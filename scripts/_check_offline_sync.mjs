import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  acknowledgedLocalRevision,
  decideRemoteDocument,
  decideRemoteFolder,
  isDesktopAuthenticationRejection,
  confirmAction,
  prepareDesktopLogout,
  pulledLocalRevision,
  registerDesktopLogoutPreparation,
  shouldAttachDesktopAuthorization,
  snapshotGuard,
} = await import("./_offline_sync_bundle.mjs");

const originalWindow = globalThis.window;
let confirmationRoute = "";
const adapters = {
  browser() {
    confirmationRoute = "browser";
    return true;
  },
  async desktop() {
    confirmationRoute = "desktop";
    return true;
  },
};
globalThis.window = {};
assert.equal(await confirmAction("delete", adapters), true);
assert.equal(confirmationRoute, "browser");
globalThis.window = { __TAURI_INTERNALS__: {} };
assert.equal(await confirmAction("delete", adapters), true);
assert.equal(confirmationRoute, "desktop", "桌面危险操作必须使用原生确认框");
if (originalWindow === undefined) delete globalThis.window;
else globalThis.window = originalWindow;

let prepared = 0;
const unregisterSuccessfulPreparation = registerDesktopLogoutPreparation(async () => {
  prepared += 1;
  return true;
});
assert.equal(await prepareDesktopLogout(), true);
assert.equal(prepared, 1);
const unregisterFailedPreparation = registerDesktopLogoutPreparation(async () => false);
assert.equal(
  await prepareDesktopLogout(),
  false,
  "任一保存屏障失败都必须中止桌面登出",
);
unregisterSuccessfulPreparation();
unregisterFailedPreparation();
assert.equal(await prepareDesktopLogout(), true, "没有打开编辑器时允许正常登出");

assert.equal(isDesktopAuthenticationRejection(401), true);
assert.equal(isDesktopAuthenticationRejection(403), true);
assert.equal(
  isDesktopAuthenticationRejection(500),
  false,
  "后端临时故障不能让离线客户端丢失缓存身份",
);

const apiOrigin = "https://koinote.app";
assert.equal(shouldAttachDesktopAuthorization("/api/documents", apiOrigin), true);
assert.equal(
  shouldAttachDesktopAuthorization("https://koinote.app/api/documents", apiOrigin),
  true,
);
for (const untrusted of [
  "https://images.example.com/photo.png",
  "//images.example.com/photo.png",
  "https://koinote.app.evil.example/api/documents",
  "data:image/png;base64,AA==",
]) {
  assert.equal(
    shouldAttachDesktopAuthorization(untrusted, apiOrigin),
    false,
    `桌面 Bearer token 不能发送到第三方地址：${untrusted}`,
  );
}

const local = {
  title: "本地标题",
  theme: "paper",
  content: "本地正文",
  folderId: "folder-local",
  localRevision: 8,
  baseRevision: 5,
  syncState: "update",
  changeSeq: 12,
};

assert.equal(acknowledgedLocalRevision(8, 6), 8, "云端确认不能让本地 revision 回退");
assert.equal(acknowledgedLocalRevision(5, 6), 6);
assert.equal(pulledLocalRevision(8, 6), 9, "远端替换必须让已打开编辑器的旧 revision 失效");
assert.equal(pulledLocalRevision(2, 9), 9);

assert.equal(
  decideRemoteDocument(local, {
    title: local.title,
    theme: local.theme,
    content: local.content,
    folderId: local.folderId,
    revision: 6,
  }),
  "acknowledge-local",
  "已被服务器接受但确认响应丢失的内容应收敛为 clean",
);

assert.equal(
  decideRemoteDocument(local, {
    title: "远端标题",
    theme: local.theme,
    content: "远端正文",
    folderId: local.folderId,
    revision: 6,
  }),
  "conflict",
  "本地待同步且远端变化时必须保留双方版本",
);

assert.equal(
  decideRemoteDocument(
    { ...local, syncState: "clean" },
    { ...local, revision: 6 },
  ),
  "replace-clean",
);
assert.equal(
  decideRemoteDocument(
    { ...local, syncState: "conflict" },
    { ...local, revision: 6 },
  ),
  "unchanged",
  "未解决的冲突不能被后续拉取静默覆盖",
);
assert.deepEqual(snapshotGuard(local), [5, "update", 12]);

const cleanFolder = {
  name: "写作",
  parentFolderId: null,
  syncState: "clean",
};
assert.equal(
  decideRemoteFolder(cleanFolder, {
    name: cleanFolder.name,
    parentFolderId: cleanFolder.parentFolderId,
  }),
  "unchanged",
  "完全相同的 clean 文件夹不能被误标成待同步",
);
assert.equal(
  decideRemoteFolder(cleanFolder, { name: "云端改名", parentFolderId: null }),
  "replace-clean",
);
assert.equal(
  decideRemoteFolder(
    { ...cleanFolder, syncState: "update" },
    { name: cleanFolder.name, parentFolderId: cleanFolder.parentFolderId },
  ),
  "acknowledge-local",
);
assert.equal(
  decideRemoteFolder(
    { ...cleanFolder, syncState: "update" },
    { name: "另一端改名", parentFolderId: null },
  ),
  "keep-local",
);

