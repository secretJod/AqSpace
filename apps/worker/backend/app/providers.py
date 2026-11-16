"""AI provider list and server-side keys.

``provider_table()`` merges the engine's ``llm.PROVIDERS`` (if it can be imported) with
``FALLBACK_PROVIDERS``, so the UI always gets the full, ordered list.
``server_key(pid)`` reads the key from the environment (backend/.env). Keys are never returned
to the browser; the API only reports *whether* a server key exists.

Read next: ``routes.py``.
"""

from __future__ import annotations

import os

from .settings import ENV_KEYS, FALLBACK_PROVIDERS, KEYLESS, PROVIDER_ORDER


def provider_table() -> dict:
    """provider id -> {label, default_model, key_hint}, for every id in PROVIDER_ORDER."""
    table = {}
    try:
        from notes_engine import llm  # lazy: the server must start even if llm is broken

        for pid, meta in (getattr(llm, "PROVIDERS", None) or {}).items():
            if pid in FALLBACK_PROVIDERS and isinstance(meta, dict):
                fallback = FALLBACK_PROVIDERS[pid]
                table[pid] = {
                    "label": meta.get("label") or fallback["label"],
                    "default_model": meta.get("default_model") or fallback["default_model"],
                    "key_hint": meta.get("key_hint") or fallback["key_hint"],
                }
    except Exception:
        table = {}
    for pid in PROVIDER_ORDER:
        table.setdefault(pid, dict(FALLBACK_PROVIDERS[pid]))
    return table


def server_key(pid: str) -> str:
    """The server-side API key for a provider ("" if none is configured)."""
    return (os.environ.get(ENV_KEYS[pid]) or "").strip() if pid in ENV_KEYS else ""


def local_online() -> bool:
    """True when the local llama-server answers (1 s probe; False on any error)."""
    try:
        from notes_engine import llm

        return bool(llm.local_online(timeout=1.0))
    except Exception:
        return False


def provider_rows() -> list[dict]:
    """The /api/providers list: label, default model, key hint, needs_key, server_key (+ online for local)."""
    table = provider_table()
    rows = []
    for pid in PROVIDER_ORDER:
        row = {"id": pid, **table[pid], "needs_key": pid not in KEYLESS, "server_key": bool(server_key(pid))}
        if pid in KEYLESS:
            row["online"] = local_online()
        rows.append(row)
    return rows
