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
const login = fs.readFileSync("spa/src/pages/LoginPage.tsx", "utf8");
const settings = fs.readFileSync("spa/src/pages/SettingsPage.tsx", "utf8");
const documents = fs.readFileSync("spa/src/pages/DocumentsPage.tsx", "utf8");
const documentHooks = fs.readFileSync("spa/src/documents.ts", "utf8");
const invitationCard = fs.readFileSync("spa/src/components/InvitationCard.tsx", "utf8");
const membershipCard = fs.readFileSync("spa/src/components/MembershipCard.tsx", "utf8");
const shareDialog = fs.readFileSync("spa/src/components/editor/ShareDialog.tsx", "utf8");
const historySettings = fs.readFileSync("spa/src/components/DocumentHistorySettingsCard.tsx", "utf8");
const pricing = fs.readFileSync("spa/src/pages/PricingPage.tsx", "utf8");
const accountDeletion = fs.readFileSync("spa/src/components/AccountDeletionCard.tsx", "utf8");
const admin = fs.readFileSync("spa/src/pages/AdminPage.tsx", "utf8");

includes("注册文档页路由", main, 'path: "/documents"');
includes("注册价格页路由", main, 'path: "/pricing"');
includes("注册统一设置页路由", main, 'path: "/settings"');
includes("登录默认落点进入设置", login, 'return "/settings";');
includes(
  "文档路由绑定 DocumentsPage",
  main,
  'path: "/documents",\n  component: lazyRouteComponent(\n    () => import("./pages/DocumentsPage"),\n    "DocumentsPage"',
);
includes("用户菜单包含文档入口", shell, 'to="/documents"');
includes("用户菜单包含统一设置入口", shell, 'to="/settings"');
excludes("用户菜单不再单列控制台", shell, 'to="/dashboard"');
excludes("用户菜单不再单列 AI 设置", shell, 'to="/ai-settings"');
excludes("用户菜单不再单列邀请", shell, 'to="/invitations"');
includes("文档入口只在登录用户菜单中渲染", shell, '<UserMenu\n                name={user.nickname');

includes("设置页采用左右分栏", settings, 'lg:grid-cols-[14rem_minmax(0,1fr)]');
includes("设置页包含通用分类", settings, 'id: "general"');
includes("设置页包含会员分类", settings, 'id: "membership"');
includes("设置页包含 AI 分类", settings, 'id: "ai"');
includes("设置页包含邀请分类", settings, 'id: "invitations"');
includes("通用设置渲染账号安全", settings, "<PasswordSecurityCard user={user} />");
includes("通用设置渲染账号注销", settings, "<AccountDeletionCard user={user} />");
includes("会员设置渲染会员信息", settings, "<MembershipCard user={user} />");
includes("会员卡明确显示当前方案", membershipCard, "t.membership.currentPlan");
includes("免费账号明确显示 Free Plan", membershipCard, "t.membership.freePlan");
includes("会员卡优先展示当前存储权益", membershipCard, "t.membership.currentStorageBenefit");
includes("会员卡只保留升级按钮", membershipCard, 'to="/pricing"');
excludes("会员卡不再内嵌支付导航", membershipCard, "openMembershipCheckout");
includes("会员设置渲染云端用量", settings, "<StorageCard />");
includes("会员设置渲染版本历史", settings, "<DocumentHistorySettingsCard user={user} />");
includes("AI 设置渲染 credits", settings, "<AgentCreditsCard user={user} />");
includes("AI 设置渲染模型来源", settings, "<AgentModelSettingsCard user={user} />");
includes("AI 设置渲染模型渠道", settings, "<LLMChannelsCard user={user} />");
includes("AI 设置渲染 MCP 令牌", settings, "<MCPAccessCard user={user} />");
includes("免费用户只显示 AI 升级门禁", settings, 'user.membershipTier !== "lifetime"');
includes("设置页在基本信息提供升级入口", settings, "<AccountOverviewCard user={user} />");
includes("旧控制台地址兼容跳转", settings, "LegacyDashboardPage");
includes("旧 AI 地址兼容跳转", settings, "LegacyAISettingsPage");
includes("旧邀请地址兼容跳转", settings, "LegacyInvitationsPage");
includes("账号注销要求当前邮箱确认", accountDeletion, "t.accountDeletion.confirmLabel");
includes("历史版本设置可读取", historySettings, "getDocumentHistorySettings");
includes("历史版本设置可修改", historySettings, "updateDocumentHistorySettings");
includes("文档页读取文档列表", documents, "useDocumentList");
includes("设置页邀请分类渲染邀请卡", settings, "return <InvitationCard />");
includes("邀请链接使用站点公开域名", invitationCard, "koinoteWebURL(");
excludes("邀请链接不使用 Tauri 本地域名", invitationCard, "window.location.origin");
includes("邀请卡兼容旧版邀请接口", invitationCard, "data.invitedUsers ?? []");
includes("邀请卡渲染受邀列表", invitationCard, "invitedUsers.map");
includes("分享链接使用站点公开域名", shareDialog, "koinoteWebURL(");
excludes("分享链接不使用 Tauri 本地域名", shareDialog, "window.location.origin");
includes("分享请求期间显示进度", shareDialog, "t.editor.shareSaving");
includes("分享成功后立即更新当前文档", documentHooks, "{ ...document, share }");
includes("撤销分享后立即清除当前文档状态", documentHooks, "{ ...document, share: null }");
includes("价格页读取公开价目表", pricing, "getBillingPricing");
includes("价格页登录用户可直接结账", pricing, "createMembershipCheckout");
includes("价格页展示 credits 套餐", pricing, "creditPacks.map");
includes("会员可在价格页购买 credits", pricing, "createAgentCreditsCheckout");
includes("用户菜单读取 credits", shell, "queryFn: getAgentCredits");
includes("用户菜单只向会员展示 credits", shell, "!localMode && membershipActive && (");
includes("顶栏包含价格入口", shell, 'to="/pricing"');
includes("注销账号付款保留明确占位", admin, "payment.userName ?? t.admin.deletedAccount");

console.log(`\naccount pages: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
