import type { DocNode, FolderNode, TreeLevel } from "./tree";

export type TreeSelectionItem =
  | { kind: "doc"; id: string; revision?: number }
  | { kind: "folder"; id: string };

export type VisibleTreeItem = TreeSelectionItem & { depth: number };

export function treeSelectionKey(item: TreeSelectionItem): string {
  return `${item.kind}:${item.id}`;
}

export function flattenVisibleTree(
  level: TreeLevel,
  expanded: Set<string>,
  depth = 0,
): VisibleTreeItem[] {
  const result: VisibleTreeItem[] = [];
  for (const folder of level.folders) {
    result.push({ kind: "folder", id: folder.folderId, depth });
    if (expanded.has(folder.folderId)) {
      result.push(...flattenVisibleTree(folder, expanded, depth + 1));
    }
  }
  for (const doc of level.docs) {
    result.push({ kind: "doc", id: doc.docId, depth });
  }
  return result;
}

export function rangeSelectionKeys(
  items: VisibleTreeItem[],
  anchorKey: string | null,
  targetKey: string,
): string[] {
  const targetIndex = items.findIndex((item) => treeSelectionKey(item) === targetKey);
  if (targetIndex < 0) return [targetKey];
  const anchorIndex = anchorKey
    ? items.findIndex((item) => treeSelectionKey(item) === anchorKey)
    : -1;
  if (anchorIndex < 0) return [targetKey];
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return items.slice(start, end + 1).map(treeSelectionKey);
}

export function replaceRangeSelection(
  selectedKeys: Iterable<string>,
  previousRange: Iterable<string>,
  nextRange: Iterable<string>,
): Set<string> {
  const next = new Set(selectedKeys);
  for (const key of previousRange) next.delete(key);
  for (const key of nextRange) next.add(key);
  return next;
}

export function compactTreeSelection(
  items: TreeSelectionItem[],
  folders: FolderNode[],
  docs: DocNode[],
): TreeSelectionItem[] {
  const selectedFolderIDs = new Set(
    items.filter((item) => item.kind === "folder").map((item) => item.id),
  );
  const folderByID = new Map(folders.map((folder) => [folder.folderId, folder]));
  const isInsideSelectedFolder = (folderID: string | null): boolean => {
    const walked = new Set<string>();
    let current = folderID;
    while (current) {
      if (selectedFolderIDs.has(current)) return true;
      if (walked.has(current)) return false;
      walked.add(current);
      current = folderByID.get(current)?.parentFolderId ?? null;
    }
    return false;
  };

  return items.filter((item) => {
    if (item.kind === "folder") {
      const folder = folderByID.get(item.id);
      return !folder || !isInsideSelectedFolder(folder.parentFolderId);
    }
    const document = docs.find((doc) => doc.docId === item.id);
    return !document || !isInsideSelectedFolder(document.folderId);
  }).map((item) => {
    if (item.kind !== "doc" || item.revision !== undefined) return item;
    const document = docs.find((doc) => doc.docId === item.id);
    return document ? { ...item, revision: document.revision } : item;
  });
}
