"""Secret, launch codes, request guards, routes, open action, resume command and the launcher.

Synthetic data only. Servers bind port 0, every subprocess is mocked, and nothing opens a URL.
"""
from __future__ import annotations

import ast
import hashlib
import hmac
import http.client
import importlib.machinery
import importlib.util
import io
import json
import os
import plistlib
import re
import shlex
import signal
import socket
import socketserver
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from unittest import mock

from town import actions, reviews, security, server
from town import board as bd
from town.done import DoneStore
from town.linkstore import LinkStore
from town.model import (CliTranscript, DesktopRecord, GitHubPr, PrLink, PullRequest, RawSnapshot, ReviewRequest,
                       ReviewSnapshot, Tail, TailRecord)
from town.paths import CODE_DIR, EDITOR_OPEN_URL_RE, EDITORS, Paths, adopt_legacy_dir

LOCAL = "local_11111111-2222-4333-8444-555555555555"
NOT_IN_BOARD = "local_99999999-2222-4333-8444-555555555555"
NO_OPEN = "local_aaaaaaaa-2222-4333-8444-555555555555"
QUOTE_UUID = "22222222-3333-4444-8555-666666666666"
NEWLINE_UUID = "33333333-3333-4444-8555-666666666666"
BIDI_UUID = "44444444-3333-4444-8555-666666666666"
VSCODE_UUID = "55555555-3333-4444-8555-666666666666"
VSCODE_SHUT_UUID = "66666666-3333-4444-8555-666666666666"
TERMINAL_OPEN_UUID = "77777777-3333-4444-8555-666666666666"
VSCODE_LIVE_UUID = "88888888-3333-4444-8555-666666666666"
VSCODE_URL = f"vscode://anthropic.claude-code/open?session={VSCODE_UUID}"
VSCODE_CWD = "/tmp/vscode repo/caf\u00e9"
VSCODE_FOLDER = ["-b", "com.microsoft.VSCode", VSCODE_CWD]
QUOTE_CWD = "/tmp/a'; touch x #"
NEWLINE_CWD = "/tmp/a\nb"
BIDI_CWD = "/tmp/safe\u202eevil"
HOSTILE = '</script><script>alert("x")</script>\u2028<img src=x onerror=alert(1)> & \'"\\'
VISITOR_URL = "https://github.com/Acme-DataTeam/wonderful-things-core/pull/532"
VISITOR_ID = reviews.review_id(VISITOR_URL)
STALE_URL = "https://github.com/Acme-DataTeam/wonderful-things-core/pull/999"
STALE_ID = reviews.review_id(STALE_URL)
# On the board, but the URL the source kept for it is not a PR URL: the opener must still refuse it.
BAD_STORED_ID = reviews.review_id("https://github.com/o/r/pull/7")
LAUNCHER = CODE_DIR / "tokentown"
OPEN_KWARGS = dict(shell=False, timeout=10, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, env={"PATH": "/usr/bin:/bin"})


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def make_raw() -> RawSnapshot:
    return RawSnapshot(
        scanned_at=1, desktop=(), registry_files=0, registry_live=(),
        cli_only=(
            CliTranscript(session_id=QUOTE_UUID, cwd=QUOTE_CWD, cwd_exists=True, last_activity_at=1),
            CliTranscript(session_id=NEWLINE_UUID, cwd=NEWLINE_CWD, cwd_exists=True, last_activity_at=1),
            CliTranscript(session_id=BIDI_UUID, cwd=BIDI_CWD, cwd_exists=True, last_activity_at=1),
            CliTranscript(session_id=VSCODE_UUID, cwd=VSCODE_CWD, cwd_exists=True, last_activity_at=1,
                          entrypoint="claude-vscode"),
            CliTranscript(session_id=VSCODE_LIVE_UUID, cwd=VSCODE_CWD, cwd_exists=True, last_activity_at=1,
                          entrypoint="claude-vscode"),
        ),
        tails={}, app_version=None, cli_versions=(), desktop_parse_errors=0, scan_ms=3,
    )


def visitor(visitor_id: str = VISITOR_ID, number: int = 532, repo: str = "wonderful-things-core",
            via: str = "you", teams=()) -> dict:
    return {"id": visitor_id, "number": number, "repo": repo, "owner": "Acme-DataTeam", "island": None,
            "title": HOSTILE, "author": "sam", "via": via, "teams": list(teams), "waitingSince": 1, "look": 7}


def make_board(*, generated_at: int = 1, scan_ms: int = 3, title: str | None = HOSTILE,
               visitors=()) -> dict:
    def row(row_id, kind, can_open, can_resume, row_title=None, surface=None, live=False):
        return {"id": row_id, "kind": kind, "surface": surface or ("desktop" if kind == "desktop" else "terminal"),
                "editor": "vscode" if surface == "vscode" else None, "lane": "recent", "label": "Recent",
                "title": row_title, "live": live,
                "canOpen": can_open, "canCopyResume": can_resume, "canMarkDone": can_open or can_resume,
                "valhallaReason": None, "doneAt": None}

    return {
        "v": 1, "generatedAt": generated_at, "alert": 0, "counts": {"recent": 5}, "rateLimit": None,
        "health": {"ok": True, "scanMs": scan_ms, "warnings": []},
        "sessions": [
            row(LOCAL, "desktop", True, False, title),
            row(NO_OPEN, "desktop", False, False),
            row("cli:" + QUOTE_UUID, "cli", False, True),
            row("cli:" + NEWLINE_UUID, "cli", False, True),
            row("cli:" + BIDI_UUID, "cli", False, True),
            row("cli:" + VSCODE_UUID, "cli", True, True, surface="vscode"),
            row("cli:" + VSCODE_LIVE_UUID, "cli", True, False, surface="vscode", live=True),
            row("cli:" + VSCODE_SHUT_UUID, "cli", False, False, surface="vscode"),
            # A terminal row that claims it can open: only an editor's row may map to a URL, whatever canOpen says.
            row("cli:" + TERMINAL_OPEN_UUID, "cli", True, True),
        ],
        "visitors": list(visitors),
    }


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def no_real_subprocesses(case: unittest.TestCase) -> None:
    """Any real process launch (open, Safari, ps, lsof) fails the test instead of running."""
    for target in ("subprocess.Popen", "os.posix_spawn", "os.execv", "os.system"):
        patcher = mock.patch(target, side_effect=AssertionError(f"real {target} called in a test"))
        patcher.start()
        case.addCleanup(patcher.stop)


class FakeResolver:
    """Stands in for github.PrStateResolver: records refresh calls and never runs gh."""

    def __init__(self, states: dict[str, GitHubPr] | None = None, health: dict | None = None):
        self.states = dict(states or {})
        self.health_value = health or {"enabled": True, "known": len(self.states), "failed": 0,
                                       "lastError": None, "lastCheckedAt": 1234}
        self.calls: list[list[str]] = []
        self.errors: list[Exception] = []
        self.called = threading.Semaphore(0)
        self.cancelled = False
        self._lock = threading.Lock()

    def refresh(self, urls, max_calls: int = 60) -> int:
        with self._lock:
            self.calls.append(list(urls))
            error = self.errors.pop(0) if self.errors else None
        self.called.release()
        if error is not None:
            raise error
        return 0

    def cancel(self) -> None:
        self.cancelled = True

    def snapshot(self) -> dict[str, GitHubPr]:
        return dict(self.states)

    def health(self) -> dict:
        return dict(self.health_value)


class FakeReviewSource:
    """Stands in for reviews.ReviewSource: records refresh calls and never runs gh."""

    def __init__(self, urls: dict[str, str] | None = None, health: dict | None = None,
                 snapshot: ReviewSnapshot | None = None):
        self.urls = dict(urls or {})
        self.snapshot_value = snapshot or ReviewSnapshot()
        self.health_value = health or {"enabled": True, "known": 2, "failed": 0, "lastError": None,
                                       "lastCheckedAt": 4321}
        self.calls: list[list[str]] = []
        self.errors: list[Exception] = []
        self.called = threading.Semaphore(0)
        self.cancelled = False
        self._lock = threading.Lock()

    def refresh(self, urls, max_calls: int = 21) -> int:
        with self._lock:
            self.calls.append(list(urls))
            error = self.errors.pop(0) if self.errors else None
        self.called.release()
        if error is not None:
            raise error
        return 0

    def cancel(self) -> None:
        self.cancelled = True

    def snapshot(self) -> ReviewSnapshot:
        return self.snapshot_value

    def url_for(self, visitor_id):
        return self.urls.get(visitor_id)

    def health(self) -> dict:
        return dict(self.health_value)


class FakeUpdateChecker:
    """Stands in for updates.UpdateChecker: records refresh calls and never runs gh or reads .git."""

    def __init__(self, health: dict | None = None, code_dir: str = "/Users/someone/tools/tokentown"):
        self.code_dir = Path(code_dir)
        self.health_value = health or {"enabled": True, "reason": None, "state": "current", "latest": None,
                                       "version": None, "restart": False, "lastError": None, "lastCheckedAt": 5678}
        self.releases_value: list[dict] = []
        self.refreshes = 0
        self.errors: list[Exception] = []
        self.called = threading.Semaphore(0)
        self.cancelled = False
        self.outcome: tuple[str, str | None] = ("nothing", None)
        self.updates = 0
        self._lock = threading.Lock()

    def update(self) -> tuple[str, str | None]:
        with self._lock:
            self.updates += 1
        return self.outcome

    def releases(self) -> list[dict]:
        return [dict(r) for r in self.releases_value]

    def refresh(self) -> int:
        with self._lock:
            self.refreshes += 1
            error = self.errors.pop(0) if self.errors else None
        self.called.release()
        if error is not None:
            raise error
        return 0

    def cancel(self) -> None:
        self.cancelled = True

    def health(self) -> dict:
        return dict(self.health_value)


def start_server(case: unittest.TestCase, *, provider, secret: bytes, opener=None, port: int = 0,
                 scan_interval: float = 3600, wait: bool = True, paths: Paths | None = None,
                 pr_resolver=None, pr_interval: float = 3600, done_store=None, done_clock=None,
                 review_source=None, review_opener=None, review_interval: float = 3600,
                 update_checker=None, update_interval: float = 3600):
    opener = opener or actions.Opener(run=mock.Mock(), clock=FakeClock())
    httpd, app = server.make_server(port, board_provider=provider, opener=opener, secret=secret,
                                    scan_interval=scan_interval, paths=paths, pr_resolver=pr_resolver,
                                    pr_interval=pr_interval, done_store=done_store,
                                    review_source=review_source, review_opener=review_opener,
                                    review_interval=review_interval, update_checker=update_checker,
                                    update_interval=update_interval,
                                    done_clock=done_clock or FakeClock())
    thread = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
    thread.start()

    def shutdown():
        httpd.shutdown()
        httpd.server_close()
        app.stop()
        thread.join(5)

    case.addCleanup(shutdown)
    if wait:
        case.assertTrue(app.wait_first_scan(5))
    return httpd, app


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ====================================================================== secret and HMAC values

class SecretTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.paths = Paths(home=Path(self.tmp.name))

    def test_creates_dir_0700_and_file_0600(self):
        secret = security.load_or_create_secret(self.paths)
        self.assertEqual(len(secret), 32)
        self.assertEqual(stat.S_IMODE(os.stat(self.paths.secret_dir).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(self.paths.secret_file).st_mode), 0o600)
        self.assertEqual(self.paths.secret_file.read_text().strip(), secret.hex())
        self.assertEqual([p.name for p in self.paths.secret_dir.iterdir()], ["secret"])

    def test_second_load_returns_same_secret(self):
        self.assertEqual(security.load_or_create_secret(self.paths), security.load_or_create_secret(self.paths))

    def test_read_secret_none_before_creation(self):
        self.assertIsNone(security.read_secret(self.paths))

    def test_rotate_replaces_secret_and_keeps_permissions(self):
        first = security.load_or_create_secret(self.paths)
        security.rotate_secret(self.paths)
        second = security.load_or_create_secret(self.paths)
        self.assertNotEqual(first, second)
        self.assertEqual(stat.S_IMODE(os.stat(self.paths.secret_file).st_mode), 0o600)
        self.assertEqual([p.name for p in self.paths.secret_dir.iterdir()], ["secret"])

    def test_loose_permissions_are_tightened(self):
        security.load_or_create_secret(self.paths)
        os.chmod(self.paths.secret_dir, 0o755)
        os.chmod(self.paths.secret_file, 0o644)
        security.load_or_create_secret(self.paths)
        self.assertEqual(stat.S_IMODE(os.stat(self.paths.secret_dir).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(self.paths.secret_file).st_mode), 0o600)

    def test_malformed_secret_is_refused(self):
        self.paths.secret_dir.mkdir(parents=True, mode=0o700)
        self.paths.secret_file.write_text("not hex")
        with self.assertRaises(ValueError):
            security.load_or_create_secret(self.paths)

    def test_symlinked_secret_is_refused(self):
        self.paths.secret_dir.mkdir(parents=True, mode=0o700)
        target = Path(self.tmp.name) / "elsewhere"
        target.write_text("ab" * 32)
        self.paths.secret_file.symlink_to(target)
        with self.assertRaises(OSError):
            security.load_or_create_secret(self.paths)



