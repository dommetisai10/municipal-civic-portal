"""Citizen grievance and complaint redressal routes with image verification."""

import os
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
    ALLOWED_COMPLAINT_EXTENSIONS
)
from backend.utils.validators import sanitize_string

logger = logging.getLogger(__name__)

complaints_bp = Blueprint("complaints", __name__, url_prefix="/api")

COMPLAINT_CATEGORIES = [
    "Garbage Collection",
    "Water Supply",
    "Road Damage",
    "Drainage Problems",
    "Streetlight Problems",
    "Public Sanitation",
    "Illegal Dumping",
    "Public Infrastructure",
    "Other Municipal Problems"
]

MUNICIPAL_DEPARTMENTS = [
    "Sanitation & Waste Management",
    "Roads & Infrastructure",
    "Roads & Traffic",
    "Streetlighting & Electrical",
    "Water Supply & Sewerage",
    "Drainage & Storm Water",
    "Public Health & Vector Control",
    "Encroachment & Illegal Construction",
    "Horticulture & Parks",
    "Other Civic Issue"
]


@complaints_bp.route("/complaints/categories", methods=["GET"])
def get_categories():
    """Returns the list of recognized complaint categories per specification."""
    return success_response(data=COMPLAINT_CATEGORIES)


@complaints_bp.route("/complaints/departments", methods=["GET"])
def get_departments():
    """Returns the list of municipal departments available for grievance routing."""
    return success_response(data=MUNICIPAL_DEPARTMENTS)


