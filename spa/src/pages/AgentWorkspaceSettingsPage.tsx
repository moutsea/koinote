import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowLeft, Check, Cloud, LoaderCircle, ShieldCheck } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ApiError, getAgentWorkspaceSettings, getAgentWorkspaceStorage, submitFeedback, updateAgentWorkspaceSettings } from "../api";
import { useSession } from "../auth";
import { MCPAccessCard } from "../components/MCPAccessCard";
import { AgentWorkspaceStorageCard } from "../components/AgentWorkspaceStorageCard";
import { PaperCard } from "../components/Ink";
import { PageContainer } from "../components/PageContainer";
import { useI18n } from "../i18n";

export function AgentWorkspaceSettingsPage() {
  const session = useSession();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { workspaceId } = useSearch({ strict: false }) as { workspaceId?: number };
  const user = session.data?.user;
  const settings = useQuery({ queryKey: ["agent-workspace-settings"], queryFn: getAgentWorkspaceSettings, enabled: Boolean(user && !user.isLocalMode), retry: false });
  const storage = useQuery({ queryKey: ["agent-workspace-storage"], queryFn: getAgentWorkspaceStorage, enabled: Boolean(user && !user.isLocalMode && settings.data?.enabled === true), retry: false });
  const enable = useMutation({
    mutationFn: () => updateAgentWorkspaceSettings(true),
    onSuccess: async (settings) => {
      queryClient.setQueryData(["agent-workspace-settings"], settings);
      await navigate({ to: "/space", search: { tab: "agent" } });
    },
  });

  if (session.isLoading) return <PageLoading>{t.dashboard.loading}</PageLoading>;
  if (!user) return <PageMessage>{t.dashboard.loginRequired}</PageMessage>;
  if (user.isLocalMode) return <PageMessage>{t.agentWorkspace.localMode}</PageMessage>;
  if (user.membershipTier !== "lifetime") return <PageMessage><p>{t.agentWorkspace.membersOnly}</p><Link to="/pricing" className="mt-4 inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>{t.mcp.upgrade}</Link></PageMessage>;
  if (settings.isLoading) return <PageLoading>{t.agentWorkspace.loading}</PageLoading>;
  if (settings.isError) return <PageMessage>{t.agentWorkspace.repositoryLoadFailed}</PageMessage>;
  const enabled = settings.data?.enabled === true;

  return <PageContainer className="flex-1 py-7 sm:py-10">
    <Link to="/space" search={{ tab: "agent" }} className="inline-flex items-center gap-1.5 text-sm font-medium transition-opacity hover:opacity-70" style={{ color: "var(--ink-mid)" }}><ArrowLeft className="h-4 w-4" />{t.agentWorkspace.backToRepositories}</Link>
    <header className="mt-6 flex items-start gap-4 border-b pb-7" style={{ borderColor: "var(--ink-line)" }}><div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}><Cloud className="h-6 w-6" /></div><div><h1 className="kn-heading-cn text-2xl font-bold tracking-tight sm:text-3xl" style={{ color: "var(--ink-black)" }}>{t.agentWorkspace.settingsTitle}</h1><p className="mt-2 max-w-2xl text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.settingsDescription}</p></div></header>
    <main className="mt-7 max-w-4xl space-y-5">
      {enabled && <PaperCard className="p-6 sm:p-7">
        <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--ink-strong)" }}><Check className="h-4 w-4" />{t.agentWorkspace.enabled}</div>
        <p className="mt-2 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.clientUploadWithoutToken}</p>
        {workspaceId && <div className="mt-4 border-t pt-4" style={{ borderColor: "var(--ink-line)" }}>
          <p role="status" className="text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.promptWriteTokenRequired}</p>
          <Link to="/agent/workspaces/$workspaceId" params={{ workspaceId: String(workspaceId) }} search={{ from: "space" }} className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold hover:underline" style={{ color: "var(--cinnabar)" }}><ArrowLeft className="h-4 w-4" />{t.agentWorkspace.backToRepository}</Link>
        </div>}
      </PaperCard>}
      {enabled && <PaperCard className="p-6 sm:p-7">
        <h2 className="kn-heading-cn text-lg font-bold" style={{ color: "var(--ink-black)" }}>{t.agentWorkspace.storageSettingsTitle}</h2>
        <p className="mt-2 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.storageSettingsDescription}</p>
        <div className="mt-4"><AgentWorkspaceStorageCard storage={storage.data?.storage} loading={storage.isFetching} error={storage.isError} onRetry={() => void storage.refetch()} showExpand={false} /></div>
        <StorageExpansionRequest />
      </PaperCard>}
      {!enabled && <PaperCard className="p-6 sm:p-7"><div className="flex items-start gap-3"><span className="rounded-lg p-2.5" style={{ background: "var(--ink-wash)", color: "var(--ink-strong)" }}><ShieldCheck className="h-5 w-5" /></span><div className="min-w-0 flex-1"><h2 className="kn-heading-cn text-lg font-bold" style={{ color: "var(--ink-black)" }}>{t.agentWorkspace.title}</h2><p className="mt-2 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.description}</p><button type="button" disabled={enable.isPending} onClick={() => enable.mutate()} className="mt-5 inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold disabled:opacity-50" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>{enable.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Cloud className="h-4 w-4" />}{t.agentWorkspace.enable}</button>{enable.isError && <p className="mt-3 text-sm" role="alert" style={{ color: "var(--cinnabar)" }}>{t.agentWorkspace.enableFailed}</p>}</div></div></PaperCard>}
      {enabled && <MCPAccessCard user={user} agentOnly workspaceEnabled title={t.agentWorkspace.tokenSettingsTitle} />}
    </main>
  </PageContainer>;
}

