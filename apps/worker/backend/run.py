"""Entry point of the notes worker: ``python backend/run.py`` serves http://127.0.0.1:5055.

Called by the Docker image (``CMD ["python", "run.py"]``) and by developers running the worker by hand.
It prepares the process (cache folder, repo-local temp folder, key check) and then starts the Flask app
built by ``app.server.create_app``.

Read next: ``app/server.py``.
"""

import os
import shutil
import sys
import tempfile
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)  # backend/  (the web app)
sys.path.insert(0, os.path.dirname(_HERE))  # repo root (the notes_engine package, when not pip-installed)

from app.server import create_app  # noqa: E402


def _use_local_temp() -> str:
    """Keep scratch files (downloaded audio, browser profiles for the PDF) inside the project folder, so
    they land on the same drive as the project, not on the system drive.  Child processes (ffmpeg, yt-dlp,
    Edge/Chrome) inherit TEMP/TMP.  Override with LNA_TMP_DIR."""
    d = os.environ.get("LNA_TMP_DIR") or os.path.join(_HERE, ".tmp")
    os.makedirs(d, exist_ok=True)
    os.environ["TEMP"] = os.environ["TMP"] = os.environ["TMPDIR"] = d
    tempfile.tempdir = d
    cutoff = time.time() - 3600  # leftovers of jobs that died before cleaning up
    for name in os.listdir(d):
        p = os.path.join(d, name)
        try:
            if name.startswith(("lna_", "lnai_")) and os.path.isdir(p) and os.path.getmtime(p) < cutoff:
                shutil.rmtree(p, ignore_errors=True)
        except OSError:
            pass
    return d


HOST = "127.0.0.1"  # local only - never bind to 0.0.0.0
PORT = int(os.environ.get("LNA_PORT", "5055"))


def main() -> None:
    """Configure the process and run the Flask server until Ctrl+C."""
    # Transcripts and accepted LLM answers are cached here (git-ignored, size-capped) so a retry or a
    # second request for the same video skips the slow steps. Set LNA_CACHE_DIR to move it.
    os.environ.setdefault("LNA_CACHE_DIR", os.path.join(_HERE, "output", "cache"))  # = cache.DEFAULT_DIR
    _use_local_temp()
    app = create_app()  # loads backend/.env
    from app.keycheck import check_keys  # warns about malformed provider keys (never logs values)

    check_keys()
    print(f"Lecture Notes AI running at http://{HOST}:{PORT}  (Ctrl+C to stop)")
    app.run(host=HOST, port=PORT, debug=False, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
