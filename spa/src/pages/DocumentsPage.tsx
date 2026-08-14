import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  FileText,
  FolderUp,
  LoaderCircle,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import { useRef, useState } from "react";
import { useSession } from "../auth";
import { useDocumentList, useFolderList } from "../documents";
import { useI18n, interpolate, type Locale } from "../i18n";
import { PageContainer } from "../components/PageContainer";
import {
  exportDocumentsArchive,
  importDocumentsFromFiles,
} from "../documentTransfer";

const DATE_LOCALE: Record<Locale, string> = {
  en: "en-US",
  zh: "zh-CN",
  fr: "fr-FR",
  ja: "ja-JP",
};

export function DocumentsPage() {
  const session = useSession();
  const { t, locale } = useI18n();
  const documents = useDocumentList(Boolean(session.data?.user));
  const folders = useFolderList(Boolean(session.data?.user));
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [transfer, setTransfer] = useState<{
    kind: "import" | "export";
    done: number;
    total: number;
  } | null>(null);
  const [transferNotice, setTransferNotice] = useState<string | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);

  async function handleImport(files: File[]) {
    if (files.length === 0) return;
    setTransferError(null);
    setTransferNotice(null);
    setTransfer({ kind: "import", done: 0, total: 0 });
    try {
      const count = await importDocumentsFromFiles(files, (done, total) =>
        setTransfer({ kind: "import", done, total }),
      );
      setTransferNotice(
        interpolate(t.transfer.importSuccess, { count: String(count) }),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["documents"] }),
        queryClient.invalidateQueries({ queryKey: ["folders"] }),
        queryClient.invalidateQueries({ queryKey: ["storage-usage"] }),
      ]);
    } catch {
      setTransferError(t.transfer.importFailed);
    } finally {
      setTransfer(null);
    }
  }

  async function handleExport() {
    if (!documents.data?.length) return;
    setTransferError(null);
    setTransferNotice(null);
    setTransfer({ kind: "export", done: 0, total: documents.data.length });
    try {
      await exportDocumentsArchive(
        documents.data,
        folders.data ?? [],
        (done, total) => setTransfer({ kind: "export", done, total }),
      );
      setTransferNotice(t.transfer.exportSuccess);
    } catch {
      setTransferError(t.transfer.exportFailed);
    } finally {
      setTransfer(null);
    }
  }

  if (session.isLoading) {
    return (
      <div
        className="flex flex-1 items-center justify-center py-24"
        style={{ color: "var(--ink-faint)" }}
      >
        {t.dashboard.loading}
      </div>
    );
  }

  if (!session.data?.user) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-24 text-center">
        <p
          className="kn-heading-cn text-lg font-medium"
          style={{ color: "var(--ink-black)" }}
        >
          {t.dashboard.loginRequired}
        </p>
        <p className="text-sm" style={{ color: "var(--ink-mid)" }}>
          {t.dashboard.loginRequiredHint}
        </p>
        <Link
          to="/login"
          className="rounded-full px-6 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
          style={{ background: "var(--cinnabar)" }}
        >
          {t.dashboard.goLogin}
        </Link>
      </div>
    );
  }

  return (
    <PageContainer className="flex-1 py-10">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1
            className="kn-heading-cn text-2xl font-bold tracking-tight"
            style={{ color: "var(--ink-black)" }}
          >
            {t.documentsPage.title}
          </h1>
          <div
            className="mt-2 h-0.5 w-10 rounded-full"
            style={{ background: "var(--cinnabar)" }}
          />
          <p className="mt-2 text-sm" style={{ color: "var(--ink-mid)" }}>
            {t.documentsPage.subtitle}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept=".md,.zip,image/png,image/jpeg,image/gif,image/webp"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              void handleImport(files);
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            className="hidden"
            {...({ webkitdirectory: "", directory: "" } as Record<
              string,
              string
            >)}
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              void handleImport(files);
            }}
          />
          <button
            type="button"
            disabled={Boolean(transfer)}
            onClick={() => inputRef.current?.click()}
            className="hidden items-center gap-1.5 rounded-full border px-4 py-2.5 text-sm font-medium transition hover:bg-[var(--ink-wash-strong)] disabled:opacity-50 sm:inline-flex"
            style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}
          >
            <Upload className="h-4 w-4" />
            {t.transfer.importButton}
          </button>
          <button
            type="button"
            disabled={Boolean(transfer)}
            onClick={() => folderInputRef.current?.click()}
            className="hidden items-center gap-1.5 rounded-full border px-4 py-2.5 text-sm font-medium transition hover:bg-[var(--ink-wash-strong)] disabled:opacity-50 sm:inline-flex"
            style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}
          >
            <FolderUp className="h-4 w-4" />
            {t.transfer.importFolderButton}
          </button>
          <button
            type="button"
            disabled={Boolean(transfer) || !documents.data?.length}
            onClick={() => void handleExport()}
            className="hidden items-center gap-1.5 rounded-full border px-4 py-2.5 text-sm font-medium transition hover:bg-[var(--ink-wash-strong)] disabled:opacity-50 sm:inline-flex"
            style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}
          >
            <Archive className="h-4 w-4" />
            {t.transfer.exportButton}
          </button>
          <Link
            to="/trash"
            className="inline-flex items-center gap-1.5 rounded-full border px-4 py-2.5 text-sm font-medium transition hover:bg-[var(--ink-wash-strong)]"
            style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}
          >
            <Trash2 className="h-4 w-4" />
            {t.nav.trash}
          </Link>
          <Link
            to="/editor"
            className="inline-flex items-center gap-1.5 rounded-full px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
            style={{ background: "var(--cinnabar)" }}
          >
            <Plus className="h-4 w-4" />
            {t.dashboard.newDoc}
          </Link>
        </div>
      </div>

      <div
        className="mt-5 flex flex-wrap items-center gap-3 text-xs"
        style={{ color: "var(--ink-faint)" }}
      >
        <button
          type="button"
          disabled={Boolean(transfer)}
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-1.5 font-medium sm:hidden"
          style={{ color: "var(--cinnabar)" }}
        >
          <Upload className="h-3.5 w-3.5" />
          {t.transfer.importButton}
        </button>
        <button
          type="button"
          disabled={Boolean(transfer)}
          onClick={() => folderInputRef.current?.click()}
          className="inline-flex items-center gap-1.5 font-medium sm:hidden"
          style={{ color: "var(--cinnabar)" }}
        >
          <FolderUp className="h-3.5 w-3.5" />
          {t.transfer.importFolderButton}
        </button>
        <button
          type="button"
          disabled={Boolean(transfer) || !documents.data?.length}
          onClick={() => void handleExport()}
          className="inline-flex items-center gap-1.5 font-medium disabled:opacity-50 sm:hidden"
          style={{ color: "var(--cinnabar)" }}
        >
          <Archive className="h-3.5 w-3.5" />
          {t.transfer.exportButton}
        </button>
        <span>{t.transfer.importHint}</span>
      </div>

      {(transfer || transferNotice || transferError) && (
        <div
          className="mt-4 flex items-center gap-2 rounded-xl border px-4 py-3 text-sm"
          style={{
            borderColor: "var(--ink-line)",
            color: transferError ? "#dc2626" : "var(--ink-mid)",
          }}
          role={transferError ? "alert" : "status"}
        >
          {transfer && (
            <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" />
          )}
          <span>
            {transfer
              ? `${transfer.kind === "import" ? t.transfer.importing : t.transfer.exporting}${transfer.total > 0 ? ` ${transfer.done}/${transfer.total}` : ""}`
              : transferError || transferNotice}
          </span>
        </div>
      )}

      {documents.isLoading ? (
        <p className="mt-8 text-sm" style={{ color: "var(--ink-faint)" }}>
          {t.editor.loading}
        </p>
      ) : documents.data && documents.data.length > 0 ? (
        <ul
          className="mt-8 overflow-hidden rounded-xl border"
          style={{
            borderColor: "var(--ink-line)",
            background: "var(--ink-paper-soft)",
          }}
        >
          {documents.data.map((document, index) => (
            <li
              key={document.docId}
              style={
                index > 0
                  ? { borderTop: "1px solid var(--ink-line)" }
                  : undefined
              }
            >
              <Link
                to="/editor/$docId"
                params={{ docId: document.docId }}
                className="flex items-center gap-3 px-5 py-3.5 transition hover:bg-[var(--ink-wash-strong)]"
              >
                <FileText
                  className="h-4 w-4 shrink-0"
                  style={{ color: "var(--ink-faint)" }}
                />
                <span
                  className="min-w-0 flex-1 truncate text-sm font-medium"
                  style={{ color: "var(--ink-black)" }}
                >
                  {document.title.trim() || t.editor.untitled}
                </span>
                {document.updatedAt && (
                  <span
                    className="shrink-0 text-xs"
                    style={{ color: "var(--ink-faint)" }}
                  >
                    {new Date(document.updatedAt).toLocaleDateString(
                      DATE_LOCALE[locale],
                    )}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div
          className="mt-8 rounded-xl border border-dashed px-6 py-16 text-center"
          style={{
            borderColor: "var(--ink-line)",
            background: "var(--ink-wash)",
          }}
        >
          <FileText
            className="mx-auto h-10 w-10"
            style={{ color: "var(--ink-faint)" }}
          />
          <p className="mt-3 text-sm" style={{ color: "var(--ink-mid)" }}>
            {t.documentsPage.emptyHint}
            <Link
              to="/editor"
              className="font-medium hover:underline"
              style={{ color: "var(--cinnabar)" }}
            >
              {t.documentsPage.emptyLinkText}
            </Link>
          </p>
        </div>
      )}
    </PageContainer>
  );
}
