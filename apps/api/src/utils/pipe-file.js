/* pipe-file.js - streams a file from the Python worker straight to the browser.

   What:  copies the status and a short allow-list of headers, then pipes the body.
   How it fits: used by routes/notes.js (notes HTML/PDF) and routes/fonts.js.
   Read next: routes/notes.js */
import { Readable } from "node:stream";

/**
 * Streams a worker response to the browser. Only the named headers are copied, so the worker cannot
 * set cookies or other headers on our origin.
 *
 * @param {import("express").Response} res
 * @param {Response} upstream  a fetch Response from the worker (body not read yet)
 * @param {string[]} headerNames  lower-case names of the headers to pass on
 * @returns {Promise<void>}
 */
export async function pipeFile(res, upstream, headerNames) {
  res.status(upstream.status);
  for (const name of headerNames) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  if (!upstream.body) return res.end();

  const source = Readable.fromWeb(upstream.body);
  source.on("error", () => res.destroy()); // worker stream broke: drop the connection
  res.on("close", () => source.destroy()); // browser went away: stop reading from the worker
  source.pipe(res);
}
