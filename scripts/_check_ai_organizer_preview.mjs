import assert from "node:assert/strict";
import { build } from "esbuild";
const bundle = await build({ entryPoints: ["spa/src/components/editor/aiOrganizerPreviewCore.ts"], bundle: true, format: "esm", platform: "node", write: false });
const { buildOrganizationPreview, moveOrganizationDocument, changeOrganizationTags, previewTagCounts, organizationPreviewOrders } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const { organizationChoices } = await import("./_ai_organizer_bundle.mjs");
const folders = [{ id: "work", name: "Work", parentId: "" }, { id: "ai", name: "AI", parentId: "work" }, { id: "empty", name: "Empty", parentId: "" }];
const items = [{ docId: "one", title: "A", folderId: "", tags: ["Original"] }, { docId: "two", title: "B", folderId: "work", tags: ["Keep"] }];
const drafts = {
  one: { selected: true, folderId: "", newPath: "Work/AI/Guides", tags: ["#Go", "go", "商业、营销"] },
  two: { selected: false, folderId: "ai", newPath: "Guides", tags: ["Go"] },
};
const before = structuredClone(drafts);
const tree = buildOrganizationPreview(items, folders, drafts);
assert.equal(tree.root.count, 2);
assert.deepEqual(tree.locations.get("one").path, ["Work", "AI", "Guides"]);
assert.deepEqual(tree.locations.get("one").newFolders, ["Guides"], "existing path prefixes must resolve exactly as apply does");
assert.deepEqual(tree.locations.get("two").path, ["Work"], "excluded articles must preview their unchanged locations");
assert.ok([...tree.directories.values()].some(node => node.folderId === "empty"), "empty existing folders remain drop targets");
assert.equal(tree.root.children.filter(node => node.name === "Work").length, 1, "an existing folder must not appear as a duplicate proposed folder");
const target = tree.locations.get("one");
const moved = moveOrganizationDocument(drafts, "two", target, folders, items);
assert.equal(moved.two.selected, true, "an explicit move includes an excluded article");
assert.deepEqual(organizationChoices(moved, folders).map(choice => [choice.folderId, choice.newFolders]), [["ai", ["Guides"]], ["ai", ["Guides"]]]);
assert.deepEqual(drafts, before, "preview changes must never mutate the fetched drafts");
assert.strictEqual(moveOrganizationDocument(drafts, "deleted", target, folders, items), drafts);
assert.throws(() => moveOrganizationDocument(drafts, "one", { folderId: "", newFolders: Array(9).fill("Deep") }, folders, items));
const duplicates = [{ id: "a", name: "Same", parentId: "" }, { id: "b", name: "Same", parentId: "" }];
const duplicateTree = buildOrganizationPreview([], duplicates, {});
assert.equal(duplicateTree.root.children.length, 2);
assert.notEqual(duplicateTree.root.children[0].key, duplicateTree.root.children[1].key);
assert.throws(() => organizationChoices({ one: { ...drafts.one, newPath: "Same" } }, duplicates), /ambiguous_folder/);
const invalidTags = { one: { ...drafts.one, tags: ["x".repeat(33)] } };
assert.deepEqual(buildOrganizationPreview(items.slice(0, 1), folders, invalidTags).locations.get("one").path, ["Work", "AI", "Guides"], "unfinished tag edits must not change the folder preview");
assert.deepEqual(previewTagCounts(drafts), [{ name: "商业、营销", count: 1 }, { name: "Go", count: 1 }].sort((a, b) => a.name.localeCompare(b.name)));
const renamed = changeOrganizationTags(drafts, { kind: "rename", from: "go", value: "商业、营销" });
assert.deepEqual(renamed.one.tags, ["商业、营销"], "renaming to an existing tag merges instead of duplicating it");
assert.strictEqual(renamed.two, drafts.two, "bulk operations must leave excluded documents untouched");
assert.deepEqual(changeOrganizationTags(renamed, { kind: "remove", from: "商业、营销" }).one.tags, []);
assert.deepEqual(changeOrganizationTags(renamed, { kind: "add", value: " #API " }).one.tags, ["商业、营销", "API"]);
const limit = { one: { ...drafts.one, tags: ["a"] }, two: { ...drafts.two, selected: true, tags: ["a", "b", "c", "d", "e"] } };
const original = structuredClone(limit);
assert.throws(() => changeOrganizationTags(limit, { kind: "add", value: "sixth" }), /tag_limit/);
assert.deepEqual(limit, original, "a rejected bulk operation must not partially modify earlier documents");
for (const value of ["", "#", "x".repeat(33), "control\u0085tag"]) assert.throws(() => changeOrganizationTags(drafts, { kind: "add", value }));
console.log("AI organization preview: effective tree, duplicate folders, moves, exclusions and atomic tag management passed");

