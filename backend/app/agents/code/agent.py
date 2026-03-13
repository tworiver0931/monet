"""
Code agent: an LlmAgent wrapped in a streaming FunctionTool.

The main orchestrator calls ``generate_code`` (a streaming tool).  Internally
it either:
  - **Fast mode**: makes a single LLM call with structured JSON output
    (create/edit/delete file actions).  No tools are used.
  - **Agent mode**: runs a full ADK agent with file-operation tools and a React
    coding skill, using a persistent session so conversation history
    accumulates across calls.
"""

from __future__ import annotations

import json
import logging
from typing import Literal

from pydantic import BaseModel, Field

from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools import FunctionTool, ToolContext
from google.genai import types
from google import genai

from ...config import CODE_FAST_MODE, CODE_GEN_FAST_MODEL, CODE_GEN_LOCATION, CODE_GEN_MODEL, GOOGLE_CLOUD_PROJECT
from ...prompts import get_code_agent_fast_instruction, get_code_agent_instruction
from ...utils import apply_file_actions, format_files_as_code_blocks, lang_from_path
from .tools import delete_file, edit_file, list_files, read_file, write_file

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Structured output schema for fast mode
# ---------------------------------------------------------------------------


class FileAction(BaseModel):
    """A single file operation."""

    action: Literal["create", "edit", "delete"] = Field(
        description=(
            "The operation type: "
            "'create' for new files, "
            "'edit' for modifying existing files (provide complete contents), "
            "'delete' to remove a file."
        ),
    )
    path: str = Field(
        description="File path relative to project root (e.g. 'src/App.tsx').",
    )
    code: str = Field(
        default="",
        description=(
            "Complete file contents. Required for 'create' and 'edit' actions. "
            "Leave empty for 'delete'."
        ),
    )


class CodeResponse(BaseModel):
    """Structured response from the code agent in fast mode."""

    actions: list[FileAction] = Field(
        description="List of file operations to perform.",
    )
    summary: str = Field(
        description=(
            "Brief, non-technical summary of what was done. "
            "Do NOT include code details."
        ),
    )


# ---------------------------------------------------------------------------
# Internal LlmAgent (used in agent mode only)
# ---------------------------------------------------------------------------


def _code_agent_instruction(context) -> str:
    """InstructionProvider: builds instruction dynamically from state."""
    base = get_code_agent_instruction()
    base = _append_uploaded_images(base, context.state.get("uploaded_images", []))
    return base


def _append_uploaded_images(base: str, images: list) -> str:
    """Append uploaded image references to the instruction if available."""
    if not images:
        return base
    lines = []
    for img in images:
        if isinstance(img, dict):
            lines.append(f"- \"{img['name']}\": {img['url']}")
        else:
            lines.append(f"- {img}")
    return base + (
        "\n\n## Uploaded Images\n\n"
        "The user has uploaded the following images. "
        "Use these URLs directly in <img> tags or CSS background-image "
        "when the user wants to include them:\n"
        + "\n".join(lines)
        + "\n\n"
        "You may also receive a screenshot of the current app preview. "
        "User-uploaded images are tagged with labels like 'Image 1', "
        "'Image 2' in the screenshot for identification."
    )


_code_agent_tools = [
    FunctionTool(func=list_files),
    FunctionTool(func=read_file),
    FunctionTool(func=write_file),
    FunctionTool(func=edit_file),
    FunctionTool(func=delete_file),
]

def _make_code_gen_model():
    """Create a Gemini LLM instance pointing at CODE_GEN_LOCATION (global)."""
    from google.adk.models.google_llm import Gemini

    model = Gemini(model=CODE_GEN_MODEL)
    # Force the underlying genai client to use CODE_GEN_LOCATION (e.g. "global")
    # instead of the default GOOGLE_CLOUD_LOCATION env var.
    model.__dict__["api_client"] = genai.Client(
        vertexai=True, project=GOOGLE_CLOUD_PROJECT, location=CODE_GEN_LOCATION,
    )
    return model


_code_agent = Agent(
    name="_code_agent_inner",
    model=_make_code_gen_model(),
    instruction=_code_agent_instruction,
    description="Internal code generation agent.",
    tools=_code_agent_tools,
    output_key="code_agent_last_response",
)

# ---------------------------------------------------------------------------
# Persistent session service and runner for the code agent
# ---------------------------------------------------------------------------

_code_session_service = InMemorySessionService()
_code_runner = Runner(
    app_name="code_agent",
    agent=_code_agent,
    session_service=_code_session_service,
)

# ---------------------------------------------------------------------------
# Module-level live state registry (bypasses ADK state proxy)
# ---------------------------------------------------------------------------

# Maps session_id -> dict of live references (transcript, validate_fn, etc.)
# ADK's tool_context.state may snapshot/copy values, losing live list
# references and callables.  This registry holds the real objects.
_live_state_registry: dict[str, dict] = {}


def register_live_state(session_id: str, state: dict) -> None:
    """Register live state for a session (called from main.py)."""
    _live_state_registry[session_id] = state


