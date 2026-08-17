import { relaunch } from "@tauri-apps/plugin-process";
import {
  check,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";
import { Download, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { DESKTOP_UPDATE_CHECK_EVENT } from "../desktop/updaterEvents";
import {
  DESKTOP_UPDATE_TIMER_TICK_MS,
  desktopUpdateCheckDue,
  nextDesktopUpdateCheckAt,
} from "../desktop/updaterSchedule";
import { interpolate, useI18n } from "../i18n";
import { isDesktopLocalModeSelected } from "../desktop/localMode";

type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "installing"
  | "current"
  | "failed";

export function DesktopUpdater() {
  const { t } = useI18n();
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [contentLength, setContentLength] = useState<number | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const checkingRef = useRef(false);
  const availableUpdateRef = useRef<Update | null>(null);
  const contentLengthRef = useRef<number | null>(null);
  const nextScheduledCheckAtRef = useRef<number | null>(null);

  const runCheck = useCallback(async (interactive: boolean) => {
    if (isDesktopLocalModeSelected()) return;
    if (checkingRef.current || (!interactive && availableUpdateRef.current)) return;
    checkingRef.current = true;
    setSaveFailed(false);
    if (interactive) setPhase("checking");
    let succeeded = false;
    try {
      const update = await check({ timeout: 15_000 });
      succeeded = true;
      if (update) {
        if (availableUpdateRef.current) void availableUpdateRef.current.close();
        availableUpdateRef.current = update;
        setAvailableUpdate(update);
        setPhase("available");
      } else if (interactive) {
        setPhase("current");
      }
    } catch {
      if (interactive) setPhase("failed");
    } finally {
      nextScheduledCheckAtRef.current = nextDesktopUpdateCheckAt(
        Date.now(),
        succeeded,
      );
      checkingRef.current = false;
    }
  }, []);

  useEffect(() => {
    const startupTimer = window.setTimeout(() => void runCheck(false), 2_000);
    const checkIfDue = () => {
      if (desktopUpdateCheckDue(nextScheduledCheckAtRef.current, Date.now())) {
        void runCheck(false);
      }
    };
    const handleManualCheck = () => void runCheck(true);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") checkIfDue();
    };
    const handleOnline = () => void runCheck(false);
    const interval = window.setInterval(checkIfDue, DESKTOP_UPDATE_TIMER_TICK_MS);
    window.addEventListener(DESKTOP_UPDATE_CHECK_EVENT, handleManualCheck);
    window.addEventListener("focus", checkIfDue);
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearTimeout(startupTimer);
      window.clearInterval(interval);
      window.removeEventListener(DESKTOP_UPDATE_CHECK_EVENT, handleManualCheck);
      window.removeEventListener("focus", checkIfDue);
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [runCheck]);

  function dismiss() {
    if (phase === "installing") return;
    if (availableUpdate) void availableUpdate.close();
    availableUpdateRef.current = null;
    setAvailableUpdate(null);
    setPhase("idle");
  }

  async function installUpdate() {
    if (!availableUpdate) {
      await runCheck(true);
      return;
    }
    const { prepareDesktopLogout } = await import("../desktop/logoutGuard");
    if (!(await prepareDesktopLogout())) {
      setSaveFailed(true);
      setPhase("failed");
      return;
    }
    setSaveFailed(false);
    setPhase("installing");
    setDownloadedBytes(0);
    setContentLength(null);
    contentLengthRef.current = null;
    try {
      await availableUpdate.downloadAndInstall(handleDownloadEvent, {
        timeout: 120_000,
      });
      await relaunch();
    } catch {
      setPhase("failed");
    }
  }

  function handleDownloadEvent(event: DownloadEvent) {
    if (event.event === "Started") {
      setDownloadedBytes(0);
      const length = event.data.contentLength ?? null;
      contentLengthRef.current = length;
      setContentLength(length);
      return;
    }
    if (event.event === "Progress") {
      setDownloadedBytes((current) => current + event.data.chunkLength);
      return;
    }
    if (event.event === "Finished" && contentLengthRef.current) {
      setDownloadedBytes(contentLengthRef.current);
    }
  }

  if (phase === "idle") return null;

  const progress = contentLength
    ? Math.min(100, Math.round((downloadedBytes / contentLength) * 100))
    : null;
  const title =
    phase === "checking"
      ? t.desktopUpdate.checking
      : phase === "current"
        ? t.desktopUpdate.currentTitle
        : phase === "failed"
          ? t.desktopUpdate.failedTitle
          : t.desktopUpdate.availableTitle;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="desktop-update-title"
        className="w-full max-w-md rounded-2xl border p-5 shadow-2xl"
        style={{
          borderColor: "var(--ink-line)",
          background: "var(--ink-paper-soft)",
        }}
      >
        <div className="flex items-start gap-4">
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
            style={{
              background: "var(--ink-wash-strong)",
              color: "var(--ink-strong)",
            }}
          >
            {phase === "checking" || phase === "installing" ? (
              <LoaderCircle className="h-5 w-5 animate-spin" />
            ) : phase === "failed" ? (
              <RefreshCw className="h-5 w-5" />
            ) : (
              <Download className="h-5 w-5" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="desktop-update-title" className="kn-heading-cn text-lg font-semibold">
              {title}
            </h2>
            <p className="mt-1 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
              {phase === "available" || phase === "installing"
                ? interpolate(t.desktopUpdate.availableDescription, {
                    current: availableUpdate?.currentVersion ?? "",
                    next: availableUpdate?.version ?? "",
                  })
                : phase === "current"
                  ? t.desktopUpdate.currentDescription
                  : phase === "failed"
                    ? saveFailed
                      ? t.desktopUpdate.saveFailedDescription
                      : t.desktopUpdate.failedDescription
                    : t.desktopUpdate.checkingDescription}
            </p>
          </div>
          {phase !== "installing" && (
            <button
              type="button"
              onClick={dismiss}
              aria-label={t.desktopUpdate.later}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition hover:bg-[var(--ink-wash-strong)]"
              style={{ color: "var(--ink-faint)" }}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {availableUpdate?.body && (phase === "available" || phase === "installing") && (
          <div
            className="mt-4 max-h-36 overflow-y-auto whitespace-pre-wrap rounded-xl p-3 text-xs leading-5"
            style={{ background: "var(--ink-wash)", color: "var(--ink-mid)" }}
          >
            {availableUpdate.body}
          </div>
        )}

        {phase === "installing" && (
          <div className="mt-5" aria-live="polite">
            <div className="flex items-center justify-between gap-3 text-xs" style={{ color: "var(--ink-mid)" }}>
              <span>{t.desktopUpdate.downloading}</span>
              {progress !== null && <span>{progress}%</span>}
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: "var(--ink-wash-strong)" }}>
              <div
                className={`h-full rounded-full ${progress === null ? "w-1/3 animate-pulse" : ""}`}
                style={{
                  width: progress === null ? undefined : `${progress}%`,
                  background: "var(--ink-strong)",
                }}
              />
            </div>
          </div>
        )}

        {phase !== "checking" && phase !== "installing" && (
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={dismiss}
              className="rounded-lg border px-4 py-2 text-sm font-medium transition hover:bg-[var(--ink-wash-strong)]"
              style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}
            >
              {phase === "current" ? t.desktopUpdate.close : t.desktopUpdate.later}
            </button>
            {phase !== "current" && (
              <button
                type="button"
                onClick={() => void installUpdate()}
                className="rounded-lg px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
                style={{ background: "var(--cinnabar)" }}
              >
                {phase === "failed"
                  ? t.desktopUpdate.retry
                  : t.desktopUpdate.downloadAndRestart}
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
