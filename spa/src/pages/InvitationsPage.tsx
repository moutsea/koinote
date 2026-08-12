import { Link } from "@tanstack/react-router";
import { useSession } from "../auth";
import { useI18n } from "../i18n";
import { InvitationCard } from "../components/InvitationCard";
import { PageContainer } from "../components/PageContainer";

export function InvitationsPage() {
  const session = useSession();
  const { t } = useI18n();

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
      <h1
        className="kn-heading-cn text-2xl font-bold tracking-tight"
        style={{ color: "var(--ink-black)" }}
      >
        {t.invitationsPage.title}
      </h1>
      <div
        className="mt-2 h-0.5 w-10 rounded-full"
        style={{ background: "var(--cinnabar)" }}
      />
      <p className="mt-2 text-sm" style={{ color: "var(--ink-mid)" }}>
        {t.invitationsPage.subtitle}
      </p>

      <div className="mt-8">
        <InvitationCard />
      </div>
    </PageContainer>
  );
}
