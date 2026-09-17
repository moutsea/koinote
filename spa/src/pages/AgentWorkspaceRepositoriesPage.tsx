import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, ChevronRight, Cloud, Edit3, FolderGit2, LoaderCircle, LockKeyhole, Plus, Search, Settings2, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from "react";
import { useSession } from "../auth";
import { createAgentWorkspace, deleteAgentWorkspace, getAgentWorkspaceSettings, getAgentWorkspaceStorage, listAgentWorkspaces, updateAgentWorkspaceMetadata, type AgentWorkspaceSummary } from "../api";
import { confirmAction } from "../confirmAction";
import { PaperCard } from "../components/Ink";
import { AgentWorkspaceStorageCard } from "../components/AgentWorkspaceStorageCard";
import { PageContainer } from "../components/PageContainer";
import { useI18n } from "../i18n";

export function AgentWorkspaceRepositoriesPage() {
  const session = useSession();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const user = session.data?.user;
  const settings = useQuery({ queryKey: ["agent-workspace-settings"], queryFn: getAgentWorkspaceSettings, enabled: Boolean(user && !user.isLocalMode), retry: false });
  const enabled = settings.data?.enabled === true;
  const repositories = useQuery({ queryKey: ["agent-workspaces"], queryFn: listAgentWorkspaces, enabled, retry: false });
  const storage = useQuery({ queryKey: ["agent-workspace-storage"], queryFn: getAgentWorkspaceStorage, enabled, retry: false });
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [editingID, setEditingID] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");

  const create = useMutation({
    mutationFn: () => createAgentWorkspace({ name: name.trim(), description: description.trim(), locale }),
    onSuccess() { setName(""); setDescription(""); setShowCreate(false); void queryClient.invalidateQueries({ queryKey: ["agent-workspaces"] }); },
  });
  const editingWorkspace = repositories.data?.workspaces.find((item) => item.workspaceId === editingID);
  const save = useMutation({
    mutationFn: () => editingWorkspace ? updateAgentWorkspaceMetadata(editingWorkspace.workspaceId, { expectedRevision: editingWorkspace.revision, name: editName.trim(), description: editDescription.trim() }) : Promise.reject(new Error("repository not found")),
    onSuccess() { setEditingID(null); void queryClient.invalidateQueries({ queryKey: ["agent-workspaces"] }); },
  });
  const remove = useMutation({
    mutationFn: (workspace: AgentWorkspaceSummary) => deleteAgentWorkspace(workspace.workspaceId, workspace.revision),
    onSuccess() { void queryClient.invalidateQueries({ queryKey: ["agent-workspaces"] }); },
  });
  const openCreate = () => { create.reset(); setName(""); setDescription(""); setEditingID(null); setShowCreate(true); };
  const closeCreate = () => { create.reset(); setName(""); setDescription(""); setShowCreate(false); };
  useEffect(() => {
    if (editingID !== null && !repositories.data?.workspaces.some((item) => item.workspaceId === editingID)) setEditingID(null);
  }, [editingID, repositories.data?.workspaces]);
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (repositories.data?.workspaces ?? []).filter((workspace) => !query || `${workspace.name} ${workspace.description}`.toLocaleLowerCase().includes(query));
  }, [repositories.data?.workspaces, search]);

  if (session.isLoading) return <PageLoading>{t.dashboard.loading}</PageLoading>;
  if (!user) return <PageMessage><p>{t.dashboard.loginRequired}</p><Link to="/login" className="mt-4 inline-flex rounded-full px-5 py-2.5 text-sm font-semibold" style={{ background: "var(--cinnabar)", color: "white" }}>{t.dashboard.goLogin}</Link></PageMessage>;
  if (user.isLocalMode) return <PageMessage>{t.agentWorkspace.localMode}</PageMessage>;
  if (user.membershipTier !== "lifetime") return <PageMessage><p>{t.agentWorkspace.membersOnly}</p><Link to="/pricing" className="mt-4 inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>{t.mcp.upgrade}<ArrowRight className="h-4 w-4" /></Link></PageMessage>;
  if (settings.isLoading) return <PageLoading>{t.agentWorkspace.loading}</PageLoading>;
  if (settings.isError) return <PageMessage>{t.agentWorkspace.repositoryLoadFailed}</PageMessage>;

  return <PageContainer className="flex-1 py-7 sm:py-10">
    <div className="flex items-center gap-2 text-xs" style={{ color: "var(--ink-faint)" }}><Cloud className="h-3.5 w-3.5" /><span>Skills / Agent</span><ChevronRight className="h-3.5 w-3.5" /><span style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.repositoryHubTitle}</span></div>
    <header className="mt-6 flex flex-col gap-5 border-b pb-7 sm:flex-row sm:items-end sm:justify-between" style={{ borderColor: "var(--ink-line)" }}>
      <div className="flex min-w-0 items-start gap-4"><div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}><Cloud className="h-6 w-6" /></div><div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--cinnabar)" }}>Koinote</p><h1 className="kn-heading-cn mt-1 text-2xl font-bold tracking-tight sm:text-3xl" style={{ color: "var(--ink-black)" }}>{t.agentWorkspace.repositoryHubTitle}</h1><p className="mt-2 max-w-2xl text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.repositoryHubDescription}</p></div></div>
      <div className="flex shrink-0 flex-wrap gap-2"><Link to="/agent/settings" className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors hover:bg-[var(--ink-wash)]" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}><Settings2 className="h-3.5 w-3.5" />{t.agentWorkspace.settingsTab}</Link>{enabled && <button type="button" onClick={openCreate} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold shadow-sm transition-opacity hover:opacity-90" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}><Plus className="h-3.5 w-3.5" />{t.agentWorkspace.newRepository}</button>}</div>
    </header>
    {enabled && <div className="mt-6"><AgentWorkspaceStorageCard storage={storage.data?.storage} /></div>}
    {!enabled ? <EnablePanel /> : <div className="mt-7 grid gap-7 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <main className="min-w-0">
        {showCreate ? <CreateRepositoryView name={name} description={description} t={t} pending={create.isPending} error={create.isError} onName={setName} onDescription={setDescription} onSubmit={() => create.mutate()} onCancel={closeCreate} /> : <>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-lg font-semibold" style={{ color: "var(--ink-strong)" }}>{t.agentWorkspace.repositoriesTab}</h2><p className="mt-1 text-xs" style={{ color: "var(--ink-faint)" }}>{t.agentWorkspace.repositoryCount.replace("{count}", String(repositories.data?.workspaces.length ?? 0))}</p></div><label className="relative block sm:w-64"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: "var(--ink-faint)" }} /><span className="sr-only">{t.agentWorkspace.searchRepositories}</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t.agentWorkspace.searchRepositoriesPlaceholder} className="w-full rounded-lg border bg-transparent py-2 pl-9 pr-3 text-sm outline-none transition-colors focus:border-[var(--ink-strong)]" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }} /></label></div>
          {editingWorkspace && <><MetadataForm name={editName} description={editDescription} t={t} submitLabel={t.agentWorkspace.saveRepository} pending={save.isPending} onName={setEditName} onDescription={setEditDescription} onSubmit={() => save.mutate()} onCancel={() => setEditingID(null)} />{save.isError && <p className="-mt-2 mb-4 text-sm" role="alert" style={{ color: "var(--cinnabar)" }}>{t.agentWorkspace.repositoryLoadFailed}</p>}</>}
          {repositories.isLoading ? <LoadingList /> : repositories.isError ? <PaperCard className="p-8 text-center text-sm"><p style={{ color: "var(--cinnabar)" }}>{t.agentWorkspace.repositoryLoadFailed}</p></PaperCard> : filtered.length === 0 ? <PaperCard className="p-10 text-center"><FolderGit2 className="mx-auto h-9 w-9" style={{ color: "var(--ink-faint)" }} /><p className="mt-3 text-sm" style={{ color: "var(--ink-mid)" }}>{search ? t.agentWorkspace.noSearchResults : t.agentWorkspace.noRepositories}</p>{!search && <button type="button" onClick={openCreate} className="mt-4 inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}><Plus className="h-3.5 w-3.5" />{t.agentWorkspace.createRepository}</button>}</PaperCard> : <div className="space-y-3">{filtered.map((workspace) => <RepositoryItem key={workspace.workspaceId} workspace={workspace} locale={locale} t={t} onEdit={() => { setEditName(workspace.name); setEditDescription(workspace.description); setEditingID(workspace.workspaceId); setShowCreate(false); }} onDelete={async () => { if (await confirmAction(t.agentWorkspace.deleteRepositoryConfirm)) remove.mutate(workspace); }} deletePending={remove.isPending} />)}</div>}
        </>}
      </main>
      <aside className="space-y-4"><PaperCard className="p-5"><div className="flex items-center gap-2"><FolderGit2 className="h-4 w-4" style={{ color: "var(--ink-strong)" }} /><h2 className="text-sm font-semibold" style={{ color: "var(--ink-strong)" }}>{t.agentWorkspace.workspaceAbout}</h2></div><p className="mt-3 text-xs leading-6" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.privateWorkspaceDescription}</p><div className="mt-4 flex items-center gap-2 text-xs" style={{ color: "var(--ink-faint)" }}><LockKeyhole className="h-3.5 w-3.5" />{t.agentWorkspace.privateBadge}</div></PaperCard><PaperCard className="p-5"><div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" style={{ color: "var(--cinnabar)" }} /><h2 className="text-sm font-semibold" style={{ color: "var(--ink-strong)" }}>{t.agentWorkspace.securityTitle}</h2></div><p className="mt-3 text-xs leading-6" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.securityDescription}</p></PaperCard></aside>
    </div>}
  </PageContainer>;
}

