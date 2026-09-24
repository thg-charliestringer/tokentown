"""Lanes, sorting, counts and health: RawSnapshot -> the board JSON served at /api/board.

Pure: no I/O, no clock. Everything time-based is measured against the `now` passed in.
"""
from __future__ import annotations

import hashlib
import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass, field, replace

from . import status as st
from .model import (BackgroundWork, CliTranscript, DesktopRecord, GitHubPr, PlanUsage, PrLink, PullRequest,
                    RawSnapshot, RegistryEntry, ReviewRequest, ReviewSnapshot, SessionTokens, Tail)
from .github import GH_NOT_SIGNED_IN, parse_pr_url
from .paths import CLI_ROW_ID_RE, CONFIG_DIR_ENV, EDITORS, LOCAL_ID_RE, PR_URL_RE, REVIEW_ID_RE
from .reviews import VIA_TEAM, VIA_YOU, keep_visitors, team_slugs

LANE_ORDER = ("needs_you", "errored", "your_turn", "running", "stopped", "idle", "open_pr", "recent", "valhalla",
              "castle", "jail", "graveyard")
COUNT_ONLY_LANES = ("old",)
ALL_LANES = LANE_ORDER + COUNT_ONLY_LANES
SINCE_ASC_LANES = frozenset({"needs_you", "errored", "your_turn", "stopped", "running"})
ISLAND_LANES = frozenset({"valhalla", "castle"})
# Live lanes a done mark never overrides: the session is doing something, or waiting on Charlie.
BUSY_LANES = frozenset({"needs_you", "errored", "running"})
# A done mark outranks an open PR (a finished session can leave a PR open for someone else), so Harbour rows can
# be sent too. Island rows are already there: a merged one has nothing to undo, a done one shows Bring back.
NO_DONE_LANES = ISLAND_LANES
NEEDS_INPUT_LABEL = "Needs input"

ROW_KEYS = ("id", "kind", "surface", "editor", "lane", "label", "hints", "since", "title", "shortId", "repo",
            "worktree", "branch", "model", "effort", "live", "unread", "pr", "lastActivityAt", "canOpen",
            "canCopyResume", "look", "createdAt", "turns", "tokens", "restReason", "doneAt", "valhallaReason",
            "canMarkDone")
# Visitors are not sessions: they are their own array, they have no lane, and they change no count.
VISITOR_KEYS = ("id", "number", "repo", "owner", "island", "title", "author", "via", "teams", "waitingSince", "look")

DAY_MS = 24 * 60 * 60 * 1000
D7_MS = 7 * DAY_MS
BEACH_MS = 14 * DAY_MS
GRAVEYARD_INACTIVE_MS = 30 * DAY_MS
FOCUS_GRACE_MS = 120_000
NEEDS_INPUT_MS = 2 * 60 * 60 * 1000
TOOL_HINT_MS = 90_000
QUIET_MS = 10 * 60 * 1000
ERROR_AT_SLACK_MS = 1000
LABEL_VALUE_MAX = 40
PLAN_STALE_MS = 30 * 60 * 1000
PLAN_FIVE_HOUR_MS = 5 * 60 * 60 * 1000
PLAN_WEEKLY_MS = D7_MS
DONE_GRACE_MS = 120_000
DONE_FUTURE_SLACK_MS = DAY_MS
BACKGROUND_HINT = "background task"
# A transcript pr-link records no state, and the app never saw it: the state stays unknown until GitHub answers.
UNKNOWN_PR_STATE = "UNKNOWN"
# Any other state (UNKNOWN, or one the app invented) may still be open, so it holds a merge off the island and the
# row out of the jail alike.
RESOLVED_PR_STATES = frozenset({"OPEN", "MERGED", "CLOSED"})

KNOWN_STATUSES = frozenset({"idle", "busy", "waiting", "shell"})
VSCODE_ENTRYPOINT = "claude-vscode"
APPROVAL_GRACE_MS = 15_000
INSTANT_TOOLS = frozenset({"Edit", "MultiEdit", "Write", "NotebookEdit"})
WORKTREE_MARKER = "/.claude/worktrees/"
ERROR_LABELS = {"rate_limit": "Rate limited", "authentication_failed": "Signed out", "server_error": "API error"}
MISSING_STATUS = "(missing)"
# What a gh source's lastError is while gh has no sign-in GitHub accepts: none at all, or one GitHub refuses. Every
# call then fails the same way, so PR states, review requests and the update check all stop together.
GH_SIGN_IN_ERRORS = frozenset({GH_NOT_SIGNED_IN, "HTTP 401"})
GH_SIGN_IN_PROBLEM = "gh not signed in"


@dataclass(frozen=True, slots=True)
class _Lane:
    lane: str
    label: str | None = None
    since: int | None = None
    hints: tuple[str, ...] = ()
    rest_reason: str | None = None
    valhalla_reason: str | None = None


@dataclass(frozen=True, slots=True)
class PrCandidate:
    """One non-dismissed PR of a session, from desktop prs[] or a transcript pr-link."""
    number: int
    url: str | None  # already validated against PR_URL_RE
    app_state: str  # the Claude app's prs[].state, or UNKNOWN_PR_STATE for a link the app never recorded


@dataclass(frozen=True, slots=True)
class EffectivePr:
    """One non-dismissed PR, with GitHub's state in place of the app's when GitHub has one."""
    number: int
    state: str
    url: str | None  # already validated against PR_URL_RE
    verified: bool  # the state came from GitHub
    merged_at: int | None  # GitHub's merged_at; null when the state came from the app
    closed_at: int | None = None  # GitHub's closed_at; null when the state came from the app


