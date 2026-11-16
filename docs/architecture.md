# Architecture

AQspace turns YouTube lectures into study notes. A user collects lectures into playlists, watches them inside the
app, tracks progress on a dashboard, and asks for notes on any video. The notes come back as a hand-drawn "field
notebook": an HTML page shown beside the video and an A4 PDF.

The system is three apps in one repository:

| App | Stack | Responsibility |
|---|---|---|
| [`apps/web`](../apps/web/README.md) | Plain HTML, CSS and JavaScript, no build step | Everything the user sees. Keeps an offline copy of playlists and progress in `localStorage` and talks only to the API. |
| [`apps/api`](../apps/api/README.md) | Node 24, Express 5, built-in `node:sqlite` | The front door. Serves the web app and `/api/v1`, signs users in, owns all application data in SQLite, and starts and follows jobs in the worker. |
| [`apps/worker`](../apps/worker/README.md) | Python 3.12, Flask | The heavy work: transcripts, language-model calls, notes validation, HTML and PDF rendering, playlist analysis. Internal only. |

## The running system

```
  browser (apps/web)
     |
     |  https, optional: Cloudflare quick tunnel (docker compose --profile tunnel)
     v
  api  127.0.0.1:5180  ----------------------------->  SQLite  apps/api/data/aq.db
     |   serves apps/web on /  and JSON on /api/v1
     |
     |  http, loopback only (shared network namespace in Docker)
     v
  worker  127.0.0.1:5055  (never published)
     |-- YouTube: captions, yt-dlp subtitles and playlist listings, oEmbed metadata
     |-- speech-to-text when there are no captions: local faster-whisper, or Groq Whisper
     |-- language model: Gemini (default), Groq, NVIDIA, or a local llama-server on the host :8081
     |-- PDF: headless Chromium prints the rendered HTML page
     '-- files on disk: apps/worker/backend/output/ (job files, cache, checkpoints)
```

In Docker (`docker-compose.yml`) the worker runs as `notes-ai` and the API as `aq-api`. The API joins the worker's
network namespace, so both talk over `127.0.0.1` and only port 5180 is published, and only on the host's loopback.
The optional `tunnel` service joins the same namespace and forwards a temporary `trycloudflare.com` address to port
5180.

## Main flows

**Opening the app.** The API serves `apps/web/index.html` and its assets from the same origin. `js/core/api.js`
probes the API, loads the user's playlists and watch progress into `AQ.store`, and on the very first connection
uploads whatever the browser already had in `localStorage` (`POST /api/v1/sync/import`). From then on every change
in the store is written through to the API in order. If the API is unreachable the app keeps working from
`localStorage` and pushes the whole local state on the next successful connection.

**Importing a playlist.** The user pastes a YouTube playlist link. The web app calls
`GET /api/v1/import/youtube?url=...`; the API validates the `list=` id and forwards only that id to the worker's
`GET /api/playlist`, which lists the videos with yt-dlp (metadata only). The browser checks every field of the answer
and saves the result as a normal playlist. Nothing syncs back from YouTube later.

**Making notes.** This is an asynchronous job.

1. The web app calls `POST /api/v1/notes/:videoId`. The API keeps one live job per video for all users, in the
   `notes_jobs` table. Finished notes are returned at once (200); a running job returns its progress (200);
   otherwise the API starts a worker job with `POST /api/jobs` and answers 202.
2. The worker runs the job in a background thread (two at a time): transcript (0-25 %), notes from the language
   model (25-85 %), then HTML and PDF (85-100 %). Short lectures take one model call; long ones are split into
   slices and composed (map-reduce). Every model answer is repaired and validated into Notes JSON
   ([schema](../apps/worker/docs/notes-schema.md)).
3. The browser polls `GET /api/v1/notes/:videoId` every 1.5 seconds; the API in turn asks the worker for the job's
   state. The web app remembers running jobs in `localStorage`, so polling resumes after a reload.
4. **Checkpoints and resume.** Each finished slice is saved under `output/checkpoints/<video_id>/`, keyed by a hash
   of the transcript, provider, model and prompt version. Worker job ids do not survive a worker restart: when the
   API gets a 404 for a queued or running job, it submits the same video again and the worker skips the slices it
   already has. After `NOTES_MAX_AUTO_RESUMES` (default 3) attempts the job is marked as an error.
5. With provider fallback on (`LNA_PROVIDER_FALLBACK=1`, set in Docker), a rate limit, server error or unreachable
   local model retries the whole video once with another provider.

