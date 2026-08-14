import { Link } from "@tanstack/react-router";
import { Check, GitCompareArrows, History, RotateCcw, Settings2, ShieldCheck } from "lucide-react";
import { InkClouds, PaperCard } from "../components/Ink";
import { PageContainer } from "../components/PageContainer";
import { useI18n } from "../i18n";

const FEATURE_ICONS = [History, Settings2, ShieldCheck, GitCompareArrows, RotateCcw] as const;

export function VersionHistoryGuidePage() {
  const { t } = useI18n();

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <InkClouds />
      <PageContainer className="relative flex-1 py-14 sm:py-20">
        <header className="mx-auto max-w-3xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: "var(--ink-mid)" }}>
            {t.versionGuide.eyebrow}
          </p>
          <h1 className="kn-heading-cn mt-4 text-3xl font-bold tracking-tight sm:text-5xl" style={{ color: "var(--ink-black)" }}>
            {t.versionGuide.title}
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-7" style={{ color: "var(--ink-mid)" }}>
            {t.versionGuide.subtitle}
          </p>
        </header>

        <section className="mx-auto mt-12 grid max-w-5xl gap-5 md:grid-cols-[1.1fr_1fr]">
          <PaperCard className="p-6 sm:p-7">
            <div className="flex items-center gap-3">
              <IconBox><History className="h-5 w-5" /></IconBox>
              <h2 className="kn-heading-cn text-xl font-bold" style={{ color: "var(--ink-black)" }}>{t.versionGuide.overviewTitle}</h2>
            </div>
            <p className="mt-4 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>{t.versionGuide.overviewBody}</p>
          </PaperCard>
          <PaperCard className="p-6 sm:p-7">
            <div className="flex items-center gap-3">
              <IconBox><Settings2 className="h-5 w-5" /></IconBox>
              <h2 className="kn-heading-cn text-xl font-bold" style={{ color: "var(--ink-black)" }}>{t.versionGuide.availabilityTitle}</h2>
            </div>
            <p className="mt-4 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>{t.versionGuide.availabilityBody}</p>
          </PaperCard>
        </section>

        <section className="mx-auto mt-16 max-w-5xl">
          <h2 className="kn-heading-cn text-2xl font-bold" style={{ color: "var(--ink-black)" }}>{t.versionGuide.featuresTitle}</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {t.versionGuide.features.map((feature, index) => {
              const Icon = FEATURE_ICONS[index] ?? History;
              return (
                <PaperCard key={feature.title} className="p-5">
                  <Icon className="h-5 w-5" style={{ color: "var(--ink-strong)" }} />
                  <h3 className="mt-4 font-semibold" style={{ color: "var(--ink-black)" }}>{feature.title}</h3>
                  <p className="mt-2 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{feature.desc}</p>
                </PaperCard>
              );
            })}
          </div>
        </section>

        <section className="mx-auto mt-16 grid max-w-5xl gap-5 lg:grid-cols-2">
          <PaperCard className="p-6 sm:p-7">
            <h2 className="kn-heading-cn text-xl font-bold" style={{ color: "var(--ink-black)" }}>{t.versionGuide.webTitle}</h2>
            <ul className="mt-5 space-y-3">
              {t.versionGuide.webSteps.map((item) => <CheckItem key={item}>{item}</CheckItem>)}
            </ul>
          </PaperCard>
          <PaperCard className="p-6 sm:p-7">
            <h2 className="kn-heading-cn text-xl font-bold" style={{ color: "var(--ink-black)" }}>{t.versionGuide.mcpTitle}</h2>
            <ul className="mt-5 space-y-3">
              {t.versionGuide.mcpRules.map((item) => <CheckItem key={item}>{item}</CheckItem>)}
            </ul>
          </PaperCard>
        </section>

        <section className="mx-auto mt-16 max-w-5xl rounded-2xl border p-6 sm:p-7" style={{ borderColor: "var(--ink-line)", background: "var(--ink-wash)" }}>
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" style={{ color: "var(--ink-strong)" }} />
            <div>
              <h2 className="kn-heading-cn text-xl font-bold" style={{ color: "var(--ink-black)" }}>{t.versionGuide.safetyTitle}</h2>
              <p className="mt-2 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>{t.versionGuide.safetyBody}</p>
            </div>
          </div>
        </section>

        <div className="mx-auto mt-12 flex max-w-5xl flex-wrap gap-3">
          <Link to="/dashboard" hash="history-settings" className="rounded-full px-5 py-2.5 text-sm font-semibold transition hover:opacity-85" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>{t.versionGuide.settingsCta}</Link>
          <Link to="/docs/mcp" className="rounded-full border px-5 py-2.5 text-sm font-semibold transition hover:bg-[var(--ink-wash)]" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}>{t.versionGuide.mcpCta}</Link>
          <Link to="/pricing" className="rounded-full border px-5 py-2.5 text-sm font-semibold transition hover:bg-[var(--ink-wash)]" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}>{t.versionGuide.pricingCta}</Link>
        </div>
      </PageContainer>
    </div>
  );
}

function IconBox({ children }: { children: React.ReactNode }) {
  return <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ background: "var(--ink-wash)", color: "var(--ink-strong)" }}>{children}</span>;
}

function CheckItem({ children }: { children: React.ReactNode }) {
  return <li className="flex items-start gap-2.5 text-sm leading-6" style={{ color: "var(--ink-mid)" }}><Check className="mt-1 h-4 w-4 shrink-0" style={{ color: "var(--ink-strong)" }} /><span>{children}</span></li>;
}
