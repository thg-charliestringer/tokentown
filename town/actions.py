"""Open a session in the Claude app or its editor, and build the commands the page copies: a terminal session's
resume command, and the one that updates Tokentown itself."""
from __future__ import annotations

import os
import shlex
import subprocess
import threading
import time
import unicodedata

from .model import RawSnapshot
from .paths import (CLI_ROW_ID_RE, EDITOR_BY_KEY, EDITOR_OPEN_URL_RE, LOCAL_ID_RE, OPEN_URL_RE, RELEASE_TAG_RE, UUID_RE,
                    Editor)

OPEN_BIN = "/usr/bin/open"
OPEN_MIN_INTERVAL_S = 0.7
# An editor hands a session link to its last active window, so the window with the session's folder needs a moment to
# come forward (or open) before the link follows.
EDITOR_SESSION_PAUSE_S = 1.0
SUBPROCESS_ENV = {"PATH": "/usr/bin:/bin"}

# Control, format (bidi overrides, zero-width), surrogate and line/paragraph separator characters.
# A format character can make a pasted command read differently from what the shell runs.
_REFUSED_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Zl", "Zp"})


def _board_row(board: dict | None, row_id: str) -> dict | None:
    if not isinstance(board, dict):
        return None
    for row in board.get("sessions") or ():
        if isinstance(row, dict) and row.get("id") == row_id:
            return row
    return None


def _cli_transcript(raw: RawSnapshot | None, uuid: str):
    if raw is None:
        return None
    return next((cli for cli in raw.cli_only if cli.session_id == uuid), None)


def editor_folder_args(editor: Editor, cwd: object) -> list[str] | None:
    """open's arguments that bring forward the editor's window with this folder, or None for a folder not to name.

    macOS hands the editor an open-file request, which reuses the window that already has the folder open. A
    vscode://file link would do the same, but VS Code asks before it follows one from another app.
    """
    if not _safe_cwd(cwd) or cwd == "/" or cwd != os.path.normpath(cwd):
        return None
    return ["-b", editor.bundle_id, cwd]


def open_commands(row_id: object, board: dict | None, raw: RawSnapshot | None = None) -> list[list[str]] | None:
    """open's arguments for each step a board row opens, in order, or None when it opens nothing.

    A desktop session opens in the Claude app. A session in an editor (VS Code, VS Code Insiders or Cursor) first
    brings forward that editor's window with its folder; only when it is closed there does its session link follow,
    because that link finds just a tab it opened itself and would start a second copy of a session still open.
    """
    if not isinstance(row_id, str):
        return None
    desktop = bool(LOCAL_ID_RE.match(row_id))
    if not desktop and not CLI_ROW_ID_RE.match(row_id):
        return None
    row = _board_row(board, row_id)
    if row is None or row.get("canOpen") is not True:
        return None
    if desktop:
        url = f"claude://claude.ai/epitaxy/{row_id}"
        return [[url]] if OPEN_URL_RE.match(url) else None
    if row.get("surface") != "vscode":
        return None
    key = row.get("editor")
    editor = EDITOR_BY_KEY.get(key) if isinstance(key, str) else None
    if editor is None:
        return None
    uuid = row_id[len("cli:"):]
    cli = _cli_transcript(raw, uuid)
    folder = editor_folder_args(editor, cli.cwd) if cli is not None and cli.cwd_exists else None
    if folder is None:
        return None
    if row.get("live") is not False:
        return [folder]
    session = f"{editor.scheme}://anthropic.claude-code/open?session={uuid}"
    return [folder, [session]] if EDITOR_OPEN_URL_RE.match(session) else None


class Opener:
    def __init__(self, run=subprocess.run, clock=time.monotonic, sleep=time.sleep):
        self._run = run
        self._clock = clock
        self._sleep = sleep
        self._lock = threading.Lock()
        self._last: float | None = None

    def open(self, session_id: str, board: dict | None, raw: RawSnapshot | None = None) -> int:
        """HTTP status: 200 opened, 404 not an openable board row, 429 too soon, 500 open failed."""
        steps = open_commands(session_id, board, raw)
        if steps is None:
            return 404
        with self._lock:
            now = self._clock()
            if self._last is not None and now - self._last < OPEN_MIN_INTERVAL_S:
                return 429
            self._last = now
        for i, args in enumerate(steps):
            if i:
                self._sleep(EDITOR_SESSION_PAUSE_S)
            if not self._open_one(args):
                return 500
        return 200

    def _open_one(self, args: list[str]) -> bool:
        try:
            result = self._run(
                [OPEN_BIN, *args],
                shell=False,
                timeout=10,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=dict(SUBPROCESS_ENV),
            )
        except (OSError, subprocess.SubprocessError):
            return False
        returncode = getattr(result, "returncode", 0)
        return not (isinstance(returncode, int) and returncode != 0)


def _safe_cwd(cwd: object) -> bool:
    return (
        isinstance(cwd, str)
        and cwd.startswith("/")
        and not any(unicodedata.category(ch) in _REFUSED_CATEGORIES for ch in cwd)
    )


def resume_command(row_id: str, raw: RawSnapshot | None, board: dict | None) -> str | None:
    if not isinstance(row_id, str) or not CLI_ROW_ID_RE.match(row_id) or raw is None:
        return None
    row = _board_row(board, row_id)
    if row is None or row.get("canCopyResume") is not True:
        return None
    uuid = row_id[len("cli:"):]
    if not UUID_RE.match(uuid):
        return None
    cli = _cli_transcript(raw, uuid)
    if cli is None or not cli.cwd_exists or not _safe_cwd(cli.cwd):
        return None
    return f"cd {shlex.quote(cli.cwd)} && claude --resume {uuid}"


def update_command(code_dir: object, updates: object) -> str | None:
    """The command that brings this copy up to date and restarts it, while health.updates has one to give, else None.

    A fast-forward to the newest release when one is out, else a restart once a pull has changed the code on disk.
    Only --ff-only, so a copy with commits of its own is never merged into.
    """
    if not isinstance(updates, dict) or updates.get("enabled") is not True:
        return None
    folder = os.fspath(code_dir) if isinstance(code_dir, (str, os.PathLike)) else None
    if not _safe_cwd(folder):
        return None
    restart = "./tokentown stop && ./tokentown"
    if updates.get("state") == "behind":
        latest = updates.get("latest")
        tag = latest.get("tag") if isinstance(latest, dict) else None
        if not isinstance(tag, str) or not RELEASE_TAG_RE.fullmatch(tag):
            return None
        return f"cd {shlex.quote(folder)} && git fetch --tags origin && git merge --ff-only {tag} && {restart}"
    if updates.get("restart") is True:
        return f"cd {shlex.quote(folder)} && {restart}"
    return None
