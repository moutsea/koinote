import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { User } from "../api";
import { useI18n } from "../i18n";
import { getKoiOverview, koiErrorMessage, KOI_SETTINGS_QUERY_KEY, updateKoiSettings } from "../koiSkills";
import { PaperCard } from "./Ink";
import { KoiInstallDialog } from "./KoiInstallDialog";
import { KoiRetry } from "./KoiSkillUi";
import { KoiSkillsSection } from "./KoiSkillsSection";
import { KoiLegacyBanner } from "./KoiLegacyBanner";

export function KoiSkillLibrary({ user }: { user: User }) {
  const { t } = useI18n();
  const labels = t.koi;
  const client = useQueryClient();
  const queryKey = [KOI_SETTINGS_QUERY_KEY, user.authUserId];
  const overview = useQuery({ queryKey, queryFn: getKoiOverview, retry: false });
  const [installOpen, setInstallOpen] = useState(false);
  const save = useMutation({
    mutationFn: updateKoiSettings,
    onSuccess: ({ settings }) => client.setQueryData(queryKey, (current: typeof overview.data) => current && { ...current, settings }),
    onSettled: () => client.invalidateQueries({ queryKey, exact: true }),
  });
  if (overview.isError && !overview.data) return <PaperCard className="p-5"><KoiRetry label={labels.skillsLoadFailed} action={labels.retry} busy={overview.isFetching} onRetry={() => void overview.refetch()} /></PaperCard>;
  if (!overview.data?.managementAvailable) return null;
  const { settings } = overview.data;
  const canInstall = overview.data.canInstall && user.membershipTier === "lifetime";
  const legacy = settings.libraryMode === "legacy";
  return <section aria-label={labels.skillsTitle} className="space-y-5">
    <PaperCard className="p-5 sm:p-6">
      <label className="flex cursor-pointer items-start justify-between gap-4">
        <span><span className="block text-sm font-semibold">{labels.autoSkillsTitle}</span><span className="mt-1 block text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{legacy ? labels.legacyAutoDescription : labels.autoSkillsDescription}</span></span>
        <input type="checkbox" role="switch" aria-label={labels.autoSkillsTitle} checked={save.isPending ? save.variables.autoSkills : settings.autoSkills} disabled={!canInstall || save.isPending || overview.isFetching} className="mt-1 h-4 w-4 shrink-0 accent-[var(--cinnabar)]" onChange={(event) => save.mutate({ expectedRevision: settings.revision, autoSkills: event.target.checked })} />
      </label>
      <p className="mt-3 text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{labels.skillTaskScope}</p>
      {save.isPending && <p role="status" className="mt-2 text-xs">{labels.saving}</p>}
      {save.isError && <p role="alert" className="mt-2 text-xs" style={{ color: "var(--cinnabar)" }}>{koiErrorMessage(save.error, labels)}</p>}
    </PaperCard>
    {legacy ? <KoiLegacyBanner settings={settings} count={overview.data.legacySkillCount} disabled={!canInstall} onReview={() => setInstallOpen(true)} onChanged={() => client.invalidateQueries({ queryKey, exact: true })} /> : <KoiSkillsSection user={user} canInstall={canInstall} onInstall={() => setInstallOpen(true)} />}
    {installOpen && canInstall && <KoiInstallDialog authUserId={user.authUserId} migration={legacy} onClose={() => { setInstallOpen(false); void client.invalidateQueries({ queryKey, exact: true }); }} />}
  </section>;
}
