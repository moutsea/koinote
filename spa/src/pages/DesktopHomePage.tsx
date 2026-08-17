import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  CloudOff,
  Clock3,
  FilePlus2,
  Files,
  HardDrive,
  Laptop,
  LoaderCircle,
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useSession } from "../auth";
import { DesktopSyncStatus } from "../components/DesktopSyncStatus";
import { DesktopLocalImportCard } from "../components/DesktopLocalImportCard";
import { PaperCard } from "../components/Ink";
import { PageContainer } from "../components/PageContainer";
import { useCreateDocument, useDocumentList } from "../documents";
import {
  getImportErrorMessage,
  importDocumentsFromFiles,
} from "../documentTransfer";
import { IMPORT_FILE_ACCEPT } from "../documentTransferCore";
import {
  desktopClearRemoteImageCache,
  desktopImageCacheSummary,
  desktopSyncEventName,
  type DesktopImageCacheSummary,
} from "../desktop/offlineStore";
import { interpolate, type Locale, useI18n } from "../i18n";
import { formatBytes } from "../storage";
import { DesktopLoginPage } from "./DesktopLoginPage";

const DATE_LOCALE: Record<Locale, string> = {
  en: "en-US",
  zh: "zh-CN",
  fr: "fr-FR",
  ja: "ja-JP",
};

