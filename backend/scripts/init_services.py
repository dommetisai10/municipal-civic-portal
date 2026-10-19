"""Services catalog database initialization script.

STRICT CLEAN DATA RULE:
This script only populates the static services catalog definitions from
services_catalog.json into the 'services' collection. Every service defaults to
'Unavailable'. It NEVER touches, seeds, or modifies citizen accounts, applications,
complaints, or notifications.
"""

import os
import sys
import json
import logging
from pathlib import Path

# Ensure project root is in sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.services.db import get_collection, check_db_connection

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("init_services")

CATALOG_PATH = PROJECT_ROOT / "backend" / "config" / "services_catalog.json"


def init_services():
    """Reads services catalog and upserts services in MongoDB."""
    is_connected, msg = check_db_connection()
    if not is_connected:
        logger.error("Cannot initialize services: %s", msg)
        logger.error("Please verify MongoDB is running and MONGO_URI in backend/.env is accessible.")
        sys.exit(1)

    if not CATALOG_PATH.exists():
        logger.error("Catalog configuration file not found at: %s", CATALOG_PATH)
        sys.exit(1)

    with open(CATALOG_PATH, "r", encoding="utf-8") as f:
        services_list = json.load(f)

    services_col = get_collection("services")
    logger.info("Found %d services defined in catalog. Initializing database...", len(services_list))

    loaded_count = 0
    for srv in services_list:
        slug = srv.get("slug")
        if not slug:
            logger.warning("Skipping invalid service entry without slug: %s", srv)
            continue

        doc = {
            "slug": slug,
            "name": srv.get("name"),
            "category": srv.get("category"),
            "description": srv.get("description"),
            "availability": srv.get("availability", "Unavailable"),
            "required_documents": srv.get("required_documents", []),
            "form_schema": srv.get("form_schema", [])
        }

        # Acknowledged upsert by unique slug
        res = services_col.update_one(
            {"slug": slug},
            {"$set": doc},
            upsert=True
        )
        if res.acknowledged:
            loaded_count += 1
            logger.info("  [✓] %-30s | Category: %-22s | Status: %s", doc["name"], doc["category"], doc["availability"])
        else:
            logger.error("Unacknowledged write for service '%s'", slug)

    logger.info("Services catalog initialization complete. Successfully synced %d services.", loaded_count)
    total_in_db = services_col.count_documents({})
    logger.info("Total services in database: %d (All default to 'Unavailable')", total_in_db)
    return True


if __name__ == "__main__":
    try:
        init_services()
    except Exception as exc:
        logger.error("Error during services initialization: %s", exc)
        sys.exit(1)
