import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Check, Cloud, LoaderCircle, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { getAgentWorkspaceSettings, updateAgentWorkspaceSettings } from "../api";
import { useSession } from "../auth";
import { MCPAccessCard } from "../components/MCPAccessCard";
import { PaperCard } from "../components/Ink";
import { PageContainer } from "../components/PageContainer";
import { useI18n } from "../i18n";

export function AgentWorkspaceSettingsPage() {
  const session = useSession();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const user = session.data?.user;
  const settings = useQuery({ queryKey: ["agent-workspace-settings"], queryFn: getAgentWorkspaceSettings, enabled: Boolean(user && !user.isLocalMode), retry: false });
  const enable = useMutation({ mutationFn: () => updateAgentWorkspaceSettings(true), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agent-workspace-settings"] }) });

  if (session.isLoading) return <PageLoading>{t.dashboard.loading}</PageLoading>;
  if (!user) return <PageMessage>{t.dashboard.loginRequired}</PageMessage>;
  if (user.isLocalMode) return <PageMessage>{t.agentWorkspace.localMode}</PageMessage>;
  if (user.membershipTier !== "lifetime") return <PageMessage><p>{t.agentWorkspace.membersOnly}</p><Link to="/pricing" className="mt-4 inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>{t.mcp.upgrade}</Link></PageMessage>;
  if (settings.isLoading) return <PageLoading>{t.agentWorkspace.loading}</PageLoading>;
  if (settings.isError) return <PageMessage>{t.agentWorkspace.repositoryLoadFailed}</PageMessage>;
  const enabled = settings.data?.enabled === true;

  return <PageContainer className="flex-1 py-7 sm:py-10">
    <Link to="/agent/workspaces" className="inline-flex items-center gap-1.5 text-sm font-medium transition-opacity hover:opacity-70" style={{ color: "var(--ink-mid)" }}><ArrowLeft className="h-4 w-4" />{t.agentWorkspace.backToRepositories}</Link>
    <header className="mt-6 flex items-start gap-4 border-b pb-7" style={{ borderColor: "var(--ink-line)" }}><div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}><Cloud className="h-6 w-6" /></div><div><h1 className="kn-heading-cn text-2xl font-bold tracking-tight sm:text-3xl" style={{ color: "var(--ink-black)" }}>{t.agentWorkspace.settingsTitle}</h1><p className="mt-2 max-w-2xl text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.settingsDescription}</p></div></header>
    <main className="mt-7 max-w-4xl space-y-5">
      {!enabled && <PaperCard className="p-6 sm:p-7"><div className="flex items-start gap-3"><span className="rounded-lg p-2.5" style={{ background: "var(--ink-wash)", color: "var(--ink-strong)" }}><ShieldCheck className="h-5 w-5" /></span><div className="min-w-0 flex-1"><h2 className="kn-heading-cn text-lg font-bold" style={{ color: "var(--ink-black)" }}>{t.agentWorkspace.title}</h2><p className="mt-2 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.description}</p><button type="button" disabled={enable.isPending} onClick={() => enable.mutate()} className="mt-5 inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold disabled:opacity-50" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>{enable.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Cloud className="h-4 w-4" />}{t.agentWorkspace.enable}</button>{enable.isError && <p className="mt-3 text-sm" role="alert" style={{ color: "var(--cinnabar)" }}>{t.agentWorkspace.enableFailed}</p>}</div></div></PaperCard>}
      {enabled && <MCPAccessCard user={user} agentOnly workspaceEnabled title={t.agentWorkspace.tokenSettingsTitle} />}
    </main>
  </PageContainer>;
}

function PageLoading({ children }: { children: string }) { return <div className="flex flex-1 items-center justify-center py-24 text-sm" style={{ color: "var(--ink-faint)" }}>{children}</div>; }
function PageMessage({ children }: { children: ReactNode }) { return <div className="flex flex-1 flex-col items-center justify-center px-4 py-24 text-center text-sm" style={{ color: "var(--ink-mid)" }}>{children}</div>; }
