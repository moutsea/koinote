import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Moon, Sun, FileText, Globe, Check } from "lucide-react";
import { useSession, useLogout } from "../auth";
import { applyTheme, readStoredTheme, type Theme } from "../theme";
import { useI18n, LOCALES, LOCALE_LABELS, type Locale } from "../i18n";
import { EDGE_PADDING } from "../layout";

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
    <div className="flex min-h-[100dvh] flex-col bg-[var(--background)] text-[var(--foreground)]">
      <header className="sticky top-0 z-50 border-b border-black/5 bg-[var(--background)]/85 backdrop-blur dark:border-white/10">
        {/* 页头始终通栏，不跟着正文的宽度走。
            它是全站导航（logo、语言、主题、登录态），属于应用外壳而不是页面内容 ——
            正文收窄是为了行长和阅读，那个理由对一排图标按钮不成立。

            内边距取 EDGE_PADDING，与通栏正文同源：编辑器页侧栏的左边缘要和 logo
            对齐，两边各写一个 px-3 的话改了一处就差几个像素。 */}
        <div className={`flex h-14 w-full items-center gap-3 ${EDGE_PADDING}`}>
          <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <FileText className="h-5 w-5 text-sky-600" />
            <span>Koinote</span>
          </Link>

          <nav className="ml-4 hidden items-center gap-5 text-sm text-neutral-600 dark:text-neutral-300 sm:flex">
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
              className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-500 transition hover:bg-black/5 dark:hover:bg-white/10"
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>

            {session.isLoading ? null : user ? (
              <div className="flex items-center gap-3">
                <span className="hidden text-sm text-neutral-600 dark:text-neutral-300 sm:inline">
                  {user.nickname || user.username || user.email}
                </span>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="rounded-full border border-black/10 px-4 py-1.5 text-sm font-medium transition hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
                >
                  {t.nav.logout}
                </button>
              </div>
            ) : (
              <Link
                to="/login"
                className="rounded-full bg-sky-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-sky-500"
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
        className="flex h-9 items-center gap-1.5 rounded-full px-2.5 text-sm text-neutral-500 transition hover:bg-black/5 dark:hover:bg-white/10"
      >
        <Globe className="h-4 w-4" />
        <span className="hidden sm:inline">{LOCALE_LABELS[locale]}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-50 min-w-36 overflow-hidden rounded-xl border border-black/10 bg-[var(--background)] py-1 shadow-lg dark:border-white/15">
          {LOCALES.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => {
                setLocale(l);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between px-3 py-2 text-sm transition hover:bg-black/5 dark:hover:bg-white/10"
            >
              <span>{LOCALE_LABELS[l]}</span>
              {l === locale && <Check className="h-4 w-4 text-sky-600" />}
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
      className={
        active
          ? "font-medium text-sky-600"
          : "transition hover:text-neutral-900 dark:hover:text-white"
      }
    >
      {children}
    </Link>
  );
}
