"""POST /api/keys/test and llm.check_key: the real engine code with requests.post mocked (no network, no real keys)."""

import json
import logging

import pytest
import requests

from app import server as srv
from notes_engine import llm

FAKE_KEY = "gsk_FAKEFAKEFAKE0123456789abcdefXYZ"


class FakeResp:
    def __init__(self, status, payload=None, text=None):
        self.status_code = status
        self._payload = payload
        self.text = text if text is not None else (json.dumps(payload) if payload is not None else "")
        self.headers = {}

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


class Recorder:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def __call__(self, url, headers=None, json=None, timeout=None, **kw):
        self.calls.append({"url": url, "headers": headers or {}, "json": json, "timeout": timeout})
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


@pytest.fixture
def keys_client(tmp_path, monkeypatch):
    def factory(result=None, **cfg):
        config = {"OUTPUT_DIR": tmp_path / "out", "LOAD_DOTENV": False, "RATE_LIMIT": (100, 60)}
        config.update(cfg)
        app = srv.create_app(config)
        rec = Recorder(result if result is not None else FakeResp(200, {"choices": [{"message": {"content": "OK"}}]}))
        monkeypatch.setattr(llm.requests, "post", rec)
        return app.test_client(), rec

    return factory


def test_ok_makes_one_tiny_request_with_key_only_in_header(keys_client):
    client, rec = keys_client()
    r = client.post("/api/keys/test", json={"provider": "groq", "api_key": FAKE_KEY})
    assert r.status_code == 200 and r.get_json() == {"ok": True}
    assert len(rec.calls) == 1
    call = rec.calls[0]
    assert call["url"] == llm.ENDPOINTS["groq"] and FAKE_KEY not in call["url"]
    assert call["headers"]["Authorization"] == f"Bearer {FAKE_KEY}"
    assert call["json"]["max_tokens"] <= 8 and "response_format" not in call["json"]
    assert call["json"]["model"] == llm.PROVIDERS["groq"]["default_model"]
    assert max(call["timeout"]) <= 15


def test_gemini_uses_header_key_and_custom_model(keys_client):
    client, rec = keys_client(FakeResp(200, {"candidates": []}))
    key = "AIzaFAKE_0123456789abcdefghijk"
    r = client.post("/api/keys/test", json={"provider": "gemini", "api_key": key, "model": "gemini-x"})
    assert r.get_json() == {"ok": True}
    call = rec.calls[0]
    assert "gemini-x:generateContent" in call["url"] and key not in call["url"]
    assert call["headers"]["x-goog-api-key"] == key
    assert call["json"]["generationConfig"]["maxOutputTokens"] <= 8


@pytest.mark.parametrize("status", [401, 403])
def test_invalid_key(keys_client, status):
    client, _ = keys_client(FakeResp(status, {"error": {"message": f"Invalid API Key {FAKE_KEY}"}}))
    r = client.post("/api/keys/test", json={"provider": "groq", "api_key": FAKE_KEY})
    data = r.get_json()
    assert r.status_code == 200 and data["ok"] is False and data["kind"] == "invalid"
    assert data["error"] == "This key was rejected by Groq. Check you copied all of it."
    assert FAKE_KEY not in r.get_data(as_text=True)


def test_400_that_complains_about_the_key_is_invalid(keys_client):
    # Gemini answers 400 "API key not valid", xAI 400 "Incorrect API key provided"
    client, _ = keys_client(
        FakeResp(
            400,
            {
                "error": {
                    "code": 400,
                    "message": "API key not valid. Please pass a valid API key.",
                    "status": "INVALID_ARGUMENT",
                }
            },
        )
    )
    data = client.post(
        "/api/keys/test", json={"provider": "gemini", "api_key": "AIzaFAKE_0123456789abcdefghijk"}
    ).get_json()
    assert data["kind"] == "invalid" and "Google Gemini" in data["error"]


@pytest.mark.parametrize("status", [429, 402])
def test_quota(keys_client, status):
    client, _ = keys_client(FakeResp(status, {"error": {"message": "Rate limit reached"}}))
    data = client.post(
        "/api/keys/test", json={"provider": "nvidia", "api_key": "nvapi-FAKE0123456789abcdef"}
    ).get_json()
    assert data["ok"] is False and data["kind"] == "quota" and "NVIDIA" in data["error"]