function CreateRepositoryView({ name, description, t, pending, error, onName, onDescription, onSubmit, onCancel }: { name: string; description: string; t: any; pending: boolean; error: boolean; onName: (value: string) => void; onDescription: (value: string) => void; onSubmit: () => void; onCancel: () => void }) {
  return <div className="max-w-3xl">
    <button type="button" onClick={onCancel} className="inline-flex items-center gap-1.5 text-sm font-medium transition-opacity hover:opacity-70" style={{ color: "var(--ink-mid)" }}><ArrowLeft className="h-4 w-4" />{t.agentWorkspace.backToRepositories}</button>
    <div className="mt-6"><p className="text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--cinnabar)" }}>Koinote</p><h2 className="kn-heading-cn mt-1 text-2xl font-bold tracking-tight sm:text-3xl" style={{ color: "var(--ink-black)" }}>{t.agentWorkspace.createRepositoryTitle}</h2><p className="mt-2 max-w-2xl text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.createRepositoryDescription}</p></div>
    <form className="mt-7" onSubmit={(event) => { event.preventDefault(); if (!pending && name.trim()) onSubmit(); }}>
      <PaperCard className="overflow-hidden"><div className="border-b px-6 py-5" style={{ borderColor: "var(--ink-line)" }}><h3 className="text-base font-semibold" style={{ color: "var(--ink-strong)" }}>{t.agentWorkspace.repositoryName}</h3><p className="mt-1 text-xs" style={{ color: "var(--ink-faint)" }}>{t.agentWorkspace.createRepositoryNameHint}</p></div><div className="space-y-6 p-6 sm:p-7">
        <label className="block text-sm font-medium" style={{ color: "var(--ink-strong)" }}>{t.agentWorkspace.repositoryName}<span className="ml-1" style={{ color: "var(--cinnabar)" }}>*</span><input autoFocus value={name} onChange={(event) => onName(event.target.value)} placeholder={t.agentWorkspace.repositoryNamePlaceholder} maxLength={80} className="mt-2 w-full rounded-lg border bg-transparent px-3 py-2.5 text-sm outline-none transition-colors focus:border-[var(--ink-strong)]" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }} /></label>
        <label className="block text-sm font-medium" style={{ color: "var(--ink-strong)" }}>{t.agentWorkspace.repositoryDescription}<span className="ml-2 text-xs font-normal" style={{ color: "var(--ink-faint)" }}>({t.agentWorkspace.repositoryDescriptionPlaceholder})</span><textarea value={description} onChange={(event) => onDescription(event.target.value)} placeholder={t.agentWorkspace.repositoryDescriptionPlaceholder} maxLength={500} rows={3} className="mt-2 w-full resize-y rounded-lg border bg-transparent px-3 py-2.5 text-sm leading-6 outline-none transition-colors focus:border-[var(--ink-strong)]" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }} /></label>
        <div className="rounded-lg border px-3 py-3" style={{ borderColor: "var(--ink-line)", background: "transparent" }}><div className="flex items-start gap-2.5"><LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: "var(--ink-faint)" }} /><div><p className="text-xs font-medium" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.createRepositoryVisibility}</p><p className="mt-1 text-xs leading-5" style={{ color: "var(--ink-faint)" }}>{t.agentWorkspace.createRepositoryVisibilityDescription}</p></div></div></div>
        {error && <p className="text-sm" role="alert" style={{ color: "var(--cinnabar)" }}>{t.agentWorkspace.createFailed}</p>}
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1"><button type="button" onClick={onCancel} className="rounded-lg border px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--ink-wash)]" style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}>{t.llmChannels.cancel}</button><button type="submit" disabled={pending || !name.trim()} className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>{pending && <LoaderCircle className="h-4 w-4 animate-spin" />}{t.agentWorkspace.createRepository}</button></div>
      </div></PaperCard>
    </form>
  </div>;
}

