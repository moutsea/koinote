import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { parseHTML } from "linkedom";

const require = createRequire(import.meta.url);
const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
const calls = [];
const navigations = [];
const clipboard = [];
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "Node.js", clipboard: { writeText: async (text) => clipboard.push(text) } },
  configurable: true,
});
const harness = {
  enabled: false,
  tokens: [],
  search: {},
  labels: null,
  failTokenList: false,
  failStorage: false,
  createError: null,
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
      const token = { ...args[0], tokenId: "created-agent-token", hint: "test-token", revealable: true };
      harness.tokens.push(token);
      return { token, secret: "test-agent-secret" };
    }
    if (method === "revealMCPToken") return { secret: "test-agent-secret" };
    if (method === "getAgentWorkspacePrompt") return { prompt: "Instructions for repository 7" };
    if (method === "getAgentWorkspaceStorage") {
      if (harness.failStorage) throw new Error("storage unavailable");
      return { storage: { usedBytes: 0, quotaBytes: 100000000 } };
    }
    if (method === "submitFeedback") return { feedback: { id: 1, category: args[0].category, message: args[0].message, pagePath: args[0].pagePath, client: "web", createdAt: "2026-10-08T00:00:00Z" } };
    if (method === "listAgentWorkspaces") return { workspaces: [] };
    if (method === "listAgentWorkspaceCommits") return { commits: [] };
    if (method === "getAgentWorkspace") return {
      workspace: { workspaceId: 7, name: "Test repository", description: "", revision: 1, files: [], updatedAt: "2026-10-08T00:00:00Z" },
    };
    throw new Error(`Unexpected API call: ${method}`);
  },
};
globalThis.__agentAccessTest = harness;
const bundle = await build({
  stdin: {
    contents: `export { createElement, act } from "react";
      export { ApiError } from "../api";
      export { createRoot } from "react-dom/client";
      export { QueryClient, QueryClientProvider } from "@tanstack/react-query";
      export { AgentWorkspaceRepositoryPage } from "./spa/src/pages/AgentWorkspaceRepositoryPage";
      export { AgentWorkspaceSettingsPage } from "./spa/src/pages/AgentWorkspaceSettingsPage";
      export { MCPAccessCard } from "./spa/src/components/MCPAccessCard";
      export { AgentWorkspaceCard } from "./spa/src/components/AgentWorkspaceCard";
      export { zh } from "./spa/src/i18n/zh";`,
    resolveDir: process.cwd(),
  },
  bundle: true, format: "esm", platform: "node", write: false, jsx: "automatic",
  plugins: [{ name: "agent-access-adapters", setup(builder) {
    const methods = [
      "createMCPToken", "listMCPTokens", "revealMCPToken", "revokeMCPToken", "updateMCPTokenExpiry",
      "getAgentWorkspaceSettings", "updateAgentWorkspaceSettings", "getAgentWorkspace", "getAgentWorkspaceFile",
      "getAgentWorkspacePrompt", "getAgentWorkspaceStorage", "listAgentWorkspaceCommits", "patchAgentWorkspace",
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
      "../i18n": "export const useI18n = () => ({ t: globalThis.__agentAccessTest.labels, locale: 'zh' });",
      "@tanstack/react-router": `import { createElement } from "react";
        export const useNavigate = () => globalThis.__agentAccessTest.navigate;
        export const useSearch = () => globalThis.__agentAccessTest.search;
        export const useParams = () => ({ workspaceId: "7" });
        export const useRouterState = ({ select }) => select({ location: { pathname: "/space/settings" } });
        export const Link = ({ to, params, search, hash, children }) => createElement("a", {
          href: to.replace("$workspaceId", params?.workspaceId ?? "") + (hash ? "#" + hash : ""), "data-search": JSON.stringify(search),
        }, children);`,
      "../components/AgentWorkspaceReadme": `import { createElement } from "react";
        export const AgentWorkspaceReadme = props => createElement("div", null,
          createElement("button", { onClick: props.onCopy, disabled: props.copying, "data-copied": String(props.copied) }, "copy-prompt"),
          props.promptError && createElement("p", { role: "alert" }, props.promptErrorMessage));`,
      "../desktop/runtime": "export const isDesktopRuntime = () => false; export const desktopAPIOrigin = () => 'https://koinote.example';",
      "../desktop/configFiles": "export const desktopScanAgentWorkspaceFiles = async () => [];",
      "../confirmAction": "export const confirmAction = async () => true;",
      "../modalStack": "export const pushModal = () => () => {};",
    };
    window.location = { origin: "https://koinote.example" };
    builder.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(adapters, path) ? { path, namespace: "agent-access" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "agent-access" }, ({ path }) => ({ contents: adapters[path] }));
    builder.onResolve({ filter: /^(?:react(?:-dom)?(?:\/|$)|@tanstack\/react-query$|lucide-react$)/ }, ({ path }) => ({ path: pathToFileURL(require.resolve(path)).href, external: true }));
  } }],
});
const { createElement, act, createRoot, QueryClient, QueryClientProvider, ApiError, AgentWorkspaceRepositoryPage, AgentWorkspaceSettingsPage, AgentWorkspaceCard, MCPAccessCard, zh } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
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
  await act(async () => button.click());
  await settle();
}
const token = (scope, revealable = true) => ({ tokenId: `${scope}-token`, name: `${scope}-credential`, scope, revealable, hint: "test-token" });

try {
  await mount(AgentWorkspaceSettingsPage);
  assert.ok(!document.body.textContent.includes(zh.agentWorkspace.tokenSettingsTitle));
  await click(zh.agentWorkspace.enable);
  assert.deepEqual(navigations.at(-1), { to: "/space", search: { tab: "agent" } });
  assert.equal(calls.filter((call) => call.method === "createMCPToken").length, 0, "enabling repositories does not create or require a token");
  assert.ok(document.body.textContent.includes(zh.agentWorkspace.storageSettingsTitle), "repository settings show storage controls");
  assert.ok(document.body.textContent.includes("0.0 KiB / 95.4 MiB"), "repository settings show storage usage and quota");
  assert.equal([...document.querySelectorAll("a")].some((link) => link.textContent?.includes(zh.agentWorkspace.storageExpand)), false, "storage settings do not link back to themselves");
  await click(zh.agentWorkspace.storageRequest);
  assert.ok(document.querySelector("textarea"), "storage settings open an expansion request form");
  harness.failStorage = true;
  await mount(AgentWorkspaceSettingsPage);
  assert.ok(document.querySelector('[role="alert"]')?.textContent.includes(zh.storage.loadFailed), "storage failures are visible to the user");
  assert.equal(document.body.textContent.includes("0.0 KiB / 95.4 MiB"), false, "storage failures do not display fake usage");
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
  assert.match(clipboard[0], /KOINOTE_MCP_TOKEN=test-agent-secret/);
  assert.equal(document.querySelector("[data-copied]").getAttribute("data-copied"), "true");

  harness.tokens = [];
  harness.failTokenList = true;
  navigations.length = 0;
  await mount(AgentWorkspaceRepositoryPage);
  await click("copy-prompt");
  assert.equal(navigations.length, 0, "a token lookup failure must not be treated as an absent token");
  assert.ok(document.querySelector('[role="alert"]'));
  assert.equal(clipboard.length, 1);
  console.log("agent repository optional tokens, isolated settings, shared token limit guidance, on-demand setup and copy checks passed");
} finally {
  await act(async () => root.unmount());
  client?.clear();
  stop();
  delete globalThis.__agentAccessTest;
}
