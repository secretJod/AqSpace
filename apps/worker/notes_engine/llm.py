"""Transcript -> study notes, using an AI model (plain ``requests``, no vendor SDKs).

Called by ``backend/app/jobs.py``, ``notes_engine.generate`` and ``smart_playlist.py`` (which reuses
``_Client``). Start here: ``generate_notes()`` at the bottom of this file.

The pipeline
------------
* short lecture  -> ONE call that returns the whole Notes JSON ("single pass");
                    on Gemini a longer "short" lecture is cut into a few time slices that are
                    written in parallel ("parallel single pass").
* long lecture   -> map-reduce:
    1. ``ingest.chunk_transcript`` -> N slices,
    2. one *digest* call per slice (compact facts only; checkpointed per chunk),
    3. very long lectures: digests are folded by hierarchical *merge* levels until they fit,
    4. digests are packed into batches; each batch is composed into 2-10 sections,
    5. one small final call writes subtitle / cover / glossary / recap from the outline,
    6. ``notes_schema.validate_notes`` coerces everything.
  Single pass falls back to map-reduce if the output is truncated or unusable.

Providers and resilience
------------------------
* ``local`` provider: an OpenAI-compatible llama-server (LNAI_LOCAL_URL, optional LNAI_LOCAL_KEY),
  "local" / "local-small" profiles by the server's context size; ``colab`` is a deprecated alias.
* Gemini RPM pacer (LNAI_GEMINI_RPM): thread-safe, counts in-flight calls, says why it waits;
  a daily-quota hit marks the client ``quota_dead`` so parallel calls stop.
* Fallback chain (LNA_PROVIDER_FALLBACK): local -> Groq (videos <= 1 h) -> NVIDIA, one provider per
  run, never mixing answers; a fallback run never writes to the shared cache.
* ``_Checkpoints``: every finished step is saved under ``checkpoint_dir/<video_id>/`` so a retry
  resumes; the cache sits under it, keyed by ``profile_hash`` (+ prompts.PROMPT_VERSION).

How the file is organised
-------------------------
1. Short names      - aliases for helpers in ``notes_engine/ai/`` that the pipeline and tests use.
2. Tunables         - timeouts, retry counts; the local server helpers.
3. Sleeping/pacing  - ``_sleep`` and ``_Pacer`` (tests replace ``llm._sleep``).
4. ``_Client``      - builds requests, retries HTTP errors, extracts text, asks for JSON.
5. Pipeline helpers - checkpoints, single pass, parallel single pass, digest, merge, compose, map-reduce.
6. ``generate_notes`` - the public entry point, with the provider fallback chain.

The API key is only ever put in a request header (never a URL) and is scrubbed from every error
message.  Size / token reasoning per provider is explained in ``ai/providers.py``.

Read next: ``ai/providers.py`` (limits), ``prompts.py`` (what we ask), ``notes_schema.py`` (what
we accept).

Note for maintainers: tests patch ``llm._sleep``, ``llm._get_chunker``, ``llm.local_online``,
``llm._CTX_SEEN``, ``llm.random``, ``llm.time`` and ``llm.requests`` - so the code that *uses*
those names must stay in this module.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import random
import re
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import requests

from . import cache, prompts
from .ai.errors import LLMError, _BadJSON, _HTTPStatusError, _OutputTruncated, _TransientError
from .ai.json_repair import parse_json, salvage_truncated_json
from .ai.key_safety import clean_api_key, scrub_secrets
from .ai.providers import (
    CHARS_PER_TOKEN,
    ENDPOINTS,
    GEMINI_URL,
    LOCAL_READ_TIMEOUT,
    LOCAL_URL_DEFAULT,
    PROVIDERS,
    SECTION_TOKENS,
    colab_base_url,
    local_profile_name,
    model_profile,
)
from .ai.responses import as_dict, as_str, failed_generation_text, is_daily_quota_error, parse_retry_delay
from .ai.sections import (
    coverage_needed,
    find_sections,
    glossary_from_blocks,
    join_section_lists,
    pack_batches,
    usable_section_count,
)
from .notes_schema import format_duration, validate_notes

__all__ = [
    "LLMError",
    "PROVIDERS",
    "LOCAL_READ_TIMEOUT",
    "generate_notes",
    "default_checkpoint_dir",
    "local_base_url",
    "local_key",
    "local_online",
    "local_profile_name",
    "local_server_ctx",
    "profile_hash",
]

# Short names the pipeline and its tests use for helpers that live in ``notes_engine/ai/``.
_profile = model_profile
_join_parts = join_section_lists
_usable_count = usable_section_count

# progress(stage, percent, message) - the same callback shape the whole engine uses
Progress = Callable[[str, int, str], None]

# --------------------------------------------------------------------------- #
# 2. Tunables and the local server
# --------------------------------------------------------------------------- #

CONNECT_TIMEOUT = 15
MAX_ATTEMPTS = 5  # per HTTP call (429 / 5xx / network)
MAX_RETRY_WAIT = 75  # seconds we are willing to sleep for one retry
BACKOFF_BASE = 2.0

LOCAL_MAX_ATTEMPTS = 2  # a local server that is down will not come back by retrying 5 times


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


# --------------------------------------------------------------------------- #
# 3. Sleeping and pacing
# --------------------------------------------------------------------------- #
def _sleep(sec: float) -> None:
    time.sleep(max(0.0, sec))


GEMINI_RPM_DEFAULT = 10  # free-tier Flash / Flash-Lite allow ~10-15 requests per minute


def _gemini_rpm() -> int:
    """LNAI_GEMINI_RPM (requests per minute for the Gemini pacer); 0 turns the pacer off."""
    raw = (os.environ.get("LNAI_GEMINI_RPM") or "").strip()
    if not raw:
        return GEMINI_RPM_DEFAULT
    try:
        return max(0, int(raw))
    except ValueError:
        return GEMINI_RPM_DEFAULT


class _Pacer:
    """Client-side rate limiter over a trailing 60 s window.

    * ``tpm``: keeps estimated tokens under ``tpm * 0.85`` (Groq free tier).
    * ``rpm``: keeps the number of requests at most ``rpm`` (Gemini free tier).
    ``notify(seconds)`` is called before each wait so the UI can say why the job is paused.
    """

    def __init__(self, tpm: int | None, rpm: int | None = None, notify: Callable[[float], None] | None = None):
        self.budget = int(tpm * 0.85) if tpm else None
        self.rpm = int(rpm) if rpm else None
        self.notify = notify
        self.log: list[tuple[float, int]] = []
        self.inflight = 0  # requests let through but not finished yet (parallel calls count too)
        self._lock = threading.Lock()

    def _over(self, est_tokens: int) -> bool:
        if self.budget and sum(n for _, n in self.log) + est_tokens > self.budget:
            return True
        return bool(self.rpm) and len(self.log) + self.inflight + 1 > self.rpm

    def before(self, est_tokens: int) -> None:
        """Block until a request of about ``est_tokens`` tokens fits the window, then count it in flight."""
        if not self.budget and not self.rpm:
            return
        with self._lock:  # parallel callers wait their turn, so the window is never overrun
            self._before(est_tokens)
            self.inflight += 1

    def _before(self, est_tokens: int) -> None:
        now = time.monotonic()
        self.log = [(t, n) for t, n in self.log if now - t < 60]
        while self.log and self._over(est_tokens):
            t0, _n = self.log[0]
            wait = t0 + 60 - time.monotonic()
            if wait > 0:
                if self.notify:
                    try:
                        self.notify(wait + 0.5)
                    except Exception:  # noqa: BLE001 - progress must never kill the job
                        pass
                _sleep(wait + 0.5)
            self.log.pop(0)  # explicit pop: terminates even when sleep is mocked

    def after(self, est_tokens: int) -> None:
        """Record a finished request so it counts against the next 60 seconds."""
        if self.budget or self.rpm:
            with self._lock:
                self.inflight = max(0, self.inflight - 1)
                self.log.append((time.monotonic(), est_tokens))


# --------------------------------------------------------------------------- #
# 4. The HTTP client for one provider + model
# --------------------------------------------------------------------------- #
class _Client:
    def __init__(
        self,
        provider: str,
        api_key: str,
        model: str,
        *,
        base_url: str | None = None,
        profile_name: str | None = None,
        cache_writes: bool = True,
    ):
        self.provider, self.key, self.model = provider, api_key, model
        self.label = PROVIDERS[provider]["label"]
        self.base_url = base_url  # local only: overrides LNAI_LOCAL_URL (deprecated colab alias)
        self.profile_name = profile_name or provider
        self.profile = _profile(self.profile_name, model)
        # False on a fallback run: answers from a stand-in provider never go into the shared cache
        self.cache_writes = cache_writes
        # set by _generate_notes: notify(msg) shows "waiting for rate limit" progress lines
        self.notify: Callable[[str], None] | None = None
        rpm = _gemini_rpm() if provider == "gemini" else None
        self.pacer = _Pacer(self.profile["tpm"], rpm, notify=lambda sec: self._waiting(sec))
        self.json_mode = True  # flips to False if an OpenAI-compatible provider rejects it
        self.reasoning_effort = self.profile["reasoning_effort"]  # flips to None if rejected
        self.schema_ok = provider == "gemini"  # Gemini structured output; flips to False if rejected
        self.quota_dead = False  # set once the daily quota is hit

    # -- request construction (kept separate so tests can assert on it) --
    def build_request(
        self,
        system: str,
        user: str,
        max_tokens: int,
        temperature: float,
        think: bool = False,
        schema: dict | None = None,
    ) -> tuple[str, dict, dict]:
        """Build ``(url, headers, body)`` for one chat call in the provider's API shape.

        The key only ever goes into a header. ``think`` enables reasoning on the local Qwen model;
        ``schema`` is sent as Gemini structured output when the model accepts it.
        """
        if self.provider == "gemini":
            url = GEMINI_URL.format(model=self.model)
            headers = {"x-goog-api-key": self.key, "Content-Type": "application/json"}
            gen = {"responseMimeType": "application/json", "temperature": temperature, "maxOutputTokens": max_tokens}
            if schema and self.schema_ok:
                gen["responseJsonSchema"] = schema  # structured output: always valid JSON, no repair call
            body = {
                "systemInstruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": [{"text": user}]}],
                "generationConfig": gen,
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
            url = ENDPOINTS[self.provider]
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
    def _post(self, url: str, headers: dict, body: dict, read_timeout: float | None = None) -> dict:
        last_status = None
        local = self.provider == "local"
        attempts = LOCAL_MAX_ATTEMPTS if local else MAX_ATTEMPTS
        for attempt in range(attempts):
            try:
                resp = requests.post(
                    url,
                    headers=headers,
                    json=body,
                    timeout=(CONNECT_TIMEOUT, read_timeout or self.profile["read_timeout"]),
                )
            except (requests.Timeout, requests.ConnectionError) as e:
                last_status = type(e).__name__
                if attempt + 1 >= attempts:
                    if local:
                        raise _TransientError(
                            "The local model server is not reachable at LNAI_LOCAL_URL "
                            f"({scrub_secrets(self.base_url or local_base_url(), self.key, 80)}). "
                            "Start llama-server and try again."
                        ) from None
                    raise _TransientError(
                        f"Could not reach {self.label} (network error or timeout) after "
                        f"{MAX_ATTEMPTS} tries. Check your connection and try again."
                    ) from None
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
            if sc == 429 and is_daily_quota_error(body_text):
                self.quota_dead = True  # parallel calls of this job stop instead of hitting the cap again
                raise _TransientError(self._quota_message("daily quota"), daily_quota=True)
            if sc in (408, 429, 500, 502, 503, 504, 529):
                last_status = sc
                wait = parse_retry_delay(resp)
                if wait is not None and wait > 90:
                    raise (
                        _TransientError(self._quota_message(f"limit (asks to wait {int(wait)} s)"))
                        if sc == 429
                        else _TransientError(f"{self.label} is overloaded (HTTP {sc}); try again later.")
                    )
                if attempt + 1 >= attempts:
                    break
                delay = min(MAX_RETRY_WAIT, (wait + 0.5) if wait is not None else self._backoff(attempt))
                if sc == 429:
                    self._waiting(delay)
                _sleep(delay)
                continue
            raise self._http_error(sc, resp, body_text)
        if last_status == 429:
            raise _TransientError(self._quota_message("rate limit"))
        raise _TransientError(
            f"{self.label} is temporarily unavailable (HTTP {last_status}) after "
            f"{attempts} tries. Please try again in a few minutes."
        )

    def _waiting(self, sec: float) -> None:
        if self.notify:
            try:
                self.notify(f"Waiting for {self.label} rate limit, {max(1, int(round(sec)))}s...")
            except Exception:  # noqa: BLE001
                pass

    @staticmethod
    def _backoff(attempt: int) -> float:
        return min(MAX_RETRY_WAIT, BACKOFF_BASE * (2**attempt)) + random.uniform(0, 1)

    def _quota_message(self, what: str) -> str:
        if what == "daily quota":
            extra = (
                "the free daily request quota is used up"
                if self.provider == "gemini"
                else "the daily usage cap is used up"
            )
            return (
                f"{self.label} daily quota reached: {extra}. It resets within 24 hours; "
                "until then use another provider or a paid key."
            )
        extra = {
            "gemini": "Free-tier Gemini keys allow only a few requests per minute and a limited number per day.",
            "groq": "Groq's free tier caps tokens per minute and per day.",
        }.get(self.provider, "Free-tier or low-credit keys have strict rate limits.")
        return (
            f"{self.label} {what} reached. {extra} Wait a minute (or until tomorrow for daily caps), "
            "pick a smaller/different model, or switch provider and retry."
        )

    def _http_error(self, sc: int, resp: Any, body_text: str) -> _HTTPStatusError:
        payload = None
        try:
            payload = resp.json()
        except Exception:  # noqa: BLE001
            pass
        err = payload.get("error") if isinstance(payload, dict) else None
        if isinstance(err, dict):
            detail = as_str(err.get("message")) or body_text
        else:
            detail = as_str(err) or body_text
        detail = scrub_secrets(detail, self.key)
        if sc in (401, 403):
            msg = (
                f"{self.label} rejected the API key (HTTP {sc}). Check that the key is pasted correctly, "
                f"is active, and belongs to {self.label}"
                + (" (and that the Generative Language API is enabled for it)." if self.provider == "gemini" else ".")
                + (f" Server said: {detail}" if detail else "")
            )
        elif sc == 404:
            msg = (
                f"{self.label} does not know the model '{scrub_secrets(self.model, self.key, 80)}' (HTTP 404). "
                f"Pick a valid model id (default: {PROVIDERS[self.provider]['default_model']})."
            )
        elif sc == 413:
            msg = (
                f"The request was too large for {self.label}'s limits (HTTP 413). Try a shorter video "
                "or a model/provider with a bigger context window."
            )
        elif sc == 402:
            msg = f"{self.label} says the account has no credits left (HTTP 402)."
        else:
            msg = f"{self.label} rejected the request (HTTP {sc})." + (f" Server said: {detail}" if detail else "")
        code = as_str(err.get("code")) + " " + as_str(err.get("type")) if isinstance(err, dict) else ""
        return _HTTPStatusError(msg, sc, (detail + " " + code).lower(), payload)

    # -- one completion: returns (text, truncated) --
    def complete(
        self,
        system: str,
        user: str,
        max_tokens: int,
        temperature: float = 0.3,
        think: bool = False,
        schema: dict | None = None,
        read_timeout: float | None = None,
    ) -> tuple[str, bool]:
        """Run one completion and return ``(text, truncated)``.

        Retries without JSON mode, ``reasoning_effort`` or the Gemini schema when the provider
        rejects them. Raises ``_TransientError`` (rate limit, overload, unreachable),
        ``_HTTPStatusError`` or ``LLMError`` with a user-safe message.
        """
        est = int((len(system) + len(user)) / CHARS_PER_TOKEN) + max_tokens
        for _ in range(4):  # at most: normal, then without JSON mode / reasoning_effort / schema
            if self.quota_dead:
                raise _TransientError(self._quota_message("daily quota"), daily_quota=True)
            url, headers, body = self.build_request(system, user, max_tokens, temperature, think, schema)
            self.pacer.before(est)
            try:
                data = self._post(url, headers, body, read_timeout)
            except _HTTPStatusError as e:
                self.pacer.after(est)
                if (
                    self.provider == "gemini"
                    and e.status == 400
                    and "responseJsonSchema" in body["generationConfig"]
                    and any(t in e.detail for t in ("schema", "unknown name", "generation_config", "generationconfig"))
                ):
                    self.schema_ok = False  # model/API version without JSON-schema output: plain JSON mode
                    continue
                if self.provider != "gemini" and e.status in (400, 422):
                    failed = failed_generation_text(e.payload)
                    if failed and "json_validate_failed" in e.detail:
                        return failed, False  # Groq hands back the invalid text: let the repair stage fix it
                    if self.reasoning_effort and "reasoning" in e.detail:
                        self.reasoning_effort = None
                        continue
                    if self.json_mode and any(
                        t in e.detail
                        for t in ("response_format", "json_object", "json mode", "json_schema", "json_validate")
                    ):
                        self.json_mode = False
                        continue
                raise
            self.pacer.after(est)
            return self._extract(data)
        raise LLMError(f"{self.label} did not accept the request.")

    def _extract(self, data: dict) -> tuple[str, bool]:
        if self.provider == "gemini":
            pf = as_dict(data.get("promptFeedback"))
            if pf.get("blockReason"):
                raise LLMError(
                    f"Gemini blocked the request for safety reasons ({pf['blockReason']}). "
                    "Try a different video or model."
                )
            cands = data.get("candidates") or []
            if not cands:
                raise LLMError("Gemini returned no answer (empty response). Try again or choose another model.")
            c = as_dict(cands[0])
            fr = str(c.get("finishReason") or "")
            parts = as_dict(c.get("content")).get("parts") or []
            text = "".join(as_str(p.get("text")) for p in parts if isinstance(p, dict) and not p.get("thought"))
            if fr in ("SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION") and not text.strip():
                raise LLMError(f"Gemini's safety filter stopped the answer ({fr}). Try a different model or video.")
            return text, fr == "MAX_TOKENS"
        choices = data.get("choices") or []
        if not choices:
            raise LLMError(f"{self.label} returned no answer (empty response).")
        ch = as_dict(choices[0])
        msg = as_dict(ch.get("message"))
        content = msg.get("content")
        if isinstance(content, list):
            content = "".join(as_str(p.get("text") if isinstance(p, dict) else p) for p in content)
        content = re.sub(r"<think>.*?</think>", "", content or "", flags=re.S)  # qwen-style reasoning
        if "<think>" in content:  # reasoning cut off before it closed: nothing usable after it
            content = content.split("<think>", 1)[0]
        fr = str(ch.get("finish_reason") or "")
        if fr == "content_filter" and not content:
            raise LLMError(f"{self.label}'s content filter blocked the answer. Try a different model or video.")
        return content or "", fr == "length"

    # -- JSON helpers --
    def ask_json(
        self,
        messages: tuple[str, str],
        max_tokens: int,
        temperature: float = 0.3,
        think: bool = False,
        schema: dict | None = None,
        read_timeout: float | None = None,
    ) -> Any:
        """Ask for JSON and return it parsed (a dict or list).

        Unparseable output gets one "please fix this JSON" call. Raises ``_OutputTruncated`` when the
        answer hit the token limit (its ``text`` can be salvaged) and ``_BadJSON`` when the repair
        failed too.
        """
        system, user = messages
        extra: dict = {"schema": schema} if schema and self.schema_ok else {}  # only Gemini uses a schema
        if read_timeout:
            extra["read_timeout"] = read_timeout
        text, truncated = self.complete(system, user, max_tokens, temperature, think, **extra)
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
            raise _BadJSON(
                f"{self.label} returned malformed JSON twice. Try again, or pick a different model."
            ) from None


# --------------------------------------------------------------------------- #
# 5. Pipeline helpers
# --------------------------------------------------------------------------- #
def _get_chunker() -> Callable[..., list[dict]]:
    from .ingest import chunk_transcript

    return chunk_transcript


class _Reporter:
    def __init__(self, cb: Progress | None):
        self.cb = cb
        self.last = 0  # last percentage, reused by "waiting for rate limit" messages

    def __call__(self, pct: int, msg: str) -> None:
        self.last = pct
        if self.cb:
            try:
                self.cb("notes", max(0, min(100, int(pct))), msg)
            except Exception:  # noqa: BLE001 - a broken progress callback must not kill the job
                pass


def _meta_for_prompt(transcript: dict) -> dict:
    return {
        "title": transcript.get("title") or "",
        "channel": transcript.get("channel") or "",
        "duration": format_duration(transcript.get("duration_sec")) if transcript.get("duration_sec") else "",
    }


class _Checkpoints:
    """Finished pipeline steps on disk, so a restart or retry resumes instead of starting over.

    Layout: ``<base>/<video_id>/manifest.json`` + one JSON file per finished step
    (``map-0007.json``, ``merge-L1-0002.json``, ``compose-0003.json``, ``final.json``).
    The manifest stores a hash of the transcript and a hash of provider + model + profile + prompt
    version; when either differs, the old files are discarded. Every write is atomic (tmp + rename).
    ``base=None`` disables checkpointing (all calls become no-ops).
    """

    def __init__(self, base: str | Path | None, transcript: dict, text: str, client: _Client):
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
        """Return the saved value of step ``name``, or None."""
        if not self.dir:
            return None
        got = self._read(self.dir / f"{name}.json")
        return got.get("value") if isinstance(got, dict) else None

    def put(self, name: str, value: Any) -> None:
        """Save the value of step ``name``; a failed write is only logged."""
        if not self.dir:
            return
        try:
            self._write(self.dir / f"{name}.json", {"value": value})
        except OSError as e:  # a full disk must not kill the job
            _log.warning("checkpoint write failed (%s)", type(e).__name__)

    def clear(self) -> None:
        """Delete this video's checkpoints (called once the notes are done)."""
        if self.dir:
            for f in self.dir.glob("*.json*"):
                f.unlink(missing_ok=True)
            try:
                self.dir.rmdir()
            except OSError:
                pass


