import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { parseHTML } from "linkedom";

const directory = mkdtempSync(`${process.cwd()}/scripts/.import-recovery-`);
const harness = { owner: "account-1", saved: [], blocked: true, releases: [] };
globalThis.__importUI = harness;
const api = `export class ApiError extends Error {constructor(status,message,code){super(message);this.status=status;this.code=code;}}
  export const getSession=async()=>{const h=globalThis.__importUI;if(h.sessionGate)await h.sessionGate;if(h.sessionError)throw h.sessionError;return {user:{authUserId:h.owner}}};
  export const createDocument=async (p,owner)=>{const h=globalThis.__importUI;if(owner!==h.owner)throw new ApiError(409,"account changed","import_account_changed");if(h.blocked&&h.saved.length===2)throw new ApiError(409,'limit','document_count_limit_reached');h.saved.push({...p,owner});if(h.switchAfterFirst&&h.saved.length===1)h.owner="account-2";return {document:{docId:String(h.saved.length)}}};
  export const releaseUnusedImages=async keys=>{globalThis.__importUI.releases.push(keys)};
  export const retainImportImages=async()=>({missingKeys:[]});
  export const createFolder=async()=>{throw Error('Unexpected folder')};
  export const uploadImage=async()=>{throw Error('Unexpected upload')};
  export const fetchAppResource=async()=>{throw Error('Unexpected resource')};
  export const getDocument=async()=>{throw Error('Unexpected get')};
  export const trackProductEvent=async()=>{};`;