@dataclass(frozen=True, slots=True)
class PrVerdict:
    """What a session's PRs say about its lane."""
    shown: EffectivePr | None = None  # the row's pr field
    open: bool = False  # some PR is OPEN: the Harbour
    merged_at: int | None = None  # set when a merge sails: some PR MERGED, none OPEN, none unresolved
    closed: bool = False  # every PR is CLOSED: the jail
    closed_at: int | None = None  # the newest closure GitHub gave a time for; dates the jail's D30 window


NO_PRS = PrVerdict()


def _clean(value: str, limit: int = LABEL_VALUE_MAX) -> str:
    """Drop control and format characters, then truncate: registry values reach labels and health."""
    kept = "".join(c for c in value if unicodedata.category(c)[0] != "C")
    return kept[:limit]


def _version_key(version: str) -> list:
    # re.split with a capture group puts the digit runs at odd indexes, so element types always line up.
    return [int(part) if i % 2 else part for i, part in enumerate(re.split(r"(\d+)", version))]


def _basename(path: str | None) -> str | None:
    if not path:
        return None
    name = path.rstrip("/").rsplit("/", 1)[-1]
    return name or None


def _worktree(cwd: str | None) -> str | None:
    if not cwd or WORKTREE_MARKER not in cwd:
        return None
    return cwd.split(WORKTREE_MARKER, 1)[1].split("/", 1)[0] or None


def _cli_repo(cwd: str | None) -> str | None:
    if cwd and WORKTREE_MARKER in cwd:
        return _basename(cwd.split(WORKTREE_MARKER, 1)[0])
    return _basename(cwd)


def status_unreported(entry: RegistryEntry) -> bool:
    """The Claude Code extension registers its sessions with no status, in every editor: that is its normal shape, not
    the registry changing under us."""
    return entry.status is None and entry.entrypoint == VSCODE_ENTRYPOINT


def awaits_approval(verdict: st.Verdict, background: BackgroundWork | None, now: int) -> bool:
    """For a session that reports no status: whether its pending tool call is waiting for approval.

    Allowed, a Bash call starts a marked shell under the session's process and an edit finishes at once, so either
    still pending past the grace is waiting. The grace covers the ps table's age and an auto-mode check. Any other
    tool can rightly run for minutes, so it is never read as waiting.
    """
    if verdict.kind != st.TOOL_PENDING or verdict.since is None or now - verdict.since < APPROVAL_GRACE_MS:
        return False
    if verdict.tool_name == "Bash":
        return background is not None and background.shells == 0
    return verdict.tool_name in INSTANT_TOOLS


def cli_surface(cli: CliTranscript, entry: RegistryEntry | None, hosted: Mapping[str, str] | None = None) -> str:
    """Where a session with no desktop record runs: "vscode" (in VS Code, VS Code Insiders or Cursor) or "terminal".

    `claude` in an editor's own terminal says "cli" like any terminal, so a live one is known by the editor among its
    process's ancestors (`hosted`). An editor session can be resumed in a terminal and the other way round, so while
    the session is live its registry entry, which names where it runs now, beats the transcript's first record.
    """
    if entry is not None and entry.session_id in (hosted or {}):
        return "vscode"
    entrypoint = entry.entrypoint if entry is not None and entry.entrypoint else cli.entrypoint
    return "vscode" if entrypoint == VSCODE_ENTRYPOINT else "terminal"


def row_editor(raw: RawSnapshot, session_id: str) -> str:
    """The editor a "vscode" session opens in: the one it runs under now, else the one it was last seen live under,
    else the first one installed. The extension's chat records the same entrypoint in every editor."""
    return (raw.editor_hosted.get(session_id) or raw.editors_seen.get(session_id) or raw.default_editor
            or EDITORS[0].key)


def _within_d7(ts: int | None, now: int) -> bool:
    return ts is not None and now - ts <= D7_MS


def look_for(row_id: str) -> int:
    return int(hashlib.sha1(row_id.encode("utf-8")).hexdigest()[:8], 16)


def _error_label(v: st.Verdict) -> str:
    if v.kind == st.RATE_LIMITED:
        return ERROR_LABELS["rate_limit"]
    return ERROR_LABELS.get(v.error_kind or "", "Error")


def newest_pr(prs: tuple[PullRequest, ...]) -> PullRequest | None:
    # prs[] is appended as PRs are linked, so the last non-dismissed one is the newest.
    for pr in reversed(prs):
        if not pr.dismissed:
            return pr
    return None


def safe_pr_url(url: object) -> str | None:
    return url if isinstance(url, str) and PR_URL_RE.match(url) else None


def _link_ok(link: PrLink) -> bool:
    # parse_pr_url, not PR_URL_RE alone: a link has no state of its own, so one gh can never be asked about
    # (pull/0) would stay UNKNOWN and hide an older merged PR.
    return (type(link.number) is int and link.number > 0 and parse_pr_url(link.url) is not None
            and (link.timestamp is None or type(link.timestamp) is int))


def pr_candidates(prs: tuple[PullRequest, ...], links: tuple[PrLink, ...] = ()) -> list[PrCandidate]:
    """A session's non-dismissed PRs, oldest first: desktop prs[] in order, then transcript links by timestamp.

    Desktop PRs carry no time and the app stopped writing them, so every transcript link counts as newer; a link
    with no timestamp is the oldest link. A URL dismissed on the desktop record never comes back through a link.
    """
    dismissed = {pr.url.lower() for pr in prs if pr.dismissed and isinstance(pr.url, str)}
    out: list[PrCandidate] = []
    app_states: dict[str, str] = {}
    for pr in prs:
        if pr.dismissed:
            continue
        url = safe_pr_url(pr.url)
        out.append(PrCandidate(pr.number, url, pr.state))
        if url is not None:
            app_states[url.lower()] = pr.state
    usable = [(i, link) for i, link in enumerate(links) if _link_ok(link)]
    usable.sort(key=lambda p: (p[1].timestamp is not None, p[1].timestamp or 0, p[0]))
    for _, link in usable:
        key = link.url.lower()
        if key not in dismissed:
            out.append(PrCandidate(link.number, link.url, app_states.get(key, UNKNOWN_PR_STATE)))
    return out


