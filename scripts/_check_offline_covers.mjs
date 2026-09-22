import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const sqlite = new DatabaseSync(":memory:");
for (const migration of readdirSync("src-tauri/migrations").filter((name) => name.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(`src-tauri/migrations/${migration}`, "utf8"));
}
const bind = (values) => Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value]));
const calls = [];
const harness = {
  local: true,
  database: {
    async select(sql, values = []) { return sqlite.prepare(sql).all(bind(values)); },
    async execute(sql, values = []) {
      return { rowsAffected: Number(sqlite.prepare(sql).run(bind(values)).changes) };
    },
  },
  async invoke(command, args) { calls.push({ command, args }); },
};
globalThis.__offlineCoverTest = harness;
const bundle = await build({
  stdin: {
    contents: readFileSync("spa/src/desktop/offlineStore.ts", "utf8") + `
      export { insertRemoteDocument, localReferencedImageIDs, cleanupUnusedOfflineImages, applyUploadedImageMapping };
      export { encryptLocalModeValue, decryptLocalModeValue } from "./localModeCrypto";
    `,
    resolveDir: `${process.cwd()}/spa/src/desktop`,
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  plugins: [{
    name: "offline-cover-adapters",
    setup(builder) {
      const adapters = {
        "@tauri-apps/plugin-sql": "export default { load: async () => globalThis.__offlineCoverTest.database };",
        "@tauri-apps/api/core": "export const invoke = (...args) => globalThis.__offlineCoverTest.invoke(...args);",
        "./auth": "export const getStoredDesktopSession = async () => ({ accountId: 'account-1' });",
        "./network": "export const desktopFetch = async () => { throw new Error('Unexpected network request'); };",
        "./logoutGuard": "export const prepareDesktopSync = async () => true;",
        "./localMode": `
          const harness = globalThis.__offlineCoverTest;
          export const DESKTOP_LOCAL_ACCOUNT_ID = "local:v1";
          export const isDesktopLocalModeSelected = () => harness.local;
          export const isDesktopLocalModeUnlocked = () => harness.local;
          export const verifyDesktopLocalModePassword = async () => harness.key;
          export const encryptDesktopLocalValue = (value) => harness.encrypt(value, harness.key);
          export const decryptDesktopLocalValue = (value, key) => harness.decrypt(value, key ?? harness.key);
        `,
      };
      builder.onResolve({ filter: /.*/ }, ({ path }) =>
        Object.hasOwn(adapters, path) ? { path, namespace: "offline-cover-test" } : undefined,
      );
      builder.onLoad({ filter: /.*/, namespace: "offline-cover-test" }, ({ path }) => ({ contents: adapters[path] }));
    },
  }],
});
const store = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
harness.key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
harness.encrypt = store.encryptLocalModeValue;
harness.decrypt = store.decryptLocalModeValue;
const originalWindow = globalThis.window;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
globalThis.window = new EventTarget();
globalThis.setTimeout = () => 1;
globalThis.clearTimeout = () => {};

const imageID = "550e8400-e29b-41d4-a716-446655440000";
const localSource = `koinote-local-image://${imageID}`;
const objectKey = "u/test-user/12345678abcdef00.png";
const remoteSource = `https://img.koinote.app/${objectKey}`;
const rowFor = (account, docId) => sqlite.prepare("SELECT * FROM offline_documents WHERE account_id = ? AND doc_id = ?").get(account, docId);
const imageCount = (account) => sqlite.prepare("SELECT COUNT(*) AS count FROM offline_images WHERE account_id = ?").get(account).count;

try {
  const local = (await store.desktopCreateDocument({ title: "Local", content: "Body" })).document;
  const storedLocal = rowFor("local:v1", local.docId);
  assert.equal(storedLocal.base_revision, 1);
  assert.equal(storedLocal.local_revision, 1);
  assert.equal(storedLocal.sync_state, "clean");
  assert.equal(storedLocal.created_at, local.createdAt);
  assert.equal(storedLocal.updated_at, local.updatedAt);
  assert.match(storedLocal.cover_image_source, /^koinote-encrypted-v1:/);
  sqlite.prepare("UPDATE offline_documents SET cover_image_source = '', cover_prompt = '' WHERE doc_id = ?").run(local.docId);
  const upgraded = (await store.desktopGetDocument(local.docId)).document;
  assert.equal(upgraded.title, "Local");
  assert.equal(upgraded.coverImageSource, "");
  assert.equal(upgraded.coverPrompt, "");
  await store.desktopUpdateDocument(local.docId, {
    title: "Local", content: "Body", expectedRevision: 1,
    coverMode: "ai", coverRatio: "3:2", coverImageSource: localSource, coverPrompt: "Original prompt",
  });
  const encryptedImage = await harness.encrypt("Y292ZXI=", harness.key);
  sqlite.prepare(`INSERT INTO offline_images
    (account_id, image_id, content_type, base64_data, byte_size, created_at, is_local_origin)
    VALUES ('local:v1', ?, 'image/png', ?, 5, '2000-01-01T00:00:00Z', 1)`)
    .run(imageID, encryptedImage);
  assert.equal((await store.localReferencedImageIDs("local:v1")).has(imageID), true);
  await store.desktopReleaseUnusedImages([localSource]);
  await store.cleanupUnusedOfflineImages("local:v1");
  assert.equal(imageCount("local:v1"), 1, "a cover-only local image must survive cleanup");
  const reopened = (await store.desktopGetDocument(local.docId)).document;
  assert.equal(reopened.coverImageSource, localSource);
  assert.equal(reopened.coverPrompt, "Original prompt");

  harness.local = false;
  const summary = await store.desktopImportLocalMode("password");
  assert.equal(summary.images, 1);
  const importedImage = calls.flatMap((call) => call.args.batch?.images ?? [])[0];
  const importedDocument = calls.flatMap((call) => call.args.batch?.documents ?? [])[0];
  assert.equal(importedDocument.coverImageSource, `koinote-local-image://${importedImage.imageId}`);
  assert.equal(importedDocument.coverMode, "ai");
  assert.equal(importedDocument.coverRatio, "3:2");
  assert.equal(importedDocument.coverPrompt, "Original prompt");

  const created = (await store.desktopCreateDocument({ title: "Offline" })).document;
  assert.equal(rowFor("account-1", created.docId).base_revision, 0);
  assert.equal(rowFor("account-1", created.docId).sync_state, "create");
  const remote = {
    docId: "remote-document", title: "Remote", theme: "minimal", content: "Remote body",
    coverMode: "ai", coverRatio: "3:2", coverImageSource: "data:image/png;base64,Y292ZXI=",
    coverPrompt: "Remote prompt", revision: 7, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
    share: { token: "share-token", access: "link", requiresPassword: false, viewCount: 2 },
  };
  await store.insertRemoteDocument("account-1", remote, "folder-1", 12);
  const pulled = rowFor("account-1", remote.docId);
  assert.equal(pulled.local_revision, 7);
  assert.equal(pulled.base_revision, 7);
  assert.equal(pulled.created_at, remote.createdAt);
  assert.equal(pulled.updated_at, remote.updatedAt);
  assert.equal(pulled.sort_order, 12);
  assert.deepEqual(JSON.parse(pulled.share_json), remote.share);
  const accepted = await store.desktopAcceptRemoteDocumentMutation({ ...remote, coverPrompt: "Updated prompt" });
  assert.equal(accepted.document.coverPrompt, "Updated prompt");

  sqlite.prepare(`INSERT INTO offline_images
    (account_id, image_id, content_type, base64_data, byte_size, created_at, is_local_origin, object_key)
    VALUES ('account-1', ?, 'image/png', 'Y292ZXI=', 5, '2000-01-01T00:00:00Z', 0, ?)`)
    .run(imageID, objectKey);
  sqlite.prepare("UPDATE offline_documents SET cover_image_source = ? WHERE doc_id = ?").run(localSource, remote.docId);
  await store.desktopReleaseUnusedImages([localSource]);
  await store.cleanupUnusedOfflineImages("account-1");
  assert.equal(imageCount("account-1"), 1, "cover-only references protect cloud image caches");
  assert.equal(await store.applyUploadedImageMapping("account-1", imageID, remoteSource), 1);
  assert.equal(rowFor("account-1", remote.docId).cover_image_source, remoteSource);
  await store.cleanupUnusedOfflineImages("account-1");
  assert.equal(imageCount("account-1"), 1, "remote cover object keys protect cloud image caches");
  console.log("offline cover SQLite and migration checks passed");
} finally {
  globalThis.window = originalWindow;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  delete globalThis.__offlineCoverTest;
  sqlite.close();
}
