"""Automated unit and integration tests for public status tracking and privacy protection."""

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


def test_track_missing_id_returns_400(client):
    """Tracking without providing an identifier must return HTTP 400."""
    res = client.get("/api/track")
    assert res.status_code == 400
    data = res.get_json()
    assert data["success"] is False
    assert data["error"]["code"] == "TRACKING_ID_REQUIRED"


def test_track_non_existent_record_returns_404(client):
    """Querying a non-existent reference ID must return HTTP 404."""
    mock_apps = MagicMock()
    mock_apps.find_one.return_value = None
    mock_cmps = MagicMock()
    mock_cmps.find_one.return_value = None

    def col_side_effect(name):
        if name == "applications":
            return mock_apps
        if name == "complaints":
            return mock_cmps
        return MagicMock()

    with patch("backend.routes.track.get_collection", side_effect=col_side_effect):
        res = client.get("/api/track/MSP-APP-2026-NONEXIST")
        assert res.status_code == 404
        data = res.get_json()
        assert data["success"] is False
        assert data["error"]["code"] == "RECORD_NOT_FOUND"


def test_track_application_publicly_with_zero_pii(client):
    """Tracking an application must return public status milestones without leaking PII."""
    app_id = "MSP-APP-2026-K8F2N9X4"
    now = datetime.now(timezone.utc)

    # Database document containing sensitive citizen information
    mock_app_doc = {
        "_id": ObjectId(),
        "application_id": app_id,
        "user_id": ObjectId(),
        "user_email": "citizen.secret@example.com",
        "user_name": "Private Citizen",
        "service_name": "Birth Certificate",
        "category": "Civil Registration",
        "status": "Under Review",
        "certificate_status": "Issuance not supported",
        "form_data": {
            "child_full_name": "Secret Baby",
            "father_name": "Secret Father",
            "permanent_address": "Private Residence Road 12"
        },
        "documents": [
            {
                "original_filename": "birth_report.pdf",
                "stored_filename": "uuid-1234.pdf",
                "file_path": "/var/server/uploads/applications/uuid-1234.pdf"
            }
        ],
        "status_history": [
            {
                "status": "Submitted",
                "changed_at": now,
                "remarks": "Application submitted by citizen."
            },
            {
                "status": "Under Review",
                "changed_at": now,
                "remarks": "Application assigned to civil registrar."
            }
        ],
        "created_at": now,
        "updated_at": now
    }

    mock_apps = MagicMock()
    mock_apps.find_one.return_value = mock_app_doc

    with patch("backend.routes.track.get_collection", return_value=mock_apps):
        # Public unauthenticated request
        res = client.get(f"/api/track/{app_id}")
        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True

        payload = data["data"]
        assert payload["record_id"] == app_id
        assert payload["record_type"] == "Application"
        assert payload["title"] == "Birth Certificate"
        assert payload["department"] == "Civil Registration"
        assert payload["status"] == "Under Review"
        assert payload["certificate_status"] == "Issuance not supported"
        assert payload["documents_attached_count"] == 1
        assert len(payload["timeline"]) == 2

        # STRICT PII AND SERVER PATH AUDIT
        raw_response_str = str(data)
        assert "citizen.secret@example.com" not in raw_response_str
        assert "Private Citizen" not in raw_response_str
        assert "Secret Baby" not in raw_response_str
        assert "Private Residence Road 12" not in raw_response_str
        assert "/var/server/uploads" not in raw_response_str
        assert "user_id" not in payload


def test_track_complaint_publicly_with_zero_pii(client):
    """Tracking a complaint returns department, status, location without citizen credentials."""
    cmp_id = "MSP-CMP-2026-M4P9R2T7"
    now = datetime.now(timezone.utc)

    mock_cmp_doc = {
        "_id": ObjectId(),
        "complaint_id": cmp_id,
        "user_id": ObjectId(),
        "user_email": "resident.private@example.com",
        "user_name": "Jane Citizen",
        "title": "Broken Streetlight",
        "department": "Streetlighting & Electrical",
        "description": "Streetlight #14 is non-functional.",
        "location": "Ward 5, 2nd Cross Road",
        "status": "Submitted",
        "images": [{"stored_filename": "uuid-photo.jpg"}],
        "status_history": [
            {
                "status": "Submitted",
                "changed_at": now,
                "remarks": "Grievance registered."
            }
        ],
        "created_at": now,
        "updated_at": now
    }

    mock_cmps = MagicMock()
    mock_cmps.find_one.return_value = mock_cmp_doc

    with patch("backend.routes.track.get_collection", return_value=mock_cmps):
        res = client.get(f"/api/track/{cmp_id}")
        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True

        payload = data["data"]
        assert payload["record_id"] == cmp_id
        assert payload["record_type"] == "Complaint"
        assert payload["title"] == "Broken Streetlight"
        assert payload["department"] == "Streetlighting & Electrical"
        assert payload["status"] == "Submitted"
        assert payload["location"] == "Ward 5, 2nd Cross Road"
        assert payload["images_attached_count"] == 1

        # STRICT PII AUDIT
        raw_str = str(data)
        assert "resident.private@example.com" not in raw_str
        assert "Jane Citizen" not in raw_str
        assert "user_id" not in payload


def test_track_case_insensitivity_and_query_string(client):
    """Tracking is case-insensitive and supports ?id= query parameters."""
    app_id = "MSP-APP-2026-ABCD1234"
    mock_doc = {
        "application_id": app_id,
        "service_name": "Property Tax Assessment",
        "category": "Revenue & Taxation",
        "status": "Approved",
        "certificate_status": "Issuance not supported",
        "documents": [],
        "status_history": [],
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc)
    }

    mock_apps = MagicMock()
    mock_apps.find_one.return_value = mock_doc

    with patch("backend.routes.track.get_collection", return_value=mock_apps):
        # Lowercase in query param
        res = client.get("/api/track?id=msp-app-2026-abcd1234")
        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True
        assert data["data"]["record_id"] == app_id
        assert data["data"]["status"] == "Approved"
