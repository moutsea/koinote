import { useEffect, useState } from "react";
import { LoaderCircle, X } from "lucide-react";
import { getDocument, type Document } from "../../api";
import type { DocumentSnapshot } from "./useDocumentSaver";
import { useI18n } from "../../i18n";
import { findWechatTheme } from "./wechatThemes";

export function ConflictDialog({
  docId,
  local,
  onAcceptRemote,
  onOverwrite,
  onClose,
}: {
  docId: string;
  local: DocumentSnapshot;
  onAcceptRemote: (document: Document) => void;
  onOverwrite: (
    remoteRevision: number,
    patch: Pick<DocumentSnapshot, "title" | "content" | "theme">,
  ) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [remote, setRemote] = useState<Document | null>(null);
  const [merged, setMerged] = useState(local);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    void getDocument(docId)
      .then(({ document }) => {
        if (active) setRemote(document);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [docId]);

  async function saveMerged() {
    if (!remote) return;
    setSaving(true);
    setError(false);
    const saved = await onOverwrite(remote.revision, {
      title: merged.title,
      content: merged.content,
      theme: merged.theme,
    });
    if (!saved) {
      setError(true);
      try {
        const latest = await getDocument(docId);
        setRemote(latest.document);
      } catch {
        // 保留现有远端内容和错误提示，用户仍可关闭后重开对话框重试。
      }
    }
    setSaving(false);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4 py-6"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.editor.conflictTitle}
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-full w-full max-w-5xl flex-col rounded-2xl border border-black/5 bg-[var(--background)] p-5 shadow-xl dark:border-white/10"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">{t.editor.conflictTitle}</h2>
            <p className="mt-1 text-sm text-neutral-500">{t.editor.conflictDescription}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.editor.shareClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-black/5 dark:hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading ? (
          <div className="flex min-h-64 items-center justify-center text-sm text-neutral-400">
            <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
            {t.editor.loading}
          </div>
        ) : remote ? (
          <>
            <div className="mt-5 grid min-h-0 flex-1 gap-4 lg:grid-cols-2">
              <SourcePane
                label={t.editor.localDraft}
                title={merged.title}
                theme={themeName(merged.theme, t.editor.themeNone)}
                value={merged.content}
                onTitleChange={(title) => setMerged((current) => ({ ...current, title }))}
                onChange={(content) => setMerged((current) => ({ ...current, content }))}
              />
              <SourcePane
                label={t.editor.remoteVersion}
                title={remote.title}
                theme={themeName(remote.theme, t.editor.themeNone)}
                value={remote.content}
                readOnly
              />
            </div>
            {error && (
              <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">
                {t.editor.conflictSaveFailed}
              </p>
            )}
            <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => onAcceptRemote(remote)}
                className="rounded-full px-4 py-2 text-sm font-medium text-neutral-600 transition hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10"
              >
                {t.editor.useRemote}
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void saveMerged()}
                className="inline-flex items-center gap-2 rounded-full bg-cinnabar-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-cinnabar-500 disabled:opacity-60"
              >
                {saving && <LoaderCircle className="h-4 w-4 animate-spin" />}
                {t.editor.saveMerged}
              </button>
            </div>
          </>
        ) : (
          <p className="py-16 text-center text-sm text-red-600 dark:text-red-400">
            {t.editor.conflictLoadFailed}
          </p>
        )}
      </div>
    </div>
  );
}

function SourcePane({
  label,
  title,
  theme,
  value,
  onTitleChange,
  onChange,
  readOnly = false,
}: {
  label: string;
  title: string;
  theme: string;
  value: string;
  onTitleChange?: (value: string) => void;
  onChange?: (value: string) => void;
  readOnly?: boolean;
}) {
  return (
    <label className="flex min-h-72 flex-col">
      <span className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {label}
      </span>
      <input
        value={title}
        readOnly={readOnly}
        onChange={(event) => onTitleChange?.(event.target.value)}
        className="mb-2 rounded-lg border border-black/10 bg-white/70 px-3 py-2 text-sm font-semibold outline-none focus:border-cinnabar-500 dark:border-white/15 dark:bg-white/5"
      />
      <span className="mb-2 text-xs text-neutral-400">{theme}</span>
      <textarea
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange?.(event.target.value)}
        spellCheck={false}
        className="min-h-72 flex-1 resize-none rounded-xl border border-black/10 bg-white/70 p-4 font-mono text-xs leading-6 outline-none focus:border-cinnabar-500 dark:border-white/15 dark:bg-white/5"
      />
    </label>
  );
}

function themeName(theme: string, none: string) {
  return theme ? findWechatTheme(theme).name : none;
}
