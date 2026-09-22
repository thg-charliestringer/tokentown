"""Tail verdict: what the end of a transcript says a session is doing.

Pure: reads only the structure-only TailRecords that sources.py produced.
"""
from __future__ import annotations

from dataclasses import dataclass

from .model import Tail, TailRecord

RATE_LIMITED = "RATE_LIMITED"
API_ERROR = "API_ERROR"
RETRYING = "RETRYING"
TOOL_PENDING = "TOOL_PENDING"
MODEL_NEXT = "MODEL_NEXT"
ENDED = "ENDED"
NONE = "NONE"

QUALIFYING_SYSTEM_SUBTYPES = frozenset({"stop_hook_summary", "api_error"})
ENDED_STOP_REASONS = frozenset({"end_turn", "stop_sequence", None})
THINKING_BLOCKS = frozenset({"thinking", "redacted_thinking"})
# Tools that block on Charlie. When several tool calls are pending at once, one of these wins so a
# question never hides behind a parallel Bash call.
USER_FACING_TOOLS = ("AskUserQuestion", "ExitPlanMode")


@dataclass(frozen=True)
class Verdict:
    kind: str
    tool_name: str | None = None
    since: int | None = None
    error_kind: str | None = None
    resets_at: int | None = None
    limit_type: str | None = None
    last_ts: int | None = None


NO_VERDICT = Verdict(NONE)


def _qualifies(r: TailRecord) -> bool:
    if r.is_sidechain or r.is_meta:
        return False
    if r.type in ("assistant", "user"):
        return True
    return r.type == "system" and r.subtype in QUALIFYING_SYSTEM_SUBTYPES


def last_record_ts(tail: Tail | None) -> int | None:
    """Timestamp of the newest qualifying record that has one."""
    if tail is None or not tail.found:
        return None
    for r in reversed(tail.records):
        if _qualifies(r) and r.timestamp is not None:
            return r.timestamp
    return None


def _pending_tool(records: list[TailRecord]) -> tuple[str, int | None] | None:
    """Newest-turn tool_use with no later tool_result, walking back from the end.

    Stops at a turn boundary (a user prompt with no tool results, or a stop hook summary) so a tool
    call abandoned in an earlier turn is never reported.
    """
    resolved: set[str] = set()
    pending: list[tuple[str, int | None]] = []
    for r in reversed(records):
        if r.type == "user":
            if not r.tool_result_ids:
                break
            resolved.update(r.tool_result_ids)
        elif r.type == "system":
            if r.subtype == "stop_hook_summary":
                break
        elif r.type == "assistant":
            for tool_id, name in r.tool_uses:
                if tool_id not in resolved:
                    pending.append((name, r.timestamp))
    if not pending:
        return None
    for name in USER_FACING_TOOLS:
        for p in pending:
            if p[0] == name:
                return p
    # pending was collected newest first; the oldest call is the one that has run longest.
    return pending[-1]


def _error_verdict(r: TailRecord, now: int, last_ts: int | None) -> Verdict | None:
    if r.quota_status == "rejected" and r.quota_resets_at is not None and r.quota_resets_at > now:
        return Verdict(RATE_LIMITED, error_kind=r.error_kind, resets_at=r.quota_resets_at,
                       limit_type=r.quota_limit_type, since=r.timestamp, last_ts=last_ts)
    if r.is_api_error:
        return Verdict(API_ERROR, error_kind=r.error_kind, since=r.timestamp, last_ts=last_ts)
    return None


def tail_verdict(tail: Tail | None, now: int) -> Verdict:
    if tail is None or not tail.found:
        return NO_VERDICT
    records = [r for r in tail.records if _qualifies(r)]
    if not records:
        return NO_VERDICT

    last = records[-1]
    last_ts = last.timestamp

    # A stop hook summary or api_error system record trails the assistant record that decided the
    # turn, so an assistant error just before them still wins.
    i = len(records) - 1
    while i >= 0 and records[i].type == "system":
        i -= 1
    anchor = records[i] if i >= 0 else None
    if anchor is not None and anchor.type == "assistant":
        err = _error_verdict(anchor, now, last_ts)
        if err is not None:
            return err

    if last.type == "system":
        if last.subtype == "api_error":
            if (last.retry_attempt is not None and last.max_retries is not None
                    and last.retry_attempt < last.max_retries):
                return Verdict(RETRYING, error_kind=last.error_kind, since=last_ts, last_ts=last_ts)
            return Verdict(API_ERROR, error_kind=last.error_kind, since=last_ts, last_ts=last_ts)
        return Verdict(ENDED, since=last_ts, last_ts=last_ts)

    if last.tool_uses or (last.type == "user" and last.tool_result_ids):
        pending = _pending_tool(records)
        if pending is not None:
            return Verdict(TOOL_PENDING, tool_name=pending[0], since=pending[1], last_ts=last_ts)

    if last.type == "user":
        return Verdict(MODEL_NEXT, since=last_ts, last_ts=last_ts)

    # Transcripts write one record per content block, so a long think leaves a thinking-only record
    # (stop_reason null) last while the model is still mid-response.
    if last.block_types and all(b in THINKING_BLOCKS for b in last.block_types):
        return Verdict(MODEL_NEXT, since=last_ts, last_ts=last_ts)
    if not last.tool_uses and last.stop_reason in ENDED_STOP_REASONS:
        return Verdict(ENDED, since=last_ts, last_ts=last_ts)
    return NO_VERDICT
