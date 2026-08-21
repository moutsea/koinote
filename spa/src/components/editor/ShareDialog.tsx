import { useEffect, useRef, useState } from "react";
import { Check, Copy, Eye, Link2, LoaderCircle, Lock, X } from "lucide-react";
import { ApiError } from "../../api";
import {
  useCreateShare,
  useRevokeShare,
  type DocumentShare,
  type ShareAccess,
} from "../../documents";
import { useI18n } from "../../i18n";
import { confirmAction } from "../../confirmAction";
import { koinoteWebURL } from "../../externalNavigation";
import { pushModal } from "../../modalStack";

export function ShareDialog({
  docId,
  share,
  onClose,
}: {
  docId: string;
  share: DocumentShare | null | undefined;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const create = useCreateShare();
  const revoke = useRevokeShare();

  const [access, setAccess] = useState<ShareAccess>(share?.access ?? "link");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [rotated, setRotated] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const shareURL = share
    ? koinoteWebURL(`/share/${encodeURIComponent(share.token)}`)
    : "";

  // Esc 关闭 + 打开时焦点进入对话框，避免焦点留在背后的编辑器里
  useEffect(() => {
    const releaseModal = pushModal();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      releaseModal();
    };
  }, [onClose]);

  function translateError(err: unknown): string {
    if (err instanceof ApiError) {
      if (err.code && t.errors[err.code]) return t.errors[err.code];
      return err.message;
    }
    return t.auth.requestFailed;
  }

  async function submit() {
    setError(null);
    try {
      const result = await create.mutateAsync({
        docId,
        access,
        password: access === "password" ? password : undefined,
      });
      setPassword(""); // 提交后不再留在内存里
      // 放宽权限时后端换了 token，老链接已失效。用户可能已经把老链接
      // 发出去了，必须显式告知，否则他不会知道要重新分享。
      const didRotate = Boolean(result?.share?.tokenRotated);
      setRotated(didRotate);
      if (didRotate) setCopied(false); // 链接变了，"已复制"不再成立
    } catch (err) {
      setError(translateError(err));
    }
  }

  async function handleRevoke() {
    if (!(await confirmAction(t.editor.shareRevokeConfirm))) return;
    setError(null);
    try {
      await revoke.mutateAsync(docId);
    } catch (err) {
      setError(translateError(err));
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareURL);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // 非 HTTPS 或权限被拒时 clipboard 不可用，明确提示而非静默
      setError(t.editor.shareCopyFailed);
    }
  }

  const busy = create.isPending || revoke.isPending;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t.editor.shareTitle}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-black/5 bg-[var(--background)] p-5 shadow-xl outline-none dark:border-white/10"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">{t.editor.shareTitle}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.editor.shareClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-black/5 dark:hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-1 text-xs text-neutral-400">
          {share ? t.editor.shareActive : t.editor.shareNotShared}
        </p>
        {share && (
          <p className="mt-2 inline-flex items-center gap-1 text-xs text-neutral-400">
            <Eye className="h-3.5 w-3.5" />
            {t.editor.sharedViews.replace(
              "{count}",
              String(share.viewCount ?? 0),
            )}
          </p>
        )}

        <div className="mt-4 space-y-2">
          <AccessOption
            icon={<Link2 className="h-4 w-4" />}
            label={t.editor.shareAccessLink}
            hint={t.editor.shareAccessLinkHint}
            checked={access === "link"}
            onSelect={() => setAccess("link")}
          />
          <AccessOption
            icon={<Lock className="h-4 w-4" />}
            label={t.editor.shareAccessPassword}
            hint={t.editor.shareAccessPasswordHint}
            checked={access === "password"}
            onSelect={() => setAccess("password")}
          />
        </div>

        {access === "password" && (
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t.editor.sharePasswordPlaceholder}
            autoComplete="new-password"
            className="mt-3 w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none transition focus:border-cinnabar-500 dark:border-white/15 dark:bg-white/5"
          />
        )}

        {error && (
          <p
            role="alert"
            className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400"
          >
            {error}
          </p>
        )}

        {/* 紧贴链接输入框上方：用户正要复制链接时才最可能读到这句 */}
        {rotated && (
          <p
            role="status"
            className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:bg-amber-950/40 dark:text-amber-400"
          >
            {t.editor.shareTokenRotated}
          </p>
        )}

        {share && (
          <div className="mt-4 flex items-center gap-2">
            <input
              readOnly
              value={shareURL}
              onFocus={(e) => e.currentTarget.select()}
              aria-label={t.editor.shareCopyLink}
              className="min-w-0 flex-1 truncate rounded-lg border border-black/10 bg-black/[0.03] px-3 py-2 font-mono text-xs outline-none dark:border-white/15 dark:bg-white/5"
            />
            <button
              type="button"
              onClick={copyLink}
              title={t.editor.shareCopyLink}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-black/10 px-3 text-xs font-medium transition hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-600" />
                  {t.editor.shareCopied}
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  {t.editor.shareCopyLink}
                </>
              )}
            </button>
          </div>
        )}

        <div className="mt-5 flex items-center gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="rounded-full bg-cinnabar-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-cinnabar-500 disabled:opacity-60"
          >
            {create.isPending ? (
              <span className="inline-flex items-center gap-1.5">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                {t.editor.shareSaving}
              </span>
            ) : share ? t.editor.shareUpdate : t.editor.shareEnable}
          </button>
          {share && (
            <button
              type="button"
              onClick={handleRevoke}
              disabled={busy}
              className="rounded-full px-4 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-60 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              {revoke.isPending ? t.editor.shareSaving : t.editor.shareRevoke}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function AccessOption({
  icon,
  label,
  hint,
  checked,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={checked}
      className={`flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
        checked
          ? "border-cinnabar-500 bg-cinnabar-50/60 dark:bg-cinnabar-950/30"
          : "border-black/10 hover:bg-black/[0.03] dark:border-white/15 dark:hover:bg-white/5"
      }`}
    >
      <span
        className={`mt-0.5 shrink-0 ${checked ? "text-cinnabar-600 dark:text-cinnabar-400" : "text-neutral-400"}`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-neutral-400">
          {hint}
        </span>
      </span>
    </button>
  );
}
