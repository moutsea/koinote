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

test("public proxy never forwards Worker-only backend callbacks", async t => {
  // The proxy attaches the internal token, so forwarding these would let any
  // caller act as the Worker (record usage, admit uploads, roll back objects).
  mockFetch(t, async () => { throw new Error("Worker-only callback reached the backend"); });
  for (const path of ["/api/images/record", "/api/images/admit", "/api/images/rollback", "/api/images/rollback/", "/api/images/%72ollback", "/api/images/%E0%A4%A"]) {
    const response = await worker.fetch(new Request("https://app.example" + path, { method: "POST", headers: { "cf-connecting-ip": "203.0.113.7", "x-auth-user-id": "victim" }, body: "{}" }), environment());
    assert.equal(response.status, 404, path);
  }
});

test("share metadata forwards the client address for same-zone CF-Connecting-IP", async t => {
  const token = "c".repeat(32);
  mockFetch(t, async (input, init) => {
    const { url, headers } = backendRequest(input, init);
    assert.equal(url.pathname, `/api/share/${token}/meta`);
    assert.equal(headers.get("x-forwarded-for"), "2001:db8::77");
    assert.equal(headers.get("x-real-ip"), "2001:db8::77");
    return new Response(null, { status: 404 });
  });
  const response = await worker.fetch(new Request(`https://app.example/share/${token}`, { headers: { "cf-connecting-ip": "2001:db8::77", "x-real-ip": "forged" } }), environment());
  assert.equal(response.status, 200);
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

test("repository SEO lookup authenticates origin", async t => {
  let calls = 0;
  mockFetch(t, async (input, init) => {
    calls += 1; const { url } = backendRequest(input, init);
    assert.equal(url.pathname, "/api/agent/repositories/7");
    return Response.json({ repository: { name: "Fixture repository", files: [] } });
  });
  assert.equal((await worker.fetch(new Request("https://app.example/repositories/7"), environment())).status, 200);
  assert.equal(calls, 1);
});

test("image session verification and quota recording both authenticate origin", async t => {
  const paths = [];
  mockFetch(t, async (input, init) => {
    const { url, headers } = backendRequest(input, init); paths.push(url.pathname);
    if (url.pathname === "/api/auth/session") return Response.json({ user: { authUserId: "fixture-user" } });
    if (url.pathname === "/api/images/admit") return new Response(null, { status: 204 });
    assert.equal(url.pathname, "/api/images/record");
    assert.equal(headers.get("x-koinote-internal-token"), internal);
    assert.equal(headers.get("x-auth-user-id"), "fixture-user");
    return Response.json({ usedBytes: 12 });
  });
  const response = await worker.fetch(new Request("https://app.example/api/images", { method: "POST", headers: { cookie: "fixture-session", "content-type": "image/png" }, body: png }), environment());
  assert.equal(response.status, 200); assert.deepEqual(paths, ["/api/auth/session", "/api/images/admit", "/api/images/record", "/api/images/record"]);
});

test("external image requests never receive either backend credential", async t => {
  let externalRequests = 0;
  mockFetch(t, async (input, init) => {
    const url = new URL(input.url ?? input);
    if (url.origin === "https://backend.example") {
      if (url.pathname === "/api/images/admit") { backendRequest(input, init); return new Response(null, { status: 204 }); }
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

test("import owner hint survives proxying but cannot authorize an image write", async t => {
  let puts=0,reads=0;
  const env=environment();env.IMAGES.put=async()=>{puts++};
  mockFetch(t,async(input,init)=>{
    const {url,headers}=backendRequest(input,init);
    if(url.pathname==="/api/auth/session")return Response.json({user:{authUserId:"account-B"}});
    assert.equal(headers.get("x-koinote-import-owner"),"account-A");
    return Response.json({code:"import_account_changed"},{status:409});
  });
  const rejected=await worker.fetch(new Request("https://app.example/api/documents",{method:"POST",headers:{cookie:"session=B","X-Koinote-Import-Owner":"account-A"},body:"{}"}),env);
  assert.equal(rejected.status,409);
  for(const path of ["/api/images","/api/images/fetch"]){
    const request=new Request("https://app.example"+path,{method:"POST",headers:{cookie:"session=B","X-Koinote-Import-Owner":"account-A","Content-Type":"image/png"},body:png});
    request.arrayBuffer=async()=>{reads++;throw Error("must reject before reading image bytes")};
    request.json=async()=>{reads++;throw Error("must reject before external-image lookup")};
    const response=await worker.fetch(request,env);
    assert.equal(response.status,409);assert.equal((await response.json()).code,"import_account_changed");
  }
  assert.equal(puts,0);assert.equal(reads,0);
  const anonymous=await worker.fetch(new Request("https://app.example/api/images",{method:"POST",headers:{"X-Koinote-Import-Owner":"account-B"},body:png}),env);
  assert.equal(anonymous.status,401);assert.equal(puts,0);
});

test("import image uploads require durable cleanup registration", async t => {
  let puts=0,deletes=0,recorded;const phases=[];
  const env=environment();env.IMAGES.put=async()=>{puts++};env.IMAGES.delete=async()=>{deletes++};
  mockFetch(t,async(input,init)=>{
    const {url}=backendRequest(input,init);
    if(url.pathname==="/api/auth/session")return Response.json({user:{authUserId:"account-A"}});
    if(url.pathname==="/api/images/admit")return new Response(null,{status:204});
    if(url.pathname==="/api/images/rollback"){
      assert.equal(new Headers(init.headers).get("x-auth-user-id"),"account-A");
      const body=JSON.parse(init.body);phases.push(body.deleted);
      if(body.deleted)assert.equal(deletes,1);else assert.equal(deletes,0);
      return Response.json({rollbackAllowed:true});
    }
    assert.equal(url.pathname,"/api/images/record");recorded=JSON.parse(init.body);
    return Response.json({code:"server_error"},{status:500});
  });
  const result=await worker.fetch(new Request("https://app.example/api/images",{method:"POST",headers:{cookie:"session=A","X-Koinote-Import-Owner":"account-A","Content-Type":"image/png"},body:png}),env);
  assert.equal(result.status,503);assert.equal(recorded.import,true);assert.equal(recorded.purpose,"persistent");
  assert.equal(puts,0);assert.equal(deletes,1);
  assert.deepEqual(phases,[false,true]);
});

test("import rollback keeps an image when the backend finds a persisted reference",async t=>{
  const env=environment();let deletes=0;env.IMAGES.delete=async()=>{deletes++};
  mockFetch(t,async(input,init)=>{
    const {url}=backendRequest(input,init);
    if(url.pathname==="/api/auth/session")return Response.json({user:{authUserId:"account-A"}});
    if(url.pathname==="/api/images/admit")return new Response(null,{status:204});
    if(url.pathname==="/api/images/rollback")return Response.json({rollbackAllowed:false});
    return Response.json({code:"server_error"},{status:500});
  });
  const result=await worker.fetch(new Request("https://app.example/api/images",{method:"POST",headers:{cookie:"session=A","X-Koinote-Import-Owner":"account-A","Content-Type":"image/png"},body:png}),env);
  assert.equal(result.status,503);assert.equal(deletes,0);
});

test("both import rollback acknowledgements can be retried without another deletion",async t=>{
  const env=environment();const phases=[];let deletes=0;
  env.IMAGES.delete=async()=>{deletes++};
  mockFetch(t,async(input,init)=>{
    const {url}=backendRequest(input,init);
    if(url.pathname==="/api/auth/session")return Response.json({user:{authUserId:"account-A"}});
    if(url.pathname==="/api/images/admit")return new Response(null,{status:204});
    if(url.pathname==="/api/images/record")return Response.json({code:"server_error"},{status:500});
    assert.equal(url.pathname,"/api/images/rollback");
    const {deleted}=JSON.parse(init.body);phases.push(deleted);
    if(phases.length===1||phases.length===3)throw new TypeError("Rollback committed but response lost");
    return Response.json({rollbackAllowed:true});
  });
  const result=await worker.fetch(new Request("https://app.example/api/images",{method:"POST",headers:{cookie:"session=A","X-Koinote-Import-Owner":"account-A","Content-Type":"image/png"},body:png}),env);
  assert.equal(result.status,503);assert.equal(deletes,1);assert.deepEqual(phases,[false,false,true,true]);
});
