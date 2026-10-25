"""Idempotent Administrator Seed and Password Reset Script.

Creates or resets an administrator account with verified bcrypt hash,
'admin' role, active status, and audit trail.
Reads from environment variables (ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME)
or CLI arguments (--email, --password, --reset), with local development defaults.
"""

import os
import sys
import argparse
from pathlib import Path
from datetime import datetime, timezone

# Ensure project root is in sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import logging
from backend.services.db import get_collection, check_db_connection
from backend.services.audit import log_audit
from backend.utils.validators import validate_email, validate_password, sanitize_string
from backend.utils.security import hash_password

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("seed_admin")


def seed_admin(email=None, password=None, full_name=None, reset=False):
    """Idempotently creates or updates the administrator account."""
    target_email = (email or os.getenv("ADMIN_EMAIL", "admin@municipal.gov")).strip().lower()
    target_password = password or os.getenv("ADMIN_PASSWORD", "Admin@12345")
    target_name = (full_name or os.getenv("ADMIN_NAME", "Municipal Administrator")).strip()

    is_connected, msg = check_db_connection()
    if not is_connected:
        logger.error("Cannot seed administrator: Database unavailable: %s", msg)
        sys.exit(1)

    ok_email, norm_email = validate_email(target_email)
    if not ok_email:
        logger.error("Invalid admin email: %s", norm_email)
        sys.exit(1)

    ok_pwd, pwd_err = validate_password(target_password)
    if not ok_pwd:
        logger.error("Invalid admin password: %s", pwd_err)
        sys.exit(1)

    users_col = get_collection("users")
    now_utc = datetime.now(timezone.utc)
    pwd_hash = hash_password(target_password)

    existing = users_col.find_one({"email": norm_email})
    if existing:
        update_doc = {
            "role": "admin",
            "admin_role": "super_admin",
            "is_active": True,
            "failed_login_attempts": 0,
            "locked_until": None,
            "password_hash": pwd_hash,
            "updated_at": now_utc
        }
        users_col.update_one({"_id": existing["_id"]}, {"$set": update_doc})
        user_id_str = str(existing["_id"])
        action = "ADMIN_PASSWORD_RESET" if reset else "ADMIN_SYNC"
        logger.info("Admin account '%s' synchronized and password set.", norm_email)
    else:
        admin_doc = {
            "full_name": target_name,
            "email": norm_email,
            "mobile": "[HQ Direct]",
            "address": "Municipal Administrative Headquarters",
            "password_hash": pwd_hash,
            "role": "admin",
            "admin_role": "super_admin",
            "is_active": True,
            "failed_login_attempts": 0,
            "locked_until": None,
            "created_at": now_utc,
            "updated_at": now_utc,
            "last_login_at": None
        }
        result = users_col.insert_one(admin_doc)
        user_id_str = str(result.inserted_id)
        action = "ADMIN_SEED_CREATED"
        logger.info("New administrator account created for '%s'.", norm_email)

    try:
        log_audit(
            actor_id=user_id_str,
            actor_role="admin",
            action=action,
            target_collection="users",
            target_id=user_id_str,
            before_after_summary={"email": norm_email, "role": "admin"},
            ip="127.0.0.1"
        )
    except Exception:
        pass

    print("\n" + "=" * 65)
    print("   ADMINISTRATOR ACCOUNT READY")
    print("=" * 65)
    print(f" Login URL:     http://127.0.0.1:5000/admin-login.html")
    print(f" Email:         {norm_email}")
    print(f" Password:      {target_password}")
    print(f" Role:          admin")
    print("=" * 65 + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Seed or reset municipal administrator credentials.")
    parser.add_argument("--email", help="Administrator email address")
    parser.add_argument("--password", help="Administrator password")
    parser.add_argument("--name", help="Administrator full name")
    parser.add_argument("--reset", action="store_true", help="Force password reset on existing account")
    args = parser.parse_args()

    seed_admin(email=args.email, password=args.password, full_name=args.name, reset=args.reset)