@complaints_bp.route("/complaints", methods=["POST"])
@citizen_required
@csrf_protect
def submit_complaint():
    """
    Submits a new citizen grievance / complaint with location details, landmark, and image proofs.

    STRICT CLEAN DATA & SECURITY RULES:
    - Enforces department routing to designated municipal departments or categories.
    - Title, description, and location undergo length and injection validation.
    - File uploads strictly restricted to images (JPG, JPEG, PNG, max 5 MB).
    - Binary magic bytes inspection prevents spoofed extensions.
    - Generates unique ID formatted as MSP-CMP-YYYY-XXXXXXXX.
    - Writes acknowledged record, audit trail, and citizen notification.
    """
    try:
        # 1. Validate Title
        raw_title = request.form.get("title")
        ok, title = sanitize_string(raw_title, field_name="Title", min_length=5, max_length=120, required=True)
        if not ok:
            return error_response(code="VALIDATION_ERROR", message=title, fields={"title": title}, status_code=400)

        # 2. Validate Category / Department
        raw_cat = request.form.get("category", "").strip()
        raw_dept = request.form.get("department", "").strip()
        chosen = raw_cat or raw_dept

        all_valid_options = COMPLAINT_CATEGORIES + MUNICIPAL_DEPARTMENTS
        if not chosen or chosen not in all_valid_options:
            err_code = "INVALID_DEPARTMENT" if raw_dept else "INVALID_CATEGORY"
            return error_response(
                code=err_code,
                message="Grievance category must be one of the recognized municipal categories.",
                fields={"category": f"Must be one of {COMPLAINT_CATEGORIES}"},
                status_code=400
            )

        category = chosen
        department = chosen

        # 3. Validate Description
        raw_desc = request.form.get("description")
        ok, description = sanitize_string(raw_desc, field_name="Description", min_length=15, max_length=2000, required=True)
        if not ok:
            return error_response(code="VALIDATION_ERROR", message=description, fields={"description": description}, status_code=400)

        # 4. Validate Location / Address
        raw_loc = request.form.get("location")
        ok, location = sanitize_string(raw_loc, field_name="Location", min_length=5, max_length=300, required=True)
        if not ok:
            return error_response(code="VALIDATION_ERROR", message=location, fields={"location": location}, status_code=400)

        # 4b. Optional Landmark
        raw_landmark = request.form.get("landmark")
        ok_lm, landmark = sanitize_string(raw_landmark, field_name="Landmark", min_length=0, max_length=150, required=False)
        landmark_val = landmark if (ok_lm and landmark) else None

        # 5. Optional GPS Coordinates
        coordinates = None
        lat_str = request.form.get("latitude")
        lng_str = request.form.get("longitude")
        if lat_str and lng_str:
            try:
                lat = float(lat_str)
                lng = float(lng_str)
                if -90.0 <= lat <= 90.0 and -180.0 <= lng <= 180.0:
                    coordinates = {"latitude": lat, "longitude": lng}
            except (ValueError, TypeError):
                # Ignore invalid coordinates without failing the entire submission
                pass

        # 6. Process Uploaded Images (JPG, JPEG, PNG only)
        file_list = []
        if "images" in request.files:
            file_list.extend(request.files.getlist("images"))
        for key, f in request.files.items():
            if key != "images" and f not in file_list:
                file_list.append(f)

        uploaded_images = []
        for file_obj in file_list:
            if not file_obj or not file_obj.filename:
                continue

            valid, err, meta = validate_and_save_file(
                file_obj,
                subfolder="complaints",
                allowed_extensions=ALLOWED_COMPLAINT_EXTENSIONS
            )
            if not valid:
                return error_response(code="INVALID_FILE", message=err, status_code=400)
            uploaded_images.append(meta)

        # 7. Generate Record ID & Timestamps
        cmp_id = generate_record_id("MSP-CMP")
        now = datetime.now(timezone.utc)
        user_id = ObjectId(session["user_id"])

        record = {
            "complaint_id": cmp_id,
            "user_id": user_id,
            "user_email": session.get("email", ""),
            "user_name": session.get("full_name", ""),
            "title": title,
            "department": department,
            "category": category,
            "description": description,
            "location": location,
            "landmark": landmark_val,
            "assigned_department": "Unassigned",
            "coordinates": coordinates,
            "images": uploaded_images,
            "status": "Submitted",
            "status_history": [
                {
                    "status": "Submitted",
                    "changed_at": now,
                    "changed_by": str(user_id),
                    "role": "citizen",
                    "remarks": "Grievance submitted by citizen."
                }
            ],
            "created_at": now,
            "updated_at": now
        }

        # 8. Acknowledged Database Write
        cmps_col = get_collection("complaints")
        res = cmps_col.insert_one(record)
        if not res.acknowledged:
            return error_response(
                code="DATABASE_ERROR",
                message="Failed to persist complaint record.",
                status_code=500
            )

        # 9. Create Citizen Notification
        notif_col = get_collection("notifications")
        notif_col.insert_one({
            "user_id": user_id,
            "title": "Grievance Registered",
            "message": f"Your complaint {cmp_id} for '{department}' has been registered.",
            "link": "/user-dashboard.html",
            "is_read": False,
            "created_at": now
        })

        # 10. Audit Log
        log_audit(
            actor_id=str(user_id),
            actor_role="citizen",
            action="COMPLAINT_SUBMITTED",
            target_collection="complaints",
            target_id=cmp_id,
            before_after_summary={"complaint_id": cmp_id, "department": department, "status": "Submitted"},
            ip=request.remote_addr
        )

        return success_response(
            data={
                "complaint_id": cmp_id,
                "title": title,
                "department": department,
                "status": "Submitted",
                "created_at": now.isoformat(),
                "images_count": len(uploaded_images),
                "message": f"Grievance {cmp_id} registered successfully."
            },
            status_code=201
        )

    except PyMongoError as exc:
        logger.error("Database error during complaint submission: %s", exc)
        return error_response(code="DATABASE_ERROR", message="Database connection error occurred.", fields={"details": str(exc)}, status_code=503)
    except Exception as exc:
        logger.error("Unexpected error in submit_complaint: %s", exc)
        return error_response(code="INTERNAL_SERVER_ERROR", message=f"An error occurred: {str(exc)}", status_code=500)


