import {
  compactTreeSelection,
  flattenVisibleTree,
  rangeSelectionKeys,
  replaceRangeSelection,
  treeSelectionKey,
} from "./_tree_selection_bundle.mjs";

const tree = {
  folders: [
    {
      folderId: "f1",
      name: "One",
      parentFolderId: null,
      folders: [
        {
          folderId: "f2",
          name: "Two",
          parentFolderId: "f1",
          folders: [],
          docs: [{ docId: "c", title: "C", folderId: "f2" }],
        },
      ],
      docs: [{ docId: "b", title: "B", folderId: "f1" }],
    },
  ],
  docs: [{ docId: "a", title: "A", folderId: null }],
};
const visible = flattenVisibleTree(tree, new Set(["f1", "f2"]));
const keys = visible.map(treeSelectionKey);

const expected = ["folder:f1", "folder:f2", "doc:c", "doc:b", "doc:a"];
if (JSON.stringify(keys) !== JSON.stringify(expected)) {
  throw new Error(`visible tree order mismatch: ${JSON.stringify(keys)}`);
}

const range = rangeSelectionKeys(visible, "folder:f1", "doc:b");
if (JSON.stringify(range) !== JSON.stringify(["folder:f1", "folder:f2", "doc:c", "doc:b"])) {
  throw new Error(`range selection mismatch: ${JSON.stringify(range)}`);
}

const shrunk = replaceRangeSelection(
  new Set(["doc:a", "doc:b", "doc:c"]),
  ["doc:a", "doc:b", "doc:c"],
  ["doc:a", "doc:b"],
);
if (JSON.stringify([...shrunk]) !== JSON.stringify(["doc:a", "doc:b"])) {
  throw new Error(`range replacement mismatch: ${JSON.stringify([...shrunk])}`);
}

const compacted = compactTreeSelection(
  [
    { kind: "folder", id: "f1" },
    { kind: "folder", id: "f2" },
    { kind: "doc", id: "c" },
    { kind: "doc", id: "a" },
  ],
  [
    { folderId: "f1", name: "One", parentFolderId: null },
    { folderId: "f2", name: "Two", parentFolderId: "f1" },
  ],
  [
    { docId: "c", title: "C", folderId: "f2" },
    { docId: "a", title: "A", folderId: null },
  ],
);
if (JSON.stringify(compacted) !== JSON.stringify([{ kind: "folder", id: "f1" }, { kind: "doc", id: "a" }])) {
  throw new Error(`nested selection mismatch: ${JSON.stringify(compacted)}`);
}

const collapsed = flattenVisibleTree(tree, new Set());
if (JSON.stringify(collapsed.map(treeSelectionKey)) !== JSON.stringify(["folder:f1", "doc:a"])) {
  throw new Error(`collapsed tree mismatch: ${JSON.stringify(collapsed)}`);
}

console.log("tree selection checks passed");
