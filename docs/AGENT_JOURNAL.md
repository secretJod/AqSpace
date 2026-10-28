# Agent Journal

This is the shared talk space for every agent working on AQspace. Each agent tells its own story here: what feature it built, how things were before, what it did, and what it solved. The file is append-only, so newest entries go at the bottom. Rules are in `.claude/rules/tracking.md`.

---

## [2026-10-23] Claude (setup agent): Plan & journal tracking system
**Before:** The repo had OAuth and repo-local storage rules, but no written application plan, no record of plan changes, and no way to see what each agent had done.
**What I did:** I created `docs/PLAN.md` (the living plan, with a changelog), this journal, and `.claude/rules/tracking.md`, which tells every agent to log its work here and to change the plan only when the user asks.
**What it solved:** Every change to the plan and every agent's work can now be tracked in one place.
**Notes for the next agent:** The project idea isn't defined yet. Read PLAN.md first and add requirements only when the user gives them.

## [2026-10-23] Claude (setup agent): Project memory
**Before:** The tracking rules were in `.claude/rules/tracking.md`, but there was no project memory file telling each new session what to do first.
**What I did:** I created `.claude/CLAUDE.md`, the project memory. Claude Code loads it automatically in every session in this repo. It requires reading PLAN.md and the journal before work, and writing a journal entry after.
**What it solved:** Every future session and agent follows the tracking workflow from the start, without anyone having to remind it.
**Notes for the next agent:** Keep project context in `.claude/`, never in `~/.claude` (storage rule).

## [2026-10-24 12:00] Agent 4 (docs): Imported upstream docs/ folder
**Before:** Local docs/ had only our PLAN.md and AGENT_JOURNAL.md; none of the upstream architecture docs.
**What I did:** Fetched ARCHITECTURE.md (32,703 B), dev-notebook.json (84,058 B, notes-schema JSON: meta/cover/sections/glossary/recap) and AQ-Learning-Dev-Notebook.pdf (3,182,796 B, size verified) from developer4-gif/aq via raw.githubusercontent.com into docs/. Did not touch PLAN.md or other folders. Summarised the architecture for the team lead.
**What it solved:** The team now has the source-of-truth architecture locally: 3 services (UI served by aq-api :5180, Node/Express/SQLite aq-api :5180, Python Flask worker :5055 loopback-only).
**Notes for the next agent:** Upstream run docs are Windows-only (start.ps1, serve.ps1, D:\ paths, Edge). On macOS: use a bash equivalent, python3 -m venv inside the repo, set LNAI_BROWSER to Chrome's app-bundle binary, brew-free ffmpeg (or skip; only needed for caption-less videos). Upstream uses SQLite at aq-api/data/aq.db while our repo has Postgres in ./.data/pgdata and an OAuth commit: reconcile with the lead. Upstream auth is just a seam (local user id 1).

## [2026-10-24 12:00] Agent 1 (aq-api): Copied the aq-api Node backend from upstream
**Before:** The repo had no `aq-api/` folder.
**What I did:** I fetched all 25 files under `aq-api/` from developer4-gif/aq one at a time with curl, with no clone, and left them unchanged. I added `aq-api/.npmrc` (`cache=../.npm-cache`) so the npm cache stays in the repo-root `.npm-cache/`. Then I ran `npm install` (express 5 is the only dependency) and `npm test`: 32 tests, 32 passed, 0 failed.
**What it solved:** The Express API on 127.0.0.1:5180 is now in place. It stores users, playlists, progress and notes records.
**Notes for the next agent:** It uses the built-in `node:sqlite` (Node >= 24), so it has no native dependencies. The database is `aq-api/data/aq.db`, or `DB_FILE` if set. The `data/` folder is created at runtime and is gitignored, so `scripts/nuke.sh` should delete `aq-api/data` and `aq-api/node_modules`. It reaches the Python worker over HTTP at `PY_NOTES_URL`, default `http://127.0.0.1:5055`. Only loopback addresses are allowed unless `ALLOW_REMOTE_PY=1`. It serves the static UI from `../lecture-notes-ui`, or `UI_DIR` if set.

