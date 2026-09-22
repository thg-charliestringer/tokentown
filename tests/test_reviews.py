"""The review source: exact gh argv and env, answer parsing, caching, back-off, the breaker, and the opener.

gh never runs here, and neither does `open`: every test passes a mock run, and a real process launch fails.
"""
from __future__ import annotations

import collections
import json
import os
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from town import github, reviews
from town.model import ReviewRequest, ReviewSnapshot
from town.reviews import (MAX_CALLS_PER_CYCLE, MAX_REVIEWER_CALLS_PER_CYCLE, MAX_REVIEWERS, MAX_TEAMS,
                         MAX_VISITORS, REVIEWERS_JQ, REVIEWERS_RECHECK_MS, SEARCH_JQ, SEARCH_RECHECK_MS, TEAM_MAX,
                         ReviewOpener, ReviewSource, combine_searches, parse_requested_reviewers,
                         parse_review_search, parse_reviewers, review_id, search_rows, team_slugs)

# Written as escapes rather than literals: a source file holding a real NUL will not even parse.
NUL, BIDI, LINE_SEP = "\u0000", "\u202e", "\u2028"
GH = "/opt/homebrew/bin/gh"
HOME = "/Users/someone"
T0 = 1_790_000_000_000
MINUTE = 60_000
FAILURE_BACKOFF_MS = github.FAILURE_BACKOFF_MS
PAUSE_MS = github.PAUSE_MS
PAUSE_MAX_MS = github.PAUSE_MAX_MS

URL1 = "https://github.com/Acme-DataTeam/wonderful-things-core/pull/532"
URL2 = "https://github.com/Acme-DataTeam/wonderful-things-core/pull/533"
URL3 = "https://github.com/Acme-DataTeam/tokentown/pull/7"
OPENED1 = "2026-09-10T08:00:00Z"
OPENED1_MS = 1_789_027_200_000
OPENED2 = "2026-09-12T09:30:00Z"
OPENED2_MS = 1_789_205_400_000

DIRECT_ARGV = [GH, "search", "prs", "user-review-requested:@me", "--state", "open", "--limit", "100",
               "--json", "url,title,author,createdAt",
               "--jq", "[.[] | {u: .url, t: .title[0:120], a: .author.login, c: .createdAt}]"]
BROAD_ARGV = [GH, "search", "prs", "review-requested:@me", "--state", "open", "--limit", "100",
              "--json", "url,title,author,createdAt",
              "--jq", "[.[] | {u: .url, t: .title[0:120], a: .author.login, c: .createdAt}]"]
SEARCH_ARGVS = [DIRECT_ARGV, BROAD_ARGV]
SEARCHES = 2
REVIEWERS_ARGV_JQ = "{users: [.users[]?.login], teams: [.teams[]?.slug]}"
SEARCH_ENV = {"PATH": "/usr/bin:/bin", "HOME": HOME}
OPEN_KWARGS = dict(shell=False, timeout=10, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, env={"PATH": "/usr/bin:/bin"})


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


def search_out(*rows) -> bytes:
    return json.dumps(list(rows)).encode()


def row(url=URL1, title="Fix the funnel", author="sam", created=OPENED1) -> dict:
    return {"u": url, "t": title, "a": author, "c": created}


def reviewers_out(users=(), teams=()) -> bytes:
    return json.dumps({"users": list(users), "teams": list(teams)}).encode()


def done(stdout=b"[]", code=0, stderr=b""):
    return subprocess.CompletedProcess([], code, stdout=stdout, stderr=stderr)


class Clock:
    def __init__(self, t: int = T0):
        self.t = t

    def __call__(self) -> int:
        return self.t


class SourceTestCase(unittest.TestCase):
    def setUp(self):
        no_real_subprocesses(self)
        self.clock = Clock()
        self.run = mock.Mock(return_value=done())
        self.source = ReviewSource(run=self.run, clock_ms=self.clock, gh_path=GH, home=HOME)

    def answers(self, search=None, reviewers=None, *, direct=None, broad=None):
        """Route each call by its argv: the direct search, the broad one, or one PR's requested reviewers.

        `search` answers both searches alike; `direct` and `broad` override it for one. Any answer can be bytes or a
        CompletedProcess (a failure), and `reviewers` can also be a function of the argv.
        """
        def as_done(out, default):
            if isinstance(out, subprocess.CompletedProcess):
                return out
            return done(out if out is not None else default)

        def call(argv, **kw):
            if argv[1] == "search":
                own = direct if argv[3] == reviews.SEARCH_QUERY_DIRECT else broad
                return as_done(own if own is not None else search, b"[]")
            return as_done(reviewers(argv) if callable(reviewers) else reviewers, reviewers_out())

        self.run.side_effect = call

    def argvs(self) -> list[list[str]]:
        return [c.args[0] for c in self.run.call_args_list]

    def asked(self) -> list[int]:
        """The PR numbers a reviewers call was made for, in call order."""
        return [int(a[2].split("/pulls/")[1].split("/")[0]) for a in self.argvs() if a[1] == "api"]

    def reviewers_argv(self, owner: str, repo: str, number: int) -> list[str]:
        return [GH, "api", f"repos/{owner}/{repo}/pulls/{number}/requested_reviewers", "--jq", REVIEWERS_ARGV_JQ]


# ====================================================================== argv and env

