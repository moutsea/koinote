export type BackupsEnv = {
  BACKUPS: R2Bucket;
  BACKEND_INTERNAL_TOKEN?: string;
};

const BACKUP_PATH_PREFIX = "/api/internal/backups/database/";
const BACKUP_KEY_PREFIX = "database/";
// Cloudflare Free/Pro 请求体上限是 100 MB。留出代理头与平台计量余量，
// 让数据库变大时明确失败并触发告警，而不是依赖一个实际上到不了的 512 MB 上限。
const MAX_BACKUP_BYTES = 95 * 1024 * 1024;
const RECENT_BACKUPS = 28;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_WINDOW_MS = 35 * DAY_MS;
const WEEKLY_WINDOW_MS = 180 * DAY_MS;
const MONTHLY_WINDOW_MS = 400 * DAY_MS;
const BACKUP_NAME_PATTERN =
  /^koinote-(\d{4}-\d{2}-\d{2})T(\d{2})00Z\.dump\.cms$/;

type ParsedBackup = {
  key: string;
  timestamp: number;
  day: string;
  month: string;
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function authorized(request: Request, env: BackupsEnv): boolean {
  const expected = (env.BACKEND_INTERNAL_TOKEN ?? "").trim();
  const presented = request.headers.get("x-koinote-internal-token") ?? "";
  return expected !== "" && timingSafeEqual(presented, expected);
}

function parseBackupKey(key: string): ParsedBackup | null {
  if (!key.startsWith(BACKUP_KEY_PREFIX)) return null;
  const name = key.slice(BACKUP_KEY_PREFIX.length);
  const match = BACKUP_NAME_PATTERN.exec(name);
  if (!match) return null;
  const [, day, hour] = match;
  const timestamp = Date.parse(`${day}T${hour}:00:00Z`);
  if (!Number.isFinite(timestamp)) return null;
  const canonical = new Date(timestamp).toISOString();
  if (canonical.slice(0, 10) !== day || canonical.slice(11, 13) !== hour) {
    return null;
  }
  return { key, timestamp, day, month: day.slice(0, 7) };
}

function weekBucket(timestamp: number): string {
  const date = new Date(timestamp);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

export function backupKeysToDelete(
  keys: string[],
  now = Date.now(),
): string[] {
  const backups = keys
    .map(parseBackupKey)
    .filter((backup): backup is ParsedBackup => backup !== null)
    .sort((left, right) => right.timestamp - left.timestamp);
  const keep = new Set(backups.slice(0, RECENT_BACKUPS).map((backup) => backup.key));
  const daily = new Set<string>();
  const weekly = new Set<string>();
  const monthly = new Set<string>();

  for (const backup of backups.slice(RECENT_BACKUPS)) {
    const age = Math.max(0, now - backup.timestamp);
    if (age <= DAILY_WINDOW_MS) {
      if (!daily.has(backup.day)) {
        daily.add(backup.day);
        keep.add(backup.key);
      }
      continue;
    }
    if (age <= WEEKLY_WINDOW_MS) {
      const bucket = weekBucket(backup.timestamp);
      if (!weekly.has(bucket)) {
        weekly.add(bucket);
        keep.add(backup.key);
      }
      continue;
    }
    if (age <= MONTHLY_WINDOW_MS && !monthly.has(backup.month)) {
      monthly.add(backup.month);
      keep.add(backup.key);
    }
  }

  return backups
    .filter((backup) => !keep.has(backup.key))
    .map((backup) => backup.key);
}

function keyFromRequest(request: Request): string | null {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith(BACKUP_PATH_PREFIX)) return null;
  const name = pathname.slice(BACKUP_PATH_PREFIX.length);
  if (!BACKUP_NAME_PATTERN.test(name)) return null;
  return `${BACKUP_KEY_PREFIX}${name}`;
}

async function listBackupObjects(bucket: R2Bucket): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: BACKUP_KEY_PREFIX,
      cursor,
      limit: 1000,
      include: ["customMetadata"],
    });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

