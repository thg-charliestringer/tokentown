"""PR state from GitHub through gh: argv, env, parsing, caching, backoff and thread safety.

gh never runs here: every test passes a mock run, and real process launches fail the test.
"""
from __future__ import annotations

import os
import stat
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from town import github
from town.github import (FAILURE_BACKOFF_MS, JQ_FILTER, OPEN_RECHECK_MS, PAUSE_MAX_MS, PAUSE_MS, PrStateResolver,
                        parse_pr_state)
from town.model import GitHubPr

GH = "/opt/homebrew/bin/gh"
HOME = "/Users/someone"
URL = "https://github.com/Acme-DataTeam/wonderful-things-core/pull/532"
URL2 = "https://github.com/Acme-DataTeam/wonderful-things-core/pull/533"
T0 = 1_790_000_000_000
MINUTE = 60_000

OPEN_OUT = b'{"closed_at":null,"merged_at":null,"state":"open"}\n'
MERGED_OUT = b'{"closed_at":"2026-09-15T10:22:33Z","merged_at":"2026-09-15T10:22:33Z","state":"closed"}\n'
CLOSED_OUT = b'{"closed_at":"2026-09-14T08:00:00Z","merged_at":null,"state":"closed"}\n'
MERGED_MS = 1_789_467_753_000
CLOSED_MS = 1_789_372_800_000


def setUpModule():
    # The exact env tests must not see a GH_TOKEN or GH_CONFIG_DIR from the shell that runs them.
    patcher = mock.patch.dict(os.environ)
    patcher.start()
    unittest.addModuleCleanup(patcher.stop)
    for key in github.GH_ENV_KEYS:
        os.environ.pop(key, None)


def no_real_subprocesses(case: unittest.TestCase) -> None:
    for target in ("subprocess.Popen", "os.posix_spawn", "os.execv", "os.system"):
        patcher = mock.patch(target, side_effect=AssertionError(f"real {target} called in a test"))
        patcher.start()
        case.addCleanup(patcher.stop)


def done(stdout=OPEN_OUT, code=0, stderr=b""):
    return subprocess.CompletedProcess([], code, stdout=stdout, stderr=stderr)


class Clock:
    def __init__(self, t: int = T0):
        self.t = t

    def __call__(self) -> int:
        return self.t


class ResolverTestCase(unittest.TestCase):
    def setUp(self):
        no_real_subprocesses(self)
        self.clock = Clock()
        self.run = mock.Mock(return_value=done())
        self.resolver = PrStateResolver(run=self.run, clock_ms=self.clock, gh_path=GH, home=HOME)

    def argv_for(self, owner: str, repo: str, number: int) -> list[str]:
        return [GH, "api", f"repos/{owner}/{repo}/pulls/{number}", "--jq", JQ_FILTER]


class ArgvTests(ResolverTestCase):
    def test_exact_argv_and_env(self):
        self.assertEqual(self.resolver.refresh([URL]), 1)
        self.run.assert_called_once_with(
            [GH, "api", "repos/Acme-DataTeam/wonderful-things-core/pulls/532", "--jq",
             "{state: .state, merged_at: .merged_at, closed_at: .closed_at}"],
            shell=False, timeout=20, stdin=subprocess.DEVNULL, capture_output=True,
            env={"PATH": "/usr/bin:/bin", "HOME": HOME})

    def test_every_argv_element_is_a_plain_string(self):
        self.resolver.refresh([URL, "https://github.com/a.b/c_d-e.f/pull/7"])
        for call in self.run.call_args_list:
            argv = call.args[0]
            self.assertTrue(all(type(a) is str for a in argv))
            self.assertEqual(argv[0], GH)
            self.assertEqual(argv[1:2] + argv[3:], ["api", "--jq", JQ_FILTER])
        self.assertEqual(self.run.call_args_list[1].args[0], self.argv_for("a.b", "c_d-e.f", 7))

    def test_default_home_is_the_user_home(self):
        resolver = PrStateResolver(run=self.run, clock_ms=self.clock, gh_path=GH)
        resolver.refresh([URL])
        self.assertEqual(self.run.call_args.kwargs["env"], {"PATH": "/usr/bin:/bin", "HOME": str(Path.home())})

    def test_leading_zeros_become_the_canonical_number(self):
        self.resolver.refresh(["https://github.com/o/r/pull/0042"])
        self.assertEqual(self.run.call_args.args[0], self.argv_for("o", "r", 42))

    def test_hostile_urls_never_reach_argv(self):
        hostile = [
            "javascript:alert(1)",
            "https://github.com/o/r/pull/1/files",
            "https://github.com/o/r/pull/1/../../../user",
            "https://github.com/o/r/pull/1\n",
            "https://github.com/o/r/pull/1\r\n--method=DELETE",
            "https://github.com/o/r/pull/1?x=1",
            "https://github.com/o/r/pull/1#frag",
            "https://github.com/o/r/pull/abc",
            "https://github.com/o/r/pull/-1",
            "https://github.com/o/r/pull/0",
            "https://github.com/o/r/pull/12345678901",
            "https://github.com/o/r/pull/1 --method=DELETE",
            "https://github.com/o/x/r/pull/1",
            "https://github.com/o%2Fx/r/pull/1",
            "https://github.com/../../pull/1",
            "https://github.com/o/../pull/1",
            "https://github.com/./r/pull/1",
            "https://github.com/{owner}/{repo}/pull/1",
            "https://github.com/ｏ/r/pull/1",
            "https://github.com/o/r/pull/١٢",
            "http://github.com/o/r/pull/1",
            "https://github.com.evil.example/o/r/pull/1",
            "https://evil.example/github.com/o/r/pull/1",
            "https://github.com/o/r/issues/1",
            " https://github.com/o/r/pull/1",
            "",
        ]
        self.assertEqual(self.resolver.refresh(hostile), 0)
        self.run.assert_not_called()
        self.assertEqual(self.resolver.snapshot(), {})
        self.assertEqual(self.resolver.health()["known"], 0)

    def test_non_string_urls_are_skipped(self):
        self.assertEqual(self.resolver.refresh([None, 532, b"https://github.com/o/r/pull/1", ["x"], {"u": 1}]), 0)
        self.run.assert_not_called()

    def test_only_the_valid_url_in_a_mixed_list_is_called(self):
        self.assertEqual(self.resolver.refresh(["javascript:alert(1)", URL, "https://github.com/../../pull/1"]), 1)
        self.run.assert_called_once()
        self.assertEqual(self.run.call_args.args[0], self.argv_for("Acme-DataTeam", "wonderful-things-core", 532))

    def test_duplicates_call_once(self):
        self.assertEqual(self.resolver.refresh([URL, URL, URL]), 1)

    def test_relative_gh_path_refused(self):
        for bad in ("gh", "bin/gh", ""):
            with self.assertRaises(ValueError):
                PrStateResolver(run=self.run, clock_ms=self.clock, gh_path=bad, home=HOME)


