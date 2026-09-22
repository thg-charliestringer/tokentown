"""Pull request links from transcript `pr-link` records, read incrementally under a per-call byte budget.

The Claude app stopped copying PRs into desktop records' prs[] around August 2026; transcripts still carry a
`pr-link` record for each PR a session opens. Same file discipline as usage.TokenLedger: an offset per file on a
line boundary, a reset when the inode changes or the file shrinks or is rewritten, complete lines only, and a budget
on bytes read. Structure only: the PR number, a URL and repository that pass strict patterns, a time, and the
record's session id (a UUID), which is used to drop links copied in from another session's history.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import replace
import stat as stat_mod
from collections.abc import Collection, Sequence
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

from . import model
from .paths import PR_URL_RE, UUID_RE, open_for_read

CHUNK_BYTES = 4 * 1024 * 1024
NEEDLE = b'"pr-link"'
RECORD_TYPE = "pr-link"
MAX_PR_NUMBER = 9_999_999_999  # PR_URL_RE allows 10 digits
MAX_URL_CHARS = 300
MAX_LINKS_PER_FILE = 256  # distinct links per file (per session id within a file); beyond it the oldest go
REPOSITORY_RE = re.compile(r"^(?!\.\.?/)[A-Za-z0-9_.-]{1,100}/(?!\.\.?\Z)[A-Za-z0-9_.-]{1,100}\Z")

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _iso_ms(value) -> int | None:
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (dt - _EPOCH) // timedelta(milliseconds=1)


def parse_pr_link(rec) -> model.PrLink | None:
    """A PrLink from one decoded transcript record, or None when it is not a usable `pr-link`."""
    if not isinstance(rec, dict) or rec.get("type") != RECORD_TYPE:
        return None
    number = rec.get("prNumber")
    if type(number) is not int or not 0 < number <= MAX_PR_NUMBER:
        return None
    url = rec.get("prUrl")
    if not (isinstance(url, str) and len(url) <= MAX_URL_CHARS and PR_URL_RE.match(url)):
        url = None
    repository = rec.get("prRepository")
    if not (isinstance(repository, str) and REPOSITORY_RE.match(repository)):
        repository = None
    return model.PrLink(number=number, url=url, repository=repository, timestamp=_iso_ms(rec.get("timestamp")))


def record_session(rec: dict) -> str | None:
    """The record's sessionId when it is a UUID; "" when present but malformed; None when absent (older records)."""
    if "sessionId" not in rec:
        return None
    sid = rec["sessionId"]
    return sid if isinstance(sid, str) and UUID_RE.match(sid) else ""


def _rank(link: model.PrLink) -> tuple[bool, int]:
    # A link with no time is older than any link with one.
    return link.timestamp is not None, link.timestamp or 0


def _earliest(a: int | None, b: int | None) -> int | None:
    return b if a is None else a if b is None else min(a, b)


def _latest(a: int | None, b: int | None) -> int | None:
    return b if a is None else a if b is None else max(a, b)


def _key(link: model.PrLink) -> tuple:
    return ("url", link.url) if link.url is not None else ("number", link.repository, link.number)


def merge_links(groups) -> tuple[model.PrLink, ...]:
    """One session's links from several transcripts or stores, with the same rules as a single file.

    Each link keeps the earliest time any group has for it (when it was first linked); its other fields, and its
    place among links linked at the same time, come from the last group that has it.
    """
    best: dict[tuple, tuple[int, model.PrLink]] = {}
    seq = 0
    for group in groups:
        for link in group:
            seq += 1
            old = best.get(_key(link))
            first = link.timestamp if old is None else _earliest(old[1].timestamp, link.timestamp)
            best[_key(link)] = (seq, link if first == link.timestamp else replace(link, timestamp=first))
    ordered = sorted(best.values(), key=lambda item: (_rank(item[1]), item[0]))
    return tuple(link for _seq, link in ordered[-MAX_LINKS_PER_FILE:])


