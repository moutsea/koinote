import { Link } from "@tanstack/react-router";
import { InkClouds } from "../components/Ink";
import { PageContainer } from "../components/PageContainer";
import { useI18n } from "../i18n";

export function AIOptimizationGuidePage() {
  const { t } = useI18n();
  const guide = t.aiGuide;
  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <InkClouds />
      <PageContainer className="relative mx-auto max-w-3xl space-y-10 py-14 sm:py-20">
        <header className="space-y-4">
          <p
            className="text-xs font-semibold tracking-wider"
            style={{ color: "var(--cinnabar)" }}
          >
            {guide.eyebrow}
          </p>
          <h1 className="kn-heading-cn text-4xl font-bold">{guide.title}</h1>
          <p className="leading-7" style={{ color: "var(--ink-mid)" }}>
            {guide.subtitle}
          </p>
        </header>
        {guide.checks.map((item) => (
          <section key={item.title} className="space-y-2">
            <h2 className="text-xl font-semibold">{item.title}</h2>
            <p className="leading-7">{item.desc}</p>
          </section>
        ))}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold">{guide.faqTitle}</h2>
          {guide.faqs.map((item) => (
            <details key={item.question}>
              <summary className="cursor-pointer font-medium">
                {item.question}
              </summary>
              <p className="mt-2 leading-7">{item.answer}</p>
            </details>
          ))}
        </section>
        <Link
          to="/pricing"
          className="font-semibold"
          style={{ color: "var(--cinnabar)" }}
        >
          {guide.pricingCta}
        </Link>
      </PageContainer>
    </div>
  );
}