def _effective(pr: PrCandidate, github: dict[str, GitHubPr] | None) -> EffectivePr:
    url = pr.url
    gh = github.get(url) if github and url is not None else None
    parts = parse_pr_url(url) if gh is not None else None
    if parts is not None:
        # GitHub was asked about the number in the URL, which a badly written record can disagree with.
        return EffectivePr(parts[2], gh.state, url, True, gh.merged_at, gh.closed_at)
    return EffectivePr(pr.number, pr.app_state, url, False, None)


def effective_prs(prs: tuple[PullRequest, ...], github: dict[str, GitHubPr] | None,
                  links: tuple[PrLink, ...] = ()) -> tuple[EffectivePr, ...]:
    """Every non-dismissed PR of a session with its effective state, oldest first (`pr_candidates` order)."""
    return tuple(_effective(pr, github) for pr in pr_candidates(prs, links))


def pr_verdict(prs: tuple[EffectivePr, ...], last_activity_at: int) -> PrVerdict:
    """Any OPEN PR puts the row in the Harbour. Otherwise at least one MERGED PR, with every other PR MERGED or
    CLOSED, sends it to the island, dated by the latest merge; nothing but CLOSED PRs sends it to the jail. The row
    shows the PR that decided."""
    if not prs:
        return NO_PRS
    opened = [pr for pr in prs if pr.state == "OPEN"]
    if opened:
        return PrVerdict(opened[-1], open=True)
    unresolved = any(pr.state not in RESOLVED_PR_STATES for pr in prs)
    merged = [pr for pr in prs if pr.state == "MERGED"]
    if not merged:
        # Nothing open, nothing merged: with nothing unresolved either, every candidate is CLOSED, so prs[-1] is
        # both the newest candidate and the newest closed one. The newest closure dates the jail's own D30 window,
        # so a PR rejected today reaches the jail however long the session has been quiet.
        closed_times = [pr.closed_at for pr in prs if pr.closed_at is not None]
        return PrVerdict(prs[-1], closed=not unresolved,
                         closed_at=max(closed_times) if closed_times and not unresolved else None)
    if unresolved:
        return PrVerdict(prs[-1])
    best, best_at = merged[0], None
    for pr in merged:
        # The app has no merge time, so an unverified merge dates from the session's last activity.
        at = pr.merged_at if pr.merged_at is not None else last_activity_at
        if best_at is None or at >= best_at:
            best, best_at = pr, at
    return PrVerdict(best, merged_at=best_at)


def _island_lane(merged_at: int, now: int) -> _Lane:
    return _Lane("valhalla" if now - merged_at <= BEACH_MS else "castle", "Merged", merged_at,
                 valhalla_reason="merged")


def _open_pr_lane(last_activity_at: int) -> _Lane:
    return _Lane("open_pr", "PR open", last_activity_at)


def _jail_lane(last_activity_at: int) -> _Lane:
    return _Lane("jail", "PR closed", last_activity_at)


def _done_lane(done_at: int, now: int) -> _Lane:
    return _Lane("valhalla" if now - done_at <= BEACH_MS else "castle", "Done", done_at, valhalla_reason="done")


def counted_done_at(done: dict[str, int] | None, row_id: str, activity: int | None, now: int) -> int | None:
    """The row's done mark, unless the session was active after it (or the mark is not a sane time).

    `activity` is the row's done activity (`desktop_done_activity`, `cli_done_activity`); None means no sign of any.
    """
    if not done:
        return None
    done_at = done.get(row_id)
    if type(done_at) is not int or done_at <= 0 or done_at > now + DONE_FUTURE_SLACK_MS:
        return None
    return done_at if activity is None or activity <= done_at + DONE_GRACE_MS else None


def _record_done_activity(tail: Tail | None, now: int) -> int | None:
    """A transcript record is the moment itself, so any record after doneAt is activity. Shifting its time by the
    grace puts it on the same comparison as the app's own times, which get the grace because the app writes them a
    little after the moment. Without that, a reply within two minutes of pressing Done stayed on the island."""
    ts = st.last_record_ts(tail)
    return None if ts is None else min(ts, now) + DONE_GRACE_MS


def desktop_done_activity(rec: DesktopRecord, tail: Tail | None, now: int) -> int:
    """What a desktop row's done mark is judged against: the mark counts while this is at most doneAt + the grace."""
    at = rec.last_activity_at
    if rec.interrupted_by_quit_at is not None:
        at = max(at, min(rec.interrupted_by_quit_at, now))
    record = _record_done_activity(tail, now)
    return at if record is None else max(at, record)


def cli_done_activity(tail: Tail | None, now: int) -> int | None:
    """Only the transcript's records count for a CLI row. Its mtime also moves when the CLI writes last-prompt, a
    title or the mode on exit or rename, which is not activity. With no tail read (not live and older than 7 days)
    there is nothing to judge by; later activity makes the file recent enough to be read again."""
    return _record_done_activity(tail, now)


def has_background(work: BackgroundWork | None) -> bool:
    return work is not None and (work.shells > 0 or work.pending_launches > 0 or bool(work.scheduled_wakeup))


def _background_lane(work: BackgroundWork, verdict: st.Verdict, last_activity_at: int, now: int) -> _Lane:
    start = work.oldest_started_at
    if start is None:
        start = verdict.last_ts if verdict.last_ts is not None else last_activity_at
    start = min(start, now)
    return _Lane("running", "Running", start, (f"{BACKGROUND_HINT} \u00b7 {(now - start) // 60_000} min",))


