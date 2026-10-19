"""Flask application factory and entry point for Municipal Service Portal backend."""

import os
import logging
from flask import Flask, request
from flask_cors import CORS
from backend.config import Config
from backend.services.limiter import limiter
from backend.utils.responses import error_response
from backend.routes.health import health_bp

# Configure logging format
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("civic_portal")


def create_app(config_class=Config):
    """Factory creating and configuring the Flask application instance."""
    from pathlib import Path
    frontend_dir = (Path(__file__).resolve().parent.parent / "frontend").resolve()
    app = Flask(__name__, static_folder=str(frontend_dir), static_url_path="")
    app.config.from_object(config_class)

    # Ensure secure upload directory exists outside public static folders
    os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)

    # Initialize CORS
    CORS(
        app,
        resources={r"/api/*": {"origins": app.config["CORS_ORIGINS"]}},
        supports_credentials=True,
        expose_headers=["Content-Type", "X-CSRF-Token"],
        allow_headers=["Content-Type", "X-CSRF-Token", "Authorization"]
    )

    # Initialize rate limiter
    limiter.init_app(app)

    # Security headers on all HTTP responses
    @app.after_request
    def set_security_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(self)"
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        response.headers["X-XSS-Protection"] = "0"
        # Content Security Policy preventing unauthorized script execution and embedding
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "img-src 'self' data: blob:; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src 'self' https://fonts.gstatic.com; "
            "script-src 'self'; "
            "connect-src 'self' http://127.0.0.1:* http://localhost:*;"
        )
        return response

    # Global JSON error handlers
    @app.errorhandler(400)
    def handle_bad_request(err):
        return error_response(code="BAD_REQUEST", message=str(err.description or "Bad request"), status_code=400)

    @app.errorhandler(404)
    def handle_not_found(err):
        return error_response(code="NOT_FOUND", message="The requested resource was not found.", status_code=404)

    @app.errorhandler(405)
    def handle_method_not_allowed(err):
        return error_response(code="METHOD_NOT_ALLOWED", message="HTTP method not allowed for this endpoint.", status_code=405)

    @app.errorhandler(413)
    def handle_payload_too_large(err):
        return error_response(code="FILE_TOO_LARGE", message="Uploaded file exceeds the maximum 5 MB limit.", status_code=413)

    @app.errorhandler(429)
    def handle_rate_limit(err):
        return error_response(code="RATE_LIMIT_EXCEEDED", message="Too many requests. Please slow down and try again later.", status_code=429)

    @app.errorhandler(500)
    def handle_internal_error(err):
        logger.error("Internal Server Error: %s", err)
        return error_response(code="INTERNAL_SERVER_ERROR", message="An unexpected internal server error occurred.", status_code=500)

    # Database connection error handler returning HTTP 503
    from pymongo.errors import PyMongoError, ServerSelectionTimeoutError, ConnectionFailure

    @app.errorhandler(ServerSelectionTimeoutError)
    @app.errorhandler(ConnectionFailure)
    @app.errorhandler(PyMongoError)
    def handle_db_error(err):
        logger.error("Database connection failure: %s", err)
        return error_response(
            code="DATABASE_UNAVAILABLE",
            message="Database connection failed. Please ensure MongoDB is running or check connection configuration.",
            status_code=503
        )

    # Session and Cookie Configuration
    app.config["SESSION_COOKIE_HTTPONLY"] = config_class.SESSION_COOKIE_HTTPONLY
    app.config["SESSION_COOKIE_SECURE"] = config_class.SESSION_COOKIE_SECURE
    app.config["SESSION_COOKIE_SAMESITE"] = config_class.SESSION_COOKIE_SAMESITE

    # Register Blueprints
    from backend.routes.auth import auth_bp
    from backend.routes.admin_auth import admin_auth_bp
    from backend.routes.portal import portal_bp
    from backend.routes.services import services_bp
    from backend.routes.dashboard import dashboard_bp
    from backend.routes.notifications import notifications_bp
    from backend.routes.applications import applications_bp
    from backend.routes.complaints import complaints_bp
    from backend.routes.track import track_bp
    from backend.routes.admin_portal import admin_portal_bp

    app.register_blueprint(health_bp)
    app.register_blueprint(auth_bp)
    app.register_blueprint(admin_auth_bp)
    app.register_blueprint(portal_bp)
    app.register_blueprint(services_bp)
    app.register_blueprint(dashboard_bp)
    app.register_blueprint(notifications_bp)
    app.register_blueprint(applications_bp)
    app.register_blueprint(complaints_bp)
    app.register_blueprint(track_bp)
    app.register_blueprint(admin_portal_bp)

    # Serve Frontend Single-Page and Static Assets
    @app.route("/")
    def serve_index():
        return app.send_static_file("index.html")

    @app.route("/<path:page>")
    def serve_page(page):
        clean_page = page.strip("/")
        if clean_page.startswith("api"):
            return handle_not_found(Exception("The requested API resource was not found."))
        candidate_html = frontend_dir / f"{clean_page}.html"
        if candidate_html.is_file():
            return app.send_static_file(f"{clean_page}.html")
        candidate_direct = frontend_dir / clean_page
        if candidate_direct.is_file():
            return app.send_static_file(clean_page)
        return handle_not_found(Exception("The requested page was not found."))

    return app


# Application instance for dev servers / WSGI
app = create_app()

if __name__ == "__main__":
    logger.info("Starting Municipal Service Portal backend on http://%s:%d", Config.HOST, Config.PORT)
    app.run(host=Config.HOST, port=Config.PORT, debug=Config.DEBUG)
