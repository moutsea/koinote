import { apiJson, type Document } from "./api";

export type WritingTask = {
  intentVersion?: number;
  taskIntent?: { outcome: "model_output" | "clarification_required" | "operations_reported" | "partial"; question?: string; reason?: "step_limit" | "tool_limit" | "no_progress"; inputVersion: number };
  id: string;
  message: string;
  source: { path?: string; docId: string; title: string; content: string; revision: number };
  status:
    | "preparing"
    | "queued"
    | "running"
    | "awaiting_approval"
    | "completed"
    | "failed"
    | "cancelled";
  result: string;
  error: string;
  proposal: {
    title: string;
    content: string;
    explanation: string;
    hash: string;
  } | null;
  appliedDocument: Document | null;
  reservedCredits: number;
  chargedCredits: number;
  billingStatus: string;
  usage: {
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
  } | null;
  cancelRequested: boolean;
  createdAt: string;
};
export type WritingEvent = {
  seq: number;
  event: { type: string; [key: string]: unknown };
};
export const writingFinished = (task: WritingTask) =>
  ["completed", "failed", "cancelled"].includes(task.status);
export const getWritingConfig = () =>
  apiJson<{
    enabled: boolean;
    reservedCredits: number;
    skills: { repositoryId: number; name: string; path: string }[];
  }>("/api/writing-agent/config");
export const listWritingTasks = (docId: string) =>
  apiJson<{ tasks: Pick<WritingTask, "id" | "message" | "status" | "createdAt">[] }>(
    `/api/writing-agent/tasks?docId=${encodeURIComponent(docId)}`,
  );
export const getWritingTask = (id: string) =>
  apiJson<{ task: WritingTask; events: WritingEvent[] }>(
    `/api/writing-agent/tasks/${encodeURIComponent(id)}`,
  );
export const createWritingTask = (input: {
  requestId: string;
  docId: string;
  expectedRevision: number;
  message: string;
  skillRepositoryId: number;
  skillPath: string;
}) =>
  apiJson<{ task: WritingTask }>("/api/writing-agent/tasks", {
    method: "POST",
    body: JSON.stringify(input),
  });
export const cancelWritingTask = (id: string) =>
  apiJson(`/api/writing-agent/tasks/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
  });
export const applyWritingTask = (task: WritingTask) =>
  apiJson<{ document: Document }>(
    `/api/writing-agent/tasks/${encodeURIComponent(task.id)}/apply`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedRevision: task.source.revision,
        proposalHash: task.proposal?.hash,
      }),
    },
  );
