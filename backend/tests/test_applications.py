"""Automated unit and integration tests for municipal service applications."""

import io
import json
from unittest.mock import MagicMock, patch
from datetime import datetime, timezone
from bson import ObjectId
import pytest

from backend.app import create_app
from backend.config import TestingConfig
from backend.utils.id_generator import generate_record_id


@pytest.fixture
def app():
    """Create test application."""
    application = create_app(config_class=TestingConfig)
    return application


@pytest.fixture
def client(app):
    """Create test HTTP client."""
    return app.test_client()


def test_id_generator_format():
    """Verify application record ID matches MSP-APP-YYYY-XXXXXXXX pattern."""
    app_id = generate_record_id("MSP-APP")
    year = str(datetime.now(timezone.utc).year)
    parts = app_id.split("-")
    assert len(parts) == 4
    assert parts[0] == "MSP"
    assert parts[1] == "APP"
    assert parts[2] == year
    assert len(parts[3]) == 8


def test_submit_application_unauthorized(client):
    """Unauthenticated POST to /api/applications must return HTTP 401."""
    res = client.post("/api/applications", data={"service_slug": "birth-certificate"})
    assert res.status_code == 401
    data = res.get_json()
    assert data["success"] is False
    assert data["error"]["code"] == "UNAUTHORIZED"


def test_submit_application_forbidden_for_admin(client):
    """Admins cannot submit citizen applications; must receive HTTP 403."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "admin"
        sess["csrf_token"] = "valid_csrf_token"

    res = client.post(
        "/api/applications",
        data={"service_slug": "birth-certificate"},
        headers={"X-CSRF-Token": "valid_csrf_token"}
    )
    assert res.status_code == 403
    data = res.get_json()
    assert data["success"] is False
    assert data["error"]["code"] == "FORBIDDEN"


def test_submit_application_csrf_protection(client):
    """Citizen POST without CSRF header must be rejected with HTTP 403."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "citizen"
        sess["csrf_token"] = "valid_csrf_token"

    res = client.post(
        "/api/applications",
        data={"service_slug": "birth-certificate"}
    )
    assert res.status_code == 403
    data = res.get_json()
    assert data["error"]["code"] == "CSRF_TOKEN_MISSING"


def test_submit_application_service_not_found(client):
    """Non-existent service slug must return HTTP 404."""
    user_id = ObjectId()
    with client.session_transaction() as sess:
        sess["user_id"] = str(user_id)
        sess["role"] = "citizen"
        sess["email"] = "citizen@example.com"
        sess["full_name"] = "Citizen Clean"
        sess["csrf_token"] = "valid_csrf_token"

    mock_services = MagicMock()
    mock_services.find_one.return_value = None

    with patch("backend.routes.applications.get_collection", return_value=mock_services):
        res = client.post(
            "/api/applications",
            data={"service_slug": "non-existent-service"},
            headers={"X-CSRF-Token": "valid_csrf_token"}
        )
        assert res.status_code == 404
        data = res.get_json()
        assert data["error"]["code"] == "SERVICE_NOT_FOUND"


def test_submit_application_service_unavailable(client):
    """Services marked 'Unavailable' must reject applications with HTTP 400."""
    user_id = ObjectId()
    with client.session_transaction() as sess:
        sess["user_id"] = str(user_id)
        sess["role"] = "citizen"
        sess["email"] = "citizen@example.com"
        sess["full_name"] = "Citizen Clean"
        sess["csrf_token"] = "valid_csrf_token"

    mock_service_doc = {
        "_id": ObjectId(),
        "slug": "birth-certificate",
        "name": "Birth Certificate",
        "availability": "Unavailable",
        "required_documents": ["Hospital Birth Report"],
        "form_schema": []
    }

    mock_services = MagicMock()
    mock_services.find_one.return_value = mock_service_doc

    with patch("backend.routes.applications.get_collection", return_value=mock_services):
        res = client.post(
            "/api/applications",
            data={"service_slug": "birth-certificate"},
            headers={"X-CSRF-Token": "valid_csrf_token"}
        )
        assert res.status_code == 400
        data = res.get_json()
        assert data["error"]["code"] == "SERVICE_UNAVAILABLE"
        assert "currently marked as Unavailable" in data["error"]["message"]


