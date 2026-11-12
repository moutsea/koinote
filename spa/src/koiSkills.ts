import { apiJson, ApiError } from "./api";
import { githubImportErrorMessage } from "./agentGitHubImport";

export type KoiCompatibility = {
  conversation: boolean;
  article: boolean;
  reasons: string[];
  warnings?: string[];
  requiredTools?: string[];
};

export type KoiSkill = {
  id: string;
  name: string;
  description: string;
  sourceKind: "github" | "folder" | "hub" | "migration";
  source: Record<string, unknown>;
  versionId: string;
  version: string;
  contentSha256: string;
  enabled: boolean;
  revision: number;
  installedAt: string;
  updatedAt: string;
  fileCount: number;
  sizeBytes: number;
  compatibility: KoiCompatibility;
  metadataFormat: "agent-skills" | "plain-markdown";
  license: string;
  entryPath: string;
};

export type KoiSkillFile = {
  position: number;
  path: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
};

export type KoiImportCandidate = {
  id: string;
  name: string;
  description: string;
  entryPath: string;
  directory: string;
  metadataFormat: "agent-skills" | "plain-markdown";
  fileCount: number;
  sizeBytes: number;
  contentSha256: string;
  license: string;
  instructions: string;
  compatibility: KoiCompatibility;
  installedStatus?: "installed" | "update";
  installedRevision?: number;
  previousVersion?: string;
  previousSizeBytes?: number;
  installedId?: string;
};

export type KoiImportRejection = { directory: string; entryPath: string; name?: string; reason: string; details?: string[] };

export type KoiPreview = {
  id: string;
  status: "pending" | "analyzing" | "ready" | "committed" | "failed" | "cancelled" | "expired";
  revision: number;
  sourceKind: "github" | "folder" | "hub" | "migration";
  source: Record<string, unknown>;
  candidates: KoiImportCandidate[];
  rejected: KoiImportRejection[];
  errorCode?: string;
  expiresAt: string;
  uploadedFiles: number;
  declaredFiles: number;
  rejectedFiles: number;
  installed?: KoiSkill[];
};

export type KoiSettings = { autoSkills: boolean; revision: number; libraryMode: "legacy" | "installed" };
export type KoiOverview = { managementAvailable: boolean; canInstall: boolean; settings: KoiSettings; legacySkillCount: number };
export type KoiSkillPage = { skills: KoiSkill[]; nextCursor: string; storage: { usedBytes: number } };
export const KOI_SKILLS_QUERY_KEY = "koi-skills";
export const KOI_SETTINGS_QUERY_KEY = "koi-settings";
export const getKoiOverview = () => apiJson<KoiOverview>("/api/koi/settings");
export const updateKoiSettings = (input: { expectedRevision: number; autoSkills: boolean }) =>
 apiJson<{ settings: KoiSettings }>("/api/koi/settings", { method: "PUT", body: JSON.stringify(input) });
export const listKoiSkills = (params: { q?: string; source?: KoiSkill["sourceKind"] | ""; state?: string; cursor?: string }) =>
 apiJson<KoiSkillPage>(`/api/koi/skills?${new URLSearchParams({ q: params.q ?? "", source: params.source ?? "", state: params.state ?? "", cursor: params.cursor ?? "" })}`);
export const getKoiSkill = (id: string) =>
 apiJson<{ skill: KoiSkill; files: KoiSkillFile[]; instructions: string }>(`/api/koi/skills/${encodeURIComponent(id)}`);
export const getKoiSkillFile = (id: string, position: number, version: string) =>
 apiJson<{ file: KoiSkillFile; contentBase64: string }>(`/api/koi/skills/${encodeURIComponent(id)}/files/${position}?version=${encodeURIComponent(version)}`);
