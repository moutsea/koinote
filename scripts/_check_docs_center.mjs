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
  /to="\/docs\/mcp"/.test(page) && /to="\/docs\/version-history"/.test(page),
  "详细 MCP 与版本指南仍应保留独立入口",
);
ok(
  "文档中心提供可执行下一步",
  /to="\/editor"/.test(page) &&
    /to="\/documents"/.test(page) &&
    /DESKTOP_DOWNLOAD_URL/.test(page),
  "读完说明后应能直接写作、迁移或下载客户端",
);
ok(
  "顶部菜单包含文档中心",
  /<HeaderDocsMenuItem\s+to="\/docs"/.test(shell),
  "文档索引不能只藏在页脚",
);
ok(
  "页脚包含文档中心",
  /<FooterRoute to="\/docs">\{t\.footer\.docsCenter\}<\/FooterRoute>/.test(footer),
  "公开文档需要稳定的全站入口",
);

console.log(`文档中心：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
