import {
  Link,
  useNavigate,
  useRouterState,
  useSearch,
} from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import {
  Bot,
  ChevronRight,
  Clock,
  Crown,
  ExternalLink,
  Gift,
  KeyRound,
  LockKeyhole,
  Settings,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import type { User } from "../api";
import { useSession } from "../auth";
import { AccountDeletionCard } from "../components/AccountDeletionCard";
import { AgentCreditsCard } from "../components/AgentCreditsCard";
import { AgentModelSettingsCard } from "../components/AgentModelSettingsCard";
import { Avatar } from "../components/Avatar";
import { DocumentHistorySettingsCard } from "../components/DocumentHistorySettingsCard";
import { InvitationCard } from "../components/InvitationCard";
import { PaperCard } from "../components/Ink";
import { LLMChannelsCard } from "../components/LLMChannelsCard";
import { MCPAccessCard } from "../components/MCPAccessCard";
import { MembershipCard } from "../components/MembershipCard";
import { PageContainer } from "../components/PageContainer";
import { PasswordSecurityCard } from "../components/PasswordSecurityCard";
import { StorageCard } from "../components/StorageCard";
import { isDesktopRuntime } from "../desktop/runtime";
import { openKoinoteWebPath } from "../externalNavigation";
import { useI18n, type Locale } from "../i18n";

type SettingsSection = "general" | "membership" | "ai" | "invitations";

const DATE_LOCALE: Record<Locale, string> = {
  en: "en-US",
  zh: "zh-CN",
  fr: "fr-FR",
  ja: "ja-JP",
};

export function SettingsPage() {
  const session = useSession();
  const search = useSearch({ strict: false }) as { section?: SettingsSection };
  const { t } = useI18n();

  if (session.isLoading) {
    return <SettingsLoading />;
  }

  const user = session.data?.user;
  if (!user) {
    return <SettingsLoginRequired />;
  }

  const section = search.section ?? "general";
  const sections: Array<{
    id: SettingsSection;
    label: string;
    description: string;
    icon: ReactNode;
  }> = [
    {
      id: "general",
      label: t.settingsPage.general,
      description: t.settingsPage.generalDescription,
      icon: <UserRound className="h-4 w-4" />,
    },
    {
      id: "membership",
      label: t.settingsPage.membership,
      description: t.settingsPage.membershipDescription,
      icon: <Crown className="h-4 w-4" />,
    },
    {
      id: "ai",
      label: t.settingsPage.ai,
      description: t.settingsPage.aiDescription,
      icon: user.membershipTier === "lifetime" ? (
        <Bot className="h-4 w-4" />
      ) : (
        <LockKeyhole className="h-4 w-4" />
      ),
    },
    {
      id: "invitations",
      label: t.settingsPage.invitations,
      description: t.settingsPage.invitationsDescription,
      icon: <Gift className="h-4 w-4" />,
    },
  ];
  const activeSection = sections.find((item) => item.id === section) ?? sections[0];

  return (
    <PageContainer className="flex-1 py-8 sm:py-10">
      <header className="flex items-start gap-3">
        <span
          className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
          style={{ background: "var(--ink-wash)", color: "var(--ink-strong)" }}
        >
          <Settings className="h-5 w-5" />
        </span>
        <div>
          <h1
            className="kn-heading-cn text-2xl font-bold tracking-tight"
            style={{ color: "var(--ink-black)" }}
          >
            {t.settingsPage.title}
          </h1>
          <p className="mt-1.5 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
            {t.settingsPage.subtitle}
          </p>
        </div>
      </header>

      <div className="mt-8 grid min-w-0 gap-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-8">
        <aside className="min-w-0">
          <nav
            aria-label={t.settingsPage.title}
            className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:sticky lg:top-20 lg:flex lg:flex-col"
          >
            {sections.map((item) => {
              const active = item.id === section;
              return (
                <Link
                  key={item.id}
                  to="/settings"
                  search={{ section: item.id }}
                  aria-current={active ? "page" : undefined}
                  className="group flex min-w-0 items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm transition"
                  style={{
                    background: active ? "var(--ink-wash-strong)" : "transparent",
                    color: active ? "var(--ink-black)" : "var(--ink-mid)",
                    fontWeight: active ? 600 : undefined,
                  }}
                >
                  <span style={{ color: active ? "var(--cinnabar)" : "var(--ink-faint)" }}>
                    {item.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  <ChevronRight
                    className="hidden h-3.5 w-3.5 lg:block"
                    style={{ color: active ? "var(--ink-mid)" : "transparent" }}
                  />
                </Link>
              );
            })}
          </nav>
        </aside>

        <section className="min-w-0">
          <SettingsSectionHeader
            title={activeSection.label}
            description={activeSection.description}
          />
          <div className="mt-5">
            <SettingsSectionContent section={section} user={user} />
          </div>
        </section>
      </div>
    </PageContainer>
  );
}

function SettingsSectionContent({
  section,
  user,
}: {
  section: SettingsSection;
  user: User;
}) {
  if (section === "general") {
    return (
      <div className="space-y-4">
        <AccountOverviewCard user={user} />
        <div id="security" className="scroll-mt-20">
          {isDesktopRuntime() ? (
            <DesktopSecurityCard />
          ) : (
            <PasswordSecurityCard user={user} />
          )}
        </div>
        <div id="delete-account" className="scroll-mt-20">
          <AccountDeletionCard user={user} />
        </div>
      </div>
    );
  }

  if (section === "membership") {
    return (
      <div className="space-y-4">
        <div id="membership" className="scroll-mt-20">
          <MembershipCard user={user} />
        </div>
        <StorageCard />
        <div id="history-settings" className="scroll-mt-20">
          <DocumentHistorySettingsCard user={user} />
        </div>
      </div>
    );
  }

  if (section === "ai") {
    if (user.membershipTier !== "lifetime") {
      return <AIUpgradeCard />;
    }
    return (
      <div className="space-y-4">
        <div id="agent-model" className="scroll-mt-20">
          <AgentModelSettingsCard user={user} />
        </div>
        <div id="llm-channels" className="scroll-mt-20">
          <LLMChannelsCard user={user} />
        </div>
        <div id="mcp" className="scroll-mt-20">
          <MCPAccessCard user={user} />
        </div>
        <div id="agent-credits" className="scroll-mt-20">
          <AgentCreditsCard user={user} />
        </div>
      </div>
    );
  }

  return <InvitationCard />;
}

function SettingsSectionHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col gap-3 border-b pb-5 sm:flex-row sm:items-start sm:justify-between" style={{ borderColor: "var(--ink-line)" }}>
      <div>
        <h2 className="kn-heading-cn text-xl font-bold" style={{ color: "var(--ink-black)" }}>
          {title}
        </h2>
        <p className="mt-1.5 max-w-2xl text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
          {description}
        </p>
      </div>
    </div>
  );
}

