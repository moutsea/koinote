import {
  clearDesktopSession,
  getStoredDesktopSession,
  refreshDesktopSession,
} from "./auth";
import { shouldAttachDesktopAuthorization } from "./networkPolicy";
import { desktopAPIOrigin } from "./runtime";
import { desktopRawFetch } from "./transport";

export async function desktopFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const authenticated = shouldAttachDesktopAuthorization(
    path,
    desktopAPIOrigin(),
  );
  if (!authenticated) {
    return fetchWithSession(path, init, undefined);
  }
  const session = await getStoredDesktopSession();
  let response = await fetchWithSession(
    path,
    init,
    session?.accessToken,
  );
  if (response.status !== 401 || !session) return response;

  const refreshed = await refreshDesktopSession();
  if (!refreshed) {
    await clearDesktopSession();
    return response;
  }
  response = await fetchWithSession(path, init, refreshed.accessToken);
  return response;
}

async function fetchWithSession(
  path: string,
  init: RequestInit | undefined,
  accessToken: string | undefined,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (
    accessToken &&
    shouldAttachDesktopAuthorization(path, desktopAPIOrigin())
  ) {
    headers.set("Authorization", `Bearer ${accessToken}`);
  }
  return desktopRawFetch(path, { ...init, headers });
}
