import { apiJson, type AgentWorkspace, type AgentWorkspaceFileContent, type AgentWorkspaceSummary } from "./api";
export { publicRepositoryClonePrompt } from "./agentRepositoryClonePrompt";
import type { AgentWorkspaceTransferSource } from "./agentWorkspaceTransfer";

export type AgentRepositoryEngagement = { starCount: number; starred: boolean; cloneCount: number };
export type PublicAgentRepository = AgentWorkspace & AgentRepositoryEngagement & { license: string; url: string; manifestUrl: string };
export type AgentRepositorySource = { workspaceId: number | null; revision: number; name: string; license: string };
export const REPOSITORY_SHARING_QUERY_KEY = "agent-repository-sharing";
export const PUBLIC_REPOSITORIES_QUERY_KEY = "public-agent-repositories";
export const REPOSITORY_LICENSES = ["UNLICENSED", "MIT", "Apache-2.0", "BSD-3-Clause", "GPL-3.0-only", "CC0-1.0", "CC-BY-4.0"] as const;
export function getAgentRepositorySharing(id: number) {
  return apiJson<{ publication: PublicAgentRepository | null; source: AgentRepositorySource | null; currentRevision: number }>(`/api/agent/workspaces/${id}/sharing`);
}
export function setAgentRepositorySharing(id: number, expectedRevision: number, license: string, revoke = false) {
  return apiJson<{ success: boolean }>(`/api/agent/workspaces/${id}/sharing`, { method: revoke ? "DELETE" : "PUT", body: JSON.stringify({ expectedRevision, license }) });
}
export function listPublicAgentRepositories(query: string, cursor?: string) {
  const params = new URLSearchParams({ q: query });
  if (cursor !== undefined) params.set("cursor", cursor);
  return apiJson<{ repositories: (AgentWorkspaceSummary & AgentRepositoryEngagement & { license: string })[]; nextCursor: string | null }>(`/api/agent/repositories?${params}`);
}
export function getPublicAgentRepository(id: number, revision?: number, signal?: AbortSignal) {
  return apiJson<{ repository: PublicAgentRepository }>(`/api/agent/repositories/${id}${revision === undefined ? "" : `?revision=${revision}`}`, { signal });
}
export function getPublicAgentRepositoryFile(repository: AgentWorkspace, fileId: number, signal?: AbortSignal) {
  return apiJson<{ file: AgentWorkspaceFileContent }>(`/api/agent/repositories/${repository.workspaceId}/files/${fileId}?revision=${repository.revision}`, { signal });
}
export function forkPublicAgentRepository(repository: AgentWorkspace, requestId: string) {
  return apiJson<{ workspace: AgentWorkspace }>(`/api/agent/repositories/${repository.workspaceId}/fork`, { method: "POST", body: JSON.stringify({ expectedRevision: repository.revision, requestId }) });
}
export function publicAgentRepositoryTransferSource(repository: PublicAgentRepository): AgentWorkspaceTransferSource {
  return {
    readFile: (fileId, signal) => getPublicAgentRepositoryFile(repository, fileId, signal),
    readWorkspace: async (signal) => ({ workspace: (await getPublicAgentRepository(repository.workspaceId, repository.revision, signal)).repository }),
  };
}

export function updatePublicAgentRepositoryStar(id: number, starred: boolean) {
 return apiJson<AgentRepositoryEngagement>(`/api/agent/repositories/${id}/star`, { method: starred ? "PUT" : "DELETE" });
}
export function recordPublicAgentRepositoryClone(repository: AgentWorkspace, requestId: string, method: "zip" | "home" | "agent") {
 return apiJson<AgentRepositoryEngagement>(`/api/agent/repositories/${repository.workspaceId}/clone`, { method: "POST", body: JSON.stringify({ expectedRevision: repository.revision, requestId, method }) });
}
