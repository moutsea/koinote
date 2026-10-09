import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configFilesZip,
  decryptConfigSnapshot,
  encryptConfigSnapshot,
  unlockConfigSnapshot,
} from "./_config_vault_crypto_bundle.mjs";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.btoa) globalThis.btoa = (value) => Buffer.from(value, "binary").toString("base64");
if (!globalThis.atob) globalThis.atob = (value) => Buffer.from(value, "base64").toString("binary");

const password = "correct horse battery staple";
const files = [
  { path: ".ssh/config", bytes: new TextEncoder().encode("Host example\n") },
  { path: ".zshrc", bytes: new TextEncoder().encode("export EDITOR=vim\n") },
  { path: ".dsh/.env", bytes: new TextEncoder().encode("TEST_KEY=fixture") },
  { path: ".ssh/id_ed25519", bytes: new TextEncoder().encode("fixture-key") },
  { path: ".dsh/.credentials.yaml", bytes: new TextEncoder().encode("version: 1\nrefs: {}\n") },
  { path: ".dsh/profiles/web/cordis.patch.yml", bytes: new TextEncoder().encode("[]\n") },
];
const encrypted = await encryptConfigSnapshot(files, password);
assert.equal(encrypted.fileCount, files.length);
const restored = await decryptConfigSnapshot(encrypted.envelope, password);
assert.deepEqual(
  restored.map(({ path, bytes }) => [path, new TextDecoder().decode(bytes)]),
  files.map(({ path, bytes }) => [path, new TextDecoder().decode(bytes)]),
);

// Check the ZIP with an independent reader, then use a real POSIX extractor.
// Test both browser downloads and the archive decrypted by an AI Agent.
const { decryptionKey } = await unlockConfigSnapshot(encrypted.envelope, password);
const envelope = JSON.parse(encrypted.envelope);
const archiveKey = await crypto.subtle.importKey("raw", Buffer.from(decryptionKey, "base64"), "AES-GCM", false, ["decrypt"]);
const decryptedArchive = new Uint8Array(await crypto.subtle.decrypt(
  { name: "AES-GCM", iv: Buffer.from(envelope.iv, "base64") },
  archiveKey,
  Buffer.from(envelope.ciphertext, "base64"),
));
const zipFixture = mkdtempSync(join(tmpdir(), "koinote-config-zip-permissions-"));
try {
  for (const [name, archive] of [["download", configFilesZip(restored)], ["encrypted", decryptedArchive]]) {
    const archivePath = join(zipFixture, `${name}.zip`);
    writeFileSync(archivePath, archive);
    const result = JSON.parse(execFileSync("python3", ["-c", `
import json, os, stat, subprocess, sys, zipfile
archive, destination = sys.argv[1:]
with zipfile.ZipFile(archive) as zipped:
    credential = zipped.getinfo('.dsh/.credentials.yaml')
    ordinary = zipped.getinfo('.dsh/profiles/web/cordis.patch.yml')
    result = {'os': credential.create_system, 'mode': credential.external_attr >> 16,
              'ordinary_os': ordinary.create_system, 'ordinary_attrs': ordinary.external_attr}
if os.name == 'posix':
    os.umask(0o022)
    subprocess.run(['unzip', '-q', archive, '-d', destination], check=True)
    path = os.path.join(destination, '.dsh', '.credentials.yaml')
    result['extracted_mode'] = stat.S_IMODE(os.stat(path).st_mode)
    result['other_modes'] = [stat.S_IMODE(os.stat(os.path.join(destination, p)).st_mode) for p in ['.dsh/.env', '.ssh/id_ed25519']]
    with open(path, 'rb') as restored:
        result['contents'] = restored.read().decode('utf-8')
print(json.dumps(result))
`, archivePath, join(zipFixture, name)], { encoding: "utf8" }));
    assert.equal(result.os, 3, `${name}: ZIP entry uses Unix attributes`);
    assert.equal(result.mode, 0o100600, `${name}: regular file with owner-only permissions`);
    assert.equal(result.ordinary_os, 3, `${name}: all configuration entries carry private Unix permissions`);
    assert.equal(result.ordinary_attrs >>> 16, 0o100600);
    if (process.platform !== "win32") {
      assert.equal(result.extracted_mode, 0o600, `${name}: real unzip keeps private permissions`);
      assert.deepEqual(result.other_modes, [0o600, 0o600]);
      assert.equal(result.contents, "version: 1\nrefs: {}\n");
    }
  }
} finally {
  rmSync(zipFixture, { recursive: true, force: true });
}

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
console.log("config vault checks passed, including credential permissions in downloaded/encrypted ZIPs and POSIX extraction");
