import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { parseHTML } from "linkedom";

const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
const require = createRequire(import.meta.url);
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
const storage = new Map();
window.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: key => storage.delete(key),
};
const bundle = await build({
  stdin: {
    contents: `export { createElement, act } from "react";
      export { createRoot } from "react-dom/client";
      export { useDocumentSaver } from "./spa/src/components/editor/useDocumentSaver";
      export { LiveEditor } from "./spa/src/components/editor/LiveEditor";`,
    resolveDir: process.cwd(),
  },
  bundle: true, format: "esm", platform: "node", write: false, jsx: "automatic",
  plugins: [{ name: "saver-race-adapters", setup(builder) {
    const adapters = {
      "@tanstack/react-query": "const client = { setQueryData() {}, invalidateQueries() {} }; export const useQueryClient = () => client;",
      "lucide-react": "export const Bot = () => null; export const History = Bot; export const RefreshCw = Bot;",
      "../../i18n": "const strings = new Proxy({}, { get: (_, key) => key }); export const useI18n = () => ({ t: { editor: strings, agentReview: strings } });",
      "../../desktop/runtime": 'export const isDesktopRuntime = () => true; export const DESKTOP_SYNC_EVENT = "koinote:desktop-sync";',
      "../../desktop/menu": "export const useDesktopMenuActions = () => {};",
      "../../desktop/offlineStore": "export const desktopPrepareDocumentForRemoteMutation = async () => true;",
      "../../agentReviewNotifications": 'export const AGENT_REVIEW_OPEN_EVENT = "review"; export const consumeAgentReviewOpen = () => null;',
      "./MarkdownEditor": "export default () => null;",
      "./ConflictDialog": "export const ConflictDialog = () => null;",
      "./VersionHistoryDialog": "export const VersionHistoryDialog = () => null;",
      "./AgentReviewPanel": "export const AgentReviewPanel = () => null;",
      "./DocumentCoverDialog": "export const DocumentCoverDialog = () => null;",
    };
    builder.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(adapters, path) ? { path, namespace: "saver-ui" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "saver-ui" }, ({ path }) => ({ contents: adapters[path] }));
    builder.onResolve({ filter: /^react(?:-dom)?(?:\/|$)/ }, ({ path }) => ({ path: pathToFileURL(require.resolve(path)).href, external: true }));
    builder.onResolve({ filter: /\/documents$/ }, () => ({ path: "documents", namespace: "saver-race" }));
    builder.onResolve({ filter: /\/api$/ }, () => ({ path: "api", namespace: "saver-race" }));
    builder.onLoad({ filter: /.*/, namespace: "saver-race" }, ({ path }) => ({ contents: path === "documents"
      ? `export const useSaveDocument = () => ({ mutateAsync: input => globalThis.__saverRaceSave(input) });
        export const useDocument = () => ({ data: globalThis.__saverRaceQuery });`
      : `export class ApiError extends Error {}
        export const getDocument = () => globalThis.__saverRaceGet();
        export const uploadImage = async () => { throw new Error("Unexpected upload"); };
        export const releaseUnusedImages = async () => { throw new Error("Unexpected cleanup"); };`,
    }));
  } }],
});
const { createElement, act, createRoot, useDocumentSaver, LiveEditor } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const root = createRoot(document.getElementById("root"));
let saver;
function Harness({ liveDocId }) {
  saver = useDocumentSaver();
  return liveDocId ? createElement(LiveEditor, { docId: liveDocId, saver, visible: true }) : null;
}
const original = { title: "Article", content: "Body", theme: "minimal", revision: 1 };
const documents = new Map();
const requests = [];
let beforeSave = async () => {};
globalThis.__saverRaceSave = async input => {
  requests.push({ ...input });
  await beforeSave(input);
  const current = documents.get(input.docId);
  if (input.expectedRevision !== current.revision) throw new Error("document_revision_conflict");
  const saved = { ...input, revision: current.revision + 1 };
  documents.set(input.docId, saved);
  return { document: { ...saved } };
};

