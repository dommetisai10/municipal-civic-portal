"""CLI bootstrap script to create the first administrative account.

STRICT CLEAN DATA RULE:
Admin accounts are created ONLY through this interactive script via secure prompts (getpass).
No hardcoded admin credentials exist in code or .env files.
"""

import sys
import getpass
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
logger = logging.getLogger("create_admin")


def create_admin():
    """Prompts for administrator credentials and registers the first admin."""
    print("=================================================================")
    print(" MUNICIPAL SERVICE PORTAL - ADMINISTRATOR INITIALIZATION")
    print("=================================================================")

    # 1. Verify DB connection
    is_connected, msg = check_db_connection()
    if not is_connected:
        print(f"\n[ERROR] Database is unavailable: {msg}")
        print("Please ensure MongoDB is running and MONGO_URI in backend/.env is valid.\n")
        sys.exit(1)

    users_col = get_collection("users")

    # 2. Prompt Full Name
    while True:
        raw_name = input("Enter Administrator Full Name: ").strip()
        ok_name, name_val = sanitize_string(raw_name, field_name="Full Name", min_length=2, max_length=100)
        if ok_name:
            break
        print(f"  [!] {name_val}")

    # 3. Prompt Email
    while True:
        raw_email = input("Enter Administrator Email: ").strip()
        ok_email, email_val = validate_email(raw_email)
        if not ok_email:
            print(f"  [!] {email_val}")
            continue

        # Check if email is already registered
        existing = users_col.find_one({"email": email_val})
        if existing:
            print(f"  [!] An account with email '{email_val}' already exists. Please choose another email.")
            continue
        break

    # 4. Prompt Mobile Number (Optional for Admin)
    raw_mobile = input("Enter Administrator Mobile Number (or press Enter to skip): ").strip()
    mobile_val = raw_mobile if raw_mobile else "[Not Provided]"

    # 5. Prompt Password via getpass (masked input)
    while True:
        pwd = getpass.getpass("Enter Administrator Password (min 8 chars, 1 uppercase, 1 lowercase, 1 digit): ")
        ok_pwd, pwd_err = validate_password(pwd)
        if not ok_pwd:
            print(f"  [!] {pwd_err}")
            continue

        pwd_confirm = getpass.getpass("Confirm Administrator Password: ")
        if pwd != pwd_confirm:
            print("  [!] Passwords do not match. Please try again.")
            continue
        break

    # 6. Hash password and persist admin record
    pwd_hash = hash_password(pwd)
    now_utc = datetime.now(timezone.utc)

    admin_doc = {
        "full_name": name_val,
        "email": email_val,
        "mobile": mobile_val,
        "address": "Municipal Headquarters",
        "password_hash": pwd_hash,
        "role": "admin",
        "is_active": True,
        "failed_login_attempts": 0,
        "locked_until": None,
        "created_at": now_utc,
        "updated_at": now_utc,
        "last_login_at": None
    }

    result = users_col.insert_one(admin_doc)
    if not result.acknowledged:
        print("\n[ERROR] Database failed to acknowledge administrator creation.")
        sys.exit(1)

    admin_id_str = str(result.inserted_id)

    # 7. Audit log creation
    log_audit(
        actor_id=admin_id_str,
        actor_role="admin",
        action="ADMIN_CREATE",
        target_collection="users",
        target_id=admin_id_str,
        before_after_summary={"email": email_val, "role": "admin", "full_name": name_val},
        ip="127.0.0.1"
    )

    print("\n-----------------------------------------------------------------")
    print(f" SUCCESS: Administrator account created successfully!")
    print(f" User ID   : {admin_id_str}")
    print(f" Full Name : {name_val}")
    print(f" Email     : {email_val}")
    print(f" Role      : admin")
    print("-----------------------------------------------------------------")
    print("You can now authenticate via the Admin Portal at /admin-login.html.\n")


if __name__ == "__main__":
    try:
        create_admin()
    except KeyboardInterrupt:
        print("\n\nOperation cancelled by user.")
        sys.exit(0)
    except Exception as exc:
        print(f"\n[FATAL ERROR] {exc}")
        sys.exit(1)
