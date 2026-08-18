import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, LoaderCircle } from "lucide-react";
import type { User } from "../api";
import {
  AGENT_SETTINGS_QUERY_KEY,
  getAgentSettings,
  updateAgentSettings,
  type AgentSettings,
} from "../api";
import { useI18n } from "../i18n";
import { PaperCard } from "./Ink";

export function AgentModelSettingsCard({ user }: { user: User }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const member = user.membershipTier === "lifetime";
  const settings = useQuery({
    queryKey: AGENT_SETTINGS_QUERY_KEY,
    queryFn: getAgentSettings,
    enabled: member && !user.isLocalMode,
    retry: false,
  });
  const update = useMutation({
    mutationFn: updateAgentSettings,
    onSuccess(result) {
      queryClient.setQueryData(AGENT_SETTINGS_QUERY_KEY, result);
    },
  });
  const currentMode = settings.data?.settings.providerMode ?? "builtin";

  return (
    <PaperCard className="p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <Bot className="mt-0.5 h-5 w-5 shrink-0" style={{ color: "var(--ink-faint)" }} />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold" style={{ color: "var(--ink-black)" }}>
            {t.agentModelSettings.title}
          </h2>
          <p className="mt-1 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
            {member ? t.agentModelSettings.description : t.agentModelSettings.membersOnly}
          </p>
        </div>
      </div>

      {member && settings.isLoading && (
        <p className="mt-4 flex items-center gap-2 text-sm" style={{ color: "var(--ink-faint)" }}>
          <LoaderCircle className="h-4 w-4 animate-spin" />
          {t.agentModelSettings.loading}
        </p>
      )}

      {member && settings.isError && (
        <p className="mt-4 text-sm" role="alert" style={{ color: "var(--cinnabar)" }}>
          {t.agentModelSettings.loadFailed}
        </p>
      )}

      {member && settings.data && (
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <ModeButton
            active={currentMode === "builtin"}
            title={t.agentModelSettings.builtIn}
            description={t.agentModelSettings.builtInHint}
            disabled={update.isPending}
            onClick={() => update.mutate("builtin")}
          />
          <ModeButton
            active={currentMode === "byok"}
            title={t.agentModelSettings.byok}
            description={
              settings.data.settings.defaultChannel
                ? `${settings.data.settings.defaultChannel.name} · ${settings.data.settings.defaultChannel.model}`
                : t.agentModelSettings.byokUnavailable
            }
            disabled={update.isPending || !settings.data.settings.defaultChannel}
            onClick={() => update.mutate("byok")}
          />
        </div>
      )}

      {update.isError && (
        <p className="mt-4 text-sm" role="alert" style={{ color: "var(--cinnabar)" }}>
          {t.agentModelSettings.saveFailed}
        </p>
      )}
    </PaperCard>
  );
}

function ModeButton({
  active,
  title,
  description,
  disabled,
  onClick,
}: {
  active: boolean;
  title: string;
  description: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className="flex min-h-24 items-start gap-3 rounded-lg border p-4 text-left transition hover:bg-[var(--ink-wash)] disabled:cursor-not-allowed disabled:opacity-55"
      style={{ borderColor: active ? "var(--ink-strong)" : "var(--ink-line)" }}
    >
      <span
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border"
        style={{
          borderColor: active ? "var(--ink-strong)" : "var(--ink-line)",
          background: active ? "var(--ink-strong)" : "transparent",
          color: "var(--ink-paper)",
        }}
      >
        {active && <Check className="h-3 w-3" />}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold" style={{ color: "var(--ink-strong)" }}>{title}</span>
        <span className="mt-1 block text-xs leading-5" style={{ color: "var(--ink-faint)" }}>{description}</span>
      </span>
    </button>
  );
}
