import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ArrowLeft, ChevronDown, ChevronRight, Cloud, Edit3, Eye, FileText, Folder, FolderOpen, LockKeyhole, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { AGENT_WORKSPACE_QUERY_KEY, ApiError, getAgentWorkspace, getAgentWorkspaceFile, getAgentWorkspacePrompt, getAgentWorkspaceStorage, listAgentWorkspaceCommits, listMCPTokens, patchAgentWorkspace, revealMCPToken, restoreAgentWorkspaceCommit, updateAgentWorkspace, updateAgentWorkspaceMetadata } from "../api";
import { AGENT_WORKSPACE_MAX_FILE_BYTES, configFilesToAgentWorkspaceImport, decodeAgentWorkspaceText, filterAgentWorkspaceSensitiveFiles, prepareAgentWorkspaceImport, sha256Hex, type AgentWorkspaceFilteredFile } from "../agentWorkspaceImport";
import type { ConfigVaultFile } from "../configVaultCrypto";
import { isDesktopRuntime } from "../desktop/runtime";
import { useSession } from "../auth";
import { AgentWorkspaceReadme } from "../components/AgentWorkspaceReadme";
import { AgentWorkspaceFileTree } from "../components/AgentWorkspaceFileTree";
import { PaperCard } from "../components/Ink";
import { AgentWorkspaceStorageCard } from "../components/AgentWorkspaceStorageCard";
import { PageContainer } from "../components/PageContainer";
import { useI18n } from "../i18n";
import { confirmAction } from "../confirmAction";
import { formatBytes } from "../storage";
import { pushModal } from "../modalStack";

