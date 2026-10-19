"""Authentication, authorization, and CSRF protection decorators."""

from functools import wraps
import hmac
from flask import session, request, current_app
from backend.utils.responses import error_response


def login_required(f):
    """Decorator ensuring that an active, authenticated user session exists."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        user_id = session.get("user_id")
        if not user_id:
            return error_response(
                code="UNAUTHORIZED",
                message="Authentication required. Please log in to proceed.",
                status_code=401
            )
        return f(*args, **kwargs)
    return decorated_function


def role_required(*allowed_roles):
    """Decorator restricting endpoint access to specified user roles (e.g., 'citizen', 'admin')."""
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            user_id = session.get("user_id")
            if not user_id:
                return error_response(
                    code="UNAUTHORIZED",
                    message="Authentication required. Please log in.",
                    status_code=401
                )

            user_role = session.get("role")
            if user_role not in allowed_roles:
                return error_response(
                    code="FORBIDDEN",
                    message="Access forbidden. You do not possess the required permissions.",
                    status_code=403
                )
            return f(*args, **kwargs)
        return decorated_function
    return decorator


def admin_required(f):
    """Convenience decorator restricting route access exclusively to administrators."""
    return role_required("admin")(f)


def citizen_required(f):
    """Convenience decorator restricting route access exclusively to citizens."""
    return role_required("citizen")(f)


def csrf_protect(f):
    """
    Validates CSRF token on state-changing HTTP requests (POST, PUT, PATCH, DELETE).
    Compares the client's 'X-CSRF-Token' header with the session-stored 'csrf_token'.
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # Skip CSRF check in testing mode if configured
        if current_app.config.get("TESTING") and current_app.config.get("WTF_CSRF_ENABLED") is False:
            return f(*args, **kwargs)

        if request.method in ["POST", "PUT", "PATCH", "DELETE"]:
            session_token = session.get("csrf_token")
            header_token = request.headers.get("X-CSRF-Token")

            if not session_token or not header_token:
                return error_response(
                    code="CSRF_TOKEN_MISSING",
                    message="CSRF token missing. Please refresh and try again.",
                    status_code=403
                )

            # Constant-time comparison to prevent timing attacks
            if not hmac.compare_digest(session_token, header_token):
                return error_response(
                    code="CSRF_TOKEN_INVALID",
                    message="Invalid CSRF token. Request rejected.",
                    status_code=403
                )

        return f(*args, **kwargs)
    return decorated_function
