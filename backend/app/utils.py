"""Shared utility functions for code formatting and file application."""

from __future__ import annotations

import uuid

_EXT_TO_LANG: dict[str, str] = {
    ".tsx": "tsx",
    ".ts": "ts",
    ".css": "css",
    ".json": "json",
}


def lang_from_path(path: str) -> str:
    """Infer language from file extension, defaulting to tsx."""
    dot = path.rfind(".")
    if dot != -1:
        ext = path[dot:]
        lang = _EXT_TO_LANG.get(ext)
        if lang is not None:
            return lang
    return None


def format_files_as_code_blocks(files: list[dict]) -> str:
    """Convert a list of file dicts back into fenced code block text."""
    blocks: list[str] = []
    for f in files:
        lang = f.get("language") or lang_from_path(f["path"])
        path = f["path"]
        code = f["code"]
        blocks.append(f"```{lang}{{path={path}}}\n{code}\n```")
    return "\n\n".join(blocks)


def normalize_uploaded_image_record(
    payload: object,
    *,
    default_name: str = "uploaded_image",
    index_hint: int | None = None,
    source: str = "user_upload",
) -> dict[str, str] | None:
    """Return a normalized uploaded-image record or ``None``."""
    next_index = index_hint or 1

    if isinstance(payload, str) and payload:
        return {
            "id": uuid.uuid4().hex,
            "label": f"Image {next_index}",
            "name": f"{default_name}-{next_index}",
            "url": payload,
            "source": source,
        }

    if not isinstance(payload, dict):
        return None

    url = payload.get("url", "")
    if not isinstance(url, str) or not url:
        return None

    name = payload.get("name", default_name)
    if not isinstance(name, str) or not name:
        name = default_name

    label = payload.get("label", "")
    if not isinstance(label, str) or not label:
        label = f"Image {next_index}"

    image_id = payload.get("id", "")
    if not isinstance(image_id, str) or not image_id:
        image_id = uuid.uuid4().hex

    image_source = payload.get("source", source)
    if not isinstance(image_source, str) or not image_source:
        image_source = source

    return {
        "id": image_id,
        "label": label,
        "name": name,
        "url": url,
        "source": image_source,
    }


def apply_file_actions(
    existing: list[dict],
    actions: list[dict],
) -> list[dict]:
    """Apply edit/add/delete actions to an existing file list.

    Each action dict must have ``action`` ("create", "edit", "add", or
    "delete") and ``path``.  For "create", "edit" and "add", ``language``
    and ``code`` are required.
    """
    files_by_path: dict[str, dict] = {f["path"]: dict(f) for f in existing}

    for act in actions:
        action = act["action"]
        path = act["path"]

        if action == "delete":
            files_by_path.pop(path, None)
        elif action in ("create", "edit", "add"):
            files_by_path[path] = {
                "language": act.get("language", "tsx"),
                "path": path,
                "code": act.get("code", ""),
            }

    return list(files_by_path.values())
