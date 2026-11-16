"""Background jobs: what runs in a thread after POST /api/jobs or POST /api/smart.

What this file does
    ``run_note_job``   transcript (0-25 %) -> AI notes (25-85 %) -> HTML preview + PDF (85-100 %)
    ``run_smart_job``  smart playlist analysis (watch order + topics)

    Both write progress into the job dict via ``state.update`` (the browser polls it), and turn
    every failure into a safe, user-friendly message. API keys are never logged (see ``redact``)
    and the references to them are dropped when the job ends.

Read next
    ``routes.py`` (where these threads are started).
"""
from __future__ import annotations

import inspect
import json
import logging
import traceback

from .helpers import format_duration, redact
from .settings import CHUNK_RE, GENERIC_ERROR
from .state import State

log = logging.getLogger("lna")


def _missing_module_error(exc: ImportError) -> str:
    return ("The notes engine is not fully installed yet "
            f"(missing module: {getattr(exc, 'name', None) or 'unknown'}).")


# ----------------------------------------------------------------------------------------------
# 1. Progress
# ----------------------------------------------------------------------------------------------
def scaled_progress(state: State, job: dict, lo: float, hi: float, stage: str):
    """Map a module's stage-local progress callback (pct 0-100) into the job's global range.

    Example: with lo=25, hi=85 a module reporting 50 % moves the job to 55 %.
    Progress never goes backwards.
    """
    def callback(_stage=None, pct=None, message=None, *_a, **_k):
        try:
            local = max(0.0, min(100.0, float(pct if pct is not None else 0)))
            overall = int(round(lo + (hi - lo) * local / 100.0))
            fields = {"stage": stage}
            if overall > job.get("pct", 0):
                fields["pct"] = overall
            if message:
                fields["message"] = str(message)[:240]
                match = CHUNK_RE.search(str(message))
                if match:  # map-stage progress: chunks finished / total (aq-api shows "chunk i/N")
                    fields["chunk"], fields["chunks"] = int(match.group(1)), int(match.group(2))
            state.update(job, **fields)
        except Exception:  # a broken progress callback must never kill the job
            pass
    return callback


# ----------------------------------------------------------------------------------------------
# 2. Note job
# ----------------------------------------------------------------------------------------------
def run_note_job(state: State, job_id: str, url: str, provider: str, api_key: str,
                 model: str | None, groq_key: str | None):
    job = state.jobs[job_id]
    secrets = [api_key, groq_key]
    job_dir = state.output_dir / job_id
    try:
        state.update(job, status="running", stage="transcript", pct=1, message="Fetching transcript...")
        try:
            ingest, llm, pdf = state.load_modules()
        except ImportError as e:
            log.error("module import failed: %s", redact(e, secrets))
            state.update(job, status="error", error=_missing_module_error(e))
            return
        PdfError = getattr(pdf, "PdfError", ())

        # Step 1: transcript (0-25 %)
        # speech-to-text checkpoints live in output/_cache/<video_id>/ (not a job dir, so
        # cleanup_old_jobs keeps them and a restarted job for the same video resumes)
        transcript = ingest.get_transcript(url, groq_key=groq_key,
                                           progress=scaled_progress(state, job, 0, 25, "transcript"),
                                           work_dir=str(state.output_dir / "_cache"))
        meta = {
            "title": str(transcript.get("title") or "Untitled lecture"),
            "channel": str(transcript.get("channel") or ""),
            "duration": format_duration(transcript.get("duration_sec")),
        }
        state.update(job, meta=meta, stage="notes", pct=max(job["pct"], 25),
                     message="Transcript ready. Writing notes...")

        # Step 2: notes (25-85 %)
        # per-video checkpoints (output/checkpoints/<video_id>/) let a retry resume finished chunks
        notes = llm.generate_notes(transcript, provider=provider, api_key=api_key, model=model,
                                   progress=scaled_progress(state, job, 25, 85, "notes"),
                                   checkpoint_dir=str(state.output_dir / "checkpoints"))
        job_dir.mkdir(parents=True, exist_ok=True)
        (job_dir / "notes.json").write_text(json.dumps(notes, ensure_ascii=False, indent=2), encoding="utf-8")
        try:  # prefer the notes' own title if the model produced a nicer one
            notes_title = (notes.get("meta") or {}).get("title")
            if notes_title:
                meta["title"] = str(notes_title)
        except AttributeError:
            pass
        state.update(job, meta=meta, stage="pdf", pct=max(job["pct"], 85), message="Drawing the notebook...")

        # Step 3: html preview + pdf (85-100 %). One of the two failing is only a warning.
        warnings: list[str] = []
        have_html = have_pdf = False
        try:
            html = pdf.render_html(notes)
            (job_dir / "notes.html").write_text(html, encoding="utf-8")
            have_html = True
            state.update(job, pct=max(job["pct"], 92))
        except Exception as e:
            log.error("render_html failed: %s\n%s", redact(e, secrets),
                      redact(traceback.format_exc(), secrets))
            warnings.append("The on-screen preview could not be drawn.")
        try:
            pdf.render_pdf(notes, str(job_dir / "notes.pdf"))
            have_pdf = (job_dir / "notes.pdf").is_file()
        except Exception as e:
            if PdfError and isinstance(e, PdfError):
                warnings.append(str(e))  # PdfError messages are written to be user-safe
            else:
                warnings.append("The PDF could not be drawn.")
            log.error("render_pdf failed: %s\n%s", redact(e, secrets),
                      redact(traceback.format_exc(), secrets))
        if not (have_html or have_pdf):
            state.update(job, status="error", error=warnings[-1] if warnings else GENERIC_ERROR)
            return

        base = f"/api/jobs/{job_id}"
        links = {"notes_json": f"{base}/notes.json"}
        if have_pdf:
            links["pdf"] = f"{base}/notes.pdf"
        if have_html:
            links["html"] = f"{base}/notes.html"
        state.update(job, status="done", stage="pdf", pct=100, message="Your notebook is ready.",
                     links=links, warning=" ".join(warnings) if warnings else None)
    except Exception as e:  # map every failure to a safe message
        # Our own error classes carry friendly messages; anything else is a crash.
        user_safe = False
        try:
            ingest_mod, llm_mod, pdf_mod = state.load_modules()
            safe_types = tuple(t for t in (getattr(ingest_mod, "IngestError", None),
                                           getattr(llm_mod, "LLMError", None),
                                           getattr(pdf_mod, "PdfError", None)) if isinstance(t, type))
            user_safe = bool(safe_types) and isinstance(e, safe_types)
        except Exception:
            pass
        if user_safe:
            msg = redact(str(e), secrets).strip() or GENERIC_ERROR
            log.warning("job %s failed (%s): %s", job_id, type(e).__name__, msg)
        else:
            msg = GENERIC_ERROR
            log.error("job %s crashed: %s: %s\n%s", job_id, type(e).__name__, redact(e, secrets),
                      redact(traceback.format_exc(), secrets))
        state.update(job, status="error", error=msg[:600])
    finally:
        # drop references to the keys as soon as possible
        secrets.clear()


