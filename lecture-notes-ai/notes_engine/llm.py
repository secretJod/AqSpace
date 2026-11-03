"""LLM providers + notes generation (plain ``requests``, no vendor SDKs).

Pipeline
--------
* short lecture  -> ONE call that returns the whole Notes JSON ("single pass");
* long lecture   -> map-reduce:
    1. ``ingest.chunk_transcript`` -> N slices,
    2. one *digest* call per slice (compact facts only),
    3. digests are packed into batches; each batch is composed into 2-10 sections,
    4. one small final call writes subtitle / cover / glossary / recap from the outline,
    5. ``notes_schema.validate_notes`` coerces everything.
  Single pass falls back to map-reduce if the output is truncated or unusable.

Size / token reasoning (rough rule: 1 token ~ 3.3 chars of English transcript; one finished
notebook section is ~800 output tokens; the rules prompt + schema example ~2k tokens):
* Groq free tier (llama-3.3-70b-versatile) allows ~12k tokens/minute INCLUDING the requested
  ``max_tokens``.  So: digest call = 10k chars (3k) + 1k prompt + 1.5k out ~ 5.5k; compose batch =
  12k chars of digests (3.6k) + 2k prompt + 3.5k out ~ 9k; single pass = 8k chars (2.4k) + 2k +
  6k out ~ 10.4k.  A client-side pacer sleeps so the trailing-minute total stays under ~85 % of
  the limit, and 429s sleep per Retry-After / "try again in Xs".
* Gemini / xAI have huge contexts, so the limits there are *output* limits (2.5/3 models: 32k,
  older ones: 8k).  Single pass is only attempted when the expected notes (sections x 800 + 1.2k
  tokens) fit comfortably in the output budget.

The API key is only ever put in a request header (never a URL) and is scrubbed from every error
message.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import random
import re
import time
from pathlib import Path
from typing import Any, Callable

import requests

from . import cache, prompts
from .notes_schema import format_duration, validate_notes

# ------------------------------------------------------------ public API ----
PROVIDERS: dict[str, dict] = {
    "local": {
        "label": "Local model (Qwen3-8B)",
        "default_model": "qwen3-8b",
        "needs_key": False,
        "key_hint": "No key needed: runs on your own llama-server (LNAI_LOCAL_URL, default http://127.0.0.1:8081/v1; "
                    "an https URL plus LNAI_LOCAL_KEY for a remote/Colab server)",
    },
    "gemini": {
        "label": "Google Gemini",
        "default_model": "gemini-3.5-flash-lite",
        "needs_key": True,
        "key_hint": "Free key from aistudio.google.com/apikey (starts with AIza...)",
    },
    "groq": {
        "label": "Groq",
        "default_model": "openai/gpt-oss-120b",
        "needs_key": True,
        "key_hint": "Free key from console.groq.com/keys (starts with gsk_...)",
    },
    "xai": {
        "label": "xAI Grok",
        "default_model": "grok-4",
        "needs_key": True,
        "key_hint": "Key from console.x.ai (starts with xai-...)",
    },
    "huggingface": {
        "label": "Hugging Face",
        "default_model": "meta-llama/Llama-3.3-70B-Instruct",
        "needs_key": True,
        "key_hint": "Access token from huggingface.co/settings/tokens with 'Inference Providers' permission (hf_...)",
    },
    "nvidia": {
        "label": "NVIDIA Nemotron",
        "default_model": "nvidia/nemotron-3.5-super-vl-120b-a12b",
        "needs_key": True,
        "key_hint": "Free key from build.nvidia.com (starts with nvapi-...)",
    },
    # DEPRECATED alias of "local" (ADR-0004, kept for one release): runs the local provider against
    # COLAB_LLM_URL with COLAB_LLM_KEY and the local-small profile. Prefer LNAI_LOCAL_URL + LNAI_LOCAL_KEY.
    "colab": {
        "label": "Colab Qwen3-8B (deprecated: use Local)",
        "default_model": "qwen3-8b",
        "needs_key": True,
        "deprecated": True,
        "alias_of": "local",
        "key_hint": "Deprecated: set LNAI_LOCAL_URL (https) and LNAI_LOCAL_KEY and choose Local. "
                    "Still reads COLAB_LLM_URL and COLAB_LLM_KEY from backend/.env for one release.",
    },
}

_ENDPOINTS = {
    "groq": "https://api.groq.com/openai/v1/chat/completions",
    "xai": "https://api.x.ai/v1/chat/completions",
    "huggingface": "https://router.huggingface.co/v1/chat/completions",
    "nvidia": "https://integrate.api.nvidia.com/v1/chat/completions",
}
LOCAL_URL_DEFAULT = "http://127.0.0.1:8081/v1"
_GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


def _colab_base_url() -> str:
    """Deprecated alias: the Colab server's base URL (a cloudflared link) from COLAB_LLM_URL, as an
    OpenAI-compatible ``.../v1`` base for the local provider."""
    base = (os.environ.get("COLAB_LLM_URL") or "").strip().rstrip("/").removesuffix("/v1")
    if not re.fullmatch(r"https://[A-Za-z0-9.\-]+(:\d+)?", base):
        raise LLMError("COLAB_LLM_URL is not set to the https link printed by the Colab server cell.")
    return base + "/v1"

Progress = Callable[[str, int, str], None]


class LLMError(Exception):
    """User-safe error message (never contains the API key)."""


class _BadJSON(LLMError):
    """The model kept returning unparseable JSON."""


class _OutputTruncated(LLMError):
    """The model hit its output-token limit (``text`` = what it produced before the cut)."""

    def __init__(self, message: str, text: str = ""):
        super().__init__(message)
        self.text = text


class _TransientError(LLMError):
    """Rate limit (429), server error (5xx) or timeout - another provider may still work."""


class _HTTPStatusError(LLMError):
    def __init__(self, message: str, status: int, detail: str = "", payload: Any = None):
        super().__init__(message)
        self.status, self.detail, self.payload = status, detail, payload


# ----------------------------------------------------------- tunables -------
CONNECT_TIMEOUT = 15
READ_TIMEOUT = 240
MAX_ATTEMPTS = 5              # per HTTP call (429 / 5xx / network)
MAX_RETRY_WAIT = 75           # seconds we are willing to sleep for one retry
BACKOFF_BASE = 2.0
SECTION_TOKENS = 800          # expected output tokens per finished section
CHARS_PER_TOKEN = 3.3

LOCAL_READ_TIMEOUT = 1800   # one compose on an M2 at ~10-20 tok/s can take several minutes
LOCAL_MAX_ATTEMPTS = 2       # a local server that is down will not come back by retrying 5 times

_BASE_PROFILES: dict[str, dict] = {
    # Qwen3-8B Q4_K_M on llama.cpp, ctx 16384, 1 slot (numbers from ADR-0003). The biggest call
    # stays <= ~14k tokens (tokens ~ chars/3.3 worst case; Qwen's tokenizer is nearer chars/4):
    #   digest  : 24k chars (6-7k) + 0.8k prompt + 1.5k out             ~ 9k
    #   compose : 20k chars of digests (5-6k) + 2.8k rules/example + 6k out ~ 14k
    #   final   : outline (trimmed to fit) + 4k out + 1.5k thinking
    # No rate limits -> no pacer. Thinking off for map/merge/compose, on for the final call.
    "local": dict(single_chars=12000, chunk_chars=24000, batch_chars=20000, digest_cap=2500,
                  digest_out=1500, out_single=6000, out_batch=6000, tpm=None, final_out=4000,
                  final_reasoning_reserve=1500, max_total_sections=200, merge_budget_chars=60000,
                  merge_fanout=8, read_timeout=LOCAL_READ_TIMEOUT, ctx_tokens=16384),
    # single_chars: biggest transcript (chars) attempted in one call
    # chunk_chars: map-stage slice size; batch_chars: digest text per compose call
    "gemini": dict(single_chars=90000, chunk_chars=36000, batch_chars=40000, digest_cap=5000,
                   digest_out=3000, out_single=None, out_batch=None, tpm=None),
    "groq": dict(single_chars=8000, chunk_chars=10000, batch_chars=12000, digest_cap=3000,
                 digest_out=1500, out_single=6000, out_batch=3500, tpm=12000),
    "xai": dict(single_chars=100000, chunk_chars=40000, batch_chars=40000, digest_cap=5000,
                digest_out=3000, out_single=16000, out_batch=12000, tpm=None),
    "huggingface": dict(single_chars=20000, chunk_chars=10000, batch_chars=14000, digest_cap=3500,
                        digest_out=2000, out_single=8000, out_batch=5000, tpm=None),
    # NVIDIA NIM free tier: ~40 requests/minute, no daily token cap; large-context Nemotron models
    "nvidia": dict(single_chars=40000, chunk_chars=20000, batch_chars=20000, digest_cap=4000,
                   digest_out=2500, out_single=12000, out_batch=8000, tpm=None),
    # self-hosted Qwen3-8B (llama.cpp on a Colab T4, 16k context, ~33 tok/s): small slices keep every
    # call well inside the context window and each call short
    # local-small: the same Qwen3-8B on a llama-server with <= 8K context (upstream's Colab T4 sizes).
    # Chosen when the server reports n_ctx <= SMALL_CTX_MAX (or LNAI_LOCAL_CTX says so), and always
    # for the deprecated "colab" alias. Small slices keep every call inside the window.
    "local-small": dict(single_chars=6000, chunk_chars=8000, batch_chars=8000, digest_cap=2500,
                        digest_out=1500, out_single=5000, out_batch=4000, tpm=None, final_out=3000,
                        final_reasoning_reserve=0, max_total_sections=200, merge_budget_chars=40000,
                        merge_fanout=8, read_timeout=LOCAL_READ_TIMEOUT, ctx_tokens=8192),
}
SMALL_CTX_MAX = 8192


def _profile(provider: str, model: str) -> dict:
    """Tunables for a provider id or a profile name ("local-small")."""
    p = dict(_BASE_PROFILES[provider])
    ml = model.lower()
    if provider == "gemini":
        big = re.search(r"gemini-(2\.5|3)", ml) is not None
        out = 32768 if big else 8192
        p["out_single"], p["out_batch"] = out, min(out, 16000)
    if provider == "groq" and "gpt-oss" in ml:
        # gpt-oss-120b / -20b on the Groq free tier: ~8k tokens/minute (input + max_tokens), and they
        # are reasoning models: reasoning tokens are billed against max_tokens, so every call reserves
        # ~1.2k of its budget for them (reasoning_effort "low" keeps it near that).
        # Per request (tokens ~ chars/3.3; rules prompt ~1.3k):
        #   digest  : 5k chars (1.5k) + 0.7k prompt + 2k out            ~ 4.2k
        #   compose : 4k chars of digests (1.2k) + 1.9k prompt + 3k out ~ 6.1k   (<= 85 % of 8k = 6.8k)
        # A single pass never fits (6+ sections need > 6k output tokens) -> always map-reduce.
        p.update(single_chars=2500, chunk_chars=5000, batch_chars=4000, digest_cap=2000,
                 digest_out=2000, out_single=3000, out_batch=3000, tpm=8000,
                 reasoning_effort="low", reasoning_reserve=1200, final_out=2800)
    elif provider == "groq" and "qwen" in ml:
        # qwen3.x on Groq free tier: ~6k tokens/minute. Thinking is switched off (reasoning_effort
        # "none"; dropped automatically if the model rejects it) and <think> blocks are stripped.
        p.update(single_chars=2000, chunk_chars=4000, batch_chars=3000, digest_cap=1600,
                 digest_out=1600, out_single=2500, out_batch=2500, tpm=6000,
                 reasoning_effort="none", reasoning_reserve=500, final_out=2200)
    elif provider == "groq" and re.search(r"(^|[-/])8b|instant", ml):
        # llama-3.1-8b-instant: only ~6k tokens/minute on the free tier
        p.update(single_chars=3000, chunk_chars=5000, batch_chars=6000, digest_cap=2000,
                 digest_out=1000, out_single=3000, out_batch=2000, tpm=6000)
    p.setdefault("reasoning_effort", None)   # sent to the provider when set (Groq reasoning models)
    p.setdefault("reasoning_reserve", 0)     # output tokens a reasoning model may burn before the answer
    p.setdefault("final_out", 3000)
    p.setdefault("final_reasoning_reserve", 0)  # thinking budget for the final call only (local)
    p.setdefault("max_total_sections", 18)      # cap on the whole notebook (cloud: keep it short)
    p.setdefault("merge_budget_chars", None)    # digests above this -> hierarchical merge levels
    p.setdefault("merge_fanout", 8)
    p.setdefault("read_timeout", READ_TIMEOUT)
    p.setdefault("ctx_tokens", None)
    # sections one compose call can reliably return: answer budget = out_batch - reasoning reserve
    answer = p["out_batch"] - p["reasoning_reserve"]
    p["max_sections_per_call"] = max(1, min(10, int(answer * 0.9 / SECTION_TOKENS)))
    return p


def local_key() -> str:
    """Optional Bearer key for a remote local server (LNAI_LOCAL_KEY); empty for a plain local llama-server."""
    key = (os.environ.get("LNAI_LOCAL_KEY") or "").strip()
    if key and (not key.isascii() or re.search(r"\s", key)):
        raise LLMError("LNAI_LOCAL_KEY contains spaces or unusual characters.")
    return key


_CTX_SEEN: dict[str, int | None] = {}


def local_server_ctx(base: str | None = None, key: str | None = None, timeout: float = 2.0) -> int | None:
    """Context size of the local server: LNAI_LOCAL_CTX if set, else llama-server's ``/props`` n_ctx
    (asked once per URL; skipped when LNA_OFFLINE=1). None when unknown."""
    env = (os.environ.get("LNAI_LOCAL_CTX") or "").strip()
    if env:
        try:
            return int(env)
        except ValueError:
            return None
    if (os.environ.get("LNA_OFFLINE") or "").strip().lower() in ("1", "true", "yes"):
        return None
    base = base or local_base_url()
    if base in _CTX_SEEN:
        return _CTX_SEEN[base]
    n = None
    try:
        headers = {"Authorization": f"Bearer {key}"} if key else {}
        r = requests.get(base.removesuffix("/v1") + "/props", headers=headers, timeout=timeout)
        if r.status_code == 200:
            d = r.json()
            n = int((d.get("default_generation_settings") or {}).get("n_ctx") or d.get("n_ctx") or 0) or None
    except Exception:  # noqa: BLE001 - unknown ctx just means the default profile
        n = None
    _CTX_SEEN[base] = n
    return n


def local_profile_name(ctx: int | None, force_small: bool = False) -> str:
    return "local-small" if force_small or (ctx is not None and ctx <= SMALL_CTX_MAX) else "local"


def local_base_url() -> str:
    """OpenAI-compatible base URL of the local llama-server (LNAI_LOCAL_URL; http or https)."""
    url = (os.environ.get("LNAI_LOCAL_URL") or "").strip() or LOCAL_URL_DEFAULT
    if not re.match(r"^https?://[^\s/]+", url):
        raise LLMError("LNAI_LOCAL_URL must be an http(s) URL such as http://127.0.0.1:8081/v1.")
    return url.rstrip("/")


def local_online(timeout: float = 1.0) -> bool:
    """True if the local llama-server answers GET <LNAI_LOCAL_URL>/models."""
    try:
        key = local_key()
        headers = {"Authorization": f"Bearer {key}"} if key else {}
        return requests.get(local_base_url() + "/models", headers=headers, timeout=timeout).status_code == 200
    except Exception:  # noqa: BLE001
        return False


# ----------------------------------------------------------- utilities ------
def _sleep(sec: float) -> None:
    time.sleep(max(0.0, sec))


_KEY_PATTERNS = re.compile(
    r"(AIza[0-9A-Za-z_\-]{20,}|gsk_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}"
    r"|sk-[A-Za-z0-9_\-]{20,}|Bearer\s+[A-Za-z0-9._\-]{12,})")


def _scrub(text: Any, key: str | None, limit: int = 300) -> str:
    s = str(text or "")
    if key:
        s = s.replace(key, "***")
    s = _KEY_PATTERNS.sub("***", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= limit else s[: limit - 1] + "…"


def _parse_retry_delay(resp: Any) -> float | None:
    """Seconds to wait, from Retry-After header or provider-specific body hints."""
    try:
        ra = resp.headers.get("Retry-After") or resp.headers.get("retry-after")
    except Exception:  # noqa: BLE001
        ra = None
    if ra:
        try:
            return max(0.0, float(ra))
        except ValueError:
            pass
    body = ""
    try:
        body = resp.text or ""
    except Exception:  # noqa: BLE001
        pass
    m = re.search(r'"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"', body)  # Gemini
    if m:
        return float(m.group(1))
    m = re.search(r"try again in\s+(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)(ms|s))?", body)  # Groq
    if m and any(m.groups()[:3]):
        h, mi, sec, unit = m.groups()
        total = int(h or 0) * 3600 + int(mi or 0) * 60
        if sec:
            total += float(sec) / (1000 if unit == "ms" else 1)
        return total
    return None


def _daily_quota_hit(body: str) -> bool:
    b = body.lower()
    return any(t in b for t in ("perday", "per day", "tokens per day", "(tpd)", "requests per day",
                                "(rpd)", "daily limit", "daily quota", '"limit": 0', "limit: 0"))


class _Pacer:
    """Keeps estimated tokens in the trailing 60 s under ``tpm * 0.85`` (Groq free tier)."""

    def __init__(self, tpm: int | None):
        self.budget = int(tpm * 0.85) if tpm else None
        self.log: list[tuple[float, int]] = []

    def before(self, est_tokens: int) -> None:
        if not self.budget:
            return
        now = time.monotonic()
        self.log = [(t, n) for t, n in self.log if now - t < 60]
        while self.log and sum(n for _, n in self.log) + est_tokens > self.budget:
            t0, _n = self.log[0]
            wait = t0 + 60 - time.monotonic()
            if wait > 0:
                _sleep(wait + 0.5)
            self.log.pop(0)  # explicit pop: terminates even when sleep is mocked

    def after(self, est_tokens: int) -> None:
        if self.budget:
            self.log.append((time.monotonic(), est_tokens))


# ------------------------------------------------------------- JSON repair --
def _strip_fences(text: str) -> str:
    t = text.strip()
    m = re.match(r"^```[a-zA-Z0-9_-]*\s*\n?(.*?)\n?```\s*$", t, re.S)
    if m:
        return m.group(1).strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", t)
        t = re.sub(r"```\s*$", "", t)
    return t.strip()


def _outermost(text: str) -> str | None:
    """Substring from the first '{' or '[' to its matching closer (string-aware)."""
    starts = [i for i in (text.find("{"), text.find("[")) if i >= 0]
    if not starts:
        return None
    start = min(starts)
    stack: list[str] = []
    in_str = esc = False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c in "{[":
            stack.append("}" if c == "{" else "]")
        elif c in "}]":
            if stack and stack[-1] == c:
                stack.pop()
                if not stack:
                    return text[start:i + 1]
            else:
                return None
    return None


def _loads(s: str) -> Any:
    try:
        return json.loads(s, strict=False)
    except json.JSONDecodeError:
        fixed = re.sub(r",\s*([}\]])", r"\1", s)  # trailing commas
        return json.loads(fixed, strict=False)


def parse_json(text: str) -> Any:
    """Parse model output into a dict/list: strips ``` fences, extracts the outermost {...}."""
    if not text or not text.strip():
        raise ValueError("empty response")
    cleaned = _strip_fences(text)
    candidates = [cleaned]
    outer = _outermost(cleaned)
    if outer and outer != cleaned:
        candidates.append(outer)
    last: Exception | None = None
    for c in candidates:
        try:
            val = _loads(c)
            if isinstance(val, (dict, list)):
                return val
        except json.JSONDecodeError as e:
            last = e
    raise ValueError(str(last) if last else "no JSON object found")


def salvage_truncated_json(text: str) -> Any:
    """Best-effort close of JSON cut off by an output limit (drops the dangling tail)."""
    s = _strip_fences(text)
    start = min([i for i in (s.find("{"), s.find("[")) if i >= 0] or [-1])
    if start < 0:
        raise ValueError("no JSON found")
    s = s[start:]
    for _ in range(80):
        stack: list[str] = []
        in_str = esc = False
        for c in s:
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
            elif c == '"':
                in_str = True
            elif c in "{[":
                stack.append("}" if c == "{" else "]")
            elif c in "}]" and stack:
                stack.pop()
        cand = s + ('"' if in_str else "")
        cand = re.sub(r",\s*$", "", cand) + "".join(reversed(stack))
        try:
            val = _loads(cand)
            if isinstance(val, (dict, list)):
                return val
        except json.JSONDecodeError:
            pass
        cut = s.rfind(",")
        if cut <= 0:
            break
        s = s[:cut]
    raise ValueError("could not salvage truncated JSON")


# ------------------------------------------------------------------ client --
class _Client:
    def __init__(self, provider: str, api_key: str, model: str, *, base_url: str | None = None,
                 profile_name: str | None = None, cache_writes: bool = True):
        self.provider, self.key, self.model = provider, api_key, model
        self.label = PROVIDERS[provider]["label"]
        self.base_url = base_url  # local only: overrides LNAI_LOCAL_URL (deprecated colab alias)
        self.profile_name = profile_name or provider
        self.profile = _profile(self.profile_name, model)
        # False on a fallback run: answers from a stand-in provider never go into the shared cache
        self.cache_writes = cache_writes
        self.pacer = _Pacer(self.profile["tpm"])
        self.json_mode = True  # flips to False if an OpenAI-compatible provider rejects it
        self.reasoning_effort = self.profile["reasoning_effort"]  # flips to None if rejected

    # -- request construction (kept separate so tests can assert on it) --
    def build_request(self, system: str, user: str, max_tokens: int, temperature: float,
                      think: bool = False) -> tuple[str, dict, dict]:
        if self.provider == "gemini":
            url = _GEMINI_URL.format(model=self.model)
            headers = {"x-goog-api-key": self.key, "Content-Type": "application/json"}
            body = {
                "systemInstruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": [{"text": user}]}],
                "generationConfig": {"responseMimeType": "application/json",
                                     "temperature": temperature, "maxOutputTokens": max_tokens},
            }
            return url, headers, body
        local = self.provider == "local"
        if local:
            url = (self.base_url or local_base_url()) + "/chat/completions"
            headers = {"Content-Type": "application/json"}
            if self.key:  # only the server-side LNAI_LOCAL_KEY (or COLAB_LLM_KEY); never a typed key
                headers["Authorization"] = f"Bearer {self.key}"
            if not think and "qwen3" in self.model.lower():
                user = user + "\n/no_think"
        else:
            url = _ENDPOINTS[self.provider]
            headers = {"Authorization": f"Bearer {self.key}", "Content-Type": "application/json"}
        body = {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if local:
            body["chat_template_kwargs"] = {"enable_thinking": bool(think)}
            body["cache_prompt"] = True  # llama-server reuses the shared rules-prompt KV cache
        # a JSON grammar would forbid the <think> block, so thinking calls rely on parse/repair
        if self.json_mode and not (local and think):
            body["response_format"] = {"type": "json_object"}
        if self.reasoning_effort and self.provider == "groq":
            body["reasoning_effort"] = self.reasoning_effort
        return url, headers, body

    # -- HTTP with retries --
    def _post(self, url: str, headers: dict, body: dict) -> dict:
        last_status = None
        local = self.provider == "local"
        attempts = LOCAL_MAX_ATTEMPTS if local else MAX_ATTEMPTS
        for attempt in range(attempts):
            try:
                resp = requests.post(url, headers=headers, json=body,
                                     timeout=(CONNECT_TIMEOUT, self.profile["read_timeout"]))
            except (requests.Timeout, requests.ConnectionError) as e:
                last_status = type(e).__name__
                if attempt + 1 >= attempts:
                    if local:
                        raise _TransientError(
                            "The local model server is not reachable at LNAI_LOCAL_URL "
                            f"({_scrub(self.base_url or local_base_url(), self.key, 80)}). Start llama-server and try again.") from None
                    raise _TransientError(f"Could not reach {self.label} (network error or timeout) after "
                                   f"{MAX_ATTEMPTS} tries. Check your connection and try again.") from None
                _sleep(self._backoff(attempt))
                continue
            except requests.RequestException:
                raise LLMError(f"Network error while contacting {self.label}.") from None

            sc = resp.status_code
            if sc == 200:
                try:
                    return resp.json()
                except ValueError:
                    raise LLMError(f"{self.label} returned a response that is not valid JSON.") from None
            body_text = ""
            try:
                body_text = resp.text or ""
            except Exception:  # noqa: BLE001
                pass
            if sc == 429 and _daily_quota_hit(body_text):
                raise _TransientError(self._quota_message("daily quota"))
            if sc in (408, 429, 500, 502, 503, 504, 529):
                last_status = sc
                wait = _parse_retry_delay(resp)
                if wait is not None and wait > 90:
                    raise _TransientError(self._quota_message(f"limit (asks to wait {int(wait)} s)")) if sc == 429 else \
                        _TransientError(f"{self.label} is overloaded (HTTP {sc}); try again later.")
                if attempt + 1 >= attempts:
                    break
                _sleep(min(MAX_RETRY_WAIT, (wait + 0.5) if wait is not None else self._backoff(attempt)))
                continue
            raise self._http_error(sc, resp, body_text)
        if last_status == 429:
            raise _TransientError(self._quota_message("rate limit"))
        raise _TransientError(f"{self.label} is temporarily unavailable (HTTP {last_status}) after "
                       f"{attempts} tries. Please try again in a few minutes.")

    @staticmethod
    def _backoff(attempt: int) -> float:
        return min(MAX_RETRY_WAIT, BACKOFF_BASE * (2 ** attempt)) + random.uniform(0, 1)

    def _quota_message(self, what: str) -> str:
        extra = {
            "gemini": "Free-tier Gemini keys allow only a few requests per minute and a limited number per day.",
            "groq": "Groq's free tier caps tokens per minute and per day.",
        }.get(self.provider, "Free-tier or low-credit keys have strict rate limits.")
        return (f"{self.label} {what} reached. {extra} Wait a minute (or until tomorrow for daily caps), "
                "pick a smaller/different model, or switch provider and retry.")

    def _http_error(self, sc: int, resp: Any, body_text: str) -> _HTTPStatusError:
        payload = None
        try:
            payload = resp.json()
        except Exception:  # noqa: BLE001
            pass
        err = payload.get("error") if isinstance(payload, dict) else None
        if isinstance(err, dict):
            detail = _to_s(err.get("message")) or body_text
        else:
            detail = _to_s(err) or body_text
        detail = _scrub(detail, self.key)
        if sc in (401, 403):
            msg = (f"{self.label} rejected the API key (HTTP {sc}). Check that the key is pasted correctly, "
                   f"is active, and belongs to {self.label}"
                   + (" (and that the Generative Language API is enabled for it)." if self.provider == "gemini" else ".")
                   + (f" Server said: {detail}" if detail else ""))
        elif sc == 404:
            msg = (f"{self.label} does not know the model '{_scrub(self.model, self.key, 80)}' (HTTP 404). "
                   f"Pick a valid model id (default: {PROVIDERS[self.provider]['default_model']}).")
        elif sc == 413:
            msg = (f"The request was too large for {self.label}'s limits (HTTP 413). Try a shorter video "
                   "or a model/provider with a bigger context window.")
        elif sc == 402:
            msg = f"{self.label} says the account has no credits left (HTTP 402)."
        else:
            msg = f"{self.label} rejected the request (HTTP {sc})." + (f" Server said: {detail}" if detail else "")
        code = _to_s(err.get("code")) + " " + _to_s(err.get("type")) if isinstance(err, dict) else ""
        return _HTTPStatusError(msg, sc, (detail + " " + code).lower(), payload)

    # -- one completion: returns (text, truncated) --
    def complete(self, system: str, user: str, max_tokens: int, temperature: float = 0.3,
                 think: bool = False) -> tuple[str, bool]:
        est = int((len(system) + len(user)) / CHARS_PER_TOKEN) + max_tokens
        for _ in range(4):  # at most: normal, then without JSON mode / reasoning_effort
            url, headers, body = self.build_request(system, user, max_tokens, temperature, think)
            self.pacer.before(est)
            try:
                data = self._post(url, headers, body)
            except _HTTPStatusError as e:
                self.pacer.after(est)
                if self.provider != "gemini" and e.status in (400, 422):
                    failed = _failed_generation(e.payload)
                    if failed and "json_validate_failed" in e.detail:
                        return failed, False  # Groq hands back the invalid text: let the repair stage fix it
                    if self.reasoning_effort and "reasoning" in e.detail:
                        self.reasoning_effort = None
                        continue
                    if self.json_mode and any(t in e.detail for t in
                                              ("response_format", "json_object", "json mode", "json_schema", "json_validate")):
                        self.json_mode = False
                        continue
                raise
            self.pacer.after(est)
            return self._extract(data)
        raise LLMError(f"{self.label} did not accept the request.")

    def _extract(self, data: dict) -> tuple[str, bool]:
        if self.provider == "gemini":
            pf = _dict(data.get("promptFeedback"))
            if pf.get("blockReason"):
                raise LLMError(f"Gemini blocked the request for safety reasons ({pf['blockReason']}). "
                               "Try a different video or model.")
            cands = data.get("candidates") or []
            if not cands:
                raise LLMError("Gemini returned no answer (empty response). Try again or choose another model.")
            c = _dict(cands[0])
            fr = str(c.get("finishReason") or "")
            parts = _dict(c.get("content")).get("parts") or []
            text = "".join(_to_s(p.get("text")) for p in parts if isinstance(p, dict) and not p.get("thought"))
            if fr in ("SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION") and not text.strip():
                raise LLMError(f"Gemini's safety filter stopped the answer ({fr}). Try a different model or video.")
            return text, fr == "MAX_TOKENS"
        choices = data.get("choices") or []
        if not choices:
            raise LLMError(f"{self.label} returned no answer (empty response).")
        ch = _dict(choices[0])
        msg = _dict(ch.get("message"))
        content = msg.get("content")
        if isinstance(content, list):
            content = "".join(_to_s(p.get("text") if isinstance(p, dict) else p) for p in content)
        content = re.sub(r"<think>.*?</think>", "", content or "", flags=re.S)  # qwen-style reasoning
        if "<think>" in content:  # reasoning cut off before it closed: nothing usable after it
            content = content.split("<think>", 1)[0]
        fr = str(ch.get("finish_reason") or "")
        if fr == "content_filter" and not content:
            raise LLMError(f"{self.label}'s content filter blocked the answer. Try a different model or video.")
        return content or "", fr == "length"

    # -- JSON helpers --
    def ask_json(self, messages: tuple[str, str], max_tokens: int, temperature: float = 0.3,
                 think: bool = False) -> Any:
        system, user = messages
        text, truncated = self.complete(system, user, max_tokens, temperature, think)
        try:
            return parse_json(text)
        except ValueError as e:
            err = str(e)
        if truncated:
            raise _OutputTruncated("model output hit its token limit", text)
        fsys, fuser = prompts.fix_json_messages(text, err)
        fixed, trunc2 = self.complete(fsys, fuser, max_tokens, 0.0)
        try:
            return parse_json(fixed)
        except ValueError:
            if trunc2:
                raise _OutputTruncated("model output hit its token limit", fixed) from None
            raise _BadJSON(f"{self.label} returned malformed JSON twice. Try again, or pick a different model.") from None


def _to_s(v: Any) -> str:
    return v if isinstance(v, str) else ("" if v is None else str(v))


def _dict(v: Any) -> dict:
    return v if isinstance(v, dict) else {}


def _failed_generation(payload: Any) -> str | None:
    err = _dict(_dict(payload).get("error"))
    fg = err.get("failed_generation")
    return fg if isinstance(fg, str) and fg.strip() else None


# -------------------------------------------------------------- pipeline ----
def _get_chunker() -> Callable[..., list[dict]]:
    from .ingest import chunk_transcript  
    return chunk_transcript


class _Reporter:
    def __init__(self, cb: Progress | None):
        self.cb = cb

    def __call__(self, pct: int, msg: str) -> None:
        if self.cb:
            try:
                self.cb("notes", max(0, min(100, int(pct))), msg)
            except Exception:  # noqa: BLE001 - a broken progress callback must not kill the job
                pass


def _looks_like_section(v: Any) -> bool:
    return isinstance(v, dict) and ("blocks" in v or "key_takeaways" in v) and ("title" in v or "heading" in v)


def _as_section_list(obj: Any, _depth: int = 0) -> list:
    """Find the sections in whatever shape the model chose: {"sections": [...]}, {"pages": [...]},
    {"section": {...}}, a bare section object, a bare list, or any of these nested one level down."""
    if _depth > 3:
        return []
    if isinstance(obj, list):
        if any(_looks_like_section(v) for v in obj):
            return [v for v in obj if isinstance(v, dict)]
        found = [s for v in obj for s in _as_section_list(v, _depth + 1)]
        return found or obj
    if not isinstance(obj, dict):
        return []
    if _looks_like_section(obj):
        return [obj]
    for k in ("sections", "pages", "notebook_pages", "notes", "section", "page", "items"):
        if k in obj:
            got = _as_section_list(obj[k], _depth + 1)
            if got:
                return got
    for v in obj.values():
        if isinstance(v, (dict, list)):
            got = _as_section_list(v, _depth + 1)
            if got:
                return got
    return []


def _meta_for_prompt(transcript: dict) -> dict:
    return {"title": transcript.get("title") or "", "channel": transcript.get("channel") or "",
            "duration": format_duration(transcript.get("duration_sec")) if transcript.get("duration_sec") else ""}


class _Checkpoints:
    """Finished pipeline steps on disk, so a restart or retry resumes instead of starting over.

    Layout: ``<base>/<video_id>/manifest.json`` + one JSON file per finished step
    (``map-0007.json``, ``merge-L1-0002.json``, ``compose-0003.json``, ``final.json``).
    The manifest stores a hash of the transcript and a hash of provider + model + profile + prompt
    version; when either differs, the old files are discarded. Every write is atomic (tmp + rename).
    ``base=None`` disables checkpointing (all calls become no-ops).
    """

    def __init__(self, base: str | Path | None, transcript: dict, text: str, client: "_Client"):
        self.dir: Path | None = None
        if not base:
            return
        vid = re.sub(r"[^A-Za-z0-9_-]", "", str(transcript.get("video_id") or ""))[:32]
        if not vid:
            vid = "t" + hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:16]
        self.manifest = {
            "video_id": vid,
            "transcript_hash": hashlib.sha256(text.encode("utf-8", "replace")).hexdigest(),
            "profile_hash": profile_hash(client),
        }
        d = Path(base) / vid
        try:
            d.mkdir(parents=True, exist_ok=True)
            old = self._read(d / "manifest.json")
            if old != self.manifest:
                for f in d.glob("*.json"):
                    f.unlink(missing_ok=True)
                self._write(d / "manifest.json", self.manifest)
            self.dir = d
        except OSError as e:
            _log.warning("checkpoints disabled (%s)", type(e).__name__)
            self.dir = None

    @staticmethod
    def _read(path: Path) -> Any:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    @staticmethod
    def _write(path: Path, obj: Any) -> None:
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)

    def get(self, name: str) -> Any:
        if not self.dir:
            return None
        got = self._read(self.dir / f"{name}.json")
        return got.get("value") if isinstance(got, dict) else None

    def put(self, name: str, value: Any) -> None:
        if not self.dir:
            return
        try:
            self._write(self.dir / f"{name}.json", {"value": value})
        except OSError as e:  # a full disk must not kill the job
            _log.warning("checkpoint write failed (%s)", type(e).__name__)

    def clear(self) -> None:
        if self.dir:
            for f in self.dir.glob("*.json*"):
                f.unlink(missing_ok=True)
            try:
                self.dir.rmdir()
            except OSError:
                pass


def profile_hash(client: "_Client") -> str:
    """Hash of everything that shapes an answer: provider, model, profile name and tunables, prompt
    version. Shared by checkpoints and the cache, so a change to any of them never reuses old work."""
    prof = {k: v for k, v in sorted(client.profile.items()) if k != "read_timeout"}
    return hashlib.sha256(json.dumps(
        [client.provider, client.model, client.profile_name, prompts.PROMPT_VERSION, prof],
        sort_keys=True, default=str).encode()).hexdigest()


def _cache_key(client: "_Client", stage: str, *parts: Any) -> str:
    """Cache key: stage + key format + profile hash + prompt version + the exact prompt messages."""
    return cache.make_key(stage, cache.KEY_VERSION, profile_hash(client), prompts.PROMPT_VERSION, *parts)


def _single_pass(client: _Client, transcript: dict, text: str, meta: dict, report: _Reporter) -> dict:
    prof = client.profile
    n = prompts.target_section_count(transcript.get("duration_sec"), len(text), prof["max_total_sections"])
    report(10, "Writing the notebook (single pass)...")
    obj = client.ask_json(prompts.compose_single_messages(meta, text, n), prof["out_single"])
    report(90, "Checking the notes...")
    if isinstance(obj, list):
        obj = {"sections": obj}
    return obj


def _digest_chunks(client: _Client, chunks: list[dict], meta: dict, report: _Reporter,
                   ckpt: _Checkpoints | None = None) -> list[str]:
    prof = client.profile
    digests: list[str] = []
    n = len(chunks)
    for i, ch in enumerate(chunks):
        name = f"map-{i:04d}"
        d = ckpt.get(name) if ckpt else None
        from_model = False
        ck = None
        if not isinstance(d, str):
            report(5 + int(35 * i / max(1, n)), f"Extracting key knowledge (chunk {i}/{n})...")
            text = ch["text"]
            msgs = prompts.digest_messages(text, i, n, meta, prompts.digest_word_budget(len(text)))
            # the prompt text is part of the key, so editing a prompt or switching model never reuses old digests
            ck = _cache_key(client, "digest", msgs)
            hit = cache.get("digest", ck)
            if isinstance(hit, dict) and str(hit.get("d", "")).strip():
                d = str(hit["d"])
            else:
                from_model = True
                try:
                    try:
                        obj = client.ask_json(msgs, prof["digest_out"], 0.2)
                    except _OutputTruncated as e:
                        # keep what was produced before the cut-off rather than failing the whole job
                        obj = salvage_truncated_json(e.text)
                    d = prompts.digest_to_text(obj, prof["digest_cap"]) if isinstance(obj, dict) else ""
                except (_BadJSON, _OutputTruncated, ValueError):
                    d = text[: prof["digest_cap"]]  # degrade: feed raw slice head instead of aborting
                    from_model = False
            if ckpt:
                ckpt.put(name, d)
        report(5 + int(35 * (i + 1) / max(1, n)), f"Extracting key knowledge (chunk {i + 1}/{n})...")
        if d.strip():
            digests.append(d)
            # never cache the degraded fallback (a retry should get another chance), nor a stand-in provider
            if from_model and client.cache_writes:
                cache.put("digest", ck, {"d": d})
    return digests


def _merge_levels(client: _Client, digests: list[str], meta: dict, report: _Reporter,
                  ckpt: _Checkpoints | None = None) -> list[str]:
    """Hierarchical reduce for very long lectures (ADR-0003): while the digests exceed
    ``merge_budget_chars``, fold every ``merge_fanout`` consecutive digests into one part digest.
    Order and [h:mm:ss] markers are kept, so the compose stage still walks the lecture in time order."""
    prof = client.profile
    budget, fan = prof["merge_budget_chars"], max(2, int(prof["merge_fanout"]))
    level = 0
    while budget and len(digests) > 1 and sum(len(d) for d in digests) > budget and level < 6:
        level += 1
        groups = [digests[i:i + fan] for i in range(0, len(digests), fan)]
        merged: list[str] = []
        for g_i, group in enumerate(groups):
            name = f"merge-L{level}-{g_i:04d}"
            d = ckpt.get(name) if ckpt else None
            if not isinstance(d, str):
                report(40, f"Merging long-lecture digests (level {level}, part {g_i + 1}/{len(groups)})...")
                if len(group) == 1:
                    d = group[0]
                else:
                    cap = prof["digest_cap"] * 2
                    msgs = prompts.merge_messages(meta, "\n\n".join(group), level, g_i + 1, len(groups),
                                                  max(200, cap // 6))
                    try:
                        try:
                            obj = client.ask_json(msgs, prof["digest_out"] + 500, 0.2)
                        except _OutputTruncated as e:
                            obj = salvage_truncated_json(e.text)
                        d = prompts.digest_to_text(obj, cap) if isinstance(obj, dict) else ""
                    except (_BadJSON, _OutputTruncated, ValueError):
                        d = ""
                    if not d.strip():  # degrade: keep the head of every digest in the group
                        d = "\n".join(x[: cap // len(group)] for x in group)
                if ckpt:
                    ckpt.put(name, d)
            merged.append(d)
        digests = merged
    return digests


def _pack_batches(digests: list[str], max_chars: int, min_batches: int = 1) -> list[list[str]]:
    """Group consecutive digests; use at least ``min_batches`` groups (if there are that many digests)
    so each compose call only has to write a few sections for its own slice of the lecture."""
    total = sum(len(d) for d in digests)
    if min_batches > 1 and len(digests) >= min_batches:
        max_chars = min(max_chars, max(1, math.ceil(total / min_batches)))
    batches: list[list[str]] = []
    cur: list[str] = []
    size = 0
    for d in digests:
        if cur and size + len(d) > max_chars:
            batches.append(cur)
            cur, size = [], 0
        cur.append(d)
        size += len(d)
    if cur:
        batches.append(cur)
    return batches


def _usable_count(sections: list, max_sections: int = 10 ** 4) -> int:
    try:
        return len(validate_notes({"sections": sections}, max_sections=max_sections)["sections"])
    except ValueError:
        return 0


def _coverage_needed(target: int) -> int:
    """Minimum acceptable number of sections: ~70 % of the target."""
    return max(1, math.ceil(0.7 * target))


def _compose_covered(client: _Client, meta: dict, digs: list[str], n: int, cap: int,
                     prior: list[str], no: int, total: int) -> list:
    """Compose one batch asking for ``n`` sections; if the model returns < 70 % of that, retry once
    with a stricter instruction (one section per consecutive time group) and keep the better result."""
    n = max(1, min(n, cap))
    n_max = min(cap, n + 1)
    first = prompts.compose_batch_messages(meta, "\n\n".join(digs), n, n_max, prior, no, total, "")
    ck = _cache_key(client, "compose", first)
    hit = cache.get("compose", ck)
    if isinstance(hit, dict) and isinstance(hit.get("sections"), list) \
            and _usable_count(hit["sections"]) >= _coverage_needed(n):
        return hit["sections"]
    got = _compose_batch(client, meta, digs, n, n_max, prior, no, total)
    have = _usable_count(got)
    if have < _coverage_needed(n):
        strict = (f"IMPORTANT: your previous answer contained only {have} usable section(s). "
                  f"Return AT LEAST {n} sections: split the digests into {n} consecutive groups by their "
                  "[mm:ss] markers and write one separate section per group, so the whole span from the "
                  "first to the last marker is covered. Never merge the whole part into one section.")
        again = _compose_batch(client, meta, digs, n, n_max, prior, no, total, strict)
        if _usable_count(again) > have:
            got = again
    if client.cache_writes and _usable_count(got) >= _coverage_needed(n):  # only accepted answers are kept
        cache.put("compose", ck, {"sections": got})
    return got


def _compose_batch(client: _Client, meta: dict, digs: list[str], n_min: int, n_max: int,
                   prior: list[str], no: int, total: int, strict: str = "") -> list:
    text = "\n\n".join(digs)
    msgs = prompts.compose_batch_messages(meta, text, n_min, n_max, prior, no, total, strict)
    try:
        return _as_section_list(client.ask_json(msgs, client.profile["out_batch"]))
    except _OutputTruncated:
        if len(digs) > 1:  # too much for one reply: halve the input
            mid = len(digs) // 2
            a = _compose_batch(client, meta, digs[:mid], max(1, n_min // 2), max(1, n_max // 2), prior, no, total, strict)
            b = _compose_batch(client, meta, digs[mid:], max(1, n_min // 2), max(1, n_max // 2),
                               prior + [s.get("title", "") for s in a if isinstance(s, dict)], no, total, strict)
            return a + b
        if n_max > 1:
            return _compose_batch(client, meta, digs, 1, max(1, n_max - 1), prior, no, total, strict)
        raise LLMError(f"{client.label} could not fit the notes in its output limit. Try a model with a larger output limit.") from None


def _map_reduce(client: _Client, transcript: dict, meta: dict, report: _Reporter, text_chars: int,
                ckpt: _Checkpoints | None = None) -> dict:
    prof = client.profile
    max_sec = prof["max_total_sections"]
    target = prompts.target_section_count(transcript.get("duration_sec"), text_chars, max_sec)
    cap = prof["max_sections_per_call"]
    # Coverage by construction: every compose call covers one time slice and writes <= cap sections,
    # so reaching `target` needs >= ceil(target / cap) slices. Shrink the slice size accordingly.
    slices_needed = max(1, math.ceil(target / cap))
    chunk_chars = min(prof["chunk_chars"], max(1200, math.ceil(text_chars / slices_needed)))
    chunks = _get_chunker()(transcript, max_chars=chunk_chars, overlap_chars=300)
    if not chunks:
        raise LLMError("The transcript is empty.")
    digests = _digest_chunks(client, chunks, meta, report, ckpt)
    if not digests:
        raise LLMError("This video has nothing to teach - it looks like a trailer, music video, promo or "
                       "entertainment clip rather than a lecture. Try a lecture, tutorial or talk video.")
    digests = _merge_levels(client, digests, meta, report, ckpt)

    batches = _pack_batches(digests, prof["batch_chars"], min(slices_needed, len(digests)))
    total_chars = sum(len(d) for d in digests)
    sections: list = []
    for b_i, batch in enumerate(batches):
        name = f"compose-{b_i:04d}"
        got = ckpt.get(name) if ckpt else None
        if not isinstance(got, list):
            report(45 + int(40 * b_i / len(batches)), f"Writing notebook pages (part {b_i + 1}/{len(batches)})...")
            share = target * sum(len(d) for d in batch) / max(1, total_chars)
            n = max(1, round(share))
            titles = [s.get("title", "") for s in sections if isinstance(s, dict)]
            got = _compose_covered(client, meta, batch, n, cap, titles, b_i + 1, len(batches))
            if ckpt:
                ckpt.put(name, got)
        sections += got
    if _usable_count(sections, max_sec) < _coverage_needed(target):
        report(86, "Fewer pages than the lecture length suggests; the video may contain little teachable content.")

    report(88, "Writing cover, glossary and recap...")
    front = ckpt.get("final") if ckpt else None
    if not isinstance(front, dict):
        front = {}
        try:
            partial = validate_notes({"sections": sections}, max_sections=max_sec)
            outline = partial["sections"]
            terms = []
            for s in outline:
                for b in s["blocks"]:
                    if b["type"] == "definition":
                        terms.append(f"{b['term']}: {b['text'][:140]}")
            think = prof["final_reasoning_reserve"] > 0
            obj = client.ask_json(_final_messages_fit(client, meta, outline, terms),
                                  prof["final_out"] + prof["final_reasoning_reserve"], think=think)
            front = obj if isinstance(obj, dict) else {}
            if not front.get("glossary"):
                front["glossary"] = [{"term": t.split(": ", 1)[0], "definition": t.split(": ", 1)[-1]} for t in terms[:20]]
            if ckpt:
                ckpt.put("final", front)
        except (_BadJSON, _OutputTruncated):
            front = {}  # validate_notes derives recap/big_idea; glossary below
    out = dict(front)
    out["sections"] = sections
    if not out.get("glossary"):
        out["glossary"] = _glossary_from_blocks(sections)
    return out


def _final_messages_fit(client: _Client, meta: dict, outline: list[dict], terms: list[str]) -> tuple[str, str]:
    """Build the final prompt, trimming terms / takeaways / outline lines until it fits ~80 % of
    the TPM budget (cloud) or of the context window minus the output budget (local)."""
    prof = client.profile
    if prof["tpm"]:
        limit = int(prof["tpm"] * 0.8) - prof["final_out"]
    elif prof["ctx_tokens"]:
        limit = int(prof["ctx_tokens"] * 0.85) - prof["final_out"] - prof["final_reasoning_reserve"]
    else:
        limit = None
    slim = [dict(s) for s in outline]
    lines = None
    msgs = prompts.compose_final_messages(meta, slim, terms)
    while limit and (len(msgs[0]) + len(msgs[1])) / CHARS_PER_TOKEN > limit:
        if len(terms) > 6:
            terms = terms[: len(terms) // 2]
        elif any(s.get("key_takeaways") for s in slim):
            for s in slim:
                s["key_takeaways"] = []
        else:
            cur = lines if lines is not None else prompts.outline_lines(slim)
            if len(cur) <= 8:
                break
            lines = cur[::2]  # very long lecture: keep every other page title (order kept)
        msgs = prompts.compose_final_messages(meta, slim, terms, lines)
    return msgs


def _glossary_from_blocks(sections: list) -> list[dict]:
    g = []
    for s in sections:
        for b in (s.get("blocks") or []) if isinstance(s, dict) else []:
            if isinstance(b, dict) and b.get("type") == "definition" and b.get("term") and b.get("text"):
                g.append({"term": b["term"], "definition": b["text"]})
    return g[:20]


def _clean_key(api_key: str | None) -> str:
    key = (api_key or "").strip().strip("\"'").strip()
    if key.lower().startswith("bearer "):
        key = key[7:].strip()
    if not key:
        raise LLMError("No API key was provided. Paste your key in the app or set it in the environment (e.g. GROQ_API_KEY) or backend/.env.")
    if not key.isascii() or re.search(r"\s", key):
        raise LLMError("The API key contains spaces or unusual characters. Re-copy it without quotes or line breaks.")
    return key


# provider id -> env var holding a SERVER-side key (mirrors backend/app/server.py ENV_KEYS)
SERVER_KEY_ENV = {
    "gemini": "GEMINI_API_KEY",
    "groq": "GROQ_API_KEY",
    "xai": "XAI_API_KEY",
    "huggingface": "HF_TOKEN",
    "nvidia": "NVIDIA_API_KEY",
}
GROQ_FALLBACK_MAX_SEC_DEFAULT = 3600  # local -> Groq only for videos up to ~1 h (ADR-0003)
_log = logging.getLogger(__name__)


def _fallback_enabled() -> bool:
    return (os.environ.get("LNA_PROVIDER_FALLBACK") or "").strip().lower() in ("1", "true", "yes", "on")


def _groq_fallback_max_sec() -> int:
    try:
        return int(os.environ.get("LNAI_GROQ_FALLBACK_MAX_SEC") or GROQ_FALLBACK_MAX_SEC_DEFAULT)
    except ValueError:
        return GROQ_FALLBACK_MAX_SEC_DEFAULT


def _fallback_target(primary: str, transcript: dict | None = None) -> tuple[str, str] | None:
    """Provider to retry with after a transient failure. Never uses a key the user typed.

    * primary ``local`` (or the deprecated ``colab`` alias): Groq (server key) for videos up to
      LNAI_GROQ_FALLBACK_MAX_SEC (default 1 h); longer videos, which Groq's per-minute budget cannot
      take, go to NVIDIA Nemotron (NVIDIA_API_KEY); without that key they wait for the local server.
    * any other primary: ``local`` first when its server is online, then the first provider with a
      server-side key.
    One fallback means one whole new run: providers are never mixed within one video.
    """
    if primary in ("local", "colab"):
        dur = (transcript or {}).get("duration_sec") or 0
        if dur <= 0:
            return None
        if dur <= _groq_fallback_max_sec():
            key = (os.environ.get("GROQ_API_KEY") or "").strip()
            return ("groq", key) if key else None
        nv = (os.environ.get("NVIDIA_API_KEY") or "").strip()
        return ("nvidia", nv) if nv else None
    for pid in PROVIDERS:
        if pid == primary or PROVIDERS[pid].get("deprecated"):
            continue
        if not PROVIDERS[pid].get("needs_key", True):
            if local_online():
                return pid, ""
            continue
        key = (os.environ.get(SERVER_KEY_ENV.get(pid, "")) or "").strip()
        if key:
            return pid, key
    return None


def default_checkpoint_dir() -> str | None:
    """LNAI_CHECKPOINT_DIR, if set (callers normally pass ``checkpoint_dir`` explicitly)."""
    return (os.environ.get("LNAI_CHECKPOINT_DIR") or "").strip() or None


def generate_notes(transcript: dict, *, provider: str, api_key: str | None = None, model: str | None = None,
                   progress: Progress | None = None, checkpoint_dir: str | Path | None = None) -> dict:
    """Transcript -> validated Notes dict. Raises LLMError (user-safe message) on failure.

    ``checkpoint_dir`` (default: $LNAI_CHECKPOINT_DIR, else off): finished steps are saved under
    ``<checkpoint_dir>/<video_id>/`` and reused by a later call for the same video, provider, model
    and prompt version; they are removed once the notes are done.

    With ``LNA_PROVIDER_FALLBACK=1``, a rate limit / 5xx / timeout / unreachable local server
    triggers one full retry with another provider (see ``_fallback_target``); providers are never
    mixed within one video. The provider actually used is in ``meta.model`` (and ``meta.provider``
    / ``meta.fallback_from``).
    """
    ckdir = checkpoint_dir or default_checkpoint_dir()
    try:
        return _generate_notes(transcript, provider=provider, api_key=api_key, model=model,
                               progress=progress, checkpoint_dir=ckdir)
    except _TransientError as e:
        if not _fallback_enabled():
            raise
        target = _fallback_target(provider, transcript if isinstance(transcript, dict) else None)
        if target is None:
            raise
        fb, fb_key = target
        _log.warning("LLM provider %s failed (%s); falling back to %s",
                     provider, _scrub(e, api_key, 160), fb)
        if progress:
            try:
                progress("notes", 3, f"{PROVIDERS[provider]['label']} is busy; retrying with {PROVIDERS[fb]['label']}...")
            except Exception:  # noqa: BLE001
                pass
        try:
            notes = _generate_notes(transcript, provider=fb, api_key=fb_key, model=None, progress=progress,
                                    checkpoint_dir=ckdir, cache_writes=False)
        except LLMError as e2:
            raise LLMError(f"{e} Fallback to {PROVIDERS[fb]['label']} also failed: {_scrub(e2, fb_key, 300)}") from None
        meta = notes.setdefault("meta", {})
        meta["provider"] = fb
        meta["fallback_from"] = provider
        return notes


def _generate_notes(transcript: dict, *, provider: str, api_key: str | None, model: str | None,
                    progress: Progress | None, checkpoint_dir: str | Path | None = None,
                    cache_writes: bool = True) -> dict:
    if provider not in PROVIDERS:
        raise LLMError(f"Unknown provider '{_scrub(provider, None, 40)}'. Choose one of: {', '.join(PROVIDERS)}.")
    alias_of = provider
    base_url = None
    if provider == "colab":  # deprecated alias: the local provider on COLAB_LLM_URL / COLAB_LLM_KEY
        _log.warning("provider 'colab' is deprecated; use 'local' with LNAI_LOCAL_URL and LNAI_LOCAL_KEY")
        base_url = _colab_base_url()
        key = _clean_key(api_key or os.environ.get("COLAB_LLM_KEY"))
        provider = "local"
    elif provider == "local":
        key = local_key()  # server-side only: a key typed in the app is never sent to a local server
    else:
        key = _clean_key(api_key) if PROVIDERS[provider].get("needs_key", True) else ""
    model = (model or "").strip() or PROVIDERS[provider]["default_model"]
    if provider == "gemini":
        model = model.removeprefix("models/")
        if not re.fullmatch(r"[A-Za-z0-9._\-]+", model):
            raise LLMError("Invalid Gemini model name.")
    elif not re.fullmatch(r"[A-Za-z0-9._\-/:]+", model):
        raise LLMError("Invalid model name.")
    if not isinstance(transcript, dict) or not transcript.get("segments"):
        raise LLMError("The transcript is empty, so there is nothing to summarise.")
    profile_name = None
    if provider == "local":
        base = base_url or local_base_url()  # fail fast on a bad LNAI_LOCAL_URL
        profile_name = local_profile_name(local_server_ctx(base, key), force_small=alias_of == "colab")

    client = _Client(provider, key, model, base_url=base_url, profile_name=profile_name,
                     cache_writes=cache_writes)
    report = _Reporter(progress)
    meta = _meta_for_prompt(transcript)
    model_tag = f"{provider}/{model}"
    max_sec = client.profile["max_total_sections"]
    try:
        report(2, f"Preparing transcript for {client.label}...")
        chunker = _get_chunker()
        full = chunker(transcript, max_chars=10 ** 9, overlap_chars=0)
        text = "\n".join(c["text"] for c in full)
        ckpt = _Checkpoints(checkpoint_dir, transcript, text, client)
        n_target = prompts.target_section_count(transcript.get("duration_sec"), len(text), max_sec)
        reserve = client.profile["reasoning_reserve"]
        fits_output = n_target * SECTION_TOKENS + 1200 + reserve <= client.profile["out_single"] * 0.9
        raw = None
        if len(text) <= client.profile["single_chars"] and fits_output:
            try:
                raw = _single_pass(client, transcript, text, meta, report)
                have = len(validate_notes(raw, transcript, max_sections=max_sec)["sections"])
                if have < _coverage_needed(n_target):
                    # models tend to under-deliver on section count; map-reduce covers every time slice
                    report(12, f"Only {have} of ~{n_target} sections came back; rewriting slice by slice...")
                    raw = None
            except (_OutputTruncated, _BadJSON, ValueError):
                report(12, "Single pass was not usable; switching to the multi-step method...")
                raw = None
        if raw is None:
            raw = _map_reduce(client, transcript, meta, report, len(text), ckpt)
        report(97, "Polishing notes...")
        notes = validate_notes(raw, transcript, model=model_tag, max_sections=max_sec)
        ckpt.clear()
    except LLMError:
        raise
    except ValueError as e:
        raise LLMError(f"The model's answer could not be turned into notes ({_scrub(e, key, 120)}). Please retry.") from None
    except Exception as e:  # noqa: BLE001 - never leak internals/keys
        raise LLMError(f"Unexpected error while generating notes ({type(e).__name__}). Please retry.") from None
    report(100, "Notes ready.")
    return notes
