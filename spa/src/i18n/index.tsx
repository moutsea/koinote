import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { en } from "./en";
import { zh } from "./zh";
import { fr } from "./fr";
import { ja } from "./ja";
import { LOCALES, type Locale, type Messages } from "./types";
import { syncDesktopMenuLocale } from "../desktop/menu";
// 与 Worker 首屏渲染的 <html lang> 一致（zh → zh-CN），JS 接管后不改写成另一个值
import { HTML_LANG } from "../seoMeta";

export { LOCALES, LOCALE_LABELS } from "./types";
export type { Locale, Messages } from "./types";

const MESSAGES: Record<Locale, Messages> = { en, zh, fr, ja };
const STORAGE_KEY = "koinote-locale";

// 浏览器语言 → 支持的 Locale，默认 en。
function detectLocale(): Locale {
  if (typeof window === "undefined") return "en";
  // ?lang= 是各语言版本的固定地址（hreflang 与 Worker 边缘渲染都指向它），
  // 优先级最高，但只决定这次打开的语言、不写进 localStorage：点一次搜索结果里
  // 的外语链接，不该把用户自己选过的界面语言永久改掉。站内跳转期间语言保存在
  // React 状态里，不会因为地址里没了 ?lang 而变。用户在语言菜单里主动切换才保存。
  const requested = new URLSearchParams(window.location.search).get("lang");
  if (requested && (LOCALES as readonly string[]).includes(requested)) {
    return requested as Locale;
  }
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored && (LOCALES as readonly string[]).includes(stored)) {
    return stored as Locale;
  }
  const nav = window.navigator.language.toLowerCase();
  if (nav.startsWith("zh")) return "zh";
  if (nav.startsWith("fr")) return "fr";
  if (nav.startsWith("ja")) return "ja";
  return "en";
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: Messages;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => detectLocale());

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      window.localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // 忽略隐私模式写入失败
    }
    document.documentElement.lang = HTML_LANG[l];
  }, []);

  // 挂载时同步 <html lang>，与初始检测到的语言对齐（index.html 里的静态值可能不符）。
  useEffect(() => {
    document.documentElement.lang = HTML_LANG[locale];
    void syncDesktopMenuLocale(locale).catch((error) =>
      console.warn("Desktop menu locale sync failed", error),
    );
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t: MESSAGES[locale] }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n 必须在 I18nProvider 内使用");
  return ctx;
}

// 简单占位符插值：interpolate("Hi, {name}", { name: "x" })
export function interpolate(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key) =>
    key in vars ? String(vars[key]) : `{${key}}`,
  );
}
