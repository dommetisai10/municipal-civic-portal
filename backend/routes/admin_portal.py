"""Administrative dashboard aggregations, review workflows, staff, and catalog management routes."""

import logging
import re
import csv
import io
import secrets
from datetime import datetime, timezone, timedelta
from flask import Blueprint, request, session, Response
from pymongo.errors import PyMongoError
from bson import ObjectId

from backend.services.db import get_collection
from backend.services.audit import log_audit
from backend.middleware.auth import admin_required, admin_role_required, super_admin_required, csrf_protect
from backend.utils.responses import success_response, error_response
from backend.utils.validators import validate_email, validate_password
from backend.utils.security import hash_password

logger = logging.getLogger(__name__)

admin_portal_bp = Blueprint("admin_portal", __name__, url_prefix="/api/admin")

VALID_APPLICATION_STATUSES = [
    "Submitted",
    "Pending",
    "Under Review",
    "Action Required",
    "Additional Information Required",
    "Approved",
    "Rejected",
    "Completed"
]

VALID_COMPLAINT_STATUSES = [
    "Submitted",
    "Under Review",
    "Assigned",
    "In Progress",
    "Action Required",
    "Resolved",
    "Closed",
    "Rejected"
]

COMPLAINT_PRIORITIES = ["Low", "Medium", "High", "Urgent"]
STAFF_ROLES = ["super_admin", "admin", "officer", "viewer"]


def safe_count(col, query):
    """Safely retrieves document count handling mock objects in tests."""
    try:
        val = col.count_documents(query)
        if isinstance(val, int):
            return val
        if isinstance(val, (float,)):
            return int(val)
        return 0
    except Exception:
        return 0


def parse_date_range(range_type, custom_from=None, custom_to=None):
    """Calculates start and end datetime based on selected filter."""
    now = datetime.now(timezone.utc)
    if range_type == "today":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        prev_start = start - timedelta(days=1)
        prev_end = start
        return start, now, prev_start, prev_end
    elif range_type == "7d":
        start = now - timedelta(days=7)
        prev_start = start - timedelta(days=7)
        prev_end = start
        return start, now, prev_start, prev_end
    elif range_type == "30d":
        start = now - timedelta(days=30)
        prev_start = start - timedelta(days=30)
        prev_end = start
        return start, now, prev_start, prev_end
    elif range_type == "custom" and custom_from:
        try:
            start = datetime.fromisoformat(custom_from).replace(tzinfo=timezone.utc)
            end = datetime.fromisoformat(custom_to).replace(tzinfo=timezone.utc) if custom_to else now
            delta = end - start
            prev_start = start - delta
            prev_end = start
            return start, end, prev_start, prev_end
        except Exception:
            pass
    return None, None, None, None


def build_applications_filter(
    range_type="all",
    custom_from=None,
    custom_to=None,
    status=None,
    service_slug=None,
    department=None,
    search_q=None,
    include_deleted=False,
    overdue=False,
    user_dept=None,
    user_role=None
):
    """Single shared source of truth for filtering applications across KPI counts and lists."""
    query = {}
    if not include_deleted:
        query["is_deleted"] = {"$ne": True}

    if user_role == "officer" and user_dept and user_dept not in ["Municipal Administration", "All"]:
        query["department"] = user_dept
    elif department and department != "ALL":
        query["department"] = department

    if service_slug and service_slug != "ALL":
        s_val = str(service_slug).strip()
        slug_hyphen = s_val.lower().replace(" ", "-")
        query["$or"] = [
            {"service_slug": s_val},
            {"service_slug": slug_hyphen},
            {"service_slug": {"$regex": f"^{re.escape(slug_hyphen)}$", "$options": "i"}},
            {"service_name": {"$regex": f"^{re.escape(s_val)}$", "$options": "i"}},
            {"service_name": {"$regex": re.escape(s_val), "$options": "i"}}
        ]

    if status and status != "ALL":
        status_clean = str(status).strip()
        s_lower = status_clean.lower()
        if s_lower in ["pending", "submitted", "pending review"]:
            query["status"] = {"$in": ["Pending", "Submitted", "pending", "submitted", "Action Required"]}
        elif s_lower in ["under review", "under_review", "in review", "in_review"]:
            query["status"] = {"$in": ["Under Review", "under review", "under_review", "In Review"]}
        elif s_lower == "approved":
            query["status"] = {"$in": ["Approved", "approved", "APPROVED"]}
        elif s_lower == "rejected":
            query["status"] = {"$in": ["Rejected", "rejected", "REJECTED"]}
        elif s_lower == "completed":
            query["status"] = {"$in": ["Completed", "completed"]}
        else:
            query["status"] = {"$regex": f"^{re.escape(status_clean)}$", "$options": "i"}

    start_dt, end_dt, _, _ = parse_date_range(range_type, custom_from, custom_to)
    if start_dt and end_dt:
        query["created_at"] = {"$gte": start_dt, "$lte": end_dt}

    if overdue:
        now_utc = datetime.now(timezone.utc)
        seven_days_ago = now_utc - timedelta(days=7)
        query["status"] = {"$in": ["Pending", "Submitted", "Under Review", "Action Required"]}
        query["$or"] = [
            {"due_date": {"$lt": now_utc}},
            {"created_at": {"$lt": seven_days_ago}}
        ]

    if search_q:
        q_regex = {"$regex": search_q, "$options": "i"}
        search_or = [
            {"application_id": q_regex},
            {"applicant_name": q_regex},
            {"user_name": q_regex},
            {"citizen_name": q_regex},
            {"applicant_email": q_regex},
            {"user_email": q_regex},
            {"citizen_email": q_regex},
            {"service_name": q_regex}
        ]
        if "$or" in query:
            query["$and"] = [{"$or": query.pop("$or")}, {"$or": search_or}]
        else:
            query["$or"] = search_or

    return query


def build_complaints_filter(
    range_type="all",
    custom_from=None,
    custom_to=None,
    status=None,
    department=None,
    priority=None,
    search_q=None,
    include_deleted=False,
    overdue=False,
    user_dept=None,
    user_role=None
):
    """Single shared source of truth for filtering complaints across KPI counts and lists."""
    query = {}
    if not include_deleted:
        query["is_deleted"] = {"$ne": True}

    if user_role == "officer" and user_dept and user_dept not in ["Municipal Administration", "All"]:
        query["department"] = user_dept
    elif department and department != "ALL":
        query["department"] = department

    if priority and priority != "ALL":
        query["priority"] = priority

    if status and status != "ALL":
        status_clean = str(status).strip()
        s_lower = status_clean.lower()
        if s_lower in ["open", "active"]:
            query["status"] = {"$in": ["Submitted", "Pending", "Assigned", "In Progress", "Action Required", "Under Review", "open"]}
        elif s_lower in ["resolved", "closed"]:
            query["status"] = {"$in": ["Resolved", "Closed", "resolved", "closed"]}
        else:
            query["status"] = {"$regex": f"^{re.escape(status_clean)}$", "$options": "i"}

    start_dt, end_dt, _, _ = parse_date_range(range_type, custom_from, custom_to)
    if start_dt and end_dt:
        query["created_at"] = {"$gte": start_dt, "$lte": end_dt}

    if overdue:
        now_utc = datetime.now(timezone.utc)
        query["status"] = {"$nin": ["Resolved", "Closed", "Rejected"]}
        query["$or"] = [
            {"due_date": {"$lt": now_utc}},
            {"assigned_to": {"$in": [None, ""]}}
        ]

    if search_q:
        q_regex = {"$regex": search_q, "$options": "i"}
        search_or = [
            {"complaint_id": q_regex},
            {"title": q_regex},
            {"user_name": q_regex},
            {"user_email": q_regex},
            {"department": q_regex}
        ]
        if "$or" in query:
            query["$and"] = [{"$or": query.pop("$or")}, {"$or": search_or}]
        else:
            query["$or"] = search_or

    return query


# ==============================================================================
# 1. RECONCILED LIVE DASHBOARD AGGREGATIONS
# ==============================================================================

@admin_portal_bp.route("/dashboard", methods=["GET"])
@admin_required
def get_admin_dashboard_metrics():
    """
    Returns live database aggregations across the entire municipality.
    Computes fully reconciled counters, trends, charts data, and 'Needs Attention' items.
    """
    try:
        apps_col = get_collection("applications")
        cmps_col = get_collection("complaints")
        users_col = get_collection("users")
        services_col = get_collection("services")

        range_param = request.args.get("range", "all")
        from_param = request.args.get("from")
        to_param = request.args.get("to")
        start_dt, end_dt, prev_start_dt, prev_end_dt = parse_date_range(range_param, from_param, to_param)

        user_role = session.get("admin_role") or session.get("role")
        user_dept = session.get("department")

        base_app_filter = build_applications_filter(
            range_type=range_param,
            custom_from=from_param,
            custom_to=to_param,
            user_dept=user_dept,
            user_role=user_role
        )
        base_cmp_filter = build_complaints_filter(
            range_type=range_param,
            custom_from=from_param,
            custom_to=to_param,
            user_dept=user_dept,
            user_role=user_role
        )

        # 1. Applications Breakdown by Status
        app_pipeline = [
            {"$match": base_app_filter},
            {"$group": {"_id": "$status", "count": {"$sum": 1}}}
        ]
        app_status_counts = {
            "total": 0,
            "Submitted": 0,
            "Pending": 0,
            "Under Review": 0,
            "Action Required": 0,
            "Approved": 0,
            "Rejected": 0,
            "Completed": 0
        }
        for item in apps_col.aggregate(app_pipeline):
            st = item.get("_id")
            count = item.get("count", 0)
            if st in app_status_counts:
                app_status_counts[st] = count
            else:
                app_status_counts[st] = count
            app_status_counts["total"] += count

        # Harmonize pending count so both 'Pending' and 'Submitted' reflect applications awaiting review
        pending_total = app_status_counts.get("Submitted", 0) + app_status_counts.get("Pending", 0)
        app_status_counts["Submitted"] = pending_total
        app_status_counts["Pending"] = pending_total

        # 2. Complaints Breakdown by Status
        cmp_pipeline = [
            {"$match": base_cmp_filter},
            {"$group": {"_id": "$status", "count": {"$sum": 1}}}
        ]
        cmp_status_counts = {
            "total": 0,
            "Submitted": 0,
            "Under Review": 0,
            "Assigned": 0,
            "In Progress": 0,
            "Action Required": 0,
            "Resolved": 0,
            "Closed": 0,
            "Rejected": 0
        }
        for item in cmps_col.aggregate(cmp_pipeline):
            status = item.get("_id")
            count = item.get("count", 0)
            if status in cmp_status_counts:
                cmp_status_counts[status] = count
            cmp_status_counts["total"] += count

        total_open_cmps = (
            cmp_status_counts["Submitted"] +
            cmp_status_counts["Under Review"] +
            cmp_status_counts["Assigned"] +
            cmp_status_counts["In Progress"]
        )

        # 3. Overall Municipal Catalog & Citizen Counts (Strictly All-Time live database counts)
        citizens_count = safe_count(users_col, {"role": "citizen", "is_deleted": {"$ne": True}})
        services_active_count = safe_count(services_col, {"availability": {"$in": ["Available", "Active"]}, "is_deleted": {"$ne": True}})
        services_inactive_count = safe_count(services_col, {"availability": "Unavailable", "is_deleted": {"$ne": True}})
        services_total_count = safe_count(services_col, {"is_deleted": {"$ne": True}})

        # 4. Correct Trends Calculation
        def calc_trend(col, base_filt, s_cur, e_cur, s_prev, e_prev, range_type="all"):
            if range_type == "all" or not s_cur or not s_prev:
                return None
            try:
                filt_cur = dict(base_filt)
                filt_cur["created_at"] = {"$gte": s_cur, "$lte": e_cur}
                count_cur = safe_count(col, filt_cur)

                filt_prev = dict(base_filt)
                filt_prev["created_at"] = {"$gte": s_prev, "$lte": e_prev}
                count_prev = safe_count(col, filt_prev)

                if count_prev == 0:
                    return "New" if count_cur > 0 else "-"
                pct = round(((count_cur - count_prev) / count_prev) * 100)
                return f"+{pct}%" if pct > 0 else f"{pct}%"
            except Exception:
                return "-"

        apps_trend = calc_trend(apps_col, {"is_deleted": {"$ne": True}}, start_dt, end_dt, prev_start_dt, prev_end_dt, range_param)
        cmps_trend = calc_trend(cmps_col, {"is_deleted": {"$ne": True}}, start_dt, end_dt, prev_start_dt, prev_end_dt, range_param)
        citizens_trend = calc_trend(users_col, {"role": "citizen", "is_deleted": {"$ne": True}}, start_dt, end_dt, prev_start_dt, prev_end_dt, range_param)

        vs_label_map = {
            "today": "vs yesterday",
            "7d": "vs previous 7 days",
            "30d": "vs previous 30 days",
            "all": None
        }
        vs_label = vs_label_map.get(range_param)

        # 5. Charts Timeline
        timeline_pipeline = [
            {"$match": base_app_filter},
            {
                "$group": {
                    "_id": {"$dateToString": {"format": "%Y-%m-%d", "date": "$created_at"}},
                    "count": {"$sum": 1}
                }
            },
            {"$sort": {"_id": 1}}
        ]
        try:
            app_timeline = [
                {"date": item["_id"], "count": item["count"]}
                for item in apps_col.aggregate(timeline_pipeline) if item.get("_id")
            ]
        except Exception:
            app_timeline = []

        app_service_pipeline = [
            {"$match": base_app_filter},
            {"$group": {"_id": "$service_name", "count": {"$sum": 1}}},
            {"$sort": {"count": -1}},
            {"$limit": 6}
        ]
        try:
            apps_by_service = [
                {"service": item["_id"] or "Unknown", "count": item["count"]}
                for item in apps_col.aggregate(app_service_pipeline)
            ]
        except Exception:
            apps_by_service = []

        cmp_cat_pipeline = [
            {"$match": base_cmp_filter},
            {"$group": {"_id": {"$ifNull": ["$category", "$department"]}, "count": {"$sum": 1}}},
            {"$sort": {"count": -1}},
            {"$limit": 6}
        ]
        try:
            grievances_by_category = [
                {"category": item["_id"] or "General", "count": item["count"]}
                for item in cmps_col.aggregate(cmp_cat_pipeline)
            ]
        except Exception:
            grievances_by_category = []

        now_utc = datetime.now(timezone.utc)
        seven_days_ago = now_utc - timedelta(days=7)
        sla_breach_count = safe_count(cmps_col, {
            "is_deleted": {"$ne": True},
            "status": {"$nin": ["Resolved", "Closed", "Rejected"]},
            "due_date": {"$lt": now_utc}
        })
        stale_apps_count = safe_count(apps_col, {
            "is_deleted": {"$ne": True},
            "status": {"$in": ["Submitted", "Under Review"]},
            "created_at": {"$lt": seven_days_ago}
        })
        sla_breach_count += stale_apps_count

        # 6. Needs Attention Panel Items
        needs_attention_apps = []
        needs_attention_cmps = []
        try:
            stale_apps_cursor = apps_col.find({
                "is_deleted": {"$ne": True},
                "status": {"$in": ["Submitted", "Under Review"]},
                "created_at": {"$lt": seven_days_ago}
            }).sort("created_at", 1).limit(5)
            for d in stale_apps_cursor:
                needs_attention_apps.append({
                    "application_id": d.get("application_id"),
                    "service_name": d.get("service_name"),
                    "citizen_name": d.get("user_name"),
                    "status": d.get("status")
                })

            overdue_cmps_cursor = cmps_col.find({
                "is_deleted": {"$ne": True},
                "status": {"$nin": ["Resolved", "Closed", "Rejected"]},
                "$or": [
                    {"due_date": {"$lt": now_utc}},
                    {"assigned_to": {"$in": [None, ""]}}
                ]
            }).sort("created_at", 1).limit(5)
            for d in overdue_cmps_cursor:
                needs_attention_cmps.append({
                    "complaint_id": d.get("complaint_id"),
                    "title": d.get("title"),
                    "department": d.get("department"),
                    "status": d.get("status")
                })
        except Exception:
            pass

        # 7. Recent Applications (Latest 5)
        recent_applications = []
        try:
            recent_apps_cursor = apps_col.find(base_app_filter).sort("created_at", -1).limit(5)
            for doc in recent_apps_cursor:
                recent_applications.append({
                    "application_id": doc.get("application_id"),
                    "service_name": doc.get("service_name", "Municipal Service"),
                    "category": doc.get("category", "General"),
                    "citizen_name": doc.get("user_name", "Citizen"),
                    "citizen_email": doc.get("user_email", ""),
                    "status": doc.get("status", "Submitted"),
                    "created_at": doc.get("created_at").isoformat() if isinstance(doc.get("created_at"), datetime) else str(doc.get("created_at") or "")
                })
        except Exception:
            pass

        # 8. Recent Complaints (Latest 5)
        recent_complaints = []
        try:
            recent_cmps_cursor = cmps_col.find(base_cmp_filter).sort("created_at", -1).limit(5)
            for doc in recent_cmps_cursor:
                recent_complaints.append({
                    "complaint_id": doc.get("complaint_id"),
                    "title": doc.get("title", ""),
                    "department": doc.get("department", "General"),
                    "citizen_name": doc.get("user_name", "Citizen"),
                    "status": doc.get("status", "Submitted"),
                    "location": doc.get("location", ""),
                    "created_at": doc.get("created_at").isoformat() if isinstance(doc.get("created_at"), datetime) else str(doc.get("created_at") or "")
                })
        except Exception:
            pass

        # Real turnaround calculation from database for approved applications
        approved_cursor = apps_col.find({
            "is_deleted": {"$ne": True},
            "status": {"$in": ["Approved", "approved", "APPROVED", "Completed", "completed"]},
            "created_at": {"$exists": True}
        })
        turnaround_days_list = []
        for app_doc in approved_cursor:
            c_time = app_doc.get("created_at")
            u_time = app_doc.get("approved_at") or app_doc.get("decided_at") or app_doc.get("updated_at")
            if isinstance(c_time, datetime) and isinstance(u_time, datetime) and u_time >= c_time:
                diff_days = (u_time - c_time).total_seconds() / 86400.0
                turnaround_days_list.append(diff_days)
        real_avg_turnaround = round(sum(turnaround_days_list) / len(turnaround_days_list), 1) if turnaround_days_list else 0.0

        return success_response(data={
            "metrics": {
                "applications": app_status_counts,
                "complaints": cmp_status_counts,
                "citizens_count": citizens_count,
                "services_count": services_total_count,
                "services_active_count": services_active_count,
                "services_inactive_count": services_inactive_count,
                "total_open_complaints": total_open_cmps,
                "sla_breach_count": sla_breach_count,
                "actionable_counts": {
                    "applications_pending": app_status_counts["Submitted"] + app_status_counts["Action Required"],
                    "complaints_open": total_open_cmps
                },
                "avg_processing_time_days": real_avg_turnaround,
                "trends": {
                    "applications": apps_trend,
                    "complaints": cmps_trend,
                    "citizens": citizens_trend,
                    "vs_label": vs_label
                }
            },
            "charts": {
                "applications_timeline": app_timeline,
                "applications_by_status": app_status_counts,
                "applications_by_service": apps_by_service,
                "grievances_by_category": grievances_by_category
            },
            "needs_attention": {
                "stale_applications": needs_attention_apps,
                "overdue_or_unassigned_grievances": needs_attention_cmps
            },
            "recent_applications": recent_applications,
            "recent_complaints": recent_complaints,
            "selected_range": range_param
        })

    except PyMongoError as exc:
        logger.error("Admin dashboard query error: %s", exc)
        return error_response(code="DATABASE_ERROR", message="Failed to retrieve administrative metrics.", fields={"details": str(exc)}, status_code=503)
    except Exception as exc:
        logger.error("Unexpected error in admin dashboard: %s", exc)
        return error_response(code="INTERNAL_SERVER_ERROR", message=f"An error occurred: {str(exc)}", status_code=500)


