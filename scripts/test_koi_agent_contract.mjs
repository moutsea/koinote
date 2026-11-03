// Run against an isolated PostgreSQL database and the sibling agent-gpt checkout.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.TEST_DATABASE_URL) throw new Error("请指定隔离的 TEST_DATABASE_URL。");
const root = fileURLToPath(new URL("../", import.meta.url));
const upstream = resolve(process.env.AGENT_GPT_CHECKOUT || join(root, "../tools/agent-gpt"));
const directory = mkdtempSync(join(tmpdir(), "koi-agent-wire-"));
const env = { ...process.env, AGENT_GPT_CHECKOUT: upstream, KOINOTE_TEST_CONTRACT_DIR: directory };
try {
  execFileSync("go", ["test","./internal/server","-run","^TestAgent(Wire|ApprovalPause)","-count=1"], {cwd:join(root,"backend"),env,stdio:"inherit"});
  execFileSync(process.execPath, [join(upstream,"node_modules/vitest/vitest.mjs"),"run","test/koinote-wire.spec.ts","test/koinote-approval-replay.spec.ts","test/koinote-audience.spec.ts"], {cwd:upstream,env:{...env,PWD:upstream},stdio:"inherit"});
} finally { rmSync(directory,{recursive:true,force:true}); }
