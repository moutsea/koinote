import { useState } from "react";
import { KeyRound, LogOut } from "lucide-react";
import {
  ApiError,
  changePassword,
  invalidateOtherSessions,
  type User,
} from "../api";
import { useI18n } from "../i18n";
import { PaperCard } from "./Ink";

export function PasswordSecurityCard({ user }: { user: User }) {
  const { t } = useI18n();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changing, setChanging] = useState(false);
  const [invalidating, setInvalidating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function messageFor(errorValue: unknown) {
    if (
      errorValue instanceof ApiError &&
      errorValue.code &&
      t.errors[errorValue.code]
    ) {
      return t.errors[errorValue.code];
    }
    return errorValue instanceof Error
      ? errorValue.message
      : t.auth.requestFailed;
  }

  async function submitPassword(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (newPassword !== confirmPassword) {
      setError(t.auth.passwordMismatch);
      return;
    }
    setChanging(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setNotice(t.security.passwordChanged);
    } catch (errorValue) {
      setError(messageFor(errorValue));
    } finally {
      setChanging(false);
    }
  }

  async function invalidateSessions() {
    setError(null);
    setNotice(null);
    setInvalidating(true);
    try {
      await invalidateOtherSessions();
      setNotice(t.security.sessionsInvalidated);
    } catch (errorValue) {
      setError(messageFor(errorValue));
    } finally {
      setInvalidating(false);
    }
  }

  return (
    <PaperCard className="p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <KeyRound
          className="mt-0.5 h-5 w-5 shrink-0"
          style={{ color: "var(--ink-faint)" }}
        />
        <div>
          <h2 className="font-semibold" style={{ color: "var(--ink-black)" }}>
            {t.security.title}
          </h2>
          <p className="mt-1 text-sm" style={{ color: "var(--ink-mid)" }}>
            {t.security.description}
          </p>
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="mt-4 rounded-lg px-3 py-2 text-sm"
          style={{ background: "var(--ink-wash)", color: "var(--ink-mid)" }}
        >
          {notice}
        </p>
      )}

      {user.hasPassword ? (
        <form
          onSubmit={submitPassword}
          className="mt-5 grid gap-4 sm:grid-cols-3"
        >
          <PasswordField
            label={t.security.currentPassword}
            value={currentPassword}
            onChange={setCurrentPassword}
            autoComplete="current-password"
          />
          <PasswordField
            label={t.security.newPassword}
            value={newPassword}
            onChange={setNewPassword}
            autoComplete="new-password"
          />
          <PasswordField
            label={t.security.confirmPassword}
            value={confirmPassword}
            onChange={setConfirmPassword}
            autoComplete="new-password"
          />
          <div className="sm:col-span-3">
            <button
              type="submit"
              disabled={changing}
              className="rounded-full px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
              style={{ background: "var(--cinnabar)" }}
            >
              {changing
                ? t.security.changingPassword
                : t.security.changePassword}
            </button>
          </div>
        </form>
      ) : (
        <p
          className="mt-5 rounded-lg border px-3 py-3 text-sm"
          style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}
        >
          {t.security.oauthOnly}
        </p>
      )}

      <div
        className="mt-6 flex flex-col gap-3 border-t pt-5 sm:flex-row sm:items-center sm:justify-between"
        style={{ borderColor: "var(--ink-line)" }}
      >
        <div>
          <h3
            className="text-sm font-semibold"
            style={{ color: "var(--ink-strong)" }}
          >
            {t.security.sessionsTitle}
          </h3>
          <p className="mt-1 text-xs" style={{ color: "var(--ink-faint)" }}>
            {t.security.sessionsDescription}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void invalidateSessions()}
          disabled={invalidating}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition hover:bg-[var(--ink-wash)] disabled:opacity-60"
          style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
        >
          <LogOut className="h-4 w-4" />
          {invalidating
            ? t.security.invalidatingSessions
            : t.security.invalidateSessions}
        </button>
      </div>
    </PaperCard>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
}) {
  return (
    <label className="block">
      <span
        className="mb-1.5 block text-sm font-medium"
        style={{ color: "var(--ink-strong)" }}
      >
        {label}
      </span>
      <input
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        required
        minLength={6}
        className="w-full rounded-lg border px-3 py-2 text-sm outline-none transition focus:border-[var(--cinnabar)] focus:ring-2 focus:ring-[var(--cinnabar-soft)]"
        style={{
          borderColor: "var(--ink-line)",
          background: "var(--ink-paper)",
          color: "var(--ink-black)",
        }}
      />
    </label>
  );
}
