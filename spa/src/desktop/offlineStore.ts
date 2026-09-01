import type {
  Document,
  DocumentSearchResult,
  DocumentSummary,
  EditorTabs,
  Folder,
  TrashedDocumentSummary,
  UploadedImage,
} from "../api";
import { invoke } from "@tauri-apps/api/core";
import {
  forEachConcurrent,
  imageReferences,
  MAX_IMPORT_UPLOAD_IMAGE_BYTES,
} from "../documentTransferCore";
import { imageFetchURL } from "../components/editor/imageLoading";
import { getStoredDesktopSession } from "./auth";
import { prepareDesktopSync } from "./logoutGuard";
import { desktopFetch } from "./network";
import { DESKTOP_SYNC_EVENT } from "./runtime";
import {
  decryptDesktopLocalValue,
  DESKTOP_LOCAL_ACCOUNT_ID,
  encryptDesktopLocalValue,
  isDesktopLocalModeSelected,
  isDesktopLocalModeUnlocked,
  verifyDesktopLocalModePassword,
} from "./localMode";
import {
  acknowledgedLocalRevision,
  canRunRemoteDocumentMutation,
  createAsyncSerialQueue,
  desktopMaintenanceBackoff,
  decideRemoteDocument,
  decideRemoteFolder,
  pulledLocalRevision,
  runDesktopSyncSequence,
  snapshotGuard,
} from "./offlineSyncCore";
import {
  DESKTOP_IMAGE_UPLOAD_FAILED_EVENT,
  DESKTOP_IMAGE_UPLOADED_EVENT,
  desktopLocalImageID,
  desktopLocalImageURL,
  imageObjectKeyFromSource,
  isRemoteHTTPImageSource,
  replaceDesktopLocalImageURLs,
} from "./offlineImagesCore";

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
  organizer_kind: Folder["organizerKind"];
  sync_state: FolderSyncState;
  change_seq: number;
  remote_snapshot: string | null;
  last_error: string | null;
};

type OfflineImageRow = {
  account_id: string;
  image_id: string;
  content_type: string;
  base64_data: string;
  byte_size: number;
  object_key: string | null;
  remote_url: string | null;
  created_at: string;
  last_error: string | null;
  is_local_origin: number;
};

type OfflineImageIdentity = Pick<OfflineImageRow, "image_id" | "object_key">;

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

export type DesktopImageCacheSummary = {
  usedBytes: number;
  remoteCacheBytes: number;
  pendingLocalBytes: number;
  remoteCacheLimitBytes: number;
  maintenanceIssue: {
    attempts: number;
    stages: string[];
    nextRetryAt: string;
  } | null;
};

export type DesktopLocalImportSummary = {
  documents: number;
  folders: number;
  images: number;
};

type DesktopLocalImportBatch = {
  stagingAccount: string;
  folders: Array<{
    folderId: string;
    name: string;
    parentFolderId: string | null;
    organizerKind: Folder["organizerKind"];
  }>;
  images: Array<{
    imageId: string;
    contentType: string;
    base64Data: string;
    byteSize: number;
    createdAt: string;
  }>;
  documents: Array<{
    docId: string;
    title: string;
    theme: string;
    content: string;
    folderId: string | null;
    createdAt: string;
  }>;
};

type ImageMaintenanceState = {
  attempts: number;
  stages: string[];
  errors: Record<string, string>;
  lastFailedAt: string;
  nextRetryAt: string;
};

const DATABASE_URL = "sqlite:koinote-offline.db";
const DEFAULT_DOCUMENT_THEME = "minimal";
const DESKTOP_IMAGE_CONCURRENCY = 3;
const LOCAL_IMPORT_FOLDER_BATCH_SIZE = 100;
const LOCAL_IMPORT_DOCUMENT_BATCH_SIZE = 10;
const IMAGE_MAINTENANCE_META_KEY = "image-maintenance-state";
export const DESKTOP_DOCUMENT_SYNC_IDLE_MS = 20_000;
export const DESKTOP_REMOTE_IMAGE_CACHE_LIMIT_BYTES = 512 * 1024 * 1024;
// 图片写入和文档自动保存不是一个原子操作。维护任务在两者之间运行时，
// 不能把刚插入、尚未出现在文档正文里的图片误判成孤儿。
const DESKTOP_OFFLINE_IMAGE_CLEANUP_GRACE_MS = 10 * 60 * 1000;
const DESKTOP_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

let databasePromise: Promise<import("@tauri-apps/plugin-sql").default> | null = null;
const serializeMutation = createAsyncSerialQueue();
const serializeImageCacheMutation = createAsyncSerialQueue();
let syncPromise: Promise<DesktopSyncSummary> | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncQueuedAfterCurrent = false;
let lastDocumentMutationAt = 0;
const snapshotInitializations = new Map<string, Promise<void>>();
const remoteCacheFullAccounts = new Set<string>();

async function database() {
  if (!databasePromise) {
    databasePromise = import("@tauri-apps/plugin-sql").then(({ default: Database }) =>
      Database.load(DATABASE_URL),
    );
  }
  return databasePromise;
}

async function accountID(): Promise<string> {
  if (isDesktopLocalModeUnlocked()) return DESKTOP_LOCAL_ACCOUNT_ID;
  if (isDesktopLocalModeSelected()) throw new Error("local_mode_locked");
  const session = await getStoredDesktopSession();
  if (!session?.accountId) throw new Error("Desktop session is unavailable");
  return session.accountId;
}

function isLocalAccount(account: string): boolean {
  return account === DESKTOP_LOCAL_ACCOUNT_ID;
}

async function storedLocalValue(account: string, value: string): Promise<string> {
  return isLocalAccount(account) ? encryptDesktopLocalValue(value) : value;
}

async function readableDocumentRow(
  account: string,
  row: DocumentRow,
  key?: CryptoKey,
): Promise<DocumentRow> {
  if (!isLocalAccount(account)) return row;
  return {
    ...row,
    title: await decryptDesktopLocalValue(row.title, key),
    theme: await decryptDesktopLocalValue(row.theme, key),
    content: await decryptDesktopLocalValue(row.content, key),
    share_json: null,
    remote_snapshot: null,
  };
}

async function readableFolderRow(
  account: string,
  row: FolderRow,
  key?: CryptoKey,
): Promise<FolderRow> {
  if (!isLocalAccount(account)) return row;
  return { ...row, name: await decryptDesktopLocalValue(row.name, key) };
}

