import type { DocumentOrganization, OrganizationChoice, OrganizationFolder, OrganizationItem } from "../../api";

export type OrganizationDraft = { selected: boolean; folderId: string; newPath: string; tags: string[] };
export function organizationDrafts(items: OrganizationItem[]): Record<string, OrganizationDraft> {
  return Object.fromEntries(items.filter(item => item.suggested).map(item => [item.docId, {
    selected: !item.needsReview, folderId: item.suggested!.folderId,
    newPath: item.suggested!.newFolders.join("/"), tags: [...item.suggested!.tags],
  }]));
}
export function organizationPath(folders: OrganizationFolder[], id: string): string[] {
  const path: string[] = []; const seen = new Set<string>();
  while (id) {
    if (seen.has(id)) throw new Error("invalid_organization"); seen.add(id);
    const folder = folders.find(f => f.id === id);
    if (!folder) throw new Error("invalid_organization");
    path.unshift(folder.name); id = folder.parentId;
  }
  return path;
}
export function organizationChoices(drafts: Record<string, OrganizationDraft>, folders: OrganizationFolder[]): OrganizationChoice[] {
  return Object.entries(drafts).filter(([, draft]) => draft.selected).map(([docId, draft]) => {
    const newFolders = draft.newPath.trim() ? draft.newPath.split("/").map(name => name.trim()) : [];
    const seen = new Set<string>();
    const tags = draft.tags.map(tag => tag.trim().replace(/^#/, "").trim()).filter(tag => {
      if (!tag || seen.has(tag.toLowerCase())) return false;
      seen.add(tag.toLowerCase()); return true;
    });
    const path = organizationPath(folders, draft.folderId);
    if (path.length + newFolders.length > 8 || newFolders.some(name => !name || name === "." || name === ".." || /[\\\x00-\x1f\x7f-\x9f]/.test(name) || [...name].length > 60) || tags.length > 5 || tags.some(tag => [...tag].length > 32 || /[\x00-\x1f\x7f-\x9f]/.test(tag))) throw new Error("invalid_organization");
    return { docId, folderId: draft.folderId, newFolders, tags };
  });
}

// A restored running task can have no detail data yet. Keep polling after a
// transient first-read failure, but stop for terminal HTTP errors or statuses.
export function organizationPollInterval(
  status: DocumentOrganization["status"] | undefined,
  knownStatus?: DocumentOrganization["status"],
  errorStatus?: number,
): number | false {
  if (errorStatus && errorStatus >= 400 && errorStatus < 500 && errorStatus !== 408 && errorStatus !== 429) return false;
  return (status ?? knownStatus) === "running" ? (errorStatus ? 5000 : 1500) : false;
}
