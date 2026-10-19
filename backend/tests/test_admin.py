"""Automated unit and integration tests for administrator portal and services management."""

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch
from bson import ObjectId
import pytest

from backend.app import create_app
from backend.config import TestingConfig
from backend.utils.security import hash_password


@pytest.fixture
def app():
    """Create test application."""
    application = create_app(config_class=TestingConfig)
    return application


@pytest.fixture
def client(app):
    """Create test HTTP client."""
    return app.test_client()


def test_admin_dashboard_unauthorized(client):
    """Unauthenticated requests to admin dashboard must receive HTTP 401."""
    res = client.get("/api/admin/dashboard")
    assert res.status_code == 401
    data = res.get_json()
    assert data["success"] is False
    assert data["error"]["code"] == "UNAUTHORIZED"


def test_admin_dashboard_forbidden_for_citizen(client):
    """Citizens attempting to access the admin dashboard must receive HTTP 403."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "citizen"

    res = client.get("/api/admin/dashboard")
    assert res.status_code == 403
    data = res.get_json()
    assert data["success"] is False
    assert data["error"]["code"] == "FORBIDDEN"


def test_admin_dashboard_empty_db_returns_zeros(client):
    """Empty database returns all zeroes and empty lists without mock placeholders."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "admin"

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

    mock_users = MagicMock()
    mock_users.count_documents.return_value = 0

    mock_services = MagicMock()
    mock_services.count_documents.return_value = 0

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
        res = client.get("/api/admin/dashboard")
        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True

        metrics = data["data"]["metrics"]
        assert metrics["applications"]["total"] == 0
        assert metrics["applications"]["Submitted"] == 0
        assert metrics["complaints"]["total"] == 0
        assert metrics["citizens_count"] == 0
        assert metrics["services_count"] == 0
        assert data["data"]["recent_applications"] == []
        assert data["data"]["recent_complaints"] == []


def test_admin_dashboard_live_aggregations_with_records(client):
    """Admin dashboard aggregates live status counts across applications and complaints."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "admin"

    mock_apps = MagicMock()
    mock_apps.aggregate.return_value = [
        {"_id": "Submitted", "count": 4},
        {"_id": "Under Review", "count": 2},
        {"_id": "Approved", "count": 1}
    ]
    mock_apps_cursor = MagicMock()
    mock_apps_cursor.sort.return_value.limit.return_value = [
        {
            "application_id": "MSP-APP-2026-TEST0001",
            "service_name": "Birth Certificate",
            "category": "Civil Registration",
            "user_name": "John Citizen",
            "status": "Submitted",
            "created_at": datetime.now(timezone.utc)
        }
    ]
    mock_apps.find.return_value = mock_apps_cursor

    mock_cmps = MagicMock()
    mock_cmps.aggregate.return_value = [
        {"_id": "Submitted", "count": 3},
        {"_id": "Resolved", "count": 5}
    ]
    mock_cmps_cursor = MagicMock()
    mock_cmps_cursor.sort.return_value.limit.return_value = []
    mock_cmps.find.return_value = mock_cmps_cursor

    mock_users = MagicMock()
    mock_users.count_documents.return_value = 15

    mock_services = MagicMock()
    mock_services.count_documents.return_value = 12

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
        res = client.get("/api/admin/dashboard")
        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True

        metrics = data["data"]["metrics"]
        assert metrics["applications"]["total"] == 7
        assert metrics["applications"]["Submitted"] == 4
        assert metrics["applications"]["Under Review"] == 2
        assert metrics["complaints"]["total"] == 8
        assert metrics["citizens_count"] == 15
        assert metrics["services_count"] == 12
        assert len(data["data"]["recent_applications"]) == 1


def test_admin_services_catalog_listing(client):
    """Admin can view all services with associated application count."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "admin"

    mock_services = MagicMock()
    mock_services.find.return_value.sort.return_value = [
        {
            "slug": "birth-certificate",
            "name": "Birth Certificate",
            "category": "Civil Registration",
            "description": "Issuance of birth certificates.",
            "availability": "Unavailable",
            "required_documents": ["Birth Report"],
            "form_schema": []
        }
    ]

    mock_apps = MagicMock()
    mock_apps.aggregate.return_value = [
        {"_id": "birth-certificate", "count": 5}
    ]

    def col_side_effect(name):
        if name == "services":
            return mock_services
        if name == "applications":
            return mock_apps
        return MagicMock()

    with patch("backend.routes.admin_portal.get_collection", side_effect=col_side_effect):
        res = client.get("/api/admin/services")
        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True
        assert len(data["data"]) == 1
        assert data["data"][0]["slug"] == "birth-certificate"
        assert data["data"][0]["applications_count"] == 5


def test_admin_toggle_service_availability(client):
    """Admin can toggle service availability between 'Active' and 'Unavailable'."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "admin"
        sess["csrf_token"] = "valid_csrf_token"

    mock_service_doc = {
        "_id": ObjectId(),
        "slug": "birth-certificate",
        "name": "Birth Certificate",
        "availability": "Unavailable"
    }

    mock_services = MagicMock()
    mock_services.find_one.return_value = mock_service_doc
    mock_services.update_one.return_value = MagicMock(acknowledged=True)

    with patch("backend.routes.admin_portal.get_collection", return_value=mock_services), \
         patch("backend.routes.admin_portal.log_audit") as mock_audit:

        # Toggle to Active
        res = client.patch(
            "/api/admin/services/birth-certificate/availability",
            json={"availability": "Active"},
            headers={"X-CSRF-Token": "valid_csrf_token"}
        )
        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True
        assert data["data"]["availability"] == "Active"

        # Verify acknowledged write
        assert mock_services.update_one.called
        assert mock_audit.called
        assert mock_audit.call_args[1]["action"] == "SERVICE_AVAILABILITY_UPDATED"


def test_admin_toggle_service_invalid_value(client):
    """Passing an invalid availability status must return HTTP 400."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "admin"
        sess["csrf_token"] = "valid_csrf_token"

    res = client.patch(
        "/api/admin/services/birth-certificate/availability",
        json={"availability": "PendingReview"},  # Invalid availability
        headers={"X-CSRF-Token": "valid_csrf_token"}
    )
    assert res.status_code == 400
    data = res.get_json()
    assert data["error"]["code"] == "INVALID_AVAILABILITY"
