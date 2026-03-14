"""
File operation tools for the code agent.

These tools operate on tool_context.state["code_files"], which is a list of
dicts with keys: path, code.
"""

from __future__ import annotations

from google.adk.tools import ToolContext


def _files_by_path(tool_context: ToolContext) -> dict[str, dict]:
    """Build a path-keyed dict from the code_files list.

    The result is cached on the state dict under ``_code_files_index`` and
    invalidated whenever ``code_files`` changes identity (i.e. is reassigned).
    """
    files: list[dict] = tool_context.state.get("code_files", [])
    cached = tool_context.state.get("_code_files_index")
    cached_source = tool_context.state.get("_code_files_index_source")
    if cached is not None and cached_source is files:
        return cached
    index = {f["path"]: f for f in files}
    tool_context.state["_code_files_index"] = index
    tool_context.state["_code_files_index_source"] = files
    return index


def _save_files(tool_context: ToolContext, by_path: dict[str, dict]) -> None:
    """Persist the path-keyed dict back to code_files and update the cache."""
    files = list(by_path.values())
    tool_context.state["code_files"] = files
    tool_context.state["_code_files_index"] = by_path
    tool_context.state["_code_files_index_source"] = files


async def list_files(tool_context: ToolContext) -> dict:
    """List all file paths in the current codebase.

    Returns:
        A dict with a "files" key containing the list of file paths.
    """
    by_path = _files_by_path(tool_context)
    return {"files": list(by_path.keys())}


async def read_file(path: str, tool_context: ToolContext) -> dict:
    """Read the contents of a specific file.

    Args:
        path: The file path to read (e.g. "src/App.tsx").

    Returns:
        A dict with "path" and "code" keys, or an error.
    """
    by_path = _files_by_path(tool_context)
    f = by_path.get(path)
    if f is not None:
        return {"path": f["path"], "code": f["code"]}
    return {"error": f"File not found: {path}"}


async def write_file(path: str, code: str, tool_context: ToolContext) -> dict:
    """Create or fully replace a file.

    Args:
        path: The file path (e.g. "src/App.tsx").
        code: The complete file contents.

    Returns:
        A dict with a "written" key containing the path.
    """
    by_path = dict(_files_by_path(tool_context))
    by_path[path] = {"path": path, "code": code}
    _save_files(tool_context, by_path)
    return {"written": path}


async def edit_file(
    path: str, old_code: str, new_code: str, tool_context: ToolContext
) -> dict:
    """Perform a partial edit on an existing file by replacing old_code with new_code.

    Args:
        path: The file path to edit.
        old_code: The exact code snippet to find and replace.
        new_code: The replacement code snippet.

    Returns:
        A dict with status information.
    """
    by_path = dict(_files_by_path(tool_context))

    if path not in by_path:
        return {"error": f"File not found: {path}"}

    file_entry = dict(by_path[path])
    count = file_entry["code"].count(old_code)
    if count == 0:
        return {"error": f"old_code not found in {path}"}
    if count > 1:
        return {"error": f"old_code matches {count} locations in {path} — provide a more specific snippet"}

    file_entry["code"] = file_entry["code"].replace(old_code, new_code, 1)
    by_path[path] = file_entry
    _save_files(tool_context, by_path)
    return {"edited": path}


async def delete_file(path: str, tool_context: ToolContext) -> dict:
    """Remove a file from the codebase.

    Args:
        path: The file path to delete.

    Returns:
        A dict with status information.
    """
    by_path = dict(_files_by_path(tool_context))

    if path not in by_path:
        return {"error": f"File not found: {path}"}

    del by_path[path]
    _save_files(tool_context, by_path)
    return {"deleted": path}
