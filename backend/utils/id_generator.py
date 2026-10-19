"""Unique identifier generator for municipal applications and complaints."""

import secrets
from datetime import datetime, timezone

# 32-character unambiguous alphanumeric alphabet (excluding lookalikes like 0/O, 1/I)
CHARSET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"


def generate_record_id(prefix="MSP-APP") -> str:
    """
    Generates a record ID following the specification:
    - Application IDs: MSP-APP-YYYY-XXXXXXXX
    - Complaint IDs:   MSP-CMP-YYYY-XXXXXXXX
    Example: MSP-APP-2026-K8F2N9X4
    """
    year = datetime.now(timezone.utc).year
    suffix = "".join(secrets.choice(CHARSET) for _ in range(8))
    return f"{prefix}-{year}-{suffix}"
