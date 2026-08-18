import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `源码中缺少起始标记：${startMarker}`);
  assert.notEqual(end, -1, `源码中缺少结束标记：${endMarker}`);
  return source.slice(start, end);
}

const {
  acknowledgedLocalRevision,
  DESKTOP_IMAGE_MAPPING_META,
  DESKTOP_IMAGE_UPLOAD_FAILED_EVENT,
  DESKTOP_IMAGE_UPLOADED_EVENT,
  desktopLocalImageID,
  desktopLocalImageURL,
  decideRemoteDocumentUpdate,
  decideRemoteDocument,
  decideRemoteFolder,
  isDesktopAuthenticationRejection,
  isDesktopLocalImageURL,
  imageObjectKeyFromSource,
  localWebURL,
  confirmAction,
  createAsyncSerialQueue,
  desktopMaintenanceBackoff,
  prepareDesktopLogout,
  prepareDesktopSync,
  pulledLocalRevision,
  replaceDesktopLocalImageURLs,
  registerDesktopLogoutPreparation,
  registerDesktopSyncPreparation,
  REMOTE_UPDATE_INTERVAL_MS,
  runDesktopSyncSequence,
  shouldAttachDesktopAuthorization,
  snapshotGuard,
} = await import("./_offline_sync_bundle.mjs");

const localImageID = "550e8400-e29b-41d4-a716-446655440000";
const localImageURL = desktopLocalImageURL(localImageID);
assert.equal(localImageURL, `koinote-local-image://${localImageID}`);
assert.equal(desktopLocalImageID(localImageURL), localImageID);
assert.equal(isDesktopLocalImageURL(localImageURL), true);
assert.equal(desktopLocalImageID("koinote-local-image://not-a-uuid"), null);
assert.throws(() => desktopLocalImageURL("../escape"), /invalid_local_image_id/);
assert.equal(
  imageObjectKeyFromSource(
    "https://img.koinote.app/u/google_123/abcdef1234567890.png?cache=1",
  ),
  "u/google_123/abcdef1234567890.png",
);
assert.equal(
  imageObjectKeyFromSource("https://example.com/photo.png"),
  null,
);
assert.equal(
  imageObjectKeyFromSource("https://evil.example/u/google_123/abcdef1234567890.png"),
  null,
);
assert.equal(
  replaceDesktopLocalImageURLs(
    `![](${localImageURL})\n${localImageURL}`,
    new Map([[localImageURL, "https://img.koinote.app/u/me/abcdef1234567890.png"]]),
  ),
  "![](https://img.koinote.app/u/me/abcdef1234567890.png)\nhttps://img.koinote.app/u/me/abcdef1234567890.png",
);
assert.equal(DESKTOP_IMAGE_UPLOADED_EVENT, "koinote:desktop-image-uploaded");
assert.equal(DESKTOP_IMAGE_UPLOAD_FAILED_EVENT, "koinote:desktop-image-upload-failed");
assert.equal(DESKTOP_IMAGE_MAPPING_META, "koinote:desktop-image-mapping");
assert.equal(
  localWebURL("https://koinote.app", "/register?invite=ABC234"),
  "https://koinote.app/register?invite=ABC234",
);
assert.equal(
  localWebURL("https://koinote.app", "/share/token"),
  "https://koinote.app/share/token",
);
assert.throws(() => localWebURL("tauri://localhost", "/register"), /HTTP or HTTPS/);
assert.throws(() => localWebURL("https://koinote.app", "//evil.example"), /absolute local path/);
assert.throws(() => localWebURL("https://koinote.app", "/\\evil.example"), /absolute local path/);

const documentQueue = createAsyncSerialQueue();
const imageCacheQueue = createAsyncSerialQueue();
const nestedQueueResult = await Promise.race([
  documentQueue(async () => {
    await imageCacheQueue(async () => "cached");
    return "resolved";
  }),
  new Promise((resolve) => setTimeout(() => resolve("timeout"), 100)),
]);
assert.equal(
  nestedQueueResult,
  "resolved",
  "文档冲突处理与图片缓存必须使用独立队列，不能嵌套自锁",
);

