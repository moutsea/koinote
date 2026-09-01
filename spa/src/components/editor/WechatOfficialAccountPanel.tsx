import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Link2, Loader2, Pencil, Plus, Star, Trash2 } from "lucide-react";
import {
  ApiError,
  createWechatOfficialAccount,
  deleteWechatOfficialAccountById,
  getWechatOfficialAccounts,
  setDefaultWechatOfficialAccount,
  updateWechatOfficialAccountById,
  type WechatOfficialAccount,
} from "../../api";
import { useI18n } from "../../i18n";

export function WechatOfficialAccountPanel({
  member,
  localMode,
}: {
  member: boolean;
  localMode: boolean;
}) {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<WechatOfficialAccount[]>([]);
  const [maxCount, setMaxCount] = useState(5);
  const [accountLoading, setAccountLoading] = useState(true);
  const [accountLoadFailed, setAccountLoadFailed] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [accountBusy, setAccountBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!member || localMode) return;
    let cancelled = false;
    setAccountLoading(true);
    setAccountLoadFailed(false);
    setError(null);
    void getWechatOfficialAccounts()
      .then((result) => {
        if (cancelled) return;
        setAccounts(result.accounts);
        setMaxCount(result.maxCount);
      })
      .catch((caught) => {
        if (!cancelled) {
          setAccountLoadFailed(true);
          setError(
            apiErrorText(caught, t.editor.wechatAccountLoadFailed, t.errors),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setAccountLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    loadVersion,
    localMode,
    member,
    t.editor.wechatAccountLoadFailed,
    t.errors,
  ]);

  function closeEditor() {
    setCreating(false);
    setEditingAccountId(null);
    setLabel("");
    setAppId("");
    setAppSecret("");
  }

  function startCreate() {
    setError(null);
    setCreating(true);
    setEditingAccountId(null);
    setLabel("");
    setAppId("");
    setAppSecret("");
  }

  function startEdit(account: WechatOfficialAccount) {
    setError(null);
    setCreating(false);
    setEditingAccountId(account.accountId);
    setLabel(account.label);
    setAppId(account.appId);
    setAppSecret("");
  }

  async function saveAccount() {
    const existing = accounts.find(
      (account) => account.accountId === editingAccountId,
    );
    const secretRequired = !existing || appId.trim() !== existing.appId;
    if (!appId.trim() || (secretRequired && !appSecret.trim())) return;
    setError(null);
    setAccountBusy(true);
    try {
      const commonInput = {
        label: label.trim(),
        appId: appId.trim(),
      };
      const result = editingAccountId
        ? await updateWechatOfficialAccountById(editingAccountId, {
            ...commonInput,
            ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}),
          })
        : await createWechatOfficialAccount({
            ...commonInput,
            appSecret: appSecret.trim(),
          });
      setAccounts((current) => {
        const found = current.some(
          (account) => account.accountId === result.account.accountId,
        );
        const next = found
          ? current.map((account) =>
              account.accountId === result.account.accountId
                ? result.account
                : account,
            )
          : [...current, result.account];
        return next.sort(compareWechatAccounts);
      });
      closeEditor();
    } catch (caught) {
      setError(
        apiErrorText(
          caught,
          editingAccountId
            ? t.editor.wechatAccountSaveFailed
            : t.editor.wechatAccountBindFailed,
          t.errors,
        ),
      );
    } finally {
      setAccountBusy(false);
    }
  }

  async function makeDefault(accountId: string) {
    setError(null);
    setAccountBusy(true);
    try {
      const result = await setDefaultWechatOfficialAccount(accountId);
      setAccounts((current) =>
        current
          .map((account) => ({
            ...account,
            isDefault: account.accountId === result.account.accountId,
          }))
          .sort(compareWechatAccounts),
      );
    } catch (caught) {
      setError(
        apiErrorText(caught, t.editor.wechatAccountSaveFailed, t.errors),
      );
    } finally {
      setAccountBusy(false);
    }
  }

  async function unbindAccount(account: WechatOfficialAccount) {
    if (!window.confirm(t.editor.wechatAccountUnbindConfirm)) return;
    setError(null);
    setAccountBusy(true);
    try {
      const result = await deleteWechatOfficialAccountById(account.accountId);
      setAccounts((current) =>
        current
          .filter((item) => item.accountId !== account.accountId)
          .map((item) => ({
            ...item,
            isDefault: item.accountId === result.defaultAccountId,
          }))
          .sort(compareWechatAccounts),
      );
      if (editingAccountId === account.accountId) closeEditor();
    } catch (caught) {
      setError(
        apiErrorText(caught, t.editor.wechatAccountUnbindFailed, t.errors),
      );
    } finally {
      setAccountBusy(false);
    }
  }

  if (!member) {
    return (
      <section className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-5">
        <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-200">
          {t.editor.wechatOfficialTitle}
        </h3>
        <p className="mt-1.5 text-sm leading-6 text-amber-700 dark:text-amber-300">
          {t.editor.wechatOfficialMembersOnly}
        </p>
        <Link
          to="/pricing"
          className="mt-4 inline-flex rounded-full bg-[var(--cinnabar)] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
        >
          {t.settingsPage.upgrade}
        </Link>
      </section>
    );
  }

  if (localMode) {
    return (
      <section className="rounded-xl border border-black/10 bg-black/[0.02] p-5 text-sm leading-6 text-neutral-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-neutral-400">
        {t.desktopLocalMode.networkDisabled}
      </section>
    );
  }

  const controlsDisabled = accountBusy || accountLoading;
  const editorOpen = creating || editingAccountId !== null;
  const editingAccount = accounts.find(
    (account) => account.accountId === editingAccountId,
  );
  const appIdChanged = Boolean(
    editingAccount && appId.trim() !== editingAccount.appId,
  );
  const appSecretRequired = creating || appIdChanged;

  return (
    <section className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.035] p-5">
      <div className="flex items-start gap-2.5">
        <Link2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold">
            {t.editor.wechatOfficialTitle}
          </h3>
          <p className="mt-1.5 text-sm leading-6 text-neutral-500 dark:text-neutral-400">
            {t.editor.wechatOfficialHint}
          </p>
          <Link
            to="/docs/wechat-official-account"
            className="kn-ink-link mt-2 inline-flex text-xs font-semibold"
            style={{ color: "var(--ink-strong)" }}
          >
            {t.wechatGuide.openGuide} →
          </Link>
        </div>
      </div>

      {accountLoading ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-neutral-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t.editor.wechatAccountLoading}
        </p>
      ) : accountLoadFailed ? (
        <div className="mt-4 rounded-lg border border-red-500/15 bg-red-500/5 px-3.5 py-3 text-sm text-red-600 dark:text-red-400">
          <p role="alert">{error || t.editor.wechatAccountLoadFailed}</p>
          <button
            type="button"
            onClick={() => setLoadVersion((current) => current + 1)}
            className="mt-2 rounded-md border border-red-500/20 px-3 py-1.5 text-xs font-medium transition hover:bg-red-500/10"
          >
            {t.editor.wechatAccountRetry}
          </button>
        </div>
      ) : (
        <>
          <div className="mt-5 space-y-2.5">
            {accounts.map((account) => (
              <div
                key={account.accountId}
                className="flex items-center justify-between gap-3 rounded-lg border border-black/5 bg-white/60 px-3.5 py-3 dark:border-white/10 dark:bg-white/5"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">
                      {account.label || account.appId}
                    </p>
                    {account.isDefault && (
                      <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                        {t.editor.wechatAccountDefault}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-neutral-400">
                    {account.appId} · {account.secretHint}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {!account.isDefault && (
                    <button
                      type="button"
                      disabled={controlsDisabled}
                      onClick={() => void makeDefault(account.accountId)}
                      className="rounded-md p-2 text-neutral-400 transition hover:bg-emerald-50 hover:text-emerald-600 disabled:opacity-50 dark:hover:bg-emerald-950/40"
                      aria-label={t.editor.wechatAccountSetDefault}
                      title={t.editor.wechatAccountSetDefault}
                    >
                      <Star className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={controlsDisabled}
                    onClick={() => startEdit(account)}
                    className="rounded-md p-2 text-neutral-400 transition hover:bg-black/5 hover:text-neutral-700 disabled:opacity-50 dark:hover:bg-white/10 dark:hover:text-neutral-200"
                    aria-label={t.editor.wechatAccountRebind}
                    title={t.editor.wechatAccountRebind}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    disabled={controlsDisabled}
                    onClick={() => void unbindAccount(account)}
                    className="rounded-md p-2 text-neutral-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-950/50"
                    aria-label={t.editor.wechatAccountUnbind}
                    title={t.editor.wechatAccountUnbind}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {!editorOpen && (
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-xs text-neutral-400">
                {accounts.length}/{maxCount} {t.editor.wechatAccountBound}
              </p>
              <button
                type="button"
                disabled={controlsDisabled || accounts.length >= maxCount}
                onClick={startCreate}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/25 px-3 py-2 text-sm font-medium text-emerald-700 transition hover:bg-emerald-500/10 disabled:opacity-45 dark:text-emerald-300"
              >
                <Plus className="h-4 w-4" />
                {t.editor.wechatAccountAdd}
              </button>
            </div>
          )}

          {accounts.length >= maxCount && !editorOpen && (
            <p className="mt-2 text-xs leading-relaxed text-amber-600 dark:text-amber-400">
              {t.editor.wechatAccountLimitReached}
            </p>
          )}

          {editorOpen && (
            <div className="mt-4 space-y-3 rounded-xl border border-black/5 bg-white/40 p-3.5 dark:border-white/10 dark:bg-white/[0.03]">
              <label className="block text-xs text-neutral-500">
                {t.editor.wechatAccountLabel}
                <input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  disabled={controlsDisabled}
                  maxLength={40}
                  autoComplete="off"
                  placeholder={t.editor.wechatAccountLabelPlaceholder}
                  className="mt-1.5 w-full rounded-lg border border-black/10 bg-transparent px-3 py-2.5 text-sm outline-none transition focus:border-emerald-500/50 dark:border-white/15"
                />
              </label>
              <label className="block text-xs text-neutral-500">
                {t.editor.wechatAppId}
                <input
                  value={appId}
                  onChange={(event) => setAppId(event.target.value)}
                  disabled={controlsDisabled}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="wx…"
                  className="mt-1.5 w-full rounded-lg border border-black/10 bg-transparent px-3 py-2.5 text-sm outline-none transition focus:border-emerald-500/50 dark:border-white/15"
                />
              </label>
              <label className="block text-xs text-neutral-500">
                {t.editor.wechatAppSecret}
                <input
                  type="password"
                  value={appSecret}
                  onChange={(event) => setAppSecret(event.target.value)}
                  disabled={controlsDisabled}
                  autoComplete="new-password"
                  placeholder={
                    editingAccount
                      ? t.editor.wechatAppSecretUpdatePlaceholder
                      : t.editor.wechatAppSecretPlaceholder
                  }
                  className="mt-1.5 w-full rounded-lg border border-black/10 bg-transparent px-3 py-2.5 text-sm outline-none transition focus:border-emerald-500/50 dark:border-white/15"
                />
              </label>
              <p className="text-xs leading-relaxed text-amber-600 dark:text-amber-400">
                {t.editor.wechatIPAllowlistHint}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  disabled={controlsDisabled}
                  onClick={closeEditor}
                  className="rounded-lg px-3 py-2 text-sm text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
                >
                  {t.editor.wechatAccountCancel}
                </button>
                <button
                  type="button"
                  disabled={
                    controlsDisabled ||
                    !appId.trim() ||
                    (appSecretRequired && !appSecret.trim())
                  }
                  onClick={() => void saveAccount()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-45"
                >
                  {accountBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {editingAccountId
                    ? t.editor.wechatAccountSave
                    : t.editor.wechatAccountBind}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {error && !accountLoadFailed && (
        <p
          role="alert"
          className="mt-4 text-sm leading-relaxed text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      )}
    </section>
  );
}

function compareWechatAccounts(
  left: WechatOfficialAccount,
  right: WechatOfficialAccount,
): number {
  if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
  return (left.label || left.appId).localeCompare(right.label || right.appId);
}

function apiErrorText(
  error: unknown,
  fallback: string,
  errors: Record<string, string>,
): string {
  const code = error instanceof ApiError ? error.code : undefined;
  return (code && errors[code]) || fallback;
}
