"""The privacy scan: it must find what it claims to find, and print no secret of its own.

The git layer is not exercised here, because the suite runs no real subprocess. Everything below drives
`scan_items` with the pairs that layer yields.
"""
from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path

from tools import privacy_scan

SESSION_ID = "11111111-2222-4333-8444-555555555555"
TITLE = "A rather memorable session title"
PR_URL = "https://github.com/o/r/pull/7"


def items(text: str, name: str = "tests/fixtures.py"):
    return [(name, text.encode())]


class ScanTests(unittest.TestCase):
    def scan(self, text, real=None, words=(), name="tests/fixtures.py"):
        return privacy_scan.scan_items(items(text, name), real or privacy_scan.RealData(), words)

    def test_ordinary_code_has_nothing(self):
        self.assertEqual(self.scan("row = Row(id='local_1', lane='idle')\n"), {})

    def test_a_token_is_found_with_its_line(self):
        found = self.scan("ok = 1\ntoken = 'ghp_" + "a" * 36 + "'\n")
        self.assertEqual(list(found), ["secret (github token)"])
        self.assertEqual(list(found["secret (github token)"]), ["tests/fixtures.py:2"])

    def test_each_kind_of_credential_is_found(self):
        # Built from pieces, every one of them: the scan reads this file too, and a whole one written out here
        # would fail the scan of this repo for ever after, in this commit and in every commit that follows.
        for text in ("AKIA" + "A" * 16, "sk-" + "ant-" + "b" * 24, "xox" + "b-1234567890-abcdef",
                     "-----BEGIN RSA" + " PRIVATE KEY-----", "pass" + "word = 'hunter2hunter2'",
                     "post" + "gres://user:pw@host/db", "eyJhbGciOiJIUzI1" + ".eyJzdWIiOiIxMjM0.abcde"):
            with self.subTest(text=text):
                self.assertTrue(any(k.startswith("secret") for k in self.scan(text)), text)

    def test_this_file_does_not_trip_the_scan(self):
        """The one file most likely to, since it is made of things the scan looks for."""
        source = Path(__file__).read_bytes()
        found = privacy_scan.scan_items([(__file__, source)], privacy_scan.RealData())
        self.assertEqual([k for k in found if not k.startswith("noted")], [])

    def test_this_macs_own_data_is_found(self):
        real = privacy_scan.RealData(ids={SESSION_ID.encode()}, titles={TITLE.encode()},
                                     pr_urls={PR_URL.encode()}, folders={b"someproject"})
        self.assertIn("real session id", self.scan(f'id = "{SESSION_ID}"', real))
        self.assertIn("real title", self.scan(f'title = "{TITLE}"', real))
        self.assertIn("real PR link", self.scan(f'url = "{PR_URL}"', real))
        self.assertIn("real folder name", self.scan('cwd = "/Users/x/someproject"', real))

    def test_a_folder_name_inside_a_longer_word_is_not_a_match(self):
        real = privacy_scan.RealData(folders={b"someproject"})
        self.assertEqual(self.scan('name = "othersomeprojectish"', real), {})

    def test_your_own_words_are_found_whatever_the_case(self):
        found = self.scan("repo = 'Acme-DataTeam/thing'", words=["acme-datateam", "", "# a comment"])
        self.assertEqual(list(found), ["private word"])

    def test_a_binary_file_is_reported_rather_than_read(self):
        found = privacy_scan.scan_items([("art.png", b"\x89PNG\x00\x00")], privacy_scan.RealData())
        self.assertEqual(list(found), ["binary file"])

    def test_emails_hosts_and_home_folders_are_noted_only(self):
        found = self.scan("me@example.com https://gitlab.com/o/r /Users/someone/x\n")
        self.assertEqual(sorted(found), ["noted: email", "noted: home folder", "noted: host"])
        self.assertEqual(privacy_scan.report(found, io.StringIO()), 0)


class ReportTests(unittest.TestCase):
    def test_a_finding_fails_the_run_and_never_prints_what_matched(self):
        real = privacy_scan.RealData(titles={TITLE.encode()})
        found = privacy_scan.scan_items(items(f'title = "{TITLE}"'), real)
        out = io.StringIO()
        self.assertEqual(privacy_scan.report(found, out), 1)
        # A scan that printed the title would put it somewhere it can be read again.
        self.assertNotIn(TITLE, out.getvalue())
        self.assertIn("tests/fixtures.py:1", out.getvalue())

    def test_a_clean_run_says_so(self):
        out = io.StringIO()
        self.assertEqual(privacy_scan.report({}, out), 0)
        self.assertIn("Nothing found in what was scanned", out.getvalue())


class CoverageTests(unittest.TestCase):
    """A pass must never claim more than the scan could match against."""

    def test_it_names_what_it_had(self):
        real = privacy_scan.RealData(ids={b"a"}, titles={b"b"}, pr_urls={b"c"}, folders={b"d"})
        self.assertEqual(privacy_scan.coverage(real, ["w"]),
                         "matching against: 1 session ids, 1 titles, 1 PR links, 1 folder names; 1 private words")

    def test_it_says_when_there_is_no_claude_folder(self):
        line = privacy_scan.coverage(privacy_scan.RealData(), [])
        self.assertIn("nothing of this machine's own", line)
        self.assertIn("0 private words", line)


class RealDataTests(unittest.TestCase):
    """It reads a synthetic home only, and keeps ids, titles, links and folder names."""

    def test_it_reads_transcripts_and_the_link_store(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            project = home / ".claude" / "projects" / "-Users-x-someproject"
            project.mkdir(parents=True)
            (project / f"{SESSION_ID}.jsonl").write_text(
                json.dumps({"type": "user", "cwd": "/Users/x/someproject"}) + "\n"
                + json.dumps({"type": "custom-title", "customTitle": TITLE}) + "\n", encoding="utf-8")
            store = home / "Library" / "Application Support" / "tokentown"
            store.mkdir(parents=True)
            (store / "links.json").write_text(
                json.dumps({"version": 1, "sessions": {"local_1": [[PR_URL, 7, 1]]}}), encoding="utf-8")
            real = privacy_scan.real_data(privacy_scan.Paths(home=home))
        self.assertIn(SESSION_ID.encode(), real.ids)
        self.assertIn(TITLE.encode(), real.titles)
        self.assertIn(PR_URL.encode(), real.pr_urls)
        self.assertIn(b"someproject", real.folders)
        # "Users" and "x" are too short or too common to tell anything apart.
        self.assertEqual({f for f in real.folders if len(f) < 5}, set())


if __name__ == "__main__":
    unittest.main()
