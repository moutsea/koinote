import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  RouterProvider,
} from "@tanstack/react-router";

import "./globals.css";
import { I18nProvider } from "./i18n";
import { AppShell } from "./components/AppShell";
import { HomePage } from "./pages/HomePage";
import { isDesktopRuntime } from "./desktop/runtime";
import { installDropNavigationGuard } from "./dropNavigation";

const queryClient = new QueryClient();
const desktopRuntime = isDesktopRuntime();

installDropNavigationGuard();

if (desktopRuntime) {
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
    | "ai"
    | "invitations"
    | "wechat"
    | "zhihu";
  checkout?: string;
  credit_checkout?: string;
  session_id?: string;
} {
  const section = search.section;
  return {
    section:
      section === "general" ||
      section === "membership" ||
      section === "ai" ||
      section === "invitations" ||
      section === "wechat" ||
      section === "zhihu"
        ? section
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
  getParentRoute: () => rootRoute,
  path: "/editor/$docId",
  validateSearch: parseEditorSearch,
  component: lazyRouteComponent(
    () => import("./pages/EditorPage"),
    "EditorPage",
  ),
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
// 公开分享页：无需登录，token 即凭证
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
  editorRoute,
  editorDocRoute,
  loginRoute,
  desktopAuthorizeRoute,
  desktopBillingReturnRoute,
  registerRoute,
  dashboardRoute,
  settingsRoute,
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

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nProvider>
  </React.StrictMode>,
);
