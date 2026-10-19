"""Rate limiting service extension for Municipal Service Portal."""

from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

limiter = Limiter(
    key_func=get_remote_address,
    default_limits=["500 per hour", "100 per minute"],
    storage_uri="memory://"
)
