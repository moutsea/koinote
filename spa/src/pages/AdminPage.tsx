import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  BarChart3,
  CheckCircle2,
  Coins,
  Eye,
  FileText,
  HardDrive,
  Image,
  MousePointerClick,
  RefreshCw,
  ShieldCheck,
  ShoppingBag,
  UserCheck,
  Users,
  WifiOff,
} from "lucide-react";
import { getAdminStats, type AdminStats } from "../api";
import { useSession } from "../auth";
import { PaperCard } from "../components/Ink";
import { PageContainer } from "../components/PageContainer";
import { useI18n, interpolate, type Locale } from "../i18n";
import { formatBytes } from "../storage";

const DATE_LOCALE: Record<Locale, string> = {
  en: "en-US",
  zh: "zh-CN",
  fr: "fr-FR",
  ja: "ja-JP",
};

export function AdminPage() {
  const session = useSession();
  const { t, locale } = useI18n();
  const user = session.data?.user;
  const stats = useQuery({
    queryKey: ["admin-stats"],
    queryFn: getAdminStats,
    enabled: Boolean(user?.isAdmin),
    staleTime: 30_000,
    retry: false,
  });

  if (session.isLoading) {
    return <CenteredMessage>{t.admin.loading}</CenteredMessage>;
  }
  if (!user) {
    return (
      <CenteredMessage>
        <p>{t.admin.loginRequired}</p>
        <Link
          to="/login"
          className="mt-4 inline-flex rounded-full px-6 py-2.5 text-sm font-semibold text-white"
          style={{ background: "var(--cinnabar)" }}
        >
          {t.admin.goLogin}
        </Link>
      </CenteredMessage>
    );
  }
  if (!user.isAdmin) {
    return (
      <CenteredMessage>
        <ShieldCheck className="mx-auto mb-3 h-10 w-10" style={{ color: "var(--ink-faint)" }} />
        <p>{t.admin.forbidden}</p>
      </CenteredMessage>
    );
  }

  return (
    <PageContainer className="flex-1 py-8 sm:py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-6 w-6" style={{ color: "var(--cinnabar)" }} />
            <h1
              className="kn-heading-cn text-2xl font-bold tracking-tight"
              style={{ color: "var(--ink-black)" }}
            >
              {t.admin.title}
            </h1>
          </div>
          <p className="mt-2 text-sm" style={{ color: "var(--ink-mid)" }}>
            {t.admin.subtitle}
          </p>
        </div>
        <button
          type="button"
          disabled={stats.isFetching}
          onClick={() => void stats.refetch()}
          className="inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition hover:bg-[var(--ink-wash-strong)] disabled:opacity-50"
          style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
        >
          <RefreshCw className={`h-4 w-4 ${stats.isFetching ? "animate-spin" : ""}`} />
          {t.admin.refresh}
        </button>
      </div>

      {stats.isLoading ? (
        <CenteredMessage>{t.admin.loading}</CenteredMessage>
      ) : stats.isError || !stats.data ? (
        <PaperCard className="mt-8 p-8 text-center">
          <WifiOff className="mx-auto h-8 w-8" style={{ color: "var(--ink-faint)" }} />
          <p className="mt-3 text-sm" style={{ color: "var(--ink-mid)" }}>
            {t.admin.loadFailed}
          </p>
        </PaperCard>
      ) : (
        <AdminContent stats={stats.data} locale={locale} />
      )}
    </PageContainer>
  );
}