class LegacyDirTests(unittest.TestCase):
    """The pre-rename ccboard folder is carried across once, and never at the cost of what is already there."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.paths = Paths(home=Path(self.tmp.name))

    def make_legacy(self, **files) -> Path:
        old = self.paths.legacy_secret_dir
        old.mkdir(parents=True, mode=0o700)
        for name, text in files.items():
            (old / name).write_text(text)
        return old

    def test_nothing_to_do_without_a_legacy_dir(self):
        self.assertFalse(adopt_legacy_dir(self.paths))
        self.assertFalse(self.paths.secret_dir.exists())

    def test_legacy_dir_is_renamed_with_its_files(self):
        self.make_legacy(secret="ab" * 32 + "\n", **{"done.json": '{"v": 1}', "links.json": "[]"})
        self.assertTrue(adopt_legacy_dir(self.paths))
        self.assertFalse(self.paths.legacy_secret_dir.exists())
        self.assertEqual(sorted(p.name for p in self.paths.secret_dir.iterdir()),
                         ["done.json", "links.json", "secret"])
        self.assertEqual(self.paths.secret_file.read_text().strip(), "ab" * 32)
        self.assertEqual(stat.S_IMODE(os.stat(self.paths.secret_dir).st_mode), 0o700)

    def test_a_second_run_is_a_no_op(self):
        self.make_legacy(secret="ab" * 32 + "\n")
        self.assertTrue(adopt_legacy_dir(self.paths))
        self.assertFalse(adopt_legacy_dir(self.paths))

    def test_an_existing_new_dir_wins_and_the_legacy_one_is_left_alone(self):
        self.make_legacy(**{"done.json": "old"})
        self.paths.secret_dir.mkdir(parents=True, mode=0o700)
        (self.paths.secret_dir / "done.json").write_text("new")
        self.assertFalse(adopt_legacy_dir(self.paths))
        self.assertEqual((self.paths.secret_dir / "done.json").read_text(), "new")
        self.assertEqual((self.paths.legacy_secret_dir / "done.json").read_text(), "old")

    def test_a_symlink_in_place_of_the_legacy_dir_is_refused(self):
        target = Path(self.tmp.name) / "elsewhere"
        target.mkdir()
        (target / "done.json").write_text("planted")
        self.paths.legacy_secret_dir.parent.mkdir(parents=True, exist_ok=True)
        self.paths.legacy_secret_dir.symlink_to(target, target_is_directory=True)
        self.assertFalse(adopt_legacy_dir(self.paths))
        self.assertFalse(self.paths.secret_dir.exists())

    def test_a_legacy_file_rather_than_a_directory_is_refused(self):
        self.paths.legacy_secret_dir.parent.mkdir(parents=True, exist_ok=True)
        self.paths.legacy_secret_dir.write_text("not a directory")
        self.assertFalse(adopt_legacy_dir(self.paths))
        self.assertFalse(self.paths.secret_dir.exists())


class HmacTests(unittest.TestCase):
    secret = bytes(range(32))

    def test_health_and_session_values(self):
        nonce = "0123456789abcdef0123456789abcdef"
        self.assertEqual(security.health_response(self.secret, nonce),
                         hmac.new(self.secret, b"health|" + nonce.encode(), hashlib.sha256).hexdigest())
        self.assertEqual(security.session_token(self.secret),
                         hmac.new(self.secret, b"session", hashlib.sha256).hexdigest())

    def test_code_format(self):
        code = security.mint_code(self.secret, 1_700_000_000_123)
        nonce, ts, mac = code.split(".")
        self.assertRegex(nonce, r"^[0-9a-f]{32}$")
        self.assertEqual(ts, "1700000000123")
        self.assertEqual(mac, hmac.new(self.secret, f"claim|{nonce}|{ts}".encode(), hashlib.sha256).hexdigest())

    def test_code_single_use(self):
        verifier = security.CodeVerifier(self.secret)
        code = security.mint_code(self.secret, 10_000_000)
        self.assertTrue(verifier.verify(code, 10_000_500))
        self.assertFalse(verifier.verify(code, 10_000_600))

    def test_code_expires_after_30_seconds(self):
        verifier = security.CodeVerifier(self.secret)
        self.assertTrue(verifier.verify(security.mint_code(self.secret, 10_000_000), 10_030_000))
        self.assertFalse(verifier.verify(security.mint_code(self.secret, 10_000_000), 10_030_001))

    def test_code_from_the_future_refused(self):
        verifier = security.CodeVerifier(self.secret)
        self.assertFalse(verifier.verify(security.mint_code(self.secret, 10_005_000), 10_000_000))

    def test_code_with_wrong_secret_or_tampering_refused(self):
        verifier = security.CodeVerifier(self.secret)
        other = security.mint_code(b"\x01" * 32, 10_000_000)
        self.assertFalse(verifier.verify(other, 10_000_000))
        good = security.mint_code(self.secret, 10_000_000)
        nonce, ts, mac = good.split(".")
        self.assertFalse(verifier.verify(f"{nonce}.{int(ts) + 1}.{mac}", 10_000_000))
        self.assertFalse(verifier.verify(good.upper(), 10_000_000))
        self.assertFalse(verifier.verify(good + "\n", 10_000_000))
        self.assertFalse(verifier.verify(None, 10_000_000))
        self.assertTrue(verifier.verify(good, 10_000_000))

    def test_replay_is_reported_distinctly(self):
        verifier = security.CodeVerifier(self.secret)
        code = security.mint_code(self.secret, 10_000_000)
        self.assertEqual(verifier.check(code, 10_000_100), security.CLAIM_OK)
        self.assertEqual(verifier.check(code, 10_000_200), security.CLAIM_REPLAYED)
        # Still a replay once the code has expired, while the nonce is remembered.
        self.assertEqual(verifier.check(code, 10_045_000), security.CLAIM_REPLAYED)
        self.assertFalse(verifier.verify(code, 10_000_300))
        self.assertEqual(verifier.check(code, 10_061_000), security.CLAIM_INVALID)
        # Forged or expired codes never count as replays.
        nonce, ts, mac = code.split(".")
        self.assertEqual(verifier.check(f"{nonce}.{ts}.{'0' * 64}", 10_000_300), security.CLAIM_INVALID)
        self.assertEqual(verifier.check(security.mint_code(b"\x03" * 32, 10_000_000), 10_000_300),
                         security.CLAIM_INVALID)
        expired = security.mint_code(self.secret, 10_000_000)
        self.assertEqual(verifier.check(expired, 10_030_001), security.CLAIM_INVALID)
        self.assertEqual(verifier.check(expired, 10_030_002), security.CLAIM_INVALID)

    def test_used_nonces_forgotten_after_60_seconds(self):
        verifier = security.CodeVerifier(self.secret)
        verifier.verify(security.mint_code(self.secret, 10_000_000), 10_000_000)
        verifier.verify(security.mint_code(self.secret, 10_070_000), 10_070_000)
        self.assertEqual(len(verifier._used), 1)


class GuardHelperTests(unittest.TestCase):
    def test_body_length(self):
        self.assertEqual(security.body_length(["1024"], None), 1024)
        self.assertIsNone(security.body_length(["1025"], None))
        self.assertIsNone(security.body_length(None, None))
        self.assertIsNone(security.body_length(["10", "10"], None))
        self.assertIsNone(security.body_length(["-1"], None))
        self.assertIsNone(security.body_length(["\u0661\u0662"], None))
        self.assertIsNone(security.body_length(["10"], ["chunked"]))

    def test_parse_json_object(self):
        keys = frozenset({"id"})
        self.assertEqual(security.parse_json_object(b'{"id": "x"}', keys), {"id": "x"})
        for body in (b'{"id": "x", "extra": "y"}', b"{}", b'{"id": 1}', b'["id"]', b"not json",
                     b'{"id": "a", "id": "b"}', b'{"id": "\xff"}', b"[" * 1000):
            self.assertIsNone(security.parse_json_object(body, keys), body[:40])


# ====================================================================== actions

class ActionTests(unittest.TestCase):
    def setUp(self):
        no_real_subprocesses(self)
        self.run = mock.Mock(return_value=subprocess.CompletedProcess([], 0))
        self.clock = FakeClock()
        self.sleep = mock.Mock()
        self.opener = actions.Opener(run=self.run, clock=self.clock, sleep=self.sleep)
        self.board = make_board()
        self.raw = make_raw()

    def test_open_runs_exactly_the_allowlisted_url(self):
        self.assertEqual(self.opener.open(LOCAL, self.board), 200)
        self.run.assert_called_once_with(["/usr/bin/open", f"claude://claude.ai/epitaxy/{LOCAL}"], **OPEN_KWARGS)

    def test_open_refuses_without_board_or_row(self):
        self.assertEqual(self.opener.open(LOCAL, None), 404)
        self.assertEqual(self.opener.open(NOT_IN_BOARD, self.board), 404)
        self.assertEqual(self.opener.open(NO_OPEN, self.board), 404)
        self.assertEqual(self.opener.open(LOCAL + "\n", self.board), 404)
        self.assertEqual(self.opener.open("cli:" + QUOTE_UUID, self.board), 404)
        self.run.assert_not_called()

    def test_open_rate_limit(self):
        self.assertEqual(self.opener.open(LOCAL, self.board), 200)
        self.clock.t += 0.5
        self.assertEqual(self.opener.open(LOCAL, self.board), 429)
        self.clock.t += 0.3
        self.assertEqual(self.opener.open(LOCAL, self.board), 200)
        self.assertEqual(self.run.call_count, 2)

    def test_open_closed_vscode_session_brings_its_window_forward_then_resumes_it(self):
        self.assertEqual(self.opener.open("cli:" + VSCODE_UUID, self.board, self.raw), 200)
        self.assertEqual(self.run.call_args_list, [mock.call(["/usr/bin/open", *VSCODE_FOLDER], **OPEN_KWARGS),
                                                   mock.call(["/usr/bin/open", VSCODE_URL], **OPEN_KWARGS)])
        self.sleep.assert_called_once_with(actions.EDITOR_SESSION_PAUSE_S)

    def test_open_live_vscode_session_only_brings_its_window_forward(self):
        self.assertEqual(self.opener.open("cli:" + VSCODE_LIVE_UUID, self.board, self.raw), 200)
        self.run.assert_called_once_with(["/usr/bin/open", *VSCODE_FOLDER], **OPEN_KWARGS)
        self.sleep.assert_not_called()

    def test_open_vscode_session_stops_when_the_window_fails(self):
        run = mock.Mock(return_value=subprocess.CompletedProcess([], 1))
        opener = actions.Opener(run=run, clock=FakeClock(), sleep=mock.Mock())
        self.assertEqual(opener.open("cli:" + VSCODE_UUID, self.board, self.raw), 500)
        run.assert_called_once()

    def test_open_refuses_rows_that_are_not_openable_vscode_sessions(self):
        for row_id in ("cli:" + VSCODE_SHUT_UUID, "cli:" + TERMINAL_OPEN_UUID, "cli:" + QUOTE_UUID):
            self.assertEqual(self.opener.open(row_id, self.board, self.raw), 404, row_id)
        # Without the scan there is no folder to name the window by.
        self.assertEqual(self.opener.open("cli:" + VSCODE_UUID, self.board), 404)
        self.run.assert_not_called()

    def test_open_commands_take_only_an_exact_row_id(self):
        self.assertEqual(actions.open_commands("cli:" + VSCODE_UUID, self.board, self.raw), [VSCODE_FOLDER, [VSCODE_URL]])
        self.assertEqual(actions.open_commands(LOCAL, self.board, self.raw), [[f"claude://claude.ai/epitaxy/{LOCAL}"]])
        for bad in ("cli:" + VSCODE_UUID + "\n", "cli:" + VSCODE_UUID.replace("-", ""), "CLI:" + VSCODE_UUID,
                    VSCODE_UUID, "cli:" + VSCODE_UUID + "&prompt=x", "cli:../" + VSCODE_UUID, "local_" + VSCODE_UUID,
                    " cli:" + VSCODE_UUID, None, 7, ["cli:" + VSCODE_UUID]):
            with self.subTest(bad=bad):
                self.assertIsNone(actions.open_commands(bad, self.board, self.raw))
        self.assertIsNone(actions.open_commands("cli:" + VSCODE_UUID, None, self.raw))

    def test_open_commands_resume_only_a_session_known_to_be_closed(self):
        board = make_board()
        row = next(r for r in board["sessions"] if r["id"] == "cli:" + VSCODE_UUID)
        for live in (True, None, "no", 0):
            with self.subTest(live=live):
                row["live"] = live
                self.assertEqual(actions.open_commands("cli:" + VSCODE_UUID, board, self.raw), [VSCODE_FOLDER])

    def test_each_editor_opens_in_its_own_app_with_its_own_link(self):
        expected = {"vscode": ("com.microsoft.VSCode", "vscode"),
                    "vscode-insiders": ("com.microsoft.VSCodeInsiders", "vscode-insiders"),
                    "cursor": ("com.todesktop.230313mzl4w4u92", "cursor")}
        self.assertEqual({e.key: (e.bundle_id, e.scheme) for e in EDITORS}, expected)
        board = make_board()
        row = next(r for r in board["sessions"] if r["id"] == "cli:" + VSCODE_UUID)
        for key, (bundle_id, scheme) in expected.items():
            with self.subTest(editor=key):
                row["editor"] = key
                self.assertEqual(actions.open_commands("cli:" + VSCODE_UUID, board, self.raw),
                                 [["-b", bundle_id, VSCODE_CWD],
                                  [f"{scheme}://anthropic.claude-code/open?session={VSCODE_UUID}"]])

    def test_open_closed_cursor_session_in_cursor(self):
        board = make_board()
        next(r for r in board["sessions"] if r["id"] == "cli:" + VSCODE_UUID)["editor"] = "cursor"
        self.assertEqual(self.opener.open("cli:" + VSCODE_UUID, board, self.raw), 200)
        self.assertEqual(self.run.call_args_list, [
            mock.call(["/usr/bin/open", "-b", "com.todesktop.230313mzl4w4u92", VSCODE_CWD], **OPEN_KWARGS),
            mock.call(["/usr/bin/open", f"cursor://anthropic.claude-code/open?session={VSCODE_UUID}"], **OPEN_KWARGS)])

    def test_an_editor_row_names_one_of_the_editors_or_opens_nothing(self):
        board = make_board()
        row = next(r for r in board["sessions"] if r["id"] == "cli:" + VSCODE_UUID)
        for bad in (None, "windsurf", "Cursor", "vscode ", "com.microsoft.VSCode", ["cursor"], {"key": "cursor"}, 7):
            with self.subTest(bad=bad):
                row["editor"] = bad
                self.assertIsNone(actions.open_commands("cli:" + VSCODE_UUID, board, self.raw))
        # An editor on a row that is not an editor's session changes nothing.
        terminal = next(r for r in board["sessions"] if r["id"] == "cli:" + TERMINAL_OPEN_UUID)
        terminal["editor"] = "cursor"
        self.assertIsNone(actions.open_commands("cli:" + TERMINAL_OPEN_UUID, board, self.raw))

    def test_editor_folder_args(self):
        # The folder travels as its own argv element, never through a shell, so quotes and spaces stay text.
        for editor in EDITORS:
            for cwd in (VSCODE_CWD, QUOTE_CWD, "/tmp/a?b#c%d", "/tmp/-rf"):
                with self.subTest(editor=editor.key, cwd=cwd):
                    self.assertEqual(actions.editor_folder_args(editor, cwd), ["-b", editor.bundle_id, cwd])
            for bad in ("/", "", "relative/dir", "-a/Applications/Calculator.app", "/tmp/a/../b", "/tmp/./b",
                        "/tmp//b", "/tmp/b/", NEWLINE_CWD, BIDI_CWD, None, 7, b"/tmp"):
                with self.subTest(editor=editor.key, bad=bad):
                    self.assertIsNone(actions.editor_folder_args(editor, bad))

    def test_editor_url_pattern(self):
        for scheme in ("vscode", "vscode-insiders", "cursor"):
            with self.subTest(scheme=scheme):
                url = f"{scheme}://anthropic.claude-code/open?session={VSCODE_UUID}"
                self.assertTrue(EDITOR_OPEN_URL_RE.match(url))
        for bad in (VSCODE_URL + "\n", VSCODE_URL + "&prompt=hi", VSCODE_URL.upper(),
                    f"vscode://anthropic.claude-code/install-plugin?plugin={VSCODE_UUID}",
                    f"vscode://file/{VSCODE_UUID}", f"vscode://anthropic.claude-code/open?prompt={VSCODE_UUID}",
                    f"cursor://anthropic.claude-code/install-plugin?plugin={VSCODE_UUID}",
                    f"cursor://file/{VSCODE_UUID}", f"Cursor://anthropic.claude-code/open?session={VSCODE_UUID}",
                    f"windsurf://anthropic.claude-code/open?session={VSCODE_UUID}",
                    f"vscode-insiders-x://anthropic.claude-code/open?session={VSCODE_UUID}",
                    f"xcursor://anthropic.claude-code/open?session={VSCODE_UUID}",
                    f"claude://claude.ai/epitaxy/local_{VSCODE_UUID}"):
            with self.subTest(bad=bad):
                self.assertIsNone(EDITOR_OPEN_URL_RE.match(bad))

    def test_open_failure_is_500(self):
        self.run.side_effect = subprocess.TimeoutExpired(["/usr/bin/open"], 10)
        self.assertEqual(self.opener.open(LOCAL, self.board), 500)
        opener = actions.Opener(run=mock.Mock(return_value=subprocess.CompletedProcess([], 1)), clock=FakeClock())
        self.assertEqual(opener.open(LOCAL, self.board), 500)

    def test_resume_command_quotes_hostile_folder(self):
        command = actions.resume_command("cli:" + QUOTE_UUID, self.raw, self.board)
        self.assertEqual(command, f"cd '/tmp/a'\"'\"'; touch x #' && claude --resume {QUOTE_UUID}")
        self.assertEqual(shlex.split(command), ["cd", QUOTE_CWD, "&&", "claude", "--resume", QUOTE_UUID])

    def test_resume_command_refusals(self):
        self.assertIsNone(actions.resume_command("cli:" + NEWLINE_UUID, self.raw, self.board))
        self.assertIsNone(actions.resume_command("cli:" + BIDI_UUID, self.raw, self.board))
        self.assertIsNone(actions.resume_command(LOCAL, self.raw, self.board))
        self.assertIsNone(actions.resume_command("cli:" + QUOTE_UUID, None, self.board))
        self.assertIsNone(actions.resume_command("cli:" + QUOTE_UUID, self.raw, None))
        self.assertIsNone(actions.resume_command("cli:../" + QUOTE_UUID, self.raw, self.board))
        board = make_board()
        board["sessions"][2]["canCopyResume"] = False
        self.assertIsNone(actions.resume_command("cli:" + QUOTE_UUID, self.raw, board))


# ====================================================================== server

class ServerTestCase(unittest.TestCase):
    def setUp(self):
        no_real_subprocesses(self)
        self.secret = bytes(range(32))
        self.token = security.session_token(self.secret)
        self.run = mock.Mock(return_value=subprocess.CompletedProcess([], 0))
        self.clock = FakeClock()
        self.board = make_board()
        self.raw = make_raw()
        self.provider_error: Exception | None = None
        self.done_clock = FakeClock()
        self.review_run = mock.Mock(return_value=subprocess.CompletedProcess([], 0))
        self.review_clock = FakeClock()
        self.review_source = self.make_review_source()
        self.httpd, self.app = start_server(
            self, provider=self.provide, secret=self.secret,
            opener=actions.Opener(run=self.run, clock=self.clock, sleep=mock.Mock()),
            done_store=self.make_done_store(), done_clock=self.done_clock,
            review_source=self.review_source,
            review_opener=reviews.ReviewOpener(run=self.review_run, clock=self.review_clock),
            update_checker=self.make_update_checker())
        self.port = self.httpd.server_address[1]
        self.origin = f"http://127.0.0.1:{self.port}"
        web = tempfile.TemporaryDirectory()
        self.addCleanup(web.cleanup)
        self.web_dir = Path(web.name)
        (self.web_dir / "index.html").write_text("<!doctype html><title>Sessions</title>")
        (self.web_dir / "app.css").write_text("body{}")
        self.app.web_dir = self.web_dir

    def make_done_store(self):
        return None

    def make_review_source(self):
        return None

    def make_update_checker(self):
        return None

    def provide(self):
        if self.provider_error is not None:
            raise self.provider_error
        return self.raw, self.board

    # ------------------------------------------------------------ request helpers

    def request(self, method, path, headers=None, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            resp = conn.getresponse()
            return resp.status, resp.headers, resp.read()
        finally:
            conn.close()

    def get(self, path, *, token=False, headers=None):
        h = dict(headers or {})
        if token:
            h["X-Town-Token"] = self.token if token is True else token
        return self.request("GET", path, h)

    def post(self, path, obj=None, *, body=None, origin=True, ctype="application/json", token=True, headers=None):
        h = {}
        if origin:
            h["Origin"] = self.origin if origin is True else origin
        if ctype:
            h["Content-Type"] = ctype
        if token:
            h["X-Town-Token"] = self.token if token is True else token
        h.update(headers or {})
        return self.request("POST", path, h, json.dumps(obj).encode() if body is None else body)

    def raw_request(self, data: bytes, method: str = "GET"):
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as sock:
            sock.sendall(data)
            resp = http.client.HTTPResponse(sock, method=method)
            resp.begin()
            return resp.status, resp.headers, resp.read()

    def assert_security_headers(self, headers):
        for name, value in security.SECURITY_HEADERS:
            self.assertEqual(headers.get(name), value, name)
        self.assertFalse([k for k in headers.keys() if k.lower().startswith("access-control")])


class HostGuardTests(ServerTestCase):
    def test_correct_host_serves_page(self):
        status, headers, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "text/html; charset=utf-8")
        self.assertIn(b"Sessions", body)
        self.assert_security_headers(headers)

    def test_localhost_refused(self):
        self.assertEqual(self.get("/", headers={"Host": f"localhost:{self.port}"})[0], 403)

    def test_other_port_refused(self):
        self.assertEqual(self.get("/", headers={"Host": f"127.0.0.1:{self.port + 1}"})[0], 403)
        self.assertEqual(self.get("/", headers={"Host": "127.0.0.1"})[0], 403)

    def test_trailing_dot_host_refused(self):
        self.assertEqual(self.get("/", headers={"Host": f"127.0.0.1.:{self.port}"})[0], 403)

    def test_rebinding_host_refused_on_api_even_with_token(self):
        self.assertEqual(self.get("/api/board", token=True, headers={"Host": f"evil.example:{self.port}"})[0], 403)

    def test_missing_host_refused(self):
        status, headers, _ = self.raw_request(b"GET / HTTP/1.0\r\n\r\n")
        self.assertEqual(status, 403)
        self.assert_security_headers(headers)

    def test_duplicate_host_refused(self):
        for second in (f"127.0.0.1:{self.port}", "evil.example"):
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
            try:
                conn.putrequest("GET", "/", skip_host=True)
                conn.putheader("Host", f"127.0.0.1:{self.port}")
                conn.putheader("Host", second)
                conn.endheaders()
                self.assertEqual(conn.getresponse().status, 403, second)
            finally:
                conn.close()

    def test_any_method_goes_through_host_guard(self):
        self.assertEqual(self.request("PUT", "/", {"Host": f"localhost:{self.port}"})[0], 403)
        self.assertEqual(self.request("DELETE", "/api/board", {"X-Town-Token": self.token})[0], 404)


class MethodAndRouteTests(ServerTestCase):
    def test_options_refused_without_cors(self):
        status, headers, _ = self.request("OPTIONS", "/api/open", {
            "Origin": self.origin, "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "x-town-token"})
        self.assertEqual(status, 403)
        self.assert_security_headers(headers)

    def test_head_request_is_not_routed(self):
        status, headers, body = self.request("HEAD", "/")
        self.assertEqual(status, 404)
        self.assertEqual(body, b"")
        self.assert_security_headers(headers)

    def test_http09_request_is_refused_with_headers(self):
        for path, extra in (("/app.css", b""), ("/api/board", f"X-Town-Token: {self.token}\r\n".encode()),
                            (f"/healthz?n={'ab' * 16}", b"")):
            with self.subTest(path=path):
                request = f"GET {path}\r\nHost: 127.0.0.1:{self.port}\r\n".encode() + extra + b"\r\n"
                with socket.create_connection(("127.0.0.1", self.port), timeout=5) as sock:
                    sock.sendall(request)
                    data = b""
                    while chunk := sock.recv(65536):
                        data += chunk
                self.assertTrue(data.startswith(b"HTTP/1.0 400 "), data[:40])
                head, _, body = data.partition(b"\r\n\r\n")
                self.assertEqual(body, b"")
                self.assertIn(b"Content-Security-Policy: default-src 'none'", head)
                self.assertIn(b"X-Content-Type-Options: nosniff", head)
                self.assertIn(b"Cache-Control: no-store", head)

    def test_malformed_request_lines_get_headers_and_no_echo(self):
        for line, expected in ((b"GET /<script> HTTP/9.9", 505), (b"GET /<script> HTTP/1.1 extra", 400)):
            status, headers, body = self.raw_request(line + f"\r\nHost: 127.0.0.1:{self.port}\r\n\r\n".encode())
            self.assertEqual(status, expected, line)
            self.assertEqual(body, b"")
            self.assert_security_headers(headers)

    def test_unknown_routes_404(self):
        for path in ("/nope", "/index.html", "/web/app.js", "/app.js/", "/../README.md", "/%2e%2e/README.md",
                     "/..%2ftown%2fserver.py", f"http://127.0.0.1:{self.port}/", "/favicon.ico", "/api"):
            self.assertEqual(self.get(path, headers={"Host": f"127.0.0.1:{self.port}"})[0], 404, path)

    def test_unknown_api_route_needs_token_then_404(self):
        self.assertEqual(self.get("/api/secret")[0], 401)
        self.assertEqual(self.get("/api/secret", token=True)[0], 404)
        self.assertEqual(self.get("/api/open", token=True)[0], 404)
        self.assertEqual(self.post("/api/nope", {"id": "x"}, token=False)[0], 401)
        self.assertEqual(self.post("/api/nope", {"id": "x"})[0], 404)

    def test_missing_web_file_404(self):
        self.assertEqual(self.get("/app.js")[0], 404)
        status, headers, _ = self.get("/app.css")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "text/css; charset=utf-8")

    def test_static_fetch_site(self):
        self.assertEqual(self.get("/", headers={"Sec-Fetch-Site": "none"})[0], 200)
        self.assertEqual(self.get("/", headers={"Sec-Fetch-Site": "same-origin"})[0], 200)
        self.assertEqual(self.get("/", headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(self.get("/", headers={"Sec-Fetch-Site": "same-site"})[0], 403)

    def test_api_fetch_site(self):
        self.assertEqual(self.get("/api/board", token=True, headers={"Sec-Fetch-Site": "same-origin"})[0], 200)
        self.assertEqual(self.get("/api/board", token=True, headers={"Sec-Fetch-Site": "none"})[0], 403)
        self.assertEqual(self.get("/api/board", token=True, headers={"Sec-Fetch-Site": "cross-site"})[0], 403)

    def test_healthz(self):
        nonce = "0123456789abcdef0123456789abcdef"
        status, headers, body = self.get(f"/healthz?n={nonce}")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "text/plain; charset=utf-8")
        self.assertEqual(body.decode(), security.health_response(self.secret, nonce))
        for query in ("", "?n=", "?n=" + nonce.upper(), "?n=" + nonce[:-1], f"?n={nonce}&x=1", f"?x=1&n={nonce}"):
            self.assertEqual(self.get("/healthz" + query)[0], 400, query)
        self.assertEqual(self.get(f"/healthz?n={nonce}", headers={"Sec-Fetch-Site": "cross-site"})[0], 403)


class TokenTests(ServerTestCase):
    def test_board_without_token(self):
        status, headers, body = self.get("/api/board")
        self.assertEqual(status, 401)
        self.assertEqual(body, b"")
        self.assert_security_headers(headers)

    def test_board_with_wrong_token(self):
        self.assertEqual(self.get("/api/board", token="0" * 64)[0], 401)
        self.assertEqual(self.get("/api/board", token=self.token.upper())[0], 401)
        self.assertEqual(self.get("/api/board", token="\u00e9" * 64)[0], 401)

    def test_open_without_token(self):
        self.assertEqual(self.post("/api/open", {"id": LOCAL}, token=False)[0], 401)
        self.assertEqual(self.post("/api/open", {"id": LOCAL}, token="f" * 64)[0], 401)
        self.run.assert_not_called()

    def test_duplicate_token_header_refused(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.putrequest("GET", "/api/board")
            conn.putheader("X-Town-Token", self.token)
            conn.putheader("X-Town-Token", self.token)
            conn.endheaders()
            self.assertEqual(conn.getresponse().status, 401)
        finally:
            conn.close()


class PostGuardTests(ServerTestCase):
    def test_origin_other_port(self):
        self.assertEqual(self.post("/api/open", {"id": LOCAL}, origin="http://127.0.0.1:3000")[0], 403)

    def test_origin_null(self):
        self.assertEqual(self.post("/api/open", {"id": LOCAL}, origin="null")[0], 403)

    def test_origin_missing(self):
        self.assertEqual(self.post("/api/open", {"id": LOCAL}, origin=False)[0], 403)

    def test_origin_variants(self):
        for origin in (f"http://localhost:{self.port}", f"https://127.0.0.1:{self.port}", self.origin + "/",
                       f"http://127.0.0.1.:{self.port}"):
            self.assertEqual(self.post("/api/open", {"id": LOCAL}, origin=origin)[0], 403, origin)
        self.run.assert_not_called()

    def test_text_plain_post(self):
        self.assertEqual(self.post("/api/open", {"id": LOCAL}, ctype="text/plain")[0], 400)
        self.assertEqual(self.post("/api/open", {"id": LOCAL}, ctype=None)[0], 400)
        self.assertEqual(self.post("/api/open", {"id": LOCAL}, ctype="application/jsonx")[0], 400)
        self.run.assert_not_called()

    def test_json_content_type_with_charset_accepted(self):
        self.assertEqual(self.post("/api/open", {"id": LOCAL}, ctype="application/json; charset=utf-8")[0], 200)

    def test_body_over_1kb(self):
        body = json.dumps({"id": LOCAL + " " * 1100}).encode()
        self.assertGreater(len(body), 1024)
        self.assertEqual(self.post("/api/open", body=body)[0], 400)
        self.run.assert_not_called()

    def test_body_over_1kb_large(self):
        self.assertEqual(self.post("/api/open", body=b"x" * 60_000)[0], 400)

    def test_huge_content_length_refused_without_waiting_for_body(self):
        request = (
            f"POST /api/open HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nOrigin: {self.origin}\r\n"
            f"Content-Type: application/json\r\nX-Town-Token: {self.token}\r\n"
            "Content-Length: 999999999\r\n\r\n{"
        ).encode()
        started = time.monotonic()
        self.assertEqual(self.raw_request(request, "POST")[0], 400)
        self.assertLess(time.monotonic() - started, 3)
        self.run.assert_not_called()

    def test_body_exactly_1kb_is_read(self):
        body = json.dumps({"id": "x" * (1024 - len(json.dumps({"id": ""})))}).encode()
        self.assertEqual(len(body), 1024)
        self.assertEqual(self.post("/api/open", body=body)[0], 404)

    def test_extra_json_key(self):
        self.assertEqual(self.post("/api/open", {"id": LOCAL, "url": "claude://x"})[0], 400)
        self.run.assert_not_called()

    def test_malformed_bodies(self):
        for body in (b"", b"{}", b'{"id": 5}', b'[{"id": "x"}]', b"{nope", b'{"id": "a", "id": "b"}'):
            self.assertEqual(self.post("/api/open", body=body)[0], 400, body)
        self.run.assert_not_called()

    def test_chunked_post_refused(self):
        payload = json.dumps({"id": LOCAL}).encode()
        request = (
            f"POST /api/open HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nOrigin: {self.origin}\r\n"
            f"Content-Type: application/json\r\nX-Town-Token: {self.token}\r\n"
            "Transfer-Encoding: chunked\r\n\r\n"
        ).encode() + f"{len(payload):x}\r\n".encode() + payload + b"\r\n0\r\n\r\n"
        status, headers, _ = self.raw_request(request, "POST")
        self.assertEqual(status, 400)
        self.assert_security_headers(headers)
        self.run.assert_not_called()

    def test_chunked_with_content_length_refused(self):
        payload = json.dumps({"id": LOCAL}).encode()
        request = (
            f"POST /api/open HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nOrigin: {self.origin}\r\n"
            f"Content-Type: application/json\r\nX-Town-Token: {self.token}\r\n"
            f"Content-Length: {len(payload)}\r\nTransfer-Encoding: chunked\r\n\r\n"
        ).encode() + payload
        self.assertEqual(self.raw_request(request, "POST")[0], 400)
        self.run.assert_not_called()


class ClaimTests(ServerTestCase):
    def test_claim_returns_token_that_works(self):
        status, _, body = self.post("/api/claim", {"code": security.mint_code(self.secret, now_ms())}, token=False)
        self.assertEqual(status, 200)
        token = json.loads(body)["token"]
        self.assertEqual(token, self.token)
        self.assertEqual(self.get("/api/board", token=token)[0], 200)

    def test_replayed_launch_code(self):
        code = security.mint_code(self.secret, now_ms())
        self.assertEqual(self.post("/api/claim", {"code": code}, token=False)[0], 200)
        etag = self.get("/api/board", token=True)[1]["ETag"]
        status, headers, body = self.post("/api/claim", {"code": code}, token=False)
        # Refused with no token, and told apart from a bad code so the page can say the link was used.
        self.assertEqual(status, 409)
        self.assertEqual(body, b"")
        self.assert_security_headers(headers)
        status, headers, body = self.get("/api/board", token=True, headers={"If-None-Match": etag})
        self.assertEqual(status, 200)
        board = json.loads(body)
        self.assertFalse(board["health"]["ok"])
        self.assertEqual(board["health"]["warnings"], [server.REPLAY_WARNING])
        self.assertEqual(board["sessions"], self.board["sessions"])
        # The warning survives later scans and scan failures, and is added once.
        self.assertEqual(self.post("/api/claim", {"code": code}, token=False)[0], 409)
        self.assertTrue(self.app.scan_once())
        self.assertEqual(json.loads(self.get("/api/board", token=True)[2])["health"]["warnings"],
                         [server.REPLAY_WARNING])
        self.provider_error = KeyError("x")
        with mock.patch("sys.stderr", new_callable=io.StringIO):
            self.app.scan_once()
        self.assertEqual(json.loads(self.get("/api/board", token=True)[2])["health"]["warnings"],
                         ["scan failed: KeyError", server.REPLAY_WARNING])

    def test_garbage_codes_do_not_raise_the_replay_warning(self):
        for _ in range(2):
            self.assertEqual(self.post("/api/claim", {"code": "0" * 32 + ".1." + "0" * 64}, token=False)[0], 403)
        expired = security.mint_code(self.secret, now_ms() - 31_000)
        for _ in range(2):
            self.assertEqual(self.post("/api/claim", {"code": expired}, token=False)[0], 403)
        board = json.loads(self.get("/api/board", token=True)[2])
        self.assertTrue(board["health"]["ok"])
        self.assertEqual(board["health"]["warnings"], [])

    def test_expired_launch_code(self):
        code = security.mint_code(self.secret, now_ms() - 31_000)
        self.assertEqual(self.post("/api/claim", {"code": code}, token=False)[0], 403)

    def test_foreign_and_garbage_codes(self):
        for code in (security.mint_code(b"\x02" * 32, now_ms()), "", "../../etc", "a" * 900):
            self.assertEqual(self.post("/api/claim", {"code": code}, token=False)[0], 403, code[:20])

    def test_claim_needs_origin(self):
        code = security.mint_code(self.secret, now_ms())
        self.assertEqual(self.post("/api/claim", {"code": code}, token=False, origin="null")[0], 403)
        self.assertEqual(self.post("/api/claim", {"code": code}, token=False)[0], 200)


class BoardRouteTests(ServerTestCase):
    def test_board_json_and_etag(self):
        status, headers, body = self.get("/api/board", token=True)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/json; charset=utf-8")
        self.assertRegex(headers["ETag"], r'^"[0-9a-f]{32}"$')
        self.assertEqual(json.loads(body), self.board)
        self.assert_security_headers(headers)

    def test_304_with_etag(self):
        etag = self.get("/api/board", token=True)[1]["ETag"]
        status, headers, body = self.get("/api/board", token=True, headers={"If-None-Match": etag})
        self.assertEqual(status, 304)
        self.assertEqual(body, b"")
        self.assertEqual(headers["ETag"], etag)
        self.assert_security_headers(headers)
        self.assertEqual(self.get("/api/board", token=True, headers={"If-None-Match": '"stale"'})[0], 200)
        self.assertEqual(self.get("/api/board", headers={"If-None-Match": etag})[0], 401)

    def test_etag_ignores_generated_at_and_scan_ms_only(self):
        etag = self.get("/api/board", token=True)[1]["ETag"]
        self.board = make_board(generated_at=999, scan_ms=77)
        self.assertTrue(self.app.scan_once())
        self.assertEqual(self.get("/api/board", token=True, headers={"If-None-Match": etag})[0], 304)
        self.board = make_board(generated_at=999, title="changed")
        self.app.scan_once()
        status, headers, _ = self.get("/api/board", token=True, headers={"If-None-Match": etag})
        self.assertEqual(status, 200)
        self.assertNotEqual(headers["ETag"], etag)

    def test_hostile_title_round_trips_as_inert_json(self):
        status, headers, body = self.get("/api/board", token=True)
        self.assertEqual(status, 200)
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertTrue(headers["Content-Type"].startswith("application/json"))
        for byte in (b"<", b">", b"&", "\u2028".encode()):
            self.assertNotIn(byte, body)
        self.assertEqual(json.loads(body)["sessions"][0]["title"], HOSTILE)

    def test_scan_failure_keeps_last_good_board(self):
        self.provider_error = KeyError("secret title that must not leak")
        with mock.patch("sys.stderr", new_callable=io.StringIO) as stderr:
            self.assertFalse(self.app.scan_once())
            self.assertFalse(self.app.scan_once())
        self.assertEqual(stderr.getvalue(), "tokentown: KeyError\ntokentown: KeyError\n")
        board = json.loads(self.get("/api/board", token=True)[2])
        self.assertFalse(board["health"]["ok"])
        self.assertEqual(board["health"]["warnings"], ["scan failed: KeyError"])
        self.assertEqual(board["sessions"], self.board["sessions"])
        self.assertNotIn("must not leak", json.dumps(board))
        self.provider_error = None
        self.assertTrue(self.app.scan_once())
        self.assertTrue(json.loads(self.get("/api/board", token=True)[2])["health"]["ok"])


class FirstScanTests(unittest.TestCase):
    def setUp(self):
        no_real_subprocesses(self)

    def test_503_before_first_scan(self):
        release = threading.Event()
        board = make_board()

        def slow_provider():
            release.wait(5)
            return make_raw(), board

        secret = bytes(range(32))
        httpd, app = start_server(self, provider=slow_provider, secret=secret, wait=False)
        port = httpd.server_address[1]
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("GET", "/api/board", headers={"X-Town-Token": security.session_token(secret)})
        resp = conn.getresponse()
        self.assertEqual(resp.status, 503)
        self.assertEqual(json.loads(resp.read()), {"scanning": True})
        for name, value in security.SECURITY_HEADERS:
            self.assertEqual(resp.headers.get(name), value)
        conn.close()
        release.set()
        self.assertTrue(app.wait_first_scan(5))
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("GET", "/api/board", headers={"X-Town-Token": security.session_token(secret)})
        self.assertEqual(conn.getresponse().status, 200)
        conn.close()

    def test_scan_failure_before_any_board_stays_503(self):
        def broken():
            raise RuntimeError("boom")

        secret = bytes(range(32))
        with mock.patch("sys.stderr", new_callable=io.StringIO):
            httpd, _ = start_server(self, provider=broken, secret=secret)
        conn = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=5)
        conn.request("GET", "/api/board", headers={"X-Town-Token": security.session_token(secret)})
        self.assertEqual(conn.getresponse().status, 503)
        conn.close()


class OpenRouteTests(ServerTestCase):
    def test_open_calls_open_with_exactly_the_allowlisted_url(self):
        status, _, body = self.post("/api/open", {"id": LOCAL})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"ok": True})
        self.run.assert_called_once_with(["/usr/bin/open", f"claude://claude.ai/epitaxy/{LOCAL}"], **OPEN_KWARGS)

    def test_id_not_in_board(self):
        self.assertEqual(self.post("/api/open", {"id": NOT_IN_BOARD})[0], 404)
        self.assertEqual(self.post("/api/open", {"id": NO_OPEN})[0], 404)
        self.assertEqual(self.post("/api/open", {"id": "cli:" + QUOTE_UUID})[0], 404)
        self.assertEqual(self.post("/api/open", {"id": "cli:" + VSCODE_SHUT_UUID})[0], 404)
        self.assertEqual(self.post("/api/open", {"id": "cli:" + TERMINAL_OPEN_UUID})[0], 404)
        self.run.assert_not_called()

    def test_open_vscode_session(self):
        status, _, body = self.post("/api/open", {"id": "cli:" + VSCODE_UUID})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"ok": True})
        self.assertEqual(self.run.call_args_list, [mock.call(["/usr/bin/open", *VSCODE_FOLDER], **OPEN_KWARGS),
                                                   mock.call(["/usr/bin/open", VSCODE_URL], **OPEN_KWARGS)])

    def test_open_live_vscode_session(self):
        self.assertEqual(self.post("/api/open", {"id": "cli:" + VSCODE_LIVE_UUID})[0], 200)
        self.run.assert_called_once_with(["/usr/bin/open", *VSCODE_FOLDER], **OPEN_KWARGS)

    def test_open_live_insiders_session_in_insiders(self):
        next(r for r in self.board["sessions"] if r["id"] == "cli:" + VSCODE_LIVE_UUID)["editor"] = "vscode-insiders"
        self.app.scan_once()
        self.assertEqual(self.post("/api/open", {"id": "cli:" + VSCODE_LIVE_UUID})[0], 200)
        self.run.assert_called_once_with(["/usr/bin/open", "-b", "com.microsoft.VSCodeInsiders", VSCODE_CWD],
                                         **OPEN_KWARGS)

    def test_vscode_id_with_extra_text(self):
        for bad in ("cli:" + VSCODE_UUID + "\n", "cli:" + VSCODE_UUID + "&prompt=x", VSCODE_URL,
                    "cli:" + VSCODE_UUID + "/../" + LOCAL):
            self.assertEqual(self.post("/api/open", {"id": bad})[0], 404, bad)
        self.run.assert_not_called()

    def test_id_with_path_traversal(self):
        for bad in ("../" + LOCAL, LOCAL + "/../x", "local_../../../etc/passwd", LOCAL + "\n",
                    f"{LOCAL}?x=1", "claude://claude.ai/epitaxy/" + LOCAL):
            self.assertEqual(self.post("/api/open", {"id": bad})[0], 404, bad)
        self.run.assert_not_called()

    def test_429_on_rapid_opens(self):
        self.assertEqual(self.post("/api/open", {"id": LOCAL})[0], 200)
        self.clock.t += 0.2
        self.assertEqual(self.post("/api/open", {"id": LOCAL})[0], 429)
        self.clock.t += 0.6
        self.assertEqual(self.post("/api/open", {"id": LOCAL})[0], 200)
        self.assertEqual(self.run.call_count, 2)


class ResumeRouteTests(ServerTestCase):
    def test_resume_command_quoting(self):
        status, _, body = self.post("/api/resume-command", {"id": "cli:" + QUOTE_UUID})
        self.assertEqual(status, 200)
        command = json.loads(body)["command"]
        self.assertEqual(command, f"cd '/tmp/a'\"'\"'; touch x #' && claude --resume {QUOTE_UUID}")
        self.assertEqual(shlex.split(command), ["cd", QUOTE_CWD, "&&", "claude", "--resume", QUOTE_UUID])

    def test_resume_command_newline_refused(self):
        status, _, body = self.post("/api/resume-command", {"id": "cli:" + NEWLINE_UUID})
        self.assertEqual(status, 404)
        self.assertEqual(body, b"")

    def test_resume_command_unknown_or_desktop_id(self):
        self.assertEqual(self.post("/api/resume-command", {"id": LOCAL})[0], 404)
        self.assertEqual(self.post("/api/resume-command", {"id": "cli:" + NOT_IN_BOARD[6:]})[0], 404)
        self.assertEqual(self.post("/api/resume-command", {"id": "cli:" + QUOTE_UUID, "cwd": "/"})[0], 400)
        self.run.assert_not_called()


BEHIND = {"enabled": True, "reason": None, "state": "behind",
          "latest": {"tag": "v1.1.0", "name": "Tokentown 1.1.0", "published": 5000}, "version": "v1.0.0",
          "restart": False, "lastError": None, "lastCheckedAt": 5678}


class UpdateRouteTests(ServerTestCase):
    """The page posts {} and gets the command to copy. The folder in it is the one the server runs from, never one
    the page sent."""

    def make_update_checker(self):
        self.checker = FakeUpdateChecker(dict(BEHIND))
        return self.checker

    def test_a_pull_command_while_behind(self):
        status, headers, body = self.post("/api/update-command", {})
        self.assertEqual(status, 200)
        self.assert_security_headers(headers)
        self.assertEqual(json.loads(body), {"command": "cd /Users/someone/tools/tokentown && git fetch --tags origin"
                                                       " && git merge --ff-only v1.1.0 && ./tokentown stop && "
                                                       "./tokentown"})

    def test_a_restart_command_once_pulled(self):
        self.checker.health_value = dict(BEHIND, state="current", restart=True)
        status, _, body = self.post("/api/update-command", {})
        self.assertEqual((status, json.loads(body)["command"]),
                         (200, "cd /Users/someone/tools/tokentown && ./tokentown stop && ./tokentown"))

    def test_nothing_to_do_is_404(self):
        for health in (dict(BEHIND, state="current"), dict(BEHIND, state="ahead"),
                       dict(BEHIND, enabled=False, reason="not on main"), dict(BEHIND, state=None),
                       dict(BEHIND, latest=None), dict(BEHIND, latest={"tag": "v1.1.0 && curl evil"})):
            with self.subTest(health=health):
                self.checker.health_value = health
                status, _, body = self.post("/api/update-command", {})
                self.assertEqual((status, body), (404, b""))

    def test_a_folder_it_will_not_quote_is_404(self):
        self.checker.code_dir = Path("/tmp/safe\u202eevil")
        self.assertEqual(self.post("/api/update-command", {})[0], 404)

    def test_the_body_must_be_exactly_an_empty_object(self):
        for body in (b"", b"[]", b'{"id": "x"}', b'{"folder": "/tmp"}', b'{"command": "rm -rf ~"}', b"{nope",
                     b"null"):
            with self.subTest(body=body):
                self.assertEqual(self.post("/api/update-command", body=body)[0], 400)

    def test_guards(self):
        self.assertEqual(self.post("/api/update-command", {}, token=False)[0], 401)
        self.assertEqual(self.post("/api/update-command", {}, token="nope")[0], 401)
        self.assertEqual(self.post("/api/update-command", {}, origin="http://127.0.0.1:3000")[0], 403)
        self.assertEqual(self.post("/api/update-command", {}, ctype="text/plain")[0], 400)
        self.assertEqual(self.get("/api/update-command", token=True)[0], 404)
        self.run.assert_not_called()


class ReleasesRouteTests(ServerTestCase):
    """What's new reads the releases the last check brought back: a GET with the token, and no gh of its own."""

    def make_update_checker(self):
        self.checker = FakeUpdateChecker(dict(BEHIND))
        self.checker.releases_value = [
            {"tag": "v1.1.0", "name": "Tokentown 1.1.0", "published": 5000, "notes": HOSTILE},
            {"tag": "v1.0.0", "name": "", "published": 1000, "notes": "The first release"},
        ]
        return self.checker

    def test_the_releases_as_the_checker_holds_them(self):
        status, headers, body = self.get("/api/releases", token=True)
        self.assertEqual(status, 200)
        self.assert_security_headers(headers)
        self.assertEqual(json.loads(body), {"releases": self.checker.releases_value})
        self.assertNotIn(b"<", body, "notes are text: <, > and & are escaped like every other answer")
        self.assertEqual(self.checker.updates, 0, "reading the notes never updates")

    def test_guards(self):
        self.assertEqual(self.get("/api/releases")[0], 401)
        self.assertEqual(self.get("/api/releases", token="nope")[0], 401)
        self.assertEqual(self.get("/api/releases", token=True, headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(self.post("/api/releases", {})[0], 404)


class UpdateNowRouteTests(ServerTestCase):
    """Update now: the page posts {}, the checker runs git, and a 202 is the last thing this server sends."""

    def make_update_checker(self):
        self.checker = FakeUpdateChecker(dict(BEHIND, canPull=True))
        return self.checker

    def test_a_pull_answers_202_and_then_the_server_stops_to_restart(self):
        self.checker.outcome = ("pulled", None)
        stopped = threading.Event()
        real_shutdown = self.httpd.shutdown

        def shutdown():
            real_shutdown()
            stopped.set()

        with mock.patch.object(self.httpd, "shutdown", side_effect=shutdown):
            status, headers, body = self.post("/api/update", {})
            self.assertEqual((status, json.loads(body)), (202, {"restarting": True, "pulled": True}))
            self.assert_security_headers(headers)
            self.assertTrue(stopped.wait(5), "the server stops once the answer is sent")
        self.assertTrue(self.app.restarting)
        self.assertEqual(self.checker.updates, 1)

    def test_a_restart_alone_says_so(self):
        self.checker.outcome = ("restart", None)
        with mock.patch.object(self.httpd, "shutdown"):
            status, _, body = self.post("/api/update", {})
        self.assertEqual((status, json.loads(body)), (202, {"restarting": True, "pulled": False}))

    def test_once_restarting_nothing_runs_again(self):
        self.checker.outcome = ("pulled", None)
        self.assertEqual(self.app.update_now(), (202, {"restarting": True, "pulled": True}))
        self.assertEqual(self.app.update_now(), (409, None))
        self.assertEqual(self.checker.updates, 1)

    def test_every_other_outcome_leaves_the_server_running(self):
        cases = [
            (("nothing", None), 409, b""),
            (("busy", None), 429, b""),
            (("fetch", "exit 128"), 500, {"step": "fetch", "error": "exit 128"}),
            (("merge", "exit 1"), 500, {"step": "merge", "error": "exit 1"}),
            (("start", "exit 1"), 500, {"step": "start", "error": "exit 1"}),
        ]
        with mock.patch.object(self.httpd, "shutdown", side_effect=AssertionError("must not stop")):
            for outcome, expected_status, expected_body in cases:
                with self.subTest(outcome=outcome):
                    self.checker.outcome = outcome
                    status, _, body = self.post("/api/update", {})
                    self.assertEqual(status, expected_status)
                    self.assertEqual(json.loads(body) if body else b"", expected_body)
        self.assertFalse(self.app.restarting)

    def test_the_body_must_be_exactly_an_empty_object(self):
        for body in (b"", b"[]", b'{"branch": "main"}', b'{"command": "rm -rf ~"}', b'{"folder": "/tmp"}', b"null"):
            with self.subTest(body=body):
                self.assertEqual(self.post("/api/update", body=body)[0], 400)
        self.assertEqual(self.checker.updates, 0)

    def test_guards(self):
        self.assertEqual(self.post("/api/update", {}, token=False)[0], 401)
        self.assertEqual(self.post("/api/update", {}, token="nope")[0], 401)
        self.assertEqual(self.post("/api/update", {}, origin="http://127.0.0.1:3000")[0], 403)
        self.assertEqual(self.post("/api/update", {}, origin=False)[0], 403)
        self.assertEqual(self.post("/api/update", {}, ctype="text/plain")[0], 400)
        self.assertEqual(self.get("/api/update", token=True)[0], 404)
        self.assertEqual(self.checker.updates, 0)
        self.assertFalse(self.app.restarting)


class ServeRestartTests(unittest.TestCase):
    """serve() restarts into the copy on disk only after Update now, and only once everything has stopped."""

    def serve_once(self, restarting: bool):
        httpd, app = mock.Mock(), mock.Mock()
        app.restarting = restarting
        stopped = []
        app.stop.side_effect = lambda: stopped.append("app")
        httpd.server_close.side_effect = lambda: stopped.append("socket")
        with tempfile.TemporaryDirectory() as home, \
                mock.patch.dict(os.environ, {"TOWN_HOME": home}), \
                mock.patch("town.server.make_server", return_value=(httpd, app)), \
                mock.patch("town.server.signal.signal"), \
                mock.patch("town.server.os.execv", side_effect=lambda *a: stopped.append("exec")) as execv, \
                mock.patch("sys.stdout", new_callable=io.StringIO):
            server.serve(port=0)
        httpd.serve_forever.assert_called_once_with()
        return execv, stopped

    def test_it_restarts_into_the_launchers_serve_after_a_clean_stop(self):
        execv, order = self.serve_once(True)
        execv.assert_called_once_with(sys.executable, [sys.executable, str(CODE_DIR / "tokentown"), "serve"])
        self.assertEqual(order, ["app", "socket", "exec"])
        self.assertEqual(server.restart_argv(), [sys.executable, str(LAUNCHER), "serve"])

    def test_a_plain_stop_never_restarts(self):
        execv, order = self.serve_once(False)
        execv.assert_not_called()
        self.assertEqual(order, ["app", "socket"])


class NoUpdateCheckerTests(ServerTestCase):
    def test_no_checker_no_command_and_no_health(self):
        self.assertIsNone(self.app.update_checker)
        self.assertEqual(self.get("/api/releases", token=True)[0], 404)
        self.assertEqual(self.post("/api/update", {})[0], 404)
        self.assertFalse(self.app.restarting)
        self.assertEqual(self.post("/api/update-command", {})[0], 404)
        self.assertEqual(self.app.refresh_updates_once(), 0)
        self.assertNotIn("updates", json.loads(self.get("/api/board", token=True)[2])["health"])


DONE_ROW = "local_bbbbbbbb-2222-4333-8444-555555555555"
MERGED_ROW = "local_cccccccc-2222-4333-8444-555555555555"


class DoneRouteTests(ServerTestCase):
    """POST /api/done: the /api/open guards, then a current row, canMarkDone, the rate limit and the store."""

    def make_done_store(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        self.store = DoneStore(Paths(home=Path(home.name)))
        self.provide_calls = 0
        return self.store

    def provide(self):
        self.provide_calls += 1
        board = json.loads(json.dumps(make_board()))
        board["sessions"] += [
            {"id": DONE_ROW, "kind": "desktop", "lane": "valhalla", "label": "Done", "title": None, "canOpen": True,
             "canCopyResume": False, "canMarkDone": False, "valhallaReason": "done", "doneAt": 5},
            {"id": MERGED_ROW, "kind": "desktop", "lane": "castle", "label": "Merged", "title": None, "canOpen": True,
             "canCopyResume": False, "canMarkDone": False, "valhallaReason": "merged", "doneAt": None},
        ]
        marks = self.store.marks()
        for row in board["sessions"]:
            if row["id"] in marks and row["canMarkDone"]:
                row.update(lane="valhalla", label="Done", valhallaReason="done", doneAt=marks[row["id"]],
                           canMarkDone=False)
        self.board = board
        return self.raw, board

    def done(self, row_id=LOCAL, value=True, **kw):
        return self.post("/api/done", {"id": row_id, "done": value}, **kw)

    def lane_of(self, row_id):
        board = json.loads(self.get("/api/board", token=True)[2])
        return next((r["lane"], r["valhallaReason"]) for r in board["sessions"] if r["id"] == row_id)

    def assert_untouched(self):
        self.assertEqual(self.store.marks(), {})
        self.assertFalse(self.store.path.exists())

    def test_mark_and_unmark_round_trip_and_the_board_moves_at_once(self):
        self.assertEqual(self.lane_of(LOCAL), ("recent", None))
        before = now_ms()
        status, headers, body = self.done(LOCAL, True)
        self.assertEqual((status, json.loads(body)), (200, {"ok": True}))
        self.assertEqual(headers["Content-Type"], "application/json; charset=utf-8")
        self.assert_security_headers(headers)
        self.assertEqual(set(self.store.marks()), {LOCAL})
        self.assertGreaterEqual(self.store.marks()[LOCAL], before)
        self.assertEqual(self.lane_of(LOCAL), ("valhalla", "done"))
        self.assertEqual(stat.S_IMODE(os.lstat(self.store.path).st_mode), 0o600)

        self.done_clock.t += 0.31
        self.assertEqual(self.done(LOCAL, False)[0], 200)
        self.assertEqual(self.store.marks(), {})
        self.assertEqual(self.lane_of(LOCAL), ("recent", None))

    def test_cli_rows_can_be_marked(self):
        self.assertEqual(self.done("cli:" + QUOTE_UUID)[0], 200)
        self.assertEqual(set(self.store.marks()), {"cli:" + QUOTE_UUID})

    def test_unmarking_an_unmarked_row_is_idempotent(self):
        calls = self.provide_calls
        self.assertEqual(self.done(LOCAL, False), (200, mock.ANY, b'{"ok":true}'))
        self.done_clock.t += 0.31
        self.assertEqual(self.done(MERGED_ROW, False)[0], 200)
        self.assertEqual(self.provide_calls, calls)
        self.assert_untouched()

    def test_marking_a_row_already_done_is_a_no_op(self):
        self.assertEqual(self.done(DONE_ROW, True)[0], 200)
        self.assert_untouched()

    def test_not_allowed_is_409(self):
        for row_id in (NO_OPEN, MERGED_ROW):
            with self.subTest(row_id=row_id):
                self.assertEqual(self.done(row_id, True)[0], 409)
        self.assert_untouched()

    def test_unknown_or_malformed_ids_are_404(self):
        for bad in (NOT_IN_BOARD, "cli:" + NOT_IN_BOARD[6:], "../" + LOCAL, LOCAL + "\n", LOCAL.upper(),
                    "local_../../../etc/passwd", "cli:../x", "", "x" * 200):
            for value in (True, False):
                with self.subTest(id=bad, done=value):
                    self.assertEqual(self.done(bad, value)[0], 404)
        self.assert_untouched()

    def test_rate_limit_300ms(self):
        self.assertEqual(self.done(LOCAL, True)[0], 200)
        self.done_clock.t += 0.29
        self.assertEqual(self.done(LOCAL, False)[0], 429)
        self.assertEqual(set(self.store.marks()), {LOCAL})
        self.done_clock.t += 0.02
        self.assertEqual(self.done(LOCAL, False)[0], 200)
        self.assertEqual(self.store.marks(), {})

    def test_refused_requests_do_not_use_up_the_rate_limit(self):
        self.assertEqual(self.done(NOT_IN_BOARD)[0], 404)
        self.assertEqual(self.done(NO_OPEN)[0], 409)
        self.assertEqual(self.done(LOCAL, "yes")[0], 400)
        self.assertEqual(self.done(LOCAL)[0], 200)

    def test_request_guards(self):
        body = {"id": LOCAL, "done": True}
        cases = [
            (dict(headers={"Host": "localhost:%d" % self.port}), 403),
            (dict(origin="http://127.0.0.1:3000"), 403),
            (dict(origin="null"), 403),
            (dict(origin=False), 403),
            (dict(origin=f"http://localhost:{self.port}"), 403),
            (dict(ctype="text/plain"), 400),
            (dict(ctype=None), 400),
            (dict(token=False), 401),
            (dict(token="0" * 64), 401),
        ]
        for kw, expected in cases:
            with self.subTest(kw=kw):
                self.assertEqual(self.post("/api/done", body, **kw)[0], expected)
        self.assert_untouched()

    def test_body_shape(self):
        bodies = [
            b"", b"{}", b"[]", b"null", b"{nope", json.dumps({"id": LOCAL}).encode(), json.dumps({"done": True}).encode(),
            json.dumps({"id": LOCAL, "done": True, "at": 1}).encode(),
            json.dumps({"id": LOCAL, "done": "true"}).encode(), json.dumps({"id": LOCAL, "done": 1}).encode(),
            json.dumps({"id": LOCAL, "done": None}).encode(), json.dumps({"id": 5, "done": True}).encode(),
            json.dumps({"id": [LOCAL], "done": True}).encode(),
            b'{"id": "%s", "done": true, "done": false}' % LOCAL.encode(),
            b'{"id": "%s", "done": NaN}' % LOCAL.encode(), b"\xff\xfe",
            json.dumps({"id": LOCAL + " " * 1100, "done": True}).encode(),
        ]
        for body in bodies:
            with self.subTest(body=body[:60]):
                self.assertEqual(self.post("/api/done", body=body)[0], 400)
        self.assertEqual(self.post("/api/done", body=b"x" * 60_000)[0], 400)
        self.assert_untouched()

    def test_options_and_get_are_refused(self):
        status, headers, _ = self.request("OPTIONS", "/api/done", {"Origin": self.origin})
        self.assertEqual(status, 403)
        self.assertEqual(self.get("/api/done", token=True)[0], 404)
        self.assert_untouched()

    def test_write_failure_is_500_without_detail(self):
        with mock.patch.object(DoneStore, "_write", side_effect=OSError("/Users/someone/secret path")), \
                mock.patch("sys.stderr", new_callable=io.StringIO) as stderr:
            status, _, body = self.done(LOCAL)
        self.assertEqual((status, body), (500, b""))
        self.assertEqual(stderr.getvalue(), "tokentown: OSError\n")
        self.assertEqual(self.store.marks(), {})


class NoDoneStoreTests(ServerTestCase):
    def test_injected_provider_without_a_store_answers_404(self):
        self.assertIsNone(self.app.done_store)
        self.assertEqual(self.post("/api/done", {"id": LOCAL, "done": True})[0], 404)
        self.assertEqual(self.post("/api/done", {"id": LOCAL, "done": False})[0], 404)


class BindTests(unittest.TestCase):
    def setUp(self):
        no_real_subprocesses(self)

    def test_binds_loopback_only(self):
        httpd, _ = start_server(self, provider=lambda: (make_raw(), make_board()), secret=bytes(32))
        self.assertEqual(httpd.server_address[0], "127.0.0.1")

    def test_serve_refuses_malformed_secret_before_binding(self):
        with tempfile.TemporaryDirectory() as home:
            paths = Paths(home=Path(home))
            paths.secret_dir.mkdir(parents=True, mode=0o700)
            paths.secret_file.write_text("garbage")
            with mock.patch.dict(os.environ, {"TOWN_HOME": home}), \
                    mock.patch("town.server.make_server", side_effect=AssertionError("must not bind")), \
                    mock.patch("sys.stderr", new_callable=io.StringIO) as err:
                with self.assertRaises(SystemExit) as ctx:
                    server.serve(port=0)
        self.assertEqual(ctx.exception.code, 1)
        self.assertIn("tokentown rotate", err.getvalue())

    def test_port_taken_fails_loudly(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as taken:
            taken.bind(("127.0.0.1", 0))
            taken.listen(1)
            port = taken.getsockname()[1]
            with self.assertRaises(OSError):
                server.make_server(port, board_provider=lambda: (None, {}), opener=actions.Opener(run=mock.Mock()),
                                   secret=bytes(32))


class IntegrationTests(unittest.TestCase):
    """The default provider: the real Scanner and build_board over a synthetic home."""

    def setUp(self):
        no_real_subprocesses(self)

    def test_default_provider_board_and_open(self):
        from tests.fixtures import HOSTILE as FIXTURE_HOSTILE, SyntheticHome

        home = SyntheticHome(now_ms=now_ms())
        self.addCleanup(home.cleanup)
        handle = home.add_desktop(title=FIXTURE_HOSTILE)
        run = mock.Mock(return_value=subprocess.CompletedProcess([], 0))
        secret = bytes(range(32))
        httpd, _ = start_server(self, provider=None, paths=home.paths, secret=secret,
                                opener=actions.Opener(run=run, clock=FakeClock()), pr_resolver=FakeResolver())
        port = httpd.server_address[1]
        token = security.session_token(secret)

        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("GET", "/api/board", headers={"X-Town-Token": token})
        resp = conn.getresponse()
        body = resp.read()
        conn.close()
        self.assertEqual(resp.status, 200)
        board = json.loads(body)
        rows = [r for r in board["sessions"] if r["id"] == handle.session_id]
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["canOpen"])
        self.assertEqual(rows[0]["title"], FIXTURE_HOSTILE)
        self.assertNotIn(b"<", body)

        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("POST", "/api/open", body=json.dumps({"id": handle.session_id}), headers={
            "Origin": f"http://127.0.0.1:{port}", "Content-Type": "application/json", "X-Town-Token": token})
        self.assertEqual(conn.getresponse().status, 200)
        conn.close()
        run.assert_called_once_with(["/usr/bin/open", f"claude://claude.ai/epitaxy/{handle.session_id}"],
                                    **OPEN_KWARGS)

    def test_default_provider_uses_github_states_and_urls(self):
        from tests.fixtures import SyntheticHome

        home = SyntheticHome(now_ms=now_ms())
        self.addCleanup(home.cleanup)
        handle = home.add_desktop(prs=[home.pr(7, "OPEN"), home.pr(8, "OPEN", dismissed=True)])
        url = "https://github.com/o/r/pull/7"
        merged = GitHubPr(state="MERGED", merged_at=now_ms() - 3_600_000, closed_at=None, checked_at=now_ms())
        fake = FakeResolver(states={url: merged})
        secret = bytes(range(32))
        httpd, _ = start_server(self, provider=None, paths=home.paths, secret=secret, pr_resolver=fake)
        self.assertTrue(fake.called.acquire(timeout=5))
        self.assertEqual(fake.calls[0], [url])

        conn = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=5)
        conn.request("GET", "/api/board", headers={"X-Town-Token": security.session_token(secret)})
        board = json.loads(conn.getresponse().read())
        conn.close()
        self.assertEqual(board["health"]["github"], fake.health())
        row = next(r for r in board["sessions"] if r["id"] == handle.session_id)
        self.assertEqual((row["pr"]["number"], row["pr"]["state"], row["pr"]["verified"]), (7, "MERGED", True))


# ====================================================================== GitHub PR state wiring

U1 = "https://github.com/o/r/pull/1"
U2 = "https://github.com/o/r/pull/2"
U3 = "https://github.com/o/r/pull/3"
U4 = "https://github.com/o/other/pull/4"


def desktop_record(n: int, last_activity_at: int, prs: tuple[PullRequest, ...]) -> DesktopRecord:
    return DesktopRecord(
        session_id=f"local_{n:08d}-2222-4333-8444-555555555555", cli_session_id=None, cwd="/w/repo",
        origin_cwd="/w/repo", title=None, model=None, effort=None, branch=None, permission_mode=None,
        created_at=None, last_activity_at=last_activity_at, last_focused_at=None, is_archived=False, error_at=None,
        prs=prs, transcript_unavailable=False)


def raw_with_prs() -> RawSnapshot:
    older = desktop_record(1, 100, (
        PullRequest(1, "MERGED", U1), PullRequest(2, "OPEN", U2, dismissed=True), PullRequest(3, "OPEN", U3)))
    newer = desktop_record(2, 200, (
        PullRequest(4, "OPEN", U4), PullRequest(5, "OPEN", "javascript:alert(1)"), PullRequest(6, "OPEN", None),
        PullRequest(7, "OPEN", U1 + "\n"), PullRequest(1, "OPEN", U1)))
    oldest = desktop_record(3, 50, ())
    return RawSnapshot(scanned_at=1, desktop=(older, newer, oldest), registry_files=0, registry_live=(),
                       cli_only=(), tails={}, app_version=None, cli_versions=(), desktop_parse_errors=0, scan_ms=3)


class GitHubWiringTests(unittest.TestCase):
    def setUp(self):
        no_real_subprocesses(self)
        self.secret = bytes(range(32))
        self.board = make_board()
        self.fake = FakeResolver()

    def get_board(self, httpd) -> dict:
        conn = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=5)
        try:
            conn.request("GET", "/api/board", headers={"X-Town-Token": security.session_token(self.secret)})
            resp = conn.getresponse()
            self.assertEqual(resp.status, 200)
            return json.loads(resp.read())
        finally:
            conn.close()

    def test_pr_urls_non_dismissed_valid_newest_session_first(self):
        self.assertEqual(server.pr_urls(raw_with_prs()), [U1, U4, U3])
        self.assertEqual(server.pr_urls(None), [])
        self.assertEqual(server.pr_urls(make_raw()), [])

    def test_pr_urls_include_transcript_links(self):
        u = "https://github.com/o/r/pull/{}".format
        cli_a, cli_b, cli_c = "a" * 8 + "-2222-4333-8444-555555555555", "b" * 8 + "-2222-4333-8444-555555555555", \
            "c" * 8 + "-2222-4333-8444-555555555555"

        older = desktop_record(1, 100, (PullRequest(1, "MERGED", u(1)), PullRequest(9, "OPEN", u(9), dismissed=True)))
        older = DesktopRecord(**{f: getattr(older, f) for f in DesktopRecord.__slots__} | {"cli_session_id": cli_a})
        newer = desktop_record(2, 200, (PullRequest(4, "OPEN", u(4), dismissed=True),))
        newer = DesktopRecord(**{f: getattr(newer, f) for f in DesktopRecord.__slots__} | {"cli_session_id": cli_b})
        links = {
            cli_a: (PrLink(3, u(3), "o/r", 9), PrLink(2, u(2), "o/r", 5), PrLink(9, u(9), "o/r", 20),
                    PrLink(1, u(1), "o/r", 1), PrLink(7, "javascript:alert(1)", "o/r", 30)),
            cli_b: (PrLink(4, u(4), "o/r", 50), PrLink(5, u(5), "o/r", 40)),
            cli_c: (PrLink(6, u(6), "o/r", None),),
        }
        clis = (CliTranscript(session_id=cli_c, cwd="/w", cwd_exists=True, last_activity_at=150),
                CliTranscript(session_id=cli_a, cwd="/w", cwd_exists=True, last_activity_at=10_000))
        raw = RawSnapshot(scanned_at=10_000, desktop=(older, newer), registry_files=0, registry_live=(), cli_only=clis,
                          tails={}, app_version=None, cli_versions=(), desktop_parse_errors=0, scan_ms=3,
                          pr_links=links)
        self.assertEqual(server.pr_urls(raw), [u(5), u(6), u(3), u(2), u(1)])

        record = TailRecord(type="assistant", subtype=None, timestamp=300, is_sidechain=False, is_meta=False,
                            stop_reason="end_turn", block_types=("text",), tool_uses=(), tool_result_ids=(),
                            is_api_error=False, error_kind=None, retry_attempt=None, max_retries=None,
                            quota_status=None, quota_resets_at=None, quota_limit_type=None)
        moved = RawSnapshot(**{f: getattr(raw, f) for f in RawSnapshot.__dataclass_fields__}
                            | {"tails": {cli_a: Tail(found=True, records=(record,), newest_mtime=300)}})
        self.assertEqual(server.pr_urls(moved), [u(3), u(2), u(1), u(5), u(6)])

    def test_etag_ignores_github_last_checked_at_only(self):
        board = make_board()
        board["health"]["github"] = {"enabled": True, "known": 3, "failed": 0, "lastError": None,
                                     "lastCheckedAt": 1790000000000}
        later = json.loads(json.dumps(board))
        later["health"]["github"]["lastCheckedAt"] = 1790000060000
        self.assertEqual(server.board_etag(board), server.board_etag(later))
        later["health"]["github"]["known"] = 4
        self.assertNotEqual(server.board_etag(board), server.board_etag(later))
        self.assertEqual(board["health"]["github"]["lastCheckedAt"], 1790000000000)

        httpd, app = start_server(self, provider=lambda: (raw_with_prs(), self.board), secret=self.secret,
                                  pr_resolver=self.fake)
        etag = app.snapshot()[3]
        self.fake.health_value = dict(self.fake.health_value, lastCheckedAt=99_999)
        self.assertTrue(app.scan_once())
        self.assertEqual(app.snapshot()[3], etag)
        self.assertEqual(self.get_board(httpd)["health"]["github"]["lastCheckedAt"], 99_999)

    def test_first_cycle_as_soon_as_the_first_scan_exists(self):
        start_server(self, provider=lambda: (raw_with_prs(), self.board), secret=self.secret,
                     pr_resolver=self.fake)
        self.assertTrue(self.fake.called.acquire(timeout=5))
        self.assertEqual(self.fake.calls, [[U1, U4, U3]])
        self.assertFalse(self.fake.called.acquire(timeout=0.2))

    def test_no_cycle_before_the_first_scan(self):
        release = threading.Event()
        self.addCleanup(release.set)

        def slow():
            release.wait(5)
            return raw_with_prs(), self.board

        _, app = start_server(self, provider=slow, secret=self.secret, pr_resolver=self.fake, wait=False)
        self.assertFalse(self.fake.called.acquire(timeout=0.3))
        release.set()
        self.assertTrue(app.wait_first_scan(5))
        self.assertTrue(self.fake.called.acquire(timeout=5))

    def test_no_cycle_while_scans_have_no_snapshot(self):
        start_server(self, provider=lambda: (None, self.board), secret=self.secret, pr_resolver=self.fake,
                     scan_interval=0.02, pr_interval=0.02)
        self.assertFalse(self.fake.called.acquire(timeout=0.3))

    def test_cycles_repeat_on_the_interval(self):
        start_server(self, provider=lambda: (raw_with_prs(), self.board), secret=self.secret,
                     pr_resolver=self.fake, pr_interval=0.02)
        for _ in range(3):
            self.assertTrue(self.fake.called.acquire(timeout=5))

    def test_cycle_reads_the_latest_snapshot(self):
        raws = [make_raw()]
        _, app = start_server(self, provider=lambda: (raws[0], self.board), secret=self.secret,
                              pr_resolver=self.fake)
        self.assertTrue(self.fake.called.acquire(timeout=5))
        self.assertEqual(self.fake.calls[-1], [])
        raws[0] = raw_with_prs()
        self.assertTrue(app.scan_once())
        self.assertEqual(app.refresh_prs_once(), 0)
        self.assertEqual(self.fake.calls[-1], [U1, U4, U3])

    def test_refresh_error_logs_class_only_and_the_loop_continues(self):
        self.fake.errors.append(KeyError("secret title that must not leak"))
        with mock.patch("sys.stderr", new_callable=io.StringIO) as stderr:
            start_server(self, provider=lambda: (raw_with_prs(), self.board), secret=self.secret,
                         pr_resolver=self.fake, pr_interval=0.02)
            self.assertTrue(self.fake.called.acquire(timeout=5))
            self.assertTrue(self.fake.called.acquire(timeout=5))
        self.assertIn("tokentown: KeyError\n", stderr.getvalue())
        self.assertNotIn("must not leak", stderr.getvalue())

    def test_board_health_gains_github(self):
        self.fake.health_value = {"enabled": True, "known": 12, "failed": 1, "lastError": "exit 1",
                                  "lastCheckedAt": 1790000000000}
        httpd, app = start_server(self, provider=lambda: (raw_with_prs(), self.board), secret=self.secret,
                                  pr_resolver=self.fake)
        board = self.get_board(httpd)
        self.assertEqual(board["health"]["github"], self.fake.health_value)
        self.assertEqual({k: v for k, v in board["health"].items() if k != "github"}, self.board["health"])
        self.assertEqual({k: v for k, v in board.items() if k != "health"},
                         {k: v for k, v in self.board.items() if k != "health"})
        self.assertNotIn("github", self.board["health"])

        etag = app.snapshot()[3]
        self.fake.health_value = dict(self.fake.health_value, known=13)
        self.assertTrue(app.scan_once())
        self.assertEqual(self.get_board(httpd)["health"]["github"]["known"], 13)
        self.assertNotEqual(app.snapshot()[3], etag)

    def test_github_health_survives_a_scan_failure_and_alerts(self):
        errors: list[Exception] = []

        def provide():
            if errors:
                raise errors.pop()
            return raw_with_prs(), self.board

        httpd, app = start_server(self, provider=provide, secret=self.secret, pr_resolver=self.fake)
        errors.append(RuntimeError("boom"))
        with mock.patch("sys.stderr", new_callable=io.StringIO):
            self.assertFalse(app.scan_once())
        app.note_replay()
        board = self.get_board(httpd)
        self.assertFalse(board["health"]["ok"])
        self.assertEqual(board["health"]["github"], self.fake.health())
        self.assertIn(server.REPLAY_WARNING, board["health"]["warnings"])

    def test_stop_cancels_the_resolver_so_no_gh_outlives_the_server(self):
        _, app = start_server(self, provider=lambda: (raw_with_prs(), self.board), secret=self.secret,
                              pr_resolver=self.fake)
        self.assertTrue(self.fake.called.acquire(timeout=5))
        self.assertFalse(self.fake.cancelled)
        app.stop()
        self.assertTrue(self.fake.cancelled)

    def test_stop_kills_a_gh_call_in_flight_without_waiting_for_it(self):
        from town.github import PrStateResolver

        started, killed = threading.Event(), threading.Event()

        class Child:
            returncode = None

            def __init__(self, argv, **kwargs):
                started.set()

            def communicate(self, timeout=None):
                killed.wait(30)
                self.returncode = -9
                return b"", None

            def kill(self):
                killed.set()

        resolver = PrStateResolver(clock_ms=lambda: 1_790_000_000_000, gh_path="/opt/homebrew/bin/gh",
                                   home="/Users/someone", popen=Child)
        _, app = start_server(self, provider=lambda: (raw_with_prs(), self.board), secret=self.secret,
                              pr_resolver=resolver)
        self.assertTrue(started.wait(5))
        begun = time.monotonic()
        app.stop()
        self.assertTrue(killed.is_set())
        self.assertLess(time.monotonic() - begun, 2)
        app._pr_thread.join(2)
        self.assertFalse(app._pr_thread.is_alive())

    def test_injected_provider_without_resolver_runs_no_github(self):
        with mock.patch("town.server.PrStateResolver", side_effect=AssertionError("must not build a resolver")):
            httpd, app = start_server(self, provider=lambda: (raw_with_prs(), self.board), secret=self.secret)
        self.assertIsNone(app.pr_resolver)
        self.assertIsNone(app._pr_thread)
        self.assertEqual(app.refresh_prs_once(), 0)
        self.assertNotIn("github", self.get_board(httpd)["health"])

    def test_default_provider_gets_a_real_resolver(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch("town.server.PrStateResolver") as resolver_cls, \
                mock.patch("town.server.default_board_provider",
                           return_value=lambda: (raw_with_prs(), make_board())) as provider_factory:
            refreshed = threading.Event()
            resolver = resolver_cls.return_value
            resolver.health.return_value = {"enabled": False, "known": 0, "failed": 0, "lastError": "gh not found",
                                            "lastCheckedAt": None}
            resolver.refresh.side_effect = lambda urls: refreshed.set() or 0
            paths = Paths(home=Path(tmp))
            httpd, app = start_server(self, provider=None, paths=paths, secret=self.secret)
            resolver_cls.assert_called_once_with()
            self.assertIsInstance(app.done_store, DoneStore)
            self.assertEqual(app.done_store.path, paths.secret_dir / "done.json")
            provider_factory.assert_called_once_with(paths, resolver.snapshot, done=app.done_store.marks,
                                                     link_store=mock.ANY, reviews=mock.ANY)
            store = provider_factory.call_args.kwargs["link_store"]
            self.assertIsInstance(store, LinkStore)
            self.assertEqual(store.path, paths.secret_dir / "links.json")
            self.assertFalse(store._read_only)
            # mock.ANY above, pinned here the way link_store is: the board must read the very source the server
            # refreshes and opens from, or a visitor could be drawn from one list and opened out of another.
            self.assertIsInstance(app.review_source, reviews.ReviewSource)
            self.assertEqual(provider_factory.call_args.kwargs["reviews"], app.review_source.snapshot)
            self.assertIsInstance(app.review_opener, reviews.ReviewOpener)
            self.assertIs(app.pr_resolver, resolver)
            self.assertEqual(self.get_board(httpd)["health"]["github"]["lastError"], "gh not found")
            self.assertTrue(refreshed.wait(5))
            app.stop()
        resolver.refresh.assert_called_once_with([U1, U4, U3])

    def test_default_board_provider_passes_states_into_build_board(self):
        raw = raw_with_prs()
        states = {U1: GitHubPr(state="MERGED", merged_at=5, closed_at=5, checked_at=9)}
        paths = Paths(home=Path("/nonexistent-tokentown-home"))
        with mock.patch("town.sources.Scanner") as scanner_cls, \
                mock.patch("town.board.build_board", return_value={"v": 1}) as build:
            scanner_cls.return_value.scan.return_value = raw
            got_raw, board = server.default_board_provider(paths, lambda: states)()
            self.assertIs(got_raw, raw)
            self.assertEqual(board, {"v": 1})
            args = build.call_args.args
            self.assertIs(args[0], raw)
            self.assertIsInstance(args[1], int)
            self.assertEqual(args[2], states)
            build.reset_mock()
            server.default_board_provider(paths)()
            self.assertEqual((len(build.call_args.args), build.call_args.kwargs), (2, {}))
            build.reset_mock()
            marks = {LOCAL: 7}
            server.default_board_provider(paths, lambda: states, done=lambda: marks)()
            self.assertEqual(build.call_args.args[2], states)
            self.assertEqual(build.call_args.kwargs, {"done": marks})
            scanner_cls.assert_called_with(paths)
            store = object()
            server.default_board_provider(paths, link_store=store)()
        scanner_cls.assert_called_with(paths, link_store=store)

    def test_stop_ends_the_pr_thread_even_before_a_first_scan(self):
        release = threading.Event()
        self.addCleanup(release.set)

        def blocked():
            release.wait(5)
            return raw_with_prs(), self.board

        app = server.App(port=0, secret=self.secret, board_provider=blocked,
                         opener=actions.Opener(run=mock.Mock(), clock=FakeClock()), pr_resolver=self.fake)
        app.start()
        app.stop(timeout=0.2)
        app._pr_thread.join(2)
        self.assertFalse(app._pr_thread.is_alive())
        release.set()
        app._thread.join(5)
        self.assertEqual(self.fake.calls, [])


class OpenReviewRouteTests(ServerTestCase):
    """POST /api/open-review: an id and nothing else, then the server's own stored URL."""

    def make_review_source(self):
        return FakeReviewSource({VISITOR_ID: VISITOR_URL, STALE_ID: STALE_URL,
                                 BAD_STORED_ID: "javascript:alert(1)"})

    def setUp(self):
        super().setUp()
        self.set_visitors(visitor(), visitor(BAD_STORED_ID, number=7, repo="tokentown"))

    def set_visitors(self, *visitors):
        self.board = make_board(visitors=visitors)
        self.assertTrue(self.app.scan_once())

    def test_opens_exactly_the_stored_url(self):
        status, _, body = self.post("/api/open-review", {"id": VISITOR_ID})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"ok": True})
        self.review_run.assert_called_once_with(["/usr/bin/open", VISITOR_URL], **OPEN_KWARGS)
        self.run.assert_not_called()

    def test_the_fake_visitor_carries_exactly_the_boards_keys(self):
        self.assertEqual(set(visitor()), set(bd.VISITOR_KEYS))

    def test_a_team_visitor_opens_by_id_alone_like_any_other(self):
        # Neither via nor a team slug is ever sent back: the body is still {"id"} and nothing else.
        self.set_visitors(visitor(via="team", teams=["web-platform"]))
        for payload in ({"id": VISITOR_ID, "via": "team"}, {"id": VISITOR_ID, "team": "web-platform"},
                        {"id": "web-platform"}):
            with self.subTest(payload=payload):
                self.assertIn(self.post("/api/open-review", payload)[0], (400, 404))
        self.review_run.assert_not_called()
        self.assertEqual(self.post("/api/open-review", {"id": VISITOR_ID})[0], 200)
        self.review_run.assert_called_once_with(["/usr/bin/open", VISITOR_URL], **OPEN_KWARGS)

    def test_a_hostile_team_slug_on_the_board_round_trips_as_inert_json(self):
        # build_board never publishes one (test_status), so this is the server alone: data, never markup.
        self.set_visitors(visitor(via="team", teams=[HOSTILE]))
        body = self.get("/api/board", token=True)[2]
        self.assertNotIn(b"<script", body)
        self.assertEqual(json.loads(body)["visitors"][0]["teams"], [HOSTILE])

    def test_the_client_never_sends_a_url(self):
        for payload in ({"id": VISITOR_URL}, {"id": "pr:" + VISITOR_URL}, {"url": VISITOR_URL},
                        {"id": VISITOR_ID, "url": VISITOR_URL}):
            status = self.post("/api/open-review", payload)[0]
            self.assertIn(status, (400, 404), payload)
        self.review_run.assert_not_called()

    def test_unknown_id(self):
        self.assertEqual(self.post("/api/open-review", {"id": "pr:" + "0" * 16})[0], 404)
        self.review_run.assert_not_called()

    def test_stale_id_after_the_list_changed(self):
        self.set_visitors(visitor(STALE_ID, number=999))
        self.assertEqual(self.post("/api/open-review", {"id": STALE_ID})[0], 200)
        self.review_clock.t += 1
        self.set_visitors(visitor())
        self.assertEqual(self.post("/api/open-review", {"id": STALE_ID})[0], 404)
        self.assertEqual(self.review_run.call_count, 1)

    def test_a_visitor_the_source_has_forgotten(self):
        self.set_visitors(visitor(reviews.review_id("https://github.com/o/r/pull/3")))
        self.assertEqual(self.post("/api/open-review", {"id": reviews.review_id(
            "https://github.com/o/r/pull/3")})[0], 404)
        self.review_run.assert_not_called()

    def test_a_stored_url_that_fails_the_regex_is_refused(self):
        self.assertEqual(self.post("/api/open-review", {"id": BAD_STORED_ID})[0], 404)
        self.review_run.assert_not_called()

    def test_hostile_ids(self):
        bad = ["../" + VISITOR_ID, VISITOR_ID + "/../x", VISITOR_ID + "\n", VISITOR_ID + " ", " " + VISITOR_ID,
               VISITOR_ID.upper(), VISITOR_ID[:-1], VISITOR_ID + "0", "pr:", "pr:../../etc/passwd", LOCAL,
               "cli:" + QUOTE_UUID, "pr:" + "g" * 16, "pr:" + "0" * 15 + "\u0660", VISITOR_ID + "?x=1", ""]
        for value in bad:
            self.assertEqual(self.post("/api/open-review", {"id": value})[0], 404, value)
        self.review_run.assert_not_called()

    def test_wrong_body_shapes(self):
        bodies = [b"{}", b'{"id": 7}', b'{"id": null}', b'{"id": true}', b'{"id": ["x"]}',
                  b'{"id": "' + VISITOR_ID.encode() + b'", "extra": 1}',
                  b'{"id": "' + VISITOR_ID.encode() + b'", "id": "' + VISITOR_ID.encode() + b'"}',
                  b"[]", b"null", b"not json", b"", json.dumps({"id": VISITOR_ID + " " * 1100}).encode()]
        for body in bodies:
            self.assertEqual(self.post("/api/open-review", body=body)[0], 400, body[:40])
        self.assertEqual(self.post("/api/open-review", body=b"x" * 60_000)[0], 400)
        self.review_run.assert_not_called()

    def test_guards(self):
        payload = {"id": VISITOR_ID}
        self.assertEqual(self.post("/api/open-review", payload, headers={"Host": f"localhost:{self.port}"})[0], 403)
        self.assertEqual(self.post("/api/open-review", payload,
                                   headers={"Host": f"127.0.0.1:{self.port + 1}"})[0], 403)
        for origin in (False, "null", "http://127.0.0.1:3000", f"http://localhost:{self.port}",
                       f"https://127.0.0.1:{self.port}"):
            self.assertEqual(self.post("/api/open-review", payload, origin=origin)[0], 403, origin)
        self.assertEqual(self.post("/api/open-review", payload, token=False)[0], 401)
        self.assertEqual(self.post("/api/open-review", payload, token="f" * 64)[0], 401)
        for ctype in ("text/plain", None, "application/jsonx"):
            self.assertEqual(self.post("/api/open-review", payload, ctype=ctype)[0], 400, ctype)
        self.assertEqual(self.request("OPTIONS", "/api/open-review", {
            "Host": f"127.0.0.1:{self.port}", "Origin": self.origin})[0], 403)
        for method in ("GET", "PUT", "DELETE", "HEAD"):
            self.assertEqual(self.request(method, "/api/open-review", {
                "Host": f"127.0.0.1:{self.port}", "X-Town-Token": self.token})[0], 404, method)
        self.review_run.assert_not_called()

    def test_rate_limited(self):
        self.assertEqual(self.post("/api/open-review", {"id": VISITOR_ID})[0], 200)
        self.review_clock.t += 0.2
        self.assertEqual(self.post("/api/open-review", {"id": VISITOR_ID})[0], 429)
        self.review_clock.t += 0.6
        self.assertEqual(self.post("/api/open-review", {"id": VISITOR_ID})[0], 200)
        self.assertEqual(self.review_run.call_count, 2)

    def test_the_two_open_actions_have_their_own_rate_limits(self):
        self.assertEqual(self.post("/api/open-review", {"id": VISITOR_ID})[0], 200)
        self.assertEqual(self.post("/api/open", {"id": LOCAL})[0], 200)
        self.run.assert_called_once_with(["/usr/bin/open", f"claude://claude.ai/epitaxy/{LOCAL}"], **OPEN_KWARGS)

    def test_open_failure_is_500(self):
        self.review_run.return_value = subprocess.CompletedProcess([], 1)
        status, headers, body = self.post("/api/open-review", {"id": VISITOR_ID})
        self.assertEqual(status, 500)
        self.assertEqual(body, b"")
        self.assert_security_headers(headers)

    def test_a_hostile_visitor_title_round_trips_as_inert_json(self):
        body = self.get("/api/board", token=True)[2]
        self.assertNotIn(b"<script", body)
        self.assertEqual(json.loads(body)["visitors"][0]["title"], HOSTILE)


