import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { parseHTML } from "linkedom";

const require = createRequire(import.meta.url);
const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
document.oninput = null;
const calls = [];
const navigations = [];
const clipboard = [];
let userGesture = false;
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "Node.js", clipboard: { writeText: async (text) => clipboard.push(text) } },
  configurable: true,
});
const harness = {
  enabled: false,
  desktop: false,
  workspaceFiles: [],
  fileContents: new Map(),
  fileWait: null,
  scannedFiles: [],
  uploadFiles: [],
  revisionResponses: [],
  nativeCalls: [],
  saveResult: true,
  restoreCount: null,
  async save(command, bytes, options) { harness.nativeCalls.push({ command, bytes, options }); return harness.saveResult; },
  async restoreFiles(destination, files, locale) { harness.nativeCalls.push({ destination, files, locale }); return harness.restoreCount ?? files.length; },
  tokens: [],
  search: {},
  labels: null,
  failTokenList: false,
  failStorage: false,
  allocationError: null,
  allocationWait: null,
  storage: { usedBytes: 0, quotaBytes: 100000000, bonusBytes: 0, allocatedBytes: 0, personalQuotaBytes: 10 * 1024 ** 3, personalUsedBytes: 0, availableBytes: 10 * 1024 ** 3 },
  createError: null,
  commits: [],
  workspaceRevision: 1,
  restoreResponses: [],
  confirmations: [],
  confirmationResults: [],
  confirmationWait: null,
  async confirm(message) {
    harness.confirmations.push(message);
    if (harness.confirmationWait && message === zh.agentWorkspace.restoreSensitiveConfirm.replace("{revision}", "0")) await harness.confirmationWait;
    return harness.confirmationResults.shift() ?? true;
  },
  user: { membershipTier: "lifetime", isLocalMode: false },
  navigate: async (destination) => { navigations.push(destination); },
  async api(method, ...args) {
    calls.push({ method, args });
    if (method === "getAgentWorkspaceSettings") return { enabled: harness.enabled };
    if (method === "updateAgentWorkspaceSettings") {
      harness.enabled = args[0];
      return { enabled: harness.enabled };
    }
    if (method === "listMCPTokens") {
      if (harness.failTokenList) throw new Error("network unavailable");
      return { tokens: [...harness.tokens] };
    }
    if (method === "createMCPToken") {
      if (harness.createError) throw harness.createError;
      const token = { ...args[0], tokenId: "created-agent-token", hint: "test-token", revealable: true, expiresAt: new Date(Date.now() + args[0].expiresInDays * 86_400_000).toISOString() };
      harness.tokens.push(token);
      return { token, secret: "test-agent-secret" };
    }
    if (method === "revealMCPToken") return { secret: "test-agent-secret" };
    if (method === "getAgentWorkspacePrompt") return { prompt: "Instructions for repository 7", mcpUrl: "https://example.test/mcp" };
    if (method === "getAgentWorkspaceStorage") {
      if (harness.failStorage) throw new Error("storage unavailable");
      return { storage: { ...harness.storage } };
    }
    if (method === "updateAgentWorkspaceStorage") {
      if (harness.allocationWait) await harness.allocationWait;
      if (harness.allocationError) throw harness.allocationError;
      const difference = args[0] - harness.storage.allocatedBytes;
      harness.storage = { ...harness.storage, allocatedBytes: args[0], quotaBytes: harness.storage.quotaBytes + difference, personalUsedBytes: harness.storage.personalUsedBytes + difference, availableBytes: harness.storage.availableBytes - difference };
      return { storage: { ...harness.storage } };
    }
    if (method === "getStorageUsage") return { usedBytes: harness.storage.personalUsedBytes, documentBytes: 0, imageBytes: 0, configBytes: 0, agentAllocatedBytes: harness.storage.allocatedBytes, quotaBytes: harness.storage.personalQuotaBytes };
    if (method === "submitFeedback") return { feedback: { id: 1, category: args[0].category, message: args[0].message, pagePath: args[0].pagePath, client: "web", createdAt: "2026-10-08T00:00:00Z" } };
    if (method === "listAgentWorkspaces") return { workspaces: [] };
    if (method === "listAgentWorkspaceCommits") return { commits: harness.commits };
    if (method === "restoreAgentWorkspaceCommit") {
      const response = harness.restoreResponses.shift();
      if (response instanceof Error) throw response;
      harness.workspaceRevision = args[2] + 1;
      return { workspace: { workspaceId: 7, revision: harness.workspaceRevision, files: [] } };
    }
    if (method === "updateAgentWorkspace" || method === "patchAgentWorkspace") {
      harness.workspaceRevision++;
      return { workspace: { workspaceId: 7, revision: harness.workspaceRevision, files: harness.workspaceFiles } };
    }
    if (method === "getAgentWorkspaceFile") {
      if (harness.fileWait) await harness.fileWait;
      const file = harness.fileContents.get(args[0]);
      if (file instanceof Error) throw file;
      if (!file) throw new ApiError(404, "missing", "not_found");
      return { file };
    }
    if (method === "getAgentWorkspace") return {
      workspace: { workspaceId: 7, name: "Test repository", description: "", revision: harness.revisionResponses.shift() ?? harness.workspaceRevision, files: harness.workspaceFiles, updatedAt: "2026-10-08T00:00:00Z" },
    };
    throw new Error(`Unexpected API call: ${method}`);
  },
};
globalThis.__agentAccessTest = harness;
const bundle = await build({
  stdin: {
    contents: `export { createElement, act } from "react";
      export { ApiError } from "../api";
      export { restoreAgentWorkspaceCommit as realRestoreAgentWorkspaceCommit } from "./spa/src/api";
      export { createRoot } from "react-dom/client";
      export { QueryClient, QueryClientProvider } from "@tanstack/react-query";
      export { loadAgentWorkspaceFiles, saveAgentWorkspaceZip, validateAgentWorkspaceTransferPaths, agentWorkspaceTransferTooLarge, AGENT_WORKSPACE_TRANSFER_MAX_BYTES, AGENT_WORKSPACE_TRANSFER_MAX_FILES } from "./spa/src/agentWorkspaceTransfer";
      export { AgentWorkspaceTransferDialog } from "./spa/src/components/AgentWorkspaceTransferDialog";
      export { AgentWorkspaceRepositoryPage } from "./spa/src/pages/AgentWorkspaceRepositoryPage";
      export { AgentWorkspaceSettingsPage } from "./spa/src/pages/AgentWorkspaceSettingsPage";
      export { MCPAccessCard } from "./spa/src/components/MCPAccessCard";
      export { AgentWorkspaceCard } from "./spa/src/components/AgentWorkspaceCard";
      export { StorageCard } from "./spa/src/components/StorageCard";
      export { zh } from "./spa/src/i18n/zh";`,
    resolveDir: process.cwd(),
  },
  bundle: true, format: "esm", platform: "node", write: false, jsx: "automatic",
  plugins: [{ name: "agent-access-adapters", setup(builder) {
    const methods = [
      "createMCPToken", "listMCPTokens", "revealMCPToken", "revokeMCPToken", "updateMCPTokenExpiry",
      "getAgentWorkspaceSettings", "updateAgentWorkspaceSettings", "getAgentWorkspace", "getAgentWorkspaceFile",
      "getAgentWorkspacePrompt", "getAgentWorkspaceStorage", "updateAgentWorkspaceStorage", "getStorageUsage", "listAgentWorkspaceCommits", "patchAgentWorkspace",
      "restoreAgentWorkspaceCommit", "updateAgentWorkspace", "updateAgentWorkspaceMetadata",
      "createAgentWorkspace", "deleteAgentWorkspace", "listAgentWorkspaces", "submitFeedback",
    ];
    const adapters = {
      "../api": `export class ApiError extends Error {
          constructor(status, message, code) { super(message); this.status = status; this.code = code; }
        }
        export const AGENT_WORKSPACE_QUERY_KEY = ["agent-workspace"];
        ${methods.map((method) => `export const ${method} = (...args) => globalThis.__agentAccessTest.api("${method}", ...args);`).join("\n")}`,
      "../auth": "export const useSession = () => ({ data: { user: globalThis.__agentAccessTest.user } });",
      "../i18n": `export const useI18n = () => ({ t: globalThis.__agentAccessTest.labels, locale: 'zh' });
        export const interpolate = (template, values) => Object.entries(values).reduce((text, [key, value]) => text.replaceAll("{" + key + "}", value), template);`,
      "@tanstack/react-router": `import { createElement } from "react";
        export const useNavigate = () => globalThis.__agentAccessTest.navigate;
        export const useSearch = () => globalThis.__agentAccessTest.search;
        export const useParams = () => ({ workspaceId: "7" });
        export const useRouterState = ({ select }) => select({ location: { pathname: "/space/settings" } });
        export const Link = ({ to, params, search, hash, children }) => createElement("a", {
          href: to.replace("$workspaceId", params?.workspaceId ?? "") + (hash ? "#" + hash : ""), "data-search": JSON.stringify(search),
        }, children);`,
      "../components/AgentGitHubCredentialCard": "export const AgentGitHubCredentialCard = () => null;",
      "../components/AgentRepositorySharingCard": "export const AgentRepositorySharingCard = () => null;",
      "../components/AgentWorkspaceReadme": `import { createElement } from "react";
        export const AgentWorkspaceReadme = props => createElement("div", null,
          createElement("button", { onClick: props.onCopy, disabled: props.copying, "data-copied": String(props.copied) }, "copy-prompt"),
          props.promptError && createElement("p", { role: "alert" }, props.promptErrorMessage),
          createElement("button", { onClick: () => props.onImport(globalThis.__agentAccessTest.uploadFiles) }, "test-upload"),
          createElement("button", { onClick: props.onScanLocal }, "test-scan"));`,
      "./desktop/runtime": "export const isDesktopRuntime = () => globalThis.__agentAccessTest.desktop;",
      "./desktop/network": "export const desktopFetch = () => { throw new Error('Unexpected desktop request'); };",
      "./desktop/offlineStore": "export const desktopResolveImageSource = () => { throw new Error('Unexpected offline image request'); };",
      "../desktop/runtime": "export const isDesktopRuntime = () => globalThis.__agentAccessTest.desktop; export const desktopAPIOrigin = () => 'https://koinote.example';",
      "../desktop/configFiles": "export const desktopScanAgentWorkspaceFiles = async () => globalThis.__agentAccessTest.scannedFiles; export const desktopRestoreConfigFiles = (...args) => globalThis.__agentAccessTest.restoreFiles('folder', ...args); export const desktopRestoreConfigFilesToHome = (...args) => globalThis.__agentAccessTest.restoreFiles('home', ...args);",
      "@tauri-apps/api/core": "export const invoke = (...args) => globalThis.__agentAccessTest.save(...args);",
      "../confirmAction": "export const confirmAction = (...args) => globalThis.__agentAccessTest.confirm(...args);",
      "../modalStack": "export const pushModal = () => () => {};",
    };
    window.location = { origin: "https://koinote.example" };
    builder.onResolve({ filter: /^\.\/api$/ }, ({ importer }) => importer.endsWith("agentWorkspaceTransfer.ts") ? { path: "../api", namespace: "agent-access" } : undefined);
    builder.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(adapters, path) ? { path, namespace: "agent-access" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "agent-access" }, ({ path }) => ({ contents: adapters[path] }));
    builder.onResolve({ filter: /^(?:react(?:-dom)?(?:\/|$)|@tanstack\/react-query$|lucide-react$)/ }, ({ path }) => ({ path: pathToFileURL(require.resolve(path)).href, external: true }));
  } }],
});
const { agentWorkspaceTransferTooLarge, AGENT_WORKSPACE_TRANSFER_MAX_BYTES, AGENT_WORKSPACE_TRANSFER_MAX_FILES, loadAgentWorkspaceFiles, saveAgentWorkspaceZip, validateAgentWorkspaceTransferPaths, AgentWorkspaceTransferDialog, realRestoreAgentWorkspaceCommit, createElement, act, createRoot, QueryClient, QueryClientProvider, ApiError, AgentWorkspaceRepositoryPage, AgentWorkspaceSettingsPage, AgentWorkspaceCard, StorageCard, MCPAccessCard, zh } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
harness.labels = zh;
const root = createRoot(document.getElementById("root"));
let client;
async function settle() {
  for (let attempt = 0; attempt < 3; attempt++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}
async function mount(component, props = {}) {
  await act(async () => root.render(null));
  client?.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(component, props))));
  await settle();
}
async function click(label) {
  const button = [...document.querySelectorAll("button")].find((item) => item.textContent === label);
  assert.ok(button, `Missing button: ${label}`);
  await act(async () => { userGesture = true; try { button.click(); } finally { userGesture = false; } });
  await settle();
}
const originalFetch = globalThis.fetch;
const token = (scope, revealable = true) => ({ tokenId: `${scope}-token`, name: `${scope}-credential`, scope, revealable, hint: "test-token" });

