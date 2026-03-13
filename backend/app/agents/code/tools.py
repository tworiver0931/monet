"""
File operation tools for the code agent.

These tools operate on tool_context.state["code_files"], which is a list of
dicts with keys: path, code.
"""

from __future__ import annotations

from google.adk.tools import ToolContext


async def list_files(tool_context: ToolContext) -> dict:
    """List all file paths in the current codebase.

    Returns:
        A dict with a "files" key containing the list of file paths.
    """
    files: list[dict] = tool_context.state.get("code_files", [])
    return {"files": [f["path"] for f in files]}


async def read_file(path: str, tool_context: ToolContext) -> dict:
    """Read the contents of a specific file.

    Args:
        path: The file path to read (e.g. "src/App.tsx").

    Returns:
        A dict with "path" and "code" keys, or an error.
    """
    files: list[dict] = tool_context.state.get("code_files", [])
    by_path: dict[str, dict] = {f["path"]: f for f in files}
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
    existing: list[dict] = tool_context.state.get("code_files", [])
    by_path: dict[str, dict] = {f["path"]: dict(f) for f in existing}

    by_path[path] = {
        "path": path,
        "code": code,
    }

    tool_context.state["code_files"] = list(by_path.values())
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
    existing: list[dict] = tool_context.state.get("code_files", [])
    by_path: dict[str, dict] = {f["path"]: dict(f) for f in existing}

    if path not in by_path:
        return {"error": f"File not found: {path}"}

    file_entry = by_path[path]
    count = file_entry["code"].count(old_code)
    if count == 0:
        return {"error": f"old_code not found in {path}"}
    if count > 1:
        return {"error": f"old_code matches {count} locations in {path} — provide a more specific snippet"}

    file_entry["code"] = file_entry["code"].replace(old_code, new_code, 1)
    tool_context.state["code_files"] = list(by_path.values())
    return {"edited": path}


async def delete_file(path: str, tool_context: ToolContext) -> dict:
    """Remove a file from the codebase.

    Args:
        path: The file path to delete.

    Returns:
        A dict with status information.
    """
    existing: list[dict] = tool_context.state.get("code_files", [])
    new_files = [f for f in existing if f["path"] != path]

    if len(new_files) == len(existing):
        return {"error": f"File not found: {path}"}

    tool_context.state["code_files"] = new_files
    return {"deleted": path}
