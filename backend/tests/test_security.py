"""Automated tests for security hardening, audit log compliance, and edge cases."""

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


def test_audit_logs_unauthorized(client):
    """Unauthenticated requests to audit logs must return HTTP 401."""
    res = client.get("/api/admin/audit-logs")
    assert res.status_code == 401
    data = res.get_json()
    assert data["success"] is False
    assert data["error"]["code"] == "UNAUTHORIZED"


def test_audit_logs_forbidden_for_citizen(client):
    """Citizens attempting to view audit logs must receive HTTP 403."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "citizen"

    res = client.get("/api/admin/audit-logs")
    assert res.status_code == 403
    data = res.get_json()
    assert data["success"] is False
    assert data["error"]["code"] == "FORBIDDEN"


def test_audit_logs_listing_and_pagination(client):
    """Admins can list audit records with proper pagination metadata."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "admin"

    log_1 = {
        "_id": ObjectId(),
        "actor_id": "admin_123",
        "actor_role": "admin",
        "action": "APPLICATION_STATUS_UPDATED",
        "target_collection": "applications",
        "target_id": "MSP-APP-2026-ABC12345",
        "before_after_summary": {"before_status": "Submitted", "after_status": "Under Review"},
        "ip": "127.0.0.1",
        "created_at": datetime.now(timezone.utc)
    }
    log_2 = {
        "_id": ObjectId(),
        "actor_id": "admin_123",
        "actor_role": "admin",
        "action": "SERVICE_AVAILABILITY_UPDATED",
        "target_collection": "services",
        "target_id": "trade-license",
        "before_after_summary": {"before": "Unavailable", "after": "Active"},
        "ip": "127.0.0.1",
        "created_at": datetime.now(timezone.utc)
    }

    mock_col = MagicMock()
    mock_col.count_documents.return_value = 25
    mock_cursor = MagicMock()
    mock_cursor.sort.return_value.skip.return_value.limit.return_value = [log_1, log_2]
    mock_col.find.return_value = mock_cursor
    mock_col.distinct.side_effect = lambda field: ["APPLICATION_STATUS_UPDATED", "SERVICE_AVAILABILITY_UPDATED"] if field == "action" else ["applications", "services"]

    with patch("backend.routes.admin_portal.get_collection", return_value=mock_col):
        res = client.get("/api/admin/audit-logs?page=2&limit=2")
        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True

        payload = data["data"]
        assert len(payload["logs"]) == 2
        assert payload["pagination"]["page"] == 2
        assert payload["pagination"]["limit"] == 2
        assert payload["pagination"]["total_records"] == 25
        assert payload["pagination"]["total_pages"] == 13
        assert "APPLICATION_STATUS_UPDATED" in payload["filter_options"]["actions"]


