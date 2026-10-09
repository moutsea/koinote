import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock } from "node:test";
import { build, stop } from "esbuild";

const bundle = await build({
  stdin: { resolveDir: process.cwd(), contents: `
    export { apiJson, ApiError } from "./spa/src/api";
    export { loadAgentWorkspaceFiles } from "./spa/src/agentWorkspaceTransfer";
    export { publicAgentRepositoryTransferSource } from "./spa/src/agentRepositorySharing";
  ` }, bundle: true, write: false, format: "esm", platform: "node",
});
const { apiJson, ApiError, loadAgentWorkspaceFiles, publicAgentRepositoryTransferSource } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const originalFetch = globalThis.fetch;
const realTimeout = globalThis.setTimeout;
const bytes = Buffer.from("# Shared skill\nReview before use.");
const file = { path: "skill.md", fileId: 1, mimeType: "text/markdown", sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
const snapshot = { workspaceId: 7, revision: 3, files: [file] };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const limited = (value = "60") => json({ code: "rate_limited", error: "Rate limited" }, 429, value === null ? {} : { "Retry-After": value });
const load = (repository = snapshot, signal, waiting = () => {}) => loadAgentWorkspaceFiles(repository, new Set(repository.files.map(f => f.fileId)), () => {}, signal, publicAgentRepositoryTransferSource(repository), waiting);
const fileResponse = f => json({ file: { ...f, contentBase64: bytes.toString("base64") } });
async function until(predicate) {
  for (let i = 0; i < 2000; i++) {
    if (predicate()) return;
    await new Promise(resolve => realTimeout(resolve, 1));
  }
  assert.fail("The transfer did not reach the expected state");
}

try {
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.UTC(2026, 9, 9) });
  // Read actual HTTP response headers through apiJson, not a mocked ApiError.
  for (const [header, delay] of [["60", 60_000], [new Date(Date.now() + 120_000).toUTCString(), 120_000], [null, undefined], ["invalid", undefined], ["-1", undefined]]) {
    globalThis.fetch = async () => limited(header);
    await assert.rejects(apiJson("/api/test"), error => error instanceof ApiError && error.status === 429 && error.retryAfterMs === delay);
  }

  // The real 600-request budget includes manifests. Four readers must pause
  // together, then resume without fetching already verified files again.
  const many = { ...snapshot, files: Array.from({ length: 601 }, (_, i) => ({ ...file, fileId: i + 1, path: `skills/${i + 1}.md` })) };
  let windowStart = Date.now(), budget = 600, requests = 0, waiting = false, result;
  const successes = new Map();
  globalThis.fetch = async (path, init) => {
    requests++;
    assert.ok(init.signal instanceof AbortSignal, "downloads forward cancellation to fetch");
    if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); budget = 600; }
    if (budget-- <= 0) return limited();
    const match = path.match(/\/files\/(\d+)/);
    if (!match) return json({ repository: many });
    const id = Number(match[1]); successes.set(id, (successes.get(id) ?? 0) + 1);
    return fileResponse(many.files[id - 1]);
  };
  const download = load(many, undefined, value => { waiting = value; }).then(files => { result = files; });
  await until(() => waiting);
  const before = requests;
  mock.timers.tick(59_999);
  await new Promise(resolve => realTimeout(resolve, 5));
  assert.equal(requests, before, "no reader retries before Retry-After");
  assert.equal(result, undefined, "saving cannot begin during the pause");
  mock.timers.tick(1);
  await download;
  assert.equal(result.length, 601);
  assert.ok(result.every(f => Buffer.from(f.bytes).equals(bytes)));
  assert.equal(successes.size, 601);
  assert.ok([...successes.values()].every(count => count === 1), "completed files are not downloaded twice");

  // Cancellation interrupts the wait immediately and never starts another read.
  const controller = new AbortController();
  waiting = false; requests = 0;
  globalThis.fetch = async path => { requests++; return path.includes("/files/") ? limited(null) : json({ repository: snapshot }); };
  const cancelled = assert.rejects(load(snapshot, controller.signal, value => { waiting = value; }), error => error.name === "AbortError");
  await until(() => waiting);
  controller.abort(); await cancelled;
  const afterCancel = requests;
  mock.timers.tick(60_000);
  await new Promise(resolve => realTimeout(resolve, 5));
  assert.equal(requests, afterCancel);

  // The final manifest also respects limits, then rejects withdrawal before saving.
  let manifests = 0;
  waiting = false;
  globalThis.fetch = async path => path.includes("/files/") ? fileResponse(file) : ++manifests === 1 ? json({ repository: snapshot }) : manifests === 2 ? limited("1") : json({ error: "Withdrawn" }, 404);
  const withdrawn = assert.rejects(load(snapshot, undefined, value => { waiting = value; }), error => error.code === "transferChanged");
  await until(() => waiting); mock.timers.tick(1000); await withdrawn;
  assert.equal(manifests, 3);

  // A permanent error wakes other workers instead of waiting through their cooldown.
  const several = { ...snapshot, files: many.files.slice(0, 4) };
  let finishMissing;
  waiting = false;
  globalThis.fetch = async path => {
    if (!path.includes("/files/")) return json({ repository: several });
    if (path.includes("/files/1?")) return new Promise(resolve => { finishMissing = () => resolve(json({ error: "Missing" }, 404)); });
    return limited();
  };
  const failed = assert.rejects(load(several, undefined, value => { waiting = value; }), error => error.code === "transferChanged");
  await until(() => waiting && finishMissing); finishMissing(); await failed;

  // Repeated throttling is bounded; an excessive Retry-After is never shortened.
  requests = 0;
  globalThis.fetch = async () => { requests++; return limited("1"); };
  const exhausted = assert.rejects(load(), error => error.status === 429);
  for (let attempt = 1; attempt <= 3; attempt++) { await until(() => requests === attempt); await new Promise(resolve => realTimeout(resolve, 1)); mock.timers.tick(1000); }
  await exhausted; assert.equal(requests, 4);
  requests = 0;
  globalThis.fetch = async () => { requests++; return limited("3600"); };
  await assert.rejects(load(), error => error.status === 429);
  assert.equal(requests, 1);
  console.log("Repository HTTP Retry-After, 601-file resume, shared cooldown, cancellation and withdrawal checks passed");
} finally {
  globalThis.fetch = originalFetch;
  mock.timers.reset();
  stop();
}
