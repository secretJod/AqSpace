# AQspace API (`apps/api`)

The HTTP API of AQspace. It owns the application data (users, sign-in sessions, playlists, videos, watch progress
and the records of generated notes and smart playlist runs) and serves the web app (`apps/web`) from the same origin.
The Python worker (`apps/worker`) does the heavy work: transcripts, notes, PDFs and language-model calls. This API
starts jobs there, follows their progress and keeps the results, so a finished job is reused by every user.

```
browser (apps/web, localStorage = offline cache)
   |  same origin, http://127.0.0.1:5180
API (this app)       users, playlists, progress, notes and smart records   ->  data/aq.db (SQLite)
   |  server to server, loopback only
worker (Python)      transcripts, notes, PDFs, model calls                 ->  http://127.0.0.1:5055
```

Node 24+ with Express 5 and the built-in `node:sqlite`. Express is the only runtime dependency.

## Run and test

```sh
cd apps/api
npm ci                 # npm cache goes to the repo-root .npm-cache (see .npmrc)
npm start              # http://127.0.0.1:5180/  (web app + API)
npm test               # node:test; starts a mock worker, needs no network
npm run lint           # ESLint (eslint.config.js)
npm run format         # Prettier, rewrites files
npm run format:check   # Prettier, check only (CI)
```

Start the worker as well to generate notes (`docker compose up` from the repo root starts both). Without it everything
else works and notes calls answer `503 {"code": "py_offline"}`.

## Folder map

Every source file starts with a short header: what it does, who uses it, and what to read next.

```
src/
  server.js              entry point: load config, listen, shut down cleanly
  app.js                 builds the Express app: services, middleware and routers, in order
  config/
    load-config.js       every setting and environment variable
  routes/                one file per API area; thin: read the request, call a service or the repo
    index.js             builds /api/v1 and shows the middleware order
    health.js            GET /health
    auth-status.js       GET /auth/status
    me.js                GET /me
    sync.js              POST /sync/import
    playlists.js         /playlists and their videos
    progress.js          /progress
    notes.js             /notes
    smart.js             /playlists/:id/smart
    youtube-import.js    GET /import/youtube
    fonts.js             GET /static/fonts/:file (outside /api)
    ui-static.js         serves apps/web (runtime assets only)
  services/              logic that talks to the worker and keeps job state
    worker-client.js     HTTP client for the worker
    notes-service.js     notes jobs: start, poll, cache, resume after a worker restart, expire, stream files
    smart-service.js     smart playlist runs: fingerprint, poll, store the result
    job-helpers.js       shared per-key lock, progress mapping, error mapping
  db/                    everything that touches SQLite
    database.js          open the database, run migrations, tx(), write-contention counter
    repository.js        combines the repo files into one `repo` object
    users-repo.js        users, profile, sessions
    playlists-repo.js    playlists and their videos
    progress-repo.js     watch progress
    sync-import-repo.js  import of the browser's localStorage data
    playlist-helpers.js  shared row lookups, JSON shaping, appendVideos
  middleware/
    security-headers.js  CSP and other security headers
    request-logger.js    one console line per request
    local-only.js        host guard, CORS, proxy detection, the /dev guard
    rate-limit.js        fixed-window limiter ("general" and "heavy")
    local-auth.js        the single built-in user (AUTH_MODE=local)
    google-auth.js       Google sign-in (AUTH_MODE=google)
    error-handler.js     404 fallback and JSON error replies
  dev/                   the /dev tracker (local only)
    tracker.js           records requests, worker calls and job changes
    ring-buffer.js       in-memory list of recent entries
    dev-log-store.js     daily JSONL files in data/devlogs
    mask-path.js         hides ids in recorded paths
    history-tools.js     filter, CSV and statistics for saved entries
    service-logs.js      tail of the service console logs, secrets masked
    dev-router.js        the /dev endpoints and pages
  utils/
    http-errors.js       HttpError and bad / notFound / conflict
    validate.js          input checks (ids, names, durations, videos)
    cookies.js           cookie parsing and signed cookie values
    time.js              nowIso()
    pipe-file.js         stream a worker response to the browser
dev-ui/                  static pages for /dev (eval-data.json is sample data for the eval page)
sql/                     migrations, NNN_name.sql, applied once each in order
test/                    node:test suites; helpers.js has startApp() and the mock worker
```

