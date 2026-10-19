"""Public portal configuration and metadata routes."""

from flask import Blueprint, current_app
from backend.utils.responses import success_response
from backend.services.db import get_collection

portal_bp = Blueprint("portal", __name__, url_prefix="/api")


@portal_bp.route("/config", methods=["GET"])
def get_portal_config():
    """
    Returns public portal branding and contact details driven by configuration.
    Never exposes internal server secrets, database URIs, or private keys.
    """
    config = current_app.config
    data = {
        "municipality_name": config.get("PORTAL_MUNICIPALITY_NAME", "Municipal Service Portal"),
        "contact_phone": config.get("PORTAL_CONTACT_PHONE", "[Contact phone – to be configured]"),
        "contact_email": config.get("PORTAL_CONTACT_EMAIL", "[Contact email – to be configured]"),
        "office_address": config.get("PORTAL_OFFICE_ADDRESS", "[Office address – to be configured]")
    }
    return success_response(data=data)
