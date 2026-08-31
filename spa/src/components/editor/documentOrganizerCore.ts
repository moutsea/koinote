import type { DocumentSummary, Folder } from "../../api";

export const ORGANIZER_BUCKET_LIMIT = 20;

export type DocumentOrganizerStrategy = "smart" | "activity";

export type DocumentOrganizerLabels = {
  unknownDate: string;
  weekOfMonth: string;
  activityRecent7: string;
  activityRecent30: string;
  activityRecent90: string;
  activityInactive: string;
  activityArchive: string;
};

export type DocumentOrganizationAssignment = {
  docId: string;
  path: string[];
};

export type DocumentOrganizationGroup = {
  path: string[];
  count: number;
};

export type DocumentOrganizationPlan = {
  strategy: DocumentOrganizerStrategy;
  assignments: DocumentOrganizationAssignment[];
  groups: DocumentOrganizationGroup[];
  documentCount: number;
  folderCount: number;
};

export function documentOrganizerFolderKey(
  parentFolderId: string | null,
  organizerKind: DocumentOrganizerStrategy,
  name: string,
): string {
  return JSON.stringify([parentFolderId, organizerKind, name]);
}

type DatedDocument = {
  document: DocumentSummary;
  date: Date | null;
};

type ActivityBucket =
  | "recent7"
  | "recent30"
  | "recent90"
  | "inactive"
  | "archive";

const DAY_MS = 24 * 60 * 60 * 1_000;

export function buildDocumentOrganizationPlan(
  documents: DocumentSummary[],
  folders: Folder[],
  strategy: DocumentOrganizerStrategy,
  locale: string,
  labels: DocumentOrganizerLabels,
  now = new Date(),
): DocumentOrganizationPlan {
  const organizerFolderIds = organizerScopeFolderIds(folders);
  const eligibleDocuments = documents.filter((document) =>
    document.folderId === null || organizerFolderIds.has(document.folderId),
  );
  const assignments =
    strategy === "smart"
      ? buildSmartAssignments(eligibleDocuments, locale, labels)
      : buildActivityAssignments(eligibleDocuments, locale, labels, now);
  return {
    strategy,
    assignments,
    groups: summarizeGroups(assignments),
    documentCount: assignments.length,
    folderCount: countFolders(assignments),
  };
}

export function isDocumentInOrganizerScope(
  document: Pick<DocumentSummary, "folderId">,
  folders: Folder[],
): boolean {
  return document.folderId === null || isFolderInOrganizerScope(document.folderId, folders);
}

export function countDocumentOrganizationMoves(
  plan: DocumentOrganizationPlan,
  documents: Pick<DocumentSummary, "docId" | "folderId">[],
  folders: Folder[],
): number {
  const documentById = new Map(
    documents.map((document) => [document.docId, document]),
  );
  const folderByLocation = new Map<string, Folder>();
  for (const folder of folders) {
    if (!folder.organizerKind) continue;
    const key = documentOrganizerFolderKey(
      folder.parentFolderId,
      folder.organizerKind,
      folder.name,
    );
    const existing = folderByLocation.get(key);
    if (!existing || folder.folderId < existing.folderId) {
      folderByLocation.set(key, folder);
    }
  }

  return plan.assignments.reduce((count, assignment) => {
    const document = documentById.get(assignment.docId);
    if (!document) return count;

    let parentFolderId: string | null = null;
    for (const name of assignment.path) {
      const folder = folderByLocation.get(
        documentOrganizerFolderKey(parentFolderId, plan.strategy, name),
      );
      if (!folder) return count + 1;
      parentFolderId = folder.folderId;
    }

    return document.folderId === parentFolderId ? count : count + 1;
  }, 0);
}

export function isFolderInOrganizerScope(
  folderId: string,
  folders: Folder[],
): boolean {
  return organizerScopeFolderIds(folders).has(folderId);
}

export function organizerScopeFolderIds(folders: Folder[]): Set<string> {
  const folderById = new Map(folders.map((folder) => [folder.folderId, folder]));
  const state = new Map<string, "visiting" | "included" | "excluded">();

  function includes(folderId: string): boolean {
    const known = state.get(folderId);
    if (known === "included") return true;
    if (known === "excluded" || known === "visiting") return false;

    state.set(folderId, "visiting");
    const folder = folderById.get(folderId);
    const included = Boolean(
      folder?.organizerKind &&
        (folder.parentFolderId === null || includes(folder.parentFolderId)),
    );
    state.set(folderId, included ? "included" : "excluded");
    return included;
  }

  const included = new Set<string>();
  for (const folder of folders) {
    if (includes(folder.folderId)) included.add(folder.folderId);
  }
  return included;
}

function buildSmartAssignments(
  documents: DocumentSummary[],
  locale: string,
  labels: DocumentOrganizerLabels,
): DocumentOrganizationAssignment[] {
  const dated = documents.map((document) => ({
    document,
    date: parseDate(document.createdAt) ?? parseDate(document.updatedAt),
  }));
  const byMonth = groupBy(dated, (item) =>
    item.date ? monthKey(item.date) : "unknown",
  );
  const assignments: DocumentOrganizationAssignment[] = [];

  for (const [key, items] of sortedEntries(byMonth)) {
    if (key === "unknown") {
      assign(items, [labels.unknownDate], assignments);
      continue;
    }
    assignAdaptiveMonth(
      items,
      [formatMonth(items[0].date!, locale)],
      locale,
      labels,
      assignments,
    );
  }
  return assignments;
}

