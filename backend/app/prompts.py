"""Prompt loading utilities."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

_CODE_AGENT_PROMPT_PATH = Path(__file__).parent / "agents" / "code" / "prompts.md"
_CODE_AGENT_PROMPT = _CODE_AGENT_PROMPT_PATH.read_text(encoding="utf-8")
_HOW_YOU_WORK_PLACEHOLDER = "{{HOW_YOU_WORK_SECTION}}"

_REQUIRED_CODE_AGENT_SECTIONS = {
    "## Screen Context",
    "## Request Context",
    "## Rules",
}

_STANDARD_MODE_HOW_YOU_WORK = """\
## How You Work

You can manage files in a React codebase with these tools:

- `list_files`
- `read_file`
- `write_file`
- `edit_file`
- `delete_file`

Workflow:

1. Use `edit_file` for surgical updates and `write_file` for new files or full rewrites.
2. Treat the approved plan and requested changes as the highest-priority request context.
3. Preserve working parts of the app unless the request implies a redesign.
4. After making changes, respond with a brief natural-language summary. Do not mention code details in that summary.
"""


def get_code_agent_instruction() -> str:
    """Return the code agent system instruction from prompts.md."""
    return _build_code_agent_instruction(_STANDARD_MODE_HOW_YOU_WORK)


_FAST_MODE_HOW_YOU_WORK = """\
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
- Follow the approved plan and requested changes first; use recent conversation memory only to resolve follow-up intent.
- For `create` and `edit`, the `code` field must contain the COMPLETE file contents — no placeholders, no truncation, no partial snippets.
- The `summary` field should be a brief, non-technical description of what you did.
"""


def _validate_code_agent_prompt(prompt: str) -> None:
    """Fail fast if the canonical prompt loses required sections."""
    section_names = {line.strip() for line in prompt.splitlines() if line.startswith("## ")}
    missing = sorted(_REQUIRED_CODE_AGENT_SECTIONS - section_names)
    if missing:
        missing_text = ", ".join(missing)
        raise ValueError(
            "Code agent prompt is missing required sections in "
            f"{_CODE_AGENT_PROMPT_PATH}: {missing_text}"
        )
    placeholder_count = prompt.count(_HOW_YOU_WORK_PLACEHOLDER)
    if placeholder_count != 1:
        raise ValueError(
            "Code agent prompt must contain exactly one "
            f"{_HOW_YOU_WORK_PLACEHOLDER} placeholder in {_CODE_AGENT_PROMPT_PATH}, "
            f"found {placeholder_count}."
        )


def _build_code_agent_instruction(how_you_work_section: str) -> str:
    """Render a code-agent instruction by injecting a mode-specific section."""
    _validate_code_agent_prompt(_CODE_AGENT_PROMPT)
    if not how_you_work_section.strip().startswith("## How You Work"):
        raise ValueError("Mode-specific prompt section must start with '## How You Work'.")
    return _CODE_AGENT_PROMPT.replace(
        _HOW_YOU_WORK_PLACEHOLDER,
        how_you_work_section.strip(),
    )


def _build_fast_mode_instruction() -> str:
    """Build fast-mode instruction from the canonical prompt template."""
    return _build_code_agent_instruction(_FAST_MODE_HOW_YOU_WORK)


@lru_cache(maxsize=1)
def get_code_agent_fast_instruction() -> str:
    """Return the fast-mode code agent system instruction."""
    return _build_fast_mode_instruction()
