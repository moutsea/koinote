import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  CircleAlert,
  ExternalLink,
  ImagePlus,
  KeyRound,
  Send,
  ShieldCheck,
} from "lucide-react";
import { InkClouds, PaperCard } from "../components/Ink";
import { PageContainer } from "../components/PageContainer";
import { useI18n } from "../i18n";

export function WechatOfficialAccountGuidePage() {
  const { t } = useI18n();
  const guide = t.wechatGuide;

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <InkClouds />
      <PageContainer className="relative flex-1 py-12 sm:py-16">
        <Link
          to="/docs"
          className="kn-ink-link inline-flex items-center gap-1.5 text-sm font-semibold"
          style={{ color: "var(--ink-mid)" }}
        >
          <ArrowLeft className="h-4 w-4" />
          {guide.backToDocs}
        </Link>

        <header className="mx-auto mt-10 max-w-3xl text-center">
          <p
            className="text-xs font-semibold uppercase tracking-[0.2em]"
            style={{ color: "var(--ink-mid)" }}
          >
            {guide.eyebrow}
          </p>
          <h1
            className="kn-heading-cn mt-4 text-3xl font-bold tracking-tight sm:text-5xl"
            style={{ color: "var(--ink-black)" }}
          >
            {guide.title}
          </h1>
          <p
            className="mx-auto mt-5 max-w-2xl text-base leading-7"
            style={{ color: "var(--ink-mid)" }}
          >
            {guide.subtitle}
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              to="/editor"
              className="rounded-full px-5 py-2.5 text-sm font-semibold transition hover:opacity-85"
              style={{
                background: "var(--ink-strong)",
                color: "var(--ink-paper)",
              }}
            >
              {guide.openEditor}
            </Link>
            <a
              href="https://developers.weixin.qq.com/platform"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full border px-5 py-2.5 text-sm font-semibold transition hover:bg-[var(--ink-wash)]"
              style={{
                borderColor: "var(--ink-line)",
                color: "var(--ink-strong)",
              }}
            >
              {guide.openPlatform}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <Link
              to="/pricing"
              className="rounded-full border px-5 py-2.5 text-sm font-semibold transition hover:bg-[var(--ink-wash)]"
              style={{
                borderColor: "var(--ink-line)",
                color: "var(--ink-strong)",
              }}
            >
              {guide.pricingCta}
            </Link>
          </div>
        </header>

        <section className="mx-auto mt-12 grid max-w-5xl gap-5 lg:grid-cols-2">
          <GuideCard
            icon={<Check className="h-5 w-5" />}
            title={guide.prerequisitesTitle}
          >
            <ul className="space-y-3">
              {guide.prerequisites.map((item) => (
                <CheckItem key={item}>{item}</CheckItem>
              ))}
            </ul>
          </GuideCard>
          <GuideCard
            icon={<KeyRound className="h-5 w-5" />}
            title={guide.platformTitle}
          >
            <ol className="space-y-4">
              {guide.platformSteps.map((step, index) => (
                <li key={step.title} className="flex gap-3 text-sm leading-6">
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold"
                    style={{
                      borderColor: "var(--ink-line)",
                      color: "var(--ink-strong)",
                    }}
                  >
                    {index + 1}
                  </span>
                  <span>
                    <strong style={{ color: "var(--ink-strong)" }}>
                      {step.title}
                    </strong>
                    <span className="block" style={{ color: "var(--ink-mid)" }}>
                      {step.desc}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </GuideCard>
        </section>

        <section
          className="mx-auto mt-8 flex max-w-5xl items-start gap-3 rounded-2xl border p-6 sm:p-7"
          style={{
            borderColor: "var(--ink-line)",
            background: "var(--ink-wash)",
          }}
        >
          <ShieldCheck
            className="mt-0.5 h-5 w-5 shrink-0"
            style={{ color: "var(--ink-strong)" }}
          />
          <div>
            <h2
              className="kn-heading-cn text-xl font-bold"
              style={{ color: "var(--ink-black)" }}
            >
              {guide.ipTitle}
            </h2>
            <p
              className="mt-2 text-sm leading-7"
              style={{ color: "var(--ink-mid)" }}
            >
              {guide.ipBody}
            </p>
          </div>
        </section>

        <section className="mx-auto mt-16 max-w-5xl">
          <GuideCard
            icon={<Send className="h-5 w-5" />}
            title={guide.koinoteTitle}
          >
            <ol className="grid gap-4 md:grid-cols-2">
              {guide.koinoteSteps.map((step, index) => (
                <li key={step} className="flex gap-3 text-sm leading-6">
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold"
                    style={{
                      borderColor: "var(--ink-line)",
                      color: "var(--ink-strong)",
                    }}
                  >
                    {index + 1}
                  </span>
                  <span style={{ color: "var(--ink-mid)" }}>{step}</span>
                </li>
              ))}
            </ol>
          </GuideCard>
        </section>

        <section className="mx-auto mt-8 grid max-w-5xl gap-5 lg:grid-cols-2">
          <GuideCard
            icon={<ImagePlus className="h-5 w-5" />}
            title={guide.billingTitle}
          >
            <p
              className="text-sm leading-7"
              style={{ color: "var(--ink-mid)" }}
            >
              {guide.billingBody}
            </p>
          </GuideCard>
          <GuideCard
            icon={<ShieldCheck className="h-5 w-5" />}
            title={guide.securityTitle}
          >
            <p
              className="text-sm leading-7"
              style={{ color: "var(--ink-mid)" }}
            >
              {guide.securityBody}
            </p>
          </GuideCard>
        </section>

        <section className="mx-auto mt-16 max-w-5xl">
          <div className="flex items-center gap-3">
            <CircleAlert
              className="h-5 w-5"
              style={{ color: "var(--ink-strong)" }}
            />
            <h2
              className="kn-heading-cn text-2xl font-bold"
              style={{ color: "var(--ink-black)" }}
            >
              {guide.troubleshootingTitle}
            </h2>
          </div>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {guide.troubleshooting.map((item) => (
              <PaperCard key={item.problem} className="p-5 sm:p-6">
                <h3
                  className="font-semibold"
                  style={{ color: "var(--ink-black)" }}
                >
                  {item.problem}
                </h3>
                <p
                  className="mt-2 text-sm leading-6"
                  style={{ color: "var(--ink-mid)" }}
                >
                  {item.solution}
                </p>
              </PaperCard>
            ))}
          </div>
        </section>
      </PageContainer>
    </div>
  );
}

function GuideCard({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <PaperCard className="p-6 sm:p-7">
      <div className="flex items-center gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
          style={{ background: "var(--ink-wash)", color: "var(--ink-strong)" }}
        >
          {icon}
        </span>
        <h2
          className="kn-heading-cn text-xl font-bold"
          style={{ color: "var(--ink-black)" }}
        >
          {title}
        </h2>
      </div>
      <div className="mt-5">{children}</div>
    </PaperCard>
  );
}

function CheckItem({ children }: { children: React.ReactNode }) {
  return (
    <li
      className="flex items-start gap-2.5 text-sm leading-6"
      style={{ color: "var(--ink-mid)" }}
    >
      <Check
        className="mt-1 h-4 w-4 shrink-0"
        style={{ color: "var(--ink-strong)" }}
      />
      <span>{children}</span>
    </li>
  );
}
