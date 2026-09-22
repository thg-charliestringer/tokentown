"""status.tail_verdict, board.build_board and check.run_check, on synthetic model objects only."""
from __future__ import annotations

import hashlib
import io
import json
import sys
import types
import unittest
from unittest import mock

from town import board as bd
from town import check as ck
from town import status as st
from town.model import (BackgroundWork, CliTranscript, DesktopRecord, GitHubPr, PlanUsage, PrLink, PullRequest,
                       RawSnapshot, RegistryEntry, ReviewRequest, ReviewSnapshot, SessionTokens, SourceFolder, Tail,
                       TailRecord, TokenTotals)
from town.reviews import review_id

NOW = 1_800_000_000_000
SEC = 1000
MIN = 60 * SEC
HOUR = 60 * MIN
DAY = 24 * HOUR


def uid(n: int) -> str:
    return f"{n:08x}-0000-4000-8000-{n:012x}"


def rec(type_: str = "assistant", **kw) -> TailRecord:
    base = dict(type=type_, subtype=None, timestamp=NOW - MIN, is_sidechain=False, is_meta=False,
                stop_reason=None, block_types=(), tool_uses=(), tool_result_ids=(), is_api_error=False,
                error_kind=None, retry_attempt=None, max_retries=None, quota_status=None,
                quota_resets_at=None, quota_limit_type=None)
    base.update(kw)
    return TailRecord(**base)


def text(ts=NOW - MIN, stop="end_turn", **kw):
    return rec("assistant", block_types=("text",), stop_reason=stop, timestamp=ts, **kw)


def use(tool_id, name, ts=NOW - MIN, **kw):
    return rec("assistant", block_types=("tool_use",), tool_uses=((tool_id, name),), stop_reason="tool_use",
               timestamp=ts, **kw)


def result(*ids, ts=NOW - MIN, **kw):
    return rec("user", block_types=("tool_result",) * len(ids), tool_result_ids=tuple(ids), timestamp=ts, **kw)


def prompt(ts=NOW - MIN, **kw):
    return rec("user", block_types=("text",), timestamp=ts, **kw)


def system(subtype, ts=NOW - MIN, **kw):
    return rec("system", subtype=subtype, timestamp=ts, **kw)


def api_error(kind="server_error", ts=NOW - MIN, **kw):
    return rec("assistant", block_types=("text",), is_api_error=True, error_kind=kind, timestamp=ts, **kw)


def tail(*records, found=True, newest_mtime=None, unknown_types=(), title=None, cwd=None):
    return Tail(found=found, records=tuple(records), newest_mtime=newest_mtime, unknown_types=tuple(unknown_types),
                title=title, cwd=cwd)


def desktop(n: int = 1, **kw) -> DesktopRecord:
    base = dict(session_id=f"local_{uid(n)}", cli_session_id=uid(1000 + n), cwd="/Users/t/code/repo-a",
                origin_cwd="/Users/t/code/repo-a", title=f"Session {n}", model="opus", effort="high",
                branch="main", permission_mode="default", created_at=NOW - 3 * HOUR,
                last_activity_at=NOW - HOUR, last_focused_at=None, is_archived=False, error_at=None, prs=(),
                transcript_unavailable=False)
    base.update(kw)
    return DesktopRecord(**base)


def entry(session_id: str, **kw) -> RegistryEntry:
    base = dict(pid=4242, session_id=session_id, cwd="/Users/t/code/repo-a", status="idle", waiting_for=None,
                status_updated_at=NOW - 30 * MIN, started_at=NOW - 2 * HOUR, version="2.1.271",
                entrypoint="claude-desktop")
    base.update(kw)
    return RegistryEntry(**base)


def cli(n: int = 1, **kw) -> CliTranscript:
    base = dict(session_id=uid(2000 + n), cwd="/Users/t/code/repo-b", cwd_exists=True,
                last_activity_at=NOW - HOUR)
    base.update(kw)
    return CliTranscript(**base)


def snap(desktop_=(), registry=(), cli_=(), tails=None, **kw) -> RawSnapshot:
    base = dict(scanned_at=NOW, desktop=tuple(desktop_), registry_files=len(registry),
                registry_live=tuple(registry), cli_only=tuple(cli_), tails=dict(tails or {}),
                app_version="2.110.0", cli_versions=("2.1.271",), desktop_parse_errors=0, scan_ms=12,
                warnings=())
    base.update(kw)
    return RawSnapshot(**base)


def one(rec_kw=None, entry_kw=None, tail_=None, live=True, now=NOW, github=None, links=None, background=None,
        done=None):
    """Board for a single desktop session. Returns (lane, row or None, board).

    `done` is the doneAt for this session's row, or a whole marks dict.
    """
    d = desktop(1, **(rec_kw or {}))
    reg = [entry(d.cli_session_id, **(entry_kw or {}))] if live else []
    tails = {d.cli_session_id: tail_} if tail_ is not None else {}
    extra = {}
    if links is not None:
        extra["pr_links"] = {d.cli_session_id: tuple(links)}
    if background is not None:
        extra["background"] = {d.cli_session_id: background}
    if isinstance(done, int):
        done = {d.session_id: done}
    b = bd.build_board(snap([d], reg, tails=tails, **extra), now, github, done)
    if b["sessions"]:
        return b["sessions"][0]["lane"], b["sessions"][0], b
    lanes = [k for k, v in b["counts"].items() if v]
    return lanes[0], None, b


def one_cli(cli_kw=None, entry_kw=None, tail_=None, live=True, now=NOW, github=None, links=None, background=None,
            done=None):
    c = cli(1, **(cli_kw or {}))
    reg = [entry(c.session_id, entrypoint="cli", **(entry_kw or {}))] if live else []
    tails = {c.session_id: tail_} if tail_ is not None else {}
    extra = {}
    if links is not None:
        extra["pr_links"] = {c.session_id: tuple(links)}
    if background is not None:
        extra["background"] = {c.session_id: background}
    if isinstance(done, int):
        done = {f"cli:{c.session_id}": done}
    b = bd.build_board(snap((), reg, [c], tails=tails, **extra), now, github, done)
    if b["sessions"]:
        return b["sessions"][0]["lane"], b["sessions"][0], b
    lanes = [k for k, v in b["counts"].items() if v]
    return lanes[0], None, b


class TailVerdictTests(unittest.TestCase):
    def v(self, *records, now=NOW, **kw):
        return st.tail_verdict(tail(*records, **kw), now)

    def test_constants_and_frozen(self):
        for name in ("RATE_LIMITED", "API_ERROR", "RETRYING", "TOOL_PENDING", "MODEL_NEXT", "ENDED", "NONE"):
            self.assertEqual(getattr(st, name), name)
        with self.assertRaises(Exception):
            st.Verdict(st.NONE).kind = st.ENDED

    def test_none_when_no_tail_or_not_found_or_empty(self):
        self.assertEqual(st.tail_verdict(None, NOW).kind, st.NONE)
        self.assertEqual(st.tail_verdict(tail(text(), found=False), NOW).kind, st.NONE)
        self.assertEqual(self.v().kind, st.NONE)

    def test_none_when_nothing_qualifies(self):
        v = self.v(
            rec("attachment"), rec("file-history-snapshot"), rec("last-prompt"), rec("summary"),
            system("compact_boundary"), system("turn_duration"), system("local_command"),
            system("away_summary"), system("informational"),
            text(is_sidechain=True), prompt(is_meta=True),
        )
        self.assertEqual(v.kind, st.NONE)
        self.assertIsNone(v.last_ts)

    def test_rate_limited_in_future(self):
        v = self.v(prompt(), api_error("rate_limit", ts=NOW - 2 * MIN, quota_status="rejected",
                                       quota_resets_at=NOW + HOUR, quota_limit_type="five_hour"))
        self.assertEqual((v.kind, v.resets_at, v.limit_type, v.error_kind),
                         (st.RATE_LIMITED, NOW + HOUR, "five_hour", "rate_limit"))
        self.assertEqual(v.last_ts, NOW - 2 * MIN)

    def test_rate_limit_needs_no_api_error_flag(self):
        v = self.v(text(quota_status="rejected", quota_resets_at=NOW + MIN, quota_limit_type="weekly"))
        self.assertEqual(v.kind, st.RATE_LIMITED)

    def test_rate_limit_reset_passed_becomes_api_error(self):
        v = self.v(api_error("rate_limit", quota_status="rejected", quota_resets_at=NOW - SEC))
        self.assertEqual((v.kind, v.error_kind), (st.API_ERROR, "rate_limit"))
        v = self.v(api_error("rate_limit", quota_status="rejected", quota_resets_at=NOW))
        self.assertEqual(v.kind, st.API_ERROR)

    def test_quota_not_rejected_is_not_rate_limited(self):
        v = self.v(text(quota_status="allowed_warning", quota_resets_at=NOW + HOUR))
        self.assertEqual(v.kind, st.ENDED)

    def test_rate_limited_survives_trailing_system_records(self):
        v = self.v(api_error("rate_limit", ts=NOW - 3 * MIN, quota_status="rejected", quota_resets_at=NOW + HOUR),
                   system("api_error", ts=NOW - 2 * MIN, retry_attempt=10, max_retries=10),
                   system("stop_hook_summary", ts=NOW - MIN))
        self.assertEqual(v.kind, st.RATE_LIMITED)
        self.assertEqual(v.last_ts, NOW - MIN)

    def test_api_error(self):
        for kind in ("server_error", "authentication_failed", "rate_limit", "invalid_request", None):
            with self.subTest(kind=kind):
                v = self.v(prompt(), api_error(kind))
                self.assertEqual((v.kind, v.error_kind), (st.API_ERROR, kind))

    def test_api_error_followed_by_system_api_error(self):
        v = self.v(prompt(ts=NOW - 5 * MIN), api_error("authentication_failed", ts=NOW - 4 * MIN),
                   system("api_error", ts=NOW - 3 * MIN, error_kind="server_error", retry_attempt=1, max_retries=10))
        self.assertEqual((v.kind, v.error_kind, v.last_ts), (st.API_ERROR, "authentication_failed", NOW - 3 * MIN))

    def test_api_error_followed_by_stop_hook(self):
        v = self.v(api_error("server_error", ts=NOW - 2 * MIN), system("stop_hook_summary", ts=NOW - MIN))
        self.assertEqual(v.kind, st.API_ERROR)

    def test_retrying(self):
        v = self.v(prompt(ts=NOW - 2 * MIN),
                   system("api_error", ts=NOW - MIN, error_kind="server_error", retry_attempt=3, max_retries=10))
        self.assertEqual((v.kind, v.since, v.last_ts), (st.RETRYING, NOW - MIN, NOW - MIN))

    def test_retries_exhausted_is_api_error(self):
        v = self.v(prompt(), system("api_error", error_kind="server_error", retry_attempt=10, max_retries=10))
        self.assertEqual((v.kind, v.error_kind), (st.API_ERROR, "server_error"))

    def test_system_api_error_without_retry_fields_is_api_error(self):
        v = self.v(prompt(), system("api_error", error_kind="overloaded"))
        self.assertEqual(v.kind, st.API_ERROR)

    def test_retrying_only_when_last(self):
        v = self.v(prompt(ts=NOW - 3 * MIN), system("api_error", ts=NOW - 2 * MIN, retry_attempt=1, max_retries=10),
                   text(ts=NOW - MIN))
        self.assertEqual(v.kind, st.ENDED)

    def test_tool_pending(self):
        v = self.v(prompt(ts=NOW - 5 * MIN), text(ts=NOW - 4 * MIN, stop=None), use("t1", "Bash", ts=NOW - 3 * MIN))
        self.assertEqual((v.kind, v.tool_name, v.since, v.last_ts), (st.TOOL_PENDING, "Bash", NOW - 3 * MIN, NOW - 3 * MIN))

    def test_tool_pending_with_parallel_results_partly_in(self):
        v = self.v(prompt(ts=NOW - 5 * MIN), use("a", "Read", ts=NOW - 4 * MIN), use("b", "Bash", ts=NOW - 4 * MIN + 1),
                   result("a", ts=NOW - 3 * MIN))
        self.assertEqual((v.kind, v.tool_name, v.since), (st.TOOL_PENDING, "Bash", NOW - 4 * MIN + 1))
        self.assertEqual(v.last_ts, NOW - 3 * MIN)

    def test_parallel_results_all_in_is_model_next(self):
        v = self.v(prompt(), use("a", "Read"), use("b", "Bash"), result("b"), result("a"))
        self.assertEqual(v.kind, st.MODEL_NEXT)

    def test_multi_result_record_resolves_all(self):
        v = self.v(prompt(), use("a", "Read"), use("b", "Grep"), result("a", "b"))
        self.assertEqual(v.kind, st.MODEL_NEXT)

    def test_question_wins_over_parallel_tool(self):
        v = self.v(prompt(), use("a", "Bash", ts=NOW - 3 * MIN), use("q", "AskUserQuestion", ts=NOW - 2 * MIN))
        self.assertEqual((v.tool_name, v.since), ("AskUserQuestion", NOW - 2 * MIN))
        v = self.v(prompt(), use("p", "ExitPlanMode", ts=NOW - 3 * MIN), use("a", "Bash", ts=NOW - 2 * MIN))
        self.assertEqual(v.tool_name, "ExitPlanMode")

    def test_oldest_pending_tool_wins_otherwise(self):
        v = self.v(prompt(), use("a", "Bash", ts=NOW - 9 * MIN), use("b", "Read", ts=NOW - 2 * MIN))
        self.assertEqual((v.tool_name, v.since), ("Bash", NOW - 9 * MIN))

    def test_unresolved_tool_in_earlier_turn_is_ignored(self):
        v = self.v(use("old", "Bash", ts=NOW - 50 * MIN), prompt(ts=NOW - 40 * MIN), use("new", "Read", ts=NOW - 30 * MIN),
                   result("new", ts=NOW - 20 * MIN))
        self.assertEqual(v.kind, st.MODEL_NEXT)
        v = self.v(use("old", "Bash"), system("stop_hook_summary"), prompt(), use("new", "Read"), result("new"))
        self.assertEqual(v.kind, st.MODEL_NEXT)

    def test_sidechain_and_meta_records_are_skipped(self):
        v = self.v(prompt(), use("a", "Task", ts=NOW - 5 * MIN), result("a", is_sidechain=True),
                   text(is_sidechain=True), prompt(is_meta=True))
        self.assertEqual((v.kind, v.tool_name), (st.TOOL_PENDING, "Task"))

    def test_model_next_on_user_text(self):
        v = self.v(text(ts=NOW - 3 * MIN), prompt(ts=NOW - 2 * MIN), rec("attachment", timestamp=NOW - MIN))
        self.assertEqual((v.kind, v.last_ts), (st.MODEL_NEXT, NOW - 2 * MIN))

    def test_model_next_on_string_content_user_record(self):
        self.assertEqual(self.v(rec("user")).kind, st.MODEL_NEXT)

    def test_ended_stop_reasons(self):
        for reason in ("end_turn", "stop_sequence", None):
            with self.subTest(reason=reason):
                v = self.v(prompt(ts=NOW - 2 * MIN), text(ts=NOW - MIN, stop=reason))
                self.assertEqual((v.kind, v.since), (st.ENDED, NOW - MIN))

    def test_other_stop_reason_without_tools_is_none(self):
        self.assertEqual(self.v(prompt(), text(stop="max_tokens")).kind, st.NONE)

    def test_stop_hook_summary_is_ended(self):
        v = self.v(prompt(ts=NOW - 3 * MIN), text(ts=NOW - 2 * MIN), system("stop_hook_summary", ts=NOW - MIN))
        self.assertEqual((v.kind, v.since), (st.ENDED, NOW - MIN))

    def test_skipped_system_subtypes_after_end(self):
        v = self.v(prompt(), text(ts=NOW - 5 * MIN), system("turn_duration"), system("compact_boundary"),
                   system("away_summary"), system("local_command"), system("informational"),
                   rec("custom-title"), rec("ai-title"), rec("pr-link"))
        self.assertEqual((v.kind, v.last_ts), (st.ENDED, NOW - 5 * MIN))

    def test_thinking_only_record_is_mid_response(self):
        v = self.v(prompt(), rec("assistant", block_types=("thinking",), stop_reason=None))
        self.assertEqual(v.kind, st.MODEL_NEXT)

    def test_old_api_error_before_new_turn_is_forgotten(self):
        v = self.v(api_error("server_error", ts=NOW - 10 * MIN), prompt(ts=NOW - 5 * MIN), text(ts=NOW - MIN))
        self.assertEqual(v.kind, st.ENDED)


class LiveLaneTests(unittest.TestCase):
    # Rule 1
    def test_waiting_labels(self):
        cases = [("permission prompt", "Approve"), ("input needed", "Answer"), ("plan review", "Check: plan review"),
                 (None, "Check status"), ("", "Check status")]
        for waiting_for, label in cases:
            with self.subTest(waiting_for=waiting_for):
                lane, row, _ = one(entry_kw=dict(status="waiting", waiting_for=waiting_for,
                                                 status_updated_at=NOW - 7 * MIN))
                self.assertEqual((lane, row["label"], row["since"]), ("needs_you", label, NOW - 7 * MIN))

    def test_waiting_other_value_truncated_and_cleaned(self):
        _, row, _ = one(entry_kw=dict(status="waiting", waiting_for="x\n‮" + "y" * 60))
        self.assertEqual(row["label"], "Check: x" + "y" * 39)

    def test_waiting_since_falls_back_to_last_activity(self):
        _, row, _ = one(entry_kw=dict(status="waiting", status_updated_at=None))
        self.assertEqual(row["since"], NOW - HOUR)

    # Rules 2 and 3
    def test_pending_question_and_plan(self):
        for tool, label in (("AskUserQuestion", "Answer"), ("ExitPlanMode", "Review plan")):
            for status in ("idle", "busy"):
                with self.subTest(tool=tool, status=status):
                    lane, row, _ = one(entry_kw=dict(status=status),
                                       tail_=tail(prompt(ts=NOW - 9 * MIN), use("q", tool, ts=NOW - 8 * MIN)))
                    self.assertEqual((lane, row["label"], row["since"]), ("needs_you", label, NOW - 8 * MIN))

    def test_pending_other_tool_is_not_needs_you(self):
        lane, _, _ = one(entry_kw=dict(status="busy"), tail_=tail(prompt(), use("a", "Bash")))
        self.assertEqual(lane, "running")

    # Rule 4
    def test_unknown_status(self):
        lane, row, b = one(entry_kw=dict(status="thinking", status_updated_at=NOW - 3 * MIN))
        self.assertEqual((lane, row["label"], row["since"]), ("needs_you", "Check status", NOW - 3 * MIN))
        self.assertEqual(b["health"]["registry"]["unknownStatuses"], ["thinking"])
        self.assertFalse(b["health"]["ok"])

    def test_missing_status_counts_as_unknown(self):
        lane, row, b = one(entry_kw=dict(status=None))
        self.assertEqual((lane, row["label"]), ("needs_you", "Check status"))
        self.assertEqual(b["health"]["registry"]["unknownStatuses"], ["(missing)"])
        self.assertFalse(b["health"]["ok"])

    # Rule 5
    def test_idle_with_api_error_labels(self):
        cases = [("rate_limit", "Rate limited"), ("authentication_failed", "Signed out"),
                 ("server_error", "API error"), ("invalid_request", "Error"), (None, "Error")]
        for kind, label in cases:
            with self.subTest(kind=kind):
                lane, row, _ = one(tail_=tail(prompt(ts=NOW - 6 * MIN), api_error(kind, ts=NOW - 5 * MIN)))
                self.assertEqual((lane, row["label"], row["since"]), ("errored", label, NOW - 5 * MIN))

    def test_idle_rate_limited(self):
        lane, row, b = one(tail_=tail(api_error(None, ts=NOW - 4 * MIN, quota_status="rejected",
                                                quota_resets_at=NOW + HOUR, quota_limit_type="five_hour")))
        self.assertEqual((lane, row["label"], row["since"]), ("errored", "Rate limited", NOW - 4 * MIN))
        self.assertEqual(b["rateLimit"], {"resetsAt": NOW + HOUR, "limitType": "five_hour"})

    def test_errored_since_is_last_qualifying_record(self):
        _, row, _ = one(tail_=tail(api_error("server_error", ts=NOW - 5 * MIN),
                                   system("api_error", ts=NOW - 4 * MIN, retry_attempt=10, max_retries=10)))
        self.assertEqual(row["since"], NOW - 4 * MIN)

    # Rule 6
    def test_busy_and_shell_are_running(self):
        for status in ("busy", "shell"):
            with self.subTest(status=status):
                lane, row, _ = one(entry_kw=dict(status=status, status_updated_at=NOW - 2 * MIN))
                self.assertEqual((lane, row["label"], row["since"], row["hints"]),
                                 ("running", "Running", NOW - 2 * MIN, []))

    def test_running_hints(self):
        cases = [
            (tail(prompt(), text()), "default", ["background"]),
            (tail(prompt(), system("api_error", retry_attempt=1, max_retries=10)), "default", ["retrying"]),
            (tail(prompt(), use("a", "Bash", ts=NOW - 5 * MIN)), "default", ["tool running 5 min"]),
            (tail(prompt(), use("a", "Bash", ts=NOW - 91 * SEC)), "default", ["tool running 1 min"]),
            (tail(prompt(), use("a", "Bash", ts=NOW - 90 * SEC)), "default", []),
            (tail(prompt(), use("a", "Bash", ts=NOW - 5 * MIN)), "auto", []),
            (tail(prompt(), newest_mtime=NOW - 25 * MIN), "default", ["quiet 25 min"]),
            (tail(prompt(), newest_mtime=NOW - 10 * MIN), "default", []),
            (tail(prompt(), text(), newest_mtime=NOW - 11 * MIN), "default", ["background", "quiet 11 min"]),
            (tail(prompt(), use("a", "Bash", ts=NOW - 3 * MIN), newest_mtime=NOW - 12 * MIN), "default",
             ["tool running 3 min", "quiet 12 min"]),
        ]
        for i, (t, mode, hints) in enumerate(cases):
            with self.subTest(i=i):
                lane, row, _ = one(rec_kw=dict(permission_mode=mode), entry_kw=dict(status="busy"), tail_=t)
                self.assertEqual((lane, row["hints"]), ("running", hints))

    def test_hints_never_change_the_lane(self):
        lane, row, _ = one(entry_kw=dict(status="busy"), tail_=tail(api_error("server_error")))
        self.assertEqual((lane, row["hints"]), ("running", []))

    # Rule 8
    def test_needs_input_after_end(self):
        for t in (tail(prompt(), text()), None):
            with self.subTest(tail=t is not None):
                lane, row, _ = one(entry_kw=dict(status_updated_at=NOW - 30 * MIN), tail_=t)
                self.assertEqual((lane, row["label"], row["since"]), ("your_turn", "Needs input", NOW - 30 * MIN))

    def test_needs_input_since_uses_last_activity_when_it_predates_process_start(self):
        _, row, _ = one(rec_kw=dict(last_activity_at=NOW - HOUR),
                        entry_kw=dict(started_at=NOW - 10 * MIN, status_updated_at=NOW - 9 * MIN),
                        tail_=tail(text(ts=NOW - HOUR)))
        self.assertEqual((row["lane"], row["since"]), ("your_turn", NOW - HOUR))

    def test_needs_input_ignores_whether_it_was_read(self):
        # (d) Charlie has looked since the turn ended: still his move for 2 hours.
        ended = NOW - 30 * MIN
        for focused in (None, ended - HOUR, ended - 120_001, ended - 120_000, ended + MIN, NOW):
            with self.subTest(focused=focused):
                lane, row, _ = one(rec_kw=dict(last_activity_at=ended, last_focused_at=focused),
                                   tail_=tail(prompt(ts=ended - MIN), text(ts=ended)))
                self.assertEqual((lane, row["label"], row["unread"]), ("your_turn", "Needs input", False))

    def test_needs_input_lasts_2_hours_from_the_turn_end(self):
        # (d) then Idle: the Cottages.
        for ended, expected in ((NOW - 2 * HOUR, "your_turn"), (NOW - 2 * HOUR - 1, "idle"),
                                (NOW - 2 * HOUR - MIN, "idle"), (NOW - 3 * DAY, "idle"), (NOW + MIN, "your_turn")):
            with self.subTest(ended=ended):
                lane, row, _ = one(rec_kw=dict(last_activity_at=min(ended, NOW), last_focused_at=NOW),
                                   entry_kw=dict(status_updated_at=NOW - 5 * HOUR),
                                   tail_=tail(prompt(ts=ended - MIN), text(ts=ended)))
                self.assertEqual((lane, row["label"]), (expected, "Needs input" if expected == "your_turn" else "Idle"))
        self.assertEqual(bd.NEEDS_INPUT_MS, 2 * HOUR)

    def test_needs_input_clock_is_the_ended_record_not_later_app_times(self):
        # The app's lastActivityAt moving on does not restart the 2 hours; with no transcript it is all there is.
        ended = NOW - 3 * HOUR
        lane, row, _ = one(rec_kw=dict(last_activity_at=NOW - 10 * MIN), tail_=tail(text(ts=ended)))
        self.assertEqual((lane, row["lastActivityAt"]), ("idle", NOW - 10 * MIN))
        self.assertEqual(one(rec_kw=dict(last_activity_at=NOW - 10 * MIN))[0], "your_turn")
        self.assertEqual(one(rec_kw=dict(last_activity_at=NOW - 2 * HOUR - 1))[0], "idle")
        # A turn that ended with a stop hook summary is timed from it.
        t = tail(text(ts=NOW - 2 * HOUR - 5 * SEC), system("stop_hook_summary", ts=NOW - 2 * HOUR + 5 * SEC))
        self.assertEqual(one(rec_kw=dict(last_activity_at=NOW - 3 * HOUR), tail_=t)[0], "your_turn")

    # Rule 9
    def test_idle_when_turn_not_ended(self):
        for t in (tail(prompt()), tail(prompt(), use("a", "Bash"))):
            with self.subTest():
                lane, row, _ = one(entry_kw=dict(status_updated_at=NOW - 4 * MIN), tail_=t)
                self.assertEqual((lane, row["label"], row["since"]), ("idle", "Idle", NOW - 4 * MIN))

    def test_live_archived_session_uses_live_rules(self):
        lane, _, _ = one(rec_kw=dict(is_archived=True), tail_=tail(text()))
        self.assertEqual(lane, "your_turn")

    # Precedence collisions
    def test_waiting_beats_api_error(self):
        lane, row, _ = one(entry_kw=dict(status="waiting", waiting_for="permission prompt"),
                           tail_=tail(api_error("server_error")))
        self.assertEqual((lane, row["label"]), ("needs_you", "Approve"))

    def test_waiting_label_names_a_pending_question_or_plan(self):
        # The CLI reports both as "permission prompt".
        for tool, label in (("AskUserQuestion", "Answer"), ("ExitPlanMode", "Review plan"), ("Bash", "Approve")):
            for waiting_for in ("permission prompt", "input needed"):
                with self.subTest(tool=tool, waiting_for=waiting_for):
                    lane, row, _ = one(entry_kw=dict(status="waiting", waiting_for=waiting_for,
                                                     status_updated_at=NOW - 6 * MIN),
                                       tail_=tail(prompt(ts=NOW - 8 * MIN), use("q", tool, ts=NOW - 7 * MIN)))
                    expected = "Answer" if tool == "Bash" and waiting_for == "input needed" else label
                    self.assertEqual((lane, row["label"], row["since"]), ("needs_you", expected, NOW - 6 * MIN))
        _, row, _ = one(entry_kw=dict(status="waiting", waiting_for="permission prompt"),
                        tail_=tail(use("q", "ExitPlanMode", ts=NOW - 9 * MIN), result("q", ts=NOW - 8 * MIN)))
        self.assertEqual(row["label"], "Approve")

    def test_question_beats_unknown_status_but_health_still_flags(self):
        lane, row, b = one(entry_kw=dict(status="weird"), tail_=tail(use("q", "AskUserQuestion")))
        self.assertEqual((lane, row["label"]), ("needs_you", "Answer"))
        self.assertEqual(b["health"]["registry"]["unknownStatuses"], ["weird"])

    def test_newest_registry_entry_wins(self):
        d = desktop(1)
        reg = [entry(d.cli_session_id, pid=1, status="waiting", status_updated_at=NOW - 20 * MIN),
               entry(d.cli_session_id, pid=2, status="busy", status_updated_at=NOW - MIN)]
        b = bd.build_board(snap([d], reg), NOW)
        self.assertEqual(b["sessions"][0]["lane"], "running")


