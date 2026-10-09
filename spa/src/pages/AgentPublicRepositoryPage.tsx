import { Star } from "lucide-react";
import { updatePublicAgentRepositoryStar, recordPublicAgentRepositoryClone } from "../agentRepositorySharing";
import { AgentGitHubAttribution } from "../components/AgentGitHubAttribution";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiError, getAgentWorkspaceSettings } from "../api";
import { forkPublicAgentRepository, getAgentRepositorySharing, getPublicAgentRepository, getPublicAgentRepositoryFile, publicAgentRepositoryTransferSource, publicRepositoryClonePrompt, REPOSITORY_SHARING_QUERY_KEY, PUBLIC_REPOSITORIES_QUERY_KEY, setAgentRepositorySharing, type PublicAgentRepository } from "../agentRepositorySharing";
import { decodeAgentWorkspaceText } from "../agentWorkspaceImport";
import { useSession } from "../auth";
import { AgentWorkspaceFileTree } from "../components/AgentWorkspaceFileTree";
import { AgentWorkspaceTransferDialog } from "../components/AgentWorkspaceTransferDialog";
import { useAgentSyncCopy } from "../components/AgentSyncCopyDialog";
import { LocalSyncMenu } from "../components/LocalSyncMenu";
import { PaperCard } from "../components/Ink";
import { PageContainer } from "../components/PageContainer";
import { confirmAction } from "../confirmAction";
import { isDesktopRuntime } from "../desktop/runtime";
import { useI18n } from "../i18n";

