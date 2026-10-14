export const DESKTOP_UPDATE_CHECK_EVENT = "koinote:desktop-update-check";

let pendingCheck = false;

export function requestDesktopUpdateCheck(): void {
  pendingCheck = true;
  window.dispatchEvent(new Event(DESKTOP_UPDATE_CHECK_EVENT));
}

// The updater is lazy-loaded. Retain a click until its listener is mounted.
export function consumeDesktopUpdateCheck(): boolean {
  const pending = pendingCheck;
  pendingCheck = false;
  return pending;
}

export function isNewerDesktopRelease(version: string, installed: string): boolean {
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  const next = parse(version); const current = parse(installed);
  if (!next || !current) return false;
  for (let index = 1; index <= 3; index++) {
    const difference = BigInt(next[index]) - BigInt(current[index]);
    if (difference !== 0n) return difference > 0n;
  }
  if (next[4] === current[4]) return false;
  if (!next[4]) return true;
  if (!current[4]) return false;
  const left = next[4].split("."); const right = current[4].split(".");
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if (left[index] === undefined) return false;
    if (right[index] === undefined) return true;
    if (left[index] === right[index]) continue;
    const leftNumber = /^\d+$/.test(left[index]); const rightNumber = /^\d+$/.test(right[index]);
    if (leftNumber && rightNumber) return BigInt(left[index]) > BigInt(right[index]);
    if (leftNumber !== rightNumber) return !leftNumber;
    return left[index] > right[index];
  }
  return false;
}
