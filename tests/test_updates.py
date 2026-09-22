"""The update check and Update now: reading a clone's .git and its release tags, the two gh calls, their answers, how
often they run, health, the two git calls, the start check, and the command the page copies.

gh and git never run here: every test passes a mock run, popen or update_run, and real process launches fail the
test. Clones are built in a temp folder, never read from this checkout. The one real process is StartCheckTests' own
Python, which runs the start check's words against this checkout and a temp copy.
"""
from __future__ import annotations

import inspect
import json
import os
import shlex
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from town import github, updates
from town.actions import update_command
from town.github import FAILURE_BACKOFF_MS, GH_NOT_FOUND, GH_NOT_SIGNED_IN
from town.paths import CODE_DIR, RELEASE_TAG_RE
from town.updates import (CHECK_EVERY_MS, COMPARE_JQ, GIT_TIMEOUT_S, NO_GITHUB_ORIGIN, NOT_A_CLONE, NOT_ON_MAIN,
                          PYTHON_NOT_FOUND, RELEASES_JQ, START_CHECK, START_TIMEOUT_S, UNREADABLE, Clone, Release,
                          UpdateChecker, find_git, origin_url, parse_compare, parse_origin, parse_releases, read_clone)

GH = "/opt/homebrew/bin/gh"
GIT = "/opt/homebrew/bin/git"
PY = "/opt/homebrew/bin/python3.13"
HOME = "/Users/someone"
SHA = "155ca5e3853afe41d5ecb5a9b11b6356308e15cf"
SHA2 = "8bcc1e4a" * 5
SHA3 = "0123456789abcdef" * 2 + "01234567"
REL = "a1b2c3d4" * 5  # the commit the newest release's tag names
T0 = 1_790_000_000_000
MINUTE = 60_000
CLONE = Clone("thg-charliestringer", "tokentown", SHA)
CONFIG = """[core]
\trepositoryformatversion = 0
\tbare = false
[remote "origin"]
\turl = https://github.com/thg-charliestringer/tokentown.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
\tremote = origin
\tmerge = refs/heads/main
"""
V110 = {"tag": "v1.1.0", "name": "Tokentown 1.1.0", "published": "2026-09-22T09:00:00Z",
        "notes": "## What's Changed\n* Update now pulls the newest release"}
V100 = {"tag": "v1.0.0", "name": "", "published": "2026-09-20T09:00:00Z", "notes": "The first release"}
V110_MS = 1_790_067_600_000


def releases_out(*items) -> bytes:
    return json.dumps(list(items)).encode()


def compare_out(status: str, ahead: int = 0, behind: int = 0, base: str = REL) -> bytes:
    return json.dumps({"ahead_by": ahead, "base": base, "behind_by": behind, "status": status}).encode()


BEHIND_OUT = compare_out("behind", behind=3)
CURRENT_OUT = compare_out("identical")


def setUpModule():
    # The exact env tests must not see a GH_TOKEN or GH_CONFIG_DIR from the shell that runs them.
    patcher = mock.patch.dict(os.environ)
    patcher.start()
    unittest.addModuleCleanup(patcher.stop)
    for key in github.GH_ENV_KEYS:
        os.environ.pop(key, None)


def no_real_subprocesses(case: unittest.TestCase) -> None:
    for target in ("subprocess.Popen", "os.posix_spawn", "os.execv", "os.system"):
        patcher = mock.patch(target, side_effect=AssertionError(f"real {target} called in a test"))
        patcher.start()
        case.addCleanup(patcher.stop)


def done(stdout=BEHIND_OUT, code=0):
    return subprocess.CompletedProcess([], code, stdout=stdout, stderr=b"")


class Clock:
    def __init__(self, t: int = T0):
        self.t = t

    def __call__(self) -> int:
        return self.t


class TempDirCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def clone(self, name="tokentown", *, head="ref: refs/heads/main\n", main=SHA, packed=None,
              config=CONFIG, tags=None) -> Path:
        folder = self.root / name
        git = folder / ".git"
        (git / "refs" / "heads").mkdir(parents=True)
        (git / "HEAD").write_text(head)
        if main is not None:
            (git / "refs" / "heads" / "main").write_text(main + "\n")
        if packed is not None:
            (git / "packed-refs").write_text(packed)
        if config is not None:
            (git / "config").write_text(config)
        if tags:
            (git / "refs" / "tags").mkdir(parents=True, exist_ok=True)
            for tag, sha in tags.items():
                (git / "refs" / "tags" / tag).write_text(sha + "\n")
        return folder

    def worktree(self, main_clone: Path, name="wt", *, head="ref: refs/heads/main\n", gitdir=None) -> Path:
        """A git worktree of main_clone: a .git file naming its gitdir, whose commondir leads back."""
        admin = main_clone / ".git" / "worktrees" / name
        admin.mkdir(parents=True)
        (admin / "HEAD").write_text(head)
        (admin / "commondir").write_text("../..\n")
        folder = self.root / name
        folder.mkdir()
        (folder / ".git").write_text(f"gitdir: {gitdir or admin}\n")
        return folder


# ====================================================================== reading .git

