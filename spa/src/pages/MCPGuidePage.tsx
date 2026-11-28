import { Link } from "@tanstack/react-router";
import { InkClouds, PaperCard } from "../components/Ink";
import { PageContainer } from "../components/PageContainer";
import { useI18n } from "../i18n";
import { mcpKnowledge } from "../i18n/mcpKnowledge";
import { MCP_CLIENTS, MCP_CONNECTIONS, MCP_TOOL_GROUPS } from "../mcpKnowledge";

export function MCPGuidePage() {
  const { t, locale } = useI18n();
  const copy = mcpKnowledge[locale];

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <InkClouds />
      <PageContainer className="relative flex-1 py-14 sm:py-20">
        <header className="mx-auto max-w-3xl text-center">
          <h1 className="kn-heading-cn text-3xl font-bold sm:text-5xl" style={{ color: "var(--ink-black)" }}>{copy.title}</h1>
          <p className="mt-5 text-base leading-7" style={{ color: "var(--ink-mid)" }}>{copy.positioning}</p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link to="/settings" search={{ section: "ai" }} hash="mcp" className="rounded-full px-5 py-2.5 text-sm font-semibold" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>{t.mcpGuide.tokensCta}</Link>
            <Link to="/docs/version-history" className="rounded-full border px-5 py-2.5 text-sm font-semibold" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}>{t.mcpGuide.historyCta}</Link>
            <Link to="/pricing" className="rounded-full border px-5 py-2.5 text-sm font-semibold" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}>{t.mcpGuide.pricingCta}</Link>
          </div>
        </header>

        <section className="mx-auto mt-12 max-w-5xl">
          <h2 className="kn-heading-cn text-2xl font-bold">{copy.connectionsTitle}</h2>
          <p className="mt-3 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>{copy.membership}</p>
          <p className="mt-3 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>{copy.toolsIntro}</p>
          <div className="mt-6 space-y-6">
            {MCP_CONNECTIONS.map((connection) => (
              <PaperCard key={connection.id} className="p-5 sm:p-7">
                <h3 className="text-xl font-semibold">{copy.connections[connection.id].title}</h3>
                <p className="mt-3 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>{copy.connections[connection.id].description}</p>
                <p className="mt-3 break-all text-sm"><code>{connection.name}</code> · <code>{connection.endpoint}</code></p>
                {connection.id === "repositories" && <Link to="/space/settings" className="mt-3 inline-block text-sm underline">{t.agentWorkspace.tokenSettingsTitle}</Link>}
                <h4 className="mt-6 font-semibold">{copy.toolsTitle}</h4>
                {MCP_TOOL_GROUPS.filter((group) => group.connection === connection.id).map((group) => (
                  <section key={group.tools[0]} className="mt-4">
                    <h5 className="text-sm font-semibold">{copy.kinds[group.kind]} ({group.tools.length})</h5>
                    <p className="mt-1 text-xs" style={{ color: "var(--ink-mid)" }}>{copy.scopeLabel} <code>{group.scopes.join(" / ")}</code></p>
                    <ul className="mt-2 grid gap-x-5 gap-y-1 sm:grid-cols-2">
                      {group.tools.map((name) => <li key={name} className="break-all text-xs leading-6"><code>{name}</code></li>)}
                    </ul>
                  </section>
                ))}
              </PaperCard>
            ))}
          </div>
        </section>

        <section className="mx-auto mt-12 max-w-5xl">
          <h2 className="kn-heading-cn text-2xl font-bold">{copy.clientTitle}</h2>
          <p className="mt-3 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>{copy.environmentHelp}</p>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            {MCP_CLIENTS.map((client) => (
              <Link key={client.id} to={client.path} search={{ lang: locale }} className="rounded-xl border p-5 hover:bg-[var(--ink-wash)]" style={{ borderColor: "var(--ink-line)" }}>
                <h3 className="font-semibold underline">{client.name}</h3>
                <p className="mt-2 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{copy.clientDescriptions[client.id]}</p>
              </Link>
            ))}
          </div>
          <h3 className="mt-6 font-semibold">{copy.genericTitle}</h3>
          <p className="mt-2 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>{copy.genericHelp}</p>
        </section>

        <section className="mx-auto mt-12 max-w-5xl">
          <h2 className="kn-heading-cn text-2xl font-bold">{copy.effectsTitle}</h2>
          <ul className="mt-4 list-disc space-y-3 pl-5 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>
            {copy.effects.map((item) => <li key={item}>{item}</li>)}
          </ul>
          <Link to="/pricing" className="mt-3 inline-block text-sm underline">{t.mcpGuide.pricingCta}</Link>
        </section>

        <section className="mx-auto mt-12 max-w-5xl">
          <h2 className="kn-heading-cn text-2xl font-bold">{copy.boundariesTitle}</h2>
          <ul className="mt-4 list-disc space-y-3 pl-5 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>
            {copy.boundaries.map((item) => <li key={item}>{item}</li>)}
          </ul>
          <a href="/llms.txt" className="mt-5 inline-block text-sm underline">llms.txt</a>
        </section>
      </PageContainer>
    </div>
  );
}
