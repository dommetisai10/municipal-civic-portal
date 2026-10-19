"""Administrative dashboard aggregations and services management routes."""

import logging
from datetime import datetime, timezone
from flask import Blueprint, request, session
from pymongo.errors import PyMongoError
from bson import ObjectId

from backend.services.db import get_collection
from backend.services.audit import log_audit
from backend.middleware.auth import admin_required, csrf_protect
from backend.utils.responses import success_response, error_response
from backend.utils.validators import sanitize_string

logger = logging.getLogger(__name__)

admin_portal_bp = Blueprint("admin_portal", __name__, url_prefix="/api/admin")


@admin_portal_bp.route("/dashboard", methods=["GET"])
@admin_required
def get_admin_dashboard_metrics():
    """
    Returns live database aggregations across the entire municipality.

    STRICT CLEAN DATA RULE:
    Zero mock numbers. If the database has 0 applications or complaints, all
    counters return 0 and recent lists return empty arrays.
    """
    try:
        apps_col = get_collection("applications")
        cmps_col = get_collection("complaints")
        users_col = get_collection("users")
        services_col = get_collection("services")

        # 1. Applications breakdown by status
        app_pipeline = [
            {"$group": {"_id": "$status", "count": {"$sum": 1}}}
        ]
        app_status_counts = {
            "total": 0,
            "Submitted": 0,
            "Under Review": 0,
            "Action Required": 0,
            "Approved": 0,
            "Rejected": 0,
            "Completed": 0
        }
        for item in apps_col.aggregate(app_pipeline):
            status = item.get("_id")
            count = item.get("count", 0)
            if status in app_status_counts:
                app_status_counts[status] = count
            app_status_counts["total"] += count

        # 2. Complaints breakdown by status
        cmp_pipeline = [
            {"$group": {"_id": "$status", "count": {"$sum": 1}}}
        ]
        cmp_status_counts = {
            "total": 0,
            "Submitted": 0,
            "Under Review": 0,
            "Action Required": 0,
            "Approved": 0,
            "Rejected": 0,
            "Completed": 0
        }
        for item in cmps_col.aggregate(cmp_pipeline):
            status = item.get("_id")
            count = item.get("count", 0)
            if status in cmp_status_counts:
                cmp_status_counts[status] = count
            cmp_status_counts["total"] += count

        # 3. Overall Municipal Counts
        citizens_count = users_col.count_documents({"role": "citizen"})
        services_count = services_col.count_documents({})

        # 4. Recent Applications (Latest 5 municipality-wide)
        recent_apps_cursor = apps_col.find({}).sort("created_at", -1).limit(5)
        recent_applications = []
        for doc in recent_apps_cursor:
            recent_applications.append({
                "application_id": doc.get("application_id"),
                "service_name": doc.get("service_name", "Municipal Service"),
                "category": doc.get("category", "General"),
                "citizen_name": doc.get("user_name", "Citizen"),
                "citizen_email": doc.get("user_email", ""),
                "status": doc.get("status", "Submitted"),
                "created_at": doc.get("created_at").isoformat() if isinstance(doc.get("created_at"), datetime) else str(doc.get("created_at"))
            })

        # 5. Recent Complaints (Latest 5 municipality-wide)
        recent_cmps_cursor = cmps_col.find({}).sort("created_at", -1).limit(5)
        recent_complaints = []
        for doc in recent_cmps_cursor:
            recent_complaints.append({
                "complaint_id": doc.get("complaint_id"),
                "title": doc.get("title", ""),
                "department": doc.get("department", "General"),
                "citizen_name": doc.get("user_name", "Citizen"),
                "status": doc.get("status", "Submitted"),
                "location": doc.get("location", ""),
                "created_at": doc.get("created_at").isoformat() if isinstance(doc.get("created_at"), datetime) else str(doc.get("created_at"))
            })

        return success_response(data={
            "metrics": {
                "applications": app_status_counts,
                "complaints": cmp_status_counts,
                "citizens_count": citizens_count,
                "services_count": services_count
            },
            "recent_applications": recent_applications,
            "recent_complaints": recent_complaints
        })

    except PyMongoError as exc:
        logger.error("Admin dashboard query error: %s", exc)
        return error_response(code="DATABASE_ERROR", message="Failed to retrieve administrative metrics.", fields={"details": str(exc)}, status_code=503)
    except Exception as exc:
        logger.error("Unexpected error in admin dashboard: %s", exc)
        return error_response(code="INTERNAL_SERVER_ERROR", message=f"An error occurred: {str(exc)}", status_code=500)


