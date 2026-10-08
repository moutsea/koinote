import { Link } from "@tanstack/react-router";
import { HardDrive, LoaderCircle, Plus } from "lucide-react";
import type { AgentWorkspaceStorage } from "../api";
import { useI18n } from "../i18n";
export function AgentWorkspaceStorageCard({
  storage,
  loading,
  error,
  onRetry,
  compact = false,
  showExpand = true,
}: {
  storage?: AgentWorkspaceStorage;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  compact?: boolean;
  showExpand?: boolean;
}) {
  const { t } = useI18n();
  const percent = storage && storage.quotaBytes > 0 ? Math.min(100, storage.usedBytes / storage.quotaBytes * 100) : 0;

  return <div className={compact ? "rounded-lg border p-4" : "rounded-xl border p-5"} style={{ borderColor: "var(--ink-line)" }}>
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-sm font-semibold"><HardDrive className="h-4 w-4" />{t.agentWorkspace.storageTitle}</span>
      {showExpand && <Link to="/space/settings" className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-semibold"><Plus className="h-3 w-3" />{t.agentWorkspace.storageExpand}</Link>}
    </div>
    {error ? <div className="mt-3">
      <p role="alert" className="text-sm" style={{ color: "var(--cinnabar)" }}>{t.storage.loadFailed}</p>
      <button type="button" disabled={loading} onClick={onRetry} className="mt-2 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold disabled:opacity-50" style={{ borderColor: "var(--ink-line)" }}>
        {loading && <LoaderCircle className="h-3 w-3 animate-spin" />}
        {loading ? t.storage.loading : t.agentWorkspace.storageRetry}
      </button>
    </div> : !storage ? <p role="status" className="mt-3 text-sm" style={{ color: "var(--ink-faint)" }}>{t.storage.loading}</p> : <>
      <div role="progressbar" aria-label={t.agentWorkspace.storageTitle} aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100} className="mt-3 h-2 overflow-hidden rounded-full" style={{ background: "var(--ink-wash)" }}>
        <div className="h-full rounded-full" style={{ width: `${percent}%`, background: percent > 90 ? "var(--cinnabar)" : "var(--ink-strong)" }} />
      </div>
      <p className="mt-2 text-xs" style={{ color: "var(--ink-faint)" }}>{formatBytes(storage.usedBytes)} / {formatBytes(storage.quotaBytes)}</p>
    </>}
  </div>;
}
function formatBytes(bytes: number) { return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`; }
