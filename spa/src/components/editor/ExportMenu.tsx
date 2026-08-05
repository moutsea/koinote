import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import { Code2, Download, FileText, FileType, Printer } from "lucide-react";
import { useI18n } from "../../i18n";
import {
  exportHTML,
  exportMarkdown,
  exportPDF,
  safeFilename,
} from "./exportDocument";

export function ExportMenu({
  editor,
  title,
}: {
  editor: Editor | null;
  title: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 点外部或按 Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function run(kind: string, action: () => void | Promise<void>) {
    setError(null);
    setBusy(kind);
    try {
      await action();
      setOpen(false);
    } catch {
      // 导出失败必须显形，静默失败会让用户以为文件已经下载了
      setError(t.editor.exportFailed);
    } finally {
      setBusy(null);
    }
  }

  if (!editor) return null;

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title={t.editor.exportLabel}
        aria-label={t.editor.exportLabel}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-neutral-400 transition hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-neutral-200"
      >
        <Download className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{t.editor.exportLabel}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-9 z-40 min-w-52 overflow-hidden rounded-xl border border-black/10 bg-[var(--background)] py-1 shadow-lg dark:border-white/15"
        >
          <Item
            icon={<FileText className="h-3.5 w-3.5" />}
            label={t.editor.exportMarkdown}
            busy={busy === "md"}
            onClick={() =>
              run("md", () =>
                exportMarkdown(editor, title, t.editor.untitled),
              )
            }
          />
          <Item
            icon={<Code2 className="h-3.5 w-3.5" />}
            label={t.editor.exportHTML}
            busy={busy === "html"}
            onClick={() =>
              run("html", () => exportHTML(editor, title, t.editor.untitled))
            }
          />
          <Item
            icon={<FileType className="h-3.5 w-3.5" />}
            label={t.editor.exportDOCX}
            busy={busy === "docx"}
            onClick={() =>
              run("docx", async () => {
                // 动态引入：docx 库约 1 MB，不该压在编辑器首屏
                const [{ buildDocx }, { downloadBlob }] = await Promise.all([
                  import("./exportDocx"),
                  import("./exportDocument"),
                ]);
                const blob = await buildDocx(editor, title, {
                  imageFailed: t.editor.exportFailed,
                });
                downloadBlob(
                  blob,
                  `${safeFilename(title, t.editor.untitled)}.docx`,
                );
              })
            }
          />
          <div className="my-1 h-px bg-black/5 dark:bg-white/10" />
          <Item
            icon={<Printer className="h-3.5 w-3.5" />}
            label={t.editor.exportPDF}
            hint={t.editor.exportPDFHint}
            busy={busy === "pdf"}
            onClick={() => run("pdf", () => exportPDF())}
          />
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="absolute right-0 top-9 z-40 whitespace-nowrap rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 shadow dark:bg-red-950/60 dark:text-red-400"
        >
          {error}
        </p>
      )}
    </div>
  );
}

function Item({
  icon,
  label,
  hint,
  busy,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  busy?: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      role="menuitem"
      disabled={busy}
      onClick={onClick}
      className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition hover:bg-black/5 disabled:opacity-60 dark:hover:bg-white/10"
    >
      <span className="mt-0.5 shrink-0 text-neutral-400">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{busy ? t.editor.exporting : label}</span>
        {hint && (
          <span className="mt-0.5 block text-[11px] leading-relaxed text-neutral-400">
            {hint}
          </span>
        )}
      </span>
    </button>
  );
}
