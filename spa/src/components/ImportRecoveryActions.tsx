import { getImportErrorMessage, type ImportInterruptedError } from "../documentTransfer";
import { useI18n } from "../i18n";

export function ImportRecoveryActions({ pending, busy, waiting, onResume, onDiscard }: {
  pending: ImportInterruptedError | null;
  busy: boolean;
  waiting: boolean;
  onResume: () => void;
  onDiscard: () => void;
}) {
  const { t } = useI18n();
  if (!pending && !waiting) return null;
  return (
    <div className="my-3 rounded-xl border p-3 text-sm" style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}>
      {waiting ? <p role="status">{t.transfer.importWaiting}</p> : pending && (
        <p role="alert">{getImportErrorMessage(pending, t.transfer, t.errors)}</p>
      )}
      {pending && (
        <>
          <p className="mt-1 text-xs">{t.transfer.importKeepSaved}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {pending.canResume && <button type="button" disabled={busy} onClick={onResume} className="rounded-lg border px-3 py-2 disabled:opacity-50" style={{ borderColor: "var(--ink-line)" }}>{t.transfer.importResume}</button>}
            <button type="button" disabled={busy} onClick={onDiscard} className="rounded-lg border px-3 py-2 disabled:opacity-50" style={{ borderColor: "var(--ink-line)" }}>{t.transfer.importFinish}</button>
          </div>
        </>
      )}
    </div>
  );
}
