"""PR state from GitHub, read-only, through the gh CLI.

The Claude app's prs[].state goes stale once a session is idle, so the board asks GitHub instead. The only
command ever run is `gh api repos/<owner>/<repo>/pulls/<number>` with a fixed jq filter, and nothing but the
state and two timestamps is kept from the answer.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Iterable

from .model import GitHubPr
from .paths import PR_URL_RE

# Homebrew on Apple silicon, then Intel (or GitHub's own installer), MacPorts, nix-darwin, a Nix profile, by hand.
GH_CANDIDATES = ("/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/opt/local/bin/gh", "/run/current-system/sw/bin/gh",
                 "~/.nix-profile/bin/gh", "~/.local/bin/gh")
GH_TIMEOUT_S = 20
GH_PATH_ENV = "/usr/bin:/bin"
# Where gh finds its sign-in when you have moved its config, or use a token instead. Nothing else reaches gh.
GH_ENV_KEYS = ("GH_CONFIG_DIR", "XDG_CONFIG_HOME", "GH_TOKEN")
JQ_FILTER = "{state: .state, merged_at: .merged_at, closed_at: .closed_at}"
OPEN_RECHECK_MS = 10 * 60 * 1000
FAILURE_BACKOFF_MS = 15 * 60 * 1000
# While GitHub, the proxy or gh's sign-in is down every URL fails: after BREAKER_FAILURES failed calls in a row the
# cycle stops and no re-check runs for PAUSE_MS, doubling up to PAUSE_MAX_MS until a call succeeds.
BREAKER_FAILURES = 3
PAUSE_MS = 15 * 60 * 1000
PAUSE_MAX_MS = 2 * 60 * 60 * 1000
FUTURE_SLACK_MS = 24 * 60 * 60 * 1000
MAX_OUTPUT_BYTES = 4096
# Transcript pr-links brought about 180 URLs into play: 120 resolves a cold start in two cycles, recent ones first.
MAX_CALLS_PER_CYCLE = 120
TERMINAL_STATES = frozenset({"MERGED", "CLOSED"})
GH_NOT_FOUND = "gh not found"
GH_NOT_SIGNED_IN = "gh not signed in"
# gh exits 4 when it has no sign-in at all. One GitHub refuses exits 1 like any other HTTP error, and `gh api` then
# prints GitHub's error body on stdout, --jq or not: its "status" says which error it was.
GH_EXIT_NO_SIGN_IN = 4
MAX_ERROR_BYTES = 4096
_HTTP_STATUS_RE = re.compile(r"[1-5][0-9]{2}")

# PR_URL_RE is built from \w and \d, which also match non-ASCII letters and digits (int() reads Arabic-Indic
# digits), and its [\w.-]+ accepts "." and "..", which gh would pass on as dot segments of the API path.
_URL_PARTS_RE = re.compile(r"https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/pull/([0-9]{1,10})")
_ISO_RE = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})")
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
_RESPONSE_KEYS = frozenset({"state", "merged_at", "closed_at"})


class BadResponse(ValueError):
    """gh answered 0 but the output is not the shape the jq filter produces."""


class Cancelled(RuntimeError):
    """The resolver was cancelled before gh could start."""


def _epoch_ms() -> int:
    return time.time_ns() // 1_000_000


def find_gh(candidates: Iterable[str] | None = None) -> str | None:
    for candidate in GH_CANDIDATES if candidates is None else candidates:
        path = os.path.expanduser(candidate)
        if os.path.isabs(path) and os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def gh_env(home: str, environ=os.environ) -> dict[str, str]:
    """gh's whole environment: a fixed PATH, HOME, and the GH_ENV_KEYS that are set."""
    env = {"PATH": GH_PATH_ENV, "HOME": home}
    env.update({key: environ[key] for key in GH_ENV_KEYS if environ.get(key)})
    return env


