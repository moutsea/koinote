import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ExternalLink, Link2, Loader2, Pencil, Trash2 } from "lucide-react";
import {
  ApiError,
  deleteZhihuAccount,
  getZhihuAccount,
  updateZhihuAccount,
  type ZhihuAccount,
} from "../../api";
import { useI18n } from "../../i18n";

export function ZhihuAccountPanel({ localMode }: { localMode: boolean }) {
  const { t } = useI18n();
  const [account, setAccount] = useState<ZhihuAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [appKey, setAppKey] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);

  useEffect(() => {
    if (localMode) return;
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    setError(null);
    void getZhihuAccount()
      .then((result) => {
        if (cancelled) return;
        setAccount(result.account);
        if (result.account) setAppKey(result.account.appKey);
      })
      .catch((caught) => {
        if (!cancelled) {
          setLoadFailed(true);
          setError(apiErrorText(caught, t.editor.zhihuAccountLoadFailed, t.errors));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadVersion, localMode, t.editor.zhihuAccountLoadFailed, t.errors]);

  function startEdit() {
    setError(null);
    setEditing(true);
    setAppKey(account?.appKey ?? "");
    setAppSecret("");
  }

  function cancelEdit() {
    setEditing(false);
    setAppKey(account?.appKey ?? "");
    setAppSecret("");
  }

  async function save() {
    const trimmedKey = appKey.trim();
    const trimmedSecret = appSecret.trim();
    if (!trimmedKey || (!account && !trimmedSecret)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await updateZhihuAccount({
        appKey: trimmedKey,
        ...(trimmedSecret ? { appSecret: trimmedSecret } : {}),
      });
      setAccount(result.account);
      setEditing(false);
      setAppSecret("");
    } catch (caught) {
      setError(
        apiErrorText(
          caught,
          account ? t.editor.zhihuAccountSaveFailed : t.editor.zhihuAccountBindFailed,
          t.errors,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function unbind() {
    if (!account || !window.confirm(t.editor.zhihuAccountUnbindConfirm)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteZhihuAccount();
      setAccount(null);
      setEditing(false);
      setAppKey("");
      setAppSecret("");
    } catch (caught) {
      setError(apiErrorText(caught, t.editor.zhihuAccountUnbindFailed, t.errors));
    } finally {
      setBusy(false);
    }
  }

  if (localMode) {
    return (
      <section className="rounded-xl border border-black/10 bg-black/[0.02] p-5 text-sm leading-6 text-neutral-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-neutral-400">
        {t.desktopLocalMode.networkDisabled}
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-sky-500/20 bg-sky-500/[0.035] p-5">
      <div className="flex items-start gap-2.5">
        <Link2 className="mt-0.5 h-5 w-5 shrink-0 text-sky-600 dark:text-sky-400" />
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold">{t.editor.zhihuAccountTitle}</h3>
          <p className="mt-1.5 text-sm leading-6 text-neutral-500 dark:text-neutral-400">
            {t.editor.zhihuAccountHint}
          </p>
          <a
            href="https://www.zhihu.com/playground/zhihu-publisher"
            target="_blank"
            rel="noreferrer"
            className="kn-ink-link mt-2 inline-flex items-center gap-1 text-xs font-semibold"
            style={{ color: "var(--ink-strong)" }}
          >
            {t.editor.zhihuOpenAPIHint} <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>

      {loading ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-neutral-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t.editor.zhihuAccountLoading}
        </p>
      ) : loadFailed ? (
        <div className="mt-4 rounded-lg border border-red-500/15 bg-red-500/5 px-3.5 py-3 text-sm text-red-600 dark:text-red-400">
          <p role="alert">{error || t.editor.zhihuAccountLoadFailed}</p>
          <button
            type="button"
            onClick={() => setLoadVersion((current) => current + 1)}
            className="mt-2 rounded-md border border-red-500/20 px-3 py-1.5 text-xs font-medium transition hover:bg-red-500/10"
          >
            {t.editor.zhihuAccountRetry}
          </button>
        </div>
      ) : !account && !editing ? (
        <div className="mt-4 rounded-lg border border-amber-500/15 bg-amber-500/5 px-3.5 py-3 text-sm text-amber-700 dark:text-amber-300">
          <p>{t.editor.zhihuAccountNotBound}</p>
          <button
            type="button"
            onClick={startEdit}
            className="mt-3 rounded-lg bg-sky-600 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-sky-500"
          >
            {t.editor.zhihuAccountBind}
          </button>
        </div>
      ) : (
        <>
          {account && !editing && (
            <div className="mt-5 flex items-center justify-between gap-3 rounded-lg border border-black/5 bg-white/60 px-3.5 py-3 dark:border-white/10 dark:bg-white/5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{account.appKey}</p>
                <p className="mt-0.5 truncate text-xs text-neutral-400">{account.secretHint}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={startEdit}
                  className="rounded-md p-2 text-neutral-400 transition hover:bg-black/5 hover:text-neutral-700 disabled:opacity-50 dark:hover:bg-white/10 dark:hover:text-neutral-200"
                  aria-label={t.editor.zhihuAccountEdit}
                  title={t.editor.zhihuAccountEdit}
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void unbind()}
                  className="rounded-md p-2 text-neutral-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-950/50"
                  aria-label={t.editor.zhihuAccountUnbind}
                  title={t.editor.zhihuAccountUnbind}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {editing && (
            <div className="mt-4 space-y-3 rounded-xl border border-black/5 bg-white/40 p-3.5 dark:border-white/10 dark:bg-white/[0.03]">
              <label className="block text-xs text-neutral-500">
                {t.editor.zhihuAppKey}
                <input
                  value={appKey}
                  onChange={(event) => setAppKey(event.target.value)}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t.editor.zhihuAppKeyPlaceholder}
                  className="mt-1.5 w-full rounded-lg border border-black/10 bg-transparent px-3 py-2.5 text-sm outline-none transition focus:border-sky-500/50 dark:border-white/15"
                />
              </label>
              <label className="block text-xs text-neutral-500">
                {t.editor.zhihuAppSecret}
                <input
                  type="password"
                  value={appSecret}
                  onChange={(event) => setAppSecret(event.target.value)}
                  disabled={busy}
                  autoComplete="new-password"
                  placeholder={
                    account
                      ? t.editor.zhihuAppSecretUpdatePlaceholder
                      : t.editor.zhihuAppSecretPlaceholder
                  }
                  className="mt-1.5 w-full rounded-lg border border-black/10 bg-transparent px-3 py-2.5 text-sm outline-none transition focus:border-sky-500/50 dark:border-white/15"
                />
              </label>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={cancelEdit}
                  className="rounded-lg px-3 py-2 text-sm text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
                >
                  {t.editor.zhihuAccountCancel}
                </button>
                <button
                  type="button"
                  disabled={busy || !appKey.trim() || (!account && !appSecret.trim())}
                  onClick={() => void save()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-500 disabled:opacity-45"
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {account ? t.editor.zhihuAccountSave : t.editor.zhihuAccountBind}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {error && !loadFailed && (
        <p role="alert" className="mt-4 text-sm leading-relaxed text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}

function apiErrorText(
  error: unknown,
  fallback: string,
  errors: Record<string, string>,
): string {
  const code = error instanceof ApiError ? error.code : undefined;
  return (code && errors[code]) || fallback;
}