class NoReviewSourceTests(ServerTestCase):
    def test_open_review_without_a_source_is_404(self):
        self.board = make_board(visitors=(visitor(),))
        self.assertTrue(self.app.scan_once())
        self.assertIsNone(self.app.review_source)
        self.assertEqual(self.post("/api/open-review", {"id": VISITOR_ID})[0], 404)
        self.assertEqual(self.app.refresh_reviews_once(), 0)
        self.review_run.assert_not_called()
        self.assertNotIn("reviews", json.loads(self.get("/api/board", token=True)[2])["health"])


class ReviewWiringTests(unittest.TestCase):
    """The review thread reads the latest board, and its health reaches the page."""

    def setUp(self):
        no_real_subprocesses(self)
        self.secret = bytes(range(32))
        self.board = make_board(visitors=(visitor(),))
        self.fake = FakeReviewSource()

    def get_board(self, httpd) -> dict:
        conn = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=5)
        try:
            conn.request("GET", "/api/board", headers={"X-Town-Token": security.session_token(self.secret)})
            resp = conn.getresponse()
            self.assertEqual(resp.status, 200)
            return json.loads(resp.read())
        finally:
            conn.close()

    def board_with(self, *prs) -> dict:
        board = make_board()
        board["sessions"] = [{"id": f"local_{i}", "pr": pr} for i, pr in enumerate(prs)]
        return board

    def pr(self, url, state="OPEN", verified=True) -> dict:
        return {"number": 1, "state": state, "url": url, "verified": verified, "mergedAt": None}

    def test_review_urls_verified_open_only_and_distinct(self):
        board = self.board_with(
            self.pr(VISITOR_URL), self.pr(VISITOR_URL), self.pr(STALE_URL, state="MERGED"),
            self.pr(STALE_URL, verified=False), self.pr(None), self.pr("javascript:alert(1)"),
            self.pr("https://github.com/o/r/pull/1/files"), self.pr("https://github.com/o/../pull/2"),
            None, "not a row", {"pr": {"state": "OPEN", "url": VISITOR_URL, "verified": True}},
        )
        self.assertEqual(server.review_urls(board), [VISITOR_URL])
        self.assertEqual(server.review_urls(None), [])
        self.assertEqual(server.review_urls({}), [])
        self.assertEqual(server.review_urls(make_board()), [])

    def test_review_urls_capped_in_board_order(self):
        urls = [f"https://github.com/o/r/pull/{n}" for n in range(1, 10)]
        board = self.board_with(*[self.pr(u) for u in urls])
        self.assertEqual(server.review_urls(board, limit=3), urls[:3])
        self.assertEqual(len(server.review_urls(board)), 9)
        self.assertEqual(server.MAX_REVIEW_URLS, 60)

    def test_first_cycle_after_the_first_scan_then_on_its_own_interval(self):
        board = self.board_with(self.pr(VISITOR_URL))
        start_server(self, provider=lambda: (make_raw(), board), secret=self.secret,
                     review_source=self.fake, review_interval=0.02)
        for _ in range(3):
            self.assertTrue(self.fake.called.acquire(timeout=5))
        self.assertEqual(self.fake.calls[0], [VISITOR_URL])

    def test_a_cycle_runs_even_when_the_first_scan_failed(self):
        """The search needs no board: a scan failure must not hold the visitors back."""
        with mock.patch("sys.stderr", new_callable=io.StringIO):
            start_server(self, provider=mock.Mock(side_effect=RuntimeError("boom")), secret=self.secret,
                         review_source=self.fake, review_interval=0.02)
            self.assertTrue(self.fake.called.acquire(timeout=5))
        self.assertEqual(self.fake.calls[0], [])

    def test_cycle_reads_the_latest_board(self):
        boards = [make_board()]
        _, app = start_server(self, provider=lambda: (make_raw(), boards[0]), secret=self.secret,
                              review_source=self.fake)
        self.assertTrue(self.fake.called.acquire(timeout=5))
        self.assertEqual(self.fake.calls[-1], [])
        boards[0] = self.board_with(self.pr(VISITOR_URL))
        self.assertTrue(app.scan_once())
        self.assertEqual(app.refresh_reviews_once(), 0)
        self.assertEqual(self.fake.calls[-1], [VISITOR_URL])

    def test_refresh_error_logs_class_only_and_the_loop_continues(self):
        self.fake.errors.append(KeyError("secret title that must not leak"))
        with mock.patch("sys.stderr", new_callable=io.StringIO) as stderr:
            start_server(self, provider=lambda: (make_raw(), self.board), secret=self.secret,
                         review_source=self.fake, review_interval=0.02)
            self.assertTrue(self.fake.called.acquire(timeout=5))
            self.assertTrue(self.fake.called.acquire(timeout=5))
        self.assertIn("tokentown: KeyError\n", stderr.getvalue())
        self.assertNotIn("must not leak", stderr.getvalue())

    def test_board_health_gains_reviews(self):
        self.fake.health_value = {"enabled": True, "known": 9, "failed": 1, "lastError": "exit 1",
                                  "lastCheckedAt": 1790000000000}
        httpd, app = start_server(self, provider=lambda: (make_raw(), self.board), secret=self.secret,
                                  review_source=self.fake)
        board = self.get_board(httpd)
        self.assertEqual(board["health"]["reviews"], self.fake.health_value)
        self.assertEqual({k: v for k, v in board["health"].items() if k != "reviews"}, self.board["health"])
        self.assertNotIn("reviews", self.board["health"])
        self.assertEqual(board["visitors"], self.board["visitors"])

    def test_etag_ignores_the_review_last_checked_at_only(self):
        board = make_board()
        board["health"]["reviews"] = {"enabled": True, "known": 3, "failed": 0, "lastError": None,
                                      "lastCheckedAt": 1790000000000}
        later = json.loads(json.dumps(board))
        later["health"]["reviews"]["lastCheckedAt"] = 1790000060000
        self.assertEqual(server.board_etag(board), server.board_etag(later))
        later["health"]["reviews"]["known"] = 4
        self.assertNotEqual(server.board_etag(board), server.board_etag(later))

        httpd, app = start_server(self, provider=lambda: (make_raw(), self.board), secret=self.secret,
                                  review_source=self.fake)
        etag = app.snapshot()[3]
        self.fake.health_value = dict(self.fake.health_value, lastCheckedAt=99_999)
        self.assertTrue(app.scan_once())
        self.assertEqual(app.snapshot()[3], etag)
        self.assertEqual(self.get_board(httpd)["health"]["reviews"]["lastCheckedAt"], 99_999)

    def test_both_source_healths_are_reported_together(self):
        resolver = FakeResolver()
        httpd, _ = start_server(self, provider=lambda: (make_raw(), self.board), secret=self.secret,
                                pr_resolver=resolver, review_source=self.fake)
        health = self.get_board(httpd)["health"]
        self.assertEqual(health["github"], resolver.health())
        self.assertEqual(health["reviews"], self.fake.health())

    def test_stop_cancels_the_source_so_no_gh_outlives_the_server(self):
        _, app = start_server(self, provider=lambda: (make_raw(), self.board), secret=self.secret,
                              review_source=self.fake)
        self.assertTrue(self.fake.called.acquire(timeout=5))
        self.assertFalse(self.fake.cancelled)
        app.stop()
        self.assertTrue(self.fake.cancelled)
        self.assertFalse(app._review_thread.is_alive())

    def test_stop_ends_the_review_thread_even_before_a_first_scan(self):
        release = threading.Event()
        self.addCleanup(release.set)

        def blocked():
            release.wait(5)
            return make_raw(), self.board

        app = server.App(port=0, secret=self.secret, board_provider=blocked,
                         opener=actions.Opener(run=mock.Mock(), clock=FakeClock()), review_source=self.fake)
        app.start()
        app.stop(timeout=0.2)
        app._review_thread.join(2)
        self.assertFalse(app._review_thread.is_alive())
        release.set()
        app._thread.join(5)
        self.assertEqual(self.fake.calls, [])

    def test_injected_provider_without_a_source_runs_no_reviews(self):
        with mock.patch("town.server.ReviewSource", side_effect=AssertionError("must not build a source")):
            httpd, app = start_server(self, provider=lambda: (make_raw(), self.board), secret=self.secret)
        self.assertIsNone(app.review_source)
        self.assertIsNone(app.review_opener)
        self.assertIsNone(app._review_thread)
        self.assertEqual(app.refresh_reviews_once(), 0)
        self.assertEqual(app.open_review(VISITOR_ID), 404)
        self.assertNotIn("reviews", self.get_board(httpd)["health"])

    def test_default_provider_gets_a_real_source_and_opener(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch("town.server.PrStateResolver") as resolver_cls, \
                mock.patch("town.server.ReviewSource") as source_cls, \
                mock.patch("town.server.default_board_provider",
                           return_value=lambda: (make_raw(), make_board())) as provider_factory:
            refreshed = threading.Event()
            source = source_cls.return_value
            source.health.return_value = {"enabled": False, "known": 0, "failed": 0, "lastError": "gh not found",
                                           "lastCheckedAt": None}
            source.refresh.side_effect = lambda urls: refreshed.set() or 0
            resolver_cls.return_value.health.return_value = {"enabled": False, "known": 0, "failed": 0,
                                                             "lastError": "gh not found", "lastCheckedAt": None}
            httpd, app = start_server(self, provider=None, paths=Paths(home=Path(tmp)), secret=self.secret,
                                      review_interval=0.02)
            source_cls.assert_called_once_with()
            self.assertIs(app.review_source, source)
            self.assertIsInstance(app.review_opener, reviews.ReviewOpener)
            self.assertIs(provider_factory.call_args.kwargs["reviews"], source.snapshot)
            self.assertEqual(self.get_board(httpd)["health"]["reviews"]["lastError"], "gh not found")
            self.assertTrue(refreshed.wait(5))
            app.stop()
        source.refresh.assert_called_with([])

    def test_default_board_provider_passes_the_snapshot_into_build_board(self):
        raw = make_raw()
        snap = ReviewSnapshot(requests=(ReviewRequest(id=VISITOR_ID, number=532, owner="o", repo="r",
                                                      url=VISITOR_URL, title="t", author="sam",
                                                      waiting_since=5),))
        paths = Paths(home=Path("/nonexistent-tokentown-home"))
        with mock.patch("town.sources.Scanner") as scanner_cls, \
                mock.patch("town.board.build_board", return_value={"v": 1}) as build:
            scanner_cls.return_value.scan.return_value = raw
            server.default_board_provider(paths, reviews=lambda: snap)()
            self.assertEqual(build.call_args.kwargs, {"reviews": snap})
            build.reset_mock()
            server.default_board_provider(paths, lambda: {}, done=lambda: {}, reviews=lambda: snap)()
            self.assertEqual(build.call_args.kwargs, {"done": {}, "reviews": snap})
            build.reset_mock()
            server.default_board_provider(paths)()
            self.assertEqual((len(build.call_args.args), build.call_args.kwargs), (2, {}))


class UpdateWiringTests(unittest.TestCase):
    """The update thread follows the first scan, its health reaches the page, and gh signed out asks for a look."""

    def setUp(self):
        no_real_subprocesses(self)
        self.secret = bytes(range(32))
        self.board = make_board()
        self.fake = FakeUpdateChecker()

    def get_board(self, httpd) -> dict:
        conn = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=5)
        try:
            conn.request("GET", "/api/board", headers={"X-Town-Token": security.session_token(self.secret)})
            resp = conn.getresponse()
            self.assertEqual(resp.status, 200)
            return json.loads(resp.read())
        finally:
            conn.close()

    def test_first_check_after_the_first_scan_then_on_its_own_interval(self):
        start_server(self, provider=lambda: (make_raw(), self.board), secret=self.secret,
                     update_checker=self.fake, update_interval=0.02)
        for _ in range(3):
            self.assertTrue(self.fake.called.acquire(timeout=5))
        self.assertEqual(server.UPDATE_REFRESH_INTERVAL_S, 60.0)

    def test_refresh_error_logs_class_only_and_the_loop_continues(self):
        self.fake.errors.append(OSError("/Users/t/clients/acme-secret/.git/HEAD"))
        with mock.patch("sys.stderr", new_callable=io.StringIO) as stderr:
            start_server(self, provider=lambda: (make_raw(), self.board), secret=self.secret,
                         update_checker=self.fake, update_interval=0.02)
            self.assertTrue(self.fake.called.acquire(timeout=5))
            self.assertTrue(self.fake.called.acquire(timeout=5))
        self.assertIn("tokentown: OSError\n", stderr.getvalue())
        self.assertNotIn("acme", stderr.getvalue())

    def test_board_health_gains_updates(self):
        self.fake.health_value = dict(BEHIND)
        httpd, _ = start_server(self, provider=lambda: (make_raw(), self.board), secret=self.secret,
                                update_checker=self.fake)
        board = self.get_board(httpd)
        self.assertEqual(board["health"]["updates"], BEHIND)
        self.assertEqual({k: v for k, v in board["health"].items() if k != "updates"}, self.board["health"])
        self.assertNotIn("updates", self.board["health"])

    def test_gh_signed_out_anywhere_asks_for_a_look_once(self):
        resolver, source = FakeResolver(), FakeReviewSource()
        httpd, app = start_server(self, provider=lambda: (make_raw(), self.board), secret=self.secret,
                                  pr_resolver=resolver, review_source=source, update_checker=self.fake)
        health = self.get_board(httpd)["health"]
        self.assertEqual((health["ok"], health.get("problems", [])), (True, []))
        for fake, error in ((resolver, "gh not signed in"), (source, "HTTP 401"), (self.fake, "gh not signed in")):
            with self.subTest(source=type(fake).__name__, error=error):
                fake.health_value = dict(fake.health_value, lastError=error)
                self.assertTrue(app.scan_once())
                health = self.get_board(httpd)["health"]
                self.assertEqual((health["ok"], health["problems"]), (False, [bd.GH_SIGN_IN_PROBLEM]))
                fake.health_value = dict(fake.health_value, lastError=None)
        for error in ("HTTP 403", "HTTP 404", "exit 1", "gh not found", "TimeoutExpired"):
            with self.subTest(error=error):
                resolver.health_value = dict(resolver.health_value, lastError=error)
                self.assertTrue(app.scan_once())
                health = self.get_board(httpd)["health"]
                self.assertEqual((health["ok"], health.get("problems", [])), (True, []))
        self.assertEqual(bd.GH_SIGN_IN_PROBLEM, "gh not signed in")

    def test_a_sign_in_problem_joins_the_scans_own(self):
        board = make_board()
        board["health"] = dict(board["health"], ok=False, problems=["no sessions found"])
        self.fake.health_value = dict(self.fake.health_value, lastError="gh not signed in")
        httpd, _ = start_server(self, provider=lambda: (make_raw(), board), secret=self.secret,
                                update_checker=self.fake)
        health = self.get_board(httpd)["health"]
        self.assertEqual((health["ok"], health["problems"]), (False, ["no sessions found", "gh not signed in"]))
        self.assertEqual(board["health"]["problems"], ["no sessions found"])

    def test_etag_ignores_the_update_last_checked_at_only(self):
        board = make_board()
        board["health"]["updates"] = dict(BEHIND)
        later = json.loads(json.dumps(board))
        later["health"]["updates"]["lastCheckedAt"] = 99_999
        self.assertEqual(server.board_etag(board), server.board_etag(later))
        later["health"]["updates"]["behindBy"] = 4
        self.assertNotEqual(server.board_etag(board), server.board_etag(later))

    def test_stop_cancels_the_checker_so_no_gh_outlives_the_server(self):
        _, app = start_server(self, provider=lambda: (make_raw(), self.board), secret=self.secret,
                              update_checker=self.fake)
        self.assertTrue(self.fake.called.acquire(timeout=5))
        self.assertFalse(self.fake.cancelled)
        app.stop()
        self.assertTrue(self.fake.cancelled)
        self.assertFalse(app._update_thread.is_alive())

    def test_stop_ends_the_update_thread_even_before_a_first_scan(self):
        release = threading.Event()
        self.addCleanup(release.set)

        def blocked():
            release.wait(5)
            return make_raw(), self.board

        app = server.App(port=0, secret=self.secret, board_provider=blocked,
                         opener=actions.Opener(run=mock.Mock(), clock=FakeClock()), update_checker=self.fake)
        app.start()
        app.stop(timeout=0.2)
        app._update_thread.join(2)
        self.assertFalse(app._update_thread.is_alive())
        release.set()
        app._thread.join(5)
        self.assertEqual(self.fake.refreshes, 0)

    def test_injected_provider_without_a_checker_checks_nothing(self):
        with mock.patch("town.server.UpdateChecker", side_effect=AssertionError("must not build a checker")):
            httpd, app = start_server(self, provider=lambda: (make_raw(), self.board), secret=self.secret)
        self.assertIsNone(app.update_checker)
        self.assertIsNone(app._update_thread)
        self.assertIsNone(app.update_command())
        self.assertNotIn("updates", self.get_board(httpd)["health"])

    def test_default_provider_gets_a_real_checker(self):
        off = {"enabled": False, "known": 0, "failed": 0, "lastError": "gh not found", "lastCheckedAt": None}
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch("town.server.PrStateResolver") as resolver_cls, \
                mock.patch("town.server.ReviewSource") as source_cls, \
                mock.patch("town.server.UpdateChecker") as checker_cls, \
                mock.patch("town.server.default_board_provider", return_value=lambda: (make_raw(), make_board())):
            resolver_cls.return_value.health.return_value = off
            source_cls.return_value.health.return_value = off
            refreshed = threading.Event()
            checker = checker_cls.return_value
            checker.health.return_value = dict(BEHIND, enabled=False, reason="gh not found", state=None,
                                               lastError="gh not found")
            checker.refresh.side_effect = lambda: refreshed.set() or 0
            httpd, app = start_server(self, provider=None, paths=Paths(home=Path(tmp)), secret=self.secret,
                                      update_interval=0.02)
            checker_cls.assert_called_once_with()
            self.assertIs(app.update_checker, checker)
            self.assertEqual(self.get_board(httpd)["health"]["updates"]["reason"], "gh not found")
            self.assertTrue(refreshed.wait(5))
            app.stop()
        checker.cancel.assert_called_once_with()


