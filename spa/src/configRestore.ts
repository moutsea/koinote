import type { Messages } from "./i18n";

/** Tauri rejects with strings; web/API errors may arrive as Error objects. */
export function configRestoreErrorMessage(error: unknown, labels: Messages["space"]["configSnapshots"]): string | null {
  const code = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  if (code === "config_platform_path_unsupported" || code === "config_platform_location_unsupported") return labels.errorPlatformUnsupported;
  if (code === "config_platform_path_conflict") return labels.errorPlatformConflict;
  if (code === "config_path_invalid" || code === "config_path_duplicate") return labels.errorPath;
  return null;
}