export function AgentPublicRepositoryPage() {
  const { repositoryId } = useParams({ from: "/repositories/$repositoryId" });
  const id = Number(repositoryId);
  const { t, locale } = useI18n();
  const labels = t.agentWorkspace;
  const client = useQueryClient();
  const navigate = useNavigate();
  const session = useSession();
  const user = session.data?.user;
  const member = user?.membershipTier === "lifetime" && !user.isLocalMode;
  const settings = useQuery({ queryKey: ["agent-workspace-settings"], queryFn: getAgentWorkspaceSettings, enabled: Boolean(member), retry: false });
  const detail = useQuery({ queryKey: ["public-agent-repository", id, user?.id], queryFn: () => getPublicAgentRepository(id), enabled: Number.isSafeInteger(id) && id > 0, retry: false });
  const repository = detail.data?.repository;
  // Owners can withdraw here even when private workspace sync is disabled.
  // A 404 simply means the signed-in viewer does not own this repository.
  const ownership = useQuery({ queryKey: [REPOSITORY_SHARING_QUERY_KEY, id, user?.id], queryFn: () => getAgentRepositorySharing(id), enabled: Boolean(user && !user.isLocalMode && repository), retry: false });
  const withdraw = useMutation({
    mutationFn: () => setAgentRepositorySharing(id, ownership.data!.currentRevision, "", true),
    onSuccess: async () => {
      setTransfer(null);
      copy.clear();
      await Promise.all([
        client.invalidateQueries({ queryKey: ["public-agent-repository", id] }),
        client.invalidateQueries({ queryKey: ["public-agent-file", id] }),
        client.invalidateQueries({ queryKey: [REPOSITORY_SHARING_QUERY_KEY, id] }),
        client.invalidateQueries({ queryKey: [PUBLIC_REPOSITORIES_QUERY_KEY] }),
        client.invalidateQueries({ queryKey: ["agent-workspace-storage"] }),
      ]);
    },
  });
  const [transfer, setTransfer] = useState<PublicAgentRepository | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const copy = useAgentSyncCopy(() => setMessage(labels.copied));
  // Reuse the same idempotency key after a network failure; a new revision needs a new key.
  const forkRequest = useRef<{ key: string; requestId: string } | null>(null);
  useEffect(() => { setSelected(null); setTransfer(null); setMessage(""); copy.clear(); }, [id]);
  const previewFile = repository?.files.find((file) => file.fileId === selected)
    ?? repository?.files.find((file) => file.path.toLowerCase() === "readme.md");
  const preview = useQuery({
    queryKey: ["public-agent-file", id, repository?.revision, previewFile?.fileId, previewFile?.sha256],
    queryFn: () => getPublicAgentRepositoryFile(repository!, previewFile!.fileId), enabled: Boolean(repository && previewFile), retry: false,
  });
  const fork = useMutation({
    mutationFn: async (snapshot: PublicAgentRepository) => {
      const key = `${user?.id}:${snapshot.workspaceId}:${snapshot.revision}`;
      if (forkRequest.current?.key !== key) forkRequest.current = { key, requestId: crypto.randomUUID() };
      return forkPublicAgentRepository(snapshot, forkRequest.current.requestId);
    },
    onSuccess: async ({ workspace }) => {
      await Promise.all([client.invalidateQueries({ queryKey: ["agent-workspaces"] }), client.invalidateQueries({ queryKey: ["agent-workspace-storage"] })]);
      await navigate({ to: "/agent/workspaces/$workspaceId", params: { workspaceId: String(workspace.workspaceId) }, search: { from: "space" } });
    },
  });
  let previewText = "";
  if (preview.data && preview.data.file.sha256 === previewFile?.sha256) {
    const binary = atob(preview.data.file.contentBase64);
    previewText = binary.includes("\0") ? labels.scanReviewPreviewBinary : decodeAgentWorkspaceText(btoa(binary.slice(0, 64 * 1024))) + (binary.length > 64 * 1024 ? `\n\n${labels.scanReviewPreviewTruncated}` : "");
  }
  const cloneRequest = useRef<{ key: string; id: string } | null>(null);
  const cloneContext = `${id}:${user?.id ?? "anonymous"}`;
  const activeCloneContext = useRef<string | null>(cloneContext);
  useEffect(() => {
    activeCloneContext.current = cloneContext;
    return () => { activeCloneContext.current = null; };
  }, [cloneContext]);
  const clone = useMutation({ mutationFn: async ({ snapshot, method }: { snapshot: PublicAgentRepository; method: "zip" | "home" | "agent" }) => {
    const key = `${snapshot.workspaceId}:${snapshot.revision}:${method}:${user?.id ?? "anonymous"}`;
    if (cloneRequest.current?.key !== key) cloneRequest.current = { key, id: crypto.randomUUID() };
    const request = cloneRequest.current;
    const current = (await getPublicAgentRepository(snapshot.workspaceId, snapshot.revision)).repository;
    await recordPublicAgentRepositoryClone(current, request.id, method);
    // Retry uncertain outcomes with the same ID; an acknowledged initiation is
    // complete, so the next Clone must count as a new request.
    if (cloneRequest.current === request) cloneRequest.current = null;
    await Promise.all([client.invalidateQueries({queryKey:["public-agent-repository",id]}), client.invalidateQueries({queryKey:[PUBLIC_REPOSITORIES_QUERY_KEY]})]);
    return current;
  } });
  const star = useMutation({ mutationFn: () => updatePublicAgentRepositoryStar(id, !repository?.starred), onSuccess: async () => {
    await Promise.all([client.invalidateQueries({ queryKey: ["public-agent-repository", id] }), client.invalidateQueries({ queryKey: [PUBLIC_REPOSITORIES_QUERY_KEY] })]);
  } });
  const back = <Link to="/repositories" className="text-sm underline">← {labels.publicRepositories}</Link>;
  if (detail.isPending && Number.isSafeInteger(id) && id > 0) return <PageContainer className="flex-1 py-8">{back}<p className="mt-5">{labels.loading}</p></PageContainer>;
  if (!repository || detail.isError) return <PageContainer className="flex-1 py-8">{back}<p role="alert" className="mt-5">{labels.sharingUnavailable}</p><button type="button" onClick={() => void detail.refetch()} className="mt-3 underline">{labels.refresh}</button></PageContainer>;
  return <PageContainer className="flex-1 py-8 sm:py-12">
    {back}
    <header className="mt-6"><h1 className="break-words text-2xl font-bold">{repository.name}</h1><p className="mt-3 whitespace-pre-wrap text-sm leading-6">{repository.description}</p><p className="mt-3 text-xs" style={{ color: "var(--ink-faint)" }}>r{repository.revision} · {repository.license} · {labels.fileCount.replace("{count}", String(repository.files.length))}</p></header>
    {repository.githubSource && <PaperCard className="mt-5 p-5"><AgentGitHubAttribution source={repository.githubSource} /></PaperCard>}
    <div className="mt-6 flex flex-wrap items-start gap-3">
      {!user || user.isLocalMode ? <Link to="/login" className="rounded-full border px-4 py-2 text-sm">{labels.starRepository} · {t.dashboard.goLogin}</Link> : <button type="button" disabled={star.isPending} aria-pressed={repository.starred} onClick={() => star.mutate()} className="inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm disabled:opacity-50"><Star className={`h-4 w-4 ${repository.starred ? "fill-current" : ""}`} />{repository.starred ? labels.unstarRepository : labels.starRepository} · {repository.starCount ?? 0}</button>}
      <LocalSyncMenu label={labels.cloneRepository} disabled={!repository.files.length || clone.isPending} download={!isDesktopRuntime()} onKoinote={() => { clone.reset(); void clone.mutateAsync({ snapshot: repository, method: isDesktopRuntime() ? "home" : "zip" }).then((snapshot) => { if (activeCloneContext.current === cloneContext) setTransfer(snapshot); }).catch(() => {}); }} onAgent={() => { clone.reset(); void copy.copy(async () => publicRepositoryClonePrompt(await clone.mutateAsync({ snapshot: repository, method: "agent" }), locale)).catch(() => {}); }} />
      {!user || user.isLocalMode ? <Link to="/login" className="rounded-full border px-4 py-2 text-sm">{labels.forkRepository} · {t.dashboard.goLogin}</Link>
        : !member ? <Link to="/pricing" className="rounded-full border px-4 py-2 text-sm">{labels.forkRepository} · {t.mcp.upgrade}</Link>
        : <button type="button" className="rounded-full border px-4 py-2 text-sm disabled:opacity-50" disabled={fork.isPending || !settings.data?.enabled} onClick={async () => { if (await confirmAction(labels.forkConfirm)) fork.mutate(repository); }}>{labels.forkRepository}</button>}
      {ownership.data?.publication && <button type="button" className="rounded-full border px-4 py-2 text-sm disabled:opacity-50" disabled={withdraw.isPending} onClick={async () => { if (await confirmAction(labels.revokeConfirm)) withdraw.mutate(); }}>{labels.revokeSharing}</button>}
    </div>
    <p className="mt-3 text-xs" style={{ color: "var(--ink-mid)" }}>{labels.starCount.replace("{count}", String(repository.starCount ?? 0))} · {labels.cloneRequests.replace("{count}", String(repository.cloneCount ?? 0))}</p>
    {star.isError && <p role="alert" className="mt-3 text-sm">{labels.starFailed}</p>}
    <p className="mt-3 text-xs leading-6" style={{ color: "var(--ink-mid)" }}>{labels.cloneDescription}<br />{labels.forkDescription}</p>
    {member && !settings.isPending && !settings.data?.enabled && <Link to="/space/settings" className="mt-2 inline-block text-xs underline">{labels.forkEnable}</Link>}
    {fork.isError && <p role="alert" className="mt-3 text-sm" style={{ color: "var(--cinnabar)" }}>{fork.error instanceof ApiError && fork.error.code === "revision_conflict" ? labels.sharingConflict : labels.forkFailed}</p>}
    {clone.isError && <p role="alert" className="mt-3 text-sm">{labels.sharingUnavailable}</p>}
    {withdraw.isError && <p role="alert" className="mt-3 text-sm">{withdraw.error instanceof ApiError && withdraw.error.code === "revision_conflict" ? labels.sharingConflict : labels.sharingFailed}</p>}
    {message && <p role="status" className="mt-3 text-sm">{message}</p>}
    <PaperCard className="mt-7 overflow-hidden"><h2 className="border-b px-5 py-4 font-semibold">{labels.filesTitle}</h2><AgentWorkspaceFileTree files={repository.files} hashLabel={labels.hashLabel} onOpen={setSelected} /></PaperCard>
    {previewFile && <PaperCard className="mt-5 overflow-hidden"><h2 className="break-all border-b px-5 py-4 font-mono text-sm">{previewFile.path}</h2>{preview.isPending ? <p className="p-5 text-sm">{labels.loadingFile}</p> : preview.isError ? <p role="alert" className="p-5 text-sm">{labels.transferPreviewFailed}</p> : <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words p-5 font-mono text-xs leading-6">{previewText}</pre>}</PaperCard>}
    {transfer && <AgentWorkspaceTransferDialog workspace={transfer} source={publicAgentRepositoryTransferSource(transfer)} initialDestination={isDesktopRuntime() ? "home" : "zip"} onClose={() => setTransfer(null)} onComplete={(value) => { setTransfer(null); setMessage(value); }} />}
    {copy.dialog}
  </PageContainer>;
}
