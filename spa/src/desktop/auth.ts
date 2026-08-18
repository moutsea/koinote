import { invoke } from "@tauri-apps/api/core";
import type { User } from "../api";
import { desktopAPIOrigin } from "./runtime";
import { desktopRawFetch } from "./transport";
import {
  DESKTOP_BILLING_EVENT,
  isTerminalBillingHTTPStatus,
  publishDesktopBillingEvent,
} from "./billingCore";
import {
  isDesktopLocalModeSelected,
  leaveDesktopLocalMode,
} from "./localMode";

export { DESKTOP_BILLING_EVENT } from "./billingCore";

const CLIENT_ID = "koinote-desktop";
const CALLBACK_SCHEME = "koinote:";
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;

export type StoredDesktopSession = {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  userJson: string;
};

type PendingAuthorization = {
  state: string;
  codeVerifier: string;
  createdAt: number;
};

type DesktopTokenResponse = {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresInSeconds: number;
  user: User;
};

let initializePromise: Promise<void> | null = null;
let refreshPromise: Promise<StoredDesktopSession | null> | null = null;
let callbackTail: Promise<void> = Promise.resolve();

export function initializeDesktopAuth(): Promise<void> {
  if (initializePromise) return initializePromise;
  initializePromise = initializeDesktopAuthOnce();
  return initializePromise;
}

async function initializeDesktopAuthOnce(): Promise<void> {
  const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
  await onOpenUrl((urls) => {
    void enqueueDesktopURLs(urls);
  });
  const current = await getCurrent();
  if (current) await enqueueDesktopURLs(current);
}

function enqueueDesktopURLs(urls: string[]): Promise<void> {
  callbackTail = callbackTail.then(
    () => handleDesktopURLs(urls),
    () => handleDesktopURLs(urls),
  );
  return callbackTail;
}

export async function beginDesktopAuthorization(): Promise<void> {
  leaveDesktopLocalMode();
  const verifier = randomBase64URL(48);
  const challenge = await sha256Base64URL(verifier);
  const state = randomBase64URL(32);
  await invoke("desktop_pending_auth_store", {
    pending: {
      state,
      codeVerifier: verifier,
      createdAt: Date.now(),
    } satisfies PendingAuthorization,
  });
  const authorizeURL = new URL("/desktop/authorize", desktopAPIOrigin());
  authorizeURL.searchParams.set("client_id", CLIENT_ID);
  authorizeURL.searchParams.set("code_challenge", challenge);
  authorizeURL.searchParams.set("state", state);
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(authorizeURL);
  } catch (error) {
    await clearPendingAuthorization();
    throw error;
  }
}

