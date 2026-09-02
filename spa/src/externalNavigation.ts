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

const ZHIHU_COMPOSER_URL = "https://zhuanlan.zhihu.com/write";

export async function openZhihuComposer(): Promise<void> {
  const url = new URL(ZHIHU_COMPOSER_URL);
  if (isDesktopRuntime()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url.toString());
    return;
  }

  const opened = window.open(url.toString(), "_blank");
  if (opened) {
    opened.opener = null;
    return;
  }
  window.location.assign(url.toString());
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