class ReadCloneTests(TempDirCase):
    def test_a_plain_clone_on_main(self):
        self.assertEqual(read_clone(self.clone()), CLONE)
        self.assertEqual(read_clone(str(self.clone("other"))), CLONE)

    def test_a_packed_ref_is_found_and_a_loose_one_wins(self):
        packed = (f"# pack-refs with: peeled fully-peeled sorted \n{SHA3} refs/heads/feature\n"
                  f"{SHA2} refs/heads/main\n^{SHA3}\n")
        self.assertEqual(read_clone(self.clone("packed", main=None, packed=packed)).commit, SHA2)
        self.assertEqual(read_clone(self.clone("both", packed=packed)).commit, SHA)
        self.assertEqual(read_clone(self.clone("none", main=None, packed=f"{SHA3} refs/heads/mainline\n")), UNREADABLE)
        self.assertEqual(read_clone(self.clone("nothing", main=None)), UNREADABLE)

    def test_a_worktree_reads_head_from_its_gitdir_and_refs_and_config_from_the_common_dir(self):
        main_clone = self.clone(head="ref: refs/heads/feature\n", tags={"v1.0.0": SHA})
        self.assertEqual(read_clone(main_clone), NOT_ON_MAIN)
        self.assertEqual(read_clone(self.worktree(main_clone)),
                         Clone("thg-charliestringer", "tokentown", SHA, tags=("v1.0.0",)))
        self.assertEqual(read_clone(self.worktree(main_clone, "wt2", head="ref: refs/heads/other\n")), NOT_ON_MAIN)
        # A relative gitdir is relative to the folder holding the .git file.
        relative = self.worktree(main_clone, "wt3", gitdir="../tokentown/.git/worktrees/wt3")
        self.assertEqual(read_clone(relative).commit, SHA)

    def test_a_gitdir_without_a_commondir_holds_everything_itself(self):
        real = self.clone("real")
        folder = self.root / "linked"
        folder.mkdir()
        (folder / ".git").write_text(f"gitdir: {real / '.git'}\n")
        self.assertEqual(read_clone(folder), CLONE)

    def test_any_other_head_is_not_on_main(self):
        self.assertEqual(read_clone(self.clone("a", head="ref: refs/heads/feature/x\n")), NOT_ON_MAIN)
        self.assertEqual(read_clone(self.clone("b", head="ref: refs/heads/mainline\n")), NOT_ON_MAIN)
        self.assertEqual(read_clone(self.clone("c", head=SHA + "\n")), NOT_ON_MAIN)
        self.assertEqual(read_clone(self.clone("d", head="garbage\n")), UNREADABLE)

    def test_no_git_folder_is_not_a_clone(self):
        self.assertEqual(read_clone(self.root), NOT_A_CLONE)
        self.assertEqual(read_clone(self.root / "missing"), NOT_A_CLONE)

    def test_anything_odd_is_unreadable_never_an_exception(self):
        bad = [
            self.clone("short", main="abc123"),
            self.clone("upper", main=SHA.upper()),
            self.clone("sha256", main="a" * 64),
            self.clone("noconfig", config=None),
            self.clone("symbolic", main="ref: refs/heads/other"),
        ]
        big = self.clone("big")
        (big / ".git" / "HEAD").write_text("ref: refs/heads/main\n" + " " * updates.MAX_GIT_FILE_BYTES)
        binary = self.clone("binary")
        (binary / ".git" / "HEAD").write_bytes(b"ref: refs/heads/main\xff\n")
        nogitdir = self.root / "nogitdir"
        nogitdir.mkdir()
        (nogitdir / ".git").write_text("not a gitdir line\n")
        emptygitdir = self.root / "emptygitdir"
        emptygitdir.mkdir()
        (emptygitdir / ".git").write_text("gitdir: \n")
        dangling = self.root / "dangling"
        dangling.mkdir()
        (dangling / ".git").write_text(f"gitdir: {self.root / 'gone'}\n")
        for folder in [*bad, big, binary, nogitdir, emptygitdir, dangling]:
            with self.subTest(folder=folder.name):
                self.assertEqual(read_clone(folder), UNREADABLE)

    def test_an_origin_off_github_is_not_checked(self):
        configs = {
            "none": "[core]\n\tbare = false\n",
            "upstream only": '[remote "upstream"]\n\turl = https://github.com/o/r.git\n',
            "gitlab": '[remote "origin"]\n\turl = https://gitlab.com/o/r.git\n',
            "enterprise": '[remote "origin"]\n\turl = https://github.example.com/o/r.git\n',
            "local": '[remote "origin"]\n\turl = /Users/someone/tokentown\n',
        }
        for name, config in configs.items():
            with self.subTest(name=name):
                self.assertEqual(read_clone(self.clone(name.replace(" ", "-"), config=config)), NO_GITHUB_ORIGIN)

    def test_git_files_are_only_ever_opened_to_read(self):
        folder = self.worktree(self.clone(packed=f"{SHA2} refs/heads/other\n", tags={"v1.0.0": SHA}))
        real_open = open
        modes = []

        def spy(path, mode="r", *args, **kwargs):
            modes.append(mode)
            return real_open(path, mode, *args, **kwargs)

        with mock.patch("builtins.open", side_effect=spy):
            self.assertEqual(read_clone(folder).tags, ("v1.0.0",))
        self.assertTrue(modes)
        self.assertEqual(set(modes), {"rb"})

    def test_this_checkout_is_the_default(self):
        self.assertEqual(inspect.signature(read_clone).parameters["code_dir"].default, CODE_DIR)
        self.assertEqual(inspect.signature(UpdateChecker).parameters["code_dir"].default, CODE_DIR)


class ReleaseTagTests(TempDirCase):
    """The release tags at the commit main is at: what names the version this copy is."""

    def test_loose_tags_at_this_commit_highest_first(self):
        tags = {"v1.9.0": SHA, "v1.10.0": SHA, "v1.0.0": SHA2, "latest": SHA, "v2.0.0-rc1": SHA, "notes": SHA}
        self.assertEqual(read_clone(self.clone(tags=tags)).tags, ("v1.10.0", "v1.9.0"))

    def test_packed_tags_lightweight_or_annotated(self):
        packed = (f"# pack-refs with: peeled fully-peeled sorted \n{SHA} refs/tags/v1.2.0\n"
                  f"{SHA3} refs/tags/v1.3.0\n^{SHA}\n{SHA3} refs/tags/v1.4.0\n^{SHA2}\n{SHA} refs/heads/other\n")
        self.assertEqual(read_clone(self.clone(packed=packed)).tags, ("v1.3.0", "v1.2.0"))

    def test_a_loose_annotated_tag_is_not_read_for_its_commit(self):
        # Its file holds the tag object's id, and the commit is only inside that object.
        self.assertEqual(read_clone(self.clone(tags={"v1.0.0": SHA3})).tags, ())

    def test_odd_tag_files_are_skipped(self):
        folder = self.clone(tags={"v1.0.0": SHA})
        (folder / ".git" / "refs" / "tags" / "v1.1.0").write_bytes(b"\xff\xfe")
        (folder / ".git" / "refs" / "tags" / "v1.2.0").mkdir()
        self.assertEqual(read_clone(folder).tags, ("v1.0.0",))

    def test_the_release_tag_pattern(self):
        for tag in ("v1", "v1.2", "v1.2.3", "1.2.3", "v1.2.3.4", "v2026.9.22"):
            with self.subTest(tag=tag):
                self.assertTrue(RELEASE_TAG_RE.fullmatch(tag))
        for tag in ("", "v", "latest", "v1.2.3-rc1", "v1..2", "v1.2.", "-v1", "v1/2", "v1.2.3.4.5", "v1 .2",
                    "v1.2\n", "v١.2", "../v1", "v1.2;ls", "v1234567"):
            with self.subTest(tag=tag):
                self.assertFalse(RELEASE_TAG_RE.fullmatch(tag))


