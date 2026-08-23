// Koinote 前端 API 封装
// 所有请求走同源 /api/*，dev 由 Vite 代理转发到 Go 后端，prod 由 Worker 代理。
// credentials:"include" 让浏览器带上 koinote_session cookie，实现基于 cookie 的会话。

import { isDesktopRuntime } from "./desktop/runtime";
import { isDesktopAuthenticationRejection } from "./desktop/networkPolicy";
import { isDesktopLocalImageURL } from "./desktop/offlineImagesCore";

export type User = {
  id: number;
  authUserId: string;
  email: string;
  username?: string | null;
  nickname?: string | null;
  avatarUrl?: string | null;
  isVerified: boolean;
  isAdmin: boolean;
  hasPassword: boolean;
  membershipTier: "free" | "lifetime";
  membershipGrantedAt?: string | null;
  bonusStorageBytes: number;
  createdAt?: string | null;
  updatedAt?: string | null;
  isLocalMode?: boolean;
};

// 带后端错误码的错误对象：code 供前端 i18n 翻译，message 为英文兜底。
export class ApiError extends Error {
  code?: string;
  email?: string;
  status: number;
  constructor(status: number, message: string, code?: string, email?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.email = email;
  }
}

/**
 * 图床超额事件。超额时全局弹一次窗，而不是只在编辑器角落显示一行错误。
 *
 * 用事件而不是把回调层层传下去：上传会在三个地方失败（拖放上传、粘贴 base64、
 * 转存外链），加上 rehost 那条路，四处都要接同一个弹窗。事件让 api.ts 里
 * 构造错误的那一处广播，AppShell 里监听一次就够。
 *
 * 这是全局的，所以只用于"必须打断用户"的情况。普通上传失败仍走编辑器内的行内提示。
 */
export const IMAGE_QUOTA_EVENT = "koinote:image-quota-exceeded";

/**
 * 超额错误码。
 *
 * 两个而不是一个：图片上传超额由 Worker 回 image_quota_exceeded，
 * 文档保存超额由后端回 storage_quota_exceeded。两条路径的用户动作不同
 * （贴图 vs 打字），但要弹同一个窗 —— 都是"云端空间满了"。
 */
export const IMAGE_QUOTA_CODE = "image_quota_exceeded";
export const STORAGE_QUOTA_CODE = "storage_quota_exceeded";
export const TEMPORARY_IMAGE_QUOTA_CODE = "temporary_image_quota_exceeded";

const QUOTA_CODES = new Set<string>([IMAGE_QUOTA_CODE, STORAGE_QUOTA_CODE]);

export type ImageQuotaDetail = {
  usedBytes: number;
  quotaBytes: number;
  /** 分项。旧版后端可能不返回，所以是可选的 */
  documentBytes?: number;
  imageBytes?: number;
};

