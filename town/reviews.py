"""Review requests from GitHub, read-only, through the gh CLI.

Two call shapes, both with fixed argv. `gh search prs`, twice a cycle, for the open PRs waiting on Charlie's review
(the village's visitors): `user-review-requested:@me` lists the ones that ask him by name, and
`review-requested:@me` also lists every one asking a team he is on. And
`gh api repos/<owner>/<repo>/pulls/<number>/requested_reviewers`, for the logins his own open PRs are waiting on and
the teams a team visitor's PR asks.

Nothing the page sends can reach any argv, and no text gh printed can either: both search argvs are built entirely
from module constants, and a reviewer call's owner, repo and number are only ever the three parts
`github.parse_pr_url` accepts, taken from a PR URL the board holds or from one a search answered with that was
rebuilt from those same parts. The URLs are re-validated again before `/usr/bin/open`.
"""
from __future__ import annotations

import hashlib
import itertools
import json
import os
import re
import subprocess
import threading
import time
import unicodedata
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Iterable

from .actions import OPEN_BIN, SUBPROCESS_ENV
from .github import (BREAKER_FAILURES, FAILURE_BACKOFF_MS, GH_TIMEOUT_S, PAUSE_MAX_MS, PAUSE_MS, BadResponse,
                     Cancelled, find_gh, gh_env, gh_failure, parse_pr_url)
from .model import ReviewRequest, ReviewSnapshot
from .paths import PR_URL_RE, TEAM_SLUG_RE

# Neither search takes any input: every element below is a constant, so no value from the page, from disk or from
# a previous gh answer can change what is run. `@me` is resolved by GitHub for the signed-in account, so Tokentown
# never learns or stores the login.
SEARCH_SUBCOMMAND = ("search", "prs")
# Requests that name him. Alone it leaves the desk empty for anyone whose requests come through CODEOWNERS teams.
SEARCH_QUERY_DIRECT = "user-review-requested:@me"
# Those plus every PR requesting a team he is on (what gh's --review-requested flag emits).
SEARCH_QUERY_BROAD = "review-requested:@me"
SEARCH_QUERIES = (SEARCH_QUERY_DIRECT, SEARCH_QUERY_BROAD)
SEARCH_STATE = "open"
SEARCH_LIMIT = "100"
SEARCH_FIELDS = "url,title,author,createdAt"
# The title is cut inside jq so the output is bounded before the size cap is applied: GitHub allows a 256-character
# title, and gh writes each of `<`, `>` and `&` as a 6-byte escape.
SEARCH_JQ = "[.[] | {u: .url, t: .title[0:120], a: .author.login, c: .createdAt}]"
REVIEWERS_JQ = "{users: [.users[]?.login], teams: [.teams[]?.slug]}"

VIA_YOU = "you"
VIA_TEAM = "team"

# 100 rows at GitHub's longest owner, repo and login with a 120-character title of escapes measure about 98 KB.
SEARCH_OUTPUT_BYTES = 128 * 1024
REVIEWERS_OUTPUT_BYTES = 4096
# Reviews arrive on human timescales, so this source polls at REVIEW_INTERVAL_S (server.py), five times slower
# than PR state. The two due times below are what stop a caller that loops faster from hammering gh.
SEARCH_RECHECK_MS = 4 * 60 * 1000
REVIEWERS_RECHECK_MS = 20 * 60 * 1000
MAX_VISITORS = 50
MAX_REVIEWERS = 10
MAX_TEAMS = 10
SEARCH_CALLS_PER_CYCLE = len(SEARCH_QUERIES)
# Shared by his own open PRs and the team visitors: one reviewers call answers either.
MAX_REVIEWER_CALLS_PER_CYCLE = 20
MAX_CALLS_PER_CYCLE = SEARCH_CALLS_PER_CYCLE + MAX_REVIEWER_CALLS_PER_CYCLE
TITLE_MAX = 120
LOGIN_MAX = 40
TEAM_MAX = 40
GH_NOT_FOUND = "gh not found"
REVIEW_OPEN_MIN_INTERVAL_S = 0.7

