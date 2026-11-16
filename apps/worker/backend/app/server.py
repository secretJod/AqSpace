"""Flask worker for Lecture Notes AI (http://127.0.0.1:5055) - the entry point.

What this file does
    ``create_app(config)`` builds the Flask app: loads backend/.env, prepares the output
    folder, creates the shared ``State`` and plugs in security, error handlers and routes.
    backend/run.py (started by docker compose) calls it.

How the worker is organised (read in this order)
    settings.py   folders, validation patterns, providers, CSP strings
    helpers.py    redact secrets, format durations, slugify, delete old job folders
    state.py      State: jobs, rate limits, lazy loading of the notes engine
    jobs.py       background threads: lecture -> transcript -> notes -> HTML/PDF; smart playlist
    security.py   local-only guard, security headers, JSON error pages
    providers.py  provider list + server-side keys
    routes.py     every HTTP route (the full list is at the top of that file)

The heavy modules (ingest / llm / pdf) are imported lazily inside the worker so
the server starts even when one of them is missing or broken.
"""
from __future__ import annotations

import logging
from pathlib import Path

from flask import Flask
from flask_cors import CORS

# Re-exported so older imports (``from app.server import GENERIC_ERROR`` etc.) keep working.
from .helpers import cleanup_old_jobs, format_duration as _fmt_duration, redact as _redact, slugify as _slug  # noqa: F401
from .jobs import run_note_job as _run_job, run_smart_job as _run_smart, scaled_progress as _safe_progress  # noqa: F401
from .routes import register_routes
from .security import register_security
from .settings import (  # noqa: F401
    BACKEND_DIR, CSP_APP, CSP_FILE, CSP_NOTES, DEFAULT_OUTPUT_DIR, ENGINE_DIR, ENV_KEYS, FALLBACK_PROVIDERS,
    FRONTEND_DIR, GENERIC_ERROR, JOB_ID_RE, KEY_RE, LOCAL_HOST_RE, LOCAL_ORIGIN_RE, MODEL_RE, PROJECT_DIR,
    PROVIDER_ORDER, VIDEO_ID_RE, KEYLESS, CHUNK_RE,
)
from .state import State

try:  # python-dotenv is in requirements, but never let a missing .env library kill the server
    from dotenv import load_dotenv
except Exception:  # pragma: no cover
    load_dotenv = None

log = logging.getLogger("lna")

# Default settings; tests and callers override any of them through ``create_app(config)``.
DEFAULT_CONFIG = {
    "OUTPUT_DIR": DEFAULT_OUTPUT_DIR,
    "MAX_ACTIVE_JOBS": 2,
    "RATE_LIMIT": (10, 60),      # at most 10 new jobs / 60 s
    "MAX_CONTENT_LENGTH": 64 * 1024,
    "CLEANUP_ON_START": True,
    "LOAD_DOTENV": True,
}


def create_app(config: dict | None = None) -> Flask:
    # 1. Settings
    cfg = dict(DEFAULT_CONFIG)
    cfg.update(config or {})

    if cfg["LOAD_DOTENV"] and load_dotenv is not None:
        load_dotenv(BACKEND_DIR / ".env", override=False)

    # 2. The Flask app (fonts are served from notes_engine/static under /static)
    app = Flask(__name__, static_folder=str(ENGINE_DIR / "static"), static_url_path="/static")
    app.config["MAX_CONTENT_LENGTH"] = cfg["MAX_CONTENT_LENGTH"]
    app.json.ensure_ascii = False

    # 3. Output folder (old job folders are removed on start)
    output_dir = Path(cfg["OUTPUT_DIR"])
    output_dir.mkdir(parents=True, exist_ok=True)
    if cfg["CLEANUP_ON_START"]:
        try:
            n = cleanup_old_jobs(output_dir)
            if n:
                log.info("removed %d old job folder(s)", n)
        except Exception:
            log.warning("cleanup of old jobs failed")

    # 4. Shared state
    state = State(output_dir, int(cfg["MAX_ACTIVE_JOBS"]), tuple(cfg["RATE_LIMIT"]))
    app.extensions["lna"] = state

    # 5. CORS (only local pages may call the API), security, routes
    CORS(app, resources={r"/api/*": {"origins": [LOCAL_ORIGIN_RE]}}, methods=["GET", "POST", "OPTIONS"],
         allow_headers=["Content-Type"], max_age=600)
    register_security(app)
    register_routes(app, state)
    return app


# convenience for `flask --app app.server run` style usage
def _default_app() -> Flask:  # pragma: no cover
    return create_app()
