"""
Database layer for deployment persistence using Google Cloud SQL (PostgreSQL).
"""

from __future__ import annotations

import json
import logging

import asyncpg
from google.cloud.sql.connector import Connector

from .config import DATABASE_URL, CLOUD_SQL_CONNECTION_NAME

logger = logging.getLogger(__name__)

_pool: asyncpg.Pool | None = None
_connector: Connector | None = None

_CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS deployment (
    id              TEXT PRIMARY KEY,
    slug            TEXT UNIQUE NOT NULL,
    session_id      TEXT NOT NULL,
    title           TEXT NOT NULL DEFAULT 'Untitled App',
    description     TEXT,
    files           JSONB NOT NULL,
    thumbnail_url   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""

_CREATE_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_deployment_slug ON deployment (slug);
"""


async def get_pool() -> asyncpg.Pool:
    global _pool, _connector
    if _pool is None:
        if CLOUD_SQL_CONNECTION_NAME:
            from .config import DB_USER, DB_PASSWORD, DB_NAME

            _connector = Connector()

            async def _getconn():
                return await _connector.connect_async(
                    CLOUD_SQL_CONNECTION_NAME,
                    "asyncpg",
                    user=DB_USER,
                    password=DB_PASSWORD,
                    db=DB_NAME,
                )

            _pool = await asyncpg.create_pool(
                connect=_getconn,
                min_size=1,
                max_size=5,
                command_timeout=30,
            )
        elif DATABASE_URL:
            connect_kwargs: dict = {
                "dsn": DATABASE_URL,
                "min_size": 1,
                "max_size": 5,
                "command_timeout": 30,
            }
            if "localhost" not in DATABASE_URL and "127.0.0.1" not in DATABASE_URL:
                connect_kwargs["ssl"] = "require"
            _pool = await asyncpg.create_pool(**connect_kwargs)
        else:
            raise RuntimeError("No database configuration provided")
    return _pool


async def init_db() -> None:
    """Create tables if they don't exist. Call on app startup."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(_CREATE_TABLE_SQL)
        await conn.execute(_CREATE_INDEX_SQL)
    logger.info("Database tables initialized")


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


# ---------------------------------------------------------------------------
# Deployment CRUD
# ---------------------------------------------------------------------------


async def create_deployment(
    *,
    id: str,
    slug: str,
    session_id: str,
    title: str,
    description: str | None,
    files: list[dict],
    thumbnail_url: str | None,
) -> dict:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO deployment (id, slug, session_id, title, description, files, thumbnail_url)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
            RETURNING id, slug, session_id, title, description, files, thumbnail_url, created_at, updated_at
            """,
            id,
            slug,
            session_id,
            title,
            description,
            json.dumps(files),
            thumbnail_url,
        )
        return dict(row) if row else {}


async def get_deployment_by_slug(slug: str) -> dict | None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, slug, session_id, title, description, files, thumbnail_url, created_at, updated_at
            FROM deployment
            WHERE slug = $1
            """,
            slug,
        )
        return dict(row) if row else None
