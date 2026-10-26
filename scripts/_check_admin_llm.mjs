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
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let server = { settings: ["text", "image"].map(kind => ({
  kind, enabled: true, protocol: "openai", baseUrl: "https://models.example/v1", model: `old-${kind}`,
  hasApiKey: true, apiKeyHint: "••••test", thinking: false, version: 1, source: "admin", updatedAt: null,
})) };
let nextRead, nextWrite;
const reads = [], writes = [];
globalThis.__adminLLMTest = {
  get(signal) {
    reads.push({ signal });
    if (nextRead) { const read = nextRead; nextRead = undefined; return read.promise; }
    return Promise.resolve(structuredClone(server));
  },
  update(kind, input) {
    writes.push({ kind, input });
    if (nextWrite) { const write = nextWrite; nextWrite = undefined; return write.promise; }
    return Promise.resolve(commit(kind, input));
  },
};
function commit(kind, input) {
  const { apiKey, ...fields } = input;
  const setting = { ...server.settings.find(value => value.kind === kind), ...fields, version: input.version + 1 };
  server.settings = server.settings.map(value => value.kind === kind ? setting : value);
  return structuredClone({ setting });
}
const adapters = {
  "../api": `const test=globalThis.__adminLLMTest;
    export const ADMIN_LLM_SETTINGS_QUERY_KEY=['admin-llm-settings'];
    export const AGENT_CREDITS_QUERY_KEY=['agent-credits'];
    export const getAdminLLMSettings=(signal)=>test.get(signal);
    export const updateAdminLLMSetting=(kind,input)=>test.update(kind,input);
    export class ApiError extends Error { constructor(status,code){super(code);this.status=status;this.code=code;} }`,
  "../i18n": "export const useI18n=()=>({t:globalThis.__adminLLMLabels});",
  "./Ink": "import {createElement} from 'react';export const PaperCard=({children,...props})=>createElement('div',props,children);",
  "lucide-react": "const Icon=()=>null;export const Bot=Icon,Check=Icon,Image=Icon,LoaderCircle=Icon,RefreshCw=Icon;",
};
const bundle = await build({
  stdin: { contents: `export {createElement,act} from 'react';export {createRoot} from 'react-dom/client';
    export {QueryClient,QueryClientProvider} from '@tanstack/react-query';export {ApiError} from '../api';
    export {AdminLLMSettingsPanel} from './spa/src/components/AdminLLMSettingsPanel';export {zh} from './spa/src/i18n/zh';`, resolveDir: process.cwd() },
  bundle: true, format: "esm", platform: "node", write: false, jsx: "automatic",
  plugins: [{ name: "admin-llm-test-adapters", setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(adapters, path) ? { path, namespace: "test-adapter" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "test-adapter" }, ({ path }) => ({ contents: adapters[path] }));
    builder.onResolve({ filter: /^(?:react(?:-dom)?(?:\/|$)|@tanstack\/react-query$)/ }, ({ path }) => ({ path: pathToFileURL(require.resolve(path)).href, external: true }));
  }}],
});
const { createElement, act, createRoot, QueryClient, QueryClientProvider, ApiError, AdminLLMSettingsPanel, zh } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
globalThis.__adminLLMLabels = zh;
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
const key = ["admin-llm-settings"];
const root = createRoot(document.getElementById("root"));
const waitFor = async (predicate, message) => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await act(async () => new Promise(resolve => setTimeout(resolve, 10))); }
  assert.fail(message);
};
const form = index => document.querySelectorAll("form")[index];
const input = (index, label) => [...form(index).querySelectorAll("label")].find(value => value.firstChild.textContent.trim() === label)?.querySelector("input");
const edit = async (index, label, value) => {
  const element = input(index, label); assert.ok(element, label);
  await act(async () => {
    if (!element.type) element.type = "text";
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(element, value);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
};
const submit = index => act(async () => { form(index).dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
const refresh = () => [...document.querySelectorAll("button")].find(value => value.textContent === zh.admin.refresh);
try {
  await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(AdminLLMSettingsPanel))));
  await waitFor(() => document.querySelectorAll("form").length === 2, "forms loaded");
  const oldSnapshot = structuredClone(server);
  const delayedRead = nextRead = deferred();
  await act(async () => refresh().click());
  await waitFor(() => reads.length === 2, "refresh started");
  const refreshSignal = reads[1].signal;
  await edit(0, zh.adminLLM.model, "new-text");
  await edit(0, "API Key", "new-provider-secret");
  const delayedWrite = nextWrite = deferred();
  await submit(0);
  await waitFor(() => writes.length === 1, "save started");
  assert.equal(refreshSignal.aborted, true, "save must cancel the old GET");
  assert.equal(refresh().disabled, true, "refresh cannot run during save");
  assert.equal(writes[0].input.model, "new-text", "cancellation must not change the submitted snapshot");
  assert.equal(writes[0].input.apiKey, "new-provider-secret");
  await act(async () => delayedWrite.resolve(commit(writes[0].kind, writes[0].input)));
  await waitFor(() => form(0).querySelector('[role="status"]'), "save success");
  assert.equal(input(0, "API Key").value, "", "never echo a saved key");
  // Deliberately ignore AbortSignal in the mock, as a remote response may already be in flight.
  await act(async () => delayedRead.resolve(oldSnapshot));
  assert.equal(input(0, zh.adminLLM.model).value, "new-text");
  assert.equal(client.getQueryData(key).settings[0].version, 2);

  // Monotonic merging is per channel: reject stale text while accepting newer image data.
  await edit(0, zh.adminLLM.model, "unsaved-text-draft");
  await act(async () => client.setQueryData(key, { settings: [oldSnapshot.settings[0], { ...oldSnapshot.settings[1], version: 3, model: "new-image" }] }));
  assert.equal(input(0, zh.adminLLM.model).value, "unsaved-text-draft", "other channel refresh must preserve the draft");
  await waitFor(() => input(1, zh.adminLLM.model).value === "new-image", "newer image configuration renders");
  assert.equal(client.getQueryData(key).settings[0].version, 2);

  // A genuine later update must clear the success state associated with the old version.
  server = { settings: [{ ...server.settings[0], version: 4, model: "other-admin" }, client.getQueryData(key).settings[1]] };
  await act(async () => client.setQueryData(key, structuredClone(server)));
  await waitFor(() => input(0, zh.adminLLM.model).value === "other-admin", "later update renders");
  assert.equal(form(0).querySelector('[role="status"]'), null);
  await edit(0, zh.adminLLM.model, "conflicting-draft");
  const conflict = nextWrite = deferred();
  await submit(0); await waitFor(() => writes.length === 2, "second save started");
  assert.ok(!Object.hasOwn(writes[1].input, "apiKey"), "blank key means preserve");
  server.settings[0] = { ...server.settings[0], version: 5, model: "concurrent-edit" };
  await act(async () => conflict.reject(new ApiError(409, "llm_settings_conflict")));
  await waitFor(() => form(0).textContent.includes(zh.adminLLM.conflict), "conflict is visible");
  // onError renders the message before React Query necessarily notifies every
  // useIsMutating observer. A real user can refresh only after the button enables.
  await waitFor(() => !refresh().disabled, "refresh enabled after failed save");
  await act(async () => refresh().click());
  await waitFor(() => input(0, zh.adminLLM.model).value === "concurrent-edit", "reload after conflict");
  assert.equal(form(0).querySelector('[role="status"]'), null);

  const recovery = nextWrite = deferred();
  await submit(0); await waitFor(() => writes.length === 3, "recovery save started");
  await act(async () => recovery.reject(new ApiError(400, "llm_credential_unavailable")));
  await waitFor(() => form(0).textContent.includes(zh.adminLLM.keyRecovery), "key recovery instruction is visible");
  console.log("admin LLM regressions: canceled/stale reads, immutable submissions, per-channel versions, draft preservation, masked keys, conflict recovery and key-recovery errors passed");
} finally { await act(async () => root.unmount()); client.clear(); }

// Exercise the actual client API functions, not a source-text approximation.
const apiBundle = await build({ stdin: { contents: `export {createAgentReview,generateWechatGeoSummary,getAdminLLMSettings} from './spa/src/api';`, resolveDir: process.cwd() }, bundle: true, format: "esm", platform: "node", write: false });
const api = await import(`data:text/javascript;base64,${Buffer.from(apiBundle.outputFiles[0].text).toString("base64")}`);
const originalFetch = globalThis.fetch;
const requests = [];
globalThis.fetch = async (url, init) => { requests.push({ url, init }); return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }); };
try {
  await api.createAgentReview("doc", { tasks: ["title"] });
  await api.generateWechatGeoSummary("doc", "Title", "Content");
  const controller = new AbortController();
  await api.getAdminLLMSettings(controller.signal);
  for (const request of requests.slice(0, 2)) assert.equal(JSON.parse(request.init.body).providerMode, "builtin", "paid text requests explicitly confirm their provider mode");
  assert.equal(requests[2].init.signal, controller.signal, "admin reads forward the cancellation signal");
  console.log("client API regressions: review/GEO credit confirmation and configuration read cancellation passed");
} finally { globalThis.fetch = originalFetch; }
