from __future__ import annotations

import builtins
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from town import model, paths as paths_mod, usage
from town.usage import TokenLedger

MARKER = "ACME-CLIENT-SECRET-7731"
BIG = 10 ** 9


def assistant(msg_id: str | None, inp: int = 0, out: int = 0, cr: int = 0, cw: int = 0, *, sidechain: bool = False,
              model_name: str = "claude-opus-5", text: str = MARKER) -> dict:
    message = {
        "model": model_name, "role": "assistant", "type": "message", "stop_reason": None,
        "content": [{"type": "text", "text": f"{text} usage is here"}],
        "usage": {"input_tokens": inp, "cache_creation_input_tokens": cw, "cache_read_input_tokens": cr,
                  "output_tokens": out, "service_tier": "standard", "cache_creation": {"ephemeral_1h_input_tokens": cw}},
    }
    if msg_id is not None:
        message["id"] = msg_id
    return {"type": "assistant", "isSidechain": sidechain, "uuid": "u", "timestamp": "2026-09-17T08:00:00.000Z",
            "message": message}


def line(record) -> bytes:
    return json.dumps(record).encode() + b"\n"


def lines(records) -> bytes:
    return b"".join(line(r) for r in records)


class SpyOpen:
    """Delegates to paths.open_for_read and counts opens and bytes read."""

    def __init__(self):
        self.opens: list[str] = []
        self.bytes_read = 0

    def __call__(self, path, mode="rb"):
        self.opens.append(Path(path).name)
        fh = paths_mod.open_for_read(path, mode)
        spy = self

        class Wrapped:
            def fileno(self):
                return fh.fileno()

            def seek(self, *args):
                return fh.seek(*args)

            def read(self, n=-1):
                data = fh.read(n)
                spy.bytes_read += len(data)
                return data

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                fh.close()

        return Wrapped()


class LedgerTestCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)

    def path(self, name: str = "a.jsonl") -> Path:
        return self.dir / name

    def write(self, path: Path, data: bytes) -> None:
        with open(path, "wb") as fh:
            fh.write(data)

    def append(self, path: Path, data: bytes) -> None:
        with open(path, "ab") as fh:
            fh.write(data)

    def one_shot(self, data: bytes) -> model.TokenTotals:
        path = self.path("one-shot.jsonl")
        self.write(path, data)
        ledger = TokenLedger()
        ledger.update([path], BIG)
        return ledger.totals(path)


class DedupeTests(LedgerTestCase):
    def test_last_record_per_message_id_wins(self):
        p = self.path()
        self.write(p, lines([
            assistant("msg_A", 10, 1, 100, 5),
            assistant("msg_A", 10, 1, 100, 5),
            assistant("msg_A", 10, 50, 100, 5),
            assistant("msg_B", 20, 7, 0, 0),
        ]))
        ledger = TokenLedger()
        self.assertEqual(ledger.update([p], BIG), p.stat().st_size)
        self.assertEqual(ledger.totals(p), model.TokenTotals(input=30, output=57, cache_read=100, cache_write=5,
                                                             messages=2, context=20))

    def test_changed_usage_on_a_repeat_adjusts_totals_across_updates(self):
        p = self.path()
        self.write(p, lines([assistant("msg_A", 3, 5, 1000, 40), assistant("msg_B", 1, 1, 1, 1)]))
        ledger = TokenLedger()
        ledger.update([p], BIG)
        self.assertEqual(ledger.totals(p).output, 6)

        self.append(p, line(assistant("msg_A", 4, 120, 1000, 0)))
        ledger.update([p], BIG)
        self.assertEqual(ledger.totals(p), model.TokenTotals(input=5, output=121, cache_read=1001, cache_write=1,
                                                             messages=2, context=1004))

        self.append(p, line(assistant("msg_A", 0, 2, 0, 0)))  # a later copy can also be smaller
        ledger.update([p], BIG)
        self.assertEqual(ledger.totals(p), model.TokenTotals(input=1, output=3, cache_read=1, cache_write=1,
                                                             messages=2, context=0))

    def test_records_without_an_id_count_once_each(self):
        p = self.path()
        self.write(p, lines([assistant(None, 1, 2), assistant(None, 1, 2), assistant("", 1, 2)]))
        ledger = TokenLedger()
        ledger.update([p], BIG)
        self.assertEqual(ledger.totals(p), model.TokenTotals(input=3, output=6, messages=3, context=1))


