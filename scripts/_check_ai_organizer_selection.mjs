import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = await build({ entryPoints: ["spa/src/components/editor/aiOrganizerSelectionCore.ts"], bundle: true, format: "esm", platform: "neutral", write: false });
const core = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const folders = [
  { folderId: "aug", name: "2026年8月", parentFolderId: null, organizerKind: "smart" },
  { folderId: "week", name: "第 2 周", parentFolderId: "aug", organizerKind: "smart" },
  { folderId: "manual-in-week", name: "Notes", parentFolderId: "week", organizerKind: null },
  { folderId: "work", name: "Work", parentFolderId: null, organizerKind: null },
  { folderId: "cycle", name: "Cycle", parentFolderId: "cycle", organizerKind: null },
];
const documents = [
  { docId: "a", title: "A", folderId: "week", organizedAt: "2026-08-01" },
  { docId: "b", title: "B", folderId: "manual-in-week", organizedAt: "2026-08-01" },
  { docId: "c", title: "C", folderId: "work", organizedAt: "2026-09-01" },
  { docId: "d", title: "D", folderId: null, organizedAt: null },
  { docId: "e", title: "E", folderId: "missing", organizedAt: "2026-09-01" },
];
assert.deepEqual([...core.automaticFolderIds(folders)].sort(), ["aug", "manual-in-week", "week"], "descendants of automatic folders are automatic");
assert.deepEqual([...core.defaultOrganizerSelection(folders, documents)].sort(), ["a", "b", "d"]);
const tree = core.buildOrganizerPickerTree(folders, documents);
const aug = tree.folders.find(folder => folder.folderId === "aug");
assert.deepEqual(core.documentIdsIn(aug).sort(), ["a", "b"], "a folder covers every nested document");
assert.ok(core.documentIdsIn(tree).includes("e"), "orphaned documents remain pickable at the root");
assert.equal(core.organizerSelectionState(["a", "b"], new Set(["a"])), "some");
assert.equal(core.organizerSelectionState(["a", "b"], new Set(["a", "b"])), "all");
assert.equal(core.organizerSelectionState([], new Set(["a"])), "none");
const toggled = core.toggleOrganizerSelection(new Set(["c"]), ["a", "b"], true);
assert.deepEqual([...toggled].sort(), ["a", "b", "c"]);
assert.deepEqual([...core.toggleOrganizerSelection(toggled, ["a", "b"], false)], ["c"]);
assert.deepEqual(core.organizerRequestIds(documents, new Set(["d", "a", "c"]), new Set(["c"])), ["a", "d"], "request keeps library order and drops unavailable documents");
console.log("AI organizer selection: defaults, nested folders, toggles and request order passed");
