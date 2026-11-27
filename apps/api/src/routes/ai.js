/* ai.js - /api/v1/ai : the signed-in user's own AI keys (connected providers and which AI does which task).

   What:  GET    /ai                          providers (+ connected/last4/status/serverKey) and tasks (+ ready)
          PUT    /ai/keys/:provider  {key}    test via the worker, then save encrypted   (heavy rate limit)
          POST   /ai/keys/:provider/test      re-test the saved key                      (heavy rate limit)
          DELETE /ai/keys/:provider           forget the key (204)
          PUT    /ai/tasks/:task  {provider}  choose the provider for a task (null = default)
   Safety: keys only travel in request bodies (never URLs) and are never sent back (only last4).
   How it fits: mounted in routes/index.js; the logic lives in services/ai-keys-service.js.
   Read next: services/ai-keys-service.js */
import { Router } from "express";

/**
 * @param {object} ai  the AI keys service (services/ai-keys-service.js)
 * @param {import("express").RequestHandler} heavyLimiter  rate limit for anything that tests a key
 * @returns {import("express").Router}
 */
export function aiRoutes(ai, heavyLimiter) {
  const router = Router();
  // Responses here describe a user's credentials: never let anything cache them.
  router.use("/ai", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  /** GET /ai - {providers: [...], tasks: {notes, smart, assistant, doubts}} for the signed-in user. */
  router.get("/ai", async (req, res) => {
    res.json(await ai.overview(req.user));
  });

  /** PUT /ai/keys/:provider {key} - test, then save encrypted. 400 {error, kind} when the key does not work. */
  router.put("/ai/keys/:provider", heavyLimiter, async (req, res) => {
    res.json(await ai.saveKey(req.user, req.params.provider, req.body));
  });

  /** POST /ai/keys/:provider/test - re-test the saved key; status becomes "ok" or "failing". */
  router.post("/ai/keys/:provider/test", heavyLimiter, async (req, res) => {
    res.json(await ai.retestKey(req.user, req.params.provider));
  });

  /** DELETE /ai/keys/:provider - forget the key (204, also when there was none). */
  router.delete("/ai/keys/:provider", (req, res) => {
    ai.deleteKey(req.user, req.params.provider);
    res.status(204).end();
  });

  /** PUT /ai/tasks/:task {provider} - choose the provider for a task; null or "" = back to the default. */
  router.put("/ai/tasks/:task", async (req, res) => {
    res.json(await ai.setTaskProvider(req.user, req.params.task, req.body));
  });

  return router;
}