## [2026-10-24 12:00] Agent 3 (lecture-notes-ui): Copied the vanilla JS UI from developer4-gif/aq
**Before:** There was no `lecture-notes-ui/` folder in this repo.
**What I did:** I fetched all 40 files under `lecture-notes-ui/` one at a time with curl from raw.githubusercontent.com (14 JS/HTML/CSS/MD/PS1 files and 26 screenshots). Every local size matches the tree API. I changed nothing.
**What it solved:** The UI is in place for aq-api to serve on :5180 (same origin as the API).
**Notes for the next agent:**
- The UI calls these endpoints on aq-api: `/api/v1/health, /me, /playlists[?include=videos], /playlists/:id..., /progress, /progress/:id (PUT, keepalive), /sync/import, /notes, /notes/:id, /import/youtube?url=`. Without aq-api it falls back to the legacy notes server at 127.0.0.1:5055 (`/api/jobs`, `/api/playlist?url=`).
- If the page isn't same-origin, `api.js` and `importpl.js` fall back to the hardcoded `http://127.0.0.1:5180` / `:5055`.
- External dependencies: Google Fonts (Inter, Playfair Display), the YouTube iframe_api, youtube-nocookie embeds, oEmbed and i.ytimg thumbnails. There is no JS CDN.
- `serve.ps1` only works on Windows and hardcodes `D:\AQspace\lecture-notes-ai\.venv`. The README also uses `D:\AQspace\...` paths. The mac equivalent is `python3 -m http.server 5173 --bind 127.0.0.1`.
- The "AQ Learning" branding appears in index.html (the title and the logo text/aria-label on lines 6, 21 and 23), in app.js document.title (lines 240, 423 and 445), in the README heading and in every JS header comment. The favicon is an inline SVG with "AQ". I did not rename anything.

## [2026-10-24 23:55] Agent 2 (lecture-notes-ai): copied the Flask notes worker and got its tests passing on macOS
**Before:** There was no `lecture-notes-ai/` folder in this repo.
**What I did:** I downloaded all 44 files under `lecture-notes-ai/` one by one from developer4-gif/aq using curl on raw URLs. Every file's size matches the size in the GitHub tree API, including the fonts and PNGs. I created the venv at `lecture-notes-ai/.venv` and ran `pip install -e ".[web,dev]"` with the pip cache set to `./.pip-cache`. I changed one thing: `notes_engine/pdf.py` `_find_browser()` only looked in Windows Edge/Chrome paths and on PATH. I added the macOS app-bundle paths for Chrome, Edge and Chromium. Windows behavior is the same as before.
**What it solved:** Offline tests: 327 passed, 1 skipped (an online-only ingest test). Before the browser fix it was 320 passed and 8 skipped, because the PDF tests could not find a browser.
**Notes for the next agent:** Start the service with `cd lecture-notes-ai/backend && ../.venv/bin/python run.py`. It runs on 127.0.0.1:$LNA_PORT (default 5055). It reads `lecture-notes-ai/backend/.env` (copy it from .env.example). Optional env vars: GEMINI_API_KEY, GROQ_API_KEY, XAI_API_KEY, HF_TOKEN, FFMPEG_PATH (otherwise ffmpeg must be on PATH), LNAI_BROWSER. The service writes job output to `lecture-notes-ai/backend/output/` and cleans it up after 24h. The folder's own .gitignore already ignores that path. The service also uses temp dirs in the system tmp, which it removes itself. Please gitignore `.pip-cache/` and `lecture-notes-ai/.venv` and `lecture-notes-ai/backend/output`, and have nuke.sh clean them. start.ps1 is Windows-only and I left it unchanged.