def profile_hash(client: _Client) -> str:
    """Hash of everything that shapes an answer: provider, model, profile name and tunables, prompt
    version. Shared by checkpoints and the cache, so a change to any of them never reuses old work."""
    prof = {k: v for k, v in sorted(client.profile.items()) if k != "read_timeout"}
    return hashlib.sha256(
        json.dumps(
            [client.provider, client.model, client.profile_name, prompts.PROMPT_VERSION, prof],
            sort_keys=True,
            default=str,
        ).encode()
    ).hexdigest()


def _cache_key(client: _Client, stage: str, *parts: Any) -> str:
    """Cache key: stage + key format + profile hash + prompt version + the exact prompt messages."""
    return cache.make_key(stage, cache.KEY_VERSION, profile_hash(client), prompts.PROMPT_VERSION, *parts)


def _single_pass(client: _Client, transcript: dict, text: str, meta: dict, report: _Reporter) -> dict:
    prof = client.profile
    n = prompts.target_section_count(transcript.get("duration_sec"), len(text), prof["max_total_sections"])
    report(10, "Writing the notebook (single pass)...")
    obj = client.ask_json(
        prompts.compose_single_messages(meta, text, n), prof["out_single"], schema=prompts.NOTES_SCHEMA
    )
    report(90, "Checking the notes...")
    if isinstance(obj, list):
        obj = {"sections": obj}
    return obj


