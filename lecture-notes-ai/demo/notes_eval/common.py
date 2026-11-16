"""Shared paths, contestants, key loading and instrumentation for the notes-provider evaluation.

API keys are read from backend/.env into memory only. They are never printed, logged or written.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent                      # lecture-notes-ai/
OUT = HERE / "out"
TRANSCRIPTS = OUT / "transcripts"
GOLD = OUT / "gold"
RUNS = OUT / "runs"
JUDGE = OUT / "judgements"
DEV_UI = Path(os.environ.get("LNAI_EVAL_DEV_UI") or (ROOT.parent / "aq-api" / "dev-ui"))
BLIND_SHEET = ROOT.parent / "docs" / "qa" / "r5-eval-blind.md"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

VIDEOS = {
    "WUvTyaaNkzM": "3Blue1Brown - Essence of calculus (17m)",
    "aircAruvnKk": "3Blue1Brown - Neural networks ch.1 (18m)",
    "IqQFaj3oO0Q": "Piyush Garg - Harness Engineering (14m)",
    "zjkBMFhNj_g": "Andrej Karpathy - Intro to LLMs (60m)",
}

# id -> provider, model (None = engine default), env var holding the key (None = keyless),
# url (local only: overrides LNAI_LOCAL_URL for this contestant)
CONTESTANTS = {
    "gemini": {"provider": "gemini", "model": None, "env": "GEMINI_API_KEY"},
    "groq": {"provider": "groq", "model": None, "env": "GROQ_API_KEY"},
    "nvidia-super": {"provider": "nvidia", "model": "nvidia/nemotron-3.5-super-vl-120b-a12b", "env": "NVIDIA_API_KEY"},
    "nvidia-lightning": {"provider": "nvidia", "model": "nvidia/nemotron-3.5-lightning-30b-a3b", "env": "NVIDIA_API_KEY"},
    "local": {"provider": "local", "model": None, "env": None, "url": None},
}
UNAVAILABLE = {
    "huggingface": "Hugging Face Inference: not available (no credits)",
}
KEY_ENV = {"gemini": "GEMINI_API_KEY", "groq": "GROQ_API_KEY", "nvidia": "NVIDIA_API_KEY",
           "xai": "XAI_API_KEY", "huggingface": "HF_TOKEN", "local": None}

# The judge. Default Gemini, which is ALSO a contestant: expect self-preference bias in its favour.
# Change with run_eval --judge groq | nvidia | local[:alias][@url] (see README "Judge bias").
SELECTED: list[str] = []   # contestants of the current run (aggregate only reports these)
JUDGE_PROVIDER = "gemini"
JUDGE_MODEL: str | None = None
JUDGE_URL: str | None = None


def _slug(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", s).strip("-").lower()


def parse_spec(spec: str) -> dict:
    """``provider[:model][@url]`` -> {provider, model, env, url}. ``@url`` is only allowed for local."""
    from notes_engine.llm import PROVIDERS
    spec = spec.strip()
    url = None
    if "@" in spec:
        spec, url = spec.split("@", 1)
        if not re.match(r"^https?://", url):
            raise ValueError(f"bad URL in contestant spec: {url!r}")
    prov, _, model = spec.partition(":")
    if prov not in PROVIDERS or prov == "colab":
        raise ValueError(f"unknown provider {prov!r}")
    if url and prov != "local":
        raise ValueError("@url is only allowed for the local provider")
    return {"provider": prov, "model": model or None, "env": KEY_ENV.get(prov), "url": url}


def register_contestant(spec: str) -> str:
    """A known id (gemini, groq, local, ...) or a spec such as ``local:qwen3.5-9b`` or
    ``local:gpt-oss-20b@http://127.0.0.1:8082/v1``; returns the contestant id used for out/ paths."""
    spec = spec.strip()
    if spec in CONTESTANTS:
        return spec
    cfg = parse_spec(spec)
    cid = _slug("-".join(x for x in (cfg["provider"], cfg["model"]) if x))
    if cfg["url"]:
        cid += "-" + hashlib.sha1(cfg["url"].encode()).hexdigest()[:6]
    CONTESTANTS[cid] = cfg
    return cid


