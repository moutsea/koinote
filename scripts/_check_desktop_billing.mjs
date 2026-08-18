import fs from "node:fs";
import {
  desktopBillingDeepLink,
  isTerminalBillingHTTPStatus,
} from "./_desktop_billing_core_bundle.mjs";

let pass = 0;
let fail = 0;

function equal(label, actual, expected) {
  if (actual === expected) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label} —— ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}

function includes(label, source, fragment) {
  if (source.includes(fragment)) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label} —— 缺少 ${JSON.stringify(fragment)}`);
  }
}

equal(
  "成功页只把 Stripe Session 带回客户端",
  desktopBillingDeepLink("https://koinote.app/billing/desktop-return?checkout=success&session_id=cs_test_123"),
  "koinote://billing?checkout=success&session_id=cs_test_123",
);
equal(
  "取消页不需要 Session",
  desktopBillingDeepLink("https://koinote.app/billing/desktop-return?checkout=cancelled"),
  "koinote://billing?checkout=cancelled",
);
equal(
  "Credits 成功页保留购买类型和 Session",
  desktopBillingDeepLink("https://koinote.app/billing/desktop-return?checkout=success&purchase=credits&session_id=cs_test_credits"),
  "koinote://billing?checkout=success&purchase=credits&session_id=cs_test_credits",
);
equal(
  "Credits 取消页保留购买类型",
  desktopBillingDeepLink("https://koinote.app/billing/desktop-return?checkout=cancelled&purchase=credits"),
  "koinote://billing?checkout=cancelled&purchase=credits",
);
equal(
  "成功页拒绝缺失 Session",
  desktopBillingDeepLink("https://koinote.app/billing/desktop-return?checkout=success"),
  null,
);
equal(
  "回跳页拒绝未知状态",
  desktopBillingDeepLink("https://koinote.app/billing/desktop-return?checkout=failed&session_id=cs_test_123"),
  null,
);
equal("401 是支付轮询终态", isTerminalBillingHTTPStatus(401), true);
equal("403 是支付轮询终态", isTerminalBillingHTTPStatus(403), true);
equal("500 是可重试故障", isTerminalBillingHTTPStatus(500), false);
equal("429 是可重试限流", isTerminalBillingHTTPStatus(429), false);

const auth = fs.readFileSync("spa/src/desktop/auth.ts", "utf8");
const api = fs.readFileSync("spa/src/api.ts", "utf8");
const main = fs.readFileSync("spa/src/main.tsx", "utf8");
const pricing = fs.readFileSync("spa/src/pages/PricingPage.tsx", "utf8");
const membership = fs.readFileSync("spa/src/components/MembershipCard.tsx", "utf8");
const shell = fs.readFileSync("spa/src/components/AppShell.tsx", "utf8");
const backendMain = fs.readFileSync("backend/cmd/server/main.go", "utf8");

includes("客户端处理 billing deep link", auth, 'callback.hostname === "billing"');
includes("客户端用自身会话确认支付", auth, "confirmMembershipCheckout(sessionId)");
includes("客户端等待 webhook 履约", auth, "pollDesktopMembership");
includes("客户端确认 Credits 支付", auth, "confirmAgentCreditsCheckout(sessionId)");
includes("客户端等待 Credits webhook 履约", auth, "pollDesktopCredits");
includes("Credits 回调保留独立事件类型", auth, 'kind: "credits"');
includes("长时间处理进入明确终态", auth, 'status: "delayed"');
includes("轮询单次故障不会退出循环", auth, "isTerminalDesktopBillingError(error, ApiError)");
includes("Checkout 请求标记客户端来源", api, 'client: isDesktopRuntime() ? "desktop" : "web"');
includes("桌面回跳页已注册", main, 'path: "/billing/desktop-return"');
includes("回跳后刷新会员状态", main, '["membership-status"]');
includes("Credits 回跳后刷新余额", main, '["agent-credits"]');
includes("价格页读取权威会员状态", pricing, "getMembershipStatus");
includes("价格页识别处理中 409", pricing, 'checkoutErrorCode === "checkout_in_progress"');
includes("会员卡识别处理中 409", membership, 'error.code === "checkout_in_progress"');
includes("会员卡识别已生效 409", membership, 'error.code === "membership_already_active"');
includes("Web 轮询使用共享终态判断", membership, "isTerminalBillingHTTPStatus(error.status)");
includes("Web 轮询超时进入 delayed", membership, 'setNotice("delayed")');
includes("Web 未决支付禁止重复付款", membership, "checkoutUnresolved");
includes("客户端显示全局支付状态", shell, "desktopBillingNotice");
includes("后台启动有界 Checkout 清理", backendMain, "StartStripeCheckoutCleanup");

console.log(`\ndesktop billing: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
