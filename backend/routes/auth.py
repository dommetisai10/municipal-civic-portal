"""Citizen authentication routes (register, login, logout, profile, password change)."""

from datetime import datetime, timezone, timedelta
from bson import ObjectId
from flask import Blueprint, request, session, current_app
from pymongo.errors import PyMongoError
from backend.services.db import get_collection
from backend.services.audit import log_audit
from backend.utils.responses import success_response, error_response
from backend.utils.validators import (
    validate_registration_payload,
    validate_email,
    validate_password,
    validate_mobile,
    sanitize_string,
)
from backend.utils.security import (
    hash_password,
    verify_password,
    generate_csrf_token,
    generate_auth_token,
)
from backend.middleware.auth import login_required, citizen_required, csrf_protect
from backend.services.limiter import limiter

auth_bp = Blueprint("auth", __name__, url_prefix="/api/auth")


@auth_bp.route("/csrf-token", methods=["GET"])
def get_csrf_token():
    """Returns or generates a session CSRF token for state-changing operations."""
    if "csrf_token" not in session:
        session["csrf_token"] = generate_csrf_token()
    return success_response({"csrf_token": session["csrf_token"]})


@auth_bp.route("/register", methods=["POST"])
@limiter.limit("10 per minute")
@csrf_protect
def register():
    """
    Registers a new citizen account.
    Enforces strict input validation, password complexity, unique email, and clean data rules.
    """
    body = request.get_json(silent=True) or {}
    is_valid, sanitized, errors = validate_registration_payload(body)
    if not is_valid:
        return error_response(
            code="VALIDATION_ERROR",
            message="Invalid registration data.",
            fields=errors,
            status_code=400
        )

    try:
        users_col = get_collection("users")

        # Check for existing email (case-insensitive check against normalized lowercase email)
        existing = users_col.find_one({"email": sanitized["email"]})
        if existing:
            return error_response(
                code="EMAIL_ALREADY_EXISTS",
                message="An account with this email address already exists.",
                fields={"email": "Email is already registered."},
                status_code=409
            )

        now_utc = datetime.now(timezone.utc)
        pwd_hash = hash_password(sanitized["password"])

        user_doc = {
            "full_name": sanitized["full_name"],
            "email": sanitized["email"],
            "mobile": sanitized["mobile"],
            "address": sanitized["address"],
            "password_hash": pwd_hash,
            "role": "citizen",
            "is_active": True,
            "failed_login_attempts": 0,
            "locked_until": None,
            "created_at": now_utc,
            "updated_at": now_utc,
            "last_login_at": None
        }

        # Guaranteed acknowledged write
        result = users_col.insert_one(user_doc)
        if not result.acknowledged:
            return error_response(
                code="DB_WRITE_FAILED",
                message="Database failed to acknowledge registration write.",
                status_code=503
            )

        user_id_str = str(result.inserted_id)

        # Audit log creation
        log_audit(
            actor_id=user_id_str,
            actor_role="citizen",
            action="USER_REGISTER",
            target_collection="users",
            target_id=user_id_str,
            before_after_summary={"email": sanitized["email"], "role": "citizen"},
            ip=request.remote_addr
        )

        secret_key = current_app.config.get("SECRET_KEY", "")
        auth_token = generate_auth_token(
            user_id_str, "citizen", secret_key,
            email=sanitized["email"], full_name=sanitized["full_name"]
        )

        return success_response(
            data={
                "id": user_id_str,
                "full_name": sanitized["full_name"],
                "email": sanitized["email"],
                "role": "citizen",
                "token": auth_token,
                "message": "Registration successful. You can now log in."
            },
            status_code=201
        )

    except PyMongoError as exc:
        return error_response(
            code="DATABASE_ERROR",
            message="Database error occurred during registration. Please try again.",
            fields={"details": str(exc)},
            status_code=503
        )