def set_judge(spec: str) -> None:
    global JUDGE_PROVIDER, JUDGE_MODEL, JUDGE_URL
    cfg = CONTESTANTS[spec] if spec in CONTESTANTS else parse_spec(spec)
    JUDGE_PROVIDER, JUDGE_MODEL, JUDGE_URL = cfg["provider"], cfg["model"], cfg.get("url")


def judge_is_contestant(contestants: list[str]) -> list[str]:
    """Contestant ids that use the judge's provider (their scores are suspect: self-preference)."""
    return [c for c in contestants if CONTESTANTS[c]["provider"] == JUDGE_PROVIDER]


def set_out(path: Path) -> None:
    """Point every output path somewhere else (dry runs and tests never touch the real out/)."""
    global OUT, TRANSCRIPTS, GOLD, RUNS, JUDGE
    OUT = Path(path)
    TRANSCRIPTS, GOLD, RUNS, JUDGE = OUT / "transcripts", OUT / "gold", OUT / "runs", OUT / "judgements"


def model_of(cid: str) -> str:
    from notes_engine.llm import PROVIDERS
    c = CONTESTANTS[cid]
    return c["model"] or PROVIDERS[c["provider"]]["default_model"]


def judge_model() -> str:
    from notes_engine.llm import PROVIDERS
    return JUDGE_MODEL or PROVIDERS[JUDGE_PROVIDER]["default_model"]


# Env vars that would make an eval run differ from a clean app run, or leak state between runs.
_APP_ONLY_ENV = ("LNA_CACHE_DIR", "LNAI_CHECKPOINT_DIR", "LNA_PROVIDER_FALLBACK")


@contextlib.contextmanager
def clean_run_env(local_url: str | None = None):
    """Same engine path as the app, minus cache, checkpoints and provider fallback (a fallback would
    silently score another provider). ``local_url`` overrides LNAI_LOCAL_URL for the block."""
    saved = {k: os.environ.get(k) for k in (*_APP_ONLY_ENV, "LNAI_LOCAL_URL")}
    for k in _APP_ONLY_ENV:
        os.environ.pop(k, None)
    if local_url:
        os.environ["LNAI_LOCAL_URL"] = local_url
    try:
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


_KEYS: dict[str, str] = {}


def key(env: str | None) -> str:
    """Key from the process env or backend/.env (key names are whitespace-stripped). Never printed."""
    if not env:
        return ""
    if not _KEYS:
        try:
            from dotenv import dotenv_values
            for k, v in dotenv_values(ROOT / "backend" / ".env").items():
                if k and v:
                    _KEYS[k.strip()] = v.strip().strip("\"'")
        except Exception:  # noqa: BLE001
            pass
    return (os.environ.get(env) or _KEYS.get(env) or "").strip()


def read_json(p: Path) -> Any:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None


def write_json(p: Path, obj: Any) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, p)


def run_path(cid: str, vid: str, n: int) -> Path:
    return RUNS / cid / vid / f"{n}.json"


def transcript_text(t: dict) -> str:
    return "\n".join(str(s.get("text", "")) for s in t.get("segments", []))


_SKIP_KEYS = {"number", "next", "timestamp", "id", "type", "style", "language", "toc", "meta"}


def _strings(v: Any, out: list[str]) -> None:
    if isinstance(v, str):
        if v.strip():
            out.append(v.strip())
    elif isinstance(v, list):
        for x in v:
            _strings(x, out)
    elif isinstance(v, dict):
        for k, x in v.items():
            if k not in _SKIP_KEYS:
                _strings(x, out)