class DeadLaneTests(unittest.TestCase):
    # Rule 13
    def test_archived_is_graveyard(self):
        lane, row, b = one(rec_kw=dict(is_archived=True, last_activity_at=NOW - 2 * HOUR), live=False)
        self.assertEqual((lane, row["label"], row["since"], row["restReason"]),
                         ("graveyard", "Archived", NOW - 2 * HOUR, "archived"))
        self.assertEqual(b["counts"]["graveyard"], 1)

    def test_archived_recent_error_is_graveyard(self):
        for kw, t in ((dict(error_at=NOW - HOUR), None), ({}, tail(api_error("server_error"))),
                      (dict(error_at=NOW - HOUR), tail(api_error("authentication_failed")))):
            with self.subTest(kw=kw, tail=t is not None):
                lane, row, _ = one(rec_kw=dict(is_archived=True, **kw), live=False, tail_=t)
                self.assertEqual((lane, row["restReason"]), ("graveyard", "archived"))

    # Rule 10
    def test_not_live_api_error_within_d7(self):
        lane, row, _ = one(rec_kw=dict(last_activity_at=NOW - 2 * DAY), live=False,
                           tail_=tail(api_error("authentication_failed", ts=NOW - 2 * DAY)))
        self.assertEqual((lane, row["label"], row["since"]), ("errored", "Signed out", NOW - 2 * DAY))

    def test_not_live_api_error_7_day_cap(self):
        lane, _, _ = one(rec_kw=dict(last_activity_at=NOW - 7 * DAY), live=False,
                         tail_=tail(api_error(ts=NOW - 7 * DAY)))
        self.assertEqual(lane, "errored")
        lane, _, _ = one(rec_kw=dict(last_activity_at=NOW - 7 * DAY - 1), live=False,
                         tail_=tail(api_error(ts=NOW - 7 * DAY - 1)))
        self.assertEqual(lane, "old")

    def test_not_live_rate_limited_is_not_errored_but_sets_banner(self):
        lane, _, b = one(live=False, tail_=tail(api_error("rate_limit", quota_status="rejected",
                                                          quota_resets_at=NOW + HOUR, quota_limit_type="five_hour")))
        self.assertEqual(lane, "recent")
        self.assertEqual(b["rateLimit"], {"resetsAt": NOW + HOUR, "limitType": "five_hour"})

    # Rule 11
    def test_error_at(self):
        lane, row, _ = one(rec_kw=dict(error_at=NOW - HOUR - 1000, last_activity_at=NOW - HOUR), live=False)
        self.assertEqual((lane, row["label"], row["since"]), ("errored", "Error", NOW - HOUR - 1000))

    def test_error_at_older_than_last_activity(self):
        lane, _, _ = one(rec_kw=dict(error_at=NOW - HOUR - 1001, last_activity_at=NOW - HOUR), live=False)
        self.assertEqual(lane, "recent")

    def test_error_at_7_day_cap(self):
        lane, _, _ = one(rec_kw=dict(error_at=NOW - 7 * DAY, last_activity_at=NOW - 7 * DAY), live=False)
        self.assertEqual(lane, "errored")
        lane, _, _ = one(rec_kw=dict(error_at=NOW - 8 * DAY, last_activity_at=NOW - 8 * DAY), live=False)
        self.assertEqual(lane, "old")

    def test_error_at_beats_stopped(self):
        lane, _, _ = one(rec_kw=dict(error_at=NOW - HOUR), live=False, tail_=tail(prompt()))
        self.assertEqual(lane, "errored")

    # Rule 14
    def test_stopped_mid_turn(self):
        for t in (tail(prompt(ts=NOW - 3 * HOUR)), tail(prompt(ts=NOW - 4 * HOUR), use("a", "Bash", ts=NOW - 3 * HOUR))):
            with self.subTest():
                lane, row, _ = one(rec_kw=dict(last_activity_at=NOW - 3 * HOUR), live=False, tail_=t)
                self.assertEqual((lane, row["label"], row["since"]), ("stopped", "Stopped mid-turn", NOW - 3 * HOUR))

    def test_stopped_7_day_cap(self):
        lane, _, _ = one(rec_kw=dict(last_activity_at=NOW - 8 * DAY), live=False, tail_=tail(prompt(ts=NOW - 8 * DAY)))
        self.assertEqual(lane, "old")

    def test_retrying_not_live_is_not_stopped(self):
        lane, _, _ = one(live=False, tail_=tail(prompt(), system("api_error", retry_attempt=1, max_retries=9)))
        self.assertEqual(lane, "recent")

    def test_api_error_beats_open_pr_and_open_pr_beats_stopped(self):
        prs = (PullRequest(7, "OPEN", "https://github.com/o/r/pull/7"),)
        self.assertEqual(one(rec_kw=dict(prs=prs), live=False, tail_=tail(api_error()))[0], "errored")
        self.assertEqual(one(rec_kw=dict(prs=prs), live=False, tail_=tail(prompt()))[0], "open_pr")
        self.assertEqual(one(rec_kw=dict(prs=prs), live=False, tail_=tail(use("a", "Bash")))[0], "open_pr")

    # Rule 12
    def test_open_pr(self):
        prs = (PullRequest(5, "MERGED", "https://github.com/o/r/pull/5"),
               PullRequest(9, "OPEN", "https://github.com/o/r/pull/9"))
        lane, row, _ = one(rec_kw=dict(prs=prs, last_activity_at=NOW - 2 * HOUR), live=False,
                           tail_=tail(text(ts=NOW - 2 * HOUR)))
        self.assertEqual((lane, row["label"], row["since"]), ("open_pr", "PR open", NOW - 2 * HOUR))
        self.assertEqual(row["pr"], {"number": 9, "state": "OPEN", "url": "https://github.com/o/r/pull/9",
                                     "verified": False, "mergedAt": None})

    def test_open_pr_has_no_7_day_cap_but_is_unverified(self):
        prs = (PullRequest(9, "OPEN", "https://github.com/o/r/pull/9"),)
        lane, row, _ = one(rec_kw=dict(prs=prs, last_activity_at=NOW - 40 * DAY), live=False)
        self.assertEqual((lane, row["pr"]["verified"]), ("open_pr", False))

    def test_dismissed_newest_pr_is_skipped(self):
        prs = (PullRequest(3, "OPEN", "https://github.com/o/r/pull/3"),
               PullRequest(4, "MERGED", "https://github.com/o/r/pull/4", dismissed=True))
        lane, row, _ = one(rec_kw=dict(prs=prs), live=False)
        self.assertEqual((lane, row["pr"]["number"]), ("open_pr", 3))

    def test_an_older_open_pr_still_holds_the_harbour(self):
        prs = (PullRequest(3, "OPEN", None), PullRequest(4, "MERGED", None))
        lane, row, _ = one(rec_kw=dict(prs=prs), live=False)
        self.assertEqual((lane, row["pr"]["number"], row["pr"]["state"]), ("open_pr", 3, "OPEN"))

    # Rule 14a
    def test_a_closed_pr_is_jailed(self):
        lane, row, b = one(rec_kw=dict(prs=(PullRequest(1, "CLOSED", None),)), live=False)
        self.assertEqual((lane, row["label"], row["pr"]["state"]), ("jail", "PR closed", "CLOSED"))
        lane, row, _ = one(rec_kw=dict(prs=(PullRequest(1, "CLOSED", None),), last_activity_at=NOW - 10 * DAY),
                           live=False)
        self.assertEqual((lane, row["since"], row["lastActivityAt"]), ("jail", NOW - 10 * DAY, NOW - 10 * DAY))
        self.assertNotIn("done", b["counts"])
        self.assertNotIn("archived", b["counts"])

    def test_dismissed_open_pr_does_not_hide_an_older_merge(self):
        prs = (PullRequest(1, "MERGED", None), PullRequest(2, "OPEN", None, dismissed=True))
        lane, row, _ = one(rec_kw=dict(prs=prs), live=False)
        self.assertEqual((lane, row["pr"]["number"]), ("valhalla", 1))

    def test_unknown_pr_state_has_no_lane_of_its_own(self):
        lane, row, _ = one(rec_kw=dict(prs=(PullRequest(1, "DRAFT", None),)), live=False)
        self.assertEqual((lane, row["pr"]["state"]), ("recent", "DRAFT"))

    def test_all_prs_dismissed_means_no_effective_pr(self):
        prs = (PullRequest(1, "MERGED", None, dismissed=True), PullRequest(2, "CLOSED", None, dismissed=True))
        for last, expected in ((NOW - HOUR, "recent"), (NOW - 100 * DAY, "graveyard")):
            with self.subTest(last=last):
                lane, row, _ = one(rec_kw=dict(prs=prs, last_activity_at=last), live=False)
                self.assertEqual((lane, row["pr"]), (expected, None))

    def test_dismissed_open_pr_alone_is_not_open_pr(self):
        lane, row, _ = one(rec_kw=dict(prs=(PullRequest(1, "OPEN", None, dismissed=True),)), live=False)
        self.assertEqual((lane, row["pr"]), ("recent", None))

    def test_an_older_open_pr_holds_a_newer_merge_in_the_harbour(self):
        prs = (PullRequest(1, "OPEN", None), PullRequest(2, "MERGED", None, dismissed=True),
               PullRequest(3, "MERGED", None))
        lane, row, _ = one(rec_kw=dict(prs=prs), live=False)
        self.assertEqual((lane, row["pr"]["number"]), ("open_pr", 1))
        prs = (PullRequest(1, "OPEN", None, dismissed=True), PullRequest(3, "MERGED", None))
        self.assertEqual(one(rec_kw=dict(prs=prs), live=False)[0], "valhalla")

    # Rules 15, 16 and 17
    def test_recent_and_old(self):
        lane, row, _ = one(rec_kw=dict(last_activity_at=NOW - 3 * DAY), live=False, tail_=tail(text(ts=NOW - 3 * DAY)))
        self.assertEqual((lane, row["label"], row["since"]), ("recent", "Recent", NOW - 3 * DAY))
        lane, row, b = one(rec_kw=dict(last_activity_at=NOW - 7 * DAY - 1), live=False,
                           tail_=tail(text(ts=NOW - 7 * DAY - 1)))
        self.assertEqual((lane, row, b["counts"]["old"]), ("old", None, 1))

    def test_unread_only_in_recent(self):
        _, row, _ = one(rec_kw=dict(last_activity_at=NOW - HOUR, last_focused_at=NOW - HOUR - 120_001), live=False)
        self.assertTrue(row["unread"])
        _, row, _ = one(rec_kw=dict(last_activity_at=NOW - HOUR, last_focused_at=NOW - HOUR - 120_000), live=False)
        self.assertFalse(row["unread"])
        _, row, _ = one(rec_kw=dict(last_focused_at=None), live=False)
        self.assertTrue(row["unread"])
        _, row, _ = one(rec_kw=dict(last_focused_at=None), live=False, tail_=tail(prompt()))
        self.assertEqual((row["lane"], row["unread"]), ("stopped", False))
        _, row, _ = one(rec_kw=dict(last_focused_at=None), tail_=tail(text()))
        self.assertEqual((row["lane"], row["unread"]), ("your_turn", False))
        _, row, _ = one(rec_kw=dict(last_focused_at=None, prs=pr9("OPEN")), live=False)
        self.assertEqual((row["lane"], row["unread"]), ("open_pr", False))


class EffectiveLastActivityTests(unittest.TestCase):
    """lastActivityAt on a desktop record can lag the transcript and an app quit by days."""

    def test_app_quit_mid_turn_after_a_stale_record_is_stopped(self):
        rec_kw = dict(last_activity_at=NOW - 8 * DAY, last_focused_at=NOW - 8 * DAY,
                      interrupted_by_quit_at=NOW - 5 * DAY)
        t = tail(text(ts=NOW - 8 * DAY), prompt(ts=NOW - 5 * DAY - 10), prompt(ts=NOW - 5 * DAY))
        lane, row, _ = one(rec_kw=rec_kw, live=False, tail_=t)
        self.assertEqual((lane, row["label"], row["since"], row["lastActivityAt"]),
                         ("stopped", "Stopped mid-turn", NOW - 5 * DAY, NOW - 5 * DAY))

    def test_quit_time_alone_moves_last_activity(self):
        lane, row, _ = one(rec_kw=dict(last_activity_at=NOW - 8 * DAY, interrupted_by_quit_at=NOW - 2 * DAY),
                           live=False)
        self.assertEqual((lane, row["lastActivityAt"], row["unread"]), ("recent", NOW - 2 * DAY, True))

    def test_later_transcript_turn_is_your_turn_and_unread(self):
        activity = NOW - 429 * MIN
        rec_kw = dict(last_activity_at=activity, last_focused_at=activity - 60 * SEC)
        t = tail(prompt(ts=NOW - 80 * MIN), text(ts=NOW - 74 * MIN))
        self.assertEqual(one(rec_kw=rec_kw, tail_=tail(text(ts=activity)))[0], "idle")
        lane, row, _ = one(rec_kw=rec_kw, tail_=t, entry_kw=dict(started_at=NOW - 8 * HOUR))
        self.assertEqual((lane, row["lastActivityAt"]), ("your_turn", NOW - 74 * MIN))
        lane, row, _ = one(rec_kw=rec_kw, tail_=t, live=False)
        self.assertEqual((lane, row["unread"], row["pr"]), ("recent", True, None))

    def test_d7_and_d30_use_it(self):
        lane, row, _ = one(rec_kw=dict(last_activity_at=NOW - 40 * DAY), live=False, tail_=tail(text(ts=NOW - DAY)))
        self.assertEqual((lane, row["lastActivityAt"], row["restReason"]), ("recent", NOW - DAY, None))
        lane, _, _ = one(rec_kw=dict(last_activity_at=NOW - 40 * DAY), live=False,
                         tail_=tail(text(ts=NOW - 20 * DAY)))
        self.assertEqual(lane, "old")
        lane, row, _ = one(rec_kw=dict(last_activity_at=NOW - 40 * DAY, interrupted_by_quit_at=NOW - 10 * DAY),
                           live=False)
        self.assertEqual((lane, row), ("old", None))

    def test_island_fallback_uses_it(self):
        prs = (PullRequest(9, "MERGED", "https://github.com/o/r/pull/9"),)
        lane, row, _ = one(rec_kw=dict(prs=prs, last_activity_at=NOW - 40 * DAY), live=False,
                           tail_=tail(text(ts=NOW - DAY)))
        self.assertEqual((lane, row["since"], row["pr"]["mergedAt"], row["pr"]["verified"]),
                         ("valhalla", NOW - DAY, None, False))

    def test_older_or_future_transcript_times(self):
        _, row, _ = one(rec_kw=dict(last_activity_at=NOW - HOUR), live=False, tail_=tail(text(ts=NOW - 2 * HOUR)))
        self.assertEqual(row["lastActivityAt"], NOW - HOUR)
        _, row, _ = one(rec_kw=dict(last_activity_at=NOW - HOUR), live=False, tail_=tail(text(ts=NOW + DAY)))
        self.assertEqual(row["lastActivityAt"], NOW)
        _, row, _ = one(rec_kw=dict(last_activity_at=NOW - HOUR), live=False,
                        tail_=tail(text(ts=NOW - HOUR), prompt(ts=NOW - MIN, is_meta=True),
                                   prompt(ts=NOW - MIN, is_sidechain=True)))
        self.assertEqual(row["lastActivityAt"], NOW - HOUR)

    def test_error_at_still_compares_with_the_record_time(self):
        lane, row, _ = one(rec_kw=dict(error_at=NOW - HOUR, last_activity_at=NOW - HOUR), live=False,
                           tail_=tail(text(ts=NOW - HOUR + 5 * SEC)))
        self.assertEqual((lane, row["since"], row["lastActivityAt"]), ("errored", NOW - HOUR, NOW - HOUR + 5 * SEC))


