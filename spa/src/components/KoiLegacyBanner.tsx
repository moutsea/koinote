import { useMutation } from "@tanstack/react-query";
import { confirmAction } from "../confirmAction";
import { useI18n } from "../i18n";
import { koiErrorMessage, skipKoiMigration, type KoiSettings } from "../koiSkills";

export function KoiLegacyBanner({ settings, count, onReview, onChanged, disabled = false }: { settings: KoiSettings; count: number; onReview: () => void; onChanged: () => Promise<unknown>; disabled?: boolean }) {
  const { t } = useI18n();
  const labels = t.koi;
  const skip = useMutation({
    mutationFn: () => skipKoiMigration(settings.revision),
    onSettled: () => onChanged(),
  });
  return <div role="note" className="rounded-xl border p-4 sm:p-5" style={{ borderColor: "var(--cinnabar-soft)", background: "var(--cinnabar-wash)" }}>
    <h3 className="text-sm font-semibold">{labels.legacyTitle}</h3>
    <p className="mt-2 text-xs leading-6" style={{ color: "var(--ink-mid)" }}>{labels.legacyDescription.replace("{count}", String(count))}</p>
    <div className="mt-3 flex flex-wrap items-center gap-4">
      <button type="button" disabled={disabled || skip.isPending} onClick={onReview} className="rounded-lg border px-3 py-2 text-xs font-semibold disabled:opacity-50">{labels.legacyAction}</button>
      <button type="button" disabled={disabled || skip.isPending} onClick={async () => { if (await confirmAction(labels.legacySkipConfirm)) skip.mutate(); }} className="text-xs underline disabled:opacity-50">{skip.isPending ? labels.saving : labels.legacySkip}</button>
    </div>
    {skip.isError && <p role="alert" className="mt-3 text-xs" style={{ color: "var(--cinnabar)" }}>{koiErrorMessage(skip.error, labels)}</p>}
  </div>;
}
