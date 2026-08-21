const MAX_PAGE_SEARCH_MATCHES = 2_000;

export type TextMatch = { from: number; to: number };

function escapedLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findTextMatches(
  text: string,
  rawQuery: string,
  limit = MAX_PAGE_SEARCH_MATCHES,
): TextMatch[] {
  const query = rawQuery.trim();
  if (!query || limit <= 0) return [];

  const matches: TextMatch[] = [];
  const pattern = new RegExp(escapedLiteral(query), "giu");
  for (const match of text.matchAll(pattern)) {
    const from = match.index;
    const value = match[0];
    if (from === undefined || !value) continue;
    matches.push({ from, to: from + value.length });
    if (matches.length >= limit) break;
  }
  return matches;
}

export function nextPageSearchIndex(
  current: number,
  total: number,
  direction: 1 | -1,
): number {
  if (total <= 0) return -1;
  if (current < 0 || current >= total) return direction > 0 ? 0 : total - 1;
  return (current + direction + total) % total;
}

export function isPageSearchShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
}): boolean {
  return (
    !event.isComposing &&
    !event.altKey &&
    !event.shiftKey &&
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "f"
  );
}

export { MAX_PAGE_SEARCH_MATCHES };
