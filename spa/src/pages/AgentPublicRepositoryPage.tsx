import { BookOpen, CheckCircle2, ChevronDown, Code2, Copy, Download, FileText, FolderGit2, FolderSync, GitFork, LoaderCircle, RefreshCw, Star, Undo2 } from "lucide-react";
import { updatePublicAgentRepositoryStar, recordPublicAgentRepositoryClone, refreshPublicAgentRepository, syncPublicAgentRepository, type PublicAgentRepositorySync } from "../agentRepositorySharing";
import { AGENT_REPOSITORY_FORK_NOTICE_QUERY_KEY, publicRepositoryPreparationFeedback, publicRepositorySyncFeedback } from "../agentRepositorySyncFeedback";
import { AgentGitHubAttribution } from "../components/AgentGitHubAttribution";
import { githubImportErrorMessage } from "../agentGitHubImport";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useRouterState, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getAgentWorkspaceSettings, User } from "../api";
import { forkPublicAgentRepository, getAgentRepositorySharing, getPublicAgentRepository, getPublicAgentRepositoryFile, publicAgentRepositoryTransferSource, publicRepositoryClonePrompt, REPOSITORY_SHARING_QUERY_KEY, PUBLIC_REPOSITORIES_QUERY_KEY, SYSTEM_REPOSITORIES_QUERY_KEY, setAgentRepositorySharing, type PublicAgentRepository } from "../agentRepositorySharing";
import { isRepositoryMarkdown, repositoryAnchorID, repositoryKoiLoginRedirect, repositoryPreview, repositoryReadme, REPOSITORY_PREVIEW_BYTES } from "../agentRepositoryMarkdown";
import { parseRepositoryDirectorySearch } from "../agentRepositoryDirectory";
import { RepositoryMarkdown } from "../components/RepositoryMarkdown";
import { formatBytes } from "../storage";
import { useSession } from "../auth";
import { AgentWorkspaceFileTree } from "../components/AgentWorkspaceFileTree";
import { AgentWorkspaceTransferDialog } from "../components/AgentWorkspaceTransferDialog";
import { useAgentSyncCopy } from "../components/AgentSyncCopyDialog";
import { PublicRepositoryActionsMenu, type PublicRepositoryAction } from "../components/PublicRepositoryActionsMenu";
import { PaperCard } from "../components/Ink";
import { PageContainer } from "../components/PageContainer";
import { confirmAction } from "../confirmAction";
import { isDesktopRuntime } from "../desktop/runtime";
import { useI18n } from "../i18n";
import { clipDescription, notFoundTitle, publicPageMeta, repositoryPageTitle } from "../seoMeta";
import { getKoiHubSkills, getKoiOverview, KOI_SETTINGS_QUERY_KEY, KOI_SKILLS_QUERY_KEY, type KoiHubTarget } from "../koiSkills";
import { KoiInstallDialog } from "../components/KoiInstallDialog";
import { KoiRetry } from "../components/KoiSkillUi";

export function AgentPublicRepositoryPage() {
  const { repositoryId } = useParams({ from: "/repositories/$repositoryId" });
  const session = useSession();
  const user = session.data?.user;
  // A new repository/account visit owns new mutation callbacks and request refs.
  // Leaving and returning must not reactivate an earlier visit's pending work.
  return <AgentPublicRepositoryDetail key={`${repositoryId}:${user?.id ?? "anonymous"}:${Boolean(user?.isLocalMode)}`} repositoryId={repositoryId} user={user} />;
}