PART_TIMEOUT = 45  # s; a parallel part call normally takes 5-15 s, a stuck one is retried instead
SECTIONS_PER_PART = 5  # parallel single pass: sections one slice call writes (~4k output tokens, ~10 s)


def _part_count(client: _Client, n_target: int) -> int:
    """How many parallel slice calls a single-pass-sized lecture gets (1 = classic single pass).
    Capped below the Gemini RPM so the parts plus the front-matter call fit one pacer window."""
    par = client.profile["parallel"]
    rpm = client.pacer.rpm
    if rpm:
        par = min(par, rpm - 1)
    if par <= 1 or n_target < 7:
        return 1
    return max(1, min(par, math.ceil(n_target / SECTIONS_PER_PART)))


def _parallel_single(
    client: _Client, transcript: dict, text_chars: int, meta: dict, parts: int, report: _Reporter
) -> dict:
    """Single pass split by time: ``parts`` slice calls (raw transcript -> sections) plus one front-matter
    call over the whole transcript, all at once. Wall time ~ the slowest call instead of the sum.
    Every call still goes through the shared pacer (Gemini RPM) and the daily-quota handling."""
    from concurrent.futures import ThreadPoolExecutor

    prof = client.profile
    n_target = prompts.target_section_count(transcript.get("duration_sec"), text_chars, prof["max_total_sections"])
    slices = _get_chunker()(transcript, max_chars=math.ceil(text_chars / parts) + 200, overlap_chars=0)
    if not slices:
        raise LLMError("The transcript is empty.")
    total = sum(len(s["text"]) for s in slices) or 1
    full_text = "\n".join(s["text"] for s in slices)
    jobs = []
    for i, sl in enumerate(slices):
        n = max(1, min(prof["max_sections_per_call"], round(n_target * len(sl["text"]) / total)))
        jobs.append((i, sl["text"], n))
    done = {"n": 0}
    lock = threading.Lock()
    report(10, f"Writing {len(jobs)} notebook parts in parallel...")

    def tick() -> None:
        with lock:
            done["n"] += 1
            report(10 + int(80 * done["n"] / (len(jobs) + 1)), f"Notebook parts written: {done['n']}/{len(jobs) + 1}")

    def cap_out(n: int) -> int:  # ~1k tokens per section is plenty; a tight cap stops runaway output early
        return min(prof["out_batch"], 2000 + 1000 * n)

    def part(job: tuple[int, str, int]) -> list:
        i, txt, n = job
        got: list = []
        for strict in ("", f"IMPORTANT: return AT LEAST {n} separate sections covering the whole slice."):
            msgs = prompts.compose_part_messages(meta, txt, n, n, i + 1, len(jobs), strict)
            try:
                again = find_sections(
                    client.ask_json(msgs, cap_out(n), schema=prompts.SECTIONS_SCHEMA, read_timeout=PART_TIMEOUT)
                )
            except _OutputTruncated as e:
                # usually a repetition loop: keep the complete sections, drop the runaway last one
                try:
                    again = find_sections(salvage_truncated_json(e.text))[:-1]
                except ValueError:
                    again = []
            except _BadJSON:
                again = []
            if _usable_count(again) > _usable_count(got):
                got = again
            if _usable_count(got) >= coverage_needed(n):
                break
        tick()
        return got

    def front() -> dict:
        try:
            obj = client.ask_json(
                prompts.compose_front_messages(meta, full_text),
                prof["final_out"] + 1500,
                schema=prompts.FRONT_SCHEMA,
                read_timeout=PART_TIMEOUT,
            )
        except (_BadJSON, _OutputTruncated):
            obj = {}
        tick()
        return obj if isinstance(obj, dict) else {}

    with ThreadPoolExecutor(max_workers=min(len(jobs) + 1, prof["parallel"] + 1)) as pool:
        f_front = pool.submit(front)
        f_parts = [pool.submit(part, j) for j in jobs]
        per_part = [f.result() for f in f_parts]  # in lecture order; re-raises LLMError (quota -> fallback)
        out = dict(f_front.result())
    sections = per_part[0] if per_part else []
    for nxt in per_part[1:]:
        sections = _join_parts(sections, nxt)
    report(90, "Checking the notes...")
    out["sections"] = sections
    if not out.get("glossary"):
        out["glossary"] = glossary_from_blocks(sections)
    return out