class OriginTests(unittest.TestCase):
    def test_github_urls_give_owner_and_repo(self):
        for url in ("https://github.com/o/r", "https://github.com/o/r.git", "https://github.com/o/r/",
                    "https://github.com/o/r.git/", "https://someone@github.com/o/r.git", "git@github.com:o/r.git",
                    "git@github.com:o/r", "ssh://git@github.com/o/r.git", "ssh://git@github.com/o/r"):
            with self.subTest(url=url):
                self.assertEqual(parse_origin(url), ("o", "r"))
        self.assertEqual(parse_origin("https://github.com/thg-charliestringer/tokentown.git"),
                         ("thg-charliestringer", "tokentown"))
        self.assertEqual(parse_origin("git@github.com:Acme-DataTeam/wonderful_things.core-2.git"),
                         ("Acme-DataTeam", "wonderful_things.core-2"))

    def test_anything_else_is_refused(self):
        refused = [
            "http://github.com/o/r", "https://github.com.evil.example/o/r", "https://evil.example/github.com/o/r",
            "https://someone:password@github.com/o/r", "https://github.com/o", "https://github.com/o/r/extra",
            "https://github.com/../r", "https://github.com/o/..", "https://github.com/o/.", "https://github.com/o/.git",
            "https://github.com/o/..git", "https://github.com/-o/r", "https://github.com/o/r?x=1",
            "https://github.com/o/r#top", "https://github.com/o/r\n", "https://github.com/ο/r",
            "https://github.com/o/r r", "https://github.com/o/r‮", "ssh://git@github.com:22/o/r",
            "https://GITHUB.COM/o/r", "https://github.com/" + "o" * 40 + "/r", "https://github.com/o/" + "r" * 101,
            "git@github.com:o/r/x", "", None, 5, b"https://github.com/o/r",
        ]
        for url in refused:
            with self.subTest(url=url):
                self.assertIsNone(parse_origin(url))

    def test_origin_url_reads_just_enough_git_config(self):
        cases = [
            (CONFIG, "https://github.com/thg-charliestringer/tokentown.git"),
            ('[remote "origin"]\nurl=https://github.com/o/r\n', "https://github.com/o/r"),
            ('[Remote "origin"]\n  URL = git@github.com:o/r.git  \n', "git@github.com:o/r.git"),
            ('[remote "origin"]\n\turl = "https://github.com/o/r.git"\n', "https://github.com/o/r.git"),
            ('[remote "origin"]\n\turl = https://github.com/o/r.git # the main one\n', "https://github.com/o/r.git"),
            ('[remote "origin"]\n\turl = https://github.com/o/r.git;note\n', "https://github.com/o/r.git"),
            ('[remote "fork"]\n\turl = https://github.com/x/y\n[remote "origin"]\n\turl = https://github.com/o/r\n',
             "https://github.com/o/r"),
            ('[remote "origin"]\n\turl = https://github.com/o/first\n\turl = https://github.com/o/second\n',
             "https://github.com/o/first"),
            ('# [remote "origin"]\n; url = https://github.com/x/y\n[remote "origin"]\n\turl = https://github.com/o/r\n',
             "https://github.com/o/r"),
            ('[remote "Origin"]\n\turl = https://github.com/o/r\n', None),
            ('[remote "origin"]\n\tpushurl = https://github.com/o/r\n', None),
            ('[branch "main"]\n\turl = https://github.com/o/r\n', None),
            ('[remote "origin"]\n\turl = "unterminated\n', None),
            ("", None),
        ]
        for config, expected in cases:
            with self.subTest(config=config):
                self.assertEqual(origin_url(config), expected)


# ====================================================================== GitHub's answers

class ParseReleasesTests(unittest.TestCase):
    def test_published_releases_newest_first(self):
        self.assertEqual(parse_releases(releases_out(V110, V100)), (
            Release("v1.1.0", "Tokentown 1.1.0", V110_MS, "## What's Changed\n* Update now pulls the newest release"),
            Release("v1.0.0", "", V110_MS - 2 * 24 * 3600 * 1000, "The first release"),
        ))
        self.assertEqual(parse_releases(b"[]"), ())
        self.assertEqual(parse_releases(releases_out(dict(V100, published=None, extra=[1])))[0].published, None)

    def test_a_release_with_another_kind_of_tag_is_left_out(self):
        odd = [dict(V100, tag=tag) for tag in ("latest", "v1.0.0-rc1", "../x", "v1.0.0;ls", "", "v 1")]
        self.assertEqual([r.tag for r in parse_releases(releases_out(*odd, V110))], ["v1.1.0"])

    def test_at_most_ten(self):
        many = [dict(V100, tag=f"v1.0.{n}") for n in range(15)]
        self.assertEqual(len(parse_releases(releases_out(*many))), 10)

    def test_words_are_cleaned_and_capped(self):
        messy = dict(V110, name="Tok‮entown\x00 1.1​" + "n" * 300,
                     notes="one\r\ntwo\rthree\x1b[31m\tfour five﻿" + "x" * 5000)
        (release,) = parse_releases(releases_out(messy))
        self.assertTrue(release.name.startswith("Tokentown 1.1"))
        self.assertEqual(len(release.name), updates.MAX_NAME_CHARS)
        self.assertTrue(release.notes.startswith("one\ntwo\nthree[31m\tfourfive"))
        self.assertLessEqual(len(release.notes), updates.MAX_NOTES_CHARS)
        for ch in ("‮", "\x00", "​", "\r", "\x1b", " ", "﻿"):
            self.assertNotIn(ch, release.name + release.notes)

    def test_anything_else_is_a_bad_response(self):
        bad = [
            b"", b"garbage", b"{}", b"null", b'"v1.0.0"', b"[1]", b"[[]]", releases_out({"tag": "v1.0.0"}),
            releases_out(dict(V110, tag=None)), releases_out(dict(V110, name=None)),
            releases_out(dict(V110, notes=5)), releases_out(dict(V110, published="yesterday")),
            releases_out(dict(V110, published=1790000000)), b'[{"tag":"v1","name":"","published":null,"notes":NaN}]',
            b"\xff\xfe", b"[" * 100_000, b"[" + b" " * updates.MAX_RELEASES_BYTES + b"]", None, 3,
        ]
        for output in bad:
            with self.subTest(output=output[:60] if isinstance(output, bytes) else output):
                with self.assertRaises(github.BadResponse):
                    parse_releases(output)


class ParseCompareTests(unittest.TestCase):
    def test_every_status(self):
        cases = [
            (compare_out("identical"), ("current", REL)),
            (compare_out("behind", behind=3) + b"\n", ("behind", REL)),
            (compare_out("ahead", ahead=2), ("ahead", REL)),
            (compare_out("diverged", ahead=2, behind=5), ("diverged", REL)),
            ('{"status": "behind", "behind_by": 1, "ahead_by": 0, "base": "%s", "extra": [1]}' % REL, ("behind", REL)),
        ]
        for output, expected in cases:
            with self.subTest(output=output):
                self.assertEqual(parse_compare(output), expected)

    def test_anything_else_is_a_bad_response(self):
        bad = [
            b"", b"garbage", b"[]", b"null", b'"behind"', b'{"status":"behind","behind_by":3}',
            compare_out("behind", behind=3)[:-1] + b',"x":NaN}', compare_out("sideways"),
            compare_out("behind", behind=3, base=REL.upper()), compare_out("behind", behind=3, base="main"),
            compare_out("behind", behind=3, base=REL + "\n"), b'{"status":"identical","ahead_by":0,"behind_by":0}',
            b'{"status":"behind","ahead_by":false,"behind_by":true,"base":"%s"}' % REL.encode(),
            compare_out("behind", behind=-3), compare_out("behind", behind=1_000_001),
            compare_out("identical", behind=1), compare_out("behind"), compare_out("behind", ahead=1, behind=3),
            compare_out("ahead"), compare_out("diverged", behind=2), b"\xff\xfe", b"[" * 100_000,
            compare_out("behind", behind=3)[:-1] + b',"pad":"' + b"x" * 1024 + b'"}', None, 3,
        ]
        for output in bad:
            with self.subTest(output=output[:80] if isinstance(output, bytes) else output):
                with self.assertRaises(github.BadResponse):
                    parse_compare(output)


# ====================================================================== the checker

