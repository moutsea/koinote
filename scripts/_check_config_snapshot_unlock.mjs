import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { parseHTML } from "linkedom";

const require = createRequire(import.meta.url);
const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
document.oninput = null;
// Linkedom omits the textarea defaultValue reflection React uses on mount.
Object.defineProperty(window.HTMLTextAreaElement.prototype, "defaultValue", {
  get() { return this.textContent; }, set(value) { this.textContent = value; }, configurable: true,
});
const calls = { reads: [], restores: [], updates: [], deletes: [], creates: [], grants: [], revocations: [] };
const clipboard = [];
let userGesture = false;
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Node.js", clipboard: { writeText: async text => clipboard.push(text) } }, configurable: true });
const snapshots = new Map();
let selectedFiles = [{ path: ".gitconfig", bytes: new TextEncoder().encode("updated git") }];
globalThis.__configUnlockTest = {
  desktop: true,
  labels: null,
  list: () => ({ snapshots: [...snapshots.values()] }),
  get: async (id) => { calls.reads.push(id); return { snapshot: snapshots.get(id) }; },
  update: async (id, input) => {
    assert.equal(input.revision, snapshots.get(id).revision);
    calls.updates.push({ id, input });
    const snapshot = { ...snapshots.get(id), ...input, revision: input.revision + 1 };
    snapshots.set(id, snapshot);
    return { snapshot };
  },
  create: async (input) => {
    calls.creates.push(input);
    const snapshot = { id: `created-${calls.creates.length}`, revision: 1, ...input };
    snapshots.set(snapshot.id, snapshot);
    return { snapshot };
  },
  restore: async (files, destination) => { calls.restores.push({ files, destination }); return files.length; },
  pick: async () => selectedFiles,
  grant: async (id, revision) => {
    assert.equal(revision, snapshots.get(id).revision);
    calls.grants.push({id, revision});
    return { snapshotId: id, revision, token: "test-config-sync-token", expiresAt: "2026-10-09T10:30:00Z", mcpUrl: "https://example.test/api/config-sync/mcp", downloadUrl: "https://example.test/api/config-sync/envelope" };
  },
  revoke: async id => { calls.revocations.push(id); return { success: true }; },
  scanCalls: 0,
  delete: async (id) => { calls.deletes.push(id); snapshots.delete(id); return { success: true }; },
};
const bundle = await build({
  stdin: {
    contents: `export { createElement, act } from "react";
      export { createRoot } from "react-dom/client";
      export { QueryClient, QueryClientProvider } from "@tanstack/react-query";
      export { ConfigSnapshotsCard } from "./spa/src/components/ConfigSnapshotsCard";
      export { encryptConfigSnapshot, decryptConfigSnapshot } from "./spa/src/configVaultCrypto";
      export { configGroupKey } from "./spa/src/configVaultGroups";
      export { zh } from "./spa/src/i18n/zh";`,
    resolveDir: process.cwd(),
  },
  bundle: true, format: "esm", platform: "node", write: false, jsx: "automatic",
  plugins: [{ name: "config-unlock-adapters", setup(builder) {
    const adapters = {
      "lucide-react": "const Icon = () => null; export const Copy = Icon; export const FolderSync = Icon; export const Archive = Icon; export const Check = Icon; export const ChevronDown = Icon; export const ChevronRight = Icon; export const Download = Icon; export const Eye = Icon; export const FileText = Icon; export const Files = Icon; export const Folder = Icon; export const FolderOpen = Icon; export const KeyRound = Icon; export const LoaderCircle = Icon; export const ScanLine = Icon; export const ShieldCheck = Icon; export const Trash2 = Icon; export const Upload = Icon; export const X = Icon;",
      "../api": `const test = globalThis.__configUnlockTest;
        export class ApiError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
        export const getConfigSnapshots = test.list;
        export const revokeConfigSyncGrants = test.revoke;
        export const getConfigSnapshot = test.get; export const createConfigSyncGrant = (...args) => test.grant(...args);
        export const updateConfigSnapshot = test.update;
        export const createConfigSnapshot = test.create;
        export const deleteConfigSnapshot = async (id) => test.delete(id);`,
      "../desktop/runtime": "export const isDesktopRuntime = () => globalThis.__configUnlockTest.desktop;",
      "../desktop/configFiles": `const test = globalThis.__configUnlockTest;
        export const desktopRestoreConfigFilesToHome = files => test.restore(files, "home");
        export const desktopRestoreConfigFiles = files => test.restore(files, "folder");
        export const desktopPickConfigFiles = test.pick;
        export const desktopScanConfigFiles = async () => { test.scanCalls += 1; return test.pick(); };`,
      "../confirmAction": "export const confirmAction = async () => true;",
      "../i18n": "export const useI18n = () => ({ t: globalThis.__configUnlockTest.labels, locale: 'zh' }); export const interpolate = (template, vars) => template.replace(/\\{(\\w+)\\}/g, (_, key) => key in vars ? String(vars[key]) : `{${key}}`);",
      "./StorageCard": 'export const STORAGE_USAGE_KEY = ["storage-usage"];',
    };
    builder.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(adapters, path) ? { path, namespace: "config-unlock" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "config-unlock" }, ({ path }) => ({ contents: adapters[path] }));
    builder.onResolve({ filter: /^(?:react(?:-dom)?(?:\/|$)|@tanstack\/react-query$)/ }, ({ path }) => ({ path: pathToFileURL(require.resolve(path)).href, external: true }));
  } }],
});
const { createElement, act, createRoot, QueryClient, QueryClientProvider, ConfigSnapshotsCard, encryptConfigSnapshot, decryptConfigSnapshot, configGroupKey, zh } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
for (const path of [".dsh/settings.yaml", ".dsh/.credentials.yaml", ".dsh/.env", ".dsh/cordis.patch.yml", ".dsh/profiles/web/package.json", ".dsh\\profiles\\web\\cordis.patch.yml"]) {
  assert.equal(configGroupKey(path), "coding-agents", path);
}
assert.equal(configGroupKey(".dsh-other/settings.yaml"), "config");
assert.ok(zh.space.cloneCategories[3].includes("DeepSeek Harness"));
globalThis.__configUnlockTest.labels = zh;
const firstPassword = "snapshot-one-password";
const secondPassword = "snapshot-two-password";
const original = [
  { path: ".gitconfig", bytes: new TextEncoder().encode("original git") },
  { path: ".config/git/work.conf", bytes: new TextEncoder().encode("cloud-only git") },
  { path: ".ssh/config", bytes: new TextEncoder().encode("ssh config") },
];
for (const [id, password] of [["first", firstPassword], ["second", secondPassword]]) {
  const encrypted = await encryptConfigSnapshot(original, password);
  snapshots.set(id, { id, name: id, revision: 1, updatedAt: "2026-09-30T00:00:00Z", ...encrypted });
}
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
client.setQueryData(["config-snapshots"], globalThis.__configUnlockTest.list());
const root = createRoot(document.getElementById("root"));
const dialog = () => document.querySelector('[role="dialog"]');
const click = async (label, index = 0) => {
  const button = [...document.querySelectorAll("button")].filter((item) => item.textContent === label)[index];
  assert.ok(button, `button exists: ${label}`);
  assert.equal(button.disabled, false);
  await act(async () => { userGesture = true; try { button.click(); } finally { userGesture = false; } });
};
const submit = async (password) => {
  const input = dialog().querySelector('input[type="password"]');
  await act(async () => {
    const previous = input.value;
    input.value = password;
    input._valueTracker?.setValue(previous);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    userGesture = true;
    try { dialog().querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); }
    finally { userGesture = false; }
  });
};
const setInput = async (input, value) => {
  await act(async () => {
    const previous = input.value;
    input.value = value;
    input._valueTracker?.setValue(previous);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
};
const togglePath = async (path) => {
  const input = document.querySelector(`input[aria-label="选择 ${path}"]`);
  assert.ok(input, `selection exists: ${path}`);
  await act(async () => {
    input.checked = !input.checked;
    input.click();
  });
};
async function waitUntil(predicate, description) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  assert.fail(description);
}
async function settle() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (!dialog() || dialog().getAttribute("aria-busy") !== "true") return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  assert.fail("Snapshot action did not settle");
}

