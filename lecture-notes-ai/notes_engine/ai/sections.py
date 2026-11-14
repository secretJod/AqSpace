"""Working with notebook *sections* inside model answers.

A finished notebook is a list of sections (title, blocks, key takeaways...).  Models return
them in many shapes, and the pipeline writes them in several pieces, so we need to:

1. find the sections in whatever JSON shape the model chose   -> ``find_sections()``
2. glue the sections of two neighbouring transcript slices    -> ``join_section_lists()``
3. group digests into compose batches                         -> ``pack_batches()``
4. count how many sections are really usable                  -> ``usable_section_count()``
5. build a fallback glossary from "definition" blocks         -> ``glossary_from_blocks()``

Nothing here calls the network.

Read next: ``../llm.py`` (the client and the pipeline that use these helpers).
"""
from __future__ import annotations

import math
import re
from typing import Any

from ..notes_schema import validate_notes
from .responses import as_str

# --------------------------------------------------------------------------- #
# 1. Finding sections in an answer
# --------------------------------------------------------------------------- #


def looks_like_section(v: Any) -> bool:
    """True for a dict that has content (blocks/takeaways) and a title."""
    return isinstance(v, dict) and ("blocks" in v or "key_takeaways" in v) and ("title" in v or "heading" in v)


def find_sections(obj: Any, _depth: int = 0) -> list:
    """Find the sections in whatever shape the model chose.

    Handles {"sections": [...]}, {"pages": [...]}, {"section": {...}}, a bare section object,
    a bare list, or any of these nested one level down.  Looks at most 3 levels deep.
    """
    if _depth > 3:
        return []
    if isinstance(obj, list):
        if any(looks_like_section(v) for v in obj):
            return [v for v in obj if isinstance(v, dict)]
        found = [s for v in obj for s in find_sections(v, _depth + 1)]
        return found or obj
    if not isinstance(obj, dict):
        return []
    if looks_like_section(obj):
        return [obj]
    # usual wrapper keys first...
    for k in ("sections", "pages", "notebook_pages", "notes", "section", "page", "items"):
        if k in obj:
            got = find_sections(obj[k], _depth + 1)
            if got:
                return got
    # ...then any nested value
    for v in obj.values():
        if isinstance(v, (dict, list)):
            got = find_sections(v, _depth + 1)
            if got:
                return got
    return []


# --------------------------------------------------------------------------- #
# 2. Joining the sections of two neighbouring slices
# --------------------------------------------------------------------------- #

# Words that say nothing about a topic, ignored when comparing two titles.
STOP_WORDS = {"the", "a", "an", "and", "of", "in", "on", "to", "for", "vs", "with", "from", "how", "what", "is",
              "llm", "llms", "model", "models", "stage", "into", "via", "its", "under", "over", "between", "by",
              "as", "at", "or", "part", "intro", "introduction", "basics", "overview"}


def title_words(section: Any) -> set[str]:
    """The meaningful lower-case words of a section's title."""
    t = as_str(section.get("title") if isinstance(section, dict) else "").lower()
    return {w for w in re.findall(r"[a-z0-9][a-z0-9\-]+", t) if w not in STOP_WORDS}


def join_section_lists(left: list, right: list) -> list:
    """Concatenate two consecutive slices' sections.

    A topic cut by the slice boundary tends to come back twice (end of one slice, start of
    the next).  When the two boundary titles clearly name the same topic (2+ shared content
    words that make up at least half of the shorter title), merge them into one section
    instead of printing the topic twice.
    """
    if not left or not right or not isinstance(left[-1], dict) or not isinstance(right[0], dict):
        return left + right
    a, b = left[-1], right[0]
    wa, wb = title_words(a), title_words(b)
    common = len(wa & wb)
    if common < 2 or common / max(1, min(len(wa), len(wb))) < 0.5:
        return left + right
    blocks_a = a.get("blocks") if isinstance(a.get("blocks"), list) else []
    blocks_b = b.get("blocks") if isinstance(b.get("blocks"), list) else []
    takeaways = [t for t in (a.get("key_takeaways") or []) + (b.get("key_takeaways") or []) if isinstance(t, str)]
    merged = dict(a)
    merged["blocks"] = (blocks_a + [x for x in blocks_b if x not in blocks_a])[:8]
    merged["diagram"] = a.get("diagram") or b.get("diagram")
    merged["key_takeaways"] = list(dict.fromkeys(takeaways))[:3]  # de-duplicate, keep order
    return left[:-1] + [merged] + right[1:]


# --------------------------------------------------------------------------- #
# 3. Grouping digests into compose batches
# --------------------------------------------------------------------------- #


def pack_batches(digests: list[str], max_chars: int, min_batches: int = 1) -> list[list[str]]:
    """Group consecutive digests into batches of at most ``max_chars`` characters.

    Uses at least ``min_batches`` groups (if there are that many digests) so each compose
    call only has to write a few sections for its own slice of the lecture.
    """
    total = sum(len(d) for d in digests)
    if min_batches > 1 and len(digests) >= min_batches:
        max_chars = min(max_chars, max(1, math.ceil(total / min_batches)))
    batches: list[list[str]] = []
    current: list[str] = []
    size = 0
    for d in digests:
        if current and size + len(d) > max_chars:
            batches.append(current)
            current, size = [], 0
        current.append(d)
        size += len(d)
    if current:
        batches.append(current)
    return batches


# --------------------------------------------------------------------------- #
# 4. Counting usable sections
# --------------------------------------------------------------------------- #


def usable_section_count(sections: list, max_sections: int = 10 ** 4) -> int:
    """How many of ``sections`` survive ``validate_notes`` (0 if none do).

    ``max_sections`` lifts validate_notes' section cap (very long local-model lectures)."""
    try:
        return len(validate_notes({"sections": sections}, max_sections=max_sections)["sections"])
    except ValueError:
        return 0


def coverage_needed(target: int) -> int:
    """Minimum acceptable number of sections: ~70 % of the target."""
    return max(1, math.ceil(0.7 * target))


# --------------------------------------------------------------------------- #
# 5. Fallback glossary
# --------------------------------------------------------------------------- #


def glossary_from_blocks(sections: list) -> list[dict]:
    """Collect up to 20 ``{"term", "definition"}`` pairs from "definition" blocks."""
    glossary = []
    for s in sections:
        for b in (s.get("blocks") or []) if isinstance(s, dict) else []:
            if isinstance(b, dict) and b.get("type") == "definition" and b.get("term") and b.get("text"):
                glossary.append({"term": b["term"], "definition": b["text"]})
    return glossary[:20]
