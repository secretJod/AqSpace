"""The hand-drawn ("sketchy") SVG toolkit used by every diagram.

What this file does
    ``Sketch`` collects SVG for one drawing. Each shape is recorded THREE ways:

      <g class="py">  plain jittery strokes drawn here in Python - the no-JavaScript fallback
      <g class="rg">  machine-readable shape specs (<g class="rj" data-s='{json}'>) that
                      templates/notebook.js hands to Rough.js; when that works, the Rough.js
                      drawing replaces the "py" group (the svg gets the class "rough-on")
      <g class="tx">  the real <text> labels (always visible, crisp and selectable)

    Every random wobble comes from a seeded ``random.Random``, so the same notes always
    produce exactly the same drawing (important for tests and caching).

How it fits
    ``diagrams.py`` positions boxes and arrows and calls the methods here to draw them;
    ``decorations.py`` uses it for page borders and underlines.

Read next
    ``diagrams.py``.
"""

from __future__ import annotations

import json
import math
import random

from .fonts import text_width
from .text import escape_html, fmt_num, round1

# ----------------------------------------------------------------------------------------------
# 1. Colours
# ----------------------------------------------------------------------------------------------
INK = "#2b2622"  # the main "pen" colour
CARD = "#fffdf6"  # default box fill
PAPER = "#f6f1e3"  # page colour (used behind edge labels)

# Box colour sets: (pale base fill, outline colour, highlighter hachure colour or None)
TINTS = [
    ("#fffdf6", INK, None),  # 0 plain
    ("#fdeeea", "#b03a2e", "#ee9d92"),  # 1 pink
    ("#eef7ee", "#2e7d4f", "#79c48e"),  # 2 green
    ("#eef3fb", "#2f5f8f", "#8db6e2"),  # 3 blue
    ("#fff8d6", "#9c7d0b", "#f3d63b"),  # 4 yellow
]

# Rough.js seeds must stay below this value.
ROUGH_SEED_MODULUS = 2147483646


