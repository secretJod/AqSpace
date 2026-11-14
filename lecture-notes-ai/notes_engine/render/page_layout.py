"""Assembling the complete, self-contained notebook HTML document.

What this file does
    ``build_document`` puts everything together: cover, sections, glossary, recap, the CSS,
    the embedded fonts, Rough.js and notebook.js, all inside ONE html string (no external
    files, so it works offline and in the headless browser).

    The units go into ``<div id="source">``. In the browser, templates/notebook.js then
    measures them and pours their items into fixed A4 page boxes inside ``<div id="pages">``
    (splitting long lists/tables/code, keeping headings with their first block, adding the
    rings, footer and "pg. N / M" to every page).

How it fits
    ``render_html`` here is the public entry point; ``pdf_export.render_pdf`` calls
    ``build_document(notes, for_print=True)``.

Read next
    ``pdf_export.py``, then templates/notebook.js.
"""
from __future__ import annotations

from functools import lru_cache

from .cover import COVER_TOC_MAX, cover_unit
from .decorations import rings_svg
from .fonts import font_face_css
from .paths import TEMPLATE_DIR
from .sections import contents_unit, glossary_unit, recap_unit, section_unit
from .text import as_dict, as_list, clean_text, escape_html


@lru_cache(maxsize=1)
def rough_js_source() -> str:
    """Rough.js (MIT, templates/vendor/rough.js), inlined so previews and PDFs work offline.

    Returns "" when the file is missing; diagrams then keep their plain-SVG strokes."""
    try:
        source = (TEMPLATE_DIR / "vendor" / "rough.js").read_text(encoding="utf-8")
    except OSError:
        return ""
    return source.replace("</script", "<\\/script")  # must not close our <script> tag early


# The page skeleton. Placeholders, in order: language, print flag (1/0), title (data attribute),
# title (<title>), font CSS, notebook.css, rings template, the units, Rough.js tag, notebook.js.
HTML_SKELETON = (
    '<!DOCTYPE html>\n<html lang="%s" data-print="%s" data-doc-title="%s">\n<head>\n<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>%s — notebook</title>\n'
    '<style>%s</style>\n<style>%s</style>\n</head>\n<body>\n'
    '<template id="rings-tpl">%s</template>\n<div id="source">%s</div>\n<div id="pages"></div>\n%s<script>%s</script>\n</body>\n</html>\n'
)


def build_document(notes: dict, for_print: bool, rough_source: str | None = None) -> str:
    """Build the full HTML. ``for_print`` sets ``data-print="1"`` (used for the PDF).

    ``rough_source`` overrides the inlined Rough.js ("" = leave it out); by default the vendored
    file is used. notes_engine/pdf.py passes it so tests can switch Rough.js off.
    """
    notes = as_dict(notes)
    meta = as_dict(notes.get("meta"))
    title = clean_text(meta.get("title")) or "Lecture notes"

    # 1. The content units, in reading order
    units = [cover_unit(notes, title), contents_unit(notes, COVER_TOC_MAX)]
    for index, section in enumerate(as_list(notes.get("sections"))):
        units.append(section_unit(section, index))
    units.append(glossary_unit(notes.get("glossary")))
    units.append(recap_unit(notes.get("recap")))

    # 2. Styles and scripts (read fresh each time, so template edits show up without a restart)
    css = (TEMPLATE_DIR / "notebook.css").read_text(encoding="utf-8")
    js = (TEMPLATE_DIR / "notebook.js").read_text(encoding="utf-8")
    rough = rough_js_source() if rough_source is None else rough_source
    rough_tag = ("<script>%s</script>\n" % rough) if rough else ""

    # 3. Fill the skeleton
    return HTML_SKELETON % (
        escape_html(clean_text(meta.get("language")) or "en"), "1" if for_print else "0", escape_html(title), escape_html(title),
        font_face_css(), css, rings_svg(), "".join(u for u in units if u), rough_tag, js)


def render_html(notes: dict, *, for_print: bool = False, rough_source: str | None = None) -> str:
    """Full self-contained HTML (fonts embedded as base64). Pagination runs in the browser."""
    return build_document(notes, for_print, rough_source)