class ArgvTests(SourceTestCase):
    def test_exact_search_argvs_env_and_kwargs(self):
        self.assertEqual(self.source.refresh(), 2)
        kwargs = dict(shell=False, timeout=20, stdin=subprocess.DEVNULL, capture_output=True,
                      env={"PATH": "/usr/bin:/bin", "HOME": HOME})
        self.assertEqual(self.run.call_args_list, [
            mock.call([GH, "search", "prs", "user-review-requested:@me", "--state", "open", "--limit", "100",
                       "--json", "url,title,author,createdAt",
                       "--jq", "[.[] | {u: .url, t: .title[0:120], a: .author.login, c: .createdAt}]"], **kwargs),
            mock.call([GH, "search", "prs", "review-requested:@me", "--state", "open", "--limit", "100",
                       "--json", "url,title,author,createdAt",
                       "--jq", "[.[] | {u: .url, t: .title[0:120], a: .author.login, c: .createdAt}]"], **kwargs),
        ])
        self.assertEqual(self.source.search_argv(), DIRECT_ARGV)

    def test_gh_gets_your_token_when_you_sign_in_with_one(self):
        with mock.patch.dict(os.environ, {"GH_TOKEN": "t0ken"}):
            source = ReviewSource(run=self.run, clock_ms=self.clock, gh_path=GH, home=HOME)
        source.refresh()
        self.assertEqual(self.run.call_args.kwargs["env"], {"PATH": "/usr/bin:/bin", "HOME": HOME, "GH_TOKEN": "t0ken"})
        self.assertEqual(self.source.search_argv(reviews.SEARCH_QUERY_BROAD), BROAD_ARGV)
        for argv in SEARCH_ARGVS:
            self.assertEqual(argv[-1], SEARCH_JQ)
            self.assertEqual(argv[-3], reviews.SEARCH_FIELDS)

    def test_the_search_argv_takes_only_its_two_constant_queries(self):
        for query in ("is:open", "review-requested:someone", "user-review-requested:@me ", "--web", "", None,
                      "author:@me"):
            with self.subTest(query=query):
                with self.assertRaises(ValueError):
                    self.source.search_argv(query)
        self.assertEqual(reviews.SEARCH_QUERIES, ("user-review-requested:@me", "review-requested:@me"))

    def test_exact_reviewers_argv_env_and_kwargs(self):
        self.answers()
        self.source.refresh([URL1])
        argv = [c.args[0] for c in self.run.call_args_list if c.args[0][1] != "search"]
        self.assertEqual(argv, [[GH, "api", "repos/Acme-DataTeam/wonderful-things-core/pulls/532/"
                                            "requested_reviewers", "--jq", REVIEWERS_JQ]])
        self.assertEqual(self.run.call_args.kwargs, dict(shell=False, timeout=20, stdin=subprocess.DEVNULL,
                                                         capture_output=True, env=SEARCH_ENV))

    def test_every_argv_element_is_a_plain_string(self):
        self.answers()
        self.source.refresh([URL1, "https://github.com/a.b/c_d-e.f/pull/0042"])
        for call in self.run.call_args_list:
            argv = call.args[0]
            self.assertTrue(all(type(a) is str for a in argv), argv)
            self.assertEqual(argv[0], GH)
        api = [c.args[0] for c in self.run.call_args_list if c.args[0][1] == "api"]
        self.assertEqual(api[-1], self.reviewers_argv("a.b", "c_d-e.f", 42))

    def test_a_direct_visitor_is_never_asked_about(self):
        """Only a team visitor's PR is asked about, and only to name its teams."""
        self.answers(search=search_out(row(url=URL1), row(url=URL3)))
        self.source.refresh()
        self.assertEqual(self.argvs(), SEARCH_ARGVS)
        self.clock.t += SEARCH_RECHECK_MS
        self.source.refresh()
        self.assertEqual({a[1] for a in self.argvs()}, {"search"})

    def test_a_team_visitors_call_holds_only_the_parts_the_url_rule_accepted(self):
        # The search answer's URL is rebuilt from the three parts parse_pr_url accepted before it is stored, and
        # the reviewers argv is built from those parts again: never the string gh printed, and no title or login.
        hostile_text = "--method=DELETE repos/x/y/pulls/1 {owner}"
        self.answers(broad=search_out(row(url="https://github.com/a.b/c_d-e.f/pull/0042", title=hostile_text,
                                          author=hostile_text)))
        self.source.refresh()
        self.assertEqual(self.argvs(), [*SEARCH_ARGVS, self.reviewers_argv("a.b", "c_d-e.f", 42)])
        for argv in self.argvs():
            # argv[-1] is the constant jq filter, the only element that may hold a brace.
            self.assertFalse(any("DELETE" in a or "{" in a for a in argv[:-1]), argv)

    def test_hostile_urls_in_either_search_answer_never_reach_argv(self):
        hostile = [
            "javascript:alert(1)", "https://github.com/o/r/pull/1/files", "https://github.com/o/r/pull/1\n",
            "https://github.com/o/r/pull/1 --method=DELETE", "https://github.com/o/r/pull/1?x=1",
            "https://github.com/../../pull/1", "https://github.com/o/../pull/1", "https://github.com/./r/pull/1",
            "https://github.com/o/r/pull/0", "https://github.com/ｏ/r/pull/1", "https://github.com/o/r/pull/١٢",
            "https://github.com/{owner}/{repo}/pull/1", "https://github.com.evil.example/o/r/pull/1",
            "http://github.com/o/r/pull/1", "pr:0123456789abcdef", "", None, 532, ["x"], {"u": URL1},
        ]
        rows = [row(url=url) for url in hostile]
        self.answers(direct=search_out(*rows), broad=search_out(*rows))
        self.assertEqual(self.source.refresh(), SEARCHES)
        self.assertEqual(self.argvs(), SEARCH_ARGVS)
        self.assertEqual(self.source.snapshot().requests, ())

    def test_hostile_open_pr_urls_never_reach_argv(self):
        hostile = [
            "javascript:alert(1)",
            "https://github.com/o/r/pull/1/files",
            "https://github.com/o/r/pull/1/../../../user",
            "https://github.com/o/r/pull/1\n",
            "https://github.com/o/r/pull/1 --method=DELETE",
            "https://github.com/o/r/pull/1?x=1",
            "https://github.com/../../pull/1",
            "https://github.com/o/../pull/1",
            "https://github.com/./r/pull/1",
            "https://github.com/o/r/pull/abc",
            "https://github.com/o/r/pull/0",
            "https://github.com/ｏ/r/pull/1",
            "https://github.com/o/r/pull/١٢",
            "http://github.com/o/r/pull/1",
            "https://github.com.evil.example/o/r/pull/1",
            "pr:0123456789abcdef",
            "", None, 532, b"https://github.com/o/r/pull/1", ["x"],
        ]
        self.assertEqual(self.source.refresh(hostile), SEARCHES)
        self.assertEqual(self.argvs(), SEARCH_ARGVS)
        self.assertEqual(self.source.snapshot().reviewers, {})

    def test_relative_gh_path_refused(self):
        for bad in ("gh", "bin/gh", ""):
            with self.assertRaises(ValueError):
                ReviewSource(run=self.run, clock_ms=self.clock, gh_path=bad, home=HOME)

    def test_default_home_is_the_user_home(self):
        source = ReviewSource(run=self.run, clock_ms=self.clock, gh_path=GH)
        source.refresh()
        self.assertEqual(self.run.call_args.kwargs["env"], {"PATH": "/usr/bin:/bin", "HOME": str(Path.home())})


# ====================================================================== parsing

