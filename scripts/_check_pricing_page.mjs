import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { parseHTML } from "linkedom";

const require = createRequire(import.meta.url);
const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Node.js" }, configurable: true });
window.location = { search: "?lang=en" };
window.localStorage = { getItem: () => null, setItem() {} };
let user = null;
let pendingRead;
let rejectRead = false;
const checkouts = [];
const opened = [];
let pricing = {
  billingEnabled: true, creditPurchaseEnabled: true,
  freeStorageQuotaBytes: 500 * 1024 ** 2, lifetimeStorageQuotaBytes: 10 * 1024 ** 3,
  prices: [{ amount: 749, currency: "usd" }, { amount: 5300, currency: "cny" }, { amount: 1099, currency: "eur" }, { amount: 1234, currency: "jpy" }],
  creditPacks: [{ code: "pack", credits: 1000, amount: 199, currency: "usd", prices: [{ amount: 199, currency: "usd" }, { amount: 900, currency: "jpy" }] }],
};
globalThis.__pricingTest = {
  user: () => user,
  read: () => pendingRead ?? (rejectRead ? Promise.reject(new Error("offline")) : Promise.resolve({ pricing: structuredClone(pricing) })),
  status: async () => ({ membership: { active: user?.membershipTier === "lifetime" } }),
  checkout: async (...args) => { checkouts.push(args); return { url: "https://checkout.example/test" }; },
  open: async url => opened.push(url),
};
const adapters = {
  "../api": `const test=globalThis.__pricingTest;
    export const getBillingPricing=test.read, getMembershipStatus=test.status;
    export const createMembershipCheckout=(currency)=>test.checkout('membership',currency);
    export const createAgentCreditsCheckout=(pack,currency)=>test.checkout('credits',pack,currency);
    export const AGENT_CREDITS_QUERY_KEY=['agent-credits'];
    export const confirmAgentCreditsCheckout=()=>{}, getAgentCredits=()=>{};
    export class ApiError extends Error {}`,
  "../auth": "export const useCurrentUser=globalThis.__pricingTest.user;",
  "../externalNavigation": "export const openMembershipCheckout=globalThis.__pricingTest.open;",
  "../desktop/menu": "export const syncDesktopMenuLocale=async()=>{};",
  "@tanstack/react-router": `import {createElement} from 'react';
    export const Link=({to,search,children,...props})=>createElement('a',{href:to,...props},children);
    export const useRouterState=({select})=>select({location:{pathname:'/pricing'}});`,
};
const bundle = await build({
  stdin: { contents: `export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client';
    export {QueryClient,QueryClientProvider} from '@tanstack/react-query';
    export {PricingPage} from './spa/src/pages/PricingPage';
    export {I18nProvider,useI18n} from './spa/src/i18n';
    export {zh} from './spa/src/i18n/zh'; export {en} from './spa/src/i18n/en';
    export {fr} from './spa/src/i18n/fr'; export {ja} from './spa/src/i18n/ja';
    export {formatBillingPrice} from './spa/src/billingCore';`, resolveDir: process.cwd() },
  bundle: true, format: "esm", platform: "node", write: false, jsx: "automatic",
  plugins: [{ name: "pricing-test-adapters", setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(adapters, path) ? { path, namespace: "pricing-adapter" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "pricing-adapter" }, ({ path }) => ({ contents: adapters[path] }));
    builder.onResolve({ filter: /^(?:react(?:-dom)?(?:\/|$)|@tanstack\/react-query$|lucide-react$)/ }, ({ path }) => ({ path: pathToFileURL(require.resolve(path)).href, external: true }));
  }}],
});
const { createElement, act, createRoot, QueryClient, QueryClientProvider, PricingPage, I18nProvider, useI18n, zh, en, fr, ja, formatBillingPrice } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const messages = { zh, en, fr, ja };
let setLocale;
function LocaleControl() {
  setLocale = useI18n().setLocale;
  return null;
}
let root, client;
async function mount(locale = "en") {
  window.location.search = `?lang=${locale}`;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  root = createRoot(document.getElementById("root"));
  await act(async () => root.render(createElement(QueryClientProvider, { client },
    createElement(I18nProvider, null, createElement(LocaleControl), createElement(PricingPage)))));
}
async function unmount() {
  await act(async () => root.unmount());
  client.clear();
}
async function waitFor(predicate, message) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
  }
  assert.fail(message);
}
const button = text => [...document.querySelectorAll("button")].find(element => element.textContent === text);
const content = () => document.getElementById("root").textContent;
async function selectCurrency(currency) {
  const select = document.querySelector("select");
  assert.ok(select);
  // Linkedom has a read-only select.value, while browsers provide a writable one.
  Object.defineProperty(select, "value", { value: currency, configurable: true });
  await act(async () => select.dispatchEvent(new window.Event("change", { bubbles: true })));
}
try {
  let resolveRead;
  pendingRead = new Promise(resolve => { resolveRead = resolve; });
  await mount();
  assert.ok(content().includes(en.pricing.loading));
  assert.ok(content().includes(en.pricing.freeFeatures[1]));
  assert.ok(content().includes(en.pricing.faqs[0].answer), "FAQ remains readable during loading");
  await act(async () => resolveRead({ pricing }));
  pendingRead = undefined;
  await waitFor(() => content().includes("$7.49"), "price loaded");
  assert.ok(document.querySelector('a[href="/login?redirectTo=%2Fpricing"]'));
  for (const [locale, currency] of [["zh", "cny"], ["fr", "eur"], ["ja", "jpy"], ["en", "usd"]]) {
    await act(async () => setLocale(locale));
    const source = pricing.prices.find(price => price.currency === currency);
    assert.ok(content().includes(formatBillingPrice(source.amount, currency, locale)), "locale controls default currency");
    assert.ok(content().includes(formatBillingPrice(0, currency, locale)));
    for (const faq of messages[locale].pricing.faqs) assert.ok(content().includes(faq.answer));
  }
  await unmount();

  user = { membershipTier: "free" };
  await mount();
  await waitFor(() => button(en.membership.purchase)?.disabled === false, "purchase is enabled");
  await selectCurrency("jpy");
  assert.ok(content().includes("¥1,234"));
  await act(async () => button(en.membership.purchase).click());
  await waitFor(() => opened.length === 1, "checkout opened");
  assert.deepEqual(checkouts[0], ["membership", "jpy"]);
  await unmount();

  pricing.billingEnabled = false;
  await mount();
  await waitFor(() => content().includes("$7.49"), "disabled billing keeps valid price");
  assert.equal(button(en.membership.purchase).disabled, true);
  assert.ok(content().includes(en.pricing.unavailable));
  await unmount();

  pricing.billingEnabled = true;
  user = { membershipTier: "lifetime" };
  await mount();
  await waitFor(() => document.querySelector('a[href="/settings"]') && document.querySelector("select"), "member management and prices loaded");
  assert.equal(button(en.membership.purchase), undefined);
  await selectCurrency("jpy");
  await act(async () => button(en.pricing.buyCredits).click());
  await waitFor(() => checkouts.length === 2, "credits checkout");
  assert.deepEqual(checkouts[1], ["credits", "pack", "jpy"]);
  await unmount();

  user = { membershipTier: "free" };
  rejectRead = true;
  await mount("fr");
  await waitFor(() => content().includes(fr.pricing.loadFailed), "error shown");
  assert.ok(content().includes(fr.pricing.freeFeatures[1]));
  assert.ok(content().includes(fr.pricing.faqs[0].answer));
  assert.equal(button(fr.membership.purchase).disabled, true);
  rejectRead = false;
  await act(async () => client.invalidateQueries({ queryKey: ["billing-pricing"] }));
  await waitFor(() => content().includes(formatBillingPrice(1099, "eur", "fr")), "error recovers to current price");
  assert.equal(button(fr.membership.purchase).disabled, false);
  await unmount();

  pricing.prices = [null, { amount: 0, currency: "usd" }];
  await mount();
  await waitFor(() => content().includes(en.pricing.loadFailed), "invalid price shown as unavailable");
  assert.equal(button(en.membership.purchase).disabled, true);
  assert.equal(document.querySelector("select"), null);
  await unmount();
  console.log("Pricing React: four locales, loading/error recovery, currency selection, membership and credits checkout passed");
} finally {
  if (root) await act(async () => root.unmount());
  client?.clear();
}
