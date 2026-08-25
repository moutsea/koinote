import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, Coins, Crown, LoaderCircle } from "lucide-react";
import {
  ApiError,
  createAgentCreditsCheckout,
  createMembershipCheckout,
  getBillingPricing,
  getMembershipStatus,
  type AgentCreditPack,
} from "../api";
import { useCurrentUser } from "../auth";
import { InkClouds, PaperCard } from "../components/Ink";
import {
  DEFAULT_CURRENCY_BY_LOCALE,
  formatBillingPrice,
} from "../billingCore";
import { PageContainer } from "../components/PageContainer";
import { formatCreditPackPrice } from "../components/AgentCreditsCard";
import { interpolate, useI18n } from "../i18n";
import { formatBytes } from "../storage";
import { openMembershipCheckout } from "../externalNavigation";

const PRICING_KEY = ["billing-pricing"] as const;

export function PricingPage() {
  const user = useCurrentUser();
  const queryClient = useQueryClient();
  const { t, locale } = useI18n();
  const [selectedCurrency, setSelectedCurrency] = useState(
    () => DEFAULT_CURRENCY_BY_LOCALE[locale] ?? "usd",
  );
  const pricing = useQuery({
    queryKey: PRICING_KEY,
    queryFn: getBillingPricing,
    retry: false,
  });
  const checkout = useMutation({
    async mutationFn(currency: string) {
      const result = await createMembershipCheckout(currency);
      await openMembershipCheckout(result.url);
      return result;
    },
    onError(error) {
      if (
        error instanceof ApiError &&
        (error.code === "checkout_in_progress" ||
          error.code === "membership_already_active")
      ) {
        void queryClient.invalidateQueries({ queryKey: ["session"] });
        void queryClient.invalidateQueries({ queryKey: ["membership-status"] });
      }
    },
  });
  const checkoutErrorCode =
    checkout.error instanceof ApiError ? checkout.error.code : undefined;
  const checkoutInProgress = checkoutErrorCode === "checkout_in_progress";
  const membership = useQuery({
    queryKey: ["membership-status"],
    queryFn: getMembershipStatus,
    enabled: Boolean(user),
    retry: false,
    refetchInterval: (query) =>
      checkoutInProgress && !query.state.data?.membership.active ? 2_000 : false,
  });
  const creditCheckout = useMutation({
    async mutationFn({ pack, currency }: { pack: AgentCreditPack; currency: string }) {
      const result = await createAgentCreditsCheckout(pack.code, currency);
      await openMembershipCheckout(result.url);
      return result;
    },
  });

  const data = pricing.data?.pricing;
  const selectedPrice =
    data?.prices.find((price) => price.currency.toLowerCase() === selectedCurrency) ??
    data?.prices[0];
  const freeStorage = formatBytes(data?.freeStorageQuotaBytes ?? 500 * 1024 * 1024, locale);
  const lifetimeStorage = formatBytes(data?.lifetimeStorageQuotaBytes ?? 10 * 1024 * 1024 * 1024, locale);
  const lifetimePrice = selectedPrice
    ? formatBillingPrice(selectedPrice.amount, selectedPrice.currency, locale)
    : "—";
  const active =
    membership.data?.membership.active ?? user?.membershipTier === "lifetime";
  const creditPacks = data?.creditPacks ?? [];

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <InkClouds withCinnabar />
      <PageContainer className="relative flex-1 py-16 sm:py-20">
        <div className="mx-auto max-w-3xl text-center">
          <p
            className="text-xs font-semibold uppercase tracking-[0.2em]"
            style={{ color: "var(--cinnabar)" }}
          >
            {t.pricing.eyebrow}
          </p>
          <h1
            className="kn-heading-cn mt-4 text-3xl font-bold tracking-tight sm:text-5xl"
            style={{ color: "var(--ink-black)" }}
          >
            {t.pricing.title}
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-7" style={{ color: "var(--ink-mid)" }}>
            {t.pricing.subtitle}
          </p>
        </div>

        {pricing.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-24 text-sm" style={{ color: "var(--ink-mid)" }}>
            <LoaderCircle className="h-4 w-4 animate-spin" />
            {t.pricing.loading}
          </div>
        ) : pricing.isError || !data ? (
          <p className="py-24 text-center text-sm" style={{ color: "var(--ink-mid)" }}>
            {t.pricing.loadFailed}
          </p>
        ) : (
          <>
            <div className="mx-auto mt-12 grid max-w-5xl gap-5 lg:grid-cols-2">
              <PricingCard
                name={t.pricing.freeName}
                description={t.pricing.freeDescription}
                price={t.pricing.freePrice}
                period={t.pricing.freePeriod}
                included={t.pricing.included}
                features={t.pricing.freeFeatures.map((feature) =>
                  interpolate(feature, { storage: freeStorage }),
                )}
                action={
                  <Link
                    to="/editor"
                    className="inline-flex w-full items-center justify-center rounded-full border px-5 py-2.5 text-sm font-semibold transition hover:bg-[var(--ink-wash-strong)]"
                    style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
                  >
                    {t.home.ctaStart}
                  </Link>
                }
              />

              <PricingCard
                featured
                name={t.pricing.lifetimeName}
                description={t.pricing.lifetimeDescription}
                price={lifetimePrice}
                period={t.pricing.lifetimePeriod}
                priceControl={
                  data.prices.length > 1 ? (
                    <label className="mt-4 block max-w-56 text-xs" style={{ color: "var(--ink-mid)" }}>
                      <span className="mb-1.5 block">{t.membership.currencyLabel}</span>
                      <select
                        value={selectedPrice?.currency.toLowerCase() ?? selectedCurrency}
                        onChange={(event) => setSelectedCurrency(event.target.value)}
                        disabled={checkout.isPending || checkoutInProgress}
                        className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none disabled:opacity-60"
                        style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
                      >
                        {data.prices.map((price) => (
                          <option key={price.currency} value={price.currency.toLowerCase()}>
                            {price.currency.toUpperCase()} · {formatBillingPrice(price.amount, price.currency, locale)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : undefined
                }
                included={t.pricing.included}
                badge={active ? t.membership.activeBadge : t.pricing.recommended}
                features={t.pricing.lifetimeFeatures.map((feature) =>
                  interpolate(feature, { storage: lifetimeStorage }),
                )}
                action={
                  active ? (
                    <Link
                      to="/settings"
                      search={{ section: "ai" }}
                      className="inline-flex w-full items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold transition hover:opacity-85"
                      style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}
                    >
                      {t.pricing.manageMembership}
                    </Link>
                  ) : user ? (
                    <button
                      type="button"
                      onClick={() => selectedPrice && checkout.mutate(selectedPrice.currency)}
                      disabled={
                        !data.billingEnabled ||
                        !selectedPrice ||
                        checkout.isPending ||
                        checkoutInProgress
                      }
                      className="inline-flex w-full items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-60"
                      style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}
                    >
                      {checkout.isPending && <LoaderCircle className="h-4 w-4 animate-spin" />}
                      {checkout.isPending ? t.membership.redirecting : t.membership.purchase}
                    </button>
                  ) : (
                    <a
                      href="/login?redirectTo=%2Fpricing"
                      className="inline-flex w-full items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold transition hover:opacity-85"
                      style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}
                    >
                      {t.pricing.loginToUpgrade}
                    </a>
                  )
                }
                note={
                  active
                    ? t.pricing.active
                    : !data.billingEnabled
                      ? t.pricing.unavailable
                      : checkoutErrorCode === "checkout_in_progress"
                        ? t.membership.checkoutPending
                        : checkoutErrorCode === "membership_already_active"
                          ? t.membership.checkoutSuccess
                          : checkout.isError
                            ? t.membership.checkoutFailed
                        : undefined
                }
              />
            </div>

            {creditPacks.length > 0 && <section className="mx-auto mt-16 max-w-5xl">
              <div className="mx-auto max-w-2xl text-center">
                <Coins className="mx-auto h-6 w-6" style={{ color: "var(--ink-mid)" }} />
                <h2 className="kn-heading-cn mt-3 text-2xl font-bold" style={{ color: "var(--ink-black)" }}>
                  {t.pricing.creditsTitle}
                </h2>
                <p className="mt-3 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
                  {t.pricing.creditsDescription}
                </p>
                {data.prices.length > 1 && (
                  <label className="mx-auto mt-5 block max-w-56 text-left text-xs" style={{ color: "var(--ink-mid)" }}>
                    <span className="mb-1.5 block">{t.membership.currencyLabel}</span>
                    <select
                      value={selectedPrice?.currency.toLowerCase() ?? selectedCurrency}
                      onChange={(event) => setSelectedCurrency(event.target.value)}
                      disabled={creditCheckout.isPending}
                      className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none disabled:opacity-60"
                      style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
                    >
                      {data.prices.map((price) => (
                        <option key={price.currency} value={price.currency.toLowerCase()}>
                          {price.currency.toUpperCase()}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              <div className="mt-7 grid gap-4 sm:grid-cols-3">
                {creditPacks.map((pack) => (
                  <CreditPackCard
                    key={pack.code}
                    pack={pack}
                    currency={selectedPrice?.currency ?? selectedCurrency}
                    locale={locale}
                    action={active ? (
                      <button
                        type="button"
                        onClick={() => creditCheckout.mutate({
                          pack,
                          currency: selectedPrice?.currency ?? selectedCurrency,
                        })}
                        disabled={!data.creditPurchaseEnabled || creditCheckout.isPending}
                        className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition hover:bg-[var(--ink-wash)] disabled:cursor-not-allowed disabled:opacity-50"
                        style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
                      >
                        {creditCheckout.isPending && creditCheckout.variables?.pack.code === pack.code && (
                          <LoaderCircle className="h-4 w-4 animate-spin" />
                        )}
                        {t.pricing.buyCredits}
                      </button>
                    ) : undefined}
                  />
                ))}
              </div>
              <p className="mt-4 text-center text-xs leading-5" style={{ color: creditCheckout.isError ? "var(--cinnabar)" : "var(--ink-faint)" }}>
                {!active
                  ? t.pricing.creditsMembersOnly
                  : !data.creditPurchaseEnabled
                    ? t.agentCredits.purchaseUnavailable
                    : creditCheckout.isError
                      ? t.agentCredits.checkoutFailed
                      : t.pricing.creditsNote}
              </p>
            </section>}

            <section className="mx-auto mt-20 max-w-4xl">
              <h2 className="kn-heading-cn text-center text-2xl font-bold" style={{ color: "var(--ink-black)" }}>
                {t.pricing.faqTitle}
              </h2>
              <div className="mt-8 grid gap-4 sm:grid-cols-2">
                {t.pricing.faqs.map((faq) => (
                  <PaperCard key={faq.question} className="p-5 sm:p-6">
                    <h3 className="font-semibold" style={{ color: "var(--ink-black)" }}>
                      {faq.question}
                    </h3>
                    <p className="mt-2 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
                      {faq.answer}
                    </p>
                  </PaperCard>
                ))}
              </div>
            </section>
          </>
        )}
      </PageContainer>
    </div>
  );
}

function CreditPackCard({
  pack,
  currency,
  locale,
  action,
}: {
  pack: AgentCreditPack;
  currency: string;
  locale: string;
  action?: React.ReactNode;
}) {
  return (
    <PaperCard className="flex flex-col p-5 text-center sm:p-6">
      <p className="text-2xl font-bold tabular-nums" style={{ color: "var(--ink-black)" }}>
        {pack.credits.toLocaleString(locale)}
      </p>
      <p className="mt-1 text-sm font-medium" style={{ color: "var(--ink-mid)" }}>credits</p>
      <p className="mt-4 text-lg font-semibold" style={{ color: "var(--ink-strong)" }}>
        {formatCreditPackPrice(pack, currency, locale)}
      </p>
      <div className="mt-auto">{action}</div>
    </PaperCard>
  );
}

function PricingCard({
  name,
  description,
  price,
  period,
  priceControl,
  included,
  features,
  action,
  badge,
  note,
  featured = false,
}: {
  name: string;
  description: string;
  price: string;
  period: string;
  priceControl?: React.ReactNode;
  included: string;
  features: string[];
  action: React.ReactNode;
  badge?: string;
  note?: string;
  featured?: boolean;
}) {
  return (
    <PaperCard className={`relative flex h-full flex-col p-6 sm:p-8 ${featured ? "shadow-lg" : ""}`}>
      {badge && (
        <span
          className="absolute right-5 top-5 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold"
          style={{ borderColor: "var(--ink-line)", background: "var(--ink-wash)", color: "var(--ink-strong)" }}
        >
          {featured && <Crown className="h-3.5 w-3.5" />}
          {badge}
        </span>
      )}
      <h2 className="kn-heading-cn pr-24 text-xl font-bold" style={{ color: "var(--ink-black)" }}>
        {name}
      </h2>
      <p className="mt-2 min-h-12 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
        {description}
      </p>
      <div className="mt-7">
        <p className="text-4xl font-bold tracking-tight" style={{ color: "var(--ink-black)" }}>
          {price}
        </p>
        <p className="mt-1.5 text-xs" style={{ color: "var(--ink-faint)" }}>
          {period}
        </p>
        {priceControl}
      </div>
      <div className="mt-7 border-t pt-6" style={{ borderColor: "var(--ink-line)" }}>
        <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--ink-faint)" }}>
          {included}
        </p>
        <ul className="mt-4 space-y-3">
          {features.map((feature) => (
            <li key={feature} className="flex items-start gap-2.5 text-sm leading-6" style={{ color: "var(--ink-strong)" }}>
              <Check className="mt-1 h-4 w-4 shrink-0" style={{ color: "var(--ink-mid)" }} />
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-auto pt-8">
        {action}
        {note && (
          <p className="mt-3 text-center text-xs leading-5" style={{ color: "var(--ink-faint)" }}>
            {note}
          </p>
        )}
      </div>
    </PaperCard>
  );
}
