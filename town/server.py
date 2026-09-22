"""The loopback HTTP server: request guards, a fixed route map, and the background scan thread."""
from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import signal
import socketserver
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable

from . import security
from .actions import Opener, resume_command, update_command
from .board import (done_activity, effective_last_activity, pr_candidates, session_activity, valhalla_asks,
                    with_source_problems)
from .done import DoneStore, valid_row_id
from .github import PrStateResolver
from .model import GitHubPr, RawSnapshot, ReviewSnapshot
from .paths import CODE_DIR, HOST, PORT, PR_URL_RE, REVIEW_ID_RE, Paths, default_paths
from .reviews import ReviewOpener, ReviewSource
from .updates import UpdateChecker

WEB_DIR = CODE_DIR / "web"
STATIC_ROUTES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/village.js": ("village.js", "text/javascript; charset=utf-8"),
    "/app.css": ("app.css", "text/css; charset=utf-8"),
}
POST_KEYS = {
    "/api/claim": frozenset({"code"}),
    "/api/open": frozenset({"id"}),
    "/api/open-review": frozenset({"id"}),
    "/api/resume-command": frozenset({"id"}),
    "/api/done": frozenset({"id", "done"}),
    "/api/update-command": frozenset(),
    "/api/update": frozenset(),
}
HEALTHZ_QUERY_RE = re.compile(r"n=([0-9a-f]{32})")
REPLAY_WARNING = "launch link used twice"
JSON_TYPE = "application/json; charset=utf-8"
DISCARD_LIMIT = 65536
PR_REFRESH_INTERVAL_S = 60.0
# Reviews move on human timescales, so the review source polls five times slower than PR state.
REVIEW_REFRESH_INTERVAL_S = 300.0
# Reviewer calls cost one gh launch each, so only this many of his open PRs are in play at once.
MAX_REVIEW_URLS = 60
# Only reads .git: the checker itself asks GitHub at most hourly, and straight away after a pull.
UPDATE_REFRESH_INTERVAL_S = 60.0
DONE_MIN_INTERVAL_S = 0.3

BoardProvider = Callable[[], tuple[RawSnapshot | None, dict]]
GitHubStates = Callable[[], dict[str, GitHubPr]]
DoneMarks = Callable[[], dict[str, int]]
Reviews = Callable[[], ReviewSnapshot]


def _now_ms() -> int:
    return time.time_ns() // 1_000_000


def _log_exception(exc: BaseException | None) -> None:
    try:
        sys.stderr.write(f"tokentown: {type(exc).__name__}\n")
    except Exception:
        pass


def json_bytes(obj) -> bytes:
    text = json.dumps(obj, ensure_ascii=True, separators=(",", ":"), allow_nan=False)
    # <, > and & only ever occur inside JSON strings, so escaping them keeps the JSON identical
    # while no response body can be mistaken for markup.
    return text.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026").encode("ascii")


def board_etag(board: dict) -> str:
    # scanMs changes on every scan like generatedAt, so leaving it in would mean a 304 never happens.
    view = {k: v for k, v in board.items() if k != "generatedAt"}
    health = view.get("health")
    if isinstance(health, dict):
        health = {k: v for k, v in health.items() if k != "scanMs"}
        for source in ("github", "reviews", "updates"):
            value = health.get(source)
            if isinstance(value, dict):
                # lastCheckedAt moves with every gh answer, including the many that change nothing.
                health[source] = {k: v for k, v in value.items() if k != "lastCheckedAt"}
        view["health"] = health
    text = json.dumps(view, sort_keys=True, ensure_ascii=True, separators=(",", ":"))
    return '"' + hashlib.sha256(text.encode("ascii")).hexdigest()[:32] + '"'


def _etag_matches(values: list[str] | None, etag: str) -> bool:
    for value in values or ():
        for tag in value.split(","):
            tag = tag.strip()
            if tag == "*" or tag.removeprefix("W/") == etag:
                return True
    return False