try {
  await act(async () => root.render(createElement(Harness)));
  documents.set("stale-cache", { ...original });
  saver.seed("stale-cache", original);
  await act(async () => {
    saver.queue("stale-cache", { content: "Saved body with image" });
    assert.equal(await saver.flush("stale-cache"), true);
  });
  saver.seed("stale-cache", original);
  assert.equal(saver.peek("stale-cache").revision, 2, "a delayed query snapshot must not rewind a successful save");
  assert.equal(saver.peek("stale-cache").content, "Saved body with image");
  await act(async () => {
    saver.queue("stale-cache", { content: "Keep typing after save" });
    assert.equal(await saver.flush("stale-cache"), true, "the next edit must not conflict with our previous save");
  });
  assert.equal(saver.status("stale-cache"), "saved");
  const newer = { ...documents.get("stale-cache"), content: "Newer stored body", revision: 10 };
  documents.set("stale-cache", newer);
  saver.seed("stale-cache", newer);
  assert.equal(saver.peek("stale-cache").revision, 10, "a clean saver still accepts newer snapshots");

  const localURL = "koinote-local-image://550e8400-e29b-41d4-a716-446655440000";
  const remoteURL = "https://img.koinote.app/u/test-user/12345678abcdef00.png";
  documents.set("image-flight", { ...original });
  saver.seed("image-flight", original);
  let releaseSave;
  let startedSave;
  const saveStarted = new Promise(resolve => { startedSave = resolve; });
  const saveGate = new Promise(resolve => { releaseSave = resolve; });
  beforeSave = async () => { startedSave(); await saveGate; };
  let flushing;
  await act(async () => {
    saver.queue("image-flight", { content: `Body\n\n![](${localURL})` });
    flushing = saver.flush("image-flight");
    await saveStarted;
    saver.queue("image-flight", { content: `Body\n\n![](${localURL})\n\nTyped during save` });
    saver.applyImageMapping("image-flight", localURL, remoteURL);
    saver.seed("image-flight", original);
  });
  assert.equal(saver.isSaving("image-flight"), true);
  await act(async () => {
    releaseSave();
    assert.equal(await flushing, true);
  });
  beforeSave = async () => {};
  assert.equal(documents.get("image-flight").content, `Body\n\n![](${remoteURL})\n\nTyped during save`);
  assert.deepEqual(requests.filter(request => request.docId === "image-flight").map(request => request.expectedRevision), [1, 2]);
  assert.equal(saver.isDirty("image-flight"), false);
  assert.equal(saver.status("image-flight"), "saved");

  documents.set("real-conflict", { ...original, content: "Different stored body", revision: 2 });
  saver.seed("real-conflict", original);
  await act(async () => {
    saver.queue("real-conflict", { content: "Unsaved user draft" });
    assert.equal(await saver.flush("real-conflict"), false);
  });
  assert.equal(saver.status("real-conflict"), "conflict");
  assert.equal(saver.peek("real-conflict").content, "Unsaved user draft");
  assert.equal(documents.get("real-conflict").content, "Different stored body");
  assert.ok([...storage.values()].some(value => JSON.parse(value).content === "Unsaved user draft"));
  await act(async () => saver.drop("real-conflict"));

  const refreshDocId = "desktop-refresh";
  const refreshOriginal = { ...original, docId: refreshDocId };
  documents.set(refreshDocId, refreshOriginal);
  globalThis.__saverRaceQuery = refreshOriginal;
  await act(async () => root.render(createElement(Harness, { liveDocId: refreshDocId })));
  let resolveRefresh;
  globalThis.__saverRaceGet = () => new Promise(resolve => { resolveRefresh = resolve; });
  await act(async () => {
    window.dispatchEvent(new window.CustomEvent("koinote:desktop-sync", { detail: { state: "idle" } }));
    assert.equal(typeof resolveRefresh, "function");
    saver.queue(refreshDocId, { content: "Typing after image sync" });
    assert.equal(await saver.flush(refreshDocId), true);
    resolveRefresh({ document: refreshOriginal });
  });
  assert.equal(saver.peek(refreshDocId).revision, 2, "a delayed desktop sync refresh must not undo a completed local save");
  assert.equal(saver.peek(refreshDocId).content, "Typing after image sync");
  await act(async () => {
    saver.queue(refreshDocId, { content: "Continue typing after refresh" });
    assert.equal(await saver.flush(refreshDocId), true);
  });
  const latestRemote = { ...refreshOriginal, revision: 4, content: "Newer remote content" };
  documents.set(refreshDocId, latestRemote);
  globalThis.__saverRaceGet = async () => ({ document: latestRemote });
  await act(async () => window.dispatchEvent(new window.CustomEvent("koinote:desktop-sync", { detail: { state: "idle" } })));
  assert.equal(saver.peek(refreshDocId).content, latestRemote.content, "clean editors must still accept newer remote changes");
  console.log("document saver cache and image race checks passed");
} finally {
  await act(async () => root.unmount());
  delete globalThis.__saverRaceSave;
  delete globalThis.__saverRaceGet;
  delete globalThis.__saverRaceQuery;
}