async function pruneBackups(bucket: R2Bucket): Promise<number> {
  const objects = await listBackupObjects(bucket);
  const keys = backupKeysToDelete(objects.map((object) => object.key));
  for (let offset = 0; offset < keys.length; offset += 1000) {
    await bucket.delete(keys.slice(offset, offset + 1000));
  }
  return keys.length;
}

export async function handleDatabaseBackupUpload(
  request: Request,
  env: BackupsEnv,
): Promise<Response> {
  if (!authorized(request, env)) {
    return json(401, { code: "unauthorized", error: "Bad token" });
  }
  const key = keyFromRequest(request);
  if (!key) {
    return json(400, { code: "invalid_backup_name", error: "Invalid backup name" });
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    return json(411, { code: "content_length_required", error: "Content-Length is required" });
  }
  if (contentLength > MAX_BACKUP_BYTES) {
    return json(413, { code: "backup_too_large", error: "Backup is too large" });
  }
  const sha256 = (request.headers.get("x-koinote-backup-sha256") ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256) || !request.body) {
    return json(400, { code: "invalid_checksum", error: "A SHA-256 checksum is required" });
  }

  let stored: R2Object | null;
  try {
    stored = await env.BACKUPS.put(key, request.body, {
      sha256,
      httpMetadata: { contentType: "application/pkcs7-mime" },
      customMetadata: {
        sha256,
        format: "pg_dump-custom+cms-aes-256-gcm",
      },
    });
  } catch (error) {
    console.error("database backup upload failed", error);
    return json(502, { code: "backup_upload_failed", error: "Could not store backup" });
  }
  if (!stored || stored.size !== contentLength) {
    try {
      await env.BACKUPS.delete(key);
    } catch (error) {
      console.warn("database backup mismatch cleanup failed", error);
    }
    return json(502, { code: "backup_size_mismatch", error: "Stored backup size does not match" });
  }

  let deleted = 0;
  try {
    deleted = await pruneBackups(env.BACKUPS);
  } catch (error) {
    console.warn("database backup retention failed", error);
  }
  return json(200, {
    key,
    size: stored.size,
    sha256,
    deleted,
  });
}

export async function handleDatabaseBackupDownload(
  request: Request,
  env: BackupsEnv,
): Promise<Response> {
  if (!authorized(request, env)) {
    return json(401, { code: "unauthorized", error: "Bad token" });
  }
  const key = keyFromRequest(request);
  if (!key) {
    return json(400, { code: "invalid_backup_name", error: "Invalid backup name" });
  }
  const object = await env.BACKUPS.get(key);
  if (!object) {
    return json(404, { code: "backup_not_found", error: "Backup not found" });
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Length", String(object.size));
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "private, no-store");
  headers.set(
    "Content-Disposition",
    `attachment; filename="${key.slice(BACKUP_KEY_PREFIX.length)}"`,
  );
  const sha256 = object.customMetadata?.sha256;
  if (sha256) headers.set("X-Koinote-Backup-Sha256", sha256);
  return new Response(object.body, { headers });
}

export async function handleDatabaseBackupStatus(
  request: Request,
  env: BackupsEnv,
): Promise<Response> {
  if (!authorized(request, env)) {
    return json(401, { code: "unauthorized", error: "Bad token" });
  }
  const objects = (await listBackupObjects(env.BACKUPS))
    .filter((object) => parseBackupKey(object.key) !== null)
    .sort((left, right) => right.uploaded.getTime() - left.uploaded.getTime());
  const latest = objects[0];
  return json(200, {
    count: objects.length,
    latest: latest
      ? {
          key: latest.key,
          size: latest.size,
          uploadedAt: latest.uploaded.toISOString(),
          sha256: latest.customMetadata?.sha256 ?? null,
        }
      : null,
  });
}
