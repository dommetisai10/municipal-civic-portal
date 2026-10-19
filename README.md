# Municipal Service Portal

A production-quality civic service web portal where citizens apply for municipal services and submit complaints, and municipal administrators review, assign, audit, and manage them.

Built with a strict clean data architecture: **no fake records, zero mock data, and 100% live database-backed counters and tables**.

---

## Architecture & Technology Stack

### Frontend
- **Markup & Layout**: HTML5 semantic elements (accessible, responsive, ARIA tags).
- **Styling**: Vanilla CSS3 (custom design system, responsive layouts, blue & white palette, no Tailwind or CSS frameworks).
- **Client Logic**: Vanilla JavaScript ES Modules (`import`/`export`), native `fetch` API.
- **Build Tools**: Zero build tools or transpilers; runs directly in modern web browsers.

### Backend
- **Language**: Python 3.11+
- **Framework**: Flask (modular structure using Flask Blueprints)
- **Database Driver**: PyMongo (official MongoDB driver)
- **Database**: MongoDB (Local instance or MongoDB Atlas)
- **Approved Supporting Libraries**:
  - `Flask-CORS`: Handles Cross-Origin Resource Sharing for decoupling frontend and backend.
  - `Flask-Limiter`: Protects against brute-force attacks on authentication, upload, and search routes.
  - `Flask-WTF`: CSRF token validation on state-changing requests.
  - `python-dotenv`: Environment variable management.
  - `bcrypt`: Cryptographic password hashing with adaptive salt.
  - `pytest`: Automated test framework.
  - `gunicorn`: Production WSGI HTTP server.

---

## Project Directory Structure

```text
municipal civic portal/
├── .gitignore                      # Root version control ignore rules
├── README.md                       # Master project documentation
├── backend/
│   ├── .env.example                # Template for environment configuration
│   ├── .gitignore                  # Backend-specific ignore rules
│   ├── requirements.txt            # Python dependencies with explanations
│   ├── app.py                      # Flask application factory (Step 2)
│   ├── config.py                   # Configuration loader (Step 2)
│   ├── config/                     # Configuration assets (services catalog, etc.)
│   ├── middleware/                 # Security headers, auth decorators, CSRF
│   ├── routes/                     # Blueprint routes (auth, services, complaints, etc.)
│   ├── scripts/                    # Admin CLI & catalog bootstrap scripts
│   ├── services/                   # Business logic and database operations
│   ├── tests/                      # Pytest automated test suites
│   ├── utils/                      # Validation, file checks, response helpers
│   └── uploads/                    # Secure storage outside public static folder
└── frontend/
    ├── css/                        # Custom vanilla CSS stylesheets
    └── js/                         # Vanilla JS ES Modules
```

---

## Clean Data & Security Principles

1. **Zero Fake Data**: No placeholder or mock users, applications, complaints, statistics, or notices exist anywhere in the code.
2. **Honest Empty States**: If the database is empty, counters display `0` and tables show informative empty states.
3. **No Hardcoded Credentials**: Initial admin creation is performed strictly via CLI using Python's `getpass` module (`backend/scripts/create_admin.py`).
4. **Server-Side Authorization**: Every state-changing request checks session cookies, CSRF tokens, and record ownership.
5. **Secure Uploads**: Uploaded files are validated against allowed extensions, MIME types, and binary file signatures (magic bytes), renamed with random UUIDs, and stored outside the web root.

---

## 13-Step Implementation Workflow & Status

1. **Step 1: Environment & Project Scaffolding** `[Complete]`
   - Python virtual environment, dependencies specification (`backend/requirements.txt`), version control ignore rules (`.gitignore`), and environment configuration templates (`backend/.env.example`).
2. **Step 2: Database Layer & Connection Management** `[Complete]`
   - PyMongo database connection pooling, ping health check (`/api/health`), and automated indexing script (`backend/scripts/init_db.py`).
3. **Step 3: Authentication & Authorization Security** `[Complete]`
   - Citizen registration, login, logout, bcrypt password hashing with adaptive salt, role-based session cookies (`HttpOnly`, `SameSite=Lax`), CSRF token validation (`/api/auth/csrf-token`), and interactive admin bootstrap (`backend/scripts/create_admin.py`).
4. **Step 4: Public Homepage & Navigation** `[Complete]`
   - Accessible, responsive portal homepage (`frontend/index.html`) featuring announcement ticker, quick-action tiles, search bar, live municipal status counter, and skip-to-content links.