const reentrantQueue = createAsyncSerialQueue();
const reentrantEvents = [];
let releaseOuter;
let markOuterStarted;
const outerStarted = new Promise((resolve) => {
  markOuterStarted = resolve;
});
const outerGate = new Promise((resolve) => {
  releaseOuter = resolve;
});
const outerOperation = reentrantQueue(async (scope) => {
  reentrantEvents.push("outer-start");
  markOuterStarted();
  await Promise.resolve();
  await scope.runNested(async () => {
    reentrantEvents.push("nested");
  });
  await outerGate;
  reentrantEvents.push("outer-end");
});
await outerStarted;
const queuedOperation = reentrantQueue(async () => {
  reentrantEvents.push("queued");
});
await Promise.resolve();
assert.deepEqual(
  reentrantEvents,
  ["outer-start", "nested"],
  "无作用域的并发操作必须继续排队，不能借重入机制绕过串行保证",
);
releaseOuter();
await Promise.all([outerOperation, queuedOperation]);
assert.deepEqual(reentrantEvents, ["outer-start", "nested", "outer-end", "queued"]);
await assert.rejects(
  reentrantQueue((scope) =>
    scope.runNested(async () => {
      throw new Error("nested_failed");
    }),
  ),
  /nested_failed/,
);
assert.equal(
  await reentrantQueue(async () => "recovered"),
  "recovered",
  "嵌套操作失败后队列必须继续服务后续操作",
);

const syncSequenceEvents = [];
let reportedMaintenanceError = null;
const successfulSync = await runDesktopSyncSequence({
  async pushFolders() {
    syncSequenceEvents.push("push-folders");
  },
  async pushDocuments() {
    syncSequenceEvents.push("push-documents");
    return [];
  },
  async pullRemoteSnapshot() {
    syncSequenceEvents.push("pull-remote");
  },
  async maintain() {
    syncSequenceEvents.push("maintain");
    throw new Error("cleanup_failed");
  },
  async recordSuccess() {
    syncSequenceEvents.push("record-success");
  },
  reportMaintenanceFailure(error) {
    reportedMaintenanceError = error;
  },
});
assert.deepEqual(syncSequenceEvents, [
  "push-folders",
  "push-documents",
  "pull-remote",
  "maintain",
  "record-success",
]);
assert.deepEqual(successfulSync, { state: "idle" });
assert.match(String(reportedMaintenanceError), /cleanup_failed/);

let recordedFailedSync = false;
await assert.rejects(
  runDesktopSyncSequence({
    async pushFolders() {},
    async pushDocuments() { return []; },
    async pullRemoteSnapshot() { throw new Error("pull_failed"); },
    async maintain() {},
    async recordSuccess() { recordedFailedSync = true; },
  }),
  /pull_failed/,
);
assert.equal(recordedFailedSync, false, "权威拉取失败时不能记录同步成功");
assert.equal(desktopMaintenanceBackoff(1), 30_000);
assert.equal(desktopMaintenanceBackoff(2), 60_000);
assert.equal(desktopMaintenanceBackoff(100), 30 * 60_000);
assert.equal(desktopMaintenanceBackoff(Number.NaN), 30_000);
assert.deepEqual(
  await runDesktopSyncSequence({
    async pushFolders() {},
    async pushDocuments() { return ["image_quota_exceeded"]; },
    async pullRemoteSnapshot() {},
    async maintain() { throw new Error("maintenance_failed"); },
    async recordSuccess() {},
    reportMaintenanceFailure() { throw new Error("logger_failed"); },
  }),
  { state: "error", message: "image_quota_exceeded" },
  "维护日志失败不能覆盖真正的待上传图片错误",
);

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

let syncPrepared = 0;
const unregisterSyncPreparation = registerDesktopSyncPreparation(async () => {
  syncPrepared += 1;
  return true;
});
assert.equal(await prepareDesktopSync(), true);
assert.equal(syncPrepared, 1, "后台拉取前必须复用编辑器保存屏障");
unregisterSyncPreparation();

