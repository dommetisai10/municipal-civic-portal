import json
import pytest
from backend.app import create_app
from backend.services.db import get_collection

@pytest.fixture
def client():
    app = create_app()
    app.config["TESTING"] = True
    with app.test_client() as client:
        yield client

def test_birth_certificate_service_fee(client):
    """Verifies Birth Certificate statutory fee is 50 in services API and catalog."""
    res = client.get("/api/services/birth-certificate")
    assert res.status_code == 200
    data = res.get_json()["data"]
    assert data["slug"] == "birth-certificate"
    assert data["fee"] == 50, f"Expected fee 50, got {data.get('fee')}"

def test_admin_applications_filtered_by_birth_certificate(client):
    """Verifies filtering by service=birth-certificate returns all 3 applications with fee=50."""
    # Obtain CSRF token
    csrf_res = client.get("/api/auth/csrf-token")
    csrf_token = csrf_res.get_json()["data"]["csrf_token"]
    headers = {"X-CSRF-Token": csrf_token}

    # Authenticate as admin
    login_res = client.post(
        "/api/admin/auth/login",
        json={"email": "admin@municipal.gov", "password": "Admin@12345"},
        headers=headers
    )
    assert login_res.status_code == 200, f"Login failed: {login_res.data}"

    # Refresh CSRF token for subsequent requests
    csrf_res2 = client.get("/api/auth/csrf-token")
    headers["X-CSRF-Token"] = csrf_res2.get_json()["data"]["csrf_token"]

    # Query applications for birth-certificate
    app_res = client.get("/api/admin/applications?service=birth-certificate", headers=headers)
    assert app_res.status_code == 200
    apps = app_res.get_json()["data"]
    assert len(apps) == 3, f"Expected 3 birth certificate applications, got {len(apps)}"

    for app in apps:
        assert app["service_slug"] == "birth-certificate"
        assert app["fee"] == 50.0, f"Application {app['application_id']} fee is {app['fee']}, expected 50.0"

    # Also test query by service name
    name_res = client.get("/api/admin/applications?service=Birth%20Certificate", headers=headers)
    assert name_res.status_code == 200
    name_apps = name_res.get_json()["data"]
    assert len(name_apps) == 3

    # Check detail endpoint
    detail_res = client.get(f"/api/admin/applications/{apps[0]['application_id']}", headers=headers)
    assert detail_res.status_code == 200
    detail = detail_res.get_json()["data"]
    assert detail["fee"] == 50.0

def test_unrelated_service_fees_unchanged(client):
    """Confirms other services fees are not altered to 50."""
    street_res = client.get("/api/services/street-light-repair")
    assert street_res.status_code == 200
    assert street_res.get_json()["data"]["fee"] == 0

    trade_res = client.get("/api/services/trade-license")
    assert trade_res.status_code == 200
    assert trade_res.get_json()["data"]["fee"] == 1500
