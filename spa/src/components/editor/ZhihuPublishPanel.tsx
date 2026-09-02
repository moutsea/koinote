import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, Copy, ExternalLink, Loader2, Send } from "lucide-react";
import {
  ApiError,
  getZhihuAccount,
  publishZhihuArticle,
  type ZhihuAccount,
} from "../../api";
import { openZhihuComposer } from "../../externalNavigation";
import { useI18n } from "../../i18n";
import { copyRichText } from "./exportWechat";

export function ZhihuPublishPanel({
  docId,
  title,
  plainText,
  prepareHTML,
  prepareAssistedHTML,
  disabled,
  onPublishingChange,
}: {
  docId: string;
  title: string;
  plainText: string;
  prepareHTML: () => Promise<string | null>;
  prepareAssistedHTML?: () => Promise<string | null>;
  disabled: boolean;
  onPublishingChange?: (publishing: boolean) => void;
}) {
  const { t } = useI18n();
  const [account, setAccount] = useState<ZhihuAccount | null>(null);
  const [accountChecking, setAccountChecking] = useState(false);
  const [accountCheckError, setAccountCheckError] = useState<string | null>(null);
  const [showBindPrompt, setShowBindPrompt] = useState(false);
  const [publishedURL, setPublishedURL] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [assistedPublishing, setAssistedPublishing] = useState(false);
  const [assistedDone, setAssistedDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accountCheckPromiseRef = useRef<Promise<ZhihuAccount | null> | null>(
    null,
  );

  async function ensureAccount(): Promise<ZhihuAccount | null> {
    if (account) return account;
    if (accountCheckPromiseRef.current) return accountCheckPromiseRef.current;

    setAccountChecking(true);
    setAccountCheckError(null);
    setShowBindPrompt(false);
    const checkPromise = (async () => {
      try {
        const result = await getZhihuAccount();
        setAccount(result.account);
        if (!result.account) setShowBindPrompt(true);
        return result.account;
      } catch (caught) {
        setAccountCheckError(
          apiErrorText(caught, t.editor.zhihuAccountLoadFailed, t.errors),
        );
        return null;
      } finally {
        setAccountChecking(false);
      }
    })();
    accountCheckPromiseRef.current = checkPromise;
    try {
      return await checkPromise;
    } finally {
      if (accountCheckPromiseRef.current === checkPromise) {
        accountCheckPromiseRef.current = null;
      }
    }
  }

  async function publish() {
    if (
      accountChecking ||
      publishing ||
      assistedPublishing ||
      publishedURL ||
      disabled ||
      !title.trim()
    ) return;
    setError(null);
    onPublishingChange?.(true);
    try {
      const connectedAccount = await ensureAccount();
      if (!connectedAccount) return;
      if (!window.confirm(t.editor.zhihuPublishConfirm)) return;
      setPublishing(true);
      setPublishedURL("");
      const html = await prepareHTML();
      if (!html) return;
      const result = await publishZhihuArticle(docId, {
        title: title.trim(),
        html,
      });
      setPublishedURL(result.url);
    } catch (caught) {
      setError(apiErrorText(caught, t.editor.zhihuPublishFailed, t.errors));
    } finally {
      setPublishing(false);
      onPublishingChange?.(false);
    }
  }

  async function assistPublish() {
    if (assistedPublishing || publishing || accountChecking || disabled) return;
    setAssistedPublishing(true);
    onPublishingChange?.(true);
    setAssistedDone(false);
    setAccountCheckError(null);
    setError(null);
    try {
      const html = await (prepareAssistedHTML ?? prepareHTML)();
      if (!html) return;
      await copyRichText(html, plainText);
      await openZhihuComposer();
      setAssistedDone(true);
    } catch (caught) {
      setError(apiErrorText(caught, t.editor.zhihuAssistFailed, t.errors));
    } finally {
      setAssistedPublishing(false);
      onPublishingChange?.(false);
    }
  }

  const directBusy = accountChecking || publishing;
  return (
    <section className="mt-4 rounded-xl border border-sky-500/20 bg-sky-500/[0.035] p-3.5">
      <div className="flex items-start gap-2.5">
        <Send className="mt-0.5 h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{t.editor.zhihuPublish}</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-neutral-400">
            {t.editor.zhihuPublishHint}
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={
            disabled ||
            directBusy ||
            assistedPublishing ||
            Boolean(publishedURL) ||
            !title.trim()
          }
          onClick={() => void publish()}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-500 disabled:opacity-45"
        >
          {directBusy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : publishedURL ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          {accountChecking
            ? t.editor.zhihuAccountLoading
            : publishing
              ? t.editor.zhihuPublishing
              : publishedURL
                ? t.editor.zhihuPublished
                : t.editor.zhihuPublish}
        </button>
        <button
          type="button"
          disabled={disabled || publishing || accountChecking || assistedPublishing}
          onClick={() => void assistPublish()}
          className="inline-flex items-center gap-1.5 rounded-xl border border-sky-500/35 px-3.5 py-2.5 text-sm font-semibold text-sky-700 transition hover:bg-sky-500/10 disabled:opacity-50 dark:border-sky-400/35 dark:text-sky-300 dark:hover:bg-sky-400/10"
        >
          {assistedPublishing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : assistedDone ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
          {assistedPublishing
            ? t.editor.zhihuAssistPublishing
            : assistedDone
              ? t.editor.zhihuAssistDone
              : t.editor.zhihuAssistPublish}
        </button>
      </div>
      {showBindPrompt && (
        <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
          <p>{t.editor.zhihuAccountNotBound}</p>
          <Link
            to="/settings"
            search={{ section: "zhihu" }}
            className="mt-1 inline-flex font-semibold underline underline-offset-2"
          >
            {t.editor.zhihuAccountBind}
          </Link>
        </div>
      )}
      {accountCheckError && (
        <p role="alert" className="mt-3 text-[11px] leading-relaxed text-red-600 dark:text-red-400">
          {accountCheckError}
        </p>
      )}
      {publishedURL && (
        <a
          href={publishedURL}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-sky-700 underline underline-offset-2 dark:text-sky-300"
        >
          {publishedURL} <ExternalLink className="h-3 w-3" />
        </a>
      )}
      {error && (
        <p role="alert" className="mt-3 text-[11px] leading-relaxed text-red-600 dark:text-red-400">
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
