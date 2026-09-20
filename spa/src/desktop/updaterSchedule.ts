export const DESKTOP_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
export const DESKTOP_UPDATE_RETRY_INTERVAL_MS = 30 * 60 * 1_000;
export const DESKTOP_UPDATE_TIMER_TICK_MS = 60 * 1_000;
export const DESKTOP_UPDATE_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1_000;
export const DESKTOP_UPDATE_DOWNLOAD_ATTEMPTS = 3;
export const DESKTOP_UPDATE_DOWNLOAD_RETRY_DELAYS_MS = [1_000, 3_000] as const;

export function nextDesktopUpdateCheckAt(
  now: number,
  succeeded: boolean,
): number {
  return now + (
    succeeded
      ? DESKTOP_UPDATE_CHECK_INTERVAL_MS
      : DESKTOP_UPDATE_RETRY_INTERVAL_MS
  );
}

export function desktopUpdateCheckDue(
  nextCheckAt: number | null,
  now: number,
): boolean {
  return nextCheckAt === null || now >= nextCheckAt;
}
