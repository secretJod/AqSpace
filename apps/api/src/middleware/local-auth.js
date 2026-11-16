/* local-auth.js - who is making this request? (the authentication seam)

   What:  every /api/v1 route (except /health) runs `authenticate(req, res, next)` and may rely
          on `req.user = { id, name }` afterwards. All data access is scoped by req.user.id.
          AUTH_MODE=local (default): a single built-in local user (id 1), localAuth below.
          AUTH_MODE=google: middleware/google-auth.js (server-side sessions, 401 code "auth_required").
   How it fits: app.js passes `deps.authenticate || google.authenticate || localAuth` to routes/index.js.

   To plug in another sign-in system, pass a different authenticator to createApp(config, { authenticate }):
     - read the session cookie / bearer token the OAuth app issued and verify it,
     - map the subject to a row with repo.upsertExternalUser(sub, name, email),
     - set req.user = { id, name } or call next(new HttpError(401, "Sign in required.")).
   Nothing else in the code needs to change.
   Read next: routes/index.js */

/** The single built-in user of AUTH_MODE=local. Row id 1 is created by sql/001_init.sql. */
export const LOCAL_USER = { id: 1, name: "local" };

/**
 * Authenticator for AUTH_MODE=local: every request is the built-in local user.
 * Safe only because the API listens on loopback and hostGuard/cors refuse other sites.
 *
 * @param {import("express").Request} req  gets req.user = LOCAL_USER
 */
export function localAuth(req, _res, next) {
  req.user = LOCAL_USER;
  next();
}