def unregister_live_state(session_id: str) -> None:
    """Remove live state when session ends."""
    _live_state_registry.pop(session_id, None)
    # Clean up fast-mode conversation history for this session
    _fast_mode_history.pop(f"code-{session_id}", None)


# ---------------------------------------------------------------------------
# Fast mode: conversation history per session
# ---------------------------------------------------------------------------

# Maps code_session_id -> list of Content (user/model turns).
# Bounded to MAX_FAST_MODE_SESSIONS to prevent unbounded memory growth.
MAX_FAST_MODE_SESSIONS = 100
_fast_mode_history: dict[str, list[types.Content]] = {}

# ---------------------------------------------------------------------------
# Streaming FunctionTool wrapper (called by the Main Agent)
# ---------------------------------------------------------------------------


# Guard against duplicate concurrent calls from the orchestrator.
# Maps orchestrator session_id -> True while generate_code is running.
_active_generate: dict[str, bool] = {}


def _build_user_message_with_files(
    prompt_text: str,
    code_files: list[dict],
    latest_frame: bytes | None = None,
    latest_mime: str = "image/jpeg",
) -> types.Content:
    """Build a user Content that includes current files and the prompt."""
    parts_text = ""

    if code_files:
        parts_text += "## Current Codebase\n\n"
        parts_text += format_files_as_code_blocks(code_files)
        parts_text += "\n\n"

    parts_text += "## Request\n\n" + prompt_text

    msg_parts: list[types.Part] = [types.Part(text=parts_text)]
    if latest_frame:
        msg_parts.append(
            types.Part(
                inline_data=types.Blob(
                    mime_type=latest_mime,
                    data=latest_frame,
                )
            )
        )

    return types.Content(role="user", parts=msg_parts)


# ---------------------------------------------------------------------------
# Fast mode implementation
# ---------------------------------------------------------------------------

_genai_client: genai.Client | None = None


def _get_genai_client() -> genai.Client:
    global _genai_client
    if _genai_client is None:
        _genai_client = genai.Client(
            vertexai=True, project=GOOGLE_CLOUD_PROJECT, location=CODE_GEN_LOCATION,
        )
    return _genai_client


async def _fast_generate(
    prompt_text: str,
    code_files: list[dict],
    uploaded_images: list,
    latest_frame: bytes | None,
    latest_mime: str,
    session_id: str,
) -> tuple[list[dict], str]:
    """Single LLM call with structured JSON output.

    Returns (updated_files, summary).
    """
    client = _get_genai_client()

    # Build system instruction
    instruction = get_code_agent_fast_instruction()
    instruction = _append_uploaded_images(instruction, uploaded_images)

    # Build user message with current files
    user_msg = _build_user_message_with_files(
        prompt_text, code_files, latest_frame, latest_mime,
    )

    # Get conversation history
    history = _fast_mode_history.get(session_id, [])

    response = await client.aio.models.generate_content(
        model=CODE_GEN_FAST_MODEL,
        contents=history + [user_msg],
        config=types.GenerateContentConfig(
            system_instruction=instruction,
            thinking_config=types.ThinkingConfig(thinking_level="medium"),
            response_mime_type="application/json",
            response_json_schema=CodeResponse.model_json_schema(),
        ),
    )

    response_text = response.text or "{}"
    logger.info("Fast mode raw response length: %d chars", len(response_text))

    # Parse structured response
    try:
        code_response = CodeResponse.model_validate_json(response_text)
    except Exception:
        logger.exception("Failed to parse structured response, attempting raw JSON")
        try:
            raw = json.loads(response_text)
            code_response = CodeResponse(
                actions=[FileAction(**a) for a in raw.get("actions", [])],
                summary=raw.get("summary", "Code generation complete."),
            )
        except Exception:
            logger.exception("Failed to parse raw JSON response")
            return code_files, "Code generation failed — could not parse response."

    # Convert actions to the format expected by apply_file_actions
    action_dicts = []
    for fa in code_response.actions:
        d: dict = {"action": fa.action, "path": fa.path}
        if fa.action in ("create", "edit"):
            d["code"] = fa.code
            d["language"] = lang_from_path(fa.path)
        action_dicts.append(d)

    updated_files = apply_file_actions(code_files, action_dicts)

    # Update conversation history (store as plain text for model context)
    model_msg = types.Content(
        role="model",
        parts=[types.Part(text=response_text)],
    )
    history = history + [user_msg, model_msg]
    # Keep history bounded (last 10 turns = 20 messages)
    if len(history) > 20:
        history = history[-20:]
    _fast_mode_history[session_id] = history

    # Evict oldest sessions if over capacity
    if len(_fast_mode_history) > MAX_FAST_MODE_SESSIONS:
        excess = len(_fast_mode_history) - MAX_FAST_MODE_SESSIONS
        for key in list(_fast_mode_history)[:excess]:
            _fast_mode_history.pop(key, None)

    return updated_files, code_response.summary


# ---------------------------------------------------------------------------
# Main entry point (normal FunctionTool)
# ---------------------------------------------------------------------------


