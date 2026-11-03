import type { WritingEvent, WritingTask } from "./writingAgent";

export type ProgressAction =
  | "documents" | "folders" | "read" | "proposal" | "review"
  | "conversation" | "references" | "search" | "web" | "compute"
  | "save" | "work";
export type ProgressPhase =
  | ProgressAction | WritingTask["status"] | "thinking" | "finishing"
  | "retrying" | "cancelling" | "clarification" | "partial";

const actions = new Map<string, ProgressAction>([
  ["search_documents", "documents"], ["list_folders", "folders"],
  ["get_document", "read"], ["propose_operations", "proposal"],
  ["propose_document_change", "proposal"], ["validate_operation", "review"],
  ["get_operation_results", "review"], ["get_conversation", "conversation"],
  ["find_skills", "references"], ["load_skill", "references"],
  ["skill_view", "references"], ["skills_list", "references"],
  ["read_file", "references"], ["web_search", "search"],
  ["web_fetch", "web"], ["browser_markdown", "web"],
  ["browser_links", "web"], ["browser_scrape", "web"],
  ["browser_accessibility", "web"], ["browser_read", "web"],
  ["sandbox_compute", "compute"], ["save_artifact", "save"],
]);

export type ProgressStep = { seq: number; action: ProgressAction; failed: boolean };

/** Only describe observed activity. A successful tool call is not proof that
 * document changes were applied: its result may still require approval. */
export function agentProgress(
  task: Pick<WritingTask, "status" | "cancelRequested" | "taskIntent">,
  events: readonly WritingEvent[] = [],
) {
  let phase: ProgressPhase = "thinking";
  const steps: ProgressStep[] = [];
  // The API returns the latest 100 events in descending sequence order. Accept
  // either order and duplicates so polling/recovery cannot reverse the timeline.
  const ordered = [...new Map(events.map(event => [event.seq, event])).values()]
    .sort((a, b) => a.seq - b.seq);
  for (const { seq, event } of ordered) {
    if (["tool.started", "tool.completed", "tool.failed"].includes(event.type)) {
      const call = event.toolCall;
      const name = call && typeof call === "object" && "name" in call
        ? call.name : event.toolName;
      // Kernel MCP names are server.tool; also tolerate common __ namespaces.
      const tool = typeof name === "string" ? name.split(/\.|__/).at(-1) : "";
      const action = actions.get(tool ?? "") ?? "work";
      const failed = event.type === "tool.failed";
      const last = steps.at(-1);
      if (last?.action === action) {
        last.failed = failed;
      } else {
        steps.push({ seq, action, failed });
      }
      phase = failed ? "retrying" : event.type === "tool.started" ? action : "thinking";
    } else if (["model.started", "task.model_started", "model.completed", "run.started", "tool.skipped"].includes(event.type)) {
      phase = "thinking";
    } else if (["model.retrying", "model.fallback"].includes(event.type)) {
      phase = "retrying";
    } else if (["run.completed", "run.failed", "task.clarification"].includes(event.type)) {
      // The host still needs to reconcile results and billing. Only task.status
      // can tell the UI that this task finished or is waiting for approval.
      phase = "finishing";
    }
  }
  if (task.status !== "running") phase = task.status;
  if (task.status === "completed") {
    if (task.taskIntent?.outcome === "clarification_required") phase = "clarification";
    if (task.taskIntent?.outcome === "partial") phase = "partial";
  } else if (task.cancelRequested && !["failed", "cancelled"].includes(task.status)) {
    phase = "cancelling";
  }
  return { phase, steps: steps.slice(-4) };
}
