import fs from "node:fs";

const {
  DESKTOP_UPDATE_CHECK_INTERVAL_MS,
  DESKTOP_UPDATE_RETRY_INTERVAL_MS,
  desktopUpdateCheckDue,
  nextDesktopUpdateCheckAt,
} = await import("./_desktop_updater_schedule_bundle.mjs");

let passed = 0;
let failed = 0;

function ok(label, condition) {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL  ${label}`);
  }
}

function includes(label, source, fragment) {
  ok(label, source.includes(fragment));
}

const config = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
const capability = JSON.parse(fs.readFileSync("src-tauri/capabilities/default.json", "utf8"));
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const cargo = fs.readFileSync("src-tauri/Cargo.toml", "utf8");
const rust = fs.readFileSync("src-tauri/src/lib.rs", "utf8");
const updater = fs.readFileSync("spa/src/components/DesktopUpdater.tsx", "utf8");
const shell = fs.readFileSync("spa/src/components/AppShell.tsx", "utf8");
const workflow = fs.readFileSync(".github/workflows/release-desktop.yml", "utf8");
const composerIcon = JSON.parse(fs.readFileSync("src-tauri/icons/AppIcon.icon/icon.json", "utf8"));
const decodedPublicKey = Buffer.from(config.plugins.updater.pubkey, "base64")
  .toString("utf8")
  .trim()
  .split(/\r?\n/);

ok("客户端版本已升级", config.version === "0.1.23");
ok("构建更新产物", config.bundle.createUpdaterArtifacts === true);
ok(
  "桌面端允许受控后台压缩 Worker",
  config.app.security.csp.includes("worker-src 'self' blob:"),
);
ok("配置 macOS 26 原生图标", config.bundle.icon.includes("icons/AppIcon.icon"));
ok("原生图标使用深色底", composerIcon.fill?.solid === "srgb:0.12157,0.13725,0.15686,1.00000");
ok("原生图标包含水墨前景", composerIcon.groups?.[0]?.layers?.[0]?.["image-name"] === "mark.png" && fs.existsSync("src-tauri/icons/AppIcon.icon/Assets/mark.png"));
ok("配置 GitHub 更新清单", config.plugins.updater.endpoints.includes("https://github.com/moutsea/koinote/releases/latest/download/latest.json"));
ok(
  "配置完整 Minisign 更新公钥",
  decodedPublicKey.length === 2
    && decodedPublicKey[0].startsWith("untrusted comment: minisign public key:")
    && decodedPublicKey[1].length === 56
    && /^[A-Za-z0-9+/]+={0,2}$/.test(decodedPublicKey[1]),
);
ok("授权完整更新流程", capability.permissions.includes("updater:default"));
ok("只授权进程重启", capability.permissions.includes("process:allow-restart") && !capability.permissions.includes("process:default"));
ok("安装前端 updater 插件", Boolean(pkg.dependencies["@tauri-apps/plugin-updater"]));
ok("安装前端 process 插件", Boolean(pkg.dependencies["@tauri-apps/plugin-process"]));
includes("安装 Rust updater 插件", cargo, 'tauri-plugin-updater = "2.10.1"');
includes("安装 Rust process 插件", cargo, 'tauri-plugin-process = "2.3.1"');
includes("注册 updater 插件", rust, "tauri_plugin_updater::Builder::new().build()");
includes("注册 process 插件", rust, "tauri_plugin_process::init()");
includes("启动后自动检查", updater, "window.setTimeout(() => void runCheck(false), 2_000)");
ok("定时检查间隔为六小时", DESKTOP_UPDATE_CHECK_INTERVAL_MS === 6 * 60 * 60 * 1_000);
ok("失败后半小时重试", DESKTOP_UPDATE_RETRY_INTERVAL_MS === 30 * 60 * 1_000);
ok("未安排检查时立即执行", desktopUpdateCheckDue(null, 1_000));
ok("未到检查时间不执行", !desktopUpdateCheckDue(2_000, 1_999));
ok("到达检查时间立即执行", desktopUpdateCheckDue(2_000, 2_000));
ok(
  "成功与失败使用不同的下次检查时间",
  nextDesktopUpdateCheckAt(1_000, true) === 1_000 + DESKTOP_UPDATE_CHECK_INTERVAL_MS
    && nextDesktopUpdateCheckAt(1_000, false) === 1_000 + DESKTOP_UPDATE_RETRY_INTERVAL_MS,
);
includes("定时唤醒更新检查", updater, "window.setInterval(checkIfDue, DESKTOP_UPDATE_TIMER_TICK_MS)");
includes("窗口聚焦时补检", updater, 'window.addEventListener("focus", checkIfDue)');
includes("恢复联网时补检", updater, 'window.addEventListener("online", handleOnline)');
includes("回到前台时补检", updater, 'document.addEventListener("visibilitychange", handleVisibilityChange)');
includes("更新弹窗打开时避免重复请求", updater, "(!interactive && availableUpdateRef.current)");
includes("支持手动检查事件", updater, "DESKTOP_UPDATE_CHECK_EVENT");
includes("下载并安装更新", updater, "availableUpdate.downloadAndInstall");
includes("安装前保存编辑内容", updater, "await prepareDesktopLogout()");
includes("安装后重启", updater, "await relaunch()");
includes("显示下载进度", updater, 'event.event === "Progress"');
includes("桌面外壳懒加载更新器", shell, 'import("./DesktopUpdater")');
includes("账户菜单可检查更新", shell, "requestDesktopUpdateCheck()");
includes("发布流程读取签名私钥", workflow, "TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}");
includes("使用支持 Icon Composer 的 macOS 构建机", workflow, "os: macos-26");
includes("绕过 Tauri actool 临时目录缺陷", workflow, "预编译 macOS 原生图标");
includes("预编译 Assets.car", workflow, "actool src-tauri/icons/AppIcon.icon");
includes("打包预编译图标", workflow, '"icons/Assets.car"');
includes("校验 macOS 原生图标产物", workflow, 'test -f "$app/Contents/Resources/Assets.car"');
includes("发布 macOS 更新包", workflow, "*.app.tar.gz");
includes("发布 Windows 更新包", workflow, "updaters=(\"$bundle_dir\"/nsis/*-setup.exe)");
includes("生成静态更新清单", workflow, "> release-artifacts/latest.json");
includes("清单包含 Apple Silicon", workflow, '"darwin-aarch64"');
includes("清单包含 Intel macOS", workflow, '"darwin-x86_64"');
includes("清单包含 Windows x64", workflow, '"windows-x86_64"');

console.log(`\ndesktop updater: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