def _turn_ended_at(verdict: st.Verdict, last_activity_at: int, now: int) -> int:
    """When the turn ended: the ENDED record's time, else the last activity (no transcript, or nothing qualifying).

    A CLI row's last activity is its mtime, which also moves when the CLI writes a title, a mode or a pr-link."""
    if verdict.kind == st.ENDED and verdict.since is not None:
        return min(verdict.since, now)
    return last_activity_at


def _pr_or_done_lane(pr: PrVerdict, done_at: int | None, last_activity_at: int, now: int) -> _Lane | None:
    """The harbour or the island when a PR or a done mark places the row, else None."""
    if pr.open:
        return _done_lane(done_at, now) if done_at is not None else _open_pr_lane(last_activity_at)
    if pr.merged_at is not None:
        return _island_lane(pr.merged_at, now)
    if done_at is not None:
        return _done_lane(done_at, now)
    return None


def _archived_lane(pr: PrVerdict, done_at: int | None, last_activity_at: int, now: int) -> _Lane:
    """Where an archived chat rests. Unfinished business still places it first: a PR still open holds it in the
    harbour, and a merge or a done mark sails it."""
    placed = _pr_or_done_lane(pr, done_at, last_activity_at, now)
    if placed is not None:
        return placed
    return _Lane("graveyard", "Archived", last_activity_at, rest_reason="archived")


def _live_lane(*, entry: RegistryEntry, verdict: st.Verdict, rec: DesktopRecord | None, pr: PrVerdict,
               last_activity_at: int, newest_mtime: int | None, now: int, background: BackgroundWork | None = None,
               done_at: int | None = None) -> _Lane:
    # Archiving is how a chat is put away, so it rests whatever its session is still doing. It rests in the lane it
    # would land in once the process goes, so an archived chat never walks the village twice.
    if rec is not None and rec.is_archived:
        return _archived_lane(pr, done_at, last_activity_at, now)
    status = entry.status
    if status_unreported(entry):
        # The tail stands in for the missing status. A question or a plan review is a pending tool the checks below
        # catch; a permission prompt writes no record at all, so it is inferred from what the call has not done.
        if awaits_approval(verdict, background, now):
            return _Lane("needs_you", "Approve", verdict.since)
        status = "busy" if verdict.kind in (st.MODEL_NEXT, st.TOOL_PENDING, st.RETRYING) else "idle"
    status_since = entry.status_updated_at if entry.status_updated_at is not None else last_activity_at

    if status == "waiting":
        wf = entry.waiting_for
        # The CLI reports a plan approval as "permission prompt", so a pending user-facing tool names it.
        if verdict.kind == st.TOOL_PENDING and verdict.tool_name == "ExitPlanMode":
            label = "Review plan"
        elif verdict.kind == st.TOOL_PENDING and verdict.tool_name == "AskUserQuestion":
            label = "Answer"
        elif wf == "permission prompt":
            label = "Approve"
        elif wf == "input needed":
            label = "Answer"
        else:
            cleaned = _clean(wf) if isinstance(wf, str) else ""
            label = f"Check: {cleaned}" if cleaned else "Check status"
        return _Lane("needs_you", label, status_since)

    if verdict.kind == st.TOOL_PENDING and verdict.tool_name in ("AskUserQuestion", "ExitPlanMode"):
        label = "Answer" if verdict.tool_name == "AskUserQuestion" else "Review plan"
        return _Lane("needs_you", label, verdict.since if verdict.since is not None else last_activity_at)

    if status not in KNOWN_STATUSES:
        return _Lane("needs_you", "Check status", status_since)

    if status == "idle" and verdict.kind in (st.API_ERROR, st.RATE_LIMITED):
        return _Lane("errored", _error_label(verdict),
                     verdict.last_ts if verdict.last_ts is not None else last_activity_at)

    if status in ("busy", "shell"):
        hints: list[str] = []
        if verdict.kind == st.ENDED:
            hints.append("background")
        if verdict.kind == st.RETRYING:
            hints.append("retrying")
        permission_mode = rec.permission_mode if rec is not None else None
        if (verdict.kind == st.TOOL_PENDING and verdict.since is not None
                and now - verdict.since > TOOL_HINT_MS and permission_mode != "auto"):
            hints.append(f"tool running {(now - verdict.since) // 60_000} min")
        if newest_mtime is not None and now - newest_mtime > QUIET_MS:
            hints.append(f"quiet {(now - newest_mtime) // 60_000} min")
        return _Lane("running", "Running", status_since, tuple(hints))

    # status is idle from here on
    if has_background(background):
        # The turn ended, so the registry says idle, but a background task the session launched is still going.
        return _background_lane(background, verdict, last_activity_at, now)
    placed = _pr_or_done_lane(pr, done_at, last_activity_at, now)
    if placed is not None:
        return placed
    if (verdict.kind in (st.ENDED, st.NONE)
            and now - _turn_ended_at(verdict, last_activity_at, now) <= NEEDS_INPUT_MS):
        started = entry.started_at or 0
        since = status_since if last_activity_at >= started else last_activity_at
        return _Lane("your_turn", NEEDS_INPUT_LABEL, since)
    if pr.closed:
        return _jail_lane(last_activity_at)

    return _Lane("idle", "Idle", status_since)


def effective_last_activity(rec: DesktopRecord, tail: Tail | None, now: int) -> int:
    """The record's lastActivityAt, moved forward by later transcript activity or an app quit.

    The app does not always update lastActivityAt when a turn ends or when quitting interrupts one.
    """
    last = rec.last_activity_at
    for ts in (st.last_record_ts(tail), rec.interrupted_by_quit_at):
        if ts is not None:
            last = max(last, min(ts, now))
    return last


