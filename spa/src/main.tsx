import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  RouterProvider,
} from "@tanstack/react-router";

import "./globals.css";
import { I18nProvider } from "./i18n";
import { AppShell } from "./components/AppShell";
import { HomePage } from "./pages/HomePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { isDesktopRuntime } from "./desktop/runtime";
import { installDesktopSyncQueryRefresh } from "./desktop/syncQueries";
import { installDropNavigationGuard } from "./dropNavigation";
import { parseRepositorySearch } from "./agentRepositoryMarkdown";
import { parseRepositoryDirectorySearch } from "./agentRepositoryDirectory";

const queryClient = new QueryClient();
const desktopRuntime = isDesktopRuntime();

installDropNavigationGuard();

if (desktopRuntime) {
  installDesktopSyncQueryRefresh(queryClient);
  void import("./desktop/auth").then(
    ({ DESKTOP_BILLING_EVENT, initializeDesktopAuth }) => {
      window.addEventListener(DESKTOP_BILLING_EVENT, (event) => {
        const detail = (event as CustomEvent<{ user?: unknown; kind?: "membership" | "credits" }>).detail;
        if (detail?.user) queryClient.setQueryData(["session"], { user: detail.user });
        void queryClient.invalidateQueries({ queryKey: ["session"] });
        void queryClient.invalidateQueries({ queryKey: ["membership-status"] });
        void queryClient.invalidateQueries({ queryKey: ["storage-usage"] });
        if (detail?.kind === "credits") {
          void queryClient.invalidateQueries({ queryKey: ["agent-credits"] });
        }
      });
      void initializeDesktopAuth();
    },
  );
}

const IndexPage = desktopRuntime
  ? lazyRouteComponent(
      () => import("./pages/DesktopHomePage"),
      "DesktopHomePage",
    )
  : HomePage;

// 主页与 AppShell 静态导入，保证首屏最快。
// 编辑器（TipTap 最胖）、Dashboard、登录页按路由懒加载，用到才下载对应 chunk。
const rootRoute = createRootRoute({
  component: AppShell,
  pendingComponent: RoutePending,
  // 路由表之外的地址。HTTP 404 状态码由 Worker 给（worker/seo.ts）
  notFoundComponent: NotFoundPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: IndexPage,
});
const pricingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pricing",
  component: lazyRouteComponent(
    () => import("./pages/PricingPage"),
    "PricingPage",
  ),
});
const docsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/docs",
  component: lazyRouteComponent(
    () => import("./pages/DocsPage"),
    "DocsPage",
  ),
});
const mcpGuideRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/docs/mcp",
  component: lazyRouteComponent(
    () => import("./pages/MCPGuidePage"),
    "MCPGuidePage",
  ),
});
const versionHistoryGuideRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/docs/version-history",
  component: lazyRouteComponent(
    () => import("./pages/VersionHistoryGuidePage"),
    "VersionHistoryGuidePage",
  ),
});
const aiOptimizationGuideRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/docs/ai-optimization",
  component: lazyRouteComponent(
    () => import("./pages/AIOptimizationGuidePage"),
    "AIOptimizationGuidePage",
  ),
});
const aiOptimizationCaseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/docs/ai-optimization/case",
  component: lazyRouteComponent(
    () => import("./pages/AIOptimizationCasePage"),
    "AIOptimizationCasePage",
  ),
});
const wechatOfficialAccountGuideRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/docs/wechat-official-account",
  component: lazyRouteComponent(
    () => import("./pages/WechatOfficialAccountGuidePage"),
    "WechatOfficialAccountGuidePage",
  ),
});
const changelogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/changelog",
  component: lazyRouteComponent(
    () => import("./pages/ChangelogPage"),
    "ChangelogPage",
  ),
});
// /editor 不带 id：跳最近编辑的一篇，没有则新建
// /editor/$docId：打开指定文档
function parseEditorSearch(
  search: Record<string, unknown>,
): { create?: true } {
  return {
    create:
      search.create === true || search.create === "1" ? true : undefined,
  };
}

