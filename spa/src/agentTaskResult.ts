import type { AgentOperation } from "./agentSessions";
import type { WritingTask } from "./writingAgent";
import type { Locale } from "./i18n/types";
import { agentPanelText } from "./i18n/agentPanel";

/** Native operation reports are audit receipts, not assistant prose. Present
 * current host outcomes so approval, rejection and undo never show stale claims. */
export function agentTaskResult(
  task: Pick<WritingTask, "id" | "result" | "taskIntent">,
  operations: readonly AgentOperation[],
  locale: Locale,
): string {
  const outcome = task.taskIntent?.outcome;
  if (outcome !== "operations_reported" && outcome !== "partial") return task.result;

  const t = agentPanelText[locale];
  const own = operations.filter(op => op.taskId === task.id);
  const lines: string[] = [];
  const messages = {
    applied: t.resultApplied,
    pending: t.resultPending,
    undone: t.resultUndone,
    rejected: t.resultRejected,
    cancelled: t.resultCancelled,
    superseded: t.resultSuperseded,
  };
  for (const status of Object.keys(messages) as Array<keyof typeof messages>) {
    const matching = own.filter(op => op.status === status);
    if (!matching.length) continue;
    const template = status === "applied" && matching.every(op => op.input.kind === "delete_folder")
      ? t.resultFoldersDeleted : messages[status];
    lines.push(template.replace("{count}", String(matching.length)));
  }
  // A partially completed task may still have a genuine scope question.
  if (task.taskIntent?.question) lines.push(task.taskIntent.question);
  if (outcome === "partial" && task.taskIntent?.reason) {
    if (!lines.length) lines.push(t.resultUnavailable);
    lines.push(t.resultUnverified);
  }
  return lines.join("\n\n") || t.resultUnavailable;
}
