import { desktopAPIOrigin, isDesktopRuntime } from "./desktop/runtime";

export async function openMembershipCheckout(value: string): Promise<void> {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("Checkout URL must use HTTPS");
  }
  await openURL(url);
}

export async function openKoinoteWebPath(path: string): Promise<void> {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new Error("Koinote web path must be an absolute local path");
  }
  const base = new URL(desktopAPIOrigin());
  const url = new URL(path, `${base.origin}/`);
  if (url.origin !== base.origin) {
    throw new Error("Koinote web path must stay on the configured origin");
  }
  await openURL(url);
}

async function openURL(url: URL): Promise<void> {
  if (isDesktopRuntime()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url.toString());
    return;
  }
  window.location.assign(url.toString());
}
