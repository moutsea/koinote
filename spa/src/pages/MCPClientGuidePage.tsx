import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { InkClouds, PaperCard } from "../components/Ink";
import { PageContainer } from "../components/PageContainer";
import { useI18n } from "../i18n";
import { mcpKnowledge } from "../i18n/mcpKnowledge";
import { MCP_CLIENTS, MCP_TOKEN_SETUP, type MCPClientId } from "../mcpKnowledge";

function ConfigurationBlock({ label, code }: { label: string; code: string }) {
  const { locale } = useI18n();
  const copy = mcpKnowledge[locale];
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  }

  return (
    <PaperCard className="mt-5 min-w-0 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3" style={{ borderColor: "var(--ink-line)" }}>
        <h3 className="break-all text-sm font-semibold">{label}</h3>
        <button type="button" onClick={copyCode} className="rounded-lg border px-3 py-1.5 text-sm" style={{ borderColor: "var(--ink-line)" }} aria-label={`${copy.copy} · ${label}`}>{copy.copy}</button>
      </div>
      <pre tabIndex={0} className="overflow-x-auto p-5 text-xs leading-6" style={{ background: "var(--ink-wash)", color: "var(--ink-strong)" }}><code>{code}</code></pre>
      <p role="status" className="px-5 text-sm leading-7">{status === "copied" ? copy.copied : status === "failed" ? copy.copyFailed : ""}</p>
    </PaperCard>
  );
}

function MCPClientGuidePage({ clientId }: { clientId: MCPClientId }) {
  const { locale, t } = useI18n();
  const copy = mcpKnowledge[locale];
  const client = MCP_CLIENTS.find((item) => item.id === clientId)!;

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <InkClouds />
      <PageContainer className="relative flex-1 py-14 sm:py-20">
        <article className="mx-auto max-w-3xl">
          <Link to="/docs/mcp" search={{ lang: locale }} className="text-sm underline">{copy.back}</Link>
          <h1 className="kn-heading-cn mt-6 text-3xl font-bold sm:text-4xl">{client.name} · {copy.clientTitle}</h1>
          <p className="mt-5 leading-7" style={{ color: "var(--ink-mid)" }}>{copy.clientDescriptions[clientId]}</p>
          <p className="mt-3 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>{copy.membership}</p>
          <Link to="/settings" search={{ section: "ai" }} hash="mcp" className="mt-4 inline-block text-sm underline">{t.mcpGuide.tokensCta}</Link>
          <section className="mt-10">
            <h2 className="text-xl font-semibold">{copy.environmentTitle}</h2>
            <p className="mt-3 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>{copy.environmentHelp}</p>
            <ConfigurationBlock label="Bash" code={MCP_TOKEN_SETUP} />
            {client.blocks.map((block) => <ConfigurationBlock key={block.label} label={block.label} code={block.code} />)}
            <p className="mt-5 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>{copy.clientNotes[clientId]}</p>
            <a href={client.source} className="mt-3 inline-block text-sm underline" rel="noreferrer">{copy.official}</a>
          </section>
          <section className="mt-10">
            <h2 className="text-xl font-semibold">{copy.verifyTitle}</h2>
            <p className="mt-3 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>{copy.verify}</p>
            <p className="mt-3 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>{copy.repositorySetup}</p>
            <Link to="/docs/mcp" search={{ lang: locale }} className="mt-5 inline-block text-sm underline">{copy.back}</Link>
          </section>
        </article>
      </PageContainer>
    </div>
  );
}

export function CodexMCPGuidePage() {
  return <MCPClientGuidePage clientId="codex" />;
}
export function ClaudeCodeMCPGuidePage() {
  return <MCPClientGuidePage clientId="claude-code" />;
}
export function OpenCodeMCPGuidePage() {
  return <MCPClientGuidePage clientId="opencode" />;
}
export function OpenClawMCPGuidePage() {
  return <MCPClientGuidePage clientId="openclaw" />;
}
