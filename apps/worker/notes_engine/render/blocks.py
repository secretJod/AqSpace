"""Content blocks: paragraphs, bullets, steps, definitions, examples, callouts, code, tables, formulas.

What this file does
    One small function per block type turns a block dict into one notebook "item" (a ``<div>``).
    ``render_blocks`` walks a section's block list and calls the right one.

The data-* attributes are read by templates/notebook.js when it splits content across pages:
    data-split="1"   the item may be split across pages (its ``.sb`` children are the pieces)
    data-minkeep=N   keep at least N pieces on the first page
    data-minmove=N   move at least N pieces to the next page

How it fits
    ``sections.py`` calls ``render_blocks`` for every section.

Read next
    ``sections.py``.
"""

from __future__ import annotations

import re

from .text import as_list, clean_text, escape_html, plain, rich

# ----------------------------------------------------------------------------------------------
# 1. Paragraphs (long ones are split into sentences so pagination can break between them)
# ----------------------------------------------------------------------------------------------
SENTENCE_BREAK = re.compile(r"(?<=[.!?。])\s+(?=[A-Z“\"'(\[0-9])")


def split_sentences(text: str) -> list[str]:
    """Split text into sentences, never inside an open **bold** or `code` span."""
    parts = SENTENCE_BREAK.split(text)
    sentences: list[str] = []
    buffer = ""
    for part in parts:
        buffer = (buffer + " " + part).strip() if buffer else part
        if buffer.count("**") % 2 == 0 and buffer.count("`") % 2 == 0:  # markup is balanced
            sentences.append(buffer)
            buffer = ""
    if buffer:
        sentences.append(buffer)
    return sentences


def paragraph_block(block) -> str:
    text = clean_text(block.get("text"))
    if not text:
        return ""
    sentences = split_sentences(text) if len(text) > 180 else [text]
    spans = "".join('<span class="s">%s </span>' % rich(s) for s in sentences)
    return (
        '<div class="item blk b-para" data-split="1" data-minkeep="2" data-minmove="2"><p class="sb para">%s</p></div>'
        % spans
    )


# ----------------------------------------------------------------------------------------------
# 2. Lists
# ----------------------------------------------------------------------------------------------
def bullets_block(block) -> str:
    items = [clean_text(i) for i in as_list(block.get("items")) if clean_text(i)]
    if not items:
        return ""
    lis = "".join("<li>%s</li>" % rich(i) for i in items)
    # many short bullets -> two columns
    cols = " cols2" if len(items) >= 4 and max(len(plain(i)) for i in items) <= 48 else ""
    return (
        '<div class="item blk b-bullets'
        + cols
        + '" data-split="1" data-minkeep="2" data-minmove="2"><ul class="sb">%s</ul></div>' % lis
    )


def steps_block(block) -> str:
    items = [clean_text(i) for i in as_list(block.get("items")) if clean_text(i)]
    if not items:
        return ""
    lis = "".join('<li><span class="num">%d</span>%s</li>' % (n, rich(i)) for n, i in enumerate(items, 1))
    return (
        '<div class="item blk b-steps" data-split="1" data-minkeep="2" data-minmove="2"><ol class="sb">%s</ol></div>'
        % lis
    )


# ----------------------------------------------------------------------------------------------
# 3. Boxes: definition, example, callout, formula
# ----------------------------------------------------------------------------------------------
def definition_block(block) -> str:
    term, text = clean_text(block.get("term")), clean_text(block.get("text"))
    if not (term or text):
        return ""
    return (
        '<div class="item blk b-def"><div class="box"><span '
        'class="tag">def.</span><span class="term">%s</span> — %s</div></div>' % (escape_html(term), rich(text))
    )


def example_block(block) -> str:
    title, text = clean_text(block.get("title")), clean_text(block.get("text"))
    if not (title or text):
        return ""
    heading = '<span class="ex-t">e.g. %s</span>' % escape_html(title) if title else '<span class="ex-t">e.g.</span>'
    return '<div class="item blk b-ex"><div class="box">%s%s</div></div>' % (heading, rich(text))


CALLOUT_LABELS = {"note": "note to self", "warning": "watch out!", "tip": "pro tip"}


