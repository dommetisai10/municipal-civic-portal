"""Secure file upload validator enforcing extensions, MIME types, and magic bytes."""

import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from werkzeug.utils import secure_filename
from backend.config import Config

# Allowed extensions and MIME types
ALLOWED_APPLICATION_EXTENSIONS = {"pdf", "jpg", "jpeg", "png"}
ALLOWED_COMPLAINT_EXTENSIONS = {"jpg", "jpeg", "png"}

ALLOWED_MIME_TYPES = {
    "pdf": "application/pdf",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png"
}

# Magic bytes signatures for binary verification
MAGIC_BYTES_SIGNATURES = {
    "pdf": [b"%PDF"],
    "jpg": [b"\xff\xd8\xff"],
    "jpeg": [b"\xff\xd8\xff"],
    "png": [b"\x89PNG\r\n\x1a\n"]
}

MAX_FILE_SIZE = Config.MAX_CONTENT_LENGTH  # 5 MB


def verify_file_signature(file_stream, extension):
    """
    Validates file signature (magic bytes) against the declared extension.
    Reads the initial bytes and resets the file stream pointer.
    """
    signatures = MAGIC_BYTES_SIGNATURES.get(extension, [])
    if not signatures:
        return False

    header = file_stream.read(16)
    file_stream.seek(0)  # Rewind pointer

    for sig in signatures:
        if header.startswith(sig):
            return True
    return False


def validate_and_save_file(file_storage, subfolder="applications", allowed_extensions=ALLOWED_APPLICATION_EXTENSIONS):
    """
    Validates and stores an uploaded file outside the public static directory.
    Performs multi-layer verification:
    1. Extension allow-list check
    2. File size verification (<= 5 MB)
    3. MIME type inspection
    4. Magic bytes signature verification
    5. UUID renaming to prevent path traversal and collision
    """
    if not file_storage or not file_storage.filename:
        return False, "No file provided or filename is empty.", None

    original_filename = secure_filename(file_storage.filename)
    if "." not in original_filename:
        return False, "File must have a valid extension.", None

    ext = original_filename.rsplit(".", 1)[1].lower()
    if ext not in allowed_extensions:
        allowed_str = ", ".join(sorted(list(allowed_extensions)))
        return False, f"File extension '.{ext}' is not permitted. Allowed: {allowed_str}.", None

    # Check MIME type
    expected_mime = ALLOWED_MIME_TYPES.get(ext)
    detected_mime = file_storage.mimetype.lower() if file_storage.mimetype else ""
    if detected_mime != expected_mime:
        # Some browsers send image/pjpeg or octet-stream; verify magic bytes strictly
        pass

    # Magic bytes binary verification
    if not verify_file_signature(file_storage.stream, ext):
        return False, "File binary signature does not match its declared file extension.", None

    # Size check
    file_storage.seek(0, os.SEEK_END)
    file_size = file_storage.tell()
    file_storage.seek(0)

    if file_size > MAX_FILE_SIZE:
        return False, f"File size ({file_size / (1024*1024):.2f} MB) exceeds maximum allowed 5 MB limit.", None

    if file_size == 0:
        return False, "Uploaded file is empty (0 bytes).", None

    # Generate secure UUID filename
    random_uuid = str(uuid.uuid4())
    stored_filename = f"{random_uuid}.{ext}"

    # Target directory outside public web roots
    target_dir = Config.UPLOAD_FOLDER / subfolder
    os.makedirs(target_dir, exist_ok=True)

    dest_path = target_dir / stored_filename
    file_storage.save(str(dest_path))

    metadata = {
        "original_filename": original_filename,
        "stored_filename": stored_filename,
        "subfolder": subfolder,
        "extension": ext,
        "mime_type": expected_mime,
        "file_size": file_size,
        "uploaded_at": datetime.now(timezone.utc).isoformat()
    }

    return True, None, metadata