export function AgentWorkspaceRepositoryPage() {
  const { t, locale } = useI18n();
  const session = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { workspaceId?: string };
  const search = useSearch({ strict: false }) as { from?: "hub" | "space" | "settings" };
  const workspaceId = Number(params.workspaceId);
  const user = session.data?.user;
  const canAccess = Boolean(user && user.membershipTier === "lifetime" && !user.isLocalMode && Number.isInteger(workspaceId) && workspaceId > 0);
  const detail = useQuery({ queryKey: [...AGENT_WORKSPACE_QUERY_KEY, workspaceId], queryFn: () => getAgentWorkspace(workspaceId), enabled: canAccess, retry: false });
  const storage = useQuery({ queryKey: ["agent-workspace-storage"], queryFn: getAgentWorkspaceStorage, enabled: canAccess, retry: false });
  const commits = useQuery({ queryKey: ["agent-workspace-commits", workspaceId], queryFn: () => listAgentWorkspaceCommits(workspaceId), enabled: canAccess, retry: false });
  const readmeFile = detail.data?.workspace?.files.find((file) => file.path.toLowerCase() === "readme.md");
  const readme = useQuery({ queryKey: ["agent-workspace-readme", readmeFile?.fileId, readmeFile?.sha256], queryFn: () => getAgentWorkspaceFile(readmeFile!.fileId), enabled: canAccess && readmeFile !== undefined, retry: false });
  const [copied, setCopied] = useState(false);
  const [editingSettings, setEditingSettings] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [selectedFile, setSelectedFile] = useState<number | null>(null);
  const [pendingLocalFiles, setPendingLocalFiles] = useState<ConfigVaultFile[] | null>(null);
  const [filteredLocalFiles, setFilteredLocalFiles] = useState<AgentWorkspaceFilteredFile[]>([]);
  const [selectedLocalPaths, setSelectedLocalPaths] = useState<Set<string>>(() => new Set());
  const selectedFileQuery = useQuery({ queryKey: ["agent-workspace-file", selectedFile, detail.data?.workspace?.revision], queryFn: () => getAgentWorkspaceFile(selectedFile!), enabled: selectedFile !== null, retry: false });
  const prompt = useMutation({
    mutationFn: async () => {
      const currentTokens = (await listMCPTokens()).tokens;
      const token = currentTokens.find((item) => item.scope === "agent_write" && item.revealable);
      if (!token) {
        await navigate({ to: "/space/settings", search: { workspaceId } });
        return false;
      }
      const [result, revealed] = await Promise.all([getAgentWorkspacePrompt(workspaceId), revealMCPToken(token.tokenId)]);
      await navigator.clipboard.writeText(`${result.prompt}\n\nAuthentication token for this session (keep it secret):\nKOINOTE_MCP_TOKEN=${revealed.secret}\nUse this value as the Bearer token for both REST API and MCP requests.`);
      return true;
    },
    onSuccess(didCopy) { if (didCopy) { setCopied(true); window.setTimeout(() => setCopied(false), 1800); } },
  });
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const workspace = detail.data?.workspace;
      if (!workspace || files.length === 0) throw new Error("no files selected");
      const currentReadme = workspace.files.find((file) => file.path.toLowerCase() === "readme.md");
      const readmeContent = currentReadme ? await getAgentWorkspaceFile(currentReadme.fileId) : undefined;
      const prepared = await prepareAgentWorkspaceImport(files, readmeContent?.file);
      return updateAgentWorkspace({ workspaceId: workspace.workspaceId, expectedRevision: workspace.revision, files: prepared });
    },
    onSuccess() { void queryClient.invalidateQueries({ queryKey: [...AGENT_WORKSPACE_QUERY_KEY, workspaceId] }); void queryClient.invalidateQueries({ queryKey: ["agent-workspaces"] }); },
  });
  const scanLocal = useMutation({
    mutationFn: async () => {
      const { desktopScanAgentWorkspaceFiles } = await import("../desktop/configFiles");
      const scanned = await desktopScanAgentWorkspaceFiles();
      if (scanned.length === 0) throw new Error("no agent files found");
      return scanned;
    },
    onSuccess: (scanned) => {
      const filtered = filterAgentWorkspaceSensitiveFiles(scanned);
      setPendingLocalFiles(filtered.safeFiles);
      setFilteredLocalFiles(filtered.filteredFiles);
      setSelectedLocalPaths(new Set(filtered.safeFiles.map((file) => file.path)));
    },
  });
  const syncLocal = useMutation({
    mutationFn: async ({ selected, allowSensitive }: { selected: ConfigVaultFile[]; allowSensitive: boolean }) => {
      const workspace = detail.data?.workspace;
      if (!workspace) throw new Error("workspace unavailable");
      const currentByPath = new Map(workspace.files.map((file) => [file.path, file]));
      const changed: ConfigVaultFile[] = [];
      for (const file of selected) {
        const hash = await sha256Hex(file.bytes);
        if (currentByPath.get(file.path)?.sha256 !== hash) changed.push(file);
      }
      const upsert = changed.length > 0 ? configFilesToAgentWorkspaceImport(changed) : [];
      if (upsert.length === 0) return null;
      return patchAgentWorkspace({
        workspaceId: workspace.workspaceId,
        expectedRevision: workspace.revision,
        upsert,
        allowSensitive,
      });
    },
    onSuccess: () => {
      setPendingLocalFiles(null);
      setFilteredLocalFiles([]);
      setSelectedLocalPaths(new Set());
      void queryClient.invalidateQueries({ queryKey: [...AGENT_WORKSPACE_QUERY_KEY, workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ["agent-workspaces"] });
      void queryClient.invalidateQueries({ queryKey: ["agent-workspace-storage"] });
    },
  });
  const scanLocalPending = scanLocal.isPending || syncLocal.isPending;
  const scanError = scanLocal.error ?? syncLocal.error;
  const saveSettings = useMutation({
    mutationFn: () => updateAgentWorkspaceMetadata(workspaceId, { expectedRevision: detail.data?.workspace?.revision ?? 0, name: editName.trim(), description: editDescription.trim() }),
    onSuccess() {
      setEditingSettings(false);
      void queryClient.invalidateQueries({ queryKey: [...AGENT_WORKSPACE_QUERY_KEY, workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ["agent-workspaces"] });
    },
  });
  const restore = useMutation({
    mutationFn: (revision: number) => restoreAgentWorkspaceCommit(workspaceId, revision, detail.data?.workspace?.revision ?? 0),
    onSuccess: () => { void detail.refetch(); void commits.refetch(); void queryClient.invalidateQueries({ queryKey: ["agent-workspaces"] }); },
  });

  if (session.isLoading) return <PageLoading>{t.dashboard.loading}</PageLoading>;
  if (!user) return <PageMessage><p>{t.dashboard.loginRequired}</p><Link to="/login" className="mt-4 inline-flex rounded-full px-5 py-2.5 text-sm font-semibold" style={{ background: "var(--cinnabar)", color: "white" }}>{t.dashboard.goLogin}</Link></PageMessage>;
  if (user.isLocalMode) return <PageMessage>{t.agentWorkspace.localMode}</PageMessage>;
  if (user.membershipTier !== "lifetime") return <PageMessage><p>{t.agentWorkspace.membersOnly}</p><Link to="/pricing" className="mt-4 inline-flex rounded-full px-5 py-2.5 text-sm font-semibold" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>{t.mcp.upgrade}</Link></PageMessage>;
  if (!canAccess || detail.isError || detail.data?.workspace === null) return <PageMessage>{t.agentWorkspace.repositoryLoadFailed}</PageMessage>;
  if (detail.isLoading || !detail.data?.workspace) return <PageLoading>{t.agentWorkspace.loading}</PageLoading>;

  const workspace = detail.data.workspace;
  const openSettings = () => { saveSettings.reset(); setEditName(workspace.name); setEditDescription(normalizeRepositoryDescription(workspace.description)); setEditingSettings(true); };
  const backLink = search.from === "space" ? <Link to="/space" search={{ tab: "agent" }} className="inline-flex items-center gap-1.5 text-sm font-medium transition-opacity hover:opacity-70" style={{ color: "var(--ink-mid)" }}><ArrowLeft className="h-4 w-4" />{t.agentWorkspace.backToRepositories}</Link> : search.from === "hub" ? <Link to="/agent/workspaces" className="inline-flex items-center gap-1.5 text-sm font-medium transition-opacity hover:opacity-70" style={{ color: "var(--ink-mid)" }}><ArrowLeft className="h-4 w-4" />{t.agentWorkspace.backToRepositories}</Link> : <Link to="/settings" search={{ section: "agent" }} className="inline-flex items-center gap-1.5 text-sm font-medium transition-opacity hover:opacity-70" style={{ color: "var(--ink-mid)" }}><ArrowLeft className="h-4 w-4" />{t.agentWorkspace.backToRepositories}</Link>;
  const readmeContent = readme.data?.file ? decodeAgentWorkspaceText(readme.data.file.contentBase64) : null;

  return <PageContainer className="flex-1 py-7 sm:py-10">
    <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: "var(--ink-faint)" }}><Link to={search.from === "space" ? "/space" : "/agent/workspaces"} search={search.from === "space" ? { tab: "agent" } : undefined} className="transition-opacity hover:opacity-70">{search.from === "space" ? t.nav.space : t.agentWorkspace.repositoryHubTitle}</Link><ChevronRight className="h-3.5 w-3.5" /><span className="max-w-[16rem] truncate" style={{ color: "var(--ink-mid)" }}>{workspace.name}</span></div>
    <div className="mt-5">{backLink}</div><div className="mt-5"><AgentWorkspaceStorageCard storage={storage.data?.storage} loading={storage.isFetching} error={storage.isError} onRetry={() => void storage.refetch()} compact /></div>
    <header className="mt-6 border-b pb-6" style={{ borderColor: "var(--ink-line)" }}><div className="flex min-w-0 items-start justify-between gap-4"><div className="flex min-w-0 items-start gap-4"><div className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-xl sm:flex" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}><Cloud className="h-6 w-6" /></div><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h1 className="kn-heading-cn break-words text-2xl font-bold tracking-tight sm:text-3xl" style={{ color: "var(--ink-black)" }}>{workspace.name}</h1><Badge icon={<LockKeyhole className="h-3 w-3" />}>{t.agentWorkspace.privateBadge}</Badge><Badge>{t.agentWorkspace.kindBadge}</Badge></div>{normalizeRepositoryDescription(workspace.description) && <p className="mt-3 max-w-2xl text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{normalizeRepositoryDescription(workspace.description)}</p>}</div></div><div className="flex shrink-0 items-center gap-1"><button type="button" onClick={openSettings} disabled={saveSettings.isPending} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border transition-colors hover:bg-[var(--ink-wash)] disabled:opacity-50" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }} title={t.agentWorkspace.editRepository} aria-label={t.agentWorkspace.editRepository}><Edit3 className="h-4 w-4" /></button><button type="button" onClick={() => void detail.refetch()} disabled={detail.isFetching || upload.isPending} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border transition-colors hover:bg-[var(--ink-wash)] disabled:opacity-50" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }} title={t.agentWorkspace.refresh} aria-label={t.agentWorkspace.refresh}><RefreshCw className={`h-4 w-4 ${detail.isFetching ? "animate-spin" : ""}`} /></button></div></div></header>
    <div className="mt-7 grid gap-7 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <main className="min-w-0 space-y-7"><section><PaperCard className="overflow-hidden"><div className="flex items-center gap-2 border-b px-5 py-5 sm:px-6" style={{ borderColor: "var(--ink-line)" }}><FileText className="h-4 w-4" style={{ color: "var(--ink-faint)" }} /><h2 className="text-base font-semibold" style={{ color: "var(--ink-strong)" }}>{t.agentWorkspace.filesTitle}</h2><span className="rounded-full px-2 py-0.5 text-[11px]" style={{ background: "var(--ink-wash)", color: "var(--ink-faint)" }}>{workspace.files.length}</span></div>{workspace.files.length === 0 ? <div className="px-5 py-10 text-sm" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.empty}</div> : <AgentWorkspaceFileTree key={workspace.workspaceId} files={workspace.files} hashLabel={t.agentWorkspace.hashLabel} onOpen={setSelectedFile} />}<AgentWorkspaceReadme content={readmeContent} loading={readme.isLoading} failed={readme.isError} copying={prompt.isPending} copied={copied} uploading={upload.isPending || syncLocal.isPending} scanningLocal={scanLocal.isPending} canScanLocal={isDesktopRuntime()} promptError={prompt.isError} promptErrorMessage={agentWorkspaceErrorMessage(prompt.error, t.agentWorkspace)} uploadError={upload.isError} uploadSuccess={upload.isSuccess || syncLocal.isSuccess} scanError={scanLocal.isError || syncLocal.isError} scanErrorMessage={agentWorkspaceErrorMessage(scanError, t.agentWorkspace)} onCopy={() => { prompt.reset(); prompt.mutate(); }} onImport={(files) => upload.mutate(files)} onScanLocal={() => { syncLocal.reset(); scanLocal.reset(); prompt.reset(); scanLocal.mutate(); }} onRetry={() => void readme.refetch()} /></PaperCard></section></main>
      <aside className="space-y-4"><PaperCard className="p-5"><h2 className="text-sm font-semibold" style={{ color: "var(--ink-strong)" }}>{t.agentWorkspace.aboutTitle}</h2><dl className="mt-4 space-y-4 text-xs"><InfoRow label={t.agentWorkspace.repositoryId} value={`#${workspace.workspaceId}`} /><InfoRow label={t.agentWorkspace.filesTitle} value={String(workspace.files.length)} /><InfoRow label={t.agentWorkspace.revision} value={`r${workspace.revision}`} /><InfoRow label={t.agentWorkspace.updatedLabel} value={new Date(workspace.updatedAt).toLocaleDateString(locale)} /></dl></PaperCard></aside>
    </div>
    {pendingLocalFiles && <AgentWorkspaceScanDialog files={pendingLocalFiles} filteredFiles={filteredLocalFiles} selectedPaths={selectedLocalPaths} pending={scanLocalPending} errorMessage={agentWorkspaceErrorMessage(scanError, t.agentWorkspace)} t={t.agentWorkspace} onToggleFile={(path) => setSelectedLocalPaths((current) => togglePath(current, path))} onToggleDirectory={(files) => setSelectedLocalPaths((current) => togglePaths(current, files.map((file) => file.path)))} onSelectAll={() => setSelectedLocalPaths(new Set([...pendingLocalFiles, ...filteredLocalFiles].map((file) => file.path)))} onClearAll={() => setSelectedLocalPaths(new Set())} onCancel={() => { if (!scanLocalPending) { setPendingLocalFiles(null); setFilteredLocalFiles([]); setSelectedLocalPaths(new Set()); } }} onConfirm={async () => { if (scanLocalPending) return; const allFiles = [...pendingLocalFiles, ...filteredLocalFiles]; const selected = allFiles.filter((file) => selectedLocalPaths.has(file.path)); const selectedFiltered = selected.filter((selectedFile) => filteredLocalFiles.some((filteredFile) => filteredFile.path === selectedFile.path)); if (selectedFiltered.length > 0 && !(await confirmAction(t.agentWorkspace.scanReviewSensitiveConfirm.replace("{count}", String(selectedFiltered.length))))) return; syncLocal.mutate({ selected, allowSensitive: selectedFiltered.length > 0 }); }} />}
    {editingSettings && <RepositorySettingsForm name={editName} description={editDescription} t={t} pending={saveSettings.isPending} error={saveSettings.isError} onName={setEditName} onDescription={setEditDescription} onSubmit={() => saveSettings.mutate()} onCancel={() => { saveSettings.reset(); setEditingSettings(false); }} />}
    {selectedFile !== null && <div className="mt-7"><FileEditor file={selectedFileQuery.data?.file} loading={selectedFileQuery.isLoading} errorMessage={t.agentWorkspace.fileSaveFailed} t={t.agentWorkspace} onClose={() => setSelectedFile(null)} onSave={async (content, mimeType) => { await patchAgentWorkspace({ workspaceId: workspace.workspaceId, expectedRevision: workspace.revision, upsert: [{ path: selectedFileQuery.data!.file.path, contentBase64: btoa(unescape(encodeURIComponent(content))), mimeType }] }); await detail.refetch(); }} /></div>}
    <PaperCard className="mt-7 p-5"><h2 className="text-sm font-semibold" style={{ color: "var(--ink-strong)" }}>{t.agentWorkspace.commitHistory}</h2><div className="mt-3 space-y-2">{commits.data?.commits.map((commit) => <div key={commit.commitId} className="flex items-center justify-between gap-3 border-b pb-2 text-xs last:border-b-0"><div><p style={{ color: "var(--ink-strong)" }}>r{commit.revision} · {commit.action}</p><p style={{ color: "var(--ink-faint)" }}>{new Date(commit.createdAt).toLocaleString(locale)}</p></div>{commit.revision !== workspace.revision && <button type="button" disabled={restore.isPending} onClick={async () => { if (await confirmAction(t.agentWorkspace.restoreCommitConfirm.replace("{revision}", String(commit.revision)))) restore.mutate(commit.revision); }} className="shrink-0 rounded border px-2 py-1" style={{ borderColor: "var(--ink-line)" }}>{t.agentWorkspace.restore}</button>}</div>)}</div></PaperCard>
  </PageContainer>;
}

