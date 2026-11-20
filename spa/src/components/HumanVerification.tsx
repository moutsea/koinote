import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchTurnstileConfig } from "../api";
import { useI18n } from "../i18n";
import { loadTurnstile, type TurnstileAPI } from "../turnstile";

export type HumanVerificationState = {
  action: string;
  token: string;
  ready: boolean;
};

export function HumanVerification({ action, resetVersion, onChange }: {
  action: "email_verification" | "password_reset";
  resetVersion: number;
  onChange: (state: HumanVerificationState) => void;
}) {
  const { locale, t } = useI18n();
  const config = useQuery({ queryKey: ["turnstile-config"], queryFn: fetchTurnstileConfig, staleTime: 60000, retry: 1 });
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<{ api: TurnstileAPI; id: string } | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "expired">("loading");
  const [attempt, setAttempt] = useState(0);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const target = container.current;
    if (!target) return;
    const update = () => setCompact(target.clientWidth > 0 && target.clientWidth < 300);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(target);
    return () => observer.disconnect();
  }, [config.data?.required]);

  useEffect(() => {
    let cancelled = false;
    change.current({ action, token: "", ready: false });
    if (config.isError) {
      setStatus("error");
      return;
    }
    if (!config.data) return;
    if (!config.data.required) {
      change.current({ action, token: "", ready: true });
      return;
    }
    if (!config.data.siteKey) {
      setStatus("error");
      return;
    }
    const siteKey = config.data.siteKey;
    setStatus("loading");
    const update = (next: typeof status, token = "") => {
      if (cancelled) return;
      setStatus(next);
      change.current({ action, token, ready: next === "ready" });
    };
    void loadTurnstile().then((api) => {
      if (cancelled || !container.current) return;
      const id = api.render(container.current, {
        sitekey: siteKey,
        action,
        theme: "auto",
        size: compact ? "compact" : "flexible",
        language: locale === "zh" ? "zh-CN" : locale,
        "response-field": false,
        callback: (token: string) => update("ready", token),
        "expired-callback": () => update("expired"),
        "timeout-callback": () => update("expired"),
        "error-callback": () => update("error"),
      });
      widget.current = { api, id };
    }).catch(() => update("error"));
    return () => {
      cancelled = true;
      if (widget.current) widget.current.api.remove(widget.current.id);
      widget.current = null;
    };
  }, [action, config.data, config.isError, locale, compact, attempt]);

  useEffect(() => {
    if (resetVersion === 0) return;
    if (config.data?.required === false) {
      change.current({ action, token: "", ready: true });
      return;
    }
    if (!widget.current) return;
    change.current({ action, token: "", ready: false });
    setStatus("loading");
    widget.current.api.reset(widget.current.id);
  }, [resetVersion, action, config.data?.required]);

  if (config.data?.required === false) return null;
  const failed = status === "error" || status === "expired";
  return (
    <div className="space-y-2" role="group" aria-label={t.auth.humanVerification}>
      <div ref={container} className="flex min-w-0 justify-center" />
      <p role="status" className="text-xs" style={{ color: "var(--ink-mid)" }}>
        {failed ? (status === "expired" ? t.auth.humanVerificationExpired : t.auth.humanVerificationUnavailable)
          : status === "ready" ? t.auth.humanVerificationPassed : t.auth.humanVerificationLoading}
      </p>
      {failed && <button type="button" className="text-xs font-medium underline" style={{ color: "var(--cinnabar)" }}
        onClick={() => { setAttempt((value) => value + 1); void config.refetch(); }}>
        {t.auth.retryHumanVerification}
      </button>}
    </div>
  );
}
