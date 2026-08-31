import {
  createFolder,
  deleteEmptyOrganizerFolder,
  listDocuments,
  listFolders,
  moveDocument,
  type DocumentSummary,
  type Folder,
} from "./api";
import {
  documentOrganizerFolderKey,
  isDocumentInOrganizerScope,
  organizerScopeFolderIds,
  type DocumentOrganizationPlan,
} from "./components/editor/documentOrganizerCore";

export type ApplyDocumentOrganizationResult = {
  moved: number;
  failed: number;
  foldersCreated: number;
};

const MOVE_CONCURRENCY = 4;
const ORGANIZATION_LOCK_NAME = "koinote:document-organization";
let organizationQueue: Promise<void> = Promise.resolve();

export async function applyDocumentOrganization(
  plan: DocumentOrganizationPlan,
): Promise<ApplyDocumentOrganizationResult> {
  const run = organizationQueue.then(
    () => withOrganizationLock(() => applyDocumentOrganizationNow(plan)),
    () => withOrganizationLock(() => applyDocumentOrganizationNow(plan)),
  );
  organizationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function withOrganizationLock<T>(operation: () => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined") return operation();
  const lockManager = (
    navigator as Navigator & {
      locks?: { request<T>(name: string, callback: () => Promise<T>): Promise<T> };
    }
  ).locks;
  return lockManager
    ? lockManager.request(ORGANIZATION_LOCK_NAME, operation)
    : operation();
}

async function applyDocumentOrganizationNow(
  plan: DocumentOrganizationPlan,
): Promise<ApplyDocumentOrganizationResult> {
  const [{ documents }, { folders }] = await Promise.all([
    listDocuments(),
    listFolders(),
  ]);
  const currentDocumentById = new Map(
    documents.map((document) => [document.docId, document]),
  );
  const assignments = plan.assignments.filter((assignment) => {
    const document = currentDocumentById.get(assignment.docId);
    return document ? isDocumentInOrganizerScope(document, folders) : false;
  });
  if (assignments.length === 0) {
    return { moved: 0, failed: 0, foldersCreated: 0 };
  }

  const createdFolderIds: string[] = [];
  const folderIds = new Map<string, string>();
  const folderByLocation = new Map<string, Folder>();
  for (const folder of folders) {
    if (folder.organizerKind !== plan.strategy) continue;
    const key = documentOrganizerFolderKey(
      folder.parentFolderId,
      plan.strategy,
      folder.name,
    );
    const existing = folderByLocation.get(key);
    if (!existing || folder.folderId < existing.folderId) {
      folderByLocation.set(key, folder);
    }
  }

  try {
    for (const assignment of assignments) {
      let parentFolderId: string | null = null;
      for (let index = 1; index <= assignment.path.length; index += 1) {
        const path = assignment.path.slice(0, index);
        const pathKey = JSON.stringify(path);
        const cached = folderIds.get(pathKey);
        if (cached) {
          parentFolderId = cached;
          continue;
        }

        const name = path[path.length - 1];
        const locationKey = documentOrganizerFolderKey(
          parentFolderId,
          plan.strategy,
          name,
        );
        let folder = folderByLocation.get(locationKey);
        if (!folder) {
          const result = await createFolder({
            name,
            parentFolderId,
            organizerKind: plan.strategy,
          });
          folder = result.folder;
          folderByLocation.set(locationKey, folder);
          if (result.created === true) createdFolderIds.push(folder.folderId);
        }
        parentFolderId = folder.folderId;
        folderIds.set(pathKey, parentFolderId);
      }
    }
  } catch (error) {
    await cleanupCreatedFolders(createdFolderIds);
    throw error;
  }

  let nextIndex = 0;
  let moved = 0;
  let failed = 0;
  const workerCount = Math.min(MOVE_CONCURRENCY, assignments.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < assignments.length) {
        const assignment = assignments[nextIndex];
        nextIndex += 1;
        const folderId = folderIds.get(JSON.stringify(assignment.path));
        if (!folderId) {
          failed += 1;
          continue;
        }
        try {
          const document = currentDocumentById.get(assignment.docId);
          if (document?.folderId !== folderId) {
            await moveDocument(assignment.docId, folderId);
            moved += 1;
          }
        } catch {
          failed += 1;
        }
      }
    }),
  );

  await cleanupUnusedOrganizerFolders();
  return { moved, failed, foldersCreated: createdFolderIds.length };
}

async function cleanupCreatedFolders(folderIds: string[]) {
  for (const folderId of [...folderIds].reverse()) {
    try {
      await deleteEmptyOrganizerFolder(folderId);
    } catch {
      // 最佳努力清理。原始创建错误比清理错误更能解释本次失败。
    }
  }
}

async function cleanupUnusedOrganizerFolders() {
  try {
    const [{ documents }, folderResult] = await Promise.all([
      listDocuments(),
      listFolders(),
    ]);
    const remainingFolders = [...folderResult.folders];
    const blocked = new Set<string>();

    while (true) {
      const candidates = emptyOrganizerFolders(
        documents,
        remainingFolders,
      ).filter((folder) => !blocked.has(folder.folderId));
      if (candidates.length === 0) return;

      let deletedAny = false;
      for (const folder of candidates) {
        try {
          const result = await deleteEmptyOrganizerFolder(folder.folderId);
          if (!result.deleted) {
            blocked.add(folder.folderId);
            continue;
          }
          const index = remainingFolders.findIndex(
            (candidate) => candidate.folderId === folder.folderId,
          );
          if (index >= 0) remainingFolders.splice(index, 1);
          deletedAny = true;
        } catch {
          blocked.add(folder.folderId);
        }
      }
      if (!deletedAny) return;
    }
  } catch {
    // 清理空的旧自动目录不应改变本次文档移动的成功结果。
  }
}

function emptyOrganizerFolders(
  documents: DocumentSummary[],
  folders: Folder[],
): Folder[] {
  const organizerFolderIds = organizerScopeFolderIds(folders);
  const documentFolderIds = new Set(
    documents.flatMap((document) =>
      document.folderId ? [document.folderId] : [],
    ),
  );
  const parentFolderIds = new Set(
    folders.flatMap((folder) =>
      folder.parentFolderId ? [folder.parentFolderId] : [],
    ),
  );
  return folders.filter(
    (folder) =>
      folder.organizerKind !== null &&
      organizerFolderIds.has(folder.folderId) &&
      !documentFolderIds.has(folder.folderId) &&
      !parentFolderIds.has(folder.folderId),
  );
}