function parseSettingsSearch(search: Record<string, unknown>): {
  section?:
    | "general"
    | "membership"
    | "agent"
    | "configs"
    | "ai"
    | "invitations"
    | "media"
    | "wechat"
    | "zhihu"
    | "x"
    | "custom"
    | "feishu";
  platform?: "wechat" | "zhihu" | "x" | "custom";
  checkout?: string;
  credit_checkout?: string;
  session_id?: string;
} {
  const section = search.section;
  return {
    section:
      section === "general" ||
      section === "membership" ||
      section === "agent" ||
      section === "configs" ||
      section === "ai" ||
      section === "invitations" ||
      section === "media" ||
      section === "wechat" ||
      section === "zhihu" ||
      section === "x" ||
      section === "custom" ||
      section === "feishu"
        ? section
        : undefined,
    platform:
      search.platform === "wechat" ||
      search.platform === "zhihu" ||
      search.platform === "x" ||
      search.platform === "custom"
        ? search.platform
        : undefined,
    checkout: typeof search.checkout === "string" ? search.checkout : undefined,
    credit_checkout:
      typeof search.credit_checkout === "string"
        ? search.credit_checkout
        : undefined,
    session_id:
      typeof search.session_id === "string" ? search.session_id : undefined,
  };
}

function parseAgentWorkspaceSearch(search: Record<string, unknown>): { from?: "hub" | "space" | "settings" } {
  return {
    from: search.from === "hub" || search.from === "space" || search.from === "settings" ? search.from : undefined,
  };
}

function parseSpaceSearch(search: Record<string, unknown>): { tab?: "config" | "agent" } {
  return {
    tab: search.tab === "agent" || search.tab === "config" ? search.tab : undefined,
  };
}

function parseAgentWorkspaceSettingsSearch(search: Record<string, unknown>): { workspaceId?: number } {
  const workspaceId = Number(search.workspaceId);
  return { workspaceId: Number.isSafeInteger(workspaceId) && workspaceId > 0 ? workspaceId : undefined };
}

const editorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/editor",
  validateSearch: parseEditorSearch,
  component: lazyRouteComponent(
    () => import("./pages/EditorPage"),
    "EditorPage",
  ),
});
const editorDocRoute = createRoute({
  // 文档与空白工作区共享 EditorPage，关闭最后一个标签时保存层和撤销状态仍存活。
  getParentRoute: () => editorRoute,
  path: "$docId",
  validateSearch: parseEditorSearch,
});
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: lazyRouteComponent(
    () => import("./pages/LoginPage"),
    "LoginRoute",
  ),
});
const desktopAuthorizeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/desktop/authorize",
  component: lazyRouteComponent(
    () => import("./pages/DesktopAuthorizePage"),
    "DesktopAuthorizePage",
  ),
});
const desktopBillingReturnRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/billing/desktop-return",
  component: lazyRouteComponent(
    () => import("./pages/DesktopBillingReturnPage"),
    "DesktopBillingReturnPage",
  ),
});
const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  component: lazyRouteComponent(
    () => import("./pages/LoginPage"),
    "RegisterRoute",
  ),
});
// 公开分享页：无需登录即可预览，全文仍由后端校验会话
const shareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/share/$token",
  component: lazyRouteComponent(() => import("./pages/SharePage"), "SharePage"),
});
const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dashboard",
  component: lazyRouteComponent(
    () => import("./pages/DashboardPage"),
    "DashboardPage",
  ),
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  validateSearch: parseSettingsSearch,
  component: lazyRouteComponent(
    () => import("./pages/SettingsPage"),
    "SettingsPage",
  ),
});
const agentPublicRepositoriesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/repositories",
  validateSearch: parseRepositoryDirectorySearch,
  component: lazyRouteComponent(() => import("./pages/AgentPublicRepositoriesPage"), "AgentPublicRepositoriesPage"),
});
const agentPublicRepositoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/repositories/$repositoryId",
  validateSearch: parseRepositorySearch,
  component: lazyRouteComponent(() => import("./pages/AgentPublicRepositoryPage"), "AgentPublicRepositoryPage"),
});
const agentWorkspaceRepositoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agent/workspaces/$workspaceId",
  validateSearch: parseAgentWorkspaceSearch,
  component: lazyRouteComponent(
    () => import("./pages/AgentWorkspaceRepositoryPage"),
    "AgentWorkspaceRepositoryPage",
  ),
});
const agentWorkspaceSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/space/settings",
  validateSearch: parseAgentWorkspaceSettingsSearch,
  component: lazyRouteComponent(
    () => import("./pages/AgentWorkspaceSettingsPage"),
    "AgentWorkspaceSettingsPage",
  ),
});
const legacyAgentWorkspaceSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agent/settings",
  validateSearch: parseAgentWorkspaceSettingsSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/space/settings", search, replace: true });
  },
});
const agentWorkspaceRepositoriesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agent/workspaces",
  beforeLoad: () => {
    throw redirect({ to: "/space", search: { tab: "agent" } });
  },
  component: lazyRouteComponent(
    () => import("./pages/AgentWorkspaceRepositoriesPage"),
    "AgentWorkspaceRepositoriesPage",
  ),
});
const spaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/space",
  validateSearch: parseSpaceSearch,
  component: lazyRouteComponent(
    () => import("./pages/SpacePage"),
    "SpacePage",
  ),
});
const aiSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ai-settings",
  component: lazyRouteComponent(
    () => import("./pages/AISettingsPage"),
    "AISettingsPage",
  ),
});
const mcpActivityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mcp/activity",
  component: lazyRouteComponent(
    () => import("./pages/MCPActivityPage"),
    "MCPActivityPage",
  ),
});
const documentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/documents",
  component: lazyRouteComponent(
    () => import("./pages/DocumentsPage"),
    "DocumentsPage",
  ),
});
const trashRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/trash",
  component: lazyRouteComponent(() => import("./pages/TrashPage"), "TrashPage"),
});
const invitationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invitations",
  component: lazyRouteComponent(
    () => import("./pages/InvitationsPage"),
    "InvitationsPage",
  ),
});
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: lazyRouteComponent(() => import("./pages/AdminPage"), "AdminPage"),
});

