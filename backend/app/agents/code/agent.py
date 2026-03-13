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

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass
from typing import AsyncGenerator, Awaitable, Callable, Literal

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

ToolEventEmitter = Callable[[dict[str, object]], Awaitable[None]]


@dataclass(slots=True)
class ToolJob:
    job_id: str
    tool_name: str

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
# references and callables. This registry holds the real objects.
_live_state_registry: dict[str, dict] = {}
_active_tool_jobs: dict[str, dict[str, ToolJob]] = {}
_user_turn_ids: dict[str, int] = {}
_tool_call_turn_ids: dict[str, dict[str, int]] = {}
_tool_job_lock = asyncio.Lock()


def register_live_state(session_id: str, state: dict) -> None:
    """Register live state for a session (called from main.py)."""
    state.setdefault("latest_user_turn_id", 0)
    state.setdefault("latest_user_turn_source", None)
    state.setdefault("latest_user_turn_text", "")
    _live_state_registry[session_id] = state


def unregister_live_state(session_id: str) -> None:
    """Remove live state when session ends."""
    _live_state_registry.pop(session_id, None)
    _active_tool_jobs.pop(session_id, None)
    _user_turn_ids.pop(session_id, None)
    _tool_call_turn_ids.pop(session_id, None)
    # Clean up fast-mode conversation history for this session
    _fast_mode_history.pop(f"code-{session_id}", None)


def get_live_state(session_id: str) -> dict:
    """Return the live state dict for a session."""
    return _live_state_registry.get(session_id, {})


async def record_user_turn(
    session_id: str,
    *,
    source: str,
    text: str | None = None,
) -> int:
    """Advance the real-user turn counter for a live session."""
    async with _tool_job_lock:
        turn_id = _user_turn_ids.get(session_id, 0) + 1
        _user_turn_ids[session_id] = turn_id

    live = get_live_state(session_id)
    if live:
        live["latest_user_turn_id"] = turn_id
        live["latest_user_turn_source"] = source
        live["latest_user_turn_text"] = text or ""
    return turn_id


async def claim_tool_call_turn(
    session_id: str,
    tool_name: str,
) -> tuple[bool, int, str]:
    """Allow at most one invocation of a given tool per real user turn."""
    async with _tool_job_lock:
        turn_id = _user_turn_ids.get(session_id, 0)
        if turn_id <= 0:
            return False, turn_id, "no_user_turn"

        claimed_turns = _tool_call_turn_ids.setdefault(session_id, {})
        if claimed_turns.get(tool_name) == turn_id:
            return False, turn_id, "already_used"

        claimed_turns[tool_name] = turn_id
        return True, turn_id, "claimed"


async def begin_tool_job(
    session_id: str,
    tool_name: str,
    job_id: str,
) -> ToolJob | None:
    """Mark a tool job as the current active job for this tool."""
    async with _tool_job_lock:
        session_jobs = _active_tool_jobs.setdefault(session_id, {})
        previous = session_jobs.get(tool_name)
        session_jobs[tool_name] = ToolJob(job_id=job_id, tool_name=tool_name)
        return previous


def is_current_tool_job(session_id: str, tool_name: str, job_id: str) -> bool:
    """Check whether a job is still the current active job for this tool."""
    session_jobs = _active_tool_jobs.get(session_id)
    if session_jobs is None:
        return False
    job = session_jobs.get(tool_name)
    return job is not None and job.job_id == job_id


async def clear_tool_job(session_id: str, tool_name: str, job_id: str) -> None:
    """Clear the active tool job if it still matches for this tool."""
    async with _tool_job_lock:
        session_jobs = _active_tool_jobs.get(session_id)
        if session_jobs is None:
            return
        job = session_jobs.get(tool_name)
        if job is not None and job.job_id == job_id:
            session_jobs.pop(tool_name, None)
            if not session_jobs:
                _active_tool_jobs.pop(session_id, None)


def get_tool_job_id(tool_context: ToolContext, tool_name: str) -> str:
    """Derive a stable job id for a tool invocation."""
    return tool_context.function_call_id or f"{tool_name}-{uuid.uuid4().hex}"


async def emit_client_event(session_id: str, payload: dict[str, object]) -> None:
    """Emit a custom JSON event to the active websocket client."""
    live = get_live_state(session_id)
    emitter = live.get("emit_client_event")
    if not callable(emitter):
        return
    try:
        await emitter(payload)
    except Exception:
        logger.debug("Failed to emit client event for session %s", session_id, exc_info=True)


