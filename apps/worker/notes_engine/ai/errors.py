"""Exceptions raised by the AI engine.

Only ``LLMError`` is meant for the outside world: its message is always safe to show to a
user (it never contains an API key).  The other classes are *internal signals* used by the
pipeline in ``notes_engine/llm.py`` to decide what to try next.

Read next: ``providers.py``.
"""
from __future__ import annotations

from typing import Any


class LLMError(Exception):
    """User-safe error message (never contains the API key)."""


class _BadJSON(LLMError):
    """The model kept returning unparseable JSON (even after one "please fix this JSON" call)."""


class _OutputTruncated(LLMError):
    """The model hit its output-token limit.

    ``text`` holds what the model produced before it was cut off, so the caller can try to
    salvage the complete part of it (see ``json_repair.salvage_truncated_json``).
    """

    def __init__(self, message: str, text: str = ""):
        super().__init__(message)
        self.text = text


class _TransientError(LLMError):
    """Rate limit (429), server error (5xx) or timeout - another provider may still work.

    ``daily_quota`` is True when the provider's daily cap is used up (nothing will work until it resets).
    """

    def __init__(self, message: str, daily_quota: bool = False):
        super().__init__(message)
        self.daily_quota = daily_quota


class _HTTPStatusError(LLMError):
    """The provider answered with an HTTP error that is not worth retrying as-is.

    ``status``  - the HTTP status code (e.g. 400),
    ``detail``  - lower-cased server message + error code, used to recognise known problems,
    ``payload`` - the parsed JSON body (or None), e.g. Groq puts ``failed_generation`` in it.
    """

    def __init__(self, message: str, status: int, detail: str = "", payload: Any = None):
        super().__init__(message)
        self.status, self.detail, self.payload = status, detail, payload
