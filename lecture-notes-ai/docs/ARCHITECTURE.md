# Architecture

## AI engine

The AI engine turns a YouTube link into a validated *Notes JSON* document. Rendering that JSON
into HTML/PDF is done by `notes_engine/pdf.py`, which is outside this section.

### Pipeline

```text
YouTube URL
   |
   v
ingest.get_transcript()                         notes_engine/ingest.py
   |  0. parse_video_id()  (only real YouTube hosts: SSRF guard)    transcripts/youtube_urls.py
   |  1. disk cache hit? -> return it (30 days)                      cache.py
   |  2. title / channel / duration (oEmbed, then yt-dlp)
   |  3. captions: youtube-transcript-api -> yt-dlp subtitles -> Groq Whisper (only with a Groq key)
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
   |   c) map-reduce (everything else, and fallback when a) or b) is unusable / too few sections):
   |        slices --digest calls--> digests          (cached: cache "digest")
   |        digests --pack_batches--> batches --compose calls--> sections (cached: cache "compose")
   |        outline --final call--> subtitle / cover / glossary / recap
   |
   |  every LLM call goes through _Client.ask_json():
   |     pacer (tokens/minute) -> HTTP POST with retries (429 / 5xx / network)
   |     -> extract text -> parse_json (fences, outer {...}, trailing commas)    ai/json_repair.py
   |     -> on failure: one "fix this JSON" call, or salvage truncated output
   v
notes_schema.validate_notes()                   notes_engine/notes_schema.py
   |  coerce messy JSON into the schema (docs/notes-schema.md), renumber sections, rebuild TOC
   v
Notes JSON  ---->  pdf.render_html() / pdf.render_pdf()   (rendering, see pdf.py)
```

### Module map

| Module | What it does |
| --- | --- |
| `notes_engine/__init__.py` | `generate()` - the whole flow in one call; lazy re-exports. |
| `notes_engine/__main__.py` | Command line wrapper (`python -m notes_engine URL ...`). |
| `notes_engine/ingest.py` | `get_transcript()` and the three fetch stages; re-exports the `transcripts/` helpers. |
| `notes_engine/transcripts/errors.py` | `IngestError`, `PlaylistError`, all user-facing ingest messages. |
| `notes_engine/transcripts/youtube_urls.py` | `parse_video_id()`, `parse_playlist_id()`. |
| `notes_engine/transcripts/cleaning.py` | Caption cleaning, de-duplication, merging; json3 / vtt parsers. |
| `notes_engine/transcripts/chunking.py` | `chunk_transcript()`, `format_timestamp()`. |
| `notes_engine/transcripts/playlists.py` | `get_playlist()` (yt-dlp flat listing). |
| `notes_engine/llm.py` | `generate_notes()`, the HTTP `_Client`, pacing, and the pipeline strategies. |
| `notes_engine/ai/providers.py` | `PROVIDERS`, API URLs, per-model size profiles (token budgets explained). |
| `notes_engine/ai/errors.py` | `LLMError` and internal signals (`_BadJSON`, `_OutputTruncated`, ...). |
| `notes_engine/ai/key_safety.py` | Clean a pasted key; scrub keys out of any message. |
| `notes_engine/ai/responses.py` | Retry-After / quota hints, small type guards. |
| `notes_engine/ai/json_repair.py` | `parse_json()`, `salvage_truncated_json()`. |
| `notes_engine/ai/sections.py` | Find / join / count sections, pack digest batches, fallback glossary. |
| `notes_engine/prompts.py` | All prompt texts and the Gemini JSON schemas. |
| `notes_engine/notes_schema.py` | `validate_notes()` - forgiving coercion into the Notes schema. |
| `notes_engine/cache.py` | Optional disk cache (`LNA_CACHE_DIR`), LRU eviction. |
| `notes_engine/smart_playlist.py` | Three-agent playlist analysis built on `llm._Client` + `ingest`. |

### Compatibility rule

`ingest.py` and `llm.py` re-export every name they defined before the split (for example
`llm._profile`, `llm._join_parts`, `ingest._Fail`, `ingest._parse_vtt`), so
`from notes_engine.llm import ...` / `from notes_engine.ingest import ...` keep working.
Functions that tests patch on these modules (`llm._sleep`, `llm._get_chunker`,
`ingest._get_metadata`, `ingest._oembed`, `ingest._ytdlp_info`, `ingest._fetch_via_*`) and the code
that calls them stay inside `llm.py` / `ingest.py` on purpose - moving them would silently bypass
the patches.

### Where to start reading

1. `notes_engine/__init__.py` -> `generate()` (the whole flow in 20 lines).
2. `notes_engine/ingest.py` -> `get_transcript()` (section 6), then `transcripts/chunking.py`.
3. `notes_engine/llm.py` -> `generate_notes()` at the bottom, then `_write_raw_notes()` and
   `_map_reduce()`; `_Client` (section 4) for the HTTP details.
4. `notes_engine/ai/providers.py` for why the numbers are what they are.
5. `notes_engine/prompts.py` and `notes_engine/notes_schema.py` for what we ask and what we accept.

## Renderer & worker

### Notebook renderer (`notes_engine/render/`)

A notes dict becomes one self-contained HTML page (fonts, CSS, Rough.js and the pagination
script are all inlined). For a PDF, headless Edge/Chrome prints that page.