class ParseTests(unittest.TestCase):
    def test_open(self):
        self.assertEqual(parse_pr_state(OPEN_OUT), ("OPEN", None, None))

    def test_merged(self):
        self.assertEqual(parse_pr_state(MERGED_OUT), ("MERGED", MERGED_MS, MERGED_MS))

    def test_closed_without_merge(self):
        self.assertEqual(parse_pr_state(CLOSED_OUT), ("CLOSED", None, CLOSED_MS))

    def test_merged_at_wins_over_state(self):
        out = b'{"state":"open","merged_at":"2026-09-15T10:22:33Z","closed_at":null}'
        self.assertEqual(parse_pr_state(out), ("MERGED", MERGED_MS, None))

    def test_pretty_printed_and_extra_keys(self):
        out = b'{\n  "closed_at": null,\n  "merged_at": null,\n  "state": "open",\n  "title": "x"\n}\n'
        self.assertEqual(parse_pr_state(out), ("OPEN", None, None))

    def test_timestamp_variants(self):
        for value, ms in (("2026-09-15T10:22:33Z", MERGED_MS), ("2026-09-15T10:22:33.5Z", MERGED_MS + 500),
                          ("2026-09-15T11:22:33+01:00", MERGED_MS), ("2026-09-15T09:22:33.123456-01:00",
                                                                     MERGED_MS + 123)):
            out = ('{"state":"closed","merged_at":"%s","closed_at":null}' % value).encode()
            self.assertEqual(parse_pr_state(out)[1], ms, value)

    def test_malformed_json(self):
        for out in (b"", b"\n", b"not json", b'{"state":"open"', b"[]", b'"open"', b"null", b"42",
                    b'{"state":"open","merged_at":null,"closed_at":null}{"x":1}',
                    b'{"state":"open","merged_at":NaN,"closed_at":null}',
                    b'{"state":"open","merged_at":Infinity,"closed_at":null}',
                    b"[" * 3000, b"\xff\xfe{}", None, 42):
            with self.assertRaises(github.BadResponse, msg=repr(out)[:40]):
                parse_pr_state(out)

    def test_missing_keys(self):
        for out in (b'{"state":"open","merged_at":null}', b'{"state":"open","closed_at":null}',
                    b'{"merged_at":null,"closed_at":null}', b"{}"):
            with self.assertRaises(github.BadResponse, msg=out):
                parse_pr_state(out)

    def test_wrong_types_and_states(self):
        for out in (b'{"state":1,"merged_at":null,"closed_at":null}',
                    b'{"state":null,"merged_at":null,"closed_at":null}',
                    b'{"state":"draft","merged_at":null,"closed_at":null}',
                    b'{"state":"OPEN","merged_at":null,"closed_at":null}',
                    b'{"state":"open","merged_at":1789467753000,"closed_at":null}',
                    b'{"state":"closed","merged_at":null,"closed_at":true}',
                    b'{"state":["open"],"merged_at":null,"closed_at":null}'):
            with self.assertRaises(github.BadResponse, msg=out):
                parse_pr_state(out)

    def test_bad_timestamps(self):
        for value in ("yesterday", "2026-13-01T00:00:00Z", "2026-09-15T10:22:33", "2026-09-15 10:22:33Z",
                      "2026-09-15T10:22:33+24:00", "2026-09-15", "1969-12-31T23:59:59Z",
                      "2026-09-15T10:22:33.1234567Z", "٢026-09-15T10:22:33Z", "2026-09-15T10:22:33Z\n", ""):
            out = ('{"state":"closed","merged_at":"%s","closed_at":null}' % value.replace("\n", "\\n")).encode()
            with self.assertRaises(github.BadResponse, msg=value):
                parse_pr_state(out)

    def test_oversized_output(self):
        out = b'{"state":"open","merged_at":null,"closed_at":null,"pad":"' + b"x" * 5000 + b'"}'
        with self.assertRaises(github.BadResponse):
            parse_pr_state(out)


