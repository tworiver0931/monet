import asyncio
import base64
import collections
import json
import logging
import secrets
import time
import uuid

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from google.adk.agents import LiveRequestQueue
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import errors as genai_errors, types

from .config import (
    FRONTEND_ORIGINS,
    MAX_UPLOAD_SIZE,
    SESSION_HARD_LIMIT,
    SESSION_IDLE_TIMEOUT,
)
from .schemas import DeployRequest, DeployResponse
from .session import init_db, close_pool, create_deployment, get_deployment_by_slug
from .agents import agent
from .agents.code.agent import (
    _live_state_registry,
    record_user_turn,
    register_live_state,
    unregister_live_state,
)
from .storage import upload_public_blob

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

MAX_FRAME_BYTES = 5 * 1024 * 1024  # 5 MB limit for stored frames
LIVE_SESSION_TIMEOUT = 600  # 10 min max per live session connection
MAX_CONVERSATION_MEMORY = 100
MAX_RECENT_CODE_RUNS = 8

WS_CLOSE_IDLE_TIMEOUT = 4000
WS_CLOSE_HARD_LIMIT = 4001

_session_connections_lock = asyncio.Lock()
_active_session_connections: dict[str, tuple[str, WebSocket]] = {}
_APPROVAL_PHRASES = (
    "yes",
    "yeah",
    "yep",
    "sure",
    "go ahead",
    "do it",
    "sounds good",
    "okay",
    "ok",
    "make it",
)


def _normalize_uploaded_image_record(
    payload: object,
    *,
    default_name: str = "uploaded_image",
    index_hint: int | None = None,
    source: str = "user_upload",
) -> dict[str, str] | None:
    """Return a normalized uploaded-image record or ``None``."""
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
        next_index = index_hint or 1
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


def _clean_text(value: object) -> str:
    """Normalize arbitrary values into a stripped string."""
    if isinstance(value, str):
        return value.strip()
    return ""


def _normalize_meta(value: object) -> dict[str, object]:
    """Return a shallow normalized metadata dict."""
    if not isinstance(value, dict):
        return {}
    normalized: dict[str, object] = {}
    for key, item in value.items():
        if isinstance(key, str):
            normalized[key] = item
    return normalized


def _normalize_memory_entry(entry: object) -> dict[str, object] | None:
    """Normalize a conversation-memory entry."""
    if not isinstance(entry, dict):
        return None

    kind = _clean_text(entry.get("kind"))
    if not kind:
        return None

    normalized: dict[str, object] = {
        "kind": kind,
        "text": _clean_text(entry.get("text")),
        "source": _clean_text(entry.get("source")),
        "meta": _normalize_meta(entry.get("meta")),
    }
    turn_id = entry.get("turn_id")
    if isinstance(turn_id, int):
        normalized["turn_id"] = turn_id
    return normalized


def _normalize_conversation_memory(entries: object) -> list[dict[str, object]]:
    """Normalize stored conversation memory."""
    if not isinstance(entries, list):
        return []
    normalized = [
        entry
        for entry in (_normalize_memory_entry(item) for item in entries)
        if entry is not None
    ]
    return normalized[-MAX_CONVERSATION_MEMORY:]