async function toApiError(response: Response): Promise<ApiError> {
  let message = `Request failed (${response.status})`;
  let code: string | undefined;
  let email: string | undefined;
  let quota: ImageQuotaDetail | null = null;
  try {
    const data = await response.json();
    if (data && typeof data.error === "string") message = data.error;
    if (data && typeof data.code === "string") code = data.code;
    if (data && typeof data.email === "string") email = data.email;
    // 后端在 409 里回了当前用量，弹窗要用它显示"已用多少 / 共多少"
    if (
      data &&
      typeof data.usedBytes === "number" &&
      typeof data.quotaBytes === "number"
    ) {
      quota = {
        usedBytes: data.usedBytes,
        quotaBytes: data.quotaBytes,
        ...(typeof data.documentBytes === "number"
          ? { documentBytes: data.documentBytes }
          : {}),
        ...(typeof data.imageBytes === "number"
          ? { imageBytes: data.imageBytes }
          : {}),
      };
    }
  } catch {
    // 忽略解析失败，落到状态码兜底
  }

  if (
    code !== undefined &&
    QUOTA_CODES.has(code) &&
    typeof window !== "undefined"
  ) {
    // 用量缺失时给 0/0：storage.ts 的 usageRatio 把 quota<=0 当作"满"，
    // 弹窗仍然能正确表达"没空间了"，只是数字显示为 0
    window.dispatchEvent(
      new CustomEvent<ImageQuotaDetail>(IMAGE_QUOTA_EVENT, {
        detail: quota ?? { usedBytes: 0, quotaBytes: 0 },
      }),
    );
  }

  return new ApiError(response.status, message, code, email);
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchAppResource(path, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  return response.json() as Promise<T>;
}

export async function fetchAppResource(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  if (isDesktopRuntime()) {
    if (isDesktopLocalImageURL(path)) {
      const { desktopResolveImageSource } =
        await import("./desktop/offlineStore");
      const source = await desktopResolveImageSource(path);
      if (!source) return new Response(null, { status: 404 });
      return fetch(source, { signal: init?.signal });
    }
    const { desktopFetch } = await import("./desktop/network");
    return desktopFetch(path, init);
  }
  return fetch(path, init);
}

export function register(params: {
  username: string;
  email: string;
  password: string;
  verificationCode: string;
  invitationCode?: string;
}) {
  return apiJson<{ user: User }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function sendVerificationCode(email: string, locale: string) {
  return apiJson<{
    ok: boolean;
    expiresInSeconds: number;
    retryAfterSeconds: number;
    devCode?: string;
  }>("/api/auth/verification-code", {
    method: "POST",
    body: JSON.stringify({ email, locale }),
  });
}

export function verifyEmail(params: {
  email: string;
  password: string;
  verificationCode: string;
}) {
  return apiJson<{ user: User }>("/api/auth/verify-email", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function sendPasswordResetCode(email: string, locale: string) {
  return apiJson<{
    ok: boolean;
    expiresInSeconds: number;
    retryAfterSeconds: number;
    devCode?: string;
  }>("/api/auth/password-reset-code", {
    method: "POST",
    body: JSON.stringify({ email, locale }),
  });
}

export function resetPassword(params: {
  email: string;
  verificationCode: string;
  newPassword: string;
}) {
  return apiJson<{ success: boolean }>("/api/auth/password-reset", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function changePassword(currentPassword: string, newPassword: string) {
  return apiJson<{ success: boolean }>("/api/auth/password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export function invalidateOtherSessions() {
  return apiJson<{ success: boolean }>("/api/auth/sessions/invalidate", {
    method: "POST",
  });
}

export function login(identifier: string, password: string) {
  return apiJson<{ user: User }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: identifier, password }),
  });
}

export async function logout() {
  if (!isDesktopRuntime()) {
    return apiJson<{ success: boolean }>("/api/auth/logout", {
      method: "POST",
    });
  }
  const { clearDesktopSession, getStoredDesktopSession } =
    await import("./desktop/auth");
  const session = await getStoredDesktopSession();
  try {
    try {
      await apiJson<{ success: boolean }>("/api/auth/desktop/revoke", {
        method: "POST",
      });
    } catch {
      // 离线登出仍须立即清掉本机令牌和文档；服务端访问令牌最多 15 分钟失效，
      // 刷新令牌也已从系统钥匙串删除，恢复网络后不会再被客户端使用。
    }
    return { success: true };
  } finally {
    try {
      if (session?.accountId) {
        const { clearDesktopOfflineAccount } =
          await import("./desktop/offlineStore");
        await clearDesktopOfflineAccount(session.accountId);
      }
    } finally {
      // 清理 SQLite 失败也不能阻止钥匙串令牌删除。否则用户看到登出失败后，
      // 访问令牌和 30 天刷新令牌仍会留在设备上。
      await clearDesktopSession();
    }
  }
}

export async function deleteAccount(confirmation: string) {
  const desktopRuntime = isDesktopRuntime();
  const session = desktopRuntime
    ? await import("./desktop/auth").then(({ getStoredDesktopSession }) =>
        getStoredDesktopSession(),
      )
    : null;
  const result = await apiJson<{ success: boolean }>("/api/account", {
    method: "DELETE",
    body: JSON.stringify({ confirmation }),
  });
  if (!desktopRuntime) return { ...result, localCleanupFailed: false };

  let localCleanupFailed = false;
  try {
    if (session?.accountId) {
      const { clearDesktopOfflineAccount } =
        await import("./desktop/offlineStore");
      await clearDesktopOfflineAccount(session.accountId);
    }
  } catch {
    localCleanupFailed = true;
  }
  try {
    const { clearDesktopSession } = await import("./desktop/auth");
    await clearDesktopSession();
  } catch {
    localCleanupFailed = true;
  }
  return { ...result, localCleanupFailed };
}

export async function getSession() {
  if (!isDesktopRuntime()) {
    return apiJson<{ user: User }>("/api/auth/session");
  }
  const { isDesktopLocalModeSelected, isDesktopLocalModeUnlocked } =
    await import("./desktop/localMode");
  if (isDesktopLocalModeSelected()) {
    if (!isDesktopLocalModeUnlocked()) return { user: null };
    return {
      user: {
        id: 0,
        authUserId: "local:v1",
        email: "",
        nickname: "Local",
        isVerified: false,
        isAdmin: false,
        hasPassword: true,
        membershipTier: "free" as const,
        bonusStorageBytes: 0,
        isLocalMode: true,
      },
    };
  }
  try {
    const result = await apiJson<{ user: User }>("/api/auth/session");
    const { updateCachedDesktopUser } = await import("./desktop/auth");
    await updateCachedDesktopUser(result.user);
    return result;
  } catch (error) {
    // 只有 401/403 明确证明凭证无效；Worker 或后端返回 5xx 时仍应使用
    // 钥匙串里的最后一次身份打开本地文档，否则“服务端故障”会把离线客户端
    // 错误地送回登录页。受保护 API 的同步仍会失败，不会因此越权。
    if (
      error instanceof ApiError &&
      isDesktopAuthenticationRejection(error.status)
    ) {
      throw error;
    }
    const { getCachedDesktopUser } = await import("./desktop/auth");
    const user = await getCachedDesktopUser();
    if (!user) throw error;
    return { user };
  }
}

export function authorizeDesktop(params: {
  clientId: string;
  codeChallenge: string;
  state: string;
}) {
  return apiJson<{ redirectUri: string }>("/api/auth/desktop/authorize", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export type DocumentHistorySettings = {
  enabled: boolean;
  perDocumentMax: number;
  mcpEnabled: boolean;
  available: boolean;
  accountMax: number;
};

export function getDocumentHistorySettings() {
  return apiJson<{ settings: DocumentHistorySettings }>(
    "/api/settings/document-history",
  );
}

export function updateDocumentHistorySettings(
  settings: Pick<
    DocumentHistorySettings,
    "enabled" | "perDocumentMax" | "mcpEnabled"
  >,
) {
  return apiJson<{ settings: DocumentHistorySettings }>(
    "/api/settings/document-history",
    { method: "PUT", body: JSON.stringify(settings) },
  );
}

// ---------- 会员与支付 ----------

export type MembershipStatus = {
  tier: "free" | "lifetime";
  active: boolean;
  storageQuotaBytes: number;
  /** 代表已取得未来 AI 功能权益；具体 AI 功能尚未上线 */
  aiEnabled: boolean;
  billingEnabled: boolean;
  /** Stripe 最小货币单位，例如 USD cents */
  priceAmount: number;
  priceCurrency: string;
  prices: Array<{
    /** Stripe 最小货币单位；JPY 等零小数货币直接使用整数金额 */
    amount: number;
    currency: string;
  }>;
};

export type BillingPricing = {
  billingEnabled: boolean;
  creditPurchaseEnabled?: boolean;
  freeStorageQuotaBytes: number;
  lifetimeStorageQuotaBytes: number;
  prices: MembershipStatus["prices"];
  creditPacks?: AgentCreditPack[];
};

export function getBillingPricing() {
  return apiJson<{ pricing: BillingPricing }>("/api/billing/pricing");
}

export function getMembershipStatus() {
  return apiJson<{ membership: MembershipStatus }>("/api/billing/status");
}

// ---------- 邀请奖励 ----------

export type InvitationOverview = {
  invitationCode: string;
  successfulInvites: number;
  rewardPerInviteBytes: number;
  maxBonusStorageBytes: number;
  earnedStorageBytes: number;
  /** 包含自己受邀注册所得与邀请他人所得的全部永久奖励空间 */
  bonusStorageBytes: number;
};

export function getInvitationOverview() {
  return apiJson<InvitationOverview>("/api/invitations");
}

// ---------- 用户反馈 ----------

export type FeedbackCategory = "bug" | "experience";

export type FeedbackSubmission = {
  id: number;
  category: FeedbackCategory;
  message: string;
  pagePath: string;
  client: "web" | "desktop";
  createdAt: string;
};

export function submitFeedback(input: {
  category: FeedbackCategory;
  message: string;
  pagePath: string;
}) {
  return apiJson<{ feedback: FeedbackSubmission }>("/api/feedback", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function createMembershipCheckout(currency: string) {
  return apiJson<{ sessionId: string; url: string }>("/api/billing/checkout", {
    method: "POST",
    body: JSON.stringify({
      currency,
      client: isDesktopRuntime() ? "desktop" : "web",
    }),
  });
}

export function confirmMembershipCheckout(sessionId: string) {
  return apiJson<{
    status: "active" | "pending";
    membership?: MembershipStatus;
    user?: User;
  }>("/api/billing/checkout/confirm", {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

// ---------- AI 优化 ----------

export type AgentCreditPack = {
  code: "credits_3000" | "credits_10000" | "credits_30000";
  credits: number;
  /** 旧客户端默认使用的 USD 价格，Stripe 最小货币单位 */
  amount: number;
  currency: string;
  /** 与会员购买一致的可选币种价格；旧后端响应可能暂时缺少此字段 */
  prices?: MembershipStatus["prices"];
};

export type AgentCreditTransaction = {
  entryId: string;
  kind:
    "membership_grant" | "purchase" | "agent_usage" | "adjustment" | "refund";
  amount: number;
  balanceAfter: number;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type AgentCredits = {
  balance: number;
  reserved: number;
  available: number;
  tokensPerCredit: number;
  builtinEnabled: boolean;
  purchaseEnabled: boolean;
  packs: AgentCreditPack[];
  transactions: AgentCreditTransaction[];
};

export const AGENT_CREDITS_QUERY_KEY = ["agent-credits"] as const;

export function getAgentCredits() {
  return apiJson<{ credits: AgentCredits }>("/api/agent/credits");
}

export function createAgentCreditsCheckout(
  packCode: AgentCreditPack["code"],
  currency: string,
) {
  return apiJson<{ sessionId: string; url: string }>(
    "/api/agent/credits/checkout",
    {
    method: "POST",
    body: JSON.stringify({
      packCode,
      currency,
      client: isDesktopRuntime() ? "desktop" : "web",
    }),
    },
  );
}

export function confirmAgentCreditsCheckout(sessionId: string) {
  return apiJson<{
    status: "active" | "pending";
    credits?: Pick<AgentCredits, "balance" | "reserved" | "available">;
  }>("/api/agent/credits/checkout/confirm", {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

export type LLMChannel = {
  channelId: string;
  name: string;
  protocol: "openai" | "anthropic";
  baseUrl: string;
  model: string;
  apiKeyHint: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

export type LLMChannelInput = {
  name: string;
  protocol: LLMChannel["protocol"];
  baseUrl: string;
  model: string;
  apiKey?: string;
  isDefault: boolean;
};

export const LLM_CHANNELS_QUERY_KEY = ["llm-channels"] as const;

export type AgentSettings = {
  providerMode: "builtin" | "byok";
  defaultChannel?: Pick<LLMChannel, "channelId" | "name" | "model"> | null;
};

export const AGENT_SETTINGS_QUERY_KEY = ["agent-settings"] as const;

export function getAgentSettings() {
  return apiJson<{ settings: AgentSettings }>("/api/agent/settings");
}

export function updateAgentSettings(
  providerMode: AgentSettings["providerMode"],
) {
  return apiJson<{ settings: AgentSettings }>("/api/agent/settings", {
    method: "PUT",
    body: JSON.stringify({ providerMode }),
  });
}

export function listLLMChannels() {
  return apiJson<{ channels: LLMChannel[] }>("/api/agent/channels");
}

export function createLLMChannel(input: LLMChannelInput) {
  return apiJson<{ channel: LLMChannel }>("/api/agent/channels", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateLLMChannel(channelId: string, input: LLMChannelInput) {
  return apiJson<{ channel: LLMChannel }>(
    `/api/agent/channels/${encodeURIComponent(channelId)}`,
    { method: "PUT", body: JSON.stringify(input) },
  );
}

export function deleteLLMChannel(channelId: string) {
  return apiJson<{ success: boolean }>(
    `/api/agent/channels/${encodeURIComponent(channelId)}`,
    { method: "DELETE" },
  );
}

export type WechatGeoSummary = {
  text: string;
  summary: string;
  topics: string[];
  keywords: string[];
  sourceHash: string;
  enabled: boolean;
  providerMode: "builtin" | "byok";
  model: string;
  creditsCharged: number;
  updatedAt: string;
};

export function getWechatGeoSummary(docId: string) {
  return apiJson<{ geo: WechatGeoSummary | null }>(
    `/api/documents/${encodeURIComponent(docId)}/wechat-geo-summary`,
  );
}

export function generateWechatGeoSummary(
  docId: string,
  title: string,
  content: string,
  signal?: AbortSignal,
) {
  return apiJson<{ geo: WechatGeoSummary }>(
    `/api/documents/${encodeURIComponent(docId)}/wechat-geo-summary/generate`,
    {
      method: "POST",
      body: JSON.stringify({ title, content }),
      signal,
    },
  );
}

export function updateWechatGeoSummary(
  docId: string,
  changes: { text?: string; enabled?: boolean },
) {
  return apiJson<{ geo: WechatGeoSummary }>(
    `/api/documents/${encodeURIComponent(docId)}/wechat-geo-summary`,
    {
      method: "PUT",
      body: JSON.stringify(changes),
    },
  );
}

export type AgentReviewSuggestion = {
  suggestionId: string;
  ordinal: number;
  target: "title" | "body";
  kind: "content" | "layout";
  category: string;
  operation:
    | "change_block_type"
    | "split_paragraph"
    | "convert_to_list"
    | "emphasize_block"
    | "insert_divider"
    | null;
  before: string;
  after: string;
  reason: string;
  status: "pending" | "applied" | "dismissed";
  appliedAt?: string | null;
};

export type AgentReviewLayoutAssessment = {
  id:
    "hierarchy" | "readability" | "emphasis" | "rhythm" | "modules" | "mobile";
  label: string;
  score: number;
  summary: string;
};

export type AgentReviewTaskProgress = {
  mode?: "standard" | "deep";
  focusDimension?: AgentReviewLayoutAssessment["id"] | null;
  completedTasks: number;
  totalTasks: number;
  stages: Array<{
    id: "title" | "document" | "body" | "layout";
    status: "pending" | "running" | "completed" | "failed";
    completedTasks: number;
    totalTasks: number;
    durationMs: number;
  }>;
};

export type AgentReviewCreateInput = {
  depth?: "deep";
  focusDimension?: AgentReviewLayoutAssessment["id"];
  sourceReviewId?: string;
};

export type AgentReview = {
  reviewId: string;
  documentId: string;
  baseRevision: number;
  currentRevision: number;
  documentRevision: number;
  providerMode: "builtin" | "byok";
  providerProtocol: "openai" | "anthropic";
  channelId?: string | null;
  model: string;
  status:
    | "running"
    | "ready"
    | "partially_applied"
    | "applied"
    | "dismissed"
    | "failed"
    | "stale";
  summary?: string | null;
  titleScore?: number | null;
  titleAssessment?: string | null;
  layoutAssessment: AgentReviewLayoutAssessment[];
  taskProgress: AgentReviewTaskProgress;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  creditsCharged: number;
  errorCode?: string | null;
  createdAt: string;
  completedAt?: string | null;
  updatedAt: string;
  suggestions?: AgentReviewSuggestion[];
};

export function createAgentReview(
  docId: string,
  input: AgentReviewCreateInput = {},
) {
  return apiJson<{ review: AgentReview }>(
    `/api/documents/${encodeURIComponent(docId)}/agent-reviews`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function listAgentReviews(docId: string) {
  return apiJson<{ reviews: AgentReview[] }>(
    `/api/documents/${encodeURIComponent(docId)}/agent-reviews`,
  );
}

export function getAgentReview(reviewId: string) {
  return apiJson<{ review: AgentReview }>(
    `/api/agent/reviews/${encodeURIComponent(reviewId)}`,
  );
}

export type AgentReviewMutation = {
  review: AgentReview;
  document: Document;
};

async function reconcileDesktopAgentReviewMutation(
  result: AgentReviewMutation,
): Promise<AgentReviewMutation> {
  if (!isDesktopRuntime()) return result;
  const { desktopAcceptRemoteDocumentMutation } =
    await import("./desktop/offlineStore");
  const accepted = await desktopAcceptRemoteDocumentMutation(result.document);
  return { ...result, document: accepted.document };
}

export async function applyAgentReviewSuggestion(
  reviewId: string,
  suggestionId: string,
  expectedRevision: number,
) {
  const result = await apiJson<AgentReviewMutation>(
    `/api/agent/reviews/${encodeURIComponent(reviewId)}/suggestions/${encodeURIComponent(suggestionId)}/apply`,
    { method: "POST", body: JSON.stringify({ expectedRevision }) },
  );
  return reconcileDesktopAgentReviewMutation(result);
}

export function dismissAgentReviewSuggestion(
  reviewId: string,
  suggestionId: string,
) {
  return apiJson<{ review: AgentReview }>(
    `/api/agent/reviews/${encodeURIComponent(reviewId)}/suggestions/${encodeURIComponent(suggestionId)}/dismiss`,
    { method: "POST" },
  );
}

export async function applyAllAgentReviewSuggestions(
  reviewId: string,
  expectedRevision: number,
) {
  const result = await apiJson<AgentReviewMutation>(
    `/api/agent/reviews/${encodeURIComponent(reviewId)}/apply-all`,
    { method: "POST", body: JSON.stringify({ expectedRevision }) },
  );
  return reconcileDesktopAgentReviewMutation(result);
}

export function dismissAgentReview(reviewId: string) {
  return apiJson<{ review: AgentReview }>(
    `/api/agent/reviews/${encodeURIComponent(reviewId)}/dismiss`,
    { method: "POST" },
  );
}

// ---------- 管理后台 ----------

export type AdminStats = {
  generatedAt: string;
  timeZone: string;
  overview: {
    users: number;
    verifiedUsers: number;
    members: number;
    documents: number;
    images: number;
    documentBytes: number;
    imageBytes: number;
    orders: number;
    todayNewUsers: number;
    todayNewMembers: number;
    todayOrders: number;
  };
  revenue: Array<{
    currency: string;
    totalAmount: number;
    totalOrders: number;
    todayAmount: number;
    todayOrders: number;
  }>;
  trend: Array<{
    date: string;
    newUsers: number;
    newMembers: number;
    orders: number;
  }>;
  recentUsers: Array<{
    id: number;
    name: string;
    email: string;
    isVerified: boolean;
    membershipTier: "free" | "lifetime";
    createdAt: string;
    lastClient: "web" | "desktop" | null;
    lastClientAt: string | null;
  }>;
  recentPayments: Array<{
    userName: string | null;
    userEmail: string | null;
    amount: number;
    currency: string;
    createdAt: string;
  }>;
  traffic: {
    available: boolean;
    reason?: "not_configured" | "upstream_error";
    pageViews: number;
    uniqueVisitors: number;
    requests: number;
    bytes: number;
    from: string;
    to: string;
  };
  funnel: {
    registered: number;
    firstDocument: number;
    firstUpload: number;
    firstExport: number;
    mcpConnected: number;
    checkoutStarted: number;
    checkoutCompleted: number;
  };
  retention: {
    trackingStartedAt: string;
    day1: { eligible: number; returned: number };
    day7: { eligible: number; returned: number };
    day30: { eligible: number; returned: number };
  };
};

export function getAdminStats() {
  return apiJson<AdminStats>("/api/admin/stats");
}

export type AdminFeedback = {
  id: number;
  userId: number | null;
  userName: string | null;
  userEmail: string | null;
  category: FeedbackCategory;
  message: string;
  pagePath: string;
  client: "web" | "desktop";
  userAgent: string;
  createdAt: string;
};

export type AdminFeedbackPage = {
  feedback: AdminFeedback[];
  nextCursor: number | null;
};

export function getAdminFeedback(before: number | null = null, limit = 50) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before != null) params.set("before", String(before));
  return apiJson<AdminFeedbackPage>(`/api/admin/feedback?${params}`);
}

export type AdminServerStatus = {
  available: boolean;
  generatedAt: string;
  uptimeSeconds: number;
  cpu: {
    usagePercent: number | null;
    logicalCPUs: number;
    load1: number;
    load5: number;
    load15: number;
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    swapTotalBytes: number;
    swapUsedBytes: number;
  };
  disk: {
    available: boolean;
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
  };
  network: {
    available: boolean;
    interfaceName: string;
    receiveBytes: number;
    transmitBytes: number;
    receiveBytesPerSecond: number | null;
    transmitBytesPerSecond: number | null;
  };
};

export function getAdminServerStatus() {
  return apiJson<AdminServerStatus>("/api/admin/server-status");
}

export type AnnouncementTranslation = {
  title: string;
  summary: string;
  highlights: string[];
};

export type Announcement = {
  id: number;
  kind: "release" | "manual";
  version: string | null;
  publishedAt: string;
  translation: AnnouncementTranslation;
};

export type AdminAnnouncement = Omit<Announcement, "translation"> & {
  createdBy: string | null;
  createdAt: string;
  withdrawnAt: string | null;
  translations: Record<string, AnnouncementTranslation>;
};

export function getUnreadAnnouncements(locale: string) {
  return apiJson<{ announcements: Announcement[] }>(
    `/api/announcements/unread?locale=${encodeURIComponent(locale)}`,
  );
}

export function withdrawAdminAnnouncement(announcementId: number) {
  return apiJson<{ success: boolean }>(
    `/api/admin/announcements/${announcementId}`,
    { method: "DELETE" },
  );
}

export function markAnnouncementRead(announcementId: number) {
  return apiJson<{ success: boolean }>(
    `/api/announcements/${announcementId}/read`,
    { method: "POST" },
  );
}

export function getAdminAnnouncements() {
  return apiJson<{
    announcements: AdminAnnouncement[];
    translationEnabled: boolean;
  }>("/api/admin/announcements");
}

export function publishAdminAnnouncement(input: {
  sourceLocale: string;
  translation: AnnouncementTranslation;
}) {
  return apiJson<{ announcement: AdminAnnouncement }>(
    "/api/admin/announcements",
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function trackProductEvent(event: "first_export") {
  return apiJson<{ success: boolean }>("/api/analytics/events", {
    method: "POST",
    body: JSON.stringify({ event }),
  });
}

// ---------- 文档 ----------

// 曾有第三档 "public"，与 "link" 行为完全相同，已删。
// 存量数据由后端 normalizeShareAccess 归一成 "link"，前端不必再认它。
export type ShareAccess = "link" | "password";

export type DocumentShare = {
  token: string;
  access: ShareAccess;
  requiresPassword: boolean;
  /** 后端因放宽权限换了新 token，老链接已失效 —— 需要提示用户重新分享 */
  tokenRotated?: boolean;
  viewCount: number;
};

export type Document = {
  docId: string;
  title: string;
  /** 微信排版主题 id，空串表示不套主题 */
  theme: string;
  content: string;
  revision: number;
  createdAt?: string | null;
  updatedAt?: string | null;
  /** null 表示未分享 */
  share?: DocumentShare | null;
};

/** 公开分享视图：不含任何内部标识 */
export type SharedDocument = {
  title: string;
  theme?: string;
  content: string;
  updatedAt?: string | null;
  ownerName?: string;
  viewCount: number;
};

// 列表接口不返回 content，只够侧边栏渲染
export type DocumentSummary = {
  docId: string;
  title: string;
  /** null 表示在根下 */
  folderId: string | null;
  revision: number;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type TrashedDocumentSummary = {
  docId: string;
  title: string;
  revision: number;
  trashedAt: string;
  deletesAt: string;
};

export function listDocuments() {
  if (isDesktopRuntime()) {
    return import("./desktop/offlineStore").then(({ desktopListDocuments }) =>
      desktopListDocuments(),
    );
  }
  return apiJson<{ documents: DocumentSummary[] }>("/api/documents");
}

export type DocumentSearchResult = {
  docId: string;
  title: string;
  snippet: string;
  titleMatched: boolean;
  contentMatched: boolean;
  revision: number;
  updatedAt?: string | null;
};

export function searchDocuments(query: string, limit = 20) {
  if (isDesktopRuntime()) {
    return import("./desktop/offlineStore").then(({ desktopSearchDocuments }) =>
      desktopSearchDocuments(query, limit),
    );
  }
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return apiJson<{ results: DocumentSearchResult[] }>(
    `/api/documents/search?${params.toString()}`,
  );
}

export function createDocument(params?: {
  title?: string;
  content?: string;
  /** 直接建在这个文件夹里。省掉「建到根下再移动」那一步的闪烁 */
  folderId?: string | null;
}) {
  if (isDesktopRuntime()) {
    return import("./desktop/offlineStore").then(({ desktopCreateDocument }) =>
      desktopCreateDocument(params),
    );
  }
  return apiJson<{ document: Document }>("/api/documents", {
    method: "POST",
    body: JSON.stringify(params ?? {}),
  });
}

export function getDocument(docId: string) {
  if (isDesktopRuntime()) {
    return import("./desktop/offlineStore").then(({ desktopGetDocument }) =>
      desktopGetDocument(docId),
    );
  }
  return apiJson<{ document: Document }>(
    `/api/documents/${encodeURIComponent(docId)}`,
  );
}

export function updateDocument(
  docId: string,
  params: {
    title: string;
    content: string;
    theme?: string;
    expectedRevision: number;
    forceVersion?: boolean;
  },
) {
  if (isDesktopRuntime()) {
    return import("./desktop/offlineStore").then(({ desktopUpdateDocument }) =>
      desktopUpdateDocument(docId, params),
    );
  }
  return apiJson<{ document: Document }>(
    `/api/documents/${encodeURIComponent(docId)}`,
    { method: "PUT", body: JSON.stringify(params) },
  );
}

export type DocumentVersion = {
  revision: number;
  title: string;
  theme: string;
  content?: string;
  source: "web" | "mcp" | "restore";
  safetySnapshot: boolean;
  createdAt?: string | null;
};

export function listDocumentVersions(docId: string) {
  return apiJson<{ versions: DocumentVersion[] }>(
    `/api/documents/${encodeURIComponent(docId)}/versions`,
  );
}

export function getDocumentVersion(docId: string, revision: number) {
  return apiJson<{ version: DocumentVersion }>(
    `/api/documents/${encodeURIComponent(docId)}/versions/${revision}`,
  );
}

export function restoreDocumentVersion(
  docId: string,
  revision: number,
  expectedRevision: number,
) {
  return apiJson<{ document: Document }>(
    `/api/documents/${encodeURIComponent(docId)}/versions/${revision}/restore`,
    { method: "POST", body: JSON.stringify({ expectedRevision }) },
  );
}

export type MCPToken = {
  tokenId: string;
  name: string;
  hint: string;
  scope: "read" | "write";
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  createdAt?: string | null;
  revealable: boolean;
};

export function listMCPTokens() {
  return apiJson<{ tokens: MCPToken[] }>("/api/mcp/tokens");
}

export function createMCPToken(params: {
  name: string;
  scope: "read" | "write";
  expiresInDays?: number;
  neverExpires?: boolean;
}) {
  return apiJson<{ token: MCPToken; secret: string }>("/api/mcp/tokens", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function updateMCPTokenExpiry(
  tokenId: string,
  params: { expiresInDays?: number; neverExpires?: boolean },
) {
  return apiJson<{ token: MCPToken }>(
    `/api/mcp/tokens/${encodeURIComponent(tokenId)}`,
    { method: "PATCH", body: JSON.stringify(params) },
  );
}

export function revealMCPToken(tokenId: string) {
  return apiJson<{ secret: string }>(
    `/api/mcp/tokens/${encodeURIComponent(tokenId)}/reveal`,
    { method: "POST" },
  );
}

export function revokeMCPToken(tokenId: string) {
  return apiJson<{ success: boolean }>(
    `/api/mcp/tokens/${encodeURIComponent(tokenId)}`,
    { method: "DELETE" },
  );
}

export type MCPActivity = {
  id: number;
  toolName: string;
  result: "success" | "error";
  durationMs: number;
  createdAt?: string | null;
  docId?: string | null;
  documentTitle?: string | null;
  tokenName?: string | null;
  tokenHint?: string | null;
};

export function listMCPActivity(cursor?: string, limit = 50) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set("cursor", cursor);
  return apiJson<{ activities: MCPActivity[]; nextCursor: string }>(
    `/api/mcp/activity?${query.toString()}`,
  );
}

// ---------- 文件夹 ----------

export type Folder = {
  folderId: string;
  name: string;
  /** null 表示在根下 */
  parentFolderId: string | null;
  /** null 表示用户手动创建或导入的目录。 */
  organizerKind: "smart" | "activity" | null;
};

export function listFolders() {
  if (isDesktopRuntime()) {
    return import("./desktop/offlineStore").then(({ desktopListFolders }) =>
      desktopListFolders(),
    );
  }
  return apiJson<{ folders: Folder[] }>("/api/folders");
}

export function createFolder(params: {
  name: string;
  parentFolderId: string | null;
  organizerKind?: Folder["organizerKind"];
}) {
  if (isDesktopRuntime()) {
    return import("./desktop/offlineStore").then(({ desktopCreateFolder }) =>
      desktopCreateFolder(params),
    );
  }
  return apiJson<{ folder: Folder }>("/api/folders", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function deleteEmptyOrganizerFolder(folderId: string) {
  if (isDesktopRuntime()) {
    return import("./desktop/offlineStore").then(
      ({ desktopDeleteEmptyOrganizerFolder }) =>
        desktopDeleteEmptyOrganizerFolder(folderId),
    );
  }
  return apiJson<{ deleted: boolean }>(
    `/api/folders/${encodeURIComponent(folderId)}/empty`,
    { method: "DELETE" },
  );
}

export function renameFolder(folderId: string, name: string) {
  if (isDesktopRuntime()) {
    return import("./desktop/offlineStore").then(({ desktopRenameFolder }) =>
      desktopRenameFolder(folderId, name),
    );
  }
  return apiJson<{ folder: Folder }>(
    `/api/folders/${encodeURIComponent(folderId)}`,
    { method: "PUT", body: JSON.stringify({ name }) },
  );
}

export function deleteFolder(folderId: string) {
  if (isDesktopRuntime()) {
    return import("./desktop/offlineStore").then(({ desktopDeleteFolder }) =>
      desktopDeleteFolder(folderId),
    );
  }
  return apiJson<{ ok: boolean }>(
    `/api/folders/${encodeURIComponent(folderId)}`,
    { method: "DELETE" },
  );
}

export function moveFolder(folderId: string, parentFolderId: string | null) {
  if (isDesktopRuntime()) {
    return import("./desktop/offlineStore").then(({ desktopMoveFolder }) =>
      desktopMoveFolder(folderId, parentFolderId),
    );
  }
  return apiJson<{ ok: boolean }>(
    `/api/folders/${encodeURIComponent(folderId)}/parent`,
    { method: "PUT", body: JSON.stringify({ parentFolderId }) },
  );
}

export function moveDocument(docId: string, folderId: string | null) {
  if (isDesktopRuntime()) {
    return import("./desktop/offlineStore").then(({ desktopMoveDocument }) =>
      desktopMoveDocument(docId, folderId),
    );
  }
  return apiJson<{ ok: boolean }>(
    `/api/documents/${encodeURIComponent(docId)}/folder`,
    { method: "PUT", body: JSON.stringify({ folderId }) },
  );
}

// ---------- 编辑器标签页 ----------

export type EditorTabs = {
  tabs: string[];
  /** null 表示一个都没打开 */
  activeDocId: string | null;
};

export function getEditorTabs() {
  if (isDesktopRuntime()) {
    return import("./desktop/offlineStore").then(({ desktopGetEditorTabs }) =>
      desktopGetEditorTabs(),
    );
  }
  return apiJson<EditorTabs>("/api/editor/tabs");
}

export function putEditorTabs(params: EditorTabs) {
  if (isDesktopRuntime()) {
    return import("./desktop/offlineStore").then(({ desktopPutEditorTabs }) =>
      desktopPutEditorTabs(params),
    );
  }
  return apiJson<EditorTabs>("/api/editor/tabs", {
    method: "PUT",
    body: JSON.stringify(params),
  });
}

// ---------- 分享 ----------

export async function createShare(
  docId: string,
  params: { access: ShareAccess; password?: string },
) {
  const desktopStore = isDesktopRuntime()
    ? await import("./desktop/offlineStore")
    : null;
  if (
    desktopStore &&
    !(await desktopStore.desktopPrepareDocumentForRemoteMutation(docId))
  ) {
    throw new ApiError(
      409,
      "Document must finish syncing before it can be shared",
      "desktop_share_sync_required",
    );
  }
  const result = await apiJson<{ share: DocumentShare }>(
    `/api/documents/${encodeURIComponent(docId)}/share`,
    { method: "POST", body: JSON.stringify(params) },
  );
  if (desktopStore) {
    await desktopStore
      .desktopAcceptDocumentShare(docId, result.share)
      .catch((error) => {
        console.warn("Desktop share state could not be cached", error);
        void desktopStore
          .desktopReportSyncError("desktop_share_cache_failed")
          .catch((reportError) =>
            console.warn(
              "Desktop share cache failure could not be reported",
              reportError,
            ),
        );
      });
  }
  return result;
}

export async function revokeShare(docId: string) {
  const desktopStore = isDesktopRuntime()
    ? await import("./desktop/offlineStore")
    : null;
  if (
    desktopStore &&
    !(await desktopStore.desktopPrepareDocumentForRemoteMutation(docId))
  ) {
    throw new ApiError(
      409,
      "Document must finish syncing before sharing can be changed",
      "desktop_share_sync_required",
    );
  }
  const result = await apiJson<{ success: boolean }>(
    `/api/documents/${encodeURIComponent(docId)}/share`,
    { method: "DELETE" },
  );
  if (desktopStore) {
    await desktopStore
      .desktopAcceptDocumentShare(docId, null)
      .catch((error) => {
      console.warn("Desktop share state could not be cleared", error);
        void desktopStore
          .desktopReportSyncError("desktop_share_cache_failed")
          .catch((reportError) =>
          console.warn(
            "Desktop share cache failure could not be reported",
            reportError,
          ),
      );
    });
  }
  return result;
}

/** 公开读取。口令档时返回 { requiresPassword: true }，不含正文。 */
export function getSharedDocument(token: string) {
  return apiJson<{ document?: SharedDocument; requiresPassword?: boolean }>(
    `/api/share/${encodeURIComponent(token)}`,
  );
}

export function verifySharePassword(token: string, password: string) {
  return apiJson<{ document: SharedDocument }>(
    `/api/share/${encodeURIComponent(token)}/verify`,
    { method: "POST", body: JSON.stringify({ password }) },
  );
}

// ---------- 图片 ----------

export type UploadedImage = {
  key: string;
  url: string;
  size: number;
  contentType: string;
  flattenedAnimation?: boolean;
};

// Worker 侧按 magic byte 校验真实类型，允许的集合与之保持一致
const UPLOADABLE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

export function isUploadableImage(file: File): boolean {
  return UPLOADABLE_TYPES.has(file.type);
}

/**
 * 上传图片到 R2（由 Worker 处理，不经过 Go 后端）。
 *
 * 直接发原始字节而非 FormData：Worker 读的是 request.arrayBuffer()，
 * multipart 的分隔符会混进字节流，导致文件头校验失败。
 * 也因此不能复用 apiJson —— 它会强制 Content-Type: application/json，
 * 而 Worker 要拿这个头与真实文件头比对。
 */
export type ImageUploadPurpose = "persistent" | "wechat-export";

export async function uploadImage(
  file: File,
  purpose: ImageUploadPurpose = "persistent",
): Promise<UploadedImage> {
  if (!isUploadableImage(file)) {
    // 前端先挡一道：服务端也会拒，但等一趟往返才报错体验更差
    throw new ApiError(415, "Unsupported image type", "image_type_unsupported");
  }
  if (isDesktopRuntime() && purpose === "persistent") {
    try {
      let localFile = file;
      let flattenedAnimation = false;
      if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
        const { prepareImportedImage } =
          await import("./importImageCompression");
        const prepared = await prepareImportedImage(file);
        localFile = prepared.file;
        flattenedAnimation = prepared.flattenedAnimation;
      }
      const { desktopStoreLocalImage } = await import("./desktop/offlineStore");
      return {
        ...(await desktopStoreLocalImage(localFile)),
        ...(flattenedAnimation ? { flattenedAnimation: true } : {}),
      };
    } catch (error) {
      if (error instanceof Error && error.message === "image_too_large") {
        throw new ApiError(413, "Image is too large", "image_too_large");
      }
      throw error;
    }
  }

  const response = await fetchAppResource("/api/images", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": file.type,
      "X-Koinote-Image-Purpose": purpose,
    },
    body: file,
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  const data = (await response.json()) as { image: UploadedImage };
  return data.image;
}

/**
 * 让服务端代抓一个外链图片并转存进图床。
 *
 * 为什么不在前端抓：浏览器受 CORS 限制读不到跨站图片的字节。<img> 能显示它，但
 * canvas/fetch 拿不到内容，所以「粘贴网页里的图并转存」只能由服务端代抓。
 *
 * 服务端那侧是个 SSRF 原语，防护见 worker/ssrf.ts。
 */
export async function fetchImageToBucket(url: string) {
  const result = await apiJson<{ image: UploadedImage }>("/api/images/fetch", {
    method: "POST",
    body: JSON.stringify({ url }),
  });
  if (isDesktopRuntime()) {
    const { desktopCacheRemoteImage } = await import("./desktop/offlineStore");
    await desktopCacheRemoteImage(result.image.url).catch(() => undefined);
  }
  return result;
}

/**
 * 云端存储用量。配额的真值在后端，前端不写死。
 *
 * 分项给出是因为用户看到"满了"之后要知道该删什么 —— 只报总数的话，
 * 一个存了 400 MB 图片的人可能会去删文档，白费功夫。
 */
export type StorageUsage = {
  /** 总量，等于 documentBytes + imageBytes */
  usedBytes: number;
  /** 文档正文与标题（Postgres） */
  documentBytes: number;
  /** 图床对象（R2） */
  imageBytes: number;
  quotaBytes: number;
};

/**
 * 查当前用户的云端存储用量。
 *
 * 路径是 /api/storage/usage 而不是 /api/images/usage：Worker 对 /api/images/ 下的
 * 若干路径有专门分派，加一个同前缀的路由要改两处，容易漏。
 */
export function getStorageUsage() {
  return apiJson<StorageUsage>("/api/storage/usage");
}

export async function releaseUnusedImages(keys: string[]) {
  if (keys.length === 0) return Promise.resolve({ queued: 0 });
  let remoteKeys = keys;
  if (isDesktopRuntime()) {
    const localKeys = keys.filter((key) =>
      key.startsWith("koinote-local-image://"),
    );
    remoteKeys = keys.filter(
      (key) => !key.startsWith("koinote-local-image://"),
    );
    if (localKeys.length > 0) {
      const { desktopReleaseUnusedImages } =
        await import("./desktop/offlineStore");
      await desktopReleaseUnusedImages(localKeys);
    }
    const { isDesktopLocalModeSelected } = await import("./desktop/localMode");
    if (isDesktopLocalModeSelected()) return { queued: 0 };
  }
  if (remoteKeys.length === 0) return { queued: 0 };
  return apiJson<{ queued: number }>("/api/storage/release-images", {
    method: "POST",
    body: JSON.stringify({ keys: remoteKeys }),
  });
}

export function trashDocument(docId: string) {
  if (isDesktopRuntime()) {
    return import("./desktop/offlineStore").then(({ desktopTrashDocument }) =>
      desktopTrashDocument(docId),
    );
  }
  return apiJson<{ success: boolean }>(
    `/api/documents/${encodeURIComponent(docId)}`,
    { method: "DELETE" },
  );
}

export function listTrashedDocuments() {
  if (isDesktopRuntime()) {
    return import("./desktop/localMode").then(
      ({ isDesktopLocalModeSelected }) =>
      isDesktopLocalModeSelected()
        ? import("./desktop/offlineStore").then(
            ({ desktopListLocalTrashedDocuments }) =>
              desktopListLocalTrashedDocuments(),
          )
        : apiJson<{ documents: TrashedDocumentSummary[] }>(
            "/api/documents/trash",
          ),
    );
  }
  return apiJson<{ documents: TrashedDocumentSummary[] }>(
    "/api/documents/trash",
  );
}

export function restoreTrashedDocument(docId: string) {
  if (isDesktopRuntime()) {
    return import("./desktop/localMode").then(
      ({ isDesktopLocalModeSelected }) =>
      isDesktopLocalModeSelected()
        ? import("./desktop/offlineStore").then(
            ({ desktopRestoreLocalTrashedDocument }) =>
              desktopRestoreLocalTrashedDocument(docId),
          )
        : apiJson<{ document: Document }>(
            `/api/documents/${encodeURIComponent(docId)}/restore`,
            { method: "POST" },
          ),
    );
  }
  return apiJson<{ document: Document }>(
    `/api/documents/${encodeURIComponent(docId)}/restore`,
    { method: "POST" },
  );
}

export function permanentlyDeleteDocument(docId: string, confirmation: string) {
  if (isDesktopRuntime()) {
    return import("./desktop/offlineStore").then(
      ({ desktopPermanentlyDeleteDocument }) =>
        desktopPermanentlyDeleteDocument(docId, confirmation),
    );
  }
  return apiJson<{ success: boolean }>(
    `/api/documents/${encodeURIComponent(docId)}/permanent`,
    { method: "DELETE", body: JSON.stringify({ confirmation }) },
  );
}
