// Opt-in, billable synthetic diagnostics. The plan contains synthetic requests;
// credentials stay in environment variables and are never included in reports.
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";

if (process.env.KOINOTE_AGENT_LIVE !== "1") throw new Error("Set KOINOTE_AGENT_LIVE=1 for billable diagnosis");
const endpoint = new URL(process.env.AGENT_DIAG_ENDPOINT);
if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Expected a plain HTTPS endpoint");
if (!process.env.AGENT_DIAG_KEY) throw new Error("Missing provider credential");
const plan = JSON.parse(await readFile(process.env.AGENT_DIAG_PLAN, "utf8"));
if (plan.scope !== "synthetic-only" || !Array.isArray(plan.cases) || plan.cases.length > 50) throw new Error("Expected a bounded synthetic plan");
const output = process.env.AGENT_DIAG_REPORT;
if (!output) throw new Error("Missing report path");
const report = { runID: randomUUID(), endpoint: endpoint.href, scope: plan.scope, results: [] };
let saving = Promise.resolve();
function save() {
  const snapshot = JSON.stringify(report, null, 2);
  saving = saving.then(async () => {
    const temporary = `${output}.${report.runID}.tmp`;
    await writeFile(temporary, snapshot, { mode: 0o600 });
    await rename(temporary, output);
  });
  return saving;
}
async function run(entry) {
  const started = Date.now();
  const raw = JSON.stringify(entry.body);
  const result = { id: entry.id, factor: entry.factor, request: entry.body, requestSHA256: createHash("sha256").update(raw).digest("hex") };
  try {
    const response = await fetch(endpoint, { method: "POST", headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${process.env.AGENT_DIAG_KEY}`,
    }, body: raw, redirect: "error", signal: AbortSignal.timeout(180000) });
    result.status = response.status;
    result.requestID = response.headers.get("x-request-id");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    let content = "", calls = [], usage, finishReason, responseModel;
    if (response.headers.get("content-type")?.includes("application/json")) {
      const data = await response.json();
      content = data.choices?.[0]?.message?.content ?? "";
      calls = data.choices?.[0]?.message?.tool_calls ?? [];
      usage = data.usage;
      finishReason = data.choices?.[0]?.finish_reason;
      responseModel = data.model;
    } else {
      let buffer = "";
      const decoder = new TextDecoder();
      const consume = line => {
        if (!line.startsWith("data:")) return;
        const value = line.slice(5).trim();
        if (!value || value === "[DONE]") return;
        const data = JSON.parse(value);
        if (data.error) throw new Error("Provider stream error");
        const choice = data.choices?.[0];
        content += choice?.delta?.content ?? "";
        for (const call of choice?.delta?.tool_calls ?? []) {
          const target = calls[call.index] ??= { id: call.id, type: "function", function: { name: "", arguments: "" } };
          if (call.id) target.id = call.id;
          target.function.name += call.function?.name ?? "";
          target.function.arguments += call.function?.arguments ?? "";
        }
        usage = data.usage ?? usage;
        finishReason = choice?.finish_reason ?? finishReason;
        responseModel = data.model ?? responseModel;
      };
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n"); buffer = lines.pop();
        for (const line of lines) consume(line);
      }
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer);
    }
    const actual = calls.filter(Boolean).map(call => {
      try { return { name: call.function.name, value: JSON.parse(call.function.arguments) }; }
      catch { return { name: call.function.name, invalidArguments: call.function.arguments }; }
    });
    Object.assign(result, { content, actual, usage, finishReason, responseModel });
    console.log(`${entry.id}: ${JSON.stringify(actual.length ? actual.map(x => x.value ?? x.invalidArguments) : content)}`);
  } catch (error) {
    result.error = error.message;
    console.log(`${entry.id}: ${error.message}`);
  }
  result.elapsedMs = Date.now() - started;
  report.results.push(result);
  await save();
}
await save();
const queue = [...plan.cases];
await Promise.all(Array.from({ length: 2 }, async () => {
  for (;;) { const entry = queue.shift(); if (!entry) return; await run(entry); }
}));
await save();
console.log(`Saved ${report.results.length} responses to ${output}`);
process.exitCode = report.results.some(x => x.error) ? 1 : 0;
