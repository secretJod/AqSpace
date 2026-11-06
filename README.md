# AQspace

AQspace turns YouTube lectures (up to 24 hours long) into hand-drawn "field notebook" study notes, as a web page and a PDF. Paste a video or a playlist, watch it inside the app, and read the notes beside the video. Notes are written by Google Gemini by default (fast, handles long videos), with an automatic fallback chain (see [AI providers](#ai-providers)).

The app opens on a dashboard with a daily study streak, and you move between screens with a bottom navigation bar.

The repo also holds a small Google sign-in test app (`backend/`, `frontend/`).

Everything the app creates stays inside this folder (`.data/`, `models/`, `.npm-cache/`, `aq-api/data/`, `lecture-notes-ai/backend/output/`). `scripts/nuke.sh` removes it all.

## Start (one command)

Requirements: Docker Desktop running.

1. Get the code. Until PR #82 merges into `main`, the latest build lives on `preview/latest`:
   ```bash
   git fetch origin && git checkout preview/latest
   ```
2. Put the keys in place (see [Keys](#keys)). For the default setup, `GEMINI_API_KEY` is enough.
3. Start everything:
   ```bash
   docker compose up --build
   ```
   The first build is slow (Chromium, ffmpeg, Whisper). Later starts are fast.
4. Open http://localhost:5180

First time? Follow the step-by-step check in [docs/qa/first-run.md](docs/qa/first-run.md).

| URL | What |
|---|---|
| http://localhost:5180 | AQspace notes app (UI + API) |
| http://localhost:5173 | Google sign-in test app (frontend) |
| http://localhost:4000 | Google sign-in test app (API) |

Stop with `docker compose down`. Logs: `docker compose logs -f notes-ai aq-api`.

## What you see

- **Dashboard:** the home screen, bringing your playlists and activity together.
- **Daily streak:** counts the days in a row you studied, saved in your browser.
- **Bottom nav:** a "liquid glass" navigation bar at the bottom of the screen to switch between screens.

## AI providers

Notes use **Gemini** by default (`PY_NOTES_PROVIDER=gemini` in `docker-compose.yml`; set `PY_NOTES_PROVIDER=local` or `groq` to change it). If the provider fails (rate limit, outage, timeout), AQspace retries the whole video once with another provider: the local model if it is online, then Groq (videos up to 1 hour), then NVIDIA. Providers are never mixed inside one video.

| Provider | Model | Status | Key |
|---|---|---|---|
| Google Gemini | gemini-3.5-flash-lite | **Default** | `GEMINI_API_KEY` |
| Groq | cloud, free tier | Fallback, videos up to 1 h | `GROQ_API_KEY` |
| NVIDIA NIM | Nemotron | Fallback for longer videos | `NVIDIA_API_KEY` |
| Local (Mac) | Qwen3-8B via llama.cpp | Waiting for llama.cpp approval (#37) | none |
| Local candidates | Qwen3.5-9B, gpt-oss-20b | Being evaluated (#75) | none |
| Google Colab | Qwen3-32B | Optional, when the Mac is busy | `COLAB_LLM_URL`, `COLAB_LLM_KEY` |

## Local model

The notes worker talks to a llama.cpp `llama-server` running natively on the Mac at `127.0.0.1:8081` (Metal GPU). The model file, Qwen3-8B-Q4_K_M GGUF (about 5 GB), lives in `models/` and is not in git.

```bash
scripts/llm.sh start     # pending card #37 (llama.cpp install)
```

Until #37 lands, the local model is not available and notes use Gemini (or the fallback chain above). `curl -s 'localhost:5180/api/v1/health?deep=1'` shows `localModel: ok` or `offline`. Plain-language guide: [docs/client/local-model.md](docs/client/local-model.md).

## Public link (Cloudflare tunnel, optional)

```bash
docker compose --profile tunnel up --build
docker compose logs tunnel | grep trycloudflare.com   # your public https link
```

The tunnel only exposes the app on port 5180. The link changes on every restart. There is no login, so anyone with the link can make notes on your machine and your AI keys. Stop it with `docker compose stop tunnel`.

## Keys

Keys are never committed and never baked into an image. Copy the `.example` files and fill them in.

| File | What goes there |
|---|---|
| `lecture-notes-ai/backend/.env` | AI provider keys: `GEMINI_API_KEY` (default), optional `GROQ_API_KEY`, `NVIDIA_API_KEY`, Colab link/key. Copy from `lecture-notes-ai/backend/.env.example`. |
| `.env` (repo root) | Google OAuth client id/secret and `SESSION_SECRET` for the sign-in app. Copy from `.env.example`. |

`.env` files are not on GitHub: back them up before deleting the repo. Run `scripts/secret-scan.sh` before pushing.

## Layout

| Path | What |
|---|---|
| `aq-api/` | Node/Express app backend and SQLite store, port 5180 |
| `lecture-notes-ai/` | Python notes worker (transcripts, Whisper, LLM, PDF), internal port 5055 |
| `lecture-notes-ui/` | Vanilla JS UI (no build step): dashboard, streak, bottom nav, player, notes |
| `backend/`, `frontend/` | Google sign-in test app |
| `scripts/` | `nuke.sh`, `secret-scan.sh`, `gh.sh` (repo-local GitHub CLI), `board.sh` |

## Tests

```bash
cd aq-api && npm test
cd lecture-notes-ai && LNA_OFFLINE=1 .venv/bin/python -m pytest tests -q
```

## Docs

- [docs/PLAN.md](docs/PLAN.md): the plan and requirements (R1, R2, ...)
- [docs/qa/first-run.md](docs/qa/first-run.md): first-run check
- [docs/qa/](docs/qa/): test plans and checklists
- [docs/client/](docs/client/): release notes ([v0.3](docs/client/release-notes-v0.3.md)), demo script, guides
- [docs/decisions/](docs/decisions/): architecture decisions (ADRs)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/AGENT_JOURNAL.md](docs/AGENT_JOURNAL.md)
- Board: https://github.com/users/secretJod/projects/2
