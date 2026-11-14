/* server.js - the entry point (`npm start` runs `node src/server.js`).

   What:  loads the config, builds the app and listens on 127.0.0.1:<PORT> (default 5180).
          Ctrl+C / SIGTERM closes the server and the database cleanly.
   How it fits: everything else is assembled in app.js.
   Read next: config/load-config.js, then app.js */
import { loadConfig } from "./config/load-config.js";
import { createApp } from "./app.js";

// ---------------------------------------------------------------------------
// 1. Start
// ---------------------------------------------------------------------------

const config = loadConfig();
const app = createApp(config);

const server = app.listen(config.port, config.host, () => {
  console.log(`AQ API + UI on http://${config.host}:${config.port}/  (notes service: ${config.pyUrl})`);
});

server.on("error", (e) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${config.port} is already in use (set PORT).` : e.message);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// 2. Stop
// ---------------------------------------------------------------------------

function stop() {
  server.close(() => {
    try { app.locals.db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();   // do not wait forever for open connections
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