@complaints_bp.route("/complaints/my", methods=["GET"])
@citizen_required
def get_my_complaints():
    """Returns all complaints submitted by the logged-in citizen."""
    try:
        user_id = ObjectId(session["user_id"])
        cmps_col = get_collection("complaints")

        cursor = cmps_col.find({"user_id": user_id}).sort("created_at", -1)
        results = []
        for doc in cursor:
            results.append({
                "complaint_id": doc.get("complaint_id"),
                "title": doc.get("title"),
                "department": doc.get("department"),
                "status": doc.get("status", "Submitted"),
                "location": doc.get("location"),
                "images_count": len(doc.get("images", [])),
                "created_at": doc.get("created_at").isoformat() if isinstance(doc.get("created_at"), datetime) else str(doc.get("created_at")),
                "updated_at": doc.get("updated_at").isoformat() if isinstance(doc.get("updated_at"), datetime) else str(doc.get("updated_at"))
            })

        return success_response(data=results)
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@complaints_bp.route("/complaints/<complaint_id>", methods=["GET"])
@login_required
def get_complaint_detail(complaint_id):
    """
    Returns complaint details with ownership enforcement:
    Citizens can view only their own complaints; administrators can view any.
    """
    try:
        cmps_col = get_collection("complaints")
        doc = cmps_col.find_one({"complaint_id": complaint_id})
        if not doc:
            return error_response(code="COMPLAINT_NOT_FOUND", message="Complaint record not found.", status_code=404)

        user_role = session.get("role")
        current_user_id = str(session.get("user_id"))

        if user_role == "citizen" and str(doc.get("user_id")) != current_user_id:
            return error_response(code="FORBIDDEN", message="You do not have permission to view this complaint.", status_code=403)

        safe_images = []
        for img in doc.get("images", []):
            safe_images.append({
                "original_filename": img.get("original_filename"),
                "stored_filename": img.get("stored_filename"),
                "extension": img.get("extension"),
                "mime_type": img.get("mime_type"),
                "file_size": img.get("file_size"),
                "uploaded_at": img.get("uploaded_at")
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
            "complaint_id": doc.get("complaint_id"),
            "title": doc.get("title"),
            "category": doc.get("category", doc.get("department", "General")),
            "department": doc.get("department"),
            "assigned_department": doc.get("assigned_department", "Unassigned"),
            "description": doc.get("description"),
            "location": doc.get("location"),
            "landmark": doc.get("landmark"),
            "coordinates": doc.get("coordinates"),
            "status": doc.get("status"),
            "images": safe_images,
            "status_history": history,
            "created_at": doc.get("created_at").isoformat() if isinstance(doc.get("created_at"), datetime) else str(doc.get("created_at")),
            "updated_at": doc.get("updated_at").isoformat() if isinstance(doc.get("updated_at"), datetime) else str(doc.get("updated_at"))
        })

    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@complaints_bp.route("/complaints/<complaint_id>/images/<stored_filename>", methods=["GET"])
@login_required
def download_complaint_image(complaint_id, stored_filename):
    """
    Secure endpoint for retrieving attached complaint photos.
    Verifies authentication, ownership, and guards against path traversal.
    """
    try:
        if stored_filename != os.path.basename(stored_filename):
            return error_response(code="INVALID_FILENAME", message="Invalid image identifier.", status_code=400)

        cmps_col = get_collection("complaints")
        doc = cmps_col.find_one({"complaint_id": complaint_id})
        if not doc:
            return error_response(code="COMPLAINT_NOT_FOUND", message="Complaint record not found.", status_code=404)

        user_role = session.get("role")
        current_user_id = str(session.get("user_id"))

        if user_role == "citizen" and str(doc.get("user_id")) != current_user_id:
            return error_response(code="FORBIDDEN", message="You do not have permission to view this image.", status_code=403)

        matched_img = None
        for img in doc.get("images", []):
            if img.get("stored_filename") == stored_filename:
                matched_img = img
                break

        if not matched_img:
            return error_response(code="IMAGE_NOT_FOUND", message="Image is not attached to this complaint.", status_code=404)

        target_path = Config.UPLOAD_FOLDER / "complaints" / stored_filename
        if not target_path.exists():
            return error_response(code="FILE_MISSING", message="Image file not found on storage.", status_code=404)

        return send_file(
            str(target_path),
            as_attachment=False,
            download_name=matched_img.get("original_filename", stored_filename),
            mimetype=matched_img.get("mime_type", "image/jpeg")
        )

    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)
