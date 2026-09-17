import assert from "node:assert/strict";
import {
  agentWorkspaceImportPath,
  decodeAgentWorkspaceText,
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

const preserved = await prepareAgentWorkspaceImport([file("SKILL.md", "内容", "bundle/skills/SKILL.md")], readme);
assert.deepEqual(preserved.map((item) => item.path), ["skills/SKILL.md", "README.md"]);
assert.equal(Buffer.from(preserved[1].contentBase64, "base64").toString(), "# Guide\n安全提醒");

const replaced = await prepareAgentWorkspaceImport([file("README.md", "新的指南", "bundle/README.md")], readme);
assert.deepEqual(replaced.map((item) => item.path), ["README.md"]);
assert.equal(Buffer.from(replaced[0].contentBase64, "base64").toString(), "新的指南");

await assert.rejects(() => prepareAgentWorkspaceImport([file("one.txt", "x"), file("one.txt", "y")]), /duplicate file paths/);
await assert.rejects(() => prepareAgentWorkspaceImport([file("large.bin", Buffer.alloc(5 * 1024 * 1024 + 1))]), /file too large/);

console.log("agent workspace checks passed");
