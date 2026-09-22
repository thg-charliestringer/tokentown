"""`tokentown check`: a counts-and-booleans report of what the scanner sees.

Never prints titles, prompts or paths from a session store. Exceptions surface as their class name only. The lanes
use the Claude app's own PR states. Its only gh calls are the update check's, which also show whether gh is signed in.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from . import paths as paths_mod
from .board import (BACKGROUND_HINT, COUNT_ONLY_LANES, GH_SIGN_IN_ERRORS, LANE_ORDER, build_board, safe_pr_url,
                    with_source_problems)
from .model import RawSnapshot

LABEL_WIDTH = 21
PR_STATE_RANK = {"OPEN": 0, "CLOSED": 1, "MERGED": 2}
_ISLAND = LANE_ORDER.index("valhalla")
LANE_LINES = (LANE_ORDER[:_ISLAND], LANE_ORDER[_ISLAND:] + COUNT_ONLY_LANES)
UPDATE_WORDS = {"behind": "{tag} is out, and this copy is older: press Update now in the page",
                "current": "up to date ({tag})", "ahead": "ahead of {tag}: changes not released yet",
                "diverged": "differs from {tag}"}


def _line(label: str, value: str) -> str:
    return f"{label:<{LABEL_WIDTH}}{value}"


def _names(values) -> str:
    return ", ".join(values) if values else "none"


def _folders(folders: list[dict], kind: str) -> str:
    """Labels only, never paths: `~/.claude`, `CLAUDE_CONFIG_DIR`, `Claude` or `Claude-3p`."""
    shown = [f["label"] if f["found"] else f"{f['label']} (not found)" for f in folders if f["kind"] == kind]
    return ", ".join(shown) if shown else "not checked"


def _normalise(p: str) -> str:
    try:
        return os.path.realpath(p)
    except (OSError, ValueError):
        return os.path.normpath(p)


def code_dir_outside(raw: RawSnapshot, code_dir: Path | str) -> bool:
    """True when code_dir is not inside (or equal to) any desktop cwd / origin_cwd or registry cwd."""
    code = _normalise(str(code_dir))
    cwds = [c for r in raw.desktop for c in (r.cwd, r.origin_cwd)]
    cwds += [e.cwd for e in raw.registry_live]
    for cwd in cwds:
        if not cwd:
            continue
        root = _normalise(cwd)
        if code == root or code.startswith(root.rstrip("/") + "/"):
            return False
    return True


def app_pr_states(raw: RawSnapshot) -> dict[str, int]:
    """Distinct non-dismissed PRs by the state the Claude app last recorded, without asking GitHub.

    One PR can be linked from several records (a forked session); the most final state wins.
    """
    best: dict[object, str] = {}
    for rec in raw.desktop:
        for i, pr in enumerate(rec.prs):
            if pr.dismissed or pr.state not in PR_STATE_RANK:
                continue
            key = safe_pr_url(pr.url) or (rec.session_id, i)
            if key not in best or PR_STATE_RANK[pr.state] > PR_STATE_RANK[best[key]]:
                best[key] = pr.state
    return {state: sum(1 for v in best.values() if v == state) for state in ("OPEN", "MERGED", "CLOSED")}


def _plan_usage(board: dict) -> str:
    usage = board.get("planUsage")
    if usage is None:
        return "none"

    def pct(value) -> str:
        return "none" if value is None else f"{value}%"

    age_min = max(0, board["generatedAt"] - usage["sampledAt"]) // 60_000
    return f"5-hour {pct(usage['fiveHourPct'])} weekly {pct(usage['weeklyPct'])} (sample {age_min} min old)"


def background_running(board: dict) -> int:
    """Rows in running only because a background task outlived the turn."""
    return sum(1 for row in board["sessions"] if any(h.startswith(BACKGROUND_HINT) for h in row["hints"]))


def load_done_marks(paths) -> dict[str, int]:
    """The done marks the server would use. Read-only here, and never fatal: the report must still print."""
    try:
        from .done import DoneStore

        return DoneStore(paths).marks()
    except Exception:
        return {}


def load_review_health() -> dict | None:
    """The review source's health, without asking GitHub: constructing it only looks for gh on disk."""
    try:
        from .reviews import ReviewSource

        return ReviewSource().health()
    except Exception:
        return None


def load_update_health() -> dict | None:
    """Whether a newer release is out, asked just now. Its two calls are the only gh `check` runs, and only for a copy
    on main with a GitHub origin, so they are also how `check` finds gh not signed in. None when it cannot run."""
    try:
        from .updates import UpdateChecker

        checker = UpdateChecker()
        checker.refresh()
        return checker.health()
    except Exception:
        return None


