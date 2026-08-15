import type {
  Document,
  DocumentSearchResult,
  DocumentSummary,
  EditorTabs,
  Folder,
} from "../api";
import { getStoredDesktopSession } from "./auth";
import { prepareDesktopSync } from "./logoutGuard";
import { desktopFetch } from "./network";
import { DESKTOP_SYNC_EVENT } from "./runtime";
import {
  acknowledgedLocalRevision,
  decideRemoteDocument,
  decideRemoteFolder,
  pulledLocalRevision,
  snapshotGuard,
} from "./offlineSyncCore";

type SyncState = "clean" | "create" | "update" | "trash" | "conflict";
type FolderSyncState = "clean" | "create" | "update" | "delete" | "conflict";

type DocumentRow = {
  account_id: string;
  doc_id: string;
  title: string;
  theme: string;
  content: string;
  folder_id: string | null;
  local_revision: number;
  base_revision: number;
  created_at: string | null;
  updated_at: string | null;
  share_json: string | null;
  sync_state: SyncState;
  folder_dirty: number;
  change_seq: number;
  remote_snapshot: string | null;
  last_error: string | null;
};

type FolderRow = {
  account_id: string;
  folder_id: string;
  name: string;
  parent_folder_id: string | null;
  sync_state: FolderSyncState;
  change_seq: number;
  remote_snapshot: string | null;
  last_error: string | null;
};

export type DesktopSyncSummary = {
  state: "idle" | "syncing" | "offline" | "error";
  pending: number;
  conflicts: number;
  lastSyncedAt: string | null;
  message?: string;
};

export type DesktopConflict = {
  docId: string;
  title: string;
  local: Document;
  remote: Document;
};

const DATABASE_URL = "sqlite:koinote-offline.db";
const DEFAULT_DOCUMENT_THEME = "minimal";

let databasePromise: Promise<import("@tauri-apps/plugin-sql").default> | null = null;
let mutationTail: Promise<void> = Promise.resolve();
let syncPromise: Promise<DesktopSyncSummary> | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
const snapshotInitializations = new Map<string, Promise<void>>();

async function database() {
  if (!databasePromise) {
    databasePromise = import("@tauri-apps/plugin-sql").then(({ default: Database }) =>
      Database.load(DATABASE_URL),
    );
  }
  return databasePromise;
}

async function accountID(): Promise<string> {
  const session = await getStoredDesktopSession();
  if (!session?.accountId) throw new Error("Desktop session is unavailable");
  return session.accountId;
}

function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(operation, operation);
  mutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function notify(summary: DesktopSyncSummary) {
  window.dispatchEvent(new CustomEvent<DesktopSyncSummary>(DESKTOP_SYNC_EVENT, { detail: summary }));
}

export function desktopSyncEventName() {
  return DESKTOP_SYNC_EVENT;
}

export async function desktopListDocuments(): Promise<{ documents: DocumentSummary[] }> {
  const account = await accountID();
  await ensureInitialSnapshot(account);
  const db = await database();
  const rows = await db.select<DocumentRow[]>(`
    SELECT * FROM offline_documents
    WHERE account_id = $1 AND sync_state <> 'trash'
    ORDER BY COALESCE(updated_at, '') DESC, doc_id DESC
  `, [account]);
  return {
    documents: rows.map((row) => ({
      docId: row.doc_id,
      title: row.title,
      folderId: row.folder_id,
      revision: row.local_revision,
      updatedAt: row.updated_at,
    })),
  };
}

export async function desktopSearchDocuments(
  query: string,
  limit: number,
): Promise<{ results: DocumentSearchResult[] }> {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return { results: [] };
  const account = await accountID();
  const db = await database();
  const rows = await db.select<DocumentRow[]>(`
    SELECT * FROM offline_documents
    WHERE account_id = $1 AND sync_state <> 'trash'
      AND (instr(lower(title), $2) > 0 OR instr(lower(content), $2) > 0)
    ORDER BY COALESCE(updated_at, '') DESC
    LIMIT $3
  `, [account, normalized, limit]);
  return {
    results: rows.map((row) => {
      const titleMatched = row.title.toLocaleLowerCase().includes(normalized);
      const contentIndex = row.content.toLocaleLowerCase().indexOf(normalized);
      const contentMatched = contentIndex >= 0;
      const start = Math.max(0, contentIndex - 60);
      const snippet = contentMatched
        ? `${start > 0 ? "…" : ""}${row.content.slice(start, contentIndex + normalized.length + 100)}${contentIndex + normalized.length + 100 < row.content.length ? "…" : ""}`
        : row.title;
      return {
        docId: row.doc_id,
        title: row.title,
        snippet,
        titleMatched,
        contentMatched,
        revision: row.local_revision,
        updatedAt: row.updated_at,
      };
    }),
  };
}

