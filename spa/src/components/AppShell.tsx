import {
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Moon,
  Sun,
  Globe,
  Check,
  ChevronDown,
  Bot,
  CloudOff,
  Coins,
  Crown,
  FileText,
  Gift,
  HardDrive,
  History,
  Keyboard,
  LayoutDashboard,
  Laptop,
  LogOut,
  LockKeyhole,
  MessageSquareText,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { AGENT_CREDITS_QUERY_KEY, getAgentCredits } from "../api";
import { useSession, useLogout } from "../auth";
import { applyTheme, readStoredTheme, type Theme } from "../theme";
import {
  useI18n,
  interpolate,
  LOCALES,
  LOCALE_LABELS,
  type Locale,
} from "../i18n";
import {
  EDGE_PADDING,
  EDITOR_ROOT_SCROLL_LOCK_CLASS,
  hasFooter,
  isUnder,
  shellViewportClass,
  shouldLockRootScroll,
} from "../layout";
import { formatBytes, usageLevel, usageRatio } from "../storage";
import { AppFooter } from "./AppFooter";
import { InkSeal } from "./Ink";
import { Logo } from "./Logo";
import { Avatar } from "./Avatar";
import { QuotaDialog } from "./QuotaDialog";
import { AnnouncementDialog } from "./AnnouncementDialog";
import { AgentReviewNotifications } from "./AgentReviewNotifications";
import { confirmAction } from "../confirmAction";
import { DESKTOP_DOWNLOAD_URL } from "../desktopDownload";
import { useStorageUsage } from "./StorageCard";
import { GlobalSearch } from "./GlobalSearch";
import { isDesktopRuntime } from "../desktop/runtime";
import { requestDesktopUpdateCheck } from "../desktop/updaterEvents";
import {
  clearLatestDesktopBillingEvent,
  DESKTOP_BILLING_EVENT,
  getLatestDesktopBillingEvent,
  type DesktopBillingEventDetail,
} from "../desktop/billingCore";
import {
  leaveDesktopLocalMode,
  isDesktopLocalModeSelected,
  lockDesktopLocalMode,
} from "../desktop/localMode";
import {
  desktopMenuEnabledActions,
  syncDesktopMenuEnabled,
  useDesktopMenuActions,
} from "../desktop/menu";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";
import { FeedbackDialog } from "./FeedbackDialog";
import {
  detectEditorShortcutPlatform,
  isKeyboardShortcutsShortcut,
  keyboardShortcutsOpenAfterShortcut,
} from "./editor/editorShortcuts";
import { isModalOpen, isOnlyModalOpen } from "../modalStack";
import { feedbackPagePath } from "../feedback";

const DesktopSyncStatus = lazy(() =>
  import("./DesktopSyncStatus").then((module) => ({
    default: module.DesktopSyncStatus,
  })),
);

const DesktopUpdater = lazy(() =>
  import("./DesktopUpdater").then((module) => ({
    default: module.DesktopUpdater,
  })),
);

export function AppShell() {
  const session = useSession();
  const user = session.data?.user;
  const desktopMenuAuthenticated = Boolean(user);
  const desktopMenuHistoryAvailable = user?.membershipTier === "lifetime";
  const desktopRuntime = isDesktopRuntime();
  const localMode =
    desktopRuntime &&
    (Boolean(user?.isLocalMode) || isDesktopLocalModeSelected());
  const logout = useLogout();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { t, locale, setLocale } = useI18n();
  const localModeRouteBlocked = localMode && !isLocalModeAllowedPath(pathname);
  const [desktopBillingNotice, setDesktopBillingNotice] =
    useState<DesktopBillingEventDetail | null>(() =>
      desktopRuntime ? getLatestDesktopBillingEvent() : null,
    );
  const [keyboardShortcutsOpen, setKeyboardShortcutsOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const closeKeyboardShortcuts = useCallback(
    () => setKeyboardShortcutsOpen(false),
    [],
  );

  useEffect(() => {
    if (!user || localMode) setFeedbackOpen(false);
  }, [localMode, user?.authUserId]);

  useDesktopMenuActions((action) => {
    if (action === "open-documentation") {
      void navigate({ to: "/docs" });
    }
    if (action === "check-updates" && desktopRuntime && !localMode) {
      requestDesktopUpdateCheck();
    }
    if (action === "show-keyboard-shortcuts") {
      setKeyboardShortcutsOpen(true);
    }
  });

  useEffect(() => {
    if (!desktopRuntime) return;
    const enabledActions = desktopMenuEnabledActions({
      editorRoute: isUnder(pathname, "/editor"),
      authenticated: desktopMenuAuthenticated,
      localMode,
      historyAvailable: desktopMenuHistoryAvailable,
    });
    void syncDesktopMenuEnabled(enabledActions).catch((error) =>
      console.warn("Desktop menu availability sync failed", error),
    );
  }, [
    desktopMenuAuthenticated,
    desktopMenuHistoryAvailable,
    desktopRuntime,
    localMode,
    pathname,
  ]);

  useEffect(() => {
    const platform = detectEditorShortcutPlatform(
      navigator.platform,
      navigator.userAgent,
    );
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isKeyboardShortcutsShortcut(event, platform)) return;
      event.preventDefault();
      const modalOpen = isModalOpen();
      const onlyModalOpen = isOnlyModalOpen();
      setKeyboardShortcutsOpen((dialogOpen) =>
        keyboardShortcutsOpenAfterShortcut(
          dialogOpen,
          modalOpen,
          onlyModalOpen,
        ),
      );
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!desktopRuntime) return;
    const onBilling = (event: Event) => {
      setDesktopBillingNotice(
        (event as CustomEvent<DesktopBillingEventDetail>).detail,
      );
    };
    window.addEventListener(DESKTOP_BILLING_EVENT, onBilling);
    return () => window.removeEventListener(DESKTOP_BILLING_EVENT, onBilling);
  }, [desktopRuntime]);

  useEffect(() => {
    if (
      !desktopBillingNotice ||
      desktopBillingNotice.status === "pending" ||
      desktopBillingNotice.status === "delayed"
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      clearLatestDesktopBillingEvent();
      setDesktopBillingNotice(null);
    }, 8_000);
    return () => window.clearTimeout(timer);
  }, [desktopBillingNotice]);

  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const lockRootScroll = shouldLockRootScroll(pathname);
  useEffect(() => {
    document.documentElement.classList.toggle(
      EDITOR_ROOT_SCROLL_LOCK_CLASS,
      lockRootScroll,
    );
    return () => {
      document.documentElement.classList.remove(EDITOR_ROOT_SCROLL_LOCK_CLASS);
    };
  }, [lockRootScroll]);

  function clearDesktopModeQueries() {
    queryClient.removeQueries({
      predicate: (query) => query.queryKey[0] !== "session",
    });
  }

  async function handleLogout(switchToLocalMode = false) {
    if (localMode) {
      const { prepareDesktopLogout } = await import("../desktop/logoutGuard");
      if (!(await prepareDesktopLogout())) {
        window.alert(t.desktopSync.logoutSaveFailed);
        return;
      }
      lockDesktopLocalMode();
      clearDesktopModeQueries();
      queryClient.setQueryData(["session"], { user: null });
      void navigate({ to: "/" });
      return;
    }
    if (isDesktopRuntime()) {
      const [{ prepareDesktopLogout }, { desktopSyncSummary }] =
        await Promise.all([
          import("../desktop/logoutGuard"),
          import("../desktop/offlineStore"),
        ]);
      if (!(await prepareDesktopLogout())) {
        window.alert(t.desktopSync.logoutSaveFailed);
        return;
      }
      let summary;
      try {
        summary = await desktopSyncSummary();
      } catch {
        window.alert(t.desktopSync.logoutSaveFailed);
        return;
      }
      if (
        (summary.pending > 0 || summary.conflicts > 0) &&
        !(await confirmAction(
          interpolate(t.desktopSync.logoutWarning, {
            pending: summary.pending,
            conflicts: summary.conflicts,
          }),
        ))
      ) {
        return;
      }
    }
    await logout();
    if (switchToLocalMode) lockDesktopLocalMode();
    clearDesktopModeQueries();
    void navigate({ to: "/" });
  }

  async function handleUseAccount() {
    const { prepareDesktopLogout } = await import("../desktop/logoutGuard");
    if (!(await prepareDesktopLogout())) {
      window.alert(t.desktopSync.logoutSaveFailed);
      return;
    }
    leaveDesktopLocalMode();
    clearDesktopModeQueries();
    queryClient.setQueryData(["session"], { user: null });
    void navigate({ to: "/" });
    const { beginDesktopAuthorization } = await import("../desktop/auth");
    await beginDesktopAuthorization().catch(() => undefined);
  }

  const desktopBillingText = desktopBillingNotice
    ? desktopBillingNotice.kind === "credits"
      ? desktopBillingNotice.status === "active"
        ? t.agentCredits.checkoutSuccess
        : desktopBillingNotice.status === "pending"
          ? t.agentCredits.checkoutPending
          : desktopBillingNotice.status === "delayed"
            ? t.agentCredits.checkoutDelayed
            : desktopBillingNotice.status === "cancelled"
              ? t.agentCredits.checkoutCancelled
              : t.agentCredits.checkoutFailed
      : desktopBillingNotice.status === "active"
        ? t.membership.checkoutSuccess
        : desktopBillingNotice.status === "pending"
          ? t.membership.checkoutPending
          : desktopBillingNotice.status === "delayed"
            ? t.membership.checkoutDelayed
            : desktopBillingNotice.status === "cancelled"
              ? t.membership.checkoutCancelled
              : t.membership.checkoutFailed
    : "";

  return (
    <div
      className={`flex flex-col ${shellViewportClass(pathname)}`}
      style={{ background: "var(--ink-paper)", color: "var(--ink-black)" }}
    >
      <header
        className="sticky top-0 z-50 shrink-0 border-b backdrop-blur"
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
          <Link
            to="/"
            className="flex items-center gap-2 font-semibold tracking-tight"
          >
            {/* 9（36px）而不是 5（20px）：这是水墨笔触，笔丝在小尺寸下会被
                重采样平均掉 —— 20px 时整条尾巴淡成一道钩，认不出是鱼尾 */}
            <Logo className="h-9 w-9" />
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
            {desktopRuntime && localMode ? null : desktopRuntime ? (
              <>
                <HeaderDocsMenu
                  active={isUnder(pathname, "/docs")}
                  label={t.nav.docs}
                  homeLabel={t.nav.docsHome}
                  aiLabel={t.nav.aiGuide}
                  mcpLabel={t.nav.mcpGuide}
                  versionLabel={t.nav.versionHistoryGuide}
                />
                <HeaderLink to="/pricing" active={isUnder(pathname, "/pricing")}>
                  {t.nav.pricing}
                </HeaderLink>
              </>
            ) : (
              <>
                <a
                  href={DESKTOP_DOWNLOAD_URL}
                  className="kn-ink-link transition"
                >
                  {t.nav.download}
                </a>
                <HeaderDocsMenu
                  active={isUnder(pathname, "/docs")}
                  label={t.nav.docs}
                  homeLabel={t.nav.docsHome}
                  aiLabel={t.nav.aiGuide}
                  mcpLabel={t.nav.mcpGuide}
                  versionLabel={t.nav.versionHistoryGuide}
                />
                <HeaderLink to="/pricing" active={isUnder(pathname, "/pricing")}>
                  {t.nav.pricing}
                </HeaderLink>
              </>
            )}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            {user && desktopRuntime && !localMode && pathname !== "/" && (
              <Suspense fallback={null}>
                <DesktopSyncStatus />
              </Suspense>
            )}
            {user && <GlobalSearch />}
            <LocaleSwitcher
              locale={locale}
              setLocale={setLocale}
              label={t.common.language}
            />

            <button
              type="button"
              aria-label={t.common.theme}
              title={t.common.theme}
              onClick={() =>
                setTheme((cur) => (cur === "dark" ? "light" : "dark"))
              }
              className="flex h-9 w-9 items-center justify-center rounded-full transition hover:bg-[var(--ink-wash-strong)]"
              style={{ color: "var(--ink-mid)" }}
            >
              {theme === "dark" ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </button>

            {session.isLoading ? null : user ? (
              <UserMenu
                name={user.nickname || user.username || user.email}
                email={user.email}
                avatarUrl={user.avatarUrl}
                membershipTier={user.membershipTier}
                isAdmin={user.isAdmin}
                dashboardActive={isUnder(pathname, "/dashboard")}
                aiSettingsActive={isUnder(pathname, "/ai-settings")}
                documentsActive={isUnder(pathname, "/documents")}
                trashActive={isUnder(pathname, "/trash")}
                invitationsActive={isUnder(pathname, "/invitations")}
                adminActive={isUnder(pathname, "/admin")}
                desktopRuntime={desktopRuntime}
                localMode={localMode}
                onLogout={() => handleLogout()}
                onSwitchLocal={() => handleLogout(true)}
                onUseAccount={handleUseAccount}
                onShowFeedback={() => setFeedbackOpen(true)}
                onShowKeyboardShortcuts={() => setKeyboardShortcutsOpen(true)}
              />
            ) : (
              // 主行动按钮走朱砂，全站唯一的高饱和色留给它
              <Link
                to={desktopRuntime ? "/" : "/login"}
                className="rounded-full px-4 py-1.5 text-sm font-semibold text-white transition hover:opacity-90"
                style={{ background: "var(--cinnabar)" }}
              >
                {desktopRuntime && localMode
                  ? t.desktopLocalMode.badge
                  : t.nav.login}
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col">
        {localModeRouteBlocked ? (
          <div className="flex flex-1 items-center justify-center px-4 py-16">
            <div
              className="w-full max-w-lg rounded-2xl border p-7 text-center"
              style={{
                borderColor: "var(--ink-line)",
                background: "var(--ink-paper-soft)",
              }}
            >
              <CloudOff
                className="mx-auto h-8 w-8"
                style={{ color: "var(--ink-mid)" }}
              />
              <h1 className="kn-heading-cn mt-4 text-xl font-semibold">
                {t.desktopLocalMode.badge}
              </h1>
              <p
                className="mt-3 text-sm leading-6"
                style={{ color: "var(--ink-mid)" }}
              >
                {t.desktopLocalMode.networkDisabled}
              </p>
              <button
                type="button"
                onClick={() => void handleUseAccount()}
                className="mt-5 rounded-lg px-5 py-2.5 text-sm font-semibold text-white"
                style={{ background: "var(--cinnabar)" }}
              >
                {t.desktopLocalMode.useAccount}
              </button>
            </div>
          </div>
        ) : (
          <Outlet />
        )}
      </main>

      {!desktopRuntime && hasFooter(pathname) && <AppFooter />}

      {/* 图床超额弹窗。挂在外壳上而不是编辑器里：转存外链图片的失败也会走它，
          而那条路不只在编辑器页面触发 */}
      <QuotaDialog />
      {keyboardShortcutsOpen && (
        <KeyboardShortcutsDialog onClose={closeKeyboardShortcuts} />
      )}
      {user && !localMode && feedbackOpen && (
        <FeedbackDialog
          pagePath={feedbackPagePath(pathname)}
          onClose={() => setFeedbackOpen(false)}
        />
      )}
      {user && !localMode && <AnnouncementDialog />}
      {user?.membershipTier === "lifetime" && !localMode && (
        <AgentReviewNotifications
          key={user.authUserId}
          accountKey={user.authUserId}
        />
      )}
      {desktopRuntime && !localMode && desktopBillingNotice && (
        <div
          className="fixed bottom-5 left-1/2 z-[70] flex w-[min(92vw,36rem)] -translate-x-1/2 items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg"
          style={{
            borderColor: "var(--ink-line)",
            background: "var(--ink-paper-soft)",
            color: "var(--ink-strong)",
          }}
          role="status"
        >
          <span className="min-w-0 flex-1 leading-6">{desktopBillingText}</span>
          <button
            type="button"
            aria-label={t.desktopBilling.dismiss}
            title={t.desktopBilling.dismiss}
            onClick={() => {
              clearLatestDesktopBillingEvent();
              setDesktopBillingNotice(null);
            }}
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition hover:bg-[var(--ink-wash-strong)]"
            style={{ color: "var(--ink-mid)" }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {desktopRuntime && !localMode && (
        <Suspense fallback={null}>
          <DesktopUpdater />
        </Suspense>
      )}
    </div>
  );
}

function isLocalModeAllowedPath(pathname: string): boolean {
  if (pathname === "/") return true;
  return [
    "/changelog",
    "/cookies",
    "/docs",
    "/documents",
    "/editor",
    "/privacy",
    "/terms",
    "/trash",
  ].some((prefix) => isUnder(pathname, prefix));
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
  membershipTier,
  isAdmin,
  dashboardActive,
  aiSettingsActive,
  documentsActive,
  trashActive,
  invitationsActive,
  adminActive,
  desktopRuntime,
  localMode,
  onLogout,
  onSwitchLocal,
  onUseAccount,
  onShowFeedback,
  onShowKeyboardShortcuts,
}: {
  name: string;
  email: string;
  /** OAuth 登录（Google / GitHub）时后端会存下来；邮箱注册的用户为空 */
  avatarUrl?: string | null;
  membershipTier: "free" | "lifetime";
  isAdmin: boolean;
  dashboardActive: boolean;
  aiSettingsActive: boolean;
  documentsActive: boolean;
  trashActive: boolean;
  invitationsActive: boolean;
  adminActive: boolean;
  desktopRuntime: boolean;
  localMode: boolean;
  onLogout: () => void | Promise<void>;
  onSwitchLocal: () => void | Promise<void>;
  onUseAccount: () => void | Promise<void>;
  onShowFeedback: () => void;
  onShowKeyboardShortcuts: () => void;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const storage = useStorageUsage(open && !localMode);
  const membershipActive = membershipTier === "lifetime";
  const credits = useQuery({
    queryKey: AGENT_CREDITS_QUERY_KEY,
    queryFn: getAgentCredits,
    enabled: open && membershipActive && !localMode,
    retry: false,
  });

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
          className="absolute right-0 top-11 z-50 w-72 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border py-1 shadow-lg"
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
            {localMode ? (
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
                style={{ background: "var(--ink-wash-strong)" }}
              >
                <CloudOff className="h-4 w-4" />
              </span>
            ) : (
              <Avatar name={name} avatarUrl={avatarUrl} size={36} />
            )}
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
                <p
                  className="truncate text-xs"
                  style={{ color: "var(--ink-faint)" }}
                >
                  {email}
                </p>
              )}
            </div>
          </div>

          {!localMode && (
            <div
            className="border-b px-3 py-3"
            style={{ borderColor: "var(--ink-line)" }}
          >
            <div className="flex items-center justify-between gap-2">
              <div
                className="flex items-center gap-2 text-xs font-medium"
                style={{ color: "var(--ink-mid)" }}
              >
                <HardDrive className="h-4 w-4 shrink-0" />
                {t.storage.title}
              </div>
              {membershipActive && (
                <span
                  className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                  style={{
                    background: "var(--cinnabar-soft)",
                    color: "var(--cinnabar)",
                  }}
                >
                  {t.membership.activeBadge}
                </span>
              )}
            </div>

            {storage.isPending ? (
                <p
                  className="mt-2 text-xs"
                  style={{ color: "var(--ink-faint)" }}
                >
                {t.storage.loading}
              </p>
            ) : storage.isError || !storage.data ? (
                <p
                  className="mt-2 text-xs"
                  style={{ color: "var(--ink-faint)" }}
                >
                {t.storage.loadFailed}
              </p>
            ) : (
              <UserMenuStorageUsage
                usedBytes={storage.data.usedBytes}
                quotaBytes={storage.data.quotaBytes}
                locale={locale}
                label={t.storage.title}
                usedOf={t.storage.usedOf}
              />
            )}
            </div>
          )}

          {!localMode && membershipActive && (
            <Link
              to="/ai-settings"
              hash="agent-credits"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center justify-between gap-3 border-b px-3 py-3 text-sm transition hover:bg-[var(--ink-wash-strong)]"
              style={{
                borderColor: "var(--ink-line)",
                color: "var(--ink-strong)",
              }}
            >
              <span className="flex items-center gap-2 font-medium">
                <Coins
                  className="h-4 w-4 shrink-0"
                  style={{ color: "var(--ink-mid)" }}
                />
                {t.agentCredits.title}
              </span>
              <span
                className="flex flex-col items-end text-xs tabular-nums"
                style={{ color: "var(--ink-faint)" }}
              >
                {credits.isPending ? (
                  t.agentCredits.loading
                ) : credits.data?.credits ? (
                        <>
                          <span>
                            {interpolate(t.agentCredits.available, {
                        count:
                          credits.data.credits.available.toLocaleString(locale),
                            })}
                          </span>
                          {credits.data.credits.reserved > 0 && (
                            <span className="mt-0.5">
                              {interpolate(t.agentCredits.estimatedCharge, {
                          count:
                            credits.data.credits.reserved.toLocaleString(
                              locale,
                            ),
                              })}
                            </span>
                          )}
                        </>
                ) : (
                  t.agentCredits.loadFailed
                )}
              </span>
            </Link>
          )}

          {!localMode && !membershipActive && (
            <Link
              to="/pricing"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="mx-2 my-1.5 flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-semibold transition hover:opacity-80"
              style={{
                background: "var(--cinnabar-soft)",
                color: "var(--cinnabar)",
              }}
            >
              <Crown className="h-4 w-4 shrink-0" />
              {t.membership.purchase}
            </Link>
          )}

          {!localMode && (
            <Link
            to="/dashboard"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-sm transition hover:bg-[var(--ink-wash-strong)]"
            style={{
                color: dashboardActive
                  ? "var(--cinnabar)"
                  : "var(--ink-strong)",
              fontWeight: dashboardActive ? 500 : undefined,
            }}
          >
            <LayoutDashboard className="h-4 w-4 shrink-0" />
            {t.nav.dashboard}
            </Link>
          )}

          {!localMode && (
            <Link
            to="/ai-settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-sm transition hover:bg-[var(--ink-wash-strong)]"
            style={{
                color: aiSettingsActive
                  ? "var(--cinnabar)"
                  : "var(--ink-strong)",
              fontWeight: aiSettingsActive ? 500 : undefined,
            }}
          >
            <Bot className="h-4 w-4 shrink-0" />
            {t.nav.aiSettings}
            </Link>
          )}

          <Link
            to="/documents"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-sm transition hover:bg-[var(--ink-wash-strong)]"
            style={{
              color: documentsActive ? "var(--cinnabar)" : "var(--ink-strong)",
              fontWeight: documentsActive ? 500 : undefined,
            }}
          >
            <FileText className="h-4 w-4 shrink-0" />
            {t.nav.documents}
          </Link>

          <Link
            to="/trash"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-sm transition hover:bg-[var(--ink-wash-strong)]"
            style={{
              color: trashActive ? "var(--cinnabar)" : "var(--ink-strong)",
              fontWeight: trashActive ? 500 : undefined,
            }}
          >
            <Trash2 className="h-4 w-4 shrink-0" />
            {t.nav.trash}
          </Link>

          {!localMode && (
            <Link
            to="/invitations"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-sm transition hover:bg-[var(--ink-wash-strong)]"
            style={{
              color: invitationsActive
                ? "var(--cinnabar)"
                : "var(--ink-strong)",
              fontWeight: invitationsActive ? 500 : undefined,
            }}
          >
            <Gift className="h-4 w-4 shrink-0" />
            {t.nav.invitations}
            </Link>
          )}

          {!localMode && isAdmin && (
            <Link
              to="/admin"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-3 py-2 text-sm transition hover:bg-[var(--ink-wash-strong)]"
              style={{
                color: adminActive ? "var(--cinnabar)" : "var(--ink-strong)",
                fontWeight: adminActive ? 500 : undefined,
              }}
            >
              <ShieldCheck className="h-4 w-4 shrink-0" />
              {t.nav.admin}
            </Link>
          )}

          {desktopRuntime && !localMode && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                requestDesktopUpdateCheck();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm transition hover:bg-[var(--ink-wash-strong)]"
              style={{ color: "var(--ink-strong)" }}
            >
              <RefreshCw className="h-4 w-4 shrink-0" />
              {t.desktopUpdate.check}
            </button>
          )}

          {desktopRuntime && !localMode && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void onSwitchLocal();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm transition hover:bg-[var(--ink-wash-strong)]"
              style={{ color: "var(--ink-strong)" }}
            >
              <CloudOff className="h-4 w-4 shrink-0" />
              {t.desktopLocalMode.enterLocalMode}
            </button>
          )}

          {localMode && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void onUseAccount();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm transition hover:bg-[var(--ink-wash-strong)]"
              style={{ color: "var(--ink-strong)" }}
            >
              <Laptop className="h-4 w-4 shrink-0" />
              {t.desktopLocalMode.useAccount}
            </button>
          )}

          {!localMode && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onShowFeedback();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm transition hover:bg-[var(--ink-wash-strong)]"
              style={{ color: "var(--ink-strong)" }}
            >
              <MessageSquareText className="h-4 w-4 shrink-0" />
              {t.feedback.menuLabel}
            </button>
          )}

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onShowKeyboardShortcuts();
            }}
            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-sm transition hover:bg-[var(--ink-wash-strong)]"
            style={{ color: "var(--ink-strong)" }}
          >
            <span className="flex items-center gap-2">
              <Keyboard className="h-4 w-4 shrink-0" />
              {t.keyboardShortcuts.title}
            </span>
            <span className="text-xs" style={{ color: "var(--ink-faint)" }}>
              ⌘/Ctrl+/
            </span>
          </button>

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
            {localMode ? (
              <LockKeyhole className="h-4 w-4 shrink-0" />
            ) : (
              <LogOut className="h-4 w-4 shrink-0" />
            )}
            {localMode ? t.desktopLocalMode.lock : t.nav.logout}
          </button>
        </div>
      )}
    </div>
  );
}

