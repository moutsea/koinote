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
  beforeExecute: async () => {},
  fetch: async () => { throw new Error("Unexpected network request"); },
  database: {
    async select(sql, values = []) { return sqlite.prepare(sql).all(bind(values)); },
    async execute(sql, values = []) {
      await harness.beforeExecute(sql, values);
      return { rowsAffected: Number(sqlite.prepare(sql).run(bind(values)).changes) };
    },
  },
  async invoke(command, args) { calls.push({ command, args }); },
};
globalThis.__offlineCoverTest = harness;
const bundle = await build({
  stdin: {
    contents: readFileSync("spa/src/desktop/offlineStore.ts", "utf8") + `
      export { insertRemoteDocument, localReferencedImageIDs, cleanupUnusedOfflineImages, applyUploadedImageMapping,
        acknowledgeDocument, acknowledgeMatchingRemoteDocument, replaceDocumentFromRemote, prepareDocumentContentForRemote };
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
        "./network": "export const desktopFetch = (...args) => globalThis.__offlineCoverTest.fetch(...args);",
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

  // Explicit release receives the original local key even after sync has mapped
  // document references to remote URLs. Exercise the real DELETE past its grace
  // period, including references held only by the other side of a conflict.
  for (const source of [localSource, remoteSource, `/images/${objectKey}`]) {
    for (const reference of ["cover", "body", "remote-cover", "remote-body"]) {
      const content = reference === "body" ? `![image](${source})` : "Body";
      const cover = reference === "cover" ? source : "";
      const snapshot = reference.startsWith("remote-")
        ? JSON.stringify({ ...remote, content: reference === "remote-body" ? `![image](${source})` : "Body", coverImageSource: reference === "remote-cover" ? source : "" })
        : null;
      sqlite.prepare(`UPDATE offline_documents SET content = ?, cover_image_source = ?, remote_snapshot = ?
        WHERE account_id = 'account-1' AND doc_id = ?`).run(content, cover, snapshot, remote.docId);
      await store.desktopReleaseUnusedImages([localSource]);
      await store.cleanupUnusedOfflineImages("account-1");
      assert.equal(imageCount("account-1"), 1, `${reference} retains its cached image: ${source}`);
      assert.equal(await store.desktopResolveImageSource(source), "data:image/png;base64,Y292ZXI=", `${reference} remains readable offline`);
    }
  }

  sqlite.prepare(`UPDATE offline_documents SET content = 'Body', cover_image_source = '', remote_snapshot = NULL
    WHERE account_id = 'account-1' AND doc_id = ?`).run(remote.docId);
  await store.desktopReleaseUnusedImages([localSource]);
  assert.equal(imageCount("account-1"), 0, "a synced image is reclaimed after its final reference is removed");
  assert.equal(imageCount("local:v1"), 1, "cleanup is scoped to the active account");

  sqlite.prepare(`INSERT INTO offline_images
    (account_id, image_id, content_type, base64_data, byte_size, created_at, is_local_origin)
    VALUES ('account-1', ?, 'image/png', 'Y292ZXI=', 5, ?, 1)`).run(imageID, new Date().toISOString());
  await store.desktopReleaseUnusedImages([localSource]);
  assert.equal(imageCount("account-1"), 1, "new uploads retain their cleanup grace period");
  sqlite.prepare("UPDATE offline_images SET created_at = '2000-01-01T00:00:00Z' WHERE account_id = 'account-1'").run();
  await store.desktopReleaseUnusedImages([localSource]);
  assert.equal(imageCount("account-1"), 0, "explicit release still reclaims abandoned local uploads after the grace period");

  const race = (await store.desktopCreateDocument({
    title: "Image upload race", content: `Body\n\n![](${localSource})`,
  })).document;
  const sent = rowFor("account-1", race.docId);
  const edited = (await store.desktopUpdateDocument(race.docId, {
    ...race, content: `${race.content}\n\nTyping during upload`, expectedRevision: race.revision,
  })).document;
  await store.applyUploadedImageMapping("account-1", imageID, remoteSource);
  const mappedContent = race.content.replace(localSource, remoteSource);
  const undone = (await store.desktopUpdateDocument(race.docId, {
    ...edited, content: mappedContent, expectedRevision: edited.revision,
  })).document;
  await store.acknowledgeDocument("account-1", sent, { ...race, content: mappedContent });
  const next = await store.desktopUpdateDocument(race.docId, {
    ...undone, content: `${mappedContent}\n\nKeep writing`, expectedRevision: undone.revision,
  });
  assert.equal(next.document.content, `${mappedContent}\n\nKeep writing`, "typing after an upload acknowledgement must not conflict with this client's own saves");
  assert.equal(next.document.revision, undone.revision + 1, "an old sync response must not rewind the local revision");
  assert.equal(rowFor("account-1", race.docId).sync_state, "update");
  await store.acknowledgeDocument("account-1", sent, { ...race, content: mappedContent });
  const afterLateResponse = rowFor("account-1", race.docId);
  assert.equal(afterLateResponse.content, next.document.content, "a late response must retain text entered after its snapshot");
  assert.equal(afterLateResponse.local_revision, next.document.revision);
  assert.equal(afterLateResponse.sync_state, "update", "new text must remain queued for cloud sync");

  const sameContent = (await store.desktopCreateDocument({ title: "Same content", content: "Body" })).document;
  const sameRow = rowFor("account-1", sameContent.docId);
  await store.acknowledgeDocument("account-1", sameRow, { ...sameContent, revision: 9 });
  assert.equal(rowFor("account-1", sameContent.docId).local_revision, 9);
  assert.equal(rowFor("account-1", sameContent.docId).base_revision, 9);
  const matchingRow = rowFor("account-1", sameContent.docId);
  await store.acknowledgeMatchingRemoteDocument("account-1", matchingRow, { ...sameContent, revision: 10 }, null, 0);
  assert.equal(rowFor("account-1", sameContent.docId).local_revision, 10);
  assert.equal(rowFor("account-1", sameContent.docId).base_revision, 10);
  const beforeRemoteEdit = rowFor("account-1", sameContent.docId);
  await store.replaceDocumentFromRemote("account-1", beforeRemoteEdit, { ...sameContent, content: "Real remote edit", revision: 11 }, null, 0);
  await assert.rejects(store.desktopUpdateDocument(sameContent.docId, {
    ...sameContent, content: "Stale editor draft", expectedRevision: beforeRemoteEdit.local_revision,
  }), /document_revision_conflict/, "real remote changes must still reject stale editor writes");

  const deferred = () => {
    let resolve;
    const promise = new Promise(complete => { resolve = complete; });
    return { promise, resolve };
  };
  const uploads = Array.from({ length: 3 }, () => {
    const imageId = crypto.randomUUID();
    const key = `u/test-user/${imageId.replaceAll("-", "")}.png`;
    sqlite.prepare(`INSERT INTO offline_images
      (account_id, image_id, content_type, base64_data, byte_size, created_at, is_local_origin)
      VALUES ('account-1', ?, 'image/png', 'Y292ZXI=', 5, ?, 1)`).run(imageId, new Date().toISOString());
    return {
      imageId, key, localURL: `koinote-local-image://${imageId}`,
      remoteURL: `https://img.koinote.app/${key}`, response: deferred(), started: deferred(), recorded: deferred(),
    };
  });
  const imageBody = uploads.map(upload => `![](${upload.localURL})`).join("\n\n");
  const multiImage = (await store.desktopCreateDocument({ title: "Three uploads", content: imageBody })).document;
  const multiSent = rowFor("account-1", multiImage.docId);
  let uploadCount = 0;
  harness.fetch = async (url, init) => {
    assert.equal(url, "/api/images");
    assert.equal(init.method, "POST");
    const upload = uploads[uploadCount++];
    upload.started.resolve();
    await upload.response.promise;
    return Response.json({ image: { key: upload.key, url: upload.remoteURL } });
  };
  const saveStarted = deferred();
  const saveGate = deferred();
  harness.beforeExecute = async (sql, values) => {
    if (sql.includes("local_revision = local_revision + 1") && values[1] === multiImage.docId) {
      saveStarted.resolve();
      await saveGate.promise;
    }
    if (sql.includes("SET object_key = $3, remote_url = $4")) {
      uploads.find(upload => upload.imageId === values[1]).recorded.resolve();
    }
  };
  const preparing = store.prepareDocumentContentForRemote("account-1", imageBody);
  await Promise.all(uploads.map(upload => upload.started.promise));
  const saving = store.desktopUpdateDocument(multiImage.docId, {
    ...multiImage, content: `${imageBody}\n\nTyping during three uploads`,
    coverImageSource: uploads[0].localURL, expectedRevision: multiImage.revision,
  });
  await saveStarted.promise;
  for (const upload of uploads.toReversed()) upload.response.resolve();
  await Promise.all(uploads.map(upload => upload.recorded.promise));
  await new Promise(resolve => setImmediate(resolve));
  saveGate.resolve();
  const [mappedBody, savedDuringUpload] = await Promise.all([preparing, saving]);
  harness.beforeExecute = async () => {};
  assert.equal(uploadCount, 3);
  assert.equal(rowFor("account-1", multiImage.docId).content, `${mappedBody}\n\nTyping during three uploads`, "an in-flight local save must not restore placeholders after concurrent uploads");
  assert.equal(rowFor("account-1", multiImage.docId).cover_image_source, uploads[0].remoteURL);
  const staleImageSave = await store.desktopUpdateDocument(multiImage.docId, {
    ...multiImage, content: `${imageBody}\n\nKeep typing with an older image snapshot`,
    coverImageSource: uploads[0].localURL, expectedRevision: savedDuringUpload.document.revision,
  });
  assert.equal(staleImageSave.document.content, `${mappedBody}\n\nKeep typing with an older image snapshot`, "a queued snapshot must reuse completed uploads without another network request");
  assert.equal(staleImageSave.document.coverImageSource, uploads[0].remoteURL);
  assert.equal(uploadCount, 3);
  await store.acknowledgeDocument("account-1", multiSent, { ...multiImage, content: mappedBody });
  const afterMultiAck = rowFor("account-1", multiImage.docId);
  assert.equal(afterMultiAck.content, staleImageSave.document.content);
  assert.equal(afterMultiAck.local_revision, staleImageSave.document.revision);
  assert.equal(afterMultiAck.base_revision, multiImage.revision, "later local edits must build on the acknowledged cloud revision");
  assert.equal(afterMultiAck.sync_state, "update");
  console.log("offline cover SQLite and migration checks passed");
} finally {
  globalThis.window = originalWindow;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  delete globalThis.__offlineCoverTest;
  sqlite.close();
}