function AccountOverviewCard({ user }: { user: User }) {
  const { t, locale } = useI18n();
  const name = user.nickname || user.username || user.email;
  const joinedAt = user.createdAt
    ? new Date(user.createdAt).toLocaleDateString(DATE_LOCALE[locale])
    : "—";
  const member = user.membershipTier === "lifetime";

  return (
    <PaperCard className="p-5 sm:p-6">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
        <Avatar name={name} avatarUrl={user.avatarUrl} size={52} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-semibold" style={{ color: "var(--ink-black)" }}>
              {name}
            </h3>
            <span
              className="rounded-full px-2.5 py-1 text-xs font-medium"
              style={{
                background: member ? "var(--cinnabar-soft)" : "var(--ink-wash)",
                color: member ? "var(--cinnabar)" : "var(--ink-mid)",
              }}
            >
              {member ? t.settingsPage.lifetimePlan : t.settingsPage.freePlan}
            </span>
          </div>
          <p className="mt-1 truncate text-sm" style={{ color: "var(--ink-mid)" }}>
            {user.email}
          </p>
          <p className="mt-2 flex items-center gap-1.5 text-xs" style={{ color: "var(--ink-faint)" }}>
            <Clock className="h-3.5 w-3.5" />
            {t.dashboard.joinedAt} · {joinedAt}
          </p>
        </div>
        {!member && (
          <Link
            to="/pricing"
            className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full border px-4 py-2 text-sm font-semibold transition hover:bg-[var(--ink-wash)]"
            style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
          >
            <Crown className="h-4 w-4" style={{ color: "var(--cinnabar)" }} />
            {t.settingsPage.upgrade}
          </Link>
        )}
      </div>
    </PaperCard>
  );
}