def load_link_store(paths):
    """The PR links the server kept after their transcripts were deleted, read-only, so the lanes match. None when it
    cannot be read."""
    try:
        from .linkstore import LinkStore

        return LinkStore(paths, read_only=True)
    except Exception:
        return None


def _review_source(health: dict | None) -> str:
    """`check` never has the review source run gh, so this reports what the source could do, not what it found."""
    if health is None:
        return "not checked"
    known, failed = health.get("known"), health.get("failed")
    error = health.get("lastError") or "none"
    return (f"{'enabled' if health.get('enabled') else 'disabled':<9}"
            f"known {known}  failed {failed}  last error {error}")


def _updates(health: dict | None) -> str:
    if health is None:
        return "not checked"
    if health.get("enabled") is not True:
        return f"not checked ({health.get('reason') or 'unknown'})"
    error = health.get("lastError")
    if error:
        return f"check failed ({error}): run gh auth login" if error in GH_SIGN_IN_ERRORS else f"check failed ({error})"
    latest = health.get("latest")
    tag = latest.get("tag") if isinstance(latest, dict) else None
    if not isinstance(tag, str):
        return "no release published yet" if health.get("lastCheckedAt") else "not checked yet"
    words = UPDATE_WORDS.get(health.get("state"))
    return words.format(tag=tag) if words else "not checked yet"


def format_report(raw: RawSnapshot, board: dict, code_dir_ok: bool, done_marks: int = 0,
                  reviews: dict | None = None, updates: dict | None = None) -> list[str]:
    h = board["health"]
    c = board["counts"]
    reg = h["registry"]
    tr = h["transcripts"]
    cli = ", ".join(h["cliVersions"]) if h["cliVersions"] else "none"
    prs = app_pr_states(raw)
    lines = [
        _line("claude code folders", _folders(h["folders"], "code")),
        _line("claude app folders", _folders(h["folders"], "app")),
        _line("desktop records", f"{h['desktop']['records']} (parse errors {h['desktop']['parseErrors']})"),
        _line("registry files", f"{reg['files']:<4}live {reg['live']:<4}joined to desktop {reg['joined']}"),
        _line("transcripts tailed", f"{tr['tailed']:<4}missing {tr['missing']}"),
        _line("tokens counted", f"{h['tokens']['complete']} of {h['tokens']['tracked']} sessions"),
        _line("unknown statuses", _names(reg["unknownStatuses"])),
        _line("unknown record types", _names(tr["unknownTypes"])),
        _line("waiting status now", str(h["waitingSeenNow"])),
        _line("background running", str(background_running(board))),
        _line("versions", f"app {h['appVersion'] or 'unknown'}  cli {cli}"),
        _line("plan usage", _plan_usage(board)),
        f"code dir outside every session cwd: {'yes' if code_dir_ok else 'no'}",
        _line("pr states (app)", f"open {prs['OPEN']} merged {prs['MERGED']} closed {prs['CLOSED']}"),
        _line("done marks", str(done_marks)),
        _line("review source", _review_source(reviews)),
        _line("updates", _updates(updates)),
        _line("lanes", "  ".join(f"{lane} {c[lane]}" for lane in LANE_LINES[0])),
        _line("", "  ".join(f"{lane} {c[lane]}" for lane in LANE_LINES[1])),
    ]
    if h["warnings"]:
        lines.append(_line("warnings", str(len(h["warnings"]))))
    lines.append(_line("health", "OK" if h["ok"] else f"NOT OK ({', '.join(h['problems']) or 'see warnings'})"))
    return lines


def run_check(paths: paths_mod.Paths | None = None, out=sys.stdout, scanner=None,
              done: dict[str, int] | None = None, reviews: dict | None = None, updates: dict | None = None) -> int:
    """`done`, `reviews` and `updates` default to the marks on disk, the real review source's health and a real
    update check when the real scanner runs, else to none and not checked (an injected scanner)."""
    try:
        if scanner is None:
            from .sources import Scanner

            paths = paths or paths_mod.default_paths()
            store = load_link_store(paths)
            scanner = Scanner(paths) if store is None else Scanner(paths, link_store=store)
            if done is None:
                done = load_done_marks(paths)
            if reviews is None:
                reviews = load_review_health()
            if updates is None:
                updates = load_update_health()
        done = dict(done or {})
        raw = scanner.scan()
        now = int(time.time() * 1000)
        board = build_board(raw, now, done=done)
        board = {**board, "health": with_source_problems(board["health"], [reviews, updates])}
        lines = format_report(raw, board, code_dir_outside(raw, paths_mod.CODE_DIR), len(done), reviews, updates)
    except Exception as exc:  # the report must never echo exception text: it can carry paths
        print(_line("health", f"NOT OK (scan raised {type(exc).__name__})"), file=out)
        return 1
    for line in lines:
        print(line, file=out)
    return 0 if board["health"]["ok"] else 1
