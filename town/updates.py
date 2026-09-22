"""Whether a newer release of Tokentown is out, and Update now.

Checking is read-only, through the gh CLI. The copy's branch, commit, origin and release tags are read from its own
.git files, and only a copy on main whose origin is on github.com is checked, with two fixed gh commands: the newest
published releases (`gh api repos/<owner>/<repo>/releases`), then `gh api repos/<owner>/<repo>/compare/<tag>...<commit>`
for how the copy stands against the newest of them. Of each release only its tag, name, date and notes are kept.

Updating runs only when you press Update now: two fixed git commands in the copy's own folder, a fetch of origin's
main and tags over HTTPS alone and a fast-forward to the release's commit, then a fresh Python that has to import the
new code before the server restarts into it.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

from .github import (FAILURE_BACKOFF_MS, GH_NOT_FOUND, GH_PATH_ENV, GH_TIMEOUT_S, BadResponse, Cancelled, find_gh,
                     gh_env, gh_failure)
from .paths import CODE_DIR, RELEASE_TAG_RE

BRANCH = "main"
CHECK_EVERY_MS = 60 * 60 * 1000
RELEASES_PER_PAGE = 10
MAX_NAME_CHARS = 200
MAX_NOTES_CHARS = 4000
# Drafts, which only people who can push see, and pre-releases never reach anyone. The newest published comes first.
RELEASES_JQ = ('[.[] | select(.draft == false and .prerelease == false) | {tag: .tag_name, '
               'name: ((.name // "")[0:200]), published: .published_at, notes: ((.body // "")[0:4000])}] '
               '| sort_by(.published) | reverse')
COMPARE_JQ = "{status: .status, ahead_by: .ahead_by, behind_by: .behind_by, base: .base_commit.sha}"
MAX_OUTPUT_BYTES = 1024
MAX_RELEASES_BYTES = 256 * 1024
MAX_COUNT = 1_000_000
MAX_TAGS = 2000
# HEAD, a loose ref, a worktree's .git file and config are a few hundred bytes. packed-refs grows with every tag.
MAX_GIT_FILE_BYTES = 64 * 1024
MAX_PACKED_REFS_BYTES = 4 * 1024 * 1024

# GitHub compares the release (the base) with this copy's commit (the head): "behind" means the copy lacks commits
# the release has, and "ahead" that it has commits no release has yet. Each status comes with (ahead_by > 0,
# behind_by > 0) as shown.
_STATES = {"identical": "current", "behind": "behind", "ahead": "ahead", "diverged": "diverged"}
_COUNTS = {"identical": (False, False), "behind": (False, True), "ahead": (True, False), "diverged": (True, True)}
_COMPARE_KEYS = frozenset({"status", "ahead_by", "behind_by", "base"})
_RELEASE_KEYS = frozenset({"tag", "name", "published", "notes"})

# Homebrew on Apple silicon, then Intel, MacPorts, nix-darwin and a Nix profile, as for gh.
GIT_CANDIDATES = ("/opt/homebrew/bin/git", "/usr/local/bin/git", "/opt/local/bin/git", "/run/current-system/sw/bin/git",
                  "~/.nix-profile/bin/git")
# /usr/bin/git runs the git of the active Xcode or Command Line Tools, and with neither it offers to install them.
APPLE_GIT = "/usr/bin/git"
APPLE_DEVELOPER_GITS = ("/Library/Developer/CommandLineTools/usr/bin/git",
                        "/Applications/Xcode.app/Contents/Developer/usr/bin/git")
GIT_TIMEOUT_S = 60
START_TIMEOUT_S = 30
# git must never wait on a terminal nobody is watching: a sign-in it would have to ask for fails instead.
GIT_ENV = {"GIT_TERMINAL_PROMPT": "0", "GIT_MERGE_AUTOEDIT": "no"}
# The launcher has to compile and the server's modules import in a fresh Python, from the copy's own folder, before
# the server restarts into them. -B, so the check itself writes no .pyc.
START_CHECK = "compile(open('tokentown', 'rb').read(), 'tokentown', 'exec'); import town.server"
PYTHON_NOT_FOUND = "python not found"

# Why a copy is not checked, in the words health shows.
NOT_A_CLONE = "not a git clone"
NOT_ON_MAIN = "not on main"
NO_GITHUB_ORIGIN = "no GitHub origin"
UNREADABLE = "git files unreadable"

_SHA_RE = re.compile(r"[0-9a-f]{40}")
# github.com only, over https (a user name but never a password) or ssh, and nothing after the repo but .git or /.
_ORIGIN_RES = (
    re.compile(r"https://(?:[A-Za-z0-9_.-]+@)?github\.com/([^/]+)/([^/]+?)/?"),
    re.compile(r"(?:ssh://)?git@github\.com[:/]([^/]+)/([^/]+?)/?"),
)
# GitHub's own sets, in ASCII. They are what reaches gh's argv, where "." or ".." would be sent on as a dot segment.
_OWNER_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}")
_REPO_RE = re.compile(r"[A-Za-z0-9_.-]{1,100}")
_SECTION_RE = re.compile(r'\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]')
_KEY_RE = re.compile(r"([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)")
_ISO_RE = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})")
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
# Kept out of a release's words: control characters but a line break or a tab, and format characters such as the
# bidi overrides, which can make a line read differently from what it holds.
_DROPPED_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Zl", "Zp"})


def _epoch_ms() -> int:
    return time.time_ns() // 1_000_000


def _reject_constant(_name: str):
    raise BadResponse


def version_key(tag: str) -> tuple[int, ...]:
    """A release tag's numbers, to order v1.10.0 after v1.9.0."""
    return tuple(int(part) for part in tag.removeprefix("v").split("."))