function UserMenuStorageUsage({
  usedBytes,
  quotaBytes,
  locale,
  label,
  usedOf,
}: {
  usedBytes: number;
  quotaBytes: number;
  locale: string;
  label: string;
  usedOf: string;
}) {
  const ratio = usageRatio(usedBytes, quotaBytes);
  const level = usageLevel(usedBytes, quotaBytes);
  const color = level === "normal" ? "var(--ink-mid)" : "var(--cinnabar)";

  return (
    <div className="mt-2">
      <p className="text-xs font-medium" style={{ color: "var(--ink-strong)" }}>
        {interpolate(usedOf, {
          used: formatBytes(usedBytes, locale),
          quota: formatBytes(quotaBytes, locale),
        })}
      </p>
      <div
        role="progressbar"
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className="mt-2 h-1.5 overflow-hidden rounded-full"
        style={{ background: "var(--ink-wash-strong)" }}
      >
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${ratio * 100}%`, background: color }}
        />
      </div>
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
                <Check
                  className="h-4 w-4"
                  style={{ color: "var(--cinnabar)" }}
                />
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
  to: "/editor" | "/documents" | "/pricing";
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

function HeaderDocsMenu({
  active,
  label,
  homeLabel,
  aiLabel,
  mcpLabel,
  versionLabel,
}: {
  active: boolean;
  label: string;
  homeLabel: string;
  aiLabel: string;
  mcpLabel: string;
  versionLabel: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
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
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        className={`kn-ink-link relative flex items-center gap-1 transition ${active ? "font-medium" : ""}`}
        style={{ color: active ? "var(--cinnabar)" : "var(--ink-mid)" }}
      >
        {label}
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
        />
        {active && (
          <span
            aria-hidden
            className="absolute -bottom-1.5 left-0 h-0.5 w-full rounded-full"
            style={{ background: "var(--cinnabar)" }}
          />
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label={label}
          className="absolute left-0 top-8 z-50 w-56 overflow-hidden rounded-xl border py-1 shadow-lg"
          style={{
            borderColor: "var(--ink-line)",
            background: "var(--ink-paper-soft)",
          }}
        >
          <HeaderDocsMenuItem
            to="/docs"
            onSelect={() => setOpen(false)}
            icon={<FileText className="h-4 w-4" />}
          >
            {homeLabel}
          </HeaderDocsMenuItem>
          <HeaderDocsMenuItem
            to="/docs/ai-optimization"
            onSelect={() => setOpen(false)}
            icon={<Sparkles className="h-4 w-4" />}
          >
            {aiLabel}
          </HeaderDocsMenuItem>
          <HeaderDocsMenuItem
            to="/docs/mcp"
            onSelect={() => setOpen(false)}
            icon={<Bot className="h-4 w-4" />}
          >
            {mcpLabel}
          </HeaderDocsMenuItem>
          <HeaderDocsMenuItem
            to="/docs/version-history"
            onSelect={() => setOpen(false)}
            icon={<History className="h-4 w-4" />}
          >
            {versionLabel}
          </HeaderDocsMenuItem>
        </div>
      )}
    </div>
  );
}

function HeaderDocsMenuItem({
  to,
  onSelect,
  icon,
  children,
}: {
  to: "/docs" | "/docs/ai-optimization" | "/docs/mcp" | "/docs/version-history";
  onSelect: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      role="menuitem"
      onClick={onSelect}
      className="flex items-center gap-3 px-3 py-2.5 text-sm font-medium transition hover:bg-[var(--ink-wash-strong)]"
      style={{ color: "var(--ink-strong)" }}
    >
      {icon}
      {children}
    </Link>
  );
}
