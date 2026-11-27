/* assistant.js - /api/v1/ai/ask : ask a question and get an answer from your own notes, with links to the lectures.

   What:  POST /ai/ask {question, playlistId?} -> {answer, found, citations, usedNotes, provider}
   Safety: heavy rate limit (each call spends the user's provider quota); answers are never cached;
          the question is never logged.
   How it fits: mounted in routes/index.js; the logic lives in services/assistant-service.js.
   Read next: services/assistant-service.js */
import { Router } from "express";

/**
 * @param {object} assistant  the assistant service (services/assistant-service.js)
 * @param {import("express").RequestHandler} heavyLimiter  rate limit for calls that use a language model
 * @returns {import("express").Router}
 */
export function assistantRoutes(assistant, heavyLimiter) {
  const router = Router();

  /**
   * POST /ai/ask {question: 1-500 chars, playlistId?: slug}
   * -> 200 {answer, found, citations: [{videoId, title, heading, startSec, url}], usedNotes, provider}.
   * With no ready notes: 200 with found false (no model call).
   * Errors: 400 bad input, 404 unknown playlist, 409 ai_key_required, 422 {error, kind} key or quota problem,
   * 429 busy, 502 py_offline.
   */
  router.post("/ai/ask", heavyLimiter, async (req, res) => {
    // Answers quote the user's private notes: never let a browser or proxy keep them.
    res.set("Cache-Control", "no-store");
    res.json(await assistant.ask(req.user, req.body));
  });

  return router;
}
