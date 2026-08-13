import { Link } from "@tanstack/react-router";
import { Plus, Clock, User as UserIcon } from "lucide-react";
import { useSession } from "../auth";
import { useI18n, interpolate, type Locale } from "../i18n";
import { PageContainer } from "../components/PageContainer";
import { PaperCard } from "../components/Ink";
import { StorageCard } from "../components/StorageCard";
import { MembershipCard } from "../components/MembershipCard";
import { MCPAccessCard } from "../components/MCPAccessCard";
import { DocumentHistorySettingsCard } from "../components/DocumentHistorySettingsCard";

const DATE_LOCALE: Record<Locale, string> = {
  en: "en-US",
  zh: "zh-CN",
  fr: "fr-FR",
  ja: "ja-JP",
};

export function DashboardPage() {
  const session = useSession();
  const { t, locale } = useI18n();

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
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <InfoCard
          icon={<UserIcon className="h-5 w-5" />}
          label={t.dashboard.account}
          value={user.email}
        />
        <InfoCard
          icon={<Clock className="h-5 w-5" />}
          label={t.dashboard.joinedAt}
          value={joinedAt}
        />
      </div>

      {/* 图床用量。单独一行而不是挤进上面那三张卡：它有进度条和可能出现的警示文字，
          高度和那三张不一致，并排会让整行参差 */}
      <div className="mt-4">
        <StorageCard />
      </div>

      <div id="membership" className="mt-4 scroll-mt-20">
        <MembershipCard user={user} />
      </div>

      <div id="history-settings" className="mt-4 scroll-mt-20">
        <DocumentHistorySettingsCard user={user} />
      </div>

      <div id="mcp" className="mt-4 scroll-mt-20">
        <MCPAccessCard user={user} />
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
