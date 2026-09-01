import { Link } from "@tanstack/react-router";
import { ArrowLeft, Check, CircleAlert, ExternalLink, ShieldCheck } from "lucide-react";
import { InkClouds, PaperCard } from "../components/Ink";
import { PageContainer } from "../components/PageContainer";
import { useI18n } from "../i18n";

const PLATFORM_SCREENSHOT = "/docs/wechat-platform-ip-allowlist.png";

export function WechatOfficialAccountGuidePage() {
  const { t } = useI18n();
  const guide = t.wechatGuide;

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <InkClouds />
      <PageContainer className="relative flex-1 py-10 sm:py-14">
        <Link
          to="/docs"
          className="kn-ink-link inline-flex items-center gap-1.5 text-sm font-semibold"
          style={{ color: "var(--ink-mid)" }}
        >
          <ArrowLeft className="h-4 w-4" />
          {guide.backToDocs}
        </Link>

        <article className="mx-auto mt-10 max-w-3xl">
          <header className="border-b pb-9" style={{ borderColor: "var(--ink-line)" }}>
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
              className="mt-5 max-w-2xl text-base leading-8"
              style={{ color: "var(--ink-mid)" }}
            >
              {guide.subtitle}
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link
                to="/editor"
                className="rounded-full px-5 py-2.5 text-sm font-semibold transition hover:opacity-85"
                style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}
              >
                {guide.openEditor}
              </Link>
              <a
                href="https://developers.weixin.qq.com/platform"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full border px-5 py-2.5 text-sm font-semibold transition hover:bg-[var(--ink-wash)]"
                style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
              >
                {guide.openPlatform}
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          </header>

          <GuideArticleSection title={guide.prerequisitesTitle}>
            <p className="guide-prose">{guide.prerequisitesIntro}</p>
            <ul className="mt-5 space-y-3">
              {guide.prerequisites.map((item) => (
                <CheckItem key={item}>{item}</CheckItem>
              ))}
            </ul>
          </GuideArticleSection>

          <GuideArticleSection title={guide.platformTitle}>
            <p className="guide-prose">{guide.platformIntro}</p>
            <ol className="mt-6 space-y-6">
              {guide.platformSteps.map((step, index) => (
                <li key={step.title} className="flex gap-4">
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
                    style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0 pt-0.5">
                    <h3 className="font-semibold" style={{ color: "var(--ink-black)" }}>
                      {step.title}
                    </h3>
                    <p className="mt-1 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>
                      {step.desc}
                    </p>
                    {index === 2 && (
                      <figure
                        className="mt-5 overflow-hidden rounded-xl border"
                        style={{ borderColor: "var(--ink-line)", background: "var(--ink-paper-soft)" }}
                      >
                        <img
                          src={PLATFORM_SCREENSHOT}
                          alt={guide.platformScreenshotAlt}
                          loading="lazy"
                          className="block h-auto w-full"
                        />
                        <figcaption
                          className="border-t px-4 py-3 text-xs leading-5"
                          style={{ borderColor: "var(--ink-line)", color: "var(--ink-faint)" }}
                        >
                          {guide.platformScreenshotCaption}
                        </figcaption>
                      </figure>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </GuideArticleSection>

          <PaperCard
            className="mt-12 flex items-start gap-3 rounded-2xl border p-5 sm:p-6"
          >
            <ShieldCheck
              className="mt-0.5 h-5 w-5 shrink-0"
              style={{ color: "var(--ink-strong)" }}
            />
            <div>
              <h2 className="kn-heading-cn text-xl font-bold" style={{ color: "var(--ink-black)" }}>
                {guide.ipTitle}
              </h2>
              <p className="mt-2 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>
                {guide.ipBody}
              </p>
            </div>
          </PaperCard>

          <GuideArticleSection title={guide.koinoteTitle}>
            <p className="guide-prose">{guide.koinoteIntro}</p>
            <ol className="mt-6 space-y-5">
              {guide.koinoteSteps.map((step, index) => (
                <li key={step} className="flex gap-4">
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold"
                    style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
                  >
                    {index + 1}
                  </span>
                  <p className="pt-0.5 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>
                    {step}
                  </p>
                </li>
              ))}
            </ol>
          </GuideArticleSection>

          <GuideArticleSection title={guide.billingTitle}>
            <p className="guide-prose">{guide.billingBody}</p>
          </GuideArticleSection>

          <GuideArticleSection title={guide.securityTitle}>
            <p className="guide-prose">{guide.securityBody}</p>
          </GuideArticleSection>

          <GuideArticleSection title={guide.troubleshootingTitle} icon={<CircleAlert className="h-5 w-5" />}>
            <div className="space-y-5">
              {guide.troubleshooting.map((item) => (
                <div key={item.problem}>
                  <h3 className="font-semibold" style={{ color: "var(--ink-black)" }}>
                    {item.problem}
                  </h3>
                  <p className="mt-1 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>
                    {item.solution}
                  </p>
                </div>
              ))}
            </div>
          </GuideArticleSection>

          <footer
            className="mt-12 border-t pt-7 text-sm leading-7"
            style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}
          >
            <p>{guide.footerNote}</p>
            <Link
              to="/pricing"
              className="mt-4 inline-flex rounded-full border px-4 py-2 text-sm font-semibold transition hover:bg-[var(--ink-wash)]"
              style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
            >
              {guide.pricingCta}
            </Link>
          </footer>
        </article>
      </PageContainer>
    </div>
  );
}

function GuideArticleSection({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-12 sm:mt-14">
      <div className="flex items-center gap-2.5">
        {icon ? <span style={{ color: "var(--ink-strong)" }}>{icon}</span> : null}
        <h2 className="kn-heading-cn text-2xl font-bold" style={{ color: "var(--ink-black)" }}>
          {title}
        </h2>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function CheckItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>
      <Check className="mt-1.5 h-4 w-4 shrink-0" style={{ color: "var(--ink-strong)" }} />
      <span>{children}</span>
    </li>
  );
}
