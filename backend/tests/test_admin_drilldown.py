"""Automated unit and integration tests for Admin Dashboard drilldown, search, citizens management, and services detail."""

from datetime import datetime, timezone, timedelta
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


def test_admin_global_search(client):
    """Global search returns grouped results across applications, complaints, citizens, and services."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "admin"

    mock_apps = MagicMock()
    mock_apps.find.return_value.limit.return_value = [
        {"application_id": "MSP-APP-2026-TEST", "service_name": "Birth Certificate", "user_name": "John", "status": "Submitted"}
    ]
    mock_cmps = MagicMock()
    mock_cmps.find.return_value.limit.return_value = [
        {"complaint_id": "CMP-20261020-0001", "title": "Street Light Broken", "department": "Electrical", "status": "Submitted"}
    ]
    mock_users = MagicMock()
    mock_users.find.return_value.limit.return_value = [
        {"_id": ObjectId(), "full_name": "John Citizen", "email": "john@test.com", "mobile": "9999999999"}
    ]
    mock_services = MagicMock()
    mock_services.find.return_value.limit.return_value = [
        {"slug": "birth-certificate", "name": "Birth Certificate", "department": "Civil", "availability": "Available"}
    ]

    def col_side_effect(name):
        if name == "applications":
            return mock_apps
        if name == "complaints":
            return mock_cmps
        if name == "users":
            return mock_users
        if name == "services":
            return mock_services
        return MagicMock()

    with patch("backend.routes.admin_portal.get_collection", side_effect=col_side_effect):
        res = client.get("/api/admin/search?q=birth")
        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True
        assert len(data["data"]["applications"]) == 1
        assert len(data["data"]["complaints"]) == 1
        assert len(data["data"]["citizens"]) == 1
        assert len(data["data"]["services"]) == 1


def test_admin_service_detail_endpoint(client):
    """Detail endpoint returns statistics, checklist, form schema, and recent applications."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "admin"

    mock_service = {
        "slug": "birth-certificate",
        "name": "Birth Certificate",
        "category": "Civil Registration",
        "department": "Civil Registration",
        "description": "Issuance of birth certificates.",
        "availability": "Available",
        "is_active": True,
        "processing_days": 7,
        "fee": 50,
        "required_documents": ["Hospital Certificate"],
        "form_schema": []
    }
    mock_services = MagicMock()
    mock_services.find_one.return_value = mock_service

    mock_apps = MagicMock()
    mock_apps.count_documents.return_value = 10
    mock_apps.find.return_value.sort.return_value.limit.return_value = []

    def col_side_effect(name):
        if name == "services":
            return mock_services
        if name == "applications":
            return mock_apps
        return MagicMock()

    with patch("backend.routes.admin_portal.get_collection", side_effect=col_side_effect):
        res = client.get("/api/admin/services/birth-certificate")
        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True
        assert data["data"]["slug"] == "birth-certificate"
        assert data["data"]["statistics"]["total_applications"] == 10
        assert data["data"]["is_active"] is True


def test_admin_update_citizen_details(client):
    """Admin can update citizen name, phone, address, and email with validation."""
    citizen_oid = ObjectId()
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "admin"
        sess["csrf_token"] = "valid_csrf"

    mock_user = {
        "_id": citizen_oid,
        "role": "citizen",
        "full_name": "Old Name",
        "email": "citizen@test.com",
        "mobile": "9876543210",
        "address": "Old Address"
    }
    mock_users = MagicMock()
    mock_users.find_one.return_value = mock_user
    mock_users.update_one.return_value = MagicMock(acknowledged=True)

    with patch("backend.routes.admin_portal.get_collection", return_value=mock_users), \
         patch("backend.routes.admin_portal.log_audit") as mock_audit:

        res = client.put(
            f"/api/admin/citizens/{str(citizen_oid)}",
            json={"full_name": "New Valid Name", "mobile": "9998887776", "address": "New Ward 4 Address"},
            headers={"X-CSRF-Token": "valid_csrf"}
        )
        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True
        assert mock_users.update_one.called
        assert mock_audit.called


def test_admin_suspend_citizen_requires_reason(client):
    """Suspending a citizen account strictly requires a documented suspension reason."""
    citizen_oid = ObjectId()
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "admin"
        sess["csrf_token"] = "valid_csrf"

    mock_users = MagicMock()
    mock_users.find_one.return_value = {"_id": citizen_oid, "role": "citizen", "is_active": True}

    with patch("backend.routes.admin_portal.get_collection", return_value=mock_users):
        # Attempt to suspend without reason
        res = client.patch(
            f"/api/admin/citizens/{str(citizen_oid)}/status",
            json={"is_active": False, "reason": ""},
            headers={"X-CSRF-Token": "valid_csrf"}
        )
        assert res.status_code == 400
        data = res.get_json()
        assert data["error"]["code"] == "SUSPENSION_REASON_REQUIRED"

        # Attempt to suspend with valid reason
        mock_users.update_one.return_value = MagicMock(acknowledged=True)
        res_ok = client.patch(
            f"/api/admin/citizens/{str(citizen_oid)}/status",
            json={"is_active": False, "reason": "Repeated fraudulent claims detected in ward 5."},
            headers={"X-CSRF-Token": "valid_csrf"}
        )
        assert res_ok.status_code == 200
        data_ok = res_ok.get_json()
        assert data_ok["success"] is True
        assert data_ok["data"]["is_active"] is False