class IncrementalTests(LedgerTestCase):
    def test_partial_trailing_line_waits(self):
        p = self.path()
        first = line(assistant("msg_A", 1, 2))
        second = line(assistant("msg_B", 10, 20))
        self.write(p, first + second[:25])
        ledger = TokenLedger()
        self.assertEqual(ledger.update([p], BIG), len(first))
        self.assertEqual(ledger.totals(p), model.TokenTotals(input=1, output=2, messages=1, context=1))
        self.assertTrue(ledger.is_complete(p))  # every whole line is counted; the rest is not a line yet

        self.append(p, second[25:])
        self.assertFalse(ledger.update([p], 0))
        self.assertFalse(ledger.is_complete(p))
        self.assertEqual(ledger.update([p], BIG), len(second))
        self.assertEqual(ledger.totals(p), model.TokenTotals(input=11, output=22, messages=2, context=10))
        self.assertTrue(ledger.is_complete(p))

    def test_appends_are_read_incrementally(self):
        p = self.path()
        spy = SpyOpen()
        ledger = TokenLedger(open_file=spy)
        self.write(p, lines([assistant(f"msg_{i}", 1, 1, text=MARKER * 50) for i in range(40)]))
        ledger.update([p], BIG)
        self.assertEqual(spy.bytes_read, p.stat().st_size)

        spy.bytes_read = 0
        added = line(assistant("msg_new", 7, 9))
        self.append(p, added)
        self.assertEqual(ledger.update([p], BIG), len(added))
        self.assertLessEqual(spy.bytes_read, len(added) + 1)  # plus the boundary byte before the offset
        self.assertEqual(ledger.totals(p).messages, 41)
        self.assertEqual(ledger.totals(p).output, 49)

    def test_warm_update_with_nothing_appended_does_not_open(self):
        p = self.path()
        self.write(p, lines([assistant("msg_A", 1, 1)]))
        spy = SpyOpen()
        ledger = TokenLedger(open_file=spy)
        ledger.update([p], BIG)
        for _ in range(3):
            self.assertEqual(ledger.update([p], BIG), 0)
        self.assertEqual(len(spy.opens), 1)

    def test_budget_spans_several_updates_and_resumes_exactly(self):
        records = []
        for i in range(60):
            records.append(assistant(f"msg_{i // 3}", i, i + 1, 2 * i, i % 7, sidechain=i % 11 == 0,
                                     text=MARKER * (i % 5)))
        data = lines(records) + b"not json but has \"usage\"\n"
        p = self.path()
        self.write(p, data)
        expected = self.one_shot(data)

        ledger = TokenLedger()
        budget = 777
        calls = 0
        consumed_total = 0
        while not ledger.is_complete(p):
            consumed = ledger.update([p], budget)
            self.assertLessEqual(consumed, budget)
            self.assertGreater(consumed, 0)
            consumed_total += consumed
            calls += 1
            self.assertLess(calls, 500)
        self.assertGreater(calls, 3)
        self.assertEqual(consumed_total, len(data))
        self.assertEqual(ledger.totals(p), expected)

    def test_budget_is_shared_across_files_in_priority_order(self):
        a, b = self.path("a.jsonl"), self.path("b.jsonl")
        a_lines = [line(assistant(f"msg_a{i}", 1, 1)) for i in range(20)]
        self.write(a, b"".join(a_lines))
        self.write(b, lines([assistant("msg_b", 5, 5)]))
        budget = sum(len(x) for x in a_lines[:10])
        ledger = TokenLedger()
        self.assertEqual(ledger.update([a, b], budget), budget)
        self.assertEqual(ledger.totals(a).messages, 10)
        self.assertIsNone(ledger.totals(b))
        self.assertFalse(ledger.is_complete(a))
        self.assertFalse(ledger.is_complete(b))

        calls = 1
        while not (ledger.is_complete(a) and ledger.is_complete(b)):
            ledger.update([a, b], budget)
            calls += 1
            self.assertLess(calls, 10)
        self.assertEqual(ledger.totals(a).messages, 20)
        self.assertEqual(ledger.totals(b).output, 5)

    def test_a_line_longer_than_the_budget_still_makes_progress(self):
        long_line = line(assistant("msg_long", 3, 4, text=MARKER * 400))
        p, q = self.path("p.jsonl"), self.path("q.jsonl")
        self.write(p, long_line + line(assistant("msg_2", 1, 1)))
        self.write(q, line(assistant("msg_q", 1, 1)))
        ledger = TokenLedger()
        self.assertEqual(ledger.update([p, q], 100), len(long_line))
        self.assertEqual(ledger.totals(p).output, 4)
        self.assertIsNone(ledger.totals(q))
        while not (ledger.is_complete(p) and ledger.is_complete(q)):
            ledger.update([p, q], 100)
        self.assertEqual(ledger.totals(p).messages, 2)
        self.assertEqual(ledger.totals(q).messages, 1)

    def test_budget_caps_bytes_read_not_just_bytes_consumed(self):
        # A long line that does not fit the budget left after an earlier file is read and dropped. Those bytes
        # must still count, or every later file gets the same budget again and one update reads several times it.
        budget = 10_000
        small_a, small_b = self.path("small_a.jsonl"), self.path("small_b.jsonl")
        self.write(small_a, line(assistant("msg_sa", 1, 1)))
        self.write(small_b, line(assistant("msg_sb", 1, 1)))
        longs = [self.path(f"long_{i}.jsonl") for i in range(4)]
        long_line = line(assistant("msg_long", 2, 3, text=MARKER * 900))
        self.assertGreater(len(long_line), 2 * budget)
        for p in longs:
            self.write(p, long_line)
        files = [small_a, *longs, small_b]

        with mock.patch("town.usage.CHUNK_BYTES", 4096):
            spy = SpyOpen()
            ledger = TokenLedger(open_file=spy)
            ledger.update(files, budget)
            self.assertLessEqual(spy.bytes_read, budget)

            calls = 1
            while not all(ledger.is_complete(p) for p in files):
                spy.bytes_read = 0
                ledger.update(files, budget)
                # One overspent line (plus the read block it ends in) at most.
                self.assertLessEqual(spy.bytes_read, len(long_line) + 4096 + 1)
                calls += 1
                self.assertLess(calls, 20)
        for p in longs:
            self.assertEqual(ledger.totals(p), model.TokenTotals(input=2, output=3, messages=1, context=2))
        self.assertEqual(ledger.totals(small_b).messages, 1)

    def test_long_line_behind_a_growing_file_still_makes_progress(self):
        # Charging read bytes means a file that grows every update can leave too little budget for a long line
        # behind it. The stalled file gets leave to overspend next time, so it and everything after it move.
        budget = 10_000
        live, stuck, after = self.path("live.jsonl"), self.path("stuck.jsonl"), self.path("after.jsonl")
        self.write(live, line(assistant("msg_live0", 1, 1)))
        self.write(stuck, line(assistant("msg_stuck", 4, 5, text=MARKER * 900)))
        self.write(after, line(assistant("msg_after", 6, 7)))
        ledger = TokenLedger()
        for i in range(1, 6):
            ledger.update([live, stuck, after], budget)
            self.append(live, line(assistant(f"msg_live{i}", 1, 1)))
            if ledger.is_complete(stuck) and ledger.is_complete(after):
                break
        self.assertEqual(ledger.totals(stuck).output, 5)
        self.assertTrue(ledger.is_complete(after))
        self.assertEqual(ledger.totals(after).output, 7)

    def test_lines_spanning_read_chunks_are_whole(self):
        records = [assistant(f"msg_{i % 9}", i, 2 * i, 3 * i, i % 4, sidechain=i % 5 == 0, text=MARKER * (i % 13))
                   for i in range(80)]
        data = lines(records)
        expected = self.one_shot(data)
        p = self.path()
        self.write(p, data)
        for chunk, budget in ((7, BIG), (64, BIG), (7, 500), (1000, 333)):
            with self.subTest(chunk=chunk, budget=budget), mock.patch("town.usage.CHUNK_BYTES", chunk):
                ledger = TokenLedger()
                total = 0
                for _ in range(1000):
                    if ledger.is_complete(p):
                        break
                    total += ledger.update([p], budget)
                self.assertEqual(total, len(data))
                self.assertEqual(ledger.totals(p), expected)

    def test_usage_key_split_across_reads_is_found(self):
        text = b'{"a": 1, "message": {"usage": {}}}\n'
        key_at = text.index(b'"usage"')
        for cut1 in range(1, len(text)):
            for cut2 in (cut1 + 1, cut1 + 3, key_at + 4):
                pieces = [text[:cut1], text[cut1:cut2], text[cut2:]] if cut1 < cut2 else [text[:cut1], text[cut1:]]
                partial = usage._PartialLine()
                for piece in pieces:
                    if piece:
                        partial.add(piece)
                self.assertTrue(partial.hit, (cut1, cut2))
                self.assertEqual(b"".join(partial.parts), text)
        partial = usage._PartialLine()
        for i in range(len(text)):
            partial.add(text[i:i + 1].replace(b"u", b"v"))
        self.assertFalse(partial.hit)

    def test_empty_file_is_complete_with_zero_totals(self):
        p = self.path()
        self.write(p, b"")
        ledger = TokenLedger()
        self.assertEqual(ledger.update([p], BIG), 0)
        self.assertEqual(ledger.totals(p), model.TokenTotals())
        self.assertTrue(ledger.is_complete(p))


