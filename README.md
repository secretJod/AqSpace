# AQspace - repository overview

This repository holds two things:

1. **Google OAuth app** (`backend/`, `frontend/`, `docker-compose.yml`) - setup notes right below.
2. **AQspace notes app** - turns YouTube lectures into hand-drawn "field notebook" study notes. See [AQspace notes app](#aqspace-notes-app) further down.

Everything the apps create stays inside this folder (Postgres in `.data/pgdata`, caches in `.npm-cache/` and `.pip-cache/`, runtime files in `.run/`). `scripts/nuke.sh` removes it all.

---

## Run everything with Docker (one command)

Requirements: Docker Desktop running. Nothing else needs installing on the host.

1. Paste your Groq key (https://console.groq.com/keys) into `lecture-notes-ai/backend/.env`:
   ```
   GROQ_API_KEY=gsk_...
   ```
   (Copy `lecture-notes-ai/backend/.env.example` if the file is missing. The key is read at runtime and never baked into an image.)
2. Make sure the root `.env` (Google OAuth keys, see [OAuth app](#oauth-app)) exists.
3. Start everything:
   ```bash
   docker compose up --build
   ```
   The first build downloads Chromium and ffmpeg and can take a while; later starts are fast.

| URL | What |
|---|---|
| http://localhost:5180 | AQspace notes app (UI + API) |
| http://localhost:5173 | OAuth app frontend |
| http://localhost:4000 | OAuth app API |

- Stop: `docker compose down`
- Logs: `docker compose logs -f notes-ai aq-api`

Data stays in the repo: SQLite in `aq-api/data/`, generated notes in `lecture-notes-ai/backend/output/`, Postgres in `.data/pgdata`. The Python worker (port 5055) is internal only.

---

## OAuth app

### Setup
1. Google Cloud Console -> APIs & Services -> Credentials -> Create OAuth client ID (Web application)
   - Authorized JavaScript origin:  http://localhost:5173
   - Authorized redirect URI:       http://localhost:5173/api/auth/google/callback
2. Put the client id/secret in `.env` (`cp .env.example .env`, and set a long random SESSION_SECRET)
3. `docker compose up --build`  (stop with Ctrl+C or `docker compose down`)
4. Open http://localhost:5173

### Test with Postman / curl (no Google needed)
- GET  http://localhost:4000/api/health
- GET  http://localhost:4000/api/workspaces            -> 401
- POST http://localhost:4000/api/auth/dev-login        body (JSON): {"email":"a@b.com","name":"Karan"}
- GET  http://localhost:4000/api/auth/me               -> authenticated: true  (Postman keeps the cookie)
- GET  http://localhost:4000/api/workspaces            -> 200
- POST http://localhost:4000/api/auth/logout

---

## AQspace notes app

Paste a YouTube video or playlist and get study notes (PDF + HTML) written by the AI provider of your choice, with a notebook-style UI to browse playlists, watch the video and read the notes side by side.

### Architecture

```
 Browser (vanilla JS UI, served by the Node API)
        |
        v
 aq-api  - Node/Express app backend      http://127.0.0.1:5180   (playlists, progress, data store, serves the UI)
        |   HTTP, local only
        v
 lecture-notes-ai - Python AI worker     http://127.0.0.1:5055   (transcripts, LLM calls, notes -> PDF/HTML)
```

- **aq-api/** - Node/Express app backend (SQLite via built-in `node:sqlite`). Data lives in `aq-api/data/` (git-ignored).
- **lecture-notes-ai/** - Python (Flask) service plus the `notes_engine` package: fetches the transcript, calls Gemini / Groq / xAI / Hugging Face, renders the notebook PDF with Chrome/Edge/Chromium.
- **lecture-notes-ui/** - vanilla JS front end (no build step).
- **docs/** - architecture notes and the developer notebook.

Full details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/AQ-Learning-Dev-Notebook.pdf](docs/AQ-Learning-Dev-Notebook.pdf).

### Quick start (macOS)

Run it with Docker. See **Run everything with Docker (one command)** above: put your key in `lecture-notes-ai/backend/.env`, then run `docker compose up --build`.

### Folder map

| Path | What it is |
|---|---|
| `backend/`, `frontend/`, `docker-compose.yml` | Google OAuth app (see above) |
| `aq-api/` | Node/Express app backend, port 5180 |
| `lecture-notes-ai/` | Python AI/notes worker, port 5055 (`backend/` Flask app, `notes_engine/`, `tests/`) |
| `lecture-notes-ui/` | Vanilla JS UI |
| `docs/` | `ARCHITECTURE.md`, dev notebook, `PLAN.md`, `AGENT_JOURNAL.md` |
| `scripts/` | `nuke.sh` (remove all app data), `secret-scan.sh` (key scanner), `gh.sh` (repo-local GitHub CLI) |

### Development

- Python tests: `cd lecture-notes-ai && LNA_OFFLINE=1 .venv/bin/python -m pytest tests -q`
- Node tests: `cd aq-api && npm test`
- Before pushing: `scripts/secret-scan.sh` (fails if a real-looking key or a `.env` file is in the tree).

### Public link with a Cloudflare tunnel (optional)
```bash
docker compose --profile tunnel up --build
docker compose logs tunnel | grep trycloudflare.com   # your public https link
```
The tunnel points at the UI (aq-api :5180). aq-api accepts writes from `https://*.trycloudflare.com` pages (`TUNNEL_ORIGINS`). There is no login, so anyone with the link uses your Groq key. Stop it with `docker compose stop tunnel`.
