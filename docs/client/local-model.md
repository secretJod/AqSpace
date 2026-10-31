# Making notes with your own model on the Mac

*Status: the notes side is built (PR #45, waiting for QA). The start/stop
command (`scripts/llm.sh`) is **card #37**. It is not built yet and waits for your
OK to download llama.cpp. Steps that need #37 are marked **[needs #37]**.*

## What changed
- Notes now come from **your own model, Qwen3-8B**, running on your Mac. They no longer come from a cloud service.
- **No rate limits.** There are no daily caps and no "too many requests" errors.
- **Videos up to 24 hours.** Long videos are cut into chunks. Each chunk is summarised, then the summaries are joined into one set of notes.
- **Jobs resume after a crash.** Each finished chunk is saved. If the Mac, Docker or the model stops, run the job again and it carries on from where it stopped.
- Colab is no longer needed. It is now only an optional extra.

## One-time setup
1. **Install the model server [needs #37].** Once you approve card #37, the team adds `scripts/llm.sh`. It downloads llama.cpp into the project folder only. There is no system-wide install. The model file (about 5 GB) is already in `models/`.
2. **Cap Docker's memory at 4 GB.** Open Docker Desktop, then Settings, then Resources, and set Memory to 4 GB. This leaves room on the Mac for the model.
3. **Speech-to-text model.** For videos that have no captions, the Whisper speech-to-text model downloads by itself the first time you use it. That first run is slower. It also downloads again after Docker rebuilds the app (a fix is planned).

## Daily use
1. `scripts/llm.sh start` turns the model on **[needs #37]**.
2. `docker compose up` starts the app. Open http://localhost:5180.
3. Pick a video and click to make notes.
4. Watch the progress line. For long videos it shows **"chunk i/N"**, for example "chunk 7/40". Before that, videos without captions show "Transcribing audio i/N".

## What to expect
These are estimates. We will measure the real times.
- **1-hour video:** about 25-35 minutes.
- **24-hour video:** about 5-6 hours.
- **If the model is off:** short videos use Groq (the old cloud service) instead. Long videos wait until the model is back on.

## How to stop
1. `docker compose down` stops the app.
2. `scripts/llm.sh stop` turns the model off and frees the memory **[needs #37]**.
3. `scripts/llm.sh status` tells you whether the model is on **[needs #37]**.

## Where your notes are saved
- **Notes files (PDF and others):** `lecture-notes-ai/backend/output/` in the project folder.
- **Your playlists and progress:** `aq-api/data/`.
- Everything stays inside the project folder. Deleting the folder removes it all, so back up your notes first.
