"""Fonts: embedding them in the HTML and measuring text with them.

What this file does
    1. Builds the ``@font-face`` CSS with every bundled font embedded as base64, so the HTML
       works offline and looks the same in every browser.
    2. Measures how wide a piece of text is (using PyMuPDF and the real font files) and wraps
       text into lines, so diagram boxes are always big enough for their labels.

How it fits
    ``diagrams.py`` uses ``text_width`` / ``wrap_text`` for layout; ``page_layout.py`` puts
    ``font_face_css()`` into the page ``<style>``.

Read next
    ``sketch.py``.
"""

from __future__ import annotations

import base64
from functools import lru_cache

from .paths import FONT_DIR
from .text import clean_text

# ----------------------------------------------------------------------------------------------
# 1. Font files embedded into the page
# ----------------------------------------------------------------------------------------------
# (CSS family name, file in static/fonts, CSS font-weight)
FONT_FACES = [
    ("NB Kalam", "Kalam-Regular.ttf", "400"),
    ("NB Kalam", "Kalam-Bold.ttf", "700"),
    ("NB Kalam Light", "Kalam-Light.ttf", "100 900"),
    ("NB Patrick", "PatrickHand-Regular.ttf", "400"),
    ("NB Caveat", "Caveat-Regular.ttf", "400"),
    ("NB Mono", "JetBrainsMono-Regular.ttf", "400"),
]


@lru_cache(maxsize=1)
def font_face_css() -> str:
    """CSS ``@font-face`` rules with the fonts inlined as base64 (computed once, then cached)."""
    rules = []
    for family, filename, weight in FONT_FACES:
        font_path = FONT_DIR / filename
        if not font_path.exists():
            continue
        b64 = base64.b64encode(font_path.read_bytes()).decode("ascii")
        rules.append(
            "@font-face{font-family:'%s';src:url(data:font/ttf;base64,%s) format('truetype');"
            "font-weight:%s;font-style:normal;font-display:block}" % (family, b64, weight)
        )
    return "\n".join(rules)


# ----------------------------------------------------------------------------------------------
# 2. Measuring text
# ----------------------------------------------------------------------------------------------
# Short "face" codes used throughout the diagram code -> font file used to measure them.
# They match the CSS classes on SVG <text> (kb = Kalam Bold, ph = Patrick Hand, cv = Caveat, ...).
MEASURE_FILES = {
    "kb": "Kalam-Bold.ttf",
    "kr": "Kalam-Regular.ttf",
    "kl": "Kalam-Light.ttf",
    "ph": "PatrickHand-Regular.ttf",
    "cv": "Caveat-Regular.ttf",
    "mono": "JetBrainsMono-Regular.ttf",
}
_loaded_fonts: dict = {}  # face code -> pymupdf.Font (or None if PyMuPDF is unavailable)


def _measure_font(face: str):
    """Load (once) the PyMuPDF font for a face code; ``None`` means "use the rough estimate"."""
    if face not in _loaded_fonts:
        try:
            import pymupdf  # type: ignore

            _loaded_fonts[face] = pymupdf.Font(fontfile=str(FONT_DIR / MEASURE_FILES[face]))
        except Exception:  # pragma: no cover - fall back to heuristics
            _loaded_fonts[face] = None
    return _loaded_fonts[face]


def text_width(text: str, size: float, face: str) -> float:
    """Width of ``text`` in px at font ``size`` (measured slightly too wide, on purpose)."""
    font = _measure_font(face)
    if font is None:
        return len(text) * size * 0.56
    try:
        return font.text_length(text, size) * 1.03 + 0.5
    except Exception:  # pragma: no cover
        return len(text) * size * 0.56


def wrap_text(text: str, max_width: float, size: float, face: str, max_lines: int | None = None) -> list[str]:
    """Split ``text`` into lines no wider than ``max_width``.

    Words longer than a whole line are broken into pieces. With ``max_lines`` the result is cut
    and the last line ends with an ellipsis. Always returns at least one (maybe empty) line.
    """
    words = clean_text(text).split()
    lines: list[str] = []
    current = ""
    for word in words:
        # A single word wider than the line: chop it into line-sized pieces.
        while text_width(word, size, face) > max_width and len(word) > 1:
            cut = len(word)
            while cut > 1 and text_width(word[:cut], size, face) > max_width:
                cut -= 1
            if current:
                lines.append(current)
                current = ""
            lines.append(word[:cut])
            word = word[cut:]
        candidate = (current + " " + word).strip()
        if current and text_width(candidate, size, face) > max_width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    if max_lines and len(lines) > max_lines:
        lines = lines[:max_lines]
        last = lines[-1]
        while last and text_width(last + "…", size, face) > max_width:
            last = last[:-1]
        lines[-1] = last.rstrip() + "…"
    return lines or [""]
