import assert from "node:assert/strict";
import { build } from "esbuild";
import { renameDocumentTitle } from "./_document_rename_bundle.mjs";

// Exercise the actual saver with deterministic hook storage and a fake transport.
// No component rendering is needed for its synchronous snapshot/queue API.
const bundle = await build({
  entryPoints: ["spa/src/components/editor/useDocumentSaver.ts"],
  bundle: true, format: "esm", write: false,
  plugins: [{ name: "rename-test-runtime", setup(builder) {
    builder.onResolve({ filter: /^react$/ }, () => ({ path: "hooks", namespace: "fixture" }));
    builder.onResolve({ filter: /^\.\.\/\.\.\/documents$/ }, () => ({ path: "documents", namespace: "fixture" }));
    builder.onResolve({ filter: /^\.\.\/\.\.\/api$/ }, () => ({ path: "api", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ contents:
      path === "hooks" ? `export const useRef = value => ({current:value}); export const useState = value => [value, () => {}]; export const useCallback = fn => fn; export const useMemo = fn => fn(); export const useEffect = () => {};` :
      path === "documents" ? `export const useSaveDocument = () => ({mutateAsync:globalThis.renameTestSave});` :
      `export class ApiError extends Error {}`,
    }));
  } }],
});
const { useDocumentSaver } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const original = { title: "Original", content: "Body\n\n![image](local.png)", theme: "ink", revision: 7 };
function fixture() {
  let remote = { ...original };
  let fail = false;
  let beforeSave = null;
  let loads = 0;
  const writes = [];
  const storage = new Map();
  globalThis.window = { localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  } };
  globalThis.renameTestSave = async input => {
    writes.push({ ...input });
    if (beforeSave) { const fn = beforeSave; beforeSave = null; await fn(); }
    if (fail) throw new Error("offline");
    if (input.expectedRevision !== remote.revision) throw new Error("document_revision_conflict");
    remote = { title: input.title, content: input.content, theme: input.theme, revision: remote.revision + 1 };
    return { document: { ...remote } };
  };
  const saver = useDocumentSaver();
  return {
    saver, storage, writes,
    load: async () => { loads++; return { ...remote }; },
    remote: () => remote,
    loads: () => loads,
    fail: value => { fail = value; },
    beforeSave: fn => { beforeSave = fn; },
    updateRemote: patch => { remote = { ...remote, ...patch, revision: remote.revision + 1 }; },
  };
}
let checks = 0;
async function check(name, run) { await run(); checks++; console.log(`PASS ${name}`); }

