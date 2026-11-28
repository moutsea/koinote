export type BillingPrice = {
  amount: number;
  currency: string;
};

export const DEFAULT_CURRENCY_BY_LOCALE: Record<string, string> = {
  zh: "cny",
  ja: "jpy",
  fr: "eur",
  en: "usd",
};

// /api/billing/pricing 读不到时的兜底容量。真值在后端（billingPricing），
// 价格页与 Worker 边缘渲染共用这两个常量，免得两处各写一份数字。
export const DEFAULT_FREE_STORAGE_QUOTA_BYTES = 500 * 1024 * 1024;
export const DEFAULT_LIFETIME_STORAGE_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;

const ZERO_DECIMAL_CURRENCIES = new Set(["jpy"]);

export function billingPriceFor(
  prices: BillingPrice[] | undefined,
  currency: string,
  fallback: BillingPrice,
): BillingPrice {
  return prices?.find(
    (price) => price.currency.toLowerCase() === currency.toLowerCase(),
  ) ?? fallback;
}

// Membership prices come from a public API. Ignore incomplete or invalid entries
// before they reach either the purchase controls or search-engine offers.
export function validMembershipPrices(prices: unknown): BillingPrice[] {
  if (!Array.isArray(prices)) return [];
  const currencies = Object.values(DEFAULT_CURRENCY_BY_LOCALE);
  return prices
    .filter((price): price is BillingPrice =>
      price != null &&
      Number.isSafeInteger(price.amount) && price.amount > 0 &&
      typeof price.currency === "string" && currencies.includes(price.currency.toLowerCase()),
    )
    .map((price) => ({ amount: price.amount, currency: price.currency.toLowerCase() }));
}

export function billingPriceAmount(amount: number, currency: string): string {
  const zeroDecimal = ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase());
  return (amount / (zeroDecimal ? 1 : 100)).toFixed(zeroDecimal ? 0 : 2);
}

export function formatBillingPrice(amount: number, currency: string, locale: string) {
  const normalizedCurrency = currency.toLowerCase();
  const value = billingPriceAmount(amount, normalizedCurrency);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: normalizedCurrency.toUpperCase(),
      currencyDisplay: "narrowSymbol",
    }).format(Number(value));
  } catch {
    return `${normalizedCurrency.toUpperCase()} ${value}`;
  }
}

export function isTerminalBillingHTTPStatus(status: number): boolean {
  return (
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 425 &&
    status !== 429
  );
}
