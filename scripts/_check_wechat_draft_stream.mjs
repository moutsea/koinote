import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "neutral", write: false,
});
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const originalFetch = globalThis.fetch;
const contentType = "application/x-koinote-wechat-draft";
const env = { BACKEND_URL: "https://backend.example", BACKEND_INTERNAL_TOKEN: "test-internal" };
const encoder = new TextEncoder();
const request = () => new Request("https://koinote.app/api/documents/test-doc/wechat-draft", {
  method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-session" }, body: "{}",
});
const framedResponse = (text) => new Response(new ReadableStream({
  start(controller) {
    for (const byte of encoder.encode(text)) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  },
}), { headers: { "content-type": contentType, "content-length": "9999", "content-encoding": "gzip" } });

try {
  for (const [status, body] of [
    [200, { draft: { mediaId: "draft-中文" } }],
    [502, { code: "wechat_provider_error", error: "provider failed" }],
    [400, { code: "wechat_cover_input_invalid", error: "invalid cover" }],
    [402, { code: "insufficient_credits", error: "not enough credits" }],
  ]) {
    globalThis.fetch = async (url, init) => {
      assert.equal(new URL(url).pathname, "/api/documents/test-doc/wechat-draft");
      assert.equal(init.headers.get("accept"), contentType);
      assert.equal(init.headers.get("authorization"), "Bearer test-session");
      assert.equal(init.headers.get("x-koinote-internal-token"), "test-internal");
      assert.ok(init.signal instanceof AbortSignal);
      return framedResponse(`{"type":"ping"}\n{"type":"ping"}\n${JSON.stringify({ type: "result", status, body })}\n`);
    };
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), body);
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(response.headers.get("content-encoding"), null);
    assert.match(response.headers.get("content-type"), /application\/json/);
  }

  for (const invalid of [
    `{"type":"ping"}\n`,
    `{"type":"result","status":200,"body":{}}\n`,
    `{"type":"result","status":204,"body":{}}\n`,
    `{"type":"result","status":502,"body":`,
    "not JSON\n",
    "x".repeat(65537),
  ]) {
    globalThis.fetch = async () => framedResponse(invalid);
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, "wechat_provider_unavailable");
  }

  let controller;
  let canceled = false;
  let completed = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(streamController) { controller = streamController; },
    cancel() { canceled = true; },
  }), { headers: { "content-type": contentType } });
  const waiting = worker.fetch(request(), env).then((response) => { completed = true; return response; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.enqueue(encoder.encode(`{"type":"ping"}\n`));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(completed, false);
  controller.enqueue(encoder.encode(`{"type":"result","status":200,"body":{"draft":{"mediaId":"complete"}}}\n`));
  assert.equal((await waiting).status, 200);
  assert.equal(canceled, true);

  globalThis.fetch = async () => Response.json({ code: "unauthorized" }, { status: 401 });
  assert.equal((await worker.fetch(request(), env)).status, 401);
  globalThis.fetch = async (_url, init) => {
    assert.notEqual(init.headers.get("accept"), contentType);
    return Response.json({ status: "ok" });
  };
  assert.equal((await worker.fetch(new Request("https://koinote.app/health"), env)).status, 200);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("WeChat draft gateway streaming checks passed");
