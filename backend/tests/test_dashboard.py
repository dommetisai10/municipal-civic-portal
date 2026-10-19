"""Automated unit and integration tests for citizen dashboard aggregations and notifications."""

from unittest.mock import MagicMock, patch
from bson import ObjectId
from datetime import datetime, timezone
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


def test_dashboard_unauthorized_access(client):
    """Unauthenticated access to citizen dashboard must return HTTP 401."""
    res = client.get("/api/dashboard/user")
    assert res.status_code == 401
    data = res.get_json()
    assert data["success"] is False
    assert data["error"]["code"] == "UNAUTHORIZED"


def test_dashboard_admin_access_forbidden(client):
    """Admins accessing citizen dashboard must be rejected with HTTP 403 Forbidden."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "admin"

    res = client.get("/api/dashboard/user")
    assert res.status_code == 403
    data = res.get_json()
    assert data["success"] is False
    assert data["error"]["code"] == "FORBIDDEN"


def test_dashboard_empty_db_returns_zeros_and_empty_lists(client):
    """With an empty database, every counter must be 0 and recent lists must be empty."""
    user_id = ObjectId()
    with client.session_transaction() as sess:
        sess["user_id"] = str(user_id)
        sess["role"] = "citizen"
        sess["email"] = "citizen@example.com"
        sess["full_name"] = "Citizen Clean"

    mock_apps = MagicMock()
    mock_apps.aggregate.return_value = []
    mock_apps_cursor = MagicMock()
    mock_apps_cursor.sort.return_value.limit.return_value = []
    mock_apps.find.return_value = mock_apps_cursor

    mock_cmps = MagicMock()
    mock_cmps.aggregate.return_value = []
    mock_cmps_cursor = MagicMock()
    mock_cmps_cursor.sort.return_value.limit.return_value = []
    mock_cmps.find.return_value = mock_cmps_cursor

    mock_notifs = MagicMock()
    mock_notifs.count_documents.return_value = 0

    def mock_get_collection(name):
        if name == "applications":
            return mock_apps
        elif name == "complaints":
            return mock_cmps
        elif name == "notifications":
            return mock_notifs
        return MagicMock()

    with patch("backend.routes.dashboard.get_collection", side_effect=mock_get_collection):
        res = client.get("/api/dashboard/user")
        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True

        stats = data["data"]["stats"]
        assert stats["applications"]["total"] == 0
        assert stats["applications"]["pending"] == 0
        assert stats["applications"]["approved"] == 0
        assert stats["applications"]["rejected"] == 0

        assert stats["complaints"]["total"] == 0
        assert stats["complaints"]["open"] == 0
        assert stats["complaints"]["resolved"] == 0

        assert stats["unread_notifications"] == 0
        assert data["data"]["recent_applications"] == []
        assert data["data"]["recent_complaints"] == []


def test_dashboard_live_aggregations_with_records(client):
    """Dashboard must compute accurate counts from live MongoDB aggregations."""
    user_id = ObjectId()
    with client.session_transaction() as sess:
        sess["user_id"] = str(user_id)
        sess["role"] = "citizen"

    mock_apps = MagicMock()
    mock_apps.aggregate.return_value = [
        {"_id": "Submitted", "count": 2},
        {"_id": "Under Review", "count": 1},
        {"_id": "Approved", "count": 3},
        {"_id": "Rejected", "count": 1}
    ]
    mock_apps_cursor = MagicMock()
    mock_apps_cursor.sort.return_value.limit.return_value = [
        {
            "_id": ObjectId(),
            "application_id": "MSP-APP-2026-11112222",
            "service_name": "Birth Certificate",
            "status": "Submitted",
            "created_at": datetime.now(timezone.utc)
        }
    ]
    mock_apps.find.return_value = mock_apps_cursor

    mock_cmps = MagicMock()
    mock_cmps.aggregate.return_value = [
        {"_id": "Submitted", "count": 2},
        {"_id": "Resolved", "count": 1}
    ]
    mock_cmps_cursor = MagicMock()
    mock_cmps_cursor.sort.return_value.limit.return_value = []
    mock_cmps.find.return_value = mock_cmps_cursor

    mock_notifs = MagicMock()
    mock_notifs.count_documents.return_value = 2

    def mock_get_collection(name):
        if name == "applications":
            return mock_apps
        elif name == "complaints":
            return mock_cmps
        elif name == "notifications":
            return mock_notifs
        return MagicMock()

    with patch("backend.routes.dashboard.get_collection", side_effect=mock_get_collection):
        res = client.get("/api/dashboard/user")
        assert res.status_code == 200
        data = res.get_json()
        stats = data["data"]["stats"]

        # Total apps: 2 + 1 + 3 + 1 = 7
        assert stats["applications"]["total"] == 7
        # Pending apps: Submitted (2) + Under Review (1) = 3
        assert stats["applications"]["pending"] == 3
        # Approved: 3
        assert stats["applications"]["approved"] == 3
        # Rejected: 1
        assert stats["applications"]["rejected"] == 1

        # Complaints: total = 3, open = 2, resolved = 1
        assert stats["complaints"]["total"] == 3
        assert stats["complaints"]["open"] == 2
        assert stats["complaints"]["resolved"] == 1

        assert stats["unread_notifications"] == 2
        assert len(data["data"]["recent_applications"]) == 1


def test_notifications_endpoints(client):
    """Test retrieving and marking notifications as read."""
    user_id = ObjectId()
    notif_id = ObjectId()
    with client.session_transaction() as sess:
        sess["user_id"] = str(user_id)
        sess["role"] = "citizen"
        sess["csrf_token"] = "valid_csrf_token"

    mock_notifs = MagicMock()
    mock_notifs.find.return_value.sort.return_value.limit.return_value = [
        {
            "_id": notif_id,
            "type": "APPLICATION_UPDATE",
            "message": "Your application was approved.",
            "related_id": "MSP-APP-2026-12345678",
            "is_read": False,
            "created_at": datetime.now(timezone.utc)
        }
    ]
    mock_notifs.update_one.return_value = MagicMock(acknowledged=True, matched_count=1)

    with patch("backend.routes.notifications.get_collection", return_value=mock_notifs):
        # 1. GET notifications
        res = client.get("/api/notifications")
        assert res.status_code == 200
        data = res.get_json()
        assert len(data["data"]) == 1
        assert data["data"][0]["message"] == "Your application was approved."

        # 2. PATCH mark read
        patch_res = client.patch(
            f"/api/notifications/{notif_id}/read",
            headers={"X-CSRF-Token": "valid_csrf_token"}
        )
        assert patch_res.status_code == 200
        assert patch_res.get_json()["success"] is True


def test_profile_update(client):
    """Citizen can update full_name, mobile, and address."""
    user_id = ObjectId()
    with client.session_transaction() as sess:
        sess["user_id"] = str(user_id)
        sess["role"] = "citizen"
        sess["csrf_token"] = "valid_csrf_token"

    mock_users = MagicMock()
    mock_users.update_one.return_value = MagicMock(acknowledged=True)
    mock_audit = MagicMock()
    mock_audit.insert_one.return_value = MagicMock(acknowledged=True)

    with patch("backend.routes.auth.get_collection", return_value=mock_users), \
         patch("backend.services.audit.get_collection", return_value=mock_audit):
        res = client.patch(
            "/api/auth/profile",
            headers={"X-CSRF-Token": "valid_csrf_token"},
            json={
                "full_name": "Citizen Updated",
                "mobile": "9123456780",
                "address": "999 Civic Avenue"
            }
        )
        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True
        assert "Profile updated" in data["data"]["message"]