def _digest_chunks(
    client: _Client, chunks: list[dict], meta: dict, report: _Reporter, ckpt: _Checkpoints | None = None
) -> list[str]:
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


def _merge_levels(
    client: _Client, digests: list[str], meta: dict, report: _Reporter, ckpt: _Checkpoints | None = None
) -> list[str]:
    """Hierarchical reduce for very long lectures: while the digests exceed
    ``merge_budget_chars``, fold every ``merge_fanout`` consecutive digests into one part digest.
    Order and [h:mm:ss] markers are kept, so the compose stage still walks the lecture in time order."""
    prof = client.profile
    budget, fan = prof["merge_budget_chars"], max(2, int(prof["merge_fanout"]))
    level = 0
    while budget and len(digests) > 1 and sum(len(d) for d in digests) > budget and level < 6:
        level += 1
        groups = [digests[i : i + fan] for i in range(0, len(digests), fan)]
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
                    msgs = prompts.merge_messages(
                        meta, "\n\n".join(group), level, g_i + 1, len(groups), max(200, cap // 6)
                    )
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


def _compose_covered(
    client: _Client, meta: dict, digs: list[str], n: int, cap: int, prior: list[str], no: int, total: int
) -> list:
    """Compose one batch asking for ``n`` sections; if the model returns < 70 % of that, retry once
    with a stricter instruction (one section per consecutive time group) and keep the better result."""
    n = max(1, min(n, cap))
    n_max = min(cap, n + 1)
    first = prompts.compose_batch_messages(meta, "\n\n".join(digs), n, n_max, prior, no, total, "")
    ck = _cache_key(client, "compose", first)
    hit = cache.get("compose", ck)
    if (
        isinstance(hit, dict)
        and isinstance(hit.get("sections"), list)
        and _usable_count(hit["sections"]) >= coverage_needed(n)
    ):
        return hit["sections"]
    got = _compose_batch(client, meta, digs, n, n_max, prior, no, total)
    have = _usable_count(got)
    if have < coverage_needed(n):
        strict = (
            f"IMPORTANT: your previous answer contained only {have} usable section(s). "
            f"Return AT LEAST {n} sections: split the digests into {n} consecutive groups by their "
            "[mm:ss] markers and write one separate section per group, so the whole span from the "
            "first to the last marker is covered. Never merge the whole part into one section."
        )
        again = _compose_batch(client, meta, digs, n, n_max, prior, no, total, strict)
        if _usable_count(again) > have:
            got = again
    if client.cache_writes and _usable_count(got) >= coverage_needed(n):  # only accepted answers are kept
        cache.put("compose", ck, {"sections": got})
    return got


def _compose_batch(
    client: _Client,
    meta: dict,
    digs: list[str],
    n_min: int,
    n_max: int,
    prior: list[str],
    no: int,
    total: int,
    strict: str = "",
) -> list:
    text = "\n\n".join(digs)
    msgs = prompts.compose_batch_messages(meta, text, n_min, n_max, prior, no, total, strict)
    try:
        return find_sections(client.ask_json(msgs, client.profile["out_batch"], schema=prompts.SECTIONS_SCHEMA))
    except _OutputTruncated:
        if len(digs) > 1:  # too much for one reply: halve the input
            mid = len(digs) // 2
            a = _compose_batch(
                client, meta, digs[:mid], max(1, n_min // 2), max(1, n_max // 2), prior, no, total, strict
            )
            b = _compose_batch(
                client,
                meta,
                digs[mid:],
                max(1, n_min // 2),
                max(1, n_max // 2),
                prior + [s.get("title", "") for s in a if isinstance(s, dict)],
                no,
                total,
                strict,
            )
            return a + b
        if n_max > 1:
            return _compose_batch(client, meta, digs, 1, max(1, n_max - 1), prior, no, total, strict)
        raise LLMError(
            f"{client.label} could not fit the notes in its output limit. Try a model with a larger output limit."
        ) from None


def _map_reduce(
    client: _Client, transcript: dict, meta: dict, report: _Reporter, text_chars: int, ckpt: _Checkpoints | None = None
) -> dict:
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
        raise LLMError(
            "This video has nothing to teach - it looks like a trailer, music video, promo or "
            "entertainment clip rather than a lecture. Try a lecture, tutorial or talk video."
        )
    digests = _merge_levels(client, digests, meta, report, ckpt)

    batches = pack_batches(digests, prof["batch_chars"], min(slices_needed, len(digests)))
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
    if _usable_count(sections, max_sec) < coverage_needed(target):
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
            obj = client.ask_json(
                _final_messages_fit(client, meta, outline, terms),
                prof["final_out"] + prof["final_reasoning_reserve"],
                think=think,
                schema=prompts.FRONT_SCHEMA,
            )
            front = obj if isinstance(obj, dict) else {}
            if not front.get("glossary"):
                front["glossary"] = [
                    {"term": t.split(": ", 1)[0], "definition": t.split(": ", 1)[-1]} for t in terms[:20]
                ]
            if ckpt:
                ckpt.put("final", front)
        except (_BadJSON, _OutputTruncated):
            front = {}  # validate_notes derives recap/big_idea; glossary below
    out = dict(front)
    out["sections"] = sections
    if not out.get("glossary"):
        out["glossary"] = glossary_from_blocks(sections)
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


# provider id -> env var holding a SERVER-side key (mirrors backend/app/server.py ENV_KEYS)
# --------------------------------------------------------------------------- #
# 6. Public entry point: provider fallback chain + generate_notes
# --------------------------------------------------------------------------- #

SERVER_KEY_ENV = {
    "gemini": "GEMINI_API_KEY",
    "groq": "GROQ_API_KEY",
    "xai": "XAI_API_KEY",
    "huggingface": "HF_TOKEN",
    "nvidia": "NVIDIA_API_KEY",
}
# local -> Groq only for videos up to ~1 h: longer ones do not fit Groq's free tokens-per-minute budget
GROQ_FALLBACK_MAX_SEC_DEFAULT = 3600
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
    * any other primary (e.g. ``gemini``): ``local`` when its server is online, then Groq for videos
      up to LNAI_GROQ_FALLBACK_MAX_SEC, then NVIDIA; otherwise None (the original error is raised).
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
    # every other primary follows the same chain: local (online) -> Groq (<= cap) -> NVIDIA
    if local_online():
        return "local", ""
    dur = (transcript or {}).get("duration_sec") or 0
    groq = (os.environ.get("GROQ_API_KEY") or "").strip()
    if primary != "groq" and groq and 0 < dur <= _groq_fallback_max_sec():
        return "groq", groq
    nv = (os.environ.get("NVIDIA_API_KEY") or "").strip()
    if primary != "nvidia" and nv:
        return "nvidia", nv
    return None


def default_checkpoint_dir() -> str | None:
    """LNAI_CHECKPOINT_DIR, if set (callers normally pass ``checkpoint_dir`` explicitly)."""
    return (os.environ.get("LNAI_CHECKPOINT_DIR") or "").strip() or None


def generate_notes(
    transcript: dict,
    *,
    provider: str,
    api_key: str | None = None,
    model: str | None = None,
    progress: Progress | None = None,
    checkpoint_dir: str | Path | None = None,
) -> dict:
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
        return _generate_notes(
            transcript, provider=provider, api_key=api_key, model=model, progress=progress, checkpoint_dir=ckdir
        )
    except _TransientError as e:
        if not _fallback_enabled():
            raise
        target = _fallback_target(provider, transcript if isinstance(transcript, dict) else None)
        if target is None:
            raise
        fb, fb_key = target
        _log.warning("LLM provider %s failed (%s); falling back to %s", provider, scrub_secrets(e, api_key, 160), fb)
        if progress:
            try:
                why = "daily quota reached" if getattr(e, "daily_quota", False) else "is busy"
                progress(
                    "notes",
                    3,
                    f"{PROVIDERS[provider]['label']} {why}; retrying the whole video with {PROVIDERS[fb]['label']}...",
                )
            except Exception:  # noqa: BLE001
                pass
        try:
            notes = _generate_notes(
                transcript,
                provider=fb,
                api_key=fb_key,
                model=None,
                progress=progress,
                checkpoint_dir=ckdir,
                cache_writes=False,
            )
        except LLMError as e2:
            raise LLMError(
                f"{e} Fallback to {PROVIDERS[fb]['label']} also failed: {scrub_secrets(e2, fb_key, 300)}"
            ) from None
        meta = notes.setdefault("meta", {})
        meta["provider"] = fb
        meta["fallback_from"] = provider
        return notes


def _generate_notes(
    transcript: dict,
    *,
    provider: str,
    api_key: str | None,
    model: str | None,
    progress: Progress | None,
    checkpoint_dir: str | Path | None = None,
    cache_writes: bool = True,
) -> dict:
    if provider not in PROVIDERS:
        raise LLMError(
            f"Unknown provider '{scrub_secrets(provider, None, 40)}'. Choose one of: {', '.join(PROVIDERS)}."
        )
    alias_of = provider
    base_url = None
    if provider == "colab":  # deprecated alias: the local provider on COLAB_LLM_URL / COLAB_LLM_KEY
        _log.warning("provider 'colab' is deprecated; use 'local' with LNAI_LOCAL_URL and LNAI_LOCAL_KEY")
        base_url = colab_base_url()
        key = clean_api_key(api_key or os.environ.get("COLAB_LLM_KEY"))
        provider = "local"
    elif provider == "local":
        key = local_key()  # server-side only: a key typed in the app is never sent to a local server
    else:
        key = clean_api_key(api_key) if PROVIDERS[provider].get("needs_key", True) else ""
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

    client = _Client(provider, key, model, base_url=base_url, profile_name=profile_name, cache_writes=cache_writes)
    report = _Reporter(progress)
    client.notify = lambda msg: report(report.last, msg)
    meta = _meta_for_prompt(transcript)
    model_tag = f"{provider}/{model}"
    max_sec = client.profile["max_total_sections"]
    try:
        report(2, f"Preparing transcript for {client.label}...")
        chunker = _get_chunker()
        full = chunker(transcript, max_chars=10**9, overlap_chars=0)
        text = "\n".join(c["text"] for c in full)
        ckpt = _Checkpoints(checkpoint_dir, transcript, text, client)
        n_target = prompts.target_section_count(transcript.get("duration_sec"), len(text), max_sec)
        reserve = client.profile["reasoning_reserve"]
        fits_output = n_target * SECTION_TOKENS + 1200 + reserve <= client.profile["out_single"] * 0.9
        raw = None
        parts = _part_count(client, n_target)
        if len(text) <= client.profile["single_chars"] and parts > 1:
            try:
                raw = _parallel_single(client, transcript, len(text), meta, parts, report)
                have = len(validate_notes(raw, transcript, max_sections=max_sec)["sections"])
                if have < coverage_needed(n_target):
                    report(12, f"Only {have} of ~{n_target} sections came back; rewriting slice by slice...")
                    raw = None
            except ValueError:
                report(12, "Parallel pass was not usable; switching to the multi-step method...")
                raw = None
        elif len(text) <= client.profile["single_chars"] and fits_output:
            try:
                raw = _single_pass(client, transcript, text, meta, report)
                have = len(validate_notes(raw, transcript, max_sections=max_sec)["sections"])
                if have < coverage_needed(n_target):
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
        raise LLMError(
            f"The model's answer could not be turned into notes ({scrub_secrets(e, key, 120)}). Please retry."
        ) from None
    except Exception as e:  # noqa: BLE001 - never leak internals/keys
        raise LLMError(f"Unexpected error while generating notes ({type(e).__name__}). Please retry.") from None
    report(100, "Notes ready.")
    return notes
