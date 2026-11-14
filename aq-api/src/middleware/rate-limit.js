/* rate-limit.js - a tiny in-memory rate limiter.

   What:  rateLimit({ max, windowMs }) returns a middleware that allows `max` requests per
          client IP per window ("fixed window"), then answers 429 with Retry-After.
   How it fits: app.js builds two of them: "general" for the whole API and "heavy" for
          expensive calls (starting notes / smart runs, YouTube imports).
   Note:  no X-Forwarded-For: this service is not behind a proxy.
   Read next: middleware/request-logger.js */
import { HttpError } from "../utils/http-errors.js";

export function rateLimit({ max, windowMs }, now = Date.now) {
  const hitsByIp = new Map();                        // ip -> { n, reset }

  // Forget expired windows now and then so the map does not grow forever.
  const cleanupTimer = setInterval(() => {
    const t = now();
    for (const [ip, hits] of hitsByIp) if (hits.reset <= t) hitsByIp.delete(ip);
  }, windowMs);
  cleanupTimer.unref();                              // never keeps the process alive

  return function limiter(req, res, next) {
    const ip = req.socket.remoteAddress || "?";
    const t = now();
    let hits = hitsByIp.get(ip);
    if (!hits || hits.reset <= t) {
      hits = { n: 0, reset: t + windowMs };
      hitsByIp.set(ip, hits);
    }
    hits.n++;
    if (hits.n > max) {
      const waitSec = Math.max(1, Math.ceil((hits.reset - t) / 1000));
      res.setHeader("Retry-After", String(waitSec));
      return next(new HttpError(429, "Too many requests. Please slow down.", { retryAfter: waitSec }));
    }
    next();
  };
}
