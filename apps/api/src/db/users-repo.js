/* users-repo.js - users and their sign-in sessions.

   What:  getUser(), profile(), upsertExternalUser() (Google sign-in) and the server-side
          session rows (createSession / sessionUser / deleteSession, migration 004).
   How it fits: part of the repository object built in db/repository.js; used by
          middleware/google-auth.js and routes/me.js.
   Read next: middleware/auth.js */
import crypto from "node:crypto";
import { tx } from "./database.js";

/** Every table keyed by a user id (sessions excluded). Add new user-owned tables here (#151 claim). */
export const USER_KEYED = [["playlists", "user_id"], ["watch_progress", "user_id"], ["notes_jobs", "requested_by"], ["smart_runs", "requested_by"]];

export function createUsersRepo(db) {
  // -------------------------------------------------------------------------
  // 1. Reading
  // -------------------------------------------------------------------------

  const getUser = (id) => db.prepare("SELECT id, name, email, picture, external_id, bootstrapped_at FROM users WHERE id = ?").get(id) || null;

  /** Public profile shape shared by /me and /auth/status (#151). */
  const profile = (u) => ({ id: u.id, name: u.name, email: u.email ?? null, picture: u.picture ?? null });

  // -------------------------------------------------------------------------
  // 2. Google sign-in
  // -------------------------------------------------------------------------

  /** Find or create the user for an external subject, refreshing name/email/picture. Returns the user id.
      #151: the first external user ever created (when no external user existed before) takes ownership of everything
      that belonged to the built-in local user (id 1), in the same transaction, exactly once. */
  function upsertExternalUser(externalId, name, email, picture = null) {
    let claimed = null;
    const id = tx(db, () => {
      const existing = db.prepare("SELECT id FROM users WHERE external_id = ?").get(externalId);
      if (existing) {
        db.prepare("UPDATE users SET name = ?, email = ?, picture = ? WHERE id = ?").run(name, email ?? null, picture ?? null, existing.id);
        return existing.id;
      }
      const first = !db.prepare("SELECT 1 FROM users WHERE external_id IS NOT NULL LIMIT 1").get();
      const uid = Number(db.prepare("INSERT INTO users (external_id, name, email, picture) VALUES (?, ?, ?, ?)").run(externalId, name, email ?? null, picture ?? null).lastInsertRowid);
      if (first && db.prepare("SELECT 1 FROM users WHERE id = 1 AND external_id IS NULL").get()) {
        claimed = {};
        for (const [t, c] of USER_KEYED) claimed[t] = Number(db.prepare(`UPDATE ${t} SET ${c} = ? WHERE ${c} = 1`).run(uid).changes);
        db.prepare("UPDATE users SET bootstrapped_at = (SELECT bootstrapped_at FROM users WHERE id = 1) WHERE id = ?").run(uid);
        db.prepare("UPDATE users SET bootstrapped_at = NULL WHERE id = 1").run();
      }
      return uid;
    });
    if (claimed) console.log(`[aq-api] first Google user ${id} claimed the local user's data: ${Object.entries(claimed).map(([k, n]) => `${k}=${n}`).join(" ")}`);
    return id;
  }

  // -------------------------------------------------------------------------
  // 3. Sessions (AUTH_MODE=google, #14): the cookie holds a random token, only its sha256 is stored
  // -------------------------------------------------------------------------

  const sha = (tok) => crypto.createHash("sha256").update(String(tok)).digest("hex");

  /** Creates a session and returns the opaque token for the cookie. Expired rows are swept on the way. */
  function createSession(userId, now, maxAgeMs) {
    const token = crypto.randomBytes(32).toString("base64url");
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    db.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha(token), userId, now, now + maxAgeMs);
    return token;
  }

  /** Returns the user id for a live session token, or null. */
  function sessionUser(token, now) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = db.prepare("SELECT user_id FROM sessions WHERE id = ? AND expires_at > ?").get(sha(token), now);
    return row ? row.user_id : null;
  }

  function deleteSession(token) { if (typeof token === "string") db.prepare("DELETE FROM sessions WHERE id = ?").run(sha(token)); }

  return { getUser, profile, upsertExternalUser, createSession, sessionUser, deleteSession };
}
