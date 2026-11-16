"""Page furniture: the spiral binding rings, the cover border and the squiggly title underlines.

These are purely decorative SVGs. They are drawn in Python only (never redrawn by Rough.js) and
use fixed seeds, so they look the same every time.

Read next: ``blocks.py``.
"""

from __future__ import annotations

import math
import random
from functools import lru_cache

from .sketch import INK, Sketch
from .text import fmt_num, stable_seed


@lru_cache(maxsize=1)
def rings_svg() -> str:
    """The column of 24 spiral rings down the left edge of every page (same on every page)."""
    rng = random.Random(7)
    parts = []
    for i in range(24):
        cy = 36 + i * 45.9
        cx = 27 + rng.uniform(-1, 1)
        d = ""
        steps = 46
        for s in range(steps + 1):
            t = s / steps
            angle = t * 2 * math.pi * 2.6 + rng.uniform(0, 0.1)
            radius = 3 + 9 * t + rng.uniform(-0.9, 0.9)
            x, y = cx + math.cos(angle) * radius * 1.15, cy + math.sin(angle) * radius * 0.95
            d += ("M" if s == 0 else "L") + "%s %s" % (fmt_num(x), fmt_num(y))
        parts.append(
            '<path d="%s" fill="none" stroke="#6f6454" stroke-width="1.7" '
            'stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>' % d
        )
        parts.append('<circle cx="%s" cy="%s" r="2.2" fill="#3a332b" opacity=".75"/>' % (fmt_num(cx), fmt_num(cy)))
    return (
        '<svg class="rings" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 1122" aria-hidden="true">%s</svg>'
        % "".join(parts)
    )


def underline_svg(seed: str, width: float = 690, sw: float = 3.2) -> str:
    """A hand-drawn double underline (used under section titles and the cover title)."""
    sk = Sketch(stable_seed("ul", seed))
    d = sk.line_d(2, 6, width - 2, 5, amp=1.8)
    d2 = sk.line_d(width * 0.04, 8.5, width * 0.9, 7.5, amp=1.4)
    return (
        '<svg class="ul" xmlns="http://www.w3.org/2000/svg" viewBox="0 '
        '0 %s 12" preserveAspectRatio="none" aria-hidden="true">'
        '<path d="%s" fill="none" stroke="%s" stroke-width="%s" stroke-linecap="round"/>'
        '<path d="%s" fill="none" stroke="%s" stroke-width="1.4" stroke-linecap="round" opacity=".55"/></svg>'
    ) % (fmt_num(width), d, INK, fmt_num(sw), d2, INK)


def cover_border_svg() -> str:
    """The double frame drawn around the cover page."""
    sk = Sketch(stable_seed("cover-border"))
    sk.rect(66, 54, 672, 1004, fill="none", stroke=INK, sw=3.4, double=True)
    sk.rect(76, 64, 652, 984, fill="none", stroke=INK, sw=2.0, double=False)
    return (
        '<svg class="border" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 794 1122" aria-hidden="true">%s</svg>'
        % sk.out_plain()
    )
