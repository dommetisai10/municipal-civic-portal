"""Public status tracking route for municipal applications and complaints."""

import logging
from datetime import datetime
from flask import Blueprint, request
from pymongo.errors import PyMongoError

from backend.services.db import get_collection
from backend.utils.responses import success_response, error_response
from backend.utils.validators import sanitize_string

logger = logging.getLogger(__name__)

track_bp = Blueprint("track", __name__, url_prefix="/api")


@track_bp.route("/track/<record_id>", methods=["GET"])
@track_bp.route("/track", methods=["GET"])
def track_status(record_id=None):
    """
    Public tracking endpoint allowing citizens and the general public to check
    the real-time processing status of any municipal application or grievance.

    STRICT PRIVACY & CLEAN DATA RULES:
    - Zero PII leaks: No personal names, emails, phone numbers, detailed form data, or server paths.
    - Only public status metadata and official timeline transition milestones are returned.
    - Application records honestly report certificate_status: 'Issuance not supported'.
    """
    try:
        # Determine tracking identifier from route parameter or query string
        identifier = record_id or request.args.get("id") or request.args.get("q")
        if not identifier:
            return error_response(
                code="TRACKING_ID_REQUIRED",
                message="A valid tracking ID (e.g. MSP-APP-YYYY-XXXXXXXX or MSP-CMP-YYYY-XXXXXXXX) is required.",
                status_code=400
            )

        ok, clean_id = sanitize_string(identifier, field_name="Tracking ID", min_length=5, max_length=50, required=True)
        if not ok:
            return error_response(code="VALIDATION_ERROR", message=clean_id, status_code=400)

        clean_id = clean_id.upper()

        apps_col = get_collection("applications")
        cmps_col = get_collection("complaints")

        record_type = None
        doc = None

        # Determine target collection based on ID prefix or query both
        if clean_id.startswith("MSP-APP"):
            doc = apps_col.find_one({"application_id": clean_id})
            if doc:
                record_type = "Application"
        elif clean_id.startswith("MSP-CMP"):
            doc = cmps_col.find_one({"complaint_id": clean_id})
            if doc:
                record_type = "Complaint"
        else:
            # Check applications first, then complaints
            doc = apps_col.find_one({"application_id": clean_id})
            if doc:
                record_type = "Application"
            else:
                doc = cmps_col.find_one({"complaint_id": clean_id})
                if doc:
                    record_type = "Complaint"

        if not doc or not record_type:
            return error_response(
                code="RECORD_NOT_FOUND",
                message=f"No municipal application or complaint was found matching tracking ID '{clean_id}'.",
                status_code=404
            )

        # Sanitize status history timeline
        timeline = []
        for h in doc.get("status_history", []):
            timeline.append({
                "status": h.get("status", "Submitted"),
                "date": h.get("changed_at").isoformat() if isinstance(h.get("changed_at"), datetime) else str(h.get("changed_at")),
                "remarks": h.get("remarks", "")
            })

        # Format public response ensuring ZERO PII is leaked
        if record_type == "Application":
            public_data = {
                "record_id": doc.get("application_id"),
                "record_type": "Application",
                "title": doc.get("service_name", "Municipal Service"),
                "department": doc.get("category", "General"),
                "status": doc.get("status", "Submitted"),
                "certificate_status": doc.get("certificate_status", "Issuance not supported"),
                "documents_attached_count": len(doc.get("documents", [])),
                "created_at": doc.get("created_at").isoformat() if isinstance(doc.get("created_at"), datetime) else str(doc.get("created_at")),
                "updated_at": doc.get("updated_at").isoformat() if isinstance(doc.get("updated_at"), datetime) else str(doc.get("updated_at")),
                "timeline": timeline
            }
        else:
            public_data = {
                "record_id": doc.get("complaint_id"),
                "record_type": "Complaint",
                "title": doc.get("title", "Civic Grievance"),
                "department": doc.get("department", "General"),
                "status": doc.get("status", "Submitted"),
                "location": doc.get("location", ""),
                "images_attached_count": len(doc.get("images", [])),
                "created_at": doc.get("created_at").isoformat() if isinstance(doc.get("created_at"), datetime) else str(doc.get("created_at")),
                "updated_at": doc.get("updated_at").isoformat() if isinstance(doc.get("updated_at"), datetime) else str(doc.get("updated_at")),
                "timeline": timeline
            }

        return success_response(data=public_data)

    except PyMongoError as exc:
        logger.error("Database query failed during public tracking: %s", exc)
        return error_response(code="DATABASE_ERROR", message="Database connection error occurred.", fields={"details": str(exc)}, status_code=503)
    except Exception as exc:
        logger.error("Unexpected error in track_status: %s", exc)
        return error_response(code="INTERNAL_SERVER_ERROR", message=f"An unexpected error occurred: {str(exc)}", status_code=500)