class _Entry:
    """Every copy of one link in one file from one session: first and latest time, and the latest copy's fields."""
    __slots__ = ("first", "last", "seq", "link")

    def __init__(self, first: int | None, last: int | None, seq: int, link: model.PrLink):
        self.first = first
        self.last = last
        self.seq = seq
        self.link = link

    def order(self) -> tuple:
        # Linked earlier sorts earlier. A link mentioned again later does not move: sessions that juggle several
        # PRs re-emit links for all of them, so the latest mention would flip between them.
        return (self.first is not None, self.first or 0, self.last is not None, self.last or 0, self.seq)

    def absorb(self, other: _Entry) -> _Entry:
        newer = other if (other.last is not None, other.last or 0, other.seq) >= \
            (self.last is not None, self.last or 0, self.seq) else self
        return _Entry(_earliest(self.first, other.first), _latest(self.last, other.last), newer.seq, newer.link)


class _FileState:
    __slots__ = ("ino", "offset", "scanned_to", "stat_ino", "stat_size", "stalled", "links", "seq")

    def __init__(self, ino: int):
        self.ino = ino
        self.offset = 0  # consumed: every complete line before it is ingested
        self.scanned_to = 0  # looked at: may run past offset over a partial trailing line
        self.stat_ino = ino
        self.stat_size = 0
        # The last read hit its budget inside the first unconsumed line; see usage._FileState.stalled.
        self.stalled = False
        self.links: dict[tuple, _Entry] = {}  # (record session id, link key) -> entry
        self.seq = 0


class _PartialLine:
    """A line split across reads. Joined only when it holds the needle, so a 20 MB tool result is never copied."""
    __slots__ = ("parts", "size", "hit", "tail")

    def __init__(self):
        self.parts: list[bytes] = []
        self.size = 0
        self.hit = False
        self.tail = b""

    def add(self, piece: bytes) -> None:
        if not self.hit:
            k = len(NEEDLE) - 1
            self.hit = NEEDLE in piece or NEEDLE in self.tail + piece[:k]
            self.tail = (self.tail + piece[-k:])[-k:]
        self.parts.append(piece)
        self.size += len(piece)