function buildActivityAssignments(
  documents: DocumentSummary[],
  locale: string,
  labels: DocumentOrganizerLabels,
  now: Date,
): DocumentOrganizationAssignment[] {
  const dated = documents.map((document) => ({
    document,
    date: parseDate(document.updatedAt) ?? parseDate(document.createdAt),
  }));
  const bucketOrder: ActivityBucket[] = [
    "recent7",
    "recent30",
    "recent90",
    "inactive",
    "archive",
  ];
  const byActivity = groupBy(dated, (item) => activityBucket(item.date, now));
  const assignments: DocumentOrganizationAssignment[] = [];

  for (const bucket of bucketOrder) {
    const items = byActivity.get(bucket) ?? [];
    if (items.length === 0) continue;
    const bucketPath = [activityLabel(bucket, labels)];
    if (items.length <= ORGANIZER_BUCKET_LIMIT) {
      assign(items, bucketPath, assignments);
      continue;
    }

    const byMonth = groupBy(items, (item) =>
      item.date ? monthKey(item.date) : "unknown",
    );
    for (const [key, monthItems] of sortedEntries(byMonth)) {
      if (key === "unknown") {
        assign(monthItems, [...bucketPath, labels.unknownDate], assignments);
        continue;
      }
      assignAdaptiveMonth(
        monthItems,
        [...bucketPath, formatMonth(monthItems[0].date!, locale)],
        locale,
        labels,
        assignments,
      );
    }
  }
  return assignments;
}

function assignAdaptiveMonth(
  items: DatedDocument[],
  monthPath: string[],
  locale: string,
  labels: DocumentOrganizerLabels,
  assignments: DocumentOrganizationAssignment[],
) {
  if (items.length <= ORGANIZER_BUCKET_LIMIT) {
    assign(items, monthPath, assignments);
    return;
  }

  const byWeek = groupBy(items, (item) => weekOfMonth(item.date!));
  for (const [week, weekItems] of sortedEntries(byWeek)) {
    const weekPath = [
      ...monthPath,
      labels.weekOfMonth.replace("{n}", () => String(week)),
    ];
    if (weekItems.length <= ORGANIZER_BUCKET_LIMIT) {
      assign(weekItems, weekPath, assignments);
      continue;
    }

    const byDay = groupBy(weekItems, (item) => dayKey(item.date!));
    for (const dayItems of sortedEntries(byDay).map((entry) => entry[1])) {
      assign(
        dayItems,
        [...weekPath, formatDay(dayItems[0].date!, locale)],
        assignments,
      );
    }
  }
}

function assign(
  items: DatedDocument[],
  path: string[],
  assignments: DocumentOrganizationAssignment[],
) {
  for (const item of items) assignments.push({ docId: item.document.docId, path });
}

function activityBucket(date: Date | null, now: Date): ActivityBucket {
  if (!date) return "archive";
  const age = Math.max(0, calendarDay(now) - calendarDay(date));
  if (age <= 7) return "recent7";
  if (age <= 30) return "recent30";
  if (age <= 90) return "recent90";
  if (age <= 365) return "inactive";
  return "archive";
}

function activityLabel(
  bucket: ActivityBucket,
  labels: DocumentOrganizerLabels,
): string {
  switch (bucket) {
    case "recent7":
      return labels.activityRecent7;
    case "recent30":
      return labels.activityRecent30;
    case "recent90":
      return labels.activityRecent90;
    case "inactive":
      return labels.activityInactive;
    case "archive":
      return labels.activityArchive;
  }
}

function summarizeGroups(
  assignments: DocumentOrganizationAssignment[],
): DocumentOrganizationGroup[] {
  const groups = new Map<string, DocumentOrganizationGroup>();
  for (const assignment of assignments) {
    const key = JSON.stringify(assignment.path);
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { path: assignment.path, count: 1 });
  }
  return [...groups.values()];
}

function countFolders(assignments: DocumentOrganizationAssignment[]): number {
  if (assignments.length === 0) return 0;
  const paths = new Set<string>();
  for (const assignment of assignments) {
    for (let index = 1; index <= assignment.path.length; index += 1) {
      paths.add(JSON.stringify(assignment.path.slice(0, index)));
    }
  }
  return paths.size;
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

function sortedEntries<T>(groups: Map<string, T[]>): Array<[string, T[]]> {
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function dayKey(date: Date): string {
  return `${monthKey(date)}-${String(date.getDate()).padStart(2, "0")}`;
}

function weekOfMonth(date: Date): string {
  return String(Math.ceil(date.getDate() / 7));
}

function calendarDay(date: Date): number {
  return Math.floor(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS,
  );
}

function formatMonth(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
  }).format(date);
}

function formatDay(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  }).format(date);
}
