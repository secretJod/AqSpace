"""``State``: everything the worker remembers while it runs (jobs, rate limits, module loaders).

How it fits
    ``server.create_app`` creates one ``State`` and stores it on ``app.extensions['lna']``.
    Routes read and write jobs through it; background threads update jobs with ``update()``.
    The ``load_*`` methods import the notes engine lazily - tests replace them with fakes.

Read next
    ``jobs.py``.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from pathlib import Path
from types import ModuleType


class State:
    """Process-wide mutable state, kept on app.extensions['lna']."""

    def __init__(self, output_dir: Path, max_active: int, rate_limit: tuple[int, int]):
        self.output_dir = output_dir
        self.max_active = max_active
        self.rate_limit = rate_limit  # (max requests, per seconds)
        self.jobs: dict[str, dict] = {}
        self.smart_jobs: dict[str, dict] = {}  # smart-playlist runs (own store and rate bucket)
        self.lock = threading.Lock()
        self.recent: deque[float] = deque()  # times of recent note jobs (rate limit)
        self.recent_smart: deque[float] = deque()
        self.recent_playlist: deque[float] = deque()  # separate bucket so playlist lookups can't starve note jobs
        self.playlist_slots = threading.BoundedSemaphore(2)  # at most 2 yt-dlp playlist fetches at once

    # --- 1. Loading the notes engine (lazy, so the server starts even if a module is broken) ---
    # Modules are looked up here so tests can monkeypatch ``load_modules`` with fakes.
    def load_modules(self) -> tuple[ModuleType, ModuleType, ModuleType]:
        """Import and return the engine modules ``(ingest, llm, pdf)``; raises ImportError if one is broken."""
        from notes_engine import ingest, llm, pdf

        return ingest, llm, pdf

    def load_ingest(self) -> ModuleType:
        """Just the ingest module (URL validation must work even if llm/pdf are unfinished)."""
        try:
            return self.load_modules()[0]
        except ImportError:
            from notes_engine import ingest

            return ingest

    def load_smart(self) -> ModuleType:
        """Import and return ``notes_engine.smart_playlist`` (tests monkeypatch this)."""
        from notes_engine import smart_playlist

        return smart_playlist

    # --- 2. Counting and limiting ---------------------------------------------------------------
    def active_count(self) -> int:
        """Return the number of note jobs that are queued or running."""
        return sum(1 for j in self.jobs.values() if j["status"] in ("queued", "running"))

    def active_smart(self) -> int:
        """Return the number of smart-playlist jobs that are queued or running."""
        return sum(1 for j in self.smart_jobs.values() if j["status"] in ("queued", "running"))

    def rate_limited(self, bucket: deque | None = None) -> bool:
        """Sliding-window limit. Returns True if the request must be refused; otherwise records it.

        ``bucket`` picks which list of recent request times to use (default: note jobs).
        """
        max_requests, window = self.rate_limit
        recent = self.recent if bucket is None else bucket
        now = time.monotonic()
        while recent and now - recent[0] > window:
            recent.popleft()
        if len(recent) >= max_requests:
            return True
        recent.append(now)
        return False

    def prune_memory(self, max_age_sec: int = 24 * 3600) -> None:
        """Forget finished jobs older than ``max_age_sec`` (their files are cleaned separately)."""
        cutoff = time.time() - max_age_sec
        for store in (self.jobs, self.smart_jobs):
            for jid in [k for k, j in store.items() if j["status"] in ("done", "error") and j["updated"] < cutoff]:
                store.pop(jid, None)

    # --- 3. Updating jobs and showing them to the browser ------------------------------------
    def update(self, job: dict, **fields: object) -> None:
        """Set ``fields`` on ``job`` and stamp ``updated``, under the state lock."""
        with self.lock:
            job.update(fields)
            job["updated"] = time.time()

    def public(self, job: dict) -> dict:
        """The fields of a note job that the browser may see (never keys)."""
        with self.lock:
            out = {k: job[k] for k in ("status", "stage", "pct", "message") if k in job}
            for k in ("error", "meta", "links", "warning", "chunk", "chunks"):
                if job.get(k):
                    out[k] = job[k]
            out["job_id"] = job["id"]
        return out

    def public_smart(self, job: dict) -> dict:
        """The fields of a smart-playlist job that the browser may see."""
        with self.lock:
            out = {k: job[k] for k in ("status", "stage", "pct", "message", "model") if k in job}
            for k in ("error", "result", "usage"):
                if job.get(k):
                    out[k] = job[k]
            out["job_id"] = job["id"]
        return out