type AgentSelectionNode = {
  name: string;
  path: string;
  kind: "directory" | "file";
  children: AgentSelectionNode[];
  file?: ConfigVaultFile;
};

function buildAgentSelectionTree(files: ConfigVaultFile[]): AgentSelectionNode[] {
  const roots: AgentSelectionNode[] = [];
  for (const file of files) {
    const parts = file.path.split("/");
    let children = roots;
    let path = "";
    parts.forEach((name, index) => {
      path = path ? `${path}/${name}` : name;
      const isFile = index === parts.length - 1;
      let node = children.find((candidate) => candidate.name === name);
      if (!node) {
        node = { name, path, kind: isFile ? "file" : "directory", children: [], ...(isFile ? { file } : {}) };
        children.push(node);
      }
      children = node.children;
    });
  }
  const sortNodes = (nodes: AgentSelectionNode[]): AgentSelectionNode[] => [...nodes]
    .sort((left, right) => left.kind !== right.kind ? (left.kind === "directory" ? -1 : 1) : left.name.localeCompare(right.name, undefined, { sensitivity: "base" }))
    .map((node) => ({ ...node, children: sortNodes(node.children) }));
  return sortNodes(roots);
}

function agentSelectionDescendants(node: AgentSelectionNode): ConfigVaultFile[] {
  if (node.kind === "file" && node.file) return [node.file];
  return node.children.flatMap(agentSelectionDescendants);
}

