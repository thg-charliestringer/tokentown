from __future__ import annotations

import builtins
import io
import json
import os
import plistlib
import subprocess
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

from town import board, model, paths as paths_mod, sources, status
from town.sources import ProcessChecker, Scanner, read_tail
from tests import fixtures as fx
from tests.fixtures import DAY, HOUR, MARKER, MINUTE, SyntheticHome


def by_session(raw: model.RawSnapshot) -> dict[str, model.DesktopRecord]:
    return {r.session_id: r for r in raw.desktop}


def fixed_line(record: dict, field_path: tuple[str, ...], n: int) -> bytes:
    """Serialise record to exactly n bytes including the newline by padding one string field."""
    target = record
    for key in field_path[:-1]:
        target = target[key]
    target[field_path[-1]] = ""
    base = len(json.dumps(record).encode()) + 1
    if base > n:
        raise ValueError("record too big for the fixed length")
    target[field_path[-1]] = "x" * (n - base)
    line = json.dumps(record).encode() + b"\n"
    assert len(line) == n
    return line


class RecordingLedger:
    """Stands in for usage.TokenLedger: records what the scanner asks for and counts nothing."""

    def __init__(self, fail: Exception | None = None):
        self.updates: list[tuple[list[Path], int]] = []
        self.forgets: list[set[Path]] = []
        self.fail = fail

    def update(self, files, byte_budget):
        self.updates.append(([Path(f) for f in files], byte_budget))
        if self.fail is not None:
            raise self.fail
        return 0

    def totals(self, path):
        return None

    def is_complete(self, path):
        return False

    def forget(self, keep):
        self.forgets.append({Path(p) for p in keep})


class RecordingPrIndex:
    """Stands in for prlinks.PrLinkIndex: records what the scanner asks for and finds nothing."""

    def __init__(self, fail: Exception | None = None, links: dict | None = None):
        self.updates: list[tuple[list[Path], int]] = []
        self.forgets: list[set[Path]] = []
        self.fail = fail
        self.found = links or {}

    def update(self, files, byte_budget):
        self.updates.append(([Path(f) for f in files], byte_budget))
        if self.fail is not None:
            raise self.fail
        return 0

    def links(self, path, sessions=None):
        self.sessions = getattr(self, "sessions", {})
        self.sessions[Path(path)] = None if sessions is None else frozenset(sessions)
        return self.found.get(Path(path), ())

    def is_complete(self, path):
        return False

    def forget(self, keep):
        self.forgets.append({Path(p) for p in keep})


class HomeTestCase(unittest.TestCase):
    def setUp(self):
        self.home = SyntheticHome()
        self.addCleanup(self.home.cleanup)
        self.now = self.home.now_ms


# ---------------------------------------------------------------------------------------------------


class DesktopParsingTests(HomeTestCase):
    def test_fields_mapped(self):
        d = self.home.add_desktop(
            cwd="/w/repo/.claude/worktrees/feat-a", origin_cwd="/w/repo", title="A title", model="claude-opus-5",
            effort="high", branch="claude/feat-a", permission_mode="auto", created_at=self.now - DAY,
            last_activity_at=self.now - HOUR, last_focused_at=self.now - 2 * HOUR, is_archived=True,
            error_at=self.now - HOUR, transcript_unavailable=True)
        rec = by_session(self.home.scanner().scan())[d.session_id]
        self.assertEqual(rec, model.DesktopRecord(
            session_id=d.session_id, cli_session_id=d.cli_session_id, cwd="/w/repo/.claude/worktrees/feat-a",
            origin_cwd="/w/repo", title="A title", model="claude-opus-5", effort="high", branch="claude/feat-a",
            permission_mode="auto", created_at=self.now - DAY, last_activity_at=self.now - HOUR,
            last_focused_at=self.now - 2 * HOUR, is_archived=True, error_at=self.now - HOUR, prs=(),
            transcript_unavailable=True, completed_turns=3))

    def test_optional_fields_absent(self):
        d = self.home.add_desktop(cli_session_id=None, origin_cwd=None, title=None, model=None, effort=None,
                                  branch=None, permission_mode=None)
        rec = by_session(self.home.scanner().scan())[d.session_id]
        self.assertIsNone(rec.cli_session_id)
        self.assertEqual(rec.origin_cwd, rec.cwd)
        for name in ("title", "model", "effort", "branch", "permission_mode", "last_focused_at", "error_at"):
            self.assertIsNone(getattr(rec, name), name)
        self.assertFalse(rec.is_archived)
        self.assertFalse(rec.transcript_unavailable)

    def test_non_uuid_cli_id_is_dropped_and_never_used_as_a_path(self):
        d = self.home.add_desktop(cli_session_id="../../../etc/passwd", last_activity_at=self.now - MINUTE)
        raw = self.home.scanner().scan()
        self.assertIsNone(by_session(raw)[d.session_id].cli_session_id)
        self.assertEqual(raw.tails, {})

    def test_missing_created_at_stays_null_instead_of_last_activity(self):
        h = self.home
        sid = f"local_{fx.uid(515)}"
        (h.desktop_dir / f"{sid}.json").write_text(json.dumps(
            {"sessionId": sid, "cwd": "/w/repo", "lastActivityAt": self.now - HOUR, "completedTurns": 2}))
        raw = h.scanner().scan()
        rec = by_session(raw)[sid]
        self.assertEqual((rec.created_at, rec.last_activity_at), (None, self.now - HOUR))
        self.assertEqual(raw.desktop_parse_errors, 0)
        row = next(r for r in board.build_board(raw, self.now)["sessions"] if r["id"] == sid)
        self.assertIsNone(row["createdAt"])
        self.assertEqual(row["turns"], 2)

    def test_second_timestamps_normalised_to_ms(self):
        d = self.home.add_desktop(extra={"createdAt": 1_789_000_000, "lastActivityAt": 1_789_000_100})
        rec = by_session(self.home.scanner().scan())[d.session_id]
        self.assertEqual(rec.created_at, 1_789_000_000_000)
        self.assertEqual(rec.last_activity_at, 1_789_000_100_000)

    def test_prs_array(self):
        h = self.home
        d = h.add_desktop(prs=[h.pr(5, "open"), h.pr(6, "MERGED", dismissed=True), h.pr(7, "CLOSED", url=None),
                               {"state": "OPEN"}, "junk"])
        rec = by_session(h.scanner().scan())[d.session_id]
        self.assertEqual(rec.prs, (
            model.PullRequest(5, "OPEN", "https://github.com/o/r/pull/5", False),
            model.PullRequest(6, "MERGED", "https://github.com/o/r/pull/6", True),
            model.PullRequest(7, "CLOSED", None, False),
        ))

    def test_legacy_pr_fields(self):
        d = self.home.add_desktop(legacy_pr=self.home.legacy_pr(12, "merged"))
        rec = by_session(self.home.scanner().scan())[d.session_id]
        self.assertEqual(rec.prs, (model.PullRequest(12, "MERGED", "https://github.com/o/r/pull/12"),))

    def test_legacy_pr_already_in_prs_is_not_duplicated(self):
        h = self.home
        d = h.add_desktop(prs=[h.pr(12, "MERGED"), h.pr(13, "OPEN")], legacy_pr=h.legacy_pr(12, "OPEN"))
        rec = by_session(h.scanner().scan())[d.session_id]
        self.assertEqual([p.number for p in rec.prs], [12, 13])
        self.assertEqual(rec.prs[0].state, "MERGED")

    def test_legacy_pr_missing_from_prs_goes_first(self):
        h = self.home
        d = h.add_desktop(prs=[h.pr(20, "OPEN")], legacy_pr=h.legacy_pr(11, "CLOSED"))
        rec = by_session(h.scanner().scan())[d.session_id]
        self.assertEqual([(p.number, p.state) for p in rec.prs], [(11, "CLOSED"), (20, "OPEN")])

    def test_only_local_records_are_read(self):
        h = self.home
        a = h.add_desktop()
        # A local_*.json one level too deep, and one at the right depth but under another org.
        other = h.paths.desktop_sessions_dir / fx.ACCOUNT_UUID / fx.uid(77)
        other.mkdir(parents=True)
        (other / f"local_{fx.uid(78)}.json").write_text(json.dumps(
            {"sessionId": f"local_{fx.uid(78)}", "cwd": "/w/x", "createdAt": self.now, "lastActivityAt": self.now}))
        raw = h.scanner().scan()
        self.assertEqual(sorted(r.session_id for r in raw.desktop), sorted([a.session_id, f"local_{fx.uid(78)}"]))
        self.assertEqual(raw.desktop_parse_errors, 0)

    def test_missing_desktop_dir(self):
        home = SyntheticHome()
        self.addCleanup(home.cleanup)
        for p in sorted(home.paths.desktop_sessions_dir.rglob("*"), reverse=True):
            p.rmdir() if p.is_dir() else p.unlink()
        home.paths.desktop_sessions_dir.rmdir()
        raw = home.scanner().scan()
        self.assertEqual(raw.desktop, ())
        self.assertEqual(raw.desktop_parse_errors, 0)


class DesktopCacheTests(HomeTestCase):
    def opens_of(self, spy: mock.Mock, path: Path) -> int:
        return sum(1 for c in spy.call_args_list if Path(c.args[0]) == path)

    def test_unchanged_files_are_not_reparsed(self):
        h = self.home
        d = h.add_desktop(title="one", mtime_ms=self.now - HOUR)
        scanner = h.scanner()
        with mock.patch.object(sources, "open_for_read", wraps=paths_mod.open_for_read) as spy:
            scanner.scan()
            scanner.scan()
            self.assertEqual(self.opens_of(spy, d.path), 1)
            data = json.loads(d.path.read_text())
            data["title"] = "two"
            d.path.write_text(json.dumps(data))
            fx.set_mtime(d.path, self.now - HOUR + 1000)
            raw = scanner.scan()
            self.assertEqual(self.opens_of(spy, d.path), 2)
        self.assertEqual(by_session(raw)[d.session_id].title, "two")

    def test_parse_error_keeps_last_good_copy(self):
        h = self.home
        d = h.add_desktop(title="good", mtime_ms=self.now - HOUR)
        scanner = h.scanner()
        self.assertEqual(scanner.scan().desktop_parse_errors, 0)
        d.path.write_text('{"sessionId": "trunc')
        fx.set_mtime(d.path, self.now - HOUR + 1000)
        with mock.patch.object(sources, "open_for_read", wraps=paths_mod.open_for_read) as spy:
            raw = scanner.scan()
            self.assertEqual(raw.desktop_parse_errors, 1)
            self.assertEqual(by_session(raw)[d.session_id].title, "good")
            raw = scanner.scan()
            self.assertEqual(raw.desktop_parse_errors, 1)
            self.assertEqual(self.opens_of(spy, d.path), 1)
        data = {"sessionId": d.session_id, "cwd": "/w/repo", "createdAt": self.now, "lastActivityAt": self.now,
                "title": "fixed"}
        d.path.write_text(json.dumps(data))
        fx.set_mtime(d.path, self.now - HOUR + 2000)
        raw = scanner.scan()
        self.assertEqual(raw.desktop_parse_errors, 0)
        self.assertEqual(by_session(raw)[d.session_id].title, "fixed")

    def test_non_finite_numbers_in_desktop_record(self):
        h = self.home
        path = h.desktop_dir / f"local_{fx.uid(510)}.json"
        path.write_text('{"sessionId": "x", "cwd": "/w", "createdAt": NaN, "lastActivityAt": Infinity}')
        path2 = h.desktop_dir / f"local_{fx.uid(511)}.json"
        path2.write_text('{"cwd": "/w", "createdAt": 1789000000000, "lastFocusedAt": -Infinity, "errorAt": NaN}')
        raw = h.scanner().scan()
        self.assertEqual(raw.desktop_parse_errors, 1)
        rec = by_session(raw)[f"local_{fx.uid(511)}"]
        self.assertEqual((rec.last_focused_at, rec.error_at), (None, None))

    def test_parse_error_with_no_good_copy(self):
        h = self.home
        (h.desktop_dir / f"local_{fx.uid(501)}.json").write_text("[1, 2")
        (h.desktop_dir / f"local_{fx.uid(502)}.json").write_text("[1, 2]")
        (h.desktop_dir / f"local_{fx.uid(503)}.json").write_text('{"sessionId": "x"}')
        (h.desktop_dir / f"local_{fx.uid(504)}.json").write_bytes(b"\xff\xfe\x00garbage")
        raw = h.scanner().scan()
        self.assertEqual(raw.desktop, ())
        self.assertEqual(raw.desktop_parse_errors, 4)

    def test_deleted_file_disappears(self):
        h = self.home
        d = h.add_desktop()
        scanner = h.scanner()
        self.assertEqual(len(scanner.scan().desktop), 1)
        d.path.unlink()
        self.assertEqual(scanner.scan().desktop, ())


# ---------------------------------------------------------------------------------------------------


class RegistryTests(HomeTestCase):
    def test_name_filter_spare_and_liveness(self):
        h = self.home
        h.add_registry(pid=101, session_id=fx.uid(1), cwd="/w/a")
        h.add_registry(pid=102, session_id=fx.uid(2), cwd="/w/b", live=False)
        h.add_registry(pid=103, session_id=fx.uid(3), cwd="/w/c", spare=True)
        for name in ("abc.json", "104.json.tmp", "105.JSON", " 106.json", "107.json.bak"):
            (h.paths.sessions_dir / name).write_text(json.dumps({"pid": 104, "sessionId": fx.uid(4), "cwd": "/"}))
        h.live_pids[104] = fx.PROC_START
        raw = h.scanner().scan()
        self.assertEqual(raw.registry_files, 3)
        self.assertEqual([e.pid for e in raw.registry_live], [101])

    def test_pid_inside_file_must_match_name(self):
        h = self.home
        path = h.add_registry(pid=110, session_id=fx.uid(1), cwd="/w/a")
        data = json.loads(path.read_text())
        data["pid"] = 111
        path.write_text(json.dumps(data))
        h.live_pids[111] = fx.PROC_START
        raw = h.scanner().scan()
        self.assertEqual(raw.registry_files, 1)
        self.assertEqual(raw.registry_live, ())

    def test_proc_start_guard(self):
        h = self.home
        h.add_registry(pid=120, session_id=fx.uid(1), cwd="/w/a")
        h.live_pids[120] = "Thu Sep 17 09:00:00 2026"  # the pid now belongs to a different process
        self.assertEqual(h.scanner().scan().registry_live, ())

    def test_fields_and_versions(self):
        h = self.home
        h.add_registry(pid=130, session_id=fx.uid(1), cwd="/w/a", status="waiting", waiting_for="permission prompt",
                       status_updated_at=self.now - MINUTE, started_at=self.now - HOUR, version="2.1.271",
                       entrypoint="claude-desktop")
        h.add_registry(pid=131, session_id=fx.uid(2), cwd="/w/b", status=None, version="2.1.300", entrypoint="cli")
        h.add_registry(pid=132, session_id=fx.uid(3), cwd="/w/c", version="2.1.271")
        h.add_registry(pid=133, session_id=fx.uid(4), cwd="/w/d", version="9.9.9", live=False)
        raw = h.scanner().scan()
        live = {e.pid: e for e in raw.registry_live}
        self.assertEqual(live[130], model.RegistryEntry(
            pid=130, session_id=fx.uid(1), cwd="/w/a", status="waiting", waiting_for="permission prompt",
            status_updated_at=self.now - MINUTE, started_at=self.now - HOUR, version="2.1.271",
            entrypoint="claude-desktop"))
        self.assertIsNone(live[131].status)
        self.assertEqual(raw.cli_versions, ("2.1.271", "2.1.300"))

    def test_bad_registry_files_do_not_raise(self):
        h = self.home
        (h.paths.sessions_dir / "140.json").write_text("{nope")
        (h.paths.sessions_dir / "141.json").write_text("[]")
        (h.paths.sessions_dir / "142.json").write_text(json.dumps({"pid": 142, "cwd": "/w"}))
        (h.paths.sessions_dir / "143.json").mkdir()
        h.add_registry(pid=144, session_id=fx.uid(1), cwd="/w/a")
        raw = h.scanner().scan()
        self.assertEqual(raw.registry_files, 4)
        self.assertEqual([e.pid for e in raw.registry_live], [144])

    def test_injected_checker_that_raises_is_contained(self):
        h = self.home
        h.add_registry(pid=150, session_id=fx.uid(1), cwd="/w/a")
        raw = h.scanner(is_live=mock.Mock(side_effect=RuntimeError("boom"))).scan()
        self.assertEqual(raw.registry_live, ())
        self.assertIn("liveness RuntimeError", raw.warnings)

    def test_missing_sessions_dir(self):
        h = self.home
        for p in h.paths.sessions_dir.iterdir():
            p.unlink()
        h.paths.sessions_dir.rmdir()
        raw = h.scanner().scan()
        self.assertEqual((raw.registry_files, raw.registry_live), (0, ()))


class DefaultLivenessTests(HomeTestCase):
    def ps_result(self, stdout: str, returncode: int = 0):
        return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr="")

    def test_scanner_default_uses_kill_and_ps_with_cache(self):
        h = self.home
        h.add_registry(pid=4242, session_id=fx.uid(1), cwd="/w/a")
        with mock.patch.object(sources.os, "kill") as kill, \
                mock.patch.object(sources.subprocess, "run", return_value=self.ps_result(fx.PROC_START + "   \n")) as run:
            scanner = Scanner(h.paths, now_ms=lambda: self.now, pr_index=RecordingPrIndex())
            self.assertEqual([e.pid for e in scanner.scan().registry_live], [4242])
            self.assertEqual([e.pid for e in scanner.scan().registry_live], [4242])
        kill.assert_called_with(4242, 0)
        lstart = [c for c in run.call_args_list if c.args[0][:2] == ["/bin/ps", "-o"]]
        table = [c for c in run.call_args_list if c.args[0][:2] == ["/bin/ps", "-A"]]
        self.assertEqual((len(lstart), len(table), run.call_count), (1, 1, 2))
        args, kwargs = lstart[0]
        self.assertEqual(args[0], ["/bin/ps", "-o", "lstart=", "-p", "4242"])
        self.assertIs(kwargs["shell"], False)
        self.assertEqual(kwargs["env"]["TZ"], "UTC")
        self.assertEqual(kwargs["env"]["LC_ALL"], "C")
        self.assertIn("timeout", kwargs)
        # The default scanner takes one ps table for the background check, cached between the two scans.
        self.assertEqual(table[0].args[0], ["/bin/ps", "-A", "-o", "pid=,ppid=,etime=,args="])

    def test_start_time_mismatch_is_not_live(self):
        run = mock.Mock(return_value=self.ps_result("Thu Sep 17 09:00:00 2026\n"))
        checker = ProcessChecker(run=run, kill=mock.Mock())
        self.assertFalse(checker(4242, fx.PROC_START))

    def test_dead_pid_skips_ps_and_forgets_cache(self):
        run = mock.Mock(return_value=self.ps_result(fx.PROC_START))
        kill = mock.Mock()
        checker = ProcessChecker(run=run, kill=kill)
        self.assertTrue(checker(4242, fx.PROC_START))
        kill.side_effect = ProcessLookupError()
        self.assertFalse(checker(4242, fx.PROC_START))
        kill.side_effect = None
        self.assertTrue(checker(4242, fx.PROC_START))
        self.assertEqual(run.call_count, 2)

    def test_permission_error_from_kill_is_not_live(self):
        run = mock.Mock()
        checker = ProcessChecker(run=run, kill=mock.Mock(side_effect=PermissionError()))
        self.assertFalse(checker(1, fx.PROC_START))
        run.assert_not_called()

    def test_whitespace_padding_in_lstart_is_normalised(self):
        run = mock.Mock(return_value=self.ps_result("Sun Sep  6 08:00:00 2026  \n"))
        checker = ProcessChecker(run=run, kill=mock.Mock())
        self.assertTrue(checker(4242, "Sun Sep 6 08:00:00 2026"))

    def test_missing_proc_start_or_bad_pid(self):
        run, kill = mock.Mock(), mock.Mock()
        checker = ProcessChecker(run=run, kill=kill)
        self.assertFalse(checker(4242, None))
        self.assertFalse(checker(4242, "   "))
        self.assertFalse(checker(0, fx.PROC_START))
        self.assertFalse(checker(True, fx.PROC_START))
        kill.assert_not_called()
        run.assert_not_called()

    def test_ps_failure_is_not_live(self):
        kill = mock.Mock()
        for effect in (subprocess.TimeoutExpired("ps", 5), OSError()):
            self.assertFalse(ProcessChecker(run=mock.Mock(side_effect=effect), kill=kill)(4242, fx.PROC_START))
        self.assertFalse(ProcessChecker(run=mock.Mock(return_value=self.ps_result("", 1)), kill=kill)(4242, fx.PROC_START))

    def test_scanner_does_not_rerun_ps_for_a_recycled_pid_every_scan(self):
        h = self.home
        h.add_registry(pid=4243, session_id=fx.uid(1), cwd="/w/a")
        with mock.patch.object(sources.os, "kill"), \
                mock.patch.object(sources.subprocess, "run",
                                  return_value=self.ps_result("Thu Sep 17 09:00:00 2026")) as run:
            scanner = Scanner(h.paths, now_ms=lambda: self.now)
            for _ in range(3):
                self.assertEqual(scanner.scan().registry_live, ())
        self.assertEqual(run.call_count, 1)

    def test_recheck_after_interval(self):
        clock = mock.Mock(return_value=0.0)
        run = mock.Mock(return_value=self.ps_result(fx.PROC_START))
        checker = ProcessChecker(run=run, kill=mock.Mock(), clock=clock, recheck_s=300)
        checker(4242, fx.PROC_START)
        clock.return_value = 299.0
        checker(4242, fx.PROC_START)
        self.assertEqual(run.call_count, 1)
        clock.return_value = 301.0
        run.return_value = self.ps_result("Thu Sep 17 09:00:00 2026")
        self.assertFalse(checker(4242, fx.PROC_START))
        self.assertEqual(run.call_count, 2)


