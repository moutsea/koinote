import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, Edit3, LoaderCircle, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState, type ChangeEvent, type ReactNode } from "react";
import {
  createAgentWorkspace, deleteAgentWorkspace, getAgentWorkspaceSettings,
  listAgentWorkspaces, listMCPTokens,
  updateAgentWorkspaceMetadata, updateAgentWorkspaceSettings, type AgentWorkspaceSummary, type User,
} from "../api";
import { useI18n } from "../i18n";
import { confirmAction } from "../confirmAction";
import { MCPAccessCard } from "./MCPAccessCard";
import { PaperCard } from "./Ink";

export function AgentWorkspaceCard({ user, repositoryLinkSource = "settings" }: { user: User; repositoryLinkSource?: "settings" | "hub" }) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const member = user.membershipTier === "lifetime";
  const localMode = Boolean(user.isLocalMode);
  const settings = useQuery({ queryKey: ["agent-workspace-settings"], queryFn: getAgentWorkspaceSettings, enabled: !localMode, retry: false });
  const enabled = member && settings.data?.enabled === true;
  const tokens = useQuery({ queryKey: ["mcp-tokens"], queryFn: listMCPTokens, enabled, retry: false });
  const repositories = useQuery({ queryKey: ["agent-workspaces"], queryFn: listAgentWorkspaces, enabled, retry: false });
  const workspaces = repositories.data?.workspaces;
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [editingID, setEditingID] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");

  useEffect(() => {
    const items = workspaces ?? [];
    if (editingID === null || items.some((item) => item.workspaceId === editingID)) return;
    setEditingID(null);
  }, [workspaces, editingID]);

  const enable = useMutation({ mutationFn: () => updateAgentWorkspaceSettings(true), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agent-workspace-settings"] }) });
  const create = useMutation({
    mutationFn: () => createAgentWorkspace({ name: newName.trim(), description: newDescription.trim(), locale }),
    onSuccess() { setNewName(""); setNewDescription(""); void queryClient.invalidateQueries({ queryKey: ["agent-workspaces"] }); },
  });
  const editingWorkspace = workspaces?.find((workspace) => workspace.workspaceId === editingID);
  const saveMetadata = useMutation({
    mutationFn: () => editingWorkspace ? updateAgentWorkspaceMetadata(editingWorkspace.workspaceId, { expectedRevision: editingWorkspace.revision, name: editName.trim(), description: editDescription.trim() }) : Promise.reject(new Error("no repository")),
    onSuccess() { setEditingID(null); void queryClient.invalidateQueries({ queryKey: ["agent-workspaces"] }); },
  });
  const remove = useMutation({
    mutationFn: (workspace: AgentWorkspaceSummary) => deleteAgentWorkspace(workspace.workspaceId, workspace.revision),
    onSuccess() { void queryClient.invalidateQueries({ queryKey: ["agent-workspaces"] }); },
  });

  if (localMode) return <WorkspaceShell user={user} title={t.agentWorkspace.title} description={t.agentWorkspace.description}><p className="mt-4 text-sm" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.localMode}</p></WorkspaceShell>;
  if (!member) return <WorkspaceShell user={user} title={t.agentWorkspace.title} description={t.agentWorkspace.membersOnly}><Link to="/pricing" className="mt-5 inline-flex rounded-full px-5 py-2.5 text-sm font-semibold" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>{t.mcp.upgrade}</Link></WorkspaceShell>;
  if (!enabled) return <WorkspaceShell user={user} title={t.agentWorkspace.title} description={t.agentWorkspace.description}><section className="mt-5 rounded-xl border p-4" style={{ borderColor: "var(--ink-line)" }}><p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--ink-faint)" }}>{t.agentWorkspace.enableStep}</p><p className="mt-2 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.description}</p><button type="button" disabled={enable.isPending} onClick={() => enable.mutate()} className="mt-4 inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold disabled:opacity-50" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>{enable.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{t.agentWorkspace.enable}</button>{enable.isError && <p className="mt-2 text-sm" style={{ color: "var(--cinnabar)" }}>{t.agentWorkspace.enableFailed}</p>}</section></WorkspaceShell>;

  const hasToken = tokens.data?.tokens.some((token) => token.scope === "agent_read" || token.scope === "agent_write") === true;
  const onboarding = !hasToken || workspaces?.length === 0;
  return <WorkspaceShell user={user} title={t.agentWorkspace.title} description={t.agentWorkspace.description}>
    {onboarding && <StepLabel>{t.agentWorkspace.enabled}</StepLabel>}
    {onboarding && <MCPAccessCard user={user} agentOnly workspaceEnabled />}
    {hasToken && <section className="mt-5 border-t pt-5" style={{ borderColor: "var(--ink-line)" }}>
      {onboarding && <><p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--ink-faint)" }}>{t.agentWorkspace.repositoriesTitle}</p>
      <p className="mt-2 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.repositoriesDescription}</p></>}
      {repositories.isError ? <p className="mt-4 text-sm" style={{ color: "var(--cinnabar)" }}>{t.agentWorkspace.repositoryLoadFailed}</p> : <>
        <div className="mt-4 space-y-2">{(workspaces ?? []).map((workspace) => <RepositoryRow key={workspace.workspaceId} workspace={workspace} linkSource={repositoryLinkSource} onEdit={() => { setEditName(workspace.name); setEditDescription(workspace.description); setEditingID(workspace.workspaceId); }} onDelete={async () => { if (await confirmAction(t.agentWorkspace.deleteRepositoryConfirm)) remove.mutate(workspace); }} deletePending={remove.isPending} t={t} />)}</div>
        {editingWorkspace ? <MetadataForm name={editName} description={editDescription} t={t} submitLabel={t.agentWorkspace.saveRepository} pending={saveMetadata.isPending} onName={setEditName} onDescription={setEditDescription} onSubmit={() => saveMetadata.mutate()} onCancel={() => setEditingID(null)} /> : workspaces?.length === 0 ? <div className="mt-4 rounded-xl border p-4" style={{ borderColor: "var(--ink-line)" }}>
          <p className="text-sm font-semibold" style={{ color: "var(--ink-strong)" }}>{t.agentWorkspace.noRepositories}</p>
          <MetadataForm name={newName} description={newDescription} t={t} submitLabel={t.agentWorkspace.createFirst} pending={create.isPending} onName={setNewName} onDescription={setNewDescription} onSubmit={() => create.mutate()} />
          {create.isError && <p className="mt-2 text-sm" style={{ color: "var(--cinnabar)" }}>{t.agentWorkspace.createFailed}</p>}
        </div> : null}
      </>}
    </section>}
  </WorkspaceShell>;
}

