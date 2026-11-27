"""Answer a student's question from their own finished notes.

What it does
    1. Loads ``notes.json`` of each given job from the worker's output folder.
    2. Splits the notes into passages (one section heading + its blocks + its timestamp).
    3. Ranks the passages against the question with BM25 (pure Python, no extra packages).
    4. Sends the best passages that fit the provider's budget to the LLM with a grounded prompt
       ("answer only from these passages, cite them, say so when they don't cover it").
    5. Maps the cited passage numbers back to ``{video_id, title, heading, start_sec}``.

Who calls it
    ``POST /api/ask`` in ``backend/app/routes.py`` (called only by the API server).

Read next
    ``prompts.ask_messages`` for the prompt, ``llm._Client`` for the HTTP call.
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import prompts
from .ai.errors import LLMError, _HTTPStatusError, _TransientError
from .ai.key_safety import scrub_secrets
from .ai.providers import PROVIDERS

MAX_QUESTION_CHARS = 500
MAX_JOBS = 50
TOP_PASSAGES = 8
PASSAGE_CHARS = 1500  # a long section is split so one passage never eats the whole budget
CONTEXT_CHARS_CAP = 16000  # even big-context models get a short, focused prompt
ANSWER_TOKENS = 900

NO_NOTES_ANSWER = (
    "You don't have finished notes yet, so there is nothing to answer from. "
    "Make notes for a lecture first, then ask again."
)
NOT_FOUND_ANSWER = (
    "Your notes don't seem to cover this. Try different words, or make notes for a lecture on this topic."
)

_JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_WORD_RE = re.compile(r"[a-z0-9]+")
# Words that carry no meaning for ranking; without this list "what is the ..." matches everything.
_STOPWORDS = frozenset(
    "a an the and or but of to in on at for with by from as is are was were be been being it its this that "
    "these those what which who whom how why when where do does did can could should would will i you we "
    "they he she me my your our their about into than then so not no yes if there here also just".split()
)


class AskError(Exception):
    """A failure the user can fix (bad key, quota, network). ``kind`` matches the key-test kinds."""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


# --------------------------------------------------------------------------- #
# 1. Notes -> passages
# --------------------------------------------------------------------------- #
def timestamp_to_sec(value: object) -> int | None:
    """Turn "MM:SS" or "H:MM:SS" into seconds; None when it is not a timestamp."""
    if not isinstance(value, str) or not re.fullmatch(r"\d{1,2}(:\d{2}){1,2}", value.strip()):
        return None
    sec = 0
    for part in value.strip().split(":"):
        sec = sec * 60 + int(part)
    return sec


def _block_text(block: Any) -> str:
    """Readable text of one notes block (paragraph, bullets, table, ...); diagrams are skipped."""
    if not isinstance(block, dict):
        return ""
    parts: list[str] = []
    for key in ("title", "term", "text", "code"):
        if isinstance(block.get(key), str):
            parts.append(block[key])
    for item in block.get("items") or []:
        if isinstance(item, str):
            parts.append("- " + item)
    if isinstance(block.get("headers"), list):
        parts.append(" | ".join(str(h) for h in block["headers"]))
    for row in block.get("rows") or []:
        if isinstance(row, list):
            parts.append(" | ".join(str(c) for c in row))
    return "\n".join(p.strip() for p in parts if p and p.strip())


def _split(text: str, limit: int) -> list[str]:
    """Split ``text`` on line breaks into pieces of at most about ``limit`` characters."""
    pieces, cur = [], ""
    for line in text.split("\n"):
        if cur and len(cur) + len(line) + 1 > limit:
            pieces.append(cur)
            cur = ""
        cur = f"{cur}\n{line}" if cur else line[:limit]
    if cur:
        pieces.append(cur)
    return pieces


def notes_passages(notes: dict, video_id: str, title: str) -> list[dict]:
    """Split one notes document into passages.

    Each passage is ``{video_id, title, heading, start_sec, text}``. Sections become one or more
    passages; the glossary and recap become passages without a timestamp.
    """
    out: list[dict] = []

    def add(heading: str, start: int | None, body: str) -> None:
        for piece in _split(body, PASSAGE_CHARS):
            if piece.strip():
                out.append(
                    {"video_id": video_id, "title": title, "heading": heading, "start_sec": start, "text": piece}
                )

    for sec in notes.get("sections") or []:
        if not isinstance(sec, dict):
            continue
        heading = str(sec.get("title") or "").strip() or "Section"
        lines = [str(sec["subtitle"])] if isinstance(sec.get("subtitle"), str) else []
        lines += [_block_text(b) for b in sec.get("blocks") or []]
        lines += ["- " + t for t in sec.get("key_takeaways") or [] if isinstance(t, str)]
        add(heading, timestamp_to_sec(sec.get("timestamp")), "\n".join(t for t in lines if t))

    gloss = [
        f"{g.get('term')}: {g.get('definition')}"
        for g in notes.get("glossary") or []
        if isinstance(g, dict) and g.get("term") and g.get("definition")
    ]
    if gloss:
        add("Glossary", None, "\n".join(gloss))
    recap = notes.get("recap") if isinstance(notes.get("recap"), dict) else {}
    points = [p for p in recap.get("points") or [] if isinstance(p, str)]
    if points:
        add(str(recap.get("title") or "Recap"), None, "\n".join("- " + p for p in points))
    return out


def load_passages(output_dir: Path, jobs: list[dict]) -> tuple[list[dict], int]:
    """Read each job's ``notes.json`` and return ``(passages, number of notes loaded)``.

    Jobs whose file is missing, expired (cleaned up), unreadable or outside ``output_dir`` are
    skipped: the API server's list of ready notes can be a little ahead of the worker's disk.
    """
    root = output_dir.resolve()
    passages: list[dict] = []
    used = 0
    for job in jobs:
        job_id = str(job.get("job_id") or "")
        if not _JOB_ID_RE.match(job_id):
            continue
        path = (root / job_id / "notes.json").resolve()
        if root not in path.parents or not path.is_file():
            continue
        try:
            notes = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(notes, dict):
            continue
        meta = notes.get("meta") if isinstance(notes.get("meta"), dict) else {}
        title = str(job.get("title") or meta.get("title") or "Lecture")
        passages += notes_passages(notes, str(job.get("video_id") or ""), title)
        used += 1
    return passages, used


# --------------------------------------------------------------------------- #
# 2. Ranking (BM25)
# --------------------------------------------------------------------------- #
def tokenize(text: str) -> list[str]:
    """Lower-case word tokens without stopwords, with a light plural strip ("heads" -> "head")."""
    words = []
    for w in _WORD_RE.findall(text.lower()):
        if w in _STOPWORDS:
            continue
        if len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
            w = w[:-1]
        words.append(w)
    return words


def rank_passages(question: str, passages: list[dict], k1: float = 1.5, b: float = 0.75) -> list[tuple[float, dict]]:
    """Score every passage against the question with BM25; best first, zero scores dropped.

    The heading is counted twice: a section titled "positional encoding" is the best place to
    answer a question about positional encoding even when the body uses the word only once.
    """
    query = set(tokenize(question))
    if not query or not passages:
        return []
    docs = [Counter(tokenize(p["heading"] + " " + p["heading"] + " " + p["text"])) for p in passages]
    n = len(docs)
    avg_len = sum(sum(d.values()) for d in docs) / n or 1.0
    df = Counter(t for d in docs for t in query if t in d)
    scored = []
    for doc, passage in zip(docs, passages, strict=True):
        length = sum(doc.values())
        score = 0.0
        for t in query:
            tf = doc.get(t, 0)
            if not tf:
                continue
            idf = math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5))
            score += idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * length / avg_len))
        if score > 0:
            scored.append((score, passage))
    scored.sort(key=lambda sp: sp[0], reverse=True)
    return scored


def pick_passages(ranked: list[tuple[float, dict]], budget_chars: int, top: int = TOP_PASSAGES) -> list[dict]:
    """Take the best passages, at most ``top``, while their text fits ``budget_chars``."""
    chosen, used = [], 0
    for _score, p in ranked[:top]:
        size = len(p["text"]) + len(p["heading"]) + len(p["title"]) + 40
        if chosen and used + size > budget_chars:
            break
        chosen.append(p)
        used += size
    return chosen


# --------------------------------------------------------------------------- #
# 3. Errors -> the same kinds and wording as the key test
# --------------------------------------------------------------------------- #
def classify_error(exc: Exception, provider: str) -> AskError:
    """Map an LLM failure to ``AskError(kind, friendly message)``; kind is invalid/quota/network/other."""
    label = PROVIDERS.get(provider, {}).get("label", provider)
    if isinstance(exc, _HTTPStatusError):
        if exc.status in (401, 403) or (
            exc.status == 400 and re.search(r"api[ _-]?key|unauthori|credential", exc.detail)
        ):
            return AskError("invalid", f"This key was rejected by {label}. Check you copied all of it.")
        if exc.status == 402:
            return AskError("quota", f"{label} says the account has no credits left. Check your plan.")
        return AskError("other", f"{label} could not answer right now (HTTP {exc.status}). Please try again.")
    if isinstance(exc, _TransientError):
        text = str(exc).lower()
        if "could not reach" in text or "not reachable" in text:
            return AskError("network", f"Couldn't reach {label}. Check your internet connection and try again.")
        if "overloaded" in text:
            return AskError("other", f"{label} is temporarily unavailable. Please try again in a minute.")
        return AskError(
            "quota",
            f"{label} accepted the key but says its rate limit or quota is used up. "
            "Wait a minute and try again, or check your plan.",
        )
    return AskError("other", f"{label} could not answer this question. Please try again.")


# --------------------------------------------------------------------------- #
# 4. The whole flow
# --------------------------------------------------------------------------- #
def _default_client(provider: str, api_key: str, model: str) -> Any:
    from .llm import _Client  # lazy: keeps this module importable without the HTTP stack

    return _Client(provider, api_key, model, cache_writes=False)


def answer_question(
    question: str,
    provider: str,
    api_key: str,
    model: str | None,
    jobs: list[dict],
    output_dir: Path,
    *,
    make_client: Callable[[str, str, str], Any] | None = None,
) -> dict:
    """Answer ``question`` from the notes of ``jobs``.

    Returns ``{answer, found, citations: [{video_id, title, heading, start_sec}], used_notes}``.
    Raises ``AskError`` for a bad key, quota or network problem. When no notes can be loaded or no
    passage matches, it answers ``found: false`` without calling the LLM at all (saves the user's
    quota and cannot hallucinate).
    """
    passages, used = load_passages(output_dir, jobs)
    if not used:
        return {"answer": NO_NOTES_ANSWER, "found": False, "citations": [], "used_notes": 0}
    ranked = rank_passages(question, passages)
    if not ranked:
        return {"answer": NOT_FOUND_ANSWER, "found": False, "citations": [], "used_notes": used}

    if not api_key:
        label = PROVIDERS.get(provider, {}).get("label", provider)
        raise AskError("invalid", f"Add your {label} key in Settings to ask questions about your notes.")
    model = (model or "").strip() or PROVIDERS[provider]["default_model"]
    client = (make_client or _default_client)(provider, api_key, model)
    budget = min(CONTEXT_CHARS_CAP, int(client.profile.get("single_chars") or CONTEXT_CHARS_CAP))
    chosen = pick_passages(ranked, budget)
    texts = [f"({p['title']} / {p['heading']})\n{p['text']}" for p in chosen]
    try:
        reply = client.ask_json(prompts.ask_messages(question, texts), ANSWER_TOKENS, 0.2, schema=prompts.ASK_SCHEMA)
    except LLMError as e:
        raise classify_error(e, provider) from None

    reply = reply if isinstance(reply, dict) else {}
    answer = scrub_secrets(str(reply.get("answer") or "").strip(), api_key, 4000)
    found = bool(reply.get("found")) and bool(answer)
    citations, seen = [], set()
    for n in reply.get("cite") or [] if found else []:
        # the model may cite a number we never sent: ignore it instead of inventing a source
        if isinstance(n, int) and not isinstance(n, bool) and 1 <= n <= len(chosen) and n not in seen:
            seen.add(n)
            p = chosen[n - 1]
            citations.append({k: p[k] for k in ("video_id", "title", "heading", "start_sec")})
    if not answer:
        answer = NOT_FOUND_ANSWER
    return {"answer": answer, "found": found, "citations": citations, "used_notes": used}