def default_board_provider(paths: Paths, github: GitHubStates | None = None, *,
                           done: DoneMarks | None = None, link_store=None,
                           reviews: Reviews | None = None) -> BoardProvider:
    from .board import build_board
    from .sources import Scanner

    scanner = Scanner(paths) if link_store is None else Scanner(paths, link_store=link_store)

    def provide() -> tuple[RawSnapshot, dict]:
        raw = scanner.scan()
        extra = {} if done is None else {"done": done()}
        if reviews is not None:
            extra["reviews"] = reviews()
        if github is None:
            return raw, build_board(raw, _now_ms(), **extra)
        return raw, build_board(raw, _now_ms(), github(), **extra)

    return provide


def pr_urls(raw: RawSnapshot | None) -> list[str]:
    """Distinct PR URLs from desktop prs[] and transcript pr-links, most recently active session first.

    Within a session the newest PR comes first. Dismissed URLs and URLs that fail PR_URL_RE are left out.
    """
    if raw is None:
        return []
    sessions: list[tuple[int, tuple, tuple]] = []
    desktop_cli_ids = set()
    for rec in raw.desktop:
        tail = raw.tails.get(rec.cli_session_id) if rec.cli_session_id else None
        links = raw.pr_links.get(rec.cli_session_id, ()) if rec.cli_session_id else ()
        sessions.append((effective_last_activity(rec, tail, raw.scanned_at), rec.prs, links))
        if rec.cli_session_id:
            desktop_cli_ids.add(rec.cli_session_id)
    for cli in raw.cli_only:
        if cli.session_id not in desktop_cli_ids:
            sessions.append((cli.last_activity_at, (), raw.pr_links.get(cli.session_id, ())))
    sessions.sort(key=lambda s: s[0], reverse=True)
    seen: dict[str, None] = {}
    for _, prs, links in sessions:
        for pr in reversed(pr_candidates(prs, links)):
            if pr.url is not None:
                seen.setdefault(pr.url, None)
    return list(seen)


def review_urls(board: dict | None, limit: int = MAX_REVIEW_URLS) -> list[str]:
    """Distinct PR URLs of board rows whose shown PR GitHub confirmed OPEN, in board order.

    Verified only: the Claude app calls a PR OPEN long after it merged, and asking about a merged PR spends a
    gh launch to be told nobody is reviewing it.
    """
    if not isinstance(board, dict):
        return []
    seen: dict[str, None] = {}
    for row in board.get("sessions") or ():
        if not isinstance(row, dict):
            continue
        pr = row.get("pr")
        if not isinstance(pr, dict) or pr.get("state") != "OPEN" or pr.get("verified") is not True:
            continue
        url = pr.get("url")
        if isinstance(url, str) and PR_URL_RE.match(url):
            seen.setdefault(url, None)
            if len(seen) >= limit:
                break
    return list(seen)


