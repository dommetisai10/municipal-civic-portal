"""Public and citizen municipal services catalog routes."""

from flask import Blueprint, request
from bson import ObjectId
from pymongo.errors import PyMongoError
from backend.services.db import get_collection
from backend.utils.responses import success_response, error_response

services_bp = Blueprint("services", __name__, url_prefix="/api")


@services_bp.route("/services", methods=["GET"])
def get_services():
    """
    Returns municipal services from the database.
    STRICT CLEAN DATA RULE:
    Returns live database records only. If no services have been published, returns an empty list.
    """
    try:
        services_col = get_collection("services")
        # Fetch active or published services sorted by name
        cursor = services_col.find({}).sort("name", 1)
        results = []
        for doc in cursor:
            results.append({
                "id": str(doc["_id"]),
                "slug": doc.get("slug", ""),
                "name": doc.get("name", ""),
                "category": doc.get("category", "General"),
                "department": doc.get("department", doc.get("category", "General Administration")),
                "description": doc.get("description", ""),
                "fee": doc.get("fee", 0),
                "processing_days": doc.get("processing_days", 7),
                "availability": doc.get("availability", "Unavailable"),
                "required_documents": doc.get("required_documents", []),
                "form_schema": doc.get("form_schema", [])
            })
        return success_response(data=results)
    except PyMongoError as exc:
        return error_response(
            code="DATABASE_ERROR",
            message="Failed to retrieve services from database.",
            fields={"details": str(exc)},
            status_code=503
        )


@services_bp.route("/services/<service_identifier>", methods=["GET"])
def get_service_detail(service_identifier):
    """Retrieves a single service by slug or ObjectId."""
    try:
        services_col = get_collection("services")
        query = {"slug": service_identifier}
        if ObjectId.is_valid(service_identifier):
            query = {"$or": [{"slug": service_identifier}, {"_id": ObjectId(service_identifier)}]}

        doc = services_col.find_one(query)
        if not doc:
            return error_response(code="SERVICE_NOT_FOUND", message="Requested service does not exist.", status_code=404)

        return success_response(data={
            "id": str(doc["_id"]),
            "slug": doc.get("slug", ""),
            "name": doc.get("name", ""),
            "category": doc.get("category", "General"),
            "department": doc.get("department", doc.get("category", "General Administration")),
            "description": doc.get("description", ""),
            "fee": doc.get("fee", 0),
            "processing_days": doc.get("processing_days", 7),
            "availability": doc.get("availability", "Unavailable"),
            "required_documents": doc.get("required_documents", []),
            "form_schema": doc.get("form_schema", [])
        })
    except PyMongoError as exc:
        return error_response(code="DATABASE_ERROR", message=str(exc), status_code=503)