def _dead_lane(*, verdict: st.Verdict, rec: DesktopRecord | None, pr: PrVerdict, last_activity_at: int,
               now: int, done_at: int | None = None) -> _Lane:
    recent = _within_d7(last_activity_at, now)
    archived = rec is not None and rec.is_archived

    # Marking done, like archiving, is Charlie saying he has dealt with a recent error.
    if not archived and done_at is None:
        if verdict.kind == st.API_ERROR and recent:
            return _Lane("errored", _error_label(verdict),
                         verdict.last_ts if verdict.last_ts is not None else last_activity_at)
        # errorAt is paired with the record's own lastActivityAt, which the app writes at the same moment.
        if (rec is not None and rec.error_at is not None and _within_d7(rec.error_at, now)
                and rec.error_at >= rec.last_activity_at - ERROR_AT_SLACK_MS):
            return _Lane("errored", "Error", rec.error_at)
    if archived:
        return _archived_lane(pr, done_at, last_activity_at, now)
    placed = _pr_or_done_lane(pr, done_at, last_activity_at, now)
    if placed is not None:
        return placed
    if verdict.kind in (st.MODEL_NEXT, st.TOOL_PENDING) and recent:
        return _Lane("stopped", "Stopped mid-turn", last_activity_at)
    # A terminal or editor session has no archive: ending it is how it is put away, as archiving is on the desktop.
    if rec is None:
        return _Lane("graveyard", "Ended", last_activity_at, rest_reason="ended")
    # Capped at D30 so the graveyard still keeps the long-dead, and so a closed PR is never count-only `old`. The
    # window is dated by the newer of the last activity and the closure: a PR rejected yesterday on a session that
    # went quiet months ago is exactly the row worth seeing in the jail. `since` stays the last activity, so the
    # row still reads "Active N ago".
    if pr.closed and now - max(last_activity_at, pr.closed_at or 0) <= GRAVEYARD_INACTIVE_MS:
        return _jail_lane(last_activity_at)
    if recent:
        return _Lane("recent", "Recent", last_activity_at)
    if now - last_activity_at > GRAVEYARD_INACTIVE_MS:
        return _Lane("graveyard", "Inactive", last_activity_at, rest_reason="inactive")
    return _Lane("old")


def _short_id(session_id: str) -> str:
    return session_id.removeprefix("local_")[:8]


def _pr_json(pr: EffectivePr | None) -> dict | None:
    if pr is None:
        return None
    return {"number": pr.number, "state": pr.state, "url": pr.url, "verified": pr.verified,
            "mergedAt": pr.merged_at}


@dataclass(slots=True)
class IslandIndex:
    """Which island a review request queues on, from the PR links of the rows the board shows.

    An island is named after a local folder and a request after a GitHub repo, and anyone can open a repo that
    shares a name with one of Charlie's. So a request lands on an island only when a row's own PR link ties that
    folder to that GitHub repo, or failing that, when his rows link PRs under the same owner and the folder carries
    the repo's name (compared without case, since GitHub sends its canonical case) and no link ties it to that name
    under another owner. Anything else waits at the whole board's desk and badges no island.
    """
    linked: dict[tuple[str, str], dict[str, int]] = field(default_factory=dict)
    owners: set[str] = field(default_factory=set)
    islands: set[str] = field(default_factory=set)

    def add(self, island: str | None, urls) -> None:
        if island:
            self.islands.add(island)
        seen: set[tuple[str, str]] = set()
        for url in urls:
            parts = parse_pr_url(url) if isinstance(url, str) else None
            if parts is None:
                continue
            key = (parts[0].lower(), parts[1].lower())
            self.owners.add(key[0])
            if island and key not in seen:
                seen.add(key)
                counts = self.linked.setdefault(key, {})
                counts[island] = counts.get(island, 0) + 1

    def island_for(self, owner: object, repo: object) -> str | None:
        if not (isinstance(owner, str) and isinstance(repo, str) and owner and repo):
            return None
        key = (owner.lower(), repo.lower())
        hits = self.linked.get(key)
        if hits:
            return min(hits, key=lambda name: (-hits[name], name.lower() != key[1], name))
        if key[0] not in self.owners:
            return None
        elsewhere = {name for (o, r), names in self.linked.items() if r == key[1] and o != key[0] for name in names}
        named = sorted((n for n in self.islands if n.lower() == key[1] and n not in elsewhere),
                       key=lambda n: (n != repo, n))
        return named[0] if named else None


def _usable_visitor(req: ReviewRequest) -> bool:
    """Whether the page may be handed this request.

    The id and URL are checked again here, so a request built by hand (a test, or a future source) can never put
    a value the open action would refuse into the array the page clicks on. The number must be >= 1 for the same
    reason both clients drop one that is not: a published `reviews.waiting` that counted a visitor neither of them
    draws would put the HUD pill and the desk queue permanently one apart.
    """
    if not (isinstance(req.id, str) and REVIEW_ID_RE.match(req.id)):
        return False
    return safe_pr_url(req.url) is not None and type(req.number) is int and req.number >= 1


def _via(value: object) -> str:
    """"you" only when the source said so: anything else is read as the less urgent of the two."""
    return value if isinstance(value, str) and value in (VIA_YOU, VIA_TEAM) else VIA_TEAM


def visitor_json(req: ReviewRequest, places: IslandIndex | None = None) -> dict | None:
    """One visitor, or None when the request is not one the page may be handed."""
    if not _usable_visitor(req):
        return None
    via = _via(req.via)
    return {
        "id": req.id,
        "number": req.number,
        "repo": req.repo,
        "owner": req.owner,
        "island": places.island_for(req.owner, req.repo) if places is not None else None,
        "title": req.title,
        "author": req.author,
        "via": via,
        # Slugs are checked again as well: a hand-built request is held to the source's own rule. A "you" visitor
        # names no team, so the tooltip can only ever read one way.
        "teams": list(team_slugs(req.teams)) if via == VIA_TEAM else [],
        "waitingSince": req.waiting_since,
        # From the login, so the same reviewer looks the same wherever they queue; the id when there is none.
        "look": look_for(req.author or req.id),
    }