def callout_block(block, callout_number: int) -> str:
    """A sticky-note callout. ``callout_number`` alternates the tilt (classes t1 / t2)."""
    text = clean_text(block.get("text"))
    if not text:
        return ""
    style = clean_text(block.get("style")).lower()
    if style not in CALLOUT_LABELS:
        style = "note"
    return (
        '<div class="item blk b-call %s t%d"><div class="box"><span '
        'class="lbl">%s</span><span class="tx">%s</span></div></div>'
        % (style, 1 + callout_number % 2, escape_html(CALLOUT_LABELS[style]), rich(text))
    )


def formula_block(block) -> str:
    text = clean_text(block.get("text"))
    if not text:
        return ""
    return '<div class="item blk b-formula"><div class="box">%s</div></div>' % escape_html(text)


# ----------------------------------------------------------------------------------------------
# 4. Code and tables
# ----------------------------------------------------------------------------------------------
def code_block(block) -> str:
    """Code listing, one ``<div class="ln">`` per line (max 160 lines of max 400 characters)."""
    raw = block.get("code") if block.get("code") is not None else ""
    code = str(raw).replace("\r\n", "\n").replace("\r", "\n").expandtabs(4).strip("\n")
    if not code.strip():
        return ""
    lines = code.split("\n")[:160]
    lines = [line if len(line) <= 400 else line[:399] + "…" for line in lines]
    language = clean_text(block.get("language"))[:24]
    body = "".join('<div class="ln">%s</div>' % (escape_html(line) if line.strip() else "&nbsp;") for line in lines)
    tag = '<span class="lang">%s</span>' % escape_html(language) if language else ""
    return (
        '<div class="item blk b-code" data-split="1" data-minkeep="4" '
        'data-minmove="3"><div class="box">%s<div class="sb">%s</div></div></div>' % (tag, body)
    )


def table_block(block) -> str:
    """Table (max 60 rows); short rows are padded so every row has the same number of cells."""
    headers = [clean_text(h) for h in as_list(block.get("headers"))]
    rows = [r for r in as_list(block.get("rows")) if isinstance(r, list)][:60]
    ncol = max([len(headers)] + [len(r) for r in rows] + [1])
    if not headers and not rows:
        return ""
    headers = (headers + [""] * ncol)[:ncol]
    thead = "<thead><tr>%s</tr></thead>" % "".join("<th>%s</th>" % rich(h) for h in headers) if any(headers) else ""
    trs = ""
    for row in rows:
        cells = ([clean_text(c) for c in row] + [""] * ncol)[:ncol]
        trs += "<tr>%s</tr>" % "".join("<td>%s</td>" % rich(c) for c in cells)
    return (
        '<div class="item blk b-table" data-split="1" data-minkeep="3" '
        'data-minmove="2"><table>%s<tbody class="sb">%s</tbody></table></div>' % (thead, trs)
    )


# ----------------------------------------------------------------------------------------------
# 5. Unknown blocks and the dispatcher
# ----------------------------------------------------------------------------------------------
def unknown_block(block) -> str:
    """Block types this renderer does not know yet: show any text / items instead of dropping them."""
    if as_list(block.get("items")):
        return bullets_block(block)
    parts = [
        clean_text(block.get(k))
        for k in ("title", "term", "text", "content", "body", "definition")
        if clean_text(block.get(k))
    ]
    if not parts:
        return ""
    if len(parts) > 1:
        return paragraph_block({"text": "**%s** — %s" % (parts[0], " ".join(parts[1:]))})
    return paragraph_block({"text": parts[0]})


BLOCK_RENDERERS = {
    "paragraph": paragraph_block,
    "bullets": bullets_block,
    "steps": steps_block,
    "definition": definition_block,
    "example": example_block,
    "code": code_block,
    "table": table_block,
    "formula": formula_block,
}


def render_blocks(blocks: list) -> list[str]:
    """Render every block dict in order; empty blocks are skipped. Returns a list of HTML items."""
    rendered, callout_count = [], 0
    for block in blocks:
        if not isinstance(block, dict):
            continue
        typ = clean_text(block.get("type")).lower()
        if typ == "callout":  # callouts need a running number (their tilt alternates)
            html = callout_block(block, callout_count)
            callout_count += 1
        else:
            html = BLOCK_RENDERERS.get(typ, unknown_block)(block)
        if html:
            rendered.append(html)
    return rendered