function StorageExpansionRequest() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const request = useMutation({
    mutationFn: () => submitFeedback({
      category: "experience",
      message: `[${t.agentWorkspace.storageRequest}]\n${message.trim()}`,
      pagePath: "/space/settings",
    }),
    onSuccess: () => setMessage(""),
  });
  const errorMessage = request.error instanceof ApiError && request.error.code && t.errors[request.error.code]
    ? t.errors[request.error.code]
    : t.agentWorkspace.storageRequestFailed;

  return <div className="mt-5 border-t pt-5" style={{ borderColor: "var(--ink-line)" }}>
    <p className="text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.storageExpansionDescription}</p>
    {request.isSuccess ? <p role="status" className="mt-3 text-sm" style={{ color: "var(--ink-strong)" }}>{t.agentWorkspace.storageRequestSent}</p> : open ? <form className="mt-4 space-y-3" onSubmit={(event) => {
      event.preventDefault();
      if (message.trim() && !request.isPending) request.mutate();
    }}>
      <label className="block text-sm font-medium">
        {t.agentWorkspace.storageRequestDetails}
        <textarea required maxLength={3000} rows={3} value={message} disabled={request.isPending} onChange={(event) => setMessage(event.target.value)} placeholder={t.agentWorkspace.storageRequestPlaceholder} className="mt-2 block w-full rounded-lg border bg-transparent px-3 py-2 text-sm disabled:opacity-50" style={{ borderColor: "var(--ink-line)" }} />
      </label>
      <p className="text-xs leading-5" style={{ color: "var(--ink-faint)" }}>{t.feedback.privacyHint}</p>
      {request.isError && <p role="alert" className="text-sm" style={{ color: "var(--cinnabar)" }}>{errorMessage}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={!message.trim() || request.isPending} className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>
          {request.isPending && <LoaderCircle className="h-4 w-4 animate-spin" />}
          {request.isPending ? t.feedback.submitting : t.agentWorkspace.storageRequestSubmit}
        </button>
        <button type="button" disabled={request.isPending} onClick={() => { setOpen(false); request.reset(); }} className="rounded-lg border px-4 py-2 text-sm disabled:opacity-50" style={{ borderColor: "var(--ink-line)" }}>{t.feedback.cancel}</button>
      </div>
    </form> : <button type="button" onClick={() => setOpen(true)} className="mt-3 rounded-lg px-4 py-2 text-sm font-semibold" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>{t.agentWorkspace.storageRequest}</button>}
  </div>;
}

function PageLoading({ children }: { children: string }) { return <div className="flex flex-1 items-center justify-center py-24 text-sm" style={{ color: "var(--ink-faint)" }}>{children}</div>; }
function PageMessage({ children }: { children: ReactNode }) { return <div className="flex flex-1 flex-col items-center justify-center px-4 py-24 text-center text-sm" style={{ color: "var(--ink-mid)" }}>{children}</div>; }
