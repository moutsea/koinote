export const DESKTOP_SYNC_EVENT = "koinote:desktop-sync";

export type DesktopFlavor = "production" | "local";

export function desktopFlavor(): DesktopFlavor {
  return import.meta.env?.VITE_DESKTOP_FLAVOR?.trim() === "local"
    ? "local"
    : "production";
}

export function desktopCallbackScheme(): string {
  return desktopFlavor() === "local" ? "koinote-local:" : "koinote:";
}

export function desktopAuthClientID(): string {
  return desktopFlavor() === "local"
    ? "koinote-desktop-local"
    : "koinote-desktop";
}

export function isDesktopRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

export function desktopAPIOrigin(): string {
  return desktopFlavor() === "local" ? "http://localhost:5273" : "https://koinote.app";
}

export function desktopURL(path: string): string {
  return new URL(path, `${desktopAPIOrigin()}/`).toString();
}
