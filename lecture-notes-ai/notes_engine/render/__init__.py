"""The notebook renderer: notes dict -> hand-drawn "field notebook" HTML -> A4 PDF.

Public API (also available as ``notes_engine.pdf``, the older import path):
    render_html(notes: dict, *, for_print=False) -> str
    render_pdf(notes: dict, out_path: str) -> str
    class PdfError(Exception)
    build_diagram_svg(diagram, width=690.0, css_class="d") -> (svg, w, h) | None

Files, in reading order:
    text.py         escaping, **bold**/`code` markup, small helpers
    fonts.py        embedded @font-face CSS, measuring and wrapping text
    sketch.py       Sketch: the seeded hand-drawn SVG toolkit (Python strokes + Rough.js specs)
    diagrams.py     8 diagram types: flow, stack, compare, cycle, tree, timeline, mindmap, sequence
    decorations.py  rings, cover border, squiggly underlines
    blocks.py       paragraph / bullets / steps / definition / example / callout / code / table / formula
    sections.py     section, glossary and recap units
    cover.py        the cover page
    page_layout.py  the full HTML document (render_html)
    pdf_export.py   headless Edge/Chrome -> PDF (render_pdf)

Safety: all text from the notes is escaped; only **bold** and `code` are re-introduced after escaping.
"""
from .diagrams import build_diagram_svg
from .page_layout import render_html
from .pdf_export import PdfError, render_pdf

__all__ = ["render_html", "render_pdf", "PdfError", "build_diagram_svg"]
