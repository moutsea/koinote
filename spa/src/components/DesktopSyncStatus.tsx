import { AlertTriangle, Check, Cloud, RefreshCw, WifiOff, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { isDesktopRuntime } from "../desktop/runtime";
import { REMOTE_UPDATE_INTERVAL_MS } from "../remoteUpdates";
import {
  desktopListConflicts,
  desktopSyncEventName,
  desktopSyncSummary,
  resolveDesktopConflict,
  syncDesktopNow,
  type DesktopConflict,
  type DesktopSyncSummary,
} from "../desktop/offlineStore";
import { useI18n } from "../i18n";
import { pushModal } from "../modalStack";
import { PaperCard } from "./Ink";

const INITIAL: DesktopSyncSummary = {
  state: "idle",
  pending: 0,
  conflicts: 0,
  lastSyncedAt: null,
};

export function DesktopSyncStatus({ variant = "header" }: { variant?: "header" | "panel" }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [summary, setSummary] = useState(INITIAL);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [conflicts, setConflicts] = useState<DesktopConflict[]>([]);
  const previousConflictCount = useRef(0);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    const eventName = desktopSyncEventName();
    const onStatus = (event: Event) => {
      const next = (event as CustomEvent<DesktopSyncSummary>).detail;
      setSummary(next);
      if (next.state === "idle") {
        void queryClient.invalidateQueries({ queryKey: ["documents"] });
        void queryClient.invalidateQueries({ queryKey: ["document"] });
        void queryClient.invalidateQueries({ queryKey: ["folders"] });
        void queryClient.invalidateQueries({ queryKey: ["document-search"] });
      }
      if (next.conflicts > 0) {
        const shouldPrompt = next.conflicts > previousConflictCount.current;
        void desktopListConflicts().then((items) => {
          if (disposed) return;
          setConflicts(items);
          if (shouldPrompt) setDialogOpen(true);
        });
      }
      previousConflictCount.current = next.conflicts;
    };
    const onOnline = () => void syncDesktopNow();
    const checkRemote = () => {
      if (!navigator.onLine || document.visibilityState !== "visible") return;
      void syncDesktopNow({ silent: true });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") checkRemote();
    };
    window.addEventListener(eventName, onStatus);
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", checkRemote);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const interval = window.setInterval(checkRemote, REMOTE_UPDATE_INTERVAL_MS);
    void desktopSyncSummary()
      .then((initial) => {
        if (disposed) return;
        setSummary(initial);
        previousConflictCount.current = initial.conflicts;
        if (initial.conflicts > 0) {
          void desktopListConflicts().then((items) => {
            if (disposed) return;
            setConflicts(items);
            setDialogOpen(true);
          });
        }
        if (navigator.onLine) void syncDesktopNow();
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener(eventName, onStatus);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", checkRemote);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [queryClient]);

  useEffect(() => {
    if (!dialogOpen) return;
    return pushModal();
  }, [dialogOpen]);

  if (!isDesktopRuntime()) return null;

  const label = syncLabel(summary, t.desktopSync, t.errors);
  const Icon = summary.conflicts > 0
    ? AlertTriangle
    : summary.state === "error"
      ? AlertTriangle
      : summary.state === "offline"
        ? WifiOff
        : summary.state === "syncing"
          ? RefreshCw
          : summary.state === "idle" && summary.pending === 0
            ? Check
            : Cloud;

  async function activate() {
    if (summary.conflicts > 0) {
      setConflicts(await desktopListConflicts());
      setDialogOpen(true);
      return;
    }
    setSummary(await syncDesktopNow());
  }

  async function resolve(docId: string, choice: "local" | "remote") {
    await resolveDesktopConflict(docId, choice);
    const next = await desktopListConflicts();
    setConflicts(next);
    if (next.length === 0) {
      setDialogOpen(false);
      setSummary(await syncDesktopNow());
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void activate()}
        title={label}
        aria-label={label}
        className={
          variant === "panel"
            ? "flex w-full items-center gap-3 rounded-lg border px-3.5 py-3 text-sm font-medium transition hover:bg-[var(--ink-wash-strong)]"
            : "flex h-9 items-center gap-1.5 rounded-full px-2.5 text-xs transition hover:bg-[var(--ink-wash-strong)]"
        }
        style={{
          borderColor: variant === "panel" ? "var(--ink-line)" : undefined,
          color:
            summary.conflicts > 0 || summary.state === "error"
              ? "var(--cinnabar)"
              : "var(--ink-mid)",
        }}
      >
        <Icon className={`h-4 w-4 ${summary.state === "syncing" ? "animate-spin" : ""}`} />
        <span className={variant === "panel" ? "inline" : "hidden xl:inline"}>{label}</span>
        {variant === "panel" && <RefreshCw className="ml-auto h-3.5 w-3.5" aria-hidden />}
      </button>

      {dialogOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/35 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="desktop-conflicts-title"
        >
          <PaperCard
            className="max-h-[80vh] w-full max-w-2xl overflow-y-auto p-6 sm:p-8"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="desktop-conflicts-title" className="kn-heading-cn text-xl font-bold">
                  {t.desktopSync.conflictsTitle}
                </h2>
                <p className="mt-2 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
                  {t.desktopSync.conflictsDescription}
                </p>
              </div>
              <button type="button" onClick={() => setDialogOpen(false)} aria-label={t.desktopSync.close}>
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-6 space-y-4">
              {conflicts.map((conflict) => (
                <div key={conflict.docId} className="rounded-xl border p-4" style={{ borderColor: "var(--ink-line)" }}>
                  <h3 className="font-semibold">{conflict.title || conflict.docId}</h3>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void resolve(conflict.docId, "local")}
                      className="rounded-full px-4 py-2 text-xs font-semibold text-white"
                      style={{ background: "var(--cinnabar)" }}
                    >
                      {t.desktopSync.keepLocal}
                    </button>
                    <button
                      type="button"
                      onClick={() => void resolve(conflict.docId, "remote")}
                      className="rounded-full border px-4 py-2 text-xs font-semibold"
                      style={{ borderColor: "var(--ink-line)" }}
                    >
                      {t.desktopSync.useCloud}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </PaperCard>
        </div>
      )}
    </>
  );
}

function syncLabel(
  summary: DesktopSyncSummary,
  copy: ReturnType<typeof useI18n>["t"]["desktopSync"],
  errors: Record<string, string>,
): string {
  if (summary.conflicts > 0) return `${summary.conflicts} ${copy.conflicts}`;
  if (summary.state === "syncing") return copy.syncing;
  if (summary.state === "offline") return summary.pending > 0 ? `${copy.offline} · ${summary.pending} ${copy.pending}` : copy.offline;
  if (summary.state === "error") {
    const code = summary.message?.replace(/^Error:\s*/, "");
    return (code && errors[code]) || copy.error;
  }
  if (summary.pending > 0) return `${summary.pending} ${copy.pending}`;
  return copy.synced;
}