class CheckerTestCase(unittest.TestCase):
    def setUp(self):
        no_real_subprocesses(self)
        self.clock = Clock()
        self.answers = {"releases": done(releases_out(V110, V100)), "compare": done(BEHIND_OUT)}
        self.run = mock.Mock(side_effect=self.answer)
        self.update_run = mock.Mock(return_value=subprocess.CompletedProcess([], 0))
        self.disk = CLONE
        self.checker = self.make()

    def answer(self, argv, **_kwargs):
        value = self.answers["releases" if "/releases?" in argv[2] else "compare"]
        if isinstance(value, BaseException):
            raise value
        return value

    def make(self, **kwargs) -> UpdateChecker:
        kwargs.setdefault("run", self.run)
        kwargs.setdefault("gh_path", GH)
        kwargs.setdefault("git_path", GIT)
        kwargs.setdefault("python", PY)
        kwargs.setdefault("update_run", self.update_run)
        kwargs.setdefault("read", lambda _folder: self.disk)
        return UpdateChecker(clock_ms=self.clock, home=HOME, **kwargs)

    def releases_argv(self) -> list[str]:
        return [GH, "api", "repos/thg-charliestringer/tokentown/releases?per_page=10", "--jq", RELEASES_JQ]

    def compare_argv(self, tag="v1.1.0", commit=SHA) -> list[str]:
        return [GH, "api", f"repos/thg-charliestringer/tokentown/compare/{tag}...{commit}", "--jq", COMPARE_JQ]

    def gh_argvs(self) -> list[list[str]]:
        return [c.args[0] for c in self.run.call_args_list]


