import { desktopURL } from "./runtime";
import { isDesktopLocalModeSelected } from "./localMode";

export async function desktopRawFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  if (isDesktopLocalModeSelected()) {
    throw new Error("local_mode_network_disabled");
  }
  const { fetch } = await import("@tauri-apps/plugin-http");
  const authenticated = new Headers(init?.headers).has("Authorization");
  return fetch(desktopURL(path), {
    connectTimeout: 10_000,
    // 不让原生 HTTP 客户端携带 Bearer token 跟随跨域重定向。后端 API
    // 不依赖重定向；3xx 会原样返回给调用方处理。
    ...(authenticated ? { maxRedirections: 0 } : {}),
    ...init,
  });
}
