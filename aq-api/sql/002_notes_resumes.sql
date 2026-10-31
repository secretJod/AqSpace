-- R5 / #30: how many times aq-api re-submitted this record's video after the Python service lost the job (restart).
-- Python resumes from its per-video chunk checkpoints; the count caps automatic resumes so a crash loop ends in a clear error.
ALTER TABLE notes_jobs ADD COLUMN resumes INTEGER NOT NULL DEFAULT 0;
