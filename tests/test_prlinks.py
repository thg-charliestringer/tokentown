from __future__ import annotations

import builtins
import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from town import model, paths as paths_mod, prlinks
from town.paths import PR_URL_RE
from town.prlinks import PrLinkIndex, parse_pr_link

MARKER = "ACME-CLIENT-SECRET-7731"
BIG = 10 ** 9
T0 = int(datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc).timestamp() * 1000)


def iso(ms: int) -> str:
    dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms % 1000:03d}Z"


def link_record(number=12, ts: int | None = T0, *, repo="o/r", url="auto", **extra) -> dict:
    r = {"type": "pr-link", "sessionId": "00000001-0000-4000-8000-000000000001", "prNumber": number,
         "prUrl": f"https://github.com/{repo}/pull/{number}" if url == "auto" else url, "prRepository": repo}
    if ts is not None:
        r["timestamp"] = iso(ts)
    r.update(extra)
    return r


def noise(i: int = 0, pad: int = 0) -> dict:
    """An ordinary record: hostile text, no pr-link needle."""
    return {"type": "assistant", "uuid": f"u{i}", "timestamp": iso(T0),
            "message": {"role": "assistant", "content": [{"type": "text", "text": MARKER + "x" * pad}]}}


def line(record) -> bytes:
    return json.dumps(record).encode() + b"\n"


def lines(records) -> bytes:
    return b"".join(line(r) for r in records)


def url(number, repo="o/r"):
    return f"https://github.com/{repo}/pull/{number}"


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


class IndexTestCase(unittest.TestCase):
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

    def one_shot(self, data: bytes) -> tuple[model.PrLink, ...]:
        path = self.path("one-shot.jsonl")
        self.write(path, data)
        index = PrLinkIndex()
        index.update([path], BIG)
        return index.links(path)


# ---------------------------------------------------------------------------------------------------


class PrUrlReTests(unittest.TestCase):
    def test_valid(self):
        for value in ("https://github.com/Acme-DataTeam/wonderful-things-core/pull/532",
                      "https://github.com/o.r-g/re_po.x/pull/1", "https://github.com/a/b/pull/1234567890",
                      "https://github.com/.github/.github/pull/7", "https://github.com/o/.../pull/1",
                      "https://github.com/o/r/pull/0"):
            with self.subTest(url=value):
                self.assertIsNotNone(PR_URL_RE.match(value))

    def test_hostile(self):
        for value in (
                "https://github.com/../../pull/1", "https://github.com/o/../pull/1", "https://github.com/./r/pull/1",
                "https://github.com/o/./pull/1", "https://github.com/../r/pull/1",
                "https://github.com/ｏ/r/pull/1", "https://github.com/o/r/pull/١٢", "https://github.com/o/r/pull/１",
                "https://github.com/é/r/pull/1", "https://github.com/o/r/pull/12345678901",
                "https://github.com/o/r/pull/1\n", "https://github.com/o/r/pull/1\r\n--method=DELETE",
                "https://github.com/o/r/pull/1/files", "https://github.com/o/r/pull/1/../../../user",
                "https://github.com/o/r/pull/1?x=1", "https://github.com/o/r/pull/1#frag",
                "https://github.com/o/r/pull/abc", "https://github.com/o/r/pull/-1", "https://github.com/o/r/pull/",
                "https://github.com/o/r/pull/1 --method=DELETE", "https://github.com/o/x/r/pull/1",
                "https://github.com/o%2Fx/r/pull/1", "https://github.com//r/pull/1", "https://github.com/o//pull/1",
                "https://github.com/{owner}/{repo}/pull/1", "http://github.com/o/r/pull/1",
                "https://github.com.evil.example/o/r/pull/1", "https://evil.example/github.com/o/r/pull/1",
                "https://github.com/o/r/issues/1", " https://github.com/o/r/pull/1", "javascript:alert(1)", ""):
            with self.subTest(url=value):
                self.assertIsNone(PR_URL_RE.match(value))

    def test_name_and_flags_unchanged(self):
        self.assertEqual(PR_URL_RE.flags & 8, 0)  # not MULTILINE: ^ and \Z anchor the whole string