class ResetTests(LedgerTestCase):
    def test_truncation_resets(self):
        p = self.path()
        self.write(p, lines([assistant(f"msg_{i}", 100, 100) for i in range(5)]))
        ledger = TokenLedger()
        ledger.update([p], BIG)
        self.assertEqual(ledger.totals(p).output, 500)

        smaller = lines([assistant("msg_x", 1, 2)])
        self.write(p, smaller)  # same inode, shorter than the stored offset
        self.assertEqual(ledger.update([p], BIG), len(smaller))
        self.assertEqual(ledger.totals(p), model.TokenTotals(input=1, output=2, messages=1, context=1))

    def test_inode_change_resets(self):
        p = self.path()
        self.write(p, lines([assistant("msg_A", 100, 100)]))
        ledger = TokenLedger()
        ledger.update([p], BIG)
        old_ino = p.stat().st_ino

        replacement = lines([assistant("msg_B", 1, 2), assistant("msg_C", 3, 4), assistant("msg_A", 0, 1)])
        tmp = self.path("replacement.tmp")
        self.write(tmp, replacement)
        os.replace(tmp, p)
        self.assertNotEqual(p.stat().st_ino, old_ino)
        self.assertFalse(ledger.update([p], 0))
        self.assertFalse(ledger.is_complete(p))
        self.assertEqual(ledger.update([p], BIG), len(replacement))
        self.assertEqual(ledger.totals(p), model.TokenTotals(input=4, output=7, messages=3, context=0))

    def test_rewrite_in_place_off_the_line_boundary_resets(self):
        p = self.path()
        original = lines([assistant("msg_A", 100, 100)])
        self.write(p, original)
        ledger = TokenLedger()
        ledger.update([p], BIG)

        rewritten = lines([assistant("msg_B", 1, 2, text="x"), assistant("msg_C", 3, 4)])
        self.assertNotEqual(rewritten[len(original) - 1:len(original)], b"\n")
        with open(p, "r+b") as fh:
            fh.write(rewritten)
        self.assertEqual(ledger.update([p], BIG), len(rewritten))
        self.assertEqual(ledger.totals(p), model.TokenTotals(input=4, output=6, messages=2, context=3))


