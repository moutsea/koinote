import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Moon, Sun, FileText, Globe, Check } from "lucide-react";
import { useSession, useLogout } from "../auth";
import { applyTheme, readStoredTheme, type Theme } from "../theme";
import { useI18n, LOCALES, LOCALE_LABELS, type Locale } from "../i18n";
import { EDGE_PADDING, hasFooter } from "../layout";
import { AppFooter } from "./AppFooter";
import { InkSeal } from "./Ink";

export function AppShell() {
  const session = useSession();
  const user = session.data?.user;
  const logout = useLogout();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { t, locale, setLocale } = useI18n();

  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  async function handleLogout() {
    await logout();
    void navigate({ to: "/" });
  }

  return (
    <div
      className="flex min-h-[100dvh] flex-col"
      style={{ background: "var(--ink-paper)", color: "var(--ink-black)" }}
    >
      <header
        className="sticky top-0 z-50 border-b backdrop-blur"
        style={{
          borderColor: "var(--ink-line)",
          // 半透明纸底：滚动时下方内容透出来一点，但仍能压住文字。
          // color-mix 而不是 /85 后缀 —— 令牌是 var()，Tailwind 的透明度语法对它无效
          background: "color-mix(in srgb, var(--ink-paper) 88%, transparent)",
        }}
      >
        {/* 页头始终通栏，不跟着正文的宽度走。
            它是全站导航（logo、语言、主题、登录态），属于应用外壳而不是页面内容 ——
            正文收窄是为了行长和阅读，那个理由对一排图标按钮不成立。

            内边距取 EDGE_PADDING，与通栏正文同源：编辑器页侧栏的左边缘要和 logo
            对齐，两边各写一个 px-3 的话改了一处就差几个像素。 */}
        <div className={`flex h-14 w-full items-center gap-3 ${EDGE_PADDING}`}>
          <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <FileText className="h-5 w-5" style={{ color: "var(--cinnabar)" }} />
            <span className="kn-heading-cn text-lg">Koinote</span>
            {/* 印章只在 sm 以上出现：手机上页头横向就那么点地方，
                先让位给语言、主题和登录态 */}
            <InkSeal className="ml-0.5 hidden h-7 px-0.5 text-[10px] sm:inline-flex" />
          </Link>

          <nav
            className="ml-4 hidden items-center gap-5 text-sm sm:flex"
            style={{ color: "var(--ink-mid)" }}
          >
            <HeaderLink to="/editor" active={pathname.startsWith("/editor")}>
              {t.nav.editor}
            </HeaderLink>
            {user && (
              <HeaderLink to="/dashboard" active={pathname.startsWith("/dashboard")}>
                {t.nav.dashboard}
              </HeaderLink>
            )}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <LocaleSwitcher
              locale={locale}
              setLocale={setLocale}
              label={t.common.language}
            />

            <button
              type="button"
              aria-label={t.common.theme}
              title={t.common.theme}
              onClick={() => setTheme((cur) => (cur === "dark" ? "light" : "dark"))}
              className="flex h-9 w-9 items-center justify-center rounded-full transition hover:bg-[var(--ink-wash-strong)]"
              style={{ color: "var(--ink-mid)" }}
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>

            {session.isLoading ? null : user ? (
              <div className="flex items-center gap-3">
                <span
                  className="hidden text-sm sm:inline"
                  style={{ color: "var(--ink-mid)" }}
                >
                  {user.nickname || user.username || user.email}
                </span>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="rounded-full border px-4 py-1.5 text-sm font-medium transition hover:bg-[var(--ink-wash-strong)]"
                  style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
                >
                  {t.nav.logout}
                </button>
              </div>
            ) : (
              // 主行动按钮走朱砂，全站唯一的高饱和色留给它
              <Link
                to="/login"
                className="rounded-full px-4 py-1.5 text-sm font-semibold text-white transition hover:opacity-90"
                style={{ background: "var(--cinnabar)" }}
              >
                {t.nav.login}
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="flex flex-1 flex-col">
        <Outlet />
      </main>

      {hasFooter(pathname) && <AppFooter />}
    </div>
  );
}

function LocaleSwitcher({
  locale,
  setLocale,
  label,
}: {
  locale: Locale;
  setLocale: (l: Locale) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="flex h-9 items-center gap-1.5 rounded-full px-2.5 text-sm transition hover:bg-[var(--ink-wash-strong)]"
        style={{ color: "var(--ink-mid)" }}
      >
        <Globe className="h-4 w-4" />
        <span className="hidden sm:inline">{LOCALE_LABELS[locale]}</span>
      </button>
      {open && (
        <div
          className="absolute right-0 top-11 z-50 min-w-36 overflow-hidden rounded-xl border py-1 shadow-lg"
          style={{
            borderColor: "var(--ink-line)",
            background: "var(--ink-paper-soft)",
          }}
        >
          {LOCALES.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => {
                setLocale(l);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between px-3 py-2 text-sm transition hover:bg-[var(--ink-wash-strong)]"
              style={{ color: "var(--ink-strong)" }}
            >
              <span>{LOCALE_LABELS[l]}</span>
              {l === locale && (
                <Check className="h-4 w-4" style={{ color: "var(--cinnabar)" }} />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function HeaderLink({
  to,
  active,
  children,
}: {
  to: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      // 当前项用朱砂 + 下方短横，等同于书页上的朱笔圈点
      className={`kn-ink-link relative transition ${active ? "font-medium" : ""}`}
      style={{ color: active ? "var(--cinnabar)" : "var(--ink-mid)" }}
    >
      {children}
      {active && (
        <span
          aria-hidden
          className="absolute -bottom-1.5 left-0 h-0.5 w-full rounded-full"
          style={{ background: "var(--cinnabar)" }}
        />
      )}
    </Link>
  );
}
