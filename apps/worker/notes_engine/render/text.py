"""Small text helpers shared by every part of the notebook renderer.

What this file does
    Turns "whatever the AI gave us" (strings, lists, None, odd control characters) into clean,
    HTML-safe text, and offers a few tiny formatting helpers (numbers for SVG, stable seeds).

How it fits
    Every other module in ``notes_engine.render`` imports from here. Nothing here knows about
    pages, diagrams or fonts.

Read next
    ``fonts.py`` (measuring text), then ``sketch.py`` (the hand-drawn SVG toolkit).
"""
from __future__ import annotations

import hashlib
import html as _html
import re


# ----------------------------------------------------------------------------------------------
# 1. Escaping and coercing values
# ----------------------------------------------------------------------------------------------
def escape_html(value) -> str:
    """HTML-escape any value (``None`` becomes an empty string). Quotes are escaped too."""
    return _html.escape("" if value is None else str(value), quote=True)


def clean_text(value, default: str = "") -> str:
    """Coerce anything to one clean, stripped string.

    Lists are joined with spaces, Windows/Mac line endings become ``\\n`` and invisible
    control characters (which break HTML/PDF) are removed.
    """
    if value is None:
        return default
    if isinstance(value, (list, tuple)):
        value = " ".join(str(item) for item in value)
    text = str(value).replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text)
    return text.strip()


def as_list(value) -> list:
    """Return ``value`` if it is a list, otherwise an empty list."""
    return value if isinstance(value, list) else []


def as_dict(value) -> dict:
    """Return ``value`` if it is a dict, otherwise an empty dict."""
    return value if isinstance(value, dict) else {}


# ----------------------------------------------------------------------------------------------
# 2. Our tiny markup: **bold** and `code`
# ----------------------------------------------------------------------------------------------
BOLD_PATTERN = re.compile(r"\*\*(.+?)\*\*", re.S)
CODE_PATTERN = re.compile(r"`([^`\n]+)`")


def rich(text) -> str:
    """Escape the text FIRST, then turn **bold** and `code` back into tags.

    Because escaping happens before the tags are added, nothing from the notes can inject HTML.
    """
    safe = escape_html(clean_text(text))
    safe = CODE_PATTERN.sub(lambda m: "<code>" + m.group(1) + "</code>", safe)
    safe = BOLD_PATTERN.sub(lambda m: "<b>" + m.group(1) + "</b>", safe)
    return safe.replace("\n", "<br>")


def plain(text) -> str:
    """Remove our tiny markup, for places where only plain text is wanted (SVG labels)."""
    result = clean_text(text)
    result = BOLD_PATTERN.sub(lambda m: m.group(1), result)
    result = CODE_PATTERN.sub(lambda m: m.group(1), result)
    return re.sub(r"\s+", " ", result)


def truncate(text: str, max_chars: int) -> str:
    """Plain text cut to ``max_chars`` characters, ending with an ellipsis when cut."""
    result = plain(text)
    return result if len(result) <= max_chars else result[: max_chars - 1].rstrip() + "…"


def truncate_sentences(text: str, max_chars: int) -> str:
    """Plain text cut to whole sentences within ``max_chars`` (#128: no summary ending mid-sentence).

    Falls back to a word boundary plus an ellipsis when even the first sentence is too long."""
    result = plain(text)
    if len(result) <= max_chars:
        return result
    head = result[:max_chars]
    ends = [i for i in range(len(head)) if head[i] in ".!?" and (i + 1 == len(head) or head[i + 1] == " ")]
    if ends and ends[-1] >= max_chars // 3:
        return head[: ends[-1] + 1]
    cut = head[: max_chars - 1]
    if " " in cut:
        cut = cut[: cut.rfind(" ")]
    return cut.rstrip(" ,;:-") + "…"


# ----------------------------------------------------------------------------------------------
# 3. Numbers and seeds
# ----------------------------------------------------------------------------------------------
def stable_seed(*parts) -> int:
    """A random seed that depends only on ``parts``, so the same notes always draw the same wobbles."""
    digest = hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8", "replace")).digest()
    return int.from_bytes(digest[:8], "big")


def fmt_num(value: float) -> str:
    """Format a number for SVG: one decimal, without trailing zeros ("12.0" -> "12")."""
    return ("%.1f" % value).rstrip("0").rstrip(".")


def round1(value) -> float:
    """Round to one decimal (used for the Rough.js shape specs)."""
    return round(float(value), 1)
