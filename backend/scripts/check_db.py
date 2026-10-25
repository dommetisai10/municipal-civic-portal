"""Database Diagnostic Script for Municipal Service Portal.

Tests MongoDB Atlas connection, latency, lists collections with row counts,
and verifies schema requirements with a PASS/FAIL checklist.
"""

import sys
import time
from pathlib import Path

# Ensure project root is in sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.config import Config
from backend.services.db import get_mongo_client, check_db_connection, sanitize_uri

def run_diagnostic():
    print("\n" + "=" * 70)
    print("   MUNICIPAL SERVICE PORTAL - DATABASE DIAGNOSTIC CHECK (PYTHON)")
    print("=" * 70)
    print(f"[i] Target Connection: {sanitize_uri(Config.MONGO_URI)}")
    print(f"[i] Target Database:   {Config.MONGO_DB_NAME}")

    checks = []

    # Check 1: Ping & Latency
    t0 = time.time()
    is_connected, msg = check_db_connection()
    latency_ms = round((time.time() - t0) * 1000, 2)

    if is_connected:
        checks.append({
            "name": "MongoDB Atlas Ping & Latency",
            "status": "PASS",
            "detail": f"{latency_ms} ms latency ({msg})"
        })
    else:
        checks.append({
            "name": "MongoDB Atlas Ping & Latency",
            "status": "FAIL",
            "detail": msg
        })
        print_results(checks)
        return False

    # Check 2: Collections Discovery & Counts
    try:
        client = get_mongo_client()
        db = client[Config.MONGO_DB_NAME]
        col_names = db.list_collection_names()

        checks.append({
            "name": "Collection Discovery",
            "status": "PASS" if len(col_names) > 0 else "WARN",
            "detail": f"Found {len(col_names)} collections"
        })

        print("\n   COLLECTION INVENTORY & DOCUMENT COUNTS:")
        print("   " + "-" * 50)
        for name in sorted(col_names):
            count = db[name].count_documents({})
            print(f"   * {name:<25} : {count} documents")
        print("   " + "-" * 50)

    except Exception as exc:
        checks.append({
            "name": "Collection Discovery",
            "status": "FAIL",
            "detail": str(exc)
        })

    # Check 3: Core Collections Verification
    required_cols = ["users", "services", "applications", "complaints"]
    try:
        missing = [c for c in required_cols if c not in col_names]
        if not missing:
            checks.append({
                "name": "Required Core Collections",
                "status": "PASS",
                "detail": "users, services, applications, complaints verified"
            })
        else:
            checks.append({
                "name": "Required Core Collections",
                "status": "WARN",
                "detail": f"Missing: {', '.join(missing)} (Run seed script to initialize)"
            })
    except Exception as exc:
        checks.append({
            "name": "Required Core Collections",
            "status": "FAIL",
            "detail": str(exc)
        })

    print_results(checks)
    return is_connected

def print_results(checks):
    print("\n" + "=" * 70)
    print("   DIAGNOSTIC SUMMARY REPORT")
    print("=" * 70)
    for c in checks:
        symbol = "✓" if c["status"] == "PASS" else ("⚠" if c["status"] == "WARN" else "✗")
        print(f" [{symbol}] {c['name']:<35} : [{c['status']}] {c['detail']}")
    print("=" * 70 + "\n")

if __name__ == "__main__":
    success = run_diagnostic()
    sys.exit(0 if success else 1)
