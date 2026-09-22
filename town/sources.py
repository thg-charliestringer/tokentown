"""Reads the three session stores into a model.RawSnapshot: structure only, never message text.

The one piece of text kept is a session's title from its transcript tail, shown like a desktop title.
"""
from __future__ import annotations

import bisect
import json
import os
import plistlib
import re
import stat
import subprocess
import time
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

from . import model
from .paths import DESKTOP_SESSIONS, EDITORS, PLAN_USAGE, UUID_RE, Paths, is_denied, open_for_read
from .linkstore import LinkStore
from .prlinks import PrLinkIndex, merge_links
from .usage import TokenLedger

TAIL_WINDOW = 256 * 1024
TAIL_WINDOW_MAX = 4 * 1024 * 1024
HEAD_LIMIT = 1024 * 1024
RECENT_MS = 7 * 24 * 3600 * 1000
PS_RECHECK_S = 300.0
TOKEN_BYTES_PER_SCAN = 48 * 1024 * 1024
PR_LINK_BYTES_PER_SCAN = 32 * 1024 * 1024
PR_LINK_WINDOW_MS = 60 * 24 * 3600 * 1000
PR_LINK_MAX_PRIOR_FILES = 20
PLAN_USAGE_MAX_BYTES = 8 * 1024 * 1024
PLAN_FUTURE_SLACK_MS = 5 * 60 * 1000

# Tools whose background launch shows only in the call's input. Agent, Task and Workflow launches are read from their
# result instead: most set no run_in_background at all and still return status async_launched.
BACKGROUND_TOOLS = frozenset({"Bash"})
ASYNC_LAUNCHED = "async_launched"
# Monitor always runs in the background, has no run_in_background key and its result no status. A call only counts
# once its result carries a taskId, so a denied or failed call never waits for a notification that cannot come.
MONITOR_TOOL = "Monitor"
MONITOR_TASK_KEY = "taskId"
# TaskStop ends a task with no report back: none came for any of 7 stopped background shells, nor for a monitor stopped
# before its first event. Its result names the task, so the launch it stopped stops counting. Launch results name their
# task under one of these keys (background Bash, Monitor and Workflow, Agent).
TASK_STOP_TOOL = "TaskStop"
TASK_STOP_ID_KEY = "task_id"
LAUNCH_TASK_KEYS = ("backgroundTaskId", "taskId", "agentId")
TASK_NOTIFICATION_PREFIX = "<task-notification"
SCHEDULE_WAKEUP_TOOL = "ScheduleWakeup"
# A message that is nothing but a request to sail, such as "ok go to valhalla" or "send it to Valhalla please". The
# whole message must match: a sentence that only mentions Valhalla ("yes to saying go to valhalla in chat") never does.
VALHALLA_ASK_MAX_CHARS = 60
_ASK_FILLER = (r"(?:ok|okay|k|right|alright|great|cool|nice|lovely|perfect|brilliant|thanks|thank you|ta|cheers|yes"
               r"|yeah|yep|now|please|so|and|then|done|all done)")
_ASK_VERB = (r"(?:(?:you can |now )?(?:go|head|sail|off|send|send it|send this|send yourself|ship it|ship this"
             r"|lets go|time to go))")
_ASK_TAIL = r"(?:please|thanks|thank you|now|then|cheers|ta)"
VALHALLA_ASK_RE = re.compile(rf"(?:{_ASK_FILLER} )*(?:(?:{_ASK_VERB} )?to )?valhalla(?: {_ASK_TAIL})*")
PS_TABLE_ARGV = ("/bin/ps", "-A", "-o", "pid=,ppid=,etime=,args=")
PS_TABLE_ENV = {"PATH": "/usr/bin:/bin", "LC_ALL": "C"}
PS_TABLE_INTERVAL_S = 5.0
PS_WARNING_INTERVAL_S = 60.0
SHELL_MARKER = b"shell-snapshots"
# Every editor process's args carry its app bundle's path. A session with one among its process's ancestors runs in
# that editor: in the Claude Code extension's chat, or as `claude` in the editor's own terminal.
EDITOR_PROCESS_MARKERS = tuple((f"/{editor.app}/".encode(), editor.key) for editor in EDITORS)
ANCESTOR_STEPS = 16

REGISTRY_NAME_RE = re.compile(r"^\d+\.json\Z")
# Enum-like values only. Anything else (free text) is dropped so no prose can ride along.
_ENUM_RE = re.compile(r"^[A-Za-z0-9_.:\-]{1,120}\Z")

KNOWN_TYPES = frozenset({
    "assistant", "user", "system", "attachment", "last-prompt", "atis-latch", "bridge-session",
    "custom-title", "queue-operation", "mode", "ai-title", "pr-link", "file-history-snapshot",
    "file-history-delta", "frame-link", "summary", "started", "result", "launched",
    # Seen on this machine 2026-09-16 but missing from the original list.
    "permission-mode", "cost-state", "agent-name",
})
QUALIFYING_SYSTEM_SUBTYPES = frozenset({"stop_hook_summary", "api_error"})
# Local slash commands and bash mode write user records that never start a model turn.
LOCAL_OUTPUT_PREFIXES = ("<local-command-stdout>", "<local-command-stderr>", "<local-command-caveat>",
                         "<bash-input>", "<bash-stdout>", "<bash-stderr>")
COMMAND_NAME_PREFIX = "<command-name>"
DESKTOP_ENTRYPOINT = "claude-desktop"
# Title records and the field holding each one's text. The CLI rewrites them all through a transcript, so the tail
# holds a current one.
TITLE_FIELDS = {"custom-title": "customTitle", "ai-title": "aiTitle"}
TITLE_MAX_CHARS = 200

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _now_ms() -> int:
    return time.time_ns() // 1_000_000


def _enum(value) -> str | None:
    return value if isinstance(value, str) and _ENUM_RE.match(value) else None


def _int(value) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        return int(value)
    except (ValueError, OverflowError):  # json.loads accepts NaN and Infinity
        return None


def _epoch_ms(value) -> int | None:
    """Integer epoch in seconds or milliseconds, detected by magnitude."""
    n = _int(value)
    if n is None:
        return None
    return n * 1000 if abs(n) < 10**11 else n


def _iso_ms(value) -> int | None:
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (dt - _EPOCH) // timedelta(milliseconds=1)


def _mtime_ms(st: os.stat_result) -> int:
    return st.st_mtime_ns // 1_000_000


def _regular_mtime(path: Path) -> int | None:
    """mtime in ms of a regular file that is not a symlink, else None."""
    try:
        st = os.stat(path, follow_symlinks=False)
    except (OSError, ValueError):
        return None
    return _mtime_ms(st) if stat.S_ISREG(st.st_mode) else None


def _folder_key(path: Path) -> tuple[int, int] | None:
    """(device, inode) of the folder at an absolute path, else None. A relative path is never read."""
    if not path.is_absolute():
        return None
    try:
        st = os.stat(path)
    except (OSError, ValueError):
        return None
    return (st.st_dev, st.st_ino) if stat.S_ISDIR(st.st_mode) else None


def _norm_lstart(value: str) -> str:
    return " ".join(value.split())


# ---------------------------------------------------------------------------------------------------
# Liveness


