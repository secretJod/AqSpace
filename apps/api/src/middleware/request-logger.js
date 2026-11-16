/* request-logger.js - one console line per request: "GET /api/v1/playlists 200 4ms".

   What:  logs method, path (no query string, no headers, no bodies), status and time.
   How it fits: app.js adds it when config.log is true (LOG=0 turns it off).
   Read next: middleware/error-handler.js */

export function requestLogger(req, res, next) {
  const startedAt = Date.now();
  if (req.path.startsWith("/dev/api/")) return next(); // tracker polling would flood the console
  res.on("finish", () =>
    console.log(`${req.method} ${req.originalUrl.split("?")[0]} ${res.statusCode} ${Date.now() - startedAt}ms`)
  );
  next();
}