async def generate_code(
    prompt: str, tool_context: ToolContext, **kwargs
):
    """Generates or refines a React application.

    Args:
        prompt: description of what to build or change.

    Returns:
        A brief summary what was done
    """
    fast_mode = CODE_FAST_MODE
    model = CODE_GEN_FAST_MODEL if fast_mode else CODE_GEN_MODEL
    logger.info("Code agent using %s model (fast_mode=%s)", model, fast_mode)

    # Prevent duplicate concurrent calls from the orchestrator
    orchestrator_session_id = tool_context.session.id
    if _active_generate.get(orchestrator_session_id):
        logger.info("generate_code already running for session %s, skipping duplicate call", orchestrator_session_id)
        return (
            "Code generation is already in progress. Wait for it to finish before "
            "calling generate_code again."
        )
    _active_generate[orchestrator_session_id] = True

    try:
        # Derive a code-agent session ID from the main session
        code_session_id = f"code-{orchestrator_session_id}"
        user_id = tool_context.user_id

        # Read live state from module-level registry
        live = _live_state_registry.get(orchestrator_session_id, {})
        notify_code_agent_started = live.get("notify_code_agent_started")

        code_files = live.get("code_files", [])
        uploaded_images = live.get("uploaded_images", [])
        transcript = live.get("transcript", [])
        latest_frame = live.get("latest_frame")
        latest_mime = live.get("latest_frame_mime", "image/jpeg")

        if notify_code_agent_started:
            await notify_code_agent_started()

        if fast_mode:
            # ----- Fast mode: single LLM call, structured JSON output -----

            # Track transcript offset in live state
            offset = live.get("_fast_transcript_offset", 0)
            new_entries = list(transcript)[offset:]
            live["_fast_transcript_offset"] = len(transcript)

            if new_entries:
                prompt_text = (
                    "The following conversation took place between the user and the "
                    "voice assistant since your last invocation:\n\n"
                    + "\n".join(new_entries)
                    + "\n\n"
                    "Based on the above conversation, the voice assistant is now "
                    "requesting the following:\n\n"
                    + prompt
                )
            else:
                prompt_text = (
                    "The voice assistant is requesting the following:\n\n" + prompt
                )

            updated_files, summary = await _fast_generate(
                prompt_text,
                code_files,
                uploaded_images,
                latest_frame,
                latest_mime,
                session_id=code_session_id,
            )

            # Log generated code
            for f in updated_files:
                logger.info(
                    "Fast mode generated file [%s]:\n%s",
                    f.get("path", "unknown"),
                    f.get("code", ""),
                )

            # Update state
            tool_context.state["code_files"] = updated_files
            live["code_files"] = updated_files

            return summary or "Code generation complete."

        else:
            # ----- Agent mode: full ADK agent with tools -----

            session = await _code_session_service.get_session(
                app_name="code_agent",
                user_id=user_id,
                session_id=code_session_id,
            )
            if session is None:
                session = await _code_session_service.create_session(
                    app_name="code_agent",
                    user_id=user_id,
                    session_id=code_session_id,
                    state={
                        "code_files": code_files,
                        "uploaded_images": uploaded_images,
                        "_transcript_offset": 0,
                    },
                )
            else:
                session.state["code_files"] = code_files
                session.state["uploaded_images"] = uploaded_images

            # Build the user message with new conversation context prepended.
            offset = session.state.get("_transcript_offset", 0)
            new_entries = list(transcript)[offset:]
            session.state["_transcript_offset"] = len(transcript)
            logger.info(
                "Transcript debug: session=%s, total=%d, offset=%d, new_entries=%d",
                orchestrator_session_id, len(transcript), offset, len(new_entries),
            )

            if new_entries:
                prompt_text = (
                    "The following conversation took place between the user and the "
                    "voice assistant since your last invocation:\n\n"
                    + "\n".join(new_entries)
                    + "\n\n"
                    "Based on the above conversation, the voice assistant is now "
                    "requesting the following:\n\n"
                    + prompt
                )
            else:
                prompt_text = (
                    "The voice assistant is requesting the following:\n\n" + prompt
                )

            msg_parts = [types.Part(text=prompt_text)]
            if latest_frame:
                msg_parts.append(
                    types.Part(
                        inline_data=types.Blob(
                            mime_type=latest_mime,
                            data=latest_frame,
                        )
                    )
                )
            current_msg = types.Content(role="user", parts=msg_parts)
            summary = ""

            async for event in _code_runner.run_async(
                user_id=user_id,
                session_id=code_session_id,
                new_message=current_msg,
            ):
                if event.actions and event.actions.state_delta:
                    new_files = event.actions.state_delta.get("code_files")
                    if new_files is not None:
                        tool_context.state["code_files"] = new_files
                        live["code_files"] = new_files

                if event.is_final_response() and event.content and event.content.parts:
                    summary = "".join(p.text for p in event.content.parts if p.text)

            return summary or "Code generation complete."
    finally:
        _active_generate.pop(orchestrator_session_id, None)
