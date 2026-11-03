import { apiJson, type Document } from "./api";
import type { WritingTask } from "./writingAgent";

export type AgentPermission = "review" | "assist" | "full";
export type AgentSession = {
  writeDocumentId?: string;
  id: string;
  title: string;
  permission: AgentPermission;
  revision: number;
  updatedAt: string;
  usedBytes: number;
  chargedCredits: number;
  activeTasks: number;
  pendingOperations: number;
};
export type AgentOperation = {
  id: string;
  taskId: string;
  hash: string;
  input: {
    key: string;
    kind: "update" | "create" | "move" | "trash" | "folder" | "delete_folder";
    path?: string;
    title?: string;
    content?: string;
    explanation: string;
    folderId?: string;
    targetId?: string;
  };
  before: { folder?: { folderId: string; name: string; parentFolderId: string; organizerKind: string }; document: Document; folderId: string; path: string; sortOrder?: number } | null;
  status:
    | "pending"
    | "applied"
    | "rejected"
    | "cancelled"
    | "superseded"
    | "undone";
  approval: string;
  reason: string;
  result: {
    docId?: string;
    folderId?: string;
    revision?: number;
    undoRevision?: number;
    sortOrder?: number;
    path?: string;
  } | null;
  createdAt: string;
};
export type AgentArtifact = {
  id: string;
  taskId: string;
  name: string;
  mimeType: string;
  bytes: number;
};
export type AgentSessionPage = {
  artifacts: AgentArtifact[];
  session: AgentSession;
  tasks: WritingTask[];
  operations: AgentOperation[];
  nextCursor: string;
};
const base = "/api/agent/sessions";
export const listAgentSessions = (q = "", sort = "recent", cursor = "") =>
  apiJson<{
    sessions: AgentSession[];
    nextCursor: string;
    activity?: { running: number; pending: number };
  }>(`${base}?${new URLSearchParams({ q, sort, cursor })}`);
export const getAgentSession = (id: string, cursor = "") =>
  apiJson<AgentSessionPage>(
    `${base}/${encodeURIComponent(id)}?${new URLSearchParams({ cursor })}`,
  );
export const openArticleAgentSession = async (docId: string) => {
  const page = await apiJson<AgentSessionPage>(`/api/documents/${encodeURIComponent(docId)}/koi-session`, { method: "POST" });
  if (page.session?.writeDocumentId !== docId) throw new Error("article_session_unavailable");
  return page;
};
export const createAgentSession = (id: string) =>
  apiJson<AgentSessionPage>(base, {
    method: "POST",
    body: JSON.stringify({ id }),
  });
