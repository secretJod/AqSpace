"""Which AI providers we support, where their APIs live, and how big each request may be.

What this file answers
----------------------
1. ``PROVIDERS``          - the list shown in the app (label, default model, where to get a key).
2. ``ENDPOINTS`` / URLs   - the HTTP address of each provider's chat API.
3. ``model_profile()``    - the "size profile" for one provider + model (or a profile name such
                            as "local-small"): how many transcript characters fit in one call,
                            how many output tokens to ask for, the tokens-per-minute budget,
                            how many calls may run in parallel, the section cap, merge levels...

The ``local`` provider (an OpenAI-compatible llama-server running Qwen3-8B) needs no key. Its
network helpers (``local_base_url``, ``local_server_ctx``, ``local_online``) live in ``llm.py``
because tests patch them there; this file only holds its static numbers.

How it fits
-----------
``llm._Client`` reads a profile once when it is created and the pipeline in ``llm.py`` uses
the numbers to decide between "single pass" and "map-reduce" and to size every call.

Size / token reasoning (rough rule: 1 token ~ 3.3 chars of English transcript; one finished
notebook section is ~800 output tokens; the rules prompt + schema example ~2k tokens):

* Groq free tier (llama-3.3-70b-versatile) allows ~12k tokens/minute INCLUDING the requested
  ``max_tokens``.  So: digest call = 10k chars (3k) + 1k prompt + 1.5k out ~ 5.5k; compose batch =
  12k chars of digests (3.6k) + 2k prompt + 3.5k out ~ 9k; single pass = 8k chars (2.4k) + 2k +
  6k out ~ 10.4k.  A client-side pacer (``llm._Pacer``) sleeps so the trailing-minute total stays
  under ~85 % of the limit, and 429s sleep per Retry-After / "try again in Xs".
* Gemini / xAI have huge contexts, so the limits there are *output* limits (2.5/3 models: 32k,
  older ones: 8k).  Single pass is only attempted when the expected notes (sections x 800 + 1.2k
  tokens) fit comfortably in the output budget.

Read next: ``json_repair.py``.
"""

from __future__ import annotations

import os
import re

from .errors import LLMError

# --------------------------------------------------------------------------- #
# 1. The providers the user can pick
# --------------------------------------------------------------------------- #

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
    # Deprecated alias of "local", kept for one release: runs the local provider against
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

# --------------------------------------------------------------------------- #
# 2. Where each provider's API lives
# --------------------------------------------------------------------------- #

# OpenAI-compatible "chat/completions" endpoints.  The local provider is missing on purpose: its
# base URL comes from LNAI_LOCAL_URL (llm.local_base_url), or COLAB_LLM_URL for the colab alias.
ENDPOINTS = {
    "groq": "https://api.groq.com/openai/v1/chat/completions",
    "xai": "https://api.x.ai/v1/chat/completions",
    "huggingface": "https://router.huggingface.co/v1/chat/completions",
    "nvidia": "https://integrate.api.nvidia.com/v1/chat/completions",
}

# default base URL of the local llama-server (OpenAI-compatible, ends in /v1)
LOCAL_URL_DEFAULT = "http://127.0.0.1:8081/v1"

# Gemini has its own API shape; the model name goes into the URL.
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


def colab_base_url() -> str:
    """Deprecated colab alias: the Colab server's OpenAI-compatible ``.../v1`` base URL.

    The base URL (a cloudflared link) comes from ``COLAB_LLM_URL`` and changes every Colab
    session.  We only accept a plain ``https://host[:port]`` value (an optional ``/v1`` suffix is
    dropped) so the app can never be pointed at something odd.
    """
    base = (os.environ.get("COLAB_LLM_URL") or "").strip().rstrip("/").removesuffix("/v1")
    if not re.fullmatch(r"https://[A-Za-z0-9.\-]+(:\d+)?", base):
        raise LLMError("COLAB_LLM_URL is not set to the https link printed by the Colab server cell.")
    return base + "/v1"


# --------------------------------------------------------------------------- #
# 3. Size profiles (how much text / how many tokens per call)
# --------------------------------------------------------------------------- #

SECTION_TOKENS = 800  # expected output tokens per finished notebook section
CHARS_PER_TOKEN = 3.3  # rough average for English transcript text

READ_TIMEOUT = 240  # s; default read timeout of one cloud call
LOCAL_READ_TIMEOUT = 1800  # s; one compose on an M2 at ~10-20 tok/s can take several minutes
SMALL_CTX_MAX = 8192  # a local server with at most this context gets the "local-small" profile

