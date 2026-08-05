import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Check, Copy, Loader2, X } from "lucide-react";
import { useI18n } from "../../i18n";
import { buildWechatHTML, copyRichText } from "./exportWechat";
import { groupWechatThemes, type WechatThemeId } from "./wechatThemes";

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

        <div className="mt-4 space-y-4">
          {groupWechatThemes().map(({ group, themes }) => (
            <div key={group}>
              <h3 className="mb-2 text-xs font-semibold text-neutral-500 dark:text-neutral-400">
                {group}
              </h3>
              <div className="space-y-1.5">
                {themes.map((theme) => (
                  <button
                    key={theme.id}
                    type="button"
                    role="radio"
                    aria-checked={themeId === theme.id}
                    onClick={() => {
                      setThemeId(theme.id);
                      setDone(false);
                    }}
                    className={`flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition ${
                      themeId === theme.id
                        ? "border-sky-500 bg-sky-50 dark:bg-sky-950/30"
                        : "border-black/10 hover:bg-black/[0.03] dark:border-white/15 dark:hover:bg-white/5"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`mt-1 h-3 w-3 shrink-0 rounded-full border-2 ${
                        themeId === theme.id
                          ? "border-sky-500 bg-sky-500"
                          : "border-neutral-300 dark:border-neutral-600"
                      }`}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{theme.name}</span>
                      <span className="mt-0.5 block text-[11px] text-neutral-400">
                        {theme.hint}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
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