class CheckerTests(CheckerTestCase):
    def test_a_check_is_the_releases_then_a_compare_with_the_newest(self):
        self.assertEqual(self.checker.refresh(), 2)
        self.assertEqual(self.gh_argvs(), [self.releases_argv(), self.compare_argv()])
        for call in self.run.call_args_list:
            self.assertEqual(call.kwargs, dict(shell=False, timeout=20, stdin=subprocess.DEVNULL, capture_output=True,
                                               env={"PATH": "/usr/bin:/bin", "HOME": HOME}))
        self.assertEqual(COMPARE_JQ, "{status: .status, ahead_by: .ahead_by, behind_by: .behind_by, "
                                     "base: .base_commit.sha}")
        self.assertIn("select(.draft == false and .prerelease == false)", RELEASES_JQ)

    def test_the_answer_reaches_health(self):
        self.assertEqual(self.checker.health(), {"enabled": True, "reason": None, "state": None, "latest": None,
                                                 "version": None, "restart": False, "canPull": True, "running": SHA,
                                                 "lastError": None, "lastCheckedAt": None})
        self.clock.t = T0 + 5
        self.checker.refresh()
        self.assertEqual(self.checker.health(), {
            "enabled": True, "reason": None, "state": "behind",
            "latest": {"tag": "v1.1.0", "name": "Tokentown 1.1.0", "published": V110_MS}, "version": None,
            "restart": False, "canPull": True, "running": SHA, "lastError": None, "lastCheckedAt": T0 + 5})
        self.assertEqual([r["tag"] for r in self.checker.releases()], ["v1.1.0", "v1.0.0"])
        self.assertEqual(self.checker.releases()[0]["notes"], V110["notes"])

    def test_no_release_yet_is_one_call_and_says_so(self):
        self.answers["releases"] = done(b"[]")
        self.assertEqual(self.checker.refresh(), 1)
        health = self.checker.health()
        self.assertEqual((health["state"], health["latest"], health["lastError"], health["lastCheckedAt"]),
                         (None, None, None, T0))
        self.assertEqual(self.checker.releases(), [])

    def test_github_is_asked_at_most_hourly(self):
        self.assertEqual(self.checker.refresh(), 2)
        self.clock.t = T0 + CHECK_EVERY_MS - 1
        self.assertEqual(self.checker.refresh(), 0)
        self.clock.t = T0 + CHECK_EVERY_MS
        self.assertEqual(self.checker.refresh(), 2)
        self.assertEqual(CHECK_EVERY_MS, 60 * MINUTE)

    def test_a_day_of_minutely_refreshes_is_two_calls_an_hour(self):
        calls = 0
        for _ in range(24 * 60):
            calls += self.checker.refresh()
            self.clock.t += MINUTE
        self.assertEqual(calls, 48)

    def test_a_new_release_is_found_by_the_next_check(self):
        self.answers = {"releases": done(releases_out(V100)), "compare": done(CURRENT_OUT)}
        self.checker.refresh()
        health = self.checker.health()
        self.assertEqual((health["state"], health["latest"]["tag"]), ("current", "v1.0.0"))
        self.answers = {"releases": done(releases_out(V110, V100)), "compare": done(BEHIND_OUT)}
        self.clock.t += CHECK_EVERY_MS
        self.checker.refresh()
        self.assertEqual(self.gh_argvs()[-1], self.compare_argv("v1.1.0"))
        self.assertEqual((self.checker.health()["state"], self.checker.health()["latest"]["tag"]), ("behind", "v1.1.0"))

    def test_a_pull_is_checked_straight_away_and_needs_a_restart(self):
        self.checker.refresh()
        self.disk = Clone("thg-charliestringer", "tokentown", SHA2)
        self.answers["compare"] = done(CURRENT_OUT)
        self.clock.t += MINUTE
        # Read but not yet answered: the old commit's "behind" is not this commit's.
        self.answers["releases"] = done(b"", code=1)
        self.assertEqual(self.checker.refresh(), 1)
        health = self.checker.health()
        self.assertEqual((health["state"], health["restart"], health["latest"]["tag"]), (None, True, "v1.1.0"))
        self.answers["releases"] = done(releases_out(V110, V100))
        self.clock.t += FAILURE_BACKOFF_MS
        self.assertEqual(self.checker.refresh(), 2)
        self.assertEqual(self.gh_argvs()[-1], self.compare_argv(commit=SHA2))
        health = self.checker.health()
        self.assertEqual((health["state"], health["restart"], health["lastError"]), ("current", True, None))

    def test_a_commit_that_moves_is_asked_about_at_once(self):
        self.checker.refresh()
        self.disk = Clone("thg-charliestringer", "tokentown", SHA2)
        self.clock.t += MINUTE
        self.assertEqual(self.checker.refresh(), 2)
        self.assertEqual(self.gh_argvs()[-1], self.compare_argv(commit=SHA2))

    def test_restart_follows_the_commit_it_started_with(self):
        self.disk = Clone("thg-charliestringer", "tokentown", SHA2)
        self.checker.refresh()
        self.assertTrue(self.checker.health()["restart"])
        self.disk = CLONE
        self.checker.refresh()
        self.assertFalse(self.checker.health()["restart"])
        self.disk = NOT_ON_MAIN
        self.checker.refresh()
        self.assertFalse(self.checker.health()["restart"])

    def test_a_copy_that_started_off_main_never_asks_for_a_restart(self):
        self.disk = NOT_ON_MAIN
        checker = self.make()
        self.disk = CLONE
        checker.refresh()
        self.assertFalse(checker.health()["restart"])

    def test_the_version_is_the_running_commits_tag_or_the_release_it_matches(self):
        self.disk = Clone("thg-charliestringer", "tokentown", SHA, tags=("v1.0.0",))
        checker = self.make()
        self.assertEqual(checker.health()["version"], "v1.0.0", "from its own tags, before any check")
        self.disk = CLONE
        checker = self.make()
        self.answers["compare"] = done(CURRENT_OUT)
        checker.refresh()
        self.assertEqual(checker.health()["version"], "v1.1.0", "identical to the newest release")
        self.answers["compare"] = done(compare_out("ahead", ahead=4))
        self.clock.t += CHECK_EVERY_MS
        checker.refresh()
        self.assertIsNone(checker.health()["version"], "an unreleased build has no version")

    def test_a_newer_release_on_the_same_commit_names_the_version(self):
        # v1.0.1 published on v1.0.0's commit: the clone's tags know only v1.0.0, and Health said "Version v1.0.0"
        # beside "Up to date: v1.0.1".
        self.disk = Clone("thg-charliestringer", "tokentown", SHA, tags=("v1.0.0",))
        checker = self.make()
        self.assertEqual(checker.health()["version"], "v1.0.0", "its own tag until GitHub answers")
        self.answers["compare"] = done(CURRENT_OUT)
        checker.refresh()
        self.assertEqual((checker.health()["state"], checker.health()["version"]), ("current", "v1.1.0"))
        self.answers["compare"] = done(compare_out("ahead", ahead=2))
        self.clock.t += CHECK_EVERY_MS
        checker.refresh()
        self.assertEqual(checker.health()["version"], "v1.0.0", "not the newest release: its own tag again")

    def test_a_tag_fetched_later_names_the_running_code_and_a_pull_keeps_its_version(self):
        self.checker.refresh()
        self.assertIsNone(self.checker.health()["version"])
        self.disk = Clone("thg-charliestringer", "tokentown", SHA, tags=("v1.0.0",))
        self.checker.refresh()
        self.assertEqual(self.checker.health()["version"], "v1.0.0")
        # Pulled by hand to the newest: the server still runs v1.0.0 until it restarts.
        self.disk = Clone("thg-charliestringer", "tokentown", REL, tags=("v1.1.0",))
        self.checker.refresh()
        self.assertEqual((self.checker.health()["version"], self.checker.health()["restart"]), ("v1.0.0", True))

    def test_failure_backs_off_fifteen_minutes_but_a_pull_is_asked_about_once(self):
        self.answers["releases"] = done(b"", code=1)
        self.assertEqual(self.checker.refresh(), 1)
        self.clock.t = T0 + MINUTE
        self.assertEqual(self.checker.refresh(), 0, "the same commit waits out the back-off")
        # A 404 for a commit GitHub never saw left the very pull that followed it unchecked for 15 minutes.
        self.disk = Clone("thg-charliestringer", "tokentown", SHA2)
        self.assertEqual(self.checker.refresh(), 1, "a new commit is asked about at once")
        self.clock.t = T0 + 2 * MINUTE
        self.assertEqual(self.checker.refresh(), 0, "and then waits its own back-off")
        self.clock.t = T0 + MINUTE + FAILURE_BACKOFF_MS
        self.assertEqual(self.checker.refresh(), 1)
        self.assertEqual(self.checker.health()["lastError"], "exit 1")

    def test_a_day_signed_out_costs_one_call_a_quarter_hour_and_one_per_pull(self):
        self.answers["releases"] = done(b"", code=4)
        calls = 0
        for minute in range(24 * 60):
            if minute in (100, 700, 1300):
                self.disk = Clone("thg-charliestringer", "tokentown", (SHA, SHA2, SHA3)[minute % 3])
            calls += self.checker.refresh()
            self.clock.t += MINUTE
        self.assertLessEqual(calls, 24 * 4 + 3)
        self.assertEqual(self.checker.health()["lastError"], GH_NOT_SIGNED_IN)

    def test_a_failed_recheck_keeps_the_last_answer(self):
        self.checker.refresh()
        self.answers["compare"] = done(b"", code=1)
        self.clock.t += CHECK_EVERY_MS
        self.assertEqual(self.checker.refresh(), 2)
        health = self.checker.health()
        self.assertEqual((health["state"], health["lastError"], health["lastCheckedAt"]), ("behind", "exit 1", T0))
        self.answers["compare"] = done(CURRENT_OUT)
        self.clock.t += FAILURE_BACKOFF_MS
        self.checker.refresh()
        self.assertEqual((self.checker.health()["state"], self.checker.health()["lastError"]), ("current", None))

    def test_a_compare_that_fails_after_a_new_release_claims_nothing_about_it(self):
        self.answers = {"releases": done(releases_out(V100)), "compare": done(CURRENT_OUT)}
        self.checker.refresh()
        self.answers = {"releases": done(releases_out(V110, V100)), "compare": done(b"", code=1)}
        self.clock.t += CHECK_EVERY_MS
        self.checker.refresh()
        health = self.checker.health()
        self.assertEqual((health["latest"]["tag"], health["state"], health["lastError"]), ("v1.1.0", None, "exit 1"))
        self.assertEqual(self.checker.releases()[0]["tag"], "v1.1.0", "its notes are already in What's new")
        self.assertEqual(self.checker.update(), ("nothing", None), "and nothing is pulled on the old answer")

    def test_error_names_never_carry_what_gh_said(self):
        cases = [
            (done(b"", code=4), GH_NOT_SIGNED_IN),
            (done(b'{"message":"secret credentials","status":"401"}', code=1), "HTTP 401"),
            (done(b'{"message":"secret","documentation_url":"x","status":"404"}\n', code=1), "HTTP 404"),
            (done(b"secret text", code=1), "exit 1"),
            (done(b'{"status":"404"}', code=2), "exit 2"),
            (done(b"secret", code=-9), "exit -9"),
            (done(b"secret text"), "BadResponse"),
            (subprocess.CompletedProcess([], None, stdout=releases_out(V110)), "BadResponse"),
            (subprocess.TimeoutExpired([GH], 20, output=b"secret out", stderr=b"secret err"), "TimeoutExpired"),
            (FileNotFoundError(2, "No such file", "/secret/path"), "FileNotFoundError"),
        ]
        for step in ("releases", "compare"):
            for outcome, expected in cases:
                with self.subTest(step=step, expected=expected):
                    self.answers = {"releases": done(releases_out(V110)), "compare": done(BEHIND_OUT), step: outcome}
                    checker = self.make()
                    self.assertEqual(checker.refresh(), 1 if step == "releases" else 2)
                    health = checker.health()
                    self.assertEqual((health["lastError"], health["state"]), (expected, None))
                    self.assertNotIn("secret", repr(health) + repr(vars(checker)) + repr(checker.releases()))

    def test_a_copy_that_cannot_be_checked_makes_no_call(self):
        for reason in (NOT_A_CLONE, NOT_ON_MAIN, NO_GITHUB_ORIGIN, UNREADABLE):
            with self.subTest(reason=reason):
                self.disk = reason
                checker = self.make()
                self.assertEqual(checker.refresh(), 0)
                self.assertEqual(checker.health(), {"enabled": False, "reason": reason, "state": None, "latest": None,
                                                    "version": None, "restart": False, "canPull": False,
                                                    "running": None, "lastError": None, "lastCheckedAt": None})
        self.run.assert_not_called()

    def test_leaving_main_hides_the_answer_and_its_error(self):
        self.answers["releases"] = done(b"", code=1)
        self.checker.refresh()
        self.disk = NOT_ON_MAIN
        self.checker.refresh()
        health = self.checker.health()
        self.assertEqual((health["enabled"], health["reason"], health["lastError"], health["latest"]),
                         (False, NOT_ON_MAIN, None, None))

    def test_a_read_that_raises_or_returns_junk_is_unreadable(self):
        for read in (mock.Mock(side_effect=PermissionError("/secret/path")), mock.Mock(return_value=None),
                     mock.Mock(return_value=("thg-charliestringer", "tokentown", SHA))):
            with self.subTest(read=read):
                checker = self.make(read=read)
                self.assertEqual(checker.refresh(), 0)
                self.assertEqual(checker.health()["reason"], UNREADABLE)
                self.assertNotIn("secret", repr(checker.health()))

    def test_a_clone_is_checked_again_before_its_parts_reach_argv(self):
        hostile = [
            Clone("o/../x", "r", SHA), Clone("o", "r/../../user", SHA), Clone("-o", "r", SHA), Clone("o", "..", SHA),
            Clone("o", "r.git", SHA), Clone("o", "r?x=1", SHA), Clone("o", "r", SHA.upper()), Clone("o", "r", "HEAD"),
            Clone("o", "r", SHA + "\n"), Clone("ο", "r", SHA), Clone(5, "r", SHA), Clone("o", "r", None),
            Clone("o", "r", SHA, tags=("../v1",)), Clone("o", "r", SHA, tags=["v1.0.0"]),
            Clone("o", "r", SHA, tags=(1,)),
        ]
        for clone in hostile:
            with self.subTest(clone=clone):
                checker = self.make(read=lambda _f, c=clone: c)
                self.assertEqual(checker.refresh(), 0)
                self.assertEqual(checker.health()["reason"], UNREADABLE)
        self.run.assert_not_called()
        self.assertEqual(self.checker.refresh(), 2)

    def test_only_a_release_tag_reaches_the_compare(self):
        for tag in ("latest", "../x", "v1.0.0...main", "-v1"):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                self.checker.compare_argv(CLONE, tag)

    def test_gh_missing_disables_and_says_so(self):
        with mock.patch.object(updates, "find_gh", return_value=None):
            checker = UpdateChecker(run=self.run, clock_ms=self.clock, home=HOME, read=lambda _f: CLONE, git_path=GIT)
        self.assertFalse(checker.enabled)
        self.assertEqual(checker.refresh(), 0)
        health = checker.health()
        self.assertEqual((health["enabled"], health["reason"], health["lastError"]),
                         (False, GH_NOT_FOUND, GH_NOT_FOUND))
        self.run.assert_not_called()

    def test_a_copy_off_main_says_why_before_gh_missing(self):
        with mock.patch.object(updates, "find_gh", return_value=None):
            checker = UpdateChecker(run=self.run, clock_ms=self.clock, home=HOME, read=lambda _f: NOT_ON_MAIN,
                                    git_path=GIT)
        self.assertEqual(checker.health()["reason"], NOT_ON_MAIN)

    def test_relative_paths_refused(self):
        with self.assertRaises(ValueError):
            UpdateChecker(gh_path="gh", git_path=GIT, read=lambda _f: CLONE)
        with self.assertRaises(ValueError):
            UpdateChecker(gh_path=GH, git_path="git", read=lambda _f: CLONE)

    def test_gh_gets_its_sign_in_settings_and_nothing_else(self):
        with mock.patch.dict(os.environ, {"GH_CONFIG_DIR": "/Users/someone/.gh", "GH_TOKEN": "t0ken",
                                          "AWS_SECRET_ACCESS_KEY": "nope", "PATH": "/evil"}):
            checker = self.make()
        checker.refresh()
        for call in self.run.call_args_list:
            self.assertEqual(call.kwargs["env"], {"PATH": "/usr/bin:/bin", "HOME": HOME,
                                                  "GH_CONFIG_DIR": "/Users/someone/.gh", "GH_TOKEN": "t0ken"})

    def test_cancel_stops_every_later_call(self):
        self.checker.cancel()
        self.assertEqual(self.checker.refresh(), 0)
        self.run.assert_not_called()

    def test_health_never_waits_for_a_call_in_flight(self):
        started, release = threading.Event(), threading.Event()

        def slow(argv, **kwargs):
            started.set()
            release.wait(5)
            return self.answer(argv, **kwargs)

        checker = self.make(run=slow)
        worker = threading.Thread(target=checker.refresh)
        worker.start()
        self.addCleanup(worker.join, 5)
        self.addCleanup(release.set)
        self.assertTrue(started.wait(5))
        self.assertIsNone(checker.health()["state"])
        self.assertEqual(checker.releases(), [])
        release.set()
        worker.join(5)
        self.assertEqual(checker.health()["state"], "behind")