@auth_bp.route("/login", methods=["POST"])
@limiter.limit("10 per minute")
@csrf_protect
def login():
    """
    Authenticates a citizen, establishes a server-side session, and sets security cookies and signed token.
    """
    body = request.get_json(silent=True) or {}
    ok_email, email_val = validate_email(body.get("email"))
    ok_pwd, pwd_val = sanitize_string(body.get("password"), field_name="password", max_length=128, required=True)

    if not ok_email or not ok_pwd:
        return error_response(
            code="INVALID_CREDENTIALS",
            message="Invalid email or password.",
            status_code=401
        )

    try:
        users_col = get_collection("users")
        user = users_col.find_one({"email": email_val})

        # Generic failure message to prevent user enumeration
        if not user or user.get("role") != "citizen":
            return error_response(
                code="INVALID_CREDENTIALS",
                message="Invalid email or password.",
                status_code=401
            )

        now_utc = datetime.now(timezone.utc)

        # Account lockout check (5 consecutive failures lock account for 15 minutes)
        locked_until = user.get("locked_until")
        if locked_until:
            # Handle timezone awareness
            if locked_until.tzinfo is None:
                locked_until = locked_until.replace(tzinfo=timezone.utc)
            if now_utc < locked_until:
                remaining_min = int((locked_until - now_utc).total_seconds() // 60) + 1
                return error_response(
                    code="ACCOUNT_LOCKED",
                    message=f"Account is temporarily locked due to repeated failed login attempts. Please try again in {remaining_min} minutes.",
                    status_code=423
                )

        if not user.get("is_active", True) or user.get("is_deleted", False):
            suspension_reason = user.get("suspension_reason", "").strip()
            msg = f"Your account has been suspended by municipal administration. Reason: {suspension_reason}" if suspension_reason else "Your citizen account has been suspended or deactivated. Please contact municipal support."
            return error_response(
                code="ACCOUNT_SUSPENDED",
                message=msg,
                status_code=403
            )

        # Password verification
        if not verify_password(pwd_val, user.get("password_hash", "")):
            failed_attempts = user.get("failed_login_attempts", 0) + 1
            update_fields = {"failed_login_attempts": failed_attempts, "updated_at": now_utc}
            if failed_attempts >= 5:
                update_fields["locked_until"] = now_utc + timedelta(minutes=15)

            users_col.update_one({"_id": user["_id"]}, {"$set": update_fields})

            return error_response(
                code="INVALID_CREDENTIALS",
                message="Invalid email or password.",
                status_code=401
            )

        # Success: reset failed attempts and record login
        users_col.update_one(
            {"_id": user["_id"]},
            {"$set": {"failed_login_attempts": 0, "locked_until": None, "last_login_at": now_utc, "updated_at": now_utc}}
        )

        # Establish server-side session
        session.clear()
        session["user_id"] = str(user["_id"])
        session["role"] = "citizen"
        session["email"] = user["email"]
        session["full_name"] = user["full_name"]
        session["csrf_token"] = generate_csrf_token()

        # Audit log login
        log_audit(
            actor_id=str(user["_id"]),
            actor_role="citizen",
            action="USER_LOGIN",
            target_collection="users",
            target_id=str(user["_id"]),
            ip=request.remote_addr
        )

        secret_key = current_app.config.get("SECRET_KEY", "")
        auth_token = generate_auth_token(
            str(user["_id"]), "citizen", secret_key,
            email=user["email"], full_name=user["full_name"]
        )

        return success_response(
            data={
                "id": str(user["_id"]),
                "full_name": user["full_name"],
                "email": user["email"],
                "role": "citizen",
                "token": auth_token,
                "csrf_token": session["csrf_token"],
                "message": "Login successful."
            },
            status_code=200
        )

    except PyMongoError as exc:
        return error_response(
            code="DATABASE_ERROR",
            message="Database connection error. Please try again.",
            fields={"details": str(exc)},
            status_code=503
        )


@auth_bp.route("/logout", methods=["POST"])
@login_required
@csrf_protect
def logout():
    """Logs out the current citizen and invalidates the session."""
    user_id = session.get("user_id")
    log_audit(
        actor_id=user_id,
        actor_role="citizen",
        action="USER_LOGOUT",
        target_collection="users",
        target_id=user_id,
        ip=request.remote_addr
    )
    session.clear()
    return success_response({"message": "Successfully logged out."})


@auth_bp.route("/me", methods=["GET"])
@login_required
def get_current_user():
    """Returns the profile of the authenticated citizen (without sensitive fields)."""
    user_id = session.get("user_id")
    try:
        users_col = get_collection("users")
        user = users_col.find_one({"_id": ObjectId(user_id)}, {"password_hash": 0})
        if not user:
            session.clear()
            return error_response(code="USER_NOT_FOUND", message="User account not found.", status_code=404)

        secret_key = current_app.config.get("SECRET_KEY", "")
        auth_token = generate_auth_token(
            str(user["_id"]), user.get("role", "citizen"), secret_key,
            email=user.get("email"), full_name=user.get("full_name")
        )

        return success_response(
            data={
                "id": str(user["_id"]),
                "full_name": user.get("full_name"),
                "email": user.get("email"),
                "mobile": user.get("mobile"),
                "address": user.get("address"),
                "role": user.get("role"),
                "admin_role": user.get("admin_role") or (user.get("role") if user.get("role") in ["admin", "super_admin", "officer", "viewer"] else None),
                "token": auth_token,
                "created_at": user.get("created_at").isoformat() if user.get("created_at") else None,
                "last_login_at": user.get("last_login_at").isoformat() if user.get("last_login_at") else None
            }
        )
    except Exception as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@auth_bp.route("/change-password", methods=["POST"])
@login_required
@csrf_protect
def change_password():
    """Allows an authenticated citizen to securely change their password."""
    user_id = session.get("user_id")
    body = request.get_json(silent=True) or {}

    current_pwd = body.get("current_password")
    new_pwd = body.get("new_password")

    if not current_pwd or not new_pwd:
        return error_response(
            code="VALIDATION_ERROR",
            message="Both current password and new password are required.",
            status_code=400
        )

    ok_val, pwd_val = validate_password(new_pwd)
    if not ok_val:
        return error_response(code="VALIDATION_ERROR", message=pwd_val, status_code=400)

    try:
        users_col = get_collection("users")
        user = users_col.find_one({"_id": ObjectId(user_id)})
        if not user:
            return error_response(code="USER_NOT_FOUND", message="User not found.", status_code=404)

        if not verify_password(current_pwd, user.get("password_hash", "")):
            return error_response(code="INVALID_PASSWORD", message="Current password is incorrect.", status_code=400)

        if verify_password(new_pwd, user.get("password_hash", "")):
            return error_response(
                code="PASSWORD_REUSE",
                message="New password cannot be the same as your current password.",
                status_code=400
            )

        new_hash = hash_password(new_pwd)
        now_utc = datetime.now(timezone.utc)

        users_col.update_one(
            {"_id": user["_id"]},
            {"$set": {"password_hash": new_hash, "updated_at": now_utc}}
        )

        log_audit(
            actor_id=user_id,
            actor_role=session.get("role", "citizen"),
            action="PASSWORD_CHANGE",
            target_collection="users",
            target_id=user_id,
            ip=request.remote_addr
        )

        return success_response({"message": "Password changed successfully."})

    except Exception as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)


