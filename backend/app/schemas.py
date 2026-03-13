"""
Pydantic models for the WebSocket message protocol between frontend and backend.
"""

from __future__ import annotations

from pydantic import BaseModel


class CodeFile(BaseModel):
    path: str
    code: str
    language: str


class DeployRequest(BaseModel):
    session_id: str
    title: str = "Untitled App"
    description: str | None = None
    files: list[CodeFile]
    thumbnail: str | None = None  # base64 JPEG


class DeployResponse(BaseModel):
    id: str
    slug: str
    url: str


