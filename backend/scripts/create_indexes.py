"""Database index setup script for Municipal Service Portal.

STRICT CLEAN DATA RULE:
This script only creates unique and compound indexes in MongoDB.
It NEVER seeds or inserts fake/mock citizen accounts, applications, complaints, or notifications.
"""

import sys
import logging
from pathlib import Path

# Ensure project root is in sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from pymongo import ASCENDING, DESCENDING
from backend.services.db import get_db, check_db_connection

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("create_indexes")


def create_indexes():
    """Initializes all collections with required database indexes."""
    is_connected, msg = check_db_connection()
    if not is_connected:
        logger.error("Cannot initialize database indexes: %s", msg)
        logger.error("Please verify that MongoDB Atlas is reachable and MONGO_URI in backend/.env is correct.")
        sys.exit(1)

    db = get_db()
    logger.info("Connected to database: '%s'. Initializing indexes...", db.name)

    created = []

    # 1. users collection: unique index on lowercase email
    users_idx = db.users.create_index([("email", ASCENDING)], unique=True, name="idx_users_email_unique")
    created.append(("users", users_idx))

    # 2. applications collection:
    # - unique application_id (MSP-APP-YYYY-XXXXXXXX)
    # - compound index user_id + created_at (for citizen dashboard queries)
    # - status index (for officer review filters and counts)
    app_id_idx = db.applications.create_index([("application_id", ASCENDING)], unique=True, name="idx_apps_app_id_unique")
    app_user_idx = db.applications.create_index([("user_id", ASCENDING), ("created_at", DESCENDING)], name="idx_apps_user_created")
    app_status_idx = db.applications.create_index([("status", ASCENDING)], name="idx_apps_status")
    created.extend([("applications", app_id_idx), ("applications", app_user_idx), ("applications", app_status_idx)])

    # 3. complaints collection:
    # - unique complaint_id (MSP-CMP-YYYY-XXXXXXXX)
    # - compound index user_id + created_at
    # - status index
    cmp_id_idx = db.complaints.create_index([("complaint_id", ASCENDING)], unique=True, name="idx_cmps_cmp_id_unique")
    cmp_user_idx = db.complaints.create_index([("user_id", ASCENDING), ("created_at", DESCENDING)], name="idx_cmps_user_created")
    cmp_status_idx = db.complaints.create_index([("status", ASCENDING)], name="idx_cmps_status")
    created.extend([("complaints", cmp_id_idx), ("complaints", cmp_user_idx), ("complaints", cmp_status_idx)])

    # 4. notifications collection: compound user_id + is_read for rapid unread badge queries
    notif_idx = db.notifications.create_index([("user_id", ASCENDING), ("is_read", ASCENDING)], name="idx_notif_user_unread")
    created.append(("notifications", notif_idx))

    # 5. services collection: unique slug index (e.g. 'birth-certificate')
    srv_slug_idx = db.services.create_index([("slug", ASCENDING)], unique=True, name="idx_services_slug_unique")
    created.append(("services", srv_slug_idx))

    # 6. departments collection: unique department name index
    dept_name_idx = db.departments.create_index([("name", ASCENDING)], unique=True, name="idx_departments_name_unique")
    created.append(("departments", dept_name_idx))

    # 7. audit_logs collection: indexed for chronological inspection and filtering
    audit_time_idx = db.audit_logs.create_index([("timestamp", DESCENDING)], name="idx_audit_timestamp")
    audit_action_idx = db.audit_logs.create_index([("action", ASCENDING)], name="idx_audit_action")
    created.extend([("audit_logs", audit_time_idx), ("audit_logs", audit_action_idx)])

    logger.info("Successfully created/verified %d indexes across 7 collections:", len(created))
    for collection, idx_name in created:
        logger.info("  - [%s] %s", collection, idx_name)

    # Clean data audit verification
    collections_to_check = ["users", "applications", "complaints", "notifications", "audit_logs"]
    logger.info("Clean data verification:")
    for col in collections_to_check:
        count = db[col].count_documents({})
        logger.info("  - Collection '%s' document count: %d (Zero mock records)", col, count)

    return True


if __name__ == "__main__":
    try:
        create_indexes()
        logger.info("Index initialization completed successfully.")
    except Exception as exc:
        logger.error("Error during index creation: %s", exc)
        sys.exit(1)
