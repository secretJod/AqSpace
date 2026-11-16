/* time.js - the one way the API writes a timestamp into the database.

   What:  nowIso() returns the current time as ISO-8601 UTC text, the format of every
          *_at column (see sql/001_init.sql).
   How it fits: used by the repository files in db/ and by the job services in services/.
   Read next: db/playlist-helpers.js */

/**
 * The current time as ISO-8601 UTC text, e.g. "2026-01-31T12:00:00.000Z".
 *
 * @returns {string}
 */
export const nowIso = () => new Date().toISOString();
