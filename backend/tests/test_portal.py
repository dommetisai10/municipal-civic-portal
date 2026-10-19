"""Tests for public homepage serving and portal configuration API."""

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


def test_homepage_static_serving(client):
    """The root route '/' must serve index.html with HTTP 200."""
    response = client.get("/")
    assert response.status_code == 200
    html_content = response.get_data(as_text=True)
    assert "<title>Municipal Service Portal" in html_content
    assert "hero-section" in html_content
    assert "quick-action-strip" in html_content


def test_css_static_serving(client):
    """The /css/style.css file must be served with HTTP 200 and text/css content type."""
    response = client.get("/css/style.css")
    assert response.status_code == 200
    assert "text/css" in response.headers.get("Content-Type", "")
    css_content = response.get_data(as_text=True)
    assert "--primary-700" in css_content


def test_js_static_serving(client):
    """The /js/home.js module must be served with HTTP 200."""
    response = client.get("/js/home.js")
    assert response.status_code == 200
    js_content = response.get_data(as_text=True)
    assert "initPortalConfig" in js_content


def test_portal_config_api(client):
    """GET /api/config must return public contact info and branding without secrets."""
    response = client.get("/api/config")
    assert response.status_code == 200
    data = response.get_json()
    assert data["success"] is True
    assert "municipality_name" in data["data"]
    assert "contact_phone" in data["data"]
    assert "contact_email" in data["data"]
    assert "office_address" in data["data"]
    # Ensure no secrets leak
    assert "SECRET_KEY" not in str(data)
    assert "MONGO_URI" not in str(data)


def test_services_catalog_empty_when_no_data(client):
    """GET /api/services must return an empty list when database contains no services."""
    from unittest.mock import MagicMock, patch
    mock_services_col = MagicMock()
    mock_cursor = MagicMock()
    mock_cursor.__iter__.return_value = []
    mock_services_col.find.return_value.sort.return_value = mock_cursor

    with patch("backend.routes.services.get_collection", return_value=mock_services_col):
        response = client.get("/api/services")
        assert response.status_code == 200
        data = response.get_json()
        assert data["success"] is True
        assert data["data"] == []