@dataclass(frozen=True, slots=True)
class Clone:
    """A copy that can be checked: the GitHub repo its origin names, the commit main is at, and its release tags."""
    owner: str
    repo: str
    commit: str
    https: bool = True  # origin is an https URL, the only kind Update now fetches from
    tags: tuple[str, ...] = ()  # the release tags at this commit, highest first


@dataclass(frozen=True, slots=True)
class Release:
    """One published release: its tag, name, when it was published (epoch ms, or None) and its notes."""
    tag: str
    name: str
    published: int | None
    notes: str


def find_git(candidates: tuple[str, ...] | None = None, apple: tuple[str, ...] = APPLE_DEVELOPER_GITS) -> str | None:
    """The git Update now runs, or None. Never the /usr/bin/git stub unless an Xcode or Command Line Tools is there."""
    for candidate in GIT_CANDIDATES if candidates is None else candidates:
        path = os.path.expanduser(candidate)
        if os.path.isabs(path) and os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    if any(os.path.isfile(p) and os.access(p, os.X_OK) for p in apple) and os.access(APPLE_GIT, os.X_OK):
        return APPLE_GIT
    return None


def git_env(home: str, environ=os.environ) -> dict[str, str]:
    """git's whole environment: gh's, since a gh credential helper needs its sign-in, and never a prompt."""
    return {**gh_env(home, environ), **GIT_ENV}


def parse_origin(url: object) -> tuple[str, str] | None:
    """(owner, repo) of a github.com remote URL, else None."""
    if not isinstance(url, str):
        return None
    for pattern in _ORIGIN_RES:
        m = pattern.fullmatch(url)
        if m is not None:
            break
    else:
        return None
    owner, repo = m.group(1), m.group(2).removesuffix(".git")
    if not _OWNER_RE.fullmatch(owner) or not _REPO_RE.fullmatch(repo) or repo in (".", ".."):
        return None
    return owner, repo


def origin_url(config: str) -> str | None:
    """The first url of [remote "origin"] in a git config's text, else None.

    Just enough of git's syntax for a clone's own config: section names are case-blind, a value may be quoted, and
    `#` or `;` starts a comment. Includes and url rewrites are not followed.
    """
    section = None
    for raw in config.splitlines():
        line = raw.strip()
        if not line or line[0] in "#;":
            continue
        if line.startswith("["):
            m = _SECTION_RE.match(line)
            section = (m.group(1).lower(), m.group(2)) if m else None
            continue
        if section != ("remote", "origin"):
            continue
        m = _KEY_RE.fullmatch(line)
        if m is None or m.group(1).lower() != "url":
            continue
        value = m.group(2)
        if value.startswith('"'):
            end = value.find('"', 1)
            return value[1:end] if end > 0 else None
        return re.split(r"[\s#;]", value, maxsplit=1)[0] or None
    return None


