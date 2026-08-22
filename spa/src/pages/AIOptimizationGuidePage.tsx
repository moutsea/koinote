import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Gauge,
  ListTree,
  MessageSquareText,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { InkClouds, PaperCard } from "../components/Ink";
import { PageContainer } from "../components/PageContainer";
import { useI18n } from "../i18n";
import type { Messages } from "../i18n/types";

const REVIEW_ICONS = [Gauge, MessageSquareText, ListTree, ShieldCheck] as const;

export function AIOptimizationGuidePage() {
  const { t } = useI18n();
  const guide = t.aiGuide;

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <InkClouds />
      <PageContainer className="relative flex-1 py-14 sm:py-20">
        <header className="mx-auto max-w-3xl text-center">
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
        </header>

        <section className="mx-auto mt-14 max-w-5xl sm:mt-16">
          <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--cinnabar)" }}>
            {guide.caseEyebrow}
          </p>
          <h2 className="kn-heading-cn mt-3 text-2xl font-bold sm:text-3xl" style={{ color: "var(--ink-black)" }}>
            {guide.caseTitle}
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-7" style={{ color: "var(--ink-mid)" }}>
            {guide.caseIntro}{" "}
            <Link
              to="/docs/ai-optimization/case"
              target="_blank"
              className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium opacity-65 transition hover:opacity-100"
              style={{ color: "var(--ink-mid)" }}
            >
              {guide.caseSourceCta}
              <ExternalLink className="h-3 w-3" />
            </Link>
          </p>
          <Link
            to="/pricing"
            className="group mt-4 inline-flex items-center gap-1.5 rounded-full px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
            style={{ background: "var(--cinnabar)" }}
          >
            {guide.pricingCta}
            <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>

          <ReviewCaseCarousel guide={guide} />
        </section>

        <section className="mx-auto mt-16 max-w-5xl">
          <h2 className="kn-heading-cn text-2xl font-bold" style={{ color: "var(--ink-black)" }}>
            {guide.faqTitle}
          </h2>
          <div className="mt-6 space-y-3">
            {guide.faqs.map((item) => (
              <details
                key={item.question}
                className="group rounded-xl border px-5 py-4 open:bg-[var(--ink-wash)]"
                style={{ borderColor: "var(--ink-line)", background: "var(--ink-paper-soft)" }}
              >
                <summary
                  className="cursor-pointer list-none pr-8 font-semibold marker:hidden"
                  style={{ color: "var(--ink-black)" }}
                >
                  {item.question}
                </summary>
                <p className="mt-3 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>
                  {item.answer}
                </p>
              </details>
            ))}
          </div>
        </section>

      </PageContainer>
    </div>
  );
}

const CASE_TAB_COUNT = 4;

