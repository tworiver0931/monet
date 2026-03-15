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
import time
import uuid
import itertools
from collections import OrderedDict
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

WAIT_FOR_TURN_SECONDS = 1.5
POLL_INTERVAL_SECONDS = 0.05
HEARTBEAT_INTERVAL_SECONDS = 4.0
FAST_GENERATE_TIMEOUT_SECONDS = 120
MAX_HISTORY_MESSAGES = 20


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
    block = _format_uploaded_images_block(images)
    if not block:
        return base
    return base + (
        "\n\n"
        + block
        + "\n\n"
        "When the request mentions an uploaded image label such as `Image 1`, "
        "use the matching public URL from the uploaded-images list directly "
        "instead of inferring from filenames or screenshot order."
    )


def _normalize_uploaded_image_record(img: object, index: int) -> dict[str, str] | None:
    """Normalize uploaded image metadata for prompt assembly."""
    if isinstance(img, dict):
        url = img.get("url", "")
        if not isinstance(url, str) or not url:
            return None
        name = img.get("name", "uploaded_image")
        if not isinstance(name, str) or not name:
            name = "uploaded_image"
        label = img.get("label", f"Image {index}")
        if not isinstance(label, str) or not label:
            label = f"Image {index}"
        image_id = img.get("id", "")
        if not isinstance(image_id, str):
            image_id = ""
        source = img.get("source", "user_upload")
        if not isinstance(source, str) or not source:
            source = "user_upload"
        return {
            "id": image_id,
            "label": label,
            "name": name,
            "url": url,
            "source": source,
        }
    if isinstance(img, str) and img:
        return {
            "id": "",
            "label": f"Image {index}",
            "name": f"uploaded-image-{index}",
            "url": img,
            "source": "user_upload",
        }
    return None


def _normalize_uploaded_images(images: list) -> list[dict[str, str]]:
    normalized: list[dict[str, str]] = []
    for index, img in enumerate(images, start=1):
        record = _normalize_uploaded_image_record(img, index)
        if record is not None:
            normalized.append(record)
    return normalized


def _format_uploaded_images_block(images: list) -> str:
    normalized = _normalize_uploaded_images(images)
    if not normalized:
        return ""

    lines = [
        "## Uploaded Images",
        "",
        "Use these public URLs directly in `<img>` tags or CSS background-image.",
        "When a request mentions `Image N`, use the matching label below.",
    ]
    for image in normalized:
        source_suffix = ""
        if image["source"] != "user_upload":
            source_suffix = f" [source={image['source']}]"
        lines.append(
            f'- `{image["label"]}` -> "{image["name"]}" -> {image["url"]}{source_suffix}'
        )
    return "\n".join(lines)


def _build_generate_code_prompt_text(
    *,
    prompt: str,
    transcript_entries: list[str],
    latest_user_turn_text: str,
    uploaded_images: list,
) -> str:
    """Build the per-call user prompt with explicit request priority."""
    sections = []
    uploaded_images_block = _format_uploaded_images_block(uploaded_images)
    if uploaded_images_block:
        sections.append(uploaded_images_block)

    sections.append("## Latest Approved Request\n\n" + prompt)

    latest_turn = latest_user_turn_text.strip()
    if latest_turn:
        sections.append("## Latest User Turn\n\n" + latest_turn)

    recent_entries = transcript_entries[-12:]
    if recent_entries:
        sections.append("## Recent Conversation Context\n\n" + "\n".join(recent_entries))

    return "\n\n".join(sections)


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
_session_locks: dict[str, asyncio.Lock] = {}


def _get_session_lock(session_id: str) -> asyncio.Lock:
    """Return a per-session lock, creating one if needed."""
    lock = _session_locks.get(session_id)
    if lock is None:
        lock = asyncio.Lock()
        _session_locks[session_id] = lock
    return lock

# Track last-access time for TTL-based eviction of orphaned entries
_session_last_access: dict[str, float] = {}
_SESSION_TTL_SECONDS = 3600  # 1 hour


