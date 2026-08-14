type LogoutPreparation = () => Promise<boolean>;

const preparations = new Set<LogoutPreparation>();

export function registerDesktopLogoutPreparation(
  preparation: LogoutPreparation,
): () => void {
  preparations.add(preparation);
  return () => preparations.delete(preparation);
}

export async function prepareDesktopLogout(): Promise<boolean> {
  const results = await Promise.allSettled(
    [...preparations].map((preparation) => preparation()),
  );
  return results.every(
    (result) => result.status === "fulfilled" && result.value,
  );
}
