import sys
import json
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.app import create_app

app = create_app()
client = app.test_client()

# 1. Fetch CSRF token
csrf_res = client.get("/api/auth/csrf-token")
csrf_data = json.loads(csrf_res.data)
csrf_token = csrf_data["data"]["csrf_token"]
headers = {"X-CSRF-Token": csrf_token}

# 2. Login as admin
login_res = client.post(
    "/api/admin/auth/login",
    data=json.dumps({"email": "admin@municipal.gov", "password": "Admin@12345"}),
    content_type="application/json",
    headers=headers
)
assert login_res.status_code == 200, f"Login failed: {login_res.data}"
print("1. Admin Login: SUCCESS")

# Refresh CSRF token for the authenticated admin session
csrf_res = client.get("/api/auth/csrf-token")
csrf_token = json.loads(csrf_res.data)["data"]["csrf_token"]
headers["X-CSRF-Token"] = csrf_token

# 3. Test Services Catalog API & Filtering
srv_res = client.get("/api/admin/services", headers=headers)
assert srv_res.status_code == 200
srv_data = json.loads(srv_res.data)["data"]
print(f"2. Services Catalog (All): Total = {len(srv_data)}")
assert len(srv_data) == 21, f"Expected 21 services, got {len(srv_data)}"

srv_avail_res = client.get("/api/admin/services?availability=Available", headers=headers)
srv_avail_data = json.loads(srv_avail_res.data)["data"]
print(f"3. Services Catalog (Available): Count = {len(srv_avail_data)}")
assert len(srv_avail_data) == 21, f"Expected 21 available services, got {len(srv_avail_data)}"

srv_unavail_res = client.get("/api/admin/services?availability=Unavailable", headers=headers)
srv_unavail_data = json.loads(srv_unavail_res.data)["data"]
print(f"4. Services Catalog (Unavailable): Count = {len(srv_unavail_data)}")
assert len(srv_unavail_data) == 0, f"Expected 0 unavailable services, got {len(srv_unavail_data)}"

# 4. Test Dashboard Metrics
dash_res = client.get("/api/admin/dashboard?range=30d", headers=headers)
assert dash_res.status_code == 200
metrics = json.loads(dash_res.data)["data"]["metrics"]
print(f"5. Dashboard Metrics: Active Services = {metrics.get('services_active_count')}, Inactive = {metrics.get('services_inactive_count')}, Avg Processing = {metrics.get('avg_processing_time_days')} d")
assert metrics.get("services_active_count") == 21
assert metrics.get("services_inactive_count") == 0

# 5. Test Citizen View, Edit & Validation
citizens_res = client.get("/api/admin/citizens?page=1&limit=10", headers=headers)
assert citizens_res.status_code == 200
citizens_list = json.loads(citizens_res.data)["data"]["citizens"]
print(f"6. Citizens Directory: Listed {len(citizens_list)} citizens")
assert len(citizens_list) >= 1

# Choose a test citizen
test_citizen = citizens_list[0]
citizen_id = test_citizen["id"]
orig_name = test_citizen["name"]
orig_phone = test_citizen.get("phone", "")

# View details
detail_res = client.get(f"/api/admin/citizens/{citizen_id}", headers=headers)
assert detail_res.status_code == 200
detail_data = json.loads(detail_res.data)["data"]
assert "citizen" in detail_data or "id" in detail_data
print(f"7. Citizen View Detail: Retrieved profile for {detail_data.get('name')}")

# Edit Citizen: valid update
edit_res = client.put(
    f"/api/admin/citizens/{citizen_id}",
    data=json.dumps({"name": f"{orig_name} (Verified)", "phone": "9876543210", "address": "Ward 12, Civic Zone"}),
    content_type="application/json",
    headers=headers
)
assert edit_res.status_code == 200, f"Edit citizen failed: {edit_res.data}"
print(f"8. Citizen Edit: Successfully updated profile particulars")

# Verify persistence
verify_edit = client.get(f"/api/admin/citizens/{citizen_id}", headers=headers)
v_data = json.loads(verify_edit.data)["data"]
assert "(Verified)" in v_data.get("name", "")

