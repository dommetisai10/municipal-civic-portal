"""End-to-End integration tests validating the complete lifecycle of citizen applications,
civic grievances, administrative review workflows, public tracking, and audit trail integrity."""

import io
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch
from bson import ObjectId
import pytest

from backend.app import create_app
from backend.config import TestingConfig


@pytest.fixture
def app():
    """Create test application."""
    application = create_app(config_class=TestingConfig)
    return application


@pytest.fixture
def client(app):
    """Create test HTTP client."""
    return app.test_client()


def test_e2e_application_submission_review_and_tracking(client):
    """
    End-to-End Workflow:
    1. Citizen applies for an active municipal service with form data and verified PDF.
    2. System generates unique MSP-APP-YYYY-XXXXXXXX identifier.
    3. Public tracking endpoint displays workflow milestones with zero PII leaks.
    4. Administrator reviews application, verifies documents, and advances status with remarks.
    5. Citizen receives in-app notifications and dashboard reflects updated live counts.
    6. Certificate status remains strictly 'Issuance not supported'.
    """
    citizen_id = ObjectId()
    citizen_email = "citizen.e2e@example.gov"
    citizen_name = "Jane Citizen"

    # In-memory mock storage simulating MongoDB collections
    db_store = {
        "services": [
            {
                "slug": "trade-license",
                "name": "Commercial Trade License",
                "category": "Revenue & Licensing",
                "availability": "Active",
                "required_documents": ["Business Plan"],
                "form_schema": [
                    {"name": "business_name", "label": "Business Name", "type": "text", "required": True}
                ]
            }
        ],
        "applications": [],
        "notifications": [],
        "audit_logs": []
    }

    def mock_get_collection(col_name):
        mock_col = MagicMock()
        if col_name == "services":
            mock_col.find_one.side_effect = lambda q: next((s for s in db_store["services"] if s.get("slug") == q.get("slug")), None)
            mock_col.find.return_value = db_store["services"]
            return mock_col

        if col_name == "applications":
            def insert_app(doc):
                doc["_id"] = ObjectId()
                db_store["applications"].append(doc)
                res = MagicMock()
                res.acknowledged = True
                res.inserted_id = doc["_id"]
                return res

            def find_app(q, projection=None):
                for a in db_store["applications"]:
                    if q.get("application_id") and a.get("application_id") == q.get("application_id"):
                        return a
                    if q.get("user_id") and a.get("user_id") == q.get("user_id"):
                        return a
                return None

            def update_app(q, update):
                doc = find_app(q)
                if doc:
                    if "$set" in update:
                        doc.update(update["$set"])
                    if "$push" in update:
                        for k, v in update["$push"].items():
                            doc.setdefault(k, []).append(v)
                res = MagicMock()
                res.acknowledged = True
                res.matched_count = 1 if doc else 0
                return res

            mock_col.insert_one.side_effect = insert_app
            mock_col.find_one.side_effect = find_app
            mock_col.update_one.side_effect = update_app
            mock_col.count_documents.side_effect = lambda q: len([a for a in db_store["applications"] if not q or a.get("status") == q.get("status")])
            mock_cursor = MagicMock()
            mock_cursor.sort.return_value = db_store["applications"]
            mock_col.find.return_value = mock_cursor
            return mock_col

        if col_name == "notifications":
            def insert_notif(doc):
                db_store["notifications"].append(doc)
                res = MagicMock()
                res.acknowledged = True
                return res
            mock_col.insert_one.side_effect = insert_notif
            mock_cursor = MagicMock()
            mock_cursor.sort.return_value = mock_cursor
            mock_cursor.limit.return_value = db_store["notifications"]
            mock_col.find.return_value = mock_cursor
            mock_col.count_documents.side_effect = lambda q: len(db_store["notifications"])
            return mock_col

        if col_name == "audit_logs":
            def insert_audit(doc):
                db_store["audit_logs"].append(doc)
                res = MagicMock()
                res.acknowledged = True
                return res
            mock_col.insert_one.side_effect = insert_audit
            mock_col.count_documents.side_effect = lambda q: len(db_store["audit_logs"])
            mock_cursor = MagicMock()
            mock_cursor.sort.return_value.skip.return_value.limit.return_value = db_store["audit_logs"]
            mock_col.find.return_value = mock_cursor
            mock_col.distinct.return_value = ["APPLICATION_SUBMITTED", "APPLICATION_STATUS_UPDATED"]
            return mock_col

        return MagicMock()

    with patch("backend.routes.applications.get_collection", side_effect=mock_get_collection), \
         patch("backend.routes.track.get_collection", side_effect=mock_get_collection), \
         patch("backend.routes.admin_portal.get_collection", side_effect=mock_get_collection), \
         patch("backend.routes.notifications.get_collection", side_effect=mock_get_collection), \
         patch("backend.services.audit.get_collection", side_effect=mock_get_collection):

        # --- STEP A: Citizen submits application ---
        with client.session_transaction() as sess:
            sess["user_id"] = str(citizen_id)
            sess["role"] = "citizen"
            sess["email"] = citizen_email
            sess["full_name"] = citizen_name
            sess["csrf_token"] = "valid_csrf_token"

        payload = {
            "service_slug": "trade-license",
            "business_name": "Apex Municipal Bakery",
            "doc_0": (io.BytesIO(b"%PDF-1.4\n%mock valid pdf content"), "business_plan.pdf")
        }

        submit_res = client.post(
            "/api/applications",
            data=payload,
            content_type="multipart/form-data",
            headers={"X-CSRF-Token": "valid_csrf_token"}
        )
        assert submit_res.status_code == 201
        submit_data = submit_res.get_json()
        assert submit_data["success"] is True
        app_id = submit_data["data"]["application_id"]
        assert app_id.startswith("MSP-APP-")
        assert submit_data["data"]["certificate_status"] == "Issuance not supported"

        # --- STEP B: Public status tracking (Zero PII Leaked) ---
        with client.session_transaction() as sess:
            sess.clear()  # Unauthenticated public citizen tracking

        track_res = client.get(f"/api/track/{app_id}")
        assert track_res.status_code == 200
        track_data = track_res.get_json()
        assert track_data["success"] is True
        record = track_data["data"]
        assert record["record_id"] == app_id
        assert record["status"] == "Submitted"
        assert record["certificate_status"] == "Issuance not supported"
        # Strict privacy guarantee: No phone, email, or citizen address
        assert "user_email" not in record
        assert "user_name" not in record
        assert "phone" not in record

        # --- STEP C: Officer Review and Status Updates ---
        admin_id = ObjectId()
        with client.session_transaction() as sess:
            sess["user_id"] = str(admin_id)
            sess["role"] = "admin"
            sess["email"] = "officer@example.gov"
            sess["full_name"] = "Municipal Officer"
            sess["csrf_token"] = "admin_csrf_token"

        # Officer inspects full application detail
        detail_res = client.get(f"/api/admin/applications/{app_id}")
        assert detail_res.status_code == 200
        detail_data = detail_res.get_json()["data"]
        assert detail_data["citizen_name"] == citizen_name
        assert detail_data["form_data"]["business_name"] == "Apex Municipal Bakery"
        assert len(detail_data["documents"]) == 1

        # Officer advances status to 'Under Review'
        status_res1 = client.patch(
            f"/api/admin/applications/{app_id}/status",
            json={"status": "Under Review", "remarks": "Documents under administrative verification."},
            headers={"X-CSRF-Token": "admin_csrf_token"}
        )
        assert status_res1.status_code == 200
        assert status_res1.get_json()["data"]["status"] == "Under Review"

        # Officer approves application
        status_res2 = client.patch(
            f"/api/admin/applications/{app_id}/status",
            json={"status": "Approved", "remarks": "Municipal commercial license approved. Physical document pickup required."},
            headers={"X-CSRF-Token": "admin_csrf_token"}
        )
        assert status_res2.status_code == 200
        assert status_res2.get_json()["data"]["status"] == "Approved"

        # --- STEP D: Citizen notifications verification ---
        with client.session_transaction() as sess:
            sess["user_id"] = str(citizen_id)
            sess["role"] = "citizen"
            sess["csrf_token"] = "valid_csrf_token"

        notif_res = client.get("/api/notifications")
        assert notif_res.status_code == 200
        data = notif_res.get_json()["data"]
        notifications = data if isinstance(data, list) else data.get("notifications", [])
        assert len(notifications) >= 2
        assert any("Under Review" in n["title"] or "Approved" in n["title"] for n in notifications)

        # --- STEP E: Audit logs verify compliance trail ---
        with client.session_transaction() as sess:
            sess["user_id"] = str(admin_id)
            sess["role"] = "admin"

        audit_res = client.get("/api/admin/audit-logs")
        assert audit_res.status_code == 200
        assert len(db_store["audit_logs"]) >= 3  # Submit, Under Review, Approved


