import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { parseHTML } from "linkedom";

const require = createRequire(import.meta.url);
const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
document.oninput = null;
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Node.js" }, configurable: true });
const item = {
  docId: "doc", title: "文章", revision: 1, version: 0, folderId: "", tags: [], organizedAt: null,
  suggested: { docId: "doc", folderId: "", newFolders: [], tags: ["商业、营销", "Go"] }, reason: "主题分类",
};
const data = { items: [item], folders: [], createdFolders: [], includeOrganized: false, completed: 1, skipped: 0, providerMode: "builtin", reservedCredits: 1 };
let latest = { id: "preview", status: "ready", data, creditsCharged: 1, errorCode: "" };
let lastApplied = { id: "previous", appliedAt: "2026-10-14T01:00:00Z" };
let detailFailure = false;
let desktopMode = false;
let localConflicts = [];
let undoSkippedItems = [];
const savedPreviews = new Map();
let confirmDiscard = false;
const calls = { undo: [], apply: [], confirm: 0, estimate: [], create: [], prepare: [] };
// Library shown in the document picker before generating.
let libraryFolders = [
  { folderId: "aug", name: "2026年8月", parentFolderId: null, organizerKind: "smart" },
  { folderId: "week", name: "第 3 周", parentFolderId: "aug", organizerKind: "smart" },
  { folderId: "work", name: "Work", parentFolderId: null, organizerKind: null },
];
let libraryDocuments = [
  { docId: "doc", title: "文章", folderId: "week", sortOrder: 0, revision: 1, organizedAt: "2026-08-20T00:00:00Z" },
  { docId: "conflict-doc", title: "冲突", folderId: "week", sortOrder: 1, revision: 1, organizedAt: null },
  { docId: "filed", title: "已归类", folderId: "work", sortOrder: 0, revision: 1, organizedAt: "2026-09-01T00:00:00Z" },
  { docId: "fresh", title: "新文章", folderId: null, sortOrder: 0, revision: 1, organizedAt: null },
];
globalThis.__organizerTest = {
  libraryDocuments: () => structuredClone(libraryDocuments),
  libraryFolders: () => structuredClone(libraryFolders),
  desktop: () => desktopMode,
  prepare: async ids => { calls.prepare.push(ids); return [...localConflicts]; },
  estimate: async (docIds, exclude) => { calls.estimate.push({ docIds, exclude }); return { count: docIds.length, skipped: 0, reservedCredits: 1, providerMode: 'builtin' }; },
  create: async (id, docIds, estimate, exclude) => {
    assert.ok(desktopMode, 'unexpected generation'); calls.create.push({ id, docIds, exclude });
    latest = { id, status: 'ready', data, creditsCharged: 1, errorCode: '' };
    return structuredClone({ organization: latest });
  },
  latest: async () => structuredClone({ organization: latest, lastApplied }),
  get: async id => {
    const organization = id === latest?.id ? latest : savedPreviews.get(id) ?? (id === lastApplied?.id ? { ...latest, id, status: "applied", data: { ...data, items: [{ ...item, appliedVersion: 1 }] } } : undefined);
    assert.ok(organization, `unknown preview ${id}`);
    if (detailFailure) { detailFailure = false; throw new Error("temporary failure"); }
    return structuredClone({ organization });
  },
  confirm: async () => { calls.confirm++; return confirmDiscard; },
  undo: async id => {
    calls.undo.push(id); lastApplied = null;
    const source = id === latest?.id ? latest : savedPreviews.get(id) ?? latest;
    const organization = { ...source, id, status: "undone", data: { ...source.data, items: [...source.data.items, ...undoSkippedItems] } };
    if (latest?.id === id) latest = organization;
    savedPreviews.set(id, organization);
    return structuredClone({ organization });
  },
  apply: async (id, items, orders = []) => {
    calls.apply.push({ id, items, ...(orders.length ? {orders} : {}) });
    const organization = { ...(id === latest.id ? latest : savedPreviews.get(id)), status: "applied" };
    savedPreviews.set(id, organization);
    if (latest.id === id) latest = organization;
    lastApplied = { id, appliedAt: "2026-10-14T02:00:00Z" };
    return structuredClone({ organization });
  },
};
const adapters = {
  "../../api": `const test=globalThis.__organizerTest;
    export class ApiError extends Error { constructor(status,message,code) { super(message); this.status=status; this.code=code; } }
    export const AGENT_CREDITS_QUERY_KEY=['agent-credits'];
    export const latestDocumentOrganization=test.latest;
    export const getDocumentOrganization=test.get;
    export const undoDocumentOrganization=test.undo;
    export const applyDocumentOrganizationPreview=test.apply;
    export const estimateDocumentOrganization=test.estimate;
    export const createDocumentOrganization=test.create;
    export const listDocuments=async()=>({documents:test.libraryDocuments()});
    export const listFolders=async()=>({folders:test.libraryFolders()});`,
  "../../i18n": "export const useI18n=()=>({t:globalThis.__organizerLabels}); export const interpolate=(text,values)=>text.replace(/\\{(\\w+)\\}/g,(_,key)=>String(values[key]));",
  "../../confirmAction": "export const confirmAction=globalThis.__organizerTest.confirm;",
  "../../modalStack": "export const pushModal=()=>()=>{};",
  "../../desktop/runtime": "export const isDesktopRuntime=globalThis.__organizerTest.desktop;",
  "../../desktop/offlineStore": "export const desktopPrepareLibraryForOrganization=globalThis.__organizerTest.prepare; export const syncDesktopNow=async()=>({state:'idle'});",
  "../Logo": "export const Logo=()=>null;",
  "@tanstack/react-router": "export const Link=()=>null; export const useNavigate=()=>()=>{};",
  "lucide-react": "const Icon=()=>null; export const ArrowUp=Icon, ArrowDown=Icon, ArrowRight=Icon, Check=Icon, Folder=Icon, LoaderCircle=Icon, Plus=Icon, RotateCcw=Icon, X=Icon, ChevronDown=Icon, ChevronRight=Icon, FileText=Icon, FolderPlus=Icon, GripVertical=Icon, Search=Icon, Tags=Icon;",
};
const bundle = await build({
  stdin: { contents: `export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client';
    export {QueryClient,QueryClientProvider} from '@tanstack/react-query';
    export {AIOrganizerDialog} from './spa/src/components/editor/AIOrganizerDialog'; export {zh} from './spa/src/i18n/zh';`, resolveDir: process.cwd() },
  bundle: true, format: "esm", platform: "node", write: false, jsx: "automatic",
  plugins: [{ name: "organizer-test-adapters", setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(adapters, path) ? { path, namespace: "organizer-test" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "organizer-test" }, ({ path }) => ({ contents: adapters[path] }));
    builder.onResolve({ filter: /^(?:react(?:-dom)?(?:\/|$)|@tanstack\/react-query$)/ }, ({ path }) => ({ path: pathToFileURL(require.resolve(path)).href, external: true }));
  } }],
});
const { createElement, act, createRoot, QueryClient, QueryClientProvider, AIOrganizerDialog, zh } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
globalThis.__organizerLabels = zh;
const labels = zh.editor.aiOrganizer;
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
const root = createRoot(document.getElementById("root"));
const render = () => act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(AIOrganizerDialog, { member: true, localMode: false, onPrepare: async () => true, onClose: () => {} }))));
const button = text => [...document.querySelectorAll("button")].find(element => element.textContent === text);
const waitFor = async predicate => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
  }
  assert.fail(`dialog did not reach the expected state: ${document.body.textContent.slice(0, 600)}`);
};
const click = async text => { const target = button(text); assert.ok(target, `button ${text}`); assert.equal(target.disabled, false); await act(async () => { target.click(); if (target.closest("form") && target.getAttribute("type") !== "button") target.closest("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); }); };
const tagInputs = () => [...document.querySelectorAll('article input[aria-label]')].filter(input => input.getAttribute("aria-label").includes(labels.tags));
const openArticle = async (id = "doc") => {
  await waitFor(() => document.querySelector(`[data-preview-document="${id}"] [data-edit-document]`));
  const target = document.querySelector(`[data-preview-document="${id}"] [data-edit-document]`);
  if (target.getAttribute("aria-expanded") !== "true") await act(async () => target.click());
};
try {
  await render();
  await openArticle();
  await waitFor(() => tagInputs().length === 2 && button(labels.undoPrevious));
  assert.deepEqual(tagInputs().map(input => input.value), ["商业、营销", "Go"]);
  await click(labels.addTag);
  const input = tagInputs()[2];
  await act(async () => {
    // Linkedom does not reflect the browser's implicit type="text" default.
    input.type = "text";
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, "人工、保留");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  savedPreviews.set(latest.id, structuredClone(latest));
  latest = { ...latest, id: "other-window", data: { ...data, items: [{ ...item, suggested: { ...item.suggested, tags: ["Other window"] } }] } };
  // Focus/reconnect refreshes both queries in a real browser.
  await act(async () => { await Promise.all([
    client.invalidateQueries({ queryKey: ["document-organization-latest"] }),
    client.invalidateQueries({ queryKey: ["document-organization", "preview"] }),
  ]); });
  assert.deepEqual(tagInputs().map(input => input.value), ["商业、营销", "Go", "人工、保留"], "background refresh must retain the selected preview and its edits");
  await click(labels.newRun);
  assert.equal(calls.confirm, 1, "explicitly leaving a dirty preview must request confirmation");
  assert.equal(tagInputs().length, 3, "declining confirmation must retain the preview");
  await click(labels.undoPrevious);
  await waitFor(() => !button(labels.undoPrevious));
  assert.deepEqual(calls.undo, ["previous"]);
  assert.deepEqual(tagInputs().map(input => input.value), ["商业、营销", "Go", "人工、保留"], "undoing the old run must retain edits in the new preview");
  await click(labels.apply.replace("{count}", "1"));
  await waitFor(() => button(labels.undo));
  assert.deepEqual(calls.apply[0], { id: "preview", items: [{ docId: "doc", folderId: "", newFolders: [], tags: ["商业、营销", "Go", "人工、保留"] }] });

  await act(async () => root.render(null)); client.clear();
  latest = { ...latest, id: "failed-preview", status: "failed" }; detailFailure = true;
  undoSkippedItems = [{ ...item, docId: "manual-edit", title: "手动修改的文档", undoSkipped: true }];
  await render();
  await waitFor(() => button(labels.retry) && button(labels.undoPrevious));
  await click(labels.retry);
  await waitFor(() => !button(labels.retry));
  await click(labels.undoPrevious);
  await waitFor(() => !button(labels.undoPrevious));
  assert.deepEqual(calls.undo, ["previous", "preview"], "failed previews must not hide the prior undo action");
  assert.ok(document.body.textContent.includes(labels.undoSkipped.replace("{titles}", "手动修改的文档")), "partial undo of a prior run must show skipped titles even while another preview is selected");
  assert.ok(!document.body.textContent.includes(labels.undone), "partial undo must not claim every document was restored");
  undoSkippedItems = [];
  // Reopening refreshes the latest selection, while deleting one document from
  // that preview removes only its draft and keeps the other document's edits.
  await act(async () => root.render(null)); client.clear();
  latest = { ...latest, id: "deletion-preview", status: "ready", data: { ...data, items: [item, { ...item, docId: "deleted-doc", suggested: { ...item.suggested, docId: "deleted-doc" } }] } };
  await render();
  await openArticle();
  await waitFor(() => document.querySelectorAll("[data-preview-document]").length === 2 && tagInputs().length === 2);
  const keptInput = tagInputs()[0];
  await act(async () => {
    keptInput.type = "text";
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(keptInput, "保留修改");
    keptInput.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  latest = { ...latest, data: { ...latest.data, items: [item] } };
  await act(async () => { await client.invalidateQueries({ queryKey: ["document-organization", latest.id] }); });
  await waitFor(() => document.querySelectorAll("[data-preview-document]").length === 1);
  assert.deepEqual(tagInputs().map(input => input.value), ["保留修改", "Go"]);
  await click(labels.apply.replace("{count}", "1"));
  await waitFor(() => calls.apply.length === 2);
  assert.deepEqual(calls.apply[1], { id: "deletion-preview", items: [{ docId: "doc", folderId: "", newFolders: [], tags: ["保留修改", "Go"] }] });
  await act(async () => root.render(null)); client.clear();
  latest = { ...latest, id: "review-preview", status: "ready", data: { ...data, unbilledBatches: 1, items: [{ ...item, needsReview: true }], folders: [
    { id: "folder-a", name: "Same", parentId: "" }, { id: "folder-b", name: "Same", parentId: "" },
  ] } };
  await render();
  await openArticle();
  await waitFor(() => tagInputs().length === 2);
  assert.ok(document.body.textContent.includes(labels.needsReview));
  assert.ok(document.body.textContent.includes(labels.unbilledBatches.replace("{count}", "1")));
  latest = { ...latest, data: { ...latest.data, providerMode: "byok" } };
  await act(async () => { await client.invalidateQueries({ queryKey: ["document-organization", latest.id] }); });
  await waitFor(() => document.body.textContent.includes(labels.invalidBatchesByok.replace("{count}", "1")));
  assert.equal(button(labels.apply.replace("{count}", "0")).disabled, true);
  const options = [...document.querySelectorAll("select[data-destination-select] option")].filter(option => option.value !== '["",[]]');
  assert.equal(options.length, 2);
  assert.notEqual(options[0].textContent, options[1].textContent, "same-name destinations must be distinguishable");
  for (const [stopReason, message] of [["timeout", labels.partialTimeout], ["failure_limit", labels.partialFailureLimit], ["failure_ratio", labels.partialFailureRatio]]) {
    await act(async () => root.render(null)); client.clear();
    latest = { ...latest, id: `partial-${stopReason}`, status: "ready", data: { ...data, stopReason, completed: 1, items: [item, { ...item, docId: "unfinished", title: "未完成的文章", suggested: { ...item.suggested, docId: "unfinished" }, needsReview: true, notAnalyzed: true }] } };
    await render();
    await waitFor(() => document.body.textContent.includes(message.replace("{done}", "1").replace("{total}", "2")));
    assert.ok(document.body.textContent.includes(labels.notAnalyzedShort));
    await openArticle("unfinished");
    assert.ok(document.body.textContent.includes(labels.notAnalyzed));
    assert.ok(!document.body.textContent.includes(labels.needsReview), "unfinished work must not be labeled as an invalid model suggestion");
    assert.deepEqual([...document.querySelectorAll("input[data-preview-include]")].map(input => input.checked), [true, false]);
    assert.equal(button(labels.apply.replace("{count}", "1")).disabled, false, "completed suggestions must remain applicable");
  }
  for (const [status, message] of [[400, labels.providerRejected], [422, labels.providerRejected], [429, labels.providerRateLimited], [503, labels.providerUnavailable]]) {
    await act(async () => root.render(null)); client.clear();
    latest = { ...latest, id: `provider-${status}`, status: "ready", data: { ...data, unbilledBatches: 2, items: [item, { ...item, docId: "second", suggested: { ...item.suggested, docId: "second" } }].map(value => ({ ...value, needsReview: true, failureStatus: status })) } };
    await render();
    await openArticle();
    const diagnostic = message.replace("{status}", status);
    await waitFor(() => document.body.textContent.includes(diagnostic));
    assert.equal([...document.querySelectorAll('[role="status"]')].filter(node => node.textContent === diagnostic).length, 1, "provider errors should be explained once per status");
    assert.ok(document.body.textContent.includes(labels.providerItem.replace("{status}", status)));
    assert.ok(!document.body.textContent.includes(labels.needsReview), "a rejected request must not be labeled as an invalid suggestion");
    assert.deepEqual([...document.querySelectorAll("input[data-preview-include]")].map(input => input.checked), [false, false]);
    assert.equal(button(labels.apply.replace("{count}", "0")).disabled, true);
  }
  latest = { ...latest, status: "applied", data: { ...latest.data, items: [{ ...item, applySkipped: true }] } };
  await act(async () => { await client.invalidateQueries({ queryKey: ["document-organization", latest.id] }); });
  await waitFor(() => document.body.textContent.includes(labels.skippedTrash.replace("{titles}", item.title)));
  await act(async () => root.render(null)); client.clear();
  latest = { ...latest, id: "partial-undo-reload", status: "undone", data: { ...data, items: [{ ...item, undoSkipped: true }] } }; lastApplied = null;
  await render();
  await waitFor(() => document.body.textContent.includes(labels.undoSkipped.replace("{titles}", item.title)));
  assert.ok(!document.body.textContent.includes(labels.undone));
  await act(async () => root.render(null)); client.clear();
  desktopMode = true; localConflicts = ["conflict-doc"]; latest = null; lastApplied = null;
  await render();
  await waitFor(() => button(labels.generate) && !button(labels.generate).disabled);
  assert.deepEqual(calls.estimate.at(-1).exclude, ["conflict-doc"], "estimate must exclude local conflicts");
  // Default: documents in automatic buckets (even previously organized) and
  // never-organized documents; conflicts are shown but cannot be picked.
  assert.deepEqual(calls.estimate.at(-1).docIds, ["doc", "fresh"], "default selection covers automatic buckets and unorganized documents");
  assert.ok(document.body.textContent.includes(labels.excludedConflicts.replace("{count}", "1")));
  assert.ok(document.body.textContent.includes(labels.automaticFolder), "automatic folders are marked in the picker");
  const pickerBox = label => document.querySelector(`input[aria-label="${label}"]`);
  const augBox = pickerBox(labels.selectFolder.replace("{name}", "2026年8月"));
  assert.equal(augBox.checked, true, "a folder whose available documents are all picked is checked");
  // Linkedom's click() neither toggles a checkbox nor dispatches the click React listens to.
  await act(async () => { augBox.checked = !augBox.checked; augBox.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true })); });
  await act(async () => new Promise(resolve => setTimeout(resolve, 400)));
  await waitFor(() => JSON.stringify(calls.estimate.at(-1).docIds) === JSON.stringify(["fresh"]));
  await click(labels.selectAll);
  await act(async () => new Promise(resolve => setTimeout(resolve, 400)));
  await waitFor(() => JSON.stringify(calls.estimate.at(-1).docIds) === JSON.stringify(["doc", "filed", "fresh"]));
  await click(labels.selectNone);
  await waitFor(() => button(labels.generate).disabled);
  assert.ok(document.body.textContent.includes(labels.empty), "an empty selection cannot generate");
  await click(labels.selectDefault);
  await act(async () => new Promise(resolve => setTimeout(resolve, 400)));
  await waitFor(() => !button(labels.generate).disabled && JSON.stringify(calls.estimate.at(-1).docIds) === JSON.stringify(["doc", "fresh"]));
  await click(labels.generate);
  await openArticle();
  await waitFor(() => tagInputs().length === 2);
  assert.deepEqual(calls.create.at(-1).exclude, ["conflict-doc"], "generation must use the same exclusions as its estimate");
  assert.deepEqual(calls.create.at(-1).docIds, ["doc", "fresh"], "generation must organize exactly the picked documents");
  await click(labels.apply.replace("{count}", "1"));
  await waitFor(() => button(labels.undo));
  assert.deepEqual(calls.prepare.at(-1), ["doc"], "apply must check only selected documents for conflicts");
  // Edit the tree in place, then check the submitted plan.
  await act(async () => root.render(null)); client.clear(); desktopMode = false; lastApplied = null;
  const previewFolders = [{ id: "work", name: "Work", parentId: "" }, { id: "empty", name: "Empty", parentId: "" }];
  latest = { id: "tree-preview", status: "ready", creditsCharged: 1, errorCode: "", data: { ...data, folders: previewFolders, items: [
    { ...item, tags: ["Original"], suggested: { ...item.suggested, folderId: "work", newFolders: ["Guides"], tags: ["Go", "营销"] } },
    { ...item, docId: "second", title: "Second", suggested: { docId: "second", folderId: "empty", newFolders: [], tags: ["go", "Notes"] } },
    { ...item, docId: "excluded", title: "Excluded", tags: ["Keep"], needsReview: true, suggested: { docId: "excluded", folderId: "work", newFolders: [], tags: ["Private"] } },
  ] } };
  await render();
  await waitFor(() => document.querySelectorAll("[data-preview-document]").length === 3);
  assert.equal(document.querySelectorAll("aside").length, 0, "preview uses a single tree without a side pane");
  assert.equal(document.querySelectorAll("article").length, 0, "article editors stay collapsed until requested");
  await openArticle();
  assert.equal(document.querySelectorAll("article").length, 1);
  assert.ok(document.querySelector('[data-preview-document="doc"] article'), "article editor must be inside its tree row");
  await openArticle("second");
  assert.equal(document.querySelectorAll("article").length, 1, "opening another row keeps only one inline editor");
  await act(async () => document.querySelector('[data-preview-document="second"] [data-edit-document]').click());
  assert.equal(document.querySelectorAll("article").length, 0, "article can be collapsed again");
  const docRow = id => document.querySelector(`[data-preview-document="${id}"]`);
  const location = id => docRow(id).parentElement.closest("[data-preview-folder]").getAttribute("data-preview-folder");
  const directory = key => [...document.querySelectorAll("[data-preview-folder]")].find(node => node.getAttribute("data-preview-folder") === key);
  const setInput = async (input, value) => act(async () => {
    if (input.type !== "search") input.type = "text";
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  const drag = async (docId, key, local = true) => act(async () => {
    const values = new Map(); const transfer = { setData: (key, value) => values.set(key, value), getData: key => values.get(key) ?? "" };
    const event = type => Object.assign(new window.Event(type, { bubbles: true, cancelable: true }), { dataTransfer: transfer });
    if (local) docRow(docId).querySelector("[data-edit-document]").dispatchEvent(event("dragstart"));
    else transfer.setData("application/x-koinote-organization-document", docId);
    directory(key).firstElementChild.dispatchEvent(event("dragover"));
    directory(key).firstElementChild.dispatchEvent(event("drop"));
  });
  assert.equal(location("doc"), '["work",["Guides"]]');
  assert.equal(location("excluded"), '["",[]]', "unchecked suggestions stay in their original locations");
  await drag("doc", '["empty",[]]', false);
  assert.equal(location("doc"), '["work",["Guides"]]', "external drag payloads must not modify a preview");
  await drag("doc", '["empty",[]]');
  assert.equal(location("doc"), '["empty",[]]');
  await act(async () => directory('["",[]]').firstElementChild.querySelector("[data-create-directory]").click());
  assert.ok(directory('["",[]]').querySelector("form"), "new folder is created inline at its parent");
  await setInput(document.querySelector(`input[aria-label="${labels.directoryName}"]`), "Archive");
  await click(labels.createDirectory);
  assert.ok(directory('["",["Archive"]]'), "new folders must immediately become drop targets");
  await drag("second", '["",["Archive"]]');
  const insertAt = async (docId, anchorId, edge) => {
    const values = new Map(); const transfer = {setData:(key,value)=>values.set(key,value),getData:key=>values.get(key)??""};
    const target = docRow(anchorId);
    target.getBoundingClientRect = () => ({top:10,height:40});
    const event = type => Object.assign(new window.Event(type,{bubbles:true,cancelable:true}),{dataTransfer:transfer,clientY:edge==="before"?15:45});
    const priorNotice = [...document.querySelectorAll('[role="status"]')].map(node=>node.textContent);
    await act(async () => {
      docRow(docId).querySelector("[data-edit-document]").dispatchEvent(event("dragstart"));
      target.dispatchEvent(event("dragover"));
    });
    assert.deepEqual([...document.querySelectorAll('[role="status"]')].map(node=>node.textContent),priorNotice,"starting a drag must not shift drop targets by removing a notice");
    assert.equal(target.querySelector("[data-preview-insertion]")?.getAttribute("data-preview-insertion"),edge,"show the insertion point before committing a drop");
    await act(async () => target.dispatchEvent(event("drop")));
    assert.equal(document.querySelector("[data-preview-insertion]"),null,"clear insertion marker after dropping");
  };
  await insertAt("doc", "second", "before");
  assert.equal(location("doc"), '["",["Archive"]]', "dropping on an article also changes the destination folder");
  await insertAt("doc", "second", "after");
  assert.deepEqual([...directory('["",["Archive"]]').querySelectorAll("[data-preview-document]")].map(node=>node.getAttribute("data-preview-document")),["second","doc"]);
  const orderedRows = () => [...directory('["",["Archive"]]').querySelectorAll("[data-preview-document]")].map(node => node.getAttribute("data-preview-document"));
  assert.equal(docRow("second").querySelector('[data-move-document="up"]').disabled, true);
  assert.equal(docRow("doc").querySelector('[data-move-document="down"]').disabled, true);
  assert.equal(docRow("doc").querySelector('[data-move-document="up"]').getAttribute("aria-label"), labels.moveUp.replace("{title}", item.title));
  await act(async () => docRow("doc").querySelector('[data-move-document="up"]').click());
  assert.deepEqual(orderedRows(), ["doc", "second"], "row buttons reorder without a mouse drag");
  await act(async () => docRow("doc").querySelector('[data-move-document="down"]').click());
  assert.deepEqual(orderedRows(), ["second", "doc"], "down button restores the intended submitted order");
  await click(labels.manageTags);
  assert.equal(button(labels.manageTags).getAttribute("aria-expanded"), "true");
  await click(labels.renameTag);
  await setInput(document.querySelector(`input[aria-label="${labels.renameTag}"]`), "Notes");
  await click(labels.saveTag);
  await act(async () => document.querySelector(`button[aria-label="${labels.removeTag}: 营销"]`).click());
  await setInput(document.querySelector(`input[aria-label="${labels.bulkTag}"]`), "Reviewed");
  await click(labels.addTag);
  await click(labels.manageTags);
  assert.equal(button(labels.manageTags).getAttribute("aria-expanded"), "false");
  assert.equal(document.querySelector("#organization-tag-manager"), null, "bulk tag controls collapse back into the toolbar");
  await openArticle();
  assert.deepEqual(tagInputs().map(input => input.value), ["Notes", "Reviewed"], "inline editor reflects bulk updates");
  await setInput(tagInputs()[1], "Reviewed inline");
  await act(async () => docRow("doc").querySelector("[data-edit-document]").click());
  await openArticle();
  assert.equal(tagInputs()[1].value, "Reviewed inline", "collapsing a row must preserve its edits");
  await setInput(tagInputs()[1], "Reviewed");
  await setInput(document.querySelector('input[type="search"]'), "Notes");
  assert.equal(document.querySelectorAll("[data-preview-document]").length, 2, "tree search includes effective tags");
  await setInput(document.querySelector('input[type="search"]'), "");
  assert.ok(docRow("excluded").textContent.includes("Keep"), "excluded articles retain their effective tags");
  await click(labels.apply.replace("{count}", "2"));
  await waitFor(() => button(labels.undo));
  assert.deepEqual(calls.apply.at(-1), { id: "tree-preview", items: [
    { docId: "doc", folderId: "", newFolders: ["Archive"], tags: ["Notes", "Reviewed"] },
    { docId: "second", folderId: "", newFolders: ["Archive"], tags: ["Notes", "Reviewed"] },
  ], orders: [
    {folderId:"",newFolders:["Archive"],docIds:["second","doc"]},
  ] }, "apply must submit exactly the dragged destinations and managed tags, excluding unchecked documents");
  await act(async () => root.render(null)); client.clear(); lastApplied = null;
  const timeFolders = [
    { id: "month", name: "2026年8月", parentId: "", documentCount: 0 },
    { id: "week", name: "第 2 周", parentId: "month", documentCount: 1 },
  ];
  latest = { id: "calendar-preview", status: "ready", creditsCharged: 1, errorCode: "", data: {
    ...data, folders: timeFolders, timeFolders,
    items: [{ ...item, folderId: "week", suggested: { ...item.suggested, newFolders: ["Topics"] } }],
  } };
  await render(); await waitFor(() => document.querySelector('[data-preview-document="doc"]'));
  assert.equal(directory('["month",[]]'), undefined, "an obsolete empty time branch must not render in the result tree");
  assert.equal(location("doc"), '["",["Topics"]]');
  assert.ok(document.body.textContent.includes(labels.cleanupTimeFolders.replace("{count}", "2")), "explain that empty date folders will be removed on apply");
  latest = { ...latest, data: { ...latest.data, timeFolders: timeFolders.map(folder => ({ ...folder, documentCount: folder.id === "week" ? 2 : 0 })) } };
  await act(async () => client.setQueryData(["document-organization", latest.id], { organization: latest }));
  await waitFor(() => directory('["week",[]]'));
  assert.ok(directory('["week",[]]'), "folder occupancy refresh preserves documents outside the editable preview");
  console.log("AI organizer dialog: lossless tags, pinned preview, discard protection, deleted-item pruning, prior undo and reload passed");
} finally {
  await act(async () => root.unmount()); client.clear();
}
