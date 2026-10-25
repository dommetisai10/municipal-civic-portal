"""Health check routes reporting honest service and database connectivity."""

import time
from datetime import datetime, timezone
from flask import Blueprint
from backend.services.db import check_db_connection, get_db_diagnostics
from backend.utils.responses import api_response

health_bp = Blueprint("health", __name__, url_prefix="/api")


@health_bp.route("/health", methods=["GET"])
def health_check():
    """
    Honest health check endpoint.
    Runs a live ping query to verify database status, latency, and uptime.
    Returns HTTP 200 if MongoDB responds to ping; returns HTTP 503 if unavailable.
    """
    t0 = time.time()
    is_connected, message = check_db_connection()
    latency_ms = round((time.time() - t0) * 1000, 2)
    now_utc = datetime.now(timezone.utc).isoformat()

    # Get extended diagnostics if available
    diagnostics = get_db_diagnostics()
    uptime_seconds = diagnostics.get("uptime_seconds", 0)
    collections_count = diagnostics.get("collections_count", 0)

    if is_connected:
        return api_response(
            success=True,
            data={
                "status": "healthy",
                "database": "connected",
                "latency_ms": latency_ms,
                "uptime_seconds": uptime_seconds,
                "collections_count": collections_count,
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
            "latency_ms": latency_ms,
            "uptime_seconds": uptime_seconds,
            "collections_count": 0,
            "timestamp": now_utc
        },
        error={
            "code": "DATABASE_UNAVAILABLE",
            "message": "Database connection failed. Please ensure MongoDB is running or check connection configuration.",
            "fields": {
                "details": message,
                "target": diagnostics.get("uri_target", "")
            }
        },
        status_code=503
    )
