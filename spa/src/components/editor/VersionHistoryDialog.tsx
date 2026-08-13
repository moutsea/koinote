import { useEffect, useState } from "react";
import { LoaderCircle, RotateCcw, X } from "lucide-react";
import {
  ApiError,
  getDocumentVersion,
  listDocumentVersions,
  restoreDocumentVersion,
  type Document,
  type DocumentVersion,
} from "../../api";
import { useI18n } from "../../i18n";

export function VersionHistoryDialog({
  document,
  onRestore,
  onClose,
}: {
  document: Document;
  onRestore: (document: Document) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [selected, setSelected] = useState<DocumentVersion | null>(null);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const { versions: items } = await listDocumentVersions(document.docId);
        if (!active) return;
        setVersions(items);
        if (items[0]) {
          const { version } = await getDocumentVersion(document.docId, items[0].revision);
          if (active) setSelected(version);
        }
      } catch {
        if (active) setError(t.editor.historyLoadFailed);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [document.docId, t.editor.historyLoadFailed]);

  async function selectVersion(version: DocumentVersion) {
    setError(null);
    try {
      const result = await getDocumentVersion(document.docId, version.revision);
      setSelected(result.version);
    } catch {
      setError(t.editor.historyLoadFailed);
    }
  }

  async function restore() {
    if (!selected) return;
    setRestoring(true);
    setError(null);
    try {
      const result = await restoreDocumentVersion(
        document.docId,
        selected.revision,
        document.revision,
      );
      onRestore(result.document);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "document_revision_conflict") {
        setError(t.editor.historyConflict);
      } else {
        setError(t.editor.historyRestoreFailed);
      }
    } finally {
      setRestoring(false);
    }
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
        aria-label={t.editor.historyTitle}
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-full w-full max-w-4xl flex-col rounded-2xl border border-black/5 bg-[var(--background)] p-5 shadow-xl dark:border-white/10"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">{t.editor.historyTitle}</h2>
            <p className="mt-1 text-sm text-neutral-500">{t.editor.historyDescription}</p>
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
        ) : versions.length === 0 ? (
          <p className="py-16 text-center text-sm text-neutral-500">{t.editor.historyEmpty}</p>
        ) : (
          <div className="mt-5 grid min-h-0 flex-1 gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
            <div className="space-y-1 overflow-y-auto rounded-xl border border-black/10 p-2 dark:border-white/15">
              {versions.map((version) => (
                <button
                  type="button"
                  key={version.revision}
                  onClick={() => void selectVersion(version)}
                  className={`w-full rounded-lg px-3 py-2 text-left text-xs transition ${
                    selected?.revision === version.revision
                      ? "bg-cinnabar-50 text-cinnabar-700 dark:bg-cinnabar-950/40 dark:text-cinnabar-300"
                      : "hover:bg-black/5 dark:hover:bg-white/10"
                  }`}
                >
                  <span className="block font-semibold">#{version.revision}</span>
                  <span className="mt-1 block truncate text-neutral-500">{version.title || t.editor.untitled}</span>
                  <span className="mt-1 block text-neutral-400">
                    {version.createdAt ? new Date(version.createdAt).toLocaleString(locale) : "—"}
                    {` · ${t.editor.historySource[version.source]}`}
                    {version.safetySnapshot ? ` · ${t.editor.historySafetySnapshot}` : ""}
                  </span>
                </button>
              ))}
            </div>
            <textarea
              readOnly
              value={selected?.content ?? ""}
              spellCheck={false}
              className="min-h-80 resize-none rounded-xl border border-black/10 bg-white/70 p-4 font-mono text-xs leading-6 outline-none dark:border-white/15 dark:bg-white/5"
            />
          </div>
        )}

        {error && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
        {selected && (
          <div className="mt-5 flex justify-end">
            <button
              type="button"
              disabled={restoring}
              onClick={() => void restore()}
              className="inline-flex items-center gap-2 rounded-full bg-cinnabar-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-cinnabar-500 disabled:opacity-60"
            >
              {restoring ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              {t.editor.restoreVersion}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
