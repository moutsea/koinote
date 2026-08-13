export const CONFLICT_DRAFT_PREFIX = "koinote:conflict-draft:";

export const conflictDraftKey = (docId: string) =>
  `${CONFLICT_DRAFT_PREFIX}${docId}`;

export function clearAllConflictDrafts() {
  if (typeof window === "undefined") return;
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(CONFLICT_DRAFT_PREFIX)) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // 浏览器可能禁用 localStorage；登出本身不能因此失败。
  }
}
