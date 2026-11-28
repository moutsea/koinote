import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({
  stdin: {
    contents: 'export * from "./spa/src/mcpKnowledge"; export * from "./spa/src/i18n/mcpKnowledge";',
    resolveDir: root,
  },
  bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent",
});
const { MCP_CLIENTS, MCP_TOOL_GROUPS, MCP_TOKEN_SETUP, mcpKnowledge } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const names = (source) => [...source.matchAll(/\bName:\s*"([a-z][a-z0-9_]+)"/g)].map((match) => match[1]);
const sorted = (values) => [...values].sort();
const registered = read("backend/internal/server/mcp.go").split("func (a *App) newMCPServer")[1].split("type mcpDocumentHistorySettingsInput")[0];
const readTools = names(registered.split("readOnly :=")[1].split("addWechatGeoTools :=")[0]);
const geoTools = names(registered.split("addWechatGeoTools :=")[1].split("if principal.canWrite()")[0]);
const writeTools = [...readTools, ...geoTools, ...names(registered.split("if principal.canWrite()")[1].split("if principal.canPublish()")[0])];
const publishTools = [...readTools, ...geoTools, ...names(registered.split("if principal.canPublish()")[1])];
const documented = (connection, scope) => MCP_TOOL_GROUPS
  .filter((group) => group.connection === connection && (!scope || group.scopes.includes(scope)))
  .flatMap((group) => group.tools);

assert.deepEqual(sorted(documented("documents")), sorted(names(registered)), "文档工具必须与真实 Go 注册集合一致且不重复");
for (const [scope, expected] of Object.entries({ read: readTools, write: writeTools, publish: publishTools })) {
  assert.deepEqual(sorted(documented("documents", scope)), sorted(expected), `${scope} 的公开工具与注册分支不同`);
}
const repositorySource = read("backend/internal/server/mcp_agent_workspace_tools.go");
const repositoryTools = [...repositorySource.matchAll(/newAgentWorkspaceMCPTool\(mcp.Tool\{([\s\S]*?)\}, (true|false),/g)]
  .map((match) => ({ name: names(match[1])[0], write: match[2] === "true" }));
assert.equal(repositoryTools.length, 12, "必须解析真实仓库工具注册");
assert.deepEqual(sorted(documented("repositories", "agent_read")), sorted(repositoryTools.filter((tool) => !tool.write).map((tool) => tool.name)));
assert.deepEqual(sorted(documented("repositories", "agent_write")), sorted(repositoryTools.map((tool) => tool.name)));
const configSyncSource = read("backend/internal/server/config_sync.go").split("func (a *App) configSyncMCPHandler")[1].split("type configSyncInfo")[0];
assert.deepEqual(sorted(documented("configSync")), sorted(names(configSyncSource)));
assert.deepEqual(sorted(MCP_TOOL_GROUPS.filter((group) => group.kind === "external").flatMap((group) => group.tools)),
  ["generate_wechat_geo_summary", "push_wechat_draft", "sync_document_to_feishu"]);
assert.equal(MCP_TOOL_GROUPS.filter((group) => group.kind === "read").some((group) => group.tools.includes("update_wechat_geo_summary")), false);

for (const [locale, copy] of Object.entries(mcpKnowledge)) {
  function assertTranslations(value, path) {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string") assert.ok(item.trim(), `${locale}.${path}.${key} 为空`);
      else assertTranslations(item, `${path}.${key}`);
    }
  }
  assertTranslations(copy, "mcpKnowledge");
  assert.equal(copy.boundaries.length, 7);
  assert.equal(copy.effects.length, 3);
  for (const client of MCP_CLIENTS) {
    assert.ok(copy.clientDescriptions[client.id]);
    assert.ok(copy.clientNotes[client.id]);
  }
  assert.match(copy.limitsSummary, /OAuth/);
  assert.match(copy.limitsSummary, /RAG/);
  assert.match(copy.limitsSummary, /180/);
  assert.match(copy.connections.configSync.description, /30/);
  assert.match(copy.connections.repositories.description, /manage_agent_workspace/);
}
assert.equal(new Set(Object.values(mcpKnowledge).map((copy) => copy.positioning)).size, 4);
assert.equal(mcpKnowledge.zh.positioning, "个人 AI 知识文档库：Markdown 写作与整理，并通过 MCP 让你的 Agent 安全检索、读取和修改文档。");

for (const client of MCP_CLIENTS) {
  for (const block of client.blocks) {
    assert.match(block.code, /https:\/\/koinote\.app\/mcp/);
    assert.match(block.code, /KOINOTE_MCP_TOKEN/);
    assert.doesNotMatch(block.code, /knt_mcp_[A-Za-z0-9]{8,}/, "配置只能保存环境变量引用");
    if (block.label.endsWith(".json")) {
      const config = JSON.parse(block.code);
      if (client.id === "claude-code") {
        assert.equal(config.mcpServers.koinote.type, "http");
        assert.equal(config.mcpServers.koinote.headers.Authorization, "Bearer ${KOINOTE_MCP_TOKEN}");
      } else {
        const server = block.label.includes("V2") ? config.mcp.servers.koinote : config.mcp.koinote;
        assert.equal(server.type, "remote");
        assert.equal(server.oauth, false);
        assert.equal(server.headers.Authorization, "Bearer {env:KOINOTE_MCP_TOKEN}");
      }
    }
  }
}
assert.equal(MCP_TOKEN_SETUP, "export KOINOTE_MCP_TOKEN='knt_mcp_...'");
assert.match(MCP_CLIENTS.find((client) => client.id === "openclaw").blocks[0].code,
  /--header 'Authorization=Bearer \$\{KOINOTE_MCP_TOKEN\}'/);
const codex = MCP_CLIENTS.find((client) => client.id === "codex").blocks[0].code;
assert.match(codex, /\[mcp_servers.koinote\]/);
assert.match(codex, /bearer_token_env_var = "KOINOTE_MCP_TOKEN"/);
// Exercise the documented shell quoting without a real token or external connection.
const shellCode = MCP_CLIENTS.find((client) => client.id === "openclaw").blocks[0].code;
const argumentsPassed = execFileSync("bash", ["-c", `openclaw() { printf '%s\\0' "$@"; }\n${shellCode}`], {
  env: { PATH: process.env.PATH, KOINOTE_MCP_TOKEN: "fake-test-secret" }, encoding: "utf8",
}).split("\0");
assert.ok(argumentsPassed.includes("Authorization=Bearer ${KOINOTE_MCP_TOKEN}"));
assert.ok(!argumentsPassed.some((arg) => arg.includes("fake-test-secret")));
for (const filename of ["README.md", "README.en.md"]) {
  const readme = read(filename);
  for (const client of MCP_CLIENTS) assert.ok(readme.includes(`https://koinote.app${client.path}`));
  for (const block of MCP_CLIENTS.find((client) => client.id === "opencode").blocks) assert.ok(readme.includes(block.code));
}

assert.ok(read("README.md").includes("每次文档 MCP\n请求都会重新检查会员状态"));
assert.ok(read("README.md").includes("不会获得修改文档正文或删除文档的权限"));
assert.ok(read("README.en.md").includes("Every document MCP request rechecks membership"));
console.log("MCP 知识库检查通过：49 个工具、5 种 PAT scope、4 种语言及客户端配置");
