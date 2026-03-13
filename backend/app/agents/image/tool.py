from __future__ import annotations

import base64
import logging
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
from ..code.agent import _live_state_registry

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
_active_image_generate: dict[str, bool] = {}


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


async def generate_image(prompt: str, tool_context: ToolContext, **kwargs):
    del kwargs

    orchestrator_session_id = tool_context.session.id
    if _active_image_generate.get(orchestrator_session_id):
        return (
            "Image generation is already in progress. Wait for it to finish "
            "before calling generate_image again."
        )

    _active_image_generate[orchestrator_session_id] = True

    try:
        live = _live_state_registry.get(orchestrator_session_id, {})
        frame_bytes = cast(bytes | None, live.get("latest_image_generation_frame"))
        frame_mime = cast(
            str,
            live.get("latest_image_generation_frame_mime", "image/png"),
        )
        uploaded_images = list(cast(list, live.get("uploaded_images", [])))

        if not frame_bytes:
            return (
                "Image generation failed: no generation frame exists on the canvas. "
                "The user must first draw a frame on the canvas to define the area "
                "where the image will be placed. Ask the user to create a generation "
                "frame and try again."
            )

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
                    f"Using the attached reference image as a compositional guide, "
                    f"generate a polished image based on the following description:\n\n"
                    f"{prompt}"
                )
            ),
        ]

        response = await client.aio.models.generate_content(
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

        image_bytes, mime_type, response_text = _extract_generated_image(response)
        if not image_bytes:
            logger.warning("Image model returned no image for session %s", orchestrator_session_id)
            return response_text or "I couldn't generate an image from that prompt."

        extension = _extension_for_mime_type(mime_type)
        image_index = len(uploaded_images) + 1
        file_name = f"generated-image-{image_index}{extension}"
        data_b64 = base64.b64encode(image_bytes).decode("ascii")
        url = f"data:{mime_type};base64,{data_b64}"

        try:
            url = await upload_public_blob(
                data=image_bytes,
                filename=file_name,
                content_type=mime_type,
                prefix="uploads",
            )
        except Exception:
            logger.exception("Falling back to a data URL for generated image upload")

        image_entry = {"name": file_name, "url": url}
        uploaded_images.append(image_entry)
        tool_context.state["uploaded_images"] = uploaded_images
        live["uploaded_images"] = uploaded_images
        live["pending_generated_image"] = {
            "url": url,
            "name": file_name,
            "mimeType": mime_type,
            "data": data_b64,
        }

        return response_text or "Image generation complete."
    finally:
        _active_image_generate.pop(orchestrator_session_id, None)
