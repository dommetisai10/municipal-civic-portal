"""Automated unit and integration tests for municipal grievance and complaints system."""

import io
from unittest.mock import MagicMock, patch
from datetime import datetime, timezone
from bson import ObjectId
import pytest

from backend.app import create_app
from backend.config import TestingConfig
from backend.utils.id_generator import generate_record_id
from backend.routes.complaints import MUNICIPAL_DEPARTMENTS


@pytest.fixture
def app():
    """Create test application."""
    application = create_app(config_class=TestingConfig)
    return application


@pytest.fixture
def client(app):
    """Create test HTTP client."""
    return app.test_client()


def test_complaint_id_generator_format():
    """Verify complaint record ID matches MSP-CMP-YYYY-XXXXXXXX pattern."""
    cmp_id = generate_record_id("MSP-CMP")
    year = str(datetime.now(timezone.utc).year)
    parts = cmp_id.split("-")
    assert len(parts) == 4
    assert parts[0] == "MSP"
    assert parts[1] == "CMP"
    assert parts[2] == year
    assert len(parts[3]) == 8


def test_get_departments_public_endpoint(client):
    """GET /api/complaints/departments must return the recognized municipal departments."""
    res = client.get("/api/complaints/departments")
    assert res.status_code == 200
    data = res.get_json()
    assert data["success"] is True
    assert "Sanitation & Waste Management" in data["data"]
    assert "Roads & Infrastructure" in data["data"]
    assert "Streetlighting & Electrical" in data["data"]


def test_submit_complaint_unauthorized(client):
    """Unauthenticated POST to /api/complaints must return HTTP 401."""
    res = client.post("/api/complaints", data={"title": "Broken Streetlight"})
    assert res.status_code == 401
    data = res.get_json()
    assert data["success"] is False
    assert data["error"]["code"] == "UNAUTHORIZED"


def test_submit_complaint_forbidden_for_admin(client):
    """Admins cannot lodge citizen complaints; must receive HTTP 403."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "admin"
        sess["csrf_token"] = "valid_csrf_token"

    res = client.post(
        "/api/complaints",
        data={"title": "Pothole on Main Road"},
        headers={"X-CSRF-Token": "valid_csrf_token"}
    )
    assert res.status_code == 403
    data = res.get_json()
    assert data["success"] is False
    assert data["error"]["code"] == "FORBIDDEN"


def test_submit_complaint_csrf_protection(client):
    """Citizen POST without CSRF token must be rejected with HTTP 403."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "citizen"
        sess["csrf_token"] = "valid_csrf_token"

    res = client.post(
        "/api/complaints",
        data={"title": "Pothole on Main Road"}
    )
    assert res.status_code == 403
    data = res.get_json()
    assert data["error"]["code"] == "CSRF_TOKEN_MISSING"


def test_submit_complaint_invalid_department(client):
    """Submitting a grievance with an unrecognized department must return HTTP 400."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "citizen"
        sess["email"] = "citizen@example.com"
        sess["csrf_token"] = "valid_csrf_token"

    res = client.post(
        "/api/complaints",
        data={
            "title": "Broken Drainage Cover",
            "department": "Space Exploration Department",  # Invalid department
            "description": "Drainage cover is shattered and posing danger to vehicles.",
            "location": "Ward 7, Market Cross"
        },
        headers={"X-CSRF-Token": "valid_csrf_token"}
    )
    assert res.status_code == 400
    data = res.get_json()
    assert data["error"]["code"] == "INVALID_DEPARTMENT"


def test_submit_complaint_validation_errors(client):
    """Title < 5 chars, Description < 15 chars, or Location < 5 chars must return HTTP 400."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "citizen"
        sess["email"] = "citizen@example.com"
        sess["csrf_token"] = "valid_csrf_token"

    # 1. Title too short
    res1 = client.post(
        "/api/complaints",
        data={
            "title": "Bad",
            "department": "Roads & Infrastructure",
            "description": "Large dangerous pothole right in front of the municipal hospital.",
            "location": "123 Civic Road"
        },
        headers={"X-CSRF-Token": "valid_csrf_token"}
    )
    assert res1.status_code == 400
    assert "at least 5 characters" in res1.get_json()["error"]["message"]

    # 2. Description too short
    res2 = client.post(
        "/api/complaints",
        data={
            "title": "Broken Streetlight",
            "department": "Streetlighting & Electrical",
            "description": "Too short",
            "location": "123 Civic Road"
        },
        headers={"X-CSRF-Token": "valid_csrf_token"}
    )
    assert res2.status_code == 400
    assert "at least 15 characters" in res2.get_json()["error"]["message"]


