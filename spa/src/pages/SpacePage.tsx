import { Archive, Cloud, Files, FolderOpen, FolderSync, ShieldCheck } from "lucide-react";
import { defaultStringifySearch, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { useSession } from "../auth";
import { AgentWorkspaceRepositoriesPage } from "./AgentWorkspaceRepositoriesPage";
import { ConfigSnapshotsCard } from "../components/ConfigSnapshotsCard";
import { KoiPage } from "../components/KoiPage";
import { Logo } from "../components/Logo";
import { PageContainer } from "../components/PageContainer";
import { useI18n } from "../i18n";
import { parseSpaceSearch } from "../spaceSearch";

export function SpacePage() {
  const session = useSession();
  const { t } = useI18n();
  const [syncOpen, setSyncOpen] = useState(false);
  const navigate = useNavigate();
  const search = parseSpaceSearch(useSearch({ strict: false }));
  const activeTab = search.tab === "config" || (!search.tab && session.data?.user?.isLocalMode)
    ? "config" : search.tab === "koi" ? "koi" : "agent";

  if (session.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center py-24" style={{ color: "var(--ink-faint)" }}>
        {t.dashboard.loading}
      </div>
    );
  }

  const user = session.data?.user;
  if (!user) {
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
          search={activeTab === "koi" ? { redirectTo: `/space${defaultStringifySearch(search)}` } : undefined}
          className="rounded-full px-6 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
          style={{ background: "var(--cinnabar)" }}
        >
          {t.dashboard.goLogin}
        </Link>
      </div>
    );
  }

  return (
    <PageContainer className="flex-1 py-8 sm:py-10">
      <header className="flex items-start gap-3">
        <span
          className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
          style={{ background: "var(--ink-wash)", color: "var(--ink-strong)" }}
        >
          <FolderOpen className="h-5 w-5" />
        </span>
        <div>
          <h1 className="kn-heading-cn text-2xl font-bold tracking-tight" style={{ color: "var(--ink-black)" }}>
            {t.nav.space}
          </h1>
          <p className="mt-1.5 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
            {activeTab === "koi" ? t.koi.subtitle : t.space.subtitle}
          </p>
        </div>
      </header>

      <div className="mt-8 space-y-6">
        <div role="tablist" aria-label={t.nav.space} className="grid grid-cols-3 gap-2 border-b sm:flex sm:gap-6 sm:overflow-x-auto" style={{ borderColor: "var(--ink-line)" }}>
          <Link
            to="/space"
            search={{ tab: "agent" }}
            role="tab"
            aria-selected={activeTab === "agent"}
            className="inline-flex min-w-0 items-center justify-center gap-1.5 border-b-2 px-1 pb-3 text-center text-sm font-semibold sm:shrink-0 sm:justify-start sm:gap-2"
            style={{ borderColor: activeTab === "agent" ? "var(--cinnabar)" : "transparent", color: activeTab === "agent" ? "var(--cinnabar)" : "var(--ink-mid)" }}
          >
            <Cloud className="hidden h-4 w-4 shrink-0 sm:block" />
            <span className="min-w-0 break-words">{t.space.repositoryTab}</span>
          </Link>
          <Link
            to="/space"
            search={{ tab: "config" }}
            role="tab"
            aria-selected={activeTab === "config"}
            className="inline-flex min-w-0 items-center justify-center gap-1.5 border-b-2 px-1 pb-3 text-center text-sm font-semibold sm:shrink-0 sm:justify-start sm:gap-2"
            style={{ borderColor: activeTab === "config" ? "var(--cinnabar)" : "transparent", color: activeTab === "config" ? "var(--cinnabar)" : "var(--ink-mid)" }}
          >
            <FolderSync className="hidden h-4 w-4 shrink-0 sm:block" />
            <span className="min-w-0 break-words sm:hidden">{t.space.configTitle}</span><span className="hidden sm:inline">{t.space.cloneTitle}</span>
          </Link>
          <Link
            to="/space"
            search={{ tab: "koi" }}
            role="tab"
            aria-selected={activeTab === "koi"}
            className="inline-flex min-w-0 items-center justify-center gap-1.5 border-b-2 px-1 pb-3 text-center text-sm font-semibold sm:shrink-0 sm:justify-start sm:gap-2"
            style={{ borderColor: activeTab === "koi" ? "var(--cinnabar)" : "transparent", color: activeTab === "koi" ? "var(--cinnabar)" : "var(--ink-mid)" }}
          >
            <span className="hidden sm:inline-flex"><Logo className="h-4 w-4" /></span>
            <span>{t.space.koiTab}</span>
          </Link>
        </div>

        {activeTab === "koi" && <KoiPage key={user.authUserId} user={user} section={search.section} install={search.install} onInstallClose={() => {
          void navigate({ to: "/space", search: { tab: "koi", section: "skills" }, replace: true, resetScroll: false });
        }} />}

        {activeTab === "config" && <>
        <section className="border-b pb-7" style={{ borderColor: "var(--ink-line)" }}>
          <div className="mb-4 flex items-center gap-2">
            <FolderOpen className="h-4 w-4" style={{ color: "var(--cinnabar)" }} />
            <h2 className="kn-heading-cn text-sm font-semibold" style={{ color: "var(--ink-black)" }}>{t.space.configTitle}</h2>
          </div>
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ background: "var(--cinnabar-soft)", color: "var(--cinnabar)" }}>
              <Archive className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="kn-heading-cn text-lg font-semibold" style={{ color: "var(--ink-black)" }}>
                {t.space.cloneTagline}
              </h2>
              <p className="mt-2 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
                {t.space.cloneDescription}
              </p>
            </div>
            </div>
            <div className="shrink-0">
              <button
                type="button"
                onClick={() => setSyncOpen(true)}
                disabled={Boolean(user.isLocalMode)}
                className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ background: "var(--cinnabar)" }}
              >
                <FolderSync className="h-4 w-4" />
                {t.space.syncButton}
              </button>
              {user.isLocalMode && <p className="mt-2 text-xs" style={{ color: "var(--ink-faint)" }}>{t.space.syncCloudOnly}</p>}
            </div>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {t.space.cloneCategories.map((category) => (
              <div key={category} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}>
                <Files className="h-4 w-4 shrink-0" style={{ color: "var(--ink-faint)" }} />
                {category}
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-start gap-2 rounded-xl border p-3 text-xs leading-5" style={{ borderColor: "var(--cinnabar-soft)", background: "var(--cinnabar-wash)", color: "var(--ink-mid)" }}>
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--cinnabar)" }} />
            <span>{t.space.cloneSecurity}</span>
          </div>
        </section>

        <section>
          <ConfigSnapshotsCard
            member={user.membershipTier === "lifetime"}
            localMode={Boolean(user.isLocalMode)}
            syncOpen={syncOpen}
            onSyncOpenChange={setSyncOpen}
          />
        </section>
        </>}

        {activeTab === "agent" && <AgentWorkspaceRepositoriesPage embedded />}

      </div>
    </PageContainer>
  );
}