// 条款页：三条路由共用一个 LegalPage，内容按 kind 从 i18n 取。
// 懒加载同一个 chunk —— 三页的代码完全相同，读者也常常连着看两页
const privacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/privacy",
  component: lazyRouteComponent(
    () => import("./pages/LegalPage"),
    "PrivacyPage",
  ),
});
const termsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/terms",
  component: lazyRouteComponent(() => import("./pages/LegalPage"), "TermsPage"),
});
const cookiesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cookies",
  component: lazyRouteComponent(
    () => import("./pages/LegalPage"),
    "CookiesPage",
  ),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  pricingRoute,
  docsRoute,
  mcpGuideRoute,
  versionHistoryGuideRoute,
  aiOptimizationGuideRoute,
  aiOptimizationCaseRoute,
  wechatOfficialAccountGuideRoute,
  changelogRoute,
  editorRoute.addChildren([editorDocRoute]),
  loginRoute,
  desktopAuthorizeRoute,
  desktopBillingReturnRoute,
  registerRoute,
  dashboardRoute,
  settingsRoute,
  agentWorkspaceRepositoriesRoute,
  agentWorkspaceSettingsRoute,
  legacyAgentWorkspaceSettingsRoute,
  agentWorkspaceRepositoryRoute,
  agentPublicRepositoriesRoute,
  agentPublicRepositoryRoute,
  spaceRoute,
  aiSettingsRoute,
  mcpActivityRoute,
  documentsRoute,
  trashRoute,
  invitationsRoute,
  adminRoute,
  shareRoute,
  privacyRoute,
  termsRoute,
  cookiesRoute,
]);

const router = createRouter({
  routeTree,
  defaultPendingComponent: RoutePending,
  // 匹配不上的地址一律由根路由显示 NotFoundPage，与 Worker 的 404 一致。
  // 默认的 fuzzy 会把 /editor/a/b 这种地址挂到 /editor 上，而编辑器页没有
  // <Outlet>，结果是服务端回 404、页面却照常打开编辑器
  notFoundMode: "root",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function RoutePending() {
  return (
    <div className="flex flex-1 items-center justify-center py-24 text-sm text-neutral-400">
      加载中…
    </div>
  );
}

function renderApp() {
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </I18nProvider>
    </React.StrictMode>,
  );
}

// 公开页的 #root 里有 Worker 渲染的静态正文（worker/seo.ts）。React 首次提交会
// 清空它；若此时懒加载的页面 chunk 还没到，用户会看到正文 → 「加载中…」→ 正文
// 的闪烁。先把当前路由的 chunk 拉下来再挂载，静态正文一直留到真页面能直接接上。
// 预加载失败也照常挂载，交给路由自己的错误处理。
if (document.querySelector("#root > .seo-static")) {
  // 只预加载组件代码，不动 router 状态：挂载后 RouterProvider 照常自己 load，
  // 那时 lazyRouteComponent 已有缓存，会直接渲染而不是挂起。
  const components = router
    .matchRoutes(router.latestLocation.pathname, router.latestLocation.search)
    .map(
      (match) =>
        router.looseRoutesById[match.routeId]?.options.component as
          | { preload?: () => Promise<unknown> }
          | undefined,
    );
  // 最多等 3 秒：chunk 请求卡住时宁可闪一下「加载中…」，也不能让页面一直停在
  // 静态正文、点什么都没反应
  void Promise.race([
    Promise.all(components.map((component) => component?.preload?.())),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ])
    .catch(() => undefined)
    .finally(renderApp);
} else {
  renderApp();
}