def _no_duplicate_keys(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("duplicate key")
        obj[key] = value
    return obj


def parse_done_payload(body: bytes) -> dict | None:
    """`{"id": str, "done": bool}` exactly, else None. security.parse_json_object only takes string values."""
    try:
        obj = json.loads(body.decode("utf-8"), object_pairs_hook=_no_duplicate_keys)
    except (UnicodeDecodeError, ValueError, RecursionError):
        return None
    if not isinstance(obj, dict) or set(obj) != POST_KEYS["/api/done"]:
        return None
    if not isinstance(obj["id"], str) or type(obj["done"]) is not bool:
        return None
    return obj


def _board_row(board: dict | None, row_id: str) -> dict | None:
    if not isinstance(board, dict):
        return None
    for row in board.get("sessions") or ():
        if isinstance(row, dict) and row.get("id") == row_id:
            return row
    return None


def _visitor(board: dict | None, visitor_id: str) -> dict | None:
    """The visitor of that id on the board the page was last given, else None (an unknown or stale id)."""
    if not isinstance(board, dict):
        return None
    for visitor in board.get("visitors") or ():
        if isinstance(visitor, dict) and visitor.get("id") == visitor_id:
            return visitor
    return None


class App:
    """Server state shared by request threads: the secret, the opener and the latest board."""

    def __init__(self, *, port: int, secret: bytes, board_provider: BoardProvider, opener: Opener,
                 scan_interval: float = 2.0, web_dir: Path = WEB_DIR, now_ms: Callable[[], int] = _now_ms,
                 pr_resolver: PrStateResolver | None = None, pr_interval: float = PR_REFRESH_INTERVAL_S,
                 done_store: DoneStore | None = None, done_clock: Callable[[], float] = time.monotonic,
                 review_source: ReviewSource | None = None, review_opener: ReviewOpener | None = None,
                 review_interval: float = REVIEW_REFRESH_INTERVAL_S, update_checker: UpdateChecker | None = None,
                 update_interval: float = UPDATE_REFRESH_INTERVAL_S):
        self.port = port
        self.secret = secret
        self.token = security.session_token(secret)
        self.verifier = security.CodeVerifier(secret)
        self.opener = opener
        self.web_dir = Path(web_dir)
        self.now_ms = now_ms
        self.pr_resolver = pr_resolver
        self.review_source = review_source
        self.review_opener = review_opener
        self.update_checker = update_checker
        self.done_store = done_store
        self._done_clock = done_clock
        self._done_lock = threading.Lock()
        self._last_done: float | None = None
        self._provider = board_provider
        self._interval = scan_interval
        self._pr_interval = pr_interval
        # Set once a scan has published a RawSnapshot, and on stop, so the PR thread never waits forever.
        self._pr_wake = threading.Event()
        self._pr_thread = (threading.Thread(target=self._pr_loop, name="tokentown-github", daemon=True)
                           if pr_resolver is not None else None)
        self._review_interval = review_interval
        # Set by every scan, and on stop: the searches need no board, so they run even when a scan fails.
        self._review_wake = threading.Event()
        self._review_thread = (threading.Thread(target=self._review_loop, name="tokentown-reviews", daemon=True)
                               if review_source is not None else None)
        self._update_interval = update_interval
        # Set by every scan, and on stop, as the review thread's is: the first check follows the first scan.
        self._update_wake = threading.Event()
        self._update_thread = (threading.Thread(target=self._update_loop, name="tokentown-updates", daemon=True)
                               if update_checker is not None else None)
        # Set once Update now has left the copy ready to run: serve() then restarts into it.
        self._restarting = threading.Event()
        self._lock = threading.Lock()
        self._scan_lock = threading.Lock()
        self._raw: RawSnapshot | None = None
        self._board: dict | None = None
        self._body: bytes | None = None
        self._etag: str | None = None
        self._good_board: dict | None = None
        self._alerts: tuple[str, ...] = ()
        self._first_scan = threading.Event()
        self._stopping = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="tokentown-scan", daemon=True)

    def snapshot(self) -> tuple[RawSnapshot | None, dict | None, bytes | None, str | None]:
        with self._lock:
            return self._raw, self._board, self._body, self._etag

    def scan_once(self) -> bool:
        with self._scan_lock:
            try:
                raw, board = self._provider()
                board = self._with_source_health(board)
                body, etag = json_bytes(board), board_etag(board)
            except Exception as exc:
                self._publish_failure(exc)
                return False
            else:
                with self._lock:
                    shown = self._with_alerts(board)
                    if shown is not board:
                        body, etag = json_bytes(shown), board_etag(shown)
                    self._raw, self._board, self._body, self._etag = raw, shown, body, etag
                    self._good_board = board
                if raw is not None:
                    self._pr_wake.set()
                self._maintain_done(raw, board)
                return True
            finally:
                self._first_scan.set()
                self._review_wake.set()
                self._update_wake.set()

    def _with_source_health(self, board: dict) -> dict:
        """health.github, health.reviews and health.updates, on a copy: a provider may hand back the same dict every
        scan. Health asks for a look while any of them says gh is not signed in."""
        sources = [("github", self.pr_resolver), ("reviews", self.review_source), ("updates", self.update_checker)]
        sources = [(name, s) for name, s in sources if s is not None]
        if not sources or not isinstance(board, dict):
            return board
        health = board.get("health")
        health = dict(health) if isinstance(health, dict) else {}
        for name, source in sources:
            health[name] = source.health()
        return {**board, "health": with_source_problems(health, [health[name] for name, _ in sources])}

    def _maintain_done(self, raw: RawSnapshot | None, board: dict) -> None:
        """Drop marks the board already ignores (active since), and old marks for sessions that are gone."""
        store = self.done_store
        if store is None or not isinstance(raw, RawSnapshot):
            return
        now = board.get("generatedAt") if isinstance(board, dict) else None
        if type(now) is not int:
            now = self.now_ms()
        try:
            activity = done_activity(raw, now)
            store.forget_if_active(activity)
            store.prune(session_activity(raw, now), now)
            self._apply_valhalla_asks(store, raw, board, now)
        except Exception as exc:
            _log_exception(exc)

    @staticmethod
    def _apply_valhalla_asks(store, raw: RawSnapshot, board: dict, now: int) -> None:
        """A "go to valhalla" message marks its session done once the reply to it has ended, dated at the end of
        that reply so the reply is not activity after the mark. The next scan shows the move."""
        rows = {r.get("id"): r for r in board.get("sessions", ()) if isinstance(r, dict)} \
            if isinstance(board, dict) else {}
        for row_id, (asked_at, done_at) in valhalla_asks(raw, now).items():
            row = rows.get(row_id)
            # Never mid-reply: the activity after such a mark would drop it, and the message would be spent.
            if row is None or row.get("canMarkDone") is not True:
                continue
            if done_at >= asked_at:
                store.apply_ask(row_id, asked_at, done_at)

    def set_done(self, row_id: str, done: bool) -> int:
        """HTTP status: 200 done, 404 no store or not a current row, 409 not allowed, 429 too soon, 500 write failed."""
        store = self.done_store
        if store is None or not valid_row_id(row_id):
            return 404
        with self._lock:
            row = _board_row(self._board, row_id)
        if row is None:
            return 404
        already = row.get("valhallaReason") == "done"
        if done and not already and row.get("canMarkDone") is not True:
            return 409
        with self._done_lock:
            now = self._done_clock()
            if self._last_done is not None and now - self._last_done < DONE_MIN_INTERVAL_S:
                return 429
            self._last_done = now
        try:
            if not done:
                changed = store.unmark(row_id)
            elif already:
                changed = False
            else:
                store.mark(row_id, self.now_ms())
                changed = True
        except Exception as exc:
            _log_exception(exc)
            return 500
        if changed:
            # Rebuild now, so the page's refresh straight after this answer already sees the move.
            self.scan_once()
        return 200

    def refresh_prs_once(self) -> int:
        """One GitHub cycle over the PR URLs of the latest scan. Returns the gh calls made."""
        resolver = self.pr_resolver
        if resolver is None:
            return 0
        with self._lock:
            raw = self._raw
        if raw is None:
            return 0
        try:
            return resolver.refresh(pr_urls(raw))
        except Exception as exc:
            _log_exception(exc)
            return 0

    def _pr_loop(self) -> None:
        self._pr_wake.wait()
        while not self._stopping.is_set():
            self.refresh_prs_once()
            self._stopping.wait(self._pr_interval)

    def refresh_reviews_once(self) -> int:
        """One review cycle: both searches, plus the reviewers of the team visitors and of the PRs the latest board
        shows as open."""
        source = self.review_source
        if source is None:
            return 0
        with self._lock:
            board = self._board
        try:
            return source.refresh(review_urls(board))
        except Exception as exc:
            _log_exception(exc)
            return 0

    def _review_loop(self) -> None:
        self._review_wake.wait()
        while not self._stopping.is_set():
            self.refresh_reviews_once()
            self._stopping.wait(self._review_interval)

    def refresh_updates_once(self) -> int:
        """Read this copy's .git again, and ask GitHub about it when a check is due. Returns the gh calls made."""
        checker = self.update_checker
        if checker is None:
            return 0
        try:
            return checker.refresh()
        except Exception as exc:
            _log_exception(exc)
            return 0

    def _update_loop(self) -> None:
        self._update_wake.wait()
        while not self._stopping.is_set():
            self.refresh_updates_once()
            self._stopping.wait(self._update_interval)

    def update_command(self) -> str | None:
        """The command the page copies to update this copy, or None while there is nothing to do."""
        checker = self.update_checker
        if checker is None:
            return None
        return update_command(checker.code_dir, checker.health())

    @property
    def restarting(self) -> bool:
        return self._restarting.is_set()

    def update_now(self) -> tuple[int, dict | None]:
        """Update now: (HTTP status, JSON body or None). 202 when the server restarts into the copy on disk once this
        answer is sent, 409 with nothing to do, 429 while one is already running, 500 with the step that failed."""
        checker = self.update_checker
        if checker is None:
            return 404, None
        if self._restarting.is_set():
            return 409, None
        outcome, error = checker.update()
        if outcome in ("pulled", "restart"):
            self._restarting.set()
            return 202, {"restarting": True, "pulled": outcome == "pulled"}
        if outcome == "busy":
            return 429, None
        if outcome == "nothing":
            return 409, None
        return 500, {"step": outcome, "error": error}

    def open_review(self, visitor_id: str) -> int:
        """HTTP status: 200 opened, 404 not a current visitor, 429 too soon, 500 open failed.

        The page sends an id and nothing else. The URL comes from the source's own list and is checked against
        PR_URL_RE again inside the opener, immediately before /usr/bin/open.
        """
        source, opener = self.review_source, self.review_opener
        if source is None or opener is None:
            return 404
        if not isinstance(visitor_id, str) or not REVIEW_ID_RE.match(visitor_id):
            return 404
        with self._lock:
            board = self._board
        if _visitor(board, visitor_id) is None:
            return 404
        url = source.url_for(visitor_id)
        if url is None:
            return 404
        return opener.open(url)

    def _publish_failure(self, exc: Exception) -> None:
        _log_exception(exc)
        with self._lock:
            good = self._good_board
        if good is None:
            return
        failed = copy.deepcopy(good)
        health = failed.get("health")
        if not isinstance(health, dict):
            health = failed["health"] = {}
        health["ok"] = False
        warning = f"scan failed: {type(exc).__name__}"
        warnings = [w for w in (health.get("warnings") or []) if w != warning]
        health["warnings"] = warnings + [warning]
        with self._lock:
            failed = self._with_alerts(failed)
            body, etag = json_bytes(failed), board_etag(failed)
            self._board, self._body, self._etag = failed, body, etag

    def _with_alerts(self, board: dict) -> dict:
        """The board with this process's security warnings added. Call with self._lock held."""
        if not self._alerts:
            return board
        shown = copy.deepcopy(board)
        health = shown.get("health")
        if not isinstance(health, dict):
            health = shown["health"] = {}
        health["ok"] = False
        warnings = list(health.get("warnings") or [])
        health["warnings"] = warnings + [a for a in self._alerts if a not in warnings]
        return shown

    def note_replay(self) -> None:
        """A genuine launch code arrived twice: someone else may have claimed a token. Stays until restart."""
        with self._lock:
            if REPLAY_WARNING not in self._alerts:
                self._alerts += (REPLAY_WARNING,)
            if self._board is not None:
                self._board = self._with_alerts(self._board)
                self._body, self._etag = json_bytes(self._board), board_etag(self._board)

    def _loop(self) -> None:
        while not self._stopping.is_set():
            self.scan_once()
            self._stopping.wait(self._interval)

    def start(self) -> None:
        self._thread.start()
        if self._pr_thread is not None:
            self._pr_thread.start()
        if self._review_thread is not None:
            self._review_thread.start()
        if self._update_thread is not None:
            self._update_thread.start()

    def wait_first_scan(self, timeout: float | None = None) -> bool:
        return self._first_scan.wait(timeout)

    def stop(self, timeout: float = 5.0) -> None:
        self._stopping.set()
        self._pr_wake.set()
        self._review_wake.set()
        self._update_wake.set()
        if self._thread.is_alive() and self._thread is not threading.current_thread():
            self._thread.join(timeout)
        # A gh call in flight can take up to 20 s and would outlive this process, so kill it rather than wait.
        for source in (self.pr_resolver, self.review_source, self.update_checker):
            cancel = getattr(source, "cancel", None)
            if callable(cancel):
                try:
                    cancel()
                except Exception as exc:
                    _log_exception(exc)
        for thread in (self._pr_thread, self._review_thread, self._update_thread):
            if thread is not None and thread.is_alive() and thread is not threading.current_thread():
                thread.join(min(timeout, 1.0))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    server_version = "tokentown"
    timeout = 10

    def version_string(self) -> str:
        return "tokentown"

    def log_message(self, format, *args) -> None:
        pass

    def __getattr__(self, name: str):
        # BaseHTTPRequestHandler answers 501 itself for a method with no do_* handler, which would skip
        # the Host guard. Route every method through the same guards instead.
        if name.startswith("do_"):
            method = name[3:]
            return lambda: self._handle(method)
        raise AttributeError(name)

    def end_headers(self) -> None:
        for name, value in security.SECURITY_HEADERS:
            self.send_header(name, value)
        super().end_headers()

    def parse_request(self) -> bool:
        # An HTTP/0.9 request line makes the base class drop the status line and every header,
        # including the security headers, so refuse it before any route runs.
        ok = super().parse_request()
        if ok and self.request_version == "HTTP/0.9":
            self.send_error(400)
            return False
        return ok

    def send_error(self, code, message=None, explain=None) -> None:
        # The stock error page echoes parts of the request; send our headers and no body instead.
        # A request line too broken to name a version leaves HTTP/0.9, which would suppress the
        # status line and every header, so answer those as HTTP/1.0.
        self.close_connection = True
        if getattr(self, "request_version", "HTTP/0.9") == "HTTP/0.9":
            self.request_version = "HTTP/1.0"
        self._send(int(code))

    # ------------------------------------------------------------ plumbing

    def _send(self, status: int, body: bytes = b"", content_type: str | None = None,
              headers: tuple[tuple[str, str], ...] = ()) -> None:
        self._responded = True
        self.send_response(status)
        if content_type:
            self.send_header("Content-Type", content_type)
        for name, value in headers:
            self.send_header(name, value)
        if status != 304:
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body and status != 304 and self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, obj, headers: tuple[tuple[str, str], ...] = ()) -> None:
        self._send(status, json_bytes(obj), JSON_TYPE, headers)

    def _handle(self, method: str) -> None:
        self._responded = False
        self._body_read = False
        self._restart_after = False
        try:
            self._dispatch(self.server.town_app, method)
        except Exception as exc:
            _log_exception(exc)
            if not self._responded:
                try:
                    self._send(500)
                except OSError:
                    pass
        finally:
            self._discard_unread_body()
            if self._restart_after:
                # Only once the 202 is written. shutdown() waits for serve_forever, so never from its own thread.
                threading.Thread(target=self.server.shutdown, name="tokentown-restart", daemon=True).start()

    def _discard_unread_body(self) -> None:
        # Closing a socket with unread input sends RST, and the client can then lose the refusal it was
        # already sent. Throw away a bounded amount so refused requests still get their status.
        headers = getattr(self, "headers", None)
        if self._body_read or headers is None:
            return
        length = (headers.get("Content-Length") or "").strip()
        chunked = headers.get("Transfer-Encoding") is not None
        remaining = int(length) if length.isascii() and length.isdigit() else 0
        if not chunked and remaining == 0:
            return
        limit = DISCARD_LIMIT if chunked else min(remaining, DISCARD_LIMIT)
        deadline = time.monotonic() + 0.5
        try:
            self.connection.settimeout(0.2)
            while limit > 0 and time.monotonic() < deadline:
                chunk = self.rfile.read1(min(limit, 16384))
                if not chunk:
                    break
                limit -= len(chunk)
        except OSError:
            pass

    # ------------------------------------------------------------ guards and routes

    def _dispatch(self, app: App, method: str) -> None:
        h = self.headers
        if not security.host_ok(h.get_all("Host"), app.port):
            return self._send(403)
        if method == "OPTIONS":
            return self._send(403)
        path, _, query = self.path.partition("?")
        is_api = path.startswith("/api/")
        needs_token = is_api and path != "/api/claim"

        if method == "GET":
            if not security.fetch_site_ok(h.get_all("Sec-Fetch-Site"), api=is_api):
                return self._send(403)
            if needs_token and not security.token_ok(h.get_all("X-Town-Token"), app.token):
                return self._send(401)
            if path in STATIC_ROUTES:
                return self._static(app, path)
            if path == "/healthz":
                return self._healthz(app, query)
            if path == "/api/board":
                return self._board(app)
            if path == "/api/releases":
                return self._releases(app)
            return self._send(404)

        if method == "POST":
            if not security.origin_ok(h.get_all("Origin"), app.port):
                return self._send(403)
            if not security.content_type_ok(h.get_all("Content-Type")):
                return self._send(400)
            length = security.body_length(h.get_all("Content-Length"), h.get_all("Transfer-Encoding"))
            if length is None:
                return self._send(400)
            self._body_read = True
            body = self.rfile.read(length) if length else b""
            if len(body) != length:
                return self._send(400)
            keys = POST_KEYS.get(path)
            payload = None
            if keys is not None:
                if path == "/api/done":
                    payload = parse_done_payload(body)
                else:
                    payload = security.parse_json_object(body, keys)
                if payload is None:
                    return self._send(400)
            if needs_token and not security.token_ok(h.get_all("X-Town-Token"), app.token):
                return self._send(401)
            if path == "/api/claim":
                return self._claim(app, payload)
            if path == "/api/open":
                return self._open(app, payload)
            if path == "/api/open-review":
                return self._open_review(app, payload)
            if path == "/api/resume-command":
                return self._resume(app, payload)
            if path == "/api/done":
                return self._done(app, payload)
            if path == "/api/update-command":
                return self._update(app)
            if path == "/api/update":
                return self._update_now(app)
            return self._send(404)

        return self._send(404)

    def _static(self, app: App, path: str) -> None:
        name, content_type = STATIC_ROUTES[path]
        try:
            body = (app.web_dir / name).read_bytes()
        except OSError:
            return self._send(404)
        self._send(200, body, content_type)

    def _healthz(self, app: App, query: str) -> None:
        m = HEALTHZ_QUERY_RE.fullmatch(query)
        if m is None:
            return self._send(400)
        self._send(200, security.health_response(app.secret, m.group(1)).encode("ascii"),
                   "text/plain; charset=utf-8")

    def _board(self, app: App) -> None:
        _, board, body, etag = app.snapshot()
        if board is None or body is None or etag is None:
            return self._json(503, {"scanning": True})
        if _etag_matches(self.headers.get_all("If-None-Match"), etag):
            return self._send(304, headers=(("ETag", etag),))
        self._send(200, body, JSON_TYPE, (("ETag", etag),))

    def _claim(self, app: App, payload: dict[str, str]) -> None:
        result = app.verifier.check(payload["code"], app.now_ms())
        if result == security.CLAIM_REPLAYED:
            app.note_replay()
            return self._send(409)
        if result != security.CLAIM_OK:
            return self._send(403)
        self._json(200, {"token": app.token})

    def _open(self, app: App, payload: dict[str, str]) -> None:
        raw, board, _, _ = app.snapshot()
        status = app.opener.open(payload["id"], board, raw)
        if status == 200:
            return self._json(200, {"ok": True})
        self._send(status if status in (404, 429) else 500)

    def _open_review(self, app: App, payload: dict[str, str]) -> None:
        status = app.open_review(payload["id"])
        if status == 200:
            return self._json(200, {"ok": True})
        self._send(status if status in (404, 429) else 500)

    def _done(self, app: App, payload: dict) -> None:
        status = app.set_done(payload["id"], payload["done"])
        if status == 200:
            return self._json(200, {"ok": True})
        self._send(status if status in (404, 409, 429) else 500)

    def _update(self, app: App) -> None:
        command = app.update_command()
        if command is None:
            return self._send(404)
        self._json(200, {"command": command})

    def _releases(self, app: App) -> None:
        # What the last check brought back, so opening What's new never waits on gh.
        checker = app.update_checker
        if checker is None:
            return self._send(404)
        self._json(200, {"releases": checker.releases()})

    def _update_now(self, app: App) -> None:
        status, body = app.update_now()
        self._restart_after = status == 202
        if body is None:
            return self._send(status)
        self._json(status, body)

    def _resume(self, app: App, payload: dict[str, str]) -> None:
        raw, board, _, _ = app.snapshot()
        command = resume_command(payload["id"], raw, board)
        if command is None:
            return self._send(404)
        self._json(200, {"command": command})


