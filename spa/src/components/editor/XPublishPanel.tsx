import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, ExternalLink, Send } from "lucide-react";
import {
  ApiError,
  fetchAppResource,
  getXAccount,
  prepareWechatDraftDocument,
  publishXArticle,
  uploadImage,
  type XOAuth2Account,
} from "../../api";
import { useI18n } from "../../i18n";
import { isDesktopLocalImageURL } from "../../desktop/offlineImagesCore";
import { buildXArticle, type XArticleImage } from "./xPublish";

export function XPublishPanel({
  docId,
  title,
  markdownBody,
  articleImages,
  disabled,
  localMode,
  onPublishingChange,
}: {
  docId: string;
  title: string;
  markdownBody: string;
  articleImages: XArticleImage[];
  disabled: boolean;
  localMode: boolean;
  onPublishingChange?: (publishing: boolean) => void;
}) {
  const { t } = useI18n();
  const [oauth2, setOauth2] = useState<XOAuth2Account | null>(null);
  const [checking, setChecking] = useState(false);
  const [showBindPrompt, setShowBindPrompt] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publishedURL, setPublishedURL] = useState("");
  const [publishing, setPublishing] = useState(false);
  const checkRef = useRef<Promise<{ oauth2: XOAuth2Account | null }> | null>(null);
  const publishInFlightRef = useRef(false);

  async function ensureAccount(): Promise<boolean> {
    if (oauth2) return true;
    if (checkRef.current) {
      const result = await checkRef.current;
      return Boolean(result.oauth2);
    }
    setChecking(true);
    setError(null);
    setShowBindPrompt(false);
    const promise = getXAccount()
      .then((result) => {
        setOauth2(result.oauth2);
        if (!result.oauth2) setShowBindPrompt(true);
        return { oauth2: result.oauth2 };
      })
      .catch((caught) => {
        setError(apiErrorText(caught, t.editor.xAccountLoadFailed, t.errors));
        return { oauth2: null };
      })
      .finally(() => setChecking(false));
    checkRef.current = promise;
    try {
      const result = await promise;
      return Boolean(result.oauth2);
    } finally {
      if (checkRef.current === promise) checkRef.current = null;
    }
  }

  async function publish() {
    if (disabled || checking || publishing || publishInFlightRef.current || publishedURL) return;
    setError(null);
    publishInFlightRef.current = true;
    setPublishing(true);
    onPublishingChange?.(true);
    try {
      if (!(await ensureAccount())) return;
      if (!window.confirm(t.editor.xPublishConfirm)) return;
      const draft = buildXArticle(title, markdownBody, articleImages);
      if (draft.invalid) {
        setError(t.editor.xArticleInvalid);
        return;
      }
      if (draft.tooLong) {
        setError(t.editor.xArticleTooLong);
        return;
      }
      if (draft.tooManyImages) {
        setError(t.editor.xPublishTooManyImages);
        return;
      }
      await prepareWechatDraftDocument(docId);
      const images: Array<{ source: string; originalSource: string; alt: string }> = [];
      for (const image of draft.images) {
        images.push({
          source: await resolveXImageSource(image.src),
          originalSource: image.src,
          alt: image.alt,
        });
      }
      const result = await publishXArticle(docId, {
        mode: "oauth2",
        title: draft.title,
        markdown: draft.markdown,
        images,
      });
      setPublishedURL(result.url);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "x_oauth2_account_not_bound") {
        setOauth2(null);
        setShowBindPrompt(true);
        setError(t.editor.xOAuth2NotBound);
        return;
      }
      setError(apiErrorText(caught, t.editor.xPublishFailed, t.errors));
    } finally {
      publishInFlightRef.current = false;
      setPublishing(false);
      onPublishingChange?.(false);
    }
  }

  if (localMode) {
    return (
      <section className="mt-4 rounded-xl border border-black/10 bg-black/[0.02] p-3.5 text-xs leading-relaxed text-neutral-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-neutral-400">
        {t.desktopLocalMode.networkDisabled}
      </section>
    );
  }

  return (
    <section className="mt-4 rounded-xl border border-neutral-500/20 bg-neutral-500/[0.035] p-3.5">
      <div className="flex items-start gap-2.5">
        <Send className="mt-0.5 h-4 w-4 shrink-0 text-neutral-700 dark:text-neutral-200" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{t.editor.xPublish}</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-neutral-400">{t.editor.xPublishHint}</p>
        </div>
      </div>
      <div className="mt-3">
        <button type="button" aria-busy={checking || publishing} disabled={disabled || checking || publishing || Boolean(publishedURL)} onClick={() => void publish()} className="inline-flex items-center gap-2 rounded-xl bg-black px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-neutral-800 disabled:cursor-default dark:bg-white dark:text-black dark:hover:bg-neutral-200">
          {checking || publishing ? <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full bg-current" /> : publishedURL ? <CheckCircle2 className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          {checking ? t.editor.xAccountLoading : publishing ? t.editor.xPublishing : publishedURL ? t.editor.xPublished : t.editor.xPublish}
        </button>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-neutral-400">{t.editor.xPublishOAuth2BillingHint}</p>
      {!oauth2 && showBindPrompt && (
        <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
          <p>{t.editor.xOAuth2NotBound}</p>
          <Link to="/settings" search={{ section: "x" }} className="mt-1 inline-flex font-semibold underline underline-offset-2">{t.editor.xOAuth2Bind}</Link>
        </div>
      )}
      {publishedURL && <a href={publishedURL} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold underline underline-offset-2">{publishedURL} <ExternalLink className="h-3 w-3" /></a>}
      {error && <p role="alert" className="mt-3 text-[11px] leading-relaxed text-red-600 dark:text-red-400">{error}</p>}
    </section>
  );
}

async function resolveXImageSource(source: string): Promise<string> {
  if (!isDesktopLocalImageURL(source)) return source;
  const response = await fetchAppResource(source);
  if (!response.ok) {
    throw new ApiError(
      response.status || 422,
      "Image source unavailable",
      "x_image_source_unavailable",
    );
  }
  const blob = await response.blob();
  const file = new File([blob], "x-article-image", { type: blob.type || "image/jpeg" });
  const uploaded = await uploadImage(file, "wechat-export");
  return uploaded.url;
}

function apiErrorText(error: unknown, fallback: string, errors: Record<string, string>): string {
  const code = error instanceof ApiError ? error.code : undefined;
  return (code && errors[code]) || fallback;
}
