"""MongoDB connection manager using PyMongo with pooling, retry, and latency tracking."""

import atexit
import logging
import re
import time
from urllib.parse import urlparse
from pymongo import MongoClient
from pymongo.errors import ConnectionFailure, ServerSelectionTimeoutError, PyMongoError
from backend.config import Config, START_TIME

logger = logging.getLogger("civic_portal.db")

# Global MongoClient singleton instance
_mongo_client = None


def sanitize_uri(uri: str) -> str:
    """Masks password credentials in MongoDB connection string for safe logging."""
    if not uri:
        return ""
    # Mask password in mongodb:// or mongodb+srv:// URIs
    return re.sub(r":([^@/]+)@", r":****@", uri)


def get_mongo_client(uri=None):
    """Returns or initializes the MongoClient singleton instance with configured pooling and TLS."""
    global _mongo_client
    if _mongo_client is None:
        target_uri = uri or Config.MONGO_URI

        # Ensure robust Atlas SRV resolution across restrictive router/ISP DNS servers
        try:
            import dns.resolver
            dns_res = dns.resolver.get_default_resolver()
            if dns_res and "8.8.8.8" not in dns_res.nameservers:
                dns_res.nameservers = ["8.8.8.8", "1.1.1.1"] + list(dns_res.nameservers)
        except Exception:
            pass

        # Robust TLS root CA certificate resolution
        tls_kwargs = {}
        if target_uri.startswith("mongodb+srv://") or "ssl=true" in target_uri.lower() or "tls=true" in target_uri.lower():
            try:
                import certifi
                tls_kwargs["tlsCAFile"] = certifi.where()
            except ImportError:
                pass

        # Allow insecure TLS certificates if explicitly configured for local debugging
        if Config.MONGO_TLS_ALLOW_INVALID:
            tls_kwargs["tlsAllowInvalidCertificates"] = True

        _mongo_client = MongoClient(
            target_uri,
            serverSelectionTimeoutMS=Config.MONGO_SERVER_SELECTION_TIMEOUT_MS,
            connectTimeoutMS=Config.MONGO_CONNECT_TIMEOUT_MS,
            socketTimeoutMS=Config.MONGO_SOCKET_TIMEOUT_MS,
            maxPoolSize=Config.MONGO_MAX_POOL_SIZE,
            minPoolSize=Config.MONGO_MIN_POOL_SIZE,
            maxIdleTimeMS=Config.MONGO_MAX_IDLE_TIME_MS,
            retryWrites=Config.MONGO_RETRY_WRITES,
            uuidRepresentation="standard",
            **tls_kwargs
        )
        logger.info("MongoClient initialized for %s", sanitize_uri(target_uri))

    return _mongo_client


def get_db(db_name=None):
    """Returns the PyMongo database instance."""
    client = get_mongo_client()
    target_name = db_name or Config.MONGO_DB_NAME
    return client[target_name]


def get_collection(collection_name):
    """Returns a specific collection from the configured database."""
    db = get_db()
    return db[collection_name]


def check_db_connection():
    """
    Checks MongoDB connectivity honestly using the admin ping command.
    Returns:
        tuple (is_connected: bool, message: str)
    """
    t0 = time.time()
    try:
        client = get_mongo_client()
        client.admin.command("ping")
        latency_ms = round((time.time() - t0) * 1000, 2)
        return True, f"MongoDB connection established ({latency_ms} ms)."
    except (ConnectionFailure, ServerSelectionTimeoutError, PyMongoError) as exc:
        latency_ms = round((time.time() - t0) * 1000, 2)
        logger.error("MongoDB connection check failed (%s ms): %s", latency_ms, exc)
        return False, f"Database unavailable: {str(exc)}"
    except Exception as exc:
        latency_ms = round((time.time() - t0) * 1000, 2)
        logger.error("Unexpected error during MongoDB check: %s", exc)
        return False, f"Database error: {str(exc)}"


def connect_with_retry(max_retries=3, initial_delay=1.0, backoff_factor=2.0):
    """
    Attempts to connect to MongoDB with exponential backoff.
    Returns (success: bool, final_message: str)
    """
    delay = initial_delay
    last_msg = ""

    for attempt in range(1, max_retries + 1):
        logger.info("Attempting MongoDB connection (attempt %d/%d)...", attempt, max_retries)
        is_connected, msg = check_db_connection()
        if is_connected:
            logger.info("Database connection verified: %s", msg)
            return True, msg

        last_msg = msg
        if attempt < max_retries:
            logger.warning("Connection attempt %d failed: %s. Retrying in %.1fs...", attempt, msg, delay)
            time.sleep(delay)
            delay *= backoff_factor

    return False, last_msg


def get_db_diagnostics():
    """Returns complete diagnostic health metrics for /api/health."""
    t0 = time.time()
    is_connected, msg = check_db_connection()
    latency_ms = round((time.time() - t0) * 1000, 2) if is_connected else None
    uptime_seconds = round(time.time() - START_TIME, 1)

    collections_count = 0
    if is_connected:
        try:
            db = get_db()
            collections_count = len(db.list_collection_names())
        except Exception:
            pass

    return {
        "status": "healthy" if is_connected else "degraded",
        "database": "connected" if is_connected else "disconnected",
        "latency_ms": latency_ms,
        "uptime_seconds": uptime_seconds,
        "collections_count": collections_count,
        "database_name": Config.MONGO_DB_NAME,
        "uri_target": sanitize_uri(Config.MONGO_URI),
        "message": msg
    }


def close_db_connection():
    """Closes the MongoClient singleton instance gracefully."""
    global _mongo_client
    if _mongo_client is not None:
        try:
            _mongo_client.close()
            logger.info("Closed MongoDB connection pool gracefully.")
        except Exception as e:
            logger.error("Error closing MongoDB connection: %s", e)
        finally:
            _mongo_client = None


# Ensure pool closes automatically on process exit
atexit.register(close_db_connection)