def test_admin_reset_citizen_password_secure_link(client):
    """Resetting citizen password dispatches a secure cryptographic token and never stores plaintext."""
    citizen_oid = ObjectId()
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "admin"
        sess["csrf_token"] = "valid_csrf"

    mock_user = {"_id": citizen_oid, "role": "citizen", "email": "dommeti@municipal.org"}
    mock_users = MagicMock()
    mock_users.find_one.return_value = mock_user

    mock_resets = MagicMock()
    mock_resets.insert_one.return_value = MagicMock(acknowledged=True)

    def col_side_effect(name):
        if name == "users":
            return mock_users
        if name == "password_resets":
            return mock_resets
        return MagicMock()

    with patch("backend.routes.admin_portal.get_collection", side_effect=col_side_effect), \
         patch("backend.routes.admin_portal.log_audit") as mock_audit:

        res = client.post(
            f"/api/admin/citizens/{str(citizen_oid)}/reset-password",
            json={},
            headers={"X-CSRF-Token": "valid_csrf"}
        )
        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True
        assert "reset_url" in data["data"]
        assert "token=" in data["data"]["reset_url"]
        assert mock_resets.insert_one.called
        assert mock_audit.called


def test_admin_delete_citizen_confirmation_and_active_app_guard(client):
    """Deleting citizen requires explicit confirmation and warns if active applications exist."""
    citizen_oid = ObjectId()
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "admin"
        sess["csrf_token"] = "valid_csrf"

    mock_user = {"_id": citizen_oid, "role": "citizen", "email": "dommeti@municipal.org"}
    mock_users = MagicMock()
    mock_users.find_one.return_value = mock_user

    mock_apps = MagicMock()
    mock_apps.count_documents.return_value = 2  # Has 2 active applications

    def col_side_effect(name):
        if name == "users":
            return mock_users
        if name == "applications":
            return mock_apps
        return MagicMock()

    with patch("backend.routes.admin_portal.get_collection", side_effect=col_side_effect):
        # 1. Missing confirmation
        res_no_conf = client.delete(
            f"/api/admin/citizens/{str(citizen_oid)}",
            json={"confirmation": "wrong_text"},
            headers={"X-CSRF-Token": "valid_csrf"}
        )
        assert res_no_conf.status_code == 400
        assert res_no_conf.get_json()["error"]["code"] == "CONFIRMATION_REQUIRED"

        # 2. Blocked because active applications exist
        res_blocked = client.delete(
            f"/api/admin/citizens/{str(citizen_oid)}",
            json={"confirmation": "DELETE"},
            headers={"X-CSRF-Token": "valid_csrf"}
        )
        assert res_blocked.status_code == 409
        assert res_blocked.get_json()["error"]["code"] == "ACTIVE_APPLICATIONS_EXIST"

        # 3. Successful soft delete with force override
        mock_users.update_one.return_value = MagicMock(acknowledged=True)
        res_ok = client.delete(
            f"/api/admin/citizens/{str(citizen_oid)}",
            json={"confirmation": "DELETE", "force": True},
            headers={"X-CSRF-Token": "valid_csrf"}
        )
        assert res_ok.status_code == 200
        assert res_ok.get_json()["success"] is True
        assert res_ok.get_json()["data"]["permanent"] is False


def test_admin_restore_citizen(client):
    """Soft-deleted citizen can be restored."""
    citizen_oid = ObjectId()
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "admin"
        sess["csrf_token"] = "valid_csrf"

    mock_user = {"_id": citizen_oid, "role": "citizen", "email": "dommeti@municipal.org", "is_deleted": True}
    mock_users = MagicMock()
    mock_users.find_one.return_value = mock_user
    mock_users.update_one.return_value = MagicMock(acknowledged=True)

    with patch("backend.routes.admin_portal.get_collection", return_value=mock_users), \
         patch("backend.routes.admin_portal.log_audit") as mock_audit:

        res = client.patch(
            f"/api/admin/citizens/{str(citizen_oid)}/restore",
            json={},
            headers={"X-CSRF-Token": "valid_csrf"}
        )
        assert res.status_code == 200
        assert res.get_json()["success"] is True
        assert mock_users.update_one.called


def test_admin_citizens_csv_export(client):
    """Admin can export registered citizens list to CSV."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "admin"

    mock_users = MagicMock()
    mock_users.find.return_value.sort.return_value = [
        {"_id": ObjectId(), "full_name": "Citizen One", "email": "c1@test.com", "mobile": "9876543210", "address": "Ward 1", "is_verified": True, "is_active": True, "created_at": datetime.now(timezone.utc)}
    ]
    mock_apps = MagicMock()
    mock_apps.count_documents.return_value = 0
    mock_cmps = MagicMock()
    mock_cmps.count_documents.return_value = 0

    def col_side_effect(name):
        if name == "users":
            return mock_users
        if name == "applications":
            return mock_apps
        if name == "complaints":
            return mock_cmps
        return MagicMock()

    with patch("backend.routes.admin_portal.get_collection", side_effect=col_side_effect):
        res = client.get("/api/admin/citizens/export")
        assert res.status_code == 200
        assert "text/csv" in res.content_type
        assert b"Citizen ID,Full Name,Email Address" in res.data
        assert b"c1@test.com" in res.data