class ParseTests(unittest.TestCase):
    def test_valid_record(self):
        self.assertEqual(parse_pr_link(link_record(532, T0, repo="Acme-DataTeam/wonderful-things-core")),
                         model.PrLink(number=532, url=url(532, "Acme-DataTeam/wonderful-things-core"),
                                      repository="Acme-DataTeam/wonderful-things-core", timestamp=T0))

    def test_only_pr_link_records(self):
        for rtype in ("user", "assistant", "pr_link", "PR-LINK", None, 7):
            with self.subTest(type=rtype):
                self.assertIsNone(parse_pr_link(link_record(type=rtype)))
        for value in (None, [], "pr-link", 12, [link_record()]):
            self.assertIsNone(parse_pr_link(value))

    def test_number_must_be_a_positive_int(self):
        for number in (0, -1, True, False, 1.0, 12.5, "12", None, [12], 10 ** 10, 10 ** 40):
            with self.subTest(number=number):
                self.assertIsNone(parse_pr_link(link_record(number, url=url(1))))
        self.assertEqual(parse_pr_link(link_record(9_999_999_999)).number, 9_999_999_999)
        rec = link_record()
        del rec["prNumber"]
        self.assertIsNone(parse_pr_link(rec))

    def test_hostile_url_is_dropped_but_the_link_kept(self):
        for value in ("https://github.com/../../pull/1", "https://github.com/ｏ/r/pull/12", "javascript:alert(1)",
                      f"https://github.com/o/r/pull/12?{MARKER}", "https://github.com/o/r/pull/12\n",
                      "https://github.com/" + "a" * 400 + "/r/pull/12", 12, None, ["x"]):
            with self.subTest(url=value):
                got = parse_pr_link(link_record(12, url=value))
                self.assertEqual((got.number, got.url, got.repository), (12, None, "o/r"))

    def test_hostile_repository_is_dropped(self):
        for repo in ("o", "o/r/x", "../r", "./r", "o/..", "o/.", "o/r\n", "ｏ/r", f"o/{MARKER} x", "/r", "o/", "a" * 101 + "/r", 7, None):
            with self.subTest(repo=repo):
                rec = link_record(12, url=url(12))
                rec["prRepository"] = repo
                got = parse_pr_link(rec)
                self.assertEqual((got.number, got.url, got.repository), (12, url(12), None))

    def test_timestamps(self):
        self.assertEqual(parse_pr_link(link_record(ts=None)).timestamp, None)
        for value, expected in (("2026-09-01T12:00:00.000Z", T0), ("2026-09-01T13:00:00+01:00", T0),
                                ("2026-09-01T12:00:00", T0), ("yesterday", None), (T0, None), ("x" * 50, None)):
            with self.subTest(value=value):
                rec = link_record()
                rec["timestamp"] = value
                self.assertEqual(parse_pr_link(rec).timestamp, expected)

    def test_nothing_else_is_kept(self):
        got = parse_pr_link(link_record(extra=MARKER, sessionId=MARKER, cwd=MARKER))
        self.assertNotIn(MARKER, repr(got))


# ---------------------------------------------------------------------------------------------------


