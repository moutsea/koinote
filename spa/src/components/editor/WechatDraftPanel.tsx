import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, ImagePlus, Loader2, Send } from "lucide-react";
import {
  ApiError,
  createWechatDraft,
  getDocument,
  getWechatOfficialAccounts,
  type WechatOfficialAccount,
} from "../../api";
import { useI18n } from "../../i18n";
import { CoverImage } from "./CoverImage";
import { DocumentCoverDialog, type DocumentCoverState } from "./DocumentCoverDialog";
import { wechatDraftCoverInput } from "./wechatDraftCover";

export function WechatDraftPanel({
  accounts: initialAccounts,
  docId,
  title,
  author,
  digest,
  disabled,
  member,
  articleImages,
  prepareHTML,
  onPublishingChange,
}: {
  accounts?: WechatOfficialAccount[];
  docId: string;
  title: string;
  author?: string;
  digest?: string;
  disabled: boolean;
  member: boolean;
  articleImages: Array<{ src: string; alt: string }>;
  prepareHTML: () => Promise<string | null>;
  onPublishingChange?: (publishing: boolean) => void;
}) {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<WechatOfficialAccount[]>(initialAccounts ?? []);
  const [accountLoading, setAccountLoading] = useState(initialAccounts === undefined);
  const [selectedAccountId, setSelectedAccountId] = useState(
    initialAccounts?.find((account) => account.isDefault)?.accountId ??
      initialAccounts?.[0]?.accountId ?? "",
  );
  const [coverState, setCoverState] = useState<DocumentCoverState | null>(null);
  const [coverLoading, setCoverLoading] = useState(true);
  const [coverLoadError, setCoverLoadError] = useState(false);
  const [coverLoadAttempt, setCoverLoadAttempt] = useState(0);
  const [coverDialogOpen, setCoverDialogOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const publishingRef = useRef(false);

  useEffect(() => {
    if (initialAccounts !== undefined) {
      setAccounts(initialAccounts);
      setAccountLoading(false);
      return;
    }
    let cancelled = false;
    setAccountLoading(true);
    void getWechatOfficialAccounts().then((result) => {
      if (!cancelled) setAccounts(result.accounts);
    }).catch((caught) => {
      if (!cancelled) setError(apiErrorText(caught, t.editor.wechatAccountLoadFailed, t.errors));
    }).finally(() => {
      if (!cancelled) setAccountLoading(false);
    });
    return () => { cancelled = true; };
  }, [initialAccounts, t.editor.wechatAccountLoadFailed, t.errors]);

  useEffect(() => {
    if (accounts.some((account) => account.accountId === selectedAccountId)) return;
    setSelectedAccountId(accounts.find((account) => account.isDefault)?.accountId ?? accounts[0]?.accountId ?? "");
  }, [accounts, selectedAccountId]);

  useEffect(() => {
    let cancelled = false;
    setCoverState(null);
    setCoverDialogOpen(false);
    setPublished(false);
    setCoverLoading(true);
    setCoverLoadError(false);
    void getDocument(docId).then(({ document }) => {
      if (cancelled) return;
      setCoverState({
        coverMode: document.coverMode ?? "default",
        coverRatio: document.coverRatio ?? "2.35:1",
        coverImageSource: document.coverImageSource ?? "",
        coverPrompt: document.coverPrompt ?? "",
      });
    }).catch(() => {
      if (!cancelled) setCoverLoadError(true);
    }).finally(() => {
      if (!cancelled) setCoverLoading(false);
    });
    return () => { cancelled = true; };
  }, [docId, coverLoadAttempt]);

  async function publishDraft() {
    if (
      disabled || publishingRef.current || coverLoadError || !coverState ||
      !selectedAccountId || publishing || published ||
      title.trim().length === 0 || [...title.trim()].length > 64
    ) return;
    publishingRef.current = true;
    setError(null);
    setPublished(false);
    setPublishing(true);
    onPublishingChange?.(true);
    try {
      const html = await prepareHTML();
      if (!html) return;
      const coverInput = await wechatDraftCoverInput(coverState);
      await createWechatDraft(docId, {
        accountId: selectedAccountId,
        title: title.trim(),
        ...(author?.trim() ? { author: author.trim() } : {}),
        ...(digest?.trim() ? { digest: digest.trim() } : {}),
        html,
        ...coverInput,
      });
      setPublished(true);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "wechat_account_not_bound") {
        try {
          const result = await getWechatOfficialAccounts();
          setAccounts(result.accounts);
          setError(result.accounts.length > 0 ? t.errors.not_found : t.editor.wechatAccountNotBound);
        } catch (reloadError) {
          setError(apiErrorText(reloadError, t.editor.wechatAccountLoadFailed, t.errors));
        }
      } else {
        setError(apiErrorText(caught, t.editor.wechatDraftCreateFailed, t.errors));
      }
    } finally {
      publishingRef.current = false;
      setPublishing(false);
      onPublishingChange?.(false);
    }
  }

  const controlsDisabled = disabled || publishing;
  const titleInvalid = title.trim().length === 0 || [...title.trim()].length > 64;
  const hasCover = Boolean(coverState?.coverImageSource.trim());

  if (accountLoading || coverLoading) {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.035] px-4 py-5 text-sm text-neutral-500 dark:text-neutral-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        {accountLoading ? t.editor.wechatAccountLoading : t.editor.wechatCoverLoading}
      </div>
    );
  }
  if (accounts.length === 0) {
    return (
      <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-4 text-sm leading-6 text-amber-700 dark:text-amber-300">
        <p role={error ? "alert" : undefined}>{error || t.editor.wechatAccountNotBound}</p>
        {!error && (
          <Link to="/settings" search={{ section: "wechat" }} className="mt-2 inline-flex font-semibold underline underline-offset-2">
            {t.settingsPage.wechat}
          </Link>
        )}
      </div>
    );
  }

  return (
    <section className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.035] p-3.5">
      <div className="flex items-start gap-2.5">
        <Send className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{t.editor.wechatDraftPush}</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-neutral-400">{t.editor.wechatDraftPushHint}</p>
        </div>
      </div>
      <label className="mt-3 block text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
        {t.editor.wechatTargetAccount}
        <select
          value={selectedAccountId}
          disabled={controlsDisabled}
          onChange={(event) => { setSelectedAccountId(event.target.value); setPublished(false); }}
          className="mt-1.5 w-full rounded-lg border border-black/10 bg-transparent px-3 py-2 text-xs outline-none transition focus:border-emerald-500/50 disabled:opacity-60 dark:border-white/10"
        >
          {accounts.map((account) => (
            <option key={account.accountId} value={account.accountId}>
              {account.label || account.appId}
              {account.isDefault ? ` · ${t.editor.wechatAccountDefault}` : ""}
            </option>
          ))}
        </select>
      </label>
      <div className="mt-4 border-t border-emerald-500/15 pt-3.5">
        <div className="flex items-center gap-2">
          <ImagePlus className="h-4 w-4 text-neutral-400" />
          <h4 className="text-xs font-semibold">{t.editor.wechatCoverTitle}</h4>
        </div>
        {coverLoadError ? (
          <div className="mt-3 text-[11px] text-red-600 dark:text-red-400">
            <p role="alert">{t.editor.wechatCoverLoadFailed}</p>
            <button type="button" onClick={() => setCoverLoadAttempt((attempt) => attempt + 1)} className="mt-2 font-semibold underline underline-offset-2">{t.editor.wechatAccountRetry}</button>
          </div>
        ) : coverState && hasCover ? (
          <div className="mt-3 overflow-hidden rounded-lg border border-black/10 bg-black/5 dark:border-white/10">
            <CoverImage source={coverState.coverImageSource} alt={t.editor.wechatCoverPreview} className="mx-auto block w-full max-w-sm object-cover" style={{ aspectRatio: coverState.coverRatio.replace(":", " / ") }} />
            <div className="flex items-center justify-between gap-3 px-3 py-2">
              <p className="text-[11px] text-neutral-500">{t.editor.wechatCoverDraftOnly}</p>
              <button type="button" disabled={controlsDisabled} onClick={() => setCoverDialogOpen(true)} className="shrink-0 rounded-full border border-black/10 px-3 py-1 text-[11px] font-semibold disabled:opacity-60 dark:border-white/15">{t.editor.wechatCoverChange}</button>
            </div>
          </div>
        ) : (
          <div className="mt-3 rounded-lg border border-dashed border-black/10 px-3 py-4 text-center text-[11px] text-neutral-400 dark:border-white/10">
            {t.editor.wechatCoverUnset}
            <button type="button" disabled={controlsDisabled} onClick={() => setCoverDialogOpen(true)} className="ml-2 font-semibold text-emerald-700 underline underline-offset-2 dark:text-emerald-300">{t.editor.wechatCoverSet}</button>
          </div>
        )}
      </div>
      {titleInvalid && <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">{t.editor.wechatTitleLimit}</p>}
      <button
        type="button"
        disabled={controlsDisabled || published || titleInvalid || !coverState || coverLoadError}
        onClick={() => void publishDraft()}
        className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-500 disabled:opacity-45"
      >
        {publishing ? <Loader2 className="h-4 w-4 animate-spin" /> : published ? <CheckCircle2 className="h-4 w-4" /> : <Send className="h-4 w-4" />}
        {publishing ? t.editor.wechatDraftCreating : published ? t.editor.wechatDraftCreated : t.editor.wechatDraftCreate}
      </button>
      {error && <p role="alert" className="mt-3 text-[11px] leading-relaxed text-red-600 dark:text-red-400">{error}</p>}
      {coverDialogOpen && coverState && (
        <DocumentCoverDialog
          title={title}
          member={member}
          articleImages={articleImages}
          initial={coverState}
          purpose="wechat-draft"
          onSave={(next) => { setCoverState(next); setPublished(false); setError(null); }}
          onClose={() => setCoverDialogOpen(false)}
        />
      )}
    </section>
  );
}

function apiErrorText(error: unknown, fallback: string, errors: Record<string, string>): string {
  const code = error instanceof ApiError ? error.code : undefined;
  return (code && errors[code]) || fallback;
}
