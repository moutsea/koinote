import { useQueryClient } from "@tanstack/react-query";
import { CloudOff, KeyRound, Laptop, LoaderCircle, ShieldCheck } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";

import { getSession } from "../api";
import {
  beginDesktopAuthorization,
  cancelDesktopAuthorization,
} from "../desktop/auth";
import {
  configureDesktopLocalMode,
  desktopLocalModeStatus,
  type DesktopLocalModeStatus,
  unlockDesktopLocalMode,
} from "../desktop/localMode";
import { InkClouds, PaperCard } from "../components/Ink";
import { Logo } from "../components/Logo";
import { useI18n } from "../i18n";

const DESKTOP_AUTH_TIMEOUT_MS = 5 * 60 * 1000;

export function DesktopLoginPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<DesktopLocalModeStatus | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState<"account" | "local" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const authTimeoutRef = useRef<number | null>(null);

  function clearAuthTimeout() {
    if (authTimeoutRef.current === null) return;
    window.clearTimeout(authTimeoutRef.current);
    authTimeoutRef.current = null;
  }

  useEffect(() => {
    void desktopLocalModeStatus()
      .then(setStatus)
      .catch(() => setError(t.desktopLocalMode.genericError));
  }, [t.desktopLocalMode.genericError]);

  useEffect(() => {
    const handleAuthenticated = () => {
      clearAuthTimeout();
      setLoading(null);
    };
    const handleError = () => {
      clearAuthTimeout();
      setLoading(null);
      setError(t.desktopAuth.failed);
    };
    window.addEventListener("koinote:desktop-authenticated", handleAuthenticated);
    window.addEventListener("koinote:desktop-auth-error", handleError);
    return () => {
      window.removeEventListener("koinote:desktop-authenticated", handleAuthenticated);
      window.removeEventListener("koinote:desktop-auth-error", handleError);
    };
  }, [t.desktopAuth.failed]);

  useEffect(() => () => clearAuthTimeout(), []);

  async function connectAccount() {
    setLoading("account");
    setError(null);
    try {
      await beginDesktopAuthorization();
      queryClient.setQueryData(["session"], { user: null });
      clearAuthTimeout();
      authTimeoutRef.current = window.setTimeout(() => {
        authTimeoutRef.current = null;
        void cancelDesktopAuthorization();
        setLoading((current) => (current === "account" ? null : current));
        setError(t.desktopAuth.timeout);
      }, DESKTOP_AUTH_TIMEOUT_MS);
    } catch {
      clearAuthTimeout();
      setLoading(null);
      setError(t.desktopAuth.failed);
    }
  }

  async function enterLocalMode(event: FormEvent) {
    event.preventDefault();
    if (!status) return;
    if (!status.configured && password !== confirmation) {
      setError(t.desktopLocalMode.passwordMismatch);
      return;
    }
    setLoading("local");
    setError(null);
    try {
      if (status.configured) await unlockDesktopLocalMode(password);
      else await configureDesktopLocalMode(password);
      const nextSession = await getSession();
      queryClient.removeQueries({ queryKey: ["documents"] });
      queryClient.removeQueries({ queryKey: ["document"] });
      queryClient.removeQueries({ queryKey: ["folders"] });
      queryClient.removeQueries({ queryKey: ["documents-trash"] });
      queryClient.setQueryData(["session"], nextSession);
      setPassword("");
      setConfirmation("");
      setLoading(null);
    } catch (caught) {
      setLoading(null);
      setError(
        caught instanceof Error && caught.message === "local_mode_password_invalid"
          ? t.desktopLocalMode.invalidPassword
          : caught instanceof Error && caught.message === "local_mode_password_too_short"
            ? t.desktopLocalMode.passwordHint
            : t.desktopLocalMode.genericError,
      );
    }
  }

  const configured = status?.configured ?? false;

  return (
    <div className="relative flex flex-1 items-center justify-center overflow-hidden px-4 py-10">
      <InkClouds withCinnabar />
      <div className="relative grid w-full max-w-4xl gap-5 md:grid-cols-2">
        <PaperCard className="flex flex-col px-7 py-8 sm:px-9">
          <Logo className="h-12 w-12" />
          <p className="mt-5 text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--ink-faint)" }}>
            {t.desktopAuth.eyebrow}
          </p>
          <h1 className="kn-heading-cn mt-2 text-2xl font-bold">{t.desktopAuth.title}</h1>
          <p className="mt-4 flex-1 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>
            {t.desktopAuth.description}
          </p>
          <button
            type="button"
            onClick={() => void connectAccount()}
            disabled={loading !== null}
            className="mt-7 inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-white disabled:opacity-60"
            style={{ background: "var(--cinnabar)" }}
          >
            {loading === "account" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Laptop className="h-4 w-4" />}
            {loading === "account" ? "…" : t.desktopAuth.signIn}
          </button>
        </PaperCard>

        <PaperCard className="px-7 py-8 sm:px-9">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl" style={{ background: "var(--ink-wash-strong)", color: "var(--ink-strong)" }}>
            <CloudOff className="h-5 w-5" />
          </div>
          <p className="mt-5 text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--ink-faint)" }}>
            {t.desktopLocalMode.badge}
          </p>
          <h2 className="kn-heading-cn mt-2 text-2xl font-bold">
            {configured ? t.desktopLocalMode.unlockTitle : t.desktopLocalMode.setupTitle}
          </h2>
          <p className="mt-3 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
            {configured ? t.desktopLocalMode.unlockDescription : t.desktopLocalMode.setupDescription}
          </p>

          <form className="mt-6 space-y-4" onSubmit={(event) => void enterLocalMode(event)}>
            <label className="block text-sm font-medium">
              {t.desktopLocalMode.password}
              <span className="relative mt-1.5 block">
                <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: "var(--ink-faint)" }} />
                <input
                  type="password"
                  value={password}
                  minLength={8}
                  required
                  autoComplete={configured ? "current-password" : "new-password"}
                  onChange={(event) => setPassword(event.target.value)}
                  className="w-full rounded-xl border bg-transparent py-2.5 pl-10 pr-3 outline-none focus:border-cinnabar-500"
                  style={{ borderColor: "var(--ink-line)" }}
                />
              </span>
            </label>
            {!configured && (
              <label className="block text-sm font-medium">
                {t.desktopLocalMode.confirmPassword}
                <input
                  type="password"
                  value={confirmation}
                  minLength={8}
                  required
                  autoComplete="new-password"
                  onChange={(event) => setConfirmation(event.target.value)}
                  className="mt-1.5 w-full rounded-xl border bg-transparent px-3 py-2.5 outline-none focus:border-cinnabar-500"
                  style={{ borderColor: "var(--ink-line)" }}
                />
              </label>
            )}
            <p className="text-xs leading-5" style={{ color: "var(--ink-faint)" }}>
              {t.desktopLocalMode.passwordHint}
            </p>
            <button
              type="submit"
              disabled={!status || loading !== null}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl border px-5 py-3 text-sm font-semibold disabled:opacity-60"
              style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
            >
              {loading === "local" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              {loading === "local"
                ? configured ? t.desktopLocalMode.unlocking : t.desktopLocalMode.creating
                : configured ? t.desktopLocalMode.unlock : t.desktopLocalMode.create}
            </button>
          </form>
          <div className="mt-5 space-y-2 border-t pt-4 text-xs leading-5" style={{ borderColor: "var(--ink-line)", color: "var(--ink-faint)" }}>
            <p>{t.desktopLocalMode.encrypted}</p>
            <p>{t.desktopLocalMode.networkDisabled}</p>
          </div>
        </PaperCard>

        {error && (
          <p className="text-center text-sm md:col-span-2" role="alert" style={{ color: "var(--cinnabar)" }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