function togglePath(paths: Set<string>, path: string) {
  const next = new Set(paths);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

function togglePaths(paths: Set<string>, values: string[]) {
  const next = new Set(paths);
  const allSelected = values.every((value) => next.has(value));
  for (const value of values) {
    if (allSelected) next.delete(value);
    else next.add(value);
  }
  return next;
}

function agentWorkspaceErrorMessage(error: unknown, t: Record<string, string>) {
  if (!error) return null;
  if (error instanceof ApiError) {
    if (error.code === "sensitive_data_detected") {
      const path = error.message.match(/"([^\"]+)"/)?.[1];
      return path ? `${t.scanSensitiveData} ${path}` : t.scanSensitiveData;
    }
    if (error.code === "revision_conflict") return t.scanRevisionConflict;
    if (error.code === "agent_workspace_quota_exceeded") return t.scanQuotaExceeded;
    return error.message || null;
  }
  if (error instanceof Error) {
    if (error.message === "file too large" || error.message.startsWith("file too large:")) return t.scanReviewFileSizeLimit;
    if (error.message === "config_files_too_large") return t.scanLocalFailed;
    if (error.message === "no agent files found") return t.scanNoFilesFound;
    return error.message || null;
  }
  return null;
}

function AgentWorkspaceScanDialog({
  files,
  filteredFiles,
  selectedPaths,
  pending,
  errorMessage,
  t,
  onToggleFile,
  onToggleDirectory,
  onSelectAll,
  onClearAll,
  onCancel,
  onConfirm,
}: {
  files: ConfigVaultFile[];
  filteredFiles: AgentWorkspaceFilteredFile[];
  selectedPaths: Set<string>;
  pending: boolean;
  errorMessage: string | null;
  t: Record<string, string>;
  onToggleFile: (path: string) => void;
  onToggleDirectory: (files: ConfigVaultFile[]) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const [previewFile, setPreviewFile] = useState<ConfigVaultFile | null>(null);
  useEffect(() => pushModal(), []);
  const nodes = buildAgentSelectionTree(files);
  const filteredNodes = buildAgentSelectionTree(filteredFiles);
  const allFiles = [...files, ...filteredFiles];
  const selectedFiles = allFiles.filter((file) => selectedPaths.has(file.path));
  const selectedBytes = selectedFiles.reduce((total, file) => total + file.bytes.byteLength, 0);
  const selectedOversizedFiles = selectedFiles.filter((file) => file.bytes.byteLength > AGENT_WORKSPACE_MAX_FILE_BYTES);

  function renderNode(node: AgentSelectionNode, depth: number, isFiltered = false): ReactNode {
    const isDirectory = node.kind === "directory";
    const descendants = isDirectory ? agentSelectionDescendants(node) : node.file ? [node.file] : [];
    const selectedCount = descendants.filter((file) => selectedPaths.has(file.path)).length;
    const allSelected = descendants.length > 0 && selectedCount === descendants.length;
    const partiallySelected = selectedCount > 0 && !allSelected;
    const expansionKey = `${isFiltered ? "filtered" : "safe"}:${node.path}`;
    const expanded = isDirectory && expandedPaths.has(expansionKey);
    return <div key={expansionKey} role="treeitem" aria-expanded={isDirectory ? expanded : undefined}>
      <div className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs hover:bg-[var(--ink-wash)]" style={{ paddingLeft: `${depth * 16 + 4}px`, background: isFiltered ? "var(--cinnabar-wash)" : undefined }}>
        {isDirectory ? <button type="button" onClick={() => setExpandedPaths((current) => togglePath(current, expansionKey))} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" aria-label={`${expanded ? t.collapse : t.expand} ${node.path}`}>
          {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
          {expanded ? <FolderOpen className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--cinnabar)" }} /> : <Folder className="h-3.5 w-3.5 shrink-0" style={{ color: isFiltered ? "var(--cinnabar)" : "var(--ink-faint)" }} />}
          <span className="min-w-0 truncate" style={{ color: isFiltered ? "var(--cinnabar)" : "var(--ink-strong)" }}>{node.name}</span>
        </button> : <button type="button" onClick={() => node.file && setPreviewFile(node.file)} className="group flex min-w-0 flex-1 items-center gap-1.5 text-left" title={t.scanReviewPreview}>
          <FileText className="h-3.5 w-3.5 shrink-0" style={{ color: isFiltered ? "var(--cinnabar)" : "var(--ink-faint)" }} />
          <span className="min-w-0 truncate" title={node.path} style={{ color: isFiltered ? "var(--cinnabar)" : "var(--ink-mid)" }}>{node.name}</span>
          <Eye className="ml-auto h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-70" style={{ color: isFiltered ? "var(--cinnabar)" : "var(--ink-faint)" }} />
        </button>}
        <span className="shrink-0 text-[11px]" style={{ color: "var(--ink-faint)" }}>{isDirectory ? `${selectedCount}/${descendants.length}` : node.file ? formatBytes(node.file.bytes.byteLength) : ""}</span>
        <input type="checkbox" checked={allSelected} ref={(element) => { if (element) element.indeterminate = partiallySelected; }} onChange={() => isDirectory ? onToggleDirectory(descendants) : node.file && onToggleFile(node.file.path)} className="h-3.5 w-3.5 shrink-0 accent-[var(--cinnabar)]" aria-label={`${t.select} ${node.path}`} />
      </div>
      {isDirectory && expanded && <div role="group">{node.children.map((child) => renderNode(child, depth + 1, isFiltered))}</div>}
    </div>;
  }

  return <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]">
    <section role="dialog" aria-modal="true" aria-labelledby="agent-sync-review-title" className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-2xl border bg-[var(--background)] shadow-2xl" style={{ borderColor: "var(--ink-line)" }}>
      <div className="flex items-start gap-3 border-b px-5 py-4" style={{ borderColor: "var(--ink-line)" }}><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ background: "var(--cinnabar-soft)", color: "var(--cinnabar)" }}><ShieldCheck className="h-5 w-5" /></span><div className="min-w-0"><h2 id="agent-sync-review-title" className="kn-heading-cn text-base font-semibold" style={{ color: "var(--ink-black)" }}>{t.scanReviewTitle}</h2><p className="mt-1 text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{t.scanReviewDescription}</p></div></div>
      <div className="space-y-3 px-5 py-4"><div className="grid grid-cols-2 gap-2"><div className="rounded-xl border px-3 py-2.5" style={{ borderColor: "var(--ink-line)", background: "var(--paper)" }}><p className="text-[11px]" style={{ color: "var(--ink-faint)" }}>{t.scanReviewFilesLabel}</p><p className="mt-0.5 text-sm font-semibold" style={{ color: "var(--ink-strong)" }}>{t.scanReviewFiles.replace("{count}", String(selectedFiles.length))}</p></div><div className="rounded-xl border px-3 py-2.5" style={{ borderColor: "var(--ink-line)", background: "var(--paper)" }}><p className="text-[11px]" style={{ color: "var(--ink-faint)" }}>{t.scanReviewSizeLabel}</p><p className="mt-0.5 text-sm font-semibold" style={{ color: "var(--ink-strong)" }}>{t.scanReviewSize.replace("{size}", formatBytes(selectedBytes))}</p></div></div>{filteredFiles.length > 0 && <div className="rounded-xl border px-3 py-2.5 text-xs leading-5" style={{ borderColor: "var(--cinnabar-soft)", background: "var(--cinnabar-wash)", color: "var(--ink-mid)" }}><p>{t.scanReviewFiltered.replace("{count}", String(filteredFiles.length))}</p></div>}<div><div className="mb-1.5 flex items-center justify-between gap-3"><p className="text-xs font-semibold" style={{ color: "var(--ink-strong)" }}>{t.scanReviewFilesLabel}</p><div className="flex gap-2 text-[11px]"><button type="button" onClick={onSelectAll} disabled={allFiles.length === 0} className="rounded-full px-2 py-1 hover:bg-[var(--ink-wash)] disabled:opacity-40" style={{ color: "var(--cinnabar)" }}>{t.scanReviewSelectAll}</button><button type="button" onClick={onClearAll} className="rounded-full px-2 py-1 hover:bg-[var(--ink-wash)]" style={{ color: "var(--ink-mid)" }}>{t.scanReviewClearAll}</button></div></div><div className="max-h-56 overflow-y-auto rounded-xl border p-2" style={{ borderColor: "var(--ink-line)" }}>{files.length > 0 && <div role="tree" className="space-y-0.5">{nodes.map((node) => renderNode(node, 0))}</div>}{files.length === 0 && <p className="px-2 py-3 text-xs" style={{ color: "var(--ink-faint)" }}>{t.scanReviewNoSafeFiles}</p>}{filteredFiles.length > 0 && <><div className="my-2 border-t pt-2" style={{ borderColor: "var(--ink-line)" }}><p className="px-1 text-[11px] font-semibold" style={{ color: "var(--cinnabar)" }}>{t.scanReviewFilteredSection}</p></div><div role="tree" className="space-y-0.5">{filteredNodes.map((node) => renderNode(node, 0, true))}</div></>}</div></div><div className="flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs leading-5" style={{ borderColor: "var(--cinnabar-soft)", background: "var(--cinnabar-wash)", color: "var(--ink-mid)" }}><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--cinnabar)" }} /><span>{t.scanReviewWarning}</span></div>{selectedOversizedFiles.length > 0 && <p className="text-xs leading-5" role="alert" style={{ color: "var(--cinnabar)" }}>{t.scanReviewFileSizeLimit}</p>}{errorMessage && <p className="text-xs leading-5" role="alert" style={{ color: "var(--cinnabar)" }}>{errorMessage}</p>}</div>
      <div className="flex justify-end gap-2 border-t px-5 py-3" style={{ borderColor: "var(--ink-line)" }}><button type="button" onClick={onCancel} disabled={pending} className="rounded-full border px-4 py-2 text-sm font-medium transition hover:bg-[var(--ink-wash)] disabled:opacity-50" style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}>{t.scanReviewCancel}</button><button type="button" onClick={onConfirm} disabled={pending || selectedFiles.length === 0 || selectedOversizedFiles.length > 0} className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50" style={{ background: "var(--cinnabar)" }}>{pending && <RefreshCw className="h-4 w-4 animate-spin" />}{t.scanReviewUpload}</button></div>
    </section>
    {previewFile && <AgentWorkspaceFilePreviewDialog file={previewFile} onClose={() => setPreviewFile(null)} t={t} />}
  </div>;
}