def test_submit_complaint_rejects_non_image_upload(client):
    """Grievances only allow image evidence (JPG, PNG). PDF files must be rejected."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "citizen"
        sess["email"] = "citizen@example.com"
        sess["csrf_token"] = "valid_csrf_token"

    # PDF file
    pdf_file = (io.BytesIO(b"%PDF-1.4\nvalid pdf"), "evidence.pdf")

    res = client.post(
        "/api/complaints",
        data={
            "title": "Garbage Overflowing",
            "department": "Sanitation & Waste Management",
            "description": "Garbage bin on corner of 3rd Avenue has not been cleared for 4 days.",
            "location": "Corner of 3rd Avenue and 5th Cross",
            "images": pdf_file
        },
        headers={"X-CSRF-Token": "valid_csrf_token"},
        content_type="multipart/form-data"
    )
    assert res.status_code == 400
    data = res.get_json()
    assert data["error"]["code"] == "INVALID_FILE"
    assert "extension '.pdf' is not permitted" in data["error"]["message"]


def test_submit_complaint_spoofed_image_magic_bytes_rejected(client):
    """Uploading a file named .jpg but lacking binary JPEG magic bytes must be rejected."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "citizen"
        sess["email"] = "citizen@example.com"
        sess["csrf_token"] = "valid_csrf_token"

    # Spoofed jpg: plain text bytes
    fake_jpg = (io.BytesIO(b"Fake JPG content text without magic header"), "pothole.jpg")

    res = client.post(
        "/api/complaints",
        data={
            "title": "Dangerous Pothole on Highway",
            "department": "Roads & Infrastructure",
            "description": "Very large pothole causing vehicle tire damage near city entrance.",
            "location": "Near West Gate City Toll",
            "images": fake_jpg
        },
        headers={"X-CSRF-Token": "valid_csrf_token"},
        content_type="multipart/form-data"
    )
    assert res.status_code == 400
    data = res.get_json()
    assert data["error"]["code"] == "INVALID_FILE"
    assert "binary signature" in data["error"]["message"]


