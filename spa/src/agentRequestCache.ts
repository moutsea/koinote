import {
  agentTaskIntentFingerprint,
  withAgentStorageLock,
  type AgentPanelLayout,
  type AgentTaskRequest,
} from "./agentSessions";

import { archiveAgentRequests, readArchivedAgentRequests, deleteArchivedAgentRequests } from "./agentRequestArchive";

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

function readLegacyRequests(account: string): PendingAgentRequest[] {
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
  } catch {}
  return [...legacy.values()];
}

export function readPendingAgentRequests(account: string): PendingAgentRequest[] {
  const legacy = readLegacyRequests(account);
  try {
    return [
      ...legacy.filter((request) => localStorage.getItem(keyFor(account, request)) === null),
      ...records(localStorage, account),
    ];
  } catch { return legacy; }
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
    // Older windows acknowledge without taking the storage lock, including
    // while we await IndexedDB. Read their completed records at lookup time.
    return [...this.pending(), ...records(localStorage, this.account, true)];
  }

  private maskLegacyOrRemove(request: PendingAgentRequest, legacyIds: Set<string>) {
    const key = keyFor(this.account, request);
    if (legacyIds.has(request.input.requestId)) localStorage.setItem(key, "null");
    else localStorage.removeItem(key);
  }

  // Caller holds the storage lock. Rescan on each operation because an older
  // window can keep writing this format after our initial restoration.
  // Commit before freeing localStorage so interrupted migration remains safe.
  private async migrateCompletedLocked() {
    const completed = records(localStorage, this.account, true);
    if (completed.length) await archiveAgentRequests(this.account, completed);
    const legacyIds = new Set(readLegacyRequests(this.account).map((r) => r.input.requestId));
    for (const request of completed) this.maskLegacyOrRemove(request, legacyIds);
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix(this.account)) && localStorage.getItem(key) === "null" &&
        !legacyIds.has(key.slice(key.lastIndexOf(":") + 1))) localStorage.removeItem(key);
    }
  }

  async retainDraftRequests(layout: Pick<AgentPanelLayout, "drafts" | "draftIds">) {
    const matches = (request: PendingAgentRequest) =>
      !!layout.drafts[request.sessionId]?.trim() &&
      request.draftId === layout.draftIds[request.sessionId] &&
      request.input.message === layout.drafts[request.sessionId].trim();
    // Pin pending/legacy records synchronously before any other window can
    // acknowledge them while this window is loading its archive.
    const pending = this.replayable().filter(matches);
    for (const request of pending) this.remember(request);
    return withAgentStorageLock(this.account, async () => {
      await this.migrateCompletedLocked();
      const archived = (await Promise.all(Object.keys(layout.drafts)
        .filter((id) => layout.drafts[id]?.trim())
        .map((id) => readArchivedAgentRequests(this.account, id, layout.draftIds[id]))))
        .flat();
      const restored = [...this.replayable(), ...archived].filter(matches);
      for (const request of restored) this.remember(request);
      return restored;
    });
  }

  private remember(request: PendingAgentRequest) {
    this.own.set(request.input.requestId, request);
    sessionStorage.setItem(keyFor(this.account, request), JSON.stringify(request));
  }

  async prepare(sessionId: string, payload: Omit<AgentTaskRequest, "requestId">, draftId?: string, options?: { automaticSkills?: boolean }) {
    return withAgentStorageLock(this.account, async () => {
      await this.migrateCompletedLocked();
      const archived = await readArchivedAgentRequests(this.account, sessionId, draftId);
      const fingerprint = agentTaskIntentFingerprint(payload);
      const candidates = [...this.replayable(), ...archived].filter((item) =>
        item.sessionId === sessionId && item.draftId === draftId);
      // Upgrading removes the selector, not an in-flight request. Replay its
      // exact payload so a lost acknowledgement cannot create a second task.
      // Explicit choices from older windows still use their original fingerprint.
      const request = candidates.find((item) => item.fingerprint === fingerprint) ??
        (options?.automaticSkills && draftId ? candidates.find((item) =>
          agentTaskIntentFingerprint({ ...item.input, skillRepositoryId: 0, skillPath: "" }) === fingerprint) : undefined) ??
        { sessionId, draftId, fingerprint, input: { ...payload, requestId: crypto.randomUUID() } };
      // Durable retry information must exist before issuing the external request.
      this.remember(request);
      const key = keyFor(this.account, request);
      if (!archived.some((r) => r.input.requestId === request.input.requestId) &&
        localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(request));
      return request;
    });
  }

  async complete(request: PendingAgentRequest) {
    await withAgentStorageLock(this.account, async () => {
      await this.migrateCompletedLocked();
      await archiveAgentRequests(this.account, [request]);
      this.maskLegacyOrRemove(request, new Set(readLegacyRequests(this.account).map((r) => r.input.requestId)));
      this.own.delete(request.input.requestId);
      sessionStorage.removeItem(keyFor(this.account, request));
    });
  }

  async clearSession(sessionId: string) {
    await withAgentStorageLock(this.account, async () => {
      await this.migrateCompletedLocked();
      await deleteArchivedAgentRequests(this.account, sessionId);
      const legacyIds = new Set(readLegacyRequests(this.account).map((r) => r.input.requestId));
      for (const request of this.replayable()) {
        if (request.sessionId !== sessionId) continue;
        this.maskLegacyOrRemove(request, legacyIds);
        this.own.delete(request.input.requestId);
        sessionStorage.removeItem(keyFor(this.account, request));
      }
    });
  }
}
