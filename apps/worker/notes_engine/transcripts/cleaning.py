"""Caption text cleaning: raw subtitle cues -> tidy transcript segments.

The flow for every fetch method (captions API, yt-dlp subtitles, Whisper) is the same:

    raw cues  (start, duration, [lines])
      -> dedupe_cues()   clean each line, drop the repeated text of "rolling" auto-captions
      -> merge_cues()    join tiny fragments into ~5-15 second segments
      =  segments [{"start": seconds, "text": "..."}]

``build_segments()`` does both steps.  This file also reads the two subtitle file formats
yt-dlp gives us: ``parse_json3()`` and ``parse_vtt()``.

Read next: ``chunking.py``.
"""
from __future__ import annotations

import html
import re

# A cue is (start seconds, duration seconds, list of text lines)
RawCue = tuple[float, float, list[str]]

# --------------------------------------------------------------------------- #
# 1. Cleaning one piece of text
# --------------------------------------------------------------------------- #

_TAG_RE = re.compile(r"<[^>]*>")
_ENTITY_RE = re.compile(r"&(#\d+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);")
_SOUND_WORDS = (
    r"music|musical|applause|laughter|laughing|laughs|cheering|cheers|silence|noise|"
    r"inaudible|crosstalk|singing|sings|sound|sounds|sfx|foreign|speaking|whistling|"
    r"clapping|audience|background|bell|beep|chuckles|coughs|sighs|gasps|"
    r"upbeat|soft|gentle|dramatic|intro|outro|jingle|chatter|static|buzz"
)
_SOUND_CUE_RE = re.compile(   # "[Music]", "(applause)", "[soft music playing]" ...
    r"[\[\(]\s*(?:" + _SOUND_WORDS + r")\b[^\]\)]{0,40}[\]\)]", re.IGNORECASE
)
_MUSIC_NOTE_RE = re.compile(r"[♪♫♬♩]+[^♪♫♬♩]*[♪♫♬♩]*")
_CENSOR_RE = re.compile(r"\[\s*_+\s*\]")       # "[ __ ]" = a bleeped word
_SPEAKER_RE = re.compile(r"^\s*(?:>>+|-)\s+")  # ">> " / "- " speaker-change markers
WS_RE = re.compile(r"\s+")


def clean_text(text: str) -> str:
    """Strip markup, entities, [Music]-style cues and collapse whitespace."""
    if not text:
        return ""
    text = _TAG_RE.sub("", text)
    for _ in range(2):  # some captions are HTML-escaped twice
        if not _ENTITY_RE.search(text):
            break
        text = html.unescape(text)
    text = text.replace(" ", " ").replace("​", "")
    text = _SOUND_CUE_RE.sub(" ", text)
    text = _MUSIC_NOTE_RE.sub(" ", text)
    text = _CENSOR_RE.sub(" ", text)
    text = WS_RE.sub(" ", text).strip()
    text = _SPEAKER_RE.sub("", text)
    return text.strip()


def _norm_line(s: str) -> str:
    """A line in a form that is easy to compare (lower case, single spaces)."""
    return WS_RE.sub(" ", s).strip().lower()


def _words(s: str) -> list[str]:
    return s.split()


# --------------------------------------------------------------------------- #
# 2. Removing rolling duplicates
# --------------------------------------------------------------------------- #


def drop_word_overlap(prev: str, new: str) -> str:
    """Remove from the start of `new` any words that already end `prev`.

    Handles rolling auto-captions where each cue repeats the previous cue's
    tail ("so today we" -> "so today we will"). Requires >= 3 overlapping words
    (or the whole new cue being contained) to avoid eating real repetition.
    """
    pw, nw = _words(prev), _words(new)
    if not pw or not nw:
        return new
    pl = [w.lower() for w in pw]
    nl = [w.lower() for w in nw]
    if nl == pl:
        return ""
    if len(nl) >= 3 and len(nl) <= len(pl) and pl[-len(nl):] == nl:
        return ""
    max_k = min(len(pl), len(nl))
    for k in range(max_k, 2, -1):  # longest overlap first, at least 3 words
        if pl[-k:] == nl[:k]:
            return " ".join(nw[k:])
    return new


