import os

from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "")
CLOUD_SQL_CONNECTION_NAME = os.getenv("CLOUD_SQL_CONNECTION_NAME", "")

# Vertex AI ADC: requires gcloud auth application-default login
# and GOOGLE_CLOUD_PROJECT + GOOGLE_CLOUD_LOCATION set.
USE_VERTEXAI = os.getenv("GOOGLE_GENAI_USE_VERTEXAI", "FALSE").upper() == "TRUE"
GOOGLE_CLOUD_PROJECT = os.getenv("GOOGLE_CLOUD_PROJECT", "")
GOOGLE_CLOUD_LOCATION = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")

# Location for code-generation models (gemini-3.x) that require "global".
CODE_GEN_LOCATION = os.getenv("CODE_GEN_LOCATION", "global")
IMAGE_GEN_LOCATION = os.getenv("IMAGE_GEN_LOCATION", CODE_GEN_LOCATION)

ORCHESTRATOR_MODEL = os.getenv(
    "ORCHESTRATOR_MODEL",
    "gemini-live-2.5-flash-native-audio"
    if USE_VERTEXAI
    else "gemini-2.5-flash-native-audio-preview-12-2025",
)
CODE_GEN_MODEL = os.getenv("CODE_GEN_MODEL", "gemini-3-flash-preview")
CODE_GEN_FAST_MODEL = os.getenv("CODE_GEN_FAST_MODEL", "gemini-3.1-flash-lite-preview")
IMAGE_GEN_MODEL = os.getenv("IMAGE_GEN_MODEL", "gemini-3.1-flash-image-preview")
CODE_FAST_MODE = os.getenv("CODE_FAST_MODE", "true").lower() in ("1", "true", "yes")

GCS_BUCKET = os.getenv("GCS_BUCKET", "")

# Session timeout settings (in seconds)
SESSION_IDLE_TIMEOUT = int(os.getenv("SESSION_IDLE_TIMEOUT", "300"))  # 5 minutes
SESSION_HARD_LIMIT = int(os.getenv("SESSION_HARD_LIMIT", "1200"))  # 20 minutes

FRONTEND_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3000",
]
