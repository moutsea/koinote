import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  backupKeysToDelete,
  handleDatabaseBackupDownload,
  handleDatabaseBackupStatus,
  handleDatabaseBackupUpload,
} from "./_database_backup_bundle.mjs";

const token = "database-backup-test-token";

function checksum(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function backupName(iso) {
  return `koinote-${iso.slice(0, 13)}00Z.dump.cms`;
}

function metadata(record, includeCustomMetadata = true) {
  return {
    key: record.key,
    version: "test-version",
    size: record.bytes.byteLength,
    etag: record.sha256,
    httpEtag: `"${record.sha256}"`,
    uploaded: record.uploaded,
    httpMetadata: { contentType: "application/pkcs7-mime" },
    customMetadata: includeCustomMetadata ? record.customMetadata : undefined,
    checksums: {},
    storageClass: "Standard",
    writeHttpMetadata(headers) {
      headers.set("Content-Type", "application/pkcs7-mime");
    },
  };
}

class MemoryBucket {
  records = new Map();
  deleted = [];
  sizeOffset = 0;

  async put(key, body, options = {}) {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    const sha256 = checksum(bytes);
    if (options.sha256 !== sha256) throw new Error("checksum mismatch");
    const record = {
      key,
      bytes,
      sha256,
      uploaded: new Date("2026-08-16T12:00:00Z"),
      customMetadata: options.customMetadata ?? {},
    };
    this.records.set(key, record);
    const object = metadata(record);
    return { ...object, size: object.size + this.sizeOffset };
  }

  async get(key) {
    const record = this.records.get(key);
    if (!record) return null;
    return {
      ...metadata(record),
      body: record.bytes,
      bodyUsed: false,
      range: undefined,
      async arrayBuffer() {
        return record.bytes.slice().buffer;
      },
      async text() {
        return new TextDecoder().decode(record.bytes);
      },
      async json() {
        return JSON.parse(await this.text());
      },
      async blob() {
        return new Blob([record.bytes]);
      },
    };
  }

  async list({ prefix = "", cursor, limit = 1000, include = [] } = {}) {
    const records = [...this.records.values()]
      .filter((record) => record.key.startsWith(prefix))
      .sort((left, right) => left.key.localeCompare(right.key));
    const offset = cursor ? Number(cursor) : 0;
    const page = records.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      objects: page.map((record) =>
        metadata(record, include.includes("customMetadata")),
      ),
      truncated: nextOffset < records.length,
      cursor: nextOffset < records.length ? String(nextOffset) : undefined,
      delimitedPrefixes: [],
    };
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.deleted.push(key);
      this.records.delete(key);
    }
  }
}

function uploadRequest(name, bytes, overrides = {}) {
  const headers = {
    "content-length": String(bytes.byteLength),
    "x-koinote-backup-sha256": checksum(bytes),
    "x-koinote-internal-token": token,
    ...overrides,
  };
  return new Request(
    `https://koinote.app/api/internal/backups/database/${name}`,
    { method: "PUT", headers, body: bytes },
  );
}

const now = Date.parse("2026-08-16T12:00:00Z");
const recent = Array.from({ length: 28 }, (_, index) =>
  `database/${backupName(new Date(now - index * 6 * 60 * 60 * 1000).toISOString())}`,
);
const dailyNewer = `database/${backupName("2026-08-08T18:00:00.000Z")}`;
const dailyOlder = `database/${backupName("2026-08-08T12:00:00.000Z")}`;
const weeklyNewer = `database/${backupName("2026-07-08T18:00:00.000Z")}`;
const weeklyOlder = `database/${backupName("2026-07-08T12:00:00.000Z")}`;
const monthlyNewer = `database/${backupName("2026-01-28T18:00:00.000Z")}`;
const monthlyOlder = `database/${backupName("2026-01-08T12:00:00.000Z")}`;
const expired = `database/${backupName("2025-07-01T12:00:00.000Z")}`;
const invalid = "database/not-a-backup.txt";
const deletions = new Set(
  backupKeysToDelete(
    [
      invalid,
      expired,
      monthlyOlder,
      monthlyNewer,
      weeklyOlder,
      weeklyNewer,
      dailyOlder,
      dailyNewer,
      ...recent,
    ],
    now,
  ),
);
for (const key of recent) assert.equal(deletions.has(key), false);
assert.equal(deletions.has(dailyNewer), false);
assert.equal(deletions.has(dailyOlder), true);
assert.equal(deletions.has(weeklyNewer), false);
assert.equal(deletions.has(weeklyOlder), true);
assert.equal(deletions.has(monthlyNewer), false);
assert.equal(deletions.has(monthlyOlder), true);
assert.equal(deletions.has(expired), true);
assert.equal(deletions.has(invalid), false);

const bucket = new MemoryBucket();
const env = { BACKUPS: bucket, BACKEND_INTERNAL_TOKEN: token };
const bytes = new TextEncoder().encode("encrypted pg_dump fixture");
const name = "koinote-2026-08-16T1200Z.dump.cms";

let response = await handleDatabaseBackupUpload(
  uploadRequest(name, bytes, { "x-koinote-internal-token": "wrong" }),
  env,
);
assert.equal(response.status, 401);
assert.equal(bucket.records.size, 0);

response = await handleDatabaseBackupUpload(
  uploadRequest("../../bad.dump.cms", bytes),
  env,
);
assert.equal(response.status, 400);

const originalConsoleError = console.error;
console.error = () => undefined;
try {
  response = await handleDatabaseBackupUpload(
    uploadRequest(name, bytes, { "x-koinote-backup-sha256": "0".repeat(64) }),
    env,
  );
} finally {
  console.error = originalConsoleError;
}
assert.equal(response.status, 502);
assert.equal(bucket.records.size, 0);

response = await handleDatabaseBackupUpload(uploadRequest(name, bytes), env);
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), {
  key: `database/${name}`,
  size: bytes.byteLength,
  sha256: checksum(bytes),
  deleted: 0,
});
assert.match(response.headers.get("cache-control"), /no-store/);

response = await handleDatabaseBackupStatus(
  new Request("https://koinote.app/api/internal/backups", {
    headers: { "x-koinote-internal-token": token },
  }),
  env,
);
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), {
  count: 1,
  latest: {
    key: `database/${name}`,
    size: bytes.byteLength,
    uploadedAt: "2026-08-16T12:00:00.000Z",
    sha256: checksum(bytes),
  },
});

response = await handleDatabaseBackupDownload(
  new Request(`https://koinote.app/api/internal/backups/database/${name}`, {
    headers: { "x-koinote-internal-token": token },
  }),
  env,
);
assert.equal(response.status, 200);
assert.equal(await response.text(), "encrypted pg_dump fixture");
assert.equal(response.headers.get("x-koinote-backup-sha256"), checksum(bytes));
assert.equal(response.headers.get("content-disposition"), `attachment; filename="${name}"`);

const mismatchBucket = new MemoryBucket();
mismatchBucket.sizeOffset = 1;
response = await handleDatabaseBackupUpload(uploadRequest(name, bytes), {
  BACKUPS: mismatchBucket,
  BACKEND_INTERNAL_TOKEN: token,
});
assert.equal(response.status, 502);
assert.equal(mismatchBucket.records.size, 0);
assert.deepEqual(mismatchBucket.deleted, [`database/${name}`]);

response = await handleDatabaseBackupUpload(
  uploadRequest(name, bytes, { "content-length": String(96 * 1024 * 1024) }),
  env,
);
assert.equal(response.status, 413);

console.log("database backup worker checks passed");
