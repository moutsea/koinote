import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { User } from "../api";
import { getAgentSessionSettings, updateAgentSessionSettings, type AgentPermission } from "../agentSessions";
import { getWritingConfig } from "../writingAgent";
import { useI18n } from "../i18n";
import { agentPanelText } from "../i18n/agentPanel";
import { AgentGitHubCredentialCard } from "./AgentGitHubCredentialCard";
import { PaperCard } from "./Ink";

export function KoiPage({ user }: { user: User }) {
  const { t } = useI18n();
  if (user.isLocalMode) {
    return <p className="rounded-xl border p-5 text-sm leading-6" style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}>{t.koi.localMode}</p>;
  }
  return <AccountKoiSettings key={user.authUserId} user={user} />;
}

function AccountKoiSettings({ user }: { user: User }) {
  const { t, locale } = useI18n();
  const labels = t.koi;
  const panel = agentPanelText[locale];
  const client = useQueryClient();
  const member = user.membershipTier === "lifetime";
  // Share the bottom panel's account-scoped cache and existing settings API.
  const settingsKey = ["agent-session-settings", user.authUserId];
  const settings = useQuery({ queryKey: settingsKey, queryFn: getAgentSessionSettings, enabled: member, retry: false });
  const config = useQuery({ queryKey: ["writing-config", user.authUserId], queryFn: getWritingConfig, enabled: member, retry: false });
  const save = useMutation({
    mutationFn: updateAgentSessionSettings,
    onSuccess: (result) => client.setQueryData(settingsKey, result),
    onSettled: () => client.invalidateQueries({ queryKey: settingsKey, exact: true }),
  });
  const permission = settings.data?.permission ?? "review";
  const help = { review: panel.reviewHelp, assist: panel.approvalHelp, full: panel.fullHelp };

  return (
    <section aria-labelledby="koi-settings-title" className="space-y-5">
      <header>
        <h2 id="koi-settings-title" className="kn-heading-cn text-xl font-semibold">{labels.title}</h2>
        <p className="mt-2 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{labels.subtitle}</p>
      </header>
      <PaperCard className="space-y-4 p-5">
        <h3 className="text-sm font-semibold">{labels.serviceTitle}</h3>
        <p className="text-xs leading-5" style={{ color: "var(--ink-faint)" }}>{labels.serviceDescription}</p>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between gap-3"><dt>{labels.membershipLabel}</dt><dd>{member ? labels.membershipLifetime : labels.membershipNone}</dd></div>
          <div className="flex justify-between gap-3"><dt>{labels.modelLabel}</dt><dd>{labels.modelManaged}</dd></div>
          {member && <div className="flex justify-between gap-3"><dt>{labels.serviceTitle}</dt><dd>{config.isPending ? labels.loading : config.isError ? labels.loadFailed : config.data?.enabled ? labels.serviceConfigured : labels.serviceNotConfigured}</dd></div>}
        </dl>
        <Link to="/settings" search={{ section: "ai" }} hash="agent-credits" className="inline-block text-sm underline">{labels.creditsLink}</Link>
      </PaperCard>
      {member ? <PaperCard className="space-y-3 p-5">
        <label htmlFor="koi-default-permission" className="block text-sm font-semibold">{panel.defaults}</label>
        <p className="text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{labels.defaultsDescription}</p>
        {settings.isPending ? <p role="status" className="text-sm">{labels.loading}</p> : settings.data && <>
          <select id="koi-default-permission" value={permission} disabled={settings.isError || save.isPending}
            className="rounded-lg border bg-[var(--ink-paper)] px-3 py-2 text-sm disabled:opacity-50"
            onChange={(event) => save.mutate(event.target.value as AgentPermission)}>
            {(["review", "assist", "full"] as const).map((mode) => <option key={mode} value={mode}>{panel[mode]}</option>)}
          </select>
          <p className="text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{help[permission]}</p>
        </>}
        <p className="text-xs leading-5" style={{ color: "var(--ink-faint)" }}>{labels.defaultsScope}</p>
        {save.isSuccess && <p role="status" className="text-xs">{labels.saved}</p>}
        {save.isError && <p role="alert" className="text-xs" style={{ color: "var(--cinnabar)" }}>{labels.saveFailed}</p>}
      </PaperCard> : <Link to="/pricing" className="inline-block rounded-full border px-5 py-2 text-sm">{labels.upgrade}</Link>}
      {(settings.isError || config.isError) && <div role="alert" className="flex items-center gap-3 text-sm" style={{ color: "var(--cinnabar)" }}>
        <p>{labels.loadFailed}</p>
        <button type="button" disabled={settings.isFetching || config.isFetching} className="underline disabled:opacity-50"
          onClick={() => { if (settings.isError) void settings.refetch(); if (config.isError) void config.refetch(); }}>{labels.retry}</button>
      </div>}
      <AgentGitHubCredentialCard />
    </section>
  );
}