function AdminContent({ stats, locale }: { stats: AdminStats; locale: Locale }) {
  const { t } = useI18n();
  const totalStorage = stats.overview.documentBytes + stats.overview.imageBytes;
  const conversion = stats.overview.users
    ? stats.overview.members / stats.overview.users
    : 0;

  return (
    <div className="mt-8 space-y-10">
      <section>
        <SectionTitle icon={<Eye className="h-5 w-5" />} title={t.admin.today} />
        {stats.traffic.available ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard icon={<Eye />} label={t.admin.pageViews} value={formatNumber(stats.traffic.pageViews, locale)} />
            <MetricCard icon={<Users />} label={t.admin.uniqueVisitors} value={formatNumber(stats.traffic.uniqueVisitors, locale)} />
            <MetricCard icon={<MousePointerClick />} label={t.admin.requests} value={formatNumber(stats.traffic.requests, locale)} />
            <MetricCard icon={<HardDrive />} label={t.admin.bandwidth} value={formatBytes(stats.traffic.bytes, DATE_LOCALE[locale])} />
          </div>
        ) : (
          <PaperCard className="mt-4 flex items-start gap-3 p-4">
            <WifiOff className="mt-0.5 h-5 w-5 shrink-0" style={{ color: "var(--ink-faint)" }} />
            <div>
              <p className="text-sm font-medium" style={{ color: "var(--ink-strong)" }}>
                {t.admin.trafficUnavailable}
              </p>
              <p className="mt-1 text-xs" style={{ color: "var(--ink-faint)" }}>
                {stats.traffic.reason === "not_configured"
                  ? t.admin.trafficNotConfigured
                  : t.admin.trafficUpstreamError}
              </p>
            </div>
          </PaperCard>
        )}
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <MetricCard icon={<UserCheck />} label={t.admin.newUsers} value={formatNumber(stats.overview.todayNewUsers, locale)} />
          <MetricCard icon={<ShieldCheck />} label={t.admin.newMembers} value={formatNumber(stats.overview.todayNewMembers, locale)} />
          <MetricCard icon={<ShoppingBag />} label={t.admin.orders} value={formatNumber(stats.overview.todayOrders, locale)} />
        </div>
        <p className="mt-3 text-xs" style={{ color: "var(--ink-faint)" }}>
          {t.admin.trafficNote}
        </p>
      </section>

      <section>
        <SectionTitle icon={<BarChart3 className="h-5 w-5" />} title={t.admin.overview} />
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard icon={<Users />} label={t.admin.totalUsers} value={formatNumber(stats.overview.users, locale)} />
          <MetricCard icon={<CheckCircle2 />} label={t.admin.verifiedUsers} value={formatNumber(stats.overview.verifiedUsers, locale)} />
          <MetricCard icon={<ShieldCheck />} label={t.admin.lifetimeMembers} value={formatNumber(stats.overview.members, locale)} />
          <MetricCard icon={<BarChart3 />} label={t.admin.conversionRate} value={formatPercent(conversion, locale)} />
          <MetricCard icon={<FileText />} label={t.admin.documents} value={formatNumber(stats.overview.documents, locale)} />
          <MetricCard icon={<Image />} label={t.admin.images} value={formatNumber(stats.overview.images, locale)} />
          <MetricCard icon={<HardDrive />} label={t.admin.storageUsed} value={formatBytes(totalStorage, DATE_LOCALE[locale])} />
          <MetricCard icon={<ShoppingBag />} label={t.admin.totalOrders} value={formatNumber(stats.overview.orders, locale)} />
        </div>
      </section>

      <section>
        <SectionTitle icon={<Coins className="h-5 w-5" />} title={t.admin.revenue} />
        {stats.revenue.length === 0 ? (
          <EmptyCard>{t.admin.noRevenue}</EmptyCard>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {stats.revenue.map((item) => (
              <PaperCard key={item.currency} className="p-5">
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--ink-faint)" }}>
                  {item.currency}
                </p>
                <p className="mt-2 text-xl font-semibold" style={{ color: "var(--ink-black)" }}>
                  {formatMoney(item.totalAmount, item.currency, locale)}
                </p>
                <p className="mt-1 text-xs" style={{ color: "var(--ink-mid)" }}>
                  {interpolate(t.admin.orderCount, { count: formatNumber(item.totalOrders, locale) })}
                </p>
                <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--ink-line)" }}>
                  <p className="text-xs" style={{ color: "var(--ink-faint)" }}>{t.admin.todayRevenue}</p>
                  <p className="mt-1 text-sm font-medium" style={{ color: "var(--ink-strong)" }}>
                    {formatMoney(item.todayAmount, item.currency, locale)}
                  </p>
                </div>
              </PaperCard>
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionTitle icon={<BarChart3 className="h-5 w-5" />} title={t.admin.trend} />
        <p className="mt-1 text-xs" style={{ color: "var(--ink-faint)" }}>{t.admin.trendHint}</p>
        <TrendChart points={stats.trend} locale={locale} />
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <RecentUsers users={stats.recentUsers} locale={locale} />
        <RecentPayments payments={stats.recentPayments} locale={locale} />
      </div>

      <p className="text-right text-xs" style={{ color: "var(--ink-faint)" }}>
        {interpolate(t.admin.generatedAt, {
          time: formatDateTime(stats.generatedAt, locale),
          timeZone: stats.timeZone,
        })}
      </p>
    </div>
  );
}

function SectionTitle({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2" style={{ color: "var(--ink-strong)" }}>
      {icon}
      <h2 className="kn-heading-cn text-base font-semibold">{title}</h2>
    </div>
  );
}

function MetricCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <PaperCard className="p-4">
      <div className="flex items-center gap-2 text-xs font-medium" style={{ color: "var(--ink-faint)" }}>
        <span className="[&>svg]:h-4 [&>svg]:w-4">{icon}</span>
        {label}
      </div>
      <p className="mt-2 text-xl font-semibold" style={{ color: "var(--ink-black)" }}>{value}</p>
    </PaperCard>
  );
}

