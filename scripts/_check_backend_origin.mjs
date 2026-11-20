import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const bundled = await build({ entryPoints: ["worker/index.ts"], bundle: true, write: false, platform: "neutral", format: "esm", loader: { ".md": "text" }, logLevel: "silent" });
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`);
const origin = "fixture-origin-credential";
const internal = "fixture-internal-credential";
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const assets = { fetch: async () => new Response("<!doctype html><html><head><title>Fixture</title></head><body></body></html>", { headers: { "content-type": "text/html" } }) };
const environment = () => ({ BACKEND_URL: "https://backend.example", BACKEND_INTERNAL_TOKEN: internal, BACKEND_ORIGIN_TOKEN: origin, ASSETS: assets, IMAGES: { head: async () => null, put: async () => {}, delete: async () => {} } });
function mockFetch(t, handler) {
  const previous = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = previous; });
}
function backendRequest(input, init) {
  const url = new URL(input.url ?? input);
  assert.equal(url.origin, "https://backend.example");
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("x-koinote-origin-token"), origin);
  assert.equal(init.redirect, "manual", "origin/internal credentials cannot follow redirects");
  return { url, headers };
}

test("API proxy replaces forged origin/identity/forwarding headers", async t => {
  mockFetch(t, async (input, init) => {
    const { headers } = backendRequest(input, init);
    assert.equal(headers.get("x-auth-user-id"), null);
    assert.equal(headers.get("x-koinote-internal-token"), internal);
    assert.equal(headers.get("x-forwarded-for"), "203.0.113.7");
    assert.equal(headers.get("authorization"), "Bearer fixture-desktop-token");
    return Response.json({ ok: true });
  });
  const response = await worker.fetch(new Request("https://app.example/api/documents", { headers: { authorization: "Bearer fixture-desktop-token", "x-koinote-origin-token": "forged", "x-auth-user-id": "another-user", "x-koinote-internal-token": "forged", "x-forwarded-for": "192.0.2.1", "cf-connecting-ip": "203.0.113.7" } }), environment());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-koinote-origin-token"), null);
});

test("blocked sources cannot reach backend or internal storage routes", async t => {
  mockFetch(t, async () => { throw new Error("blocked request reached an upstream"); });
  const env = { ...environment(), SECURITY_BLOCKED_IPS: " 192.0.2.7, 45.137.180.141 " };
  for (const path of ["/api/auth/login", "/api/internal/backups", "/api/images/delete", "/"]) {
    const response = await worker.fetch(new Request("https://app.example" + path, { headers: { "cf-connecting-ip": "45.137.180.141" } }), env);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("local mode strips caller origin credentials when none are configured", async t => {
  mockFetch(t, async (_input, init) => {
    assert.equal(new Headers(init.headers).get("x-koinote-origin-token"), null);
    return Response.json({ ok: true });
  });
  const env = environment(); delete env.BACKEND_ORIGIN_TOKEN;
  assert.equal((await worker.fetch(new Request("https://app.example/health", { headers: { "x-koinote-origin-token": "forged" } }), env)).status, 200);
});

test("share metadata authenticates origin and does not follow a redirect", async t => {
  let calls = 0;
  mockFetch(t, async (input, init) => {
    calls += 1; backendRequest(input, init);
    return new Response(null, { status: 302, headers: { location: "https://untrusted.example/collect" } });
  });
  const response = await worker.fetch(new Request("https://app.example/share/" + "a".repeat(32)), environment());
  assert.equal(response.status, 200); assert.equal(calls, 1);
});

test("sitemap backend lookup authenticates origin", async t => {
  let calls = 0;
  mockFetch(t, async (input, init) => {
    calls += 1; const { url } = backendRequest(input, init);
    assert.equal(url.pathname, "/api/agent/repositories/sitemap");
    return Response.json({ repositories: [] });
  });
  assert.equal((await worker.fetch(new Request("https://app.example/sitemap.xml"), environment())).status, 200);
  assert.equal(calls, 1);
});

test("image session verification and quota recording both authenticate origin", async t => {
  const paths = [];
  mockFetch(t, async (input, init) => {
    const { url, headers } = backendRequest(input, init); paths.push(url.pathname);
    if (url.pathname === "/api/auth/session") return Response.json({ user: { authUserId: "fixture-user" } });
    assert.equal(url.pathname, "/api/images/record");
    assert.equal(headers.get("x-koinote-internal-token"), internal);
    assert.equal(headers.get("x-auth-user-id"), "fixture-user");
    return Response.json({ usedBytes: 12 });
  });
  const response = await worker.fetch(new Request("https://app.example/api/images", { method: "POST", headers: { cookie: "fixture-session", "content-type": "image/png" }, body: png }), environment());
  assert.equal(response.status, 200); assert.deepEqual(paths, ["/api/auth/session", "/api/images/record"]);
});

test("external image requests never receive either backend credential", async t => {
  let externalRequests = 0;
  mockFetch(t, async (input, init) => {
    const url = new URL(input.url ?? input);
    if (url.origin === "https://backend.example") {
      backendRequest(input, init);
      return Response.json(url.pathname === "/api/auth/session" ? { user: { authUserId: "fixture-user" } } : { usedBytes: 12 });
    }
    externalRequests += 1;
    assert.equal(url.origin, "https://images.example");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("x-koinote-origin-token"), null);
    assert.equal(headers.get("x-koinote-internal-token"), null);
    assert.equal(headers.get("cookie"), null);
    return new Response(png, { headers: { "content-type": "image/png" } });
  });
  const response = await worker.fetch(new Request("https://app.example/api/images/fetch", { method: "POST", headers: { cookie: "fixture-session", "content-type": "application/json" }, body: JSON.stringify({ url: "https://images.example/test.png" }) }), environment());
  assert.equal(response.status, 200); assert.equal(externalRequests, 1);
});
