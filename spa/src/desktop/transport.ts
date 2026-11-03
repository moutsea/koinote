import { invoke } from "@tauri-apps/api/core";
import { desktopAPIOrigin, desktopFlavor, desktopURL } from "./runtime";
import { isDesktopLocalModeSelected } from "./localMode";

export async function localDesktopProxy(): Promise<string> {
  const port = await invoke<number>("desktop_local_proxy_port");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("local_service_unavailable");
  return `http://127.0.0.1:${port}`;
}

export async function desktopRawFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  if (isDesktopLocalModeSelected()) {
    throw new Error("local_mode_network_disabled");
  }
  const { fetch } = await import("@tauri-apps/plugin-http");
  const authenticated = new Headers(init?.headers).has("Authorization");
  const url = new URL(desktopURL(path));
  const local = desktopFlavor() === "local" && url.origin === desktopAPIOrigin();
  const proxy = local ? { all: await localDesktopProxy() } : undefined;
  return fetch(url, {
    ...init,
    proxy,
    connectTimeout: 10_000,
    // 不让原生 HTTP 客户端携带 Bearer token 跟随跨域重定向。后端 API
    // 不依赖重定向；3xx 会原样返回给调用方处理。
    ...((authenticated || local) ? { maxRedirections: 0 } : {}),
  });
}