function ReviewCaseCarousel({ guide }: { guide: Messages["aiGuide"] }) {
  const [activeTab, setActiveTab] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const paused = hovered || focusWithin;

  useEffect(() => {
    if (paused || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => {
      setActiveTab((current) => (current + 1) % CASE_TAB_COUNT);
    }, 8_000);
    return () => window.clearInterval(timer);
  }, [paused]);

  function selectTab(index: number) {
    setActiveTab((index + CASE_TAB_COUNT) % CASE_TAB_COUNT);
  }

  return (
    <div
      className="mt-6"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocusWithin(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false);
      }}
    >
      <div
        className="overflow-x-auto rounded-xl border p-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{ borderColor: "var(--ink-line)", background: "var(--ink-wash)" }}
      >
        <div role="tablist" aria-label={guide.caseCarouselLabel} className="flex min-w-max gap-1">
          {guide.checks.map((item, index) => {
            const Icon = REVIEW_ICONS[index] ?? Sparkles;
            const active = index === activeTab;
            return (
              <button
                key={item.title}
                id={`ai-case-tab-${index}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`ai-case-panel-${index}`}
                tabIndex={active ? 0 : -1}
                onClick={() => selectTab(index)}
                onKeyDown={(event) => {
                  let next = index;
                  if (event.key === "ArrowRight") next = (index + 1) % CASE_TAB_COUNT;
                  else if (event.key === "ArrowLeft") next = (index - 1 + CASE_TAB_COUNT) % CASE_TAB_COUNT;
                  else if (event.key === "Home") next = 0;
                  else if (event.key === "End") next = CASE_TAB_COUNT - 1;
                  else return;
                  event.preventDefault();
                  selectTab(next);
                  event.currentTarget.parentElement
                    ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                    [next]?.focus();
                }}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition"
                style={{
                  color: active ? "var(--ink-black)" : "var(--ink-mid)",
                  background: active ? "var(--ink-paper-soft)" : "transparent",
                  boxShadow: active ? "0 1px 3px rgba(31, 35, 40, 0.08)" : "none",
                }}
              >
                <Icon className="h-4 w-4" />
                {item.title}
              </button>
            );
          })}
        </div>
      </div>

      <PaperCard className="mt-4 overflow-hidden p-5 sm:p-7">
        <div
          key={activeTab}
          id={`ai-case-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`ai-case-tab-${activeTab}`}
          aria-live={paused ? "polite" : "off"}
          className="kn-case-slide"
        >
          {activeTab === 0 && <TitleReviewCase guide={guide} />}
          {activeTab === 1 && <ContentReviewCase guide={guide} />}
          {activeTab === 2 && <StructureReviewCase guide={guide} />}
          {activeTab === 3 && <SafeApplyCase guide={guide} />}
        </div>
      </PaperCard>

      <div className="mt-4 flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={() => selectTab(activeTab - 1)}
          aria-label={guide.casePrevious}
          className="flex h-9 w-9 items-center justify-center rounded-full border transition hover:bg-[var(--ink-wash)]"
          style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="flex gap-2" aria-hidden="true">
          {Array.from({ length: CASE_TAB_COUNT }, (_, index) => (
            <span
              key={index}
              className="h-1.5 rounded-full transition-all"
              style={{
                width: index === activeTab ? "1.75rem" : "0.375rem",
                background: index === activeTab ? "var(--cinnabar)" : "var(--ink-line)",
              }}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => selectTab(activeTab + 1)}
          aria-label={guide.caseNext}
          className="flex h-9 w-9 items-center justify-center rounded-full border transition hover:bg-[var(--ink-wash)]"
          style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function CaseMetric({ fact }: { fact: { label: string; value: string } }) {
  return (
    <div
      className="rounded-xl border p-5 text-center"
      style={{ borderColor: "var(--ink-line)", background: "var(--ink-wash)" }}
    >
      <p className="text-3xl font-bold" style={{ color: "var(--ink-black)" }}>{fact.value}</p>
      <p className="mt-1.5 text-xs" style={{ color: "var(--ink-faint)" }}>{fact.label}</p>
    </div>
  );
}

function TitleReviewCase({ guide }: { guide: Messages["aiGuide"] }) {
  return (
    <div className="grid gap-5 lg:grid-cols-[14rem_1fr]">
      <CaseMetric fact={guide.caseFacts[0]!} />
      <div>
        <h3 className="text-lg font-semibold" style={{ color: "var(--ink-black)" }}>
          {guide.caseTitleReviewTitle}
        </h3>
        <p
          className="mt-3 rounded-lg border-l-4 px-4 py-3 font-medium"
          style={{ borderColor: "var(--cinnabar)", background: "var(--ink-wash)", color: "var(--ink-strong)" }}
        >
          {guide.caseOriginalTitle}
        </p>
        <p className="mt-4 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>
          {guide.caseTitleReviewBody}
        </p>
      </div>
    </div>
  );
}

function ContentReviewCase({ guide }: { guide: Messages["aiGuide"] }) {
  return (
    <div className="grid gap-5 lg:grid-cols-[14rem_1fr]">
      <CaseMetric fact={guide.caseFacts[1]!} />
      <div>
        <h3 className="text-lg font-semibold" style={{ color: "var(--ink-black)" }}>
          {guide.caseContentTitle}
        </h3>
        <p className="mt-2 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
          {guide.caseContentBody}
        </p>
        <DiffBlock label={guide.beforeLabel} value={guide.caseBefore} tone="remove" />
        <DiffBlock label={guide.afterLabel} value={guide.caseAfter} tone="add" />
      </div>
    </div>
  );
}

function StructureReviewCase({ guide }: { guide: Messages["aiGuide"] }) {
  return (
    <div>
      <div className="grid gap-5 lg:grid-cols-[14rem_1fr]">
        <CaseMetric fact={guide.caseFacts[2]!} />
        <div>
          <h3 className="text-lg font-semibold" style={{ color: "var(--ink-black)" }}>
            {guide.caseStructureTitle}
          </h3>
          <p className="mt-2 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
            {guide.caseStructureBody}
          </p>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {guide.caseDimensions.map((dimension) => (
              <div
                key={dimension.label}
                className="rounded-lg border px-3 py-3"
                style={{ borderColor: "var(--ink-line)", background: "var(--ink-wash)" }}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs" style={{ color: "var(--ink-mid)" }}>{dimension.label}</span>
                  <strong className="text-sm" style={{ color: "var(--ink-strong)" }}>{dimension.score}</strong>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: "var(--ink-line)" }}>
                  <div className="h-full rounded-full" style={{ width: `${dimension.score}%`, background: "var(--cinnabar)" }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <h4 className="mt-6 font-semibold" style={{ color: "var(--ink-black)" }}>
        {guide.caseChangesTitle}
      </h4>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {guide.caseChanges.map((item, index) => (
          <div
            key={`${item.before}-${item.after}`}
            className="rounded-xl border p-4"
            style={{ borderColor: "var(--ink-line)", background: "var(--ink-paper-soft)" }}
          >
            <div className="flex items-start gap-3">
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold"
                style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
              >
                {index + 1}
              </span>
              <p className="text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{item.reason}</p>
            </div>
            <DiffBlock label={guide.beforeLabel} value={item.before} tone="remove" />
            <DiffBlock label={guide.afterLabel} value={item.after} tone="add" />
          </div>
        ))}
      </div>
    </div>
  );
}

function SafeApplyCase({ guide }: { guide: Messages["aiGuide"] }) {
  return (
    <div className="grid gap-5 lg:grid-cols-[14rem_1fr]">
      <CaseMetric fact={guide.caseFacts[3]!} />
      <div>
        <h3 className="text-lg font-semibold" style={{ color: "var(--ink-black)" }}>
          {guide.caseSafetyTitle}
        </h3>
        <p className="mt-2 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>
          {guide.caseSafetyBody}
        </p>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {guide.caseSafetyItems.map((item) => <CheckItem key={item}>{item}</CheckItem>)}
        </ul>
      </div>
    </div>
  );
}

function CheckItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
      <Check className="mt-1 h-4 w-4 shrink-0" style={{ color: "var(--ink-strong)" }} />
      <span>{children}</span>
    </li>
  );
}

function DiffBlock({ label, value, tone }: { label: string; value: string; tone: "remove" | "add" }) {
  return (
    <div
      className="mt-4 rounded-lg border px-4 py-3"
      style={{
        borderColor: tone === "remove" ? "color-mix(in srgb, #dc2626 25%, var(--ink-line))" : "color-mix(in srgb, #16a34a 25%, var(--ink-line))",
        background: tone === "remove" ? "color-mix(in srgb, #dc2626 5%, var(--ink-paper))" : "color-mix(in srgb, #16a34a 5%, var(--ink-paper))",
      }}
    >
      <p className="text-xs font-semibold" style={{ color: tone === "remove" ? "#b91c1c" : "#15803d" }}>
        {tone === "remove" ? "−" : "+"} {label}
      </p>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-6" style={{ color: "var(--ink-strong)" }}>{value}</p>
    </div>
  );
}