class ProcessChecker:
    """Default is_live: the pid exists AND its ps start time equals the registry's procStart.

    The procStart match is what stops a recycled pid from making a dead session look live.
    """

    def __init__(self, *, run: Callable | None = None, kill: Callable | None = None,
                 clock: Callable[[], float] = time.monotonic, recheck_s: float = PS_RECHECK_S):
        self._run = run
        self._kill = kill
        self._clock = clock
        self._recheck_s = recheck_s
        self._cache: dict[tuple[int, str], tuple[bool, float]] = {}

    def __call__(self, pid: int, proc_start: str | None) -> bool:
        if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0 or not isinstance(proc_start, str):
            return False
        want = _norm_lstart(proc_start)
        if not want:
            return False
        try:
            (self._kill or os.kill)(pid, 0)
        except (OSError, OverflowError, ValueError):
            for key in [k for k in self._cache if k[0] == pid]:
                del self._cache[key]
            return False
        key = (pid, want)
        hit = self._cache.get(key)
        now = self._clock()
        if hit is not None and now - hit[1] < self._recheck_s:
            return hit[0]
        ok = self._ps_lstart(pid) == want
        self._cache[key] = (ok, now)
        return ok

    def _ps_lstart(self, pid: int) -> str | None:
        run = self._run or subprocess.run
        try:
            result = run(
                ["/bin/ps", "-o", "lstart=", "-p", str(int(pid))],
                shell=False, timeout=5, capture_output=True, text=True,
                stdin=subprocess.DEVNULL, env={"TZ": "UTC", "LC_ALL": "C", "PATH": "/usr/bin:/bin"},
            )
        except (OSError, subprocess.SubprocessError, ValueError):
            return None
        if getattr(result, "returncode", 1) != 0 or not isinstance(result.stdout, str):
            return None
        return _norm_lstart(result.stdout) or None

    def forget_except(self, pids: set[int]) -> None:
        for key in [k for k in self._cache if k[0] not in pids]:
            del self._cache[key]


# ---------------------------------------------------------------------------------------------------
# Background work


_ETIME_RE = re.compile(rb"^(?:(?:([0-9]{1,5})-)?([0-9]{1,2}):)?([0-9]{1,2}):([0-9]{2})\Z")


def parse_etime(value: bytes) -> int | None:
    """Seconds from ps etime, `[[dd-]hh:]mm:ss`."""
    m = _ETIME_RE.match(value)
    if m is None:
        return None
    days, hours, minutes, seconds = (int(g) if g is not None else 0 for g in m.groups())
    if minutes >= 60 or seconds >= 60 or (m.group(1) is not None and hours >= 24):
        return None
    return ((days * 24 + hours) * 60 + minutes) * 60 + seconds


def parse_ps_table(stdout: bytes, now_ms: int) -> dict[int, list[int]]:
    """{parent pid: start times (epoch ms) of its children whose args contain the shell marker}.

    Only the marker test touches args, and each line is dropped as soon as it is parsed.
    """
    shells: dict[int, list[int]] = {}
    for line in stdout.split(b"\n"):
        fields = line.split(None, 3)
        if len(fields) < 4 or SHELL_MARKER not in fields[3]:
            continue
        pid, ppid = fields[0], fields[1]
        if not (pid.isdigit() and ppid.isdigit() and len(pid) <= 10 and len(ppid) <= 10):
            continue
        elapsed = parse_etime(fields[2])
        if elapsed is None:
            continue
        shells.setdefault(int(ppid), []).append(now_ms - elapsed * 1000)
    return shells


def parse_ps_parents(stdout: bytes) -> tuple[dict[int, int], dict[int, str]]:
    """({pid: parent pid}, {pid: editor key} for the pids whose args name an editor's app). Only the marker test
    touches args."""
    parents: dict[int, int] = {}
    editors: dict[int, str] = {}
    for line in stdout.split(b"\n"):
        fields = line.split(None, 3)
        if len(fields) < 2:
            continue
        pid, ppid = fields[0], fields[1]
        if not (pid.isdigit() and ppid.isdigit() and len(pid) <= 10 and len(ppid) <= 10):
            continue
        parents[int(pid)] = int(ppid)
        if len(fields) == 4:
            key = next((key for marker, key in EDITOR_PROCESS_MARKERS if marker in fields[3]), None)
            if key is not None:
                editors[int(pid)] = key
    return parents, editors


class ShellProbe:
    """Counts Claude shell processes (args contain `shell-snapshots`) that are direct children of each CLI pid.

    A session that ended its turn after starting a background command reads idle in the registry while that shell
    still runs. MCP servers are children of the same pid but never carry the marker. One ps table is taken at most
    every `interval_s` and shared by every session in between.
    """

    def __init__(self, *, run: Callable | None = None, clock: Callable[[], float] = time.monotonic,
                 interval_s: float = PS_TABLE_INTERVAL_S, warn_interval_s: float = PS_WARNING_INTERVAL_S):
        self._run = run
        self._clock = clock
        self._interval_s = interval_s
        self._warn_interval_s = warn_interval_s
        self._taken_at: float | None = None
        self._shells: dict[int, list[int]] = {}
        self._parents: dict[int, int] = {}
        self._editors: dict[int, str] = {}
        self._error: str | None = None
        self._warned_at: float | None = None

    def children(self, pids: set[int], now_ms: int, warnings: set[str]) -> dict[int, tuple[int, int | None]]:
        """{pid: (marked children, oldest start ms or None)}. Runs nothing when pids is empty."""
        if not pids:
            return {}
        now = self._clock()
        if self._taken_at is None or now - self._taken_at >= self._interval_s:
            self._taken_at = now
            try:
                self._shells, self._parents, self._editors = self._take(now_ms)
                self._error = None
            except Exception as exc:  # the board must never go down because ps did
                self._shells, self._parents, self._editors = {}, {}, {}
                self._error = type(exc).__name__
        if self._error is not None and (self._warned_at is None or now - self._warned_at >= self._warn_interval_s):
            warnings.add(f"ps {self._error}")
            self._warned_at = now
        out: dict[int, tuple[int, int | None]] = {}
        for pid in pids:
            starts = self._shells.get(pid, ())
            out[pid] = (len(starts), min(starts) if starts else None)
        return out

    def editors_of(self, pids: set[int]) -> dict[int, str]:
        """{pid: editor key} for the pids with an editor process among their ancestors, the nearest one's, in the
        table children() last took."""
        hosted: dict[int, str] = {}
        for pid in pids:
            parent = self._parents.get(pid)
            for _ in range(ANCESTOR_STEPS):
                if parent is None or parent <= 1:
                    break
                if parent in self._editors:
                    hosted[pid] = self._editors[parent]
                    break
                parent = self._parents.get(parent)
        return hosted

    def _take(self, now_ms: int) -> tuple[dict[int, list[int]], dict[int, int], dict[int, str]]:
        run = self._run or subprocess.run
        result = run(list(PS_TABLE_ARGV), shell=False, timeout=5, capture_output=True, stdin=subprocess.DEVNULL,
                     env=dict(PS_TABLE_ENV))
        code = getattr(result, "returncode", None)
        if code != 0:
            raise subprocess.CalledProcessError(code if isinstance(code, int) else -1, PS_TABLE_ARGV[0])
        stdout = getattr(result, "stdout", None)
        if not isinstance(stdout, bytes):
            raise TypeError("ps output is not bytes")
        return (parse_ps_table(stdout, now_ms), *parse_ps_parents(stdout))


def _is_prompt(rec: model.TailRecord) -> bool:
    return rec.type == "user" and not rec.is_meta and bool(rec.block_types) and "tool_result" not in rec.block_types