class SearchParseTests(unittest.TestCase):
    def test_one_request(self):
        (req,) = parse_review_search(search_out(row()))
        self.assertEqual(req, ReviewRequest(id=review_id(URL1), number=532, owner="Acme-DataTeam",
                                            repo="wonderful-things-core", url=URL1, title="Fix the funnel",
                                            author="sam", waiting_since=OPENED1_MS))
        self.assertRegex(req.id, r"^pr:[0-9a-f]{16}\Z")

    def test_empty_answer(self):
        for out in (b"[]", b"[]\n", "[]"):
            self.assertEqual(parse_review_search(out), ())

    def test_longest_wait_first_and_no_time_last(self):
        rows = [row(url=URL2, created=OPENED2), row(url=URL3, created=None), row(url=URL1, created=OPENED1)]
        self.assertEqual([r.url for r in parse_review_search(search_out(*rows))], [URL1, URL2, URL3])

    def test_duplicate_urls_count_once(self):
        rows = [row(url=URL1), row(url="https://github.com/Acme-DataTeam/wonderful-things-core/pull/0532")]
        self.assertEqual([r.url for r in parse_review_search(search_out(*rows))], [URL1])

    def test_urls_are_rebuilt_from_the_parts_not_echoed(self):
        (req,) = parse_review_search(search_out(row(url="https://github.com/o/r/pull/0042")))
        self.assertEqual(req.url, "https://github.com/o/r/pull/42")
        self.assertEqual((req.owner, req.repo, req.number), ("o", "r", 42))
        self.assertEqual(req.id, review_id("https://github.com/o/r/pull/42"))

    def test_a_url_that_fails_the_regex_is_dropped(self):
        rows = [row(url="https://github.com/o/r/pull/1/files"), row(url=URL1), row(url="javascript:alert(1)"),
                row(url=None), row(url=532), row(url="https://github.com/o/../pull/3")]
        self.assertEqual([r.url for r in parse_review_search(search_out(*rows))], [URL1])

    def test_two_hundred_requests_are_capped_at_fifty(self):
        rows = [row(url=f"https://github.com/o/r/pull/{n}", created="2026-09-%02dT08:00:00Z" % (n % 28 + 1))
                for n in range(1, 201)]
        got = parse_review_search(search_out(*rows))
        self.assertEqual(len(got), MAX_VISITORS)
        self.assertEqual(MAX_VISITORS, 50)
        waits = [r.waiting_since for r in got]
        self.assertEqual(waits, sorted(waits))
        # The longest waits are kept: nothing newer than the 50th oldest survives.
        everyone = sorted(r.waiting_since for r in parse_review_search(search_out(*rows[:])))
        self.assertEqual(waits[0], min(everyone))

    def test_unicode_logins_and_titles_survive_cleaned(self):
        rows = [row(url=URL1, author="dóm-中", title="Réview: café 中文"),
                row(url=URL2, author="a" + BIDI + "b" + NUL, title="x\ty" + LINE_SEP + "z")]
        by_url = {r.url: r for r in parse_review_search(search_out(*rows))}
        first, second = by_url[URL1], by_url[URL2]
        self.assertEqual((first.author, first.title), ("dóm-中", "Réview: café 中文"))
        # Control and format characters are dropped; nothing else is.
        self.assertEqual((second.author, second.title), ("ab", "xyz"))

    def test_long_titles_and_logins_are_truncated(self):
        (req,) = parse_review_search(search_out(row(title="t" * 500, author="a" * 200)))
        self.assertEqual(len(req.title), reviews.TITLE_MAX)
        self.assertEqual(len(req.author), reviews.LOGIN_MAX)

    def test_missing_title_author_and_time(self):
        (req,) = parse_review_search(search_out({"u": URL1}))
        self.assertEqual((req.title, req.author, req.waiting_since), (None, None, None))
        (req,) = parse_review_search(search_out(row(title="", author="   ", created="yesterday")))
        self.assertEqual((req.title, req.author, req.waiting_since), (None, None, None))

    def test_bad_times_lose_the_clock_but_keep_the_visitor(self):
        for value in ("yesterday", "2026-13-01T00:00:00Z", "2026-09-15T10:22:33", "1969-12-31T23:59:59Z",
                      "2026-09-15", "٢026-09-15T10:22:33Z", "2026-09-15T10:22:33Z\n", "", 17, True, None):
            with self.subTest(value=value):
                (req,) = parse_review_search(search_out(row(created=value)))
                self.assertIsNone(req.waiting_since)
        (req,) = parse_review_search(search_out(row(created="2026-09-12T10:30:00+01:00")))
        self.assertEqual(req.waiting_since, OPENED2_MS)

    def test_malformed_json(self):
        for out in (b"", b"\n", b"not json", b"{}", b'{"u":"x"}', b'"[]"', b"null", b"42", b"[" * 3000,
                    b"\xff\xfe[]", b'[{"u":null}]{"x":1}', b'[{"u":"x"},NaN]', None, 42, 3.5):
            with self.subTest(out=repr(out)[:40]):
                with self.assertRaises(github.BadResponse):
                    parse_review_search(out)

    def test_rows_that_are_not_objects_are_a_bad_answer(self):
        for out in (b'["x"]', b"[1]", b"[null]", b"[[]]"):
            with self.assertRaises(github.BadResponse, msg=out):
                parse_review_search(out)

    def test_oversized_output(self):
        out = search_out(row(), {"u": URL2, "pad": "x" * reviews.SEARCH_OUTPUT_BYTES})
        self.assertGreater(len(out), reviews.SEARCH_OUTPUT_BYTES)
        with self.assertRaises(github.BadResponse):
            parse_review_search(out)

    def test_a_full_answer_at_githubs_own_limits_fits_inside_the_cap(self):
        # The worst case the argv itself allows: 100 rows (--limit), GitHub's longest owner (39), repo (100) and
        # login (39), and a title jq has cut to TITLE_MAX made entirely of characters gh writes as 6-byte escapes
        # (its encoder escapes `<`, `>` and `&`). One requester opening forty such PRs used to fail the whole
        # search closed and freeze the visitor list, since a failed re-check keeps the last answer.
        owner, repo = "o" * 39, "r" * 100
        rows = [row(url=f"https://github.com/{owner}/{repo}/pull/{9_999_999_000 + n}", title="<" * reviews.TITLE_MAX,
                    author="a" * 39, created="2026-09-10T08:00:00.123456+01:00") for n in range(100)]
        out = json.dumps(rows).replace("<", "\\u003c").encode()
        self.assertEqual(out.count(b"\\u003c"), 100 * reviews.TITLE_MAX)
        self.assertLess(len(out), reviews.SEARCH_OUTPUT_BYTES)
        found = parse_review_search(out)
        self.assertEqual(len(found), MAX_VISITORS)
        self.assertEqual(found[0].title, "<" * reviews.TITLE_MAX)

    def test_jq_cuts_the_title_at_the_length_that_is_kept(self):
        # Cut inside jq, so gh's output is bounded before the cap applies; the same length, so nothing jq keeps is
        # then thrown away.
        self.assertIn(f".title[0:{reviews.TITLE_MAX}]", SEARCH_JQ)

    def test_two_hundred_requests_fit_inside_the_cap(self):
        rows = [row(url=f"https://github.com/Acme-DataTeam/wonderful-things-core/pull/{n}",
                    title="Refine the marketing explore's aggregate awareness " + "x" * 40, author="colleague")
                for n in range(1, 201)]
        out = search_out(*rows)
        self.assertLess(len(out), reviews.SEARCH_OUTPUT_BYTES)
        self.assertEqual(len(parse_review_search(out)), MAX_VISITORS)


class ReviewersParseTests(unittest.TestCase):
    def test_users_then_teams(self):
        self.assertEqual(parse_reviewers(reviewers_out(["sam", "robin"], ["web-platform"])),
                         ("sam", "robin", "web-platform"))

    def test_nobody_waiting(self):
        self.assertEqual(parse_reviewers(reviewers_out()), ())

    def test_duplicates_and_junk_dropped(self):
        out = reviewers_out(["sam", "sam", None, 7, "", "  ", "a" + NUL + "b"], ["sam"])
        self.assertEqual(parse_reviewers(out), ("sam", "ab"))

    def test_capped(self):
        out = reviewers_out([f"user{n}" for n in range(30)])
        self.assertEqual(len(parse_reviewers(out)), MAX_REVIEWERS)

    def test_malformed(self):
        for out in (b"", b"[]", b'{"users":[]}', b'{"teams":[]}', b'{"users":"sam","teams":[]}',
                    b'{"users":{},"teams":[]}', b"not json", None):
            with self.subTest(out=repr(out)[:30]):
                with self.assertRaises(github.BadResponse):
                    parse_reviewers(out)

    def test_extra_keys_ignored_and_oversized_refused(self):
        self.assertEqual(parse_reviewers(b'{"users":[],"teams":[],"extra":1}'), ())
        with self.assertRaises(github.BadResponse):
            parse_reviewers(b'{"users":[],"teams":[],"pad":"' + b"x" * 5000 + b'"}')

    def test_names_and_teams_are_answered_apart(self):
        names, teams = parse_requested_reviewers(reviewers_out(["sam"], ["web-platform", "bad slug", "x" * 300]))
        self.assertEqual(teams, ("web-platform", "x" * TEAM_MAX))
        self.assertEqual(names, ("sam", "web-platform", "x" * TEAM_MAX))
        self.assertEqual(parse_requested_reviewers(reviewers_out(["sam"])), (("sam",), ()))
        # A team that fails the slug rule is left out of the "waiting on" names as well: one rule for every slug.
        self.assertEqual(parse_reviewers(reviewers_out([], ["a/b", "ok"])), ("ok",))


class TeamSlugTests(unittest.TestCase):
    """Team slugs are text other people chose: GitHub's slug characters only, capped in length and number."""

    def test_normal_slugs_kept_in_order_and_distinct(self):
        self.assertEqual(team_slugs(["web-platform", "platform_eng", "Web-Platform", "web-platform", "a1"]),
                         ("web-platform", "platform_eng", "Web-Platform", "a1"))

    def test_empty_and_missing(self):
        for values in ([], (), None, "web-platform", {"slug": "x"}, 7, b"web-platform"):
            with self.subTest(values=values):
                self.assertEqual(team_slugs(values), ())
        self.assertEqual(team_slugs(["", None, 7, [], {}, True]), ())

    def test_hostile_slugs_are_dropped_not_cleaned(self):
        hostile = ["web platform", " web-platform", "web-platform ", "web/platform", "../admin", "a\\b",
                   "data.product", "org/team", "@data", "data&product", "<script>alert(1)</script>", "dätä",
                   "ｄata", "中文", "data" + BIDI + "product", "data" + NUL, "data\nproduct", "data" + LINE_SEP,
                   "data​product", "x" * 300 + " "]
        for slug in hostile:
            with self.subTest(slug=slug[:20]):
                self.assertEqual(team_slugs([slug]), ())
        self.assertEqual(team_slugs(hostile + ["ok"]), ("ok",))

    def test_a_long_slug_is_cut_and_the_list_is_capped(self):
        self.assertEqual(team_slugs(["x" * 300]), ("x" * TEAM_MAX,))
        # Two long slugs that agree on their first TEAM_MAX characters are one name on the page.
        self.assertEqual(team_slugs(["x" * 300, "x" * 299 + "y"]), ("x" * TEAM_MAX,))
        self.assertEqual(team_slugs([f"team-{n}" for n in range(40)]), tuple(f"team-{n}" for n in range(MAX_TEAMS)))
        self.assertEqual((TEAM_MAX, MAX_TEAMS), (40, 10))