class CliRowTests(unittest.TestCase):
    def test_live_cli_rows_need_input_too(self):
        lane, row, _ = one_cli(entry_kw=dict(status_updated_at=NOW - 5 * MIN), tail_=tail(prompt(), text()))
        self.assertEqual((lane, row["label"], row["since"], row["unread"]), ("your_turn", "Needs input", NOW - 5 * MIN,
                                                                             False))
        # With no transcript the file time is all there is.
        self.assertEqual(one_cli(cli_kw=dict(last_activity_at=NOW - HOUR))[0], "your_turn")
        self.assertEqual(one_cli(cli_kw=dict(last_activity_at=NOW - 2 * HOUR - 1))[0], "idle")

    def test_cli_needs_input_is_timed_from_the_record_not_the_file_time(self):
        # Writing a title, a mode or a pr-link moves the mtime; the turn ended 3 hours ago.
        lane, row, _ = one_cli(cli_kw=dict(last_activity_at=NOW - MIN), entry_kw=dict(status_updated_at=NOW - 3 * HOUR),
                               tail_=tail(prompt(ts=NOW - 3 * HOUR - MIN), text(ts=NOW - 3 * HOUR)))
        self.assertEqual((lane, row["label"]), ("idle", "Idle"))

    def test_same_table_otherwise(self):
        self.assertEqual(one_cli(entry_kw=dict(status="waiting", waiting_for="permission prompt"))[1]["label"],
                         "Approve")
        self.assertEqual(one_cli(tail_=tail(use("q", "AskUserQuestion")))[1]["label"], "Answer")
        self.assertEqual(one_cli(tail_=tail(api_error("server_error")))[0], "errored")
        self.assertEqual(one_cli(entry_kw=dict(status="busy"))[0], "running")
        self.assertEqual(one_cli(live=False, tail_=tail(api_error()))[0], "errored")
        self.assertEqual(one_cli(live=False, tail_=tail(prompt()))[0], "stopped")
        # No archive for a terminal session: once ended it rests in the graveyard, however recent.
        self.assertEqual(one_cli(live=False)[0], "graveyard")
        self.assertEqual(one_cli(cli_kw=dict(last_activity_at=NOW - 9 * DAY), live=False)[0], "graveyard")

    def test_an_ended_session_rests_in_the_graveyard(self):
        for age in (HOUR, 9 * DAY, 30 * DAY, 30 * DAY + 1):
            with self.subTest(age=age):
                lane, row, b = one_cli(cli_kw=dict(last_activity_at=NOW - age), live=False)
                self.assertEqual((lane, row["label"], row["since"], row["restReason"], row["pr"]),
                                 ("graveyard", "Ended", NOW - age, "ended", None))
                self.assertEqual((b["counts"]["graveyard"], b["counts"]["old"], b["counts"]["recent"]), (1, 0, 0))
        for t in (tail(prompt(ts=NOW - 31 * DAY)), tail(api_error(ts=NOW - 31 * DAY))):
            with self.subTest():
                self.assertEqual(one_cli(cli_kw=dict(last_activity_at=NOW - 31 * DAY), live=False, tail_=t)[0],
                                 "graveyard")

    def test_live_cli_row_is_never_on_the_island_or_in_the_graveyard(self):
        for status, expected in (("idle", "idle"), ("busy", "running")):
            with self.subTest(status=status):
                lane, row, _ = one_cli(cli_kw=dict(last_activity_at=NOW - 90 * DAY),
                                       entry_kw=dict(status=status), tail_=tail(text(ts=NOW - 90 * DAY)))
                self.assertEqual((lane, row["restReason"]), (expected, None))

    def test_tool_hint_without_permission_mode(self):
        _, row, _ = one_cli(entry_kw=dict(status="busy"), tail_=tail(use("a", "Bash", ts=NOW - 4 * MIN)))
        self.assertEqual(row["hints"], ["tool running 4 min"])

    def test_cli_row_fields(self):
        c = cli(1, cwd="/Users/t/code/repo-b/.claude/worktrees/feat-x/sub", cwd_exists=True)
        b = bd.build_board(snap((), (), [c]), NOW)
        row = b["sessions"][0]
        self.assertEqual(row["id"], f"cli:{c.session_id}")
        self.assertEqual((row["kind"], row["title"], row["pr"], row["unread"], row["live"]),
                         ("cli", None, None, False, False))
        self.assertEqual((row["repo"], row["worktree"], row["shortId"]), ("repo-b", "feat-x", c.session_id[:8]))
        self.assertEqual((row["branch"], row["model"], row["effort"]), (None, None, None))
        self.assertEqual((row["surface"], row["canOpen"], row["canCopyResume"]), ("terminal", False, True))
        row = bd.build_board(snap((), (), [cli(1, cwd="/Users/t/x/plain/", cwd_exists=False)]), NOW)["sessions"][0]
        self.assertEqual((row["repo"], row["worktree"], row["canCopyResume"]), ("plain", None, False))

    def test_cli_row_duplicating_a_desktop_session_is_skipped(self):
        d = desktop(1)
        c = cli(1, session_id=d.cli_session_id)
        b = bd.build_board(snap([d], (), [c]), NOW)
        self.assertEqual([r["kind"] for r in b["sessions"]], ["desktop"])

    def test_vscode_row_opens_in_vscode(self):
        row = bd.build_board(snap((), (), [cli(1, entrypoint="claude-vscode")]), NOW)["sessions"][0]
        self.assertEqual((row["kind"], row["surface"], row["canOpen"], row["canCopyResume"]),
                         ("cli", "vscode", True, True))
        self.assertEqual((row["title"], row["id"]), (None, f"cli:{uid(2001)}"))

    def test_vscode_row_whose_folder_is_gone_cannot_open(self):
        c = cli(1, entrypoint="claude-vscode", cwd_exists=False)
        row = bd.build_board(snap((), (), [c]), NOW)["sessions"][0]
        self.assertEqual((row["surface"], row["canOpen"], row["canCopyResume"]), ("vscode", False, False))

    def test_vscode_row_needs_a_uuid_to_open(self):
        c = cli(1, session_id="not-a-uuid", entrypoint="claude-vscode")
        row = bd.build_board(snap((), (), [c]), NOW)["sessions"][0]
        self.assertEqual((row["surface"], row["canOpen"]), ("vscode", False))

    def test_other_entrypoints_are_terminal(self):
        for entrypoint in ("cli", "sdk-ts", "sdk-cli", None, "claude-vscode2", "Claude-VSCode"):
            with self.subTest(entrypoint=entrypoint):
                row = bd.build_board(snap((), (), [cli(1, entrypoint=entrypoint)]), NOW)["sessions"][0]
                self.assertEqual((row["surface"], row["canOpen"]), ("terminal", False))

    def test_live_registry_names_where_the_session_runs_now(self):
        cases = (("claude-vscode", "cli", "terminal"), ("cli", "claude-vscode", "vscode"),
                 ("claude-vscode", None, "vscode"), ("cli", None, "terminal"))
        for started, running, surface in cases:
            with self.subTest(started=started, running=running):
                c = cli(1, entrypoint=started)
                b = bd.build_board(snap((), [entry(c.session_id, entrypoint=running)], [c]), NOW)
                row = b["sessions"][0]
                self.assertTrue(row["live"])
                self.assertEqual(row["surface"], surface)

    def test_vscode_session_opens_open_or_closed_but_resumes_only_closed(self):
        # A click brings its VS Code window forward either way. A resume command would start a second copy of a
        # session still open in VS Code, so a live one has none.
        c = cli(1, entrypoint="claude-vscode")
        live = bd.build_board(snap((), [entry(c.session_id, entrypoint="claude-vscode")], [c]), NOW)["sessions"][0]
        self.assertEqual((live["live"], live["canOpen"], live["canCopyResume"]), (True, True, False))
        shut = bd.build_board(snap((), (), [c]), NOW)["sessions"][0]
        self.assertEqual((shut["live"], shut["canOpen"], shut["canCopyResume"]), (False, True, True))
        # Nor does a live terminal session: its resume command would start a second copy too.
        t = cli(2)
        row = bd.build_board(snap((), [entry(t.session_id, entrypoint="cli")], [t]), NOW)["sessions"][0]
        self.assertEqual((row["live"], row["canOpen"], row["canCopyResume"]), (True, False, False))

    def vscode_live(self, tail_, background=None, **entry_kw):
        """A live VS Code session registered the way the extension does it: no status, no waitingFor."""
        c = cli(1, entrypoint="claude-vscode")
        kw = dict(entrypoint="claude-vscode", status=None, status_updated_at=None)
        kw.update(entry_kw)
        extra = {"background": {c.session_id: background}} if background is not None else {}
        b = bd.build_board(snap((), [entry(c.session_id, **kw)], [c], {c.session_id: tail_}, **extra), NOW)
        return b["sessions"][0], b

    def test_vscode_permission_prompt_is_inferred(self):
        cases = (
            # (tool, pending for, marked shells under the session, lane, label)
            ("Bash", 20 * SEC, 0, "needs_you", "Approve"),
            ("Bash", 20 * SEC, 1, "running", "Running"),
            ("Bash", 10 * SEC, 0, "running", "Running"),
            ("Edit", 20 * SEC, 0, "needs_you", "Approve"),
            ("Write", 4 * MIN, 1, "needs_you", "Approve"),
            ("Edit", 5 * SEC, 0, "running", "Running"),
            ("Read", 20 * SEC, 0, "running", "Running"),
            ("mcp__x__y", 4 * MIN, 0, "running", "Running"),
        )
        for tool, age, shells, lane, label in cases:
            with self.subTest(tool=tool, age=age, shells=shells):
                row, b = self.vscode_live(tail(use("a", tool, ts=NOW - age)), background=bg(shells=shells))
                self.assertEqual((row["lane"], row["label"]), (lane, label))
                if lane == "needs_you":
                    self.assertEqual((row["since"], b["alert"]), (NOW - age, 1))

    def test_no_shell_count_never_reads_as_waiting(self):
        row, _ = self.vscode_live(tail(use("a", "Bash", ts=NOW - 4 * MIN)))
        self.assertEqual((row["lane"], row["hints"]), ("running", ["tool running 4 min"]))

    def test_approval_is_only_inferred_without_a_status(self):
        c = cli(1)
        b = bd.build_board(snap((), [entry(c.session_id, entrypoint="cli", status="busy")], [c],
                                {c.session_id: tail(use("a", "Bash", ts=NOW - 4 * MIN))},
                                background={c.session_id: bg()}), NOW)
        self.assertEqual(b["sessions"][0]["lane"], "running")

    def test_cli_row_title_comes_from_its_tail(self):
        for title in ("Launcher tidy-up", '<img src=x onerror=alert(1)>', None):
            with self.subTest(title=title):
                c = cli(1)
                row = bd.build_board(snap((), (), [c], {c.session_id: tail(text(), title=title)}), NOW)["sessions"][0]
                self.assertEqual(row["title"], title)
        # A desktop session keeps the app's own title.
        d = desktop(1, title="From the app")
        b = bd.build_board(snap([d], (), (), {d.cli_session_id: tail(text(), title="From the transcript")}), NOW)
        self.assertEqual(b["sessions"][0]["title"], "From the app")

    def test_vscode_session_without_a_status_reads_its_lane_from_the_tail(self):
        cases = (
            (tail(prompt(ts=NOW - 5 * MIN), text()), "your_turn", "Needs input", []),
            (tail(prompt()), "running", "Running", []),
            (tail(use("a", "Bash", ts=NOW - 4 * MIN)), "running", "Running", ["tool running 4 min"]),
            (tail(use("a", "AskUserQuestion", ts=NOW - 4 * MIN)), "needs_you", "Answer", []),
            (tail(use("a", "ExitPlanMode")), "needs_you", "Review plan", []),
            (tail(api_error()), "errored", "API error", []),
        )
        for tail_, lane, label, hints in cases:
            with self.subTest(lane=lane, label=label):
                row, b = self.vscode_live(tail_)
                self.assertEqual((row["lane"], row["label"], row["hints"]), (lane, label, hints))
                self.assertEqual(b["health"]["registry"]["unknownStatuses"], [])
                self.assertTrue(b["health"]["ok"])

    def test_vscode_session_with_a_status_uses_it(self):
        row, _ = self.vscode_live(tail(text()), status="waiting", waiting_for="permission prompt")
        self.assertEqual((row["lane"], row["label"]), ("needs_you", "Approve"))

    def test_terminal_session_without_a_status_still_asks_for_a_check(self):
        c = cli(1, entrypoint="cli")
        b = bd.build_board(snap((), [entry(c.session_id, entrypoint="cli", status=None)], [c],
                                {c.session_id: tail(text())}), NOW)
        self.assertEqual((b["sessions"][0]["lane"], b["sessions"][0]["label"]), ("needs_you", "Check status"))
        self.assertEqual(b["health"]["registry"]["unknownStatuses"], ["(missing)"])
        self.assertFalse(b["health"]["ok"])

    def test_a_session_running_under_vscode_is_a_vscode_session(self):
        # `claude` in VS Code's own terminal: entrypoint "cli", a status like any terminal, VS Code among its ancestors.
        c = cli(1, entrypoint="cli")
        e = entry(c.session_id, entrypoint="cli", status="waiting", waiting_for="permission prompt")
        b = bd.build_board(snap((), [e], [c], editor_hosted={c.session_id: "vscode"}), NOW)
        row = b["sessions"][0]
        self.assertEqual((row["surface"], row["editor"], row["lane"], row["label"], row["canOpen"],
                          row["canCopyResume"]), ("vscode", "vscode", "needs_you", "Approve", True, False))
        # Once it has closed, nothing ties it to VS Code: a terminal session with its resume command.
        row = bd.build_board(snap((), (), [c], editor_hosted={c.session_id: "vscode"},
                                  editors_seen={c.session_id: "vscode"}), NOW)["sessions"][0]
        self.assertEqual((row["surface"], row["editor"], row["canOpen"], row["canCopyResume"]),
                         ("terminal", None, False, True))

    def test_a_session_names_the_editor_it_runs_in(self):
        c = cli(1, entrypoint="cli")
        e = entry(c.session_id, entrypoint="cli")
        for key in ("vscode", "vscode-insiders", "cursor"):
            with self.subTest(editor=key):
                row = bd.build_board(snap((), [e], [c], editor_hosted={c.session_id: key}), NOW)["sessions"][0]
                self.assertEqual((row["surface"], row["editor"]), ("vscode", key))

    def test_an_ended_chat_opens_where_it_was_seen_else_in_the_editor_installed(self):
        chat = cli(1, entrypoint="claude-vscode")
        cases = [
            (dict(editors_seen={chat.session_id: "cursor"}, default_editor="vscode"), "cursor"),
            (dict(default_editor="vscode-insiders"), "vscode-insiders"),
            (dict(editors_seen={cli(2).session_id: "cursor"}), "vscode"),
            (dict(), "vscode"),
        ]
        for kw, expected in cases:
            with self.subTest(**{k: str(v) for k, v in kw.items()}):
                row = bd.build_board(snap((), (), [chat], **kw), NOW)["sessions"][0]
                self.assertEqual((row["surface"], row["live"], row["editor"]), ("vscode", False, expected))

    def test_the_editor_it_runs_in_now_beats_the_one_it_was_seen_in(self):
        chat = cli(1, entrypoint="claude-vscode")
        e = entry(chat.session_id, entrypoint="claude-vscode", status=None)
        raw = snap((), [e], [chat], editor_hosted={chat.session_id: "vscode-insiders"},
                   editors_seen={chat.session_id: "cursor"}, default_editor="vscode")
        self.assertEqual(bd.build_board(raw, NOW)["sessions"][0]["editor"], "vscode-insiders")

    def test_resumed_in_a_terminal_after_an_editor_it_is_a_terminal_session(self):
        # Seen in Cursor's terminal earlier, now live in a plain terminal: where it runs now decides.
        c = cli(1, entrypoint="cli")
        e = entry(c.session_id, entrypoint="cli")
        row = bd.build_board(snap((), [e], [c], editors_seen={c.session_id: "cursor"}), NOW)["sessions"][0]
        self.assertEqual((row["surface"], row["editor"]), ("terminal", None))

    def test_desktop_and_terminal_rows_name_no_editor(self):
        raw = snap([desktop(1)], (), [cli(1, entrypoint="cli")], default_editor="cursor")
        self.assertEqual({(r["surface"], r["editor"]) for r in bd.build_board(raw, NOW)["sessions"]},
                         {("desktop", None), ("terminal", None)})

    def test_a_terminal_row_shows_the_folder_it_works_in_now(self):
        c = cli(1, cwd="/Users/t")
        moved = tail(text(), cwd="/Users/t/code/tokentown/.claude/worktrees/wt-a")
        row = bd.build_board(snap((), (), [c], {c.session_id: moved}), NOW)["sessions"][0]
        self.assertEqual((row["repo"], row["worktree"], row["canCopyResume"]), ("tokentown", "wt-a", True))
        # With no newer folder read, the one it started in.
        row = bd.build_board(snap((), (), [c], {c.session_id: tail(text())}), NOW)["sessions"][0]
        self.assertEqual((row["repo"], row["worktree"]), ("t", None))

    def test_desktop_rows_stay_desktop(self):
        d = desktop(1)
        b = bd.build_board(snap([d], [entry(d.cli_session_id, entrypoint="claude-vscode")]), NOW)
        row = b["sessions"][0]
        self.assertEqual((row["kind"], row["surface"], row["canOpen"]), ("desktop", "desktop", True))


def full_snapshot() -> RawSnapshot:
    ds = [
        desktop(1, title="<script>alert(1)</script>"),
        desktop(2), desktop(3), desktop(4), desktop(5, last_focused_at=NOW, last_activity_at=NOW - 3 * HOUR),
        desktop(6, prs=(PullRequest(8, "OPEN", "javascript:alert(1)"),)),
        desktop(7, is_archived=True), desktop(8, prs=(PullRequest(1, "MERGED", None),)),
        desktop(9, last_activity_at=NOW - 30 * DAY), desktop(10, cwd="/Users/t/code/repo-a/.claude/worktrees/wt-1"),
        desktop(11, last_activity_at=NOW - 20 * DAY, prs=(PullRequest(2, "MERGED", "https://github.com/o/r/pull/2"),)),
        desktop(12, prs=(PullRequest(3, "CLOSED", "https://github.com/o/r/pull/3"),)),
        desktop(13, last_activity_at=NOW - 2 * DAY),
    ]
    reg = [entry(ds[0].cli_session_id, status="waiting", waiting_for="input needed"),
           entry(ds[3].cli_session_id, status="busy"), entry(ds[4].cli_session_id),
           entry(ds[2].cli_session_id)]
    tails = {ds[1].cli_session_id: tail(api_error()), ds[2].cli_session_id: tail(text()),
             ds[9].cli_session_id: tail(prompt())}
    clis = [cli(1), cli(2, last_activity_at=NOW - 20 * DAY), cli(3, last_activity_at=NOW - 31 * DAY)]
    tokens = {ds[1].cli_session_id: tokens_for(output=5), clis[0].session_id: tokens_for(output=7, complete=False)}
    return snap(ds, reg, clis, tails, tokens=tokens, plan_usage=PlanUsage(40, 60, NOW - MIN))


def tokens_for(*, input=1, output=2, cache_read=3, cache_write=4, context=8, sub=(10, 20, 30, 40),
               complete=True) -> SessionTokens:
    return SessionTokens(
        main=TokenTotals(input=input, output=output, cache_read=cache_read, cache_write=cache_write, messages=2,
                         context=context),
        subagents=TokenTotals(input=sub[0], output=sub[1], cache_read=sub[2], cache_write=sub[3], messages=1),
        complete=complete)


class RowContractTests(unittest.TestCase):
    def full_board(self):
        return bd.build_board(full_snapshot(), NOW)

    def test_every_sent_lane_present(self):
        b = self.full_board()
        self.assertEqual({r["lane"] for r in b["sessions"]}, set(bd.LANE_ORDER))
        self.assertEqual(b["counts"], {"needs_you": 1, "errored": 1, "your_turn": 1, "running": 1, "stopped": 1,
                                       "idle": 1, "open_pr": 1, "recent": 1, "valhalla": 1, "castle": 1,
                                       "jail": 1, "graveyard": 4, "old": 1})
        self.assertEqual(b["alert"], 2)
        self.assertEqual(len(b["sessions"]), 15)

    def test_top_level_health_and_row_keys(self):
        b = self.full_board()
        self.assertEqual(set(b), {"v", "generatedAt", "alert", "counts", "rateLimit", "planUsage", "health",
                                  "sessions", "visitors", "reviews"})
        self.assertEqual((b["v"], b["generatedAt"]), (1, NOW))
        self.assertEqual(list(b["counts"]), list(bd.ALL_LANES))
        self.assertEqual(set(b["health"]), {"ok", "problems", "folders", "appVersion", "cliVersions", "desktop",
                                            "registry", "transcripts", "tokens", "waitingSeenNow", "scanMs",
                                            "warnings"})
        self.assertEqual(set(b["health"]["tokens"]), {"tracked", "complete"})
        self.assertEqual(set(b["health"]["desktop"]), {"records", "parseErrors"})
        self.assertEqual(set(b["health"]["registry"]), {"files", "live", "joined", "unknownStatuses"})
        self.assertEqual(set(b["health"]["transcripts"]), {"tailed", "missing", "unknownTypes"})
        self.assertEqual(len(bd.ROW_KEYS), 29)
        for row in b["sessions"]:
            with self.subTest(id=row["id"]):
                self.assertEqual(set(row), set(bd.ROW_KEYS))
                self.assertNotIn(row["lane"], bd.COUNT_ONLY_LANES)
                self.assertIn(row["kind"], ("desktop", "cli"))
                self.assertIn(row["surface"], ("desktop",) if row["kind"] == "desktop" else ("terminal", "vscode"))
                self.assertIsInstance(row["hints"], list)
                self.assertIsInstance(row["since"], int)
                self.assertIsInstance(row["lastActivityAt"], int)
                self.assertIsInstance(row["look"], int)
                for flag in ("live", "unread", "canOpen", "canCopyResume"):
                    self.assertIsInstance(row[flag], bool)
                if row["pr"] is not None:
                    self.assertEqual(set(row["pr"]), {"number", "state", "url", "verified", "mergedAt"})
                    self.assertIsInstance(row["pr"]["verified"], bool)
                if row["lane"] == "graveyard":
                    self.assertIn(row["restReason"], ("archived", "inactive", "ended"))
                else:
                    self.assertIsNone(row["restReason"])
                self.assertIsNone(row["doneAt"])
                self.assertEqual(row["valhallaReason"], "merged" if row["lane"] in bd.ISLAND_LANES else None)
                self.assertIsInstance(row["canMarkDone"], bool)
                self.assertEqual(row["canMarkDone"],
                                 row["lane"] not in bd.ISLAND_LANES
                                 and not (row["live"] and row["lane"] in ("needs_you", "errored", "running")))
                self.assertTrue(row["createdAt"] is None or isinstance(row["createdAt"], int))
                self.assertTrue(row["turns"] is None or isinstance(row["turns"], int))
                if row["tokens"] is not None:
                    self.assertEqual(set(row["tokens"]), {"input", "output", "cacheRead", "cacheWrite", "context",
                                                          "subagents", "complete"})
                    self.assertEqual(set(row["tokens"]["subagents"]), {"input", "output", "cacheRead", "cacheWrite"})

    def test_json_round_trip_and_purity(self):
        raw = full_snapshot()
        b1 = bd.build_board(raw, NOW)
        b2 = bd.build_board(raw, NOW)
        self.assertEqual(b1, b2)
        self.assertEqual(raw, full_snapshot())
        self.assertEqual(json.loads(json.dumps(b1)), b1)
        title_row = next(r for r in b1["sessions"] if r["id"] == f"local_{uid(1)}")
        self.assertEqual(title_row["title"], "<script>alert(1)</script>")

    def test_desktop_row_fields(self):
        b = self.full_board()
        rows = {r["id"]: r for r in b["sessions"]}
        r1 = rows[f"local_{uid(1)}"]
        self.assertEqual((r1["kind"], r1["shortId"], r1["repo"], r1["worktree"], r1["branch"], r1["model"],
                          r1["effort"], r1["live"], r1["canOpen"], r1["canCopyResume"]),
                         ("desktop", uid(1)[:8], "repo-a", None, "main", "opus", "high", True, True, False))
        self.assertEqual(rows[f"local_{uid(10)}"]["worktree"], "wt-1")
        self.assertEqual(rows[f"local_{uid(10)}"]["repo"], "repo-a")
        self.assertIsNone(rows[f"local_{uid(6)}"]["pr"]["url"])

    def test_can_open_requires_local_id(self):
        for sid in ("local_notauuid", f"local_{uid(1)}\n", f"LOCAL_{uid(1)}"):
            with self.subTest(sid=sid):
                b = bd.build_board(snap([desktop(1, session_id=sid)]), NOW)
                self.assertFalse(b["sessions"][0]["canOpen"])

    def test_look_is_stable_sha1_seed(self):
        rid = f"local_{uid(1)}"
        expected = int(hashlib.sha1(rid.encode()).hexdigest()[:8], 16)
        self.assertEqual(bd.look_for(rid), expected)
        self.assertEqual(bd.look_for("cli:" + uid(5)), int(hashlib.sha1(("cli:" + uid(5)).encode()).hexdigest()[:8], 16))
        self.assertEqual(bd.look_for("local_00000001-0000-4000-8000-000000000001"), 4144441267)
        b1 = bd.build_board(snap([desktop(1)]), NOW)
        b2 = bd.build_board(snap([desktop(1, title="renamed", last_activity_at=NOW - 2 * DAY)]), NOW + DAY)
        self.assertEqual(b1["sessions"][0]["look"], expected)
        self.assertEqual(b2["sessions"][0]["look"], expected)


class TokenAndUsageJsonTests(unittest.TestCase):
    def test_row_tokens_turns_and_created_at(self):
        ds = [desktop(1, completed_turns=12, created_at=NOW - 2 * DAY), desktop(2), desktop(3, cli_session_id=None)]
        clis = [cli(1)]
        tokens = {ds[0].cli_session_id: tokens_for(input=3_400_000, output=120_000, cache_read=3_100_000,
                                                   cache_write=9, context=182_000),
                  clis[0].session_id: tokens_for(context=None, sub=(0, 0, 0, 0), complete=False)}
        b = bd.build_board(snap(ds, (), clis, tokens=tokens), NOW)
        rows = {r["id"]: r for r in b["sessions"]}
        r1 = rows[ds[0].session_id]
        self.assertEqual((r1["createdAt"], r1["turns"]), (NOW - 2 * DAY, 12))
        self.assertEqual(r1["tokens"], {"input": 3_400_000, "output": 120_000, "cacheRead": 3_100_000,
                                        "cacheWrite": 9, "context": 182_000,
                                        "subagents": {"input": 10, "output": 20, "cacheRead": 30, "cacheWrite": 40},
                                        "complete": True})
        r2 = rows[ds[1].session_id]
        self.assertEqual((r2["createdAt"], r2["turns"], r2["tokens"]), (NOW - 3 * HOUR, None, None))
        self.assertIsNone(rows[ds[2].session_id]["tokens"])
        rc = rows[f"cli:{clis[0].session_id}"]
        self.assertEqual((rc["createdAt"], rc["turns"]), (None, None))
        self.assertEqual(rc["tokens"], {"input": 1, "output": 2, "cacheRead": 3, "cacheWrite": 4, "context": None,
                                        "subagents": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                                        "complete": False})
        self.assertEqual(b["health"]["tokens"], {"tracked": 2, "complete": 1})

    def test_tokens_for_a_session_not_on_the_board_still_count_in_health(self):
        tokens = {uid(4242): tokens_for(), uid(4243): tokens_for(complete=False)}
        b = bd.build_board(snap(tokens=tokens), NOW)
        self.assertEqual(b["health"]["tokens"], {"tracked": 2, "complete": 1})
        self.assertTrue(b["health"]["ok"])

    def test_plan_usage_ages(self):
        cases = [
            (None, None),
            (-2 * MIN, {"fiveHourPct": 40, "weeklyPct": 60, "stale": False}),
            (0, {"fiveHourPct": 40, "weeklyPct": 60, "stale": False}),
            (29 * MIN, {"fiveHourPct": 40, "weeklyPct": 60, "stale": False}),
            (30 * MIN, {"fiveHourPct": 40, "weeklyPct": 60, "stale": False}),
            (31 * MIN, {"fiveHourPct": 40, "weeklyPct": 60, "stale": True}),
            (5 * HOUR, {"fiveHourPct": 40, "weeklyPct": 60, "stale": True}),
            (5 * HOUR + 1, {"fiveHourPct": None, "weeklyPct": 60, "stale": True}),
            (7 * DAY, {"fiveHourPct": None, "weeklyPct": 60, "stale": True}),
            (8 * DAY, {"fiveHourPct": None, "weeklyPct": None, "stale": True}),
        ]
        for age, expected in cases:
            with self.subTest(age=age):
                usage = None if age is None else PlanUsage(40, 60, NOW - age)
                got = bd.build_board(snap(plan_usage=usage), NOW)["planUsage"]
                if expected is None:
                    self.assertIsNone(got)
                else:
                    self.assertEqual(got, {**expected, "sampledAt": NOW - age})

    def test_plan_usage_null_values_pass_through(self):
        got = bd.build_board(snap(plan_usage=PlanUsage(None, 7, NOW - MIN)), NOW)["planUsage"]
        self.assertEqual(got, {"fiveHourPct": None, "weeklyPct": 7, "sampledAt": NOW - MIN, "stale": False})


URL9 = "https://github.com/o/r/pull/9"


def pr9(state="OPEN", url=URL9, **kw):
    return (PullRequest(9, state, url, **kw),)


def gh(state="MERGED", merged_at=NOW - 2 * DAY, closed_at=None, checked_at=NOW - MIN):
    if state == "MERGED" and closed_at is None:
        closed_at = merged_at
    return GitHubPr(state, merged_at, closed_at, checked_at)


class GitHubStateTests(unittest.TestCase):
    """The effective PR state: GitHub's when it has one, else the Claude app's."""

    def test_github_overrides_stale_desktop_open(self):
        lane, row, b = one(rec_kw=dict(prs=pr9("OPEN"), last_activity_at=NOW - 3 * DAY), live=False,
                           github={URL9: gh("MERGED", merged_at=NOW - DAY)})
        self.assertEqual((lane, row["label"], row["since"]), ("valhalla", "Merged", NOW - DAY))
        self.assertEqual(row["pr"], {"number": 9, "state": "MERGED", "url": URL9, "verified": True,
                                     "mergedAt": NOW - DAY})
        self.assertEqual((b["counts"]["open_pr"], b["counts"]["valhalla"]), (0, 1))

    def test_open_verified_vs_unverified(self):
        for github, verified in ((None, False), ({}, False), ({URL9: gh("OPEN", merged_at=None)}, True)):
            with self.subTest(github=github):
                lane, row, _ = one(rec_kw=dict(prs=pr9("OPEN"), last_activity_at=NOW - 3 * DAY), live=False,
                                   github=github)
                self.assertEqual((lane, row["pr"]["state"], row["pr"]["verified"], row["pr"]["mergedAt"]),
                                 ("open_pr", "OPEN", verified, None))

    def test_github_wins_in_both_directions(self):
        lane, row, _ = one(rec_kw=dict(prs=pr9("MERGED")), live=False, github={URL9: gh("OPEN", merged_at=None)})
        self.assertEqual((lane, row["pr"]["state"], row["pr"]["verified"]), ("open_pr", "OPEN", True))

    def test_closed_on_github_leaves_the_harbour_for_the_jail(self):
        # The jail's D30 window is dated by the newer of the closure and the last activity, so the graveyard case
        # needs both to be old.
        for last, closed_at, expected in ((NOW - 3 * DAY, NOW - DAY, "jail"), (NOW - 10 * DAY, NOW - DAY, "jail"),
                                          (NOW - 31 * DAY, NOW - DAY, "jail"),
                                          (NOW - 31 * DAY, NOW - 31 * DAY, "graveyard")):
            closed = {URL9: gh("CLOSED", merged_at=None, closed_at=closed_at)}
            with self.subTest(last=last, closed_at=closed_at):
                lane, row, _ = one(rec_kw=dict(prs=pr9("OPEN"), last_activity_at=last), live=False, github=closed)
                self.assertEqual(lane, expected)
                if row is not None:
                    self.assertEqual((row["pr"]["state"], row["pr"]["verified"], row["pr"]["mergedAt"]),
                                     ("CLOSED", True, None))

    def test_desktop_merged_without_github_is_unverified(self):
        lane, row, _ = one(rec_kw=dict(prs=pr9("MERGED"), last_activity_at=NOW - 3 * DAY), live=False)
        self.assertEqual((lane, row["since"]), ("valhalla", NOW - 3 * DAY))
        self.assertEqual((row["pr"]["verified"], row["pr"]["mergedAt"]), (False, None))

    def test_lookup_only_by_the_effective_pr_valid_url(self):
        hostile = "javascript:alert(1)"
        cases = [
            # invalid url on disk: never looked up, even if a key happens to match
            (pr9("OPEN", url=hostile), {hostile: gh()}, "open_pr", False),
            (pr9("OPEN", url=None), {None: gh()}, "open_pr", False),
            # GitHub knows a different PR
            (pr9("OPEN"), {"https://github.com/o/r/pull/10": gh()}, "open_pr", False),
            # the dismissed newer PR's state never applies
            ((PullRequest(9, "OPEN", URL9), PullRequest(10, "OPEN", "https://github.com/o/r/pull/10", dismissed=True)),
             {"https://github.com/o/r/pull/10": gh()}, "open_pr", False),
            ((PullRequest(9, "OPEN", URL9), PullRequest(10, "OPEN", "https://github.com/o/r/pull/10", dismissed=True)),
             {URL9: gh()}, "valhalla", True),
        ]
        for i, (prs, github, lane_, verified) in enumerate(cases):
            with self.subTest(i=i):
                lane, row, _ = one(rec_kw=dict(prs=prs), live=False, github=github)
                self.assertEqual((lane, row["pr"]["number"], row["pr"]["verified"]), (lane_, 9, verified))

    def test_verified_number_is_the_one_github_was_asked_about(self):
        url7 = "https://github.com/o/r/pull/7"
        prs = (PullRequest(999, "OPEN", url7),)
        lane, row, _ = one(rec_kw=dict(prs=prs), live=False, github={url7: gh(merged_at=NOW - DAY)})
        self.assertEqual((lane, row["pr"]), ("valhalla", {"number": 7, "state": "MERGED", "url": url7,
                                                          "verified": True, "mergedAt": NOW - DAY}))
        lane, row, _ = one(rec_kw=dict(prs=prs), live=False)
        self.assertEqual((lane, row["pr"]["number"], row["pr"]["verified"]), ("open_pr", 999, False))

    def test_a_url_github_could_never_have_been_asked_about_is_unverified(self):
        for odd in ("https://github.com/o/r/pull/" + chr(0x661) + chr(0x662), "https://github.com/../r/pull/12",
                    "https://github.com/o/../pull/12", "https://github.com/o/r/pull/12345678901",
                    "https://github.com/o\u0301/r/pull/12"):
            with self.subTest(odd=odd):
                prs = (PullRequest(12, "OPEN", odd),)
                lane, row, _ = one(rec_kw=dict(prs=prs), live=False, github={odd: gh()})
                self.assertEqual((lane, row["pr"]["number"], row["pr"]["verified"]), ("open_pr", 12, False))
                self.assertIsNone(row["pr"]["url"])

    def test_github_without_merged_at_falls_back_to_last_activity(self):
        odd = {URL9: GitHubPr("MERGED", None, None, NOW)}
        lane, row, _ = one(rec_kw=dict(prs=pr9(), last_activity_at=NOW - 20 * DAY), live=False, github=odd)
        self.assertEqual((lane, row["since"], row["pr"]["verified"], row["pr"]["mergedAt"]),
                         ("castle", NOW - 20 * DAY, True, None))

    def test_github_dict_is_not_mutated_and_board_is_json(self):
        github = {URL9: gh(), "https://github.com/o/r/pull/77": gh("OPEN", merged_at=None)}
        before = dict(github)
        raw = snap([desktop(1, prs=pr9())])
        b1 = bd.build_board(raw, NOW, github)
        self.assertEqual(github, before)
        self.assertEqual(b1, bd.build_board(raw, NOW, github=github))
        self.assertEqual(json.loads(json.dumps(b1)), b1)

    def test_cli_rows_ignore_github(self):
        lane = one_cli(live=False)[0]
        c = cli(1)
        b = bd.build_board(snap((), (), [c]), NOW, {URL9: gh()})
        self.assertEqual((b["sessions"][0]["lane"], b["sessions"][0]["pr"]), (lane, None))


