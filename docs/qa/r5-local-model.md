# QA plan: card #34 - R5 local Qwen3-8B model (notes made on your Mac)

- **Card:** https://github.com/secretJod/AqSpace/issues/34 (model server: card #37)
- **PR:** <link>
- **Tester:** <your name>
- **Date:** YYYY-MM-DD
- **Tested on:** MacBook M2 16 GB + <browser>, <phone + browser>

## What this feature is, in plain words
AQspace now writes lecture notes with its own AI model, **Qwen3-8B**, running on your Mac instead of on the internet. The model runs as a small server (`scripts/llm.sh start`) at the address `127.0.0.1:8081`, which only your Mac can reach. Long videos (up to 24 hours) are cut into pieces ("chunks"), each piece is summarised, then the summaries are joined. Every finished piece is saved, so if something crashes the job carries on from where it stopped. If the model is off, **short** videos use Groq (the old internet service) instead; **long** videos wait for the model.

Words you will see:
- **chunk i/N**: piece i of N pieces is being worked on.
- **fallback**: the app used Groq because the local model was off.
- **Whisper**: the tool that listens to the audio and writes the text when a video has no captions.

## Before you start
- [ ] Docker Desktop is running.
- [ ] Close other heavy apps (games, video editing, other AI tools). The Mac has 16 GB and the model needs about 6 GB.
- [ ] The model file exists: `ls -lh models/Qwen3-8B-Q4_K_M.gguf` shows about 5 GB.
- [ ] `.env` has `GROQ_API_KEY` set (needed for the fallback steps). Never show it on screen.
- [ ] Pick 4 videos and write their links here (see `docs/qa/r5-eval.md` for how to choose):
  - Short (10-20 min, has captions): ______
  - About 1 hour (has captions): ______
  - Very long (10 hours or more): ______
  - No captions at all: ______
- Run every command from the AQspace folder in Terminal.

## Steps

Mark exactly one box per step. If it fails, fill in "What I saw".

### 1. Start the model
**Do:** `scripts/llm.sh start`, then `scripts/llm.sh status`.
**Expect:** It says the model is running on 127.0.0.1:8081. The first start can take up to a minute while the model loads.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 2. The model answers on your Mac
**Do:** `curl -s http://127.0.0.1:8081/v1/models`
**Expect:** A short block of text that mentions `qwen3-8b` (or the .gguf file name). No "connection refused".
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 3. Start the app
**Do:** `docker compose up --build -d`, wait about a minute, open http://localhost:5180 and sign in.
**Expect:** The AQspace home page loads. `docker compose ps` shows the containers as running/healthy.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 4. Notes for the short video
**Do:** Import the short video and press the button to make notes. Note the start time.
**Expect:** Progress appears (for example "chunk 1/2"). Notes finish in a few minutes. The notes match what the video talks about and have headings and bullet points. Write down how many minutes it took: ____
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 5. The notes really came from the local model
**Do:** `docker compose logs notes-ai | grep -i -E "provider|local|groq" | tail -20`
**Expect:** Lines say provider `local` (model `qwen3-8b`). Nothing says Groq for this job.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 6. Notes for the 1-hour video, watch progress
**Do:** Make notes for the 1-hour video. Look at the progress every few minutes.
**Expect:** Progress shows "chunk i/N" and i goes up steadily (it never jumps backwards or freezes for more than ~10 minutes). Notes finish and cover the start, middle and end of the lecture. Minutes taken: ____
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 7. Notes for the very long (10h+) video
**Do:** Start notes for the 10h+ video. You can leave it running (keep the Mac plugged in and stop it from sleeping). Check progress now and then.
**Expect:** N is large (dozens of chunks). Progress keeps moving. The job finishes without an error, and the notes cover the whole video, not only the first hour. Minutes taken: ____ (start ____ end ____)
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 8. Crash in the middle, then resume
**Do:** Start notes for the 1-hour video again (or a different long one). When progress shows about chunk 5 or later, write down the number, then run `docker compose kill notes-ai`. Wait 10 seconds, then `docker compose up -d notes-ai`. If the job does not restart on its own, press the make-notes button again.
**Expect:** The job continues from about the chunk where it stopped (not from chunk 1). Logs may say it reused saved chunks: `docker compose logs notes-ai | grep -i -E "resume|checkpoint|skip" | tail`. Notes finish and look complete. Stopped at chunk ____, continued at chunk ____.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 9. Model off: short video falls back to Groq
**Do:** `scripts/llm.sh stop`. Make notes for the short video (or another short one).
**Expect:** Notes still finish. Logs (step 5 command) say provider `groq` for this job. The app may show a small note that Groq was used.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 10. Model off: long video waits with a clear message
**Do:** Model still stopped. Start notes for the 1-hour or 10h+ video.
**Expect:** The job does **not** go to Groq and does **not** fail with a scary error. You see a plain message such as "waiting for the local model, start it with scripts/llm.sh start". Then run `scripts/llm.sh start`: the job begins on its own (or after you press the button again) and finishes.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 11. Model off and no Groq key
**Do:** Stop the model. Remove `GROQ_API_KEY` from `.env` (keep a copy), `docker compose up -d`, make notes for a short video. Put the key back afterwards and `docker compose up -d` again.
**Expect:** A clear message that no notes service is available. No crash, no blank page.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 12. Video with no captions uses Whisper
**Do:** Model running. Make notes for the no-captions video.
**Expect:** Progress first shows the audio being transcribed (this is slower), then chunks. Logs mention Whisper: `docker compose logs notes-ai | grep -i whisper | tail`. Notes match what is said in the video.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 13. No network
**Do:** Turn Wi-Fi off. Try to make notes for a video you already imported. Turn Wi-Fi back on.
**Expect:** A clear message that the video could not be downloaded. The app keeps working once Wi-Fi is back.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 14. Notes on a phone
**Do:** Open the app on your phone (through the tunnel link) and open the notes from step 6.
**Expect:** Notes are readable without zooming; headings and lists look right; the PDF button works.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

