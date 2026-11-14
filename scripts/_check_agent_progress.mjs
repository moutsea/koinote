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
  const { agentProgress, agentActivitySteps } = await import(pathToFileURL(outfile).href);
  const running = { status: "running", cancelRequested: false };
  const tool = (seq, type, name) => ({ seq, event: { type: `tool.${type}`, toolCall: { name } } });
  assert.equal(agentProgress(running, [tool(1, "started", "koinote.generate_cover")]).phase, "cover");
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
  const history = agentActivitySteps([...events, tool(10, "failed", "koinote.propose_operations"),
    tool(11, "started", "koinote.propose_operations"), tool(12, "completed", "koinote.propose_operations"),
    tool(13, "started", "private_tool")]);
  assert.deepEqual(history, [
    { seq: 1, action: "documents", status: "completed" },
    { seq: 2, action: "folders", status: "completed" },
    { seq: 3, action: "read", status: "completed" },
    { seq: 6, action: "read", status: "completed" },
    { seq: 8, action: "proposal", status: "failed" },
    { seq: 11, action: "proposal", status: "completed" },
    { seq: 13, action: "work", status: "started" },
  ], "history retains earlier steps, repeat calls, failures and retries without exposing raw names");
  assert.deepEqual(agentActivitySteps([...events].reverse().concat(events[0])), agentActivitySteps(events));
  assert.deepEqual(agentActivitySteps([tool(4, "completed", "get_document")]),
    [{ seq: 4, action: "read", status: "completed" }], "a page boundary may split a start/outcome pair");
  const interpret = (seq, stage) => ({ seq, event: { type: "task.model_started", stage } });
  assert.deepEqual(agentActivitySteps([
    interpret(2, "interpret"), interpret(4, "interpret:format-repair"),
    { seq: 6, event: { type: "run.failed" } },
  ]), [
    { seq: 2, action: "interpret", status: "failed" },
    { seq: 4, action: "interpret", status: "failed" },
  ], "failed task interpretation is visible even before the first tool call");
  assert.deepEqual(agentActivitySteps([
    interpret(1, "interpret"), interpret(2, "clarification-review"),
    { seq: 3, event: { type: "task.interpreted" } },
    tool(4, "started", "get_document"), tool(5, "completed", "get_document"),
    interpret(6, "review:change"), { seq: 7, event: { type: "task.scope_checked" } },
    interpret(8, "response-review:answer"), { seq: 9, event: { type: "run.completed" } },
  ]).map(s => [s.action, s.status]), [
    ["interpret", "completed"], ["interpret", "completed"], ["read", "completed"], ["scope", "completed"], ["response", "completed"],
  ], "successful assessments and clarification checks do not look like failures");
  assert.deepEqual(agentActivitySteps([interpret(1, "private-internal-stage"), { seq: 2, event: { type: "run.failed" } }]),
    [{ seq: 1, action: "assessment", status: "failed" }], "unknown or old assessment stages use a safe label");
  console.log("Agent progress regressions passed: chronology, grouping, status precedence, proposals, recovery, safe fallbacks.");
} finally { await rm(dir, { recursive: true, force: true }); }
