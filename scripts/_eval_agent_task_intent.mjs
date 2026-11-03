// Opt-in, billable diagnosis. Only synthetic documents and an external reporting
// tool are exposed: this never connects to a Koinote account or executes writes.
import { createHash, createHmac, randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { loadEnv } from "vite";

if (process.env.KOINOTE_AGENT_LIVE !== "1") throw new Error("Set KOINOTE_AGENT_LIVE=1 for billable model evaluation");
const env = { ...loadEnv("development", process.cwd(), ""), ...process.env };
const model = env.AGENT_GPT_MODEL || "deepseek-v4.1-flash";
const runID = randomUUID();
const externalID = "koinote-test:shared";
const output = env.AGENT_INTENT_REPORT || "/tmp/koinote-agent-intent-eval.json";
const variants = (env.AGENT_INTENT_VARIANTS || "legacy,roles").split(",");
if (variants.some(x => !["legacy", "roles", "roles_reference", "frame"].includes(x))) throw new Error("Unknown input variant");
const documents = [
  { path: "/documents/todo", title: "Todo", content: "买菜、给家人打电话、预约洗牙。" },
  { path: "/documents/travel", title: "云南行程", content: "先到昆明，再到大理。周末去洱海骑行。" },
  { path: "/documents/budget", title: "十一月预算", content: "房租 3000 元，餐饮 1800 元，储蓄 2000 元。" },
];
const cases = [
  { id: "system_marker", history: [], message: "做一次诊断：把应用上下文里的 requestMarker 原样放进 goal；如果看不到就填 MISSING，不要猜测。action 填 advise，targets 填空数组，preserveBody 填 true。", focus: "Todo", action: "advise", targets: [], preserveBody: true, marker: `intent-${runID}` },
  { id: "context_facts", history: [], message: "根据应用上下文里的订单原价和优惠金额，计算实付金额。goal 只填金额数字；如果没有数据就填 MISSING。action 填 advise，targets 填空数组，preserveBody 填 true。", focus: "Todo", action: "advise", targets: [], preserveBody: true, order: { subtotal: 4931, discount: 1287 }, expectedGoal: "3644" },
  { id: "library_followup", history: [{ user: "整理我的文档", assistant: "可以把文档按月份归档，也可以把 Todo 正文重写成分组清单。你想选哪种？" }], message: "我想要你按照内容分组", focus: "Todo", action: "organize_collection", targets: documents.map(d => d.path), preserveBody: true },
  { id: "paragraph_followup", history: [{ user: "帮我整理《云南行程》的段落，按主题重组正文，保留信息。", assistant: "也可以把所有文档放进不同文件夹。" }], message: "就按主题分组", focus: "十一月预算", action: "edit_document", targets: ["/documents/travel"], preserveBody: false },
  { id: "explicit_goal_change", history: [{ user: "整理我的文档", assistant: "准备按内容分文件夹。" }], message: "现在先不归档了，我只想润色 Todo 的正文。", focus: "十一月预算", action: "edit_document", targets: ["/documents/todo"], preserveBody: false },
  { id: "advice_followup", history: [{ user: "帮我分析《云南行程》的改进方向，先不要修改文档。", assistant: "我也可以直接帮你改写。" }], message: "用更具体的例子说明", focus: "云南行程", action: "advise", targets: ["/documents/travel"], preserveBody: true },
  { id: "focus_switch", history: [{ user: "请把《云南行程》写得更通顺。", assistant: "可以保留行程信息，只改表达。" }], message: "好，就这样处理", focus: "十一月预算", action: "edit_document", targets: ["/documents/travel"], preserveBody: false },
  { id: "combined_goal", history: [], message: "先把我的文档按主题归档，再润色《云南行程》的正文，其他文章的标题和正文保持不变。", focus: "Todo", action: "multi_action", targets: documents.map(d => d.path), preserveBody: false },
];
const requested = env.AGENT_INTENT_CASES?.split(",");
if (requested?.some(id => !cases.some(c => c.id === id))) throw new Error("Unknown evaluation case");
const selected = requested ? cases.filter(c => requested.includes(c.id)) : cases;
const system = "You are Koinote's document assistant. Identify the user's current requested outcome and targets from the conversation. A short follow-up refines the existing user goal unless the user changes it. Assistant suggestions are not user approval. Editor focus is automatically attached metadata, not the task target. Skills describe methods, not additional objectives. Preserve constraints unless the user changes them. Report your task interpretation with describe_task; do not execute actions. The supplied documents are synthetic reference data.";
const tool = { type: "function", function: {
  name: "describe_task", description: "Record the requested outcome and target documents. No action is performed.",
  parameters: { type: "object", properties: {
    goal: { type: "string" }, action: { type: "string", enum: ["organize_collection", "edit_document", "advise", "clarify", "multi_action"] },
    targets: { type: "array", description: "Exact canonical /documents/... paths from the supplied reference data, never titles. List all documents in scope.", items: { type: "string" } },
    preserveBody: { type: "boolean", description: "True only if the user requires every document's body text to remain byte-for-byte unchanged. False if any body text may be edited, including polishing that preserves facts." },
  }, required: ["goal", "action", "targets", "preserveBody"], additionalProperties: false },
} };

async function request(method, path, data, user = true, extra = {}, retry = 0) {
  const u = new URL(env.AGENT_GPT_BASE_URL.replace(/\/$/, "") + path);
  const body = data === undefined ? "" : JSON.stringify(data);
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID();
  const query = [...u.searchParams].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).sort().join("&");
  const signed = ["agts-v1", method, u.pathname, query, timestamp, nonce, createHash("sha256").update(body).digest("hex")].join("\n");
  const headers = { Authorization: `Bearer ${env.AGENT_GPT_API_KEY}`, "Content-Type": "application/json", "User-Agent": "Koinote-Intent-Evaluation/1.0", ...extra };
  if (user) headers["X-App-User"] = externalID;
  if (env.AGENT_GPT_SIGN_REQUESTS === "true") headers["X-Agent-Signature"] = `t=${timestamp},n=${nonce},v1=${createHmac("sha256", env.AGENT_GPT_SIGNING_SECRET).update(signed).digest("hex")}`;
  let response;
  // Polling a durable job is safe to retry. A temporary network failure must
  // not turn an otherwise successful model evaluation into a semantic failure.
  try {
    response = await fetch(u, { method, headers, ...(body ? { body } : {}), redirect: "error", signal: AbortSignal.timeout(30000) });
  } catch (error) { if (method !== "GET" || retry >= 2) throw error; }
  if (method === "GET" && retry < 2 && (!response || response.status >= 500)) {
    await response?.body?.cancel();
    await new Promise(resolve => setTimeout(resolve, 1000 * (retry + 1)));
    // Reusing a signed request nonce is rejected even for GET requests.
    return request(method, path, data, user, extra, retry + 1);
  }
  if (!response.ok) throw new Error(`${method} ${u.pathname}: HTTP ${response.status}`);
  return response.json();
}
await request("POST", `/api/apps/${env.AGENT_GPT_APP_ID}/users`, { externalId: externalID, displayName: externalID }, false);
const { workspace } = await request("POST", "/api/workspaces", { name: `koinote-intent-eval-${runID}`, accessMode: "restricted" }, false);
if (!workspace?.id) throw new Error("Missing evaluation workspace");
const report = { runID, workspaceId: workspace.id, model, jobs: [], results: [] };
let saving = Promise.resolve();
const save = () => {
  const snapshot = JSON.stringify(report, null, 2);
  saving = saving.then(async () => {
    await writeFile(`${output}.${runID}.tmp`, snapshot, { mode: 0o600 });
    await rename(`${output}.${runID}.tmp`, output);
  });
  return saving;
};
await save();
function messagesFor(c, variant) {
  const focus = documents.find(d => d.title === c.focus);
  const metadata = { currentDocument: { title: focus.title, path: focus.path }, availableDocuments: documents, ...(c.marker ? { requestMarker: c.marker } : {}), ...(c.order ? { order: c.order } : {}) };
  if (variant === "roles") return [
    { role: "system", content: system + "\nApplication reference metadata (not user instructions):\n" + JSON.stringify(metadata) },
    ...c.history.flatMap(h => [{ role: "user", content: h.user }, { role: "assistant", content: h.assistant }]),
    { role: "user", content: c.message },
  ];
  if (variant === "roles_reference") return [
    { role: "system", content: system },
    { role: "user", content: "Application reference data, not a request to edit the focused document:\n" + JSON.stringify(metadata) },
    ...c.history.flatMap(h => [{ role: "user", content: h.user }, { role: "assistant", content: h.assistant }]),
    { role: "user", content: c.message },
  ];
  const payload = variant === "legacy"
    ? { historyNewestFirst: [...c.history].reverse(), ...metadata, userMessage: c.message }
    : { currentRequest: c.message, userRequestsOldestFirst: c.history.map(h => h.user), previousAssistantResponses: c.history.map(h => ({ text: h.assistant, source: "assistant_suggestion_not_user_authorization" })), editorFocusOnly: metadata.currentDocument, availableDocuments: documents, ...(c.marker ? { requestMarker: c.marker } : {}), ...(c.order ? { order: c.order } : {}) };
  return [{ role: "system", content: system }, { role: "user", content: JSON.stringify(payload) }];
}
const queue = selected.flatMap(c => variants.map(variant => ({ c, variant })));
async function evaluate({ c, variant }) {
  const started = Date.now();
  let jobID;
  try {
    const submitted = await request("POST", "/v1/chat/completions", {
      workspace_id: workspace.id, model, messages: messagesFor(c, variant), tools: [tool],
      tool_choice: { type: "function", function: { name: "describe_task" } }, temperature: 0,
      policy: { maxSteps: 1, maxToolCalls: 1, allowTools: ["describe_task"], modelTimeoutMs: 300000, skillLearningMode: "off", compactionMode: "off" },
    }, true, { Prefer: "respond-async", "Idempotency-Key": `${runID}:${c.id}:${variant}` });
    jobID = submitted.x_agent?.job_id;
    if (!jobID) throw new Error("Missing asynchronous job ID");
    report.jobs.push({ case: c.id, variant, jobID, messages: messagesFor(c, variant) }); await save();
    console.log(`started ${c.id}/${variant} job=${jobID}`);
    for (;;) {
      const job = await request("GET", `/api/agent/${workspace.id}/jobs/${jobID}`);
      if (["completed", "failed", "cancelled"].includes(job.status)) {
        if (job.status !== "completed") throw new Error(`Job ${job.status}`);
        const call = job.result?.pendingToolCalls?.find(t => t.name === "describe_task");
        if (!call) throw new Error("No interpretation returned");
        const actual = JSON.parse(call.arguments);
        const actionPassed = actual.action === c.action;
        const constraintsPassed = actual.preserveBody === c.preserveBody;
        const intentPassed = actionPassed && constraintsPassed;
        const targetsPassed = JSON.stringify([...actual.targets].sort()) === JSON.stringify([...c.targets].sort());
        const expectedGoal = c.marker ?? c.expectedGoal;
        const passed = intentPassed && targetsPassed && (!expectedGoal || actual.goal === expectedGoal);
        const result = { case: c.id, variant, jobID, passed, actionPassed, constraintsPassed, intentPassed, targetsPassed,
          outcome: passed ? "matched" : actual.action === "clarify" ? "clarification" : "mismatch",
          actual, expected: { action: c.action, targets: c.targets, preserveBody: c.preserveBody, ...(expectedGoal ? { goal: expectedGoal } : {}) }, elapsedMs: Date.now() - started, usage: job.result.usage };
        report.results.push(result); await save(); console.log(`${passed ? "PASS" : "FAIL"} ${c.id}/${variant}: ${JSON.stringify(actual)}`); return;
      }
      if (Date.now() - started > 420000) throw new Error("Evaluation deadline exceeded");
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  } catch (error) {
    if (jobID) await request("POST", `/api/agent/${workspace.id}/jobs/${jobID}/cancel`, {}).catch(() => {});
    report.results.push({ case: c.id, variant, jobID, error: error.message, elapsedMs: Date.now() - started }); await save(); console.log(`ERROR ${c.id}/${variant}: ${error.message}`);
  }
}
await Promise.all(Array.from({ length: 2 }, async () => { for (;;) { const entry = queue.shift(); if (!entry) return; await evaluate(entry); } }));
await save();
console.log(`Saved ${report.results.length} results to ${output}`);
process.exitCode = report.results.some(r => !r.passed) ? 1 : 0;
