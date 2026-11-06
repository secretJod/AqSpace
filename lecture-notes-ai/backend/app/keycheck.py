"""Startup key-format check (#81).

At server start, look at the provider keys in the environment and log ONE warning line per key that is
set but looks malformed. Never logs the value, its length or any part of it: only the variable name and
the kind of problem.

Surrounding whitespace and quotes (a common .env copy-paste mistake) are stripped from os.environ in
place, so every later reader (server.py, notes_engine) sees the clean key.
"""
from __future__ import annotations

import logging
import os
import re
from typing import MutableMapping

log = logging.getLogger("lna")

# env var -> expected key prefix
KEY_PREFIXES = {
    "GEMINI_API_KEY": "AIza",
    "GROQ_API_KEY": "gsk_",
    "NVIDIA_API_KEY": "nvapi-",
}

_QUOTES = "\"'`"


def _clean(raw: str) -> str:
    v = raw.strip()
    while v and (v[0] in _QUOTES or v[-1] in _QUOTES):
        v = v.strip(_QUOTES).strip()
    return v


def problems(raw: str, prefix: str) -> list[str]:
    """Describe what is wrong with a raw key value. Descriptions never contain the value."""
    out = []
    if raw != raw.strip():
        out.append("surrounding whitespace")
    if any(q in raw for q in _QUOTES):
        out.append("quotes")
    cleaned = _clean(raw)
    if re.search(r"\s", cleaned):
        out.append("inner whitespace")
    if cleaned and not cleaned.startswith(prefix):
        out.append(f"unexpected prefix (expected {prefix}...)")
    return out


def check_keys(env: MutableMapping[str, str] | None = None,
               logger: logging.Logger | None = None) -> dict[str, list[str]]:
    """Warn about malformed keys and strip surrounding whitespace/quotes in place. Returns {var: problems}."""
    env = os.environ if env is None else env
    logger = logger or log
    found: dict[str, list[str]] = {}
    for name, prefix in KEY_PREFIXES.items():
        raw = env.get(name)
        if not raw or not raw.strip():
            continue
        issues = problems(raw, prefix)
        if issues:
            found[name] = issues
            logger.warning("key check: %s looks malformed: %s", name, ", ".join(issues))
        cleaned = _clean(raw)
        if cleaned != raw:
            env[name] = cleaned
    return found