class LinkSetTests(IndexTestCase):
    def test_distinct_by_url_ordered_by_when_each_was_first_linked(self):
        data = lines([
            link_record(1, T0 + 5000),
            noise(1),
            link_record(2, T0 + 1000),
            link_record(1, T0 + 9000, repo="o/r"),  # mentioned again later: #1 stays where it was first linked
            link_record(3, T0 + 3000),
            link_record(2, T0),  # an earlier copy read later moves #2 back to its first time
        ])
        self.assertEqual(self.one_shot(data), (
            model.PrLink(2, url(2), "o/r", T0),
            model.PrLink(3, url(3), "o/r", T0 + 3000),
            model.PrLink(1, url(1), "o/r", T0 + 5000),
        ))

    def test_a_session_juggling_prs_keeps_the_most_recently_opened_one_last(self):
        # Re-mentions cycle through every PR the session knows; the newest opened must not flip with them.
        cycle = [link_record(n, T0 + 1000 * (10 + i)) for i, n in enumerate([1, 2, 3, 1, 2, 3, 2, 1])]
        data = lines([link_record(1, T0), link_record(2, T0 + 100), link_record(3, T0 + 200), *cycle])
        self.assertEqual([g.number for g in self.one_shot(data)], [1, 2, 3])

    def test_missing_timestamps_count_as_oldest_and_ties_keep_the_later_copy(self):
        data = lines([
            link_record(5, T0),
            link_record(6, None),
            link_record(7, None, repo="a/b"),
            link_record(5, T0, repo="o/r", prRepository="x/y"),  # same URL and time: the later copy wins
        ])
        got = self.one_shot(data)
        self.assertEqual([(g.number, g.timestamp) for g in got], [(6, None), (7, None), (5, T0)])
        self.assertEqual(got[-1].repository, "x/y")

    def test_links_without_a_url_are_distinct_by_repository_and_number(self):
        data = lines([
            link_record(8, T0, url="javascript:alert(1)"),
            link_record(8, T0 + 1, url=None),
            link_record(8, T0 + 2, repo="a/b", url=None),
            link_record(8, T0 + 3),
        ])
        got = self.one_shot(data)
        self.assertEqual([(g.url, g.repository, g.timestamp) for g in got],
                         [(None, "o/r", T0), (None, "a/b", T0 + 2), (url(8), "o/r", T0 + 3)])

    def test_links_per_file_are_capped_dropping_the_oldest(self):
        data = lines([link_record(n, T0 + n) for n in range(1, 11)] + [link_record(99, None)])
        with mock.patch.object(prlinks, "MAX_LINKS_PER_FILE", 4):
            got = self.one_shot(data)
        self.assertEqual([g.number for g in got], [7, 8, 9, 10])

    def test_prefilter_skips_json_for_lines_without_the_needle(self):
        data = lines([noise(i, pad=2000) for i in range(50)] + [link_record(4)] + [noise(99)])
        p = self.path()
        self.write(p, data)
        with mock.patch.object(prlinks.json, "loads", wraps=json.loads) as loads:
            index = PrLinkIndex()
            index.update([p], BIG)
        self.assertEqual(loads.call_count, 1)
        self.assertEqual([g.number for g in index.links(p)], [4])

    def test_needle_inside_text_or_the_wrong_record_is_not_a_link(self):
        decoy_user = {"type": "user", "message": {"content": '{"type":"pr-link","prNumber":5}'}}
        decoy_nested = {"type": "attachment", "attachment": {"type": "pr-link", "prNumber": 6,
                                                             "prUrl": url(6)}}
        decoy_key = {"type": "system", "pr-link": {"prNumber": 7}}
        data = lines([decoy_user, decoy_nested, decoy_key]) + b'{"type": "pr-link", "prNumber": 9\n' + \
            b"NaN \"pr-link\"\n" + b"[" * 100_000 + b'"pr-link"\n' + lines([link_record(10)])
        self.assertEqual([g.number for g in self.one_shot(data)], [10])


class SessionFilterTests(IndexTestCase):
    OWN = "0000000a-0000-4000-8000-00000000000a"
    PRIOR = "00000003-0000-4000-8000-000000000003"
    PARENT = "00000002-0000-4000-8000-000000000002"

    def index_for(self, records) -> tuple[PrLinkIndex, Path]:
        p = self.path(f"{self.OWN}.jsonl")
        self.write(p, lines(records))
        index = PrLinkIndex()
        index.update([p], BIG)
        return index, p

    def test_records_copied_from_another_session_are_dropped(self):
        index, p = self.index_for([
            link_record(1, T0, sessionId=self.PARENT), link_record(1, T0, sessionId=self.PARENT),
            link_record(2, T0 + 5, sessionId=self.OWN), link_record(3, T0 + 9, sessionId=self.PARENT),
            link_record(4, T0 + 7, sessionId=self.PRIOR),
        ])
        self.assertEqual([g.number for g in index.links(p)], [1, 2, 4, 3])
        self.assertEqual([g.number for g in index.links(p, {self.OWN})], [2])
        self.assertEqual([g.number for g in index.links(p, ())], [2])  # the file's own stem always counts
        self.assertEqual([g.number for g in index.links(p, [self.OWN, self.PRIOR])], [2, 4])
        self.assertEqual([g.number for g in index.links(p, {self.PARENT})], [1, 2, 3])

    def test_a_missing_session_id_counts_and_a_malformed_one_does_not(self):
        missing = link_record(5, T0)
        del missing["sessionId"]
        hostile = [link_record(6, T0, sessionId=value) for value in
                   (MARKER, self.OWN.upper(), self.OWN + "\n", 12, None, [self.OWN], "")]
        index, p = self.index_for([missing, *hostile])
        self.assertEqual([g.number for g in index.links(p, {self.OWN})], [5])
        self.assertEqual([g.number for g in index.links(p)], [5, 6])
        self.assertNotIn(MARKER, repr(index._files))

    def test_a_pr_the_parent_linked_first_takes_the_time_of_the_own_link(self):
        index, p = self.index_for([link_record(7, T0, sessionId=self.PARENT), link_record(8, T0 + 10, sessionId=self.OWN),
                                   link_record(7, T0 + 50, sessionId=self.OWN)])
        self.assertEqual([(g.number, g.timestamp) for g in index.links(p, {self.OWN})], [(8, T0 + 10), (7, T0 + 50)])
        self.assertEqual([(g.number, g.timestamp) for g in index.links(p)], [(7, T0), (8, T0 + 10)])


