"""Standardized API response helpers ensuring a consistent contract across all endpoints."""

from flask import jsonify


def api_response(success=True, data=None, error=None, status_code=200):
    """
    Constructs a consistent JSON response adhering to the project schema:
    {
        "success": bool,
        "data": Any,
        "error": {
            "code": str,
            "message": str,
            "fields": Optional[dict]
        } or None
    }
    """
    payload = {
        "success": bool(success),
        "data": data,
        "error": error
    }
    return jsonify(payload), status_code


def success_response(data=None, status_code=200):
    """Convenience helper for successful API operations."""
    return api_response(success=True, data=data, error=None, status_code=status_code)


def error_response(code="ERROR", message="An error occurred", fields=None, status_code=400):
    """Convenience helper for failed API operations."""
    error_payload = {
        "code": str(code),
        "message": str(message),
        "fields": fields
    }
    return api_response(success=False, data=None, error=error_payload, status_code=status_code)