class ResolveTests(ResolverTestCase):
    def test_states_reach_the_snapshot(self):
        outputs = {"532": OPEN_OUT, "533": MERGED_OUT, "534": CLOSED_OUT}
        self.run.side_effect = lambda argv, **kw: done(outputs[argv[2].rsplit("/", 1)[1]])
        url3 = "https://github.com/Acme-DataTeam/wonderful-things-core/pull/534"
        self.assertEqual(self.resolver.refresh([URL, URL2, url3]), 3)
        self.assertEqual(self.resolver.snapshot(), {
            URL: GitHubPr(state="OPEN", merged_at=None, closed_at=None, checked_at=T0),
            URL2: GitHubPr(state="MERGED", merged_at=MERGED_MS, closed_at=MERGED_MS, checked_at=T0),
            url3: GitHubPr(state="CLOSED", merged_at=None, closed_at=CLOSED_MS, checked_at=T0),
        })
        self.assertEqual(self.resolver.health(), {"enabled": True, "known": 3, "failed": 0, "lastError": None,
                                                  "lastCheckedAt": T0})

    def test_nothing_else_from_the_response_is_kept(self):
        self.run.return_value = done(b'{"state":"open","merged_at":null,"closed_at":null,"title":"secret title"}',
                                     stderr=b"secret stderr")
        self.resolver.refresh([URL])
        dumped = repr(self.resolver.snapshot()) + repr(self.resolver.health()) + repr(vars(self.resolver))
        self.assertNotIn("secret", dumped)

    def test_terminal_states_are_never_rechecked(self):
        for out in (MERGED_OUT, CLOSED_OUT):
            with self.subTest(out=out):
                self.run.reset_mock()
                resolver = PrStateResolver(run=self.run, clock_ms=self.clock, gh_path=GH, home=HOME)
                self.run.return_value = done(out)
                self.assertEqual(resolver.refresh([URL]), 1)
                for step in (OPEN_RECHECK_MS, FAILURE_BACKOFF_MS, 30 * 24 * 60 * MINUTE):
                    self.clock.t += step
                    self.assertEqual(resolver.refresh([URL]), 0)
                self.assertEqual(self.run.call_count, 1)
                self.clock.t = T0

    def test_open_is_rechecked_after_ten_minutes(self):
        self.assertEqual(self.resolver.refresh([URL]), 1)
        self.clock.t = T0 + OPEN_RECHECK_MS - 1
        self.assertEqual(self.resolver.refresh([URL]), 0)
        self.clock.t = T0 + OPEN_RECHECK_MS
        self.run.return_value = done(MERGED_OUT)
        self.assertEqual(self.resolver.refresh([URL]), 1)
        self.assertEqual(self.resolver.snapshot()[URL].state, "MERGED")
        self.assertEqual(self.resolver.snapshot()[URL].checked_at, T0 + OPEN_RECHECK_MS)
        self.clock.t += 365 * 24 * 60 * MINUTE
        self.assertEqual(self.resolver.refresh([URL]), 0)

    def test_recheck_is_timed_from_when_the_call_finished(self):
        def slow(argv, **kw):
            self.clock.t += 15_000
            return done()

        self.run.side_effect = slow
        self.resolver.refresh([URL])
        self.assertEqual(self.resolver.snapshot()[URL].checked_at, T0 + 15_000)
        self.clock.t = T0 + 15_000 + OPEN_RECHECK_MS - 1
        self.assertEqual(self.resolver.refresh([URL]), 0)

    def test_failure_backs_off_fifteen_minutes(self):
        self.run.return_value = done(b"", code=1, stderr=b"gh: Not Found (HTTP 404)")
        self.assertEqual(self.resolver.refresh([URL]), 1)
        self.assertEqual(self.resolver.snapshot(), {})
        self.assertEqual(self.resolver.health(), {"enabled": True, "known": 0, "failed": 1, "lastError": "exit 1",
                                                  "lastCheckedAt": None})
        self.clock.t = T0 + FAILURE_BACKOFF_MS - 1
        self.assertEqual(self.resolver.refresh([URL]), 0)
        self.clock.t = T0 + FAILURE_BACKOFF_MS
        self.run.return_value = done(OPEN_OUT)
        self.assertEqual(self.resolver.refresh([URL]), 1)
        self.assertEqual(self.resolver.health(), {"enabled": True, "known": 1, "failed": 0, "lastError": None,
                                                  "lastCheckedAt": T0 + FAILURE_BACKOFF_MS})

    def test_failed_recheck_keeps_the_last_known_state(self):
        self.resolver.refresh([URL])
        self.clock.t = T0 + OPEN_RECHECK_MS
        self.run.return_value = done(b"garbage")
        self.assertEqual(self.resolver.refresh([URL]), 1)
        self.assertEqual(self.resolver.snapshot()[URL], GitHubPr("OPEN", None, None, T0))
        health = self.resolver.health()
        self.assertEqual((health["known"], health["failed"], health["lastError"]), (1, 1, "BadResponse"))
        self.assertEqual(health["lastCheckedAt"], T0)
        self.clock.t = T0 + OPEN_RECHECK_MS + FAILURE_BACKOFF_MS - 1
        self.assertEqual(self.resolver.refresh([URL]), 0)

    def test_error_names_are_class_names_exit_codes_or_http_statuses_only(self):
        cases = [
            (subprocess.TimeoutExpired([GH], 20, output=b"secret out", stderr=b"secret err"), "TimeoutExpired"),
            (FileNotFoundError(2, "No such file", "/secret/path"), "FileNotFoundError"),
            (PermissionError(13, "denied"), "PermissionError"),
            (RuntimeError("secret message"), "RuntimeError"),
            (done(b"secret", code=4, stderr=b"secret"), "gh not signed in"),
            (done(b'{"message":"secret credentials","status":"401"}', code=1, stderr=b"secret"), "HTTP 401"),
            (done(b"secret", code=-9), "exit -9"),
            (done(b"secret text"), "BadResponse"),
            (subprocess.CompletedProcess([], None, stdout=OPEN_OUT), "BadResponse"),
        ]
        for outcome, expected in cases:
            with self.subTest(expected=expected):
                run = mock.Mock()
                if isinstance(outcome, BaseException):
                    run.side_effect = outcome
                else:
                    run.return_value = outcome
                resolver = PrStateResolver(run=run, clock_ms=self.clock, gh_path=GH, home=HOME)
                self.assertEqual(resolver.refresh([URL]), 1)
                health = resolver.health()
                self.assertEqual(health["lastError"], expected)
                self.assertEqual(health["failed"], 1)
                self.assertNotIn("secret", repr(health) + repr(resolver.snapshot()))

    def test_timeout_backs_off(self):
        self.run.side_effect = subprocess.TimeoutExpired([GH], 20)
        self.assertEqual(self.resolver.refresh([URL, URL2]), 2)
        self.clock.t += MINUTE
        self.assertEqual(self.resolver.refresh([URL, URL2]), 0)
        self.assertEqual(self.resolver.health()["failed"], 2)

    def test_last_error_is_the_newest_still_failing(self):
        self.run.side_effect = [done(code=1), done(b"x")]
        self.resolver.refresh([URL])
        self.clock.t += MINUTE
        self.resolver.refresh([URL, URL2])
        self.assertEqual(self.resolver.health()["lastError"], "BadResponse")

    def test_max_calls_caps_a_cycle_and_the_rest_follow(self):
        urls = [f"https://github.com/o/r/pull/{n}" for n in range(1, 6)]
        self.assertEqual(self.resolver.refresh(urls, max_calls=2), 2)
        self.assertEqual(self.resolver.refresh(urls, max_calls=2), 2)
        self.assertEqual(self.resolver.refresh(urls, max_calls=2), 1)
        self.assertEqual(self.resolver.refresh(urls, max_calls=2), 0)
        numbers = [c.args[0][2].rsplit("/", 1)[1] for c in self.run.call_args_list]
        self.assertEqual(numbers, ["1", "2", "3", "4", "5"])
        self.assertEqual(self.resolver.refresh(urls, max_calls=0), 0)

    def test_default_max_calls_is_120(self):
        urls = [f"https://github.com/o/r/pull/{n}" for n in range(1, 181)]
        self.assertEqual(github.MAX_CALLS_PER_CYCLE, 120)
        self.assertEqual(self.resolver.refresh(urls), 120)
        numbers = [int(c.args[0][2].rsplit("/", 1)[1]) for c in self.run.call_args_list]
        self.assertEqual(numbers, list(range(1, 121)))
        self.assertEqual(self.resolver.refresh(urls), 60)

    def test_urls_no_longer_passed_are_forgotten(self):
        self.run.side_effect = [done(MERGED_OUT), done(code=1)]
        self.resolver.refresh([URL, URL2])
        self.assertEqual(self.resolver.health()["failed"], 1)
        self.resolver.refresh([URL])
        self.assertEqual(set(self.resolver.snapshot()), {URL})
        self.assertEqual(self.resolver.health()["failed"], 0)
        self.assertIsNone(self.resolver.health()["lastError"])
        self.resolver.refresh([])
        self.assertEqual(self.resolver.snapshot(), {})
        self.assertEqual(self.resolver.health()["lastCheckedAt"], T0)

    def test_accepts_any_iterable(self):
        self.assertEqual(self.resolver.refresh(u for u in (URL, URL2)), 2)


