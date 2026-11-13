import type { RepositoryCategory, RepositoryFacet, RepositorySource } from "./agentRepositoryDirectory";
import { apiJson, type AgentWorkspace, type AgentWorkspaceFileContent, type AgentWorkspaceSummary } from "./api";
export { publicRepositoryClonePrompt } from "./agentRepositoryClonePrompt";
import type { AgentWorkspaceTransferSource } from "./agentWorkspaceTransfer";

export type AgentRepositoryEngagement = { starCount: number; starred: boolean; cloneCount: number };
export type PublicAgentRepository = AgentWorkspace & AgentRepositoryEngagement & { license: string; url: string; manifestUrl: string; publicationId: string; syncDisabledReason?: string };
export type AgentRepositorySource = { workspaceId: number | null; revision: number; name: string; license: string };
export const REPOSITORY_SHARING_QUERY_KEY = "agent-repository-sharing";
export const PUBLIC_REPOSITORIES_QUERY_KEY = "public-agent-repositories";
export const REPOSITORY_LICENSES = ["UNLICENSED", "MIT", "Apache-2.0", "ISC", "BSD-3-Clause", "GPL-3.0-only", "CC0-1.0", "CC-BY-4.0"] as const;
export function getAgentRepositorySharing(id: number, system = false) {
  return apiJson<{ publication: PublicAgentRepository | null; source: AgentRepositorySource | null; currentRevision: number }>(`${system ? "/api/admin/agent-repositories" : "/api/agent/workspaces"}/${id}/sharing`);
}
export function setAgentRepositorySharing(id: number, expectedRevision: number, license: string, revoke = false, system = false, category?: RepositoryCategory) {
  return apiJson<{ success: boolean }>(`${system ? "/api/admin/agent-repositories" : "/api/agent/workspaces"}/${id}/sharing`, { method: revoke ? "DELETE" : "PUT", body: JSON.stringify({ expectedRevision, license, category }) });
}
export type PublicRepositorySummary = AgentWorkspaceSummary & AgentRepositoryEngagement & { license: string; koiInstallable?: boolean };
export function listPublicAgentRepositories(query: string, cursor?: string, filters: { source?: RepositorySource; category?: RepositoryCategory | "" } = {}) {
  const params = new URLSearchParams({ q: query });
  if (cursor !== undefined) params.set("cursor", cursor);
  if (filters.source) params.set("source", filters.source);
  if (filters.category) params.set("category", filters.category);
  return apiJson<{ repositories: PublicRepositorySummary[]; nextCursor: string | null; total?: number; facets?: RepositoryFacet[] }>(`/api/agent/repositories?${params}`);
}
export function getPublicAgentRepository(id: number, revision?: number, signal?: AbortSignal, publicationId?: string) {
  const params = new URLSearchParams();
  if (revision !== undefined) params.set("revision", String(revision));
  if (publicationId) params.set("publication", publicationId);
  return apiJson<{ repository: PublicAgentRepository }>(`/api/agent/repositories/${id}${params.size ? `?${params}` : ""}`, { signal, headers: { "X-Koinote-Repository-Links": "1" } });
}
export function getPublicAgentRepositoryFile(repository: PublicAgentRepository, fileId: number, signal?: AbortSignal) {
  return apiJson<{ file: AgentWorkspaceFileContent }>(`/api/agent/repositories/${repository.workspaceId}/files/${fileId}?revision=${repository.revision}&publication=${encodeURIComponent(repository.publicationId)}`, { signal });
}
/** `code` explains a skip: a retired source, an edited personal copy, or a personal fork. */
export type PublicAgentRepositorySync = { status: "updated" | "unchanged" | "skipped"; code?: string; warningCode?: string };
/**
 * Ask the server to refresh this repository from its GitHub origin. Metadata-only
 * changes (including a new upstream mark) never republish or bump the revision.
 */
export function syncPublicAgentRepository(id: number, signal?: AbortSignal) {
  return apiJson<{ repository: PublicAgentRepository; sync: PublicAgentRepositorySync }>(`/api/agent/repositories/${id}/sync`, { method: "POST", signal, headers: { "X-Koinote-Repository-Links": "1" } });
}
/**
 * Prepare the current public snapshot using server-side eligibility and upstream
 * state. Cached client metadata must never decide whether GitHub is contacted.
 * Known retired sources keep their saved snapshot; only manual sync rechecks.
 */
export type PublicAgentRepositoryRefresh = { repository: PublicAgentRepository; sync: PublicAgentRepositorySync };
export async function refreshPublicAgentRepository(repository: PublicAgentRepository): Promise<PublicAgentRepositoryRefresh> {
  return apiJson<PublicAgentRepositoryRefresh>(`/api/agent/repositories/${repository.workspaceId}/sync?recheck=false`, { method: "POST", headers: { "X-Koinote-Repository-Links": "1" } });
}
/**
 * Fork the latest published snapshot. GitHub-origin repositories refresh first
 * unless the caller already prepared a snapshot (an uncertain retry must not be
 * retargeted by a newer upstream commit).
 */
export async function forkPublicAgentRepository(repository: PublicAgentRepository, requestId: string, refresh = true) {
  const latest = refresh ? (await refreshPublicAgentRepository(repository)).repository : repository;
  const result = await apiJson<{ workspace: AgentWorkspace }>(`/api/agent/repositories/${latest.workspaceId}/fork`, { method: "POST", body: JSON.stringify({ expectedRevision: latest.revision, expectedPublication: latest.publicationId, requestId, refresh: false }) });
  return { ...result, repository: latest };
}
export function publicAgentRepositoryTransferSource(repository: PublicAgentRepository): AgentWorkspaceTransferSource {
  return {
    readFile: (fileId, signal) => getPublicAgentRepositoryFile(repository, fileId, signal),
    readWorkspace: async (signal) => ({ workspace: (await getPublicAgentRepository(repository.workspaceId, repository.revision, signal, repository.publicationId)).repository }),
  };
}

export function updatePublicAgentRepositoryStar(id: number, starred: boolean) {
 return apiJson<AgentRepositoryEngagement>(`/api/agent/repositories/${id}/star`, { method: starred ? "PUT" : "DELETE" });
}
export function recordPublicAgentRepositoryClone(repository: PublicAgentRepository, requestId: string, method: "zip" | "home" | "agent", refresh = true) {
 return apiJson<AgentRepositoryEngagement>(`/api/agent/repositories/${repository.workspaceId}/clone`, { method: "POST", body: JSON.stringify({ expectedRevision: repository.revision, expectedPublication: repository.publicationId, requestId, method, refresh }) });
}

export const SYSTEM_REPOSITORIES_QUERY_KEY = "system-agent-repositories";
export type SystemAgentRepository = AgentWorkspaceSummary & { systemManaged: true; publishedRevision: number | null };
export function listSystemAgentRepositories() {
  return apiJson<{ repositories: SystemAgentRepository[] }>("/api/admin/agent-repositories");
}

export function collectSystemGitHubLink(repositoryUrl: string, requestId: string) {
  return apiJson<{ workspace: AgentWorkspace }>("/api/admin/agent-repositories/import/github", { method: "POST", body: JSON.stringify({ repositoryUrl, requestId, linkOnly: true }) });
}
