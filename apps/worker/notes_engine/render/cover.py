"""The cover page: title, tagline, a small diagram, table of contents and a side panel.

What this file does
    ``cover_unit`` builds the whole first page as one fixed ``<div class="page cover">``
    (the cover is never split by notebook.js).

How it fits
    Called first by ``page_layout.build_document``.

Read next
    ``page_layout.py``.
"""

from __future__ import annotations

import datetime as _dt

from .decorations import cover_border_svg, rings_svg, underline_svg
from .diagrams import build_diagram_svg, clean_diagram
from .text import as_dict, as_list, clean_text, escape_html, truncate, truncate_sentences

# more sections than this -> the cover lists 17 + "and N more", and a contents unit follows (sections.py)
COVER_TOC_MAX = 18

# Used when no section has a diagram that suits the cover.
FALLBACK_COVER_DIAGRAM = {
    "type": "flow",
    "title": "",
    "caption": "",
    "nodes": [
        {"id": "a", "label": "the lecture", "detail": ""},
        {"id": "b", "label": "these notes", "detail": ""},
        {"id": "c", "label": "recall & revise", "detail": ""},
    ],
    "edges": [{"from": "a", "to": "b", "label": ""}, {"from": "b", "to": "c", "label": ""}],
}


def format_month_year(date_text: str) -> str:
    """ "2026-11-12" -> "Nov 2026"; anything else is returned unchanged."""
    try:
        d = _dt.datetime.strptime(date_text[:10], "%Y-%m-%d")
        return d.strftime("%b %Y")
    except Exception:
        return date_text


def cover_title_size(title: str) -> int:
    """Font size (px) for the cover title: shorter titles are drawn bigger."""
    n = len(title)
    return 80 if n <= 14 else 68 if n <= 20 else 58 if n <= 28 else 48 if n <= 40 else 40 if n <= 60 else 33


def _cover_diagram(notes: dict) -> dict:
    """First section diagram that looks good small (not stack/sequence/mindmap), else the fallback.

    Details are shortened and the title removed so it fits the cover.
    """
    chosen = None
    for section in as_list(notes.get("sections")):
        d = clean_diagram(as_dict(section).get("diagram"))
        if d and d["type"] not in ("stack", "sequence", "mindmap"):
            chosen = d
            break
    if chosen is None:
        chosen = FALLBACK_COVER_DIAGRAM
    return {**chosen, "nodes": [{**nd, "detail": truncate(nd["detail"], 38)} for nd in chosen["nodes"]], "title": ""}


def cover_unit(notes: dict, title: str) -> str:
    meta, cover = as_dict(notes.get("meta")), as_dict(notes.get("cover"))
    tagline = clean_text(cover.get("tagline")) or "a student's own field notebook —"
    subtitle = clean_text(meta.get("subtitle"))
    title_px = cover_title_size(title)
    duration = clean_text(meta.get("duration"))
    info = " · ".join(
        x
        for x in [
            clean_text(meta.get("channel")),
            ("%s lecture" % duration) if duration else "",
            clean_text(meta.get("language")),
        ]
        if x
    )

    # --- diagram
    dg = _cover_diagram(notes)
    result = build_diagram_svg(dg, 600.0, "d")
    diagram_svg = result[0] if result else ""
    diagram_caption = '<div class="cap">%s</div>' % escape_html(dg["caption"]) if dg.get("caption") else ""

    # --- table of contents (from the cover data, else from the section titles)
    n_sections = len(as_list(notes.get("sections")))
    long_notes = n_sections > COVER_TOC_MAX
    toc = [clean_text(t) for t in as_list(cover.get("toc")) if clean_text(t)][:24]
    if not toc or long_notes:
        toc = [
            "%s. %s" % (as_dict(s).get("number", i + 2), clean_text(as_dict(s).get("title")))
            for i, s in enumerate(as_list(notes.get("sections"))[:24])
        ]
    if long_notes:  # a 24 h lecture has 40-80 sections: the full list gets its own pages
        toc = toc[: COVER_TOC_MAX - 1] + [
            "\u2026 and %d more \u2014 full contents on the next page" % (n_sections - (COVER_TOC_MAX - 1))
        ]
    toc_class = "" if len(toc) <= 11 else ("two" if len(toc) <= 18 else "two many")  # long lists -> two columns
    toc_html = "".join("<li>%s</li>" % escape_html(t) for t in toc)
    toc_title = "what's inside — read top to bottom"

    # --- side panel: big idea sticky note + key takeaways (or the "how to use" box and summary)
    idea = clean_text(cover.get("big_idea"))
    summary_text = clean_text(cover.get("summary"))
    sticky = '<div class="cv-idea">%s</div>' % escape_html(truncate(idea, 90)) if idea else ""
    howto = (
        '<div class="cv-how"><div class="rt">★ recall question</div><div class="q">Q: How do I use this book?</div>'
        "A: After each page, close it and explain it out loud in 30 "
        "seconds. Every section ends with one recall question.</div>"
    )
    summary = (
        '<div class="cv-sum">%s</div>' % escape_html(truncate_sentences(summary_text, 200)) if summary_text else ""
    )
    date = format_month_year(clean_text(meta.get("generated_on")))
    date_html = '<div class="cv-date">— field notes%s</div>' % (", " + escape_html(date) if date else "")
    keys = [clean_text(t) for t in as_list(cover.get("takeaways")) if clean_text(t)][:6]
    keys_html = (
        (
            '<div class="cv-keys"><div class="rt">★ key takeaways</div><ol>%s</ol></div>'
            % "".join("<li>%s</li>" % escape_html(truncate(k, 220)) for k in keys)
        )
        if keys
        else ""
    )

    body = (
        '<div class="page cover">' + rings_svg() + '%s<div class="cv-in">'
        '<div class="cv-tag">%s</div><div class="cv-title" style="font-size:%dpx">%s</div>%s'
        "%s%s"
        '<div class="cv-dgm">%s%s</div>'
        '<div class="cv-low"><div><h3>%s</h3><ul class="cv-toc %s">%s</ul></div><div class="cv-side">%s%s%s</div></div>'
        "</div>%s</div>"
    ) % (
        cover_border_svg(),
        escape_html(tagline),
        title_px,
        escape_html(title),
        underline_svg("cover-title", 600, 4.2).replace('class="ul"', 'class="cv-ul"'),
        ('<div class="cv-sub">%s</div>' % escape_html(truncate(subtitle, 140))) if subtitle else "",
        ('<div class="cv-info">%s</div>' % escape_html(info)) if info else "",
        diagram_svg,
        diagram_caption,
        escape_html(toc_title),
        toc_class,
        toc_html,
        sticky,
        keys_html or howto,
        "" if keys_html else summary,
        date_html,
    )
    return '<div class="unit" data-kind="cover">%s</div>' % body