def parse_pr_url(url: object) -> tuple[str, str, int] | None:
    """(owner, repo, number) for a URL that fully matches PR_URL_RE and is plain ASCII, else None."""
    if not isinstance(url, str) or not PR_URL_RE.match(url):
        return None
    m = _URL_PARTS_RE.fullmatch(url)
    if m is None:
        return None
    owner, repo, digits = m.groups()
    if owner in (".", "..") or repo in (".", ".."):
        return None
    number = int(digits)
    if number < 1:
        return None
    return owner, repo, number


def _timestamp_ms(value: object) -> int | None:
    if value is None:
        return None
    if not isinstance(value, str) or _ISO_RE.fullmatch(value) is None:
        raise BadResponse
    try:
        ms = (datetime.fromisoformat(value) - _EPOCH) // timedelta(milliseconds=1)
    except ValueError:
        raise BadResponse from None
    if ms < 0:
        raise BadResponse
    return ms


def _reject_constant(_name: str):
    raise BadResponse


def gh_failure(code: int, stdout: object = None) -> str:
    """How a gh call that exited `code` is kept: which failure it was, never what gh or GitHub said."""
    if code == GH_EXIT_NO_SIGN_IN:
        return GH_NOT_SIGNED_IN
    status = _http_status(stdout) if code == 1 else None
    return f"HTTP {status}" if status is not None else f"exit {code}"


def _http_status(stdout: object) -> str | None:
    """The "status" of a GitHub error body, three digits, else None. Nothing else of the body is read."""
    if not isinstance(stdout, (bytes, str)) or len(stdout) > MAX_ERROR_BYTES:
        return None
    try:
        obj = json.loads(stdout, parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError, RecursionError):
        return None
    status = obj.get("status") if isinstance(obj, dict) else None
    return status if isinstance(status, str) and _HTTP_STATUS_RE.fullmatch(status) else None


