import {
  Link,
  Outlet,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  FolderOpen,
  HardDrive,
  History,
  Keyboard,
  Laptop,
  LogOut,
  LockKeyhole,
  MessageSquareText,
  RefreshCw,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { AGENT_CREDITS_QUERY_KEY, getAgentCredits } from "../api";
import { useSession, useLogout } from "../auth";
import { applyTheme, readStoredTheme, type Theme } from "../theme";
import { defaultSiteTitle, notFoundTitle, pageOwnsMeta, publicPageForPath, publicPageMeta } from "../seoMeta";
import { fitHeaderNav, sameNavSet, type HeaderNavKey } from "../headerNavCore";
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
  const notFound = useRouterState({
    select: (s) => s.matches.some((match) => match.globalNotFound),
  });
  // canonical 的 lang 从 router 状态读：路由切换时这里的 effect 先于浏览器地址
  // 更新执行，此时读 window.location 拿到的还是上一页的查询串
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
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

  // 页头导航按实际宽度收起：放不下的入口进「更多」菜单（规则见 headerNavCore.ts）。
  // 宽度取自一组看不见的同款文字，而不是导航本身：被收起的入口已经不在版面上，
  // 量不到；语言切换后文字变长变短，这组文字的尺寸跟着变，ResizeObserver 会通知。
  const navKeys: HeaderNavKey[] =
    desktopRuntime && localMode
      ? ["editor", "space", "hub"]
      : desktopRuntime
        ? ["editor", "space", "hub", "docs", "pricing"]
        : ["editor", "space", "hub", "download", "docs", "pricing"];
  const navSignature = navKeys.join(",");
  const navRef = useRef<HTMLElement>(null);
  const navMeasureRef = useRef<HTMLDivElement>(null);
  const headerRowRef = useRef<HTMLDivElement>(null);
  const brandRef = useRef<HTMLAnchorElement>(null);
  const headerActionsRef = useRef<HTMLDivElement>(null);
  const [hiddenNav, setHiddenNav] = useState<ReadonlySet<HeaderNavKey>>(() => new Set());
  // 窄屏上连 logo 旁的「Koinote」字样也放不下时（320px 手机、法文的「Se connecter」），
  // 只留 logo 图形。同样按实际宽度判断：中文在 360px 放得下，就不该跟着藏。
  const [compactBrand, setCompactBrand] = useState(false);
  const compactBrandRef = useRef(false);
  useLayoutEffect(() => {
    const nav = navRef.current;
    const measure = navMeasureRef.current;
    const row = headerRowRef.current;
    const brand = brandRef.current;
    const actions = headerActionsRef.current;
    if (!nav || !measure || !row || !brand || !actions) return;
    const keys = navSignature.split(",") as HeaderNavKey[];
    const width = (key: string) =>
      measure.querySelector<HTMLElement>(`[data-measure="${key}"]`)?.getBoundingClientRect().width ?? 0;
    const fit = () => {
      const style = getComputedStyle(row);
      const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const gap = parseFloat(style.columnGap) || 0;
      const navShown = getComputedStyle(nav).display !== "none";
      // 字样被藏起来时，logo 的当前宽度不含它，要加回来才是完整宽度（gap-2 = 8px）
      const brandWidth =
        brand.getBoundingClientRect().width + (compactBrandRef.current ? width("brand") + 8 : 0);
      // sm 以上导航至少还要留出「更多」的位置（ml-4 + 两侧间距）
      const navMinimum = navShown ? 16 + gap + width("more") : 0;
      const required = padding + brandWidth + gap + actions.getBoundingClientRect().width + navMinimum;
      const compact = required > row.clientWidth + 0.5;
      if (compact !== compactBrandRef.current) {
        compactBrandRef.current = compact;
        setCompactBrand(compact);
      }
      const next = fitHeaderNav({
        available: nav.clientWidth,
        keys,
        widths: Object.fromEntries(keys.map((key) => [key, width(key)])),
        moreWidth: width("more"),
        gap: HEADER_NAV_GAP_PX,
      });
      setHiddenNav((current) => (sameNavSet(current, next) ? current : next));
    };
    fit();
    // 页头宽度、右侧按钮（登录态、语言）和各段文字任一变化都要重算
    const observer = new ResizeObserver(fit);
    for (const element of [row, nav, measure, actions, brand]) observer.observe(element);
    return () => observer.disconnect();
  }, [navSignature]);
  const navHidden = (key: HeaderNavKey) => hiddenNav.has(key);
  const docsLabels = {
    label: t.nav.docs,
    homeLabel: t.nav.docsHome,
    aiLabel: t.nav.aiGuide,
    mcpLabel: t.nav.mcpGuide,
    versionLabel: t.nav.versionHistoryGuide,
    wechatLabel: t.settingsPage.wechat,
  };

  // 路由切换时同步 title / description / canonical。首屏由 Worker 按同一份
  // seoMeta 渲染好，这里只负责之后的客户端跳转。分享页和仓库详情页的标题和描述
  // 由页面按数据设置（父组件 effect 晚于子组件执行，这里改了会把它覆盖掉），
  // 这里只跳过这两项，canonical 照常更新。
  useEffect(() => {
    const owned = !notFound && pageOwnsMeta(pathname);
    const page = publicPageForPath(pathname);
    if (!owned) {
      const meta = publicPageMeta(page ?? "home", t, locale);
      document.title = notFound
        ? notFoundTitle(t)
        : page
          ? meta.title
          : defaultSiteTitle(locale);
      // 应用页也重置成首页描述，避免从价格页跳进编辑器后还挂着价格页的摘要
      document
        .querySelector('meta[name="description"]')
        ?.setAttribute("content", meta.description);
    }
    let canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    // 编辑器、登录页的首屏没有 canonical；站内进入公开页时需要补建。
    if (!canonical && !notFound && (owned || page)) {
      canonical = document.createElement("link");
      canonical.rel = "canonical";
      document.head.appendChild(canonical);
    }
    if (canonical) {
      // 只认受支持的 lang，与 Worker 一致；?lang=de 之类的垃圾值不能各自成为规范地址
      const lang = owned ? null : new URLSearchParams(searchStr).get("lang");
      const valid = lang && (LOCALES as readonly string[]).includes(lang) ? lang : null;
      canonical.href = `${window.location.origin}${pathname}${valid ? `?lang=${valid}` : ""}`;
    }
  }, [pathname, searchStr, notFound, t, locale]);

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
        {/* 导航各入口的完整宽度，供自适应收起计算。w-0 + overflow-hidden 让它不占
            版面、也不撑出横向滚动，里面的文字仍按真实宽度排版。字重取 font-medium：
            当前页的入口会加粗，按宽的算才不会在切到那一页时挤出去。 */}
        <div aria-hidden className="pointer-events-none absolute left-0 top-0 h-0 w-0 overflow-hidden">
          <div ref={navMeasureRef} className="flex w-max items-center whitespace-nowrap text-sm font-medium">
            <span data-measure="editor">{t.nav.editor}</span>
            <span data-measure="space">{t.nav.space}</span>
            <span data-measure="hub">{t.agentWorkspace.publicRepositories}</span>
            <span data-measure="download">{t.nav.download}</span>
            <span data-measure="docs" className="flex items-center gap-1">
              {t.nav.docs}
              <ChevronDown className="h-3.5 w-3.5" />
            </span>
            <span data-measure="pricing">{t.nav.pricing}</span>
            <span data-measure="brand" className="kn-heading-cn text-lg font-semibold">Koinote</span>
            <span data-measure="more" className="flex items-center gap-1">
              {t.nav.more}
              <ChevronDown className="h-3.5 w-3.5" />
            </span>
          </div>
        </div>
        {/* 页头始终通栏，不跟着正文的宽度走。
            它是全站导航（logo、语言、主题、登录态），属于应用外壳而不是页面内容 ——
            正文收窄是为了行长和阅读，那个理由对一排图标按钮不成立。

            内边距取 EDGE_PADDING，与通栏正文同源：编辑器页侧栏的左边缘要和 logo
            对齐，两边各写一个 px-3 的话改了一处就差几个像素。 */}
        <div ref={headerRowRef} className={`flex h-14 w-full items-center gap-3 ${EDGE_PADDING}`}>
          {/* logo 与右侧按钮都不参与 flex 收缩：放不下时由导航收进「更多」、
              再不够就藏起字样（见上面的 fit），而不是让按钮文字被挤成两行 */}
          <Link
            ref={brandRef}
            to="/"
            className="flex shrink-0 items-center gap-2 font-semibold tracking-tight"
          >
            {/* 9（36px）而不是 5（20px）：这是水墨笔触，笔丝在小尺寸下会被
                重采样平均掉 —— 20px 时整条尾巴淡成一道钩，认不出是鱼尾 */}
            <Logo className="h-9 w-9" />
            {/* sr-only 而不是删掉：链接的无障碍名仍然是「Koinote」 */}
            <span className={compactBrand ? "sr-only" : "kn-heading-cn text-lg"}>Koinote</span>
            {/* 印章只在 sm 以上出现：手机上页头横向就那么点地方，
                先让位给语言、主题和登录态。显隐写在外层：InkSeal 自带 inline-flex，
                样式表里它排在 hidden 之后，直接传 hidden 会被覆盖，手机上照样显示 */}
            <span className="ml-0.5 hidden sm:inline-flex">
              <InkSeal className="h-7 px-0.5 text-[10px]" />
            </span>
          </Link>

          {/* 控制台是账号自己的东西（我的文档、注册时间、邮箱），归到右侧账户菜单里；
              顶栏保留编辑器和「我的空间」等工作入口。 */}
          {/* flex-1 + min-w-0：导航区占满 logo 与右侧按钮之间的空隙，宽度由页头决定
              而不是由内容撑开，自适应收起量的就是这块地方。 */}
          <nav
            ref={navRef}
            className="ml-4 hidden min-w-0 flex-1 items-center gap-5 whitespace-nowrap text-sm sm:flex"
            style={{ color: "var(--ink-mid)" }}
          >
            <HeaderLink to="/editor" active={isUnder(pathname, "/editor")} hidden={navHidden("editor")}>
              {t.nav.editor}
            </HeaderLink>
            <HeaderLink to="/space" active={isUnder(pathname, "/space")} hidden={navHidden("space")}>
              {t.nav.space}
            </HeaderLink>
            <HeaderLink to="/repositories" active={isUnder(pathname, "/repositories")} hidden={navHidden("hub")}>
              {t.agentWorkspace.publicRepositories}
            </HeaderLink>
            {desktopRuntime && localMode ? null : desktopRuntime ? (
              <>
                <HeaderDocsMenu
                  active={isUnder(pathname, "/docs")}
                  hidden={navHidden("docs")}
                  {...docsLabels}
                />
                <HeaderLink to="/pricing" active={isUnder(pathname, "/pricing")} hidden={navHidden("pricing")}>
                  {t.nav.pricing}
                </HeaderLink>
              </>
            ) : (
              <>
                <a
                  href={DESKTOP_DOWNLOAD_URL}
                  className={`kn-ink-link transition ${navHidden("download") ? "hidden" : ""}`}
                >
                  {t.nav.download}
                </a>
                <HeaderDocsMenu
                  active={isUnder(pathname, "/docs")}
                  hidden={navHidden("docs")}
                  {...docsLabels}
                />
                <HeaderLink to="/pricing" active={isUnder(pathname, "/pricing")} hidden={navHidden("pricing")}>
                  {t.nav.pricing}
                </HeaderLink>
              </>
            )}
            {hiddenNav.size > 0 && (
              <HeaderMoreMenu
                label={t.nav.more}
                keys={navKeys.filter((key) => hiddenNav.has(key))}
                pathname={pathname}
                labels={{
                  editor: t.nav.editor,
                  space: t.nav.space,
                  hub: t.agentWorkspace.publicRepositories,
                  download: t.nav.download,
                  pricing: t.nav.pricing,
                }}
                docsLabels={docsLabels}
              />
            )}
          </nav>

          <div ref={headerActionsRef} className="ml-auto flex shrink-0 items-center gap-2">
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
                settingsActive={isUnder(pathname, "/settings")}
                spaceActive={isUnder(pathname, "/space")}
                documentsActive={isUnder(pathname, "/documents")}
                trashActive={isUnder(pathname, "/trash")}
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
                className="whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-semibold text-white transition hover:opacity-90"
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
    "/space",
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
  settingsActive,
  spaceActive,
  documentsActive,
  trashActive,
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
  settingsActive: boolean;
  spaceActive: boolean;
  documentsActive: boolean;
  trashActive: boolean;
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
          className="absolute right-0 top-11 z-50 max-h-[calc(100dvh-4.5rem)] w-72 max-w-[calc(100vw-1.5rem)] overflow-y-auto overscroll-contain rounded-xl border py-1 shadow-lg"
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
              to="/settings"
              search={{ section: "ai" }}
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
              to="/settings"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-3 py-2 text-sm transition hover:bg-[var(--ink-wash-strong)]"
              style={{
                color: settingsActive
                  ? "var(--cinnabar)"
                  : "var(--ink-strong)",
                fontWeight: settingsActive ? 500 : undefined,
              }}
            >
              <Settings className="h-4 w-4 shrink-0" />
              {t.nav.settings}
            </Link>
          )}

          <Link
            to="/space"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-sm transition hover:bg-[var(--ink-wash-strong)]"
            style={{
              color: spaceActive ? "var(--cinnabar)" : "var(--ink-strong)",
              fontWeight: spaceActive ? 500 : undefined,
            }}
          >
            <FolderOpen className="h-4 w-4 shrink-0" />
            {t.nav.space}
          </Link>

          <Link to="/repositories" role="menuitem" onClick={() => setOpen(false)} className="flex items-center gap-2 px-3 py-2 text-sm transition hover:bg-[var(--ink-wash-strong)]">
            <FolderOpen className="h-4 w-4 shrink-0" />{t.agentWorkspace.publicRepositories}
          </Link>

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
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);

  function choose(next: Locale) {
    setLocale(next);
    // 地址里带着 ?lang= 时一并改掉，否则刷新后又被参数切回旧语言。走 router
    // 的 history 而不是直接 replaceState：后者不通知 router，它记着的地址
    // 还是旧的，之后基于当前 search 的跳转会把旧 lang 写回去。
    const url = new URL(window.location.href);
    if (url.searchParams.has("lang")) {
      url.searchParams.set("lang", next);
      router.history.replace(`${url.pathname}${url.search}${url.hash}`, router.history.location.state);
    }
  }

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
                choose(l);
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

