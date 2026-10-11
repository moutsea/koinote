import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { beginDesktopAuthorization } from "../desktop/auth";
import { DesktopAccountMismatchError, DesktopCredentialStoreError } from "../desktop/sessionErrors";

export function DesktopSessionError({ error, retrying, onRetry, compact = false }: { error: unknown; retrying: boolean; onRetry: () => void; compact?: boolean }) {
  const { t } = useI18n();
  const [opening, setOpening] = useState(false);
  const [authorizationStatus, setAuthorizationStatus] = useState<"opened" | "failed" | null>(null);
  const mismatch = error instanceof DesktopAccountMismatchError;
  useEffect(() => {
    const failed = () => setAuthorizationStatus("failed");
    window.addEventListener("koinote:desktop-auth-error", failed);
    window.addEventListener("koinote:desktop-auth-stale", failed);
    return () => {
      window.removeEventListener("koinote:desktop-auth-error", failed);
      window.removeEventListener("koinote:desktop-auth-stale", failed);
    };
  }, []);
  async function reauthorize() {
    setOpening(true);
    setAuthorizationStatus(null);
    try {
      // Keep credentials and local data until a new browser authorization succeeds.
      await beginDesktopAuthorization();
      setAuthorizationStatus("opened");
    } catch {
      setAuthorizationStatus("failed");
    } finally {
      setOpening(false);
    }
  }
  return <div role="alert" className={compact ? "shrink-0 border-b border-[var(--ink-line)] px-6 py-3 text-center" : "flex flex-1 flex-col items-center justify-center gap-4 px-6 py-24 text-center"}>
    <h1 className="text-lg font-medium">{t.desktopAuth.sessionUnavailable}</h1>
    <p className="mx-auto max-w-lg text-sm leading-7 text-[var(--ink-mid)]">{mismatch ? t.desktopAuth.accountMismatch : error instanceof DesktopCredentialStoreError ? t.desktopAuth.credentialsUnavailable : t.desktopAuth.sessionRetryHint}</p>
    <div className="flex justify-center gap-3">
      <button type="button" disabled={retrying || opening} onClick={onRetry} className="rounded-full border border-[var(--ink-line)] px-6 py-2.5 text-sm font-semibold disabled:opacity-50">{t.desktopAuth.retrySession}</button>
      {mismatch && <button type="button" disabled={opening} onClick={() => { void reauthorize(); }} className="rounded-full bg-cinnabar-600 px-6 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{t.desktopAuth.reauthorize}</button>}
    </div>
    {authorizationStatus && <p className="text-sm" role="status">{authorizationStatus === "opened" ? t.desktopAuth.reauthorizeOpened : t.desktopAuth.failed}</p>}
  </div>;
}