class IslandLaneTests(unittest.TestCase):
    """Rules 7 and 12: a merged PR sends a session to Valhalla (14 days) or the sand castle."""

    def test_live_busy_or_waiting_with_merge_keeps_its_live_lane(self):
        github = {URL9: gh()}
        cases = [
            (dict(status="busy"), None, "running"),
            (dict(status="shell"), None, "running"),
            (dict(status="waiting", waiting_for="permission prompt"), None, "needs_you"),
            (dict(status="compacting"), None, "needs_you"),
            (dict(status="idle"), tail(use("q", "AskUserQuestion")), "needs_you"),
            (dict(status="idle"), tail(api_error("server_error")), "errored"),
        ]
        for entry_kw, t, expected in cases:
            for gh_ in (None, github):
                with self.subTest(entry=entry_kw, github=gh_ is not None):
                    lane, row, _ = one(rec_kw=dict(prs=pr9("MERGED")), entry_kw=entry_kw, tail_=t, github=gh_)
                    self.assertEqual((lane, row["pr"]["state"]), (expected, "MERGED"))

    def test_live_idle_with_merge_goes_to_the_island_before_needs_input(self):
        needs_input = dict(rec_kw=dict(prs=pr9("OPEN"), last_focused_at=None), tail_=tail(text()))
        self.assertEqual(one(**needs_input)[0], "open_pr")
        lane, row, _ = one(**needs_input, github={URL9: gh(merged_at=NOW - 3 * HOUR)})
        self.assertEqual((lane, row["live"], row["since"], row["unread"], row["label"]),
                         ("valhalla", True, NOW - 3 * HOUR, False, "Merged"))
        lane, _, _ = one(rec_kw=dict(prs=pr9("MERGED"), last_focused_at=NOW), tail_=tail(text()))
        self.assertEqual(lane, "valhalla")
        lane, _, _ = one(rec_kw=dict(prs=pr9("OPEN"), last_focused_at=NOW),
                         github={URL9: gh(merged_at=NOW - 15 * DAY)})
        self.assertEqual(lane, "castle")

    def test_activity_after_the_merge_no_longer_holds_the_session(self):
        # (h) The old hold: a reply after the merge kept the row needing input, or stopped. It sails now.
        old_merge = {URL9: gh(merged_at=NOW - 40 * DAY)}
        base = dict(prs=pr9("OPEN"), last_activity_at=NOW - MIN, last_focused_at=NOW - HOUR)
        lane, row, _ = one(rec_kw=base, tail_=tail(prompt(ts=NOW - 2 * MIN), text(ts=NOW - MIN)), github=old_merge)
        self.assertEqual((lane, row["since"], row["pr"]["state"], row["pr"]["verified"], row["valhallaReason"]),
                         ("castle", NOW - 40 * DAY, "MERGED", True, "merged"))
        self.assertEqual(one(rec_kw=base, tail_=tail(text(ts=NOW - MIN)),
                             github={URL9: gh(merged_at=NOW - DAY)})[0], "valhalla")
        # Not live and stopped part-way after the merge, archived or not, recent or not.
        for kw, t in ((dict(), tail(prompt(ts=NOW - MIN))), (dict(), tail(use("a", "Bash", ts=NOW - MIN))),
                      (dict(is_archived=True), tail(prompt(ts=NOW - MIN))), (dict(), tail(text(ts=NOW - MIN))),
                      (dict(last_activity_at=NOW - 8 * DAY), tail(prompt(ts=NOW - 8 * DAY)))):
            with self.subTest(kw=kw):
                lane, row, _ = one(rec_kw=dict(base, **kw), live=False, tail_=t, github=old_merge)
                self.assertEqual((lane, row["pr"]["state"], row["since"]), ("castle", "MERGED", NOW - 40 * DAY))
        # Busy still wins.
        for entry_kw, expected in ((dict(status="busy"), "running"),
                                   (dict(status="waiting", waiting_for="permission prompt"), "needs_you")):
            with self.subTest(entry=entry_kw):
                self.assertEqual(one(rec_kw=base, entry_kw=entry_kw, tail_=tail(text(ts=NOW - MIN)),
                                     github=old_merge)[0], expected)

    def test_live_archived_idle_merged_is_on_the_island(self):
        lane, row, _ = one(rec_kw=dict(is_archived=True, prs=pr9("MERGED")))
        self.assertEqual((lane, row["restReason"]), ("valhalla", None))

    def test_archived_and_merged_is_on_the_island(self):
        for last, merged_at, expected in ((NOW - HOUR, NOW - DAY, "valhalla"), (NOW - 90 * DAY, NOW - 80 * DAY, "castle"),
                                          (NOW - 90 * DAY, NOW - 2 * DAY, "valhalla")):
            with self.subTest(last=last):
                lane, row, b = one(rec_kw=dict(is_archived=True, prs=pr9("OPEN"), last_activity_at=last), live=False,
                                   github={URL9: gh(merged_at=merged_at)})
                self.assertEqual((lane, row["restReason"]), (expected, None))
                self.assertEqual(b["counts"]["graveyard"], 0)

    def test_old_merge_is_on_the_island_not_old_or_graveyard(self):
        for last in (NOW - 15 * DAY, NOW - 200 * DAY):
            with self.subTest(last=last):
                lane, row, b = one(rec_kw=dict(prs=pr9("MERGED"), last_activity_at=last), live=False)
                self.assertEqual((lane, b["counts"]["old"], b["counts"]["graveyard"]), ("castle", 0, 0))
                self.assertEqual(row["since"], last)

    def test_recent_error_beats_merge_unless_archived(self):
        t = tail(api_error("server_error", ts=NOW - HOUR))
        self.assertEqual(one(rec_kw=dict(prs=pr9("MERGED")), live=False, tail_=t)[0], "errored")
        self.assertEqual(one(rec_kw=dict(prs=pr9("MERGED"), error_at=NOW - HOUR), live=False)[0], "errored")
        self.assertEqual(one(rec_kw=dict(prs=pr9("MERGED"), is_archived=True), live=False, tail_=t)[0], "valhalla")
        self.assertEqual(one(rec_kw=dict(prs=pr9("MERGED"), is_archived=True, error_at=NOW - HOUR), live=False)[0],
                         "valhalla")

    def test_open_pr_then_merge_beat_stopped(self):
        self.assertEqual(one(rec_kw=dict(prs=pr9("MERGED")), live=False, tail_=tail(prompt()))[0], "valhalla")
        self.assertEqual(one(rec_kw=dict(prs=pr9("OPEN")), live=False, tail_=tail(prompt()))[0], "open_pr")

    def test_14_day_boundary_on_github_merge_time(self):
        for merged_at, expected in ((NOW - 14 * DAY, "valhalla"), (NOW - 14 * DAY - 1, "castle"),
                                    (NOW + MIN, "valhalla")):
            with self.subTest(merged_at=merged_at):
                lane, row, _ = one(rec_kw=dict(prs=pr9("OPEN"), last_activity_at=NOW - HOUR), live=False,
                                   github={URL9: gh(merged_at=merged_at)})
                self.assertEqual((lane, row["since"], row["pr"]["mergedAt"]), (expected, merged_at, merged_at))

    def test_14_day_boundary_on_last_activity_when_unverified(self):
        for last, expected in ((NOW - 14 * DAY, "valhalla"), (NOW - 14 * DAY - 1, "castle")):
            with self.subTest(last=last):
                lane, row, _ = one(rec_kw=dict(prs=pr9("MERGED"), last_activity_at=last), live=False)
                self.assertEqual((lane, row["label"], row["since"]), (expected, "Merged", last))

    def test_github_merge_time_wins_over_last_activity(self):
        lane, _, _ = one(rec_kw=dict(prs=pr9("MERGED"), last_activity_at=NOW - HOUR), live=False,
                         github={URL9: gh(merged_at=NOW - 20 * DAY)})
        self.assertEqual(lane, "castle")
        lane, _, _ = one(rec_kw=dict(prs=pr9("MERGED"), last_activity_at=NOW - 60 * DAY), live=False,
                         github={URL9: gh(merged_at=NOW - 3 * DAY)})
        self.assertEqual(lane, "valhalla")


class GraveyardLaneTests(unittest.TestCase):
    """Rules 13 and 17: archived, or no activity for more than 30 days."""

    def test_archived_ignores_age_stopped_and_a_closed_pr(self):
        cases = [dict(last_activity_at=NOW - 400 * DAY), dict(prs=pr9("CLOSED")), dict(prs=pr9("DRAFT")), {}]
        for kw in cases:
            with self.subTest(kw=kw):
                lane, row, _ = one(rec_kw=dict(is_archived=True, **kw), live=False, tail_=tail(prompt()))
                self.assertEqual((lane, row["label"], row["restReason"]), ("graveyard", "Archived", "archived"))

    def test_archived_with_an_open_pr_waits_in_the_harbour(self):
        # (g)
        for kw in (dict(prs=pr9("OPEN")), dict(prs=pr9("OPEN"), last_activity_at=NOW - 400 * DAY)):
            with self.subTest(kw=kw):
                lane, row, b = one(rec_kw=dict(is_archived=True, **kw), live=False, tail_=tail(prompt()))
                self.assertEqual((lane, row["label"], row["restReason"], row["canMarkDone"]),
                                 ("open_pr", "PR open", None, True))
                self.assertEqual(b["counts"]["graveyard"], 0)
        lane, row, _ = one(rec_kw=dict(is_archived=True), live=False, tail_=tail(text()))
        self.assertEqual((lane, row["restReason"], row["pr"]), ("graveyard", "archived", None))
        # An archived session's recent error does not beat its open PR.
        lane, _, _ = one(rec_kw=dict(is_archived=True, prs=pr9("OPEN"), error_at=NOW - HOUR), live=False,
                         tail_=tail(api_error(ts=NOW - HOUR)))
        self.assertEqual(lane, "open_pr")

    def test_archived_with_github_open_or_closed(self):
        for state, expected, reason in (("OPEN", "open_pr", None), ("CLOSED", "graveyard", "archived")):
            with self.subTest(state=state):
                lane, row, _ = one(rec_kw=dict(is_archived=True, prs=pr9("MERGED")), live=False,
                                   github={URL9: gh(state, merged_at=None)})
                self.assertEqual((lane, row["restReason"], row["pr"]["verified"]), (expected, reason, True))

    def test_inactive_30_day_boundary(self):
        lane, row, b = one(rec_kw=dict(last_activity_at=NOW - 30 * DAY), live=False)
        self.assertEqual((lane, row, b["counts"]["old"]), ("old", None, 1))
        lane, row, b = one(rec_kw=dict(last_activity_at=NOW - 30 * DAY - 1), live=False)
        self.assertEqual((lane, row["label"], row["since"], row["restReason"]),
                         ("graveyard", "Inactive", NOW - 30 * DAY - 1, "inactive"))
        self.assertEqual((b["counts"]["graveyard"], b["counts"]["old"]), (1, 0))

    def test_open_pr_is_never_inactive(self):
        lane, row, _ = one(rec_kw=dict(prs=pr9("OPEN"), last_activity_at=NOW - 300 * DAY), live=False)
        self.assertEqual((lane, row["restReason"], row["pr"]["verified"]), ("open_pr", None, False))

    def test_old_errors_and_stops_rest_in_the_graveyard(self):
        old = NOW - 31 * DAY
        for kw, t in ((dict(error_at=old), None), ({}, tail(api_error(ts=old))), ({}, tail(prompt(ts=old)))):
            with self.subTest(kw=kw):
                lane, row, _ = one(rec_kw=dict(last_activity_at=old, **kw), live=False, tail_=t)
                self.assertEqual((lane, row["restReason"]), ("graveyard", "inactive"))

    def test_live_sessions_never_rest(self):
        lane, row, _ = one(rec_kw=dict(is_archived=True, last_activity_at=NOW - 90 * DAY, last_focused_at=NOW),
                           entry_kw=dict(status_updated_at=NOW - 90 * DAY), tail_=tail(text(ts=NOW - 90 * DAY)))
        self.assertEqual((lane, row["restReason"]), ("idle", None))

    def test_rest_reason_null_outside_the_graveyard(self):
        b = bd.build_board(full_snapshot(), NOW)
        for row in b["sessions"]:
            with self.subTest(lane=row["lane"]):
                self.assertEqual(row["restReason"] is not None, row["lane"] == "graveyard")


class PrUrlTests(unittest.TestCase):
    def pr_url(self, url):
        prs = (PullRequest(12, "OPEN", url),)
        return one(rec_kw=dict(prs=prs), live=False)[1]["pr"]["url"]

    def test_valid(self):
        for url in ("https://github.com/Acme-DataTeam/wonderful-things-core/pull/532",
                    "https://github.com/o.r-g/re_po.x/pull/1"):
            with self.subTest(url=url):
                self.assertEqual(self.pr_url(url), url)

    def test_rejected(self):
        for url in ("javascript:alert(1)", "https://github.com/o/r/pull/1\n", "http://github.com/o/r/pull/1",
                    "https://gitlab.com/o/r/pull/1", "https://github.com.evil.example/o/r/pull/1",
                    "https://github.com/o/r/pull/1/../../x", "https://github.com/o/r/pull/1?x=1",
                    "https://github.com/o/r/issues/1", " https://github.com/o/r/pull/1", "", None):
            with self.subTest(url=url):
                self.assertIsNone(self.pr_url(url))

    def test_non_string_url(self):
        self.assertIsNone(bd.safe_pr_url(12))
        self.assertIsNone(bd.safe_pr_url(b"https://github.com/o/r/pull/1"))


class SortTests(unittest.TestCase):
    def test_lane_order(self):
        self.assertEqual(bd.LANE_ORDER, ("needs_you", "errored", "your_turn", "running", "stopped", "idle",
                                         "open_pr", "recent", "valhalla", "castle", "jail", "graveyard"))
        self.assertEqual(bd.COUNT_ONLY_LANES, ("old",))
        b = bd.build_board(full_snapshot(), NOW)
        seen = [r["lane"] for r in b["sessions"]]
        self.assertEqual(seen, sorted(seen, key=bd.LANE_ORDER.index))

    def test_since_ascending_lanes(self):
        ds = [desktop(n) for n in (1, 2, 3, 4)]
        reg = [entry(ds[0].cli_session_id, status="waiting", status_updated_at=NOW - 5 * MIN),
               entry(ds[1].cli_session_id, status="waiting", status_updated_at=NOW - 20 * MIN),
               entry(ds[2].cli_session_id, status="waiting", status_updated_at=NOW - 10 * MIN),
               entry(ds[3].cli_session_id, status="waiting", status_updated_at=NOW - 10 * MIN)]
        b = bd.build_board(snap(ds, reg), NOW)
        self.assertEqual([r["id"] for r in b["sessions"]],
                         [ds[1].session_id, ds[2].session_id, ds[3].session_id, ds[0].session_id])

    def test_running_and_stopped_since_ascending(self):
        ds = [desktop(1), desktop(2), desktop(3, last_activity_at=NOW - 5 * HOUR), desktop(4, last_activity_at=NOW - HOUR)]
        reg = [entry(ds[0].cli_session_id, status="busy", status_updated_at=NOW - MIN),
               entry(ds[1].cli_session_id, status="shell", status_updated_at=NOW - 9 * MIN)]
        tails = {ds[2].cli_session_id: tail(prompt()), ds[3].cli_session_id: tail(prompt())}
        b = bd.build_board(snap(ds, reg, tails=tails), NOW)
        self.assertEqual([r["id"] for r in b["sessions"]],
                         [ds[1].session_id, ds[0].session_id, ds[2].session_id, ds[3].session_id])

    def test_last_activity_descending_lanes(self):
        ds = [desktop(1, last_activity_at=NOW - 5 * HOUR, last_focused_at=NOW),
              desktop(2, last_activity_at=NOW - 3 * HOUR, last_focused_at=NOW),
              desktop(3, last_activity_at=NOW - 4 * HOUR, last_focused_at=NOW)]
        reg = [entry(d.cli_session_id, status_updated_at=NOW - 30 * DAY) for d in ds]
        b = bd.build_board(snap(ds, reg), NOW)
        self.assertEqual([r["lane"] for r in b["sessions"]], ["idle"] * 3)
        self.assertEqual([r["id"] for r in b["sessions"]], [ds[1].session_id, ds[2].session_id, ds[0].session_id])

        recents = [desktop(1, last_activity_at=NOW - 3 * DAY), desktop(2, last_activity_at=NOW - DAY),
                   desktop(3, last_activity_at=NOW - 2 * DAY)]
        b = bd.build_board(snap(recents), NOW)
        self.assertEqual([r["id"] for r in b["sessions"]],
                         [recents[1].session_id, recents[2].session_id, recents[0].session_id])

    def test_island_lanes_by_merge_time_then_last_activity(self):
        def merged(n, last):
            return desktop(n, last_activity_at=last, prs=(PullRequest(n, "MERGED", f"https://github.com/o/r/pull/{n}"),))

        ds = [merged(1, NOW - HOUR), merged(2, NOW - 9 * DAY), merged(3, NOW - 2 * DAY), merged(4, NOW - 2 * DAY),
              merged(5, NOW - 20 * DAY), merged(6, NOW - 30 * DAY), merged(7, NOW - HOUR)]
        github = {"https://github.com/o/r/pull/2": GitHubPr("MERGED", NOW - MIN, NOW - MIN, NOW),
                  "https://github.com/o/r/pull/3": GitHubPr("MERGED", NOW - 5 * DAY, NOW - 5 * DAY, NOW),
                  "https://github.com/o/r/pull/6": GitHubPr("MERGED", NOW - 16 * DAY, NOW - 16 * DAY, NOW),
                  "https://github.com/o/r/pull/7": GitHubPr("MERGED", NOW - 40 * DAY, NOW - 40 * DAY, NOW)}
        b = bd.build_board(snap(ds), NOW, github)
        got = [(r["lane"], r["id"]) for r in b["sessions"]]
        self.assertEqual(got, [("valhalla", ds[1].session_id), ("valhalla", ds[0].session_id),
                               ("valhalla", ds[3].session_id), ("valhalla", ds[2].session_id),
                               ("castle", ds[5].session_id), ("castle", ds[4].session_id),
                               ("castle", ds[6].session_id)])
        self.assertEqual([r["since"] for r in b["sessions"]],
                         [NOW - MIN, NOW - HOUR, NOW - 2 * DAY, NOW - 5 * DAY, NOW - 16 * DAY, NOW - 20 * DAY,
                          NOW - 40 * DAY])

    def test_graveyard_by_last_activity_descending(self):
        ds = [desktop(1, is_archived=True, last_activity_at=NOW - 50 * DAY),
              desktop(2, last_activity_at=NOW - 31 * DAY),
              desktop(3, is_archived=True, last_activity_at=NOW - HOUR),
              desktop(4, last_activity_at=NOW - 400 * DAY)]
        clis = [cli(1, last_activity_at=NOW - 45 * DAY)]
        b = bd.build_board(snap(ds, (), clis), NOW)
        self.assertEqual([(r["id"], r["restReason"]) for r in b["sessions"]],
                         [(ds[2].session_id, "archived"), (ds[1].session_id, "inactive"),
                          (f"cli:{clis[0].session_id}", "ended"), (ds[0].session_id, "archived"),
                          (ds[3].session_id, "inactive")])
        self.assertEqual({r["lane"] for r in b["sessions"]}, {"graveyard"})


class BannerAndHealthTests(unittest.TestCase):
    def test_rate_limit_banner_latest_future_reset(self):
        ds = [desktop(n) for n in (1, 2, 3)]
        def limited(resets, kind):
            return tail(api_error("rate_limit", quota_status="rejected", quota_resets_at=resets,
                                  quota_limit_type=kind))

        tails = {ds[0].cli_session_id: limited(NOW + HOUR, "five_hour"),
                 ds[1].cli_session_id: limited(NOW + 3 * DAY, "seven_day"),
                 ds[2].cli_session_id: limited(NOW - MIN, "old")}
        b = bd.build_board(snap(ds, tails=tails), NOW)
        self.assertEqual(b["rateLimit"], {"resetsAt": NOW + 3 * DAY, "limitType": "seven_day"})

    def test_no_banner_when_all_resets_passed(self):
        t = tail(api_error("rate_limit", quota_status="rejected", quota_resets_at=NOW - 1))
        self.assertIsNone(one(tail_=t)[2]["rateLimit"])
        self.assertIsNone(one()[2]["rateLimit"])

    def test_health_counts(self):
        ds = [desktop(1), desktop(2), desktop(3)]
        reg = [entry(ds[0].cli_session_id, status="waiting"), entry(ds[1].cli_session_id, status="busy"),
               entry(uid(9999), status="waiting"), entry(uid(9998), status="zzz")]
        tails = {ds[0].cli_session_id: tail(text(), unknown_types=("zeta", "alpha", "\n")),
                 ds[1].cli_session_id: tail(found=False),
                 ds[2].cli_session_id: tail(prompt(), unknown_types=("alpha",))}
        raw = snap(ds, reg, tails=tails, registry_files=6, desktop_parse_errors=2, scan_ms=345,
                   warnings=("PermissionError",), cli_versions=("2.1.271", "2.1.99", "2.1.271"), app_version=None)
        h = bd.build_board(raw, NOW)["health"]
        self.assertEqual(h, {
            "ok": False,
            "problems": ["unknown statuses"],
            "folders": [],
            "appVersion": None,
            "cliVersions": ["2.1.99", "2.1.271"],
            "desktop": {"records": 3, "parseErrors": 2},
            "registry": {"files": 6, "live": 4, "joined": 2, "unknownStatuses": ["zzz"]},
            "transcripts": {"tailed": 2, "missing": 1, "unknownTypes": ["alpha", "zeta"]},
            "tokens": {"tracked": 0, "complete": 0},
            "waitingSeenNow": 2,
            "scanMs": 345,
            "warnings": ["PermissionError"],
        })

    def test_health_ok_parse_error_threshold(self):
        self.assertTrue(bd.build_board(snap(desktop_parse_errors=5), NOW)["health"]["ok"])
        self.assertFalse(bd.build_board(snap(desktop_parse_errors=6), NOW)["health"]["ok"])

    def test_empty_snapshot(self):
        b = bd.build_board(snap(app_version=None, cli_versions=()), NOW)
        self.assertEqual((b["alert"], b["sessions"], b["rateLimit"], b["health"]["ok"]), (0, [], None, True))
        self.assertTrue(all(v == 0 for v in b["counts"].values()))


