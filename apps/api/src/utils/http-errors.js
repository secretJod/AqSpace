/* http-errors.js - small error helpers used everywhere in the API.

   What:  HttpError is a normal Error that also carries an HTTP status code.
   How it fits: routes and services `throw` these; the error handler
          (middleware/error-handler.js) turns them into a JSON reply.
          `expose = true` means "this message is safe to show the user".
   Read next: middleware/error-handler.js */

// ---------------------------------------------------------------------------
// 1. The error class
// ---------------------------------------------------------------------------

/** An Error with an HTTP status; its message is safe to show to the user. */
export class HttpError extends Error {
  /**
   * @param {number} status  HTTP status code (400, 404, 503, ...)
   * @param {string} message text shown to the user
   * @param {object} extra   optional extra fields, e.g. { code: "py_offline" } or { retryAfter: 6 }
   */
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.expose = true;
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------------------
// 2. Shortcuts for the most common statuses
// ---------------------------------------------------------------------------

/** 400 Bad Request. */
export const bad = (message) => new HttpError(400, message);
/** 404 Not Found. */
export const notFound = (message = "Not found.") => new HttpError(404, message);
/** 409 Conflict (e.g. a duplicate name or video). */
export const conflict = (message) => new HttpError(409, message);
