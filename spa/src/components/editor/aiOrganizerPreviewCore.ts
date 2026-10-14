import type { OrganizationFolder, OrganizationItem, OrganizationOrder, OrganizationTimeFolder } from "../../api";
import { organizationChoices, organizationDestination, type OrganizationDraft } from "./aiOrganizerCore";

export type PreviewDestination = { folderId: string; newFolders: string[] };
export type PreviewDirectory = PreviewDestination & {
  key: string; name: string; path: string[]; children: PreviewDirectory[];
  documents: OrganizationItem[]; count: number;
};
export const previewDirectoryKey = (target: PreviewDestination) => JSON.stringify([target.folderId, target.newFolders]);

export function buildOrganizationPreview(items: OrganizationItem[], folders: OrganizationFolder[], drafts: Record<string, OrganizationDraft>, extras: PreviewDestination[] = [], timeFolders: OrganizationTimeFolder[] = []) {
  const root: PreviewDirectory = { key: previewDirectoryKey({ folderId: "", newFolders: [] }), name: "", folderId: "", newFolders: [], path: [], children: [], documents: [], count: 0 };
  const directories = new Map<string, PreviewDirectory>([[root.key, root]]);
  const folderMap = new Map(folders.map(folder => [folder.id, folder]));
  function existing(id: string, seen = new Set<string>()): PreviewDirectory {
    const key = previewDirectoryKey({ folderId: id, newFolders: [] });
    const cached = directories.get(key);
    if (cached) return cached;
    const folder = folderMap.get(id);
    if (!folder || seen.has(id)) throw new Error("invalid_organization");
    seen.add(id);
    const parent = existing(folder.parentId, seen);
    const node: PreviewDirectory = { key, name: folder.name, folderId: id, newFolders: [], path: [...parent.path, folder.name], children: [], documents: [], count: 0 };
    directories.set(key, node); parent.children.push(node);
    return node;
  }
  for (const folder of folders) existing(folder.id);
  function destination(target: PreviewDestination) {
    const resolved = organizationDestination(folders, target.folderId, target.newFolders);
    let parent = existing(resolved.folderId);
    resolved.newFolders.forEach((name, index) => {
      const newFolders = resolved.newFolders.slice(0, index + 1);
      const key = previewDirectoryKey({ folderId: resolved.folderId, newFolders });
      let node = directories.get(key);
      if (!node) {
        node = { key, name, folderId: resolved.folderId, newFolders, path: [...parent.path, name], children: [], documents: [], count: 0 };
        directories.set(key, node); parent.children.push(node);
      }
      parent = node;
    });
    return parent;
  }
  for (const extra of extras) destination(extra);
  const locations = new Map<string, PreviewDirectory>();
  for (const item of items) {
    const draft = drafts[item.docId];
    let node = existing(item.folderId);
    if (draft?.selected) {
      try {
        // An unfinished tag edit should not hide a valid destination.
        const [choice] = organizationChoices({ [item.docId]: { ...draft, tags: [] } }, folders);
        node = destination(choice);
      } catch { /* Keep invalid path edits visible at the original location. */ }
    }
    node.documents.push(item); locations.set(item.docId, node);
  }
  const itemOrder = new Map(items.map((item, index) => [item.docId, index]));
  function sort(node: PreviewDirectory): number {
    node.children.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
    // Match apply: existing documents retain their order, incoming documents
    // append in snapshot order. Replay only explicit, still-selected moves.
    const staying = (item: OrganizationItem) => !node.newFolders.length && item.folderId === node.folderId;
    node.documents.sort((a, b) => Number(staying(b)) - Number(staying(a)) ||
      (staying(a) ? (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.docId.localeCompare(b.docId) : itemOrder.get(a.docId)! - itemOrder.get(b.docId)!));
    const placements = node.documents.filter(item => drafts[item.docId]?.selected && drafts[item.docId].placement)
      .sort((a, b) => drafts[a.docId].placement!.sequence - drafts[b.docId].placement!.sequence);
    for (const item of placements) {
      const placement = drafts[item.docId].placement!;
      node.documents.splice(node.documents.indexOf(item), 1);
      const anchor = node.documents.findIndex(candidate => candidate.docId === placement.anchorDocId);
      node.documents.splice(anchor < 0 ? node.documents.length : anchor + (placement.edge === "after" ? 1 : 0), 0, item);
    }
    node.count = node.documents.length + node.children.reduce((total, child) => total + sort(child), 0);
    return node.count;
  }
  sort(root);
  const timeFolderCounts = new Map(timeFolders.map(folder => [folder.id, folder.documentCount]));
  const originalCounts = new Map<string, number>();
  for (const item of items) originalCounts.set(item.folderId, (originalCounts.get(item.folderId) ?? 0) + 1);
  let removedDirectoryCount = 0;
  function retain(node: PreviewDirectory): boolean {
    node.children = node.children.filter(retain);
    const count = timeFolderCounts.get(node.folderId);
    // Counts include excluded/previously organized articles and trash. A
    // folder absent from this preview can still contain real documents.
    const outsidePreview = Math.max(0, (count ?? 0) - (originalCounts.get(node.folderId) ?? 0));
    if (node !== root && !node.newFolders.length && count !== undefined && !outsidePreview && !node.documents.length && !node.children.length) {
      directories.delete(node.key);
      removedDirectoryCount++;
      return false;
    }
    return true;
  }
  retain(root);
  return { root, directories, locations, removedDirectoryCount };
}

export function moveOrganizationDocument(drafts: Record<string, OrganizationDraft>, docId: string, target: PreviewDestination, folders: OrganizationFolder[], items: OrganizationItem[], anchor?: { docId: string; edge: "before" | "after" }) {
  const draft = drafts[docId];
  if (!draft || anchor?.docId === docId) return drafts;
  const next = { ...draft, selected: true, folderId: target.folderId, newPath: target.newFolders.join("/") };
  // Moving does not discard or validate an unfinished tag edit.
  organizationChoices({ [docId]: { ...next, tags: [] } }, folders);
  const tree = buildOrganizationPreview(items, folders, drafts, [target]);
  const destination = tree.directories.get(previewDirectoryKey(organizationDestination(folders, target.folderId, target.newFolders)))!;
  const ordered = destination.documents.filter(item => item.docId !== docId);
  const item = items.find(value => value.docId === docId);
  if (!item) return drafts;
  const anchorIndex = ordered.findIndex(value => value.docId === anchor?.docId);
  ordered.splice(anchorIndex < 0 ? ordered.length : anchorIndex + (anchor?.edge === "after" ? 1 : 0), 0, item);
  const result = { ...drafts, [docId]: next };
  let sequence = Math.max(0, ...Object.values(drafts).map(value => value.placement?.sequence ?? 0));
  function retainOrder(documents: OrganizationItem[]) {
    // Rebuild the selected siblings from the end. This keeps earlier moves in
    // place when an article that was used as an anchor is dragged again.
    for (let i = documents.length - 1; i >= 0; i--) {
      const id = documents[i].docId;
      if (!result[id]?.selected) continue;
      result[id] = { ...result[id], placement: { sequence: ++sequence, ...(documents[i + 1] ? { anchorDocId: documents[i + 1].docId, edge: "before" as const } : {}) } };
    }
  }
  const source = tree.locations.get(docId);
  if (source && source !== destination) retainOrder(source.documents.filter(value => value.docId !== docId));
  retainOrder(ordered);
  return result;
}

// Send complete visible sibling order only for directories with explicit moves.
// Unchecked siblings are anchors; the server preserves their relative order.
export function organizationPreviewOrders(items: OrganizationItem[], folders: OrganizationFolder[], drafts: Record<string, OrganizationDraft>): OrganizationOrder[] {
  const tree = buildOrganizationPreview(items, folders, drafts);
  return [...tree.directories.values()].filter(node => node.documents.some(item => drafts[item.docId]?.selected && drafts[item.docId].placement))
    .map(node => ({ folderId: node.folderId, newFolders: node.newFolders, docIds: node.documents.map(item => item.docId) }));
}

export function normalizePreviewTag(value: string): string {
  return value.trim().replace(/^#/, "").trim();
}
export function previewTagCounts(drafts: Record<string, OrganizationDraft>) {
  const counts = new Map<string, { name: string; count: number }>();
  for (const draft of Object.values(drafts)) {
    if (!draft.selected) continue;
    for (const key of new Set(draft.tags.map(normalizePreviewTag).filter(Boolean).map(tag => tag.toLowerCase()))) {
      const tag = counts.get(key) ?? { name: draft.tags.map(normalizePreviewTag).find(tag => tag.toLowerCase() === key)!, count: 0 };
      tag.count++; counts.set(key, tag);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export type PreviewTagChange = { kind: "add"; value: string } | { kind: "rename"; from: string; value: string } | { kind: "remove"; from: string };
export function changeOrganizationTags(drafts: Record<string, OrganizationDraft>, change: PreviewTagChange) {
  const value = change.kind === "remove" ? "" : normalizePreviewTag(change.value);
  if (change.kind !== "remove" && (!value || [...value].length > 32 || /[\x00-\x1f\x7f-\x9f]/.test(value))) throw new Error("invalid_organization");
  const from = change.kind === "add" ? "" : normalizePreviewTag(change.from).toLowerCase();
  const result = { ...drafts };
  for (const [docId, draft] of Object.entries(drafts)) {
    if (!draft.selected) continue;
    const matches = draft.tags.some(tag => normalizePreviewTag(tag).toLowerCase() === from);
    if (change.kind !== "add" && !matches) continue;
    const seen = new Set<string>();
    const tags = (change.kind === "add" ? [...draft.tags, value] : draft.tags.map(tag => normalizePreviewTag(tag).toLowerCase() === from ? value : tag))
      .map(normalizePreviewTag).filter(tag => {
        const key = tag.toLowerCase();
        if (!tag || seen.has(key)) return false;
        seen.add(key); return true;
      });
    if (tags.length > 5) throw new Error("organization_tag_limit");
    result[docId] = { ...draft, tags };
  }
  return result;
}