def _read_small(path: Path, cap: int = MAX_GIT_FILE_BYTES) -> str:
    """A git file's text. Raises OSError, or ValueError for one over `cap` bytes or not UTF-8."""
    with open(path, "rb") as f:
        data = f.read(cap + 1)
    if len(data) > cap:
        raise ValueError("over the size cap")
    return data.decode("utf-8")


def _first_line(text: str) -> str:
    return text.split("\n", 1)[0].rstrip("\r")


def git_dirs(code_dir: Path) -> tuple[Path, Path] | None:
    """(gitdir, commondir) of the clone at code_dir, or None when it is not one.

    A worktree's .git is a file naming its own gitdir, which holds HEAD; the refs and config are in the commondir
    that gitdir's `commondir` file names. In a plain clone both are .git itself.
    """
    dot_git = code_dir / ".git"
    if dot_git.is_dir():
        return dot_git, dot_git
    if not dot_git.is_file():
        return None
    line = _first_line(_read_small(dot_git))
    if not line.startswith("gitdir: ") or not line[len("gitdir: "):]:
        raise ValueError("not a gitdir file")
    gitdir = code_dir / line[len("gitdir: "):]
    try:
        common = _first_line(_read_small(gitdir / "commondir"))
    except FileNotFoundError:
        return gitdir, gitdir
    return gitdir, (gitdir / common if common else gitdir)


def _packed_refs(common: Path) -> list[str]:
    try:
        return _read_small(common / "packed-refs", MAX_PACKED_REFS_BYTES).splitlines()
    except FileNotFoundError:
        return []


def _main_commit(common: Path, packed: list[str]) -> str | None:
    """The commit refs/heads/main names, loose or packed, else None."""
    try:
        loose = _read_small(common / "refs" / "heads" / BRANCH).strip()
    except FileNotFoundError:
        loose = None
    if loose is not None:
        return loose if _SHA_RE.fullmatch(loose) else None
    for line in packed:
        sha, _, name = line.partition(" ")
        if name == f"refs/heads/{BRANCH}":
            return sha if _SHA_RE.fullmatch(sha) else None
    return None


def release_tags_at(common: Path, commit: str, packed: list[str]) -> tuple[str, ...]:
    """The release tags naming this commit, highest first: loose ones, which `gh release create` makes lightweight,
    and packed ones, lightweight or annotated with the commit on the `^` line after them. An annotated tag that is
    still loose names a tag object, not the commit, and is not read."""
    found: set[str] = set()
    tags_dir = common / "refs" / "tags"
    try:
        names = sorted(os.listdir(tags_dir))[:MAX_TAGS]
    except OSError:
        names = []
    for name in names:
        if not RELEASE_TAG_RE.fullmatch(name):
            continue
        try:
            if _read_small(tags_dir / name).strip() == commit:
                found.add(name)
        except (OSError, ValueError):
            continue
    for i, line in enumerate(packed[:MAX_TAGS * 2]):
        sha, _, ref = line.partition(" ")
        name = ref.removeprefix("refs/tags/")
        if name == ref or not RELEASE_TAG_RE.fullmatch(name):
            continue
        peeled = packed[i + 1][1:] if i + 1 < len(packed) and packed[i + 1].startswith("^") else None
        if commit in (sha, peeled):
            found.add(name)
    return tuple(sorted(found, key=version_key, reverse=True))


def read_clone(code_dir: Path | str = CODE_DIR) -> Clone | str:
    """The copy at code_dir as the update check needs it, or the reason it cannot be checked. Only ever reads."""
    try:
        dirs = git_dirs(Path(code_dir))
        if dirs is None:
            return NOT_A_CLONE
        gitdir, common = dirs
        head = _read_small(gitdir / "HEAD").strip()
        if head != f"ref: refs/heads/{BRANCH}":
            return NOT_ON_MAIN if head.startswith("ref: ") or _SHA_RE.fullmatch(head) else UNREADABLE
        packed = _packed_refs(common)
        commit = _main_commit(common, packed)
        if commit is None:
            return UNREADABLE
        url = origin_url(_read_small(common / "config")) or ""
        origin = parse_origin(url)
        tags = release_tags_at(common, commit, packed)
    except (OSError, ValueError):
        return UNREADABLE
    if origin is None:
        return NO_GITHUB_ORIGIN
    return Clone(owner=origin[0], repo=origin[1], commit=commit, https=url.startswith("https://"), tags=tags)


