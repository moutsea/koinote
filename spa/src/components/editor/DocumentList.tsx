import { ChevronLeft, FileText, Plus, Trash2 } from "lucide-react";
import { useI18n, type Locale } from "../../i18n";
import type { DocumentSummary } from "../../documents";

const DATE_LOCALE: Record<Locale, string> = {
  en: "en-US",
  zh: "zh-CN",
  fr: "fr-FR",
  ja: "ja-JP",
};

export function DocumentList({
  documents,
  activeDocId,
  loading,
  creating,
  onSelect,
  onCreate,
  onDelete,
  onCollapse,
}: {
  documents: DocumentSummary[];
  activeDocId?: string;
  loading: boolean;
  creating: boolean;
  onSelect: (docId: string) => void;
  onCreate: () => void;
  onDelete: (docId: string, title: string) => void;
  onCollapse: () => void;
}) {
  const { t, locale } = useI18n();

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-3 py-2">
        <span className="flex-1 truncate text-xs font-semibold uppercase tracking-wide text-neutral-400">
          {t.editor.documentsPanel}
        </span>
        <button
          type="button"
          onClick={onCreate}
          disabled={creating}
          aria-label={t.editor.newDocument}
          title={t.editor.newDocument}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-black/5 hover:text-neutral-900 disabled:opacity-50 dark:hover:bg-white/10 dark:hover:text-white"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onCollapse}
          aria-label={t.editor.collapsePanel}
          aria-expanded
          title={t.editor.collapsePanel}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-neutral-200"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {loading ? (
          <p className="px-2 py-4 text-xs text-neutral-400">{t.editor.loading}</p>
        ) : documents.length === 0 ? (
          <p className="px-2 py-4 text-xs leading-relaxed text-neutral-400">
            {t.editor.emptyDocuments}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {documents.map((doc) => {
              const title = doc.title.trim() || t.editor.untitled;
              const active = doc.docId === activeDocId;
              return (
                <li key={doc.docId} className="group relative">
                  <button
                    type="button"
                    onClick={() => onSelect(doc.docId)}
                    aria-current={active ? "true" : undefined}
                    className={`flex w-full items-start gap-2 rounded-lg px-2 py-2 pr-8 text-left transition ${
                      active
                        ? "bg-sky-50 text-sky-800 dark:bg-sky-950/50 dark:text-sky-200"
                        : "text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10"
                    }`}
                  >
                    <FileText
                      className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                        active ? "text-sky-600 dark:text-sky-400" : "text-neutral-400"
                      }`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{title}</span>
                      {doc.updatedAt && (
                        <span className="mt-0.5 block text-[11px] text-neutral-400">
                          {new Date(doc.updatedAt).toLocaleDateString(
                            DATE_LOCALE[locale],
                          )}
                        </span>
                      )}
                    </span>
                  </button>

                  {/* 删除按钮：悬停或键盘聚焦时出现，避免误触 */}
                  <button
                    type="button"
                    onClick={() => onDelete(doc.docId, title)}
                    aria-label={t.editor.deleteDocument}
                    title={t.editor.deleteDocument}
                    className="absolute right-1 top-2 flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 opacity-0 transition hover:bg-red-50 hover:text-red-600 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