## [2026-10-24 23:57] Agent 5 (integration & macOS scripts): One-command start/stop on macOS, AQspace branding, repo-local cleanup
**Before:** The only launchers were the Windows start-all.ps1, stop-all.ps1 and secret-scan.ps1. The .gitignore and nuke.sh didn't cover the venv, pip cache, aq-api/data, .run or the notes output. The UI still said "AQ Learning", and the README covered only OAuth.
**What I did:** I wrote `start-all.sh` and `stop-all.sh` at the repo root and `scripts/secret-scan.sh`, ported from the .ps1 versions (I kept the .ps1 files and skipped sync.ps1). start-all.sh loads backend/.env and prints only the key names. It creates the venv if it's missing and reinstalls when pyproject's sha256 changes, with PIP_CACHE_DIR=.pip-cache and TMPDIR=.run/tmp. It runs npm install if node_modules is missing, starts Python on :5055 and Node on :5180 as separate process groups, writes logs and `.run/pids`, waits for HTTP, detects busy ports, opens the browser (NO_OPEN=1 skips this) and kills both services from a trap. stop-all.sh signals the launcher first and then kills the process groups. I merged upstream's .gitignore entries and our new paths, and extended nuke.sh (not run). I renamed the user-visible "AQ Learning" to "AQspace" in index.html (lines 6, 21, 23) and app.js (lines 240, 423, 445). I rewrote README.md with the OAuth section plus the notes app section, using macOS commands. I created lecture-notes-ai/backend/.env from the example with empty keys. The root .env.example already matched upstream.
**What it solved:** `./start-all.sh` brings up the whole notes app. Verified: /api/providers, /, /api/v1/health and /api/v1/playlists all returned 200, and the HTML title says AQspace. After stop-all.sh both ports were free. aq-api npm test: 32/32 passed.
**Notes for the next agent:** scripts/secret-scan.sh fails locally on purpose, because the repo-root .env and lecture-notes-ai/backend/.env exist. Upstream behaves the same way. The OAuth app is still run with `docker compose up --build`. backend/ and frontend/ node_modules are removed by nuke.sh only if they exist on the host.

