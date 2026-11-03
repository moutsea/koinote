// Frozen localStorage-only request cache from before the IndexedDB migration.
// Keep this protocol unchanged: mixed-version tests need an actual old writer.
import {
  agentTaskIntentFingerprint,
  withAgentStorageLock,
  type AgentPanelLayout,
  type AgentTaskRequest,
} from "../../spa/src/agentSessions";

export type PendingAgentRequest = {
  sessionId: string;
  draftId?: string;
  fingerprint: string;
  input: AgentTaskRequest;
};
type StoredAgentRequest = PendingAgentRequest & { completed?: true };

const prefix = (account: string) => `koinote:agent-request-v2:${account}:`;
const keyFor = (account: string, request: PendingAgentRequest) =>
  `${prefix(account)}${request.sessionId}:${request.input.requestId}`;

function parse(
  raw: string | null,
  sessionId?: string,
): StoredAgentRequest | undefined {
  try {
    const value = JSON.parse(raw ?? "null");
    if (
      typeof (sessionId ?? value?.sessionId) === "string" &&
      typeof value?.input?.requestId === "string" &&
      typeof value?.input?.message === "string"
    )
      return {
        sessionId: sessionId ?? value.sessionId,
        ...(typeof value.draftId === "string" ? { draftId: value.draftId } : {}),
        fingerprint: agentTaskIntentFingerprint(value.input),
        input: value.input,
        ...(value.completed === true ? { completed: true } : {}),
      };
  } catch {}
}

function records(storage: Storage, account: string, completed = false) {
  const found: PendingAgentRequest[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(prefix(account))) continue;
    const request = parse(storage.getItem(key));
    if (request && (request.completed === true) === completed) {
      const { completed: _completed, ...input } = request;
      found.push(input);
    }
  }
  return found;
}

export function readPendingAgentRequests(account: string): PendingAgentRequest[] {
  const legacy = new Map<string, PendingAgentRequest>();
  try {
    const entries = JSON.parse(
      localStorage.getItem(`koinote:agent-requests:${account}`) ?? "[]",
    );
    if (Array.isArray(entries)) {
      for (const entry of entries.slice(0, 50)) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
        const request = parse(JSON.stringify(entry[1]), entry[0]);
        if (request) legacy.set(entry[0], request);
      }
    }
  } catch {}
  try {
    // Read both previous formats without rewriting another window's records.
    const oldPrefix = `koinote:agent-request:${account}:`;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(oldPrefix)) continue;
      const sessionId = key.slice(oldPrefix.length);
      const request = parse(localStorage.getItem(key), sessionId);
      if (request) legacy.set(sessionId, request);
      else legacy.delete(sessionId);
    }
    const current = records(localStorage, account);
    return [
      ...[...legacy.values()].filter(
        (request) => localStorage.getItem(keyFor(account, request)) === null,
      ),
      ...current,
    ];
  } catch {
    return [...legacy.values()];
  }
}

export class AgentRequestCache {
  private own = new Map<string, PendingAgentRequest>();

  constructor(private account: string) {
    try {
      for (const request of records(sessionStorage, account))
        this.own.set(request.input.requestId, request);
    } catch {}
  }

  pending() {
    return [...this.own.values(), ...readPendingAgentRequests(this.account)];
  }

  private replayable() {
    const pending = this.pending();
    try {
      return [...pending, ...records(localStorage, this.account, true)];
    } catch {
      return pending;
    }
  }

  retainDraftRequests(layout: Pick<AgentPanelLayout, "drafts" | "draftIds">) {
    const requests = this.replayable().filter((request) =>
      !!layout.drafts[request.sessionId]?.trim() &&
      request.draftId === layout.draftIds[request.sessionId] &&
      request.input.message === layout.drafts[request.sessionId].trim(),
    );
    // A restored composer owns its retry information before the user sends it.
    // Another window can acknowledge and mask the shared (including legacy)
    // record meanwhile, but must not invalidate this window's restored retry.
    for (const request of requests) this.remember(request);
    return requests;
  }

  private remember(request: PendingAgentRequest) {
    this.own.set(request.input.requestId, request);
    try {
      sessionStorage.setItem(keyFor(this.account, request), JSON.stringify(request));
    } catch {}
  }

  async prepare(
    sessionId: string,
    payload: Omit<AgentTaskRequest, "requestId">,
    draftId?: string,
  ) {
    return withAgentStorageLock(this.account, () => {
      const fingerprint = agentTaskIntentFingerprint(payload);
      const request =
        this.replayable().find(
          (item) =>
            item.sessionId === sessionId &&
            item.draftId === draftId &&
            item.fingerprint === fingerprint,
        ) ?? {
          sessionId,
          draftId,
          fingerprint,
          input: { ...payload, requestId: crypto.randomUUID() },
        };
      const key = keyFor(this.account, request);
      // Match only within this draft: a later turn may use the same text while
      // an older unacknowledged request is still retained for another window.
      // Legacy drafts and requests both have an undefined draftId.
      // Each unresolved request owns an immutable key, even within one session.
      // A window also keeps its own copy until it receives its response. Another
      // window completing the request must not break retry after this reloads.
      this.remember(request);
      try {
        if (localStorage.getItem(key) === null)
          localStorage.setItem(key, JSON.stringify(request));
      } catch {}
      return request;
    });
  }

  complete(request: PendingAgentRequest) {
    this.own.delete(request.input.requestId);
    const key = keyFor(this.account, request);
    try {
      sessionStorage.removeItem(key);
    } catch {}
    // Keep the immutable payload for windows that still hold this draft but
    // have not sent it themselves. Acknowledgement is not a new draft turn.
    // Completed records mask legacy copies and stay out of pending listings.
    try {
      localStorage.setItem(key, JSON.stringify({ ...request, completed: true }));
    } catch {}
  }

  clearSession(sessionId: string) {
    for (const request of this.replayable()) {
      if (request.sessionId !== sessionId) continue;
      const key = keyFor(this.account, request);
      this.own.delete(request.input.requestId);
      try { sessionStorage.removeItem(key); } catch {}
      // Deletion discards payloads while still masking any legacy copies.
      try { localStorage.setItem(key, "null"); } catch {}
    }
  }
}
