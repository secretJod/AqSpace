"""Cutting a transcript into LLM-sized chunks with inline [mm:ss] time markers.

The AI pipeline (``notes_engine/llm.py``) calls ``chunk_transcript()`` to get slices it can
send to the model.  Each chunk looks like::

    {"index": 0, "start": 0.0, "end": 312.5, "text": "[00:00] Today we ... [00:31] Next ..."}

Read next: ``playlists.py`` or ``../ingest.py``.
"""
from __future__ import annotations

from .cleaning import clean_text

MARKER_EVERY_SEC = 30  # a new [mm:ss] marker at most every 30 seconds


# --------------------------------------------------------------------------- #
# 1. Helpers
# --------------------------------------------------------------------------- #


def format_timestamp(sec: float) -> str:
    """mm:ss, or h:mm:ss from one hour onwards."""
    s = max(0, int(sec))
    h, rem = divmod(s, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


def split_long_text(text: str, limit: int) -> list[str]:
    """Split text on whitespace into pieces no longer than `limit` characters."""
    if len(text) <= limit:
        return [text]
    pieces, cur = [], ""
    for w in text.split():
        while len(w) > limit:  # absurdly long token
            if cur:
                pieces.append(cur)
                cur = ""
            pieces.append(w[:limit])
            w = w[limit:]
        if cur and len(cur) + 1 + len(w) > limit:
            pieces.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}" if cur else w
    if cur:
        pieces.append(cur)
    return pieces


def render_chunk(segs: list[tuple[float, str]]) -> str:
    """Join segments, inserting a [mm:ss] marker at the first segment and then
    whenever >= MARKER_EVERY_SEC has passed since the previous marker."""
    parts: list[str] = []
    last_marker = None
    for start, text in segs:
        if last_marker is None or start - last_marker >= MARKER_EVERY_SEC:
            parts.append(f"[{format_timestamp(start)}]")
            last_marker = start
        parts.append(text)
    return " ".join(parts)


def segment_cost(text: str) -> int:
    """Characters a segment adds to a chunk (its text + one joining space)."""
    return len(text) + 1


# --------------------------------------------------------------------------- #
# 2. chunk_transcript
# --------------------------------------------------------------------------- #


def _clean_segments(transcript: dict, piece_limit: int) -> list[tuple[float, str]]:
    """``(start, text)`` pairs: cleaned, long texts split, sorted by time."""
    segs: list[tuple[float, str]] = []
    for s in transcript.get("segments") or []:
        text = clean_text(str(s.get("text", "")))
        if not text:
            continue
        for piece in split_long_text(text, piece_limit):
            segs.append((float(s.get("start", 0.0)), piece))
    segs.sort(key=lambda x: x[0])
    return segs


def chunk_transcript(transcript: dict, max_chars: int = 12000, overlap_chars: int = 400) -> list[dict]:
    """Split a transcript into LLM-sized chunks with inline [mm:ss] markers.

    Each chunk is self-contained (starts with a marker). Consecutive chunks
    overlap by up to `overlap_chars` of trailing text. `index` is 0-based.
    """
    max_chars = max(300, int(max_chars))
    overlap_chars = max(0, min(int(overlap_chars), max_chars // 3))
    marker_budget = 12  # room for a leading "[h:mm:ss] "
    piece_limit = max(100, max_chars // 2 - marker_budget)

    segs = _clean_segments(transcript, piece_limit)
    if not segs:
        return []
    n = len(segs)

    def fill(first: int) -> int:
        """Greedy: index one past the last segment that fits max_chars (markers included)."""
        used, k, last_marker = 0, first, None
        while k < n:
            start, text = segs[k]
            cost = segment_cost(text)
            marker = last_marker is None or start - last_marker >= MARKER_EVERY_SEC
            if marker:
                cost += len(format_timestamp(start)) + 3  # "[", "]" and a space
            if used + cost > max_chars and k > first:
                break
            used += cost
            if marker:
                last_marker = start
            k += 1
        return k

    # Step 1: decide which segments go into each chunk -> (first index, end index exclusive)
    chunks_idx: list[tuple[int, int]] = []
    i = 0
    while i < n:
        first = i
        if chunks_idx:
            # step back over the end of the previous chunk to create the overlap
            prev_start, prev_end = chunks_idx[-1]
            acc, j = 0, prev_end
            while j > prev_start + 1:  # never re-start at the previous chunk's first segment
                c = segment_cost(segs[j - 1][1])
                if acc + c > overlap_chars:
                    break
                acc += c
                j -= 1
            first = j
        k = fill(first)
        if k <= i:  # overlap left no room for new text: drop the overlap
            first = i
            k = fill(first)
        chunks_idx.append((first, k))
        i = k

    # Step 2: build the chunk dicts
    out = []
    for idx, (a, b) in enumerate(chunks_idx):
        part = segs[a:b]
        end_t = segs[b][0] if b < n else None
        if end_t is None:  # last chunk: end at the video's duration when we know it
            dur = transcript.get("duration_sec")
            end_t = float(dur) if isinstance(dur, (int, float)) and dur >= part[-1][0] else part[-1][0] + 10.0
        out.append(
            {
                "index": idx,
                "start": float(part[0][0]),
                "end": float(end_t),
                "text": render_chunk(part),
            }
        )
    return out
