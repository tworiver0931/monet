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
MAX_CONTEXT_MEMORY_ENTRIES = 12
MAX_CONTEXT_CODE_RUNS = 4
MAX_STORED_CODE_RUNS = 8


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


class GenerateCodeRequest(BaseModel):
    """Structured request payload passed from the orchestrator."""

    approved_plan: str = Field(
        description="The approved implementation plan for this code run.",
    )
    latest_user_turn: str = Field(
        default="",
        description="The latest user message that triggered this approved plan.",
    )
    requested_changes: list[str] = Field(
        default_factory=list,
        description="Concrete changes to make during this run.",
    )
    referenced_images: list[str] = Field(
        default_factory=list,
        description="Uploaded image labels or references relevant to this request.",
    )
    follow_up_delta: str = Field(
        default="",
        description="How this request differs from the previously approved plan.",
    )


class ConversationMemoryEntry(BaseModel):
    """Normalized conversation-memory entry stored in live/session state."""

    kind: str = Field(description="Entry type such as user_turn or runtime_error.")
    text: str = Field(default="", description="Primary text content for the entry.")
    source: str = Field(default="", description="Origin such as text, speech, or assistant.")
    turn_id: int | None = Field(default=None, description="Associated user turn id when available.")
    meta: dict[str, object] = Field(
        default_factory=dict,
        description="Extra structured metadata associated with the entry.",
    )


