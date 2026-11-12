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
  let available = false, canInstall = true, settings = { autoSkills: true, revision: 1, libraryMode: "installed" };
  let failMigration = false, loseSkip = false;
  let holdMigration = false, migrationSignal;
  let holdConfirmation = false, releaseConfirmation, confirmationSignal;
  let holdReceipt = false, receiptSignal;
  let skills = [], preview, createInput, rejectNextToggle = true, loseConfirmation = true;
  let saveDelay, rejectRemote = false, remoteFailure = "", failFile = false, failUpload = true;
  const calls = [], uploads = [];
  const candidate = { id: "candidate-review", name: "review", description: "检查文章结构", entryPath: "SKILL.md", directory: "review", fileCount: 2, sizeBytes: 100, license: "MIT", instructions: "# Review\nRead guide.md.", compatibility: { conversation: true, article: false, reasons: [], warnings: ["scripts_not_executed"] }, metadataFormat: "plain-markdown" };
  const installed = { ...candidate, id: "installation-review", versionId: "version-one", version: "123456abcdef", contentSha256: "1".repeat(64), sourceKind: "folder", source: { directoryName: "collection" }, enabled: true, revision: 1, installedAt: "2026-11-11T00:00:00Z", updatedAt: "2026-11-11T00:00:00Z", license: "" };
  state.api = async (path, init = {}) => {
    const method = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    const url = new URL(path, "https://koinote.test");
    if (url.pathname === "/api/koi/settings") {
      if (method === "PUT") {
        if (saveDelay) await saveDelay;
        assert.equal(body.expectedRevision, settings.revision);
        settings = { ...settings, autoSkills: body.autoSkills, revision: settings.revision + 1 };
        return { settings: { ...settings } };
      }
      return { managementAvailable: available, canInstall, settings: { ...settings }, legacySkillCount: 2 };
    }
    if (url.pathname === "/api/koi/skill-migration/skip") {
      assert.equal(body.expectedRevision, settings.revision);
      settings = { ...settings, libraryMode: "installed", revision: settings.revision + 1 };
      if (loseSkip) { loseSkip = false; throw new Error("response lost"); }
      return { libraryMode: "installed" };
    }
    if (url.pathname === "/api/koi/skills") {
      const filtered = skills.filter((skill) => (!url.searchParams.get("q") || skill.name.includes(url.searchParams.get("q"))) && (!url.searchParams.get("source") || skill.sourceKind === url.searchParams.get("source")) && (!url.searchParams.get("state") || (skill.enabled ? "enabled" : "disabled") === url.searchParams.get("state")));
      const offset = Number(url.searchParams.get("cursor") || 0);
      return { skills: filtered.slice(offset, offset + 20).map((item) => ({ ...item })), nextCursor: filtered.length > offset + 20 ? String(offset + 20) : "", storage: { usedBytes: skills.length * 100 } };
    }
    if (url.pathname === "/api/koi/skill-imports" && method === "POST") {
      createInput = body;
      if (body.source === "migration" && holdMigration) {
        migrationSignal = init.signal;
        await new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }
      if (body.source !== "folder" && rejectRemote) throw new ApiError(403, "access denied", "github_token_required");
      preview = { id: "preview-one", status: "pending", revision: 1, sourceKind: "folder", source: {}, candidates: [], rejected: [], uploadedFiles: 0, rejectedFiles: 0, declaredFiles: body.declaredPaths?.length ?? 0, expiresAt: "2099-01-01T00:00:00Z" };
      if (body.source !== "folder") preview = { ...preview, status: "ready", revision: 2, sourceKind: body.source, source: { kind: body.source, repositoryUrl: body.repositoryUrl, ref: "main", commitSha: "a".repeat(40), name: "Hub review" }, candidates: [candidate] };
      if (body.source !== "folder" && remoteFailure) preview = {
        ...preview, status: "failed", errorCode: remoteFailure, candidates: [],
        rejected: remoteFailure === "validation_failed" ? [{ entryPath: "SKILL.md", directory: "", reason: "missing_description" }] : [],
      };
      if (body.source === "migration") preview.candidates.push({ ...candidate, id: "candidate-other", name: "other" });
      return { preview: { ...preview } };
    }
    if (url.pathname === "/api/koi/skill-imports/preview-one/files") {
      assert.equal(body.path, undefined, "member paths belong in the query, not the upload body");
      if (failUpload) { failUpload = false; throw new Error("offline"); }
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
      if (holdConfirmation) {
        confirmationSignal = init.signal;
        // Deliberately ignore abort: the UI must still leave its waiting state,
        // even when a native transport cannot reject immediately.
        await new Promise((resolve) => { releaseConfirmation = resolve; });
      }
      if (preview.status === "committed") return { installed: skills };
      if (preview.sourceKind === "migration" && failMigration) { failMigration = false; throw new ApiError(409, "full", "storage_quota_exceeded"); }
      if (preview.sourceKind === "migration") settings = { ...settings, libraryMode: "installed", revision: settings.revision + 1 };
      skills = createInput.updateFromId ? [{ ...skills[0], versionId: "version-two", revision: skills[0].revision + 1 }] : [{ ...installed, sourceKind: createInput.source, source: { ...preview.source }, enabled: body.enable }];
      preview = { ...preview, status: "committed", candidates: [], installed: skills };
      if (loseConfirmation) { loseConfirmation = false; throw new Error("response lost"); }
      return { installed: skills };
    }
    if (url.pathname === "/api/koi/skill-imports/preview-one") {
      if (method === "DELETE") return { status: "cancelled" };
      if (holdReceipt) { receiptSignal = init.signal; await new Promise(() => {}); }
      return { preview: { ...preview } };
    }
    if (url.pathname.endsWith("/check-update")) return { status: "update_available", preview: { ...preview, id: "preview-one", status: "ready", revision: 2, sourceKind: "github", candidates: [{ ...candidate, installedStatus: "update", installedId: skills[0].id, previousVersion: skills[0].version, previousSizeBytes: 100 }] } };
    if (url.pathname === "/api/koi/skills/installation-review/files/2") {
      assert.equal(url.searchParams.get("version"), "version-one", "file preview pins the displayed version");
      if (failFile) throw new Error("offline");
      return { file: { position: 2, path: "guide.md", sha256: "guide-hash" }, contentBase64: Buffer.from("结构说明：保持作者原意。").toString("base64") };
    }
    if (url.pathname === "/api/koi/skills/installation-review/files/3") return {
      file: { position: 3, path: "example.html", sha256: "html-hash" }, contentBase64: Buffer.from('<script>window.executed=true</script><img src="https://external.invalid/x">').toString("base64"),
    };
    if (url.pathname === "/api/koi/skills/installation-review/files/4") return {
      file: { position: 4, path: "sample.bin", sha256: "bin-hash" }, contentBase64: Buffer.from([0, 1, 2]).toString("base64"),
    };
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
      return { skill: { ...skills[0] }, instructions: candidate.instructions, files: [{ position: 1, path: "SKILL.md", sizeBytes: 50 }, { position: 2, path: "guide.md", sizeBytes: 50, sha256: "guide-hash" }, { position: 3, path: "example.html", sizeBytes: 50, sha256: "html-hash" }, { position: 4, path: "sample.bin", sizeBytes: 3, sha256: "bin-hash" }] };
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
  assert.ok(document.body.textContent.includes(labels.installRuntimeNotice), "installation explains the Credits and script boundary before upload");
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
  await change(document.querySelector('input[type="file"]'), { files: [], value: "" });
  assert.equal(document.querySelectorAll('input[name="folder-package"]').length, 2, "cancelling the picker preserves the current selection");
  assert.equal(document.body.textContent.includes(labels.folderEmpty), false, "picker cancellation is not an empty-folder error");
  await click(labels.uploadAndAnalyze);
  const createsBeforeRetry = calls.filter((call) => call.path === "/api/koi/skill-imports").length;
  assert.ok(document.body.textContent.includes(labels.koiAnalysisFailed));
  assert.equal(document.querySelector('[role="dialog"] [role="status"]'), null, "a failed upload stops showing progress and allows retry");
  await click(labels.retry);
  assert.equal(calls.filter((call) => call.path === "/api/koi/skill-imports").length, createsBeforeRetry, "upload retry reuses its existing preview");
  assert.deepEqual(createInput.declaredPaths.sort(), ["bad/SKILL.md", "bad/guide.md", "review/SKILL.md", "review/guide.md"]);
  assert.ok(document.body.textContent.includes(labels.rejectedTitle));
  assert.ok(document.body.textContent.includes(labels.reject_sensitive_data_detected));
  const previewCard = document.querySelector('input[name="preview-candidate"]').closest("li");
  const licenseDetails = [...previewCard.querySelectorAll("details")].find((item) => item.querySelector("summary")?.textContent === labels.viewLicense);
  assert.ok(licenseDetails, "the license remains available before confirmation");
  assert.equal(licenseDetails.hasAttribute("open"), false, "license text is collapsed by default");
  assert.equal(licenseDetails.querySelector("p").textContent, candidate.license, "expanding retains the full original license");
  assert.ok([...document.querySelectorAll('[role="dialog"] footer button')].some((button) => button.textContent.trim() === labels.confirmInstall.replace("{count}", "1")), "the install action stays in the fixed footer");
  assert.ok(previewCard.textContent.includes(labels.formatPlain));
  assert.ok(previewCard.textContent.includes(labels.articleUnavailable));
  assert.ok(previewCard.textContent.includes(labels.requirement_scripts_not_executed), "the preview explains declared script restrictions");
  assert.equal(uploads.some((file) => file.content === "must stay local"), false);
  const enable = [...document.querySelectorAll('input[type="checkbox"]')].find((input) => input.parentElement.textContent === labels.enableAfterInstall);
  await change(enable, { checked: false });
  await click(labels.confirmInstall.replace("{count}", "1"));
  assert.equal(document.querySelector('[role="dialog"]'), null, "lost confirmation response recovers the committed receipt");
  assert.equal(calls.filter((call) => call.path.endsWith("/confirm")).length, 1);
  const originalSkills = skills;
  skills = [...Array.from({ length: 21 }, (_, index) => ({ ...installed, id: `folder-${index}`, name: `folder-${index}` })), { ...installed, id: "github-skill", name: "github-skill", sourceKind: "github", enabled: false }];
  const sourceFilter = () => document.querySelector(`select[aria-label="${labels.filterSource}"]`);
  const stateFilter = () => document.querySelector(`select[aria-label="${labels.filterState}"]`);
  const visibleSkills = () => document.querySelectorAll('section[aria-labelledby="koi-skills-heading"] li');
  await change(sourceFilter(), { value: "folder" });
  assert.equal(visibleSkills().length, 20);
  await click(labels.loadMore);
  assert.equal(visibleSkills().length, 21, "pagination keeps the selected source");
  await change(sourceFilter(), { value: "github" });
  assert.equal(visibleSkills().length, 1, "changing source replaces the previous pages");
  const lastList = new URL(calls.filter((call) => call.path.startsWith("/api/koi/skills?")).at(-1).path, "https://koinote.test");
  assert.equal(lastList.searchParams.get("source"), "github");
  assert.equal(lastList.searchParams.get("cursor"), "", "a new source starts from its first page");
  await change(stateFilter(), { value: "enabled" });
  assert.ok(document.body.textContent.includes(labels.noMatches), "source and status filters combine");
  assert.equal(document.body.textContent.includes(labels.emptySkills), false, "a filter miss does not claim the library is empty");
  await change(stateFilter(), { value: "disabled" });
  assert.equal(visibleSkills().length, 1);
  await change(stateFilter(), { value: "" });
  await change(sourceFilter(), { value: "hub" });
  assert.ok(document.body.textContent.includes(labels.noMatches));
  skills = originalSkills;
  await change(sourceFilter(), { value: "" });
  await act(async () => client.invalidateQueries({ queryKey: ["koi-skills", user.authUserId] })); await settle();
  let skillSwitch = () => document.querySelector(`input[aria-label="${labels.enabledToggle} review"]`);
  assert.equal(skillSwitch().checked, false);
  await change(skillSwitch(), {});
  assert.equal(skillSwitch().checked, true, "conflicts refresh the current installation state");
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1, "conflicts do not replay writes automatically");
  await click("review");
  assert.ok(document.body.textContent.includes(labels.articleUnavailable), "preview and installed detail explain the same entry restrictions");
  await click("example.html50 B");
  assert.ok(document.querySelector("pre").textContent.includes("<script>"));
  assert.equal(document.querySelectorAll("script, img").length, 0, "attachment HTML stays inert without loading external resources");
  await click("sample.bin3 B");
  assert.ok(document.body.textContent.includes(labels.binaryFileNoPreview));
  failFile = true;
  await click("guide.md50 B");
  assert.ok(document.body.textContent.includes(labels.fileLoadFailed));
  failFile = false;
  await click(labels.retry);
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
  for (const [code, message] of [["no_skills", labels.koiNoSkills], ["validation_failed", labels.koiValidationFailed]]) {
    remoteFailure = code;
    await act(async () => propsOf(document.querySelector('form')).onSubmit({ preventDefault() {} })); await settle();
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(message && dialog.textContent.includes(message), `${code} explains why installation cannot continue`);
    assert.equal(dialog.textContent.includes(labels.koiAnalysisFailed), false, "known analysis failures have specific guidance");
    assert.equal(dialog.textContent.includes(labels.reject_missing_description), code === "validation_failed", "validation keeps the concrete rejection reason visible");
    assert.equal([...dialog.querySelectorAll("button")].some((button) => button.textContent.includes(labels.confirmInstall.split("{count}")[0])), false, "failed previews cannot be installed");
    await click(labels.startOver);
  }
  remoteFailure = "";
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

  // Legacy accounts explicitly choose what to keep; failed confirmation keeps
  // the old library, and a Hub entry resumes its original source after migration.
  settings = { autoSkills: true, revision: 10, libraryMode: "legacy" };
  client.clear();
  await render();
  assert.ok(document.body.textContent.includes(labels.legacyTitle));
  assert.equal([...document.querySelectorAll("button")].some((button) => button.textContent === labels.installSkill), false, "legacy accounts choose their library before using install controls");
  await click(labels.legacyAction);
  assert.equal(createInput.source, "migration");
  assert.ok(document.body.textContent.includes(labels.previewMultiHint));
  const otherCandidate = [...document.querySelectorAll('input[name="preview-candidate"]')].find((input) => input.parentElement.textContent.includes("other"));
  await change(otherCandidate, {});
  failMigration = true;
  await click(labels.legacyConfirm.replace("{count}", "1"));
  assert.equal(settings.libraryMode, "legacy");
  assert.ok(document.body.textContent.includes(labels.koiQuota));
  await click(labels.legacyConfirm.replace("{count}", "1"));
  assert.equal(settings.libraryMode, "installed");
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(skills.length, 1);

  settings = { autoSkills: true, revision: 20, libraryMode: "legacy" };
  client.clear();
  const createsBeforeMigration = calls.filter((item) => item.path === "/api/koi/skill-imports").length;
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(KoiInstallDialog, { key: "legacy-hub", authUserId: user.authUserId, hubTarget: { workspaceId: 7, name: "Original Hub", revision: 3, publicationId: "publication-one" }, onClose() {} }))));
  await settle();
  assert.ok(document.body.textContent.includes(labels.legacyTitle));
  assert.equal(calls.filter((item) => item.path === "/api/koi/skill-imports").length, createsBeforeMigration, "Hub does not bypass the migration choice");
  await click(labels.legacyAction);
  await change([...document.querySelectorAll('input[name="preview-candidate"]')].find((input) => input.parentElement.textContent.includes("other")), {});
  const confirmationsBeforeSwitch = calls.filter((item) => item.path.endsWith("/confirm")).length;
  await click(labels.legacyConfirm.replace("{count}", "1"));
  await settle();
  assert.equal(settings.libraryMode, "installed");
  assert.equal(createInput.source, "hub", "migration returns to the original Hub preview");
  assert.equal(createInput.workspaceId, 7);
  assert.equal(calls.filter((item) => item.path.endsWith("/confirm")).length, confirmationsBeforeSwitch + 1, "the resumed Hub source is not automatically confirmed");

  settings = { autoSkills: true, revision: 30, libraryMode: "legacy" };
  client.clear();
  await render();
  loseSkip = true;
  await click(labels.legacySkip);
  assert.equal(settings.libraryMode, "installed");
  assert.equal(document.body.textContent.includes(labels.legacyTitle), false, "a lost empty-library response reconciles the actual mode");

  // A stalled migration times out, can retry with its stable request ID, and
  // actually aborts the network request when the user closes the dialog.
  settings = { autoSkills: true, revision: 40, libraryMode: "legacy" };
  client.clear();
  await render();
  const nativeSetTimeout = globalThis.setTimeout;
  let migrationTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => delay === 65_000
    ? (migrationTimeout = callback, -1) : nativeSetTimeout(callback, delay, ...args);
  try {
    holdMigration = true;
    await click(labels.legacyAction);
    assert.ok(document.body.textContent.includes(labels.legacyAnalyzing.replace("{count}", "2")));
    const timedOutRequest = createInput.requestId;
    await act(async () => migrationTimeout());
    await settle();
    assert.equal(migrationSignal.aborted, true);
    assert.ok(document.body.textContent.includes(labels.legacyTimeout));
    assert.equal(document.querySelector('[role="dialog"] [role="status"]'), null, "timeout stops the spinner");
    assert.equal(settings.libraryMode, "legacy");
    holdMigration = false;
    const retryMigration = [...document.querySelector('[role="dialog"]').querySelectorAll("button")].find((button) => button.textContent.trim() === labels.legacyAction);
    assert.ok(retryMigration, "failed migration has a retry action inside the dialog");
    await act(async () => retryMigration.click());
    await settle();
    assert.equal(createInput.requestId, timedOutRequest, "timeout retries reuse the import receipt");
    assert.ok(document.querySelector('input[name="preview-candidate"]'));
    await click(labels.cancel);
    holdMigration = true;
    await click(labels.legacyAction);
    const pendingSignal = migrationSignal;
    await click(labels.cancel);
    assert.equal(pendingSignal.aborted, true, "closing migration cancels its HTTP request");
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    holdMigration = false;
  }

  // Confirmation and receipt reads have independent deadlines. An unknown
  // result preserves the same payload; closing must never delete its preview.
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  const deadlineTimers = new Map();
  let nextTimer = -1;
  globalThis.setTimeout = (callback, delay, ...args) => [10_000, 15_000, 180_000].includes(delay)
    ? (deadlineTimers.set(nextTimer, { callback, delay }), nextTimer--)
    : realSetTimeout(callback, delay, ...args);
  globalThis.clearTimeout = (timer) => { if (!deadlineTimers.delete(timer)) realClearTimeout(timer); };
  const fireDeadline = async (delay) => {
    const timer = [...deadlineTimers].find(([, value]) => value.delay === delay);
    assert.ok(timer, `Missing ${delay}ms deadline`);
    deadlineTimers.delete(timer[0]);
    await act(async () => timer[1].callback());
    await settle();
  };
  const openMigration = async (revision) => {
    settings = { autoSkills: true, revision, libraryMode: "legacy" };
    client.clear();
    await render();
    await click(labels.legacyAction);
    await change([...document.querySelectorAll('input[name="preview-candidate"]')].find((input) => input.parentElement.textContent.includes("other")), {});
  };
  try {
    await openMigration(50);
    holdConfirmation = true;
    holdReceipt = true;
    await click(labels.legacyConfirm.replace("{count}", "1"));
    const originalConfirmation = calls.filter((call) => call.path.endsWith("/confirm")).at(-1).body;
    const confirmSignal = confirmationSignal;
    assert.equal(document.querySelector('[role="dialog"] button[aria-label="' + labels.close + '"]').disabled, false);
    assert.ok(document.body.textContent.includes(labels.installCloseNotice));
    await fireDeadline(10_000);
    assert.ok(document.body.textContent.includes(labels.installingSlow));
    await fireDeadline(180_000);
    assert.equal(confirmSignal.aborted, true);
    await fireDeadline(15_000);
    assert.equal(receiptSignal.aborted, true);
    assert.equal(document.querySelector('[role="dialog"] [role="status"]'), null, "both stalled requests release the waiting UI");
    assert.ok(document.body.textContent.includes(labels.installResultUnknown));
    assert.ok([...document.querySelectorAll('input[name="preview-candidate"]')].every((input) => input.disabled), "uncertain results freeze the original selection");
    const firstRelease = releaseConfirmation;
    holdReceipt = false;
    holdConfirmation = false;
    const confirmationsBeforeRetry = calls.filter((call) => call.path.endsWith("/confirm")).length;
    await click(labels.checkInstallResult);
    assert.equal(calls.filter((call) => call.path.endsWith("/confirm")).length, confirmationsBeforeRetry, "checking a receipt never submits another install");
    const retryStart = calls.length;
    await click(labels.retryInstall);
    assert.equal(calls[retryStart].method, "GET", "retry checks the durable receipt before posting");
    assert.deepEqual(calls.filter((call) => call.path.endsWith("/confirm")).at(-1).body, originalConfirmation);
    assert.equal(settings.libraryMode, "installed");
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(async () => firstRelease());
    await settle();
    assert.equal(settings.revision, 51, "a late original response does not duplicate the migration");

    await openMigration(60);
    holdConfirmation = true;
    await click(labels.legacyConfirm.replace("{count}", "1"));
    const deletesBeforeClose = calls.filter((call) => call.method === "DELETE" && call.path === "/api/koi/skill-imports/preview-one").length;
    const backgroundSignal = confirmationSignal;
    await click(labels.close);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(backgroundSignal.aborted, false, "closing the window does not abort a confirmation");
    assert.equal(calls.filter((call) => call.method === "DELETE" && call.path === "/api/koi/skill-imports/preview-one").length, deletesBeforeClose, "closing a confirmation preserves its preview");
    holdConfirmation = false;
    await act(async () => releaseConfirmation());
    await settle();
    assert.equal(settings.libraryMode, "installed", "the late result refreshes the library after closing");

    await openMigration(70);
    loseConfirmation = true;
    holdReceipt = true;
    const confirmationsBeforeLoss = calls.filter((call) => call.path.endsWith("/confirm")).length;
    await click(labels.legacyConfirm.replace("{count}", "1"));
    await fireDeadline(15_000);
    assert.ok(document.body.textContent.includes(labels.installResultUnknown));
    holdReceipt = false;
    await click(labels.retryInstall);
    assert.equal(calls.filter((call) => call.path.endsWith("/confirm")).length, confirmationsBeforeLoss + 1, "a committed receipt recovers without a second POST");
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally {
    holdConfirmation = false;
    holdReceipt = false;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }

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
  console.log("Koi Skill UI passed: rollout gate, settings, folder installation/replacement, GitHub/Hub previews, migration selection/retry, Hub continuation, empty-library recovery, file preview and account isolation");
} finally {
  if (root) await act(async () => root.unmount());
  client?.clear();
  delete globalThis.__koiSkillsTest;
  await rm(directory, { recursive: true, force: true });
}
