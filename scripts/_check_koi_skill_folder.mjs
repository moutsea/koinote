import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({ entryPoints: ["spa/src/koiSkillFolder.ts"], bundle: true, format: "esm", platform: "node", write: false, logLevel: "silent" });
const { koiFolderEntries, koiFolderPackages, koiSelectedFolderEntries } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);

function files(paths) {
  return paths.map((path) => {
    const file = new File(["# Method"], path.split(/[\\/]/).at(-1), { type: "text/markdown" });
    Object.defineProperty(file, "webkitRelativePath", { value: path });
    file.arrayBuffer = () => { throw new Error("Folder selection must not read file bytes"); };
    return file;
  });
}
const pathsOf = (entries) => entries.map(({ path }) => path).sort();

test("directory selection strips only a shared root and ignores cache files", () => {
  const input = files(["collection/SKILL.md", "collection/guide.md", "collection/build/guide.md", "collection/dist/helper.js", "collection/node_modules/pkg/SKILL.md", "collection/.git/config", "collection/.DS_Store", "collection/._reference.md"]);
  const entries = koiFolderEntries(input);
  assert.deepEqual(pathsOf(entries), ["SKILL.md", "build/guide.md", "dist/helper.js", "guide.md"]);
  assert.equal(entries[0].file, input[0]);
  assert.equal(input[0].webkitRelativePath, "collection/SKILL.md");
  assert.deepEqual(pathsOf(koiFolderEntries(files(["collection\\SKILL.md"]))), ["SKILL.md"]);
  assert.deepEqual(pathsOf(koiFolderEntries([new File(["Method"], "SKILL.md")])), ["SKILL.md"]);
  assert.deepEqual(pathsOf(koiFolderEntries(files(["first/SKILL.md", "second/SKILL.md"]))), ["first/SKILL.md", "second/SKILL.md"]);
  assert.deepEqual(koiFolderPackages(koiFolderEntries(files(["collection/README.md"]))), []);
  assert.deepEqual(koiFolderEntries([]), []);
});

test("nested skills stay independent and ancestor notices follow each package", () => {
  const entries = koiFolderEntries(files([
    "repo/LICENSE", "repo/NOTICE.md", "repo/skills/COPYING",
    "repo/skills/writing/SKILL.md", "repo/skills/writing/LICENSE", "repo/skills/writing/references/guide.md",
    "repo/skills/writing/nested/SKILL.md", "repo/skills/writing/nested/reference.md",
    "repo/skills/writing-extra/SKILL.md", "repo/docs/private-example.txt",
  ]));
  const packages = koiFolderPackages(entries);
  assert.deepEqual(packages.map(({ directory }) => directory), ["skills/writing", "skills/writing-extra", "skills/writing/nested"]);
  const shared = ["LICENSE", "NOTICE.md", "skills/COPYING", "skills/writing/LICENSE"];
  const parent = [...shared, "skills/writing/SKILL.md", "skills/writing/references/guide.md"].sort();
  const child = [...shared, "skills/writing/nested/SKILL.md", "skills/writing/nested/reference.md"].sort();
  assert.deepEqual(pathsOf(packages[0].entries), parent);
  assert.deepEqual(pathsOf(packages[2].entries), child);
  assert.deepEqual(pathsOf(packages[1].entries), ["LICENSE", "NOTICE.md", "skills/COPYING", "skills/writing-extra/SKILL.md"]);
  assert.deepEqual(pathsOf(koiSelectedFolderEntries(packages, ["skills/writing"])), parent);
  const selected = koiSelectedFolderEntries(packages, ["skills/writing", "skills/writing/nested"]);
  assert.deepEqual(pathsOf(selected), [...new Set([...parent, ...child])].sort());
  assert.deepEqual(koiSelectedFolderEntries(packages, []), []);
  assert.deepEqual(koiSelectedFolderEntries(packages, ["unknown"]), []);
  assert.equal(entries.length, 10, "package selection must not modify the original file list");
});

test("a root skill keeps ordinary subdirectories but excludes nested skills", () => {
  const packages = koiFolderPackages(koiFolderEntries(files([
    "collection/SKILL.md", "collection/reference.md", "collection/nested/SKILL.md", "collection/nested/note.md", "collection/notes/example.txt",
  ])));
  assert.deepEqual(packages.map(({ directory }) => directory), ["", "nested"]);
  assert.deepEqual(pathsOf(koiSelectedFolderEntries(packages, [""])), ["SKILL.md", "notes/example.txt", "reference.md"]);
});

test("invalid and duplicate paths cannot become a partial upload", () => {
  for (const path of ["/tmp/collection/SKILL.md", "C:\\collection\\SKILL.md", "collection/../SKILL.md", "collection//SKILL.md", "collection/./SKILL.md", "collection/\u0000SKILL.md"]) {
    assert.throws(() => koiFolderEntries(files(["collection/SKILL.md", path])), /Invalid folder file path/);
  }
  assert.throws(() => koiFolderEntries(files(["collection/SKILL.md", "collection/SKILL.md"])), /Duplicate folder file path/);
});
