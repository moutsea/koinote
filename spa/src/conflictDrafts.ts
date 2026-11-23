export const CONFLICT_DRAFT_PREFIX = "koinote:conflict-draft:";

let activeOwner: string | undefined;
let suspendedOwner: string | undefined;
let identityKnown = false;
const authorizedLegacyDrafts = new Map<string, Map<string, string>>();

export function setConflictDraftOwner(owner: string | undefined) {
  // A passive session expiry can unmount an editor before its last failed save
  // settles. Allow that account to finish its scoped backup until a different
  // account signs in. Explicit logout revokes this permission below.
  if (owner) suspendedOwner = undefined;
  else if (activeOwner) suspendedOwner = activeOwner;
  activeOwner = owner;
  identityKnown = true;
}

export const currentConflictDraftOwner = () => activeOwner;
export const conflictDraftRevocationKey = (owner: string) =>
  `koinote:conflict-draft-revocation:${encodeURIComponent(owner)}`;

export function conflictDraftRevision(owner: string | undefined): string | null | undefined {
  if (!owner || typeof window === "undefined") return undefined;
  try { return window.localStorage.getItem(conflictDraftRevocationKey(owner)); }
  catch { return undefined; }
}

export const canStoreConflictDraft = (owner: string | undefined, revision: string | null | undefined) =>
  Boolean(owner) && revision !== undefined &&
  (!identityKnown || activeOwner === owner || suspendedOwner === owner) &&
  conflictDraftRevision(owner) === revision;

// Without owner this is the legacy key, used only to migrate an authorized
// document's recovery draft. New writes always use an account namespace.
export const conflictDraftKey = (docId: string, owner?: string) =>
  `${CONFLICT_DRAFT_PREFIX}${owner ? `${encodeURIComponent(owner)}:` : ""}${docId}`;

export function rememberLegacyConflictDraft(owner: string, docId: string, value: string, revision: string | null | undefined): string {
  const key = conflictDraftKey(docId);
  const drafts = authorizedLegacyDrafts.get(owner) ?? new Map<string, string>();
  authorizedLegacyDrafts.set(owner, drafts);
  drafts.set(key, value);
  try {
    if (!canStoreConflictDraft(owner, revision) || window.localStorage.getItem(key) !== value) return value;
    // Attribute the supported fallback in-place so another independent tab can
    // remove it too, even if the account-scoped migration cannot fit.
    const attributed = JSON.stringify({ ...JSON.parse(value), owner });
    window.localStorage.setItem(key, attributed);
    if (!canStoreConflictDraft(owner, revision)) {
      if (window.localStorage.getItem(key) === attributed) window.localStorage.removeItem(key);
    } else {
      drafts.set(key, attributed);
      return attributed;
    }
  } catch { /* The authorized original remains recoverable if storage is full. */ }
  return value;
}

export function clearLegacyConflictDrafts(owner: string) {
  if (typeof window === "undefined") return;
  const known = authorizedLegacyDrafts.get(owner);
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(CONFLICT_DRAFT_PREFIX) || key.slice(CONFLICT_DRAFT_PREFIX.length).includes(":")) continue;
      const value = window.localStorage.getItem(key);
      let attributed = false;
      let unowned = true;
      try {
        const previousOwner = JSON.parse(value ?? "null")?.owner;
        unowned = typeof previousOwner !== "string" || previousOwner.length === 0;
        attributed = previousOwner === owner;
      } catch { /* Unreadable pre-account backups have no safe owner either. */ }
      // Pre-account backups were global. Explicit logout discards unattributed
      // legacy data too, including when a full store prevented owner metadata.
      // Attributed data for another account always remains intact.
      if (unowned || attributed || (value !== null && known?.get(key) === value)) window.localStorage.removeItem(key);
    }
  } catch { /* Session changes must still complete when storage is disabled. */ }
  authorizedLegacyDrafts.delete(owner);
}

export function clearConflictDrafts(owner: string | undefined) {
  if (!owner) return;
  // Revoke late backup writes before an explicit logout/account deletion clears
  // storage, so the editor's unmount callback cannot recreate discarded data.
  if (activeOwner === owner) activeOwner = undefined;
  if (suspendedOwner === owner) suspendedOwner = undefined;
  identityKnown = true;
  if (typeof window === "undefined") return;
  // Publish before clearing shared data. Other tabs (including frozen tabs)
  // compare this durable generation before AND after every backup write.
  const revision = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  const publish = () => {
    try { window.localStorage.setItem(conflictDraftRevocationKey(owner), revision); return true; }
    catch { return false; }
  };
  const published = publish();
  const prefix = `${CONFLICT_DRAFT_PREFIX}${encodeURIComponent(owner)}:`;
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(prefix)) window.localStorage.removeItem(key);
    }
  } catch {
    // Storage can be disabled; session changes must still complete.
  }
  clearLegacyConflictDrafts(owner);
  // Clearing drafts can free the space needed for a small revocation marker.
  if (!published) publish();
}