def iso(ms: int) -> str:
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class GhFailureTests(unittest.TestCase):
    """How a failed gh call is kept, for every gh source: which failure it was, never what gh or GitHub said."""

    def test_no_sign_in_at_all(self):
        self.assertEqual(github.gh_failure(4), "gh not signed in")
        self.assertEqual(github.gh_failure(4, b'{"status":"500"}'), "gh not signed in")
        self.assertEqual(github.GH_NOT_SIGNED_IN, "gh not signed in")

    def test_an_http_error_is_named_by_its_status_alone(self):
        body = b'{"message":"Bad credentials","documentation_url":"https://docs.github.com/rest","status":"401"}'
        self.assertEqual(github.gh_failure(1, body), "HTTP 401")
        self.assertEqual(github.gh_failure(1, body.decode() + "\n"), "HTTP 401")
        self.assertEqual(github.gh_failure(1, b'{\n  "message": "Not Found",\n  "status": "404"\n}\n'), "HTTP 404")
        self.assertEqual(github.gh_failure(1, b'{"status":"503"}'), "HTTP 503")

    def test_anything_else_is_the_exit_code(self):
        cases = [
            (1, None), (1, b""), (1, b"gh: Bad credentials"), (1, b'{"message":"API rate limit exceeded"}'),
            (1, b'{"status":401}'), (1, b'{"status":"4011"}'), (1, b'{"status":"099"}'), (1, b'{"status":" 401"}'),
            (1, b'{"status":"\u0664\u0660\u0661"}'), (1, b'[{"status":"401"}]'), (1, b'{"status":"401","n":NaN}'),
            (1, b"\xff\xfe"), (1, b'{"status":"401","pad":"' + b"x" * github.MAX_ERROR_BYTES + b'"}'),
            (1, b"[" * 100_000), (1, 401), (2, b'{"status":"401"}'), (-9, b'{"status":"401"}'),
        ]
        for code, stdout in cases:
            with self.subTest(code=code, stdout=stdout[:40] if isinstance(stdout, bytes) else stdout):
                self.assertEqual(github.gh_failure(code, stdout), f"exit {code}")