5. **Step 5: Citizen Dashboard & Live Profile** `[Complete]`
   - Citizen dashboard (`frontend/user-dashboard.html`) showing live aggregation counters (applications submitted, grievances resolved), interactive tab navigation, and notification badges.
6. **Step 6: Services Catalog & Dynamic Application Forms** `[Complete]`
   - Dynamic catalog (`frontend/services.html`), search/filter by department category, service availability enforcement, and schema-driven dynamic application form generator (`frontend/apply-service.html`).
7. **Step 7: Civic Grievances & Secure Uploads** `[Complete]`
   - Multi-department complaint submission (`frontend/submit-complaint.html`) supporting geolocation, street address sanitization, image attachments with binary magic-byte validation, and UUID-based isolated file storage (`backend/uploads/`).
8. **Step 8: Public & Authenticated Status Tracking** `[Complete]`
   - Zero-PII public status tracker (`frontend/track-status.html`) allowing citizens and public to track applications (`MSP-APP-YYYY-XXXXXXXX`) and grievances (`MSP-CMP-YYYY-XXXXXXXX`) without contact leakage.
9. **Step 9: Administrative Dashboard & Oversight** `[Complete]`
   - Secure officer portal (`frontend/admin-dashboard.html`) displaying municipal KPIs, application distributions, complaint statuses, and system activity logs.
10. **Step 10: Application Review & Grievance Resolution Workflows** `[Complete]`
    - Application review console (`frontend/admin-applications.html`) with document preview, remarks logging, and status transitions (`Under Review`, `Approved`, `Rejected`).
    - Complaint resolution console (`frontend/admin-complaints.html`) with department filtering, GPS inspection, and resolution updates.
11. **Step 11: Service Management, Notifications & Live Audit Trail** `[Complete]`
    - Dynamic service catalog toggling (`Active` / `Unavailable`), automated citizen in-app notifications on status changes, and immutable administrative audit logging (`frontend/admin-audit-logs.html`).
12. **Step 12: Automated Pytest Suite & Verification** `[Complete]`
    - 91 comprehensive automated unit, functional, security, accessibility, and end-to-end workflow test cases passing with 100% success rate (`pytest -v backend/tests`).
13. **Step 13: Production Deployment Preparation** `[Complete]`
    - Production WSGI entry points (`gunicorn backend.app:app`), security response headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options), rate-limiting configurations, and MongoDB Atlas connection guidelines.

---

## Quickstart Guide

### 1. Prerequisites
- **Python**: Version 3.11 or higher
- **MongoDB**: Local MongoDB instance (`mongodb://127.0.0.1:27017/`) or MongoDB Atlas URI

### 2. Environment Setup
```powershell
# Clone or navigate to the repository directory
cd "e:\municipal civic portal"

# Create and activate Python virtual environment
python -m venv backend\venv
backend\venv\Scripts\activate

# Install required dependencies
pip install -r backend\requirements.txt

# Configure environment variables
cp backend\.env.example backend\.env
```

### 3. Initialize Database & Static Catalog
```powershell
# Create unique indexes across all collections
python backend\scripts\init_db.py

# Seed initial services catalog definitions (all default to 'Unavailable')
python backend\scripts\init_services.py
```

### 4. Create Initial Administrator Account
```powershell
# Prompts securely for officer name, email, and password via getpass
python backend\scripts\create_admin.py
```

### 5. Run the Application
```powershell
# Run backend development server (serves both API & Frontend)
python -m backend.app
```
Open your browser to:
- **Citizen Portal**: `http://127.0.0.1:5000/`
- **Services Catalog**: `http://127.0.0.1:5000/services.html`
- **Submit Complaint**: `http://127.0.0.1:5000/submit-complaint.html`
- **Track Status**: `http://127.0.0.1:5000/track-status.html`
- **Admin Portal**: `http://127.0.0.1:5000/admin-login.html`

### 6. Run Automated Test Suite
```powershell
# Run the complete test suite across all 14 test modules
pytest -v backend\tests
```
All **91 automated test cases** cover:
- Authentication, session security, CSRF protection, and bcrypt hashing
- Application schema validation and magic-byte document upload rejection
- Grievance reporting, GPS tracking, and image security
- Zero-PII public tracking
- Administrative workflow state transitions and immutable audit logs
- HTML accessibility, semantic landmarks, skip links, and single-`<h1>` rules
- End-to-end citizen submission through officer resolution lifecycles
