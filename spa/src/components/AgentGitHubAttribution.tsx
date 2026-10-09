import type { AgentGitHubSource } from "../api";
import { useI18n } from "../i18n";

export function AgentGitHubAttribution({ source, compact = false }: { source?: AgentGitHubSource; compact?: boolean }) {
  const { t } = useI18n();
  if (!source) return null;
  const labels = t.agentWorkspace;
  return <div className="space-y-1.5 break-words text-xs leading-5" style={{ color: "var(--ink-mid)" }}>
    <p>{labels.githubOriginalAuthor} <a href={source.authorUrl} target="_blank" rel="noreferrer" className="font-semibold underline">{source.author}</a></p>
    <p><a href={source.repositoryUrl} target="_blank" rel="noreferrer" className="break-all underline">{compact ? labels.githubOriginalLink : source.repositoryUrl}</a></p>
    {!compact && <>
      <p>{labels.githubImportedVersion} <a href={`${source.repositoryUrl}/tree/${source.commitSha}`} target="_blank" rel="noreferrer" className="underline">{source.ref} · {source.commitSha.slice(0, 12)}</a></p>
      <p>{labels.githubOriginalLicense} {source.license}</p>
      <p>{labels.githubImportedCopy}</p>
      {source.private && <p style={{ color: "var(--cinnabar)" }}>{labels.githubSourcePrivate}</p>}
    </>}
  </div>;
}
