from __future__ import annotations

import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from town import linkstore, privatejson
from town.linkstore import LinkStore
from town.model import PrLink
from town.paths import Paths

NOW = 1_800_000_000_000
DAY = 24 * 60 * 60 * 1000
MARKER = "ACME-CLIENT-SECRET-7731"
S1 = "11111111-2222-4333-8444-555555555555"
S2 = "22222222-2222-4333-8444-555555555555"
S3 = "33333333-2222-4333-8444-555555555555"


def url(n: int, repo: str = "o/r") -> str:
    return f"https://github.com/{repo}/pull/{n}"


def link(n: int, ts: int | None = NOW - DAY, u: str | None = "auto", repo: str | None = "o/r") -> PrLink:
    return PrLink(n, url(n) if u == "auto" else u, repo, ts)


class LinkStoreTestCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.paths = Paths(home=Path(tmp.name))
        self.file = self.paths.secret_dir / "links.json"

    def write_raw(self, data: bytes | str) -> None:
        self.paths.secret_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
        self.file.write_bytes(data.encode("utf-8") if isinstance(data, str) else data)
        os.chmod(self.file, 0o600)

    def write_json(self, obj) -> None:
        self.write_raw(json.dumps(obj))


class PersistenceTests(LinkStoreTestCase):
    def test_missing_file_is_empty_and_creates_nothing(self):
        store = LinkStore(self.paths)
        self.assertEqual(store.sessions(), {})
        self.assertFalse(store.remember({}, {S1}, NOW))
        self.assertFalse(self.paths.secret_dir.exists())
        self.assertEqual(store.path, self.file)

    def test_remember_writes_the_exact_shape_and_reloads(self):
        store = LinkStore(self.paths)
        self.assertTrue(store.remember({S1: (link(1, NOW - 2 * DAY), link(2, None)), S2: (link(3),)}, {S1, S2}, NOW))
        self.assertEqual(json.loads(self.file.read_text()), {"version": 1, "sessions": {
            S1: [[2, url(2), None], [1, url(1), NOW - 2 * DAY]], S2: [[3, url(3), NOW - DAY]]}})
        expected = {S1: (PrLink(2, url(2), None, None), PrLink(1, url(1), None, NOW - 2 * DAY)),
                    S2: (PrLink(3, url(3), None, NOW - DAY),)}
        self.assertEqual(store.sessions(), expected)
        self.assertEqual(LinkStore(self.paths).sessions(), expected)

    def test_permissions_dir_0700_file_0600_and_no_temp_files(self):
        LinkStore(self.paths).remember({S1: (link(1),)}, {S1}, NOW)
        self.assertEqual(stat.S_IMODE(os.stat(self.paths.secret_dir).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(self.file).st_mode), 0o600)
        self.assertEqual(sorted(p.name for p in self.paths.secret_dir.iterdir()), ["links.json"])

    def test_links_accumulate_keeping_each_first_time(self):
        store = LinkStore(self.paths)
        store.remember({S1: (link(1, NOW - 5 * DAY),)}, {S1}, NOW)
        # The transcript that recorded #1 is gone; a later scan only sees #2, then a re-mention of #1.
        self.assertTrue(store.remember({S1: (link(2, NOW - DAY),)}, {S1}, NOW))
        self.assertFalse(store.remember({S1: (link(2, NOW - DAY),)}, {S1}, NOW))
        store.remember({S1: (link(1, NOW - 3 * DAY), link(2, NOW - DAY))}, {S1}, NOW)
        self.assertEqual([(g.number, g.timestamp) for g in LinkStore(self.paths).sessions()[S1]],
                         [(1, NOW - 5 * DAY), (2, NOW - DAY)])

    def test_unchanged_links_never_write(self):
        store = LinkStore(self.paths)
        store.remember({S1: (link(1),)}, {S1}, NOW)
        with mock.patch.object(privatejson, "write", side_effect=AssertionError("wrote")):
            self.assertFalse(store.remember({S1: (link(1, repo="x/y"),)}, {S1}, NOW))
            self.assertFalse(store.remember({}, {S1}, NOW))

    def test_only_usable_links_are_kept_and_nothing_else(self):
        bad = (link(4, u=None), link(5, u="javascript:alert(1)"), link(6, u="https://github.com/o/r/pull/0"),
               link(7, u=url(7) + "\n"), link(8, u=f"https://github.com/o/r/pull/8?{MARKER}"),
               PrLink(0, url(9), "o/r", NOW), PrLink(True, url(9), "o/r", NOW), PrLink(9, url(9), MARKER, 1.5),
               link(10, u="https://github.com/../r/pull/10"), link(11, u="https://github.com/" + "a" * 290 + "/r/pull/11"))
        store = LinkStore(self.paths)
        self.assertFalse(store.remember({S1: bad}, {S1}, NOW))
        store.remember({S1: (*bad, PrLink(12, url(12), MARKER, NOW))}, {S1}, NOW)
        self.assertEqual(store.sessions(), {S1: (PrLink(12, url(12), None, NOW),)})
        self.assertNotIn(MARKER, self.file.read_text())
        for sid in (MARKER, S1.upper().replace("1", "A"), "", "cli:" + S1, "local_" + S1):
            self.assertFalse(LinkStore(self.paths).remember({sid: (link(13),)}, {sid}, NOW))

    def test_each_session_keeps_its_newest_links(self):
        store = LinkStore(self.paths)
        many = tuple(link(n, NOW - 100 * DAY + n) for n in range(1, 41))
        store.remember({S1: many}, {S1}, NOW)
        self.assertEqual([g.number for g in LinkStore(self.paths).sessions()[S1]],
                         list(range(41 - linkstore.MAX_LINKS_PER_SESSION, 41)))

    def test_forgets_unknown_sessions_only_when_their_newest_link_is_over_90_days_old(self):
        store = LinkStore(self.paths)
        store.remember({S1: (link(1, NOW - 91 * DAY),), S2: (link(2, NOW - 89 * DAY),), S3: (link(3, NOW - 200 * DAY),)},
                       {S1, S2, S3}, NOW)
        self.assertEqual(set(store.sessions()), {S1, S2, S3})
        self.assertTrue(store.remember({}, {S3}, NOW))
        self.assertEqual(set(LinkStore(self.paths).sessions()), {S2, S3})

    def test_failed_write_changes_nothing(self):
        store = LinkStore(self.paths)
        store.remember({S1: (link(1),)}, {S1}, NOW)
        with mock.patch.object(privatejson.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                store.remember({S2: (link(2),)}, {S1, S2}, NOW)
        self.assertEqual(set(store.sessions()), {S1})
        self.assertEqual(set(LinkStore(self.paths).sessions()), {S1})
        self.assertEqual(sorted(p.name for p in self.paths.secret_dir.iterdir()), ["links.json"])

    def test_read_only_never_writes(self):
        store = LinkStore(self.paths, read_only=True)
        self.assertTrue(store.remember({S1: (link(1),)}, {S1}, NOW))
        self.assertFalse(self.paths.secret_dir.exists())

    def test_a_full_store_is_trimmed_to_a_file_that_loads_back(self):
        # A file over MAX_FILE_BYTES loads as empty, so the newest sessions that fit are written and nothing more.
        long_repo = "o/" + "r" * 260
        sessions = {f"{i:08x}-2222-4333-8444-555555555555":
                    tuple(link(n, NOW - DAY - i, u=url(n, long_repo)) for n in range(1, 17)) for i in range(400)}
        store = LinkStore(self.paths)
        store.remember(sessions, set(sessions), NOW)
        self.assertLessEqual(self.file.stat().st_size, linkstore.MAX_FILE_BYTES)
        loaded = LinkStore(self.paths).sessions()
        self.assertGreater(len(loaded), 100)
        self.assertLess(len(loaded), 400)
        newest_first = sorted(sessions, key=lambda sid: sessions[sid][-1].timestamp, reverse=True)
        self.assertEqual(set(loaded), set(newest_first[:len(loaded)]))


class HostileFileTests(LinkStoreTestCase):
    def assert_empty(self):
        self.assertEqual(LinkStore(self.paths).sessions(), {})

    def test_malformed_files_load_empty(self):
        for body in ("", "{", "[]", "null", '{"version": 2, "sessions": {}}', '{"version": "1", "sessions": {}}',
                     '{"version": 1, "sessions": []}', '{"version": 1}', b"\xff\xfe", '{"version": 1, "sessions": NaN}',
                     "[" * 100_000):
            with self.subTest(body=str(body)[:30]):
                self.write_raw(body)
                self.assert_empty()

    def test_invalid_entries_are_dropped_and_valid_ones_kept(self):
        self.write_json({"version": 1, "sessions": {
            S1: [[1, url(1), NOW], [True, url(2), NOW], ["3", url(3), NOW], [4, "javascript:alert(1)", NOW],
                 [5, url(5), 1.5], [6, url(6), -1], [7, url(7), 2 ** 53], [8, url(8)], [9, url(9), None, MARKER],
                 {"number": 10}, 11, [12, url(12), None]],
            MARKER: [[13, url(13), NOW]],
            S2: "not a list",
            S3: [[0, "https://github.com/o/r/pull/0", NOW]],
        }})
        self.assertEqual(LinkStore(self.paths).sessions(), {S1: (PrLink(12, url(12), None, None),
                                                                 PrLink(1, url(1), None, NOW))})

    def test_oversized_file_is_empty(self):
        self.write_raw(b'{"version": 1, "sessions": {}, "pad": "' + b"x" * linkstore.MAX_FILE_BYTES + b'"}')
        self.assert_empty()

    def test_symlink_is_not_followed(self):
        target = Path(self.paths.home) / "planted.json"
        target.write_text(json.dumps({"version": 1, "sessions": {S1: [[1, url(1), NOW]]}}))
        self.paths.secret_dir.mkdir(parents=True, mode=0o700)
        self.file.symlink_to(target)
        self.assert_empty()
        LinkStore(self.paths).remember({S2: (link(2),)}, {S2}, NOW)
        self.assertFalse(self.file.is_symlink())
        self.assertEqual(json.loads(target.read_text())["sessions"], {S1: [[1, url(1), NOW]]})

    def test_fifo_does_not_hang(self):
        self.paths.secret_dir.mkdir(parents=True, mode=0o700)
        os.mkfifo(self.file)
        self.assert_empty()


if __name__ == "__main__":
    unittest.main()
