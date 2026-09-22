import { useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, Copy, Loader2, Send, X } from "lucide-react";
import { useI18n } from "../../i18n";
import {
  exportToMedia,
  mediaExportFormat,
  type MediaPlatform,
} from "./exportMedia";
import { buildMediaMarkdown } from "./mediaExportStrategy";
import { getWechatThemeLabel } from "./wechatThemes";
import { isLocalModeNetworkDisabled } from "../../desktop/localMode";
import { pushModal } from "../../modalStack";
import { WECHAT_GEO_MAX_CHARS, wechatGeoSourceHash } from "./wechatGeo";
import {
  AGENT_CREDITS_QUERY_KEY,
  ApiError,
  generateWechatGeoSummary,
  getWechatGeoSummary,
  publishCustomMediaPlatform,
  trackProductEvent,
  type CustomMediaPlatform,
  updateWechatGeoSummary,
  type WechatOfficialAccount,
} from "../../api";
import { buildWechatHTML } from "./exportWechat";
import { WechatDraftPanel } from "./WechatDraftPanel";
import { ZhihuPublishPanel } from "./ZhihuPublishPanel";
import { XPublishPanel } from "./XPublishPanel";
import { WechatPreflightPanel } from "./WechatPreflightPanel";
import { parseArticleMetadata } from "./wechatPreflight";
import { isDesktopLocalImageURL } from "../../desktop/offlineImagesCore";

/**
 * 导出到自媒体平台。
 *
 * 微信与知乎使用内联样式富文本；X 使用服务端文章发布以保留图片；自定义平台使用统一 API 合约。
 * 不带主题选择也不带预览：主题是文档属性，在编辑区已经生效了。
 */
