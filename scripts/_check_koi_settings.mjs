import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const require = createRequire(import.meta.url);
const { QueryClient, QueryClientProvider, QueryObserver } = require("@tanstack/react-query");
const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
const member = { id: 1, authUserId: "account-one", membershipTier: "lifetime" };
const state = globalThis.__koiSettingsTest = { user: member, search: { tab: "koi" }, api: null, i18n: null };
const directory = await mkdtemp(join(process.cwd(), "scripts/.koi-settings-test-"));
let root, client, unsubscribe;
try {
  const outfile = join(directory, "settings.cjs");
  await build({
    stdin: { contents: 'export {SpacePage} from "./spa/src/pages/SpacePage";export {zh} from "./spa/src/i18n/zh";export {ApiError} from "./spa/src/api";', resolveDir: process.cwd(), loader: "tsx" },
    outfile, bundle: true, platform: "node", format: "cjs", packages: "external", jsx: "automatic", logLevel: "silent",
    plugins: [{ name: "settings-host", setup(builder) {
      const hosts = {
        api: 'export const apiJson=(...args)=>globalThis.__koiSettingsTest.api(...args);export class ApiError extends Error{constructor(status,message,code){super(message);this.status=status;this.code=code;}};',
        auth: 'export const useSession=()=>({data:{user:globalThis.__koiSettingsTest.user}});',
        i18n: 'export const useI18n=()=>globalThis.__koiSettingsTest.i18n;',
        router: 'import React from "react";export const useRouterState=({select})=>select({location:{pathname:"/space"}});export const useSearch=()=>globalThis.__koiSettingsTest.search;export const Link=({to,search,hash,children,...props})=><a href={to+(search?"?"+new URLSearchParams(search):"")+(hash?"#"+hash:"")} {...props}>{children}</a>;',
        repositories: 'export const AgentWorkspaceRepositoriesPage=()=>null;',
        snapshots: 'export const ConfigSnapshotsCard=()=>null;',
        confirmation: 'export const confirmAction=async()=>true;',
      };
      builder.onResolve({ filter: /^react(?:\/.*)?$/, namespace: "settings-host" }, ({ path }) => ({ path, external: true }));
      for (const [filter, path] of [
        [/(^|\/)api$/, "api"], [/(^|\/)auth$/, "auth"], [/(^|\/)i18n$/, "i18n"],
        [/^@tanstack\/react-router$/, "router"], [/AgentWorkspaceRepositoriesPage$/, "repositories"],
        [/ConfigSnapshotsCard$/, "snapshots"], [/(^|\/)confirmAction$/, "confirmation"],
      ]) builder.onResolve({ filter }, () => ({ path, namespace: "settings-host" }));
      builder.onLoad({ filter: /.*/, namespace: "settings-host" }, ({ path }) => ({ contents: hosts[path], loader: "jsx" }));
    } }],
  });
  const { SpacePage, zh, ApiError } = require(outfile);
  state.i18n = { t: zh, locale: "zh" };
  const calls = [];
  let permission = "assist", failRead = false, failSave = false;
  let credential = { configured: false }, credentialReadError, credentialSaveError, credentialRemoveError;
  state.api = async (path, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method });
    if (path === "/api/agent/session-settings") {
      if (method === "PUT") {
        if (failSave) throw new Error("offline");
        permission = JSON.parse(init.body).permission;
      } else if (failRead) throw new Error("offline");
      return { permission };
    }
    if (path === "/api/writing-agent/config") return { enabled: true, skills: [] };
    if (path === "/api/agent/github-credential") {
      if (method === "PUT") {
        if (state.user.membershipTier !== "lifetime" && !state.user.isAdmin) throw new ApiError(403, "Lifetime membership is required", "membership_required");
        if (credentialSaveError) throw credentialSaveError;
        credential = { configured: true, tokenHint: JSON.parse(init.body).token.slice(-4) };
      } else if (method === "DELETE") {
        if (credentialRemoveError) throw credentialRemoveError;
        credential = { configured: false };
        return { success: true };
      } else if (credentialReadError) throw credentialReadError;
      return { credential: { ...credential } };
    }
    throw new Error(`Unexpected endpoint: ${path}`);
  };
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); }); };
  async function mount() {
    if (root) await act(async () => root.unmount());
    client?.clear();
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    root = createRoot(document.getElementById("root"));
    await render();
  }
  async function render() {
    await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(SpacePage))));
    await settle();
  }
  async function changePermission(value) {
    const select = document.getElementById("koi-default-permission");
    // Linkedom does not provide a writable select.value; selected options drive
    // its getter, just as the browser's native selection does.
    for (const option of select.querySelectorAll("option")) option.selected = option.value === value;
    await act(async () => select.dispatchEvent(new window.Event("change", { bubbles: true })));
    await settle();
  }
  const tokenLabels = zh.agentWorkspace;
  const tokenCard = () => [...document.querySelectorAll("h2")].find((heading) => heading.textContent === tokenLabels.githubTokenTitle).parentElement;
  async function clickTokenButton(text) {
    const button = [...tokenCard().querySelectorAll("button")].find((item) => item.textContent === text);
    assert.ok(button, `Missing credential action: ${text}`);
    await act(async () => button.click());
    await settle();
  }
  async function enterToken(value) {
    const input = tokenCard().querySelector('input[type="password"]');
    const props = input[Object.keys(input).find((key) => key.startsWith("__reactProps$"))];
    await act(async () => props.onChange({ target: { value } }));
  }
  async function submitToken() {
    await act(async () => tokenCard().querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
    await settle();
  }

  await mount();
  assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').textContent, "Koi AI");
  assert.equal(document.getElementById("koi-default-permission").value, "assist");
  assert.ok(document.body.textContent.includes(zh.koi.serviceConfigured));
  assert.ok(document.querySelector('a[href="/settings?section=ai#agent-credits"]'));
  const observer = new QueryObserver(client, { queryKey: ["agent-session-settings", member.authUserId] });
  let observed;
  unsubscribe = observer.subscribe((result) => { observed = result.data?.permission; });
  await changePermission("full");
  assert.equal(permission, "full");
  assert.equal(observed, "full", "the existing bottom-panel cache receives the saved default");
  assert.ok(document.body.textContent.includes(zh.koi.saved));
  failSave = true;
  await changePermission("review");
  assert.equal(permission, "full");
  assert.equal(document.getElementById("koi-default-permission").value, "full");
  assert.ok(document.body.textContent.includes(zh.koi.saveFailed));
  assert.ok(!document.body.textContent.includes(zh.koi.saved));
  unsubscribe(); unsubscribe = null;

  failSave = false; failRead = true;
  await mount();
  assert.equal(document.getElementById("koi-default-permission"), null, "failed reads do not expose a guessed default");
  failRead = false;
  await act(async () => [...document.querySelectorAll("button")].find((button) => button.textContent === zh.koi.retry).click());
  await settle();
  assert.equal(document.getElementById("koi-default-permission").value, "full");
  state.user = { ...member, id: 2, authUserId: "account-two" }; permission = "review";
  await render();
  assert.equal(document.getElementById("koi-default-permission").value, "review", "switching accounts reads that account's defaults");

  credentialReadError = new Error("offline");
  await mount();
  assert.ok(tokenCard().textContent.includes(tokenLabels.githubTokenLoadFailed));
  assert.ok(!tokenCard().textContent.includes(tokenLabels.githubTokenNotConfigured), "a failed read is not an unconfigured token");
  assert.ok(!tokenCard().textContent.includes(tokenLabels.githubImportFailed));
  credentialReadError = undefined;
  await clickTokenButton(tokenLabels.refresh);
  assert.ok(tokenCard().textContent.includes(tokenLabels.githubTokenNotConfigured), "retry recovers without leaving the page");
  assert.ok(!tokenCard().querySelector('[role="alert"]'));

  const token = "github-test-token-9876";
  credentialSaveError = new Error("offline");
  await enterToken(token); await submitToken();
  assert.ok(tokenCard().textContent.includes(tokenLabels.githubTokenSaveFailed));
  assert.equal(tokenCard().querySelector("input").value, token, "save failure keeps input for retry");
  credentialSaveError = new ApiError(403, "Lifetime membership is required", "membership_required");
  await submitToken();
  assert.ok(tokenCard().textContent.includes(tokenLabels.githubTokenMembersOnly), "server-side membership rejection has an actionable message");
  credentialSaveError = undefined;
  await submitToken();
  assert.ok(tokenCard().textContent.includes("••••9876"));
  assert.equal(tokenCard().querySelector("input").value, "");
  assert.ok(tokenCard().textContent.includes(tokenLabels.githubTokenSaved));
  credentialSaveError = new Error("offline");
  await enterToken("replacement-token"); await submitToken();
  assert.ok(tokenCard().textContent.includes(tokenLabels.githubTokenSaveFailed));
  credentialSaveError = undefined;
  credentialRemoveError = new Error("offline");
  await clickTokenButton(tokenLabels.githubTokenRemove);
  assert.ok(tokenCard().textContent.includes(tokenLabels.githubTokenRemoveFailed));
  assert.ok(!tokenCard().textContent.includes(tokenLabels.githubTokenSaveFailed), "a previous save error does not mask the remove error");
  assert.ok(tokenCard().textContent.includes("••••9876"), "remove failure retains the configured state");
  credentialRemoveError = undefined;

  calls.length = 0; state.user = { ...member, membershipTier: "free" };
  await mount();
  assert.ok(document.querySelector('a[href="/pricing"]'));
  assert.equal(tokenCard().querySelector("form"), null, "free accounts are not offered member-only credential writes");
  assert.ok(tokenCard().textContent.includes(tokenLabels.githubTokenMembersOnly));
  assert.ok(!calls.some((call) => call.path !== "/api/agent/github-credential"), "free accounts do not call member-only endpoints");
  await clickTokenButton(tokenLabels.githubTokenRemove);
  assert.equal(credential.configured, false, "free accounts can still remove an existing credential");
  assert.ok(tokenCard().textContent.includes(tokenLabels.githubTokenNotConfigured));
  assert.ok(!calls.some((call) => call.method === "PUT"));

  state.user = { ...member, membershipTier: "free", isAdmin: true };
  await mount();
  await enterToken(token); await submitToken();
  assert.ok(tokenCard().textContent.includes("••••9876"), "administrators retain the server-authorized save capability");
  state.user = { ...member, id: 2, authUserId: "account-two" };
  credential = { configured: false }; credentialReadError = new Error("offline");
  await render();
  assert.ok(!tokenCard().textContent.includes("••••9876"), "account switch does not display the previous account's credential");
  credentialReadError = undefined;
  calls.length = 0; state.user = { ...member, isLocalMode: true };
  await mount();
  assert.equal(calls.length, 0, "local mode must not make cloud requests");
  assert.ok(document.body.textContent.includes(zh.koi.localMode));
  console.log("Koi settings passed: shared defaults, credential read/save/remove recovery, membership/admin permissions and local mode.");
} finally {
  unsubscribe?.();
  if (root) await act(async () => root.unmount());
  client?.clear();
  delete globalThis.__koiSettingsTest;
  await rm(directory, { recursive: true, force: true });
}