| File | What it does |
|---|---|
| `text.py` | escaping, the tiny `**bold**` / `` `code` `` markup (added back *after* escaping), seeds, number formatting |
| `fonts.py` | base64 `@font-face` CSS; measures and wraps text with the real fonts (PyMuPDF) |
| `sketch.py` | `Sketch`, the seeded hand-drawn SVG toolkit. Each shape is drawn three ways: Python strokes (`g.py`, the fallback), Rough.js specs (`g.rg`) and the text (`g.tx`) |
| `diagrams.py` | `clean_diagram` plus one layout/draw function for each type: flow, stack, compare, cycle, tree, timeline, mindmap, sequence |
| `decorations.py` | the binding rings, the cover border and the squiggly underlines |
| `blocks.py` | paragraph / bullets / steps / definition / example / callout / code / table / formula |
| `sections.py` | the section, glossary and recap "units" |
| `cover.py` | the cover page |
| `page_layout.py` | `build_document` / `render_html`: puts the whole page together |
| `pdf_export.py` | `render_pdf`: finds the browser, prints the page, checks that "pg. N / M" is right on every page, and retries once with a longer time budget if it is not |

`notes_engine/pdf.py` is the old import path, kept for compatibility. It re-exports `render_html`,
`render_pdf`, `PdfError` and `build_diagram_svg`, plus the private aliases that tests use
(`_find_browser`, `_clean_diagram`, `_mindmap_tree`, `_rough_js`). Its `render_html`/`render_pdf`
wrappers look up `pdf._rough_js` each time they run, so `monkeypatch.setattr(pdf, "_rough_js", ...)`
still works.

Pagination runs in the browser (`templates/notebook.js`). Python decides *what* goes into each
item; the script measures every item and pours it into fixed 794x1122 px A4 page boxes. Long
blocks can be split (`data-split`, `data-minkeep`, `data-minmove`), a heading stays with the block
after it (`data-keep`), and page numbers are added once the total page count is known.
`templates/notebook.css` is organised in numbered sections. Leave `templates/vendor/rough.js`
untouched.

Determinism: every wobble comes from a seed made from the content, so the same notes always give
byte-identical HTML.

### Worker (`backend/app/`, Flask on 127.0.0.1:5055)

`backend/run.py` (started by docker compose) calls `app.server.create_app()`.

| File | What it does |
|---|---|
| `server.py` | entry point: `create_app(config)` (settings, output folder, `State`, CORS, security, routes). It also re-exports the older names (`GENERIC_ERROR`, `State`, ...) |
| `settings.py` | folders, validation regexes, provider table and env-key names, CSP strings |
| `helpers.py` | `redact` (keys never reach the logs), `format_duration`, `slugify`, `cleanup_old_jobs` |
| `state.py` | `State` on `app.extensions['lna']`: jobs, rate-limit buckets, lazy `load_modules/load_ingest/load_smart` (tests replace these) |
| `jobs.py` | background threads: `run_note_job` (transcript 0-25 %, notes 25-85 %, HTML+PDF 85-100 %) and `run_smart_job` |
| `security.py` | local-host/origin guard (DNS rebinding), security headers / CSP, JSON error pages |
| `providers.py` | `provider_table()` (from `llm.PROVIDERS`, with fallbacks) and `server_key()` |
| `routes.py` | every route, listed at the top of the file. `notes.html` gets a CSP that allows exactly the hashes of the inline scripts we generated |

Where to start reading: `server.py`, then `routes.py`, then `jobs.py`. For the renderer:
`render/__init__.py`, then `page_layout.py`, then `templates/notebook.js`.

## AQspace additions (on top of this layout)

These are AQspace features that are not in the reference project. They live in the same modules
as the code they extend, so the layout above still tells you where to look.

| Feature | Where |
|---|---|
| `local` provider (llama-server at `LNAI_LOCAL_URL`, optional `LNAI_LOCAL_KEY`), `local` / `local-small` profiles, deprecated `colab` alias | static parts in `ai/providers.py`; `local_base_url`, `local_server_ctx`, `local_online` in `llm.py` |
| Gemini RPM pacer (`LNAI_GEMINI_RPM`, thread-safe, counts in-flight calls, "waiting" messages, `quota_dead`) | `llm._Pacer`, `llm._Client` |
| Provider fallback chain (local -> Groq for videos up to 1 h -> NVIDIA; `LNA_PROVIDER_FALLBACK`; `_TransientError`) | `llm._fallback_target`, `llm.generate_notes`; `ai/errors.py` |
| Per-chunk checkpoints with resume, hierarchical merge levels, cache keyed by `profile_hash` + `prompts.PROMPT_VERSION` (no fallback answers cached) | `llm._Checkpoints`, `llm._merge_levels`, `llm._cache_key`; `cache.py` |
| `chunk` / `chunks` in job status | `backend/app/jobs.py` (`CHUNK_RE` in `settings.py`), `state.py` |
| Startup key check (whitespace / quotes; the prefix is not checked, #127) | `backend/app/keycheck.py`, called by `backend/run.py` |
| 24 h ingest (streamed captions with retries), chunked local faster-whisper / Groq speech-to-text with checkpoints (`LNAI_WHISPER`, `LNAI_WHISPER_DIR`, `LNAI_WORK_DIR`) | `ingest.py` stage 3; channel / playlist link messages in `transcripts/errors.py`, `transcripts/youtube_urls.py` |
| Long-notes contents pages, budgets that scale with the section count, macOS browser paths | `render/sections.contents_unit`, `render/cover.py`, `render/pdf_export.render_budgets` |
| Smart playlist passes `groq_key` and `work_dir` to ingest | `smart_playlist.py`, `backend/app/jobs.run_smart_job` |
| Model evaluation harness | `demo/notes_eval/` |
