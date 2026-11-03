import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = await mkdtemp(join(tmpdir(), "koinote-agent-progress-"));
try {
  const outfile = join(dir, "progress.mjs");
  await build({ entryPoints: ["spa/src/agentProgress.ts"], bundle: true, format: "esm", platform: "node", outfile, logLevel: "silent" });
  const { agentProgress } = await import(pathToFileURL(outfile).href);
  const running = { status: "running", cancelRequested: false };
  const tool = (seq, type, name) => ({ seq, event: { type: `tool.${type}`, toolCall: { name } } });
  for (const name of ["koinote.find_skills", "koinote.load_skill"]) {
    assert.equal(agentProgress(running, [tool(1, "started", name)]).phase, "references",
      "automatic Skill loading uses a readable progress label");
  }
  const events = [
    tool(1, "completed", "koinote.search_documents"),
    tool(2, "completed", "koinote.list_folders"),
    tool(3, "started", "koinote.get_document"),
    tool(4, "completed", "koinote.get_document"),
    { seq: 5, event: { type: "model.completed" } },
    tool(6, "started", "koinote.get_document"),
    tool(7, "completed", "koinote.get_document"),
    tool(8, "started", "koinote.propose_operations"),
    { seq: 9, event: { type: "task.scope_checked", toolName: "koinote.propose_operations" } },
  ];
  const original = JSON.stringify(events);
  const progress = agentProgress(running, events);
  assert.equal(progress.phase, "proposal");
  assert.deepEqual(progress.steps.map(s => s.action), ["documents", "folders", "read", "proposal"]);
  assert.deepEqual(agentProgress(running, [...events].reverse().concat(events[0])), progress, "descending API events and duplicates preserve chronology");
  assert.equal(JSON.stringify(events), original, "query cache events are never mutated");
  const more = [...events, tool(10, "completed", "koinote.propose_operations")];
  assert.equal(agentProgress(running, more).phase, "thinking", "tool completion must not claim changes were applied");
  assert.equal(agentProgress(running, [...more, { seq: 11, event: { type: "run.completed" } }]).phase, "finishing", "wait for host task reconciliation");
  for (const status of ["preparing", "queued", "awaiting_approval", "failed", "cancelled", "completed"]) {
    assert.equal(agentProgress({ ...running, status }, events).phase, status, "task status overrides historical tool activity");
  }
  assert.equal(agentProgress({ ...running, cancelRequested: true }, events).phase, "cancelling");
  assert.equal(agentProgress({ ...running, status: "failed", cancelRequested: true }, events).phase, "failed");
  assert.equal(agentProgress({ ...running, status: "completed", taskIntent: { outcome: "partial" } }, events).phase, "partial");
  assert.equal(agentProgress({ ...running, status: "completed", taskIntent: { outcome: "clarification_required" } }, events).phase, "clarification");
  assert.equal(agentProgress(running).phase, "thinking");
  for (const name of ["get_document", "server-id.get_document", "mcp__server__get_document"]) {
    assert.equal(agentProgress(running, [tool(1, "started", name)]).phase, "read");
  }
  for (const name of ["private_server.secret_tool", "__proto__", "constructor", undefined, { raw: "internal" }]) {
    assert.deepEqual(agentProgress(running, [tool(1, "started", name)]), { phase: "work", steps: [{ seq: 1, action: "work", failed: false }] }, "unknown tools never expose technical names");
  }
  assert.equal(agentProgress(running, [{ seq: 1, event: { type: "tool.started", toolName: "koinote.get_document" } }]).phase, "read");
  const failed = [tool(1, "started", "get_document"), tool(2, "failed", "get_document")];
  assert.equal(agentProgress(running, failed).phase, "retrying");
  assert.equal(agentProgress(running, failed).steps[0].failed, true);
  assert.equal(agentProgress(running, [...failed, tool(3, "started", "get_document")]).steps[0].failed, false);
  const latest = agentProgress(running, [...more, tool(11, "started", "web_search"), tool(12, "started", "web_fetch"), tool(13, "started", "save_artifact")]);
  assert.deepEqual(latest.steps.map(s => s.action), ["proposal", "search", "web", "save"], "show the latest four meaningful steps");
  console.log("Agent progress regressions passed: chronology, grouping, status precedence, proposals, recovery, safe fallbacks.");
} finally { await rm(dir, { recursive: true, force: true }); }
