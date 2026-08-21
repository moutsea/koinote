import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isModalOpen,
  isOnlyModalOpen,
  pushModal,
} from "./_modal_stack_bundle.mjs";

const read = (path) => readFileSync(path, "utf8");
const sourceFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });

assert.equal(isModalOpen(), false);
const releaseFirst = pushModal();
assert.equal(isModalOpen(), true);
assert.equal(isOnlyModalOpen(), true);
const releaseSecond = pushModal();
assert.equal(isOnlyModalOpen(), false);
releaseFirst();
assert.equal(isModalOpen(), true);
assert.equal(isOnlyModalOpen(), true);
releaseFirst();
assert.equal(isModalOpen(), true);
releaseSecond();
assert.equal(isModalOpen(), false);

const modalFiles = sourceFiles("spa/src").filter(
  (path) => path.endsWith(".tsx") && /aria-modal=(?:"true"|\{true\})/.test(read(path)),
);

assert.ok(modalFiles.length > 0, "the SPA must contain modal components");

for (const path of modalFiles) {
  const source = read(path);
  assert.match(source, /pushModal\(\)/, `${path} must register modal state`);
}

const agentReviewPanel = read(
  "spa/src/components/editor/AgentReviewPanel.tsx",
);
assert.match(agentReviewPanel, /role="dialog"/);
assert.match(agentReviewPanel, /event\.key !== "Escape"/);

for (const path of [
  "spa/src/components/AppShell.tsx",
  "spa/src/components/GlobalSearch.tsx",
  "spa/src/pages/EditorPage.tsx",
  "spa/src/components/editor/DocumentFindBar.tsx",
  "spa/src/desktop/menu.ts",
]) {
  assert.match(read(path), /isModalOpen\(\)/, `${path} must guard modal state`);
}

console.log(`modal shortcut guard: ${modalFiles.length} modals covered`);
