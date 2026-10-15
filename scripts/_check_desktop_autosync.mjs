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
let organizationMetadataWrites = 0;
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
    async execute(sql, values = []) {
      if (sql.includes("INSERT INTO offline_meta") && sql.includes("'document-organization-metadata'")) organizationMetadataWrites++;
      return { rowsAffected: Number(sqlite.prepare(sql).run(bind(values)).changes) };
    },
  },
  async fetch(path, init = {}) {
    requests.push({ path, ...init });
    if (harness.fail) throw new Error("desktop_sync_failed");
    await harness.beforeFetch(path, init);
    if (path === "/api/tree/delete" && init.method === "POST" && harness.staleTrash) {
      const { items } = JSON.parse(init.body);
      harness.trashRequests.push({ batch: items.map(item => [item.id, item.revision]) });
      if (items.some(item => harness.staleTrash.has(item.id))) return Response.json({ code: "document_revision_conflict" }, { status: 409 });
      return Response.json({ ok: true });
    }
    // Folder deletes queued by the cascade checks above.
    if (harness.staleTrash && init.method === "DELETE" && path.startsWith("/api/folders/")) return Response.json({ ok: true });
    if (harness.staleTrash && init.method === "DELETE" && path.startsWith("/api/documents/")) {
      harness.trashRequests.push({ single: decodeURIComponent(path.slice("/api/documents/".length)) });
      return Response.json({ success: true });
    }
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
  // Organization changes metadata without changing the content revision.
  const beforeMetadata = organizationMetadataWrites;
  await act(async () => {
    await store.syncDesktopNow({ force: true, pullOnly: true, strictPull: true });
    await store.syncDesktopNow({ force: true, pullOnly: true, strictPull: true });
  });
  assert.equal(organizationMetadataWrites, beforeMetadata, "unchanged metadata must not be rewritten");
  remoteDocument = { ...remoteDocument, tags: ["Organized"], organizedAt: "2026-10-14T04:00:00Z", updatedAt: "2026-10-14T04:00:00Z" };
  await act(async () => { await store.syncDesktopNow({ force: true, pullOnly: true, strictPull: true }); });
  assert.equal(organizationMetadataWrites, beforeMetadata + 1);
  const organizedSummary = (await store.desktopListDocuments()).documents.find(doc => doc.docId === remoteDocument.docId);
  assert.deepEqual(organizedSummary.tags, ["Organized"]);
  assert.equal(organizedSummary.updatedAt, remoteDocument.updatedAt, "metadata-only changes must refresh the sidebar timestamp");

  sqlite.prepare("UPDATE offline_documents SET sync_state='conflict',last_error='document_revision_conflict' WHERE doc_id=?").run(remoteDocument.docId);
  const conflictContent = (await store.desktopGetDocument(remoteDocument.docId)).document.content;
  await act(async () => {
    assert.deepEqual(await store.desktopPrepareLibraryForOrganization(), [remoteDocument.docId], "generation excludes conflicts instead of blocking the whole library");
    assert.deepEqual(await store.desktopPrepareLibraryForOrganization(["unrelated-document"]), [remoteDocument.docId], "unrelated conflicts must not block applying or undoing");
    await assert.rejects(store.desktopPrepareLibraryForOrganization([remoteDocument.docId]), /organization_sync_conflict/);
    sqlite.prepare("INSERT INTO offline_folders(account_id,folder_id,name,sync_state) VALUES('account-1','legacy-conflict','Local folder','conflict')").run();
    await assert.rejects(store.desktopPrepareLibraryForOrganization(), /organization_folder_sync_conflict/, "legacy folder conflicts need a specific explanation, not a save error");
    assert.equal(sqlite.prepare("SELECT name FROM offline_folders WHERE folder_id='legacy-conflict'").get().name, 'Local folder');
    sqlite.prepare("DELETE FROM offline_folders WHERE folder_id='legacy-conflict'").run();
    harness.fail = true;
    await assert.rejects(store.desktopPrepareLibraryForOrganization(), /document_save_failed/);
    harness.fail = false;
  });
  assert.equal((await store.desktopGetDocument(remoteDocument.docId)).document.content, conflictContent, "preparation must preserve conflicted local content");
  sqlite.prepare("UPDATE offline_documents SET sync_state='clean',last_error=NULL WHERE doc_id=?").run(remoteDocument.docId);
  await act(async () => root.render(null));
  const beforeUnmounted = requests.length;
  await advance(60_000);
  window.dispatchEvent(new window.Event("focus"));
  document.dispatchEvent(new window.Event("visibilitychange"));
  await settle();
  assert.equal(requests.length, beforeUnmounted, "unmounting stops remote check timers and listeners");

  // Deleting a folder deletes its subtree locally: every nested folder becomes a
  // plain delete (no server cascade) and documents become ordinary trash rows
  // placed under the deleted folder's parent, so restore puts them there.
  const folderRow = sqlite.prepare("INSERT INTO offline_folders(account_id,folder_id,name,parent_folder_id,sync_state) VALUES('account-1',?,?,?,'clean')");
  const documentRow = sqlite.prepare("INSERT INTO offline_documents(account_id,doc_id,title,folder_id,local_revision,base_revision,sync_state) VALUES('account-1',?,?,?,2,2,?)");
  folderRow.run("cascade-outer", "Outer", null);
  folderRow.run("cascade-parent", "Parent", "cascade-outer");
  folderRow.run("cascade-child", "Child", "cascade-parent");
  folderRow.run("cascade-sibling", "Sibling", "cascade-outer");
  documentRow.run("cascade-doc-1", "One", "cascade-parent", "clean");
  documentRow.run("cascade-doc-2", "Two", "cascade-child", "update");
  documentRow.run("cascade-kept", "Kept", "cascade-sibling", "clean");
  documentRow.run("cascade-conflict", "Conflict", "cascade-sibling", "conflict");
  documentRow.run("cascade-old-trash", "Old trash", "cascade-child", "trash");
  // Offline: the pre-delete sync fails, so unsynced documents must block deletion.
  harness.fail = true;
  await assert.rejects(store.desktopDeleteFolder("cascade-outer"), /folder_delete_sync_conflict/, "a conflicted draft must not be trashed with its folder");
  assert.equal(sqlite.prepare("SELECT sync_state FROM offline_folders WHERE folder_id='cascade-outer'").get().sync_state, "clean", "a rejected delete changes nothing");
  await assert.rejects(store.desktopDeleteFolder("cascade-parent"), /delete_sync_pending/, "an unsynced edit would be lost behind the trash push");
  assert.deepEqual(await store.desktopUnsyncedTrashLoss([{ kind: "folder", id: "cascade-parent" }]), { modified: 1, created: 0 }, "offline, the pre-delete check reports what would be lost");
  sqlite.prepare("UPDATE offline_documents SET sync_state='clean' WHERE doc_id='cascade-doc-2'").run();
  sqlite.prepare("UPDATE offline_documents SET base_revision=0 WHERE doc_id='cascade-doc-1'").run();
  await assert.rejects(store.desktopDeleteFolder("cascade-parent"), /delete_sync_pending/, "a never-uploaded document would vanish instead of reaching the trash");
  assert.deepEqual(await store.desktopUnsyncedTrashLoss([{ kind: "folder", id: "cascade-parent" }]), { modified: 0, created: 1 });
  sqlite.prepare("UPDATE offline_documents SET base_revision=2 WHERE doc_id='cascade-doc-1'").run();
  assert.equal(sqlite.prepare("SELECT sync_state FROM offline_documents WHERE doc_id='cascade-doc-1'").get().sync_state, "clean", "rejected deletes change no document");
  await store.desktopDeleteFolder("cascade-parent");
  harness.fail = false;
  const folderStates = Object.fromEntries(sqlite.prepare("SELECT folder_id, sync_state, last_error FROM offline_folders WHERE folder_id LIKE 'cascade-%'").all().map(row => [row.folder_id, [row.sync_state, row.last_error]]));
  assert.deepEqual(folderStates, {
    "cascade-outer": ["clean", null], "cascade-parent": ["delete", null], "cascade-child": ["delete", null], "cascade-sibling": ["clean", null],
  }, "the whole subtree is deleted with ordinary (non-cascade) folder deletes");
  const documentStates = Object.fromEntries(sqlite.prepare("SELECT doc_id, sync_state, folder_id, folder_dirty FROM offline_documents WHERE doc_id LIKE 'cascade-%'").all().map(row => [row.doc_id, [row.sync_state, row.folder_id, row.folder_dirty]]));
  assert.deepEqual(documentStates, {
    "cascade-doc-1": ["trash", "cascade-outer", 0], "cascade-doc-2": ["trash", "cascade-outer", 0], "cascade-old-trash": ["trash", "cascade-outer", 0],
    "cascade-kept": ["clean", "cascade-sibling", 0], "cascade-conflict": ["conflict", "cascade-sibling", 0],
  }, "subtree documents are trashed under the deleted folder's parent; others are untouched");
  assert.equal((await store.desktopListFolders()).folders.some(folder => folder.folderId === "cascade-child"), false, "deleted subfolders disappear from the tree immediately");
  console.log("desktop cascading folder deletion, conflict and unsynced guards and restore placement passed");

  // Single and batch deletes share the unsynced-content guard. Batch deletes
  // check folders before touching any document, so a rejection is all-or-nothing.
  folderRow.run("batch-folder", "Batch", null);
  documentRow.run("batch-loose", "Loose", null, "clean");
  documentRow.run("batch-pending", "Pending", "batch-folder", "update");
  documentRow.run("batch-pending-root", "Pending root", null, "update");
  sqlite.prepare("INSERT INTO offline_documents(account_id,doc_id,title,content,folder_id,local_revision,base_revision,sync_state) VALUES('account-1','batch-blank','','',NULL,1,0,'create')").run();
  harness.fail = true;
  await assert.rejects(store.desktopTrashDocument("batch-pending-root"), /delete_sync_pending/, "an unsynced edit must not be trashed without confirmation");
  assert.deepEqual(await store.desktopUnsyncedTrashLoss([{ kind: "doc", id: "batch-loose" }]), { modified: 0, created: 0 }, "synced documents need no extra confirmation");
  await store.desktopTrashDocument("batch-blank");
  assert.equal(sqlite.prepare("SELECT sync_state FROM offline_documents WHERE doc_id='batch-blank'").get().sync_state, "trash", "closing an untouched blank document still discards it");
  await assert.rejects(store.desktopDeleteMany([{ kind: "doc", id: "batch-loose" }, { kind: "folder", id: "batch-folder" }]), /delete_sync_pending/);
  assert.equal(sqlite.prepare("SELECT sync_state FROM offline_documents WHERE doc_id='batch-loose'").get().sync_state, "clean", "a rejected batch must not trash the documents listed before the folder");
  await assert.rejects(store.desktopDeleteMany([{ kind: "doc", id: "batch-pending" }, { kind: "folder", id: "batch-folder" }]), /delete_sync_pending/, "selecting an unsynced document inside the folder must not bypass the guard");
  assert.deepEqual(await store.desktopUnsyncedTrashLoss([{ kind: "doc", id: "batch-pending" }, { kind: "folder", id: "batch-folder" }]), { modified: 1, created: 0 }, "a document selected both directly and through its folder is counted once");
  assert.equal(sqlite.prepare("SELECT sync_state FROM offline_documents WHERE doc_id='batch-pending'").get().sync_state, "update");
  assert.equal(sqlite.prepare("SELECT sync_state FROM offline_folders WHERE folder_id='batch-folder'").get().sync_state, "clean");
  // Sync keeps failing: the user can still delete after an explicit confirmation.
  await store.desktopTrashDocument("batch-pending-root", { discardUnsynced: true });
  assert.equal(sqlite.prepare("SELECT sync_state FROM offline_documents WHERE doc_id='batch-pending-root'").get().sync_state, "trash", "a confirmed delete is not blocked by a failing sync");
  await store.desktopDeleteMany([{ kind: "doc", id: "batch-loose" }, { kind: "doc", id: "batch-pending" }, { kind: "folder", id: "batch-folder" }], { discardUnsynced: true });
  harness.fail = false;
  assert.deepEqual(sqlite.prepare("SELECT doc_id, sync_state FROM offline_documents WHERE doc_id IN ('batch-loose','batch-pending') ORDER BY doc_id").all().map(row => [row.doc_id, row.sync_state]),
    [["batch-loose", "trash"], ["batch-pending", "trash"]], "once confirmed, the whole batch is deleted");
  assert.equal(sqlite.prepare("SELECT sync_state FROM offline_folders WHERE folder_id='batch-folder'").get().sync_state, "delete");
  console.log("desktop single and batch delete unsynced guards, confirmed discard and all-or-nothing batches passed");

  // A trashed document edited on another device has a stale base revision. The
  // batch trash push then returns 409; it must fall back to unversioned single
  // deletes (the server trashes the latest version) instead of failing every sync.
  sqlite.prepare("DELETE FROM offline_documents WHERE sync_state='trash' AND doc_id <> 'stale-a'").run();
  documentRow.run("stale-a", "Stale A", null, "trash");
  documentRow.run("stale-b", "Stale B", null, "trash");
  harness.staleTrash = new Set(["stale-a"]);
  harness.trashRequests = [];
  const staleSummary = await store.syncDesktopNow({ force: true });
  assert.equal(staleSummary.message, undefined, `stale trash must not fail the sync: ${staleSummary.message}`);
  assert.deepEqual(harness.trashRequests[0], { batch: [["stale-a", 2], ["stale-b", 2]] }, "trash is first pushed as one revision-checked batch");
  assert.deepEqual(harness.trashRequests.slice(1).map(request => request.single).sort(), ["stale-a", "stale-b"], "a stale revision falls back to unversioned single deletes");
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM offline_documents WHERE doc_id IN ('stale-a','stale-b')").get().n, 0, "pushed trash rows are acknowledged");
  delete harness.staleTrash;
  console.log("desktop trash push recovers from stale revisions passed");
  console.log("desktop autosync startup, read-only cloud checks, drafts, debounce, reconnect, manual and in-flight checks passed");
} finally {
  await act(async () => root.unmount());
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  Date.now = originalDateNow;
  sqlite.close();
  delete globalThis.__desktopAutosyncTest;
}
