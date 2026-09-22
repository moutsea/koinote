type DocumentScrollPosition = {
  scrollTop: number;
  scrollLeft: number;
};

const positions = new Map<string, DocumentScrollPosition>();
const STORAGE_PREFIX = "koinote:document-scroll:";
const MAX_FALLBACK_RESTORE_FRAMES = 120;
const MAX_REMEMBERED_POSITIONS = 500;

function rememberPosition(key: string, position: DocumentScrollPosition) {
  positions.delete(key);
  positions.set(key, position);
  if (positions.size > MAX_REMEMBERED_POSITIONS) {
    const oldest = positions.keys().next().value;
    if (oldest !== undefined) positions.delete(oldest);
  }
}

export function pruneDocumentScrollPositions(docIds: readonly string[], scope = "") {
  const normalizedScope = scope.trim();
  const memoryPrefix = normalizedScope ? `${normalizedScope}\u0000` : "";
  const persistedPrefix = normalizedScope ? `${STORAGE_PREFIX}${encodeURIComponent(normalizedScope)}:` : STORAGE_PREFIX;
  const keepMemory = new Set(docIds.map((docId) => positionKey(docId, normalizedScope)));
  const keepStorage = new Set(docIds.map((docId) => storageKey(docId, normalizedScope)));
  for (const key of positions.keys()) {
    if ((normalizedScope ? key.startsWith(memoryPrefix) : !key.includes("\u0000")) && !keepMemory.has(key)) positions.delete(key);
  }
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(persistedPrefix)) continue;
      if (!normalizedScope && key.slice(STORAGE_PREFIX.length).includes(":")) continue;
      if (!keepStorage.has(key)) window.localStorage.removeItem(key);
    }
  } catch {}
}

function positionKey(docId: string, scope: string): string {
  return scope ? `${scope}\u0000${docId}` : docId;
}

function storageKey(docId: string, scope: string): string {
  if (!scope) return STORAGE_PREFIX + docId;
  return `${STORAGE_PREFIX}${encodeURIComponent(scope)}:${encodeURIComponent(docId)}`;
}

function readPosition(docId: string, scope: string): DocumentScrollPosition | null {
  const remembered = positions.get(positionKey(docId, scope));
  if (remembered) return remembered;
  try {
    const stored = window.localStorage.getItem(storageKey(docId, scope));
    if (!stored) return null;
    const position = JSON.parse(stored) as DocumentScrollPosition;
    if (
      !Number.isFinite(position?.scrollTop) || position.scrollTop < 0 ||
      !Number.isFinite(position?.scrollLeft) || position.scrollLeft < 0
    ) return null;
    rememberPosition(positionKey(docId, scope), position);
    return position;
  } catch {
    return null;
  }
}

export function trackDocumentScrollPosition(
  docId: string,
  container: HTMLElement,
  scope = "",
): () => void {
  const normalizedScope = scope.trim();
  const memoryKey = positionKey(docId, normalizedScope);
  const persistedKey = storageKey(docId, normalizedScope);
  const remembered = readPosition(docId, normalizedScope);
  let position = remembered ?? { scrollTop: 0, scrollLeft: 0 };
  let restoring = remembered !== null;
  let frame: number | undefined;
  let saveTimer: number | undefined;
  let observer: ResizeObserver | undefined;
  let fallbackRestoreFrames = 0;
  let disposed = false;

  const persist = () => {
    if (saveTimer !== undefined) window.clearTimeout(saveTimer);
    saveTimer = undefined;
    rememberPosition(memoryKey, position);
    try {
      window.localStorage.setItem(persistedKey, JSON.stringify(position));
    } catch {}
  };

  const remember = () => {
    if (disposed || restoring || container.clientHeight === 0) return;
    position = {
      scrollTop: Math.max(0, container.scrollTop),
      scrollLeft: Math.max(0, container.scrollLeft),
    };
    rememberPosition(memoryKey, position);
    if (saveTimer !== undefined) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(persist, 200);
  };

  const saveCurrentPosition = () => {
    remember();
    persist();
  };

  const stopRestoring = () => {
    restoring = false;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
    observer?.disconnect();
  };

  const interruptRestore = () => {
    if (!restoring) return;
    stopRestoring();
    remember();
  };

  const restore = () => {
    if (disposed || !restoring || container.clientHeight === 0) return;
    container.scrollTop = position.scrollTop;
    container.scrollLeft = position.scrollLeft;
  };

  const finishRestore = () => {
    restore();
    if (
      container.clientHeight > 0 &&
      Math.abs(container.scrollTop - position.scrollTop) < 1 &&
      Math.abs(container.scrollLeft - position.scrollLeft) < 1
    ) stopRestoring();
  };

  if (restoring) {
    const hasResizeObserver = typeof ResizeObserver !== "undefined";
    if (hasResizeObserver) {
      observer = new ResizeObserver(() => {
        if (frame === undefined) finishRestore();
        else restore();
      });
      observer.observe(container);
      const content = container.querySelector("[data-koinote-print-source]");
      if (content) observer.observe(content);
    }
    restore();
    const retryRestore = () => {
      if (disposed || !restoring) return;
      frame = undefined;
      finishRestore();
      if (!hasResizeObserver && restoring && fallbackRestoreFrames < MAX_FALLBACK_RESTORE_FRAMES) {
        fallbackRestoreFrames += 1;
        frame = window.requestAnimationFrame(retryRestore);
      }
    };
    frame = window.requestAnimationFrame(() => {
      restore();
      frame = window.requestAnimationFrame(retryRestore);
    });
  }

  container.addEventListener("scroll", remember, { passive: true });
  container.addEventListener("wheel", interruptRestore, { passive: true });
  container.addEventListener("touchstart", interruptRestore, { passive: true });
  container.addEventListener("pointerdown", interruptRestore, { passive: true });
  container.addEventListener("keydown", interruptRestore);
  window.addEventListener("pagehide", saveCurrentPosition);

  return () => {
    saveCurrentPosition();
    disposed = true;
    stopRestoring();
    container.removeEventListener("scroll", remember);
    container.removeEventListener("wheel", interruptRestore);
    container.removeEventListener("touchstart", interruptRestore);
    container.removeEventListener("pointerdown", interruptRestore);
    container.removeEventListener("keydown", interruptRestore);
    window.removeEventListener("pagehide", saveCurrentPosition);
  };
}
