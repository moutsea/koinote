import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Crown, HardDrive, LoaderCircle, Sparkles } from "lucide-react";
import {
  confirmMembershipCheckout,
  createMembershipCheckout,
  getMembershipStatus,
  type User,
} from "../api";
import { useI18n } from "../i18n";
import { PaperCard } from "./Ink";
import { STORAGE_USAGE_KEY } from "./StorageCard";

export const MEMBERSHIP_STATUS_KEY = ["membership-status"] as const;

type CheckoutNotice = "none" | "success" | "pending" | "cancelled" | "failed";

export const DEFAULT_CURRENCY_BY_LOCALE: Record<string, string> = {
  zh: "cny",
  ja: "jpy",
  fr: "eur",
  en: "usd",
};

const ZERO_DECIMAL_CURRENCIES = new Set(["jpy"]);

function clearCheckoutQuery() {
  const url = new URL(window.location.href);
  url.searchParams.delete("checkout");
  url.searchParams.delete("session_id");
  window.history.replaceState(null, "", url);
}

export function formatMembershipPrice(amount: number, currency: string, locale: string) {
  const normalizedCurrency = currency.toLowerCase();
  const divisor = ZERO_DECIMAL_CURRENCIES.has(normalizedCurrency) ? 1 : 100;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: normalizedCurrency.toUpperCase(),
      currencyDisplay: "narrowSymbol",
    }).format(amount / divisor);
  } catch {
    return `${normalizedCurrency.toUpperCase()} ${(amount / divisor).toFixed(divisor === 1 ? 0 : 2)}`;
  }
}

