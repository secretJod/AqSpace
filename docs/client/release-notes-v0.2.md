# AQspace v0.2 - Release notes

*November 2026*

## In short

v0.2 is about long lectures and our own AI. AQspace can now make notes from videos up to 24 hours long, using an AI model that runs on the host Mac instead of a paid online service. It also brings in new features built on the other AQspace line of work: a smart playlist that suggests a watch order, and tools for the team to watch and measure the app.

## Notes from very long lectures (R5)

- **Our own AI model.** Notes are written by an open-source model (Qwen3-8B) running on the host Mac. There are no usage limits and no per-request cost. If the model is not running, AQspace falls back to Groq for short videos.
- **Videos up to 24 hours.** Long lectures are split into parts, each part is summarised, then the parts are joined into one set of notes with a full table of contents.
- **Picks up where it stopped.** Every finished part is saved as it goes. If a job is interrupted, asking again continues from the last saved part instead of starting over.
- **Clear progress.** While it works, AQspace shows which part it is on, for example "chunk 3/12".
- **Videos without captions.** When a video has no transcript, AQspace listens to the audio and writes one itself (Whisper speech-to-text), showing "Transcribing audio 2/8".
- **More YouTube link formats.** Short links, Shorts and embedded links are all accepted.
- **Model status.** The health check shows whether the local model is online or offline.

## New from the upstream line of work (R6)

- **Smart playlist.** The playlist name is treated as your learning goal. AQspace suggests the best order to watch the videos, lists the topics they cover and the topics still missing, and suggests real videos to fill the gaps.
- **Magic arrange.** One "Smart arrange" button reorders the playlist into that suggested order, with a short animation.
- **More AI choices.** Two extra AI providers: NVIDIA Nemotron, and the same Qwen3-8B model running on Google Colab for when the Mac is busy.
- **Faster repeat notes.** Notes already made are kept and reused, so asking again is instant.
- **Team tools (not for clients).** A private developer area on the host Mac only: a live 3D picture of how a request flows through the app, a live activity tracker with saved history, and a page that compares AI models on speed, reliability and accuracy.

## How to start it

Same as v0.1: Docker Desktop running, keys in place, then `docker compose up --build` and open **http://localhost:5180**. The local model is started separately with `scripts/llm.sh start` once it is installed (see below). Plain-language guide: [local-model.md](local-model.md).

## Known limits / pending

- **The local model is not installed yet.** Installing llama.cpp on the Mac (card #37) is waiting for approval. Until then, notes use Groq, which only handles short videos.
- **No real run with the model yet.** Long videos, resume and the local model are proven by automatic tests with a stand-in server, not yet with the real model on a real 24-hour lecture. Note quality against Groq is still to be measured.
- **Speech-to-text redownloads.** The Whisper files are fetched again after each rebuild of the app, and the first rebuild is slower and larger.
- **Small display glitch.** After the parts are done, the progress text can still show "chunk N/N" during the final steps.
- **Still no login.** Everyone who opens AQspace, including through the public link, shares the same playlists and AI keys.
- **The Mac must stay on.** Long lectures can take a long time, and the Mac must stay awake for the whole job.