async function handleDesktopURLs(urls: string[]): Promise<void> {
  if (isDesktopLocalModeSelected()) return;
  for (const value of urls) {
    let callback: URL;
    try {
      callback = new URL(value);
    } catch {
      continue;
    }
    if (callback.protocol !== CALLBACK_SCHEME) {
      continue;
    }
    if (callback.hostname === "billing") {
      await handleDesktopBillingCallback(callback);
      continue;
    }
    if (callback.hostname !== "auth") continue;
    try {
      await exchangeDesktopCallback(callback);
      window.dispatchEvent(new CustomEvent("koinote:desktop-authenticated"));
      window.location.replace("/editor");
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("koinote:desktop-auth-error", {
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

async function handleDesktopBillingCallback(callback: URL): Promise<void> {
  const checkout = callback.searchParams.get("checkout")?.trim() ?? "";
  const kind = callback.searchParams.get("purchase") === "credits"
    ? "credits"
    : "membership";
  if (checkout === "cancelled") {
    publishDesktopBillingEvent({ status: "cancelled", kind });
    return;
  }
  const sessionId = callback.searchParams.get("session_id")?.trim() ?? "";
  if (checkout !== "success" || !sessionId.startsWith("cs_")) {
    publishDesktopBillingEvent({ status: "failed", kind });
    return;
  }

  if (kind === "credits") {
    await handleDesktopCreditsCallback(sessionId);
    return;
  }

  publishDesktopBillingEvent({ status: "pending", kind: "membership" });
  const {
    ApiError,
    confirmMembershipCheckout,
    getMembershipStatus,
    getSession,
  } = await import("../api");
  try {
    const result = await confirmMembershipCheckout(sessionId);
    if (result.status === "active") {
      if (result.user) await updateCachedDesktopUser(result.user);
      publishDesktopBillingEvent({ status: "active", kind: "membership", user: result.user });
      return;
    }

    void pollDesktopMembership(getMembershipStatus, getSession, ApiError);
  } catch (error) {
    if (isTerminalDesktopBillingError(error, ApiError)) {
      publishDesktopBillingEvent({ status: "failed", kind: "membership" });
      return;
    }
    void pollDesktopMembership(getMembershipStatus, getSession, ApiError);
  }
}

async function handleDesktopCreditsCallback(sessionId: string): Promise<void> {
  publishDesktopBillingEvent({ status: "pending", kind: "credits" });
  const { ApiError, confirmAgentCreditsCheckout } = await import("../api");
  try {
    const result = await confirmAgentCreditsCheckout(sessionId);
    if (result.status === "active") {
      publishDesktopBillingEvent({
        status: "active",
        kind: "credits",
        credits: result.credits?.balance,
      });
      return;
    }
    void pollDesktopCredits(sessionId, confirmAgentCreditsCheckout, ApiError);
  } catch (error) {
    if (isTerminalDesktopBillingError(error, ApiError)) {
      publishDesktopBillingEvent({ status: "failed", kind: "credits" });
      return;
    }
    void pollDesktopCredits(sessionId, confirmAgentCreditsCheckout, ApiError);
  }
}

async function pollDesktopCredits(
  sessionId: string,
  confirmCredits: typeof import("../api").confirmAgentCreditsCheckout,
  ApiError: typeof import("../api").ApiError,
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(2_000);
    try {
      const result = await confirmCredits(sessionId);
      if (result.status !== "active") continue;
      publishDesktopBillingEvent({
        status: "active",
        kind: "credits",
        credits: result.credits?.balance,
      });
      return;
    } catch (error) {
      if (isTerminalDesktopBillingError(error, ApiError)) {
        publishDesktopBillingEvent({ status: "failed", kind: "credits" });
        return;
      }
    }
  }
  publishDesktopBillingEvent({ status: "delayed", kind: "credits" });
}

async function pollDesktopMembership(
  getMembershipStatus: typeof import("../api").getMembershipStatus,
  getSession: typeof import("../api").getSession,
  ApiError: typeof import("../api").ApiError,
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(2_000);
    try {
      const status = await getMembershipStatus();
      if (!status.membership.active) continue;
      const session = await getSession();
      publishDesktopBillingEvent({
        status: "active",
        kind: "membership",
        user: session.user ?? undefined,
      });
      return;
    } catch (error) {
      if (isTerminalDesktopBillingError(error, ApiError)) {
        publishDesktopBillingEvent({ status: "failed", kind: "membership" });
        return;
      }
    }
  }
  publishDesktopBillingEvent({ status: "delayed", kind: "membership" });
}

function isTerminalDesktopBillingError(
  error: unknown,
  ApiError: typeof import("../api").ApiError,
): boolean {
  return (
    error instanceof ApiError &&
    isTerminalBillingHTTPStatus(error.status)
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function exchangeDesktopCallback(callback: URL): Promise<void> {
  const code = callback.searchParams.get("code")?.trim() ?? "";
  const state = callback.searchParams.get("state")?.trim() ?? "";
  const pending = await invoke<PendingAuthorization | null>(
    "desktop_pending_auth_get",
  );
  if (
    !code ||
    !state ||
    !pending ||
    pending.state !== state ||
    Date.now() - pending.createdAt > PENDING_MAX_AGE_MS
  ) {
    await clearPendingAuthorization();
    throw new Error("Desktop authorization state is invalid or expired");
  }

  const response = await desktopRawFetch("/api/auth/desktop/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grantType: "authorization_code",
      clientId: CLIENT_ID,
      code,
      codeVerifier: pending.codeVerifier,
    }),
  });
  if (!response.ok) {
    await clearPendingAuthorization();
    throw new Error(`Desktop token exchange failed (${response.status})`);
  }
  const tokens = (await response.json()) as DesktopTokenResponse;
  await storeDesktopSession(tokens);
  await clearPendingAuthorization();
}

export function getStoredDesktopSession(): Promise<StoredDesktopSession | null> {
  return invoke<StoredDesktopSession | null>("desktop_session_get");
}

export async function getCachedDesktopUser(): Promise<User | null> {
  const session = await getStoredDesktopSession();
  if (!session) return null;
  try {
    return JSON.parse(session.userJson) as User;
  } catch {
    await clearDesktopSession();
    return null;
  }
}

export async function updateCachedDesktopUser(user: User): Promise<void> {
  const session = await getStoredDesktopSession();
  if (!session) return;
  await invoke("desktop_session_store", {
    session: { ...session, userJson: JSON.stringify(user) },
  });
}

export function clearDesktopSession(): Promise<void> {
  return invoke("desktop_session_clear");
}

export async function refreshDesktopSession(): Promise<StoredDesktopSession | null> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = refreshDesktopSessionOnce().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function refreshDesktopSessionOnce(): Promise<StoredDesktopSession | null> {
  const existing = await getStoredDesktopSession();
  if (!existing) return null;
  const response = await desktopRawFetch("/api/auth/desktop/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grantType: "refresh_token",
      clientId: CLIENT_ID,
      refreshToken: existing.refreshToken,
    }),
  });
  if (!response.ok) {
    if (response.status === 400 || response.status === 401) {
      await clearDesktopSession();
      return null;
    }
    throw new Error(`Desktop refresh failed (${response.status})`);
  }
  const tokens = (await response.json()) as DesktopTokenResponse;
  return storeDesktopSession(tokens);
}

async function storeDesktopSession(
  tokens: DesktopTokenResponse,
): Promise<StoredDesktopSession> {
  const session: StoredDesktopSession = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accountId: tokens.user.authUserId,
    userJson: JSON.stringify(tokens.user),
  };
  await invoke("desktop_session_store", { session });
  return session;
}

async function clearPendingAuthorization(): Promise<void> {
  await invoke("desktop_pending_auth_clear");
}

function randomBase64URL(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return base64URL(bytes);
}

async function sha256Base64URL(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return base64URL(new Uint8Array(digest));
}

function base64URL(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
