"""Sessions Charlie marked done: they rest on Valhalla island until the session is active again.

Stored in `<secret dir>/done.json` as `{"version": 1, "done": {row_id: doneAt_ms}}`, plus `"asked": {row_id: ms}` once
a "go to valhalla" message has marked a session: the time of the message it acted on, so the same message never marks
the session again after Bring back. Row ids are the only strings kept, so no title, path or prompt is ever written.
"""
from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Iterable, Mapping

from . import privatejson
from .paths import CLI_ROW_ID_RE, LOCAL_ID_RE, Paths

DONE_FILE_NAME = "done.json"
VERSION = 1
DAY_MS = 24 * 60 * 60 * 1000
# A mark stops counting once the session is active this long after it (same grace as the focus rule).
ACTIVE_GRACE_MS = 120_000
PRUNE_AFTER_MS = 90 * DAY_MS
FUTURE_SLACK_MS = DAY_MS
MAX_FILE_BYTES = 1 << 20
# At most 62 bytes a mark on disk, so the cap stays well under MAX_FILE_BYTES: a file over it loads as empty.
MAX_MARKS = 10_000
MAX_MS = 2 ** 53


def _epoch_ms() -> int:
    return time.time_ns() // 1_000_000


def valid_row_id(row_id: object) -> bool:
    return isinstance(row_id, str) and bool(LOCAL_ID_RE.match(row_id) or CLI_ROW_ID_RE.match(row_id))


def _valid_ms(value: object) -> bool:
    return type(value) is int and 0 < value < MAX_MS


def _newest(marks: dict[str, int]) -> dict[str, int]:
    if len(marks) <= MAX_MARKS:
        return marks
    return dict(sorted(marks.items(), key=lambda kv: (kv[1], kv[0]), reverse=True)[:MAX_MARKS])


class DoneStore:
    """Thread-safe done marks. Loading never raises; writes raise OSError and leave the marks unchanged."""

    def __init__(self, paths: Paths, clock_ms=None):
        self._dir = paths.secret_dir
        self._file = paths.secret_dir / DONE_FILE_NAME
        self._clock_ms = clock_ms or _epoch_ms
        self._lock = threading.Lock()
        self._marks, self._asked = self._load()

    @property
    def path(self) -> Path:
        return self._file

    # ------------------------------------------------------------ disk

    def _load(self) -> tuple[dict[str, int], dict[str, int]]:
        obj = privatejson.load(self._file, MAX_FILE_BYTES)
        if not isinstance(obj, dict) or type(obj.get("version")) is not int or obj["version"] != VERSION:
            return {}, {}
        latest = self._clock_ms() + FUTURE_SLACK_MS

        def valid(section: object) -> dict[str, int]:
            if not isinstance(section, dict):
                return {}
            return _newest({k: v for k, v in section.items() if valid_row_id(k) and _valid_ms(v) and v <= latest})

        done = obj.get("done")
        if not isinstance(done, dict):
            return {}, {}
        return valid(done), valid(obj.get("asked"))

    def _write(self, marks: dict[str, int], asked: dict[str, int]) -> None:
        obj = {"version": VERSION, "done": dict(sorted(marks.items()))}
        if asked:
            obj["asked"] = dict(sorted(asked.items()))
        privatejson.write(self._dir, self._file, privatejson.encode(obj), ".done.")

    def _commit(self, marks: dict[str, int], asked: dict[str, int] | None = None) -> None:
        """Write, then swap in memory, so a failed write changes nothing. Call with the lock held.

        Trimmed to the newest MAX_MARKS first, so what is written always loads back.
        """
        marks = _newest(marks)
        asked = _newest(self._asked if asked is None else asked)
        self._write(marks, asked)
        self._marks, self._asked = marks, asked

    # ------------------------------------------------------------ API

    def marks(self) -> dict[str, int]:
        with self._lock:
            return dict(self._marks)

    def mark(self, row_id: str, now: int) -> None:
        if not valid_row_id(row_id):
            raise ValueError("not a board row id")
        if not _valid_ms(now):
            raise ValueError("now must be epoch milliseconds")
        with self._lock:
            if self._marks.get(row_id) == now:
                return
            self._commit({**self._marks, row_id: now})

    def asked(self) -> dict[str, int]:
        with self._lock:
            return dict(self._asked)

    def apply_ask(self, row_id: str, asked_at: int, done_at: int) -> bool:
        """Mark the row done at done_at for the "go to valhalla" message sent at asked_at, unless that message was
        already acted on. True when a mark was written."""
        if not valid_row_id(row_id):
            raise ValueError("not a board row id")
        if not (_valid_ms(asked_at) and _valid_ms(done_at)):
            raise ValueError("times must be epoch milliseconds")
        with self._lock:
            if self._asked.get(row_id) == asked_at:
                return False
            self._commit({**self._marks, row_id: done_at}, {**self._asked, row_id: asked_at})
            return True

    def unmark(self, row_id: str) -> bool:
        """True when a mark was removed."""
        with self._lock:
            if row_id not in self._marks:
                return False
            marks = dict(self._marks)
            del marks[row_id]
            self._commit(marks)
            return True

    def prune(self, valid_ids: Iterable[str], now: int, max_age_ms: int = PRUNE_AFTER_MS) -> int:
        """Remove marks for sessions that no longer exist, once the mark is older than max_age_ms.

        A session can drop out of one scan (a record that failed to parse, a transcript being rewritten),
        so absence alone never removes a mark.
        """
        keep = set(valid_ids)
        with self._lock:
            gone = {k for k, at in self._marks.items() if k not in keep and now - at > max_age_ms}
            gone_asks = {k for k, at in self._asked.items() if k not in keep and now - at > max_age_ms}
            if not gone and not gone_asks:
                return 0
            self._commit({k: v for k, v in self._marks.items() if k not in gone},
                         {k: v for k, v in self._asked.items() if k not in gone_asks})
            return len(gone)

    def forget_if_active(self, activity: Mapping[str, int], grace_ms: int = ACTIVE_GRACE_MS) -> int:
        """Remove marks whose session was active more than grace_ms after the mark. Returns how many."""
        with self._lock:
            stale = {k for k, at in self._marks.items()
                     if type(activity.get(k)) is int and activity[k] > at + grace_ms}
            if not stale:
                return 0
            self._commit({k: v for k, v in self._marks.items() if k not in stale})
            return len(stale)
