// Check the package emitted from immutable storage against the actual runtime.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

if (!process.env.TEST_DATABASE_URL) throw new Error("请指定隔离的 TEST_DATABASE_URL。");
const root = fileURLToPath(new URL("../", import.meta.url));
const upstream = resolve(process.env.AGENT_GPT_CHECKOUT || join(root, "../tools/agent-gpt"));
const directory = mkdtempSync(join(tmpdir(), "koi-skill-contract-"));
try {
  execFileSync("go", ["test", "./internal/server", "-run", "^TestKoiSkillRuntimeContract$", "-count=1"], {
    cwd: join(root, "backend"), env: { ...process.env, KOINOTE_TEST_SKILL_CONTRACT_DIR: directory }, stdio: "inherit",
  });
  const outfile = join(directory, "native.cjs");
  await build({ stdin: { contents: 'export {normalizeSkillPackage} from "./src/runtime/skill-packages";export {validateSkillInvocationPolicy} from "./src/core/skill-invocation-policy";export {skillReadiness} from "./src/core/skill-readiness";', resolveDir: upstream, loader: "ts" }, bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent" });
  const native = createRequire(import.meta.url)(outfile);
  for (const format of ["standard", "plain"]) {
    const payload = JSON.parse(readFileSync(join(directory, `${format}.json`), "utf8"));
    const pkg = await native.normalizeSkillPackage(payload.manifest, payload.instructions, payload.files);
    assert.equal(pkg.instructions, payload.instructions);
    assert.match(pkg.manifest.id, /^koi-[a-f0-9-]{36}$/);
    assert.ok(pkg.files.some((file) => file.path.startsWith("_provenance/") && Buffer.from(file.contentBase64, "base64").toString() === "MIT License"));
    const skill = { instructions: pkg.instructions, packageManifest: pkg.manifest };
    assert.equal(native.validateSkillInvocationPolicy(skill).modelInvocable, true);
    assert.equal(native.skillReadiness(skill, { tools: [{ name: "koinote.get_document" }] }).eligible, true);
    if (format === "standard") assert.equal(native.skillReadiness(skill, { tools: [] }).eligible, false);
    console.log(`Koi installed Skill native contract passed: ${format}`);
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