class MergeTests(unittest.TestCase):
    def test_merge_keeps_the_earliest_time_and_the_last_group_fields(self):
        a = (model.PrLink(1, url(1), "o/r", T0), model.PrLink(2, url(2), "o/r", T0 + 5))
        b = (model.PrLink(1, url(1), "x/y", T0), model.PrLink(2, url(2), "o/r", T0 + 1),
             model.PrLink(3, None, "o/r", None))
        self.assertEqual(prlinks.merge_links([a, b]), (
            model.PrLink(3, None, "o/r", None), model.PrLink(1, url(1), "x/y", T0),
            model.PrLink(2, url(2), "o/r", T0 + 1)))
        c = (model.PrLink(2, url(2), "a/b", None),)
        self.assertEqual(prlinks.merge_links([a, c])[-1], model.PrLink(2, url(2), "a/b", T0 + 5))
        self.assertEqual(prlinks.merge_links([]), ())
        self.assertEqual(prlinks.merge_links(iter([(), a])), a)

    def test_merge_is_capped_keeping_the_newest(self):
        groups = [tuple(model.PrLink(n, url(n), "o/r", T0 + n) for n in range(g * 10, g * 10 + 10)) for g in range(3)]
        with mock.patch.object(prlinks, "MAX_LINKS_PER_FILE", 5):
            self.assertEqual([link.number for link in prlinks.merge_links(groups)], [25, 26, 27, 28, 29])