### How a request flows

```
request
  -> security headers -> request log -> host guard -> CORS -> dev tracker (if on)
  -> /api/v1 router: rate limit -> health | auth routes | authenticate -> JSON parser -> area router
  -> service (notes, smart) or the repository directly (playlists, progress)
  -> worker-client (Python on :5055) and db/*-repo.js (SQLite)
  <- JSON; a thrown HttpError becomes {error, code?} in error-handler.js, never a stack trace
```

Start reading at `src/app.js`, then `src/routes/index.js`, then one area end to end
(`routes/notes.js` -> `services/notes-service.js` -> `services/worker-client.js`).

## Environment variables

| Variable                       | Default                                             | Meaning                                                                         |
| ------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------- |
| `HOST`                         | `127.0.0.1`                                         | listen address; `0.0.0.0` only inside the container                             |
| `PORT`                         | `5180`                                              | listen port                                                                     |
| `DB_FILE`                      | `apps/api/data/aq.db`                               | SQLite file, created and migrated on start                                      |
| `UI_DIR`                       | `apps/web`                                          | the web app served on `/`                                                       |
| `PY_NOTES_URL`                 | `http://127.0.0.1:5055`                             | the worker; must be loopback unless `ALLOW_REMOTE_PY=1`                         |
| `ALLOW_REMOTE_PY`              | off                                                 | `1` allows a worker on another host                                             |
| `PY_NOTES_PROVIDER`            | `groq`                                              | provider sent to the worker for notes jobs                                      |
| `PY_SMART_PROVIDER`            | `gemini`                                            | provider sent to the worker for smart runs                                      |
| `PY_SMART_MODEL`               | empty                                               | model for smart runs; empty = the worker's default                              |
| `NOTES_REQUIRE_MEMBERSHIP`     | `1`                                                 | `0` lets a user start notes for any video, not only ones in their playlists     |
| `NOTES_MAX_AUTO_RESUMES`       | `3`                                                 | how often a notes job is re-submitted after the worker lost it                  |
| `BODY_LIMIT`                   | `256kb`                                             | JSON body limit (`/sync/import` allows 2 MB)                                    |
| `LOG`                          | `1`                                                 | `0` silences the request log                                                    |
| `RATE_LIMIT_PER_MIN`           | `600`                                               | requests per client per minute on `/api/v1`                                     |
| `RATE_LIMIT_HEAVY_PER_MIN`     | `20`                                                | starting notes or smart runs, and YouTube imports, per client per minute        |
| `TRUST_CF_HEADERS`             | off                                                 | `1` rate-limits each tunnel visitor by `CF-Connecting-IP` (loopback proxy only) |
| `TUNNEL_ORIGINS`               | empty                                               | extra page origins allowed by CORS, e.g. `https://*.trycloudflare.com`          |
| `AUTH_MODE`                    | `local`                                             | `local` (one built-in user) or `google`                                         |
| `GOOGLE_CLIENT_ID` / `_SECRET` | empty                                               | Google OAuth web client (required for `google`)                                 |
| `GOOGLE_REDIRECT_URI`          | `http://localhost:5180/api/v1/auth/google/callback` | must match the Google Cloud Console exactly                                     |
| `SESSION_SECRET`               | empty                                               | at least 32 characters, signs the OAuth state cookie (required for `google`)    |
| `SESSION_MAX_AGE_HOURS`        | `168`                                               | session lifetime                                                                |
| `AUTH_AFTER_LOGIN`             | `/`                                                 | where sign-in lands when no `?next=` was given                                  |
| `AQ_DEV_TOOLS`                 | `1`                                                 | `0` turns the /dev tracker off (404)                                            |
| `AQ_DEVLOG_DIR`                | `apps/api/data/devlogs`                             | saved tracker history; empty = memory only                                      |
| `AQ_DEVLOG_DAYS`               | `14`                                                | days of saved history to keep                                                   |
| `AQ_RUN_DIR`                   | `.run` (repo root)                                  | folder with service console logs for /dev; empty = off                          |

