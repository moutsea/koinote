type SyncPreparation = () => Promise<boolean>;

const preparations = new Set<SyncPreparation>();

export function registerDesktopSyncPreparation(
  preparation: SyncPreparation,
): () => void {
  preparations.add(preparation);
  return () => preparations.delete(preparation);
}

export async function prepareDesktopSync(): Promise<boolean> {
  const results = await Promise.allSettled(
    [...preparations].map((preparation) => preparation()),
  );
  return results.every(
    (result) => result.status === "fulfilled" && result.value,
  );
}

export function registerDesktopLogoutPreparation(
  preparation: SyncPreparation,
): () => void {
  return registerDesktopSyncPreparation(preparation);
}

export function prepareDesktopLogout(): Promise<boolean> {
  return prepareDesktopSync();
}
