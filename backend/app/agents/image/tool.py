from __future__ import annotations

import asyncio
import base64
import logging
from typing import AsyncGenerator
from typing import cast

from google import genai
from google.adk.tools import ToolContext
from google.genai import types

from ...config import (
    GOOGLE_CLOUD_PROJECT,
    IMAGE_GEN_LOCATION,
    IMAGE_GEN_MODEL,
)
from ...storage import upload_public_blob
from ..code.agent import (
    _cancel_background_task,
    begin_tool_job,
    claim_tool_call_turn,
    clear_tool_job,
    emit_client_event,
    emit_tool_event,
    get_live_state,
    get_tool_job_id,
    is_current_tool_job,
    wait_for_task_heartbeats,
)

logger = logging.getLogger(__name__)

_IMAGE_GEN_SYSTEM_INSTRUCTION = (
    "You are an image generation assistant. "
    "The user provides a reference image captured from a canvas frame, which may "
    "contain rough sketches, annotations, or existing visuals. Treat this reference "
    "image as a compositional guide — use it to understand the intended layout, "
    "positioning, and structure, but produce a polished, high-quality final image.\n\n"
    "Guidelines:\n"
    "- Follow the user's text prompt as the primary instruction for style, subject, "
    "and mood.\n"
    "- Use the reference image to infer spatial arrangement and composition.\n"
    "- The reference image likely contains blue pen sketches drawn by the user. "
    "These blue strokes are rough guides indicating shapes, layout, or intent — "
    "do NOT reproduce them as blue lines or adopt a blue pen sketch style. "
    "Instead, interpret what the sketches represent and render them as polished, "
    "realistic or stylized visuals according to the text prompt.\n"
    "- Generate a clean, visually appealing image suitable for use in a web application. "
    "The final output must NOT look like a sketch or drawing unless the user's prompt "
    "explicitly requests a sketch style."
)

_image_gen_client: genai.Client | None = None
def _get_image_gen_client() -> genai.Client:
    global _image_gen_client
    if _image_gen_client is None:
        _image_gen_client = genai.Client(
            vertexai=True,
            project=GOOGLE_CLOUD_PROJECT,
            location=IMAGE_GEN_LOCATION,
        )
    return _image_gen_client


def _extension_for_mime_type(mime_type: str) -> str:
    if mime_type == "image/jpeg":
        return ".jpg"
    if mime_type == "image/webp":
        return ".webp"
    if mime_type == "image/gif":
        return ".gif"
    return ".png"


def _make_data_url(image_bytes: bytes, mime_type: str) -> str:
    encoded = base64.b64encode(image_bytes).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def _extract_generated_image(
    response: types.GenerateContentResponse,
) -> tuple[bytes | None, str, str]:
    response_text = response.text or ""
    candidates = response.candidates or []
    for candidate in candidates:
        content = getattr(candidate, "content", None)
        parts = getattr(content, "parts", None) or []
        for part in parts:
            inline_data = getattr(part, "inline_data", None)
            mime_type = getattr(inline_data, "mime_type", "") or ""
            data = getattr(inline_data, "data", None)
            if data and mime_type.startswith("image/"):
                return cast(bytes, data), cast(str, mime_type), response_text
    return None, "image/png", response_text


