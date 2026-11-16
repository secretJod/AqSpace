"""Constants for the Flask worker: folders, input-validation patterns, providers and security policies.

How it fits
    Imported by every other module of the worker. Nothing here does any work; it is just the
    "settings sheet" so values are defined in exactly one place.

Read next
    ``helpers.py``.
"""

from __future__ import annotations

import re
from pathlib import Path

# ----------------------------------------------------------------------------------------------
# 1. Folders
# ----------------------------------------------------------------------------------------------
BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BACKEND_DIR.parent
ENGINE_DIR = PROJECT_DIR / "notes_engine"  # fonts are served from notes_engine/static/fonts
DEFAULT_OUTPUT_DIR = BACKEND_DIR / "output"

# ----------------------------------------------------------------------------------------------
# 2. Input validation patterns
# ----------------------------------------------------------------------------------------------
JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")  # uuid4().hex
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")  # a YouTube video id
KEY_RE = re.compile(r"^[\x21-\x7e]{1,512}$")  # printable ASCII, no whitespace
MODEL_RE = re.compile(r"^[A-Za-z0-9._:/\-]{1,200}$")
LOCAL_HOST_RE = re.compile(r"^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$", re.I)
LOCAL_ORIGIN_RE = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$", re.I)

# ----------------------------------------------------------------------------------------------
# 3. AI providers
# ----------------------------------------------------------------------------------------------
# provider id -> env var that may hold a server-side key
ENV_KEYS = {
    "gemini": "GEMINI_API_KEY",
    "groq": "GROQ_API_KEY",
    "xai": "XAI_API_KEY",
    "huggingface": "HF_TOKEN",
    "nvidia": "NVIDIA_API_KEY",
    "colab": "COLAB_LLM_KEY",
}

# providers that need no key (served locally; see notes_engine.llm.PROVIDERS["local"])
KEYLESS = {"local"}
# "chunk i/N" in a progress message -> job status fields chunk / chunks (aq-api shows "chunk i/N")
CHUNK_RE = re.compile(r"\bchunk (\d+)/(\d+)")

# Used only if llm.PROVIDERS cannot be imported (so the UI still renders).
FALLBACK_PROVIDERS = {
    "local": {
        "label": "Local model (Qwen3-8B)",
        "default_model": "qwen3-8b",
        "key_hint": "No key needed: runs on your own llama-server",
    },
    "gemini": {
        "label": "Google Gemini",
        "default_model": "gemini-3.5-flash-lite",
        "key_hint": "Free key at aistudio.google.com/apikey",
    },
    "groq": {
        "label": "Groq",
        "default_model": "llama-3.3-70b-versatile",
        "key_hint": "Free key at console.groq.com/keys",
    },
    "xai": {"label": "xAI Grok", "default_model": "grok-4", "key_hint": "Key from console.x.ai"},
    "huggingface": {
        "label": "Hugging Face",
        "default_model": "meta-llama/Llama-3.3-70B-Instruct",
        "key_hint": "Token from huggingface.co/settings/tokens",
    },
    "nvidia": {
        "label": "NVIDIA Nemotron",
        "default_model": "nvidia/nemotron-3.5-super-vl-120b-a12b",
        "key_hint": "Free key at build.nvidia.com",
    },
    "colab": {
        "label": "Colab Qwen3-8B (deprecated: use Local)",
        "default_model": "qwen3-8b",
        "key_hint": "Deprecated: set LNAI_LOCAL_URL + LNAI_LOCAL_KEY and choose Local",
    },
}
PROVIDER_ORDER = ["local", "gemini", "groq", "xai", "huggingface", "nvidia", "colab"]

# unfinished per-video checkpoints (output/checkpoints/<video_id>/) are kept this long for a retry
CHECKPOINT_MAX_AGE_SEC = 7 * 24 * 3600

# ----------------------------------------------------------------------------------------------
# 4. Messages
# ----------------------------------------------------------------------------------------------
GENERIC_ERROR = (
    "Something went wrong while making your notes. Please try again - "
    "if it keeps happening, check the server console for details."
)

# ----------------------------------------------------------------------------------------------
# 5. Content-Security-Policy headers
# ----------------------------------------------------------------------------------------------
# The web app itself (frontend/).
CSP_APP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    "font-src 'self'; connect-src 'self'; frame-src 'self' "
    "https://www.youtube-nocookie.com https://www.youtube.com; object-src 'none'; "
    "base-uri 'none'; form-action 'self'; frame-ancestors 'self'"
)
# The generated notebook page is self-contained (inline CSS, data: fonts/images) but must never run script.
# (routes.notes_html adds hashes for exactly the inline scripts we generated.)
CSP_NOTES = (
    "default-src 'none'; style-src 'unsafe-inline'; img-src data: 'self'; "
    "font-src data: 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
)
# Every other /api/ response (JSON, PDF downloads).
CSP_FILE = "default-src 'none'; frame-ancestors 'self'"
