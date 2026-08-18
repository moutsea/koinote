import type { User } from "../api";
export { isTerminalBillingHTTPStatus } from "../billingCore";

export const DESKTOP_BILLING_EVENT = "koinote:desktop-billing";

export type DesktopBillingEventDetail = {
  status: "active" | "pending" | "delayed" | "cancelled" | "failed";
  kind?: "membership" | "credits";
  user?: User;
  credits?: number;
};

let latestDesktopBillingEvent: DesktopBillingEventDetail | null = null;

export function publishDesktopBillingEvent(detail: DesktopBillingEventDetail): void {
  latestDesktopBillingEvent = detail;
  window.dispatchEvent(
    new CustomEvent<DesktopBillingEventDetail>(DESKTOP_BILLING_EVENT, { detail }),
  );
}

export function getLatestDesktopBillingEvent(): DesktopBillingEventDetail | null {
  return latestDesktopBillingEvent;
}

export function clearLatestDesktopBillingEvent(): void {
  latestDesktopBillingEvent = null;
}

export function desktopBillingDeepLink(value: string): string | null {
  const source = new URL(value);
  const checkout = source.searchParams.get("checkout")?.trim() ?? "";
  if (checkout !== "success" && checkout !== "cancelled") return null;
  const purchase = source.searchParams.get("purchase")?.trim() ?? "membership";
  if (purchase !== "membership" && purchase !== "credits") return null;
  const target = new URL("koinote://billing");
  target.searchParams.set("checkout", checkout);
  if (purchase === "credits") target.searchParams.set("purchase", purchase);
  if (checkout === "success") {
    const sessionId = source.searchParams.get("session_id")?.trim() ?? "";
    if (!sessionId.startsWith("cs_") || sessionId.length > 255) return null;
    target.searchParams.set("session_id", sessionId);
  }
  return target.toString();
}