def _json_output(output: object, cap: int):
    if not isinstance(output, (bytes, str)) or len(output) > cap:
        raise BadResponse
    try:
        return json.loads(output, parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        raise BadResponse from None


def parse_compare(output: object) -> tuple[str, str]:
    """(state, the release's commit) from the jq filter's output. Raises BadResponse for anything else."""
    obj = _json_output(output, MAX_OUTPUT_BYTES)
    if not isinstance(obj, dict) or not _COMPARE_KEYS <= obj.keys():
        raise BadResponse
    status, ahead, behind, base = obj["status"], obj["ahead_by"], obj["behind_by"], obj["base"]
    if not isinstance(status, str) or status not in _STATES:
        raise BadResponse
    # type() rather than isinstance(): JSON true is a Python bool, which is an int.
    if type(ahead) is not int or type(behind) is not int or not (0 <= ahead <= MAX_COUNT and 0 <= behind <= MAX_COUNT):
        raise BadResponse
    if (ahead > 0, behind > 0) != _COUNTS[status]:
        raise BadResponse
    # It reaches git's argv as the commit Update now fast-forwards to.
    if not isinstance(base, str) or not _SHA_RE.fullmatch(base):
        raise BadResponse
    return _STATES[status], base


def _clean_text(value: object, cap: int) -> str:
    if not isinstance(value, str):
        raise BadResponse
    text = value.replace("\r\n", "\n").replace("\r", "\n")
    kept = "".join(ch for ch in text if ch in "\n\t" or unicodedata.category(ch) not in _DROPPED_CATEGORIES)
    return kept[:cap].strip()


def _published_ms(value: object) -> int | None:
    if value is None:
        return None
    if not isinstance(value, str) or _ISO_RE.fullmatch(value) is None:
        raise BadResponse
    try:
        ms = (datetime.fromisoformat(value) - _EPOCH) // timedelta(milliseconds=1)
    except ValueError:
        raise BadResponse from None
    return ms if ms >= 0 else None


def parse_releases(output: object) -> tuple[Release, ...]:
    """The published releases in the jq filter's output, newest first and at most RELEASES_PER_PAGE. A release whose
    tag is not a release tag Tokentown takes is left out. Raises BadResponse for anything that is not that list."""
    items = _json_output(output, MAX_RELEASES_BYTES)
    if not isinstance(items, list):
        raise BadResponse
    releases: list[Release] = []
    for item in items:
        if not isinstance(item, dict) or not _RELEASE_KEYS <= item.keys():
            raise BadResponse
        tag = item["tag"]
        if not isinstance(tag, str):
            raise BadResponse
        if not RELEASE_TAG_RE.fullmatch(tag):
            continue
        releases.append(Release(tag=tag, name=_clean_text(item["name"], MAX_NAME_CHARS),
                                published=_published_ms(item["published"]),
                                notes=_clean_text(item["notes"], MAX_NOTES_CHARS)))
    return tuple(releases[:RELEASES_PER_PAGE])


@dataclass(frozen=True, slots=True)
class _Answer:
    commit: str  # this copy's commit, as GitHub was asked about it
    tag: str  # the newest release's tag
    state: str  # this copy against that release
    release_commit: str  # the commit the tag names: what Update now fast-forwards to


class UpdateChecker:
    """Caches whether a newer release is out. refresh() reads .git and may run gh; health() never blocks on it.
    update() is Update now.

    The commit main is at when this is built is the code the server runs, so a later one on disk is a pull that
    needs a restart. `run`, when given, is called like subprocess.run (tests). Without it gh is started with `popen`
    so that cancel() can kill a call in flight, exactly as PrStateResolver does. `read` stands in for read_clone, and
    `update_run` for the subprocess.run that update() starts git and the start check with.
    """

    def __init__(self, code_dir: Path | str = CODE_DIR, run: Callable | None = None,
                 clock_ms: Callable[[], int] = _epoch_ms, gh_path: str | None = None, *, home: str | None = None,
                 popen: Callable | None = None, read: Callable[[Path], Clone | str] = read_clone,
                 git_path: str | None = None, python: str = sys.executable, update_run: Callable = subprocess.run):
        if gh_path is None:
            gh_path = find_gh()
        elif not (isinstance(gh_path, str) and os.path.isabs(gh_path)):
            raise ValueError("gh_path must be an absolute path")
        if git_path is None:
            git_path = find_git()
        elif not (isinstance(git_path, str) and os.path.isabs(git_path)):
            raise ValueError("git_path must be an absolute path")
        if not (isinstance(python, str) and os.path.isabs(python)):
            python = None
        if home is None:
            try:
                home = str(Path.home())
            except (RuntimeError, KeyError):
                gh_path = git_path = python = None
        self.code_dir = Path(code_dir)
        self.gh_path = gh_path
        self.git_path = git_path
        self._python = python
        self._home = home
        self._env = gh_env(home) if home is not None else {}
        self._git_env = git_env(home) if home is not None else {}
        self._update_run = update_run
        self._update_lock = threading.Lock()
        self._run = run
        self._popen = popen
        self._clock_ms = clock_ms
        self._read = read
        self._lock = threading.Lock()
        self._refresh_lock = threading.Lock()
        self._proc_lock = threading.Lock()
        self._proc = None
        self._cancelled = False
        self._clone = self._read_clone()
        checkable = isinstance(self._clone, Clone)
        self._started = self._clone.commit if checkable else None
        self._running_tags = self._clone.tags if checkable else ()
        self._answer: _Answer | None = None
        self._releases: tuple[Release, ...] = ()
        self._error: str | None = None
        self._asked: str | None = None  # the commit the latest check asked about, answered or not
        self._next_check_at = 0
        self._last_checked_at: int | None = None

    @property
    def enabled(self) -> bool:
        return self.gh_path is not None

    def _read_clone(self) -> Clone | str:
        try:
            clone = self._read(self.code_dir)
        except Exception:
            return UNREADABLE
        if isinstance(clone, str):
            return clone
        # Checked again here, whatever `read` is: owner, repo and commit are what reach gh's argv.
        if (isinstance(clone, Clone) and parse_origin(f"https://github.com/{clone.owner}/{clone.repo}")
                == (clone.owner, clone.repo) and isinstance(clone.commit, str) and _SHA_RE.fullmatch(clone.commit)
                and isinstance(clone.tags, tuple)
                and all(isinstance(t, str) and RELEASE_TAG_RE.fullmatch(t) for t in clone.tags)):
            return clone
        return UNREADABLE

    def refresh(self) -> int:
        """Read the copy again, and ask GitHub about it when a check is due. Returns the gh calls made, 0 to 2.

        A check is the newest releases, then, when there is one, how this copy compares with it. It is due an hour
        after an answer and 15 minutes after a failure, and straight away for a commit it has not asked about yet, as
        after a pull: once per commit, so a failing gh costs one more check per pull at most.
        """
        with self._refresh_lock:
            clone = self._read_clone()
            with self._lock:
                self._clone = clone
                if isinstance(clone, Clone) and clone.commit == self._started:
                    # A tag fetched after the server started still names the code it runs.
                    self._running_tags = clone.tags
            if self.gh_path is None or self._cancelled or not isinstance(clone, Clone):
                return 0
            now = self._clock_ms()
            with self._lock:
                if clone.commit == self._asked and now < self._next_check_at:
                    return 0
            calls, answer = 1, None
            releases, error = self._gh(self.releases_argv(clone), parse_releases)
            if error is None and releases:
                calls = 2
                compared, error = self._gh(self.compare_argv(clone, releases[0].tag), parse_compare)
                if error is None:
                    answer = _Answer(clone.commit, releases[0].tag, *compared)
            done = self._clock_ms()
            if self._cancelled:
                return calls
            with self._lock:
                self._asked = clone.commit
                if releases is not None:
                    self._releases = releases
                if error is not None:
                    self._error = error
                    self._next_check_at = done + FAILURE_BACKOFF_MS
                else:
                    # None when no release is out yet.
                    self._answer = answer
                    self._error = None
                    self._next_check_at = done + CHECK_EVERY_MS
                    self._last_checked_at = done
            return calls

    def cancel(self) -> None:
        """For shutdown: no further gh calls, and a call in flight is killed."""
        with self._proc_lock:
            self._cancelled = True
            proc = self._proc
        if proc is not None:
            try:
                proc.kill()
            except OSError:
                pass

    def releases_argv(self, clone: Clone) -> list[str]:
        return [self.gh_path, "api", f"repos/{clone.owner}/{clone.repo}/releases?per_page={RELEASES_PER_PAGE}",
                "--jq", RELEASES_JQ]

    def compare_argv(self, clone: Clone, tag: str) -> list[str]:
        if not RELEASE_TAG_RE.fullmatch(tag):
            raise ValueError("not a release tag")
        return [self.gh_path, "api", f"repos/{clone.owner}/{clone.repo}/compare/{tag}...{clone.commit}",
                "--jq", COMPARE_JQ]

    def _start_and_wait(self, argv: list[str], env: dict[str, str]) -> subprocess.CompletedProcess:
        popen = self._popen if self._popen is not None else subprocess.Popen
        with self._proc_lock:
            if self._cancelled:
                raise Cancelled
            # stderr is never read, so gh's error text never enters this process.
            proc = popen(argv, shell=False, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, env=env)
            self._proc = proc
        try:
            try:
                stdout, _ = proc.communicate(timeout=GH_TIMEOUT_S)
            except BaseException:
                proc.kill()
                proc.communicate()
                raise
            return subprocess.CompletedProcess(argv, proc.returncode, stdout, None)
        finally:
            with self._proc_lock:
                self._proc = None

    def _gh(self, argv: list[str], parse: Callable):
        """One gh call: (what `parse` makes of its output, None), or (None, why it failed)."""
        env = dict(self._env)
        try:
            if self._run is not None:
                result = self._run(argv, shell=False, timeout=GH_TIMEOUT_S, stdin=subprocess.DEVNULL,
                                   capture_output=True, env=env)
            else:
                result = self._start_and_wait(argv, env)
        except Exception as exc:
            return None, type(exc).__name__
        code = getattr(result, "returncode", None)
        if type(code) is not int:
            return None, BadResponse.__name__
        if code != 0:
            return None, gh_failure(code, getattr(result, "stdout", None))
        try:
            return parse(getattr(result, "stdout", None)), None
        except BadResponse:
            return None, BadResponse.__name__

    # ------------------------------------------------------------ Update now

    def update(self) -> tuple[str, str | None]:
        """Update now, for a click and never on its own. ("pulled" or "restart", None) when the server should restart
        into the copy on disk now, ("busy" or "nothing", None) when there is nothing to run, else the step that failed
        ("fetch", "merge" or "start") and its exit code or exception class.

        A fetch or merge that fails changes nothing: the merge only fast-forwards, and git refuses rather than
        overwrite a local edit. A start check that fails leaves the pulled code on disk and the server as it was.
        """
        if not self._update_lock.acquire(blocking=False):
            return "busy", None
        try:
            action, clone, release_commit = self._pending()
            if action is None:
                return "nothing", None
            if action == "pull":
                if not self._can_pull(clone):
                    return "nothing", None
                for step, argv in (("fetch", self.fetch_argv()), ("merge", self.merge_argv(release_commit))):
                    error = self._run_local(argv, GIT_TIMEOUT_S, self._git_env)
                    if error is not None:
                        return step, error
            if self._python is None:
                return "start", PYTHON_NOT_FOUND
            error = self._run_local([self._python, "-B", "-c", START_CHECK], START_TIMEOUT_S,
                                    {"PATH": GH_PATH_ENV, "HOME": self._home}, cwd=str(self.code_dir))
            if error is not None:
                return "start", error
            return ("pulled" if action == "pull" else "restart"), None
        finally:
            self._update_lock.release()

    def _pending(self) -> tuple[str | None, Clone | None, str | None]:
        """What Update now would do for the copy on disk right now: pull, only when GitHub's answer is for this very
        commit and says a newer release is out, or restart, once the commit has moved since the server started."""
        clone = self._read_clone()
        with self._lock:
            self._clone = clone
            answer = self._answer
        if not isinstance(clone, Clone):
            return None, None, None
        if answer is not None and answer.commit == clone.commit and answer.state == "behind":
            return "pull", clone, answer.release_commit
        if self._started is not None and clone.commit != self._started:
            return "restart", clone, None
        return None, clone, None

    def _can_pull(self, clone: object) -> bool:
        return isinstance(clone, Clone) and clone.https and self.git_path is not None and self._home is not None

    def fetch_argv(self) -> list[str]:
        # --tags, so the release's tag is here to name the version afterwards. --force, so a tag moved on GitHub
        # moves here too instead of failing the fetch: a tag only names a commit, and git never moves a branch for it.
        return [self.git_path, "-C", str(self.code_dir), "-c", "protocol.allow=never",
                "-c", "protocol.https.allow=always", "fetch", "--quiet", "--tags", "--force",
                "--no-recurse-submodules", "origin", BRANCH]

    def merge_argv(self, commit: str) -> list[str]:
        if not (isinstance(commit, str) and _SHA_RE.fullmatch(commit)):
            raise ValueError("not a commit")
        return [self.git_path, "-C", str(self.code_dir), "merge", "--ff-only", "--quiet", commit]

    def _run_local(self, argv: list[str], timeout: float, env: dict[str, str], cwd: str | None = None) -> str | None:
        """None when the command exits 0, else its exit code or exception class. Nothing it prints is read.

        subprocess.run, not a Popen shutdown can kill: a git still running when the server stops is left to finish,
        since a merge cut short would leave the folder half moved.
        """
        try:
            result = self._update_run(argv, shell=False, timeout=timeout, stdin=subprocess.DEVNULL,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=dict(env), cwd=cwd)
        except Exception as exc:
            return type(exc).__name__
        code = getattr(result, "returncode", None)
        if type(code) is not int:
            return BadResponse.__name__
        return None if code == 0 else f"exit {code}"

    # ------------------------------------------------------------ reading

    def releases(self) -> list[dict]:
        """The newest releases as the last check saw them, newest first, for What's new."""
        with self._lock:
            releases = self._releases
        return [{"tag": r.tag, "name": r.name, "published": r.published, "notes": r.notes} for r in releases]

    def health(self) -> dict:
        """health.updates. `state` is this copy against the newest release, as GitHub answered for the commit on disk
        now, and None until it has. `version` is the release the server runs, from its tags, and `running` its
        commit, which the page reloads for when it changes."""
        with self._lock:
            clone, answer, error, last_checked_at = self._clone, self._answer, self._error, self._last_checked_at
            releases, running_tags = self._releases, self._running_tags
        checkable = isinstance(clone, Clone)
        if not checkable:
            reason = clone
        elif self.gh_path is None:
            reason = GH_NOT_FOUND
        else:
            reason = None
        latest = releases[0] if checkable and releases else None
        # A compare that failed after a newer release came out leaves an answer about the one before it.
        fresh = (answer if checkable and answer is not None and answer.commit == clone.commit
                 and latest is not None and answer.tag == latest.tag else None)
        if self.gh_path is None:
            last_error = GH_NOT_FOUND
        else:
            last_error = error if checkable else None
        # GitHub's answer first: a release published on this very commit after the clone last fetched its tags names
        # it too, and the local tags would still call it the release before.
        if fresh is not None and fresh.state == "current" and clone.commit == self._started:
            version = fresh.tag
        elif running_tags:
            version = running_tags[0]
        else:
            version = None
        return {
            "enabled": reason is None,
            "reason": reason,
            "state": fresh.state if fresh is not None else None,
            "latest": {"tag": latest.tag, "name": latest.name, "published": latest.published} if latest else None,
            "version": version,
            "restart": checkable and self._started is not None and clone.commit != self._started,
            "canPull": self._can_pull(clone),
            "running": self._started,
            "lastError": last_error,
            "lastCheckedAt": last_checked_at,
        }
