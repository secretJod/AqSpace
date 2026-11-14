/* me.js - GET /api/v1/me : the signed-in user.

   What:  returns { user: {id, name}, bootstrapped } ("bootstrapped" = the browser data was imported once).
   How it fits: mounted in routes/index.js after authentication (req.user is set).
   Read next: routes/sync.js */
import { Router } from "express";

export function meRoutes(repo) {
  const router = Router();
  router.get("/me", (req, res) => {
    const user = repo.getUser(req.user.id);
    res.json({ user: { id: user.id, name: user.name }, bootstrapped: !!user.bootstrapped_at });
  });
  return router;
}
