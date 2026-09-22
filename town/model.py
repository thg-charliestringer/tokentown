"""Shapes shared by the scanner (sources.py), the status rules (status.py, board.py) and the server.

Every timestamp is epoch milliseconds. Nothing here holds prompts, message text, tool inputs or
error text: structure only, and a session's title (Tail.title).
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class PullRequest:
    number: int
    state: str  # upper-cased: OPEN | MERGED | CLOSED, or an unknown value kept verbatim
    url: str | None  # raw from disk; board.py validates it before it reaches the page
    dismissed: bool = False


@dataclass(frozen=True, slots=True)
class DesktopRecord:
    session_id: str  # local_<uuid>, equals the file name
    cli_session_id: str | None
    cwd: str  # the worktree path when the session ran in one
    origin_cwd: str  # always the repo root
    title: str | None
    model: str | None
    effort: str | None
    branch: str | None
    permission_mode: str | None
    created_at: int | None  # null when the record has no createdAt
    last_activity_at: int
    last_focused_at: int | None
    is_archived: bool
    error_at: int | None
    prs: tuple[PullRequest, ...]
    transcript_unavailable: bool
    interrupted_by_quit_at: int | None = None
    completed_turns: int | None = None


@dataclass(frozen=True, slots=True)
class RegistryEntry:
    """A ~/.claude/sessions/<pid>.json whose pid is alive and whose procStart matches ps."""
    pid: int
    session_id: str  # equals DesktopRecord.cli_session_id
    cwd: str
    status: str | None  # idle | busy | waiting | shell, or an unknown value kept verbatim
    waiting_for: str | None
    status_updated_at: int | None
    started_at: int | None
    version: str | None
    entrypoint: str | None


@dataclass(frozen=True, slots=True)
class TailRecord:
    type: str
    subtype: str | None
    timestamp: int | None
    is_sidechain: bool
    is_meta: bool
    stop_reason: str | None
    block_types: tuple[str, ...]
    tool_uses: tuple[tuple[str, str], ...]  # (tool_use_id, tool_name)
    tool_result_ids: tuple[str, ...]
    is_api_error: bool
    error_kind: str | None  # rate_limit | server_error | authentication_failed | ...
    retry_attempt: int | None
    max_retries: int | None
    quota_status: str | None
    quota_resets_at: int | None
    quota_limit_type: str | None
    # a Bash tool_use with input.run_in_background true, a user record whose toolUseResult.status is async_launched
    # (Agent and Workflow launches, which mostly set no flag), or the taskId result of a Monitor call in the same window;
    # cleared when a later TaskStop result in the same window names the launch's task
    background_launch: bool = False
    # a user record whose text opens with <task-notification (opening tag only), or a queued task-notification attachment
    task_notification: bool = False
    # a message typed while the model was busy, queued into the running turn as a `queued_command` attachment
    queued_prompt: bool = False
    # a typed message that is only a request to sail (sources.VALHALLA_ASK_RE); the text itself is never kept
    valhalla_ask: bool = False


@dataclass(frozen=True, slots=True)
class PrLink:
    """A transcript `pr-link` record: the Claude app stopped copying these into desktop prs[] around Aug 2026."""
    number: int
    url: str | None
    repository: str | None  # owner/repo
    timestamp: int | None


@dataclass(frozen=True, slots=True)
class BackgroundWork:
    """Work a live session is still doing after it ended its turn (the registry then says idle)."""
    shells: int  # Claude shell processes (args contain shell-snapshots) that are children of the session's CLI pid
    oldest_started_at: int | None  # epoch ms, from ps etime
    pending_launches: int  # background launches in the tail after the latest task notification
    scheduled_wakeup: bool  # the last turn called ScheduleWakeup


@dataclass(frozen=True, slots=True)
class Tail:
    found: bool
    records: tuple[TailRecord, ...]  # oldest first
    newest_mtime: int | None  # newest mtime across the transcript and <id>/subagents/**
    unknown_types: tuple[str, ...] = ()
    # The newest title Claude recorded in the tail: the session renamed (customTitle) beats its own summary (aiTitle).
    # The one piece of transcript text kept, shown like a desktop title and never logged.
    title: str | None = None
    # The folder the newest main-chain record names. A session can move to another folder part way through, while
    # its transcript stays filed under the one it started in.
    cwd: str | None = None


@dataclass(frozen=True, slots=True)
class CliTranscript:
    """A transcript with no desktop record: a session started from a terminal or the Claude Code extension."""
    session_id: str
    cwd: str
    cwd_exists: bool
    last_activity_at: int
    entrypoint: str | None = None  # the first record's: "cli" from a terminal, "claude-vscode" from the extension


@dataclass(frozen=True, slots=True)
class TokenTotals:
    """Summed message.usage over distinct assistant message ids (the last record per id wins)."""
    input: int = 0
    output: int = 0
    cache_read: int = 0
    cache_write: int = 0  # cache_creation_input_tokens
    messages: int = 0
    context: int | None = None  # newest main-chain assistant record: input + cache_read + cache_write


@dataclass(frozen=True, slots=True)
class SessionTokens:
    main: TokenTotals  # the session's own transcript
    subagents: TokenTotals  # every <cli_session_id>/subagents/** transcript, summed
    complete: bool  # every tracked file has been read to its current end


@dataclass(frozen=True, slots=True)
class GitHubPr:
    """A PR's state as GitHub reports it. The Claude app's own prs[].state goes stale once a session is idle."""
    state: str  # OPEN | MERGED | CLOSED (closed without merging)
    merged_at: int | None
    closed_at: int | None
    checked_at: int


@dataclass(frozen=True, slots=True)
class ReviewRequest:
    """An open PR on GitHub waiting for Charlie's review: a visitor, not a session.

    It carries no session data because there is none behind it. `url` is rebuilt from the three parts
    `github.parse_pr_url` accepted, never the string gh answered with.
    """
    id: str  # pr:<16 hex of the URL>: what the page is given, and all it can send back
    number: int
    owner: str
    repo: str
    url: str
    title: str | None
    author: str | None  # the PR author's GitHub login
    waiting_since: int | None  # when the PR was opened: the search carries no request time
    via: str = "you"  # "you" when the direct search listed it, "team" when only the broad one did
    teams: tuple[str, ...] = ()  # slugs of the teams the PR asks; () for "you", and until GitHub has said


@dataclass(frozen=True, slots=True)
class ReviewSnapshot:
    """What `reviews.ReviewSource` knows: the visitors (each carrying its teams), and who each of his own open PRs
    waits on."""
    requests: tuple[ReviewRequest, ...] = ()
    reviewers: dict[str, tuple[str, ...]] = field(default_factory=dict)  # keyed by PR URL


@dataclass(frozen=True, slots=True)
class SourceFolder:
    """A folder the scanner looks in, by its label (paths.CLAUDE_DIR_LABEL, CONFIG_DIR_ENV or APP_DATA_NAMES)."""
    label: str
    kind: str  # "code": a Claude Code folder. "app": a Claude app folder
    found: bool  # a code folder that exists, or an app folder holding session records


@dataclass(frozen=True, slots=True)
class PlanUsage:
    """Newest sample from the Claude app's plan-usage-history.json."""
    five_hour_pct: int | None
    weekly_pct: int | None
    sampled_at: int