export async function desktopGetDocument(docId: string): Promise<{ document: Document }> {
  const account = await accountID();
  const row = await selectDocument(account, docId);
  if (row && row.sync_state !== "trash") return { document: rowToDocument(row) };

  const remote = await remoteJSON<{ document: Document }>(
    `/api/documents/${encodeURIComponent(docId)}`,
  );
  await insertRemoteDocument(account, remote.document, null);
  return remote;
}

export async function desktopCreateDocument(params?: {
  title?: string;
  content?: string;
  folderId?: string | null;
}): Promise<{ document: Document }> {
  return serializeMutation(async () => {
    const account = await accountID();
    const db = await database();
    const now = new Date().toISOString();
    const document: Document = {
      docId: crypto.randomUUID(),
      title: params?.title?.trim() ?? "",
      theme: DEFAULT_DOCUMENT_THEME,
      content: params?.content ?? "",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      share: null,
    };
    await db.execute(`
      INSERT INTO offline_documents (
        account_id, doc_id, title, theme, content, folder_id,
        local_revision, base_revision, created_at, updated_at, share_json,
        sync_state, change_seq
      ) VALUES ($1, $2, $3, $4, $5, $6, 1, 0, $7, $7, NULL, 'create', 1)
    `, [account, document.docId, document.title, document.theme, document.content, params?.folderId ?? null, now]);
    scheduleSync();
    return { document };
  });
}

export async function desktopUpdateDocument(
  docId: string,
  params: {
    title: string;
    content: string;
    theme?: string;
    expectedRevision: number;
  },
): Promise<{ document: Document }> {
  return serializeMutation(async () => {
    const account = await accountID();
    const db = await database();
    const now = new Date().toISOString();
    const result = await db.execute(`
      UPDATE offline_documents
      SET title = $3, content = $4,
          theme = CASE WHEN $5 IS NULL THEN theme ELSE $5 END,
          local_revision = local_revision + 1,
          updated_at = $6,
          sync_state = CASE WHEN sync_state = 'create' THEN 'create' ELSE 'update' END,
          change_seq = change_seq + 1,
          remote_snapshot = NULL,
          last_error = NULL
      WHERE account_id = $1 AND doc_id = $2
        AND local_revision = $7 AND sync_state <> 'trash'
    `, [account, docId, params.title.trim(), params.content, params.theme ?? null, now, params.expectedRevision]);
    if (result.rowsAffected !== 1) throw new Error("document_revision_conflict");
    const row = await selectDocument(account, docId);
    if (!row) throw new Error("Document not found");
    scheduleSync();
    return { document: rowToDocument(row) };
  });
}

export async function desktopTrashDocument(docId: string): Promise<{ success: boolean }> {
  return serializeMutation(async () => {
    const account = await accountID();
    const db = await database();
    await db.execute(`
      UPDATE offline_documents
      SET sync_state = 'trash', change_seq = change_seq + 1,
          updated_at = $3, last_error = NULL
      WHERE account_id = $1 AND doc_id = $2
    `, [account, docId, new Date().toISOString()]);
    scheduleSync();
    return { success: true };
  });
}

export async function desktopListFolders(): Promise<{ folders: Folder[] }> {
  const account = await accountID();
  await ensureInitialSnapshot(account);
  const db = await database();
  const rows = await db.select<FolderRow[]>(`
    SELECT * FROM offline_folders
    WHERE account_id = $1 AND sync_state <> 'delete'
    ORDER BY name, folder_id
  `, [account]);
  return { folders: rows.map(rowToFolder) };
}

export async function desktopCreateFolder(params: {
  name: string;
  parentFolderId: string | null;
}): Promise<{ folder: Folder }> {
  return serializeMutation(async () => {
    const account = await accountID();
    const db = await database();
    const folder: Folder = {
      folderId: crypto.randomUUID(),
      name: params.name.trim(),
      parentFolderId: params.parentFolderId,
    };
    await db.execute(`
      INSERT INTO offline_folders (
        account_id, folder_id, name, parent_folder_id, sync_state, change_seq
      ) VALUES ($1, $2, $3, $4, 'create', 1)
    `, [account, folder.folderId, folder.name, folder.parentFolderId]);
    scheduleSync();
    return { folder };
  });
}

export async function desktopRenameFolder(folderId: string, name: string): Promise<{ folder: Folder }> {
  await mutateFolder(folderId, `name = $3`, [name.trim()]);
  const account = await accountID();
  const db = await database();
  const rows = await db.select<FolderRow[]>(`
    SELECT * FROM offline_folders WHERE account_id = $1 AND folder_id = $2
  `, [account, folderId]);
  if (!rows[0]) throw new Error("Folder not found");
  return { folder: rowToFolder(rows[0]) };
}

export async function desktopMoveFolder(folderId: string, parentFolderId: string | null) {
  return mutateFolder(folderId, `parent_folder_id = $3`, [parentFolderId]);
}