class CombineTests(unittest.TestCase):
    def test_every_url_either_search_lists_and_you_exactly_when_the_direct_one_does(self):
        direct = search_rows(search_out(row(url=URL1), row(url=URL3, title="direct copy")))
        broad = search_rows(search_out(row(url=URL1, title="broad copy"), row(url=URL2)))
        got = {r.url: (r.via, r.title, r.teams) for r in combine_searches(direct, broad)}
        self.assertEqual(got, {URL1: ("you", "Fix the funnel", ()), URL2: ("team", "Fix the funnel", ()),
                               URL3: ("you", "direct copy", ())})

    def test_search_rows_are_not_capped_before_the_union(self):
        rows = [row(url=f"https://github.com/o/r/pull/{n}") for n in range(1, 201)]
        self.assertEqual(len(search_rows(search_out(*rows))), 200)

    def test_past_the_cap_the_requests_that_name_him_keep_their_place(self):
        # A CODEOWNERS team can queue a whole repo. Kept by wait alone, eighty older team requests would push out
        # the one that asks him by name.
        team = [row(url=f"https://github.com/o/r/pull/{n}", created=OPENED1) for n in range(1, 81)]
        broad = search_rows(search_out(*team, row(url=URL1, created=OPENED2)))
        direct = search_rows(search_out(row(url=URL1, created=OPENED2)))
        kept = combine_searches(direct, broad)
        self.assertEqual(len(kept), MAX_VISITORS)
        self.assertEqual([r.url for r in kept if r.via == "you"], [URL1])
        self.assertEqual(kept[-1].url, URL1, "still in queue order: the newest wait stands last")
        waits = [(r.waiting_since, r.id) for r in kept]
        self.assertEqual(waits, sorted(waits))


# ====================================================================== resolving

class ResolveTests(SourceTestCase):
    def test_a_normal_cycle(self):
        self.answers(search=search_out(row(url=URL1), row(url=URL3, created=OPENED2)),
                     reviewers=reviewers_out(["robin"], ["web-platform"]))
        self.assertEqual(self.source.refresh([URL2]), SEARCHES + 1)
        snap = self.source.snapshot()
        self.assertEqual([r.url for r in snap.requests], [URL1, URL3])
        self.assertEqual({r.via for r in snap.requests}, {"you"})
        self.assertEqual(snap.reviewers, {URL2: ("robin", "web-platform")})
        self.assertEqual(self.source.health(), {"enabled": True, "known": 3, "failed": 0, "lastError": None,
                                                "lastCheckedAt": T0})
        self.assertEqual(self.source.url_for(review_id(URL1)), URL1)

    def test_snapshot_is_a_review_snapshot_and_a_copy(self):
        self.answers(search=search_out(row()))
        self.source.refresh([URL2])
        snap = self.source.snapshot()
        self.assertIsInstance(snap, ReviewSnapshot)
        snap.reviewers.clear()
        self.assertEqual(set(self.source.snapshot().reviewers), {URL2})

    def test_nothing_else_from_the_answer_is_kept(self):
        self.run.side_effect = lambda argv, **kw: done(
            search_out({"u": URL1, "t": "title", "a": "sam", "c": OPENED1, "body": "secret body"})
            if argv[1] == "search" else b'{"users":[],"teams":[],"note":"secret note"}', stderr=b"secret stderr")
        self.source.refresh([URL2])
        dumped = repr(self.source.snapshot()) + repr(self.source.health()) + repr(vars(self.source))
        self.assertNotIn("secret", dumped)

    def test_url_for_only_answers_for_a_current_visitor(self):
        self.answers(search=search_out(row(url=URL1)))
        self.source.refresh()
        self.assertIsNone(self.source.url_for(review_id(URL3)))
        for bad in (None, 17, b"pr:0", "pr:" + "0" * 16, "", ["x"]):
            self.assertIsNone(self.source.url_for(bad))
        self.answers(search=search_out(row(url=URL3)))
        self.clock.t += SEARCH_RECHECK_MS
        self.source.refresh()
        self.assertIsNone(self.source.url_for(review_id(URL1)), "a stale id keeps no URL")
        self.assertEqual(self.source.url_for(review_id(URL3)), URL3)

    def test_the_searches_are_rechecked_together_on_their_own_interval(self):
        self.assertEqual(self.source.refresh(), SEARCHES)
        self.clock.t += SEARCH_RECHECK_MS - 1
        self.assertEqual(self.source.refresh(), 0)
        self.clock.t += 1
        self.assertEqual(self.source.refresh(), SEARCHES)
        self.assertEqual(self.argvs(), SEARCH_ARGVS * 2)
        self.assertEqual(SEARCH_RECHECK_MS, 4 * MINUTE)

    def test_reviewers_are_rechecked_on_their_own_interval(self):
        self.answers()
        self.assertEqual(self.source.refresh([URL1]), SEARCHES + 1)
        self.clock.t += SEARCH_RECHECK_MS
        self.assertEqual(self.source.refresh([URL1]), SEARCHES, "only the searches were due")
        self.clock.t = T0 + REVIEWERS_RECHECK_MS
        self.assertEqual(self.source.refresh([URL1]), SEARCHES + 1)
        self.assertEqual(REVIEWERS_RECHECK_MS, 20 * MINUTE)

    def test_a_new_open_pr_is_asked_about_at_once(self):
        self.answers()
        self.source.refresh([URL1])
        self.clock.t += MINUTE
        self.assertEqual(self.source.refresh([URL1, URL2]), 1)
        self.assertEqual(self.run.call_args.args[0], self.reviewers_argv("Acme-DataTeam", "wonderful-things-core",
                                                                        533))

    def test_urls_no_longer_passed_are_forgotten(self):
        self.answers(reviewers=reviewers_out(["sam"]))
        self.source.refresh([URL1, URL2])
        self.assertEqual(set(self.source.snapshot().reviewers), {URL1, URL2})
        self.assertEqual(self.source.health()["known"], 2)
        self.source.refresh([URL1])
        self.assertEqual(set(self.source.snapshot().reviewers), {URL1})
        self.source.refresh([])
        self.assertEqual(self.source.snapshot().reviewers, {})
        self.assertEqual(self.source.health()["known"], 0)

    def test_empty_reviewers_are_kept_as_an_answer(self):
        self.answers()
        self.source.refresh([URL1])
        self.assertEqual(self.source.snapshot().reviewers, {URL1: ()})

    def test_reviewer_calls_are_capped_and_the_rest_follow(self):
        self.answers()
        urls = [f"https://github.com/o/r/pull/{n}" for n in range(1, 30)]
        self.assertEqual(self.source.refresh(urls), SEARCHES + MAX_REVIEWER_CALLS_PER_CYCLE)
        self.clock.t += MINUTE
        self.assertEqual(self.source.refresh(urls), 29 - MAX_REVIEWER_CALLS_PER_CYCLE)
        self.assertEqual(len(self.source.snapshot().reviewers), 29)
        self.assertEqual(MAX_REVIEWER_CALLS_PER_CYCLE, 20)
        self.assertEqual(MAX_CALLS_PER_CYCLE, 22)

    def test_max_calls_caps_the_whole_cycle(self):
        self.answers()
        urls = [f"https://github.com/o/r/pull/{n}" for n in range(1, 10)]
        self.assertEqual(self.source.refresh(urls, max_calls=3), 3)
        self.assertEqual(self.source.refresh(urls, max_calls=0), 0)

    def test_accepts_any_iterable(self):
        self.answers()
        self.assertEqual(self.source.refresh(u for u in (URL1, URL2)), SEARCHES + 2)


