import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Check, Copy, Loader2, X } from "lucide-react";
import { useI18n } from "../../i18n";
import { buildWechatHTML, copyRichText } from "./exportWechat";
import { findWechatTheme } from "./wechatThemes";

/**
 * 导出到微信公众号。
 *
 * 不带主题选择也不带预览：主题是文档属性，在编辑区已经生效了。这里只做一件事
 * —— 把编辑区看到的样子转成内联 style 的 HTML 写进剪贴板。
 */
export function WechatDialog({
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
  const [bytes, setBytes] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function run() {
    setError(null);
    setNote(null);
    setDone(false);
    setBusy(true);
    try {
      // 公式栅格化 + 上传放在这里而不是打开弹窗时：只是点开看看又关掉的话，
      // 不该往 R2 里堆图（现在没有 images 表，堆进去也没法列举清理）
      const result = await buildWechatHTML(editor, title, themeId);
      await copyRichText(result.html, editor.storage.markdown.getMarkdown());
      setDone(true);
      setBytes(result.bytes);

      // 公式失败要说出来。静默降级成 LaTeX 源码，用户会以为公式本来就长那样
      if (result.math.failed > 0) {
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
    } catch {
      setError(t.editor.exportFailed);
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
        aria-label={t.editor.wechatTitle}
        tabIndex={-1}
        className="w-full max-w-md rounded-2xl border border-black/10 bg-[var(--background)] p-5 shadow-2xl outline-none dark:border-white/15"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">{t.editor.wechatTitle}</h2>
            <p className="mt-1 text-xs leading-relaxed text-neutral-400">
              {t.editor.wechatSubtitle}
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

        {/* 当前用的是哪套主题。改主题要回编辑区改 —— 那里改完立刻能看见效果，
            在这个弹窗里改反而看不见 */}
        <p className="mt-4 rounded-lg bg-black/[0.03] px-3 py-2 text-xs text-neutral-500 dark:bg-white/5 dark:text-neutral-400">
          {t.editor.wechatThemeLabel}
          <span className="mx-1.5 text-neutral-300 dark:text-neutral-600">·</span>
          <span className="font-medium text-neutral-700 dark:text-neutral-200">
            {themeId ? findWechatTheme(themeId).name : t.editor.themeNone}
          </span>
        </p>

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
          {t.editor.wechatCodeNote}
        </p>

        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={run}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-full bg-sky-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:opacity-60"
          >
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t.editor.wechatWorking}
              </>
            ) : done ? (
              <>
                <Check className="h-3.5 w-3.5" />
                {t.editor.wechatCopied}
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                {t.editor.wechatCopy}
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