async function mutateFolder(folderId: string, assignment: string, values: unknown[]) {
  return serializeMutation(async () => {
    const account = await accountID();
    const db = await database();
    await db.execute(`
      UPDATE offline_folders SET ${assignment},
        sync_state = CASE WHEN sync_state = 'create' THEN 'create' ELSE 'update' END,
        change_seq = change_seq + 1, remote_snapshot = NULL, last_error = NULL
      WHERE account_id = $1 AND folder_id = $2 AND sync_state <> 'delete'
    `, [account, folderId, ...values]);
    scheduleSync();
    return { ok: true };
  });
}

export async function desktopDeleteFolder(folderId: string) {
  return serializeMutation(async () => {
    const account = await accountID();
    const db = await database();
    const rows = await db.select<FolderRow[]>(`
      SELECT * FROM offline_folders WHERE account_id = $1 AND folder_id = $2
    `, [account, folderId]);
    const folder = rows[0];
    if (!folder) return { ok: true };
    await db.execute(`
      UPDATE offline_documents SET folder_id = $3, folder_dirty = 1, change_seq = change_seq + 1
      WHERE account_id = $1 AND folder_id = $2 AND sync_state <> 'trash'
    `, [account, folderId, folder.parent_folder_id]);
    await db.execute(`
      UPDATE offline_folders SET parent_folder_id = $3,
        sync_state = CASE WHEN sync_state = 'create' THEN 'create' ELSE 'update' END,
        change_seq = change_seq + 1
      WHERE account_id = $1 AND parent_folder_id = $2 AND sync_state <> 'delete'
    `, [account, folderId, folder.parent_folder_id]);
    if (folder.sync_state === "create") {
      await db.execute(`DELETE FROM offline_folders WHERE account_id = $1 AND folder_id = $2`, [account, folderId]);
    } else {
      await db.execute(`
        UPDATE offline_folders SET sync_state = 'delete', change_seq = change_seq + 1
        WHERE account_id = $1 AND folder_id = $2
      `, [account, folderId]);
    }
    scheduleSync();
    return { ok: true };
  });
}

export async function desktopMoveDocument(docId: string, folderId: string | null) {
  return serializeMutation(async () => {
    const account = await accountID();
    const db = await database();
    await db.execute(`
      UPDATE offline_documents
      SET folder_id = $3, folder_dirty = 1, change_seq = change_seq + 1
      WHERE account_id = $1 AND doc_id = $2 AND sync_state <> 'trash'
    `, [account, docId, folderId]);
    scheduleSync();
    return { ok: true };
  });
}

export async function desktopGetEditorTabs(): Promise<EditorTabs> {
  const account = await accountID();
  const db = await database();
  const rows = await db.select<{ value: string }[]>(`
    SELECT value FROM offline_meta WHERE account_id = $1 AND key = 'editor-tabs'
  `, [account]);
  if (!rows[0]) return { tabs: [], activeDocId: null };
  try {
    return JSON.parse(rows[0].value) as EditorTabs;
  } catch {
    return { tabs: [], activeDocId: null };
  }
}

export async function desktopPutEditorTabs(value: EditorTabs): Promise<EditorTabs> {
  const account = await accountID();
  const db = await database();
  await db.execute(`
    INSERT INTO offline_meta (account_id, key, value) VALUES ($1, 'editor-tabs', $2)
    ON CONFLICT (account_id, key) DO UPDATE SET value = excluded.value
  `, [account, JSON.stringify(value)]);
  return value;
}

export function syncDesktopNow(options: { silent?: boolean } = {}): Promise<DesktopSyncSummary> {
  if (syncPromise) return syncPromise;
  syncPromise = performPreparedSync(options).finally(() => {
    syncPromise = null;
  });
  return syncPromise;
}

export async function desktopSyncSummary(): Promise<DesktopSyncSummary> {
  const account = await accountID();
  return calculateSummary(account, "idle");
}

export async function desktopListConflicts(): Promise<DesktopConflict[]> {
  const account = await accountID();
  const db = await database();
  const rows = await db.select<DocumentRow[]>(`
    SELECT * FROM offline_documents WHERE account_id = $1 AND sync_state = 'conflict'
  `, [account]);
  return rows.flatMap((row) => {
    if (!row.remote_snapshot) return [];
    try {
      return [{
        docId: row.doc_id,
        title: row.title,
        local: rowToDocument(row),
        remote: JSON.parse(row.remote_snapshot) as Document,
      }];
    } catch {
      return [];
    }
  });
}