def visitors_json(reviews: ReviewSnapshot | None, places: IslandIndex | None = None) -> list[dict]:
    """Queue order, at most MAX_VISITORS, the ones asking him by name kept first past the cap (`keep_visitors`)."""
    if reviews is None:
        return []
    usable = [replace(req, via=_via(req.via)) for req in reviews.requests if _usable_visitor(req)]
    return [visitor for visitor in (visitor_json(req, places) for req in keep_visitors(usable))
            if visitor is not None]


def reviews_json(visitors: list[dict], reviews: ReviewSnapshot | None, rows: list[dict]) -> dict:
    """The counts the HUD pill and the world map's island badges read, and the Harbour's "waiting on" logins.

    `viaYou` and `viaTeam` split `waiting` by each visitor's `via`, so they always add up to it.
    `byRepo` is keyed by each visitor's `island`, the way rows name their repo, and leaves out a visitor with no
    island, which waits at the whole board's desk and badges nothing. `waitingOn` is keyed by the
    URL a row already carries, and holds only rows the board is showing: a review request on a PR no session of
    his links is a visitor, not a "waiting on" line.
    """
    by_repo: dict[str, int] = {}
    for visitor in visitors:
        island = visitor["island"]
        if island is not None:
            by_repo[island] = by_repo.get(island, 0) + 1
    waiting_on: dict[str, list[str]] = {}
    if reviews is not None:
        shown = {row["pr"]["url"] for row in rows if row["pr"] is not None and row["pr"]["url"] is not None}
        for url, logins in reviews.reviewers.items():
            if url in shown and logins and safe_pr_url(url) is not None:
                waiting_on[url] = list(logins)
    via_you = sum(1 for visitor in visitors if visitor["via"] == VIA_YOU)
    return {"waiting": len(visitors), "viaYou": via_you, "viaTeam": len(visitors) - via_you, "byRepo": by_repo,
            "waitingOn": waiting_on}


def _token_counts(t) -> dict:
    return {"input": t.input, "output": t.output, "cacheRead": t.cache_read, "cacheWrite": t.cache_write}


def tokens_json(tokens: SessionTokens | None) -> dict | None:
    if tokens is None:
        return None
    return {**_token_counts(tokens.main), "context": tokens.main.context,
            "subagents": _token_counts(tokens.subagents), "complete": tokens.complete}


def plan_usage_json(usage: PlanUsage | None, now: int) -> dict | None:
    """Each limit's reading expires with its own window, so an old sample never shows as current."""
    if usage is None:
        return None
    age = now - usage.sampled_at
    return {
        "fiveHourPct": usage.five_hour_pct if age <= PLAN_FIVE_HOUR_MS else None,
        "weeklyPct": usage.weekly_pct if age <= PLAN_WEEKLY_MS else None,
        "sampledAt": usage.sampled_at,
        "stale": age > PLAN_STALE_MS,
    }


def _pick_entries(entries: tuple[RegistryEntry, ...]) -> dict[str, RegistryEntry]:
    by_id: dict[str, RegistryEntry] = {}
    for e in entries:
        cur = by_id.get(e.session_id)
        if cur is None or (e.status_updated_at or 0, e.pid) > (cur.status_updated_at or 0, cur.pid):
            by_id[e.session_id] = e
    return by_id


def _sort_key(row: dict):
    lane_idx = LANE_ORDER.index(row["lane"])
    if row["lane"] in SINCE_ASC_LANES:
        return (lane_idx, row["since"], row["id"])
    if row["lane"] in ISLAND_LANES:
        # since is the merge time (GitHub's, else last activity) or the done time: when the row reached the island.
        return (lane_idx, -row["since"], row["id"])
    return (lane_idx, -row["lastActivityAt"], row["id"])


def session_activity(raw: RawSnapshot, now: int) -> dict[str, int]:
    """Effective last activity for every session id the board knows, including count-only rows."""
    desktop_cli_ids = {r.cli_session_id for r in raw.desktop if r.cli_session_id}
    activity: dict[str, int] = {}
    for rec in raw.desktop:
        tail = raw.tails.get(rec.cli_session_id) if rec.cli_session_id else None
        activity[rec.session_id] = effective_last_activity(rec, tail, now)
    for cli in raw.cli_only:
        if cli.session_id not in desktop_cli_ids:
            activity[f"cli:{cli.session_id}"] = cli.last_activity_at
    return activity


def valhalla_ask_at(tail: Tail | None) -> int | None:
    """The time of the latest message Charlie typed in the session, when that message asked to sail to Valhalla.

    A message typed mid-turn counts as the latest too, so anything typed after the request cancels it. A task
    notification or a subagent's prompt is not something he typed.
    """
    if tail is None:
        return None
    for r in reversed(tail.records):
        if r.is_sidechain or r.task_notification:
            continue
        typed = r.queued_prompt or (r.type == "user" and not r.is_meta and bool(r.block_types)
                                    and "tool_result" not in r.block_types)
        if typed:
            return r.timestamp if r.valhalla_ask else None
    return None


