/* ui-static.js - serves the web UI (lecture-notes-ui) on the same origin as the API.

   What:  a filter that only lets through GET/HEAD for web asset files, then express.static.
          Only what the UI loads is served: html, css, js (incl. vendored Chart.js), images, fonts.
          Dot-files, folders starting with "_" (e.g. _landing-backup), tooling/docs (package.json,
          package-lock.json, eslint.config.mjs, README.md, any .json/.txt/.md/.mjs) and the
          screenshots/, node_modules/, test(s)/ folders are 404 (#158).
   How it fits: mounted in app.js after the API, only when config.uiDir exists.
   Read next: middleware/error-handler.js */
import express from "express";
import path from "node:path";
import { HttpError } from "../utils/http-errors.js";

const ALLOWED_FILE_RE = /\.(html|js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf)$/i;
/** Tooling files that match an allowed extension (e.g. *.config.js) and folders the UI never loads from. */
const DENIED_FILE_RE = /^(eslint|prettier|vite|webpack|rollup|playwright|jest|vitest)\.config\.[a-z]+$/i;
const DENIED_DIRS = new Set(["node_modules", "screenshots", "test", "tests", "scripts"]);

/** Returns two middlewares: [filter, static file server]. */
export function uiStaticRoutes(uiDir) {
  const root = path.resolve(uiDir);

  function onlyWebAssets(req, _res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next(new HttpError(405, "Method not allowed."));
    const filePath = req.path === "/" ? "/index.html" : req.path;
    const parts = filePath.split("/");
    const hiddenPart = parts.some((part) => part.startsWith(".") || part.startsWith("_") || DENIED_DIRS.has(part.toLowerCase()));
    const deniedFile = DENIED_FILE_RE.test(parts[parts.length - 1]);
    if (hiddenPart || deniedFile || !ALLOWED_FILE_RE.test(filePath)) return next(new HttpError(404, "Not found."));
    next();
  }

  const serveFiles = express.static(root, { index: "index.html", dotfiles: "ignore", etag: true, maxAge: 0, redirect: false, fallthrough: true });

  return [onlyWebAssets, serveFiles];
}