export async function resolveDesktopConflict(docId: string, choice: "local" | "remote") {
  return serializeMutation(async () => {
    const account = await accountID();
    const row = await selectDocument(account, docId);
    if (!row?.remote_snapshot) return;
    const remote = JSON.parse(row.remote_snapshot) as Document;
    const db = await database();
    if (choice === "remote") {
      await db.execute(`
        UPDATE offline_documents
        SET title = $3, theme = $4, content = $5,
            local_revision = $6, base_revision = $7,
            created_at = $8, updated_at = $9, share_json = $10,
            sync_state = 'clean', folder_dirty = 0,
            change_seq = change_seq + 1, remote_snapshot = NULL, last_error = NULL
        WHERE account_id = $1 AND doc_id = $2
          AND sync_state = 'conflict' AND change_seq = $11
      `, [
        account, docId, remote.title, remote.theme, remote.content,
        pulledLocalRevision(row.local_revision, remote.revision), remote.revision,
        remote.createdAt ?? null, remote.updatedAt ?? null,
        remote.share ? JSON.stringify(remote.share) : null, row.change_seq,
      ]);
    } else {
      await db.execute(`
        UPDATE offline_documents
        SET base_revision = $3, sync_state = 'update', remote_snapshot = NULL,
            last_error = NULL, change_seq = change_seq + 1
        WHERE account_id = $1 AND doc_id = $2
      `, [account, docId, remote.revision]);
      scheduleSync();
    }
  });
}

export async function clearDesktopOfflineAccount(account: string): Promise<void> {
  const initialization = snapshotInitializations.get(account);
  if (initialization) await initialization.catch(() => undefined);
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  const activeSync = syncPromise;
  if (activeSync) await activeSync.catch(() => undefined);
  const db = await database();
  await db.execute(`DELETE FROM offline_documents WHERE account_id = $1`, [account]);
  await db.execute(`DELETE FROM offline_folders WHERE account_id = $1`, [account]);
  await db.execute(`DELETE FROM offline_meta WHERE account_id = $1`, [account]);
  snapshotInitializations.delete(account);
}

async function ensureInitialSnapshot(account: string): Promise<void> {
  const existing = snapshotInitializations.get(account);
  if (existing) return existing;

  const initialization = initializeDesktopSnapshot(account);
  snapshotInitializations.set(account, initialization);
  try {
    await initialization;
  } catch (error) {
    snapshotInitializations.delete(account);
    throw error;
  }
}

async function initializeDesktopSnapshot(account: string): Promise<void> {
  const db = await database();
  const rows = await db.select<{ count: number }[]>(`
    SELECT COUNT(*) AS count FROM offline_documents WHERE account_id = $1
  `, [account]);
  if (Number(rows[0]?.count ?? 0) === 0) {
    try {
      await syncDesktopNow();
    } catch {
      // 空缓存 + 离线时返回空列表；连接恢复后状态组件会重新触发同步。
    }
  } else {
    scheduleSync(0);
  }
}

function scheduleSync(delay = 1500) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncDesktopNow();
  }, delay);
}

async function performPreparedSync(options: { silent?: boolean }): Promise<DesktopSyncSummary> {
  const account = await accountID();
  if (!(await prepareDesktopSync())) {
    const summary = await calculateSummary(account, "error", "Local edits could not be saved before sync");
    notify(summary);
    return summary;
  }
  return performSync(account, options);
}

async function performSync(
  account: string,
  options: { silent?: boolean },
): Promise<DesktopSyncSummary> {
  if (!options.silent) notify(await calculateSummary(account, "syncing"));
  try {
    await pushFolders(account);
    await pushDocuments(account);
    await pullRemoteSnapshot(account);
    const db = await database();
    const now = new Date().toISOString();
    await db.execute(`
      INSERT INTO offline_meta (account_id, key, value) VALUES ($1, 'last-synced-at', $2)
      ON CONFLICT (account_id, key) DO UPDATE SET value = excluded.value
    `, [account, now]);
    const summary = await calculateSummary(account, "idle");
    notify(summary);
    return summary;
  } catch (error) {
    const offline = !navigator.onLine;
    const summary = await calculateSummary(account, offline ? "offline" : "error", String(error));
    notify(summary);
    return summary;
  }
}

async function pushFolders(account: string) {
  const db = await database();
  let pendingCreates = await db.select<FolderRow[]>(`
    SELECT * FROM offline_folders WHERE account_id = $1 AND sync_state = 'create'
  `, [account]);
  while (pendingCreates.length > 0) {
    const pendingIDs = new Set(pendingCreates.map((row) => row.folder_id));
    const ready = pendingCreates.filter((row) => !row.parent_folder_id || !pendingIDs.has(row.parent_folder_id));
    if (ready.length === 0) break;
    for (const row of ready) {
      const result = await remoteJSON<{ folder: Folder }>("/api/folders", {
        method: "POST",
        body: JSON.stringify({ folderId: row.folder_id, name: row.name, parentFolderId: row.parent_folder_id }),
      });
      await acknowledgeFolder(account, row, result.folder);
    }
    pendingCreates = await db.select<FolderRow[]>(`
      SELECT * FROM offline_folders WHERE account_id = $1 AND sync_state = 'create'
    `, [account]);
  }

  const updates = await db.select<FolderRow[]>(`
    SELECT * FROM offline_folders WHERE account_id = $1 AND sync_state = 'update'
  `, [account]);
  for (const row of updates) {
    await remoteJSON(`/api/folders/${encodeURIComponent(row.folder_id)}`, {
      method: "PUT", body: JSON.stringify({ name: row.name }),
    });
    await remoteJSON(`/api/folders/${encodeURIComponent(row.folder_id)}/parent`, {
      method: "PUT", body: JSON.stringify({ parentFolderId: row.parent_folder_id }),
    });
    await acknowledgeFolder(account, row, rowToFolder(row));
  }

  const deletions = await db.select<FolderRow[]>(`
    SELECT * FROM offline_folders WHERE account_id = $1 AND sync_state = 'delete'
  `, [account]);
  for (const row of deletions) {
    try {
      await remoteJSON(`/api/folders/${encodeURIComponent(row.folder_id)}`, { method: "DELETE" });
    } catch (error) {
      if (!(error instanceof RemoteHTTPError) || error.status !== 404) throw error;
    }
    await db.execute(`DELETE FROM offline_folders WHERE account_id = $1 AND folder_id = $2`, [account, row.folder_id]);
  }
}