class RecordRuleTests(LedgerTestCase):
    def test_sidechain_counts_in_totals_but_not_context(self):
        p = self.path()
        self.write(p, lines([
            assistant("msg_A", 10, 1, 200, 30),
            assistant("msg_S", 99, 5, 9000, 900, sidechain=True),
        ]))
        ledger = TokenLedger()
        ledger.update([p], BIG)
        self.assertEqual(ledger.totals(p), model.TokenTotals(input=109, output=6, cache_read=9200, cache_write=930,
                                                             messages=2, context=240))

    def test_context_is_none_without_a_main_chain_record(self):
        p = self.path()
        self.write(p, lines([assistant("msg_S", 1, 1, sidechain=True)]))
        ledger = TokenLedger()
        ledger.update([p], BIG)
        self.assertIsNone(ledger.totals(p).context)
        self.assertEqual(ledger.totals(p).messages, 1)

    def test_synthetic_records_are_ignored(self):
        p = self.path()
        self.write(p, lines([
            assistant("msg_A", 10, 1, 5, 5),
            assistant("msg_err", 777, 777, 777, 777, model_name="<synthetic>"),
            assistant("msg_A", 777, 777, 777, 777, model_name="<synthetic>"),
        ]))
        ledger = TokenLedger()
        ledger.update([p], BIG)
        self.assertEqual(ledger.totals(p), model.TokenTotals(input=10, output=1, cache_read=5, cache_write=5,
                                                             messages=1, context=20))

    def test_malformed_lines_are_skipped(self):
        p = self.path()
        bad_values = assistant("msg_bad", 0, 0)
        bad_values["message"]["usage"] = {"input_tokens": "12", "output_tokens": 3.5, "cache_read_input_tokens": -4,
                                          "cache_creation_input_tokens": True}
        no_usage_dict = assistant("msg_nd")
        no_usage_dict["message"]["usage"] = [1, 2]
        string_message = {"type": "assistant", "message": "usage"}
        tool_result = {"type": "user", "toolUseResult": {"usage": {"input_tokens": 5000, "output_tokens": 5000}},
                       "message": {"role": "user", "usage": {"input_tokens": 5000, "output_tokens": 5000}}}
        data = b"".join([
            line(assistant("msg_A", 1, 2, 3, 4)),
            b'{"type": "assistant", "message": {"usage": {"input_tokens": 9\n',
            b'\xff\xfe "usage" not utf-8 \xc3\n',
            b'["usage"]\n',
            b'"usage"\n',
            b"\n",
            b"   \n",
            b'{"deep": ' + b"[" * 100000 + b'"usage"\n',
            line(string_message),
            line(no_usage_dict),
            line(bad_values),
            line(tool_result),
            line({"type": "assistant"}),
            line(assistant("msg_B", 10, 20, 30, 40)),
        ])
        self.write(p, data)
        ledger = TokenLedger()
        self.assertEqual(ledger.update([p], BIG), len(data))
        self.assertEqual(ledger.totals(p), model.TokenTotals(input=11, output=22, cache_read=33, cache_write=44,
                                                             messages=3, context=80))
        self.assertTrue(ledger.is_complete(p))


