import { Laptop, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { beginDesktopAuthorization } from "../desktop/auth";
import { InkClouds, PaperCard } from "../components/Ink";
import { Logo } from "../components/Logo";
import { useI18n } from "../i18n";

export function DesktopLoginPage() {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleError = () => {
      setLoading(false);
      setError(t.desktopAuth.failed);
    };
    window.addEventListener("koinote:desktop-auth-error", handleError);
    return () => window.removeEventListener("koinote:desktop-auth-error", handleError);
  }, [t.desktopAuth.failed]);

  async function connect() {
    setLoading(true);
    setError(null);
    try {
      await beginDesktopAuthorization();
    } catch {
      setLoading(false);
      setError(t.desktopAuth.failed);
    }
  }

  return (
    <div className="relative flex flex-1 items-center justify-center overflow-hidden px-4 py-12">
      <InkClouds withCinnabar />
      <PaperCard className="relative w-full max-w-md px-7 py-9 text-center sm:px-10">
        <Logo className="mx-auto h-14 w-14" />
        <h1 className="kn-heading-cn mt-5 text-2xl font-bold">{t.desktopAuth.title}</h1>
        <p className="mt-4 text-sm leading-7" style={{ color: "var(--ink-mid)" }}>
          {t.desktopAuth.description}
        </p>
        <button
          type="button"
          onClick={() => void connect()}
          disabled={loading}
          className="mt-7 inline-flex items-center gap-2 rounded-full px-6 py-3 text-sm font-semibold text-white disabled:opacity-60"
          style={{ background: "var(--cinnabar)" }}
        >
          <Laptop className="h-4 w-4" />
          {loading ? "…" : t.desktopAuth.signIn}
        </button>
        <div className="mt-6 flex items-start gap-2 text-left text-xs leading-5" style={{ color: "var(--ink-faint)" }}>
          <WifiOff className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t.desktopAuth.permissionOffline}</span>
        </div>
        {error && <p className="mt-4 text-sm" style={{ color: "var(--cinnabar)" }}>{error}</p>}
      </PaperCard>
    </div>
  );
}
