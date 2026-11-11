# ADR-0002: aq-api database: stay on SQLite, move to Postgres on a named trigger

- Status: Accepted
- Date: 2026-10-25
- Decider: scaling-lead (card #6)

## Context

aq-api stores everything in one SQLite file through Node's built-in `node:sqlite` (`DatabaseSync`, which is synchronous): `aq-api/data/aq.db`, bind-mounted into the container from `./aq-api/data`. `src/db.js` sets WAL, `synchronous=NORMAL` and `busy_timeout=5000`, runs the `sql/*.sql` migrations inside a transaction, and its `tx()` helper uses `BEGIN IMMEDIATE`. All SQL lives in `src/repo.js` and `src/notes-service.js`, and every query is scoped by `userId`.

Today everything runs on one machine. `docker compose` starts a single aq-api process that shares a network namespace with `notes-ai`, published on `127.0.0.1:5180` and optionally exposed through a Cloudflare quick tunnel. There is one user today (local) and will be a handful of Google users after #5. Each user creates little load: playlist edits, a progress PUT every few seconds while a video plays, and notes status polls. The expensive work (transcripts, LLM calls, PDF rendering) happens in Python, not in the database.

ADR-0001 removes Postgres from the stack, so the question is whether aq-api should adopt Postgres anyway.

### Where SQLite breaks down for this app

| Limit | Why | When it bites here |
|---|---|---|
| **One writer at a time** | WAL lets reads run alongside writes, but writes take turns on a single file lock. `DatabaseSync` also blocks the Node event loop during every query. | One write takes well under a millisecond on an SSD, so even about 500 writes/s is fine. At one progress PUT every 5 s per viewer, that load only comes from hundreds to low thousands of people *watching at the same time*. It can also bite if a long transaction (a large `importState` or playlist import) holds the lock and other requests queue behind `busy_timeout`. |
| **Multiple instances** | Only processes on one host with a local filesystem can safely write the file. That rules out NFS/EFS/SMB and two containers on two hosts. | As soon as we want 2+ aq-api replicas (high availability, rolling deploys, horizontal scaling), SQLite stops working. |
| **Hosting** | It needs a persistent local disk. Serverless and ephemeral platforms (Cloud Run, Vercel, Heroku dynos, most PaaS free tiers) lose the file on restart. | Fine on any single box with a disk (laptop, one VPS, a Fly.io machine with a volume). Not fine on a PaaS without volumes. |
| **Ops** | Backup means copying the file or running `VACUUM INTO`. There is no point-in-time recovery, managed failover or remote admin console. | Matters once the data holds work people would be upset to lose (#16 adds backups). |

## Options

1. **Stay on SQLite (`node:sqlite`).** *(chosen for now)*
   - Pro: no extra container, RAM or config. The file stays in the repo (storage rule). The 32 tests run fast against in-memory SQLite. Synchronous code is simple to reason about. One box has plenty of headroom.
   - Con: a single host and a single writer, the event loop blocks under heavy load, and there is no managed failover.
2. **Postgres now** (reuse the `db` service).
   - Pro: ready for multiple instances, managed hosting is available everywhere, real concurrent writes, point-in-time recovery.
   - Con: every repo call becomes async, which means rewriting repo.js, notes-service.js, the routes and the tests. Tests would need a real Postgres or pg-mem. It keeps the container ADR-0001 removes, and no current user benefits.
3. **SQLite plus replication or an edge layer (Litestream, LiteFS, Turso/libSQL).**
   - Pro: backups off the machine (Litestream) or read replicas.
   - Con: LiteFS and Turso add a vendor or a FUSE layer and still have a single primary writer, so they don't solve concurrent writes. Litestream is a reasonable backup add-on later, not a scaling answer.

## Decision

**Stay on SQLite**, and keep the code portable so the move is mechanical when it comes:
- All SQL stays in `repo.js` and `notes-service.js` (card #15). Routes never touch `db`.
- New migrations use portable SQL where it exists. The SQLite-only features already in use are documented next to their Postgres equivalents (#15).
- Measure lock contention (#16) so the trigger is based on data, not a guess.

### Migration trigger: move to Postgres when ANY of these is true

1. We need **more than one aq-api instance** (high availability, zero-downtime deploys or horizontal scaling).
2. We deploy to a host **without a persistent local disk**.
3. Real traffic produces sustained **SQLITE_BUSY errors or transaction waits over 100 ms** in #16's logs, or p95 write latency on the progress PUT goes above 50 ms (roughly a few hundred people watching at the same time).
4. We need **managed backups or point-in-time recovery** for real users' data, beyond what `VACUUM INTO` + Litestream provide.

When a trigger fires, scaling-lead writes a new ADR that supersedes this one. The port is then: an async repo layer over `pg` with the same function signatures, translated migrations, a one-shot SQLite-to-Postgres copy script, and Postgres bind-mounted at `./.data/pgdata` per `.claude/rules/storage.md`.

## Consequences

- Production stays one box: a laptop or VPS running Docker, or one VM with a volume. That covers the current roadmap (OAuth with user-scoped rows, multi-device sync).
- #5's sessions go in SQLite too (#14), so there is one store.
- The cost of switching later is limited: about 330 lines of `repo.js` plus notes-service made async, and a small schema (users, videos, playlists, playlist_videos, watch_progress, notes).
- Risk: synchronous queries block the event loop. That is acceptable at this size, and #16's logging is the early warning.

## Follow-ups

| Card | Role | What |
|---|---|---|
| #14 | web-dev-3 | SQLite sessions table for Google auth |
| #15 | web-dev-2 | Keep SQL in the repo layer, document SQLite-only features and their Postgres equivalents |
| #16 | web-dev-1 | Backup script writing to `./.data/backups`, plus SQLITE_BUSY / slow-transaction logging |