def valhalla_asks(raw: RawSnapshot, now: int) -> dict[str, tuple[int, int]]:
    """Row id -> (time of the Valhalla request, the session's last activity), for every row whose latest typed message
    is one. The mark is dated at that last activity, the end of the reply, not a grace later: a record after it must
    count as new activity at once (see `_record_done_activity`)."""
    desktop_cli_ids = {r.cli_session_id for r in raw.desktop if r.cli_session_id}
    asks: dict[str, tuple[int, int]] = {}
    for rec in raw.desktop:
        tail = raw.tails.get(rec.cli_session_id) if rec.cli_session_id else None
        at = valhalla_ask_at(tail)
        if at is not None:
            asks[rec.session_id] = (at, min(now, effective_last_activity(rec, tail, now)))
    for cli in raw.cli_only:
        if cli.session_id not in desktop_cli_ids:
            tail = raw.tails.get(cli.session_id)
            at, last = valhalla_ask_at(tail), st.last_record_ts(tail)
            if at is not None and last is not None:
                asks[f"cli:{cli.session_id}"] = (at, min(now, last))
    return asks


def done_activity(raw: RawSnapshot, now: int) -> dict[str, int]:
    """The done activity of every row that has one, including count-only rows: what `counted_done_at` compares.

    The server removes a stored mark when this is past doneAt + DONE_GRACE_MS, exactly when the board ignores it.
    """
    desktop_cli_ids = {r.cli_session_id for r in raw.desktop if r.cli_session_id}
    activity: dict[str, int] = {}
    for rec in raw.desktop:
        tail = raw.tails.get(rec.cli_session_id) if rec.cli_session_id else None
        activity[rec.session_id] = desktop_done_activity(rec, tail, now)
    for cli in raw.cli_only:
        if cli.session_id not in desktop_cli_ids:
            at = cli_done_activity(raw.tails.get(cli.session_id), now)
            if at is not None:
                activity[f"cli:{cli.session_id}"] = at
    return activity


def health_problems(raw: RawSnapshot, unknown_statuses: list[str], *, sessions: int) -> list[str]:
    """Why health asks for a look. `tokentown check` prints these after NOT OK, and the page lists them."""
    problems = []
    if unknown_statuses:
        problems.append("unknown statuses")
    if raw.desktop_parse_errors > 5:
        problems.append("parse errors over 5")
    # Only a scanner reports folders: a snapshot without them is a test's, where an empty board is fine.
    if raw.folders:
        code = [f for f in raw.folders if f.kind == "code"]
        if not any(f.found for f in code):
            problems.append("no Claude Code folder")
        if any(f.label == CONFIG_DIR_ENV and not f.found for f in code):
            problems.append(f"no folder at {CONFIG_DIR_ENV}")
        if sessions == 0:
            problems.append("no sessions found")
        # Every transcript looked for is missing, as when the Claude app keeps its Claude Code folder elsewhere.
        if raw.tails and not any(t.found for t in raw.tails.values()):
            problems.append("no transcripts found")
    return problems


def with_source_problems(health: dict, sources) -> dict:
    """health asking for a look while any gh source's health (github, reviews, updates) says gh is not signed in."""
    problems = list(health.get("problems") or [])
    signed_out = any(isinstance(s, dict) and s.get("lastError") in GH_SIGN_IN_ERRORS for s in sources)
    if not signed_out or GH_SIGN_IN_PROBLEM in problems:
        return health
    return {**health, "ok": False, "problems": problems + [GH_SIGN_IN_PROBLEM]}