class TwoSearchTests(SourceTestCase):
    """Both searches every cycle, told apart: "you" when the direct one lists the PR, "team" otherwise."""

    def vias(self) -> dict[str, str]:
        return {r.url: r.via for r in self.source.snapshot().requests}

    def test_both_searches_normal(self):
        self.answers(direct=search_out(row(url=URL1)),
                     broad=search_out(row(url=URL1), row(url=URL2, created=OPENED2)),
                     reviewers=reviewers_out(["robin"], ["web-platform"]))
        self.assertEqual(self.source.refresh(), SEARCHES + 1)
        self.assertEqual(self.argvs(), [*SEARCH_ARGVS,
                                        self.reviewers_argv("Acme-DataTeam", "wonderful-things-core", 533)])
        snap = self.source.snapshot()
        self.assertEqual([(r.url, r.via, r.teams) for r in snap.requests],
                         [(URL1, "you", ()), (URL2, "team", ("web-platform",))])
        self.assertEqual(snap.reviewers, {}, "a team visitor's reviewers are not a waiting-on line")
        self.assertEqual(self.source.url_for(review_id(URL2)), URL2)
        self.assertEqual(self.source.health(), {"enabled": True, "known": 2, "failed": 0, "lastError": None,
                                                "lastCheckedAt": T0})

    def test_charlies_shape_nobody_asks_him_directly_and_eleven_ask_his_team(self):
        urls = [f"https://github.com/Acme-DataTeam/wonderful-things-core/pull/{500 + n}" for n in range(11)]
        self.answers(direct=b"[]", broad=search_out(*(row(url=u) for u in urls)),
                     reviewers=reviewers_out([], ["web-platform"]))
        self.assertEqual(self.source.refresh(), SEARCHES + 11)
        snap = self.source.snapshot()
        self.assertEqual(len(snap.requests), 11)
        self.assertEqual({(r.via, r.teams) for r in snap.requests}, {("team", ("web-platform",))})
        self.assertEqual(sorted(self.asked()), list(range(500, 511)))
        self.assertEqual(snap.reviewers, {})

    def test_a_url_only_the_direct_search_lists_is_still_a_you_visitor(self):
        self.answers(direct=search_out(row(url=URL3)), broad=search_out(row(url=URL1)))
        self.assertEqual(self.source.refresh(), SEARCHES + 1)
        self.assertEqual(self.vias(), {URL1: "team", URL3: "you"})
        self.assertEqual(self.asked(), [532], "only the team visitor is asked about")

    def test_duplicate_urls_are_one_visitor_and_one_call(self):
        padded = "https://github.com/Acme-DataTeam/wonderful-things-core/pull/0532"
        self.answers(direct=search_out(row(url=URL1), row(url=padded), row(url=URL1)),
                     broad=search_out(row(url=padded), row(url=URL2), row(url=URL2), row(url=URL1)))
        self.assertEqual(self.source.refresh(), SEARCHES + 1)
        self.assertEqual(self.vias(), {URL1: "you", URL2: "team"})
        self.assertEqual(len(self.source.snapshot().requests), 2)
        self.assertEqual(self.asked(), [533])

    def test_both_empty(self):
        self.answers(direct=b"[]", broad=b"[]")
        self.assertEqual(self.source.refresh(), SEARCHES)
        self.assertEqual(self.source.snapshot(), ReviewSnapshot())

    def test_a_request_that_turns_direct_is_reclassified_on_the_next_good_pair(self):
        self.answers(direct=b"[]", broad=search_out(row(url=URL1)), reviewers=reviewers_out([], ["web-platform"]))
        self.source.refresh()
        self.assertEqual(self.source.snapshot().requests[0].teams, ("web-platform",))
        self.answers(direct=search_out(row(url=URL1)), broad=search_out(row(url=URL1)))
        self.clock.t += SEARCH_RECHECK_MS
        self.assertEqual(self.source.refresh(), SEARCHES)
        (req,) = self.source.snapshot().requests
        self.assertEqual((req.via, req.teams), ("you", ()))

    def test_a_partial_failure_before_any_good_pair_shows_nobody(self):
        self.answers(direct=search_out(row(url=URL1)), broad=done(code=1))
        self.assertEqual(self.source.refresh(), SEARCHES)
        self.assertEqual(self.source.snapshot().requests, ())
        self.assertIsNone(self.source.url_for(review_id(URL1)))
        self.assertEqual(self.source.health()["lastError"], "exit 1")


class PartialFailureTests(SourceTestCase):
    """The two searches are one answer: when either fails, the last good pair stands and nobody is reclassified."""

    def setUp(self):
        super().setUp()
        self.answers(direct=search_out(row(url=URL1)), broad=search_out(row(url=URL1), row(url=URL2)),
                     reviewers=reviewers_out([], ["web-platform"]))
        self.source.refresh()
        self.good = self.source.snapshot()
        self.assertEqual({r.url: (r.via, r.teams) for r in self.good.requests},
                         {URL1: ("you", ()), URL2: ("team", ("web-platform",))})
        self.run.reset_mock()
        self.clock.t += SEARCH_RECHECK_MS

    def vias(self) -> dict[str, str]:
        return {r.url: r.via for r in self.source.snapshot().requests}

    def test_the_direct_search_failing_skips_the_broad_one_and_keeps_the_last_good_pair(self):
        self.answers(direct=done(code=1), broad=search_out(row(url=URL2)))
        self.assertEqual(self.source.refresh(), 1)
        self.assertEqual(self.argvs(), [DIRECT_ARGV], "the broad answer could not be used, so it is not asked")
        self.assertEqual(self.source.snapshot(), self.good)
        health = self.source.health()
        self.assertEqual((health["failed"], health["lastError"]), (1, "exit 1"))

    def test_the_broad_search_failing_keeps_the_last_good_pair(self):
        # Published alone, the direct answer would have made URL2 "you" and sent URL1 away.
        self.answers(direct=search_out(row(url=URL2)), broad=done(b"garbage"))
        self.assertEqual(self.source.refresh(), SEARCHES)
        self.assertEqual(self.source.snapshot(), self.good)
        self.assertEqual(self.source.url_for(review_id(URL1)), URL1)
        health = self.source.health()
        self.assertEqual((health["failed"], health["lastError"], health["lastCheckedAt"]),
                         (1, "BadResponse", T0 + SEARCH_RECHECK_MS))

    def test_both_are_asked_again_together_after_the_back_off(self):
        self.answers(direct=search_out(row(url=URL2)), broad=done(code=1))
        self.source.refresh()
        self.clock.t += SEARCH_RECHECK_MS
        self.assertEqual(self.source.refresh(), 0, "the half that worked is not asked again on its own")
        self.clock.t = T0 + SEARCH_RECHECK_MS + FAILURE_BACKOFF_MS
        self.answers(direct=search_out(row(url=URL2)), broad=search_out(row(url=URL2)))
        self.run.reset_mock()
        self.assertEqual(self.source.refresh(), SEARCHES)
        self.assertEqual(self.argvs(), SEARCH_ARGVS)
        self.assertEqual(self.vias(), {URL2: "you"})
        self.assertEqual(self.source.health()["failed"], 0)

    def test_both_searches_failing(self):
        self.answers(direct=search_out(row(url=URL2)), broad=done(code=1))
        self.source.refresh()
        self.clock.t = T0 + SEARCH_RECHECK_MS + FAILURE_BACKOFF_MS
        self.answers(direct=done(code=4), broad=done(code=4))
        self.assertEqual(self.source.refresh(), 1)
        self.assertEqual(self.source.snapshot(), self.good)
        health = self.source.health()
        self.assertEqual((health["failed"], health["lastError"]), (2, "gh not signed in"))


