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

export function formatBillingPrice(amount: number, currency: string, locale: string) {
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

export function isTerminalBillingHTTPStatus(status: number): boolean {
  return (
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 425 &&
    status !== 429
  );
}
