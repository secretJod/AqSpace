# Worker architecture

The worker turns a YouTube link into a validated *Notes JSON* document and draws it as a
hand-made "field notebook" (HTML preview and A4 PDF). It has three layers:

1. **Flask app** (`backend/app/`): HTTP routes, background jobs, security.
2. **Notes engine** (`notes_engine/`): transcript, AI notes, validation, smart playlist.
3. **Renderer** (`notes_engine/render/`): Notes JSON to HTML to PDF.

The README covers running, testing and adding features. This page explains how the parts fit.

## The pipeline

```text
YouTube URL
   |
   v
ingest.get_transcript()                         notes_engine/ingest.py
   |  0. parse_video_id()  (only real YouTube hosts: SSRF guard)    transcripts/youtube_urls.py
   |  1. disk cache hit? -> return it (30 days)                      cache.py
   |  2. title / channel / duration (oEmbed, then yt-dlp)
   |  3. captions: youtube-transcript-api -> yt-dlp subtitles
   |     -> speech-to-text (local faster-whisper, or Groq Whisper with a Groq key)
   |  4. clean + de-duplicate + merge cues into 5-15 s segments      transcripts/cleaning.py
   v
transcript dict {video_id, title, channel, duration_sec, language, source, segments[]}
   |
   v
llm.generate_notes()                            notes_engine/llm.py
   |  check provider / key / model, build _Client (size profile from ai/providers.py)
   |
   |  chunk: ingest.chunk_transcript() -> text with [mm:ss] markers  transcripts/chunking.py
   |
   |  pick a strategy:
   |   a) parallel single pass (Gemini, short lecture): N slice calls + 1 front-matter call at once
   |   b) single pass (short lecture, output fits):     1 call -> whole Notes JSON
   |   c) map-reduce (everything else, and the fallback when a) or b) is unusable or too short):
   |        slices --digest calls--> digests          (checkpointed, cached as "digest")
   |        very long lectures: digests --merge levels--> fewer digests
   |        digests --pack_batches--> batches --compose calls--> sections (cached as "compose")
   |        outline --final call--> subtitle / cover / glossary / recap
   |
   |  every LLM call goes through _Client.ask_json():
   |     pacer (tokens or requests per minute) -> HTTP POST with retries (429 / 5xx / network)
   |     -> extract text -> parse_json (fences, outer {...}, trailing commas)    ai/json_repair.py
   |     -> on failure: one "fix this JSON" call, or salvage truncated output
   v
notes_schema.validate_notes()                   notes_engine/notes_schema.py
   |  coerce messy JSON into the schema (docs/notes-schema.md), renumber sections, rebuild TOC
   v
Notes JSON  ---->  pdf.render_html() / pdf.render_pdf()        notes_engine/render/
```

In the running service, `backend/app/jobs.py` drives these three steps in a background thread and
maps their progress to 0-25 % (transcript), 25-85 % (notes) and 85-100 % (HTML and PDF).

## Notes engine

| Module | What it does |
| --- | --- |
| `notes_engine/__init__.py` | `generate()`: the whole flow in one call; lazy re-exports. |
| `notes_engine/__main__.py` | Command line wrapper (`python -m notes_engine URL ...`). |
| `notes_engine/ingest.py` | `get_transcript()` and the three fetch stages; re-exports the public `transcripts/` helpers. |
| `notes_engine/transcripts/errors.py` | `IngestError`, `PlaylistError`, all user-facing ingest messages. |
| `notes_engine/transcripts/youtube_urls.py` | `parse_video_id()`, `parse_playlist_id()`. |
| `notes_engine/transcripts/cleaning.py` | Caption cleaning, de-duplication, merging; json3 / vtt parsers. |
| `notes_engine/transcripts/chunking.py` | `chunk_transcript()`, `format_timestamp()`. |
| `notes_engine/transcripts/playlists.py` | `get_playlist()` (yt-dlp flat listing). |
| `notes_engine/llm.py` | `generate_notes()`, the HTTP `_Client`, pacing, checkpoints, the strategies and the provider fallback. |
| `notes_engine/ai/providers.py` | `PROVIDERS`, API URLs, per-model size profiles (the token budgets are explained there). |
| `notes_engine/ai/errors.py` | `LLMError` and internal signals (`_BadJSON`, `_OutputTruncated`, `_TransientError`, ...). |
| `notes_engine/ai/key_safety.py` | Clean a pasted key; scrub keys out of any message. |
| `notes_engine/ai/responses.py` | Retry-After / quota hints, small type guards. |
| `notes_engine/ai/json_repair.py` | `parse_json()`, `salvage_truncated_json()`. |
| `notes_engine/ai/sections.py` | Find / join / count sections, pack digest batches, fallback glossary. |
| `notes_engine/prompts.py` | All prompt texts and the Gemini JSON schemas; `PROMPT_VERSION`. |
| `notes_engine/notes_schema.py` | `validate_notes()`: forgiving coercion into the Notes schema. |
| `notes_engine/cache.py` | Optional disk cache (`LNA_CACHE_DIR`) with least-recently-used eviction. |
| `notes_engine/smart_playlist.py` | Three-agent playlist analysis built on `llm._Client` and `ingest`. |

### Resilience

- **Pacing.** Groq's free tier counts tokens per minute (input plus the requested `max_tokens`),
  Gemini's counts requests per minute. `llm._Pacer` keeps a trailing 60 s window under the limit,
  and a 429 sleeps for the time the provider asks for. A daily-quota answer marks the client
  `quota_dead`, so parallel calls of the same job stop at once.