class TeamVisitorTests(SourceTestCase):
    """A team visitor names the teams its PR asks, through the reviewers call, inside the same cap and cache."""

    @staticmethod
    def urls(n: int, owner: str = "o") -> list[str]:
        return [f"https://github.com/{owner}/r/pull/{k}" for k in range(1, n + 1)]

    def test_teams_come_from_that_prs_requested_reviewers(self):
        by_number = {1: reviewers_out(["sam"], ["web-platform", "platform"]), 2: reviewers_out(["robin"], [])}
        self.answers(broad=search_out(*(row(url=u) for u in self.urls(2))),
                     reviewers=lambda argv: by_number[int(argv[2].split("/pulls/")[1].split("/")[0])])
        self.source.refresh()
        self.assertEqual({r.number: r.teams for r in self.source.snapshot().requests},
                         {1: ("web-platform", "platform"), 2: ()})

    def test_teams_are_unknown_until_github_answers(self):
        self.answers(broad=search_out(row(url=URL1)), reviewers=done(code=1))
        self.source.refresh()
        (req,) = self.source.snapshot().requests
        self.assertEqual((req.via, req.teams), ("team", ()))
        self.assertEqual(self.source.health()["failed"], 1)

    def test_a_failed_recheck_keeps_the_teams_last_named(self):
        self.answers(broad=search_out(row(url=URL1)), reviewers=reviewers_out([], ["web-platform"]))
        self.source.refresh()
        self.clock.t += REVIEWERS_RECHECK_MS
        self.answers(broad=search_out(row(url=URL1)), reviewers=done(code=1))
        self.assertEqual(self.source.refresh(), SEARCHES + 1)
        self.assertEqual(self.source.snapshot().requests[0].teams, ("web-platform",))

    def test_hostile_team_slugs_never_reach_a_request(self):
        self.answers(broad=search_out(row(url=URL1)),
                     reviewers=reviewers_out(["sam"], ["web platform", "a/b", "x" * 300, "dätä", "", None,
                                                       "<b>", "ok_team"]))
        self.source.refresh()
        self.assertEqual(self.source.snapshot().requests[0].teams, ("x" * TEAM_MAX, "ok_team"))

    def test_a_team_visitor_that_leaves_is_forgotten(self):
        self.answers(broad=search_out(row(url=URL1)), reviewers=reviewers_out([], ["web-platform"]))
        self.source.refresh()
        self.answers(broad=b"[]")
        self.clock.t += SEARCH_RECHECK_MS
        self.source.refresh()
        self.assertEqual(self.source.snapshot().requests, ())
        # Back again a cycle later: its cache went with it, so it is asked about at once, not 20 min on.
        self.answers(broad=search_out(row(url=URL1)), reviewers=reviewers_out([], ["platform"]))
        self.clock.t += SEARCH_RECHECK_MS
        self.assertEqual(self.source.refresh(), SEARCHES + 1)
        self.assertEqual(self.source.snapshot().requests[0].teams, ("platform",))

    def test_his_own_pr_listed_as_a_team_visitor_is_asked_about_once(self):
        self.answers(broad=search_out(row(url=URL1)), reviewers=reviewers_out(["robin"], ["web-platform"]))
        self.assertEqual(self.source.refresh([URL1]), SEARCHES + 1)
        snap = self.source.snapshot()
        self.assertEqual(snap.reviewers, {URL1: ("robin", "web-platform")})
        self.assertEqual(snap.requests[0].teams, ("web-platform",))

    def test_the_call_cap_across_fifty_team_visitors(self):
        rows = [row(url=u, created="2026-09-%02dT08:00:00Z" % (k % 28 + 1)) for k, u in enumerate(self.urls(60))]
        self.answers(direct=b"[]", broad=search_out(*rows), reviewers=reviewers_out([], ["web-platform"]))
        made = []
        for _ in range(5):
            made.append(self.source.refresh())
            self.clock.t += 5 * MINUTE
        # 5 min apart like the server's cycles: both searches every cycle, and at most twenty reviewer calls.
        self.assertEqual(made, [SEARCHES + 20, SEARCHES + 20, SEARCHES + 10, SEARCHES, SEARCHES + 20])
        self.assertLessEqual(max(made), MAX_CALLS_PER_CYCLE)
        snap = self.source.snapshot()
        self.assertEqual(len(snap.requests), MAX_VISITORS)
        self.assertEqual({r.teams for r in snap.requests}, {("web-platform",)})
        first_round = self.asked()[:MAX_VISITORS]
        self.assertEqual(sorted(first_round), sorted(r.number for r in snap.requests), "each visitor asked once")

    def test_at_both_caps_nothing_waits_for_ever(self):
        # 50 team visitors and 60 of his own PRs are 110 targets against 80 calls every 20 min. Re-checked in list
        # order, the head's re-checks took every call and 20 of his own PRs were never asked at all.
        rows = [row(url=u) for u in self.urls(60)]
        self.answers(direct=b"[]", broad=search_out(*rows), reviewers=reviewers_out(["sam"], ["web-platform"]))
        own = self.urls(60, owner="me")
        for _ in range(6):
            self.assertEqual(self.source.refresh(own), MAX_CALLS_PER_CYCLE)
            self.clock.t += 5 * MINUTE
        snap = self.source.snapshot()
        self.assertEqual(len(snap.reviewers), 60)
        self.assertEqual(sum(bool(r.teams) for r in snap.requests), MAX_VISITORS)
        self.run.reset_mock()
        for _ in range(24):
            self.source.refresh(own)
            self.clock.t += 5 * MINUTE
        asked = collections.Counter(a[2] for a in self.argvs() if a[1] == "api")
        self.assertEqual(len(asked), MAX_VISITORS + 60)
        self.assertEqual((min(asked.values()), max(asked.values())), (4, 5), "every target takes its turn")

    def test_team_visitors_and_his_own_prs_take_turns_under_the_cap(self):
        self.answers(broad=search_out(*(row(url=u) for u in self.urls(30))))
        own = self.urls(30, owner="me")
        self.assertEqual(self.source.refresh(own), SEARCHES + MAX_REVIEWER_CALLS_PER_CYCLE)
        paths = [a[2] for a in self.argvs() if a[1] == "api"]
        self.assertEqual((sum("repos/o/" in p for p in paths), sum("repos/me/" in p for p in paths)), (10, 10))
        self.assertEqual(len(self.source.snapshot().reviewers), 10)