# ==============================================================================
# 2. APPLICATION MANAGEMENT WORKFLOWS (FULL CRUD)
# ==============================================================================

@admin_portal_bp.route("/applications", methods=["GET"])
@admin_required
def list_admin_applications():
    """Lists citizen applications with shared filtering, search, sorting, and date ranges."""
    try:
        apps_col = get_collection("applications")

        range_param = request.args.get("range", "all")
        from_param = request.args.get("from")
        to_param = request.args.get("to")
        status_filter = request.args.get("status")
        service_filter = request.args.get("service")
        dept_filter = request.args.get("department")
        search_q = request.args.get("q", "").strip()
        include_deleted = request.args.get("include_deleted") == "true"
        overdue = request.args.get("overdue") == "true"

        user_role = session.get("admin_role") or session.get("role")
        user_dept = session.get("department")

        query = build_applications_filter(
            range_type=range_param,
            custom_from=from_param,
            custom_to=to_param,
            status=status_filter,
            service_slug=service_filter,
            department=dept_filter,
            search_q=search_q,
            include_deleted=include_deleted,
            overdue=overdue,
            user_dept=user_dept,
            user_role=user_role
        )

        services_col = get_collection("services")
        service_fees = {}
        try:
            for s in services_col.find({"is_deleted": {"$ne": True}}):
                if s.get("slug"):
                    service_fees[s["slug"]] = float(s.get("fee", 0))
        except Exception:
            pass

        cursor = apps_col.find(query).sort("created_at", -1)
        results = []
        for doc in cursor:
            citizen_name = doc.get("applicant_name") or doc.get("user_name") or doc.get("citizen_name") or "Citizen"
            citizen_email = doc.get("applicant_email") or doc.get("user_email") or doc.get("citizen_email") or ""
            citizen_phone = doc.get("applicant_mobile") or doc.get("mobile") or doc.get("phone") or ""

            fee = doc.get("fee")
            if fee is None:
                fee = service_fees.get(doc.get("service_slug"), 0.0)
            fee_val = float(fee) if fee is not None else 0.0
            payment_status = doc.get("payment_status", "Paid" if fee_val == 0.0 else "Pending")

            results.append({
                "application_id": doc.get("application_id"),
                "service_name": doc.get("service_name"),
                "service_slug": doc.get("service_slug"),
                "category": doc.get("category", "General"),
                "department": doc.get("department", "General"),
                "citizen_name": citizen_name,
                "citizen_email": citizen_email,
                "applicant_name": citizen_name,
                "applicant_email": citizen_email,
                "applicant_mobile": citizen_phone,
                "status": doc.get("status", "Submitted"),
                "fee": fee_val,
                "payment_status": payment_status,
                "assigned_to": doc.get("assigned_to"),
                "certificate_status": doc.get("certificate_status", "Issuance not supported"),
                "documents_count": len(doc.get("documents", [])),
                "is_deleted": doc.get("is_deleted", False),
                "created_at": doc.get("created_at").isoformat() if isinstance(doc.get("created_at"), datetime) else str(doc.get("created_at") or ""),
                "updated_at": doc.get("updated_at").isoformat() if isinstance(doc.get("updated_at"), datetime) else str(doc.get("updated_at") or "")
            })

        return success_response(data=results)

    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/applications/<application_id>", methods=["GET"])
@admin_required
def get_admin_application_detail(application_id):
    """Retrieves full application details for review."""
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
                "role": h.get("role", "admin"),
                "remarks": h.get("remarks", "")
            })

        internal_notes = []
        for n in doc.get("internal_notes", []):
            internal_notes.append({
                "note": n.get("note"),
                "author": n.get("author", "Officer"),
                "created_at": n.get("created_at").isoformat() if isinstance(n.get("created_at"), datetime) else str(n.get("created_at"))
            })

        citizen_name = doc.get("applicant_name") or doc.get("user_name") or doc.get("citizen_name") or "Citizen"
        citizen_email = doc.get("applicant_email") or doc.get("user_email") or doc.get("citizen_email") or ""
        citizen_phone = doc.get("applicant_mobile") or doc.get("mobile") or doc.get("phone") or ""

        fee = doc.get("fee")
        if fee is None:
            services_col = get_collection("services")
            srv_doc = services_col.find_one({"slug": doc.get("service_slug")}) if doc.get("service_slug") else None
            fee = srv_doc.get("fee", 0) if srv_doc else 0.0
        fee_val = float(fee) if fee is not None else 0.0
        payment_status = doc.get("payment_status", "Paid" if fee_val == 0.0 else "Pending")

        return success_response(data={
            "application_id": doc.get("application_id"),
            "citizen_name": citizen_name,
            "citizen_email": citizen_email,
            "applicant_name": citizen_name,
            "applicant_email": citizen_email,
            "applicant_mobile": citizen_phone,
            "service_name": doc.get("service_name"),
            "service_slug": doc.get("service_slug"),
            "category": doc.get("category"),
            "department": doc.get("department", "General"),
            "status": doc.get("status"),
            "fee": fee_val,
            "payment_status": payment_status,
            "assigned_to": doc.get("assigned_to"),
            "certificate_status": doc.get("certificate_status", "Issuance not supported"),
            "certificate_number": doc.get("certificate_number"),
            "form_data": doc.get("form_data", {}),
            "documents": documents,
            "status_history": history,
            "internal_notes": internal_notes,
            "is_deleted": doc.get("is_deleted", False),
            "created_at": doc.get("created_at").isoformat() if isinstance(doc.get("created_at"), datetime) else str(doc.get("created_at") or ""),
            "updated_at": doc.get("updated_at").isoformat() if isinstance(doc.get("updated_at"), datetime) else str(doc.get("updated_at") or "")
        })

    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/applications/<application_id>", methods=["PUT"])
@admin_required
@csrf_protect
def update_application_details(application_id):
    """
    Updates editable fields of an application: applicant name, email, phone, address/ward,
    description/remarks, and form_data particulars.
    Preserves system fields and logs full audit trail.
    """
    try:
        apps_col = get_collection("applications")
        doc = apps_col.find_one({"application_id": application_id})
        if not doc:
            return error_response(code="APPLICATION_NOT_FOUND", message="Application record not found.", status_code=404)

        body = request.get_json(silent=True) or {}
        update_fields = {}
        before_state = {}

        # 1. Applicant Name
        if "applicant_name" in body or "citizen_name" in body or "user_name" in body:
            new_name = (body.get("applicant_name") or body.get("citizen_name") or body.get("user_name") or "").strip()
            if len(new_name) < 2:
                return error_response(code="VALIDATION_ERROR", message="Applicant name must be at least 2 characters.", status_code=400)
            update_fields["applicant_name"] = new_name
            update_fields["citizen_name"] = new_name
            update_fields["user_name"] = new_name
            before_state["applicant_name"] = doc.get("applicant_name") or doc.get("user_name") or doc.get("citizen_name")

        # 2. Applicant Email
        if "applicant_email" in body or "citizen_email" in body or "user_email" in body:
            new_email = (body.get("applicant_email") or body.get("citizen_email") or body.get("user_email") or "").strip().lower()
            ok_email, sanitized_email = validate_email(new_email)
            if not ok_email:
                return error_response(code="VALIDATION_ERROR", message="Invalid applicant email address.", status_code=400)
            update_fields["applicant_email"] = sanitized_email
            update_fields["citizen_email"] = sanitized_email
            update_fields["user_email"] = sanitized_email
            before_state["applicant_email"] = doc.get("applicant_email") or doc.get("user_email") or doc.get("citizen_email")

        # 3. Applicant Mobile / Phone
        if "applicant_mobile" in body or "phone" in body or "mobile" in body:
            new_phone = (body.get("applicant_mobile") or body.get("phone") or body.get("mobile") or "").strip()
            update_fields["applicant_mobile"] = new_phone
            update_fields["phone"] = new_phone
            update_fields["mobile"] = new_phone
            before_state["applicant_mobile"] = doc.get("applicant_mobile") or doc.get("mobile") or doc.get("phone")

        # 4. Residential Address / Location / Ward
        if "address" in body or "location" in body or "ward" in body:
            new_address = (body.get("address") or body.get("location") or body.get("ward") or "").strip()
            update_fields["address"] = new_address
            before_state["address"] = doc.get("address")

        # 5. Application Description / Remarks
        if "description" in body or "remarks" in body:
            new_desc = (body.get("description") or body.get("remarks") or "").strip()
            update_fields["description"] = new_desc
            before_state["description"] = doc.get("description")

        # 6. Form Data Particulars
        if "form_data" in body and isinstance(body["form_data"], dict):
            current_form_data = dict(doc.get("form_data") or {})
            current_form_data.update(body["form_data"])
            update_fields["form_data"] = current_form_data
            before_state["form_data"] = doc.get("form_data")

        if not update_fields:
            return error_response(code="NO_CHANGES", message="No valid editable fields provided.", status_code=400)

        now = datetime.now(timezone.utc)
        update_fields["updated_at"] = now
        update_fields["updated_by"] = session.get("email") or str(session.get("user_id"))

        apps_col.update_one({"application_id": application_id}, {"$set": update_fields})

        log_audit(
            actor_id=session.get("user_id"),
            actor_role=session.get("admin_role", "admin"),
            action="APPLICATION_DETAILS_UPDATED",
            target_collection="applications",
            target_id=application_id,
            before_after_summary={"before": before_state, "after": update_fields},
            ip=request.remote_addr
        )

        updated_doc = apps_col.find_one({"application_id": application_id})
        return success_response(data={
            "application_id": application_id,
            "applicant_name": updated_doc.get("applicant_name") or updated_doc.get("user_name"),
            "applicant_email": updated_doc.get("applicant_email") or updated_doc.get("user_email"),
            "applicant_mobile": updated_doc.get("applicant_mobile"),
            "address": updated_doc.get("address"),
            "description": updated_doc.get("description"),
            "form_data": updated_doc.get("form_data", {}),
            "updated_at": now.isoformat(),
            "message": f"Application {application_id} updated successfully."
        })

    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/applications/<application_id>/status", methods=["PATCH"])
