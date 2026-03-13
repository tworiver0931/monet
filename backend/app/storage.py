from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

from google.cloud import storage

from .config import GCS_BUCKET

CONTENT_TYPE_MAP = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
}

_gcs_client: storage.Client | None = None


def _get_gcs_client() -> storage.Client:
    global _gcs_client
    if _gcs_client is None:
        _gcs_client = storage.Client()
    return _gcs_client


def _upload_sync(
    data: bytes,
    blob_name: str,
    resolved_content_type: str,
) -> str:
    """Synchronous GCS upload — runs in a thread via upload_public_blob."""
    client = _get_gcs_client()
    bucket = client.bucket(GCS_BUCKET)
    blob = bucket.blob(blob_name)
    blob.upload_from_string(data, content_type=resolved_content_type, timeout=60)
    blob.make_public(timeout=30)
    return blob.public_url


async def upload_public_blob(
    *,
    data: bytes,
    filename: str,
    content_type: str | None = None,
    prefix: str = "uploads",
) -> str:
    if not GCS_BUCKET:
        raise RuntimeError("GCS_BUCKET not configured")

    ext = Path(filename).suffix.lower() or ".bin"
    blob_name = f"{prefix}/{uuid.uuid4().hex}{ext}"
    resolved_content_type = content_type or CONTENT_TYPE_MAP.get(
        ext,
        "application/octet-stream",
    )

    return await asyncio.to_thread(_upload_sync, data, blob_name, resolved_content_type)
