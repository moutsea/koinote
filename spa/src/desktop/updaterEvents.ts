export const DESKTOP_UPDATE_CHECK_EVENT = "koinote:desktop-update-check";

export function requestDesktopUpdateCheck(): void {
  window.dispatchEvent(new Event(DESKTOP_UPDATE_CHECK_EVENT));
}
