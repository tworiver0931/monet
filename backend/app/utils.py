"""Shared utility functions for code extraction and formatting."""

from __future__ import annotations

import re

_CODE_BLOCK_PATTERN = re.compile(r"```(\w+)\{path=([^}]+)\}\n([\s\S]*?)```")

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
    return "tsx"


def extract_code_files_from_text(text: str) -> list[dict] | None:
    """Parse fenced code blocks with ``{path=...}`` annotations."""
    matches = _CODE_BLOCK_PATTERN.findall(text)
    if not matches:
        return None
    return [
        {"language": lang, "path": path, "code": code.rstrip()}
        for lang, path, code in matches
    ]


def extract_result_text_from_function_response(function_response) -> str | None:
    """Extract text payload from a function response part."""
    if not function_response:
        return None

    response = getattr(function_response, "response", None)
    if isinstance(response, dict):
        result = response.get("result")
        if isinstance(result, str):
            return result
        return None

    if isinstance(response, str):
        return response

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