class FakePopen:
    """Stands in for subprocess.Popen: answers like the two gh calls, and blocks until told to finish or killed."""

    def __init__(self, argv, **kwargs):
        self.argv, self.kwargs = argv, kwargs
        self.returncode = None
        self.killed = threading.Event()
        self.finish = threading.Event()

    def communicate(self, timeout=None):
        while not (self.finish.is_set() or self.killed.is_set()):
            self.killed.wait(0.005)
        self.returncode = -9 if self.killed.is_set() else 0
        out = releases_out(V110) if "/releases?" in self.argv[2] else BEHIND_OUT
        return (b"" if self.killed.is_set() else out), None

    def kill(self):
        self.killed.set()


class PopenPathTests(CheckerTestCase):
    """Without an injected run, gh is started with Popen so that shutdown can kill a call in flight."""

    def test_exact_argv_env_and_streams(self):
        made = []

        def instant(argv, **kwargs):
            p = FakePopen(argv, **kwargs)
            p.finish.set()
            made.append(p)
            return p

        checker = self.make(run=None, popen=instant)
        self.assertEqual(checker.refresh(), 2)
        self.assertEqual([p.argv for p in made], [self.releases_argv(), self.compare_argv()])
        for p in made:
            self.assertEqual(p.kwargs, {"shell": False, "stdin": subprocess.DEVNULL, "stdout": subprocess.PIPE,
                                        "stderr": subprocess.DEVNULL, "env": {"PATH": "/usr/bin:/bin", "HOME": HOME}})
        self.assertEqual(checker.health()["state"], "behind")

    def test_default_popen_is_subprocess_popen_looked_up_at_call_time(self):
        checker = self.make(run=None)
        with mock.patch("subprocess.Popen", side_effect=OSError("blocked")) as popen:
            self.assertEqual(checker.refresh(), 1)
        popen.assert_called_once()
        self.assertEqual(checker.health()["lastError"], "OSError")

    def test_cancel_kills_the_call_in_flight(self):
        made = []

        def blocking(argv, **kwargs):
            p = FakePopen(argv, **kwargs)
            made.append(p)
            return p

        checker = self.make(run=None, popen=blocking)
        worker = threading.Thread(target=checker.refresh)
        worker.start()
        for _ in range(500):
            if made:
                break
            threading.Event().wait(0.005)
        self.assertEqual(len(made), 1)
        checker.cancel()
        worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertTrue(made[0].killed.is_set())
        self.assertIsNone(checker.health()["state"])
        self.assertEqual(checker.refresh(), 0)
        self.assertEqual(len(made), 1)


