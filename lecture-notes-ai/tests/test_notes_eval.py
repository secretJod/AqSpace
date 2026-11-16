"""Card #75: the notes-provider evaluation runs through notes_engine with fakes only (no network)."""
from __future__ import annotations

import json
import os

import pytest
import requests

from demo.notes_eval import blind, common as C, evaluate, fakes, run_eval
from notes_engine import llm


@pytest.fixture(autouse=True)
def _isolated(monkeypatch, tmp_path):
    # monkeypatch records the originals, so whatever fakes.install() overwrites is restored afterwards
    monkeypatch.setattr(requests, "post", requests.post)
    monkeypatch.setattr(requests, "get", requests.get)
    monkeypatch.setattr(llm, "_sleep", llm._sleep)
    for k in ("GEMINI_API_KEY", "GROQ_API_KEY", "NVIDIA_API_KEY", "XAI_API_KEY", "HF_TOKEN", "LNAI_LOCAL_CTX",
              "LNAI_LOCAL_URL", "LNA_CACHE_DIR", "LNAI_CHECKPOINT_DIR", "LNA_PROVIDER_FALLBACK"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(C, "CONTESTANTS", dict(C.CONTESTANTS))
    monkeypatch.setattr(C, "VIDEOS", dict(C.VIDEOS))
    monkeypatch.setattr(C, "SELECTED", [])
    for name in ("OUT", "TRANSCRIPTS", "GOLD", "RUNS", "JUDGE", "JUDGE_PROVIDER", "JUDGE_MODEL", "JUDGE_URL"):
        monkeypatch.setattr(C, name, getattr(C, name))
    monkeypatch.setattr(evaluate, "JUDGE_PACE_SEC", evaluate.JUDGE_PACE_SEC)
    return tmp_path


def _dry(tmp_path, *extra):
    return run_eval.main(["--dry-run", "--runs", "1", "--out", str(tmp_path / "out"),
                          "--blind-sheet", str(tmp_path / "blind.md"), *extra])


def test_local_specs_register_as_contestants():
    assert C.register_contestant("local") == "local"
    cid = C.register_contestant("local:qwen3.5-9b")
    assert cid == "local-qwen3.5-9b"
    assert C.CONTESTANTS[cid] == {"provider": "local", "model": "qwen3.5-9b", "env": None, "url": None}
    cid2 = C.register_contestant("local:gpt-oss-20b@http://127.0.0.1:8082/v1")
    assert cid2.startswith("local-gpt-oss-20b-") and C.CONTESTANTS[cid2]["url"] == "http://127.0.0.1:8082/v1"
    with pytest.raises(ValueError):
        C.register_contestant("groq@http://x/v1")
    with pytest.raises(ValueError):
        C.register_contestant("nosuch")


def test_clean_run_env_turns_cache_checkpoints_fallback_off(monkeypatch):
    monkeypatch.setenv("LNA_CACHE_DIR", "/x")
    monkeypatch.setenv("LNAI_CHECKPOINT_DIR", "/y")
    monkeypatch.setenv("LNA_PROVIDER_FALLBACK", "1")
    with C.clean_run_env("http://127.0.0.1:9999/v1"):
        assert not any(os.environ.get(k) for k in ("LNA_CACHE_DIR", "LNAI_CHECKPOINT_DIR", "LNA_PROVIDER_FALLBACK"))
        assert os.environ["LNAI_LOCAL_URL"] == "http://127.0.0.1:9999/v1"
    assert os.environ["LNA_CACHE_DIR"] == "/x" and "LNAI_LOCAL_URL" not in os.environ


def test_dry_run_goes_through_engine_with_fakes(tmp_path):
    res = _dry(tmp_path, "--contestants", "gemini,groq,local,local:qwen3.5-9b@http://127.0.0.1:8082/v1",
               "--videos", "default")
    out = tmp_path / "out"
    cids = res["contestants"]
    for cid in cids:
        for vid in C.VIDEOS:
            r = json.loads((out / "runs" / cid / vid / "1.json").read_text())
            assert r["status"] == "success", r
            assert r["notes"]["meta"]["model"].startswith(r["provider"] + "/")
            assert r["timing"]["http_requests"] > 0          # real engine path, fake HTTP
    loc = json.loads((out / "runs" / cids[3] / "WUvTyaaNkzM" / "1.json").read_text())
    assert loc["model"] == "qwen3.5-9b" and loc["local_url"] == "http://127.0.0.1:8082/v1"
    ev = json.loads((out / "evaluation.json").read_text())
    assert [c["id"] for c in ev["contestants"]] and {c["id"] for c in ev["contestants"]} == set(cids)
    assert ev["judge"].startswith("gemini/")
    assert ev["judge_bias"]["self_judged_contestants"] == ["gemini"]


def test_dry_run_hits_only_fake_endpoints(tmp_path, monkeypatch):
    seen = []
    real_install = fakes.install

    def spy():
        f = real_install()
        seen.append(f)
        return f
    monkeypatch.setattr(fakes, "install", spy)
    _dry(tmp_path, "--contestants", "local:qwen3.5-9b", "--videos", "WUvTyaaNkzM")
    urls = {c["url"] for c in seen[0].calls}
    assert any("127.0.0.1:8081" in u for u in urls)      # local contestant
    assert any("generativelanguage" in u for u in urls)  # gemini judge (fake)
    assert all(c.get("model") in (None, "qwen3.5-9b", "gemini-3.5-flash-lite") for c in seen[0].calls)


def test_other_judge_removes_self_bias(tmp_path):
    _dry(tmp_path, "--contestants", "gemini,local", "--videos", "WUvTyaaNkzM", "--judge", "groq")
    ev = json.loads((tmp_path / "out" / "evaluation.json").read_text())
    assert ev["judge"].startswith("groq/") and ev["judge_bias"]["self_judged_contestants"] == []


def test_blind_sheet_hides_model_names(tmp_path):
    _dry(tmp_path, "--contestants", "gemini,groq,local", "--videos", "WUvTyaaNkzM,aircAruvnKk", "--no-judge")
    sheet = (tmp_path / "blind.md").read_text()
    for name in ("gemini", "groq", "qwen3-8b", "gpt-oss"):
        assert name not in sheet.lower()
    assert "| A |" in sheet and "| C |" in sheet and "Accuracy" in sheet
    key = json.loads((tmp_path / "out" / "blind-key.json").read_text())
    assert set(key["videos"]) == {"WUvTyaaNkzM", "aircAruvnKk"}
    assert {v["contestant"] for v in key["videos"]["WUvTyaaNkzM"].values()} == {"gemini", "groq", "local"}
    table = blind.reveal(tmp_path / "out" / "blind-key.json")
    assert "| WUvTyaaNkzM | A |" in table


def test_blind_sheet_seeded_shuffle_is_stable(tmp_path):
    _dry(tmp_path, "--contestants", "gemini,groq,local", "--videos", "WUvTyaaNkzM", "--no-judge")
    a = blind.build(["WUvTyaaNkzM"], ["gemini", "groq", "local"], seed=1)
    b = blind.build(["WUvTyaaNkzM"], ["gemini", "groq", "local"], seed=1)
    assert a == b


def test_fallback_answer_is_rejected(tmp_path, monkeypatch):
    fakes.install()
    C.set_out(tmp_path / "out")
    C.register_contestant("local")

    def fake_generate(transcript, **kw):
        return {"meta": {"model": "groq/openai/gpt-oss-120b"}, "sections": []}
    monkeypatch.setattr(llm, "generate_notes", fake_generate)
    rec = run_eval.generate("local", "v", 1, fakes.transcript("v", "t"))
    assert rec["status"] == "error" and "another provider" in rec["error"]