- **Checkpoints.** Every finished step is saved under `<checkpoint_dir>/<video_id>/`. The manifest
  holds a hash of the transcript and of provider + model + profile + `PROMPT_VERSION`, so a retry
  resumes only when nothing that shapes the answer changed.
- **Cache.** Accepted digest and compose answers are cached with the full prompt text in the key.
  Answers from a fallback provider are never cached.
- **Fallback.** With `LNA_PROVIDER_FALLBACK=1`, a transient failure (rate limit, 5xx, timeout,
  unreachable local server) retries the *whole* video with one other provider: never a mix of two
  providers in one notebook. See the table in the README.

### Patch points the tests rely on

Tests replace a few functions on the module where they are called. Those functions, and the code
that calls them, must stay where they are, or the patches silently stop working:

- `llm._sleep`, `llm._get_chunker`, `llm.local_online`, `llm._CTX_SEEN`, `llm.requests`
- `ingest._get_metadata`, `ingest._oembed`, `ingest._fetch_via_api`, `ingest._fetch_via_ytdlp`,
  `ingest._fetch_via_whisper`, `ingest._split_audio`, `ingest._download_audio`, `ingest._find_ffmpeg`
- `pdf._rough_js` (the wrappers in `notes_engine/pdf.py` look it up on every call)
- `State.load_modules` / `load_ingest` / `load_smart` in the Flask app

## Renderer (`notes_engine/render/`)

A notes dict becomes one self-contained HTML page (fonts, CSS, Rough.js and the pagination script
are all inlined). For a PDF, headless Edge/Chrome/Chromium prints that page.

| File | What it does |
|---|---|
| `text.py` | escaping, the tiny `**bold**` / `` `code` `` markup (added back *after* escaping), seeds, number formatting |
| `fonts.py` | base64 `@font-face` CSS; measures and wraps text with the real fonts (PyMuPDF) |
| `sketch.py` | `Sketch`, the seeded hand-drawn SVG toolkit. Each shape is drawn three ways: Python strokes (the fallback), Rough.js specs and the text |
| `diagrams.py` | `clean_diagram` plus one layout/draw function per type: flow, stack, compare, cycle, tree, timeline, mindmap, sequence |
| `decorations.py` | the binding rings, the cover border and the squiggly underlines |
| `blocks.py` | paragraph / bullets / steps / definition / example / callout / code / table / formula |
| `sections.py` | the section, contents, glossary and recap "units" |
| `cover.py` | the cover page |
| `page_layout.py` | `build_document` / `render_html`: puts the whole page together |
| `pdf_export.py` | `render_pdf`: finds the browser, prints the page, checks that "pg. N / M" is right on every page, and retries once with a longer time budget if it is not |

`notes_engine/pdf.py` is the import path callers use (`from notes_engine import pdf`). It exposes
`render_html`, `render_pdf`, `PdfError` and `build_diagram_svg`, plus the private aliases the tests
use (`_find_browser`, `_clean_diagram`, `_mindmap_tree`, `_render_budgets`, `_rough_js`).

Pagination runs in the browser (`templates/notebook.js`). Python decides *what* goes into each
item; the script measures every item and pours it into fixed 794x1122 px A4 page boxes. Long
blocks can be split (`data-split`, `data-minkeep`, `data-minmove`), a heading stays with the block
after it (`data-keep`), and page numbers are added once the total page count is known.
`templates/notebook.css` is organised in numbered sections. `templates/vendor/rough.js` is a
vendored library: do not edit it.

Determinism: every wobble comes from a seed made from the content, so the same notes always give
byte-identical HTML.

Safety: all text from the notes is escaped; only `**bold**` and `` `code` `` are re-introduced after
escaping. The preview route allows exactly the hashes of the inline scripts the renderer wrote.

## Flask app (`backend/app/`, 127.0.0.1:5055)

`backend/run.py` (the container's command) prepares the process and calls `app.server.create_app()`.

| File | What it does |
|---|---|
| `server.py` | `create_app(config)`: settings, output folder, `State`, CORS, security, routes |
| `settings.py` | folders, validation regexes, provider table and env-key names, CSP strings |
| `helpers.py` | `redact` (keys never reach the logs), `format_duration`, `slugify`, `cleanup_old_jobs` |
| `state.py` | `State` on `app.extensions['lna']`: jobs, rate-limit buckets, lazy `load_modules` / `load_ingest` / `load_smart` |
| `jobs.py` | background threads: `run_note_job` and `run_smart_job` |
| `security.py` | local host/origin guard (DNS rebinding), security headers and CSP, JSON error pages |
| `providers.py` | `provider_table()` (from `llm.PROVIDERS`, with fallbacks) and `server_key()` |
| `keycheck.py` | startup check of provider keys (whitespace / quotes only; values are never logged) |
| `routes.py` | every route, listed at the top of the file |

The worker binds to 127.0.0.1 and answers only local host names. In Docker, the Node API joins its
network namespace and is the only service that talks to it.

Where to start reading: `server.py`, then `routes.py`, then `jobs.py`. For the renderer:
`render/__init__.py`, then `page_layout.py`, then `templates/notebook.js`.

## Developer tools

`tools/notes_eval/` runs the real pipeline once per provider on a few fixed videos and scores the
notes (LLM judge, code checks, blind human sheet). It is not part of the running service; see its
README.
