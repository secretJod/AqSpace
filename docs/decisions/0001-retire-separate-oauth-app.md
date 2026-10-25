# ADR-0001: Retire the separate React/Postgres OAuth app

- Status: Accepted (deleting the code needs the user's approval, card #13)
- Date: 2026-10-25
- Decider: scaling-lead (card #6)

## Context

The repo runs two unrelated apps from one `docker-compose.yml`:

| App | Pieces | Store | Used by the product? |
|---|---|---|---|
| OAuth demo (commit `412ca75`) | `backend/` (Express/TS, Google OAuth, `express-session` + `connect-pg-simple`, :4000), `frontend/` (Vite/React, :5173), `db` (postgres:16, `./.data/pgdata`) | Postgres: `users` (UUID, `google_subject`) and `session` | No. Its `/me` returns `{userId, workspaces: []}`, and nothing in aq-api or lecture-notes-ui calls it. |
| AQ Learning | `aq-api/` (:5180, Express 5, `node:sqlite`), `lecture-notes-ui/`, `lecture-notes-ai/` | SQLite `aq-api/data/aq.db` with its own `users` table (`external_id` reserved for the OAuth subject) | Yes, this is the product. |

So a user who signs in through `backend/` gets a Postgres user with no playlists, progress or notes. Those live in aq-api's SQLite and belong to user 1 (`localAuth`). The result is two user tables, two session mechanisms, two extra ports, and a Postgres container that uses RAM and startup time on a single laptop without adding anything to the product. aq-api already has the right seam: `createApp(config, {authenticate})` (`src/middleware/auth.js`) and `repo.upsertUserByExternalId`.

Card #5 (web-dev-3) moves Google OAuth into aq-api behind `AUTH_MODE=google`.

## Options

1. **Keep both and bridge them.** aq-api trusts a session or JWT issued by `backend/`.
   - Pro: no OAuth rewrite.
   - Con: two services, two databases, cross-service cookie/CORS/JWT trust, and user rows to sync between Postgres and SQLite. The most moving parts for the smallest app.
2. **Move product state into `backend/` (Postgres) and retire aq-api.**
   - Pro: one service on Postgres.
   - Con: rewrites the tested part (aq-api: playlists, progress, notes cache, Python proxy, 32 tests) to keep the untested demo (about 100 lines of auth). Wrong way round.
3. **Move OAuth into aq-api (#5) and retire `backend/`, `frontend/` and `db`.** *(chosen)*
   - Pro: one entry point (:5180), one user table, one session store, one fewer container. The auth seam was built for this. `AUTH_MODE=local` keeps today's behaviour.
   - Con: the Google flow is re-implemented (about 100 lines, using `fetch`, no new heavy dependencies), and sessions need a store in aq-api (card #14).

## Decision

Option 3. Google OAuth lives in aq-api (#5). The React app, its Express backend and the Postgres service are retired once #5 reaches Done. aq-api reuses the root `.env` names (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, session secret), so no secrets change. Google's `sub` maps to `users.external_id`. This ADR deletes no code. Removal is card #13 and needs the user's explicit OK.

## Consequences

- `docker compose up` shrinks to `notes-ai` + `aq-api` (+ the optional `tunnel`): no Postgres RAM, nothing on :4000 or :5173.
- Google Cloud console: the OAuth redirect URI moves from `backend/` on :4000 to aq-api's callback on :5180 (and to the tunnel host, if used). The user must update it, and #5 should document the exact URI.
- The existing Postgres user rows are demo data and are not migrated. `./.data/pgdata` can be deleted together with the code (#13).
- aq-api's sessions must survive restarts without Postgres, so they go in a SQLite sessions table (#14). This also matches ADR-0002.
- Until #13 merges, `backend/` and `frontend/` stay in the repo as dead code. Nobody should build on them.

## Follow-ups

| Card | Role | What |
|---|---|---|
| #5 (exists) | web-dev-3 | Google OAuth in aq-api behind `AUTH_MODE` |
| #14 | web-dev-3 | SQLite-backed session store in aq-api |
| #13 | web-dev-3 | Remove `backend/`, `frontend/`, the `db` service and pgdata handling, and update the docs (after #5 is Done and the user approves) |
