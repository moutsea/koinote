import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const require = createRequire(import.meta.url);
const { QueryClient, QueryClientProvider } = require("@tanstack/react-query");
const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
// Exercise the browser reader boundary with real File bytes.
globalThis.FileReader = class {
  readAsDataURL(file) {
    file.arrayBuffer().then((bytes) => { this.result = `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`; this.onload(); }, () => this.onerror());
  }
};
const state = globalThis.__koiSkillsTest = {};
const directory = await mkdtemp(join(process.cwd(), "scripts/.koi-skills-test-"));
let root, client;
try {
  const outfile = join(directory, "skills.cjs");
  await build({
    stdin: { contents: 'export {KoiSkillLibrary} from "./spa/src/components/KoiSkillLibrary";export {KoiInstallDialog} from "./spa/src/components/KoiInstallDialog";export {zh} from "./spa/src/i18n/zh";export {ApiError} from "./spa/src/api";', resolveDir: process.cwd(), loader: "tsx" },
    outfile, bundle: true, platform: "node", format: "cjs", packages: "external", jsx: "automatic", logLevel: "silent",
    plugins: [{ name: "skills-host", setup(builder) {
      const hosts = {
        api: 'export const apiJson=(...args)=>globalThis.__koiSkillsTest.api(...args);export class ApiError extends Error{constructor(status,message,code){super(message);this.status=status;this.code=code;}};',
        i18n: 'export const useI18n=()=>globalThis.__koiSkillsTest.i18n;',
        confirmation: 'export const confirmAction=async()=>true;',
      };
      for (const [filter, path] of [[/(^|\/)api$/, "api"], [/(^|\/)i18n$/, "i18n"], [/(^|\/)confirmAction$/, "confirmation"]]) builder.onResolve({ filter }, () => ({ path, namespace: "skills-host" }));
      builder.onLoad({ filter: /.*/, namespace: "skills-host" }, ({ path }) => ({ contents: hosts[path], loader: "js" }));
    } }],
  });
  const { KoiSkillLibrary, KoiInstallDialog, zh, ApiError } = require(outfile);
  const labels = zh.koi;
  state.i18n = { t: zh, locale: "zh" };
  let user = { id: 1, authUserId: "skills-one", membershipTier: "lifetime" };
  let available = false, canInstall = true, settings = { autoSkills: true, revision: 1 };
  let skills = [], preview, createInput, rejectNextToggle = true, loseConfirmation = true;
  let saveDelay, rejectRemote = false;
  const calls = [], uploads = [];
  const candidate = { id: "candidate-review", name: "review", description: "检查文章结构", entryPath: "SKILL.md", directory: "review", fileCount: 2, sizeBytes: 100, instructions: "# Review\nRead guide.md.", compatibility: { conversation: true, article: false, reasons: [] }, metadataFormat: "plain-markdown" };
  const installed = { ...candidate, id: "installation-review", versionId: "version-one", version: "123456abcdef", contentSha256: "1".repeat(64), sourceKind: "folder", source: { directoryName: "collection" }, enabled: true, revision: 1, installedAt: "2026-11-11T00:00:00Z", updatedAt: "2026-11-11T00:00:00Z", license: "" };
  state.api = async (path, init = {}) => {
    const method = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    const url = new URL(path, "https://koinote.test");
    if (url.pathname === "/api/koi/settings") {
      if (method === "PUT") {
        if (saveDelay) await saveDelay;
        assert.equal(body.expectedRevision, settings.revision);
        settings = { autoSkills: body.autoSkills, revision: settings.revision + 1 };
        return { settings: { ...settings } };
      }
      return { managementAvailable: available, canInstall, settings: { ...settings } };
    }
    if (url.pathname === "/api/koi/skills") {
      const filtered = skills.filter((skill) => (!url.searchParams.get("q") || skill.name.includes(url.searchParams.get("q"))) && (!url.searchParams.get("state") || (skill.enabled ? "enabled" : "disabled") === url.searchParams.get("state")));
      return { skills: filtered.map((item) => ({ ...item })), nextCursor: "", storage: { usedBytes: skills.length * 100 } };
    }
    if (url.pathname === "/api/koi/skill-imports" && method === "POST") {
      createInput = body;
      if (body.source !== "folder" && rejectRemote) throw new ApiError(403, "access denied", "github_token_required");
      preview = { id: "preview-one", status: "pending", revision: 1, sourceKind: "folder", source: {}, candidates: [], rejected: [], uploadedFiles: 0, rejectedFiles: 0, declaredFiles: body.declaredPaths?.length ?? 0, expiresAt: "2099-01-01T00:00:00Z" };
      if (body.source !== "folder") preview = { ...preview, status: "ready", revision: 2, sourceKind: body.source, source: { kind: body.source, repositoryUrl: body.repositoryUrl, ref: "main", commitSha: "a".repeat(40), name: "Hub review" }, candidates: [candidate] };
      return { preview: { ...preview } };
    }
    if (url.pathname === "/api/koi/skill-imports/preview-one/files") {
      assert.equal(body.path, undefined, "member paths belong in the query, not the upload body");
      const member = url.searchParams.get("path");
      uploads.push({ path: member, content: Buffer.from(body.contentBase64, "base64").toString() });
      if (member === "bad/guide.md") throw new ApiError(422, "sensitive", "sensitive_data_detected");
      return { path: member };
    }
    if (url.pathname.endsWith("/analyze")) {
      assert.equal(uploads.length % createInput.declaredPaths.length, 0, "a rejected member must not stop sibling uploads");
      preview = { ...preview, status: "ready", revision: 2, candidates: [candidate], rejected: [{ entryPath: "bad/SKILL.md", directory: "bad", reason: "sensitive_data_detected", details: ["sensitive_data_detected:bad/guide.md"] }] };
      if (createInput.updateFromId) preview.candidates = [{ ...candidate, installedStatus: "update", installedId: skills[0].id, previousVersion: skills[0].version, previousSizeBytes: 100 }];
      return { preview: { ...preview } };
    }
    if (url.pathname.endsWith("/confirm")) {
      assert.equal(body.previewRevision, 2);
      assert.deepEqual(body.candidateIds, [candidate.id]);
      skills = createInput.updateFromId ? [{ ...skills[0], versionId: "version-two", revision: skills[0].revision + 1 }] : [{ ...installed, sourceKind: createInput.source, source: { ...preview.source }, enabled: body.enable }];
      preview = { ...preview, status: "committed", candidates: [], installed: skills };
      if (loseConfirmation) { loseConfirmation = false; throw new Error("response lost"); }
      return { installed: skills };
    }
    if (url.pathname === "/api/koi/skill-imports/preview-one") {
      if (method === "DELETE") return { status: "cancelled" };
      return { preview: { ...preview } };
    }
    if (url.pathname.endsWith("/check-update")) return { status: "update_available", preview: { ...preview, id: "preview-one", status: "ready", revision: 2, sourceKind: "github", candidates: [{ ...candidate, installedStatus: "update", installedId: skills[0].id, previousVersion: skills[0].version, previousSizeBytes: 100 }] } };
    if (url.pathname === "/api/koi/skills/installation-review/files/2") {
      assert.equal(url.searchParams.get("version"), "version-one", "file preview pins the displayed version");
      return { file: { position: 2, path: "guide.md", sha256: "guide-hash" }, contentBase64: Buffer.from("结构说明：保持作者原意。").toString("base64") };
    }
    if (url.pathname === "/api/koi/skills/installation-review") {
      if (method === "GET" && !skills[0]) throw new ApiError(404, "missing", "not_found");
      if (method === "PATCH") {
        assert.equal(body.expectedRevision, skills[0].revision);
        skills[0] = { ...skills[0], enabled: body.enabled, revision: skills[0].revision + 1 };
        if (rejectNextToggle) { rejectNextToggle = false; throw new ApiError(409, "changed elsewhere", "revision_conflict"); }
        return { skill: { ...skills[0] } };
      }
      if (method === "DELETE") {
        assert.equal(Number(url.searchParams.get("expectedRevision")), skills[0].revision);
        skills = [];
        return { deleted: true, retainedBytes: 100 };
      }
      return { skill: { ...skills[0] }, instructions: candidate.instructions, files: [{ position: 1, path: "SKILL.md", sizeBytes: 50 }, { position: 2, path: "guide.md", sizeBytes: 50, sha256: "guide-hash" }] };
    }
    throw new Error(`Unexpected Skill request: ${method} ${path}`);
  };
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); }); };
  async function render() {
    await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(KoiSkillLibrary, { user, key: user.authUserId }))));
    await settle();
  }
  const propsOf = (element) => element[Object.keys(element).find((key) => key.startsWith("__reactProps$"))];
  async function click(text) {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === text);
    assert.ok(button, `Missing action: ${text}`);
    await act(async () => button.click());
    await settle();
  }
  async function change(element, target) { assert.ok(element); await act(async () => propsOf(element).onChange({ target, currentTarget: target })); await settle(); }
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createRoot(document.getElementById("root"));
  await render();
  assert.equal(document.body.textContent, "", "ordinary accounts do not see management controls");
  assert.equal(calls.some((call) => call.path.startsWith("/api/koi/skills?")), false);
  available = true;
  await act(async () => client.invalidateQueries({ queryKey: ["koi-settings", user.authUserId] }));
  await settle();
  assert.ok(document.body.textContent.includes(labels.emptySkills));
  const auto = () => document.querySelector(`input[aria-label="${labels.autoSkillsTitle}"]`);
  let resolveSave;
  saveDelay = new Promise((resolve) => { resolveSave = resolve; });
  await change(auto(), { checked: false });
  assert.equal(auto().disabled, true, "settings remain locked while the write is pending");
  assert.equal(auto().checked, false);
  await act(async () => resolveSave());
  saveDelay = undefined;
  await settle();
  assert.equal(auto().checked, false);

  await click(labels.installSkill);
  const files = [
    ["collection/review/SKILL.md", candidate.instructions], ["collection/review/guide.md", "Guide"],
    ["collection/bad/SKILL.md", "# Bad"], ["collection/bad/guide.md", "secret"],
    ["collection/private-notes.txt", "must stay local"], ["collection/.git/config", "must stay local"],
  ].map(([path, content]) => {
    const file = new File([content], path.split("/").at(-1));
    Object.defineProperty(file, "webkitRelativePath", { value: path });
    return file;
  });
  await change(document.querySelector('input[type="file"]'), { files, value: "folder" });
  assert.equal(uploads.length, 0, "choosing a folder does not upload bytes");
  assert.equal(document.querySelectorAll('input[name="folder-package"]').length, 2);
  await click(labels.uploadAndAnalyze);
  assert.deepEqual(createInput.declaredPaths.sort(), ["bad/SKILL.md", "bad/guide.md", "review/SKILL.md", "review/guide.md"]);
  assert.ok(document.body.textContent.includes(labels.rejectedTitle));
  assert.ok(document.body.textContent.includes(labels.reject_sensitive_data_detected));
  assert.equal(uploads.some((file) => file.content === "must stay local"), false);
  const enable = [...document.querySelectorAll('input[type="checkbox"]')].find((input) => input.parentElement.textContent === labels.enableAfterInstall);
  await change(enable, { checked: false });
  await click(labels.confirmInstall.replace("{count}", "1"));
  assert.equal(document.querySelector('[role="dialog"]'), null, "lost confirmation response recovers the committed receipt");
  assert.equal(calls.filter((call) => call.path.endsWith("/confirm")).length, 1);
  let skillSwitch = () => document.querySelector(`input[aria-label="${labels.enabledToggle} review"]`);
  assert.equal(skillSwitch().checked, false);
  await change(skillSwitch(), {});
  assert.equal(skillSwitch().checked, true, "conflicts refresh the current installation state");
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1, "conflicts do not replay writes automatically");
  await click("review");
  await click("guide.md50 B");
  assert.ok(document.body.textContent.includes("结构说明：保持作者原意。"));
  await click(labels.uploadNewVersion);
  await change(document.querySelector('input[type="file"]'), { files, value: "replacement" });
  assert.equal(document.querySelectorAll('input[name="folder-package"][type="radio"]').length, 2, "replacement accepts one package");
  uploads.length = 0;
  await click(labels.uploadAndAnalyze);
  assert.equal(createInput.updateFromId, installed.id);
  assert.equal(createInput.expectedRevision, skills[0].revision);
  assert.ok(document.body.textContent.includes(labels.existingKeepsState));
  assert.equal(document.body.textContent.includes(labels.enableAfterInstall), false);
  await click(labels.confirmUpdate);
  assert.equal(skills[0].id, installed.id);
  assert.equal(skills[0].versionId, "version-two");
  assert.equal(skills[0].enabled, true);
  await click(labels.uninstall);
  assert.ok(document.body.textContent.includes(labels.emptySkills));

  await click(labels.installSkill);
  await click(labels.sourceGithub);
  await change(document.querySelector('input[type="url"]'), { value: "https://github.com/octo/demo" });
  const form = document.querySelector('form');
  rejectRemote = true;
  await act(async () => propsOf(form).onSubmit({ preventDefault() {} })); await settle();
  assert.ok(document.body.textContent.includes(labels.githubTokenRequired));
  const failedID = createInput.requestId;
  rejectRemote = false;
  await act(async () => propsOf(form).onSubmit({ preventDefault() {} })); await settle();
  assert.equal(createInput.requestId, failedID, "remote retries reuse their request ID");
  assert.equal(createInput.repositoryUrl, "https://github.com/octo/demo");
  await click(labels.confirmInstall.replace("{count}", "1"));
  await click("review");
  const createsBeforeUpdate = calls.filter((item) => item.path === "/api/koi/skill-imports").length;
  await click(labels.checkUpdate);
  assert.ok(document.querySelector('[role="dialog"]'));
  assert.equal(calls.filter((item) => item.path === "/api/koi/skill-imports").length, createsBeforeUpdate, "update uses the server's reviewed preview");
  await click(labels.cancel);

  const confirmsBeforeHub = calls.filter((item) => item.path.endsWith("/confirm")).length;
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(React.StrictMode, null, React.createElement(KoiInstallDialog, { authUserId: user.authUserId, hubTarget: { workspaceId: 7, name: "Hub review", revision: 3, publicationId: "publication-one" }, onClose() {} })))));
  await settle();
  assert.equal(createInput.source, "hub");
  assert.ok(document.body.textContent.includes("Hub review"), "the source name remains visible in the preview");
  assert.equal(createInput.publicationId, "publication-one");
  assert.equal(createInput.revision, 3);
  assert.equal(calls.filter((item) => item.path.endsWith("/confirm")).length, confirmsBeforeHub, "Hub entry only opens a preview");
  await click(labels.confirmInstall.replace("{count}", "1"));
  assert.equal(calls.filter((item) => item.path.endsWith("/confirm")).length, confirmsBeforeHub + 1);

  // Account-scoped data and UI reset together; a non-member can read/remove but
  // cannot install or change automatic discovery.
  user = { id: 2, authUserId: "skills-two", membershipTier: "free" };
  canInstall = false;
  settings = { autoSkills: true, revision: 1 };
  await render();
  assert.equal(auto().checked, true);
  assert.equal(auto().disabled, true);
  assert.equal([...document.querySelectorAll("button")].some((button) => button.textContent === labels.installSkill), false);
  assert.equal(document.querySelector('[role="dialog"]'), null);
  // Send the UI's serialized request bodies through the actual strict Go
  // decoder. A permissive API mock cannot catch extra display-only fields.
  const requestsPath = join(directory, "import-requests.json");
  await writeFile(requestsPath, JSON.stringify(calls.filter((call) => call.path === "/api/koi/skill-imports" && call.method === "POST").map((call) => call.body)));
  execFileSync("go", ["test", "./internal/server", "-run", "^TestKoiImportRequestContract$", "-count=1"], {
    cwd: join(process.cwd(), "backend"),
    env: { ...process.env, KOINOTE_TEST_IMPORT_REQUESTS: requestsPath },
    stdio: "inherit", timeout: 300_000,
  });
  console.log("Koi Skill UI passed: rollout gate, settings, folder selection/upload, partial rejection, confirmation recovery, replacement, GitHub retries/updates, Hub preview, file preview and account isolation");
} finally {
  if (root) await act(async () => root.unmount());
  client?.clear();
  delete globalThis.__koiSkillsTest;
  await rm(directory, { recursive: true, force: true });
}
