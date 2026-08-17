import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  decryptLocalModeValue,
  deriveLocalModePasswordMaterial,
  encryptLocalModeValue,
  localModeVerifierMatches,
} = await import("./_local_mode_crypto_bundle.mjs");

const salt = new Uint8Array(16).fill(7);
const first = await deriveLocalModePasswordMaterial("correct horse battery staple", salt, 100_000);
const same = await deriveLocalModePasswordMaterial("correct horse battery staple", salt, 100_000);
const wrong = await deriveLocalModePasswordMaterial("wrong password", salt, 100_000);
assert.equal(localModeVerifierMatches(first.verifier, same.verifier), true);
assert.equal(localModeVerifierMatches(first.verifier, wrong.verifier), false);

const plaintext = "本地标题\n![图片](koinote-local-image://550e8400-e29b-41d4-a716-446655440000)";
const ciphertext = await encryptLocalModeValue(plaintext, first.encryptionKey);
assert.notEqual(ciphertext, plaintext);
assert.match(ciphertext, /^koinote-encrypted-v1:/);
assert.equal(await decryptLocalModeValue(ciphertext, same.encryptionKey), plaintext);
await assert.rejects(
  decryptLocalModeValue(ciphertext, wrong.encryptionKey),
  /local_mode_data_invalid/,
);
await assert.rejects(
  decryptLocalModeValue(plaintext, first.encryptionKey),
  /local_mode_data_not_encrypted/,
);

const localMode = readFileSync("spa/src/desktop/localMode.ts", "utf8");
const offlineStore = readFileSync("spa/src/desktop/offlineStore.ts", "utf8");
const transport = readFileSync("spa/src/desktop/transport.ts", "utf8");
const markdownEditor = readFileSync("spa/src/components/editor/MarkdownEditor.tsx", "utf8");
const mediaDialog = readFileSync("spa/src/components/editor/WechatDialog.tsx", "utf8");
const wechatMath = readFileSync("spa/src/components/editor/wechatMath.ts", "utf8");
const login = readFileSync("spa/src/pages/DesktopLoginPage.tsx", "utf8");
const shell = readFileSync("spa/src/components/AppShell.tsx", "utf8");
const editor = readFileSync("spa/src/pages/EditorPage.tsx", "utf8");
const migration = readFileSync("src-tauri/migrations/0004_local_mode.sql", "utf8");
const tauri = readFileSync("src-tauri/src/lib.rs", "utf8");

assert.match(localMode, /PASSWORD_ITERATIONS = 310_000/);
assert.match(localMode, /selectionStorage\(\)\?\.setItem\(LOCAL_MODE_SELECTION_KEY, "1"\)/);
assert.match(localMode, /activeEncryptionKey = null/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS local_mode_config/);
assert.match(tauri, /version: 4[\s\S]*?0004_local_mode\.sql/);
assert.match(tauri, /async fn desktop_import_local_mode[\s\S]*?import_local_mode_batch/);
assert.match(tauri, /async fn desktop_finalize_local_mode_import[\s\S]*?finalize_local_mode_import/);
assert.match(tauri, /async fn desktop_abort_local_mode_import[\s\S]*?abort_local_mode_import/);
assert.match(tauri, /let mut transaction = pool\.begin\(\)\.await/);
assert.match(tauri, /transaction\.commit\(\)\.await/);
assert.match(tauri, /local_import_rolls_back_complete_batch/);
assert.match(tauri, /local_import_finalize_is_atomic_and_abortable/);
assert.match(
  transport,
  /isDesktopLocalModeSelected\(\)[\s\S]*?throw new Error\("local_mode_network_disabled"\)[\s\S]*?plugin-http/,
  "本地模式网络阻断必须位于原生 HTTP 调用之前",
);
assert.match(offlineStore, /DESKTOP_LOCAL_ACCOUNT_ID = "local:v1"|DESKTOP_LOCAL_ACCOUNT_ID/);
assert.match(offlineStore, /storedLocalValue\(account, document\.title\)/);
assert.match(offlineStore, /storedLocalValue\(account, bytesToBase64\(bytes\)\)/);
assert.match(offlineStore, /if \(!local\) scheduleSync\(\)/);
assert.match(offlineStore, /verifyDesktopLocalModePassword\(password\)/);
assert.match(offlineStore, /folderIDs = new Map[\s\S]*?crypto\.randomUUID\(\)/);
assert.match(offlineStore, /imageURLs = new Map/);
assert.match(offlineStore, /replaceDesktopLocalImageURLs\(document\.content, imageURLs\)/);
assert.match(offlineStore, /invoke\("desktop_import_local_mode", \{ batch \}\)/);
assert.match(offlineStore, /LOCAL_IMPORT_DOCUMENT_BATCH_SIZE = 10/);
assert.match(
  offlineStore,
  /const documents: DesktopLocalImportBatch\["documents"\] = \[\][\s\S]*?documents\.push\([\s\S]*?await invoke\("desktop_import_local_mode", \{ batch \}\)/,
  "本地文档导入应把一批文档合并成一次 IPC 调用",
);
assert.match(offlineStore, /stagingAccount = `local-import:\$\{crypto\.randomUUID\(\)\}`/);
assert.match(offlineStore, /desktop_finalize_local_mode_import/);
assert.match(offlineStore, /desktop_abort_local_mode_import/);
assert.doesNotMatch(offlineStore, /Promise\.all\([\s\S]{0,100}storedDocuments\.map/);
assert.doesNotMatch(offlineStore, /BEGIN IMMEDIATE/);
assert.match(
  offlineStore,
  /async function localReferencedImageIDs[\s\S]*?decryptDesktopLocalValue\(row\.content\)/,
  "本地图片回收必须先解密正文再判断引用",
);
assert.match(
  offlineStore,
  /async function cleanupUnusedOfflineImages[\s\S]*?if \(isLocalAccount\(account\)\)[\s\S]*?localReferencedImageIDs/,
);
assert.match(
  offlineStore,
  /desktopPermanentlyDeleteDocument[\s\S]*?await cleanupUnusedOfflineImages\(account\)[\s\S]*?catch \{\}[\s\S]*?if \(!local\) scheduleSync\(0\)/,
  "远端账号永久删除后，即使图片清理失败也应立即调度同步",
);
assert.match(login, /configureDesktopLocalMode/);
assert.match(login, /unlockDesktopLocalMode/);
assert.match(shell, /lockDesktopLocalMode/);
assert.match(shell, /leaveDesktopLocalMode/);
assert.match(shell, /localMode && !isLocalModeAllowedPath\(pathname\)/);
for (const allowedPath of ["/editor", "/documents", "/trash"]) {
  assert.ok(
    shell.slice(shell.indexOf("function isLocalModeAllowedPath")).includes(`"${allowedPath}"`),
    `本地模式应允许 ${allowedPath}`,
  );
}
assert.doesNotMatch(shell, /function isLocalModeRemotePath/);
assert.match(editor, /!localMode && <button[\s\S]*?setShareOpen/);
assert.match(markdownEditor, /isLocalModeNetworkDisabled\(err\)[\s\S]*?desktopLocalMode\.networkDisabled/);
assert.match(wechatMath, /isLocalModeNetworkDisabled\(error\)[\s\S]*?throw error/);
assert.match(mediaDialog, /isLocalModeNetworkDisabled\(error\)[\s\S]*?desktopLocalMode\.networkDisabled/);

console.log("local mode checks passed");