**Opening notes.** The notes panel frames `GET /api/v1/notes/:videoId/html` and offers
`GET /api/v1/notes/:videoId/pdf`. The API streams both files from the worker. Job files are deleted by the worker
after 24 hours; the API then marks the record expired and the user can generate the notes again.

**Smart arrange.** For a playlist of 2 to 20 videos, `POST /api/v1/playlists/:id/smart` starts a run in which a
language model suggests the best order, finds missing topics and proposes videos for them. It is also an
asynchronous job (`POST /api/smart` and `GET /api/smart/<id>` on the worker). The API stores the result in
`smart_runs`, keyed by a fingerprint of the goal and the video ids, so the same request is answered from the
database. The contract is in [smart-playlist-contract.md](../apps/worker/docs/smart-playlist-contract.md).

**Sign-in.** With `AUTH_MODE=local` (the default) every request is one built-in user. With `AUTH_MODE=google` the
API runs the OAuth authorization-code flow (`/api/v1/auth/google/login` and `/callback`), checks the id token, and
creates a server-side session. Any `/api/v1` call without a valid session answers 401 `auth_required`, and the web
app shows its sign-in screen. The first Google user takes over the data the local user created.

## Data and where it lives

Everything stays inside the repository and is git-ignored. `scripts/nuke.sh` removes all of it.

| Path | What is there |
|---|---|
| `apps/api/data/aq.db` | The SQLite database (WAL mode): users, sessions, playlists, videos, watch progress, notes job records, smart runs. Migrations are in `apps/api/sql/`. |
| `apps/api/data/devlogs/` | History of the local developer tracker (`/dev`), pruned after 14 days. |
| `apps/worker/backend/output/` | One folder per notes job (`notes.json`, `notes.html`, `notes.pdf`, kept 24 hours), plus `cache/` (transcripts and accepted model answers), `checkpoints/` (kept 7 days) and `_cache/` (speech-to-text work). |
| `.data/` | Other runtime data, such as database backups from `scripts/backup-db.sh` (`.data/backups`). |
| `.tools/whisper-models/` | The downloaded Whisper model. |

The browser's `localStorage` is a cache. The API is the source of truth whenever it is reachable.

## Security model

- Both services bind to `127.0.0.1` and reject requests whose `Host` is not local (DNS-rebinding guard). The worker
  is never published; the API is its only caller and calls it only on fixed paths with validated ids.
- The API allows cross-origin requests only from loopback pages and `TUNNEL_ORIGINS`, and refuses writes from any
  other origin. Together with JSON-only bodies and `SameSite=Lax` cookies this is the CSRF defence.
- Every `/api/v1` route after `authenticate` is scoped to the signed-in user. Google sessions are random tokens of
  which only the SHA-256 is stored, so logout really revokes them.
- Both services set a strict CSP and security headers. The web app never puts data into `innerHTML`, and the notes
  page allows only the hashes of the scripts the renderer wrote.
- Per-client rate limits (a stricter one for starting jobs and imports), body size limits, and error replies without
  stack traces.
- Provider keys live only in `apps/worker/backend/.env`, are scrubbed from every error and log line, and never appear
  in a response. The `/dev` tracker answers only on the local machine, never through the tunnel.
- With a tunnel and `AUTH_MODE=local`, anyone with the link can use the app and its AI keys. Turn on Google sign-in
  before sharing it.

## Configuration

Settings come from environment variables; secrets only from `.env` files, which are never committed.

| Where | What |
|---|---|
| `apps/worker/backend/.env` | Provider keys (`GEMINI_API_KEY`, `GROQ_API_KEY`, `NVIDIA_API_KEY`, ...) and worker settings. Template: `apps/worker/backend/.env.example`. |
| `.env` at the repository root | Sign-in for the API: `AUTH_MODE`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `SESSION_SECRET`. |
| Shell, before `docker compose up` | `PY_NOTES_PROVIDER` and `PY_SMART_PROVIDER` (`gemini` by default in Docker), `AQ_DEV_TOOLS`. |
| `docker-compose.yml` | Fixed wiring: the worker URL, tunnel origins, fallback, cache and scratch folders, bind mounts. |

The full lists, with defaults, are in the API README ("Environment variables") and the worker README
("Environment variables" and "Providers and fallback").

## Where to read next

- [Adding a feature](adding-a-feature.md): how a change travels through the three apps.
- [`apps/api/README.md`](../apps/api/README.md): routes, request pipeline, database and security in detail.
- [`apps/worker/README.md`](../apps/worker/README.md) and
  [`apps/worker/docs/architecture.md`](../apps/worker/docs/architecture.md): the notes pipeline module by module.
- [`apps/web/README.md`](../apps/web/README.md): script load order, the store, and how screens are built.
