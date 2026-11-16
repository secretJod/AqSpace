/* users-repo.js - users and their sign-in sessions.

   What:  getUser(), profile(), upsertExternalUser() (Google sign-in) and the server-side
          session rows (createSession / sessionUser / deleteSession, table from sql/004_sessions.sql).
   How it fits: part of the repository object built in db/repository.js; used by
          middleware/google-auth.js, routes/me.js and routes/auth-status.js.
   Read next: middleware/local-auth.js */
import crypto from "node:crypto";
import { tx } from "./database.js";

/* Every table keyed by a user id (sessions excluded). When the first Google user claims the local user's
   data (upsertExternalUser), these are the rows that move. Add every new user-owned table here. */
const USER_KEYED = [
  ["playlists", "user_id"],
  ["watch_progress", "user_id"],
  ["notes_jobs", "user_id"],
  ["notes_jobs", "requested_by"],
  ["smart_runs", "requested_by"]
];

/**
 * Builds the user and session functions of the repository.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @returns {object} getUser, profile, upsertExternalUser, createSession, sessionUser, deleteSession
 */
export function createUsersRepo(db) {
  // -------------------------------------------------------------------------
  // 1. Reading
  // -------------------------------------------------------------------------

  /** The user row {id, name, email, picture, external_id, bootstrapped_at}, or null. */
  const getUser = (id) =>
    db.prepare("SELECT id, name, email, picture, external_id, bootstrapped_at FROM users WHERE id = ?").get(id) || null;

  /** The public profile {id, name, email, picture} returned by /me and /auth/status. */
  const profile = (u) => ({ id: u.id, name: u.name, email: u.email ?? null, picture: u.picture ?? null });

  // -------------------------------------------------------------------------
  // 2. Google sign-in
  // -------------------------------------------------------------------------

  /**
   * Finds or creates the user for an external sign-in subject (Google `sub`) and refreshes name, email and picture.
   * The very first external user takes over everything the built-in local user (id 1) owned, in the same
   * transaction and exactly once, so switching from AUTH_MODE=local to google keeps the data.
   *
   * @param {string} externalId  the provider's stable subject id
   * @param {string} name
   * @param {string | null} email
   * @param {string | null} [picture]  an https URL (already checked by the caller)
   * @returns {number} the user id
   */
  function upsertExternalUser(externalId, name, email, picture = null) {
    let claimed = null;
    const id = tx(db, () => {
      const existing = db.prepare("SELECT id FROM users WHERE external_id = ?").get(externalId);
      if (existing) {
        db.prepare("UPDATE users SET name = ?, email = ?, picture = ? WHERE id = ?").run(
          name,
          email ?? null,
          picture ?? null,
          existing.id
        );
        return existing.id;
      }
      const first = !db.prepare("SELECT 1 FROM users WHERE external_id IS NOT NULL LIMIT 1").get();
      const uid = Number(
        db
          .prepare("INSERT INTO users (external_id, name, email, picture) VALUES (?, ?, ?, ?)")
          .run(externalId, name, email ?? null, picture ?? null).lastInsertRowid
      );
      if (first && db.prepare("SELECT 1 FROM users WHERE id = 1 AND external_id IS NULL").get()) {
        claimed = {};
        for (const [t, c] of USER_KEYED)
          claimed[t] = Number(db.prepare(`UPDATE ${t} SET ${c} = ? WHERE ${c} = 1`).run(uid).changes);
        db.prepare(
          "UPDATE users SET bootstrapped_at = (SELECT bootstrapped_at FROM users WHERE id = 1) WHERE id = ?"
        ).run(uid);
        db.prepare("UPDATE users SET bootstrapped_at = NULL WHERE id = 1").run();
      }
      return uid;
    });
    if (claimed)
      console.log(
        `[aq-api] first Google user ${id} claimed the local user's data: ${Object.entries(claimed)
          .map(([k, n]) => `${k}=${n}`)
          .join(" ")}`
      );
    return id;
  }

  // -------------------------------------------------------------------------
  // 3. Sessions (AUTH_MODE=google): the cookie holds a random token and only its sha256 is stored,
  //    so a leaked database cannot be replayed as cookies, and deleting the row really logs out
  // -------------------------------------------------------------------------

  const sha = (tok) => crypto.createHash("sha256").update(String(tok)).digest("hex");

  /**
   * Creates a session and returns the opaque token for the cookie. Expired rows are swept on the way.
   *
   * @param {number} userId
   * @param {number} now       current time in ms
   * @param {number} maxAgeMs  session lifetime
   * @returns {string} a 43-character base64url token (256 random bits)
   */
  function createSession(userId, now, maxAgeMs) {
    const token = crypto.randomBytes(32).toString("base64url");
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    db.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
      sha(token),
      userId,
      now,
      now + maxAgeMs
    );
    return token;
  }

  /** The user id for a live (unexpired) session token, or null. Malformed tokens never reach the database. */
  function sessionUser(token, now) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = db.prepare("SELECT user_id FROM sessions WHERE id = ? AND expires_at > ?").get(sha(token), now);
    return row ? row.user_id : null;
  }

  /** Deletes the session of this token (logout). Unknown tokens are ignored. */
  function deleteSession(token) {
    if (typeof token === "string") db.prepare("DELETE FROM sessions WHERE id = ?").run(sha(token));
  }

  return { getUser, profile, upsertExternalUser, createSession, sessionUser, deleteSession };
}
