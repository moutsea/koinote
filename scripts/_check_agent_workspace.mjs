import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  agentWorkspaceImportPath,
  configFilesToAgentWorkspaceImport,
  decodeAgentWorkspaceText,
  filterAgentWorkspaceSensitiveFiles,
  isAgentWorkspaceSourcePath,
  isAgentWorkspaceHomeFile,
  isAgentWorkspaceReadme,
  prepareAgentWorkspaceImport,
} from "./_agent_workspace_import_bundle.mjs";

function file(name, content, relativePath = "") {
  const value = new File([content], name, { type: "text/plain" });
  Object.defineProperty(value, "webkitRelativePath", { value: relativePath });
  return value;
}

const readme = {
  fileId: 7,
  path: "README.md",
  mimeType: "text/markdown",
  sizeBytes: 10,
  sha256: "readme-hash",
  contentBase64: Buffer.from("# Guide\n安全提醒").toString("base64"),
};

assert.equal(agentWorkspaceImportPath(file("SKILL.md", "", "bundle/skills/writing/SKILL.md")), "skills/writing/SKILL.md");
assert.equal(isAgentWorkspaceReadme("README.md"), true);
assert.equal(isAgentWorkspaceReadme("skills/README.md"), false);
assert.equal(decodeAgentWorkspaceText(readme.contentBase64), "# Guide\n安全提醒");
assert.equal(isAgentWorkspaceSourcePath(".codex/skills/writing/SKILL.md"), true);
assert.equal(isAgentWorkspaceSourcePath(".config/moltbot/skills/writing/SKILL.md"), true);
assert.equal(isAgentWorkspaceSourcePath(".opencode/skills/writing/SKILL.md"), true);
assert.equal(isAgentWorkspaceSourcePath(".codex/config.json"), false);
assert.equal(isAgentWorkspaceSourcePath(".dsh/skills/demo/config.json"), true);
assert.equal(isAgentWorkspaceSourcePath(".dsh/AGENTS.md"), true);
assert.equal(isAgentWorkspaceSourcePath(".dsh/.credentials.yaml"), false);
assert.equal(isAgentWorkspaceSourcePath(".dsh/settings.yaml"), false);
assert.equal(isAgentWorkspaceHomeFile(".dsh/skills/demo/SKILL.md"), true);
assert.equal(isAgentWorkspaceHomeFile(".dsh/AGENTS.md"), true);
assert.equal(isAgentWorkspaceHomeFile(".dsh/skills"), false);
assert.equal(isAgentWorkspaceSourcePath("AGENTS.md"), true);
assert.deepEqual(
  configFilesToAgentWorkspaceImport([{ path: ".codex/prompts/system.md", bytes: new TextEncoder().encode("Be concise") }]),
  [{ path: ".codex/prompts/system.md", contentBase64: Buffer.from("Be concise").toString("base64") }],
);
assert.equal(isAgentWorkspaceHomeFile(".codex/skills/demo/SKILL.md"), true);
assert.equal(isAgentWorkspaceHomeFile("AGENTS.md"), true);
for (const path of [".codex/skills", "README.md", "skills/demo/SKILL.md", ".ssh/config"]) {
  assert.equal(isAgentWorkspaceHomeFile(path), false, path);
}
const manyFiles = Array.from({ length: 201 }, (_, index) => ({ path: `skills/skill-${index}/SKILL.md`, bytes: new TextEncoder().encode("portable skill") }));
assert.equal(configFilesToAgentWorkspaceImport(manyFiles).length, manyFiles.length);
const filtered = filterAgentWorkspaceSensitiveFiles([
  { path: ".codex/prompts/safe.md", bytes: new TextEncoder().encode("Be concise") },
  { path: ".codex/skills/authentication.md", bytes: new TextEncoder().encode("Explain OAuth flows") },
  { path: ".codex/settings.json", bytes: new TextEncoder().encode('{"api_key":"sk-example-1234567890"}') },
  { path: ".codex/.env", bytes: new TextEncoder().encode("SAFE=true") },
  { path: ".codex/.env.example", bytes: new TextEncoder().encode("API_KEY=<REDACTED>") },
]);
assert.deepEqual(filtered.safeFiles.map((file) => file.path), [".codex/prompts/safe.md", ".codex/skills/authentication.md", ".codex/.env.example"]);
assert.deepEqual(filtered.filteredFiles.map((file) => file.path), [".codex/settings.json", ".codex/.env"]);
assert.equal(new TextDecoder().decode(filtered.filteredFiles[0].bytes), '{"api_key":"sk-example-1234567890"}');
const documentationExamples = filterAgentWorkspaceSensitiveFiles([
  { path: ".codex/skills/example.md", bytes: new TextEncoder().encode("apiKey: process.env.OPENAI_API_KEY") },
  { path: ".codex/skills/schema.md", bytes: new TextEncoder().encode("STRIPE_API_KEY: SecretsStoreSecret") },
  { path: ".codex/skills/placeholder.md", bytes: new TextEncoder().encode("API_KEY=your_global_api_key") },
  { path: ".codex/skills/cookie.md", bytes: new TextEncoder().encode("document.cookie = 'cookie_consent'") },
  { path: ".codex/skills/consent-secret.md", bytes: new TextEncoder().encode("cookie: my-consent-secret-123456") },
]);
assert.deepEqual(documentationExamples.filteredFiles.map((file) => file.path), [".codex/skills/consent-secret.md"]);

const sensitiveFixtures = JSON.parse(readFileSync("backend/internal/server/testdata/agent_workspace_sensitive_content.json", "utf8"));
for (const fixture of sensitiveFixtures) {
  const result = filterAgentWorkspaceSensitiveFiles([{ path: ".codex/skills/cloudflare/references/zaraz/gotchas.md", bytes: new TextEncoder().encode(fixture.content) }]);
  assert.equal(result.filteredFiles.length > 0, fixture.sensitive, fixture.name);
}

const preserved = await prepareAgentWorkspaceImport([file("SKILL.md", "内容", "bundle/skills/SKILL.md")], readme);
assert.deepEqual(preserved.map((item) => item.path), ["skills/SKILL.md", "README.md"]);
assert.equal(Buffer.from(preserved[1].contentBase64, "base64").toString(), "# Guide\n安全提醒");

const replaced = await prepareAgentWorkspaceImport([file("README.md", "新的指南", "bundle/README.md")], readme);
assert.deepEqual(replaced.map((item) => item.path), ["README.md"]);
assert.equal(Buffer.from(replaced[0].contentBase64, "base64").toString(), "新的指南");

await assert.rejects(() => prepareAgentWorkspaceImport([file("one.txt", "x"), file("one.txt", "y")]), /duplicate file paths/);
await assert.rejects(() => prepareAgentWorkspaceImport([file("large.bin", Buffer.alloc(5 * 1024 * 1024 + 1))]), /file too large/);

console.log("agent workspace checks passed");
