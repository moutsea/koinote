import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const installer = fileURLToPath(new URL("./install-macos.py", import.meta.url));
const cwd = fileURLToPath(new URL(".", import.meta.url));
test("Local tunnel preflight verifies DNS SAN, validity and the paired private key before installation", () => {
  const home = mkdtempSync(join(tmpdir(), "koi-origin-"));
  const config = join(home, ".config/koinote-local");
  const origin = join(config, "vpc");
  const env = { ...process.env, HOME: home, PYTHONDONTWRITEBYTECODE: "1" };
  const generate = (name) => {
    const cfg = join(home, "leaf.cnf");
    writeFileSync(cfg, `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=koi-local.koinote.app\n[ext]\nsubjectAltName=DNS:${name}\n`);
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-config", cfg,
      "-keyout", join(origin, "origin.key"), "-out", join(origin, "origin.crt")], { stdio: "pipe" });
  };
  const probe = (offset = 0) => spawnSync("python3", ["-c", [
    "import pathlib, sys, time, origin_cert",
    "now = time.time() + float(sys.argv[2])",
    "origin_cert.time.time = lambda: now",
    "origin_cert.verify_origin(pathlib.Path(sys.argv[1]))",
  ].join("\n"), origin, String(offset)], { cwd, env, encoding: "utf8" });
  try {
    mkdirSync(origin, { recursive: true, mode: 0o700 });
    writeFileSync(join(config, "tunnel.token"), "test-token", { mode: 0o600 });
    generate("other.koinote.app");
    const rejected = spawnSync("python3", [installer], { env, encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /subject alternative name/);
    assert.equal(existsSync(join(home, "Library/LaunchAgents")), false);
    for (const name of ["koi-local.koinote.app", "*.koinote.app"]) {
      generate(name);
      const valid = probe();
      assert.equal(valid.status, 0, valid.stderr);
      for (const offset of [-86400, 3 * 86400]) assert.match(probe(offset).stderr, /not currently valid/);
    }
    execFileSync("openssl", ["genrsa", "-out", join(origin, "origin.key"), "2048"], { stdio: "pipe" });
    assert.match(probe().stderr, /do not match/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
