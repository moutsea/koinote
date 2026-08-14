import { isDesktopRuntime } from "./desktop/runtime";

export interface ConfirmationAdapters {
  browser(message: string): boolean;
  desktop(message: string): Promise<boolean>;
}

const defaultAdapters: ConfirmationAdapters = {
  browser: (message) => window.confirm(message),
  desktop: async (message) => {
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    return confirm(message, { title: "Koinote", kind: "warning" });
  },
};

export function confirmAction(
  message: string,
  adapters: ConfirmationAdapters = defaultAdapters,
): Promise<boolean> {
  if (isDesktopRuntime()) return adapters.desktop(message);
  return Promise.resolve(adapters.browser(message));
}
