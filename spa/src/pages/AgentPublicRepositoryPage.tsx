import { BookOpen, ChevronDown, Code2, FileText, FolderGit2, Star } from "lucide-react";
import { updatePublicAgentRepositoryStar, recordPublicAgentRepositoryClone } from "../agentRepositorySharing";
import { AgentGitHubAttribution } from "../components/AgentGitHubAttribution";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useRouterState, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getAgentWorkspaceSettings } from "../api";
import { forkPublicAgentRepository, getAgentRepositorySharing, getPublicAgentRepository, getPublicAgentRepositoryFile, publicAgentRepositoryTransferSource, publicRepositoryClonePrompt, REPOSITORY_SHARING_QUERY_KEY, PUBLIC_REPOSITORIES_QUERY_KEY, setAgentRepositorySharing, type PublicAgentRepository } from "../agentRepositorySharing";
import { isRepositoryMarkdown, repositoryAnchorID, repositoryPreview, repositoryReadme, REPOSITORY_PREVIEW_BYTES } from "../agentRepositoryMarkdown";
import { RepositoryMarkdown } from "../components/RepositoryMarkdown";
import { formatBytes } from "../storage";
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
  const { file: selected } = useSearch({ from: "/repositories/$repositoryId" });
  const hash = useRouterState({ select: (state) => state.location.hash });
  const fragment = hash?.replace(/^user-content-/, "");
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
  const [raw, setRaw] = useState(false);
  const previewRef = useRef<HTMLElement>(null);
  const [message, setMessage] = useState("");
  const copy = useAgentSyncCopy(() => setMessage(labels.copied));
  // Reuse the same idempotency key after a network failure; a new revision needs a new key.
  const forkRequest = useRef<{ key: string; requestId: string } | null>(null);
  useEffect(() => { setTransfer(null); setMessage(""); copy.clear(); }, [id]);
  useEffect(() => { setRaw(false); }, [id, selected, hash]);
  const readmeFile = repository ? repositoryReadme(repository.files) : undefined;
  const previewFile = repository?.files.find((file) => file.path === selected) ?? readmeFile;
  const preview = useQuery({
    queryKey: ["public-agent-file", id, repository?.revision, previewFile?.fileId, previewFile?.sha256],
    queryFn: ({ signal }) => getPublicAgentRepositoryFile(repository!, previewFile!.fileId, signal), enabled: Boolean(repository && previewFile), retry: false,
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
  const previewContent = useMemo(() => preview.data && preview.data.file.sha256 === previewFile?.sha256 ? repositoryPreview(preview.data.file.contentBase64) : undefined, [preview.data, previewFile?.sha256]);
  const markdown = Boolean(previewFile && isRepositoryMarkdown(previewFile.path));
  function openFile(fileId: number, anchor?: string) {
    const file = repository?.files.find((item) => item.fileId === fileId);
    if (!file) return;
    setRaw(false);
    void navigate({ to: "/repositories/$repositoryId", params: { repositoryId }, search: { file: file.path }, hash: anchor ? repositoryAnchorID(anchor) : "", resetScroll: false, hashScrollIntoView: false });
    if (anchor && file.path === previewFile?.path) {
      const target = document.getElementById(repositoryAnchorID(anchor));
      if (target && previewRef.current?.contains(target)) target.scrollIntoView?.({ block: "start" });
    }
    if (!anchor) previewRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
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
  return <PageContainer className="repository-detail flex-1 py-8 sm:py-10">
    {back}
    <header className="mt-6 border-b pb-6"><div className="flex items-start gap-3"><FolderGit2 className="mt-1 h-6 w-6 shrink-0 text-[var(--ink-mid)]" aria-hidden="true" /><h1 className="min-w-0 break-words text-2xl font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-3xl">{repository.name}</h1></div><p className="mt-3 max-w-3xl whitespace-pre-wrap text-sm leading-7 text-[var(--ink-mid)]">{repository.description}</p><div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-[var(--ink-mid)]"><span className="rounded-full border px-2 py-0.5">{labels.hubPublicBadge}</span><span>{repository.license}</span><span>{labels.fileCount.replace("{count}", String(repository.files.length))}</span><span>{formatBytes(repository.files.reduce((total, file) => total + file.sizeBytes, 0))}</span><span>r{repository.revision}</span></div></header>
    <div className="mt-6 flex flex-wrap items-start gap-3">
      {!user || user.isLocalMode ? <Link to="/login" className="rounded-full border px-4 py-2 text-sm">{labels.starRepository} · {t.dashboard.goLogin}</Link> : <button type="button" disabled={star.isPending} aria-pressed={repository.starred} onClick={() => star.mutate()} className="inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm disabled:opacity-50"><Star className={`h-4 w-4 ${repository.starred ? "fill-current" : ""}`} />{repository.starred ? labels.unstarRepository : labels.starRepository} · {repository.starCount ?? 0}</button>}
      <LocalSyncMenu label={labels.cloneRepository} disabled={!repository.files.length || clone.isPending} download={!isDesktopRuntime()} onKoinote={() => { clone.reset(); void clone.mutateAsync({ snapshot: repository, method: isDesktopRuntime() ? "home" : "zip" }).then((snapshot) => { if (activeCloneContext.current === cloneContext) setTransfer(snapshot); }).catch(() => {}); }} onAgent={() => { clone.reset(); void copy.copy(async () => publicRepositoryClonePrompt(await clone.mutateAsync({ snapshot: repository, method: "agent" }), locale)).catch(() => {}); }} />
      {!user || user.isLocalMode ? <Link to="/login" className="rounded-full border px-4 py-2 text-sm">{labels.forkRepository} · {t.dashboard.goLogin}</Link>
        : !member ? <Link to="/pricing" className="rounded-full border px-4 py-2 text-sm">{labels.forkRepository} · {t.mcp.upgrade}</Link>
        : <button type="button" className="rounded-full border px-4 py-2 text-sm disabled:opacity-50" disabled={fork.isPending || !settings.data?.enabled} onClick={async () => { if (await confirmAction(labels.forkConfirm)) fork.mutate(repository); }}>{labels.forkRepository}</button>}
      {ownership.data?.publication && <button type="button" className="rounded-full border px-4 py-2 text-sm disabled:opacity-50" disabled={withdraw.isPending} onClick={async () => { if (await confirmAction(labels.revokeConfirm)) withdraw.mutate(); }}>{labels.revokeSharing}</button>}
    </div>
    {star.isError && <p role="alert" className="mt-3 text-sm">{labels.starFailed}</p>}
    {member && !settings.isPending && !settings.data?.enabled && <Link to="/space/settings" className="mt-2 inline-block text-xs underline">{labels.forkEnable}</Link>}
    {fork.isError && <p role="alert" className="mt-3 text-sm" style={{ color: "var(--cinnabar)" }}>{fork.error instanceof ApiError && fork.error.code === "revision_conflict" ? labels.sharingConflict : labels.forkFailed}</p>}
    {clone.isError && <p role="alert" className="mt-3 text-sm">{labels.sharingUnavailable}</p>}
    {withdraw.isError && <p role="alert" className="mt-3 text-sm">{withdraw.error instanceof ApiError && withdraw.error.code === "revision_conflict" ? labels.sharingConflict : labels.sharingFailed}</p>}
    {message && <p role="status" className="mt-3 text-sm">{message}</p>}
    <div className="mt-8 grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_15rem]">
      <main className="min-w-0 space-y-5">
        <PaperCard className="overflow-hidden"><details className="group" open={!previewFile || undefined}><summary className="flex cursor-pointer list-none items-center gap-2 bg-[var(--ink-wash)] px-5 py-4 text-sm font-semibold [&::-webkit-details-marker]:hidden"><FolderGit2 className="h-4 w-4" aria-hidden="true" />{labels.filesTitle}<span className="ml-1 font-normal text-[var(--ink-mid)]">{repository.files.length}</span><ChevronDown className="ml-auto h-4 w-4 transition group-open:rotate-180" aria-hidden="true" /></summary><div className="max-h-96 overflow-auto border-t"><AgentWorkspaceFileTree files={repository.files} hashLabel={labels.hashLabel} onOpen={openFile} /></div></details></PaperCard>
        {previewFile ? <section ref={previewRef} className="scroll-mt-24" id={`repository-file-${previewFile.fileId}`}>
          {readmeFile && readmeFile.fileId !== previewFile.fileId && <button type="button" className="mb-3 inline-flex items-center gap-2 text-sm underline" onClick={() => openFile(readmeFile.fileId)}><BookOpen className="h-4 w-4" aria-hidden="true" />{labels.readmeBack}</button>}
          <PaperCard className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-[var(--ink-wash)] px-4 py-3 sm:px-6"><h2 className="flex min-w-0 items-center gap-2 break-all text-sm font-medium">{markdown ? <BookOpen className="h-4 w-4 shrink-0" aria-hidden="true" /> : <FileText className="h-4 w-4 shrink-0" aria-hidden="true" />}{previewFile.path}</h2>{markdown && <div className="flex shrink-0 gap-1 rounded-lg border p-1" role="group" aria-label={labels.readmeView}><button type="button" aria-pressed={!raw} onClick={() => setRaw(false)} className={`rounded-md px-3 py-1 text-xs ${!raw ? "bg-[var(--ink-paper-soft)] font-semibold shadow-sm" : "text-[var(--ink-mid)]"}`}>{labels.readmeRendered}</button><button type="button" aria-pressed={raw} onClick={() => setRaw(true)} className={`inline-flex items-center gap-1 rounded-md px-3 py-1 text-xs ${raw ? "bg-[var(--ink-paper-soft)] font-semibold shadow-sm" : "text-[var(--ink-mid)]"}`}><Code2 className="h-3 w-3" aria-hidden="true" />{labels.readmeSource}</button></div>}</div>
            {preview.isPending ? <p className="p-6 text-sm" role="status">{labels.loadingFile}</p> : preview.isError || !previewContent ? <div role="alert" className="p-6 text-sm"><p>{labels.transferPreviewFailed}</p><button type="button" onClick={() => void preview.refetch()} className="mt-2 underline">{labels.refresh}</button></div> : <>
              {previewContent.truncated && <p role="status" className="border-b px-6 py-3 text-xs text-[var(--ink-mid)]">{labels.readmeTruncated.replace("{size}", formatBytes(REPOSITORY_PREVIEW_BYTES))}</p>}
              {previewContent.binary ? <p className="p-6 text-sm">{labels.scanReviewPreviewBinary}</p> : markdown && !raw ? <div className="p-5 sm:p-8"><RepositoryMarkdown content={previewContent.text} filePath={previewFile.path} repository={repository} onOpenFile={openFile} fragment={fragment} /></div> : <pre className="max-h-[48rem] overflow-auto p-5 font-mono text-xs leading-6 sm:p-6">{previewContent.text}</pre>}
            </>}
          </PaperCard>
        </section> : <PaperCard className="p-8 text-sm text-[var(--ink-mid)]">{labels.readmeSelectFile}</PaperCard>}
      </main>
      <aside className="min-w-0 space-y-5 lg:sticky lg:top-24"><h2 className="border-b pb-3 text-sm font-semibold">{labels.repositoryAbout}</h2>{repository.githubSource && <AgentGitHubAttribution source={repository.githubSource} />}<div className="space-y-2 border-t pt-4 text-xs leading-6 text-[var(--ink-mid)]"><p>{labels.starCount.replace("{count}", String(repository.starCount ?? 0))}</p><p>{labels.cloneRequests.replace("{count}", String(repository.cloneCount ?? 0))}</p>{!repository.githubSource && <p>{labels.licenseLabel}: {repository.license}</p>}</div><div className="space-y-3 border-t pt-4 text-xs leading-6 text-[var(--ink-mid)]"><p>{labels.cloneDescription}</p><p>{labels.forkDescription}</p></div></aside>
    </div>
    {transfer && <AgentWorkspaceTransferDialog workspace={transfer} source={publicAgentRepositoryTransferSource(transfer)} initialDestination={isDesktopRuntime() ? "home" : "zip"} onClose={() => setTransfer(null)} onComplete={(value) => { setTransfer(null); setMessage(value); }} />}
    {copy.dialog}
  </PageContainer>;
}