@admin_portal_bp.route("/services", methods=["GET"])
@admin_required
def get_admin_services_catalog():
    """
    Returns all municipal services in the catalog along with live application counts.
    """
    try:
        services_col = get_collection("services")
        apps_col = get_collection("applications")

        # Aggregate application counts grouped by service_slug
        app_counts_by_slug = {}
        for item in apps_col.aggregate([{"$group": {"_id": "$service_slug", "count": {"$sum": 1}}}]):
            if item.get("_id"):
                app_counts_by_slug[item["_id"]] = item.get("count", 0)

        cursor = services_col.find({}).sort("name", 1)
        results = []
        for srv in cursor:
            slug = srv.get("slug", "")
            results.append({
                "slug": slug,
                "name": srv.get("name", ""),
                "category": srv.get("category", "General"),
                "description": srv.get("description", ""),
                "availability": srv.get("availability", "Unavailable"),
                "required_documents": srv.get("required_documents", []),
                "form_schema": srv.get("form_schema", []),
                "applications_count": app_counts_by_slug.get(slug, 0)
            })

        return success_response(data=results)

    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/services/<slug>/availability", methods=["PATCH"])
@admin_required
@csrf_protect
def update_service_availability(slug):
    """
    Toggles service availability between 'Active' and 'Unavailable'.
    Records an acknowledged write and an audit log event.
    """
    try:
        body = request.get_json(silent=True) or {}
        new_availability = body.get("availability", "").strip()

        if new_availability not in ["Active", "Unavailable"]:
            return error_response(
                code="INVALID_AVAILABILITY",
                message="Availability must be either 'Active' or 'Unavailable'.",
                fields={"availability": "Allowed values: 'Active', 'Unavailable'"},
                status_code=400
            )

        services_col = get_collection("services")
        service = services_col.find_one({"slug": slug})
        if not service:
            return error_response(code="SERVICE_NOT_FOUND", message=f"Service '{slug}' was not found.", status_code=404)

        old_availability = service.get("availability", "Unavailable")

        # Acknowledged update
        res = services_col.update_one(
            {"slug": slug},
            {"$set": {"availability": new_availability, "updated_at": datetime.now(timezone.utc)}}
        )
        if not res.acknowledged:
            return error_response(code="DATABASE_ERROR", message="Failed to update service availability.", status_code=500)

        # Audit log
        log_audit(
            actor_id=session.get("user_id"),
            actor_role="admin",
            action="SERVICE_AVAILABILITY_UPDATED",
            target_collection="services",
            target_id=slug,
            before_after_summary={
                "slug": slug,
                "service_name": service.get("name"),
                "before": old_availability,
                "after": new_availability
            },
            ip=request.remote_addr
        )

        return success_response(
            data={
                "slug": slug,
                "name": service.get("name"),
                "availability": new_availability,
                "message": f"Service '{service.get('name')}' is now {new_availability}."
            }
        )

    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


# ==============================================================================
# ADMINISTRATIVE APPLICATION REVIEW WORKFLOWS
# ==============================================================================

VALID_APPLICATION_STATUSES = ["Submitted", "Under Review", "Action Required", "Approved", "Rejected", "Completed"]
VALID_COMPLAINT_STATUSES = ["Submitted", "Under Review", "Action Required", "Resolved", "Rejected"]


