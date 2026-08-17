const ENCRYPTED_VALUE_PREFIX = "koinote-encrypted-v1:";

export type LocalModePasswordMaterial = {
  encryptionKey: CryptoKey;
  verifier: Uint8Array;
};

export function localModeBytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function localModeBase64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function localModeVerifierMatches(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export async function deriveLocalModePasswordMaterial(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<LocalModePasswordMaterial> {
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const material = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    passwordKey,
    512,
  ));
  const encryptionKey = await crypto.subtle.importKey(
    "raw",
    material.slice(0, 32),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  return { encryptionKey, verifier: material.slice(32) };
}

export async function encryptLocalModeValue(
  value: string,
  key: CryptoKey,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(value),
  ));
  return ENCRYPTED_VALUE_PREFIX +
    localModeBytesToBase64(iv) + ":" +
    localModeBytesToBase64(encrypted);
}

export async function decryptLocalModeValue(
  value: string,
  key: CryptoKey,
): Promise<string> {
  if (!value.startsWith(ENCRYPTED_VALUE_PREFIX)) {
    throw new Error("local_mode_data_not_encrypted");
  }
  const encoded = value.slice(ENCRYPTED_VALUE_PREFIX.length);
  const separator = encoded.indexOf(":");
  if (separator <= 0) throw new Error("local_mode_data_invalid");
  try {
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: localModeBase64ToBytes(encoded.slice(0, separator)) as BufferSource,
      },
      key,
      localModeBase64ToBytes(encoded.slice(separator + 1)) as BufferSource,
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    throw new Error("local_mode_data_invalid");
  }
}
