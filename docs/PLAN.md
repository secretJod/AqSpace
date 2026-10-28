# AQspace — Application Plan

**Status:** R3 built (tunnel), R2 done: the whole app runs in Docker with one command (`docker compose up --build`).

## Overview
AQspace turns YouTube lectures (videos or playlists) into hand-drawn "field notebook" study notes (PDF + HTML) using an AI provider (Groq / Gemini / xAI / Hugging Face). A notebook-style UI lets you browse playlists, watch the video and read the notes side by side. It also includes the Google OAuth app.

Reference: https://github.com/developer4-gif/aq (read remotely, never cloned).

## Existing baseline
- OAuth implementation (commit `412ca75`).
- All app data and caches stay inside the repo: Postgres at `./.data/pgdata`, npm cache at `.npm-cache/`, and `scripts/nuke.sh` for cleanup (see `.claude/rules/storage.md`).

## Requirements
- **R1 (2026-10-24):** Rebuild everything from the reference repo inside this repo, as it is, under the name **AQspace**. Read the code from GitHub (no clone). Follow the storage rules (everything repo-local) and log the agents' work in `docs/AGENT_JOURNAL.md`. Then document the start commands for macOS.
- **R2 (2026-10-25):** Wrap the whole application in containers so a single command (`docker compose up --build`) starts everything. The Groq API key goes in `lecture-notes-ai/backend/.env`. Work split across 3 agents (A: notes-ai image, B: aq-api image, C: compose integration and verification).
- **R3 (2026-10-25):** Public access through a Cloudflare quick tunnel pointed at the UI port (5180); the app must accept requests coming through the tunnel. Opt-in compose profile `tunnel`.
- **R4 (2026-10-25):** Fixed agent team (3 web, 2 AI, 2 UI developers, scaling-lead, client-presenter, qa-guide) working like a company: GitHub Project kanban (Backlog→Todo→In Progress→In Review→QA→Done) as the source of truth, daily standup files, and a QA gate where the user (QA tester, guided by qa-guide) approves Done.
- **R5 (2026-10-28):** Turn transcripts into notes on a **Google Colab Pro GPU worker** running an open-source model (~25 GB class, L4/A100) that is powerful and fast, with no request or token rate limits. The worker *pulls* jobs from aq-api through the tunnel with a worker token, sends notes back, and saves a copy of every note to **Google Drive** so nothing is lost. Groq stays as the fallback when Colab is offline.

## Architecture
| Service | Path | Port | Tech |
|---|---|---|---|
| OAuth app backend | `backend/` | 4000 | Node/TS + Postgres (Docker) |
| OAuth app frontend | `frontend/` | 5173 | Vite/React (Docker) |
| Postgres | (docker) | - | data in `./.data/pgdata` |
| App API (serves UI) | `aq-api/` | 5180 | Node 24 / Express, SQLite in `aq-api/data/` |
| Notes/AI worker | `lecture-notes-ai/` | 5055 | Python Flask + `notes_engine`, venv in `lecture-notes-ai/.venv` |
| UI | `lecture-notes-ui/` | (served by aq-api) | vanilla JS |

Run with Docker only: `docker compose up --build`.

## Changelog
| Date | Change | Why | Requested by |
|------|--------|-----|--------------|
| 2026-10-23 | Plan and tracking system created (`docs/PLAN.md`, `docs/AGENT_JOURNAL.md`, `.claude/rules/tracking.md`) | To track every plan change and every agent's work | User |
| 2026-10-24 | Added R1, Overview and Architecture (rebuild AQspace from the reference repo) | User gave the project idea | User |
| 2026-10-24 | R1 done: all services copied, macOS start/stop scripts added, UI branded AQspace, nuke.sh/.gitignore extended | Verified end to end by Agent 5 | User |
| 2026-10-25 | Added R2: containerize the whole app, one-command start | User request | User |
| 2026-10-25 | R2 done: notes-ai and aq-api containers added to docker-compose (aq-api shares the notes-ai network namespace; only 127.0.0.1:5180 is published); aq-api config gets an optional HOST env | Verified end to end by Agent C | User |
| 2026-10-25 | R3: added cloudflared `tunnel` service (profile) and `TUNNEL_ORIGINS` allowlist in aq-api CORS guard | User wants traffic via Cloudflare tunnel on the UI port | User |
| 2026-10-25 | R4: fixed agent team, board workflow, daily standups, QA gate | User wants to run the project like a company | User |
| 2026-10-25 | Docker is the only way to run AQspace: removed start-all.sh/stop-all.sh and the Windows start.ps1/serve.ps1 | Remove duplicate and unused scripts | User |
| 2026-10-28 | Added R5: Colab Pro GPU worker (open-source model, no rate limits) for transcript→notes, Google Drive backup, Groq fallback | User wants own model on Colab Pro and notes saved to Drive | User |
