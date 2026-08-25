import { Link } from "@tanstack/react-router";
import { Bot, Check, KeyRound, ShieldCheck } from "lucide-react";
import { InkClouds, PaperCard } from "../components/Ink";
import { PageContainer } from "../components/PageContainer";
import { useI18n } from "../i18n";

const ENDPOINT = "https://koinote.app/mcp";
const CLIENTS = [
  {
    name: "Codex",
    code: `export KOINOTE_MCP_TOKEN='knt_mcp_...'

# ~/.codex/config.toml
[mcp_servers.koinote]
url = "${ENDPOINT}"
bearer_token_env_var = "KOINOTE_MCP_TOKEN"`,
  },
  {
    name: "Claude Code",
    code: `export KOINOTE_MCP_TOKEN='knt_mcp_...'

claude mcp add --transport http koinote ${ENDPOINT} \\
  --header "Authorization: Bearer \${KOINOTE_MCP_TOKEN}"`,
  },
  {
    name: "OpenCode",
    code: `export KOINOTE_MCP_TOKEN='knt_mcp_...'

// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "koinote": {
      "type": "remote",
      "url": "${ENDPOINT}",
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:KOINOTE_MCP_TOKEN}"
      }
    }
  }
}`,
  },
  {
    name: "OpenClaw",
    code: `export KOINOTE_MCP_TOKEN='knt_mcp_...'

openclaw mcp add koinote \\
  --url ${ENDPOINT} \\
  --transport streamable-http \\
  --header "Authorization=Bearer \${KOINOTE_MCP_TOKEN}"

openclaw mcp doctor koinote --probe`,
  },
  {
    name: "WorkBuddy / Other clients",
    code: `Transport: Streamable HTTP
URL: ${ENDPOINT}
Header: Authorization: Bearer knt_mcp_...`,
  },
] as const;

export function MCPGuidePage() {
  const { t } = useI18n();

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <InkClouds />
      <PageContainer className="relative flex-1 py-14 sm:py-20">
        <header className="mx-auto max-w-3xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: "var(--ink-mid)" }}>
            {t.mcpGuide.eyebrow}
          </p>
          <h1 className="kn-heading-cn mt-4 text-3xl font-bold tracking-tight sm:text-5xl" style={{ color: "var(--ink-black)" }}>
            {t.mcpGuide.title}
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-7" style={{ color: "var(--ink-mid)" }}>
            {t.mcpGuide.subtitle}
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link to="/settings" search={{ section: "ai" }} hash="mcp" className="rounded-full px-5 py-2.5 text-sm font-semibold transition hover:opacity-85" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>{t.mcpGuide.tokensCta}</Link>
            <Link to="/docs/version-history" className="rounded-full border px-5 py-2.5 text-sm font-semibold transition hover:bg-[var(--ink-wash)]" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}>{t.mcpGuide.historyCta}</Link>
            <Link to="/pricing" className="rounded-full border px-5 py-2.5 text-sm font-semibold transition hover:bg-[var(--ink-wash)]" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}>{t.mcpGuide.pricingCta}</Link>
          </div>
        </header>

        <section className="mx-auto mt-12 grid max-w-5xl gap-5 md:grid-cols-[1.1fr_1fr]">
          <PaperCard className="p-6 sm:p-7">
            <div className="flex items-center gap-3">
              <IconBox><Bot className="h-5 w-5" /></IconBox>
              <h2 className="kn-heading-cn text-xl font-bold" style={{ color: "var(--ink-black)" }}>{t.mcpGuide.overviewTitle}</h2>
            </div>
            <p className="mt-4 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>{t.mcpGuide.overviewBody}</p>
          </PaperCard>
          <PaperCard className="p-6 sm:p-7">
            <div className="flex items-center gap-3">
              <IconBox><KeyRound className="h-5 w-5" /></IconBox>
              <h2 className="kn-heading-cn text-xl font-bold" style={{ color: "var(--ink-black)" }}>{t.mcpGuide.setupTitle}</h2>
            </div>
            <ol className="mt-4 space-y-3">
              {t.mcpGuide.setupSteps.map((step, index) => (
                <li key={step.title} className="flex gap-3 text-sm leading-6">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}>{index + 1}</span>
                  <span><strong style={{ color: "var(--ink-strong)" }}>{step.title}</strong><span className="block" style={{ color: "var(--ink-mid)" }}>{step.desc}</span></span>
                </li>
              ))}
            </ol>
          </PaperCard>
        </section>

        <section className="mx-auto mt-16 max-w-5xl">
          <h2 className="kn-heading-cn text-2xl font-bold" style={{ color: "var(--ink-black)" }}>{t.mcpGuide.clientsTitle}</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{t.mcpGuide.clientsSubtitle}</p>
          <div className="mt-6 space-y-5">
            {CLIENTS.map((client, index) => (
              <PaperCard key={client.name} className="overflow-hidden">
                <div className="border-b px-5 py-4 sm:px-6" style={{ borderColor: "var(--ink-line)" }}>
                  <h3 className="font-semibold" style={{ color: "var(--ink-black)" }}>{client.name}</h3>
                  <p className="mt-1 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{t.mcpGuide.clientDescriptions[index]}</p>
                </div>
                <pre className="overflow-x-auto p-5 text-xs leading-5 sm:p-6" style={{ background: "var(--ink-wash)", color: "var(--ink-strong)" }}><code>{client.code}</code></pre>
              </PaperCard>
            ))}
          </div>
          <p className="mt-3 text-xs" style={{ color: "var(--ink-faint)" }}>{t.mcpGuide.tokenPlaceholder}</p>
        </section>

        <section className="mx-auto mt-16 grid max-w-5xl gap-5 lg:grid-cols-2">
          <PaperCard className="p-6 sm:p-7">
            <h2 className="kn-heading-cn text-xl font-bold" style={{ color: "var(--ink-black)" }}>{t.mcpGuide.usageTitle}</h2>
            <p className="mt-3 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{t.mcpGuide.usageBody}</p>
            <p className="mt-5 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--ink-faint)" }}>{t.mcpGuide.verifyLabel}</p>
            <ul className="mt-3 space-y-2.5">
              {t.mcpGuide.prompts.map((prompt) => <CheckItem key={prompt}>{prompt}</CheckItem>)}
            </ul>
          </PaperCard>
          <PaperCard className="p-6 sm:p-7">
            <div className="flex items-center gap-3">
              <IconBox><ShieldCheck className="h-5 w-5" /></IconBox>
              <h2 className="kn-heading-cn text-xl font-bold" style={{ color: "var(--ink-black)" }}>{t.mcpGuide.permissionsTitle}</h2>
            </div>
            <ul className="mt-5 space-y-3">
              {t.mcpGuide.permissions.map((item) => <CheckItem key={item}>{item}</CheckItem>)}
            </ul>
          </PaperCard>
        </section>

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