# Meaning of the keys:
#   single_chars - biggest transcript (chars) we try to turn into notes in ONE call
#   chunk_chars  - size of one transcript slice in the map-reduce "digest" stage
#   batch_chars  - how many characters of digests go into one "compose" call
#   digest_cap   - maximum length (chars) we keep of one digest
#   digest_out   - max output tokens for one digest call
#   out_single   - max output tokens for a single-pass call (None = decided per model below)
#   out_batch    - max output tokens for one compose call     (None = decided per model below)
#   tpm          - tokens-per-minute budget to pace ourselves under (None = no pacing)
# Local-only extras: final_reasoning_reserve (thinking budget of the final call), max_total_sections
# (section cap for the whole notebook), merge_budget_chars / merge_fanout (hierarchical merge levels
# for very long lectures), read_timeout, ctx_tokens.
BASE_PROFILES: dict[str, dict] = {
    # Qwen3-8B Q4_K_M on llama.cpp, ctx 16384, 1 slot. The biggest call
    # stays <= ~14k tokens (tokens ~ chars/3.3 worst case; Qwen's tokenizer is nearer chars/4):
    #   digest  : 24k chars (6-7k) + 0.8k prompt + 1.5k out             ~ 9k
    #   compose : 20k chars of digests (5-6k) + 2.8k rules/example + 6k out ~ 14k
    #   final   : outline (trimmed to fit) + 4k out + 1.5k thinking
    # No rate limits -> no pacer. Thinking off for map/merge/compose, on for the final call.
    "local": dict(
        single_chars=12000,
        chunk_chars=24000,
        batch_chars=20000,
        digest_cap=2500,
        digest_out=1500,
        out_single=6000,
        out_batch=6000,
        tpm=None,
        final_out=4000,
        final_reasoning_reserve=1500,
        max_total_sections=200,
        merge_budget_chars=60000,
        merge_fanout=8,
        read_timeout=LOCAL_READ_TIMEOUT,
        ctx_tokens=16384,
    ),
    "gemini": dict(
        single_chars=90000,
        chunk_chars=36000,
        batch_chars=40000,
        digest_cap=5000,
        digest_out=3000,
        out_single=None,
        out_batch=None,
        tpm=None,
    ),
    "groq": dict(
        single_chars=8000,
        chunk_chars=10000,
        batch_chars=12000,
        digest_cap=3000,
        digest_out=1500,
        out_single=6000,
        out_batch=3500,
        tpm=12000,
    ),
    "xai": dict(
        single_chars=100000,
        chunk_chars=40000,
        batch_chars=40000,
        digest_cap=5000,
        digest_out=3000,
        out_single=16000,
        out_batch=12000,
        tpm=None,
    ),
    "huggingface": dict(
        single_chars=20000,
        chunk_chars=10000,
        batch_chars=14000,
        digest_cap=3500,
        digest_out=2000,
        out_single=8000,
        out_batch=5000,
        tpm=None,
    ),
    # NVIDIA NIM free tier: ~40 requests/minute, no daily token cap; large-context Nemotron models
    "nvidia": dict(
        single_chars=40000,
        chunk_chars=20000,
        batch_chars=20000,
        digest_cap=4000,
        digest_out=2500,
        out_single=12000,
        out_batch=8000,
        tpm=None,
    ),
    # local-small: the same Qwen3-8B on a llama-server with <= 8K context (e.g. a free Colab T4 GPU).
    # Chosen when the server reports n_ctx <= SMALL_CTX_MAX (or LNAI_LOCAL_CTX says so), and always
    # for the deprecated "colab" alias. Small slices keep every call inside the window.
    "local-small": dict(
        single_chars=6000,
        chunk_chars=8000,
        batch_chars=8000,
        digest_cap=2500,
        digest_out=1500,
        out_single=5000,
        out_batch=4000,
        tpm=None,
        final_out=3000,
        final_reasoning_reserve=0,
        max_total_sections=200,
        merge_budget_chars=40000,
        merge_fanout=8,
        read_timeout=LOCAL_READ_TIMEOUT,
        ctx_tokens=8192,
    ),
}


def local_profile_name(ctx: int | None, force_small: bool = False) -> str:
    """ "local-small" for a server with a small context window (or when forced), else "local"."""
    return "local-small" if force_small or (ctx is not None and ctx <= SMALL_CTX_MAX) else "local"


