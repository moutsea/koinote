import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { parseHTML } from "linkedom";

const require = createRequire(import.meta.url);
const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
Object.assign(globalThis, { window, document: window.document, CustomEvent: window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { value: { onLine: true, userAgent: "Node.js" }, configurable: true });
Object.defineProperty(document, "visibilityState", { value: "hidden", writable: true, configurable: true });
const sqlite = new DatabaseSync(":memory:");
for (const migration of readdirSync("src-tauri/migrations").filter((name) => name.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(`src-tauri/migrations/${migration}`, "utf8"));
}
const bind = (values) => Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value]));
const requests = [];
const statuses = [];
let remoteDocument = {
  docId: "autosync-document", title: "Autosync", content: "Original", theme: "minimal", revision: 1,
  coverMode: "default", coverRatio: "2.35:1", coverImageSource: "", coverPrompt: "", folderId: null, sortOrder: 0,
};
let remoteFolders = [];
let additionalRemoteDocuments = [];
const harness = {
  fail: false,
  localMode: false,
  beforeFetch: async () => {},
  prepare: async () => true,
  database: {
    async select(sql, values = []) { return sqlite.prepare(sql).all(bind(values)); },
    async execute(sql, values = []) { return { rowsAffected: Number(sqlite.prepare(sql).run(bind(values)).changes) }; },
  },
  async fetch(path, init = {}) {
    requests.push({ path, ...init });
    if (harness.fail) throw new Error("desktop_sync_failed");
    await harness.beforeFetch(path, init);
    if (path === "/api/folders") return Response.json({ folders: remoteFolders });
    if (path === "/api/documents") return Response.json({ documents: [{ ...remoteDocument }, ...additionalRemoteDocuments] });
    if (path === "/api/tree/move" && init.method === "POST") {
      const { items, folderId } = JSON.parse(init.body);
      assert.equal(items.length, 1);
      assert.equal(items[0].id, remoteDocument.docId);
      assert.equal(items[0].revision, remoteDocument.revision);
      assert.ok(remoteFolders.some((folder) => folder.folderId === folderId));
      remoteDocument = { ...remoteDocument, folderId, sortOrder: 0 };
      return Response.json({ ok: true });
    }
    if (path === `/api/documents/${remoteDocument.docId}/order` && init.method === "PUT") {
      const { folderId, docIds } = JSON.parse(init.body);
      if (folderId !== remoteDocument.folderId) return Response.json({ code: "invalid_order" }, { status: 400 });
      assert.deepEqual(docIds, [remoteDocument.docId]);
      return Response.json({ ok: true });
    }
    if (path === `/api/documents/${remoteDocument.docId}`) {
      if (init.method === "PUT") {
        const patch = JSON.parse(init.body);
        assert.equal(patch.expectedRevision, remoteDocument.revision);
        remoteDocument = { ...remoteDocument, ...patch, revision: remoteDocument.revision + 1 };
      }
      return Response.json({ document: { ...remoteDocument } });
    }
    const additional = additionalRemoteDocuments.find((item) => path === `/api/documents/${item.docId}`);
    if (additional) return Response.json({ document: additional });
    throw new Error(`Unexpected request: ${path}`);
  },
};
globalThis.__desktopAutosyncTest = harness;
const bundle = await build({
  stdin: {
    contents: `export * from "./spa/src/desktop/offlineStore";
      export { DesktopSyncStatus } from "./spa/src/components/DesktopSyncStatus";
      export { createElement, act } from "react";
      export { createRoot } from "react-dom/client";`,
    resolveDir: process.cwd(),
  },
  bundle: true, format: "esm", platform: "node", write: false, jsx: "automatic",
  plugins: [{ name: "desktop-autosync-adapters", setup(builder) {
    const adapters = {
      "@tauri-apps/plugin-sql": "export default { load: async () => globalThis.__desktopAutosyncTest.database };",
      "@tauri-apps/api/core": "export const invoke = async () => {};",
      "./auth": "export const getStoredDesktopSession = async () => ({ accountId: 'account-1' });",
      "./network": "export const desktopFetch = (...args) => globalThis.__desktopAutosyncTest.fetch(...args);",
      "./logoutGuard": "export const prepareDesktopSync = () => globalThis.__desktopAutosyncTest.prepare();",
      "./localMode": `export const DESKTOP_LOCAL_ACCOUNT_ID = "local:v1";
        export const isDesktopLocalModeSelected = () => globalThis.__desktopAutosyncTest.localMode;
        export const isDesktopLocalModeUnlocked = () => false;
        export const verifyDesktopLocalModePassword = async () => {};
        export const encryptDesktopLocalValue = async value => value;
        export const decryptDesktopLocalValue = async value => value;`,
      "../desktop/runtime": 'export const isDesktopRuntime = () => true;',
      "../i18n": 'const copy = new Proxy({}, { get: (_, key) => key }); export const useI18n = () => ({ t: { desktopSync: copy, errors: {} } });',
      "../modalStack": "export const pushModal = () => () => {};",
      "./Ink": "export const PaperCard = () => null;",
      "lucide-react": "export const AlertTriangle = () => null; export const Check = AlertTriangle; export const Cloud = AlertTriangle; export const RefreshCw = AlertTriangle; export const WifiOff = AlertTriangle; export const X = AlertTriangle;",
    };
    builder.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(adapters, path) ? { path, namespace: "autosync" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "autosync" }, ({ path }) => ({ contents: adapters[path] }));
    builder.onLoad({ filter: /\/desktop\/offlineStore\.ts$/ }, ({ path }) => ({
      contents: readFileSync(path, "utf8") + `
        export const settleSync = async () => { await syncPromise; };
        export const restartSyncForTest = () => {
          snapshotInitializations.clear();
          remoteCheckTimes.clear();
          if (syncTimer) clearTimeout(syncTimer);
          syncTimer = null;
          lastDocumentMutationAt = 0;
        };`, loader: "ts",
    }));
    builder.onResolve({ filter: /^react(?:-dom)?(?:\/|$)/ }, ({ path }) => ({ path: pathToFileURL(require.resolve(path)).href, external: true }));
  } }],
});
const store = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const { act, createElement, createRoot, DesktopSyncStatus } = store;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalDateNow = Date.now;
let now = 1_000_000;
let timerID = 0;
const timers = new Map();
Date.now = () => now;
globalThis.setTimeout = (callback, delay = 0) => {
  const id = ++timerID;
  timers.set(id, { callback, at: now + delay });
  return id;
};
globalThis.clearTimeout = (id) => timers.delete(id);
window.addEventListener(store.desktopSyncEventName(), (event) => statuses.push(event.detail));
const root = createRoot(document.getElementById("root"));

