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

const queryClient = new QueryClient();

// 主页与 AppShell 静态导入，保证首屏最快。
// 编辑器（TipTap 最胖）、Dashboard、登录页按路由懒加载，用到才下载对应 chunk。
const rootRoute = createRootRoute({
  component: AppShell,
  pendingComponent: RoutePending,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});
const pricingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pricing",
  component: lazyRouteComponent(
    () => import("./pages/PricingPage"),
    "PricingPage",
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
// /editor 不带 id：跳最近编辑的一篇，没有则新建
// /editor/$docId：打开指定文档
const editorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/editor",
  component: lazyRouteComponent(
    () => import("./pages/EditorPage"),
    "EditorPage",
  ),
});
const editorDocRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/editor/$docId",
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
  mcpGuideRoute,
  versionHistoryGuideRoute,
  editorRoute,
  editorDocRoute,
  loginRoute,
  registerRoute,
  dashboardRoute,
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
