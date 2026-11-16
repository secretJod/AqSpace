# Smart playlist: contract between the layers

The playlist NAME is the learning goal; its videos are the topics already covered.
One run = 3 AI agents (profiler, sequencer, gap analyst) + code checks, implemented in
`notes_engine/smart_playlist.py`. Change this contract only together with the API and the web app.

```
browser (apps/web)  -->  API :5180 (apps/api, Node)  -->  worker :5055 (apps/worker)  -->  Gemini / Groq
```

API keys come from the worker's `backend/.env` only and are never printed or logged.

## 1. Worker (port 5055)

`POST /api/smart`   JSON `{ "goal": str (1-120), "videos": [{"id": 11-char, "title": str, "channel": str, "duration_sec": int}] (2..20),
                         "provider": "gemini"|"groq", "model"?: str }`
  -> `202 {"job_id": hex}`; 400 for bad input (same error style as /api/jobs); 429 when busy; 503 if engine not installed.
  Keys come from `backend/.env` through the existing `server_key(provider)` (never from the browser).
  Default model for provider gemini is `gemini-3.5-flash-lite` (the old default `gemini-2.5-flash` returns 404 for new keys).

`GET /api/smart/<job_id>` -> `200 {"status": "queued"|"running"|"done"|"error", "stage": "transcripts"|"profiling"|"ordering"|"gaps"|"checking"|"candidates",
                                  "pct": 0-100, "message": str, "error": str, "result"?: Result, "usage"?: Usage}`; `404` when unknown (worker restarted).

Result (only when status = done):
```json
{
  "goal": "System Design Interview Prep",
  "path_summary": "one or two sentences",
  "order": [{"video_id": "i7twT3x5yv8", "reason": "why here"}],
  "unplaced": [{"video_id": "U-G-mSd4KAE", "reason": "why it is not in the path"}],
  "off_goal": [{"video_id": "U-G-mSd4KAE", "reason": "..."}],
  "areas": [{"area": "Rate limiting", "why": "...", "status": "covered"|"partial"|"missing",
             "covered_by": ["videoId"], "priority": "high"|"medium"|"low"}],
  "suggestions": [{"topic": "...", "reason": "...", "kind": "overview"|"deep-dive"|"practice",
                   "search_query": "...", "candidates": [{"id": "11chars", "title": "", "channel": "", "duration_sec": 656, "url": "https://www.youtube.com/watch?v=..."}]}],
  "video_topics": {"videoId": {"level": "beginner"|"intermediate"|"advanced", "summary": "...", "topics": ["name", "..."]}},
  "checks": ["human readable verification notes"],
  "stats": {"topics_claimed": 25, "topics_grounded": 22, "videos_readded_to_order": 0, "areas_downgraded_to_missing": 0, "suggestions": 3, "candidates_found": 6}
}
```
Rules the code (not the model) enforces: every playlist video appears exactly once in `order` or `unplaced`;
a "covered" area must cite real playlist videos (else downgraded to "missing"); topic evidence quotes must exist in the transcript
(unsupported topics are dropped); candidates are real YouTube search results, 120-1500 s long, not already in the playlist.
`Usage`: `{"calls": n, "total_tokens": n, "wall_seconds": x, "api_seconds": x, "waiting_seconds": x}` (burn ledger, per run).
Jobs live in memory (like notes jobs); finished jobs are pruned like the existing ones.

## 2. API (port 5180): base `/api/v1`, user = `req.user`, playlist = slug `:id`

`POST /api/v1/playlists/:id/smart`  (heavy rate limiter)
  - 404 unknown playlist; 422 `{error}` when the playlist has < 2 or > 20 videos.
  - Builds `{goal: playlist.name, videos}` from the playlist, computes `fingerprint` = sha256 of goal + the SORTED video ids.
  - If a run with the same fingerprint is `queued|running|ready` -> return it (200, `cached: true`). Else start one in the worker -> 202.
  - Provider = `config.pySmartProvider` (env `PY_SMART_PROVIDER`, default `gemini`).
`GET /api/v1/playlists/:id/smart` -> the latest run for that playlist (so the panel can auto-show):
```json
{ "state": "none"|"queued"|"running"|"ready"|"error",
  "pct": 0, "stage": "profiling", "message": "", "error": "",
  "fingerprint": "...", "current": true, "generatedAt": "ISO", "provider": "gemini", "model": "gemini-3.5-flash-lite",
  "result": Result, "usage": Usage }
```
  `current` = fingerprint still matches the playlist now (false -> "playlist changed since this was generated"; result still returned).
  `result`/`usage` only when state = ready. Results are stored in SQLite (migration `sql/002_smart_runs.sql`) so they survive worker restarts
  and page reloads; a queued/running job whose worker id 404s becomes `error` ("The analysis was interrupted - run it again").
  A failed run never blocks a new POST.

## 3. Web app (apps/web, plain JS, no build step)

- A "Smart arrange" button starts a run (POST), then polls the GET route about every 1.5 s until the
  run is `ready` or `error`, or the user leaves the page. A stored run is shown as soon as the playlist
  opens.
- The panel shows the goal and `path_summary`; the covered / partial / missing areas (missing and high
  priority first); suggested videos per missing topic with "Add to playlist" and "Watch on YouTube"; the
  recommended order with reasons and an "Apply order" action (with undo); off-goal videos; and a short
  footer built from `checks` and `usage`.
- When `current` is false, the panel notes that the playlist changed since the analysis and offers the
  button as the refresh action.