async def generate_image(
    prompt: str, tool_context: ToolContext, **kwargs
) -> AsyncGenerator[str, None]:
    del kwargs

    tool_name = "generate_image"
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
        return
    job_cleared = False
    generate_task: asyncio.Task | None = None
    upload_task: asyncio.Task | None = None

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
        message="Generating the requested image.",
    )

    try:
        live = get_live_state(orchestrator_session_id)
        frame_bytes = cast(bytes | None, live.get("latest_image_generation_frame"))
        frame_mime = cast(
            str,
            live.get("latest_image_generation_frame_mime", "image/png"),
        )
        uploaded_images = list(cast(list, live.get("uploaded_images", [])))

        if not frame_bytes:
            await emit_tool_event(
                orchestrator_session_id,
                event_type="tool_failed",
                tool_name=tool_name,
                job_id=job_id,
                stage="failed",
                message="No generation frame exists on the canvas yet.",
                reason="missing_frame",
            )
            await clear_tool_job(orchestrator_session_id, tool_name, job_id)
            job_cleared = True
            yield (
                "[ToolError] generate_image: Image generation failed because the "
                "canvas does not have a generation frame yet."
            )
            return

        client = _get_image_gen_client()

        user_parts: list[types.Part] = [
            types.Part(
                inline_data=types.Blob(
                    mime_type=frame_mime,
                    data=frame_bytes,
                )
            ),
            types.Part(
                text=(
                    "Using the attached reference image as a compositional guide, "
                    "generate a polished image based on the following description:\n\n"
                    f"{prompt}"
                )
            ),
        ]

        generate_task = asyncio.create_task(
            client.aio.models.generate_content(
                model=IMAGE_GEN_MODEL,
                contents=[
                    types.Content(role="user", parts=user_parts),
                ],
                config=types.GenerateContentConfig(
                    system_instruction=_IMAGE_GEN_SYSTEM_INSTRUCTION,
                    response_modalities=[types.Modality.IMAGE],
                    image_config=types.ImageConfig(
                        image_size="1K",
                    ),
                ),
            )
        )
        await wait_for_task_heartbeats(
            task=generate_task,
            session_id=orchestrator_session_id,
            job_id=job_id,
            tool_name=tool_name,
            stage="generating",
            client_message="Still generating the image.",
        )

        if not is_current_tool_job(orchestrator_session_id, tool_name, job_id):
            return

        response = await generate_task
        image_bytes, mime_type, response_text = _extract_generated_image(response)
        if not image_bytes:
            logger.warning(
                "Image model returned no image for session %s",
                orchestrator_session_id,
            )
            failure_message = response_text or "I couldn't generate an image from that prompt."
            await emit_tool_event(
                orchestrator_session_id,
                event_type="tool_failed",
                tool_name=tool_name,
                job_id=job_id,
                stage="failed",
                message=failure_message,
                reason="no_image",
            )
            await clear_tool_job(orchestrator_session_id, tool_name, job_id)
            job_cleared = True
            yield "[ToolError] generate_image: Image generation failed before completion."
            return

        extension = _extension_for_mime_type(mime_type)
        image_index = len(uploaded_images) + 1
        file_name = f"generated-image-{image_index}{extension}"
        data_b64 = base64.b64encode(image_bytes).decode("ascii")
        preview_url = _make_data_url(image_bytes, mime_type)

        await emit_tool_event(
            orchestrator_session_id,
            event_type="tool_result",
            tool_name=tool_name,
            job_id=job_id,
            stage="image_ready",
            message="Image preview is ready.",
        )
        await emit_client_event(
            orchestrator_session_id,
            {
                "type": "generated_image",
                "toolName": tool_name,
                "jobId": job_id,
                "url": preview_url,
                "name": file_name,
                "mimeType": mime_type,
                "data": data_b64,
            },
        )
        upload_task = asyncio.create_task(
            upload_public_blob(
                data=image_bytes,
                filename=file_name,
                content_type=mime_type,
                prefix="uploads",
            )
        )
        await wait_for_task_heartbeats(
            task=upload_task,
            session_id=orchestrator_session_id,
            job_id=job_id,
            tool_name=tool_name,
            stage="uploading",
            client_message="Saving the generated image.",
        )

        if not is_current_tool_job(orchestrator_session_id, tool_name, job_id):
            return

        try:
            url = await upload_task
        except Exception:
            logger.exception("Falling back to a data URL for generated image upload")
            url = preview_url

        image_entry = {"name": file_name, "url": url}
        uploaded_images.append(image_entry)
        tool_context.state["uploaded_images"] = uploaded_images
        live["uploaded_images"] = uploaded_images

        await emit_client_event(
            orchestrator_session_id,
            {
                "type": "generated_image",
                "toolName": tool_name,
                "jobId": job_id,
                "url": url,
                "name": file_name,
                "mimeType": mime_type,
                "data": data_b64,
            },
        )

        final_summary = response_text or "Image generation complete."
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
        yield f"[ToolComplete] generate_image: {final_summary}"
    except asyncio.CancelledError:
        if upload_task is not None:
            try:
                await asyncio.shield(_cancel_background_task(upload_task))
            except Exception:
                logger.debug("Failed to cancel image upload task", exc_info=True)
        if generate_task is not None:
            try:
                await asyncio.shield(_cancel_background_task(generate_task))
            except Exception:
                logger.debug("Failed to cancel image generation task", exc_info=True)
        if is_current_tool_job(orchestrator_session_id, tool_name, job_id):
            try:
                await asyncio.shield(
                    emit_tool_event(
                        orchestrator_session_id,
                        event_type="tool_cancelled",
                        tool_name=tool_name,
                        job_id=job_id,
                        stage="cancelled",
                        message="Stopped the image task.",
                        reason="cancelled",
                    )
                )
            except Exception:
                logger.debug("Failed to emit image cancellation event", exc_info=True)
        raise
    except Exception as exc:
        logger.exception(
            "Image generation failed for session %s", orchestrator_session_id
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
        yield "[ToolError] generate_image: Image generation failed before completion."
    finally:
        if upload_task is not None and not upload_task.done():
            await _cancel_background_task(upload_task)
        if generate_task is not None and not generate_task.done():
            await _cancel_background_task(generate_task)
        if not job_cleared:
            await clear_tool_job(orchestrator_session_id, tool_name, job_id)
