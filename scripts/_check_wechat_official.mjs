import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
let passed = 0;

function ok(label, condition) {
  if (!condition) throw new Error(`微信公众号草稿门禁失败：${label}`);
  passed += 1;
}

const api = read("spa/src/api.ts");
const dialog = read("spa/src/components/editor/WechatDialog.tsx");
const panel = read("spa/src/components/editor/WechatOfficialAccountPanel.tsx");
const draftPanel = read("spa/src/components/editor/WechatDraftPanel.tsx");
const coverGenerator = read("spa/src/components/editor/wechatCover.ts");
const exportMenu = read("spa/src/components/editor/ExportMenu.tsx");
const settings = read("spa/src/pages/SettingsPage.tsx");
const main = read("spa/src/main.tsx");
const desktopAuth = read("backend/internal/server/desktop_auth.go");
const routes = read("backend/internal/server/server.go");
const admin = read("backend/internal/server/admin.go");
const account = read("backend/internal/server/wechat_official_account.go");
const publish = read("backend/internal/server/wechat_official_publish.go");
const config = read("backend/internal/config/config.go");
const deploy = read(".github/workflows/deploy.yml");
const proxyService = read(
  "deploy/wechat-proxy/koinote-wechat-proxy.service",
);
const proxySource = read("deploy/wechat-proxy/main.go");
const initialMigration = read(
  "backend/migrations/0039_wechat_official_accounts.sql",
);
const multiAccountMigration = read(
  "backend/migrations/0040_wechat_official_multi_accounts.sql",
);

for (const endpoint of [
  "/api/wechat/account",
  "/api/wechat/accounts",
  "/api/wechat/cover/generate",
  "/wechat-draft",
]) {
  const desktopNeedle =
    endpoint === "/wechat-draft" ? 'case "wechat-draft"' : endpoint;
  ok(`前端 API 接入 ${endpoint}`, api.includes(endpoint));
  ok(`后端路由接入 ${endpoint}`, routes.includes(endpoint));
  ok(`桌面鉴权允许 ${endpoint}`, desktopAuth.includes(desktopNeedle));
}

