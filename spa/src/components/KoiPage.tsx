import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, ChevronDown, CircleCheck, Coins, Crown, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { User } from "../api";
import { getAgentSessionSettings, updateAgentSessionSettings } from "../agentSessions";
import { getWritingConfig } from "../writingAgent";
import { useI18n } from "../i18n";
import { agentPanelText } from "../i18n/agentPanel";
import { AgentGitHubCredentialCard } from "./AgentGitHubCredentialCard";
import { AgentCreditsCard } from "./AgentCreditsCard";
import { PaperCard } from "./Ink";
import { Logo } from "./Logo";

export function KoiPage({ user }: { user: User }) {
  const { t } = useI18n();
  if (user.isLocalMode) {
    return <PaperCard className="flex items-start gap-4 p-6">
      <Logo className="h-10 w-10" />
      <div><h2 className="text-base font-semibold">{t.koi.title}</h2><p className="mt-2 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{t.koi.localMode}</p></div>
    </PaperCard>;
  }
  return <AccountKoiSettings key={user.authUserId} user={user} />;
}

function AccountKoiSettings({ user }: { user: User }) {
  const { t, locale } = useI18n();
  const labels = t.koi;
  const panel = agentPanelText[locale];
  const client = useQueryClient();
  const member = user.membershipTier === "lifetime";
  const [creditsOpen, setCreditsOpen] = useState(false);
  // Share the bottom panel's account-scoped cache and existing settings API.
  const settingsKey = ["agent-session-settings", user.authUserId];
  const settings = useQuery({ queryKey: settingsKey, queryFn: getAgentSessionSettings, enabled: member, retry: false });
  const config = useQuery({ queryKey: ["writing-config", user.authUserId], queryFn: getWritingConfig, enabled: member, retry: false });
  const save = useMutation({
    mutationFn: updateAgentSessionSettings,
    onSuccess: (result) => client.setQueryData(settingsKey, result),
    onSettled: () => client.invalidateQueries({ queryKey: settingsKey, exact: true }),
  });
  const permission = save.isPending ? save.variables : settings.data?.permission;
  const help = { review: panel.reviewHelp, assist: panel.approvalHelp, full: panel.fullHelp };

  return (
    <section aria-labelledby="koi-settings-title" className="space-y-5">
      <PaperCard className="overflow-hidden">
        <header className="flex flex-wrap items-start justify-between gap-4 p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <Logo className="h-10 w-10" />
            <div>
              <h2 id="koi-settings-title" className="kn-heading-cn text-lg font-semibold">{labels.title}</h2>
              <p className="mt-1 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{labels.serviceDescription}</p>
            </div>
          </div>
          <button type="button" aria-expanded={creditsOpen} aria-controls="koi-credits" onClick={() => setCreditsOpen((open) => !open)} className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition hover:bg-[var(--ink-wash)]" style={{ borderColor: "var(--ink-line)" }}>
            <Coins aria-hidden className="h-3.5 w-3.5" />{labels.creditsLink}<ChevronDown aria-hidden className={`h-3.5 w-3.5 transition-transform ${creditsOpen ? "rotate-180" : ""}`} />
          </button>
        </header>
        <dl className="grid gap-3 border-t px-5 py-4 sm:grid-cols-3 sm:gap-4 sm:px-6" style={{ borderColor: "var(--ink-line)", background: "var(--ink-wash)" }}>
          <div className="flex items-center justify-between gap-3 sm:block"><dt className="text-xs" style={{ color: "var(--ink-mid)" }}>{labels.membershipLabel}</dt><dd className="flex items-center gap-1.5 text-sm font-medium sm:mt-1.5">{member && <Crown aria-hidden className="h-3.5 w-3.5" style={{ color: "var(--cinnabar)" }} />}{member ? labels.membershipLifetime : labels.membershipNone}</dd></div>
          <div className="flex items-center justify-between gap-3 sm:block"><dt className="text-xs" style={{ color: "var(--ink-mid)" }}>{labels.modelLabel}</dt><dd className="text-sm font-medium sm:mt-1.5">{labels.modelManaged}</dd></div>
          {member && <div className="flex items-center justify-between gap-3 sm:block"><dt className="text-xs" style={{ color: "var(--ink-mid)" }}>{labels.serviceTitle}</dt><dd className="flex items-center gap-1.5 text-sm font-medium sm:mt-1.5">
            {config.isPending ? <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" /> : !config.isError && config.data?.enabled && <CircleCheck aria-hidden className="h-3.5 w-3.5" />}
            {config.isPending ? labels.loading : config.isError ? labels.loadFailed : config.data?.enabled ? labels.serviceConfigured : labels.serviceNotConfigured}
          </dd></div>}
        </dl>
        {config.isError && <div role="alert" className="flex items-center justify-between gap-3 border-t px-5 py-3 text-xs sm:px-6" style={{ borderColor: "var(--ink-line)", color: "var(--cinnabar)" }}>
          <p>{labels.loadFailed}</p><button type="button" disabled={config.isFetching} onClick={() => void config.refetch()} className="inline-flex shrink-0 items-center gap-1.5 rounded px-2 py-1 font-semibold disabled:opacity-50"><RefreshCw aria-hidden className={`h-3.5 w-3.5 ${config.isFetching ? "animate-spin" : ""}`} />{labels.retry}</button>
        </div>}
      </PaperCard>
      <section id="koi-credits" aria-label={labels.creditsLink} hidden={!creditsOpen}>
        {creditsOpen && <AgentCreditsCard user={user} />}
      </section>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <PaperCard className="p-5 sm:p-6">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 id="koi-permission-title" className="text-sm font-semibold">{panel.defaults}</h3>
            <span role="status" aria-live="polite" className="inline-flex min-h-5 items-center gap-1.5 text-xs" style={{ color: "var(--ink-mid)" }}>
              {save.isPending ? <><LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />{labels.saving}</> : save.isSuccess ? <><Check aria-hidden className="h-3.5 w-3.5" />{labels.saved}</> : member && labels.autoSave}
            </span>
          </div>
          <p id="koi-permission-description" className="text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{labels.defaultsDescription}</p>
          {member ? <>
            {settings.isPending ? <p role="status" className="flex items-center gap-2 py-8 text-sm" style={{ color: "var(--ink-mid)" }}><LoaderCircle aria-hidden className="h-4 w-4 animate-spin" />{labels.loading}</p> : settings.data &&
              <fieldset id="koi-default-permission" aria-labelledby="koi-permission-title" aria-describedby="koi-permission-description koi-permission-scope" disabled={settings.isError || save.isPending} className="mt-4 space-y-2.5 disabled:opacity-60">
                {(["review", "assist", "full"] as const).map((mode) => <label key={mode} className="flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition hover:bg-[var(--ink-wash)] focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--cinnabar)] has-disabled:cursor-not-allowed"
                  style={{ borderColor: permission === mode ? "var(--cinnabar)" : "var(--ink-line)", background: permission === mode ? "color-mix(in srgb, var(--cinnabar) 5%, var(--ink-paper-soft))" : undefined }}>
                  <input type="radio" name="koi-default-permission" value={mode} checked={permission === mode} onChange={() => save.mutate(mode)} className="mt-1 h-4 w-4 shrink-0 accent-[var(--cinnabar)]" />
                  <span><span className="block text-sm font-semibold">{panel[mode]}</span><span className="mt-1 block text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{help[mode]}</span></span>
                </label>)}
              </fieldset>}
            {settings.isError && <div role="alert" className="mt-4 flex items-center justify-between gap-3 text-xs" style={{ color: "var(--cinnabar)" }}>
              <p>{labels.loadFailed}</p><button type="button" disabled={settings.isFetching} className="shrink-0 rounded px-2 py-1 font-semibold disabled:opacity-50" onClick={() => void settings.refetch()}>{labels.retry}</button>
            </div>}
            {save.isError && <div role="alert" className="mt-4 flex items-center justify-between gap-3 text-xs" style={{ color: "var(--cinnabar)" }}>
              <p>{labels.saveFailed}</p><button type="button" className="shrink-0 rounded px-2 py-1 font-semibold" onClick={() => { if (save.variables) save.mutate(save.variables); }}>{labels.retry}</button>
            </div>}
          </> : <div className="mt-5 rounded-xl p-4" style={{ background: "var(--ink-wash)" }}>
            <p className="text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{labels.membersOnly}</p>
            <Link to="/pricing" className="mt-3 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}><Crown aria-hidden className="h-3.5 w-3.5" />{labels.upgrade}</Link>
          </div>}
          <p id="koi-permission-scope" className="mt-4 flex items-start gap-2 border-t pt-4 text-xs leading-5" style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}><ShieldCheck aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />{labels.defaultsScope}</p>
        </PaperCard>
        <AgentGitHubCredentialCard />
      </div>
    </section>
  );
}