def test_submit_complaint_success(client, tmp_path):
    """Valid grievance submission writes acknowledged record, notification, and audit event."""
    user_id = ObjectId()
    with client.session_transaction() as sess:
        sess["user_id"] = str(user_id)
        sess["role"] = "citizen"
        sess["email"] = "citizen@example.com"
        sess["full_name"] = "Citizen Clean"
        sess["csrf_token"] = "valid_csrf_token"

    # Valid JPEG image bytes starting with \xff\xd8\xff
    valid_jpg_bytes = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x01\x00`\x00`\x00\x00\xff\xdb"
    photo_file = (io.BytesIO(valid_jpg_bytes), "overflowing_bin.jpg")

    mock_cmps_col = MagicMock()
    insert_res = MagicMock(acknowledged=True)
    mock_cmps_col.insert_one.return_value = insert_res

    mock_notif_col = MagicMock()
    mock_notif_col.insert_one.return_value = MagicMock(acknowledged=True)

    def col_side_effect(name):
        if name == "complaints":
            return mock_cmps_col
        if name == "notifications":
            return mock_notif_col
        return MagicMock()

    with patch("backend.routes.complaints.get_collection", side_effect=col_side_effect), \
         patch("backend.routes.complaints.log_audit") as mock_audit, \
         patch("backend.utils.file_security.Config.UPLOAD_FOLDER", tmp_path):

        res = client.post(
            "/api/complaints",
            data={
                "title": "Overflowing Public Dustbin",
                "department": "Sanitation & Waste Management",
                "description": "Public dustbin near Ward 12 bus station has not been cleared for days.",
                "location": "Bus Station Stop, Ward 12",
                "latitude": "12.971598",
                "longitude": "77.594566",
                "images": photo_file
            },
            headers={"X-CSRF-Token": "valid_csrf_token"},
            content_type="multipart/form-data"
        )

        assert res.status_code == 201
        data = res.get_json()
        assert data["success"] is True
        assert data["data"]["complaint_id"].startswith("MSP-CMP-2026-")
        assert data["data"]["status"] == "Submitted"
        assert data["data"]["images_count"] == 1

        # Verify DB insert
        assert mock_cmps_col.insert_one.called
        inserted = mock_cmps_col.insert_one.call_args[0][0]
        assert inserted["user_id"] == user_id
        assert inserted["status"] == "Submitted"
        assert inserted["coordinates"] == {"latitude": 12.971598, "longitude": 77.594566}
        assert len(inserted["images"]) == 1

        # Verify notification
        assert mock_notif_col.insert_one.called

        # Verify audit log
        assert mock_audit.called
        assert mock_audit.call_args[1]["action"] == "COMPLAINT_SUBMITTED"


def test_get_my_complaints(client):
    """GET /api/complaints/my returns logged-in citizen's complaints."""
    user_id = ObjectId()
    with client.session_transaction() as sess:
        sess["user_id"] = str(user_id)
        sess["role"] = "citizen"

    mock_doc = {
        "complaint_id": "MSP-CMP-2026-T8R4N2K9",
        "title": "Streetlight Not Working",
        "department": "Streetlighting & Electrical",
        "status": "Submitted",
        "location": "Ward 5, 2nd Cross",
        "images": [{"stored_filename": "photo.jpg"}],
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc)
    }

    mock_cursor = MagicMock()
    mock_cursor.sort.return_value = [mock_doc]
    mock_cmps_col = MagicMock()
    mock_cmps_col.find.return_value = mock_cursor

    with patch("backend.routes.complaints.get_collection", return_value=mock_cmps_col):
        res = client.get("/api/complaints/my")
        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True
        assert len(data["data"]) == 1
        assert data["data"][0]["complaint_id"] == "MSP-CMP-2026-T8R4N2K9"
        assert data["data"][0]["images_count"] == 1


def test_get_complaint_detail_ownership_guard(client):
    """Citizens cannot view complaints registered by other citizens."""
    user1_id = ObjectId()
    user2_id = ObjectId()

    with client.session_transaction() as sess:
        sess["user_id"] = str(user1_id)
        sess["role"] = "citizen"

    # Complaint owned by user2
    mock_doc = {
        "complaint_id": "MSP-CMP-2026-W3E5R7T9",
        "user_id": user2_id,
        "title": "Illegal Encroachment",
        "status": "Submitted"
    }

    mock_cmps_col = MagicMock()
    mock_cmps_col.find_one.return_value = mock_doc

    with patch("backend.routes.complaints.get_collection", return_value=mock_cmps_col):
        res = client.get("/api/complaints/MSP-CMP-2026-W3E5R7T9")
        assert res.status_code == 403
        data = res.get_json()
        assert data["error"]["code"] == "FORBIDDEN"


def test_complaint_image_download_path_traversal_prevented(client):
    """Path traversal attack in complaint image download must be rejected."""
    with client.session_transaction() as sess:
        sess["user_id"] = str(ObjectId())
        sess["role"] = "citizen"

    res = client.get("/api/complaints/MSP-CMP-2026-ABCD1234/images/..%2F..%2Fconfig.py")
    assert res.status_code in [400, 404]