def parse_pr_state(output: object) -> tuple[str, int | None, int | None]:
    """(state, merged_at, closed_at) from the jq filter's output. Raises BadResponse for anything else."""
    if isinstance(output, bytes):
        if len(output) > MAX_OUTPUT_BYTES:
            raise BadResponse
        try:
            text = output.decode("utf-8")
        except UnicodeDecodeError:
            raise BadResponse from None
    elif isinstance(output, str):
        if len(output) > MAX_OUTPUT_BYTES:
            raise BadResponse
        text = output
    else:
        raise BadResponse
    try:
        obj = json.loads(text, parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        raise BadResponse from None
    if not isinstance(obj, dict) or not _RESPONSE_KEYS <= obj.keys():
        raise BadResponse
    state = obj["state"]
    if not isinstance(state, str):
        raise BadResponse
    merged_at = _timestamp_ms(obj["merged_at"])
    closed_at = _timestamp_ms(obj["closed_at"])
    if merged_at is not None:
        return "MERGED", merged_at, closed_at
    if state == "closed":
        return "CLOSED", None, closed_at
    if state == "open":
        return "OPEN", None, closed_at
    raise BadResponse


@dataclass(slots=True)
class _Entry:
    pr: GitHubPr | None = None
    next_check_at: int | None = 0  # None: terminal, never checked again
    error: str | None = None  # set while the latest check of this URL failed
    failed_at: int | None = None


class PrStateResolver:
    """Caches GitHub's state for PR URLs. refresh() runs gh; snapshot() and health() never block on it.

    Each refresh() is given the full set of URLs in play: entries for URLs no longer passed are forgotten.
    `run`, when given, is called like subprocess.run (tests). Without it gh is started with `popen` so that
    cancel() can kill a call in flight: subprocess.run enforces its timeout from the calling thread, which dies
    with the server and would leave gh running.
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
        self._entries: dict[str, _Entry] = {}
        self._last_checked_at: int | None = None
        self._failures_in_a_row = 0
        self._paused_until: int | None = None
        self._pause_ms = PAUSE_MS

    @property
    def enabled(self) -> bool:
        return self.gh_path is not None

    def refresh(self, urls: Iterable[str], max_calls: int = MAX_CALLS_PER_CYCLE) -> int:
        """Ask GitHub about each URL that is due. Returns the number of gh calls made."""
        with self._refresh_lock:
            wanted: dict[str, tuple[str, str, int]] = {}
            for url in urls:
                if isinstance(url, str) and url not in wanted:
                    parts = parse_pr_url(url)
                    if parts is not None:
                        wanted[url] = parts
            with self._lock:
                for url in [u for u in self._entries if u not in wanted]:
                    del self._entries[url]
            if self.gh_path is None or self._cancelled:
                return 0

            now = self._clock_ms()
            with self._lock:
                if self._paused_until is not None and now < self._paused_until:
                    return 0
                due: list[tuple[int, str, tuple[str, str, int]]] = []
                for url, parts in wanted.items():
                    entry = self._entries.get(url)
                    if entry is None:
                        due.append((0, url, parts))
                    elif entry.next_check_at is not None and now >= entry.next_check_at:
                        # URLs that keep failing go last, so a few dead ones cannot trip the breaker for the rest.
                        due.append((0 if entry.error is None else 1, url, parts))
            due.sort(key=lambda d: d[0])

            calls = successes = failures = streak = 0
            done = now
            for _, url, (owner, repo, number) in due:
                if calls >= max_calls or streak >= BREAKER_FAILURES or self._cancelled:
                    break
                calls += 1
                state, error = self._fetch(owner, repo, number)
                done = self._clock_ms()
                if self._cancelled:
                    break
                with self._lock:
                    entry = self._entries.setdefault(url, _Entry())
                    if state is None:
                        # A failed re-check keeps the last state GitHub gave: still fresher than the app's.
                        entry.error, entry.failed_at = error, done
                        entry.next_check_at = done + FAILURE_BACKOFF_MS
                        failures += 1
                        streak += 1
                        self._failures_in_a_row += 1
                        continue
                    name, merged_at, closed_at = state
                    entry.pr = GitHubPr(state=name, merged_at=merged_at, closed_at=closed_at, checked_at=done)
                    entry.error, entry.failed_at = None, None
                    entry.next_check_at = None if name in TERMINAL_STATES else done + OPEN_RECHECK_MS
                    self._last_checked_at = done
                    successes += 1
                    streak = 0
                    self._failures_in_a_row = 0
            with self._lock:
                if successes:
                    self._paused_until, self._pause_ms = None, PAUSE_MS
                elif failures and self._failures_in_a_row >= BREAKER_FAILURES:
                    self._paused_until = done + self._pause_ms
                    self._pause_ms = min(self._pause_ms * 2, PAUSE_MAX_MS)
            return calls

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

    def _fetch(self, owner: str, repo: str, number: int) -> tuple[tuple[str, int | None, int | None] | None, str | None]:
        argv = [self.gh_path, "api", f"repos/{owner}/{repo}/pulls/{number}", "--jq", JQ_FILTER]
        env = dict(self._env)
        try:
            if self._run is not None:
                result = self._run(argv, shell=False, timeout=GH_TIMEOUT_S, stdin=subprocess.DEVNULL,
                                   capture_output=True, env=env)
            else:
                result = self._start_and_wait(argv, env)
        except Exception as exc:
            return None, type(exc).__name__
        code = getattr(result, "returncode", None)
        if type(code) is not int:
            return None, BadResponse.__name__
        if code != 0:
            return None, gh_failure(code, getattr(result, "stdout", None))
        try:
            state = parse_pr_state(getattr(result, "stdout", None))
        except BadResponse:
            return None, BadResponse.__name__
        # A merge time in the future would keep a row on the beach for good, since MERGED is never asked again.
        latest = self._clock_ms() + FUTURE_SLACK_MS
        if any(ts is not None and ts > latest for ts in state[1:]):
            return None, BadResponse.__name__
        return state, None

    def snapshot(self) -> dict[str, GitHubPr]:
        with self._lock:
            return {url: e.pr for url, e in self._entries.items() if e.pr is not None}

    def health(self) -> dict:
        with self._lock:
            known = sum(1 for e in self._entries.values() if e.pr is not None)
            failing = [(e.failed_at or 0, e.error) for e in self._entries.values() if e.error is not None]
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
