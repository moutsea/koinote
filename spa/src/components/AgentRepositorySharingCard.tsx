import { AgentGitHubAttribution } from "./AgentGitHubAttribution";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiError, type AgentWorkspace } from "../api";
import { getAgentRepositorySharing, PUBLIC_REPOSITORIES_QUERY_KEY, REPOSITORY_LICENSES, REPOSITORY_SHARING_QUERY_KEY, setAgentRepositorySharing } from "../agentRepositorySharing";
import { confirmAction } from "../confirmAction";
import { useI18n } from "../i18n";
import { useAgentSyncCopy } from "./AgentSyncCopyDialog";
import { PaperCard } from "./Ink";

type SharingChange = { workspaceId: number; revision: number; license: string; revoke: boolean };

export function AgentRepositorySharingCard({ workspace }: { workspace: AgentWorkspace }) {
  const { t } = useI18n();
  const labels = t.agentWorkspace;
  const client = useQueryClient();
  const queryKey = [REPOSITORY_SHARING_QUERY_KEY, workspace.workspaceId];
  const sharing = useQuery({ queryKey, queryFn: () => getAgentRepositorySharing(workspace.workspaceId), retry: false });
  const publication = sharing.data?.publication;
  const source = sharing.data?.source;
  const githubSource = workspace.githubSource;
  const licenses = [...new Set<string>([...REPOSITORY_LICENSES, ...(githubSource ? [githubSource.license] : [])])];
  const [license, setLicense] = useState("UNLICENSED");
  const [consent, setConsent] = useState(false);
  const [message, setMessage] = useState("");
  const [confirming, setConfirming] = useState(false);
  const confirmation = useRef(0);
  useEffect(() => () => { confirmation.current++; }, [workspace.workspaceId]);
  const copy = useAgentSyncCopy(() => setMessage(labels.copied));
  useEffect(() => { setLicense(publication?.license ?? source?.license ?? githubSource?.license ?? "UNLICENSED"); setConsent(false); }, [publication?.license, source?.license, githubSource?.license, workspace.workspaceId]);
  useEffect(() => { setConsent(false); setMessage(""); }, [workspace.workspaceId, workspace.revision]);
  const update = useMutation({
    mutationFn: (change: SharingChange) => setAgentRepositorySharing(change.workspaceId, change.revision, change.license, change.revoke),
    onSuccess: async (_, change) => {
      setConsent(false);
      setMessage(change.revoke ? labels.sharingRevoked : labels.sharingSaved);
      await Promise.all([
        client.invalidateQueries({ queryKey: [REPOSITORY_SHARING_QUERY_KEY, change.workspaceId] }),
        client.invalidateQueries({ queryKey: [PUBLIC_REPOSITORIES_QUERY_KEY] }),
        client.invalidateQueries({ queryKey: ["public-agent-repository", change.workspaceId] }),
        client.invalidateQueries({ queryKey: ["agent-workspace-storage"] }),
      ]);
    },
  });
  const pending = update.isPending || confirming;
  async function confirmChange(revoke: boolean) {
    if (pending || (!revoke && !consent)) return;
    // Capture exactly what the human is about to approve. A background refresh
    // during the native dialog must conflict, never publish the newer revision.
    const change = { workspaceId: workspace.workspaceId, revision: workspace.revision, license, revoke };
    const sequence = ++confirmation.current;
    setConfirming(true);
    try {
      const accepted = await confirmAction(revoke ? labels.revokeConfirm : labels.publishConfirm.replace("{revision}", String(change.revision)).replace("{count}", String(workspace.files.length)));
      if (accepted && sequence === confirmation.current) update.mutate(change);
    } finally {
      if (sequence === confirmation.current) setConfirming(false);
    }
  }
  const error = update.error instanceof ApiError
    ? update.error.code === "sensitive_data_detected" ? labels.sharingSensitive : update.error.code === "revision_conflict" ? labels.sharingConflict : labels.sharingFailed
    : update.isError ? labels.sharingFailed : "";
  const buttonClass = "rounded-lg border px-3 py-2 text-xs font-medium disabled:opacity-50 hover:bg-[var(--ink-wash)]";
  return <PaperCard className="space-y-3 break-words p-5">
    <h2 className="text-sm font-semibold">{labels.sharingTitle}</h2>
    <AgentGitHubAttribution source={githubSource} />
    {source && <p className="text-xs leading-5" style={{ color: "var(--ink-mid)" }}>
      {source.workspaceId ? <Link to="/repositories/$repositoryId" params={{ repositoryId: String(source.workspaceId) }} className="underline">{labels.sourceRepository.replace("{name}", source.name).replace("{revision}", String(source.revision)).replace("{license}", source.license)}</Link> : <>{labels.sourceRepository.replace("{name}", source.name).replace("{revision}", String(source.revision)).replace("{license}", source.license)} · {labels.sourceDeleted}</>}
    </p>}
    <p className="text-xs leading-6" style={{ color: "var(--ink-mid)" }}>{labels.sharingDescription}</p>
    {sharing.isPending ? <p className="text-xs">{labels.loading}</p> : sharing.isError ? <div role="alert" className="text-xs"><p>{labels.sharingFailed}</p><button type="button" onClick={() => void sharing.refetch()} className="mt-2 underline">{labels.refresh}</button></div> : <>
      <p className="text-xs font-medium">{publication ? labels.publishedRevision.replace("{revision}", String(publication.revision)) : labels.notPublished}</p>
      {publication && publication.revision !== workspace.revision && <p className="text-xs" style={{ color: "var(--cinnabar)" }}>{labels.unpublishedChanges}</p>}
      {publication && <div className="flex flex-wrap gap-2">
        <Link className={buttonClass} to="/repositories/$repositoryId" params={{ repositoryId: String(workspace.workspaceId) }}>{labels.viewPublic}</Link>
        <button type="button" className={buttonClass} onClick={() => void copy.copy(async () => publication.url).catch(() => setMessage(labels.sharingFailed))}>{labels.copyShareLink}</button>
      </div>}
      <label className="block text-xs">{labels.licenseLabel}<select className="mt-2 w-full rounded-lg border bg-[var(--background)] p-2" value={license} disabled={pending} onChange={(event) => { setLicense(event.target.value); setConsent(false); }}>{licenses.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" checked={consent} disabled={pending} onChange={(event) => setConsent(event.target.checked)} className="mt-1 shrink-0" />{labels.publishConsent}</label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={pending || !consent} onClick={() => void confirmChange(false)}>{publication ? labels.republishSnapshot : labels.publishSnapshot}</button>
        {publication && <button type="button" className={buttonClass} disabled={pending} onClick={() => void confirmChange(true)}>{labels.revokeSharing}</button>}
      </div>
    </>}
    {error && <p role="alert" className="text-xs leading-5" style={{ color: "var(--cinnabar)" }}>{error}</p>}
    {message && <p role="status" className="text-xs">{message}</p>}
    {copy.dialog}
    <Link to="/repositories" className="inline-block text-xs underline">{labels.publicRepositories}</Link>
  </PaperCard>;
}
