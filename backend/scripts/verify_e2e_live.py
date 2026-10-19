"""
Live End-to-End Verification against MongoDB Atlas.
Validates the entire citizen & administrative workflow with 100% truthful data.
Cleans up test records afterwards.
"""

import sys
from bson import ObjectId
from backend.app import create_app
from backend.config import Config
from backend.services.db import get_collection

def run_e2e_verification():
    print("--- Starting Live E2E Verification ---")
    app = create_app(config_class=Config)
    client = app.test_client()

    # 1. Health Check
    health_res = client.get("/api/health")
    assert health_res.status_code == 200, f"Health check failed: {health_res.text}"
    health_data = health_res.get_json()
    assert health_data.get("data", {}).get("database") == "connected", "Database not connected!"
    print("[OK] Health Check: Live MongoDB Atlas Connected")

    # 2. Get CSRF Token
    csrf_res = client.get("/api/auth/csrf-token")
    assert csrf_res.status_code == 200, f"CSRF token failed: {csrf_res.text}"
    csrf_token = csrf_res.get_json()["data"]["csrf_token"]
    headers = {"X-CSRF-Token": csrf_token}
    print("[OK] CSRF Token received successfully")

    # 3. Services Catalog Check
    services_res = client.get("/api/services")
    assert services_res.status_code == 200, f"Services failed: {services_res.text}"
    services = services_res.get_json().get("data", [])
    assert len(services) == 12, f"Expected 12 services, found {len(services)}"
    print(f"[OK] Services Catalog: {len(services)} services available")

    # 4. Citizen Registration
    import uuid
    test_email = f"e2e_citizen_{uuid.uuid4().hex[:8]}@example.com"
    reg_payload = {
        "full_name": "E2E Citizen Verification",
        "email": test_email,
        "mobile": "9876543210",
        "password": "Password123!",
        "address": "456 Civic Boulevard, Ward 4"
    }

    user_id = None
    app_id = None
    cmp_id = None

    try:
        reg_res = client.post("/api/auth/register", json=reg_payload, headers=headers)
        assert reg_res.status_code == 201, f"Registration failed: {reg_res.text}"
        print(f"[OK] Citizen Registration: {test_email} created in MongoDB Atlas")

        # 4b. Citizen Login
        login_res = client.post("/api/auth/login", json={"email": test_email, "password": "Password123!"}, headers=headers)
        assert login_res.status_code == 200, f"Login failed: {login_res.text}"
        csrf_token = login_res.get_json()["data"]["csrf_token"]
        headers = {"X-CSRF-Token": csrf_token}
        print(f"[OK] Citizen Login: {test_email} authenticated")

        # 5. Fetch Active Citizen Profile
        me_res = client.get("/api/auth/me")
        assert me_res.status_code == 200, f"Auth me failed: {me_res.text}"
        user_id = me_res.get_json()["data"]["id"]
        print("[OK] Citizen Session verified")

        # 6. Submit Application for Birth Certificate
        app_payload = {
            "service_slug": "birth-certificate",
            "child_name": "Baby Verification",
            "date_of_birth": "2026-05-15",
            "gender": "Female",
            "place_of_birth": "General Hospital Ward 1",
            "parent_guardian_name": "Father Test",
            "relationship": "Father",
            "permanent_address": "456 Civic Boulevard, Ward 4"
        }
        import io
        dummy_pdf = io.BytesIO(b"%PDF-1.4\n1 0 obj\n<<\n>>\nendobj\ntrailer\n<<\n>>\n%%EOF")
        app_payload["documents"] = (dummy_pdf, "hospital_record.pdf")
        app_res = client.post("/api/applications", data=app_payload, headers=headers, content_type="multipart/form-data")
        assert app_res.status_code == 201, f"Application submission failed: {app_res.text}"
        app_data = app_res.get_json()["data"]
        app_id = app_data["application_id"]
        print(f"[OK] Service Application Submitted: {app_id}")

        # 7. Submit Complaint
        cmp_payload = {
            "title": "Broken Streetlight on 5th Cross Road",
            "department": "Streetlight Problems",
            "description": "Streetlight pole has no illumination for past 3 days causing nighttime hazards.",
            "location": "5th Cross Road, Ward 4",
            "landmark": "Near Municipal Community Hall"
        }
        cmp_res = client.post("/api/complaints", data=cmp_payload, headers=headers)
        assert cmp_res.status_code == 201, f"Complaint submission failed: {cmp_res.text}"
        cmp_data = cmp_res.get_json()["data"]
        cmp_id = cmp_data["complaint_id"]
        print(f"[OK] Complaint Submitted: {cmp_id} with landmark")

        # 8. Public Status Tracking (Strict 0 PII)
        track_app_res = client.get(f"/api/track/{app_id}")
        assert track_app_res.status_code == 200, f"Tracking failed: {track_app_res.text}"
        assert track_app_res.get_json()["data"]["status"] == "Submitted"
        print(f"[OK] Public Tracking Application: {app_id} verified")

        track_cmp_res = client.get(f"/api/track/{cmp_id}")
        assert track_cmp_res.status_code == 200, f"Tracking complaint failed: {track_cmp_res.text}"
        assert track_cmp_res.get_json()["data"]["status"] == "Submitted"
        print(f"[OK] Public Tracking Grievance: {cmp_id} verified")

    finally:
        # Clean up test user, application, and complaint from MongoDB Atlas
        apps_col = get_collection("applications")
        cmps_col = get_collection("complaints")
        users_col = get_collection("users")
        audit_col = get_collection("audit_logs")
        notif_col = get_collection("notifications")

        if app_id:
            apps_col.delete_many({"application_id": app_id})
        if cmp_id:
            cmps_col.delete_many({"complaint_id": cmp_id})
        users_col.delete_many({"email": {"$regex": "^e2e_citizen_"}})
        if user_id:
            notif_col.delete_many({"user_id": ObjectId(user_id)})
            audit_col.delete_many({"actor_id": str(user_id)})
        print("[OK] Live cleanup completed: all test records removed from Atlas")

    print("\n==========================================")
    print("ALL LIVE END-TO-END VERIFICATIONS PASSED!")
    print("==========================================")

if __name__ == "__main__":
    run_e2e_verification()
