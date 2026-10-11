import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { listSystemAgentRepositories, setAgentRepositorySharing, SYSTEM_REPOSITORIES_QUERY_KEY, PUBLIC_REPOSITORIES_QUERY_KEY, REPOSITORY_SHARING_QUERY_KEY, type SystemAgentRepository } from "../agentRepositorySharing";
import { confirmAction } from "../confirmAction";
import { useI18n } from "../i18n";
import { formatBytes } from "../storage";
import { AgentGitHubCredentialCard } from "./AgentGitHubCredentialCard";
import { PaperCard } from "./Ink";

type Change = { id: number; revision: number; license: string; revoke: boolean };

export function SystemRepositoriesAdminPanel() {
  const { t } = useI18n();
  const labels = t.agentWorkspace;
  const client = useQueryClient();
  const repositories = useQuery({ queryKey: [SYSTEM_REPOSITORIES_QUERY_KEY], queryFn: listSystemAgentRepositories, retry: false });
  const [confirming, setConfirming] = useState(false);
  const confirmation = useRef(0);
  useEffect(() => () => { confirmation.current++; }, []);
  const update = useMutation({
    mutationFn: (change: Change) => setAgentRepositorySharing(change.id, change.revision, change.license, change.revoke, true),
    onSuccess: async (_, change) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: [SYSTEM_REPOSITORIES_QUERY_KEY] }),
        client.invalidateQueries({ queryKey: [PUBLIC_REPOSITORIES_QUERY_KEY] }),
        client.invalidateQueries({ queryKey: ["public-agent-repository", change.id] }),
        client.invalidateQueries({ queryKey: [REPOSITORY_SHARING_QUERY_KEY, change.id] }),
      ]);
    },
  });
  async function changePublication(repository: SystemAgentRepository) {
    if (confirming || update.isPending) return;
    const change: Change = { id: repository.workspaceId, revision: repository.revision, license: repository.githubSource?.license ?? "UNLICENSED", revoke: repository.publishedRevision !== null };
    const sequence = ++confirmation.current;
    setConfirming(true);
    try {
      const message = change.revoke ? labels.revokeConfirm : labels.publishConfirm.replace("{revision}", String(change.revision)).replace("{count}", String(repository.fileCount));
      if (await confirmAction(message) && sequence === confirmation.current) update.mutate(change);
    } finally {
      if (sequence === confirmation.current) setConfirming(false);
    }
  }
  const error = update.error instanceof ApiError && update.error.code === "sensitive_data_detected" ? labels.sharingSensitive
    : update.error instanceof ApiError && update.error.code === "revision_conflict" ? labels.sharingConflict
    : update.isError ? labels.sharingFailed : "";
  const buttonClass = "rounded-lg border px-3 py-2 text-xs hover:bg-[var(--ink-wash)] disabled:opacity-50";
  return <section className="space-y-4">
    <div className="flex items-start justify-between gap-4">
      <div><h2 className="font-semibold">{labels.systemRepositories}</h2><p className="mt-2 text-sm leading-6 text-[var(--ink-mid)]">{labels.systemRepositoriesDescription}</p></div>
      <button type="button" className={`${buttonClass} shrink-0`} disabled={repositories.isFetching} onClick={() => void repositories.refetch()}>{labels.refresh}</button>
    </div>
    <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm">{labels.githubTokenTitle}</summary><div className="mt-3"><AgentGitHubCredentialCard /></div></details>
    {error && <p role="alert" className="text-sm text-[var(--cinnabar)]">{error}</p>}
    {repositories.isPending ? <p>{labels.loading}</p> : repositories.isError ? <p role="alert">{labels.repositoryLoadFailed}</p> : <>
      {repositories.data.repositories.length === 0 && <p>{labels.systemRepositoriesEmpty}</p>}
      {repositories.data.repositories.map((repository) => <PaperCard key={repository.workspaceId} className="flex flex-wrap items-center justify-between gap-4 p-4">
        <div className="min-w-0 flex-1 basis-64">
          <h3 className="break-words text-sm font-semibold">{repository.name}</h3>
          <p className="mt-1 text-xs text-[var(--ink-mid)]">{repository.publishedRevision === null ? labels.systemUnpublished : labels.publishedRevision.replace("{revision}", String(repository.publishedRevision))} · {formatBytes(repository.sizeBytes)} · {repository.githubSource?.license}</p>
          {repository.githubSource && <a className="mt-2 inline-block break-all text-xs underline" href={repository.githubSource.repositoryUrl} target="_blank" rel="noreferrer">{repository.githubSource.repositoryUrl}</a>}
        </div>
        <div className="flex flex-wrap gap-2">
          {repository.publishedRevision !== null && <Link className={buttonClass} to="/repositories/$repositoryId" params={{ repositoryId: String(repository.workspaceId) }}>{labels.viewPublic}</Link>}
          <button type="button" className={buttonClass} disabled={confirming || update.isPending} onClick={() => void changePublication(repository)}>{repository.publishedRevision === null ? labels.publishSnapshot : labels.revokeSharing}</button>
        </div>
      </PaperCard>)}
    </>}
  </section>;
}
