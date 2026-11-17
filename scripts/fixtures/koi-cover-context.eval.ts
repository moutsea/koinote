// Explicit semantic acceptance: real configured model and production kernel;
// synthetic documents and operation receipts, no production document writes.
import { afterAll, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { AgentKernel } from "../../../tools/agent-gpt/src/core/agent";
import { InMemoryWorkspaceFS } from "../../../tools/agent-gpt/src/workspace/in-memory";
import { InMemorySkillStore } from "../../../tools/agent-gpt/src/core/skills";
import { applicationChannel } from "../../../tools/agent-gpt/eval/agent-channel";
import type { AgentRunInput, ToolDefinition } from "../../../tools/agent-gpt/src/core/types";
import type { TaskBinding, TaskOperationStatus } from "../../../tools/agent-gpt/src/core/task-intent";

const fixture = JSON.parse(await readFile(process.env.KOINOTE_CONTEXT_FIXTURE!, "utf8"));
const channel = await applicationChannel();
const records: Record<string, unknown>[] = [];
afterAll(async () => {
  await writeFile(process.env.KOINOTE_CONTEXT_REPORT!, JSON.stringify({
    boundary: "Real model and Agent kernel; host input exported from isolated PostgreSQL using the supplied conversation fragment. Article, prior inferred state and tool receipts are synthetic. Earlier topic-selection turns and the original production trace are unavailable. This is semantic replay, not production acceptance.",
    channel: channel.manifest, jobs: channel.jobs, records,
  }, null, 2), { mode: 0o600 });
});

const lanes = process.env.KOINOTE_CONTEXT_LANES?.split(",") ?? ["baseline", "fixed"];
const interpretationOnly = process.env.KOINOTE_CONTEXT_INTERPRET_ONLY === "1";
const stopBeforeExecution = new Error("Semantic probe stops before execution");
for (const lane of lanes) it(lane + ": supplied cover follow-up", async () => {
  const input = structuredClone(fixture[lane === "ambiguous" ? "fixed" : lane]) as AgentRunInput;
  if (lane === "ambiguous") {
    const [first, assistant, latest] = input.initialMessages!;
    first.content = "帮我比较设置当前文章封面和设置公众号渠道这两种方案，先不执行，等我选定";
    assistant.content = "两种方案都可以：一是把生成图设为当前文章封面，二是调整公众号发布渠道。需要选定具体项。";
    latest.content = "帮我设置";
    const sources = [{ messageId: first.id!, quote: first.content }];
    input.taskContext!.state = { goal: { text: first.content, sources }, targets: [{ unresolved: "文章封面或公众号渠道，尚未选择", sources }], constraints: [{ text: "先不执行，等我选定", sources: [{ messageId: first.id!, quote: "先不执行，等我选定" }], resourceIds: [], forbiddenEffects: ["execute"] }], questions: [], suggestions: [] };
  }
  input.tenantId = input.workspaceId = input.userId = "isolated-context-evaluation";
  input.policy = { ...input.policy, maxSteps: 5, maxToolCalls: 10, maxContextChars: 200000, modelTimeoutMs: 180000 };
  const document = fixture.document;
  const path = `/documents/${document.docId}`;
  let applied = 0, regenerated = 0, bodyChanges = 0;
  const interpretations: unknown[] = [];
  const responses: unknown[] = [];
  const events: unknown[] = [];
  const proof = (task: TaskBinding, resourceId: string, kind: "execute" | "create" | "update_content") => ({
    taskId: task.taskId, sessionId: task.sessionId, version: task.version,
    currentMessageId: task.currentMessageId, effects: [{ resourceId, kind, revision: "1" }], token: "synthetic-host-proof",
  });
  const tools: ToolDefinition[] = [
    { name: "koinote.get_document", description: "Read the current saved article, including its canonical path, revision and cover settings.",
      inputSchema: z.object({ path: z.string().optional(), offset: z.number().optional(), limit: z.number().optional() }), intent: { kind: "read" },
      execute: async () => JSON.stringify({ ...document, path, nextOffset: document.content.length, hasMore: false, coverMode: applied ? "article" : "default", coverImageSource: applied ? "/images/synthetic-cover.jpg" : "" }) },
    { name: "koinote.get_conversation", description: "Read earlier user/assistant messages and authoritative operation receipts.",
      inputSchema: z.object({ cursor: z.string().optional(), taskId: z.string().optional(), limit: z.number().optional() }), intent: { kind: "read" },
      execute: async () => JSON.stringify({ historyNewestFirst: input.initialMessages, ...(lane === "fixed" ? { artifacts: [fixture.artifact] } : {}) }) },
    { name: "koinote.generate_cover", description: "Generate one NEW cover image, costs 20 additional Credits. Does not set the article cover or modify the article.",
      inputSchema: z.object({ prompt: z.string(), ratio: z.string().optional() }),
      intent: { kind: "guarded", prepare: async (_args, task) => proof(task, "new:synthetic-cover", "create"), result: () => "applied" as TaskOperationStatus },
      execute: async () => { regenerated++; return JSON.stringify({ status: "generated_not_applied", operationStatus: "applied", artifact: fixture.artifact, credits: 20 }); } },
    { name: "koinote.propose_document_change", description: "Propose a complete article TITLE/BODY replacement. This tool cannot change cover metadata.",
      inputSchema: z.object({ docId: z.string(), expectedRevision: z.number(), title: z.string(), content: z.string(), explanation: z.string() }),
      intent: { kind: "guarded", prepare: async (_args, task) => proof(task, path, "update_content"), result: () => "applied" as TaskOperationStatus },
      execute: async () => { bodyChanges++; return JSON.stringify({ operationStatus: "applied" }); } },
  ];
  if (lane === "fixed") tools.push({ name: "koinote.set_document_cover",
    description: "Set an existing generated image from this conversation as the article cover. Reuse artifactId without regeneration or additional image Credits. Preserve title and body. The host handles approval.",
    inputSchema: z.object({ path: z.string(), expectedRevision: z.number(), artifactId: z.string() }),
    intent: { kind: "guarded", prepare: async (args, task) => {
      const value = args as { artifactId: string; path: string };
      if (value.artifactId !== fixture.artifact.id || value.path !== path) throw new Error("Wrong synthetic image/article");
      return proof(task, path, "execute");
    }, result: () => "applied" as TaskOperationStatus },
    execute: async () => { applied++; return JSON.stringify({ operationStatus: "applied", status: "saved", path, revision: document.revision + 1 }); },
  });
  const recordIndex = records.length;
  try {
    const result = await new AgentKernel({ workspace: new InMemoryWorkspaceFS(), skills: new InMemorySkillStore(), tools,
      model: { generate: async request => {
        const internal = request.messages[0]?.content.startsWith("INTERNAL PROTOCOL STAGE");
        if (interpretationOnly && !internal) throw stopBeforeExecution;
        const response = await channel.provider.generate(request);
        responses.push({ internal, text: response.text, tools: response.toolCalls?.map(call => call.name) });
        if (internal) {
          const query = request.messages.at(-1)?.content ?? "";
          if (query.includes("Return change, changeSources and state")) {
            try { interpretations.push(JSON.parse(response.text ?? "")); } catch { interpretations.push({ invalid: true }); }
          }
        }
        return response;
      } }, onEvent: event => { if (event.type.startsWith("task.")) events.push(event); },
    }).run(input);
    records.push({ lane, applied, regenerated, bodyChanges, text: result.text, task: result.task, interpretations, responses, usage: result.usage, events });
    expect(regenerated).toBe(0);
    expect(bodyChanges).toBe(0);
    if (lane === "ambiguous") {
      expect(result.task?.outcome).toBe("clarification_required");
      expect(result.task?.question).toBeTruthy();
      expect(applied).toBe(0);
      return;
    }
    if (interpretationOnly) {
      expect(result.task?.question).toBeUndefined();
      throw new Error("Interpretation-only probe unexpectedly reached terminal execution");
    }
    if (lane === "fixed") {
      expect(result.task?.question).toBeUndefined();
      expect(applied).toBe(1);
    }
  } catch (error) {
    if (interpretationOnly && error === stopBeforeExecution) {
      records.push({ lane, interpretationOnly: true, interpretations, responses, events });
      const effective = interpretations.at(-1) as { state: { goal: { text: string }; questions: string[] } };
      expect(lane).not.toBe("ambiguous");
      expect(effective.state.questions).toEqual([]);
      expect(effective.state.goal.text).not.toBe(input.taskContext?.state?.goal.text);
      return;
    }
    const failure = { lane, applied, regenerated, bodyChanges, interpretations, responses, events, error: error instanceof Error ? error.message : "Unknown error" };
    if (records.length > recordIndex) Object.assign(records[recordIndex], failure);
    else records.push(failure);
    throw error;
  }
}, 600000);
