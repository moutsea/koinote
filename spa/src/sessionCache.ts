import type { QueryClient } from "@tanstack/react-query";
import { clearLegacyConflictDrafts, conflictDraftRevocationKey, setConflictDraftOwner } from "./conflictDrafts";

const installed = new WeakSet<QueryClient>();
let identityEpoch = 0;
export const sessionIdentityEpoch = () => identityEpoch;
type SessionIdentity = { user?: { authUserId: string } | null };

// Observe all session writes, including login/local-mode setQueryData calls.
// Invalidating a query retains its old data, so an identity change must remove
// private data and cancel the old requests before the next account renders.
export function installSessionCacheIsolation(client: QueryClient) {
  if (installed.has(client)) return;
  installed.add(client);
  const cache = client.getQueryCache();
  const identityKnown = client.getQueryData(["session"]) !== undefined;
  let owner = client.getQueryData<SessionIdentity>(["session"])?.user?.authUserId;
  if (identityKnown) setConflictDraftOwner(owner);
  if (typeof window !== "undefined") {
    window.addEventListener("storage", event => {
      if (owner && event.key === conflictDraftRevocationKey(owner) && event.newValue !== event.oldValue) {
        clearLegacyConflictDrafts(owner);
        client.setQueryData(["session"], { user: null });
      }
    });
  }
  cache.subscribe(event => {
    if (event.query.queryKey.length !== 1 || event.query.queryKey[0] !== "session") return;
    if (event.type !== "removed" && !(event.type === "updated" && event.action.type === "success")) return;
    const next = event.type === "removed" ? undefined : (event.query.state.data as SessionIdentity | undefined)?.user?.authUserId;
    setConflictDraftOwner(next);
    if (next === owner) return;
    owner = next;
    identityEpoch += 1;
    // A manual login can supersede an older in-flight session GET as well.
    void client.cancelQueries({ queryKey: ["session"], exact: true }, { revert: false, silent: true });
    // Revocation and account changes clear private memory, not unsaved work.
    // Persisted drafts are account-scoped; only explicit logout/deletion discards them.
    const privateQueries = { predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[0] !== "session" };
    for (const query of cache.findAll(privateQueries)) query.reset();
    client.removeQueries(privateQueries);
  });
}