# ----------------------------------------------------------------------------------------------
# 2. The Sketch class
# ----------------------------------------------------------------------------------------------
class Sketch:
    """One drawing. Call the shape methods, then ``out()`` (or ``out_plain()``) for the markup."""

    def __init__(self, seed: int):
        self.rng = random.Random(seed)
        self.seed = seed % ROUGH_SEED_MODULUS
        self.parts: list[str] = []  # python fallback strokes
        self.rj: list[dict] = []  # rough.js shape specs
        self.tx: list[str] = []  # text (always visible)
        self._shape_count = 0

    def jitter(self, amount: float) -> float:
        """A random offset in [-amount, +amount] - the "hand-drawn" wobble."""
        return self.rng.uniform(-amount, amount)

    def _add_rough_spec(self, kind: str, args: list, op=None, **options) -> None:
        """Record one shape for Rough.js.

        ``kind`` is r (rectangle), e (ellipse), l (line) or p (path); ``op`` is an optional
        opacity. Each shape gets its own fixed seed, so Rough.js always draws it the same way.
        """
        self._shape_count += 1
        options.setdefault("seed", (self.seed + self._shape_count * 7919) % ROUGH_SEED_MODULUS + 1)
        spec = {"k": kind, "a": [v if isinstance(v, str) else round1(v) for v in args], "o": options}
        if op:
            spec["op"] = op
        self.rj.append(spec)

    # --- 2a. Basic shapes ---------------------------------------------------------------------
    def line_d(self, x1, y1, x2, y2, amp=1.3, over=0.0) -> str:
        """SVG path data for one slightly bowed line.

        ``amp`` controls how much it bows; ``over`` lets the ends overshoot a little, like a pen.
        """
        dx, dy = x2 - x1, y2 - y1
        length = math.hypot(dx, dy) or 1.0
        ux, uy = dx / length, dy / length
        overshoot_start = self.rng.uniform(0, over)
        overshoot_end = self.rng.uniform(0, over)
        x1, y1 = x1 - ux * overshoot_start, y1 - uy * overshoot_start
        x2, y2 = x2 + ux * overshoot_end, y2 + uy * overshoot_end
        nx, ny = -uy, ux  # normal direction (the line bows sideways along it)
        bow = self.jitter(amp * (1.0 + min(length, 300) / 150.0))
        mx, my = (x1 + x2) / 2 + nx * bow, (y1 + y2) / 2 + ny * bow
        return "M%s %sQ%s %s %s %s" % (
            fmt_num(x1 + self.jitter(0.6)),
            fmt_num(y1 + self.jitter(0.6)),
            fmt_num(mx),
            fmt_num(my),
            fmt_num(x2 + self.jitter(0.6)),
            fmt_num(y2 + self.jitter(0.6)),
        )

    def rect(
        self,
        x,
        y,
        w,
        h,
        fill=CARD,
        stroke=INK,
        sw=2.2,
        double=True,
        dash=None,
        shadow=False,
        hl=None,
        hl_style="hachure",
        rough=True,
    ):
        """Box. ``fill`` is the pale base, ``hl`` an optional highlighter-hachure colour (Rough.js only).

        ``double`` draws the outline twice (the second pass thinner) like a real pen sketch;
        ``rough=False`` skips the Rough.js spec (used for page furniture).
        """
        markup = []
        wobble = 1.4
        corners = [
            (x + self.jitter(wobble), y + self.jitter(wobble)),
            (x + w + self.jitter(wobble), y + self.jitter(wobble)),
            (x + w + self.jitter(wobble), y + h + self.jitter(wobble)),
            (x + self.jitter(wobble), y + h + self.jitter(wobble)),
        ]
        if shadow:
            markup.append(
                '<path d="M%s %sL%s %sL%s %sL%s %sZ" fill="rgba(43,38,34,.16)" stroke="none"/>'
                % (
                    fmt_num(corners[0][0] + 4),
                    fmt_num(corners[0][1] + 4),
                    fmt_num(corners[1][0] + 4),
                    fmt_num(corners[1][1] + 4),
                    fmt_num(corners[2][0] + 4),
                    fmt_num(corners[2][1] + 4),
                    fmt_num(corners[3][0] + 4),
                    fmt_num(corners[3][1] + 4),
                )
            )
        if fill and fill != "none":
            markup.append(
                '<path d="M%s %sL%s %sL%s %sL%s %sZ" fill="%s" stroke="none"/>'
                % (
                    fmt_num(corners[0][0]),
                    fmt_num(corners[0][1]),
                    fmt_num(corners[1][0]),
                    fmt_num(corners[1][1]),
                    fmt_num(corners[2][0]),
                    fmt_num(corners[2][1]),
                    fmt_num(corners[3][0]),
                    fmt_num(corners[3][1]),
                    fill,
                )
            )
        passes = 2 if double else 1
        for pass_no in range(passes):
            d = ""
            points = corners if pass_no == 0 else [(px + self.jitter(1.6), py + self.jitter(1.6)) for px, py in corners]
            for i in range(4):
                a, b = points[i], points[(i + 1) % 4]
                d += self.line_d(a[0], a[1], b[0], b[1], amp=0.9, over=4.0 if pass_no == 0 else 3.0)
            extra = ' stroke-dasharray="%s"' % dash if dash else ""
            markup.append(
                '<path d="%s" fill="none" stroke="%s" stroke-width="%s" stroke-linecap="round" stroke-linejoin="round"%s%s/>'
                % (d, stroke, fmt_num(sw if pass_no == 0 else sw * 0.55), ' opacity=".8"' if pass_no else "", extra)
            )
        self.parts.append("".join(markup))
        if not rough:
            return
        box = [x, y, w, h]
        if shadow:
            self._add_rough_spec(
                "r", [x + 4, y + 4, w, h], fill="rgba(43,38,34,.16)", fillStyle="solid", stroke="none", roughness=0.6
            )
        if fill and fill != "none":
            self._add_rough_spec("r", box, fill=fill, fillStyle="solid", stroke="none", roughness=0.6)
        if hl:
            self._add_rough_spec(
                "r",
                box,
                op=0.5,
                fill=hl,
                fillStyle=hl_style,
                fillWeight=4.2,
                hachureGap=8,
                hachureAngle=-38,
                stroke="none",
                roughness=1.0,
            )
        options = dict(stroke=stroke, strokeWidth=round1(sw), roughness=1.15, bowing=1.1, disableMultiStroke=not double)
        if dash:
            options["strokeLineDash"] = [float(v) for v in str(dash).split()]
        self._add_rough_spec("r", box, **options)

    def ellipse(self, cx, cy, w, h, fill=CARD, stroke=INK, sw=2.2, hl=None, hl_style="hachure"):
        """Hand-drawn ellipse centred on (cx, cy), outlined twice like ``rect``."""
        rng = self.rng
        rx, ry = w / 2, h / 2
        for pass_no in range(2):
            steps = 28
            start_angle = rng.uniform(0, 6.28)
            points = []
            for i in range(steps + 3):  # a few extra points so the ends overlap
                angle = start_angle + 2 * math.pi * i / steps
                wobble = 1 + rng.uniform(-0.015, 0.015) + (pass_no * rng.uniform(-0.02, 0.02))
                points.append((cx + math.cos(angle) * rx * wobble, cy + math.sin(angle) * ry * wobble))
            d = "M%s %s" % (fmt_num(points[0][0]), fmt_num(points[0][1])) + "".join(
                "L%s %s" % (fmt_num(px), fmt_num(py)) for px, py in points[1:]
            )
            if pass_no == 0 and fill and fill != "none":
                self.parts.append('<path d="%sZ" fill="%s" stroke="none"/>' % (d, fill))
            self.parts.append(
                '<path d="%s" fill="none" stroke="%s" stroke-width="%s" stroke-linecap="round" stroke-linejoin="round"%s/>'
                % (d, stroke, fmt_num(sw if pass_no == 0 else sw * 0.55), ' opacity=".8"' if pass_no else "")
            )
        box = [cx, cy, w, h]
        if fill and fill != "none":
            self._add_rough_spec("e", box, fill=fill, fillStyle="solid", stroke="none", roughness=0.6)
        if hl:
            self._add_rough_spec(
                "e",
                box,
                op=0.5,
                fill=hl,
                fillStyle=hl_style,
                fillWeight=4.2,
                hachureGap=8,
                hachureAngle=-38,
                stroke="none",
                roughness=1.0,
            )
        self._add_rough_spec("e", box, stroke=stroke, strokeWidth=round1(sw), roughness=1.15, bowing=1.1)

    @staticmethod
    def _fallback_path(d, stroke, sw, dash=None, opacity=None) -> str:
        """``<path>`` markup for one Python-drawn stroke."""
        extra = ' stroke-dasharray="%s"' % dash if dash else ""
        op = ' opacity="%s"' % opacity if opacity else ""
        return (
            '<path d="%s" fill="none" stroke="%s" stroke-width="%s" stroke-linecap="round" stroke-linejoin="round"%s%s/>'
            % (d, stroke, fmt_num(sw), extra, op)
        )

    @staticmethod
    def _dash_option(dash) -> dict:
        """Rough.js option for a dashed stroke ("7 5" -> [7.0, 5.0]), or nothing."""
        return {"strokeLineDash": [float(v) for v in str(dash).split()]} if dash else {}

    def line(self, x1, y1, x2, y2, stroke=INK, sw=2.2, dash=None, amp=1.3, opacity=None):
        """A single hand-drawn line."""
        self.parts.append(self._fallback_path(self.line_d(x1, y1, x2, y2, amp=amp), stroke, sw, dash, opacity))
        self._add_rough_spec(
            "l",
            [x1, y1, x2, y2],
            op=opacity,
            stroke=stroke,
            strokeWidth=round1(sw),
            roughness=1.0,
            bowing=1.0,
            **self._dash_option(dash),
        )

    def path(self, d, stroke=INK, sw=2.2, dash=None, opacity=None, rd=None):
        """Stroke an SVG path. ``d`` is the python fallback; ``rd`` (default ``d``) is what Rough.js redraws."""
        self.parts.append(self._fallback_path(d, stroke, sw, dash, opacity))
        self._add_rough_spec(
            "p",
            [rd or d],
            op=opacity,
            stroke=stroke,
            strokeWidth=round1(sw),
            roughness=1.0,
            bowing=1.0,
            **self._dash_option(dash),
        )

    # --- 2b. Arrows ---------------------------------------------------------------------------
    def head(self, x, y, ang, stroke=INK, sw=2.2, size=11):
        """Arrow head at (x, y) pointing in direction ``ang`` (radians): two short strokes."""
        d = ""
        for sign in (-1, 1):
            a = ang + math.pi + sign * math.radians(27 + self.jitter(4))
            length = size + self.jitter(1.5)
            ex, ey = x + math.cos(a) * length, y + math.sin(a) * length
            d += "M%s %sL%s %s" % (fmt_num(x), fmt_num(y), fmt_num(ex), fmt_num(ey))
            self._add_rough_spec("l", [x, y, ex, ey], stroke=stroke, strokeWidth=round1(sw), roughness=0.55, bowing=0.6)
        self.parts.append(self._fallback_path(d, stroke, sw))

    def arrow(self, pts, stroke=INK, sw=2.2, dash=None, curve=True):
        """pts: list of (x, y); drawn as smooth-ish polyline with arrow head at the end."""
        if len(pts) == 2:
            (x1, y1), (x2, y2) = pts
            self.line(x1, y1, x2, y2, stroke, sw, dash, amp=1.6)
            self.head(x2, y2, math.atan2(y2 - y1, x2 - x1), stroke, sw)
            return
        # Polyline with rounded corners: at each corner, stop ``radius`` before it and curve round.
        d = "M%s %s" % (fmt_num(pts[0][0]), fmt_num(pts[0][1]))
        corner_radius = 12
        for i in range(1, len(pts) - 1):
            p0, p1, p2 = pts[i - 1], pts[i], pts[i + 1]
            len_in = math.hypot(p1[0] - p0[0], p1[1] - p0[1]) or 1
            len_out = math.hypot(p2[0] - p1[0], p2[1] - p1[1]) or 1
            r = min(corner_radius, len_in / 2, len_out / 2)
            a = (p1[0] + (p0[0] - p1[0]) / len_in * r, p1[1] + (p0[1] - p1[1]) / len_in * r)
            b = (p1[0] + (p2[0] - p1[0]) / len_out * r, p1[1] + (p2[1] - p1[1]) / len_out * r)
            d += "L%s %sQ%s %s %s %s" % (
                fmt_num(a[0]),
                fmt_num(a[1]),
                fmt_num(p1[0]),
                fmt_num(p1[1]),
                fmt_num(b[0]),
                fmt_num(b[1]),
            )
        d += "L%s %s" % (fmt_num(pts[-1][0]), fmt_num(pts[-1][1]))
        self.path(d, stroke, sw, dash)
        x2, y2 = pts[-1]
        x1, y1 = pts[-2]
        self.head(x2, y2, math.atan2(y2 - y1, x2 - x1), stroke, sw)

    def bezier_arrow(self, p0, c1, c2, p3, stroke=INK, sw=2.2, dash=None, head=True):
        """Cubic Bezier from p0 to p3 (control points c1, c2), optionally with an arrow head."""
        d = "M%s %sC%s %s %s %s %s %s" % (
            fmt_num(p0[0]),
            fmt_num(p0[1]),
            fmt_num(c1[0]),
            fmt_num(c1[1]),
            fmt_num(c2[0]),
            fmt_num(c2[1]),
            fmt_num(p3[0]),
            fmt_num(p3[1]),
        )
        self.path(d, stroke, sw, dash)
        if head:
            self.head(p3[0], p3[1], math.atan2(p3[1] - c2[1], p3[0] - c2[0]), stroke, sw)

    # --- 2c. Text -----------------------------------------------------------------------------
    def text(self, x, y, s, size, cls, anchor="middle", fill=INK, extra=""):
        """One line of SVG text (escaped). ``cls`` is the font class, e.g. "kb" or "ph"."""
        self.tx.append(
            '<text x="%s" y="%s" font-size="%s" class="%s" text-anchor="%s" fill="%s"%s>%s</text>'
            % (fmt_num(x), fmt_num(y), fmt_num(size), cls, anchor, fill, extra, escape_html(s))
        )

    def label(self, cx, cy, lines, size=15, cls="cv", fill="#2f5f8f", bg=PAPER):
        """Edge label centred on (cx, cy) with paper-coloured backing."""
        line_height = size * 1.05
        w = max(text_width(line, size, "cv") for line in lines) + 8
        h = line_height * len(lines) + 2
        self.parts.append(
            '<rect x="%s" y="%s" width="%s" height="%s" rx="4" fill="%s" opacity=".92"/>'
            % (fmt_num(cx - w / 2), fmt_num(cy - h / 2), fmt_num(w), fmt_num(h), bg)
        )
        self._add_rough_spec(
            "r", [cx - w / 2, cy - h / 2, w, h], op=0.94, fill=bg, fillStyle="solid", stroke="none", roughness=0
        )
        for i, line in enumerate(lines):
            self.text(cx, cy - h / 2 + line_height * (i + 0.8) + 1, line, size, cls, "middle", fill)

    # --- 2d. Output ---------------------------------------------------------------------------
    def out(self) -> str:
        """Diagram markup: python fallback strokes + Rough.js specs + text."""
        rough_specs = "".join("<g class=\"rj\" data-s='%s'/>" % json.dumps(s, separators=(",", ":")) for s in self.rj)
        return '<g class="py">%s</g><g class="rg">%s</g><g class="tx">%s</g>' % (
            "".join(self.parts),
            rough_specs,
            "".join(self.tx),
        )

    def out_plain(self) -> str:
        """Strokes + text only (page furniture that is never redrawn by Rough.js)."""
        return "".join(self.parts) + "".join(self.tx)
