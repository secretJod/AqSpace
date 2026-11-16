"""Diagrams: turn a diagram dict from the notes into a hand-drawn SVG.

What this file does
    1. ``clean_diagram`` validates the AI's diagram (type, nodes, edges) and trims it to sizes
       that fit on a page.
    2. One layout+draw function per diagram type computes every position in Python
       (deterministic; text is measured with the real fonts so nothing overflows) and draws
       with a ``Sketch``:
         flow, stack, compare, cycle, tree, timeline, mindmap, sequence
    3. ``build_diagram_svg`` picks the right function and wraps the result in ``<svg>``;
       ``diagram_item`` wraps that in the notebook's ``<div class="item dgm">``.

    Each drawing function has the same shape:  (cleaned_diagram, width) -> (svg_inner, width, height)

How it fits
    ``sections.py`` and ``cover.py`` call ``diagram_item`` / ``build_diagram_svg``.

Read next
    ``blocks.py`` (the non-diagram content).
"""

from __future__ import annotations

import math
import re

from .fonts import text_width, wrap_text
from .sketch import CARD, INK, TINTS, Sketch
from .text import as_list, clean_text, escape_html, fmt_num, stable_seed, truncate

# ----------------------------------------------------------------------------------------------
# 1. Limits and text sizes
# ----------------------------------------------------------------------------------------------
MAX_NODES = 8
MAX_NODES_BY_TYPE = {"mindmap": 10, "sequence": 5}
MAX_SEQ_MESSAGES = 8
DIAGRAM_TYPES = ("flow", "stack", "compare", "cycle", "tree", "timeline", "mindmap", "sequence")
LABEL_SIZE, LABEL_LINE_HEIGHT = 16.5, 19.5  # node titles (Kalam Bold)
DETAIL_SIZE, DETAIL_LINE_HEIGHT = 13.6, 16.2  # node details (Patrick Hand)


# ----------------------------------------------------------------------------------------------
# 2. Cleaning the input
# ----------------------------------------------------------------------------------------------
def clean_diagram(diagram: object) -> dict | None:
    """Validate a diagram dict. Returns a clean copy, or ``None`` if there is nothing to draw.

    Unknown types become "flow"; node ids are made unique; edges must point at known nodes.
    """
    if not isinstance(diagram, dict):
        return None
    typ = clean_text(diagram.get("type")).lower()
    if typ not in DIAGRAM_TYPES:
        typ = "flow"
    nodes, seen_ids = [], set()
    for i, node in enumerate(as_list(diagram.get("nodes"))[: MAX_NODES_BY_TYPE.get(typ, MAX_NODES)]):
        if isinstance(node, str):
            node = {"label": node}
        if not isinstance(node, dict):
            continue
        label = truncate(node.get("label", ""), 60)
        if not label:
            continue
        node_id = clean_text(node.get("id")) or "n%d" % i
        if node_id in seen_ids:
            node_id = "%s_%d" % (node_id, i)
        seen_ids.add(node_id)
        nodes.append(
            {
                "id": node_id,
                "label": label,
                "detail": truncate(node.get("detail", ""), 140),
                "parent": clean_text(node.get("parent")),
            }
        )
    if not nodes:
        return None
    if typ == "sequence" and len(nodes) < 2:  # a lifeline diagram needs at least two actors
        typ = "flow"
    ids = {n["id"] for n in nodes}
    edges, seen_pairs = [], set()
    for edge in as_list(diagram.get("edges")):
        if not isinstance(edge, dict):
            continue
        a, b = clean_text(edge.get("from")), clean_text(edge.get("to"))
        if typ == "sequence":  # ordered messages: repeats and self-calls are meaningful
            if a in ids and b in ids and len(edges) < MAX_SEQ_MESSAGES:
                edges.append({"from": a, "to": b, "label": truncate(edge.get("label", ""), 40)})
        elif a in ids and b in ids and a != b and (a, b) not in seen_pairs:
            seen_pairs.add((a, b))
            edges.append({"from": a, "to": b, "label": truncate(edge.get("label", ""), 28)})
    return {
        "type": typ,
        "title": truncate(diagram.get("title", ""), 80),
        "caption": truncate(diagram.get("caption", ""), 200),
        "nodes": nodes,
        "edges": edges,
    }


# ----------------------------------------------------------------------------------------------
# 3. Shared drawing helpers
# ----------------------------------------------------------------------------------------------
def _node_box(node: dict, box_width: float, center=True, max_label=2, max_det=3, pad=10) -> dict:
    """Wrap a node's label/detail for a box of ``box_width``; returns lines and the needed height."""
    inner_width = box_width - 2 * pad
    label_lines = wrap_text(node["label"], inner_width, LABEL_SIZE, "kb", max_label)
    detail_lines = wrap_text(node["detail"], inner_width, DETAIL_SIZE, "ph", max_det) if node["detail"] else []
    h = (
        pad
        + len(label_lines) * LABEL_LINE_HEIGHT
        + (len(detail_lines) * DETAIL_LINE_HEIGHT + 3 if detail_lines else 0)
        + pad
        - 1
    )
    return {"ll": label_lines, "dl": detail_lines, "h": max(h, 40)}


def _draw_node(sk: Sketch, node: dict, x, y, w, h, tint=0, shadow=False):
    """Draw a node box (colour set ``tint``) with its pre-wrapped ``_ll`` / ``_dl`` lines."""
    fill, stroke, hl = TINTS[tint % len(TINTS)]
    sk.rect(x, y, w, h, fill=fill, stroke=stroke, shadow=shadow, hl=hl)
    ty = y + 10 + LABEL_LINE_HEIGHT * 0.78
    for line in node["_ll"]:
        sk.text(x + w / 2, ty, line, LABEL_SIZE, "kb", "middle", INK)
        ty += LABEL_LINE_HEIGHT
    if node["_dl"]:
        ty += 1
        for line in node["_dl"]:
            sk.text(x + w / 2, ty, line, DETAIL_SIZE, "ph", "middle", "#3d362f")
            ty += DETAIL_LINE_HEIGHT


