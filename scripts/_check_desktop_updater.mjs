import fs from "node:fs";

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

ok("客户端版本已升级", config.version === "0.1.7");
ok("构建更新产物", config.bundle.createUpdaterArtifacts === true);
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
includes("支持手动检查事件", updater, "DESKTOP_UPDATE_CHECK_EVENT");
includes("下载并安装更新", updater, "availableUpdate.downloadAndInstall");
includes("安装前保存编辑内容", updater, "await prepareDesktopLogout()");
includes("安装后重启", updater, "await relaunch()");
includes("显示下载进度", updater, 'event.event === "Progress"');
includes("桌面外壳懒加载更新器", shell, 'import("./DesktopUpdater")');
includes("账户菜单可检查更新", shell, "requestDesktopUpdateCheck()");
includes("发布流程读取签名私钥", workflow, "TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}");
includes("使用支持 Icon Composer 的 macOS 构建机", workflow, "os: macos-26");
includes("校验 macOS 原生图标产物", workflow, 'test -f "$app/Contents/Resources/Assets.car"');
includes("发布 macOS 更新包", workflow, "*.app.tar.gz");
includes("发布 Windows 更新包", workflow, "updaters=(\"$bundle_dir\"/nsis/*-setup.exe)");
includes("生成静态更新清单", workflow, "> release-artifacts/latest.json");
includes("清单包含 Apple Silicon", workflow, '"darwin-aarch64"');
includes("清单包含 Intel macOS", workflow, '"darwin-x86_64"');
includes("清单包含 Windows x64", workflow, '"windows-x86_64"');

console.log(`\ndesktop updater: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
