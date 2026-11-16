"""Offline fakes for ``run_eval --dry-run`` and the tests: no network, no keys, no model downloads.

``install()`` swaps the HTTP layer the engine uses (``notes_engine.llm.requests.post`` / ``.get``) for a
canned responder, so a dry run still goes through the real ``notes_engine.llm.generate_notes`` pipeline
(profiles, chunking, validation) exactly like the app; only the provider answer is fake. Judge prompts
get canned judge JSON. Transcripts are synthetic, so ``ingest`` (yt-dlp) is never called.
"""
from __future__ import annotations

import json as _json
from typing import Any


def transcript(vid: str, title: str) -> dict:
    segs = [{"start": i * 20.0, "end": i * 20.0 + 20.0,
             "text": f"In part {i} of {title} we explain idea number {i} and why it matters."} for i in range(40)]
    return {"video_id": vid, "title": title, "channel": "Fake channel", "duration_sec": 800,
            "url": f"https://www.youtube.com/watch?v={vid}", "language": "en", "source": "fake",
            "segments": segs}


def _section(i: int) -> dict:
    return {"title": f"Idea {i}", "start": i * 200, "end": i * 200 + 200, "timestamp": f"{i * 3}:20",
            "blocks": [{"type": "paragraph", "text": f"Idea number {i} matters."},
                       {"type": "definition", "term": f"idea {i}", "text": f"the {i}th idea of the lecture"}],
            "key_takeaways": [f"idea {i} matters"], "recall": {"q": f"What is idea {i}?", "a": f"idea number {i}"}}


NOTES_BODY = {"subtitle": "a fake lecture", "cover": {"summary": "Four ideas explained.", "big_idea": "ideas matter"},
              "glossary": [{"term": "idea", "definition": "a thing explained in the lecture"}],
              "recap": {"title": "the whole picture, recapped", "points": ["ideas matter"], "diagram": None},
              "sections": [_section(i) for i in range(4)],
              # digest / merge stages read "topics"; one canned object serves every engine stage
              "topics": [{"heading": f"idea {i}", "start": f"{i * 3}:20", "facts": [f"Idea number {i} matters."]}
                         for i in range(4)]}


def judge_answer(system: str) -> dict:
    if "extract the key facts" in system:
        return {"facts": [{"id": f"f{i}", "fact": f"Idea number {i} matters."} for i in range(1, 13)]}
    if "compare two sets" in system:
        return {"winner": "tie", "reason": "fake judge"}
    return {"coverage": [{"id": f"f{i}", "covered": i % 2 == 0} for i in range(1, 13)],
            "claims": [{"claim": "Idea 1 matters.", "supported": True, "why": "fake"}],
            "rubric": {"accuracy": 7, "coverage": 6, "clarity": 7, "structure": 7, "overall": 7, "rationale": "fake"}}


class _Resp:
    def __init__(self, payload: Any, status: int = 200):
        self.status_code = status
        self._p = payload
        self.text = _json.dumps(payload)
        self.headers: dict = {}

    def json(self) -> Any:
        return self._p


def _system_of(url: str, body: dict) -> str:
    if "generativelanguage" in url:
        return ((body.get("systemInstruction") or {}).get("parts") or [{}])[0].get("text", "")
    msgs = body.get("messages") or [{}]
    return str(msgs[0].get("content", ""))


class FakeHTTP:
    """Records every call; never touches the network."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def post(self, url, headers=None, json=None, timeout=None, **kw):  # noqa: A002
        body = json or {}
        system = _system_of(url, body)
        self.calls.append({"url": url, "model": body.get("model"), "system": system[:80]})
        is_judge = any(s in system for s in ("strict evaluator", "extract the key facts", "compare two sets"))
        text = _json.dumps(judge_answer(system) if is_judge else NOTES_BODY)
        if "generativelanguage" in url:
            return _Resp({"candidates": [{"content": {"parts": [{"text": text}]}, "finishReason": "STOP"}],
                          "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 50}})
        return _Resp({"choices": [{"message": {"content": text}, "finish_reason": "stop"}],
                      "usage": {"prompt_tokens": 100, "completion_tokens": 50}})

    def get(self, url, headers=None, timeout=None, **kw):
        self.calls.append({"url": url, "get": True})
        return _Resp({"default_generation_settings": {"n_ctx": 32768}, "data": [{"id": "fake"}]})


def install() -> FakeHTTP:
    """Patch the engine's HTTP + sleep in this process. Call before common.install_meter()."""
    import os

    from notes_engine import llm
    fake = FakeHTTP()
    llm.requests.post = fake.post
    llm.requests.get = fake.get
    llm._sleep = lambda s: None
    os.environ.setdefault("LNAI_LOCAL_CTX", "32768")
    for k in ("GEMINI_API_KEY", "GROQ_API_KEY", "NVIDIA_API_KEY", "XAI_API_KEY", "HF_TOKEN"):
        os.environ[k] = "fake-key-for-dry-run"  # never sent anywhere: requests is patched
    return fake