assert.equal(REMOTE_UPDATE_INTERVAL_MS, 30_000);
assert.equal(decideRemoteDocumentUpdate(5, 5, false), "unchanged");
assert.equal(decideRemoteDocumentUpdate(6, 5, false), "unchanged");
assert.equal(decideRemoteDocumentUpdate(5, 6, false), "apply");
assert.equal(
  decideRemoteDocumentUpdate(5, 6, true),
  "prompt",
  "本地有草稿时远端更新不能静默覆盖",
);

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
const offlineStoreAST = ts.createSourceFile(
  "offlineStore.ts",
  offlineStore,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const offlineStoreFunctions = new Map();
for (const statement of offlineStoreAST.statements) {
  if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
    offlineStoreFunctions.set(statement.name.text, statement);
  }
}
function calledIdentifiers(node) {
  const names = new Set();
  function visit(current) {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) {
      names.add(current.expression.text);
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return names;
}
const serializedMutationFunctions = new Set(
  [...offlineStoreFunctions]
    .filter(([, declaration]) => calledIdentifiers(declaration).has("serializeMutation"))
    .map(([name]) => name),
);
const nestedSerializedCalls = [];
for (const name of serializedMutationFunctions) {
  const calls = calledIdentifiers(offlineStoreFunctions.get(name));
  for (const called of serializedMutationFunctions) {
    if (calls.has(called)) {
      nestedSerializedCalls.push(`${name} -> ${called}`);
    }
  }
}
assert.deepEqual(
  nestedSerializedCalls,
  [],
  "已排队的桌面 mutation 不能直接调用另一个排队 mutation；请抽出内部操作并通过队列 scope.runNested 复用",
);
const apiSource = readFileSync(
  new URL("../spa/src/api.ts", import.meta.url),
  "utf8",
);
const editorSource = readFileSync(
  new URL("../spa/src/components/editor/MarkdownEditor.tsx", import.meta.url),
  "utf8",
);
const imageNodeSource = readFileSync(
  new URL("../spa/src/components/editor/ImageNodeView.tsx", import.meta.url),
  "utf8",
);
const syncStatusSource = readFileSync(
  new URL("../spa/src/components/DesktopSyncStatus.tsx", import.meta.url),
  "utf8",
);
const desktopMigration = readFileSync(
  new URL("../src-tauri/migrations/0002_offline_images.sql", import.meta.url),
  "utf8",
);
const desktopCacheMigration = readFileSync(
  new URL("../src-tauri/migrations/0003_offline_image_cache.sql", import.meta.url),
  "utf8",
);
const tauriSource = readFileSync(
  new URL("../src-tauri/src/lib.rs", import.meta.url),
  "utf8",
);
assert.match(
  offlineStore,
  /DEFAULT_DOCUMENT_THEME\s*=\s*"minimal"/,
  "桌面端新文档默认主题必须与网页端一致",
);
const permanentDeletionSection = sourceBetween(
  offlineStore,
  "export async function desktopPermanentlyDeleteDocument",
  "export async function desktopListFolders",
);
assert.match(
  permanentDeletionSection,
  /remoteJSON\(`\/api\/documents\/\$\{encodeURIComponent\(docId\)\}\/permanent`/,
  "桌面永久删除必须先调用服务端权威接口",
);
assert.match(
  permanentDeletionSection,
  /DELETE FROM offline_documents WHERE account_id = \$1 AND doc_id = \$2/,
  "服务端永久删除成功后必须清掉本地文档，避免同步复活",
);
assert.match(
  permanentDeletionSection,
  /cleanupUnusedOfflineImages\(account\)/,
  "永久删除本地文档后必须清理不再引用的离线图片",
);
assert.match(
  permanentDeletionSection,
  /cleanupUnusedOfflineImages\(account\)[\s\S]*?if \(!local\) scheduleSync\(0\)/,
  "远端账号永久删除后无论图片清理结果如何都必须立即补一轮同步",
);
assert.match(
  apiSource,
  /permanentlyDeleteDocument[\s\S]*?isDesktopRuntime\(\)[\s\S]*?desktopPermanentlyDeleteDocument/,
  "桌面永久删除必须通过本地协调层处理",
);
assert.match(offlineStore, /desktopStoreLocalImage[\s\S]*?INSERT INTO offline_images/);
assert.match(
  offlineStore,
  /prepareDocumentContentForRemote[\s\S]*?uploadOfflineImage[\s\S]*?replaceDesktopLocalImageURLs/,
  "同步文档前必须先把本地图片上传并替换成远端 URL",
);
assert.match(
  offlineStore,
  /applyUploadedImageMapping[\s\S]*?UPDATE offline_documents[\s\S]*?replace\(content, \$2, \$3\)/,
  "上传映射必须持久化到 SQLite，不能只更新当前编辑器",
);
assert.match(
  offlineStore,
  /sync_state IN \('trash', 'conflict'\)[\s\S]*?title = \$4 AND theme = \$5 AND content = \$6/,
  "图片映射确认不能复活已删除或冲突中的文档",
);
assert.match(
  offlineStore,
  /base_revision = CASE[\s\S]*?sync_state IN \('trash', 'conflict'\)[\s\S]*?THEN base_revision/,
  "同步响应不能推进已删除或冲突文档的基准版本",
);
assert.match(
  offlineStore,
  /remote_snapshot = CASE[\s\S]*?sync_state IN \('trash', 'conflict'\)[\s\S]*?THEN remote_snapshot/,
  "同步响应不能清掉并发产生的冲突快照",
);
assert.match(
  offlineStore,
  /SET sync_state = 'conflict'[\s\S]*?sync_state NOT IN \('trash', 'conflict'\)/,
  "远端 409 不能把同步期间删除的文档复活成冲突",
);
assert.match(
  offlineStore,
  /SELECT i\.image_id, i\.object_key FROM offline_images i/,
  "清理本地附件时不能把无关图片的 base64 正文全部读入内存",
);
assert.match(
  offlineStore,
  /DESKTOP_OFFLINE_IMAGE_CLEANUP_GRACE_MS = 10 \* 60 \* 1000/,
  "新写入的离线图片必须有清理保护窗口，避免先写图片后保存文档的竞态",
);
assert.match(
  offlineStore,
  /cleanupUnusedOfflineImages[\s\S]*?created_at < \$3/,
  "后台孤儿图片清理必须跳过保护窗口内的新图片",
);
assert.match(
  offlineStore,
  /cleanupUnusedOfflineImages[\s\S]*?AND i\.is_local_origin = 0/,
  "自动缓存清理不能回收仍是本地原件的待上传图片",
);
assert.match(
  offlineStore,
  /desktopReleaseUnusedImages[\s\S]*?created_at < \$3/,
  "显式释放离线图片也不能删除刚写入、尚未完成文档保存的图片",
);
assert.match(offlineStore, /cacheAllDocumentImages\(account\)/);
assert.match(offlineStore, /DELETE FROM offline_images WHERE account_id = \$1/);
assert.match(apiSource, /purpose === "persistent"[\s\S]*?desktopStoreLocalImage/);
assert.match(
  apiSource,
  /flattenedAnimation[\s\S]*?desktopStoreLocalImage/,
  "桌面粘贴大 GIF 时必须把静态化结果返回给编辑器",
);
assert.match(
  apiSource,
  /fetchAppResource[\s\S]*?isDesktopLocalImageURL\(path\)[\s\S]*?desktopResolveImageSource/,
  "Word、PDF 等读取链路必须能直接读取桌面本地图片",
);
assert.match(
  editorSource,
  /DESKTOP_IMAGE_UPLOADED_EVENT[\s\S]*?DESKTOP_IMAGE_MAPPING_META/,
  "编辑器必须接收上传映射且避免把内部替换当成用户编辑",
);
assert.match(imageNodeSource, /desktopResolveImageSource\(src\)/);
assert.match(
  imageNodeSource,
  /DESKTOP_IMAGE_UPLOAD_FAILED_EVENT[\s\S]*?t\.errors\[syncError\]/,
  "失败图片必须在具体节点下显示本地化原因",
);
assert.match(
  syncStatusSource,
  /syncLabel\(summary, t\.desktopSync, t\.errors\)[\s\S]*?errors\[code\]/,
  "同步状态必须把持久化的图片错误码映射为本地化文案",
);
assert.match(desktopMigration, /CREATE TABLE IF NOT EXISTS offline_images/);
assert.match(desktopMigration, /base64_data TEXT NOT NULL/);
assert.match(tauriSource, /version: 2[\s\S]*?0002_offline_images\.sql/);
assert.match(tauriSource, /version: 3[\s\S]*?0003_offline_image_cache\.sql/);
assert.match(desktopCacheMigration, /is_local_origin[\s\S]*?CHECK/);
assert.match(
  desktopCacheMigration,
  /UPDATE offline_images[\s\S]*?object_key IS NULL AND remote_url IS NULL/,
  "升级旧数据库时必须保住尚未上传的本地图片",
);
assert.match(offlineStore, /DESKTOP_REMOTE_IMAGE_CACHE_LIMIT_BYTES = 512 \* 1024 \* 1024/);
assert.match(
  offlineStore,
  /desktopClearRemoteImageCache[\s\S]*?is_local_origin = 0[\s\S]*?remote-image-cache-manual/,
  "清空缓存只能删除可重新下载的远端副本，并暂停后台全量回填",
);
const cacheRemoteImageSection = sourceBetween(
  offlineStore,
  "async function cacheRemoteImageForAccount",
  "async function uploadOfflineImage",
);
const cacheDocumentImagesSection = sourceBetween(
  offlineStore,
  "async function cacheDocumentImages",
  "async function cacheAllDocumentImages",
);
const uploadOfflineImageSection = sourceBetween(
  offlineStore,
  "async function uploadOfflineImage",
  "async function applyUploadedImageMapping",
);
const pushDocumentsSection = sourceBetween(
  offlineStore,
  "async function pushDocuments",
  "async function recoverDeletedRemoteDocument",
);
const calculateSummarySection = sourceBetween(
  offlineStore,
  "async function calculateSummary",
  "class RemoteHTTPError",
);
assert.match(
  cacheRemoteImageSection,
  /serializeImageCacheMutation\(/,
  "远端图片缓存必须使用独立队列，不能嵌套文档 mutation 队列",
);
assert.doesNotMatch(
  cacheRemoteImageSection,
  /serializeMutation\(/,
  "远端图片缓存不能重新使用文档 mutation 队列",
);
assert.match(
  cacheDocumentImagesSection,
  /selectOfflineImageIdentityByObjectKey\(account, objectKey\)/,
  "热路径的缓存存在性判断必须调用轻量查询",
);
assert.doesNotMatch(
  cacheDocumentImagesSection,
  /selectOfflineImageByObjectKey\(/,
  "热路径不能把图片 base64 正文读入内存",
);
assert.match(
  offlineStore,
  /remoteCacheFullAccounts\.has\(account\)[\s\S]*?DESKTOP_REMOTE_IMAGE_CACHE_LIMIT_BYTES[\s\S]*?remoteCacheFullAccounts\.add\(account\)/,
  "远端缓存达到上限后不能每轮同步继续下载图片",
);
assert.match(
  pushDocumentsSection,
  /catch \(error\) \{\s*if \(error instanceof OfflineImageUploadError\) \{\s*imageUploadIssues\.push\(error\.code\);[\s\S]*?continue;/,
  "单张图片被拒绝时必须继续同步后续文档",
);
assert.match(offlineStore, /runDesktopSyncSequence\(\{/);
assert.match(
  offlineStore,
  /IMAGE_MAINTENANCE_META_KEY[\s\S]*?desktopMaintenanceBackoff\(attempts\)/,
  "图片维护失败必须持久化并按退避时间重试",
);
assert.match(
  calculateSummarySection,
  /last_error IS NOT NULL\s*AND \(sync_state <> 'clean' OR folder_dirty = 1\)/,
  "已同步文档的陈旧错误不能污染同步状态",
);
assert.match(
  calculateSummarySection,
  /SELECT i\.last_error FROM offline_images i[\s\S]*?EXISTS \([\s\S]*?d\.sync_state <> 'clean'[\s\S]*?instr\(d\.content, \$2 \|\| i\.image_id\) > 0/,
  "图片错误只应在仍被待同步文档引用时显示",
);
assert.match(
  offlineStore,
  /SET object_key = \$3, remote_url = \$4, last_error = NULL,\s*is_local_origin = 1/,
  "图片上传完成但正文尚未替换时必须继续保护本地副本",
);
assert.match(
  uploadOfflineImageSection,
  /const replacedDocuments = await applyUploadedImageMapping\([\s\S]*?row\.image_id,[\s\S]*?result\.image\.url,[\s\S]*?if \(replacedDocuments > 0\)[\s\S]*?UPDATE offline_images SET is_local_origin = 0/,
  "本地图片只有在所有占位地址替换完成后才能转为可清理的远端缓存",
);
assert.match(
  uploadOfflineImageSection,
  /if \(row\.remote_url\)[\s\S]*?const replacedDocuments = await applyUploadedImageMapping\([\s\S]*?row\.image_id,[\s\S]*?row\.remote_url,[\s\S]*?if \(replacedDocuments > 0\)/,
  "恢复半完成上传时也必须等持久化正文完成占位地址替换",
);
assert.match(
  offlineStore,
  /applyUploadedImageMapping[\s\S]*?if \(result\.rowsAffected > 0 && typeof window !== "undefined"\)/,
  "没有持久化正文被替换时不能提前广播图片已上传事件",
);
assert.match(
  offlineStore,
  /let code = "image_upload_failed";[\s\S]*?if \(body\.code\) code = body\.code/,
  "未知上传错误必须使用可翻译的通用错误码",
);
assert.match(
  offlineStore,
  /instr\(d\.remote_snapshot, i\.object_key\) > 0/,
  "冲突云端稿引用的图片不能被本地清理器误删",
);
assert.match(
  offlineStore,
  /desktopReleaseUnusedImages[\s\S]*?instr\(d\.remote_snapshot, \$3 \|\| offline_images\.image_id\) > 0/,
  "显式释放图片时也必须保留冲突快照中的引用",
);
assert.match(
  editorSource,
  /flattenedAnimation[\s\S]*?setUploadNotice\([\s\S]*?importGifFlattened/,
  "桌面粘贴大 GIF 被静态化时必须向用户提示",
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
assert.match(
  offlineStore,
  /syncDesktopNow\(options:[\s\S]*?performPreparedSync[\s\S]*?prepareDesktopSync\(\)[\s\S]*?performSync\(account, options\)/,
  "每次桌面同步都必须先保存编辑器内尚未落 SQLite 的草稿",
);
assert.match(
  offlineStore,
  /remoteJSON<\{ documents:[\s\S]*?remoteJSON<\{ folders:[\s\S]*?prepareDesktopSync\(\)[\s\S]*?SELECT \* FROM offline_documents/,
  "远端列表请求期间产生的新编辑也必须在应用远端内容前落盘",
);

for (const file of [
  "../spa/src/documentTransfer.ts",
  "../spa/src/components/editor/exportDocx.ts",
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

const apiLogoutSource = readFileSync(
  new URL("../spa/src/api.ts", import.meta.url),
  "utf8",
);
assert.match(
  apiLogoutSource,
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
  /registerDesktopSyncPreparation\(\(\) => saver\.flushAll\(\)\)/,
  "编辑器必须把防抖窗口内的改动接入桌面同步与登出屏障",
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
  /syncLabel\(summary, t\.desktopSync, t\.errors\)[\s\S]*?errors\[code\]/,
  "桌面同步状态必须把图片错误码翻译成用户可读文案",
);
assert.match(
  syncStatus,
  /desktopSyncSummary\(\)[\s\S]*?navigator\.onLine[\s\S]*?syncDesktopNow\(\)/,
  "客户端启动后必须自动拉取远端并重试待同步修改",
);
assert.match(
  syncStatus,
  /addEventListener\("focus", checkRemote\)[\s\S]*?visibilitychange[\s\S]*?setInterval\(checkRemote, REMOTE_UPDATE_INTERVAL_MS\)/,
  "客户端前台必须定时检查，并在重新聚焦时立即检查远端",
);
assert.match(
  syncStatus,
  /syncDesktopNow\(\{ silent: true \}\)/,
  "后台检查不能让同步状态每 30 秒闪烁",
);
assert.match(
  syncStatus,
  /shouldPrompt[\s\S]*?setDialogOpen\(true\)/,
  "客户端发现新的同步冲突时必须主动提示用户",
);

const documentsSource = readFileSync(
  new URL("../spa/src/documents.ts", import.meta.url),
  "utf8",
);
assert.match(
  documentsSource,
  /refetchInterval:\s*desktop \? false : REMOTE_UPDATE_INTERVAL_MS[\s\S]*?refetchOnWindowFocus:\s*!desktop/,
  "网页文档列表必须在前台轮询并在窗口聚焦时更新 revision",
);

const liveEditor = readFileSync(
  new URL("../spa/src/components/editor/LiveEditor.tsx", import.meta.url),
  "utf8",
);
assert.match(
  liveEditor,
  /decideRemoteDocumentUpdate[\s\S]*?latestDecision === "prompt"[\s\S]*?setRemoteUpdateAvailable\(true\)[\s\S]*?latestDecision === "apply"[\s\S]*?acceptLatestDocument/,
  "网页编辑器必须自动应用干净远端更新，并保护本地草稿",
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
