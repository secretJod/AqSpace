/* auth-status.js - GET /api/v1/auth/status  (no login needed)

   What:  tells the UI whether someone is signed in:
          { authMode: "local"|"google", signedIn, user: {id, name, email, picture} | null, loginUrl }.
   How it fits: mounted in routes/index.js before the authentication middleware.
          resolveUser(req) returns the signed-in user id or null (google-auth's currentUser, or the local user).
   Read next: routes/me.js */
import { Router } from "express";

const LOGIN_URL = "/api/v1/auth/google/login";

/**
 * @param {object} repo  the repository (getUser, profile)
 * @param {"local" | "google"} authMode
 * @param {(req) => number | null} resolveUser  the signed-in user id for a request, or null
 * @returns {import("express").Router}
 */
export function authStatusRoutes(repo, authMode, resolveUser) {
  const router = Router();
  /** GET /auth/status - {authMode, signedIn, user, loginUrl}. Never fails with 401: signed out is a normal answer. */
  router.get("/auth/status", (req, res) => {
    const uid = resolveUser(req);
    const user = uid ? repo.getUser(uid) : null;
    res.json({ authMode, signedIn: !!user, user: user ? repo.profile(user) : null, loginUrl: LOGIN_URL });
  });
  return router;
}