class FutureTimestampTests(ResolverTestCase):
    def out(self, merged_at: str | None, closed_at: str | None, state: str = "closed") -> bytes:
        q = lambda v: "null" if v is None else f'"{v}"'
        return f'{{"state":"{state}","merged_at":{q(merged_at)},"closed_at":{q(closed_at)}}}'.encode()

    def test_merge_time_far_in_the_future_is_a_bad_answer_and_retried(self):
        for merged_at in ("9999-12-31T23:59:59-23:59", iso(T0 + 24 * 60 * MINUTE + 1000)):
            with self.subTest(merged_at=merged_at):
                resolver = PrStateResolver(run=self.run, clock_ms=self.clock, gh_path=GH, home=HOME)
                self.run.return_value = done(self.out(merged_at, merged_at))
                self.assertEqual(resolver.refresh([URL]), 1)
                self.assertEqual(resolver.snapshot(), {})
                self.assertEqual((resolver.health()["failed"], resolver.health()["lastError"]), (1, "BadResponse"))
                self.clock.t = T0 + FAILURE_BACKOFF_MS
                self.run.return_value = done(MERGED_OUT)
                self.assertEqual(resolver.refresh([URL]), 1)
                self.assertEqual(resolver.snapshot()[URL].merged_at, MERGED_MS)
                self.clock.t = T0

    def test_future_close_time_on_an_open_pr_is_refused_too(self):
        self.run.return_value = done(self.out(None, iso(T0 + 2 * 24 * 60 * MINUTE), state="open"))
        self.resolver.refresh([URL])
        self.assertEqual(self.resolver.snapshot(), {})

    def test_small_clock_skew_is_accepted(self):
        ahead = T0 + 24 * 60 * MINUTE
        self.run.return_value = done(self.out(iso(ahead), iso(ahead)))
        self.resolver.refresh([URL])
        self.assertEqual(self.resolver.snapshot()[URL].merged_at, ahead)


