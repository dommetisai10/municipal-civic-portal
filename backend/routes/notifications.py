"""Citizen notifications management routes."""

from flask import Blueprint, session
from bson import ObjectId
from pymongo.errors import PyMongoError
from backend.services.db import get_collection
from backend.utils.responses import success_response, error_response
from backend.middleware.auth import login_required, csrf_protect

notifications_bp = Blueprint("notifications", __name__, url_prefix="/api/notifications")


@notifications_bp.route("", methods=["GET"])
@login_required
def get_user_notifications():
    """Retrieves all notifications for the authenticated citizen, ordered latest first."""
    user_id_str = session.get("user_id")
    match_ids = [user_id_str]
    if ObjectId.is_valid(user_id_str):
        match_ids.append(ObjectId(user_id_str))

    try:
        notifs_col = get_collection("notifications")
        cursor = notifs_col.find(
            {"user_id": {"$in": match_ids}}
        ).sort("created_at", -1).limit(50)

        results = []
        for doc in cursor:
            results.append({
                "id": str(doc.get("_id", ObjectId())),
                "type": doc.get("type", "INFO"),
                "title": doc.get("title", ""),
                "message": doc.get("message", ""),
                "related_id": doc.get("related_id"),
                "is_read": bool(doc.get("is_read", False)),
                "created_at": doc.get("created_at").isoformat() if doc.get("created_at") else None
            })
        return success_response(data=results)
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@notifications_bp.route("/<notification_id>/read", methods=["PATCH"])
@login_required
@csrf_protect
def mark_notification_read(notification_id):
    """Marks a single notification as read, enforcing user ownership."""
    if not ObjectId.is_valid(notification_id):
        return error_response(code="INVALID_ID", message="Invalid notification identifier.", status_code=400)

    user_id_str = session.get("user_id")
    match_ids = [user_id_str]
    if ObjectId.is_valid(user_id_str):
        match_ids.append(ObjectId(user_id_str))

    try:
        notifs_col = get_collection("notifications")
        res = notifs_col.update_one(
            {"_id": ObjectId(notification_id), "user_id": {"$in": match_ids}},
            {"$set": {"is_read": True}}
        )

        if not res.acknowledged:
            return error_response(code="DB_ERROR", message="Database write unacknowledged.", status_code=503)

        if res.matched_count == 0:
            return error_response(code="NOT_FOUND", message="Notification not found or access denied.", status_code=404)

        return success_response({"message": "Notification marked as read."})
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)