try {
  await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(ConfigSnapshotsCard, { member: true }))));
  assert.equal(document.querySelector('input[type="password"]'), null, "no persistent password field");
  await click("展开并解锁");
  assert.ok(dialog().textContent.includes("first"));
  assert.equal(calls.reads.length, 0, "clicking only opens the prompt");
  await click(zh.space.syncCancel);
  assert.equal(dialog(), null);
  assert.equal(calls.reads.length, 0, "cancel does not fetch or decrypt");

  await click("展开并解锁");
  await submit("");
  assert.ok(dialog().querySelector('[role="alert"]'));
  assert.equal(calls.reads.length, 0, "empty password does not reach the API");
  await submit("wrong-password");
  await settle();
  assert.equal(dialog().querySelector('[role="alert"]').textContent, zh.space.syncUnlockFailed);
  assert.equal(document.querySelectorAll("button").length > 0, true);
  await submit(firstPassword);
  await settle();
  assert.equal(dialog(), null, "valid password resumes expansion");
  assert.ok(document.body.textContent.includes(".gitconfig"));
  assert.equal(document.querySelector('input[type="password"]'), null);
  const viewFile = document.querySelector('button[aria-label="查看 .gitconfig"]');
  assert.ok(viewFile, "file preview button exists");
  await act(async () => viewFile.click());
  assert.ok(document.body.textContent.includes("original git"), "file contents are previewed after unlock");
  const closePreview = document.querySelector('button[aria-label="关闭文件预览"]');
  assert.ok(closePreview, "file preview close button exists");
  await act(async () => closePreview.click());

  const readsBeforeRestore = calls.reads.length;
  await click("全部同步到本机");
  assert.equal(dialog(), null, "sync first opens a choice menu, not a password prompt");
  await click(zh.space.configSnapshots.syncWithKoinote);
  assert.equal(dialog(), null, "unlocked revision does not ask for its password again");
  assert.equal(calls.reads.length, readsBeforeRestore, "cached restore only checks metadata");
  assert.equal(calls.restores.length, 1);
  assert.equal(calls.restores[0].destination, "home");
  assert.equal(calls.restores[0].files.length, 3);

  await click("同步到本机");
  assert.equal(dialog(), null);
  assert.deepEqual(calls.restores[1].files.map((file) => file.path).sort(), [".config/git/work.conf", ".gitconfig"], "group restore stays scoped");

  await click("全部同步到本机");
  assert.ok(document.body.textContent.includes(zh.space.configSnapshots.agentSecretHint));
  await click(zh.space.configSnapshots.syncWithAgent);
  assert.equal(dialog(), null, "copying for an agent reuses the unlocked snapshot key");
  assert.deepEqual(calls.grants, [{id: "first", revision: 1}]);
  const instructions = clipboard.at(-1);
  assert.ok(instructions.includes("https://example.test/api/config-sync/mcp"));
  assert.ok(instructions.includes("Authorization: Bearer test-config-sync-token"));
  assert.ok(!instructions.includes(firstPassword) && !instructions.includes(secondPassword), "migration passwords never enter the clipboard");
  assert.ok(!instructions.includes("original git") && !instructions.includes("ssh config"), "configuration plaintext is not embedded in the instructions");
  const keyBase64 = instructions.match(/Snapshot decryption key \(base64 AES-256, secret\): (\S+)/)[1];
  const envelope = JSON.parse(snapshots.get("first").envelope);
  const key = await crypto.subtle.importKey("raw", Buffer.from(keyBase64, "base64"), "AES-GCM", false, ["decrypt"]);
  const archive = await crypto.subtle.decrypt({name:"AES-GCM", iv:Buffer.from(envelope.iv, "base64")}, key, Buffer.from(envelope.ciphertext, "base64"));
  assert.equal(new Uint8Array(archive)[0], 0x50, "copied snapshot key decrypts the original ZIP");
  const otherEnvelope = JSON.parse(snapshots.get("second").envelope);
  await assert.rejects(() => crypto.subtle.decrypt({name:"AES-GCM", iv:Buffer.from(otherEnvelope.iv, "base64")}, key, Buffer.from(otherEnvelope.ciphertext, "base64")), "snapshot key cannot decrypt another snapshot");
  await click("收起配置"); await click("展开并解锁");
  assert.equal(dialog(), null, "collapsing does not discard the page-local unlock");

  await click("选择目录", 1);
  assert.ok(dialog().textContent.includes("second"));
  assert.equal(dialog().querySelector("input").value, "");
  await submit(firstPassword);
  await settle();
  assert.equal(calls.restores.length, 2, "passwords stay isolated between snapshots");
  await submit(secondPassword);
  await settle();
  assert.equal(calls.restores[2].destination, "folder");

  assert.ok(document.body.textContent.includes(zh.space.configSnapshots.crossPlatformHint));
  const restoreBeforeError = globalThis.__configUnlockTest.restore;
  for (const [code, message] of [
    ["config_platform_path_unsupported", zh.space.configSnapshots.errorPlatformUnsupported],
    ["config_platform_location_unsupported", zh.space.configSnapshots.errorPlatformUnsupported],
    ["config_platform_path_conflict", zh.space.configSnapshots.errorPlatformConflict],
  ]) {
    globalThis.__configUnlockTest.restore = async () => { throw code; };
    await click("全部同步到本机");
    await click(zh.space.configSnapshots.syncWithKoinote);
    assert.equal(dialog(), null);
    assert.ok(document.body.textContent.includes(message));
    assert.equal(calls.restores.length, 3, "mapping failure does not write files");
  }
  globalThis.__configUnlockTest.restore = restoreBeforeError;

  snapshots.set("first", { ...snapshots.get("first"), revision: 2 });
  await click("全部同步到本机");
  await click(zh.space.configSnapshots.syncWithKoinote);
  assert.equal(calls.restores.length, 3, "a changed cloud revision cannot restore cached plaintext");
  assert.ok(document.body.textContent.includes(zh.space.configSnapshots.errorConflict));
  await act(async () => client.setQueryData(["config-snapshots"], globalThis.__configUnlockTest.list()));
  await click("全部同步到本机");
  await click(zh.space.configSnapshots.syncWithAgent);
  assert.ok(dialog(), "a changed revision requires unlocking again for the agent too");
  await click(zh.space.syncCancel);
  await click("收起配置");
  await click("展开并解锁");
  await submit(firstPassword);
  await settle();

  await click("从本机更新");
  assert.equal(globalThis.__configUnlockTest.scanCalls, 1, "desktop group update scans automatically");
  await submit(secondPassword);
  await settle();
  assert.equal(calls.updates.length, 0, "wrong password cannot re-encrypt a snapshot");
  await submit(firstPassword);
  await settle();
  assert.equal(calls.updates.length, 1);
  const updated = await decryptConfigSnapshot(snapshots.get("first").envelope, firstPassword);
  assert.equal(new TextDecoder().decode(updated.find((file) => file.path === ".gitconfig").bytes), "updated git");
  assert.equal(new TextDecoder().decode(updated.find((file) => file.path === ".config/git/work.conf").bytes), "cloud-only git", "group update preserves cloud-only files within the same category");
  assert.equal(new TextDecoder().decode(updated.find((file) => file.path === ".ssh/config").bytes), "ssh config");
  await assert.rejects(() => decryptConfigSnapshot(snapshots.get("first").envelope, secondPassword), /config_password_incorrect/);
  const deleteDirectory = [...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "删除 .ssh");
  assert.ok(deleteDirectory, "directory delete button exists");
  await act(async () => deleteDirectory.click());
  await submit(firstPassword);
  await settle();
  assert.equal(calls.updates.length, 2, "deleting a directory re-encrypts the snapshot");
  const afterDelete = await decryptConfigSnapshot(snapshots.get("first").envelope, firstPassword);
  assert.deepEqual(afterDelete.map((file) => file.path).sort(), [".config/git/work.conf", ".gitconfig"], "directory deletion removes descendants only");
  await act(async () => root.render(null));
  snapshots.clear();
  const previousFiles = [
    { path: ".ssh/config", bytes: new TextEncoder().encode("old host") },
    { path: ".ssh/id_ed25519", bytes: new TextEncoder().encode("old key") },
    { path: ".gitconfig", bytes: new TextEncoder().encode("old git") },
    { path: ".codex/prompts/system.md", bytes: new TextEncoder().encode("private prompt") },
  ];
  snapshots.set("free", { id: "free", name: "free", revision: 1, ...await encryptConfigSnapshot(previousFiles, firstPassword) });
  selectedFiles = [
    { path: ".ssh/config", bytes: new TextEncoder().encode("new host") },
    { path: ".ssh/id_ed25519", bytes: new TextEncoder().encode("new key") },
    { path: ".ssh/work/config", bytes: new TextEncoder().encode("work host") },
    { path: ".gitconfig", bytes: new TextEncoder().encode("new git") },
  ];
  const renderSync = async (member) => {
    client.setQueryData(["config-snapshots"], globalThis.__configUnlockTest.list());
    await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(ConfigSnapshotsCard, { member, syncOpen: true }))));
    for (const input of document.querySelectorAll('input[type="password"]')) await setInput(input, firstPassword);
  };
  await renderSync(false);
  await click(zh.space.syncScan);
  assert.equal(dialog().getAttribute("aria-labelledby"), "config-sync-review-title");
  assert.equal(document.querySelector('input[aria-label="选择 .ssh/config"]'), null, "directory starts collapsed");
  await click(zh.space.syncReviewClearAll);
  assert.equal([...dialog().querySelectorAll("button")].find((button) => button.textContent === zh.space.syncReviewUpload).disabled, true);
  await togglePath(".ssh");
  assert.equal(dialog().textContent.includes("3 个文件"), true, "directory selection includes nested files");
  await act(async () => document.querySelector('button[aria-label="展开 .ssh"]').click());
  await togglePath(".ssh/id_ed25519");
  assert.equal(document.querySelector('input[aria-label="选择 .ssh"]').indeterminate, true, "parent becomes partially selected");
  await togglePath(".ssh/work");
  assert.equal(dialog().textContent.includes("1 个文件"), true, "deselecting a nested directory updates count");
  assert.equal(dialog().textContent.includes("明文大小 8 B"), true, "size includes selected bytes only");
  const updatesBeforeUpload = calls.updates.length;
  await click(zh.space.syncReviewUpload);
  await waitUntil(() => calls.updates.length === updatesBeforeUpload + 1, "free snapshot upload did not finish");
  const freeFiles = await decryptConfigSnapshot(snapshots.get("free").envelope, firstPassword);
  assert.deepEqual(freeFiles.map((file) => file.path).sort(), [".gitconfig", ".ssh/config", ".ssh/id_ed25519"]);
  assert.equal(new TextDecoder().decode(freeFiles.find((file) => file.path === ".ssh/config").bytes), "new host");
  assert.equal(new TextDecoder().decode(freeFiles.find((file) => file.path === ".ssh/id_ed25519").bytes), "old key", "unselected cloud file is preserved within the same group");
  assert.equal(new TextDecoder().decode(freeFiles.find((file) => file.path === ".gitconfig").bytes), "old git", "unselected group is preserved");
  await act(async () => root.render(null));
  await renderSync(true);
  await click(zh.space.syncManual);
  assert.equal(dialog().getAttribute("aria-labelledby"), "config-sync-review-title", "manual desktop selection opens the tree preview");
  await click(zh.space.syncReviewClearAll);
  await togglePath(".gitconfig");
  await click(zh.space.syncReviewUpload);
  await waitUntil(() => calls.creates.length === 1, "member snapshot upload did not finish");
  const createdFiles = await decryptConfigSnapshot(calls.creates[0].envelope, firstPassword);
  assert.deepEqual(createdFiles.map((file) => file.path), [".gitconfig"], "only selected files reach encrypted upload");
  await act(async () => root.render(null));
  globalThis.__configUnlockTest.desktop = false;
  await renderSync(true);
  await click(zh.space.syncManual);
  const fileInput = document.querySelector('input[type="file"]');
  Object.defineProperty(fileInput, "files", { configurable: true, value: [
    { name: ".npmrc", arrayBuffer: async () => new TextEncoder().encode("registry=test").buffer },
    { name: ".yarnrc", arrayBuffer: async () => new TextEncoder().encode("yarn=test").buffer },
  ] });
  await act(async () => fileInput.dispatchEvent(new window.Event("change", { bubbles: true })));
  assert.equal(dialog().getAttribute("aria-labelledby"), "config-sync-review-title", "manual web selection opens the tree preview");
  await click(zh.space.syncReviewClearAll);
  await togglePath(".npmrc");
  await click(zh.space.syncReviewUpload);
  await waitUntil(() => calls.creates.length === 2, "web snapshot upload did not finish");
  const webFiles = await decryptConfigSnapshot(calls.creates[1].envelope, firstPassword);
  assert.deepEqual(webFiles.map((file) => file.path), [".npmrc"]);
  console.log("config snapshot upload: directory selection, partial selection, counts, sizes, Agent-file separation, free snapshot merge and desktop/web manual previews passed");
  await act(async () => root.render(null));
  await act(async () => client.setQueryData(["config-snapshots"], globalThis.__configUnlockTest.list()));
  await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(ConfigSnapshotsCard, { member: true }))));
  await click("全部同步到本机");
  await click(zh.space.configSnapshots.syncWithAgent);
  assert.ok(dialog().querySelector('input[type="password"]'), "leaving the page discards unlock keys");
  await click(zh.space.syncCancel);
  // The detail response can advance while the initial list is still cached.
  await act(async () => root.render(null));
  globalThis.__configUnlockTest.desktop = true;
  snapshots.clear();
  snapshots.set("fresh", { id: "fresh", name: "fresh", revision: 1, ...await encryptConfigSnapshot(original, firstPassword) });
  await act(async () => client.setQueryData(["config-snapshots"], globalThis.__configUnlockTest.list()));
  await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(ConfigSnapshotsCard, { member: true }))));
  snapshots.set("fresh", { ...snapshots.get("fresh"), revision: 2 });
  await click("展开并解锁"); await submit(firstPassword); await settle();
  assert.equal(client.getQueryData(["config-snapshots"]).snapshots[0].revision, 2, "unlock refreshes stale list metadata");
  assert.ok(!("envelope" in client.getQueryData(["config-snapshots"]).snapshots[0]), "detail contents are not cached in the list");
  await click("全部同步到本机"); await click(zh.space.configSnapshots.syncWithKoinote);
  assert.equal(dialog(), null, "freshly unlocked detail never prompts again due to a stale list");

  globalThis.ClipboardItem = class { constructor(data) { this.data = data; } };
  let clipboardStarts = 0;
  navigator.clipboard.write = async (items) => {
    assert.equal(userGesture, true, "clipboard.write starts inside the original click or submit event");
    clipboardStarts++;
    clipboard.push(await (await items[0].data["text/plain"]).text());
  };
  const grantBeforeDelay = globalThis.__configUnlockTest.grant;
  let finishGrant;
  const grantWait = new Promise(resolve => { finishGrant = resolve; });
  globalThis.__configUnlockTest.grant = async (...args) => { await grantWait; return grantBeforeDelay(...args); };
  const grantsBeforeDelay = calls.grants.length;
  await click("全部同步到本机"); await click(zh.space.configSnapshots.syncWithAgent);
  assert.equal(clipboardStarts, 1, "clipboard write is initiated before grant preparation finishes");
  assert.equal(calls.grants.length, grantsBeforeDelay);
  await act(async () => finishGrant());
  await waitUntil(() => document.body.textContent.includes(zh.space.configSnapshots.agentCopied), "deferred clipboard did not finish");
  globalThis.__configUnlockTest.grant = grantBeforeDelay;

  // Permission denial keeps the same prepared grant for a fresh gesture retry.
  navigator.clipboard.write = async () => { throw new DOMException("denied", "NotAllowedError"); };
  await click("全部同步到本机"); await click(zh.space.configSnapshots.syncWithAgent);
  assert.equal(dialog().getAttribute("aria-labelledby"), "agent-copy-title");
  const grantsBeforeRetry = calls.grants.length;
  navigator.clipboard.writeText = async () => { throw new DOMException("denied", "NotAllowedError"); };
  await click(zh.space.configSnapshots.syncWithAgent);
  assert.equal(dialog().querySelector('[role="alert"]').textContent, zh.space.configSnapshots.agentCopyFailed);
  navigator.clipboard.writeText = async text => { assert.equal(userGesture, true); clipboard.push(text); };
  await click(zh.space.configSnapshots.syncWithAgent);
  assert.equal(dialog(), null);
  assert.equal(calls.grants.length, grantsBeforeRetry, "clipboard retries never mint more credentials");

  // Non-secure HTTP contexts have no clipboard API; prepared instructions remain
  // available for manual selection and repeated clicks never mint another grant.
  const workingClipboard = navigator.clipboard;
  navigator.clipboard = undefined;
  await click("全部同步到本机"); await click(zh.space.configSnapshots.syncWithAgent);
  const manualText = dialog().querySelector("textarea");
  assert.ok(manualText.value.includes("Authorization: Bearer test-config-sync-token"));
  assert.equal(manualText.getAttribute("readOnly"), "");
  const grantsBeforeManual = calls.grants.length;
  await click(zh.space.configSnapshots.syncWithAgent);
  assert.equal(calls.grants.length, grantsBeforeManual);
  assert.equal(dialog().querySelector("textarea").value, manualText.value);
  await click(zh.space.syncCancel);
  navigator.clipboard = workingClipboard;
  await click(zh.space.configSnapshots.revokeAgentAccess);
  assert.deepEqual(calls.revocations, ["fresh"]);
  assert.ok(document.body.textContent.includes(zh.space.configSnapshots.agentAccessRevoked));

  // Password entry also initiates the deferred write before asynchronous decrypt.
  await act(async () => root.render(null));
  await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(ConfigSnapshotsCard, { member: true }))));
  navigator.clipboard.write = async items => {
    assert.equal(userGesture, true);
    clipboardStarts++;
    clipboard.push(await (await items[0].data["text/plain"]).text());
  };
  await click("全部同步到本机"); await click(zh.space.configSnapshots.syncWithAgent);
  assert.ok(dialog().querySelector('input[type="password"]'));
  await submit(firstPassword);
  assert.equal(clipboardStarts, 2, "password submit starts writing synchronously");
  await settle();
  assert.equal(dialog(), null);

  // A late network response after leaving the page must not replace clipboard data.
  const clipboardBeforeLeaving = clipboard.length;
  let finishLateGrant;
  const lateWait = new Promise(resolve => { finishLateGrant = resolve; });
  globalThis.__configUnlockTest.grant = async (...args) => { await lateWait; return grantBeforeDelay(...args); };
  await click("全部同步到本机"); await click(zh.space.configSnapshots.syncWithAgent);
  await act(async () => root.render(null));
  await act(async () => finishLateGrant());
  assert.equal(clipboard.length, clipboardBeforeLeaving);
  delete globalThis.ClipboardItem;
  console.log("config snapshot unlock: revision reuse, gesture-bound copy, credential-free retries and page-exit cancellation passed");
} finally {
  await act(async () => root.unmount());
  client.clear();
  delete globalThis.__configUnlockTest;
  stop();
}

process.exit(0);
