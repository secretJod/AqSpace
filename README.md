# AQspace

AQspace turns YouTube lectures into hand-drawn "field notebook" study notes, as a web page and a PDF. Paste a video or a playlist, watch it inside the app, and read the notes beside the video. Notes are written by Google Gemini by default, with automatic fallback to other providers when it is unavailable.

<!-- Screenshot: add one here when the UI is final, e.g. docs/images/app.png -->

## Quick start

You need Docker Desktop (or another Docker engine with Compose).

1. Add an AI key. Copy `apps/worker/backend/.env.example` to `apps/worker/backend/.env` and set `GEMINI_API_KEY`. That is enough for the default setup.
2. Start everything:
   ```bash
   docker compose up --build
   ```
   The first build is slow (it installs Chromium, ffmpeg and Whisper). Later starts are fast.
3. Open http://localhost:5180

Stop with `docker compose down`. Follow the logs with `docker compose logs -f notes-ai aq-api`.

Everything the app creates stays inside this folder. `scripts/nuke.sh` removes all of it, including the containers and images.

## Project layout

| Path | What it is |
|---|---|
| [`apps/api/`](apps/api/README.md) | Node 24 and Express: the HTTP API, sign-in and the SQLite database. Serves the web app on port 5180. |
| [`apps/worker/`](apps/worker/README.md) | Python 3.12 and Flask: transcripts, AI notes and PDF rendering. Internal port 5055, never exposed. |
| [`apps/web/`](apps/web/README.md) | The browser app: plain HTML, CSS and JavaScript with no build step. |
| `scripts/` | Developer and operations scripts: `nuke.sh`, `backup-db.sh`, `deploy.sh`, `secret-scan.sh`. |
| `docs/` | Documentation. |

Each app's README explains how it works and how to add a feature to it.

## Running the checks

From the repository root:

```bash
npm test               # API tests and worker tests
npm run lint           # ESLint (api, web) and Ruff (worker)
npm run format:check   # Prettier (api, web) and Ruff format (worker)
```

The worker checks use its virtual environment. Create it once:

```bash
python3.12 -m venv apps/worker/.venv
apps/worker/.venv/bin/pip install -e "apps/worker[web,dev]"
```

You can also run one app at a time, for example `npm --prefix apps/api test`. CI runs the same checks on every push.

## Configuration

Settings and keys live in `.env` files, which are never committed. Copy each `.env.example` and fill it in.

| File | What goes there |
|---|---|
| `apps/worker/backend/.env` | AI provider keys: `GEMINI_API_KEY` (default), and optionally `GROQ_API_KEY`, `NVIDIA_API_KEY` and a Colab endpoint. |
| `.env` (repository root) | Sign-in settings for the API: `AUTH_MODE`, the Google OAuth client and `SESSION_SECRET`. |

To change the notes provider, set `PY_NOTES_PROVIDER` (`gemini`, `local` or `groq`) in your shell before `docker compose up`. The `local` provider expects a llama.cpp `llama-server` running on the host at port 8081.

Back up your `.env` files before deleting the repository, and run `scripts/secret-scan.sh` before pushing.

## Public link (optional)

A Cloudflare quick tunnel gives the app a temporary public HTTPS address:

```bash
docker compose --profile tunnel up --build
docker compose logs tunnel | grep trycloudflare.com
```

Only port 5180 is exposed, and the address changes on every restart. Unless Google sign-in is on, anyone with the link can use the app and your AI keys. Stop it with `docker compose stop tunnel`.

## Google sign-in (optional)

By default the app runs as a single local user. To turn on Google sign-in:

1. In Google Cloud Console (APIs & Services > Credentials), create a Web OAuth client and add the redirect URI `http://localhost:5180/api/v1/auth/google/callback`.
2. Copy `.env.example` to `.env` and set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` and `SESSION_SECRET` (`openssl rand -hex 32`).
3. Set `AUTH_MODE=google` in the same file.
4. Run `docker compose up -d` to restart the API with the new settings.

A quick tunnel address changes on every restart, so sign-in through a tunnel needs a fixed hostname.

## Documentation

- [Architecture](docs/architecture.md): how the services fit together and how a request flows through them.
- [Adding a feature](docs/adding-a-feature.md): a walkthrough across the API, worker and web app.
- [Notes schema](apps/worker/docs/notes-schema.md): the JSON the AI writes and the renderer reads.