export function DesktopHomePage() {
  const session = useSession();
  const user = session.data?.user;
  const localMode = Boolean(user?.isLocalMode);
  const documents = useDocumentList(Boolean(user));
  const create = useCreateDocument();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { locale, t } = useI18n();
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  const [importNotice, setImportNotice] = useState<{ error: boolean; message: string } | null>(null);
  const [imageCache, setImageCache] = useState<DesktopImageCacheSummary | null>(null);
  const [clearingImageCache, setClearingImageCache] = useState(false);
  const [imageCacheNotice, setImageCacheNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const refresh = () => {
      void desktopImageCacheSummary().then(setImageCache).catch(() => undefined);
    };
    const eventName = desktopSyncEventName();
    refresh();
    window.addEventListener(eventName, refresh);
    return () => window.removeEventListener(eventName, refresh);
  }, [user]);

  useEffect(() => {
    if (!importNotice) return;
    const timer = window.setTimeout(() => setImportNotice(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [importNotice]);

  if (session.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center py-24" style={{ color: "var(--ink-faint)" }}>
        <LoaderCircle className="h-5 w-5 animate-spin" aria-label={t.dashboard.loading} />
      </div>
    );
  }

  if (!user) return <DesktopLoginPage />;

  const allDocuments = documents.data ?? [];
  const continueDocument = allDocuments[0];
  const recentDocuments = allDocuments.slice(1, 6);
  const displayName = localMode
    ? t.desktopLocalMode.badge
    : user.nickname || user.username || user.email;

  function createDocument() {
    create.mutate(undefined, {
      onSuccess: ({ document }) => {
        void navigate({
          to: "/editor/$docId",
          params: { docId: document.docId },
        });
      },
    });
  }

  async function importDocuments(files: File[]) {
    if (files.length === 0) return;
    setImporting(true);
    setImportNotice(null);
    try {
      const result = await importDocumentsFromFiles(files);
      const success = interpolate(t.transfer.importSuccess, {
        count: result.imported,
      });
      const gifNotice = result.flattenedGifCount
        ? ` ${interpolate(t.transfer.importGifFlattened, {
            count: result.flattenedGifCount,
          })}`
        : "";
      setImportNotice({
        error: false,
        message: `${success}${gifNotice}`,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["documents"] }),
        queryClient.invalidateQueries({ queryKey: ["folders"] }),
        queryClient.invalidateQueries({ queryKey: ["storage-usage"] }),
      ]);
    } catch (error) {
      setImportNotice({
        error: true,
        message: getImportErrorMessage(error, t.transfer),
      });
    } finally {
      setImporting(false);
    }
  }

  async function clearImageCache() {
    setClearingImageCache(true);
    setImageCacheNotice(null);
    try {
      setImageCache(await desktopClearRemoteImageCache());
      setImageCacheNotice(t.desktopHome.imageCacheCleared);
    } catch {
      setImageCacheNotice(t.desktopSync.error);
    } finally {
      setClearingImageCache(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col" style={{ background: "var(--ink-paper)" }}>
      <PageContainer className="flex-1 py-8 sm:py-10">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p
              className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em]"
              style={{ color: "var(--ink-faint)" }}
            >
              <Laptop className="h-4 w-4" />
              {t.desktopHome.eyebrow}
            </p>
            <h1 className="kn-heading-cn mt-3 text-3xl font-bold tracking-tight" style={{ color: "var(--ink-black)" }}>
              {interpolate(t.desktopHome.welcome, { name: displayName })}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
              {localMode ? t.desktopLocalMode.localSubtitle : t.desktopHome.subtitle}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={importInputRef}
              type="file"
              accept={IMPORT_FILE_ACCEPT}
              multiple
              className="hidden"
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = "";
                void importDocuments(files);
              }}
            />
            <button
              type="button"
              disabled={importing}
              onClick={() => importInputRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition hover:bg-[var(--ink-wash-strong)] disabled:opacity-60"
              style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
            >
              {importing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {t.desktopHome.importDocuments}
            </button>
            <button
              type="button"
              disabled={create.isPending}
              onClick={createDocument}
              className="inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
              style={{ background: "var(--cinnabar)" }}
            >
              {create.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FilePlus2 className="h-4 w-4" />}
              {t.desktopHome.newDocument}
            </button>
          </div>
        </div>

        {create.isError && (
          <p className="mt-4 text-sm" role="alert" style={{ color: "var(--cinnabar)" }}>
            {t.desktopHome.createFailed}
          </p>
        )}
        {importNotice && (
          <p
            className="mt-4 text-sm"
            role={importNotice.error ? "alert" : "status"}
            style={{ color: importNotice.error ? "var(--cinnabar)" : "var(--ink-mid)" }}
          >
            {importNotice.message}
          </p>
        )}

        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-6">
            {documents.isLoading ? (
              <PaperCard className="flex min-h-52 items-center justify-center p-8">
                <LoaderCircle className="h-5 w-5 animate-spin" style={{ color: "var(--ink-faint)" }} />
              </PaperCard>
            ) : documents.isError ? (
              <PaperCard className="p-8 text-center">
                <p className="text-sm" style={{ color: "var(--cinnabar)" }}>{t.desktopHome.loadFailed}</p>
              </PaperCard>
            ) : continueDocument ? (
              <>
                <section aria-labelledby="desktop-continue-title">
                  <div className="mb-3 flex items-center justify-between gap-4">
                    <h2 id="desktop-continue-title" className="kn-heading-cn text-lg font-semibold">
                      {t.desktopHome.continueTitle}
                    </h2>
                    <Link to="/documents" className="text-xs font-medium hover:underline" style={{ color: "var(--ink-mid)" }}>
                      {t.desktopHome.allDocuments}
                    </Link>
                  </div>
                  <Link
                    to="/editor/$docId"
                    params={{ docId: continueDocument.docId }}
                    className="group flex items-center gap-4 rounded-xl border p-5 transition hover:bg-[var(--ink-wash)]"
                    style={{ borderColor: "var(--ink-line)", background: "var(--ink-paper-soft)" }}
                  >
                    <span
                      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl"
                      style={{ background: "var(--ink-wash-strong)", color: "var(--ink-strong)" }}
                    >
                      <Files className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold" style={{ color: "var(--ink-black)" }}>
                        {continueDocument.title.trim() || t.editor.untitled}
                      </span>
                      <span className="mt-1 flex items-center gap-1.5 text-xs" style={{ color: "var(--ink-faint)" }}>
                        <Clock3 className="h-3.5 w-3.5" />
                        {formatUpdatedAt(continueDocument.updatedAt, locale, t.desktopHome.updated)}
                      </span>
                    </span>
                    <ArrowRight className="h-5 w-5 shrink-0 transition group-hover:translate-x-0.5" style={{ color: "var(--ink-faint)" }} />
                  </Link>
                </section>

                {recentDocuments.length > 0 && (
                  <section aria-labelledby="desktop-recent-title">
                    <h2 id="desktop-recent-title" className="kn-heading-cn mb-3 text-lg font-semibold">
                      {t.desktopHome.recentTitle}
                    </h2>
                    <ul className="overflow-hidden rounded-xl border" style={{ borderColor: "var(--ink-line)", background: "var(--ink-paper-soft)" }}>
                      {recentDocuments.map((document, index) => (
                        <li key={document.docId} style={index > 0 ? { borderTop: "1px solid var(--ink-line)" } : undefined}>
                          <Link
                            to="/editor/$docId"
                            params={{ docId: document.docId }}
                            className="flex items-center gap-3 px-4 py-3.5 transition hover:bg-[var(--ink-wash)]"
                          >
                            <Files className="h-4 w-4 shrink-0" style={{ color: "var(--ink-faint)" }} />
                            <span className="min-w-0 flex-1 truncate text-sm font-medium" style={{ color: "var(--ink-black)" }}>
                              {document.title.trim() || t.editor.untitled}
                            </span>
                            <span className="shrink-0 text-xs" style={{ color: "var(--ink-faint)" }}>
                              {formatDate(document.updatedAt, locale)}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </>
            ) : (
              <PaperCard className="border-dashed px-6 py-14 text-center">
                <FilePlus2 className="mx-auto h-10 w-10" style={{ color: "var(--ink-faint)" }} />
                <h2 className="kn-heading-cn mt-4 text-xl font-semibold">{t.desktopHome.emptyTitle}</h2>
                <p className="mx-auto mt-2 max-w-md text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
                  {t.desktopHome.emptyDescription}
                </p>
                <button
                  type="button"
                  disabled={create.isPending}
                  onClick={createDocument}
                  className="mt-5 rounded-lg px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
                  style={{ background: "var(--cinnabar)" }}
                >
                  {t.desktopHome.newDocument}
                </button>
              </PaperCard>
            )}
          </div>

          <aside className="space-y-4">
            {localMode ? (
              <PaperCard className="p-5">
                <CloudOff className="h-5 w-5" style={{ color: "var(--ink-mid)" }} />
                <h2 className="kn-heading-cn mt-3 font-semibold">{t.desktopLocalMode.localStorageTitle}</h2>
                <p className="mt-2 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
                  {t.desktopLocalMode.localStorageDescription}
                </p>
                <p className="mt-3 text-xs leading-5" style={{ color: "var(--ink-faint)" }}>
                  {t.desktopLocalMode.encrypted}
                </p>
              </PaperCard>
            ) : (
              <PaperCard className="p-5">
                <h2 className="kn-heading-cn font-semibold">{t.desktopHome.syncTitle}</h2>
                <p className="mt-2 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
                  {t.desktopHome.syncDescription}
                </p>
                <div className="mt-4">
                  <DesktopSyncStatus variant="panel" />
                </div>
              </PaperCard>
            )}

            <PaperCard className="p-5">
              <HardDrive className="h-5 w-5" style={{ color: "var(--ink-mid)" }} />
              <h2 className="kn-heading-cn mt-3 font-semibold">
                {localMode ? t.desktopLocalMode.badge : t.desktopHome.offlineTitle}
              </h2>
              <p className="mt-2 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
                {localMode
                  ? t.desktopLocalMode.networkDisabled
                  : t.desktopHome.offlineDescription}
              </p>
              {!documents.isLoading && !documents.isError && (
                <div className="mt-4 space-y-3 border-t pt-4" style={{ borderColor: "var(--ink-line)" }}>
                  <p className="text-xs font-medium" style={{ color: "var(--ink-faint)" }}>
                    {interpolate(t.desktopHome.documentCount, { count: allDocuments.length })}
                  </p>
                  {imageCache && !localMode && (
                    <>
                      <p className="text-xs" style={{ color: "var(--ink-faint)" }}>
                        {interpolate(t.desktopHome.imageCacheUsage, {
                          total: formatBytes(imageCache.usedBytes, DATE_LOCALE[locale]),
                          cached: formatBytes(imageCache.remoteCacheBytes, DATE_LOCALE[locale]),
                          limit: formatBytes(imageCache.remoteCacheLimitBytes, DATE_LOCALE[locale]),
                          pending: formatBytes(imageCache.pendingLocalBytes, DATE_LOCALE[locale]),
                        })}
                      </p>
                      {imageCache.maintenanceIssue && (
                        <p className="text-xs leading-5" role="status" style={{ color: "var(--cinnabar)" }}>
                          {t.desktopHome.imageMaintenanceDelayed}
                        </p>
                      )}
                    </>
                  )}
                  {!localMode && (
                    <button
                      type="button"
                      disabled={clearingImageCache}
                      onClick={() => void clearImageCache()}
                      className="text-xs font-medium hover:underline disabled:opacity-60"
                      style={{ color: "var(--ink-mid)" }}
                    >
                      {clearingImageCache
                        ? t.desktopHome.clearingImageCache
                        : t.desktopHome.clearImageCache}
                    </button>
                  )}
                  {imageCacheNotice && (
                    <p className="text-xs leading-5" role="status" style={{ color: "var(--ink-mid)" }}>
                      {imageCacheNotice}
                    </p>
                  )}
                </div>
              )}
            </PaperCard>
            {!localMode && <DesktopLocalImportCard />}
          </aside>
        </div>
      </PageContainer>
    </div>
  );
}

function formatDate(value: string | null | undefined, locale: Locale): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(DATE_LOCALE[locale], {
    month: "short",
    day: "numeric",
  });
}

function formatUpdatedAt(
  value: string | null | undefined,
  locale: Locale,
  template: string,
): string {
  const formatted = formatDate(value, locale);
  return formatted === "—" ? template.replace("{date}", "—") : interpolate(template, { date: formatted });
}
