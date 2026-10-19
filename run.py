"""Municipal Service Portal - Application Entry Point

Runs the unified Flask server hosting both the REST API backend and the
HTML5 / Vanilla CSS / Vanilla JS frontend.
"""

import sys
import logging
from pathlib import Path

# Ensure project root directory is in Python module search path
PROJECT_ROOT = Path(__file__).resolve().parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.config import Config
from backend.services.db import check_db_connection, get_db
from backend.app import create_app

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("civic_portal")

app = create_app()

if __name__ == "__main__":
    print("\n" + "=" * 70)
    print("   MUNICIPAL SERVICE PORTAL - FULL-STACK CIVIC PLATFORM")
    print("=" * 70)

    # Verify MongoDB connectivity
    is_connected, db_msg = check_db_connection()
    if is_connected:
        db = get_db()
        print(f" [+] MongoDB Atlas: CONNECTED (Database: '{db.name}')")
        services_count = db.services.count_documents({})
        users_count = db.users.count_documents({})
        print(f" [+] Active Services Catalog: {services_count} services")
        print(f" [+] Registered Users in DB:  {users_count} users")
    else:
        print(f" [!] MongoDB Warning: {db_msg}")

    base_url = f"http://{Config.HOST}:{Config.PORT}"
    print("-" * 70)
    print(" ACCESS DIRECT LINKS:")
    print(f"   * Portal Home:           {base_url}/")
    print(f"   * Services Catalog:      {base_url}/services.html")
    print(f"   * Submit Grievance:      {base_url}/submit-complaint.html")
    print(f"   * Track Reference Status:{base_url}/track-status.html")
    print(f"   * Citizen Sign In:       {base_url}/login.html")
    print(f"   * Citizen Registration:  {base_url}/register.html")
    print(f"   * Citizen Dashboard:     {base_url}/user-dashboard.html")
    print(f"   * Admin Dashboard:       {base_url}/admin-dashboard.html")
    print(f"   * Service Management:    {base_url}/service-management.html")
    print(f"   * Citizen Directory:     {base_url}/citizens.html")
    print(f"   * Reports & Analytics:   {base_url}/reports.html")
    print(f"   * Backend Health API:    {base_url}/api/health")
    print("=" * 70)
    print(f" Server starting on {base_url} (Press Ctrl+C to stop)...\n")

    app.run(host=Config.HOST, port=Config.PORT, debug=Config.DEBUG)
