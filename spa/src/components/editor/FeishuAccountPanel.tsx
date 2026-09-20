import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ExternalLink, Link2, Loader2, Unlink } from "lucide-react";
import {
  disconnectFeishu,
  feishuErrorText,
  getFeishuAccount,
  startFeishuOAuth,
  type FeishuAccount,
} from "../../feishu";
import { useI18n } from "../../i18n";
import { desktopFlavor, isDesktopRuntime } from "../../desktop/runtime";
import { confirmAction } from "../../confirmAction";

export function FeishuAccountPanel({ member, localMode }: { member: boolean; localMode: boolean }) {
  const { t } = useI18n();
  const [account, setAccount] = useState<FeishuAccount | null>(null);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!member || localMode) return;
    setError(null);
    const params = new URLSearchParams(window.location.search);
    if (params.get("feishu") === "success") {
      setError(null);
      setNotice(t.feishu.connected);
    }
    if (params.get("feishu") === "error") {
      setNotice(null);
      setError(t.feishu.failed);
    }
    if (params.has("feishu")) {
      params.delete("feishu");
      window.history.replaceState(null, "", `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`);
    }
    let cancelled = false;
    setLoading(true);
    void getFeishuAccount()
      .then((result) => {
        if (cancelled) return;
        setAccount(result.account);
        setConfigured(result.configured);
      })
      .catch((caught) => {
        if (!cancelled) setError(feishuErrorText(caught, t.feishu));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [member, localMode, reload, t.feishu]);

  useEffect(() => {
    if (!member || localMode) return;
    const listener = (event: Event) => {
      const status = (event as CustomEvent<{ status?: string }>).detail?.status;
      if (status === "success") {
        setBusy(false);
        setError(null);
        setNotice(t.feishu.connected);
        setReload((value) => value + 1);
      } else if (status) {
        setBusy(false);
        setNotice(null);
        setError(t.feishu.failed);
      }
    };
    window.addEventListener("koinote:feishu-oauth-complete", listener);
    return () => window.removeEventListener("koinote:feishu-oauth-complete", listener);
  }, [member, localMode, t.feishu.connected, t.feishu.failed]);

  async function connect() {
    if (!member || localMode) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await startFeishuOAuth(isDesktopRuntime() ? (desktopFlavor() === "local" ? "desktop-local" : "desktop") : undefined);
      if (isDesktopRuntime()) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(result.url);
      } else {
        window.location.assign(result.url);
      }
    } catch (caught) {
      setError(feishuErrorText(caught, t.feishu));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!(await confirmAction(t.feishu.unbindConfirm))) return;
    setBusy(true);
    setError(null);
    try {
      await disconnectFeishu();
      setAccount(null);
      setNotice(null);
    } catch (caught) {
      setError(feishuErrorText(caught, t.feishu));
    } finally {
      setBusy(false);
    }
  }

  if (localMode) return <section className="rounded-xl border border-black/10 bg-black/[0.02] p-5 text-sm leading-6 text-neutral-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-neutral-400">{t.desktopLocalMode.networkDisabled}</section>;
  if (!member) {
    return (
      <section className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-5">
        <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-200">{t.feishu.name}</h3>
        <p className="mt-1.5 text-sm leading-6 text-amber-700 dark:text-amber-300">{t.feishu.membersOnly}</p>
        <Link to="/pricing" className="mt-4 inline-flex rounded-full bg-[var(--cinnabar)] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90">
          {t.settingsPage.upgrade}
        </Link>
      </section>
    );
  }
  if (loading) return <p className="flex items-center gap-2 text-sm text-neutral-400"><Loader2 className="h-4 w-4 animate-spin" />{t.feishu.loading}</p>;
  return (
    <section className="rounded-xl border border-sky-500/20 bg-sky-500/[0.035] p-5">
      <div className="flex items-start gap-2.5">
        <Link2 className="mt-0.5 h-5 w-5 shrink-0 text-sky-600 dark:text-sky-400" />
        <div>
          <h3 className="text-base font-semibold">{t.feishu.name}</h3>
          <p className="mt-1.5 text-sm leading-6 text-neutral-500 dark:text-neutral-400">{t.feishu.accountHint}</p>
          <p className="mt-1.5 text-sm leading-6 text-neutral-500 dark:text-neutral-400">{t.feishu.syncHint}</p>
          <p className="mt-1 text-xs leading-5 text-neutral-400">{t.feishu.formats}</p>
          <a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold underline">{t.feishu.openPlatform} <ExternalLink className="h-3 w-3" /></a>
        </div>
      </div>
      {!configured ? (
        <p className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3.5 py-3 text-sm text-amber-700 dark:text-amber-300">{t.feishu.unavailable}</p>
      ) : (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-black/5 bg-white/60 px-3.5 py-3 dark:border-white/10 dark:bg-white/5">
          <p className="min-w-0 break-words text-sm font-medium">{account?.name || t.feishu.notBound}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy} onClick={() => void connect()} className="rounded-lg bg-black px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black">{busy ? t.feishu.loading : t.feishu.bind}</button>
            {account && <button type="button" disabled={busy} onClick={() => void disconnect()} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-neutral-500 hover:bg-black/5 disabled:opacity-50"><Unlink className="h-3.5 w-3.5" />{t.feishu.unbind}</button>}
          </div>
        </div>
      )}
      {error && <div className="mt-3 flex items-center gap-3 text-sm text-red-600 dark:text-red-400"><p role="alert">{error}</p><button type="button" disabled={busy} onClick={() => setReload((value) => value + 1)} className="underline disabled:opacity-50">{t.feishu.retry}</button></div>}
      {notice && <p role="status" className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">{notice}</p>}
    </section>
  );
}