# ====================================================================== Update now

FETCH = [GIT, "-C", str(CODE_DIR), "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "fetch",
         "--quiet", "--tags", "--force", "--no-recurse-submodules", "origin", "main"]
MERGE = [GIT, "-C", str(CODE_DIR), "merge", "--ff-only", "--quiet", REL]
START = [PY, "-B", "-c", START_CHECK]
QUIET = dict(shell=False, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
GIT_KW = dict(QUIET, timeout=GIT_TIMEOUT_S, cwd=None,
              env={"PATH": "/usr/bin:/bin", "HOME": HOME, "GIT_TERMINAL_PROMPT": "0", "GIT_MERGE_AUTOEDIT": "no"})
START_KW = dict(QUIET, timeout=START_TIMEOUT_S, cwd=str(CODE_DIR), env={"PATH": "/usr/bin:/bin", "HOME": HOME})


class UpdateNowTests(CheckerTestCase):
    """Update now, with every git and Python launch a mock: two fixed git calls, then the start check."""

    def behind(self):
        self.checker.refresh()
        self.assertEqual(self.checker.health()["state"], "behind")

    def argvs(self):
        return [c.args[0] for c in self.update_run.call_args_list]

    def test_a_pull_is_a_fetch_then_a_fast_forward_to_the_release_then_a_start_check(self):
        self.behind()
        self.assertEqual(self.checker.update(), ("pulled", None))
        self.assertEqual(self.update_run.call_args_list, [mock.call(FETCH, **GIT_KW), mock.call(MERGE, **GIT_KW),
                                                          mock.call(START, **START_KW)])
        self.assertEqual(self.checker.code_dir, CODE_DIR)

    def test_it_fast_forwards_to_the_release_and_never_to_mains_tip(self):
        self.answers["compare"] = done(compare_out("behind", behind=2, base=SHA3))
        self.behind()
        self.checker.update()
        self.assertEqual(self.argvs()[1][-1], SHA3)
        self.assertNotIn("FETCH_HEAD", self.argvs()[1])

    def test_nothing_to_do_runs_nothing(self):
        for compared in (CURRENT_OUT, compare_out("ahead", ahead=3), compare_out("diverged", ahead=1, behind=1)):
            with self.subTest(compared=compared):
                self.answers["compare"] = done(compared)
                checker = self.make()
                self.assertEqual(checker.update(), ("nothing", None))
                checker.refresh()
                self.assertEqual(checker.update(), ("nothing", None))
        self.answers["releases"] = done(b"[]")
        checker = self.make()
        checker.refresh()
        self.assertEqual(checker.update(), ("nothing", None), "no release out yet")
        self.update_run.assert_not_called()

    def test_a_pull_needs_githubs_answer_for_this_very_commit(self):
        self.assertEqual(self.checker.update(), ("nothing", None), "no answer yet")
        self.behind()
        self.disk = Clone("thg-charliestringer", "tokentown", SHA2)
        # The commit moved after the answer, as after a pull by hand: that is a restart, and never a pull.
        self.assertEqual(self.checker.update(), ("restart", None))
        self.assertEqual(self.argvs(), [START])

    def test_a_restart_needs_neither_git_nor_gh(self):
        with mock.patch.object(updates, "find_git", return_value=None), \
                mock.patch.object(updates, "find_gh", return_value=None):
            checker = UpdateChecker(clock_ms=self.clock, home=HOME, python=PY, update_run=self.update_run,
                                    read=lambda _f: self.disk)
        self.disk = Clone("thg-charliestringer", "tokentown", SHA2)
        self.assertEqual(checker.update(), ("restart", None))
        self.assertEqual(self.argvs(), [START])

    def test_no_pull_without_git_or_an_https_origin(self):
        with mock.patch.object(updates, "find_git", return_value=None):
            no_git = self.make(git_path=None)
        cases = [(no_git, CLONE), (self.make(), Clone("thg-charliestringer", "tokentown", SHA, https=False))]
        for checker, clone in cases:
            with self.subTest(clone=clone, git=checker.git_path):
                self.disk = clone
                checker.refresh()
                self.assertEqual(checker.health()["state"], "behind")
                self.assertFalse(checker.health()["canPull"])
                self.assertEqual(checker.update(), ("nothing", None))
        self.update_run.assert_not_called()

    def test_each_failing_step_stops_there_and_says_which(self):
        ok, fails, odd = (subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 1),
                          subprocess.CompletedProcess([], None))
        cases = [
            ([subprocess.CompletedProcess([], 128)], ("fetch", "exit 128"), [FETCH]),
            ([subprocess.TimeoutExpired(FETCH, 60, output=b"secret")], ("fetch", "TimeoutExpired"), [FETCH]),
            ([OSError("/secret/path")], ("fetch", "OSError"), [FETCH]),
            ([ok, fails], ("merge", "exit 1"), [FETCH, MERGE]),
            ([ok, odd], ("merge", "BadResponse"), [FETCH, MERGE]),
            ([ok, ok, fails], ("start", "exit 1"), [FETCH, MERGE, START]),
        ]
        for outcomes, expected, argvs in cases:
            with self.subTest(expected=expected):
                self.update_run.reset_mock()
                self.update_run.side_effect = outcomes
                checker = self.make()
                checker.refresh()
                self.assertEqual(checker.update(), expected)
                self.assertEqual(self.argvs(), argvs)
                self.assertNotIn("secret", repr(checker.health()))

    def test_a_python_it_cannot_name_never_restarts(self):
        for python in ("python3", "", None):
            with self.subTest(python=python):
                self.update_run.reset_mock()
                self.update_run.side_effect = None
                checker = self.make(python=python)
                checker.refresh()
                self.assertEqual(checker.update(), ("start", PYTHON_NOT_FOUND))
                self.assertEqual(self.argvs(), [FETCH, MERGE])

    def test_a_second_update_while_one_runs_is_busy(self):
        self.behind()
        started, release = threading.Event(), threading.Event()

        def slow(argv, **_kwargs):
            started.set()
            release.wait(5)
            return subprocess.CompletedProcess(argv, 0)

        self.update_run.side_effect = slow
        results = []
        worker = threading.Thread(target=lambda: results.append(self.checker.update()))
        worker.start()
        self.addCleanup(worker.join, 5)
        self.addCleanup(release.set)
        self.assertTrue(started.wait(5))
        self.assertEqual(self.checker.update(), ("busy", None))
        release.set()
        worker.join(5)
        self.assertEqual(results, [("pulled", None)])
        self.assertEqual(self.checker.update(), ("pulled", None), "the lock is free again")

    def test_git_gets_a_fixed_env_that_never_prompts(self):
        with mock.patch.dict(os.environ, {"GH_CONFIG_DIR": "/Users/someone/.gh", "SSH_AUTH_SOCK": "/tmp/agent",
                                          "GIT_DIR": "/elsewhere", "GIT_SSH_COMMAND": "evil", "HTTPS_PROXY": "x",
                                          "PATH": "/evil"}):
            checker = self.make()
        checker.refresh()
        checker.update()
        env = self.update_run.call_args_list[0].kwargs["env"]
        self.assertEqual(env, {"PATH": "/usr/bin:/bin", "HOME": HOME, "GH_CONFIG_DIR": "/Users/someone/.gh",
                               "GIT_TERMINAL_PROMPT": "0", "GIT_MERGE_AUTOEDIT": "no"})
        self.assertEqual(self.update_run.call_args_list[2].kwargs["env"], {"PATH": "/usr/bin:/bin", "HOME": HOME})

    def test_every_argv_is_fixed_and_https_alone(self):
        self.behind()
        self.checker.update()
        for argv in self.argvs():
            self.assertTrue(all(isinstance(a, str) for a in argv))
            self.assertTrue(os.path.isabs(argv[0]))
        fetch = self.argvs()[0]
        self.assertEqual(fetch[3:7], ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always"])
        self.assertLess(fetch.index("protocol.https.allow=always"), fetch.index("fetch"))
        self.assertNotIn("pull", fetch + self.argvs()[1])

    def test_only_a_full_commit_reaches_the_merge(self):
        for commit in ("main", "FETCH_HEAD", "v1.1.0", REL.upper(), REL[:7], "--ff", None):
            with self.subTest(commit=commit), self.assertRaises(ValueError):
                self.checker.merge_argv(commit)


class FindGitTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)

    def executable(self, name: str) -> str:
        path = self.dir / name
        path.write_text("#!/bin/sh\n")
        path.chmod(0o755)
        return str(path)

    def test_the_first_executable_candidate_wins(self):
        (self.dir / "plain").write_text("")
        (self.dir / "folder").mkdir()
        first, second = self.executable("git1"), self.executable("git2")
        candidates = (str(self.dir / "nope"), str(self.dir / "plain"), str(self.dir / "folder"), first, second)
        self.assertEqual(find_git(candidates, apple=()), first)
        self.assertIsNone(find_git(("git", "bin/git"), apple=()))

    def test_the_apple_stub_only_when_xcode_or_the_command_line_tools_are_there(self):
        self.assertIsNone(find_git((), apple=(str(self.dir / "missing"),)))
        if os.access(updates.APPLE_GIT, os.X_OK):
            self.assertEqual(find_git((), apple=(self.executable("developer-git"),)), updates.APPLE_GIT)

    def test_candidates_cover_the_usual_installs(self):
        self.assertEqual(updates.GIT_CANDIDATES[:2], ("/opt/homebrew/bin/git", "/usr/local/bin/git"))
        self.assertEqual(updates.APPLE_GIT, "/usr/bin/git")

    def test_read_clone_notes_whether_origin_is_https(self):
        for n, (url, https) in enumerate((("https://github.com/o/r.git", True), ("git@github.com:o/r.git", False),
                                          ("ssh://git@github.com/o/r.git", False))):
            with self.subTest(url=url):
                folder = self.dir / f"clone{n}"
                (folder / ".git" / "refs" / "heads").mkdir(parents=True)
                (folder / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
                (folder / ".git" / "refs" / "heads" / "main").write_text(SHA + "\n")
                (folder / ".git" / "config").write_text(f'[remote "origin"]\n\turl = {url}\n')
                self.assertEqual(read_clone(folder), Clone("o", "r", SHA, https=https))


class StartCheckTests(unittest.TestCase):
    """The start check's own words, run for real in a fresh Python: nothing else here starts a process."""

    def run_check(self, folder: Path) -> int:
        return subprocess.run([updates.sys.executable, "-B", "-c", START_CHECK], cwd=str(folder), shell=False,
                              timeout=60, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, env={"PATH": "/usr/bin:/bin", "HOME": str(folder)}).returncode

    def test_this_checkout_passes(self):
        self.assertEqual(self.run_check(CODE_DIR), 0)

    def test_a_launcher_that_will_not_compile_or_a_server_that_will_not_import_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "town").mkdir()
            (root / "town" / "__init__.py").write_text("")
            (root / "town" / "server.py").write_text("x = 1\n")
            (root / "tokentown").write_text("#!/usr/bin/env python3\nprint('ok')\n")
            self.assertEqual(self.run_check(root), 0)
            (root / "tokentown").write_text("def broken(:\n")
            self.assertNotEqual(self.run_check(root), 0)
            (root / "tokentown").write_text("print('ok')\n")
            (root / "town" / "server.py").write_text("from .gone import thing\n")
            self.assertNotEqual(self.run_check(root), 0)
            self.assertFalse(list(root.rglob("__pycache__")), "-B: the check writes no .pyc")


