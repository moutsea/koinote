import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Moon,
  Sun,
  FileText,
  Globe,
  Check,
  ChevronDown,
  LayoutDashboard,
  LogOut,
} from "lucide-react";
import { useSession, useLogout } from "../auth";
import { applyTheme, readStoredTheme, type Theme } from "../theme";
import { useI18n, LOCALES, LOCALE_LABELS, type Locale } from "../i18n";
import { EDGE_PADDING, hasFooter, isUnder } from "../layout";
import { AppFooter } from "./AppFooter";
import { InkSeal } from "./Ink";
import { Avatar } from "./Avatar";

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

          {/* 主导航只留编辑器。控制台是账号自己的东西（我的文档、注册时间、邮箱），
              归到右侧的账户菜单里；顶栏留给「产品能做什么」那一类入口 */}
          <nav
            className="ml-4 hidden items-center gap-5 text-sm sm:flex"
            style={{ color: "var(--ink-mid)" }}
          >
            <HeaderLink to="/editor" active={isUnder(pathname, "/editor")}>
              {t.nav.editor}
            </HeaderLink>
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
              <UserMenu
                name={user.nickname || user.username || user.email}
                email={user.email}
                avatarUrl={user.avatarUrl}
                dashboardActive={isUnder(pathname, "/dashboard")}
                onLogout={handleLogout}
              />
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

/**
 * 账户菜单。控制台入口从顶栏挪进来了。
 *
 * 触发器上显示用户名，但读屏只念一个人名不知道那是什么，所以 aria-label 写「账户菜单」，
 * 靠 aria-expanded 播报开合状态。
 */
function UserMenu({
  name,
  email,
  avatarUrl,
  dashboardActive,
  onLogout,
}: {
  name: string;
  email: string;
  /** OAuth 登录（Google / GitHub）时后端会存下来；邮箱注册的用户为空 */
  avatarUrl?: string | null;
  dashboardActive: boolean;
  onLogout: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={t.nav.userMenu}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          // 不冒泡到 window：否则上面那个 close 会立刻把刚打开的菜单关掉
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        // 左侧 pl-1 比右侧窄：头像是个圆，视觉上比方形文字更"靠外"，
        // 两边等距时看着偏右
        className="flex h-9 max-w-44 items-center gap-1.5 rounded-full border pl-1 pr-2.5 text-sm font-medium transition hover:bg-[var(--ink-wash-strong)]"
        style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}
      >
        <Avatar name={name} avatarUrl={avatarUrl} size={26} />
        {/* 用户名可能很长，截断而不是把页头挤变形 */}
        <span className="hidden truncate sm:inline">{name}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          style={{ color: "var(--ink-faint)" }}
        />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t.nav.userMenu}
          className="absolute right-0 top-11 z-50 min-w-52 overflow-hidden rounded-xl border py-1 shadow-lg"
          style={{
            borderColor: "var(--ink-line)",
            background: "var(--ink-paper-soft)",
          }}
        >
          {/* 账号身份：菜单里重复一次，因为触发器在小屏上只有头像 */}
          <div
            className="flex items-center gap-2.5 border-b px-3 pb-2.5 pt-2"
            style={{ borderColor: "var(--ink-line)" }}
          >
            <Avatar name={name} avatarUrl={avatarUrl} size={36} />
            {/* min-w-0 是 truncate 在 flex 子项里生效的前提：
                flex item 默认 min-width:auto，不会缩到内容宽度以下 */}
            <div className="min-w-0">
              <p
                className="truncate text-sm font-medium"
                style={{ color: "var(--ink-black)" }}
              >
                {name}
              </p>
              {/* 昵称存在时 name 就不是邮箱，这时补一行邮箱；相等则不重复显示 */}
              {email && email !== name && (
                <p className="truncate text-xs" style={{ color: "var(--ink-faint)" }}>
                  {email}
                </p>
              )}
            </div>
          </div>

          <Link
            to="/dashboard"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-sm transition hover:bg-[var(--ink-wash-strong)]"
            style={{
              color: dashboardActive ? "var(--cinnabar)" : "var(--ink-strong)",
              fontWeight: dashboardActive ? 500 : undefined,
            }}
          >
            <LayoutDashboard className="h-4 w-4 shrink-0" />
            {t.nav.dashboard}
          </Link>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void onLogout();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm transition hover:bg-[var(--ink-wash-strong)]"
            style={{ color: "var(--ink-strong)" }}
          >
            <LogOut className="h-4 w-4 shrink-0" />
            {t.nav.logout}
          </button>
        </div>
      )}
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