export const updateAgentSession = (
  id: string,
  input: { revision: number; title?: string; permission?: AgentPermission },
) =>
  apiJson<AgentSessionPage>(`${base}/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
export const deleteAgentSession = (id: string) =>
  apiJson<void>(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" });
export const getAgentSessionSettings = () =>
  apiJson<{ permission: AgentPermission }>("/api/agent/session-settings");
export const updateAgentSessionSettings = (permission: AgentPermission) =>
  apiJson<{ permission: AgentPermission }>("/api/agent/session-settings", {
    method: "PUT",
    body: JSON.stringify({ permission }),
  });
export type AgentTaskRequest = {
  requestId: string;
  message: string;
  context?: { title: string; path: string };
  skillRepositoryId: number;
  skillPath: string;
  supersedeTaskId?: string;
};

// The document title is display metadata and may change as the accepted task
// runs. A retry must keep the original payload, including its original title.
export function agentTaskIntentFingerprint(
  input: Omit<AgentTaskRequest, "requestId">,
): string {
  return JSON.stringify([
    input.message,
    input.context?.path ?? "",
    input.skillRepositoryId,
    input.skillPath,
    input.supersedeTaskId ?? "",
  ]);
}

export const sendAgentMessage = (id: string, input: AgentTaskRequest) =>
  apiJson<{ task: WritingTask }>(`${base}/${encodeURIComponent(id)}/tasks`, {
    method: "POST",
    body: JSON.stringify(input),
  });
export const actOnAgentOperation = (
  operation: AgentOperation,
  action: "approve" | "reject" | "undo",
) =>
  apiJson<{ operation: AgentOperation }>(
    `/api/agent/operations/${encodeURIComponent(operation.id)}/${action}`,
    { method: "POST", body: JSON.stringify({ hash: operation.hash }) },
  );

export const actOnAgentOperationBatch = (
  taskId: string,
  operations: AgentOperation[],
  action: "approve" | "reject" | "undo",
) => apiJson<{ operations: AgentOperation[] }>(
  `/api/agent/tasks/${encodeURIComponent(taskId)}/operations/${action}`,
  { method: "POST", body: JSON.stringify({ operations: operations.map(({ id, hash }) => ({ id, hash })) }) },
);

export function agentApprovalBatch(operations: AgentOperation[], taskId: string) {
  const pending = operations.filter((op) => op.taskId === taskId && op.status === "pending");
  return pending.length > 1 || pending.some((op) => (op.input.kind === "folder" || op.input.kind === "delete_folder")) ? pending : [];
}

export {
  AGENT_PANEL_OPEN,
  AGENT_DOCUMENT_CHANGED,
  getAgentFocus,
  setAgentFocus,
  subscribeAgentFocus,
  notifyAgentDocumentChange,
} from "./agentContext";
export type { AgentFocus } from "./agentContext";

export type AgentPanelLayout = {
  open: boolean;
  height: number;
  tabs: string[];
  active: string;
  drafts: Record<string, string>;
  draftIds: Record<string, string>;
  draftSubmissions: Record<string, string>;
  skills: Record<string, string>;
  adjusting: Record<string, string>;
  ignored: Record<string, string>;
  scroll: Record<string, number>;
};
const emptyLayout = (): AgentPanelLayout => ({
  open: false,
  height: 420,
  tabs: [],
  active: "",
  drafts: {},
  draftIds: {},
  draftSubmissions: {},
  skills: {},
  adjusting: {},
  ignored: {},
  scroll: {},
});
export function readAgentPanelLayoutSnapshot(account: string) {
  let own: string | null = null;
  let sharedRaw: string | null = null;
  try {
    own = sessionStorage.getItem(`koinote:agent-panel-window:${account}`);
  } catch {}
  try {
    sharedRaw = localStorage.getItem(`koinote:agent-panel:${account}`);
  } catch {}
  const raw = own ?? sharedRaw;
  return { raw, sharedRaw, layout: parseAgentPanelLayout(raw) };
}
export function readAgentPanelLayout(
  account: string,
  pendingAdjustments: Record<string, string> = {},
  snapshot = readAgentPanelLayoutSnapshot(account),
): AgentPanelLayout {
  return parseAgentPanelLayout(snapshot.raw, pendingAdjustments);
}
function parseAgentPanelLayout(
  text: string | null,
  pendingAdjustments: Record<string, string> = {},
): AgentPanelLayout {
  try {
    const raw = JSON.parse(text ?? "null");
    if (!raw || !Array.isArray(raw.tabs)) return emptyLayout();
    return {
      open: raw.open === true,
      height: Math.min(800, Math.max(220, Number(raw.height) || 420)),
      tabs: raw.tabs
        .filter((id: unknown) => typeof id === "string")
        .slice(0, 50),
      active: typeof raw.active === "string" ? raw.active : "",
      drafts: stringRecord(raw.drafts),
      draftIds: stringRecord(raw.draftIds),
      draftSubmissions: stringRecord(raw.draftSubmissions),
      skills: stringRecord(raw.skills),
      // Older clients only persisted the adjustment target in pending requests.
      // An explicit empty map means the user cancelled it; do not resurrect it.
      adjusting:
        raw.adjusting === undefined
          ? pendingAdjustments
          : stringRecord(raw.adjusting),
      ignored: stringRecord(raw.ignored),
      scroll: Object.fromEntries(
        Object.entries(raw.scroll ?? {}).filter(
          (entry): entry is [string, number] =>
            typeof entry[1] === "number" &&
            Number.isFinite(entry[1]) &&
            entry[1] >= 0,
        ),
      ),
    };
  } catch {
    return emptyLayout();
  }
}
function stringRecord(raw: unknown): Record<string, string> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? Object.fromEntries(
        Object.entries(raw).filter(([, value]) => typeof value === "string"),
      )
    : {};
}
export async function withAgentStorageLock<T>(
  account: string,
  action: () => T | Promise<T>,
): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks)
    return navigator.locks.request(`koinote:agent-storage:${account}`, action);
  return action();
}

function mergeLayoutRecord<T>(
  shared: Record<string, T>,
  previous: Record<string, T>,
  next: Record<string, T>,
) {
  const merged = { ...shared };
  for (const id of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (previous[id] === next[id]) continue;
    // Preserve the other window's scroll position when both changed it.
    if (shared[id] !== previous[id] && shared[id] !== next[id]) continue;
    if (next[id] === undefined) delete merged[id];
    else merged[id] = next[id];
  }
  return merged;
}

function storedComposerUnchanged(before: string | null, after: string | null, id: string) {
  try {
    const previous = JSON.parse(before ?? "null") ?? {};
    const current = JSON.parse(after ?? "null") ?? {};
    return ["drafts", "draftIds", "draftSubmissions", "skills", "adjusting", "ignored"].every((field) =>
      // A missing adjustment map enables legacy recovery; an explicit empty
      // map cancels it. Preserve that distinction when another window writes.
      (previous[field] === undefined) === (current[field] === undefined) &&
      previous[field]?.[id] === current[field]?.[id],
    );
  } catch {
    return false;
  }
}

export async function saveAgentPanelLayout(
  account: string,
  layout: AgentPanelLayout,
  previous: AgentPanelLayout,
  migration?: { sharedRaw: string | null },
) {
  try {
    // Reload/remount restores this window's own draft even when two windows
    // edit the same session differently. New windows start from shared state.
    sessionStorage.setItem(
      `koinote:agent-panel-window:${account}`,
      JSON.stringify(layout),
    );
  } catch {}
  try {
    await withAgentStorageLock(account, () => {
      const key = `koinote:agent-panel:${account}`;
      const sharedRaw = localStorage.getItem(key);
      const shared = parseAgentPanelLayout(sharedRaw);
      const merged = { ...shared };
      if (layout.open !== previous.open) merged.open = layout.open;
      if (layout.height !== previous.height) merged.height = layout.height;
      if (layout.active !== previous.active) merged.active = layout.active;
      const removed = new Set(
        previous.tabs.filter((id) => !layout.tabs.includes(id)),
      );
      const added = layout.tabs.filter((id) => !previous.tabs.includes(id));
      merged.tabs = [
        ...new Set([...shared.tabs.filter((id) => !removed.has(id)), ...added]),
      ];
      const composerFields = ["drafts", "draftIds", "draftSubmissions", "skills", "adjusting", "ignored"] as const;
      const sessions = new Set(
        composerFields.flatMap((field) => [
          ...Object.keys(previous[field]), ...Object.keys(layout[field]),
        ]),
      );
      for (const field of composerFields) merged[field] = { ...shared[field] };
      for (const id of sessions) {
        if (composerFields.every((field) => previous[field][id] === layout[field][id]))
          continue;
        // Publish an actual edit as one composer, so a fresh window cannot pair
        // one window's text with another's Skill or adjustment target. Clearing
        // a completed draft or migrating an older one is conditional on the
        // entire persisted baseline matching. Migration is not a user edit.
        const onlySubmissionChanged = composerFields.every((field) =>
          field === "draftSubmissions" || previous[field][id] === layout[field][id],
        );
        if (
          (migration || !layout.drafts[id] || onlySubmissionChanged) &&
          composerFields.some((field) => shared[field][id] !== previous[field][id])
        ) continue;
        if (migration && !storedComposerUnchanged(migration.sharedRaw, sharedRaw, id))
          continue;
        for (const field of composerFields) {
          if (layout[field][id] === undefined) delete merged[field][id];
          else merged[field][id] = layout[field][id];
        }
      }
      merged.scroll = mergeLayoutRecord(
        shared.scroll, previous.scroll, layout.scroll,
      );
      if (JSON.stringify(merged) !== JSON.stringify(shared))
        localStorage.setItem(key, JSON.stringify(merged));
    });
  } catch {
    /* Cloud history is independent of local layout persistence. */
  }
}
