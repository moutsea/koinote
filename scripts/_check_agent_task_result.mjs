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
  const { agentTaskResult, agentTaskReply } = await import(pathToFileURL(outfile).href);
  const billingFile = join(dir, "billing.mjs");
  await build({ entryPoints: ["spa/src/agentTaskBilling.ts"], bundle: true, format: "esm", platform: "node", outfile: billingFile, logLevel: "silent" });
  const { agentTaskBilling } = await import(pathToFileURL(billingFile).href);
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
  for (const reason of ["step_limit", "tool_limit", "no_progress"]) {
    const stopped = { ...task, taskIntent: { outcome: "partial", reason, inputVersion: 1 } };
    assert.equal(agentTaskResult(stopped, deletions, "zh"), "已删除 2 个空文件夹，可在下方撤销。\n\n本轮已停止，其余工作尚未核实。");
    assert.equal(agentTaskResult(stopped, deletions.map(op => ({...op,status:"undone"})), "zh"), "已撤销 2 项改动。\n\n本轮已停止，其余工作尚未核实。");
  }
  assert.equal(agentTaskResult(task, [], "zh"), "改动结果暂不可用，请重试加载。", "missing host records must not claim success or expose the audit trace");
  const cover = {taskId: task.id, mimeType:"image/jpeg", name:"koi-cover-result.jpg"};
  const titles = "三个标题建议：\n1. 山间来信\n2. 云南慢行\n3. 把日子写成诗";
  const combined = {...task,taskIntent:{...task.taskIntent,reply:titles}};
  assert.equal(agentTaskReply(combined), titles, "final text is independent of operation audit receipts");
  assert.equal(agentTaskReply(task), "", "receipt-only results never manufacture a reply");
  assert.equal(agentTaskReply({...combined,taskIntent:{...combined.taskIntent,outcome:"model_output"}}), "", "ordinary prose must not render twice");
  assert.equal(agentTaskReply({...combined,taskIntent:{...combined.taskIntent,outcome:"partial"}}), titles, "a failed image must not swallow successful text");
  assert.equal(agentTaskResult(combined, deletions.map(op=>({...op,status:"undone"})), "zh", [cover]), "已保存到会话，可下载；尚未设为文章封面。\n\n已撤销 2 项改动。", "final text never overrides the current host state");
  assert.equal(agentTaskResult(task, [], "zh", [cover]), "已保存到会话，可下载；尚未设为文章封面。", "generated images use actual host artifacts for completion receipts");
  assert.equal(agentTaskResult(task, [], "zh", [{...cover,taskId:"another-task"}]), "改动结果暂不可用，请重试加载。", "other tasks cannot vouch for cover success");
  const failedCover = { ...task, taskIntent: {outcome:"partial",inputVersion:1}, coverGeneration: {status:"failed",errorCode:"insufficient_credits",chargedCredits:0} };
  const failure = agentTaskResult(failedCover, [], "zh");
  assert.match(failure, /可用 Credits 不足/);
  assert.match(failure, /新消息重试/);
  assert.doesNotMatch(failure, /重试加载|koinote\./);
  assert.match(agentTaskResult(failedCover, deletions, "zh"), /已删除 2 个空文件夹/);
  assert.match(agentTaskResult(failedCover, deletions, "zh"), /可用 Credits 不足/);
  assert.doesNotMatch(agentTaskResult(failedCover, [], "zh", [cover]), /不足|失败/ , "an actual artifact takes precedence over a stale failure");
  for (const [code, label] of [["service_unavailable","暂不可用"],["rate_limited","本小时"],["generation_failed","失败或超时"]]) {
    assert.match(agentTaskResult({...failedCover,coverGeneration:{...failedCover.coverGeneration,errorCode:code}}, [], "zh"), new RegExp(label));
  }
  const billed = {chargedCredits:20, reservedCredits:100, billingStatus:"needs_review",coverGeneration:{status:"completed",chargedCredits:20}};
  assert.equal(agentTaskBilling(billed,"zh"), "生图已扣 20 Credits · 文本费用尚未结算，等待核对。");
  assert.equal(agentTaskBilling({...billed,billingStatus:"settled",chargedCredits:22},"zh"), "生图已扣 20 Credits · 文本已扣 2 Credits");
  assert.equal(agentTaskBilling({...billed,billingStatus:"reserved"},"zh"), "生图已扣 20 Credits · 文本预留 100 Credits");
  assert.equal(agentTaskBilling({...billed,coverGeneration:undefined,chargedCredits:0},"zh"), "0 Credits · 文本费用尚未结算，等待核对。");
  for (const outcome of [undefined, "model_output", "clarification_required"]) {
    const prose = { ...task, result: "请解释 `koinote.propose_operations` 如何使用。", taskIntent: outcome ? { outcome, inputVersion: 1 } : undefined };
    assert.equal(agentTaskResult(prose, deletions, "zh"), prose.result, "ordinary prose, genuine questions and legacy responses remain intact");
  }
  for (const locale of ["en", "fr", "ja"]) {
    const result = agentTaskResult(task, deletions, locale);
    assert.ok(result.includes("2"));
    assert.doesNotMatch(result, /koinote\.|private-id|宿主确认|已删除/);
    assert.ok(agentTaskBilling(billed,locale).includes("20"));
    assert.doesNotMatch(agentTaskBilling(billed,locale), /No charge|Aucun débit|請求せず|\{credits\}/);
    assert.doesNotMatch(agentTaskResult(failedCover,[],locale), /koinote\.|重试加载|Credits 不足/);
  }
  console.log("Agent result regressions passed: audit receipts hidden, actual statuses, undo, task isolation, partial questions, legacy prose and locales.");
} finally { await rm(dir, { recursive: true, force: true }); }