@admin_portal_bp.route("/applications", methods=["GET"])
@admin_required
def list_admin_applications():
    """
    Lists all citizen applications with optional filtering by status and service.
    """
    try:
        apps_col = get_collection("applications")
        query = {}

        status_filter = request.args.get("status")
        if status_filter and status_filter != "ALL":
            query["status"] = status_filter

        service_filter = request.args.get("service")
        if service_filter and service_filter != "ALL":
            query["service_slug"] = service_filter

        search_q = request.args.get("q", "").strip()
        if search_q:
            query["$or"] = [
                {"application_id": {"$regex": search_q, "$options": "i"}},
                {"user_name": {"$regex": search_q, "$options": "i"}},
                {"user_email": {"$regex": search_q, "$options": "i"}},
                {"service_name": {"$regex": search_q, "$options": "i"}}
            ]

        cursor = apps_col.find(query).sort("created_at", -1)
        results = []
        for doc in cursor:
            results.append({
                "application_id": doc.get("application_id"),
                "service_name": doc.get("service_name"),
                "service_slug": doc.get("service_slug"),
                "category": doc.get("category", "General"),
                "citizen_name": doc.get("user_name"),
                "citizen_email": doc.get("user_email"),
                "status": doc.get("status", "Submitted"),
                "certificate_status": doc.get("certificate_status", "Issuance not supported"),
                "documents_count": len(doc.get("documents", [])),
                "created_at": doc.get("created_at").isoformat() if isinstance(doc.get("created_at"), datetime) else str(doc.get("created_at")),
                "updated_at": doc.get("updated_at").isoformat() if isinstance(doc.get("updated_at"), datetime) else str(doc.get("updated_at"))
            })

        return success_response(data=results)

    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/applications/<application_id>", methods=["GET"])
@admin_required
def get_admin_application_detail(application_id):
    """
    Retrieves full application details for officer review, including submitted
    form data, attached document metadata, and historical status log.
    """
    try:
        apps_col = get_collection("applications")
        doc = apps_col.find_one({"application_id": application_id})
        if not doc:
            return error_response(code="APPLICATION_NOT_FOUND", message="Application record not found.", status_code=404)

        documents = []
        for d in doc.get("documents", []):
            documents.append({
                "original_filename": d.get("original_filename"),
                "stored_filename": d.get("stored_filename"),
                "extension": d.get("extension"),
                "mime_type": d.get("mime_type"),
                "file_size": d.get("file_size"),
                "download_url": f"/api/applications/{application_id}/documents/{d.get('stored_filename')}",
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
            "citizen_name": doc.get("user_name"),
            "citizen_email": doc.get("user_email"),
            "service_name": doc.get("service_name"),
            "service_slug": doc.get("service_slug"),
            "category": doc.get("category"),
            "status": doc.get("status"),
            "certificate_status": doc.get("certificate_status", "Issuance not supported"),
            "form_data": doc.get("form_data", {}),
            "documents": documents,
            "status_history": history,
            "created_at": doc.get("created_at").isoformat() if isinstance(doc.get("created_at"), datetime) else str(doc.get("created_at")),
            "updated_at": doc.get("updated_at").isoformat() if isinstance(doc.get("updated_at"), datetime) else str(doc.get("updated_at"))
        })

    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/applications/<application_id>/status", methods=["PATCH"])
@admin_required
@csrf_protect
def update_application_status(application_id):
    """
    Updates the workflow status of an application with mandatory officer remarks.
    Dispatches a citizen notification and writes to the audit log.
    """
    try:
        body = request.get_json(silent=True) or {}
        new_status = body.get("status", "").strip()
        remarks = body.get("remarks", "").strip()

        if new_status not in VALID_APPLICATION_STATUSES:
            return error_response(
                code="INVALID_STATUS",
                message=f"Status must be one of {VALID_APPLICATION_STATUSES}.",
                fields={"status": f"Allowed: {VALID_APPLICATION_STATUSES}"},
                status_code=400
            )

        if not remarks or len(remarks) < 5:
            return error_response(
                code="REMARKS_REQUIRED",
                message="Administrative decision remarks are required (minimum 5 characters).",
                fields={"remarks": "Must be at least 5 characters."},
                status_code=400
            )

        apps_col = get_collection("applications")
        doc = apps_col.find_one({"application_id": application_id})
        if not doc:
            return error_response(code="APPLICATION_NOT_FOUND", message="Application record not found.", status_code=404)

        old_status = doc.get("status", "Submitted")
        now = datetime.now(timezone.utc)

        history_entry = {
            "status": new_status,
            "changed_at": now,
            "changed_by": str(session["user_id"]),
            "role": "admin",
            "remarks": remarks
        }

        # Acknowledged update
        res = apps_col.update_one(
            {"application_id": application_id},
            {
                "$set": {"status": new_status, "updated_at": now},
                "$push": {"status_history": history_entry}
            }
        )
        if not res.acknowledged:
            return error_response(code="DATABASE_ERROR", message="Failed to persist status change.", status_code=500)

        # Notify Citizen
        notif_col = get_collection("notifications")
        notif_col.insert_one({
            "user_id": doc["user_id"],
            "title": f"Application {new_status}",
            "message": f"Your application {application_id} for '{doc.get('service_name')}' status is now '{new_status}'. Officer remarks: {remarks}",
            "link": "/user-dashboard.html",
            "is_read": False,
            "created_at": now
        })

        # Audit Log
        log_audit(
            actor_id=session.get("user_id"),
            actor_role="admin",
            action="APPLICATION_STATUS_UPDATED",
            target_collection="applications",
            target_id=application_id,
            before_after_summary={
                "application_id": application_id,
                "before_status": old_status,
                "after_status": new_status,
                "remarks": remarks
            },
            ip=request.remote_addr
        )

        return success_response(
            data={
                "application_id": application_id,
                "status": new_status,
                "remarks": remarks,
                "updated_at": now.isoformat(),
                "message": f"Application {application_id} status updated to {new_status}."
            }
        )

    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


