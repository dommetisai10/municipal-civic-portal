"""Administrative authentication routes (dedicated endpoint group for administrators & officers)."""

from datetime import datetime, timezone, timedelta
from bson import ObjectId
from flask import Blueprint, request, session, current_app
from pymongo.errors import PyMongoError
from backend.services.db import get_collection
from backend.services.audit import log_audit
from backend.utils.responses import success_response, error_response
from backend.utils.validators import validate_email, validate_password, sanitize_string
from backend.utils.security import verify_password, hash_password, generate_csrf_token, generate_auth_token
from backend.middleware.auth import admin_required, csrf_protect
from backend.services.limiter import limiter

admin_auth_bp = Blueprint("admin_auth", __name__, url_prefix="/api/admin/auth")

ALLOWED_ADMIN_ROLES = ["admin", "super_admin", "officer", "viewer"]


@admin_auth_bp.route("/login", methods=["POST"])
@limiter.limit("10 per minute")
@csrf_protect
def admin_login():
    """
    Dedicated authentication endpoint strictly for portal administrators and officers.
    Rejects citizen accounts and logs all administrative authentication events.
    """
    body = request.get_json(silent=True) or {}
    ok_email, email_val = validate_email(body.get("email"))
    ok_pwd, pwd_val = sanitize_string(body.get("password"), field_name="password", max_length=128, required=True)

    if not ok_email or not ok_pwd:
        return error_response(
            code="INVALID_CREDENTIALS",
            message="Invalid administrator credentials.",
            status_code=401
        )

    try:
        users_col = get_collection("users")
        user = users_col.find_one({"email": email_val})

        # Strict admin role verification (never allow citizens into admin portal)
        user_role = user.get("role") if user else None
        admin_role = user.get("admin_role") if user else None
        if not user or (user_role not in ALLOWED_ADMIN_ROLES and admin_role not in ALLOWED_ADMIN_ROLES):
            return error_response(
                code="INVALID_CREDENTIALS",
                message="Invalid administrator credentials.",
                status_code=401
            )

        now_utc = datetime.now(timezone.utc)

        # Account lockout check
        locked_until = user.get("locked_until")
        if locked_until:
            if locked_until.tzinfo is None:
                locked_until = locked_until.replace(tzinfo=timezone.utc)
            if now_utc < locked_until:
                remaining_min = int((locked_until - now_utc).total_seconds() // 60) + 1
                return error_response(
                    code="ACCOUNT_LOCKED",
                    message=f"Administrator account locked. Try again in {remaining_min} minutes.",
                    status_code=423
                )

        if not user.get("is_active", True) or user.get("is_deleted", False):
            return error_response(
                code="ACCOUNT_DISABLED",
                message="Administrator account is disabled or deactivated.",
                status_code=403
            )

        # Password check
        if not verify_password(pwd_val, user.get("password_hash", "")):
            failed_attempts = user.get("failed_login_attempts", 0) + 1
            update_fields = {"failed_login_attempts": failed_attempts, "updated_at": now_utc}
            if failed_attempts >= 5:
                update_fields["locked_until"] = now_utc + timedelta(minutes=15)

            users_col.update_one({"_id": user["_id"]}, {"$set": update_fields})
            return error_response(
                code="INVALID_CREDENTIALS",
                message="Invalid administrator credentials.",
                status_code=401
            )

        # Success: reset lockout counters
        users_col.update_one(
            {"_id": user["_id"]},
            {"$set": {"failed_login_attempts": 0, "locked_until": None, "last_login_at": now_utc, "updated_at": now_utc}}
        )

        effective_admin_role = user.get("admin_role") or ("super_admin" if user.get("role") in ["admin", "super_admin"] else user.get("role", "admin"))
        department = user.get("department", "Municipal Administration")

        # Establish admin session
        session.clear()
        session["user_id"] = str(user["_id"])
        session["role"] = user.get("role", "admin")
        session["admin_role"] = effective_admin_role
        session["department"] = department
        session["email"] = user["email"]
        session["full_name"] = user["full_name"]
        session["csrf_token"] = generate_csrf_token()

        # Audit log admin login
        log_audit(
            actor_id=str(user["_id"]),
            actor_role=effective_admin_role,
            action="ADMIN_LOGIN",
            target_collection="users",
            target_id=str(user["_id"]),
            ip=request.remote_addr
        )

        secret_key = current_app.config.get("SECRET_KEY", "")
        auth_token = generate_auth_token(
            str(user["_id"]), user.get("role", "admin"), secret_key,
            email=user["email"], full_name=user["full_name"],
            admin_role=effective_admin_role, department=department
        )

        return success_response(
            data={
                "id": str(user["_id"]),
                "full_name": user["full_name"],
                "email": user["email"],
                "role": user.get("role", "admin"),
                "admin_role": effective_admin_role,
                "department": department,
                "token": auth_token,
                "csrf_token": session["csrf_token"],
                "message": "Administrator authentication successful."
            },
            status_code=200
        )

    except PyMongoError as exc:
        return error_response(
            code="DATABASE_ERROR",
            message="Database connection failure.",
            fields={"details": str(exc)},
            status_code=503
        )


@admin_auth_bp.route("/logout", methods=["POST"])
@admin_required
@csrf_protect
def admin_logout():
    """Logs out administrator and invalidates session."""
    user_id = session.get("user_id")
    log_audit(
        actor_id=user_id,
        actor_role=session.get("admin_role", "admin"),
        action="ADMIN_LOGOUT",
        target_collection="users",
        target_id=user_id,
        ip=request.remote_addr
    )
    session.clear()
    return success_response({"message": "Administrator logged out successfully."})


@admin_auth_bp.route("/me", methods=["GET"])
@admin_required
def get_current_admin():
    """Retrieves profile of the authenticated administrator or officer."""
    user_id = session.get("user_id")
    try:
        users_col = get_collection("users")
        user = users_col.find_one({"_id": ObjectId(user_id)}, {"password_hash": 0})
        if not user:
            session.clear()
            return error_response(code="USER_NOT_FOUND", message="Admin account not found.", status_code=404)

        effective_role = user.get("admin_role") or ("super_admin" if user.get("role") in ["admin", "super_admin"] else user.get("role", "admin"))

        return success_response(
            data={
                "id": str(user["_id"]),
                "full_name": user.get("full_name"),
                "email": user.get("email"),
                "role": user.get("role"),
                "admin_role": effective_role,
                "department": user.get("department", "Municipal Administration"),
                "last_login_at": user.get("last_login_at").isoformat() if user.get("last_login_at") else None
            }
        )
    except Exception as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@admin_auth_bp.route("/change-password", methods=["POST"])
@admin_required
@csrf_protect
def change_admin_password():
    """Allows an authenticated administrator or officer to change their account password."""
    user_id = session.get("user_id")
    body = request.get_json(silent=True) or {}
    current_pwd = body.get("current_password", "")
    new_pwd = body.get("new_password", "")

    ok_pwd, pwd_err = validate_password(new_pwd)
    if not ok_pwd:
        return error_response(code="INVALID_PASSWORD", message=pwd_err, status_code=422)

    try:
        users_col = get_collection("users")
        user = users_col.find_one({"_id": ObjectId(user_id)})
        if not user:
            return error_response(code="NOT_FOUND", message="User account not found.", status_code=404)

        if not verify_password(current_pwd, user.get("password_hash", "")):
            return error_response(code="INCORRECT_PASSWORD", message="Current password incorrect.", status_code=400)

        now_utc = datetime.now(timezone.utc)
        users_col.update_one(
            {"_id": ObjectId(user_id)},
            {"$set": {
                "password_hash": hash_password(new_pwd),
                "updated_at": now_utc
            }}
        )

        log_audit(
            actor_id=user_id,
            actor_role=session.get("admin_role", "admin"),
            action="ADMIN_PASSWORD_CHANGED",
            target_collection="users",
            target_id=user_id,
            ip=request.remote_addr
        )

        return success_response({"message": "Administrator password updated successfully."})
    except Exception as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)