class FolderHealthTests(unittest.TestCase):
    """Health asks for a look when Tokentown finds no Claude folder or nothing in one, not just an empty town."""

    def health(self, folders, desktop_=None, tails=None):
        ds = [desktop(1)] if desktop_ is None else list(desktop_)
        return bd.build_board(snap(ds, tails=tails, folders=tuple(folders)), NOW)["health"]

    def test_an_everyday_scan_is_ok_and_reports_labels_only(self):
        h = self.health(SCANNED_FOLDERS)
        self.assertEqual((h["ok"], h["problems"]), (True, []))
        self.assertEqual(h["folders"], [{"label": "~/.claude", "kind": "code", "found": True},
                                        {"label": "Claude", "kind": "app", "found": True},
                                        {"label": "Claude-3p", "kind": "app", "found": False}])

    def test_no_claude_code_folder(self):
        h = self.health([SourceFolder("~/.claude", "code", False), SourceFolder("Claude", "app", True)])
        self.assertEqual((h["ok"], h["problems"]), (False, ["no Claude Code folder"]))

    def test_a_missing_config_dir_counts_even_with_claude_there(self):
        h = self.health([SourceFolder("CLAUDE_CONFIG_DIR", "code", False), SourceFolder("~/.claude", "code", True)])
        self.assertEqual((h["ok"], h["problems"]), (False, ["no folder at CLAUDE_CONFIG_DIR"]))
        h = self.health([SourceFolder("CLAUDE_CONFIG_DIR", "code", False), SourceFolder("~/.claude", "code", False)])
        self.assertEqual(h["problems"], ["no Claude Code folder", "no folder at CLAUDE_CONFIG_DIR"])

    def test_a_relocated_folder_without_claude_is_ok(self):
        h = self.health([SourceFolder("CLAUDE_CONFIG_DIR", "code", True), SourceFolder("~/.claude", "code", False)])
        self.assertEqual((h["ok"], h["problems"]), (True, []))

    def test_no_app_folder_is_fine(self):
        """Someone who only runs claude in a terminal has no Claude app folder at all."""
        h = self.health([SourceFolder("~/.claude", "code", True), SourceFolder("Claude", "app", False),
                         SourceFolder("Claude-3p", "app", False)])
        self.assertEqual((h["ok"], h["problems"]), (True, []))

    def test_folders_with_no_sessions_in_them(self):
        h = self.health(SCANNED_FOLDERS, desktop_=())
        self.assertEqual((h["ok"], h["problems"]), (False, ["no sessions found"]))

    def test_no_transcripts_only_when_every_one_looked_for_is_missing(self):
        ds = [desktop(1), desktop(2)]
        missing = {d.cli_session_id: tail(found=False) for d in ds}
        self.assertEqual(self.health(SCANNED_FOLDERS, ds, missing)["problems"], ["no transcripts found"])
        one_found = dict(missing, **{ds[0].cli_session_id: tail(text())})
        self.assertEqual(self.health(SCANNED_FOLDERS, ds, one_found)["problems"], [])
        self.assertEqual(self.health(SCANNED_FOLDERS, ds, {})["problems"], [])

    def test_older_problems_come_first(self):
        raw = snap([], [entry(uid(9999), status="zzz")], desktop_parse_errors=6, folders=SCANNED_FOLDERS)
        self.assertEqual(bd.build_board(raw, NOW)["health"]["problems"],
                         ["unknown statuses", "parse errors over 5", "no sessions found"])


def url(n: int, repo: str = "o/r") -> str:
    return f"https://github.com/{repo}/pull/{n}"


def link(n: int, ts: int | None = NOW - HOUR, u: str | None = "auto", repo: str | None = "o/r") -> PrLink:
    return PrLink(number=n, url=url(n) if u == "auto" else u, repository=repo, timestamp=ts)


def bg(shells=0, oldest=None, pending=0, wakeup=False) -> BackgroundWork:
    return BackgroundWork(shells=shells, oldest_started_at=oldest, pending_launches=pending, scheduled_wakeup=wakeup)


class TranscriptPrTests(unittest.TestCase):
    """The effective PR also comes from transcript pr-link records, newest first."""

    def test_candidates_desktop_first_then_links_by_timestamp(self):
        prs = (PullRequest(1, "MERGED", url(1)), PullRequest(2, "OPEN", url(2), dismissed=True),
               PullRequest(3, "OPEN", None))
        links = (link(10, NOW - HOUR), link(11, None), link(12, NOW - DAY), link(13, NOW - HOUR), link(1, NOW - DAY))
        got = [(c.number, c.url, c.app_state) for c in bd.pr_candidates(prs, links)]
        self.assertEqual(got, [(1, url(1), "MERGED"), (3, None, "OPEN"), (11, url(11), "UNKNOWN"),
                               (12, url(12), "UNKNOWN"), (1, url(1), "MERGED"), (10, url(10), "UNKNOWN"),
                               (13, url(13), "UNKNOWN")])
        self.assertEqual(bd.pr_candidates((), ()), [])

    def test_transcript_link_is_newer_than_any_desktop_pr(self):
        lane, row, _ = one(rec_kw=dict(prs=pr9("MERGED")), live=False, links=[link(10, None)])
        self.assertEqual((lane, row["pr"]), ("recent", {"number": 10, "state": "UNKNOWN", "url": url(10),
                                                        "verified": False, "mergedAt": None}))
        lane, row, _ = one(rec_kw=dict(prs=pr9("MERGED")), live=False, links=[link(10)],
                           github={url(10): gh(merged_at=NOW - DAY), URL9: gh("CLOSED", merged_at=None)})
        self.assertEqual((lane, row["label"], row["since"], row["valhallaReason"]),
                         ("valhalla", "Merged", NOW - DAY, "merged"))
        self.assertEqual(row["pr"], {"number": 10, "state": "MERGED", "url": url(10), "verified": True,
                                     "mergedAt": NOW - DAY})
        # The older desktop PR is still open on GitHub: it holds the row in the Harbour, and is the one shown.
        lane, row, _ = one(rec_kw=dict(prs=pr9("MERGED")), live=False, links=[link(10)],
                           github={url(10): gh(merged_at=NOW - DAY), URL9: gh("OPEN", merged_at=None)})
        self.assertEqual((lane, row["pr"]["number"], row["pr"]["state"]), ("open_pr", 9, "OPEN"))

    def test_newest_link_by_timestamp_wins_and_ties_keep_the_later_record(self):
        links = [link(1, NOW - HOUR), link(2, NOW - DAY), link(3, None), link(4, NOW - HOUR)]
        for state, expected in (("OPEN", "open_pr"), ("CLOSED", "jail")):
            with self.subTest(state=state):
                github = {url(n): gh(state, merged_at=None) for n in (1, 2, 3, 4)}
                lane, row, _ = one(live=False, links=links, github=github)
                self.assertEqual((lane, row["pr"]["number"]), (expected, 4))
                lane, row, _ = one(live=False, links=links[:3], github=github)
                self.assertEqual((lane, row["pr"]["number"]), (expected, 1))

    def test_link_for_a_desktop_pr_keeps_the_app_state(self):
        lane, row, _ = one(rec_kw=dict(prs=pr9("MERGED"), last_activity_at=NOW - 3 * DAY), live=False,
                           links=[link(9)])
        self.assertEqual((lane, row["pr"]["state"], row["pr"]["verified"], row["valhallaReason"]),
                         ("valhalla", "MERGED", False, "merged"))
        lane, row, _ = one(rec_kw=dict(prs=pr9("OPEN")), live=False, links=[link(9, u=URL9.replace("o/r", "O/R"))])
        self.assertEqual((lane, row["pr"]["state"]), ("open_pr", "OPEN"))

    def test_url_dismissed_on_the_desktop_record_never_returns_through_a_link(self):
        dismissed = pr9("MERGED", dismissed=True)
        for u in (URL9, "https://github.com/O/R/pull/9"):
            with self.subTest(u=u):
                lane, row, _ = one(rec_kw=dict(prs=dismissed), live=False, links=[link(9, u=u)],
                                   github={u: gh(), URL9: gh()})
                self.assertEqual((lane, row["pr"]), ("recent", None))
        prs = (PullRequest(9, "MERGED", URL9, dismissed=True),)
        lane, row, _ = one(rec_kw=dict(prs=prs), live=False, links=[link(8, NOW - DAY), link(9, NOW - MIN)],
                           github={url(8): gh("OPEN", merged_at=None), URL9: gh()})
        self.assertEqual((lane, row["pr"]["number"], row["pr"]["verified"]), ("open_pr", 8, True))

    def test_unusable_links_are_ignored(self):
        bad = [
            PrLink(10, None, "o/r", NOW), PrLink(10, "javascript:alert(1)", "o/r", NOW),
            PrLink(10, url(10) + "\n", "o/r", NOW), PrLink(0, url(10), "o/r", NOW), PrLink(-3, url(10), "o/r", NOW),
            PrLink(True, url(1), "o/r", NOW), PrLink("10", url(10), "o/r", NOW), PrLink(10, url(10), "o/r", "later"),
            PrLink(10, url(10), "o/r", 1.5), PrLink(10, "https://github.com/../r/pull/10", "o/r", NOW),
            PrLink(10, "https://github.com/o/r/pull/0", "o/r", NOW), PrLink(10, "https://github.com/o/r/pull/00", "o/r", NOW),
        ]
        for item in bad:
            with self.subTest(link=item):
                lane, row, _ = one(rec_kw=dict(prs=pr9("OPEN")), live=False, links=[item],
                                   github={url(10): gh(), url(1): gh()})
                self.assertEqual((lane, row["pr"]["number"], row["pr"]["state"]), ("open_pr", 9, "OPEN"))

    def test_a_link_gh_can_never_be_asked_about_does_not_hide_an_older_merge(self):
        # PR_URL_RE matches pull/0, but GitHub is never asked about it, so it would stay UNKNOWN for good.
        zero = PrLink(5, "https://github.com/o/r/pull/0", "o/r", NOW - MIN)
        self.assertEqual(bd.pr_candidates(pr9("MERGED"), (zero,)), [bd.PrCandidate(9, URL9, "MERGED")])
        lane, row, _ = one(rec_kw=dict(prs=pr9("MERGED"), last_activity_at=NOW - 3 * DAY), live=False, links=[zero])
        self.assertEqual((lane, row["pr"]["number"], row["valhallaReason"]), ("valhalla", 9, "merged"))

    def test_unknown_state_has_no_lane_of_its_own(self):
        for last, expected in ((NOW - HOUR, "recent"), (NOW - 10 * DAY, "old"), (NOW - 31 * DAY, "graveyard")):
            with self.subTest(last=last):
                lane, row, _ = one(rec_kw=dict(last_activity_at=last), live=False, links=[link(4, last)])
                self.assertEqual(lane, expected)
                if row is not None:
                    self.assertEqual((row["pr"]["state"], row["pr"]["verified"]), ("UNKNOWN", False))
        self.assertEqual(one(links=[link(4)], tail_=tail(text()))[0], "your_turn")

    def test_links_belong_to_their_own_session(self):
        d = desktop(1)
        raw = snap([d], pr_links={uid(4242): (link(5),), d.session_id: (link(6),)})
        row = bd.build_board(raw, NOW, {url(5): gh(), url(6): gh()})["sessions"][0]
        self.assertEqual((row["lane"], row["pr"]), ("recent", None))
        raw = snap([desktop(1, cli_session_id=None)], pr_links={None: (link(5),)})
        self.assertIsNone(bd.build_board(raw, NOW, {url(5): gh()})["sessions"][0]["pr"])

    def test_cli_rows_use_their_links(self):
        cases = [({url(3): gh(merged_at=NOW - DAY)}, "valhalla", "MERGED", True),
                 ({url(3): gh(merged_at=NOW - 20 * DAY)}, "castle", "MERGED", True),
                 ({url(3): gh("OPEN", merged_at=None)}, "open_pr", "OPEN", True),
                 (None, "graveyard", "UNKNOWN", False)]
        for github, expected, state, verified in cases:
            with self.subTest(expected=expected):
                lane, row, _ = one_cli(live=False, links=[link(3)], github=github)
                self.assertEqual((lane, row["pr"]["state"], row["pr"]["verified"]), (expected, state, verified))
        lane, row, _ = one_cli(links=[link(3)], github={url(3): gh()}, tail_=tail(text()))
        self.assertEqual((lane, row["live"], row["valhallaReason"]), ("valhalla", True, "merged"))

    def test_links_do_not_mutate_inputs(self):
        links = (link(1), link(2, None))
        raw = snap([desktop(1)], pr_links={desktop(1).cli_session_id: links})
        before = dict(raw.pr_links)
        bd.build_board(raw, NOW, {url(1): gh()})
        self.assertEqual(raw.pr_links, before)


class BackgroundLaneTests(unittest.TestCase):
    """A live session whose turn ended with a background task still going is running, not Charlie's turn."""

    def test_shells_make_an_idle_session_running(self):
        your_turn = dict(tail_=tail(prompt(ts=NOW - 30 * MIN), text(ts=NOW - 25 * MIN)))
        self.assertEqual(one(**your_turn)[0], "your_turn")
        lane, row, b = one(**your_turn, background=bg(shells=2, oldest=NOW - 20 * MIN - 30 * SEC))
        self.assertEqual((lane, row["label"], row["hints"], row["since"]),
                         ("running", "Running", ["background task · 20 min"], NOW - 20 * MIN - 30 * SEC))
        self.assertEqual((row["unread"], row["canMarkDone"], row["doneAt"], b["alert"]), (False, False, None, 0))

    def test_pending_launch_or_wakeup_counts_from_the_last_record(self):
        t = tail(prompt(ts=NOW - 30 * MIN), use("b", "Bash", ts=NOW - 29 * MIN), result("b", ts=NOW - 29 * MIN),
                 text(ts=NOW - 7 * MIN))
        for work in (bg(pending=1), bg(wakeup=True), bg(pending=3, wakeup=True)):
            with self.subTest(work=work):
                lane, row, _ = one(tail_=t, background=work)
                self.assertEqual((lane, row["hints"], row["since"]), ("running", ["background task · 7 min"],
                                                                      NOW - 7 * MIN))
        lane, row, _ = one(rec_kw=dict(last_activity_at=NOW - 3 * HOUR), background=bg(wakeup=True))
        self.assertEqual((lane, row["hints"], row["since"]), ("running", ["background task · 180 min"],
                                                              NOW - 3 * HOUR))

    def test_no_work_changes_nothing(self):
        t = tail(text())
        for work in (None, bg(), bg(shells=0, oldest=NOW - HOUR, pending=0, wakeup=False)):
            with self.subTest(work=work):
                self.assertEqual(one(tail_=t, background=work)[0], "your_turn")
                self.assertEqual(one(rec_kw=dict(last_activity_at=NOW - 3 * HOUR), tail_=tail(text(ts=NOW - 3 * HOUR)),
                                     background=work)[0], "idle")

    def test_needs_you_and_live_errors_beat_background(self):
        work = bg(shells=1, oldest=NOW - HOUR, pending=1, wakeup=True)
        cases = [
            (dict(status="waiting", waiting_for="permission prompt"), None, "needs_you"),
            (dict(status="compacting"), None, "needs_you"),
            (dict(status="idle"), tail(use("q", "AskUserQuestion")), "needs_you"),
            (dict(status="idle"), tail(use("p", "ExitPlanMode")), "needs_you"),
            (dict(status="idle"), tail(api_error("server_error")), "errored"),
            (dict(status="idle"), tail(api_error("rate_limit", quota_status="rejected",
                                                 quota_resets_at=NOW + HOUR)), "errored"),
        ]
        for entry_kw, t, expected in cases:
            with self.subTest(entry=entry_kw, expected=expected):
                lane, row, _ = one(entry_kw=entry_kw, tail_=t, background=work)
                self.assertEqual(lane, expected)
                self.assertFalse(any(h.startswith(bd.BACKGROUND_HINT) for h in row["hints"]))

    def test_busy_keeps_its_own_hints(self):
        lane, row, _ = one(entry_kw=dict(status="busy", status_updated_at=NOW - 2 * MIN), tail_=tail(text()),
                           background=bg(shells=1, oldest=NOW - HOUR))
        self.assertEqual((lane, row["hints"], row["since"]), ("running", ["background"], NOW - 2 * MIN))

    def test_background_beats_a_merge_and_a_done_mark(self):
        lane, row, _ = one(rec_kw=dict(prs=pr9("MERGED")), tail_=tail(text()), background=bg(pending=1),
                           done=NOW - MIN)
        self.assertEqual((lane, row["valhallaReason"], row["canMarkDone"], row["doneAt"]),
                         ("running", None, False, NOW - MIN))

    def test_only_live_sessions(self):
        lane, row, _ = one(live=False, tail_=tail(text()), background=bg(shells=3, oldest=NOW - HOUR))
        self.assertEqual((lane, row["hints"]), ("recent", []))

    def test_cli_rows_and_future_start(self):
        lane, row, _ = one_cli(tail_=tail(text()), background=bg(shells=1, oldest=NOW + 5 * MIN))
        self.assertEqual((lane, row["hints"], row["since"]), ("running", ["background task · 0 min"], NOW))

    def test_background_rows_sort_with_running_by_since(self):
        ds = [desktop(1), desktop(2)]
        reg = [entry(ds[0].cli_session_id, status="busy", status_updated_at=NOW - 5 * MIN),
               entry(ds[1].cli_session_id)]
        raw = snap(ds, reg, tails={ds[1].cli_session_id: tail(text())},
                   background={ds[1].cli_session_id: bg(shells=1, oldest=NOW - 9 * MIN)})
        b = bd.build_board(raw, NOW)
        self.assertEqual([(r["id"], r["lane"]) for r in b["sessions"]],
                         [(ds[1].session_id, "running"), (ds[0].session_id, "running")])
        self.assertEqual(b["counts"]["running"], 2)


class DoneLaneTests(unittest.TestCase):
    """A done mark sends a finished session to Valhalla until it is active again."""

    def test_live_idle_or_your_turn_goes_to_valhalla(self):
        for rec_kw in (dict(), dict(last_focused_at=NOW)):
            with self.subTest(rec_kw=rec_kw):
                lane, row, b = one(rec_kw=rec_kw, tail_=tail(text(ts=NOW - HOUR)), done=NOW - 10 * MIN)
                self.assertEqual((lane, row["label"], row["since"], row["doneAt"], row["valhallaReason"],
                                  row["canMarkDone"], row["pr"], row["live"]),
                                 ("valhalla", "Done", NOW - 10 * MIN, NOW - 10 * MIN, "done", False, None, True))
                self.assertEqual((b["counts"]["valhalla"], b["counts"]["your_turn"], b["counts"]["idle"]), (1, 0, 0))

    def test_castle_after_14_days_from_the_mark(self):
        last = NOW - 40 * DAY
        for done_at, expected in ((NOW - 14 * DAY, "valhalla"), (NOW - 14 * DAY - 1, "castle"),
                                  (NOW + HOUR, "valhalla")):
            with self.subTest(done_at=done_at):
                lane, row, _ = one(rec_kw=dict(last_activity_at=last), live=False, done=done_at)
                self.assertEqual((lane, row["since"], row["doneAt"], row["valhallaReason"]),
                                 (expected, done_at, done_at, "done"))

    def test_busy_sessions_ignore_the_mark(self):
        cases = [
            (dict(status="waiting", waiting_for="input needed"), None, "needs_you"),
            (dict(status="mystery"), None, "needs_you"),
            (dict(status="idle"), tail(use("q", "AskUserQuestion", ts=NOW - HOUR)), "needs_you"),
            (dict(status="idle"), tail(api_error(ts=NOW - HOUR)), "errored"),
            (dict(status="busy"), None, "running"),
            (dict(status="shell"), None, "running"),
        ]
        for entry_kw, t, expected in cases:
            with self.subTest(entry=entry_kw):
                lane, row, _ = one(entry_kw=entry_kw, tail_=t, done=NOW - MIN)
                self.assertEqual((lane, row["valhallaReason"], row["canMarkDone"], row["doneAt"]),
                                 (expected, None, False, NOW - MIN))

    def test_activity_after_the_mark_ignores_it(self):
        done_at = NOW - HOUR
        for last, counted in ((done_at + 120_000, True), (done_at + 120_001, False), (done_at - DAY, True)):
            with self.subTest(last=last):
                lane, row, _ = one(rec_kw=dict(last_activity_at=last), live=False, done=done_at)
                self.assertEqual((lane, row["doneAt"], row["valhallaReason"], row["canMarkDone"]),
                                 ("valhalla", done_at, "done", False) if counted else ("recent", None, None, True))
        # A later transcript record moves the effective last activity past the mark too.
        lane, row, _ = one(rec_kw=dict(last_activity_at=done_at - HOUR, last_focused_at=NOW),
                           tail_=tail(prompt(ts=NOW - 30 * MIN), text(ts=NOW - 20 * MIN)), done=done_at)
        self.assertEqual((lane, row["doneAt"]), ("your_turn", None))

    def test_a_reply_inside_the_grace_brings_the_session_back(self):
        done_at = NOW - 10 * MIN
        rec_kw = dict(last_activity_at=done_at - HOUR, last_focused_at=done_at - HOUR)
        reply = tail(text(ts=done_at - HOUR), prompt(ts=done_at + 30_000), text(ts=done_at + 90_000))
        self.assertEqual(one(rec_kw=rec_kw, tail_=reply)[0], "your_turn")
        lane, row, b = one(rec_kw=rec_kw, tail_=reply, done=done_at)
        self.assertEqual((lane, row["doneAt"], row["valhallaReason"], row["canMarkDone"]),
                         ("your_turn", None, None, True))
        # The server forgets exactly the marks the board ignores, whenever it next scans.
        d = desktop(1, **rec_kw)
        for now in (done_at + 100_000, NOW + DAY):
            activity = bd.done_activity(snap([d], tails={d.cli_session_id: reply}), now)
            self.assertGreater(activity[d.session_id], done_at + bd.DONE_GRACE_MS)
        # A record at the mark itself, and the app's own lastActivityAt inside the grace, still count.
        for rec_kw, t, expected in (
                (dict(last_activity_at=done_at + 120_000), tail(text(ts=done_at)), "valhalla"),
                (dict(last_activity_at=done_at - HOUR), tail(text(ts=done_at + 1)), "your_turn"),
                (dict(last_activity_at=done_at - HOUR), tail(text(ts=done_at + DAY)), "your_turn"),
                (dict(last_activity_at=done_at - HOUR, interrupted_by_quit_at=done_at + 120_000),
                 tail(text(ts=done_at - MIN)), "valhalla")):
            with self.subTest(rec_kw=rec_kw):
                lane, row, _ = one(rec_kw=dict(last_focused_at=done_at - DAY, **rec_kw), tail_=t, done=done_at)
                self.assertEqual(lane, expected)

    def test_cli_marks_are_judged_by_transcript_records_not_the_file_time(self):
        done_at = NOW - 2 * DAY
        before = tail(prompt(ts=done_at - HOUR), text(ts=done_at - 50 * MIN))
        # Exiting or renaming a terminal session writes last-prompt or a title after the last record: the mtime moves.
        for mtime in (done_at + 10 * MIN, NOW - MIN):
            with self.subTest(mtime=mtime):
                lane, row, _ = one_cli(live=False, cli_kw=dict(last_activity_at=mtime), tail_=before, done=done_at)
                self.assertEqual((lane, row["doneAt"], row["valhallaReason"]), ("valhalla", done_at, "done"))
                raw = snap((), (), [cli(1, last_activity_at=mtime)], {cli(1).session_id: before})
                self.assertLessEqual(bd.done_activity(raw, NOW)[f"cli:{cli(1).session_id}"],
                                     done_at + bd.DONE_GRACE_MS)
        again = tail(prompt(ts=done_at - HOUR), text(ts=done_at - 50 * MIN), prompt(ts=done_at + HOUR))
        lane, row, _ = one_cli(live=False, cli_kw=dict(last_activity_at=done_at + HOUR), tail_=again, done=done_at)
        self.assertEqual((lane, row["doneAt"]), ("stopped", None))
        # Not live and older than 7 days, so no tail was read: nothing says it was picked up again.
        raw = snap((), (), [cli(1, last_activity_at=NOW - 9 * DAY)])
        self.assertEqual(bd.done_activity(raw, NOW), {})
        lane, row, _ = one_cli(live=False, cli_kw=dict(last_activity_at=NOW - 9 * DAY), done=NOW - 10 * DAY)
        self.assertEqual((lane, row["valhallaReason"]), ("valhalla", "done"))

    def test_done_beats_the_graveyard_stopped_recent_and_old(self):
        cases = [
            (dict(is_archived=True), None),
            (dict(last_activity_at=NOW - 60 * DAY), None),
            (dict(last_activity_at=NOW - 10 * DAY), None),
            (dict(prs=pr9("CLOSED")), None),
            # A merge an unresolved PR holds off the island.
            (dict(prs=pr9("MERGED"), links=[link(10)]), None),
            (dict(), tail(prompt(ts=NOW - HOUR))),
            (dict(), tail(use("a", "Bash", ts=NOW - HOUR))),
            (dict(), None),
        ]
        for kw, t in cases:
            with self.subTest(kw=kw, tail=t is not None):
                rec_kw = {k: v for k, v in kw.items() if k != "links"}
                links = kw.get("links")
                before = one(rec_kw=rec_kw, live=False, tail_=t, links=links)
                self.assertNotIn(before[0], bd.ISLAND_LANES)
                if before[1] is not None:
                    self.assertTrue(before[1]["canMarkDone"])
                lane, row, b = one(rec_kw=rec_kw, live=False, tail_=t, done=NOW, links=links)
                self.assertEqual((lane, row["valhallaReason"], row["restReason"], row["canMarkDone"]),
                                 ("valhalla", "done", None, False))
                self.assertEqual((b["counts"]["graveyard"], b["counts"]["old"]), (0, 0))

    def test_done_beats_a_recent_error_like_archiving(self):
        for kw in (dict(tail_=tail(api_error("authentication_failed", ts=NOW - HOUR))),
                   dict(rec_kw=dict(error_at=NOW - HOUR))):
            with self.subTest(kw=kw):
                lane, row, b = one(live=False, **kw)
                self.assertEqual((lane, row["canMarkDone"], b["alert"]), ("errored", True, 1))
                lane, row, b = one(live=False, done=NOW - MIN, **kw)
                self.assertEqual((lane, row["valhallaReason"], b["alert"]), ("valhalla", "done", 0))

    def test_a_merge_beats_the_mark(self):
        lane, row, _ = one(rec_kw=dict(prs=pr9("OPEN")), live=False, done=NOW - MIN,
                           github={URL9: gh(merged_at=NOW - 20 * DAY)})
        self.assertEqual((lane, row["since"], row["valhallaReason"], row["doneAt"], row["canMarkDone"]),
                         ("castle", NOW - 20 * DAY, "merged", NOW - MIN, False))
        lane, row, _ = one(rec_kw=dict(prs=pr9("MERGED")), tail_=tail(text()), done=NOW - MIN)
        self.assertEqual((lane, row["valhallaReason"]), ("valhalla", "merged"))
        lane, row, _ = one(rec_kw=dict(prs=pr9("MERGED"), is_archived=True), live=False,
                           tail_=tail(api_error(ts=NOW - HOUR)), done=NOW - MIN)
        self.assertEqual((lane, row["valhallaReason"]), ("valhalla", "merged"))

    def test_the_mark_beats_an_open_pr(self):
        # (g) Live or not, archived or not: a finished session can leave its PR open for someone else, so a done
        # mark sends a Harbour row to Valhalla, where it offers Bring back.
        for live, rec_kw, t in ((False, dict(), None), (False, dict(is_archived=True), tail(prompt(ts=NOW - HOUR))),
                                (False, dict(last_activity_at=NOW - 60 * DAY), None),
                                (True, dict(), tail(text(ts=NOW - 3 * HOUR))), (True, dict(), tail(text()))):
            with self.subTest(live=live, rec_kw=rec_kw):
                lane, row, _ = one(rec_kw=dict(prs=pr9("OPEN"), **rec_kw), live=live, tail_=t, done=NOW - MIN)
                self.assertEqual((lane, row["valhallaReason"], row["doneAt"], row["canMarkDone"], row["pr"]["number"]),
                                 ("valhalla", "done", NOW - MIN, False, 9))
        lane, row, _ = one(rec_kw=dict(prs=pr9("MERGED")), live=False, done=NOW - MIN,
                           github={URL9: gh("OPEN", merged_at=None)})
        self.assertEqual((lane, row["valhallaReason"]), ("valhalla", "done"))
        # A recent error on a done row is dealt with, and the mark still beats the open PR.
        lane, _, _ = one(rec_kw=dict(prs=pr9("OPEN")), live=False, tail_=tail(api_error(ts=NOW - HOUR)),
                         done=NOW - MIN)
        self.assertEqual(lane, "valhalla")
        # New activity after the mark takes it back, and the open PR holds the row in the Harbour again.
        lane, row, _ = one(rec_kw=dict(prs=pr9("OPEN")), live=True, tail_=tail(text(ts=NOW - MIN)), done=NOW - HOUR)
        self.assertEqual((lane, row["doneAt"], row["canMarkDone"]), ("open_pr", None, True))
        # Once the PR closes unmerged the mark still counts.
        lane, row, _ = one(rec_kw=dict(prs=pr9("OPEN")), live=False, done=NOW - MIN,
                           github={URL9: gh("CLOSED", merged_at=None)})
        self.assertEqual((lane, row["valhallaReason"]), ("valhalla", "done"))

    def test_cli_rows_are_marked_by_their_row_id(self):
        lane, row, _ = one_cli(live=False, cli_kw=dict(last_activity_at=NOW - 40 * DAY), done=NOW - 20 * DAY)
        self.assertEqual((lane, row["valhallaReason"], row["id"].startswith("cli:")), ("castle", "done", True))
        c = cli(1)
        b = bd.build_board(snap((), (), [c]), NOW, done={c.session_id: NOW})
        self.assertEqual((b["sessions"][0]["lane"], b["sessions"][0]["valhallaReason"]), ("graveyard", None))

    def test_hostile_or_foreign_marks_are_ignored(self):
        d = desktop(1)
        for value in (True, False, "1800000000000", 1.8e12, None, 0, -5, NOW + DAY + 1, [NOW], {"at": NOW}):
            with self.subTest(value=value):
                b = bd.build_board(snap([d]), NOW, done={d.session_id: value})
                row = b["sessions"][0]
                self.assertEqual((row["lane"], row["doneAt"], row["valhallaReason"]), ("recent", None, None))
        b = bd.build_board(snap([d]), NOW, done={d.session_id: NOW + DAY})
        self.assertEqual(b["sessions"][0]["lane"], "valhalla")
        b = bd.build_board(snap([d]), NOW, done={f"local_{uid(2)}": NOW, d.cli_session_id: NOW})
        self.assertEqual(b["sessions"][0]["lane"], "recent")

    def test_can_mark_done_by_lane(self):
        b = bd.build_board(full_snapshot(), NOW)
        got = {(r["lane"], r["live"]): r["canMarkDone"] for r in b["sessions"]}
        self.assertEqual(got[("needs_you", True)], False)
        self.assertEqual(got[("running", True)], False)
        self.assertEqual(got[("valhalla", False)], False)
        self.assertEqual(got[("castle", False)], False)
        for key in (("open_pr", False), ("errored", False), ("your_turn", True), ("stopped", False), ("idle", True), ("recent", False),
                    ("jail", False), ("graveyard", False)):
            self.assertTrue(got[key], key)

    def test_island_sorts_merged_and_done_together_by_arrival(self):
        ds = [desktop(1, last_activity_at=NOW - 30 * DAY),
              desktop(2, last_activity_at=NOW - 30 * DAY, prs=(PullRequest(2, "MERGED", url(2)),)),
              desktop(3, last_activity_at=NOW - 60 * DAY),
              desktop(4, last_activity_at=NOW - 30 * DAY, prs=(PullRequest(4, "MERGED", url(4)),))]
        github = {url(2): gh(merged_at=NOW - 2 * DAY), url(4): gh(merged_at=NOW - 20 * DAY)}
        done = {ds[0].session_id: NOW - DAY, ds[2].session_id: NOW - 50 * DAY}
        b = bd.build_board(snap(ds), NOW, github, done)
        self.assertEqual([(r["lane"], r["id"], r["valhallaReason"]) for r in b["sessions"]],
                         [("valhalla", ds[0].session_id, "done"), ("valhalla", ds[1].session_id, "merged"),
                          ("castle", ds[3].session_id, "merged"), ("castle", ds[2].session_id, "done")])

    def test_done_is_not_mutated_and_pure(self):
        d = desktop(1)
        done = {d.session_id: NOW - MIN}
        raw = snap([d])
        b1 = bd.build_board(raw, NOW, None, done)
        self.assertEqual(done, {d.session_id: NOW - MIN})
        self.assertEqual(b1, bd.build_board(raw, NOW, done=dict(done)))
        self.assertEqual(json.loads(json.dumps(b1)), b1)
        self.assertEqual(bd.build_board(raw, NOW, done={})["sessions"][0]["lane"], "recent")


