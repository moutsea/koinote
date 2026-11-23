import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";

const directory = mkdtempSync(`${process.cwd()}/scripts/.draft-recovery-`);
const previousFetch = globalThis.fetch;
let root, client, act; const clients = [];
try {
  const result = await build({ stdin: { contents: `export {useDocumentSaver} from './components/editor/useDocumentSaver';export {sessionQueryOptions,useLogout} from './auth';export {conflictDraftKey} from './conflictDrafts';`, resolveDir: `${process.cwd()}/spa/src` }, bundle: true, write: false, format: "esm", platform: "node", packages: "external", logLevel: "error" });
  const file = `${directory}/draft.mjs`; writeFileSync(file, result.outputFiles[0].text);
  const { window } = parseHTML("<html><body><div id='app'></div></body></html>");
  globalThis.window = window; globalThis.document = window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const storage = new Map(); let failWrites = false, failScopedWrites = false, writes = 0;
  window.localStorage = {
    get length() { return storage.size; }, key: index => [...storage.keys()][index] ?? null,
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => { writes++; if (failWrites || (failScopedWrites && key.startsWith("koinote:conflict-draft:A:"))) throw new Error("QuotaExceededError"); storage.set(key, String(value)); },
    removeItem: key => storage.delete(key),
  };
  const [{default: React, act: reactAct}, {createRoot}, {QueryClient, QueryClientProvider}, api] = await Promise.all([import("react"), import("react-dom/client"), import("@tanstack/react-query"), import(pathToFileURL(file).href)]);
  act = reactAct; let owner = "A", delayedSave, saver, logout;
  globalThis.fetch = async (path, init = {}) => {
    if (path === "/api/auth/session") return Response.json({user: {authUserId: owner}});
    if (path === "/api/auth/logout") return Response.json({success: true});
    if (init.method === "PUT" && path.endsWith("/retired-image")) return Response.json({code:"image_unavailable"},{status:409});
    if (init.method === "PUT") return delayedSave ?? (path.endsWith("/ordinary") ? Response.json({code: "server_error"}, {status: 503}) : Response.json({code: "document_revision_conflict"}, {status: 409}));
    throw Error(`Unexpected request ${path}`);
  };
  function Harness({account}) { saver = api.useDocumentSaver(undefined, account); logout = api.useLogout(); return null; }
  const flush = async work => act(async () => { await work?.(); await new Promise(resolve => setTimeout(resolve, 5)); });
  const open = async account => {
    client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: Infinity}, mutations: {gcTime: Infinity}}}); clients.push(client);
    await client.fetchQuery(api.sessionQueryOptions(client));
    root = createRoot(document.getElementById("app"));
    await flush(() => root.render(React.createElement(QueryClientProvider, {client}, React.createElement(Harness, {account}))));
  };
  const close = async () => { const old = saver; await flush(() => root.unmount()); root = null; await old.flushAll(); };
  const base = {title: "Article", content: "Cloud body", theme: "minimal", revision: 1};
  await open("A");
  await flush(async () => { saver.seed("doc", base); saver.queue("doc", {content: "Unique unsaved text"}); assert.equal(await saver.flush("doc"), false); });
  const retiredContent="Unsaved edits with ![image](/images/u/A/"+"a".repeat(32)+".png)";
  await flush(async()=>{saver.seed("retired-image",base);saver.queue("retired-image",{content:retiredContent});assert.equal(await saver.flush("retired-image"),false);});
  assert.equal(saver.status("retired-image"),"backed-up","an expired image is not a revision conflict and must preserve the edit");
  assert.equal(saver.errorCode("retired-image"),"image_unavailable","the editor must be able to explain why retrying keeps failing");
  assert.equal(JSON.parse(storage.get(api.conflictDraftKey("retired-image","A"))).content,retiredContent);
  const keyA = api.conflictDraftKey("doc", "A");
  assert.equal(JSON.parse(storage.get(keyA)).content, "Unique unsaved text");
  await close();
  await open("A"); // A fresh session/client is a reload, not an account switch.
  await flush(() => saver.seed("doc", {...base, revision: 2}));
  assert.equal(saver.peek("doc").content, "Unique unsaved text"); assert.equal(saver.status("doc"), "conflict");
  await flush(async () => { saver.seed("ordinary",base); saver.queue("ordinary",{content:"Unsaved after server failure"}); assert.equal(await saver.flush("ordinary"),false); });
  assert.equal(saver.status("ordinary"),"backed-up"); await close(); await open("A");
  await flush(()=>{saver.seed("doc",{...base,revision:2});saver.seed("ordinary",base);});
  assert.equal(saver.peek("ordinary").content,"Unsaved after server failure"); assert.equal(saver.status("ordinary"),"backed-up");
  const legacy = {...base, content: "Legacy recovery", conflict: false};
  storage.set(api.conflictDraftKey("legacy"), JSON.stringify(legacy));
  await flush(() => saver.seed("legacy", base));
  assert.equal(saver.peek("legacy").content, "Legacy recovery");
  assert.equal(storage.has(api.conflictDraftKey("legacy")), false);
  assert.equal(JSON.parse(storage.get(api.conflictDraftKey("legacy", "A"))).content, "Legacy recovery");
  storage.set(api.conflictDraftKey("legacy-full"), JSON.stringify(legacy)); failScopedWrites = true;
  await flush(() => saver.seed("legacy-full", base));
  await flush(async () => { saver.queue("legacy-full", {content: "Latest legacy text"}); await saver.flush("legacy-full"); });
  assert.equal(JSON.parse(storage.get(api.conflictDraftKey("legacy-full"))).content, "Latest legacy text");
  const writesBeforeRetry = writes; await flush(() => saver.flush("legacy-full"));
  assert.equal(writes, writesBeforeRetry, "unchanged backups must not be written repeatedly"); failScopedWrites = false;
  storage.set(api.conflictDraftKey("backup-failure", "A"), JSON.stringify({...base, content: "Older backup"}));
  await flush(() => saver.seed("backup-failure", base));
  failWrites = true;
  await flush(async () => { saver.queue("backup-failure", {content: "Latest unsaved text"}); assert.equal(await saver.flush("backup-failure"), false); });
  failWrites = false;
  assert.equal(storage.has(api.conflictDraftKey("backup-failure", "A")), false, "a failed new backup must not restore stale content later");
  const keyB = api.conflictDraftKey("doc", "B"); storage.set(keyB, JSON.stringify({...base, content: "Private B", conflict: false}));
  let resolveSave; delayedSave = new Promise(resolve => { resolveSave = resolve; });
  let saving; await flush(() => { saver.queue("doc", {content: "Late A"}); saving = saver.flush("doc"); });
  const previousADraft = storage.get(keyA);
  owner = "B"; await flush(() => client.fetchQuery({...api.sessionQueryOptions(client), staleTime: 0}));
  assert.equal(storage.get(keyA), previousADraft); assert.equal(JSON.parse(storage.get(keyB)).content, "Private B");
  await flush(async () => { resolveSave(Response.json({code: "document_revision_conflict"}, {status: 409})); await saving; }); delayedSave = null;
  assert.equal(storage.get(keyA), previousADraft, "a late old-account error must not replace the preserved draft"); assert.equal(JSON.parse(storage.get(keyB)).content, "Private B");
  await close(); await open("B"); await flush(() => saver.seed("doc", base));
  assert.equal(saver.peek("doc").content, "Private B");
  // A supported legacy fallback must be discarded by explicit logout too.
  storage.set(api.conflictDraftKey("legacy-logout"), JSON.stringify({...base,content:"Private legacy fallback"}));
  const foreignLegacy=api.conflictDraftKey("foreign-legacy");
  storage.set(foreignLegacy,JSON.stringify({...base,owner:"C",content:"Keep another account"}));
  failScopedWrites=true;
  // The test adapter previously blocked only A's scoped key; block this migration
  // explicitly while still allowing replacement of the existing legacy entry.
  const originalSet=window.localStorage.setItem;
  window.localStorage.setItem=(key,value)=>{if(key===api.conflictDraftKey("legacy-logout","B"))throw new Error("QuotaExceededError");return originalSet(key,value);};
  await flush(()=>saver.seed("legacy-logout",base));
  await flush(async()=>{saver.queue("legacy-logout",{content:"Latest private legacy fallback"});await saver.flush("legacy-logout");});
  assert.equal(JSON.parse(storage.get(api.conflictDraftKey("legacy-logout"))).owner,"B");
  window.localStorage.setItem=originalSet;failScopedWrites=false;
  const keyC = api.conflictDraftKey("other", "C"); storage.set(keyC, JSON.stringify(base));
  await flush(() => logout()); assert.equal(storage.has(keyB), false); assert.equal(storage.has(keyC), true);
  assert.equal(storage.has(api.conflictDraftKey("legacy-logout")),false);
  assert.equal(storage.has(foreignLegacy),true);
  console.log("draft recovery: same-account reload, legacy migration, backup failure, account namespaces, late saves and scoped logout passed");
} finally {
  if (root && act) await act(async () => root.unmount());
  for (const value of clients) value.clear();
  globalThis.fetch = previousFetch; rmSync(directory, {recursive: true, force: true});
}
