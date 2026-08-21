export type EditorShortcutPlatform = "mac" | "other";
export type NumberedTabShortcut = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
type NumberedTabShortcutAction = `select-tab-${NumberedTabShortcut}`;

export type EditorShortcutAction =
  | "next-tab"
  | "previous-tab"
  | "close-tab"
  | "new-document"
  | "toggle-documents-panel"
  | "toggle-outline-panel"
  | NumberedTabShortcutAction
  | null;

export type EditorShortcutKeyEvent = {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
};

export function isKeyboardShortcutsShortcut(
  event: EditorShortcutKeyEvent,
  platform: EditorShortcutPlatform,
): boolean {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.repeat ||
    event.altKey ||
    event.shiftKey ||
    event.ctrlKey === event.metaKey
  ) {
    return false;
  }

  const primaryModifier = platform === "mac" ? event.metaKey : event.ctrlKey;
  return (
    primaryModifier && (event.key === "/" || event.code === "Slash")
  );
}

export type EditorShortcutTarget = {
  tagName?: string;
  isContentEditable?: boolean;
};

export function isEditorShortcutInputContext(
  target: EditorShortcutTarget | null,
): boolean {
  if (!target) return false;
  return (
    Boolean(target.isContentEditable) ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName?.toUpperCase() ?? "")
  );
}

export function shouldBlockEditorShortcutInInputContext(
  action: EditorShortcutAction,
  inputContext: boolean,
): boolean {
  return (
    inputContext && (action === "close-tab" || action === "new-document")
  );
}

export function shouldPreserveInputShortcut(
  action: EditorShortcutAction,
  inputContext: boolean,
): boolean {
  return (
    inputContext &&
    (action === "toggle-documents-panel" ||
      action === "toggle-outline-panel")
  );
}

export function detectEditorShortcutPlatform(
  platform: string,
  userAgent: string,
): EditorShortcutPlatform {
  return /Mac|iPhone|iPad|iPod/i.test(`${platform} ${userAgent}`)
    ? "mac"
    : "other";
}

export function editorShortcutAction(
  event: EditorShortcutKeyEvent,
  platform: EditorShortcutPlatform,
): EditorShortcutAction {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.repeat ||
    event.altKey
  ) {
    return null;
  }

  if (
    event.key === "Tab" &&
    event.ctrlKey &&
    !event.metaKey
  ) {
    return event.shiftKey ? "previous-tab" : "next-tab";
  }

  if (event.shiftKey || event.ctrlKey === event.metaKey) return null;

  const primaryModifier =
    platform === "mac" ? event.metaKey : event.ctrlKey;
  if (!primaryModifier) return null;

  if (/^[1-9]$/.test(event.key)) {
    return `select-tab-${event.key}` as NumberedTabShortcutAction;
  }

  switch (event.key.toLowerCase()) {
    case "w":
      return "close-tab";
    case "n":
      return "new-document";
    case "b":
      return "toggle-documents-panel";
    case "\\":
      return "toggle-outline-panel";
    default:
      return null;
  }
}

export function adjacentTabId(
  openTabs: readonly string[],
  activeDocId: string | null,
  direction: 1 | -1,
): string | null {
  if (openTabs.length === 0) return null;

  const activeIndex = activeDocId ? openTabs.indexOf(activeDocId) : -1;
  if (activeIndex === -1) {
    return direction === 1 ? openTabs[0] : openTabs[openTabs.length - 1];
  }

  return openTabs[
    (activeIndex + direction + openTabs.length) % openTabs.length
  ];
}

export function numberedTabId(
  openTabs: readonly string[],
  shortcutNumber: number,
): string | null {
  if (
    !Number.isInteger(shortcutNumber) ||
    shortcutNumber < 1 ||
    shortcutNumber > 9
  ) {
    return null;
  }
  return openTabs[shortcutNumber - 1] ?? null;
}