async def emit_tool_event(
    session_id: str,
    *,
    event_type: str,
    tool_name: str,
    job_id: str,
    stage: str | None = None,
    message: str | None = None,
    **extra: object,
) -> None:
    """Emit a standardized tool lifecycle event to the browser."""
    payload: dict[str, object] = {
        "type": event_type,
        "toolName": tool_name,
        "jobId": job_id,
    }
    if stage:
        payload["stage"] = stage
    if message:
        payload["message"] = message
    payload.update(extra)
    await emit_client_event(session_id, payload)


async def _cancel_background_task(task: asyncio.Task) -> None:
    """Cancel a background task and swallow the expected cancellation error."""
    if task.done():
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    except Exception:
        logger.debug("Background task cancellation raised an error", exc_info=True)


async def wait_for_task_heartbeats(
    *,
    task: asyncio.Task,
    session_id: str,
    job_id: str,
    tool_name: str,
    stage: str,
    client_message: str,
    interval_seconds: float = 4.0,
) -> None:
    """Emit periodic heartbeat updates while a background task is pending."""
    while not task.done():
        if not is_current_tool_job(session_id, tool_name, job_id):
            await _cancel_background_task(task)
            return
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=interval_seconds)
        except asyncio.TimeoutError:
            if not is_current_tool_job(session_id, tool_name, job_id):
                await _cancel_background_task(task)
                return
            await emit_tool_event(
                session_id,
                event_type="tool_progress",
                tool_name=tool_name,
                job_id=job_id,
                stage=stage,
                message=client_message,
            )


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
) -> AsyncGenerator[str, None]:
    """Generates or refines a React application.

    Args:
        prompt: description of what to build or change.

    Returns:
        A brief summary what was done
    """
    del kwargs
    fast_mode = CODE_FAST_MODE
    model = CODE_GEN_FAST_MODEL if fast_mode else CODE_GEN_MODEL
    tool_name = "generate_code"
    orchestrator_session_id = tool_context.session.id
    job_id = get_tool_job_id(tool_context, tool_name)
    logger.info("Code agent using %s model (fast_mode=%s)", model, fast_mode)
    turn_claimed, turn_id, turn_reason = await claim_tool_call_turn(
        orchestrator_session_id,
        tool_name,
    )
    if not turn_claimed:
        live = get_live_state(orchestrator_session_id)
        logger.info(
            "Suppressing %s for session %s without a new user turn "
            "(reason=%s, turn_id=%s, source=%s)",
            tool_name,
            orchestrator_session_id,
            turn_reason,
            turn_id,
            live.get("latest_user_turn_source"),
        )
        return

    job_cleared = False
    generate_task: asyncio.Task | None = None
    previous_job = await begin_tool_job(orchestrator_session_id, tool_name, job_id)
    if previous_job is not None and previous_job.job_id != job_id:
        await emit_tool_event(
            orchestrator_session_id,
            event_type="tool_cancelled",
            tool_name=previous_job.tool_name,
            job_id=previous_job.job_id,
            stage="cancelled",
            message="Superseded by a newer tool request.",
            reason="superseded",
        )

    await emit_tool_event(
        orchestrator_session_id,
        event_type="tool_started",
        tool_name=tool_name,
        job_id=job_id,
        stage="started",
        message="Working on the requested app changes.",
    )

    try:
        # Derive a code-agent session ID from the main session
        code_session_id = f"code-{orchestrator_session_id}"
        user_id = tool_context.user_id

        # Read live state from module-level registry
        live = get_live_state(orchestrator_session_id)
        code_files = live.get("code_files", [])
        uploaded_images = live.get("uploaded_images", [])
        transcript = live.get("transcript", [])
        latest_frame = live.get("latest_frame")
        latest_mime = live.get("latest_frame_mime", "image/jpeg")

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

            generate_task = asyncio.create_task(
                _fast_generate(
                    prompt_text,
                    code_files,
                    uploaded_images,
                    latest_frame,
                    latest_mime,
                    session_id=code_session_id,
                )
            )
            await wait_for_task_heartbeats(
                task=generate_task,
                session_id=orchestrator_session_id,
                job_id=job_id,
                tool_name=tool_name,
                stage="generating",
                client_message="Still generating the code update.",
            )

            if not is_current_tool_job(orchestrator_session_id, tool_name, job_id):
                return

            updated_files, summary = await generate_task

            # Log generated code
            for f in updated_files:
                logger.info(
                    "Fast mode generated file [%s]:\n%s",
                    f.get("path", "unknown"),
                    f.get("code", ""),
                )

            if not is_current_tool_job(orchestrator_session_id, tool_name, job_id):
                return

            await emit_tool_event(
                orchestrator_session_id,
                event_type="tool_progress",
                tool_name=tool_name,
                job_id=job_id,
                stage="applying",
                message="Applying the generated code to the preview.",
            )

            tool_context.state["code_files"] = updated_files
            live["code_files"] = updated_files

            final_summary = summary or "Code generation complete."
            await emit_tool_event(
                orchestrator_session_id,
                event_type="tool_result",
                tool_name=tool_name,
                job_id=job_id,
                stage="code_ready",
                message="Updated code files are ready.",
                summary=final_summary,
            )
            await emit_client_event(
                orchestrator_session_id,
                {
                    "type": "code",
                    "toolName": tool_name,
                    "jobId": job_id,
                    "files": updated_files,
                },
            )
            await emit_tool_event(
                orchestrator_session_id,
                event_type="tool_finished",
                tool_name=tool_name,
                job_id=job_id,
                stage="finished",
                message=final_summary,
                summary=final_summary,
            )
            await clear_tool_job(orchestrator_session_id, tool_name, job_id)
            job_cleared = True
            yield f"[ToolComplete] generate_code: {final_summary}"
            return

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
            orchestrator_session_id,
            len(transcript),
            offset,
            len(new_entries),
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

        await emit_tool_event(
            orchestrator_session_id,
            event_type="tool_progress",
            tool_name=tool_name,
            job_id=job_id,
            stage="generating",
            message="The code agent is updating the app.",
        )

        async for event in _code_runner.run_async(
            user_id=user_id,
            session_id=code_session_id,
            new_message=current_msg,
        ):
            if not is_current_tool_job(orchestrator_session_id, tool_name, job_id):
                return

            if event.actions and event.actions.state_delta:
                new_files = event.actions.state_delta.get("code_files")
                if new_files is not None:
                    tool_context.state["code_files"] = new_files
                    live["code_files"] = new_files
                    await emit_tool_event(
                        orchestrator_session_id,
                        event_type="tool_result",
                        tool_name=tool_name,
                        job_id=job_id,
                        stage="code_ready",
                        message="Updated code files are ready.",
                    )
                    await emit_client_event(
                        orchestrator_session_id,
                        {
                            "type": "code",
                            "toolName": tool_name,
                            "jobId": job_id,
                            "files": new_files,
                        },
                    )

            if event.is_final_response() and event.content and event.content.parts:
                summary = "".join(p.text for p in event.content.parts if p.text)

        if not is_current_tool_job(orchestrator_session_id, tool_name, job_id):
            return

        final_summary = summary or "Code generation complete."
        await emit_tool_event(
            orchestrator_session_id,
            event_type="tool_finished",
            tool_name=tool_name,
            job_id=job_id,
            stage="finished",
            message=final_summary,
            summary=final_summary,
        )
        await clear_tool_job(orchestrator_session_id, tool_name, job_id)
        job_cleared = True
        yield f"[ToolComplete] generate_code: {final_summary}"
    except asyncio.CancelledError:
        if generate_task is not None:
            try:
                await asyncio.shield(_cancel_background_task(generate_task))
            except Exception:
                logger.debug("Failed to cancel fast code task", exc_info=True)
        if is_current_tool_job(orchestrator_session_id, tool_name, job_id):
            try:
                await asyncio.shield(
                    emit_tool_event(
                        orchestrator_session_id,
                        event_type="tool_cancelled",
                        tool_name=tool_name,
                        job_id=job_id,
                        stage="cancelled",
                        message="Stopped the code task.",
                        reason="cancelled",
                    )
                )
            except Exception:
                logger.debug("Failed to emit code cancellation event", exc_info=True)
        raise
    except Exception as exc:
        logger.exception(
            "Code generation failed for session %s", orchestrator_session_id
        )
        if not is_current_tool_job(orchestrator_session_id, tool_name, job_id):
            return
        await emit_tool_event(
            orchestrator_session_id,
            event_type="tool_failed",
            tool_name=tool_name,
            job_id=job_id,
            stage="failed",
            message=str(exc),
            reason="error",
        )
        await clear_tool_job(orchestrator_session_id, tool_name, job_id)
        job_cleared = True
        yield "[ToolError] generate_code: Code generation failed before completion."
    finally:
        if generate_task is not None and not generate_task.done():
            await _cancel_background_task(generate_task)
        if not job_cleared:
            await clear_tool_job(orchestrator_session_id, tool_name, job_id)