def dedupe_cues(cues: list[RawCue]) -> list[tuple[float, float, str]]:
    """cues: (start, duration, [lines]) -> (start, duration, cleaned_text) without rolling dupes."""
    out: list[tuple[float, float, str]] = []
    prev_lines: set[str] = set()
    prev_text = ""
    for start, dur, lines in cues:
        cleaned = [clean_text(line) for line in lines]
        cleaned = [line for line in cleaned if line]
        keys = {_norm_line(line) for line in cleaned}
        # (a) drop whole lines that were already shown in the previous cue
        fresh = [line for line in cleaned if _norm_line(line) not in prev_lines]
        prev_lines = keys or prev_lines
        text = " ".join(fresh).strip()
        # (b) drop words that repeat the end of the previous text
        if text:
            text = drop_word_overlap(prev_text, text).strip()
        if not text:
            continue
        prev_text = text if len(_words(text)) >= 3 else (prev_text + " " + text).strip()
        out.append((float(start), float(dur), text))
    return out


# --------------------------------------------------------------------------- #
# 3. Merging fragments into segments
# --------------------------------------------------------------------------- #

_SENT_END = (".", "?", "!", "。", "？", "！")


def merge_cues(cues: list[tuple[float, float, str]]) -> list[dict]:
    """Merge tiny fragments into ~5-15 s segments, preserving time order."""
    cues = sorted(cues, key=lambda c: c[0])
    segments: list[dict] = []
    cur_start = None
    cur_text = ""
    for start, _dur, text in cues:
        if cur_start is not None:
            span = start - cur_start
            ends_sentence = cur_text.endswith(_SENT_END)
            segment_is_full = (
                span >= 15
                or (span >= 5 and ends_sentence)
                or (span >= 10 and len(cur_text) >= 120)
                or len(cur_text) >= 320
            )
            if segment_is_full:
                segments.append({"start": round(cur_start, 2), "text": cur_text})
                cur_start, cur_text = None, ""
        if cur_start is None:
            cur_start, cur_text = start, text
        else:
            cur_text = f"{cur_text} {text}"
    if cur_start is not None and cur_text:
        segments.append({"start": round(cur_start, 2), "text": cur_text})
    return segments


def build_segments(raw_cues: list[RawCue]) -> list[dict]:
    """Raw cues -> clean, de-duplicated, merged segments."""
    return merge_cues(dedupe_cues(raw_cues))


# --------------------------------------------------------------------------- #
# 4. Subtitle file formats (from yt-dlp)
# --------------------------------------------------------------------------- #

_VTT_TIME_RE = re.compile(
    r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})"
)


def parse_json3(data: dict) -> list[RawCue]:
    """YouTube's "json3" subtitle format -> raw cues."""
    cues = []
    for ev in data.get("events", []) or []:
        segs = ev.get("segs")
        if not segs:
            continue
        text = "".join(s.get("utf8", "") for s in segs if isinstance(s, dict))
        if not text.strip():
            continue
        start = float(ev.get("tStartMs", 0)) / 1000.0
        dur = float(ev.get("dDurationMs", 0) or 0) / 1000.0
        cues.append((start, dur, text.split("\n")))
    return cues


def parse_vtt(text: str) -> list[RawCue]:
    """WebVTT subtitle text -> raw cues (one cue per "00:01.000 --> 00:03.000" block)."""
    cues = []
    blocks = re.split(r"\r?\n\r?\n", text.replace("﻿", ""))
    for block in blocks:
        lines = block.splitlines()
        for i, line in enumerate(lines):
            m = _VTT_TIME_RE.search(line)
            if not m:
                continue
            h1, m1, s1, ms1, h2, m2, s2, ms2 = m.groups()
            start = int(h1 or 0) * 3600 + int(m1) * 60 + int(s1) + int(ms1) / 1000
            end = int(h2 or 0) * 3600 + int(m2) * 60 + int(s2) + int(ms2) / 1000
            body = [l for l in lines[i + 1:] if l.strip()]
            if body:
                cues.append((start, max(0.0, end - start), body))
            break
    return cues