def _normalize_recent_code_runs(entries: object) -> list[dict[str, object]]:
    """Normalize stored recent code-run summaries."""
    if not isinstance(entries, list):
        return []

    normalized: list[dict[str, object]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        summary = _clean_text(entry.get("summary"))
        if not summary:
            continue
        changed_paths = entry.get("changed_paths")
        if not isinstance(changed_paths, list):
            changed_paths = []
        normalized.append(
            {
                "summary": summary,
                "changed_paths": [path for path in changed_paths if isinstance(path, str)],
                "approved_plan": _clean_text(entry.get("approved_plan")),
                "follow_up_delta": _clean_text(entry.get("follow_up_delta")),
            }
        )
    return normalized[-MAX_RECENT_CODE_RUNS:]


def _append_memory_entry(
    entries: list[dict[str, object]],
    *,
    kind: str,
    text: str,
    source: str,
    turn_id: int | None = None,
    meta: dict[str, object] | None = None,
) -> None:
    """Append a bounded memory entry in-place."""
    entry: dict[str, object] = {
        "kind": kind,
        "text": text.strip(),
        "source": source,
        "meta": meta or {},
    }
    if turn_id is not None:
        entry["turn_id"] = turn_id
    entries.append(entry)
    if len(entries) > MAX_CONVERSATION_MEMORY:
        del entries[:-MAX_CONVERSATION_MEMORY]


def _looks_like_explicit_approval(text: str) -> bool:
    """Heuristic check for short explicit approval replies."""
    normalized = text.strip().lower()
    if not normalized:
        return False
    return any(phrase in normalized for phrase in _APPROVAL_PHRASES)


def _latest_user_memory_entry(
    entries: list[dict[str, object]],
) -> dict[str, object] | None:
    """Return the most recent stored user-turn memory entry."""
    for entry in reversed(entries):
        if entry.get("kind") == "user_turn":
            return entry
    return None


def _is_session_owner(session_id: str, connection_id: str) -> bool:
    entry = _active_session_connections.get(session_id)
    return entry is not None and entry[0] == connection_id


async def _claim_session_connection(
    session_id: str,
    connection_id: str,
    websocket: WebSocket,
) -> None:
    previous_websocket: WebSocket | None = None

    async with _session_connections_lock:
        previous = _active_session_connections.get(session_id)
        if previous and previous[0] != connection_id and previous[1] is not websocket:
            previous_websocket = previous[1]
        _active_session_connections[session_id] = (connection_id, websocket)

    if previous_websocket is not None:
        logger.info("Closing superseded WebSocket for session %s", session_id)
        try:
            await previous_websocket.close(
                code=1012,
                reason="Superseded by a newer connection",
            )
        except RuntimeError:
            pass
        except Exception as exc:
            logger.warning(
                "Failed to close previous WebSocket for session %s: %s",
                session_id,
                exc,
            )


async def _release_session_connection(session_id: str, connection_id: str) -> None:
    async with _session_connections_lock:
        entry = _active_session_connections.get(session_id)
        if entry is not None and entry[0] == connection_id:
            _active_session_connections.pop(session_id, None)

app = FastAPI(title="Monet Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=FRONTEND_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class _CodeInterceptQueue(LiveRequestQueue):
    """LiveRequestQueue wrapper that can emit custom client events."""

    def __init__(self, websocket: WebSocket, ws_lock: asyncio.Lock):
        super().__init__()
        self._websocket = websocket
        self._ws_lock = ws_lock
        self._transcript: collections.deque[str] = collections.deque(maxlen=100)

    async def emit_client_event(self, payload: dict[str, object]) -> None:
        try:
            async with self._ws_lock:
                await self._websocket.send_text(
                    json.dumps(payload)
                )
        except RuntimeError:
            logger.debug("Skipping client event on closed websocket")
        except Exception as exc:
            logger.debug("Failed to send client event: %s", exc)


async def timeout_task(
    websocket: WebSocket,
    ws_lock: asyncio.Lock,
    last_activity: list[float],
    session_start: float,
    idle_timeout: int,
    hard_limit: int,
) -> None:
    try:
        while True:
            await asyncio.sleep(5)
            now = time.monotonic()

            if now - session_start >= hard_limit:
                logger.info("Session hard limit reached")
                async with ws_lock:
                    await websocket.send_text(
                        json.dumps({"type": "session_timeout", "reason": "hard_limit"})
                    )
                await websocket.close(code=WS_CLOSE_HARD_LIMIT)
                return

            if now - last_activity[0] >= idle_timeout:
                logger.info("Session idle timeout reached")
                async with ws_lock:
                    await websocket.send_text(
                        json.dumps({"type": "session_timeout", "reason": "idle"})
                    )
                await websocket.close(code=WS_CLOSE_IDLE_TIMEOUT)
                return
    except (WebSocketDisconnect, RuntimeError):
        pass
    except asyncio.CancelledError:
        pass
    except Exception as e:
        logger.error("Timeout task error: %s", e)


APP_NAME = "monet"
session_service = InMemorySessionService()
runner = Runner(
    app_name=APP_NAME,
    agent=agent,
    session_service=session_service,
)


async def upstream_task(
    websocket: WebSocket,
    live_request_queue: LiveRequestQueue,
    first_input_event: asyncio.Event,
    user_id: str,
    session_id: str,
    connection_id: str,
    last_activity: list[float] | None = None,
) -> None:
    try:
        while True:
            if not _is_session_owner(session_id, connection_id):
                break

            data = await websocket.receive()

            if last_activity is not None:
                last_activity[0] = time.monotonic()

            if not _is_session_owner(session_id, connection_id):
                break

            if data.get("type") == "websocket.disconnect":
                break

            if "bytes" in data and data["bytes"]:
                audio_data = data["bytes"]
                audio_blob = types.Blob(
                    mime_type="audio/pcm;rate=16000",
                    data=audio_data,
                )
                first_input_event.set()
                live_request_queue.send_realtime(audio_blob)

            elif "text" in data and data["text"]:
                try:
                    msg = json.loads(data["text"])
                except json.JSONDecodeError:
                    continue

                msg_type = msg.get("type", "")

                if msg_type == "runtime_error":
                    error_msg = msg.get("error", "Unknown runtime error")
                    logger.info(
                        "Runtime error from frontend (session %s): %s",
                        session_id,
                        error_msg[:200],
                    )
                    live = _live_state_registry.get(session_id)
                    if live is not None:
                        memory = live.get("conversation_memory", [])
                        if isinstance(memory, list):
                            _append_memory_entry(
                                memory,
                                kind="runtime_error",
                                text=error_msg,
                                source="preview",
                            )
                    content = types.Content(
                        role="user",
                        parts=[types.Part(text=(
                            "The generated code produced a runtime error in the "
                            "browser preview:\n\n"
                            f"```\n{error_msg}\n```\n\n"
                            "Briefly explain the problem to the user in plain "
                            "language. Do not call generate_code unless the "
                            "user asks you to fix it or explicitly approves a fix."
                        ))],
                    )
                    live_request_queue.send_content(content)

                elif msg_type == "text":
                    text_content = msg.get("text", "")
                    if text_content:
                        turn_id = await record_user_turn(
                            session_id,
                            source="text",
                            text=text_content,
                        )
                        live = _live_state_registry.get(session_id)
                        if live is not None:
                            memory = live.get("conversation_memory", [])
                            if isinstance(memory, list):
                                _append_memory_entry(
                                    memory,
                                    kind="user_turn",
                                    text=text_content,
                                    source="text",
                                    turn_id=turn_id,
                                )
                                if _looks_like_explicit_approval(text_content):
                                    _append_memory_entry(
                                        memory,
                                        kind="approval",
                                        text=text_content,
                                        source="text",
                                        turn_id=turn_id,
                                    )
                        content = types.Content(
                            role="user",
                            parts=[types.Part(text=text_content)],
                        )
                        first_input_event.set()
                        live_request_queue.send_content(content)

                elif msg_type == "image":
                    image_data = base64.b64decode(msg.get("data", ""))
                    mime_type = msg.get("mimeType", "image/jpeg")
                    # Store latest frame for code agent access
                    live = _live_state_registry.get(session_id)
                    if live is not None:
                        if len(image_data) <= MAX_FRAME_BYTES:
                            live["latest_frame"] = image_data
                            live["latest_frame_mime"] = mime_type
                        else:
                            logger.warning("Dropping oversized frame (%d bytes) for session %s", len(image_data), session_id)
                    image_blob = types.Blob(
                        mime_type=mime_type,
                        data=image_data,
                    )
                    first_input_event.set()
                    live_request_queue.send_realtime(image_blob)

                elif msg_type == "image_generation_frame":
                    frame_data = msg.get("data")
                    live = _live_state_registry.get(session_id)
                    if isinstance(frame_data, str) and frame_data:
                        image_data = base64.b64decode(frame_data)
                        mime_type = msg.get("mimeType", "image/png")
                        if live is not None:
                            if len(image_data) <= MAX_FRAME_BYTES:
                                live["latest_image_generation_frame"] = image_data
                                live["latest_image_generation_frame_mime"] = mime_type
                            else:
                                logger.warning("Dropping oversized generation frame (%d bytes)", len(image_data))
                    else:
                        if live is not None:
                            live["latest_image_generation_frame"] = None
                            live["latest_image_generation_frame_mime"] = "image/png"

                elif msg_type == "image_upload":
                    image_payload = msg.get("image")
                    if not isinstance(image_payload, dict):
                        image_payload = {
                            "url": msg.get("url", ""),
                            "name": msg.get("name", "uploaded_image"),
                            "source": "user_upload",
                        }
                    live = _live_state_registry.get(session_id)
                    if live is not None:
                        images = live.get("uploaded_images", [])
                        image = _normalize_uploaded_image_record(
                            image_payload,
                            index_hint=len(images) + 1,
                            source="user_upload",
                        )
                        if image is None:
                            continue
                        images.append(image)
                        live["uploaded_images"] = images
                        memory = live.get("conversation_memory", [])
                        if isinstance(memory, list):
                            _append_memory_entry(
                                memory,
                                kind="uploaded_image",
                                text=f'{image["label"]}: {image["name"]}',
                                source="user_upload",
                                meta={"label": image["label"], "url": image["url"]},
                            )
                        session = await session_service.get_session(
                            app_name=APP_NAME,
                            user_id=user_id,
                            session_id=session_id,
                        )
                        if session is not None:
                            session.state["uploaded_images"] = images
                        logger.info(
                            "Tracked uploaded image: %s (%s) -> %s",
                            image["label"],
                            image["name"],
                            image["url"],
                        )

    except WebSocketDisconnect:
        logger.info("Client disconnected (upstream)")
    except asyncio.CancelledError:
        pass
    except Exception as e:
        logger.error("Upstream error: %s", e)


async def downstream_task(
    websocket: WebSocket,
    adk_runner: Runner,
    user_id: str,
    session_id: str,
    connection_id: str,
    live_request_queue: LiveRequestQueue,
    first_input_event: asyncio.Event,
    run_config: RunConfig,
    ws_lock: asyncio.Lock,
) -> None:
    try:
        # Avoid opening a Live API session until we have actual user input.
        await first_input_event.wait()

        if not _is_session_owner(session_id, connection_id):
            return

        retryable_codes = {1008, 1011}
        max_retries = 2
        attempt = 0
        speech_turn_open = False

        while True:
            if not _is_session_owner(session_id, connection_id):
                return

            try:
                async with asyncio.timeout(LIVE_SESSION_TIMEOUT):
                    async for event in adk_runner.run_live(
                        user_id=user_id,
                        session_id=session_id,
                        live_request_queue=live_request_queue,
                        run_config=run_config,
                    ):
                        if not _is_session_owner(session_id, connection_id):
                            return

                        # --- Event-level error handling ---
                        if event.error_code:
                            logger.error(
                                "Event error: %s - %s",
                                event.error_code,
                                event.error_message,
                            )
                            terminal_errors = {
                                "SAFETY",
                                "PROHIBITED_CONTENT",
                                "MAX_TOKENS",
                            }
                            error_payload = json.dumps({
                                "type": "error",
                                "errorCode": event.error_code,
                                "message": event.error_message or str(event.error_code),
                            })
                            async with ws_lock:
                                await websocket.send_text(error_payload)
                            if event.error_code in terminal_errors:
                                return
                            continue

                        # --- Send audio as binary frames ---
                        has_audio = False
                        audio_parts: list = []
                        if event.content and event.content.parts:
                            for p in event.content.parts:
                                if p.inline_data:
                                    has_audio = True
                                    audio_parts.append(p)

                        if has_audio:
                            # Build lightweight metadata dict manually to
                            # avoid the expensive model_dump_json on the
                            # high-frequency audio path.
                            meta: dict = {}
                            if getattr(event, "turn_complete", None):
                                meta["turnComplete"] = True
                            if getattr(event, "interrupted", None):
                                meta["interrupted"] = True
                            if getattr(event, "partial", None) is not None:
                                meta["partial"] = event.partial
                            it = getattr(event, "input_transcription", None)
                            if it and getattr(it, "text", None):
                                meta["inputTranscription"] = {"text": it.text}
                            ot = getattr(event, "output_transcription", None)
                            if ot and getattr(ot, "text", None):
                                meta["outputTranscription"] = {"text": ot.text}
                            # Include non-audio text parts
                            text_parts = []
                            if event.content and event.content.parts:
                                for p in event.content.parts:
                                    if p.text:
                                        text_parts.append({"text": p.text})
                            if text_parts:
                                meta["content"] = {"parts": text_parts}
                            metadata = json.dumps(meta)
                            async with ws_lock:
                                for part in audio_parts:
                                    await websocket.send_bytes(
                                        part.inline_data.data
                                    )
                                await websocket.send_text(metadata)
                        else:
                            event_json = event.model_dump_json(
                                exclude_none=True, by_alias=True
                            )
                            async with ws_lock:
                                await websocket.send_text(event_json)

                        # Accumulate conversation transcript from audio
                        # transcriptions (not model thinking text).
                        transcript = live_request_queue._transcript
                        input_transcription = getattr(event, "input_transcription", None)
                        input_text = getattr(input_transcription, "text", "") or ""
                        is_partial = getattr(event, "partial", True)
                        if input_text:
                            if not speech_turn_open:
                                turn_id = await record_user_turn(
                                    session_id,
                                    source="speech",
                                    text=input_text,
                                )
                                live = _live_state_registry.get(session_id)
                                if live is not None:
                                    live["_open_speech_turn_id"] = turn_id
                                speech_turn_open = True
                            elif not is_partial:
                                live = _live_state_registry.get(session_id)
                                if live is not None:
                                    live["latest_user_turn_text"] = input_text

                            if not is_partial:
                                transcript.append(f"user: {input_text}")
                                live = _live_state_registry.get(session_id)
                                if live is not None:
                                    memory = live.get("conversation_memory", [])
                                    turn_id = live.pop("_open_speech_turn_id", None)
                                    if isinstance(memory, list):
                                        _append_memory_entry(
                                            memory,
                                            kind="user_turn",
                                            text=input_text,
                                            source="speech",
                                            turn_id=turn_id if isinstance(turn_id, int) else None,
                                        )
                                        if _looks_like_explicit_approval(input_text):
                                            _append_memory_entry(
                                                memory,
                                                kind="approval",
                                                text=input_text,
                                                source="speech",
                                                turn_id=turn_id if isinstance(turn_id, int) else None,
                                            )
                                speech_turn_open = False

                        if (
                            getattr(event, "output_transcription", None)
                            and event.output_transcription.text
                            and not getattr(event, "partial", True)
                        ):
                            assistant_text = event.output_transcription.text
                            transcript.append(
                                f"assistant: {assistant_text}"
                            )
                            live = _live_state_registry.get(session_id)
                            if live is not None:
                                memory = live.get("conversation_memory", [])
                                if isinstance(memory, list):
                                    _append_memory_entry(
                                        memory,
                                        kind="assistant_turn",
                                        text=assistant_text,
                                        source="assistant",
                                    )

                        if getattr(event, "turn_complete", False):
                            live = _live_state_registry.get(session_id)
                            if live is not None:
                                live.pop("_open_speech_turn_id", None)
                            speech_turn_open = False

                return
            except genai_errors.APIError as e:
                code = getattr(e, "code", None)
                if code in retryable_codes and attempt < max_retries:
                    attempt += 1
                    logger.warning(
                        "Transient Live API error %s (attempt %s/%s), retrying",
                        code,
                        attempt,
                        max_retries,
                    )
                    await asyncio.sleep(0.5 * attempt)
                    continue
                raise

    except WebSocketDisconnect:
        logger.info("Client disconnected (downstream)")
    except asyncio.CancelledError:
        pass
    except Exception as e:
        logger.error("Downstream error: %s", e)


@app.websocket("/ws/{user_id}/{session_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    user_id: str,
    session_id: str,
) -> None:
    await websocket.accept()
    connection_id = uuid.uuid4().hex
    await _claim_session_connection(session_id, connection_id, websocket)
    logger.info("WebSocket connected: user=%s session=%s", user_id, session_id)

    session = await session_service.get_session(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
    )
    if session is None:
        session = await session_service.create_session(
            app_name=APP_NAME,
            user_id=user_id,
            session_id=session_id,
        )

    ws_lock = asyncio.Lock()
    live_request_queue = _CodeInterceptQueue(websocket, ws_lock)
    first_input_event = asyncio.Event()
    session_start = time.monotonic()
    last_activity: list[float] = [session_start]

    session.state["_conversation_transcript"] = live_request_queue._transcript
    raw_uploaded_images = session.state.get("uploaded_images", [])
    normalized_uploaded_images: list[dict[str, str]] = []
    for index, raw_image in enumerate(raw_uploaded_images, start=1):
        image = _normalize_uploaded_image_record(
            raw_image,
            index_hint=index,
            source="user_upload",
        )
        if image is not None:
            normalized_uploaded_images.append(image)
    session.state["uploaded_images"] = normalized_uploaded_images
    conversation_memory = _normalize_conversation_memory(
        session.state.get("conversation_memory", [])
    )
    session.state["conversation_memory"] = conversation_memory
    recent_code_runs = _normalize_recent_code_runs(
        session.state.get("recent_code_runs", [])
    )
    session.state["recent_code_runs"] = recent_code_runs
    latest_user_entry = _latest_user_memory_entry(conversation_memory)
    latest_user_text = ""
    latest_user_source: str | None = None
    if latest_user_entry is not None:
        latest_user_text = _clean_text(latest_user_entry.get("text"))
        source = latest_user_entry.get("source")
        if isinstance(source, str) and source:
            latest_user_source = source

    # Register all live state directly so the code agent can access them
    # without going through ADK's state proxy (which may copy/snapshot values,
    # losing list references and callables).
    live_state = {
        "session_state": session.state,
        "transcript": live_request_queue._transcript,
        "conversation_memory": conversation_memory,
        "recent_code_runs": recent_code_runs,
        "emit_client_event": live_request_queue.emit_client_event,
        "code_files": session.state.get("code_files", []),
        "uploaded_images": session.state.get("uploaded_images", []),
        "latest_frame": None,
        "latest_frame_mime": "image/jpeg",
        "latest_image_generation_frame": session.state.get(
            "_latest_image_generation_frame"
        ),
        "latest_image_generation_frame_mime": session.state.get(
            "_latest_image_generation_frame_mime",
            "image/png",
        ),
        "latest_user_turn_text": latest_user_text,
        "latest_user_turn_source": latest_user_source,
    }
    register_live_state(session_id, live_state)

    run_config = RunConfig(
        streaming_mode=StreamingMode.BIDI,
        response_modalities=["AUDIO"],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(
                    voice_name="Puck",
                ),
            ),
            language_code="en-US",
        ),
        # Favor earlier barge-in detection so user speech interrupts playback faster.
        realtime_input_config=types.RealtimeInputConfig(
            activity_handling=types.ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
            # automatic_activity_detection=types.AutomaticActivityDetection(
            #     start_of_speech_sensitivity=(
            #         types.StartSensitivity.START_SENSITIVITY_HIGH
            #     ),
            #     end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_LOW,
            #     prefix_padding_ms=100,
            # ),
        ),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        session_resumption=types.SessionResumptionConfig(),
        proactivity=types.ProactivityConfig(proactive_audio=True),
        enable_affective_dialog=True,
        # context_window_compression=types.ContextWindowCompressionConfig(
        #     trigger_tokens=100000,
        #     sliding_window=types.SlidingWindow(target_tokens=80000),
        # ),
    )

    # Trigger the agent immediately so it greets the user on connection.
    first_input_event.set()
    live_request_queue.send_content(
        types.Content(
            role="user",
            parts=[types.Part(text="[Session started]")],
        )
    )

    up = asyncio.create_task(
        upstream_task(
            websocket,
            live_request_queue,
            first_input_event,
            user_id,
            session_id,
            connection_id,
            last_activity,
        )
    )
    down = asyncio.create_task(
        downstream_task(
            websocket,
            runner,
            user_id,
            session_id,
            connection_id,
            live_request_queue,
            first_input_event,
            run_config,
            ws_lock,
        )
    )
    timeout = asyncio.create_task(
        timeout_task(
            websocket,
            ws_lock,
            last_activity,
            session_start,
            SESSION_IDLE_TIMEOUT,
            SESSION_HARD_LIMIT,
        )
    )

    try:
        done, pending = await asyncio.wait(
            [up, down, timeout], return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        for task in pending:
            try:
                await task
            except asyncio.CancelledError:
                pass
    finally:
        live_request_queue.close()
        if _live_state_registry.get(session_id) is live_state:
            unregister_live_state(session_id)
        await _release_session_connection(session_id, connection_id)
        logger.info("WebSocket closed: user=%s session=%s", user_id, session_id)


@app.post("/api/create-session")
async def create_session_endpoint():
    """Creates a new chat session and returns its ID."""
    session_id = secrets.token_urlsafe(12)
    user_id = "user-" + session_id

    await session_service.create_session(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
    )

    return {"sessionId": session_id, "userId": user_id}

@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    data = await file.read()
    if len(data) > MAX_UPLOAD_SIZE:
        return JSONResponse(
            status_code=413,
            content={"error": f"File too large (max {MAX_UPLOAD_SIZE // (1024 * 1024)} MB)"},
        )
    try:
        url = await upload_public_blob(
            data=data,
            filename=file.filename or "upload",
            content_type=file.content_type or None,
            prefix="uploads",
        )
    except RuntimeError as exc:
        return JSONResponse(status_code=500, content={"error": str(exc)})

    return {"url": url}


@app.get("/health")
async def health():
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Deployment endpoints
# ---------------------------------------------------------------------------


@app.on_event("startup")
async def _startup():
    try:
        await init_db()
    except Exception as exc:
        logger.warning("Could not initialize deployment DB: %s", exc)


@app.on_event("shutdown")
async def _shutdown():
    await close_pool()


@app.post("/api/deploy", response_model=DeployResponse)
async def deploy_app(req: DeployRequest):
    deployment_id = uuid.uuid4().hex
    slug = secrets.token_urlsafe(8)

    thumbnail_url: str | None = None
    if req.thumbnail:
        try:
            image_data = base64.b64decode(req.thumbnail)
            thumbnail_url = await upload_public_blob(
                data=image_data,
                filename=f"{slug}.jpg",
                content_type="image/jpeg",
                prefix="thumbnails",
            )
        except Exception as exc:
            logger.warning("Failed to upload thumbnail: %s", exc)

    files_dicts = [f.model_dump() for f in req.files]

    await create_deployment(
        id=deployment_id,
        slug=slug,
        session_id=req.session_id,
        title=req.title,
        description=req.description,
        files=files_dicts,
        thumbnail_url=thumbnail_url,
    )

    return DeployResponse(
        id=deployment_id,
        slug=slug,
        url=f"/app/{slug}",
    )


@app.get("/api/deployments/{slug}")
async def get_deployment(slug: str):
    deployment = await get_deployment_by_slug(slug)
    if not deployment:
        return JSONResponse(status_code=404, content={"error": "Not found"})

    files = deployment["files"]
    if isinstance(files, str):
        files = json.loads(files)

    created_at = deployment["created_at"]
    updated_at = deployment["updated_at"]

    headers = {}
    if updated_at:
        headers["Last-Modified"] = updated_at.strftime("%a, %d %b %Y %H:%M:%S GMT")
        headers["Cache-Control"] = "public, max-age=60"

    return JSONResponse(
        content={
            "id": deployment["id"],
            "slug": deployment["slug"],
            "title": deployment["title"],
            "description": deployment["description"],
            "files": files,
            "thumbnailUrl": deployment["thumbnail_url"],
            "createdAt": created_at.isoformat() if created_at else None,
        },
        headers=headers,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
