"""Audit logging service for tracking state changes and administrative actions."""

import logging
from datetime import datetime, timezone
from backend.services.db import get_collection

logger = logging.getLogger(__name__)


def log_audit(actor_id, actor_role, action, target_collection, target_id, before_after_summary=None, ip=None):
    """
    Records an entry in the audit_logs collection with an acknowledged write.
    """
    try:
        audit_col = get_collection("audit_logs")
        entry = {
            "actor_id": str(actor_id) if actor_id else "system",
            "actor_role": str(actor_role) if actor_role else "system",
            "action": str(action),
            "target_collection": str(target_collection),
            "target_id": str(target_id) if target_id else None,
            "before_after_summary": before_after_summary or {},
            "ip": str(ip) if ip else None,
            "created_at": datetime.now(timezone.utc)
        }
        res = audit_col.insert_one(entry)
        if not res.acknowledged:
            logger.error("Audit log write was unacknowledged for action: %s", action)
            return False
        return True
    except Exception as exc:
        logger.error("Failed to write audit log entry: %s", exc)
        return False
