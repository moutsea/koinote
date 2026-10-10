import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const { outputFiles } = await build({ entryPoints: ["worker/agentRepositoryObjects.ts"], bundle: true, format: "esm", platform: "neutral", write: false });
const code = outputFiles[0].text;
const { handleAgentRepositoryObject } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const prefix = "/api/internal/agent-repository-objects/";
const token = "repository-storage-test";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const keyFor = bytes => `objects/${"1".repeat(32)}/${hash(bytes)}`;
const request = (key, method = "GET", body, headers = {}) => new Request(`https://example.com${prefix}${key}`, {
  method, headers: { "X-Koinote-Internal-Token": token, ...headers }, ...(body === undefined ? {} : { body, duplex: "half" }),
});
let touched = false;
const guard = { BACKEND_INTERNAL_TOKEN: token, AGENT_REPOSITORIES: new Proxy({}, { get() { touched = true; throw new Error("unexpected bucket access"); } }) };
const sample = new TextEncoder().encode("hello R2 — 中文");
const key = keyFor(sample);
for (const badToken of ["", "wrong", `${token}x`]) {
  const response = await handleAgentRepositoryObject(request(key, "GET", undefined, { "X-Koinote-Internal-Token": badToken }), guard);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
}
assert.equal(touched, false, "unauthenticated callers must never touch R2");
for (const [req, status] of [
  [request("objects/invalid/key"), 400],
  [request(key, "POST"), 405],
  [request(key, "PUT", sample), 411],
  [request(key, "PUT", sample, { "Content-Length": String(5 * 1024 * 1024 + 1) }), 413],
  [request(key, "PUT", sample, { "Content-Length": "1" }), 413],
  [request(key, "PUT", sample, { "Content-Length": String(sample.length + 1) }), 400],
  [request(key, "PUT", "wrong", { "Content-Length": "5" }), 400],
  [request(`${key}?offset=-1&length=1`), 400],
  [request(`${key}?offset=0&length=9999999999`), 400],
]) assert.equal((await handleAgentRepositoryObject(req, guard)).status, status);
assert.equal(touched, false);
assert.equal((await handleAgentRepositoryObject(request(key), { BACKEND_INTERNAL_TOKEN: token })).status, 503);

// Workerd's local R2 implementation validates immutable writes, checksums and
// range semantics independently of our mocks and the backend test fixture.
const mf = new Miniflare({ modules: true, script: `${code}\nexport default {fetch: handleAgentRepositoryObject};`, compatibilityDate: "2025-06-01", r2Buckets: ["AGENT_REPOSITORIES"], bindings: { BACKEND_INTERNAL_TOKEN: token } });
try {
  const dispatch = async req => mf.dispatchFetch(req.url, { method: req.method, headers: Object.fromEntries(req.headers), ...(req.body ? { body: await req.arrayBuffer() } : {}) });
  assert.equal((await dispatch(request("health"))).status, 204);
  assert.equal((await dispatch(request(key))).status, 404);
  for (const bytes of [new Uint8Array(), sample, new Uint8Array(5 * 1024 * 1024).fill(97)]) {
    const objectKey = keyFor(bytes);
    for (let retry = 0; retry < 2; retry++) {
      const uploaded = await dispatch(request(objectKey, "PUT", bytes, { "Content-Length": String(bytes.length) }));
      assert.equal(uploaded.status, 200, await uploaded.text());
    }
    const full = await dispatch(request(`${objectKey}?offset=0&length=${bytes.length}`));
    assert.equal(full.status, 200, `full read ${bytes.length}`);
    assert.equal(full.headers.get("X-Koinote-Object-Sha256"), hash(bytes));
    assert.equal(full.headers.get("Cache-Control"), "private, no-store");
    assert.deepEqual(new Uint8Array(await full.arrayBuffer()), bytes);
    if (bytes.length > 0) {
      const offset = Math.max(0, bytes.length - 3);
      const part = await dispatch(request(`${objectKey}?offset=${offset}&length=3`));
      assert.equal(part.status, 200);
      assert.deepEqual(new Uint8Array(await part.arrayBuffer()), bytes.slice(offset));
    }
    assert.equal((await dispatch(request(objectKey, "DELETE"))).status, 204);
    assert.equal((await dispatch(request(objectKey))).status, 404);
    assert.equal((await dispatch(request(objectKey, "DELETE"))).status, 204);
  }
} finally { await mf.dispose(); }
console.log("Repository R2: authentication, bounded uploads, hashes, immutable retries, empty/max files and ranges passed.");