async function readableImageRow(
  account: string,
  row: OfflineImageRow,
  key?: CryptoKey,
): Promise<OfflineImageRow> {
  if (!isLocalAccount(account)) return row;
  return {
    ...row,
    base64_data: await decryptDesktopLocalValue(row.base64_data, key),
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function imageDataURL(row: OfflineImageRow): string {
  return `data:${row.content_type};base64,${row.base64_data}`;
}

function offlineImageCleanupCutoff(): string {
  return new Date(Date.now() - DESKTOP_OFFLINE_IMAGE_CLEANUP_GRACE_MS).toISOString();
}

function isRecentOfflineImage(createdAt: string): boolean {
  const timestamp = Date.parse(createdAt);
  // Unknown timestamps are protected rather than deleted. All new writes use
  // ISO timestamps, but this keeps an old/corrupt row recoverable.
  return (
    !Number.isFinite(timestamp) ||
    Date.now() - timestamp < DESKTOP_OFFLINE_IMAGE_CLEANUP_GRACE_MS
  );
}

function imageContentType(response: Response, objectKey: string): string | null {
  const header = response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (header && DESKTOP_IMAGE_TYPES.has(header)) return header;
  const extension = objectKey.slice(objectKey.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "jpg") return "image/jpeg";
  const inferred = `image/${extension}`;
  return DESKTOP_IMAGE_TYPES.has(inferred) ? inferred : null;
}

async function selectOfflineImageByID(
  account: string,
  imageID: string,
): Promise<OfflineImageRow | null> {
  const db = await database();
  const rows = await db.select<OfflineImageRow[]>(`
    SELECT * FROM offline_images WHERE account_id = $1 AND image_id = $2
  `, [account, imageID]);
  return rows[0] ?? null;
}

async function selectOfflineImageByObjectKey(
  account: string,
  objectKey: string,
): Promise<OfflineImageRow | null> {
  const db = await database();
  const rows = await db.select<OfflineImageRow[]>(`
    SELECT * FROM offline_images WHERE account_id = $1 AND object_key = $2
  `, [account, objectKey]);
  return rows[0] ?? null;
}

async function selectOfflineImageIdentityByObjectKey(
  account: string,
  objectKey: string,
): Promise<OfflineImageIdentity | null> {
  const db = await database();
  const rows = await db.select<OfflineImageIdentity[]>(`
    SELECT image_id, object_key FROM offline_images
    WHERE account_id = $1 AND object_key = $2
    LIMIT 1
  `, [account, objectKey]);
  return rows[0] ?? null;
}

async function selectOfflineImageError(
  account: string,
  field: "image_id" | "object_key",
  value: string,
): Promise<string | null> {
  const db = await database();
  const rows = await db.select<{ last_error: string | null }[]>(`
    SELECT last_error FROM offline_images
    WHERE account_id = $1 AND ${field} = $2
    LIMIT 1
  `, [account, value]);
  return rows[0]?.last_error ?? null;
}

async function imageCacheSummaryForAccount(
  account: string,
): Promise<DesktopImageCacheSummary> {
  const db = await database();
  const rows = await db.select<{
    used_bytes: number;
    remote_cache_bytes: number;
    pending_local_bytes: number;
  }[]>(`
    SELECT
      COALESCE(SUM(byte_size), 0) AS used_bytes,
      COALESCE(SUM(CASE WHEN is_local_origin = 0 THEN byte_size ELSE 0 END), 0)
        AS remote_cache_bytes,
      COALESCE(SUM(CASE WHEN is_local_origin = 1 AND object_key IS NULL
        THEN byte_size ELSE 0 END), 0) AS pending_local_bytes
    FROM offline_images WHERE account_id = $1
  `, [account]);
  const maintenance = await imageMaintenanceState(account);
  return {
    usedBytes: Number(rows[0]?.used_bytes ?? 0),
    remoteCacheBytes: Number(rows[0]?.remote_cache_bytes ?? 0),
    pendingLocalBytes: Number(rows[0]?.pending_local_bytes ?? 0),
    remoteCacheLimitBytes: DESKTOP_REMOTE_IMAGE_CACHE_LIMIT_BYTES,
    maintenanceIssue: maintenance
      ? {
          attempts: maintenance.attempts,
          stages: maintenance.stages,
          nextRetryAt: maintenance.nextRetryAt,
        }
      : null,
  };
}

async function imageMaintenanceState(
  account: string,
): Promise<ImageMaintenanceState | null> {
  const db = await database();
  const rows = await db.select<{ value: string }[]>(`
    SELECT value FROM offline_meta
    WHERE account_id = $1 AND key = $2
    LIMIT 1
  `, [account, IMAGE_MAINTENANCE_META_KEY]);
  if (!rows[0]) return null;
  try {
    const state = JSON.parse(rows[0].value) as Partial<ImageMaintenanceState>;
    if (
      !Number.isInteger(state.attempts) ||
      Number(state.attempts) < 1 ||
      !Array.isArray(state.stages) ||
      typeof state.nextRetryAt !== "string" ||
      Number.isNaN(Date.parse(state.nextRetryAt))
    ) {
      return null;
    }
    return {
      attempts: Number(state.attempts),
      stages: state.stages.filter((stage): stage is string => typeof stage === "string"),
      errors: state.errors && typeof state.errors === "object" ? state.errors : {},
      lastFailedAt: typeof state.lastFailedAt === "string" ? state.lastFailedAt : "",
      nextRetryAt: state.nextRetryAt,
    };
  } catch {
    return null;
  }
}

function imageMaintenanceError(error: unknown): string {
  if (error instanceof RemoteHTTPError) {
    return error.code ?? `http_${error.status}`;
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim().slice(0, 200);
  }
  return "desktop_image_maintenance_failed";
}

class OfflineImageUploadError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OfflineImageUploadError";
  }
}

export async function desktopStoreLocalImage(file: File): Promise<UploadedImage> {
  if (!DESKTOP_IMAGE_TYPES.has(file.type) || file.size <= 0) {
    throw new Error("image_type_unsupported");
  }
  if (file.size > MAX_IMPORT_UPLOAD_IMAGE_BYTES) {
    throw new Error("image_too_large");
  }
  const account = await accountID();
  const imageID = crypto.randomUUID();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const base64Data = await storedLocalValue(account, bytesToBase64(bytes));
  const db = await database();
  await db.execute(`
    INSERT INTO offline_images (
      account_id, image_id, content_type, base64_data, byte_size,
      object_key, remote_url, created_at, last_error, is_local_origin
    ) VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6, NULL, 1)
  `, [
    account,
    imageID,
    file.type,
    base64Data,
    bytes.byteLength,
    new Date().toISOString(),
  ]);
  const localURL = desktopLocalImageURL(imageID);
  return {
    key: localURL,
    url: localURL,
    size: bytes.byteLength,
    contentType: file.type,
  };
}

export async function desktopResolveImageSource(
  source: string,
): Promise<string | null> {
  const account = await accountID();
  const localImageID = desktopLocalImageID(source);
  if (localImageID) {
    const row = await selectOfflineImageByID(account, localImageID);
    return row ? imageDataURL(await readableImageRow(account, row)) : null;
  }
  const objectKey = imageObjectKeyFromSource(source);
  if (!objectKey) {
    if (isLocalAccount(account) && isRemoteHTTPImageSource(source)) {
      return null;
    }
    return source;
  }
  const cached = await selectOfflineImageByObjectKey(account, objectKey);
  if (cached) return imageDataURL(await readableImageRow(account, cached));
  return isLocalAccount(account) ? null : source;
}

export async function desktopImageSyncError(source: string): Promise<string | null> {
  const account = await accountID();
  const localImageID = desktopLocalImageID(source);
  if (localImageID) {
    return selectOfflineImageError(account, "image_id", localImageID);
  }
  const objectKey = imageObjectKeyFromSource(source);
  if (!objectKey) return null;
  return selectOfflineImageError(account, "object_key", objectKey);
}

export async function desktopImageCacheSummary(): Promise<DesktopImageCacheSummary> {
  return imageCacheSummaryForAccount(await accountID());
}

export async function desktopClearRemoteImageCache(): Promise<DesktopImageCacheSummary> {
  return serializeImageCacheMutation(async () => {
    const account = await accountID();
    const db = await database();
    await db.execute(`
      DELETE FROM offline_images
      WHERE account_id = $1 AND is_local_origin = 0
    `, [account]);
    await db.execute(`
      INSERT INTO offline_meta (account_id, key, value)
      VALUES ($1, 'remote-image-cache-manual', '1')
      ON CONFLICT (account_id, key) DO UPDATE SET value = excluded.value
    `, [account]);
    remoteCacheFullAccounts.delete(account);
    return imageCacheSummaryForAccount(account);
  });
}

export async function desktopCacheRemoteImage(source: string): Promise<string> {
  const account = await accountID();
  if (isLocalAccount(account)) throw new Error("local_mode_network_disabled");
  return cacheRemoteImageForAccount(account, source);
}

async function cacheRemoteImageForAccount(
  account: string,
  source: string,
): Promise<string> {
  const objectKey = imageObjectKeyFromSource(source);
  if (!objectKey) return source;
  if (remoteCacheFullAccounts.has(account)) throw new Error("image_cache_full");
  const existing = await selectOfflineImageIdentityByObjectKey(account, objectKey);
  if (existing) return desktopLocalImageURL(existing.image_id);

  const response = await desktopFetch(imageFetchURL(source));
  if (!response.ok) throw new Error(`image_cache_${response.status}`);
  const contentLength = Number(response.headers.get("Content-Length") ?? 0);
  if (contentLength > MAX_IMPORT_UPLOAD_IMAGE_BYTES) {
    throw new Error("image_too_large");
  }
  const contentType = imageContentType(response, objectKey);
  if (!contentType) throw new Error("image_type_unsupported");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMPORT_UPLOAD_IMAGE_BYTES) {
    throw new Error("image_too_large");
  }

  const stored = await serializeImageCacheMutation(async () => {
    const concurrent = await selectOfflineImageIdentityByObjectKey(account, objectKey);
    if (concurrent) return concurrent;
    const usage = await imageCacheSummaryForAccount(account);
    if (usage.remoteCacheBytes + bytes.byteLength > DESKTOP_REMOTE_IMAGE_CACHE_LIMIT_BYTES) {
      remoteCacheFullAccounts.add(account);
      throw new Error("image_cache_full");
    }
    const imageID = crypto.randomUUID();
    const now = new Date().toISOString();
    const db = await database();
    await db.execute(`
      INSERT OR IGNORE INTO offline_images (
        account_id, image_id, content_type, base64_data, byte_size,
        object_key, remote_url, created_at, last_error, is_local_origin
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, 0)
    `, [
      account,
      imageID,
      contentType,
      bytesToBase64(bytes),
      bytes.byteLength,
      objectKey,
      source,
      now,
    ]);
    return selectOfflineImageIdentityByObjectKey(account, objectKey);
  });
  if (!stored) throw new Error("image_cache_failed");
  return desktopLocalImageURL(stored.image_id);
}