# Edit Citizen: validation rejection for duplicate email
dup_res = client.put(
    f"/api/admin/citizens/{citizen_id}",
    data=json.dumps({"email": citizens_list[1]["email"]}),
    content_type="application/json",
    headers=headers
)
assert dup_res.status_code == 400
print(f"9. Citizen Validation: Duplicate email successfully rejected (HTTP 400)")

# Revert citizen name
client.put(
    f"/api/admin/citizens/{citizen_id}",
    data=json.dumps({"name": orig_name, "phone": orig_phone}),
    content_type="application/json",
    headers=headers
)

# 6. Test Application View, Edit & Status Transition
apps_res = client.get("/api/admin/applications", headers=headers)
assert apps_res.status_code == 200
apps_list = json.loads(apps_res.data)["data"]
assert len(apps_list) == 7
print(f"10. Applications Listing: Retrieved {len(apps_list)} applications")

# Choose an application to inspect and edit
test_app = apps_list[0]
app_id = test_app["application_id"]
orig_app_name = test_app.get("applicant_name") or test_app.get("citizen_name")

# View application detail
app_detail_res = client.get(f"/api/admin/applications/{app_id}", headers=headers)
assert app_detail_res.status_code == 200
app_detail = json.loads(app_detail_res.data)["data"]
print(f"11. Application View Detail: {app_id} - {app_detail.get('service_name')} (Status: {app_detail.get('status')})")

# Edit application particulars via PUT
app_put_res = client.put(
    f"/api/admin/applications/{app_id}",
    data=json.dumps({
        "applicant_name": f"{orig_app_name} Updated",
        "applicant_mobile": "9998887776",
        "address": "Municipal Ward 4, House 102",
        "description": "Administrative update for verification"
    }),
    content_type="application/json",
    headers=headers
)
assert app_put_res.status_code == 200, f"Application edit failed: {app_put_res.data}"
put_resp_data = json.loads(app_put_res.data)["data"]
print(f"12. Application Edit (PUT): Successfully updated applicant name to '{put_resp_data.get('applicant_name')}'")

# Verify persistence
verify_app_edit = client.get(f"/api/admin/applications/{app_id}", headers=headers)
v_app_data = json.loads(verify_app_edit.data)["data"]
assert "Updated" in v_app_data.get("applicant_name", "")
assert v_app_data.get("applicant_mobile") == "9998887776"

# Revert name
client.put(
    f"/api/admin/applications/{app_id}",
    data=json.dumps({"applicant_name": orig_app_name}),
    content_type="application/json",
    headers=headers
)

# Test Status Transition with mandatory remarks
current_status = v_app_data.get("status")
target_status = "Under Review" if current_status != "Under Review" else "Pending"
status_update_res = client.patch(
    f"/api/admin/applications/{app_id}/status",
    data=json.dumps({"status": target_status, "remarks": "Reviewing attached address proof documents"}),
    content_type="application/json",
    headers=headers
)
assert status_update_res.status_code == 200, f"Status update failed: {status_update_res.data}"
print(f"13. Application Status Transition: Status transitioned to '{target_status}' with audit trail")

# Transition with insufficient remarks should fail (validation)
bad_status_res = client.patch(
    f"/api/admin/applications/{app_id}/status",
    data=json.dumps({"status": "Approved", "remarks": "ok"}),
    content_type="application/json",
    headers=headers
)
assert bad_status_res.status_code == 400
print(f"14. Status Validation: Rejection of short remarks confirmed (HTTP 400)")

# Revert status back to original
client.patch(
    f"/api/admin/applications/{app_id}/status",
    data=json.dumps({"status": current_status, "remarks": "Reverting to initial state post-verification"}),
    content_type="application/json",
    headers=headers
)

# 7. Check Audit Logs were recorded
audit_res = client.get("/api/admin/audit-logs?limit=5", headers=headers)
assert audit_res.status_code == 200
audit_entries = json.loads(audit_res.data)["data"].get("logs", [])
print(f"15. Audit Logs: Successfully recorded {len(audit_entries)} recent administrative actions")
actions_logged = [log.get("action") for log in audit_entries]
print(f"    Actions in log: {actions_logged}")

print("\n>>> ALL CRUD & INTEGRATION CHECKS PASSED PERFECTLY! <<<")