def test_submit_application_missing_required_schema_field(client):
    """Applications missing required fields from service form_schema must return HTTP 400."""
    user_id = ObjectId()
    with client.session_transaction() as sess:
        sess["user_id"] = str(user_id)
        sess["role"] = "citizen"
        sess["email"] = "citizen@example.com"
        sess["full_name"] = "Citizen Clean"
        sess["csrf_token"] = "valid_csrf_token"

    mock_service_doc = {
        "_id": ObjectId(),
        "slug": "water-connection",
        "name": "Water Connection",
        "availability": "Active",
        "required_documents": [],
        "form_schema": [
            {"name": "property_id", "label": "Property PID", "type": "text", "required": True},
            {"name": "connection_type", "label": "Connection Type", "type": "select", "options": ["Domestic", "Commercial"], "required": True}
        ]
    }

    mock_services = MagicMock()
    mock_services.find_one.return_value = mock_service_doc

    with patch("backend.routes.applications.get_collection", return_value=mock_services):
        res = client.post(
            "/api/applications",
            data={
                "service_slug": "water-connection",
                "form_data": json.dumps({"property_id": ""})
            },
            headers={"X-CSRF-Token": "valid_csrf_token"}
        )
        assert res.status_code == 400
        data = res.get_json()
        assert data["error"]["code"] == "VALIDATION_ERROR"
        assert "property_id" in data["error"]["fields"]


def test_submit_application_spoofed_file_magic_bytes_rejected(client):
    """Uploading a file with spoofed extension (.pdf) but plain text bytes must be rejected."""
    user_id = ObjectId()
    with client.session_transaction() as sess:
        sess["user_id"] = str(user_id)
        sess["role"] = "citizen"
        sess["email"] = "citizen@example.com"
        sess["full_name"] = "Citizen Clean"
        sess["csrf_token"] = "valid_csrf_token"

    mock_service_doc = {
        "_id": ObjectId(),
        "slug": "trade-license",
        "name": "Trade License",
        "availability": "Active",
        "required_documents": ["Business Registration"],
        "form_schema": []
    }

    mock_services = MagicMock()
    mock_services.find_one.return_value = mock_service_doc

    # Spoofed file: .pdf name but plain text content (missing %PDF signature)
    fake_pdf = (io.BytesIO(b"This is just plain text, not a valid binary PDF."), "license.pdf")

    with patch("backend.routes.applications.get_collection", return_value=mock_services):
        res = client.post(
            "/api/applications",
            data={
                "service_slug": "trade-license",
                "documents": fake_pdf
            },
            headers={"X-CSRF-Token": "valid_csrf_token"},
            content_type="multipart/form-data"
        )
        assert res.status_code == 400
        data = res.get_json()
        assert data["error"]["code"] == "INVALID_FILE"
        assert "binary signature" in data["error"]["message"]


