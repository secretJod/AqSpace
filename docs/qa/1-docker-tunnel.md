# QA plan: card #1 - Docker one-command start + Cloudflare tunnel

- **Card:** https://github.com/secretJod/AqSpace/issues/1
- **Tester:** ______  **Date:** ______
- **Tested on:** computer ______ / phone ______

What this feature is: one command (`docker compose up --build`) starts the whole AQspace notes app at http://localhost:5180. An optional "tunnel" gives you a public `https://....trycloudflare.com` link so you can use the app from your phone. The Python worker (port 5055) must stay hidden.

Run all commands in a terminal from the repo folder (`AQspace/`).

## Before you start
- [ ] Docker Desktop is open and says "running".
- [ ] `lecture-notes-ai/backend/.env` exists and has a line `GROQ_API_KEY=gsk_...` (get a key at https://console.groq.com/keys). Keep a copy of the real key somewhere; you will break it on purpose later.
- [ ] Root `.env` exists (the Google OAuth keys). Without it, Docker refuses to start.
- [ ] Have a YouTube **playlist** link ready with a few videos (that have captions), and one **single video** link.
- [ ] For the big test: a public playlist with **more than 100 videos** (search YouTube for "full course playlist").

Heads-up: the first build downloads Chromium and ffmpeg and can take a long time (up to an hour on slow internet). That is normal.

---

## Part A - Happy path on your computer

### 1. Start everything with one command
**Do:** `docker compose up --build`
**Expect:** The build finishes and logs keep scrolling without a red crash loop. In a second terminal, `docker compose ps` shows `notes-ai` as **healthy** and `aq-api` as running.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 2. The app opens
**Do:** Open http://localhost:5180 in your browser.
**Expect:** The AQspace notes app loads. The browser tab title says **AQspace**. No error page.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 3. Import a playlist
**Do:** Use the import option, paste your playlist link, confirm.
**Expect:** The playlist appears with its video titles and thumbnails.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 4. Generate notes for one video
**Do:** Pick one video in the playlist and ask for notes.
**Expect:** You see that it is working (progress), and after a while (can be a few minutes) the notes appear next to the video.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 5. Open the PDF
**Do:** Open the PDF version of those notes.
**Expect:** A notebook-style PDF opens and is readable (not blank, not cut off).
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 6. Data survives a restart
**Do:** Press Ctrl+C in the first terminal (or `docker compose down`), then `docker compose up` again (no `--build`). Reload http://localhost:5180.
**Expect:** Starts much faster than the first time. Your playlist and the notes from step 4 are still there.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 7. Worker is NOT reachable from your computer
**Do:** `curl http://localhost:5055`
**Expect:** It **fails** (something like "Failed to connect" / "Connection refused"). If it returns any page or JSON, that is a FAIL.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

---

## Part B - Tunnel and phone

### 8. Start the tunnel
**Do:** `docker compose --profile tunnel up -d`, wait ~20 seconds, then `docker compose logs tunnel | grep trycloudflare.com`
**Expect:** A line with a link like `https://some-random-words.trycloudflare.com`.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 9. Open the link on your phone (mobile data, not Wi-Fi)
**Do:** Turn off Wi-Fi on the phone so it is really from "outside", then open the link.
**Expect:** The AQspace app loads over https. Layout fits the phone screen: no sideways scrolling, buttons can be tapped, text readable.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 10. Import and generate from the phone
**Do:** Repeat steps 3-5 on the phone (import a playlist, generate notes for one video, open the PDF).
**Expect:** Works the same as on the computer. No "forbidden"/"not allowed" error when saving or generating.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 11. Phone in landscape and portrait
**Do:** Rotate the phone while viewing a video with notes.
**Expect:** The page re-arranges and is still usable both ways.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 12. Stop the tunnel
**Do:** `docker compose stop tunnel`, then reload the link on the phone.
**Expect:** The link stops working. http://localhost:5180 on your computer still works.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

---

## Part C - Things going wrong (edge cases)

For C1 and C2 you change the key file. After editing `.env`, restart so the app reads it: `docker compose up -d --force-recreate notes-ai aq-api`. **Put the real key back when done.**

### 13. No key
**Do:** In `lecture-notes-ai/backend/.env` change the line to `GROQ_API_KEY=` (empty). Restart (see above). Try to generate notes for a new video.
**Expect:** The app keeps running and shows a clear message, something like: *"No API key was provided. Paste your key in the app or set it in the environment (e.g. GROQ_API_KEY) or backend/.env."* It must not hang forever or show a blank screen.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 14. Wrong key
**Do:** Set `GROQ_API_KEY=gsk_wrong123`. Restart. Try to generate notes.
**Expect:** A clear message like *"Groq rejected the API key (HTTP 401). Check that the key is pasted correctly..."*. The fake key itself should not be shown in full on screen.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

**Now put the real key back and restart.**
- [ ] Real key restored and notes generate again.

### 15. No network
**Do:** With the app open in the browser, turn off your computer's Wi-Fi (or unplug the network). Try to import a new playlist and to generate notes.
**Expect:** A friendly error (e.g. *"Couldn't read that playlist from YouTube. Please try again in a moment."*), not a frozen page. Turn Wi-Fi back on, try again: it works without restarting Docker.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 16. Big playlist (100+ videos)
**Do:** Import your playlist with more than 100 videos.
**Expect:** It imports in reasonable time (under a minute or two) and the list scrolls smoothly. The app reads up to 200 videos; if the playlist is longer, it should only show part of it without crashing. Note how many videos appeared vs. how many YouTube says.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw: (videos shown: ___ / on YouTube: ___)

### 17. Bad links
**Do:** Try importing: (a) random text like `hello`, (b) a single video link instead of a playlist, (c) a private or deleted playlist link.
**Expect:** Each one gives a clear, human message saying what is wrong. No crash, no raw technical error text.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 18. Missing root `.env`
**Do:** Only if comfortable: `docker compose down`, temporarily rename the root `.env` to `.env.bak`, run `docker compose up`. **Then rename it back.**
**Expect:** Docker stops with an error that mentions the missing `.env` file (it does not start half-broken). After renaming back, everything starts again.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 19. Everything stays inside the repo
**Do:** `docker volume ls`
**Expect:** No volume starting with `aqspace_` for app data (data lives in `.data/`, `aq-api/data/`, `lecture-notes-ai/backend/output/`). Unnamed volumes for `node_modules` are OK.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

---

## Result
- Steps passed: __ / 19
- [ ] **PASS** -> comment a summary on issue #1, then `QA_APPROVED=1 scripts/board.sh move 1 Done`
- [ ] **FAIL** -> one bug comment per problem (format in `TEMPLATE.md`), then `scripts/board.sh move 1 "In Progress"`

Security reminder: the tunnel has no login. Anyone with the link can use your Groq key. Always stop the tunnel (step 12) when you are done testing.
