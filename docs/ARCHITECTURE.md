# AQspace - architecture

Status: current as of 2026-11-03 (R1-R6). Owner: `scaling-lead`. Decisions behind this document: [`docs/decisions/`](decisions/) (ADR-0003 local model, ADR-0004 upstream convergence).

AQspace turns YouTube lectures into playlists you watch in order, with resume-where-you-left-off progress and AI study notes (HTML + PDF) built from each video's transcript. It was rebuilt from upstream `developer4-gif/aq` (R1), containerised (R2), exposed through a Cloudflare quick tunnel (R3), given a local Qwen3-8B notes model for videos up to 24 h (R5), and is merging upstream's Nov 2-3 `feature/dev-tools` work (R6, card #47).

Rule of thumb: **Node (aq-api) owns state and identity; Python (notes-ai) owns slow, stateless work; the model server owns GPU time.**

Items marked **PENDING** are not on `main` yet.

## 1. Services and ports

| Service | Folder / image | Runtime | Listens on | Reachable from |
|---|---|---|---|---|
| `notes-ai` | `lecture-notes-ai/` | Python, Flask, `notes_engine` | `127.0.0.1:5055` inside its network namespace | aq-api only (never published) |
| `aq-api` | `aq-api/` (`aq-api/Dockerfile`) | Node 24, Express 5, `node:sqlite` | `5180` (shares notes-ai's namespace) | host `127.0.0.1:5180` only |
| `tunnel` (profile `tunnel`) | `cloudflare/cloudflared:2026.10.3` | cloudflared quick tunnel | shares notes-ai's namespace | public `https://*.trycloudflare.com` -> `127.0.0.1:5180` |
| `llama-server` | native on the Mac, `.tools/llama.cpp/` | llama.cpp, Metal | `127.0.0.1:8081` on the host | notes-ai via `host.docker.internal:8081` |

`docker compose up --build` starts everything except the model server and the tunnel. `docker compose --profile tunnel up` adds the public link. `lecture-notes-ui/` is static vanilla JS served by aq-api on 5180 (no build step).

Only 5180 is published for the notes app, and only on 127.0.0.1. 5055 and 8081 are loopback-only by design: notes-ai has no auth and llama-server has no key.

```
 browser (localhost:5180)        browser (https://xyz.trycloudflare.com)
        |                                      |
        |                          +-----------v-----------+
        |                          | tunnel (cloudflared)  |  profile "tunnel"
        |                          +-----------+-----------+
        |   127.0.0.1:5180 (published)         | 127.0.0.1:5180, Host: localhost:5180
 +------v--------------------------------------v--------------------------------+
 | shared network namespace of notes-ai (Docker)                                |
 |  aq-api :5180  host guard -> CORS (+TUNNEL_ORIGINS) -> headers -> rate limit |
 |    routes: playlists | videos | progress | notes | smart | /dev (dev tools)  |
 |    SQLite ./aq-api/data/aq.db  (migrations 001-003)                          |
 |        | HTTP 127.0.0.1:5055 (pyclient.js)                                   |
 |  notes-ai :5055  Flask  -> notes_engine: ingest | llm | pdf | smart_playlist |
 |    output + checkpoints ./lecture-notes-ai/backend/output (bind mount)       |
 +--------|---------------------------------------------------------------------+
          | host.docker.internal:8081 (OpenAI-compatible /v1/chat/completions)
 +--------v-------------------------+      cloud fallbacks (keys in backend/.env):
 | llama-server (native, Metal GPU) |      Groq (short videos), Gemini, xAI, HF,
 | Qwen3-8B-Q4_K_M, models/ (5 GB)  |      NVIDIA Nemotron, Colab (upstream)
 +----------------------------------+
```

## 2. Request flow and security

Every `/api` request through aq-api passes, in order (`aq-api/src/app.js`, `aq-api/src/middleware/security.js`):

1. **Host guard** (DNS-rebinding defence): `Host` must be `localhost`, `127.0.0.1` or `[::1]` with any port. The tunnel passes because cloudflared rewrites `Host` to `localhost:5180` (`--http-host-header`).
2. **CORS / origin check**: state-changing requests need an allowed `Origin`: loopback http origins plus `TUNNEL_ORIGINS` (comma list, `*` matches one DNS label; compose sets `https://*.trycloudflare.com`).
3. **Security headers**: CSP (self + YouTube + Google Fonts only), `nosniff`, `X-Frame-Options: SAMEORIGIN`; API responses get `default-src 'none'`.
4. **Rate limits** per client IP, fixed 1-minute window: general 600/min (`RATE_LIMIT_PER_MIN`), heavy 20/min (`RATE_LIMIT_HEAVY_PER_MIN`) for starting notes, YouTube imports and smart runs. Body limit 256 kB.
5. **Auth middleware** (user seam from upstream) and `NOTES_REQUIRE_MEMBERSHIP` (notes only for videos in the user's playlists).

aq-api calls notes-ai only at `PY_NOTES_URL=http://127.0.0.1:5055`; a remote Python URL is refused unless `ALLOW_REMOTE_PY=1`.

Caveat: behind the tunnel every request arrives from 127.0.0.1 with a loopback Host, so "local only" checks that look at the socket or Host do not tell tunnel traffic from local traffic. See ADR-0004 for how `/dev` is protected.

## 3. Data (SQLite)

`aq-api/data/aq.db` (bind-mounted, gitignored, removed by `scripts/nuke.sh`). Migrations in `aq-api/sql/`, applied in order by `src/db.js`:

| Migration | Adds |
|---|---|
| `001_init.sql` | `users`, `videos`, `playlists`, `playlist_videos`, `watch_progress`, `notes_jobs` (status/pct/stage per video, cached by `video_id`) |
| `002_notes_resumes.sql` | `notes_jobs.resumes`: auto-resume counter after a Python restart (cap `NOTES_MAX_AUTO_RESUMES`, default 3) |
| `003_smart_runs.sql` | `smart_runs`: one row per smart-playlist run (fingerprint, status, result/usage JSON); upstream's `002_smart_runs.sql` renumbered. **PENDING** #47 |

The legacy Google sign-in app (separate backend, frontend and Postgres) was removed on 2026-11-11 (ADR-0001); sign-in now lives in aq-api.

## 4. Notes pipeline (notes-ai)

1. **Ingest** (`notes_engine/ingest.py`): YouTube captions; if none, audio through yt-dlp and **faster-whisper** (`small`, CPU int8, models in `.tools/whisper-models/`) or Groq Whisper (10-min slices). GPU Whisper for 24 h audio is card #36.
2. **Notes** (`notes_engine/llm.py`), sized by a per-provider profile:
   - **single pass** when the transcript fits `single_chars`;
   - otherwise **map** (one digest per `chunk_chars` slice), **merge** (when digests exceed ~3 x `batch_chars`, groups of 8 digests become part digests, recursively), **compose** (sections per batch of digests), **final** (subtitle, overview, glossary, recap).
3. **Checkpoints**: each finished map/merge/compose/final call is written atomically under `<checkpoint_dir>/<video_id>/` (`LNAI_CHECKPOINT_DIR`, inside the bind-mounted output). They are reused only when transcript hash, provider, model and prompt version match, and deleted when the notes are saved.
4. **Resume**: if Python restarts, aq-api sees the lost job id on its next poll, re-submits the video (`notes-service.js`), and Python skips work already in its checkpoints. At most one call is lost.
5. **Fallback**: with `LNA_PROVIDER_FALLBACK=1`, an unreachable local server or a rate limit triggers one full retry on another provider (Groq only for videos up to ~1 h). Providers are never mixed inside one video.
6. **Render** (`pdf.py`, `templates/`): HTML + PDF in `backend/output/`.

## 5. Local model: Qwen3-8B on llama.cpp (ADR-0003)

- `models/Qwen3-8B-Q4_K_M.gguf` (5 GB, gitignored), served natively by `llama-server` at `127.0.0.1:8081` with Metal offload, 16K context, 1 slot, q8_0 KV cache, alias `qwen3-8b`. Docker on macOS has no GPU, so it does not run in a container.
- Provider `local` (no key), URL from `LNAI_LOCAL_URL` (compose: `http://host.docker.internal:8081/v1`); aq-api defaults to `PY_NOTES_PROVIDER=local`.
- Thinking off for map and compose, on for the final call.
- Estimated time: 1 h video ~25-35 min, 24 h video ~5-6 h (assumed speeds; to be measured).
- **PENDING #37**: repo-local llama.cpp install and start script (`scripts/llm.sh`), plus measured speeds. Until then `local` is offline and only fallback providers work.
- **PENDING #38** Drive backup (`drive.file` scope). **Backlog #39** Colab runner of the same server.

## 6. Upstream features (R6, importing on card #47, PENDING)

- **Smart playlist** (`notes_engine/smart_playlist.py`, `aq-api/src/smart-service.js`, `routes/smart.js`, UI `smart.js`/`smartmagic.*`): the playlist name is the goal. Three LLM agents (profiler, sequencer, gap analyst) propose, and plain code checks the result (quotes must appear in the transcript, ids must exist, order is a permutation). aq-api stores each run in `smart_runs`, dedupes by fingerprint (goal + sorted video ids), and marks runs "interrupted" when Python loses the job.
- **Dev tools** (`aq-api/src/dev.js`, `aq-api/dev-ui/`): `/dev` tracker pages with in-memory request/event ring buffers, daily JSONL under `aq-api/data/devlogs/` (14 days), and service-log tails. Paths are masked; no headers, bodies or query strings are stored. Exposure rules are in ADR-0004.
- **Notes cache** (`notes_engine/cache.py`): an LRU disk cache of transcripts and accepted digest/compose answers, keyed by sha256 of prompt + provider + model. Off unless `LNA_CACHE_DIR` is set, capped at `LNA_CACHE_MAX_MB` (300). How it relates to our checkpoints is in ADR-0004.
- **Extra providers**: `nvidia` (Nemotron on NVIDIA NIM, key) and `colab` (Qwen3-8B behind a cloudflared link, `COLAB_LLM_URL` + `COLAB_LLM_KEY`).
- Windows scripts (`start-all.ps1`, `scripts/*.ps1`) come along but are not supported on our macOS/Docker setup.

## 7. Storage

Everything stays in the repo (`.claude/rules/storage.md`): `.data/pgdata`, `aq-api/data/` (SQLite, devlogs), `lecture-notes-ai/backend/output/` (notes, checkpoints, cache), `models/`, `.tools/` (llama.cpp, Whisper models), `.npm-cache/`. All are gitignored and removed by `scripts/nuke.sh`. Any new directory (such as `LNA_CACHE_DIR`) must go under one of these and be added to nuke.