@auth_bp.route("/profile", methods=["PATCH"])
@login_required
@csrf_protect
def update_profile():
    """Allows an authenticated citizen to update their profile information."""
    user_id = session.get("user_id")
    body = request.get_json(silent=True) or {}

    updates = {}
    if "full_name" in body:
        ok, name_val = sanitize_string(body.get("full_name"), field_name="Full Name", min_length=2, max_length=100)
        if not ok:
            return error_response(code="VALIDATION_ERROR", message=name_val, status_code=400)
        updates["full_name"] = name_val

    if "mobile" in body:
        ok, mob_val = validate_mobile(body.get("mobile"), required=True)
        if not ok:
            return error_response(code="VALIDATION_ERROR", message=mob_val, status_code=400)
        updates["mobile"] = mob_val

    if "address" in body:
        ok, addr_val = sanitize_string(body.get("address"), field_name="Address", min_length=5, max_length=300)
        if not ok:
            return error_response(code="VALIDATION_ERROR", message=addr_val, status_code=400)
        updates["address"] = addr_val

    if not updates:
        return error_response(code="VALIDATION_ERROR", message="No valid fields provided for update.", status_code=400)

    updates["updated_at"] = datetime.now(timezone.utc)

    try:
        users_col = get_collection("users")
        res = users_col.update_one({"_id": ObjectId(user_id)}, {"$set": updates})

        if not res.acknowledged:
            return error_response(code="DB_ERROR", message="Database write unacknowledged.", status_code=503)

        if "full_name" in updates:
            session["full_name"] = updates["full_name"]

        log_audit(
            actor_id=user_id,
            actor_role="citizen",
            action="PROFILE_UPDATE",
            target_collection="users",
            target_id=user_id,
            before_after_summary=updates,
            ip=request.remote_addr
        )

        return success_response({
            "message": "Profile updated successfully.",
            "updated_fields": list(updates.keys())
        })
    except Exception as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)
