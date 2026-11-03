import type { PendingAgentRequest } from "./agentRequestCache";

// Completed payloads belong in IndexedDB, not in the small synchronous storage
// quota shared with drafts. Keep them replayable even for long-lived windows.
let database: Promise<IDBDatabase> | undefined;
function openArchive() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("koinote-agent-request-archive", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("requests", { keyPath: "key" });
      store.createIndex("scope", "scope");
      store.createIndex("session", "session");
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        database = undefined;
      };
      resolve(request.result);
    };
    request.onerror = () => { database = undefined; reject(request.error); };
  });
}

type ArchivedRequest = {
  key: string;
  scope: string;
  session: string;
  request: PendingAgentRequest;
};
const sessionKey = (account: string, sessionId: string) => JSON.stringify([account, sessionId]);

async function transaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore, result: (value: T) => void) => void,
): Promise<T> {
  const db = await openArchive();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction("requests", mode);
    let result: T;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error ?? new Error("请求记录保存失败，请重试"));
    tx.onerror = () => reject(tx.error);
    action(tx.objectStore("requests"), (value) => { result = value; });
  });
}

export function archiveAgentRequests(account: string, requests: PendingAgentRequest[]) {
  return transaction<void>("readwrite", (store) => {
    for (const request of requests) store.put({
      key: JSON.stringify([account, request.sessionId, request.input.requestId]),
      scope: JSON.stringify([account, request.sessionId, request.draftId ?? null]),
      session: sessionKey(account, request.sessionId),
      request,
    } satisfies ArchivedRequest);
  });
}

export function readArchivedAgentRequests(account: string, sessionId: string, draftId?: string) {
  return transaction<PendingAgentRequest[]>("readonly", (store, result) => {
    const query = store.index("scope").getAll(JSON.stringify([account, sessionId, draftId ?? null]));
    query.onsuccess = () => result((query.result as ArchivedRequest[]).map((entry) => entry.request));
  });
}

export function deleteArchivedAgentRequests(account: string, sessionId: string) {
  return transaction<void>("readwrite", (store) => {
    const query = store.index("session").openKeyCursor(sessionKey(account, sessionId));
    query.onsuccess = () => {
      const cursor = query.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
  });
}
