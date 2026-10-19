"""Cryptographic security utilities for password hashing and CSRF tokens."""

import secrets
import bcrypt


def hash_password(plain_password: str) -> str:
    """
    Hashes a plain text password using bcrypt with an adaptive salt (12 rounds).
    The password is never logged or exposed.
    """
    if not isinstance(plain_password, str):
        raise ValueError("Password must be a string.")

    password_bytes = plain_password.encode("utf-8")
    salt = bcrypt.gensalt(rounds=12)
    hashed_bytes = bcrypt.hashpw(password_bytes, salt)
    return hashed_bytes.decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """
    Verifies a plain text password against a stored bcrypt hash.
    Uses constant-time comparison internally in bcrypt to mitigate timing attacks.
    """
    if not plain_password or not hashed_password:
        return False

    try:
        password_bytes = plain_password.encode("utf-8")
        hash_bytes = hashed_password.encode("utf-8")
        return bcrypt.checkpw(password_bytes, hash_bytes)
    except Exception:
        return False


def generate_csrf_token() -> str:
    """Generates a cryptographically secure 64-character hex CSRF token."""
    return secrets.token_hex(32)
