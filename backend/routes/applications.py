"""Citizen municipal service applications routes and document retrieval."""

import os
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from flask import Blueprint, request, session, send_file
from bson import ObjectId
from pymongo.errors import PyMongoError

from backend.config import Config
from backend.services.db import get_collection
from backend.services.audit import log_audit
from backend.middleware.auth import login_required, citizen_required, csrf_protect
from backend.utils.responses import success_response, error_response
from backend.utils.id_generator import generate_record_id
from backend.utils.file_security import (
    validate_and_save_file,
    ALLOWED_APPLICATION_EXTENSIONS
)

logger = logging.getLogger(__name__)

applications_bp = Blueprint("applications", __name__, url_prefix="/api")


@applications_bp.route("/applications", methods=["POST"])
@citizen_required
@csrf_protect
def submit_application():
    """
    Submits a new municipal service application with dynamic form data and supporting documents.
    
    STRICT CLEAN DATA RULE:
    - Verifies service exists and is strictly available.
    - If service is 'Unavailable', rejects immediately with HTTP 400.
    - Validates dynamic form fields against the service's form_schema.
    - Enforces binary file magic bytes and size checks.
    - Generates unique ID formatted as MSP-APP-YYYY-XXXXXXXX.
    - Writes acknowledged record, audit trail, and citizen notification.
    """
    try:
        body = {}
        if request.is_json:
            body = request.get_json(silent=True) or {}
            service_slug = body.get("service_slug", "").strip()
        else:
            service_slug = request.form.get("service_slug", "").strip()

        if not service_slug:
            return error_response(
                code="SERVICE_SLUG_REQUIRED",
                message="Service slug is required to submit an application.",
                status_code=400
            )

        # 1. Fetch service definition from database
        services_col = get_collection("services")
        service = services_col.find_one({"slug": service_slug})
        if not service:
            return error_response(
                code="SERVICE_NOT_FOUND",
                message=f"Service '{service_slug}' does not exist.",
                status_code=404
            )

        # 2. Strict Availability Check
        if service.get("availability") == "Unavailable":
            return error_response(
                code="SERVICE_UNAVAILABLE",
                message=f"Service '{service.get('name')}' is currently marked as Unavailable and cannot accept applications.",
                status_code=400
            )

        # 3. Extract and Parse Form Data
        form_data = {}
        if request.is_json:
            raw_fd = body.get("form_data", {})
            if isinstance(raw_fd, str):
                try:
                    form_data = json.loads(raw_fd)
                except (ValueError, TypeError):
                    form_data = {}
            elif isinstance(raw_fd, dict):
                form_data = raw_fd
        elif "form_data" in request.form:
            try:
                form_data = json.loads(request.form.get("form_data", "{}"))
            except (ValueError, TypeError):
                return error_response(
                    code="INVALID_DATA",
                    message="Malformed form_data JSON payload.",
                    status_code=400
                )
        else:
            for key, val in request.form.items():
                if key != "service_slug":
                    form_data[key] = val.strip() if isinstance(val, str) else val

        # 4. Dynamic Schema Validation against form_schema
        schema = service.get("form_schema", [])
        field_errors = {}
        for field in schema:
            fname = field.get("name")
            flabel = field.get("label", fname)
            is_required = field.get("required", False)
            val = form_data.get(fname)

            if is_required and (val is None or str(val).strip() == ""):
                field_errors[fname] = f"{flabel} is required."
                continue

            if val and field.get("type") == "select" and field.get("options"):
                if val not in field["options"]:
                    field_errors[fname] = f"Invalid selection for {flabel}."

        if field_errors:
            return error_response(
                code="VALIDATION_ERROR",
                message="One or more required fields are missing or invalid.",
                fields=field_errors,
                status_code=400
            )

        # 5. Process Supporting Documents
        file_list = []
        if "documents" in request.files:
            file_list.extend(request.files.getlist("documents"))
        for key, f in request.files.items():
            if key != "documents" and f not in file_list:
                file_list.append(f)

        required_docs = service.get("required_documents", [])
        # If the service lists required documents, at least one file must be attached
        if required_docs and not any(f.filename for f in file_list):
            return error_response(
                code="DOCUMENTS_REQUIRED",
                message=f"At least one supporting document is required for '{service.get('name')}'.",
                status_code=400
            )

        uploaded_docs = []
        for file_obj in file_list:
            if not file_obj or not file_obj.filename:
                continue
            valid, err, meta = validate_and_save_file(
                file_obj,
                subfolder="applications",
                allowed_extensions=ALLOWED_APPLICATION_EXTENSIONS
            )
            if not valid:
                return error_response(
                    code="INVALID_FILE",
                    message=err,
                    status_code=400
                )
            uploaded_docs.append(meta)

        # 6. Generate Record ID & Timestamps
        app_id = generate_record_id("MSP-APP")
        now = datetime.now(timezone.utc)
        user_id = ObjectId(session["user_id"])

        record = {
            "application_id": app_id,
            "user_id": user_id,
            "user_email": session.get("email", ""),
            "user_name": session.get("full_name", ""),
            "service_id": str(service.get("_id", "")),
            "service_slug": service.get("slug", service_slug),
            "service_name": service.get("name", ""),
            "category": service.get("category", "General"),
            "form_data": form_data,
            "documents": uploaded_docs,
            "status": "Submitted",
            "certificate_status": "Issuance not supported",
            "status_history": [
                {
                    "status": "Submitted",
                    "changed_at": now,
                    "changed_by": str(user_id),
                    "role": "citizen",
                    "remarks": "Application submitted by citizen."
                }
            ],
            "created_at": now,
            "updated_at": now
        }

        # 7. Acknowledged Database Write
        apps_col = get_collection("applications")
        res = apps_col.insert_one(record)
        if not res.acknowledged:
            return error_response(
                code="DATABASE_ERROR",
                message="Failed to persist application record.",
                status_code=500
            )

        # 8. Create Citizen Notification
        notif_col = get_collection("notifications")
        notif_col.insert_one({
            "user_id": user_id,
            "title": "Application Submitted",
            "message": f"Your application {app_id} for '{service['name']}' was submitted successfully.",
            "link": "/user-dashboard.html",
            "is_read": False,
            "created_at": now
        })

        # 9. Audit Log
        log_audit(
            actor_id=str(user_id),
            actor_role="citizen",
            action="APPLICATION_SUBMITTED",
            target_collection="applications",
            target_id=app_id,
            before_after_summary={"application_id": app_id, "service_slug": service_slug, "status": "Submitted"},
            ip=request.remote_addr
        )

        return success_response(
            data={
                "application_id": app_id,
                "service_name": service["name"],
                "status": "Submitted",
                "certificate_status": "Issuance not supported",
                "created_at": now.isoformat(),
                "documents_count": len(uploaded_docs),
                "message": f"Application {app_id} submitted successfully."
            },
            status_code=201
        )

    except PyMongoError as exc:
        logger.error("Database error during application submission: %s", exc)
        return error_response(
            code="DATABASE_ERROR",
            message="Database connection error occurred.",
            fields={"details": str(exc)},
            status_code=503
        )
    except Exception as exc:
        logger.error("Unexpected error in submit_application: %s", exc)
        return error_response(
            code="INTERNAL_SERVER_ERROR",
            message=f"An error occurred: {str(exc)}",
            status_code=500
        )