def _apply_model_overrides(profile: dict, provider: str, model_lower: str) -> None:
    """Adjust the provider's base profile for specific models (changes ``profile`` in place)."""
    if provider == "gemini":
        # Gemini 2.5 / 3 models may write 32k output tokens, older ones only 8k.
        big = re.search(r"gemini-(2\.5|3)", model_lower) is not None
        out = 32768 if big else 8192
        profile["out_single"], profile["out_batch"] = out, min(out, 16000)

    if provider == "groq" and "gpt-oss" in model_lower:
        # gpt-oss-120b / -20b on the Groq free tier: ~8k tokens/minute (input + max_tokens), and they
        # are reasoning models: reasoning tokens are billed against max_tokens, so every call reserves
        # ~1.2k of its budget for them (reasoning_effort "low" keeps it near that).
        # Per request (tokens ~ chars/3.3; rules prompt ~1.3k):
        #   digest  : 5k chars (1.5k) + 0.7k prompt + 2k out            ~ 4.2k
        #   compose : 4k chars of digests (1.2k) + 1.9k prompt + 3k out ~ 6.1k   (<= 85 % of 8k = 6.8k)
        # A single pass never fits (6+ sections need > 6k output tokens) -> always map-reduce.
        profile.update(
            single_chars=2500,
            chunk_chars=5000,
            batch_chars=4000,
            digest_cap=2000,
            digest_out=2000,
            out_single=3000,
            out_batch=3000,
            tpm=8000,
            reasoning_effort="low",
            reasoning_reserve=1200,
            final_out=2800,
        )
    elif provider == "groq" and "qwen" in model_lower:
        # qwen3.x on Groq free tier: ~6k tokens/minute. Thinking is switched off (reasoning_effort
        # "none"; dropped automatically if the model rejects it) and <think> blocks are stripped.
        profile.update(
            single_chars=2000,
            chunk_chars=4000,
            batch_chars=3000,
            digest_cap=1600,
            digest_out=1600,
            out_single=2500,
            out_batch=2500,
            tpm=6000,
            reasoning_effort="none",
            reasoning_reserve=500,
            final_out=2200,
        )
    elif provider == "groq" and re.search(r"(^|[-/])8b|instant", model_lower):
        # llama-3.1-8b-instant: only ~6k tokens/minute on the free tier
        profile.update(
            single_chars=3000,
            chunk_chars=5000,
            batch_chars=6000,
            digest_cap=2000,
            digest_out=1000,
            out_single=3000,
            out_batch=2000,
            tpm=6000,
        )


def _add_defaults_and_derived(profile: dict, provider: str) -> None:
    """Fill in the optional keys and compute ``max_sections_per_call`` (in place)."""
    # concurrent requests one job may run (Gemini: slice the lecture and write the slices in parallel;
    # the shared RPM pacer still spaces every request, so parallelism never breaks the free-tier limit)
    profile.setdefault("parallel", 4 if provider == "gemini" else 1)
    profile.setdefault("reasoning_effort", None)  # sent to the provider when set (Groq reasoning models)
    profile.setdefault("reasoning_reserve", 0)  # output tokens a reasoning model may burn before the answer
    profile.setdefault("final_out", 3000)  # output tokens for the cover/glossary/recap call
    profile.setdefault("final_reasoning_reserve", 0)  # thinking budget for the final call only (local)
    profile.setdefault("max_total_sections", 18)  # cap on the whole notebook (cloud: keep it short)
    profile.setdefault("merge_budget_chars", None)  # digests above this -> hierarchical merge levels
    profile.setdefault("merge_fanout", 8)
    profile.setdefault("read_timeout", READ_TIMEOUT)
    profile.setdefault("ctx_tokens", None)
    # sections one compose call can reliably return: answer budget = out_batch - reasoning reserve
    answer = profile["out_batch"] - profile["reasoning_reserve"]
    profile["max_sections_per_call"] = max(1, min(10, int(answer * 0.9 / SECTION_TOKENS)))


def model_profile(provider: str, model: str) -> dict:
    """Return a fresh size profile dict for ``provider`` + ``model`` (see BASE_PROFILES for keys).

    ``provider`` may also be a profile name such as "local-small"."""
    profile = dict(BASE_PROFILES[provider])
    _apply_model_overrides(profile, provider, model.lower())
    _add_defaults_and_derived(profile, provider)
    return profile
