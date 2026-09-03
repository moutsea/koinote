import { useEffect, useRef } from "react";
import { isModalOpen } from "../modalStack";
import { desktopFlavor, isDesktopRuntime } from "./runtime";

export const DESKTOP_MENU_EVENT = "koinote:desktop-menu-action";

export const DESKTOP_MENU_ACTIONS = [
  "new-document",
  "save-document",
  "close-document",
  "export-markdown",
  "export-html",
  "export-docx",
  "export-pdf",
  "export-media",
  "share-document",
  "quick-open",
  "find-in-document",
  "search-all-documents",
  "previous-document",
  "next-document",
  "toggle-documents-panel",
  "toggle-outline-panel",
  "ai-optimize",
  "version-history",
  "open-documentation",
  "show-keyboard-shortcuts",
  "check-updates",
] as const;

export type DesktopMenuAction = (typeof DESKTOP_MENU_ACTIONS)[number];
export type DesktopMenuLocale = "en" | "zh" | "fr" | "ja";

export const DESKTOP_EDITOR_MENU_ACTIONS = [
  "new-document",
  "save-document",
  "close-document",
  "export-markdown",
  "export-html",
  "export-docx",
  "export-pdf",
  "export-media",
  "share-document",
  "find-in-document",
  "previous-document",
  "next-document",
  "toggle-documents-panel",
  "toggle-outline-panel",
  "ai-optimize",
  "version-history",
] as const satisfies readonly DesktopMenuAction[];

type DesktopMenuAvailability = {
  editorRoute: boolean;
  authenticated: boolean;
  localMode: boolean;
  historyAvailable: boolean;
};

const desktopMenuActions = new Set<string>(DESKTOP_MENU_ACTIONS);

export function isDesktopMenuAction(value: unknown): value is DesktopMenuAction {
  return typeof value === "string" && desktopMenuActions.has(value);
}

export async function syncDesktopMenuLocale(
  locale: DesktopMenuLocale,
): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("desktop_set_menu_locale", { locale });
}

export function desktopMenuEnabledActions({
  editorRoute,
  authenticated,
  localMode,
  historyAvailable,
}: DesktopMenuAvailability): DesktopMenuAction[] {
  const enabled: DesktopMenuAction[] = [
    "open-documentation",
    "show-keyboard-shortcuts",
  ];

  if (!localMode && desktopFlavor() === "production") enabled.push("check-updates");
  if (authenticated) {
    enabled.push("quick-open", "search-all-documents");
  }
  if (!editorRoute || !authenticated) return enabled;

  enabled.push(
    ...DESKTOP_EDITOR_MENU_ACTIONS.filter((action) => {
      if (action === "version-history") {
        return !localMode && historyAvailable;
      }
      if (action === "share-document" || action === "ai-optimize") {
        return !localMode;
      }
      return true;
    }),
  );
  return enabled;
}

export async function syncDesktopMenuEnabled(
  enabledActions: readonly DesktopMenuAction[],
): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("desktop_set_menu_enabled", { enabledActions });
}

export function useDesktopMenuActions(
  handler: (action: DesktopMenuAction) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<unknown>(DESKTOP_MENU_EVENT, (event) => {
          if (isDesktopMenuAction(event.payload)) {
            // 原生菜单加速键可能先于 WebView 的 keydown 被系统吞掉，必须在事件入口拦截模态穿透。
            if (isModalOpen()) return;
            handlerRef.current(event.payload);
          }
        }),
      )
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch((error) => console.warn("Desktop menu listener failed", error));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
