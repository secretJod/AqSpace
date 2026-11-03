# ADR-0004: Converging upstream feature/dev-tools with AQspace R5

- Status: Accepted
- Date: 2026-11-03
- Decider: scaling-lead (card #48, R6)
- Related: ADR-0003 (local Qwen3-8B), card #47 (import), PR #45 (R5 integration)

## Context

Upstream `developer4-gif/aq` `feature/dev-tools` (Nov 2-3) adds four things that overlap with what we built for R5:

1. **Providers** `nvidia` (Nemotron 120B on NVIDIA NIM, key, ~40 req/min) and `colab` (Qwen3-8B on llama.cpp on a Colab T4 behind a cloudflared link, `COLAB_LLM_URL` + `COLAB_LLM_KEY`, small 6-8k-char profile). Our `local` provider runs the same model and the same server natively at `LNAI_LOCAL_URL`, with no key.
2. **`notes_engine/cache.py`**: an LRU disk cache (off unless `LNA_CACHE_DIR`, 300 MB cap) of transcripts and accepted digest/compose answers, keyed by sha256 of (stage, provider, model, messages, limits). Our checkpoints (`LNAI_CHECKPOINT_DIR/<video_id>/`) save every map/merge/compose/final step of one job, check the transcript and profile hash, and are deleted when the notes are saved.
3. **`smart_runs`** table (upstream `002_smart_runs.sql`, which collides with our `002_notes_resumes.sql`) and `smart-service.js`.
4. **Dev tools** `/dev` (`dev.js`, `dev-ui/`): on by default (`AQ_DEV_TOOLS !== "0"`), "local only" through the host guard. They expose request/event logs and tails of service consoles.

Finding: in our compose setup the tunnel shares aq-api's network namespace and rewrites `Host` to `localhost:5180`. Tunnel requests therefore come from 127.0.0.1 with a loopback Host, so upstream's "local only" `/dev` **is public through the tunnel**. That has to be fixed before #47 merges.

## Options and decisions

### 1. Colab and Nemotron vs `local`
- (a) Merge `colab` into `local`: one OpenAI-compatible self-hosted provider, with URL and optional key from env.
- (b) Keep both as separate providers.
- (c) Drop the upstream providers.

**Decision: (a) for `colab`, keep `nvidia`.** `colab` is the same llama-server we run locally, so it becomes a deployment of `local`, not a separate provider. `local` reads an optional `LNAI_LOCAL_KEY` (sent as a Bearer token) and accepts an https `LNAI_LOCAL_URL` (validated like upstream's `_colab_url`). The profile is chosen by context size, not by where the server runs: our 16K `local` profile, plus a `local-small` variant with upstream's colab numbers when `LNAI_LOCAL_CTX` is 8K or less. `colab` stays as a deprecated alias that maps to `local` for one release, and `COLAB_LLM_URL`/`COLAB_LLM_KEY` are read as fallbacks for the `LNAI_LOCAL_*` names. This also covers our card #39 (Colab runner).
`nvidia` stays as a normal cloud provider: it is a different model, it is free and has no daily cap. It becomes the **second fallback** for long videos when `local` is down (Groq is limited to about 1 h), which removes the "long videos stay queued" gap from ADR-0003. Providers are still never mixed within one video.

### 2. cache.py vs checkpoints
- (a) Dedupe: drop one of them.
- (b) Layer them, each with its own job.

**Decision: (b) layer them, with clear roles.** Checkpoints are **job state** (crash resume, one video, deleted on success). The cache is **cross-job reuse** (same transcript re-run, smart playlist re-reading transcripts, retries after a failed final call). Order inside `_digest_chunks` / `_compose_batch`: checkpoint first, then cache, then model, and a model answer is written to both. Rules:
- The cache key must include the profile hash and prompt version that checkpoints already use, so a profile change cannot serve stale digests.
- Never cache degraded or fallback answers (upstream already does this) and never cache across providers.
- `LNA_CACHE_DIR` defaults to `lecture-notes-ai/backend/output/cache` in compose (bind mount, gitignored) and is added to `scripts/nuke.sh`.
- Transcript caching (30 days) is kept. It saves the most time for 24 h videos (Whisper).

### 3. smart_runs storage
**Decision: SQLite in aq-api, as upstream built it, renumbered to `003_smart_runs.sql`.** It follows the `notes_jobs` pattern (Node owns state, Python is stateless), and the fingerprint unique index gives us dedupe. Our `002_notes_resumes.sql` keeps its number because it is already applied to existing databases. `db.js` must apply migrations by file name in order and record them, so that a database that already has upstream's `002_smart_runs` (no AQspace user has one) does not break. Smart runs do **not** get checkpoints yet: they are short (three agent calls), and an interrupted run is marked as an error and re-run.

### 4. Dev tools exposure
- (a) Loopback only (upstream's intent).
- (b) Behind auth.

**Decision: (a), done correctly, and off by default in Docker.** We have no real auth yet, and a token-gated public dev console is attack surface we don't need.
- Compose sets `AQ_DEV_TOOLS=0`. Developers turn it on locally with `AQ_DEV_TOOLS=1`.
- When on, `/dev` also rejects any request that carries proxy markers (`Cf-Connecting-IP`, `Cf-Ray`, `X-Forwarded-For`, `Forwarded`) or whose `Origin` matches `TUNNEL_ORIGINS`. This is what tells tunnel traffic apart from local traffic in our shared namespace.
- `/dev` keeps its strict CSP and is never covered by `TUNNEL_ORIGINS` CORS.
- `runDir` log tails (`../.run`, a Windows `start-all.ps1` layout) stay off on macOS/Docker unless `AQ_RUN_DIR` is set.
- `aq-api/data/devlogs/` is gitignored and cleaned by nuke.
- Revisit (b) only once R-level real auth exists.

## Follow-ups (cards to open)

| # | Owner | Work |
|---|---|---|
| F1 (p0, blocks #47 merge) | `web-dev-1` | `/dev` tunnel guard (proxy headers and tunnel origin rejected), `AQ_DEV_TOOLS` default off in compose, a security test that a request through the tunnel to `/dev` gets 404 |
| F2 | `web-dev-1` | `003_smart_runs.sql` renumber and ordered migration tracking in `db.js`, with a migration test |
| F3 | `ai-dev-1` | Fold `colab` into `local` (`LNAI_LOCAL_KEY`, https URL, `local-small` profile, deprecated alias); `nvidia` as second fallback for long videos; tests |
| F4 | `ai-dev-1` | Layer cache under checkpoints (lookup order, profile hash and prompt version in key); tests |
| F5 | `web-dev-2` | `LNA_CACHE_DIR` in compose, `AQ_DEV_TOOLS=0`, nuke.sh entries for cache and devlogs, `.gitignore` |
| F6 | `web-dev-3` | E2E: notes job crash then resume with cache on; smart run through the tunnel; `/dev` blocked through the tunnel |
| F7 | `ai-dev-2` | Make sure smart_playlist reads transcripts through `ingest.get_transcript` and its cache (Whisper path included) |
| F8 | `scaling-lead` | Update ADR-0003 fallback section after F3; close #39 as covered by F3 |

## Consequences

- One self-hosted provider (`local`) whether the server runs on the Mac or on Colab: one profile family and one test suite.
- Long videos get a cloud fallback (Nemotron) instead of waiting in a queue. The cost is a new external key, which is optional.
- Two disk stores for the notes engine. Their roles are documented here, and both are repo-local and nuked.
- `/dev` is no longer public through the tunnel. Developers must opt in.
- Migration numbering diverges from upstream (003 vs 002). Future upstream imports must renumber, and `db.js` tracking makes that safe.