@admin_required
@csrf_protect
def update_application_status(application_id):
    """Updates application status with controlled transitions and mandatory remarks."""
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

        # Enforce controlled status transitions:
        # Reopening an approved application with issued certificate requires super_admin
        if old_status == "Approved" and new_status != "Approved":
            user_role = session.get("admin_role") or session.get("role")
            if user_role != "super_admin":
                return error_response(
                    code="TRANSITION_RESTRICTED",
                    message="Approved applications with official issued certificates can only be modified by Super Administrators.",
                    status_code=403
                )

        now = datetime.now(timezone.utc)

        history_entry = {
            "status": new_status,
            "changed_at": now,
            "changed_by": str(session["user_id"]),
            "role": session.get("admin_role", "admin"),
            "remarks": remarks
        }

        update_fields = {
            "status": new_status,
            "updated_at": now
        }

        if new_status == "Approved" and not doc.get("certificate_number"):
            cert_no = f"MSP-CERT-{now.strftime('%Y%m')}-{application_id.split('-')[-1]}"
            update_fields["certificate_number"] = cert_no
            update_fields["certificate_status"] = "Issued"
            update_fields["approved_at"] = now
            update_fields["approved_by"] = session.get("email")

        res = apps_col.update_one(
            {"application_id": application_id},
            {
                "$set": update_fields,
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
            "message": f"Your application {application_id} for '{doc.get('service_name')}' status is now '{new_status}'. Remarks: {remarks}",
            "link": "/user-dashboard.html",
            "is_read": False,
            "created_at": now
        })

        # Audit Log
        log_audit(
            actor_id=session.get("user_id"),
            actor_role=session.get("admin_role", "admin"),
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
                "certificate_number": update_fields.get("certificate_number", doc.get("certificate_number")),
                "updated_at": now.isoformat(),
                "message": f"Application {application_id} status updated to {new_status}."
            }
        )

    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/applications/<application_id>/assign", methods=["PATCH"])
@admin_required
@csrf_protect
def assign_application(application_id):
    """Assigns application to an officer or department."""
    try:
        body = request.get_json(silent=True) or {}
        assigned_to = body.get("assigned_to", "").strip()
        department = body.get("department", "").strip()
        remarks = body.get("remarks", "Application assigned for administrative evaluation.")

        if not assigned_to and not department:
            return error_response(code="VALIDATION_ERROR", message="Assigned officer or department required.", status_code=400)

        apps_col = get_collection("applications")
        doc = apps_col.find_one({"application_id": application_id})
        if not doc:
            return error_response(code="APPLICATION_NOT_FOUND", message="Application not found.", status_code=404)

        now = datetime.now(timezone.utc)
        update_doc = {"updated_at": now}
        if assigned_to:
            update_doc["assigned_to"] = assigned_to
        if department:
            update_doc["department"] = department

        history_entry = {
            "status": doc.get("status", "Under Review"),
            "changed_at": now,
            "changed_by": str(session["user_id"]),
            "role": session.get("admin_role", "admin"),
            "remarks": f"Assignment updated: {assigned_to or department}. {remarks}".strip()
        }

        apps_col.update_one(
            {"application_id": application_id},
            {"$set": update_doc, "$push": {"status_history": history_entry}}
        )

        log_audit(
            actor_id=session.get("user_id"),
            actor_role=session.get("admin_role", "admin"),
            action="APPLICATION_ASSIGNED",
            target_collection="applications",
            target_id=application_id,
            before_after_summary={"assigned_to": assigned_to, "department": department},
            ip=request.remote_addr
        )

        return success_response({"message": f"Application assigned to {assigned_to or department}."})
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/applications/<application_id>/notes", methods=["POST"])
@admin_required
@csrf_protect
def add_application_internal_note(application_id):
    """Adds an internal administrative note."""
    try:
        body = request.get_json(silent=True) or {}
        note_text = body.get("note", "").strip()
        if not note_text or len(note_text) < 2:
            return error_response(code="VALIDATION_ERROR", message="Note content is required.", status_code=400)

        apps_col = get_collection("applications")
        doc = apps_col.find_one({"application_id": application_id})
        if not doc:
            return error_response(code="APPLICATION_NOT_FOUND", message="Application not found.", status_code=404)

        now = datetime.now(timezone.utc)
        note_entry = {
            "note": note_text,
            "author": session.get("email", "Admin Officer"),
            "author_id": session.get("user_id"),
            "created_at": now
        }

        apps_col.update_one({"application_id": application_id}, {"$push": {"internal_notes": note_entry}})

        return success_response({"message": "Internal note recorded successfully."})
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/applications/<application_id>", methods=["DELETE"])
@admin_required
@csrf_protect
def soft_delete_application(application_id):
    """Soft deletes an application with audit logging and protection for approved records."""
    try:
        apps_col = get_collection("applications")
        doc = apps_col.find_one({"application_id": application_id})
        if not doc:
            return error_response(code="APPLICATION_NOT_FOUND", message="Application not found.", status_code=404)

        # Protect approved applications from accidental deletion
        if doc.get("status") == "Approved":
            force = request.args.get("force") == "true" or (request.get_json(silent=True) or {}).get("force") is True
            user_role = session.get("admin_role") or session.get("role")
            if user_role != "super_admin" and not force:
                return error_response(
                    code="CANNOT_DELETE_APPROVED",
                    message="This application has been Approved with an issued certificate. Super Admin confirmation is required to delete it.",
                    status_code=409
                )

        now = datetime.now(timezone.utc)
        apps_col.update_one(
            {"application_id": application_id},
            {"$set": {"is_deleted": True, "deleted_at": now, "deleted_by": session.get("user_id")}}
        )

        log_audit(
            actor_id=session.get("user_id"),
            actor_role=session.get("admin_role", "admin"),
            action="APPLICATION_SOFT_DELETED",
            target_collection="applications",
            target_id=application_id,
            before_after_summary={"application_id": application_id},
            ip=request.remote_addr
        )

        return success_response({"message": f"Application {application_id} moved to trash."})
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/applications/<application_id>/restore", methods=["PATCH"])
@admin_required
@csrf_protect
def restore_application(application_id):
    """Restores a soft-deleted application."""
    try:
        apps_col = get_collection("applications")
        res = apps_col.update_one(
            {"application_id": application_id},
            {"$set": {"is_deleted": False, "restored_at": datetime.now(timezone.utc)}}
        )
        if res.matched_count == 0:
            return error_response(code="APPLICATION_NOT_FOUND", message="Application not found.", status_code=404)

        return success_response({"message": f"Application {application_id} restored."})
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/applications/<application_id>/permanent", methods=["DELETE"])
@super_admin_required
@csrf_protect
def permanent_delete_application(application_id):
    """Permanently purges an application (strictly Super Admin)."""
    try:
        apps_col = get_collection("applications")
        res = apps_col.delete_one({"application_id": application_id})
        if res.deleted_count == 0:
            return error_response(code="APPLICATION_NOT_FOUND", message="Application not found.", status_code=404)

        return success_response({"message": f"Application {application_id} permanently deleted."})
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/applications/bulk", methods=["POST"])
@admin_required
@csrf_protect
def bulk_application_actions():
    """Performs bulk approval, rejection, or deletion."""
    try:
        body = request.get_json(silent=True) or {}
        action = body.get("action")
        app_ids = body.get("application_ids", [])
        remarks = body.get("remarks", "Bulk administrative operation.")

        if not app_ids or not isinstance(app_ids, list):
            return error_response(code="VALIDATION_ERROR", message="Array of application IDs required.", status_code=400)

        apps_col = get_collection("applications")
        now = datetime.now(timezone.utc)

        if action == "approve":
            apps_col.update_many(
                {"application_id": {"$in": app_ids}},
                {"$set": {"status": "Approved", "updated_at": now}}
            )
        elif action == "reject":
            if not remarks or len(remarks) < 5:
                return error_response(code="REMARKS_REQUIRED", message="Rejection reason required for bulk action.", status_code=400)
            apps_col.update_many(
                {"application_id": {"$in": app_ids}},
                {"$set": {"status": "Rejected", "updated_at": now}}
            )
        elif action == "delete":
            apps_col.update_many(
                {"application_id": {"$in": app_ids}},
                {"$set": {"is_deleted": True, "deleted_at": now, "deleted_by": session.get("user_id")}}
            )
        else:
            return error_response(code="INVALID_ACTION", message="Action must be 'approve', 'reject', or 'delete'.", status_code=400)

        return success_response({"message": f"Successfully performed '{action}' on {len(app_ids)} applications."})
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/applications/<application_id>/certificate", methods=["GET"])
@admin_required
def generate_application_certificate(application_id):
    """Generates printable certificate data for an approved application."""
    try:
        apps_col = get_collection("applications")
        doc = apps_col.find_one({"application_id": application_id})
        if not doc:
            return error_response(code="APPLICATION_NOT_FOUND", message="Application record not found.", status_code=404)

        if doc.get("status") != "Approved":
            return error_response(code="CERTIFICATE_NOT_ELIGIBLE", message="Certificates can only be issued for Approved applications.", status_code=400)

        cert_no = doc.get("certificate_number") or f"MSP-CERT-{application_id}"
        issued_date = doc.get("approved_at") or doc.get("updated_at") or datetime.now(timezone.utc)
        issued_date_str = issued_date.strftime("%d %B %Y") if isinstance(issued_date, datetime) else str(issued_date)

        cert_data = {
            "certificate_number": cert_no,
            "application_id": doc.get("application_id"),
            "service_name": doc.get("service_name"),
            "category": doc.get("category"),
            "department": doc.get("department", "Municipal Administration"),
            "citizen_name": doc.get("user_name"),
            "citizen_email": doc.get("user_email"),
            "issued_date": issued_date_str,
            "issuing_authority": "Commissioner, Municipal Corporation",
            "portal_name": "Municipal Service Portal",
            "form_data": doc.get("form_data", {}),
            "status": "Valid Official Certificate"
        }
        return success_response(data=cert_data)
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


# ==============================================================================
# 3. GRIEVANCES MANAGEMENT WORKFLOWS (FULL CRUD)
# ==============================================================================

@admin_portal_bp.route("/complaints", methods=["GET"])
@admin_required
def list_admin_complaints():
    """Lists citizen grievances with shared filtering, date ranges, and overdue SLA detection."""
    try:
        cmps_col = get_collection("complaints")

        range_param = request.args.get("range", "all")
        from_param = request.args.get("from")
        to_param = request.args.get("to")
        status_filter = request.args.get("status")
        dept_filter = request.args.get("department")
        priority_filter = request.args.get("priority")
        search_q = request.args.get("q", "").strip()
        include_deleted = request.args.get("include_deleted") == "true"
        overdue = request.args.get("overdue") == "true"

        user_role = session.get("admin_role") or session.get("role")
        user_dept = session.get("department")

        query = build_complaints_filter(
            range_type=range_param,
            custom_from=from_param,
            custom_to=to_param,
            status=status_filter,
            department=dept_filter,
            priority=priority_filter,
            search_q=search_q,
            include_deleted=include_deleted,
            overdue=overdue,
            user_dept=user_dept,
            user_role=user_role
        )

        cursor = cmps_col.find(query).sort("created_at", -1)
        results = []
        now_utc = datetime.now(timezone.utc)
        for doc in cursor:
            due_dt = doc.get("due_date")
            is_overdue = False
            if due_dt and isinstance(due_dt, datetime):
                is_overdue = due_dt < now_utc and doc.get("status") not in ["Resolved", "Closed", "Rejected"]

            results.append({
                "complaint_id": doc.get("complaint_id"),
                "department": doc.get("department"),
                "category": doc.get("category", doc.get("department", "General")),
                "title": doc.get("title"),
                "citizen_name": doc.get("user_name"),
                "citizen_email": doc.get("user_email"),
                "location": doc.get("location"),
                "priority": doc.get("priority", "Medium"),
                "status": doc.get("status", "Submitted"),
                "assigned_to": doc.get("assigned_to"),
                "is_overdue": is_overdue,
                "escalated": doc.get("escalated", False),
                "images_count": len(doc.get("images", [])),
                "created_at": doc.get("created_at").isoformat() if isinstance(doc.get("created_at"), datetime) else str(doc.get("created_at") or ""),
                "updated_at": doc.get("updated_at").isoformat() if isinstance(doc.get("updated_at"), datetime) else str(doc.get("updated_at") or "")
            })

        return success_response(data=results)

    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/complaints/<complaint_id>", methods=["GET"])
@admin_required
def get_admin_complaint_detail(complaint_id):
    """Retrieves full grievance details, photos, coordinates, and notes."""
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
                "role": h.get("role", "admin"),
                "remarks": h.get("remarks", "")
            })

        replies = []
        for r in doc.get("citizen_replies", []):
            replies.append({
                "message": r.get("message"),
                "author": r.get("author", "Officer"),
                "created_at": r.get("created_at").isoformat() if isinstance(r.get("created_at"), datetime) else str(r.get("created_at"))
            })

        internal_notes = []
        for n in doc.get("internal_notes", []):
            internal_notes.append({
                "note": n.get("note"),
                "author": n.get("author", "Officer"),
                "created_at": n.get("created_at").isoformat() if isinstance(n.get("created_at"), datetime) else str(n.get("created_at"))
            })

        now_utc = datetime.now(timezone.utc)
        due_dt = doc.get("due_date")
        is_overdue = bool(due_dt and isinstance(due_dt, datetime) and due_dt < now_utc and doc.get("status") not in ["Resolved", "Closed"])

        return success_response(data={
            "complaint_id": doc.get("complaint_id"),
            "citizen_name": doc.get("user_name"),
            "citizen_email": doc.get("user_email"),
            "title": doc.get("title"),
            "department": doc.get("department"),
            "category": doc.get("category", doc.get("department", "General")),
            "priority": doc.get("priority", "Medium"),
            "description": doc.get("description"),
            "location": doc.get("location"),
            "coordinates": doc.get("coordinates"),
            "status": doc.get("status"),
            "assigned_to": doc.get("assigned_to"),
            "is_overdue": is_overdue,
            "escalated": doc.get("escalated", False),
            "due_date": due_dt.isoformat() if isinstance(due_dt, datetime) else str(due_dt or ""),
            "images": images,
            "status_history": history,
            "citizen_replies": replies,
            "internal_notes": internal_notes,
            "resolution_proof": doc.get("resolution_proof"),
            "created_at": doc.get("created_at").isoformat() if isinstance(doc.get("created_at"), datetime) else str(doc.get("created_at") or ""),
            "updated_at": doc.get("updated_at").isoformat() if isinstance(doc.get("updated_at"), datetime) else str(doc.get("updated_at") or "")
        })

    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/complaints/<complaint_id>/status", methods=["PATCH"])
