import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../../spa/src/i18n";
import { LoginPage } from "../../spa/src/pages/LoginPage";
import type { TurnstileAPI } from "../../spa/src/turnstile";

const query = new URLSearchParams(location.search);
const widgets = new Map<string, { element: HTMLElement; options: Record<string, unknown> }>();
const state = {
  requests: [] as { path: string; body: Record<string, string> }[],
  actions: [] as string[],
  resets: 0,
  sequence: 0,
  configFail: query.has("config-fail"),
  sendFail: false,
  oldCallback: undefined as ((token: string) => void) | undefined,
  solve() {
    const item = [...widgets.values()].at(-1)!;
    (item.options.callback as (token: string) => void)(`fixture-token-${++state.sequence}`);
  },
  expire() {
    const item = [...widgets.values()].at(-1)!;
    (item.options["expired-callback"] as () => void)();
  },
  rememberCallback() {
    state.oldCallback = [...widgets.values()].at(-1)!.options.callback as (token: string) => void;
  },
};
declare global { interface Window { humanTest: typeof state } }
window.humanTest = state;
const turnstile: TurnstileAPI = {
  render(element, options) {
    const id = crypto.randomUUID();
    widgets.set(id, { element, options });
    state.actions.push(String(options.action));
    const button = document.createElement("button");
    button.type = "button";
    button.className = "fixture-turnstile";
    button.style.width = options.size === "compact" ? "150px" : "300px";
    button.style.height = options.size === "compact" ? "140px" : "65px";
    button.textContent = "验证通过（模拟服务）";
    button.addEventListener("click", () => state.solve());
    element.replaceChildren(button);
    return id;
  },
  remove(id) { widgets.get(id)?.element.replaceChildren(); widgets.delete(id); },
  reset() { state.resets++; },
};
window.turnstile = turnstile;
window.fetch = async (input, init) => {
  const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
  if (path === "/api/auth/turnstile") {
    if (state.configFail) throw new Error("fixture config unavailable");
    return Response.json({ required: !query.has("disabled"), siteKey: "fixture-site-key" });
  }
  if (path.endsWith("/verification-code") || path.endsWith("/password-reset-code")) {
    state.requests.push({ path, body: JSON.parse(String(init?.body)) });
    if (state.sendFail) {
      state.sendFail = false;
      return Response.json({ code: "email_send_failed", error: "fixture delivery failed" }, { status: 503 });
    }
    return Response.json({ ok: true, retryAfterSeconds: 1, devCode: "123456" });
  }
  if (path === "/api/auth/login") return Response.json({ code: "email_not_verified", error: "Email verification required", email: "legacy@example.test" }, { status: 403 });
  throw new Error(`Unexpected fixture request: ${path}`);
};
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root")!).render(
  <React.StrictMode><QueryClientProvider client={client}><I18nProvider>
    <LoginPage initialMode={query.get("mode") === "login" ? "login" : "register"} />
  </I18nProvider></QueryClientProvider></React.StrictMode>,
);
