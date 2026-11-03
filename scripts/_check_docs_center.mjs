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

const main = readFileSync(new URL("../spa/src/main.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../spa/src/pages/DocsPage.tsx", import.meta.url), "utf8");
const aiGuide = readFileSync(new URL("../spa/src/pages/AIOptimizationGuidePage.tsx", import.meta.url), "utf8");
const aiCase = readFileSync(new URL("../spa/src/pages/AIOptimizationCasePage.tsx", import.meta.url), "utf8");
// 原文放在独立模块里，案例页和 Worker 边缘渲染共用
const aiCaseArchive = readFileSync(new URL("../spa/src/aiOptimizationCase.ts", import.meta.url), "utf8");
const mcpGuide = readFileSync(new URL("../spa/src/pages/MCPGuidePage.tsx", import.meta.url), "utf8");
const versionGuide = readFileSync(new URL("../spa/src/pages/VersionHistoryGuidePage.tsx", import.meta.url), "utf8");
const shell = readFileSync(new URL("../spa/src/components/AppShell.tsx", import.meta.url), "utf8");
const footer = readFileSync(new URL("../spa/src/components/AppFooter.tsx", import.meta.url), "utf8");

ok(
  "文档中心有独立公开路由",
  /path:\s*["']\/docs["']/.test(main) && /import\(["'].\/pages\/DocsPage["']\)/.test(main),
  "顶部文档入口需要一个可直接分享的索引页",
);
ok(
  "文档中心覆盖完整产品工作流",
  /t\.docsCenter\.quickStartSteps/.test(page) &&
    /t\.docsCenter\.workflows/.test(page) &&
    /t\.docsCenter\.modes/.test(page),
  "不能继续只列 MCP 和版本控制",
);
ok(
  "本地与离线模式有独立说明",
  /MODE_ICONS\s*=\s*\[WifiOff, CloudOff, FolderInput\]/.test(page) &&
    /t\.docsCenter\.modesSubtitle/.test(page),
  "两种模式的数据归属不同，文档必须明确区分",
);
ok(
  "专项指南从文档中心可达",
  /to="\/docs\/ai-optimization"/.test(page) &&
    /to="\/docs\/mcp"/.test(page) &&
    /to="\/docs\/version-history"/.test(page),
  "AI 优化、MCP 与版本指南都应保留独立入口",
);
ok(
  "AI 优化有独立公开指南",
  /path:\s*["']\/docs\/ai-optimization["']/.test(main) &&
    /import\(["'].\/pages\/AIOptimizationGuidePage["']\)/.test(main),
  "指南需要可直接分享的公开路由",
);
ok(
  "AI 案例原文有独立只读归档",
  /path:\s*["']\/docs\/ai-optimization\/case["']/.test(main) &&
    /import\(["'].\/pages\/AIOptimizationCasePage["']\)/.test(main) &&
    /editable:\s*false/.test(aiCase) &&
    /import \{ CASE_ORIGINAL_MARKDOWN \} from "\.\.\/aiOptimizationCase"/.test(aiCase) &&
    /export const CASE_ORIGINAL_MARKDOWN/.test(aiCaseArchive) &&
    /https:\/\/koinote\.app\/images\/cases\/ai-optimization\//.test(aiCaseArchive) &&
    !/google_104742467398561921274/.test(aiCase + aiCaseArchive),
  "公开指南不能链接本地私有文档，应提供稳定且能显示原图的审阅前归档",
);
ok(
  "Koi AI 指南展示文章操作步骤及常见问题",
  /guide\.checks\.map/.test(aiGuide) &&
    /guide\.faqs\.map/.test(aiGuide) &&
    /<details/.test(aiGuide) && /<summary/.test(aiGuide),
  "文章专属助手指南应包含操作步骤和可展开的问题",
);
ok(
  "边界与恢复说明统一收进 FAQ",
  /guide\.faqs/.test(aiGuide) &&
    !/guide\.safetyTitle/.test(aiGuide) &&
    !/guide\.historyTitle/.test(aiGuide),
  "指南不应在真实案例后重复展示独立的边界与版本恢复模块",
);
ok(
  "Koi AI 指南保留会员与 credits 入口",
  /to="\/pricing"/.test(aiGuide) &&
    !/to="\/editor"/.test(aiGuide) &&
    !/to="\/ai-settings"/.test(aiGuide),
  "应链接会员方案，不展示旧版模型设置入口",
);
ok(
  "文档中心提供可执行下一步",
  /to="\/editor"/.test(page) &&
    /to="\/documents"/.test(page) &&
    /DESKTOP_DOWNLOAD_URL/.test(page),
  "读完说明后应能直接写作、迁移或下载客户端",
);
ok(
  "非 AI 文档页把操作入口放在正文之前",
  page.indexOf("t.docsCenter.openEditor") < page.indexOf("t.docsCenter.quickStartTitle") &&
    mcpGuide.indexOf("t.mcpGuide.tokensCta") < mcpGuide.indexOf("t.mcpGuide.overviewTitle") &&
    versionGuide.indexOf("t.versionGuide.settingsCta") < versionGuide.indexOf("t.versionGuide.overviewTitle"),
  "文档中心、MCP 和版本历史的主要按钮应紧跟标题简介，不应压在全文末尾",
);
ok(
  "顶部菜单包含文档中心与 AI 指南",
  /<HeaderDocsMenuItem\s+to="\/docs"/.test(shell) &&
    /<HeaderDocsMenuItem\s+to="\/docs\/ai-optimization"/.test(shell),
  "文档索引和 AI 指南不能只藏在页脚",
);
ok(
  "顶部菜单的微信公众号入口指向配置教程",
  /<HeaderDocsMenuItem\s+to="\/docs\/wechat-official-account"/.test(shell) &&
    !/<HeaderDocsMenuItem\s+to="\/settings"[\s\S]*?wechatLabel/.test(shell),
  "微信公众号入口应先帮助用户完成草稿箱同步配置",
);
ok(
  "页脚包含文档中心与 AI 指南",
  /<FooterRoute to="\/docs">\{t\.footer\.docsCenter\}<\/FooterRoute>/.test(footer) &&
    /<FooterRoute to="\/docs\/ai-optimization">/.test(footer),
  "公开文档和 AI 指南都需要稳定的全站入口",
);

console.log(`文档中心：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
