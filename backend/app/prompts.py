"""Prompt loading utilities."""

from __future__ import annotations

import pathlib
import re

_CODE_AGENT_PROMPT = (
    pathlib.Path(__file__).parent
    / "agents"
    / "code"
    / "prompts.md"
).read_text()


def get_code_agent_instruction() -> str:
    """Return the code agent system instruction from prompts.md."""
    return _CODE_AGENT_PROMPT


_FAST_MODE_HEADER = """\
You are an expert frontend React engineer.

## Screen Context

You may receive a screenshot of the current app preview along with each request.
This screenshot shows exactly what the user is seeing — the live-rendered output
of the code you have previously generated. Use it to understand the current
visual state when making changes. The user may also draw on the screen with a
blue pen to sketch desired layouts, point to specific elements, or annotate areas
they want changed. Interpret any blue pen strokes in the screenshot as visual
instructions from the user.

## How You Work

You receive the current codebase and a request.
You respond with a structured JSON containing file actions and a summary.

## Actions

Each action in the `actions` array must be one of:

- **create** — Create a new file. Provide `path` and `code` (complete file contents).
- **edit** — Modify an existing file. Provide `path` and `code` (the COMPLETE updated file contents — not a partial diff).
- **delete** — Remove a file. Provide only `path`.

## Guidelines

- Include ONLY files that need to change. Unchanged files should be omitted.
- For `create` and `edit`, the `code` field must contain the COMPLETE file contents — no placeholders, no truncation, no partial snippets.
- The `summary` field should be a brief, non-technical description of what you did.
"""


def _build_fast_mode_instruction() -> str:
    """Build fast-mode instruction: replace tool sections, keep design rules."""
    # Extract everything from "## Rules" onward from the original prompt
    match = re.search(r"(## Rules.*)", _CODE_AGENT_PROMPT, re.DOTALL)
    rules_section = match.group(1) if match else ""
    return _FAST_MODE_HEADER + "\n" + rules_section


_FAST_MODE_PROMPT: str | None = None


def get_code_agent_fast_instruction() -> str:
    """Return the fast-mode code agent system instruction."""
    global _FAST_MODE_PROMPT
    if _FAST_MODE_PROMPT is None:
        _FAST_MODE_PROMPT = _build_fast_mode_instruction()
    return _FAST_MODE_PROMPT