Secrets only come from the environment (or the repo's `.env` via docker compose); they are never logged.

## Endpoints (`/api/v1`)

All JSON. Errors are `{"error": "message", "code"?: "..."}` with 400 (validation), 401 (`auth_required`),
403 (origin or permission), 404, 409 (conflict), 413, 422 (the worker refused the input), 429 (with `Retry-After`)
and 502/503 (worker problems, `py_offline`). Everything after `authenticate` is scoped to `req.user`.

| Method and path                                            | Purpose                                                                                      |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /health` (`?deep=1` also asks the worker)             | `{ok, service, version, uptimeSec, db, notesService?, localModel?, dbBusy?}`; no sign-in     |
| `GET /auth/status`                                         | `{authMode, signedIn, user, loginUrl}`; no sign-in                                           |
| `GET /auth/google/login`, `/callback`, `POST /auth/logout` | Google sign-in (`AUTH_MODE=google` only)                                                     |
| `GET /me`                                                  | `{user, bootstrapped}`                                                                       |
| `GET /playlists` (`?include=videos`)                       | the user's playlists                                                                         |
| `POST /playlists`                                          | `{name, description?, id?, videos?, source?}` -> 201 `{playlist, added, skipped}`            |
| `GET` / `PATCH` / `DELETE /playlists/:id`                  | one playlist; PATCH takes `{name?, description?}`                                            |
| `POST /playlists/:id/videos`                               | one video -> 201 `{video}`, or `{videos: [...]}` -> `{added, skipped, playlist}`             |
| `PUT /playlists/:id/videos/order`                          | `{order: [videoId, ...]}`, every video exactly once                                          |
| `PATCH` / `DELETE /playlists/:id/videos/:videoId`          | edit or move one video / remove it                                                           |
| `GET /progress`, `GET` / `PUT /progress/:videoId`          | watch progress `{pos, dur, done, updated}`; an older `updated` is ignored (`stale: true`)    |
| `GET /notes`, `GET /notes/:videoId`                        | notes state `none / queued / running / ready / error`                                        |
| `POST /notes/:videoId`                                     | start notes: 202 new job, 200 existing job or cached notes                                   |
| `GET /notes/:videoId/html`, `/pdf`                         | the finished file, streamed from the worker                                                  |
| `GET` / `POST /playlists/:id/smart`                        | smart arrange runs for a playlist (2 to 20 videos)                                           |
| `GET /import/youtube?url=`                                 | reads a YouTube playlist through the worker (only the validated `list=` id is forwarded)     |
| `POST /sync/import`                                        | `{mode: "merge" or "replace", playlists, progress}`: imports the browser's localStorage data |

Outside `/api`: `GET /static/fonts/:file` (fonts for the notes page, from the worker), `/dev/*` and the web app.

## Database

SQLite in WAL mode. `src/db/database.js` runs every `sql/NNN_*.sql` file once, in numeric order, each in a
transaction, and records it in `schema_migrations`. Never edit a migration that has shipped; add a new file instead.
All SQL uses `?` placeholders; user input is never concatenated into SQL. Main tables: `users`, `sessions`, `videos`,
`playlists`, `playlist_videos`, `watch_progress`, `notes_jobs`, `smart_runs` (see the `sql/` files for columns).

## Security model

- Listens on `127.0.0.1`; the `Host` header must be localhost (DNS-rebinding guard).
- CORS only for loopback pages and `TUNNEL_ORIGINS`; a foreign `Origin` on a write is refused (403). This is the
  CSRF defence, together with JSON-only bodies and `SameSite=Lax` cookies.
- Security headers and CSP are set by hand in `middleware/security-headers.js`; `/api` replies are `no-store`.
- Per-client rate limits; body size limits; errors never contain stack traces.
- Only web asset files of `apps/web` are served: no dot-files, `_` folders, package files, docs or screenshots.
- The worker is called only on fixed paths with validated ids, must be on loopback, and its redirects are refused.
- Google sessions are server-side: the cookie holds a random token, the database only its SHA-256, logout deletes it.
- `/dev` answers only on this machine: anything that came through the tunnel (proxy headers) gets a plain 404.
- The request log holds method, path, status and time only.

## Developer tracker (`/dev`)

Local debugging pages, on by default: `/dev/` (hub), `/dev/tracker.html` (live requests, job events, history,
statistics, service logs), `/dev/flow.html` (how the services connect) and `/dev/eval.html` (notes provider
evaluation, from `dev-ui/eval-data.json`). The JSON endpoints live under `/dev/api/*` (see `src/dev/dev-router.js`).
Only method, masked path, status and timing are recorded; never headers, cookies, bodies or query strings.
History is written to `data/devlogs/*.jsonl` and pruned after `AQ_DEVLOG_DAYS`.

## How to add a feature

Worked example: **video bookmarks**, so a user can save moments in a video they study.
`GET /api/v1/bookmarks/:videoId` lists them and `POST /api/v1/bookmarks/:videoId` adds one `{atSec, label}`.
Work from the bottom up: schema, repository, service, route, test.

### 1. Migration: `sql/006_bookmarks.sql`

Use the next free number. The file runs once on every database, in a transaction.

```sql
-- Moments a user saved in a video.
CREATE TABLE bookmarks (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id    TEXT NOT NULL REFERENCES videos(id),
  at_sec      INTEGER NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX bookmarks_user_video ON bookmarks (user_id, video_id);
```

Because the table is owned by a user, also add `["bookmarks", "user_id"]` to `USER_KEYED` in `src/db/users-repo.js`,
so the first Google user takes over the local user's bookmarks. Add a `BASELINE_PROBES` entry in `src/db/database.js`
only if databases might already contain this table without the migration being recorded.

### 2. Repository: `src/db/bookmarks-repo.js`

Plain data access. Every function takes the owner's `userId` and touches only that user's rows.

```js
/* bookmarks-repo.js - saved moments in a video, per user.

   What:  list and add bookmarks.
   How it fits: part of the repository object (db/repository.js); used by services/bookmarks-service.js.
   Read next: services/bookmarks-service.js */
import { tx } from "./database.js";
import { nowIso } from "../utils/time.js";

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} helpers  from createPlaylistHelpers(db) (ensureVideo)
 */
