import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
function ok(label, condition) {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL ${label}`);
  }
}
function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const generated = JSON.parse(read("scripts/_release_announcement_test.json"));
const packageJSON = JSON.parse(read("package.json"));
ok("版本提醒使用 package 版本", generated.version === packageJSON.version);
ok("版本提醒不携带未使用的发布时间", !("publishedAt" in generated));
ok(
  "版本提醒同时包含四种语言",
  ["en", "zh", "fr", "ja"].every((locale) => generated.translations[locale]),
);
for (const locale of ["en", "zh", "fr", "ja"]) {
  const translation = generated.translations[locale];
  ok(`${locale} 有标题和摘要`, Boolean(translation.title && translation.summary));
  ok(`${locale} 标题不超过 160 字符`, [...translation.title].length <= 160);
  ok(`${locale} 摘要不超过 600 字符`, [...translation.summary].length <= 600);
  ok(
    `${locale} 提取 1–6 条功能要点`,
    translation.highlights.length >= 1 && translation.highlights.length <= 6,
  );
  ok(
    `${locale} 每条功能要点不超过 500 字符`,
    translation.highlights.every(
      (highlight) => [...highlight].length >= 1 && [...highlight].length <= 500,
    ),
  );
}

const api = read("spa/src/api.ts");
const shell = read("spa/src/components/AppShell.tsx");
const dialog = read("spa/src/components/AnnouncementDialog.tsx");
const admin = read("spa/src/components/AnnouncementAdminPanel.tsx");
const compose = read("docker-compose.yml");
const translator = read("backend/internal/server/announcement_translation.go");
const announcementServer = read("backend/internal/server/announcements.go");
const serverMain = read("backend/cmd/server/main.go");
const deployWorkflow = read(".github/workflows/deploy.yml");
const spaAndWorker = `${read("spa/src/api.ts")}\n${read("worker/index.ts")}`;
ok("前端读取未读提醒", api.includes("/api/announcements/unread?locale="));
ok("前端可标记提醒已读", api.includes("/api/announcements/${announcementId}/read"));
ok("读完当前批次会继续拉取后续提醒", dialog.includes("invalidateQueries({ queryKey })"));
ok("登录用户在全局外壳收到提醒", /user && !localMode && <AnnouncementDialog/.test(shell));
ok("版本提醒提供完整更新日志入口", dialog.includes('to="/changelog"'));
ok("提醒可用关闭按钮、Escape 或遮罩本地关闭", dialog.includes("dismissCurrent") && dialog.includes('event.key !== "Escape"'));
ok("已读失败会显示错误而不是锁住页面", dialog.includes("markRead.isError") && dialog.includes("markReadFailed"));
ok("管理员发布时提交原文语言和结构化内容", admin.includes("publishAdminAnnouncement") && admin.includes("sourceLocale"));
ok("管理员界面明确展示 LLM 翻译状态", admin.includes("announcementTranslationFailed"));
ok(
  "提醒发布工作台展示四语言、长度和要点计数",
  admin.includes("LOCALES.map") &&
    admin.includes("[...title].length") &&
    admin.includes("[...summary].length") &&
    admin.includes("{lines.length} / 8"),
);
ok(
  "提醒历史独立滚动并展示记录数量",
  admin.includes('className="max-h-[44rem] overflow-y-auto"') &&
    admin.includes("announcements.data?.announcements.length ?? 0"),
);
ok("管理员可软撤回提醒", api.includes("withdrawAdminAnnouncement") && admin.includes("announcementWithdrawConfirm"));
ok("撤回提醒不会再进入未读列表", announcementServer.includes("announcement.withdrawn_at IS NULL"));
ok("版本提醒导入失败不会终止服务", serverMain.includes("继续启动服务") && !serverMain.includes('log.Fatalf("导入版本提醒失败'));
ok("后端容器接收翻译配置", compose.includes("ANNOUNCEMENT_LLM_API_KEY"));
ok("提醒翻译使用 Anthropic Messages 端点", translator.includes('"/v1/messages"'));
ok(
  "Anthropic 鉴权头完整且没有误用 Bearer",
  translator.includes('"x-api-key"') &&
    translator.includes('"anthropic-version"') &&
    !translator.includes('"Authorization"'),
);
ok("LLM API Key 没有进入 SPA 或 Worker", !spaAndWorker.includes("ANNOUNCEMENT_LLM_API_KEY"));
ok("部署不把提醒翻译密钥列为必需 secret", !/for name in [^\n]*ANNOUNCEMENT_LLM_API_KEY/.test(deployWorkflow));
ok("部署从 Actions Variable 读取中转地址和模型", deployWorkflow.includes("vars.ANNOUNCEMENT_LLM_BASE_URL") && deployWorkflow.includes("vars.ANNOUNCEMENT_LLM_MODEL"));
ok("部署 workflow 不硬编码翻译中转域名", !deployWorkflow.includes("cfjwlpro.com"));

console.log(`announcements: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
