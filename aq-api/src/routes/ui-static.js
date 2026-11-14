/* ui-static.js - serves the web UI (lecture-notes-ui) on the same origin as the API.

   What:  a filter that only lets through GET/HEAD for web asset files, then express.static.
          Dot-files, folders starting with "_" (e.g. _landing-backup), scripts and docs are 404.
   How it fits: mounted in app.js after the API, only when config.uiDir exists.
   Read next: middleware/error-handler.js */
import express from "express";
import path from "node:path";
import { HttpError } from "../utils/http-errors.js";

const ALLOWED_FILE_RE = /\.(html|js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|json|txt)$/i;

/** Returns two middlewares: [filter, static file server]. */
export function uiStaticRoutes(uiDir) {
  const root = path.resolve(uiDir);

  function onlyWebAssets(req, _res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next(new HttpError(405, "Method not allowed."));
    const filePath = req.path === "/" ? "/index.html" : req.path;
    const hiddenPart = filePath.split("/").some((part) => part.startsWith(".") || part.startsWith("_"));
    if (hiddenPart || !ALLOWED_FILE_RE.test(filePath)) return next(new HttpError(404, "Not found."));
    next();
  }

  const serveFiles = express.static(root, { index: "index.html", dotfiles: "ignore", etag: true, maxAge: 0, redirect: false, fallthrough: true });

  return [onlyWebAssets, serveFiles];
}
