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
csrf_res = client.get('/api/auth/csrf-token')
csrf_data = json.loads(csrf_res.data)
csrf_token = csrf_data['data']['csrf_token']
headers = {'X-CSRF-Token': csrf_token}

# 2. Login as admin
login_res = client.post(
    '/api/admin/auth/login',
    data=json.dumps({'email': 'admin@municipal.gov', 'password': 'Admin@12345'}),
    content_type='application/json',
    headers=headers
)
login_data = json.loads(login_res.data)
assert login_data['success'], f"Admin login failed: {login_data}"
print(f"Admin Login: SUCCESS, role={login_data['data']['role']}")

# 3. Check dashboard metrics
dash_res = client.get('/api/admin/dashboard?range=30d')
dash_data = json.loads(dash_res.data)
assert dash_data['success'], f"Dashboard fetch failed: {dash_data}"
metrics = dash_data['data']['metrics']
apps = metrics['applications']
print(f"Dashboard Metrics (30d): Total={apps['total']}, Pending={apps.get('Pending') or apps.get('Submitted')}, Approved={apps['Approved']}, Citizens={metrics['citizens_count']}")
assert apps['total'] == 7, f"Expected 7 total apps, got {apps['total']}"
assert apps['Approved'] == 2, f"Expected 2 approved apps, got {apps['Approved']}"
assert apps.get('Pending') == 5 or apps.get('Submitted') == 5, f"Expected 5 pending apps, got {apps}"
assert metrics['citizens_count'] == 5, f"Expected 5 citizens, got {metrics['citizens_count']}"

# 4. Total Applications list
apps_res = client.get('/api/admin/applications')
apps_data = json.loads(apps_res.data)
assert apps_data['success']
print(f"Total Applications returned: {len(apps_data['data'])}")
assert len(apps_data['data']) == 7, f"Expected 7 applications, got {len(apps_data['data'])}"
for a in apps_data['data']:
    print(f"  - {a['application_id']}: status={a['status']}, applicant={a.get('applicant_name') or a.get('citizen_name')}, service={a['service_name']}")

# 5. Approved filter
approved_res = client.get('/api/admin/applications?status=Approved')
approved_data = json.loads(approved_res.data)
assert approved_data['success']
print(f"Approved Applications returned: {len(approved_data['data'])}")
assert len(approved_data['data']) == 2, f"Expected 2 approved, got {len(approved_data['data'])}"
for a in approved_data['data']:
    print(f"  - {a['application_id']}: status={a['status']}")

# 6. Pending filter
pending_res = client.get('/api/admin/applications?status=Pending')
pending_data = json.loads(pending_res.data)
assert pending_data['success']
print(f"Pending Applications returned: {len(pending_data['data'])}")
assert len(pending_data['data']) == 5, f"Expected 5 pending, got {len(pending_data['data'])}"
for a in pending_data['data']:
    print(f"  - {a['application_id']}: status={a['status']}")

# 7. Citizens list
citizens_res = client.get('/api/admin/citizens')
citizens_data = json.loads(citizens_res.data)
assert citizens_data['success']
cits = citizens_data['data']['citizens']
print(f"Registered Citizens returned: {len(cits)}")
assert len(cits) == 5, f"Expected 5 citizens, got {len(cits)}"
for c in cits:
    print(f"  - {c['email']}: name={c['name']}, phone={c['phone']}, is_active={c['is_active']}, apps={c['applications_count']}")
    assert 'password' not in c and 'password_hash' not in c and 'token' not in c

print('\n>>> ALL LIVE VERIFICATION CHECKS PASSED SUCCESSFULLY! <<<')
