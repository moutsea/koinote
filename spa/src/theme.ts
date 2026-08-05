// 深色模式：class 挂在 <html> 上，localStorage 持久化，跟随系统偏好初始化。
const STORAGE_KEY = "koinote-theme";

export type Theme = "light" | "dark";

export function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // 忽略隐私模式下的写入失败
  }
}