class RecentCodeRun(BaseModel):
    """Compact durable summary of a previous code-agent run."""

    summary: str = Field(description="Natural-language summary of the completed run.")
    changed_paths: list[str] = Field(
        default_factory=list,
        description="Paths created, edited, or deleted during the run.",
    )
    approved_plan: str = Field(
        default="",
        description="Approved plan that led to the run.",
    )
    follow_up_delta: str = Field(
        default="",
        description="Follow-up delta associated with this run, if any.",
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


def _clean_text(value: object) -> str:
    """Normalize arbitrary values into a stripped string."""
    if isinstance(value, str):
        return value.strip()
    return ""


def _clean_string_list(values: object) -> list[str]:
    """Normalize arbitrary list-like values into stripped strings."""
    if not isinstance(values, list):
        return []
    cleaned: list[str] = []
    for value in values:
        text = _clean_text(value)
        if text:
            cleaned.append(text)
    return cleaned


def _infer_referenced_images(
    *,
    uploaded_images: list,
    request: GenerateCodeRequest,
) -> list[str]:
    """Infer referenced image labels from the current request text."""
    available_labels = [
        image["label"]
        for image in _normalize_uploaded_images(uploaded_images)
        if image.get("label")
    ]
    haystack_parts = [
        request.approved_plan,
        request.latest_user_turn,
        request.follow_up_delta,
        *request.requested_changes,
    ]
    haystack = " ".join(part.lower() for part in haystack_parts if part).strip()
    if not haystack:
        return []

    return [label for label in available_labels if label.lower() in haystack]


def _normalize_generate_code_request(
    *,
    approved_plan: str,
    requested_changes: list[str] | None = None,
    follow_up_delta: str = "",
    live: dict | None = None,
    kwargs: dict | None = None,
) -> GenerateCodeRequest:
    """Create a validated request model from tool-call arguments."""
    fallback_prompt = ""
    if isinstance(kwargs, dict):
        fallback_prompt = _clean_text(kwargs.get("prompt"))
    latest_user_turn = ""
    if isinstance(live, dict):
        latest_user_turn = _clean_text(live.get("latest_user_turn_text"))

    request = GenerateCodeRequest(
        approved_plan=_clean_text(approved_plan) or fallback_prompt,
        latest_user_turn=latest_user_turn,
        requested_changes=_clean_string_list(requested_changes),
        referenced_images=[],
        follow_up_delta=_clean_text(follow_up_delta),
    )
    if not request.approved_plan:
        raise ValueError("generate_code requires a non-empty approved_plan.")

    request.referenced_images = _infer_referenced_images(
        uploaded_images=live.get("uploaded_images", []) if isinstance(live, dict) else [],
        request=request,
    )
    return request


def _normalize_conversation_memory(
    entries: object,
) -> list[ConversationMemoryEntry]:
    """Normalize session conversation-memory entries."""
    if not isinstance(entries, list):
        return []

    normalized: list[ConversationMemoryEntry] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        try:
            normalized.append(ConversationMemoryEntry.model_validate(entry))
        except Exception:
            logger.debug("Skipping invalid conversation memory entry", exc_info=True)
    return normalized


def _normalize_recent_code_runs(entries: object) -> list[RecentCodeRun]:
    """Normalize durable recent code-run summaries."""
    if not isinstance(entries, list):
        return []

    normalized: list[RecentCodeRun] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        try:
            normalized.append(RecentCodeRun.model_validate(entry))
        except Exception:
            logger.debug("Skipping invalid recent code run entry", exc_info=True)
    return normalized


def _format_list_section(title: str, items: list[str]) -> str:
    """Render a markdown section from a list of strings."""
    if not items:
        return ""
    body = "\n".join(f"- {item}" for item in items)
    return f"## {title}\n\n{body}"


def _format_memory_entry(entry: ConversationMemoryEntry) -> str:
    """Render a compact human-readable conversation-memory line."""
    source_prefix = f"[{entry.source}] " if entry.source else ""
    text = entry.text or "(no text)"
    return f"- {entry.kind}: {source_prefix}{text}"


def _format_recent_code_run(entry: RecentCodeRun) -> str:
    """Render a compact recent-code-run summary line."""
    changed_paths = ", ".join(f"`{path}`" for path in entry.changed_paths[:6])
    suffix = f" Changed files: {changed_paths}." if changed_paths else ""
    return f"- {entry.summary}{suffix}"


def _build_visual_context_section(
    *,
    request: GenerateCodeRequest,
    latest_frame: bytes | None,
) -> str:
    """Describe non-code context available to the model for this run."""
    lines: list[str] = []
    if latest_frame:
        lines.append("- A screenshot of the current app preview is attached.")
    if request.referenced_images:
        labels = ", ".join(f"`{label}`" for label in request.referenced_images)
        lines.append(f"- The request explicitly references uploaded images: {labels}.")
    if not lines:
        lines.append("- No screenshot was attached for this turn.")
    return "## Visual Context\n\n" + "\n".join(lines)


def _build_generate_code_prompt_text(
    *,
    request: GenerateCodeRequest,
    conversation_memory: list[dict],
    recent_code_runs: list[dict],
    latest_frame: bytes | None,
) -> str:
    """Build the shared per-call context payload for both execution modes."""
    sections = ["## Approved Plan\n\n" + request.approved_plan]

    if request.latest_user_turn:
        sections.append("## Latest User Turn\n\n" + request.latest_user_turn)

    if request.follow_up_delta:
        sections.append("## Follow-Up Delta\n\n" + request.follow_up_delta)

    requested_changes_section = _format_list_section(
        "Requested Changes",
        request.requested_changes,
    )
    if requested_changes_section:
        sections.append(requested_changes_section)

    recent_memory = _normalize_conversation_memory(conversation_memory)[-MAX_CONTEXT_MEMORY_ENTRIES:]
    if recent_memory:
        memory_body = "\n".join(_format_memory_entry(entry) for entry in recent_memory)
        sections.append("## Recent Conversation Memory\n\n" + memory_body)

    previous_runs = _normalize_recent_code_runs(recent_code_runs)[-MAX_CONTEXT_CODE_RUNS:]
    if previous_runs:
        run_body = "\n".join(_format_recent_code_run(entry) for entry in previous_runs)
        sections.append("## Recent Code Changes\n\n" + run_body)

    sections.append(
        _build_visual_context_section(
            request=request,
            latest_frame=latest_frame,
        )
    )
    return "\n\n".join(sections)


def _compute_changed_paths(
    previous_files: list[dict],
    updated_files: list[dict],
) -> list[str]:
    """Return created, modified, or deleted paths between two file lists."""
    previous_by_path = {
        path: code
        for path, code in (
            (entry.get("path"), entry.get("code"))
            for entry in previous_files
            if isinstance(entry, dict)
        )
        if isinstance(path, str)
    }
    updated_by_path = {
        path: code
        for path, code in (
            (entry.get("path"), entry.get("code"))
            for entry in updated_files
            if isinstance(entry, dict)
        )
        if isinstance(path, str)
    }

    changed: list[str] = []
    all_paths = sorted(set(previous_by_path) | set(updated_by_path))
    for path in all_paths:
        if previous_by_path.get(path) != updated_by_path.get(path):
            changed.append(path)
    return changed


def _append_live_conversation_entry(
    live: dict,
    *,
    kind: str,
    text: str,
    source: str,
    turn_id: int | None = None,
    meta: dict[str, object] | None = None,
) -> None:
    """Append a bounded normalized memory entry to live/session state."""
    entries = live.setdefault("conversation_memory", [])
    if not isinstance(entries, list):
        entries = []
        live["conversation_memory"] = entries

    payload = ConversationMemoryEntry(
        kind=kind,
        text=text,
        source=source,
        turn_id=turn_id,
        meta=meta or {},
    ).model_dump()
    entries.append(payload)
    if len(entries) > 100:
        del entries[:-100]

    session_state = live.get("session_state")
    if isinstance(session_state, dict):
        session_state["conversation_memory"] = entries


def _record_recent_code_run(
    live: dict,
    *,
    request: GenerateCodeRequest,
    summary: str,
    previous_files: list[dict],
    updated_files: list[dict],
) -> None:
    """Persist a compact summary of the latest code-agent run."""
    changed_paths = _compute_changed_paths(previous_files, updated_files)
    entry = RecentCodeRun(
        summary=summary,
        changed_paths=changed_paths,
        approved_plan=request.approved_plan,
        follow_up_delta=request.follow_up_delta,
    ).model_dump()

    runs = live.setdefault("recent_code_runs", [])
    if not isinstance(runs, list):
        runs = []
        live["recent_code_runs"] = runs
    runs.append(entry)
    if len(runs) > MAX_STORED_CODE_RUNS:
        del runs[:-MAX_STORED_CODE_RUNS]

    session_state = live.get("session_state")
    if isinstance(session_state, dict):
        session_state["recent_code_runs"] = runs

    _append_live_conversation_entry(
        live,
        kind="code_run",
        text=summary,
        source="generate_code",
        meta={"changed_paths": changed_paths},
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
    approved_plan: str,
    tool_context: ToolContext,
    requested_changes: list[str] | None = None,
    follow_up_delta: str = "",
    **kwargs,
) -> AsyncGenerator[str, None]:
    """Generates or refines a React application.

    Args:
        approved_plan: the approved implementation plan for this run.

    Returns:
        A brief summary what was done
    """
    fast_mode = CODE_FAST_MODE
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
        request = _normalize_generate_code_request(
            approved_plan=approved_plan,
            requested_changes=requested_changes,
            follow_up_delta=follow_up_delta,
            live=live,
            kwargs=kwargs,
        )
        code_files = live.get("code_files", [])
        uploaded_images = live.get("uploaded_images", [])
        conversation_memory = live.get("conversation_memory", [])
        recent_code_runs = live.get("recent_code_runs", [])
        latest_frame = live.get("latest_frame")
        latest_mime = live.get("latest_frame_mime", "image/jpeg")
        previous_files = list(code_files)

        _append_live_conversation_entry(
            live,
            kind="approved_plan",
            text=request.approved_plan,
            source="orchestrator",
            turn_id=turn_id,
            meta={
                "requested_changes": request.requested_changes,
                "referenced_images": request.referenced_images,
                "follow_up_delta": request.follow_up_delta,
            },
        )

        if fast_mode:
            # ----- Fast mode: single LLM call, structured JSON output -----
            prompt_text = _build_generate_code_prompt_text(
                request=request,
                conversation_memory=conversation_memory,
                recent_code_runs=recent_code_runs,
                latest_frame=latest_frame,
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
            session_state = live.get("session_state")
            if isinstance(session_state, dict):
                session_state["code_files"] = updated_files

            final_summary = summary or "Code generation complete."
            _record_recent_code_run(
                live,
                request=request,
                summary=final_summary,
                previous_files=previous_files,
                updated_files=updated_files,
            )
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
                },
            )
        else:
            session.state["code_files"] = code_files
            session.state["uploaded_images"] = uploaded_images

        prompt_text = _build_generate_code_prompt_text(
            request=request,
            conversation_memory=conversation_memory,
            recent_code_runs=recent_code_runs,
            latest_frame=latest_frame,
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
                    session_state = live.get("session_state")
                    if isinstance(session_state, dict):
                        session_state["code_files"] = new_files
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
        _record_recent_code_run(
            live,
            request=request,
            summary=final_summary,
            previous_files=previous_files,
            updated_files=live.get("code_files", previous_files),
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