def tail_background(records: tuple[model.TailRecord, ...]) -> tuple[int, bool]:
    """(background launches after the latest task notification, the last turn called ScheduleWakeup).

    Main chain only: a subagent's own background work reports back to the subagent.
    """
    main = [r for r in records if not r.is_sidechain]
    last_notification = max((i for i, r in enumerate(main) if r.task_notification), default=-1)
    pending = sum(1 for r in main[last_notification + 1:] if r.background_launch)
    last_prompt = max((i for i, r in enumerate(main) if _is_prompt(r)), default=-1)
    wakeup = any(name == SCHEDULE_WAKEUP_TOOL for r in main[last_prompt + 1:] if r.type == "assistant"
                 for _tid, name in r.tool_uses)
    return pending, wakeup


# ---------------------------------------------------------------------------------------------------
# Transcript tails


def asks_valhalla(text: object) -> bool:
    """True when a typed message is only a request to sail to Valhalla. The verdict is kept, never the text."""
    if not isinstance(text, str):
        return False
    text = text.strip()
    if not text or len(text) > VALHALLA_ASK_MAX_CHARS:
        return False
    words = re.sub(r"[^a-z0-9]+", " ", text.lower().replace("'", "").replace("’", "")).strip()
    return VALHALLA_ASK_RE.fullmatch(words) is not None


def _content_asks_valhalla(content: object) -> bool:
    if isinstance(content, list):
        return any(isinstance(b, dict) and b.get("type") == "text" and asks_valhalla(b.get("text")) for b in content)
    return asks_valhalla(content)


def _tail_record(r: dict) -> model.TailRecord | None:
    rtype = r.get("type")
    if not isinstance(rtype, str):
        return None
    message = r.get("message") if isinstance(r.get("message"), dict) else {}
    content = message.get("content")
    block_types: list[str] = []
    tool_uses: list[tuple[str, str]] = []
    tool_result_ids: list[str] = []
    # toolUseResult sits beside a tool_result block; only its status enum is compared, and nothing is kept.
    result = r.get("toolUseResult")
    background_launch = rtype == "user" and isinstance(result, dict) and result.get("status") == ASYNC_LAUNCHED
    if isinstance(content, str):
        block_types.append("text")
    elif isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = _enum(block.get("type")) or "unknown"
            block_types.append(btype)
            if btype == "tool_use":
                name = _enum(block.get("name")) or "unknown"
                tid = _enum(block.get("id"))
                if tid:
                    tool_uses.append((tid, name))
                if rtype == "assistant" and name in BACKGROUND_TOOLS and isinstance(block.get("input"), dict) \
                        and block["input"].get("run_in_background") is True:
                    background_launch = True
            elif btype == "tool_result":
                tid = _enum(block.get("tool_use_id"))
                if tid:
                    tool_result_ids.append(tid)

    error_kind = None
    if rtype == "assistant":
        raw_error = r.get("error")
        if isinstance(raw_error, str):
            error_kind = _enum(raw_error) or "unknown"
    elif rtype == "system" and isinstance(r.get("error"), dict):
        # System api_error records carry an HTTP status, not a kind; map the unambiguous ones.
        status = _int(r["error"].get("status"))
        if status == 429:
            error_kind = "rate_limit"
        elif status in (401, 403):
            error_kind = "authentication_failed"
        elif status is not None and status >= 500:
            error_kind = "server_error"

    queued_prompt = False
    valhalla_ask = False
    if rtype == "user" and not tool_result_ids and "tool_result" not in block_types:
        valhalla_ask = _content_asks_valhalla(content)
    elif rtype == "attachment":
        att = r.get("attachment")
        if isinstance(att, dict) and att.get("type") == "queued_command" and att.get("commandMode") == "prompt":
            queued_prompt = True
            valhalla_ask = _content_asks_valhalla(att.get("prompt"))

    quota = r.get("quotaLimits") if isinstance(r.get("quotaLimits"), dict) else {}
    return model.TailRecord(
        type=_enum(rtype) or "unknown",
        subtype=_enum(r.get("subtype")),
        timestamp=_iso_ms(r.get("timestamp")),
        is_sidechain=r.get("isSidechain") is True,
        is_meta=r.get("isMeta") is True,
        stop_reason=_enum(message.get("stop_reason")),
        block_types=tuple(block_types),
        tool_uses=tuple(tool_uses),
        tool_result_ids=tuple(tool_result_ids),
        is_api_error=r.get("isApiErrorMessage") is True,
        error_kind=error_kind,
        retry_attempt=_int(r.get("retryAttempt")),
        max_retries=_int(r.get("maxRetries")),
        quota_status=_enum(quota.get("status")),
        quota_resets_at=_epoch_ms(quota.get("resetsAt")),
        quota_limit_type=_enum(quota.get("rateLimitType")),
        background_launch=background_launch,
        task_notification=_is_task_notification(r),
        queued_prompt=queued_prompt,
        valhalla_ask=valhalla_ask,
    )


def _is_task_notification(r: dict) -> bool:
    """A background task reported back. Looks at the opening tag only and keeps nothing.

    Arriving between turns it is a user record. Arriving while the model is busy it is queued into the running turn
    as a `queued_command` attachment instead, and only the attachment's enum `commandMode` says what it is.
    """
    rtype = r.get("type")
    if rtype == "attachment":
        att = r.get("attachment")
        return isinstance(att, dict) and att.get("type") == "queued_command" \
            and att.get("commandMode") == "task-notification"
    if rtype != "user" or not isinstance(r.get("message"), dict):
        return False
    content = r["message"].get("content")
    if isinstance(content, list):
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return False
        content = next((b.get("text") for b in content if isinstance(b, dict) and b.get("type") == "text"), None)
    return isinstance(content, str) and content[:256].lstrip().startswith(TASK_NOTIFICATION_PREFIX)


def _is_monitor_launch(r: dict, rec: model.TailRecord, monitor_calls: set[str]) -> bool:
    """The result of a Monitor call earlier in the window, carrying a task id (its type only is checked here)."""
    result = r.get("toolUseResult")
    task_id = result.get(MONITOR_TASK_KEY) if isinstance(result, dict) else None
    return rec.type == "user" and isinstance(task_id, str) and task_id != "" \
        and any(tid in monitor_calls for tid in rec.tool_result_ids)


def _task_id(value) -> str | None:
    return value if isinstance(value, str) and value else None


def _note_task(raw: dict, rec: model.TailRecord, entries: list[tuple[model.TailRecord, str | None]],
               calls: dict[str, int | None], launches: dict[str, int]) -> None:
    """Links a launch's result to its task id, and un-counts the launch that a TaskStop result names.

    calls: tool_use id -> the entry that counts that call's launch (a Bash call flagged in its input), or None for a
    TaskStop call. launches: task id -> the entry that counts its launch. Task ids live only for this one read.
    """
    result = raw.get("toolUseResult")
    if not isinstance(result, dict):
        return
    known = [tid for tid in rec.tool_result_ids if tid in calls]
    if any(calls[tid] is None for tid in known):
        target = launches.pop(_task_id(result.get(TASK_STOP_ID_KEY)), None)
        if target is not None:
            stopped, kind = entries[target]
            entries[target] = (replace(stopped, background_launch=False), kind)
        return
    owner = len(entries) if rec.background_launch else next((calls[tid] for tid in known), None)
    task = next((t for t in (_task_id(result.get(k)) for k in LAUNCH_TASK_KEYS) if t), None)
    if owner is not None and task is not None:
        launches[task] = owner


def is_qualifying(rec: model.TailRecord) -> bool:
    if rec.is_sidechain or rec.is_meta:
        return False
    if rec.type in ("assistant", "user"):
        return True
    return rec.type == "system" and rec.subtype in QUALIFYING_SYSTEM_SUBTYPES


def _is_known_type(rtype: str) -> bool:
    return rtype in KNOWN_TYPES or rtype.startswith("artifact-")


