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

export { LOCALES, LOCALE_LABELS } from "./types";
export type { Locale, Messages } from "./types";

const MESSAGES: Record<Locale, Messages> = { en, zh, fr, ja };
const STORAGE_KEY = "koinote-locale";

// 浏览器语言 → 支持的 Locale，默认 en。
function detectLocale(): Locale {
  if (typeof window === "undefined") return "en";
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
    document.documentElement.lang = l;
  }, []);

  // 挂载时同步 <html lang>，与初始检测到的语言对齐（index.html 里的静态值可能不符）。
  useEffect(() => {
    document.documentElement.lang = locale;
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