export function MembershipCard({ user }: { user: User }) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const handledReturn = useRef(false);
  const [notice, setNotice] = useState<CheckoutNotice>("none");
  const [selectedCurrency, setSelectedCurrency] = useState(
    () => DEFAULT_CURRENCY_BY_LOCALE[locale] ?? "usd",
  );

  const status = useQuery({
    queryKey: MEMBERSHIP_STATUS_KEY,
    queryFn: getMembershipStatus,
    retry: false,
  });
  const checkout = useMutation({
    mutationFn: createMembershipCheckout,
    onSuccess(data) {
      window.location.assign(data.url);
    },
    onError() {
      setNotice("failed");
    },
  });

  useEffect(() => {
    if (handledReturn.current) return;
    handledReturn.current = true;

    const url = new URL(window.location.href);
    const checkoutResult = url.searchParams.get("checkout");
    const sessionId = url.searchParams.get("session_id");
    if (checkoutResult === "cancelled") {
      setNotice("cancelled");
      clearCheckoutQuery();
      return;
    }
    if (checkoutResult !== "success" || !sessionId) return;

    setNotice("pending");
    void confirmMembershipCheckout(sessionId)
      .then(async (result) => {
        if (result.status === "pending") {
          setNotice("pending");
          return;
        }
        if (result.user) {
          queryClient.setQueryData(["session"], { user: result.user });
        }
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["session"] }),
          queryClient.invalidateQueries({ queryKey: MEMBERSHIP_STATUS_KEY }),
          queryClient.invalidateQueries({ queryKey: STORAGE_USAGE_KEY }),
        ]);
        setNotice("success");
        clearCheckoutQuery();
      })
      .catch(() => setNotice("failed"));
  }, [queryClient]);

  useEffect(() => {
    if (notice !== "pending") return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      void queryClient
        .fetchQuery({ queryKey: MEMBERSHIP_STATUS_KEY, queryFn: getMembershipStatus })
        .then((result) => {
          if (!result.membership.active) return;
          window.clearInterval(timer);
          setNotice("success");
          clearCheckoutQuery();
          void queryClient.invalidateQueries({ queryKey: ["session"] });
          void queryClient.invalidateQueries({ queryKey: STORAGE_USAGE_KEY });
        })
        .catch(() => undefined);
      if (attempts >= 30) window.clearInterval(timer);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [notice, queryClient]);

  const membership = status.data?.membership;
  const active = membership?.active ?? user.membershipTier === "lifetime";
  const prices = membership?.prices?.length
    ? membership.prices
    : [{ amount: membership?.priceAmount ?? 399, currency: membership?.priceCurrency ?? "usd" }];
  const selectedPrice =
    prices.find((option) => option.currency.toLowerCase() === selectedCurrency) ?? prices[0];
  const price = formatMembershipPrice(selectedPrice.amount, selectedPrice.currency, locale);

  const noticeText =
    notice === "success"
      ? t.membership.checkoutSuccess
      : notice === "pending"
        ? t.membership.checkoutPending
        : notice === "cancelled"
          ? t.membership.checkoutCancelled
          : notice === "failed"
            ? t.membership.checkoutFailed
            : "";

  return (
    <PaperCard>
      <div className="p-6 sm:p-7">
        {noticeText && (
          <div
            className="mb-5 rounded-lg border px-4 py-3 text-sm"
            style={{
              borderColor: "var(--ink-line)",
              background: "var(--ink-wash)",
              color: "var(--ink-strong)",
            }}
            role="status"
          >
            {noticeText}
          </div>
        )}

        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-2xl">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="rounded-lg p-2"
                style={{ background: "var(--ink-wash)", color: "var(--ink-strong)" }}
              >
                <Crown className="h-5 w-5" />
              </span>
              <h2
                className="kn-heading-cn text-lg font-bold"
                style={{ color: "var(--ink-black)" }}
              >
                {t.membership.title}
              </h2>
              <span
                className="rounded-full border px-2.5 py-1 text-xs font-medium"
                style={{
                  borderColor: "var(--ink-line)",
                  background: "var(--ink-wash)",
                  color: "var(--ink-mid)",
                }}
              >
                {active ? t.membership.activeBadge : t.membership.lifetimeBadge}
              </span>
            </div>

            <p className="mt-3 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
              {active ? t.membership.activeDescription : t.membership.description}
            </p>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <Benefit icon={<HardDrive className="h-4 w-4" />} title={t.membership.storageBenefit} />
              <Benefit
                icon={<Sparkles className="h-4 w-4" />}
                title={t.membership.aiBenefit}
                detail={t.membership.aiComingSoon}
              />
            </div>
          </div>

          <div className="min-w-52 shrink-0 sm:text-right">
            {active ? (
              <div className="inline-flex items-center gap-2 font-semibold" style={{ color: "var(--ink-strong)" }}>
                <Check className="h-5 w-5" />
                {t.membership.activeTitle}
              </div>
            ) : status.isError ? (
              <p className="text-sm" style={{ color: "var(--ink-mid)" }}>
                {t.membership.loadFailed}
              </p>
            ) : (
              <>
                <p className="text-3xl font-bold" style={{ color: "var(--ink-black)" }}>
                  {price}
                </p>
                <p className="mt-1 text-xs" style={{ color: "var(--ink-faint)" }}>
                  {t.membership.oneTimePayment}
                </p>
                {prices.length > 1 && (
                  <label className="mt-4 block text-left text-xs" style={{ color: "var(--ink-mid)" }}>
                    <span className="mb-1.5 block">{t.membership.currencyLabel}</span>
                    <select
                      value={selectedPrice.currency.toLowerCase()}
                      onChange={(event) => setSelectedCurrency(event.target.value)}
                      disabled={checkout.isPending}
                      className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none disabled:opacity-60"
                      style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
                    >
                      {prices.map((option) => (
                        <option key={option.currency} value={option.currency.toLowerCase()}>
                          {option.currency.toUpperCase()} · {formatMembershipPrice(option.amount, option.currency, locale)}
                        </option>
                      ))}
                    </select>
                    <span className="mt-1.5 block" style={{ color: "var(--ink-faint)" }}>
                      {t.membership.currencyHint}
                    </span>
                  </label>
                )}
                {membership && !membership.billingEnabled ? (
                  <p className="mt-4 max-w-56 text-sm" style={{ color: "var(--ink-mid)" }}>
                    {t.membership.unavailable}
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={() => checkout.mutate(selectedPrice.currency)}
                    disabled={checkout.isPending || status.isLoading}
                    className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-60"
                    style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}
                  >
                    {checkout.isPending && <LoaderCircle className="h-4 w-4 animate-spin" />}
                    {checkout.isPending ? t.membership.redirecting : t.membership.purchase}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </PaperCard>
  );
}

function Benefit({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail?: string;
}) {
  return (
    <div className="flex items-start gap-2.5 text-sm" style={{ color: "var(--ink-strong)" }}>
      <span className="mt-0.5" style={{ color: "var(--ink-mid)" }}>
        {icon}
      </span>
      <span>
        <span className="font-medium">{title}</span>
        {detail && (
          <span className="mt-0.5 block text-xs" style={{ color: "var(--ink-faint)" }}>
            {detail}
          </span>
        )}
      </span>
    </div>
  );
}