await check("pending body/theme are preserved without reloading", async () => {
  const f = fixture(); f.saver.seed("a", original); f.saver.queue("a", { content: "Unsaved body", theme: "new-theme" });
  assert.equal(await renameDocumentTitle("a", "Renamed", f.saver, async () => { throw new Error("Must not reload dirty content"); }), true);
  assert.equal(f.remote().content, "Unsaved body"); assert.equal(f.remote().theme, "new-theme");
});
await check("unopened document and later remote updates use fresh revisions", async () => {
  const f = fixture();
  assert.equal(await renameDocumentTitle("a", "First", f.saver, f.load), true);
  f.updateRemote({ content: "Other client's new body" });
  assert.equal(await renameDocumentTitle("a", "Second", f.saver, f.load), true);
  assert.equal(f.loads(), 2); assert.equal(f.remote().content, "Other client's new body");
});
await check("editing while loading cannot be replaced by an earlier response", async () => {
  const f = fixture();
  await renameDocumentTitle("a", "Renamed", f.saver, async () => {
    f.saver.seed("a", original); f.saver.queue("a", { content: "Typed while loading" }); return original;
  });
  assert.equal(f.remote().content, "Typed while loading");
});
await check("mounted editor keeps its own remote-content reconciliation", async () => {
  const f = fixture(); f.saver.seed("a", original);
  await renameDocumentTitle("a", "Renamed", f.saver, async () => { throw new Error("Must not replace mounted editor baseline"); }, () => false);
  assert.equal(f.remote().title, "Renamed");
});
await check("failed rename is removed from queue and recovery storage before Esc", async () => {
  const f = fixture(); f.fail(true);
  assert.equal(await renameDocumentTitle("a", "Cancelled name", f.saver, f.load), false);
  assert.equal(f.saver.peek("a").title, original.title);
  assert.equal(f.saver.isDirty("a"), false); assert.equal(f.storage.size, 0);
  f.fail(false); await f.saver.flushAll();
  assert.equal(f.writes.length, 1); assert.equal(f.remote().title, original.title);
});
await check("rollback preserves pending body and its recovery backup", async () => {
  const f = fixture(); f.saver.seed("a", original); f.saver.queue("a", { content: "Unsaved body" }); f.fail(true);
  assert.equal(await renameDocumentTitle("a", "Cancelled", f.saver, f.load), false);
  assert.equal(f.saver.isDirty("a"), true);
  const backup = JSON.parse([...f.storage.values()][0]);
  assert.equal(backup.title, original.title); assert.equal(backup.content, "Unsaved body");
  f.fail(false); await f.saver.flushAll();
  assert.equal(f.remote().title, original.title); assert.equal(f.remote().content, "Unsaved body");
});
await check("rollback preserves body entered while rename request is pending", async () => {
  const f = fixture(); f.fail(true); f.beforeSave(() => f.saver.queue("a", { content: "Concurrent body" }));
  await renameDocumentTitle("a", "Cancelled", f.saver, f.load);
  assert.equal(f.saver.peek("a").content, "Concurrent body");
  f.fail(false); await f.saver.flushAll(); assert.equal(f.remote().title, original.title);
});
await check("a newer title from another editor is not rolled back", async () => {
  const f = fixture(); f.fail(true); f.beforeSave(() => f.saver.queue("a", { title: "Newer title" }));
  await renameDocumentTitle("a", "Older attempt", f.saver, f.load);
  assert.equal(f.saver.peek("a").title, "Newer title");
  f.fail(false); await f.saver.flushAll();
});
await check("a conflict between load and save can be retried with latest content", async () => {
  const f = fixture(); f.beforeSave(() => f.updateRemote({ content: "Latest remote body" }));
  assert.equal(await renameDocumentTitle("a", "Retried", f.saver, f.load), false);
  assert.equal(await renameDocumentTitle("a", "Retried", f.saver, f.load), true);
  assert.equal(f.remote().content, "Latest remote body");
});
await check("rollback after a partially successful save chain is still saved", async () => {
  const f = fixture();
  f.beforeSave(() => {
    f.saver.queue("a", { content: "Body typed during first save" });
    f.beforeSave(() => f.fail(true));
  });
  assert.equal(await renameDocumentTitle("a", "Cancelled", f.saver, f.load), false);
  assert.equal(f.remote().title, "Cancelled");
  assert.equal(f.saver.isDirty("a"), true);
  f.fail(false); await f.saver.flushAll();
  assert.equal(f.remote().title, original.title);
  assert.equal(f.remote().content, "Body typed during first save");
});
await check("rollback backup retains conflict type even if the first backup failed", async () => {
  const f = fixture(); f.saver.seed("a", original); f.saver.queue("a", { content: "Local edits" });
  f.updateRemote({ content: "Remote edits" });
  const write = window.localStorage.setItem;
  let first = true;
  window.localStorage.setItem = (key, value) => {
    if (first) { first = false; throw new Error("quota"); }
    write(key, value);
  };
  assert.equal(await renameDocumentTitle("a", "Cancelled", f.saver, f.load), false);
  const backup = JSON.parse([...f.storage.values()][0]);
  assert.equal(backup.conflict, true); assert.equal(backup.title, original.title);
  await f.saver.overwrite("a", f.remote().revision);
});
await check("load failure does not create a pending rename", async () => {
  const f = fixture(); await assert.rejects(renameDocumentTitle("a", "New", f.saver, async () => { throw new Error("offline"); }), /offline/);
  assert.equal(f.saver.peek("a"), null); assert.equal(f.writes.length, 0);
});
console.log(`document rename: ${checks} checks passed`);
