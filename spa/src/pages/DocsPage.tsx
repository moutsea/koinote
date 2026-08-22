import { Link } from "@tanstack/react-router";
import {
  Bot,
  Check,
  CloudOff,
  FilePenLine,
  FolderInput,
  History,
  Laptop,
  Search,
  Share2,
  ShieldCheck,
  Sparkles,
  WifiOff,
} from "lucide-react";
import { InkClouds, PaperCard } from "../components/Ink";
import { PageContainer } from "../components/PageContainer";
import { DESKTOP_DOWNLOAD_URL } from "../desktopDownload";
import { useI18n } from "../i18n";

const WORKFLOW_ICONS = [
  FilePenLine,
  FolderInput,
  Share2,
  Laptop,
  Sparkles,
  ShieldCheck,
] as const;

const QUICK_START_LINKS = ["/editor", "/documents", "/editor", "/editor"] as const;
const MODE_ICONS = [WifiOff, CloudOff, FolderInput] as const;

export function DocsPage() {
  const { t } = useI18n();

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <InkClouds />
      <PageContainer className="relative flex-1 py-14 sm:py-20">
        <header className="mx-auto max-w-3xl text-center">
          <p
            className="text-xs font-semibold uppercase tracking-[0.2em]"
            style={{ color: "var(--ink-mid)" }}
          >
            {t.docsCenter.eyebrow}
          </p>
          <h1
            className="kn-heading-cn mt-4 text-3xl font-bold tracking-tight sm:text-5xl"
            style={{ color: "var(--ink-black)" }}
          >
            {t.docsCenter.title}
          </h1>
          <p
            className="mx-auto mt-5 max-w-2xl text-base leading-7"
            style={{ color: "var(--ink-mid)" }}
          >
            {t.docsCenter.subtitle}
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              to="/editor"
              className="rounded-full px-5 py-2.5 text-sm font-semibold transition hover:opacity-85"
              style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}
            >
              {t.docsCenter.openEditor}
            </Link>
            <Link
              to="/documents"
              className="rounded-full border px-5 py-2.5 text-sm font-semibold transition hover:bg-[var(--ink-wash)]"
              style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
            >
              {t.docsCenter.manageDocuments}
            </Link>
            <a
              href={DESKTOP_DOWNLOAD_URL}
              className="rounded-full border px-5 py-2.5 text-sm font-semibold transition hover:bg-[var(--ink-wash)]"
              style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
            >
              {t.docsCenter.downloadDesktop}
            </a>
          </div>
        </header>

        <section className="mx-auto mt-12 max-w-5xl">
          <div className="flex items-center gap-3">
            <IconBox><FilePenLine className="h-5 w-5" /></IconBox>
            <h2
              className="kn-heading-cn text-2xl font-bold"
              style={{ color: "var(--ink-black)" }}
            >
              {t.docsCenter.quickStartTitle}
            </h2>
          </div>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {t.docsCenter.quickStartSteps.map((step, index) => (
              <Link
                key={step.title}
                to={QUICK_START_LINKS[index] ?? "/editor"}
                className="group rounded-xl border p-5 transition hover:-translate-y-0.5 hover:bg-[var(--ink-wash)]"
                style={{
                  borderColor: "var(--ink-line)",
                  background: "var(--ink-paper-soft)",
                }}
              >
                <div className="flex items-start gap-4">
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold"
                    style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
                  >
                    {index + 1}
                  </span>
                  <div>
                    <h3 className="font-semibold" style={{ color: "var(--ink-black)" }}>
                      {step.title}
                    </h3>
                    <p className="mt-1.5 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
                      {step.desc}
                    </p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>

        <section className="mx-auto mt-16 max-w-5xl">
          <div className="flex items-center gap-3">
            <IconBox><Search className="h-5 w-5" /></IconBox>
            <h2
              className="kn-heading-cn text-2xl font-bold"
              style={{ color: "var(--ink-black)" }}
            >
              {t.docsCenter.workflowsTitle}
            </h2>
          </div>
          <div className="mt-6 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {t.docsCenter.workflows.map((workflow, index) => {
              const Icon = WORKFLOW_ICONS[index] ?? FilePenLine;
              return (
                <PaperCard key={workflow.title} className="p-5 sm:p-6">
                  <Icon className="h-5 w-5" style={{ color: "var(--ink-strong)" }} />
                  <h3 className="mt-4 font-semibold" style={{ color: "var(--ink-black)" }}>
                    {workflow.title}
                  </h3>
                  <p className="mt-2 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
                    {workflow.desc}
                  </p>
                  <ul className="mt-4 space-y-2.5">
                    {workflow.items.map((item) => <CheckItem key={item}>{item}</CheckItem>)}
                  </ul>
                </PaperCard>
              );
            })}
          </div>
        </section>

        <section className="mx-auto mt-16 max-w-5xl">
          <h2
            className="kn-heading-cn text-2xl font-bold"
            style={{ color: "var(--ink-black)" }}
          >
            {t.docsCenter.modesTitle}
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
            {t.docsCenter.modesSubtitle}
          </p>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {t.docsCenter.modes.map((mode, index) => {
              const Icon = MODE_ICONS[index] ?? CloudOff;
              return (
                <PaperCard key={mode.title} className="p-5">
                  <Icon className="h-5 w-5" style={{ color: "var(--ink-strong)" }} />
                  <h3 className="mt-4 font-semibold" style={{ color: "var(--ink-black)" }}>
                    {mode.title}
                  </h3>
                  <p className="mt-2 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
                    {mode.desc}
                  </p>
                </PaperCard>
              );
            })}
          </div>
        </section>

        <section className="mx-auto mt-16 max-w-5xl">
          <h2
            className="kn-heading-cn text-2xl font-bold"
            style={{ color: "var(--ink-black)" }}
          >
            {t.docsCenter.deepDiveTitle}
          </h2>
          <div className="mt-6 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            <GuideCard
              icon={<Sparkles className="h-5 w-5" />}
              title={t.docsCenter.aiTitle}
              description={t.docsCenter.aiDescription}
              to="/docs/ai-optimization"
              action={t.docsCenter.readGuide}
            />
            <GuideCard
              icon={<Bot className="h-5 w-5" />}
              title={t.docsCenter.mcpTitle}
              description={t.docsCenter.mcpDescription}
              to="/docs/mcp"
              action={t.docsCenter.readGuide}
            />
            <GuideCard
              icon={<History className="h-5 w-5" />}
              title={t.docsCenter.versionTitle}
              description={t.docsCenter.versionDescription}
              to="/docs/version-history"
              action={t.docsCenter.readGuide}
            />
          </div>
        </section>

        <section
          className="mx-auto mt-16 max-w-5xl rounded-2xl border p-6 sm:p-7"
          style={{ borderColor: "var(--ink-line)", background: "var(--ink-wash)" }}
        >
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" style={{ color: "var(--ink-strong)" }} />
            <div>
              <h2 className="kn-heading-cn text-xl font-bold" style={{ color: "var(--ink-black)" }}>
                {t.docsCenter.safetyTitle}
              </h2>
              <p className="mt-2 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>
                {t.docsCenter.safetyBody}
              </p>
            </div>
          </div>
        </section>

      </PageContainer>
    </div>
  );
}

function GuideCard({
  icon,
  title,
  description,
  to,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  to: "/docs/ai-optimization" | "/docs/mcp" | "/docs/version-history";
  action: string;
}) {
  return (
    <PaperCard className="p-6 sm:p-7">
      <IconBox>{icon}</IconBox>
      <h3 className="mt-5 text-lg font-semibold" style={{ color: "var(--ink-black)" }}>{title}</h3>
      <p className="mt-2 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>{description}</p>
      <Link
        to={to}
        className="kn-ink-link mt-5 inline-flex text-sm font-semibold"
        style={{ color: "var(--ink-strong)" }}
      >
        {action} →
      </Link>
    </PaperCard>
  );
}

function IconBox({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
      style={{ background: "var(--ink-wash)", color: "var(--ink-strong)" }}
    >
      {children}
    </span>
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
