"""Sections, glossary and recap: the "units" that make up the body of the notebook.

What this file does
    A *unit* is a ``<div class="unit">`` holding a flat list of ``item`` divs. notebook.js later
    pours those items into A4 pages. This file builds:
      - ``section_unit``   heading, blocks, diagram, "to remember", recall question, "next ->"
      - ``glossary_unit``  term / definition rows
      - ``recap_unit``     numbered recap points and an optional diagram

How it fits
    ``page_layout.py`` calls these for every part of the notes (the cover is in ``cover.py``).

Read next
    ``cover.py``.
"""

from __future__ import annotations

from .blocks import render_blocks
from .decorations import underline_svg
from .diagrams import diagram_item
from .text import as_dict, as_list, clean_text, escape_html, rich


# ----------------------------------------------------------------------------------------------
# 1. Pieces shared by all units
# ----------------------------------------------------------------------------------------------
def title_size_class(title: str) -> str:
    """CSS class that shrinks long headings: "" (normal), "m" (medium) or "s" (small)."""
    n = len(title)
    return "" if n <= 24 else ("m" if n <= 38 else "s")


def section_heading(num, title: str, subtitle: str, timestamp: str, seed: str) -> str:
    """Section heading item: "N. title — subtitle  ◷ timestamp" with a squiggly underline.

    ``data-keep`` tells notebook.js to keep the heading on the same page as the next item.
    """
    num_text = ("%s. " % escape_html(num)) if num not in (None, "") else ""
    sub = '<span class="sub">— %s</span>' % escape_html(subtitle) if subtitle else ""
    ts = '<span class="ts">◷ %s</span>' % escape_html(timestamp) if timestamp else ""
    return '<div class="item sec-head" data-keep="1"><h2 class="%s">%s%s</h2>%s%s%s</div>' % (
        title_size_class(num_text + title),
        num_text,
        escape_html(title),
        sub,
        ts,
        underline_svg(seed, 690),
    )


def takeaways_item(items) -> str:
    """The "★ to remember" list (max 6 points)."""
    items = [clean_text(i) for i in as_list(items) if clean_text(i)][:6]
    if not items:
        return ""
    lis = "".join("<li>%s</li>" % rich(i) for i in items)
    return (
        '<div class="item take" data-split="1" data-minkeep="1" data-minmove="1"><div class="tt">★ to remember</div>'
        '<ul class="sb">%s</ul></div>' % lis
    )


def recall_item(recall) -> str:
    """The "★ recall question" box (Q + A)."""
    recall = as_dict(recall)
    question, answer = clean_text(recall.get("q")), clean_text(recall.get("a"))
    if not (question or answer):
        return ""
    return (
        '<div class="item recall"><div class="box"><div class="rt">★ recall question</div>'
        '<div class="q">Q: %s</div><div class="a">A: %s</div></div></div>' % (rich(question), rich(answer))
    )


# ----------------------------------------------------------------------------------------------
# 2. Units
# ----------------------------------------------------------------------------------------------
def section_unit(section: dict, index: int) -> str:
    """One lecture section. ``index`` is its position (section numbers default to index + 2,
    because the cover counts as section 1)."""
    section = as_dict(section)
    num = section.get("number")
    if not isinstance(num, (int, float)) or isinstance(num, bool):
        num = clean_text(num) or (index + 2)
    num = int(num) if isinstance(num, float) and num == int(num) else num  # 3.0 -> 3
    title = clean_text(section.get("title")) or "section %s" % num
    items = [
        section_heading(
            num,
            title,
            clean_text(section.get("subtitle")),
            clean_text(section.get("timestamp")),
            "%s|%s" % (num, title),
        )
    ]
    blocks = render_blocks(as_list(section.get("blocks")))
    diagram = diagram_item(section.get("diagram"))
    # Order: heading, first paragraph (the intro), diagram, the remaining blocks.
    first_is_paragraph = blocks and "b-para" in blocks[0][:60]
    if first_is_paragraph:
        items.append(blocks.pop(0))
    if diagram:
        items.append(diagram)
    items.extend(blocks)
    items.append(takeaways_item(section.get("key_takeaways")))
    items.append(recall_item(section.get("recall")))
    next_hint = clean_text(section.get("next"))
    if next_hint:
        items.append(
            '<div class="item nextline" data-next="%s">next → %s</div>'
            % (escape_html(next_hint), escape_html(next_hint))
        )
    return '<div class="unit" data-kind="section" data-num="%s" data-title="%s" data-next="%s">%s</div>' % (
        escape_html(num),
        escape_html(title),
        escape_html(next_hint),
        "".join(x for x in items if x),
    )


def contents_unit(notes: dict, max_on_cover: int) -> str:
    """Full table of contents (number, title, video timestamp) for notes with more than ``max_on_cover`` sections.

    One splittable list, so notebook.js flows it over as many pages as needed and fills in "p. N"."""
    sections = as_list(as_dict(notes).get("sections"))
    if len(sections) <= max_on_cover:
        return ""
    rows = []
    for i, section in enumerate(sections):
        section = as_dict(section)
        num = section.get("number")
        num = clean_text(num) if num not in (None, "") else str(i + 2)
        title = clean_text(section.get("title")) or "section %s" % num
        ts = clean_text(section.get("timestamp"))
        rows.append(
            '<li data-num="%s"><span class="num">%s</span><span class="tt">%s</span>%s<span class="pg"></span></li>'
            % (
                escape_html(num),
                escape_html(num),
                escape_html(title),
                ('<span class="ts">\u25f7 %s</span>' % escape_html(ts)) if ts else "",
            )
        )
    head = section_heading(None, "contents", "%d sections, in lecture order" % len(sections), "", "contents")
    body = (
        '<div class="item blk toc-list" data-split="1" data-minkeep="3" data-minmove="3">'
        '<ol class="sb">%s</ol></div>' % "".join(rows)
    )
    return '<div class="unit" data-kind="contents" data-num="" data-title="contents">%s%s</div>' % (head, body)


def glossary_unit(glossary) -> str:
    rows = []
    for entry in as_list(glossary):
        if not isinstance(entry, dict):
            continue
        term, definition = clean_text(entry.get("term")), clean_text(entry.get("definition"))
        if term or definition:
            rows.append(
                '<div class="item gl-row"><span class="t">%s</span><span class="d">%s</span></div>'
                % (rich(term), rich(definition))
            )
    if not rows:
        return ""
    heading = section_heading(None, "glossary", "words worth knowing", "", "glossary")
    return '<div class="unit" data-kind="glossary" data-num="" data-title="glossary">%s%s</div>' % (
        heading,
        "".join(rows),
    )


def recap_unit(recap) -> str:
    recap = as_dict(recap)
    points = [clean_text(p) for p in as_list(recap.get("points")) if clean_text(p)]
    diagram = diagram_item(recap.get("diagram"))
    if not points and not diagram:
        return ""
    title = clean_text(recap.get("title")) or "the whole picture, recapped"
    items = [section_heading(None, title, "", "", "recap|" + title)]
    if points:
        lis = "".join('<li><span class="num">%d</span>%s</li>' % (n, rich(p)) for n, p in enumerate(points, 1))
        items.append(
            '<div class="item blk recap-pts" data-split="1" data-minkeep="2" data-minmove="2">'
            '<ol class="sb" style="list-style:none;margin:0;padding:0">%s</ol></div>' % lis
        )
    if diagram:
        items.append(diagram)
    return '<div class="unit" data-kind="recap" data-num="" data-title="%s">%s</div>' % (
        escape_html(title),
        "".join(items),
    )
