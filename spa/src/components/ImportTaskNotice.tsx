import { IMPORT_ACCOUNT_CHANGED_CODE } from "../documentImportCore";
import { interpolate, useI18n } from "../i18n";
import { useDocumentImport } from "../useDocumentImport";

export function ImportTaskNotice() {
  const { result, accountChanged, dismissNotice } = useDocumentImport();
  const { t } = useI18n();
  if (!result && !accountChanged) return null;
  const text = accountChanged ? t.errors[IMPORT_ACCOUNT_CHANGED_CODE] : [
    interpolate(t.transfer.importSuccess, { count: result!.imported }),
    result!.flattenedGifCount ? interpolate(t.transfer.importGifFlattened, { count: result!.flattenedGifCount }) : "",
  ].filter(Boolean).join(" ");
  return (
    <div className="mx-4 my-3 flex items-start justify-between gap-3 rounded-xl border p-3 text-sm" style={{ borderColor: "var(--ink-line)", color: accountChanged ? "var(--cinnabar)" : "var(--ink-mid)" }}>
      <p role={accountChanged ? "alert" : "status"}>{text}</p>
      <button type="button" onClick={dismissNotice} className="shrink-0 rounded-lg border px-3 py-2" style={{ borderColor: "var(--ink-line)" }}>{t.transfer.importAcknowledge}</button>
    </div>
  );
}
