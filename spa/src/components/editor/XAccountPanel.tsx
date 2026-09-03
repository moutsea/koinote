import { useEffect, useState } from "react";
import { ExternalLink, Link2, Loader2 } from "lucide-react";
import { ApiError, deleteXOAuth2Account, getXAccount, startXOAuth2, type XOAuth2Account } from "../../api";
import { useI18n } from "../../i18n";
import { desktopFlavor, isDesktopRuntime } from "../../desktop/runtime";

export function XAccountPanel({ localMode }: { localMode: boolean }) {
  const { t } = useI18n();
  const [oauth2, setOauth2] = useState<XOAuth2Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [oauthBusy, setOauthBusy] = useState(false);

  useEffect(() => {
    if (localMode) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getXAccount()
      .then((result) => {
        if (!cancelled) setOauth2(result.oauth2);
      })
      .catch((caught) => {
        if (!cancelled) setError(apiErrorText(caught, t.editor.xAccountLoadFailed, t.errors));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [localMode, retry, t.editor.xAccountLoadFailed, t.errors]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("x_oauth2");
    const failure = params.get("x_oauth2_error");
    if (!status && !failure) return;
    if (status === "connected") {
      setNotice(t.editor.xOAuth2Connected);
      setError(null);
    }
    if (failure) {
      setNotice(null);
      setError(xOAuth2FailureText(failure, t.editor.xOAuth2BindFailed, t.errors));
    }
    params.delete("x_oauth2");
    params.delete("x_oauth2_error");
    const query = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (query ? "?" + query : "") + window.location.hash);
    if (status === "connected") setRetry((value) => value + 1);
  }, [t.editor.xOAuth2BindFailed, t.editor.xOAuth2Connected, t.errors]);

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ status?: string; code?: string }>).detail;
      if (detail?.status === "error") {
        setNotice(null);
        setError(xOAuth2FailureText(detail.code, t.editor.xOAuth2BindFailed, t.errors));
      } else if (detail?.status === "success") {
        setError(null);
        setNotice(t.editor.xOAuth2Connected);
      }
      setRetry((value) => value + 1);
    };
    window.addEventListener("koinote:x-oauth2-complete", listener);
    return () => window.removeEventListener("koinote:x-oauth2-complete", listener);
  }, [t.editor.xOAuth2BindFailed, t.editor.xOAuth2Connected, t.errors]);

  async function bindOAuth2() {
    setOauthBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await startXOAuth2({
        redirectTo: "/settings?section=x",
        ...(isDesktopRuntime()
          ? { client: desktopFlavor() === "local" ? "desktop-local" as const : "desktop" as const }
          : {}),
      });
      if (isDesktopRuntime()) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(result.url);
      } else {
        window.location.assign(result.url);
      }
    } catch (caught) {
      setError(apiErrorText(caught, t.editor.xOAuth2BindFailed, t.errors));
    } finally {
      setOauthBusy(false);
    }
  }

  async function unbindOAuth2() {
    if (!oauth2 || !window.confirm(t.editor.xOAuth2UnbindConfirm)) return;
    setOauthBusy(true);
    setError(null);
    setNotice(null);
    try {
      await deleteXOAuth2Account();
      setOauth2(null);
    } catch (caught) {
      setError(apiErrorText(caught, t.editor.xOAuth2UnbindFailed, t.errors));
    } finally {
      setOauthBusy(false);
    }
  }

  if (localMode) return <section className="rounded-xl border border-black/10 bg-black/[0.02] p-5 text-sm leading-6 text-neutral-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-neutral-400">{t.desktopLocalMode.networkDisabled}</section>;
  if (loading) return <p className="flex items-center gap-2 text-sm text-neutral-400"><Loader2 className="h-4 w-4 animate-spin" />{t.editor.xAccountLoading}</p>;

  return (
    <section className="rounded-xl border border-neutral-500/20 bg-neutral-500/[0.035] p-5">
      <div className="flex items-start gap-2.5">
        <Link2 className="mt-0.5 h-5 w-5 shrink-0 text-neutral-700 dark:text-neutral-200" />
        <div>
          <h3 className="text-base font-semibold">{t.editor.xAccountTitle}</h3>
          <p className="mt-1.5 text-sm leading-6 text-neutral-500 dark:text-neutral-400">{t.editor.xAccountHint}</p>
          <a href="https://developer.x.com/en/portal/dashboard" target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold underline">{t.editor.xDeveloperPortal} <ExternalLink className="h-3 w-3" /></a>
        </div>
      </div>
      <div className="mt-5 rounded-lg border border-black/5 bg-white/60 px-3.5 py-3 dark:border-white/10 dark:bg-white/5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">{t.editor.xOAuth2Title}</p>
            <p className="mt-0.5 text-xs text-neutral-400">{oauth2 ? "@" + oauth2.username : t.editor.xOAuth2NotBound}</p>
          </div>
          {oauth2 ? (
            <button type="button" disabled={oauthBusy} onClick={() => void unbindOAuth2()} className="rounded-md px-2.5 py-1.5 text-xs font-medium text-neutral-500 hover:bg-black/5 disabled:opacity-50">{t.editor.xOAuth2Unbind}</button>
          ) : (
            <button type="button" disabled={oauthBusy} onClick={() => void bindOAuth2()} className="rounded-lg bg-black px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black">{oauthBusy ? t.editor.xOAuth2Binding : t.editor.xOAuth2Bind}</button>
          )}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-neutral-400">{t.editor.xOAuth2Hint}</p>
      </div>
      {error && <div className="mt-3 text-sm text-red-600 dark:text-red-400"><p role="alert">{error}</p><button type="button" onClick={() => setRetry((value) => value + 1)} className="mt-2 underline">{t.editor.xAccountRetry}</button></div>}
      {notice && <p role="status" className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">{notice}</p>}
    </section>
  );
}

function apiErrorText(error: unknown, fallback: string, errors: Record<string, string>): string {
  const code = error instanceof ApiError ? error.code : undefined;
  return (code && errors[code]) || fallback;
}

function xOAuth2FailureText(code: string | null | undefined, fallback: string, errors: Record<string, string>): string {
  const errorCode = code ? {
    x_oauth2_invalid_state: "oauth_invalid_state",
    x_oauth2_denied: "oauth_denied",
    x_oauth2_missing_code: "oauth_missing_params",
    x_oauth2_exchange_failed: "oauth_exchange_failed",
    x_oauth2_profile_failed: "oauth_profile_failed",
    x_oauth2_store_failed: "oauth_sync_failed",
  }[code] : undefined;
  return (errorCode && errors[errorCode]) || fallback;
}
