"""End-to-end R5 test (#32): Flask API -> real notes_engine.llm (provider "local") -> a fake
OpenAI-compatible server over real HTTP on 127.0.0.1, standing in for llama-server.

Proves: a full local job finishes; a job killed mid-way (server drops the connection during the
compose stage) is resumed from its per-video checkpoints by a resubmit (no map call is repeated);
/api/providers reports local online true/false. Offline and fast: ingest and pdf are fakes.
"""
import json
import re
import socket
import threading
import time
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from app import server as srv
from notes_engine import llm

VID = "abc123DEF45"
URL = f"https://www.youtube.com/watch?v={VID}"


def _section(i):
    return {"title": f"topic {i}", "subtitle": "sub", "timestamp": f"{i % 60:02d}:00",
            "blocks": [{"type": "paragraph", "text": f"text {i}"}],
            "key_takeaways": ["k1"], "recall": {"q": f"q{i}?", "a": f"a{i}"}}


FRONT = {"subtitle": "s", "cover": {"summary": "s", "big_idea": "b"},
         "glossary": [{"term": "cache", "definition": "fast store"}],
         "recap": {"title": "recap", "points": ["p1"], "diagram": None}}


class FakeLlama:
    """Canned llama-server: GET /v1/models, POST /v1/chat/completions."""

    def __init__(self):
        self.calls = []          # kinds of chat calls received
        self.crash_on = None     # kind whose request gets the connection dropped
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, obj, code=200):
                body = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if self.path.rstrip("/") == "/v1/models":
                    return self._send({"data": [{"id": "qwen3-8b"}]})
                self._send({"error": "nf"}, 404)

            def do_POST(self):
                req = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
                assert "Authorization" not in self.headers  # the local provider never sends a key
                system, user = (m["content"] for m in req["messages"])
                kind = fake.kind(system, user)
                fake.calls.append(kind)
                if kind == fake.crash_on:  # llama-server killed mid-request
                    self.close_connection = True
                    self.connection.shutdown(socket.SHUT_RDWR)
                    return
                self._send({"choices": [{"message": {"content": json.dumps(fake.answer(kind, user))},
                                         "finish_reason": "stop"}]})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    @staticmethod
    def kind(system, user):
        if system.startswith("You repair"):
            return "fix"
        if system.startswith("You are the first stage"):
            return "digest"
        if system.startswith("You merge"):
            return "merge"
        if "Write the complete field-notebook notes" in user:
            return "single"
        if "This is part" in user:
            return "batch"
        if "OUTLINE:" in user:
            return "final"
        return "?"

    def answer(self, kind, user):
        n = len(self.calls)
        if kind in ("digest", "merge"):
            starts = re.findall(r"\[([0-9:]+)\]", user)
            return {"topics": [{"heading": f"h{n}", "start": starts[0] if starts else "00:10",
                                "facts": [f"fact {n} " * 40 for _ in range(4)],
                                "terms": [{"term": f"t{n}", "definition": "d"}]}]}
        if kind == "batch":
            return {"sections": [_section(n * 10 + j) for j in range(3)]}
        if kind == "single":
            return {**FRONT, "sections": [_section(j) for j in range(6)]}
        return FRONT

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def _transcript(minutes=90):
    segs = [{"start": i * 10.0, "text": (f"point {i} about caching and consistency " * 6)[:160]}
            for i in range(minutes * 6)]
    return {"video_id": VID, "url": URL, "title": "Caching 101", "channel": "C",
            "duration_sec": minutes * 60, "language": "en", "source": "captions", "segments": segs}


def _modules():
    ingest = types.ModuleType("fake_ingest")
    ingest.IngestError = type("IngestError", (Exception,), {})
    ingest.parse_video_id = lambda url: VID

    def get_transcript(url, *, groq_key=None, progress=None, work_dir=None):
        if progress:
            progress("transcript", 50, "Transcribing audio 1/2 (00:00)...")
            progress("transcript", 100, "Transcribing audio 2/2 (00:45:00)...")
            time.sleep(0.2)  # long enough for the status poll to see the message
        return _transcript()

    ingest.get_transcript = get_transcript
    pdf = types.ModuleType("fake_pdf")
    pdf.PdfError = type("PdfError", (Exception,), {})
    pdf.render_html = lambda notes: "<html><body>%d sections</body></html>" % len(notes["sections"])

    def render_pdf(notes, out_path):
        Path(out_path).write_bytes(b"%PDF-1.4 fake")
        return out_path

    pdf.render_pdf = render_pdf
    return ingest, llm, pdf


@pytest.fixture
def stack(tmp_path, monkeypatch):
    for v in ("LNAI_CHECKPOINT_DIR", "LNA_PROVIDER_FALLBACK", *llm.SERVER_KEY_ENV.values()):
        monkeypatch.delenv(v, raising=False)
    monkeypatch.setattr(llm, "_sleep", lambda s: None)
    fake = FakeLlama()
    monkeypatch.setenv("LNAI_LOCAL_URL", f"http://127.0.0.1:{fake.port}/v1")
    app = srv.create_app({"OUTPUT_DIR": tmp_path / "out", "LOAD_DOTENV": False, "RATE_LIMIT": (100, 60)})
    state = app.extensions["lna"]
    monkeypatch.setattr(state, "load_modules", _modules)
    yield app.test_client(), fake, tmp_path / "out"
    fake.close()


def _wait(client, job_id, timeout=20):
    seen = []
    end = time.time() + timeout
    while time.time() < end:
        d = client.get(f"/api/jobs/{job_id}").get_json()
        seen.append(d)
        if d["status"] in ("done", "error"):
            return d, seen
        time.sleep(0.01)
    raise AssertionError("job did not finish")


def _local_row(client):
    rows = client.get("/api/providers").get_json()["providers"]
    return next(r for r in rows if r["id"] == "local")


def test_providers_online_flag_follows_server(stack, monkeypatch):
    client, fake, _ = stack
    row = _local_row(client)
    assert row["online"] is True and row["needs_key"] is False
    with socket.socket() as s:   # a port nobody listens on
        s.bind(("127.0.0.1", 0))
        dead = s.getsockname()[1]
    monkeypatch.setenv("LNAI_LOCAL_URL", f"http://127.0.0.1:{dead}/v1")
    assert _local_row(client)["online"] is False


def test_full_local_job_then_crash_and_resume(stack):
    client, fake, out = stack
    # 1) llama-server dies during the compose stage, after every map chunk was checkpointed
    fake.crash_on = "batch"
    r = client.post("/api/jobs", json={"url": URL, "provider": "local"})
    assert r.status_code == 202
    d, seen = _wait(client, r.get_json()["job_id"])
    assert d["status"] == "error", d
    assert "local model server" in d["error"]
    n_digest = fake.calls.count("digest")
    assert n_digest >= 2
    assert any(s.get("chunks") == n_digest for s in seen)  # chunk/chunks reached the status JSON
    ck = out / "checkpoints" / VID
    assert len(list(ck.glob("map-*.json"))) == n_digest

    # 2) server is back: resubmitting resumes; no map chunk is recomputed
    fake.crash_on = None
    fake.calls.clear()
    r = client.post("/api/jobs", json={"url": URL, "provider": "local"})
    d, seen = _wait(client, r.get_json()["job_id"])
    assert d["status"] == "done", d
    assert "digest" not in fake.calls and "batch" in fake.calls and fake.calls[-1] == "final"
    # transcript-stage progress ("Transcribing audio i/N") reaches the status JSON
    assert any("Transcribing audio" in (s.get("message") or "") for s in seen)
    files = d.get("links") or {}
    assert files, d