# ---------------------------------------------------------------------------------------------------


class TailParsingTests(HomeTestCase):
    def tail_for(self, shape: str) -> model.Tail:
        path = self.home.write_transcript("/w/repo", fx.uid(1), fx.verdict_records(shape, now_ms=self.now))
        return read_tail(path, path.parent / fx.uid(1) / "subagents")

    def last_main(self, tail: model.Tail) -> model.TailRecord:
        return [r for r in tail.records if sources.is_qualifying(r)][-1]

    def test_every_shape_parses_and_leaks_nothing(self):
        for shape in fx.VERDICT_SHAPES:
            with self.subTest(shape=shape):
                tail = self.tail_for(shape)
                self.assertTrue(tail.found)
                self.assertNotIn(MARKER, repr(tail))
                self.assertNotIn("onerror", repr(tail))
                if shape not in ("none", "empty", "unknown_type_after_end"):
                    self.assertEqual(tail.unknown_types, ())

    def test_ended(self):
        rec = self.last_main(self.tail_for("ended"))
        self.assertEqual((rec.type, rec.stop_reason, rec.block_types, rec.tool_uses), ("assistant", "end_turn", ("text",), ()))
        self.assertEqual(rec.timestamp, self.now - MINUTE)
        self.assertIsNone(self.last_main(self.tail_for("ended_null_stop")).stop_reason)

    def test_stop_hook_summary(self):
        rec = self.last_main(self.tail_for("ended_stop_hook"))
        self.assertEqual((rec.type, rec.subtype), ("system", "stop_hook_summary"))

    def test_tool_pending_and_results(self):
        for shape, name in fx.PENDING_TOOL_NAME.items():
            with self.subTest(shape=shape):
                tail = self.tail_for(shape)
                uses = [u for r in tail.records for u in r.tool_uses]
                results = {i for r in tail.records for i in r.tool_result_ids}
                self.assertIn((fx.TOOL_USE_ID, name), uses)
                self.assertNotIn(fx.TOOL_USE_ID, results)
                self.assertIn("toolu_done0000000000000001", results)
                self.assertEqual(tail.records[-1].type, "attachment")
        tail = self.tail_for("model_next_tool_result")
        rec = self.last_main(tail)
        self.assertEqual((rec.type, rec.block_types, rec.tool_result_ids), ("user", ("tool_result",), (fx.TOOL_USE_ID,)))

    def test_user_text_string_content(self):
        rec = self.last_main(self.tail_for("model_next"))
        self.assertEqual((rec.type, rec.block_types, rec.is_meta), ("user", ("text",), False))

    def test_rate_limited_quota_seconds_normalised(self):
        rec = self.last_main(self.tail_for("rate_limited"))
        self.assertTrue(rec.is_api_error)
        self.assertEqual(rec.error_kind, "rate_limit")
        self.assertEqual((rec.quota_status, rec.quota_limit_type), ("rejected", "five_hour"))
        self.assertEqual(rec.quota_resets_at, (self.now + 2 * HOUR) // 1000 * 1000)

    def test_quota_resets_at_already_in_ms(self):
        records = [fx.assistant_api_error(self.now, kind="rate_limit", status=429,
                                          quota=fx.quota_rejected(self.now + HOUR + 123, in_seconds=False))]
        path = self.home.write_transcript("/w/repo", fx.uid(2), records)
        rec = read_tail(path, path.parent / "none").records[-1]
        self.assertEqual(rec.quota_resets_at, self.now + HOUR + 123)

    def test_api_errors(self):
        rec = self.last_main(self.tail_for("api_error"))
        self.assertEqual((rec.is_api_error, rec.error_kind), (True, "server_error"))
        rec = self.last_main(self.tail_for("auth_error"))
        self.assertEqual((rec.is_api_error, rec.error_kind), (True, "authentication_failed"))

    def test_retrying_system_record(self):
        rec = self.last_main(self.tail_for("retrying"))
        self.assertEqual((rec.type, rec.subtype, rec.retry_attempt, rec.max_retries), ("system", "api_error", 2, 10))
        self.assertFalse(rec.is_api_error)
        self.assertEqual(rec.error_kind, "server_error")

    def test_system_api_error_status_mapping(self):
        cases = {429: "rate_limit", 401: "authentication_failed", 403: "authentication_failed", 500: "server_error",
                 529: "server_error", 400: None, None: None}
        for status, kind in cases.items():
            with self.subTest(status=status):
                path = self.home.write_transcript("/w/repo", fx.uid(3), [fx.system_api_error(self.now, status=status)])
                self.assertEqual(read_tail(path, path.parent).records[-1].error_kind, kind)

    def test_sidechain_and_meta_flags(self):
        tail = self.tail_for("sidechain_after_end")
        self.assertTrue(all(r.is_sidechain for r in tail.records[-2:]))
        self.assertEqual(self.last_main(tail).stop_reason, "end_turn")
        tail = self.tail_for("meta_after_end")
        self.assertTrue(tail.records[-1].is_meta)
        self.assertEqual(self.last_main(tail).stop_reason, "end_turn")

    def test_unknown_types(self):
        tail = self.tail_for("unknown_type_after_end")
        self.assertEqual(tail.unknown_types, ("brand-new-record",))
        tail = self.tail_for("none")
        self.assertEqual(tail.unknown_types, ())
        self.assertFalse(any(sources.is_qualifying(r) for r in tail.records))

    def test_empty_transcript(self):
        tail = self.tail_for("empty")
        self.assertEqual((tail.found, tail.records), (True, ()))

    def test_missing_transcript(self):
        missing = self.home.paths.projects_dir / "nope" / f"{fx.uid(9)}.jsonl"
        self.assertEqual(read_tail(missing, missing.parent), model.Tail(found=False, records=(), newest_mtime=None))

    def test_hostile_structure_values_are_dropped(self):
        tool = fx.assistant_tool_use(self.now, "toolu_ok", name="Bash; rm -rf ~")
        bad_id = fx.assistant_tool_use(self.now, "toolu bad id")
        err = fx.assistant_api_error(self.now, kind=fx.HOSTILE)
        weird_type = {"type": fx.HOSTILE}
        weird_stop = fx.assistant_text(self.now, stop_reason=fx.HOSTILE)
        path = self.home.write_transcript("/w/repo", fx.uid(4), [tool, bad_id, err, weird_type, weird_stop])
        tail = read_tail(path, path.parent)
        self.assertNotIn(MARKER, repr(tail))
        self.assertEqual(tail.records[0].tool_uses, (("toolu_ok", "unknown"),))
        self.assertEqual(tail.records[1].tool_uses, ())
        self.assertEqual(tail.records[2].error_kind, "unknown")
        self.assertEqual(tail.records[3].type, "unknown")
        self.assertIsNone(tail.records[4].stop_reason)
        self.assertEqual(tail.unknown_types, ("unknown",))

    def test_garbage_lines_are_skipped(self):
        good = fx.jsonl([fx.user_text(self.now - 2000), fx.assistant_text(self.now - 1000)])
        raw = b"\x00\xff garbage\n[1,2]\n\"str\"\n{\"no\": \"type\"}\n" + good + b'{"type": "assistant", "trunc'
        path = self.home.write_transcript("/w/repo", fx.uid(5), raw=raw)
        tail = read_tail(path, path.parent)
        self.assertEqual([r.type for r in tail.records], ["user", "assistant"])

    def test_timestamp_formats(self):
        cases = {
            "2026-09-16T11:59:00.250Z": self.now - MINUTE + 250,
            "2026-09-16T11:59:00Z": self.now - MINUTE,
            "2026-09-16T12:59:00+01:00": self.now - MINUTE,
            "2026-09-16T11:59:00": self.now - MINUTE,
            "yesterday": None,
            "2026-99-99T00:00:00Z": None,
        }
        records = []
        for text in cases:
            r = fx.user_text(0)
            r["timestamp"] = text
            records.append(r)
        records.append({**fx.user_text(0), "timestamp": 1789})
        path = self.home.write_transcript("/w/repo", fx.uid(6), records)
        got = [r.timestamp for r in read_tail(path, path.parent).records]
        self.assertEqual(got, [*cases.values(), None])

    def test_nan_infinity_and_deep_nesting_do_not_raise(self):
        weird = fx.assistant_api_error(self.now, kind="rate_limit", quota=fx.quota_rejected(self.now))
        line = json.dumps(weird).replace(str((self.now) // 1000), "Infinity").encode() + b"\n"
        retry = json.dumps(fx.system_api_error(self.now)).replace('"retryAttempt": 1', '"retryAttempt": NaN').encode()
        deep = b'{"type": "user", "x": ' + b"[" * 100_000 + b"]" * 100_000 + b"}"
        path = self.home.write_transcript("/w/repo", fx.uid(8), raw=line + retry + b"\n" + deep + b"\n")
        tail = read_tail(path, path.parent)
        types = [r.type for r in tail.records]
        # Python 3.13's json gives up on the deep line, so it is dropped. 3.14's parses it, into a plain user record.
        self.assertIn(types, (["assistant", "system"], ["assistant", "system", "user"]))
        self.assertIsNone(tail.records[0].quota_resets_at)
        self.assertIsNone(tail.records[1].retry_attempt)

    def test_user_list_text_content(self):
        path = self.home.write_transcript("/w/repo", fx.uid(7), [fx.user_text(self.now, as_list=True)])
        self.assertEqual(read_tail(path, path.parent).records[-1].block_types, ("text",))

    def test_every_shape_gives_its_expected_verdict(self):
        for shape, expected in fx.EXPECTED_VERDICT.items():
            with self.subTest(shape=shape):
                self.assertEqual(status.tail_verdict(self.tail_for(shape), self.now).kind, expected)

    def test_local_command_records_are_meta(self):
        tail = self.tail_for("local_command_only")
        users = [r for r in tail.records if r.type == "user"]
        self.assertEqual(len(users), 5)
        self.assertTrue(all(r.is_meta for r in users))
        self.assertFalse(any(sources.is_qualifying(r) for r in tail.records))
        for shape in ("local_command_after_end", "local_command_system_output_after_end", "bash_mode_after_end"):
            with self.subTest(shape=shape):
                self.assertEqual(self.last_main(self.tail_for(shape)).type, "assistant")

    def test_skill_command_and_look_alike_prompts_stay_qualifying(self):
        rec = self.last_main(self.tail_for("skill_command"))
        self.assertEqual((rec.type, rec.is_meta), ("user", False))
        # A command whose output has not been written yet.
        path = self.home.write_transcript("/w/repo", fx.uid(8), [fx.command_name(self.now - 3000)])
        self.assertFalse(read_tail(path, path.parent).records[-1].is_meta)
        path = self.home.write_transcript("/w/repo", fx.uid(9), [
            fx.user_text(self.now - 2000, text="please explain <local-command-stdout> tags"),
            fx.assistant_tool_use(self.now - 1500, "toolu_x", "Bash"),
            fx.user_tool_result(self.now - 1000, "toolu_x"),
        ])
        tail = read_tail(path, path.parent)
        self.assertEqual([r.is_meta for r in tail.records], [False, False, False])
        self.assertEqual(status.tail_verdict(tail, self.now).kind, "MODEL_NEXT")

    def test_session_that_only_ran_local_commands_is_not_stopped(self):
        h = self.home
        d = h.add_desktop(last_activity_at=self.now - HOUR, last_focused_at=self.now - HOUR)
        h.write_transcript(d.cwd, d.cli_session_id,
                           fx.verdict_records("local_command_only", now_ms=self.now, cwd=d.cwd))
        cwd = h.real_dir("term")
        sid = fx.uid(840)
        h.write_transcript(cwd, sid, fx.verdict_records("local_command_only", now_ms=self.now, cwd=cwd,
                                                        entrypoint="cli"), mtime_ms=self.now - HOUR)
        lanes = {r["id"]: r["lane"] for r in board.build_board(h.scanner().scan(), self.now)["sessions"]}
        # The terminal session has ended, so it rests: not stopped, which would have come first.
        self.assertEqual(lanes, {d.session_id: "recent", f"cli:{sid}": "graveyard"})


class TailWindowTests(HomeTestCase):
    def write(self, lines: list[bytes]) -> Path:
        return self.home.write_transcript("/w/repo", fx.uid(1), raw=b"".join(lines))

    def attachments(self, total_bytes: int, line_len: int = 1024) -> list[bytes]:
        return [fixed_line(fx.attachment(self.now), ("attachment", "pad"), line_len)
                for _ in range(total_bytes // line_len)]

    def test_no_doubling_when_window_has_a_qualifying_record(self):
        lines = [fixed_line(fx.user_text(self.now), ("message", "content"), 1024) for _ in range(600)]
        tail = read_tail(self.write(lines), Path("/nonexistent"))
        self.assertEqual(len(tail.records), sources.TAIL_WINDOW // 1024)

    def test_window_starting_mid_line_drops_the_partial_line(self):
        lines = [fixed_line(fx.user_text(self.now), ("message", "content"), 1000) for _ in range(600)]
        tail = read_tail(self.write(lines), Path("/nonexistent"))
        self.assertEqual(len(tail.records), sources.TAIL_WINDOW // 1000)

    def test_window_doubles_until_a_qualifying_record(self):
        head = fixed_line(fx.assistant_text(self.now - HOUR), ("message", "content", 0, "text"), 2048)
        path = self.write([head, *self.attachments(900 * 1024)])
        tail = read_tail(path, Path("/nonexistent"))
        self.assertEqual(tail.records[0].type, "assistant")
        self.assertEqual(len(tail.records), 1 + 900)

    def test_monitor_result_counts_only_with_its_call_in_the_window(self):
        call = json.dumps(monitor_call(self.now - HOUR, "toolu_win")).encode() + b"\n"
        result = json.dumps(monitor_result(self.now, "toolu_win")).encode() + b"\n"
        for pad_kb, launch in ((16, True), (300, False)):
            with self.subTest(pad_kb=pad_kb):
                tail = read_tail(self.write([call, *self.attachments(pad_kb * 1024), result]), Path("/nonexistent"))
                self.assertEqual(tail.records[0].type == "assistant", launch)
                self.assertEqual(tail.records[-1].tool_result_ids, ("toolu_win",))
                self.assertEqual(tail.records[-1].background_launch, launch)

    def test_single_line_bigger_than_the_window(self):
        big = fixed_line(fx.user_text(self.now), ("message", "content"), 300 * 1024)
        path = self.write([fixed_line(fx.assistant_text(self.now - 1), ("message", "content", 0, "text"), 1024), big])
        tail = read_tail(path, Path("/nonexistent"))
        self.assertEqual([r.type for r in tail.records][-1], "user")

    def test_stops_at_four_megabytes(self):
        head = fixed_line(fx.assistant_text(self.now - HOUR), ("message", "content", 0, "text"), 1024)
        path = self.write([head, *self.attachments(4 * 1024 * 1024 + 4096)])
        tail = read_tail(path, Path("/nonexistent"))
        self.assertTrue(tail.found)
        self.assertFalse(any(sources.is_qualifying(r) for r in tail.records))
        self.assertEqual(len(tail.records), sources.TAIL_WINDOW_MAX // 1024)

    def test_reads_at_most_the_max_window(self):
        path = self.write(self.attachments(6 * 1024 * 1024))
        reads: list[int] = []
        real_open = paths_mod.open_for_read

        def spy_open(p, mode="rb"):
            fh = real_open(p, mode)
            real_read = fh.read

            def read(n=-1):
                data = real_read(n)
                reads.append(len(data))
                return data
            fh.read = read
            return fh

        with mock.patch.object(sources, "open_for_read", side_effect=spy_open):
            read_tail(path, Path("/nonexistent"))
        self.assertEqual(reads, [256 * 1024 + 1, 512 * 1024 + 1, 1024 * 1024 + 1, 2048 * 1024 + 1, 4096 * 1024 + 1])


class TailCacheTests(HomeTestCase):
    def setUp(self):
        super().setUp()
        h = self.home
        self.d = h.add_desktop(last_activity_at=self.now - MINUTE)
        self.path = h.write_transcript(self.d.cwd, self.d.cli_session_id,
                                       fx.verdict_records("tool_pending", now_ms=self.now, cwd=self.d.cwd),
                                       mtime_ms=self.now - 10 * MINUTE)

    def test_unchanged_transcript_is_not_reread_but_newest_mtime_refreshes(self):
        h, cli = self.home, self.d.cli_session_id
        # the real ledger and PR link index open the transcript too
        scanner = h.scanner(ledger=RecordingLedger(), pr_index=RecordingPrIndex())
        with mock.patch.object(sources, "open_for_read", wraps=paths_mod.open_for_read) as spy:
            first = scanner.scan().tails[cli]
            self.assertEqual(first.newest_mtime, self.now - 10 * MINUTE)
            h.add_subagent_file(self.d.cwd, cli, "workflows/wf_1/agent-x.jsonl", mtime_ms=self.now - 2 * MINUTE)
            h.add_subagent_file(self.d.cwd, cli, "agent-y.meta.json", mtime_ms=self.now - 5 * MINUTE)
            second = scanner.scan().tails[cli]
            self.assertEqual(second.newest_mtime, self.now - 2 * MINUTE)
            self.assertIs(second.records, first.records)
            transcript_opens = [c for c in spy.call_args_list if Path(c.args[0]) == self.path]
            self.assertEqual(len(transcript_opens), 1)

            h.append_transcript(self.path, [fx.user_tool_result(self.now, fx.TOOL_USE_ID, cwd=self.d.cwd)],
                                mtime_ms=self.now - MINUTE)
            third = scanner.scan().tails[cli]
            self.assertEqual(third.records[-1].tool_result_ids, (fx.TOOL_USE_ID,))
            self.assertEqual(len([c for c in spy.call_args_list if Path(c.args[0]) == self.path]), 2)

    def test_same_size_rewrite_with_new_mtime_is_reread(self):
        scanner = self.home.scanner()
        scanner.scan()
        data = self.path.read_bytes().replace(b'"Bash"', b'"Grep"')
        self.path.write_bytes(data)
        fx.set_mtime(self.path, self.now - 9 * MINUTE)
        uses = [u for r in scanner.scan().tails[self.d.cli_session_id].records for u in r.tool_uses]
        self.assertIn((fx.TOOL_USE_ID, "Grep"), uses)

    def test_files_outside_subagents_do_not_count(self):
        cli = self.d.cli_session_id
        other = self.path.parent / cli / "tool-results" / "big.txt"
        other.parent.mkdir(parents=True)
        other.write_text("x")
        fx.set_mtime(other, self.now)
        self.assertEqual(self.home.scanner().scan().tails[cli].newest_mtime, self.now - 10 * MINUTE)


# ---------------------------------------------------------------------------------------------------


class JoinTests(HomeTestCase):
    def test_which_sessions_are_tailed(self):
        h = self.home
        recent = h.add_desktop(last_activity_at=self.now - 6 * DAY)
        old = h.add_desktop(last_activity_at=self.now - 8 * DAY)
        old_live = h.add_desktop(last_activity_at=self.now - 30 * DAY)
        unavailable = h.add_desktop(last_activity_at=self.now - MINUTE, transcript_unavailable=True)
        no_file = h.add_desktop(last_activity_at=self.now - MINUTE)
        stale_record = h.add_desktop(last_activity_at=self.now - 20 * DAY)
        quit_recently = h.add_desktop(last_activity_at=self.now - 20 * DAY,
                                      extra={"interruptedByQuitAt": self.now - 5 * DAY})
        quit_long_ago = h.add_desktop(last_activity_at=self.now - 20 * DAY,
                                      extra={"interruptedByQuitAt": self.now - 9 * DAY})
        for d in (recent, old_live, unavailable):
            h.write_transcript(d.cwd, d.cli_session_id, fx.verdict_records("ended", now_ms=self.now, cwd=d.cwd))
        for d in (old, quit_recently, quit_long_ago):
            h.write_transcript(d.cwd, d.cli_session_id, fx.verdict_records("ended", now_ms=self.now, cwd=d.cwd),
                               mtime_ms=self.now - 8 * DAY)
        # lastActivityAt lags, but the transcript itself was written within 7 days.
        h.write_transcript(stale_record.cwd, stale_record.cli_session_id,
                           fx.verdict_records("ended", now_ms=self.now, cwd=stale_record.cwd),
                           mtime_ms=self.now - 6 * DAY)
        h.add_registry(pid=300, session_id=old_live.cli_session_id, cwd=old_live.cwd)
        raw = h.scanner().scan()
        self.assertEqual(set(raw.tails), {recent.cli_session_id, old_live.cli_session_id, no_file.cli_session_id,
                                          stale_record.cli_session_id, quit_recently.cli_session_id})
        self.assertEqual(by_session(raw)[quit_recently.session_id].interrupted_by_quit_at, self.now - 5 * DAY)
        self.assertTrue(raw.tails[recent.cli_session_id].found)
        self.assertTrue(raw.tails[old_live.cli_session_id].found)
        self.assertEqual(raw.tails[no_file.cli_session_id], model.Tail(found=False, records=(), newest_mtime=None))
        self.assertEqual(len(raw.registry_live), 1)
        self.assertEqual(raw.registry_live[0].session_id, old_live.cli_session_id)

    def test_stale_last_activity_uses_the_transcript(self):
        h = self.home
        quit_at = self.now - 5 * DAY
        stopped = h.add_desktop(last_activity_at=self.now - 8 * DAY, last_focused_at=self.now - 8 * DAY,
                                extra={"interruptedByQuitAt": quit_at})
        records = fx.verdict_records("ended", now_ms=self.now - 8 * DAY, cwd=stopped.cwd)
        interrupted = [fx.user_text(quit_at - 10, cwd=stopped.cwd), fx.user_text(quit_at, cwd=stopped.cwd)]
        for r in interrupted:
            r["interruptedByShutdown"] = True
        h.write_transcript(stopped.cwd, stopped.cli_session_id, records + interrupted, mtime_ms=quit_at)

        # Live and idle: the app's lastActivityAt is hours old and within the focus grace, but the turn
        # ended well after that focus.
        activity = self.now - 429 * MINUTE
        your_turn = h.add_desktop(last_activity_at=activity, last_focused_at=activity - 60_000)
        h.write_transcript(your_turn.cwd, your_turn.cli_session_id,
                           fx.verdict_records("ended", now_ms=self.now - 73 * MINUTE, cwd=your_turn.cwd))
        h.add_registry(pid=310, session_id=your_turn.cli_session_id, cwd=your_turn.cwd, status="idle")

        rows = {r["id"]: r for r in board.build_board(h.scanner().scan(), self.now)["sessions"]}
        self.assertEqual((rows[stopped.session_id]["lane"], rows[stopped.session_id]["lastActivityAt"],
                          rows[stopped.session_id]["since"]), ("stopped", quit_at, quit_at))
        self.assertEqual(rows[your_turn.session_id]["lane"], "your_turn")
        self.assertEqual(rows[your_turn.session_id]["lastActivityAt"], self.now - 74 * MINUTE)

    def test_live_transcript_found_through_registry_cwd(self):
        h = self.home
        d = h.add_desktop(cwd="/w/repo/.claude/worktrees/moved", last_activity_at=self.now - 30 * DAY)
        h.write_transcript("/w/repo", d.cli_session_id, fx.verdict_records("ended", now_ms=self.now))
        h.add_registry(pid=301, session_id=d.cli_session_id, cwd="/w/repo")
        self.assertTrue(h.scanner().scan().tails[d.cli_session_id].found)

    def test_live_unavailable_transcript_still_tailed(self):
        h = self.home
        d = h.add_desktop(last_activity_at=self.now - 30 * DAY, transcript_unavailable=True)
        h.add_registry(pid=302, session_id=d.cli_session_id, cwd=d.cwd)
        self.assertFalse(h.scanner().scan().tails[d.cli_session_id].found)

    def test_live_registry_without_desktop_record(self):
        h = self.home
        sid = fx.uid(700)
        cwd = h.real_dir("term")
        h.write_transcript(cwd, sid, fx.verdict_records("model_next", now_ms=self.now, cwd=cwd, entrypoint="cli"),
                           mtime_ms=self.now - 30 * DAY)
        h.add_registry(pid=303, session_id=sid, cwd=cwd, entrypoint="cli")
        raw = h.scanner().scan()
        self.assertEqual([c.session_id for c in raw.cli_only], [sid])
        self.assertTrue(raw.tails[sid].found)

    def test_live_registry_without_any_transcript_yet(self):
        h = self.home
        h.add_registry(pid=304, session_id=fx.uid(701), cwd="/w/new")
        h.add_registry(pid=305, session_id="not-a-uuid", cwd="/w/new")
        raw = h.scanner().scan()
        self.assertEqual(raw.cli_only, ())
        self.assertEqual(set(raw.tails), {fx.uid(701)})
        self.assertFalse(raw.tails[fx.uid(701)].found)


class TitleTests(HomeTestCase):
    """A session's title is the one transcript text kept: a rename beats Claude's own summary, the newest wins."""

    def title_of(self, *titles) -> str | None:
        records = [{"type": kind, TITLE_KEY[kind]: value, "sessionId": fx.uid(1)} for kind, value in titles]
        path = self.home.write_transcript("/w/repo", fx.uid(1), [*records, fx.assistant_text(self.now)])
        return read_tail(path, path.parent).title

    def test_a_rename_beats_claudes_own_title(self):
        self.assertEqual(self.title_of(("ai-title", "First summary"), ("custom-title", "My name"),
                                       ("ai-title", "Later summary")), "My name")

    def test_the_newest_title_wins(self):
        self.assertEqual(self.title_of(("ai-title", "One"), ("ai-title", "Two")), "Two")
        self.assertEqual(self.title_of(("custom-title", "A"), ("custom-title", "B")), "B")

    def test_titles_that_are_not_text_are_skipped(self):
        self.assertEqual(self.title_of(("ai-title", "Kept"), ("ai-title", 7), ("ai-title", None), ("ai-title", "   "),
                                       ("ai-title", ["x"]), ("custom-title", {"t": "x"})), "Kept")
        self.assertEqual(self.title_of(("ai-title", "  Padded  ")), "Padded")
        self.assertIsNone(self.title_of())

    def test_a_long_title_is_cut(self):
        self.assertEqual(self.title_of(("ai-title", "x" * 500)), "x" * sources.TITLE_MAX_CHARS)

    def test_the_title_is_the_only_text_kept(self):
        records = [*fx.verdict_records("ended", now_ms=self.now),
                   {"type": "custom-title", "customTitle": fx.HOSTILE, "sessionId": fx.uid(1)}]
        path = self.home.write_transcript("/w/repo", fx.uid(1), records)
        tail = read_tail(path, path.parent)
        self.assertEqual(tail.title, fx.HOSTILE)
        self.assertNotIn(MARKER, repr(model.Tail(tail.found, tail.records, tail.newest_mtime, tail.unknown_types)))

    def test_a_terminal_row_carries_its_title(self):
        h = self.home
        cwd = h.real_dir("titled")
        sid = fx.uid(840)
        h.write_transcript(cwd, sid, fx.verdict_records("ended", now_ms=self.now, cwd=cwd, entrypoint="cli"),
                           mtime_ms=self.now - HOUR)
        raw = h.scanner().scan()
        self.assertEqual(raw.tails[sid].title, fx.CUSTOM_TITLE)
        row = next(r for r in board.build_board(raw, self.now)["sessions"] if r["id"] == f"cli:{sid}")
        self.assertEqual(row["title"], fx.CUSTOM_TITLE)


TITLE_KEY = {"ai-title": "aiTitle", "custom-title": "customTitle"}


class NewestFolderTests(HomeTestCase):
    """A session can move to another folder part way through; its transcript stays filed under the first."""

    def test_the_tail_names_the_newest_main_chain_folder(self):
        h = self.home
        start, moved = h.real_dir("home"), h.real_dir("home/code/tokentown")
        sid = fx.uid(860)
        records = [fx.user_text(self.now - HOUR, cwd=start, entrypoint="cli"),
                   fx.assistant_text(self.now - HOUR + 1000, cwd=start, entrypoint="cli"),
                   fx.user_text(self.now - 2 * MINUTE, cwd=moved, entrypoint="cli"),
                   fx.assistant_text(self.now - MINUTE, cwd="/elsewhere", entrypoint="cli", sidechain=True),
                   {"type": "ai-title", "aiTitle": "Moved", "sessionId": sid, "cwd": 7}]
        h.write_transcript(start, sid, records, mtime_ms=self.now - MINUTE)
        raw = h.scanner().scan()
        self.assertEqual((raw.cli_only[0].cwd, raw.tails[sid].cwd), (start, moved))
        row = next(r for r in board.build_board(raw, self.now)["sessions"] if r["id"] == f"cli:{sid}")
        self.assertEqual(row["repo"], "tokentown")


class CliOnlyTests(HomeTestCase):
    def test_cli_only_row(self):
        h = self.home
        cwd = h.real_dir("cli-repo")
        sid = fx.uid(800)
        records = [{"type": "mode", "mode": "normal", "sessionId": sid},
                   {"type": "permission-mode", "permissionMode": "default", "sessionId": sid},
                   fx.user_text(self.now - HOUR, cwd=cwd, entrypoint="cli")]
        h.write_transcript(cwd, sid, records, mtime_ms=self.now - HOUR)
        raw = h.scanner().scan()
        self.assertEqual(raw.cli_only, (model.CliTranscript(session_id=sid, cwd=cwd, cwd_exists=True,
                                                            last_activity_at=self.now - HOUR, entrypoint="cli"),))
        self.assertTrue(raw.tails[sid].found)

    def test_vscode_session_is_a_cli_row_that_keeps_its_entrypoint(self):
        h = self.home
        cwd = h.real_dir("vscode-repo")
        sid = fx.uid(802)
        records = fx.verdict_records("ended", now_ms=self.now, cwd=cwd, entrypoint="claude-vscode")
        h.write_transcript(cwd, sid, records, mtime_ms=self.now - HOUR)
        raw = h.scanner().scan()
        self.assertEqual(raw.cli_only, (model.CliTranscript(session_id=sid, cwd=cwd, cwd_exists=True,
                                                            last_activity_at=self.now - HOUR,
                                                            entrypoint="claude-vscode"),))

    def test_entrypoint_that_is_not_an_enum_is_dropped(self):
        h = self.home
        cwd = h.real_dir("odd-repo")
        for n, value in enumerate(("claude vscode", "x" * 121, 7, None, ["claude-vscode"])):
            with self.subTest(value=value):
                sid = fx.uid(803 + n)
                records = fx.verdict_records("ended", now_ms=self.now, cwd=cwd)
                for r in records:
                    r["entrypoint"] = value
                h.write_transcript(cwd, sid, records, mtime_ms=self.now - HOUR)
                row = next(c for c in h.scanner().scan().cli_only if c.session_id == sid)
                self.assertIsNone(row.entrypoint)

    def test_missing_cwd_and_old_rows(self):
        h = self.home
        gone = fx.uid(801)
        h.write_transcript("/nowhere/at/all", gone, fx.verdict_records("ended", cwd="/nowhere/at/all", entrypoint="cli"),
                           mtime_ms=self.now - 20 * DAY)
        raw = h.scanner().scan()
        self.assertEqual(raw.cli_only,
                         (model.CliTranscript(gone, "/nowhere/at/all", False, self.now - 20 * DAY, "cli"),))
        self.assertNotIn(gone, raw.tails)

    def test_exclusions(self):
        h = self.home
        prior = fx.uid(810)
        d = h.add_desktop(prior_cli_ids=[prior, "junk"], last_activity_at=self.now - 30 * DAY)
        h.write_transcript(d.cwd, d.cli_session_id, fx.verdict_records("ended", cwd=d.cwd), mtime_ms=self.now - 30 * DAY)
        h.write_transcript(d.cwd, prior, fx.verdict_records("ended", cwd=d.cwd, entrypoint="cli"))
        h.write_transcript("/w/repo", "notes", fx.verdict_records("ended", entrypoint="cli"))
        h.write_transcript("/w/repo", fx.uid(811).upper(), fx.verdict_records("ended", entrypoint="cli"))
        h.add_subagent_file("/w/repo", fx.uid(812), f"{fx.uid(813)}.jsonl",
                            content=fx.jsonl(fx.verdict_records("ended", entrypoint="cli")))
        no_cwd = fx.uid(814)
        h.write_transcript("/w/repo", no_cwd, [{"type": "mode", "mode": "normal"}])
        raw = h.scanner().scan()
        self.assertEqual(raw.cli_only, ())
        self.assertEqual(raw.tails, {})

    def test_head_is_read_once(self):
        h = self.home
        cwd = h.real_dir("cli-repo")
        sid = fx.uid(820)
        path = h.write_transcript(cwd, sid, fx.verdict_records("ended", cwd=cwd, entrypoint="cli"),
                                  mtime_ms=self.now - 30 * DAY)
        scanner = h.scanner(pr_index=RecordingPrIndex())  # the real PR link index reads the whole file too
        with mock.patch.object(sources, "open_for_read", wraps=paths_mod.open_for_read) as spy:
            scanner.scan()
            h.append_transcript(path, [fx.user_text(self.now, cwd="/elsewhere", entrypoint="cli")],
                                mtime_ms=self.now - 29 * DAY)
            raw = scanner.scan()
        self.assertEqual(len([c for c in spy.call_args_list if Path(c.args[0]) == path]), 1)
        self.assertEqual(raw.cli_only[0].cwd, cwd)
        self.assertEqual(raw.cli_only[0].last_activity_at, self.now - 29 * DAY)

    def test_desktop_written_transcript_without_a_record_is_not_a_cli_row(self):
        h = self.home
        cwd = h.real_dir("wt")
        live_cwd = h.real_dir("wt-live")
        h.add_desktop(cwd=cwd, last_activity_at=self.now - HOUR)
        leftover, deleted, terminal, live_leftover = fx.uid(830), fx.uid(831), fx.uid(832), fx.uid(833)
        h.write_transcript(cwd, leftover, fx.verdict_records("model_next", now_ms=self.now, cwd=cwd),
                           mtime_ms=self.now - 2 * HOUR)
        h.write_transcript("/gone/wt", deleted, fx.verdict_records("ended", now_ms=self.now, cwd="/gone/wt"),
                           mtime_ms=self.now - HOUR)
        h.write_transcript(cwd, terminal, fx.verdict_records("ended", now_ms=self.now, cwd=cwd, entrypoint="cli"),
                           mtime_ms=self.now - HOUR)
        h.write_transcript(live_cwd, live_leftover, fx.verdict_records("ended", now_ms=self.now, cwd=live_cwd),
                           mtime_ms=self.now - HOUR)
        h.add_registry(pid=309, session_id=live_leftover, cwd=live_cwd)
        scanner = h.scanner()
        for _ in range(2):  # the second scan answers from the head cache
            raw = scanner.scan()
            self.assertEqual([c.session_id for c in raw.cli_only], [terminal])
            lanes = {r["id"]: r["lane"] for r in board.build_board(raw, self.now)["sessions"]}
            self.assertNotIn(f"cli:{leftover}", lanes)
            self.assertEqual(lanes[f"cli:{terminal}"], "graveyard")
            self.assertNotIn("stopped", lanes.values())

    def test_head_limit(self):
        h = self.home
        sid = fx.uid(821)
        big = fixed_line({"type": "file-history-snapshot", "snapshot": {"x": ""}}, ("snapshot", "x"),
                         sources.HEAD_LIMIT + 10)
        h.write_transcript("/w/repo", sid, raw=big + fx.jsonl([fx.user_text(self.now)]))
        self.assertEqual(h.scanner().scan().cli_only, ())


# ---------------------------------------------------------------------------------------------------


# ---------------------------------------------------------------------------------------------------


class CompletedTurnsTests(HomeTestCase):
    def test_completed_turns_accepts_non_negative_ints_only(self):
        h = self.home
        cases = {3: 3, 0: 0, -1: None, 2.0: None, "4": None, True: None, None: None}
        handles = {value: h.add_desktop(completed_turns=value) for value in cases}
        records = by_session(h.scanner().scan())
        for value, expected in cases.items():
            with self.subTest(value=value):
                self.assertEqual(records[handles[value].session_id].completed_turns, expected)


class PlanUsageTests(HomeTestCase):
    def scan(self, scanner=None):
        return (scanner or self.home.scanner()).scan()

    def test_missing_file_is_none_without_warnings(self):
        raw = self.scan()
        self.assertIsNone(raw.plan_usage)
        self.assertEqual(raw.warnings, ())

    def test_newest_sample_wins_across_orgs_and_no_org_is_kept(self):
        now = self.now
        other_org = "cccccccc-0000-4000-8000-000000000003"
        self.home.write_plan_usage([
            fx.plan_sample(now - 40 * MINUTE, 11, 21),
            fx.plan_sample(now - 10 * MINUTE, 44, 55, org=other_org),
            fx.plan_sample(now - 25 * MINUTE, 12, 22),
        ])
        raw = self.scan()
        self.assertEqual(raw.plan_usage, model.PlanUsage(five_hour_pct=44, weekly_pct=55,
                                                         sampled_at=now - 10 * MINUTE))
        for org in (fx.ORG_UUID, other_org):
            self.assertNotIn(org, repr(raw.plan_usage))
        self.assertNotIn(other_org, json.dumps(board.build_board(raw, now)))

    def test_samples_more_than_five_minutes_ahead_are_ignored_until_the_clock_catches_up(self):
        h = self.home
        clock = [self.now]
        path = h.write_plan_usage([
            fx.plan_sample(self.now - 10 * MINUTE, 10, 1),
            fx.plan_sample(self.now + 6 * MINUTE, 30, 3),
            fx.plan_sample(self.now + 5 * MINUTE, 20, 2),
        ])
        scanner = h.scanner(now_ms=lambda: clock[0])
        with mock.patch.object(sources, "open_for_read", wraps=paths_mod.open_for_read) as spy:
            self.assertEqual(scanner.scan().plan_usage.five_hour_pct, 20)
            clock[0] += MINUTE
            self.assertEqual(scanner.scan().plan_usage.five_hour_pct, 30)
        self.assertEqual(len([c for c in spy.call_args_list if Path(c.args[0]) == path]), 1)

        h.write_plan_usage([fx.plan_sample(clock[0] + 6 * MINUTE)])
        self.assertIsNone(scanner.scan().plan_usage)

    def test_values_are_clamped_and_non_ints_dropped(self):
        cases = [((140, -3), (100, 0)), ((100, 0), (100, 0)), (("50", 12.5), (None, None)),
                 ((True, None), (None, None)), ((7, float("nan")), (7, None))]
        for (fh, sd), expected in cases:
            with self.subTest(fh=fh, sd=sd):
                self.home.write_plan_usage([fx.plan_sample(self.now - MINUTE, fh, sd)])
                pu = self.scan().plan_usage
                self.assertEqual((pu.five_hour_pct, pu.weekly_pct), expected)

    def test_malformed_files_give_none_quietly(self):
        good = {"t": self.now - MINUTE, "org": fx.ORG_UUID, "u": {"fh": 1, "sd": 2}}
        variants = [
            b"", b"not json", b'{"version": 1, "samples": [', b"[]", b'{"version": 1}',
            b'{"version": 1, "samples": {"t": 1}}', b'{"version": 1, "samples": []}',
            json.dumps({"version": 1, "samples": [
                "x", 7, None, {"t": "1789000000000", "u": {"fh": 1}}, {"t": True, "u": {"fh": 1}},
                {"t": self.now, "u": None}, {"t": self.now}, {"t": 1.5e12, "u": {"fh": 1}}]}).encode(),
            b"\xff\xfe\x00garbage", b"[" * 100_000,
        ]
        scanner = self.home.scanner()
        for i, raw_bytes in enumerate(variants):
            with self.subTest(i=i):
                self.home.write_plan_usage(raw=raw_bytes, mtime_ms=self.now - i * MINUTE)
                raw = scanner.scan()
                self.assertIsNone(raw.plan_usage)
                self.assertEqual(raw.warnings, ())
        self.home.write_plan_usage(raw=json.dumps({"samples": [good, {"t": self.now, "u": "bad"}]}).encode())
        self.assertEqual(scanner.scan().plan_usage, model.PlanUsage(1, 2, self.now - MINUTE))

    def test_cached_by_mtime_and_size(self):
        h = self.home
        path = h.write_plan_usage([fx.plan_sample(self.now - MINUTE, 5, 6)], mtime_ms=self.now - HOUR)
        scanner = h.scanner()
        with mock.patch.object(sources, "open_for_read", wraps=paths_mod.open_for_read) as spy:
            for _ in range(3):
                self.assertEqual(scanner.scan().plan_usage.five_hour_pct, 5)
            self.assertEqual(len([c for c in spy.call_args_list if Path(c.args[0]) == path]), 1)
            h.write_plan_usage([fx.plan_sample(self.now - MINUTE, 5, 6), fx.plan_sample(self.now, 9, 9)],
                               mtime_ms=self.now - HOUR)
            self.assertEqual(scanner.scan().plan_usage.five_hour_pct, 9)
            self.assertEqual(len([c for c in spy.call_args_list if Path(c.args[0]) == path]), 2)
        path.unlink()
        self.assertIsNone(scanner.scan().plan_usage)

    def test_oversized_file_is_not_read(self):
        path = self.home.write_plan_usage([fx.plan_sample(self.now - MINUTE)])
        with mock.patch.object(sources, "PLAN_USAGE_MAX_BYTES", path.stat().st_size - 1), \
                mock.patch.object(sources, "open_for_read", wraps=paths_mod.open_for_read) as spy:
            self.assertIsNone(self.scan().plan_usage)
        self.assertEqual([c for c in spy.call_args_list if Path(c.args[0]) == path], [])

    def test_stale_ages_from_file_to_board(self):
        cases = [
            (29 * MINUTE, {"fiveHourPct": 61, "weeklyPct": 33, "stale": False}),
            (31 * MINUTE, {"fiveHourPct": 61, "weeklyPct": 33, "stale": True}),
            (5 * HOUR, {"fiveHourPct": 61, "weeklyPct": 33, "stale": True}),
            (5 * HOUR + MINUTE, {"fiveHourPct": None, "weeklyPct": 33, "stale": True}),
            (8 * DAY, {"fiveHourPct": None, "weeklyPct": None, "stale": True}),
        ]
        for age, expected in cases:
            with self.subTest(age=age):
                self.home.write_plan_usage([fx.plan_sample(self.now - age - DAY, 1, 1),
                                            fx.plan_sample(self.now - age, 61, 33)])
                got = board.build_board(self.scan(), self.now)["planUsage"]
                self.assertEqual(got, {**expected, "sampledAt": self.now - age})

    def test_directory_in_place_of_the_file(self):
        self.home.paths.plan_usage_file.mkdir(parents=True)
        raw = self.scan()
        self.assertIsNone(raw.plan_usage)
        self.assertEqual(raw.warnings, ())


class TokenScanTests(HomeTestCase):
    def usage(self, ts, msg_id, d, **kw):
        return fx.assistant_usage(ts, msg_id, cwd=d.cwd, session_id=d.cli_session_id, **kw)

    def test_main_and_subagent_totals(self):
        h, now = self.home, self.now
        d = h.add_desktop(last_activity_at=now - MINUTE)
        h.write_transcript(d.cwd, d.cli_session_id, [
            fx.user_text(now - 10 * MINUTE, cwd=d.cwd),
            self.usage(now - 9 * MINUTE, "msg_a", d, input=5, output=1, cache_read=100, cache_write=20),
            self.usage(now - 9 * MINUTE, "msg_a", d, input=5, output=40, cache_read=100, cache_write=20),
            self.usage(now - 8 * MINUTE, "msg_b", d, input=7, output=30, cache_read=300, cache_write=50),
            self.usage(now - 7 * MINUTE, "msg_side", d, input=1000, output=2000, cache_read=3000,
                       cache_write=4000, sidechain=True),
            self.usage(now - 6 * MINUTE, "msg_err", d, input=9999, output=9999, model="<synthetic>"),
        ])
        h.add_subagent_file(d.cwd, d.cli_session_id, "agent-a1.jsonl", content=fx.jsonl([
            self.usage(now - 5 * MINUTE, "msg_s1", d, input=11, output=12, cache_read=13, cache_write=14,
                       sidechain=True)]))
        h.add_subagent_file(d.cwd, d.cli_session_id, "workflows/wf_1/agent-b2.jsonl", content=fx.jsonl([
            self.usage(now - 4 * MINUTE, "msg_s2", d, input=21, output=22, cache_read=23, cache_write=24,
                       sidechain=True)]))
        h.add_subagent_file(d.cwd, d.cli_session_id, "agent-a1.meta.json", content=fx.jsonl([
            self.usage(now - 4 * MINUTE, "msg_meta", d, input=10**6, output=10**6)]))
        other = h.transcript_path(d.cwd, d.cli_session_id).parent / d.cli_session_id / "tool-results" / "x.jsonl"
        other.parent.mkdir(parents=True)
        other.write_bytes(fx.jsonl([self.usage(now, "msg_tool", d, output=10**6)]))

        raw = h.scanner().scan()
        self.assertEqual(raw.tokens, {d.cli_session_id: model.SessionTokens(
            main=model.TokenTotals(input=1012, output=2070, cache_read=3400, cache_write=4070, messages=3,
                                   context=357),
            subagents=model.TokenTotals(input=32, output=34, cache_read=36, cache_write=38, messages=2,
                                        context=None),
            complete=True)})
        self.assertNotIn(MARKER, repr(raw.tokens))

        b = board.build_board(raw, now)
        row = next(r for r in b["sessions"] if r["id"] == d.session_id)
        self.assertEqual(row["tokens"], {
            "input": 1012, "output": 2070, "cacheRead": 3400, "cacheWrite": 4070, "context": 357,
            "subagents": {"input": 32, "output": 34, "cacheRead": 36, "cacheWrite": 38}, "complete": True})
        self.assertEqual((row["turns"], row["createdAt"]), (3, now - MINUTE - HOUR))
        self.assertEqual(b["health"]["tokens"], {"tracked": 1, "complete": 1})

    def test_sessions_without_a_transcript_get_no_entry(self):
        h = self.home
        with_file = h.add_desktop(last_activity_at=self.now - MINUTE)
        h.write_transcript(with_file.cwd, with_file.cli_session_id,
                           fx.verdict_records("ended", now_ms=self.now, cwd=with_file.cwd))
        no_file = h.add_desktop(last_activity_at=self.now - MINUTE)
        h.add_registry(pid=320, session_id=fx.uid(720), cwd="/w/new")
        old = h.add_desktop(last_activity_at=self.now - 30 * DAY)
        h.write_transcript(old.cwd, old.cli_session_id, fx.verdict_records("ended", cwd=old.cwd),
                           mtime_ms=self.now - 30 * DAY)
        raw = h.scanner().scan()
        self.assertEqual(set(raw.tails), {with_file.cli_session_id, no_file.cli_session_id, fx.uid(720)})
        self.assertEqual(set(raw.tokens), {with_file.cli_session_id})
        # verdict_records writes 10 input and 5 output tokens on each distinct assistant message.
        main = raw.tokens[with_file.cli_session_id].main
        self.assertEqual((main.input, main.output), (10 * main.messages, 5 * main.messages))
        self.assertGreater(main.messages, 0)
        rows = {r["id"]: r for r in board.build_board(raw, self.now)["sessions"]}
        self.assertIsNone(rows[no_file.session_id]["tokens"])
        self.assertIsNotNone(rows[with_file.session_id]["tokens"])

    def test_symlinked_main_transcript_gets_no_entry(self):
        h = self.home
        d = h.add_desktop(last_activity_at=self.now - MINUTE)
        h.write_transcript(d.cwd, d.cli_session_id, fx.verdict_records("ended", now_ms=self.now, cwd=d.cwd))
        path = h.transcript_path(d.cwd, d.cli_session_id)
        real = path.with_name("elsewhere.data")
        path.rename(real)
        path.symlink_to(real)
        raw = h.scanner().scan()
        self.assertTrue(raw.tails[d.cli_session_id].found)
        self.assertEqual(raw.tokens, {})

    def test_cli_only_session_is_counted(self):
        h = self.home
        cwd = h.real_dir("cli-tokens")
        sid = fx.uid(850)
        h.write_transcript(cwd, sid, [fx.user_text(self.now - HOUR, cwd=cwd, entrypoint="cli"),
                                      fx.assistant_usage(self.now - HOUR, "msg_1", output=77, cwd=cwd,
                                                         entrypoint="cli")], mtime_ms=self.now - HOUR)
        raw = h.scanner().scan()
        self.assertEqual(raw.tokens[sid].main.output, 77)
        row = board.build_board(raw, self.now)["sessions"][0]
        self.assertEqual((row["id"], row["tokens"]["output"], row["turns"], row["createdAt"]),
                         (f"cli:{sid}", 77, None, None))

    def test_warm_scan_opens_nothing_and_appends_are_read_incrementally(self):
        h, now = self.home, self.now
        d = h.add_desktop(last_activity_at=now - MINUTE)
        path = h.write_transcript(d.cwd, d.cli_session_id, [self.usage(now - HOUR, "msg_a", d, output=10)])
        sub = h.add_subagent_file(d.cwd, d.cli_session_id, "agent-1.jsonl",
                                  content=fx.jsonl([self.usage(now - HOUR, "msg_s", d, output=3, sidechain=True)]))
        scanner = h.scanner()
        consumed: list[int] = []
        real_update = scanner._ledger.update

        def update(files, budget):
            consumed.append(real_update(files, budget))
            return consumed[-1]

        scanner._ledger.update = update
        scanner.scan()
        self.assertEqual(consumed, [path.stat().st_size + sub.stat().st_size])
        with mock.patch.object(sources, "open_for_read", wraps=paths_mod.open_for_read) as spy:
            raw = scanner.scan()
            self.assertEqual([c for c in spy.call_args_list if str(c.args[0]).endswith(".jsonl")], [])
            self.assertEqual(consumed[-1], 0)
            self.assertTrue(raw.tokens[d.cli_session_id].complete)

            extra = fx.jsonl([self.usage(now, "msg_b", d, output=9)])
            h.append_transcript(path, [self.usage(now, "msg_b", d, output=9)])
            h.append_transcript(sub, [self.usage(now, "msg_a", d, output=1, sidechain=True)])
            raw = scanner.scan()
        self.assertEqual(consumed[-1], len(extra) + len(fx.jsonl([self.usage(now, "msg_a", d, output=1,
                                                                                sidechain=True)])))
        tokens = raw.tokens[d.cli_session_id]
        self.assertEqual((tokens.main.output, tokens.main.messages, tokens.subagents.output), (19, 2, 4))
        self.assertTrue(tokens.complete)

    def test_rewritten_smaller_transcript_is_recounted(self):
        h = self.home
        d = h.add_desktop(last_activity_at=self.now - MINUTE)
        path = h.write_transcript(d.cwd, d.cli_session_id, [
            self.usage(self.now - HOUR, "msg_a", d, output=100), self.usage(self.now - HOUR, "msg_b", d, output=50)])
        scanner = h.scanner()
        self.assertEqual(scanner.scan().tokens[d.cli_session_id].main.output, 150)
        path.write_bytes(fx.jsonl([self.usage(self.now, "msg_c", d, output=7)]))
        self.assertEqual(scanner.scan().tokens[d.cli_session_id].main.output, 7)

    def test_cold_read_spreads_over_scans_in_priority_order(self):
        h, now = self.home, self.now

        def session(name, last_activity_at, **kw):
            d = h.add_desktop(cwd=f"/w/repo/.claude/worktrees/{name}", last_activity_at=last_activity_at,
                              last_focused_at=last_activity_at)
            records = [fx.assistant_usage(now - HOUR, f"msg_{name}_{i:03d}", output=1, cwd=d.cwd,
                                          session_id=d.cli_session_id) for i in range(40)]
            path = h.write_transcript(d.cwd, d.cli_session_id, records, mtime_ms=last_activity_at, **kw)
            return d, path

        live, live_path = session("wt-live", now - 5 * DAY)
        h.add_registry(pid=330, session_id=live.cli_session_id, cwd=live.cwd)
        recent, recent_path = session("wt-rcnt", now - HOUR)
        older, older_path = session("wt-oldr", now - 2 * DAY)
        sizes = {p.stat().st_size for p in (live_path, recent_path, older_path)}
        self.assertEqual(len(sizes), 1, "the three main transcripts must be the same size")
        h.add_subagent_file(recent.cwd, recent.cli_session_id, "agent-1.jsonl", content=fx.jsonl([
            fx.assistant_usage(now, "msg_sub", output=5, sidechain=True, cwd=recent.cwd)]))

        scanner = h.scanner()
        progress = []
        with mock.patch.object(sources, "TOKEN_BYTES_PER_SCAN", sizes.pop()):
            for _ in range(5):
                raw = scanner.scan()
                t = raw.tokens
                progress.append((t[live.cli_session_id].complete, t[recent.cli_session_id].complete,
                                 t[older.cli_session_id].complete, board.build_board(raw, now)["health"]["tokens"]))
                if _ == 0:
                    self.assertEqual(t[live.cli_session_id].main.output, 40)
                    self.assertEqual(t[recent.cli_session_id].main, model.TokenTotals())
        self.assertEqual(progress, [
            (True, False, False, {"tracked": 3, "complete": 1}),
            (True, False, False, {"tracked": 3, "complete": 1}),  # recent's main is in, its subagent is not
            (True, False, True, {"tracked": 3, "complete": 2}),
            (True, True, True, {"tracked": 3, "complete": 3}),
            (True, True, True, {"tracked": 3, "complete": 3}),
        ])
        self.assertEqual(raw.tokens[recent.cli_session_id].subagents.output, 5)

    def test_priority_order_and_budget_handed_to_the_ledger(self):
        h, now = self.home, self.now
        ledger = RecordingLedger()

        def desktop(name, last_activity_at, mtime_ms):
            d = h.add_desktop(cwd=f"/w/repo/.claude/worktrees/{name}", last_activity_at=last_activity_at)
            path = h.write_transcript(d.cwd, d.cli_session_id, fx.verdict_records("ended", cwd=d.cwd),
                                      mtime_ms=mtime_ms)
            return d, path

        live, live_path = desktop("live", now - 5 * DAY, now - 5 * DAY)
        h.add_registry(pid=340, session_id=live.cli_session_id, cwd=live.cwd)
        stale, stale_path = desktop("stale", now - 20 * DAY, now - 30 * MINUTE)
        recent, recent_path = desktop("recent", now - HOUR, now - HOUR)
        older, older_path = desktop("older", now - 2 * DAY, now - 2 * DAY)
        cli_cwd = h.real_dir("cli-prio")
        cli_sid = fx.uid(860)
        cli_path = h.write_transcript(cli_cwd, cli_sid, fx.verdict_records("ended", cwd=cli_cwd, entrypoint="cli"),
                                      mtime_ms=now - 3 * HOUR)
        sub_old = h.add_subagent_file(recent.cwd, recent.cli_session_id, "agent-old.jsonl", mtime_ms=now - 50 * MINUTE)
        sub_new = h.add_subagent_file(recent.cwd, recent.cli_session_id, "workflows/wf_1/agent-new.jsonl",
                                      mtime_ms=now - 10 * MINUTE)
        h.add_subagent_file(recent.cwd, recent.cli_session_id, "agent-new.meta.json", mtime_ms=now)
        h.add_subagent_file(recent.cwd, recent.cli_session_id, "Local Storage/agent-x.jsonl", mtime_ms=now)
        (sub_old.parent / "agent-dir.jsonl").mkdir()
        sub_older = h.add_subagent_file(older.cwd, older.cli_session_id, "agent-o.jsonl", mtime_ms=now - DAY)

        raw = h.scanner(ledger=ledger).scan()
        expected = [live_path, stale_path, recent_path, cli_path, older_path, sub_new, sub_old, sub_older]
        self.assertEqual(ledger.updates, [(expected, 48 * 1024 * 1024)])
        self.assertEqual(sources.TOKEN_BYTES_PER_SCAN, 48 * 1024 * 1024)
        self.assertEqual(ledger.forgets, [set(expected)])
        self.assertEqual(len(raw.tokens), 5)
        self.assertEqual(raw.tails[recent.cli_session_id].newest_mtime, now)
        for tokens in raw.tokens.values():
            self.assertEqual((tokens.main, tokens.subagents, tokens.complete),
                             (model.TokenTotals(), model.TokenTotals(), False))

    def test_subagent_directories_are_walked_once_per_scan(self):
        h = self.home
        ds = [h.add_desktop(last_activity_at=self.now - MINUTE) for _ in range(3)]
        for d in ds:
            h.write_transcript(d.cwd, d.cli_session_id, fx.verdict_records("ended", cwd=d.cwd))
            h.add_subagent_file(d.cwd, d.cli_session_id, "agent-1.jsonl")
            h.add_subagent_file(d.cwd, d.cli_session_id, "workflows/wf/agent-2.jsonl")
        scanner = h.scanner()
        for _ in range(2):
            with mock.patch.object(sources.os, "walk", wraps=os.walk) as walk:
                raw = scanner.scan()
            roots = sorted(str(c.args[0]) for c in walk.call_args_list)
            self.assertEqual(len(roots), 3)
            self.assertEqual(len(set(roots)), 3)
            self.assertTrue(all(t.complete for t in raw.tokens.values()))

    def test_dropped_session_is_forgotten(self):
        h = self.home
        d = h.add_desktop(last_activity_at=self.now - MINUTE)
        path = h.write_transcript(d.cwd, d.cli_session_id, [self.usage(self.now, "msg_a", d, output=4)])
        sub = h.add_subagent_file(d.cwd, d.cli_session_id, "agent-1.jsonl",
                                  content=fx.jsonl([self.usage(self.now, "msg_s", d, output=2, sidechain=True)]))
        scanner = h.scanner()
        scanner.scan()
        self.assertIsNotNone(scanner._ledger.totals(path))
        d.path.unlink()
        raw = scanner.scan()
        self.assertEqual(raw.tokens, {})
        self.assertIsNone(scanner._ledger.totals(path))
        self.assertIsNone(scanner._ledger.totals(sub))

    def test_ledger_failure_is_contained(self):
        h = self.home
        d = h.add_desktop(last_activity_at=self.now - MINUTE)
        h.write_transcript(d.cwd, d.cli_session_id, fx.verdict_records("ended", cwd=d.cwd))
        raw = h.scanner(ledger=RecordingLedger(fail=RuntimeError(f"/Users/x/{MARKER}"))).scan()
        self.assertEqual(raw.warnings, ("tokens RuntimeError",))
        self.assertFalse(raw.tokens[d.cli_session_id].complete)
        self.assertEqual(len(raw.tails), 1)


# ---------------------------------------------------------------------------------------------------
# Background work: transcript flags, the pure summary, the ps table and the scanner


def tail_rec(rtype: str = "assistant", *, sidechain: bool = False, meta: bool = False, blocks=("text",),
             tools=(), launch: bool = False, notification: bool = False) -> model.TailRecord:
    return model.TailRecord(
        type=rtype, subtype=None, timestamp=None, is_sidechain=sidechain, is_meta=meta, stop_reason=None,
        block_types=tuple(blocks), tool_uses=tuple((f"toolu_{i}", name) for i, name in enumerate(tools)),
        tool_result_ids=(), is_api_error=False, error_kind=None, retry_attempt=None, max_retries=None,
        quota_status=None, quota_resets_at=None, quota_limit_type=None, background_launch=launch,
        task_notification=notification)


def monitor_call(ts: int, tool_use_id: str, name: str = "Monitor", *, sidechain: bool = False, **input_extra) -> dict:
    """A Monitor tool_use as the CLI writes it (2026-09-17): no run_in_background key."""
    return fx.assistant_tool_use(ts, tool_use_id, name, sidechain=sidechain, input_extra={
        "description": fx.HOSTILE, "persistent": False, "timeout_ms": 300000, **input_extra})


def monitor_result(ts: int, tool_use_id: str, task_id: object = f"b9{MARKER}", **kw) -> dict:
    """Its result: taskId, timeoutMs and persistent, and no status."""
    r = fx.user_tool_result(ts, tool_use_id, **kw)
    r["toolUseResult"] = {"persistent": False, "taskId": task_id, "timeoutMs": 300000}
    return r


def task_stop_call(ts: int, tool_use_id: str, **kw) -> dict:
    """A TaskStop tool_use as the CLI writes it (2026-09-17): its input holds only task_id."""
    return fx.assistant_tool_use(ts, tool_use_id, "TaskStop", input_extra={"task_id": fx.HOSTILE}, **kw)


def task_stop_result(ts: int, tool_use_id: str, task_id: object = f"b9{MARKER}", **kw) -> dict:
    """Its result names the stopped task. No notification follows for a task that had not reported yet."""
    r = fx.user_tool_result(ts, tool_use_id, **kw)
    r["toolUseResult"] = {"message": fx.HOSTILE, "task_id": task_id, "task_type": "local_bash", "command": fx.HOSTILE}
    return r


def background_bash_result(ts: int, tool_use_id: str, task_id: object = f"bg{MARKER}", **kw) -> dict:
    """The result of a Bash call run in the background: no status, and the task under backgroundTaskId."""
    r = fx.user_tool_result(ts, tool_use_id, **kw)
    r["toolUseResult"] = {"backgroundTaskId": task_id, "interrupted": False, "isImage": False,
                          "noOutputExpected": False, "stderr": fx.HOSTILE, "stdout": fx.HOSTILE}
    return r


def workflow_result(ts: int, tool_use_id: str, task_id: object = f"w1{MARKER}", **kw) -> dict:
    r = fx.async_tool_result(ts, tool_use_id, **kw)
    r["toolUseResult"] = {"status": "async_launched", "runId": fx.HOSTILE, "taskId": task_id, "summary": fx.HOSTILE}
    return r


def monitor_event(ts: int, *, queued: bool = False) -> dict:
    """A notification from a Monitor that is still armed: an event line, a task id and no status."""
    text = (f"<task-notification>\n<task-id>b9{MARKER}</task-id>\n<summary>{fx.HOSTILE}</summary>\n"
            f"<event>{fx.HOSTILE}</event>\n</task-notification>")
    if not queued:
        return fx.user_text(ts, text=text)
    r = fx.queued_task_notification(ts)
    r["attachment"]["prompt"] = text
    return r


class TailFlagTests(HomeTestCase):
    def records_for(self, records: list[dict]) -> tuple[model.TailRecord, ...]:
        path = self.home.write_transcript("/w/repo", fx.uid(40), records)
        tail = read_tail(path, path.parent / "none")
        self.assertNotIn(MARKER, repr(tail))
        return tail.records

    def test_background_launch_from_the_input_flag_for_bash(self):
        self.assertEqual(sources.BACKGROUND_TOOLS, {"Bash"})
        (rec,) = self.records_for([fx.background_tool_use(self.now, "toolu_bg1", "Bash")])
        self.assertTrue(rec.background_launch)
        self.assertEqual(rec.tool_uses, (("toolu_bg1", "Bash"),))
        self.assertFalse(rec.task_notification)
        for name in ("Agent", "Task", "Workflow", "Monitor"):
            with self.subTest(tool=name):
                # Read from the result instead, so a call that sets the flag is not counted twice.
                (rec,) = self.records_for([fx.background_tool_use(self.now, "toolu_bg1", name)])
                self.assertFalse(rec.background_launch)

    def test_monitor_launch_is_read_from_its_result(self):
        now = self.now
        recs = self.records_for([
            monitor_call(now, "toolu_m1"), monitor_result(now, "toolu_m1"),
            # A flag set anyway still counts once.
            monitor_call(now, "toolu_m2", run_in_background=True), monitor_result(now, "toolu_m2"),
            monitor_call(now, "toolu_m3", persistent=True), fx.assistant_text(now), monitor_result(now, "toolu_m3"),
        ])
        self.assertEqual([r.background_launch for r in recs], [False, True, False, True, False, False, True])
        self.assertEqual(recs[1].tool_result_ids, ("toolu_m1",))
        self.assertEqual(recs[0].tool_uses, (("toolu_m1", "Monitor"),))
        self.assertEqual(sources.tail_background(recs), (3, False))

    def test_monitor_result_needs_a_task_id_and_the_monitor_call_before_it(self):
        now = self.now
        denied = fx.user_tool_result(now, "toolu_d1")
        denied["message"]["content"][0]["is_error"] = True
        denied["toolUseResult"] = f"Error: {fx.HOSTILE}"
        no_key = monitor_result(now, "toolu_d2")
        del no_key["toolUseResult"]["taskId"]
        not_a_dict = monitor_result(now, "toolu_d3")
        not_a_dict["toolUseResult"] = ["taskId", "b9"]
        records = [monitor_call(now, "toolu_d1"), denied, monitor_call(now, "toolu_d2"), no_key,
                   monitor_call(now, "toolu_d3"), not_a_dict]
        for i, task_id in enumerate(("", 7, None, True, ["b9"], {"id": "b9"})):
            records += [monitor_call(now, f"toolu_t{i}"), monitor_result(now, f"toolu_t{i}", task_id=task_id)]
        on_assistant = fx.assistant_text(now)
        on_assistant["message"]["content"] = [{"type": "tool_result", "tool_use_id": "toolu_a1"}]
        on_assistant["toolUseResult"] = {"taskId": "b9"}
        records += [
            # TaskUpdate results carry a taskId too.
            fx.assistant_tool_use(now, "toolu_u1", "TaskUpdate"), monitor_result(now, "toolu_u1"),
            monitor_result(now, "toolu_early"), monitor_call(now, "toolu_early"),
            monitor_call(now, "toolu_c1"), monitor_result(now, "toolu_c2"),
            monitor_call(now, "toolu_l1", name="monitor"), monitor_result(now, "toolu_l1"),
            monitor_call(now, "toolu_a1"), on_assistant,
        ]
        recs = self.records_for(records)
        self.assertEqual([r.background_launch for r in recs], [False] * len(records))

    def test_monitor_is_pending_until_a_notification(self):
        now = self.now
        cases = [
            ([], 1),
            ([fx.assistant_text(now)], 1),
            ([monitor_event(now)], 0),
            ([monitor_event(now, queued=True), fx.assistant_text(now)], 0),
            ([fx.task_notification(now), fx.assistant_text(now)], 0),
        ]
        for after, pending in cases:
            with self.subTest(records=len(after), pending=pending):
                recs = self.records_for([monitor_call(now, "toolu_p1"), monitor_result(now, "toolu_p1"), *after])
                self.assertEqual(sources.tail_background(recs), (pending, False))
        side = self.records_for([monitor_call(now, "toolu_p2", sidechain=True),
                                 monitor_result(now, "toolu_p2", sidechain=True)])
        self.assertTrue(side[1].background_launch)
        self.assertEqual(sources.tail_background(side), (0, False))

    def test_task_stop_uncounts_the_launch_it_names(self):
        now = self.now
        monitor = [monitor_call(now, "toolu_m1"), monitor_result(now, "toolu_m1")]
        bash = [fx.background_tool_use(now, "toolu_b1"), background_bash_result(now, "toolu_b1")]
        agent = [fx.background_tool_use(now, "toolu_a1", "Agent", fx._NOT_GIVEN), fx.async_tool_result(now, "toolu_a1")]
        workflow = [fx.background_tool_use(now, "toolu_w1", "Workflow", fx._NOT_GIVEN), workflow_result(now, "toolu_w1")]
        stop = lambda task_id=f"b9{MARKER}": [task_stop_call(now, "toolu_s1"), task_stop_result(now, "toolu_s1", task_id)]
        failed = task_stop_result(now, "toolu_s1")
        failed["message"]["content"][0]["is_error"] = True
        failed["toolUseResult"] = f"Error: {fx.HOSTILE}"
        end = [fx.assistant_text(now)]
        cases = {
            "monitor stopped before its first event": ([*monitor, *stop(), *end], 0),
            "a failed stop": ([*monitor, task_stop_call(now, "toolu_s1"), failed, *end], 1),
            "background shell stopped": ([*bash, *stop(f"bg{MARKER}"), *end], 0),
            "agent stopped": ([*agent, *stop(fx.HOSTILE), *end], 0),
            "workflow stopped": ([*workflow, *stop(f"w1{MARKER}"), *end], 0),
            "one of two stopped": ([*monitor, *bash, *stop(f"bg{MARKER}"), *end], 1),
            # The stopped monitor had already reported, so the shell launched after that report still runs.
            "a reported monitor stopped after a new launch": ([*monitor, monitor_event(now), *bash, *stop(), *end], 1),
            "a stop naming another task": ([*monitor, *stop("b7"), *end], 1),
            "a stop before the launch it names": ([*stop(), *monitor, *end], 1),
            "a launch whose result names no task": ([fx.background_tool_use(now, "toolu_b2"), *stop(), *end], 1),
            "a stop result with no TaskStop call": ([*monitor, task_stop_result(now, "toolu_x1"), *end], 1),
            "a stop call outside the window order": ([*monitor, task_stop_result(now, "toolu_s9"),
                                                      task_stop_call(now, "toolu_s9"), *end], 1),
        }
        for task_id in ("", 7, None, True, ["b9"]):
            cases[f"task_id {task_id!r}"] = ([*monitor, *stop(task_id), *end], 1)
        for name, (records, pending) in cases.items():
            with self.subTest(case=name):
                self.assertEqual(sources.tail_background(self.records_for(records)), (pending, False))
        stopped = self.records_for([*monitor, *stop(), *end])
        self.assertEqual([r.background_launch for r in stopped], [False] * 5)
        self.assertEqual(stopped[3].tool_result_ids, ("toolu_s1",))

    def test_async_launched_result_is_a_launch_with_or_without_the_flag(self):
        now, missing = self.now, fx._NOT_GIVEN
        recs = self.records_for([
            fx.background_tool_use(now, "toolu_a1", "Agent", missing), fx.async_tool_result(now, "toolu_a1"),
            fx.background_tool_use(now, "toolu_w1", "Workflow", missing), fx.async_tool_result(now, "toolu_w1"),
            fx.background_tool_use(now, "toolu_a2", "Agent"), fx.async_tool_result(now, "toolu_a2"),
            fx.background_tool_use(now, "toolu_a3", "Agent", False),
            fx.async_tool_result(now, "toolu_a3", status="completed"),
            fx.background_tool_use(now, "toolu_w2", "Workflow", "true"),
            fx.async_tool_result(now, "toolu_w2", status="failed"),
        ])
        self.assertEqual([r.background_launch for r in recs],
                         [False, True, False, True, False, True, False, False, False, False])
        self.assertEqual(recs[1].tool_result_ids, ("toolu_a1",))
        self.assertEqual(sources.tail_background(recs), (3, False))

    def test_async_launched_needs_the_exact_status_on_a_user_record(self):
        now = self.now
        shapes = []
        for status_ in ("ASYNC_LAUNCHED", " async_launched", "async_launched\n", ["async_launched"], None, 1, True):
            shapes.append(fx.async_tool_result(now, "toolu_s1", status=status_))
        as_string = fx.user_tool_result(now, "toolu_s2")
        as_string["toolUseResult"] = "async_launched"
        nested = fx.user_tool_result(now, "toolu_s3")
        nested["toolUseResult"] = {"result": {"status": "async_launched"}}
        on_assistant = fx.assistant_text(now)
        on_assistant["toolUseResult"] = {"status": "async_launched"}
        on_attachment = fx.queued_task_notification(now)
        on_attachment["toolUseResult"] = {"status": "async_launched"}
        shapes += [as_string, nested, on_assistant, on_attachment]
        self.assertEqual([r.background_launch for r in self.records_for(shapes)], [False] * len(shapes))

    def test_background_launch_needs_a_literal_true(self):
        for value in (False, fx._NOT_GIVEN, "true", 1, 1.0, None, [True], {"on": True}):
            with self.subTest(value=value):
                (rec,) = self.records_for([fx.background_tool_use(self.now, "toolu_bg2", "Bash", value)])
                self.assertFalse(rec.background_launch)
        for name in ("Read", "bash", "BashOutput", "TaskOutput", "Bash; rm -rf ~"):
            with self.subTest(tool=name):
                (rec,) = self.records_for([fx.background_tool_use(self.now, "toolu_bg3", name)])
                self.assertFalse(rec.background_launch)

    def test_background_launch_odd_shapes(self):
        not_a_dict = fx.background_tool_use(self.now, "toolu_bg4")
        not_a_dict["message"]["content"][0]["input"] = ["run_in_background", True]
        user_block = fx.user_text(self.now, as_list=True)
        user_block["message"]["content"] = [{"type": "tool_use", "id": "toolu_bg5", "name": "Bash",
                                             "input": {"run_in_background": True}}]
        no_id = fx.background_tool_use(self.now, "toolu_bg6")
        del no_id["message"]["content"][0]["id"]
        side = fx.background_tool_use(self.now, "toolu_bg7", sidechain=True)
        recs = self.records_for([not_a_dict, user_block, no_id, side])
        self.assertEqual([r.background_launch for r in recs], [False, False, True, True])
        self.assertTrue(recs[3].is_sidechain)

    def test_valhalla_ask_shapes(self):
        yes = ["ok go to valhalla", "Go to Valhalla!", "valhalla", "send it to valhalla please", "yes, go to valhalla \u2693"]
        no = ["and yes to saying go to valhalla in chat", "Send to Valhalla button on every card", "go to valhalla later",
              "don't go to valhalla", "what is valhalla?", "", "ok go to valhalla " + "x" * 50, None, 12]
        self.assertEqual([t for t in yes if not sources.asks_valhalla(t)], [])
        self.assertEqual([t for t in no if sources.asks_valhalla(t)], [])
        as_blocks = fx.user_text(self.now, text="x")
        as_blocks["message"]["content"] = [{"type": "image", "source": {"data": MARKER}},
                                           {"type": "text", "text": "go to valhalla"}]
        queued = fx.queued_task_notification(self.now, command_mode="prompt")
        queued["attachment"]["prompt"] = "ok go to valhalla"
        queued_other = fx.queued_task_notification(self.now, command_mode="prompt")
        in_tool_result = fx.user_tool_result(self.now, "toolu_v1")
        in_tool_result["message"]["content"][0]["content"] = "go to valhalla"
        assistant_says = fx.assistant_text(self.now)
        assistant_says["message"]["content"] = "go to valhalla"
        recs = self.records_for([fx.user_text(self.now, text="ok go to valhalla"),
                                 fx.user_text(self.now, text="and yes to saying go to valhalla in chat"),
                                 as_blocks, queued, queued_other, in_tool_result, assistant_says])
        self.assertEqual([r.valhalla_ask for r in recs], [True, False, True, True, False, False, False])
        self.assertEqual([r.queued_prompt for r in recs], [False, False, False, True, True, False, False])

    def test_task_notification_shapes(self):
        yes = [
            fx.task_notification(self.now),
            fx.task_notification(self.now, as_list=True),
            fx.task_notification(self.now, lead="\n  \t"),
            fx.queued_task_notification(self.now),
        ]
        image_first = fx.task_notification(self.now, as_list=True)
        image_first["message"]["content"].insert(0, {"type": "image", "source": {"data": MARKER}})
        yes.append(image_first)
        recs = self.records_for(yes)
        self.assertEqual([r.task_notification for r in recs], [True] * 5)
        self.assertEqual([r.is_meta for r in recs], [False] * 5)
        self.assertEqual(recs[0].block_types, ("text",))

        second_text = fx.task_notification(self.now, as_list=True)
        second_text["message"]["content"].insert(0, {"type": "text", "text": MARKER})
        in_tool_result = fx.user_tool_result(self.now, "toolu_n1")
        in_tool_result["message"]["content"][0]["content"] = "<task-notification>x</task-notification>"
        in_tool_result["message"]["content"].append({"type": "text", "text": "<task-notification>"})
        assistant_says = fx.assistant_text(self.now)
        assistant_says["message"]["content"] = "<task-notification>"
        not_text = fx.task_notification(self.now)
        not_text["message"]["content"] = 12
        no = [
            fx.task_notification(self.now, lead=f"{MARKER} "),
            second_text,
            in_tool_result,
            assistant_says,
            not_text,
            fx.user_text(self.now, text="<task-notes>"),
            fx.queued_task_notification(self.now, command_mode="prompt"),
            fx.queued_task_notification(self.now, command_mode=MARKER),
        ]
        other_attachment = fx.queued_task_notification(self.now)
        other_attachment["attachment"]["type"] = "hook_additional_context"
        missing_mode = fx.queued_task_notification(self.now)
        del missing_mode["attachment"]["commandMode"]
        not_a_dict = fx.queued_task_notification(self.now)
        not_a_dict["attachment"] = "queued_command"
        no += [other_attachment, missing_mode, not_a_dict]
        self.assertEqual([r.task_notification for r in self.records_for(no)], [False] * len(no))

    def test_notification_still_starts_a_turn(self):
        recs = self.records_for([*fx.verdict_records("ended", now_ms=self.now - MINUTE),
                                 fx.task_notification(self.now)])
        self.assertTrue(sources.is_qualifying(recs[-1]))
        self.assertEqual(status.tail_verdict(model.Tail(True, recs, self.now), self.now).kind, "MODEL_NEXT")


class TailBackgroundTests(unittest.TestCase):
    def test_launches_after_the_latest_notification(self):
        launch, note = tail_rec(launch=True), tail_rec("user", notification=True)
        queued = tail_rec("attachment", blocks=(), notification=True)
        cases = [
            ((), 0),
            ((launch,), 1),
            ((launch, launch, tail_rec()), 2),
            ((launch, note), 0),
            ((launch, note, launch), 1),
            ((launch, launch, queued, launch, tail_rec("user")), 1),
            ((launch, tail_rec(launch=True, sidechain=True)), 1),
            ((launch, tail_rec("user", notification=True, sidechain=True)), 1),
        ]
        for records, pending in cases:
            with self.subTest(records=len(records), pending=pending):
                self.assertEqual(sources.tail_background(records), (pending, False))

    def test_scheduled_wakeup_in_the_last_turn(self):
        prompt = tail_rec("user")
        wake = tail_rec(blocks=("tool_use",), tools=("ScheduleWakeup",))
        result = tail_rec("user", blocks=("tool_result",))
        cases = [
            ((wake,), True),
            ((prompt, wake, result, tail_rec()), True),
            ((prompt, wake, tail_rec("user", meta=True)), True),
            ((prompt, wake, tail_rec("attachment", blocks=())), True),
            ((wake, prompt, tail_rec()), False),
            ((prompt, tail_rec(blocks=("tool_use",), tools=("ScheduleWakeup",), sidechain=True)), False),
            ((prompt, tail_rec(blocks=("tool_use",), tools=("Bash", "scheduleWakeup"))), False),
            ((prompt, wake, tail_rec("user", notification=True)), False),
        ]
        for records, expected in cases:
            with self.subTest(records=len(records), expected=expected):
                self.assertEqual(sources.tail_background(records)[1], expected)


SHELL = fx.SHELL_ARGS
MCP = fx.MCP_ARGS


class PsTableTests(unittest.TestCase):
    NOW = fx.NOW_MS

    def test_etime_formats(self):
        cases = {b"00:05": 5, b"20:30": 1230, b"59:59": 3599, b"01:02:03": 3723, b"2-03:04:05": 183845,
                 b"123-00:00:01": 123 * 86400 + 1, b"0:07": 7}
        for value, seconds in cases.items():
            with self.subTest(etime=value):
                self.assertEqual(sources.parse_etime(value), seconds)
        for value in (b"", b"5", b"1-02:03", b"60:00", b"00:60", b"1-24:00:00", b"1:2:3:4", b"-1:00", b"aa:bb",
                      b"00:05 ", b"123456-00:00:00", b"\xd9\xa1:00", b"1:5"):
            with self.subTest(etime=value):
                self.assertIsNone(sources.parse_etime(value))

    def test_table_keeps_marked_children_only(self):
        out = fx.ps_table([
            (4911, 1, "3-01:00:00", "/Applications/Claude.app/Contents/MacOS/claude --session x"),
            (5001, 4911, "20:30", SHELL),
            (5002, 5001, "20:30", "sleep 1200"),
            (5003, 4911, "01:00:00", MCP),
            (5004, 4911, "00:10", SHELL),
            (5005, 5001, "00:10", SHELL),  # a shell started by a shell: not a child of the CLI
            (5006, 777, "00:03", f"vim notes-{MARKER}"),
        ]) + b"garbage line\n\n   \nabc 4911 00:01 shell-snapshots\n5007 4911 bad shell-snapshots\n" \
            b"5008 4911 00:01\n" + "５００９ 4911 00:01 shell-snapshots\n".encode()
        table = sources.parse_ps_table(out, self.NOW)
        self.assertEqual(table, {4911: [self.NOW - 1230_000, self.NOW - 10_000], 5001: [self.NOW - 10_000]})
        self.assertNotIn(MARKER, repr(table))

    def test_probe_argv_kwargs_and_results(self):
        ps = fx.FakePs([(5001, 4911, "20:30", SHELL), (5002, 4911, "05:00", SHELL), (5003, 4911, "01:00:00", MCP),
                        (5004, 4912, "00:10", MCP), (5005, 5001, "00:02", SHELL), (5006, 99, "00:02", SHELL)])
        probe = sources.ShellProbe(run=ps)
        warnings: set[str] = set()
        got = probe.children({4911, 4912, 4913}, self.NOW, warnings)
        self.assertEqual(got, {4911: (2, self.NOW - 1230_000), 4912: (0, None), 4913: (0, None)})
        self.assertEqual(warnings, set())
        (argv, kwargs), = ps.calls
        self.assertEqual(argv, ["/bin/ps", "-A", "-o", "pid=,ppid=,etime=,args="])
        self.assertEqual(kwargs, {"shell": False, "timeout": 5, "capture_output": True, "stdin": subprocess.DEVNULL,
                                  "env": {"PATH": "/usr/bin:/bin", "LC_ALL": "C"}})
        self.assertNotIn(MARKER, repr(vars(probe) if hasattr(probe, "__dict__") else probe))

    def test_no_pids_runs_nothing(self):
        ps = fx.FakePs()
        self.assertEqual(sources.ShellProbe(run=ps).children(set(), self.NOW, set()), {})
        self.assertEqual(ps.calls, [])

    def test_table_is_taken_at_most_once_per_interval(self):
        clock = mock.Mock(return_value=100.0)
        ps = fx.FakePs([(5001, 4911, "00:10", SHELL)])
        probe = sources.ShellProbe(run=ps, clock=clock)
        self.assertEqual(probe.children({4911}, self.NOW, set()), {4911: (1, self.NOW - 10_000)})
        ps.rows = []
        for t in (101.0, 104.9):
            clock.return_value = t
            self.assertEqual(probe.children({4911}, self.NOW + 4000, set()), {4911: (1, self.NOW - 10_000)})
        self.assertEqual(len(ps.calls), 1)
        clock.return_value = 105.0
        self.assertEqual(probe.children({4911}, self.NOW + 5000, set()), {4911: (0, None)})
        self.assertEqual(len(ps.calls), 2)

    def test_failures_count_no_shells_and_warn_at_most_once_a_minute(self):
        cases = [
            (dict(raises=subprocess.TimeoutExpired(["/bin/ps"], 5, output=MARKER.encode())), "ps TimeoutExpired"),
            (dict(raises=OSError(MARKER)), "ps OSError"),
            (dict(returncode=1, rows=[(5001, 4911, "00:10", SHELL)]), "ps CalledProcessError"),
            (dict(stdout=f"5001 4911 00:10 {SHELL}\n"), "ps TypeError"),
        ]
        for fake_kw, warning in cases:
            with self.subTest(warning=warning):
                clock = mock.Mock(return_value=0.0)
                probe = sources.ShellProbe(run=fx.FakePs(**fake_kw), clock=clock)
                seen = []
                for t in (0.0, 5.0, 30.0, 59.0, 60.0, 65.0, 119.0, 121.0):
                    clock.return_value = t
                    warnings: set[str] = set()
                    self.assertEqual(probe.children({4911}, self.NOW, warnings), {4911: (0, None)})
                    self.assertNotIn(MARKER, repr(warnings))
                    if warnings:
                        self.assertEqual(warnings, {warning})
                        seen.append(t)
                self.assertEqual(seen, [0.0, 60.0, 121.0])

    def test_recovery_clears_the_error(self):
        clock = mock.Mock(return_value=0.0)
        ps = fx.FakePs(raises=OSError())
        probe = sources.ShellProbe(run=ps, clock=clock)
        probe.children({4911}, self.NOW, set())
        ps.raises = None
        ps.rows = [(5001, 4911, "00:10", SHELL)]
        clock.return_value = 5.0
        warnings: set[str] = set()
        self.assertEqual(probe.children({4911}, self.NOW, warnings), {4911: (1, self.NOW - 10_000)})
        clock.return_value = 70.0
        self.assertEqual(probe.children({4911}, self.NOW, warnings), {4911: (1, self.NOW - 10_000)})
        self.assertEqual(warnings, set())


VSCODE_MAIN = "/Applications/Visual Studio Code.app/Contents/MacOS/Code"
VSCODE_HELPER = ("/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper "
                 "--type=utility")
INSIDERS_HELPER = ("/Applications/Visual Studio Code - Insiders.app/Contents/Frameworks/Code - Insiders Helper "
                   "(Plugin).app/Contents/MacOS/Code - Insiders Helper (Plugin) --type=utility")
CURSOR_HELPER = ("/Users/x/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/"
                 "Cursor Helper (Plugin) --type=utility")


class EditorHostTests(HomeTestCase):
    """`claude` in an editor's own terminal says "cli" like any terminal, and the extension's chat says the same in
    every editor: the editor among a session's ancestors gives away where it runs."""

    NOW = 1_800_000_000_000
    ROWS = [(10, 1, "01:00", VSCODE_MAIN), (20, 10, "00:30", VSCODE_HELPER), (30, 20, "00:20", "/bin/zsh -il"),
            (401, 30, "00:10", f"claude {MARKER}"), (50, 1, "00:30", "/bin/zsh"), (402, 50, "00:10", "claude"),
            (60, 1, "00:40", INSIDERS_HELPER), (403, 60, "00:10", "claude"),
            (70, 1, "00:40", CURSOR_HELPER), (71, 70, "00:30", "/bin/zsh"), (404, 71, "00:10", "claude"),
            (80, 30, "00:05", CURSOR_HELPER), (405, 80, "00:01", "claude")]

    def test_parents_and_the_markers(self):
        parents, editors = sources.parse_ps_parents(fx.ps_table(self.ROWS))
        self.assertEqual(parents, {10: 1, 20: 10, 30: 20, 401: 30, 50: 1, 402: 50, 60: 1, 403: 60, 70: 1, 71: 70,
                                   404: 71, 80: 30, 405: 80})
        self.assertEqual(editors, {10: "vscode", 20: "vscode", 60: "vscode-insiders", 70: "cursor", 80: "cursor"})
        self.assertNotIn(MARKER, repr((parents, editors)))

    def test_editors_of_walks_up_to_the_nearest_editor(self):
        probe = sources.ShellProbe(run=fx.FakePs(self.ROWS))
        probe.children({401, 402, 403, 404, 405}, self.NOW, set())
        self.assertEqual(probe.editors_of({401, 402, 403, 404, 405, 999, 10}),
                         {401: "vscode", 403: "vscode-insiders", 404: "cursor", 405: "cursor"})

    def test_a_loop_or_a_chain_too_long_stops(self):
        chain = [(1000 + i, 1001 + i, "00:10", "/bin/zsh") for i in range(sources.ANCESTOR_STEPS + 2)]
        rows = [(70, 71, "00:10", "claude"), (71, 70, "00:10", "/bin/zsh"), *chain,
                (1000 + sources.ANCESTOR_STEPS + 2, 1, "01:00", VSCODE_MAIN)]
        probe = sources.ShellProbe(run=fx.FakePs(rows))
        probe.children({70, 1000}, self.NOW, set())
        self.assertEqual(probe.editors_of({70, 1000}), {})

    def test_a_failed_table_knows_no_one(self):
        probe = sources.ShellProbe(run=fx.FakePs(raises=OSError(MARKER)))
        probe.children({401}, self.NOW, set())
        self.assertEqual(probe.editors_of({401}), {})

    def test_scan_names_the_editor_each_live_session_runs_under(self):
        h = self.home
        cwd = h.real_dir("vs")
        sids = {pid: fx.uid(450 + pid) for pid in (401, 402, 403, 404)}
        for pid, sid in sids.items():
            h.write_transcript(cwd, sid, fx.verdict_records("ended", now_ms=self.now, cwd=cwd, entrypoint="cli"),
                               mtime_ms=self.now - HOUR)
            h.add_registry(pid=pid, session_id=sid, cwd=cwd, entrypoint="cli")
        h.ps.rows = list(self.ROWS)
        raw = h.scanner().scan()
        self.assertEqual(raw.editor_hosted, {sids[401]: "vscode", sids[403]: "vscode-insiders", sids[404]: "cursor"})
        rows = {r["id"]: r for r in board.build_board(raw, self.now)["sessions"]}
        self.assertEqual({pid: tuple(rows[f"cli:{sid}"][k] for k in ("surface", "editor", "canOpen"))
                          for pid, sid in sids.items()},
                         {401: ("vscode", "vscode", True), 402: ("terminal", None, False),
                          403: ("vscode", "vscode-insiders", True), 404: ("vscode", "cursor", True)})

    def chat(self, sid: str, pid: int | None = None) -> tuple[Path, Path | None]:
        """A Claude Code extension chat's transcript, and its registry file when it is live as pid."""
        h = self.home
        cwd = h.real_dir("chat")
        path = h.write_transcript(cwd, sid, fx.verdict_records("ended", now_ms=self.now, cwd=cwd,
                                                               entrypoint="claude-vscode"), mtime_ms=self.now - HOUR)
        registry = None
        if pid is not None:
            registry = h.add_registry(pid=pid, session_id=sid, cwd=cwd, entrypoint="claude-vscode", status=None)
        return path, registry

    def editor_of(self, raw: model.RawSnapshot, sid: str) -> tuple:
        row = next(r for r in board.build_board(raw, self.now)["sessions"] if r["id"] == f"cli:{sid}")
        return row["surface"], row["live"], row["editor"]

    def test_a_chat_keeps_its_editor_once_it_ends(self):
        """The chat records the same entrypoint in every editor, so one that has ended opens where it was seen."""
        h, sid = self.home, fx.uid(860)
        self.chat(sid, pid=404)
        h.ps.rows = list(self.ROWS)
        scanner = h.scanner()
        self.assertEqual(self.editor_of(scanner.scan(), sid), ("vscode", True, "cursor"))
        del h.live_pids[404]
        raw = scanner.scan()
        self.assertEqual((raw.editor_hosted, raw.editors_seen), ({}, {sid: "cursor"}))
        self.assertEqual(self.editor_of(raw, sid), ("vscode", False, "cursor"))

    def test_a_session_gone_from_disk_is_forgotten(self):
        h, sid = self.home, fx.uid(861)
        transcript, registry = self.chat(sid, pid=404)
        h.ps.rows = list(self.ROWS)
        scanner = h.scanner()
        self.assertEqual(scanner.scan().editors_seen, {sid: "cursor"})
        transcript.unlink()
        registry.unlink()
        self.assertEqual(scanner.scan().editors_seen, {})

    def test_a_chat_never_seen_live_opens_in_the_first_editor_installed(self):
        h, sid = self.home, fx.uid(862)
        self.chat(sid)
        applications = h.paths.system_applications
        cases = [(None, None), (h.home / "Applications" / "Cursor.app", "cursor"),
                 (applications / "Visual Studio Code - Insiders.app", "vscode-insiders"),
                 (applications / "Visual Studio Code.app", "vscode")]
        for app, expected in cases:
            with self.subTest(installed=app.name if app else None):
                if app is not None:
                    app.mkdir(parents=True)
                raw = h.scanner().scan()
                self.assertEqual(raw.default_editor, expected)
                self.assertEqual(self.editor_of(raw, sid), ("vscode", False, expected or "vscode"))


class BackgroundScanTests(HomeTestCase):
    def live(self, name: str, pid: int, records: list[dict] | None, status_: str = "idle"):
        h = self.home
        d = h.add_desktop(cwd=f"/w/repo/.claude/worktrees/{name}", last_activity_at=self.now - 30 * MINUTE)
        if records is not None:
            h.write_transcript(d.cwd, d.cli_session_id, records)
        h.add_registry(pid=pid, session_id=d.cli_session_id, cwd=d.cwd, status=status_)
        return d

    def test_live_sessions_get_background_work(self):
        h, now = self.home, self.now
        base = fx.verdict_records("ended", now_ms=now - 20 * MINUTE)
        shell = self.live("shell", 4911, [*base, fx.background_tool_use(now - 21 * MINUTE, "toolu_b1"),
                                          fx.assistant_text(now - 20 * MINUTE)])
        h.add_shell(4911, etime="20:30")
        h.add_shell(4911, etime="01:00:00", args=fx.MCP_ARGS)
        done = self.live("done", 4912, [*base, fx.background_tool_use(now - 9 * MINUTE, "toolu_b2", "Agent"),
                                        fx.queued_task_notification(now - 8 * MINUTE),
                                        fx.assistant_text(now - 7 * MINUTE)])
        h.add_shell(4912, etime="02:00", args=fx.MCP_ARGS)
        waking = self.live("waking", 4913, [*base, fx.user_text(now - 6 * MINUTE),
                                            fx.assistant_tool_use(now - 5 * MINUTE, "toolu_w", "ScheduleWakeup"),
                                            fx.user_tool_result(now - 5 * MINUTE, "toolu_w"),
                                            fx.assistant_text(now - 5 * MINUTE)])
        no_file = self.live("nofile", 4914, None)
        busy = self.live("busy", 4915, [*base, fx.background_tool_use(now - MINUTE, "toolu_b3")], status_="busy")
        dead = h.add_desktop(cwd="/w/repo/.claude/worktrees/dead", last_activity_at=now - MINUTE)
        h.write_transcript(dead.cwd, dead.cli_session_id, [*base, fx.background_tool_use(now - MINUTE, "toolu_b4")])
        h.add_registry(pid=4916, session_id=dead.cli_session_id, cwd=dead.cwd, live=False)
        h.add_shell(4916)
        h.add_shell(1, pid=4999)  # a shell that belongs to no session

        raw = h.scanner().scan()
        self.assertEqual(raw.background, {
            shell.cli_session_id: model.BackgroundWork(1, now - 1230_000, 1, False),
            done.cli_session_id: model.BackgroundWork(0, None, 0, False),
            waking.cli_session_id: model.BackgroundWork(0, None, 0, True),
            no_file.cli_session_id: model.BackgroundWork(0, None, 0, False),
            busy.cli_session_id: model.BackgroundWork(0, None, 1, False),
        })
        self.assertEqual(len(h.ps.calls), 1)
        self.assertEqual(raw.warnings, ())
        self.assertNotIn(MARKER, repr(raw.background))
        self.assertNotIn(MARKER, repr(raw))

    def test_flagless_agent_or_workflow_still_running_keeps_the_session_in_running(self):
        from town.board import BACKGROUND_HINT, build_board

        h, now = self.home, self.now
        base = fx.verdict_records("ended", now_ms=now - 30 * MINUTE)
        cases = {}
        for i, tool in enumerate(("Workflow", "Agent")):
            tid = f"toolu_async{i}"
            cases[tool] = self.live(f"async-{tool.lower()}", 4960 + i, [
                *base, fx.user_text(now - 20 * MINUTE),
                fx.background_tool_use(now - 19 * MINUTE, tid, tool, fx._NOT_GIVEN),
                fx.async_tool_result(now - 19 * MINUTE, tid), fx.assistant_text(now - 18 * MINUTE)])
        answered = self.live("async-answered", 4970, [
            *base, fx.user_text(now - 20 * MINUTE),
            fx.background_tool_use(now - 19 * MINUTE, "toolu_async9", "Agent", fx._NOT_GIVEN),
            fx.async_tool_result(now - 19 * MINUTE, "toolu_async9"), fx.assistant_text(now - 18 * MINUTE),
            fx.task_notification(now - 10 * MINUTE), fx.assistant_text(now - 9 * MINUTE)])
        sync = self.live("sync-agent", 4971, [
            *base, fx.user_text(now - 20 * MINUTE),
            fx.background_tool_use(now - 19 * MINUTE, "toolu_sync", "Agent", False),
            fx.async_tool_result(now - 15 * MINUTE, "toolu_sync", status="completed"),
            fx.assistant_text(now - 14 * MINUTE)])
        raw = h.scanner().scan()
        rows = {row["id"]: row for row in build_board(raw, now)["sessions"]}
        for tool, d in cases.items():
            with self.subTest(tool=tool):
                self.assertEqual(raw.background[d.cli_session_id], model.BackgroundWork(0, None, 1, False))
                row = rows[d.session_id]
                self.assertEqual((row["lane"], row["canMarkDone"]), ("running", False))
                self.assertTrue(row["hints"][0].startswith(BACKGROUND_HINT))
        for d in (answered, sync):
            self.assertEqual(raw.background[d.cli_session_id], model.BackgroundWork(0, None, 0, False))
            self.assertEqual(rows[d.session_id]["lane"], "your_turn")

    def test_armed_monitor_keeps_the_session_in_running_until_it_reports(self):
        from town.board import BACKGROUND_HINT, build_board

        h, now = self.home, self.now
        base = [*fx.verdict_records("ended", now_ms=now - 30 * MINUTE), fx.user_text(now - 20 * MINUTE)]
        call = monitor_call(now - 19 * MINUTE, "toolu_mon")
        armed = self.live("monitor-armed", 4980, [
            *base, call, monitor_result(now - 19 * MINUTE, "toolu_mon"), fx.assistant_text(now - 18 * MINUTE)])
        reported = self.live("monitor-reported", 4981, [
            *base, call, monitor_result(now - 19 * MINUTE, "toolu_mon"), fx.assistant_text(now - 18 * MINUTE),
            monitor_event(now - 10 * MINUTE), fx.assistant_text(now - 9 * MINUTE)])
        denied_result = fx.user_tool_result(now - 19 * MINUTE, "toolu_mon")
        denied_result["toolUseResult"] = f"Error: {fx.HOSTILE}"
        denied = self.live("monitor-denied", 4982, [*base, call, denied_result, fx.assistant_text(now - 18 * MINUTE)])
        stopped = self.live("monitor-stopped", 4983, [
            *base, call, monitor_result(now - 19 * MINUTE, "toolu_mon"), task_stop_call(now - 18 * MINUTE, "toolu_stop"),
            task_stop_result(now - 18 * MINUTE, "toolu_stop"), fx.assistant_text(now - 18 * MINUTE)])
        raw = h.scanner().scan()
        rows = {row["id"]: row for row in build_board(raw, now)["sessions"]}
        self.assertEqual(raw.background[armed.cli_session_id], model.BackgroundWork(0, None, 1, False))
        row = rows[armed.session_id]
        self.assertEqual((row["lane"], row["canMarkDone"]), ("running", False))
        self.assertTrue(row["hints"][0].startswith(BACKGROUND_HINT))
        for d in (reported, denied, stopped):
            with self.subTest(session=d.cwd.rsplit("/", 1)[-1]):
                self.assertEqual(raw.background[d.cli_session_id], model.BackgroundWork(0, None, 0, False))
                self.assertEqual(rows[d.session_id]["lane"], "your_turn")
        self.assertNotIn(MARKER, repr(raw))

    def test_no_live_session_runs_no_ps(self):
        h = self.home
        d = h.add_desktop(last_activity_at=self.now - MINUTE)
        h.write_transcript(d.cwd, d.cli_session_id, [fx.background_tool_use(self.now, "toolu_b5")])
        h.add_registry(pid=4920, session_id=d.cli_session_id, cwd=d.cwd, live=False)
        h.add_shell(4920)
        raw = h.scanner().scan()
        self.assertEqual((raw.background, h.ps.calls), ({}, []))

    def test_ps_failure_keeps_transcript_signals_and_warns(self):
        h = self.home
        d = self.live("fail", 4930, [fx.background_tool_use(self.now - MINUTE, "toolu_b6"),
                                     fx.assistant_text(self.now)])
        h.add_shell(4930)
        h.ps.raises = subprocess.TimeoutExpired(["/bin/ps"], 5)
        raw = h.scanner().scan()
        self.assertEqual(raw.background[d.cli_session_id], model.BackgroundWork(0, None, 1, False))
        self.assertEqual(raw.warnings, ("ps TimeoutExpired",))

    def test_injected_probe_that_raises_is_contained(self):
        h = self.home
        d = self.live("raise", 4940, [fx.assistant_text(self.now)])
        probe = mock.Mock()
        probe.children.side_effect = RuntimeError(MARKER)
        raw = h.scanner(shells=probe).scan()
        self.assertEqual(raw.background[d.cli_session_id], model.BackgroundWork(0, None, 0, False))
        self.assertEqual(raw.warnings, ("ps RuntimeError",))

    def test_default_scanner_takes_the_table_through_subprocess_run(self):
        h = self.home
        d = self.live("default", 4950, [fx.assistant_text(self.now)])
        table = fx.ps_table([(5001, 4950, "00:42", fx.SHELL_ARGS)])
        with mock.patch.object(sources.subprocess, "run",
                               return_value=subprocess.CompletedProcess([], 0, stdout=table)) as run:
            scanner = Scanner(h.paths, is_live=h.is_live, now_ms=lambda: self.now, pr_index=RecordingPrIndex())
            raw = scanner.scan()
            scanner.scan()
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0], ["/bin/ps", "-A", "-o", "pid=,ppid=,etime=,args="])
        self.assertEqual(raw.background[d.cli_session_id], model.BackgroundWork(1, self.now - 42_000, 0, False))


class PrLinkScanTests(HomeTestCase):
    def desktop(self, name: str, *, activity: int, mtime: int | None = None, links=(), **kw):
        h = self.home
        d = h.add_desktop(cwd=f"/w/repo/.claude/worktrees/{name}", last_activity_at=activity,
                          last_focused_at=activity, **kw)
        path = h.write_transcript(d.cwd, d.cli_session_id,
                                  [fx.user_text(activity - HOUR, cwd=d.cwd), *links,
                                   fx.assistant_text(activity - HOUR, cwd=d.cwd)],
                                  mtime_ms=activity if mtime is None else mtime)
        return d, path

    def test_links_reach_the_snapshot_keyed_by_cli_session(self):
        now = self.now
        d, _ = self.desktop("linked", activity=now - 20 * DAY, links=[
            fx.pr_link(now - 22 * DAY, 531, repo="o/r"),
            fx.pr_link(now - 21 * DAY, 532, repo="o/r"),
            fx.pr_link(now - 20 * DAY - HOUR, 531, repo="o/r"),
            fx.pr_link(now - 20 * DAY, 9, url=f"https://github.com/o/r/pull/9?{MARKER}", prRepository=MARKER),
        ])
        plain, _ = self.desktop("plain", activity=now - HOUR)
        raw = self.home.scanner().scan()
        self.assertEqual(raw.pr_links, {d.cli_session_id: (
            model.PrLink(531, "https://github.com/o/r/pull/531", "o/r", now - 22 * DAY),
            model.PrLink(532, "https://github.com/o/r/pull/532", "o/r", now - 21 * DAY),
            model.PrLink(9, None, None, now - 20 * DAY),
        )})
        self.assertNotIn(plain.cli_session_id, raw.pr_links)
        self.assertNotIn(MARKER, repr(raw.pr_links))

    def test_sixty_day_window(self):
        h, now = self.home, self.now
        link = [fx.pr_link(now - 70 * DAY, 1)]
        inside, _ = self.desktop("inside", activity=now - 59 * DAY, links=link)
        outside, _ = self.desktop("outside", activity=now - 61 * DAY, links=link)
        lagging, _ = self.desktop("lagging", activity=now - 90 * DAY, mtime=now - 10 * DAY, links=link)
        quit_, _ = self.desktop("quit", activity=now - 90 * DAY, links=link,
                                extra={"interruptedByQuitAt": now - 30 * DAY})
        archived, _ = self.desktop("archived", activity=now - 3 * DAY, links=link, is_archived=True)
        cli_cwd = h.real_dir("cli-links")
        cli_in, cli_out = fx.uid(870), fx.uid(871)
        for sid, age in ((cli_in, 59 * DAY), (cli_out, 61 * DAY)):
            h.write_transcript(cli_cwd, sid, [fx.user_text(now - age, cwd=cli_cwd, entrypoint="cli"),
                                              fx.pr_link(now - age, 2)], mtime_ms=now - age)
        raw = h.scanner().scan()
        self.assertEqual(set(raw.pr_links), {inside.cli_session_id, lagging.cli_session_id, quit_.cli_session_id,
                                             archived.cli_session_id, cli_in})
        self.assertNotIn(outside.cli_session_id, raw.pr_links)
        self.assertNotIn(cli_out, raw.pr_links)

    def test_order_and_budget_handed_to_the_index(self):
        h, now = self.home, self.now
        index = RecordingPrIndex()
        live = h.add_desktop(cwd="/w/repo/.claude/worktrees/moved", last_activity_at=now - 40 * DAY)
        live_path = h.write_transcript("/w/repo", live.cli_session_id, fx.verdict_records("ended", now_ms=now),
                                       mtime_ms=now - 2 * HOUR)
        h.add_registry(pid=4960, session_id=live.cli_session_id, cwd="/w/repo")
        recent, recent_path = self.desktop("recent", activity=now - HOUR)
        older, older_path = self.desktop("older", activity=now - 30 * DAY)
        stale, stale_path = self.desktop("stale", activity=now - 50 * DAY, mtime=now - 3 * HOUR)
        linked, linked_path = self.desktop("symlinked", activity=now - 5 * DAY)
        real = linked_path.with_name("elsewhere.data")
        linked_path.rename(real)
        linked_path.symlink_to(real)
        self.desktop("gone", activity=now - DAY)[1].unlink()
        h.add_desktop(cli_session_id=None, last_activity_at=now)
        cli_cwd = h.real_dir("cli-order")
        cli_sid = fx.uid(880)
        cli_path = h.write_transcript(cli_cwd, cli_sid, [fx.user_text(now, cwd=cli_cwd, entrypoint="cli")],
                                      mtime_ms=now - 2 * DAY)
        raw = h.scanner(pr_index=index).scan()
        expected = [recent_path, live_path, stale_path, cli_path, older_path]
        self.assertEqual(index.updates, [(expected, 32 * 1024 * 1024)])
        self.assertEqual(sources.PR_LINK_BYTES_PER_SCAN, 32 * 1024 * 1024)
        self.assertEqual(index.forgets, [set(expected)])
        self.assertEqual(raw.pr_links, {})

    def test_earlier_cli_transcripts_of_a_respawned_session_are_merged(self):
        h, now = self.home, self.now
        old1, old2, missing = fx.uid(890), fx.uid(891), fx.uid(892)
        d = h.add_desktop(cwd="/w/repo/.claude/worktrees/respawn", last_activity_at=now - HOUR,
                          prior_cli_ids=[old1, old2, missing])
        main = h.write_transcript(d.cwd, d.cli_session_id, [fx.pr_link(now - 2 * HOUR, 3)], mtime_ms=now - HOUR)
        first = h.write_transcript(d.cwd, old1, [fx.pr_link(now - 30 * DAY, 1), fx.pr_link(now - 29 * DAY, 2)],
                                   mtime_ms=now - 29 * DAY)
        second = h.write_transcript(d.cwd, old2, [fx.pr_link(now - 10 * DAY, 1), fx.pr_link(now - 29 * DAY, 2)],
                                    mtime_ms=now - 10 * DAY)
        far = h.add_desktop(cwd="/w/repo/.claude/worktrees/far", last_activity_at=now - 90 * DAY,
                            prior_cli_ids=[fx.uid(893)])
        h.write_transcript(far.cwd, far.cli_session_id, [], mtime_ms=now - 90 * DAY)
        h.write_transcript(far.cwd, fx.uid(893), [fx.pr_link(now, 4)], mtime_ms=now)

        index = RecordingPrIndex()
        h.scanner(pr_index=index).scan()
        self.assertEqual(index.updates[0][0], [main, second, first])

        raw = h.scanner().scan()
        self.assertEqual([(link.number, link.timestamp) for link in raw.pr_links[d.cli_session_id]],
                         [(1, now - 30 * DAY), (2, now - 29 * DAY), (3, now - 2 * HOUR)])
        self.assertEqual(set(raw.pr_links), {d.cli_session_id})
        self.assertNotIn(old1, raw.pr_links)
        self.assertEqual({c.session_id for c in raw.cli_only}, set())

    def test_links_copied_from_another_session_do_not_count(self):
        h, now = self.home, self.now
        parent = h.add_desktop(cwd="/w/repo/.claude/worktrees/parent", last_activity_at=now - 3 * HOUR)
        copied = fx.pr_link(now - 4 * HOUR, 41, session_id=parent.cli_session_id)
        h.write_transcript(parent.cwd, parent.cli_session_id, [copied], mtime_ms=now - 3 * HOUR)
        fork = h.add_desktop(cwd="/w/repo/.claude/worktrees/fork", last_activity_at=now - HOUR)
        h.write_transcript(fork.cwd, fork.cli_session_id, [copied, fx.user_text(now - HOUR, cwd=fork.cwd)],
                           mtime_ms=now - HOUR)
        own = h.add_desktop(cwd="/w/repo/.claude/worktrees/own", last_activity_at=now - HOUR)
        h.write_transcript(own.cwd, own.cli_session_id, [copied, fx.pr_link(now - 2 * HOUR, 42, session_id=own.cli_session_id)],
                           mtime_ms=now - HOUR)
        prior = fx.uid(894)
        respawned = h.add_desktop(cwd="/w/repo/.claude/worktrees/respawned", last_activity_at=now - HOUR,
                                  prior_cli_ids=[prior])
        h.write_transcript(respawned.cwd, respawned.cli_session_id, [fx.pr_link(now - 2 * HOUR, 43, session_id=prior)],
                           mtime_ms=now - HOUR)
        index = RecordingPrIndex()
        h.scanner(pr_index=index).scan()
        self.assertEqual(index.sessions[h.paths.transcript_path(respawned.cwd, respawned.cli_session_id)],
                         {respawned.cli_session_id, prior})
        raw = h.scanner().scan()
        self.assertEqual({cli: [g.number for g in got] for cli, got in raw.pr_links.items()}, {
            parent.cli_session_id: [41], own.cli_session_id: [42], respawned.cli_session_id: [43]})

    def test_links_outlive_their_transcript_with_a_link_store(self):
        from town.board import build_board
        from town.linkstore import LinkStore

        h, now = self.home, self.now
        d, path = self.desktop("kept", activity=now - 35 * DAY, links=[fx.pr_link(now - 36 * DAY, 77)])
        gone = h.add_desktop(cwd="/w/repo/.claude/worktrees/gone", last_activity_at=now - 35 * DAY)
        gone_path = h.write_transcript(gone.cwd, gone.cli_session_id, [fx.pr_link(now - 36 * DAY, 78)],
                                       mtime_ms=now - 35 * DAY)
        github = {"https://github.com/o/r/pull/77": model.GitHubPr("MERGED", now - 36 * DAY, now - 36 * DAY, now)}

        raw = h.scanner(link_store=LinkStore(h.paths)).scan()
        self.assertEqual([g.number for g in raw.pr_links[d.cli_session_id]], [77])
        self.assertTrue((h.paths.secret_dir / "links.json").exists())
        row = {r["id"]: r for r in build_board(raw, now, github)["sessions"]}[d.session_id]
        self.assertEqual((row["lane"], row["pr"]["number"]), ("castle", 77))

        # The CLI deletes old transcripts; one desktop record is deleted too. A restarted server still knows #77.
        path.unlink()
        gone_path.unlink()
        gone.path.unlink()
        raw = h.scanner(link_store=LinkStore(h.paths)).scan()
        self.assertEqual(raw.pr_links, {d.cli_session_id: (model.PrLink(77, "https://github.com/o/r/pull/77", None,
                                                                         now - 36 * DAY),)})
        row = {r["id"]: r for r in build_board(raw, now, github)["sessions"]}[d.session_id]
        self.assertEqual((row["lane"], row["pr"]["number"], row["valhallaReason"]), ("castle", 77, "merged"))
        self.assertEqual(h.scanner().scan().pr_links, {})
        self.assertNotIn(MARKER, (h.paths.secret_dir / "links.json").read_text())

    def test_link_store_failures_are_contained(self):
        h, now = self.home, self.now
        d, _ = self.desktop("store", activity=now - HOUR, links=[fx.pr_link(now - HOUR, 5)])
        broken = mock.Mock()
        broken.sessions.side_effect = RuntimeError(MARKER)
        raw = h.scanner(link_store=broken).scan()
        self.assertEqual(([g.number for g in raw.pr_links[d.cli_session_id]], raw.warnings), ([5], ("pr link store RuntimeError",)))
        full = mock.Mock()
        full.sessions.return_value = {d.cli_session_id: (model.PrLink(4, "https://github.com/o/r/pull/4", None, now - DAY),)}
        full.remember.side_effect = OSError(MARKER)
        raw = h.scanner(link_store=full).scan()
        self.assertEqual(([g.number for g in raw.pr_links[d.cli_session_id]], raw.warnings), ([4, 5], ("pr link store OSError",)))

    def test_cold_read_spreads_over_scans_and_appends_arrive(self):
        h, now = self.home, self.now
        sessions = []
        for i in range(3):
            links = [fx.pr_link(now - DAY + j, 100 * (i + 1) + j) for j in range(5)]
            filler = [fx.attachment(now - DAY, pad=3000) for _ in range(20)]
            sessions.append(self.desktop(f"cold{i}", activity=now - (i + 1) * DAY, links=[*filler, *links]))
        sizes = [p.stat().st_size for _d, p in sessions]
        scanner = h.scanner(ledger=RecordingLedger())
        seen = []
        with mock.patch.object(sources, "PR_LINK_BYTES_PER_SCAN", max(sizes) // 2):
            for _ in range(10):
                raw = scanner.scan()
                seen.append(sum(len(v) for v in raw.pr_links.values()))
                if seen[-1] == 15:
                    break
        self.assertGreater(len(seen), 3)
        self.assertEqual(seen, sorted(seen))
        self.assertEqual(seen[-1], 15)
        d, path = sessions[0]
        with mock.patch.object(sources, "open_for_read", wraps=paths_mod.open_for_read) as spy:
            scanner.scan()
            self.assertEqual([c for c in spy.call_args_list if str(c.args[0]).endswith(".jsonl")], [])
            h.append_transcript(path, [fx.pr_link(now, 777)])
            raw = scanner.scan()
        self.assertEqual(raw.pr_links[d.cli_session_id][-1].number, 777)

    def test_dropped_session_is_forgotten(self):
        h = self.home
        d, path = self.desktop("drop", activity=self.now - HOUR, links=[fx.pr_link(self.now - HOUR, 5)])
        scanner = h.scanner()
        self.assertIn(d.cli_session_id, scanner.scan().pr_links)
        self.assertEqual(len(scanner._pr_index.links(path)), 1)
        d.path.unlink()
        self.assertEqual(scanner.scan().pr_links, {})
        self.assertEqual(scanner._pr_index.links(path), ())

    def test_index_failure_is_contained(self):
        h = self.home
        d, _ = self.desktop("fails", activity=self.now - HOUR, links=[fx.pr_link(self.now - HOUR, 5)])
        raw = h.scanner(pr_index=RecordingPrIndex(fail=RuntimeError(MARKER))).scan()
        self.assertEqual((raw.pr_links, raw.warnings), ({}, ("pr links RuntimeError",)))
        self.assertTrue(raw.tails[d.cli_session_id].found)


class ClaudeFolderTests(HomeTestCase):
    """Wherever Claude keeps its files: CLAUDE_CONFIG_DIR, Claude-3p, ~/Applications and shortened folder names."""

    def ended(self, cwd: str, *, entrypoint: str = "cli", mtime_ms: int | None = None) -> str:
        sid = self.home.next_uuid()
        self.home.write_transcript(cwd, sid, fx.verdict_records("ended", now_ms=self.now, cwd=cwd,
                                                                entrypoint=entrypoint),
                                   mtime_ms=self.now - HOUR if mtime_ms is None else mtime_ms)
        return sid

    @staticmethod
    def folders(raw: model.RawSnapshot) -> list[tuple[str, str, bool]]:
        return [(f.label, f.kind, f.found) for f in raw.folders]

    @staticmethod
    def long_cwd() -> str:
        cwd = "/w/" + "/".join(f"folder-{n:02d}-with-a-longish-name" for n in range(8))
        assert len(fx.slug(cwd)) > 200
        return cwd

    def test_an_everyday_home_reports_its_folders_by_label(self):
        raw = self.home.scanner().scan()
        self.assertEqual(self.folders(raw), [("~/.claude", "code", True), ("Claude", "app", True),
                                             ("Claude-3p", "app", False)])

    def test_a_relocated_folder_is_read_as_well_as_claude(self):
        h = self.home
        before = self.ended("/w/before")
        h.add_registry(pid=4101, session_id=before, cwd="/w/before", entrypoint="cli")
        h.relocate(h.home / "work claude")
        after = self.ended("/w/after")
        h.add_registry(pid=4102, session_id=after, cwd="/w/after", entrypoint="cli")
        raw = h.scanner().scan()
        self.assertEqual({c.session_id for c in raw.cli_only}, {before, after})
        self.assertEqual({e.session_id for e in raw.registry_live}, {before, after})
        self.assertEqual(raw.registry_files, 2)
        self.assertTrue(raw.tails[before].found and raw.tails[after].found)
        self.assertEqual(self.folders(raw)[:2], [("CLAUDE_CONFIG_DIR", "code", True), ("~/.claude", "code", True)])

    def test_a_desktop_session_finds_its_transcript_in_the_relocated_folder(self):
        """The app hands its own CLAUDE_CONFIG_DIR to the sessions it starts."""
        h = self.home
        h.relocate(h.home / "app claude")
        d = h.add_desktop(cwd="/w/repo", last_activity_at=self.now - HOUR)
        h.write_transcript(d.cwd, d.cli_session_id, fx.verdict_records("ended", now_ms=self.now, cwd=d.cwd))
        raw = h.scanner().scan()
        self.assertTrue(raw.tails[d.cli_session_id].found)
        self.assertIn(d.cli_session_id, raw.tokens)

    def test_config_dir_naming_claude_through_a_symlink_is_read_once(self):
        h = self.home
        sid = self.ended("/w/repo")
        h.add_registry(pid=4103, session_id=sid, cwd="/w/repo", entrypoint="cli")
        link = h.root / "claude-link"
        link.symlink_to(h.paths.claude_dir)
        h.relocate(link)
        raw = h.scanner().scan()
        self.assertEqual((raw.registry_files, [c.session_id for c in raw.cli_only]), (1, [sid]))
        self.assertEqual(self.folders(raw)[:2], [("CLAUDE_CONFIG_DIR", "code", True), ("~/.claude", "code", True)])

    def test_a_missing_config_dir_is_reported(self):
        h = self.home
        h.paths = replace(h.paths, config_dir=h.home / "nowhere")
        raw = h.scanner().scan()
        self.assertEqual(self.folders(raw)[:2], [("CLAUDE_CONFIG_DIR", "code", False), ("~/.claude", "code", True)])

    def test_a_relative_config_dir_is_reported_and_never_read(self):
        h = self.home
        work = h.root / "somewhere"
        work.mkdir()
        self.addCleanup(os.chdir, os.getcwd())
        os.chdir(work)
        h.relocate("rel")
        h.add_registry(pid=4104, session_id=fx.uid(4104), cwd="/w", entrypoint="cli")
        self.ended("/w")
        self.assertTrue((work / "rel" / "sessions" / "4104.json").is_file())
        raw = h.scanner().scan()
        self.assertEqual((raw.registry_files, raw.registry_live, raw.cli_only), (0, (), ()))
        self.assertEqual(self.folders(raw)[:2], [("CLAUDE_CONFIG_DIR", "code", False), ("~/.claude", "code", True)])

    def test_claude_3p_session_records_are_read(self):
        h = self.home
        d = h.add_desktop(cwd="/w/repo", last_activity_at=self.now - HOUR, app="Claude-3p")
        raw = h.scanner().scan()
        self.assertEqual([r.session_id for r in raw.desktop], [d.session_id])
        self.assertEqual(self.folders(raw)[1:], [("Claude", "app", True), ("Claude-3p", "app", True)])

    def test_a_record_in_both_app_folders_shows_once(self):
        h = self.home
        uuid, cli = h.next_uuid(), h.next_uuid()
        for app in ("Claude", "Claude-3p"):
            h.add_desktop(session_uuid=uuid, cli_session_id=cli, cwd="/w/repo", app=app)
        raw = h.scanner().scan()
        self.assertEqual([r.session_id for r in raw.desktop], [f"local_{uuid}"])

    def test_plan_usage_is_the_newest_sample_in_either_app_folder(self):
        h = self.home
        h.write_plan_usage([fx.plan_sample(self.now - 40 * MINUTE, 11, 21)])
        newer = h.write_plan_usage([fx.plan_sample(self.now - 10 * MINUTE, 44, 55)], app="Claude-3p")
        scanner = h.scanner()
        self.assertEqual(scanner.scan().plan_usage, model.PlanUsage(44, 55, self.now - 10 * MINUTE))
        newer.unlink()
        self.assertEqual(scanner.scan().plan_usage, model.PlanUsage(11, 21, self.now - 40 * MINUTE))

    @staticmethod
    def write_app(folder: Path, version: str) -> None:
        plist = folder / paths_mod.APP_PLIST
        plist.parent.mkdir(parents=True, exist_ok=True)
        with open(plist, "wb") as fh:
            plistlib.dump({"CFBundleShortVersionString": version}, fh)

    def test_app_version_from_applications_in_your_home(self):
        """The app goes to ~/Applications when installed without admin rights. /Applications still comes first."""
        h = self.home
        h.paths = replace(h.paths, claude_app_plist=None)
        self.write_app(h.home / "Applications", "2.9.0")
        scanner = h.scanner()
        self.assertEqual(scanner.scan().app_version, "2.9.0")
        self.write_app(h.paths.system_applications, "3.0.0")
        self.assertEqual(scanner.scan().app_version, "3.0.0")

    def test_a_long_folder_name_is_found_by_the_session_id(self):
        h = self.home
        cwd = self.long_cwd()
        d = h.add_desktop(cwd=cwd, last_activity_at=self.now - HOUR)
        path = h.write_transcript(cwd, d.cli_session_id, fx.verdict_records("ended", now_ms=self.now, cwd=cwd))
        self.assertNotEqual(path, h.paths.transcript_path(cwd, d.cli_session_id))
        raw = h.scanner().scan()
        self.assertTrue(raw.tails[d.cli_session_id].found)
        self.assertIn(d.cli_session_id, raw.tokens)

    def test_an_emoji_in_the_folder_name_is_found_too(self):
        h = self.home
        d = h.add_desktop(cwd="/w/\U0001F680 launch", last_activity_at=self.now - HOUR)
        path = h.write_transcript(d.cwd, d.cli_session_id, fx.verdict_records("ended", now_ms=self.now, cwd=d.cwd))
        self.assertEqual(path.parent.name, "-w----launch")
        self.assertTrue(h.scanner().scan().tails[d.cli_session_id].found)

    def test_an_old_session_touched_lately_in_a_long_folder_is_still_read(self):
        h = self.home
        cwd = self.long_cwd()
        d = h.add_desktop(cwd=cwd, last_activity_at=self.now - 10 * DAY)
        h.write_transcript(cwd, d.cli_session_id, fx.verdict_records("ended", now_ms=self.now, cwd=cwd),
                           mtime_ms=self.now - HOUR)
        self.assertTrue(h.scanner().scan().tails[d.cli_session_id].found)

    def test_pr_links_are_read_from_a_long_folder(self):
        h = self.home
        cwd = self.long_cwd()
        d = h.add_desktop(cwd=cwd, last_activity_at=self.now - 20 * DAY)
        h.write_transcript(cwd, d.cli_session_id,
                           [fx.user_text(self.now - 20 * DAY, cwd=cwd),
                            fx.pr_link(self.now - 20 * DAY, 77, session_id=d.cli_session_id)],
                           mtime_ms=self.now - 20 * DAY)
        raw = h.scanner().scan()
        self.assertNotIn(d.cli_session_id, raw.tails)
        self.assertEqual([link.number for link in raw.pr_links[d.cli_session_id]], [77])


class DefaultPathsTests(unittest.TestCase):
    def paths_with(self, **env) -> paths_mod.Paths:
        with mock.patch.dict(os.environ, env):
            for key in ("TOWN_HOME", "CLAUDE_CONFIG_DIR"):
                if key not in env:
                    os.environ.pop(key, None)
            return paths_mod.default_paths()

    def test_claude_config_dir_is_read_first_and_claude_too(self):
        p = self.paths_with(CLAUDE_CONFIG_DIR="/Users/x/work-claude")
        self.assertEqual(p.claude_dirs, (("CLAUDE_CONFIG_DIR", Path("/Users/x/work-claude")),
                                         ("~/.claude", Path.home() / ".claude")))

    def test_unset_empty_or_claude_itself_means_one_folder(self):
        for env in ({}, {"CLAUDE_CONFIG_DIR": ""}, {"CLAUDE_CONFIG_DIR": str(Path.home() / ".claude")},
                    {"CLAUDE_CONFIG_DIR": str(Path.home() / ".claude") + "/"}):
            with self.subTest(env=env):
                self.assertEqual(self.paths_with(**env).claude_dirs, (("~/.claude", Path.home() / ".claude"),))

    def test_nfc_like_claude(self):
        p = self.paths_with(CLAUDE_CONFIG_DIR="/Users/x/Café")
        self.assertEqual(p.config_dir, Path("/Users/x/Café"))

    def test_a_synthetic_home_never_reads_the_real_config_dir(self):
        p = self.paths_with(TOWN_HOME="/tmp/town-home", CLAUDE_CONFIG_DIR="/Users/x/work-claude")
        self.assertEqual(p.claude_dirs, (("~/.claude", Path("/tmp/town-home/.claude")),))

    def test_app_folders_and_plists(self):
        p = paths_mod.Paths(home=Path("/Users/x"))
        support = Path("/Users/x/Library/Application Support")
        self.assertEqual(p.app_dirs, (("Claude", support / "Claude"), ("Claude-3p", support / "Claude-3p")))
        self.assertEqual(p.app_plists, (Path("/Applications/Claude.app/Contents/Info.plist"),
                                        Path("/Users/x/Applications/Claude.app/Contents/Info.plist")))


class DenylistTests(HomeTestCase):
    def test_denied_files_are_never_opened(self):
        h = self.home
        ids = fx.populate_demo(h)
        plan = h.write_plan_usage([fx.plan_sample(self.now - MINUTE)])
        d = h.add_desktop(cwd="/w/repo/.claude/worktrees/tokens", last_activity_at=self.now - MINUTE)
        h.write_transcript(d.cwd, d.cli_session_id, fx.verdict_records("ended", now_ms=self.now, cwd=d.cwd))
        sub_ok = h.add_subagent_file(d.cwd, d.cli_session_id, "agent-ok.jsonl")
        h.add_subagent_file(d.cwd, d.cli_session_id, "Local Storage/agent-trap.jsonl")
        h.add_subagent_file(d.cwd, d.cli_session_id, "workflows/wf_1/config.json")
        h.add_subagent_file(d.cwd, d.cli_session_id, "agent-trap.key")
        for trap in h.trap_paths():
            self.assertTrue(trap.exists(), trap)
            self.assertTrue(paths_mod.is_denied(trap), trap)

        opened: list[str] = []
        real_open, real_os_open = builtins.open, os.open

        def spy_open(file, *args, **kwargs):
            opened.append(os.fspath(file) if not isinstance(file, int) else f"fd:{file}")
            return real_open(file, *args, **kwargs)

        def spy_os_open(path, *args, **kwargs):
            opened.append(os.fspath(path))
            return real_os_open(path, *args, **kwargs)

        refused: list[str] = []
        real_for_read = paths_mod.open_for_read

        def spy_for_read(path, mode="rb"):
            try:
                return real_for_read(path, mode)
            except PermissionError:
                refused.append(str(path))
                raise

        with mock.patch.object(builtins, "open", spy_open), mock.patch.object(io, "open", spy_open), \
                mock.patch.object(os, "open", spy_os_open), \
                mock.patch.object(sources, "open_for_read", side_effect=spy_for_read):
            scanner = h.scanner()
            raw = scanner.scan()
            scanner.scan()

        self.assertTrue(opened, "the spy saw no opens at all")
        for name in opened:
            self.assertFalse(paths_mod.is_denied(name), "opened a denied file")
            self.assertFalse(name.endswith(".key"))
            self.assertNotEqual(Path(name).name, "config.json")
        self.assertTrue(all("Local Storage" in r for r in refused))
        self.assertNotIn(fx.TRAP_TRANSCRIPT_UUID, {c.session_id for c in raw.cli_only})
        self.assertEqual(raw.warnings, ())
        self.assertEqual(len(raw.cli_only), 3)
        self.assertEqual(len(ids), len(fx.DEMO_EXPECTED_LANE))
        self.assertIn(str(plan), opened)
        self.assertIn(str(sub_ok), opened)
        self.assertTrue(raw.tokens[d.cli_session_id].complete)
        self.assertIsNotNone(raw.plan_usage)


class DeniedPathTests(HomeTestCase):
    def test_read_tail_refuses_denied_paths_without_opening(self):
        h = self.home
        trap = h.paths.projects_dir / "Local Storage" / f"{fx.TRAP_TRANSCRIPT_UUID}.jsonl"
        key = h.paths.sessions_dir / "9.abc.key"
        key.write_text(MARKER)
        with mock.patch.object(builtins, "open") as spy:
            self.assertFalse(read_tail(trap, trap.parent).found)
            self.assertFalse(read_tail(key, key.parent).found)
        spy.assert_not_called()


class SnapshotTests(HomeTestCase):
    def test_demo_home_snapshot(self):
        h = self.home
        ids = fx.populate_demo(h)
        raw = h.scanner().scan()
        self.assertEqual(raw.scanned_at, self.now)
        self.assertIsInstance(raw.scan_ms, int)
        self.assertEqual(len(raw.desktop), 19)
        self.assertEqual(raw.desktop_parse_errors, 0)
        self.assertEqual(raw.registry_files, 10)
        self.assertEqual(len(raw.registry_live), 10)
        self.assertEqual(raw.app_version, fx.APP_VERSION)
        self.assertEqual(raw.cli_versions, (fx.CLI_VERSION,))
        self.assertEqual({f"cli:{c.session_id}" for c in raw.cli_only},
                         {ids["cli_ended"], ids["cli_stopped"], ids["cli_ended_long_ago"]})
        desktop_ids = {r.session_id for r in raw.desktop}
        self.assertTrue({v for k, v in ids.items() if not k.startswith("cli_")} <= desktop_ids)
        self.assertTrue(all(t.found for t in raw.tails.values()))
        self.assertEqual(len(raw.tails), 10 + 6 + 2)
        self.assertNotIn(MARKER, repr(raw))
        self.assertEqual(raw.warnings, ())

    def test_demo_home_lanes(self):
        """Every case in the demo home lands in the lane it is named for, read from real-shaped files."""
        h = self.home
        ids = fx.populate_demo(h)
        b = board.build_board(h.scanner().scan(), self.now)
        rows = {r["id"]: r for r in b["sessions"]}
        for name, row_id in ids.items():
            with self.subTest(case=name):
                expected = fx.DEMO_EXPECTED_LANE[name]
                self.assertEqual(rows[row_id]["lane"] if row_id in rows else "old", expected)
        self.assertEqual(rows[ids["your_turn"]]["label"], "Needs input")
        self.assertEqual(sum(b["counts"].values()), len(ids))

    def test_app_version_missing_or_corrupt(self):
        h = self.home
        h.plist.write_bytes(b"not a plist")
        raw = h.scanner().scan()
        self.assertIsNone(raw.app_version)
        self.assertTrue(any(w.startswith("app plist ") for w in raw.warnings))
        h.plist.unlink()
        raw = h.scanner().scan()
        self.assertIsNone(raw.app_version)
        self.assertEqual(raw.warnings, ())

    def test_empty_home(self):
        home = SyntheticHome(app_version=None)
        self.addCleanup(home.cleanup)
        raw = home.scanner().scan()
        self.assertEqual((raw.desktop, raw.registry_live, raw.cli_only, raw.tails, raw.app_version),
                         ((), (), (), {}, None))

    def test_unreadable_transcript_is_not_fatal(self):
        h = self.home
        d = h.add_desktop(last_activity_at=self.now - MINUTE)
        path = h.write_transcript(d.cwd, d.cli_session_id, fx.verdict_records("ended", cwd=d.cwd))
        path.chmod(0)
        self.addCleanup(path.chmod, 0o600)
        raw = h.scanner().scan()
        if os.access(path, os.R_OK):  # running as root
            self.skipTest("file permissions not enforced")
        self.assertFalse(raw.tails[d.cli_session_id].found)

    def test_transcript_path_that_is_a_directory(self):
        h = self.home
        d = h.add_desktop(last_activity_at=self.now - MINUTE)
        h.transcript_path(d.cwd, d.cli_session_id).mkdir(parents=True)
        raw = h.scanner().scan()
        self.assertFalse(raw.tails[d.cli_session_id].found)
        self.assertEqual(raw.cli_only, ())


if __name__ == "__main__":
    unittest.main()