// Repeated moves must keep earlier placements when their anchor moves later.
const orderItems = ["a", "b", "c", "d"].map((docId, sortOrder) => ({ docId, title: docId, folderId: "", tags: [], sortOrder }));
let orderDrafts = Object.fromEntries(orderItems.map(item => [item.docId, { selected: true, folderId: "", newPath: "", tags: [] }]));
const rootTarget = { folderId: "", newFolders: [] };
const ids = () => buildOrganizationPreview(orderItems, folders, orderDrafts).root.documents.map(item => item.docId);
orderDrafts = moveOrganizationDocument(orderDrafts, "a", rootTarget, folders, orderItems);
assert.deepEqual(ids(), ["b", "c", "d", "a"]);
orderDrafts = moveOrganizationDocument(orderDrafts, "b", rootTarget, folders, orderItems, { docId: "a", edge: "before" });
assert.deepEqual(ids(), ["c", "d", "b", "a"]);
orderDrafts = moveOrganizationDocument(orderDrafts, "a", rootTarget, folders, orderItems, { docId: "c", edge: "before" });
assert.deepEqual(ids(), ["a", "c", "d", "b"]);
orderDrafts = moveOrganizationDocument(orderDrafts, "d", rootTarget, folders, orderItems, { docId: "a", edge: "after" });
assert.deepEqual(ids(), ["a", "d", "c", "b"]);
assert.deepEqual(organizationPreviewOrders(orderItems, folders, orderDrafts), [{ ...rootTarget, docIds: ["a", "d", "c", "b"] }]);
orderDrafts = moveOrganizationDocument(orderDrafts, "d", { folderId: "work", newFolders: [] }, folders, orderItems);
assert.deepEqual(ids(), ["a", "c", "b"]);
assert.strictEqual(moveOrganizationDocument(orderDrafts, "a", rootTarget, folders, orderItems, { docId: "a", edge: "before" }), orderDrafts);
const onlyC = Object.fromEntries(orderItems.map(item => [item.docId, { selected: item.docId === "c", folderId: "", newPath: "", tags: [] }]));
const above = moveOrganizationDocument(onlyC, "c", rootTarget, folders, orderItems, { docId: "a", edge: "before" });
assert.deepEqual(buildOrganizationPreview(orderItems, folders, above).root.documents.map(item => item.docId), ["c", "a", "b", "d"]);
assert.deepEqual(buildOrganizationPreview(orderItems, folders, {...above,c:{...above.c,selected:false}}).root.documents.map(item => item.docId), ["a", "b", "c", "d"], "deselecting the moved article restores its original position");
console.log("AI organization preview: repeated before/after moves, cross-folder order and deselection passed");

const calendarFolders = [
  { id: "month", name: "2026年8月", parentId: "" },
  { id: "week", name: "第 2 周", parentId: "month" },
  { id: "empty-week", name: "第 3 周", parentId: "month" },
  { id: "manual-date", name: "2026年8月", parentId: "" },
];
const calendarItems = [{ docId: "calendar-doc", title: "SQL", folderId: "week", tags: [] }];
const calendarDrafts = { "calendar-doc": { selected: true, folderId: "", newPath: "Databases", tags: [] } };
const timeFolders = calendarFolders.slice(0, 3).map(folder => ({ ...folder, documentCount: folder.id === "week" ? 1 : 0 }));
const calendarTree = buildOrganizationPreview(calendarItems, calendarFolders, calendarDrafts, [], timeFolders);
assert.equal(calendarTree.removedDirectoryCount, 3);
assert.deepEqual(calendarTree.root.children.map(node => node.name).sort(), ["2026年8月", "Databases"].sort(), "remove empty automatic branches but retain a manually created date folder");
assert.ok(calendarTree.directories.has('["manual-date",[]]'));
const uncheckedCalendar = buildOrganizationPreview(calendarItems, calendarFolders, { "calendar-doc": { ...calendarDrafts["calendar-doc"], selected: false } }, [], timeFolders);
assert.ok(uncheckedCalendar.directories.has('["week",[]]'), "unchecking a move restores the source folder immediately");
const occupiedCalendar = buildOrganizationPreview(calendarItems, calendarFolders, calendarDrafts, [], timeFolders.map(folder => ({ ...folder, documentCount: folder.id === "week" ? 2 : 0 })));
assert.ok(occupiedCalendar.directories.has('["week",[]]'), "excluded, organized or trashed documents outside the preview prevent cleanup");
const manualChild = { id: "manual-child", name: "Reference", parentId: "week" };
assert.ok(buildOrganizationPreview(calendarItems, [...calendarFolders, manualChild], calendarDrafts, [], timeFolders).directories.has('["week",[]]'), "a manual child folder keeps its time-folder ancestors");
assert.ok(buildOrganizationPreview(calendarItems, calendarFolders, calendarDrafts, [{ folderId: "week", newFolders: ["New topic"] }], timeFolders).directories.has('["week",[]]'), "an explicitly created child remains visible");
console.log("AI organization preview: empty time-folder pruning, deselection and occupied/manual folder protection passed");
