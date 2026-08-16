import { desktopAPIOrigin, isDesktopRuntime } from "./desktop/runtime";
import { localWebURL } from "./webLinksCore";

export async function openMembershipCheckout(value: string): Promise<void> {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("Checkout URL must use HTTPS");
  }
  await openURL(url);
}

export async function openKoinoteWebPath(path: string): Promise<void> {
  await openURL(new URL(koinoteWebURL(path)));
}

export function koinoteWebURL(path: string): string {
  const origin = isDesktopRuntime()
    ? desktopAPIOrigin()
    : window.location.origin;
  return localWebURL(origin, path);
}

async function openURL(url: URL): Promise<void> {
  if (isDesktopRuntime()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url.toString());
    return;
  }
  window.location.assign(url.toString());
}