def _label_lines(text: str, max_width: float) -> list[str]:
    """Wrap an edge label (Caveat 15px, at most 3 lines); empty label -> no lines."""
    return wrap_text(text, max_width, 15, "cv", 3) if text else []


def _intersect_rect(cx, cy, w, h, tx, ty, pad=5):
    """Point where the ray from rect centre to (tx,ty) leaves the (padded) rect."""
    dx, dy = tx - cx, ty - cy
    if dx == 0 and dy == 0:
        return cx, cy
    hw, hh = w / 2 + pad, h / 2 + pad
    s = min(hw / abs(dx) if dx else 1e9, hh / abs(dy) if dy else 1e9)
    return cx + dx * s, cy + dy * s


def _text_box(sk: Sketch, ll, dl, cx, y, pad, lsize, llh, dsize, dlh, lcls="kb", color=INK):
    """Draw wrapped label (+ optional detail) lines centred on cx starting at the top edge y."""
    ty = y + pad + llh * 0.78
    for line in ll:
        sk.text(cx, ty, line, lsize, lcls, "middle", color)
        ty += llh
    if dl:
        ty += 1
        for line in dl:
            sk.text(cx, ty, line, dsize, "ph", "middle", "#3d362f")
            ty += dlh


# ----------------------------------------------------------------------------------------------
# 4. Flow (layered left-to-right graph, "snaking" onto more rows when it is too wide)
# ----------------------------------------------------------------------------------------------
def _layout_flow(dg: dict, W: float):
    """Compute positions for a flow diagram. Returns a dict with node geometry and edge groups.

    Steps: (a) put each node in a layer (longest path), (b) order nodes inside a layer,
    (c) pick how many layers fit per row, (d) compute x/y of every box.
    """
    nodes, edges = dg["nodes"], list(dg["edges"])
    n = len(nodes)
    idx = {nd["id"]: i for i, nd in enumerate(nodes)}
    if not edges:  # no edges given: chain the nodes in order
        edges = [{"from": nodes[i]["id"], "to": nodes[i + 1]["id"], "label": ""} for i in range(n - 1)]
    # (a) longest-path layering; edges that point backwards are drawn as arcs
    layer = [0] * n
    for _ in range(n):
        changed = False
        for ed in edges:
            a, b = idx[ed["from"]], idx[ed["to"]]
            if layer[b] < layer[a] + 1 and layer[a] + 1 < n:
                layer[b] = layer[a] + 1
                changed = True
        if not changed:
            break
    fwd, back = [], []
    for ed in edges:
        (fwd if layer[idx[ed["to"]]] > layer[idx[ed["from"]]] else back).append(ed)
    # compact empty layers
    used = sorted(set(layer))
    remap = {old: new for new, old in enumerate(used)}
    layer = [remap[old] for old in layer]
    nl = len(used)
    groups = [[] for _ in range(nl)]
    for i in range(n):
        groups[layer[i]].append(i)
    # (b) order inside layer by mean index of predecessors (stable barycentre)
    pos = {}
    for li in range(nl):
        if li > 0:

            def key(i):
                preds = [pos[idx[ed["from"]]] for ed in fwd if idx[ed["to"]] == i and idx[ed["from"]] in pos]
                return (sum(preds) / len(preds)) if preds else i

            groups[li].sort(key=key)
        for k, i in enumerate(groups[li]):
            pos[i] = k - (len(groups[li]) - 1) / 2.0

    # gap between consecutive layers (room for edge labels)
    def gap_after(li):
        labels = [
            ed["label"] for ed in fwd if ed["label"] and layer[idx[ed["from"]]] == li and layer[idx[ed["to"]]] == li + 1
        ]
        if not labels:
            return 46
        one_line_width = max(sum(text_width(w, 15, "cv") for w in [lab]) for lab in labels)
        wrapped_width = max(max((text_width(x, 15, "cv") for x in _label_lines(lab, 80)), default=0) for lab in labels)
        return max(46, min(one_line_width, max(wrapped_width, 60)) + 22)

    gaps = [gap_after(li) for li in range(max(nl - 1, 0))]
    MARGIN = 0
    # (c) choose layers per row: as many as possible while boxes stay at least 118px wide
    best = None
    for k in range(nl, 0, -1):
        rows = math.ceil(nl / k)
        side = 34 if rows > 1 else MARGIN
        worst = 0
        for r in range(rows):
            ls = list(range(r * k, min((r + 1) * k, nl)))
            worst = max(worst, sum(gaps[li] for li in ls[:-1]))
        bw = min(196, (W - 2 * side - worst) / k)
        if bw >= 118 or k == 1:
            best = (k, rows, side, bw)
            break
    k, rows, side, bw = best
    bw = max(bw, 110)
    for nd in nodes:
        nd["_box"] = _node_box(nd, bw, max_label=2, max_det=3)
        nd["_ll"], nd["_dl"] = nd["_box"]["ll"], nd["_box"]["dl"]
    bh = max(nd["_box"]["h"] for nd in nodes)
    vgap = 22
    # (d) row geometry: how many boxes are stacked in the tallest layer of each row
    row_stack = []
    for r in range(rows):
        ls = range(r * k, min((r + 1) * k, nl))
        row_stack.append(max(len(groups[li]) for li in ls))

    # "skip" edges jump over a layer in the same row and are routed above the row
    def is_skip(ed):
        return (
            layer[idx[ed["to"]]] - layer[idx[ed["from"]]] > 1
            and layer[idx[ed["to"]]] // k == layer[idx[ed["from"]]] // k
        )

    skips = [ed for ed in fwd if is_skip(ed)]
    cross = [ed for ed in fwd if layer[idx[ed["to"]]] // k != layer[idx[ed["from"]]] // k]
    top = 10 + (12 * len(skips) + 8 if skips else 0)
    rowgap = 58 + (10 * len(cross))
    row_y, y = [], top
    for r in range(rows):
        row_y.append(y)
        y += row_stack[r] * bh + (row_stack[r] - 1) * vgap + rowgap
    H = y - rowgap + 14 + (24 if back else 0)
    # x of each layer
    layer_x = {}
    for r in range(rows):
        ls = list(range(r * k, min((r + 1) * k, nl)))
        total = len(ls) * bw + sum(gaps[li] for li in ls[:-1])
        x0 = side + (W - 2 * side - total) / 2
        xs, x = {}, x0
        for li in ls:
            xs[li] = x
            x += bw + (gaps[li] if li < nl - 1 else 0)
        if r % 2 == 1:  # snake: odd rows run right-to-left
            for li in ls:
                xs[li] = W - xs[li] - bw
        layer_x.update(xs)
    geo = {}
    for li in range(nl):
        r = li // k
        stack = len(groups[li])
        block = stack * bh + (stack - 1) * vgap
        rowh = row_stack[r] * bh + (row_stack[r] - 1) * vgap
        y0 = row_y[r] + (rowh - block) / 2
        for si, i in enumerate(groups[li]):
            geo[i] = (layer_x[li], y0 + si * (bh + vgap), bw, bh)
    return dict(
        nodes=nodes,
        edges=edges,
        fwd=fwd,
        back=back,
        geo=geo,
        layer=layer,
        idx=idx,
        k=k,
        rows=rows,
        W=W,
        H=H,
        skips=skips,
        row_y=row_y,
        bh=bh,
        groups=groups,
        cross=cross,
        row_stack=row_stack,
        vgap=vgap,
        rowgap=rowgap,
    )


def _svg_flow(dg: dict, W: float) -> tuple[str, float, float]:
    """Draw a flow diagram from ``_layout_flow``'s geometry."""
    L = _layout_flow(dg, W)
    sk = Sketch(stable_seed("flow", dg["title"], *[n["label"] for n in dg["nodes"]]))
    geo, idx, layer, k = L["geo"], L["idx"], L["layer"], L["k"]
    for i, nd in enumerate(L["nodes"]):
        x, y, w, h = geo[i]
        _draw_node(sk, nd, x, y, w, h, tint=(4, 2, 3, 1)[layer[i] % 4], shadow=False)
    skip_i = 0
    cross_i = 0
    for ed in L["fwd"]:
        a, b = idx[ed["from"]], idx[ed["to"]]
        ax, ay, aw, ah = geo[a]
        bx, by, bw_, bh_ = geo[b]
        la, lb = layer[a], layer[b]
        ra, rb = la // k, lb // k  # row of each end
        lab = _label_lines(ed["label"], 80)
        if ra == rb and lb == la + 1:  # neighbours in the same row: straight arrow
            fwd_dir = bx > ax
            p0 = (ax + aw + 3, ay + ah / 2) if fwd_dir else (ax - 3, ay + ah / 2)
            p3 = (bx - 6, by + bh_ / 2) if fwd_dir else (bx + bw_ + 6, by + bh_ / 2)
            sk.arrow([p0, p3])
            if lab:
                sk.label((p0[0] + p3[0]) / 2, (p0[1] + p3[1]) / 2 - 12 - (len(lab) - 1) * 6, lab)
        elif ra == rb:  # skip edge in same row: over the top
            gy = L["row_y"][ra] - 10 - 12 * skip_i
            skip_i += 1
            p0 = (ax + aw / 2, ay - 3)
            p3 = (bx + bw_ / 2, by - 7)
            sk.arrow([p0, (p0[0], gy), (p3[0], gy), p3])
            if lab:
                sk.label((p0[0] + p3[0]) / 2, gy, lab)
        else:  # crosses to the next row: via the channel between rows
            chan = (
                L["row_y"][ra] + L["row_stack"][ra] * L["bh"] + (L["row_stack"][ra] - 1) * L["vgap"] + 24 + 10 * cross_i
            )
            cross_i += 1
            p0 = (ax + aw / 2, ay + ah + 3)
            p3 = (bx + bw_ / 2, by - 7)
            if abs(p0[0] - p3[0]) < 2:
                sk.arrow([p0, p3])
            else:
                sk.arrow([p0, (p0[0], chan), (p3[0], chan), p3])
            if lab:
                sk.label(
                    p0[0] + 8 + max(text_width(x, 15, "cv") for x in lab) / 2,
                    chan if abs(p0[0] - p3[0]) >= 2 else (p0[1] + p3[1]) / 2,
                    lab,
                )
    for ed in L["back"]:  # backward edges: dashed arcs underneath
        a, b = idx[ed["from"]], idx[ed["to"]]
        ax, ay, aw, ah = geo[a]
        bx, by, bw_, bh_ = geo[b]
        yb = L["H"] - 6
        sk.bezier_arrow(
            (ax + aw / 2, ay + ah + 3),
            (ax + aw / 2, yb + 10),
            (bx + bw_ / 2, yb + 10),
            (bx + bw_ / 2, by + bh_ + 7),
            dash="6 5",
        )
    return sk.out(), W, L["H"]


# ----------------------------------------------------------------------------------------------
# 5. Stack (numbered layers inside one big frame, arrows going down)
# ----------------------------------------------------------------------------------------------
def _svg_stack(dg: dict, W: float) -> tuple[str, float, float]:
    sk = Sketch(stable_seed("stack", dg["title"], *[n["label"] for n in dg["nodes"]]))
    nodes = dg["nodes"]
    frame_x, frame_w = 4, W - 8
    inner_x, inner_w = 24, W - 48
    text_pad = 16
    y = 12
    title_h = 0
    if dg["title"]:
        title_h = 36
    y0 = y + title_h + 10
    heights, runs_list = [], []
    for i, nd in enumerate(nodes):
        # Each layer is "N. label — detail" on up to 3 lines, mixing two fonts on one line,
        # so we wrap word-by-word ourselves and remember the font of every word.
        runs = [("%d. %s" % (i + 1, nd["label"]), "kb", LABEL_SIZE - 1.5)]
        if nd["detail"]:
            runs += [(" — " + nd["detail"], "ph", 14.4)]
        words = []
        for txt, face, size in runs:
            for wd in re.split(r"(?<=\s)|(?<=— )", txt):
                if wd:
                    words.append((wd, face, size))
        lines, cur, cw = [], [], 0.0
        maxw = inner_w - 2 * text_pad
        for wd, face, size in words:
            ww = text_width(wd, size, face)
            if cur and cw + ww > maxw:
                lines.append(cur)
                cur, cw = [], 0.0
            cur.append((wd, face, size))
            cw += ww
        if cur:
            lines.append(cur)
        runs_list.append(lines[:3])
        heights.append(max(46, 20 + len(lines[:3]) * 19))
    total = sum(heights) + 18 * (len(nodes) - 1)
    H = y0 + total + 22
    sk.rect(
        frame_x, 6, frame_w, H - 12, fill="#faf6e9", stroke=INK, sw=2.6, double=True, hl="#e9dfc2", hl_style="zigzag"
    )
    if dg["title"]:
        sk.text(inner_x + 4, y + 30, dg["title"], 20, "kb", "start", INK)
    yy = y0
    for i in range(len(nodes)):
        h = heights[i]
        _fill, _stroke, highlight = TINTS[(4, 2, 3)[i % 3]]
        sk.rect(inner_x, yy, inner_w, h, fill=CARD, stroke=INK, sw=2.2, hl=highlight)
        ly = yy + h / 2 - (len(runs_list[i]) - 1) * 9.5 + 5.5
        for line in runs_list[i]:
            spans = "".join(
                '<tspan class="%s" font-size="%s">%s</tspan>' % (face, fmt_num(size), escape_html(wd))
                for wd, face, size in line
            )
            sk.tx.append(
                '<text x="%s" y="%s" fill="%s" xml:space="preserve">%s</text>'
                % (fmt_num(inner_x + text_pad), fmt_num(ly), INK, spans)
            )
            ly += 19
        if i < len(nodes) - 1:
            cx = inner_x + inner_w / 2
            sk.arrow([(cx, yy + h + 1), (cx + sk.jitter(1), yy + h + 17)], sw=2.0)
        yy += h + 18
    return sk.out(), W, H


# ----------------------------------------------------------------------------------------------
# 6. Compare (side-by-side cards, up to 3 per row)
# ----------------------------------------------------------------------------------------------
def _svg_compare(dg: dict, W: float) -> tuple[str, float, float]:
    sk = Sketch(stable_seed("cmp", dg["title"], *[n["label"] for n in dg["nodes"]]))
    nodes = dg["nodes"]
    n = len(nodes)
    cols = n if n <= 3 else (2 if n == 4 else 3)
    rows = math.ceil(n / cols)
    idx = {nd["id"]: i for i, nd in enumerate(nodes)}
    edges = dg["edges"] or []
    # only edges between neighbouring cards in the same row are drawn
    edge_map = {}
    for ed in edges:
        a, b = idx[ed["from"]], idx[ed["to"]]
        if a // cols == b // cols and b == a + 1:
            edge_map[a] = ed
    gaps = []
    for c in range(cols - 1):
        labels = [edge_map[i]["label"] for i in range(n) if i % cols == c and i in edge_map and edge_map[i]["label"]]
        has = any(i % cols == c and i in edge_map for i in range(n))
        w = max([text_width(lab, 15, "cv") for lab in labels], default=0)
        gaps.append(max(30, (50 if has else 0) + min(w, 74)) if has else 26)
    bw = (W - sum(gaps)) / cols
    # sizes
    for nd in nodes:
        lw = bw - 22
        nd["_ll"] = wrap_text(nd["label"], lw, 17.5, "kb", 2)
        nd["_dl"] = wrap_text(nd["detail"], lw, 14.4, "ph", 6) if nd["detail"] else []
        nd["_h"] = 18 + len(nd["_ll"]) * 21 + (len(nd["_dl"]) * 17.5 + 8 if nd["_dl"] else 0) + 6
    row_h = []
    for r in range(rows):
        row_h.append(max(nd["_h"] for i, nd in enumerate(nodes) if i // cols == r))
    vgap = 32
    H = 14 + sum(row_h) + vgap * (rows - 1) + 14
    palette = [1, 2, 3, 4, 0]
    ry = 12
    card_geo = {}
    for r in range(rows):
        x = 0.0
        for c in range(cols):
            i = r * cols + c
            if i >= n:
                break
            nd = nodes[i]
            fill, stroke, hl = TINTS[palette[i % len(palette)]]
            sk.rect(x + 3, ry, bw - 6, row_h[r], fill=fill, stroke=stroke, sw=2.3, hl=hl)
            ty = ry + 14 + 17.5 * 0.8
            for line in nd["_ll"]:
                sk.text(x + bw / 2, ty, line, 17.5, "kb", "middle", INK)
                ty += 21
            ty += 3
            for line in nd["_dl"]:
                sk.text(x + bw / 2, ty + 5, line, 14.4, "ph", "middle", "#3d362f")
                ty += 17.5
            card_geo[i] = (x, ry, bw, row_h[r])
            if c < cols - 1:
                x += bw + gaps[c]
        ry += row_h[r] + vgap
    for i, ed in edge_map.items():
        x, y, w, h = card_geo[i]
        x2 = card_geo[i + 1][0]
        ym = y + min(h, card_geo[i + 1][3]) / 2
        sk.arrow([(x + w - 2, ym), (x2 + 6, ym)], dash="7 5")
        if ed["label"]:
            lines = _label_lines(ed["label"], 72)
            sk.label((x + w + x2) / 2, ym - 14 - (len(lines) - 1) * 6, lines)
    return sk.out(), W, H


# ----------------------------------------------------------------------------------------------
# 7. Cycle (boxes around an ellipse, curved arrows between them)
# ----------------------------------------------------------------------------------------------
def _svg_cycle(dg: dict, W: float) -> tuple[str, float, float]:
    sk = Sketch(stable_seed("cycle", dg["title"], *[n["label"] for n in dg["nodes"]]))
    nodes = dg["nodes"]
    n = len(nodes)
    idx = {nd["id"]: i for i, nd in enumerate(nodes)}
    edges = (
        dg["edges"] or [{"from": nodes[i]["id"], "to": nodes[(i + 1) % n]["id"], "label": ""} for i in range(n)]
        if n > 1
        else []
    )
    bw = 168 if n <= 6 else 150
    for nd in nodes:
        b = _node_box(nd, bw, max_label=2, max_det=2)
        nd["_ll"], nd["_dl"], nd["_h"] = b["ll"], b["dl"], b["h"]
    bh = max(nd["_h"] for nd in nodes)
    rx = (W - bw) / 2 - 14
    ry = max(bh * 1.35, 80)

    def centers(ry_):
        """Box centres evenly spaced on an ellipse (first one at the top)."""
        out = []
        for i in range(n):
            a = -math.pi / 2 + 2 * math.pi * i / n
            out.append((W / 2 + rx * math.cos(a), ry_ * math.sin(a)))
        return out

    def no_overlap(cs):
        for i in range(n):
            for j in range(i + 1, n):
                if abs(cs[i][0] - cs[j][0]) < bw + 34 and abs(cs[i][1] - cs[j][1]) < bh + 28:
                    return False
        return True

    # make the ellipse taller until no two boxes overlap
    while ry < 280 and not no_overlap(centers(ry)):
        ry += 8
    cs = centers(ry)
    top = bh / 2 + 14
    cs = [(x, y + ry + top) for x, y in cs]
    H = 2 * ry + bh + 28
    cx0, cy0 = W / 2, ry + top
    for i, nd in enumerate(nodes):
        x, y = cs[i]
        _draw_node(sk, nd, x - bw / 2, y - bh / 2, bw, bh, tint=(4, 2, 3, 1)[i % 4])
    for ed in edges:
        a, b = idx[ed["from"]], idx[ed["to"]]
        (ax, ay), (bx, by) = cs[a], cs[b]
        p0 = _intersect_rect(ax, ay, bw, bh, bx, by, pad=6)
        p3 = _intersect_rect(bx, by, bw, bh, ax, ay, pad=8)
        # bend the arrow outwards, away from the centre
        mx, my = (p0[0] + p3[0]) / 2, (p0[1] + p3[1]) / 2
        vx, vy = mx - cx0, my - cy0
        vl = math.hypot(vx, vy) or 1
        off = 22
        c = (mx + vx / vl * off, my + vy / vl * off)
        d = "M%s %sQ%s %s %s %s" % (
            fmt_num(p0[0]),
            fmt_num(p0[1]),
            fmt_num(c[0]),
            fmt_num(c[1]),
            fmt_num(p3[0]),
            fmt_num(p3[1]),
        )
        sk.path(d)
        sk.head(p3[0], p3[1], math.atan2(p3[1] - c[1], p3[0] - c[0]))
        if ed["label"]:
            lines = _label_lines(ed["label"], 90)
            sk.label(c[0] + vx / vl * 16, c[1] + vy / vl * 8, lines)
    # the title is written in the middle of the cycle
    if dg["title"] and n >= 3:
        lines = wrap_text(dg["title"], max(120, 2 * rx - bw - 40), 20, "kb", 2)
        ty = cy0 - (len(lines) - 1) * 12 + 6
        for line in lines:
            sk.text(cx0, ty, line, 20, "kb", "middle", "#8d8372")
            ty += 24
    return sk.out(), W, H


# ----------------------------------------------------------------------------------------------
# 8. Tree (top-down hierarchy)
# ----------------------------------------------------------------------------------------------
def _svg_tree(dg: dict, W: float) -> tuple[str, float, float]:
    sk = Sketch(stable_seed("tree", dg["title"], *[n["label"] for n in dg["nodes"]]))
    nodes = dg["nodes"]
    n = len(nodes)
    idx = {nd["id"]: i for i, nd in enumerate(nodes)}
    parent = {}
    edge_label = {}
    for ed in dg["edges"]:
        a, b = idx[ed["from"]], idx[ed["to"]]
        edge_label[(a, b)] = ed["label"]
        if b not in parent and a != b:  # first incoming edge wins
            parent[b] = a
    # break cycles
    for i in range(n):
        seen, p = {i}, parent.get(i)
        while p is not None:
            if p in seen:
                parent.pop(i, None)
                break
            seen.add(p)
            p = parent.get(p)
    roots = [i for i in range(n) if i not in parent]
    if not dg["edges"]:  # no edges: everything hangs off the first node
        roots = [0]
        for i in range(1, n):
            parent[i] = 0
    children = {i: [] for i in range(n)}
    for c, p in parent.items():
        children[p].append(c)
    for p in children:
        children[p].sort()
    # depth of every node
    depth = {}

    def dfs_depth(i, d):
        depth[i] = d
        for c in children[i]:
            dfs_depth(c, d + 1)

    for r in roots:
        dfs_depth(r, 0)
    maxd = max(depth.values())
    # leaves get consecutive slots; a parent sits centred over its children
    slot = {}
    counter = [0]

    def assign(i):
        if not children[i]:
            slot[i] = float(counter[0])
            counter[0] += 1
        else:
            for c in children[i]:
                assign(c)
            slot[i] = (slot[children[i][0]] + slot[children[i][-1]]) / 2

    for r in roots:
        assign(r)
    nslots = max(counter[0], 1)
    gap = 18
    bw = min(176, max(96, (W - gap * (nslots - 1)) / nslots))
    natural = nslots * bw + (nslots - 1) * gap
    VW = max(W, natural)  # very wide trees get a wider viewBox (scaled down by the browser)
    for nd in nodes:
        b = _node_box(nd, bw, max_label=3, max_det=3, pad=8)
        nd["_ll"], nd["_dl"], nd["_h"] = b["ll"], b["dl"], b["h"]
    level_h = [max([nodes[i]["_h"] for i in range(n) if depth[i] == d] or [40]) for d in range(maxd + 1)]
    vgap = 56
    ys, y = [], 8
    for d in range(maxd + 1):
        ys.append(y)
        y += level_h[d] + vgap
    H = y - vgap + 12

    def cx(i):
        return (VW - natural) / 2 + bw / 2 + slot[i] * (bw + gap)

    for i, nd in enumerate(nodes):
        _draw_node(sk, nd, cx(i) - bw / 2, ys[depth[i]], bw, level_h[depth[i]], tint=(4, 2, 3)[min(depth[i], 2)])
    for c, p in parent.items():
        x1, y1 = cx(p), ys[depth[p]] + level_h[depth[p]] + 3
        x2, y2 = cx(c), ys[depth[c]] - 7
        mid = (y1 + y2) / 2
        sk.bezier_arrow((x1, y1), (x1, mid + 4), (x2, mid - 4), (x2, y2))
        lab = edge_label.get((p, c))
        if lab:
            sk.label((x1 + x2) / 2 + 4, mid, _label_lines(lab, 90))
    return sk.out(), VW, H


# ----------------------------------------------------------------------------------------------
# 9. Timeline (dots on an arrow, up to 4 per row)
# ----------------------------------------------------------------------------------------------
def _svg_timeline(dg: dict, W: float) -> tuple[str, float, float]:
    sk = Sketch(stable_seed("tl", dg["title"], *[n["label"] for n in dg["nodes"]]))
    nodes = dg["nodes"]
    n = len(nodes)
    per_row = min(n, 4) if n <= 4 else math.ceil(n / math.ceil(n / 4))
    rows = math.ceil(n / per_row)
    colw = (W - 20) / per_row
    for nd in nodes:
        nd["_ll"] = wrap_text(nd["label"], colw - 14, 20, "kb", 2)
        nd["_dl"] = wrap_text(nd["detail"], colw - 14, 14.4, "ph", 4) if nd["detail"] else []
        nd["_h"] = len(nd["_ll"]) * 23 + (len(nd["_dl"]) * 17 + 4 if nd["_dl"] else 0)
    y = 16
    for r in range(rows):
        items = nodes[r * per_row : (r + 1) * per_row]
        ly = y + 14
        x_start, x_end = 6, W - 6
        sk.arrow([(x_start, ly), (x_end, ly)], sw=2.6)
        for c, nd in enumerate(items):
            cx = 10 + colw * (c + 0.5)
            dot_radius = 7.5
            sk.ellipse(
                cx,
                ly,
                2 * dot_radius,
                2 * dot_radius,
                fill="#fff8d6",
                stroke=INK,
                sw=2.4,
                hl=TINTS[4][2],
                hl_style="solid",
            )
            ty = ly + 22 + 20 * 0.62
            for line in nd["_ll"]:
                sk.text(cx, ty, line, 20, "kb", "middle", INK)
                ty += 23
            for line in nd["_dl"]:
                sk.text(cx, ty + 4, line, 14.4, "ph", "middle", "#3d362f")
                ty += 17
        rh = max(nd["_h"] for nd in items)
        y = ly + 22 + rh + 22
    H = y - 6
    return sk.out(), W, H


# ----------------------------------------------------------------------------------------------
# 10. Mind map (root ellipse in the middle, branches left and right, at most 2 levels deep)
# ----------------------------------------------------------------------------------------------
def _mm_box(nd: dict, bw: float, lsize, llh, dsize, dlh, max_label, max_det, pad=8) -> dict:
    """Like ``_node_box`` but with explicit font sizes (mind-map levels use different sizes)."""
    lw = bw - 2 * pad
    ll = wrap_text(nd["label"], lw, lsize, "kb", max_label)
    dl = wrap_text(nd["detail"], lw, dsize, "ph", max_det) if nd["detail"] else []
    h = pad + len(ll) * llh + (len(dl) * dlh + 3 if dl else 0) + pad - 1
    return {"ll": ll, "dl": dl, "h": max(h, 36)}


def mindmap_tree(dg: dict) -> tuple[int, dict[int, int], dict[int, int]]:
    """Return (root, parent{child: parent}, depth{node: 0-2}) as node indexes; always a valid tree, depth <= 2."""
    nodes = dg["nodes"]
    n = len(nodes)
    idx = {nd["id"]: i for i, nd in enumerate(nodes)}
    par: dict[int, int] = {}
    for i, nd in enumerate(nodes):
        p = idx.get(nd.get("parent", ""))
        if p is not None and p != i:
            par[i] = p
    roots = [i for i in range(n) if i not in par]
    root = roots[0] if roots else 0
    par.pop(root, None)
    if not par and dg["edges"]:  # no parent fields: fall back to the edges (first incoming edge wins)
        for ed in dg["edges"]:
            a, b = idx[ed["from"]], idx[ed["to"]]
            if b != root and b not in par and a != b:
                par[b] = a
    for i in range(n):  # everything must reach the root (orphans / cycles hang off the root)
        if i == root:
            continue
        seen, p, reaches_root = {i}, par.get(i), False
        while p is not None:
            if p == root:
                reaches_root = True
                break
            if p in seen:
                break
            seen.add(p)
            p = par.get(p)
        if not reaches_root:
            par[i] = root

    def chain(i):
        out = []
        while i != root:
            out.append(i)
            i = par[i]
        return out  # i, parent(i), ... (excluding root)

    for i in range(n):
        c = chain(i) if i != root else []
        if len(c) > 2:  # too deep: lift to depth 2 (child of the depth-1 ancestor)
            par[i] = c[-1]
    depth = {root: 0}
    for i in range(n):
        if i != root:
            depth[i] = len(chain(i))
    return root, par, depth


def _svg_mindmap(dg: dict, W: float) -> tuple[str, float, float]:
    sk = Sketch(stable_seed("mind", dg["title"], *[n["label"] for n in dg["nodes"]]))
    nodes = dg["nodes"]
    n = len(nodes)
    root, par, depth = mindmap_tree(dg)
    kids = {i: [] for i in range(n)}
    for c in sorted(par):
        kids[par[c]].append(c)
    level1 = kids[root]
    has_level2 = any(kids[i] for i in level1)
    # widths: rw root, w1 level-1 box, w2 level-2 box; g0/g1 horizontal gaps after root / level 1
    if has_level2:
        rw, w1, w2, g0, g1 = 150.0, 118.0, 108.0, 22.0, 18.0
    else:
        rw, g0 = 176.0, 46.0
        w1 = min(210.0, (W - rw - 2 * g0) / 2)
        w2, g1 = 0.0, 0.0
    # root ellipse sized for its text (a rectangle of text must fit inside the ellipse)
    rb = _mm_box(nodes[root], rw * 0.80, 18.5, 22, 13.4, 16, 3, 2, pad=2)
    th = len(rb["ll"]) * 22 + (len(rb["dl"]) * 16 + 3 if rb["dl"] else 0)
    rh = max(80.0, th / 0.72 + 10)
    box = {}
    for i in level1:
        box[i] = _mm_box(nodes[i], w1, 16.5, 19.5, 13.4, 15.5, 3, 2, pad=10)
        box[i]["h"] = max(box[i]["h"], 46)
        for c in kids[i]:
            box[c] = _mm_box(nodes[c], w2, 14.6, 17, 12.6, 14.5, 3, 2, pad=8)
            box[c]["h"] = max(box[c]["h"], 38)
    kid_gap, group_gap = 12.0, 24.0

    def group_height(i):
        """Height of a level-1 box together with its children column."""
        ks = kids[i]
        kh = sum(box[c]["h"] for c in ks) + kid_gap * max(len(ks) - 1, 0)
        return max(box[i]["h"], kh)

    sides = {1: [], -1: []}
    side_total = {1: 0.0, -1: 0.0}
    for i in level1:  # greedy balance by height; ties go right
        s = 1 if side_total[1] <= side_total[-1] else -1
        sides[s].append(i)
        side_total[s] += group_height(i) + group_gap
    H = max(max(side_total.values()) - group_gap if level1 else 0, rh) + 24
    cx0, cy0 = W / 2, H / 2
    pos: dict[int, tuple] = {}  # node -> (x, y, w, h)
    for s, lst in sides.items():
        total = sum(group_height(i) for i in lst) + group_gap * max(len(lst) - 1, 0)
        y = cy0 - total / 2
        for i in lst:
            g = group_height(i)
            yc = y + g / 2
            x1 = cx0 + s * (rw / 2 + g0) - (w1 if s < 0 else 0)
            pos[i] = (x1, yc - box[i]["h"] / 2, w1, box[i]["h"])
            ks = kids[i]
            if ks:
                kh = sum(box[c]["h"] for c in ks) + kid_gap * (len(ks) - 1)
                yy = yc - kh / 2
                x2 = (x1 + w1 + g1) if s > 0 else (x1 - g1 - w2)
                for c in ks:
                    pos[c] = (x2, yy, w2, box[c]["h"])
                    yy += box[c]["h"] + kid_gap
            y += g + group_gap
    palette = (2, 3, 1, 4)
    tint_of = {}
    for k, i in enumerate(level1):  # a branch and its children share one colour
        tint_of[i] = palette[k % 4]
        for c in kids[i]:
            tint_of[c] = palette[k % 4]
    # edges first (under the boxes)
    for i in level1:
        x, y, w, h = pos[i]
        s = 1 if x > cx0 else -1
        ty = y + h / 2
        dx, dy = ((x - cx0) if s > 0 else (x + w - cx0)), ty - cy0
        # start the branch on the root ellipse's outline (t scales the vector onto the ellipse)
        t = 1.0 / math.sqrt((dx / (rw / 2)) ** 2 + (dy / (rh / 2)) ** 2) if dx or dy else 1.0
        t = min(t, 1.0)
        p0 = (cx0 + dx * t * 0.97, cy0 + dy * t * 0.97)
        p3 = (x - 2 if s > 0 else x + w + 2, ty)
        span = abs(p3[0] - p0[0])
        stroke = TINTS[tint_of[i]][1]
        sk.bezier_arrow(
            p0,
            (p0[0] + s * span * 0.55, p0[1]),
            (p3[0] - s * span * 0.45, p3[1]),
            p3,
            stroke=stroke,
            sw=2.8,
            head=False,
        )
        for c in kids[i]:
            cx_, cy_, cw_, ch_ = pos[c]
            q0 = (x + w + 2, ty) if s > 0 else (x - 2, ty)
            q3 = (cx_ - 2 if s > 0 else cx_ + cw_ + 2, cy_ + ch_ / 2)
            sp2 = abs(q3[0] - q0[0])
            sk.bezier_arrow(
                q0,
                (q0[0] + s * sp2 * 0.5, q0[1]),
                (q3[0] - s * sp2 * 0.5, q3[1]),
                q3,
                stroke=stroke,
                sw=2.1,
                head=False,
            )
    # root
    sk.ellipse(cx0, cy0, rw, rh, fill=TINTS[4][0], stroke=TINTS[4][1], sw=3.0, hl=TINTS[4][2])
    _text_box(sk, rb["ll"], rb["dl"], cx0, cy0 - th / 2 - 2, 0, 18.5, 22, 13.4, 16)
    for i in level1:
        x, y, w, h = pos[i]
        f, st, hl = TINTS[tint_of[i]]
        sk.rect(x, y, w, h, fill=f, stroke=st, sw=2.5, hl=hl)
        _text_box(
            sk,
            box[i]["ll"],
            box[i]["dl"],
            x + w / 2,
            y + (h - len(box[i]["ll"]) * 19.5 - (len(box[i]["dl"]) * 15.5 + 3 if box[i]["dl"] else 0)) / 2 - 10 + 10,
            0,
            16.5,
            19.5,
            13.4,
            15.5,
        )
        for c in kids[i]:
            x, y, w, h = pos[c]
            sk.rect(x, y, w, h, fill=f, stroke=st, sw=1.9, hl=None)
            _text_box(
                sk,
                box[c]["ll"],
                box[c]["dl"],
                x + w / 2,
                y + (h - len(box[c]["ll"]) * 17 - (len(box[c]["dl"]) * 14.5 + 3 if box[c]["dl"] else 0)) / 2,
                0,
                14.6,
                17,
                12.6,
                14.5,
            )
    return sk.out(), W, H


# ----------------------------------------------------------------------------------------------
# 11. Sequence (actors on top, dashed lifelines, messages as horizontal arrows)
# ----------------------------------------------------------------------------------------------
def _svg_sequence(dg: dict, W: float) -> tuple[str, float, float]:
    sk = Sketch(stable_seed("seq", dg["title"], *[n["label"] for n in dg["nodes"]]))
    actors = dg["nodes"]
    n = len(actors)
    idx = {a["id"]: i for i, a in enumerate(actors)}
    msgs = [m for m in dg["edges"] if m["from"] in idx and m["to"] in idx][:8]
    if not msgs:  # no messages given: chain the actors left to right
        msgs = [{"from": actors[i]["id"], "to": actors[i + 1]["id"], "label": ""} for i in range(n - 1)]
    bw = min(158.0, (W - 8) / n - 12)
    boxes = [_node_box(a, bw, max_label=2, max_det=2) for a in actors]
    ah = max(b["h"] for b in boxes)
    step = (W - 8 - bw) / (n - 1) if n > 1 else 0
    cx = [4 + bw / 2 + i * step for i in range(n)]  # x of each lifeline
    y0 = 6.0
    rows, cursor = [], y0 + ah + 12  # cursor = next free y below the actors
    for m in msgs:
        a, b = idx[m["from"]], idx[m["to"]]
        if a == b:  # self-call: a small loop beside the lifeline (on the side with more room)
            right = (cx[a + 1] if a + 1 < n else W - 2) - cx[a] - 58
            left = cx[a] - (cx[a - 1] if a > 0 else 2) - 58
            side = 1 if right >= left else -1
            avail = max(60.0, max(right, left))
            lines = wrap_text(m["label"], avail, 15, "cv", 4) if m["label"] else []
            lh = len(lines) * 15.75 + 2
            rows.append(dict(a=a, b=b, self=True, side=side, lines=lines, y=cursor + 4))
            cursor += max(30.0, lh) + 22
        else:
            avail = max(64.0, abs(cx[a] - cx[b]) - 22)
            lines = wrap_text(m["label"], avail, 15, "cv", 3) if m["label"] else []
            lh = len(lines) * 15.75 + 2 if lines else 0
            ay = cursor + lh + 16
            rows.append(dict(a=a, b=b, self=False, lines=lines, lh=lh, y=ay))
            cursor = ay + 18
    life_end = cursor + 2
    H = life_end + 10
    for i in range(len(actors)):  # actors + lifelines (under the messages)
        tf, ts_, thl = TINTS[(4, 2, 3, 1)[i % 4]]
        x = cx[i] - bw / 2
        sk.line(cx[i], y0 + ah + 2, cx[i], life_end, stroke="#7d7466", sw=1.7, dash="7 6", amp=0.8)
        sk.line(cx[i] - 7, life_end + 1, cx[i] + 7, life_end + 1, stroke="#7d7466", sw=1.7, amp=0.4)
        sk.rect(x, y0, bw, ah, fill=tf, stroke=ts_, sw=2.4, hl=thl)
        _text_box(
            sk,
            boxes[i]["ll"],
            boxes[i]["dl"],
            cx[i],
            y0,
            10,
            LABEL_SIZE,
            LABEL_LINE_HEIGHT,
            DETAIL_SIZE,
            DETAIL_LINE_HEIGHT,
        )
    for r in rows:
        a, b = r["a"], r["b"]
        if r["self"]:
            s, y, x = r["side"], r["y"], cx[a]
            sk.arrow([(x + s * 3, y), (x + s * 40, y), (x + s * 40, y + 20), (x + s * 7, y + 20)], sw=2.1)
            if r["lines"]:
                wmax = max(text_width(line, 15, "cv") for line in r["lines"]) + 8
                sk.label(x + s * (48 + wmax / 2), y + 10, r["lines"])
            continue
        s = 1 if cx[b] > cx[a] else -1
        y = r["y"]
        sk.arrow([(cx[a] + s * 4, y), (cx[b] - s * 5, y)], sw=2.2, dash="7 5" if s < 0 else None)  # replies are dashed
        if r["lines"]:
            sk.label((cx[a] + cx[b]) / 2, y - 9 - r["lh"] / 2, r["lines"])
    return sk.out(), W, H


# ----------------------------------------------------------------------------------------------
# 12. Public entry points
# ----------------------------------------------------------------------------------------------
DIAGRAM_BUILDERS = {
    "flow": _svg_flow,
    "stack": _svg_stack,
    "compare": _svg_compare,
    "cycle": _svg_cycle,
    "tree": _svg_tree,
    "timeline": _svg_timeline,
    "mindmap": _svg_mindmap,
    "sequence": _svg_sequence,
}


def build_diagram_svg(diagram: object, width: float = 690.0, css_class: str = "d") -> tuple[str, float, float] | None:
    """Return (svg_markup, vb_w, vb_h) or None. Never raises on odd input."""
    dg = clean_diagram(diagram)
    if not dg:
        return None
    try:
        inner, vw, vh = DIAGRAM_BUILDERS[dg["type"]](dg, width)
    except Exception:  # defensive: a broken diagram must not break the whole notebook
        try:
            inner, vw, vh = _svg_flow({**dg, "edges": []}, width)
        except Exception:
            return None
    svg = (
        '<svg class="%s" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %s %s" '
        'preserveAspectRatio="xMidYMid meet" role="img" aria-label="%s">%s</svg>'
        % (css_class, fmt_num(vw), fmt_num(vh), escape_html(dg["title"] or "diagram"), inner)
    )
    return svg, vw, vh


def diagram_item(diagram: object) -> str:
    """The diagram as a notebook item: optional title, the SVG, optional caption ("" if none)."""
    dg = clean_diagram(diagram)
    if not dg:
        return ""
    result = build_diagram_svg(diagram)
    if not result:
        return ""
    svg, _vw, _vh = result
    title = ""
    if dg["title"] and dg["type"] not in ("stack", "cycle"):  # these two draw their title inside the SVG
        title = '<div class="dt">%s</div>' % escape_html(dg["title"])
    caption = '<div class="cap">%s</div>' % escape_html(dg["caption"]) if dg["caption"] else ""
    return '<div class="item dgm">%s%s%s</div>' % (title, svg, caption)