function WorkspaceShell({ user: _user, title, description, children }: { user: User; title: string; description: string; children: ReactNode }) { return <PaperCard className="p-5 sm:p-6"><div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" style={{ color: "var(--ink-faint)" }} /><div><h2 className="font-semibold" style={{ color: "var(--ink-black)" }}>{title}</h2><p className="mt-1 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{description}</p></div></div>{children}</PaperCard>; }
function StepLabel({ children }: { children: string }) { return <p className="mt-5 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--ink-faint)" }}>{children}</p>; }
function RepositoryRow({ workspace, linkSource, onEdit, onDelete, deletePending, t }: { workspace: AgentWorkspaceSummary; linkSource: "settings" | "hub"; onEdit: () => void; onDelete: () => void; deletePending: boolean; t: any }) { return <div className="flex w-full flex-wrap items-center gap-2 rounded-xl border p-3" style={{ borderColor: "var(--ink-line)" }}><Link to="/agent/workspaces/$workspaceId" search={linkSource === "hub" ? { from: "hub" } : { from: "settings" }} params={{ workspaceId: String(workspace.workspaceId) }} className="flex min-w-0 flex-1 items-center gap-2 text-left"><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold" style={{ color: "var(--ink-strong)" }}>{workspace.name}</span><span className="mt-1 block truncate text-xs" style={{ color: "var(--ink-faint)" }}>{workspace.description || `${workspace.fileCount} files`}</span></span><span className="shrink-0 text-xs" style={{ color: "var(--ink-faint)" }}>{workspace.fileCount} files · revision {workspace.revision}</span></Link><div className="flex shrink-0 gap-2"><button type="button" onClick={onEdit} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold" style={{ color: "var(--ink-strong)" }}><Edit3 className="h-3.5 w-3.5" />{t.agentWorkspace.editRepository}</button><button type="button" disabled={deletePending} onClick={onDelete} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold disabled:opacity-50" style={{ color: "var(--cinnabar)" }}><Trash2 className="h-3.5 w-3.5" />{t.agentWorkspace.deleteRepository}</button></div></div>; }
function MetadataForm({ name, description, t, submitLabel, pending, onName, onDescription, onSubmit, onCancel }: { name: string; description: string; t: any; submitLabel: string; pending: boolean; onName: (value: string) => void; onDescription: (value: string) => void; onSubmit: () => void; onCancel?: () => void }) { return <div className="mt-4 space-y-3"><label className="block text-xs" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.repositoryName}<input value={name} onChange={(event: ChangeEvent<HTMLInputElement>) => onName(event.target.value)} placeholder={t.agentWorkspace.repositoryNamePlaceholder} maxLength={80} className="mt-1.5 w-full rounded-lg border bg-transparent px-3 py-2 text-sm" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }} /></label><label className="block text-xs" style={{ color: "var(--ink-mid)" }}>{t.agentWorkspace.repositoryDescription}<input value={description} onChange={(event: ChangeEvent<HTMLInputElement>) => onDescription(event.target.value)} placeholder={t.agentWorkspace.repositoryDescriptionPlaceholder} maxLength={500} className="mt-1.5 w-full rounded-lg border bg-transparent px-3 py-2 text-sm" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }} /></label><div className="flex gap-2"><button type="button" disabled={pending || !name.trim()} onClick={onSubmit} className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-semibold disabled:opacity-50" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>{pending && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}{submitLabel}</button>{onCancel && <button type="button" onClick={onCancel} className="rounded-full border px-3 py-2 text-xs" style={{ borderColor: "var(--ink-line)" }}>Cancel</button>}</div></div>; }