export function createBookmarksRepo(db, { ensureVideo }) {
  const toJson = (row) => ({ id: row.id, atSec: row.at_sec, label: row.label, created: row.created_at });

  /** The user's bookmarks in one video, in time order. */
  function listBookmarks(userId, videoId) {
    return db
      .prepare("SELECT * FROM bookmarks WHERE user_id = ? AND video_id = ? ORDER BY at_sec")
      .all(userId, videoId)
      .map(toJson);
  }

  /** Adds one bookmark (values already validated) and returns it. */
  function addBookmark(userId, videoId, atSec, label) {
    return tx(db, () => {
      ensureVideo({ id: videoId, title: "", channel: "", durationSec: 0 });
      const id = Number(
        db
          .prepare("INSERT INTO bookmarks (user_id, video_id, at_sec, label, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(userId, videoId, atSec, label, nowIso()).lastInsertRowid
      );
      return toJson(db.prepare("SELECT * FROM bookmarks WHERE id = ?").get(id));
    });
  }

  return { listBookmarks, addBookmark };
}
```

Then spread it into the repository in `src/db/repository.js`:

```js
const bookmarks = createBookmarksRepo(db, helpers);
return { ...users, /* ... */ ...bookmarks };
```

### 3. Service: `src/services/bookmarks-service.js`

Rules that are more than storage go here; the route stays thin. A feature that only stores data
(like playlists and progress) may call the repository straight from the route and skip this step.

```js
/* bookmarks-service.js - the rules for bookmarks.

   What:  input checks and limits; storage is in db/bookmarks-repo.js.
   How it fits: routes/bookmarks.js calls list() and add().
   Read next: db/bookmarks-repo.js */
import { HttpError, bad } from "../utils/http-errors.js";
import { isObj, nonNeg, text } from "../utils/validate.js";

// Keeps one video's list short enough for the player sidebar.
const MAX_PER_VIDEO = 200;

/** @param {{ repo: object }} deps */
export function createBookmarksService({ repo }) {
  /** The user's bookmarks in one video. */
  const list = (user, videoId) => repo.listBookmarks(user.id, videoId);

  /**
   * Adds a bookmark. body: {atSec, label?}.
   * Errors: 400 bad body, 403 video not in the user's playlists, 409 too many bookmarks.
   */
  function add(user, videoId, body) {
    if (!isObj(body)) throw bad("Send a JSON object {atSec, label}.");
    const atSec = Math.floor(nonNeg(body.atSec, "atSec"));
    const label = text(body.label).slice(0, 80);
    if (!repo.userHasVideo(user.id, videoId))
      throw new HttpError(403, "Add this video to one of your playlists first.");
    if (repo.listBookmarks(user.id, videoId).length >= MAX_PER_VIDEO) {
      throw new HttpError(409, `At most ${MAX_PER_VIDEO} bookmarks per video.`);
    }
    return repo.addBookmark(user.id, videoId, atSec, label);
  }

  return { list, add };
}
```

Create it in `src/app.js` next to the other services (`const bookmarks = createBookmarksService({ repo });`)
and pass it to `createApiRouter`.

### 4. Route: `src/routes/bookmarks.js`

Read and validate URL parameters, call the service, shape the reply. Throw `HttpError`s; never catch them here.

```js
/* bookmarks.js - /api/v1/bookmarks : saved moments in a video.

   How it fits: mounted in routes/index.js after authentication; logic in services/bookmarks-service.js.
   Read next: services/bookmarks-service.js */
import { Router } from "express";
import { videoId } from "../utils/validate.js";

/**
 * @param {object} bookmarks  the bookmarks service
 * @returns {import("express").Router}
 */
export function bookmarkRoutes(bookmarks) {
  const router = Router();

  /** GET /bookmarks/:videoId - {bookmarks: [{id, atSec, label, created}]}. */
  router.get("/bookmarks/:videoId", (req, res) => {
    res.json({ bookmarks: bookmarks.list(req.user, videoId(req.params.videoId)) });
  });

  /** POST /bookmarks/:videoId - body {atSec, label?}; 201 {bookmark}. */
  router.post("/bookmarks/:videoId", (req, res) => {
    res.status(201).json({ bookmark: bookmarks.add(req.user, videoId(req.params.videoId), req.body) });
  });

  return router;
}
```

Mount it in `src/routes/index.js` **after** `express.json()` (it needs the parsed body) and before the final
`notFoundHandler`: `api.use(bookmarkRoutes(bookmarks));`. Place it before `authenticate` only for routes that
must work signed out.

### 5. Test: `test/bookmarks.test.js`

`startApp()` runs the real app on a random port with an in-memory database, so a test covers every layer.

```js
/* bookmarks.test.js - /api/v1/bookmarks. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, VID } from "./helpers.js";

let t;
before(async () => {
  t = await startApp();
  await t.post("/api/v1/playlists", { name: "Course", videos: [{ id: VID(1) }] });
});
after(() => t.close());

test("bookmarks: add, list in time order, validation and membership", async () => {
  assert.equal((await t.post(`/api/v1/bookmarks/${VID(1)}`, { atSec: 90, label: "proof" })).status, 201);
  await t.post(`/api/v1/bookmarks/${VID(1)}`, { atSec: 30 });
  const list = (await t.get(`/api/v1/bookmarks/${VID(1)}`)).json.bookmarks;
  assert.deepEqual(
    list.map((b) => b.atSec),
    [30, 90]
  );
  assert.equal((await t.post(`/api/v1/bookmarks/${VID(1)}`, { atSec: -1 })).status, 400);
  assert.equal((await t.post(`/api/v1/bookmarks/${VID(2)}`, { atSec: 1 })).status, 403);
});
```

### 6. Finish

Run `npm test`, `npm run lint` and `npm run format:check`, add the endpoint to the table above, and give every new
file its header and every exported function its doc comment.
