export const DESKTOP_SYNC_EVENT = "koinote:desktop-sync";

export function isDesktopRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

export function desktopAPIOrigin(): string {
  const configured = import.meta.env.VITE_DESKTOP_API_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return import.meta.env.DEV ? "http://localhost:5273" : "https://koinote.app";
}

export function desktopURL(path: string): string {
  return new URL(path, `${desktopAPIOrigin()}/`).toString();
}