# ==============================================================================
# ADMINISTRATIVE GRIEVANCE / COMPLAINT REVIEW WORKFLOWS
# ==============================================================================

@admin_portal_bp.route("/complaints", methods=["GET"])
@admin_required
def list_admin_complaints():
    """
    Lists all citizen grievances with optional department and status filtering.
    """
    try:
        cmps_col = get_collection("complaints")
        query = {}

        status_filter = request.args.get("status")
        if status_filter and status_filter != "ALL":
            query["status"] = status_filter

        dept_filter = request.args.get("department")
        if dept_filter and dept_filter != "ALL":
            query["department"] = dept_filter

        search_q = request.args.get("q", "").strip()
        if search_q:
            query["$or"] = [
                {"complaint_id": {"$regex": search_q, "$options": "i"}},
                {"title": {"$regex": search_q, "$options": "i"}},
                {"user_name": {"$regex": search_q, "$options": "i"}},
                {"location": {"$regex": search_q, "$options": "i"}}
            ]

        cursor = cmps_col.find(query).sort("created_at", -1)
        results = []
        for doc in cursor:
            results.append({
                "complaint_id": doc.get("complaint_id"),
                "department": doc.get("department"),
                "title": doc.get("title"),
                "citizen_name": doc.get("user_name"),
                "location": doc.get("location"),
                "status": doc.get("status", "Submitted"),
                "images_count": len(doc.get("images", [])),
                "created_at": doc.get("created_at").isoformat() if isinstance(doc.get("created_at"), datetime) else str(doc.get("created_at")),
                "updated_at": doc.get("updated_at").isoformat() if isinstance(doc.get("updated_at"), datetime) else str(doc.get("updated_at"))
            })

        return success_response(data=results)

    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/complaints/<complaint_id>", methods=["GET"])
@admin_required
def get_admin_complaint_detail(complaint_id):
    """
    Retrieves full grievance details, photos, coordinates, and status history for review.
    """
    try:
        cmps_col = get_collection("complaints")
        doc = cmps_col.find_one({"complaint_id": complaint_id})
        if not doc:
            return error_response(code="COMPLAINT_NOT_FOUND", message="Complaint record not found.", status_code=404)

        images = []
        for img in doc.get("images", []):
            images.append({
                "original_filename": img.get("original_filename"),
                "stored_filename": img.get("stored_filename"),
                "extension": img.get("extension"),
                "mime_type": img.get("mime_type"),
                "file_size": img.get("file_size"),
                "download_url": f"/api/complaints/{complaint_id}/images/{img.get('stored_filename')}",
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
            "citizen_name": doc.get("user_name"),
            "citizen_email": doc.get("user_email"),
            "title": doc.get("title"),
            "department": doc.get("department"),
            "description": doc.get("description"),
            "location": doc.get("location"),
            "coordinates": doc.get("coordinates"),
            "status": doc.get("status"),
            "images": images,
            "status_history": history,
            "created_at": doc.get("created_at").isoformat() if isinstance(doc.get("created_at"), datetime) else str(doc.get("created_at")),
            "updated_at": doc.get("updated_at").isoformat() if isinstance(doc.get("updated_at"), datetime) else str(doc.get("updated_at"))
        })

    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/complaints/<complaint_id>/status", methods=["PATCH"])
