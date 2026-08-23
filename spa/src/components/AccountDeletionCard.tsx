import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, LoaderCircle, Trash2 } from "lucide-react";
import { ApiError, deleteAccount, type User } from "../api";
import { clearAllConflictDrafts } from "../conflictDrafts";
import { confirmAction } from "../confirmAction";
import { interpolate, useI18n } from "../i18n";
import { PaperCard } from "./Ink";

export function AccountDeletionCard({ user }: { user: User }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [confirmation, setConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = confirmation.trim().toLowerCase() === user.email.trim().toLowerCase();

  async function removeAccount() {
    if (!matches || deleting) return;
    if (!(await confirmAction(t.accountDeletion.finalConfirmation))) return;
    setDeleting(true);
    setError(null);
    try {
      const result = await deleteAccount(confirmation.trim());
      clearAllConflictDrafts();
      queryClient.clear();
      if (result.localCleanupFailed) {
        window.alert(t.accountDeletion.localCleanupFailed);
      }
      window.location.assign("/");
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.code === "account_deletion_payment_pending") {
          setError(t.accountDeletion.paymentPending);
        } else if (caught.code === "account_deletion_confirmation_mismatch") {
          setError(t.accountDeletion.mismatch);
        } else if (caught.code === "account_deletion_unavailable") {
          setError(t.accountDeletion.unavailable);
        } else {
          setError(t.accountDeletion.failed);
        }
      } else {
        setError(t.accountDeletion.failed);
      }
    } finally {
      setDeleting(false);
    }
  }

  return (
    <PaperCard className="border-red-200/70 p-5 dark:border-red-900/50 sm:p-6">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-red-700 dark:text-red-300">
            {t.accountDeletion.title}
          </h2>
          <p className="mt-1 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
            {t.accountDeletion.description}
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-xs leading-5" style={{ color: "var(--ink-mid)" }}>
            <li>{t.accountDeletion.immediate}</li>
            <li>{t.accountDeletion.membership}</li>
            <li>{t.accountDeletion.paymentRecords}</li>
            <li>{t.accountDeletion.feedbackRecords}</li>
          </ul>

          <label className="mt-5 block text-xs font-medium" style={{ color: "var(--ink-mid)" }}>
            {interpolate(t.accountDeletion.confirmLabel, { email: user.email })}
            <input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={user.email}
              className="mt-2 w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1"
              style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
            />
          </label>
          {error && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          )}
          <button
            type="button"
            disabled={!matches || deleting}
            onClick={() => void removeAccount()}
            className="mt-4 inline-flex items-center gap-2 rounded-full bg-red-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {deleting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            {deleting ? t.accountDeletion.deleting : t.accountDeletion.deleteButton}
          </button>
        </div>
      </div>
    </PaperCard>
  );
}