function RepositoryItem({ workspace, locale, t, onEdit, onDelete, deletePending }: { workspace: AgentWorkspaceSummary; locale: string; t: any; onEdit: () => void; onDelete: () => void; deletePending: boolean }) {
  const description = normalizeRepositoryDescription(workspace.description);
  return <PaperCard className="overflow-hidden transition-shadow hover:shadow-[0_8px_24px_rgba(24,22,19,0.08)]"><div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between sm:p-6"><div className="flex min-w-0 gap-3"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ background: "var(--ink-wash)", color: "var(--ink-strong)" }}><FolderGit2 className="h-4 w-4" /></div><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Link to="/agent/workspaces/$workspaceId" search={{ from: "hub" }} params={{ workspaceId: String(workspace.workspaceId) }} className="truncate text-base font-semibold hover:underline" style={{ color: "var(--ink-strong)" }}>{workspace.name}</Link><span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]" style={{ borderColor: "var(--ink-line)", color: "var(--ink-faint)" }}><LockKeyhole className="h-2.5 w-2.5" />{t.agentWorkspace.privateBadge}</span></div>{description && <p className="mt-2 line-clamp-2 text-sm leading-5" style={{ color: "var(--ink-mid)" }}>{description}</p>}<div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" style={{ color: "var(--ink-faint)" }}><span>{workspace.fileCount} {t.agentWorkspace.filesTab.toLocaleLowerCase()}</span><span>r{workspace.revision}</span><span>{new Date(workspace.updatedAt).toLocaleDateString(locale)}</span></div></div></div><div className="flex shrink-0 items-center gap-1 sm:pt-0.5"><button type="button" onClick={onEdit} className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold transition-colors hover:bg-[var(--ink-wash)]" style={{ color: "var(--ink-mid)" }}><Edit3 className="h-3.5 w-3.5" />{t.agentWorkspace.editRepository}</button><button type="button" disabled={deletePending} onClick={onDelete} className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold transition-colors hover:bg-[var(--ink-wash)] disabled:opacity-50" style={{ color: "var(--cinnabar)" }}><Trash2 className="h-3.5 w-3.5" />{t.agentWorkspace.deleteRepository}</button><Link to="/agent/workspaces/$workspaceId" search={{ from: "hub" }} params={{ workspaceId: String(workspace.workspaceId) }} aria-label={workspace.name} className="ml-1 rounded-md p-1.5 transition-colors hover:bg-[var(--ink-wash)]" style={{ color: "var(--ink-faint)" }}><ArrowRight className="h-4 w-4" /></Link></div></div></PaperCard>;
}