export function MediaExportDialog({
  editor,
  docId,
  title,
  coverImageSource,
  themeId,
  member,
  localMode,
  draftOnly = false,
  wechatAccounts,
  onOpenWechatDraft,
  wechatDraftOpening = false,
  enabledPlatforms,
  customPlatforms = [],
  onBeforeExternalExport,
  onClose,
}: {
  editor: Editor;
  docId: string;
  title: string;
  coverImageSource?: string;
  themeId: string;
  member: boolean;
  localMode: boolean;
  draftOnly?: boolean;
  wechatAccounts?: WechatOfficialAccount[];
  onOpenWechatDraft?: () => Promise<string | undefined>;
  wechatDraftOpening?: boolean;
  enabledPlatforms?: MediaPlatform[];
  customPlatforms?: CustomMediaPlatform[];
  onBeforeExternalExport: () => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const currentMarkdown = editor.storage.markdown.getMarkdown() as string;
  const articleImages = useMemo(
    () => extractWechatArticleImages(editor),
    [editor, currentMarkdown],
  );
  const exportMetadata = parseArticleMetadata(currentMarkdown, title).metadata;
  const exportTitle = exportMetadata.title || title;
  const exportPlainText = buildMediaMarkdown(
    exportTitle,
    parseArticleMetadata(currentMarkdown, title).body,
  );
  const [platform, setPlatform] = useState<MediaPlatform>("wechat");
  const [customPlatformId, setCustomPlatformId] = useState<string | null>(null);
  const [bytes, setBytes] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [geoEnabled, setGeoEnabled] = useState(false);
  const [geoText, setGeoText] = useState("");
  const [geoLoading, setGeoLoading] = useState(false);
  const [geoGenerating, setGeoGenerating] = useState(false);
  const [geoTextSaving, setGeoTextSaving] = useState(false);
  const [geoPreferenceSaving, setGeoPreferenceSaving] = useState(false);
  const [geoClosing, setGeoClosing] = useState(false);
  const [draftOpening, setDraftOpening] = useState(false);
  const [draftPublishing, setDraftPublishing] = useState(false);
  const [geoDirty, setGeoDirty] = useState(false);
  const [geoStale, setGeoStale] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [wechatUpgradePromptOpen, setWechatUpgradePromptOpen] = useState(false);
  // 与 note 分开：图片抓不到和公式降级可能同时发生，共用一个槽会互相顶掉，
  // 而被顶掉的恰好是更严重的那条
  const [imageWarning, setImageWarning] = useState<string | null>(null);
  const selectedCustomPlatform = customPlatforms.find((item) => item.platformId === customPlatformId) ?? null;
  const availablePlatforms = useMemo(
    () => enabledPlatforms ?? (["wechat", "zhihu", "x"] as MediaPlatform[]),
    [enabledPlatforms],
  );
  const isCustomPlatform = selectedCustomPlatform !== null;
  const builtInPlatformOptions = useMemo(
    () =>
      ([
        ["wechat", t.editor.mediaWechat, t.editor.mediaWechatHint],
        ["zhihu", t.editor.mediaZhihu, t.editor.mediaZhihuHint],
        ["x", t.editor.mediaX, t.editor.mediaXHint],
      ] as const).filter(([value]) => availablePlatforms.includes(value)),
    [availablePlatforms, t.editor.mediaWechat, t.editor.mediaWechatHint, t.editor.mediaZhihu, t.editor.mediaZhihuHint, t.editor.mediaX, t.editor.mediaXHint],
  );

  useEffect(() => {
    if (draftOnly) {
      setPlatform("wechat");
      setCustomPlatformId(null);
      return;
    }
    if (customPlatformId && selectedCustomPlatform) return;
    if (availablePlatforms.includes(platform)) {
      setCustomPlatformId(null);
      return;
    }
    if (availablePlatforms[0]) {
      setPlatform(availablePlatforms[0]);
      setCustomPlatformId(null);
      return;
    }
    if (customPlatforms[0]) {
      setCustomPlatformId(customPlatforms[0].platformId);
    }
  }, [availablePlatforms, customPlatformId, customPlatforms, draftOnly, platform, selectedCustomPlatform]);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const geoTouchedRef = useRef(false);
  const geoSavePromiseRef = useRef<Promise<boolean> | null>(null);
  const geoPreferenceQueueRef = useRef<Promise<void>>(Promise.resolve());
  const geoPreferenceVersionRef = useRef(0);
  const geoPersistedEnabledRef = useRef(false);
  const geoGenerateAbortRef = useRef<AbortController | null>(null);
  const wechatUpgradePromptOpenRef = useRef(false);
  const closeSaveFailedRef = useRef(false);
  const closeInFlightRef = useRef(false);
  const closeDialogRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const releaseModal = pushModal();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (wechatUpgradePromptOpenRef.current) {
          setWechatUpgradePromptOpen(false);
          return;
        }
        closeDialogRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      geoGenerateAbortRef.current?.abort();
      releaseModal();
    };
  }, []);

  useEffect(() => {
    wechatUpgradePromptOpenRef.current = wechatUpgradePromptOpen;
  }, [wechatUpgradePromptOpen]);

  useEffect(() => {
    if (!member || localMode) return;
    let cancelled = false;
    setGeoLoading(true);
    setGeoError(null);
    const markdown = editor.storage.markdown.getMarkdown() as string;
    void Promise.all([
      getWechatGeoSummary(docId),
      wechatGeoSourceHash(title, markdown),
    ])
      .then(([result, sourceHash]) => {
        if (cancelled || geoTouchedRef.current || !result.geo) return;
        setGeoText(result.geo.text);
        setGeoEnabled(result.geo.enabled);
        geoPersistedEnabledRef.current = result.geo.enabled;
        closeSaveFailedRef.current = false;
        setGeoStale(result.geo.sourceHash !== sourceHash);
        setGeoDirty(false);
      })
      .catch((caught) => {
        if (cancelled || geoTouchedRef.current) return;
        const code = caught instanceof ApiError ? caught.code : undefined;
        setGeoError((code && t.errors[code]) || t.editor.wechatGeoLoadFailed);
      })
      .finally(() => {
        if (!cancelled) setGeoLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    docId,
    editor,
    localMode,
    member,
    t.editor.wechatGeoLoadFailed,
    t.errors,
    title,
  ]);

  async function persistGeoText(): Promise<boolean> {
    if (geoSavePromiseRef.current) return geoSavePromiseRef.current;
    if (!geoDirty || !geoText.trim()) return true;
    const savePromise = (async () => {
      setGeoError(null);
      setGeoTextSaving(true);
      try {
        const result = await updateWechatGeoSummary(docId, { text: geoText });
        setGeoText(result.geo.text);
        setGeoDirty(false);
        closeSaveFailedRef.current = false;
        return true;
      } catch (caught) {
        const code = caught instanceof ApiError ? caught.code : undefined;
        setGeoError((code && t.errors[code]) || t.editor.wechatGeoSaveFailed);
        return false;
      } finally {
        setGeoTextSaving(false);
      }
    })();
    geoSavePromiseRef.current = savePromise;
    try {
      return await savePromise;
    } finally {
      if (geoSavePromiseRef.current === savePromise) {
        geoSavePromiseRef.current = null;
      }
    }
  }

  async function persistGeoEnabled(next: boolean) {
    if (!geoText.trim()) return;
    const version = ++geoPreferenceVersionRef.current;
    const textSavePromise = geoSavePromiseRef.current;
    const previousPreferenceSave = geoPreferenceQueueRef.current;
    setGeoPreferenceSaving(true);
    const preferenceSave = previousPreferenceSave
      .catch(() => undefined)
      .then(async () => {
        if (textSavePromise && !(await textSavePromise)) {
          if (version === geoPreferenceVersionRef.current) {
            setGeoEnabled(geoPersistedEnabledRef.current);
          }
          return;
        }
        setGeoError(null);
        try {
          const result = await updateWechatGeoSummary(docId, { enabled: next });
          geoPersistedEnabledRef.current = result.geo.enabled;
          if (version === geoPreferenceVersionRef.current) {
            setGeoEnabled(result.geo.enabled);
          }
        } catch (caught) {
          if (version === geoPreferenceVersionRef.current) {
            setGeoEnabled(geoPersistedEnabledRef.current);
          }
          const code = caught instanceof ApiError ? caught.code : undefined;
          setGeoError((code && t.errors[code]) || t.editor.wechatGeoSaveFailed);
        }
      });
    geoPreferenceQueueRef.current = preferenceSave;
    try {
      await preferenceSave;
    } finally {
      if (version === geoPreferenceVersionRef.current) {
        setGeoPreferenceSaving(false);
      }
    }
  }

  async function run() {
    if (isCustomPlatform) return;
    setError(null);
    setNote(null);
    setImageWarning(null);
    setDone(false);
    setBusy(true);
    try {
      if (
        platform === "wechat" &&
        member &&
        !localMode &&
        geoEnabled &&
        !(await persistGeoText())
      ) {
        return;
      }
      const result = await exportToMedia(platform, editor, title, themeId, {
        includeWechatGeoCorpus: member && !localMode && geoEnabled,
        wechatGeoText: geoText,
      });
      void trackProductEvent("first_export").catch(() => undefined);
      setDone(true);
      setBytes(result?.bytes ?? null);

      if (!result) return;

      // 图片抓不到是比公式更严重的问题：粘贴不报错，要等文章预览才看到裂图。
      // 所以它单独占一条警告，不跟公式那条抢同一个位置
      if (result.images.unreachable > 0) {
        setImageWarning(
          t.editor.mediaImagesUnreachable
            .replace("{n}", String(result.images.unreachable))
            .replace("{hosts}", result.images.unreachableHosts.join("、")),
        );
      }

      // 公式失败要说出来。静默降级成 LaTeX 源码，用户会以为公式本来就长那样
      if (result.math.temporaryQuotaFailed > 0) {
        const quotaNote = t.editor.wechatMathTemporaryQuotaExceeded.replace(
          "{n}",
          String(result.math.temporaryQuotaFailed),
        );
        const otherFailures =
          result.math.failed - result.math.temporaryQuotaFailed;
        setNote(
          otherFailures > 0
            ? `${quotaNote} ${t.editor.wechatMathFailed.replace(
                "{n}",
                String(otherFailures),
              )}`
            : quotaNote,
        );
      } else if (result.math.failed > 0) {
        setNote(
          t.editor.wechatMathFailed.replace("{n}", String(result.math.failed)),
        );
      } else if (result.math.converted > 0) {
        setNote(
          t.editor.wechatMathConverted.replace(
            "{n}",
            String(result.math.converted),
          ),
        );
      }
      if (result.layout.diagnostics.length > 0) {
        setNote((current) =>
          current
            ? `${current} ${t.editor.wechatPreflight.checkModule}`
            : t.editor.wechatPreflight.checkModule,
        );
      }
    } catch (error) {
      setError(
        isLocalModeNetworkDisabled(error)
          ? t.desktopLocalMode.networkDisabled
          : t.editor.exportFailed,
      );
    } finally {
      setBusy(false);
    }
  }

  async function runCustomPlatform() {
    if (!selectedCustomPlatform) return;
    setError(null);
    setNote(null);
    setImageWarning(null);
    setDone(false);
    setBusy(true);
    try {
      if (!(await onBeforeExternalExport())) {
        setError(t.editor.saveFailed);
        return;
      }
      const html = await prepareZhihuHTML(true, true);
      if (!html) return;
      const result = await publishCustomMediaPlatform(docId, selectedCustomPlatform.platformId, {
        title: exportTitle,
        markdown: exportPlainText,
        html,
        ...(coverImageSource?.trim() ? { coverImageSource: coverImageSource.trim() } : {}),
      });
      void trackProductEvent("first_export").catch(() => undefined);
      setDone(true);
      setNote(result.url ? `${t.editor.mediaPublished}: ${result.url}` : t.editor.mediaPublished);
    } catch (caught) {
      const code = caught instanceof ApiError ? caught.code : undefined;
      setError(
        isLocalModeNetworkDisabled(caught)
          ? t.desktopLocalMode.networkDisabled
          : (code && t.errors[code]) || t.editor.mediaPublishFailed,
      );
    } finally {
      setBusy(false);
    }
  }

  async function generateGeoSummary() {
    if (geoGenerateAbortRef.current) return;
    geoTouchedRef.current = true;
    setGeoError(null);
    setGeoGenerating(true);
    const controller = new AbortController();
    geoGenerateAbortRef.current = controller;
    try {
      if (!(await persistGeoText())) return;
      const markdown = editor.storage.markdown.getMarkdown() as string;
      const result = await generateWechatGeoSummary(
        docId,
        title,
        markdown,
        controller.signal,
      );
      setGeoText(result.geo.text);
      setGeoEnabled(result.geo.enabled);
      geoPersistedEnabledRef.current = result.geo.enabled;
      setGeoDirty(false);
      closeSaveFailedRef.current = false;
      setGeoStale(false);
      setDone(false);
      setBytes(null);
      if (result.geo.creditsCharged > 0) {
        void queryClient.invalidateQueries({
          queryKey: AGENT_CREDITS_QUERY_KEY,
        });
      }
    } catch (caught) {
      if (controller.signal.aborted) return;
      const code = caught instanceof ApiError ? caught.code : undefined;
      setGeoError((code && t.errors[code]) || t.editor.wechatGeoGenerateFailed);
    } finally {
      if (geoGenerateAbortRef.current === controller) {
        geoGenerateAbortRef.current = null;
      }
      setGeoGenerating(false);
    }
  }

  async function prepareWechatDraftHTML(): Promise<string | null> {
    setError(null);
    setNote(null);
    setImageWarning(null);
    if (member && !localMode && geoEnabled && !(await persistGeoText())) {
      return null;
    }
    try {
      const result = await buildWechatHTML(editor, title, themeId, {
        includeGeoCorpus: member && !localMode && geoEnabled,
        geoText,
        includeTitle: false,
      });
      if (result.math.temporaryQuotaFailed > 0) {
        setNote(
          t.editor.wechatMathTemporaryQuotaExceeded.replace(
            "{n}",
            String(result.math.temporaryQuotaFailed),
          ),
        );
      } else if (result.math.failed > 0) {
        setNote(
          t.editor.wechatMathFailed.replace("{n}", String(result.math.failed)),
        );
      }
      if (result.layout.diagnostics.length > 0) {
        setNote((current) =>
          current
            ? `${current} ${t.editor.wechatPreflight.checkModule}`
            : t.editor.wechatPreflight.checkModule,
        );
      }
      return result.html;
    } catch (caught) {
      setError(
        isLocalModeNetworkDisabled(caught)
          ? t.desktopLocalMode.networkDisabled
          : t.editor.exportFailed,
      );
      return null;
    }
  }

  async function openWechatDraftDialog() {
    if (
      !onOpenWechatDraft ||
      geoClosing ||
      draftOpening ||
      closeInFlightRef.current
    )
      return;
    if (!member) {
      setWechatUpgradePromptOpen(true);
      return;
    }
    closeInFlightRef.current = true;
    setDraftOpening(true);
    try {
      if (member && !localMode && !(await persistGeoText())) return;
      await geoPreferenceQueueRef.current;
      const draftError = await onOpenWechatDraft();
      if (draftError) setError(draftError);
    } finally {
      closeInFlightRef.current = false;
      setDraftOpening(false);
    }
  }

  async function prepareZhihuHTML(
    allowImages = false,
    includeTitle = false,
  ): Promise<string | null> {
    setError(null);
    setNote(null);
    setImageWarning(null);
    try {
      const result = await buildWechatHTML(editor, title, themeId, {
        includeGeoCorpus: false,
        includeTitle,
      });
      if (!allowImages && result.images.total > 0) {
        setError(t.editor.zhihuImagesUnsupported);
        return null;
      }
      if (result.math.temporaryQuotaFailed > 0) {
        setNote(
          t.editor.wechatMathTemporaryQuotaExceeded.replace(
            "{n}",
            String(result.math.temporaryQuotaFailed),
          ),
        );
      } else if (result.math.failed > 0) {
        setNote(
          t.editor.wechatMathFailed.replace("{n}", String(result.math.failed)),
        );
      }
      if (result.images.unreachable > 0) {
        setImageWarning(
          t.editor.mediaImagesUnreachable
            .replace("{n}", String(result.images.unreachable))
            .replace("{hosts}", result.images.unreachableHosts.join("、")),
        );
      }
      return result.html;
    } catch (caught) {
      setError(
        isLocalModeNetworkDisabled(caught)
          ? t.desktopLocalMode.networkDisabled
          : t.editor.exportFailed,
      );
      return null;
    }
  }

  // 刻意不拦 busy：复制路径（buildWechatHTML → uploadImage）没有超时也没有
  // AbortSignal，网络挂起时 busy 会一直是 true，拦住关闭就等于把用户锁在弹窗里。
  // 代价是复制中途关窗会丢掉图片与公式警告 —— 比关不掉弹窗轻
  async function closeDialog() {
    if (draftPublishing || draftOpening || closeInFlightRef.current) return;
    closeInFlightRef.current = true;
    setGeoClosing(true);
    geoGenerateAbortRef.current?.abort();
    try {
      if (!closeSaveFailedRef.current && !(await persistGeoText())) {
        closeSaveFailedRef.current = true;
        return;
      }
      await geoPreferenceQueueRef.current;
    } finally {
      closeInFlightRef.current = false;
      setGeoClosing(false);
    }
    onClose();
  }

  useEffect(() => {
    closeDialogRef.current = () => {
      void closeDialog();
    };
  });

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) void closeDialog();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={draftOnly ? t.editor.wechatDraftPush : t.editor.mediaTitle}
        tabIndex={-1}
        className="max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-black/10 bg-[var(--background)] p-5 shadow-2xl outline-none dark:border-white/15"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">
              {draftOnly ? t.editor.wechatDraftPush : t.editor.mediaTitle}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-neutral-400">
              {draftOnly
                ? t.editor.wechatDraftPushHint
                : t.editor.mediaSubtitle}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void closeDialog()}
            disabled={
              geoClosing ||
              draftOpening ||
              wechatDraftOpening ||
              draftPublishing
            }
            aria-label={t.editor.shareClose}
            className="shrink-0 rounded-lg p-1.5 text-neutral-400 transition hover:bg-black/5 disabled:opacity-60 dark:hover:bg-white/10"
          >
            {geoClosing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <X className="h-4 w-4" />
            )}
          </button>
        </div>

        {!draftOnly && (builtInPlatformOptions.length > 0 || customPlatforms.length > 0) && (
          <div
            className="mt-4 grid grid-cols-3 gap-2"
            role="radiogroup"
            aria-label={t.editor.mediaPlatformLabel}
          >
            {builtInPlatformOptions.map(([value, label, hint]) => {
              const selected = !isCustomPlatform && platform === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => {
                    setPlatform(value);
                    setCustomPlatformId(null);
                    setDone(false);
                    setBytes(null);
                    setError(null);
                    setNote(null);
                    setImageWarning(null);
                  }}
                  className="min-w-0 break-words rounded-xl border px-2 py-3 text-left transition hover:bg-black/[0.03] sm:px-3 dark:hover:bg-white/5"
                  style={{
                    borderColor: selected
                      ? "var(--ink-strong)"
                      : "var(--ink-line)",
                    background: selected ? "var(--ink-wash)" : "transparent",
                  }}
                >
                  <span
                    className="block text-sm font-semibold"
                    style={{ color: "var(--ink-strong)" }}
                  >
                    {label}
                  </span>
                  <span
                    className="mt-1 block text-[11px] leading-4"
                    style={{ color: "var(--ink-faint)" }}
                  >
                    {hint}
                  </span>
                </button>
              );
            })}
            {customPlatforms.map((item) => {
              const selected = selectedCustomPlatform?.platformId === item.platformId;
              return (
                <button
                  key={item.platformId}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => {
                    setCustomPlatformId(item.platformId);
                    setDone(false);
                    setBytes(null);
                    setError(null);
                    setNote(null);
                    setImageWarning(null);
                  }}
                  className="min-w-0 break-words rounded-xl border px-2 py-3 text-left transition hover:bg-black/[0.03] sm:px-3 dark:hover:bg-white/5"
                  style={{
                    borderColor: selected ? "var(--ink-strong)" : "var(--ink-line)",
                    background: selected ? "var(--ink-wash)" : "transparent",
                  }}
                >
                  <span className="block text-sm font-semibold" style={{ color: "var(--ink-strong)" }}>
                    {item.name}
                  </span>
                  <span className="mt-1 block text-[11px] leading-4" style={{ color: "var(--ink-faint)" }}>
                    {t.editor.mediaCustomHint}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* 当前用的是哪套主题。改主题要回编辑区改 —— 那里改完立刻能看见效果，
            在这个弹窗里改反而看不见 */}
        {!isCustomPlatform && mediaExportFormat(platform) === "rich-text" && (
          <p className="mt-4 rounded-lg bg-black/[0.03] px-3 py-2 text-xs text-neutral-500 dark:bg-white/5 dark:text-neutral-400">
            {t.editor.wechatThemeLabel}
            <span className="mx-1.5 text-neutral-300 dark:text-neutral-600">
              ·
            </span>
            <span className="font-medium text-neutral-700 dark:text-neutral-200">
              {themeId
                ? getWechatThemeLabel(themeId, t.editor.wechatThemeNames)
                : t.editor.themeNone}
            </span>
          </p>
        )}

        {!isCustomPlatform && platform === "wechat" && (
          <WechatPreflightPanel
            markdown={currentMarkdown}
            title={exportTitle}
          />
        )}

        {!draftOnly && !isCustomPlatform && platform === "zhihu" && !localMode && (
          <ZhihuPublishPanel
            docId={docId}
            title={exportTitle}
            plainText={exportPlainText}
            prepareHTML={() => prepareZhihuHTML(false)}
            prepareAssistedHTML={() => prepareZhihuHTML(true, true)}
            disabled={busy || geoLoading || geoGenerating || draftPublishing}
            onPublishingChange={setDraftPublishing}
          />
        )}

        {!draftOnly && !isCustomPlatform && platform === "x" && (
          <XPublishPanel
            docId={docId}
            title={exportTitle}
            coverImageSource={coverImageSource}
            markdownBody={parseArticleMetadata(currentMarkdown, title).body}
            description={exportMetadata.digest}
            articleImages={articleImages}
            localMode={localMode}
            disabled={busy || geoLoading || geoGenerating || draftPublishing}
            onPublishingChange={setDraftPublishing}
          />
        )}

        {!isCustomPlatform && platform === "wechat" && member && !localMode && (
          <div className="mt-3 rounded-xl border border-black/10 px-3 py-3 dark:border-white/10">
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={geoEnabled}
                disabled={busy || geoLoading || geoGenerating}
                onChange={(event) => {
                  geoTouchedRef.current = true;
                  const next = event.target.checked;
                  setGeoEnabled(next);
                  void persistGeoEnabled(next);
                  setDone(false);
                  setBytes(null);
                  setGeoError(null);
                }}
                className="mt-0.5 h-4 w-4 accent-neutral-900 dark:accent-white"
              />
              <span>
                <span className="block text-xs font-medium text-neutral-700 dark:text-neutral-200">
                  {t.editor.wechatGeoExperiment}
                </span>
                <span className="mt-1 block text-[11px] leading-relaxed text-neutral-400">
                  {t.editor.wechatGeoExperimentHint}
                </span>
              </span>
            </label>
            {geoLoading && (
              <p className="mt-3 flex items-center gap-1.5 text-[11px] text-neutral-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t.editor.wechatGeoLoading}
              </p>
            )}
            {geoEnabled && (
              <div className="mt-3">
                <button
                  type="button"
                  disabled={busy || geoLoading || geoGenerating}
                  onClick={() => void generateGeoSummary()}
                  className="inline-flex items-center gap-1.5 rounded-full border border-black/10 px-3 py-1.5 text-xs font-medium text-neutral-600 transition hover:bg-black/[0.03] disabled:opacity-60 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5"
                >
                  {geoGenerating && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  )}
                  {geoTextSaving || geoPreferenceSaving
                    ? t.editor.wechatGeoSaving
                    : geoGenerating
                      ? t.editor.wechatGeoGenerating
                      : geoText
                        ? t.editor.wechatGeoRegenerate
                        : t.editor.wechatGeoGenerate}
                </button>
                {geoText && (
                  <textarea
                    value={geoText}
                    maxLength={WECHAT_GEO_MAX_CHARS}
                    rows={4}
                    disabled={busy || geoGenerating || geoTextSaving}
                    onChange={(event) => {
                      geoTouchedRef.current = true;
                      closeSaveFailedRef.current = false;
                      setGeoText(event.target.value);
                      setGeoDirty(true);
                      setDone(false);
                      setBytes(null);
                    }}
                    onBlur={() => void persistGeoText()}
                    aria-label={t.editor.wechatGeoPlaceholder}
                    placeholder={t.editor.wechatGeoPlaceholder}
                    className="mt-3 w-full resize-y rounded-lg border border-black/10 bg-transparent px-3 py-2 text-xs leading-relaxed text-neutral-700 outline-none transition placeholder:text-neutral-300 focus:border-neutral-400 disabled:opacity-60 dark:border-white/10 dark:text-neutral-200 dark:placeholder:text-neutral-600 dark:focus:border-neutral-500"
                  />
                )}
                {geoStale && (
                  <p className="mt-2 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                    {t.editor.wechatGeoStale}
                  </p>
                )}
              </div>
            )}
            {geoError && (
              <p
                role="alert"
                className="mt-2 text-[11px] leading-relaxed text-red-500"
              >
                {geoError}
              </p>
            )}
          </div>
        )}

        {draftOnly &&
          platform === "wechat" &&
          !localMode &&
          member && (
            <WechatDraftPanel
              key={docId}
              accounts={wechatAccounts}
              docId={docId}
              title={exportTitle}
              author={exportMetadata.author}
              digest={exportMetadata.digest}
              member={member}
              disabled={
                busy ||
                geoClosing ||
                geoLoading ||
                geoGenerating ||
                geoTextSaving ||
                geoPreferenceSaving ||
                [...exportMetadata.author].length > 16 ||
                [...exportMetadata.digest].length > 128
              }
              articleImages={articleImages}
              prepareHTML={prepareWechatDraftHTML}
              onPublishingChange={setDraftPublishing}
            />
          )}

        {draftOnly &&
          platform === "wechat" &&
          !localMode &&
          !member && (
            <p className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
              {t.editor.wechatOfficialMembersOnly}
            </p>
          )}

        {/* 排在公式提示之前：这条更严重（图会裂），先看到它 */}
        {imageWarning && (
          <p
            role="alert"
            className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:bg-amber-950/40 dark:text-amber-400"
          >
            {imageWarning}
          </p>
        )}

        {note && (
          <p
            role="status"
            className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:bg-amber-950/40 dark:text-amber-400"
          >
            {note}
          </p>
        )}

        {error && (
          <p
            role="alert"
            className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400"
          >
            {error}
          </p>
        )}

        {wechatUpgradePromptOpen && !member && (
          <div
            role="presentation"
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                setWechatUpgradePromptOpen(false);
              }
            }}
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4"
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="wechat-upgrade-prompt-title"
              className="w-full max-w-sm rounded-2xl border border-black/10 bg-[var(--background)] p-5 shadow-2xl dark:border-white/15"
            >
              <div className="flex items-start justify-between gap-3">
                <h3
                  id="wechat-upgrade-prompt-title"
                  className="text-base font-semibold"
                >
                  {t.editor.wechatDraftPush}
                </h3>
                <button
                  type="button"
                  onClick={() => setWechatUpgradePromptOpen(false)}
                  aria-label={t.editor.shareClose}
                  className="shrink-0 rounded-lg p-1.5 text-neutral-400 transition hover:bg-black/5 dark:hover:bg-white/10"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="mt-3 text-sm leading-6 text-neutral-600 dark:text-neutral-300">
                {t.editor.wechatOfficialMembersOnly}
              </p>
              <Link
                to="/pricing"
                onClick={() => setWechatUpgradePromptOpen(false)}
                className="mt-4 inline-flex rounded-full bg-[var(--cinnabar)] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
              >
                {t.settingsPage.upgrade}
              </Link>
            </div>
          </div>
        )}

        {isCustomPlatform ? (
          <p className="mt-4 text-[11px] leading-relaxed text-neutral-400">
            {t.editor.mediaCustomHint}
          </p>
        ) : platform !== "x" && (
          <p className="mt-4 text-[11px] leading-relaxed text-neutral-400">
            {mediaExportFormat(platform) === "markdown"
              ? t.editor.mediaMarkdownNote
              : t.editor.mediaRichTextNote}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {!draftOnly && !isCustomPlatform && platform !== "zhihu" && platform !== "x" && (
            <button
              type="button"
              onClick={run}
              disabled={
                busy ||
                geoLoading ||
                geoGenerating ||
                draftOpening ||
                wechatDraftOpening ||
                (platform === "wechat" &&
                  member &&
                  !localMode &&
                  geoEnabled &&
                  !geoText.trim())
              }
              className="flex items-center gap-1.5 rounded-full px-5 py-2 text-sm font-semibold transition hover:opacity-85 disabled:opacity-60"
              style={{
                background: "var(--ink-strong)",
                color: "var(--ink-paper)",
              }}
            >
              {busy ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t.editor.mediaWorking}
                </>
              ) : done ? (
                <>
                  <Check className="h-3.5 w-3.5" />
                  {t.editor.mediaCopied}
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  {t.editor.mediaCopy}
                </>
              )}
            </button>
          )}
          {!draftOnly && isCustomPlatform && (
            <button
              type="button"
              onClick={() => void runCustomPlatform()}
              disabled={busy || draftOpening || wechatDraftOpening}
              className="flex items-center gap-1.5 rounded-full px-5 py-2 text-sm font-semibold transition hover:opacity-85 disabled:opacity-60"
              style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : done ? <Check className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
              {busy ? t.editor.mediaWorking : done ? t.editor.mediaPublished : t.editor.mediaCustomSync}
            </button>
          )}
          {!draftOnly &&
            platform === "wechat" &&
            !localMode &&
            onOpenWechatDraft && (
              <button
                type="button"
                onClick={() => void openWechatDraftDialog()}
                disabled={
                  busy ||
                  geoLoading ||
                  geoGenerating ||
                  geoClosing ||
                  draftOpening ||
                  wechatDraftOpening
                }
                className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/35 px-4 py-2 text-sm font-medium text-emerald-700 transition hover:bg-emerald-500/10 disabled:opacity-60 dark:border-emerald-400/35 dark:text-emerald-300 dark:hover:bg-emerald-400/10"
              >
                {draftOpening || wechatDraftOpening ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                {t.editor.wechatDraftSync}
              </button>
            )}
          <button
            type="button"
            onClick={() => void closeDialog()}
            disabled={
              geoClosing ||
              draftOpening ||
              wechatDraftOpening ||
              draftPublishing
            }
            className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm text-neutral-500 transition hover:bg-black/5 disabled:opacity-60 dark:hover:bg-white/10"
          >
            {geoClosing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {geoClosing ? t.editor.wechatGeoSaving : t.editor.shareClose}
          </button>
          {/* 微信对单篇体积有上限，复制完把实际大小说出来 */}
          {bytes !== null && (
            <span className="ml-auto text-[11px] tabular-nums text-neutral-400">
              ~{Math.round(bytes / 1024)} KB
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function extractWechatArticleImages(
  editor: Editor,
): Array<{ src: string; alt: string }> {
  const container = document.createElement("div");
  container.innerHTML = editor.getHTML();
  return Array.from(container.querySelectorAll("img"))
    .map((image) => {
      const rawSource = image.getAttribute("src")?.trim() ?? "";
      if (!rawSource) return null;
      try {
        const source = new URL(rawSource, window.location.origin).toString();
        if (!/^(?:https?:|data:)/i.test(source) && !isDesktopLocalImageURL(source)) return null;
        return {
          src: source,
          alt: image.getAttribute("alt")?.trim() ?? "",
        };
      } catch {
        return null;
      }
    })
    .filter((image): image is { src: string; alt: string } => image !== null);
}
