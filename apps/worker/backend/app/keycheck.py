"""Startup key-format check, called once by ``backend/run.py`` before the server starts.

It looks at the provider keys in the environment and logs ONE warning line per key that is set but
looks malformed. It never logs the value, its length or any part of it: only the variable name and the
kind of problem.

Only copy-paste damage is reported (whitespace, quotes). The key's prefix is deliberately not checked:
providers change key formats (a working Gemini key need not start with AIza), and the provider itself
is the only reliable judge of whether a key is valid.

Surrounding whitespace and quotes (a common .env copy-paste mistake) are stripped from os.environ in
place, so every later reader (server.py, notes_engine) sees the clean key.

Read next: ``providers.py``.
"""

from __future__ import annotations

import logging
import os
import re
from collections.abc import MutableMapping

log = logging.getLogger("lna")

# provider key env vars that are checked and cleaned at startup
KEY_VARS = ("GEMINI_API_KEY", "GROQ_API_KEY", "NVIDIA_API_KEY")

_QUOTES = "\"'`"


def _clean(raw: str) -> str:
    v = raw.strip()
    while v and (v[0] in _QUOTES or v[-1] in _QUOTES):
        v = v.strip(_QUOTES).strip()
    return v


def problems(raw: str) -> list[str]:
    """Describe what is wrong with a raw key value.

    Returns:
        Problem names such as "quotes" or "inner whitespace" (empty when the key looks fine). They
        never contain the value.
    """
    out = []
    if raw != raw.strip():
        out.append("surrounding whitespace")
    if any(q in raw for q in _QUOTES):
        out.append("quotes")
    cleaned = _clean(raw)
    if re.search(r"\s", cleaned):
        out.append("inner whitespace")
    return out


def check_keys(
    env: MutableMapping[str, str] | None = None, logger: logging.Logger | None = None
) -> dict[str, list[str]]:
    """Warn about malformed keys and strip surrounding whitespace/quotes in place.

    Args:
        env: the mapping to check and clean (default: ``os.environ``).
        logger: where warnings go (default: the "lna" logger).

    Returns:
        ``{variable name: problems}`` for every key that looked malformed.
    """
    env = os.environ if env is None else env
    logger = logger or log
    found: dict[str, list[str]] = {}
    for name in KEY_VARS:
        raw = env.get(name)
        if not raw or not raw.strip():
            continue
        issues = problems(raw)
        if issues:
            found[name] = issues
            logger.warning("key check: %s looks malformed: %s", name, ", ".join(issues))
        cleaned = _clean(raw)
        if cleaned != raw:
            env[name] = cleaned
    return found