# ----------------------------------------------------------------------------------------------
# 3. Smart-playlist job
# ----------------------------------------------------------------------------------------------
def run_smart_job(state: State, job_id: str, goal: str, videos: list[dict], provider: str,
                  api_key: str, model: str | None, groq_key: str | None = None):
    job = state.smart_jobs[job_id]
    secrets = [api_key, groq_key]

    def progress(stage, pct, message):
        try:
            fields = {"stage": str(stage)}
            if int(pct) > job.get("pct", 0):
                fields["pct"] = max(0, min(99, int(pct)))  # 100 is reserved for "done"
            if message:
                fields["message"] = str(message)[:240]
            state.update(job, **fields)
        except Exception:  # a broken progress callback must never kill the job
            pass

    try:
        state.update(job, status="running", stage="transcripts", pct=1, message="Starting...")
        try:
            smart = state.load_smart()
        except ImportError as e:
            log.error("module import failed: %s", redact(e, secrets))
            state.update(job, status="error", error=_missing_module_error(e))
            return
        # same transcript path as a notes job: Whisper fallback key and the shared speech-to-text cache
        # (keyword-only args; passed only when this smart_playlist accepts them)
        extra = {"groq_key": groq_key, "work_dir": str(state.output_dir / "_cache")}
        try:
            accepted = inspect.signature(smart.analyze).parameters
            extra = {k: v for k, v in extra.items() if k in accepted}
        except (TypeError, ValueError):
            extra = {}
        out = smart.analyze(goal, videos, provider, api_key, model, progress=progress, **extra)
        state.update(job, status="done", pct=100, message="Your learning path is ready.",
                     result=out["result"], usage=out["usage"])
    except Exception as e:  # map every failure to a safe message
        safe = ()
        try:
            safe = tuple(t for t in (getattr(state.load_smart(), "LLMError", None),
                                     getattr(state.load_ingest(), "IngestError", None)) if isinstance(t, type))
        except Exception:
            pass
        if safe and isinstance(e, safe):
            msg = redact(str(e), secrets).strip() or GENERIC_ERROR
            log.warning("smart job %s failed (%s): %s", job_id, type(e).__name__, msg)
        else:
            msg = GENERIC_ERROR
            log.error("smart job %s crashed: %s: %s\n%s", job_id, type(e).__name__, redact(e, secrets),
                      redact(traceback.format_exc(), secrets))
        state.update(job, status="error", error=msg[:600])
    finally:
        secrets.clear()
