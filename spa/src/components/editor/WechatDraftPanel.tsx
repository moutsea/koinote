import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, ImagePlus, Loader2, Send } from "lucide-react";
import {
  AGENT_CREDITS_QUERY_KEY,
  ApiError,
  createWechatDraft,
  generateWechatCover,
  getWechatOfficialAccounts,
  type WechatCoverRatio,
  type WechatCoverMode,
  type WechatGeneratedCover,
  type WechatOfficialAccount,
} from "../../api";
import { useI18n } from "../../i18n";
import { createDefaultWechatCover } from "./wechatCover";

export function WechatDraftPanel({
  accounts: initialAccounts,
  docId,
  title,
  author,
  digest,
  disabled,
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
  articleImages: Array<{ src: string; alt: string }>;
  prepareHTML: () => Promise<string | null>;
  onPublishingChange?: (publishing: boolean) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [accounts, setAccounts] = useState<WechatOfficialAccount[]>(
    initialAccounts ?? [],
  );
  const [accountLoading, setAccountLoading] = useState(
    initialAccounts === undefined,
  );
  const [selectedAccountId, setSelectedAccountId] = useState(
    initialAccounts?.find((account) => account.isDefault)?.accountId ??
      initialAccounts?.[0]?.accountId ??
      "",
  );
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState<WechatCoverRatio>("2.35:1");
  const [coverMode, setCoverMode] = useState<WechatCoverMode>("default");
  const [selectedImageSource, setSelectedImageSource] = useState<string | null>(
    articleImages[0]?.src ?? null,
  );
  const [defaultCover, setDefaultCover] = useState<WechatGeneratedCover | null>(
    null,
  );
  const [defaultCoverGenerating, setDefaultCoverGenerating] = useState(false);
  const [cover, setCover] = useState<WechatGeneratedCover | null>(null);
  const [coverGenerating, setCoverGenerating] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const coverAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (initialAccounts !== undefined) {
      setAccounts(initialAccounts);
      setAccountLoading(false);
      return;
    }
    let cancelled = false;
    setAccountLoading(true);
    void getWechatOfficialAccounts()
      .then((result) => {
        if (!cancelled) setAccounts(result.accounts);
      })
      .catch((caught) => {
        if (!cancelled) {
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
  }, [initialAccounts, t.editor.wechatAccountLoadFailed, t.errors]);

  useEffect(
    () => () => {
      coverAbortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (accounts.some((account) => account.accountId === selectedAccountId)) {
      return;
    }
    setSelectedAccountId(
      accounts.find((account) => account.isDefault)?.accountId ??
        accounts[0]?.accountId ??
        "",
    );
  }, [accounts, selectedAccountId]);

  useEffect(() => {
    if (
      selectedImageSource &&
      articleImages.some((image) => image.src === selectedImageSource)
    ) {
      return;
    }
    setSelectedImageSource(articleImages[0]?.src ?? null);
  }, [articleImages, selectedImageSource]);

  useEffect(() => {
    let cancelled = false;
    setDefaultCover(null);
    setDefaultCoverGenerating(true);
    void createDefaultWechatCover(title, ratio)
      .then((result) => {
        if (!cancelled) setDefaultCover(result);
      })
      .catch(() => {
        if (!cancelled) setError(t.editor.wechatCoverGenerateFailed);
      })
      .finally(() => {
        if (!cancelled) setDefaultCoverGenerating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ratio, t.editor.wechatCoverGenerateFailed, title]);

  async function runCoverGeneration() {
    if (!prompt.trim() || coverAbortRef.current) return;
    const controller = new AbortController();
    coverAbortRef.current = controller;
    setError(null);
    setPublished(false);
    setCoverGenerating(true);
    try {
      const result = await generateWechatCover(
        prompt.trim(),
        ratio,
        controller.signal,
      );
      setCover(result.cover);
      setCoverMode("ai");
      void queryClient.invalidateQueries({ queryKey: AGENT_CREDITS_QUERY_KEY });
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(
          apiErrorText(caught, t.editor.wechatCoverGenerateFailed, t.errors),
        );
      }
    } finally {
      if (coverAbortRef.current === controller) coverAbortRef.current = null;
      setCoverGenerating(false);
    }
  }

  async function publishDraft() {
    const selectedArticleImage = articleImages.find(
      (image) => image.src === selectedImageSource,
    );
    if (
      !selectedAccountId ||
      publishing ||
      published ||
      title.trim().length === 0 ||
      (coverMode === "default" && !defaultCover) ||
      (coverMode === "ai" && !cover) ||
      (coverMode === "article" && !selectedArticleImage)
    )
      return;
    setError(null);
    setPublished(false);
    setPublishing(true);
    onPublishingChange?.(true);
    try {
      const html = await prepareHTML();
      if (!html) return;
      await createWechatDraft(docId, {
        accountId: selectedAccountId,
        title: title.trim(),
        ...(author?.trim() ? { author: author.trim() } : {}),
        ...(digest?.trim() ? { digest: digest.trim() } : {}),
        html,
        coverMode,
        ...(coverMode === "default" && defaultCover
          ? { coverBase64: defaultCover.base64, coverRatio: defaultCover.ratio }
          : {}),
        ...(coverMode === "ai" && cover
          ? { coverBase64: cover.base64, coverRatio: cover.ratio }
          : {}),
        ...(coverMode === "article" && selectedArticleImage
          ? { coverImageSource: selectedArticleImage.src, coverRatio: ratio }
          : {}),
      });
      setPublished(true);
    } catch (caught) {
      if (
        caught instanceof ApiError &&
        caught.code === "wechat_account_not_bound"
      ) {
        try {
          const result = await getWechatOfficialAccounts();
          setAccounts(result.accounts);
          setError(
            result.accounts.length > 0
              ? t.errors.not_found
              : t.editor.wechatAccountNotBound,
          );
          return;
        } catch (reloadError) {
          setError(
            apiErrorText(
              reloadError,
              t.editor.wechatAccountLoadFailed,
              t.errors,
            ),
          );
          return;
        }
      }
      setError(
        apiErrorText(caught, t.editor.wechatDraftCreateFailed, t.errors),
      );
    } finally {
      setPublishing(false);
      onPublishingChange?.(false);
    }
  }

  const controlsDisabled = disabled || coverGenerating || publishing;
  const titleInvalid =
    title.trim().length === 0 || [...title.trim()].length > 64;
  const coverOptions: Array<{
    value: WechatCoverMode;
    label: string;
    hint: string;
  }> = [
    {
      value: "default",
      label: t.editor.wechatCoverDefault,
      hint: t.editor.wechatCoverDefaultHint,
    },
    {
      value: "article",
      label: t.editor.wechatCoverArticle,
      hint: t.editor.wechatCoverArticleHint,
    },
    {
      value: "ai",
      label: t.editor.wechatCoverAi,
      hint: t.editor.wechatCoverAiHint,
    },
  ];

  if (accountLoading) {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.035] px-4 py-5 text-sm text-neutral-500 dark:text-neutral-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t.editor.wechatAccountLoading}
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-4 text-sm leading-6 text-amber-700 dark:text-amber-300">
        <p role={error ? "alert" : undefined}>
          {error || t.editor.wechatAccountNotBound}
        </p>
        {!error && (
          <Link
            to="/settings"
            search={{ section: "wechat" }}
            className="mt-2 inline-flex font-semibold underline underline-offset-2"
          >
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
          <p className="mt-1 text-[11px] leading-relaxed text-neutral-400">
            {t.editor.wechatDraftPushHint}
          </p>
        </div>
      </div>

      <label className="mt-3 block text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
        {t.editor.wechatTargetAccount}
        <select
          value={selectedAccountId}
          disabled={controlsDisabled}
          onChange={(event) => {
            setSelectedAccountId(event.target.value);
            setPublished(false);
          }}
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
          {coverMode === "ai" && (
            <span className="text-[10px] text-neutral-400">
              {t.editor.wechatCoverCreditCost}
            </span>
          )}
        </div>
        <div
          role="radiogroup"
          aria-label={t.editor.wechatCoverModeLabel}
          className="mt-2 grid grid-cols-3 gap-1.5"
        >
          {coverOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={coverMode === option.value}
              disabled={controlsDisabled}
              onClick={() => {
                setCoverMode(option.value);
                setPublished(false);
              }}
              className={`rounded-lg border px-2.5 py-2 text-left transition disabled:opacity-60 ${
                coverMode === option.value
                  ? "border-emerald-500/60 bg-emerald-500/10"
                  : "border-black/10 hover:bg-black/[0.03] dark:border-white/10 dark:hover:bg-white/5"
              }`}
            >
              <span className="block text-[11px] font-semibold">
                {option.label}
              </span>
              <span className="mt-0.5 block text-[10px] leading-4 text-neutral-400">
                {option.hint}
              </span>
            </button>
          ))}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <span className="text-[11px] text-neutral-400">
            {t.editor.wechatCoverRatio}
          </span>
          <div
            role="radiogroup"
            aria-label={t.editor.wechatCoverRatio}
            className="flex gap-1"
          >
            {["2.35:1", "1:1"].map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={ratio === value}
                disabled={controlsDisabled}
                onClick={() => {
                  setRatio(value as WechatCoverRatio);
                  setCover(null);
                  setPublished(false);
                }}
                className={`rounded-md px-2 py-1 text-[11px] transition ${
                  ratio === value
                    ? "bg-emerald-600 text-white"
                    : "bg-black/5 text-neutral-500 hover:text-neutral-700 dark:bg-white/10 dark:hover:text-neutral-200"
                }`}
              >
                {value}
              </button>
            ))}
          </div>
        </div>

        {coverMode === "default" && (
          <div className="mt-3 overflow-hidden rounded-lg border border-black/10 bg-black/5 dark:border-white/10">
            {defaultCover ? (
              <img
                src={`data:${defaultCover.mimeType};base64,${defaultCover.base64}`}
                alt={t.editor.wechatCoverPreview}
                className="block h-auto w-full"
              />
            ) : (
              <div className="flex h-28 items-center justify-center text-xs font-medium text-neutral-500">
                {defaultCoverGenerating
                  ? t.editor.wechatCoverDefaultPreview
                  : t.editor.wechatCoverDefault}
              </div>
            )}
          </div>
        )}

        {coverMode === "article" && articleImages.length === 0 && (
          <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
            {t.editor.wechatCoverArticleEmpty}
          </p>
        )}

        {coverMode === "article" && articleImages.length > 0 && (
          <div className="mt-3 grid grid-cols-3 gap-1.5">
            {articleImages.map((image, index) => (
              <button
                key={`${image.src}-${index}`}
                type="button"
                aria-pressed={selectedImageSource === image.src}
                disabled={controlsDisabled}
                onClick={() => {
                  setSelectedImageSource(image.src);
                  setPublished(false);
                }}
                className={`overflow-hidden rounded-lg border text-left transition disabled:opacity-60 ${
                  selectedImageSource === image.src
                    ? "border-emerald-500 ring-2 ring-emerald-500/20"
                    : "border-black/10 dark:border-white/10"
                }`}
              >
                <img
                  src={image.src}
                  alt={
                    image.alt || `${t.editor.wechatCoverArticle} ${index + 1}`
                  }
                  className="block w-full object-cover"
                  style={{ aspectRatio: ratio === "1:1" ? "1" : "2.35 / 1" }}
                />
                <span className="block truncate px-1.5 py-1 text-[10px] text-neutral-500">
                  {image.alt || `${t.editor.wechatCoverArticle} ${index + 1}`}
                </span>
              </button>
            ))}
          </div>
        )}

        {coverMode === "ai" && (
          <>
            <textarea
              value={prompt}
              onChange={(event) => {
                setPrompt(event.target.value);
                setPublished(false);
              }}
              disabled={controlsDisabled}
              rows={3}
              maxLength={1200}
              placeholder={t.editor.wechatCoverPromptPlaceholder}
              className="mt-3 w-full resize-y rounded-lg border border-black/10 bg-transparent px-2.5 py-2 text-xs leading-relaxed outline-none transition focus:border-emerald-500/50 disabled:opacity-60 dark:border-white/15"
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                disabled={controlsDisabled || !prompt.trim()}
                onClick={() => void runCoverGeneration()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 px-3 py-1.5 text-xs font-medium text-emerald-700 transition hover:bg-emerald-500/10 disabled:opacity-45 dark:text-emerald-300"
              >
                {coverGenerating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ImagePlus className="h-3.5 w-3.5" />
                )}
                {cover
                  ? t.editor.wechatCoverRegenerate
                  : t.editor.wechatCoverGenerate}
              </button>
            </div>

            {cover && (
              <div className="mt-3 overflow-hidden rounded-lg border border-black/10 bg-black/5 dark:border-white/10">
                <img
                  src={`data:${cover.mimeType};base64,${cover.base64}`}
                  alt={t.editor.wechatCoverPreview}
                  className="block h-auto w-full object-cover"
                />
              </div>
            )}
            {!cover && (
              <p className="mt-2 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                {t.editor.wechatCoverAiRequired}
              </p>
            )}
          </>
        )}

        {titleInvalid && (
          <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
            {t.editor.wechatTitleLimit}
          </p>
        )}
        <button
          type="button"
          disabled={
            controlsDisabled ||
            published ||
            titleInvalid ||
            (coverMode === "default" &&
              (!defaultCover || defaultCoverGenerating)) ||
            (coverMode === "ai" && !cover) ||
            (coverMode === "article" &&
              !articleImages.some((image) => image.src === selectedImageSource))
          }
          onClick={() => void publishDraft()}
          className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-500 disabled:opacity-45"
        >
          {publishing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : published ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          {publishing
            ? t.editor.wechatDraftCreating
            : published
              ? t.editor.wechatDraftCreated
              : t.editor.wechatDraftCreate}
        </button>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-3 text-[11px] leading-relaxed text-red-600 dark:text-red-400"
        >
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
