import type { QueryClient } from "@tanstack/react-query";
import type { DesktopSyncSummary } from "./offlineStore";
import { DESKTOP_SYNC_EVENT } from "./runtime";

export function installDesktopSyncQueryRefresh(
  queryClient: QueryClient,
  target: EventTarget = window,
): () => void {
  const onSync = (event: Event) => {
    const summary = (event as CustomEvent<DesktopSyncSummary>).detail;
    if (summary.state === "syncing") return;
    for (const key of ["documents", "document", "folders", "document-search"]) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
  target.addEventListener(DESKTOP_SYNC_EVENT, onSync);
  return () => target.removeEventListener(DESKTOP_SYNC_EVENT, onSync);
}
