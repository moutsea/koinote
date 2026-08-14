import { Link } from "@tanstack/react-router";
import { Check, Laptop, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { authorizeDesktop } from "../api";
import { useSession } from "../auth";
import { InkClouds, PaperCard } from "../components/Ink";
import { Logo } from "../components/Logo";
import { PageContainer } from "../components/PageContainer";
import { useI18n } from "../i18n";

const PKCE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

export function DesktopAuthorizePage() {
  const { t } = useI18n();
  const session = useSession();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const clientId = params.get("client_id")?.trim() ?? "";
    const codeChallenge = params.get("code_challenge")?.trim() ?? "";
    const state = params.get("state")?.trim() ?? "";
    if (
      clientId !== "koinote-desktop" ||
      !PKCE_PATTERN.test(codeChallenge) ||
      !state ||
      state.length > 512
    ) {
      return null;
    }
    return { clientId, codeChallenge, state };
  }, []);

  async function approve() {
    if (!request || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await authorizeDesktop(request);
      window.location.assign(result.redirectUri);
    } catch {
      setError(t.desktopAuth.failed);
      setSubmitting(false);
    }
  }

  const redirectTo = `${window.location.pathname}${window.location.search}`;

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <InkClouds withCinnabar />
      <PageContainer className="relative flex flex-1 items-center justify-center py-12 sm:py-20">
        <PaperCard className="w-full max-w-xl px-6 py-8 sm:px-10 sm:py-10">
          <div className="flex items-center gap-3">
            <Logo className="h-11 w-11" />
            <div>
              <p
                className="text-xs font-semibold uppercase tracking-[0.18em]"
                style={{ color: "var(--cinnabar)" }}
              >
                {t.desktopAuth.eyebrow}
              </p>
              <h1
                className="kn-heading-cn mt-1 text-2xl font-bold"
                style={{ color: "var(--ink-black)" }}
              >
                {t.desktopAuth.title}
              </h1>
            </div>
          </div>

          {!request ? (
            <p className="mt-8 text-sm leading-7" style={{ color: "var(--cinnabar)" }}>
              {t.desktopAuth.invalid}
            </p>
          ) : session.isLoading ? (
            <p className="mt-8 text-sm" style={{ color: "var(--ink-mid)" }}>
              …
            </p>
          ) : !session.data?.user ? (
            <div className="mt-8">
              <Link
                to="/login"
                search={{ redirectTo }}
                className="inline-flex rounded-full px-5 py-2.5 text-sm font-semibold text-white"
                style={{ background: "var(--cinnabar)" }}
              >
                {t.desktopAuth.signIn}
              </Link>
            </div>
          ) : (
            <>
              <p className="mt-7 text-sm leading-7" style={{ color: "var(--ink-strong)" }}>
                {t.desktopAuth.description}
              </p>
              <div
                className="mt-6 rounded-2xl border p-5"
                style={{ borderColor: "var(--ink-line)", background: "var(--ink-paper-soft)" }}
              >
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <ShieldCheck className="h-4 w-4" />
                  {t.desktopAuth.permissionsTitle}
                </div>
                <ul className="mt-4 space-y-3 text-sm" style={{ color: "var(--ink-mid)" }}>
                  {[
                    t.desktopAuth.permissionDocuments,
                    t.desktopAuth.permissionOffline,
                    t.desktopAuth.permissionIdentity,
                  ].map((permission) => (
                    <li key={permission} className="flex gap-2.5">
                      <Check className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--cinnabar)" }} />
                      <span>{permission}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="mt-7 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void approve()}
                  disabled={submitting}
                  className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
                  style={{ background: "var(--cinnabar)" }}
                >
                  <Laptop className="h-4 w-4" />
                  {t.desktopAuth.approve}
                </button>
                <Link
                  to="/"
                  className="rounded-full px-5 py-2.5 text-sm font-semibold"
                  style={{ color: "var(--ink-mid)" }}
                >
                  {t.desktopAuth.cancel}
                </Link>
              </div>
              {error && (
                <p className="mt-4 text-sm" style={{ color: "var(--cinnabar)" }}>
                  {error}
                </p>
              )}
            </>
          )}
        </PaperCard>
      </PageContainer>
    </div>
  );
}