_ISO_RE = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})")
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
_REVIEWER_KEYS = frozenset({"users", "teams"})
# Control, format (bidi overrides, zero-width), surrogate and line separator characters. A title is drawn in a
# tooltip and in a PR line, so a bidi override or a line separator would rewrite what is read around it.
_REFUSED_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Zl", "Zp"})


def _epoch_ms() -> int:
    return time.time_ns() // 1_000_000


def review_id(url: str) -> str:
    """The visitor id the page is given. It carries no path, URL or command, only a digest of the URL."""
    return "pr:" + hashlib.sha1(url.encode("utf-8")).hexdigest()[:16]


def _reject_constant(_name: str):
    raise BadResponse


def _text(output: object, limit: int) -> str:
    if isinstance(output, bytes):
        if len(output) > limit:
            raise BadResponse
        try:
            return output.decode("utf-8")
        except UnicodeDecodeError:
            raise BadResponse from None
    if isinstance(output, str):
        if len(output) > limit:
            raise BadResponse
        return output
    raise BadResponse


def _json_value(output: object, limit: int):
    try:
        return json.loads(_text(output, limit), parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        raise BadResponse from None


def _clean(value: object, limit: int) -> str | None:
    """Drop control, format and separator characters, then truncate: a title or login is drawn on the page."""
    if not isinstance(value, str):
        return None
    kept = "".join(c for c in value if unicodedata.category(c) not in _REFUSED_CATEGORIES).strip()
    return kept[:limit] or None


def team_slugs(values: object) -> tuple[str, ...]:
    """Distinct team slugs the page may be handed: at most MAX_TEAMS, each cut to TEAM_MAX characters.

    A value that is not wholly ASCII letters, digits, `-` and `_` is dropped, not cleaned: it is not a slug GitHub
    made, so no part of it is shown.
    """
    if not isinstance(values, (list, tuple)):
        return ()
    kept: dict[str, None] = {}
    for value in values:
        if isinstance(value, str) and TEAM_SLUG_RE.match(value):
            kept.setdefault(value[:TEAM_MAX], None)
            if len(kept) >= MAX_TEAMS:
                break
    return tuple(kept)


def _iso_ms(value: object) -> int | None:
    """Epoch ms for an ISO 8601 time, else None.

    Unlike the PR state resolver's, a bad time here is not a bad answer: it costs a visitor its wait clock,
    where a PR's state depends on its timestamps.
    """
    if not isinstance(value, str) or _ISO_RE.fullmatch(value) is None:
        return None
    try:
        ms = (datetime.fromisoformat(value) - _EPOCH) // timedelta(milliseconds=1)
    except ValueError:
        return None
    return ms if ms >= 0 else None


def queue_key(req: ReviewRequest):
    """Queue order at the immigration desk: longest wait first, a request with no time last, ties on id."""
    return (req.waiting_since is None, req.waiting_since or 0, req.id)


def keep_visitors(requests: Iterable[ReviewRequest]) -> tuple[ReviewRequest, ...]:
    """At most MAX_VISITORS, in queue order.

    Past the cap the ones that ask him by name are kept first, then the longest waits: a CODEOWNERS team can queue a
    whole repo, and it must not push out the more personal request.
    """
    chosen = sorted(requests, key=lambda r: (r.via != VIA_YOU, queue_key(r)))[:MAX_VISITORS]
    return tuple(sorted(chosen, key=queue_key))


def search_rows(output: object) -> dict[str, ReviewRequest]:
    """Every usable row of one search's jq output, by URL, first copy kept. Not capped: the union comes first.

    A row whose URL is not a plain-ASCII github.com PR URL is dropped: the stored URL is rebuilt from the three parts
    `parse_pr_url` returned, so it is never a string gh chose.
    """
    rows = _json_value(output, SEARCH_OUTPUT_BYTES)
    if not isinstance(rows, list):
        raise BadResponse
    found: dict[str, ReviewRequest] = {}
    for row in rows:
        if not isinstance(row, dict):
            raise BadResponse
        parts = parse_pr_url(row.get("u"))
        if parts is None:
            continue
        owner, repo, number = parts
        url = f"https://github.com/{owner}/{repo}/pull/{number}"
        found.setdefault(url, ReviewRequest(
            id=review_id(url), number=number, owner=owner, repo=repo, url=url,
            title=_clean(row.get("t"), TITLE_MAX), author=_clean(row.get("a"), LOGIN_MAX),
            # The search carries no request time, so the wait is measured from when the PR was opened.
            waiting_since=_iso_ms(row.get("c")),
        ))
    return found


def parse_review_search(output: object) -> tuple[ReviewRequest, ...]:
    """One search's requests on their own: longest wait first, at most MAX_VISITORS."""
    return keep_visitors(search_rows(output).values())


def combine_searches(direct: dict[str, ReviewRequest], broad: dict[str, ReviewRequest]) -> tuple[ReviewRequest, ...]:
    """The visitors one cycle's two answers give: every URL either lists, "you" exactly when the direct one does.

    A URL only the direct search lists still counts: the two are separate queries, and a request made between them,
    or past the broad one's limit, is no less real.
    """
    merged = {url: replace(req, via=VIA_TEAM, teams=()) for url, req in broad.items()}
    merged.update((url, replace(req, via=VIA_YOU, teams=())) for url, req in direct.items())
    return keep_visitors(merged.values())


def parse_requested_reviewers(output: object) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """(names, teams) for one PR's pending reviewers.

    `names` is the user logins then the team slugs, distinct and capped, for the "waiting on" line of his own PR.
    `teams` is the team slugs alone, for a visitor that asks a team.
    """
    obj = _json_value(output, REVIEWERS_OUTPUT_BYTES)
    if not isinstance(obj, dict) or not _REVIEWER_KEYS <= obj.keys():
        raise BadResponse
    users, teams = obj["users"], obj["teams"]
    if not isinstance(users, list) or not isinstance(teams, list):
        raise BadResponse
    slugs = team_slugs(teams)
    names: dict[str, None] = {}
    for value in users:
        name = _clean(value, LOGIN_MAX)
        if name is not None:
            names.setdefault(name, None)
    names.update(dict.fromkeys(slugs))
    return tuple(names)[:MAX_REVIEWERS], slugs


def parse_reviewers(output: object) -> tuple[str, ...]:
    """The pending reviewers of one PR: user logins, then team slugs, distinct and capped."""
    return parse_requested_reviewers(output)[0]


def _interleave(first: dict, second: dict) -> dict:
    out: dict = {}
    for pair in itertools.zip_longest(first.items(), second.items()):
        for item in pair:
            if item is not None:
                out.setdefault(*item)
    return out


@dataclass(slots=True)
class _Target:
    """One thing gh can be asked about: one of the two searches, or one PR's requested reviewers."""
    next_check_at: int = 0
    error: str | None = None
    failed_at: int | None = None


@dataclass(slots=True)
class _Cycle:
    """One refresh's counters. The call cap and the breaker run across both searches and every reviewer call."""
    max_calls: int
    done: int
    calls: int = 0
    successes: int = 0
    failures: int = 0
    streak: int = 0


class ReviewSource:
    """Caches what GitHub says is waiting for review. refresh() runs gh; snapshot() and health() never block.

    `run`, when given, is called like subprocess.run (tests). Without it gh is started with `popen` so that
    cancel() can kill a call in flight, exactly as PrStateResolver does.
    """

    def __init__(self, run: Callable | None = None, clock_ms: Callable[[], int] = _epoch_ms,
                 gh_path: str | None = None, *, home: str | None = None, popen: Callable | None = None):
        if gh_path is None:
            gh_path = find_gh()
        elif not (isinstance(gh_path, str) and os.path.isabs(gh_path)):
            raise ValueError("gh_path must be an absolute path")
        if home is None:
            try:
                home = str(Path.home())
            except (RuntimeError, KeyError):
                gh_path = None
        self.gh_path = gh_path
        self._env = gh_env(home) if home is not None else {}
        self._run = run
        self._popen = popen
        self._clock_ms = clock_ms
        self._lock = threading.Lock()
        self._refresh_lock = threading.Lock()
        self._proc_lock = threading.Lock()
        self._proc = None
        self._cancelled = False
        self._direct = _Target()
        self._broad = _Target()
        self._reviewers: dict[str, _Target] = {}
        self._requests: tuple[ReviewRequest, ...] = ()
        self._by_id: dict[str, str] = {}
        # Per PR URL: (names, teams) from its latest good requested_reviewers answer.
        self._answers: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {}
        self._own: frozenset[str] = frozenset()
        self._last_checked_at: int | None = None
        self._failures_in_a_row = 0
        self._paused_until: int | None = None
        self._pause_ms = PAUSE_MS

    @property
    def enabled(self) -> bool:
        return self.gh_path is not None

    # ------------------------------------------------------------ reading

    def snapshot(self) -> ReviewSnapshot:
        with self._lock:
            requests = tuple(
                replace(r, teams=self._answers[r.url][1]) if r.via == VIA_TEAM and r.url in self._answers else r
                for r in self._requests)
            reviewers = {url: answer[0] for url, answer in self._answers.items() if url in self._own}
        return ReviewSnapshot(requests=requests, reviewers=reviewers)

    def url_for(self, visitor_id: object) -> str | None:
        """The stored URL of a visitor the latest good pair of searches answered with, else None."""
        if not isinstance(visitor_id, str):
            return None
        with self._lock:
            return self._by_id.get(visitor_id)

    def health(self) -> dict:
        with self._lock:
            known = len(self._requests) + sum(1 for url in self._answers if url in self._own)
            targets = [self._direct, self._broad, *self._reviewers.values()]
            failing = [(t.failed_at or 0, t.error) for t in targets if t.error is not None]
            last_checked_at = self._last_checked_at
        if self.gh_path is None:
            last_error = GH_NOT_FOUND
        elif failing:
            last_error = max(failing)[1]
        else:
            last_error = None
        return {
            "enabled": self.gh_path is not None,
            "known": known,
            "failed": len(failing),
            "lastError": last_error,
            "lastCheckedAt": last_checked_at,
        }

    # ------------------------------------------------------------ refreshing

    def refresh(self, open_pr_urls: Iterable[str] = (), max_calls: int = MAX_CALLS_PER_CYCLE) -> int:
        """One cycle: both searches when due, then the reviewers of the team visitors and of each open PR URL.

        Returns the gh calls made. `open_pr_urls` is the full set of his own PRs in play: reviewer entries for URLs
        no longer passed, and for PRs no longer team visitors, are forgotten.
        """
        with self._refresh_lock:
            own: dict[str, tuple[str, str, int]] = {}
            for url in open_pr_urls:
                if isinstance(url, str) and url not in own:
                    parts = parse_pr_url(url)
                    if parts is not None:
                        own[url] = parts
            with self._lock:
                self._own = frozenset(own)
                self._forget(own)
            if self.gh_path is None or self._cancelled:
                return 0

            now = self._clock_ms()
            with self._lock:
                if self._paused_until is not None and now < self._paused_until:
                    return 0
                search_due = now >= max(self._direct.next_check_at, self._broad.next_check_at)
            cycle = _Cycle(max_calls=max_calls, done=now)
            if search_due and max_calls >= SEARCH_CALLS_PER_CYCLE:
                self._search(cycle)
            with self._lock:
                # The searches may just have changed which PRs are team visitors.
                wanted = self._forget(own)
                plan = self._due(wanted, now)
            for url, parts in plan:
                got = self._ask(cycle, self.reviewers_argv(*parts), parse_requested_reviewers)
                if got is None:
                    break
                value, error = got
                with self._lock:
                    self._settle(cycle, self._reviewers.setdefault(url, _Target()), error, REVIEWERS_RECHECK_MS)
                    if error is None:
                        self._answers[url] = value
            with self._lock:
                if cycle.successes:
                    self._paused_until, self._pause_ms = None, PAUSE_MS
                elif cycle.failures and self._failures_in_a_row >= BREAKER_FAILURES:
                    self._paused_until = cycle.done + self._pause_ms
                    self._pause_ms = min(self._pause_ms * 2, PAUSE_MAX_MS)
            return cycle.calls

    def _search(self, cycle: _Cycle) -> None:
        """Both searches, as one answer: the visitors, and which of them are "you", change only when both succeed.

        After a failure the list stays exactly as the last good pair left it, and both are asked again together after
        the back-off. When the direct search fails the broad one is not run: its answer could not be used.
        """
        answers = []
        for target, query in ((self._direct, SEARCH_QUERY_DIRECT), (self._broad, SEARCH_QUERY_BROAD)):
            got = self._ask(cycle, self.search_argv(query), search_rows)
            if got is None:
                return
            value, error = got
            with self._lock:
                self._settle(cycle, target, error, SEARCH_RECHECK_MS)
            if error is not None:
                break
            answers.append(value)
        combined = combine_searches(*answers) if len(answers) == len(SEARCH_QUERIES) else None
        with self._lock:
            if combined is not None:
                self._requests = combined
                self._by_id = {r.id: r.url for r in combined}
            else:
                for target in (self._direct, self._broad):
                    target.next_check_at = cycle.done + FAILURE_BACKOFF_MS

    def _ask(self, cycle: _Cycle, argv: list[str], parse: Callable):
        """One gh call inside the cycle's cap and breaker: (value, error), or None when the cycle stops first."""
        if self._cancelled or cycle.calls >= cycle.max_calls or cycle.streak >= BREAKER_FAILURES:
            return None
        cycle.calls += 1
        result = self._fetch(argv, parse)
        cycle.done = self._clock_ms()
        return None if self._cancelled else result

    def _settle(self, cycle: _Cycle, target: _Target, error: str | None, recheck_ms: int) -> None:
        """Records one call's outcome on its target and on the cycle. Caller holds self._lock."""
        if error is not None:
            # A failed re-check keeps the last answer GitHub gave: still better than nothing.
            target.error, target.failed_at = error, cycle.done
            target.next_check_at = cycle.done + FAILURE_BACKOFF_MS
            cycle.failures += 1
            cycle.streak += 1
            self._failures_in_a_row += 1
            return
        target.error, target.failed_at = None, None
        target.next_check_at = cycle.done + recheck_ms
        self._last_checked_at = cycle.done
        cycle.successes += 1
        cycle.streak = 0
        self._failures_in_a_row = 0

    def _forget(self, own: dict[str, tuple[str, str, int]]) -> dict[str, tuple[str, str, int]]:
        """Drops reviewer entries nothing wants, and returns what is wanted: team visitors and his own PRs,
        alternately, the front of the desk's queue first. Caller holds self._lock."""
        team: dict[str, tuple[str, str, int]] = {}
        for req in self._requests:
            if req.via == VIA_TEAM:
                parts = parse_pr_url(req.url)
                if parts is not None:
                    team.setdefault(req.url, parts)
        wanted = _interleave(team, own)
        for url in [u for u in self._reviewers if u not in wanted]:
            del self._reviewers[url]
        for url in [u for u in self._answers if u not in wanted]:
            del self._answers[url]
        return wanted

    def _due(self, wanted: dict[str, tuple[str, str, int]], now: int) -> list[tuple[str, tuple[str, str, int]]]:
        """The reviewer calls due, at most MAX_REVIEWER_CALLS_PER_CYCLE. Caller holds self._lock.

        Targets that keep failing go last, so a few dead ones cannot trip the breaker. The rest go longest overdue
        first (never checked counts as the longest): at both caps there are more targets than calls, and in list
        order the tail would wait for ever behind the head's re-checks.
        """
        due: list[tuple[int, int, int, str, tuple[str, str, int]]] = []
        for index, (url, parts) in enumerate(wanted.items()):
            target = self._reviewers.get(url)
            if target is None:
                due.append((0, 0, index, url, parts))
            elif now >= target.next_check_at:
                due.append((0 if target.error is None else 1, target.next_check_at, index, url, parts))
        due.sort(key=lambda d: d[:3])
        return [(url, parts) for *_, url, parts in due[:MAX_REVIEWER_CALLS_PER_CYCLE]]

    def cancel(self) -> None:
        """For shutdown: no further gh calls, and a call in flight is killed."""
        with self._proc_lock:
            self._cancelled = True
            proc = self._proc
        if proc is not None:
            try:
                proc.kill()
            except OSError:
                pass

    # ------------------------------------------------------------ gh

    def search_argv(self, query: str = SEARCH_QUERY_DIRECT) -> list[str]:
        if query not in SEARCH_QUERIES:
            raise ValueError("not one of the two search queries")
        return [self.gh_path, *SEARCH_SUBCOMMAND, query, "--state", SEARCH_STATE,
                "--limit", SEARCH_LIMIT, "--json", SEARCH_FIELDS, "--jq", SEARCH_JQ]

    def reviewers_argv(self, owner: str, repo: str, number: int) -> list[str]:
        return [self.gh_path, "api", f"repos/{owner}/{repo}/pulls/{number}/requested_reviewers",
                "--jq", REVIEWERS_JQ]

    def _start_and_wait(self, argv: list[str], env: dict[str, str]) -> subprocess.CompletedProcess:
        popen = self._popen if self._popen is not None else subprocess.Popen
        with self._proc_lock:
            if self._cancelled:
                raise Cancelled
            # stderr is never read, so gh's error text never enters this process.
            proc = popen(argv, shell=False, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, env=env)
            self._proc = proc
        try:
            try:
                stdout, _ = proc.communicate(timeout=GH_TIMEOUT_S)
            except BaseException:
                proc.kill()
                proc.communicate()
                raise
            return subprocess.CompletedProcess(argv, proc.returncode, stdout, None)
        finally:
            with self._proc_lock:
                self._proc = None

    def _call(self, argv: list[str]):
        env = dict(self._env)
        if self._run is not None:
            return self._run(argv, shell=False, timeout=GH_TIMEOUT_S, stdin=subprocess.DEVNULL,
                             capture_output=True, env=env)
        return self._start_and_wait(argv, env)

    def _fetch(self, argv: list[str], parse: Callable):
        try:
            result = self._call(argv)
        except Exception as exc:
            return None, type(exc).__name__
        code = getattr(result, "returncode", None)
        if type(code) is not int:
            return None, BadResponse.__name__
        if code != 0:
            return None, gh_failure(code, getattr(result, "stdout", None))
        try:
            return parse(getattr(result, "stdout", None)), None
        except BadResponse:
            return None, BadResponse.__name__


class ReviewOpener:
    """Opens one PR page in the browser.

    The URL is never sent by the page: the server looks it up by id and hands it here, and it is checked against
    PR_URL_RE again immediately before the call, so `/usr/bin/open` only ever sees a plain-ASCII github.com PR
    URL. That anchor is also what keeps the argument from looking like a flag.
    """

    def __init__(self, run=subprocess.run, clock=time.monotonic):
        self._run = run
        self._clock = clock
        self._lock = threading.Lock()
        self._last: float | None = None

    def open(self, url: object) -> int:
        """HTTP status: 200 opened, 404 not an openable PR URL, 429 too soon, 500 open failed."""
        if not isinstance(url, str) or not PR_URL_RE.match(url) or parse_pr_url(url) is None:
            return 404
        with self._lock:
            now = self._clock()
            if self._last is not None and now - self._last < REVIEW_OPEN_MIN_INTERVAL_S:
                return 429
            self._last = now
        try:
            result = self._run(
                [OPEN_BIN, url],
                shell=False,
                timeout=10,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=dict(SUBPROCESS_ENV),
            )
        except (OSError, subprocess.SubprocessError):
            return 500
        returncode = getattr(result, "returncode", 0)
        return 500 if isinstance(returncode, int) and returncode != 0 else 200