class IncrementalTests(IndexTestCase):
    def test_partial_trailing_line_waits(self):
        p = self.path()
        whole = line(link_record(1, T0))
        self.write(p, line(link_record(2, T0 + 1)) + whole[:20])
        index = PrLinkIndex()
        index.update([p], BIG)
        self.assertEqual([g.number for g in index.links(p)], [2])
        self.assertTrue(index.is_complete(p))  # read to the end, even though the last line is not whole yet
        self.append(p, whole[20:])
        self.assertEqual(index.update([p], BIG), len(whole))
        self.assertEqual([g.number for g in index.links(p)], [1, 2])

    def test_appends_are_read_incrementally_and_a_warm_update_opens_nothing(self):
        p = self.path()
        first = lines([noise(1), link_record(1, T0)])
        self.write(p, first)
        spy = SpyOpen()
        index = PrLinkIndex(open_file=spy)
        self.assertEqual(index.update([p], BIG), len(first))
        self.assertEqual(index.update([p], BIG), 0)
        self.assertEqual(spy.opens, ["a.jsonl"])
        extra = lines([link_record(2, T0 + 5), noise(2)])
        self.append(p, extra)
        spy.bytes_read = 0
        self.assertEqual(index.update([p], BIG), len(extra))
        self.assertEqual(spy.bytes_read, len(extra) + 1)  # plus the newline check just before the offset
        self.assertEqual([g.number for g in index.links(p)], [1, 2])

    def test_budget_spans_several_updates_and_resumes_exactly(self):
        records = []
        for i in range(60):
            records.append(link_record(i % 17 + 1, T0 + i) if i % 3 == 0 else noise(i, pad=i * 3))
        data = lines(records) + b'not json but has "pr-link"\n'
        p = self.path()
        self.write(p, data)
        expected = self.one_shot(data)
        index = PrLinkIndex()
        calls = consumed_total = 0
        while not index.is_complete(p):
            consumed = index.update([p], 700)
            self.assertLessEqual(consumed, 700)
            self.assertGreater(consumed, 0)
            consumed_total += consumed
            calls += 1
            self.assertLess(calls, 500)
        self.assertGreater(calls, 3)
        self.assertEqual(consumed_total, len(data))
        self.assertEqual(index.links(p), expected)

    def test_budget_is_shared_across_files_in_the_order_given(self):
        a, b = self.path("a.jsonl"), self.path("b.jsonl")
        a_lines = [line(link_record(i + 1, T0 + i)) for i in range(20)]
        self.write(a, b"".join(a_lines))
        self.write(b, line(link_record(99)))
        budget = sum(len(x) for x in a_lines[:10])
        index = PrLinkIndex()
        self.assertEqual(index.update([a, b], budget), budget)
        self.assertEqual(len(index.links(a)), 10)
        self.assertEqual(index.links(b), ())
        self.assertFalse(index.is_complete(b))
        calls = 1
        while not (index.is_complete(a) and index.is_complete(b)):
            index.update([a, b], budget)
            calls += 1
            self.assertLess(calls, 10)
        self.assertEqual(len(index.links(a)), 20)
        self.assertEqual([g.number for g in index.links(b)], [99])

    def test_a_line_longer_than_the_budget_still_makes_progress(self):
        long_line = line(link_record(1, T0, pad=MARKER * 400))
        p, q = self.path("p.jsonl"), self.path("q.jsonl")
        self.write(p, long_line + line(link_record(2, T0 + 1)))
        self.write(q, line(link_record(3)))
        index = PrLinkIndex()
        self.assertEqual(index.update([p, q], 100), len(long_line))
        self.assertEqual([g.number for g in index.links(p)], [1])
        self.assertEqual(index.links(q), ())
        while not (index.is_complete(p) and index.is_complete(q)):
            index.update([p, q], 100)
        self.assertEqual([g.number for g in index.links(p)], [1, 2])
        self.assertEqual([g.number for g in index.links(q)], [3])

    def test_budget_caps_bytes_read_not_just_bytes_consumed(self):
        budget = 10_000
        small_a, small_b = self.path("small_a.jsonl"), self.path("small_b.jsonl")
        self.write(small_a, line(link_record(1)))
        self.write(small_b, line(link_record(2)))
        longs = [self.path(f"long_{i}.jsonl") for i in range(4)]
        long_line = line(link_record(3, pad=MARKER * 900))
        self.assertGreater(len(long_line), 2 * budget)
        for p in longs:
            self.write(p, long_line)
        files = [small_a, *longs, small_b]
        with mock.patch.object(prlinks, "CHUNK_BYTES", 4096):
            spy = SpyOpen()
            index = PrLinkIndex(open_file=spy)
            index.update(files, budget)
            self.assertLessEqual(spy.bytes_read, budget)
            calls = 1
            while not all(index.is_complete(p) for p in files):
                spy.bytes_read = 0
                index.update(files, budget)
                self.assertLessEqual(spy.bytes_read, len(long_line) + 4096 + 1)
                calls += 1
                self.assertLess(calls, 20)
        for p in longs:
            self.assertEqual([g.number for g in index.links(p)], [3])
        self.assertEqual([g.number for g in index.links(small_b)], [2])

    def test_long_line_behind_a_growing_file_still_makes_progress(self):
        budget = 10_000
        live, stuck, after = self.path("live.jsonl"), self.path("stuck.jsonl"), self.path("after.jsonl")
        self.write(live, line(link_record(1)))
        self.write(stuck, line(link_record(2, pad=MARKER * 900)))
        self.write(after, line(link_record(3)))
        index = PrLinkIndex()
        for i in range(1, 6):
            index.update([live, stuck, after], budget)
            self.append(live, line(noise(i)))
            if index.is_complete(stuck) and index.is_complete(after):
                break
        self.assertEqual([g.number for g in index.links(stuck)], [2])
        self.assertEqual([g.number for g in index.links(after)], [3])

    def test_lines_and_the_needle_spanning_read_chunks(self):
        records = [link_record(i % 7 + 1, T0 + i) if i % 2 else noise(i, pad=i) for i in range(60)]
        data = lines(records)
        expected = self.one_shot(data)
        self.assertEqual(len(expected), 7)
        p = self.path()
        self.write(p, data)
        for chunk, budget in ((3, BIG), (5, BIG), (8, 500), (64, BIG), (1000, 333)):
            with self.subTest(chunk=chunk, budget=budget), mock.patch.object(prlinks, "CHUNK_BYTES", chunk):
                index = PrLinkIndex()
                calls = 0
                while not index.is_complete(p):
                    index.update([p], budget)
                    calls += 1
                    self.assertLess(calls, 5000)
                self.assertEqual(index.links(p), expected)

    def test_zero_budget_still_notices_growth(self):
        p = self.path()
        self.write(p, line(link_record(1)))
        index = PrLinkIndex()
        index.update([p], BIG)
        self.append(p, line(link_record(2)))
        self.assertEqual(index.update([p], 0), 0)
        self.assertFalse(index.is_complete(p))


