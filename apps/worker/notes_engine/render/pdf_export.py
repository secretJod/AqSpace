"""Turning the notebook HTML into an A4 PDF with a headless Edge or Chrome.

What this file does
    1. ``find_browser`` locates Edge/Chrome (or the path in the LNAI_BROWSER env variable).
    2. ``render_pdf`` writes the print-mode HTML to a temp folder and runs the browser with
       ``--print-to-pdf``. The browser runs notebook.js (pagination) before printing.
    3. ``check_page_numbers`` opens the PDF with PyMuPDF and checks that every page says
       "pg. N / M" with the right N and M. If not (pagination did not finish in time), it
       retries once with a longer virtual-time budget.

How it fits
    Called by the worker (backend/app/server.py) and the CLI (notes_engine/__main__.py)
    through ``notes_engine.pdf.render_pdf``.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from .page_layout import build_document


class PdfError(Exception):
    """Raised when the PDF cannot be produced (message is user-safe)."""


# ----------------------------------------------------------------------------------------------
# 1. Finding a browser
# ----------------------------------------------------------------------------------------------
KNOWN_BROWSER_PATHS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    # macOS app bundles (not on PATH, so shutil.which below would miss them)
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
]
BROWSER_COMMAND_NAMES = (
    "msedge",
    "microsoft-edge",
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "chrome",
)


def find_browser() -> str:
    """Path of Edge/Chrome. Order: LNAI_BROWSER, known Windows/macOS paths, then the PATH."""
    from_env = os.environ.get("LNAI_BROWSER")
    candidates = [from_env] if from_env else []
    candidates += KNOWN_BROWSER_PATHS + [os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe")]
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            return candidate
    for name in BROWSER_COMMAND_NAMES:
        found = shutil.which(name)
        if found:
            return found
    raise PdfError("No Edge or Chrome installation was found; install Microsoft Edge or Google Chrome to create PDFs.")


# ----------------------------------------------------------------------------------------------
# 2. Checking the result
# ----------------------------------------------------------------------------------------------
def check_page_numbers(path: str) -> tuple[bool, int, int]:
    """(consistent, pages, declared_total). Consistent == every page carries 'pg. N / M' with M == pages."""
    try:
        import pymupdf  # type: ignore

        doc = pymupdf.open(path)
    except Exception:
        return False, 0, 0
    page_count = len(doc)
    declared_totals = set()
    ok = page_count > 0
    for i, page in enumerate(doc):
        match = re.search(r"pg\.\s*(\d+)\s*/\s*(\d+)", page.get_text())
        if not match or int(match.group(1)) != i + 1:
            ok = False
        else:
            declared_totals.add(int(match.group(2)))
    doc.close()
    ok = ok and declared_totals == {page_count}
    return ok, page_count, (next(iter(declared_totals)) if len(declared_totals) == 1 else 0)


# ----------------------------------------------------------------------------------------------
# 3. Rendering
# ----------------------------------------------------------------------------------------------
# Virtual-time budgets (ms) for the two attempts: normal, then generous (for <= 12 sections).
TIME_BUDGETS_MS = (20000, 60000)


def render_budgets(n_sections: int) -> tuple[tuple[int, int], int]:
    """((virtual-time budget ms, retry budget ms), process timeout s) scaled to the notes size.

    The in-browser pagination measures every item, so 80 sections (a 24 h lecture,
    ~150-250 pages) need far more time than the usual 8-12."""
    extra = max(0, int(n_sections) - 12)
    first = min(120000, TIME_BUDGETS_MS[0] + 1500 * extra)
    second = min(300000, TIME_BUDGETS_MS[1] + 4000 * extra)
    timeout = min(900, 180 + 8 * extra)
    return (first, second), timeout


def _browser_command(exe: str, profile_dir: str, budget_ms: int, pdf_path: str, html_uri: str) -> list[str]:
    """Command line for one headless print run (fresh profile, no extensions, no header/footer)."""
    return [
        exe,
        "--headless=new",
        "--disable-gpu",
        "--no-pdf-header-footer",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--hide-scrollbars",
        "--force-color-profile=srgb",
        "--disable-dev-shm-usage",
        "--js-flags=--max-old-space-size=4096",
        "--user-data-dir=" + profile_dir,
        "--virtual-time-budget=%d" % budget_ms,
        "--print-to-pdf=" + pdf_path,
        html_uri,
    ]


def render_pdf(notes: dict, out_path: str, *, rough_source: str | None = None) -> str:
    """Render ``notes`` to an A4 PDF at ``out_path`` (returns the path).

    ``rough_source`` is passed on to ``build_document`` (None = use the vendored Rough.js).
    """
    try:
        exe = find_browser()
        html_doc = build_document(notes, True, rough_source)
    except PdfError:
        raise
    except Exception as ex:  # pragma: no cover
        raise PdfError("Could not build the notebook layout: %s" % type(ex).__name__) from ex
    out_path = str(out_path)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="lnai_pdf_")
    try:
        html_path = os.path.join(tmp, "notebook.html")
        with open(html_path, "w", encoding="utf-8") as fh:
            fh.write(html_doc)
        tmp_pdf = os.path.join(tmp, "notebook.pdf")
        uri = Path(html_path).as_uri()
        last_err = ""
        sections = notes.get("sections") if isinstance(notes, dict) else None
        budgets, timeout = render_budgets(len(sections) if isinstance(sections, list) else 0)
        for attempt, budget in enumerate(budgets):
            profile = os.path.join(tmp, "profile%d" % attempt)
            cmd = _browser_command(exe, profile, budget, tmp_pdf, uri)
            try:
                if os.path.exists(tmp_pdf):
                    os.remove(tmp_pdf)
                subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout, check=False)
            except subprocess.TimeoutExpired:
                last_err = "the browser timed out"
                continue
            except OSError as ex:
                raise PdfError("Could not start the browser: %s" % type(ex).__name__) from ex
            if os.path.isfile(tmp_pdf) and os.path.getsize(tmp_pdf) > 1000:
                ok, pages, declared = check_page_numbers(tmp_pdf)
                if ok:
                    break
                last_err = "page numbering check failed (%d pages, declared %d)" % (pages, declared)
            else:
                last_err = "the browser produced no output"
        else:  # no attempt succeeded (the loop never hit "break")
            raise PdfError("PDF rendering failed: %s" % last_err)
        shutil.move(tmp_pdf, out_path)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return out_path
