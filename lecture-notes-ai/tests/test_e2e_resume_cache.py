"""F6 (#62) end-to-end: crash-then-resume with the notes cache ON.

Flask API -> real notes_engine.llm (provider "local") -> fake llama-server over real HTTP, with
LNA_CACHE_DIR pointing at a temp dir. Proves the resumed job reuses checkpoints and the cache (no
digest call repeated), and a later job for the same video with checkpoints wiped is served from the
cache with no extra digest/compose model calls. Also guards the demo import side-effect fix.
Offline: ingest and pdf are fakes, no model runs.
"""
import importlib.util
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_e2e_local as base  # noqa: E402  (reuse FakeLlama, fake modules and helpers)

from app import server as srv  # noqa: E402
from notes_engine import llm  # noqa: E402

DEMO = Path(__file__).resolve().parent.parent / "demo" / "smart_playlist" / "run_demo.py"


class RichFakeLlama(base.FakeLlama):
    """Answers each compose batch with plenty of sections, so the answer is accepted and cached."""

    def answer(self, kind, user):
        if kind == "batch":
            n = len(self.calls)
            return {"sections": [base._section(n * 100 + j) for j in range(40)]}
        return super().answer(kind, user)


@pytest.fixture
def cached_stack(tmp_path, monkeypatch):
    for v in ("LNAI_CHECKPOINT_DIR", "LNA_PROVIDER_FALLBACK", *llm.SERVER_KEY_ENV.values()):
        monkeypatch.delenv(v, raising=False)
    cache_dir = tmp_path / "cache"
    monkeypatch.setenv("LNA_CACHE_DIR", str(cache_dir))
    monkeypatch.setattr(llm, "_sleep", lambda s: None)
    fake = RichFakeLlama()
    monkeypatch.setenv("LNAI_LOCAL_URL", f"http://127.0.0.1:{fake.port}/v1")
    app = srv.create_app({"OUTPUT_DIR": tmp_path / "out", "LOAD_DOTENV": False, "RATE_LIMIT": (100, 60)})
    monkeypatch.setattr(app.extensions["lna"], "load_modules", base._modules)
    yield app.test_client(), fake, tmp_path / "out", cache_dir
    fake.close()


def _run(client):
    r = client.post("/api/jobs", json={"url": base.URL, "provider": "local"})
    assert r.status_code == 202
    d, _ = base._wait(client, r.get_json()["job_id"])
    return d


def test_crash_resume_with_cache_on_makes_no_extra_model_calls(cached_stack):
    client, fake, out, cache_dir = cached_stack

    # 1) llama-server dies in the compose stage; every map chunk is checkpointed AND cached
    fake.crash_on = "batch"
    d = _run(client)
    assert d["status"] == "error", d
    n_digest = fake.calls.count("digest")
    assert n_digest >= 2
    ck = out / "checkpoints" / base.VID
    assert len(list(ck.glob("map-*.json"))) == n_digest
    assert len(list((cache_dir / "digest").glob("*.json"))) == n_digest

    # 2) server back: the resumed job recomputes no digest
    fake.crash_on = None
    fake.calls.clear()
    d = _run(client)
    assert d["status"] == "done", d
    assert "digest" not in fake.calls and "batch" in fake.calls
    first_resume_calls = list(fake.calls)
    assert list((cache_dir / "compose").glob("*.json")), "accepted compose answer should be cached"

    # 3) checkpoints wiped (e.g. a new output dir): the cache alone covers digest and compose
    for p in ck.glob("*.json"):
        p.unlink()
    fake.calls.clear()
    d = _run(client)
    assert d["status"] == "done", d
    assert "digest" not in fake.calls and "batch" not in fake.calls, fake.calls
    assert len(fake.calls) <= len(first_resume_calls)


def test_importing_demo_has_no_env_side_effect(monkeypatch):
    monkeypatch.delenv("LNA_CACHE_DIR", raising=False)
    spec = importlib.util.spec_from_file_location("run_demo_import_check", DEMO)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert "LNA_CACHE_DIR" not in os.environ
    assert callable(mod.main)
