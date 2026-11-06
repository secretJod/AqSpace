# QA plan: card #47 - upstream import (smart playlist, dev tools, new providers, notes cache)

- **Card:** https://github.com/secretJod/AqSpace/issues/47 (this plan: card #50)
- **PR:** <link to the #47 PR>
- **Tester:** <your name>
- **Date:** YYYY-MM-DD
- **Tested on:** MacBook M2 16 GB + <browser>, <phone + browser>

## What this card is, in plain words
Another developer built new features on the same app (upstream `developer4-gif/aq`, branch `feature/dev-tools`, Nov 2-3). Card #47 copies that work into AQspace on top of our R5 local model. This plan checks every imported feature, checks that the developer pages stay private, and checks that R5 still works.

The imported features, one line each:
- **Smart playlist:** the playlist name is your learning goal; the AI suggests the best watch order and lists topics that are covered or still missing.
- **Smart arrange button:** a glowing button that plays a short 3-second animation and then reorders the videos in that order.
- **Topics to cover drawer:** a panel that slides in from the right with covered topics, missing topics and suggested videos.
- **Dev tools (`/dev`):** private pages for developers: a hub, a 3D picture of how a request flows through the app, a live tracker of requests and jobs, and a model evaluation page.
- **Persistent logs:** the tracker saves each day's history to files (kept 14 days) so you can search and download it later.
- **Colab and Nemotron providers:** two new AI choices for making notes (Qwen3-8B running on Google Colab, and NVIDIA Nemotron on the internet).
- **Notes cache:** if notes for a video already exist, asking again returns them at once instead of making them again.
- **"Notes could not be located" fix:** the notes view now opens notes correctly when the app is served from `localhost:5180`.

Note: the routes below come from upstream. If the #47 PR says a page moved, use the PR's address.

## Before you start
- [ ] Docker Desktop is running and `docker compose up --build -d` finished; http://localhost:5180 loads and you can sign in.
- [ ] `scripts/llm.sh start` is running (needed for the R5 regression section).
- [ ] `.env` has `GROQ_API_KEY`. For the smart playlist, `GEMINI_API_KEY` too (it uses Gemini by default). Never show keys on screen.
- [ ] Optional: an NVIDIA key (`nvapi-...`) for Nemotron, and a running Colab notebook (`lecture-notes-ai/colab/qwen3_8b_notes_colab.ipynb`) for Colab. Without them, mark those steps **Blocked**.
- [ ] A short video with captions (10-20 min): ______
- [ ] 4 to 6 videos on one subject (for example "Learn Python basics"): ______
- Run every command from the AQspace folder in Terminal.

## Steps

Mark exactly one box per step. If it fails, fill in "What I saw".

### A. Smart playlist

#### 1. Make a goal playlist
**Do:** Create a playlist named as a goal, e.g. "Learn Python basics", and add your 4-6 videos in a mixed-up order.
**Expect:** The playlist shows all the videos. A **Smart arrange** button is visible.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

#### 2. Smart arrange
**Do:** Press **Smart arrange** and wait.
**Expect:** A short charge-and-burst animation (about 3 seconds), progress while the AI works, then the videos move into a new order that makes sense (basics first). No error.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

#### 3. Topics to cover drawer
**Do:** Open the **Topics to cover** panel.
**Expect:** It slides in from the right. It lists topics already covered, topics missing, and suggested videos that are real YouTube links (open one to check). It closes cleanly.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

#### 4. Result is remembered
**Do:** Press **Smart arrange** again without changing the playlist. Then `docker compose restart` and reopen the playlist.
**Expect:** The second press answers almost at once (cached). After the restart, the order and the topics are still there.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

#### 5. Too few videos
**Do:** Make a playlist with only 1 video and press **Smart arrange**.
**Expect:** A clear, friendly message that at least 2 videos are needed (the limit is 2 to 20). Nothing crashes.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

#### 6. Missing key
**Do:** Remove `GEMINI_API_KEY` from `.env`, `docker compose up -d`, add one video to the goal playlist (so it really runs again) and press **Smart arrange**. Put the key back afterwards.
**Expect:** A readable error (no key, or the analysis failed). The page still works; pressing again after the key is back works.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

#### 7. Smart playlist on the phone
**Do:** Open the app on your phone (tunnel link or same Wi-Fi), open the goal playlist, press **Smart arrange**, open the drawer.
**Expect:** Button and drawer fit the screen, text is readable, the drawer can be closed.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### B. Notes cache and the "notes could not be located" fix

#### 8. Notes open from localhost:5180
**Do:** At http://localhost:5180, make notes for the short video, then open them.
**Expect:** The notes open. You never see "notes could not be located".
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

#### 9. Asking again is instant
**Do:** Press the make-notes button again for the same video (also try from a second browser or private window, signed in).
**Expect:** The same notes appear right away; no new progress bar. `docker compose logs notes-ai | tail -20` shows no new job.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### C. New providers

#### 10. Providers are listed
**Do:** Open the provider list in the app (or `curl -s http://localhost:5180/api/v1/...` as the PR says).
**Expect:** **NVIDIA Nemotron** and **Colab Qwen3-8B** appear, and so do the old ones, including our **local** one.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