class DoneWiringTests(unittest.TestCase):
    """The scan thread feeds done marks into build_board and keeps the store tidy."""

    def setUp(self):
        no_real_subprocesses(self)
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        self.paths = Paths(home=Path(home.name))
        self.store = DoneStore(self.paths)
        self.secret = bytes(range(32))
        self.now = now_ms()
        self.records = [desktop_record(1, self.now - 3_600_000, ()), desktop_record(2, self.now - 3_600_000, ())]
        self.tails: dict[str, Tail] = {}

    def raw(self):
        return RawSnapshot(scanned_at=self.now, desktop=tuple(self.records), registry_files=0, registry_live=(),
                           cli_only=(), tails=dict(self.tails), app_version=None, cli_versions=(),
                           desktop_parse_errors=0, scan_ms=3)

    def provide(self):
        raw = self.raw()
        return raw, bd.build_board(raw, now_ms(), done=self.store.marks())

    def post_done(self, httpd, row_id, value):
        port = httpd.server_address[1]
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            conn.request("POST", "/api/done", body=json.dumps({"id": row_id, "done": value}), headers={
                "Origin": f"http://127.0.0.1:{port}", "Content-Type": "application/json",
                "X-Town-Token": security.session_token(self.secret)})
            return conn.getresponse().status
        finally:
            conn.close()

    def rows(self, app):
        return {r["id"]: r for r in app.snapshot()[1]["sessions"]}

    def test_done_then_activity_brings_the_session_back_and_forgets_the_mark(self):
        clock = FakeClock()
        httpd, app = start_server(self, provider=self.provide, secret=self.secret, done_store=self.store,
                                  done_clock=clock)
        rid = self.records[0].session_id
        self.assertEqual((self.rows(app)[rid]["lane"], self.rows(app)[rid]["canMarkDone"]), ("recent", True))
        self.assertEqual(self.post_done(httpd, rid, True), 200)
        row = self.rows(app)[rid]
        self.assertEqual((row["lane"], row["valhallaReason"], row["label"]), ("valhalla", "done", "Done"))
        self.assertEqual(json.loads(self.store.path.read_text())["done"], {rid: row["doneAt"]})

        self.records[0] = desktop_record(1, now_ms() + 121_000, ())
        self.assertTrue(app.scan_once())
        self.assertEqual(self.rows(app)[rid]["lane"], "recent")
        self.assertEqual(self.store.marks(), {})

    def test_a_reply_inside_the_grace_is_activity_and_the_scan_forgets_the_mark(self):
        from dataclasses import replace

        cli = "11111111-2222-4333-8444-555555555555"
        rid = self.records[0].session_id
        done_at = self.now - 600_000
        self.records[0] = replace(self.records[0], cli_session_id=cli, last_activity_at=done_at - 3_600_000)

        def record(type_, ts, blocks, stop=None):
            return TailRecord(type=type_, subtype=None, timestamp=ts, is_sidechain=False, is_meta=False,
                              stop_reason=stop, block_types=blocks, tool_uses=(), tool_result_ids=(),
                              is_api_error=False, error_kind=None, retry_attempt=None, max_retries=None,
                              quota_status=None, quota_resets_at=None, quota_limit_type=None)

        self.tails[cli] = Tail(True, (record("assistant", done_at - 3_600_000, ("text",), "end_turn"),), None)
        self.store.mark(rid, done_at)
        _, app = start_server(self, provider=self.provide, secret=self.secret, done_store=self.store)
        self.assertEqual(self.rows(app)[rid]["valhallaReason"], "done")
        self.assertEqual(self.store.marks(), {rid: done_at})

        self.tails[cli] = Tail(True, (*self.tails[cli].records, record("user", done_at + 30_000, ("text",)),
                                      record("assistant", done_at + 90_000, ("text",), "end_turn")), None)
        self.assertTrue(app.scan_once())
        self.assertEqual(self.store.marks(), {})
        self.assertEqual((self.rows(app)[rid]["lane"], self.rows(app)[rid]["doneAt"]), ("recent", None))

    def test_go_to_valhalla_marks_at_the_end_of_the_reply_and_bring_back_holds(self):
        from dataclasses import replace

        cli = "11111111-2222-4333-8444-555555555555"
        rid = self.records[0].session_id
        asked_at = self.now - 600_000
        self.records[0] = replace(self.records[0], cli_session_id=cli, last_activity_at=asked_at - 3_600_000)

        def record(type_, ts, blocks, stop=None, **kw):
            return TailRecord(type=type_, subtype=None, timestamp=ts, is_sidechain=False, is_meta=False,
                              stop_reason=stop, block_types=blocks, tool_uses=(), tool_result_ids=(),
                              is_api_error=False, error_kind=None, retry_attempt=None, max_retries=None,
                              quota_status=None, quota_resets_at=None, quota_limit_type=None, **kw)

        reply_end = asked_at + 90_000
        self.tails[cli] = Tail(True, (record("user", asked_at, ("text",), valhalla_ask=True),
                                      record("assistant", reply_end, ("text",), "end_turn")), None)
        httpd, app = start_server(self, provider=self.provide, secret=self.secret, done_store=self.store)
        self.assertEqual(self.store.marks(), {rid: reply_end})
        self.assertTrue(app.scan_once())
        row = self.rows(app)[rid]
        self.assertEqual((row["lane"], row["valhallaReason"], row["doneAt"]), ("valhalla", "done", reply_end))

        self.assertEqual(self.post_done(httpd, rid, False), 200)
        self.assertTrue(app.scan_once())
        self.assertEqual((self.rows(app)[rid]["lane"], self.store.marks()), ("recent", {}))

    def test_go_to_valhalla_waits_while_the_row_cannot_be_marked(self):
        rid = self.records[0].session_id
        store = mock.Mock()
        raw = self.raw()
        with mock.patch.object(server, "valhalla_asks",
                               return_value={rid: (self.now - 60_000, self.now)}):
            server.App._apply_valhalla_asks(store, raw, {"sessions": [{"id": rid, "canMarkDone": False}]}, self.now)
            store.apply_ask.assert_not_called()
            server.App._apply_valhalla_asks(store, raw, {"sessions": [{"id": rid, "canMarkDone": True}]}, self.now)
            store.apply_ask.assert_called_once_with(rid, self.now - 60_000, self.now)

    def test_prune_only_old_marks_of_sessions_that_are_gone(self):
        gone_old = "local_99999999-2222-4333-8444-555555555555"
        gone_new = "local_88888888-2222-4333-8444-555555555555"
        present = self.records[1].session_id
        self.records[1] = desktop_record(2, self.now - 300 * 86_400_000, ())
        self.store.mark(gone_old, self.now - 91 * 86_400_000)
        self.store.mark(gone_new, self.now - 89 * 86_400_000)
        self.store.mark(present, self.now - 200 * 86_400_000)
        start_server(self, provider=self.provide, secret=self.secret, done_store=self.store)
        self.assertEqual(set(self.store.marks()), {gone_new, present})

    def test_maintenance_errors_never_fail_the_scan(self):
        store = mock.Mock(wraps=self.store)
        store.forget_if_active.side_effect = OSError("/Users/someone/path")
        store.marks.side_effect = self.store.marks
        with mock.patch("sys.stderr", new_callable=io.StringIO) as stderr:
            _, app = start_server(self, provider=self.provide, secret=self.secret, done_store=store)
            self.assertTrue(app.scan_once())
        self.assertIn("tokentown: OSError\n", stderr.getvalue())
        self.assertNotIn("someone", stderr.getvalue())
        self.assertTrue(app.snapshot()[1]["health"]["ok"])

    def test_no_raw_snapshot_means_no_maintenance(self):
        store = mock.Mock()
        start_server(self, provider=lambda: (None, make_board()), secret=self.secret, done_store=store)
        store.forget_if_active.assert_not_called()
        store.prune.assert_not_called()