@admin_required
@csrf_protect
def update_complaint_status(complaint_id):
    """
    Updates the resolution status of a civic grievance with officer remarks.
    Dispatches a citizen notification and records an audit log.
    """
    try:
        body = request.get_json(silent=True) or {}
        new_status = body.get("status", "").strip()
        remarks = body.get("remarks", "").strip()

        if new_status not in VALID_COMPLAINT_STATUSES:
            return error_response(
                code="INVALID_STATUS",
                message=f"Status must be one of {VALID_COMPLAINT_STATUSES}.",
                fields={"status": f"Allowed: {VALID_COMPLAINT_STATUSES}"},
                status_code=400
            )

        if not remarks or len(remarks) < 5:
            return error_response(
                code="REMARKS_REQUIRED",
                message="Resolution remarks are required (minimum 5 characters).",
                fields={"remarks": "Must be at least 5 characters."},
                status_code=400
            )

        cmps_col = get_collection("complaints")
        doc = cmps_col.find_one({"complaint_id": complaint_id})
        if not doc:
            return error_response(code="COMPLAINT_NOT_FOUND", message="Complaint record not found.", status_code=404)

        old_status = doc.get("status", "Submitted")
        now = datetime.now(timezone.utc)

        history_entry = {
            "status": new_status,
            "changed_at": now,
            "changed_by": str(session["user_id"]),
            "role": "admin",
            "remarks": remarks
        }

        # Acknowledged update
        res = cmps_col.update_one(
            {"complaint_id": complaint_id},
            {
                "$set": {"status": new_status, "updated_at": now},
                "$push": {"status_history": history_entry}
            }
        )
        if not res.acknowledged:
            return error_response(code="DATABASE_ERROR", message="Failed to persist status change.", status_code=500)

        # Notify Citizen
        notif_col = get_collection("notifications")
        notif_col.insert_one({
            "user_id": doc["user_id"],
            "title": f"Grievance {new_status}",
            "message": f"Your complaint {complaint_id} ({doc.get('department')}) status has been updated to '{new_status}'. Remarks: {remarks}",
            "link": "/user-dashboard.html",
            "is_read": False,
            "created_at": now
        })

        # Audit Log
        log_audit(
            actor_id=session.get("user_id"),
            actor_role="admin",
            action="COMPLAINT_STATUS_UPDATED",
            target_collection="complaints",
            target_id=complaint_id,
            before_after_summary={
                "complaint_id": complaint_id,
                "before_status": old_status,
                "after_status": new_status,
                "remarks": remarks
            },
            ip=request.remote_addr
        )

        return success_response(
            data={
                "complaint_id": complaint_id,
                "status": new_status,
                "remarks": remarks,
                "updated_at": now.isoformat(),
                "message": f"Grievance {complaint_id} status updated to {new_status}."
            }
        )

    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


# ==============================================================================
# ADMINISTRATIVE AUDIT LOG & COMPLIANCE INSPECTION
# ==============================================================================

