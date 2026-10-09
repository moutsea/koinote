import { apiJson, ApiError, type AgentWorkspace } from "./api";

export type AgentGitHubCredential = { configured: boolean; tokenHint?: string; updatedAt?: string };
export const GITHUB_CREDENTIAL_QUERY_KEY = "agent-github-credential";
export function getAgentGitHubCredential() {
  return apiJson<{ credential: AgentGitHubCredential }>("/api/agent/github-credential");
}
export function saveAgentGitHubCredential(token: string) {
  return apiJson<{ credential: AgentGitHubCredential }>("/api/agent/github-credential", { method: "PUT", body: JSON.stringify({ token }) });
}
export function deleteAgentGitHubCredential() {
  return apiJson<{ success: boolean }>("/api/agent/github-credential", { method: "DELETE" });
}
export function importGitHubAgentRepository(input: { repositoryUrl: string; ref?: string; requestId: string }) {
  return apiJson<{ workspace: AgentWorkspace }>("/api/agent/workspaces/import/github", { method: "POST", body: JSON.stringify(input) });
}
export function githubImportErrorMessage(error: unknown, labels: Record<string, string>): string {
  const keys: Record<string, string> = {
    github_token_required: "githubTokenRequired", github_token_invalid: "githubTokenInvalid",
    github_credential_unavailable: "githubCredentialUnavailable", github_repository_invalid: "githubRepositoryInvalid",
    github_repository_unavailable: "githubRepositoryUnavailable", github_archive_invalid: "githubArchiveInvalid",
    github_rate_limited: "githubRateLimited", rate_limited: "githubRateLimited", sensitive_data_detected: "githubSensitive",
    agent_workspace_quota_exceeded: "githubQuota", revision_conflict: "sharingConflict",
  };
  return error instanceof ApiError && error.code && keys[error.code] ? labels[keys[error.code]] : labels.githubImportFailed;
}
