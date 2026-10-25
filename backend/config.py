"""Configuration loader and validator for Municipal Service Portal backend.

Reads all settings from environment variables, provides fail-fast validation,
sensible defaults for local development, and clean architecture guarantees.
"""

import os
import sys
import time
from pathlib import Path
from dotenv import load_dotenv

# Track application start time for health check uptime calculation
START_TIME = time.time()

# Base directory for backend package and root workspace
BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_DIR.parent

# Load environment variables strictly before any config values are evaluated
env_path = BACKEND_DIR / ".env"
if env_path.exists():
    load_dotenv(dotenv_path=env_path)
else:
    root_env = PROJECT_ROOT / ".env"
    if root_env.exists():
        load_dotenv(dotenv_path=root_env)


class Config:
    """Application configuration with validation and clean data guarantees."""

    # Environment & Debugging
    FLASK_ENV = os.getenv("FLASK_ENV", "development")
    DEBUG = os.getenv("FLASK_DEBUG", "1").lower() in ("1", "true", "yes")

    # Host & Port
    HOST = os.getenv("HOST", "127.0.0.1")
    PORT = int(os.getenv("PORT", "5000"))

    # Cryptographic Secret Key
    SECRET_KEY = os.getenv(
        "SECRET_KEY",
        "dev-insecure-secret-key-change-in-production-min32chars-xyz"
    )

    # Session & Cookie Security
    SESSION_COOKIE_SECURE = os.getenv("SESSION_COOKIE_SECURE", "false").lower() in ("1", "true", "yes")
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"

    # MongoDB Connection Settings
    MONGO_URI = os.getenv("MONGO_URI", "mongodb://127.0.0.1:27017/")
    MONGO_DB_NAME = os.getenv("MONGO_DB_NAME", "municipal_civic_portal")
    MONGO_CONNECT_TIMEOUT_MS = int(os.getenv("MONGO_CONNECT_TIMEOUT_MS", "5000"))
    MONGO_SERVER_SELECTION_TIMEOUT_MS = int(os.getenv("MONGO_SERVER_SELECTION_TIMEOUT_MS", "5000"))
    MONGO_SOCKET_TIMEOUT_MS = int(os.getenv("MONGO_SOCKET_TIMEOUT_MS", "10000"))
    MONGO_MAX_POOL_SIZE = int(os.getenv("MONGO_MAX_POOL_SIZE", "50"))
    MONGO_MIN_POOL_SIZE = int(os.getenv("MONGO_MIN_POOL_SIZE", "5"))
    MONGO_MAX_IDLE_TIME_MS = int(os.getenv("MONGO_MAX_IDLE_TIME_MS", "45000"))
    MONGO_TLS_ALLOW_INVALID = os.getenv("MONGO_TLS_ALLOW_INVALID", "false").lower() in ("1", "true", "yes")
    MONGO_RETRY_WRITES = os.getenv("MONGO_RETRY_WRITES", "true").lower() in ("1", "true", "yes")

    # Allowed CORS Origins
    cors_raw = os.getenv(
        "CORS_ORIGINS",
        "http://127.0.0.1:5500,http://localhost:5500,http://127.0.0.1:5000,http://localhost:5000"
    )
    CORS_ORIGINS = [origin.strip() for origin in cors_raw.split(",") if origin.strip()]

    # File Upload Directory (stored strictly outside public static web roots)
    upload_cfg = os.getenv("UPLOAD_FOLDER", "uploads")
    if os.path.isabs(upload_cfg):
        UPLOAD_FOLDER = Path(upload_cfg)
    else:
        UPLOAD_FOLDER = BACKEND_DIR / upload_cfg

    # File Upload Limits: 5 MB per file
    MAX_CONTENT_LENGTH = int(os.getenv("MAX_CONTENT_LENGTH", str(5 * 1024 * 1024)))

    # Municipal Contact Info & Branding
    PORTAL_MUNICIPALITY_NAME = os.getenv("PORTAL_MUNICIPALITY_NAME", "Municipal Service Portal")
    PORTAL_CONTACT_PHONE = os.getenv("PORTAL_CONTACT_PHONE", "[Contact phone – to be configured]")
    PORTAL_CONTACT_EMAIL = os.getenv("PORTAL_CONTACT_EMAIL", "[Contact email – to be configured]")
    PORTAL_OFFICE_ADDRESS = os.getenv("PORTAL_OFFICE_ADDRESS", "[Office address – to be configured]")

    # Administrator Initial Credentials
    ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "admin@municipal.gov")
    ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "Admin@12345")
    ADMIN_NAME = os.getenv("ADMIN_NAME", "Municipal Administrator")

    @classmethod
    def validate(cls):
        """Validates critical configuration parameters and raises informative errors."""
        missing = []
        if not cls.MONGO_URI:
            missing.append("MONGO_URI")
        if not cls.MONGO_DB_NAME:
            missing.append("MONGO_DB_NAME")
        if not cls.SECRET_KEY:
            missing.append("SECRET_KEY")

        if missing:
            raise ValueError(f"Configuration error: Missing required environment variable(s): {', '.join(missing)}")
        return True


class TestingConfig(Config):
    """Testing configuration overriding database and session security."""
    TESTING = True
    DEBUG = False
    MONGO_DB_NAME = "municipal_civic_portal_test"
    SESSION_COOKIE_SECURE = False
    RATELIMIT_ENABLED = False
