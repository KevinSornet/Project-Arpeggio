"""Passwords, sessions and roles for Arpeggio (standard library only)."""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import threading
import time

ROLES = {
    "admin": "Admin — everything, incl. users and data references",
    "manager": "Manager — all dealers' releases and dashboard",
    "dealer": "Dealer staff — only their own dealer",
}
SESSION_COOKIE = "arp_session"
SESSION_DAYS = 14
PBKDF2_ITER = 240_000

_ROOT = os.path.dirname(os.path.abspath(__file__))


def _secret() -> bytes:
    key = os.environ.get("SECRET_KEY", "").strip()
    if key:
        return key.encode()
    path = os.path.join(_ROOT, ".secret_key")  # local dev: generate once, keep out of git
    if not os.path.exists(path):
        with open(path, "w") as f:
            f.write(secrets.token_hex(32))
        os.chmod(path, 0o600)
    return open(path).read().strip().encode()


SECRET = _secret()


# ---------------------------------------------------------------- passwords
def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, PBKDF2_ITER)
    return f"pbkdf2_sha256${PBKDF2_ITER}${salt.hex()}${dk.hex()}"


def verify_password(pw: str, stored: str) -> bool:
    try:
        algo, it, salt, digest = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), int(it))
        return hmac.compare_digest(dk.hex(), digest)
    except (ValueError, AttributeError):
        return False


def password_problem(pw: str) -> str | None:
    if len(pw or "") < 8:
        return "Password must be at least 8 characters"
    return None


# ---------------------------------------------------------------- sessions
def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _sign(payload: str) -> str:
    return _b64(hmac.new(SECRET, payload.encode(), hashlib.sha256).digest())


def _version(password_hash: str) -> str:
    # changes whenever the password changes, which signs out old sessions
    return hashlib.sha256((password_hash or "").encode()).hexdigest()[:12]


def make_token(user: dict) -> str:
    payload = f"{user['id']}.{int(time.time())}.{_version(user['password_hash'])}"
    return f"{payload}.{_sign(payload)}"


def read_token(token: str) -> tuple[int, str] | None:
    """Returns (user_id, password_version) if the token is genuine and not expired."""
    try:
        uid, issued, ver, sig = token.split(".")
    except (ValueError, AttributeError):
        return None
    payload = f"{uid}.{issued}.{ver}"
    if not hmac.compare_digest(sig, _sign(payload)):
        return None
    if time.time() - int(issued) > SESSION_DAYS * 86400:
        return None
    return int(uid), ver


def token_matches(user: dict, ver: str) -> bool:
    return bool(user) and bool(user.get("active")) and hmac.compare_digest(ver, _version(user["password_hash"]))


# ---------------------------------------------------------------- login throttling
class Throttle:
    """At most `limit` failed logins per key in `window` seconds."""

    def __init__(self, limit=8, window=900):
        self.limit, self.window = limit, window
        self.fails: dict[str, list[float]] = {}
        self.lock = threading.Lock()

    def blocked(self, key: str) -> bool:
        with self.lock:
            now = time.time()
            hits = [t for t in self.fails.get(key, []) if now - t < self.window]
            self.fails[key] = hits
            return len(hits) >= self.limit

    def fail(self, key: str) -> None:
        with self.lock:
            self.fails.setdefault(key, []).append(time.time())

    def clear(self, key: str) -> None:
        with self.lock:
            self.fails.pop(key, None)


throttle = Throttle()
