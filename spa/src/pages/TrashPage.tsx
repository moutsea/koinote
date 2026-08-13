import { Link } from "@tanstack/react-router";
import { FileText, RotateCcw, Trash2 } from "lucide-react";
import { useSession } from "../auth";
import {
  usePermanentlyDeleteDocument,
  useRestoreTrashedDocument,
  useTrashedDocumentList,
} from "../documents";
import { interpolate, useI18n, type Locale } from "../i18n";
import { PageContainer } from "../components/PageContainer";

const DATE_LOCALE: Record<Locale, string> = {
  en: "en-US",
  zh: "zh-CN",
  fr: "fr-FR",
  ja: "ja-JP",
};

export function TrashPage() {
  const session = useSession();
  const { t, locale } = useI18n();
  const documents = useTrashedDocumentList(Boolean(session.data?.user));
  const restore = useRestoreTrashedDocument();
  const purge = usePermanentlyDeleteDocument();

  if (session.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center py-24 text-sm">
        {t.dashboard.loading}
      </div>
    );
  }
  if (!session.data?.user) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-24 text-center">
        <p className="kn-heading-cn text-lg font-medium">
          {t.dashboard.loginRequired}
        </p>
        <Link
          to="/login"
          className="rounded-full px-6 py-2.5 text-sm font-semibold text-white"
          style={{ background: "var(--cinnabar)" }}
        >
          {t.dashboard.goLogin}
        </Link>
      </div>
    );
  }

  function permanentlyDelete(docId: string, title: string) {
    if (!window.confirm(t.trashPage.permanentWarning)) return;
    const expected = title || "DELETE";
    const confirmation = window.prompt(
      interpolate(t.trashPage.typeToConfirm, { title: expected }),
    );
    if (confirmation === null) return;
    purge.mutate({ docId, confirmation });
  }

  return (
    <PageContainer className="flex-1 py-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="kn-heading-cn text-2xl font-bold tracking-tight">
            {t.trashPage.title}
          </h1>
          <div
            className="mt-2 h-0.5 w-10 rounded-full"
            style={{ background: "var(--cinnabar)" }}
          />
          <p className="mt-2 text-sm" style={{ color: "var(--ink-mid)" }}>
            {t.trashPage.subtitle}
          </p>
        </div>
        <Link
          to="/documents"
          className="rounded-full border px-4 py-2 text-sm"
          style={{ borderColor: "var(--ink-line)" }}
        >
          {t.trashPage.backToDocuments}
        </Link>
      </div>

      {documents.isLoading ? (
        <p className="mt-8 text-sm">{t.editor.loading}</p>
      ) : documents.isError ? (
        <p className="mt-8 text-sm" style={{ color: "var(--cinnabar)" }}>
          {t.trashPage.loadFailed}
        </p>
      ) : documents.data?.length ? (
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
              className="flex items-center gap-3 px-5 py-3.5"
              style={
                index ? { borderTop: "1px solid var(--ink-line)" } : undefined
              }
            >
              <FileText
                className="h-4 w-4 shrink-0"
                style={{ color: "var(--ink-faint)" }}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {document.title.trim() || t.editor.untitled}
                </p>
                <p
                  className="mt-0.5 text-xs"
                  style={{ color: "var(--ink-faint)" }}
                >
                  {interpolate(t.trashPage.deletesOn, {
                    date: new Date(document.deletesAt).toLocaleDateString(
                      DATE_LOCALE[locale],
                    ),
                  })}
                </p>
              </div>
              <button
                type="button"
                onClick={() => restore.mutate(document.docId)}
                disabled={restore.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm transition hover:bg-[var(--ink-wash-strong)]"
              >
                <RotateCcw className="h-4 w-4" />
                {t.trashPage.restore}
              </button>
              <button
                type="button"
                onClick={() =>
                  permanentlyDelete(document.docId, document.title)
                }
                disabled={purge.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm transition hover:bg-red-50"
                style={{ color: "var(--cinnabar)" }}
              >
                <Trash2 className="h-4 w-4" />
                {t.trashPage.deletePermanently}
              </button>
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
          <Trash2
            className="mx-auto h-10 w-10"
            style={{ color: "var(--ink-faint)" }}
          />
          <p className="mt-3 text-sm" style={{ color: "var(--ink-mid)" }}>
            {t.trashPage.empty}
          </p>
        </div>
      )}

      {(restore.isError || purge.isError) && (
        <p className="mt-4 text-sm" style={{ color: "var(--cinnabar)" }}>
          {t.trashPage.actionFailed}
        </p>
      )}
    </PageContainer>
  );
}
