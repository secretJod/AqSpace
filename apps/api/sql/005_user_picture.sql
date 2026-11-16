-- #151: the signed-in Google account's profile photo URL (the id_token `picture` claim), refreshed on every sign-in.
-- NULL for the built-in local user. Applied by src/db.js (ordered, recorded in schema_migrations).
ALTER TABLE users ADD COLUMN picture TEXT;
