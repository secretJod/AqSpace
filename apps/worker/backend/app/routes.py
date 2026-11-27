"""All HTTP routes of the worker.

Routes:
    GET  /api/providers                           AI providers (+ whether a server key exists)
    POST /api/keys/test                           test a user's own key with one tiny real call
                                                  -> 200 {ok:true} | {ok:false, kind, error}
    POST /api/jobs                                start a lecture -> notes job      -> 202 {job_id}
    GET  /api/jobs/<id>                           job progress
    GET  /api/jobs/<id>/notes.json | notes.pdf | notes.html
    GET  /api/jobs/<id>/draft.html                live preview: pages finished so far (running jobs)
    POST /api/smart                               start a smart-playlist analysis   -> 202 {job_id}
                                                  (optional api_key overrides the server key)
    GET  /api/smart/<id>                          its progress / result
    GET  /api/playlist?url=...                    list the videos of a YouTube playlist (metadata only)

How it fits
    ``register_routes(app, state)`` is called by ``server.create_app``. Long work runs in
    background threads (``jobs.py``); routes only validate input and report status.

Read next
    ``jobs.py``.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import re
import threading
import time
import uuid
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_file

from .helpers import redact, slugify
from .jobs import run_note_job, run_smart_job
from .providers import provider_rows, provider_table, server_key
from .settings import (
    BYOK_PROVIDERS,
    CSP_NOTES,
    ENV_KEYS,
    JOB_ID_RE,
    KEY_RE,
    KEYLESS,
    MODEL_RE,
    PROVIDER_ORDER,
    VIDEO_ID_RE,
)
from .state import State

log = logging.getLogger("lna")


# ----------------------------------------------------------------------------------------------
# 1. Small validation helpers (shared by the routes below)
# ----------------------------------------------------------------------------------------------
def bad(msg: str, code: int = 400) -> tuple[Response, int]:
    """A JSON error response: {"error": msg} with status ``code``."""
    return jsonify(error=msg), code


def clean_key(value: object, label: str) -> tuple[str | None, str | None]:
    """Validate an optional key from the request body.

    Args:
        value: the raw JSON value.
        label: how the key is named in the error message ("API key", "Groq key").

    Returns:
        ``(key or None, error message or None)``.
    """
    if value is None or value == "":
        return None, None
    if not isinstance(value, str):
        return None, f"The {label} must be text."
    value = value.strip()
    if not value:
        return None, None
    if not KEY_RE.match(value):
        return None, f"The {label} looks invalid (unexpected characters or too long)."
    return value, None


def clean_model(value: object) -> tuple[str | None, bool]:
    """Validate an optional model name.

    Returns:
        ``(model or None, ok)``; ``ok`` is False when a value was given but is not a valid name.
    """
    if value in (None, ""):
        return None, True
    if not isinstance(value, str) or not MODEL_RE.match(value.strip()):
        return None, False
    return value.strip(), True


def unknown_provider_error() -> tuple[Response, int]:
    """Return the 400 response for a provider id that is not in PROVIDER_ORDER."""
    return bad("Unknown provider. Choose one of: " + ", ".join(PROVIDER_ORDER) + ".")


def valid_job_id(job_id: str) -> bool:
    """Return True when ``job_id`` has the shape of a job id (32 hex characters)."""
    return bool(JOB_ID_RE.match(job_id or ""))


def notes_page_csp(html: str) -> str:
    """CSP for the generated notebook page.

    The page runs two inline scripts (Rough.js + its own pagination), so we allow exactly the
    inline scripts present in the file we generated (by hash) - anything injected later would
    not match. It may also be framed by the local UI on another port.
    """
    hashes = []
    for m in re.finditer(r"<script(?![^>]*\bsrc\s*=)[^>]*>(.*?)</script>", html, re.S | re.I):
        digest = base64.b64encode(hashlib.sha256(m.group(1).encode("utf-8")).digest()).decode("ascii")
        hashes.append(f"'sha256-{digest}'")
    return CSP_NOTES.replace(
        "default-src 'none';", "default-src 'none'; script-src " + (" ".join(hashes) or "'none'") + ";", 1
    ).replace("frame-ancestors 'self'", "frame-ancestors 'self' http://127.0.0.1:* http://localhost:*")


def register_routes(app: Flask, state: State) -> None:
    """Attach every route listed at the top of this file to ``app``; handlers share ``state``."""

    # ------------------------------------------------------------------------------------------
    # 3. Providers
    # ------------------------------------------------------------------------------------------
    @app.get("/api/providers")
    def providers() -> Response:
        """GET /api/providers -> {providers: [...]} (see ``providers.provider_rows``)."""
        return jsonify(providers=provider_rows())

    @app.post("/api/keys/test")
    def keys_test() -> Response | tuple[Response, int]:
        """POST /api/keys/test {provider, api_key, model?} -> 200 {ok:true} | {ok:false, kind, error}.

        ``kind`` is invalid / quota / network / other. Called by aq-api before it saves a user's
        key. The key is never logged or echoed back (every message goes through ``redact``).
        """
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return bad("Send a JSON body with a provider and an api_key.")
        provider = data.get("provider")
        table = provider_table()
        if not isinstance(provider, str) or provider not in BYOK_PROVIDERS:
            return bad("Unknown provider. Key testing supports: " + ", ".join(BYOK_PROVIDERS) + ".")
        api_key, err = clean_key(data.get("api_key"), "API key")
        if err:
            return bad(err)
        if not api_key:
            return bad(f"Paste your {table[provider]['label']} key first.")
        model, ok = clean_model(data.get("model"))
        if not ok:
            return bad("The model name looks invalid.")

        try:
            llm = state.load_llm()
        except ImportError:
            return bad("The notes engine is not fully installed yet.", 503)
        check = getattr(llm, "check_key", None)
        if check is None:
            return bad("This notes engine cannot test keys yet. Restart the worker.", 503)
        with state.lock:
            if state.rate_limited(state.recent_keytest):
                return bad("Too many requests - please slow down a little.", 429)

        LLMError = getattr(llm, "LLMError", ())
        try:
            result = check(provider, api_key, model)
        except Exception as e:
            if LLMError and isinstance(e, LLMError):
                return bad(redact(str(e), (api_key,))[:300] or "That key could not be tested.")
            log.error("key test crashed (%s): %s", provider, redact(f"{type(e).__name__}: {e}", (api_key,)))
            result = {
                "ok": False,
                "kind": "other",
                "error": f"Couldn't test the {table[provider]['label']} key. Please try again.",
            }
        result = result if isinstance(result, dict) else {}
        if result.get("ok") is True:
            log.info("key test for %s: ok", provider)
            return jsonify(ok=True)
        kind = result.get("kind") if result.get("kind") in ("invalid", "quota", "network", "other") else "other"
        msg = redact(str(result.get("error") or ""), (api_key,)).strip()[:300]
        log.info("key test for %s: %s", provider, kind)
        return jsonify(
            ok=False, kind=kind, error=msg or f"Couldn't test the {table[provider]['label']} key. Please try again."
        )

    # ------------------------------------------------------------------------------------------
    # 4. Note jobs
    # ------------------------------------------------------------------------------------------
    @app.post("/api/jobs")
    def create_job() -> tuple[Response, int]:
        """POST /api/jobs {url, provider, api_key?, model?, groq_key?} -> 202 {job_id}.

        Errors: 400 for invalid input or a missing key, 429 when busy or rate-limited, 503 when the
        engine cannot be imported.
        """
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return bad("Send a JSON body with at least a YouTube url and a provider.")

        url = data.get("url")
        if not isinstance(url, str) or not url.strip():
            return bad("Please paste a YouTube link.")
        url = url.strip()
        if len(url) > 2048:
            return bad("That link is too long.")

        provider = data.get("provider")
        table = provider_table()
        if not isinstance(provider, str) or provider not in table:
            return unknown_provider_error()

        api_key, err = clean_key(data.get("api_key"), "API key")
        if err:
            return bad(err)
        groq_key, err = clean_key(data.get("groq_key"), "Groq key")
        if err:
            return bad(err)
        api_key = api_key or server_key(provider) or None
        if provider in KEYLESS:
            api_key = None  # never forward a typed key to the local server
        elif not api_key:
            return bad(
                f"No API key for {table[provider]['label']}. Paste one in the form, "
                f"or put {ENV_KEYS[provider]} in backend/.env."
            )
        # Whisper fallback key: request > env > the main key when the provider is Groq
        groq_key = groq_key or server_key("groq") or (api_key if provider == "groq" else None) or None

        model, ok = clean_model(data.get("model"))
        if not ok:
            return bad("The model name looks invalid.")

        # validate the URL with ingest's parser (also the SSRF guard)
        try:
            ingest = state.load_ingest()
        except ImportError:
            return bad("The notes engine is not fully installed yet.", 503)
        try:
            ingest.parse_video_id(url)
        except Exception as e:
            if isinstance(e, getattr(ingest, "IngestError", ())):
                return bad(str(e) or "That does not look like a YouTube link.")
            return bad("That does not look like a YouTube link.")

        with state.lock:
            state.prune_memory()
            if state.active_count() >= state.max_active:
                return bad("The server is busy with other lectures right now. Please wait a minute and try again.", 429)
            if state.rate_limited():
                return bad("Too many requests - please slow down a little.", 429)
            job_id = uuid.uuid4().hex
            now = time.time()
            job = {
                "id": job_id,
                "status": "queued",
                "stage": "transcript",
                "pct": 0,
                "message": "Queued...",
                "created": now,
                "updated": now,
            }
            state.jobs[job_id] = job

        thread = threading.Thread(
            target=run_note_job,
            name=f"job-{job_id[:8]}",
            daemon=True,
            args=(state, job_id, url, provider, api_key, model, groq_key),
        )
        thread.start()
        return jsonify(job_id=job_id), 202

    @app.get("/api/jobs/<job_id>")
    def job_status(job_id: str) -> Response | tuple[Response, int]:
        """GET /api/jobs/<id> -> the job's public fields (status, stage, pct, message, ...); 404 if unknown."""
        if not valid_job_id(job_id):
            return bad("Job not found.", 404)
        job = state.jobs.get(job_id)
        if job is None:
            return bad("Job not found (the server may have been restarted).", 404)
        return jsonify(state.public(job))

    # ------------------------------------------------------------------------------------------
    # 5. Job files (notes.json / notes.pdf / notes.html)
    # ------------------------------------------------------------------------------------------
    def job_file(job_id: str, name: str, *, while_running: bool = False) -> Path | None:
        """Path of a finished job's file, or None. Refuses anything outside the output folder.

        ``while_running`` allows the live preview (draft.html) before the job is done.
        """
        if not valid_job_id(job_id):
            return None
        job = state.jobs.get(job_id)
        if job is not None and job["status"] != "done" and not (while_running and job["status"] == "running"):
            return None
        path = state.output_dir / job_id / name
        try:
            path = path.resolve()
            if state.output_dir.resolve() not in path.parents or not path.is_file():
                return None
        except OSError:
            return None
        return path

    @app.get("/api/jobs/<job_id>/notes.json")
    def notes_json(job_id: str) -> Response | tuple[Response, int]:
        """GET /api/jobs/<id>/notes.json -> the structured notes of a finished job."""
        path = job_file(job_id, "notes.json")
        if path is None:
            return bad("File not found.", 404)
        resp = send_file(path, mimetype="application/json", max_age=0)
        resp.headers["Content-Disposition"] = 'inline; filename="notes.json"'
        return resp

    @app.get("/api/jobs/<job_id>/notes.pdf")
    def notes_pdf(job_id: str) -> Response | tuple[Response, int]:
        """GET /api/jobs/<id>/notes.pdf -> the PDF as a download named after the lecture title."""
        path = job_file(job_id, "notes.pdf")
        if path is None:
            return bad("File not found.", 404)
        title = (state.jobs.get(job_id) or {}).get("meta", {}).get("title", "")
        return send_file(
            path,
            mimetype="application/pdf",
            as_attachment=True,
            max_age=0,
            download_name=f"{slugify(title)}-notebook.pdf",
        )

    @app.get("/api/jobs/<job_id>/notes.html")
    def notes_html(job_id: str) -> Response | tuple[Response, int]:
        """GET /api/jobs/<id>/notes.html -> the notebook preview, with a CSP that allows only its own scripts."""
        return html_page(job_file(job_id, "notes.html"))

    @app.get("/api/jobs/<job_id>/draft.html")
    def draft_html(job_id: str) -> Response | tuple[Response, int]:
        """GET /api/jobs/<id>/draft.html -> live preview: the pages finished so far, while the job runs."""
        return html_page(job_file(job_id, "draft.html", while_running=True))

    def html_page(path: Path | None) -> Response | tuple[Response, int]:
        """Serve a notebook page with a CSP that allows exactly its own inline scripts (404 when missing)."""
        if path is None:
            return bad("File not found.", 404)
        html = path.read_text(encoding="utf-8", errors="replace")
        # file:// font URLs (used for the PDF render) cannot load inside an http page: point them at /static
        html = re.sub(r"file:///[^\"')\s]*?/static/fonts/", "/static/fonts/", html)
        resp = Response(html, mimetype="text/html")
        resp.headers["Content-Security-Policy"] = notes_page_csp(html)
        # Only this read-only page may be embedded by the local UI (another port = another origin); CSP frame-ancestors
        # supersedes X-Frame-Options, which security._headers() omits for this route only.
        return resp

    # ------------------------------------------------------------------------------------------
    # 6. Smart playlist
    # ------------------------------------------------------------------------------------------
    @app.post("/api/smart")
    def create_smart() -> tuple[Response, int]:
        """POST /api/smart {goal, videos:[{id,title,channel,duration_sec}], provider, model?, api_key?} -> 202 {job_id}.

        ``api_key`` is the signed-in user's own key, sent by aq-api; without it the server key is used.
        """
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return bad("Send a JSON body with a goal, a list of videos and a provider.")

        goal = data.get("goal")
        goal = " ".join(goal.split()) if isinstance(goal, str) else ""
        if not goal:
            return bad("The playlist needs a name (it is the learning goal).")
        if len(goal) > 120:
            return bad("The goal is too long (120 characters at most).")

        raw = data.get("videos")
        if not isinstance(raw, list) or not 2 <= len(raw) <= 20:
            return bad("Send between 2 and 20 videos.")
        videos, seen = [], set()
        for v in raw:
            vid = v.get("id") if isinstance(v, dict) else None
            if not isinstance(vid, str) or not VIDEO_ID_RE.match(vid):
                return bad("Every video needs an 11-character YouTube id.")
            title, channel, dur = v.get("title"), v.get("channel"), v.get("duration_sec")
            if not isinstance(title, str) or (channel is not None and not isinstance(channel, str)):
                return bad("Every video needs a text title (and a text channel).")
            if dur is not None and (isinstance(dur, bool) or not isinstance(dur, (int, float)) or dur < 0):
                return bad("duration_sec must be a number of seconds.")
            if vid in seen:
                continue  # the same video twice is analysed once
            seen.add(vid)
            videos.append(
                {
                    "id": vid,
                    "title": title.strip()[:200],
                    "channel": (channel or "").strip()[:120],
                    "duration_sec": int(dur or 0),
                }
            )
        if len(videos) < 2:
            return bad("Send between 2 and 20 different videos.")

        provider = data.get("provider")
        table = provider_table()
        if not isinstance(provider, str) or provider not in table:
            return unknown_provider_error()
        # The browser never sends a key here; aq-api may pass the signed-in user's own key as api_key
        # (decrypted only for this request), which wins over the server's .env key.
        api_key, err = clean_key(data.get("api_key"), "API key")
        if err:
            return bad(err)
        api_key = api_key or server_key(provider)
        if not api_key:
            return bad(f"No API key for {table[provider]['label']}. Put {ENV_KEYS[provider]} in backend/.env.")

        model, ok = clean_model(data.get("model"))
        if not ok:
            return bad("The model name looks invalid.")
        used_model = model or table[provider]["default_model"]
        if provider == "gemini":
            used_model = used_model.removeprefix("models/")

        try:
            state.load_smart()
        except ImportError:
            return bad("The notes engine is not fully installed yet.", 503)

        with state.lock:
            state.prune_memory()
            if state.active_smart() >= state.max_active:
                return bad("The server is busy with other analyses right now. Please wait a minute and try again.", 429)
            if state.rate_limited(state.recent_smart):
                return bad("Too many requests - please slow down a little.", 429)
            job_id = uuid.uuid4().hex
            now = time.time()
            job = {
                "id": job_id,
                "status": "queued",
                "stage": "transcripts",
                "pct": 0,
                "model": used_model,
                "message": "Queued...",
                "created": now,
                "updated": now,
            }
            state.smart_jobs[job_id] = job

        thread = threading.Thread(
            target=run_smart_job,
            name=f"smart-{job_id[:8]}",
            daemon=True,
            args=(
                state,
                job_id,
                goal,
                videos,
                provider,
                api_key,
                model,
                server_key("groq") or (api_key if provider == "groq" else None),
            ),
        )
        thread.start()
        return jsonify(job_id=job_id), 202

    @app.get("/api/smart/<job_id>")
    def smart_status(job_id: str) -> Response | tuple[Response, int]:
        """GET /api/smart/<id> -> the analysis' public fields (status, pct, result, usage, ...); 404 if unknown."""
        job = state.smart_jobs.get(job_id) if JOB_ID_RE.match(job_id or "") else None
        if job is None:
            return bad("Job not found (the server may have been restarted).", 404)
        return jsonify(state.public_smart(job))

    # ------------------------------------------------------------------------------------------
    # 7. Playlist lookup
    # ------------------------------------------------------------------------------------------
    @app.get("/api/playlist")
    def playlist() -> Response | tuple[Response, int]:
        """GET /api/playlist?url=<YouTube playlist link> -> {id,title,channel,count,videos,truncated,skipped}."""
        url = request.args.get("url", "")
        if not isinstance(url, str) or not url.strip():
            return bad("Please paste a YouTube playlist link.")
        url = url.strip()
        if len(url) > 2048:
            return bad("That link is too long.")
        try:
            ingest = state.load_ingest()
        except ImportError:
            return bad("The notes engine is not fully installed yet.", 503)
        IngestError = getattr(ingest, "IngestError", ())
        get_playlist = getattr(ingest, "get_playlist", None)
        if get_playlist is None:
            return bad("This server is too old to import playlists - restart it with docker compose up.", 503)
        # cheap local validation first (also the SSRF guard) so junk never costs a rate-limit slot
        parse_id = getattr(ingest, "parse_playlist_id", None)
        try:
            if parse_id is not None:
                parse_id(url)
        except Exception as e:
            if IngestError and isinstance(e, IngestError):
                return bad(str(e) or "That does not look like a YouTube playlist link.", getattr(e, "status", 400))
            return bad("That does not look like a YouTube playlist link.")

        with state.lock:
            if state.rate_limited(state.recent_playlist):
                return bad("Too many requests - please slow down a little.", 429)
        if not state.playlist_slots.acquire(blocking=False):
            return bad("The server is busy reading another playlist. Please try again in a moment.", 429)
        try:
            data = get_playlist(url)
        except Exception as e:
            if IngestError and isinstance(e, IngestError):
                msg = redact(str(e), ()).strip() or "Couldn't read that playlist."
                log.warning("playlist lookup failed (%s)", type(e).__name__)
                return bad(msg[:600], getattr(e, "status", 400))
            log.error("playlist lookup crashed: %s: %s", type(e).__name__, redact(e))
            return bad("Couldn't read that playlist from YouTube. Please try again in a moment.", 502)
        finally:
            state.playlist_slots.release()
        if not isinstance(data, dict):
            return bad("Couldn't read that playlist from YouTube. Please try again in a moment.", 502)
        return jsonify(data)