@dataclass(frozen=True, slots=True)
class RawSnapshot:
    scanned_at: int
    desktop: tuple[DesktopRecord, ...]
    registry_files: int
    registry_live: tuple[RegistryEntry, ...]
    cli_only: tuple[CliTranscript, ...]
    tails: dict[str, Tail]  # keyed by cli session id
    app_version: str | None
    cli_versions: tuple[str, ...]
    desktop_parse_errors: int
    scan_ms: int
    warnings: tuple[str, ...] = field(default=())
    tokens: dict[str, SessionTokens] = field(default_factory=dict)  # keyed by cli session id
    plan_usage: PlanUsage | None = None
    pr_links: dict[str, tuple[PrLink, ...]] = field(default_factory=dict)  # keyed by cli session id, oldest first
    background: dict[str, BackgroundWork] = field(default_factory=dict)  # keyed by cli session id, live sessions only
    # Cli session id -> editor key (paths.EDITORS) for live sessions whose process runs under an editor: in the
    # Claude Code extension's chat, or the editor's own terminal.
    editor_hosted: dict[str, str] = field(default_factory=dict)
    # The same for every session seen live under an editor since the server started, while it is still known.
    editors_seen: dict[str, str] = field(default_factory=dict)
    # The first editor installed, for a chat never seen live. None when there is none.
    default_editor: str | None = None
    # Every folder the scan looked in. Empty when no scanner reported any, which health reads as unknown.
    folders: tuple[SourceFolder, ...] = ()