@admin_portal_bp.route("/audit-logs", methods=["GET"])
@admin_required
def list_admin_audit_logs():
    """
    Retrieves paginated audit log entries with granular filtering.
    Supported filters:
    - action: exact action string
    - actor_role: admin, citizen, system
    - target_collection: applications, complaints, services, users
    - start_date: ISO / YYYY-MM-DD
    - end_date: ISO / YYYY-MM-DD
    - q: search term matching action, target_id, actor_id, or IP
    - page: page number (default 1)
    - limit: items per page (default 20, max 100)
    """
    try:
        audit_col = get_collection("audit_logs")
        query = {}

        # Filter: Action
        action_filter = request.args.get("action", "").strip()
        if action_filter and action_filter != "ALL":
            query["action"] = action_filter

        # Filter: Actor Role
        actor_role_filter = request.args.get("actor_role", "").strip()
        if actor_role_filter and actor_role_filter != "ALL":
            query["actor_role"] = actor_role_filter

        # Filter: Target Collection
        target_col_filter = request.args.get("target_collection", "").strip()
        if target_col_filter and target_col_filter != "ALL":
            query["target_collection"] = target_col_filter

        # Filter: Date Range
        start_date_str = request.args.get("start_date", "").strip()
        end_date_str = request.args.get("end_date", "").strip()
        date_query = {}
        if start_date_str:
            try:
                if len(start_date_str) == 10:
                    start_dt = datetime.strptime(start_date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
                else:
                    start_dt = datetime.fromisoformat(start_date_str)
                    if start_dt.tzinfo is None:
                        start_dt = start_dt.replace(tzinfo=timezone.utc)
                date_query["$gte"] = start_dt
            except ValueError:
                pass

        if end_date_str:
            try:
                if len(end_date_str) == 10:
                    end_dt = datetime.strptime(end_date_str, "%Y-%m-%d").replace(
                        hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc
                    )
                else:
                    end_dt = datetime.fromisoformat(end_date_str)
                    if end_dt.tzinfo is None:
                        end_dt = end_dt.replace(tzinfo=timezone.utc)
                date_query["$lte"] = end_dt
            except ValueError:
                pass

        if date_query:
            query["created_at"] = date_query

        # Filter: Keyword Search (q)
        search_q = request.args.get("q", "").strip()
        if search_q:
            query["$or"] = [
                {"action": {"$regex": search_q, "$options": "i"}},
                {"target_id": {"$regex": search_q, "$options": "i"}},
                {"actor_id": {"$regex": search_q, "$options": "i"}},
                {"ip": {"$regex": search_q, "$options": "i"}}
            ]

        # Total matching records count
        total_records = audit_col.count_documents(query)

        # Pagination calculations
        try:
            page = max(1, int(request.args.get("page", 1)))
        except (ValueError, TypeError):
            page = 1

        try:
            limit = min(100, max(1, int(request.args.get("limit", 20))))
        except (ValueError, TypeError):
            limit = 20

        total_pages = max(1, (total_records + limit - 1) // limit) if total_records > 0 else 1
        skip = (page - 1) * limit

        cursor = audit_col.find(query).sort("created_at", -1).skip(skip).limit(limit)

        logs = []
        for doc in cursor:
            created_at_val = doc.get("created_at")
            if isinstance(created_at_val, datetime):
                created_at_str = created_at_val.isoformat()
            else:
                created_at_str = str(created_at_val or "")

            logs.append({
                "id": str(doc.get("_id")),
                "actor_id": doc.get("actor_id"),
                "actor_role": doc.get("actor_role"),
                "action": doc.get("action"),
                "target_collection": doc.get("target_collection"),
                "target_id": doc.get("target_id"),
                "before_after_summary": doc.get("before_after_summary") or {},
                "ip": doc.get("ip"),
                "created_at": created_at_str
            })

        # Distinct filter options for dashboard dropdowns
        distinct_actions = sorted(audit_col.distinct("action"))
        distinct_collections = sorted(audit_col.distinct("target_collection"))
        distinct_roles = sorted(audit_col.distinct("actor_role"))

        return success_response(data={
            "logs": logs,
            "pagination": {
                "page": page,
                "limit": limit,
                "total_records": total_records,
                "total_pages": total_pages
            },
            "filter_options": {
                "actions": distinct_actions,
                "target_collections": distinct_collections,
                "actor_roles": distinct_roles
            }
        })

    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/audit-logs/<log_id>", methods=["GET"])
@admin_required
def get_admin_audit_log_detail(log_id):
    """
    Retrieves full audit entry details by MongoDB ObjectId.
    """
    try:
        audit_col = get_collection("audit_logs")
        try:
            obj_id = ObjectId(log_id)
        except Exception:
            return error_response(code="INVALID_ID", message="Invalid audit log ID format.", status_code=400)

        doc = audit_col.find_one({"_id": obj_id})
        if not doc:
            return error_response(code="LOG_NOT_FOUND", message="Audit record not found.", status_code=404)

        created_at_val = doc.get("created_at")
        created_at_str = created_at_val.isoformat() if isinstance(created_at_val, datetime) else str(created_at_val or "")

        return success_response(data={
            "id": str(doc.get("_id")),
            "actor_id": doc.get("actor_id"),
            "actor_role": doc.get("actor_role"),
            "action": doc.get("action"),
            "target_collection": doc.get("target_collection"),
            "target_id": doc.get("target_id"),
            "before_after_summary": doc.get("before_after_summary") or {},
            "ip": doc.get("ip"),
            "created_at": created_at_str
        })

    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


