"""Cryptographic security utilities for password hashing, CSRF tokens, and signed auth tokens."""

import secrets
import bcrypt
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired


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


def generate_auth_token(user_id: str, role: str, secret_key: str, email: str = "", full_name: str = "", admin_role: str = "", department: str = "") -> str:
    """Generates a secure, cryptographically signed auth token (valid for 7 days)."""
    serializer = URLSafeTimedSerializer(secret_key)
    return serializer.dumps({
        "user_id": str(user_id),
        "role": str(role),
        "email": str(email),
        "full_name": str(full_name),
        "admin_role": str(admin_role),
        "department": str(department)
    })


def verify_auth_token(token: str, secret_key: str, max_age: int = 86400 * 7) -> dict:
    """Verifies a signed auth token and returns payload dict, or None if invalid or expired."""
    if not token or not secret_key:
        return None
    serializer = URLSafeTimedSerializer(secret_key)
    try:
        return serializer.loads(token, max_age=max_age)
    except (BadSignature, SignatureExpired, Exception):
        return None
