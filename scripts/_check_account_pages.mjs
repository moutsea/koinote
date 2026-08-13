import fs from "node:fs";

let pass = 0;
let fail = 0;

function includes(label, source, fragment) {
  if (source.includes(fragment)) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label} —— 缺少 ${JSON.stringify(fragment)}`);
  }
}

function excludes(label, source, fragment) {
  if (!source.includes(fragment)) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label} —— 不应包含 ${JSON.stringify(fragment)}`);
  }
}

const main = fs.readFileSync("spa/src/main.tsx", "utf8");
const shell = fs.readFileSync("spa/src/components/AppShell.tsx", "utf8");
const dashboard = fs.readFileSync("spa/src/pages/DashboardPage.tsx", "utf8");
const documents = fs.readFileSync("spa/src/pages/DocumentsPage.tsx", "utf8");
const invitations = fs.readFileSync("spa/src/pages/InvitationsPage.tsx", "utf8");
const historySettings = fs.readFileSync("spa/src/components/DocumentHistorySettingsCard.tsx", "utf8");
const pricing = fs.readFileSync("spa/src/pages/PricingPage.tsx", "utf8");

includes("注册文档页路由", main, 'path: "/documents"');
includes("注册邀请页路由", main, 'path: "/invitations"');
includes("注册价格页路由", main, 'path: "/pricing"');
includes(
  "文档路由绑定 DocumentsPage",
  main,
  'path: "/documents",\n  component: lazyRouteComponent(\n    () => import("./pages/DocumentsPage"),\n    "DocumentsPage"',
);
includes(
  "邀请路由绑定 InvitationsPage",
  main,
  'path: "/invitations",\n  component: lazyRouteComponent(\n    () => import("./pages/InvitationsPage"),\n    "InvitationsPage"',
);
includes("用户菜单包含文档入口", shell, 'to="/documents"');
includes("用户菜单包含邀请入口", shell, 'to="/invitations"');
includes("文档入口只在登录用户菜单中渲染", shell, '<UserMenu\n                name={user.nickname');

excludes("控制台不再读取文档列表", dashboard, "useDocumentList");
excludes("控制台不再渲染邀请卡", dashboard, "InvitationCard");
excludes("控制台不再渲染用户名卡片", dashboard, "t.dashboard.username");
includes("控制台渲染历史版本设置", dashboard, "<DocumentHistorySettingsCard user={user} />");
includes("历史版本设置可读取", historySettings, "getDocumentHistorySettings");
includes("历史版本设置可修改", historySettings, "updateDocumentHistorySettings");
includes("文档页读取文档列表", documents, "useDocumentList");
includes("邀请页渲染邀请卡", invitations, "InvitationCard");
includes("价格页读取公开价目表", pricing, "getBillingPricing");
includes("价格页登录用户可直接结账", pricing, "createMembershipCheckout");
includes("顶栏包含价格入口", shell, 'to="/pricing"');

console.log(`\naccount pages: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
