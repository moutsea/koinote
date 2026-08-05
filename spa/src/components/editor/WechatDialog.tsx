import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Check, ChevronDown, Copy, Loader2, X } from "lucide-react";
import { useI18n } from "../../i18n";
import { buildWechatHTML, copyRichText } from "./exportWechat";
import {
  findWechatTheme,
  groupWechatThemes,
  type WechatThemeId,
} from "./wechatThemes";

export function WechatDialog({
  editor,
  title,
  onClose,
}: {
  editor: Editor;
  title: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [themeId, setThemeId] = useState<WechatThemeId>("minimal");
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
      const result = await buildWechatHTML(editor, title, themeId);
      await copyRichText(result.html, editor.storage.markdown.getMarkdown());
      setDone(true);

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

        <div className="mt-4">
          <label
            htmlFor="wechat-theme"
            className="block text-xs font-medium text-neutral-500 dark:text-neutral-400"
          >
            {t.editor.wechatThemeLabel}
          </label>
          {/* 原生 select：15 套主题平铺会把弹窗撑得很长，而 optgroup 的分组、
              键盘选择、移动端滚轮都是系统给的，自己实现一遍不划算。
              color-scheme 要跟着应用的深色模式走 —— 下拉列表和控件文字由系统绘制，
              而这里的深色是 .dark class 手动切的，跟系统偏好无关；不声明的话
              「系统亮色 + 应用深色」会得到深底配深字 */}
          <div className="relative mt-1.5">
            <select
              id="wechat-theme"
              value={themeId}
              onChange={(e) => {
                setThemeId(e.target.value as WechatThemeId);
                setDone(false);
              }}
              className="w-full appearance-none rounded-xl border border-black/10 bg-[var(--background)] py-2.5 pl-3 pr-9 text-sm outline-none transition [color-scheme:light] focus:border-sky-500 dark:border-white/15 dark:[color-scheme:dark]"
            >
              {groupWechatThemes().map(({ group, themes }) => (
                <optgroup key={group} label={group}>
                  {themes.map((theme) => (
                    <option key={theme.id} value={theme.id}>
                      {theme.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <ChevronDown
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400"
            />
          </div>
          {/* 选中项的适用场景。option 里塞不进第二行，只能放到外面 */}
          <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-400">
            {findWechatTheme(themeId).hint}
          </p>
        </div>

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
        </div>
      </div>
    </div>
  );
}
