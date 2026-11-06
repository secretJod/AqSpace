# AQspace

AQspace turns YouTube lectures (up to 24 hours long) into hand-drawn "field notebook" study notes, as a web page and a PDF. Paste a video or a playlist, watch it inside the app, and read the notes beside the video. Notes are written by a local open-source model on your Mac (Qwen3-8B), with Groq as the fallback.

The repo also holds a small Google sign-in test app (`backend/`, `frontend/`).

Everything the app creates stays inside this folder (`.data/`, `models/`, `.npm-cache/`, `aq-api/data/`, `lecture-notes-ai/backend/output/`). `scripts/nuke.sh` removes it all.

## Start (one command)

Requirements: Docker Desktop running.

1. Put the keys in place (see [Keys](#keys)).
2. Start everything:
   ```bash
   docker compose up --build
   ```
   The first build is slow (Chromium, ffmpeg, Whisper). Later starts are fast.
3. Open http://localhost:5180

| URL | What |
|---|---|
| http://localhost:5180 | AQspace notes app (UI + API) |
| http://localhost:5173 | Google sign-in test app (frontend) |
| http://localhost:4000 | Google sign-in test app (API) |

Stop with `docker compose down`. Logs: `docker compose logs -f notes-ai aq-api`.

## Local model

The notes worker talks to a llama.cpp `llama-server` running natively on the Mac at `127.0.0.1:8081` (Metal GPU). The model file, Qwen3-8B-Q4_K_M GGUF (about 5 GB), lives in `models/` and is not in git.

```bash
scripts/llm.sh start     # pending card #37 (llama.cpp install)
```

Until #37 lands, the local model is not available and notes fall back to Groq (short videos only). `curl -s 'localhost:5180/api/health?deep=1'` shows `localModel: ok` or `offline`. Plain-language guide: [docs/client/local-model.md](docs/client/local-model.md).

## Public link (Cloudflare tunnel, optional)

```bash
docker compose --profile tunnel up --build
docker compose logs tunnel | grep trycloudflare.com   # your public https link
```

The tunnel only exposes the app on port 5180. The link changes on every restart. There is no login, so anyone with the link can make notes on your machine and your Groq key. Stop it with `docker compose stop tunnel`.

## Keys

Keys are never committed and never baked into an image. Copy the `.example` files and fill them in.

| File | What goes there |
|---|---|
| `lecture-notes-ai/backend/.env` | AI provider keys (for example `GROQ_API_KEY`). Copy from `lecture-notes-ai/backend/.env.example`. |
| `.env` (repo root) | Google OAuth client id/secret and `SESSION_SECRET` for the sign-in app. Copy from `.env.example`. |

`.env` files are not on GitHub: back them up before deleting the repo. Run `scripts/secret-scan.sh` before pushing.

## Layout

| Path | What |
|---|---|
| `aq-api/` | Node/Express app backend and SQLite store, port 5180 |
| `lecture-notes-ai/` | Python notes worker (transcripts, Whisper, LLM, PDF), internal port 5055 |
| `lecture-notes-ui/` | Vanilla JS UI (no build step) |
| `backend/`, `frontend/` | Google sign-in test app |
| `scripts/` | `nuke.sh`, `secret-scan.sh`, `gh.sh` (repo-local GitHub CLI), `board.sh` |

## Tests

```bash
cd aq-api && npm test
cd lecture-notes-ai && LNA_OFFLINE=1 .venv/bin/python -m pytest tests -q
```

## Docs

- [docs/PLAN.md](docs/PLAN.md): the plan and requirements (R1, R2, ...)
- [docs/qa/](docs/qa/): test plans and checklists
- [docs/client/](docs/client/): release notes, demo script, guides
- [docs/decisions/](docs/decisions/): architecture decisions (ADRs)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/AGENT_JOURNAL.md](docs/AGENT_JOURNAL.md)
- Board: https://github.com/users/secretJod/projects/2