def _touch_session(session_id: str) -> None:
    """Update the last-access timestamp for a session."""
    _session_last_access[session_id] = time.monotonic()


def _evict_stale_sessions() -> None:
    """Remove entries from all registries for sessions older than TTL."""
    now = time.monotonic()
    stale = [
        sid for sid, ts in _session_last_access.items()
        if now - ts > _SESSION_TTL_SECONDS
    ]
    for sid in stale:
        _live_state_registry.pop(sid, None)
        _active_tool_jobs.pop(sid, None)
        _user_turn_ids.pop(sid, None)
        _tool_call_turn_ids.pop(sid, None)
        _session_locks.pop(sid, None)
        _fast_mode_history.pop(f"code-{sid}", None)
        _session_last_access.pop(sid, None)
    if stale:
        logger.info("Evicted %d stale sessions from registries", len(stale))


_eviction_task: asyncio.Task | None = None

def start_periodic_eviction() -> None:
    """Start a background task that evicts stale sessions every 5 minutes."""
    global _eviction_task
    if _eviction_task is not None:
        return

    async def _periodic_eviction():
        while True:
            await asyncio.sleep(300)  # 5 minutes
            try:
                _evict_stale_sessions()
            except Exception:
                logger.debug("Periodic session eviction failed", exc_info=True)

    _eviction_task = asyncio.create_task(_periodic_eviction())


def register_live_state(session_id: str, state: dict) -> None:
    """Register live state for a session (called from main.py)."""
    state.setdefault("latest_user_turn_id", 0)
    state.setdefault("latest_user_turn_source", None)
    state.setdefault("latest_user_turn_text", "")
    _live_state_registry[session_id] = state
    _touch_session(session_id)
    start_periodic_eviction()


def unregister_live_state(session_id: str) -> None:
    """Remove live state when session ends."""
    _live_state_registry.pop(session_id, None)
    _active_tool_jobs.pop(session_id, None)
    _user_turn_ids.pop(session_id, None)
    _tool_call_turn_ids.pop(session_id, None)
    _session_last_access.pop(session_id, None)
    _session_locks.pop(session_id, None)
    # Clean up fast-mode conversation history for this session
    _fast_mode_history.pop(f"code-{session_id}", None)


def get_live_state(session_id: str) -> dict:
    """Return the live state dict for a session."""
    state = _live_state_registry.get(session_id, {})
    if state:
        _touch_session(session_id)
    return state


async def record_user_turn(
    session_id: str,
    *,
    source: str,
    text: str | None = None,
) -> int:
    """Advance the real-user turn counter for a live session."""
    async with _get_session_lock(session_id):
        turn_id = _user_turn_ids.get(session_id, 0) + 1
        _user_turn_ids[session_id] = turn_id

        live = get_live_state(session_id)
        if live:
            live["latest_user_turn_id"] = turn_id
            live["latest_user_turn_source"] = source
            live["latest_user_turn_text"] = text or ""
    return turn_id


def _claim_tool_call_turn_locked(
    session_id: str,
    tool_name: str,
) -> tuple[bool, int, str]:
    """Claim the current user turn while holding ``_tool_job_lock``."""
    turn_id = _user_turn_ids.get(session_id, 0)
    if turn_id <= 0:
        return False, turn_id, "no_user_turn"

    claimed_turns = _tool_call_turn_ids.setdefault(session_id, {})
    if claimed_turns.get(tool_name) == turn_id:
        return False, turn_id, "already_used"

    claimed_turns[tool_name] = turn_id
    return True, turn_id, "claimed"


