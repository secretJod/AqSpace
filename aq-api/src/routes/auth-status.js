/* auth-status.js - GET /api/v1/auth/status  (no login needed, #151)

   What:  tells the UI whether someone is signed in:
          { authMode: "local"|"google", signedIn, user: {id, name, email, picture} | null, loginUrl }.
   How it fits: mounted in routes/index.js before the authentication middleware.
          resolveUser(req) returns the signed-in user id or null (google-auth's currentUser, or the local user).
   Read next: routes/me.js */
import { Router } from "express";

export const LOGIN_URL = "/api/v1/auth/google/login";

export function authStatusRoutes(repo, authMode, resolveUser) {
  const router = Router();
  router.get("/auth/status", (req, res) => {
    const uid = resolveUser(req);
    const user = uid ? repo.getUser(uid) : null;
    res.json({ authMode, signedIn: !!user, user: user ? repo.profile(user) : null, loginUrl: LOGIN_URL });
  });
  return router;
}
