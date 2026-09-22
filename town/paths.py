"""Where Tokentown reads from, and the files it must never read."""
from __future__ import annotations

import os
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

HOST = "127.0.0.1"
PORT = 47291
ORIGIN = f"http://{HOST}:{PORT}"
CODE_DIR = Path(__file__).resolve().parent.parent

# Health names each folder by one of these labels, never by its path.
CLAUDE_DIR_LABEL = "~/.claude"
CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR"
# The Claude app keeps everything in Claude-3p instead of Claude when it is set up for a third-party provider.
APP_DATA_NAMES = ("Claude", "Claude-3p")
DESKTOP_SESSIONS = "claude-code-sessions"
PLAN_USAGE = "plan-usage-history.json"
APP_PLIST = Path("Claude.app") / "Contents" / "Info.plist"
SYSTEM_APPLICATIONS = Path("/Applications")

UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
# \Z, not $: in Python $ also matches just before a trailing newline, so "local_<uuid>\n" would pass.
UUID_RE = re.compile(rf"^{UUID}\Z")
LOCAL_ID_RE = re.compile(rf"^local_{UUID}\Z")
CLI_ROW_ID_RE = re.compile(rf"^cli:{UUID}\Z")
OPEN_URL_RE = re.compile(rf"^claude://claude\.ai/epitaxy/local_{UUID}\Z")


@dataclass(frozen=True)
class Editor:
    """An editor the Claude Code extension runs in. Its chat sets the same entrypoint in every one of them, so only a
    live session's process tree tells them apart."""
    key: str  # a board row's `editor`, and a key of the page's EDITOR_NAME
    app: str  # the app bundle's folder name: every one of the editor's processes has /<app>/ in its args
    bundle_id: str  # for `open -b`
    scheme: str  # the URL scheme the extension answers session links on in this editor


EDITORS = (
    Editor("vscode", "Visual Studio Code.app", "com.microsoft.VSCode", "vscode"),
    Editor("vscode-insiders", "Visual Studio Code - Insiders.app", "com.microsoft.VSCodeInsiders", "vscode-insiders"),
    Editor("cursor", "Cursor.app", "com.todesktop.230313mzl4w4u92", "cursor"),
)
EDITOR_BY_KEY = {editor.key: editor for editor in EDITORS}
# The extension's handler resumes the session in whichever window of its editor is focused, and only finds it when
# that window has the session's folder open: anywhere else it quietly starts a new conversation instead.
EDITOR_OPEN_URL_RE = re.compile(
    rf"^(?:{'|'.join(re.escape(e.scheme) for e in EDITORS)})://anthropic\.claude-code/open\?session={UUID}\Z")
# A visitor id (reviews.review_id) is a digest of a PR URL, so the id the page sends back can hold no path,
# URL or command of its own.
REVIEW_ID_RE = re.compile(r"^pr:[0-9a-f]{16}\Z")
# ASCII classes, not \w and \d (those match non-ASCII letters and digits), and no "." or ".." segment, which gh
# would send on as a dot segment of the API path.
PR_URL_RE = re.compile(
    r"^https://github\.com/(?!\.\.?/)[A-Za-z0-9_.-]+/(?!\.\.?/)[A-Za-z0-9_.-]+/pull/[0-9]{1,10}\Z")
# A release tag as `gh release create v1.2.0` makes one. Only these reach an argv, a GitHub API path or a command the
# page copies, so nothing in one can be read as a flag, a path or shell syntax.
RELEASE_TAG_RE = re.compile(r"v?[0-9]{1,6}(?:\.[0-9]{1,6}){0,3}\Z")
# A GitHub team slug as the page may be handed one. It only ever reaches textContent, never an argv or a URL.
# ASCII for the same reason as above: a slug with a space, a slash or a look-alike letter is not GitHub's.
TEAM_SLUG_RE = re.compile(r"^[A-Za-z0-9_-]+\Z")

# Credentials and browser state live next to the session stores. The .key files beside
# ~/.claude/sessions/<pid>.json can drive live sessions over their messaging sockets.
DENY_NAMES = frozenset({"config.json", "buddy-tokens.json", "bridge-state.json", "Cookies"})
DENY_PARTS = frozenset({"Local Storage", "IndexedDB"})
DENY_SUFFIXES = (".key",)