class ResetTests(IndexTestCase):
    def test_truncation_resets(self):
        p = self.path()
        self.write(p, lines([link_record(1), link_record(2), noise(1, pad=500)]))
        index = PrLinkIndex()
        index.update([p], BIG)
        self.write(p, line(link_record(3)))
        index.update([p], BIG)
        self.assertEqual([g.number for g in index.links(p)], [3])

    def test_inode_change_resets(self):
        p = self.path()
        self.write(p, lines([link_record(1)]))
        index = PrLinkIndex()
        index.update([p], BIG)
        replacement = self.path("new.jsonl")
        self.write(replacement, lines([link_record(4), noise(1, pad=900)]))
        os.replace(replacement, p)
        index.update([p], BIG)
        self.assertEqual([g.number for g in index.links(p)], [4])

    def test_rewrite_in_place_off_the_line_boundary_resets(self):
        p = self.path()
        first = lines([link_record(1)])
        self.write(p, first)
        index = PrLinkIndex()
        index.update([p], BIG)
        with open(p, "r+b") as fh:  # same inode, longer, and no newline just before the old offset
            fh.write(b"x" * (len(first) + 5) + b"\n" + line(link_record(5)))
        index.update([p], BIG)
        self.assertEqual([g.number for g in index.links(p)], [5])


class SafetyTests(IndexTestCase):
    def test_default_open_enforces_the_denylist(self):
        good = self.path("a.jsonl")
        key = self.path("123.key")
        config = self.path("config.json")
        local_storage = self.dir / "Local Storage"
        local_storage.mkdir()
        leveldb = local_storage / "000003.log"
        for p in (good, key, config, leveldb):
            self.write(p, line(link_record(1)))
        real_open = builtins.open
        opened: list[str] = []

        def recording_open(file, *args, **kwargs):
            opened.append(os.fspath(file))
            return real_open(file, *args, **kwargs)

        index = PrLinkIndex()
        with mock.patch("builtins.open", side_effect=recording_open):
            index.update([key, config, leveldb, good], BIG)
        self.assertEqual(opened, [os.fspath(good)])
        for denied in (key, config, leveldb):
            self.assertEqual(index.links(denied), ())
            self.assertFalse(index.is_complete(denied))

    def test_injected_open_file_is_the_only_reader(self):
        p = self.path()
        self.write(p, line(link_record(1)))
        calls: list[str] = []

        def refuse(path, mode="rb"):
            calls.append(mode)
            raise PermissionError("denied")

        index = PrLinkIndex(open_file=refuse)
        with mock.patch("builtins.open", side_effect=AssertionError("bypassed open_file")):
            self.assertEqual(index.update([p], BIG), 0)
        self.assertEqual(calls, ["rb"])
        self.assertEqual(index.links(p), ())

    def test_missing_directories_and_symlinks_are_skipped(self):
        real = self.path("real.jsonl")
        self.write(real, line(link_record(1)))
        link = self.path("link.jsonl")
        link.symlink_to(real)
        folder = self.path("folder.jsonl")
        folder.mkdir()
        missing = self.path("missing.jsonl")
        index = PrLinkIndex()
        self.assertEqual(index.update([missing, folder, link], BIG), 0)
        for p in (missing, folder, link):
            self.assertEqual(index.links(p), ())
            self.assertFalse(index.is_complete(p))

    def test_state_keeps_structure_only(self):
        p = self.path()
        records = [noise(i, pad=100) for i in range(50)]
        records += [link_record(n, T0 + n, cwd=MARKER, message={"content": MARKER}) for n in range(1, 4)]
        records.append(link_record(9, url=f"https://github.com/o/r/pull/9?{MARKER}", prRepository=f"{MARKER}/x y"))
        self.write(p, lines(records))
        index = PrLinkIndex()
        index.update([p], BIG)
        state = index._files[p]
        self.assertFalse(hasattr(state, "__dict__"))
        self.assertNotIn(MARKER, repr([getattr(state, slot) for slot in type(state).__slots__]))
        self.assertEqual(len(index.links(p)), 4)

    def test_forget_and_unknown_paths(self):
        a, b = self.path("a.jsonl"), self.path("b.jsonl")
        self.write(a, line(link_record(1)))
        self.write(b, line(link_record(2)))
        index = PrLinkIndex()
        index.update([a, b], BIG)
        index.forget([a])
        self.assertEqual(len(index.links(a)), 1)
        self.assertEqual(index.links(b), ())
        self.assertFalse(index.is_complete(b))
        index.forget([])
        self.assertEqual(index.links(a), ())
        self.assertFalse(index.is_complete(self.path("never.jsonl")))


if __name__ == "__main__":
    unittest.main()