class SafetyTests(LedgerTestCase):
    def test_default_open_enforces_the_denylist(self):
        good = self.path("a.jsonl")
        key = self.path("123.key")
        config = self.path("config.json")
        local_storage = self.dir / "Local Storage"
        local_storage.mkdir()
        leveldb = local_storage / "000003.log"
        for p in (good, key, config, leveldb):
            self.write(p, line(assistant("msg_A", 1, 1)))

        real_open = builtins.open
        opened: list[str] = []

        def recording_open(file, *args, **kwargs):
            opened.append(os.fspath(file))
            return real_open(file, *args, **kwargs)

        ledger = TokenLedger()
        with mock.patch("builtins.open", side_effect=recording_open):
            ledger.update([key, config, leveldb, good], BIG)
        self.assertEqual(opened, [os.fspath(good)])
        for denied in (key, config, leveldb):
            self.assertIsNone(ledger.totals(denied))
            self.assertFalse(ledger.is_complete(denied))
        self.assertEqual(ledger.totals(good).messages, 1)

    def test_injected_open_file_is_the_only_reader(self):
        p = self.path()
        self.write(p, line(assistant("msg_A", 1, 1)))
        calls: list[str] = []

        def refuse(path, mode="rb"):
            calls.append(mode)
            raise PermissionError("denied")

        ledger = TokenLedger(open_file=refuse)
        with mock.patch("builtins.open", side_effect=AssertionError("bypassed open_file")):
            self.assertEqual(ledger.update([p], BIG), 0)
        self.assertEqual(calls, ["rb"])
        self.assertIsNone(ledger.totals(p))

    def test_missing_directories_and_symlinks_are_skipped(self):
        real = self.path("real.jsonl")
        self.write(real, line(assistant("msg_A", 1, 1)))
        link = self.path("link.jsonl")
        link.symlink_to(real)
        folder = self.path("folder.jsonl")
        folder.mkdir()
        missing = self.path("missing.jsonl")
        ledger = TokenLedger()
        self.assertEqual(ledger.update([missing, folder, link], BIG), 0)
        for p in (missing, folder, link):
            self.assertIsNone(ledger.totals(p))
            self.assertFalse(ledger.is_complete(p))

    def test_state_keeps_ids_and_integers_only(self):
        p = self.path()
        records = []
        for i in range(300):
            records.append(assistant(f"msg_{i % 3}", i, i, i, i, text=MARKER * 200))
        self.write(p, lines(records))
        ledger = TokenLedger()
        ledger.update([p], BIG)

        state = ledger._files[p]
        self.assertEqual(len(state.messages), 3)
        strings: list[str] = []

        def walk(value):
            if isinstance(value, bool) or value is None or isinstance(value, int):
                return
            if isinstance(value, str):
                strings.append(value)
            elif isinstance(value, dict):
                for k, v in value.items():
                    walk(k)
                    walk(v)
            elif isinstance(value, tuple):
                for v in value:
                    walk(v)
            else:
                self.fail(f"unexpected state value of type {type(value).__name__}")

        for slot in type(state).__slots__:
            walk(getattr(state, slot))
        self.assertEqual(sorted(strings), ["msg_0", "msg_1", "msg_2"])
        self.assertFalse(any(MARKER in s for s in strings))
        self.assertFalse(hasattr(state, "__dict__"))