function DesktopSecurityCard() {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);

  async function openWebSecuritySettings() {
    setFailed(false);
    try {
      await openKoinoteWebPath("/settings?section=general#security");
    } catch {
      setFailed(true);
    }
  }

  return (
    <PaperCard className="p-5 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <KeyRound className="mt-0.5 h-5 w-5 shrink-0" style={{ color: "var(--ink-faint)" }} />
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold" style={{ color: "var(--ink-black)" }}>
            {t.security.title}
          </h3>
          <p className="mt-1 text-sm" style={{ color: "var(--ink-mid)" }}>
            {t.security.desktopDescription}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void openWebSecuritySettings()}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition hover:bg-[var(--ink-wash)]"
          style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
        >
          <ExternalLink className="h-4 w-4" />
          {t.security.manageOnWeb}
        </button>
      </div>
      {failed && (
        <p className="mt-4 text-sm" role="alert" style={{ color: "var(--cinnabar)" }}>
          {t.auth.requestFailed}
        </p>
      )}
    </PaperCard>
  );
}

function AIUpgradeCard() {
  const { t } = useI18n();
  return (
    <PaperCard className="overflow-hidden">
      <div className="h-1" style={{ background: "linear-gradient(90deg, var(--cinnabar), #d6a84b)" }} />
      <div className="p-6 text-center sm:p-8">
        <span
          className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl"
          style={{ background: "var(--cinnabar-soft)", color: "var(--cinnabar)" }}
        >
          <ShieldCheck className="h-6 w-6" />
        </span>
        <h3 className="kn-heading-cn mt-4 text-lg font-bold" style={{ color: "var(--ink-black)" }}>
          {t.settingsPage.aiLockedTitle}
        </h3>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
          {t.settingsPage.aiLockedDescription}
        </p>
        <Link
          to="/pricing"
          className="mt-5 inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
          style={{ background: "var(--cinnabar)" }}
        >
          <Crown className="h-4 w-4" />
          {t.settingsPage.upgrade}
        </Link>
      </div>
    </PaperCard>
  );
}

function SettingsLoading() {
  const { t } = useI18n();
  return (
    <div className="flex flex-1 items-center justify-center py-24" style={{ color: "var(--ink-faint)" }}>
      {t.dashboard.loading}
    </div>
  );
}

function SettingsLoginRequired() {
  const { t } = useI18n();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-24 text-center">
      <p className="kn-heading-cn text-lg font-medium" style={{ color: "var(--ink-black)" }}>
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

function LegacySettingsRedirect({ section }: { section: SettingsSection }) {
  const navigate = useNavigate();
  const hash = useRouterState({ select: (state) => state.location.hash });
  const legacySearch = useRouterState({
    select: (state) => state.location.search,
  }) as Record<string, unknown>;
  const checkout =
    typeof legacySearch.checkout === "string" ? legacySearch.checkout : undefined;
  const creditCheckout =
    typeof legacySearch.credit_checkout === "string"
      ? legacySearch.credit_checkout
      : undefined;
  const sessionId =
    typeof legacySearch.session_id === "string"
      ? legacySearch.session_id
      : undefined;

  useEffect(() => {
    void navigate({
      to: "/settings",
      search: {
        section,
        checkout,
        credit_checkout: creditCheckout,
        session_id: sessionId,
      },
      hash: hash || undefined,
      replace: true,
    });
  }, [checkout, creditCheckout, hash, navigate, section, sessionId]);

  return <SettingsLoading />;
}

export function LegacyDashboardPage() {
  const hash = useRouterState({ select: (state) => state.location.hash });
  const legacySearch = useRouterState({
    select: (state) => state.location.search,
  }) as Record<string, unknown>;
  const normalizedHash = hash.replace(/^#/, "");
  const section =
    normalizedHash === "membership" ||
    normalizedHash === "history-settings" ||
    typeof legacySearch.checkout === "string"
      ? "membership"
      : "general";
  return <LegacySettingsRedirect section={section} />;
}

export function LegacyAISettingsPage() {
  return <LegacySettingsRedirect section="ai" />;
}

export function LegacyInvitationsPage() {
  return <LegacySettingsRedirect section="invitations" />;
}