async function settle() {
  await new Promise(setImmediate);
  await store.settleSync();
}

async function advance(milliseconds, waitForSync = true) {
  const end = now + milliseconds;
  for (;;) {
    const next = [...timers].filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at)[0];
    if (!next) break;
    const [id, timer] = next;
    now = timer.at;
    timers.delete(id);
    timer.callback();
    if (waitForSync) await settle();
  }
  now = end;
}

async function edit(content) {
  const current = (await store.desktopGetDocument(remoteDocument.docId)).document;
  await store.desktopUpdateDocument(current.docId, { title: current.title, content, expectedRevision: current.revision });
}

try {
  harness.fail = true;
  await act(async () => root.render(createElement(DesktopSyncStatus)));
  await act(settle);
  const failedInitialRequests = requests.length;
  assert.equal((await store.desktopListDocuments()).documents.length, 0);
  await store.desktopListFolders();
  await act(async () => {
    await advance(5 * 60_000);
    root.render(null);
  });
  await act(async () => root.render(createElement(DesktopSyncStatus)));
  await act(settle);
  assert.equal(requests.length, failedInitialRequests, "reads and remounts must not repeatedly retry a failed initial snapshot");
  harness.fail = false;
  await act(async () => {
    window.dispatchEvent(new window.Event("online"));
    window.dispatchEvent(new window.Event("online"));
    await settle();
  });
  assert.equal((await store.desktopListDocuments()).documents.length, 1, "reconnection retries a failed first snapshot without local edits");
  assert.equal(requests.slice(failedInitialRequests).filter((request) => request.path === "/api/documents").length, 1, "overlapping reconnect events share the same initialization");
  assert.equal((await store.desktopSyncSummary()).pending, 0);
  assert.ok(requests.length > 0, "an empty account still pulls its initial cloud snapshot");
  await act(async () => root.render(null));
  store.restartSyncForTest();
  remoteDocument = { ...remoteDocument, content: "Edited on the web", revision: 2 };
  const beforeCachedStartup = requests.length;
  statuses.length = 0;
  await act(async () => root.render(createElement(DesktopSyncStatus)));
  await act(settle);
  assert.ok(requests.length > beforeCachedStartup, "a fresh startup refreshes an existing local cache");
  assert.equal((await store.desktopGetDocument(remoteDocument.docId)).document.content, "Edited on the web");
  assert.ok(requests.slice(beforeCachedStartup).every((request) => !request.method || request.method === "GET"), "clean startup refreshes do not write to the server");
  assert.ok(statuses.length > 0, "successful background refreshes notify document subscribers");
  assert.ok(statuses.every((summary) => summary.state === "idle"), "cached startup refreshes do not show a syncing spinner");
  const beforeIdle = requests.length;
  const beforeIdleStatuses = statuses.length;
  await act(async () => {
    harness.fail = true;
    await advance(5 * 60_000);
    window.dispatchEvent(new window.Event("focus"));
    document.dispatchEvent(new window.Event("visibilitychange"));
    window.dispatchEvent(new window.Event("online"));
    await settle();
  });
  assert.ok(requests.slice(beforeIdle).every((request) => !request.method || request.method === "GET"), "reconnection may check cloud state but must not upload unchanged content");
  assert.equal(statuses.length, beforeIdleStatuses, "background check failures must not emit sync status changes");
  assert.equal(statuses.at(-1).state, "idle", "an unavailable server must not turn idle into a sync failure");
  const initialRequests = requests.length;
  await act(async () => root.render(null));
  await act(async () => root.render(createElement(DesktopSyncStatus)));
  await act(settle);
  assert.equal(requests.length, initialRequests, "remounting the status must not repeat startup synchronization");
  harness.fail = false;

  await act(async () => {
    await edit("First edit");
    await advance(19_999);
    assert.equal(requests.length, initialRequests);
    await edit("Continued editing");
    await advance(19_999);
    assert.equal(requests.length, initialRequests, "each edit resets the idle delay");
    await advance(1);
    assert.equal(remoteDocument.content, "Continued editing");
    assert.equal((await store.desktopSyncSummary()).pending, 0);
    const syncedRequests = requests.length;
    await advance(5 * 60_000);
    assert.equal(requests.length, syncedRequests, "successful synchronization must not create a polling loop");

    await edit("Manual sync before timeout");
    await store.syncDesktopNow({ force: true });
    const manualRequests = requests.length;
    await advance(20_000);
    assert.equal(requests.length, manualRequests, "a leftover timer must skip changes already sent by manual sync");

    navigator.onLine = false;
    await edit("Offline change");
    await advance(20_000);
    assert.equal(requests.length, manualRequests, "offline edits must stay local without network attempts");
    assert.equal((await store.desktopSyncSummary()).pending, 1);
    navigator.onLine = true;
    window.dispatchEvent(new window.Event("online"));
    await settle();
    assert.equal(remoteDocument.content, "Offline change", "reconnection retries pending changes");

    harness.fail = true;
    await edit("Retained after failure");
    await advance(20_000);
    assert.equal(statuses.at(-1).state, "error", "actual upload failures remain visible");
    assert.equal((await store.desktopSyncSummary()).pending, 1);
    const failedRequests = requests.length;
    await advance(5 * 60_000);
    assert.equal(requests.length, failedRequests, "failure does not restart an idle polling loop");
    harness.fail = false;
    await edit("Retry on next edit");
    await advance(20_000);
    assert.equal(remoteDocument.content, "Retry on next edit");

    harness.prepare = async () => {
      harness.prepare = async () => true;
      await edit("Draft flushed by sync preparation");
      return true;
    };
    const beforePreparation = requests.length;
    await store.syncDesktopNow({ onlyIfPending: true });
    assert.equal(requests.length, beforePreparation, "newly flushed drafts still receive the full editing idle delay");
    await advance(20_000);
    assert.equal(remoteDocument.content, "Draft flushed by sync preparation");

    let releasePreparation;
    let markPreparing;
    const preparationGate = new Promise((resolve) => { releasePreparation = resolve; });
    const preparationStarted = new Promise((resolve) => { markPreparing = resolve; });
    harness.prepare = async () => {
      harness.prepare = async () => true;
      markPreparing();
      await preparationGate;
      return true;
    };
    const beforeForcedPreparation = requests.length;
    const automatic = store.syncDesktopNow({ onlyIfPending: true });
    await preparationStarted;
    await edit("Manual sync during draft preparation");
    const manual = store.syncDesktopNow({ force: true });
    const repeatedManual = store.syncDesktopNow({ force: true });
    assert.equal(manual, repeatedManual, "concurrent manual requests share the queued forced sync");
    releasePreparation();
    await automatic;
    await manual;
    assert.equal(remoteDocument.content, "Manual sync during draft preparation", "manual sync must upload without advancing the editing idle timer");
    assert.equal((await store.desktopSyncSummary()).pending, 0);
    assert.equal(requests.slice(beforeForcedPreparation).filter((request) => request.path === "/api/documents").length, 1, "repeated manual clicks coalesce into one forced refresh");
    const afterForcedPreparation = requests.length;
    await advance(20_000);
    assert.equal(requests.length, afterForcedPreparation, "the queued manual sync does not leave a redundant upload timer");

    let releaseRequest;
    let markStarted;
    const requestStarted = new Promise((resolve) => { markStarted = resolve; });
    const requestGate = new Promise((resolve) => { releaseRequest = resolve; });
    harness.beforeFetch = async (path, init) => {
      if (init.method !== "PUT") return;
      harness.beforeFetch = async () => {};
      markStarted();
      await requestGate;
    };
    await edit("First in-flight edit");
    await advance(20_000, false);
    await requestStarted;
    await edit("Edit during upload");
    await advance(20_000, false);
    releaseRequest();
    await settle();
    await advance(0);
    assert.equal(remoteDocument.content, "Edit during upload", "edits whose timer expires during an upload must be sent afterward");
    assert.equal((await store.desktopSyncSummary()).pending, 0);
    let releasePull;
    let markPullStarted;
    const pullGate = new Promise((resolve) => { releasePull = resolve; });
    const pullStarted = new Promise((resolve) => { markPullStarted = resolve; });
    harness.beforeFetch = async (path) => {
      if (path !== "/api/documents") return;
      harness.beforeFetch = async () => {};
      markPullStarted();
      await pullGate;
    };
    const backgroundPull = store.syncDesktopNow({ background: true, pullOnly: true });
    await pullStarted;
    await edit("Manual sync after upload phase finished");
    const manualDuringPull = store.syncDesktopNow({ force: true });
    releasePull();
    await backgroundPull;
    await manualDuringPull;
    assert.equal(remoteDocument.content, "Manual sync after upload phase finished", "manual sync must upload edits made after the active task's upload phase");
    assert.equal((await store.desktopSyncSummary()).pending, 0);
    const finalRequests = requests.length;
    await advance(5 * 60_000);
    assert.equal(requests.length, finalRequests);
  });
  await act(async () => root.render(null));
  store.restartSyncForTest();
  harness.fail = true;
  statuses.length = 0;
  const beforeFailedStartup = requests.length;
  await act(async () => root.render(createElement(DesktopSyncStatus)));
  await act(settle);
  assert.ok(requests.length > beforeFailedStartup, "cached startup attempts one refresh even when the server is unavailable");
  assert.ok(statuses.every((summary) => summary.state !== "error"), "a failed background refresh without local changes stays quiet");
  assert.equal((await store.desktopGetDocument(remoteDocument.docId)).document.content, remoteDocument.content, "failed refreshes preserve the cached document");
  const failedCachedRequests = requests.length;
  await store.desktopListDocuments();
  await store.desktopListFolders();
  assert.equal(requests.length, failedCachedRequests, "cached reads must not retry a failed background refresh");
  harness.fail = false;
  remoteDocument = { ...remoteDocument, content: "Web edit recovered after reconnect", revision: remoteDocument.revision + 1 };
  await act(async () => {
    window.dispatchEvent(new window.Event("online"));
    window.dispatchEvent(new window.Event("online"));
    await settle();
  });
  assert.equal((await store.desktopGetDocument(remoteDocument.docId)).document.content, remoteDocument.content, "reconnection retries a failed cached startup refresh");
  assert.equal(requests.slice(failedCachedRequests).filter((request) => request.path === "/api/documents").length, 1);
  await act(async () => root.render(null));
  store.restartSyncForTest();
  harness.fail = true;
  await act(async () => root.render(createElement(DesktopSyncStatus)));
  await act(settle);
  harness.fail = false;
  await act(async () => { await store.syncDesktopNow({ force: true }); });
  const afterManualRecovery = requests.length;
  await act(async () => {
    window.dispatchEvent(new window.Event("online"));
    await settle();
  });
  assert.equal(requests.length, afterManualRecovery, "successful manual recovery completes initialization without an extra reconnect pull");
  await act(async () => root.render(null));
  await edit("Pending from previous run");
  store.restartSyncForTest();
  harness.fail = true;
  await act(async () => root.render(createElement(DesktopSyncStatus)));
  await act(settle);
  assert.equal(statuses.at(-1).state, "error", "startup must still surface failures when there are pending local changes");
  assert.equal((await store.desktopSyncSummary()).pending, 1);
  await act(async () => root.render(null));
  store.restartSyncForTest();
  harness.fail = false;
  await act(async () => root.render(createElement(DesktopSyncStatus)));
  await act(settle);
  assert.equal(remoteDocument.content, "Pending from previous run", "startup uploads persisted changes from a previous run");
  assert.equal((await store.desktopSyncSummary()).pending, 0);
  remoteFolders = [{ folderId: "target-folder", name: "Existing target", parentFolderId: null }];
  await act(async () => { await store.syncDesktopNow({ force: true }); });
  remoteDocument = { ...remoteDocument, content: "Cloud edit during local move", revision: remoteDocument.revision + 1 };
  const beforeMove = requests.length;
  harness.beforeFetch = async (path) => {
    if (path !== "/api/documents") return;
    harness.beforeFetch = async () => {};
    await store.desktopMoveDocument(remoteDocument.docId, "target-folder");
  };
  await act(async () => {
    await store.syncDesktopNow({ force: true });
    const local = sqlite.prepare("SELECT folder_id, folder_dirty, order_dirty, content FROM offline_documents").get();
    assert.equal(local.folder_id, "target-folder");
    assert.equal(local.folder_dirty, 1, "pulling new cloud content must preserve the unuploaded local move");
    assert.equal(local.order_dirty, 1);
    assert.equal(local.content, remoteDocument.content);
    assert.equal(remoteDocument.folderId, null);
    await advance(1500);
    assert.equal(remoteDocument.folderId, "target-folder", "the next sync must upload the preserved move");
    assert.equal((await store.desktopSyncSummary()).pending, 0);
    assert.equal(statuses.at(-1).state, "idle");
    assert.equal(requests.slice(beforeMove).filter((request) => request.path === "/api/tree/move").length, 1);
    await store.syncDesktopNow({ force: true });
    assert.equal(sqlite.prepare("SELECT folder_id FROM offline_documents").get().folder_id, "target-folder", "later pulls must not revert the local move");
  });
  document.visibilityState = "visible";
  const beforeCloudRefresh = requests.length;
  const beforeCloudStatuses = statuses.length;
  remoteDocument = { ...remoteDocument, content: "Cloud-only edit found by foreground check", revision: remoteDocument.revision + 1 };
  await act(async () => { await advance(30_000); });
  assert.equal((await store.desktopGetDocument(remoteDocument.docId)).document.content, remoteDocument.content, "foreground checks discover cloud edits without local changes");
  assert.ok(requests.slice(beforeCloudRefresh).every((request) => !request.method || request.method === "GET"), "remote checks only read from the server");
  assert.ok(statuses.slice(beforeCloudStatuses).every((summary) => summary.state === "idle"), "remote refreshes do not show a syncing spinner");
  const beforeNoop = requests.length;
  const beforeNoopStatuses = statuses.length;
  await act(async () => { await advance(30_000); });
  assert.equal(requests.length - beforeNoop, 2, "unchanged checks only fetch document summaries and folders");
  assert.ok(requests.slice(beforeNoop).every((request) => request.path === "/api/documents" || request.path === "/api/folders"));
  assert.equal(statuses.length, beforeNoopStatuses, "unchanged checks do not notify or refresh the editor");

  const cloudCreated = { ...remoteDocument, docId: "cloud-created", title: "New cloud document", content: "Created elsewhere", revision: 1 };
  additionalRemoteDocuments = [cloudCreated];
  remoteFolders = [
    { ...remoteFolders[0], name: "Renamed on cloud" },
    { folderId: "cloud-folder", name: "Cloud folder", parentFolderId: null },
  ];
  const beforeCloudCreateStatuses = statuses.length;
  await act(async () => { await advance(30_000); });
  assert.equal((await store.desktopGetDocument(cloudCreated.docId)).document.content, cloudCreated.content);
  assert.equal((await store.desktopListFolders()).folders.find((folder) => folder.folderId === "target-folder").name, "Renamed on cloud");
  assert.ok(statuses.length > beforeCloudCreateStatuses, "cloud document and folder additions notify subscribers");
  remoteDocument = { ...remoteDocument, folderId: "cloud-folder", sortOrder: 2 };
  const beforeCloudMove = requests.length;
  await act(async () => { await advance(30_000); });
  const cloudMoved = (await store.desktopListDocuments()).documents.find((item) => item.docId === remoteDocument.docId);
  assert.equal(cloudMoved.folderId, "cloud-folder");
  assert.equal(cloudMoved.sortOrder, 2);
  assert.equal(requests.length - beforeCloudMove, 2, "cloud moves and ordering changes do not refetch unchanged document bodies");
  additionalRemoteDocuments = [];
  remoteFolders = remoteFolders.filter((folder) => folder.folderId !== "target-folder");
  const beforeCloudDeleteStatuses = statuses.length;
  await act(async () => { await advance(30_000); });
  assert.ok(!(await store.desktopListDocuments()).documents.some((item) => item.docId === cloudCreated.docId));
  assert.ok(!(await store.desktopListFolders()).folders.some((folder) => folder.folderId === "target-folder"));
  assert.ok(statuses.length > beforeCloudDeleteStatuses, "cloud deletions notify subscribers");

  await act(async () => { await advance(1000); });
  remoteDocument = { ...remoteDocument, content: "Cloud edit found on focus", revision: remoteDocument.revision + 1 };
  const beforeFocus = requests.length;
  await act(async () => {
    window.dispatchEvent(new window.Event("focus"));
    document.dispatchEvent(new window.Event("visibilitychange"));
    await settle();
  });
  assert.equal((await store.desktopGetDocument(remoteDocument.docId)).document.content, remoteDocument.content);
  assert.equal(requests.slice(beforeFocus).filter((request) => request.path === "/api/documents").length, 1, "focus and visibility events coalesce");
  document.visibilityState = "hidden";
  const beforeHidden = requests.length;
  remoteDocument = { ...remoteDocument, content: "Cloud edit while hidden", revision: remoteDocument.revision + 1 };
  await act(async () => { await advance(60_000); });
  assert.equal(requests.length, beforeHidden, "hidden windows do not poll the server");
  document.visibilityState = "visible";
  await act(async () => {
    document.dispatchEvent(new window.Event("visibilitychange"));
    await settle();
  });
  assert.equal((await store.desktopGetDocument(remoteDocument.docId)).document.content, remoteDocument.content);

  navigator.onLine = false;
  const beforeOffline = requests.length;
  remoteDocument = { ...remoteDocument, content: "Cloud edit while offline", revision: remoteDocument.revision + 1 };
  await act(async () => { await advance(30_000); });
  assert.equal(requests.length, beforeOffline, "offline clients do not poll");
  navigator.onLine = true;
  await act(async () => {
    window.dispatchEvent(new window.Event("online"));
    await settle();
  });
  assert.equal((await store.desktopGetDocument(remoteDocument.docId)).document.content, remoteDocument.content, "reconnection refreshes cloud changes even after successful initialization");

  const beforeFailedCheckStatuses = statuses.length;
  harness.fail = true;
  await act(async () => { await advance(30_000); });
  assert.equal(statuses.length, beforeFailedCheckStatuses, "failed cloud checks do not turn a clean account into sync failed");
  harness.fail = false;
  remoteDocument = { ...remoteDocument, content: "Cloud edit recovered after check failure", revision: remoteDocument.revision + 1 };
  await act(async () => { await advance(30_000); });
  assert.equal((await store.desktopGetDocument(remoteDocument.docId)).document.content, remoteDocument.content);

  const partialRemoteDocument = { ...cloudCreated, docId: "cloud-partial" };
  additionalRemoteDocuments = [partialRemoteDocument];
  remoteDocument = { ...remoteDocument, content: "Cloud update before a later read fails", revision: remoteDocument.revision + 1 };
  harness.beforeFetch = async (path) => {
    if (path === `/api/documents/${partialRemoteDocument.docId}`) throw new Error("desktop_sync_failed");
  };
  const beforePartialStatuses = statuses.length;
  await act(async () => { await advance(30_000); });
  assert.equal((await store.desktopGetDocument(remoteDocument.docId)).document.content, remoteDocument.content);
  assert.ok(statuses.length > beforePartialStatuses, "partially applied cloud updates must still notify subscribers when a later read fails");
  assert.ok(statuses.slice(beforePartialStatuses).every((summary) => summary.state === "idle"), "partial background failures do not show a sync error");
  harness.beforeFetch = async () => {};
  await act(async () => { await advance(30_000); });
  assert.equal((await store.desktopGetDocument(partialRemoteDocument.docId)).document.content, partialRemoteDocument.content, "a later check recovers the rest of a partially applied snapshot");
  additionalRemoteDocuments = [];
  await act(async () => { await advance(30_000); });

  harness.localMode = true;
  const beforeLocalMode = requests.length;
  await act(async () => {
    await advance(30_000);
    window.dispatchEvent(new window.Event("focus"));
    await settle();
  });
  assert.equal(requests.length, beforeLocalMode, "local-only mode never checks cloud updates");
  harness.localMode = false;

  await act(async () => { await advance(1000); });
  const beforeDraftCheck = requests.length;
  const draftImageID = "c18dff20-8efd-4eaa-8a7e-717fbd27d885";
  const draftContent = `Unsaved editor draft before cloud refresh\n\n![Draft](koinote-local-image://${draftImageID})`;
  sqlite.prepare(`
    INSERT INTO offline_images (account_id, image_id, content_type, base64_data, byte_size, created_at, is_local_origin)
    VALUES ('account-1', ?, 'image/png', ?, ?, ?, 1)
  `).run(draftImageID, "iVBORw0KGgo=", 8, new Date().toISOString());
  harness.prepare = async () => {
    harness.prepare = async () => true;
    await edit(draftContent);
    return true;
  };
  remoteDocument = { ...remoteDocument, content: "Cloud changed while editor had a draft", revision: remoteDocument.revision + 1 };
  await act(async () => { await store.desktopCheckRemoteUpdates(); });
  const draftConflicts = await store.desktopListConflicts();
  assert.equal(draftConflicts.length, 1, "remote checks preserve both versions when an editor draft exists");
  assert.equal(draftConflicts[0].local.content, draftContent);
  assert.equal(draftConflicts[0].remote.content, remoteDocument.content);
  assert.ok(requests.slice(beforeDraftCheck).every((request) => !request.method || request.method === "GET"), "checking cloud changes must not upload the draft before its idle timer");
  assert.equal(sqlite.prepare("SELECT remote_url FROM offline_images WHERE image_id = ?").get(draftImageID).remote_url, null, "cloud checks must leave pending local images unuploaded");
  await act(async () => {
    await store.resolveDesktopConflict(remoteDocument.docId, "remote");
    sqlite.prepare("DELETE FROM offline_images WHERE image_id = ?").run(draftImageID);
    await store.syncDesktopNow({ force: true });
    await advance(20_000);
  });

  let releaseRemoteRead;
  let markRemoteRead;
  const remoteReadGate = new Promise((resolve) => { releaseRemoteRead = resolve; });
  const remoteReadStarted = new Promise((resolve) => { markRemoteRead = resolve; });
  harness.beforeFetch = async (path) => {
    if (path !== "/api/documents") return;
    harness.beforeFetch = async () => {};
    markRemoteRead();
    await remoteReadGate;
  };
  await act(async () => {
    const remoteRead = store.desktopCheckRemoteUpdates();
    await remoteReadStarted;
    await edit("Upload timer expires during read-only check");
    await advance(20_000, false);
    releaseRemoteRead();
    await remoteRead;
    await advance(0);
  });
  assert.equal(remoteDocument.content, "Upload timer expires during read-only check", "cloud checks must not consume pending upload wakeups");
  assert.equal((await store.desktopSyncSummary()).pending, 0);
  await act(async () => root.render(null));
  const beforeUnmounted = requests.length;
  await advance(60_000);
  window.dispatchEvent(new window.Event("focus"));
  document.dispatchEvent(new window.Event("visibilitychange"));
  await settle();
  assert.equal(requests.length, beforeUnmounted, "unmounting stops remote check timers and listeners");
  console.log("desktop autosync startup, read-only cloud checks, drafts, debounce, reconnect, manual and in-flight checks passed");
} finally {
  await act(async () => root.unmount());
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  Date.now = originalDateNow;
  sqlite.close();
  delete globalThis.__desktopAutosyncTest;
}
