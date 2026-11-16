"""Keeping API keys safe: clean a pasted key, and scrub keys out of any text we show.

Rule of the project: an API key is only ever put in a request *header* (never in a URL) and
must never appear in an error message, a log line or a progress message.  Everything that
turns server text into a user-visible message goes through ``scrub_secrets()``.

Read next: ``responses.py``.
"""
from __future__ import annotations

import re
from typing import Any

from .errors import LLMError

# Shapes of keys from the providers we know (Gemini, Groq, xAI, Hugging Face, OpenAI-style,
# and any "Bearer <token>" header that a server might echo back).
KEY_PATTERNS = re.compile(
    r"(AIza[0-9A-Za-z_\-]{20,}|gsk_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}"
    r"|sk-[A-Za-z0-9_\-]{20,}|Bearer\s+[A-Za-z0-9._\-]{12,})")


def scrub_secrets(text: Any, key: str | None, limit: int = 300) -> str:
    """Return ``text`` as a short single-line string with every API key replaced by ``***``.

    ``key`` is the exact key in use (removed even if it does not match a known pattern);
    the result is cut to ``limit`` characters.
    """
    s = str(text or "")
    if key:
        s = s.replace(key, "***")
    s = KEY_PATTERNS.sub("***", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= limit else s[: limit - 1] + "…"


def clean_api_key(api_key: str | None) -> str:
    """Tidy up a key the user pasted (quotes, spaces, a leading "Bearer ") or raise LLMError."""
    key = (api_key or "").strip().strip("\"'").strip()
    if key.lower().startswith("bearer "):
        key = key[7:].strip()
    if not key:
        raise LLMError("No API key was provided. Paste your key in the app or set it in the environment (e.g. GROQ_API_KEY) or backend/.env.")
    if not key.isascii() or re.search(r"\s", key):
        raise LLMError("The API key contains spaces or unusual characters. Re-copy it without quotes or line breaks.")
    return key
