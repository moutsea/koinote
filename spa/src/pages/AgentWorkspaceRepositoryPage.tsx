import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { ArrowLeft, ChevronRight, Cloud, Edit3, FileText, LockKeyhole, RefreshCw, X } from "lucide-react";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { AGENT_WORKSPACE_QUERY_KEY, getAgentWorkspace, getAgentWorkspaceFile, getAgentWorkspacePrompt, getAgentWorkspaceStorage, listAgentWorkspaceCommits, listMCPTokens, revealMCPToken, restoreAgentWorkspaceCommit, updateAgentWorkspace, updateAgentWorkspaceMetadata } from "../api";
import { prepareAgentWorkspaceImport, decodeAgentWorkspaceText } from "../agentWorkspaceImport";
import { useSession } from "../auth";
import { AgentWorkspaceReadme } from "../components/AgentWorkspaceReadme";
import { AgentWorkspaceFileTree } from "../components/AgentWorkspaceFileTree";
import { PaperCard } from "../components/Ink";
import { AgentWorkspaceStorageCard } from "../components/AgentWorkspaceStorageCard";
import { PageContainer } from "../components/PageContainer";
import { useI18n } from "../i18n";
import { confirmAction } from "../confirmAction";

export function AgentWorkspaceRepositoryPage() {
  const { t, locale } = useI18n();
  const session = useSession();
  const queryClient = useQueryClient();
  const params = useParams({ strict: false }) as { workspaceId?: string };
  const search = useSearch({ strict: false }) as { from?: "hub" | "settings" };
  const workspaceId = Number(params.workspaceId);
  const user = session.data?.user;
  const canAccess = Boolean(user && user.membershipTier === "lifetime" && !user.isLocalMode && Number.isInteger(workspaceId) && workspaceId > 0);
  const detail = useQuery({ queryKey: [...AGENT_WORKSPACE_QUERY_KEY, workspaceId], queryFn: () => getAgentWorkspace(workspaceId), enabled: canAccess, retry: false });
  const storage = useQuery({ queryKey: ["agent-workspace-storage"], queryFn: getAgentWorkspaceStorage, enabled: canAccess, retry: false });
  const commits = useQuery({ queryKey: ["agent-workspace-commits", workspaceId], queryFn: () => listAgentWorkspaceCommits(workspaceId), enabled: canAccess, retry: false });
  const tokens = useQuery({ queryKey: ["mcp-tokens"], queryFn: listMCPTokens, enabled: canAccess, retry: false });
  const readmeFile = detail.data?.workspace?.files.find((file) => file.path.toLowerCase() === "readme.md");
  const readme = useQuery({ queryKey: ["agent-workspace-readme", readmeFile?.fileId, readmeFile?.sha256], queryFn: () => getAgentWorkspaceFile(readmeFile!.fileId), enabled: canAccess && readmeFile !== undefined, retry: false });
  const [copied, setCopied] = useState(false);
  const [editingSettings, setEditingSettings] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [selectedFile, setSelectedFile] = useState<number | null>(null);
  const selectedFileQuery = useQuery({ queryKey: ["agent-workspace-file", selectedFile], queryFn: () => getAgentWorkspaceFile(selectedFile!), enabled: selectedFile !== null, retry: false });
  const prompt = useMutation({
    mutationFn: async () => {
      const currentTokens = tokens.data?.tokens ?? (await listMCPTokens()).tokens;
      const token = currentTokens.find((item) => item.scope === "agent_write" && item.revealable) ?? currentTokens.find((item) => item.scope === "agent_read" && item.revealable);
      if (!token) throw new Error("no revealable agent token");
      const [result, revealed] = await Promise.all([getAgentWorkspacePrompt(workspaceId), revealMCPToken(token.tokenId)]);
      await navigator.clipboard.writeText(`${result.prompt}\n\nAuthentication token for this session (keep it secret):\nKOINOTE_MCP_TOKEN=${revealed.secret}\nUse this value as the Bearer token for both REST API and MCP requests.`);
    },
    onSuccess() { setCopied(true); window.setTimeout(() => setCopied(false), 1800); },
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
  const backLink = search.from === "hub" ? <Link to="/agent/workspaces" className="inline-flex items-center gap-1.5 text-sm font-medium transition-opacity hover:opacity-70" style={{ color: "var(--ink-mid)" }}><ArrowLeft className="h-4 w-4" />{t.agentWorkspace.backToRepositories}</Link> : <Link to="/settings" search={{ section: "agent" }} className="inline-flex items-center gap-1.5 text-sm font-medium transition-opacity hover:opacity-70" style={{ color: "var(--ink-mid)" }}><ArrowLeft className="h-4 w-4" />{t.agentWorkspace.backToRepositories}</Link>;
  const readmeContent = readme.data?.file ? decodeAgentWorkspaceText(readme.data.file.contentBase64) : null;

  return <PageContainer className="flex-1 py-7 sm:py-10">
    <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: "var(--ink-faint)" }}><Link to="/agent/workspaces" className="transition-opacity hover:opacity-70">Skills / Agent Hub</Link><ChevronRight className="h-3.5 w-3.5" /><span className="max-w-[16rem] truncate" style={{ color: "var(--ink-mid)" }}>{workspace.name}</span></div>
    <div className="mt-5">{backLink}</div><div className="mt-5"><AgentWorkspaceStorageCard storage={storage.data?.storage} compact /></div>
    <header className="mt-6 border-b pb-6" style={{ borderColor: "var(--ink-line)" }}><div className="flex min-w-0 items-start justify-between gap-4"><div className="flex min-w-0 items-start gap-4"><div className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-xl sm:flex" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}><Cloud className="h-6 w-6" /></div><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h1 className="kn-heading-cn break-words text-2xl font-bold tracking-tight sm:text-3xl" style={{ color: "var(--ink-black)" }}>{workspace.name}</h1><Badge icon={<LockKeyhole className="h-3 w-3" />}>{t.agentWorkspace.privateBadge}</Badge><Badge>{t.agentWorkspace.kindBadge}</Badge></div>{normalizeRepositoryDescription(workspace.description) && <p className="mt-3 max-w-2xl text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{normalizeRepositoryDescription(workspace.description)}</p>}</div></div><div className="flex shrink-0 items-center gap-1"><button type="button" onClick={openSettings} disabled={saveSettings.isPending} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border transition-colors hover:bg-[var(--ink-wash)] disabled:opacity-50" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }} title={t.agentWorkspace.editRepository} aria-label={t.agentWorkspace.editRepository}><Edit3 className="h-4 w-4" /></button><button type="button" onClick={() => void detail.refetch()} disabled={detail.isFetching || upload.isPending} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border transition-colors hover:bg-[var(--ink-wash)] disabled:opacity-50" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }} title={t.agentWorkspace.refresh} aria-label={t.agentWorkspace.refresh}><RefreshCw className={`h-4 w-4 ${detail.isFetching ? "animate-spin" : ""}`} /></button></div></div></header>
    <div className="mt-7 grid gap-7 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <main className="min-w-0 space-y-7"><section><PaperCard className="overflow-hidden"><div className="flex items-center gap-2 border-b px-5 py-5 sm:px-6" style={{ borderColor: "var(--ink-line)" }}><FileText className="h-4 w-4" style={{ color: "var(--ink-faint)" }} /><h2 className="text-base font-semibold" style={{ color: "var(--ink-strong)" }}>{t.agentWorkspace.filesTitle}</h2><span className="rounded-full px-2 py-0.5 text-[11px]" style={{ background: "var(--ink-wash)", color: "var(--ink-faint)" }}>{workspace.files.length}</span></div>{workspace.files.length === 0 ? <div className="px-5 py-10 text-sm" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.empty}</div> : <AgentWorkspaceFileTree key={workspace.workspaceId} files={workspace.files} hashLabel={t.agentWorkspace.hashLabel} onOpen={setSelectedFile} />}<AgentWorkspaceReadme content={readmeContent} loading={readme.isLoading} failed={readme.isError} copying={prompt.isPending} copied={copied} uploading={upload.isPending} promptError={prompt.isError} uploadError={upload.isError} uploadSuccess={upload.isSuccess} onCopy={() => prompt.mutate()} onImport={(files) => upload.mutate(files)} onRetry={() => void readme.refetch()} /></PaperCard></section></main>
      <aside className="space-y-4"><PaperCard className="p-5"><h2 className="text-sm font-semibold" style={{ color: "var(--ink-strong)" }}>{t.agentWorkspace.aboutTitle}</h2><dl className="mt-4 space-y-4 text-xs"><InfoRow label={t.agentWorkspace.repositoryId} value={`#${workspace.workspaceId}`} /><InfoRow label={t.agentWorkspace.filesTitle} value={String(workspace.files.length)} /><InfoRow label={t.agentWorkspace.revision} value={`r${workspace.revision}`} /><InfoRow label={t.agentWorkspace.updatedLabel} value={new Date(workspace.updatedAt).toLocaleDateString(locale)} /></dl></PaperCard></aside>
    </div>
    {editingSettings && <RepositorySettingsForm name={editName} description={editDescription} t={t} pending={saveSettings.isPending} error={saveSettings.isError} onName={setEditName} onDescription={setEditDescription} onSubmit={() => saveSettings.mutate()} onCancel={() => { saveSettings.reset(); setEditingSettings(false); }} />}
    {selectedFile !== null && <div className="mt-7"><FileEditor file={selectedFileQuery.data?.file} loading={selectedFileQuery.isLoading} onClose={() => setSelectedFile(null)} onSave={async (content, mimeType) => { await updateAgentWorkspace({ workspaceId: workspace.workspaceId, expectedRevision: workspace.revision, files: [{ path: selectedFileQuery.data!.file.path, contentBase64: btoa(unescape(encodeURIComponent(content))), mimeType }] }); await detail.refetch(); }} /></div>}
    <PaperCard className="mt-7 p-5"><h2 className="text-sm font-semibold" style={{ color: "var(--ink-strong)" }}>提交历史</h2><div className="mt-3 space-y-2">{commits.data?.commits.map((commit) => <div key={commit.commitId} className="flex items-center justify-between gap-3 border-b pb-2 text-xs last:border-b-0"><div><p style={{ color: "var(--ink-strong)" }}>r{commit.revision} · {commit.action}</p><p style={{ color: "var(--ink-faint)" }}>{new Date(commit.createdAt).toLocaleString(locale)}</p></div>{commit.revision !== workspace.revision && <button type="button" disabled={restore.isPending} onClick={async () => { if (await confirmAction(`恢复到提交 r${commit.revision}？这会生成一个新的提交。`)) restore.mutate(commit.revision); }} className="shrink-0 rounded border px-2 py-1" style={{ borderColor: "var(--ink-line)" }}>恢复</button>}</div>)}</div></PaperCard>
  </PageContainer>;
}

