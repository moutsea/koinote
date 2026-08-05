import { Link } from "@tanstack/react-router";
import { FileText, Plus, Clock, User as UserIcon } from "lucide-react";
import { useSession } from "../auth";
import { useDocumentList } from "../documents";
import { useI18n, interpolate, type Locale } from "../i18n";

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
      <div className="flex flex-1 items-center justify-center py-24 text-neutral-400">
        {t.dashboard.loading}
      </div>
    );
  }

  const user = session.data?.user;
  if (!user) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-24 text-center">
        <p className="text-lg font-medium">{t.dashboard.loginRequired}</p>
        <p className="text-sm text-neutral-500">{t.dashboard.loginRequiredHint}</p>
        <Link
          to="/login"
          className="rounded-full bg-sky-600 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-500"
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
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {interpolate(t.dashboard.greeting, { name })}
          </h1>
          <p className="mt-1 text-sm text-neutral-500">{t.dashboard.subtitle}</p>
        </div>
        <Link
          to="/editor"
          className="inline-flex items-center gap-1.5 rounded-full bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-500"
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
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
          {t.dashboard.myDocs}
        </h2>

        {docs.isLoading ? (
          <p className="mt-4 text-sm text-neutral-400">{t.editor.loading}</p>
        ) : docs.data && docs.data.length > 0 ? (
          <ul className="mt-4 divide-y divide-black/5 overflow-hidden rounded-2xl border border-black/5 bg-white/60 dark:divide-white/10 dark:border-white/10 dark:bg-white/5">
            {docs.data.map((d) => (
              <li key={d.docId}>
                <Link
                  to="/editor/$docId"
                  params={{ docId: d.docId }}
                  className="flex items-center gap-3 px-5 py-3.5 transition hover:bg-black/5 dark:hover:bg-white/10"
                >
                  <FileText className="h-4 w-4 shrink-0 text-neutral-400" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {d.title.trim() || t.editor.untitled}
                  </span>
                  {d.updatedAt && (
                    <span className="shrink-0 text-xs text-neutral-400">
                      {new Date(d.updatedAt).toLocaleDateString(DATE_LOCALE[locale])}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-4 rounded-2xl border border-dashed border-black/10 bg-white/40 px-6 py-16 text-center dark:border-white/15 dark:bg-white/5">
            <FileText className="mx-auto h-10 w-10 text-neutral-300 dark:text-neutral-600" />
            <p className="mt-3 text-sm text-neutral-500">
              {t.dashboard.emptyHint}
              <Link to="/editor" className="font-medium text-sky-600 hover:underline">
                {t.dashboard.emptyLinkText}
              </Link>
            </p>
          </div>
        )}
      </div>
    </div>
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
    <div className="rounded-2xl border border-black/5 bg-white/60 p-5 dark:border-white/10 dark:bg-white/5">
      <div className="flex items-center gap-2 text-neutral-400">
        {icon}
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-2 truncate text-sm font-medium">{value}</p>
    </div>
  );
}
