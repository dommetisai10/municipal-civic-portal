"""Authentication, authorization, RBAC, and CSRF protection decorators."""

from functools import wraps
import hmac
from flask import session, request, current_app
from backend.utils.responses import error_response
from backend.utils.security import verify_auth_token

ADMIN_ROLES = ["admin", "super_admin", "officer", "viewer"]


def _populate_session_from_token():
    """Helper to authenticate user via Authorization: Bearer <token> if session is missing."""
    if session.get("user_id"):
        return True

    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:].strip()
        secret_key = current_app.config.get("SECRET_KEY", "")
        payload = verify_auth_token(token, secret_key)
        if payload and payload.get("user_id"):
            session["user_id"] = payload["user_id"]
            session["role"] = payload.get("role", "citizen")
            session["admin_role"] = payload.get("admin_role") or (payload.get("role") if payload.get("role") in ADMIN_ROLES else "admin")
            session["department"] = payload.get("department")
            if "email" in payload:
                session["email"] = payload["email"]
            if "full_name" in payload:
                session["full_name"] = payload["full_name"]
            return True
    return False


def login_required(f):
    """Decorator ensuring that an active, authenticated user session exists (via cookie or Bearer token)."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        _populate_session_from_token()
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
            _populate_session_from_token()
            user_id = session.get("user_id")
            if not user_id:
                return error_response(
                    code="UNAUTHORIZED",
                    message="Authentication required. Please log in.",
                    status_code=401
                )

            user_role = session.get("role")
            admin_role = session.get("admin_role")
            # If checking for 'admin', any admin role counts
            if "admin" in allowed_roles and (user_role in ADMIN_ROLES or admin_role in ADMIN_ROLES):
                return f(*args, **kwargs)

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
    """Restricts route access to all authorized administration roles."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        _populate_session_from_token()
        user_id = session.get("user_id")
        if not user_id:
            return error_response(
                code="UNAUTHORIZED",
                message="Authentication required. Please log in.",
                status_code=401
            )

        user_role = session.get("role")
        admin_role = session.get("admin_role")
        if user_role not in ADMIN_ROLES and admin_role not in ADMIN_ROLES:
            return error_response(
                code="FORBIDDEN",
                message="Access forbidden. Administrative privileges required.",
                status_code=403
            )

        # Viewer role protection: viewers are strictly read-only
        effective_admin_role = admin_role or ("super_admin" if user_role == "admin" else user_role)
        if effective_admin_role == "viewer" and request.method in ["POST", "PUT", "PATCH", "DELETE"]:
            return error_response(
                code="FORBIDDEN_READ_ONLY",
                message="Viewer role is restricted to read-only access. Modification actions are forbidden.",
                status_code=403
            )

        return f(*args, **kwargs)
    return decorated_function


def admin_role_required(*allowed_admin_roles):
    """Restricts route access to specific administrative roles (e.g. 'super_admin', 'admin', 'officer')."""
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            _populate_session_from_token()
            user_id = session.get("user_id")
            if not user_id:
                return error_response(code="UNAUTHORIZED", message="Authentication required.", status_code=401)

            user_role = session.get("role")
            admin_role = session.get("admin_role") or ("super_admin" if user_role == "admin" else user_role)

            if admin_role == "super_admin":
                return f(*args, **kwargs)

            if admin_role not in allowed_admin_roles:
                return error_response(
                    code="FORBIDDEN_ROLE",
                    message=f"Access forbidden. Required administrative level: {', '.join(allowed_admin_roles)}.",
                    status_code=403
                )
            return f(*args, **kwargs)
        return decorated_function
    return decorator


def super_admin_required(f):
    """Restricts action exclusively to Super Administrators."""
    return admin_role_required("super_admin")(f)


def citizen_required(f):
    """Convenience decorator restricting route access exclusively to citizens."""
    return role_required("citizen")(f)


def csrf_protect(f):
    """
    Validates CSRF token on state-changing HTTP requests (POST, PUT, PATCH, DELETE).
    Compares the client's 'X-CSRF-Token' header with the session-stored 'csrf_token'.
    Requests authenticated explicitly via Bearer tokens are immune to ambient CSRF attacks.
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # Skip CSRF check in testing mode if configured
        if current_app.config.get("TESTING") and current_app.config.get("WTF_CSRF_ENABLED") is False:
            return f(*args, **kwargs)

        if request.method in ["POST", "PUT", "PATCH", "DELETE"]:
            # If request carries a valid Bearer token, ambient CSRF is not possible
            auth_header = request.headers.get("Authorization", "")
            if auth_header.startswith("Bearer "):
                token = auth_header[7:].strip()
                secret_key = current_app.config.get("SECRET_KEY", "")
                payload = verify_auth_token(token, secret_key)
                if payload and payload.get("user_id"):
                    return f(*args, **kwargs)

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