function AgentWorkspaceFilePreviewDialog({ file, onClose, t }: { file: ConfigVaultFile; onClose: () => void; t: Record<string, string> }) {
  const previewBytes = file.bytes.subarray(0, 2 * 1024 * 1024);
  const text = new TextDecoder("utf-8").decode(previewBytes);
  const isTruncated = file.bytes.byteLength > previewBytes.byteLength;
  const isBinary = previewBytes.some((byte) => byte === 0);

  useEffect(() => {
    const releaseModal = pushModal();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      releaseModal();
    };
  }, [onClose]);

  return <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="agent-file-preview-title" className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border bg-[var(--background)] shadow-2xl" style={{ borderColor: "var(--ink-line)" }}>
      <header className="flex shrink-0 items-center gap-3 border-b px-5 py-4" style={{ borderColor: "var(--ink-line)" }}>
        <Eye className="h-5 w-5 shrink-0" style={{ color: "var(--cinnabar)" }} />
        <div className="min-w-0 flex-1"><h2 id="agent-file-preview-title" className="truncate text-base font-semibold" style={{ color: "var(--ink-strong)" }}>{t.scanReviewPreviewTitle}</h2><p className="mt-0.5 truncate text-xs" style={{ color: "var(--ink-faint)" }}>~/{file.path} · {formatBytes(file.bytes.byteLength)}</p></div>
        <button type="button" onClick={onClose} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--ink-wash)]" aria-label={t.scanReviewPreviewClose}><X className="h-4 w-4" /></button>
      </header>
      <div className="min-h-0 overflow-y-auto p-4 sm:p-5">
        {isBinary ? <div className="rounded-xl border p-5 text-sm" style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}>{t.scanReviewPreviewBinary}</div> : <pre className="max-h-[68vh] overflow-auto whitespace-pre-wrap break-words rounded-xl border p-4 font-mono text-xs leading-6" style={{ borderColor: "var(--ink-line)", background: "var(--paper)", color: "var(--ink-strong)" }}>{text || t.scanReviewPreviewEmpty}</pre>}
        {!isBinary && isTruncated && <p className="mt-2 text-xs" style={{ color: "var(--ink-faint)" }}>{t.scanReviewPreviewTruncated}</p>}
      </div>
    </section>
  </div>;
}