def test_submit_application_success(client, tmp_path):
    """Valid application submission creates acknowledged DB entry, notification, and audit event."""
    user_id = ObjectId()
    with client.session_transaction() as sess:
        sess["user_id"] = str(user_id)
        sess["role"] = "citizen"
        sess["email"] = "citizen@example.com"
        sess["full_name"] = "Citizen Clean"
        sess["csrf_token"] = "valid_csrf_token"

    mock_service_doc = {
        "_id": ObjectId(),
        "slug": "birth-certificate",
        "name": "Birth Certificate",
        "category": "Civil Registration",
        "availability": "Active",
        "required_documents": ["Hospital Birth Report"],
        "form_schema": [
            {"name": "child_full_name", "label": "Child Name", "type": "text", "required": True},
            {"name": "date_of_birth", "label": "Date of Birth", "type": "date", "required": True}
        ]
    }

    # Valid PDF with %PDF magic header
    valid_pdf_bytes = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF"
    pdf_file = (io.BytesIO(valid_pdf_bytes), "birth_report.pdf")

    mock_services_col = MagicMock()
    mock_services_col.find_one.return_value = mock_service_doc

    mock_apps_col = MagicMock()
    insert_res = MagicMock()
    insert_res.acknowledged = True
    mock_apps_col.insert_one.return_value = insert_res

    mock_notif_col = MagicMock()
    mock_notif_col.insert_one.return_value = MagicMock(acknowledged=True)

    def col_side_effect(name):
        if name == "services":
            return mock_services_col
        if name == "applications":
            return mock_apps_col
        if name == "notifications":
            return mock_notif_col
        return MagicMock()

    with patch("backend.routes.applications.get_collection", side_effect=col_side_effect), \
         patch("backend.routes.applications.log_audit") as mock_audit, \
         patch("backend.utils.file_security.Config.UPLOAD_FOLDER", tmp_path):

        res = client.post(
            "/api/applications",
            data={
                "service_slug": "birth-certificate",
                "form_data": json.dumps({"child_full_name": "Baby Doe", "date_of_birth": "2026-05-12"}),
                "documents": pdf_file
            },
            headers={"X-CSRF-Token": "valid_csrf_token"},
            content_type="multipart/form-data"
        )

        assert res.status_code == 201
        data = res.get_json()
        assert data["success"] is True
        assert data["data"]["application_id"].startswith("MSP-APP-2026-")
        assert data["data"]["status"] == "Submitted"
        assert data["data"]["certificate_status"] == "Issuance not supported"
        assert data["data"]["documents_count"] == 1

        # Verify DB insert happened
        assert mock_apps_col.insert_one.called
        inserted_doc = mock_apps_col.insert_one.call_args[0][0]
        assert inserted_doc["user_id"] == user_id
        assert inserted_doc["status"] == "Submitted"
        assert len(inserted_doc["documents"]) == 1

        # Verify notification created
        assert mock_notif_col.insert_one.called

        # Verify audit log recorded
        assert mock_audit.called
        assert mock_audit.call_args[1]["action"] == "APPLICATION_SUBMITTED"


def test_get_my_applications(client):
    """GET /api/applications/my returns all applications for logged-in citizen."""
    user_id = ObjectId()
    with client.session_transaction() as sess:
        sess["user_id"] = str(user_id)
        sess["role"] = "citizen"

    mock_doc = {
        "application_id": "MSP-APP-2026-ABCD1234",
        "service_name": "Birth Certificate",
        "service_slug": "birth-certificate",
        "category": "Civil Registration",
        "status": "Submitted",
        "certificate_status": "Issuance not supported",
        "documents": [{"stored_filename": "uuid.pdf"}],
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc)
    }

    mock_cursor = MagicMock()
    mock_cursor.sort.return_value = [mock_doc]
    mock_apps_col = MagicMock()
    mock_apps_col.find.return_value = mock_cursor

    with patch("backend.routes.applications.get_collection", return_value=mock_apps_col):
        res = client.get("/api/applications/my")
        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True
        assert len(data["data"]) == 1
        assert data["data"][0]["application_id"] == "MSP-APP-2026-ABCD1234"
        assert data["data"][0]["documents_count"] == 1


def test_get_application_detail_ownership_guard(client):
    """Citizens cannot view applications belonging to other citizens."""
    user1_id = ObjectId()
    user2_id = ObjectId()

    with client.session_transaction() as sess:
        sess["user_id"] = str(user1_id)
        sess["role"] = "citizen"

    # Application owned by user2
    mock_doc = {
        "application_id": "MSP-APP-2026-XYZ98765",
        "user_id": user2_id,
        "service_name": "Property Tax",
        "status": "Submitted"
    }

    mock_apps_col = MagicMock()
    mock_apps_col.find_one.return_value = mock_doc

    with patch("backend.routes.applications.get_collection", return_value=mock_apps_col):
        res = client.get("/api/applications/MSP-APP-2026-XYZ98765")
        assert res.status_code == 403
        data = res.get_json()
        assert data["error"]["code"] == "FORBIDDEN"


def test_document_download_path_traversal_prevented(client):
    """Path traversal in document filename must be rejected with HTTP 400."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "citizen"

    res = client.get("/api/applications/MSP-APP-2026-ABCD1234/documents/..%2F..%2Fconfig.py")
    assert res.status_code in [400, 404]
