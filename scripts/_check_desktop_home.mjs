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

function matches(label, source, pattern) {
  if (pattern.test(source)) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label} —— 未匹配 ${pattern}`);
  }
}

const main = fs.readFileSync("spa/src/main.tsx", "utf8");
const shell = fs.readFileSync("spa/src/components/AppShell.tsx", "utf8");
const home = fs.readFileSync("spa/src/pages/DesktopHomePage.tsx", "utf8");
const desktopAuthorize = fs.readFileSync("spa/src/pages/DesktopAuthorizePage.tsx", "utf8");
const sync = fs.readFileSync("spa/src/components/DesktopSyncStatus.tsx", "utf8");
const mcp = fs.readFileSync("spa/src/components/MCPAccessCard.tsx", "utf8");
const desktopRuntime = fs.readFileSync("spa/src/desktop/runtime.ts", "utf8");
const externalNavigation = fs.readFileSync("spa/src/externalNavigation.ts", "utf8");
const webLinksCore = fs.readFileSync("spa/src/webLinksCore.ts", "utf8");
const pricing = fs.readFileSync("spa/src/pages/PricingPage.tsx", "utf8");
const settings = fs.readFileSync("spa/src/pages/SettingsPage.tsx", "utf8");
const trash = fs.readFileSync("spa/src/pages/TrashPage.tsx", "utf8");
const packageJSON = fs.readFileSync("package.json", "utf8");
const tauriConfig = fs.readFileSync("src-tauri/tauri.conf.json", "utf8");
const tauriLocalConfig = fs.readFileSync("src-tauri/tauri.local.conf.json", "utf8");
const desktopFrontendRunner = fs.readFileSync("scripts/desktop_frontend_runner.mjs", "utf8");
const desktopRunner = fs.readFileSync("scripts/desktop_runner.mjs", "utf8");
const tauriBuild = fs.readFileSync("src-tauri/build.rs", "utf8");

includes("桌面运行时使用独立首页", main, 'import("./pages/DesktopHomePage")');
includes("网页仍使用营销首页", main, ": HomePage;");
includes("桌面未登录显示授权页", home, "if (!user) return <DesktopLoginPage />;");
includes("桌面首页读取本地文档", home, "useDocumentList(Boolean(user))");
includes("桌面首页支持新建文档", home, "useCreateDocument()");
includes("桌面首页可直接导入 Markdown", home, "importDocumentsFromFiles(files)");
includes("桌面导入显示具体错误", home, "getImportErrorMessage");
includes("桌面导入提示会自动消失", home, "setImportNotice(null), 5_000");
includes("桌面导入选择器限制格式", home, "accept={IMPORT_FILE_ACCEPT}");
includes("桌面首页提供继续编辑", home, "continueDocument.docId");
includes("桌面首页显示最近文档", home, "recentDocuments.map");
includes("桌面首页显示同步面板", home, '<DesktopSyncStatus variant="panel" />');
includes("桌面首页显示图片缓存用量", home, "desktopImageCacheSummary");
includes("桌面首页区分自动缓存与待上传图片", home, "pendingLocalBytes");
includes("桌面首页显示远端图片缓存上限", home, "remoteCacheLimitBytes");
includes("图片维护失败与文档同步状态分开提示", home, "imageCache.maintenanceIssue");
includes("桌面首页允许清空远端图片缓存", home, "desktopClearRemoteImageCache");
includes("桌面图片缓存清理失败会显示反馈", home, "setImageCacheNotice(t.desktopSync.error)");
includes("同步组件支持面板形态", sync, 'variant?: "header" | "panel"');
matches(
  "桌面导航提供文档指南与价格入口",
  shell,
  /desktopRuntime \? \(\s*<>\s*<HeaderDocsMenu[\s\S]*?<HeaderLink to="\/pricing"/,
);
includes("桌面端隐藏营销导航", shell, "desktopRuntime && localMode ? null : desktopRuntime ? (");
includes("工作台不重复挂载同步状态", shell, 'desktopRuntime && !localMode && pathname !== "/"');
includes("桌面端隐藏官网页脚", shell, "{!desktopRuntime && hasFooter(pathname) && <AppFooter />}");
includes("桌面 MCP 配置使用线上端点", mcp, '`${desktopAPIOrigin()}/mcp`');
includes("授权页允许本地客户端", desktopAuthorize, 'clientId !== "koinote-desktop-local"');
includes("桌面 API 地址按 flavor 切换", desktopRuntime, "VITE_DESKTOP_FLAVOR");
matches(
  "桌面 API 地址固定且按 flavor 切换",
  desktopRuntime,
  /desktopFlavor\(\) === "local" \? "http:\/\/localhost:5273" : "https:\/\/koinote\.app"/,
);
excludes("桌面 API 地址不依赖 Vite DEV 标志", desktopRuntime, "import.meta.env.DEV");
includes("Checkout 拒绝非 HTTPS 地址", externalNavigation, 'url.protocol !== "https:"');
includes("桌面外链使用系统浏览器", externalNavigation, 'import("@tauri-apps/plugin-opener")');
includes("站内网页跳转复用安全链接生成器", externalNavigation, "localWebURL(origin, path)");
includes("站内网页跳转拒绝反斜杠", webLinksCore, 'path.includes("\\\\")');
includes("价格页复用安全 Checkout 导航", pricing, "openMembershipCheckout(result.url)");
includes("桌面账户安全操作转到网页", settings, 'openKoinoteWebPath("/settings?section=general#security")');
matches(
  "桌面永久删除只需一次确认且自动提交服务端校验文字",
  trash,
  /confirmAction\([\s\S]*?const confirmation = desktopRuntime\s*\? expected\s*:\s*window\.prompt/,
);
excludes("桌面永久删除不再跳转网页", trash, 'openKoinoteWebPath("/trash")');
excludes("客户端首页不再宣传下载客户端", home, "DESKTOP_DOWNLOAD_URL");
excludes("客户端首页不再渲染营销功能卡", home, "FEATURE_ICONS");
includes("桌面开发默认使用本地 flavor", packageJSON, '"desktop:dev": "node scripts/desktop_runner.mjs dev local"');
includes("正式桌面开发使用显式 production flavor", packageJSON, '"desktop:dev:production": "node scripts/desktop_runner.mjs dev production"');
includes("正式 Tauri 配置固定 production 前端 flavor", tauriConfig, "desktop_frontend_runner.mjs build production");
includes("本地 Tauri 配置固定 local 前端 flavor", tauriLocalConfig, "desktop_frontend_runner.mjs build local");
includes("前端 flavor runner 设置 Vite flavor", desktopFrontendRunner, "VITE_DESKTOP_FLAVOR: flavor");
includes("桌面构建 runner 透传 Tauri 参数", desktopRunner, "const [command, flavor, ...extraArgs]");
includes("桌面构建 runner 保留额外参数", desktopRunner, "args.push(...extraArgs)");
includes("Windows 桌面 runner 可执行 cmd shim", desktopRunner, 'shell: process.platform === "win32"');
includes("Rust 构建检查 flavor 与 Tauri 配置一致", tauriBuild, "desktop flavor mismatch");

console.log(`\ndesktop home: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