class OutageTests(ResolverTestCase):
    """A GitHub, proxy or sign-in outage must not keep gh running all day."""

    URLS = [f"https://github.com/o/r/pull/{n}" for n in range(1, 43)]

    def simulate(self, minutes: int, *, call_seconds: int = 0, failing=lambda n: True) -> int:
        def call(argv, **kw):
            self.clock.t += call_seconds * 1000
            return done(code=1) if failing(int(argv[2].rsplit("/", 1)[1])) else done(MERGED_OUT)

        self.run.side_effect = call
        end = self.clock.t + minutes * MINUTE
        calls = 0
        while self.clock.t < end:
            calls += self.resolver.refresh(self.URLS)
            self.clock.t += MINUTE
        return calls

    def test_a_day_of_timeouts_stays_under_fifty_calls(self):
        self.assertLess(self.simulate(24 * 60, call_seconds=20), 50)

    def test_a_day_signed_out_stays_under_fifty_calls(self):
        self.assertLess(self.simulate(24 * 60), 50)
        self.assertEqual(self.resolver.health()["lastError"], "exit 1")

    def test_a_cycle_stops_after_three_failures_in_a_row(self):
        self.run.return_value = done(code=4)
        self.assertEqual(self.resolver.refresh(self.URLS), 3)
        self.assertEqual(self.resolver.refresh(self.URLS), 0)
        self.clock.t += PAUSE_MS - 1
        self.assertEqual(self.resolver.refresh(self.URLS), 0)
        self.clock.t += 1
        self.assertEqual(self.resolver.refresh(self.URLS), 3)

    def test_pause_doubles_to_two_hours_and_a_success_resets_it(self):
        self.run.return_value = done(code=1)
        pauses = []
        self.assertEqual(self.resolver.refresh(self.URLS), 3)
        for _ in range(6):
            start = self.clock.t
            while True:
                self.clock.t += MINUTE
                made = self.resolver.refresh(self.URLS)
                if made:
                    break
            self.assertEqual(made, 3)
            pauses.append(-(-(self.clock.t - start) // MINUTE) * MINUTE)
        self.assertEqual(pauses, [PAUSE_MS, 2 * PAUSE_MS, 4 * PAUSE_MS, PAUSE_MAX_MS, PAUSE_MAX_MS, PAUSE_MAX_MS])
        self.run.return_value = done(MERGED_OUT)
        self.clock.t += PAUSE_MAX_MS
        self.assertEqual(self.resolver.refresh(self.URLS), 42)
        self.assertEqual(self.resolver.health()["known"], 42)

    def test_recovers_once_the_outage_ends(self):
        self.simulate(6 * 60)
        self.assertEqual(self.resolver.health()["known"], 0)
        self.simulate(PAUSE_MAX_MS // MINUTE + 2, failing=lambda n: False)
        self.assertEqual(self.resolver.health()["known"], 42)
        self.assertEqual(self.resolver.health()["failed"], 0)

    def test_dead_urls_first_in_line_do_not_starve_the_rest(self):
        dead = {1, 2, 3}
        calls = self.simulate(PAUSE_MS // MINUTE + 1, failing=lambda n: n in dead)
        health = self.resolver.health()
        self.assertEqual((health["known"], health["failed"]), (39, 3))
        self.assertLess(calls, 50)

    def test_a_single_dead_url_does_not_pause_the_others(self):
        self.run.side_effect = lambda argv, **kw: done(code=1) if argv[2].endswith("/1") else done(OPEN_OUT)
        self.resolver.refresh(self.URLS[:1])
        self.clock.t += MINUTE
        self.assertEqual(self.resolver.refresh(self.URLS[:2]), 1)
        self.assertEqual(set(self.resolver.snapshot()), {self.URLS[1]})


class FakePopen:
    """Stands in for subprocess.Popen: records how gh was started and blocks until told to finish or killed."""

    instances: list["FakePopen"] = []

    def __init__(self, argv, **kwargs):
        self.argv, self.kwargs = argv, kwargs
        self.returncode = None
        self.killed = threading.Event()
        self.finish = threading.Event()
        self.started = threading.Event()
        self.stdout = OPEN_OUT
        self.timeout_first = False
        FakePopen.instances.append(self)
        self.started.set()

    def communicate(self, timeout=None):
        if self.timeout_first and timeout is not None:
            self.timeout_first = False
            raise subprocess.TimeoutExpired(self.argv, timeout, output=b"secret out")
        while not (self.finish.is_set() or self.killed.is_set()):
            self.killed.wait(0.005)
        self.returncode = -9 if self.killed.is_set() else 0
        return (b"" if self.killed.is_set() else self.stdout), None

    def kill(self):
        self.killed.set()


class PopenPathTests(unittest.TestCase):
    """Without an injected run, gh is started with Popen so that shutdown can kill a call in flight."""

    def setUp(self):
        no_real_subprocesses(self)
        FakePopen.instances = []
        self.clock = Clock()

    def resolver(self, popen=FakePopen):
        return PrStateResolver(clock_ms=self.clock, gh_path=GH, home=HOME, popen=popen)

    def test_exact_argv_env_and_streams(self):
        def instant(argv, **kwargs):
            p = FakePopen(argv, **kwargs)
            p.finish.set()
            return p

        resolver = self.resolver(instant)
        self.assertEqual(resolver.refresh([URL]), 1)
        (p,) = FakePopen.instances
        self.assertEqual(p.argv, [GH, "api", "repos/Acme-DataTeam/wonderful-things-core/pulls/532", "--jq",
                                  "{state: .state, merged_at: .merged_at, closed_at: .closed_at}"])
        self.assertEqual(p.kwargs, {"shell": False, "stdin": subprocess.DEVNULL, "stdout": subprocess.PIPE,
                                    "stderr": subprocess.DEVNULL, "env": {"PATH": "/usr/bin:/bin", "HOME": HOME}})
        self.assertEqual(resolver.snapshot()[URL].state, "OPEN")

    def test_default_popen_is_subprocess_popen_looked_up_at_call_time(self):
        resolver = PrStateResolver(clock_ms=self.clock, gh_path=GH, home=HOME)
        with mock.patch("subprocess.Popen", side_effect=OSError("blocked")) as popen:
            self.assertEqual(resolver.refresh([URL]), 1)
        popen.assert_called_once()
        self.assertEqual(resolver.health()["lastError"], "OSError")

    def test_timeout_kills_the_child_and_records_the_class_only(self):
        def slow(argv, **kwargs):
            p = FakePopen(argv, **kwargs)
            p.timeout_first = True
            return p

        resolver = self.resolver(slow)
        self.assertEqual(resolver.refresh([URL]), 1)
        (p,) = FakePopen.instances
        self.assertTrue(p.killed.is_set())
        self.assertEqual(resolver.health()["lastError"], "TimeoutExpired")
        self.assertNotIn("secret", repr(resolver.health()) + repr(vars(resolver)))

    def test_cancel_kills_the_call_in_flight_and_stops_refreshing(self):
        resolver = self.resolver()
        worker = threading.Thread(target=resolver.refresh, args=([URL, URL2],), daemon=True)
        worker.start()
        for _ in range(500):
            if FakePopen.instances:
                break
            threading.Event().wait(0.002)
        (p,) = FakePopen.instances
        self.assertTrue(p.started.wait(2))
        resolver.cancel()
        worker.join(2)
        self.assertFalse(worker.is_alive(), "refresh kept waiting on a killed gh")
        self.assertTrue(p.killed.is_set())
        self.assertEqual(len(FakePopen.instances), 1, "no second gh after cancel")
        self.assertEqual(resolver.refresh([URL, URL2]), 0)
        self.assertEqual(len(FakePopen.instances), 1)

    def test_cancel_with_nothing_in_flight_is_harmless(self):
        resolver = self.resolver()
        resolver.cancel()
        resolver.cancel()
        self.assertEqual(resolver.refresh([URL]), 0)
        self.assertEqual(FakePopen.instances, [])


class GhDiscoveryTests(unittest.TestCase):
    def setUp(self):
        no_real_subprocesses(self)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)

    def make_exe(self, name: str, mode: int = 0o755) -> str:
        path = self.dir / name
        path.write_text("#!/bin/sh\nexit 99\n")
        path.chmod(mode)
        return str(path)

    def test_gh_missing_disables(self):
        run = mock.Mock()
        missing = (str(self.dir / "nope"), str(self.dir / "also-nope"))
        with mock.patch.object(github, "GH_CANDIDATES", missing):
            resolver = PrStateResolver(run=run, clock_ms=Clock(), home=HOME)
        self.assertIsNone(resolver.gh_path)
        self.assertFalse(resolver.enabled)
        self.assertEqual(resolver.refresh([URL]), 0)
        run.assert_not_called()
        self.assertEqual(resolver.snapshot(), {})
        self.assertEqual(resolver.health(), {"enabled": False, "known": 0, "failed": 0, "lastError": "gh not found",
                                             "lastCheckedAt": None})

    def test_first_existing_executable_wins(self):
        not_exec = self.make_exe("gh-plain", 0o644)
        first = self.make_exe("gh-first")
        second = self.make_exe("gh-second")
        with mock.patch.object(github, "GH_CANDIDATES", (str(self.dir / "nope"), not_exec, first, second)):
            resolver = PrStateResolver(run=mock.Mock(), clock_ms=Clock(), home=HOME)
        self.assertEqual(resolver.gh_path, first)

    def test_directory_is_not_gh(self):
        (self.dir / "ghdir").mkdir()
        self.assertIsNone(github.find_gh([str(self.dir / "ghdir")]))

    def test_candidates_cover_the_usual_installs(self):
        self.assertEqual(github.GH_CANDIDATES, ("/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/opt/local/bin/gh",
                                                "/run/current-system/sw/bin/gh", "~/.nix-profile/bin/gh",
                                                "~/.local/bin/gh"))

    def test_a_candidate_in_your_home_is_expanded_and_a_relative_one_never_used(self):
        home = self.dir / "home"
        (home / ".local" / "bin").mkdir(parents=True)
        gh = home / ".local" / "bin" / "gh"
        gh.write_text("#!/bin/sh\nexit 99\n")
        gh.chmod(0o755)
        with mock.patch.dict(os.environ, {"HOME": str(home)}):
            self.assertEqual(github.find_gh(["~/nope/gh", "~/.local/bin/gh"]), str(gh))
        self.assertIsNone(github.find_gh(["gh", "bin/gh"]))

    def test_gh_gets_its_sign_in_settings_and_nothing_else(self):
        environ = {"GH_CONFIG_DIR": "/Users/x/gh", "XDG_CONFIG_HOME": "/Users/x/.config", "GH_TOKEN": "t0ken",
                   "GITHUB_TOKEN": "other", "AWS_SECRET_ACCESS_KEY": "no", "PATH": "/opt/homebrew/bin", "GH_HOST": ""}
        self.assertEqual(github.gh_env(HOME, environ), {
            "PATH": "/usr/bin:/bin", "HOME": HOME, "GH_CONFIG_DIR": "/Users/x/gh",
            "XDG_CONFIG_HOME": "/Users/x/.config", "GH_TOKEN": "t0ken"})
        self.assertEqual(github.gh_env(HOME, {"GH_TOKEN": ""}), {"PATH": "/usr/bin:/bin", "HOME": HOME})

    def test_the_resolver_hands_gh_its_config_dir(self):
        run = mock.Mock(return_value=done())
        with mock.patch.dict(os.environ, {"GH_CONFIG_DIR": "/Users/x/gh"}):
            resolver = PrStateResolver(run=run, clock_ms=Clock(), gh_path=GH, home=HOME)
        resolver.refresh([URL])
        self.assertEqual(run.call_args.kwargs["env"], {"PATH": "/usr/bin:/bin", "HOME": HOME, "GH_CONFIG_DIR": "/Users/x/gh"})


class ThreadSafetyTests(ResolverTestCase):
    def test_snapshot_is_a_copy(self):
        self.resolver.refresh([URL])
        snap = self.resolver.snapshot()
        snap.clear()
        self.assertEqual(set(self.resolver.snapshot()), {URL})

    def test_snapshot_and_health_do_not_wait_for_a_call_in_flight(self):
        entered, release = threading.Event(), threading.Event()

        def blocking(argv, **kw):
            entered.set()
            release.wait(5)
            return done(MERGED_OUT)

        self.resolver.refresh([URL])
        self.clock.t += OPEN_RECHECK_MS
        self.run.side_effect = blocking
        worker = threading.Thread(target=self.resolver.refresh, args=([URL],), daemon=True)
        worker.start()
        self.assertTrue(entered.wait(5))
        try:
            results = {}

            def read():
                results["snap"] = self.resolver.snapshot()
                results["health"] = self.resolver.health()

            reader = threading.Thread(target=read, daemon=True)
            reader.start()
            reader.join(2)
            self.assertFalse(reader.is_alive(), "snapshot or health blocked on a gh call")
            self.assertEqual(results["snap"][URL].state, "OPEN")
        finally:
            release.set()
            worker.join(5)
        self.assertEqual(self.resolver.snapshot()[URL].state, "MERGED")

    def test_concurrent_readers_during_refreshes(self):
        urls = [f"https://github.com/o/r/pull/{n}" for n in range(1, 200)]
        self.run.side_effect = lambda argv, **kw: done(OPEN_OUT if int(argv[2].rsplit("/", 1)[1]) % 2 else MERGED_OUT)
        errors: list[BaseException] = []
        stop = threading.Event()

        def reader():
            try:
                while not stop.is_set():
                    snap = self.resolver.snapshot()
                    for value in snap.values():
                        self.assertIsInstance(value, GitHubPr)
                    self.resolver.health()
            except BaseException as exc:
                errors.append(exc)

        readers = [threading.Thread(target=reader, daemon=True) for _ in range(4)]
        for t in readers:
            t.start()
        try:
            for i in range(20):
                self.clock.t += OPEN_RECHECK_MS
                self.resolver.refresh(urls if i % 3 else urls[: 50 + i], max_calls=500)
        finally:
            stop.set()
            for t in readers:
                t.join(5)
        self.assertEqual(errors, [])

    def test_refresh_calls_are_serialised(self):
        active, peak = [0], [0]
        lock = threading.Lock()

        def counting(argv, **kw):
            with lock:
                active[0] += 1
                peak[0] = max(peak[0], active[0])
            threading.Event().wait(0.002)
            with lock:
                active[0] -= 1
            return done()

        self.run.side_effect = counting
        urls = [f"https://github.com/o/r/pull/{n}" for n in range(1, 30)]
        threads = [threading.Thread(target=self.resolver.refresh, args=(urls,), daemon=True) for _ in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        self.assertEqual(peak[0], 1)
        self.assertEqual(self.run.call_count, len(urls))


if __name__ == "__main__":
    unittest.main()
