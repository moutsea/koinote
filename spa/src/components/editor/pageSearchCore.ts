const MAX_PAGE_SEARCH_MATCHES = 2_000;

export type TextMatch = { from: number; to: number };

function escapedLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findTextMatches(
  text: string,
  rawQuery: string,
  limit = MAX_PAGE_SEARCH_MATCHES,
  allowOverlaps = false,
): TextMatch[] {
  const query = rawQuery;
  if (!query || query.includes("\u0000") || limit <= 0) return [];

  const matches: TextMatch[] = [];
  const pattern = new RegExp(escapedLiteral(query), "giu");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const from = match.index;
    const value = match[0];
    if (from === undefined || !value) continue;
    matches.push({ from, to: from + value.length });
    if (matches.length >= limit) break;
    if (allowOverlaps) {
      // Under the Unicode flag, starting inside a surrogate pair can match
      // the same character again. Advance by one complete code point.
      pattern.lastIndex = from + (text.codePointAt(from)! > 0xffff ? 2 : 1);
    }
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

type PageSearchKeyEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
};

function isDocumentShortcut(event: PageSearchKeyEvent, key: string): boolean {
  return (
    !event.isComposing &&
    !event.altKey &&
    !event.shiftKey &&
    event.metaKey !== event.ctrlKey &&
    event.key.toLowerCase() === key
  );
}

export function isPageSearchShortcut(event: PageSearchKeyEvent): boolean {
  return isDocumentShortcut(event, "f");
}

export function isPageReplaceShortcut(event: PageSearchKeyEvent): boolean {
  return isDocumentShortcut(event, "r");
}

export { MAX_PAGE_SEARCH_MATCHES };