# ====================================================================== launcher

def load_launcher():
    loader = importlib.machinery.SourceFileLoader("tokentown_launcher", str(LAUNCHER))
    spec = importlib.util.spec_from_loader("tokentown_launcher", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class _OtherHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"not tokentown"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class LauncherTests(unittest.TestCase):
    def setUp(self):
        no_real_subprocesses(self)
        self.launcher = load_launcher()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.paths = Paths(home=Path(tmp.name))
        self.run = mock.Mock(return_value=subprocess.CompletedProcess([], 0))
        self.out, self.err = io.StringIO(), io.StringIO()

    def test_file_is_executable_and_runs_the_python3_on_your_path(self):
        self.assertEqual(stat.S_IMODE(os.stat(LAUNCHER).st_mode), 0o755)
        self.assertEqual(LAUNCHER.read_text().splitlines()[0], "#!/usr/bin/env python3")

    def test_the_launcher_still_parses_as_the_python_macos_ships(self):
        """It has to get as far as saying it needs a newer Python, or running itself under one."""
        ast.parse(LAUNCHER.read_text(), filename=str(LAUNCHER), feature_version=(3, 9))

    def make_pythons(self, *names: str, mode: int = 0o755) -> Path:
        folder = self.paths.home / "bin"
        folder.mkdir(exist_ok=True)
        for name in names:
            (folder / name).write_text("#!/bin/sh\nexit 99\n")
            (folder / name).chmod(mode)
        return folder

    def test_find_python_takes_the_oldest_that_is_new_enough(self):
        folder = self.make_pythons("python3.9", "python3.12", "python3.13t", "python3.13-config", "python3.14",
                                   "python3.13", "python3")
        self.make_pythons("python3.10", mode=0o644)
        patterns = (str(folder / "python3.*"),)
        self.assertEqual(self.launcher.find_python(patterns), str(folder / "python3.13"))
        (folder / "python3.13").unlink()
        self.assertEqual(self.launcher.find_python(patterns), str(folder / "python3.14"))
        (folder / "python3.14").unlink()
        self.assertIsNone(self.launcher.find_python(patterns))
        self.assertEqual(self.launcher.find_python(patterns, minimum=(3, 9)), str(folder / "python3.9"))

    def test_an_old_python_runs_the_launcher_again_under_a_new_one(self):
        environ, execv = {}, mock.Mock()
        with mock.patch.object(sys, "argv", ["tokentown", "url"]):
            code = self.launcher.run_under_newer_python((3, 9, 6), environ, lambda: "/opt/py/python3.13", execv,
                                                        self.err)
        execv.assert_called_once_with("/opt/py/python3.13", ["/opt/py/python3.13", str(LAUNCHER), "url"])
        self.assertEqual((code, environ, self.err.getvalue()), (1, {self.launcher.REEXEC_ENV: "1"}, ""))

    def test_no_new_enough_python_says_how_to_get_one(self):
        execv = mock.Mock()
        code = self.launcher.run_under_newer_python((3, 9, 6), {}, lambda: None, execv, self.err)
        self.assertEqual(code, 1)
        execv.assert_not_called()
        self.assertEqual(self.err.getvalue(), "tokentown: needs Python 3.13 or later, and this is 3.9.6. Install it "
                                              "from python.org or with Homebrew (brew install python), then run "
                                              "tokentown again.\n")

    def test_running_again_never_loops(self):
        find, execv = mock.Mock(return_value="/opt/py/python3.13"), mock.Mock()
        environ = {self.launcher.REEXEC_ENV: "1"}
        self.assertEqual(self.launcher.run_under_newer_python((3, 9, 6), environ, find, execv, self.err), 1)
        find.assert_not_called()
        execv.assert_not_called()
        self.assertIn("needs Python 3.13 or later", self.err.getvalue())

    def test_the_server_gets_where_claude_and_gh_keep_their_files_and_nothing_else(self):
        environ = {"HOME": "/Users/x", "PATH": "/opt/homebrew/bin:/usr/bin", "CLAUDE_CONFIG_DIR": "/Users/x/work",
                   "GH_CONFIG_DIR": "/Users/x/gh", "XDG_CONFIG_HOME": "/Users/x/.config", "GH_TOKEN": "t0ken",
                   "TOWN_HOME": "", "GITHUB_TOKEN": "other", "AWS_SECRET_ACCESS_KEY": "no", "SSH_AUTH_SOCK": "/s"}
        self.assertEqual(self.launcher.server_env(environ), {
            "PATH": "/usr/bin:/bin", "HOME": "/Users/x", "CLAUDE_CONFIG_DIR": "/Users/x/work",
            "GH_CONFIG_DIR": "/Users/x/gh", "XDG_CONFIG_HOME": "/Users/x/.config", "GH_TOKEN": "t0ken"})

    def test_the_server_runs_under_this_python(self):
        with mock.patch.object(self.launcher.subprocess, "Popen") as popen:
            self.launcher.spawn_server()
        argv, kwargs = popen.call_args
        self.assertEqual(argv[0], [sys.executable, str(LAUNCHER), "serve"])
        self.assertTrue(os.path.isabs(argv[0][0]))
        self.assertEqual(kwargs["env"], self.launcher.server_env())
        self.assertEqual(kwargs["cwd"], str(CODE_DIR))

    def _spawn_on(self, port):
        calls = []

        def spawn():
            calls.append(port)
            secret = security.load_or_create_secret(self.paths)
            start_server(self, provider=lambda: (make_raw(), make_board()), secret=secret, port=port)
            return None

        return spawn, calls

    def test_url_starts_server_creates_secret_and_prints_launch_url(self):
        port = free_port()
        spawn, calls = self._spawn_on(port)
        code = self.launcher.launch("url", paths=self.paths, port=port, run=self.run, spawn=spawn,
                                    out=self.out, err=self.err)
        self.assertEqual(code, 0, self.err.getvalue())
        self.assertEqual(calls, [port])
        self.run.assert_not_called()
        self.assertEqual(stat.S_IMODE(os.stat(self.paths.secret_dir).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(self.paths.secret_file).st_mode), 0o600)
        url = self.out.getvalue().strip()
        m = re.fullmatch(rf"http://127\.0\.0\.1:{port}/#c=([0-9a-f]{{32}}\.[0-9]{{13}}\.[0-9a-f]{{64}})", url)
        self.assertIsNotNone(m, url)
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("POST", "/api/claim", body=json.dumps({"code": m.group(1)}),
                     headers={"Origin": f"http://127.0.0.1:{port}", "Content-Type": "application/json"})
        self.assertEqual(conn.getresponse().status, 200)
        conn.close()

        again = io.StringIO()
        self.assertEqual(self.launcher.launch("url", paths=self.paths, port=port, run=self.run, spawn=spawn,
                                              out=again, err=self.err), 0)
        self.assertEqual(calls, [port])
        self.assertNotEqual(again.getvalue(), self.out.getvalue())

    def test_open_mode_hands_safari_a_private_launch_file_not_the_url(self):
        port = free_port()
        spawn, _ = self._spawn_on(port)
        self.assertEqual(self.launcher.launch("open", paths=self.paths, port=port, run=self.run, spawn=spawn,
                                              out=self.out, err=self.err), 0)
        self.run.assert_called_once()
        args, kwargs = self.run.call_args
        self.assertEqual(kwargs, OPEN_KWARGS)
        argv = args[0]
        self.assertEqual(len(argv), 4)
        self.assertEqual(argv[:3], ["/usr/bin/open", "-a", "Safari"])
        launch_file = Path(argv[3])
        self.assertEqual(launch_file.parent, self.paths.secret_dir)
        self.assertRegex(launch_file.name, r"^launch-[0-9a-f]{16}\.webloc$")
        # Nothing claimable is visible in argv.
        self.assertFalse([a for a in argv if "#c=" in a or re.search(r"[0-9a-f]{32}", a)])
        st = os.lstat(launch_file)
        self.assertTrue(stat.S_ISREG(st.st_mode))
        self.assertEqual(stat.S_IMODE(st.st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(self.paths.secret_dir).st_mode), 0o700)
        with open(launch_file, "rb") as fh:
            data = plistlib.load(fh)
        self.assertEqual(list(data), ["URL"])
        m = re.fullmatch(rf"http://127\.0\.0\.1:{port}/#c=([0-9a-f]{{32}}\.[0-9]+\.[0-9a-f]{{64}})", data["URL"])
        self.assertIsNotNone(m, data["URL"])
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("POST", "/api/claim", body=json.dumps({"code": m.group(1)}),
                     headers={"Origin": f"http://127.0.0.1:{port}", "Content-Type": "application/json"})
        self.assertEqual(conn.getresponse().status, 200)
        conn.close()

    def test_launch_files_are_cleaned_up(self):
        port = free_port()
        spawn, _ = self._spawn_on(port)
        security.load_or_create_secret(self.paths)
        secret_before = self.paths.secret_file.read_bytes()
        d = self.paths.secret_dir
        old = d / "launch-00000000000000aa.webloc"
        fresh = d / "launch-00000000000000bb.webloc"
        lookalike = d / "launch-notours.webloc"
        for path in (old, fresh, lookalike):
            path.write_bytes(b"x")
        os.utime(old, ns=((now_ms() - 120_000) * 1_000_000,) * 2)
        os.utime(lookalike, ns=((now_ms() - 120_000) * 1_000_000,) * 2)
        self.assertEqual(self.launcher.launch("open", paths=self.paths, port=port, run=self.run, spawn=spawn,
                                              out=self.out, err=self.err), 0)
        self.assertFalse(old.exists())
        self.assertTrue(fresh.exists())
        self.assertTrue(lookalike.exists())
        self.assertEqual(self.paths.secret_file.read_bytes(), secret_before)
        new_file = Path(self.run.call_args.args[0][3])
        self.assertTrue(new_file.exists())

        failing = mock.Mock(side_effect=OSError("no open"))
        self.assertEqual(self.launcher.launch("open", paths=self.paths, port=port, run=failing, spawn=spawn,
                                              out=self.out, err=self.err), 1)
        self.assertFalse(Path(failing.call_args.args[0][3]).exists())
        self.assertIn("tokentown url", self.err.getvalue())

    def test_launch_file_refuses_an_existing_name(self):
        security.load_or_create_secret(self.paths)
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        target = Path(outside.name) / "elsewhere"
        with mock.patch.object(security.secrets, "token_hex", return_value="00000000000000cc"):
            link = self.paths.secret_dir / "launch-00000000000000cc.webloc"
            os.symlink(target, link)
            with self.assertRaises(FileExistsError):
                security.write_launch_file(self.paths, "http://127.0.0.1:1/#c=x")
        self.assertFalse(target.exists())

    def test_refuses_when_something_else_answers(self):
        other = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _OtherHandler)
        thread = threading.Thread(target=other.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()
        self.addCleanup(lambda: (other.shutdown(), other.server_close(), thread.join(5)))
        spawn = mock.Mock()
        port = other.server_address[1]
        self.assertEqual(self.launcher.launch("open", paths=self.paths, port=port, run=self.run, spawn=spawn,
                                              out=self.out, err=self.err), 1)
        spawn.assert_not_called()
        self.run.assert_not_called()
        self.assertIn("Refusing", self.err.getvalue())
        kill = mock.Mock()
        self.assertEqual(self.launcher.stop(paths=self.paths, port=port, run=self.run, kill=kill,
                                            out=self.out, err=self.err), 1)
        kill.assert_not_called()

    def test_server_that_never_starts(self):
        port = free_port()
        self.assertEqual(self.launcher.launch("url", paths=self.paths, port=port, run=self.run, spawn=lambda: None,
                                              out=self.out, err=self.err, wait_s=0.3), 1)
        self.assertEqual(self.out.getvalue(), "")
        self.assertIn("did not start", self.err.getvalue())

    def test_stop_verifies_then_signals_the_listening_tokentown(self):
        port = free_port()
        secret = security.load_or_create_secret(self.paths)
        httpd, app = server.make_server(port, board_provider=lambda: (make_raw(), make_board()),
                                        opener=actions.Opener(run=mock.Mock()), secret=secret, scan_interval=3600)
        thread = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()

        def fake_run(argv, **kwargs):
            if argv[0] == "/usr/sbin/lsof":
                self.assertEqual(argv, ["/usr/sbin/lsof", "-nP", f"-tiTCP:{port}", "-sTCP:LISTEN"])
                return subprocess.CompletedProcess(argv, 0, stdout="4242\n", stderr="")
            self.assertEqual(argv, ["/bin/ps", "-o", "command=", "-p", "4242"])
            return subprocess.CompletedProcess(argv, 0, stdout=f"{sys.executable} {LAUNCHER} serve\n", stderr="")

        def fake_kill(pid, sig):
            self.assertEqual((pid, sig), (4242, signal.SIGTERM))
            httpd.shutdown()
            httpd.server_close()
            app.stop()

        kill = mock.Mock(side_effect=fake_kill)
        self.assertEqual(self.launcher.stop(paths=self.paths, port=port, run=fake_run, kill=kill,
                                            out=self.out, err=self.err), 0, self.err.getvalue())
        kill.assert_called_once()
        thread.join(5)
        self.assertEqual(self.launcher.stop(paths=self.paths, port=port, run=fake_run, kill=kill,
                                            out=self.out, err=self.err), 0)
        kill.assert_called_once()

    def test_stop_skips_a_listener_that_is_not_tokentown(self):
        port = free_port()
        secret = security.load_or_create_secret(self.paths)
        start_server(self, provider=lambda: (make_raw(), make_board()), secret=secret, port=port)
        run = mock.Mock(side_effect=lambda argv, **kw: subprocess.CompletedProcess(
            argv, 0, stdout="4242\n" if argv[0] == "/usr/sbin/lsof" else "/usr/bin/python3 other.py\n"))
        kill = mock.Mock()
        self.assertEqual(self.launcher.stop(paths=self.paths, port=port, run=run, kill=kill,
                                            out=self.out, err=self.err), 1)
        kill.assert_not_called()

    def test_stop_reports_a_failing_lsof_or_ps_rather_than_raising(self):
        """probe already proved the server is ours, so a broken lsof or ps is a message, never a traceback."""
        port = free_port()
        secret = security.load_or_create_secret(self.paths)
        start_server(self, provider=lambda: (make_raw(), make_board()), secret=secret, port=port)
        kill = mock.Mock()
        cases = (("/usr/sbin/lsof", FileNotFoundError(2, "No such file or directory")),
                 ("/bin/ps", subprocess.TimeoutExpired("/bin/ps", 10)))
        for binary, exc in cases:
            with self.subTest(binary=binary):
                err = io.StringIO()

                def run(argv, _binary=binary, _exc=exc, **kwargs):
                    if argv[0] == _binary:
                        raise _exc
                    return subprocess.CompletedProcess(argv, 0, stdout="4242\n", stderr="")

                self.assertEqual(self.launcher.stop(paths=self.paths, port=port, run=run, kill=kill,
                                                    out=self.out, err=err), 1)
                message = err.getvalue()
                self.assertIn("could not list what is listening", message)
                self.assertIn("The server is still running.", message)
                self.assertIn(type(exc).__name__, message)
                # The class name only: an exception's text can carry a path.
                self.assertNotIn("No such file", message)
                self.assertEqual(message.count("\n"), 1)
        kill.assert_not_called()

    def test_main_carries_the_legacy_dir_over_before_running_a_command(self):
        """The one call in main is what every command relies on, so wire it, not just the function."""
        old = self.paths.legacy_secret_dir
        old.mkdir(parents=True, mode=0o700)
        (old / "done.json").write_text('{"v": 1}')
        with mock.patch.dict(os.environ, {"TOWN_HOME": str(self.paths.home)}), \
                mock.patch.object(self.launcher, "stop", return_value=0) as stop:
            self.assertEqual(self.launcher.main(["stop"]), 0)
        stop.assert_called_once_with()
        self.assertFalse(old.exists())
        self.assertEqual((self.paths.secret_dir / "done.json").read_text(), '{"v": 1}')

    def test_unknown_subcommand(self):
        with mock.patch("sys.stderr", new_callable=io.StringIO) as err:
            self.assertEqual(self.launcher.main(["bogus"]), 2)
            self.assertEqual(self.launcher.main(["url", "extra"]), 2)
        self.assertIn("tokentown url", err.getvalue())


if __name__ == "__main__":
    unittest.main()