function RepositorySettingsForm({ name, description, t, pending, error, onName, onDescription, onSubmit, onCancel }: { name: string; description: string; t: any; pending: boolean; error: boolean; onName: (value: string) => void; onDescription: (value: string) => void; onSubmit: () => void; onCancel: () => void }) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !pending) onCancel(); };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, pending]);
  return <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]" role="presentation" onClick={() => { if (!pending) onCancel(); }}><div className="w-full max-w-2xl" role="dialog" aria-modal="true" aria-labelledby="repository-settings-title" onClick={(event) => event.stopPropagation()}><PaperCard className="overflow-hidden shadow-2xl"><div className="flex items-center justify-between border-b px-6 py-5" style={{ borderColor: "var(--ink-line)" }}><h2 id="repository-settings-title" className="text-lg font-semibold" style={{ color: "var(--ink-strong)" }}>{t.agentWorkspace.repositorySettings}</h2><button type="button" disabled={pending} onClick={onCancel} className="inline-flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-[var(--ink-wash)] disabled:opacity-50" style={{ color: "var(--ink-mid)" }} title={t.llmChannels.cancel} aria-label={t.llmChannels.cancel}><X className="h-5 w-5" /></button></div><form className="space-y-5 p-6" onSubmit={(event) => { event.preventDefault(); if (!pending && name.trim()) onSubmit(); }}><label className="block text-sm" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.repositoryName}<input autoFocus value={name} onChange={(event) => onName(event.target.value)} maxLength={80} className="mt-2 w-full rounded-lg border bg-transparent px-3.5 py-3 text-base outline-none" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }} /></label><label className="block text-sm" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.repositoryDescription}<textarea value={description} onChange={(event) => onDescription(event.target.value)} placeholder={t.agentWorkspace.repositoryDescriptionPlaceholder} maxLength={500} rows={6} className="mt-2 w-full resize-y rounded-lg border bg-transparent px-3.5 py-3 text-base leading-6 outline-none" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }} /></label>{error && <p className="text-sm" role="alert" style={{ color: "var(--cinnabar)" }}>{t.agentWorkspace.repositorySettingsSaveFailed}</p>}<div className="flex justify-end gap-3 border-t pt-5" style={{ borderColor: "var(--ink-line)" }}><button type="button" disabled={pending} onClick={onCancel} className="rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--ink-wash)] disabled:opacity-50" style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}>{t.llmChannels.cancel}</button><button type="submit" disabled={pending || !name.trim()} className="inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold disabled:opacity-50" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>{pending && <RefreshCw className="h-4 w-4 animate-spin" />}{t.agentWorkspace.saveRepository}</button></div></form></PaperCard></div></div>;
}
function Badge({ children, icon }: { children: string; icon?: ReactNode }) { return <span className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium" style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}>{icon}{children}</span>; }
function InfoRow({ label, value }: { label: string; value: string }) { return <div><dt style={{ color: "var(--ink-faint)" }}>{label}</dt><dd className="mt-1 font-medium" style={{ color: "var(--ink-strong)" }}>{value}</dd></div>; }
function FileEditor({ file, loading, onClose, onSave }: { file?: { path: string; mimeType: string; contentBase64: string }; loading: boolean; onClose: () => void; onSave: (content: string, mimeType: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false); const [value, setValue] = useState(""); const [saving, setSaving] = useState(false);
  useEffect(() => { if (file) setValue(decodeAgentWorkspaceText(file.contentBase64)); }, [file]);
  const isCode = Boolean(file && (/\.(ts|tsx|js|jsx|json|go|py|rs|java|css|html|sql|sh|yaml|yml|toml|md)$/i.test(file.path) || file.mimeType.startsWith("text/")));
  if (loading) return <PaperCard className="p-6 text-sm">加载文件中…</PaperCard>;
  if (!file) return null;
  return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4" onClick={onClose}><PaperCard className="flex h-[min(85vh,50rem)] w-full max-w-5xl flex-col overflow-hidden" onClick={(event: MouseEvent) => event.stopPropagation()}><div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: "var(--ink-line)" }}><code className="truncate text-sm font-semibold">{file.path}</code><div className="flex gap-2"><button type="button" onClick={() => setEditing(!editing)} className="rounded-md border px-3 py-1.5 text-xs">{editing ? "预览" : "编辑"}</button><button type="button" onClick={onClose} className="p-1"><X className="h-4 w-4" /></button></div></div>{editing ? <textarea value={value} onChange={(event) => setValue(event.target.value)} className="min-h-0 flex-1 resize-none bg-transparent p-5 font-mono text-sm leading-6 outline-none" spellCheck={false} /> : <pre className={`min-h-0 flex-1 overflow-auto p-5 font-mono text-sm leading-6 ${isCode ? "language-auto" : ""}`}><code>{value}</code></pre>}{editing && <div className="flex justify-end border-t px-5 py-3" style={{ borderColor: "var(--ink-line)" }}><button type="button" disabled={saving} onClick={async () => { setSaving(true); try { await onSave(value, file.mimeType); setEditing(false); } finally { setSaving(false); } }} className="rounded-md px-4 py-2 text-xs font-semibold" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>{saving ? "保存中…" : "保存"}</button></div>}</PaperCard></div>;
}
function PageLoading({ children }: { children: string }) { return <div className="flex flex-1 items-center justify-center py-24 text-sm" style={{ color: "var(--ink-faint)" }}>{children}</div>; }
function PageMessage({ children }: { children: ReactNode }) { return <div className="flex flex-1 flex-col items-center justify-center px-4 py-24 text-center text-sm" style={{ color: "var(--ink-mid)" }}>{children}</div>; }
function normalizeRepositoryDescription(description: string) { return ["可选，用于区分不同配置", "Optional, to distinguish configurations", "Facultatif, pour distinguer les configurations", "任意。設定の区別に使います"].includes(description.trim()) ? "" : description; }
