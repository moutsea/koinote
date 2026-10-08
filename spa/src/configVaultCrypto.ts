import { strToU8, unzipSync, zipSync } from "fflate";

export const CONFIG_SNAPSHOT_ENVELOPE_VERSION = 1;
const PBKDF2_ITERATIONS = 310_000;
const MAX_PATH_BYTES = 512;
const MAX_UNCOMPRESSED_BYTES = 128 << 20;

export type ConfigVaultFile = {
  path: string;
  bytes: Uint8Array;
};

type ConfigVaultEnvelope = {
  version: number;
  kdf: "PBKDF2-SHA-256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    (normalized.length >= 2 && normalized[1] === ":") ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => part === ".." || part === "." || part === "") ||
    new TextEncoder().encode(normalized).length > MAX_PATH_BYTES
  ) {
    throw new Error("config_path_invalid");
  }
  return normalized;
}

function validateFiles(files: ConfigVaultFile[]): ConfigVaultFile[] {
  if (files.length < 1) throw new Error("config_file_count_invalid");
  const seen = new Set<string>();
  const normalized = files.map((file) => {
    const path = normalizePath(file.path);
    if (seen.has(path)) throw new Error("config_path_duplicate");
    seen.add(path);
    return { path, bytes: new Uint8Array(file.bytes) };
  });
  return normalized;
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  if (password.length < 8) throw new Error("config_password_too_short");
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptConfigSnapshot(
  files: ConfigVaultFile[],
  password: string,
): Promise<{ envelope: string; fileCount: number; bytes: number }> {
  const validated = validateFiles(files);
  const archive = zipSync(
    Object.fromEntries(validated.map((file) => [file.path, file.bytes])),
    { level: 6 },
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    archive as BufferSource,
  ));
  const envelope: ConfigVaultEnvelope = {
    version: CONFIG_SNAPSHOT_ENVELOPE_VERSION,
    kdf: "PBKDF2-SHA-256",
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
  };
  const serialized = JSON.stringify(envelope);
  return {
    envelope: serialized,
    fileCount: validated.length,
    bytes: new TextEncoder().encode(serialized).byteLength,
  };
}

export async function decryptConfigSnapshot(
  serialized: string,
  password: string,
): Promise<ConfigVaultFile[]> {
  let envelope: ConfigVaultEnvelope;
  try {
    envelope = JSON.parse(serialized) as ConfigVaultEnvelope;
  } catch {
    throw new Error("config_snapshot_invalid");
  }
  if (
    envelope.version !== CONFIG_SNAPSHOT_ENVELOPE_VERSION ||
    envelope.kdf !== "PBKDF2-SHA-256" ||
    !Number.isInteger(envelope.iterations) ||
    envelope.iterations < 100_000 ||
    envelope.iterations > 2_000_000
  ) throw new Error("config_snapshot_invalid");
  let archive: Uint8Array;
  try {
    const key = await deriveKey(password, base64ToBytes(envelope.salt), envelope.iterations);
    archive = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(envelope.iv) as BufferSource },
      key,
      base64ToBytes(envelope.ciphertext) as BufferSource,
    ));
  } catch {
    throw new Error("config_password_incorrect");
  }
  try {
    let uncompressedBytes = 0;
    return validateFiles(
      Object.entries(unzipSync(archive, {
        filter: ({ originalSize }) => {
          if (
            !Number.isSafeInteger(originalSize) ||
            originalSize < 0 ||
            originalSize > MAX_UNCOMPRESSED_BYTES - uncompressedBytes
          ) {
            throw new Error("config_snapshot_invalid");
          }
          uncompressedBytes += originalSize;
          return true;
        },
      })).map(([path, bytes]) => ({ path, bytes })),
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("config_")) throw error;
    throw new Error("config_snapshot_invalid");
  }
}

export function filesFromFileList(files: FileList | File[]): Promise<ConfigVaultFile[]> {
  return Promise.all(Array.from(files).map(async (file) => ({
    path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    bytes: new Uint8Array(await file.arrayBuffer()),
  })));
}

export function configFilesZip(files: ConfigVaultFile[]): Uint8Array {
  return zipSync(Object.fromEntries(validateFiles(files).map((file) => [file.path, file.bytes])), { level: 6 });
}

export function downloadConfigFiles(files: ConfigVaultFile[], name: string): void {
  const blob = new Blob([configFilesZip(files) as BlobPart], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${name.replace(/[^\w\-.]+/g, "_").slice(0, 80) || "koinote-config"}.zip`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function configFileFromText(path: string, value: string): ConfigVaultFile {
  return { path, bytes: strToU8(value) };
}