@applications_bp.route("/applications", methods=["GET"])
@applications_bp.route("/applications/my", methods=["GET"])
@citizen_required
def get_my_applications():
    """Returns all applications submitted by the logged-in citizen."""
    try:
        user_id = ObjectId(session["user_id"])
        apps_col = get_collection("applications")

        cursor = apps_col.find({"user_id": user_id}).sort("created_at", -1)
        results = []
        for doc in cursor:
            results.append({
                "application_id": doc.get("application_id"),
                "service_name": doc.get("service_name"),
                "service_slug": doc.get("service_slug"),
                "category": doc.get("category", "General"),
                "status": doc.get("status", "Submitted"),
                "certificate_status": doc.get("certificate_status", "Issuance not supported"),
                "documents_count": len(doc.get("documents", [])),
                "created_at": doc.get("created_at").isoformat() if isinstance(doc.get("created_at"), datetime) else str(doc.get("created_at")),
                "updated_at": doc.get("updated_at").isoformat() if isinstance(doc.get("updated_at"), datetime) else str(doc.get("updated_at"))
            })

        return success_response(data=results)
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@applications_bp.route("/applications/<application_id>", methods=["GET"])
@login_required
def get_application_detail(application_id):
    """
    Returns application details.
    Enforces authorization: citizens can only view their own; admins can view any.
    """
    try:
        apps_col = get_collection("applications")
        doc = apps_col.find_one({"application_id": application_id})
        if not doc:
            return error_response(code="APPLICATION_NOT_FOUND", message="Application record not found.", status_code=404)

        user_role = session.get("role")
        current_user_id = str(session.get("user_id"))

        # Ownership check
        if user_role == "citizen" and str(doc.get("user_id")) != current_user_id:
            return error_response(code="FORBIDDEN", message="You do not have permission to view this application.", status_code=403)

        # Sanitize documents metadata (exclude server filesystem paths)
        safe_documents = []
        for d in doc.get("documents", []):
            safe_documents.append({
                "original_filename": d.get("original_filename"),
                "stored_filename": d.get("stored_filename"),
                "extension": d.get("extension"),
                "mime_type": d.get("mime_type"),
                "file_size": d.get("file_size"),
                "uploaded_at": d.get("uploaded_at")
            })

        history = []
        for h in doc.get("status_history", []):
            history.append({
                "status": h.get("status"),
                "changed_at": h.get("changed_at").isoformat() if isinstance(h.get("changed_at"), datetime) else str(h.get("changed_at")),
                "role": h.get("role", "system"),
                "remarks": h.get("remarks", "")
            })

        return success_response(data={
            "application_id": doc.get("application_id"),
            "service_name": doc.get("service_name"),
            "service_slug": doc.get("service_slug"),
            "category": doc.get("category"),
            "status": doc.get("status"),
            "certificate_status": doc.get("certificate_status", "Issuance not supported"),
            "form_data": doc.get("form_data", {}),
            "documents": safe_documents,
            "status_history": history,
            "created_at": doc.get("created_at").isoformat() if isinstance(doc.get("created_at"), datetime) else str(doc.get("created_at")),
            "updated_at": doc.get("updated_at").isoformat() if isinstance(doc.get("updated_at"), datetime) else str(doc.get("updated_at"))
        })

    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@applications_bp.route("/applications/<application_id>/documents/<stored_filename>", methods=["GET"])