function AgentPublicRepositoryDetail({ repositoryId, user }: { repositoryId: string; user: User | null | undefined }) {
  const id = Number(repositoryId);
  const routeSearch = useSearch({ from: "/repositories/$repositoryId" });
  const { file: selected } = routeSearch;
  const directorySearch = parseRepositoryDirectorySearch(routeSearch);
  const hash = useRouterState({ select: (state) => state.location.hash });
  const fragment = hash?.replace(/^user-content-/, "");
  const { t, locale } = useI18n();
  const labels = t.agentWorkspace;
  const client = useQueryClient();
  const navigate = useNavigate();
  const member = user?.membershipTier === "lifetime" && !user.isLocalMode;
  const settings = useQuery({ queryKey: ["agent-workspace-settings"], queryFn: getAgentWorkspaceSettings, enabled: Boolean(member), retry: false });
  const detail = useQuery({ queryKey: ["public-agent-repository", id, user?.id], queryFn: () => getPublicAgentRepository(id), enabled: Number.isSafeInteger(id) && id > 0, retry: false });
  const repository = detail.data?.repository;
  const koi = useQuery({ queryKey: [KOI_SETTINGS_QUERY_KEY, user?.authUserId], queryFn: getKoiOverview, enabled: Boolean(user && !user.isLocalMode), retry: false });
  const [koiTarget, setKoiTarget] = useState<KoiHubTarget>();
  const [koiMessage, setKoiMessage] = useState("");
  const [cloneAction, setCloneAction] = useState<"clone" | "agent" | null>(null);
  const installHandled = useRef(false);
  // A manifest only identifies potential entries. The install preview owns
  // validation, so do not present a raw SKILL.md count as an installable total.
  const skillPaths = repository?.files.filter((file) => /(^|\/)SKILL\.md$/.test(file.path)).map((file) => file.path) ?? [];
  const hasSkills = skillPaths.length > 0;
  const canInstallKoi = Boolean(member && koi.data?.managementAvailable && koi.data.canInstall);
  const installed = useQuery({ queryKey: [KOI_SKILLS_QUERY_KEY, user?.authUserId, "hub", id], queryFn: ({ signal }) => getKoiHubSkills(id, signal), enabled: canInstallKoi && hasSkills, retry: false });
  const installedPaths = new Set(installed.data?.map((skill) => [skill.source.path, "SKILL.md"].filter(Boolean).join("/")));
  // Overview and installation reads inform the UI; neither owns the preview
  // entry. The dialog checks permission before it reads an import source.
  const installedCount = installed.isSuccess ? skillPaths.filter((path) => installedPaths.has(path)).length : 0;
  const installLabel = installed.isSuccess && installedCount === skillPaths.length ? t.koi.alreadyInstalled : installedCount > 0 ? t.koi.installedCount.replace("{count}", String(installedCount)) : t.koi.viewSkills;
  const loadingInstallStatus = koi.isFetching || canInstallKoi && installed.isFetching;
  const openKoi = () => {
    if (repository) setKoiTarget({ workspaceId: repository.workspaceId, name: repository.name, publicationId: repository.publicationId, revision: repository.revision });
  };
  // Login return opens the reviewed snapshot only; confirmation stays explicit.
  useEffect(() => {
    if (!routeSearch.installKoi || installHandled.current || !repository || !user || user.isLocalMode) return;
    installHandled.current = true;
    void navigate({ to: "/repositories/$repositoryId", params: { repositoryId }, search: { ...directorySearch, file: selected }, hash, replace: true, resetScroll: false, hashScrollIntoView: false });
    if (member && hasSkills) openKoi();
    else if (hasSkills) setKoiMessage(t.koi.koiMembersOnly);
  }, [routeSearch.installKoi, repository, user, member, hasSkills]);
  // AppShell 的统一同步不管本页的标题和描述（见 seoMeta.pageOwnsMeta），由这里按仓库
  // 数据设置，与 Worker 首屏渲染的保持一致。
  // 数据回来之前不改：首屏已由 Worker 按仓库写好，先改成通用标题会闪一下。
  // 打不开时换掉，否则站内点进来的会一直挂着上一页的标题
  const validID = Number.isSafeInteger(id) && id > 0;
  const missing = !validID || (detail.error instanceof ApiError && detail.error.status === 404);
  const unavailable = !repository && (missing || detail.isError);
  useEffect(() => {
    if (repository) {
      document.title = repositoryPageTitle(repository.name, t);
      document
        .querySelector('meta[name="description"]')
        ?.setAttribute("content", clipDescription(repository.description.trim() || t.agentWorkspace.hubNoDescription));
    } else if (unavailable) {
      document.title = missing ? notFoundTitle(t) : publicPageMeta("repositories", t, locale).title;
    }
  }, [repository, unavailable, missing, t, locale]);
  // Owners can withdraw here even when private workspace sync is disabled.
  // A 404 simply means the signed-in viewer does not own this repository.
  const ownership = useQuery({ queryKey: [REPOSITORY_SHARING_QUERY_KEY, id, user?.id, Boolean(repository?.systemManaged)], queryFn: () => getAgentRepositorySharing(id, Boolean(repository?.systemManaged)), enabled: Boolean(user && !user.isLocalMode && repository && (!repository.systemManaged || user.isAdmin)), retry: false });
  const withdraw = useMutation({
    onMutate: clearActionFeedback,
    mutationFn: () => setAgentRepositorySharing(id, ownership.data!.currentRevision, "", true, Boolean(repository?.systemManaged)),
    onSuccess: async () => {
      setTransfer(null);
      copy.clear();
      await Promise.all([
        client.invalidateQueries({ queryKey: ["public-agent-repository", id] }),
        client.invalidateQueries({ queryKey: ["public-agent-file", id] }),
        client.invalidateQueries({ queryKey: [REPOSITORY_SHARING_QUERY_KEY, id] }),
        client.invalidateQueries({ queryKey: [PUBLIC_REPOSITORIES_QUERY_KEY] }),
        client.invalidateQueries({ queryKey: [SYSTEM_REPOSITORIES_QUERY_KEY] }),
        client.invalidateQueries({ queryKey: ["agent-workspace-storage"] }),
      ]);
    },
  });
  const [transfer, setTransfer] = useState<PublicAgentRepository | null>(null);
  const [raw, setRaw] = useState(false);
  const previewRef = useRef<HTMLElement>(null);
  const [message, setMessage] = useState("");
  const [syncMessage, setSyncMessage] = useState("");
  const copy = useAgentSyncCopy(() => setMessage(labels.copied));
  function clearActionFeedback() { setMessage(""); setSyncMessage(""); }
  // Reuse the same idempotency key and the already prepared snapshot after an
  // uncertain outcome; a newer upstream commit must not retarget the retry.
  const forkRequest = useRef<{ key: string; requestId: string; repository: PublicAgentRepository; sync: PublicAgentRepositorySync } | null>(null);
  useEffect(() => { setTransfer(null); setMessage(""); setSyncMessage(""); copy.clear(); }, [id]);
  useEffect(() => { setRaw(false); }, [id, selected, hash]);
  const readmeFile = repository ? repositoryReadme(repository.files) : undefined;
  const previewFile = repository?.files.find((file) => file.path === selected) ?? readmeFile;
  const preview = useQuery({
    queryKey: ["public-agent-file", id, repository?.revision, previewFile?.fileId, previewFile?.sha256, repository?.publicationId],
    queryFn: ({ signal }) => getPublicAgentRepositoryFile(repository!, previewFile!.fileId, signal), enabled: Boolean(repository && previewFile), retry: false,
  });
  const fork = useMutation({
    onMutate: clearActionFeedback,
    mutationFn: async (snapshot: PublicAgentRepository) => {
      requireCurrentView();
      // An uncertain outcome keeps both the prepared snapshot and its request ID;
      // retrying must not be retargeted by a newer upstream commit.
      const attempt = `${user?.id}:${snapshot.workspaceId}`;
      let request = forkRequest.current?.key === attempt ? forkRequest.current : null;
      if (!request) {
        const { repository: latest, sync: result } = await refreshPublicAgentRepository(snapshot);
        requireCurrentView();
        setSyncMessage(preparationFeedback(result));
        request = { key: attempt, requestId: crypto.randomUUID(), repository: latest, sync: result };
        forkRequest.current = request;
        cacheRepository(latest);
      }
      return { ...await forkPublicAgentRepository(request.repository, request.requestId, false), sync: request.sync };
    },
    onSuccess: async ({ workspace, sync: result }) => {
      if (activeCloneContext.current !== cloneContext) return;
      forkRequest.current = null;
      await Promise.all([client.invalidateQueries({ queryKey: ["agent-workspaces"] }), client.invalidateQueries({ queryKey: ["agent-workspace-storage"] })]);
      if (activeCloneContext.current !== cloneContext) return;
      if (user && preparationFeedback(result)) client.setQueryData([AGENT_REPOSITORY_FORK_NOTICE_QUERY_KEY, user.id, workspace.workspaceId], result);
      await navigate({ to: "/agent/workspaces/$workspaceId", params: { workspaceId: String(workspace.workspaceId) }, search: { from: "space" } });
    },
    // A conflict means the published revision moved past the prepared snapshot;
    // the next attempt must refresh again instead of retrying the stale revision.
    onError: async (error) => {
      if (activeCloneContext.current !== cloneContext) return;
      if (error instanceof ApiError && error.code === "revision_conflict") {
        forkRequest.current = null;
        await recoverPublishedSnapshot();
      } else if (error instanceof ApiError && error.code === "agent_workspace_disabled") {
        await client.invalidateQueries({ queryKey: ["agent-workspace-settings"] });
      }
    },
  });
  const previewContent = useMemo(() => preview.data && preview.data.file.sha256 === previewFile?.sha256 ? repositoryPreview(preview.data.file.contentBase64) : undefined, [preview.data, previewFile?.sha256]);
  const markdown = Boolean(previewFile && isRepositoryMarkdown(previewFile.path));
  function openFile(fileId: number, anchor?: string) {
    const file = repository?.files.find((item) => item.fileId === fileId);
    if (!file) return;
    setRaw(false);
    void navigate({ to: "/repositories/$repositoryId", params: { repositoryId }, search: { ...directorySearch, file: file.path }, hash: anchor ? repositoryAnchorID(anchor) : "", resetScroll: false, hashScrollIntoView: false });
    if (anchor && file.path === previewFile?.path) {
      const target = document.getElementById(repositoryAnchorID(anchor));
      if (target && previewRef.current?.contains(target)) target.scrollIntoView?.({ block: "start" });
    }
    if (!anchor) previewRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }
  const cloneRequest = useRef<{ key: string; id: string; repository: PublicAgentRepository } | null>(null);
  const cloneContext = `${id}:${user?.id ?? "anonymous"}`;
  const activeCloneContext = useRef<string | null>(cloneContext);
  useEffect(() => {
    activeCloneContext.current = cloneContext;
    return () => { activeCloneContext.current = null; };
  }, [cloneContext]);
  function requireCurrentView() {
    if (activeCloneContext.current !== cloneContext) throw new DOMException("Repository action cancelled", "AbortError");
  }
  const clone = useMutation({ onMutate: clearActionFeedback, mutationFn: async ({ snapshot, method }: { snapshot: PublicAgentRepository; method: "zip" | "home" | "agent" }) => {
    requireCurrentView();
    // Retry the prepared snapshot and request ID after an uncertain outcome; only
    // a fresh Clone refreshes upstream again.
    const attempt = `${snapshot.workspaceId}:${method}:${user?.id ?? "anonymous"}`;
    let request = cloneRequest.current?.key === attempt ? cloneRequest.current : null;
    if (!request) {
      const { repository: latest, sync: result } = await refreshPublicAgentRepository(snapshot);
      requireCurrentView();
      setSyncMessage(preparationFeedback(result));
      request = { key: attempt, id: crypto.randomUUID(), repository: latest };
      cloneRequest.current = request;
      cacheRepository(latest);
    }
    await recordPublicAgentRepositoryClone(request.repository, request.id, method, false);
    requireCurrentView();
    // An acknowledged initiation is complete, so the next Clone counts as a new request.
    if (cloneRequest.current === request) cloneRequest.current = null;
    await Promise.all([client.invalidateQueries({queryKey:["public-agent-repository",id]}), client.invalidateQueries({queryKey:[PUBLIC_REPOSITORIES_QUERY_KEY]})]);
    return request.repository;
  }, onError: async (error) => {
    if (error instanceof ApiError && error.code === "revision_conflict") {
      cloneRequest.current = null;
      await recoverPublishedSnapshot();
    }
  } });
  const sync = useMutation({
    mutationFn: () => syncPublicAgentRepository(id),
    onSuccess: async ({ repository: latest, sync: result }) => {
      if (activeCloneContext.current !== cloneContext) {
        await client.invalidateQueries({ queryKey: ["public-agent-repository", latest.workspaceId, user?.id], exact: true });
        return;
      }
      cacheRepository(latest);
      // Keep uncertain actions tied to their original request ID and snapshot.
      // The server replays a completed Fork even if Sync advanced the source;
      // an expired Clone snapshot is rejected and recovered on conflict.
      setTransfer(null);
      copy.clear();
      setSyncMessage(syncFeedback(result));
      await Promise.all([
        client.invalidateQueries({ queryKey: ["public-agent-repository", id] }),
        client.invalidateQueries({ queryKey: ["public-agent-file", id] }),
        client.invalidateQueries({ queryKey: [REPOSITORY_SHARING_QUERY_KEY, id] }),
        client.invalidateQueries({ queryKey: [PUBLIC_REPOSITORIES_QUERY_KEY] }),
        client.invalidateQueries({ queryKey: [SYSTEM_REPOSITORIES_QUERY_KEY] }),
      ]);
    },
    onMutate: clearActionFeedback,
  });
  const star = useMutation({ mutationFn: () => updatePublicAgentRepositoryStar(id, !repository?.starred), onSuccess: async () => {
    await Promise.all([client.invalidateQueries({ queryKey: ["public-agent-repository", id] }), client.invalidateQueries({ queryKey: [PUBLIC_REPOSITORIES_QUERY_KEY] })]);
  } });
  // Refresh responses already carry the fresh published snapshot, so pin it for
  // this view before the invalidation round-trip completes.
  function cacheRepository(latest: PublicAgentRepository) {
    client.setQueryData(["public-agent-repository", latest.workspaceId, user?.id], { repository: latest });
  }
  async function recoverPublishedSnapshot() {
    if (activeCloneContext.current !== cloneContext) return;
    try {
      const { repository: latest } = await getPublicAgentRepository(id);
      if (activeCloneContext.current === cloneContext) cacheRepository(latest);
    } catch {
      // Keep the original conflict visible. A new Clone reads the current
      // publication again rather than repeatedly requesting the expired one.
    }
  }
  function syncFeedback(result: PublicAgentRepositorySync) {
    return publicRepositorySyncFeedback(result, labels);
  }
  function preparationFeedback(result: PublicAgentRepositorySync) {
    return publicRepositoryPreparationFeedback(result, labels);
  }
  const busy = sync.isPending || fork.isPending || clone.isPending || cloneAction !== null || withdraw.isPending;
  const busyMessage = sync.isPending ? labels.syncingGitHub
    : cloneAction || clone.isPending ? cloneAction === "agent" ? labels.preparingAgentCopy : labels.preparingClone
      : fork.isPending ? labels.forkingRepository : withdraw.isPending ? labels.withdrawingSharing : "";
  const actions: PublicRepositoryAction[] = repository ? [
    { id: "clone", label: isDesktopRuntime() ? labels.cloneRepository : labels.transferZip, icon: isDesktopRuntime() ? FolderSync : Download, disabled: !repository.files.length || busy, onSelect: () => { clone.reset(); setCloneAction("clone"); void clone.mutateAsync({ snapshot: repository, method: isDesktopRuntime() ? "home" : "zip" }).then((snapshot) => { if (activeCloneContext.current === cloneContext) setTransfer(snapshot); }).catch(() => {}).finally(() => { if (activeCloneContext.current === cloneContext) setCloneAction(null); }); } },
    { id: "agent", label: t.space.configSnapshots.syncWithAgent, icon: Copy, disabled: !repository.files.length || busy, onSelect: () => { clone.reset(); setCloneAction("agent"); void copy.copy(async () => publicRepositoryClonePrompt(await clone.mutateAsync({ snapshot: repository, method: "agent" }), locale)).catch(() => {}).finally(() => { if (activeCloneContext.current === cloneContext) setCloneAction(null); }); } },
    { id: "fork", label: !user || user.isLocalMode ? `${labels.forkRepository} · ${t.dashboard.goLogin}` : !member ? `${labels.forkRepository} · ${t.mcp.upgrade}` : labels.forkRepository, icon: GitFork, separator: true, href: !user || user.isLocalMode ? "/login" : !member ? "/pricing" : undefined, disabled: busy || !settings.data?.enabled, onSelect: async () => { if (await confirmAction(labels.forkConfirm)) fork.mutate(repository); } },
    ...(repository.githubSource ? [{ id: "sync", label: sync.isPending ? labels.syncingGitHub : repository.syncDisabledReason ? labels.syncGitHub : repository.githubSource.upstreamStatus ? labels.syncRecheckGitHub : labels.syncGitHub, icon: RefreshCw, disabled: busy || Boolean(repository.syncDisabledReason), title: repository.syncDisabledReason ? syncFeedback({ status: "skipped", code: repository.syncDisabledReason }) : undefined, onSelect: () => sync.mutate() }] : []),
    ...(ownership.data?.publication ? [{ id: "withdraw", label: labels.revokeSharing, icon: Undo2, danger: true, separator: true, disabled: withdraw.isPending || busy, onSelect: async () => { if (await confirmAction(labels.revokeConfirm)) withdraw.mutate(); } }] : []),
  ] : [];
  const back = <Link to="/repositories" search={directorySearch} className="text-sm underline">← {labels.publicRepositories}</Link>;
  if (detail.isPending && Number.isSafeInteger(id) && id > 0) return <PageContainer className="flex-1 py-8">{back}<p className="mt-5">{labels.loading}</p></PageContainer>;
  if (!repository || detail.isError) return <PageContainer className="flex-1 py-8">{back}<p role="alert" className="mt-5">{labels.sharingUnavailable}</p><button type="button" onClick={() => void detail.refetch()} className="mt-3 underline">{labels.refresh}</button></PageContainer>;
  return <PageContainer className="repository-detail flex-1 py-8 sm:py-10">
    {back}
    <header className="mt-6 border-b pb-6"><div className="flex items-start gap-3"><FolderGit2 className="mt-1 h-6 w-6 shrink-0 text-[var(--ink-mid)]" aria-hidden="true" /><h1 className="min-w-0 break-words text-2xl font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-3xl">{repository.name}</h1></div><p className="mt-3 max-w-3xl whitespace-pre-wrap text-sm leading-7 text-[var(--ink-mid)]">{repository.description}</p><div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-[var(--ink-mid)]"><span className="rounded-full border px-2 py-0.5">{repository.systemManaged ? labels.hubSystemBadge : labels.hubPublicBadge}</span><span>{repository.license}</span><span>{labels.fileCount.replace("{count}", String(repository.files.length))}</span><span>{formatBytes(repository.files.reduce((total, file) => total + file.sizeBytes, 0))}</span><span>r{repository.revision}</span></div></header>
    <div className="mt-6 flex flex-wrap items-center gap-3">
      {hasSkills && (!user || user.isLocalMode ? <a href={`/login?redirectTo=${encodeURIComponent(repositoryKoiLoginRedirect(repositoryId, routeSearch, hash))}`} className="inline-flex min-h-10 items-center rounded-full border px-4 py-2 text-sm">{t.koi.viewSkills} · {t.dashboard.goLogin}</a> : member ? <button type="button" disabled={busy || Boolean(koiTarget)} aria-busy={loadingInstallStatus} onClick={openKoi} className={`inline-flex min-h-10 items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition disabled:opacity-50 ${installedCount > 0 ? "border-[var(--ink-line)] hover:bg-[var(--ink-wash)]" : "border-transparent text-white hover:brightness-95"}`} style={installedCount > 0 ? { background: "var(--ink-paper-soft)" } : { background: "var(--cinnabar)" }}>{loadingInstallStatus ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : installedCount > 0 && <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}{installLabel}</button> : null)}
      {!hasSkills && <span className="self-center text-xs text-[var(--ink-faint)]">{t.koi.noInstallableSkills}</span>}
      {!user || user.isLocalMode ? <Link to="/login" className="inline-flex min-h-10 items-center rounded-full border px-4 py-2 text-sm">{labels.starRepository} · {t.dashboard.goLogin}</Link> : <button type="button" disabled={star.isPending || busy} aria-pressed={repository.starred} onClick={() => star.mutate()} className="inline-flex min-h-10 items-center gap-2 rounded-full border px-4 py-2 text-sm transition hover:bg-[var(--ink-wash)] disabled:opacity-50"><Star className={`h-4 w-4 ${repository.starred ? "fill-current" : ""}`} aria-hidden="true" />{repository.starred ? labels.unstarRepository : labels.starRepository} · {repository.starCount ?? 0}</button>}
      <PublicRepositoryActionsMenu label={labels.repositoryActions} actions={actions} />
    </div>
    {busyMessage && <p role="status" aria-live="polite" className="mt-3 inline-flex items-center gap-2 text-sm text-[var(--ink-mid)]"><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />{busyMessage}</p>}
    {star.isError && <p role="alert" className="mt-3 text-sm">{labels.starFailed}</p>}
    {koiMessage && <p role="alert" className="mt-3 text-sm">{koiMessage}</p>}
    {member && hasSkills && !koiTarget && koi.isError && <div className="mt-3"><KoiRetry label={t.koi.loadFailed} action={t.koi.retry} busy={koi.isFetching} onRetry={() => void koi.refetch()} /></div>}
    {canInstallKoi && !koiTarget && installed.isError && <div className="mt-3"><KoiRetry label={t.koi.installStatusUnavailable} action={t.koi.retry} busy={installed.isFetching} onRetry={() => void installed.refetch()} /></div>}
    {member && !settings.isPending && !settings.data?.enabled && <Link to="/space/settings" className="mt-2 inline-block text-xs underline">{labels.forkEnable}</Link>}
    {repository.githubSource && repository.syncDisabledReason && <p className="mt-3 text-sm text-[var(--ink-mid)]">{syncFeedback({ status: "skipped", code: repository.syncDisabledReason })}</p>}
    {fork.isError && <p role="alert" className="mt-3 text-sm" style={{ color: "var(--cinnabar)" }}>{fork.error instanceof ApiError && fork.error.code === "revision_conflict" ? labels.sharingConflict : fork.error instanceof ApiError && fork.error.code === "agent_workspace_disabled" ? labels.forkEnable : githubImportErrorMessage(fork.error, labels, labels.forkFailed)}</p>}
    {clone.isError && <p role="alert" className="mt-3 text-sm">{githubImportErrorMessage(clone.error, labels, labels.sharingUnavailable)}</p>}
    {sync.isError && <p role="alert" className="mt-3 text-sm">{githubImportErrorMessage(sync.error, labels, labels.syncFailed)}</p>}
    {syncMessage && <p role="status" className="mt-3 text-sm">{syncMessage}</p>}
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
    {koiTarget && member && user && <KoiInstallDialog authUserId={user.authUserId} hubTarget={koiTarget} onClose={() => setKoiTarget(undefined)} />}
  </PageContainer>;
}