@admin_required
@csrf_protect
def update_complaint_status(complaint_id):
    """Updates complaint status with remarks and logs audit event."""
    try:
        body = request.get_json(silent=True) or {}
        new_status = body.get("status", "").strip()
        remarks = body.get("remarks", "").strip()
        resolution_proof = body.get("resolution_proof", "").strip()

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
            "role": session.get("admin_role", "admin"),
            "remarks": remarks
        }

        update_doc = {
            "status": new_status,
            "updated_at": now
        }
        if resolution_proof:
            update_doc["resolution_proof"] = resolution_proof
        if new_status in ["Resolved", "Closed"]:
            update_doc["resolved_at"] = now

        res = cmps_col.update_one(
            {"complaint_id": complaint_id},
            {
                "$set": update_doc,
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
            actor_role=session.get("admin_role", "admin"),
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


@admin_portal_bp.route("/complaints/<complaint_id>/assign", methods=["PATCH"])
@admin_required
@csrf_protect
def assign_complaint(complaint_id):
    """Assigns grievance to a department or officer."""
    try:
        body = request.get_json(silent=True) or {}
        department = body.get("department", "").strip()
        assigned_to = body.get("assigned_to", "").strip()
        remarks = body.get("remarks", "").strip()

        if not department and not assigned_to:
            return error_response(code="DEPARTMENT_REQUIRED", message="Target department or officer is required.", status_code=400)

        cmps_col = get_collection("complaints")
        doc = cmps_col.find_one({"complaint_id": complaint_id})
        if not doc:
            return error_response(code="COMPLAINT_NOT_FOUND", message="Complaint record not found.", status_code=404)

        old_dept = doc.get("department", "Unassigned")
        new_status = "Assigned"
        now = datetime.now(timezone.utc)
        note = remarks or f"Assigned to {department or assigned_to}"

        history_entry = {
            "status": new_status,
            "changed_at": now,
            "changed_by": str(session["user_id"]),
            "role": "admin",
            "remarks": note
        }

        update_fields = {"status": new_status, "updated_at": now}
        if department:
            update_fields["department"] = department
        if assigned_to:
            update_fields["assigned_to"] = assigned_to

        res = cmps_col.update_one(
            {"complaint_id": complaint_id},
            {"$set": update_fields, "$push": {"status_history": history_entry}}
        )
        if not res.acknowledged:
            return error_response(code="DATABASE_ERROR", message="Failed to assign grievance.", status_code=500)

        # Notify citizen
        notif_col = get_collection("notifications")
        notif_col.insert_one({
            "user_id": doc["user_id"],
            "title": "Grievance Assigned",
            "message": f"Your complaint {complaint_id} has been assigned to '{department or assigned_to}'. Remarks: {note}",
            "link": "/user-dashboard.html",
            "is_read": False,
            "created_at": now
        })

        log_audit(
            actor_id=session.get("user_id"),
            actor_role="admin",
            action="COMPLAINT_ASSIGNED",
            target_collection="complaints",
            target_id=complaint_id,
            before_after_summary={
                "complaint_id": complaint_id,
                "before_department": old_dept,
                "after_department": department,
                "assigned_to": assigned_to,
                "remarks": note
            },
            ip=request.remote_addr
        )

        return success_response(
            data={
                "complaint_id": complaint_id,
                "department": department or old_dept,
                "assigned_to": assigned_to,
                "status": new_status,
                "remarks": note,
                "updated_at": now.isoformat(),
                "message": f"Complaint {complaint_id} assigned to {department or assigned_to}."
            }
        )
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/complaints/<complaint_id>/priority", methods=["PATCH"])
@admin_required
@csrf_protect
def update_complaint_priority(complaint_id):
    """Sets priority for a grievance."""
    try:
        body = request.get_json(silent=True) or {}
        new_priority = body.get("priority", "").strip()
        if new_priority not in COMPLAINT_PRIORITIES:
            return error_response(code="INVALID_PRIORITY", message=f"Priority must be one of {COMPLAINT_PRIORITIES}.", status_code=400)

        cmps_col = get_collection("complaints")
        res = cmps_col.update_one(
            {"complaint_id": complaint_id},
            {"$set": {"priority": new_priority, "updated_at": datetime.now(timezone.utc)}}
        )
        if res.matched_count == 0:
            return error_response(code="COMPLAINT_NOT_FOUND", message="Complaint not found.", status_code=404)

        return success_response({"message": f"Priority set to {new_priority}."})
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/complaints/<complaint_id>/reply", methods=["POST"])
@admin_required
@csrf_protect
def reply_to_citizen(complaint_id):
    """Sends an official reply message to the citizen."""
    try:
        body = request.get_json(silent=True) or {}
        message = body.get("message", "").strip()
        if not message or len(message) < 5:
            return error_response(code="VALIDATION_ERROR", message="Reply message must be at least 5 characters.", status_code=400)

        cmps_col = get_collection("complaints")
        doc = cmps_col.find_one({"complaint_id": complaint_id})
        if not doc:
            return error_response(code="COMPLAINT_NOT_FOUND", message="Complaint not found.", status_code=404)

        now = datetime.now(timezone.utc)
        reply_entry = {
            "message": message,
            "author": session.get("email", "Admin Officer"),
            "author_id": session.get("user_id"),
            "created_at": now
        }

        cmps_col.update_one({"complaint_id": complaint_id}, {"$push": {"citizen_replies": reply_entry}})

        notif_col = get_collection("notifications")
        notif_col.insert_one({
            "user_id": doc["user_id"],
            "title": f"Officer Update on Grievance {complaint_id}",
            "message": f"Municipal Officer response: {message}",
            "link": "/user-dashboard.html",
            "is_read": False,
            "created_at": now
        })

        return success_response({"message": "Reply dispatched to citizen."})
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/complaints/<complaint_id>/notes", methods=["POST"])
@admin_required
@csrf_protect
def add_complaint_internal_note(complaint_id):
    """Adds an internal note to the grievance file."""
    try:
        body = request.get_json(silent=True) or {}
        note_text = body.get("note", "").strip()
        if not note_text or len(note_text) < 2:
            return error_response(code="VALIDATION_ERROR", message="Note content required.", status_code=400)

        cmps_col = get_collection("complaints")
        res = cmps_col.update_one(
            {"complaint_id": complaint_id},
            {
                "$push": {
                    "internal_notes": {
                        "note": note_text,
                        "author": session.get("email", "Officer"),
                        "created_at": datetime.now(timezone.utc)
                    }
                }
            }
        )
        if res.matched_count == 0:
            return error_response(code="COMPLAINT_NOT_FOUND", message="Complaint not found.", status_code=404)

        return success_response({"message": "Internal note recorded."})
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/complaints/<complaint_id>/escalate", methods=["PATCH"])
@admin_required
@csrf_protect
def escalate_complaint(complaint_id):
    """Escalates a grievance to Urgent priority."""
    try:
        body = request.get_json(silent=True) or {}
        reason = body.get("reason", "Overdue resolution SLA breached.")

        cmps_col = get_collection("complaints")
        doc = cmps_col.find_one({"complaint_id": complaint_id})
        if not doc:
            return error_response(code="COMPLAINT_NOT_FOUND", message="Complaint not found.", status_code=404)

        now = datetime.now(timezone.utc)
        history_entry = {
            "status": "Escalated",
            "changed_at": now,
            "changed_by": str(session["user_id"]),
            "role": "admin",
            "remarks": f"ESCALATED: {reason}"
        }

        cmps_col.update_one(
            {"complaint_id": complaint_id},
            {
                "$set": {"escalated": True, "priority": "Urgent", "updated_at": now},
                "$push": {"status_history": history_entry}
            }
        )

        return success_response({"message": f"Grievance {complaint_id} has been escalated to Urgent priority."})
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/complaints/<complaint_id>/reopen", methods=["PATCH"])
@admin_required
@csrf_protect
def reopen_complaint(complaint_id):
    """Reopens a resolved grievance."""
    try:
        body = request.get_json(silent=True) or {}
        reason = body.get("reason", "").strip()
        if not reason or len(reason) < 5:
            return error_response(code="VALIDATION_ERROR", message="Reopen justification required (min 5 chars).", status_code=400)

        cmps_col = get_collection("complaints")
        doc = cmps_col.find_one({"complaint_id": complaint_id})
        if not doc:
            return error_response(code="COMPLAINT_NOT_FOUND", message="Complaint not found.", status_code=404)

        now = datetime.now(timezone.utc)
        history_entry = {
            "status": "In Progress",
            "changed_at": now,
            "changed_by": str(session["user_id"]),
            "role": "admin",
            "remarks": f"REOPENED: {reason}"
        }

        cmps_col.update_one(
            {"complaint_id": complaint_id},
            {
                "$set": {"status": "In Progress", "reopened_at": now, "updated_at": now},
                "$push": {"status_history": history_entry}
            }
        )

        return success_response({"message": f"Complaint {complaint_id} has been reopened for investigation."})
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/complaints/<complaint_id>", methods=["DELETE"])
@admin_required
@csrf_protect
def soft_delete_complaint(complaint_id):
    """Soft deletes a complaint."""
    try:
        cmps_col = get_collection("complaints")
        now = datetime.now(timezone.utc)
        res = cmps_col.update_one(
            {"complaint_id": complaint_id},
            {"$set": {"is_deleted": True, "deleted_at": now, "deleted_by": session.get("user_id")}}
        )
        if res.matched_count == 0:
            return error_response(code="COMPLAINT_NOT_FOUND", message="Complaint not found.", status_code=404)

        return success_response({"message": f"Complaint {complaint_id} soft deleted."})
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/complaints/<complaint_id>/restore", methods=["PATCH"])
@admin_required
@csrf_protect
def restore_complaint(complaint_id):
    """Restores a soft-deleted complaint."""
    try:
        cmps_col = get_collection("complaints")
        res = cmps_col.update_one(
            {"complaint_id": complaint_id},
            {"$set": {"is_deleted": False, "restored_at": datetime.now(timezone.utc)}}
        )
        if res.matched_count == 0:
            return error_response(code="COMPLAINT_NOT_FOUND", message="Complaint not found.", status_code=404)

        return success_response({"message": f"Complaint {complaint_id} restored."})
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


# ==============================================================================
# 4. SERVICES CATALOG MANAGEMENT
# ==============================================================================

def slugify(text):
    text = re.sub(r"[^\w\s-]", "", text.lower())
    return re.sub(r"[-\s]+", "-", text).strip("-")


@admin_portal_bp.route("/services", methods=["GET"])
@admin_required
def get_admin_services_catalog():
    """Returns services catalog with live application counts, filtering, and search."""
    try:
        services_col = get_collection("services")
        apps_col = get_collection("applications")

        query = {"is_deleted": {"$ne": True}}

        status_param = request.args.get("status") or request.args.get("availability")
        if status_param and status_param.upper() != "ALL":
            s_clean = status_param.strip().lower()
            if s_clean in ["available", "active"]:
                query["availability"] = {"$in": ["Available", "Active"]}
            elif s_clean in ["unavailable", "inactive", "disabled"]:
                query["availability"] = "Unavailable"
            else:
                query["availability"] = {"$regex": f"^{re.escape(status_param)}$", "$options": "i"}

        category_param = request.args.get("category")
        if category_param and category_param != "ALL":
            query["category"] = category_param

        dept_param = request.args.get("department")
        if dept_param and dept_param != "ALL":
            query["department"] = dept_param

        search_q = request.args.get("q", "").strip()
        if search_q:
            query["$or"] = [
                {"name": {"$regex": search_q, "$options": "i"}},
                {"slug": {"$regex": search_q, "$options": "i"}},
                {"category": {"$regex": search_q, "$options": "i"}},
                {"department": {"$regex": search_q, "$options": "i"}}
            ]

        app_counts_by_slug = {}
        try:
            for item in apps_col.aggregate([{"$group": {"_id": "$service_slug", "count": {"$sum": 1}}}]):
                if item.get("_id"):
                    app_counts_by_slug[item["_id"]] = item.get("count", 0)
        except Exception:
            pass

        cursor = services_col.find(query).sort("name", 1)
        results = []
        for srv in cursor:
            slug = srv.get("slug", "")
            results.append({
                "slug": slug,
                "name": srv.get("name", ""),
                "category": srv.get("category", "General"),
                "department": srv.get("department", "General Administration"),
                "description": srv.get("description", ""),
                "availability": srv.get("availability", "Unavailable"),
                "is_active": srv.get("is_active", srv.get("availability") in ["Available", "Active"]),
                "unavailable_reason": srv.get("unavailable_reason", ""),
                "required_documents": srv.get("required_documents", []),
                "form_schema": srv.get("form_schema", []),
                "eligibility": srv.get("eligibility", ""),
                "processing_days": srv.get("processing_days", 7),
                "fee": srv.get("fee", 0),
                "applications_count": app_counts_by_slug.get(slug, 0),
                "created_at": srv.get("created_at").isoformat() if isinstance(srv.get("created_at"), datetime) else str(srv.get("created_at") or ""),
                "updated_at": srv.get("updated_at").isoformat() if isinstance(srv.get("updated_at"), datetime) else str(srv.get("updated_at") or "")
            })

        return success_response(data=results)

    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/services/<slug>", methods=["GET"])
@admin_required
def get_admin_service_detail(slug):
    """Retrieves full service specifications, statistics, and recent applications."""
    try:
        services_col = get_collection("services")
        apps_col = get_collection("applications")

        service = services_col.find_one({"slug": slug})
        if not service:
            return error_response(code="SERVICE_NOT_FOUND", message=f"Service '{slug}' was not found.", status_code=404)

        # Statistics
        total_apps = safe_count(apps_col, {"service_slug": slug, "is_deleted": {"$ne": True}})
        approved_apps = safe_count(apps_col, {"service_slug": slug, "status": "Approved", "is_deleted": {"$ne": True}})
        rejected_apps = safe_count(apps_col, {"service_slug": slug, "status": "Rejected", "is_deleted": {"$ne": True}})
        approval_rate = round((approved_apps / total_apps) * 100, 1) if total_apps > 0 else 0.0

        # Recent applications for this service
        recent_apps_cursor = apps_col.find(
            {"service_slug": slug, "is_deleted": {"$ne": True}}
        ).sort("created_at", -1).limit(5)
        recent_apps = []
        for app in recent_apps_cursor:
            recent_apps.append({
                "application_id": app.get("application_id"),
                "citizen_name": app.get("user_name"),
                "citizen_email": app.get("user_email"),
                "status": app.get("status"),
                "created_at": app.get("created_at").isoformat() if isinstance(app.get("created_at"), datetime) else str(app.get("created_at") or "")
            })

        return success_response(data={
            "slug": slug,
            "name": service.get("name", ""),
            "category": service.get("category", "General"),
            "department": service.get("department", "General Administration"),
            "description": service.get("description", ""),
            "availability": service.get("availability", "Unavailable"),
            "is_active": service.get("is_active", service.get("availability") in ["Available", "Active"]),
            "unavailable_reason": service.get("unavailable_reason", ""),
            "required_documents": service.get("required_documents", []),
            "form_schema": service.get("form_schema", []),
            "eligibility": service.get("eligibility", ""),
            "processing_days": service.get("processing_days", 7),
            "fee": service.get("fee", 0),
            "created_at": service.get("created_at").isoformat() if isinstance(service.get("created_at"), datetime) else str(service.get("created_at") or ""),
            "updated_at": service.get("updated_at").isoformat() if isinstance(service.get("updated_at"), datetime) else str(service.get("updated_at") or ""),
            "statistics": {
                "total_applications": total_apps,
                "approved_applications": approved_apps,
                "rejected_applications": rejected_apps,
                "approval_rate": approval_rate,
                "avg_processing_days": service.get("processing_days", 7)
            },
            "recent_applications": recent_apps
        })
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/services/<slug>/availability", methods=["PATCH"])
@admin_required
@csrf_protect
def update_service_availability(slug):
    """Toggles service availability instantly across citizen and admin portals using ONE source of truth."""
    try:
        body = request.get_json(silent=True) or {}
        new_availability = body.get("availability", "").strip()
        reason = body.get("reason", "").strip()

        if new_availability not in ["Active", "Available", "Unavailable"]:
            return error_response(
                code="INVALID_AVAILABILITY",
                message="Availability must be 'Available', 'Active', or 'Unavailable'.",
                status_code=400
            )

        services_col = get_collection("services")
        service = services_col.find_one({"slug": slug})
        if not service:
            return error_response(code="SERVICE_NOT_FOUND", message=f"Service '{slug}' was not found.", status_code=404)

        old_availability = service.get("availability", "Unavailable")
        now = datetime.now(timezone.utc)
        is_active = (new_availability in ["Available", "Active"])

        update_fields = {
            "availability": new_availability,
            "is_active": is_active,
            "unavailable_reason": reason if new_availability == "Unavailable" else "",
            "updated_at": now
        }

        res = services_col.update_one({"slug": slug}, {"$set": update_fields})
        if not res.acknowledged:
            return error_response(code="DATABASE_ERROR", message="Failed to update service availability.", status_code=500)

        log_audit(
            actor_id=session.get("user_id"),
            actor_role="admin",
            action="SERVICE_AVAILABILITY_UPDATED",
            target_collection="services",
            target_id=slug,
            before_after_summary={
                "slug": slug,
                "before": old_availability,
                "after": new_availability,
                "is_active": is_active,
                "reason": reason
            },
            ip=request.remote_addr
        )

        return success_response(
            data={
                "slug": slug,
                "name": service.get("name"),
                "availability": new_availability,
                "is_active": is_active,
                "unavailable_reason": update_fields["unavailable_reason"],
                "message": f"Service '{service.get('name')}' is now {new_availability}."
            }
        )

    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/services", methods=["POST"])
@admin_required
@csrf_protect
def create_service():
    """Creates a new municipal service in the catalog."""
    try:
        body = request.get_json(silent=True) or {}
        name = body.get("name", "").strip()
        category = body.get("category", "").strip()
        description = body.get("description", "").strip()
        department = body.get("department", "General Administration").strip()
        availability = body.get("availability", "Available").strip()
        required_docs = body.get("required_documents", [])
        form_schema = body.get("form_schema", [])
        eligibility = body.get("eligibility", "").strip()
        processing_days = body.get("processing_days", 7)
        fee = body.get("fee", 0)

        if not name or len(name) < 3:
            return error_response(code="VALIDATION_ERROR", message="Service name is required (min 3 chars).", status_code=400)
        if not category:
            return error_response(code="VALIDATION_ERROR", message="Category is required.", status_code=400)
        if not description:
            return error_response(code="VALIDATION_ERROR", message="Description is required.", status_code=400)

        slug = body.get("slug", "").strip() or slugify(name)
        services_col = get_collection("services")
        if services_col.find_one({"slug": slug}):
            return error_response(code="SLUG_EXISTS", message=f"A service with slug '{slug}' already exists.", status_code=400)

        now = datetime.now(timezone.utc)
        avail_val = availability if availability in ["Available", "Active", "Unavailable"] else "Available"
        doc = {
            "slug": slug,
            "name": name,
            "category": category,
            "department": department,
            "description": description,
            "availability": avail_val,
            "is_active": (avail_val in ["Available", "Active"]),
            "unavailable_reason": body.get("unavailable_reason", ""),
            "required_documents": required_docs if isinstance(required_docs, list) else [],
            "form_schema": form_schema if isinstance(form_schema, list) else [],
            "eligibility": eligibility,
            "processing_days": int(processing_days) if str(processing_days).isdigit() else 7,
            "fee": float(fee) if fee else 0,
            "is_deleted": False,
            "created_at": now,
            "updated_at": now
        }
        res = services_col.insert_one(doc)
        if not res.acknowledged:
            return error_response(code="DATABASE_ERROR", message="Failed to create service.", status_code=500)

        log_audit(
            actor_id=session.get("user_id"),
            actor_role="admin",
            action="SERVICE_CREATED",
            target_collection="services",
            target_id=slug,
            before_after_summary={"slug": slug, "name": name, "category": category},
            ip=request.remote_addr
        )

        return success_response(data={"slug": slug, "name": name, "message": f"Service '{name}' created successfully."}, status_code=201)
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/services/<slug>", methods=["PUT"])
@admin_required
@csrf_protect
def update_service(slug):
    """Updates an existing municipal service definition."""
    try:
        body = request.get_json(silent=True) or {}
        services_col = get_collection("services")
        service = services_col.find_one({"slug": slug})
        if not service:
            return error_response(code="SERVICE_NOT_FOUND", message=f"Service '{slug}' was not found.", status_code=404)

        update_fields = {}
        if "name" in body and body["name"].strip():
            update_fields["name"] = body["name"].strip()
        if "category" in body and body["category"].strip():
            update_fields["category"] = body["category"].strip()
        if "department" in body and body["department"].strip():
            update_fields["department"] = body["department"].strip()
        if "description" in body and body["description"].strip():
            update_fields["description"] = body["description"].strip()
        if "eligibility" in body:
            update_fields["eligibility"] = body["eligibility"].strip()
        if "availability" in body and body["availability"].strip() in ["Available", "Active", "Unavailable"]:
            update_fields["availability"] = body["availability"].strip()
            update_fields["is_active"] = (update_fields["availability"] in ["Available", "Active"])
        if "unavailable_reason" in body:
            update_fields["unavailable_reason"] = body["unavailable_reason"].strip()
        if "required_documents" in body and isinstance(body["required_documents"], list):
            update_fields["required_documents"] = body["required_documents"]
        if "form_schema" in body and isinstance(body["form_schema"], list):
            update_fields["form_schema"] = body["form_schema"]
        if "processing_days" in body:
            update_fields["processing_days"] = int(body["processing_days"]) if str(body["processing_days"]).isdigit() else 7
        if "fee" in body:
            update_fields["fee"] = float(body["fee"]) if body["fee"] else 0

        update_fields["updated_at"] = datetime.now(timezone.utc)
        services_col.update_one({"slug": slug}, {"$set": update_fields})

        log_audit(
            actor_id=session.get("user_id"),
            actor_role="admin",
            action="SERVICE_UPDATED",
            target_collection="services",
            target_id=slug,
            before_after_summary={"slug": slug, "updated_fields": list(update_fields.keys())},
            ip=request.remote_addr
        )

        return success_response(data={"slug": slug, "message": f"Service '{slug}' updated successfully."})
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/services/<slug>/duplicate", methods=["POST"])
@admin_required
@csrf_protect
def duplicate_service(slug):
    """Clones a service schema into a new draft service."""
    try:
        services_col = get_collection("services")
        service = services_col.find_one({"slug": slug})
        if not service:
            return error_response(code="NOT_FOUND", message="Service not found.", status_code=404)

        now = datetime.now(timezone.utc)
        new_slug = f"{slug}-copy-{int(now.timestamp())}"
        new_doc = dict(service)
        new_doc.pop("_id", None)
        new_doc["slug"] = new_slug
        new_doc["name"] = f"{service.get('name')} (Copy)"
        new_doc["availability"] = "Unavailable"
        new_doc["is_active"] = False
        new_doc["created_at"] = now
        new_doc["updated_at"] = now

        services_col.insert_one(new_doc)
        return success_response({"slug": new_slug, "message": f"Duplicated as '{new_slug}'."})
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/services/<slug>", methods=["DELETE"])
@admin_required
@csrf_protect
def delete_service(slug):
    """Soft deletes a service if there are no active citizen applications."""
    try:
        services_col = get_collection("services")
        apps_col = get_collection("applications")

        service = services_col.find_one({"slug": slug})
        if not service:
            return error_response(code="SERVICE_NOT_FOUND", message=f"Service '{slug}' not found.", status_code=404)

        existing_apps = safe_count(apps_col, {"service_slug": slug, "is_deleted": {"$ne": True}})
        if existing_apps > 0:
            return error_response(
                code="SERVICE_HAS_APPLICATIONS",
                message=f"Cannot delete service '{slug}' because it has {existing_apps} active citizen applications. Set its availability to 'Unavailable' instead.",
                status_code=400
            )

        now = datetime.now(timezone.utc)
        # Soft delete by default
        services_col.update_one({"slug": slug}, {"$set": {"is_deleted": True, "is_active": False, "deleted_at": now}})

        log_audit(
            actor_id=session.get("user_id"),
            actor_role="admin",
            action="SERVICE_DELETED",
            target_collection="services",
            target_id=slug,
            before_after_summary={"slug": slug, "name": service.get("name")},
            ip=request.remote_addr
        )

        return success_response(data={"slug": slug, "message": f"Service '{service.get('name')}' deleted successfully."})
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


# ==============================================================================
# 5. CITIZENS MANAGEMENT (FULL DETAIL, EDIT, SUSPEND, DELETE, RESTORE, EXPORT)
# ==============================================================================

@admin_portal_bp.route("/citizens", methods=["GET"])
@admin_required
def list_admin_citizens():
    """Lists registered citizens with search, status filters, sorting, and pagination."""
    try:
        users_col = get_collection("users")
        apps_col = get_collection("applications")
        cmps_col = get_collection("complaints")

        # Admin accounts are NEVER listed or counted as citizens
        query = {"role": "citizen"}

        status_param = request.args.get("status", "ALL")
        if status_param == "deleted":
            query["is_deleted"] = True
        else:
            query["is_deleted"] = {"$ne": True}
            if status_param == "active":
                query["is_active"] = True
            elif status_param in ["suspended", "deactivated"]:
                query["is_active"] = False
            elif status_param == "unverified":
                query["is_verified"] = False

        verification_param = request.args.get("verification") or request.args.get("verified", "ALL")
        if verification_param in ["verified", "true", True]:
            query["is_verified"] = True
        elif verification_param in ["unverified", "false", False]:
            query["is_verified"] = False

        search_q = request.args.get("q", "").strip()
        if search_q:
            query["$or"] = [
                {"full_name": {"$regex": search_q, "$options": "i"}},
                {"name": {"$regex": search_q, "$options": "i"}},
                {"email": {"$regex": search_q, "$options": "i"}},
                {"mobile": {"$regex": search_q, "$options": "i"}},
                {"phone": {"$regex": search_q, "$options": "i"}}
            ]

        total_records = safe_count(users_col, query)
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

        sort_param = request.args.get("sort")
        sort_by = request.args.get("sort_by")
        sort_dir_param = request.args.get("sort_dir")

        sort_field = "created_at"
        sort_dir = -1
        if sort_param == "oldest":
            sort_dir = 1
        elif sort_param == "name_asc":
            sort_field = "full_name"
            sort_dir = 1
        elif sort_by:
            sort_field = "full_name" if sort_by in ["name", "full_name"] else "created_at"
            sort_dir = 1 if sort_dir_param == "asc" else -1

        cursor = users_col.find(query).sort(sort_field, sort_dir).skip(skip).limit(limit)

        citizens = []
        for user in cursor:
            user_id = user["_id"]
            user_id_str = str(user_id)
            user_email = user.get("email")

            app_count = safe_count(apps_col, {
                "$or": [{"user_id": {"$in": [user_id, user_id_str]}}, {"user_email": user_email}],
                "is_deleted": {"$ne": True}
            })
            cmp_count = safe_count(cmps_col, {
                "$or": [{"user_id": {"$in": [user_id, user_id_str]}}, {"user_email": user_email}],
                "is_deleted": {"$ne": True}
            })
            created_at_val = user.get("created_at")
            created_at_str = created_at_val.isoformat() if isinstance(created_at_val, datetime) else str(created_at_val or "")
            last_login_val = user.get("last_login_at")
            last_login_str = last_login_val.isoformat() if isinstance(last_login_val, datetime) else str(last_login_val or "")

            citizens.append({
                "id": user_id_str,
                "name": user.get("full_name") or user.get("name", "Citizen"),
                "email": user_email,
                "phone": user.get("mobile") or user.get("phone", ""),
                "address": user.get("address", ""),
                "is_active": user.get("is_active", True),
                "is_verified": user.get("is_verified", False),
                "is_deleted": user.get("is_deleted", False),
                "suspension_reason": user.get("suspension_reason", ""),
                "applications_count": app_count,
                "complaints_count": cmp_count,
                "last_login_at": last_login_str,
                "created_at": created_at_str
            })

        return success_response(data={
            "citizens": citizens,
            "pagination": {
                "page": page,
                "limit": limit,
                "total_records": total_records,
                "total_pages": total_pages
            }
        })
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/citizens/<citizen_id>", methods=["GET"])
@admin_required
def get_admin_citizen_detail(citizen_id):
    """Retrieves full citizen profile along with tabs for applications, grievances, audit logs, and notifications."""
    try:
        users_col = get_collection("users")
        apps_col = get_collection("applications")
        cmps_col = get_collection("complaints")
        audit_col = get_collection("audit_logs")
        notif_col = get_collection("notifications")

        try:
            obj_id = ObjectId(citizen_id)
        except Exception:
            return error_response(code="INVALID_ID", message="Invalid citizen ID format.", status_code=400)

        user = users_col.find_one({"_id": obj_id, "role": "citizen"})
        if not user:
            return error_response(code="USER_NOT_FOUND", message="Citizen record not found.", status_code=404)

        user_email = user.get("email")

        # Applications
        user_apps = list(apps_col.find({
            "$or": [{"user_id": {"$in": [obj_id, citizen_id]}}, {"user_email": user_email}],
            "is_deleted": {"$ne": True}
        }).sort("created_at", -1))
        applications = [
            {
                "application_id": app.get("application_id"),
                "service_name": app.get("service_name"),
                "category": app.get("category"),
                "status": app.get("status"),
                "created_at": app.get("created_at").isoformat() if isinstance(app.get("created_at"), datetime) else str(app.get("created_at"))
            }
            for app in user_apps
        ]

        # Grievances
        user_cmps = list(cmps_col.find({
            "$or": [{"user_id": {"$in": [obj_id, citizen_id]}}, {"user_email": user_email}],
            "is_deleted": {"$ne": True}
        }).sort("created_at", -1))
        complaints = [
            {
                "complaint_id": cmp.get("complaint_id"),
                "title": cmp.get("title"),
                "department": cmp.get("department"),
                "status": cmp.get("status"),
                "created_at": cmp.get("created_at").isoformat() if isinstance(cmp.get("created_at"), datetime) else str(cmp.get("created_at"))
            }
            for cmp in user_cmps
        ]

        # Activity / Audit logs related to this citizen
        activity_cursor = audit_col.find({
            "$or": [
                {"target_id": citizen_id},
                {"actor_id": citizen_id},
                {"target_id": user_email}
            ]
        }).sort("timestamp", -1).limit(20)
        activity_logs = []
        for log in activity_cursor:
            ts = log.get("timestamp")
            activity_logs.append({
                "action": log.get("action"),
                "actor_role": log.get("actor_role"),
                "summary": log.get("before_after_summary") or {},
                "timestamp": ts.isoformat() if isinstance(ts, datetime) else str(ts or "")
            })

        # Notifications sent to this citizen
        notif_cursor = notif_col.find({
            "$or": [{"user_id": {"$in": [obj_id, citizen_id]}}, {"user_email": user_email}]
        }).sort("created_at", -1).limit(20)
        notifications = []
        for n in notif_cursor:
            dt = n.get("created_at")
            notifications.append({
                "title": n.get("title", "Notification"),
                "message": n.get("message", ""),
                "is_read": n.get("is_read", False),
                "created_at": dt.isoformat() if isinstance(dt, datetime) else str(dt or "")
            })

        created_at_val = user.get("created_at")
        created_at_str = created_at_val.isoformat() if isinstance(created_at_val, datetime) else str(created_at_val or "")
        last_login_val = user.get("last_login_at")
        last_login_str = last_login_val.isoformat() if isinstance(last_login_val, datetime) else str(last_login_val or "")

        # Masked ID
        raw_id = user.get("aadhaar") or user.get("national_id") or citizen_id
        id_masked = f"XXXX-XXXX-{raw_id[-4:]}" if len(raw_id) >= 4 else "XXXX-XXXX-0000"

        citizen_dict = {
            "id": str(user["_id"]),
            "name": user.get("full_name") or user.get("name", "Citizen"),
            "email": user_email,
            "phone": user.get("mobile") or user.get("phone", ""),
            "address": user.get("address", ""),
            "id_masked": id_masked,
            "is_active": user.get("is_active", True),
            "is_verified": user.get("is_verified", False),
            "is_deleted": user.get("is_deleted", False),
            "suspension_reason": user.get("suspension_reason", ""),
            "created_at": created_at_str,
            "last_login_at": last_login_str,
            "applications_count": len(applications),
            "complaints_count": len(complaints)
        }

        res_data = dict(citizen_dict)
        res_data["citizen"] = citizen_dict
        res_data["applications"] = applications
        res_data["complaints"] = complaints
        res_data["activity_logs"] = activity_logs
        res_data["notifications"] = notifications

        return success_response(data=res_data)
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/citizens/<citizen_id>", methods=["PUT"])
@admin_required
@csrf_protect
def update_citizen_details(citizen_id):
    """Updates personal details of a citizen profile with validation and audit logging."""
    try:
        try:
            obj_id = ObjectId(citizen_id)
        except Exception:
            return error_response(code="INVALID_ID", message="Invalid citizen ID format.", status_code=400)

        users_col = get_collection("users")
        user = users_col.find_one({"_id": obj_id, "role": "citizen"})
        if not user:
            return error_response(code="USER_NOT_FOUND", message="Citizen record not found.", status_code=404)

        body = request.get_json(silent=True) or {}
        update_fields = {}
        before_state = {}

        if "name" in body or "full_name" in body:
            new_name = (body.get("full_name") or body.get("name") or "").strip()
            if len(new_name) < 2:
                return error_response(code="VALIDATION_ERROR", message="Name must be at least 2 characters.", status_code=400)
            update_fields["full_name"] = new_name
            update_fields["name"] = new_name
            before_state["full_name"] = user.get("full_name") or user.get("name")

        if "phone" in body or "mobile" in body:
            new_phone = (body.get("mobile") or body.get("phone") or "").strip()
            update_fields["mobile"] = new_phone
            update_fields["phone"] = new_phone
            before_state["mobile"] = user.get("mobile") or user.get("phone")

        if "address" in body:
            new_address = body.get("address", "").strip()
            update_fields["address"] = new_address
            before_state["address"] = user.get("address")

        if "email" in body:
            new_email = body.get("email", "").strip().lower()
            ok_email, sanitized_email = validate_email(new_email)
            if not ok_email:
                return error_response(code="VALIDATION_ERROR", message="Invalid email address format.", status_code=400)
            if sanitized_email != user.get("email"):
                existing = users_col.find_one({"email": sanitized_email, "_id": {"$ne": obj_id}})
                if existing:
                    return error_response(code="EMAIL_EXISTS", message="This email is already registered to another user.", status_code=400)
                update_fields["email"] = sanitized_email
                before_state["email"] = user.get("email")

        if not update_fields:
            return error_response(code="NO_CHANGES", message="No fields provided to update.", status_code=400)

        update_fields["updated_at"] = datetime.now(timezone.utc)
        users_col.update_one({"_id": obj_id}, {"$set": update_fields})

        log_audit(
            actor_id=session.get("user_id"),
            actor_role="admin",
            action="CITIZEN_PROFILE_UPDATED",
            target_collection="users",
            target_id=citizen_id,
            before_after_summary={"before": before_state, "after": update_fields},
            ip=request.remote_addr
        )

        return success_response(data={"id": citizen_id, "message": "Citizen details updated successfully."})
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/citizens/<citizen_id>/status", methods=["PATCH"])
@admin_required
@csrf_protect
def toggle_citizen_status(citizen_id):
    """Suspends or reactivates a citizen account with mandatory reason for suspension."""
    try:
        try:
            obj_id = ObjectId(citizen_id)
        except Exception:
            return error_response(code="INVALID_ID", message="Invalid citizen ID format.", status_code=400)

        body = request.get_json(silent=True) or {}
        if "is_active" not in body:
            return error_response(code="VALIDATION_ERROR", message="Field 'is_active' (boolean) is required.", status_code=400)

        is_active = bool(body["is_active"])
        reason = body.get("reason", "").strip() or body.get("suspension_reason", "").strip()

        if not is_active and len(reason) < 3:
            return error_response(
                code="SUSPENSION_REASON_REQUIRED",
                message="A documented suspension reason is mandatory when suspending an account.",
                status_code=400
            )

        users_col = get_collection("users")
        user = users_col.find_one({"_id": obj_id})
        if not user:
            return error_response(code="USER_NOT_FOUND", message="User record not found.", status_code=404)

        current_admin_id = str(session.get("user_id", ""))
        if str(user["_id"]) == current_admin_id:
            return error_response(code="CANNOT_SUSPEND_SELF", message="Administrators cannot suspend their own account.", status_code=400)

        old_status = user.get("is_active", True)
        update_fields = {
            "is_active": is_active,
            "suspension_reason": reason if not is_active else "",
            "updated_at": datetime.now(timezone.utc)
        }
        users_col.update_one({"_id": obj_id}, {"$set": update_fields})

        log_audit(
            actor_id=session.get("user_id"),
            actor_role="admin",
            action="CITIZEN_STATUS_SUSPENDED" if not is_active else "CITIZEN_STATUS_ACTIVATED",
            target_collection="users",
            target_id=citizen_id,
            before_after_summary={"citizen_id": citizen_id, "before": old_status, "after": is_active, "reason": reason},
            ip=request.remote_addr
        )

        return success_response(data={
            "id": citizen_id,
            "is_active": is_active,
            "suspension_reason": update_fields["suspension_reason"],
            "message": f"Citizen account has been {'reactivated' if is_active else 'suspended'}."
        })
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/citizens/<citizen_id>/verify", methods=["PATCH"])
@admin_required
@csrf_protect
def verify_citizen(citizen_id):
    """Marks a citizen identity as physically/documentarily verified or unverified."""
    try:
        try:
            obj_id = ObjectId(citizen_id)
        except Exception:
            return error_response(code="INVALID_ID", message="Invalid citizen ID format.", status_code=400)

        body = request.get_json(silent=True) or {}
        new_verify = body.get("is_verified", True)

        users_col = get_collection("users")
        now = datetime.now(timezone.utc)
        update_fields = {
            "is_verified": bool(new_verify),
            "verified_at": now if new_verify else None,
            "verified_by": session.get("email") if new_verify else None,
            "updated_at": now
        }
        res = users_col.update_one(
            {"_id": obj_id, "role": "citizen"},
            {"$set": update_fields}
        )
        if res.matched_count == 0:
            return error_response(code="NOT_FOUND", message="Citizen not found.", status_code=404)

        log_audit(
            actor_id=session.get("user_id"),
            actor_role="admin",
            action="CITIZEN_VERIFICATION_TOGGLED",
            target_collection="users",
            target_id=citizen_id,
            before_after_summary={"citizen_id": citizen_id, "is_verified": bool(new_verify)},
            ip=request.remote_addr
        )

        return success_response({
            "is_verified": bool(new_verify),
            "message": f"Citizen identity {'verified' if new_verify else 'marked unverified'} successfully."
        })
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/citizens/<citizen_id>/reset-password", methods=["POST"])
@admin_required
@csrf_protect
def admin_reset_citizen_password(citizen_id):
    """Generates a secure password reset link for the citizen without revealing plaintext passwords."""
    try:
        try:
            obj_id = ObjectId(citizen_id)
        except Exception:
            return error_response(code="INVALID_ID", message="Invalid ID format.", status_code=400)

        users_col = get_collection("users")
        user = users_col.find_one({"_id": obj_id, "role": "citizen"})
        if not user:
            return error_response(code="USER_NOT_FOUND", message="Citizen record not found.", status_code=404)

        reset_token = secrets.token_urlsafe(32)
        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(hours=24)

        resets_col = get_collection("password_resets")
        resets_col.insert_one({
            "token": reset_token,
            "user_id": obj_id,
            "user_email": user.get("email"),
            "created_at": now,
            "expires_at": expires_at,
            "used": False
        })

        log_audit(
            actor_id=session.get("user_id"),
            actor_role="admin",
            action="PASSWORD_RESET_LINK_DISPATCHED",
            target_collection="users",
            target_id=citizen_id,
            before_after_summary={"email": user.get("email"), "expires_at": expires_at.isoformat()},
            ip=request.remote_addr
        )

        return success_response({
            "message": f"A secure password reset link has been dispatched for {user.get('email')}.",
            "reset_url": f"reset-password.html?token={reset_token}"
        })
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/citizens/<citizen_id>", methods=["DELETE"])
@admin_required
@csrf_protect
def delete_citizen(citizen_id):
    """Deletes or soft-deletes a citizen with confirmation modal verification and active application guard."""
    try:
        try:
            obj_id = ObjectId(citizen_id)
        except Exception:
            return error_response(code="INVALID_ID", message="Invalid ID format.", status_code=400)

        users_col = get_collection("users")
        apps_col = get_collection("applications")

        user = users_col.find_one({"_id": obj_id, "role": "citizen"})
        if not user:
            return error_response(code="USER_NOT_FOUND", message="Citizen record not found.", status_code=404)

        current_admin_id = str(session.get("user_id", ""))
        if str(user["_id"]) == current_admin_id:
            return error_response(code="CANNOT_DELETE_SELF", message="Administrators cannot delete their own account.", status_code=400)

        body = request.get_json(silent=True) or {}
        confirmation = (
            body.get("confirmation") or
            body.get("confirm_token") or
            request.args.get("confirmation") or
            request.args.get("confirm_token") or
            ""
        ).strip()
        user_email = user.get("email", "")

        # Require typing DELETE or citizen's email
        if confirmation != "DELETE" and confirmation.lower() != user_email.lower():
            return error_response(
                code="CONFIRMATION_REQUIRED",
                message=f"To confirm deletion, please type 'DELETE' or the citizen email '{user_email}'.",
                status_code=400
            )

        # Check for active applications (including Pending)
        is_force = body.get("force") is True or request.args.get("force") in ["true", "1"]
        active_apps = safe_count(apps_col, {
            "$or": [{"user_id": {"$in": [obj_id, citizen_id]}}, {"user_email": user_email}],
            "status": {"$in": ["Pending", "Submitted", "Under Review", "Action Required"]},
            "is_deleted": {"$ne": True}
        })
        if active_apps > 0 and not is_force:
            return error_response(
                code="ACTIVE_APPLICATIONS_EXIST",
                message=f"This citizen has {active_apps} active/pending applications. Process or cancel their applications first, or check force confirmation.",
                status_code=409
            )

        now = datetime.now(timezone.utc)
        user_admin_role = session.get("admin_role") or session.get("role")
        is_permanent = (
            (body.get("permanent") is True or request.args.get("permanent") in ["true", "1"])
            and user_admin_role == "super_admin"
        )

        if is_permanent:
            users_col.delete_one({"_id": obj_id})
            action_name = "CITIZEN_PERMANENTLY_DELETED"
            msg = f"Citizen '{user_email}' permanently removed from system."
        else:
            users_col.update_one({"_id": obj_id}, {"$set": {"is_deleted": True, "deleted_at": now}})
            action_name = "CITIZEN_SOFT_DELETED"
            msg = f"Citizen '{user_email}' soft-deleted (can be restored from Deleted view)."

        log_audit(
            actor_id=session.get("user_id"),
            actor_role="admin",
            action=action_name,
            target_collection="users",
            target_id=citizen_id,
            before_after_summary={"email": user_email, "permanent": is_permanent},
            ip=request.remote_addr
        )

        return success_response({"message": msg, "permanent": is_permanent})
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/citizens/<citizen_id>/restore", methods=["PATCH"])
@admin_required
@csrf_protect
def restore_citizen(citizen_id):
    """Restores a soft-deleted citizen record."""
    try:
        try:
            obj_id = ObjectId(citizen_id)
        except Exception:
            return error_response(code="INVALID_ID", message="Invalid ID format.", status_code=400)

        users_col = get_collection("users")
        user = users_col.find_one({"_id": obj_id, "role": "citizen"})
        if not user:
            return error_response(code="USER_NOT_FOUND", message="Citizen not found.", status_code=404)

        now = datetime.now(timezone.utc)
        users_col.update_one({"_id": obj_id}, {"$set": {"is_deleted": False, "deleted_at": None, "updated_at": now}})

        log_audit(
            actor_id=session.get("user_id"),
            actor_role="admin",
            action="CITIZEN_RESTORED",
            target_collection="users",
            target_id=citizen_id,
            before_after_summary={"email": user.get("email")},
            ip=request.remote_addr
        )

        return success_response({"message": f"Citizen '{user.get('email')}' restored successfully."})
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/citizens/export", methods=["GET"])
@admin_required
def export_citizens_csv():
    """Exports registered citizen users to CSV file."""
    try:
        users_col = get_collection("users")
        apps_col = get_collection("applications")
        cmps_col = get_collection("complaints")

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["Citizen ID", "Full Name", "Email Address", "Phone Number", "Address", "Verification Status", "Account Status", "Applications Count", "Grievances Count", "Registration Date"])

        cursor = users_col.find({"role": "citizen", "is_deleted": {"$ne": True}}).sort("created_at", -1)
        for u in cursor:
            uid = u["_id"]
            u_email = u.get("email")
            app_count = safe_count(apps_col, {"$or": [{"user_id": uid}, {"user_email": u_email}], "is_deleted": {"$ne": True}})
            cmp_count = safe_count(cmps_col, {"$or": [{"user_id": uid}, {"user_email": u_email}], "is_deleted": {"$ne": True}})
            reg_date = u.get("created_at").isoformat() if isinstance(u.get("created_at"), datetime) else str(u.get("created_at") or "")

            writer.writerow([
                str(uid),
                u.get("full_name") or u.get("name", "Citizen"),
                u_email,
                u.get("mobile") or u.get("phone", ""),
                u.get("address", ""),
                "Verified" if u.get("is_verified") else "Unverified",
                "Active" if u.get("is_active", True) else "Suspended",
                app_count,
                cmp_count,
                reg_date
            ])

        csv_content = output.getvalue()
        output.close()
        return Response(
            csv_content,
            mimetype="text/csv",
            headers={"Content-Disposition": "attachment;filename=municipal_registered_citizens.csv"}
        )
    except Exception as exc:
        return error_response(code="EXPORT_ERROR", message=str(exc), status_code=500)


@admin_portal_bp.route("/search", methods=["GET"])
@admin_required
def admin_global_search():
    """Global search across applications, grievances, citizens, and services."""
    q = request.args.get("q", "").strip()
    if not q or len(q) < 2:
        return success_response(data={"applications": [], "complaints": [], "citizens": [], "services": []})

    apps_col = get_collection("applications")
    cmps_col = get_collection("complaints")
    users_col = get_collection("users")
    services_col = get_collection("services")

    reg = {"$regex": q, "$options": "i"}

    # Search applications
    apps_matches = list(apps_col.find(
        {"$or": [{"application_id": reg}, {"user_name": reg}, {"user_email": reg}, {"service_name": reg}], "is_deleted": {"$ne": True}},
        {"application_id": 1, "service_name": 1, "user_name": 1, "status": 1, "created_at": 1}
    ).limit(5))

    # Search complaints
    cmps_matches = list(cmps_col.find(
        {"$or": [{"complaint_id": reg}, {"title": reg}, {"user_name": reg}, {"department": reg}], "is_deleted": {"$ne": True}},
        {"complaint_id": 1, "title": 1, "department": 1, "status": 1, "user_name": 1, "created_at": 1}
    ).limit(5))

    # Search citizens (Citizen role only)
    citizens_matches = list(users_col.find(
        {"role": "citizen", "$or": [{"full_name": reg}, {"name": reg}, {"email": reg}, {"mobile": reg}], "is_deleted": {"$ne": True}},
        {"full_name": 1, "name": 1, "email": 1, "mobile": 1, "is_verified": 1, "is_active": 1}
    ).limit(5))

    # Search services
    services_matches = list(services_col.find(
        {"$or": [{"name": reg}, {"slug": reg}, {"category": reg}, {"department": reg}], "is_deleted": {"$ne": True}},
        {"name": 1, "slug": 1, "category": 1, "department": 1, "availability": 1}
    ).limit(5))

    return success_response(data={
        "applications": [
            {
                "id": a.get("application_id"),
                "title": f"{a.get('application_id')} - {a.get('service_name')}",
                "subtitle": f"{a.get('user_name', 'Citizen')} • {a.get('status')}",
                "url": f"admin-applications.html?q={a.get('application_id')}"
            } for a in apps_matches
        ],
        "complaints": [
            {
                "id": c.get("complaint_id"),
                "title": f"{c.get('complaint_id')} - {c.get('title')}",
                "subtitle": f"{c.get('department')} • {c.get('status')}",
                "url": f"admin-complaints.html?q={c.get('complaint_id')}"
            } for c in cmps_matches
        ],
        "citizens": [
            {
                "id": str(u.get("_id")),
                "title": u.get("full_name") or u.get("name", "Citizen"),
                "subtitle": f"{u.get('email')} • {u.get('mobile', '')}",
                "url": f"citizens.html?q={u.get('email')}"
            } for u in citizens_matches
        ],
        "services": [
            {
                "id": s.get("slug"),
                "title": s.get("name"),
                "subtitle": f"{s.get('department')} • {s.get('availability')}",
                "url": f"service-management.html?q={s.get('slug')}"
            } for s in services_matches
        ]
    })


# ==============================================================================
# 6. DEPARTMENTS & STAFF MANAGEMENT (RBAC)
# ==============================================================================

DEFAULT_MUNICIPAL_DEPARTMENTS = [
    {"name": "Water Supply & Sewerage", "description": "Drinking water supply, pipeline repairs, sewer connections, and drainage."},
    {"name": "Roads, Bridges & Traffic Infrastructure", "description": "Road maintenance, pothole repairs, street signaling, and footpath upkeep."},
    {"name": "Solid Waste Management & Sanitation", "description": "Door-to-door garbage collection, street sweeping, dump yards, and sanitation."},
    {"name": "Public Health & Vector Control", "description": "Mosquito control, public health clinics, food safety inspections, and sanitization."},
    {"name": "Town Planning & Building Permissions", "description": "Building permits, occupancy certificates, zoning compliance, and encroachment removal."},
    {"name": "Revenue, Property Tax & Licensing", "description": "Property tax assessment, trade licenses, municipal asset leasing, and civic revenues."},
    {"name": "Street Lighting & Electrical Works", "description": "LED streetlight installation, faulty light maintenance, and pole electrical repairs."},
    {"name": "Horticulture, Parks & Urban Greening", "description": "Public park maintenance, tree pruning, green corridors, and civic nurseries."},
    {"name": "General Administration", "description": "Citizen grievance redressal, RTI compliance, public inquiries, and administrative support."}
]


@admin_portal_bp.route("/departments", methods=["GET"])
@admin_required
def get_admin_departments():
    """Returns list of municipal departments."""
    try:
        dept_col = get_collection("departments")
        if dept_col.count_documents({}) == 0:
            now = datetime.now(timezone.utc)
            for d in DEFAULT_MUNICIPAL_DEPARTMENTS:
                dept_col.insert_one({
                    "name": d["name"],
                    "description": d["description"],
                    "created_at": now
                })

        departments = list(dept_col.find({}, {"_id": 0}).sort("name", 1))
        return success_response(data=departments)
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/departments", methods=["POST"])
@admin_required
@csrf_protect
def add_admin_department():
    """Adds a new administrative department."""
    try:
        body = request.get_json(silent=True) or {}
        name = body.get("name", "").strip()
        description = body.get("description", "").strip()

        if not name or len(name) < 3:
            return error_response(code="VALIDATION_ERROR", message="Department name is required (min 3 chars).", status_code=400)

        dept_col = get_collection("departments")
        if dept_col.find_one({"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}):
            return error_response(code="DEPARTMENT_EXISTS", message=f"Department '{name}' already exists.", status_code=400)

        now = datetime.now(timezone.utc)
        doc = {
            "name": name,
            "description": description or f"{name} Department",
            "created_at": now
        }
        dept_col.insert_one(doc)

        log_audit(
            actor_id=session.get("user_id"),
            actor_role="admin",
            action="DEPARTMENT_CREATED",
            target_collection="departments",
            target_id=name,
            before_after_summary={"name": name, "description": description},
            ip=request.remote_addr
        )

        return success_response(data={"name": name, "description": description, "message": f"Department '{name}' created."}, status_code=201)
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/departments/<name>", methods=["DELETE"])
@admin_required
@csrf_protect
def delete_admin_department(name):
    """Deletes a department if no active complaints are assigned."""
    try:
        dept_col = get_collection("departments")
        cmps_col = get_collection("complaints")

        active_cmps = safe_count(cmps_col, {
            "department": name,
            "status": {"$in": ["Submitted", "Under Review", "Assigned", "In Progress"]}
        })
        if active_cmps > 0:
            return error_response(
                code="DEPARTMENT_HAS_ACTIVE_COMPLAINTS",
                message=f"Cannot delete department '{name}' because it has {active_cmps} active grievances assigned.",
                status_code=400
            )

        res = dept_col.delete_one({"name": name})
        if res.deleted_count == 0:
            return error_response(code="DEPARTMENT_NOT_FOUND", message=f"Department '{name}' not found.", status_code=404)

        return success_response(data={"name": name, "message": f"Department '{name}' deleted."})
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/staff", methods=["GET"])
@admin_required
def list_admin_staff():
    """Lists portal administrators, officers, and staff members."""
    try:
        users_col = get_collection("users")
        cursor = users_col.find(
            {"role": {"$in": ["admin", "super_admin", "officer", "viewer"]}, "is_deleted": {"$ne": True}},
            {"password_hash": 0}
        ).sort("created_at", -1)

        staff_list = []
        for u in cursor:
            staff_list.append({
                "id": str(u["_id"]),
                "name": u.get("full_name") or u.get("name", "Staff Officer"),
                "email": u.get("email"),
                "role": u.get("role", "admin"),
                "admin_role": u.get("admin_role") or u.get("role", "admin"),
                "department": u.get("department", "Municipal Administration"),
                "is_active": u.get("is_active", True),
                "created_at": u.get("created_at").isoformat() if isinstance(u.get("created_at"), datetime) else str(u.get("created_at") or "")
            })

        return success_response(data=staff_list)
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/staff", methods=["POST"])
@admin_role_required("super_admin", "admin")
@csrf_protect
def create_admin_staff():
    """Creates a new officer or administrative account with role-based permissions."""
    try:
        body = request.get_json(silent=True) or {}
        name = body.get("name", "").strip()
        email = body.get("email", "").strip().lower()
        password = body.get("password", "")
        role = body.get("role", "officer").strip()
        department = body.get("department", "General Administration").strip()

        ok_email, norm_email = validate_email(email)
        if not ok_email:
            return error_response(code="INVALID_EMAIL", message="Valid municipal email required.", status_code=400)

        ok_pwd, pwd_err = validate_password(password)
        if not ok_pwd:
            return error_response(code="INVALID_PASSWORD", message=pwd_err, status_code=400)

        if role not in STAFF_ROLES:
            return error_response(code="INVALID_ROLE", message=f"Role must be one of {STAFF_ROLES}.", status_code=400)

        users_col = get_collection("users")
        if users_col.find_one({"email": norm_email}):
            return error_response(code="EMAIL_EXISTS", message="An account with this email already exists.", status_code=400)

        now = datetime.now(timezone.utc)
        doc = {
            "full_name": name,
            "name": name,
            "email": norm_email,
            "password_hash": hash_password(password),
            "role": "admin" if role in ["super_admin", "admin"] else role,
            "admin_role": role,
            "department": department,
            "is_active": True,
            "is_deleted": False,
            "created_at": now,
            "updated_at": now
        }
        res = users_col.insert_one(doc)

        log_audit(
            actor_id=session.get("user_id"),
            actor_role=session.get("admin_role", "admin"),
            action="STAFF_ACCOUNT_CREATED",
            target_collection="users",
            target_id=str(res.inserted_id),
            before_after_summary={"email": norm_email, "role": role, "department": department},
            ip=request.remote_addr
        )

        return success_response(data={"id": str(res.inserted_id), "email": norm_email, "message": "Staff account created successfully."}, status_code=201)
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/staff/<user_id>/status", methods=["PATCH"])
@admin_role_required("super_admin", "admin")
@csrf_protect
def toggle_staff_status(user_id):
    """Activates or deactivates a staff officer account."""
    try:
        try:
            obj_id = ObjectId(user_id)
        except Exception:
            return error_response(code="INVALID_ID", message="Invalid staff ID format.", status_code=400)

        body = request.get_json(silent=True) or {}
        is_active = bool(body.get("is_active", True))

        users_col = get_collection("users")
        users_col.update_one({"_id": obj_id}, {"$set": {"is_active": is_active, "updated_at": datetime.now(timezone.utc)}})

        return success_response({"message": f"Staff status set to {'active' if is_active else 'inactive'}."})
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


# ==============================================================================
# 7. REPORTS & CSV EXPORT
# ==============================================================================

@admin_portal_bp.route("/reports", methods=["GET"])
@admin_required
def get_admin_reports():
    """Aggregated statistical analytics across services, applications, and complaints."""
    try:
        apps_col = get_collection("applications")
        cmps_col = get_collection("complaints")
        services_col = get_collection("services")
        users_col = get_collection("users")

        # 1. Applications by Service
        apps_by_service_pipeline = [
            {"$match": {"is_deleted": {"$ne": True}}},
            {"$group": {"_id": "$service_name", "count": {"$sum": 1}}},
            {"$sort": {"count": -1}}
        ]
        try:
            apps_by_service = [
                {"service": item["_id"] or "Unknown", "count": item["count"]}
                for item in apps_col.aggregate(apps_by_service_pipeline)
            ]
        except Exception:
            apps_by_service = []

        # 2. Applications by Status
        apps_by_status_pipeline = [
            {"$match": {"is_deleted": {"$ne": True}}},
            {"$group": {"_id": "$status", "count": {"$sum": 1}}},
            {"$sort": {"count": -1}}
        ]
        try:
            apps_by_status = [
                {"status": item["_id"] or "Unknown", "count": item["count"]}
                for item in apps_col.aggregate(apps_by_status_pipeline)
            ]
        except Exception:
            apps_by_status = []

        # 3. Complaints by Department
        cmps_by_dept_pipeline = [
            {"$match": {"is_deleted": {"$ne": True}}},
            {"$group": {"_id": "$department", "count": {"$sum": 1}}},
            {"$sort": {"count": -1}}
        ]
        try:
            cmps_by_department = [
                {"department": item["_id"] or "General", "count": item["count"]}
                for item in cmps_col.aggregate(cmps_by_dept_pipeline)
            ]
        except Exception:
            cmps_by_department = []

        # 4. Complaints by Status
        cmps_by_status_pipeline = [
            {"$match": {"is_deleted": {"$ne": True}}},
            {"$group": {"_id": "$status", "count": {"$sum": 1}}},
            {"$sort": {"count": -1}}
        ]
        try:
            cmps_by_status = [
                {"status": item["_id"] or "Unknown", "count": item["count"]}
                for item in cmps_col.aggregate(cmps_by_status_pipeline)
            ]
        except Exception:
            cmps_by_status = []

        # 5. Summary KPI metrics
        total_apps = safe_count(apps_col, {"is_deleted": {"$ne": True}})
        total_cmps = safe_count(cmps_col, {"is_deleted": {"$ne": True}})
        approved_apps = safe_count(apps_col, {"status": "Approved", "is_deleted": {"$ne": True}})
        resolved_cmps = safe_count(cmps_col, {"status": "Resolved", "is_deleted": {"$ne": True}})
        active_services = safe_count(services_col, {"availability": {"$in": ["Available", "Active"]}, "is_deleted": {"$ne": True}})
        total_citizens = safe_count(users_col, {"role": "citizen", "is_deleted": {"$ne": True}})

        return success_response(data={
            "summary": {
                "total_applications": total_apps,
                "approved_applications": approved_apps,
                "total_complaints": total_cmps,
                "resolved_complaints": resolved_cmps,
                "active_services": active_services,
                "registered_citizens": total_citizens
            },
            "applications_by_service": apps_by_service,
            "applications_by_status": apps_by_status,
            "complaints_by_department": cmps_by_department,
            "complaints_by_status": cmps_by_status
        })
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/reports/export", methods=["GET"])
@admin_required
def export_reports_csv():
    """Exports structured data to CSV, Excel, or PDF format for applications, grievances, or citizens with date filtering."""
    export_type = request.args.get("type", "applications").lower()
    export_fmt = request.args.get("format", "csv").lower()
    range_param = request.args.get("range", "all")
    start_dt, end_dt, _, _ = parse_date_range(range_param)

    output = io.StringIO()
    writer = csv.writer(output)

    try:
        title = f"Municipal Operations - {export_type.capitalize()} Report"
        headers = []
        rows = []

        if export_type == "applications":
            apps_col = get_collection("applications")
            query = {"is_deleted": {"$ne": True}}
            if start_dt and end_dt:
                query["created_at"] = {"$gte": start_dt, "$lte": end_dt}
            cursor = apps_col.find(query).sort("created_at", -1)
            headers = ["Application ID", "Service Name", "Category", "Citizen Name", "Citizen Email", "Status", "Certificate No", "Created Date"]
            writer.writerow(headers)
            for doc in cursor:
                dt_str = doc.get("created_at").isoformat() if isinstance(doc.get("created_at"), datetime) else str(doc.get("created_at") or "")
                row = [
                    doc.get("application_id", ""),
                    doc.get("service_name", ""),
                    doc.get("category", ""),
                    doc.get("user_name", ""),
                    doc.get("user_email", ""),
                    doc.get("status", ""),
                    doc.get("certificate_number", ""),
                    dt_str
                ]
                writer.writerow(row)
                rows.append(row)
        elif export_type == "grievances":
            cmps_col = get_collection("complaints")
            query = {"is_deleted": {"$ne": True}}
            if start_dt and end_dt:
                query["created_at"] = {"$gte": start_dt, "$lte": end_dt}
            cursor = cmps_col.find(query).sort("created_at", -1)
            headers = ["Complaint ID", "Department", "Title", "Citizen Name", "Location", "Priority", "Status", "Created Date"]
            writer.writerow(headers)
            for doc in cursor:
                dt_str = doc.get("created_at").isoformat() if isinstance(doc.get("created_at"), datetime) else str(doc.get("created_at") or "")
                row = [
                    doc.get("complaint_id", ""),
                    doc.get("department", ""),
                    doc.get("title", ""),
                    doc.get("user_name", ""),
                    doc.get("location", ""),
                    doc.get("priority", "Medium"),
                    doc.get("status", ""),
                    dt_str
                ]
                writer.writerow(row)
                rows.append(row)
        elif export_type == "citizens":
            users_col = get_collection("users")
            apps_col = get_collection("applications")
            cmps_col = get_collection("complaints")
            query = {"role": "citizen", "is_deleted": {"$ne": True}}
            cursor = users_col.find(query).sort("created_at", -1)
            headers = ["Citizen ID", "Name", "Email", "Phone", "Address", "Verified", "Active", "Applications", "Grievances", "Registered Date"]
            writer.writerow(headers)
            for doc in cursor:
                uid = doc["_id"]
                u_email = doc.get("email")
                app_count = safe_count(apps_col, {"$or": [{"user_id": uid}, {"user_email": u_email}], "is_deleted": {"$ne": True}})
                cmp_count = safe_count(cmps_col, {"$or": [{"user_id": uid}, {"user_email": u_email}], "is_deleted": {"$ne": True}})
                dt_str = doc.get("created_at").isoformat() if isinstance(doc.get("created_at"), datetime) else str(doc.get("created_at") or "")
                row = [
                    str(uid),
                    doc.get("full_name") or doc.get("name", ""),
                    doc.get("email", ""),
                    doc.get("mobile") or doc.get("phone", ""),
                    doc.get("address", ""),
                    "Yes" if doc.get("is_verified") else "No",
                    "Active" if doc.get("is_active", True) else "Suspended",
                    str(app_count),
                    str(cmp_count),
                    dt_str
                ]
                writer.writerow(row)
                rows.append(row)
        else:
            return error_response(code="INVALID_EXPORT_TYPE", message="Supported types: applications, grievances, citizens.", status_code=400)

        # PDF format: render printable HTML document for instant browser printing/PDF save
        if export_fmt == "pdf":
            table_head_html = "".join([f"<th style='padding: 8px 12px; border: 1px solid #cbd5e1; background: #f8fafc; font-size: 11px; text-transform: uppercase;'>{h}</th>" for h in headers])
            table_rows_html = "".join([
                f"<tr>{''.join([f'<td style=\"padding: 8px 12px; border: 1px solid #e2e8f0; font-size: 12px;\">{cell}</td>' for cell in r])}</tr>"
                for r in rows
            ])
            pdf_html = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>{title}</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 40px; color: #0f172a; }}
    .header {{ border-bottom: 2px solid #dc2626; padding-bottom: 12px; margin-bottom: 24px; }}
    .title {{ font-size: 22px; font-weight: bold; color: #0f172a; margin: 0; }}
    .meta {{ font-size: 12px; color: #64748b; margin-top: 6px; }}
    table {{ width: 100%; border-collapse: collapse; margin-top: 16px; }}
    @media print {{ body {{ margin: 0; }} .no-print {{ display: none; }} }}
  </style>
</head>
<body>
  <div class="no-print" style="margin-bottom: 20px;">
    <button onclick="window.print()" style="background: #dc2626; color: white; border: none; padding: 8px 16px; border-radius: 4px; font-weight: bold; cursor: pointer;">🖨️ Print / Save as PDF</button>
  </div>
  <div class="header">
    <h1 class="title">Municipal Service Portal - {title}</h1>
    <div class="meta">Exported on {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')} • Date Range: {range_param.upper()} • Total Records: {len(rows)}</div>
  </div>
  <table>
    <thead><tr>{table_head_html}</tr></thead>
    <tbody>{table_rows_html or "<tr><td colspan='10' style='text-align: center; padding: 20px;'>No records found in this period.</td></tr>"}</tbody>
  </table>
</body>
</html>"""
            return Response(pdf_html, mimetype="text/html", headers={"Content-Disposition": f"inline;filename=municipal_{export_type}_{range_param}_report.html"})

        csv_content = output.getvalue()
        output.close()

        # Excel format: add UTF-8 BOM so Excel opens non-ASCII characters cleanly
        if export_fmt == "excel":
            excel_content = "\ufeff" + csv_content
            return Response(
                excel_content,
                mimetype="application/vnd.ms-excel; charset=utf-8",
                headers={"Content-Disposition": f"attachment;filename=municipal_{export_type}_{range_param}_report.csv"}
            )

        return Response(
            csv_content,
            mimetype="text/csv; charset=utf-8",
            headers={"Content-Disposition": f"attachment;filename=municipal_{export_type}_{range_param}_report.csv"}
        )
    except Exception as exc:
        return error_response(code="EXPORT_ERROR", message=str(exc), status_code=500)


# ==============================================================================
# 8. AUDIT LOGS
# ==============================================================================

@admin_portal_bp.route("/audit-logs", methods=["GET"])
@admin_required
def list_admin_audit_logs():
    """Retrieves paginated immutable audit records with filters."""
    try:
        audit_col = get_collection("audit_logs")
        query = {}

        action_filter = request.args.get("action", "").strip()
        if action_filter and action_filter != "ALL":
            query["action"] = action_filter

        actor_role_filter = request.args.get("actor_role", "").strip()
        if actor_role_filter and actor_role_filter != "ALL":
            query["actor_role"] = actor_role_filter

        target_col_filter = request.args.get("target_collection", "").strip()
        if target_col_filter and target_col_filter != "ALL":
            query["target_collection"] = target_col_filter

        # Date range filtering
        start_date_str = request.args.get("start_date", "").strip() or request.args.get("date_from", "").strip()
        end_date_str = request.args.get("end_date", "").strip() or request.args.get("date_to", "").strip()
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

        search_q = request.args.get("q", "").strip()
        if search_q:
            query["$or"] = [
                {"action": {"$regex": search_q, "$options": "i"}},
                {"target_id": {"$regex": search_q, "$options": "i"}},
                {"actor_id": {"$regex": search_q, "$options": "i"}},
                {"ip": {"$regex": search_q, "$options": "i"}}
            ]

        total_records = safe_count(audit_col, query)
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
            c_val = doc.get("created_at") or doc.get("timestamp")
            logs.append({
                "id": str(doc.get("_id")),
                "actor_id": doc.get("actor_id"),
                "actor_role": doc.get("actor_role"),
                "action": doc.get("action"),
                "target_collection": doc.get("target_collection"),
                "target_id": doc.get("target_id"),
                "before_after_summary": doc.get("before_after_summary") or {},
                "ip": doc.get("ip"),
                "created_at": c_val.isoformat() if isinstance(c_val, datetime) else str(c_val or "")
            })

        try:
            actions = sorted(audit_col.distinct("action"))
            cols = sorted(audit_col.distinct("target_collection"))
            roles = sorted(audit_col.distinct("actor_role"))
        except Exception:
            actions, cols, roles = [], [], []

        return success_response(data={
            "logs": logs,
            "pagination": {
                "page": page,
                "limit": limit,
                "total_records": total_records,
                "total_pages": total_pages
            },
            "filter_options": {
                "actions": actions,
                "target_collections": cols,
                "actor_roles": roles
            }
        })
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/audit-logs/<log_id>", methods=["GET"])
@admin_required
def get_admin_audit_log_detail(log_id):
    """Retrieves full audit entry by ObjectId."""
    try:
        try:
            obj_id = ObjectId(log_id)
        except Exception:
            return error_response(code="INVALID_ID", message="Invalid audit log ID format.", status_code=400)

        audit_col = get_collection("audit_logs")
        doc = audit_col.find_one({"_id": obj_id})
        if not doc:
            return error_response(code="LOG_NOT_FOUND", message="Audit record not found.", status_code=404)

        c_val = doc.get("created_at") or doc.get("timestamp")
        return success_response(data={
            "id": str(doc.get("_id")),
            "actor_id": doc.get("actor_id"),
            "actor_role": doc.get("actor_role"),
            "action": doc.get("action"),
            "target_collection": doc.get("target_collection"),
            "target_id": doc.get("target_id"),
            "before_after_summary": doc.get("before_after_summary") or {},
            "ip": doc.get("ip"),
            "created_at": c_val.isoformat() if isinstance(c_val, datetime) else str(c_val or "")
        })
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


# ==============================================================================
# 9. ANNOUNCEMENTS & SETTINGS
# ==============================================================================

@admin_portal_bp.route("/announcements", methods=["GET"])
@admin_required
def list_admin_announcements():
    """Lists announcements for citizen portal."""
    try:
        ann_col = get_collection("announcements")
        announcements = list(ann_col.find().sort("created_at", -1))
        data = []
        for a in announcements:
            data.append({
                "id": str(a["_id"]),
                "title": a.get("title"),
                "content": a.get("content"),
                "priority": a.get("priority", "info"),
                "is_active": a.get("is_active", True),
                "created_at": a.get("created_at").isoformat() if isinstance(a.get("created_at"), datetime) else str(a.get("created_at") or "")
            })
        return success_response(data=data)
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/announcements", methods=["POST"])
@admin_required
@csrf_protect
def create_admin_announcement():
    """Publishes a civic notice or advisory."""
    try:
        body = request.get_json(silent=True) or {}
        title = body.get("title", "").strip()
        content = body.get("content", "").strip()
        priority = body.get("priority", "info")

        if not title or not content:
            return error_response(code="VALIDATION_ERROR", message="Title and content are required.", status_code=400)

        now = datetime.now(timezone.utc)
        ann_col = get_collection("announcements")
        res = ann_col.insert_one({
            "title": title,
            "content": content,
            "priority": priority,
            "is_active": True,
            "created_at": now,
            "created_by": session.get("email")
        })

        return success_response({"id": str(res.inserted_id), "message": "Announcement published."}, status_code=201)
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/announcements/<ann_id>", methods=["DELETE"])
@admin_required
@csrf_protect
def delete_admin_announcement(ann_id):
    """Deletes an announcement."""
    try:
        try:
            obj_id = ObjectId(ann_id)
        except Exception:
            return error_response(code="INVALID_ID", message="Invalid ID format.", status_code=400)

        ann_col = get_collection("announcements")
        ann_col.delete_one({"_id": obj_id})
        return success_response({"message": "Announcement deleted."})
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/settings", methods=["GET"])
@admin_required
def get_portal_settings():
    """Retrieves civic portal administrative configurations."""
    try:
        settings_col = get_collection("system_settings")
        settings_doc = settings_col.find_one({"key": "portal_config"}) or {}
        default_config = {
            "portal_name": "Municipal Service Portal",
            "support_email": "support@municipal.gov.in",
            "helpline_number": "1800-425-0011",
            "working_hours": "09:00 AM - 05:30 PM (Mon-Sat)",
            "default_sla_days": 7,
            "max_file_upload_mb": 5,
            "allowed_file_types": ["pdf", "jpg", "jpeg", "png"]
        }
        merged = dict(default_config)
        merged.update(settings_doc.get("value", {}))
        return success_response(data=merged)
    except Exception as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_portal_bp.route("/settings", methods=["POST"])
@admin_role_required("super_admin", "admin")
@csrf_protect
def update_portal_settings():
    """Updates civic portal system configurations."""
    try:
        body = request.get_json(silent=True) or {}
        settings_col = get_collection("system_settings")
        now = datetime.now(timezone.utc)
        settings_col.update_one(
            {"key": "portal_config"},
            {"$set": {"value": body, "updated_at": now, "updated_by": session.get("email")}},
            upsert=True
        )

        log_audit(
            actor_id=session.get("user_id"),
            actor_role=session.get("admin_role", "admin"),
            action="PORTAL_SETTINGS_UPDATED",
            target_collection="system_settings",
            target_id="portal_config",
            before_after_summary=body,
            ip=request.remote_addr
        )

        return success_response({"message": "System settings saved successfully."})
    except Exception as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)