function MetadataForm({ name, description, t, submitLabel, pending, onName, onDescription, onSubmit, onCancel }: { name: string; description: string; t: any; submitLabel: string; pending: boolean; onName: (value: string) => void; onDescription: (value: string) => void; onSubmit: () => void; onCancel: () => void }) {
  return <PaperCard className="mb-4 border-2 p-5"><div className="grid gap-3 sm:grid-cols-[1fr_1.4fr]"><label className="block text-xs" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.repositoryName}<input autoFocus value={name} onChange={(event: ChangeEvent<HTMLInputElement>) => onName(event.target.value)} placeholder={t.agentWorkspace.repositoryNamePlaceholder} maxLength={80} className="mt-1.5 w-full rounded-lg border bg-transparent px-3 py-2 text-sm" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }} /></label><label className="block text-xs" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.repositoryDescription}<input value={description} onChange={(event: ChangeEvent<HTMLInputElement>) => onDescription(event.target.value)} placeholder={t.agentWorkspace.repositoryDescriptionPlaceholder} maxLength={500} className="mt-1.5 w-full rounded-lg border bg-transparent px-3 py-2 text-sm" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }} /></label></div><div className="mt-4 flex gap-2"><button type="button" disabled={pending || !name.trim()} onClick={onSubmit} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-50" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>{pending && <Cloud className="h-3.5 w-3.5 animate-pulse" />}{submitLabel}</button><button type="button" onClick={onCancel} className="rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}>{t.llmChannels.cancel}</button></div></PaperCard>;
}