try {
  const restoreRequests = [];
  globalThis.fetch = async (path, init) => {
    restoreRequests.push({ path, ...init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ workspace: { workspaceId: 7 } }), { status: 200 });
  };
  await realRestoreAgentWorkspaceCommit(7, 0, 1);
  await realRestoreAgentWorkspaceCommit(7, 0, 1, true, "Restore reviewed settings");
  assert.deepEqual(restoreRequests.map(({ body }) => body), [{ expectedRevision: 1, allowSensitive: false }, { expectedRevision: 1, allowSensitive: true, comment: "Restore reviewed settings" }]);
  assert.ok(restoreRequests.every(({ path, method, credentials }) => path === "/api/agent/workspaces/7/commits/0/restore" && method === "POST" && credentials === "include"));
  globalThis.fetch = originalFetch;
  await mount(AgentWorkspaceSettingsPage);
  assert.ok(!document.body.textContent.includes(zh.agentWorkspace.tokenSettingsTitle));
  await click(zh.agentWorkspace.enable);
  assert.deepEqual(navigations.at(-1), { to: "/space", search: { tab: "agent" } });
  assert.equal(calls.filter((call) => call.method === "createMCPToken").length, 0, "enabling repositories does not create or require a token");
  assert.ok(document.body.textContent.includes(zh.agentWorkspace.storageSettingsTitle), "repository settings show storage controls");
  assert.ok(document.body.textContent.includes("0.0 KiB / 95.4 MiB"), "repository settings show storage usage and quota");
  assert.equal([...document.querySelectorAll("a")].some((link) => link.textContent?.includes(zh.agentWorkspace.storageExpand)), false, "storage settings do not link back to themselves");
  const allocationInput = () => document.getElementById("agent-storage-allocation");
  const allocationButton = () => document.querySelector('button[type="submit"]');
  const setAllocation = async (value) => {
    await act(async () => {
      const input = allocationInput();
      const previous = input.value;
      input.value = value;
      input._valueTracker?.setValue(previous);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };
  const submitAllocation = async () => {
    await act(async () => allocationInput().closest("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
    await settle();
  };
  assert.ok(allocationInput(), "storage settings directly expose allocation controls");
  assert.equal(document.querySelector("textarea"), null, "no manual request form remains");
  assert.equal(allocationButton().disabled, true, "unchanged allocation is not submitted");
  for (const invalid of ["", "-1", "0.5", "10241"]) {
    await setAllocation(invalid);
    assert.equal(allocationButton().disabled, true, `invalid allocation ${invalid} is disabled`);
  }
  client.setQueryData(["storage-usage"], { usedBytes: 0 });
  await setAllocation("512");
  assert.equal(allocationButton().disabled, false);
  let finishAllocation;
  harness.allocationWait = new Promise((resolve) => { finishAllocation = resolve; });
  await submitAllocation();
  assert.equal(allocationInput().disabled, true, "pending allocation cannot be edited or submitted twice");
  await act(async () => finishAllocation());
  await settle();
  harness.allocationWait = null;
  assert.equal(calls.findLast((call) => call.method === "updateAgentWorkspaceStorage").args[0], 512 * 1024 ** 2);
  assert.equal(client.getQueryData(["agent-workspace-storage"]).storage.allocatedBytes, 512 * 1024 ** 2);
  assert.equal(client.getQueryState(["storage-usage"]).isInvalidated, true, "account usage refreshes after allocation");
  assert.ok(document.body.textContent.includes(zh.agentWorkspace.storageAllocationSaved));
  assert.ok(document.body.textContent.includes("607.4 MiB"), "repository quota updates immediately");
  assert.equal(calls.some((call) => call.method === "submitFeedback"), false, "allocation never submits feedback");
  for (const [code, label] of [["storage_allocation_insufficient", "storageAllocationInsufficient"], ["storage_allocation_in_use", "storageAllocationInUse"]]) {
    harness.allocationError = new ApiError(409, code, code);
    await setAllocation("128");
    await submitAllocation();
    assert.ok(document.querySelector('[role="alert"]').textContent.includes(zh.agentWorkspace[label]));
    assert.equal(allocationInput().value, "128", "failed save preserves the requested value for retry");
  }
  harness.allocationError = null;
  await submitAllocation();
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.equal(harness.storage.allocatedBytes, 128 * 1024 ** 2, "reducing allocation returns unused space");
  await mount(StorageCard);
  assert.ok(document.body.textContent.includes(zh.storage.agentAllocated), "personal usage shows the reserved allocation");
  assert.ok(document.body.textContent.includes("128 MB"));
  harness.storage.usedBytes = 100000000 + 50 * 1024 ** 2;
  await mount(AgentWorkspaceSettingsPage);
  assert.equal(allocationInput().getAttribute("min"), "50", "files and retained history set the minimum allocation");
  await setAllocation("49");
  assert.equal(allocationButton().disabled, true);
  harness.storage.usedBytes = 0;
  harness.failStorage = true;
  await mount(AgentWorkspaceSettingsPage);
  assert.ok(document.querySelector('[role="alert"]')?.textContent.includes(zh.storage.loadFailed), "storage failures are visible to the user");
  assert.equal(document.body.textContent.includes("0.0 KiB / 95.4 MiB"), false, "storage failures do not display fake usage");
  assert.equal(document.getElementById("agent-storage-allocation"), null, "allocation is unavailable until storage loads successfully");
  harness.failStorage = false;

  calls.length = 0;
  await mount(AgentWorkspaceCard, { user: harness.user });
  assert.ok(document.body.textContent.includes(zh.agentWorkspace.createFirst), "the older settings entry also allows repositories without a token");
  assert.ok(!document.body.textContent.includes(zh.mcp.tokenName), "repository tokens are configured only in My Space settings");
  assert.equal(calls.filter((call) => call.method === "listMCPTokens" || call.method === "createMCPToken").length, 0);

  for (const agentOnly of [false, true]) {
    harness.tokens = ["read", "write", "publish", "agent_read", "agent_write"].map((scope) => token(scope));
    await mount(MCPAccessCard, { user: harness.user, agentOnly });
    for (const credential of harness.tokens) {
      const isAgentToken = credential.scope.startsWith("agent_");
      assert.equal([...document.querySelectorAll("p")].some((element) => element.textContent === credential.name), isAgentToken === agentOnly, "token lists must stay separate in both settings pages");
    }
    const scopes = [...document.querySelectorAll("select")[0].querySelectorAll("option")].map((option) => option.value);
    assert.deepEqual(scopes, agentOnly ? ["agent_read", "agent_write"] : ["read", "write", "publish"]);
  }

  for (const agentOnly of [false, true]) {
    harness.tokens = Array.from({ length: 20 }, (_, index) => ({
      ...token(agentOnly ? "write" : "agent_write"), tokenId: `limit-${index}`,
    }));
    harness.createError = new ApiError(409, "Revoke an existing token before creating another", "mcp_token_limit_reached");
    await mount(MCPAccessCard, { user: harness.user, agentOnly });
    assert.ok(document.body.textContent.includes(zh.mcp.empty), "tokens in the other settings page stay hidden");
    await click(zh.mcp.create);
    const alert = document.querySelector('[role="alert"]');
    assert.ok(alert?.textContent.includes(zh.mcp.sharedTokenLimitReached), "explain the shared limit even when this token list is empty");
    assert.ok(!alert.textContent.includes(zh.mcp.createFailed));
    const manageLink = alert.querySelector("a");
    assert.equal(manageLink?.getAttribute("href"), agentOnly ? "/settings#mcp" : "/space/settings");
    assert.equal(manageLink.textContent, agentOnly ? zh.mcp.manageDocumentTokens : zh.mcp.manageRepositoryTokens);
    if (agentOnly) assert.deepEqual(JSON.parse(manageLink.getAttribute("data-search")), { section: "ai" });

    harness.tokens = [];
    harness.createError = null;
    await click(zh.mcp.create);
    assert.equal(document.querySelector('[role="alert"]'), null, "a successful retry clears the limit warning");
    assert.ok(document.body.textContent.includes(zh.mcp.secretStored));
    const configuration = [...document.querySelectorAll("pre")].map((block) => block.textContent).join("\n");
    const expectedServer = agentOnly ? "koinote-agent" : "koinote";
    const expectedEnv = agentOnly ? "KOINOTE_AGENT_TOKEN" : "KOINOTE_MCP_TOKEN";
    assert.ok(configuration.includes(`[mcp_servers.${expectedServer}]`), "connections use different server names");
    assert.ok(configuration.includes(`bearer_token_env_var = "${expectedEnv}"`));
    assert.ok(configuration.includes(`Bearer {env:${expectedEnv}}`), "OpenCode uses the correct token environment");
    const configs = [...document.querySelectorAll("pre")].map((block) => block.textContent);
    const claudeConfig = configs.find((block) => block.includes("# .mcp.json"));
    const claudeJSON = JSON.parse(claudeConfig.slice(claudeConfig.indexOf("{")));
    assert.equal(claudeJSON.mcpServers[expectedServer].headers.Authorization, "Bearer ${" + expectedEnv + "}");
    assert.ok(!JSON.stringify(claudeJSON).includes("test-agent-secret"), "Claude persists an environment reference, not the credential");
    const openClawConfig = configs.find((block) => block.includes("openclaw mcp add"));
    // Execute the displayed shell syntax with a fake CLI that captures its arguments.
    // Double quotes would expand the credential here and fail this regression check.
    const captured = execFileSync("/bin/sh", ["-c", 'openclaw() { printf "%s\\n" "$@"; };\n' + openClawConfig], { encoding: "utf8" });
    assert.ok(captured.includes("--no-probe"), "defer probing until the saved config resolves environment references");
    assert.ok(captured.includes("Authorization=Bearer ${" + expectedEnv + "}"), "OpenClaw receives a literal runtime reference");
    assert.ok(!captured.includes("test-agent-secret"), "OpenClaw configuration arguments never contain the credential");
    assert.ok(configuration.includes(`openclaw mcp doctor ${expectedServer} --probe`));
    if (agentOnly) {
      assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').textContent, zh.agentWorkspace.mcpTitle, "repository setup defaults to MCP");
      assert.ok(!configuration.includes("KOINOTE_MCP_TOKEN"), "repository setup cannot overwrite the document token environment");
      await click(zh.agentWorkspace.apiTitle);
      assert.ok(document.querySelector('pre').textContent.includes('/api/agent/workspaces'), "REST access remains available");
      await click(zh.agentWorkspace.mcpTitle);
    }


    for (const failure of [new ApiError(409, "Other conflict", "other_conflict"), new Error("network unavailable")]) {
      harness.createError = failure;
      await mount(MCPAccessCard, { user: harness.user, agentOnly });
      await click(zh.mcp.create);
      const genericAlert = document.querySelector('[role="alert"]');
      assert.equal(genericAlert?.textContent, zh.mcp.createFailed, "unrelated errors retain the generic error message");
      assert.equal(genericAlert.querySelector("a"), null);
    }
  }
  harness.createError = null;

  for (const credentials of [[], [token("write")], [token("agent_read")], [token("agent_write", false)]]) {
    harness.tokens = credentials;
    navigations.length = 0;
    calls.length = 0;
    await mount(AgentWorkspaceRepositoryPage);
    assert.equal(calls.filter((call) => call.method === "listMCPTokens").length, 0, "opening a repository does not fetch tokens");
    await click("copy-prompt");
    assert.deepEqual(navigations, [{ to: "/space/settings", search: { workspaceId: 7 } }]);
    assert.equal(clipboard.length, 0);
    assert.equal(calls.filter((call) => call.method === "revealMCPToken" || call.method === "createMCPToken").length, 0);
    assert.equal(document.querySelector("[data-copied]").getAttribute("data-copied"), "false", "redirecting must not report a successful copy");
  }

  harness.search = { workspaceId: 7 };
  harness.tokens = [];
  await mount(AgentWorkspaceSettingsPage);
  assert.ok(document.body.textContent.includes(zh.agentWorkspace.clientUploadWithoutToken));
  assert.ok(document.body.textContent.includes(zh.agentWorkspace.promptWriteTokenRequired));
  assert.ok(document.querySelector('a[href="/agent/workspaces/7"]'), "token setup retains a route back to the initiating repository");
  await click(zh.mcp.create);
  assert.equal(calls.findLast((call) => call.method === "createMCPToken").args[0].scope, "agent_write");
  harness.search = { from: "space" };
  navigations.length = 0;
  await mount(AgentWorkspaceRepositoryPage);
  client.setQueryData(["mcp-tokens"], { tokens: [] });
  await click("copy-prompt");
  assert.equal(navigations.length, 0, "a newly created token is found despite a stale query cache");
  assert.equal(clipboard.length, 1);
  assert.match(clipboard[0], /Instructions for repository 7/);
  assert.match(clipboard[0], /KOINOTE_AGENT_TOKEN=test-agent-secret/);
  assert.equal(document.querySelector("[data-copied]").getAttribute("data-copied"), "true");

  harness.tokens = [];
  harness.failTokenList = true;
  navigations.length = 0;
  await mount(AgentWorkspaceRepositoryPage);
  await click("copy-prompt");
  assert.equal(navigations.length, 0, "a token lookup failure must not be treated as an absent token");
  assert.ok(document.querySelector('[role="alert"]'));
  assert.equal(clipboard.length, 1);
  harness.failTokenList = false;
  harness.commits = [{ commitId: "historical", revision: 0, action: "patch", createdAt: "2026-10-08T00:00:00Z", comment: "Restore reviewed settings" }];
  const sensitiveRestoreError = () => new ApiError(422, 'sensitive data detected in "settings.json"', "sensitive_data_detected");
  const restoreCalls = () => calls.filter((call) => call.method === "restoreAgentWorkspaceCommit").map((call) => call.args);
  const resetRestore = async (responses = [], confirmations = [true, true]) => {
    harness.workspaceRevision = 1;
    harness.restoreResponses = responses;
    harness.confirmations = [];
    harness.confirmationResults = confirmations;
    await mount(AgentWorkspaceRepositoryPage);
    calls.length = 0;
  };

  await resetRestore([], [false]);
  await click(zh.agentWorkspace.restore);
  assert.deepEqual(restoreCalls(), [], "cancelling the initial restore never sends a request");

  await resetRestore([sensitiveRestoreError(), null]);
  await click(zh.agentWorkspace.restore);
  assert.deepEqual(restoreCalls(), [[7, 0, 1, false, ""], [7, 0, 1, true, ""]], "only confirmed sensitive restores send allowSensitive");
  assert.deepEqual(harness.confirmations, [zh.agentWorkspace.restoreCommitConfirm.replace("{revision}", "0"), zh.agentWorkspace.restoreSensitiveConfirm.replace("{revision}", "0")]);
  assert.equal(document.querySelector('[role="alert"]'), null);
  for (const method of ["getAgentWorkspace", "listAgentWorkspaceCommits", "getAgentWorkspaceStorage"]) {
    assert.ok(calls.some((call) => call.method === method), `successful restore refreshes ${method}`);
  }

  await resetRestore([new ApiError(422, "Sensitive comment", "sensitive_comment")]);
  await click(zh.agentWorkspace.restore);
  assert.equal(restoreCalls().length, 1, "sensitive comments are not retried with allowSensitive");
  assert.equal(harness.confirmations.length, 1, "no misleading sensitive-file confirmation for a comment");
  assert.equal(document.querySelector('[role="alert"]').textContent, zh.agentWorkspace.changeCommentSensitive);

  await resetRestore([sensitiveRestoreError(), null]);
  assert.ok(document.body.textContent.includes("Restore reviewed settings"), "history displays the change description");
  await act(async () => {
    const input = [...document.querySelectorAll("textarea")].find(element => element.getAttribute("placeholder") === zh.agentWorkspace.changeCommentHint);
    assert.ok(Boolean(input), "the optional change description is editable");
    const props = input[Object.keys(input).find(key => key.startsWith("__reactProps"))];
    props.onChange({ target: { value: "Recover reviewed settings" } });
  });
  await click(zh.agentWorkspace.restore);
  assert.deepEqual(restoreCalls(), [[7, 0, 1, false, "Recover reviewed settings"], [7, 0, 1, true, "Recover reviewed settings"]], "sensitive confirmation preserves the change description");
  assert.equal(document.querySelector('textarea').value, "", "successful restore clears its description");


  await resetRestore([sensitiveRestoreError()], [true, false]);
  await click(zh.agentWorkspace.restore);
  assert.deepEqual(restoreCalls(), [[7, 0, 1, false, ""]], "declining the sensitive override never retries");
  assert.ok(document.querySelector('[role="alert"]').textContent.includes(zh.agentWorkspace.restoreSensitiveData));
  assert.ok(document.querySelector('[role="alert"]').textContent.includes("settings.json"));

  for (const failure of [new ApiError(409, "conflict", "revision_conflict"), new Error("network unavailable")]) {
    await resetRestore([failure]);
    await click(zh.agentWorkspace.restore);
    assert.deepEqual(restoreCalls(), [[7, 0, 1, false, ""]], "ordinary errors never bypass checks or retry automatically");
    assert.equal(harness.confirmations.length, 1);
    assert.ok(document.querySelector('[role="alert"]').textContent.includes(failure instanceof ApiError ? zh.agentWorkspace.scanRevisionConflict : failure.message));
    harness.restoreResponses = [null];
    await click(zh.agentWorkspace.restore);
    assert.equal(document.querySelector('[role="alert"]'), null, "a successful retry clears the old restore error");
  }

  await resetRestore([sensitiveRestoreError(), new ApiError(409, "conflict", "revision_conflict")]);
  let confirmRestore;
  harness.confirmationWait = new Promise((resolve) => { confirmRestore = resolve; });
  await click(zh.agentWorkspace.restore);
  assert.deepEqual(restoreCalls(), [[7, 0, 1, false, ""]]);
  assert.ok([...document.querySelectorAll("button")].find((button) => button.textContent === zh.agentWorkspace.restore).disabled, "restore remains pending during confirmation");
  // A background refresh must not silently change the revision covered by consent.
  await act(async () => client.setQueryData(["agent-workspace", 7], { workspace: { ...client.getQueryData(["agent-workspace", 7]).workspace, revision: 9 } }));
  await act(async () => confirmRestore());
  await settle();
  harness.confirmationWait = null;
  assert.deepEqual(restoreCalls(), [[7, 0, 1, false, ""], [7, 0, 1, true, ""]]);
  assert.ok(document.querySelector('[role="alert"]').textContent.includes(zh.agentWorkspace.scanRevisionConflict), "a conflict on the confirmed retry is visible");

  // Repository export must preserve binary content and a single captured revision.
  const makeFile = (fileId, path, bytes) => ({ fileId, path, mimeType: "application/octet-stream", sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), contentBase64: Buffer.from(bytes).toString("base64") });
  const cloudFiles = [makeFile(21, ".codex/skills/demo/SKILL.md", Buffer.from("# 你好\n")), makeFile(22, "README.md", Buffer.from("# Repository")), makeFile(23, "assets/icon.bin", Buffer.from([0, 128, 255, 42]))];
  harness.workspaceRevision = 3;
  harness.workspaceFiles = cloudFiles.map(({ contentBase64, ...metadata }) => metadata);
  harness.fileContents = new Map(cloudFiles.map(file => [file.fileId, file]));
  const snapshot = { workspaceId: 7, name: "测试仓库", revision: 3, files: harness.workspaceFiles };
  const setComment = async value => act(async () => {
    const input = document.querySelector(`textarea[placeholder="${zh.agentWorkspace.changeCommentHint}"]`);
    input[Object.keys(input).find(key => key.startsWith("__reactProps"))].onChange({target:{value}});
  });
  const currentComment = () => document.querySelector(`textarea[placeholder="${zh.agentWorkspace.changeCommentHint}"]`).value;
  harness.uploadFiles = [new File(["# Upload"], "SKILL.md", {type:"text/markdown"})];
  await mount(AgentWorkspaceRepositoryPage);
  await setComment("Upload this skill");
  await click("test-upload");
  assert.equal(calls.findLast(call => call.method === "updateAgentWorkspace").args[0].comment, "Upload this skill");
  assert.equal(currentComment(), "", "successful upload clears its description");

  harness.desktop = true;
  harness.scannedFiles = [{path:cloudFiles[0].path, bytes:Buffer.from("# Changed local skill")}];
  await mount(AgentWorkspaceRepositoryPage);
  await setComment("Sync local skill");
  await click("test-scan");
  await click(zh.agentWorkspace.scanReviewUpload + zh.agentWorkspace.scanReviewUploading);
  assert.equal(calls.findLast(call => call.method === "patchAgentWorkspace").args[0].comment, "Sync local skill");
  assert.equal(currentComment(), "", "successful local upload clears its description");

  await setComment("Edit skill");
  await act(async () => {
    const fileButton=[...document.querySelectorAll("button")].find(button => button.textContent.includes("README.md"));
    assert.ok(fileButton); fileButton.click();
  });
  await settle();
  await click(zh.agentWorkspace.edit);
  await click(zh.agentWorkspace.save);
  assert.equal(calls.findLast(call => call.method === "patchAgentWorkspace").args[0].comment, "Edit skill");
  assert.equal(currentComment(), "", "successful editor save clears its description");
  harness.workspaceRevision = 3;
  harness.desktop = false;
  await act(async()=>root.render(null));
  const selectedIDs = new Set([21, 23]);
  const loaded = await loadAgentWorkspaceFiles(snapshot, selectedIDs, () => {});
  assert.deepEqual(loaded.map(file => file.path), [cloudFiles[0].path, cloudFiles[2].path]);
  assert.deepEqual(Buffer.from(loaded[1].bytes), Buffer.from([0, 128, 255, 42]));
  harness.desktop = true;
  await saveAgentWorkspaceZip(loaded, "测试仓库-r3");
  const archive = harness.nativeCalls.pop();
  assert.equal(archive.command, "desktop_save_export");
  assert.equal(decodeURIComponent(archive.options.headers["x-koinote-export-filename"]), "测试仓库-r3.zip");
  const unpacked = unzipSync(archive.bytes);
  assert.deepEqual(Object.keys(unpacked), loaded.map(file => file.path));
  assert.deepEqual(Buffer.from(unpacked[loaded[1].path]), Buffer.from(loaded[1].bytes));

  const specialFiles = ["__proto__", "constructor", "toString", "assets/__proto__"].map(path => ({ path, bytes: new TextEncoder().encode(`file:${path}`) }));
  await saveAgentWorkspaceZip(specialFiles, `A${"😀".repeat(40)}`);
  const specialArchive = harness.nativeCalls.pop();
  const extracted = JSON.parse(execFileSync("python3", ["-c", "import io,sys,zipfile,json; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps({n:z.read(n).decode() for n in z.namelist()}))"], { input: Buffer.from(specialArchive.bytes), encoding: "utf8" }));
  assert.deepEqual(Object.entries(extracted), specialFiles.map(file => [file.path, new TextDecoder().decode(file.bytes)]), "an independent ZIP reader recovers every special-name file");
  assert.ok(decodeURIComponent(specialArchive.options.headers["x-koinote-export-filename"]).endsWith("😀.zip"), "long emoji names never split a surrogate pair");

  const totalLimit = AGENT_WORKSPACE_TRANSFER_MAX_BYTES;
  assert.equal(agentWorkspaceTransferTooLarge([{ sizeBytes: totalLimit }]), false);
  assert.equal(agentWorkspaceTransferTooLarge([{ sizeBytes: totalLimit }, { sizeBytes: 1 }]), true);
  assert.equal(agentWorkspaceTransferTooLarge(Array.from({length: AGENT_WORKSPACE_TRANSFER_MAX_FILES + 1}, () => ({sizeBytes: 0}))), true);
  const oversizedFiles = Array.from({length: 13}, (_, index) => ({...cloudFiles[0], fileId: index + 100, path: `.codex/skills/large/${index}.bin`, sizeBytes: 5 << 20}));
  const oversizedSnapshot = { ...snapshot, files: oversizedFiles };
  const requestsBeforeOversize = calls.length;
  await assert.rejects(() => loadAgentWorkspaceFiles(oversizedSnapshot, new Set(oversizedFiles.map(file => file.fileId)), () => {}), /transferTooLarge/);
  assert.equal(calls.length, requestsBeforeOversize, "reject oversized batches before any network request");
  await mount(AgentWorkspaceTransferDialog, { workspace: oversizedSnapshot, initialDestination: "home", onClose() {}, onComplete() { assert.fail("oversized selection completed"); } });
  assert.ok(document.querySelector('[role="alert"]').textContent.includes("64 MiB"));
  assert.ok([...document.querySelectorAll("button")].find(button => button.textContent === zh.agentWorkspace.transferConfirmSync).disabled);

  for (const path of ["../outside", "/absolute", "C:/outside", "bad\\path", "a/../b"]) {
    assert.throws(() => validateAgentWorkspaceTransferPaths([{ path }]), /transferInvalidPath/);
  }
  assert.throws(() => validateAgentWorkspaceTransferPaths([{ path: "same" }, { path: "same/child" }]), /transferInvalidPath/);
  harness.revisionResponses = [3, 4];
  await assert.rejects(() => loadAgentWorkspaceFiles(snapshot, selectedIDs, () => {}), /transferChanged/);
  harness.fileContents.set(23, { ...cloudFiles[2], contentBase64: Buffer.from([0, 128, 255, 43]).toString("base64") });
  await assert.rejects(() => loadAgentWorkspaceFiles(snapshot, selectedIDs, () => {}), /transferChanged/);
  harness.fileContents.set(23, new ApiError(404, "missing", "not_found"));
  await assert.rejects(() => loadAgentWorkspaceFiles(snapshot, selectedIDs, () => {}), /transferChanged/);
  harness.fileContents.set(23, cloudFiles[2]);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(() => loadAgentWorkspaceFiles(snapshot, selectedIDs, () => {}, aborted.signal), /abort/i);

  const completed = [];
  const transferProps = { workspace: snapshot, initialDestination: "home", onClose() {}, onComplete: message => completed.push(message) };
  harness.nativeCalls = [];
  await mount(AgentWorkspaceTransferDialog, transferProps);
  assert.ok(document.querySelector('input[aria-label="选择 README.md"]').disabled, "root README is not restored to HOME");
  await click(zh.agentWorkspace.transferConfirmSync);
  assert.equal(harness.nativeCalls.length, 1);
  assert.equal(harness.nativeCalls[0].destination, "home");
  assert.deepEqual(harness.nativeCalls[0].files.map(file => file.path), [cloudFiles[0].path]);
  assert.equal(harness.nativeCalls[0].locale, "zh");
  assert.equal(completed.pop(), zh.agentWorkspace.transferSynced.replace("{count}", "1"));

  harness.restoreCount = 0;
  await mount(AgentWorkspaceTransferDialog, transferProps);
  await click(zh.agentWorkspace.transferConfirmSync);
  assert.ok(document.querySelector('[role="status"]').textContent.includes(zh.agentWorkspace.transferCancelled));
  assert.equal(completed.length, 0, "cancelling the native restore is not success");
  harness.restoreCount = null;

  const restoreFilesBeforeError = harness.restoreFiles;
  for (const [code, message] of [
    ["config_platform_path_conflict", zh.space.configSnapshots.errorPlatformConflict],
    ["config_platform_path_unsupported", zh.space.configSnapshots.errorPlatformUnsupported],
  ]) {
    harness.restoreFiles = async () => { throw code; };
    await mount(AgentWorkspaceTransferDialog, transferProps);
    assert.ok(document.body.textContent.includes(zh.space.configSnapshots.crossPlatformHint));
    await click(zh.agentWorkspace.transferConfirmSync);
    assert.equal(document.querySelector('[role="alert"]').textContent, message);
    assert.equal(completed.length, 0, "platform conflicts do not report success");
  }
  harness.restoreFiles = restoreFilesBeforeError;

  harness.nativeCalls = [];
  harness.revisionResponses = [4];
  await mount(AgentWorkspaceTransferDialog, transferProps);
  await click(zh.agentWorkspace.transferConfirmSync);
  assert.ok(document.querySelector('[role="alert"]').textContent.includes(zh.agentWorkspace.transferChanged));
  assert.equal(harness.nativeCalls.length, 0, "conflicting revisions never reach the local writer");

  let finishDownload;
  harness.fileWait = new Promise(resolve => { finishDownload = resolve; });
  await mount(AgentWorkspaceTransferDialog, transferProps);
  await click(zh.agentWorkspace.transferConfirmSync);
  assert.ok(document.querySelector('[aria-busy="true"]'));
  await act(async () => root.render(null));
  await act(async () => finishDownload());
  await settle();
  harness.fileWait = null;
  assert.equal(harness.nativeCalls.length, 0, "leaving the dialog aborts before local writes");

  let transferClosed = false;
  const originalFile = harness.fileContents.get(cloudFiles[0].fileId);
  harness.fileContents.set(cloudFiles[0].fileId, new ApiError(429, "rate limited", "rate_limited"));
  await mount(AgentWorkspaceTransferDialog, { ...transferProps, onClose() { transferClosed = true; } });
  await click(zh.agentWorkspace.transferConfirmSync);
  assert.ok(document.querySelector('[role="status"]').textContent.includes(zh.agentWorkspace.transferRateLimited), "rate-limit waiting is visible");
  const cancelTransfer = [...document.querySelectorAll("button")].find(button => button.textContent === zh.agentWorkspace.scanReviewCancel);
  assert.ok(cancelTransfer && !cancelTransfer.disabled, "users can cancel while the readers wait");
  await click(zh.agentWorkspace.scanReviewCancel);
  assert.ok(transferClosed);
  assert.equal(harness.nativeCalls.length, 0, "cancelling the retry wait never reaches the local writer");
  await act(async () => root.render(null));
  harness.fileContents.set(cloudFiles[0].fileId, originalFile);

  const folderProps = { ...transferProps, workspace: { ...snapshot, files: snapshot.files.slice(1) } };
  harness.confirmationResults = [false];
  await mount(AgentWorkspaceTransferDialog, folderProps);
  await click(zh.agentWorkspace.transferConfirmSync);
  assert.equal(harness.nativeCalls.length, 0, "declined folder overwrite confirmation never writes");
  harness.confirmationResults = [true];
  await click(zh.agentWorkspace.transferConfirmSync);
  assert.equal(harness.nativeCalls[0].destination, "folder");
  assert.deepEqual(harness.nativeCalls[0].files.map(file => file.path), ["README.md", "assets/icon.bin"]);

  harness.desktop = false;
  await mount(AgentWorkspaceRepositoryPage);
  assert.ok([...document.querySelectorAll("button")].some(button => button.textContent === zh.agentWorkspace.transferDownload));
  await click(zh.agentWorkspace.transferSync);
  assert.ok(document.querySelector('[role="menu"]'));
  assert.ok([...document.querySelectorAll('[role="menuitem"]')].some(button => button.textContent === zh.space.configSnapshots.downloadWithKoinote), "browser Koinote option downloads ZIP");
  harness.tokens = [
    { tokenId: "writer-only", scope: "agent_write", revealable: true },
    { ...token("agent_read"), tokenId: "permanent", name: "Local Skills/Agent sync", expiresAt: null },
    { ...token("agent_read"), tokenId: "long-lived", name: "Local Skills/Agent sync", expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() },
    { ...token("agent_read"), tokenId: "personal", expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
  ];
  const callsBeforeLocalCopy = calls.length;
  globalThis.ClipboardItem = class { constructor(data) { this.data = data; } };
  let clipboardStarts = 0;
  navigator.clipboard.write = async items => {
    assert.equal(userGesture, true, "repository copy must start before mutation/network awaits");
    clipboardStarts++;
    clipboard.push(await (await items[0].data["text/plain"]).text());
  };
  await click(zh.space.configSnapshots.syncWithAgent);
  assert.equal(clipboardStarts, 1);
  assert.equal(calls.findLast(call => call.method === "createMCPToken").args[0].scope, "agent_read", "local merge never creates a write token");
  assert.equal(calls.findLast(call => call.method === "createMCPToken").args[0].expiresInDays, 1);
  assert.ok(!calls.slice(callsBeforeLocalCopy).some(call => call.method === "revealMCPToken" && call.args[0] === "writer-only"), "local merge never reveals a write token");
  assert.ok(!calls.slice(callsBeforeLocalCopy).some(call => call.method === "revealMCPToken"), "local sync must not reveal permanent, long-lived or unrelated tokens");
  assert.ok(clipboard.at(-1).includes("MCP endpoint: https://example.test/mcp"));
  assert.ok(clipboard.at(-1).includes("Authorization: Bearer test-agent-secret"));
  assert.ok(clipboard.at(-1).includes("Target workspaceId: 7"));
  assert.ok(clipboard.at(-1).includes("merge with existing local configuration"));
  const tokensAfterCopy = harness.tokens.length;
  await click(zh.agentWorkspace.transferSync);
  await click(zh.space.configSnapshots.syncWithAgent);
  assert.equal(harness.tokens.length, tokensAfterCopy, "repeat copy reuses a read token");
  navigator.clipboard.write = async () => { throw new DOMException("denied", "NotAllowedError"); };
  await click(zh.agentWorkspace.transferSync); await click(zh.space.configSnapshots.syncWithAgent);
  assert.equal(document.querySelector('[role="dialog"]').getAttribute("aria-labelledby"), "agent-copy-title");
  const callsBeforeRetry = calls.length;
  navigator.clipboard.writeText = async text => { assert.equal(userGesture, true); clipboard.push(text); };
  await click(zh.space.configSnapshots.syncWithAgent);
  assert.equal(calls.length, callsBeforeRetry, "repository clipboard retry neither creates nor reveals another token");
  delete globalThis.ClipboardItem;
  delete navigator.clipboard.write;
  await click(zh.agentWorkspace.transferDownload);
  assert.equal(document.querySelector('select').querySelectorAll('option').length, 1, "browser export only offers ZIP");

  console.log("agent repository optional tokens, isolated settings, shared token limit guidance, on-demand setup, copy, history restore and repository download/local sync checks passed");
} finally {
  globalThis.fetch = originalFetch;
  await act(async () => root.unmount());
  client?.clear();
  stop();
  delete globalThis.__agentAccessTest;
}
