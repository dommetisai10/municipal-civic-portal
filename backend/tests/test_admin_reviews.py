"""Automated unit and integration tests for administrative review workflows."""

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


def test_admin_applications_unauthorized(client):
    """Unauthenticated requests must be rejected with HTTP 401."""
    res = client.get("/api/admin/applications")
    assert res.status_code == 401
    data = res.get_json()
    assert data["success"] is False
    assert data["error"]["code"] == "UNAUTHORIZED"


def test_admin_applications_forbidden_for_citizen(client):
    """Citizen session accessing admin applications must be rejected with HTTP 403."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "citizen"

    res = client.get("/api/admin/applications")
    assert res.status_code == 403
    data = res.get_json()
    assert data["error"]["code"] == "FORBIDDEN"


def test_admin_list_applications_filtering(client):
    """Admin can list and filter citizen applications by status and service."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "admin"

    mock_doc = {
        "application_id": "MSP-APP-2026-REVW0001",
        "service_name": "Birth Certificate",
        "service_slug": "birth-certificate",
        "category": "Civil Registration",
        "user_name": "Alice Citizen",
        "user_email": "alice@example.com",
        "status": "Submitted",
        "certificate_status": "Issuance not supported",
        "documents": [{"stored_filename": "birth.pdf"}],
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc)
    }

    mock_cursor = MagicMock()
    mock_cursor.sort.return_value = [mock_doc]
    mock_apps_col = MagicMock()
    mock_apps_col.find.return_value = mock_cursor

    with patch("backend.routes.admin_portal.get_collection", return_value=mock_apps_col):
        res = client.get("/api/admin/applications?status=Submitted&service=birth-certificate")
        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True
        assert len(data["data"]) == 1
        assert data["data"][0]["application_id"] == "MSP-APP-2026-REVW0001"
        assert data["data"][0]["citizen_name"] == "Alice Citizen"


def test_admin_get_application_detail(client):
    """Admin can inspect full application particulars and document download links."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "admin"

    app_id = "MSP-APP-2026-DETL0001"
    mock_doc = {
        "application_id": app_id,
        "service_name": "Property Tax",
        "service_slug": "property-tax",
        "category": "Revenue & Taxation",
        "user_name": "Bob Resident",
        "user_email": "bob@example.com",
        "status": "Under Review",
        "certificate_status": "Issuance not supported",
        "form_data": {"property_id": "PID-999"},
        "documents": [
            {
                "original_filename": "deed.pdf",
                "stored_filename": "uuid-deed.pdf",
                "extension": "pdf",
                "mime_type": "application/pdf",
                "file_size": 204800,
                "uploaded_at": "2026-10-15T10:00:00Z"
            }
        ],
        "status_history": [],
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc)
    }

    mock_apps_col = MagicMock()
    mock_apps_col.find_one.return_value = mock_doc

    with patch("backend.routes.admin_portal.get_collection", return_value=mock_apps_col):
        res = client.get(f"/api/admin/applications/{app_id}")
        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True
        assert data["data"]["application_id"] == app_id
        assert data["data"]["form_data"]["property_id"] == "PID-999"
        assert len(data["data"]["documents"]) == 1
        assert "/api/applications/" in data["data"]["documents"][0]["download_url"]


def test_admin_update_application_status_success(client):
    """Admin status update appends history, notifies citizen, and writes audit log."""
    citizen_id = ObjectId()
    admin_id = ObjectId()

    with client.session_transaction() as sess:
        sess["user_id"] = str(admin_id)
        sess["role"] = "admin"
        sess["csrf_token"] = "valid_csrf_token"

    app_id = "MSP-APP-2026-STAT0001"
    mock_doc = {
        "_id": ObjectId(),
        "application_id": app_id,
        "user_id": citizen_id,
        "service_name": "Birth Certificate",
        "status": "Submitted"
    }

    mock_apps_col = MagicMock()
    mock_apps_col.find_one.return_value = mock_doc
    mock_apps_col.update_one.return_value = MagicMock(acknowledged=True)

    mock_notif_col = MagicMock()
    mock_notif_col.insert_one.return_value = MagicMock(acknowledged=True)

    def col_side_effect(name):
        if name == "applications":
            return mock_apps_col
        if name == "notifications":
            return mock_notif_col
        return MagicMock()

    with patch("backend.routes.admin_portal.get_collection", side_effect=col_side_effect), \
         patch("backend.routes.admin_portal.log_audit") as mock_audit:

        res = client.patch(
            f"/api/admin/applications/{app_id}/status",
            json={
                "status": "Approved",
                "remarks": "Documents verified against hospital discharge record. Physical certificate available at ward office."
            },
            headers={"X-CSRF-Token": "valid_csrf_token"}
        )

        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True
        assert data["data"]["status"] == "Approved"

        # Verify acknowledged DB update
        assert mock_apps_col.update_one.called

        # Verify citizen notification dispatched
        assert mock_notif_col.insert_one.called
        notif_doc = mock_notif_col.insert_one.call_args[0][0]
        assert notif_doc["user_id"] == citizen_id
        assert "Approved" in notif_doc["title"]

        # Verify audit log
        assert mock_audit.called
        assert mock_audit.call_args[1]["action"] == "APPLICATION_STATUS_UPDATED"


def test_admin_update_application_status_validation(client):
    """Status updates without substantive remarks or invalid status must return HTTP 400."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "admin"
        sess["csrf_token"] = "valid_csrf_token"

    app_id = "MSP-APP-2026-VALD0001"

    # 1. Invalid status value
    res1 = client.patch(
        f"/api/admin/applications/{app_id}/status",
        json={"status": "ArbitraryState", "remarks": "Valid remarks string"},
        headers={"X-CSRF-Token": "valid_csrf_token"}
    )
    assert res1.status_code == 400
    assert res1.get_json()["error"]["code"] == "INVALID_STATUS"

    # 2. Missing remarks
    res2 = client.patch(
        f"/api/admin/applications/{app_id}/status",
        json={"status": "Approved", "remarks": ""},
        headers={"X-CSRF-Token": "valid_csrf_token"}
    )
    assert res2.status_code == 400
    assert res2.get_json()["error"]["code"] == "REMARKS_REQUIRED"