async def claim_tool_call_turn(
    session_id: str,
    tool_name: str,
    *,
    wait_for_turn_seconds: float = WAIT_FOR_TURN_SECONDS,
    poll_interval_seconds: float = POLL_INTERVAL_SECONDS,
) -> tuple[bool, int, str]:
    """Allow at most one invocation of a given tool per real user turn."""
    session_lock = _get_session_lock(session_id)
    async with session_lock:
        claimed, turn_id, reason = _claim_tool_call_turn_locked(
            session_id,
            tool_name,
        )

    if claimed or reason != "no_user_turn" or wait_for_turn_seconds <= 0:
        return claimed, turn_id, reason

    loop = asyncio.get_running_loop()
    deadline = loop.time() + wait_for_turn_seconds
    while loop.time() < deadline:
        await asyncio.sleep(poll_interval_seconds)
        async with session_lock:
            claimed, turn_id, reason = _claim_tool_call_turn_locked(
                session_id,
                tool_name,
            )
        if claimed or reason != "no_user_turn":
            return claimed, turn_id, reason

    return False, turn_id, reason


def build_tool_turn_gate_error(
    tool_name: str,
    reason: str,
) -> str:
    """Return a tool result that helps the orchestrator recover gracefully."""
    if reason == "already_used":
        return (
            f"[ToolError] {tool_name}: This tool was already used for the current "
            "user turn. Do not call it again until the user makes a new request. "
            "If the work is already running or already finished, briefly tell the "
            "user that instead."
        )

    if reason == "no_user_turn":
        return (
            f"[ToolError] {tool_name}: There is no completed real user turn "
            "available yet. Do not call any tools right now. If the session just "
            "started, say exactly: Hello! What would you like to build today? "
            "Otherwise keep listening and wait until the user's request or "
            "approval is fully received before trying again."
        )

    return (
        f"[ToolError] {tool_name}: This tool call could not be used for the "
        "current conversation state. Continue the conversation without calling "
        "tools until the user makes a new approved request."
    )


def build_tool_already_running_error(
    tool_name: str,
    *,
    active_job_id: str | None = None,
) -> str:
    """Return a tool result for rejected same-tool re-entry while running."""
    job_suffix = f" Active job id: {active_job_id}." if active_job_id else ""
    return (
        f"[ToolError] {tool_name}: This tool is already running for the current "
        "session. Do not call it again right now. Wait until the active run "
        "finishes, fails, or is cancelled before calling the same tool again."
        + job_suffix
    )


async def get_active_tool_job(session_id: str, tool_name: str) -> ToolJob | None:
    """Return the currently active job for a tool, if any."""
    async with _get_session_lock(session_id):
        session_jobs = _active_tool_jobs.get(session_id)
        if session_jobs is None:
            return None
        return session_jobs.get(tool_name)


async def begin_tool_job(
    session_id: str,
    tool_name: str,
    job_id: str,
) -> ToolJob | None:
    """Mark a tool job as the current active job for this tool."""
    async with _get_session_lock(session_id):
        session_jobs = _active_tool_jobs.setdefault(session_id, {})
        previous = session_jobs.get(tool_name)
        session_jobs[tool_name] = ToolJob(job_id=job_id, tool_name=tool_name)
        return previous


def is_current_tool_job(session_id: str, tool_name: str, job_id: str) -> bool:
    """Check whether a job is still the current active job for this tool.

    Lock-free: reads of dict values are atomic in CPython's asyncio
    single-threaded event loop.  The job_id string comparison is safe
    because ToolJob instances are replaced atomically (never mutated).
    """
    session_jobs = _active_tool_jobs.get(session_id)
    if session_jobs is None:
        return False
    job = session_jobs.get(tool_name)
    return job is not None and job.job_id == job_id


