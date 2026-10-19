"""MongoDB connection manager using PyMongo."""

import logging
from pymongo import MongoClient
from pymongo.errors import ConnectionFailure, ServerSelectionTimeoutError, PyMongoError
from backend.config import Config

logger = logging.getLogger(__name__)

# Global MongoClient singleton instance
_mongo_client = None


def get_mongo_client(uri=None):
    """Returns or initializes the MongoClient singleton instance."""
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

        # 5-second server selection timeout accommodates remote Atlas TLS handshakes
        _mongo_client = MongoClient(
            target_uri,
            serverSelectionTimeoutMS=5000,
            connectTimeoutMS=5000,
            socketTimeoutMS=10000,
            uuidRepresentation="standard"
        )
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
    Checks MongoDB connectivity honestly using the ping administrative command.
    Returns:
        tuple (is_connected: bool, message: str)
    """
    try:
        client = get_mongo_client()
        # Ping the admin database to verify connectivity
        client.admin.command("ping")
        return True, "MongoDB connection established and responsive."
    except (ConnectionFailure, ServerSelectionTimeoutError, PyMongoError) as exc:
        logger.error("MongoDB connection check failed: %s", exc)
        return False, f"Database unavailable: {str(exc)}"
    except Exception as exc:
        logger.error("Unexpected error during MongoDB check: %s", exc)
        return False, f"Database error: {str(exc)}"


def close_db_connection():
    """Closes the MongoClient singleton instance."""
    global _mongo_client
    if _mongo_client is not None:
        _mongo_client.close()
        _mongo_client = None
        logger.info("Closed MongoDB connection.")