def build_board(raw: RawSnapshot, now: int, github: dict[str, GitHubPr] | None = None,
                done: dict[str, int] | None = None, reviews: ReviewSnapshot | None = None) -> dict:
    entries = _pick_entries(raw.registry_live)
    verdicts = {key: st.tail_verdict(tail, now) for key, tail in raw.tails.items()}
    desktop_cli_ids = {r.cli_session_id for r in raw.desktop if r.cli_session_id}

    counts = {lane: 0 for lane in ALL_LANES}
    rows: list[dict] = []
    places = IslandIndex()

    def add(*, row_id: str, kind: str, surface: str, title: str | None, lane: _Lane, rec: DesktopRecord | None,
            cli: CliTranscript | None, pr: PrVerdict, live: bool, last_activity_at: int, done_at: int | None,
            prs: tuple[EffectivePr, ...] = (), where: str | None = None, editor: str | None = None) -> None:
        counts[lane.lane] += 1
        if lane.lane not in LANE_ORDER:
            return
        if rec is not None:
            repo, cwd = _basename(rec.origin_cwd), rec.cwd
            unread = lane.lane == "recent" and last_activity_at > (rec.last_focused_at or 0) + FOCUS_GRACE_MS
            short = _short_id(rec.session_id)
            tokens = raw.tokens.get(rec.cli_session_id) if rec.cli_session_id else None
        else:
            # Shown by the folder it works in now; the resume command and the editor keep the one it started in.
            cwd = where or cli.cwd
            repo = _cli_repo(cwd)
            unread = False
            short = cli.session_id[:8]
            tokens = raw.tokens.get(cli.session_id)
        places.add(repo, (p.url for p in prs))
        rows.append({
            "id": row_id,
            "kind": kind,
            "surface": surface,
            "editor": editor,
            "lane": lane.lane,
            "label": lane.label,
            "hints": list(lane.hints),
            "since": lane.since if lane.since is not None else last_activity_at,
            "title": title,
            "shortId": short,
            "repo": repo,
            "worktree": _worktree(cwd),
            "branch": rec.branch if rec is not None else None,
            "model": rec.model if rec is not None else None,
            "effort": rec.effort if rec is not None else None,
            "live": live,
            "unread": unread,
            "pr": _pr_json(pr.shown),
            "lastActivityAt": last_activity_at,
            # An editor session opens by bringing forward its editor's window with its folder, which a folder that is
            # gone rules out. Only a closed one is then resumed: the extension's session link finds just a tab the
            # link itself opened, so on a session still open there it would start a second copy on the same transcript.
            # A resume command would do that to any live session, so only an ended one has one.
            "canOpen": ((kind == "desktop" and bool(LOCAL_ID_RE.match(row_id)))
                        or (surface == "vscode" and bool(CLI_ROW_ID_RE.match(row_id)) and bool(cli.cwd_exists))),
            "canCopyResume": kind == "cli" and bool(cli.cwd_exists) and not live,
            "look": look_for(row_id),
            "createdAt": rec.created_at if rec is not None else None,
            "turns": rec.completed_turns if rec is not None else None,
            "tokens": tokens_json(tokens),
            "restReason": lane.rest_reason,
            "doneAt": done_at,
            "valhallaReason": lane.valhalla_reason,
            "canMarkDone": lane.lane not in NO_DONE_LANES and not (live and lane.lane in BUSY_LANES),
        })

    for rec in raw.desktop:
        entry = entries.get(rec.cli_session_id) if rec.cli_session_id else None
        tail: Tail | None = raw.tails.get(rec.cli_session_id) if rec.cli_session_id else None
        verdict = verdicts.get(rec.cli_session_id, st.NO_VERDICT) if rec.cli_session_id else st.NO_VERDICT
        last = effective_last_activity(rec, tail, now)
        links = raw.pr_links.get(rec.cli_session_id, ()) if rec.cli_session_id else ()
        prs = effective_prs(rec.prs, github, links)
        pr = pr_verdict(prs, last)
        done_at = counted_done_at(done, rec.session_id, desktop_done_activity(rec, tail, now), now)
        if entry is not None:
            lane = _live_lane(entry=entry, verdict=verdict, rec=rec, pr=pr, last_activity_at=last,
                              newest_mtime=tail.newest_mtime if tail else None, now=now,
                              background=raw.background.get(rec.cli_session_id), done_at=done_at)
        else:
            lane = _dead_lane(verdict=verdict, rec=rec, pr=pr, last_activity_at=last, now=now, done_at=done_at)
        add(row_id=rec.session_id, kind="desktop", surface="desktop", title=rec.title, lane=lane, rec=rec, cli=None,
            pr=pr, live=entry is not None, last_activity_at=last, done_at=done_at, prs=prs)

    for cli in raw.cli_only:
        if cli.session_id in desktop_cli_ids:
            continue
        row_id = f"cli:{cli.session_id}"
        entry = entries.get(cli.session_id)
        tail = raw.tails.get(cli.session_id)
        verdict = verdicts.get(cli.session_id, st.NO_VERDICT)
        prs = effective_prs((), github, raw.pr_links.get(cli.session_id, ()))
        pr = pr_verdict(prs, cli.last_activity_at)
        done_at = counted_done_at(done, row_id, cli_done_activity(tail, now), now)
        if entry is not None:
            lane = _live_lane(entry=entry, verdict=verdict, rec=None, pr=pr, last_activity_at=cli.last_activity_at,
                              newest_mtime=tail.newest_mtime if tail else None, now=now,
                              background=raw.background.get(cli.session_id), done_at=done_at)
        else:
            lane = _dead_lane(verdict=verdict, rec=None, pr=pr, last_activity_at=cli.last_activity_at, now=now,
                              done_at=done_at)
        surface = cli_surface(cli, entry, raw.editor_hosted)
        add(row_id=row_id, kind="cli", surface=surface, title=tail.title if tail is not None else None, lane=lane,
            rec=None, cli=cli, pr=pr, live=entry is not None, last_activity_at=cli.last_activity_at, done_at=done_at,
            prs=prs, where=tail.cwd if tail is not None else None,
            editor=row_editor(raw, cli.session_id) if surface == "vscode" else None)

    rows.sort(key=_sort_key)

    rate_limit = None
    for v in verdicts.values():
        if v.kind == st.RATE_LIMITED and v.resets_at is not None and v.resets_at > now:
            if rate_limit is None or v.resets_at > rate_limit["resetsAt"]:
                rate_limit = {"resetsAt": v.resets_at, "limitType": v.limit_type}

    unknown_statuses = sorted({
        MISSING_STATUS if e.status is None else (_clean(e.status) or MISSING_STATUS)
        for e in raw.registry_live if e.status not in KNOWN_STATUSES and not status_unreported(e)
    })
    unknown_types = sorted({_clean(t) for tail in raw.tails.values() for t in tail.unknown_types} - {""})
    problems = health_problems(raw, unknown_statuses, sessions=sum(counts.values()))
    health = {
        "ok": not problems,
        "problems": problems,
        "folders": [{"label": f.label, "kind": f.kind, "found": f.found} for f in raw.folders],
        "appVersion": raw.app_version,
        "cliVersions": sorted(set(raw.cli_versions), key=_version_key),
        "desktop": {"records": len(raw.desktop), "parseErrors": raw.desktop_parse_errors},
        "registry": {
            "files": raw.registry_files,
            "live": len(raw.registry_live),
            "joined": sum(1 for e in raw.registry_live if e.session_id in desktop_cli_ids),
            "unknownStatuses": unknown_statuses,
        },
        "transcripts": {
            "tailed": sum(1 for t in raw.tails.values() if t.found),
            "missing": sum(1 for t in raw.tails.values() if not t.found),
            "unknownTypes": unknown_types,
        },
        "tokens": {"tracked": len(raw.tokens), "complete": sum(1 for t in raw.tokens.values() if t.complete)},
        "waitingSeenNow": sum(1 for e in raw.registry_live if e.status == "waiting"),
        "scanMs": raw.scan_ms,
        "warnings": list(raw.warnings),
    }

    visitors = visitors_json(reviews, places)
    return {
        "v": 1,
        "generatedAt": now,
        "alert": counts["needs_you"] + counts["errored"],
        "counts": counts,
        "rateLimit": rate_limit,
        "planUsage": plan_usage_json(raw.plan_usage, now),
        "health": health,
        "sessions": rows,
        "visitors": visitors,
        "reviews": reviews_json(visitors, reviews, rows),
    }
