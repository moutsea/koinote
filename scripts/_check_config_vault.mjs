import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  decryptConfigSnapshot,
  encryptConfigSnapshot,
} from "./_config_vault_crypto_bundle.mjs";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.btoa) globalThis.btoa = (value) => Buffer.from(value, "binary").toString("base64");
if (!globalThis.atob) globalThis.atob = (value) => Buffer.from(value, "base64").toString("binary");

const password = "correct horse battery staple";
const files = [
  { path: ".ssh/config", bytes: new TextEncoder().encode("Host example\n") },
  { path: ".zshrc", bytes: new TextEncoder().encode("export EDITOR=vim\n") },
];
const encrypted = await encryptConfigSnapshot(files, password);
assert.equal(encrypted.fileCount, 2);
const restored = await decryptConfigSnapshot(encrypted.envelope, password);
assert.deepEqual(
  restored.map(({ path, bytes }) => [path, new TextDecoder().decode(bytes)]),
  files.map(({ path, bytes }) => [path, new TextDecoder().decode(bytes)]),
);

await assert.rejects(
  () => decryptConfigSnapshot(encrypted.envelope, "wrong password"),
  /config_password_incorrect/,
);
const tampered = JSON.parse(encrypted.envelope);
tampered.ciphertext = `${tampered.ciphertext.slice(0, -2)}AA`;
await assert.rejects(
  () => decryptConfigSnapshot(JSON.stringify(tampered), password),
  /config_password_incorrect/,
);
await assert.rejects(
  () => encryptConfigSnapshot([{ path: "../secret", bytes: new Uint8Array([1]) }], password),
  /config_path_invalid/,
);
await assert.rejects(
  () => encryptConfigSnapshot([{ path: "secret/./file", bytes: new Uint8Array([1]) }], password),
  /config_path_invalid/,
);
console.log("config vault checks passed");
