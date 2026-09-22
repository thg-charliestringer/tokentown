"""PR links the scanner has read from transcripts, kept after the CLI deletes those transcripts.

The CLI deletes transcripts after about a month while desktop records stay, and the app stopped writing prs[] onto
records around August 2026, so a transcript pr-link is often a session's only PR. Without this store a merged session
would slide from the sand castle to the graveyard once its transcript went.

Stored in `<secret dir>/links.json` as `{"version": 1, "sessions": {<cli session uuid>: [[number, url, timestamp or
null], ...]}}`: session UUIDs, PR numbers, PR URLs that pass the gh URL rule and integers. Nothing else.
"""
from __future__ import annotations

import threading
from typing import Collection, Mapping

from . import privatejson
from .github import parse_pr_url
from .model import PrLink
from .paths import UUID_RE, Paths
from .prlinks import MAX_PR_NUMBER, MAX_URL_CHARS, merge_links

LINKS_FILE_NAME = "links.json"
VERSION = 1
DAY_MS = 24 * 60 * 60 * 1000
MAX_FILE_BYTES = 1 << 20
MAX_LINKS_PER_SESSION = 16  # the newest; a session's PR is its newest link
PRUNE_AFTER_MS = 90 * DAY_MS
MAX_MS = 2 ** 53


def usable(link: object) -> bool:
    """A link the board can use: a positive int number and a URL gh could be asked about."""
    return (isinstance(link, PrLink) and type(link.number) is int and 0 < link.number <= MAX_PR_NUMBER
            and isinstance(link.url, str) and len(link.url) <= MAX_URL_CHARS and parse_pr_url(link.url) is not None
            and (link.timestamp is None or (type(link.timestamp) is int and 0 < link.timestamp < MAX_MS)))


def _newest_ts(links: tuple[PrLink, ...]) -> int:
    return max((link.timestamp for link in links if link.timestamp is not None), default=0)


def _trim(links) -> tuple[PrLink, ...]:
    # merge_links keeps each URL's earliest time and orders oldest first.
    kept = tuple(PrLink(link.number, link.url, None, link.timestamp) for link in merge_links([links]) if usable(link))
    return kept[-MAX_LINKS_PER_SESSION:]


def _encode(sessions: dict[str, tuple[PrLink, ...]]) -> bytes:
    """The file body, dropping the sessions with the oldest links first until it fits MAX_FILE_BYTES.

    A file over the limit loads as empty, so it must never be written.
    """
    order = sorted(sessions, key=lambda sid: (-_newest_ts(sessions[sid]), sid))
    kept: dict[str, list] = {}
    size = 64
    for sid in order:
        entry = [[link.number, link.url, link.timestamp] for link in sessions[sid]]
        cost = len(privatejson.encode({sid: entry})) + 1
        if size + cost > MAX_FILE_BYTES:
            break
        kept[sid] = entry
        size += cost
    return privatejson.encode({"version": VERSION, "sessions": kept})


def _decode(obj: object) -> dict[str, tuple[PrLink, ...]]:
    if not isinstance(obj, dict) or type(obj.get("version")) is not int or obj["version"] != VERSION:
        return {}
    sessions = obj.get("sessions")
    if not isinstance(sessions, dict):
        return {}
    out: dict[str, tuple[PrLink, ...]] = {}
    for sid, entry in sessions.items():
        if not (isinstance(sid, str) and UUID_RE.match(sid)) or not isinstance(entry, list):
            continue
        links = []
        for item in entry[:4 * MAX_LINKS_PER_SESSION]:
            if isinstance(item, list) and len(item) == 3:
                link = PrLink(number=item[0], url=item[1], repository=None, timestamp=item[2])
                if usable(link):
                    links.append(link)
        links = _trim(links)
        if links:
            out[sid] = links
    return out


class LinkStore:
    """Thread-safe. Loading never raises; a failed write raises OSError and leaves the store as it was.

    `read_only` (for `tokentown check`) reads the file and never writes it.
    """

    def __init__(self, paths: Paths, *, read_only: bool = False):
        self._dir = paths.secret_dir
        self._file = paths.secret_dir / LINKS_FILE_NAME
        self._read_only = read_only
        self._lock = threading.Lock()
        self._sessions = _decode(privatejson.load(self._file, MAX_FILE_BYTES))

    @property
    def path(self):
        return self._file

    def sessions(self) -> dict[str, tuple[PrLink, ...]]:
        with self._lock:
            return dict(self._sessions)

    def remember(self, links: Mapping[str, tuple[PrLink, ...]], known: Collection[str], now: int) -> bool:
        """Add `links` (by cli session id) to the store, then forget sessions that are not `known` and whose newest link
        is more than 90 days old. Writes only when something changed. Returns whether it did."""
        known_set = set(known)
        with self._lock:
            updated = dict(self._sessions)
            for sid, fresh in links.items():
                if not (isinstance(sid, str) and UUID_RE.match(sid)):
                    continue
                merged = _trim([*updated.get(sid, ()), *fresh])
                if merged:
                    updated[sid] = merged
            for sid in [s for s, kept in updated.items()
                        if s not in known_set and now - _newest_ts(kept) > PRUNE_AFTER_MS]:
                del updated[sid]
            if updated == self._sessions:
                return False
            if not self._read_only:
                privatejson.write(self._dir, self._file, _encode(updated), ".links.")
            self._sessions = updated
            return True