def notes_text(notes: dict) -> str:
    """Readable plain text of everything the notes say (titles, blocks, takeaways, diagrams, glossary, recap)."""
    parts: list[str] = []
    cov = notes.get("cover") or {}
    for k in ("summary", "big_idea"):
        if cov.get(k):
            parts.append(str(cov[k]))
    for s in notes.get("sections") or []:
        parts.append("## " + str(s.get("title", "")))
        rest = {k: v for k, v in s.items() if k != "title"}
        buf: list[str] = []
        _strings(rest, buf)
        parts.extend(buf)
    for g in notes.get("glossary") or []:
        parts.append(f"{g.get('term')}: {g.get('definition')}")
    buf = []
    _strings(notes.get("recap") or {}, buf)
    parts.extend(buf)
    return "\n".join(parts)


# ------------------------------------------------------------------ instrumentation ----
class Meter:
    """Counts HTTP requests, statuses, request time, provider-reported token usage and engine sleeps."""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.active = False
        self.requests = 0
        self.statuses: dict[str, int] = {}
        self.http_sec = 0.0
        self.sleep_sec = 0.0
        self.prompt_tokens = 0
        self.output_tokens = 0
        self.usage_reported = 0      # responses that carried usage
        self.ok_responses = 0


METER = Meter()
_installed = False


def install_meter() -> None:
    """Wrap notes_engine.llm's sleep and requests.post (in-process monkeypatch; engine files are untouched)."""
    global _installed
    if _installed:
        return
    from notes_engine import llm
    orig_sleep = llm._sleep
    orig_post = llm.requests.post

    def sleep(sec: float) -> None:
        if METER.active:
            METER.sleep_sec += max(0.0, sec)
        orig_sleep(sec)

    def post(*a, **kw):
        t0 = time.perf_counter()
        try:
            resp = orig_post(*a, **kw)
        except Exception as e:
            if METER.active:
                METER.requests += 1
                METER.http_sec += time.perf_counter() - t0
                n = type(e).__name__
                METER.statuses[n] = METER.statuses.get(n, 0) + 1
            raise
        if METER.active:
            METER.requests += 1
            METER.http_sec += time.perf_counter() - t0
            sc = str(resp.status_code)
            METER.statuses[sc] = METER.statuses.get(sc, 0) + 1
            if resp.status_code == 200:
                METER.ok_responses += 1
                try:
                    d = resp.json()
                except Exception:  # noqa: BLE001
                    d = None
                if isinstance(d, dict):
                    u = d.get("usageMetadata")
                    if isinstance(u, dict):
                        METER.usage_reported += 1
                        METER.prompt_tokens += int(u.get("promptTokenCount") or 0)
                        METER.output_tokens += int(u.get("candidatesTokenCount") or 0) + int(u.get("thoughtsTokenCount") or 0)
                    u = d.get("usage")
                    if isinstance(u, dict):
                        METER.usage_reported += 1
                        METER.prompt_tokens += int(u.get("prompt_tokens") or 0)
                        METER.output_tokens += int(u.get("completion_tokens") or 0)
        return resp

    llm._sleep = sleep
    llm.requests.post = post
    _installed = True


def classify_error(msg: str) -> str:
    m = (msg or "").lower()
    if "daily quota" in m:
        return "quota_daily"
    if "quota" in m or "rate limit" in m or "limit (asks to wait" in m:
        return "quota_429"
    if "output limit" in m or "token limit" in m:
        return "output_truncated"
    if "timeout" in m or "network error" in m or "could not reach" in m:
        return "timeout"
    if "json" in m or "could not be turned into notes" in m:
        return "invalid_json"
    if "http 401" in m or "http 403" in m or "http 404" in m or "no api key" in m:
        return "config"
    if "overloaded" in m or "temporarily unavailable" in m:
        return "server_5xx"
    return "other"


def scrub(s: str) -> str:
    s = re.sub(r"(AIza[0-9A-Za-z_\-]{20,}|gsk_[A-Za-z0-9]{20,}|nvapi-[A-Za-z0-9_\-]{20,}|hf_[A-Za-z0-9]{20,}"
               r"|xai-[A-Za-z0-9]{20,}|Bearer\s+\S+)", "[redacted]", s or "")
    for v in _KEYS.values():
        if len(v) >= 12:
            s = s.replace(v, "[redacted]")
    return s[:500]
