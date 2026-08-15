import fs from "node:fs";

let pass = 0;
let fail = 0;

function includes(label, source, fragment) {
  if (source.includes(fragment)) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label} —— 缺少 ${JSON.stringify(fragment)}`);
  }
}

function excludes(label, source, fragment) {
  if (!source.includes(fragment)) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label} —— 不应包含 ${JSON.stringify(fragment)}`);
  }
}

const main = fs.readFileSync("spa/src/main.tsx", "utf8");
const shell = fs.readFileSync("spa/src/components/AppShell.tsx", "utf8");
const home = fs.readFileSync("spa/src/pages/DesktopHomePage.tsx", "utf8");
const sync = fs.readFileSync("spa/src/components/DesktopSyncStatus.tsx", "utf8");

includes("桌面运行时使用独立首页", main, 'import("./pages/DesktopHomePage")');
includes("网页仍使用营销首页", main, ": HomePage;");
includes("桌面未登录显示授权页", home, "if (!user) return <DesktopLoginPage />;");
includes("桌面首页读取本地文档", home, "useDocumentList(Boolean(user))");
includes("桌面首页支持新建文档", home, "useCreateDocument()");
includes("桌面首页可直接导入 Markdown", home, "importDocumentsFromFiles(files)");
includes("桌面首页提供继续编辑", home, "continueDocument.docId");
includes("桌面首页显示最近文档", home, "recentDocuments.map");
includes("桌面首页显示同步面板", home, '<DesktopSyncStatus variant="panel" />');
includes("同步组件支持面板形态", sync, 'variant?: "header" | "panel"');
includes("桌面导航提供文档入口", shell, '<HeaderLink to="/documents"');
includes("桌面端隐藏营销导航", shell, "{desktopRuntime ? (");
includes("工作台不重复挂载同步状态", shell, 'desktopRuntime && pathname !== "/"');
includes("桌面端隐藏官网页脚", shell, "{!desktopRuntime && hasFooter(pathname) && <AppFooter />}");
excludes("客户端首页不再宣传下载客户端", home, "DESKTOP_DOWNLOAD_URL");
excludes("客户端首页不再渲染营销功能卡", home, "FEATURE_ICONS");

console.log(`\ndesktop home: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