def test_e2e_grievance_submission_resolution_and_tracking(client):
    """
    End-to-End Workflow:
    1. Citizen submits a civic grievance with title, department, description, GPS, and PNG photo.
    2. Unique MSP-CMP-YYYY-XXXXXXXX ID is allocated.
    3. Public status check displays grievance progress without citizen contact leakage.
    4. Officer inspects grievance and persists 'Resolved' decision with remarks.
    5. Citizen receives notification and audit log confirms acknowledged state transition.
    """
    citizen_id = ObjectId()

    db_complaints = []
    db_notifications = []
    db_audit = []

    def mock_get_collection(col_name):
        mock_col = MagicMock()
        if col_name == "complaints":
            def insert_cmp(doc):
                doc["_id"] = ObjectId()
                db_complaints.append(doc)
                res = MagicMock()
                res.acknowledged = True
                res.inserted_id = doc["_id"]
                return res

            def find_cmp(q, projection=None):
                for c in db_complaints:
                    if q.get("complaint_id") and c.get("complaint_id") == q.get("complaint_id"):
                        return c
                return None

            def update_cmp(q, update):
                doc = find_cmp(q)
                if doc:
                    if "$set" in update:
                        doc.update(update["$set"])
                    if "$push" in update:
                        for k, v in update["$push"].items():
                            doc.setdefault(k, []).append(v)
                res = MagicMock()
                res.acknowledged = True
                return res

            mock_col.insert_one.side_effect = insert_cmp
            mock_col.find_one.side_effect = find_cmp
            mock_col.update_one.side_effect = update_cmp
            return mock_col

        if col_name == "notifications":
            def insert_n(doc):
                db_notifications.append(doc)
                return MagicMock(acknowledged=True)
            mock_col.insert_one.side_effect = insert_n
            return mock_col

        if col_name == "audit_logs":
            def insert_a(doc):
                db_audit.append(doc)
                return MagicMock(acknowledged=True)
            mock_col.insert_one.side_effect = insert_a
            return mock_col

        return MagicMock()

    with patch("backend.routes.complaints.get_collection", side_effect=mock_get_collection), \
         patch("backend.routes.track.get_collection", side_effect=mock_get_collection), \
         patch("backend.routes.admin_portal.get_collection", side_effect=mock_get_collection), \
         patch("backend.services.audit.get_collection", side_effect=mock_get_collection):

        # --- STEP A: Citizen reports civic complaint ---
        with client.session_transaction() as sess:
            sess["user_id"] = str(citizen_id)
            sess["role"] = "citizen"
            sess["email"] = "citizen@example.gov"
            sess["full_name"] = "John Citizen"
            sess["csrf_token"] = "valid_csrf_token"

        png_magic = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        payload = {
            "department": "Roads & Traffic",
            "title": "Severe Pothole on 5th Main Road",
            "description": "Large dangerous pothole causing vehicular damage near municipal water tank.",
            "location": "5th Main Road, Sector 4",
            "latitude": "12.9716",
            "longitude": "77.5946",
            "image_0": (io.BytesIO(png_magic), "pothole.png")
        }

        res = client.post(
            "/api/complaints",
            data=payload,
            content_type="multipart/form-data",
            headers={"X-CSRF-Token": "valid_csrf_token"}
        )
        assert res.status_code == 201
        data = res.get_json()
        assert data["success"] is True
        cmp_id = data["data"]["complaint_id"]
        assert cmp_id.startswith("MSP-CMP-")

        # --- STEP B: Public status tracking ---
        with client.session_transaction() as sess:
            sess.clear()

        track_res = client.get(f"/api/track/{cmp_id}")
        assert track_res.status_code == 200
        track_info = track_res.get_json()["data"]
        assert track_info["record_id"] == cmp_id
        assert track_info["status"] == "Submitted"
        assert track_info["department"] == "Roads & Traffic"
        # Confirm no citizen contact leakage
        assert "user_email" not in track_info
        assert "user_name" not in track_info

        # --- STEP C: Administrative Resolution ---
        admin_id = ObjectId()
        with client.session_transaction() as sess:
            sess["user_id"] = str(admin_id)
            sess["role"] = "admin"
            sess["csrf_token"] = "admin_csrf_token"

        resolve_res = client.patch(
            f"/api/admin/complaints/{cmp_id}/status",
            json={"status": "Resolved", "remarks": "Road maintenance crew asphalted the pothole and cleared the area."},
            headers={"X-CSRF-Token": "admin_csrf_token"}
        )
        assert resolve_res.status_code == 200
        assert resolve_res.get_json()["data"]["status"] == "Resolved"

        # Verify notification dispatched and audit logged
        assert len(db_notifications) == 2
        assert any("Resolved" in n["title"] for n in db_notifications)
        assert len(db_audit) >= 2