def _local_kind(r: dict) -> str | None:
    """'output' for local command or bash mode output, 'command' for a slash command's name record.

    Looks at the opening tag only and keeps nothing.
    """
    if r.get("type") != "user" or not isinstance(r.get("message"), dict):
        return None
    content = r["message"].get("content")
    if isinstance(content, list):
        # A tool_result record must stay qualifying or its tool would look pending.
        if not content or any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return None
        first = content[0]
        content = first.get("text") if isinstance(first, dict) and first.get("type") == "text" else None
    if not isinstance(content, str):
        return None
    head = content[:64].lstrip()
    if head.startswith(LOCAL_OUTPUT_PREFIXES):
        return "output"
    if head.startswith(COMMAND_NAME_PREFIX):
        return "command"
    return None


def _mark_local_commands(entries: list[tuple[model.TailRecord, str | None]]) -> list[model.TailRecord]:
    """Local command records become meta, so a session that only ran /context never reads as mid-turn.

    A command name counts as local only when local output follows it. A skill command is followed by a meta
    prompt instead and starts a real turn, so it stays qualifying.
    """
    out: list[model.TailRecord] = []
    for i, (rec, kind) in enumerate(entries):
        local = kind == "output"
        if kind == "command" and not rec.is_sidechain:
            for j in range(i + 1, len(entries)):
                nxt, nxt_kind = entries[j]
                if nxt.is_sidechain or nxt.type not in ("user", "assistant", "system"):
                    continue
                local = nxt_kind == "output" or (nxt.type == "system" and nxt.subtype == "local_command")
                break
        out.append(replace(rec, is_meta=True) if local and not rec.is_meta else rec)
    return out


def _title(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    return value.strip()[:TITLE_MAX_CHARS] or None


def _parse_window(data: bytes, cut_first_line: bool
                  ) -> tuple[list[model.TailRecord], set[str], bool, str | None, str | None]:
    """(records, unknown types, whether any record qualifies, the newest title, the newest folder)."""
    if cut_first_line:
        nl = data.find(b"\n")
        data = b"" if nl < 0 else data[nl + 1:]
    entries: list[tuple[model.TailRecord, str | None]] = []
    unknown: set[str] = set()
    monitor_calls: set[str] = set()
    calls: dict[str, int | None] = {}
    launches: dict[str, int] = {}
    titles: dict[str, str | None] = {}
    cwd: str | None = None
    for line in data.split(b"\n"):
        if not line.strip():
            continue
        try:
            raw = json.loads(line)
        except (ValueError, RecursionError):
            continue
        if not isinstance(raw, dict):
            continue
        field = TITLE_FIELDS.get(raw.get("type"))
        if field is not None:
            titles[raw["type"]] = _title(raw.get(field)) or titles.get(raw["type"])
        if isinstance(raw.get("cwd"), str) and raw["cwd"].startswith("/") and raw.get("isSidechain") is not True:
            cwd = raw["cwd"]
        rec = _tail_record(raw)
        if rec is None:
            continue
        if not _is_known_type(rec.type):
            unknown.add(rec.type)
        if rec.type == "assistant":
            for tid, name in rec.tool_uses:
                if name == MONITOR_TOOL:
                    monitor_calls.add(tid)
                elif name == TASK_STOP_TOOL:
                    calls[tid] = None
                elif rec.background_launch and name in BACKGROUND_TOOLS:
                    calls[tid] = len(entries)
        elif rec.type == "user" and rec.tool_result_ids:
            if monitor_calls and _is_monitor_launch(raw, rec, monitor_calls):
                rec = replace(rec, background_launch=True)
            _note_task(raw, rec, entries, calls, launches)
        entries.append((rec, _local_kind(raw)))
    records = _mark_local_commands(entries)
    title = titles.get("custom-title") or titles.get("ai-title")
    return records, unknown, any(is_qualifying(r) for r in records), title, cwd


def _read_records(path: Path
                  ) -> tuple[tuple[model.TailRecord, ...], tuple[str, ...], tuple, str | None, str | None]:
    """Returns (records, unknown_types, cache_key, title, cwd). Raises OSError / PermissionError."""
    with open_for_read(path, "rb") as fh:
        st = os.fstat(fh.fileno())
        size = st.st_size
        window = min(TAIL_WINDOW, size)
        while True:
            start = max(0, size - window)
            # Read one byte early: if it is a newline the first line in the window is whole.
            read_from = max(0, start - 1)
            fh.seek(read_from)
            data = fh.read(size - read_from)
            records, unknown, qualifying, title, cwd = _parse_window(data, cut_first_line=start > 0)
            if qualifying or start == 0 or window >= TAIL_WINDOW_MAX:
                break
            window = min(window * 2, TAIL_WINDOW_MAX)
    key = (st.st_ino, size, st.st_mtime_ns)
    return tuple(records), tuple(sorted(unknown)), key, title, cwd


def _walk_subagents(subagents_dir: Path) -> tuple[int | None, list[tuple[int, Path]]]:
    """(newest mtime of any file, the *.jsonl transcripts with their mtimes) under <id>/subagents/**."""
    newest: int | None = None
    transcripts: list[tuple[int, Path]] = []
    try:
        for dirpath, _dirnames, filenames in os.walk(subagents_dir, followlinks=False):
            for name in filenames:
                full = os.path.join(dirpath, name)
                try:
                    st = os.stat(full, follow_symlinks=False)
                except OSError:
                    continue
                mtime = _mtime_ms(st)
                newest = mtime if newest is None else max(newest, mtime)
                if name.endswith(".jsonl") and stat.S_ISREG(st.st_mode) and not is_denied(full):
                    transcripts.append((mtime, Path(full)))
    except OSError:
        pass
    return newest, transcripts


def _newest_mtime(transcript_mtime_ms: int, subagents_dir: Path) -> int:
    newest, _files = _walk_subagents(subagents_dir)
    return transcript_mtime_ms if newest is None else max(transcript_mtime_ms, newest)


def read_tail(path: Path, subagents_dir: Path) -> model.Tail:
    """Structure-only tail of one transcript, plus its title. A missing or unreadable transcript gives found=False."""
    try:
        records, unknown, _key, title, cwd = _read_records(path)
        st = os.stat(path)
    except Exception:
        return model.Tail(found=False, records=(), newest_mtime=None)
    return model.Tail(found=True, records=records, newest_mtime=_newest_mtime(_mtime_ms(st), subagents_dir),
                      unknown_types=unknown, title=title, cwd=cwd)


# ---------------------------------------------------------------------------------------------------
# Desktop records and registry


def _pull_requests(d: dict) -> tuple[model.PullRequest, ...]:
    prs: list[model.PullRequest] = []
    raw = d.get("prs")
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            number = _int(item.get("prNumber", item.get("number")))
            if number is None:
                continue
            state = item.get("state")
            url = item.get("url")
            prs.append(model.PullRequest(
                number=number,
                state=state.upper() if isinstance(state, str) and state else "UNKNOWN",
                url=url if isinstance(url, str) else None,
                dismissed=item.get("dismissed") is True,
            ))
    legacy = _int(d.get("prNumber"))
    if legacy is not None and all(pr.number != legacy for pr in prs):
        state = d.get("prState")
        url = d.get("prUrl")
        # Older single-PR fields predate prs[], so the legacy PR goes first (oldest).
        prs.insert(0, model.PullRequest(
            number=legacy,
            state=state.upper() if isinstance(state, str) and state else "UNKNOWN",
            url=url if isinstance(url, str) else None,
        ))
    return tuple(prs)


def _str(value) -> str | None:
    return value if isinstance(value, str) else None


def _count(value) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _pct(value) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return max(0, min(100, value))


def _read_plan_samples(path: Path, size: int) -> tuple[tuple[int, int | None, int | None], ...]:
    """(t, five-hour pct, weekly pct) per usable sample, oldest first. The org id is never kept."""
    if size > PLAN_USAGE_MAX_BYTES:
        return ()
    with open_for_read(path, "rb") as fh:
        data = json.loads(fh.read(PLAN_USAGE_MAX_BYTES + 1))
    raw = data.get("samples") if isinstance(data, dict) else None
    if not isinstance(raw, list):
        return ()
    samples: list[tuple[int, int | None, int | None]] = []
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get("u"), dict):
            continue
        t = item.get("t")
        if isinstance(t, bool) or not isinstance(t, int):
            continue
        samples.append((t, _pct(item["u"].get("fh")), _pct(item["u"].get("sd"))))
    samples.sort(key=lambda s: s[0])
    return tuple(samples)


