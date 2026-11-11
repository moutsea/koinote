import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, CircleSlash, LoaderCircle, RefreshCw, Sparkles } from "lucide-react";
import { useI18n } from "../i18n";
import { KOI_SKILLS_QUERY_KEY, KOI_SETTINGS_QUERY_KEY } from "../koiSkills";
import { PaperCard } from "./Ink";

export function KoiSkillStatusBadge({ state }: { state: "enabled" | "disabled" | "unavailable" }) {
  const { t } = useI18n();
  const labels = t.koi;
  const config = {
    enabled: { label: labels.stateEnabled, icon: CheckCircle2, color: "var(--ink-strong)" },
    disabled: { label: labels.stateDisabled, icon: CircleSlash, color: "var(--ink-faint)" },
    unavailable: { label: labels.stateUnavailable, icon: AlertTriangle, color: "var(--cinnabar)" },
  }[state];
  const Icon = config.icon;
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium" style={{ color: config.color }}>
      <Icon className="h-3.5 w-3.5" />
      {config.label}
    </span>
  );
}

export function KoiSkillSourceLabel({ source }: { source: Record<string, unknown> }) {
 const { t } = useI18n();
 const directory = typeof source.directoryName === "string" ? source.directoryName : "";
 const label = source.kind === "github" ? `${t.koi.sourceGithub} · ${source.owner}/${source.repo}${source.path ? `/${source.path}` : ""}` : source.kind === "hub" ? `${t.koi.sourceHub} · ${source.name}` : source.kind === "migration" ? `${t.koi.sourceMigration} · ${directory}` : directory || t.koi.sourceFolder;
 return <span title={label} className="max-w-64 truncate text-xs" style={{ color: "var(--ink-mid)" }}>{label}</span>;
}

export function KoiEmptyState({ onInstall, canInstall, message }: { onInstall: () => void; canInstall: boolean; message: string }) {
  const { t } = useI18n();
  return (
    <PaperCard className="p-10 text-center">
      <Sparkles className="mx-auto h-9 w-9" style={{ color: "var(--ink-faint)" }} />
      <p className="mt-3 text-sm" style={{ color: "var(--ink-mid)" }}>{message}</p>
      {canInstall && (
        <button type="button" onClick={onInstall} className="mt-4 inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold text-white" style={{ background: "var(--cinnabar)" }}>
          {t.koi.installSkill}
        </button>
      )}
    </PaperCard>
  );
}

export function KoiPending({ label }: { label: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-sm" style={{ color: "var(--ink-faint)" }}>
      <LoaderCircle className="h-4 w-4 animate-spin" />
      {label}
    </p>
  );
}

export function KoiRetry({ label, action, onRetry, busy }: { label: string; action: string; onRetry: () => void; busy: boolean }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <p role="alert" className="text-sm" style={{ color: "var(--cinnabar)" }}>{label}</p>
      <button type="button" onClick={onRetry} disabled={busy} aria-busy={busy} className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50" style={{ borderColor: "var(--ink-line)" }}>
        <RefreshCw className={busy ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
        {action}
      </button>
    </div>
  );
}

export function useKoiSkillStorageInvalidation(authUserId: string) {
 const client = useQueryClient();
 return () => Promise.all([
  client.invalidateQueries({ queryKey: [KOI_SKILLS_QUERY_KEY, authUserId] }),
  client.invalidateQueries({ queryKey: [KOI_SETTINGS_QUERY_KEY, authUserId] }),
  client.invalidateQueries({ queryKey: ["storage-usage"] }),
 ]);
}
