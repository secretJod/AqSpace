"""The renderer's front door: ``render_html``, ``render_pdf`` and ``PdfError``.

What this file does
    The job runner (``backend/app/jobs.py``), ``notes_engine.generate`` and the tests import the
    renderer as ``from notes_engine import pdf``. The code itself lives in ``notes_engine/render/``.

    ``render_html`` / ``render_pdf`` here are tiny wrappers that look up ``_rough_js`` in THIS
    module each time they run, so a test can render without Rough.js:
    ``monkeypatch.setattr(pdf, "_rough_js", lambda: "")``.

Read next
    ``notes_engine/render/__init__.py`` - it lists the renderer's files in reading order.
"""

from __future__ import annotations

from .render import PdfError, build_diagram_svg  # noqa: F401
from .render import page_layout as _page_layout
from .render import pdf_export as _pdf_export
from .render.cover import COVER_TOC_MAX  # noqa: F401

# Short names the tests use for renderer internals
from .render.diagrams import clean_diagram as _clean_diagram  # noqa: F401
from .render.diagrams import mindmap_tree as _mindmap_tree  # noqa: F401
from .render.page_layout import rough_js_source as _rough_js
from .render.pdf_export import find_browser as _find_browser  # noqa: F401
from .render.pdf_export import render_budgets as _render_budgets  # noqa: F401

__all__ = ["render_html", "render_pdf", "PdfError"]


def render_html(notes: dict, *, for_print: bool = False) -> str:
    """Full self-contained HTML (fonts embedded as base64). Pagination runs in the browser."""
    return _page_layout.render_html(notes, for_print=for_print, rough_source=_rough_js())


def render_pdf(notes: dict, out_path: str) -> str:
    """Render ``notes`` to an A4 PDF at ``out_path`` (returns the path)."""
    return _pdf_export.render_pdf(notes, out_path, rough_source=_rough_js())