def test_admin_list_complaints_filtering(client):
    """Admin can list and filter grievances by department and status."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "admin"

    mock_doc = {
        "complaint_id": "MSP-CMP-2026-FLTR0001",
        "department": "Sanitation & Waste Management",
        "title": "Overflowing Dustbin",
        "user_name": "Charlie Resident",
        "location": "Ward 8, Market Square",
        "status": "Submitted",
        "images": [],
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc)
    }

    mock_cursor = MagicMock()
    mock_cursor.sort.return_value = [mock_doc]
    mock_cmps_col = MagicMock()
    mock_cmps_col.find.return_value = mock_cursor

    with patch("backend.routes.admin_portal.get_collection", return_value=mock_cmps_col):
        res = client.get("/api/admin/complaints?department=Sanitation+%26+Waste+Management&status=Submitted")
        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True
        assert len(data["data"]) == 1
        assert data["data"][0]["complaint_id"] == "MSP-CMP-2026-FLTR0001"


def test_admin_update_complaint_status_success(client):
    """Admin resolution of grievance notifies citizen and logs audit event."""
    citizen_id = ObjectId()
    admin_id = ObjectId()

    with client.session_transaction() as sess:
        sess["user_id"] = str(admin_id)
        sess["role"] = "admin"
        sess["csrf_token"] = "valid_csrf_token"

    cmp_id = "MSP-CMP-2026-RESL0001"
    mock_doc = {
        "_id": ObjectId(),
        "complaint_id": cmp_id,
        "user_id": citizen_id,
        "department": "Streetlighting & Electrical",
        "title": "Broken Streetlight",
        "status": "Under Review"
    }

    mock_cmps_col = MagicMock()
    mock_cmps_col.find_one.return_value = mock_doc
    mock_cmps_col.update_one.return_value = MagicMock(acknowledged=True)

    mock_notif_col = MagicMock()
    mock_notif_col.insert_one.return_value = MagicMock(acknowledged=True)

    def col_side_effect(name):
        if name == "complaints":
            return mock_cmps_col
        if name == "notifications":
            return mock_notif_col
        return MagicMock()

    with patch("backend.routes.admin_portal.get_collection", side_effect=col_side_effect), \
         patch("backend.routes.admin_portal.log_audit") as mock_audit:

        res = client.patch(
            f"/api/admin/complaints/{cmp_id}/status",
            json={
                "status": "Resolved",
                "remarks": "Field electrical team replaced faulty LED bulb and wiring on Pole #14. Streetlight is now operational."
            },
            headers={"X-CSRF-Token": "valid_csrf_token"}
        )

        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True
        assert data["data"]["status"] == "Resolved"

        # Verify DB update
        assert mock_cmps_col.update_one.called

        # Verify notification
        assert mock_notif_col.insert_one.called
        notif = mock_notif_col.insert_one.call_args[0][0]
        assert notif["user_id"] == citizen_id
        assert "Resolved" in notif["title"]

        # Verify audit log
        assert mock_audit.called
        assert mock_audit.call_args[1]["action"] == "COMPLAINT_STATUS_UPDATED"
