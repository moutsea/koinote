const DATABASE_URL = "sqlite:koinote-offline.db";
const LOCAL_MODE_SELECTION_KEY = "koinote:desktop-local-mode-selected";
const LOCAL_MODE_EVENT = "koinote:desktop-local-mode-changed";
const PASSWORD_ITERATIONS = 310_000;
import {
  decryptLocalModeValue,
  deriveLocalModePasswordMaterial,
  encryptLocalModeValue,
  localModeBase64ToBytes,
  localModeBytesToBase64,
  localModeVerifierMatches,
} from "./localModeCrypto";

export const DESKTOP_LOCAL_ACCOUNT_ID = "local:v1";
export const DESKTOP_LOCAL_MODE_EVENT = LOCAL_MODE_EVENT;

export function isLocalModeNetworkDisabled(error: unknown): boolean {
  return (
    (error instanceof Error && error.message === "local_mode_network_disabled") ||
    error === "local_mode_network_disabled"
  );
}

type LocalModeConfigRow = {
  salt_base64: string;
  verifier_base64: string;
  iterations: number;
};

export type DesktopLocalModeStatus = {
  configured: boolean;
  selected: boolean;
  unlocked: boolean;
};

let databasePromise: Promise<import("@tauri-apps/plugin-sql").default> | null = null;
let activeEncryptionKey: CryptoKey | null = null;

async function database() {
  if (!databasePromise) {
    databasePromise = import("@tauri-apps/plugin-sql").then(({ default: Database }) =>
      Database.load(DATABASE_URL),
    );
  }
  return databasePromise;
}

function selectionStorage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

async function loadConfig(): Promise<LocalModeConfigRow | null> {
  const db = await database();
  const rows = await db.select<LocalModeConfigRow[]>(`
    SELECT salt_base64, verifier_base64, iterations
    FROM local_mode_config WHERE id = 1
  `);
  return rows[0] ?? null;
}

async function keyForPassword(password: string): Promise<CryptoKey> {
  const config = await loadConfig();
  if (!config) throw new Error("local_mode_not_configured");
  const material = await deriveLocalModePasswordMaterial(
    password,
    localModeBase64ToBytes(config.salt_base64),
    config.iterations,
  );
  if (!localModeVerifierMatches(
    material.verifier,
    localModeBase64ToBytes(config.verifier_base64),
  )) {
    throw new Error("local_mode_password_invalid");
  }
  return material.encryptionKey;
}

function publishLocalModeChange(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(LOCAL_MODE_EVENT));
  }
}

export function isDesktopLocalModeSelected(): boolean {
  return selectionStorage()?.getItem(LOCAL_MODE_SELECTION_KEY) === "1";
}

export function isDesktopLocalModeUnlocked(): boolean {
  return isDesktopLocalModeSelected() && activeEncryptionKey !== null;
}

export async function desktopLocalModeStatus(): Promise<DesktopLocalModeStatus> {
  return {
    configured: Boolean(await loadConfig()),
    selected: isDesktopLocalModeSelected(),
    unlocked: isDesktopLocalModeUnlocked(),
  };
}

export async function configureDesktopLocalMode(password: string): Promise<void> {
  if (password.length < 8) throw new Error("local_mode_password_too_short");
  if (await loadConfig()) throw new Error("local_mode_already_configured");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const material = await deriveLocalModePasswordMaterial(
    password,
    salt,
    PASSWORD_ITERATIONS,
  );
  const db = await database();
  await db.execute(`
    INSERT INTO local_mode_config (
      id, salt_base64, verifier_base64, iterations, created_at
    ) VALUES (1, $1, $2, $3, $4)
  `, [
    localModeBytesToBase64(salt),
    localModeBytesToBase64(material.verifier),
    PASSWORD_ITERATIONS,
    new Date().toISOString(),
  ]);
  activeEncryptionKey = material.encryptionKey;
  selectionStorage()?.setItem(LOCAL_MODE_SELECTION_KEY, "1");
  publishLocalModeChange();
}

export async function unlockDesktopLocalMode(password: string): Promise<void> {
  activeEncryptionKey = await keyForPassword(password);
  selectionStorage()?.setItem(LOCAL_MODE_SELECTION_KEY, "1");
  publishLocalModeChange();
}

export async function verifyDesktopLocalModePassword(password: string): Promise<CryptoKey> {
  return keyForPassword(password);
}

export function lockDesktopLocalMode(): void {
  activeEncryptionKey = null;
  selectionStorage()?.setItem(LOCAL_MODE_SELECTION_KEY, "1");
  publishLocalModeChange();
}

export function leaveDesktopLocalMode(): void {
  activeEncryptionKey = null;
  selectionStorage()?.removeItem(LOCAL_MODE_SELECTION_KEY);
  publishLocalModeChange();
}

function requiredEncryptionKey(key?: CryptoKey): CryptoKey {
  const resolved = key ?? activeEncryptionKey;
  if (!resolved) throw new Error("local_mode_locked");
  return resolved;
}

export async function encryptDesktopLocalValue(
  value: string,
  key?: CryptoKey,
): Promise<string> {
  return encryptLocalModeValue(value, requiredEncryptionKey(key));
}

export async function decryptDesktopLocalValue(
  value: string,
  key?: CryptoKey,
): Promise<string> {
  return decryptLocalModeValue(value, requiredEncryptionKey(key));
}
