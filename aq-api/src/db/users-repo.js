/* users-repo.js - reading and creating users.

   What:  getUser() and upsertExternalUser() (the second one is for the future OAuth login).
   How it fits: part of the repository object built in db/repository.js.
   Read next: middleware/auth.js */

export function createUsersRepo(db) {
  // -------------------------------------------------------------------------
  // 1. Reading
  // -------------------------------------------------------------------------

  const getUser = (id) => db.prepare("SELECT id, name, email, external_id, bootstrapped_at FROM users WHERE id = ?").get(id) || null;

  // -------------------------------------------------------------------------
  // 2. OAuth hook
  // -------------------------------------------------------------------------

  /** For the OAuth integration: find or create the user for an external subject. Returns the user id. */
  function upsertExternalUser(externalId, name, email) {
    const existing = db.prepare("SELECT id FROM users WHERE external_id = ?").get(externalId);
    if (existing) {
      db.prepare("UPDATE users SET name = ?, email = ? WHERE id = ?").run(name, email ?? null, existing.id);
      return existing.id;
    }
    return Number(db.prepare("INSERT INTO users (external_id, name, email) VALUES (?, ?, ?)").run(externalId, name, email ?? null).lastInsertRowid);
  }

  return { getUser, upsertExternalUser };
}
