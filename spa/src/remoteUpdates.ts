export const REMOTE_UPDATE_INTERVAL_MS = 30_000;

export type RemoteDocumentUpdateDecision = "unchanged" | "apply" | "prompt";

export function decideRemoteDocumentUpdate(
  localRevision: number,
  remoteRevision: number,
  dirty: boolean,
): RemoteDocumentUpdateDecision {
  if (remoteRevision <= localRevision) return "unchanged";
  return dirty ? "prompt" : "apply";
}