@dataclass(frozen=True)
class Paths:
    home: Path
    # None looks for Claude.app in each of `applications`.
    claude_app_plist: Path | None = None
    # CLAUDE_CONFIG_DIR as Tokentown was started with it. See config_dir_from.
    config_dir: Path | None = None
    system_applications: Path = SYSTEM_APPLICATIONS

    @property
    def claude_dirs(self) -> tuple[tuple[str, Path], ...]:
        """Every Claude Code folder with its label, the one Claude Code writes to now first.

        A session started without CLAUDE_CONFIG_DIR still writes to ~/.claude, so that is always read too.
        """
        default = self.home / ".claude"
        if self.config_dir is None or self.config_dir == default:
            return ((CLAUDE_DIR_LABEL, default),)
        return ((CONFIG_DIR_ENV, self.config_dir), (CLAUDE_DIR_LABEL, default))

    @property
    def claude_dir(self) -> Path:
        """The first of claude_dirs. The scanner reads them all."""
        return self.claude_dirs[0][1]

    @property
    def sessions_dir(self) -> Path:
        return self.claude_dir / "sessions"

    @property
    def projects_dir(self) -> Path:
        return self.claude_dir / "projects"

    @property
    def app_dirs(self) -> tuple[tuple[str, Path], ...]:
        """Every folder the Claude app may keep its data in, with its label."""
        support = self.home / "Library" / "Application Support"
        return tuple((name, support / name) for name in APP_DATA_NAMES)

    @property
    def desktop_sessions_dir(self) -> Path:
        """The first app folder's session records. The scanner reads every app folder's."""
        return self.app_dirs[0][1] / DESKTOP_SESSIONS

    @property
    def applications(self) -> tuple[Path, ...]:
        """Where apps are installed: /Applications, then ~/Applications, where an install without admin rights goes."""
        return (self.system_applications, self.home / "Applications")

    @property
    def app_plists(self) -> tuple[Path, ...]:
        if self.claude_app_plist is not None:
            return (self.claude_app_plist,)
        return tuple(folder / APP_PLIST for folder in self.applications)

    @property
    def secret_dir(self) -> Path:
        return self.home / "Library" / "Application Support" / "tokentown"

    @property
    def secret_file(self) -> Path:
        return self.secret_dir / "secret"

    @property
    def plan_usage_file(self) -> Path:
        """The first app folder's usage history. The scanner reads every app folder's."""
        return self.app_dirs[0][1] / PLAN_USAGE

    def transcript_path(self, cwd: str, cli_session_id: str, projects_dir: Path | None = None) -> Path:
        """Where Claude Code writes a session's transcript, in projects_dir or the first Claude Code folder's.

        Only right for a folder name of 200 characters or fewer: Claude Code cuts a longer one and adds a hash,
        and a host can name the folder itself. The scanner finds those by the session's id instead.
        """
        return (projects_dir or self.projects_dir) / re.sub(r"[^A-Za-z0-9]", "-", cwd) / f"{cli_session_id}.jsonl"


def config_dir_from(value: str | None) -> Path | None:
    """CLAUDE_CONFIG_DIR as the Claude app reads it: unset or empty means ~/.claude, and the rest is NFC-normalised.

    A relative path is kept, so health can report it as not found, but the scanner never reads it: Claude Code
    refuses one, and it would resolve against the server's own folder.
    """
    if not value:
        return None
    return Path(unicodedata.normalize("NFC", value))


def default_paths() -> Paths:
    # TOWN_HOME exists for tests that build a synthetic home; it never changes the bind address, and a synthetic
    # home never reads the real CLAUDE_CONFIG_DIR.
    town_home = os.environ.get("TOWN_HOME")
    if town_home:
        return Paths(home=Path(town_home))
    return Paths(home=Path.home(), config_dir=config_dir_from(os.environ.get(CONFIG_DIR_ENV)))


def is_denied(path: Path | str) -> bool:
    p = Path(path)
    return p.name in DENY_NAMES or p.name.endswith(DENY_SUFFIXES) or any(part in DENY_PARTS for part in p.parts)


def open_for_read(path: Path | str, mode: str = "rb"):
    """The only way Tokentown code opens a file from a session store."""
    if "r" not in mode or any(c in mode for c in "wax+"):
        raise PermissionError("Tokentown never writes to a session store")
    if is_denied(path):
        raise PermissionError(f"denied by the Tokentown read policy: {Path(path).name}")
    return open(path, mode)
