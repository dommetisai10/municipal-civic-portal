"""Citizen and administrative dashboard analytics routes with live database queries."""

from flask import Blueprint, session
from bson import ObjectId
from pymongo.errors import PyMongoError
from backend.services.db import get_collection
from backend.utils.responses import success_response, error_response
from backend.middleware.auth import login_required, citizen_required

dashboard_bp = Blueprint("dashboard", __name__, url_prefix="/api/dashboard")


@dashboard_bp.route("/user", methods=["GET"])
@dashboard_bp.route("/stats", methods=["GET"])
@login_required
@citizen_required
def get_citizen_dashboard():
    """
    Computes live statistics and retrieves recent records for the logged-in citizen.
    STRICT CLEAN DATA RULE:
    All counts derive from real database aggregations. If no applications or complaints
    exist, every counter returns exactly 0 and lists return empty arrays.
    """
    user_id_str = session.get("user_id")

    # Safe user ID matching (supporting both ObjectId and string formats)
    match_ids = [user_id_str]
    if ObjectId.is_valid(user_id_str):
        match_ids.append(ObjectId(user_id_str))

    try:
        apps_col = get_collection("applications")
        cmps_col = get_collection("complaints")
        notifs_col = get_collection("notifications")

        # 1. Live Applications Aggregation by Status
        app_pipeline = [
            {"$match": {"user_id": {"$in": match_ids}}},
            {"$group": {"_id": "$status", "count": {"$sum": 1}}}
        ]
        app_results = list(apps_col.aggregate(app_pipeline))

        app_counts = {
            "total": 0,
            "pending": 0,
            "approved": 0,
            "rejected": 0,
            "completed": 0
        }

        pending_statuses = {"Pending", "Submitted", "Under Review", "Additional Information Required", "Action Required"}

        for item in app_results:
            status = item.get("_id")
            count = item.get("count", 0)
            app_counts["total"] += count

            if status == "Approved":
                app_counts["approved"] += count
            elif status == "Rejected":
                app_counts["rejected"] += count
            elif status == "Completed":
                app_counts["completed"] += count

            if status in pending_statuses:
                app_counts["pending"] += count

        # 2. Live Complaints Aggregation by Status
        cmp_pipeline = [
            {"$match": {"user_id": {"$in": match_ids}}},
            {"$group": {"_id": "$status", "count": {"$sum": 1}}}
        ]
        cmp_results = list(cmps_col.aggregate(cmp_pipeline))

        cmp_counts = {
            "total": 0,
            "open": 0,
            "resolved": 0
        }

        resolved_statuses = {"Resolved", "Closed"}

        for item in cmp_results:
            status = item.get("_id")
            count = item.get("count", 0)
            cmp_counts["total"] += count

            if status in resolved_statuses:
                cmp_counts["resolved"] += count
            elif status != "Rejected":
                cmp_counts["open"] += count

        # 3. Unread Notifications Count
        unread_notifications = notifs_col.count_documents({
            "user_id": {"$in": match_ids},
            "is_read": False
        })

        # 4. Recent Applications (Latest 5)
        recent_apps_cursor = apps_col.find(
            {"user_id": {"$in": match_ids}}
        ).sort("created_at", -1).limit(5)

        recent_applications = []
        for app in recent_apps_cursor:
            recent_applications.append({
                "id": str(app["_id"]),
                "application_id": app.get("application_id"),
                "service_id": str(app.get("service_id", "")),
                "service_name": app.get("service_name", "Municipal Service"),
                "status": app.get("status", "Submitted"),
                "created_at": app.get("created_at").isoformat() if app.get("created_at") else None,
                "updated_at": app.get("updated_at").isoformat() if app.get("updated_at") else None
            })

        # 5. Recent Complaints (Latest 5)
        recent_cmps_cursor = cmps_col.find(
            {"user_id": {"$in": match_ids}}
        ).sort("created_at", -1).limit(5)

        recent_complaints = []
        for cmp_doc in recent_cmps_cursor:
            recent_complaints.append({
                "id": str(cmp_doc["_id"]),
                "complaint_id": cmp_doc.get("complaint_id"),
                "title": cmp_doc.get("title", ""),
                "category": cmp_doc.get("department") or cmp_doc.get("category", "General"),
                "status": cmp_doc.get("status", "Submitted"),
                "created_at": cmp_doc.get("created_at").isoformat() if cmp_doc.get("created_at") else None,
                "updated_at": cmp_doc.get("updated_at").isoformat() if cmp_doc.get("updated_at") else None
            })

        return success_response(data={
            "stats": {
                "applications": app_counts,
                "complaints": cmp_counts,
                "unread_notifications": unread_notifications
            },
            "recent_applications": recent_applications,
            "recent_complaints": recent_complaints
        })

    except PyMongoError as exc:
        return error_response(
            code="DATABASE_ERROR",
            message="Database query failed during dashboard aggregation.",
            fields={"details": str(exc)},
            status_code=503
        )