ok(
  "草稿同步入口支持网页和桌面运行时",
  !exportMenu.includes("isDesktopRuntime()") &&
    exportMenu.includes("onOpenWechatDraft") &&
    dialog.includes("onOpenWechatDraft") &&
    dialog.includes('platform === "wechat"'),
);
ok(
  "桌面草稿同步前等待文档进入云端",
  /export async function prepareWechatDraftDocument[\s\S]{0,700}desktopPrepareDocumentForRemoteMutation\(docId\)[\s\S]{0,260}desktop_wechat_sync_required/.test(
    api,
  ) &&
    /export async function createWechatDraft[\s\S]{0,500}await prepareWechatDraftDocument\(docId\)/.test(
      api,
    ) &&
    exportMenu.includes("await prepareWechatDraftDocument(docId)"),
);
ok(
  "草稿面板支持网页和桌面运行时",
  !dialog.includes("isDesktopRuntime()") &&
    dialog.includes("<WechatDraftPanel") &&
    /draftOnly\s*&&\s*platform === "wechat"\s*&&\s*!localMode\s*&&\s*member\s*&&/.test(
      dialog,
    ),
);
ok(
  "公众号能力只对付费会员显示",
  /!localMode\s*&&\s*member/.test(dialog) &&
    panel.includes("if (!member)") &&
    !dialog.includes("isAdmin") &&
    !panel.includes("isAdmin") &&
    !draftPanel.includes("isAdmin") &&
    !exportMenu.includes("isAdmin"),
);
ok(
  "后端公众号账号接口需要付费会员",
  admin.includes("requireWechatMember") &&
    !admin.includes("requireWechatAdminMember") &&
    (account.match(/requireWechatMember/g) || []).length === 8,
);
ok(
  "后端封面和草稿接口需要付费会员",
  (publish.match(/requireWechatMember/g) || []).length === 2 &&
    !publish.includes("requireWechatAdminMember"),
);
ok(
  "账号绑定位于设置页",
  settings.includes("WechatOfficialAccountPanel") &&
    main.includes('section === "wechat"'),
);
ok(
  "未绑定时跳转公众号设置",
  exportMenu.includes('search: { section: "wechat" }'),
);
ok("免费用户推送入口跳转会员页", exportMenu.includes('to: "/pricing"'));
ok(
  "设置页支持最多 5 个公众号",
  panel.includes("createWechatOfficialAccount") &&
    panel.includes("deleteWechatOfficialAccountById") &&
    panel.includes("setDefaultWechatOfficialAccount") &&
    panel.includes("accounts.length >= maxCount") &&
    account.includes("wechatOfficialAccountMaxCount = 5"),
);
ok(
  "只修改账号备注时不要求重新输入 AppSecret",
  panel.includes("wechatAppSecretUpdatePlaceholder") &&
    api.includes("appSecret?: string") &&
    account.includes('if input.AppSecret == ""') &&
    account.includes("updateWechatOfficialAccountLabel"),
);
ok(
  "草稿同步可选择目标公众号",
  draftPanel.includes("selectedAccountId") &&
    draftPanel.includes("accountId: selectedAccountId") &&
    draftPanel.includes("account.isDefault") &&
    api.includes("accountId?: string"),
);
ok(
  "目标公众号被其他窗口删除后自动刷新账号列表",
  draftPanel.includes('caught.code === "wechat_account_not_bound"') &&
    /wechat_account_not_bound[\s\S]*await getWechatOfficialAccounts\(\)[\s\S]*setAccounts\(result\.accounts\)/.test(
      draftPanel,
    ),
);
ok(
  "后端按用户校验草稿目标账号",
  publish.includes("resolveWechatOfficialAccountRef") &&
    account.includes("WHERE user_id = $1 AND account_id = $2"),
);
ok(
  "同步中途的账号与数据库错误不会被图片错误掩盖",
  /case errors\.Is\(err, errWechatAccountNotBound\),[\s\S]*errors\.Is\(err, errWechatPersistence\):[\s\S]*writeWechatOfficialError\(w, err\)[\s\S]*case errors\.Is\(err, errWechatCoverUploadFailed\)/.test(
    publish,
  ),
);
ok(
  "账号 ID 在查询 UUID 列之前完成格式校验",
  (account.match(/!validUUID\(accountID\)/g) || []).length >= 3,
);
ok(
  "删除账号同步返回新默认账号",
  account.includes('"defaultAccountId": defaultAccountID') &&
    api.includes("defaultAccountId: string") &&
    panel.includes("result.defaultAccountId"),
);
ok(
  "账号列表读取失败时禁止假装空列表并可重试",
  panel.includes("accountLoadFailed") &&
    panel.includes("wechatAccountRetry") &&
    panel.includes("setLoadVersion"),
);
ok(
  "从复制导出转入草稿前等待 GEO 编辑保存",
  dialog.includes("async function openWechatDraftDialog()") &&
    /openWechatDraftDialog[\s\S]*await persistGeoText\(\)[\s\S]*await geoPreferenceQueueRef\.current[\s\S]*await onOpenWechatDraft\(\)/.test(
      dialog,
    ),
);
ok(
  "旧单账号接口继续映射默认账号",
  routes.includes('"GET /api/wechat/account"') &&
    routes.includes('"PUT /api/wechat/account"') &&
    routes.includes('"DELETE /api/wechat/account"') &&
    account.includes("loadDefaultWechatOfficialAccountView") &&
    account.includes("upsertDefaultWechatOfficialAccount") &&
    account.includes("defaultWechatOfficialAccountID"),
);
ok(
  "封面默认 2.35:1",
  draftPanel.includes('useState<WechatCoverRatio>("2.35:1")'),
);
ok("封面比例包含 1:1", draftPanel.includes('["2.35:1", "1:1"]'));
ok(
  "生成封面显示 20 credits",
  draftPanel.includes("t.editor.wechatCoverCreditCost"),
);
ok(
  "关闭草稿弹窗会取消进行中的 AI 封面生成",
  /useEffect\(\s*\(\) => \(\) => \{\s*coverAbortRef\.current\?\.abort\(\);\s*\},\s*\[\],\s*\);/.test(
    draftPanel,
  ),
);
ok(
  "创建草稿期间禁止关闭弹窗以避免重复提交",
  draftPanel.includes("onPublishingChange?.(true)") &&
    draftPanel.includes("onPublishingChange?.(false)") &&
    dialog.includes("if (draftPublishing || closeInFlightRef.current) return") &&
    dialog.includes("disabled={geoClosing || draftPublishing}"),
);
ok(
  "草稿创建成功后禁止重复提交",
  /publishing \|\|\s*published \|\|\s*title\.trim\(\)\.length === 0/.test(
    draftPanel,
  ) &&
    /disabled=\{[\s\S]{0,120}controlsDisabled \|\|\s*published \|\|\s*titleInvalid/.test(
      draftPanel,
    ),
);
ok(
  "AI 封面不是同步草稿的前置条件",
  /coverBase64\?: string/.test(api) &&
    /coverRatio\?: WechatCoverRatio/.test(api) &&
    !/if \(!account \|\| !cover \|\| publishing/.test(draftPanel) &&
    !/disabled=\{controlsDisabled \|\| !cover/.test(draftPanel) &&
    /titleInvalid/.test(draftPanel),
);
ok(
  "草稿面板支持三种封面来源",
  draftPanel.includes('useState<WechatCoverMode>("default")') &&
    draftPanel.includes('value: "default"') &&
    draftPanel.includes('value: "article"') &&
    draftPanel.includes('value: "ai"') &&
    dialog.includes("extractWechatArticleImages(editor)") &&
    api.includes("coverMode?: WechatCoverMode") &&
    api.includes("coverImageSource?: string"),
);
ok(
  "默认封面包含 Logo 和文章标题",
  draftPanel.includes('from "./wechatCover"') &&
    coverGenerator.includes("createDefaultWechatCover") &&
    coverGenerator.includes('image.src = "/logo.png"') &&
    draftPanel.includes('coverMode === "default" && defaultCover'),
);
ok(
  "封面比例同时应用于默认封面和正文图片",
  draftPanel.includes(
    'style={{ aspectRatio: ratio === "1:1" ? "1" : "2.35 / 1" }}',
  ) &&
    /coverMode === \"article\"[\s\S]*coverRatio: ratio/.test(draftPanel) &&
    publish.includes("defaultWechatCover(input.Title, input.CoverRatio)"),
);
ok(
  "后端校验并处理正文图片封面",
  /CoverMode\s+string `json:"coverMode"`/.test(publish) &&
    /CoverImageSource\s+string `json:"coverImageSource"`/.test(publish) &&
    publish.includes("wechatHTMLHasImageSource") &&
    publish.includes("transferWechatDraftImagesWithCoverImage"),
);
ok(
  "后端兼容旧版 AI 封面请求",
  /if input\.CoverMode == "" && strings\.TrimSpace\(input\.CoverBase64\) != ""/.test(
    publish,
  ) && publish.includes("input.CoverMode = wechatCoverModeAI"),
);
ok(
  "后端接受客户端生成的默认封面",
  publish.includes(
    "input.CoverMode != wechatCoverModeAI && input.CoverMode != wechatCoverModeDefault",
  ),
);
ok(
  "无 AI 封面时服务端提供草稿缩略图",
  /transferWechatDraftImagesWithCoverImage\([\s\S]*\) \(string, \[\]byte, error\)/.test(
    publish,
  ) &&
    publish.includes("defaultWechatCover(input.Title, input.CoverRatio)") &&
    publish.includes("prepareWechatThumb(selectedImage, wechatCoverRatioWide)"),
);
ok(
  "封面生成固定预留 20 credits",
  publish.includes("wechatCoverGenerationCredits    = int64(20)"),
);
ok(
  "封面 credits 预留覆盖最长上游调用",
  publish.includes(
    "wechatCoverReservationTTL       = wechatCoverGenerationRunLimit + 2*time.Minute",
  ) &&
    publish.includes(
      "context.WithTimeout(r.Context(), wechatCoverGenerationRunLimit)",
    ),
);
ok(
  "封面生成成功后提交 credits",
  publish.includes("commitCreditReservation(") &&
    publish.includes('"feature": "wechat_cover_generation"'),
);
ok(
  "封面生成失败释放 credits",
  publish.includes("wechat cover release credits"),
);
ok("保留原复制按钮", dialog.includes("t.editor.mediaCopy"));
ok("草稿正文不重复标题", dialog.includes("includeTitle: false"));
ok(
  "frontmatter 元信息传入草稿",
  api.includes("author?: string") &&
    api.includes("digest?: string") &&
    draftPanel.includes("author?.trim()") &&
    draftPanel.includes("digest?.trim()"),
);
ok(
  "后端草稿保留可选元信息",
  publish.includes("input.Author") &&
    publish.includes("input.Digest") &&
    publish.includes('article["author"]') &&
    publish.includes('article["digest"]'),
);
ok(
  "AppSecret 只存密文列",
  initialMigration.includes("app_secret_ciphertext bytea NOT NULL"),
);
ok(
  "迁移不含 AppSecret 明文列",
  !/app_secret\s+(?:text|varchar)/i.test(initialMigration),
);
ok(
  "多账号迁移保留旧绑定并设为默认",
  multiAccountMigration.includes("ADD COLUMN account_id uuid") &&
    multiAccountMigration.includes("SET account_id = gen_random_uuid()") &&
    multiAccountMigration.includes("SET is_default = true") &&
    multiAccountMigration.includes("wechat_official_accounts_one_default_idx"),
);
ok(
  "公众号凭证使用独立密钥且不回退会话密钥",
  config.includes("WECHAT_CREDENTIAL_ENCRYPTION_KEY") &&
    !/wechatCredentialCipher[\s\S]*SessionSecret/.test(account),
);
ok(
  "公众号 access token 按账号隔离且并发刷新会合并",
  account.includes("wechatTokenRefreshes") &&
    account.includes("wechatAccessTokenForCredential") &&
    account.includes("map[string]wechatAccessToken") &&
  account.includes(
      "wechatTokenRefreshKey{AccountID: credential.AccountID, AppID: credential.AppID}",
    ) &&
    account.includes("errors.Is(refresh.Err, context.Canceled)"),
);
ok(
  "微信 API 只使用显式配置的出口代理",
  /transport := http\.DefaultTransport\.\(\*http\.Transport\)\.Clone\(\)\s*transport\.Proxy = nil/.test(
    account,
  ),
);
ok(
  "公众号正文图片使用有界并行准备",
  publish.includes("wechatDraftImagePrepareWorkers") &&
    publish.includes("prepareWechatDraftImages"),
);
ok(
  "公众号正文图片只替换 src 值并保留完整 img 标签",
  publish.includes("rewriteWechatImageSources") &&
    publish.includes("output.WriteString(content[last:sourceStart])") &&
    !publish.includes("output.WriteString(content[last:match[0]])"),
);
ok("封面 API Key 只由后端配置", config.includes("WECHAT_COVER_IMAGE_API_KEY"));
ok(
  "部署写入公众号凭证密钥",
  deploy.includes("WECHAT_CREDENTIAL_ENCRYPTION_KEY"),
);
ok("部署写入封面模型密钥", deploy.includes("WECHAT_COVER_IMAGE_API_KEY"));
ok(
  "部署可复现微信 API 中转地址",
  deploy.includes("WECHAT_API_PROXY_URL: ${{ vars.WECHAT_API_PROXY_URL }}") &&
    deploy.includes('printf "WECHAT_API_PROXY_URL=%s\\n"'),
);
ok(
  "SSH 中转模式不错误依赖 WireGuard 单元",
  proxyService.includes("WECHAT_PROXY_LISTEN=127.0.0.1:18080") &&
    !proxyService.includes("wg-quick@wg0.service"),
);
ok(
  "微信中转固定使用白名单中的 IPv4 出口",
  proxySource.includes(
    'DialContext(context.Background(), "tcp4", allowedWechatTarget)',
  ),
);

console.log(`微信公众号草稿：${passed} 通过，0 失败`);
