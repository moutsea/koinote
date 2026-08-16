import { useEffect, useMemo } from "react";
import { Check, LoaderCircle, X } from "lucide-react";
import { InkClouds, PaperCard } from "../components/Ink";
import { PageContainer } from "../components/PageContainer";
import { useI18n } from "../i18n";
import { desktopBillingDeepLink } from "../desktop/billingCore";

export function DesktopBillingReturnPage() {
  const { t } = useI18n();
  const target = useMemo(() => desktopBillingDeepLink(window.location.href), []);
  const cancelled = new URL(window.location.href).searchParams.get("checkout") === "cancelled";

  useEffect(() => {
    if (!target) return;
    const timer = window.setTimeout(() => window.location.assign(target), 150);
    return () => window.clearTimeout(timer);
  }, [target]);

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <InkClouds />
      <PageContainer className="relative flex flex-1 items-center justify-center py-16">
        <PaperCard className="w-full max-w-lg p-7 text-center sm:p-9">
          <span
            className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full"
            style={{ background: "var(--ink-wash)", color: "var(--ink-strong)" }}
          >
            {cancelled ? <X className="h-5 w-5" /> : <Check className="h-5 w-5" />}
          </span>
          <h1 className="kn-heading-cn mt-5 text-2xl font-bold" style={{ color: "var(--ink-black)" }}>
            {cancelled ? t.desktopBilling.cancelledTitle : t.desktopBilling.successTitle}
          </h1>
          <p className="mt-3 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
            {t.desktopBilling.description}
          </p>
          {target ? (
            <a
              href={target}
              className="mt-6 inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold"
              style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}
            >
              <LoaderCircle className="h-4 w-4" />
              {t.desktopBilling.openApp}
            </a>
          ) : (
            <p className="mt-6 text-sm" style={{ color: "var(--cinnabar)" }}>
              {t.desktopBilling.invalid}
            </p>
          )}
        </PaperCard>
      </PageContainer>
    </div>
  );
}