@login_required
def download_application_document(application_id, stored_filename):
    """
    Secure document download endpoint.
    Verifies authentication, ownership, and prevents path traversal attacks.
    """
    try:
        # Path traversal guard: filename must be a pure basename
        if stored_filename != os.path.basename(stored_filename):
            return error_response(code="INVALID_FILENAME", message="Invalid document identifier.", status_code=400)

        apps_col = get_collection("applications")
        doc = apps_col.find_one({"application_id": application_id})
        if not doc:
            return error_response(code="APPLICATION_NOT_FOUND", message="Application record not found.", status_code=404)

        user_role = session.get("role")
        current_user_id = str(session.get("user_id"))

        # Ownership guard
        if user_role == "citizen" and str(doc.get("user_id")) != current_user_id:
            return error_response(code="FORBIDDEN", message="You do not have permission to access this document.", status_code=403)

        # Verify the requested file is officially attached to this application
        matched_doc = None
        for d in doc.get("documents", []):
            if d.get("stored_filename") == stored_filename:
                matched_doc = d
                break

        if not matched_doc:
            return error_response(code="DOCUMENT_NOT_FOUND", message="Document is not associated with this application.", status_code=404)

        target_path = Config.UPLOAD_FOLDER / "applications" / stored_filename
        if not target_path.exists():
            return error_response(code="FILE_MISSING", message="Document file not found on storage.", status_code=404)

        return send_file(
            str(target_path),
            as_attachment=False,
            download_name=matched_doc.get("original_filename", stored_filename),
            mimetype=matched_doc.get("mime_type", "application/octet-stream")
        )

    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)
