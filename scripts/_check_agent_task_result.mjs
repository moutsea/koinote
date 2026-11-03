import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = await mkdtemp(join(tmpdir(), "koinote-agent-result-"));
try {
  const outfile = join(dir, "result.mjs");
  await build({ entryPoints: ["spa/src/agentTaskResult.ts"], bundle: true, format: "esm", platform: "node", outfile, logLevel: "silent" });
  const { agentTaskResult } = await import(pathToFileURL(outfile).href);
  const task = { id: "cleanup", result: "koinote.propose_operations: 宿主确认已应用 (/folders/private-id: delete)", taskIntent: { outcome: "operations_reported", inputVersion: 1 } };
  const operation = (status, kind = "delete_folder", taskId = task.id) => ({ taskId, status, input: { kind } });
  const deletions = [operation("applied"), operation("applied")];
  const original = JSON.stringify({ task, deletions });
  assert.equal(agentTaskResult(task, deletions, "zh"), "已删除 2 个空文件夹，可在下方撤销。");
  assert.equal(JSON.stringify({ task, deletions }), original, "presentation never rewrites stored audit receipts or operations");
  assert.equal(agentTaskResult(task, deletions.map(op => ({ ...op, status: "undone" })), "zh"), "已撤销 2 项改动。", "undo overrides the earlier completion receipt");
  const mixed = [operation("applied", "move"), operation("applied", "folder"), operation("pending"), operation("rejected"), operation("cancelled"), operation("superseded"), operation("undone"), operation("applied", "delete_folder", "another-task")];
  assert.equal(agentTaskResult(task, mixed, "zh"), "已完成 2 项改动。\n\n有 1 项改动等待审批。\n\n已撤销 1 项改动。\n\n已拒绝 1 项改动。\n\n已取消 1 项改动。\n\n1 项改动已由新提案替代。", "summaries use host status and exclude other tasks");
  const partial = { ...task, taskIntent: { ...task.taskIntent, outcome: "partial", question: "剩余文档要移到哪个目录？" } };
  assert.equal(agentTaskResult(partial, deletions, "zh"), "已删除 2 个空文件夹，可在下方撤销。\n\n剩余文档要移到哪个目录？");
  assert.equal(agentTaskResult(partial, [], "zh"), partial.taskIntent.question);
  assert.equal(agentTaskResult(task, [], "zh"), "改动结果暂不可用，请重试加载。", "missing host records must not claim success or expose the audit trace");
  for (const outcome of [undefined, "model_output", "clarification_required"]) {
    const prose = { ...task, result: "请解释 `koinote.propose_operations` 如何使用。", taskIntent: outcome ? { outcome, inputVersion: 1 } : undefined };
    assert.equal(agentTaskResult(prose, deletions, "zh"), prose.result, "ordinary prose, genuine questions and legacy responses remain intact");
  }
  for (const locale of ["en", "fr", "ja"]) {
    const result = agentTaskResult(task, deletions, locale);
    assert.ok(result.includes("2"));
    assert.doesNotMatch(result, /koinote\.|private-id|宿主确认|已删除/);
  }
  console.log("Agent result regressions passed: audit receipts hidden, actual statuses, undo, task isolation, partial questions, legacy prose and locales.");
} finally { await rm(dir, { recursive: true, force: true }); }
