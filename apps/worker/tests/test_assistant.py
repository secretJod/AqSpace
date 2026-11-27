"""Answering questions from the user's notes: ranking, grounding, citations, errors and privacy.

The LLM is always a fake or ``requests.post`` is mocked: no network, no real keys.
"""

import json
import logging

import pytest
import requests

from app import server as srv
from notes_engine import assistant, llm

FAKE_KEY = "gsk_FAKEFAKEFAKE0123456789abcdefXYZ"
QUESTION = "How does positional encoding work?"
JOB_A = "a" * 32
JOB_B = "b" * 32


def notes(title, sections):
    return {
        "meta": {"title": title},
        "sections": [
            {"title": h, "timestamp": ts, "blocks": [{"type": "paragraph", "text": body}], "key_takeaways": []}
            for h, ts, body in sections
        ],
        "glossary": [{"term": "token", "definition": "a word piece"}],
        "recap": {"title": "recap", "points": ["attention mixes tokens"]},
    }


NOTES_A = notes(
    "Transformers",
    [
        ("self-attention", "03:05", "Each token builds a query, key and value; softmax weights the values."),
        (
            "positional encoding",
            "12:40",
            "Attention has no sense of order, so sine and cosine positional encodings are added to embeddings.",
        ),
    ],
)
NOTES_B = notes("Databases", [("indexes", "1:02:03", "A B-tree index speeds up lookups on a column.")])


@pytest.fixture
def out_dir(tmp_path):
    out = tmp_path / "out"
    for job_id, n in ((JOB_A, NOTES_A), (JOB_B, NOTES_B)):
        (out / job_id).mkdir(parents=True)
        (out / job_id / "notes.json").write_text(json.dumps(n), encoding="utf-8")
    return out


JOBS = [
    {"job_id": JOB_A, "video_id": "AAAAAAAAAAA", "title": "Transformers lecture"},
    {"job_id": JOB_B, "video_id": "BBBBBBBBBBB", "title": "Databases lecture"},
]


class FakeClient:
    """Stands in for llm._Client: records the prompt and returns a canned JSON reply."""

    def __init__(self, reply=None, exc=None):
        self.reply, self.exc = reply, exc
        self.profile = {"single_chars": 8000}
        self.calls = []

    def ask_json(self, messages, max_tokens, temperature=0.3, think=False, schema=None, read_timeout=None):
        self.calls.append({"messages": messages, "schema": schema})
        if self.exc:
            raise self.exc
        return self.reply


def run(out_dir, client, question=QUESTION, jobs=JOBS, key=FAKE_KEY):
    return assistant.answer_question(question, "groq", key, None, jobs, out_dir, make_client=lambda *a: client)


# ---- passages and ranking ---------------------------------------------------------
def test_timestamps_parse():
    assert assistant.timestamp_to_sec("12:40") == 760
    assert assistant.timestamp_to_sec("1:02:03") == 3723
    assert assistant.timestamp_to_sec("soon") is None


def test_ranking_picks_the_right_passage(out_dir):
    passages, used = assistant.load_passages(out_dir, JOBS)
    assert used == 2
    ranked = assistant.rank_passages(QUESTION, passages)
    assert ranked[0][1]["heading"] == "positional encoding"
    top = assistant.rank_passages("what speeds up lookups with an index?", passages)[0][1]
    assert top["video_id"] == "BBBBBBBBBBB" and top["heading"] == "indexes"


def test_long_sections_are_split_and_budget_respected():
    body = "\n".join(f"line {i} about gradient descent" for i in range(400))
    passages = assistant.notes_passages(notes("ML", [("gd", "00:10", body)]), "CCCCCCCCCCC", "ML")
    section = [p for p in passages if p["heading"] == "gd"]
    assert len(section) > 1 and all(len(p["text"]) <= assistant.PASSAGE_CHARS for p in section)
    chosen = assistant.pick_passages(assistant.rank_passages("gradient descent", passages), 3000)
    assert sum(len(p["text"]) for p in chosen) <= 3000


def test_missing_bad_and_escaping_jobs_are_skipped(out_dir):
    (out_dir / ("c" * 32)).mkdir()
    (out_dir / ("c" * 32) / "notes.json").write_text("{not json", encoding="utf-8")
    jobs = [{"job_id": "d" * 32}, {"job_id": "c" * 32}, {"job_id": "../" + JOB_A}, JOBS[0]]
    _, used = assistant.load_passages(out_dir, jobs)
    assert used == 1


# ---- the grounded answer ----------------------------------------------------------
def test_answer_with_citations_mapping_to_video_and_time(out_dir):
    client = FakeClient({"answer": "Sine and cosine encodings are **added**.", "found": True, "cite": [1, 1, 99]})
    out = run(out_dir, client)
    assert out["found"] is True and out["used_notes"] == 2
    assert out["citations"] == [
        {"video_id": "AAAAAAAAAAA", "title": "Transformers lecture", "heading": "positional encoding", "start_sec": 760}
    ]
    system, user = client.calls[0]["messages"]
    assert "ONLY" in system and "positional encoding" in user.split("Question:")[0]
    assert client.calls[0]["schema"] is not None


