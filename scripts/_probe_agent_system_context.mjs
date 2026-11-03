// Explicitly opt-in, billable provider diagnosis using synthetic data only.
// AGENT_LLM_* is the local direct-model configuration. Confirm the Agent's
// actual upstream before attributing these results to its configured route.
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { loadEnv } from "vite";

if (process.env.KOINOTE_AGENT_LIVE !== "1") throw new Error("Set KOINOTE_AGENT_LIVE=1 for a billable provider probe");
const env = { ...loadEnv("development", process.cwd(), ""), ...process.env };
const base = new URL(env.AGENT_LLM_BASE_URL);
if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("Expected a plain HTTPS model base URL");
const endpoint = base.href.replace(/\/$/, "") + (base.pathname.replace(/\/$/, "").endsWith("/v1") ? "" : "/v1") + "/chat/completions";
if (!env.AGENT_LLM_API_KEY) throw new Error("Missing direct-model credential");
const models = (env.AGENT_SYSTEM_PROBE_MODELS || "deepseek-v4.1-flash,deepseek-v4.1-flash-1017").split(",");
const runID = randomUUID();
const output = env.AGENT_SYSTEM_PROBE_REPORT || "/tmp/koinote-provider-system-context.json";
const requestData = "Application reference data for this order: subtotal is 4931 yuan; discount is 1287 yuan. Use these numbers to answer the user.";
const question = "这个订单优惠后实付多少元？只返回金额数字。如果没有原价或优惠金额信息就返回 MISSING，不要猜测。";
const report = { runID, endpoint, expected: "3644", results: [] };
let saving = Promise.resolve();
const save = () => {
  const snapshot = JSON.stringify(report, null, 2);
  saving = saving.then(() => writeFile(output, snapshot, { mode: 0o600 }));
  return saving;
};
await save();
const variants = (env.AGENT_SYSTEM_PROBE_VARIANTS || "system_stream,system_json,user_stream").split(",");
if (variants.some(v => !["system_stream", "system_json", "user_stream"].includes(v))) throw new Error("Unknown probe variant");
const queue = models.flatMap(model => variants.map(variant => ({ model, variant })));
async function probe({ model, variant }) {
  const started = Date.now();
  const stream = variant.endsWith("stream");
  const messages = variant === "user_stream"
    ? [{ role: "user", content: requestData + "\n" + question }]
    : [{ role: "system", content: requestData }, { role: "user", content: question }];
  const body = JSON.stringify({ model, messages, stream, ...(stream ? { stream_options: { include_usage: true } } : {}) });
  const result = { model, variant, messages, requestSHA256: createHash("sha256").update(body).digest("hex") };
  try {
    console.log(`started ${model}/${variant}`);
    const response = await fetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.AGENT_LLM_API_KEY}` },
      body, redirect: "error", signal: AbortSignal.timeout(240000),
    });
    result.status = response.status;
    result.requestID = response.headers.get("x-request-id");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    let content = "", usage, finishReason;
    if (!stream || response.headers.get("content-type")?.includes("application/json")) {
      const data = await response.json();
      content = data.choices?.[0]?.message?.content ?? "";
      usage = data.usage;
      finishReason = data.choices?.[0]?.finish_reason;
    } else {
      let buffer = "";
      const decoder = new TextDecoder();
      const consume = line => {
        if (!line.startsWith("data:")) return;
        const value = line.slice(5).trim();
        if (!value || value === "[DONE]") return;
        const data = JSON.parse(value);
        if (data.error) throw new Error("Provider stream error");
        content += data.choices?.[0]?.delta?.content ?? "";
        usage = data.usage ?? usage;
        finishReason = data.choices?.[0]?.finish_reason ?? finishReason;
      };
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n"); buffer = lines.pop();
        for (const line of lines) consume(line);
      }
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer);
    }
    Object.assign(result, { content, usage, finishReason, passed: content.trim() === report.expected });
    console.log(`${result.passed ? "PASS" : "FAIL"} ${model}/${variant}: ${JSON.stringify(content)}`);
  } catch (error) { result.error = error.message; console.log(`ERROR ${model}/${variant}: ${error.message}`); }
  result.elapsedMs = Date.now() - started;
  report.results.push(result); await save();
}
await Promise.all(Array.from({ length: 2 }, async () => {
  for (;;) { const entry = queue.shift(); if (!entry) break; await probe(entry); }
}));
await save();
console.log(`Saved ${report.results.length} results to ${output}`);
process.exitCode = report.results.some(r => !r.passed) ? 1 : 0;
