-- Each signed-in user's own AI provider keys (encrypted) and which provider does which task.
-- Keys belong to one user (users.id) and are only ever used for that user's notes and smart-arrange jobs.
-- They are encrypted with AES-256-GCM by src/services/key-box.js (master secret: AQ_KEY_SECRET, or else the
-- file AQ_KEY_SECRET_FILE / data/.key-secret); the ciphertext is bound to "<user_id>:<provider>", so a row
-- copied to another user cannot be decrypted. The plain key is never stored. Applied by src/db/database.js.

CREATE TABLE ai_keys (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,                 -- gemini / groq / nvidia / xai / huggingface
  ciphertext  BLOB NOT NULL,
  iv          BLOB NOT NULL,                 -- 12 random bytes per encryption
  tag         BLOB NOT NULL,                 -- GCM auth tag (16 bytes)
  last4       TEXT NOT NULL,                 -- the only part of the key ever shown again
  status      TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','failing')),
  checked_at  TEXT,                          -- last time the key was tested against the provider
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);

-- Per-user choice of the provider for a task (notes / smart / assistant / doubts). No row = the default.
CREATE TABLE ai_task_providers (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task        TEXT NOT NULL,
  provider    TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, task)
);