def _sum_totals(parts) -> model.TokenTotals:
    parts = [p for p in parts if p is not None]
    return model.TokenTotals(
        input=sum(p.input for p in parts), output=sum(p.output for p in parts),
        cache_read=sum(p.cache_read for p in parts), cache_write=sum(p.cache_write for p in parts),
        messages=sum(p.messages for p in parts), context=None,
    )


def _open_transcript(path, mode: str = "rb"):
    # Resolved at call time, so the ledger goes through the same guarded opener as every other read.
    return open_for_read(path, mode)


def parse_desktop(d, file_session_id: str) -> model.DesktopRecord:
    if not isinstance(d, dict):
        raise ValueError("not an object")
    cwd = d.get("cwd")
    if not isinstance(cwd, str) or not cwd:
        raise ValueError("no cwd")
    created = _epoch_ms(d.get("createdAt"))
    last_activity = _epoch_ms(d.get("lastActivityAt"))
    if created is None and last_activity is None:
        raise ValueError("no timestamps")
    cli = d.get("cliSessionId")
    return model.DesktopRecord(
        session_id=file_session_id,
        cli_session_id=cli if isinstance(cli, str) and UUID_RE.match(cli) else None,
        cwd=cwd,
        origin_cwd=_str(d.get("originCwd")) or cwd,
        title=_str(d.get("title")),
        model=_str(d.get("model")),
        effort=_str(d.get("effort")),
        branch=_str(d.get("branch")),
        permission_mode=_str(d.get("permissionMode")),
        created_at=created,
        last_activity_at=last_activity if last_activity is not None else created,
        last_focused_at=_epoch_ms(d.get("lastFocusedAt")),
        is_archived=d.get("isArchived") is True,
        error_at=_epoch_ms(d.get("errorAt")),
        prs=_pull_requests(d),
        transcript_unavailable=d.get("transcriptUnavailable") is True,
        interrupted_by_quit_at=_epoch_ms(d.get("interruptedByQuitAt")),
        completed_turns=_count(d.get("completedTurns")),
    )


def parse_registry(d, file_pid: int) -> tuple[model.RegistryEntry, str | None] | None:
    """Returns (entry, procStart), or None for spares and unusable files."""
    if not isinstance(d, dict) or d.get("spare") is True:
        return None
    pid = _int(d.get("pid"))
    session_id = d.get("sessionId")
    cwd = d.get("cwd")
    if pid != file_pid or not isinstance(session_id, str) or not session_id or not isinstance(cwd, str):
        return None
    entry = model.RegistryEntry(
        pid=pid,
        session_id=session_id,
        cwd=cwd,
        status=_str(d.get("status")),
        waiting_for=_str(d.get("waitingFor")),
        status_updated_at=_epoch_ms(d.get("statusUpdatedAt")),
        started_at=_epoch_ms(d.get("startedAt")),
        version=_str(d.get("version")),
        entrypoint=_str(d.get("entrypoint")),
    )
    return entry, _str(d.get("procStart"))


def _prior_ids(d: dict) -> frozenset[str]:
    raw = d.get("priorCliSessionIds")
    if not isinstance(raw, list):
        return frozenset()
    return frozenset(x for x in raw if isinstance(x, str) and UUID_RE.match(x))


def _load_json(path: Path):
    with open_for_read(path, "rb") as fh:
        return json.load(fh)


def _first_cwd(path: Path) -> tuple[str | None, str | None]:
    """(cwd, entrypoint: the app that started the session) from the first record carrying a cwd."""
    with open_for_read(path, "rb") as fh:
        data = fh.read(HEAD_LIMIT)
    lines = data.split(b"\n")
    if len(data) == HEAD_LIMIT:
        lines = lines[:-1]
    for line in lines:
        if b'"cwd"' not in line:
            continue
        try:
            raw = json.loads(line)
        except (ValueError, RecursionError):
            continue
        if isinstance(raw, dict) and isinstance(raw.get("cwd"), str) and raw["cwd"]:
            return raw["cwd"], _enum(raw.get("entrypoint"))
    return None, None


# ---------------------------------------------------------------------------------------------------
# Scanner


@dataclass(frozen=True, slots=True)
class _Found:
    """The transcript a tail was read from, and the subagent transcripts beside it."""
    path: Path
    mtime_ms: int
    subagents: tuple[tuple[int, Path], ...]  # (mtime ms, path)


