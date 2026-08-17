import { useEffect, useMemo, useRef, useState } from "react";
import { GitCompareArrows, LoaderCircle, RotateCcw, X } from "lucide-react";
import {
  ApiError,
  getDocumentVersion,
  listDocumentVersions,
  restoreDocumentVersion,
  type Document,
  type DocumentVersion,
} from "../../api";
import { interpolate, useI18n } from "../../i18n";
import { buildVersionDiff } from "./versionDiff";

type Comparison = {
  revision: "current" | number;
  title: string;
  content: string;
};

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
  const [comparison, setComparison] = useState<Comparison>({
    revision: "current",
    title: document.title,
    content: document.content,
  });
  const [loading, setLoading] = useState(true);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const comparisonRequest = useRef(0);
  const diff = useMemo(
    () => buildVersionDiff(selected?.content ?? "", comparison.content),
    [selected?.content, comparison.content],
  );
  const titleChanged = selected !== null && selected.title !== comparison.title;

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const { versions: items } = await listDocumentVersions(document.docId);
        if (!active) return;
        setVersions(items);
        if (items[0]) {
          const { version } = await getDocumentVersion(
            document.docId,
            items[0].revision,
          );
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
    comparisonRequest.current += 1;
    setLoadingDiff(false);
    setError(null);
    try {
      const result = await getDocumentVersion(document.docId, version.revision);
      setSelected(result.version);
      if (comparison.revision === version.revision) {
        setComparison({
          revision: "current",
          title: document.title,
          content: document.content,
        });
      }
    } catch {
      setError(t.editor.historyLoadFailed);
    }
  }

  async function selectComparison(value: string) {
    const request = comparisonRequest.current + 1;
    comparisonRequest.current = request;
    setError(null);
    if (value === "current") {
      setComparison({
        revision: "current",
        title: document.title,
        content: document.content,
      });
      return;
    }
    const revision = Number(value);
    if (!Number.isSafeInteger(revision) || revision <= 0) return;
    setLoadingDiff(true);
    try {
      const result = await getDocumentVersion(document.docId, revision);
      if (comparisonRequest.current === request) {
        setComparison({
          revision,
          title: result.version.title,
          content: result.version.content ?? "",
        });
      }
    } catch {
      if (comparisonRequest.current === request) {
        setError(t.editor.historyLoadFailed);
      }
    } finally {
      if (comparisonRequest.current === request) setLoadingDiff(false);
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
      setError(
        caught instanceof ApiError &&
          caught.code === "document_revision_conflict"
          ? t.editor.historyConflict
          : t.editor.historyRestoreFailed,
      );
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
        className="flex max-h-full w-full max-w-6xl flex-col rounded-2xl border border-black/5 bg-[var(--background)] p-5 shadow-xl dark:border-white/10"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">{t.editor.historyTitle}</h2>
            <p className="mt-1 text-sm text-neutral-500">
              {t.editor.historyDescription}
            </p>
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
          <p className="py-16 text-center text-sm text-neutral-500">
            {t.editor.historyEmpty}
          </p>
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
                  <span className="mt-1 block truncate text-neutral-500">
                    {version.title || t.editor.untitled}
                  </span>
                  <span className="mt-1 block text-neutral-400">
                    {version.createdAt
                      ? new Date(version.createdAt).toLocaleString(locale)
                      : "—"}
                    {` · ${t.editor.historySource[version.source]}`}
                    {version.safetySnapshot
                      ? ` · ${t.editor.historySafetySnapshot}`
                      : ""}
                  </span>
                </button>
              ))}
            </div>

            <div className="flex min-h-0 flex-col rounded-xl border border-black/10 dark:border-white/15">
              <div className="flex flex-wrap items-center gap-3 border-b border-black/10 px-4 py-3 dark:border-white/15">
                <GitCompareArrows className="h-4 w-4 text-neutral-400" />
                <span className="text-xs font-medium text-neutral-500">
                  {t.editor.historyCompareWith}
                </span>
                <select
                  value={comparison.revision}
                  onChange={(event) => void selectComparison(event.target.value)}
                  disabled={loadingDiff}
                  className="min-w-0 rounded-lg border border-black/10 bg-transparent px-2 py-1.5 text-xs outline-none dark:border-white/15"
                >
                  <option value="current">{t.editor.historyCurrent}</option>
                  {versions
                    .filter((version) => version.revision !== selected?.revision)
                    .map((version) => (
                      <option key={version.revision} value={version.revision}>
                        #{version.revision} · {version.title || t.editor.untitled}
                      </option>
                    ))}
                </select>
                {!loadingDiff && selected && (
                  <span className="ml-auto text-xs text-neutral-400">
                    +{diff.added} / −{diff.removed}
                  </span>
                )}
              </div>

              {loadingDiff ? (
                <div className="flex min-h-80 flex-1 items-center justify-center text-sm text-neutral-400">
                  <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                  {t.editor.historyLoadingDiff}
                </div>
              ) : selected && !diff.changed && !titleChanged ? (
                <div className="flex min-h-80 flex-1 items-center justify-center text-sm text-neutral-500">
                  {t.editor.historyNoChanges}
                </div>
              ) : (
                <div className="min-h-80 flex-1 overflow-auto font-mono text-xs leading-5">
                  {titleChanged && selected && (
                    <div className="border-b border-black/10 px-4 py-3 font-sans text-xs text-neutral-500 dark:border-white/15">
                      {interpolate(t.editor.historyTitleChanged, {
                        before: selected.title || t.editor.untitled,
                        after: comparison.title || t.editor.untitled,
                      })}
                    </div>
                  )}
                  {diff.lines.map((line, index) =>
                    line.kind === "omitted" ? (
                      <div
                        key={`omitted-${index}`}
                        className="border-y border-black/5 bg-black/[0.025] px-4 py-1.5 text-center text-neutral-400 dark:border-white/5 dark:bg-white/[0.025]"
                      >
                        {interpolate(t.editor.historyLinesOmitted, {
                          n: line.omitted ?? 0,
                        })}
                      </div>
                    ) : (
                      <div
                        key={`${line.kind}-${line.oldLine}-${line.newLine}-${index}`}
                        className={`grid grid-cols-[3rem_3rem_1.5rem_minmax(0,1fr)] ${
                          line.kind === "add"
                            ? "bg-emerald-50/80 dark:bg-emerald-950/25"
                            : line.kind === "remove"
                              ? "bg-red-50/80 dark:bg-red-950/25"
                              : ""
                        }`}
                      >
                        <span className="select-none border-r border-black/5 px-2 text-right text-neutral-300 dark:border-white/10 dark:text-neutral-600">
                          {line.oldLine ?? ""}
                        </span>
                        <span className="select-none border-r border-black/5 px-2 text-right text-neutral-300 dark:border-white/10 dark:text-neutral-600">
                          {line.newLine ?? ""}
                        </span>
                        <span className="select-none text-center text-neutral-400">
                          {line.kind === "add"
                            ? "+"
                            : line.kind === "remove"
                              ? "−"
                              : ""}
                        </span>
                        <span className="whitespace-pre-wrap break-words pr-4">
                          {line.text || " "}
                        </span>
                      </div>
                    ),
                  )}
                </div>
              )}
            </div>
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
              {restoring ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="h-4 w-4" />
              )}
              {t.editor.restoreVersion}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