class ForgetAndQueryTests(LedgerTestCase):
    def test_forget_drops_untracked_files(self):
        a, b = self.path("a.jsonl"), self.path("b.jsonl")
        self.write(a, line(assistant("msg_A", 1, 1)))
        self.write(b, line(assistant("msg_B", 2, 2)))
        ledger = TokenLedger()
        ledger.update([a, b], BIG)
        ledger.forget([a])
        self.assertIsNotNone(ledger.totals(a))
        self.assertIsNone(ledger.totals(b))
        self.assertFalse(ledger.is_complete(b))
        ledger.forget([])
        self.assertIsNone(ledger.totals(a))

    def test_unknown_path_is_not_read_and_not_complete(self):
        ledger = TokenLedger()
        self.assertIsNone(ledger.totals(self.path("never.jsonl")))
        self.assertFalse(ledger.is_complete(self.path("never.jsonl")))

    def test_zero_budget_still_notices_growth(self):
        p = self.path()
        self.write(p, line(assistant("msg_A", 1, 1)))
        ledger = TokenLedger()
        ledger.update([p], BIG)
        self.assertTrue(ledger.is_complete(p))
        self.append(p, line(assistant("msg_B", 1, 1)))
        self.assertEqual(ledger.update([p], 0), 0)
        self.assertFalse(ledger.is_complete(p))
        self.assertEqual(ledger.totals(p).messages, 1)


if __name__ == "__main__":
    unittest.main()
