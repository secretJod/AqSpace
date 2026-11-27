-- Live notes preview: how many notebook pages (sections) the worker has finished so far for a running job.
-- The UI shows those pages (draft.html) to the job's owner while the rest is still being written.
-- Applied by src/db/database.js (ordered, recorded in schema_migrations).

ALTER TABLE notes_jobs ADD COLUMN pages INTEGER NOT NULL DEFAULT 0;
