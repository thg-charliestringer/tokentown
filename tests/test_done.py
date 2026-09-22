"""DoneStore: persistence, permissions, hostile files, pruning and thread safety. Temp homes only."""
from __future__ import annotations

import json
import os
import stat
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from town import done as done_mod, privatejson
from town.done import DoneStore
from town.paths import Paths

NOW = 1_800_000_000_000
MIN = 60_000
DAY = 24 * 60 * MIN
A = "local_11111111-2222-4333-8444-555555555555"
B = "local_22222222-2222-4333-8444-555555555555"
C = "cli:33333333-2222-4333-8444-555555555555"


class DoneStoreTestCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.paths = Paths(home=Path(tmp.name))
        self.file = self.paths.secret_dir / "done.json"

    def store(self) -> DoneStore:
        return DoneStore(self.paths, clock_ms=lambda: NOW)

    def write_raw(self, data: bytes | str, mode: int = 0o600) -> None:
        self.paths.secret_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
        if isinstance(data, str):
            data = data.encode("utf-8")
        self.file.write_bytes(data)
        os.chmod(self.file, mode)

    def write_json(self, obj) -> None:
        self.write_raw(json.dumps(obj))


class PersistenceTests(DoneStoreTestCase):
    def test_missing_file_is_empty_and_creates_nothing(self):
        s = self.store()
        self.assertEqual(s.marks(), {})
        self.assertFalse(self.paths.secret_dir.exists())
        self.assertFalse(s.unmark(A))
        self.assertFalse(self.paths.secret_dir.exists())
        self.assertEqual(s.path, self.file)

    def test_mark_writes_the_exact_shape_and_reloads(self):
        s = self.store()
        s.mark(A, NOW - MIN)
        s.mark(C, NOW)
        self.assertEqual(json.loads(self.file.read_text()), {"version": 1, "done": {A: NOW - MIN, C: NOW}})
        self.assertEqual(self.store().marks(), {A: NOW - MIN, C: NOW})
        s.mark(A, NOW)
        self.assertEqual(self.store().marks(), {A: NOW, C: NOW})

    def test_unmark_removes_and_persists(self):
        s = self.store()
        s.mark(A, NOW)
        s.mark(B, NOW)
        self.assertTrue(s.unmark(A))
        self.assertFalse(s.unmark(A))
        self.assertEqual(self.store().marks(), {B: NOW})

    def test_marks_is_a_copy(self):
        s = self.store()
        s.mark(A, NOW)
        got = s.marks()
        got[B] = NOW
        got[A] = 1
        self.assertEqual(s.marks(), {A: NOW})

    def test_permissions_dir_0700_file_0600(self):
        old = os.umask(0)
        try:
            self.store().mark(A, NOW)
        finally:
            os.umask(old)
        self.assertEqual(stat.S_IMODE(os.lstat(self.paths.secret_dir).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.lstat(self.file).st_mode), 0o600)

    def test_loose_dir_and_file_are_tightened_on_write(self):
        self.write_json({"version": 1, "done": {A: NOW}})
        os.chmod(self.paths.secret_dir, 0o755)
        os.chmod(self.file, 0o644)
        s = self.store()
        s.mark(B, NOW)
        self.assertEqual(stat.S_IMODE(os.lstat(self.paths.secret_dir).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.lstat(self.file).st_mode), 0o600)
        self.assertEqual(self.store().marks(), {A: NOW, B: NOW})

    def test_no_temp_files_left_behind(self):
        s = self.store()
        for i in range(5):
            s.mark(A, NOW + i)
        s.unmark(A)
        self.assertEqual(sorted(p.name for p in self.paths.secret_dir.iterdir()), ["done.json"])

    def test_mark_refuses_bad_ids_and_times(self):
        s = self.store()
        for bad in ("../secret", "local_x", A + "\n", A.upper(), "cli:" + A, "", None, 5):
            with self.subTest(id=bad):
                with self.assertRaises(ValueError):
                    s.mark(bad, NOW)
        for bad in (0, -1, True, 1.5, "1", 2 ** 60):
            with self.subTest(now=bad):
                with self.assertRaises(ValueError):
                    s.mark(A, bad)
        self.assertFalse(self.file.exists())

    def test_failed_write_changes_nothing(self):
        s = self.store()
        s.mark(A, NOW)
        before = self.file.read_bytes()
        with mock.patch.object(privatejson.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                s.mark(B, NOW)
            with self.assertRaises(OSError):
                s.unmark(A)
        self.assertEqual(s.marks(), {A: NOW})
        self.assertEqual(self.file.read_bytes(), before)
        self.assertEqual(sorted(p.name for p in self.paths.secret_dir.iterdir()), ["done.json"])

    def test_write_replaces_a_symlink_instead_of_following_it(self):
        target = Path(self.paths.home) / "elsewhere.txt"
        target.write_text("untouched")
        self.paths.secret_dir.mkdir(parents=True, mode=0o700)
        self.file.symlink_to(target)
        s = self.store()
        self.assertEqual(s.marks(), {})
        s.mark(A, NOW)
        self.assertEqual(target.read_text(), "untouched")
        self.assertFalse(self.file.is_symlink())
        self.assertEqual(self.store().marks(), {A: NOW})

    def test_symlinked_or_foreign_directory_refuses_to_write(self):
        real = Path(self.paths.home) / "real"
        real.mkdir(mode=0o700)
        self.paths.secret_dir.parent.mkdir(parents=True)
        self.paths.secret_dir.symlink_to(real)
        with self.assertRaises(PermissionError):
            self.store().mark(A, NOW)
        self.assertEqual(list(real.iterdir()), [])

    def test_a_directory_at_the_file_name(self):
        self.paths.secret_dir.mkdir(parents=True, mode=0o700)
        self.file.mkdir()
        s = self.store()
        self.assertEqual(s.marks(), {})
        with self.assertRaises(OSError):
            s.mark(A, NOW)
        self.assertEqual(s.marks(), {})


class HostileFileTests(DoneStoreTestCase):
    def assert_empty(self):
        self.assertEqual(self.store().marks(), {})

    def test_malformed_files_load_empty_and_never_raise(self):
        cases = [
            b"", b"{", b"null", b"[]", b'"done"', b"\xff\xfe{}", b"{\"version\": 1, \"done\": NaN}",
            b'{"version": 1}', b'{"done": {}}', b'{"version": 2, "done": {}}', b'{"version": "1", "done": {}}',
            b'{"version": true, "done": {}}', b'{"version": 1.0, "done": {}}', b'{"version": 1, "done": []}',
            b'{"version": 1, "done": "x"}', b"[" * 100_000, json.dumps({"version": 1, "done": {A: NOW}}).encode()[:-1],
        ]
        for data in cases:
            with self.subTest(data=data[:40]):
                self.write_raw(data)
                self.assert_empty()

    def test_invalid_entries_are_dropped_and_valid_ones_kept(self):
        self.write_json({"version": 1, "extra": "ignored", "done": {
            A: NOW - DAY,
            C: NOW,
            B: True,
            "local_33333333-2222-4333-8444-555555555555": 1.8e12,
            "local_44444444-2222-4333-8444-555555555555": "1800000000000",
            "local_55555555-2222-4333-8444-555555555555": 0,
            "local_66666666-2222-4333-8444-555555555555": -1,
            "local_77777777-2222-4333-8444-555555555555": NOW + DAY + 1,
            "local_88888888-2222-4333-8444-555555555555": None,
            "local_99999999-2222-4333-8444-555555555555": 2 ** 80,
            "../../etc/passwd": NOW,
            "local_x": NOW,
            A.upper(): NOW,
            A + "\n": NOW,
            "<script>": NOW,
        }})
        self.assertEqual(self.store().marks(), {A: NOW - DAY, C: NOW})

    def test_far_future_is_measured_against_the_clock(self):
        self.write_json({"version": 1, "done": {A: NOW + DAY, B: NOW + DAY + 1}})
        self.assertEqual(self.store().marks(), {A: NOW + DAY})

    def test_oversized_file_is_empty(self):
        entries = {f"local_{i:08x}-2222-4333-8444-555555555555": NOW for i in range(30_000)}
        body = json.dumps({"version": 1, "done": entries})
        self.assertGreater(len(body), done_mod.MAX_FILE_BYTES)
        self.write_raw(body)
        self.assert_empty()

    def test_too_many_marks_keeps_the_newest(self):
        with mock.patch.object(done_mod, "MAX_MARKS", 3):
            ids = [f"local_{i:08x}-2222-4333-8444-555555555555" for i in range(5)]
            self.write_json({"version": 1, "done": {rid: NOW - i for i, rid in enumerate(ids)}})
            self.assertEqual(self.store().marks(), {ids[0]: NOW, ids[1]: NOW - 1, ids[2]: NOW - 2})

    def test_a_full_store_writes_a_file_that_loads_back_whole(self):
        # A file over MAX_FILE_BYTES loads as empty, so the mark cap must keep every write under it.
        widest = f'"local_{"f" * 8}-ffff-4fff-8fff-{"f" * 12}":{done_mod.MAX_MS - 1},'
        self.assertLess(done_mod.MAX_MARKS * len(widest) + 64, done_mod.MAX_FILE_BYTES)
        ids = [f"local_{i:08x}-2222-4333-8444-555555555555" for i in range(done_mod.MAX_MARKS + 5)]
        marks = {rid: NOW - DAY + i for i, rid in enumerate(ids)}
        s = self.store()
        with s._lock:
            s._commit(marks)
        self.assertLessEqual(self.file.stat().st_size, done_mod.MAX_FILE_BYTES)
        newest = {rid: at for rid, at in marks.items() if at >= NOW - DAY + 5}
        self.assertEqual(len(newest), done_mod.MAX_MARKS)
        self.assertEqual(s.marks(), newest)
        self.assertEqual(self.store().marks(), newest)

    def test_marking_past_the_cap_drops_the_oldest(self):
        with mock.patch.object(done_mod, "MAX_MARKS", 2):
            s = self.store()
            s.mark(A, NOW - 2 * MIN)
            s.mark(B, NOW - MIN)
            s.mark(C, NOW)
            self.assertEqual(s.marks(), {B: NOW - MIN, C: NOW})
            self.assertEqual(json.loads(self.file.read_text())["done"], {B: NOW - MIN, C: NOW})

    def test_symlink_is_not_followed_on_load(self):
        target = Path(self.paths.home) / "planted.json"
        target.write_text(json.dumps({"version": 1, "done": {A: NOW}}))
        self.paths.secret_dir.mkdir(parents=True, mode=0o700)
        self.file.symlink_to(target)
        self.assert_empty()

    def test_fifo_does_not_hang(self):
        self.paths.secret_dir.mkdir(parents=True, mode=0o700)
        os.mkfifo(self.file)
        result = []
        t = threading.Thread(target=lambda: result.append(self.store().marks()), daemon=True)
        t.start()
        t.join(5)
        self.assertEqual(result, [{}])

    def test_file_owned_by_someone_else_is_ignored(self):
        self.write_json({"version": 1, "done": {A: NOW}})
        real_fstat = os.fstat

        def foreign(fd):
            st = real_fstat(fd)
            fields = list(st)
            fields[stat.ST_UID] = st.st_uid + 1
            return os.stat_result(fields)

        with mock.patch.object(privatejson.os, "fstat", side_effect=foreign):
            self.assert_empty()
        self.assertEqual(self.store().marks(), {A: NOW})

    def test_unreadable_file_is_empty(self):
        self.write_json({"version": 1, "done": {A: NOW}})
        with mock.patch.object(privatejson.os, "open", side_effect=PermissionError("denied")):
            self.assert_empty()


class PruneAndForgetTests(DoneStoreTestCase):
    def test_prune_needs_both_absence_and_age(self):
        s = self.store()
        s.mark(A, NOW - 91 * DAY)
        s.mark(B, NOW - 89 * DAY)
        s.mark(C, NOW - 200 * DAY)
        self.assertEqual(s.prune({C}, NOW), 1)
        self.assertEqual(s.marks(), {B: NOW - 89 * DAY, C: NOW - 200 * DAY})
        self.assertEqual(s.prune([B], NOW - 2 * DAY), 1)
        self.assertEqual(s.marks(), {B: NOW - 89 * DAY})
        self.assertEqual(s.prune(iter(()), NOW), 0)
        self.assertEqual(s.prune(iter(()), NOW + 2 * DAY), 1)
        self.assertEqual(self.store().marks(), {})

    def test_prune_boundary_is_strictly_older_than_90_days(self):
        s = self.store()
        s.mark(A, NOW - 90 * DAY)
        self.assertEqual(s.prune((), NOW), 0)
        self.assertEqual(s.prune((), NOW + 1), 1)

    def test_prune_without_changes_does_not_write(self):
        s = self.store()
        s.mark(A, NOW)
        with mock.patch.object(DoneStore, "_write", side_effect=AssertionError("wrote")):
            self.assertEqual(s.prune({A}, NOW + 365 * DAY), 0)
            self.assertEqual(s.forget_if_active({A: NOW}), 0)
            self.assertEqual(s.forget_if_active({}), 0)

    def test_forget_if_active(self):
        s = self.store()
        s.mark(A, NOW)
        s.mark(B, NOW)
        s.mark(C, NOW)
        removed = s.forget_if_active({A: NOW + 120_000, B: NOW + 120_001, "cli:other": NOW + DAY})
        self.assertEqual(removed, 1)
        self.assertEqual(s.marks(), {A: NOW, C: NOW})
        self.assertEqual(s.forget_if_active({A: True, C: "later", "x": NOW + DAY}), 0)
        self.assertEqual(self.store().marks(), {A: NOW, C: NOW})


class ThreadSafetyTests(DoneStoreTestCase):
    def test_concurrent_marks_all_land_and_the_file_stays_valid(self):
        s = self.store()
        ids = [f"local_{i:08x}-2222-4333-8444-555555555555" for i in range(40)]
        errors = []

        def work(chunk):
            try:
                for rid in chunk:
                    s.mark(rid, NOW)
                    s.marks()
            except Exception as exc:  # pragma: no cover - reported below
                errors.append(exc)

        threads = [threading.Thread(target=work, args=(ids[i::4],)) for i in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        self.assertEqual(errors, [])
        self.assertEqual(s.marks(), {rid: NOW for rid in ids})
        self.assertEqual(self.store().marks(), {rid: NOW for rid in ids})


class AskTests(DoneStoreTestCase):
    def test_an_ask_marks_once_and_bring_back_holds_across_a_reload(self):
        s = self.store()
        self.assertTrue(s.apply_ask(A, NOW - MIN, NOW))
        self.assertEqual((s.marks(), s.asked()), ({A: NOW}, {A: NOW - MIN}))
        self.assertEqual(json.loads(self.file.read_text()), {"version": 1, "done": {A: NOW}, "asked": {A: NOW - MIN}})
        self.assertFalse(s.apply_ask(A, NOW - MIN, NOW + MIN))
        self.assertTrue(s.unmark(A))
        self.assertFalse(s.apply_ask(A, NOW - MIN, NOW + MIN))
        again = self.store()
        self.assertEqual((again.marks(), again.asked()), ({}, {A: NOW - MIN}))
        self.assertFalse(again.apply_ask(A, NOW - MIN, NOW + MIN))
        self.assertTrue(again.apply_ask(A, NOW + 5 * MIN, NOW + 6 * MIN))
        self.assertEqual(again.marks(), {A: NOW + 6 * MIN})

    def test_asked_is_written_only_once_used_and_pruned_with_its_session(self):
        s = self.store()
        s.mark(B, NOW)
        self.assertNotIn("asked", json.loads(self.file.read_text()))
        s.apply_ask(A, NOW - 100 * DAY, NOW - 100 * DAY)
        s.prune([B], NOW)
        self.assertEqual((s.marks(), s.asked()), ({B: NOW}, {}))

    def test_apply_ask_refuses_bad_ids_and_times(self):
        s = self.store()
        for args in (("x", NOW, NOW), (A, 0, NOW), (A, NOW, -1), (A, True, NOW)):
            with self.subTest(args=args), self.assertRaises(ValueError):
                s.apply_ask(*args)
        self.assertFalse(self.file.exists())

if __name__ == "__main__":
    unittest.main()
