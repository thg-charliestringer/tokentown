"""Token totals from transcripts, read incrementally under a per-call byte budget.

Transcripts are append-only JSONL. Each file keeps an offset (bytes consumed, always on a line boundary) and
the last usage seen per assistant message id, because one message is written once per content block and a
later copy can carry different usage. Structure only: ids and integers, never message text.
"""
from __future__ import annotations

import json
import os
import stat as stat_mod
from collections.abc import Collection, Sequence
from pathlib import Path
from typing import Callable

from . import model
from .paths import open_for_read

CHUNK_BYTES = 4 * 1024 * 1024
USAGE_NEEDLE = b'"usage"'
SYNTHETIC_MODEL = "<synthetic>"


def _count(value) -> int:
    return value if type(value) is int and value >= 0 else 0


class _FileState:
    __slots__ = ("ino", "offset", "scanned_to", "stat_ino", "stat_size", "messages", "input", "output",
                 "cache_read", "cache_write", "unkeyed", "context", "stalled")

    def __init__(self, ino: int):
        self.ino = ino
        self.offset = 0  # consumed: every complete line before it is counted
        self.scanned_to = 0  # looked at: may run past offset over a partial trailing line
        self.stat_ino = ino
        self.stat_size = 0
        self.messages: dict[str, tuple[int, int, int, int]] = {}
        self.input = 0
        self.output = 0
        self.cache_read = 0
        self.cache_write = 0
        self.unkeyed = 0  # assistant records with usage but no message id: counted once each
        self.context: int | None = None
        # The last read hit its budget inside the first unconsumed line. Without leave to overspend next time,
        # a line longer than whatever budget is left after earlier files would be re-read and dropped forever.
        self.stalled = False


class _PartialLine:
    """A line split across reads. Joined only when it holds the usage key, so a 20 MB tool result is never
    copied a second time."""
    __slots__ = ("parts", "size", "hit", "tail")

    def __init__(self):
        self.parts: list[bytes] = []
        self.size = 0
        self.hit = False
        self.tail = b""  # last few bytes seen, to catch the key split across two reads

    def add(self, piece: bytes) -> None:
        if not self.hit:
            k = len(USAGE_NEEDLE) - 1
            self.hit = USAGE_NEEDLE in piece or USAGE_NEEDLE in self.tail + piece[:k]
            self.tail = (self.tail + piece[-k:])[-k:]
        self.parts.append(piece)
        self.size += len(piece)


class TokenLedger:
    """Not thread-safe; the scan thread owns it."""

    def __init__(self, open_file: Callable = open_for_read):
        self._open = open_file
        self._files: dict[Path, _FileState] = {}

    # -- public ----------------------------------------------------------------------------------

    def update(self, files: Sequence[Path], byte_budget: int) -> int:
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
            # Nothing read yet this call, or this file stalled last time: allow one line longer than the budget,
            # or a file whose next line exceeds the budget would never move.
            used, read = self._read(path, st, remaining,
                                    allow_overspend=spent == 0 or (state is not None and state.stalled))
            consumed += used
            spent += read
        return consumed

    def totals(self, path: Path) -> model.TokenTotals | None:
        state = self._files.get(Path(path))
        if state is None:
            return None
        return model.TokenTotals(input=state.input, output=state.output, cache_read=state.cache_read,
                                 cache_write=state.cache_write, messages=len(state.messages) + state.unkeyed,
                                 context=state.context)

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
        pos = start  # bytes read so far; everything between line_start and pos is one partial line
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
        # rewritten in place, so the stored counts no longer describe it.
        if state.offset == 0:
            return True
        fh.seek(state.offset - 1)
        return fh.read(1) == b"\n"

    def _ingest_lines(self, state: _FileState, data: bytes, start: int, end: int) -> None:
        """data[start:end] is whole lines (data[start - 1], if any, and data[end - 1] are newlines)."""
        pos = start
        while pos < end:
            i = data.find(USAGE_NEEDLE, pos, end)
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
        if not isinstance(rec, dict) or rec.get("type") != "assistant":
            return
        msg = rec.get("message")
        if not isinstance(msg, dict):
            return
        usage = msg.get("usage")
        if not isinstance(usage, dict) or msg.get("model") == SYNTHETIC_MODEL:
            return
        new = (_count(usage.get("input_tokens")), _count(usage.get("output_tokens")),
               _count(usage.get("cache_read_input_tokens")), _count(usage.get("cache_creation_input_tokens")))
        msg_id = msg.get("id")
        if isinstance(msg_id, str) and msg_id:
            old = state.messages.get(msg_id)
            state.messages[msg_id] = new
        else:
            old = None
            state.unkeyed += 1
        if old is not None:
            state.input -= old[0]
            state.output -= old[1]
            state.cache_read -= old[2]
            state.cache_write -= old[3]
        state.input += new[0]
        state.output += new[1]
        state.cache_read += new[2]
        state.cache_write += new[3]
        if rec.get("isSidechain") is not True:
            state.context = new[0] + new[2] + new[3]
