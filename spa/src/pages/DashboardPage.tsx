import { Link } from "@tanstack/react-router";
import { FileText, Plus, Clock, User as UserIcon } from "lucide-react";
import { useSession } from "../auth";
import { useDocumentList } from "../documents";
import { useI18n, interpolate, type Locale } from "../i18n";
import { PageContainer } from "../components/PageContainer";
import { PaperCard } from "../components/Ink";

const DATE_LOCALE: Record<Locale, string> = {
  en: "en-US",
  zh: "zh-CN",
  fr: "fr-FR",
  ja: "ja-JP",
};

export function DashboardPage() {
  const session = useSession();
  const { t, locale } = useI18n();
  // 必须在下面的提前 return 之前调用，否则违反 hooks 规则；
  // enabled 兜住未登录时不发请求。
  const docs = useDocumentList(Boolean(session.data?.user));

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

  const user = session.data?.user;
  if (!user) {
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

  const joinedAt = user.createdAt
    ? new Date(user.createdAt).toLocaleDateString(DATE_LOCALE[locale])
    : "—";
  const name = user.nickname || user.username || user.email;

  return (
    <PageContainer className="flex-1 py-10">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1
            className="kn-heading-cn text-2xl font-bold tracking-tight"
            style={{ color: "var(--ink-black)" }}
          >
            {interpolate(t.dashboard.greeting, { name })}
          </h1>
          {/* 朱砂短线：题款式的下划，比灰色副标题更有层次 */}
          <div
            className="mt-2 h-0.5 w-10 rounded-full"
            style={{ background: "var(--cinnabar)" }}
          />
          <p className="mt-2 text-sm" style={{ color: "var(--ink-mid)" }}>
            {t.dashboard.subtitle}
          </p>
        </div>
        <Link
          to="/editor"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
          style={{ background: "var(--cinnabar)" }}
        >
          <Plus className="h-4 w-4" />
          {t.dashboard.newDoc}
        </Link>
      </div>

      {/* 账户信息卡 */}
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <InfoCard
          icon={<UserIcon className="h-5 w-5" />}
          label={t.dashboard.account}
          value={user.email}
        />
        <InfoCard
          icon={<FileText className="h-5 w-5" />}
          label={t.dashboard.username}
          value={user.username || t.dashboard.notSet}
        />
        <InfoCard
          icon={<Clock className="h-5 w-5" />}
          label={t.dashboard.joinedAt}
          value={joinedAt}
        />
      </div>

      {/* 文档列表 */}
      <div className="mt-10">
        <h2
          className="kn-heading-cn text-sm font-semibold"
          style={{ color: "var(--ink-strong)" }}
        >
          {t.dashboard.myDocs}
        </h2>

        {docs.isLoading ? (
          <p className="mt-4 text-sm" style={{ color: "var(--ink-faint)" }}>
            {t.editor.loading}
          </p>
        ) : docs.data && docs.data.length > 0 ? (
          <ul
            className="mt-4 overflow-hidden rounded-xl border"
            style={{
              borderColor: "var(--ink-line)",
              background: "var(--ink-paper-soft)",
            }}
          >
            {docs.data.map((d, i) => (
              <li
                key={d.docId}
                // 分隔线画在 li 上而不是用 divide-y：divide 的颜色只吃 Tailwind 的
                // 调色板，写不进 var(--ink-line)
                style={
                  i > 0
                    ? { borderTop: "1px solid var(--ink-line)" }
                    : undefined
                }
              >
                <Link
                  to="/editor/$docId"
                  params={{ docId: d.docId }}
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
                    {d.title.trim() || t.editor.untitled}
                  </span>
                  {d.updatedAt && (
                    <span
                      className="shrink-0 text-xs"
                      style={{ color: "var(--ink-faint)" }}
                    >
                      {new Date(d.updatedAt).toLocaleDateString(DATE_LOCALE[locale])}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div
            className="mt-4 rounded-xl border border-dashed px-6 py-16 text-center"
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
              {t.dashboard.emptyHint}
              <Link
                to="/editor"
                className="font-medium hover:underline"
                style={{ color: "var(--cinnabar)" }}
              >
                {t.dashboard.emptyLinkText}
              </Link>
            </p>
          </div>
        )}
      </div>
    </PageContainer>
  );
}

function InfoCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <PaperCard className="p-5">
      <div className="flex items-center gap-2" style={{ color: "var(--ink-faint)" }}>
        {icon}
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p
        className="mt-2 truncate text-sm font-medium"
        style={{ color: "var(--ink-black)" }}
      >
        {value}
      </p>
    </PaperCard>
  );
}
