import type { AgentGitHubSource } from "../api";
import { useI18n } from "../i18n";

const UPSTREAM_LABELS: Record<NonNullable<AgentGitHubSource["upstreamStatus"]>, string> = {
  archived: "githubUpstreamArchived",
  disabled: "githubUpstreamDisabled",
  unavailable: "githubUpstreamUnavailable",
  private: "githubUpstreamPrivate",
};

/** Terminal upstream state; the saved snapshot remains usable. */
export function githubUpstreamLabel(source: AgentGitHubSource | undefined, labels: Record<string, string>): string | undefined {
  return source?.upstreamStatus ? labels[UPSTREAM_LABELS[source.upstreamStatus]] : undefined;
}

export function githubUpstreamNotice(source: Pick<AgentGitHubSource, "upstreamStatus"> | undefined, labels: Record<string, string>): string {
  const key = source?.upstreamStatus ? UPSTREAM_LABELS[source.upstreamStatus] : undefined;
  return key ? labels[`${key}Notice`] : labels.githubUpstreamNotice;
}

export function AgentGitHubUpstreamMark({ source, notice = false }: { source?: AgentGitHubSource; notice?: boolean }) {
  const { t } = useI18n();
  const labels = t.agentWorkspace;
  const label = githubUpstreamLabel(source, labels);
  if (!source?.upstreamStatus || !label) return null;
  return <div className="space-y-1.5 break-words text-xs leading-5">
    <span className="inline-block rounded-full border px-2 py-0.5" style={{ borderColor: "var(--cinnabar)", color: "var(--cinnabar)" }}>{label}</span>
    {notice && <p style={{ color: "var(--ink-mid)" }}>{githubUpstreamNotice(source, labels)}</p>}
  </div>;
}

export function AgentGitHubAttribution({ source, compact = false }: { source?: AgentGitHubSource; compact?: boolean }) {
  const { t } = useI18n();
  if (!source) return null;
  const labels = t.agentWorkspace;
  return <div className="space-y-1.5 break-words text-xs leading-5" style={{ color: "var(--ink-mid)" }}>
    <p>{labels.githubOriginalAuthor} <a href={source.authorUrl} target="_blank" rel="noreferrer" className="font-semibold underline">{source.author}</a></p>
    <p><a href={source.repositoryUrl} target="_blank" rel="noreferrer" className="break-all underline">{compact ? labels.githubOriginalLink : source.repositoryUrl}</a></p>
    <AgentGitHubUpstreamMark source={source} notice={!compact} />
    {!compact && <>
      <p>{source.linkOnly ? labels.githubListedVersion : labels.githubImportedVersion} <a href={`${source.repositoryUrl}/tree/${source.commitSha}`} target="_blank" rel="noreferrer" className="underline">{source.ref !== source.commitSha && <>{source.ref} · </>}{source.commitSha.slice(0, 12)}</a></p>
      <p>{labels.githubOriginalLicense} {source.linkOnly && source.license === "UNLICENSED" ? labels.githubLicenseAtSource : source.license}</p>
      {!source.linkOnly && <p>{labels.githubImportedCopy}</p>}
      {source.private && <p style={{ color: "var(--cinnabar)" }}>{labels.githubSourcePrivate}</p>}
    </>}
  </div>;
}
