"""Health check routes reporting honest service and database connectivity."""

from datetime import datetime, timezone
from flask import Blueprint
from backend.services.db import check_db_connection
from backend.utils.responses import api_response

health_bp = Blueprint("health", __name__, url_prefix="/api")


@health_bp.route("/health", methods=["GET"])
def health_check():
    """
    Honest health check endpoint.
    Returns HTTP 200 if MongoDB responds to ping; returns HTTP 503 if unavailable.
    """
    is_connected, message = check_db_connection()
    now_utc = datetime.now(timezone.utc).isoformat()

    if is_connected:
        return api_response(
            success=True,
            data={
                "status": "healthy",
                "database": "connected",
                "message": message,
                "timestamp": now_utc
            },
            error=None,
            status_code=200
        )

    # Return honest HTTP 503 on database unavailability
    return api_response(
        success=False,
        data={
            "status": "degraded",
            "database": "disconnected",
            "timestamp": now_utc
        },
        error={
            "code": "DATABASE_UNAVAILABLE",
            "message": "Database connection failed. Please ensure MongoDB is running or check connection configuration.",
            "fields": {"details": message}
        },
        status_code=503
    )
