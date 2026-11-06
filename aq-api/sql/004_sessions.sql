-- #14: server-side login sessions for AUTH_MODE=google. Applied by src/db.js (ordered, recorded in schema_migrations).
-- The browser cookie holds a random 256-bit token; only its sha256 is stored here, so a leaked database cannot be replayed
-- as a cookie. Logout deletes the row (real revocation); expired rows are pruned whenever a new session is created.

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,              -- sha256(token), 64 hex chars
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,              -- epoch ms
  expires_at  INTEGER NOT NULL               -- epoch ms
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);
