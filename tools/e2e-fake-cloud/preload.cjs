// NODE_OPTIONS=--require preload for the local E2E rig.
//
// The control plane hard-codes the real Neon and Google hostnames (correctly: they
// are not configurable in production). To run the real server code against the
// local rig without editing it, this preload rewrites just those three origins on
// the way out of fetch. Everything else is passed straight through.
"use strict";

const target = process.env.FAKE_CLOUD_ORIGIN || "http://127.0.0.1:4680";

function rewrite(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.pathname === "/sql") return `${target}/sql${url.search}`;
  if (url.hostname === "oauth2.googleapis.com") return `${target}/oauth2${url.pathname.replace(/^\/+/, "/")}${url.search}`;
  if (url.hostname === "www.googleapis.com") return `${target}/googleapis${url.pathname}${url.search}`;
  return null;
}

const original = globalThis.fetch;
if (typeof original !== "function") {
  throw new Error("global fetch is unavailable; Node 18+ is required for the E2E rig");
}

globalThis.fetch = function patchedFetch(input, init) {
  try {
    if (typeof input === "string" || input instanceof URL) {
      const next = rewrite(String(input));
      if (next !== null) return original(next, init);
    } else if (input && typeof input.url === "string") {
      const next = rewrite(input.url);
      if (next !== null) return original(new Request(next, input), init);
    }
  } catch {
    // Never let the rig break the request path; fall through to the real fetch.
  }
  return original(input, init);
};

// Deliberately silent: npm parses the stdout of `node -p` probes, so any banner
// printed from a global preload corrupts unrelated tooling.
if (process.env.FAKE_CLOUD_VERBOSE === "1") {
  process.stderr.write(`[e2e] google/neon fetch redirected to ${target}\n`);
}