@pytest.mark.parametrize("exc", [requests.ConnectionError(f"boom {FAKE_KEY}"), requests.Timeout("slow")])
def test_network_error(keys_client, exc):
    client, rec = keys_client(exc)
    r = client.post("/api/keys/test", json={"provider": "groq", "api_key": FAKE_KEY})
    data = r.get_json()
    assert data["ok"] is False and data["kind"] == "network" and len(rec.calls) == 1  # no retries
    assert FAKE_KEY not in r.get_data(as_text=True)


@pytest.mark.parametrize("status", [404, 500, 418])
def test_other_errors(keys_client, status):
    client, _ = keys_client(FakeResp(status, text="nope"))
    data = client.post("/api/keys/test", json={"provider": "xai", "api_key": "xai-FAKE0123456789abcdef"}).get_json()
    assert data["ok"] is False and data["kind"] == "other" and data["error"]


@pytest.mark.parametrize(
    "payload",
    [
        {"provider": "colab", "api_key": FAKE_KEY},
        {"provider": "openai", "api_key": FAKE_KEY},
        {"provider": None, "api_key": FAKE_KEY},
        {"provider": "groq"},
        {"provider": "groq", "api_key": ""},
        {"provider": "groq", "api_key": 12345},
        {"provider": "groq", "api_key": "has spaces in it"},
        {"provider": "groq", "api_key": "x" * 600},
        {"provider": "groq", "api_key": FAKE_KEY, "model": "bad model!"},
    ],
)
def test_bad_input_is_400_and_makes_no_call(keys_client, payload):
    client, rec = keys_client()
    r = client.post("/api/keys/test", json=payload)
    assert r.status_code == 400 and isinstance(r.get_json()["error"], str)
    assert rec.calls == []
    assert "x" * 600 not in r.get_data(as_text=True)


def test_non_json_body(keys_client):
    client, rec = keys_client()
    assert client.post("/api/keys/test", data="x", content_type="text/plain").status_code == 400
    assert rec.calls == []


def test_rate_limited(keys_client):
    client, rec = keys_client(RATE_LIMIT=(2, 60))
    for _ in range(2):
        assert client.post("/api/keys/test", json={"provider": "groq", "api_key": FAKE_KEY}).status_code == 200
    r = client.post("/api/keys/test", json={"provider": "groq", "api_key": FAKE_KEY})
    assert r.status_code == 429 and len(rec.calls) == 2


def test_key_never_in_response_or_logs(keys_client, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    odd_key = "my-custom-key-0123456789"  # no known prefix: only exact-match redaction catches it
    client, _ = keys_client()

    def crash(*a, **k):
        raise RuntimeError(f"internal failure with {odd_key}")

    monkeypatch.setattr(llm, "check_key", crash)
    r = client.post("/api/keys/test", json={"provider": "huggingface", "api_key": odd_key})
    data = r.get_json()
    assert r.status_code == 200 and data["ok"] is False and data["kind"] == "other"
    assert odd_key not in r.get_data(as_text=True) and odd_key not in caplog.text

    monkeypatch.setattr(llm, "check_key", lambda *a, **k: {"ok": False, "kind": "weird", "error": f"echo {odd_key}"})
    r = client.post("/api/keys/test", json={"provider": "huggingface", "api_key": odd_key})
    data = r.get_json()
    assert data["kind"] == "other" and odd_key not in r.get_data(as_text=True) and odd_key not in caplog.text


def test_engine_error_message_is_scrubbed(keys_client):
    key = "hf_FAKE0123456789abcdefghij"
    client, _ = keys_client(FakeResp(401, {"error": f"bad token {key}"}))
    r = client.post("/api/keys/test", json={"provider": "huggingface", "api_key": key})
    assert r.get_json()["kind"] == "invalid" and key not in r.get_data(as_text=True)


def test_check_key_rejects_colab_directly():
    with pytest.raises(llm.LLMError):
        llm.check_key("colab", FAKE_KEY)
