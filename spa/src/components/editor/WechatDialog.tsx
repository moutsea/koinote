import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Check, Copy, Loader2, X } from "lucide-react";
import { useI18n } from "../../i18n";
import {
  exportToMedia,
  mediaExportFormat,
  type MediaPlatform,
} from "./exportMedia";
import { findWechatTheme } from "./wechatThemes";
import { trackProductEvent } from "../../api";
import { isLocalModeNetworkDisabled } from "../../desktop/localMode";
import { pushModal } from "../../modalStack";

/**
 * 导出到自媒体平台。
 *
 * 微信与知乎使用内联样式富文本；掘金原生支持 Markdown，直接复制源码能保留最多语义。
 * 不带主题选择也不带预览：主题是文档属性，在编辑区已经生效了。
 */
export function MediaExportDialog({
  editor,
  title,
  themeId,
  onClose,
}: {
  editor: Editor;
  title: string;
  themeId: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [platform, setPlatform] = useState<MediaPlatform>("wechat");
  const [bytes, setBytes] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // 与 note 分开：图片抓不到和公式降级可能同时发生，共用一个槽会互相顶掉，
  // 而被顶掉的恰好是更严重的那条
  const [imageWarning, setImageWarning] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

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

  async function run() {
    setError(null);
    setNote(null);
    setImageWarning(null);
    setDone(false);
    setBusy(true);
    try {
      const result = await exportToMedia(platform, editor, title, themeId);
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

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t.editor.mediaTitle}
        tabIndex={-1}
        className="w-full max-w-md rounded-2xl border border-black/10 bg-[var(--background)] p-5 shadow-2xl outline-none dark:border-white/15"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">{t.editor.mediaTitle}</h2>
            <p className="mt-1 text-xs leading-relaxed text-neutral-400">
              {t.editor.mediaSubtitle}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.editor.shareClose}
            className="shrink-0 rounded-lg p-1.5 text-neutral-400 transition hover:bg-black/5 dark:hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div
          className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3"
          role="radiogroup"
          aria-label={t.editor.mediaPlatformLabel}
        >
          {(
            [
              ["wechat", t.editor.mediaWechat, t.editor.mediaWechatHint],
              ["zhihu", t.editor.mediaZhihu, t.editor.mediaZhihuHint],
              ["juejin", t.editor.mediaJuejin, t.editor.mediaJuejinHint],
            ] as const
          ).map(([value, label, hint]) => {
            const selected = platform === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => {
                  setPlatform(value);
                  setDone(false);
                  setBytes(null);
                  setError(null);
                  setNote(null);
                  setImageWarning(null);
                }}
                className="rounded-xl border px-3 py-3 text-left transition hover:bg-black/[0.03] dark:hover:bg-white/5"
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
        </div>

        {/* 当前用的是哪套主题。改主题要回编辑区改 —— 那里改完立刻能看见效果，
            在这个弹窗里改反而看不见 */}
        {mediaExportFormat(platform) === "rich-text" && (
          <p className="mt-4 rounded-lg bg-black/[0.03] px-3 py-2 text-xs text-neutral-500 dark:bg-white/5 dark:text-neutral-400">
            {t.editor.wechatThemeLabel}
            <span className="mx-1.5 text-neutral-300 dark:text-neutral-600">
              ·
            </span>
            <span className="font-medium text-neutral-700 dark:text-neutral-200">
              {themeId ? findWechatTheme(themeId).name : t.editor.themeNone}
            </span>
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

        <p className="mt-4 text-[11px] leading-relaxed text-neutral-400">
          {mediaExportFormat(platform) === "markdown"
            ? t.editor.mediaMarkdownNote
            : t.editor.mediaRichTextNote}
        </p>

        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={run}
            disabled={busy}
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
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-4 py-2 text-sm text-neutral-500 transition hover:bg-black/5 dark:hover:bg-white/10"
          >
            {t.editor.shareClose}
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