export const setKoiSkillEnabled = (id: string, input: { expectedRevision: number; enabled: boolean }) =>
 apiJson<{ skill: KoiSkill }>(`/api/koi/skills/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) });
export const deleteKoiSkill = (id: string, expectedRevision: number) =>
 apiJson<{ deleted: boolean; retainedBytes: number }>(`/api/koi/skills/${encodeURIComponent(id)}?expectedRevision=${expectedRevision}`, { method: "DELETE" });
export type KoiImportInput = { requestId: string; source: "folder" | "github" | "hub" | "migration"; declaredPaths?: string[]; directoryName?: string; repositoryUrl?: string; ref?: string; path?: string; workspaceId?: number; publicationId?: string; revision?: number; updateFromId?: string; expectedRevision?: number };
export const skipKoiMigration = (expectedRevision: number) => apiJson<{ libraryMode: "installed" }>("/api/koi/skill-migration/skip", { method: "POST", body: JSON.stringify({ expectedRevision }) });
export type KoiHubTarget = { workspaceId: number; name: string; publicationId: string; revision: number };
export const checkKoiSkillUpdate = (id: string) => apiJson<{ status: "up_to_date" | "manual_only" | "source_unavailable" | "update_available"; preview?: KoiPreview }>(`/api/koi/skills/${encodeURIComponent(id)}/check-update`, { method: "POST", body: "{}" });
export const createKoiImport = (input: KoiImportInput, signal?: AbortSignal) =>
 apiJson<{ preview: KoiPreview }>("/api/koi/skill-imports", { method: "POST", body: JSON.stringify(input), signal });
export const getKoiImport = (id: string) => koiRequestWithDeadline((signal) =>
 apiJson<{ preview: KoiPreview }>(`/api/koi/skill-imports/${encodeURIComponent(id)}`, { signal }), 15_000);
export const cancelKoiImport = (id: string) => apiJson<{ status: string }>(`/api/koi/skill-imports/${encodeURIComponent(id)}`, { method: "DELETE" });
export const uploadKoiImportFile = (id: string, path: string, contentBase64: string) =>
 apiJson<{ path: string; errorCode?: string }>(`/api/koi/skill-imports/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`, { method: "PUT", body: JSON.stringify({ contentBase64 }) });
export const analyzeKoiImport = (id: string) =>
 apiJson<{ preview: KoiPreview }>(`/api/koi/skill-imports/${encodeURIComponent(id)}/analyze`, { method: "POST", body: "{}" });
export type KoiImportConfirmation = { requestId: string; previewRevision: number; candidateIds: string[]; enable: boolean };
export const confirmKoiImport = (id: string, input: KoiImportConfirmation) => koiRequestWithDeadline((signal) =>
 apiJson<{ installed: KoiSkill[] }>(`/api/koi/skill-imports/${encodeURIComponent(id)}/confirm`, { method: "POST", body: JSON.stringify(input), signal }), 180_000);

// Confirmation may spend 45 seconds reading sources and 2 minutes staging bytes.
// Bound both the request and receipt lookup, including native transports that
// cannot reject immediately when aborted. A timeout does not prove rollback.
async function koiRequestWithDeadline<T>(request: (signal: AbortSignal) => Promise<T>, milliseconds: number): Promise<T> {
 const controller = new AbortController();
 let timer: ReturnType<typeof setTimeout> | undefined;
 const deadline = new Promise<never>((_resolve, reject) => {
  timer = setTimeout(() => { controller.abort(); reject(new Error("koi_request_timeout")); }, milliseconds);
 });
 try { return await Promise.race([request(controller.signal), deadline]); }
 finally { clearTimeout(timer); }
}

// Stable error codes map to localized guidance; raw upstream text is never shown.
const KOI_ERROR_LABELS: Record<string, string> = {
 migration_timeout: "legacyTimeout",
 skill_migration_required: "legacyRequired",
 preview_expired: "koiPreviewExpired", preview_not_ready: "koiPreviewNotReady",
 no_skills: "koiNoSkills", validation_failed: "koiValidationFailed",
 skill_incompatible: "koiIncompatible", skill_invalid: "koiSkillInvalid",
 sensitive_data_detected: "koiSensitive", storage_quota_exceeded: "koiQuota",
 revision_conflict: "koiConflict", idempotency_conflict: "koiConflict",
 upload_incomplete: "koiUploadIncomplete", file_too_large: "koiFileTooLarge",
 koi_unavailable: "koiUnavailable", not_found: "koiSkillMissing",
 source_unavailable: "sourceUnavailable",
};

export function koiErrorMessage(
  error: unknown,
  labels: Record<string, string>,
  fallback = labels.koiGenericError,
): string {
  if (error instanceof ApiError) {
    // A failed preview keeps its machine-readable code in errorCode but the
    // request itself may still be a 202; both paths surface through here.
    if (error.code && KOI_ERROR_LABELS[error.code]) return labels[KOI_ERROR_LABELS[error.code]];
    if (error.code === "membership_required") return labels.koiMembersOnly;
    if (error.code === "unauthorized") return labels.koiLoginRequired;
  }
  const github = githubImportErrorMessage(error, labels, "");
  return github || fallback;
}

export function koiPreviewErrorLabel(preview: KoiPreview, labels: Record<string, string>): string {
  const key = KOI_ERROR_LABELS[preview.errorCode ?? ""];
  return key ? labels[key] : preview.errorCode === "preview_expired" ? labels.koiPreviewExpired : labels.koiAnalysisFailed;
}

export function koiRejectionLabel(item: KoiImportRejection, labels: Record<string, string>): string {
  const summary = labels[`reject_${item.reason}`] ?? labels.koiSkillInvalid;
  const details = (item.details ?? []).map((detail) => koiRequirementLabel(detail, labels));
  return details.length ? `${summary} (${details.join("; ")})` : summary;
}

export function koiRequirementLabel(detail: string, labels: Record<string, string>): string {
  const separator = detail.indexOf(":");
  const code = separator < 0 ? detail : detail.slice(0, separator);
  const name = separator < 0 ? "" : detail.slice(separator + 1);
  return (labels[`requirement_${code}`] ?? labels.koiIncompatible).replace("{name}", name);
}