REPO = "acme/report"


def lk(n: int, ts: int | None = NOW - HOUR) -> PrLink:
    return link(n, ts, u=url(n, REPO), repo=REPO)


def ep(n: int, state: str, merged_at: int | None = None, verified: bool = True, u: str | None = "auto"):
    return bd.EffectivePr(n, state, url(n, REPO) if u == "auto" else u, verified, merged_at)


class AllPrCandidatesTests(unittest.TestCase):
    """Every PR a session has decides its lane, not only the newest."""

    def test_a_merged_29_and_closed_30_sail_an_idle_live_session(self):
        # (a) The session's newest PR #30 was closed, #29 merged: Valhalla, not Needs input.
        links = [lk(29, NOW - 5 * HOUR), lk(30, NOW - 4 * HOUR)]
        github = {url(29, REPO): gh(merged_at=NOW - 3 * HOUR),
                  url(30, REPO): gh("CLOSED", merged_at=None, closed_at=NOW - 2 * HOUR)}
        session = dict(rec_kw=dict(last_activity_at=NOW - 10 * MIN, last_focused_at=NOW - HOUR),
                       tail_=tail(prompt(ts=NOW - 12 * MIN), text(ts=NOW - 10 * MIN)), links=links)
        lane, row, b = one(**session, github=github)
        self.assertEqual((lane, row["label"], row["since"], row["valhallaReason"], row["canMarkDone"]),
                         ("valhalla", "Merged", NOW - 3 * HOUR, "merged", False))
        self.assertEqual(row["pr"], {"number": 29, "state": "MERGED", "url": url(29, REPO), "verified": True,
                                     "mergedAt": NOW - 3 * HOUR})
        self.assertEqual((b["counts"]["your_turn"], b["counts"]["valhalla"]), (0, 1))
        # Before GitHub answers both are unknown, and #29 may still be open.
        lane, row, _ = one(**session)
        self.assertEqual((lane, row["pr"]["number"], row["pr"]["state"]), ("your_turn", 30, "UNKNOWN"))
        # Not live, the same.
        self.assertEqual(one(**session, github=github, live=False)[0], "valhalla")

    def test_an_open_538_puts_an_idle_live_session_in_the_harbour(self):
        # (b) The PR was raised, the turn ended 5 minutes ago: the Harbour, not Needs input.
        links = [lk(537, NOW - 3 * HOUR), lk(538, NOW - 6 * MIN)]
        github = {url(537, REPO): gh(merged_at=NOW - 2 * HOUR), url(538, REPO): gh("OPEN", merged_at=None)}
        session = dict(rec_kw=dict(last_activity_at=NOW - 5 * MIN),
                       tail_=tail(prompt(ts=NOW - 20 * MIN), text(ts=NOW - 5 * MIN)), links=links)
        lane, row, b = one(**session, github=github)
        self.assertEqual((lane, row["label"], row["since"], row["live"], row["canMarkDone"], row["valhallaReason"]),
                         ("open_pr", "PR open", NOW - 5 * MIN, True, True, None))
        self.assertEqual(row["pr"], {"number": 538, "state": "OPEN", "url": url(538, REPO), "verified": True,
                                     "mergedAt": None})
        self.assertEqual((b["counts"]["your_turn"], b["counts"]["open_pr"], b["alert"]), (0, 1, 0))
        # (c) Busy, or blocked on Charlie: the live lane wins, and the row still shows the open PR.
        cases = [(dict(status="busy"), session["tail_"], None, "running", "Running"),
                 (dict(status="shell"), session["tail_"], None, "running", "Running"),
                 (dict(status="idle"), session["tail_"], bg(shells=1, oldest=NOW - MIN), "running", "Running"),
                 (dict(status="waiting", waiting_for="permission prompt"), session["tail_"], None, "needs_you",
                  "Approve"),
                 (dict(status="idle"), tail(prompt(ts=NOW - 2 * MIN), use("q", "AskUserQuestion", ts=NOW - MIN)), None,
                  "needs_you", "Answer"),
                 (dict(status="idle"), tail(prompt(ts=NOW - 2 * MIN), api_error(ts=NOW - MIN)), None, "errored",
                  "API error")]
        for entry_kw, t, work, expected, label in cases:
            with self.subTest(entry=entry_kw, expected=expected):
                lane, row, _ = one(rec_kw=session["rec_kw"], links=links, github=github, entry_kw=entry_kw, tail_=t,
                                   background=work)
                self.assertEqual((lane, row["label"], row["pr"]["number"], row["pr"]["state"]),
                                 (expected, label, 538, "OPEN"))

    def test_needs_input_for_30_minutes_after_viewing_then_idle(self):
        # (d)
        viewed = dict(last_focused_at=NOW - 10 * MIN)
        lane, row, _ = one(rec_kw=dict(last_activity_at=NOW - 30 * MIN, **viewed), tail_=tail(text(ts=NOW - 30 * MIN)))
        self.assertEqual((lane, row["label"], row["pr"]), ("your_turn", "Needs input", None))
        lane, row, _ = one(rec_kw=dict(last_activity_at=NOW - 121 * MIN, **viewed), tail_=tail(text(ts=NOW - 121 * MIN)))
        self.assertEqual((lane, row["label"]), ("idle", "Idle"))

    def test_an_open_pr_beats_an_older_merge_and_an_unknown_one_holds_it(self):
        # (e)
        both = [lk(1, NOW - 3 * HOUR), lk(2, NOW - 2 * HOUR)]
        for live, t in ((True, tail(text(ts=NOW - 10 * MIN))), (False, None)):
            with self.subTest(live=live):
                github = {url(1, REPO): gh(merged_at=NOW - DAY), url(2, REPO): gh("OPEN", merged_at=None)}
                lane, row, _ = one(links=both, github=github, live=live, tail_=t)
                self.assertEqual((lane, row["pr"]["number"], row["pr"]["state"]), ("open_pr", 2, "OPEN"))
                # The open one is older: it still decides, and is the PR shown.
                github = {url(1, REPO): gh("OPEN", merged_at=None), url(2, REPO): gh(merged_at=NOW - DAY)}
                lane, row, _ = one(links=both, github=github, live=live, tail_=t)
                self.assertEqual((lane, row["pr"]["number"], row["pr"]["state"]), ("open_pr", 1, "OPEN"))
                # #2 unknown: it may still be open, so no island, and no Harbour either.
                lane, row, _ = one(links=both, github={url(1, REPO): gh(merged_at=NOW - DAY)}, live=live, tail_=t)
                self.assertNotIn(lane, bd.ISLAND_LANES | {"open_pr"})
                self.assertEqual((lane, row["pr"]["number"], row["pr"]["state"], row["valhallaReason"]),
                                 ("your_turn" if live else "recent", 2, "UNKNOWN", None))
                # #1 unknown and #2 merged: the same.
                lane, row, _ = one(links=both, github={url(2, REPO): gh(merged_at=NOW - DAY)}, live=live, tail_=t)
                self.assertNotIn(lane, bd.ISLAND_LANES | {"open_pr"})
        # A state the app invented is not known to be finished either.
        prs = (PullRequest(1, "MERGED", None), PullRequest(2, "DRAFT", None))
        self.assertEqual(one(rec_kw=dict(prs=prs), live=False)[0], "recent")
        # CLOSED never blocks, in either order.
        for prs in ((PullRequest(1, "MERGED", None), PullRequest(2, "CLOSED", None)),
                    (PullRequest(2, "CLOSED", None), PullRequest(1, "MERGED", None))):
            with self.subTest(prs=prs):
                lane, row, _ = one(rec_kw=dict(prs=prs), live=False)
                self.assertEqual((lane, row["pr"]["number"]), ("valhalla", 1))

    def test_the_latest_merge_dates_the_island(self):
        # (f) In either order, the 3-day merge dates the row and is the PR shown.
        merges = {url(1, REPO): gh(merged_at=NOW - 20 * DAY), url(2, REPO): gh(merged_at=NOW - 3 * DAY)}
        for order in ([lk(1, NOW - 30 * DAY), lk(2, NOW - 25 * DAY)], [lk(2, NOW - 30 * DAY), lk(1, NOW - 25 * DAY)]):
            for live in (True, False):
                with self.subTest(first=order[0].number, live=live):
                    lane, row, _ = one(rec_kw=dict(last_activity_at=NOW - 40 * DAY), links=order, github=merges,
                                       live=live, tail_=tail(text(ts=NOW - 40 * DAY)) if live else None)
                    self.assertEqual((lane, row["since"], row["pr"]["number"], row["pr"]["mergedAt"]),
                                     ("valhalla", NOW - 3 * DAY, 2, NOW - 3 * DAY))
        merges[url(2, REPO)] = gh(merged_at=NOW - 16 * DAY)
        lane, row, _ = one(rec_kw=dict(last_activity_at=NOW - 40 * DAY), links=[lk(1), lk(2)], github=merges,
                           live=False)
        self.assertEqual((lane, row["since"]), ("castle", NOW - 16 * DAY))
        # An unverified merge dates from the last activity, which can be the latest.
        lane, row, _ = one(rec_kw=dict(prs=(PullRequest(5, "MERGED", None),), last_activity_at=NOW - HOUR),
                           links=[lk(1)], github=merges, live=False)
        self.assertEqual((lane, row["since"], row["pr"]["number"], row["pr"]["verified"]),
                         ("valhalla", NOW - HOUR, 5, False))

    def test_dismissed_prs_never_count(self):
        prs = (PullRequest(1, "MERGED", None), PullRequest(2, "OPEN", None, dismissed=True),
               PullRequest(3, "DRAFT", None, dismissed=True))
        lane, row, _ = one(rec_kw=dict(prs=prs), live=False)
        self.assertEqual((lane, row["pr"]["number"]), ("valhalla", 1))

    def test_live_cli_row_with_an_open_link_is_in_the_harbour(self):
        lane, row, _ = one_cli(links=[link(3)], github={url(3): gh("OPEN", merged_at=None)}, tail_=tail(text()))
        self.assertEqual((lane, row["live"], row["canMarkDone"]), ("open_pr", True, True))
        lane, row, _ = one_cli(links=[link(3), link(4, NOW - MIN)], tail_=tail(text()),
                               github={url(3): gh(merged_at=NOW - DAY), url(4): gh("CLOSED", merged_at=None)})
        self.assertEqual((lane, row["pr"]["number"]), ("valhalla", 3))

    def test_pr_verdict(self):
        last = NOW - HOUR
        self.assertEqual(bd.pr_verdict((), last), bd.NO_PRS)
        self.assertEqual(bd.NO_PRS, bd.PrVerdict(None, open=False, merged_at=None, closed=False))
        cases = [
            ((ep(1, "CLOSED"), ep(2, "CLOSED")), bd.PrVerdict(ep(2, "CLOSED"), closed=True)),
            ((ep(1, "OPEN"), ep(2, "OPEN"), ep(3, "MERGED", NOW - DAY)), bd.PrVerdict(ep(2, "OPEN"), open=True)),
            ((ep(1, "CLOSED"), ep(2, "OPEN")), bd.PrVerdict(ep(2, "OPEN"), open=True)),
            ((ep(1, "MERGED", NOW - DAY), ep(2, "UNKNOWN", verified=False)),
             bd.PrVerdict(ep(2, "UNKNOWN", verified=False))),
            # A closed PR beside an unresolved one: no jail, since the unresolved one may still be open.
            ((ep(1, "CLOSED"), ep(2, "UNKNOWN", verified=False)), bd.PrVerdict(ep(2, "UNKNOWN", verified=False))),
            ((ep(1, "DRAFT", verified=False), ep(2, "CLOSED")), bd.PrVerdict(ep(2, "CLOSED"))),
            ((ep(1, "MERGED", NOW - DAY), ep(2, "CLOSED"), ep(3, "MERGED", NOW - 2 * DAY)),
             bd.PrVerdict(ep(1, "MERGED", NOW - DAY), merged_at=NOW - DAY)),
            # Equal merge times: the newer PR is shown.
            ((ep(1, "MERGED", verified=False), ep(2, "MERGED", verified=False)),
             bd.PrVerdict(ep(2, "MERGED", verified=False), merged_at=last)),
            # GitHub said merged with no time: dated like an unverified merge.
            ((ep(1, "MERGED", NOW - 3 * HOUR), ep(2, "MERGED", None)), bd.PrVerdict(ep(2, "MERGED"), merged_at=last)),
        ]
        for i, (prs, expected) in enumerate(cases):
            with self.subTest(i=i):
                self.assertEqual(bd.pr_verdict(prs, last), expected)

    def test_effective_prs_resolves_each_candidate_on_its_own(self):
        prs = (PullRequest(9, "OPEN", URL9), PullRequest(4, "OPEN", "javascript:alert(1)"))
        links = (link(10, NOW - DAY), link(11, NOW - HOUR))
        got = bd.effective_prs(prs, {URL9: gh(merged_at=NOW - DAY), url(11): gh("CLOSED", merged_at=None)}, links)
        # GitHub reports closed_at on a merged PR too, and it is carried through with the state.
        self.assertEqual(got, (bd.EffectivePr(9, "MERGED", URL9, True, NOW - DAY, NOW - DAY),
                               bd.EffectivePr(4, "OPEN", None, False, None),
                               bd.EffectivePr(10, "UNKNOWN", url(10), False, None),
                               bd.EffectivePr(11, "CLOSED", url(11), True, None)))
        self.assertEqual(bd.effective_prs((), None), ())


class JailLaneTests(unittest.TestCase):
    """Rules 8a and 14a: every PR of the session is CLOSED, none merged, none still unresolved."""

    CLOSED_GH = {url(30, REPO): gh("CLOSED", merged_at=None, closed_at=NOW - 2 * HOUR)}

    def closed(self, **kw):
        """A session whose one PR, #30, GitHub calls closed."""
        return one(links=[lk(30, NOW - 3 * HOUR)], github=self.CLOSED_GH, **kw)

    def test_a_closed_only_session_is_jailed_live_or_not(self):
        ended = dict(rec_kw=dict(last_activity_at=NOW - 3 * HOUR), tail_=tail(text(ts=NOW - 3 * HOUR)))
        lane, row, b = self.closed(**ended)
        self.assertEqual((lane, row["label"], row["live"], row["since"], b["counts"]["jail"]),
                         ("jail", "PR closed", True, NOW - 3 * HOUR, 1))
        self.assertEqual(row["pr"], {"number": 30, "state": "CLOSED", "url": url(30, REPO), "verified": True,
                                     "mergedAt": None})
        self.assertEqual((row["valhallaReason"], row["restReason"], row["doneAt"], row["canMarkDone"]),
                         (None, None, None, True))
        lane, row, b = self.closed(live=False)
        self.assertEqual((lane, row["label"], row["pr"]["number"], b["counts"]["jail"]), ("jail", "PR closed", 30, 1))

    def test_a_merge_always_wins_over_a_closed_pr(self):
        # #29 merged and #30 closed still sails, in either order: a CLOSED PR never blocks.
        github = {url(29, REPO): gh(merged_at=NOW - 3 * HOUR), **self.CLOSED_GH}
        for order in ([lk(29, NOW - 5 * HOUR), lk(30, NOW - 4 * HOUR)], [lk(30, NOW - 5 * HOUR), lk(29, NOW - 4 * HOUR)]):
            for live, t in ((True, tail(text(ts=NOW - 3 * HOUR))), (False, None)):
                with self.subTest(first=order[0].number, live=live):
                    lane, row, b = one(links=order, github=github, live=live, tail_=t)
                    self.assertEqual((lane, row["valhallaReason"], row["pr"]["number"], b["counts"]["jail"]),
                                     ("valhalla", "merged", 29, 0))

    def test_an_open_pr_beats_a_closed_one_newer_or_older(self):
        github = {url(31, REPO): gh("OPEN", merged_at=None), **self.CLOSED_GH}
        for order in ([lk(30, NOW - 5 * HOUR), lk(31, NOW - 4 * HOUR)], [lk(31, NOW - 5 * HOUR), lk(30, NOW - 4 * HOUR)]):
            for live, t in ((True, tail(text(ts=NOW - 3 * HOUR))), (False, None)):
                with self.subTest(first=order[0].number, live=live):
                    lane, row, b = one(links=order, github=github, live=live, tail_=t)
                    self.assertEqual((lane, row["pr"]["number"], row["pr"]["state"], b["counts"]["jail"]),
                                     ("open_pr", 31, "OPEN", 0))

    def test_an_unresolved_pr_holds_the_row_out_of_the_jail(self):
        # An UNKNOWN link may still be open, so it blocks the jail exactly as it blocks the island.
        lane, row, b = one(links=[lk(30, NOW - 4 * HOUR), lk(31, NOW - 3 * HOUR)], github=self.CLOSED_GH, live=False)
        self.assertEqual((lane, row["pr"]["state"], b["counts"]["jail"]), ("recent", "UNKNOWN", 0))
        # A state the app invented is no more resolved than UNKNOWN.
        prs = (PullRequest(30, "CLOSED", None), PullRequest(31, "DRAFT", None))
        lane, row, _ = one(rec_kw=dict(prs=prs), live=False)
        self.assertEqual((lane, row["pr"]["state"]), ("recent", "DRAFT"))

    def test_the_newest_closed_pr_is_the_one_shown(self):
        github = {url(30, REPO): gh("CLOSED", merged_at=None, closed_at=NOW - 2 * HOUR),
                  url(31, REPO): gh("CLOSED", merged_at=None, closed_at=NOW - HOUR)}
        for order in ([lk(30, NOW - 5 * HOUR), lk(31, NOW - 4 * HOUR)], [lk(31, NOW - 5 * HOUR), lk(30, NOW - 4 * HOUR)]):
            with self.subTest(newest=order[-1].number):
                lane, row, _ = one(links=order, github=github, live=False)
                self.assertEqual((lane, row["pr"]["number"]), ("jail", order[-1].number))

    def test_needs_input_holds_a_live_row_for_two_hours_then_the_jail(self):
        for ago, expected, label in ((5 * MIN, "your_turn", "Needs input"), (3 * HOUR, "jail", "PR closed")):
            with self.subTest(ago=ago):
                lane, row, _ = self.closed(rec_kw=dict(last_activity_at=NOW - ago), tail_=tail(text(ts=NOW - ago)))
                self.assertEqual((lane, row["label"], row["pr"]["state"]), (expected, label, "CLOSED"))

    def test_a_busy_or_blocked_live_session_keeps_its_own_lane(self):
        ended = tail(text(ts=NOW - 3 * HOUR))
        cases = [(dict(status="busy"), ended, None, "running", "Running"),
                 (dict(status="shell"), ended, None, "running", "Running"),
                 (dict(status="idle"), ended, bg(shells=1, oldest=NOW - MIN), "running", "Running"),
                 (dict(status="waiting", waiting_for="input needed"), ended, None, "needs_you", "Answer"),
                 (dict(status="idle"), tail(api_error(ts=NOW - MIN)), None, "errored", "API error")]
        for entry_kw, t, work, expected, label in cases:
            with self.subTest(expected=expected, entry=entry_kw):
                lane, row, b = self.closed(entry_kw=entry_kw, tail_=t, background=work,
                                           rec_kw=dict(last_activity_at=NOW - 3 * HOUR))
                self.assertEqual((lane, row["label"], row["pr"]["state"], b["counts"]["jail"]),
                                 (expected, label, "CLOSED", 0))

    def test_archived_errored_and_stopped_rows_never_reach_the_jail(self):
        lane, row, _ = self.closed(live=False, rec_kw=dict(is_archived=True))
        self.assertEqual((lane, row["restReason"]), ("graveyard", "archived"))
        self.assertEqual(self.closed(live=False, tail_=tail(api_error(ts=NOW - HOUR)))[0], "errored")
        self.assertEqual(self.closed(live=False, rec_kw=dict(error_at=NOW - HOUR, last_activity_at=NOW - HOUR))[0],
                         "errored")
        self.assertEqual(self.closed(live=False, tail_=tail(prompt(ts=NOW - HOUR)))[0], "stopped")

    def test_a_done_mark_sends_a_jailed_row_to_the_island(self):
        lane, row, b = self.closed(live=False, done=NOW - MIN)
        self.assertEqual((lane, row["valhallaReason"], row["doneAt"], row["canMarkDone"], b["counts"]["jail"]),
                         ("valhalla", "done", NOW - MIN, False, 0))
        lane, row, _ = self.closed(rec_kw=dict(last_activity_at=NOW - 3 * HOUR),
                                   tail_=tail(text(ts=NOW - 3 * HOUR)), done=NOW - MIN)
        self.assertEqual((lane, row["valhallaReason"]), ("valhalla", "done"))

    def test_the_graveyard_keeps_the_long_quiet_at_the_30_day_boundary(self):
        # A closed PR is never count-only `old`: the jail holds it until the graveyard claims it. Both the activity
        # and the closure age together here, since the newer of the two dates the window.
        for ago, expected, rest in ((20 * DAY, "jail", None), (30 * DAY, "jail", None),
                                    (30 * DAY + 1, "graveyard", "inactive"), (40 * DAY, "graveyard", "inactive")):
            with self.subTest(ago=ago):
                github = {url(30, REPO): gh("CLOSED", merged_at=None, closed_at=NOW - ago)}
                lane, row, b = one(links=[lk(30, NOW - ago)], github=github, live=False,
                                   rec_kw=dict(last_activity_at=NOW - ago))
                self.assertEqual((lane, row["restReason"], b["counts"]["old"]), (expected, rest, 0))

    def test_a_fresh_closure_jails_a_session_that_went_quiet_long_ago(self):
        # The window is dated by the newer of the last activity and the closure: a PR rejected yesterday on a
        # session quiet for months is exactly the row worth seeing in the jail, and its `since` still reads from
        # the last activity.
        quiet = dict(live=False, rec_kw=dict(last_activity_at=NOW - 40 * DAY))
        for closed_ago, expected in ((DAY, "jail"), (30 * DAY, "jail"), (30 * DAY + 1, "graveyard")):
            with self.subTest(closed_ago=closed_ago):
                github = {url(30, REPO): gh("CLOSED", merged_at=None, closed_at=NOW - closed_ago)}
                lane, row, b = one(links=[lk(30, NOW - closed_ago)], github=github, **quiet)
                self.assertEqual((lane, row["since"], b["counts"]["jail"]),
                                 (expected, NOW - 40 * DAY, 1 if expected == "jail" else 0))
        # With no closure time (the app's own state, which gh was never asked for), the last activity still dates it.
        lane, _, _ = one(rec_kw=dict(last_activity_at=NOW - 40 * DAY, prs=(PullRequest(30, "CLOSED", url(30)),)),
                         live=False)
        self.assertEqual(lane, "graveyard")

    def test_a_dismissed_closed_url_never_jails_the_row(self):
        prs = (PullRequest(30, "CLOSED", url(30, REPO), dismissed=True),)
        lane, row, b = one(rec_kw=dict(prs=prs), live=False, links=[lk(30, NOW - 3 * HOUR)], github=self.CLOSED_GH)
        self.assertEqual((lane, row["pr"], b["counts"]["jail"]), ("recent", None, 0))

    def test_jailed_rows_sort_newest_first(self):
        ds = [desktop(n, last_activity_at=last, prs=(PullRequest(n, "CLOSED", url(n)),))
              for n, last in ((1, NOW - 3 * DAY), (2, NOW - HOUR), (3, NOW - 2 * DAY))]
        b = bd.build_board(snap(ds), NOW)
        self.assertEqual([r["lane"] for r in b["sessions"]], ["jail"] * 3)
        self.assertEqual([r["id"] for r in b["sessions"]],
                         [ds[1].session_id, ds[2].session_id, ds[0].session_id])

    def test_a_cli_row_is_jailed_by_its_own_link(self):
        closed = {url(3): gh("CLOSED", merged_at=None)}
        lane, row, _ = one_cli(links=[link(3)], github=closed, cli_kw=dict(last_activity_at=NOW - 3 * HOUR))
        self.assertEqual((lane, row["id"].startswith("cli:"), row["pr"]["number"], row["canMarkDone"]),
                         ("jail", True, 3, True))
        # Ended, it rests in the graveyard instead, as an archived desktop session does.
        lane, row, _ = one_cli(links=[link(3)], github=closed, live=False)
        self.assertEqual((lane, row["restReason"]), ("graveyard", "ended"))
        lane, row, _ = one_cli(links=[link(3)], github={url(3): gh("CLOSED", merged_at=None)}, tail_=tail(text()))
        self.assertEqual((lane, row["live"]), ("your_turn", True))