/** 与 nav 的 gap-5 一致，自适应收起按它算间距 */
const HEADER_NAV_GAP_PX = 20;

function HeaderLink({
  to,
  active,
  hidden = false,
  children,
}: {
  to: "/editor" | "/space" | "/documents" | "/pricing" | "/repositories";
  active: boolean;
  /** 页头放不下时收进「更多」菜单 */
  hidden?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      // 当前项用朱砂 + 下方短横，等同于书页上的朱笔圈点
      className={`kn-ink-link relative transition ${active ? "font-medium" : ""} ${hidden ? "hidden" : ""}`}
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
  hidden = false,
  label,
  homeLabel,
  aiLabel,
  mcpLabel,
  versionLabel,
  wechatLabel,
}: {
  active: boolean;
  hidden?: boolean;
  label: string;
  homeLabel: string;
  aiLabel: string;
  mcpLabel: string;
  versionLabel: string;
  wechatLabel: string;
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
    <div className={`relative ${hidden ? "hidden" : ""}`}>
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
          className="absolute left-0 top-8 z-50 max-h-[calc(100dvh-4.5rem)] w-56 overflow-y-auto overscroll-contain rounded-xl border py-1 shadow-lg"
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
          <HeaderDocsMenuItem
            to="/docs/wechat-official-account"
            onSelect={() => setOpen(false)}
            icon={<MessageSquareText className="h-4 w-4" />}
          >
            {wechatLabel}
          </HeaderDocsMenuItem>
        </div>
      )}
    </div>
  );
}