class FailureTests(SourceTestCase):
    def test_non_zero_exit(self):
        self.run.return_value = done(b"", code=1, stderr=b"gh: Not Found (HTTP 404)")
        self.assertEqual(self.source.refresh(), 1)
        self.assertEqual(self.source.snapshot().requests, ())
        self.assertEqual(self.source.health(), {"enabled": True, "known": 0, "failed": 1, "lastError": "exit 1",
                                                "lastCheckedAt": None})

    def test_error_names_are_class_names_exit_codes_or_http_statuses_only(self):
        cases = [
            (subprocess.TimeoutExpired([GH], 20, output=b"secret out", stderr=b"secret err"), "TimeoutExpired"),
            (FileNotFoundError(2, "No such file", "/secret/path"), "FileNotFoundError"),
            (PermissionError(13, "denied"), "PermissionError"),
            (RuntimeError("secret message"), "RuntimeError"),
            (done(b"secret", code=4, stderr=b"secret"), "gh not signed in"),
            (done(b'{"message":"secret credentials","status":"401"}', code=1), "HTTP 401"),
            (done(b"secret", code=-9), "exit -9"),
            (done(b"secret text"), "BadResponse"),
            (subprocess.CompletedProcess([], None, stdout=b"[]"), "BadResponse"),
        ]
        for outcome, expected in cases:
            with self.subTest(expected=expected):
                run = mock.Mock()
                if isinstance(outcome, BaseException):
                    run.side_effect = outcome
                else:
                    run.return_value = outcome
                source = ReviewSource(run=run, clock_ms=self.clock, gh_path=GH, home=HOME)
                self.assertEqual(source.refresh(), 1)
                health = source.health()
                self.assertEqual((health["lastError"], health["failed"]), (expected, 1))
                self.assertNotIn("secret", repr(health) + repr(source.snapshot()))

    def test_rate_limit_output(self):
        body = b'{"message":"API rate limit exceeded for user ID 1.","documentation_url":"https://docs.github.com"}'
        self.run.return_value = done(body, code=1, stderr=b"gh: API rate limit exceeded")
        self.assertEqual(self.source.refresh(), 1)
        self.assertEqual(self.source.health()["lastError"], "exit 1")
        # The same body with a zero exit is a bad answer, not an empty result.
        self.run.return_value = done(body)
        self.clock.t += FAILURE_BACKOFF_MS
        self.assertEqual(self.source.refresh(), 1)
        self.assertEqual(self.source.health()["lastError"], "BadResponse")
        self.assertEqual(self.source.snapshot().requests, ())
        self.assertNotIn("rate limit", repr(vars(self.source)))

    def test_a_failed_search_keeps_the_last_answer(self):
        self.answers(search=search_out(row()))
        self.source.refresh()
        self.clock.t += SEARCH_RECHECK_MS
        self.run.side_effect = None
        self.run.return_value = done(b"garbage")
        self.assertEqual(self.source.refresh(), 1)
        self.assertEqual([r.url for r in self.source.snapshot().requests], [URL1])
        health = self.source.health()
        self.assertEqual((health["known"], health["failed"], health["lastError"]), (1, 1, "BadResponse"))
        self.assertEqual(health["lastCheckedAt"], T0)

    def test_failure_backs_off_fifteen_minutes(self):
        self.run.return_value = done(code=1)
        self.assertEqual(self.source.refresh(), 1)
        self.clock.t += FAILURE_BACKOFF_MS - 1
        self.assertEqual(self.source.refresh(), 0)
        self.clock.t += 1
        self.run.return_value = done(search_out(row()))
        self.assertEqual(self.source.refresh(), SEARCHES)
        self.assertEqual(self.source.health(), {"enabled": True, "known": 1, "failed": 0, "lastError": None,
                                                "lastCheckedAt": T0 + FAILURE_BACKOFF_MS})

    def test_timeout(self):
        self.run.side_effect = subprocess.TimeoutExpired([GH], 20)
        self.assertEqual(self.source.refresh([URL1]), 2)
        self.assertEqual(self.source.health()["failed"], 2)
        self.assertEqual(self.source.health()["lastError"], "TimeoutExpired")
        self.clock.t += MINUTE
        self.assertEqual(self.source.refresh([URL1]), 0)

    def test_a_failing_reviewer_url_does_not_stop_the_search(self):
        self.run.side_effect = lambda argv, **kw: (done(search_out(row())) if argv[1] == "search"
                                                   else done(code=1))
        self.source.refresh([URL1])
        self.assertEqual(len(self.source.snapshot().requests), 1)
        self.assertEqual(self.source.health()["failed"], 1)