const mocks = {
  "./api": api,
  "./components/editor/exportDocument": "export const saveExportBlob=async()=>{};export const safeFilename=x=>x;",
  "./importImageCompression": "export const prepareImportedImage=async file=>({file,flattenedAnimation:false});",
  "./importArchive": "export const unpackImportArchiveFile=async()=>{throw Error('Unexpected archive')};",
  "../i18n": "export const useI18n=()=>({t:globalThis.__importUI.copy});export const interpolate=(text,values)=>text.replace(/\\{(\\w+)\\}/g,(_,key)=>String(values[key]??''));",
};
let root, client;
const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
try {
  const compiled = await build({
    stdin: { contents: 'export {useDocumentImport,DocumentImportProvider} from "./useDocumentImport";export {ImportRecoveryActions} from "./components/ImportRecoveryActions";export {ImportTaskNotice} from "./components/ImportTaskNotice";export {zh} from "./i18n/zh";', resolveDir: `${process.cwd()}/spa/src` },
    bundle: true, write: false, format: "esm", platform: "node", packages: "external", jsx: "automatic",
    plugins: [{ name: "import-ui-service-adapters", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: "import-ui-test" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "import-ui-test" }, args => ({ contents: mocks[args.path], resolveDir: process.cwd() }));
    } }],
  });
  const bundle = `${directory}/bundle.mjs`;
  writeFileSync(bundle, compiled.outputFiles[0].text);
  const { window } = parseHTML("<html><head><title>Import test</title></head><body><div id='app'></div></body></html>");
  globalThis.window = window; globalThis.document = window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const [{ default: React, act }, { createRoot }, { QueryClient, QueryClientProvider, useQuery }, { useDocumentImport, DocumentImportProvider, ImportRecoveryActions, ImportTaskNotice, zh }] = await Promise.all([
    import("react"), import("react-dom/client"), import("@tanstack/react-query"), import(pathToFileURL(bundle).href),
  ]);
  harness.copy = zh;
  const files = Array.from({ length: 4 }, (_, i) => new File(["Body"], `${i}.md`));
  function App() {
    const importer = useDocumentImport();
    harness.importer = importer;
    const documents = useQuery({ queryKey: ["documents"], queryFn: async () => harness.saved.length });
    const execute = () => { void importer.run().catch(() => {}); };
    return React.createElement("main", null,
      React.createElement("button", { type: "button", disabled: importer.blocked, "data-start": "true" }, "New import"),
      React.createElement("span", { "data-count": "true" }, String(documents.data ?? 0)),
      React.createElement(ImportRecoveryActions, { ...importer, onResume: execute, onDiscard: importer.discard }));
  }
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  root = createRoot(document.getElementById("app"));
  const render = (owner, page = "import") => root.render(React.createElement(QueryClientProvider, { client },
    React.createElement(DocumentImportProvider, { owner }, React.createElement(React.Fragment,null,React.createElement(ImportTaskNotice),page === "import"
      ? React.createElement(App) : React.createElement("main", null, "Trash page")))));
  const flush = async work => act(async () => { await work?.(); await new Promise(resolve => setTimeout(resolve, 5)); });
  const waitFor = async predicate => { for (let i = 0; i < 100; i++) { await flush(); if (predicate()) return; } throw Error("UI condition timed out"); };
  const button = label => [...document.querySelectorAll("button")].find(item => item.textContent === label);
  await flush(() => render("account-1"));
  await flush(async () => { await assert.rejects(harness.importer.run(files, null)); });
  await waitFor(() => document.querySelector("[data-count]").textContent === "2");
  assert.match(document.querySelector('[role="alert"]').textContent, /2\/4/);
  assert.ok(document.querySelector("[data-start]").disabled, "new imports must not silently replace a paused plan");
  assert.equal(button(zh.transfer.importResume).disabled, false);
  assert.equal(button(zh.transfer.importFinish).type, "button");
  harness.sessionError = new TypeError("Failed to fetch");
  await flush(async () => { await assert.rejects(harness.importer.run()); });
  assert.equal(harness.importer.pending.canResume, true, "a preflight GET failure must preserve safe resume");
  assert.equal(harness.importer.pending.phase, "session-check");
  assert.ok(button(zh.transfer.importResume));
  assert.match(document.querySelector('[role="alert"]').textContent, /暂时无法确认登录状态/);
  assert.doesNotMatch(document.querySelector('[role="alert"]').textContent, /保存结果不确定/);
  assert.equal(harness.saved.length, 2);
  harness.sessionError = null;
  const retained = harness.importer.pending;
  const releasesBeforeNavigation = harness.releases.length;
  await flush(() => render("account-1", "trash"));
  assert.equal(harness.releases.length, releasesBeforeNavigation, "navigation must not discard uploads or the plan");
  harness.blocked = false;
  await flush(() => render("account-1"));
  assert.equal(harness.importer.pending, retained);
  assert.equal(harness.importer.progress.done, 2, "progress survives a route change");
  await flush(() => button(zh.transfer.importResume).click());
  await waitFor(() => !harness.importer.busy && !harness.importer.pending);
  await waitFor(() => document.querySelector("[data-count]").textContent === "4");
  assert.equal(harness.saved.length, 4);
  assert.equal(new Set(harness.saved.map(doc => doc.title)).size, 4);
  assert.equal(document.querySelector('[role="alert"]'), null);
  await flush(() => render("account-1", "trash"));
  assert.match(document.querySelector('[role="status"]').textContent, /已导入 4 篇/);
  await flush(() => render("account-1"));
  assert.match(document.querySelector('[role="status"]').textContent, /已导入 4 篇/);
  await flush(() => button(zh.transfer.importAcknowledge).click());
  assert.equal(document.querySelector('[role="status"]'), null);

  harness.saved = []; harness.blocked = true;
  await flush(async () => { await assert.rejects(harness.importer.run(files, null)); });
  await flush(() => button(zh.transfer.importFinish).click());
  assert.equal(harness.saved.length, 2);
  assert.equal(harness.importer.pending, null);
  assert.equal(document.querySelector("[data-start]").disabled, false);

  harness.saved = []; harness.blocked = true;
  await flush(async () => { await assert.rejects(harness.importer.run(files, null)); });
  harness.owner = "different-cookie-account";
  await flush(async () => { assert.equal(await harness.importer.run(), null); });
  assert.equal(harness.saved.length, 2, "fresh session mismatch must stop a resumed POST");
  assert.equal(harness.importer.pending, null);

  harness.owner = "account-1"; harness.saved = []; harness.blocked = true;
  await flush(async () => { await assert.rejects(harness.importer.run(files, null)); });
  await flush(() => render("account-2"));
  assert.equal(harness.importer.pending, null, "an account switch discards the old plan");
  assert.equal(harness.saved.length, 2);
  assert.equal(await harness.importer.run(), null);
  harness.owner = "account-1";
  await flush(() => render("account-1"));
  let releaseSession;
  harness.sessionGate = new Promise(resolve => { releaseSession = resolve; });
  let running;
  await flush(() => { running = harness.importer.run(files, null); });
  assert.equal(harness.importer.busy, true);
  await flush(() => render("account-1", "trash"));
  await flush(() => render("account-1"));
  assert.equal(harness.importer.busy, true, "an active task and its busy state also survive route changes");
  await flush(() => render("account-2"));
  harness.owner = "account-2";
  releaseSession();
  await flush(async () => { assert.equal(await running, null); });
  harness.sessionGate = null;
  assert.equal(harness.saved.length, 2, "switching accounts cancels a pending preflight before any POST");
  assert.equal(harness.importer.pending, null);
  harness.owner = "account-1"; harness.saved = []; harness.blocked = false; harness.switchAfterFirst = true;
  await flush(() => render("account-1"));
  await flush(async () => { assert.equal(await harness.importer.run(files, null), null); });
  assert.equal(harness.saved.length, 1, "a changed cookie must stop before writing to B");
  assert.equal(harness.saved[0].owner, "account-1");
  assert.equal(harness.importer.pending, null);
  await flush(() => render("account-2"));
  assert.equal(harness.importer.result, null, "account B must never see account A's completion result");
  assert.match(document.querySelector('[role="alert"]').textContent, /账号已变化/);
  await flush(() => button(zh.transfer.importAcknowledge).click());
  assert.equal(document.querySelector('[role="alert"]'), null);
  console.log("import React DOM: cross-page resume, session outage recovery, partial refresh, explicit end and account isolation passed");
  await flush(() => root.unmount()); root = null;
} finally {
  if (root) root.unmount();
  client?.clear();
  globalThis.window = previous.window; globalThis.document = previous.document; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  delete globalThis.__importUI;
  rmSync(directory, { recursive: true, force: true });
}