async function uploadOfflineImage(
  account: string,
  row: OfflineImageRow,
): Promise<string> {
  if (row.remote_url) {
    const replacedDocuments = await applyUploadedImageMapping(
      account,
      row.image_id,
      row.remote_url,
    );
    // Keep a recovered upload protected until its local placeholders have
    // been replaced in SQLite. This also repairs rows left half-finished by a
    // crash or a cache-clear action between the two writes.
    if (replacedDocuments > 0) {
      const db = await database();
      await db.execute(`
        UPDATE offline_images SET is_local_origin = 0, last_error = NULL
        WHERE account_id = $1 AND image_id = $2
      `, [account, row.image_id]);
    }
    return row.remote_url;
  }
  const bytes = base64ToBytes(row.base64_data);
  const response = await desktopFetch("/api/images", {
    method: "POST",
    headers: {
      "Content-Type": row.content_type,
      "X-Koinote-Image-Purpose": "persistent",
    },
    body: new Blob([bytes as BlobPart], { type: row.content_type }),
  });
  if (!response.ok) {
    let code = "image_upload_failed";
    try {
      const body = (await response.json()) as { code?: string };
      if (body.code) code = body.code;
    } catch {
      // 状态码仍可用于同步错误提示。
    }
    const db = await database();
    await db.execute(`
      UPDATE offline_images SET last_error = $3
      WHERE account_id = $1 AND image_id = $2
    `, [account, row.image_id, code]);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(DESKTOP_IMAGE_UPLOAD_FAILED_EVENT, {
        detail: { localURL: desktopLocalImageURL(row.image_id), code },
      }));
    }
    throw new OfflineImageUploadError(code);
  }
  const result = (await response.json()) as { image: UploadedImage };
  const db = await database();
  await db.execute(`
    UPDATE offline_images
    SET object_key = $3, remote_url = $4, last_error = NULL,
        is_local_origin = 1
    WHERE account_id = $1 AND image_id = $2
  `, [account, row.image_id, result.image.key, result.image.url]);
  const replacedDocuments = await applyUploadedImageMapping(
    account,
    row.image_id,
    result.image.url,
  );
  // The editor can still have the image only in its in-memory document while
  // the sync runs. Do not turn the only local copy into an evictable cache
  // entry until at least one persisted document has had its placeholder
  // replaced. The next sync will retry the mapping after the editor saves.
  if (replacedDocuments > 0) {
    await db.execute(`
      UPDATE offline_images SET is_local_origin = 0
      WHERE account_id = $1 AND image_id = $2
    `, [account, row.image_id]);
  }
  return result.image.url;
}

async function applyUploadedImageMapping(
  account: string,
  imageID: string,
  remoteURL: string,
): Promise<number> {
  const db = await database();
  const localURL = desktopLocalImageURL(imageID);
  const result = await db.execute(`
    UPDATE offline_documents
    SET content = replace(content, $2, $3),
        sync_state = CASE WHEN sync_state = 'clean' THEN 'update' ELSE sync_state END,
        change_seq = change_seq + 1,
        last_error = NULL
    WHERE account_id = $1 AND instr(content, $2) > 0
  `, [account, localURL, remoteURL]);
  if (result.rowsAffected > 0 && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(DESKTOP_IMAGE_UPLOADED_EVENT, {
      detail: { localURL, remoteURL },
    }));
  }
  return result.rowsAffected;
}

async function prepareDocumentContentForRemote(
  account: string,
  content: string,
): Promise<string> {
  const localSources = [...new Set(
    imageReferences(content).filter((source) => desktopLocalImageID(source)),
  )];
  if (localSources.length === 0) return content;
  const replacements = new Map<string, string>();
  const failures: OfflineImageUploadError[] = [];
  await forEachConcurrent(
    localSources,
    DESKTOP_IMAGE_CONCURRENCY,
    async (source) => {
      const imageID = desktopLocalImageID(source);
      if (!imageID) return;
      const row = await selectOfflineImageByID(account, imageID);
      if (!row) {
        failures.push(new OfflineImageUploadError("local_image_missing"));
        return;
      }
      try {
        replacements.set(source, await uploadOfflineImage(account, row));
      } catch (error) {
        if (!(error instanceof OfflineImageUploadError)) throw error;
        failures.push(error);
      }
    },
  );
  if (failures.length > 0) throw failures[0];
  return replaceDesktopLocalImageURLs(content, replacements);
}

async function cacheDocumentImages(account: string, content: string): Promise<void> {
  const remoteSources = [...new Set(
    imageReferences(content).filter((source) => imageObjectKeyFromSource(source)),
  )];
  await forEachConcurrent(
    remoteSources,
    DESKTOP_IMAGE_CONCURRENCY,
    async (source) => {
      const objectKey = imageObjectKeyFromSource(source);
      if (!objectKey || await selectOfflineImageIdentityByObjectKey(account, objectKey)) return;
      try {
        await cacheRemoteImageForAccount(account, source);
      } catch {
        // 远端文档本身仍要可用；缓存失败会在下一轮同步再次尝试。
      }
    },
  );
}

async function cacheAllDocumentImages(account: string): Promise<void> {
  const db = await database();
  const manual = await db.select<{ value: string }[]>(`
    SELECT value FROM offline_meta
    WHERE account_id = $1 AND key = 'remote-image-cache-manual'
  `, [account]);
  if (manual[0] || remoteCacheFullAccounts.has(account)) return;
  const usage = await imageCacheSummaryForAccount(account);
  if (
    usage.remoteCacheBytes >=
    DESKTOP_REMOTE_IMAGE_CACHE_LIMIT_BYTES - MAX_IMPORT_UPLOAD_IMAGE_BYTES
  ) return;
  const rows = await db.select<Pick<DocumentRow, "content">[]>(`
    SELECT content FROM offline_documents
    WHERE account_id = $1 AND sync_state <> 'trash'
  `, [account]);
  for (const row of rows) {
    await cacheDocumentImages(account, row.content);
  }
}

async function maintainOfflineImages(account: string): Promise<void> {
  const previous = await imageMaintenanceState(account);
  if (previous && Date.parse(previous.nextRetryAt) > Date.now()) return;

  const failures: Array<{ stage: string; error: unknown }> = [];
  for (const operation of [
    { stage: "cache", run: () => cacheAllDocumentImages(account) },
    { stage: "cleanup", run: () => cleanupUnusedOfflineImages(account) },
  ]) {
    try {
      await operation.run();
    } catch (error) {
      failures.push({ stage: operation.stage, error });
    }
  }

  const db = await database();
  if (failures.length === 0) {
    await db.execute(`
      DELETE FROM offline_meta WHERE account_id = $1 AND key = $2
    `, [account, IMAGE_MAINTENANCE_META_KEY]);
    return;
  }

  const attempts = (previous?.attempts ?? 0) + 1;
  const now = Date.now();
  const state: ImageMaintenanceState = {
    attempts,
    stages: failures.map((failure) => failure.stage),
    errors: Object.fromEntries(
      failures.map((failure) => [failure.stage, imageMaintenanceError(failure.error)]),
    ),
    lastFailedAt: new Date(now).toISOString(),
    nextRetryAt: new Date(now + desktopMaintenanceBackoff(attempts)).toISOString(),
  };
  await db.execute(`
    INSERT INTO offline_meta (account_id, key, value) VALUES ($1, $2, $3)
    ON CONFLICT (account_id, key) DO UPDATE SET value = excluded.value
  `, [account, IMAGE_MAINTENANCE_META_KEY, JSON.stringify(state)]);
  console.warn("Desktop image maintenance delayed", state);
}

export async function desktopReleaseUnusedImages(sources: string[]): Promise<void> {
  const account = await accountID();
  const imageIDs = [...new Set(
    sources.map(desktopLocalImageID).filter((value): value is string => Boolean(value)),
  )];
  if (imageIDs.length === 0) return;
  const db = await database();
  const cutoff = offlineImageCleanupCutoff();
  if (isLocalAccount(account)) {
    const referenced = await localReferencedImageIDs(account);
    for (const imageID of imageIDs) {
      if (referenced.has(imageID)) continue;
      await db.execute(`
        DELETE FROM offline_images
        WHERE account_id = $1 AND image_id = $2 AND created_at < $3
      `, [account, imageID, cutoff]);
    }
    return;
  }
  for (const imageID of imageIDs) {
    await db.execute(`
      DELETE FROM offline_images
      WHERE account_id = $1 AND image_id = $2
        AND created_at < $4
        AND NOT EXISTS (
          SELECT 1 FROM offline_documents d
          WHERE d.account_id = $1
            AND (
              instr(d.content, $3 || offline_images.image_id) > 0 OR
              instr(d.remote_snapshot, $3 || offline_images.image_id) > 0
            )
        )
    `, [account, imageID, "koinote-local-image://", cutoff]);
  }
}

