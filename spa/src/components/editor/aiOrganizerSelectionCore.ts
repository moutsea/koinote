import type { DocumentSummary, Folder } from "../../api";
import { buildTree, type TreeLevel } from "./tree";

export type OrganizerPickerDocument = Pick<DocumentSummary, "docId" | "title" | "folderId" | "organizedAt">;
export type OrganizerPickerFolder = Pick<Folder, "folderId" | "name" | "parentFolderId" | "organizerKind">;
export type OrganizerSelectionState = "all" | "some" | "none";

// Folders created by date/recency filing, or nested inside one. Their documents
// are selected by default because AI organization discards these buckets.
export function automaticFolderIds(folders: OrganizerPickerFolder[]): Set<string> {
  const byId = new Map(folders.map(folder => [folder.folderId, folder]));
  const result = new Set<string>();
  for (const folder of folders) {
    const seen = new Set<string>();
    let current: OrganizerPickerFolder | undefined = folder;
    while (current && !seen.has(current.folderId)) {
      seen.add(current.folderId);
      if (current.organizerKind) { result.add(folder.folderId); break; }
      current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
    }
  }
  return result;
}

export function defaultOrganizerSelection(folders: OrganizerPickerFolder[], documents: OrganizerPickerDocument[]): Set<string> {
  const automatic = automaticFolderIds(folders);
  return new Set(documents.filter(doc => !doc.organizedAt || (doc.folderId !== null && automatic.has(doc.folderId))).map(doc => doc.docId));
}

export function buildOrganizerPickerTree(folders: OrganizerPickerFolder[], documents: OrganizerPickerDocument[]): TreeLevel {
  return buildTree(folders, documents);
}

export function documentIdsIn(level: TreeLevel): string[] {
  return [...level.folders.flatMap(documentIdsIn), ...level.docs.map(doc => doc.docId)];
}

export function organizerSelectionState(ids: string[], selected: ReadonlySet<string>): OrganizerSelectionState {
  const count = ids.filter(id => selected.has(id)).length;
  return count === 0 ? "none" : count === ids.length ? "all" : "some";
}

export function toggleOrganizerSelection(selected: ReadonlySet<string>, ids: string[], checked: boolean): Set<string> {
  const next = new Set(selected);
  for (const id of ids) {
    if (checked) next.add(id); else next.delete(id);
  }
  return next;
}

// Stable request order (library order) so equal selections share estimates.
export function organizerRequestIds(documents: OrganizerPickerDocument[], selected: ReadonlySet<string>, unavailable: ReadonlySet<string>): string[] {
  return documents.map(doc => doc.docId).filter(id => selected.has(id) && !unavailable.has(id));
}