class PrLinkIndex:
    """Not thread-safe; the scan thread owns it."""

    def __init__(self, open_file: Callable = open_for_read):
        self._open = open_file
        self._files: dict[Path, _FileState] = {}

    # -- public ----------------------------------------------------------------------------------

    def update(self, files: Sequence[Path], byte_budget: int) -> int:
        """Reads new complete lines, in the order given, until byte_budget bytes have been read. Returns bytes consumed."""
        consumed = 0
        spent = 0  # bytes read from disk, including a partial line that is dropped and read again later
        for raw_path in files:
            path = Path(raw_path)
            try:
                st = os.stat(path, follow_symlinks=False)
            except (OSError, ValueError):
                continue
            if not stat_mod.S_ISREG(st.st_mode):
                continue
            state = self._files.get(path)
            if state is not None:
                state.stat_ino, state.stat_size = st.st_ino, st.st_size
                if state.ino == st.st_ino and state.scanned_to == st.st_size:
                    continue
            remaining = byte_budget - spent
            if remaining <= 0:
                continue
            used, read = self._read(path, st, remaining,
                                    allow_overspend=spent == 0 or (state is not None and state.stalled))
            consumed += used
            spent += read
        return consumed

    def links(self, path: Path, sessions: Collection[str] | None = None) -> tuple[model.PrLink, ...]:
        """Distinct links (by URL; by repository and number when the URL was refused), oldest first.

        Each link's timestamp is its first record's. With `sessions`, only records whose sessionId is one of them or
        the file's own stem count (records with no sessionId still do): a forked or duplicated transcript carries
        copies of another session's pr-link records under that session's id.
        """
        path = Path(path)
        state = self._files.get(path)
        if state is None:
            return ()
        allowed = None if sessions is None else {s for s in sessions if isinstance(s, str) and s} | {path.stem}
        best: dict[tuple, _Entry] = {}
        for (sid, key), entry in state.links.items():
            if allowed is not None and sid is not None and sid not in allowed:
                continue
            old = best.get(key)
            best[key] = entry if old is None else old.absorb(entry)
        ordered = sorted(best.values(), key=_Entry.order)
        return tuple(e.link if e.link.timestamp == e.first else replace(e.link, timestamp=e.first) for e in ordered)

    def is_complete(self, path: Path) -> bool:
        state = self._files.get(Path(path))
        return state is not None and state.ino == state.stat_ino and state.scanned_to == state.stat_size

    def forget(self, keep: Collection[Path]) -> None:
        keep_set = {Path(p) for p in keep}
        for path in [p for p in self._files if p not in keep_set]:
            del self._files[path]

    # -- reading ---------------------------------------------------------------------------------

    def _read(self, path: Path, lst: os.stat_result, budget: int, allow_overspend: bool) -> tuple[int, int]:
        """(bytes consumed, bytes read)."""
        try:
            fh = self._open(path, "rb")
        except (OSError, ValueError):
            return 0, 0
        try:
            with fh:
                st = os.fstat(fh.fileno())
                if st.st_ino != lst.st_ino or not stat_mod.S_ISREG(st.st_mode):
                    return 0, 0  # swapped (for a symlink, say) between the stat and the open
                return self._read_open(path, fh, st, budget, allow_overspend)
        except (OSError, ValueError):
            return 0, 0

    def _read_open(self, path: Path, fh, st: os.stat_result, budget: int,
                   allow_overspend: bool) -> tuple[int, int]:
        size = st.st_size
        state = self._files.get(path)
        if state is None or state.ino != st.st_ino or size < state.offset or not self._on_boundary(fh, state):
            state = _FileState(st.st_ino)
            self._files[path] = state
        state.stat_ino, state.stat_size = st.st_ino, size

        start = state.offset
        limit = min(size, start + budget)
        fh.seek(start)
        pos = start
        line_start = start
        read = 0
        partial = _PartialLine()
        while True:
            if pos < limit:
                overspend = False
                block = fh.read(min(CHUNK_BYTES, limit - pos))
            elif allow_overspend and line_start == start and pos < size:
                overspend = True
                block = fh.read(CHUNK_BYTES)
            else:
                break
            if not block:
                break
            pos += len(block)
            read += len(block)
            first_nl = block.find(b"\n")
            if first_nl < 0:
                partial.add(block)
                continue
            seg = 0
            if partial.size:
                partial.add(block[:first_nl + 1])
                if partial.hit:
                    self._ingest(state, b"".join(partial.parts))
                line_start += partial.size
                partial = _PartialLine()
                seg = first_nl + 1
            end = first_nl + 1 if overspend else block.rfind(b"\n") + 1
            if end > seg:
                self._ingest_lines(state, block, seg, end)
                line_start += end - seg
            if overspend:
                pos = line_start  # finish just that one line; later bytes stay unread
                break
            if end < len(block):
                partial.add(block[end:])

        state.offset = line_start
        state.scanned_to = pos
        state.stalled = line_start == start and pos < size
        if pos > state.stat_size:
            state.stat_size = pos  # grew while we read
        return line_start - start, read

    @staticmethod
    def _on_boundary(fh, state: _FileState) -> bool:
        # An append-only file still has a newline just before the offset. Anything else means it was
        # rewritten in place, so the stored links no longer describe it.
        if state.offset == 0:
            return True
        fh.seek(state.offset - 1)
        return fh.read(1) == b"\n"

    def _ingest_lines(self, state: _FileState, data: bytes, start: int, end: int) -> None:
        """data[start:end] is whole lines (data[start - 1], if any, and data[end - 1] are newlines)."""
        pos = start
        while pos < end:
            i = data.find(NEEDLE, pos, end)
            if i < 0:
                return
            nl = data.rfind(b"\n", pos, i)
            first = nl + 1 if nl >= 0 else pos
            last = data.find(b"\n", i, end)
            self._ingest(state, data[first:last])
            pos = last + 1

    @staticmethod
    def _ingest(state: _FileState, line: bytes) -> None:
        try:
            rec = json.loads(line)
        except (ValueError, RecursionError):
            return
        link = parse_pr_link(rec)
        if link is None:
            return
        key = (record_session(rec), _key(link))
        state.seq += 1
        entry = _Entry(link.timestamp, link.timestamp, state.seq, link)
        old = state.links.get(key)
        state.links[key] = entry if old is None else old.absorb(entry)
        if len(state.links) > MAX_LINKS_PER_FILE:
            oldest = min(state.links, key=lambda k: state.links[k].order())
            del state.links[oldest]
