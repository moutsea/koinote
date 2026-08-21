export type GlobalSearchMode = "fulltext" | "quick-open";
export type GlobalSearchPlatform = "mac" | "other";

export type GlobalSearchShortcutEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
};

export type QuickOpenDocument = {
  docId: string;
  title: string;
};

function matchingQuickOpenDocuments<T extends QuickOpenDocument>(
  documents: readonly T[],
  query: string,
): readonly T[] {
  const normalized = query.trim().toLocaleLowerCase();
  return normalized
    ? documents.filter((document) =>
        document.title.toLocaleLowerCase().includes(normalized),
      )
    : documents;
}

export function detectGlobalSearchPlatform(
  platform: string,
  userAgent: string,
): GlobalSearchPlatform {
  return /Mac|iPhone|iPad|iPod/i.test(`${platform} ${userAgent}`)
    ? "mac"
    : "other";
}

export function globalSearchShortcutMode(
  event: GlobalSearchShortcutEvent,
  platform: GlobalSearchPlatform,
  desktop: boolean,
): GlobalSearchMode | null {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.repeat ||
    event.altKey ||
    event.ctrlKey === event.metaKey
  ) {
    return null;
  }

  const key = event.key.toLowerCase();
  if (key === "k" && !event.shiftKey) return "fulltext";
  if (!desktop) return null;

  const primaryModifier =
    platform === "mac" ? event.metaKey : event.ctrlKey;
  if (!primaryModifier) return null;

  if (key === "p" && !event.shiftKey) return "quick-open";
  if (key === "f" && event.shiftKey) return "fulltext";
  return null;
}

export function filterQuickOpenDocuments<T extends QuickOpenDocument>(
  documents: readonly T[],
  query: string,
  limit = 50,
): T[] {
  if (limit <= 0) return [];
  return matchingQuickOpenDocuments(documents, query).slice(0, limit);
}

export function countQuickOpenDocuments(
  documents: readonly QuickOpenDocument[],
  query: string,
): number {
  return matchingQuickOpenDocuments(documents, query).length;
}

export function nextGlobalSearchIndex(
  current: number,
  total: number,
  direction: 1 | -1,
): number {
  if (total <= 0) return -1;
  if (current < 0 || current >= total) return direction === 1 ? 0 : total - 1;
  return (current + direction + total) % total;
}