## Security checks
The model (8081) and the notes worker (5055) must only be reachable from your own Mac, never from the internet.

### 15. Model works locally only
**Do:** On the Mac: `curl -s http://127.0.0.1:8081/v1/models`. Then find your Mac's network address with `ipconfig getifaddr en0` and run `curl -s -m 5 http://<that address>:8081/v1/models`.
**Expect:** The first works. The second fails (connection refused or timeout). Also try `http://<that address>:8081` from your phone's browser on the same Wi-Fi: it must not load.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 16. Ports 8081 and 5055 are not reachable through the tunnel
**Do:** With the tunnel running (`docker compose --profile tunnel up -d`), take the tunnel link (e.g. `https://xxxx.trycloudflare.com`) and open these on your phone using mobile data (Wi-Fi off): `<tunnel>:8081`, `<tunnel>/v1/models`, `<tunnel>:5055`. Also run on the Mac: `curl -s -m 10 https://<tunnel>/v1/models`.
**Expect:** None of them show model or worker output (you get an error page, the AQspace page, or "not found"). Only the AQspace app is reachable through the tunnel.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

### 17. 5055 is not open on the Mac either
**Do:** `curl -s -m 5 http://127.0.0.1:5055/` and `docker compose ps` (look at the PORTS column).
**Expect:** curl fails; only `127.0.0.1:5180` is published, nothing on 5055 or 0.0.0.0.
- [ ] Pass  - [ ] Fail  - [ ] Blocked
What I saw:

## Clean up
- [ ] `scripts/llm.sh stop` when you are done (frees about 6 GB of memory).
- [ ] `docker compose down`.

## Result
- Steps passed: __ / 17
- [ ] **PASS** -> `QA_APPROVED=1 scripts/board.sh move 34 Done`
- [ ] **FAIL** -> bug comment on the card (format in `docs/qa/TEMPLATE.md`), then `scripts/board.sh move 34 "In Progress"`

Then run the quality evaluation in `docs/qa/r5-eval.md`.