async def clear_tool_job(session_id: str, tool_name: str, job_id: str) -> None:
    """Clear the active tool job if it still matches for this tool."""
    async with _get_session_lock(session_id):
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
        logger.warning("Failed to emit client event for session %s", session_id, exc_info=True)


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
    interval_seconds: float = HEARTBEAT_INTERVAL_SECONDS,
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
# Bounded to MAX_FAST_MODE_SESSIONS with LRU eviction to prevent unbounded
# memory growth while keeping the most recently active sessions.
MAX_FAST_MODE_SESSIONS = 100
_fast_mode_history: OrderedDict[str, list[types.Content]] = OrderedDict()

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

    parts_text += prompt_text

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

    # Get conversation history (move to end for LRU tracking)
    history = _fast_mode_history.get(session_id, [])
    if session_id in _fast_mode_history:
        _fast_mode_history.move_to_end(session_id)

    max_retries = 2
    last_error = None
    for attempt in range(max_retries + 1):
        try:
            async with asyncio.timeout(FAST_GENERATE_TIMEOUT_SECONDS):
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
            break
        except (asyncio.TimeoutError, Exception) as exc:
            last_error = exc
            if attempt < max_retries:
                logger.warning(
                    "Transient code generation error (attempt %d/%d): %s",
                    attempt + 1, max_retries + 1, exc,
                )
                await asyncio.sleep(0.5 * (attempt + 1))
            else:
                raise

    response_text = response.text or "{}"

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

    # Update conversation history — store only the request text and model
    # summary (not full file contents or structured JSON) to keep memory
    # bounded.  Current files are always injected fresh at call time.
    history_user_msg = types.Content(
        role="user",
        parts=[types.Part(text=prompt_text)],
    )
    history_model_msg = types.Content(
        role="model",
        parts=[types.Part(text=code_response.summary)],
    )
    history = history + [history_user_msg, history_model_msg]
    # Keep history bounded (last 10 turns = 20 messages)
    if len(history) > MAX_HISTORY_MESSAGES:
        history = history[-MAX_HISTORY_MESSAGES:]
    _fast_mode_history[session_id] = history

    # Evict least-recently-used sessions if over capacity
    while len(_fast_mode_history) > MAX_FAST_MODE_SESSIONS:
        _fast_mode_history.popitem(last=False)

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
        yield build_tool_turn_gate_error(tool_name, turn_reason)
        return

    job_cleared = False
    generate_task: asyncio.Task | None = None
    active_job = await get_active_tool_job(orchestrator_session_id, tool_name)
    if active_job is not None and active_job.job_id != job_id:
        await emit_tool_event(
            orchestrator_session_id,
            event_type="tool_failed",
            tool_name=tool_name,
            job_id=job_id,
            stage="rejected",
            message=(
                f"{tool_name} is already running. Wait for the active run "
                "to finish before starting another one."
            ),
            reason="already_running",
            activeJobId=active_job.job_id,
        )
        yield build_tool_already_running_error(
            tool_name,
            active_job_id=active_job.job_id,
        )
        return

    await begin_tool_job(orchestrator_session_id, tool_name, job_id)

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
        latest_user_turn_text = live.get("latest_user_turn_text", "")
        if not isinstance(latest_user_turn_text, str):
            latest_user_turn_text = ""

        if fast_mode:
            # ----- Fast mode: single LLM call, structured JSON output -----

            # Track transcript offset in live state
            offset = live.get("_fast_transcript_offset", 0)
            new_entries = list(itertools.islice(transcript, offset, None))
            live["_fast_transcript_offset"] = len(transcript)

            prompt_text = _build_generate_code_prompt_text(
                prompt=prompt,
                transcript_entries=new_entries,
                latest_user_turn_text=latest_user_turn_text,
                uploaded_images=uploaded_images,
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
                yield "[ToolComplete] generate_code: Superseded by a newer request."
                return

            updated_files, summary = await generate_task

            if not is_current_tool_job(orchestrator_session_id, tool_name, job_id):
                yield "[ToolComplete] generate_code: Superseded by a newer request."
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
        new_entries = list(itertools.islice(transcript, offset, None))
        session.state["_transcript_offset"] = len(transcript)
        logger.info(
            "Transcript debug: session=%s, total=%d, offset=%d, new_entries=%d",
            orchestrator_session_id,
            len(transcript),
            offset,
            len(new_entries),
        )

        prompt_text = _build_generate_code_prompt_text(
            prompt=prompt,
            transcript_entries=new_entries,
            latest_user_turn_text=latest_user_turn_text,
            uploaded_images=uploaded_images,
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
                yield "[ToolComplete] generate_code: Superseded by a newer request."
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
            yield "[ToolComplete] generate_code: Superseded by a newer request."
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
            yield "[ToolComplete] generate_code: Superseded by a newer request."
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
