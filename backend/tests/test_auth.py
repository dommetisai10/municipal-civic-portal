"""Automated unit and integration test suite for authentication and authorization."""

from unittest.mock import MagicMock, patch
from bson import ObjectId
from datetime import datetime, timezone
import pytest
from backend.app import create_app
from backend.config import TestingConfig
from backend.utils.security import hash_password, verify_password


@pytest.fixture
def app():
    """Create test application."""
    application = create_app(config_class=TestingConfig)
    return application


@pytest.fixture
def client(app):
    """Create test HTTP client."""
    return app.test_client()


def test_password_hashing():
    """Verify that bcrypt correctly hashes and verifies passwords without storing plaintext."""
    pwd = "SecurePassword123"
    hashed = hash_password(pwd)
    assert hashed != pwd
    assert hashed.startswith("$2b$")
    assert verify_password(pwd, hashed) is True
    assert verify_password("WrongPassword123", hashed) is False


def test_registration_validation_rules(client):
    """Registration must reject invalid email and weak passwords."""
    token_res = client.get("/api/auth/csrf-token")
    csrf_token = token_res.get_json()["data"]["csrf_token"]

    # 1. Password without digit
    res = client.post(
        "/api/auth/register",
        headers={"X-CSRF-Token": csrf_token},
        json={
            "full_name": "Jane Citizen",
            "email": "jane@example.com",
            "mobile": "9876543210",
            "address": "123 Civic Way",
            "password": "PasswordOnly"  # Missing digit
        }
    )
    assert res.status_code == 400
    data = res.get_json()
    assert data["success"] is False
    assert "digit" in data["error"]["fields"]["password"]

    # 2. Invalid email format
    res2 = client.post(
        "/api/auth/register",
        headers={"X-CSRF-Token": csrf_token},
        json={
            "full_name": "Jane Citizen",
            "email": "not-an-email",
            "mobile": "9876543210",
            "address": "123 Civic Way",
            "password": "Password123"
        }
    )
    assert res2.status_code == 400
    data2 = res2.get_json()
    assert data2["success"] is False
    assert "email" in data2["error"]["fields"]


def test_csrf_token_required_on_post(client):
    """State-changing POST request without X-CSRF-Token header must be rejected with HTTP 403."""
    res = client.post("/api/auth/register", json={
        "full_name": "Test User",
        "email": "test@example.com",
        "mobile": "9876543210",
        "address": "123 Test St",
        "password": "ValidPassword123"
    })
    assert res.status_code == 403
    data = res.get_json()
    assert data["success"] is False
    assert "CSRF" in data["error"]["code"]


def test_citizen_registration_success(client):
    """Valid citizen registration must persist with acknowledged write and return HTTP 201."""
    token_res = client.get("/api/auth/csrf-token")
    csrf_token = token_res.get_json()["data"]["csrf_token"]

    mock_users_col = MagicMock()
    mock_users_col.find_one.return_value = None  # No duplicate email
    user_object_id = ObjectId()
    mock_users_col.insert_one.return_value = MagicMock(acknowledged=True, inserted_id=user_object_id)

    mock_audit_col = MagicMock()
    mock_audit_col.insert_one.return_value = MagicMock(acknowledged=True)

    with patch("backend.routes.auth.get_collection", return_value=mock_users_col), \
         patch("backend.services.audit.get_collection", return_value=mock_audit_col):
        res = client.post(
            "/api/auth/register",
            headers={"X-CSRF-Token": csrf_token},
            json={
                "full_name": "Citizen One",
                "email": "citizen.one@example.com",
                "mobile": "9876543210",
                "address": "456 Civic Road",
                "password": "ValidPass123"
            }
        )
        assert res.status_code == 201
        data = res.get_json()
        assert data["success"] is True
        assert data["data"]["email"] == "citizen.one@example.com"
        assert data["data"]["role"] == "citizen"

        # Verify users collection insert
        insert_args = mock_users_col.insert_one.call_args[0][0]
        assert insert_args["email"] == "citizen.one@example.com"
        assert insert_args["password_hash"] != "ValidPass123"
        assert insert_args["password_hash"].startswith("$2b$")


def test_duplicate_email_rejected(client):
    """Registration with an already existing email must be rejected with HTTP 409 Conflict."""
    token_res = client.get("/api/auth/csrf-token")
    csrf_token = token_res.get_json()["data"]["csrf_token"]

    mock_col = MagicMock()
    mock_col.find_one.return_value = {"email": "duplicate@example.com"}

    with patch("backend.routes.auth.get_collection", return_value=mock_col):
        res = client.post(
            "/api/auth/register",
            headers={"X-CSRF-Token": csrf_token},
            json={
                "full_name": "Existing User",
                "email": "duplicate@example.com",
                "mobile": "9876543210",
                "address": "789 Park Lane",
                "password": "ValidPassword123"
            }
        )
        assert res.status_code == 409
        data = res.get_json()
        assert data["success"] is False
        assert data["error"]["code"] == "EMAIL_ALREADY_EXISTS"


def test_citizen_login_and_admin_rejection(client):
    """Citizen can log in to citizen auth, but is strictly rejected on admin login endpoint."""
    token_res = client.get("/api/auth/csrf-token")
    csrf_token = token_res.get_json()["data"]["csrf_token"]

    user_id = ObjectId()
    citizen_record = {
        "_id": user_id,
        "full_name": "Jane Citizen",
        "email": "jane@example.com",
        "password_hash": hash_password("ValidPassword123"),
        "role": "citizen",
        "is_active": True,
        "failed_login_attempts": 0,
        "locked_until": None
    }

    mock_users_col = MagicMock()
    mock_users_col.find_one.return_value = citizen_record
    mock_users_col.update_one.return_value = MagicMock(acknowledged=True)

    mock_audit_col = MagicMock()
    mock_audit_col.insert_one.return_value = MagicMock(acknowledged=True)

    with patch("backend.routes.auth.get_collection", return_value=mock_users_col), \
         patch("backend.routes.admin_auth.get_collection", return_value=mock_users_col), \
         patch("backend.services.audit.get_collection", return_value=mock_audit_col):

        # 1. Citizen login succeeds
        res = client.post(
            "/api/auth/login",
            headers={"X-CSRF-Token": csrf_token},
            json={"email": "jane@example.com", "password": "ValidPassword123"}
        )
        assert res.status_code == 200
        data = res.get_json()
        assert data["success"] is True
        assert data["data"]["role"] == "citizen"

        # Login sets a fresh CSRF token in the session and returns it in data
        fresh_csrf_token = data["data"]["csrf_token"]

        # 2. Same citizen credentials on admin login endpoint MUST fail with 401
        res_admin = client.post(
            "/api/admin/auth/login",
            headers={"X-CSRF-Token": fresh_csrf_token},
            json={"email": "jane@example.com", "password": "ValidPassword123"}
        )
        assert res_admin.status_code == 401
        admin_data = res_admin.get_json()
        assert admin_data["success"] is False
        assert admin_data["error"]["code"] == "INVALID_CREDENTIALS"


def test_protected_routes_require_authentication(client):
    """Accessing /api/auth/me without an authenticated session must return HTTP 401."""
    res = client.get("/api/auth/me")
    assert res.status_code == 401
    data = res.get_json()
    assert data["success"] is False
    assert data["error"]["code"] == "UNAUTHORIZED"


def test_admin_route_forbidden_for_unauthorized_user(client):
    """Admin me endpoint must reject non-admins with 401 or 403."""
    res = client.get("/api/admin/auth/me")
    assert res.status_code == 401
    data = res.get_json()
    assert data["success"] is False
