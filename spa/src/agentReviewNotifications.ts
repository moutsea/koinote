export const AGENT_REVIEW_STARTED_EVENT = "koinote:agent-review-started";
export const AGENT_REVIEW_OPEN_EVENT = "koinote:agent-review-open";

const REVIEW_TASKS_STORAGE_PREFIX = "koinote:agent-review-tasks:";
const REVIEW_OPEN_STORAGE_KEY = "koinote:agent-review-open";
export const MAX_STORED_REVIEW_TASKS = 12;

export type AgentReviewTaskStatus = "running" | "ready" | "failed" | "stale";

export type AgentReviewTask = {
  reviewId: string;
  documentId: string;
  status: AgentReviewTaskStatus;
  createdAt: string;
  expiresAt?: string;
  errorCode?: string | null;
  providerMode?: "builtin" | "byok";
};

export type AgentReviewStartedDetail = Pick<
  AgentReviewTask,
  "reviewId" | "documentId" | "createdAt" | "providerMode"
>;

export function publishAgentReviewStarted(
  detail: AgentReviewStartedDetail,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<AgentReviewStartedDetail>(AGENT_REVIEW_STARTED_EVENT, {
      detail,
    }),
  );
}

export function readAgentReviewTasks(accountKey: string): AgentReviewTask[] {
  if (typeof window === "undefined" || !accountKey) return [];
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(reviewTasksStorageKey(accountKey)) ?? "[]",
    );
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAgentReviewTask).slice(0, MAX_STORED_REVIEW_TASKS);
  } catch {
    return [];
  }
}

export function writeAgentReviewTasks(
  accountKey: string,
  tasks: AgentReviewTask[],
): void {
  if (typeof window === "undefined" || !accountKey) return;
  try {
    window.localStorage.setItem(
      reviewTasksStorageKey(accountKey),
      JSON.stringify(tasks.slice(0, MAX_STORED_REVIEW_TASKS)),
    );
  } catch {
    // Storage is an enhancement only. The in-memory tracker keeps working.
  }
}

export function requestAgentReviewOpen(task: {
  reviewId: string;
  documentId: string;
}): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(REVIEW_OPEN_STORAGE_KEY, JSON.stringify(task));
  } catch {
    // The event below still handles the currently mounted editor.
  }
  window.dispatchEvent(
    new CustomEvent(AGENT_REVIEW_OPEN_EVENT, { detail: task }),
  );
}

export function consumeAgentReviewOpen(documentId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(REVIEW_OPEN_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    if (!isReviewOpenRequest(value) || value.documentId !== documentId) {
      return null;
    }
    window.sessionStorage.removeItem(REVIEW_OPEN_STORAGE_KEY);
    return value.reviewId;
  } catch {
    try {
      window.sessionStorage.removeItem(REVIEW_OPEN_STORAGE_KEY);
    } catch {
      // Session storage may be unavailable in privacy-restricted webviews.
    }
    return null;
  }
}

export function reviewTasksStorageKey(accountKey: string): string {
  return REVIEW_TASKS_STORAGE_PREFIX + accountKey;
}

function isAgentReviewTask(value: unknown): value is AgentReviewTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<AgentReviewTask>;
  return (
    typeof task.reviewId === "string" &&
    typeof task.documentId === "string" &&
    typeof task.createdAt === "string" &&
    (task.expiresAt === undefined || typeof task.expiresAt === "string") &&
    (task.providerMode === undefined || task.providerMode === "builtin" || task.providerMode === "byok") &&
    (task.status === "running" ||
      task.status === "ready" ||
      task.status === "failed" ||
      task.status === "stale")
  );
}

function isReviewOpenRequest(
  value: unknown,
): value is { reviewId: string; documentId: string } {
  if (!value || typeof value !== "object") return false;
  const request = value as { reviewId?: unknown; documentId?: unknown };
  return (
    typeof request.reviewId === "string" &&
    typeof request.documentId === "string"
  );
}
