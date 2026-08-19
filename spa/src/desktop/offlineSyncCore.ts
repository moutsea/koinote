export type OfflineDocumentSnapshot = {
  title: string;
  theme: string;
  content: string;
  folderId: string | null;
  localRevision: number;
  baseRevision: number;
  syncState: "clean" | "create" | "update" | "trash" | "conflict";
  changeSeq: number;
};

export type RemoteDocumentSnapshot = {
  title: string;
  theme: string;
  content: string;
  folderId: string | null;
  revision: number;
};

export type RemoteDocumentDecision =
  | "unchanged"
  | "replace-clean"
  | "acknowledge-local"
  | "conflict";

export type OfflineFolderSnapshot = {
  name: string;
  parentFolderId: string | null;
  organizerKind: "smart" | "activity" | null;
  syncState: "clean" | "create" | "update" | "delete" | "conflict";
};

export type RemoteFolderSnapshot = {
  name: string;
  parentFolderId: string | null;
  organizerKind: "smart" | "activity" | null;
};

export type RemoteFolderDecision =
  | "unchanged"
  | "replace-clean"
  | "acknowledge-local"
  | "keep-local";

export type AsyncSerialQueueScope = {
  runNested<T>(operation: (scope: AsyncSerialQueueScope) => Promise<T>): Promise<T>;
};

export type DesktopSyncSequenceResult = {
  state: "idle" | "error";
  message?: string;
};

export type DesktopSyncSequenceSteps = {
  pushFolders: () => Promise<void>;
  pushDocuments: () => Promise<string[]>;
  pullRemoteSnapshot: () => Promise<void>;
  maintain: () => Promise<void>;
  recordSuccess: () => Promise<void>;
  reportMaintenanceFailure?: (error: unknown) => void;
};

export async function runDesktopSyncSequence(
  steps: DesktopSyncSequenceSteps,
): Promise<DesktopSyncSequenceResult> {
  await steps.pushFolders();
  const imageUploadIssues = await steps.pushDocuments();
  await steps.pullRemoteSnapshot();
  try {
    await steps.maintain();
  } catch (error) {
    try {
      steps.reportMaintenanceFailure?.(error);
    } catch {}
  }
  await steps.recordSuccess();
  return {
    state: imageUploadIssues.length > 0 ? "error" : "idle",
    ...(imageUploadIssues[0] ? { message: imageUploadIssues[0] } : {}),
  };
}

export function desktopMaintenanceBackoff(attempts: number): number {
  const finiteAttempts = Number.isFinite(attempts) ? Math.floor(attempts) : 1;
  const normalized = Math.max(1, Math.min(16, finiteAttempts));
  return Math.min(30_000 * 2 ** (normalized - 1), 30 * 60_000);
}

export function createAsyncSerialQueue() {
  let tail: Promise<void> = Promise.resolve();
  const scope: AsyncSerialQueueScope = {
    runNested<T>(operation: (activeScope: AsyncSerialQueueScope) => Promise<T>) {
      return operation(scope);
    },
  };
  return function serialize<T>(
    operation: (activeScope: AsyncSerialQueueScope) => Promise<T>,
  ): Promise<T> {
    const run = () => operation(scope);
    const result = tail.then(run, run);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

export function acknowledgedLocalRevision(
  localRevision: number,
  remoteRevision: number,
): number {
  return Math.max(localRevision, remoteRevision);
}

export function pulledLocalRevision(
  localRevision: number,
  remoteRevision: number,
): number {
  return Math.max(localRevision + 1, remoteRevision);
}

export function canRunRemoteDocumentMutation(
  local: Pick<OfflineDocumentSnapshot, "baseRevision" | "syncState">,
): boolean {
  return local.syncState === "clean" && local.baseRevision > 0;
}

export function decideRemoteDocument(
  local: OfflineDocumentSnapshot,
  remote: RemoteDocumentSnapshot,
): RemoteDocumentDecision {
  if (local.syncState === "conflict" || local.syncState === "trash") {
    return "unchanged";
  }
  if (local.baseRevision === remote.revision) return "unchanged";
  if (local.syncState === "clean") return "replace-clean";
  if (
    local.title === remote.title &&
    local.theme === remote.theme &&
    local.content === remote.content &&
    local.folderId === remote.folderId
  ) {
    return "acknowledge-local";
  }
  return "conflict";
}

export function decideRemoteFolder(
  local: OfflineFolderSnapshot,
  remote: RemoteFolderSnapshot,
): RemoteFolderDecision {
  if (local.syncState === "conflict" || local.syncState === "delete") {
    return "unchanged";
  }
  const matches =
    local.name === remote.name &&
    local.parentFolderId === remote.parentFolderId &&
    local.organizerKind === remote.organizerKind;
  if (local.syncState === "clean") {
    return matches ? "unchanged" : "replace-clean";
  }
  return matches ? "acknowledge-local" : "keep-local";
}

export function snapshotGuard(
  local: Pick<OfflineDocumentSnapshot, "baseRevision" | "syncState" | "changeSeq">,
): [number, OfflineDocumentSnapshot["syncState"], number] {
  return [local.baseRevision, local.syncState, local.changeSeq];
}
