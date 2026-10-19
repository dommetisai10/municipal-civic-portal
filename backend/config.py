"""Configuration loader for Municipal Service Portal backend."""

import os
from pathlib import Path
from dotenv import load_dotenv

# Base directory for the backend package
BACKEND_DIR = Path(__file__).resolve().parent

# Load environment variables from backend/.env if present
env_path = BACKEND_DIR / ".env"
load_dotenv(dotenv_path=env_path)


class Config:
    """Application configuration with sensible defaults and clean data guarantees."""

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

    # MongoDB Connection
    MONGO_URI = os.getenv("MONGO_URI", "mongodb://127.0.0.1:27017/")
    MONGO_DB_NAME = os.getenv("MONGO_DB_NAME", "municipal_civic_portal")

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

    # Municipal Contact Info & Branding (placeholders until officially configured)
    PORTAL_MUNICIPALITY_NAME = os.getenv("PORTAL_MUNICIPALITY_NAME", "Municipal Service Portal")
    PORTAL_CONTACT_PHONE = os.getenv("PORTAL_CONTACT_PHONE", "[Contact phone – to be configured]")
    PORTAL_CONTACT_EMAIL = os.getenv("PORTAL_CONTACT_EMAIL", "[Contact email – to be configured]")
    PORTAL_OFFICE_ADDRESS = os.getenv("PORTAL_OFFICE_ADDRESS", "[Office address – to be configured]")


class TestingConfig(Config):
    """Testing configuration overriding database and session security."""
    TESTING = True
    DEBUG = False
    MONGO_DB_NAME = "municipal_civic_portal_test"
    SESSION_COOKIE_SECURE = False
    RATELIMIT_ENABLED = False