function TrendChart({ points, locale }: { points: AdminStats["trend"]; locale: Locale }) {
  const { t } = useI18n();
  const max = Math.max(1, ...points.flatMap((point) => [point.newUsers, point.newMembers, point.orders]));
  return (
    <PaperCard className="mt-4 overflow-x-auto p-5">
      <div className="mb-4 flex flex-wrap gap-4 text-xs" style={{ color: "var(--ink-mid)" }}>
        <Legend color="var(--ink-strong)" label={t.admin.newUsers} />
        <Legend color="var(--cinnabar)" label={t.admin.newMembers} />
        <Legend color="var(--ink-faint)" label={t.admin.orders} />
      </div>
      <div className="flex h-44 min-w-[760px] items-end gap-1.5 border-b" style={{ borderColor: "var(--ink-line)" }}>
        {points.map((point, index) => (
          <div
            key={point.date}
            className="group relative flex h-full min-w-4 flex-1 items-end justify-center gap-px"
            title={`${formatDay(point.date, locale)} · ${t.admin.newUsers} ${point.newUsers} · ${t.admin.newMembers} ${point.newMembers} · ${t.admin.orders} ${point.orders}`}
          >
            <TrendBar value={point.newUsers} max={max} color="var(--ink-strong)" />
            <TrendBar value={point.newMembers} max={max} color="var(--cinnabar)" />
            <TrendBar value={point.orders} max={max} color="var(--ink-faint)" />
            {(index % 5 === 0 || index === points.length - 1) && (
              <span className="absolute -bottom-5 whitespace-nowrap text-[10px]" style={{ color: "var(--ink-faint)" }}>
                {formatShortDay(point.date, locale)}
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="h-5" />
    </PaperCard>
  );
}

function TrendBar({ value, max, color }: { value: number; max: number; color: string }) {
  const height = value === 0 ? 2 : Math.max(5, (value / max) * 100);
  return <span className="w-1.5 rounded-t-sm" style={{ height: `${height}%`, background: color, opacity: value === 0 ? 0.18 : 0.85 }} />;
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />{label}</span>;
}

function RecentUsers({ users, locale }: { users: AdminStats["recentUsers"]; locale: Locale }) {
  const { t } = useI18n();
  return (
    <section className="min-w-0">
      <SectionTitle icon={<Users className="h-5 w-5" />} title={t.admin.recentUsers} />
      {users.length === 0 ? <EmptyCard>{t.admin.noUsers}</EmptyCard> : (
        <PaperCard className="mt-4 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[540px] text-left text-sm">
              <thead style={{ background: "var(--ink-wash)", color: "var(--ink-faint)" }}>
                <tr><TableHead>{t.admin.user}</TableHead><TableHead>{t.admin.status}</TableHead><TableHead>{t.admin.joinedAt}</TableHead></tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className="border-t" style={{ borderColor: "var(--ink-line)" }}>
                    <TableCell><p className="font-medium" style={{ color: "var(--ink-black)" }}>{user.name}</p><p className="mt-0.5 text-xs" style={{ color: "var(--ink-faint)" }}>{user.email}</p></TableCell>
                    <TableCell><StatusBadge active={user.membershipTier === "lifetime"} label={user.membershipTier === "lifetime" ? t.admin.lifetime : t.admin.free} /><p className="mt-1 text-xs" style={{ color: "var(--ink-faint)" }}>{user.isVerified ? t.admin.verified : t.admin.unverified}</p></TableCell>
                    <TableCell>{formatDateTime(user.createdAt, locale)}</TableCell>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PaperCard>
      )}
    </section>
  );
}

function RecentPayments({ payments, locale }: { payments: AdminStats["recentPayments"]; locale: Locale }) {
  const { t } = useI18n();
  return (
    <section className="min-w-0">
      <SectionTitle icon={<Coins className="h-5 w-5" />} title={t.admin.recentPayments} />
      {payments.length === 0 ? <EmptyCard>{t.admin.noPayments}</EmptyCard> : (
        <PaperCard className="mt-4 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[540px] text-left text-sm">
              <thead style={{ background: "var(--ink-wash)", color: "var(--ink-faint)" }}>
                <tr><TableHead>{t.admin.user}</TableHead><TableHead>{t.admin.amount}</TableHead><TableHead>{t.admin.paidAt}</TableHead></tr>
              </thead>
              <tbody>
                {payments.map((payment, index) => (
                  <tr key={`${payment.userEmail}-${payment.createdAt}-${index}`} className="border-t" style={{ borderColor: "var(--ink-line)" }}>
                    <TableCell><p className="font-medium" style={{ color: "var(--ink-black)" }}>{payment.userName}</p><p className="mt-0.5 text-xs" style={{ color: "var(--ink-faint)" }}>{payment.userEmail}</p></TableCell>
                    <TableCell><span className="font-semibold" style={{ color: "var(--cinnabar)" }}>{formatMoney(payment.amount, payment.currency, locale)}</span></TableCell>
                    <TableCell>{formatDateTime(payment.createdAt, locale)}</TableCell>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PaperCard>
      )}
    </section>
  );
}

function TableHead({ children }: { children: ReactNode }) { return <th className="px-4 py-3 text-xs font-semibold">{children}</th>; }
function TableCell({ children }: { children: ReactNode }) { return <td className="px-4 py-3 align-middle" style={{ color: "var(--ink-mid)" }}>{children}</td>; }

function StatusBadge({ active, label }: { active: boolean; label: string }) {
  return <span className="inline-flex rounded-full px-2 py-0.5 text-xs font-semibold" style={{ background: active ? "var(--cinnabar-soft)" : "var(--ink-wash-strong)", color: active ? "var(--cinnabar)" : "var(--ink-mid)" }}>{label}</span>;
}

function EmptyCard({ children }: { children: ReactNode }) { return <PaperCard className="mt-4 p-8 text-center text-sm"><span style={{ color: "var(--ink-faint)" }}>{children}</span></PaperCard>; }
function CenteredMessage({ children }: { children: ReactNode }) { return <div className="flex flex-1 flex-col items-center justify-center px-4 py-24 text-center text-sm" style={{ color: "var(--ink-mid)" }}>{children}</div>; }

function formatNumber(value: number, locale: Locale) { return new Intl.NumberFormat(DATE_LOCALE[locale]).format(value); }
function formatPercent(value: number, locale: Locale) { return new Intl.NumberFormat(DATE_LOCALE[locale], { style: "percent", maximumFractionDigits: 1 }).format(value); }
function formatMoney(amount: number, currency: string, locale: Locale) {
  try {
    return new Intl.NumberFormat(DATE_LOCALE[locale], { style: "currency", currency: currency.toUpperCase() }).format(amount / (currency.toLowerCase() === "jpy" ? 1 : 100));
  } catch {
    return `${currency.toUpperCase()} ${amount}`;
  }
}
function parseAdminDate(value: string) { return new Date(value.includes("T") ? value : `${value}T00:00:00`); }
function formatDateTime(value: string, locale: Locale) { return parseAdminDate(value).toLocaleString(DATE_LOCALE[locale], { dateStyle: "medium", timeStyle: "short" }); }
function formatDay(value: string, locale: Locale) { return parseAdminDate(value).toLocaleDateString(DATE_LOCALE[locale], { month: "short", day: "numeric" }); }
function formatShortDay(value: string, locale: Locale) { return parseAdminDate(value).toLocaleDateString(DATE_LOCALE[locale], { month: "numeric", day: "numeric" }); }
