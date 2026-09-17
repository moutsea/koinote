import { useState, type ReactNode } from "react";
import { FileUp } from "lucide-react";
import { useI18n } from "../../i18n";
import { hasExternalFileDrag, markdownFilesFromDataTransfer } from "./treeDrag";

export function DocumentImportDropZone({ children, importing, notice, onImport }: {
  children: ReactNode;
  importing: boolean;
  notice: { error: boolean; message: string } | null;
  onImport: (files: File[]) => void;
}) {
  const { t } = useI18n();
  const [over, setOver] = useState(false);
  const [showResult, setShowResult] = useState(false);

  return (
    <div
      className="relative flex min-w-0 flex-1 flex-col"
      onDragOverCapture={(event) => {
        const transfer = event.dataTransfer;
        if (!hasExternalFileDrag(transfer)) return;
        // 拖动期间文件名通常不可读；纯图片交给编辑器自己的上传流程。
        const items = Array.from(transfer.items).filter((item) => item.kind === "file");
        if (items.length > 0 && items.every((item) => item.type.startsWith("image/"))) return;
        event.preventDefault();
        transfer.dropEffect = importing ? "none" : "copy";
        setOver(true);
      }}
      onDragLeaveCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      }}
      onDragEndCapture={() => setOver(false)}
      onDropCapture={(event) => {
        setOver(false);
        const files = markdownFilesFromDataTransfer(event.dataTransfer);
        if (files.length === 0) return;
        // 在 ProseMirror 之前接住文件，避免同时插入正文或触发图片上传。
        event.preventDefault();
        event.stopPropagation();
        if (importing) return;
        setShowResult(true);
        onImport(files);
      }}
    >
      {showResult && (importing || notice) && (
        <p
          role={notice?.error && !importing ? "alert" : "status"}
          className={`border-b border-black/5 px-4 py-2 text-xs dark:border-white/10 ${notice?.error && !importing ? "text-red-600 dark:text-red-400" : "text-neutral-500 dark:text-neutral-400"}`}
        >
          {importing ? t.transfer.importing : notice?.message}
        </p>
      )}
      {children}
      {over && (
        <div className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-cinnabar-500 bg-[var(--background)]/90">
          <div className="flex items-center gap-2 rounded-lg bg-[var(--background)] px-4 py-3 text-sm text-cinnabar-600 shadow-sm dark:text-cinnabar-400">
            <FileUp className="h-5 w-5" />
            {importing ? t.transfer.importing : t.transfer.importDropHint}
          </div>
        </div>
      )}
    </div>
  );
}