class _Server(ThreadingHTTPServer):
    daemon_threads = True

    def server_bind(self) -> None:
        # HTTPServer.server_bind names the socket with socket.getfqdn(), which can ask a DNS server.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

    def handle_error(self, request, client_address) -> None:
        _log_exception(sys.exception())


def make_server(port: int = PORT, *, board_provider: BoardProvider | None = None, paths: Paths | None = None,
                opener: Opener | None = None, secret: bytes | None = None,
                scan_interval: float = 2.0, pr_resolver: PrStateResolver | None = None,
                pr_interval: float = PR_REFRESH_INTERVAL_S, done_store: DoneStore | None = None,
                done_clock: Callable[[], float] = time.monotonic,
                review_source: ReviewSource | None = None, review_opener: ReviewOpener | None = None,
                review_interval: float = REVIEW_REFRESH_INTERVAL_S, update_checker: UpdateChecker | None = None,
                update_interval: float = UPDATE_REFRESH_INTERVAL_S) -> tuple[ThreadingHTTPServer, App]:
    """Bind (HOST, port) and start the scan thread. Raises OSError when the port is taken.

    With the default board provider a real PrStateResolver, ReviewSource, UpdateChecker and DoneStore under `paths`
    are created unless passed, and the scanner keeps PR links in a LinkStore under `paths`. An injected
    board_provider gets none of them unless passed too, so a test server never runs gh or writes a done or links
    file by accident.
    """
    if paths is None and (secret is None or board_provider is None):
        paths = default_paths()
    if secret is None:
        secret = security.load_or_create_secret(paths)
    if board_provider is None:
        if pr_resolver is None:
            pr_resolver = PrStateResolver()
        if review_source is None:
            review_source = ReviewSource()
        if update_checker is None:
            update_checker = UpdateChecker()
        if done_store is None:
            done_store = DoneStore(paths)
        from .linkstore import LinkStore

        board_provider = default_board_provider(paths, pr_resolver.snapshot, done=done_store.marks,
                                                link_store=LinkStore(paths), reviews=review_source.snapshot)
    if opener is None:
        opener = Opener()
    if review_opener is None and review_source is not None:
        review_opener = ReviewOpener()
    httpd = _Server((HOST, port), Handler)
    try:
        app = App(port=httpd.server_address[1], secret=secret, board_provider=board_provider,
                  opener=opener, scan_interval=scan_interval, pr_resolver=pr_resolver, pr_interval=pr_interval,
                  done_store=done_store, done_clock=done_clock, review_source=review_source,
                  review_opener=review_opener, review_interval=review_interval, update_checker=update_checker,
                  update_interval=update_interval)
        httpd.town_app = app
        app.start()
    except BaseException:
        httpd.server_close()
        raise
    return httpd, app


def restart_argv() -> list[str]:
    """How the server starts again after Update now: the same Python, running the launcher's own serve, so the new
    launcher's Python check runs first. The secret is unchanged, so an open tab's token works once it is back."""
    return [sys.executable, str(CODE_DIR / "tokentown"), "serve"]


def serve(port: int = PORT) -> None:
    paths = default_paths()
    try:
        secret = security.load_or_create_secret(paths)
    except (OSError, ValueError) as exc:
        sys.stderr.write(f"tokentown: cannot use the secret ({type(exc).__name__}). Try: tokentown rotate\n")
        raise SystemExit(1)
    try:
        httpd, app = make_server(port, paths=paths, secret=secret)
    except OSError as exc:
        sys.stderr.write(f"tokentown: cannot listen on {HOST}:{port} ({type(exc).__name__}). "
                         "Is Tokentown or something else already using it?\n")
        raise SystemExit(1)

    def _terminate(signum, frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, _terminate)
    sys.stdout.write(f"Tokentown serving on http://{HOST}:{port}/ (Ctrl-C to stop)\n")
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.stop()
        httpd.server_close()
    if app.restarting:
        sys.stdout.flush()
        os.execv(sys.executable, restart_argv())
