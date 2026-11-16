"""Small helpers for reading provider HTTP replies.

1. Rate-limit hints - how long a provider asks us to wait, and whether a *daily* quota is used up.
2. Type guards      - ``as_str`` / ``as_dict`` so odd JSON shapes never crash the code.
3. Groq extras      - the ``failed_generation`` text Groq returns with a JSON-validation error.

None of these functions sleep or send requests; ``llm._Client`` decides what to do with the answers.

Read next: ``json_repair.py``.
"""
from __future__ import annotations

import re
from typing import Any

# --------------------------------------------------------------------------- #
# 1. Rate-limit hints
# --------------------------------------------------------------------------- #


def parse_retry_delay(resp: Any) -> float | None:
    """Seconds to wait, from the Retry-After header or provider-specific body hints (None = no hint)."""
    try:
        retry_after = resp.headers.get("Retry-After") or resp.headers.get("retry-after")
    except Exception:  # noqa: BLE001
        retry_after = None
    if retry_after:
        try:
            return max(0.0, float(retry_after))
        except ValueError:
            pass

    body = ""
    try:
        body = resp.text or ""
    except Exception:  # noqa: BLE001
        pass

    # Gemini: "retryDelay": "12s"
    m = re.search(r'"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"', body)
    if m:
        return float(m.group(1))

    # Groq: "Please try again in 1m2.5s" / "in 350ms" / "in 1h2m"
    m = re.search(r"try again in\s+(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)(ms|s))?", body)
    if m and any(m.groups()[:3]):
        hours, minutes, seconds, unit = m.groups()
        total = int(hours or 0) * 3600 + int(minutes or 0) * 60
        if seconds:
            total += float(seconds) / (1000 if unit == "ms" else 1)
        return total
    return None


def is_daily_quota_error(body: str) -> bool:
    """True when a 429 body says a per-DAY limit is used up (retrying today is pointless)."""
    b = body.lower()
    return any(t in b for t in ("perday", "per day", "tokens per day", "(tpd)", "requests per day",
                                "(rpd)", "daily limit", "daily quota", '"limit": 0', "limit: 0"))


# --------------------------------------------------------------------------- #
# 2. Type guards
# --------------------------------------------------------------------------- #


def as_str(v: Any) -> str:
    """``v`` as a string ("" for None)."""
    return v if isinstance(v, str) else ("" if v is None else str(v))


def as_dict(v: Any) -> dict:
    """``v`` if it is a dict, otherwise an empty dict."""
    return v if isinstance(v, dict) else {}


# --------------------------------------------------------------------------- #
# 3. Groq extras
# --------------------------------------------------------------------------- #


def failed_generation_text(payload: Any) -> str | None:
    """The invalid JSON text Groq sends back with a ``json_validate_failed`` error (or None)."""
    err = as_dict(as_dict(payload).get("error"))
    text = err.get("failed_generation")
    return text if isinstance(text, str) and text.strip() else None