class PrecedenceTests(unittest.TestCase):
    """Each step of the two precedence chains in the README's Lanes section, both conditions present at once."""

    OPEN = pr9("OPEN")
    MERGED = (PullRequest(8, "MERGED", None),)
    CLOSED = (PullRequest(7, "CLOSED", None),)

    def test_live_chain(self):
        ended = tail(text(ts=NOW - 10 * MIN))
        quiet = tail(text(ts=NOW - 3 * HOUR))
        steps = [
            # Blocked > errored
            (dict(entry_kw=dict(status="waiting", waiting_for="input needed"), tail_=tail(api_error())), "needs_you"),
            (dict(tail_=tail(use("q", "ExitPlanMode")), background=bg(shells=1)), "needs_you"),
            # errored > running (background work)
            (dict(tail_=tail(api_error()), background=bg(pending=1)), "errored"),
            # running > open PR
            (dict(entry_kw=dict(status="busy"), rec_kw=dict(prs=self.OPEN), tail_=ended), "running"),
            (dict(rec_kw=dict(prs=self.OPEN), tail_=ended, background=bg(wakeup=True)), "running"),
            # open PR > merged
            (dict(rec_kw=dict(prs=self.MERGED + self.OPEN), tail_=ended), "open_pr"),
            # done mark > open PR: a finished session can leave a PR open for someone else
            (dict(rec_kw=dict(prs=self.OPEN), tail_=ended, done=NOW - MIN), "valhalla"),
            # merged > done mark, when no PR is open: the merge dates the island
            (dict(rec_kw=dict(prs=self.MERGED), tail_=ended, done=NOW - MIN), "valhalla"),
            # done mark > needs input
            (dict(tail_=ended, done=NOW - MIN), "valhalla"),
            (dict(tail_=ended), "your_turn"),
            # needs input > jail
            (dict(rec_kw=dict(prs=self.CLOSED), tail_=ended), "your_turn"),
            # jail > idle
            (dict(rec_kw=dict(prs=self.CLOSED), tail_=quiet), "jail"),
            (dict(tail_=quiet), "idle"),
        ]
        for i, (kw, expected) in enumerate(steps):
            with self.subTest(i=i, expected=expected):
                self.assertEqual(one(**kw)[0], expected)
        self.assertEqual(one(rec_kw=dict(prs=self.MERGED), tail_=ended, done=NOW - MIN)[1]["valhallaReason"], "merged")
        self.assertEqual(one(rec_kw=dict(prs=self.OPEN), tail_=ended, done=NOW - MIN)[1]["valhallaReason"], "done")

    def test_not_live_chain(self):
        err = tail(api_error(ts=NOW - HOUR))
        stopped = tail(prompt(ts=NOW - HOUR))
        steps = [
            # errored (recent, not archived, no done mark) > open PR
            (dict(rec_kw=dict(prs=self.OPEN), tail_=err), "errored"),
            (dict(rec_kw=dict(prs=self.OPEN, error_at=NOW - HOUR, last_activity_at=NOW - HOUR)), "errored"),
            (dict(rec_kw=dict(prs=self.OPEN, is_archived=True), tail_=err), "open_pr"),
            (dict(rec_kw=dict(prs=self.OPEN), tail_=err, done=NOW - MIN), "valhalla"),
            # open PR > merged; done mark > open PR; merged > done mark when no PR is open
            (dict(rec_kw=dict(prs=self.OPEN + self.MERGED)), "open_pr"),
            (dict(rec_kw=dict(prs=self.OPEN), done=NOW - MIN), "valhalla"),
            (dict(rec_kw=dict(prs=self.MERGED), done=NOW - MIN), "valhalla"),
            # done mark > archived > stopped > jail > recent
            (dict(rec_kw=dict(is_archived=True), tail_=stopped, done=NOW - MIN), "valhalla"),
            (dict(rec_kw=dict(prs=self.CLOSED), done=NOW - MIN), "valhalla"),
            (dict(rec_kw=dict(is_archived=True), tail_=stopped), "graveyard"),
            (dict(rec_kw=dict(prs=self.CLOSED, is_archived=True)), "graveyard"),
            (dict(tail_=stopped), "stopped"),
            (dict(rec_kw=dict(prs=self.CLOSED), tail_=stopped), "stopped"),
            (dict(rec_kw=dict(prs=self.CLOSED), tail_=err), "errored"),
            (dict(rec_kw=dict(prs=self.CLOSED)), "jail"),
            (dict(tail_=tail(text(ts=NOW - HOUR))), "recent"),
            # graveyard inactive (30+ days) > jail > old
            (dict(rec_kw=dict(last_activity_at=NOW - 31 * DAY)), "graveyard"),
            (dict(rec_kw=dict(prs=self.CLOSED, last_activity_at=NOW - 31 * DAY)), "graveyard"),
            (dict(rec_kw=dict(prs=self.CLOSED, last_activity_at=NOW - 20 * DAY)), "jail"),
            (dict(rec_kw=dict(last_activity_at=NOW - 20 * DAY)), "old"),
            # Open and merged PRs have no age cap.
            (dict(rec_kw=dict(prs=self.OPEN, last_activity_at=NOW - 31 * DAY)), "open_pr"),
            (dict(rec_kw=dict(prs=self.MERGED, last_activity_at=NOW - 31 * DAY)), "castle"),
        ]
        for i, (kw, expected) in enumerate(steps):
            with self.subTest(i=i, expected=expected):
                self.assertEqual(one(live=False, **kw)[0], expected)


class SessionActivityTests(unittest.TestCase):
    def test_every_session_including_count_only_rows(self):
        ds = [desktop(1, last_activity_at=NOW - 10 * DAY), desktop(2, last_activity_at=NOW - DAY),
              desktop(3, cli_session_id=None, last_activity_at=NOW - 2 * DAY)]
        clis = [cli(1, last_activity_at=NOW - 3 * DAY), cli(2, session_id=ds[0].cli_session_id)]
        tails = {ds[1].cli_session_id: tail(text(ts=NOW - HOUR)), ds[0].cli_session_id: tail(text(ts=NOW + DAY))}
        raw = snap(ds, (), clis, tails)
        self.assertEqual(bd.session_activity(raw, NOW), {
            ds[0].session_id: NOW, ds[1].session_id: NOW - HOUR, ds[2].session_id: NOW - 2 * DAY,
            f"cli:{clis[0].session_id}": NOW - 3 * DAY})
        self.assertEqual(bd.session_activity(snap(), NOW), {})

    def test_done_activity_gives_transcript_records_no_grace(self):
        g = bd.DONE_GRACE_MS
        ds = [desktop(1, last_activity_at=NOW - 10 * DAY), desktop(2, last_activity_at=NOW - DAY),
              desktop(3, cli_session_id=None, last_activity_at=NOW - 2 * DAY),
              desktop(4, last_activity_at=NOW - 3 * DAY, interrupted_by_quit_at=NOW + DAY),
              desktop(5, last_activity_at=NOW + HOUR)]
        clis = [cli(1, last_activity_at=NOW - MIN), cli(2, last_activity_at=NOW - MIN), cli(3), cli(4)]
        tails = {ds[1].cli_session_id: tail(text(ts=NOW - HOUR)), ds[0].cli_session_id: tail(text(ts=NOW + DAY)),
                 clis[0].session_id: tail(prompt(ts=NOW - HOUR), system("turn_duration", ts=NOW - MIN)),
                 clis[1].session_id: tail(system("turn_duration", ts=NOW - MIN)),
                 clis[2].session_id: tail(found=False)}
        raw = snap(ds, (), clis, tails)
        self.assertEqual(bd.done_activity(raw, NOW), {
            ds[0].session_id: NOW + g, ds[1].session_id: NOW - HOUR + g, ds[2].session_id: NOW - 2 * DAY,
            ds[3].session_id: NOW, ds[4].session_id: NOW + HOUR, f"cli:{clis[0].session_id}": NOW - HOUR + g})
        self.assertEqual(bd.done_activity(snap(), NOW), {})


class FakeScanner:
    def __init__(self, raw=None, exc=None):
        self.raw, self.exc, self.calls = raw, exc, 0

    def scan(self):
        self.calls += 1
        if self.exc:
            raise self.exc
        return self.raw


# What a scan of an everyday Mac reports: ~/.claude and the Claude app's folder, and no third-party folder.
SCANNED_FOLDERS = (SourceFolder("~/.claude", "code", True), SourceFolder("Claude", "app", True),
                   SourceFolder("Claude-3p", "app", False))


def check_snapshot(**kw):
    ds = [
        desktop(1, title="ACME secret client title", cwd="/Users/t/clients/acme-secret/.claude/worktrees/wt",
                origin_cwd="/Users/t/clients/acme-secret"),
        desktop(2, is_archived=True),
        desktop(3, last_activity_at=NOW - 30 * DAY, prs=(PullRequest(1, "MERGED", None),)),
        desktop(4, last_activity_at=NOW - 30 * DAY),
        desktop(5, last_activity_at=NOW - 60 * DAY, prs=(PullRequest(4, "OPEN", "https://github.com/o/r/pull/4"),
                                                         PullRequest(5, "CLOSED", "https://github.com/o/r/pull/5",
                                                                     dismissed=True))),
    ]
    reg = [entry(ds[0].cli_session_id, cwd="/Users/t/clients/acme-secret/.claude/worktrees/wt")]
    tails = {ds[0].cli_session_id: tail(text(), unknown_types=("mystery",)), ds[1].cli_session_id: tail(found=False)}
    base = dict(registry_files=3, plan_usage=PlanUsage(42, 17, NOW - 12 * MIN - 59 * SEC),
                tokens={ds[0].cli_session_id: tokens_for(), ds[2].cli_session_id: tokens_for(complete=False)},
                folders=SCANNED_FOLDERS)
    base.update(kw)
    return snap(ds, reg, [cli(1)], tails, **base)


# ====================================================================== visitors (review requests)

def review(number: int = 532, *, repo: str = "wonderful-things-core", owner: str = "Acme-DataTeam",
           title: str | None = "Fix the funnel", author: str | None = "sam",
           waiting_since: int | None = NOW - 2 * DAY, url=..., visitor_id=..., via="you",
           teams=()) -> ReviewRequest:
    url = f"https://github.com/{owner}/{repo}/pull/{number}" if url is ... else url
    visitor_id = review_id(url) if visitor_id is ... and isinstance(url, str) else visitor_id
    return ReviewRequest(id="pr:" + "0" * 16 if visitor_id is ... else visitor_id, number=number, owner=owner,
                         repo=repo, url=url, title=title, author=author, waiting_since=waiting_since, via=via,
                         teams=teams)


class VisitorTests(unittest.TestCase):
    """Visitors ride beside the sessions: their own array, no lane, no count of their own."""

    def build(self, *requests, reviewers=None, sessions=(), cli_=(), links=None):
        reviews = ReviewSnapshot(requests=tuple(requests), reviewers=dict(reviewers or {}))
        return bd.build_board(snap(sessions, cli_=cli_, pr_links=dict(links or {})), NOW, reviews=reviews)

    @staticmethod
    def working_in(n: int, folder: str, *urls: str) -> DesktopRecord:
        """A session in a local folder whose record links these PRs (MERGED, so no row reaches the Harbour)."""
        prs = tuple(PullRequest(int(u.rsplit("/", 1)[1]), "MERGED", u) for u in urls)
        return desktop(n, cwd=f"/Users/t/code/{folder}", origin_cwd=f"/Users/t/code/{folder}", prs=prs)

    def islands(self, *requests, sessions=(), cli_=(), links=None) -> dict[int, str | None]:
        return {v["number"]: v["island"] for v in self.build(*requests, sessions=sessions, cli_=cli_,
                                                               links=links)["visitors"]}

    def test_no_source_still_sends_both_keys(self):
        board = bd.build_board(snap(), NOW)
        self.assertEqual(board["visitors"], [])
        self.assertEqual(board["reviews"], {"waiting": 0, "viaYou": 0, "viaTeam": 0, "byRepo": {}, "waitingOn": {}})

    def test_one_visitor(self):
        board = self.build(review())
        url = "https://github.com/Acme-DataTeam/wonderful-things-core/pull/532"
        self.assertEqual(board["visitors"], [{
            "id": review_id(url), "number": 532, "repo": "wonderful-things-core", "owner": "Acme-DataTeam",
            "island": None, "title": "Fix the funnel", "author": "sam", "via": "you", "teams": [],
            "waitingSince": NOW - 2 * DAY, "look": bd.look_for("sam")}])
        self.assertEqual(set(board["visitors"][0]), set(bd.VISITOR_KEYS))
        self.assertEqual(board["reviews"], {"waiting": 1, "viaYou": 1, "viaTeam": 0, "byRepo": {}, "waitingOn": {}})

    def test_a_team_visitor_names_its_teams(self):
        board = self.build(review(1, via="team", teams=("web-platform", "platform")), review(2, via="team"))
        by_number = {v["number"]: (v["via"], v["teams"]) for v in board["visitors"]}
        self.assertEqual(by_number, {1: ("team", ["web-platform", "platform"]), 2: ("team", [])})
        self.assertEqual(set(board["visitors"][0]), set(bd.VISITOR_KEYS))

    def test_charlies_shape_the_split_counts_every_visitor_once(self):
        # Measured on his account: nothing asks him by name, eleven PRs ask a team he is on.
        board = self.build(*(review(n, via="team", teams=("web-platform",)) for n in range(500, 511)))
        self.assertEqual(len(board["visitors"]), 11)
        self.assertEqual({k: board["reviews"][k] for k in ("waiting", "viaYou", "viaTeam")},
                         {"waiting": 11, "viaYou": 0, "viaTeam": 11})
        mixed = self.build(review(1), review(2, via="team"), review(3, via="team"), review(4))
        self.assertEqual({k: mixed["reviews"][k] for k in ("waiting", "viaYou", "viaTeam")},
                         {"waiting": 4, "viaYou": 2, "viaTeam": 2})

    def test_a_you_visitor_never_names_a_team(self):
        # The tooltip reads "Asked of you" or "Asked of <team>", never both.
        (visitor,) = self.build(review(via="you", teams=("web-platform",)))["visitors"]
        self.assertEqual((visitor["via"], visitor["teams"]), ("you", []))

    def test_an_unknown_via_reads_as_the_less_urgent_team(self):
        for via in ("YOU", "direct", "", None, 1, ["you"], {"you": 1}):
            with self.subTest(via=via):
                board = self.build(review(via=via, teams=("web-platform",)))
                self.assertEqual((board["visitors"][0]["via"], board["visitors"][0]["teams"]),
                                 ("team", ["web-platform"]))
                self.assertEqual((board["reviews"]["viaYou"], board["reviews"]["viaTeam"]), (0, 1))

    def test_team_slugs_are_checked_again_whoever_built_the_request(self):
        hostile = ("web platform", "a/b", "../x", "x" * 300, "dätä", "ｄata", "<b>", "", "ok\n", None, 7,
                   "data" + "‮" + "x", "web-platform", "web-platform")
        (visitor,) = self.build(review(via="team", teams=hostile))["visitors"]
        self.assertEqual(visitor["teams"], ["x" * 40, "web-platform"])
        for teams in (None, "web-platform", 7, {"web-platform": 1}):
            with self.subTest(teams=teams):
                (visitor,) = self.build(review(via="team", teams=teams))["visitors"]
                self.assertEqual(visitor["teams"], [])
        (visitor,) = self.build(review(via="team", teams=tuple(f"t{n}" for n in range(30))))["visitors"]
        self.assertEqual(visitor["teams"], [f"t{n}" for n in range(10)])

    def test_past_the_cap_a_request_that_names_him_keeps_its_place(self):
        older_team = [review(n, via="team", waiting_since=NOW - (100 + n) * DAY) for n in range(1, 61)]
        board = self.build(*older_team, review(900, waiting_since=NOW - MIN))
        self.assertEqual(len(board["visitors"]), 50)
        self.assertEqual(board["visitors"][-1]["number"], 900, "kept, and still in queue order")
        self.assertEqual((board["reviews"]["viaYou"], board["reviews"]["viaTeam"]), (1, 49))
        waits = [v["waitingSince"] for v in board["visitors"]]
        self.assertEqual(waits, sorted(waits))

    def test_team_visitors_move_no_lane_count_either(self):
        plain = bd.build_board(snap([desktop(1)]), NOW)
        board = self.build(review(1, via="team", teams=("web-platform",)), review(2), sessions=[desktop(1)])
        self.assertEqual((board["sessions"], board["counts"], board["alert"]),
                         (plain["sessions"], plain["counts"], plain["alert"]))

    def test_the_look_follows_the_login_then_the_id(self):
        board = self.build(review(1, author="sam"), review(2, author="sam"), review(3, author=None))
        by_number = {v["number"]: v for v in board["visitors"]}
        looks = {number: v["look"] for number, v in by_number.items()}
        self.assertEqual(looks[1], looks[2])
        self.assertEqual(looks[3], bd.look_for(by_number[3]["id"]))
        self.assertTrue(all(isinstance(v["look"], int) for v in board["visitors"]))

    def test_queue_order_is_longest_wait_first(self):
        board = self.build(review(2, waiting_since=NOW - DAY), review(3, waiting_since=None),
                           review(1, waiting_since=NOW - 5 * DAY))
        self.assertEqual([v["number"] for v in board["visitors"]], [1, 2, 3])

    def test_visitors_never_become_sessions_or_move_a_count(self):
        plain = bd.build_board(snap([desktop(1)]), NOW)
        board = self.build(review(), review(2), sessions=[desktop(1)])
        self.assertEqual(board["sessions"], plain["sessions"])
        self.assertEqual(board["counts"], plain["counts"])
        self.assertEqual(board["alert"], plain["alert"])
        self.assertEqual(len(board["visitors"]), 2)
        self.assertNotIn("visitors", board["counts"])
        self.assertTrue(all("lane" not in v for v in board["visitors"]))

    def test_counts_per_island_for_the_island_badges(self):
        sessions = [self.working_in(1, "wonderful-things-core",
                                    "https://github.com/Acme-DataTeam/wonderful-things-core/pull/9"),
                    self.working_in(2, "tokentown", "https://github.com/Acme-DataTeam/tokentown/pull/3")]
        board = self.build(review(1, repo="wonderful-things-core"), review(2, repo="wonderful-things-core"),
                           review(3, repo="tokentown"), review(4, repo="elsewhere"), sessions=sessions)
        self.assertEqual(board["reviews"]["waiting"], 4, "a visitor with no island still counts for the board")
        self.assertEqual(board["reviews"]["byRepo"], {"wonderful-things-core": 2, "tokentown": 1})

    def test_a_same_named_repo_under_another_owner_gets_no_island(self):
        # Anyone can open a repo called wonderful-things-core and request Charlie's review on it. Keyed by name
        # alone it queued at his island's desk and raised its badge, and the pill sailed to it when it was oldest.
        core = self.working_in(1, "wonderful-things-core",
                               "https://github.com/Acme-DataTeam/wonderful-things-core/pull/9")
        found = self.islands(review(1), review(2, owner="someone-else"), review(3, owner="acme-datateam"),
                             sessions=[core])
        self.assertEqual(found, {1: "wonderful-things-core", 2: None, 3: "wonderful-things-core"})

    def test_a_folder_named_differently_from_its_repo_is_found_through_its_pr_links(self):
        # A worktree folder, a renamed clone, or a clone in another case: the row's own PR link ties the folder to
        # the GitHub repo, which the name never could.
        sessions = [self.working_in(1, "ad-slot-placement",
                                    "https://github.com/Acme-DataTeam/wonderful-things-core/pull/537"),
                    self.working_in(2, "Tokentown", "https://github.com/Acme-DataTeam/tokentown/pull/3")]
        found = self.islands(review(1), review(2, repo="tokentown"), sessions=sessions)
        self.assertEqual(found, {1: "ad-slot-placement", 2: "Tokentown"})

    def test_transcript_links_and_cli_rows_count_as_evidence_too(self):
        cli_row = cli(1, cwd="/Users/t/code/renamed-core")
        found = self.islands(review(1), cli_=[cli_row],
                             links={cli_row.session_id: (PrLink(7, "https://github.com/Acme-DataTeam/"
                                                                   "wonderful-things-core/pull/7", "o/r", NOW),)})
        self.assertEqual(found, {1: "renamed-core"})

    def test_the_folder_most_rows_link_wins_and_a_name_match_breaks_a_tie(self):
        url = "https://github.com/Acme-DataTeam/wonderful-things-core/pull/9"
        two = [self.working_in(1, "wt-a", url), self.working_in(2, "wt-a", url),
               self.working_in(3, "wonderful-things-core", url)]
        self.assertEqual(self.islands(review(1), sessions=two), {1: "wt-a"})
        tie = [self.working_in(1, "wt-a", url), self.working_in(2, "wonderful-things-core", url)]
        self.assertEqual(self.islands(review(1), sessions=tie), {1: "wonderful-things-core"})

    def test_a_known_owner_lets_a_same_named_folder_with_no_links_of_its_own_take_it(self):
        # His rows link PRs under Acme-DataTeam, so a folder named after the repo is taken to be its clone...
        sessions = [self.working_in(1, "wonderful-things-core",
                                    "https://github.com/Acme-DataTeam/wonderful-things-core/pull/9"),
                    self.working_in(2, "Report-Hub")]
        self.assertEqual(self.islands(review(1, repo="report-hub"), sessions=sessions), {1: "Report-Hub"})
        # ...unless a link says that folder is the same name under another owner.
        sessions[1] = self.working_in(2, "report-hub", "https://github.com/someone-else/report-hub/pull/1")
        self.assertEqual(self.islands(review(1, repo="report-hub"), sessions=sessions), {1: None})

    def test_with_no_pr_links_at_all_nothing_is_placed_on_an_island(self):
        found = self.islands(review(1), sessions=[self.working_in(1, "wonderful-things-core")])
        self.assertEqual(found, {1: None})

    def test_a_bad_id_or_url_is_dropped(self):
        bad = [
            review(1, visitor_id="pr:NOTHEX0123456789"),
            review(2, visitor_id="../etc/passwd"),
            review(3, visitor_id=""),
            review(4, url="https://github.com/o/r/pull/4/files"),
            review(5, url="javascript:alert(1)"),
            review(6, url="https://github.com/o/../pull/6"),
            review(7, url=None),
        ]
        board = self.build(*bad, review(8))
        self.assertEqual([v["number"] for v in board["visitors"]], [8])
        self.assertEqual(board["reviews"]["waiting"], 1)

    def test_a_number_below_one_is_dropped_the_way_both_clients_drop_it(self):
        # parse_pr_url already refuses pull/0, so this can only arrive from a hand-built request, and both the
        # page and the village drop a visitor with no positive number. Published, it would leave reviews.waiting
        # one above the queue and the island badges for good, which is the one divergence nothing on screen can
        # be reconciled against.
        board = self.build(review(0, url="https://github.com/o/r/pull/0"),
                           ReviewRequest(id="pr:" + "a" * 16, number=-4, owner="o", repo="r",
                                         url="https://github.com/o/r/pull/4", title=None, author=None,
                                         waiting_since=None),
                           review(8))
        self.assertEqual([v["number"] for v in board["visitors"]], [8])
        self.assertEqual(board["reviews"]["waiting"], 1)
        self.assertEqual(board["reviews"]["byRepo"], {})

    def test_the_published_count_is_the_length_of_the_array_it_publishes(self):
        # The HUD pill reads reviews.waiting and the island badges count the array. The two are only ever the
        # same number because the server derives both from one list, so that is asserted rather than assumed.
        for requests in ([], [review(1)], [review(n) for n in range(1, 61)],
                         [review(2), review(2), review(3, url=None)],
                         [review(n, via="team" if n % 3 else "you") for n in range(1, 71)],
                         [review(2, via="team"), review(2), review(4, via="bogus", url=None)]):
            board = self.build(*requests, sessions=[self.working_in(
                1, "wonderful-things-core", "https://github.com/Acme-DataTeam/wonderful-things-core/pull/9")])
            self.assertEqual(board["reviews"]["waiting"], len(board["visitors"]))
            self.assertEqual(sum(board["reviews"]["byRepo"].values()), len(board["visitors"]))
            self.assertEqual(board["reviews"]["viaYou"], sum(v["via"] == "you" for v in board["visitors"]))
            self.assertEqual(board["reviews"]["viaYou"] + board["reviews"]["viaTeam"], board["reviews"]["waiting"])

    def test_no_visitor_can_take_a_session_id(self):
        # Both clients hand a clashing id to the session, so a visitor carrying one would be counted by the HUD
        # pill and drawn by nobody. The id shapes make it impossible; this is the assertion that says so.
        board = self.build(review(), sessions=[desktop(1)])
        ids = {row["id"] for row in board["sessions"]}
        self.assertTrue(ids)
        self.assertEqual(ids & {v["id"] for v in board["visitors"]}, set())

    def test_capped_at_fifty(self):
        many = [review(n, waiting_since=NOW - n * MIN) for n in range(1, 81)]
        board = self.build(*many)
        self.assertEqual(len(board["visitors"]), 50)
        self.assertEqual(board["reviews"]["waiting"], 50)
        self.assertEqual(board["visitors"][0]["number"], 80, "the longest wait is kept")

    def test_hostile_titles_and_logins_are_passed_through_as_data(self):
        nasty = "</script><script>alert(1)</script>"
        board = self.build(review(title=nasty, author=nasty))
        self.assertEqual((board["visitors"][0]["title"], board["visitors"][0]["author"]), (nasty, nasty))

    def test_waiting_on_only_for_prs_the_board_shows(self):
        url9 = "https://github.com/Acme-DataTeam/wonderful-things-core/pull/9"
        other = "https://github.com/Acme-DataTeam/wonderful-things-core/pull/8"
        rec_ = desktop(1, prs=(PullRequest(9, "OPEN", url9),))
        board = self.build(review(), reviewers={url9: ("robin", "web-platform"), other: ("sam",)},
                           sessions=[rec_])
        self.assertEqual(board["reviews"]["waitingOn"], {url9: ["robin", "web-platform"]})
        self.assertEqual(board["sessions"][0]["pr"]["url"], url9)
        self.assertEqual(set(board["sessions"][0]["pr"]), {"number", "state", "url", "verified", "mergedAt"})

    def test_waiting_on_leaves_out_empty_and_unusable_urls(self):
        url9 = "https://github.com/Acme-DataTeam/wonderful-things-core/pull/9"
        rec_ = desktop(1, prs=(PullRequest(9, "OPEN", url9),))
        board = self.build(reviewers={url9: (), "javascript:alert(1)": ("sam",)}, sessions=[rec_])
        self.assertEqual(board["reviews"]["waitingOn"], {})

    def test_build_board_never_mutates_the_snapshot(self):
        reviews = ReviewSnapshot(requests=(review(),), reviewers={"https://github.com/o/r/pull/1": ("sam",)})
        before = (reviews.requests, dict(reviews.reviewers))
        bd.build_board(snap(), NOW, reviews=reviews)
        self.assertEqual((reviews.requests, reviews.reviewers), before)


