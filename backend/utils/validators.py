"""Validation and sanitation utilities for input integrity and NoSQL injection defense."""

import re

# Regex patterns
EMAIL_REGEX = re.compile(r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$")
PASSWORD_UPPER_REGEX = re.compile(r"[A-Z]")
PASSWORD_LOWER_REGEX = re.compile(r"[a-z]")
PASSWORD_DIGIT_REGEX = re.compile(r"[0-9]")
MOBILE_REGEX = re.compile(r"^\+?[0-9]{10,15}$")


def sanitize_string(value, field_name="field", max_length=500, min_length=0, required=True):
    """
    Validates and cleanses string input, guarding against NoSQL operator injection.
    Rejects dictionaries, lists, or non-string structures.
    """
    if value is None:
        if required:
            return False, f"'{field_name}' is required."
        return True, ""

    # NoSQL injection defense: reject non-string types (such as dicts containing $gt, $ne, etc.)
    if not isinstance(value, str):
        return False, f"'{field_name}' must be a string."

    stripped = value.strip()
    if required and len(stripped) < min_length:
        return False, f"'{field_name}' must be at least {min_length} characters."

    if len(stripped) > max_length:
        return False, f"'{field_name}' exceeds maximum length of {max_length} characters."

    return True, stripped


def validate_email(email):
    """Validates and normalizes email address."""
    valid, res = sanitize_string(email, field_name="email", max_length=254, min_length=5, required=True)
    if not valid:
        return False, res

    normalized = res.lower()
    if not EMAIL_REGEX.match(normalized):
        return False, "Please provide a valid email address."

    return True, normalized


def validate_password(password):
    """
    Enforces password complexity:
    - Minimum 8 characters, maximum 128 characters
    - At least 1 uppercase letter
    - At least 1 lowercase letter
    - At least 1 digit
    """
    if not isinstance(password, str):
        return False, "Password must be a string."

    if len(password) < 8:
        return False, "Password must be at least 8 characters long."

    if len(password) > 128:
        return False, "Password exceeds maximum length of 128 characters."

    if not PASSWORD_UPPER_REGEX.search(password):
        return False, "Password must contain at least one uppercase letter (A-Z)."

    if not PASSWORD_LOWER_REGEX.search(password):
        return False, "Password must contain at least one lowercase letter (a-z)."

    if not PASSWORD_DIGIT_REGEX.search(password):
        return False, "Password must contain at least one digit (0-9)."

    return True, password


def validate_mobile(mobile, required=True):
    """Validates telephone/mobile number (10 to 15 digits, optional leading +)."""
    valid, res = sanitize_string(mobile, field_name="mobile", max_length=20, min_length=10, required=required)
    if not valid:
        return valid, res

    # Remove hyphens or spaces
    cleaned = res.replace(" ", "").replace("-", "")
    if not MOBILE_REGEX.match(cleaned):
        return False, "Mobile number must contain between 10 and 15 digits."

    return True, cleaned


def validate_registration_payload(data):
    """Validates citizen registration payload, returning (is_valid, sanitized_data, errors_dict)."""
    if not isinstance(data, dict):
        return False, None, {"general": "Invalid request body; must be a JSON object."}

    errors = {}
    sanitized = {}

    # Full Name
    ok, name_val = sanitize_string(data.get("full_name"), field_name="full_name", min_length=2, max_length=100)
    if not ok:
        errors["full_name"] = name_val
    else:
        sanitized["full_name"] = name_val

    # Email
    ok, email_val = validate_email(data.get("email"))
    if not ok:
        errors["email"] = email_val
    else:
        sanitized["email"] = email_val

    # Mobile
    ok, mobile_val = validate_mobile(data.get("mobile"), required=True)
    if not ok:
        errors["mobile"] = mobile_val
    else:
        sanitized["mobile"] = mobile_val

    # Address
    ok, addr_val = sanitize_string(data.get("address"), field_name="address", min_length=5, max_length=300)
    if not ok:
        errors["address"] = addr_val
    else:
        sanitized["address"] = addr_val

    # Password
    ok, pass_val = validate_password(data.get("password"))
    if not ok:
        errors["password"] = pass_val
    else:
        sanitized["password"] = pass_val

    if errors:
        return False, None, errors

    return True, sanitized, None
