import { Link } from "@tanstack/react-router";
import { Bot } from "lucide-react";
import { useSession } from "../auth";
import { AgentCreditsCard } from "../components/AgentCreditsCard";
import { AgentModelSettingsCard } from "../components/AgentModelSettingsCard";
import { LLMChannelsCard } from "../components/LLMChannelsCard";
import { MCPAccessCard } from "../components/MCPAccessCard";
import { PageContainer } from "../components/PageContainer";
import { useI18n } from "../i18n";

export function AISettingsPage() {
  const session = useSession();
  const { t } = useI18n();

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
          className="rounded-full px-6 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
          style={{ background: "var(--cinnabar)" }}
        >
          {t.dashboard.goLogin}
        </Link>
      </div>
    );
  }

  return (
    <PageContainer className="flex-1 py-10">
      <div className="flex items-start gap-3">
        <Bot className="mt-1 h-6 w-6 shrink-0" style={{ color: "var(--ink-mid)" }} />
        <div>
          <h1 className="kn-heading-cn text-2xl font-bold tracking-tight" style={{ color: "var(--ink-black)" }}>
            {t.aiSettings.title}
          </h1>
          <p className="mt-2 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
            {t.aiSettings.subtitle}
          </p>
        </div>
      </div>

      <div id="agent-model" className="mt-8 scroll-mt-20">
        <AgentModelSettingsCard user={user} />
      </div>

      <div id="llm-channels" className="mt-4 scroll-mt-20">
        <LLMChannelsCard user={user} />
      </div>

      <div id="agent-credits" className="mt-4 scroll-mt-20">
        <AgentCreditsCard user={user} />
      </div>

      <div id="mcp" className="mt-4 scroll-mt-20">
        <MCPAccessCard user={user} />
      </div>
    </PageContainer>
  );
}