class Scanner:
    """Stateful: re-parses only files whose stat changed. Not thread-safe; one scan at a time."""

    def __init__(self, paths: Paths, *, is_live: Callable[[int, str | None], bool] | None = None,
                 now_ms: Callable[[], int] | None = None, ledger: TokenLedger | None = None,
                 pr_index: PrLinkIndex | None = None, shells: ShellProbe | None = None,
                 link_store: LinkStore | None = None):
        self.paths = paths
        self._link_store = link_store
        self._ledger = ledger if ledger is not None else TokenLedger(open_file=_open_transcript)
        self._pr_index = pr_index if pr_index is not None else PrLinkIndex(open_file=_open_transcript)
        self._shells = shells if shells is not None else ShellProbe()
        # path -> ((mtime_ns, size), samples oldest first)
        self._plan_cache: dict[str, tuple[tuple[int, int], tuple]] = {}
        self._checker = ProcessChecker() if is_live is None else None
        self._is_live = is_live if is_live is not None else self._checker
        self._now_ms = now_ms or _now_ms
        # path -> ((mtime_ns, size), parsed or None, last good parsed or None, prior CLI ids of the good copy)
        self._desktop_cache: dict[str, tuple[tuple[int, int], model.DesktopRecord | None,
                                             model.DesktopRecord | None, frozenset[str]]] = {}
        self._registry_cache: dict[str, tuple[tuple[int, int], tuple | None]] = {}
        self._tail_cache: dict[str, tuple[tuple, tuple, tuple, str | None, str | None]] = {}
        self._head_cache: dict[str, tuple[tuple, tuple[str | None, str | None]]] = {}
        # (path, mtime_ns, size), version
        self._plist_cache: tuple[tuple[str, int, int], str | None] | None = None
        # The Claude Code folders and Claude app folders found this scan, and every transcript it saw by session id.
        self._code_roots: list[Path] = []
        self._app_roots: list[Path] = []
        self._by_id: dict[str, list[Path]] = {}
        # Cli session id -> the editor it was last seen live under, for as long as the session is known.
        self._editors_seen: dict[str, str] = {}

    def scan(self) -> model.RawSnapshot:
        t0 = time.perf_counter()
        now = self._now_ms()
        warnings: set[str] = set()

        self._code_roots, self._app_roots, folders = self._folders()
        desktop, parse_errors = self._scan_desktop(warnings)
        registry_files, live = self._scan_registry(warnings)
        live_by_session = {e.session_id: e for e in live}

        current_ids = {r.cli_session_id for r in desktop if r.cli_session_id}
        cli_only, cli_paths, self._by_id = self._scan_cli_only(current_ids, warnings)

        tails: dict[str, model.Tail] = {}
        wanted: dict[str, list[Path]] = {}
        for rec in desktop:
            cli = rec.cli_session_id
            if not cli:
                continue
            reg = live_by_session.get(cli)
            if reg is None and (rec.transcript_unavailable or (now - rec.last_activity_at > RECENT_MS
                                                               and not self._touched_recently(rec, cli, now))):
                continue
            cwds = [rec.cwd]
            if reg is not None and reg.cwd and reg.cwd != rec.cwd:
                cwds.append(reg.cwd)
            wanted.setdefault(cli, []).extend(self._transcript_candidates(cli, *cwds))
        for cli in cli_only:
            if cli.session_id in live_by_session or now - cli.last_activity_at <= RECENT_MS:
                wanted.setdefault(cli.session_id, []).append(cli_paths[cli.session_id])
        for entry in live:
            if entry.session_id not in wanted and UUID_RE.match(entry.session_id) and entry.cwd:
                wanted[entry.session_id] = self._transcript_candidates(entry.session_id, entry.cwd)

        used: set[str] = set()
        found: dict[str, _Found] = {}
        for cli, candidates in wanted.items():
            tails[cli], hit = self._tail(cli, candidates, used, warnings)
            if hit is not None:
                found[cli] = hit
        for key in [k for k in self._tail_cache if k not in used]:
            del self._tail_cache[key]

        activity: dict[str, int] = {}
        for rec in desktop:
            if rec.cli_session_id:
                activity[rec.cli_session_id] = max(activity.get(rec.cli_session_id, 0), rec.last_activity_at)
        for cli in cli_only:
            activity[cli.session_id] = max(activity.get(cli.session_id, 0), cli.last_activity_at)
        tokens = self._count_tokens(found, activity, set(live_by_session), warnings)
        pr_links = self._scan_pr_links(desktop, cli_only, cli_paths, found, now, warnings)
        background = self._background(live, tails, now, warnings)
        editor_hosted = self._editor_hosted(live)
        known = {c.session_id for c in cli_only} | set(live_by_session)
        self._editors_seen = {sid: key for sid, key in self._editors_seen.items() if sid in known}
        self._editors_seen.update(editor_hosted)

        return model.RawSnapshot(
            scanned_at=now,
            desktop=tuple(desktop),
            registry_files=registry_files,
            registry_live=tuple(live),
            cli_only=tuple(cli_only),
            tails=tails,
            app_version=self._app_version(warnings),
            cli_versions=tuple(sorted({e.version for e in live if e.version})),
            desktop_parse_errors=parse_errors,
            scan_ms=int((time.perf_counter() - t0) * 1000),
            warnings=tuple(sorted(warnings)),
            tokens=tokens,
            plan_usage=self._plan_usage(now),
            pr_links=pr_links,
            background=background,
            editor_hosted=editor_hosted,
            editors_seen=dict(self._editors_seen),
            default_editor=self._default_editor(),
            folders=folders,
        )

    def _touched_recently(self, rec: model.DesktopRecord, cli: str, now: int) -> bool:
        # lastActivityAt can lag the transcript by days, for example when the app quits mid-turn.
        if rec.interrupted_by_quit_at is not None and now - rec.interrupted_by_quit_at <= RECENT_MS:
            return True
        for path in self._transcript_candidates(cli, rec.cwd):
            try:
                st = os.stat(path)
            except (OSError, ValueError):
                continue
            return now - _mtime_ms(st) <= RECENT_MS
        return False

    # -- folders ---------------------------------------------------------------------------------

    def _folders(self) -> tuple[list[Path], list[Path], tuple[model.SourceFolder, ...]]:
        """The Claude Code folders and Claude app folders to read this scan, and what health reports of each.

        A folder reached twice, such as CLAUDE_CONFIG_DIR naming ~/.claude through a symlink, is read once.
        """
        report: list[model.SourceFolder] = []
        code: list[Path] = []
        seen: set[tuple[int, int]] = set()
        for label, root in self.paths.claude_dirs:
            key = _folder_key(root)
            if key is not None and key not in seen:
                seen.add(key)
                code.append(root)
            report.append(model.SourceFolder(label=label, kind="code", found=key is not None))
        app: list[Path] = []
        seen = set()
        for label, root in self.paths.app_dirs:
            key = _folder_key(root)
            if key is not None and key not in seen:
                seen.add(key)
                app.append(root)
            found = key is not None and _folder_key(root / DESKTOP_SESSIONS) is not None
            report.append(model.SourceFolder(label=label, kind="app", found=found))
        return code, app, tuple(report)

    def _transcript_candidates(self, sid: str, *cwds: str) -> list[Path]:
        """Where a session's transcript may be: under each cwd's folder name in each Claude Code folder, then
        wherever this scan saw a transcript with its id, which finds a folder name Claude Code shortened."""
        paths = [self.paths.transcript_path(cwd, sid, root / "projects") for cwd in cwds if cwd
                 for root in self._code_roots]
        paths += self._by_id.get(sid, ())
        return list(dict.fromkeys(paths))

    # -- desktop ---------------------------------------------------------------------------------

    def _scan_desktop(self, warnings: set[str]) -> tuple[list[model.DesktopRecord], int]:
        seen: set[str] = set()
        ids: set[str] = set()
        records: list[model.DesktopRecord] = []
        errors = 0
        files: list[Path] = []
        for app_root in self._app_roots:
            root = app_root / DESKTOP_SESSIONS
            if not root.is_dir():
                continue
            try:
                files += sorted(root.glob("*/*/local_*.json"))
            except OSError as exc:
                warnings.add(f"desktop {type(exc).__name__}")
        for path in files:
            key = str(path)
            seen.add(key)
            try:
                st = path.stat()
                if not path.is_file():
                    continue
            except OSError:
                continue
            sig = (st.st_mtime_ns, st.st_size)
            cached = self._desktop_cache.get(key)
            if cached is not None and cached[0] == sig:
                parsed, good = cached[1], cached[2]
            else:
                good, prior = (cached[2], cached[3]) if cached is not None else (None, frozenset())
                try:
                    raw = _load_json(path)
                    parsed = parse_desktop(raw, path.stem)
                    good, prior = parsed, _prior_ids(raw)
                except Exception:
                    parsed = None
                self._desktop_cache[key] = (sig, parsed, good, prior)
            if parsed is None:
                errors += 1
            # A record copied into both app folders would otherwise give two rows the same id.
            if good is not None and good.session_id not in ids:
                ids.add(good.session_id)
                records.append(good)
        for key in [k for k in self._desktop_cache if k not in seen]:
            del self._desktop_cache[key]
        return records, errors

    # -- registry --------------------------------------------------------------------------------

    def _scan_registry(self, warnings: set[str]) -> tuple[int, list[model.RegistryEntry]]:
        files = 0
        live: list[model.RegistryEntry] = []
        seen: set[str] = set()
        known_pids: set[int] = set()
        entries: list[Path] = []
        for code_root in self._code_roots:
            root = code_root / "sessions"
            try:
                entries += [root / name for name in sorted(os.listdir(root))]
            except FileNotFoundError:
                pass
            except OSError as exc:
                warnings.add(f"registry {type(exc).__name__}")
        for path in entries:
            name = path.name
            if not REGISTRY_NAME_RE.match(name):
                continue
            try:
                st = path.stat()
            except OSError:
                continue
            if not path.is_file():
                continue
            files += 1
            key = str(path)
            seen.add(key)
            sig = (st.st_mtime_ns, st.st_size)
            cached = self._registry_cache.get(key)
            if cached is not None and cached[0] == sig:
                parsed = cached[1]
            else:
                try:
                    parsed = parse_registry(_load_json(path), int(name[:-5]))
                except Exception:
                    parsed = None
                self._registry_cache[key] = (sig, parsed)
            if parsed is None:
                continue
            entry, proc_start = parsed
            known_pids.add(entry.pid)
            try:
                alive = bool(self._is_live(entry.pid, proc_start))
            except Exception as exc:  # an injected checker must not take the scan down
                warnings.add(f"liveness {type(exc).__name__}")
                alive = False
            if alive:
                live.append(entry)
        for key in [k for k in self._registry_cache if k not in seen]:
            del self._registry_cache[key]
        if self._checker is not None:
            self._checker.forget_except(known_pids)
        return files, live

    # -- CLI-only transcripts --------------------------------------------------------------------

    def _scan_cli_only(self, current_ids: set[str], warnings: set[str]
                       ) -> tuple[list[model.CliTranscript], dict[str, Path], dict[str, list[Path]]]:
        """Terminal and editor sessions, their transcripts, and every transcript seen, by session id."""
        rows: list[model.CliTranscript] = []
        found_paths: dict[str, Path] = {}
        by_id: dict[str, list[Path]] = {}
        # A desktop session that re-spawned its CLI keeps the old ids here; those are not CLI-only.
        prior = self._prior_cli_ids()
        seen: set[str] = set()
        files: list[Path] = []
        for code_root in self._code_roots:
            root = code_root / "projects"
            if not root.is_dir():
                continue
            try:
                files += sorted(root.glob("*/*.jsonl"))
            except OSError as exc:
                warnings.add(f"projects {type(exc).__name__}")
        for path in files:
            sid = path.stem
            if not UUID_RE.match(sid) or is_denied(path):
                continue
            by_id.setdefault(sid, []).append(path)
            if sid in current_ids or sid in prior or sid in found_paths:
                continue
            try:
                st = path.stat()
            except OSError:
                continue
            key = str(path)
            seen.add(key)
            cached = self._head_cache.get(key)
            if cached is not None and cached[0][0] == st.st_ino and (cached[1][0] is not None or cached[0][1] == st.st_size):
                cwd, entrypoint = cached[1]
            else:
                try:
                    cwd, entrypoint = _first_cwd(path)
                except Exception:
                    continue
                self._head_cache[key] = ((st.st_ino, st.st_size), (cwd, entrypoint))
            # The app writes a desktop record for every session it starts, so a desktop-written transcript
            # without one is a respawn leftover or a deleted session, never a terminal session.
            if cwd is None or entrypoint == DESKTOP_ENTRYPOINT:
                continue
            rows.append(model.CliTranscript(
                session_id=sid, cwd=cwd, cwd_exists=os.path.isdir(cwd), last_activity_at=_mtime_ms(st),
                entrypoint=entrypoint))
            found_paths[sid] = path
        for key in [k for k in self._head_cache if k not in seen]:
            del self._head_cache[key]
        return rows, found_paths, by_id

    def _prior_cli_ids(self) -> set[str]:
        ids: set[str] = set()
        for entry in self._desktop_cache.values():
            ids.update(entry[3])
        return ids

    # -- tails -----------------------------------------------------------------------------------

    def _tail(self, cli: str, candidates: list[Path], used: set[str], warnings: set[str]
              ) -> tuple[model.Tail, _Found | None]:
        seen_paths: set[str] = set()
        for path in candidates:
            key = str(path)
            if key in seen_paths:
                continue
            seen_paths.add(key)
            try:
                st = path.stat()
            except OSError:
                continue
            if not path.is_file():
                continue
            used.add(key)
            sig = (st.st_ino, st.st_size, st.st_mtime_ns)
            cached = self._tail_cache.get(key)
            if cached is not None and cached[0] == sig:
                records, unknown, title, cwd = cached[1], cached[2], cached[3], cached[4]
            else:
                try:
                    records, unknown, read_sig, title, cwd = _read_records(path)
                except (FileNotFoundError, IsADirectoryError, NotADirectoryError, PermissionError):
                    continue
                except Exception as exc:
                    warnings.add(f"transcript {type(exc).__name__}")
                    continue
                self._tail_cache[key] = (read_sig, records, unknown, title, cwd)
            mtime = _mtime_ms(st)
            sub_newest, sub_files = _walk_subagents(path.parent / cli / "subagents")
            newest = mtime if sub_newest is None else max(mtime, sub_newest)
            tail = model.Tail(found=True, records=records, newest_mtime=newest, unknown_types=unknown,
                              title=title, cwd=cwd)
            # The ledger never reads through a symlink, so counting one would show "counting..." forever.
            hit = None if path.is_symlink() else _Found(path=path, mtime_ms=mtime, subagents=tuple(sub_files))
            return tail, hit
        return model.Tail(found=False, records=(), newest_mtime=None), None

    # -- tokens ----------------------------------------------------------------------------------

    def _count_tokens(self, found: dict[str, _Found], activity: dict[str, int], live_ids: set[str],
                      warnings: set[str]) -> dict[str, model.SessionTokens]:
        order = sorted(found, key=lambda cli: (cli not in live_ids,
                                               -max(activity.get(cli, 0), found[cli].mtime_ms), cli))
        subagents = {cli: [p for _m, p in sorted(found[cli].subagents, key=lambda f: (-f[0], str(f[1])))]
                     for cli in order}
        tracked = [found[cli].path for cli in order] + [p for cli in order for p in subagents[cli]]
        try:
            self._ledger.update(tracked, TOKEN_BYTES_PER_SCAN)
        except Exception as exc:  # token counts are decoration; they must never take the board down
            warnings.add(f"tokens {type(exc).__name__}")
        self._ledger.forget(set(tracked))

        tokens: dict[str, model.SessionTokens] = {}
        for cli in order:
            main_path = found[cli].path
            files = [main_path, *subagents[cli]]
            tokens[cli] = model.SessionTokens(
                main=self._ledger.totals(main_path) or model.TokenTotals(),
                subagents=_sum_totals(self._ledger.totals(p) for p in subagents[cli]),
                complete=all(self._ledger.is_complete(p) for p in files),
            )
        return tokens

    # -- PR links --------------------------------------------------------------------------------

    def _scan_pr_links(self, desktop: list[model.DesktopRecord], cli_only: list[model.CliTranscript],
                       cli_paths: dict[str, Path], found: dict[str, _Found], now: int, warnings: set[str]
                       ) -> dict[str, tuple[model.PrLink, ...]]:
        """Transcript pr-link records for sessions active within PR_LINK_WINDOW_MS, most recent first.

        With a link store, links read before are kept for every session still known, so a PR survives the CLI
        deleting the transcript that recorded it.
        """
        # cli session id -> (last activity, transcripts: the current one first, then earlier CLI incarnations,
        #                    the session ids whose pr-link records count)
        candidates: dict[str, tuple[int, list[Path], frozenset[str]]] = {}

        def offer(cli: str, activity: int, files: list[Path], sessions: frozenset[str]) -> None:
            if now - activity <= PR_LINK_WINDOW_MS and (cli not in candidates or activity > candidates[cli][0]):
                candidates[cli] = (activity, files, sessions)

        priors = self._prior_ids_by_session()
        for rec in desktop:
            cli = rec.cli_session_id
            if not cli:
                continue
            activity = max(rec.last_activity_at, rec.interrupted_by_quit_at or 0)
            files: list[Path] = []
            hit = found.get(cli)
            if hit is not None:
                activity = max(activity, hit.mtime_ms)
                files.append(hit.path)
            else:
                path, mtime = self._regular_transcript(cli, rec.cwd)
                if path is not None:
                    # lastActivityAt can lag the transcript, so its mtime counts too.
                    activity = max(activity, mtime)
                    files.append(path)
            if now - activity > PR_LINK_WINDOW_MS:
                continue
            # A respawned CLI starts a new transcript; a PR opened before the respawn is only in the old one.
            earlier = []
            for prior in priors.get(rec.session_id, ()):
                path, mtime = self._regular_transcript(prior, rec.cwd) if prior != cli else (None, None)
                if path is not None:
                    earlier.append((mtime, path))
            earlier.sort(key=lambda f: (-f[0], str(f[1])))
            files.extend(path for _mtime, path in earlier[:PR_LINK_MAX_PRIOR_FILES])
            if files:
                offer(cli, activity, files, frozenset({cli, *priors.get(rec.session_id, ())}))
        for row in cli_only:
            if row.session_id in cli_paths:
                offer(row.session_id, row.last_activity_at, [cli_paths[row.session_id]], frozenset({row.session_id}))

        order = sorted(candidates, key=lambda cli: (-candidates[cli][0], cli))
        tracked = list(dict.fromkeys(path for cli in order for path in candidates[cli][1]))
        links: dict[str, tuple[model.PrLink, ...]] = {}
        try:
            self._pr_index.update(tracked, PR_LINK_BYTES_PER_SCAN)
            self._pr_index.forget(set(tracked))
            for cli in order:
                _activity, files, sessions = candidates[cli]
                # A forked or duplicated transcript carries copies of another session's pr-link records.
                merged = (tuple(self._pr_index.links(files[0], sessions)) if len(files) == 1 else
                          merge_links(self._pr_index.links(path, sessions) for path in reversed(files)))
                if merged:
                    links[cli] = merged
        except Exception as exc:  # PR links are an extra source; they must never take the board down
            warnings.add(f"pr links {type(exc).__name__}")
        store = self._link_store
        if store is None:
            return links
        known = {rec.cli_session_id for rec in desktop if rec.cli_session_id} | {row.session_id for row in cli_only}
        try:
            stored = store.sessions()
            combined = dict(links)
            for cli in known & set(stored):
                combined[cli] = merge_links([stored[cli], links.get(cli, ())])
        except Exception as exc:
            warnings.add(f"pr link store {type(exc).__name__}")
            return links
        try:
            store.remember(links, known, now)
        except Exception as exc:  # a failed write keeps the links in hand; the next change tries again
            warnings.add(f"pr link store {type(exc).__name__}")
        return combined

    def _regular_transcript(self, sid: str, cwd: str) -> tuple[Path | None, int | None]:
        """The first of a session's transcript candidates that is a regular file, and its mtime in ms."""
        for path in self._transcript_candidates(sid, cwd):
            mtime = _regular_mtime(path)
            if mtime is not None:
                return path, mtime
        return None, None

    def _prior_ids_by_session(self) -> dict[str, frozenset[str]]:
        return {entry[2].session_id: entry[3] for entry in self._desktop_cache.values()
                if entry[2] is not None and entry[3]}

    # -- background work -------------------------------------------------------------------------

    def _background(self, live: list[model.RegistryEntry], tails: dict[str, model.Tail], now: int,
                    warnings: set[str]) -> dict[str, model.BackgroundWork]:
        if not live:
            return {}
        try:
            children = self._shells.children({e.pid for e in live}, now, warnings)
        except Exception as exc:  # an injected probe must not take the scan down
            warnings.add(f"ps {type(exc).__name__}")
            children = {}
        work: dict[str, model.BackgroundWork] = {}
        for entry in live:
            shells, oldest = children.get(entry.pid, (0, None))
            tail = tails.get(entry.session_id)
            pending, wakeup = tail_background(tail.records) if tail is not None else (0, False)
            work[entry.session_id] = model.BackgroundWork(shells=shells, oldest_started_at=oldest,
                                                          pending_launches=pending, scheduled_wakeup=wakeup)
        return work

    def _editor_hosted(self, live: list[model.RegistryEntry]) -> dict[str, str]:
        """{session id: editor key} for live sessions whose process runs under an editor, from the ps table
        _background has just used."""
        probe = getattr(self._shells, "editors_of", None)
        if not live or probe is None:
            return {}
        try:
            editors = probe({e.pid for e in live})
            return {e.session_id: editors[e.pid] for e in live if e.pid in editors}
        except Exception:  # an injected probe must not take the scan down; the ps warning is _background's
            return {}

    def _default_editor(self) -> str | None:
        """The first editor installed, for a chat that ended before Tokentown saw it live: nothing on disk says
        which editor it ran in."""
        for editor in EDITORS:
            if any((folder / editor.app).is_dir() for folder in self.paths.applications):
                return editor.key
        return None

    # -- plan usage ------------------------------------------------------------------------------

    def _plan_usage(self, now: int) -> model.PlanUsage | None:
        """The newest sample in any app folder's usage history."""
        best = None
        seen: set[str] = set()
        for root in self._app_roots:
            path = root / PLAN_USAGE
            try:
                st = os.stat(path)
            except (OSError, ValueError):
                continue
            key = str(path)
            seen.add(key)
            sig = (st.st_mtime_ns, st.st_size)
            cached = self._plan_cache.get(key)
            if cached is None or cached[0] != sig:
                try:
                    samples = _read_plan_samples(path, st.st_size) if stat.S_ISREG(st.st_mode) else ()
                except Exception:  # the app rewrites this file; a torn or odd copy just means no reading
                    samples = ()
                cached = self._plan_cache[key] = (sig, samples)
            samples = cached[1]
            # A sample far ahead of now is a clock problem, not a reading; the check runs per scan so a
            # cached sample becomes eligible once the clock catches up.
            i = bisect.bisect_right(samples, now + PLAN_FUTURE_SLACK_MS, key=lambda sample: sample[0])
            if i and (best is None or samples[i - 1][0] > best[0]):
                best = samples[i - 1]
        for key in [k for k in self._plan_cache if k not in seen]:
            del self._plan_cache[key]
        if best is None:
            return None
        t, five_hour, weekly = best
        return model.PlanUsage(five_hour_pct=five_hour, weekly_pct=weekly, sampled_at=t)

    # -- app version -----------------------------------------------------------------------------

    def _app_version(self, warnings: set[str]) -> str | None:
        """The version of the first Claude.app found."""
        for path in self.paths.app_plists:
            try:
                st = path.stat()
            except OSError:
                continue
            sig = (str(path), st.st_mtime_ns, st.st_size)
            if self._plist_cache is not None and self._plist_cache[0] == sig:
                return self._plist_cache[1]
            try:
                with open_for_read(path, "rb") as fh:
                    data = plistlib.load(fh)
                version = data.get("CFBundleShortVersionString") if isinstance(data, dict) else None
                version = version if isinstance(version, str) else None
            except Exception as exc:  # plistlib raises several unrelated types on bad input
                warnings.add(f"app plist {type(exc).__name__}")
                version = None
            self._plist_cache = (sig, version)
            return version
        self._plist_cache = None
        return None