# ====================================================================== the command the page copies

class UpdateCommandTests(unittest.TestCase):
    FOLDER = "/Users/someone/tools/tokentown"
    BEHIND = {"enabled": True, "state": "behind", "restart": False, "latest": {"tag": "v1.1.0"}}

    def test_a_fast_forward_to_the_release_then_a_restart(self):
        self.assertEqual(update_command(self.FOLDER, self.BEHIND),
                         "cd /Users/someone/tools/tokentown && git fetch --tags origin && git merge --ff-only v1.1.0"
                         " && ./tokentown stop && ./tokentown")
        self.assertEqual(update_command(Path(self.FOLDER), dict(self.BEHIND, restart=True)),
                         update_command(self.FOLDER, self.BEHIND))

    def test_a_restart_alone_once_pulled(self):
        self.assertEqual(update_command(self.FOLDER, {"enabled": True, "state": "current", "restart": True}),
                         "cd /Users/someone/tools/tokentown && ./tokentown stop && ./tokentown")

    def test_nothing_to_do_is_none(self):
        for health in ({"enabled": True, "state": "current", "restart": False},
                       {"enabled": True, "state": "ahead"}, {"enabled": True, "state": "diverged"},
                       {"enabled": True, "state": None}, dict(self.BEHIND, enabled=False, restart=True),
                       dict(self.BEHIND, enabled="yes"), {"enabled": True, "state": "current", "restart": 1},
                       {"enabled": True, "state": "behind"}, dict(self.BEHIND, latest=None),
                       dict(self.BEHIND, latest={"tag": "v1.1.0; rm -rf ~"}), dict(self.BEHIND, latest={"tag": 5}),
                       dict(self.BEHIND, latest="v1.1.0"), {}, None, "behind"):
            with self.subTest(health=health):
                self.assertIsNone(update_command(self.FOLDER, health))

    def test_the_folder_is_quoted_and_a_misleading_one_refused(self):
        folder = "/tmp/it's a \"folder\"; rm -rf ~ #"
        command = update_command(folder, self.BEHIND)
        self.assertEqual(shlex.split(command)[:2], ["cd", folder])
        for bad in ("/tmp/a\nb", "/tmp/safe‮evil", "/tmp/zero​width", "relative/folder", "", None,
                    b"/tmp/bytes", 5):
            with self.subTest(bad=bad):
                self.assertIsNone(update_command(bad, self.BEHIND))


if __name__ == "__main__":
    unittest.main()
