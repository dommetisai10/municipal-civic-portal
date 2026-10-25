"""Safe Cleanup Script for Demo/Test Data in Municipal Service Portal.

Selectively purges demo citizens, test applications, test complaints, and test notifications
while strictly preserving:
- All real administrator accounts (e.g. admin@municipal.gov, admin@municipal.gov.in)
- All real citizen accounts (e.g. dommetisai*@gmail.com)
- The entire 12-item official municipal services catalog

Supports:
- --dry-run (default mode: inspects and counts without making changes)
- --confirm / --force (executes deletion with summary audit)
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

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("cleanup_demo_data")

PROTECTED_EMAILS = {
    "admin@municipal.gov",
    "admin@municipal.gov.in",
    "dommetisai997@gmail.com",
    "dommetisai998@gmail.com",
}

TEST_EMAIL_PATTERNS = [
    r"@test\.local$",
    r"@testdomain\.gov$",
    r"^citizen_phase",
    r"^final_verifier_",
    r"^session_test",
    r"^demo_",
    r"^test_"
]

OFFICIAL_SERVICES = {
    "birth-certificate",
    "death-certificate",
    "marriage-registration",
    "property-tax",
    "trade-license",
    "water-connection",
    "building-permission",
    "sanitation-service",
    "streetlight-repair",
    "drainage-service",
    "waste-collection",
    "other-civic-service"
}


def run_cleanup(dry_run=True, confirmed=False):
    """Safely audits or purges demo records from the database."""
    is_connected, msg = check_db_connection()
    if not is_connected:
        logger.error("Database connection unavailable: %s", msg)
        sys.exit(1)

    users_col = get_collection("users")
    apps_col = get_collection("applications")
    cmps_col = get_collection("complaints")
    services_col = get_collection("services")
    notifications_col = get_collection("notifications")

    # 1. Identify Demo Users
    test_user_query = {
        "email": {
            "$nin": list(PROTECTED_EMAILS),
            "$regex": r"(@test\.local|@testdomain\.gov|^citizen_phase|^final_verifier_|^session_test|^demo_|^test_)",
            "$options": "i"
        }
    }
    demo_users = list(users_col.find(test_user_query))
    demo_user_emails = [u.get("email") for u in demo_users]
    demo_user_ids = [str(u.get("_id")) for u in demo_users]

    # 2. Identify Demo Applications
    app_query = {
        "$or": [
            {"user_email": {"$in": demo_user_emails}},
            {"user_id": {"$in": demo_user_ids}},
            {"is_demo": True}
        ]
    }
    demo_apps = list(apps_col.find(app_query))

    # 3. Identify Demo Complaints
    cmp_query = {
        "$or": [
            {"user_email": {"$in": demo_user_emails}},
            {"user_id": {"$in": demo_user_ids}},
            {"is_demo": True}
        ]
    }
    demo_complaints = list(cmps_col.find(cmp_query))

    # 4. Identify Demo Notifications
    notif_query = {
        "$or": [
            {"user_id": {"$in": demo_user_ids}},
            {"user_email": {"$in": demo_user_emails}}
        ]
    }
    demo_notifications = list(notifications_col.find(notif_query))

    # 5. Identify Demo Services (if any created outside official catalog)
    demo_services = list(services_col.find({
        "slug": {"$nin": list(OFFICIAL_SERVICES)},
        "is_official": {"$ne": True}
    }))

    print("\n" + "=" * 65)
    print("   MUNICIPAL PORTAL - DEMO DATA AUDIT REPORT")
    print("=" * 65)
    print(f" Mode: {'DRY RUN (NO CHANGES WILL BE MADE)' if dry_run else 'LIVE PURGE EXECUTION'}")
    print(f" Demo Citizens Identified:       {len(demo_users)}")
    for u in demo_users:
        print(f"   - {u.get('email')} ({u.get('full_name')})")
    print(f" Demo Applications Identified:   {len(demo_apps)}")
    for a in demo_apps:
        print(f"   - {a.get('application_id')} ({a.get('service_name')} - {a.get('user_email')})")
    print(f" Demo Complaints Identified:     {len(demo_complaints)}")
    for c in demo_complaints:
        print(f"   - {c.get('complaint_id')} ({c.get('category')} - {c.get('user_email')})")
    print(f" Demo Notifications Identified:  {len(demo_notifications)}")
    print(f" Demo Services Identified:       {len(demo_services)}")
    for s in demo_services:
        print(f"   - {s.get('slug')} ({s.get('name')})")

    print("\n Protected Entities (WILL NOT BE TOUCHED):")
    real_admins = list(users_col.find({"email": {"$in": ["admin@municipal.gov", "admin@municipal.gov.in"]}}))
    for adm in real_admins:
        print(f"   [ADMIN PRESERVED]   {adm.get('email')} ({adm.get('full_name')})")
    real_citizens = list(users_col.find({"email": {"$in": ["dommetisai997@gmail.com", "dommetisai998@gmail.com"]}}))
    for cit in real_citizens:
        print(f"   [CITIZEN PRESERVED] {cit.get('email')} ({cit.get('full_name')})")
    official_services_count = services_col.count_documents({"slug": {"$in": list(OFFICIAL_SERVICES)}})
    print(f"   [SERVICES PRESERVED] {official_services_count} official services in catalog")
    print("=" * 65 + "\n")

    if dry_run:
        print("To safely execute this cleanup, run:")
        print("   python backend/scripts/cleanup_demo_data.py --confirm")
        return

    if not confirmed:
        response = input("Are you SURE you want to permanently delete the demo records listed above? [y/N]: ")
        if response.strip().lower() not in ["y", "yes"]:
            print("Cleanup cancelled. No changes were made.")
            return

    # Execute Deletions
    del_apps = apps_col.delete_many(app_query).deleted_count if demo_apps else 0
    del_cmps = cmps_col.delete_many(cmp_query).deleted_count if demo_complaints else 0
    del_notifs = notifications_col.delete_many(notif_query).deleted_count if demo_notifications else 0
    del_users = users_col.delete_many(test_user_query).deleted_count if demo_users else 0
    del_services = services_col.delete_many({
        "slug": {"$nin": list(OFFICIAL_SERVICES)},
        "is_official": {"$ne": True}
    }).deleted_count if demo_services else 0

    try:
        log_audit(
            actor_id="system-cleanup",
            actor_role="admin",
            action="CLEANUP_DEMO_DATA",
            target_collection="system",
            target_id="cleanup-all",
            before_after_summary={
                "deleted_users": del_users,
                "deleted_applications": del_apps,
                "deleted_complaints": del_cmps,
                "deleted_notifications": del_notifs,
                "deleted_services": del_services
            },
            ip="127.0.0.1"
        )
    except Exception:
        pass

    print("\n" + "=" * 65)
    print("   DEMO DATA CLEANUP COMPLETED SUCCESSFULLY")
    print("=" * 65)
    print(f" Removed Users:         {del_users}")
    print(f" Removed Applications:  {del_apps}")
    print(f" Removed Complaints:    {del_cmps}")
    print(f" Removed Notifications: {del_notifs}")
    print(f" Removed Services:      {del_services}")
    print("=" * 65 + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Clean up demo and test records safely from the database.")
    parser.add_argument("--dry-run", action="store_true", help="Perform inspection without deleting any records (default)")
    parser.add_argument("--confirm", "--force", dest="confirm", action="store_true", help="Execute deletion without interactive confirmation")
    args = parser.parse_args()

    # If --confirm is passed, dry_run is False
    is_dry_run = not args.confirm and (args.dry_run or not sys.stdin.isatty())
    if args.confirm:
        is_dry_run = False

    run_cleanup(dry_run=is_dry_run, confirmed=args.confirm)
