import assert from "node:assert/strict";
import fs from "node:fs";
import {
  AGENT_REVIEW_BACKGROUND_TIMEOUT_MS,
  agentReviewAccess,
  agentReviewTaskExpired,
  canStartAgentReview,
  titleScoreNeedsAlternatives,
} from "./_agent_review_core_bundle.mjs";

assert.equal(agentReviewAccess(true, false), "ready");
assert.equal(agentReviewAccess(false, false), "membership_required");
assert.equal(agentReviewAccess(true, true), "local_mode_unavailable");
assert.equal(agentReviewAccess(false, true), "local_mode_unavailable");

assert.equal(canStartAgentReview("builtin", true, ""), true);
assert.equal(canStartAgentReview("builtin", false, "channel-ignored"), false);
assert.equal(canStartAgentReview("byok", false, "channel-1"), true);
assert.equal(canStartAgentReview("byok", true, "   "), false);

assert.equal(titleScoreNeedsAlternatives(0), true);
assert.equal(titleScoreNeedsAlternatives(59), true);
assert.equal(titleScoreNeedsAlternatives(60), false);
assert.equal(titleScoreNeedsAlternatives(100), false);

const trackedAt = Date.parse("2026-08-19T12:00:00Z");
const expiresAt = new Date(trackedAt + AGENT_REVIEW_BACKGROUND_TIMEOUT_MS).toISOString();
assert.equal(agentReviewTaskExpired(expiresAt, "", trackedAt), false);
assert.equal(
  agentReviewTaskExpired(expiresAt, "", trackedAt + AGENT_REVIEW_BACKGROUND_TIMEOUT_MS),
  true,
);
assert.equal(
  agentReviewTaskExpired(undefined, "2026-08-19T12:00:00Z", trackedAt),
  false,
);
assert.equal(
  agentReviewTaskExpired(
    undefined,
    "2026-08-19T12:00:00Z",
    trackedAt + AGENT_REVIEW_BACKGROUND_TIMEOUT_MS,
  ),
  true,
);

const panel = fs.readFileSync("spa/src/components/editor/AgentReviewPanel.tsx", "utf8");
const notifications = fs.readFileSync("spa/src/components/AgentReviewNotifications.tsx", "utf8");
const notificationEvents = fs.readFileSync("spa/src/agentReviewNotifications.ts", "utf8");
const modelSettings = fs.readFileSync("spa/src/components/AgentModelSettingsCard.tsx", "utf8");
const liveEditor = fs.readFileSync("spa/src/components/editor/LiveEditor.tsx", "utf8");
const zh = fs.readFileSync("spa/src/i18n/zh.ts", "utf8");
const api = fs.readFileSync("spa/src/api.ts", "utf8");
const backend = fs.readFileSync("backend/internal/server/agent_reviews.go", "utf8");
const llm = fs.readFileSync("backend/internal/server/agent_llm.go", "utf8");
const prompt = fs.readFileSync("backend/internal/server/writing_review_prompt.go", "utf8");
const tasks = fs.readFileSync("backend/internal/server/writing_review_tasks.go", "utf8");
const layout = fs.readFileSync("backend/internal/server/markdown_structure_review.go", "utf8");

function includes(label, source, fragment) {
  assert.ok(source.includes(fragment), `${label}: missing ${JSON.stringify(fragment)}`);
}