const offlineStore = readFileSync(
  new URL("../spa/src/desktop/offlineStore.ts", import.meta.url),
  "utf8",
);
assert.match(
  offlineStore,
  /DEFAULT_DOCUMENT_THEME\s*=\s*"minimal"/,
  "桌面端新文档默认主题必须与网页端一致",
);
assert.match(
  offlineStore,
  /CASE WHEN \$5 IS NULL THEN theme ELSE \$5 END/,
  "省略主题的离线更新不能把已有主题清空",
);
assert.match(
  offlineStore,
  /snapshotInitializations\s*=\s*new Map<string, Promise<void>>[\s\S]*?ensureInitialSnapshot[\s\S]*?snapshotInitializations\.get\(account\)[\s\S]*?return existing[\s\S]*?snapshotInitializations\.set\(account, initialization\)/,
  "首次快照初始化必须按账号去重，列表刷新不能反复触发同步",
);
assert.match(
  offlineStore,
  /clearDesktopOfflineAccount[\s\S]*?await initialization\.catch[\s\S]*?clearTimeout\(syncTimer\)[\s\S]*?await activeSync\.catch[\s\S]*?DELETE FROM offline_documents[\s\S]*?snapshotInitializations\.delete\(account\)/,
  "登出清库前必须停止并等待后台同步，避免数据被异步写回",
);

for (const file of [
  "../spa/src/documentTransfer.ts",
  "../spa/src/components/editor/exportDocx.ts",
  "../spa/src/components/editor/exportPdf.ts",
]) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  assert.match(
    source,
    /fetchAppResource/,
    `${file} 必须通过桌面网络层读取图片`,
  );
}

const desktopAuth = readFileSync(
  new URL("../spa/src/desktop/auth.ts", import.meta.url),
  "utf8",
);
assert.match(
  desktopAuth,
  /response\.status === 400 \|\| response\.status === 401[\s\S]*?clearDesktopSession\(\)[\s\S]*?return null/,
  "只有明确无效的 refresh token 才能清除桌面会话",
);
assert.match(
  desktopAuth,
  /throw new Error\(`Desktop refresh failed \(\$\{response\.status\}\)`\)/,
  "服务端临时故障必须保留钥匙串会话并进入离线回退",
);

const apiSource = readFileSync(
  new URL("../spa/src/api.ts", import.meta.url),
  "utf8",
);
assert.match(
  apiSource,
  /clearDesktopOfflineAccount[\s\S]*?finally\s*\{[\s\S]*?clearDesktopSession\(\)/,
  "桌面登出即使本地缓存清理失败也必须删除钥匙串令牌",
);

const appShell = readFileSync(
  new URL("../spa/src/components/AppShell.tsx", import.meta.url),
  "utf8",
);
assert.match(
  appShell,
  /prepareDesktopLogout\(\)[\s\S]*?desktopSyncSummary\(\)[\s\S]*?summary\.pending[\s\S]*?summary\.conflicts[\s\S]*?confirmAction[\s\S]*?await logout\(\)/,
  "桌面登出必须先落库编辑中内容，再明确确认待同步修改",
);

const editorPage = readFileSync(
  new URL("../spa/src/pages/EditorPage.tsx", import.meta.url),
  "utf8",
);
assert.match(
  editorPage,
  /registerDesktopLogoutPreparation\(\(\) => saver\.flushAll\(\)\)/,
  "编辑器必须把防抖窗口内的改动接入桌面登出屏障",
);
assert.match(
  editorPage,
  /saverRef\.current\.isDirty[\s\S]*?removeUnavailable\([\s\S]*?saverRef\.current\.drop[\s\S]*?setTabState\(next\)[\s\S]*?navigate/,
  "远端删除必须回收干净标签，同时保护尚未落库的编辑内容",
);

const syncStatus = readFileSync(
  new URL("../spa/src/components/DesktopSyncStatus.tsx", import.meta.url),
  "utf8",
);
assert.match(
  syncStatus,
  /desktopSyncSummary\(\)[\s\S]*?navigator\.onLine[\s\S]*?syncDesktopNow\(\)/,
  "客户端启动后必须自动拉取远端并重试待同步修改",
);

const desktopNetwork = readFileSync(
  new URL("../spa/src/desktop/network.ts", import.meta.url),
  "utf8",
);
assert.match(
  desktopNetwork,
  /shouldAttachDesktopAuthorization\(path, desktopAPIOrigin\(\)\)/,
  "桌面网络层必须只向 Koinote API 源附加 Bearer token",
);
const desktopTransport = readFileSync(
  new URL("../spa/src/desktop/transport.ts", import.meta.url),
  "utf8",
);
assert.match(
  desktopTransport,
  /authenticated[\s\S]*?maxRedirections:\s*0/,
  "带桌面 Bearer token 的请求不能自动跟随重定向",
);

console.log("offline sync reconciliation checks passed");