async function pushDocuments(account: string) {
  const db = await database();
  const rows = await db.select<DocumentRow[]>(`
    SELECT * FROM offline_documents
    WHERE account_id = $1 AND (sync_state <> 'clean' OR folder_dirty = 1)
    ORDER BY CASE sync_state WHEN 'create' THEN 0 WHEN 'update' THEN 1 WHEN 'trash' THEN 2 ELSE 3 END
  `, [account]);
  for (const row of rows) {
    if (row.sync_state === "conflict") continue;
    if (row.sync_state === "trash") {
      if (row.base_revision === 0) {
        await db.execute(`DELETE FROM offline_documents WHERE account_id = $1 AND doc_id = $2`, [account, row.doc_id]);
        continue;
      }
      try {
        await remoteJSON(`/api/documents/${encodeURIComponent(row.doc_id)}`, { method: "DELETE" });
      } catch (error) {
        if (!(error instanceof RemoteHTTPError) || error.status !== 404) throw error;
      }
      await db.execute(`DELETE FROM offline_documents WHERE account_id = $1 AND doc_id = $2`, [account, row.doc_id]);
      continue;
    }

    try {
      let remote: Document | null = null;
      if (row.sync_state === "create") {
        remote = (await remoteJSON<{ document: Document }>("/api/documents", {
          method: "POST",
          body: JSON.stringify({
            docId: row.doc_id, title: row.title, theme: row.theme,
            content: row.content, folderId: row.folder_id,
          }),
        })).document;
      } else if (row.sync_state === "update") {
        try {
          remote = (await remoteJSON<{ document: Document }>(`/api/documents/${encodeURIComponent(row.doc_id)}`, {
            method: "PUT",
            body: JSON.stringify({
              title: row.title, theme: row.theme, content: row.content,
              expectedRevision: row.base_revision,
            }),
          })).document;
        } catch (error) {
          if (!(error instanceof RemoteHTTPError) || error.status !== 404) throw error;
          remote = await recoverDeletedRemoteDocument(row);
          await db.execute(`
            UPDATE offline_documents SET folder_dirty = 1
            WHERE account_id = $1 AND doc_id = $2 AND sync_state <> 'trash'
          `, [account, row.doc_id]);
        }
      }
      if (remote) await acknowledgeDocument(account, row, remote);

      const current = await selectDocument(account, row.doc_id);
      if (current?.folder_dirty) {
        await remoteJSON(`/api/documents/${encodeURIComponent(row.doc_id)}/folder`, {
          method: "PUT", body: JSON.stringify({ folderId: current.folder_id }),
        });
        await db.execute(`
          UPDATE offline_documents SET folder_dirty = 0
          WHERE account_id = $1 AND doc_id = $2 AND change_seq = $3
        `, [account, row.doc_id, current.change_seq]);
      }
    } catch (error) {
      if (error instanceof RemoteHTTPError && error.status === 409) {
        const remote = await remoteJSON<{ document: Document }>(`/api/documents/${encodeURIComponent(row.doc_id)}`);
        await db.execute(`
          UPDATE offline_documents
          SET sync_state = 'conflict', remote_snapshot = $3, last_error = $4
          WHERE account_id = $1 AND doc_id = $2
        `, [account, row.doc_id, JSON.stringify(remote.document), error.code ?? "document_revision_conflict"]);
        continue;
      }
      throw error;
    }
  }
}