def test_model_says_not_found(out_dir):
    out = run(out_dir, FakeClient({"answer": "The notes do not cover this.", "found": False, "cite": [1]}))
    assert out["found"] is False and out["citations"] == []


def test_no_matching_passage_skips_the_llm(out_dir):
    client = FakeClient()
    out = run(out_dir, client, question="photosynthesis chlorophyll")
    assert out["found"] is False and client.calls == []


def test_no_notes_gives_friendly_answer(out_dir):
    out = run(out_dir, FakeClient(), jobs=[])
    assert out == {"answer": assistant.NO_NOTES_ANSWER, "found": False, "citations": [], "used_notes": 0}


def test_missing_key_is_an_ask_error(out_dir):
    with pytest.raises(assistant.AskError) as e:
        run(out_dir, FakeClient(), key="")
    assert e.value.kind == "invalid"


@pytest.mark.parametrize(
    "exc,kind",
    [
        (llm._HTTPStatusError("x", 401), "invalid"),
        (llm._HTTPStatusError("x", 400, "api key not valid"), "invalid"),
        (llm._TransientError("Groq daily quota reached", daily_quota=True), "quota"),
        (llm._TransientError("Could not reach Groq (network error)"), "network"),
        (llm.LLMError("boom"), "other"),
    ],
)
def test_errors_map_to_kinds(out_dir, exc, kind):
    with pytest.raises(assistant.AskError) as e:
        run(out_dir, FakeClient(exc=exc))
    assert e.value.kind == kind


# ---- the HTTP route (real _Client, requests.post mocked) --------------------------
class FakeResp:
    def __init__(self, status, payload):
        self.status_code, self._payload = status, payload
        self.text, self.headers = json.dumps(payload), {}

    def json(self):
        return self._payload


@pytest.fixture
def ask_client(out_dir, monkeypatch):
    for var in ("GEMINI_API_KEY", "GROQ_API_KEY", "XAI_API_KEY", "HF_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(llm, "_sleep", lambda s: None)
    calls = []

    def factory(result):
        def fake_post(url, headers=None, json=None, timeout=None, **kw):
            calls.append({"headers": headers, "json": json})
            if isinstance(result, BaseException):
                raise result
            return result

        monkeypatch.setattr(llm.requests, "post", fake_post)
        app = srv.create_app({"OUTPUT_DIR": out_dir, "LOAD_DOTENV": False, "RATE_LIMIT": (100, 60)})
        return app.test_client(), calls

    return factory


def body(**kw):
    return {"question": QUESTION, "provider": "groq", "api_key": FAKE_KEY, "jobs": JOBS, **kw}


def groq_reply(obj):
    return FakeResp(200, {"choices": [{"message": {"content": "<think>hmm</think>" + json.dumps(obj)}}]})


def test_route_answers_and_logs_nothing_private(ask_client, caplog):
    client, calls = ask_client(groq_reply({"answer": "They are added.", "found": True, "cite": [1]}))
    with caplog.at_level(logging.DEBUG):
        r = client.post("/api/ask", json=body())
    assert r.status_code == 200
    data = r.get_json()
    assert data["found"] is True and data["citations"][0]["start_sec"] == 760
    assert set(data) == {"answer", "found", "citations", "used_notes", "provider"} and data["provider"] == "groq"
    assert calls[0]["headers"]["Authorization"] == f"Bearer {FAKE_KEY}"
    assert FAKE_KEY not in caplog.text and QUESTION not in caplog.text and "positional" not in caplog.text


@pytest.mark.parametrize(
    "result,kind",
    [
        (FakeResp(401, {"error": {"message": "Invalid API Key"}}), "invalid"),
        (requests.ConnectionError("down"), "network"),
    ],
)
def test_route_key_errors_are_422(ask_client, caplog, result, kind):
    client, _ = ask_client(result)
    with caplog.at_level(logging.DEBUG):
        r = client.post("/api/ask", json=body())
    assert r.status_code == 422
    assert r.get_json()["kind"] == kind and FAKE_KEY not in r.get_data(as_text=True)
    assert FAKE_KEY not in caplog.text and QUESTION not in caplog.text


def test_route_no_key_anywhere_is_422(ask_client):
    client, calls = ask_client(groq_reply({}))
    r = client.post("/api/ask", json=body(api_key=None))
    assert r.status_code == 422 and r.get_json()["kind"] == "invalid" and calls == []


def test_route_no_jobs_is_friendly_200(ask_client):
    client, calls = ask_client(groq_reply({}))
    r = client.post("/api/ask", json=body(jobs=[], api_key=None))
    assert r.status_code == 200 and r.get_json()["found"] is False and calls == []


@pytest.mark.parametrize(
    "override",
    [
        {"question": ""},
        {"question": "x" * 501},
        {"provider": "local"},
        {"provider": "nope"},
        {"api_key": "bad key with spaces"},
        {"jobs": "all"},
        {"jobs": [{"job_id": "../etc"}]},
        {"jobs": [{"job_id": JOB_A, "video_id": "<script>"}]},
        {"jobs": [{"job_id": JOB_A}] * 51},
    ],
)
def test_route_rejects_bad_input(ask_client, override):
    client, calls = ask_client(groq_reply({}))
    r = client.post("/api/ask", json=body(**override))
    assert r.status_code == 400 and calls == []