#### 11. Nemotron makes notes
**Do:** Choose Nemotron, give the NVIDIA key, make notes for the short video.
**Expect:** Notes finish and match the video. With a wrong key you get a clear "invalid key" style error, and the key is not shown in the error.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

#### 12. Colab makes notes
**Do:** Start the Colab notebook, put its link and key in `COLAB_LLM_URL` / `COLAB_LLM_KEY`, restart, choose Colab, make notes.
**Expect:** Notes finish. If `COLAB_LLM_URL` is empty, the error says "COLAB_LLM_URL is not set..." instead of crashing.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### D. Dev tools (on the Mac only)

#### 13. Dev hub
**Do:** Open http://localhost:5180/dev/
**Expect:** A hub page with links to the 3D workflow, tracker and evaluation pages.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

#### 14. 3D workflow
**Do:** Open the workflow page (`/dev/flow.html`), drag to turn it, switch on live mode, then make notes in another tab.
**Expect:** A 3D picture of browser -> aq-api -> notes worker -> AI. In live mode the steps light up as your request passes. Mouse drag works.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

#### 15. Live tracker
**Do:** Open `/dev/tracker.html`. In another tab, click around the app and make notes.
**Expect:** New requests show up every few seconds with status and time; job changes (queued -> running -> ready) appear; services show as healthy. Filters narrow the list.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

#### 16. Logs survive a restart and can be downloaded
**Do:** `docker compose restart`, reopen the tracker, go to history for today, search, then export CSV.
**Expect:** Today's earlier requests are still listed. A CSV file downloads and opens in Numbers/Excel.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

#### 17. Logs hide secrets
**Do:** Open the service log view in the tracker and the CSV from step 16. Search for `gsk_`, `AIza`, `nvapi-`, `Bearer`.
**Expect:** No real key or token appears (they are masked). No cookies or query strings in the CSV.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

#### 18. Model evaluation page
**Do:** Open `/dev/eval.html`.
**Expect:** A page comparing models (speed, reliability, quality scores) with charts or tables. No blank page.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

#### 19. Dev tools can be turned off
**Do:** Set `AQ_DEV_TOOLS=0` in `.env`, `docker compose up -d`, open http://localhost:5180/dev/. Then remove the line and restart.
**Expect:** With `0`: "Not found". Without it: the hub is back.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### E. Security: dev tools must not be reachable through the tunnel
The dev pages show internal details, so only your own Mac may open them.

#### 20. Not reachable from the phone over the tunnel
**Do:** `docker compose --profile tunnel up -d`, get the link (`docker compose logs tunnel | grep trycloudflare.com`). On your phone using mobile data (Wi-Fi off), open `<tunnel>/dev/`, `<tunnel>/dev/tracker.html`, `<tunnel>/dev/api/overview`, `<tunnel>/dev/api/requests`, `<tunnel>/dev/api/logs/api`. Also on the Mac: `curl -s -i -m 10 https://<tunnel>/dev/api/overview | head -5`.
**Expect:** Every one is refused (403 or 404, "Not found" / "Forbidden"). None show request lists, jobs, logs or counts. The normal app at `<tunnel>/` still works.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

#### 21. Not reachable from the local network
**Do:** `ipconfig getifaddr en0`, then on your phone on the same Wi-Fi open `http://<that address>:5180/dev/`.
**Expect:** It does not load (connection refused/timeout) or says not found.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

#### 22. Dev tools are read-only
**Do:** On the Mac: `curl -s -i -X POST http://localhost:5180/dev/api/overview | head -3`
**Expect:** `405 Method not allowed`.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### F. Regression: R5 still works

#### 23. Local provider is listed
**Do:** Look at the provider list (same place as step 10).
**Expect:** The **local** Qwen3-8B provider is still there and is the default.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

#### 24. Notes for a short video with the local model
**Do:** Pick a short video you have NOT used today (so the cache does not answer), make notes, then `docker compose logs notes-ai | grep -i -E "provider|local|groq" | tail -20`.
**Expect:** Progress like "chunk 1/2", notes finish in a few minutes, logs say provider `local`.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

#### 25. Resume after a crash
**Do:** Start notes for another uncached video. When it shows "chunk 2/N" or later, run `docker compose restart notes-ai`, then press the make-notes button again.
**Expect:** It continues from the chunk it reached, not from chunk 1, and the notes finish.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

#### 26. Model and worker still hidden
**Do:** Repeat step 16 of `docs/qa/r5-local-model.md` (`<tunnel>:8081`, `<tunnel>/v1/models`, `<tunnel>:5055` from the phone on mobile data).
**Expect:** None of them show model or worker output.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

## Clean up
- [ ] Put back any `.env` lines you changed (`GEMINI_API_KEY`, `AQ_DEV_TOOLS`, `COLAB_LLM_*`).
- [ ] `docker compose --profile tunnel down` and `scripts/llm.sh stop`.

## Result
- Steps passed: __ / 26
- [ ] **PASS** -> `QA_APPROVED=1 scripts/board.sh move 47 Done`
- [ ] **FAIL** -> bug comment on the card (format in `docs/qa/TEMPLATE.md`), then `scripts/board.sh move 47 "In Progress"`

A failure in section E (security) is always a fail for the whole card, even if everything else passes.
