-- Notes belong to the user who made them. Applied by src/db/database.js (ordered, recorded in schema_migrations).
-- notes_jobs gets an owner (user_id) and the "one live job" rule becomes per (user, video): two users can make
-- notes for the same video independently, and nobody sees another user's jobs. SQLite cannot add a NOT NULL
-- foreign-key column in place, so the table is rebuilt. Existing rows go to whoever requested them; rows whose
-- requester is unknown go to the built-in local user (id 1), whose data the first Google account claims.

CREATE TABLE notes_jobs_new (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- the owner: only this user sees the job
  video_id      TEXT NOT NULL REFERENCES videos(id),
  job_id        TEXT,                        -- the Python service's job id (32 hex chars)
  status        TEXT NOT NULL CHECK (status IN ('queued','running','done','error','expired')),
  pct           INTEGER NOT NULL DEFAULT 0,
  stage         TEXT NOT NULL DEFAULT '',
  message       TEXT NOT NULL DEFAULT '',
  error         TEXT NOT NULL DEFAULT '',
  requested_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  checked_at    INTEGER NOT NULL DEFAULT 0,  -- epoch ms of the last contact with the Python service
  resumes       INTEGER NOT NULL DEFAULT 0   -- automatic re-submissions after the Python service lost the job
);

INSERT INTO notes_jobs_new
  (id, user_id, video_id, job_id, status, pct, stage, message, error, requested_by, created_at, updated_at, checked_at, resumes)
SELECT id, COALESCE(requested_by, 1), video_id, job_id, status, pct, stage, message, error, requested_by,
       created_at, updated_at, checked_at, resumes
FROM notes_jobs;

DROP TABLE notes_jobs;
ALTER TABLE notes_jobs_new RENAME TO notes_jobs;

-- At most one queued/running/done row per user and video; error / expired rows stay as history.
CREATE UNIQUE INDEX notes_one_live_job ON notes_jobs (user_id, video_id) WHERE status IN ('queued','running','done');
CREATE INDEX notes_user_video ON notes_jobs (user_id, video_id, id);
CREATE INDEX notes_video ON notes_jobs (video_id, id);