async function localReferencedImageIDs(account: string): Promise<Set<string>> {
  const db = await database();
  const rows = await db.select<Array<Pick<DocumentRow, "content">>>(`
    SELECT content FROM offline_documents WHERE account_id = $1
  `, [account]);
  const contents = await Promise.all(
    rows.map((row) => decryptDesktopLocalValue(row.content)),
  );
  return new Set(
    contents.flatMap((content) =>
      imageReferences(content)
        .map(desktopLocalImageID)
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

async function cleanupUnusedOfflineImages(account: string): Promise<void> {
  const db = await database();
  const cutoff = offlineImageCleanupCutoff();
  if (isLocalAccount(account)) {
    const [images, referenced] = await Promise.all([
      db.select<Array<OfflineImageIdentity & Pick<OfflineImageRow, "created_at">>>(`
        SELECT image_id, object_key, created_at FROM offline_images WHERE account_id = $1
      `, [account]),
      localReferencedImageIDs(account),
    ]);
    for (const image of images) {
      if (referenced.has(image.image_id) || isRecentOfflineImage(image.created_at)) {
        continue;
      }
      await db.execute(`
        DELETE FROM offline_images WHERE account_id = $1 AND image_id = $2
      `, [account, image.image_id]);
    }
    return;
  }
  const rows = await db.select<OfflineImageIdentity[]>(`
    SELECT i.image_id, i.object_key FROM offline_images i
    WHERE i.account_id = $1
      -- Pending local-origin images are the only copy of the user's file.
      -- Automatic cache maintenance must never reclaim them before the
      -- document upload has a chance to finish.
      AND i.is_local_origin = 0
      AND i.created_at < $3
      AND NOT EXISTS (
        SELECT 1 FROM offline_documents d
        WHERE d.account_id = $1 AND (
          instr(d.content, $2 || i.image_id) > 0 OR
          instr(d.remote_snapshot, $2 || i.image_id) > 0 OR
          (i.object_key IS NOT NULL AND (
            instr(d.content, i.object_key) > 0 OR
            instr(d.remote_snapshot, i.object_key) > 0
          ))
        )
      )
  `, [account, "koinote-local-image://", cutoff]);
  const releasedKeys: string[] = [];
  for (const row of rows) {
    // The candidate SELECT and this DELETE are separated by arbitrary work
    // (including the next candidate). Re-check references at deletion time so
    // an editor save that races cleanup cannot lose its image row.
    const result = await db.execute(`
      DELETE FROM offline_images
      WHERE account_id = $1 AND image_id = $2
        AND is_local_origin = 0
        AND NOT EXISTS (
          SELECT 1 FROM offline_documents d
          WHERE d.account_id = $1 AND (
            instr(d.content, $3 || offline_images.image_id) > 0 OR
            instr(d.remote_snapshot, $3 || offline_images.image_id) > 0 OR
            (offline_images.object_key IS NOT NULL AND (
              instr(d.content, offline_images.object_key) > 0 OR
              instr(d.remote_snapshot, offline_images.object_key) > 0
            ))
          )
        )
    `, [account, row.image_id, "koinote-local-image://"]);
    if (result.rowsAffected === 1 && row.object_key) {
      releasedKeys.push(row.object_key);
    }
  }
  if (releasedKeys.length > 0) {
    await remoteJSON("/api/storage/release-images", {
      method: "POST",
      body: JSON.stringify({ keys: releasedKeys }),
    });
  }
  if (releasedKeys.length > 0) {
    remoteCacheFullAccounts.delete(account);
  }
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
  const storedRows = await db.select<DocumentRow[]>(`
    SELECT * FROM offline_documents
    WHERE account_id = $1 AND sync_state <> 'trash'
    ORDER BY COALESCE(updated_at, '') DESC, doc_id DESC
  `, [account]);
  const rows = await Promise.all(
    storedRows.map((row) => readableDocumentRow(account, row)),
  );
  return {
    documents: rows.map((row) => ({
      docId: row.doc_id,
      title: row.title,
      folderId: row.folder_id,
      revision: row.local_revision,
      createdAt: row.created_at,
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
  const storedRows = isLocalAccount(account)
    ? await db.select<DocumentRow[]>(`
        SELECT * FROM offline_documents
        WHERE account_id = $1 AND sync_state <> 'trash'
        ORDER BY COALESCE(updated_at, '') DESC
      `, [account])
    : await db.select<DocumentRow[]>(`
        SELECT * FROM offline_documents
        WHERE account_id = $1 AND sync_state <> 'trash'
          AND (instr(lower(title), $2) > 0 OR instr(lower(content), $2) > 0)
        ORDER BY COALESCE(updated_at, '') DESC
        LIMIT $3
      `, [account, normalized, limit]);
  const readableRows = await Promise.all(
    storedRows.map((row) => readableDocumentRow(account, row)),
  );
  const rows = readableRows
    .filter((row) =>
      row.title.toLocaleLowerCase().includes(normalized) ||
      row.content.toLocaleLowerCase().includes(normalized),
    )
    .slice(0, limit);
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
  if (row && row.sync_state !== "trash") {
    if (!isLocalAccount(account) && navigator.onLine) {
      void cacheDocumentImages(account, row.content);
    }
    return { document: rowToDocument(row) };
  }

  if (isLocalAccount(account)) throw new Error("Document not found");

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
    const local = isLocalAccount(account);
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
    const [storedTitle, storedTheme, storedContent] = await Promise.all([
      storedLocalValue(account, document.title),
      storedLocalValue(account, document.theme),
      storedLocalValue(account, document.content),
    ]);
    await db.execute(`
      INSERT INTO offline_documents (
        account_id, doc_id, title, theme, content, folder_id,
        local_revision, base_revision, created_at, updated_at, share_json,
        sync_state, change_seq
      ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $8, NULL, $9, 1)
    `, [
      account, document.docId, storedTitle, storedTheme, storedContent,
      params?.folderId ?? null, local ? 1 : 0, now, local ? "clean" : "create",
    ]);
    if (!local) scheduleSync();
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
    const local = isLocalAccount(account);
    const [storedTitle, storedContent, storedTheme] = await Promise.all([
      storedLocalValue(account, params.title.trim()),
      storedLocalValue(account, params.content),
      params.theme === undefined
        ? Promise.resolve<string | null>(null)
        : storedLocalValue(account, params.theme),
    ]);
    const result = await db.execute(`
      UPDATE offline_documents
      SET title = $3, content = $4,
          theme = CASE WHEN $5 IS NULL THEN theme ELSE $5 END,
          local_revision = local_revision + 1,
          updated_at = $6,
          sync_state = CASE
            WHEN $8 = 1 THEN 'clean'
            WHEN sync_state = 'create' THEN 'create'
            ELSE 'update'
          END,
          change_seq = change_seq + 1,
          remote_snapshot = NULL,
          last_error = NULL
      WHERE account_id = $1 AND doc_id = $2
        AND (
          local_revision = $7
          OR (sync_state = 'clean' AND base_revision = $7 AND base_revision > 0)
        )
        AND sync_state <> 'trash'
    `, [
      account, docId, storedTitle, storedContent, storedTheme, now,
      params.expectedRevision, local ? 1 : 0,
    ]);
    if (result.rowsAffected !== 1) throw new Error("document_revision_conflict");
    const row = await selectDocument(account, docId);
    if (!row) throw new Error("Document not found");
    if (!local) scheduleDocumentSync();
    return { document: rowToDocument(row) };
  });
}

export async function desktopPrepareDocumentForRemoteMutation(docId: string): Promise<boolean> {
  if (isDesktopLocalModeSelected()) return false;
  await syncDesktopNow({ silent: true, force: true });
  const account = await accountID();
  const row = await selectDocument(account, docId);
  return Boolean(row && canRunRemoteDocumentMutation({
    baseRevision: row.base_revision,
    syncState: row.sync_state,
  }));
}

export async function desktopAcceptDocumentShare(
  docId: string,
  share: NonNullable<Document["share"]> | null,
): Promise<void> {
  return serializeMutation(async () => {
    const account = await accountID();
    if (isLocalAccount(account)) throw new Error("local_mode_network_disabled");
    const persistedShare = share
      ? {
          token: share.token,
          access: share.access,
          requiresPassword: share.requiresPassword,
          viewCount: share.viewCount,
        }
      : null;
    const db = await database();
    const result = await db.execute(`
      UPDATE offline_documents
      SET share_json = $3, change_seq = change_seq + 1
      WHERE account_id = $1 AND doc_id = $2 AND sync_state <> 'trash'
    `, [account, docId, persistedShare ? JSON.stringify(persistedShare) : null]);
    if (result.rowsAffected !== 1) throw new Error("Document not found");
  });
}

export async function desktopAcceptRemoteDocumentMutation(
  document: Document,
): Promise<{ document: Document }> {
  return serializeMutation(async () => {
    const account = await accountID();
    if (isLocalAccount(account)) throw new Error("local_mode_network_disabled");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const local = await selectDocument(account, document.docId);
      if (!local) throw new Error("Document not found");
      const matchesRemote =
        local.base_revision === document.revision &&
        local.title === document.title &&
        local.theme === document.theme &&
        local.content === document.content;
      if (matchesRemote) return { document: rowToDocument(local) };
      if (!canRunRemoteDocumentMutation({
        baseRevision: local.base_revision,
        syncState: local.sync_state,
      })) {
        throw new Error("document_revision_conflict");
      }
      if (await replaceDocumentFromRemote(account, local, document, local.folder_id)) {
        const accepted = await selectDocument(account, document.docId);
        if (!accepted) throw new Error("Document not found");
        return { document: rowToDocument(accepted) };
      }
    }
    throw new Error("document_revision_conflict");
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
    if (!isLocalAccount(account)) scheduleSync();
    return { success: true };
  });
}

export async function desktopPermanentlyDeleteDocument(
  docId: string,
  confirmation: string,
): Promise<{ success: boolean }> {
  return serializeMutation(async () => {
    const account = await accountID();
    const db = await database();
    const local = isLocalAccount(account);
    if (!local) {
      try {
        await remoteJSON(`/api/documents/${encodeURIComponent(docId)}/permanent`, {
          method: "DELETE",
          body: JSON.stringify({ confirmation }),
        });
      } catch (error) {
        if (!(error instanceof RemoteHTTPError) || error.status !== 404) throw error;
      }
    }
    await db.execute(`
      DELETE FROM offline_documents WHERE account_id = $1 AND doc_id = $2
    `, [account, docId]);
    try {
      await cleanupUnusedOfflineImages(account);
    } catch {}
    if (!local) scheduleSync(0);
    return { success: true };
  });
}

export async function desktopListLocalTrashedDocuments(): Promise<{
  documents: TrashedDocumentSummary[];
}> {
  const account = await accountID();
  if (!isLocalAccount(account)) throw new Error("local_mode_required");
  const db = await database();
  const storedRows = await db.select<DocumentRow[]>(`
    SELECT * FROM offline_documents
    WHERE account_id = $1 AND sync_state = 'trash'
    ORDER BY COALESCE(updated_at, '') DESC, doc_id DESC
  `, [account]);
  const rows = await Promise.all(
    storedRows.map((row) => readableDocumentRow(account, row)),
  );
  return {
    documents: rows.map((row) => ({
      docId: row.doc_id,
      title: row.title,
      revision: row.local_revision,
      trashedAt: row.updated_at ?? new Date(0).toISOString(),
      deletesAt: "9999-12-31T23:59:59.999Z",
    })),
  };
}

export async function desktopRestoreLocalTrashedDocument(
  docId: string,
): Promise<{ document: Document }> {
  return serializeMutation(async () => {
    const account = await accountID();
    if (!isLocalAccount(account)) throw new Error("local_mode_required");
    const db = await database();
    const result = await db.execute(`
      UPDATE offline_documents
      SET sync_state = 'clean', local_revision = local_revision + 1,
          change_seq = change_seq + 1, updated_at = $3, last_error = NULL
      WHERE account_id = $1 AND doc_id = $2 AND sync_state = 'trash'
    `, [account, docId, new Date().toISOString()]);
    if (result.rowsAffected !== 1) throw new Error("Document not found");
    const row = await selectDocument(account, docId);
    if (!row) throw new Error("Document not found");
    return { document: rowToDocument(row) };
  });
}

export async function desktopLocalImportSummary(): Promise<DesktopLocalImportSummary> {
  if (isDesktopLocalModeSelected()) {
    return { documents: 0, folders: 0, images: 0 };
  }
  await serializeMutation(() => invoke("desktop_abort_local_mode_import", {
    request: { stagingAccount: null },
  }));
  const db = await database();
  const rows = await db.select<DesktopLocalImportSummary[]>(`
    SELECT
      (SELECT COUNT(*) FROM offline_documents
       WHERE account_id = $1 AND sync_state <> 'trash') AS documents,
      (SELECT COUNT(*) FROM offline_folders
       WHERE account_id = $1 AND sync_state <> 'delete') AS folders,
      (SELECT COUNT(*) FROM offline_images
       WHERE account_id = $1 AND is_local_origin = 1) AS images
  `, [DESKTOP_LOCAL_ACCOUNT_ID]);
  return {
    documents: Number(rows[0]?.documents ?? 0),
    folders: Number(rows[0]?.folders ?? 0),
    images: Number(rows[0]?.images ?? 0),
  };
}

export async function desktopImportLocalMode(
  password: string,
): Promise<DesktopLocalImportSummary> {
  const key = await verifyDesktopLocalModePassword(password);
  return serializeMutation(async () => {
    const targetAccount = await accountID();
    if (isLocalAccount(targetAccount)) throw new Error("account_mode_required");
    const db = await database();
    await invoke("desktop_abort_local_mode_import", {
      request: { stagingAccount: null },
    });
    const stagingAccount = `local-import:${crypto.randomUUID()}`;
    const folderIDs = new Map<string, string>();
    const referencedImageIDs = new Set<string>();
    const imageURLs = new Map<string, string>();
    const now = new Date().toISOString();
    let documentCount = 0;

    try {
      let afterFolderID = "";
      while (true) {
        const rows = await db.select<Array<{ folder_id: string }>>(`
          SELECT folder_id FROM offline_folders
          WHERE account_id = $1 AND sync_state <> 'delete' AND folder_id > $2
          ORDER BY folder_id
          LIMIT $3
        `, [DESKTOP_LOCAL_ACCOUNT_ID, afterFolderID, LOCAL_IMPORT_FOLDER_BATCH_SIZE]);
        if (rows.length === 0) break;
        for (const row of rows) folderIDs.set(row.folder_id, crypto.randomUUID());
        afterFolderID = rows.at(-1)!.folder_id;
      }

      let afterDocumentID = "";
      while (true) {
        const rows = await db.select<DocumentRow[]>(`
          SELECT * FROM offline_documents
          WHERE account_id = $1 AND sync_state <> 'trash' AND doc_id > $2
          ORDER BY doc_id
          LIMIT $3
        `, [DESKTOP_LOCAL_ACCOUNT_ID, afterDocumentID, LOCAL_IMPORT_DOCUMENT_BATCH_SIZE]);
        if (rows.length === 0) break;
        for (const storedDocument of rows) {
          const document = await readableDocumentRow(
            DESKTOP_LOCAL_ACCOUNT_ID,
            storedDocument,
            key,
          );
          documentCount += 1;
          for (const reference of imageReferences(document.content)) {
            const imageID = desktopLocalImageID(reference);
            if (imageID) referencedImageIDs.add(imageID);
          }
        }
        afterDocumentID = rows.at(-1)!.doc_id;
      }

      afterFolderID = "";
      while (true) {
        const storedFolders = await db.select<FolderRow[]>(`
          SELECT * FROM offline_folders
          WHERE account_id = $1 AND sync_state <> 'delete' AND folder_id > $2
          ORDER BY folder_id
          LIMIT $3
        `, [DESKTOP_LOCAL_ACCOUNT_ID, afterFolderID, LOCAL_IMPORT_FOLDER_BATCH_SIZE]);
        if (storedFolders.length === 0) break;
        const folders = [];
        for (const storedFolder of storedFolders) {
          const folder = await readableFolderRow(
            DESKTOP_LOCAL_ACCOUNT_ID,
            storedFolder,
            key,
          );
          folders.push({
            folderId: folderIDs.get(folder.folder_id)!,
            name: folder.name,
            parentFolderId: folder.parent_folder_id
              ? folderIDs.get(folder.parent_folder_id) ?? null
              : null,
            organizerKind: folder.organizer_kind,
          });
        }
        const batch: DesktopLocalImportBatch = {
          stagingAccount,
          folders,
          images: [],
          documents: [],
        };
        await invoke("desktop_import_local_mode", { batch });
        afterFolderID = storedFolders.at(-1)!.folder_id;
      }

      for (const imageID of referencedImageIDs) {
        const storedImage = await selectOfflineImageByID(DESKTOP_LOCAL_ACCOUNT_ID, imageID);
        if (!storedImage) throw new Error("local_image_missing");
        const image = await readableImageRow(DESKTOP_LOCAL_ACCOUNT_ID, storedImage, key);
        const nextImageID = crypto.randomUUID();
        imageURLs.set(
          desktopLocalImageURL(image.image_id),
          desktopLocalImageURL(nextImageID),
        );
        const batch: DesktopLocalImportBatch = {
          stagingAccount,
          folders: [],
          images: [{
            imageId: nextImageID,
            contentType: image.content_type,
            base64Data: image.base64_data,
            byteSize: image.byte_size,
            createdAt: now,
          }],
          documents: [],
        };
        await invoke("desktop_import_local_mode", { batch });
      }

      afterDocumentID = "";
      while (true) {
        const storedDocuments = await db.select<DocumentRow[]>(`
          SELECT * FROM offline_documents
          WHERE account_id = $1 AND sync_state <> 'trash' AND doc_id > $2
          ORDER BY doc_id
          LIMIT $3
        `, [DESKTOP_LOCAL_ACCOUNT_ID, afterDocumentID, LOCAL_IMPORT_DOCUMENT_BATCH_SIZE]);
        if (storedDocuments.length === 0) break;
        const documents: DesktopLocalImportBatch["documents"] = [];
        for (const storedDocument of storedDocuments) {
          const document = await readableDocumentRow(
            DESKTOP_LOCAL_ACCOUNT_ID,
            storedDocument,
            key,
          );
          documents.push({
              docId: crypto.randomUUID(),
              title: document.title,
              theme: document.theme,
              content: replaceDesktopLocalImageURLs(document.content, imageURLs),
              folderId: document.folder_id
                ? folderIDs.get(document.folder_id) ?? null
                : null,
              createdAt: now,
          });
        }
        const batch: DesktopLocalImportBatch = {
          stagingAccount,
          folders: [],
          images: [],
          documents,
        };
        await invoke("desktop_import_local_mode", { batch });
        afterDocumentID = storedDocuments.at(-1)!.doc_id;
      }

      await invoke("desktop_finalize_local_mode_import", {
        request: { stagingAccount, targetAccount },
      });
    } catch (error) {
      try {
        await invoke("desktop_abort_local_mode_import", {
          request: { stagingAccount },
        });
      } catch {}
      throw error;
    }
    if (documentCount > 0 || folderIDs.size > 0) scheduleSync(0);
    return {
      documents: documentCount,
      folders: folderIDs.size,
      images: referencedImageIDs.size,
    };
  });
}

export async function desktopListFolders(): Promise<{ folders: Folder[] }> {
  const account = await accountID();
  await ensureInitialSnapshot(account);
  const db = await database();
  const storedRows = await db.select<FolderRow[]>(`
    SELECT * FROM offline_folders
    WHERE account_id = $1 AND sync_state <> 'delete'
    ORDER BY name, folder_id
  `, [account]);
  const rows = await Promise.all(
    storedRows.map((row) => readableFolderRow(account, row)),
  );
  if (isLocalAccount(account)) rows.sort((left, right) => left.name.localeCompare(right.name));
  return { folders: rows.map(rowToFolder) };
}

export async function desktopCreateFolder(params: {
  name: string;
  parentFolderId: string | null;
  organizerKind?: Folder["organizerKind"];
}): Promise<{ folder: Folder; created: boolean }> {
  return serializeMutation(async () => {
    const account = await accountID();
    const db = await database();
    const local = isLocalAccount(account);
    const folder: Folder = {
      folderId: crypto.randomUUID(),
      name: params.name.trim(),
      parentFolderId: params.parentFolderId,
      organizerKind: params.organizerKind ?? null,
    };
    const storedName = await storedLocalValue(account, folder.name);
    await db.execute(`
      INSERT INTO offline_folders (
        account_id, folder_id, name, parent_folder_id, organizer_kind,
        sync_state, change_seq
      ) VALUES ($1, $2, $3, $4, $5, $6, 1)
    `, [
      account, folder.folderId, storedName, folder.parentFolderId,
      folder.organizerKind,
      local ? "clean" : "create",
    ]);
    if (!local) scheduleSync();
    return { folder, created: true };
  });
}

export async function desktopRenameFolder(folderId: string, name: string): Promise<{ folder: Folder }> {
  const account = await accountID();
  await mutateFolder(folderId, `name = $3`, [await storedLocalValue(account, name.trim())]);
  const db = await database();
  const rows = await db.select<FolderRow[]>(`
    SELECT * FROM offline_folders WHERE account_id = $1 AND folder_id = $2
  `, [account, folderId]);
  if (!rows[0]) throw new Error("Folder not found");
  return { folder: rowToFolder(await readableFolderRow(account, rows[0])) };
}

export async function desktopMoveFolder(folderId: string, parentFolderId: string | null) {
  return mutateFolder(folderId, `parent_folder_id = $3`, [parentFolderId]);
}

async function mutateFolder(folderId: string, assignment: string, values: unknown[]) {
  return serializeMutation(async () => {
    const account = await accountID();
    const db = await database();
    const local = isLocalAccount(account);
    await db.execute(`
      UPDATE offline_folders SET ${assignment},
        sync_state = CASE
          WHEN $${values.length + 3} = 1 THEN 'clean'
          WHEN sync_state = 'create' THEN 'create'
          ELSE 'update'
        END,
        change_seq = change_seq + 1, remote_snapshot = NULL, last_error = NULL
      WHERE account_id = $1 AND folder_id = $2 AND sync_state <> 'delete'
    `, [account, folderId, ...values, local ? 1 : 0]);
    if (!local) scheduleSync();
    return { ok: true };
  });
}

export async function desktopDeleteFolder(folderId: string) {
  return serializeMutation(async () => {
    const account = await accountID();
    const db = await database();
    const local = isLocalAccount(account);
    const rows = await db.select<FolderRow[]>(`
      SELECT * FROM offline_folders WHERE account_id = $1 AND folder_id = $2
    `, [account, folderId]);
    const folder = rows[0];
    if (!folder) return { ok: true };
    await db.execute(`
      UPDATE offline_documents
      SET folder_id = $3, folder_dirty = $4, change_seq = change_seq + 1
      WHERE account_id = $1 AND folder_id = $2 AND sync_state <> 'trash'
    `, [account, folderId, folder.parent_folder_id, local ? 0 : 1]);
    await db.execute(`
      UPDATE offline_folders SET parent_folder_id = $3,
        sync_state = CASE
          WHEN $4 = 1 THEN 'clean'
          WHEN sync_state = 'create' THEN 'create'
          ELSE 'update'
        END,
        change_seq = change_seq + 1
      WHERE account_id = $1 AND parent_folder_id = $2 AND sync_state <> 'delete'
    `, [account, folderId, folder.parent_folder_id, local ? 1 : 0]);
    if (local || folder.sync_state === "create") {
      await db.execute(`DELETE FROM offline_folders WHERE account_id = $1 AND folder_id = $2`, [account, folderId]);
    } else {
      await db.execute(`
        UPDATE offline_folders SET sync_state = 'delete', change_seq = change_seq + 1
        WHERE account_id = $1 AND folder_id = $2
      `, [account, folderId]);
    }
    if (!local) scheduleSync();
    return { ok: true };
  });
}

export async function desktopDeleteEmptyOrganizerFolder(folderId: string) {
  return serializeMutation(async () => {
    const account = await accountID();
    const db = await database();
    const local = isLocalAccount(account);
    const rows = await db.select<FolderRow[]>(`
      SELECT * FROM offline_folders
      WHERE account_id = $1 AND folder_id = $2 AND sync_state <> 'delete'
    `, [account, folderId]);
    const folder = rows[0];
    if (!folder?.organizer_kind) return { deleted: false };

    const occupied = await db.select<Array<{ occupied: number }>>(`
      SELECT EXISTS (
        SELECT 1 FROM offline_folders
        WHERE account_id = $1 AND parent_folder_id = $2 AND sync_state <> 'delete'
        UNION ALL
        SELECT 1 FROM offline_documents
        WHERE account_id = $1 AND folder_id = $2
      ) AS occupied
    `, [account, folderId]);
    if (Number(occupied[0]?.occupied ?? 0) !== 0) return { deleted: false };

    if (local || folder.sync_state === "create") {
      const result = await db.execute(`
        DELETE FROM offline_folders
        WHERE account_id = $1 AND folder_id = $2 AND organizer_kind IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM offline_folders child
            WHERE child.account_id = $1 AND child.parent_folder_id = $2
              AND child.sync_state <> 'delete'
          )
          AND NOT EXISTS (
            SELECT 1 FROM offline_documents document
            WHERE document.account_id = $1 AND document.folder_id = $2
          )
      `, [account, folderId]);
      return { deleted: result.rowsAffected === 1 };
    }

    const result = await db.execute(`
      UPDATE offline_folders
      SET sync_state = 'delete', change_seq = change_seq + 1,
          last_error = 'organizer_empty_delete'
      WHERE account_id = $1 AND folder_id = $2
        AND organizer_kind IS NOT NULL AND sync_state <> 'delete'
        AND NOT EXISTS (
          SELECT 1 FROM offline_folders child
          WHERE child.account_id = $1 AND child.parent_folder_id = $2
            AND child.sync_state <> 'delete'
        )
        AND NOT EXISTS (
          SELECT 1 FROM offline_documents document
          WHERE document.account_id = $1 AND document.folder_id = $2
        )
    `, [account, folderId]);
    if (result.rowsAffected === 1) scheduleSync();
    return { deleted: result.rowsAffected === 1 };
  });
}

export async function desktopMoveDocument(docId: string, folderId: string | null) {
  return serializeMutation(async () => {
    const account = await accountID();
    const db = await database();
    const local = isLocalAccount(account);
    await db.execute(`
      UPDATE offline_documents
      SET folder_id = $3, folder_dirty = $4, change_seq = change_seq + 1
      WHERE account_id = $1 AND doc_id = $2 AND sync_state <> 'trash'
    `, [account, docId, folderId, local ? 0 : 1]);
    if (!local) scheduleSync();
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
    const value = isLocalAccount(account)
      ? await decryptDesktopLocalValue(rows[0].value)
      : rows[0].value;
    return JSON.parse(value) as EditorTabs;
  } catch {
    return { tabs: [], activeDocId: null };
  }
}

export async function desktopPutEditorTabs(value: EditorTabs): Promise<EditorTabs> {
  const account = await accountID();
  const db = await database();
  const storedValue = await storedLocalValue(account, JSON.stringify(value));
  await db.execute(`
    INSERT INTO offline_meta (account_id, key, value) VALUES ($1, 'editor-tabs', $2)
    ON CONFLICT (account_id, key) DO UPDATE SET value = excluded.value
  `, [account, storedValue]);
  return value;
}

export function syncDesktopNow(options: { silent?: boolean; force?: boolean } = {}): Promise<DesktopSyncSummary> {
  if (isDesktopLocalModeSelected()) {
    return Promise.resolve({
      state: "idle",
      pending: 0,
      conflicts: 0,
      lastSyncedAt: null,
    });
  }
  if (!options.force) {
    const remaining = documentSyncIdleRemaining();
    if (remaining > 0) {
      scheduleSync(remaining);
      return desktopSyncSummary();
    }
  }
  if (syncPromise) return syncPromise;
  syncPromise = performPreparedSync(options).finally(() => {
    syncPromise = null;
    if (syncQueuedAfterCurrent) {
      syncQueuedAfterCurrent = false;
      scheduleSync(0);
    }
  });
  return syncPromise;
}

export async function desktopSyncSummary(): Promise<DesktopSyncSummary> {
  const account = await accountID();
  if (isLocalAccount(account)) {
    return { state: "idle", pending: 0, conflicts: 0, lastSyncedAt: null };
  }
  const summary = await calculateSummary(account, "idle");
  return summary.message ? { ...summary, state: "error" } : summary;
}

export async function desktopReportSyncError(message: string): Promise<void> {
  const account = await accountID();
  notify(await calculateSummary(account, "error", message));
}

export async function desktopListConflicts(): Promise<DesktopConflict[]> {
  const account = await accountID();
  if (isLocalAccount(account)) return [];
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
      await cacheDocumentImages(account, remote.content);
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
  syncQueuedAfterCurrent = false;
  const activeSync = syncPromise;
  if (activeSync) await activeSync.catch(() => undefined);
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  syncQueuedAfterCurrent = false;
  lastDocumentMutationAt = 0;
  const db = await database();
  await db.execute(`DELETE FROM offline_documents WHERE account_id = $1`, [account]);
  await db.execute(`DELETE FROM offline_folders WHERE account_id = $1`, [account]);
  await db.execute(`DELETE FROM offline_meta WHERE account_id = $1`, [account]);
  await db.execute(`DELETE FROM offline_images WHERE account_id = $1`, [account]);
  remoteCacheFullAccounts.delete(account);
  snapshotInitializations.delete(account);
}

async function ensureInitialSnapshot(account: string): Promise<void> {
  if (isLocalAccount(account)) return;
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

function scheduleDocumentSync() {
  lastDocumentMutationAt = Date.now();
  scheduleSync(DESKTOP_DOCUMENT_SYNC_IDLE_MS);
}

function documentSyncIdleRemaining() {
  if (lastDocumentMutationAt <= 0) return 0;
  return Math.max(
    0,
    DESKTOP_DOCUMENT_SYNC_IDLE_MS - (Date.now() - lastDocumentMutationAt),
  );
}

function scheduleSync(delay = 1500) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    // 图片上传会让一轮同步持续数秒。期间若用户继续编辑，保存完成后安排的
    // 下一轮定时器可能先到；直接调用 syncDesktopNow 只会拿到旧 Promise，
    // 这次新改动便失去唤醒，只能等周期轮询或用户手动重试。
    if (syncPromise) {
      syncQueuedAfterCurrent = true;
      return;
    }
    void syncDesktopNow();
  }, delay);
}

async function performPreparedSync(options: { silent?: boolean }): Promise<DesktopSyncSummary> {
  const account = await accountID();
  if (!(await prepareDesktopSync())) {
    const summary = await calculateSummary(account, "error", "document_save_pending");
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
    const outcome = await runDesktopSyncSequence({
      pushFolders: () => pushFolders(account),
      pushDocuments: () => pushDocuments(account),
      pullRemoteSnapshot: () => pullRemoteSnapshot(account),
      maintain: () => maintainOfflineImages(account),
      recordSuccess: async () => {
        const db = await database();
        const now = new Date().toISOString();
        await db.execute(`
          INSERT INTO offline_meta (account_id, key, value) VALUES ($1, 'last-synced-at', $2)
          ON CONFLICT (account_id, key) DO UPDATE SET value = excluded.value
        `, [account, now]);
      },
      reportMaintenanceFailure: (error) => {
        console.warn("Desktop image maintenance state could not be saved", error);
      },
    });
    const summary = await calculateSummary(
      account,
      outcome.state,
      outcome.message,
    );
    notify(summary);
    return summary;
  } catch (error) {
    const offline = !navigator.onLine;
    const message = error instanceof RemoteHTTPError
      ? error.code ?? `http_${error.status}`
      : error instanceof Error
        ? error.message
        : "desktop_sync_failed";
    const summary = await calculateSummary(
      account,
      offline ? "offline" : "error",
      message,
    );
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
      const result = await remoteJSON<{ folder: Folder; created?: boolean }>("/api/folders", {
        method: "POST",
        body: JSON.stringify({
          folderId: row.folder_id,
          name: row.name,
          parentFolderId: row.parent_folder_id,
          organizerKind: row.organizer_kind,
        }),
      });
      if (result.folder.folderId === row.folder_id) {
        await acknowledgeFolder(account, row, result.folder);
      } else {
        await reconcileFolderIdentity(account, row, result.folder);
      }
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
      if (row.last_error === "organizer_empty_delete") {
        const result = await remoteJSON<{ deleted: boolean; found?: boolean }>(
          `/api/folders/${encodeURIComponent(row.folder_id)}/empty`,
          { method: "DELETE" },
        );
        if (!result.deleted && result.found !== false) continue;
      } else {
        await remoteJSON(`/api/folders/${encodeURIComponent(row.folder_id)}`, { method: "DELETE" });
      }
    } catch (error) {
      if (!(error instanceof RemoteHTTPError) || error.status !== 404) throw error;
    }
    await db.execute(`DELETE FROM offline_folders WHERE account_id = $1 AND folder_id = $2`, [account, row.folder_id]);
  }
}

async function pushDocuments(account: string): Promise<string[]> {
  const db = await database();
  const imageUploadIssues: string[] = [];
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
      const remoteContent = await prepareDocumentContentForRemote(account, row.content);
      const remoteRow = { ...row, content: remoteContent };
      let remote: Document | null = null;
      if (row.sync_state === "create") {
        remote = (await remoteJSON<{ document: Document }>("/api/documents", {
          method: "POST",
          body: JSON.stringify({
            docId: row.doc_id, title: row.title, theme: row.theme,
            content: remoteRow.content, folderId: row.folder_id,
          }),
        })).document;
      } else if (row.sync_state === "update") {
        try {
          remote = (await remoteJSON<{ document: Document }>(`/api/documents/${encodeURIComponent(row.doc_id)}`, {
            method: "PUT",
            body: JSON.stringify({
              title: row.title, theme: row.theme, content: remoteRow.content,
              expectedRevision: row.base_revision,
            }),
          })).document;
        } catch (error) {
          if (!(error instanceof RemoteHTTPError) || error.status !== 404) throw error;
          remote = await recoverDeletedRemoteDocument(remoteRow);
          await db.execute(`
            UPDATE offline_documents SET folder_dirty = 1
            WHERE account_id = $1 AND doc_id = $2 AND sync_state <> 'trash'
          `, [account, row.doc_id]);
        }
      }
      if (remote) await acknowledgeDocument(account, row, remote);

      const current = await selectDocument(account, row.doc_id);
      if (current?.folder_dirty) {
        try {
          await remoteJSON(`/api/documents/${encodeURIComponent(row.doc_id)}/folder`, {
            method: "PUT", body: JSON.stringify({ folderId: current.folder_id }),
          });
        } catch (error) {
          if (
            !(error instanceof RemoteHTTPError) ||
            error.status !== 404 ||
            error.code !== "not_found" ||
            current.sync_state !== "clean" ||
            current.base_revision <= 0
          ) {
            throw error;
          }
          const removed = await db.execute(`
            DELETE FROM offline_documents
            WHERE account_id = $1 AND doc_id = $2
              AND sync_state = 'clean' AND folder_dirty = 1
              AND base_revision = $3 AND change_seq = $4
          `, [account, row.doc_id, current.base_revision, current.change_seq]);
          if (removed.rowsAffected !== 1) throw error;
          continue;
        }
        await db.execute(`
          UPDATE offline_documents SET folder_dirty = 0
          WHERE account_id = $1 AND doc_id = $2 AND change_seq = $3
        `, [account, row.doc_id, current.change_seq]);
      }
    } catch (error) {
      if (error instanceof OfflineImageUploadError) {
        imageUploadIssues.push(error.code);
        await db.execute(`
          UPDATE offline_documents SET last_error = $3
          WHERE account_id = $1 AND doc_id = $2
            AND sync_state NOT IN ('trash', 'conflict')
        `, [account, row.doc_id, error.code]);
        continue;
      }
      if (
        error instanceof RemoteHTTPError &&
        error.status === 409 &&
        error.code === "document_revision_conflict"
      ) {
        const remote = await remoteJSON<{ document: Document }>(`/api/documents/${encodeURIComponent(row.doc_id)}`);
        await cacheDocumentImages(account, remote.document.content);
        await db.execute(`
          UPDATE offline_documents
          SET sync_state = 'conflict', remote_snapshot = $3, last_error = $4
          WHERE account_id = $1 AND doc_id = $2
            AND sync_state NOT IN ('trash', 'conflict')
        `, [account, row.doc_id, JSON.stringify(remote.document), error.code ?? "document_revision_conflict"]);
        continue;
      }
      throw error;
    }
  }
  return imageUploadIssues;
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
    throw new Error("document_save_pending");
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
    await cacheDocumentImages(account, remote.document.content);
    let comparableLocalContent = local.content;
    try {
      comparableLocalContent = await prepareDocumentContentForRemote(
        account,
        local.content,
      );
    } catch (error) {
      if (!(error instanceof OfflineImageUploadError)) throw error;
      // 本地占位地址必然与远端正文不同，后面的决策会保留双方并进入冲突；
      // 不能让一张失败图片中断其余远端文档的拉取。
    }
    const decision = decideRemoteDocument(
      {
        title: local.title,
        theme: local.theme,
        content: comparableLocalContent,
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
        organizerKind: local.organizer_kind,
        syncState: local.sync_state,
      },
      {
        name: remote.name,
        parentFolderId: remote.parentFolderId,
        organizerKind: remote.organizerKind ?? null,
      },
    );
    if (decision === "replace-clean") {
      await db.execute(`
        UPDATE offline_folders
        SET name = $3, parent_folder_id = $4, organizer_kind = $5,
            change_seq = change_seq + 1,
            remote_snapshot = NULL, last_error = NULL
        WHERE account_id = $1 AND folder_id = $2
          AND sync_state = 'clean' AND change_seq = $6
      `, [
        account, remote.folderId, remote.name, remote.parentFolderId,
        remote.organizerKind ?? null, local.change_seq,
      ]);
    } else if (decision === "acknowledge-local") {
      await db.execute(`
        UPDATE offline_folders
        SET name = $3, parent_folder_id = $4, organizer_kind = $5,
            sync_state = 'clean',
            remote_snapshot = NULL, last_error = NULL
        WHERE account_id = $1 AND folder_id = $2
          AND sync_state = $6 AND change_seq = $7
      `, [
        account, remote.folderId, remote.name, remote.parentFolderId,
        remote.organizerKind ?? null, local.sync_state, local.change_seq,
      ]);
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
        local_revision = CASE
          WHEN sync_state IN ('trash', 'conflict') THEN local_revision
          WHEN change_seq = $3 OR (title = $4 AND theme = $5 AND content = $6)
            THEN $7
          ELSE local_revision
        END,
        base_revision = CASE
          WHEN sync_state IN ('trash', 'conflict') THEN base_revision
          ELSE $8
        END,
        created_at = CASE WHEN change_seq = $3 THEN $9 ELSE created_at END,
        updated_at = CASE WHEN change_seq = $3 THEN $10 ELSE updated_at END,
        share_json = CASE WHEN change_seq = $3 THEN $11 ELSE share_json END,
        sync_state = CASE
          WHEN sync_state IN ('trash', 'conflict') THEN sync_state
          WHEN change_seq = $3 OR (title = $4 AND theme = $5 AND content = $6)
            THEN 'clean'
          ELSE 'update'
        END,
        remote_snapshot = CASE
          WHEN sync_state IN ('trash', 'conflict') THEN remote_snapshot
          ELSE NULL
        END,
        last_error = CASE
          WHEN sync_state IN ('trash', 'conflict') THEN last_error
          ELSE NULL
        END
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
        organizer_kind = CASE WHEN change_seq = $3 THEN $6 ELSE organizer_kind END,
        sync_state = CASE
          WHEN change_seq = $3 THEN 'clean'
          WHEN sync_state = 'delete' THEN 'delete'
          ELSE 'update'
        END,
        remote_snapshot = NULL, last_error = NULL
    WHERE account_id = $1 AND folder_id = $2
  `, [
    account, sent.folder_id, sent.change_seq, remote.name,
    remote.parentFolderId, remote.organizerKind ?? null,
  ]);
}

async function reconcileFolderIdentity(
  account: string,
  sent: FolderRow,
  remote: Folder,
) {
  const db = await database();
  const currentRows = await db.select<FolderRow[]>(`
    SELECT * FROM offline_folders
    WHERE account_id = $1 AND folder_id = $2
  `, [account, sent.folder_id]);
  const current = currentRows[0];

  if (!current || current.sync_state === "delete") return;

  await insertRemoteFolder(account, remote);

  if (current && current.change_seq !== sent.change_seq) {
    const canonicalRows = await db.select<FolderRow[]>(`
      SELECT * FROM offline_folders
      WHERE account_id = $1 AND folder_id = $2
    `, [account, remote.folderId]);
    const canonical = canonicalRows[0];
    if (canonical && canonical.sync_state !== "conflict") {
      const parentFolderId =
        current.parent_folder_id === sent.parent_folder_id
          ? remote.parentFolderId
          : current.parent_folder_id;
      await db.execute(`
        UPDATE offline_folders
        SET name = $3, parent_folder_id = $4, organizer_kind = $5,
            sync_state = CASE WHEN sync_state IN ('clean', 'delete') THEN 'update' ELSE sync_state END,
            change_seq = change_seq + 1, remote_snapshot = NULL, last_error = NULL
        WHERE account_id = $1 AND folder_id = $2
      `, [
        account, remote.folderId, current.name, parentFolderId,
        current.organizer_kind,
      ]);
    }
  }

  await db.execute(`
    UPDATE offline_documents
    SET folder_id = $3,
        folder_dirty = CASE WHEN sync_state = 'trash' THEN folder_dirty ELSE 1 END,
        change_seq = change_seq + 1
    WHERE account_id = $1 AND folder_id = $2 AND sync_state <> 'trash'
  `, [account, sent.folder_id, remote.folderId]);
  await db.execute(`
    UPDATE offline_folders
    SET parent_folder_id = $3,
        sync_state = CASE WHEN sync_state = 'clean' THEN 'update' ELSE sync_state END,
        change_seq = change_seq + 1, remote_snapshot = NULL, last_error = NULL
    WHERE account_id = $1 AND parent_folder_id = $2
      AND folder_id <> $2 AND sync_state NOT IN ('delete', 'conflict')
  `, [account, sent.folder_id, remote.folderId]);
  await db.execute(`
    DELETE FROM offline_folders
    WHERE account_id = $1 AND folder_id = $2
  `, [account, sent.folder_id]);
}

async function insertRemoteDocument(account: string, document: Document, folderID: string | null) {
  await cacheDocumentImages(account, document.content);
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
): Promise<boolean> {
  await cacheDocumentImages(account, document.content);
  const db = await database();
  const [baseRevision, syncState, changeSeq] = snapshotGuard({
    baseRevision: local.base_revision,
    syncState: local.sync_state,
    changeSeq: local.change_seq,
  });
  const result = await db.execute(`
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
  return result.rowsAffected === 1;
}

async function acknowledgeMatchingRemoteDocument(
  account: string,
  local: DocumentRow,
  document: Document,
  folderID: string | null,
) {
  await cacheDocumentImages(account, document.content);
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
    account, document.docId, document.title, document.theme, local.content, folderID,
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
      account_id, folder_id, name, parent_folder_id, organizer_kind,
      sync_state, change_seq
    ) VALUES ($1, $2, $3, $4, $5, 'clean', 0)
    ON CONFLICT (account_id, folder_id) DO NOTHING
  `, [
    account, folder.folderId, folder.name, folder.parentFolderId,
    folder.organizerKind ?? null,
  ]);
}

async function selectDocument(account: string, docID: string): Promise<DocumentRow | null> {
  const db = await database();
  const rows = await db.select<DocumentRow[]>(`
    SELECT * FROM offline_documents WHERE account_id = $1 AND doc_id = $2
  `, [account, docID]);
  return rows[0] ? readableDocumentRow(account, rows[0]) : null;
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
  return {
    folderId: row.folder_id,
    name: row.name,
    parentFolderId: row.parent_folder_id,
    organizerKind: row.organizer_kind ?? null,
  };
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
  const storedIssues = await db.select<{ error_code: string | null }[]>(`
    SELECT COALESCE(
      (SELECT last_error FROM offline_documents
       WHERE account_id = $1 AND last_error IS NOT NULL
         AND (sync_state <> 'clean' OR folder_dirty = 1)
       ORDER BY updated_at DESC LIMIT 1),
      (SELECT i.last_error FROM offline_images i
       WHERE i.account_id = $1 AND i.last_error IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM offline_documents d
           WHERE d.account_id = $1
             AND (d.sync_state <> 'clean' OR d.folder_dirty = 1)
             AND instr(d.content, $2 || i.image_id) > 0
         )
       ORDER BY i.created_at DESC LIMIT 1)
    ) AS error_code
  `, [account, "koinote-local-image://"]);
  const effectiveMessage = message ?? storedIssues[0]?.error_code ?? undefined;
  return {
    state,
    pending: Number(counts[0]?.pending ?? 0),
    conflicts: Number(counts[0]?.conflicts ?? 0),
    lastSyncedAt: meta[0]?.value ?? null,
    ...(effectiveMessage ? { message: effectiveMessage } : {}),
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
