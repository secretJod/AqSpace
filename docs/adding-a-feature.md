# Adding a feature

Most user-facing features touch more than one app. This guide shows how a change travels through the stack, gives a
checklist to work from, and walks through one feature end to end. Read [architecture.md](architecture.md) first if
you have not yet.

## How a feature spans the apps

```
apps/web     a control or screen; calls AQ.api.request(...) and nothing else
   |
apps/api     route -> (service) -> repository -> SQLite migration
   |         a service also calls the worker through services/worker-client.js
apps/worker  only when the feature needs transcripts, a language model or rendering
```

- The browser never talks to the worker. Every new capability is reached through `/api/v1` on the API.
- Data that belongs to a user lives in the API's SQLite database, scoped by `req.user.id`.
- The worker is stateless apart from job files and caches. It holds no user data and knows nothing about sign-in.
- Many features need only the web app and the API. Touch the worker only when the work is transcripts, model calls
  or rendering.

## Checklist

Work from the contract down to the data, then back up to the screen.

1. **Contract first.** Write down the HTTP shape before any code: method, path, request body, reply, error codes.
   Existing public shapes (`/api/v1/*` and the worker's `/api/*`) do not change; add new paths or optional fields.
   If the worker is involved, agree its endpoint too, as in
   [smart-playlist-contract.md](../apps/worker/docs/smart-playlist-contract.md).
2. **Migration.** Add the next `apps/api/sql/NNN_name.sql`. Never edit a migration that has shipped.
3. **Repository.** A new `apps/api/src/db/<feature>-repo.js`, spread into the object in `src/db/repository.js`.
4. **Service** (only if there are rules beyond storage, or worker calls): `apps/api/src/services/<feature>-service.js`,
   created in `src/app.js`.
5. **Route.** `apps/api/src/routes/<feature>.js`, mounted in `src/routes/index.js`. Keep it thin.
6. **Worker** (only if needed): the module in `notes_engine/` and the route in `backend/app/routes.py`, with tests.
7. **UI.** The feature file under `apps/web/js/features/`, styles in `apps/web/css/`, linked from `index.html`.
8. **Tests.** An API test in `apps/api/test/` covers every API layer at once. Worker changes get a pytest. UI changes
   are checked in the browser (console free of errors, keyboard, reduced motion).
9. **Docs.** The endpoint tables in the app READMEs, and this folder if the architecture changed.

## Worked example: rate a notebook from 1 to 5

A signed-in user gives the notes of a video one to five stars. The rating is personal: each user sees their own.
No worker change is needed.

### 1. Contract

| Method and path | Body | Reply |
|---|---|---|
| `GET /api/v1/notes/:videoId/rating` | | `{stars}`: 1 to 5, or `null` when not rated |
| `PUT /api/v1/notes/:videoId/rating` | `{stars}` | `{stars}` |

Errors: 400 for a bad video id or a value that is not a whole number from 1 to 5; 403 when the video is not in one of
the user's playlists (the same rule notes use).

### 2. Migration: `apps/api/sql/006_notebook_ratings.sql`

```sql
-- One rating (1-5 stars) per user for the notes of a video. Applied by src/db/database.js.
CREATE TABLE notebook_ratings (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id    TEXT NOT NULL REFERENCES videos(id),
  stars       INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, video_id)
);
```

The table is keyed by user, so also add `["notebook_ratings", "user_id"]` to `USER_KEYED` in
`apps/api/src/db/users-repo.js`. That way the first Google user takes over the ratings made in local mode.

### 3. Repository: `apps/api/src/db/ratings-repo.js`

```js
/* ratings-repo.js - each user's 1-5 star rating of a video's notes.

   What:  read and store one rating per user and video.
   How it fits: part of the repository object (db/repository.js); used by routes/ratings.js.
   Read next: routes/ratings.js */
import { nowIso } from "../utils/time.js";

/** @param {import("node:sqlite").DatabaseSync} db */
export function createRatingsRepo(db) {
  /** The user's stars for a video, or null when there is no rating. */
  function getRating(userId, videoId) {
    const row = db
      .prepare("SELECT stars FROM notebook_ratings WHERE user_id = ? AND video_id = ?")
      .get(userId, videoId);
    return row ? row.stars : null;
  }

  /** Stores the rating (stars already validated), replacing an earlier one, and returns it. */
  function setRating(userId, videoId, stars) {
    db.prepare(
      `INSERT INTO notebook_ratings (user_id, video_id, stars, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, video_id) DO UPDATE SET stars = excluded.stars, updated_at = excluded.updated_at`
    ).run(userId, videoId, stars, nowIso());
    return stars;
  }

  return { getRating, setRating };
}
```

Then add it to `createRepo` in `apps/api/src/db/repository.js`:

```js
const ratings = createRatingsRepo(db);
return { /* ... */ ...ratings };
```

The video row already exists, because the route only accepts videos that are in one of the user's playlists.

### 4. Route: `apps/api/src/routes/ratings.js`

The only rule besides storage is the membership check, which the repository already offers (`userHasVideo`), so
this feature skips the service layer, like playlists and progress do.

```js
/* ratings.js - /api/v1/notes/:videoId/rating : the user's star rating of a video's notes.

   How it fits: mounted in routes/index.js after the JSON parser; storage in db/ratings-repo.js.
   Read next: db/ratings-repo.js */
import { Router } from "express";
import { HttpError, bad } from "../utils/http-errors.js";
import { isObj, videoId } from "../utils/validate.js";

/**
 * @param {object} repo  the repository (getRating, setRating, userHasVideo)
 * @returns {import("express").Router}
 */
export function ratingRoutes(repo) {
  const router = Router();

  /** Validates the id and checks that the video is in one of the user's playlists (403 otherwise). */
  function ownVideo(req) {
    const id = videoId(req.params.videoId);
    if (!repo.userHasVideo(req.user.id, id)) throw new HttpError(403, "Add this video to one of your playlists first.");
    return id;
  }

  /** GET /notes/:videoId/rating - {stars}: 1-5, or null when not rated. */
  router.get("/notes/:videoId/rating", (req, res) => {
    res.json({ stars: repo.getRating(req.user.id, ownVideo(req)) });
  });

  /** PUT /notes/:videoId/rating - body {stars: 1-5}; returns {stars}. */
  router.put("/notes/:videoId/rating", (req, res) => {
    const id = ownVideo(req);
    const stars = isObj(req.body) ? req.body.stars : undefined;
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw bad("stars must be a whole number from 1 to 5.");
    res.json({ stars: repo.setRating(req.user.id, id, stars) });
  });

  return router;
}
```

Mount it in `apps/api/src/routes/index.js` after `express.json(...)` and before `notFoundHandler`:
`api.use(ratingRoutes(repo));`. Its paths do not clash with `routes/notes.js`, which has no `/rating` route.

### 5. Test: `apps/api/test/ratings.test.js`

`startApp()` from `test/helpers.js` runs the real app on a random port with an in-memory database and a mock worker,
so one test exercises the migration, repository and route together.

```js
/* ratings.test.js - /api/v1/notes/:videoId/rating. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, VID } from "./helpers.js";

let t;
before(async () => {
  t = await startApp();
  await t.post("/api/v1/playlists", { name: "Course", videos: [{ id: VID(1) }] });
});
after(() => t.close());

test("ratings: unrated, set, replace, validation and membership", async () => {
  assert.equal((await t.get(`/api/v1/notes/${VID(1)}/rating`)).json.stars, null);
  assert.equal((await t.put(`/api/v1/notes/${VID(1)}/rating`, { stars: 4 })).json.stars, 4);
  await t.put(`/api/v1/notes/${VID(1)}/rating`, { stars: 2 });
  assert.equal((await t.get(`/api/v1/notes/${VID(1)}/rating`)).json.stars, 2);
  assert.equal((await t.put(`/api/v1/notes/${VID(1)}/rating`, { stars: 6 })).status, 400);
  assert.equal((await t.put(`/api/v1/notes/${VID(1)}/rating`, { stars: 3.5 })).status, 400);
  assert.equal((await t.put(`/api/v1/notes/${VID(2)}/rating`, { stars: 3 })).status, 403);
});
```

Run `npm --prefix apps/api test`. `test/migrations.test.js` also checks that the new migration applies cleanly.

### 6. Web control: stars in the notes panel

The notes panel header is built in `mount()` of `apps/web/js/features/notes/notes-view.js`. Add a small star control
next to the "Download PDF" link. Use real buttons, `textContent` only, and `AQ.api.request` for the network.

```js
/** A row of five star buttons that loads and saves the user's rating for `videoId`. */
function ratingControl(videoId) {
  var group = el("div", "nview__rating");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Rate these notes");
  var buttons = [];

  function paint(stars) {
    buttons.forEach(function (b, i) {
      b.setAttribute("aria-pressed", String(i < stars));
    });
  }

  for (var i = 1; i <= 5; i++) {
    var b = el("button", "nview__star", "★");
    b.type = "button";
    b.setAttribute("aria-label", i + (i === 1 ? " star" : " stars"));
    b.addEventListener("click", save.bind(null, i));
    buttons.push(b);
    group.appendChild(b);
  }

  function save(stars) {
    paint(stars); // optimistic; the server answer below confirms it
    AQ.api.request("PUT", "/api/v1/notes/" + videoId + "/rating", { stars: stars }).then(function (res) {
      if (res.status === 200) paint(res.json.stars);
    });
  }

  if (AQ.api.available()) {
    AQ.api.request("GET", "/api/v1/notes/" + videoId + "/rating").then(function (res) {
      if (res.status === 200) paint(res.json.stars || 0);
    });
  }
  return group;
}
```

In `mount()`, add `actions.insertBefore(ratingControl(video.id), pdfLink);` once the actions are in place. Style
`.nview__rating` and `.nview__star` (with `[aria-pressed="true"]` for a filled star) next to the other `.nview__`
rules in `apps/web/css/styles.css`, with a visible focus ring.

Check it in the browser: open a playlist, open the notes of a video, click a star, reload, and confirm the rating
stays. Tab to the stars with the keyboard and check that the browser console shows no errors.

### 7. Docs

Add both endpoints to the endpoint table in [apps/api/README.md](../apps/api/README.md).

## Conventions

**Comments.** Every file starts with a short header: what it is for, who calls it, and what to read next. Every
exported function and every route has a doc comment (JSDoc or a Python docstring) with its inputs, output and errors.
Comment the *why*: limits, security decisions, rules that are not obvious from the code. Do not leave commented-out
code or debug logging behind.

**Naming.** Group code by feature first. One concept per file, named for what it does: `ratings-repo.js`,
`notes-service.js`, `transcripts/chunking.py`. In the web app every file adds one public object to `window.AQ`, and
CSS classes share a short feature prefix (`nview__`, `lib__`). Migrations are `NNN_what_it_adds.sql`.

**Lint, format and test.** From the repository root:

```bash
npm test               # API tests and worker tests
npm run lint           # ESLint (api, web) and Ruff (worker)
npm run format:check   # Prettier (api, web) and Ruff format (worker)
```

To fix formatting: `npm --prefix apps/api run format`, `npm --prefix apps/web run format`, and
`apps/worker/.venv/bin/ruff format apps/worker`. Editor settings are in `.editorconfig`. CI runs the same checks on
every push.

**Secrets.** Keys and secrets come only from `.env` files and are never logged or returned. Run
`scripts/secret-scan.sh` before pushing.

**Commits.** Conventional commits with the app as the scope, one logical change each:

```
feat(api): add notebook ratings
feat(web): rate notes from the notes panel
fix(worker): keep glossary order stable
docs: describe the rating endpoints
```

## Per-app guides

Each app README has its own "How to add a feature" section with a worked example in that app:

- [apps/api/README.md](../apps/api/README.md#how-to-add-a-feature): video bookmarks (migration, repository, service,
  route, test).
- [apps/worker/README.md](../apps/worker/README.md#how-to-add-a-feature): a new AI provider, and a new notes block
  type.
- [apps/web/README.md](../apps/web/README.md#how-to-add-a-feature): a Notes library screen with a nav item.
