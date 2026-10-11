import {
  getStoredDesktopSession,
  refreshDesktopSession,
} from "./auth";
import { shouldAttachDesktopAuthorization } from "./networkPolicy";
import { desktopAPIOrigin } from "./runtime";
import { DesktopSessionChangedError } from "./sessionErrors";
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
  const initial = await getStoredDesktopSession();
  let session = initial;
  // Bound retries; only a changed access token justifies another API attempt.
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetchWithSession(path, init, session?.accessToken);
    if (response.status !== 401 || !session) return response;
    if (init?.signal?.aborted) throw init.signal.reason;
    const refreshed = await refreshDesktopSession(session.accessToken);
    if (!refreshed) return response;
    // A late request from the old account must never be replayed as a new user.
    if (refreshed.accountId !== initial?.accountId) throw new DesktopSessionChangedError();
    if (refreshed.accessToken === session.accessToken) return response;
    session = refreshed;
  }
  // Token churn is transient, not evidence that the account has signed out.
  throw new DesktopSessionChangedError();
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