REVIEW_HEALTH = {"enabled": True, "known": 4, "failed": 0, "lastError": None, "lastCheckedAt": NOW}
UPDATE_HEALTH = {"enabled": True, "reason": None, "state": "current",
                 "latest": {"tag": "v1.1.0", "name": "", "published": NOW}, "version": "v1.1.0", "restart": False,
                 "canPull": True, "running": "a" * 40, "lastError": None, "lastCheckedAt": NOW}


class CheckTests(unittest.TestCase):
    def setUp(self):
        # The real path's update check would ask GitHub about this checkout, so every test here gets a stand-in.
        patcher = mock.patch.object(ck, "load_update_health", return_value=None)
        self.load_updates = patcher.start()
        self.addCleanup(patcher.stop)

    def run_check(self, raw=None, exc=None, done=None, reviews=None, updates=None):
        out = io.StringIO()
        with mock.patch.object(ck.time, "time", return_value=NOW / 1000):
            code = ck.run_check(out=out, scanner=FakeScanner(raw, exc), done=done, reviews=reviews, updates=updates)
        return code, out.getvalue()

    def test_report_format(self):
        code, text_ = self.run_check(check_snapshot(), reviews=REVIEW_HEALTH, updates=UPDATE_HEALTH)
        self.assertEqual(code, 0)
        self.assertEqual(text_, "\n".join([
            "claude code folders  ~/.claude",
            "claude app folders   Claude, Claude-3p (not found)",
            "desktop records      5 (parse errors 0)",
            "registry files       3   live 1   joined to desktop 1",
            "transcripts tailed   1   missing 1",
            "tokens counted       1 of 2 sessions",
            "unknown statuses     none",
            "unknown record types mystery",
            "waiting status now   0",
            "background running   0",
            "versions             app 2.110.0  cli 2.1.271",
            "plan usage           5-hour 42% weekly 17% (sample 12 min old)",
            "code dir outside every session cwd: yes",
            "pr states (app)      open 1 merged 1 closed 0",
            "done marks           0",
            "review source        enabled  known 4  failed 0  last error none",
            "updates              up to date (v1.1.0)",
            "lanes                needs_you 0  errored 0  your_turn 1  running 0  stopped 0  idle 0  open_pr 1  recent 0",
            "                     valhalla 0  castle 1  jail 0  graveyard 2  old 1",
            "health               OK",
        ]) + "\n")

    def test_review_source_line(self):
        cases = [
            (None, "review source        not checked\n"),
            (REVIEW_HEALTH, "review source        enabled  known 4  failed 0  last error none\n"),
            ({"enabled": True, "known": 2, "failed": 3, "lastError": "exit 1", "lastCheckedAt": None},
             "review source        enabled  known 2  failed 3  last error exit 1\n"),
            ({"enabled": False, "known": 0, "failed": 0, "lastError": "gh not found", "lastCheckedAt": None},
             "review source        disabled known 0  failed 0  last error gh not found\n"),
        ]
        for health, line in cases:
            with self.subTest(health=health):
                _, text_ = self.run_check(check_snapshot(), reviews=health)
                self.assertIn(line, text_)

    def test_updates_line(self):
        def health(**kw):
            return {**UPDATE_HEALTH, **kw}

        cases = [
            (None, "not checked"),
            (UPDATE_HEALTH, "up to date (v1.1.0)"),
            (health(state="behind", version="v1.0.0"),
             "v1.1.0 is out, and this copy is older: press Update now in the page"),
            (health(state="ahead", version=None), "ahead of v1.1.0: changes not released yet"),
            (health(state="diverged"), "differs from v1.1.0"),
            (health(state=None), "not checked yet"),
            (health(state=None, latest=None), "no release published yet"),
            (health(state=None, latest=None, lastCheckedAt=None), "not checked yet"),
            (health(state=None, lastError="gh not signed in"), "check failed (gh not signed in): run gh auth login"),
            (health(state=None, lastError="HTTP 401"), "check failed (HTTP 401): run gh auth login"),
            (health(state="behind", lastError="HTTP 404"), "check failed (HTTP 404)"),
            (health(enabled=False, reason="not on main", state=None), "not checked (not on main)"),
            (health(enabled=False, reason="gh not found", state=None, lastError="gh not found"),
             "not checked (gh not found)"),
            (health(enabled=False, reason=None, state=None), "not checked (unknown)"),
        ]
        for value, line in cases:
            with self.subTest(value=value):
                code, text_ = self.run_check(check_snapshot(), updates=value)
                self.assertIn(f"\nupdates              {line}\n", text_)

    def test_gh_not_signed_in_is_a_health_problem(self):
        for error in ("gh not signed in", "HTTP 401"):
            with self.subTest(error=error):
                code, text_ = self.run_check(check_snapshot(), updates={**UPDATE_HEALTH, "lastError": error})
                self.assertEqual(code, 1)
                self.assertTrue(text_.endswith("health               NOT OK (gh not signed in)\n"))
        code, text_ = self.run_check(check_snapshot(desktop_parse_errors=9),
                                     reviews={**REVIEW_HEALTH, "lastError": "gh not signed in"})
        self.assertEqual(code, 1)
        self.assertTrue(text_.endswith("health               NOT OK (parse errors over 5, gh not signed in)\n"))
        for error in ("HTTP 404", "HTTP 403", "exit 1", "TimeoutExpired", "gh not found"):
            with self.subTest(error=error):
                code, text_ = self.run_check(check_snapshot(), updates={**UPDATE_HEALTH, "lastError": error})
                self.assertEqual(code, 0)
                self.assertTrue(text_.endswith("health               OK\n"))

    def test_check_never_runs_an_update_check_with_an_injected_scanner(self):
        _, text_ = self.run_check(check_snapshot())
        self.load_updates.assert_not_called()
        self.assertIn("updates              not checked\n", text_)

    def test_check_never_builds_a_review_source_with_an_injected_scanner(self):
        with mock.patch("town.reviews.ReviewSource", side_effect=AssertionError("must not build a source")):
            _, text_ = self.run_check(check_snapshot())
        self.assertIn("review source        not checked\n", text_)

    def test_every_lane_is_printed_once(self):
        _, text_ = self.run_check(check_snapshot())
        lane_text = text_.split("pr states (app)")[1].split("health")[0]
        for lane in bd.ALL_LANES:
            with self.subTest(lane=lane):
                self.assertEqual(lane_text.count(f" {lane} "), 1)
        self.assertNotIn(" done ", lane_text)
        self.assertNotIn("archived", text_)

    def test_the_lane_line_counts_the_jail(self):
        # check stays offline, so a closed PR only reaches the jail here through the app's own state.
        code, text_ = self.run_check(snap([desktop(1, prs=(PullRequest(1, "CLOSED", None),)), desktop(2)]))
        self.assertIn("  jail 1  ", text_)
        self.assertIn("pr states (app)      open 0 merged 0 closed 1", text_)
        self.assertEqual(code, 0)

    def test_stays_offline(self):
        with mock.patch("subprocess.run", side_effect=AssertionError("check must not run a subprocess")), \
                mock.patch.object(ck, "build_board", wraps=bd.build_board) as spy:
            code, _ = self.run_check(check_snapshot())
        self.assertEqual(code, 0)
        self.assertEqual(spy.call_count, 1)
        args, kwargs = spy.call_args
        self.assertEqual((len(args), kwargs.get("github")), (2, None))

    def test_app_pr_states(self):
        url = "https://github.com/o/r/pull/{}".format
        ds = [
            desktop(1, prs=(PullRequest(1, "OPEN", url(1)), PullRequest(2, "MERGED", url(2)),
                            PullRequest(3, "CLOSED", url(3), dismissed=True))),
            # the same PR linked from a forked session, one copy stale: the most final state wins
            desktop(2, prs=(PullRequest(1, "MERGED", url(1)), PullRequest(2, "OPEN", url(2)))),
            desktop(3, prs=(PullRequest(4, "CLOSED", url(4)), PullRequest(4, "OPEN", url(4)))),
            # no valid url: each link counts on its own
            desktop(4, prs=(PullRequest(7, "OPEN", None), PullRequest(7, "OPEN", "javascript:alert(1)"),
                            PullRequest(8, "DRAFT", url(8)))),
            desktop(5, prs=(PullRequest(9, "OPEN", url(9)),)),
        ]
        self.assertEqual(ck.app_pr_states(snap(ds)), {"OPEN": 3, "MERGED": 2, "CLOSED": 1})
        self.assertEqual(ck.app_pr_states(snap()), {"OPEN": 0, "MERGED": 0, "CLOSED": 0})

    def test_never_prints_titles_or_paths(self):
        _, text_ = self.run_check(check_snapshot(warnings=("/Users/t/clients/acme-secret/x.json",)))
        self.assertNotIn("acme", text_.lower())
        self.assertNotIn("Session", text_)
        self.assertIn("warnings             1\n", text_)

    def test_nothing_found_exits_1_and_says_where_it_looked(self):
        nothing = (SourceFolder("~/.claude", "code", False), SourceFolder("Claude", "app", False),
                   SourceFolder("Claude-3p", "app", False))
        code, text_ = self.run_check(snap(folders=nothing))
        self.assertEqual(code, 1)
        self.assertTrue(text_.startswith("claude code folders  ~/.claude (not found)\n"
                                         "claude app folders   Claude (not found), Claude-3p (not found)\n"))
        self.assertTrue(text_.endswith("health               NOT OK (no Claude Code folder, no sessions found)\n"))

    def test_a_missing_config_dir_is_named(self):
        folders = (SourceFolder("CLAUDE_CONFIG_DIR", "code", False),) + SCANNED_FOLDERS
        code, text_ = self.run_check(check_snapshot(folders=folders))
        self.assertEqual(code, 1)
        self.assertIn("claude code folders  CLAUDE_CONFIG_DIR (not found), ~/.claude\n", text_)
        self.assertTrue(text_.endswith("health               NOT OK (no folder at CLAUDE_CONFIG_DIR)\n"))

    def test_an_injected_scanner_reports_no_folders(self):
        _, text_ = self.run_check(snap([desktop(1)]))
        self.assertIn("claude code folders  not checked\nclaude app folders   not checked\n", text_)

    def test_not_ok_exits_1(self):
        raw = check_snapshot(desktop_parse_errors=9)
        code, text_ = self.run_check(raw)
        self.assertEqual(code, 1)
        self.assertTrue(text_.endswith("health               NOT OK (parse errors over 5)\n"))
        ds = [desktop(1)]
        raw = snap(ds, [entry(ds[0].cli_session_id, status="compacting")])
        code, text_ = self.run_check(raw)
        self.assertEqual(code, 1)
        self.assertIn("unknown statuses     compacting\n", text_)
        self.assertIn("NOT OK (unknown statuses)", text_)

    def test_plan_usage_lines(self):
        cases = [
            (None, "plan usage           none\n"),
            (PlanUsage(None, 5, NOW - 6 * HOUR), "plan usage           5-hour none weekly 5% (sample 360 min old)\n"),
            (PlanUsage(100, 0, NOW - 9 * DAY), "plan usage           5-hour none weekly none (sample 12960 min old)\n"),
            (PlanUsage(3, 4, NOW + 4 * MIN), "plan usage           5-hour 3% weekly 4% (sample 0 min old)\n"),
        ]
        for usage, line in cases:
            with self.subTest(usage=usage):
                code, text_ = self.run_check(check_snapshot(plan_usage=usage))
                self.assertEqual(code, 0)
                self.assertIn(line, text_)
        _, text_ = self.run_check(check_snapshot(tokens={}))
        self.assertIn("tokens counted       0 of 0 sessions\n", text_)

    def test_scan_exception_prints_class_name_only(self):
        code, text_ = self.run_check(exc=PermissionError("/Users/t/clients/acme-secret/config.json"))
        self.assertEqual(code, 1)
        self.assertEqual(text_, "health               NOT OK (scan raised PermissionError)\n")

    def test_lazy_scanner_import(self):
        made = []

        class Scanner(FakeScanner):
            def __init__(self, paths):
                made.append(paths)
                super().__init__(check_snapshot())

        fake = types.ModuleType("town.sources")
        fake.Scanner = Scanner
        sentinel = object()
        out = io.StringIO()
        self.load_updates.return_value = {**UPDATE_HEALTH, "state": "behind", "version": "v1.0.0"}
        with mock.patch.dict(sys.modules, {"town.sources": fake}), \
                mock.patch.object(ck.time, "time", return_value=NOW / 1000):
            code = ck.run_check(paths=sentinel, out=out)
        self.assertEqual((code, made), (0, [sentinel]))
        self.load_updates.assert_called_once_with()
        self.assertIn("updates              v1.1.0 is out, and this copy is older", out.getvalue())

    def test_code_dir_outside(self):
        code_dir = "/nonexistent-town-test/tools/tokentown"
        cases = [
            (dict(cwd="/nonexistent-town-test/tools", origin_cwd="/nonexistent-town-test/other"), None, False),
            (dict(cwd=code_dir, origin_cwd="/nonexistent-town-test/other"), None, False),
            (dict(cwd="/nonexistent-town-test/other", origin_cwd="/"), None, False),
            (dict(cwd="/nonexistent-town-test/other", origin_cwd="/nonexistent-town-test/tools/"), None, False),
            (dict(cwd="/nonexistent-town-test/tools/tokentown2", origin_cwd="/nonexistent-town-test/tools/tokentown2"),
             None, True),
            (dict(cwd="/nonexistent-town-test/other", origin_cwd="/nonexistent-town-test/other"),
             "/nonexistent-town-test", False),
            (dict(cwd="/nonexistent-town-test/other", origin_cwd="/nonexistent-town-test/other"),
             "/nonexistent-town-test/tools/tokentown/web", True),
        ]
        for i, (rec_kw, reg_cwd, expected) in enumerate(cases):
            with self.subTest(i=i):
                d = desktop(1, **rec_kw)
                reg = [entry(d.cli_session_id, cwd=reg_cwd)] if reg_cwd else []
                self.assertEqual(ck.code_dir_outside(snap([d], reg), code_dir), expected)

    def test_code_dir_check_reported_no(self):
        with mock.patch.object(ck.paths_mod, "CODE_DIR", "/nonexistent-town-test/tools/tokentown"):
            raw = snap([desktop(1, cwd="/nonexistent-town-test", origin_cwd="/nonexistent-town-test")])
            _, text_ = self.run_check(raw)
        self.assertIn("code dir outside every session cwd: no\n", text_)

    def test_background_running_and_done_marks_lines(self):
        ds = [desktop(1), desktop(2), desktop(3, last_activity_at=NOW - 60 * DAY)]
        reg = [entry(ds[0].cli_session_id), entry(ds[1].cli_session_id, status="busy")]
        raw = snap(ds, reg, tails={ds[0].cli_session_id: tail(text())},
                   background={ds[0].cli_session_id: bg(shells=1, oldest=NOW - HOUR),
                               ds[1].cli_session_id: bg(shells=2, oldest=NOW - HOUR)})
        done = {ds[2].session_id: NOW - DAY, f"local_{uid(77)}": NOW - DAY}
        code, text_ = self.run_check(raw, done=done)
        self.assertEqual(code, 0)
        self.assertIn("waiting status now   0\nbackground running   1\n", text_)
        self.assertIn("pr states (app)      open 0 merged 0 closed 0\ndone marks           2\n", text_)
        self.assertIn("running 2", text_)
        self.assertIn("valhalla 1", text_)

    def test_done_marks_come_from_the_store_and_are_not_written(self):
        import tempfile
        from pathlib import Path

        from town import done as done_mod
        from town.paths import Paths

        ds = [desktop(1, last_activity_at=NOW - 60 * DAY)]
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(done_mod, "_epoch_ms", return_value=NOW):
            paths = Paths(home=Path(tmp))
            done_mod.DoneStore(paths).mark(ds[0].session_id, NOW - DAY)
            before = (paths.secret_dir / "done.json").read_bytes()

            stores = []

            class Scanner(FakeScanner):
                def __init__(self, got, link_store=None):
                    stores.append(link_store)
                    super().__init__(snap(ds))

            fake = types.ModuleType("town.sources")
            fake.Scanner = Scanner
            out = io.StringIO()
            with mock.patch.dict(sys.modules, {"town.sources": fake}), \
                    mock.patch.object(ck.time, "time", return_value=NOW / 1000), \
                    mock.patch.object(done_mod.DoneStore, "_write", side_effect=AssertionError("check wrote")):
                code = ck.run_check(paths=paths, out=out)
            self.assertEqual((paths.secret_dir / "done.json").read_bytes(), before)
            self.assertEqual(len(stores), 1)
            self.assertTrue(stores[0]._read_only)
            self.assertFalse((paths.secret_dir / "links.json").exists())
        self.assertEqual(code, 0)
        self.assertIn("done marks           1\n", out.getvalue())
        self.assertIn("valhalla 1", out.getvalue())
        self.assertIn("graveyard 0", out.getvalue())

    def test_injected_scanner_never_reads_the_store(self):
        with mock.patch.object(ck, "load_done_marks", side_effect=AssertionError("must not read the store")):
            code, text_ = self.run_check(check_snapshot())
        self.assertEqual(code, 0)
        self.assertIn("done marks           0\n", text_)

    def test_unreadable_store_counts_as_no_marks(self):
        self.assertEqual(ck.load_done_marks(object()), {})
        self.assertEqual(ck.load_done_marks(None), {})


class LoadUpdateHealthTests(unittest.TestCase):
    """`check`'s one gh call: a real UpdateChecker, refreshed once. Stood in for here, so gh never runs."""

    def test_one_refresh_then_its_health(self):
        with mock.patch("town.updates.UpdateChecker") as checker_cls:
            checker = checker_cls.return_value
            checker.health.return_value = UPDATE_HEALTH
            self.assertEqual(ck.load_update_health(), UPDATE_HEALTH)
        checker_cls.assert_called_once_with()
        checker.refresh.assert_called_once_with()

    def test_never_fatal(self):
        for failing in (dict(side_effect=RuntimeError("/Users/t/secret")),
                        dict(return_value=mock.Mock(refresh=mock.Mock(side_effect=OSError("secret"))))):
            with self.subTest(failing=failing), mock.patch("town.updates.UpdateChecker", **failing):
                self.assertIsNone(ck.load_update_health())


class ValhallaAskTests(unittest.TestCase):
    def test_the_latest_typed_message_decides(self):
        ask = prompt(ts=NOW - 10 * MIN, valhalla_ask=True)
        self.assertEqual(bd.valhalla_ask_at(tail(ask, text(ts=NOW - 9 * MIN))), NOW - 10 * MIN)
        # Anything typed after it cancels it, between turns or queued mid-turn.
        self.assertIsNone(bd.valhalla_ask_at(tail(ask, text(ts=NOW - 9 * MIN), prompt(ts=NOW - 5 * MIN))))
        self.assertIsNone(bd.valhalla_ask_at(tail(ask, rec("attachment", queued_prompt=True, timestamp=NOW - 9 * MIN))))
        queued_ask = rec("attachment", queued_prompt=True, valhalla_ask=True, timestamp=NOW - 9 * MIN)
        self.assertEqual(bd.valhalla_ask_at(tail(prompt(ts=NOW - 20 * MIN), queued_ask)), NOW - 9 * MIN)
        # Tool results, task notifications, subagent prompts and meta records are not typed messages.
        others = (result("t1", ts=NOW - 9 * MIN), prompt(ts=NOW - 8 * MIN, task_notification=True),
                  prompt(ts=NOW - 7 * MIN, is_sidechain=True), prompt(ts=NOW - 6 * MIN, is_meta=True))
        self.assertEqual(bd.valhalla_ask_at(tail(ask, *others)), NOW - 10 * MIN)
        self.assertIsNone(bd.valhalla_ask_at(None))
        self.assertIsNone(bd.valhalla_ask_at(tail(text())))

if __name__ == "__main__":
    unittest.main()