function RepositorySettingsForm({ name, description, t, pending, error, onName, onDescription, onSubmit, onCancel }: { name: string; description: string; t: any; pending: boolean; error: boolean; onName: (value: string) => void; onDescription: (value: string) => void; onSubmit: () => void; onCancel: () => void }) {
  useEffect(() => {
    const releaseModal = pushModal();
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !pending) onCancel(); };
    document.addEventListener("keydown", handleKeyDown);
    return () => { document.removeEventListener("keydown", handleKeyDown); releaseModal(); };
  }, [onCancel, pending]);
  return <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]" role="presentation" onClick={() => { if (!pending) onCancel(); }}><div className="w-full max-w-2xl" role="dialog" aria-modal="true" aria-labelledby="repository-settings-title" onClick={(event) => event.stopPropagation()}><PaperCard className="overflow-hidden shadow-2xl"><div className="flex items-center justify-between border-b px-6 py-5" style={{ borderColor: "var(--ink-line)" }}><h2 id="repository-settings-title" className="text-lg font-semibold" style={{ color: "var(--ink-strong)" }}>{t.agentWorkspace.repositorySettings}</h2><button type="button" disabled={pending} onClick={onCancel} className="inline-flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-[var(--ink-wash)] disabled:opacity-50" style={{ color: "var(--ink-mid)" }} title={t.llmChannels.cancel} aria-label={t.llmChannels.cancel}><X className="h-5 w-5" /></button></div><form className="space-y-5 p-6" onSubmit={(event) => { event.preventDefault(); if (!pending && name.trim()) onSubmit(); }}><label className="block text-sm" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.repositoryName}<input autoFocus value={name} onChange={(event) => onName(event.target.value)} maxLength={80} className="mt-2 w-full rounded-lg border bg-transparent px-3.5 py-3 text-base outline-none" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }} /></label><label className="block text-sm" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.repositoryDescription}<textarea value={description} onChange={(event) => onDescription(event.target.value)} placeholder={t.agentWorkspace.repositoryDescriptionPlaceholder} maxLength={500} rows={6} className="mt-2 w-full resize-y rounded-lg border bg-transparent px-3.5 py-3 text-base leading-6 outline-none" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }} /></label>{error && <p className="text-sm" role="alert" style={{ color: "var(--cinnabar)" }}>{t.agentWorkspace.repositorySettingsSaveFailed}</p>}<div className="flex justify-end gap-3 border-t pt-5" style={{ borderColor: "var(--ink-line)" }}><button type="button" disabled={pending} onClick={onCancel} className="rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--ink-wash)] disabled:opacity-50" style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}>{t.llmChannels.cancel}</button><button type="submit" disabled={pending || !name.trim()} className="inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold disabled:opacity-50" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>{pending && <RefreshCw className="h-4 w-4 animate-spin" />}{t.agentWorkspace.saveRepository}</button></div></form></PaperCard></div></div>;
}
function Badge({ children, icon }: { children: string; icon?: ReactNode }) { return <span className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium" style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}>{icon}{children}</span>; }
function InfoRow({ label, value }: { label: string; value: string }) { return <div><dt style={{ color: "var(--ink-faint)" }}>{label}</dt><dd className="mt-1 font-medium" style={{ color: "var(--ink-strong)" }}>{value}</dd></div>; }
function FileEditor({ file, loading, errorMessage, t, onClose, onSave }: { file?: { path: string; mimeType: string; contentBase64: string }; loading: boolean; errorMessage: string; t: Record<string, string>; onClose: () => void; onSave: (content: string, mimeType: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false); const [value, setValue] = useState(""); const [saving, setSaving] = useState(false); const [saveError, setSaveError] = useState(false);
  useEffect(() => pushModal(), []);
  useEffect(() => { if (file) setValue(decodeAgentWorkspaceText(file.contentBase64)); }, [file]);
  const isCode = Boolean(file && (/\.(ts|tsx|js|jsx|json|go|py|rs|java|css|html|sql|sh|yaml|yml|toml|md)$/i.test(file.path) || file.mimeType.startsWith("text/")));
  if (loading) return <PaperCard className="p-6 text-sm">{t.loadingFile}</PaperCard>;
  if (!file) return null;
  return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4" onClick={onClose}><PaperCard className="flex h-[min(85vh,50rem)] w-full max-w-5xl flex-col overflow-hidden" onClick={(event: MouseEvent) => event.stopPropagation()}><div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: "var(--ink-line)" }}><code className="truncate text-sm font-semibold">{file.path}</code><div className="flex gap-2"><button type="button" onClick={() => { setSaveError(false); setEditing(!editing); }} className="rounded-md border px-3 py-1.5 text-xs">{editing ? t.preview : t.edit}</button><button type="button" onClick={onClose} className="p-1" aria-label={t.close}><X className="h-4 w-4" /></button></div></div>{editing ? <textarea value={value} onChange={(event) => { setSaveError(false); setValue(event.target.value); }} className="min-h-0 flex-1 resize-none bg-transparent p-5 font-mono text-sm leading-6 outline-none" spellCheck={false} /> : <pre className={`min-h-0 flex-1 overflow-auto p-5 font-mono text-sm leading-6 ${isCode ? "language-auto" : ""}`}><code>{value}</code></pre>}{editing && <div className="border-t px-5 py-3" style={{ borderColor: "var(--ink-line)" }}>{saveError && <p className="mb-2 text-sm" role="alert" style={{ color: "var(--cinnabar)" }}>{errorMessage}</p>}<div className="flex justify-end"><button type="button" disabled={saving} onClick={async () => { setSaving(true); setSaveError(false); try { await onSave(value, file.mimeType); setEditing(false); } catch { setSaveError(true); } finally { setSaving(false); } }} className="rounded-md px-4 py-2 text-xs font-semibold" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>{saving ? t.saving : t.save}</button></div></div>}</PaperCard></div>;
}
function PageLoading({ children }: { children: string }) { return <div className="flex flex-1 items-center justify-center py-24 text-sm" style={{ color: "var(--ink-faint)" }}>{children}</div>; }
function PageMessage({ children }: { children: ReactNode }) { return <div className="flex flex-1 flex-col items-center justify-center px-4 py-24 text-center text-sm" style={{ color: "var(--ink-mid)" }}>{children}</div>; }
function normalizeRepositoryDescription(description: string) { return ["可选，用于区分不同配置", "Optional, to distinguish configurations", "Facultatif, pour distinguer les configurations", "任意。設定の区別に使います"].includes(description.trim()) ? "" : description; }
