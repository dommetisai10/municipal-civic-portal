"""Tests for the honest health check endpoint and error responses."""

from unittest.mock import patch
import pytest
from backend.app import create_app
from backend.config import TestingConfig


@pytest.fixture
def app():
    """Create application configured for testing."""
    application = create_app(config_class=TestingConfig)
    return application


@pytest.fixture
def client(app):
    """Test client for issuing HTTP requests."""
    return app.test_client()


def test_health_check_db_healthy(client):
    """When database ping succeeds, /api/health must return HTTP 200 and status healthy."""
    with patch("backend.routes.health.check_db_connection", return_value=(True, "MongoDB is responsive")):
        response = client.get("/api/health")
        assert response.status_code == 200
        data = response.get_json()
        assert data["success"] is True
        assert data["error"] is None
        assert data["data"]["status"] == "healthy"
        assert data["data"]["database"] == "connected"
        assert "timestamp" in data["data"]


def test_health_check_db_unavailable(client):
    """When database ping fails, /api/health must honestly return HTTP 503 Service Unavailable."""
    with patch("backend.routes.health.check_db_connection", return_value=(False, "Connection actively refused")):
        response = client.get("/api/health")
        assert response.status_code == 503
        data = response.get_json()
        assert data["success"] is False
        assert data["data"]["status"] == "degraded"
        assert data["data"]["database"] == "disconnected"
        assert data["error"]["code"] == "DATABASE_UNAVAILABLE"
        assert "Database connection failed" in data["error"]["message"]


def test_not_found_returns_standard_json(client):
    """Unmatched routes must return standardized JSON 404 errors."""
    response = client.get("/api/non-existent-route")
    assert response.status_code == 404
    data = response.get_json()
    assert data["success"] is False
    assert data["error"]["code"] == "NOT_FOUND"


def test_security_headers_present(client):
    """All responses must include standard security headers."""
    response = client.get("/api/health")
    assert response.headers.get("X-Content-Type-Options") == "nosniff"
    assert response.headers.get("X-Frame-Options") == "DENY"
    assert "default-src" in response.headers.get("Content-Security-Policy", "")