def test_audit_logs_query_filters(client):
    """Audit logs can be filtered by action, role, target_collection, date range, and keyword search."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "admin"

    mock_col = MagicMock()
    mock_col.count_documents.return_value = 1
    mock_cursor = MagicMock()
    mock_cursor.sort.return_value.skip.return_value.limit.return_value = []
    mock_col.find.return_value = mock_cursor
    mock_col.distinct.return_value = []

    with patch("backend.routes.admin_portal.get_collection", return_value=mock_col):
        res = client.get(
            "/api/admin/audit-logs?action=USER_LOGIN&actor_role=citizen&target_collection=users"
            "&start_date=2026-10-01&end_date=2026-10-15&q=searchterm"
        )
        assert res.status_code == 200

        # Verify filter query constructed
        call_args = mock_col.find.call_args[0][0]
        assert call_args["action"] == "USER_LOGIN"
        assert call_args["actor_role"] == "citizen"
        assert call_args["target_collection"] == "users"
        assert "$gte" in call_args["created_at"]
        assert "$lte" in call_args["created_at"]
        assert "$or" in call_args


def test_audit_log_detail_endpoint(client):
    """Admin can inspect individual audit records by MongoDB ObjectId."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "admin"

    valid_id = ObjectId()
    mock_doc = {
        "_id": valid_id,
        "actor_id": "officer_456",
        "actor_role": "admin",
        "action": "COMPLAINT_STATUS_UPDATED",
        "target_collection": "complaints",
        "target_id": "MSP-CMP-2026-XYZ12345",
        "before_after_summary": {"before_status": "Submitted", "after_status": "Resolved", "remarks": "Pothole filled."},
        "ip": "192.168.1.50",
        "created_at": datetime.now(timezone.utc)
    }

    mock_col = MagicMock()
    mock_col.find_one.return_value = mock_doc

    with patch("backend.routes.admin_portal.get_collection", return_value=mock_col):
        # 1. Successful lookup
        res = client.get(f"/api/admin/audit-logs/{str(valid_id)}")
        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True
        assert data["data"]["target_id"] == "MSP-CMP-2026-XYZ12345"
        assert data["data"]["before_after_summary"]["remarks"] == "Pothole filled."

        # 2. Not found
        mock_col.find_one.return_value = None
        res_404 = client.get(f"/api/admin/audit-logs/{str(ObjectId())}")
        assert res_404.status_code == 404
        assert res_404.get_json()["error"]["code"] == "LOG_NOT_FOUND"

        # 3. Invalid ID format
        res_bad = client.get("/api/admin/audit-logs/not-a-valid-object-id")
        assert res_bad.status_code == 400
        assert res_bad.get_json()["error"]["code"] == "INVALID_ID"


def test_security_response_headers(client):
    """All HTTP responses must include strict security and isolation headers."""
    res = client.get("/api/config")
    assert res.status_code == 200

    # Content isolation & sniffing prevention
    assert res.headers.get("X-Content-Type-Options") == "nosniff"
    # Clickjacking protection
    assert res.headers.get("X-Frame-Options") == "DENY"
    # Referrer leakage prevention
    assert res.headers.get("Referrer-Policy") == "strict-origin-when-cross-origin"
    # Permissions policy disabling unnecessary device sensors
    assert "camera=()" in res.headers.get("Permissions-Policy", "")
    assert "microphone=()" in res.headers.get("Permissions-Policy", "")
    assert "geolocation=(self)" in res.headers.get("Permissions-Policy", "")
    # Cross-origin isolation
    assert res.headers.get("Cross-Origin-Opener-Policy") == "same-origin"
    # Modern XSS protection directive
    assert res.headers.get("X-XSS-Protection") == "0"
    # Strict Content Security Policy
    csp = res.headers.get("Content-Security-Policy", "")
    assert "default-src 'self'" in csp
    assert "script-src 'self'" in csp


def test_413_payload_too_large_rejection(client):
    """Payloads exceeding MAX_CONTENT_LENGTH trigger HTTP 413 with standard JSON error."""
    # Trigger 413 error handler directly using a simulated oversized request
    with client.application.test_request_context():
        from werkzeug.exceptions import RequestEntityTooLarge
        handler = client.application.error_handler_spec[None][413][RequestEntityTooLarge]
        res, status = handler(RequestEntityTooLarge())
        assert status == 413
        data = res.get_json()
        assert data["success"] is False
        assert data["error"]["code"] == "FILE_TOO_LARGE"
        assert "5 MB" in data["error"]["message"]


def test_429_rate_limit_exceeded_handler(client):
    """HTTP 429 Rate Limit Exceeded returns standardized JSON error response."""
    with client.application.test_request_context():
        from werkzeug.exceptions import TooManyRequests
        handler = client.application.error_handler_spec[None][429][TooManyRequests]
        res, status = handler(TooManyRequests())
        assert status == 429
        data = res.get_json()
        assert data["success"] is False
        assert data["error"]["code"] == "RATE_LIMIT_EXCEEDED"
        assert "Too many requests" in data["error"]["message"]
