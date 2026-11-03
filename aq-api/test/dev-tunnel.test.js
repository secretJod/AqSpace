// #47 (web-dev-3): /dev must never be reachable through the Cloudflare tunnel. The tunnel arrives from loopback with
// Host localhost:5180, so the only tell is the proxy headers it adds.
import { test } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { startApp, startMockPython } from "./helpers.js";

function get(base, p, headers) {
  const { port } = new URL(base);
  return new Promise((res, rej) => http.get({ host: "127.0.0.1", port, path: p, headers: { Host: `localhost:${port}`, ...headers } },
    (x) => { x.resume(); res(x.statusCode); }).on("error", rej));
}

const TUNNEL = [
  { "cf-connecting-ip": "203.0.113.9" }, { "cf-ray": "8abc-LHR" }, { "cdn-loop": "cloudflare" },
  { "x-forwarded-for": "203.0.113.9" }, { forwarded: "for=203.0.113.9" }, { "cf-visitor": '{"scheme":"https"}' },
  { origin: "https://abc.trycloudflare.com" }
];

test("dev tools: local request works, any tunnel/proxy header -> 404 on /dev and /dev/api/*", async () => {
  const py = await startMockPython();
  const a = await startApp({ py });
  try {
    assert.equal(await get(a.base, "/dev/api/overview", {}), 200);
    for (const h of TUNNEL) {
      for (const p of ["/dev", "/dev/", "/dev/api/overview", "/dev/api/jobs", "/dev/tracker.html"]) {
        assert.equal(await get(a.base, p, h), 404, `${p} with ${JSON.stringify(h)}`);
      }
    }
    // the normal app API stays reachable through the tunnel
    assert.equal(await get(a.base, "/api/v1/health", { "cf-connecting-ip": "203.0.113.9" }), 200);
  } finally { await a.close(); await py.close(); }
});