async function recoverDeletedRemoteDocument(row: DocumentRow): Promise<Document> {
  try {
    const restored = await remoteJSON<{ document: Document }>(
      `/api/documents/${encodeURIComponent(row.doc_id)}/restore`,
      { method: "POST" },
    );
    return (await remoteJSON<{ document: Document }>(
      `/api/documents/${encodeURIComponent(row.doc_id)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          title: row.title,
          theme: row.theme,
          content: row.content,
          expectedRevision: restored.document.revision,
        }),
      },
    )).document;
  } catch (error) {
    if (!(error instanceof RemoteHTTPError) || error.status !== 404) throw error;
    return (await remoteJSON<{ document: Document }>("/api/documents", {
      method: "POST",
      body: JSON.stringify({
        docId: row.doc_id,
        title: row.title,
        theme: row.theme,
        content: row.content,
        folderId: row.folder_id,
      }),
    })).document;
  }
}

async function pullRemoteSnapshot(account: string) {
  const [documents, folders] = await Promise.all([
    remoteJSON<{ documents: DocumentSummary[] }>("/api/documents"),
    remoteJSON<{ folders: Folder[] }>("/api/folders"),
  ]);
  if (!(await prepareDesktopSync())) {
    throw new Error("Local edits could not be saved before applying remote updates");
  }
  const db = await database();
  const localDocuments = await db.select<DocumentRow[]>(`
    SELECT * FROM offline_documents WHERE account_id = $1
  `, [account]);
  const localByID = new Map(localDocuments.map((row) => [row.doc_id, row]));
  const remoteIDs = new Set(documents.documents.map((document) => document.docId));

  for (const summary of documents.documents) {
    const local = localByID.get(summary.docId);
    if (local?.sync_state === "conflict") continue;
    if (!local) {
      const remote = await remoteJSON<{ document: Document }>(`/api/documents/${encodeURIComponent(summary.docId)}`);
      await insertRemoteDocument(account, remote.document, summary.folderId);
      continue;
    }
    if (local.sync_state === "trash") continue;
    if (summary.revision === local.base_revision) {
      if (summary.folderId !== local.folder_id && !local.folder_dirty) {
        await db.execute(`
          UPDATE offline_documents
          SET folder_id = $3, change_seq = change_seq + 1, last_error = NULL
          WHERE account_id = $1 AND doc_id = $2
            AND base_revision = $4 AND sync_state = $5 AND change_seq = $6
            AND folder_dirty = 0
        `, [
          account, summary.docId, summary.folderId, local.base_revision,
          local.sync_state, local.change_seq,
        ]);
      }
      continue;
    }
    const remote = await remoteJSON<{ document: Document }>(`/api/documents/${encodeURIComponent(summary.docId)}`);
    const decision = decideRemoteDocument(
      {
        title: local.title,
        theme: local.theme,
        content: local.content,
        folderId: local.folder_id,
        localRevision: local.local_revision,
        baseRevision: local.base_revision,
        syncState: local.sync_state,
        changeSeq: local.change_seq,
      },
      {
        title: remote.document.title,
        theme: remote.document.theme,
        content: remote.document.content,
        folderId: summary.folderId,
        revision: remote.document.revision,
      },
    );
    if (decision === "replace-clean") {
      await replaceDocumentFromRemote(account, local, remote.document, summary.folderId);
    } else if (decision === "acknowledge-local") {
      await acknowledgeMatchingRemoteDocument(account, local, remote.document, summary.folderId);
    } else if (decision === "conflict") {
      const [baseRevision, syncState, changeSeq] = snapshotGuard({
        baseRevision: local.base_revision,
        syncState: local.sync_state,
        changeSeq: local.change_seq,
      });
      await db.execute(`
        UPDATE offline_documents SET sync_state = 'conflict', remote_snapshot = $3,
          last_error = 'document_revision_conflict'
        WHERE account_id = $1 AND doc_id = $2
          AND base_revision = $4 AND sync_state = $5 AND change_seq = $6
      `, [account, summary.docId, JSON.stringify(remote.document), baseRevision, syncState, changeSeq]);
    }
  }
  for (const local of localDocuments) {
    if (!remoteIDs.has(local.doc_id) && (local.sync_state === "clean" || local.sync_state === "trash")) {
      await db.execute(`
        DELETE FROM offline_documents
        WHERE account_id = $1 AND doc_id = $2 AND sync_state = $3 AND change_seq = $4
      `, [account, local.doc_id, local.sync_state, local.change_seq]);
    }
  }

  const localFolders = await db.select<FolderRow[]>(`
    SELECT * FROM offline_folders WHERE account_id = $1
  `, [account]);
  const localFolderByID = new Map(localFolders.map((row) => [row.folder_id, row]));
  const remoteFolderIDs = new Set(folders.folders.map((folder) => folder.folderId));
  for (const remote of folders.folders) {
    const local = localFolderByID.get(remote.folderId);
    if (!local) {
      await insertRemoteFolder(account, remote);
      continue;
    }
    const decision = decideRemoteFolder(
      {
        name: local.name,
        parentFolderId: local.parent_folder_id,
        syncState: local.sync_state,
      },
      { name: remote.name, parentFolderId: remote.parentFolderId },
    );
    if (decision === "replace-clean") {
      await db.execute(`
        UPDATE offline_folders
        SET name = $3, parent_folder_id = $4, change_seq = change_seq + 1,
            remote_snapshot = NULL, last_error = NULL
        WHERE account_id = $1 AND folder_id = $2
          AND sync_state = 'clean' AND change_seq = $5
      `, [account, remote.folderId, remote.name, remote.parentFolderId, local.change_seq]);
    } else if (decision === "acknowledge-local") {
      await db.execute(`
        UPDATE offline_folders
        SET name = $3, parent_folder_id = $4, sync_state = 'clean',
            remote_snapshot = NULL, last_error = NULL
        WHERE account_id = $1 AND folder_id = $2
          AND sync_state = $5 AND change_seq = $6
      `, [account, remote.folderId, remote.name, remote.parentFolderId, local.sync_state, local.change_seq]);
    } else if (decision === "keep-local") {
      // 文件夹没有 revision。若推送和拉取之间另一端又改了它，保留本地待同步
      // 状态，下一轮再写入；文档正文才进入需要人工选择的冲突流程。
      await db.execute(`
        UPDATE offline_folders SET sync_state = 'update', last_error = NULL
        WHERE account_id = $1 AND folder_id = $2
          AND sync_state = $3 AND change_seq = $4
      `, [account, remote.folderId, local.sync_state, local.change_seq]);
    }
  }
  for (const local of localFolders) {
    if (!remoteFolderIDs.has(local.folder_id) && local.sync_state === "clean") {
      await db.execute(`
        DELETE FROM offline_folders
        WHERE account_id = $1 AND folder_id = $2
          AND sync_state = 'clean' AND change_seq = $3
      `, [account, local.folder_id, local.change_seq]);
    }
  }
}

async function acknowledgeDocument(account: string, sent: DocumentRow, remote: Document) {
  const db = await database();
  await db.execute(`
    UPDATE offline_documents
    SET title = CASE WHEN change_seq = $3 THEN $4 ELSE title END,
        theme = CASE WHEN change_seq = $3 THEN $5 ELSE theme END,
        content = CASE WHEN change_seq = $3 THEN $6 ELSE content END,
        local_revision = CASE WHEN change_seq = $3 THEN $7 ELSE local_revision END,
        base_revision = $8,
        created_at = CASE WHEN change_seq = $3 THEN $9 ELSE created_at END,
        updated_at = CASE WHEN change_seq = $3 THEN $10 ELSE updated_at END,
        share_json = CASE WHEN change_seq = $3 THEN $11 ELSE share_json END,
        sync_state = CASE
          WHEN change_seq = $3 THEN 'clean'
          WHEN sync_state = 'trash' THEN 'trash'
          ELSE 'update'
        END,
        remote_snapshot = NULL, last_error = NULL
    WHERE account_id = $1 AND doc_id = $2
  `, [
    account, sent.doc_id, sent.change_seq, remote.title, remote.theme, remote.content,
    acknowledgedLocalRevision(sent.local_revision, remote.revision), remote.revision,
    remote.createdAt ?? null, remote.updatedAt ?? null,
    remote.share ? JSON.stringify(remote.share) : null,
  ]);
}

async function acknowledgeFolder(account: string, sent: FolderRow, remote: Folder) {
  const db = await database();
  await db.execute(`
    UPDATE offline_folders
    SET name = CASE WHEN change_seq = $3 THEN $4 ELSE name END,
        parent_folder_id = CASE WHEN change_seq = $3 THEN $5 ELSE parent_folder_id END,
        sync_state = CASE
          WHEN change_seq = $3 THEN 'clean'
          WHEN sync_state = 'delete' THEN 'delete'
          ELSE 'update'
        END,
        remote_snapshot = NULL, last_error = NULL
    WHERE account_id = $1 AND folder_id = $2
  `, [account, sent.folder_id, sent.change_seq, remote.name, remote.parentFolderId]);
}

async function insertRemoteDocument(account: string, document: Document, folderID: string | null) {
  const db = await database();
  await db.execute(`
    INSERT INTO offline_documents (
      account_id, doc_id, title, theme, content, folder_id,
      local_revision, base_revision, created_at, updated_at, share_json,
      sync_state, folder_dirty, change_seq, remote_snapshot, last_error
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, 'clean', 0, 0, NULL, NULL)
    ON CONFLICT (account_id, doc_id) DO NOTHING
  `, [
    account, document.docId, document.title, document.theme, document.content, folderID,
    document.revision, document.createdAt ?? null, document.updatedAt ?? null,
    document.share ? JSON.stringify(document.share) : null,
  ]);
}

async function replaceDocumentFromRemote(
  account: string,
  local: DocumentRow,
  document: Document,
  folderID: string | null,
) {
  const db = await database();
  const [baseRevision, syncState, changeSeq] = snapshotGuard({
    baseRevision: local.base_revision,
    syncState: local.sync_state,
    changeSeq: local.change_seq,
  });
  await db.execute(`
    UPDATE offline_documents
    SET title = $3, theme = $4, content = $5, folder_id = $6,
        local_revision = $7, base_revision = $8,
        created_at = $9, updated_at = $10, share_json = $11,
        sync_state = 'clean', folder_dirty = 0, change_seq = change_seq + 1,
        remote_snapshot = NULL, last_error = NULL
    WHERE account_id = $1 AND doc_id = $2
      AND base_revision = $12 AND sync_state = $13 AND change_seq = $14
  `, [
    account, document.docId, document.title, document.theme, document.content, folderID,
    pulledLocalRevision(local.local_revision, document.revision), document.revision,
    document.createdAt ?? null, document.updatedAt ?? null,
    document.share ? JSON.stringify(document.share) : null,
    baseRevision, syncState, changeSeq,
  ]);
}

async function acknowledgeMatchingRemoteDocument(
  account: string,
  local: DocumentRow,
  document: Document,
  folderID: string | null,
) {
  const db = await database();
  const [baseRevision, syncState, changeSeq] = snapshotGuard({
    baseRevision: local.base_revision,
    syncState: local.sync_state,
    changeSeq: local.change_seq,
  });
  await db.execute(`
    UPDATE offline_documents
    SET title = $3, theme = $4, content = $5, folder_id = $6,
        local_revision = $7, base_revision = $8,
        created_at = $9, updated_at = $10, share_json = $11,
        sync_state = 'clean', folder_dirty = 0,
        remote_snapshot = NULL, last_error = NULL
    WHERE account_id = $1 AND doc_id = $2
      AND base_revision = $12 AND sync_state = $13 AND change_seq = $14
  `, [
    account, document.docId, document.title, document.theme, document.content, folderID,
    acknowledgedLocalRevision(local.local_revision, document.revision), document.revision,
    document.createdAt ?? null, document.updatedAt ?? null,
    document.share ? JSON.stringify(document.share) : null,
    baseRevision, syncState, changeSeq,
  ]);
}

async function insertRemoteFolder(account: string, folder: Folder) {
  const db = await database();
  await db.execute(`
    INSERT INTO offline_folders (
      account_id, folder_id, name, parent_folder_id, sync_state, change_seq
    ) VALUES ($1, $2, $3, $4, 'clean', 0)
    ON CONFLICT (account_id, folder_id) DO NOTHING
  `, [account, folder.folderId, folder.name, folder.parentFolderId]);
}

async function selectDocument(account: string, docID: string): Promise<DocumentRow | null> {
  const db = await database();
  const rows = await db.select<DocumentRow[]>(`
    SELECT * FROM offline_documents WHERE account_id = $1 AND doc_id = $2
  `, [account, docID]);
  return rows[0] ?? null;
}

function rowToDocument(row: DocumentRow): Document {
  let share: Document["share"] = null;
  if (row.share_json) {
    try {
      share = JSON.parse(row.share_json) as NonNullable<Document["share"]>;
    } catch {
      share = null;
    }
  }
  return {
    docId: row.doc_id,
    title: row.title,
    theme: row.theme,
    content: row.content,
    revision: row.local_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    share,
  };
}

function rowToFolder(row: FolderRow): Folder {
  return { folderId: row.folder_id, name: row.name, parentFolderId: row.parent_folder_id };
}

async function calculateSummary(
  account: string,
  state: DesktopSyncSummary["state"],
  message?: string,
): Promise<DesktopSyncSummary> {
  const db = await database();
  const counts = await db.select<{ pending: number; conflicts: number }[]>(`
    SELECT
      (SELECT COUNT(*) FROM offline_documents WHERE account_id = $1 AND (sync_state <> 'clean' OR folder_dirty = 1)) +
      (SELECT COUNT(*) FROM offline_folders WHERE account_id = $1 AND sync_state <> 'clean') AS pending,
      (SELECT COUNT(*) FROM offline_documents WHERE account_id = $1 AND sync_state = 'conflict') AS conflicts
  `, [account]);
  const meta = await db.select<{ value: string }[]>(`
    SELECT value FROM offline_meta WHERE account_id = $1 AND key = 'last-synced-at'
  `, [account]);
  return {
    state,
    pending: Number(counts[0]?.pending ?? 0),
    conflicts: Number(counts[0]?.conflicts ?? 0),
    lastSyncedAt: meta[0]?.value ?? null,
    ...(message ? { message } : {}),
  };
}

class RemoteHTTPError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`Remote request failed (${status})`);
  }
}

async function remoteJSON<T = { ok: boolean }>(path: string, init?: RequestInit): Promise<T> {
  const response = await desktopFetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let code: string | undefined;
    try {
      const body = (await response.json()) as { code?: string };
      code = body.code;
    } catch {
      // 状态码足够用于同步决策。
    }
    throw new RemoteHTTPError(response.status, code);
  }
  return response.json() as Promise<T>;
}
