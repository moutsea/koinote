import type { PublicAgentRepositorySync } from "./agentRepositorySharing";
import { githubUpstreamNotice } from "./components/AgentGitHubAttribution";

export const AGENT_REPOSITORY_FORK_NOTICE_QUERY_KEY = "agent-repository-fork-notice";

export function publicRepositorySyncFeedback(result: PublicAgentRepositorySync, labels: Record<string, string>): string {
  const warning = result.warningCode === "github_credential_unavailable" ? labels.githubCredentialPublicFallback : "";
  return [syncStatusFeedback(result, labels), warning].filter(Boolean).join(" ");
}

function syncStatusFeedback(result: PublicAgentRepositorySync, labels: Record<string, string>): string {
  if (result.status === "updated") return labels.syncUpdated;
  if (result.status === "unchanged") return labels.syncUnchanged;
  const keys: Record<string, string> = {
    local_changes: "syncSkippedLocalChanges", personal_fork: "syncSkippedPersonalFork", no_github_source: "syncSkippedNoSource",
    agent_workspace_disabled: "syncSkippedDisabled", license_changed: "githubLicenseChanged",
    publication_license_mismatch: "githubPublicationLicenseMismatch", license_review_required: "githubLicenseReviewRequired",
    repository_identity_mismatch: "githubRepositoryIdentityMismatch", github_token_required: "githubTokenRequired",
  };
  if (result.code && keys[result.code]) return labels[keys[result.code]];
  if (result.code === "archived" || result.code === "disabled" || result.code === "unavailable" || result.code === "private") return githubUpstreamNotice({ upstreamStatus: result.code }, labels);
  return labels.syncSkipped;
}

export function publicRepositoryPreparationFeedback(result: PublicAgentRepositorySync, labels: Record<string, string>): string {
  const needsReview = result.code && ["license_changed", "license_review_required", "publication_license_mismatch", "repository_identity_mismatch"].includes(result.code);
  return result.warningCode === "github_credential_unavailable" || needsReview ? publicRepositorySyncFeedback(result, labels) : "";
}