/**
 * 页头放不下的入口。被收起的入口里有当前页时，按钮本身用朱砂标出，
 * 否则用户在这一页上找不到「我在哪」。
 */
function HeaderMoreMenu({
  label,
  keys,
  pathname,
  labels,
  docsLabels,
}: {
  label: string;
  keys: HeaderNavKey[];
  pathname: string;
  labels: Record<Exclude<HeaderNavKey, "docs">, string>;
  docsLabels: {
    label: string;
    homeLabel: string;
    aiLabel: string;
    mcpLabel: string;
    versionLabel: string;
    wechatLabel: string;
  };
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

  const routes: Record<Exclude<HeaderNavKey, "docs" | "download">, "/editor" | "/space" | "/repositories" | "/pricing"> = {
    editor: "/editor",
    space: "/space",
    hub: "/repositories",
    pricing: "/pricing",
  };
  const active = keys.some((key) =>
    key === "docs" ? isUnder(pathname, "/docs") : key !== "download" && isUnder(pathname, routes[key]),
  );
  const itemClass =
    "flex items-center gap-3 px-3 py-2.5 text-sm font-medium transition hover:bg-[var(--ink-wash-strong)]";
  const close = () => setOpen(false);

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
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
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
          // 靠右展开：「更多」在导航末尾，左对齐的话窄屏上会伸出右侧按钮区。
          // 限高并在菜单内滚动：页头是吸顶的，菜单跟着它固定在视口里，矮窗口
          // （手机横屏）上超出底部的项滚动页面也够不着
          className="absolute right-0 top-8 z-50 max-h-[calc(100dvh-4.5rem)] w-56 overflow-y-auto overscroll-contain rounded-xl border py-1 shadow-lg"
          style={{ borderColor: "var(--ink-line)", background: "var(--ink-paper-soft)" }}
        >
          {keys.map((key) =>
            key === "docs" ? (
              <div key={key} role="group" aria-label={docsLabels.label} className="border-t py-1 first:border-t-0" style={{ borderColor: "var(--ink-line)" }}>
                <HeaderDocsMenuItem to="/docs" onSelect={close} icon={<FileText className="h-4 w-4" />}>
                  {docsLabels.homeLabel}
                </HeaderDocsMenuItem>
                <HeaderDocsMenuItem to="/docs/ai-optimization" onSelect={close} icon={<Sparkles className="h-4 w-4" />}>
                  {docsLabels.aiLabel}
                </HeaderDocsMenuItem>
                <HeaderDocsMenuItem to="/docs/mcp" onSelect={close} icon={<Bot className="h-4 w-4" />}>
                  {docsLabels.mcpLabel}
                </HeaderDocsMenuItem>
                <HeaderDocsMenuItem to="/docs/version-history" onSelect={close} icon={<History className="h-4 w-4" />}>
                  {docsLabels.versionLabel}
                </HeaderDocsMenuItem>
                <HeaderDocsMenuItem to="/docs/wechat-official-account" onSelect={close} icon={<MessageSquareText className="h-4 w-4" />}>
                  {docsLabels.wechatLabel}
                </HeaderDocsMenuItem>
              </div>
            ) : key === "download" ? (
              <a key={key} href={DESKTOP_DOWNLOAD_URL} role="menuitem" onClick={close} className={itemClass} style={{ color: "var(--ink-strong)" }}>
                {labels.download}
              </a>
            ) : (
              <Link
                key={key}
                to={routes[key]}
                role="menuitem"
                onClick={close}
                className={itemClass}
                style={{ color: isUnder(pathname, routes[key]) ? "var(--cinnabar)" : "var(--ink-strong)" }}
              >
                {labels[key]}
              </Link>
            ),
          )}
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
  to:
    | "/docs"
    | "/docs/ai-optimization"
    | "/docs/mcp"
    | "/docs/version-history"
    | "/docs/wechat-official-account";
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