class OutageTests(SourceTestCase):
    """A GitHub, proxy or sign-in outage must not keep gh running all day."""

    URLS = [f"https://github.com/o/r/pull/{n}" for n in range(1, 43)]

    def simulate(self, minutes: int, *, call_seconds: int = 0, failing=lambda argv: True) -> int:
        def call(argv, **kw):
            self.clock.t += call_seconds * 1000
            if failing(argv):
                return done(code=1)
            return done(search_out(row()) if argv[1] == "search" else reviewers_out(["sam"]))

        self.run.side_effect = call
        end = self.clock.t + minutes * MINUTE
        calls = 0
        while self.clock.t < end:
            calls += self.source.refresh(self.URLS)
            self.clock.t += MINUTE
        return calls

    def test_a_cycle_stops_after_three_failures_in_a_row(self):
        self.run.return_value = done(code=4)
        self.assertEqual(self.source.refresh(self.URLS), 3)
        self.assertEqual(self.source.refresh(self.URLS), 0)
        self.clock.t += PAUSE_MS - 1
        self.assertEqual(self.source.refresh(self.URLS), 0)
        self.clock.t += 1
        self.assertEqual(self.source.refresh(self.URLS), 3)

    def test_failing_team_calls_trip_the_breaker(self):
        team = [f"https://github.com/t/r/pull/{k}" for k in range(1, 11)]
        self.answers(direct=b"[]", broad=search_out(*(row(url=u) for u in team)), reviewers=done(code=1))
        # Both searches worked, so this is no outage: the cycle stops at three failures in a row, with no pause.
        self.assertEqual(self.source.refresh(), SEARCHES + 3)
        self.clock.t += MINUTE
        self.assertEqual(self.source.refresh(), 3)
        # Nothing but failures in that cycle, six in a row: now it is an outage, and it pauses.
        self.clock.t += MINUTE
        self.assertEqual(self.source.refresh(), 0)
        self.clock.t = T0 + MINUTE + PAUSE_MS
        self.assertEqual(self.source.refresh(), SEARCHES + 3)
        self.assertEqual(len(self.source.snapshot().requests), 10)

    def test_a_day_of_outage_with_team_visitors_held_stays_under_fifty_calls(self):
        team = [f"https://github.com/t/r/pull/{k}" for k in range(1, 12)]
        self.answers(direct=b"[]", broad=search_out(*(row(url=u) for u in team)))
        self.assertEqual(self.source.refresh(self.URLS), MAX_CALLS_PER_CYCLE)
        self.clock.t += MINUTE
        self.assertLess(self.simulate(24 * 60), 50)
        snap = self.source.snapshot()
        self.assertEqual((len(snap.requests), {r.via for r in snap.requests}), (11, {"team"}),
                         "a day of failures keeps the last good pair as it was")

    def test_a_day_of_timeouts_stays_under_fifty_calls(self):
        self.assertLess(self.simulate(24 * 60, call_seconds=20), 50)

    def test_a_day_signed_out_stays_under_fifty_calls(self):
        self.assertLess(self.simulate(24 * 60), 50)
        self.assertEqual(self.source.health()["lastError"], "exit 1")

    def test_pause_doubles_to_two_hours_and_a_success_resets_it(self):
        self.run.return_value = done(code=1)
        pauses = []
        self.assertEqual(self.source.refresh(self.URLS), 3)
        for _ in range(6):
            start = self.clock.t
            while True:
                self.clock.t += MINUTE
                made = self.source.refresh(self.URLS)
                if made:
                    break
            self.assertEqual(made, 3)
            pauses.append(-(-(self.clock.t - start) // MINUTE) * MINUTE)
        self.assertEqual(pauses, [PAUSE_MS, 2 * PAUSE_MS, 4 * PAUSE_MS, PAUSE_MAX_MS, PAUSE_MAX_MS, PAUSE_MAX_MS])
        self.answers(search=search_out(row()), reviewers=reviewers_out(["sam"]))
        self.clock.t += PAUSE_MAX_MS
        self.assertEqual(self.source.refresh(self.URLS), SEARCHES + MAX_REVIEWER_CALLS_PER_CYCLE)
        self.assertEqual(self.source.health()["known"], 1 + MAX_REVIEWER_CALLS_PER_CYCLE)
        for _ in range(2):
            self.clock.t += MINUTE
            self.source.refresh(self.URLS)
        self.assertEqual(self.source.health()["failed"], 0)
        self.assertEqual(len(self.source.snapshot().reviewers), len(self.URLS))

    def test_recovers_once_the_outage_ends(self):
        self.simulate(6 * 60)
        self.assertEqual(self.source.health()["known"], 0)
        self.simulate(PAUSE_MAX_MS // MINUTE + 5, failing=lambda argv: False)
        health = self.source.health()
        self.assertEqual((health["failed"], health["lastError"]), (0, None))
        self.assertEqual(len(self.source.snapshot().reviewers), 42)
        self.assertEqual(len(self.source.snapshot().requests), 1)

    def test_dead_urls_first_in_line_do_not_starve_the_rest(self):
        dead = {"1", "2", "3"}
        calls = self.simulate(PAUSE_MS // MINUTE + 1,
                              failing=lambda argv: (argv[1] == "api"
                                                    and argv[2].split("/pulls/")[1].split("/")[0] in dead))
        health = self.source.health()
        self.assertEqual(health["failed"], 3)
        self.assertEqual(len(self.source.snapshot().reviewers), 39)
        self.assertLess(calls, 60)


class DisabledTests(unittest.TestCase):
    def setUp(self):
        no_real_subprocesses(self)

    def test_gh_missing_disables(self):
        run = mock.Mock()
        with tempfile.TemporaryDirectory() as tmp:
            missing = (str(Path(tmp) / "nope"), str(Path(tmp) / "also-nope"))
            with mock.patch.object(github, "GH_CANDIDATES", missing):
                source = ReviewSource(run=run, clock_ms=Clock(), home=HOME)
        self.assertIsNone(source.gh_path)
        self.assertFalse(source.enabled)
        self.assertEqual(source.refresh([URL1]), 0)
        run.assert_not_called()
        self.assertEqual(source.snapshot(), ReviewSnapshot())
        self.assertIsNone(source.url_for(review_id(URL1)))
        self.assertEqual(source.health(), {"enabled": False, "known": 0, "failed": 0,
                                           "lastError": "gh not found", "lastCheckedAt": None})

    def test_gh_candidates_are_shared_with_the_pr_resolver(self):
        self.assertIs(reviews.find_gh, github.find_gh)


class FakePopen:
    """Stands in for subprocess.Popen: records how gh was started and blocks until told to finish or killed."""

    instances: list["FakePopen"] = []

    def __init__(self, argv, **kwargs):
        self.argv, self.kwargs = argv, kwargs
        self.returncode = None
        self.killed = threading.Event()
        self.finish = threading.Event()
        self.started = threading.Event()
        self.stdout = b"[]"
        FakePopen.instances.append(self)
        self.started.set()

    def communicate(self, timeout=None):
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

    def source(self, popen=FakePopen):
        return ReviewSource(clock_ms=self.clock, gh_path=GH, home=HOME, popen=popen)

    def test_exact_argv_env_and_streams(self):
        def instant(argv, **kwargs):
            p = FakePopen(argv, **kwargs)
            p.finish.set()
            return p

        source = self.source(instant)
        self.assertEqual(source.refresh(), SEARCHES)
        self.assertEqual([p.argv for p in FakePopen.instances], SEARCH_ARGVS)
        for p in FakePopen.instances:
            self.assertEqual(p.kwargs, {"shell": False, "stdin": subprocess.DEVNULL, "stdout": subprocess.PIPE,
                                        "stderr": subprocess.DEVNULL, "env": SEARCH_ENV})

    def test_default_popen_is_subprocess_popen_looked_up_at_call_time(self):
        source = ReviewSource(clock_ms=self.clock, gh_path=GH, home=HOME)
        with mock.patch("subprocess.Popen", side_effect=OSError("blocked")) as popen:
            self.assertEqual(source.refresh(), 1)
        popen.assert_called_once()
        self.assertEqual(source.health()["lastError"], "OSError")

    def test_cancel_kills_the_call_in_flight_and_stops_refreshing(self):
        source = self.source()
        worker = threading.Thread(target=source.refresh, args=([URL1],), daemon=True)
        worker.start()
        for _ in range(500):
            if FakePopen.instances:
                break
            threading.Event().wait(0.002)
        (p,) = FakePopen.instances
        self.assertTrue(p.started.wait(2))
        source.cancel()
        worker.join(2)
        self.assertFalse(worker.is_alive(), "refresh kept waiting on a killed gh")
        self.assertTrue(p.killed.is_set())
        self.assertEqual(len(FakePopen.instances), 1, "no second gh after cancel")
        self.assertEqual(source.refresh([URL1]), 0)
        self.assertEqual(len(FakePopen.instances), 1)

    def test_cancel_with_nothing_in_flight_is_harmless(self):
        source = self.source()
        source.cancel()
        source.cancel()
        self.assertEqual(source.refresh(), 0)
        self.assertEqual(FakePopen.instances, [])


class ThreadSafetyTests(SourceTestCase):
    def test_snapshot_and_health_do_not_wait_for_a_call_in_flight(self):
        entered, release = threading.Event(), threading.Event()
        self.answers(search=search_out(row()))
        self.source.refresh()

        def blocking(argv, **kw):
            entered.set()
            release.wait(5)
            return done(search_out(row(url=URL3)))

        self.clock.t += SEARCH_RECHECK_MS
        self.run.side_effect = blocking
        worker = threading.Thread(target=self.source.refresh, daemon=True)
        worker.start()
        self.assertTrue(entered.wait(5))
        try:
            results = {}

            def read():
                results["snap"] = self.source.snapshot()
                results["health"] = self.source.health()
                results["url"] = self.source.url_for(review_id(URL1))

            reader = threading.Thread(target=read, daemon=True)
            reader.start()
            reader.join(2)
            self.assertFalse(reader.is_alive(), "snapshot, health or url_for blocked on a gh call")
            self.assertEqual(results["url"], URL1)
        finally:
            release.set()
            worker.join(5)
        self.assertEqual([r.url for r in self.source.snapshot().requests], [URL3])

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
            return done(b"[]" if argv[1] == "search" else reviewers_out())

        self.run.side_effect = counting
        urls = [f"https://github.com/o/r/pull/{n}" for n in range(1, 8)]
        threads = [threading.Thread(target=self.source.refresh, args=(urls,), daemon=True) for _ in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        self.assertEqual(peak[0], 1)


# ====================================================================== the opener

class ReviewOpenerTests(unittest.TestCase):
    def setUp(self):
        no_real_subprocesses(self)
        self.run = mock.Mock(return_value=subprocess.CompletedProcess([], 0))
        self.clock = Clock(0)
        self.clock.t = 1000.0
        self.opener = ReviewOpener(run=self.run, clock=self.clock)

    def test_opens_exactly_the_stored_url(self):
        self.assertEqual(self.opener.open(URL1), 200)
        self.run.assert_called_once_with(["/usr/bin/open", URL1], **OPEN_KWARGS)

    def test_url_is_validated_again_before_open(self):
        hostile = [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "claude://claude.ai/epitaxy/local_11111111-2222-4333-8444-555555555555",
            "vscode://anthropic.claude-code/open?session=11111111-2222-4333-8444-555555555555",
            "https://github.com/o/r/pull/1 --args",
            "https://github.com/o/r/pull/1\n",
            "https://github.com/o/r/pull/1/files",
            "https://github.com/o/../pull/1",
            "https://evil.example/o/r/pull/1",
            "-a/Applications/Calculator.app",
            "--args",
            "https://github.com/o/r/pull/١٢",
            "", None, 17, b"https://github.com/o/r/pull/1", ["x"],
        ]
        for url in hostile:
            with self.subTest(url=url):
                self.assertEqual(self.opener.open(url), 404)
        self.run.assert_not_called()

    def test_rate_limited(self):
        self.assertEqual(self.opener.open(URL1), 200)
        self.clock.t += 0.2
        self.assertEqual(self.opener.open(URL2), 429)
        self.clock.t += 0.6
        self.assertEqual(self.opener.open(URL2), 200)
        self.assertEqual(self.run.call_count, 2)

    def test_a_refused_url_does_not_use_up_the_rate_limit(self):
        self.assertEqual(self.opener.open("javascript:alert(1)"), 404)
        self.assertEqual(self.opener.open(URL1), 200)

    def test_open_failures_are_500(self):
        self.run.return_value = subprocess.CompletedProcess([], 1)
        self.assertEqual(self.opener.open(URL1), 500)
        for exc in (OSError("no"), subprocess.TimeoutExpired(["/usr/bin/open"], 10)):
            with self.subTest(exc=type(exc).__name__):
                opener = ReviewOpener(run=mock.Mock(side_effect=exc), clock=Clock(0))
                self.assertEqual(opener.open(URL1), 500)


if __name__ == "__main__":
    unittest.main()
