import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import worker from "./_seo_bundle.mjs";

const bundle = await build({
  stdin: {
    contents: `export {zh} from './spa/src/i18n/zh'; export {en} from './spa/src/i18n/en';
      export {fr} from './spa/src/i18n/fr'; export {ja} from './spa/src/i18n/ja';
      export * from './spa/src/billingCore';`,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, format: "esm", platform: "node",
});
const { zh, en, fr, ja, formatBillingPrice } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const messages = { zh, en, fr, ja };
const shell = readFileSync("spa/index.html", "utf8");
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const initialPricing = {
  billingEnabled: true,
  prices: [
    { amount: 749, currency: "usd" }, { amount: 5300, currency: "CNY" },
    { amount: 1099, currency: "eur" }, { amount: 1234, currency: "jpy" },
  ],
  freeStorageQuotaBytes: 2 * 1024 ** 3,
  lifetimeStorageQuotaBytes: 50 * 1024 ** 3,
};
let pricing = structuredClone(initialPricing);
let backendCalls = 0;
let respond = () => Response.json({ pricing });
let backend = "https://pricing-test.example";
let clock = originalNow();
Date.now = () => clock;

const env = () => ({
  BACKEND_URL: backend,
  BACKEND_INTERNAL_TOKEN: "test-internal-pricing",
  BACKEND_ORIGIN_TOKEN: "test-origin-pricing",
  ASSETS: { fetch: async () => new Response(shell, { headers: { "content-type": "text/html" } }) },
});
const get = (path, headers = {}) => worker.fetch(new Request(`https://koinote.app${path}`, { headers }), env());
async function readPage(path, headers) {
  const response = await get(path, headers);
  assert.equal(response.status, 200);
  const html = await response.text();
  const { document } = parseHTML(html);
  const graph = JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent)["@graph"];
  const offers = graph.find(item => item["@type"] === "SoftwareApplication").offers;
  assert.ok(graph.some(item => item["@type"] === "BreadcrumbList"));
  assert.doesNotMatch(html, /test-internal-pricing|test-origin-pricing/);
  return { response, document, offers, text: document.querySelector("main").textContent };
}

globalThis.fetch = async (input, init) => {
  backendCalls++;
  assert.equal(new URL(input.url ?? input).pathname, "/api/billing/pricing");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("x-koinote-internal-token"), "test-internal-pricing");
  assert.equal(headers.get("x-koinote-origin-token"), "test-origin-pricing");
  assert.equal(headers.get("authorization"), null);
  assert.equal(headers.get("cookie"), null);
  assert.equal(init.redirect, "manual");
  return respond(init);
};

try {
  const expected = [
    ["zh", "CNY", "53.00"], ["en", "USD", "7.49"],
    ["fr", "EUR", "10.99"], ["ja", "JPY", "1234"],
  ];
  for (const [locale, currency, amount] of expected) {
    const page = await readPage(`/pricing?lang=${locale}`, { cookie: "private-session", authorization: "Bearer private" });
    assert.equal(page.offers.length, 2);
    assert.equal(page.offers[0].price, "0");
    assert.equal(page.offers[0].priceCurrency, currency);
    assert.equal(page.offers[1].price, amount);
    assert.equal(page.offers[1].priceCurrency, currency);
    assert.equal(page.offers[1].description, messages[locale].pricing.lifetimePeriod);
    assert.equal(page.offers[1].url, `https://koinote.app/pricing?lang=${locale}`);
    const source = pricing.prices.find(price => price.currency.toUpperCase() === currency);
    assert.ok(page.text.includes(formatBillingPrice(source.amount, currency, locale)));
    assert.ok(page.text.includes(formatBillingPrice(0, currency, locale)));
    assert.ok(page.text.includes(messages[locale].pricing.lifetimePeriod));
    for (const faq of messages[locale].pricing.faqs) assert.ok(page.text.includes(faq.answer));
    assert.equal(page.document.querySelector('link[rel="canonical"]').getAttribute("href"), page.offers[1].url);
  }
  assert.equal(backendCalls, 1, "body and offers share one cached response across locales");
  const bare = await readPage("/pricing", { "accept-language": "ja-JP" });
  assert.equal(bare.offers[1].priceCurrency, "JPY");
  assert.equal(bare.response.headers.get("vary"), "Accept-Language");

  pricing.prices[0].amount = 999;
  assert.equal((await readPage("/pricing?lang=en")).offers[1].price, "7.49");
  clock += 300_001;
  const refreshed = await readPage("/pricing?lang=en");
  assert.equal(refreshed.offers[1].price, "9.99");
  assert.ok(refreshed.text.includes("$9.99"));
  assert.equal(backendCalls, 2);

  backend = "https://pricing-fallback.example";
  pricing = { ...initialPricing, prices: [null, { amount: -1, currency: "usd" }, { amount: 850, currency: "EUR" }], billingEnabled: false };
  const fallback = await readPage("/pricing?lang=ja");
  assert.equal(fallback.offers[1].priceCurrency, "EUR");
  assert.equal(fallback.offers[1].price, "8.50");
  assert.ok(fallback.text.includes(ja.pricing.unavailable));

  const failures = [
    () => new Response("unavailable", { status: 503 }),
    () => new Response("redirect", { status: 302, headers: { location: "https://untrusted.example" } }),
    () => new Response("{broken"),
    () => Response.json({ pricing: null }),
    () => Response.json({ pricing: { prices: [] } }),
    () => Response.json({ pricing: { prices: [null, { amount: "399", currency: "usd" }, { amount: 0, currency: "usd" }, { amount: 1.2, currency: "usd" }, { amount: 399, currency: "<script>" }] } }),
    () => { throw new Error("offline"); },
    init => new Promise((resolve, reject) => {
      // Real network I/O keeps Node alive. This timer gives the mock the same lifetime.
      const keepAlive = setTimeout(() => assert.fail("backend timeout did not abort"), 2000);
      init.signal.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(init.signal.reason);
      }, { once: true });
    }),
  ];
  for (const [index, failure] of failures.entries()) {
    backend = `https://pricing-failure-${index}.example`;
    respond = failure;
    const page = await readPage("/pricing?lang=zh");
    assert.equal(page.offers.length, 1, `failure ${index} must omit a paid offer`);
    assert.equal(page.offers[0].price, "0");
    assert.ok(page.text.includes(zh.pricing.loadFailed));
    assert.ok(page.text.includes(zh.pricing.lifetimeFeatures[1]));
    assert.ok(page.text.includes(zh.pricing.faqs[0].answer));
  }
  respond = () => Response.json({ pricing: initialPricing });
  assert.equal((await readPage("/pricing?lang=zh")).offers[1].price, "53.00", "failure is not cached");
  clock += 300_001;
  respond = () => new Response("unavailable", { status: 503 });
  assert.equal((await readPage("/pricing?lang=zh")).offers.length, 1, "expired paid price is not reused after failure");
  backend = "https://pricing-head.example";
  const calls = backendCalls;
  const head = await worker.fetch(new Request("https://koinote.app/pricing?lang=en", { method: "HEAD" }), env());
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(backendCalls, calls, "HEAD skips the optional price fetch");
  console.log("Pricing SSR: four currencies, free/paid offers, cache refresh, fallback, failures, timeout and HEAD passed");
} finally {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
}

await import("./_check_pricing_page.mjs");
