import { Link } from "@tanstack/react-router";
import { FileText, Plus, Trash2 } from "lucide-react";
import { useSession } from "../auth";
import { useDocumentList } from "../documents";
import { useI18n, type Locale } from "../i18n";
import { PageContainer } from "../components/PageContainer";

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