function EnablePanel() { const { t } = useI18n(); return <div className="mt-7 max-w-2xl"><PaperCard className="p-6 sm:p-8"><div className="flex h-11 w-11 items-center justify-center rounded-xl" style={{ background: "var(--ink-wash)", color: "var(--ink-strong)" }}><Cloud className="h-5 w-5" /></div><h2 className="mt-5 text-lg font-semibold" style={{ color: "var(--ink-strong)" }}>{t.agentWorkspace.enableStep}</h2><p className="mt-2 max-w-xl text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.description}</p><Link to="/agent/settings" className="mt-5 inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>{t.agentWorkspace.openSettings}<ArrowRight className="h-4 w-4" /></Link></PaperCard></div>; }
function LoadingList() { return <div className="space-y-3">{[1, 2].map((item) => <PaperCard key={item} className="h-32 animate-pulse bg-[var(--ink-wash)]">{null}</PaperCard>)}</div>; }
function normalizeRepositoryDescription(description: string) { return ["可选，用于区分不同配置", "Optional, to distinguish configurations", "Facultatif, pour distinguer les configurations", "任意。設定の区別に使います"].includes(description.trim()) ? "" : description.trim(); }
function PageLoading({ children }: { children: string }) { return <div className="flex flex-1 items-center justify-center py-24 text-sm" style={{ color: "var(--ink-faint)" }}>{children}</div>; }
function PageMessage({ children }: { children: ReactNode }) { return <div className="flex flex-1 flex-col items-center justify-center px-4 py-24 text-center text-sm" style={{ color: "var(--ink-mid)" }}>{children}</div>; }
