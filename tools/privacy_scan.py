#!/usr/bin/env python3
"""What a clone of this repo would give a stranger.

Run it before publishing a release, and after any change to the test data:

    python3 tools/privacy_scan.py                          # clone origin fresh, then scan it
    python3 tools/privacy_scan.py --repo <path or url>     # scan another clone or mirror
    python3 tools/privacy_scan.py --words ~/private-words  # also look for your own words
    python3 tools/privacy_scan.py --range origin/main..HEAD  # only what these commits add, as the pre-push hook does

It reads every blob, commit message and tag message on every published ref, branches and the `refs/pull/*` refs
GitHub keeps for closed PRs included. Deleting a file does not unpublish it, so the current files alone would
say too little.

It looks for three things:

- **Credentials by shape**: token formats, private keys, JWTs, connection strings, assigned passwords.
- **This Mac's own data**: session ids, session titles, PR links and the folder names your sessions work in, so a
  leak is caught even when it reads as ordinary sample data. A match is reported as a location, never printed, and
  nothing read here is written anywhere: the same rule the rest of Tokentown follows.
- **Your own words**, one per line in the file `--words` names, such as employer, team and project names. That
  list belongs outside the repo: publishing what you scan for publishes the words themselves.

It exits 1 when it finds anything, so it can gate a release, and prints emails, hosts and user names it saw for a
human to read down.
"""
from __future__ import annotations

import argparse
import collections
import json
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from town.paths import Paths, default_paths, open_for_read  # noqa: E402

