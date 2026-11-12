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
window.location = { href: "https://koinote.test/space?tab=koi" };
Object.assign(globalThis, { window, self: window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
const member = { id: 1, authUserId: "account-one", membershipTier: "lifetime" };
const state = globalThis.__koiSettingsTest = { user: member, search: { tab: "koi" }, api: null, i18n: null };
window.HTMLElement.prototype.scrollIntoView = function () { state.scrolled = this.id; };
const directory = await mkdtemp(join(process.cwd(), "scripts/.koi-settings-test-"));
let root, client, unsubscribe;
try {
  const outfile = join(directory, "settings.cjs");
  await build({
    stdin: { contents: 'export {SpacePage} from "./spa/src/pages/SpacePage";export {parseSpaceSearch} from "./spa/src/spaceSearch";export {zh} from "./spa/src/i18n/zh";export {ApiError} from "./spa/src/api";', resolveDir: process.cwd(), loader: "tsx" },
    outfile, bundle: true, platform: "node", format: "cjs", packages: "external", jsx: "automatic", logLevel: "silent",
    plugins: [{ name: "settings-host", setup(builder) {
      const hosts = {
        api: 'export const apiJson=(...args)=>globalThis.__koiSettingsTest.api(...args);export const AGENT_CREDITS_QUERY_KEY=["agent-credits"];export const getAgentCredits=()=>apiJson("/api/agent/credits");export const createAgentCreditsCheckout=(packCode,currency)=>apiJson("/api/agent/credits/checkout",{method:"POST",body:JSON.stringify({packCode,currency})});export const confirmAgentCreditsCheckout=(sessionId)=>apiJson("/api/agent/credits/checkout/confirm",{method:"POST",body:JSON.stringify({sessionId})});export class ApiError extends Error{constructor(status,message,code){super(message);this.status=status;this.code=code;}};',
        auth: 'export const useSession=()=>({data:{user:globalThis.__koiSettingsTest.user}});',
        i18n: 'export const useI18n=()=>globalThis.__koiSettingsTest.i18n;export const interpolate=(template,vars)=>template.replace(/\\{(\\w+)\\}/g,(_,key)=>key in vars?String(vars[key]):`{${key}}`);',
        router: 'import React from "react";export {defaultStringifySearch} from "@tanstack/router-core";export const useRouterState=({select})=>select({location:{pathname:"/space"}});export const useSearch=()=>globalThis.__koiSettingsTest.search;export const useNavigate=()=>async(target)=>{globalThis.__koiSettingsTest.search=target.search;};export const Link=({to,search,hash,children,...props})=><a href={to+(search?"?"+new URLSearchParams(search):"")+(hash?"#"+hash:"")} {...props}>{children}</a>;',
        repositories: 'export const AgentWorkspaceRepositoriesPage=()=>null;',
        snapshots: 'export const ConfigSnapshotsCard=()=>null;',
        confirmation: 'export const confirmAction=async()=>true;',
        navigation: 'export const openMembershipCheckout=async(url)=>{(globalThis.__koiSettingsTest.checkoutUrls??=[]).push(url);};',
      };
      builder.onResolve({ filter: /^react(?:\/.*)?$/, namespace: "settings-host" }, ({ path }) => ({ path, external: true }));
      builder.onResolve({ filter: /^@tanstack\/router-core$/, namespace: "settings-host" }, ({ path }) => ({ path, external: true }));
      for (const [filter, path] of [
        [/(^|\/)api$/, "api"], [/(^|\/)auth$/, "auth"], [/(^|\/)i18n$/, "i18n"],
        [/^@tanstack\/react-router$/, "router"], [/AgentWorkspaceRepositoriesPage$/, "repositories"],
        [/ConfigSnapshotsCard$/, "snapshots"], [/(^|\/)confirmAction$/, "confirmation"],
        [/(^|\/)externalNavigation$/, "navigation"],
      ]) builder.onResolve({ filter }, () => ({ path, namespace: "settings-host" }));
      builder.onLoad({ filter: /.*/, namespace: "settings-host" }, ({ path }) => ({ contents: hosts[path], loader: "jsx" }));
    } }],
  });
  const { SpacePage, parseSpaceSearch, zh, ApiError } = require(outfile);
  const { createRouter, createRootRoute, createRoute, defaultParseSearch } = await import("@tanstack/react-router");
  const { createMemoryHistory } = await import("@tanstack/history");
  const routeRoot = createRootRoute();
  const route = createRoute({ getParentRoute: () => routeRoot, path: "/space", validateSearch: parseSpaceSearch });
  const router = createRouter({ routeTree: routeRoot.addChildren([route]), isServer: true, history: createMemoryHistory({ initialEntries: ["/space"] }) });
  assert.deepEqual(router.matchRoutes("/space", defaultParseSearch("?tab=koi&section=skills&install=github")).at(-1).search, { tab: "koi", section: "skills", install: "github" });
  assert.deepEqual(router.matchRoutes("/space", defaultParseSearch('?tab=koi&section=%5B%22skills%22%5D&install=unknown')).at(-1).search, { tab: "koi", section: undefined, install: undefined });
  assert.deepEqual(parseSpaceSearch({ tab: "config", section: "skills", install: "folder" }), { tab: "config", section: undefined, install: undefined });
  state.i18n = { t: zh, locale: "zh" };
  const calls = [];
  let permission = "assist", failRead = false, failSave = false, writeDelay;
  let credential = { configured: false }, credentialReadError, credentialSaveError, credentialRemoveError;
  let creditsReadError, creditsReadDelay;
  let skillsAvailable = false;
  let libraryMode = "installed";
  const creditsData = {
    balance: 900, reserved: 25, available: 875, tokensPerCredit: 1000,
    builtinEnabled: true, purchaseEnabled: true,
    packs: [{ code: "credits_3000", credits: 3000, amount: 300, currency: "usd", prices: [{ amount: 300, currency: "usd" }, { amount: 2100, currency: "cny" }] }],
    transactions: [{ entryId: "usage-1", kind: "agent_usage", amount: -100, balanceAfter: 900, metadata: {}, createdAt: "2026-11-11T00:00:00Z" }],
  };
  state.api = async (path, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method, body: init.body });
    if (path === "/api/koi/settings") return { managementAvailable: skillsAvailable, canInstall: skillsAvailable && state.user.membershipTier === "lifetime", settings: { autoSkills: true, revision: 1, libraryMode }, legacySkillCount: 1 };
    if (path === "/api/koi/skill-migration/skip") { libraryMode = "installed"; return { libraryMode }; }
    if (path.startsWith("/api/koi/skills?")) return { skills: [], nextCursor: "", storage: { usedBytes: 0 } };
    if (path === "/api/agent/credits") {
      if (creditsReadDelay) await creditsReadDelay;
      if (creditsReadError) throw creditsReadError;
      return { credits: { ...creditsData } };
    }
    if (path === "/api/agent/credits/checkout") return { sessionId: "test-checkout", url: "https://checkout.stripe.com/test" };
    if (path === "/api/agent/session-settings") {
      if (method === "PUT") {
        if (writeDelay) await writeDelay;
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
    const input = document.querySelector(`input[name="koi-default-permission"][value="${value}"]`);
    const props = input[Object.keys(input).find((key) => key.startsWith("__reactProps$"))];
    await act(async () => props.onChange());
    await settle();
  }
  const tokenLabels = zh.agentWorkspace;
  const selectedPermission = () => [...document.querySelectorAll('input[name="koi-default-permission"]')].find((input) => input.checked)?.value;
  const tokenCard = () => document.querySelector(".koi-github-card");
  const creditsButton = () => document.querySelector('button[aria-controls="koi-credits"]');
  const creditsPanel = () => document.getElementById("koi-credits");
  async function toggleCredits() {
    await act(async () => creditsButton().click());
    await settle();
  }
  async function clickTokenButton(text) {
    const button = [...tokenCard().querySelectorAll("button")].find((item) => item.textContent === text);
    assert.ok(button, `Missing credential action: ${text}`);
    await act(async () => button.click());
    await settle();
  }
  async function enterToken(value) {
    if (!tokenCard().querySelector("form")) {
      const action = tokenCard().textContent.includes(tokenLabels.githubTokenConfigured) ? tokenLabels.githubTokenEdit : tokenLabels.githubTokenAdd;
      await clickTokenButton(action);
    }
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
  assert.equal(selectedPermission(), "assist");
  assert.ok(document.body.textContent.includes(zh.koi.serviceConfigured));
  assert.ok(document.querySelector('[role="tab"][aria-selected="true"] img[src="/logo.png"]'));
  assert.ok(document.querySelector('section[aria-labelledby="koi-settings-title"] header img[src="/logo.png"]'));
  assert.equal(document.querySelector('a[href="/settings?section=ai#agent-credits"]'), null);
  assert.equal(creditsButton().getAttribute("aria-expanded"), "false");
  assert.equal(calls.some((call) => call.path === "/api/agent/credits"), false, "collapsed balances do not make an extra request");
  await toggleCredits();
  assert.equal(creditsButton().getAttribute("aria-expanded"), "true");
  for (const text of [zh.agentCredits.balance, "900", zh.agentCredits.reserved, "25", "875", zh.agentCredits.history, "-100"]) {
    assert.ok(creditsPanel().textContent.includes(text), `Inline credits are missing ${text}`);
  }
  await act(async () => [...creditsPanel().querySelectorAll("button")].find((button) => button.textContent.includes("3,000 credits")).click());
  await settle();
  assert.deepEqual(JSON.parse(calls.find((call) => call.path === "/api/agent/credits/checkout").body), { packCode: "credits_3000", currency: "cny" });
  assert.deepEqual(state.checkoutUrls, ["https://checkout.stripe.com/test"], "inline credits reuse the existing checkout action");
  creditsData.available = 800;
  await act(async () => { await client.invalidateQueries({ queryKey: ["agent-credits"] }); });
  await settle();
  assert.ok(creditsPanel().textContent.includes("可用 800"), "payment return invalidation also refreshes account-scoped balances");
  await toggleCredits();
  assert.equal(creditsPanel().hidden, true);
  const observer = new QueryObserver(client, { queryKey: ["agent-session-settings", member.authUserId] });
  let observed;
  unsubscribe = observer.subscribe((result) => { observed = result.data?.permission; });
  let finishWrite;
  writeDelay = new Promise((resolve) => { finishWrite = resolve; });
  await changePermission("full");
  assert.equal(selectedPermission(), "full", "the pending choice is visible immediately");
  assert.equal(document.getElementById("koi-default-permission").hasAttribute("disabled"), true, "saving prevents conflicting choices");
  assert.ok(document.body.textContent.includes(zh.koi.saving));
  finishWrite(); writeDelay = undefined;
  await settle();
  assert.equal(permission, "full");
  assert.equal(observed, "full", "the existing bottom-panel cache receives the saved default");
  assert.ok(document.body.textContent.includes(zh.koi.saved));
  failSave = true;
  await changePermission("review");
  assert.equal(permission, "full");
  assert.equal(selectedPermission(), "full");
  assert.ok(document.body.textContent.includes(zh.koi.saveFailed));
  assert.ok(!document.body.textContent.includes(zh.koi.saved));
  unsubscribe(); unsubscribe = null;

  failSave = false;
  await act(async () => [...document.querySelectorAll("button")].find((button) => button.textContent === zh.koi.retry).click());
  await settle();
  assert.equal(permission, "review", "retry submits the failed choice without selecting another option");
  assert.equal(selectedPermission(), "review");
  failRead = true;
  await mount();
  assert.equal(document.getElementById("koi-default-permission"), null, "failed reads do not expose a guessed default");
  failRead = false;
  await act(async () => [...document.querySelectorAll("button")].find((button) => button.textContent === zh.koi.retry).click());
  await settle();
  assert.equal(selectedPermission(), "review");
  state.user = { ...member, id: 2, authUserId: "account-two" }; permission = "review";
  client.setQueryData(["agent-credits"], { credits: creditsData });
  let finishCreditsRead;
  creditsReadDelay = new Promise((resolve) => { finishCreditsRead = resolve; });
  await render();
  assert.equal(selectedPermission(), "review", "switching accounts reads that account's defaults");
  assert.equal(creditsButton().getAttribute("aria-expanded"), "false", "account switch resets the inline panel");
  await toggleCredits();
  assert.ok(creditsPanel().textContent.includes(zh.agentCredits.loading));
  assert.ok(!creditsPanel().textContent.includes("可用 800"), "a new account never displays an old account's scoped or legacy balance");
  creditsData.available = 700;
  finishCreditsRead(); creditsReadDelay = undefined;
  await settle();
  assert.ok(creditsPanel().textContent.includes("可用 700"));
  await toggleCredits();
  creditsReadError = new Error("offline");
  client.removeQueries({ queryKey: ["agent-credits"] });
  await toggleCredits();
  assert.ok(creditsPanel().textContent.includes(zh.agentCredits.loadFailed));
  assert.ok(!creditsPanel().textContent.includes("可用 0"), "a failed read must not be presented as a zero balance");
  creditsReadError = undefined;
  await toggleCredits(); await toggleCredits();
  assert.ok(creditsPanel().textContent.includes("可用 700"), "reopening the panel recovers a failed balance read");

  credentialReadError = new Error("offline");
  await mount();
  assert.ok(tokenCard().textContent.includes(tokenLabels.githubTokenLoadFailed));
  assert.ok(!tokenCard().textContent.includes(tokenLabels.githubTokenNotConfigured), "a failed read is not an unconfigured token");
  assert.ok(!tokenCard().textContent.includes(tokenLabels.githubImportFailed));
  credentialReadError = undefined;
  await clickTokenButton(tokenLabels.refresh);
  assert.ok(tokenCard().textContent.includes(tokenLabels.githubTokenNotConfigured), "retry recovers without leaving the page");
  assert.ok(!tokenCard().querySelector('[role="alert"]'));

  assert.equal(tokenCard().querySelector("form"), null, "token input stays collapsed until requested");
  await enterToken("discard-this-draft");
  await clickTokenButton(zh.llmChannels.cancel);
  assert.equal(tokenCard().querySelector("form"), null);
  await clickTokenButton(tokenLabels.githubTokenAdd);
  assert.equal(tokenCard().querySelector("input").value, "", "cancel clears the sensitive draft");
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
  assert.equal(tokenCard().querySelector("form"), null, "successful saves return to the credential summary");
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
  assert.ok(!calls.some((call) => !["/api/agent/github-credential", "/api/koi/settings"].includes(call.path)), "free accounts do not call member-only endpoints");
  client.setQueryData(["agent-credits", member.authUserId], { credits: creditsData });
  await toggleCredits();
  assert.ok(creditsPanel().textContent.includes(zh.agentCredits.membersOnly));
  assert.ok(!creditsPanel().textContent.includes("可用 700"), "membership loss hides cached balances");
  assert.ok(!calls.some((call) => call.path === "/api/agent/credits"), "free accounts do not request balances");
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
  calls.length = 0; state.user = null;
  state.search = { tab: "koi", section: "skills", install: "github" };
  await mount();
  const login = document.querySelector('a[href^="/login"]');
  assert.equal(new URL(login.getAttribute("href"), "https://koinote.test").searchParams.get("redirectTo"), "/space?tab=koi&section=skills&install=github", "sign-in retains the requested installation source");
  assert.equal(calls.length, 0);
  state.user = member; skillsAvailable = true;
  await mount();
  assert.ok(document.querySelector('[role="dialog"] input[type="url"]'), "a GitHub link opens its source form");
  assert.equal(state.scrolled, "koi-skills", "the Skills link scrolls after the library is available");
  assert.equal(calls.some(call => call.method === "POST"), false, "opening an installation link never starts an upload or confirms an install");
  await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === zh.koi.cancel).click());
  await render();
  assert.deepEqual(state.search, { tab: "koi", section: "skills" }, "closing consumes the installation request");
  assert.equal(document.querySelector('[role="dialog"]'), null);
  state.search = { tab: "koi", install: "folder" };
  await render();
  assert.ok(document.querySelector('[role="dialog"] input[type="file"]'), "a folder link opens the local picker");
  state.search = { tab: "koi", install: "github" };
  await render();
  assert.ok(document.querySelector('[role="dialog"] input[type="url"]'), "changing the link updates the source without leaving the page");
  state.search = { tab: "koi", section: "settings" };
  await render();
  assert.equal(state.scrolled, "koi-settings");
  assert.equal(document.querySelector('[role="dialog"]'), null);
  skillsAvailable = false; state.search = { tab: "koi", install: "github" };
  await mount();
  assert.ok(document.body.textContent.includes(zh.koi.koiUnavailable), "direct links explain the rollout restriction");
  assert.equal(document.querySelector('[role="dialog"]'), null);
  skillsAvailable = true; state.user = { ...member, membershipTier: "free" };
  await mount();
  assert.ok(document.body.textContent.includes(zh.koi.koiMembersOnly), "direct links preserve membership restrictions");
  assert.equal(document.querySelector('[role="dialog"]'), null);
  state.user = member; libraryMode = "legacy"; calls.length = 0;
  await mount();
  assert.ok(document.querySelector('[role="dialog"]').textContent.includes(zh.koi.legacyTitle), "legacy accounts see migration guidance before the requested installer");
  assert.equal(calls.some(call => call.method === "POST"), false, "a link does not start migration without a user choice");
  await act(async () => [...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === zh.koi.legacySkip).click());
  await settle();
  assert.ok(document.querySelector('[role="dialog"] input[type="url"]'), "choosing an empty library resumes the requested GitHub source");
  assert.equal(calls.filter(call => call.method === "POST").length, 1, "resuming the installer only performs the explicit library choice");
  calls.length = 0; state.user = { ...member, isLocalMode: true };
  await mount();
  assert.equal(calls.length, 0, "local mode must not make cloud requests");
  assert.ok(document.body.textContent.includes(zh.koi.localMode));
  console.log("Koi settings passed: inline credits and checkout, account isolation, shared defaults, credential recovery, membership/admin permissions and local mode.");
} finally {
  unsubscribe?.();
  if (root) await act(async () => root.unmount());
  client?.clear();
  delete globalThis.__koiSettingsTest;
  await rm(directory, { recursive: true, force: true });
}
