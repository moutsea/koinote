import { useEffect, useRef, useState, type FormEvent } from "react";
import { KeyRound, LoaderCircle, X } from "lucide-react";
import { useI18n } from "../i18n";
import { pushModal } from "../modalStack";

export function ConfigSnapshotPasswordDialog({
  snapshotName,
  onSubmit,
  onClose,
  formatError,
}: {
  snapshotName: string;
  onSubmit: (password: string) => Promise<void>;
  onClose: () => void;
  formatError: (error: unknown) => string;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const releaseModal = pushModal();
    inputRef.current?.focus();
    return () => {
      releaseModal();
      previouslyFocused?.focus();
    };
  }, []);

  function close() {
    if (submittingRef.current) return;
    setPassword("");
    onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    if (password.length < 8) {
      setError(t.space.syncUnlockPasswordRequired);
      inputRef.current?.focus();
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(password);
      setPassword("");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error && cause.message === "config_password_incorrect"
        ? t.space.syncUnlockFailed
        : formatError(cause));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        if (event.key === "Tab") {
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"));
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (!event.currentTarget.contains(document.activeElement)) {
            event.preventDefault();
            (event.shiftKey ? last : first)?.focus();
          } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="config-unlock-title"
        aria-describedby="config-unlock-hint"
        aria-busy={submitting}
        className="w-full max-w-md rounded-2xl border bg-[var(--background)] p-5 shadow-2xl sm:p-6"
        style={{ borderColor: "var(--ink-line)" }}
      >
        <div className="flex items-start gap-3">
          <KeyRound className="mt-1 h-5 w-5 shrink-0" style={{ color: "var(--cinnabar)" }} />
          <div className="min-w-0 flex-1">
            <h2 id="config-unlock-title" className="text-lg font-semibold" style={{ color: "var(--ink-strong)" }}>{t.space.syncUnlockTitle}</h2>
            <p className="mt-1 break-words text-sm" style={{ color: "var(--ink-mid)" }}>{snapshotName}</p>
          </div>
          <button type="button" onClick={close} disabled={submitting} aria-label={t.space.syncCancel} className="rounded-lg p-1.5 hover:bg-[var(--ink-wash)] disabled:opacity-50">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={(event) => void submit(event)} className="mt-5">
          <label className="block text-sm font-medium" style={{ color: "var(--ink-strong)" }}>
            {t.space.syncUnlockPasswordLabel}
            <input
              ref={inputRef}
              type="password"
              value={password}
              onChange={(event) => { setPassword(event.target.value); setError(null); }}
              autoComplete="new-password"
              disabled={submitting}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "config-unlock-hint config-unlock-error" : "config-unlock-hint"}
              className="mt-1.5 w-full rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: "var(--ink-line)", background: "var(--paper)" }}
            />
          </label>
          <p id="config-unlock-hint" className="mt-2 text-xs leading-5" style={{ color: "var(--ink-faint)" }}>{t.space.syncUnlockPasswordHint}</p>
          {error && <p id="config-unlock-error" role="alert" className="mt-3 text-sm" style={{ color: "var(--cinnabar)" }}>{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={close} disabled={submitting} className="rounded-full border px-4 py-2 text-sm disabled:opacity-50" style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}>{t.space.syncCancel}</button>
            <button type="submit" disabled={submitting} className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" style={{ background: "var(--cinnabar)" }}>
              {submitting && <LoaderCircle className="h-4 w-4 animate-spin" />}
              {submitting ? t.space.syncUnlockWorking : t.space.syncUnlockContinue}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
