"""Small helpers for the Flask app: hiding secrets in logs, formatting, and cleaning old output.

Used by ``jobs.py`` and ``routes.py`` (``redact``, ``slugify``, ``format_duration``) and by
``server.create_app`` (``cleanup_old_jobs``).

Read next: ``state.py``.
"""

from __future__ import annotations

import re
import shutil
import time
from collections.abc import Iterable
from pathlib import Path

from .settings import CHECKPOINT_MAX_AGE_SEC, JOB_ID_RE


def redact(text: object, secrets: Iterable[str | None] = ()) -> str:
    """Strip anything that looks like a credential from text before it is logged.

    1. exact secrets we know about (the request's keys) become ***
    2. "key=...", "token: ...", "authorization=..." style values become ***
    3. "Bearer <token>" becomes "Bearer ***"

    Args:
        text: any value; it is converted with ``str()``.
        secrets: exact key values to hide (``None`` and values shorter than 4 characters are ignored).

    Returns:
        The redacted text.
    """
    text = str(text)
    for secret in secrets:
        if secret and len(secret) >= 4:
            text = text.replace(secret, "***")
    text = re.sub(
        r"(?i)((?:api[_-]?key|key|token|access_token|authorization)[\"']?\s*[=:]\s*[\"']?)[^&\s\"',}]+", r"\1***", text
    )
    text = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._\-]+", r"\1***", text)
    return text


def format_duration(seconds: object) -> str:
    """Format a duration in seconds: 3725 -> "1:02:05", 125 -> "2:05"; invalid or zero -> ""."""
    try:
        seconds = int(seconds)
    except (TypeError, ValueError):
        return ""
    if seconds <= 0:
        return ""
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def slugify(text: str, fallback: str = "lecture") -> str:
    """Return a safe file-name piece: letters/digits joined by "-", at most 60 characters.

    ``fallback`` is used when nothing usable is left.
    """
    slug = re.sub(r"[^A-Za-z0-9]+", "-", str(text or "")).strip("-")[:60]
    return slug or fallback


def cleanup_old_jobs(output_dir: Path, max_age_sec: int = 24 * 3600) -> int:
    """Delete job folders (uuid-hex names only) older than ``max_age_sec``.

    Also deletes per-video checkpoints older than ``CHECKPOINT_MAX_AGE_SEC``. Errors on single folders
    are skipped.

    Returns:
        The number of job folders removed.
    """
    removed = 0
    if not output_dir.is_dir():
        return 0
    now = time.time()
    for child in output_dir.iterdir():
        try:
            if child.is_dir() and JOB_ID_RE.match(child.name) and now - child.stat().st_mtime > max_age_sec:
                shutil.rmtree(child, ignore_errors=True)
                removed += 1
        except OSError:
            continue
    # unfinished per-video checkpoints (output/checkpoints/<video_id>/) are kept 7 days for a retry
    checkpoints = output_dir / "checkpoints"
    for child in checkpoints.iterdir() if checkpoints.is_dir() else []:
        try:
            if child.is_dir() and now - child.stat().st_mtime > CHECKPOINT_MAX_AGE_SEC:
                shutil.rmtree(child, ignore_errors=True)
        except OSError:
            continue
    return removed