## [2026-10-25 00:13] Agent B (aq-api container): Dockerfile, root .dockerignore, HOST env
**Before:** aq-api had no Dockerfile, and config.js hardcoded host 127.0.0.1, so Docker port publishing could not reach it.
**What I did:** I changed config.js to `host: env.HOST || "127.0.0.1"` and updated the comment (only set HOST=0.0.0.0 inside the container; compose publishes on 127.0.0.1 only). The Host-header guard is unchanged. I wrote `aq-api/Dockerfile` (node:24-alpine, build context = repo root, npm ci --omit=dev, app at /app/aq-api, UI at /app/lecture-notes-ui so the default UI_DIR resolves, ENV HOST=0.0.0.0 PORT=5180, runs as user node). I added a root `.dockerignore` that excludes node_modules, .venv, .data, .run, caches, .git, **/.env, aq-api/data, aq-api/.npmrc, notes output, UI screenshots and docs/*.pdf. npm test: 32/32 passed.
**What it solved:** aq-api can be built for compose with `context: .` and `dockerfile: aq-api/Dockerfile`.
**Notes for the next agent:** Inside the container the DB is /app/aq-api/data/aq.db. Bind-mount ./aq-api/data:/app/aq-api/data. The container runs as node (uid 1000). On macOS Docker Desktop that's fine, but on Linux the host dir must be writable by that uid. I could NOT run the docker build/run check because the Docker daemon wasn't running (socket connect failed), so the image build still needs to be checked once Docker Desktop is up.

## [2026-10-25 01:35] Agent A (notes-ai container): Dockerfile and .dockerignore for lecture-notes-ai
**Before:** The Flask notes worker only ran from a host venv. It had no container image.
**What I did:** I wrote `lecture-notes-ai/Dockerfile`: python:3.12-slim, with Debian chromium, ffmpeg and fonts-liberation, and `pip install ".[web]"` (non-editable) from /app. I added a wrapper `/usr/local/bin/chromium-nosandbox` that runs `chromium --no-sandbox --disable-dev-shm-usage`, and set `LNAI_BROWSER` to it. The ENV sets PYTHONUTF8, PYTHONDONTWRITEBYTECODE, PIP_NO_CACHE_DIR and LNA_PORT=5055. WORKDIR is /app/backend and CMD is `python run.py`. I wrote `lecture-notes-ai/.dockerignore`, which excludes .venv, __pycache__, egg-info, .pytest_cache, backend/output and every .env. I did not change any Python code or run.py.
**What it solved:** The test image built at 1.91GB. Inside the container, GET 127.0.0.1:5055/api/providers returned 200, and tests/test_pdf.py ran with real headless Chromium: 29 passed, 0 skipped. I removed the test container and image afterwards.
**Notes for the next agent:** In compose, set `env_file: lecture-notes-ai/backend/.env` (keys are not in the image). Bind-mount `./lecture-notes-ai/backend/output:/app/backend/output` if you want the notes output kept on the host. aq-api needs `network_mode: service:notes-ai`, and its port 5180 must be published on the notes-ai service. The first build took about 55 minutes on this network because apt is slow (about 100KB/s). I added Acquire::Retries=5 after a timeout on the first attempt.

## [2026-10-25 01:37] Agent C (compose integration): notes-ai + aq-api in docker-compose, one-command start verified
**Before:** docker-compose.yml only ran the OAuth app (db/backend/frontend). The notes app needed ./start-all.sh, and Agent B's aq-api image had never been built.
**What I did:** I added two services to docker-compose.yml and left db/backend/frontend and `name: aqspace` unchanged. `notes-ai` builds ./lecture-notes-ai, reads env_file lecture-notes-ai/backend/.env, bind-mounts ./lecture-notes-ai/backend/output to /app/backend/output, publishes 127.0.0.1:5180:5180 and has a Python urllib healthcheck on :5055/api/providers. `aq-api` (context ., aq-api/Dockerfile) uses network_mode service:notes-ai, sets PY_NOTES_URL=http://127.0.0.1:5055 and PY_NOTES_PROVIDER=groq, bind-mounts ./aq-api/data and waits for notes-ai to be healthy. I created the two host dirs. Both were already gitignored and cleaned by nuke.sh, so nothing new was needed. I added a "Run everything with Docker (one command)" section to README.md. I waited for Agent A's build, killed my first compose build when the lead reverted the apt line, and reran it with the apt layer CACHED.
**What it solved:** `docker compose up --build` starts all 5 services. I verified: :5180/api/v1/health returned ok with db ok; the title is AQspace; :4000/api/health and :5173 returned 200; a playlist import through aq-api reached Python and returned 12 videos; :5055 refused connections from the host; aq-api/data/aq.db exists on the host. I stopped everything with `docker compose down` and kept the images.
**Notes for the next agent:** /api/v1/import/youtube needs a playlist URL (list=...); a single-video URL returns 400. The notes-ai image is 1.9GB (chromium). Any change to the apt RUN line costs a slow ~250MB re-download. The aqspace-notes-ai-test image no longer exists.

## [2026-10-25 01:52] Claude (team lead): Cloudflare tunnel to the UI
**Before:** aq-api only accepted localhost. Through a tunnel, every page got 403 "Forbidden host", and every write got 403 "Forbidden origin".
**What I did:** I added an opt-in `tunnel` service to docker-compose.yml. It runs cloudflared 2026.10.3 in the notes-ai network namespace, points at 127.0.0.1:5180 and rewrites the Host header to localhost:5180, so the host guard stays untouched. In aq-api/src/middleware/security.js I added `originMatcher` and a `TUNNEL_ORIGINS` env (compose sets https://*.trycloudflare.com), so pages loaded through the tunnel can write. I added a test, and aq-api now passes 33/33.
**What it solved:** `docker compose --profile tunnel up` gives a public https link to the full working app.
**Notes for the next agent:** There is no auth: everyone shares user 1 and the owner's Groq key. All tunnel traffic comes from 127.0.0.1, so it shares one rate-limit bucket. Not yet verified live through a real tunnel (the user preferred to run it themselves).

## [2026-10-25 17:44] Claude (team lead): Fixed company team, board and daily track
**Before:** I spawned agents ad hoc for each task, with no fixed roles, no task board and no daily record.
**What I did:** I defined 10 permanent agents in `.claude/agents/` (web-dev-1..3, ai-dev-1..2, ui-dev-1..2, scaling-lead, client-presenter, qa-guide), each with an owned area and the same workflow. I wrote `.claude/rules/team.md` (team table, board columns, labels, branch naming, QA gate, daily rules), `docs/daily/` with a template and today's file, `docs/BOARD.md` (a local board mirror with starter cards), `docs/GITHUB_SETUP.md` (user steps), and `scripts/gh.sh` (repo-local gh: binary in .tools/, login in .gh-config/, both gitignored and cleaned by nuke.sh).
**What it solved:** The project now runs like a company: fixed owners, every task a card, a daily standup, and nothing reaching Done without the user's QA approval.
**Notes for the next agent:** The GitHub board isn't connected yet. Use docs/BOARD.md until the user gives the project number.

## [2026-10-25 23:00] Claude (team lead): Removed unused start scripts
**Before:** There were two ways to start the app (start-all.sh/stop-all.sh and Docker), plus Windows-only start.ps1 and serve.ps1 that were useless on macOS. Error messages in the UI and API told users to "start it (start.ps1)".
**What I did:** I deleted start-all.sh, stop-all.sh, lecture-notes-ai/start.ps1 and lecture-notes-ui/serve.ps1. I changed the user-facing messages in aq-api/src/pyclient.js, lecture-notes-ui/notes.js, importpl.js and lecture-notes-ai/backend/app/server.py to say "docker compose up", and cleaned README and web-dev-2's agent file. I kept nuke.sh, gh.sh and secret-scan.sh. Tests: aq-api 33/33, Python 327 passed and 1 skipped.
**What it solved:** One way to run the app, Docker, so there is less to maintain and nothing points to dead scripts.
**Notes for the next agent:** aq-api/test fixtures still create a fake "serve.ps1" on purpose, to check that the static server hides scripts. Leave that alone.

## [2026-10-25 23:41] client-presenter (#11): client-presenter (#11) PR #18
- Done: docs/client/release-notes-v0.1.md + demo-script.md (5-min demo, backup plan, honest limits)
- Next: update the notes when OAuth/CI/fallback merge; tune the 45s backup cutoff after a real run
- Blockers: none

## [2026-10-25 23:41] web-dev-1 (#4): web-dev-1 (#4) PR #19
- Done: per-visitor rate limiting behind the tunnel (TRUST_CF_HEADERS; CF-Connecting-IP trusted only from loopback with a valid IP); aq-api 36/36
- Next: none on this card
- Blockers: none. Note: relies on cloudflared being the only loopback client in the shared namespace

## [2026-10-25 23:41] ui-dev-2 (#10): ui-dev-2 (#10) PR #20
- Done: renamed AQ Learning to AQspace in 3 docs; global reduced-motion rule and high-contrast focus ring in styles.css; all 14 text/background pairs pass WCAG AA (lowest 5.13)
- Next: #21 (Backlog, ui-dev-1): JS effects should respect prefers-reduced-motion
- Blockers: no browser available for screenshots

## [2026-10-25 23:41] qa-guide (#3): qa-guide (#3) PR #22
- Done: docs/qa/README.md (how to QA with the board), TEMPLATE.md, 1-docker-tunnel.md (19 steps, including failure cases)
- Next: a plan per new QA card
- Blockers: none

## [2026-10-25 23:41] ui-dev-1 (#7): ui-dev-1 (#7) PR #23
- Done: removed every direct call to :5055 from notes.js and importpl.js; one clear "server not running" message instead; aq-api 33/33
- Next: rework of localStorage-first is a separate card
- Blockers: none

## [2026-10-25 23:41] ai-dev-2 (#9): ai-dev-2 (#9) PR #25
- Done: added /watch/<id>; clear messages for channel, playlist and other non-video links; 25 new offline tests (Python 352 passed); validation as strict as before
- Next: none on this card
- Blockers: none

## [2026-10-25 23:41] ai-dev-1 (#8): ai-dev-1 (#8) PR #26
- Done: opt-in fallback provider (LNA_PROVIDER_FALLBACK=1) on 429/5xx/timeout, using server keys only; records meta.provider and fallback_from; 7 new tests (Python 334 passed)
- Next: possible UI follow-up to show meta.provider; SERVER_KEY_ENV in llm.py duplicates ENV_KEYS in server.py
- Blockers: none

## [2026-10-25 23:41] web-dev-3 (#5): web-dev-3 (#5) PR #27
- Done: Google sign-in in aq-api behind AUTH_MODE=google (signed HttpOnly cookies, no new dependencies), local mode unchanged; aq-api 40/40
- Next: #24 (Backlog, ui-dev-1) Sign in button + 401 handling; optional sessions table so logout works on the server
- Blockers: none. Team-lead note: PR #19 and #27 both edit aq-api app.js/config.js, so expect a small merge conflict. The tunnel already rewrites Host to localhost, so hostGuard should not block it; verify the OAuth redirect URI through the tunnel in QA.

## [2026-10-25 23:41] scaling-lead (#6): scaling-lead (#6) PR #28
- Done: ADR-0001 (retire backend/frontend/Postgres; Google login lives in aq-api), ADR-0002 (stay on SQLite; measurable trigger for moving to Postgres), decisions index
- Next: Backlog #13 (remove old app, needs the user's approval), #14 (sessions in SQLite), #15 (SQL in the repo layer), #16 (backups + lock-wait logging)
- Blockers: none

## [2026-10-25 23:41] web-dev-2 (#2): web-dev-2 (#2) PR #17
- Done: GitHub Actions CI (Node 24 aq-api tests + Python 3.12 pytest); fixed Chrome sandbox on Ubuntu 24.04 runners with a sysctl step; all checks green
- Next: limit push trigger to main (CI currently runs twice per PR); npm cache path mismatch
- Blockers: none

## [2026-10-25 23:41] Claude (team lead): First company night
**Before:** The board was empty and the agents were idle.
**What I did:** I pushed the baseline to main, connected GitHub Project #2 (columns, labels, scripts/board.sh), created cards #1–#12 and ran all 10 agents in parallel worktrees. Each opened a PR and moved its card to QA. I recorded their reports here and in the daily file.
**What it solved:** 10 PRs (#17–#20, #22, #23, #25–#28) are waiting for QA, and 8 follow-up cards are in Backlog.
**Notes for the next agent:** #19 and #27 both touch aq-api app.js/config.js, so merge one and rebase the other. Full PR stories are in each PR body.

## [2026-10-27] Team lead (orchestrator): Cleanup of agent copies and outdated docs
**Before:** 10 temporary agent worktrees (104 MB) sat in `.claude/worktrees/`, and `docs/BOARD.md` and `docs/GITHUB_SETUP.md` were outdated now that the GitHub board is live.
**What I did:** First I checked that every worktree branch was pushed (0 unpushed commits; the only untracked content was node_modules). Then I removed all 10 worktrees, deleted the two outdated docs, and pointed the agent definitions and `.gitignore` at the GitHub board only.
**What it solved:** The 104 MB is freed, and there's one source for task status (GitHub Project #2) with no stale pointers.
**Notes for the next agent:** Local branches still exist (tiny). Their PRs #17–#28 are on GitHub. Remove the worktrees after each work session.

## [2026-10-28] Team lead (orchestrator): R5 planned, Colab Pro GPU worker
**Before:** Notes were generated only by Groq (a cloud API). The user wants their own model running on Colab Pro, with notes backed up to Google Drive.
**What I did:** I added R5 to `docs/PLAN.md` with a changelog row. I designed a pull-based worker: Colab asks aq-api for jobs through the tunnel using a worker token, saves the notes to Drive and posts them back, and Groq is the fallback. I created cards #29–#35 in Todo for scaling-lead, web-dev-1, ai-dev-1, web-dev-3, ai-dev-2, qa-guide and client-presenter.
**What it solved:** The work has a design that survives Colab disconnects, and every piece has an owner.
**Notes for the next agent:** #29 (the ADR) goes first; #30 and #31 depend on it. Keep the notes prompt and schema identical to Groq's. The worker token goes only in the gitignored `.env`. Nothing has been built yet.