# Anything matching these fails the run.
SECRETS = {
    "github token": rb"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})",
    "anthropic or openai key": rb"\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}",
    "aws key": rb"\bAKIA[0-9A-Z]{16}\b",
    "google key": rb"\bAIza[0-9A-Za-z_-]{35}\b",
    "slack token": rb"\bxox[abprs]-[A-Za-z0-9-]{10,}",
    "private key": rb"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "ssh key": rb"\bssh-(?:rsa|ed25519) [A-Za-z0-9+/]{40,}",
    "jwt": rb"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}",
    "assigned secret": rb"(?i)\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\b"
                       rb"\s*[:=]\s*['\"][^'\"\s]{8,}['\"]",
    "connection string": rb"(?i)\b(?:postgres|mysql|mongodb|redis|amqp)(?:\+\w+)?://[^\s'\"]{6,}",
}
# Printed for a human to read down, never a failure on their own: the tests are full of made-up ones.
NOTED = {
    "email": rb"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}",
    "home folder": rb"/Users/([A-Za-z0-9._-]+)",
    "host": rb"https?://([A-Za-z0-9.-]+)",
}
UUID_RE = re.compile(rb"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
# Folder names every Mac has, or this repo's own: matching them would say nothing.
COMMON_FOLDERS = frozenset({
    "tokentown", "tools", "Tools", "VSCode", "Desktop", "Documents", "Downloads", "Library", "tmp", "private",
    "scratchpad", "worktrees", ".claude", "code", "src", "repos", "projects", "dev", "work", "git",
})
FAILING = ("secret", "session id", "title", "PR link", "folder name", "word")


@dataclass
class RealData:
    """What this Mac holds, for matching only. Nothing in here is ever printed."""
    ids: set[bytes] = field(default_factory=set)
    titles: set[bytes] = field(default_factory=set)
    pr_urls: set[bytes] = field(default_factory=set)
    folders: set[bytes] = field(default_factory=set)


def real_data(paths: Paths | None = None) -> RealData:
    """Session ids, titles, PR links and project folder names, from this Mac's own Claude folders."""
    paths = paths or default_paths()
    real = RealData()
    for _, claude_dir in paths.claude_dirs:
        for transcript in (claude_dir / "projects").glob("*/*.jsonl"):
            real.ids.add(transcript.stem.encode())
            for chunk in _head_and_tail(transcript):
                for line in chunk.split(b"\n"):
                    if b'"cwd"' not in line and b'Title"' not in line:
                        continue
                    record = _record(line)
                    for key in ("customTitle", "aiTitle"):
                        title = record.get(key)
                        # Short titles collide with ordinary prose, and a collision reads as a leak.
                        if isinstance(title, str) and len(title.strip()) >= 12:
                            real.titles.add(title.strip().encode())
                    cwd = record.get("cwd")
                    if isinstance(cwd, str) and cwd.startswith("/"):
                        real.folders.update(
                            part.encode() for part in Path(cwd).parts[3:]
                            if part not in COMMON_FOLDERS and len(part) >= 5)
    try:
        links = json.loads((paths.secret_dir / "links.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        links = {}
    for session_id, items in (links.get("sessions") or {}).items():
        real.ids.add(session_id.encode())
        for item in items or []:
            for value in (item if isinstance(item, list) else [item]):
                if isinstance(value, str) and "/pull/" in value:
                    real.pr_urls.add(value.encode())
    return real


def _head_and_tail(transcript: Path, window: int = 262144) -> tuple[bytes, bytes]:
    """The start and the end of a transcript: the start carries the folder, the end the newest title."""
    try:
        size = transcript.stat().st_size
        with open_for_read(transcript) as fh:
            head = fh.read(65536)
            fh.seek(max(0, size - window))
            return head, fh.read()
    except OSError:
        return b"", b""


def _record(line: bytes) -> dict:
    try:
        record = json.loads(line)
    except ValueError:
        return {}
    return record if isinstance(record, dict) else {}


def scan_items(items, real: RealData, words=()) -> dict[str, collections.Counter]:
    """Every finding as {category: {"<where>:<line>": count}}. Matched text is never part of a location."""
    found: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    words = [w.strip().encode() for w in words if w.strip() and not w.strip().startswith("#")]
    for name, data in items:
        if b"\0" in data[:8192]:
            found["binary file"][name] += 1
            continue
        for label, pattern in SECRETS.items():
            for match in re.finditer(pattern, data):
                found[f"secret ({label})"][_where(name, data, match.start())] += 1
        for label, pattern in NOTED.items():
            for match in re.finditer(pattern, data):
                seen = match.group(match.lastindex or 0).decode(errors="replace")
                found[f"noted: {label}"][seen.lower()] += 1
        for match in UUID_RE.finditer(data):
            if match.group(0) in real.ids:
                found["real session id"][_where(name, data, match.start())] += 1
        for title in real.titles:
            at = data.find(title)
            if at >= 0:
                found["real title"][_where(name, data, at)] += 1
        for url in real.pr_urls:
            at = data.find(url)
            if at >= 0:
                found["real PR link"][_where(name, data, at)] += 1
        for folder in real.folders:
            for match in re.finditer(rb"(?<![A-Za-z0-9_-])" + re.escape(folder) + rb"(?![A-Za-z0-9_-])", data):
                found["real folder name"][_where(name, data, match.start())] += 1
        for word in words:
            for match in re.finditer(re.escape(word), data, re.IGNORECASE):
                found["private word"][_where(name, data, match.start())] += 1
    return dict(found)


def _where(name: str, data: bytes, start: int) -> str:
    line = data.count(b"\n", 0, start) + 1
    return f"{name}:{line}"


def mirror_items(repo: str, git: str = "git"):
    """Every blob, commit message and tag message on every ref of a fresh mirror of `repo`."""
    with tempfile.TemporaryDirectory() as tmp:
        mirror = Path(tmp) / "mirror.git"
        subprocess.run([git, "clone", "--quiet", "--mirror", repo, str(mirror)], check=True)
        yield from ref_items(mirror, git)


def ref_items(repo: Path, git: str = "git"):
    """Everything on every ref, tag messages included: what a clone of `repo` holds."""
    run = _runner(repo, git)
    yield from _objects(run, "--all")
    for line in run("for-each-ref", "--format=%(objectname) %(objecttype) %(refname)").decode().splitlines():
        obj, kind, name = line.split()
        if kind == "tag":
            yield f"tag {name}", run("cat-file", "tag", obj)


def range_items(repo: Path, rev_range: str, git: str = "git"):
    """What a range of commits adds, such as `origin/main..HEAD`: what a push would publish."""
    yield from _objects(_runner(repo, git), rev_range)


def _runner(repo: Path, git: str):
    def run(*args: str, stdin: bytes | None = None) -> bytes:
        return subprocess.run([git, "-C", str(repo), *args], input=stdin, capture_output=True,
                              check=True).stdout
    return run


def _objects(run, revs: str):
    named = [line.partition(" ") for line in run("rev-list", "--objects", revs).decode().splitlines()]
    paths = [(sha, path) for sha, _, path in named if path]
    if paths:
        kinds = run("cat-file", "--batch-check=%(objectname) %(objecttype)",
                    stdin="\n".join(sha for sha, _ in paths).encode()).decode().split("\n")
        blobs = {row.split()[0] for row in kinds if row.strip() and row.split()[1] == "blob"}
        seen: set[str] = set()
        for sha, path in paths:
            # One blob can sit at several paths and in many commits: read each version once, name it by a path.
            if sha in blobs and sha not in seen:
                seen.add(sha)
                yield path, run("cat-file", "blob", sha)
    for sha in run("rev-list", revs).decode().split():
        yield f"commit {sha[:7]}", run("cat-file", "commit", sha)


def coverage(real: RealData, words) -> str:
    """What the scan had to match against. A runner has no Claude folder, so it checks less than a Mac does."""
    mine = (f"{len(real.ids)} session ids, {len(real.titles)} titles, {len(real.pr_urls)} PR links, "
            f"{len(real.folders)} folder names" if real.ids or real.titles or real.pr_urls or real.folders
            else "nothing of this machine's own (no Claude folder here)")
    return f"matching against: {mine}; {len(list(words))} private words"


def report(found: dict[str, collections.Counter], out=sys.stdout) -> int:
    """Print the findings and return the exit code: 1 when anything but a note was found."""
    failing = sorted(k for k in found if any(word in k for word in FAILING) or k == "binary file")
    for category in sorted(found):
        counter = found[category]
        out.write(f"\n{category}: {sum(counter.values())} hits, {len(counter)} distinct\n")
        for key, count in counter.most_common(40):
            out.write(f"  {count:5d}  {key}\n")
    # "Nothing found", not "nothing is there": the line above says what this run could match against.
    out.write("\nFound something to look at.\n" if failing else "\nNothing found in what was scanned.\n")
    return 1 if failing else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="What a clone of this repo would give a stranger.")
    parser.add_argument("--repo", default=None, help="a path or URL to scan (default: this clone's origin)")
    parser.add_argument("--words", default=None, help="a file of your own words, one per line, kept out of the repo")
    parser.add_argument("--range", dest="rev_range", default=None,
                        help="scan only what these commits add, such as origin/main..HEAD (default: a fresh clone)")
    args = parser.parse_args(argv)
    repo = args.repo
    if args.rev_range and repo is None:
        repo = "."
    if repo is None:
        here = Path(__file__).resolve().parent.parent
        repo = subprocess.run(["git", "-C", str(here), "remote", "get-url", "origin"],
                              capture_output=True, text=True, check=True).stdout.strip()
    words = [w for w in (Path(args.words).read_text(encoding="utf-8").splitlines() if args.words else ())
             if w.strip() and not w.strip().startswith("#")]
    real = real_data()
    print(f"scanning {args.rev_range or repo}")
    print(coverage(real, words))
    items = range_items(Path(repo), args.rev_range) if args.rev_range else mirror_items(repo)
    found = scan_items(items, real, words)
    return report(found)


if __name__ == "__main__":
    raise SystemExit(main())
