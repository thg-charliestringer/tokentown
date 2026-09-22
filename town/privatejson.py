"""Small JSON files Tokentown keeps in its own 0700 directory: loaded defensively, written atomically.

Used by the done store and the PR link store. Nothing here ever reads or writes inside a Claude folder.
"""
from __future__ import annotations

import json
import os
import secrets
import stat
from pathlib import Path


def _reject_constant(_name: str):
    raise ValueError("NaN and Infinity are not JSON")


def prepare_dir(directory: Path) -> None:
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    st = os.lstat(directory)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
        raise PermissionError("the Tokentown directory is not a plain directory owned by this user")
    if stat.S_IMODE(st.st_mode) != 0o700:
        os.chmod(directory, 0o700)


def load(path: Path, max_bytes: int) -> object | None:
    """The decoded JSON, or None for a missing, foreign, special, oversized or malformed file. Never raises."""
    try:
        # O_NONBLOCK so a FIFO planted at the name cannot hang the server on open.
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except (OSError, ValueError):
        return None
    try:
        with os.fdopen(fd, "rb") as f:
            st = os.fstat(f.fileno())
            if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid():
                return None
            data = f.read(max_bytes + 1)
    except OSError:
        return None
    if len(data) > max_bytes:
        return None
    try:
        return json.loads(data.decode("utf-8"), parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError, RecursionError):
        return None


def encode(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("ascii") + b"\n"


def write(directory: Path, path: Path, body: bytes, tmp_prefix: str) -> None:
    """Temp file (O_EXCL | O_NOFOLLOW, 0600), fsync, rename over `path`. Raises OSError; leaves no temp file."""
    prepare_dir(directory)
    tmp = directory / f"{tmp_prefix}{secrets.token_hex(8)}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            os.fchmod(f.fileno(), 0o600)
            f.write(body)
            f.flush()
            os.fsync(f.fileno())
        # rename replaces a symlink at the name rather than writing through it.
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)
