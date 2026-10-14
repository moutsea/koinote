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
globalThis.__organizerTest = {
  desktop: () => desktopMode,
  prepare: async ids => { calls.prepare.push(ids); return [...localConflicts]; },
  estimate: async (include, exclude) => { calls.estimate.push({ include, exclude }); return { count: 1, skipped: 0, reservedCredits: 1, providerMode: 'builtin' }; },
  create: async (id, include, estimate, exclude) => {
    assert.ok(desktopMode, 'unexpected generation'); calls.create.push({ id, include, exclude });
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
  apply: async (id, items) => {
    calls.apply.push({ id, items });
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
    export const createDocumentOrganization=test.create;`,
  "../../i18n": "export const useI18n=()=>({t:globalThis.__organizerLabels}); export const interpolate=(text,values)=>text.replace(/\\{(\\w+)\\}/g,(_,key)=>String(values[key]));",
  "../../confirmAction": "export const confirmAction=globalThis.__organizerTest.confirm;",
  "../../modalStack": "export const pushModal=()=>()=>{};",
  "../../desktop/runtime": "export const isDesktopRuntime=globalThis.__organizerTest.desktop;",
  "../../desktop/offlineStore": "export const desktopPrepareLibraryForOrganization=globalThis.__organizerTest.prepare; export const syncDesktopNow=async()=>({state:'idle'});",
  "../Logo": "export const Logo=()=>null;",
  "@tanstack/react-router": "export const Link=()=>null; export const useNavigate=()=>()=>{};",
  "lucide-react": "const Icon=()=>null; export const ArrowRight=Icon, Check=Icon, Folder=Icon, LoaderCircle=Icon, Plus=Icon, RotateCcw=Icon, X=Icon;",
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
  assert.fail("dialog did not reach the expected state");
};
const click = async text => { const target = button(text); assert.ok(target, `button ${text}`); assert.equal(target.disabled, false); await act(async () => target.click()); };
const tagInputs = () => [...document.querySelectorAll('input[aria-label]')].filter(input => input.getAttribute("aria-label").includes(labels.tags));
try {
  await render();
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
  await waitFor(() => tagInputs().length === 4);
  const keptInput = tagInputs()[0];
  await act(async () => {
    keptInput.type = "text";
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(keptInput, "保留修改");
    keptInput.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  latest = { ...latest, data: { ...latest.data, items: [item] } };
  await act(async () => { await client.invalidateQueries({ queryKey: ["document-organization", latest.id] }); });
  await waitFor(() => tagInputs().length === 2);
  assert.deepEqual(tagInputs().map(input => input.value), ["保留修改", "Go"]);
  await click(labels.apply.replace("{count}", "1"));
  await waitFor(() => calls.apply.length === 2);
  assert.deepEqual(calls.apply[1], { id: "deletion-preview", items: [{ docId: "doc", folderId: "", newFolders: [], tags: ["保留修改", "Go"] }] });
  await act(async () => root.render(null)); client.clear();
  latest = { ...latest, id: "review-preview", status: "ready", data: { ...data, unbilledBatches: 1, items: [{ ...item, needsReview: true }], folders: [
    { id: "folder-a", name: "Same", parentId: "" }, { id: "folder-b", name: "Same", parentId: "" },
  ] } };
  await render();
  await waitFor(() => tagInputs().length === 2);
  assert.ok(document.body.textContent.includes(labels.needsReview));
  assert.ok(document.body.textContent.includes(labels.unbilledBatches.replace("{count}", "1")));
  latest = { ...latest, data: { ...latest.data, providerMode: "byok" } };
  await act(async () => { await client.invalidateQueries({ queryKey: ["document-organization", latest.id] }); });
  await waitFor(() => document.body.textContent.includes(labels.invalidBatchesByok.replace("{count}", "1")));
  assert.equal(button(labels.apply.replace("{count}", "0")).disabled, true);
  const options = [...document.querySelectorAll("select option")].filter(option => option.value);
  assert.equal(options.length, 2);
  assert.notEqual(options[0].textContent, options[1].textContent, "same-name destinations must be distinguishable");
  for (const [stopReason, message] of [["timeout", labels.partialTimeout], ["failure_limit", labels.partialFailureLimit], ["failure_ratio", labels.partialFailureRatio]]) {
    await act(async () => root.render(null)); client.clear();
    latest = { ...latest, id: `partial-${stopReason}`, status: "ready", data: { ...data, stopReason, completed: 1, items: [item, { ...item, docId: "unfinished", title: "未完成的文章", suggested: { ...item.suggested, docId: "unfinished" }, needsReview: true, notAnalyzed: true }] } };
    await render();
    await waitFor(() => document.body.textContent.includes(message.replace("{done}", "1").replace("{total}", "2")));
    assert.ok(document.body.textContent.includes(labels.notAnalyzed));
    assert.ok(!document.body.textContent.includes(labels.needsReview), "unfinished work must not be labeled as an invalid model suggestion");
    assert.deepEqual([...document.querySelectorAll("article input[type=checkbox]")].map(input => input.checked), [true, false]);
    assert.equal(button(labels.apply.replace("{count}", "1")).disabled, false, "completed suggestions must remain applicable");
  }
  for (const [status, message] of [[400, labels.providerRejected], [422, labels.providerRejected], [429, labels.providerRateLimited], [503, labels.providerUnavailable]]) {
    await act(async () => root.render(null)); client.clear();
    latest = { ...latest, id: `provider-${status}`, status: "ready", data: { ...data, unbilledBatches: 2, items: [item, { ...item, docId: "second", suggested: { ...item.suggested, docId: "second" } }].map(value => ({ ...value, needsReview: true, failureStatus: status })) } };
    await render();
    const diagnostic = message.replace("{status}", status);
    await waitFor(() => document.body.textContent.includes(diagnostic));
    assert.equal([...document.querySelectorAll('[role="status"]')].filter(node => node.textContent === diagnostic).length, 1, "provider errors should be explained once per status");
    assert.ok(document.body.textContent.includes(labels.providerItem.replace("{status}", status)));
    assert.ok(!document.body.textContent.includes(labels.needsReview), "a rejected request must not be labeled as an invalid suggestion");
    assert.deepEqual([...document.querySelectorAll("article input[type=checkbox]")].map(input => input.checked), [false, false]);
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
  assert.ok(document.body.textContent.includes(labels.excludedConflicts.replace("{count}", "1")));
  await click(labels.generate);
  await waitFor(() => tagInputs().length === 2);
  assert.deepEqual(calls.create.at(-1).exclude, ["conflict-doc"], "generation must use the same exclusions as its estimate");
  await click(labels.apply.replace("{count}", "1"));
  await waitFor(() => button(labels.undo));
  assert.deepEqual(calls.prepare.at(-1), ["doc"], "apply must check only selected documents for conflicts");
  console.log("AI organizer dialog: lossless tags, pinned preview, discard protection, deleted-item pruning, prior undo and reload passed");
} finally {
  await act(async () => root.unmount()); client.clear();
}
