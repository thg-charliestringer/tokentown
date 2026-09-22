"""The shared secret, the HMAC values derived from it, and the request guards the server applies."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import plistlib
import re
import secrets
import stat
import threading
from pathlib import Path

from .paths import HOST, Paths

SECRET_BYTES = 32
CODE_TTL_MS = 30_000
CODE_FUTURE_SKEW_MS = 1_000
USED_NONCE_MEMORY_MS = 60_000
MAX_BODY = 1024

NONCE_RE = re.compile(r"[0-9a-f]{32}")
CODE_RE = re.compile(r"([0-9a-f]{32})\.([0-9]{1,15})\.([0-9a-f]{64})")
_SECRET_TEXT_RE = re.compile(r"[0-9a-f]{64}")
_LENGTH_RE = re.compile(r"[0-9]{1,7}")

STATIC_FETCH_SITES = frozenset({"same-origin", "none"})
API_FETCH_SITES = frozenset({"same-origin"})

SECURITY_HEADERS = (
    ("Content-Security-Policy",
     "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
     "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
    ("Cross-Origin-Opener-Policy", "same-origin"),
    ("Cross-Origin-Resource-Policy", "same-origin"),
    ("Cache-Control", "no-store"),
)


# ---------------------------------------------------------------- secret file

def _prepare_dir(directory: Path) -> None:
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    st = os.lstat(directory)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
        raise PermissionError("the Tokentown secret directory is not a plain directory owned by this user")
    if stat.S_IMODE(st.st_mode) != 0o700:
        os.chmod(directory, 0o700)


def _read_secret_file(path: Path) -> bytes | None:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "rb") as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid():
            raise PermissionError("the Tokentown secret is not a regular file owned by this user")
        if stat.S_IMODE(st.st_mode) != 0o600:
            os.fchmod(f.fileno(), 0o600)
        data = f.read(256)
    text = data.decode("ascii", "replace").strip()
    if not _SECRET_TEXT_RE.fullmatch(text):
        raise ValueError("the Tokentown secret file is malformed; run: tokentown rotate")
    return bytes.fromhex(text)


def _write_new_secret(directory: Path, final: Path, *, replace: bool) -> bytes:
    secret = secrets.token_bytes(SECRET_BYTES)
    tmp = directory / f".secret.{secrets.token_hex(8)}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(secret.hex().encode("ascii") + b"\n")
            f.flush()
            os.fsync(f.fileno())
        if replace:
            os.replace(tmp, final)
        else:
            # link() refuses an existing name, so a second launcher racing this one never sees a
            # half-written secret: it either wins the name or reads the complete file.
            os.link(tmp, final)
    finally:
        tmp.unlink(missing_ok=True)
    return secret


def read_secret(paths: Paths) -> bytes | None:
    """The current secret, or None when it has never been created."""
    return _read_secret_file(paths.secret_file)


def load_or_create_secret(paths: Paths) -> bytes:
    _prepare_dir(paths.secret_dir)
    existing = _read_secret_file(paths.secret_file)
    if existing is not None:
        return existing
    try:
        return _write_new_secret(paths.secret_dir, paths.secret_file, replace=False)
    except FileExistsError:
        winner = _read_secret_file(paths.secret_file)
        if winner is None:
            raise
        return winner


def rotate_secret(paths: Paths) -> None:
    _prepare_dir(paths.secret_dir)
    _write_new_secret(paths.secret_dir, paths.secret_file, replace=True)


# ---------------------------------------------------------------- launch file
# The launch URL goes to Safari inside a .webloc file, never in argv: any local user can read every
# process's arguments through the setuid /bin/ps and claim the code first.

LAUNCH_FILE_RE = re.compile(r"launch-[0-9a-f]{16}\.webloc")
LAUNCH_FILE_MAX_AGE_MS = 60_000


def remove_stale_launch_files(paths: Paths, now_ms: int, max_age_ms: int = LAUNCH_FILE_MAX_AGE_MS) -> int:
    """Delete launch files old enough that their code has expired. Returns how many were removed."""
    removed = 0
    try:
        names = os.listdir(paths.secret_dir)
    except OSError:
        return 0
    for name in names:
        if not LAUNCH_FILE_RE.fullmatch(name):
            continue
        path = paths.secret_dir / name
        try:
            st = os.lstat(path)
            if now_ms - st.st_mtime_ns // 1_000_000 > max_age_ms:
                path.unlink()
                removed += 1
        except OSError:
            continue
    return removed


def write_launch_file(paths: Paths, url: str) -> Path:
    """A 0600 .webloc holding the launch URL, inside the 0700 secret directory."""
    _prepare_dir(paths.secret_dir)
    path = paths.secret_dir / f"launch-{secrets.token_hex(8)}.webloc"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(plistlib.dumps({"URL": url}))
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return path


# ---------------------------------------------------------------- HMAC values

def _mac(secret: bytes, message: str) -> str:
    return hmac.new(secret, message.encode("ascii"), hashlib.sha256).hexdigest()


def health_response(secret: bytes, nonce: str) -> str:
    return _mac(secret, "health|" + nonce)


def session_token(secret: bytes) -> str:
    return _mac(secret, "session")


def mint_code(secret: bytes, now_ms: int) -> str:
    nonce = secrets.token_hex(16)
    ts = str(int(now_ms))
    return f"{nonce}.{ts}.{_mac(secret, 'claim|' + nonce + '|' + ts)}"


CLAIM_OK = "ok"
CLAIM_INVALID = "invalid"
CLAIM_REPLAYED = "replayed"


class CodeVerifier:
    """Launch codes are valid for 30 s and only once."""

    def __init__(self, secret: bytes):
        self._secret = secret
        self._used: dict[str, int] = {}
        self._lock = threading.Lock()

    def check(self, code: str, now_ms: int) -> str:
        """CLAIM_OK, CLAIM_INVALID, or CLAIM_REPLAYED for a genuine code whose nonce was already claimed.

        A replay means someone else saw the code, so it is reported even once the code has expired.
        """
        if not isinstance(code, str):
            return CLAIM_INVALID
        m = CODE_RE.fullmatch(code)
        if m is None:
            return CLAIM_INVALID
        nonce, ts_text, mac = m.groups()
        ts = int(ts_text)
        if not hmac.compare_digest(mac, _mac(self._secret, f"claim|{nonce}|{ts_text}")):
            return CLAIM_INVALID
        with self._lock:
            for old, used_at in list(self._used.items()):
                if now_ms - used_at > USED_NONCE_MEMORY_MS:
                    del self._used[old]
            if nonce in self._used:
                return CLAIM_REPLAYED
            if now_ms - ts > CODE_TTL_MS or ts - now_ms > CODE_FUTURE_SKEW_MS:
                return CLAIM_INVALID
            self._used[nonce] = now_ms
        return CLAIM_OK

    def verify(self, code: str, now_ms: int) -> bool:
        return self.check(code, now_ms) == CLAIM_OK


# ---------------------------------------------------------------- request guards
# Each takes the list from `headers.get_all(name)` (None when absent). A repeated header is refused.

def _single(values: list[str] | None) -> str | None:
    return values[0] if values is not None and len(values) == 1 else None


def host_ok(values: list[str] | None, port: int) -> bool:
    return _single(values) == f"{HOST}:{port}"


def origin_ok(values: list[str] | None, port: int) -> bool:
    return _single(values) == f"http://{HOST}:{port}"


def fetch_site_ok(values: list[str] | None, *, api: bool) -> bool:
    if values is None:
        return True
    return _single(values) in (API_FETCH_SITES if api else STATIC_FETCH_SITES)


def token_ok(values: list[str] | None, token: str) -> bool:
    value = _single(values)
    return value is not None and hmac.compare_digest(value.encode("utf-8", "replace"), token.encode("ascii"))


def content_type_ok(values: list[str] | None) -> bool:
    value = _single(values)
    return value is not None and value.split(";", 1)[0].strip().lower() == "application/json"


def body_length(length_values: list[str] | None, transfer_encoding_values: list[str] | None) -> int | None:
    """The body length to read, or None to refuse the request without reading anything."""
    if transfer_encoding_values:
        return None
    value = _single(length_values)
    if value is None or not _LENGTH_RE.fullmatch(value.strip()):
        return None
    length = int(value.strip())
    return length if length <= MAX_BODY else None


def _no_duplicate_keys(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("duplicate key")
        obj[key] = value
    return obj


def parse_json_object(body: bytes, keys: frozenset[str]) -> dict[str, str] | None:
    """A JSON object with exactly `keys`, every value a string; otherwise None."""
    try:
        obj = json.loads(body.decode("utf-8"), object_pairs_hook=_no_duplicate_keys)
    except (UnicodeDecodeError, ValueError, RecursionError):
        return None
    if not isinstance(obj, dict) or set(obj) != set(keys):
        return None
    if not all(isinstance(v, str) for v in obj.values()):
        return None
    return obj
