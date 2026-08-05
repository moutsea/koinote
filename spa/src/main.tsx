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
// /editor 不带 id：跳最近编辑的一篇，没有则新建
// /editor/$docId：打开指定文档
const editorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/editor",
  component: lazyRouteComponent(() => import("./pages/EditorPage"), "EditorPage"),
});
const editorDocRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/editor/$docId",
  component: lazyRouteComponent(() => import("./pages/EditorPage"), "EditorPage"),
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
const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dashboard",
  component: lazyRouteComponent(
    () => import("./pages/DashboardPage"),
    "DashboardPage",
  ),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  editorRoute,
  editorDocRoute,
  loginRoute,
  registerRoute,
  dashboardRoute,
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
