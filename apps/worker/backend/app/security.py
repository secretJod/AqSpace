"""Security for every request: local-only guard, security headers and JSON error pages.

What this file does
    ``register_security(app)`` installs:
      1. a before-request guard (DNS-rebinding protection: only local host names; POSTs and the
         playlist lookup must come from a local page)
      2. an after-request hook adding security headers (CSP, X-Frame-Options, no-store, ...)
      3. JSON error handlers for 404 / 405 / 413 / 500

Called by ``server.create_app``.

Read next
    ``providers.py``.
"""

from __future__ import annotations

from flask import Flask, Response, jsonify, request

from .settings import CSP_APP, CSP_FILE, CSP_NOTES, GENERIC_ERROR, LOCAL_HOST_RE, LOCAL_ORIGIN_RE


def register_security(app: Flask) -> None:
    """Install the request guard, the security headers and the JSON error pages on ``app``."""

    # ---- 1. Request guard ------------------------------------------------------------------
    @app.before_request
    def _guard():
        # DNS-rebinding guard: only answer to local host names
        if not LOCAL_HOST_RE.match(request.host or ""):
            return jsonify(error="Forbidden host."), 403
        origin = request.headers.get("Origin")
        # POSTs, and the GET that makes the server call out to YouTube, must come from a local page
        if (
            origin
            and (request.method == "POST" or request.path == "/api/playlist")
            and not LOCAL_ORIGIN_RE.match(origin)
        ):
            return jsonify(error="Forbidden origin."), 403
        return None

    # ---- 2. Security headers -----------------------------------------------------------------
    @app.after_request
    def _headers(resp: Response):
        resp.headers["X-Content-Type-Options"] = "nosniff"
        # notes.html may be framed by the local UI; it uses CSP frame-ancestors instead (see routes.py)
        if not request.path.endswith(("/notes.html", "/draft.html")):
            resp.headers["X-Frame-Options"] = "SAMEORIGIN"
        resp.headers["Referrer-Policy"] = "no-referrer"
        resp.headers["Cross-Origin-Resource-Policy"] = "same-origin"
        resp.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        if "Content-Security-Policy" not in resp.headers:  # a route may have set a stricter one
            if request.path.endswith(("/notes.html", "/draft.html")):
                resp.headers["Content-Security-Policy"] = CSP_NOTES
            elif request.path.startswith("/api/"):
                resp.headers["Content-Security-Policy"] = CSP_FILE
            else:
                resp.headers["Content-Security-Policy"] = CSP_APP
        if request.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"
        return resp

    # ---- 3. Error handlers (JSON for the API) ------------------------------------------------
    @app.errorhandler(404)
    def _404(_e):
        return jsonify(error="Not found."), 404

    @app.errorhandler(405)
    def _405(_e):
        return jsonify(error="Method not allowed."), 405

    @app.errorhandler(413)
    def _413(_e):
        return jsonify(error="Request too large."), 413

    @app.errorhandler(500)
    def _500(_e):
        return jsonify(error=GENERIC_ERROR), 500