includes("面板使用统一会员/本地模式门槛", panel, "agentReviewAccess(member, localMode)");
includes("面板复用经过测试的启动条件", panel, "canStartAgentReview(");
includes("AI 优化弹窗使用 Bot 图标", panel, '<Bot className="mt-0.5 h-5 w-5 shrink-0"');
includes("优化面板读取账号级模型设置", panel, "queryFn: getAgentSettings");
includes("创建审阅由账号级模型设置决定", panel, "createAgentReview(docId)");
includes("创建成功后发布后台任务事件", panel, "publishAgentReviewStarted({");
includes("创建成功后立即关闭优化面板", panel, "onClose();");
includes("后台任务轮询不把瞬时网络错误误判为失败", notifications, "Promise.allSettled(");
includes("轮询使用任务引用避免状态变化重建定时器", notifications, "const tasksRef = useRef(tasks);");
includes("完成任务会从隐藏集合清理", notifications, "if (runningIds.has(reviewId)) continue;");
includes("后端列表读取时主动回收超时任务", backend, "expireStaleAgentReviews(r.Context(), user.ID)");
includes("后端详情读取只回收当前超时任务", backend, "expireStaleAgentReview(r.Context(), user.ID, reviewID)");
includes("前端仅在请求失败后应用超时兜底", notifications, "expiredReviewIds.has(reviewId)");
includes("超时任务显示明确原因", notifications, 'task.errorCode === "review_timeout"');
includes("后台任务跨刷新保存在账号命名空间", notificationEvents, "REVIEW_TASKS_STORAGE_PREFIX + accountKey");
includes("后台任务跨标签页同步", notifications, 'window.addEventListener("storage", onStorage)');
includes("会话内后台任务也限制数量", notifications, "].slice(0, MAX_STORED_REVIEW_TASKS)");
includes("完成通知可以回到指定审阅", notifications, "requestAgentReviewOpen(task)");
includes("超时审阅详情显示明确原因", panel, 'review.errorCode === "review_timeout"');
includes("AI 设置可以选择内置模型", modelSettings, 'update.mutate("builtin")');
includes("AI 设置可以选择自有 LLM", modelSettings, 'update.mutate("byok")');
assert.ok(!panel.includes("ProviderButton"), "AI 优化不应展示模型来源选择");
assert.ok(!panel.includes("setProviderMode"), "AI 优化不应保存临时模型来源");
assert.ok(!panel.includes("listLLMChannels"), "AI 优化不应直接管理模型渠道");
includes("中文按钮统一使用 AI 优化", zh, 'button: "AI 优化"');
includes("中文弹窗标题统一使用 AI 优化", zh, 'title: "AI 优化"');
includes("运行中的审阅由前端轮询", panel, 'query.state.data?.review.status === "running" ? 2_000 : false');
includes("运行中展示子任务进度", panel, "<AgentReviewProgress review={review} />");
includes("运行中展示部分结果", panel, "<PartialAgentReviewResult review={review} />");
includes("后台完成后刷新 credits", panel, "selectedReviewStatus === \"running\"");
includes("运行中的审阅禁用重复提交", panel, "create.isPending || reviewRunning");
includes("用量文案只展示 credits", panel, "interpolate(t.agentReview.usage, { credits: review.creditsCharged })");
includes("运行中展示预计扣除额度", panel, "t.agentCredits.estimatedCharge");
includes("Credits 查询失败显示准确错误", panel, "providerMode === \"builtin\" && credits.isError");
includes("标题评分使用低于 60 的统一边界", panel, "titleScoreNeedsAlternatives(review.titleScore)");
includes("Git 风格删除行", panel, '<DiffBlock sign="-"');
includes("Git 风格新增行", panel, '<DiffBlock sign="+"');
includes("支持逐条应用", panel, "applyAgentReviewSuggestion(");
includes("支持逐条忽略", panel, "dismissAgentReviewSuggestion(");
includes("支持全部应用", panel, "applyAllAgentReviewSuggestions(");
includes("支持全部忽略", panel, "dismissAgentReview(");
assert.equal(
  panel.match(/await onPrepareReview\(\)/g)?.length,
  3,
  "创建审阅、逐条落实和全部落实前都必须经过保存/同步屏障",
);
includes("内容与排版使用独立标签", panel, '(["content", "layout"] as const)');
includes("内容建议单独分组", panel, 'item.kind !== "layout"');
includes("排版建议单独分组", panel, 'item.kind === "layout"');
includes("展示六维结构评分", panel, "review.layoutAssessment ?? []");
includes("逐条或全部应用后接收服务端文档", panel, "onAcceptDocument(result.document)");
includes("接收文档后刷新编辑器缓存", liveEditor, 'queryClient.setQueryData(["document", docId], next)');
includes("Agent 写入前先落盘当前草稿", liveEditor, "onPrepareReview={prepareAgentReview}");
includes("前端创建 review 端点", api, "/agent-reviews`");
includes("桌面落实结果写回 SQLite", api, "desktopAcceptRemoteDocumentMutation(result.document)");
includes("后端所有 review 操作要求终生会员", backend, "requireLifetimeMember(w, r)");
includes("内置模型预留 credits", backend, "reserveCredits(");
includes("BYOK 渠道不走 credits 预留", backend, 'if provider.Mode == "builtin"');
includes("创建审阅立即返回运行状态", backend, "http.StatusAccepted");
includes("耗时审阅在后台执行", backend, "go a.runAgentReview(");
includes("审阅构建并行任务计划", backend, "buildWritingReviewTaskPlan(document.Title, document.Content)");
includes("审阅执行并行任务计划", backend, "executeWritingReviewTaskPlan(");
includes("子任务全局并发限制为三路", tasks, "agentReviewTaskConcurrency       = 3");
includes("正文按块动态拆分", tasks, "agentReviewMaxBodyTasks          = 12");
includes("标题正文排版使用独立提示词", tasks, "buildWritingReviewTitlePrompt");
includes("标题正文排版使用独立提示词", tasks, "buildWritingReviewBodyPrompt");
includes("标题正文排版使用独立提示词", tasks, "buildWritingReviewLayoutPrompt");
includes("只重试校验失败的子任务", tasks, "The previous response for this task was rejected");
includes("子任务进度持久化", backend, "storeAgentReviewTaskOutcome(");
includes("内置模型按所有子任务预留", backend, "estimateAgentReviewPlanReservation(plan)");
includes("Anthropic 能看到完整输出 schema", llm, "The response must conform to this exact JSON Schema");
includes("低分标题必须给出 2 或 3 个候选", prompt, "low-scoring title requires 2 or 3 alternatives");
includes("正文建议使用唯一精确锚点", prompt, "body anchor is not exact and unique");
includes("提示词禁止编造事实", prompt, "Do not invent evidence");
includes("提示词保护 Markdown 和媒体", prompt, "Editorial suggestions must preserve Markdown structure");
includes("结构排版使用独立输出", prompt, "layoutSuggestions change presentation without rewriting words");
includes("结构排版限制为类型化操作", prompt, "change_block_type");
includes("服务端使用 Markdown AST", layout, "goldmark.DefaultParser().Parse");
includes("拆段必须逐字保留原文", layout, 'strings.Join(suggestion.Segments, "") != block.Source');
includes("先诊断内容价值再润色", prompt, "Diagnose the article's actual value, evidence, audience, and central promise before polishing wording");
includes("开头独立成立", prompt, "Make the opening work independently");
includes("移动端长文可读性", prompt, "Optimize for mobile long-form reading");
includes("AI 腔检测", prompt, "smooth repetitive parallelism");
includes("标题承诺必须有证据", prompt, "promise-to-evidence fit");
includes("标题触发器受正文约束", prompt, "cognitive contrast");
includes("标题不得虚构权威和数字", prompt, "Never invent authority, figures, urgency, outcomes, or pain points");
includes("低分标题使用不同角度", prompt, "meaningfully different supported angles");

console.log("agent review checks passed");
