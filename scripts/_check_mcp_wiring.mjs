import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;

function ok(label, condition, detail) {
  if (condition) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label}${detail ? ` —— ${detail}` : ""}`);
  }
}

const worker = readFileSync(
  new URL("../worker/index.ts", import.meta.url),
  "utf8",
);
const vite = readFileSync(
  new URL("../vite.config.ts", import.meta.url),
  "utf8",
);
const aiSettings = readFileSync(
  new URL("../spa/src/pages/AISettingsPage.tsx", import.meta.url),
  "utf8",
);
const accessCard = readFileSync(
  new URL("../spa/src/components/MCPAccessCard.tsx", import.meta.url),
  "utf8",
);
const membershipCard = readFileSync(
  new URL("../spa/src/components/MembershipCard.tsx", import.meta.url),
  "utf8",
);
const server = readFileSync(
  new URL("../backend/internal/server/server.go", import.meta.url),
  "utf8",
);
const mcp = readFileSync(
  new URL("../backend/internal/server/mcp.go", import.meta.url),
  "utf8",
);
const main = readFileSync(
  new URL("../spa/src/main.tsx", import.meta.url),
  "utf8",
);
const guide = readFileSync(
  new URL("../spa/src/pages/MCPGuidePage.tsx", import.meta.url),
  "utf8",
);
const versionGuide = readFileSync(
  new URL("../spa/src/pages/VersionHistoryGuidePage.tsx", import.meta.url),
  "utf8",
);
const shell = readFileSync(
  new URL("../spa/src/components/AppShell.tsx", import.meta.url),
  "utf8",
);
const activityPage = readFileSync(
  new URL("../spa/src/pages/MCPActivityPage.tsx", import.meta.url),
  "utf8",
);
const historyDialog = readFileSync(
  new URL("../spa/src/components/editor/VersionHistoryDialog.tsx", import.meta.url),
  "utf8",
);

ok(
  "Worker 只精确代理 MCP 根端点",
  /url\.pathname\s*===\s*["']\/mcp["']/.test(worker) &&
    !/url\.pathname\.startsWith\(["']\/mcp/.test(worker),
  "不能让 /mcp-anything 意外绕过静态资源路由",
);
ok(
  "本地开发与 preview 都代理 MCP",
  (vite.match(/["']\/mcp["']:\s*backendProxy/g) ?? []).length === 2,
  "开发和生产预览必须与 Worker 使用同一条后端路径",
);
ok(
  "AI 设置页挂载 MCP 令牌入口",
  /<MCPAccessCard\s+user=\{user\}/.test(aiSettings),
  "会员需要能生成和撤销个人访问令牌",
);
ok(
  "免费用户不展示令牌管理表单",
  /const active\s*=\s*user\.membershipTier\s*===\s*["']lifetime["']/.test(
    accessCard,
  ) && /\{!active\s*\?/.test(accessCard),
  "前端提示不是安全边界，但不能误导免费用户",
);
ok(
  "会员与 MCP 卡片使用统一墨色且不使用渐变",
  !/gradient|linear-gradient|(?:sky|amber|emerald|red|cinnabar)-(?:[0-9]|\[)/.test(
    `${membershipCard}\n${accessCard}`,
  ),
  "账户页的两张功能卡不应混用强调色或渐变色",
);
ok(
  "Codex 配置从环境变量读取 bearer token",
  /bearer_token_env_var\s*=\s*["']KOINOTE_MCP_TOKEN["']/.test(accessCard),
  "令牌不应直接写进持久配置文件",
);
ok(
  "OpenCode 使用远程 MCP 且令牌来自环境变量",
  /title="OpenCode"/.test(accessCard) &&
    /["']type["']:\s*["']remote["']/.test(accessCard) &&
    /Bearer \{env:KOINOTE_MCP_TOKEN\}/.test(accessCard) &&
    /["']oauth["']:\s*false/.test(accessCard),
  "远程 PAT 鉴权应关闭 OAuth 自动探测，且不能把令牌写进 opencode.json",
);
ok(
  "OpenClaw 使用 Streamable HTTP 与环境变量令牌",
  /title="OpenClaw"/.test(accessCard) &&
    /openclaw mcp add koinote/.test(accessCard) &&
    /--transport streamable-http/.test(accessCard) &&
    /Authorization=Bearer \\?\$\{KOINOTE_MCP_TOKEN\}/.test(accessCard) &&
    /openclaw mcp doctor koinote --probe/.test(accessCard),
  "OpenClaw 配置应能直接添加并探测 Koinote MCP",
);
ok(
  "其他标准 MCP 客户端有通用连接参数",
  /title="Other MCP clients"/.test(accessCard) &&
    /Transport: Streamable HTTP/.test(accessCard) &&
    /Header: Authorization: Bearer/.test(accessCard),
  "支持自定义远程端点和 Bearer Header 的客户端不应需要专用适配",
);
ok(
  "后端与账户页都接入按需查看令牌",
  /POST \/api\/mcp\/tokens\/\{tokenId\}\/reveal/.test(server) &&
    /revealMCPToken/.test(accessCard) &&
    /token\.revealable/.test(accessCard),
  "列表不返回完整令牌，用户点击后才从所属账号的专用接口解密",
);
ok(
  "令牌支持永久有效与创建后修改有效期",
  /PATCH \/api\/mcp\/tokens\/\{tokenId\}/.test(server) &&
    /updateMCPTokenExpiry/.test(accessCard) &&
    /neverExpires/.test(accessCard) &&
    /editExpiry/.test(accessCard),
  "永久令牌应使用显式字段，已创建令牌应能重新选择有效期",
);
ok(
  "MCP 只提供可恢复删除",
  /Name:\s*["']trash_document["']/.test(mcp) &&
    /Name:\s*["']restore_trashed_document["']/.test(mcp) &&
    /Name:\s*["']list_trashed_documents["']/.test(mcp) &&
    !/Name:\s*["'](?:delete_document|permanently_delete_document)["']/.test(
      mcp,
    ),
  "Agent 可以移入或恢复 30 天回收站，但不能绕过网页二次确认永久删除",
);
ok(
  "MCP 可以读取和修改历史版本策略",
  /Name:\s*["']get_document_history_settings["']/.test(mcp) &&
    /Name:\s*["']update_document_history_settings["']/.test(mcp),
  "Agent 需要和网页使用同一套历史版本设置",
);
ok(
  "会员可以查看 MCP 活动日志",
  /GET \/api\/mcp\/activity/.test(server) &&
    /to="\/mcp\/activity"/.test(accessCard) &&
    /listMCPActivity/.test(activityPage) &&
    /entry\.documentTitle/.test(activityPage),
  "审计表已有数据，用户界面必须能分页查看工具、令牌和文档关联",
);
ok(
  "版本历史支持比较当前或其他历史版本",
  /buildVersionDiff/.test(historyDialog) &&
    /historyCompareWith/.test(historyDialog) &&
    /historyCurrent/.test(historyDialog),
  "历史窗口不能只提供整篇预览和恢复",
);
ok(
  "公开 MCP 指南覆盖客户端配置且链接独立版本文档",
  /path:\s*["']\/docs\/mcp["']/.test(main) &&
    /name: ["']OpenClaw["']/.test(guide) &&
    /name: ["']WorkBuddy \/ Other clients["']/.test(guide) &&
    /to=["']\/docs\/version-history["']/.test(guide) &&
    !/t\.mcpGuide\.historyFeatures/.test(guide),
  "MCP 接入方式与版本控制不应继续混在同一篇文档里",
);
ok(
  "独立版本控制指南覆盖保留、冲突与恢复",
  /path:\s*["']\/docs\/version-history["']/.test(main) &&
    /t\.versionGuide\.features/.test(versionGuide) &&
    /t\.versionGuide\.webSteps/.test(versionGuide) &&
    /t\.versionGuide\.mcpRules/.test(versionGuide) &&
    /hash=["']history-settings["']/.test(versionGuide),
  "版本策略和恢复方式需要有可直接访问的独立文档",
);
ok(
  "顶部文档菜单可进入两篇指南",
  /<HeaderDocsMenu/.test(shell) &&
    /to=["']\/docs\/mcp["']/.test(shell) &&
    /to=["']\/docs\/version-history["']/.test(shell),
  "公开文档不应只藏在首页或页脚",
);

console.log(`MCP 接线：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
