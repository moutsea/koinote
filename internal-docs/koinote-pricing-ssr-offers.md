# Koinote 定价页 SSR、Offer 与权益说明

评估日期为 2026-11-29，时区 Asia/Singapore。本文件对应任务 `30bf01a3-9121-4bea-97d0-6014cb0ab6a5`，标题为「koinote 定价页写入 SSR 与 Offer，修正已过时的 BYOK FAQ 并重排权益」。原始需求以本卡描述及 Coder 于 2026-11-26 确认的产品定位为准。

本卡按一个原子任务交付一个 PR。目标是让同一定价页在 Worker 首屏、React 页面和结构化数据中准确表达现有价格与权益。四语 FAQ 和其他现存 BYOK 承诺来自同一批语言资源，其纠正并入本卡。后端仅作为事实来源，展示链路可一起验收和回滚，评估无需拆卡。

风险级别为中等，主要风险为货币单位换算错误、缓存导致报价不一致、权益门槛和扣费条件被文案误述。预计中等规模，主要涉及 Worker 定价渲染、共享金额工具、四语资源、定价组件和相关测试。文件数由验收需要确定。

PR 负责人为本卡「开发中」主会话，agent profile 为 `92d67037-1df0-4f19-bf5e-8cb0c4965f2b`。负责人承担实现、各提交自审、验收证据和唯一 PR 交付，独立评审由「待评审」阶段负责。Coder 决定后续合并和发布。授权终点是经过评审的 OPEN PR，禁止合并、部署和启用自动合并，后续流程须完整继承本卡限制。

本轮需求评审指令已授权在计划清晰后移入开发，覆盖卡面最初的待开工状态。当前评估交付需求文档与任务计划，功能实现由开发阶段承接。

**评估时的代码与基线**

- 真实仓库为 `moutsea/koinote`，PR base 为 `main`，沿用任务独立分支 `feature/koinote-ssr-offer-by-7k4`。
- 原始需求基线及当前工作区 HEAD 均为 `7b5c59d1f8f99d9011c891f5cb889285a04da0a6`。评估开始时工作区干净，前次会话没有留下本卡实现、内部文档或计划。
- 本轮只读查询远端 main 得到 `201df9a26308a143e8021ec341aba34a42256514`，本地 `origin/main` 与之相符。相对原始基线新增 Hub noindex 卡的提交，涉及 `worker/seo.ts`、`worker/index.ts`、SEO/来源头测试和仓库详情页等。开发前应将本卡分支承接当时最新 main，记录实际 BASE_SHA 与 HEAD_SHA，并在 PR 说明基线差异。
- 本轮只读查询开放 PR，仅发现注册归因 PR #5，分支 `feature/koinote-de5`，base `main`，非 draft。其文件涉及 `package.json`、`spa/src/api.ts`、`spa/src/main.tsx` 等，本卡首选方案可直接复用现有测试入口与 API 类型。
- 原始卡列出的仓库外 SEO 报告未读取，本轮以卡面需求及仓库代码核对实现边界。历史 GSC 数字属于原始需求背景，本轮没有复测。

**根因与改动落点**

| 问题 | 已核对的根因 | 计划改动 | 受影响链路 |
| --- | --- | --- | --- |
| SSR 缺少会员价格数字 | `worker/seo.ts` 的 `PricingQuota` 与 `pricingQuota` 仅供容量使用，`pageBody('pricing')` 只输出终身周期；React 的 `PricingPage` 才读取并展示价目 | 复用现有 `/api/billing/pricing` 请求，保留价格字段，使用语言对应货币生成免费数字价格和会员数字价格 | Go 公开价目 → Worker → 无 JS HTML → React 接管 |
| 定价页没有两档 Offer | `structuredData` 对定价页仅返回 BreadcrumbList，首页 SoftwareApplication 只描述免费档 | 在定价页增加 SoftwareApplication 与免费、终身两个 Offer，并保留面包屑 | 同一次价目快照 → 页面可见价格与 JSON-LD |
| FAQ 承诺 BYOK 免 credits | 四语 `pricing.faqs` 仍含旧渠道承诺；`docsCenter`、`agentModelSettings`、`llmChannels`、`agentReview`、`settings` 等也存在旧能力句 | 更正四语当前能力与计费说明，保留被调用的键和历史记录的兼容语义 | i18n → SSR FAQ、React 定价与相关用户提示 |
| 权益表信息不足或会被误读 | 当前仅有 AI 优化、MCP 等简写，配置快照、发布扣费和平台前置条件需要核对具体处理函数 | 使用现有权益数组和必要脚注补齐真实能力、门槛、金额及例外 | 定价页决策 → 登录升级 → 现有功能与扣费提示 |

上述为评估时的源码核对结果，实际开发与验证结果记录在后文。

**范围及最小实现方案**

1. 扩展现有定价读取的数据范围，在同一次 SSR 请求内向正文与 JSON-LD 传递同一份已选定报价。优先复用 `BillingPricing` 的类型、`BillingPrice`、`DEFAULT_CURRENCY_BY_LOCALE` 和 `formatBillingPrice`。如需共享最小单位转换，仅在现有 `billingCore.ts` 内补足所需逻辑。
2. 语言默认货币沿用 zh→CNY、en→USD、fr→EUR、ja→JPY；所需货币缺失时沿用客户端的接口首个有效价格回退。货币代码按接口规范化。USD/CNY/EUR 金额以最小单位除以 100，JPY 保留整数。接口金额作为唯一运行时价格来源。
3. 两档可见价格与 Offer 的币种一致。免费档包含数值 0，终身档 Offer 的 `price` 为不带货币符号或千分位的十进制值，`priceCurrency` 为大写币种，名称、描述明确一次性付款及无自动续费，链接指向对应语言的定价页。
4. 沿用现有 1500ms 后端超时和按后端地址隔离的 5 分钟价目缓存。缓存期内正文与 Offer 使用同一报价快照，到期成功刷新后一起更新。测试说明这个已有缓存窗口，避免把跨缓存时刻比较当成金额转换结果。
5. 冷缓存下遇到超时、非成功响应、无效 JSON、空价格或无有效报价时，页面保留可读权益、免费档和本地化价格暂不可用提示，返回现有可用页面状态；有可靠报价后才输出终身 Offer。付费价目绝不以 0 或历史金额补齐。支付未启用时仍可显示后端有效报价，购买状态遵循现有 `billingEnabled`。继续沿用后端请求的固定路径、可信后端地址、内部头与禁止跟随重定向的安全处理。
6. 重排 `pricing.freeFeatures`、`pricing.lifetimeFeatures` 和 FAQ，必要时加共享四语脚注。SSR 与 React 使用同一内容来源；手机端能够完整阅读收费条件和门槛。保留正常货币选择、登录跳转、会员管理及结算按钮逻辑。
7. 逐一追踪旧 BYOK 文字的调用者，修正当前功能承诺，包括四语文档中心中的个人渠道推荐和设置升级提示。历史版本日志与历史任务的错误说明按真实历史语义处理，避免批量替换技术标识或删除兼容键。

范围外项包括价格本身、支付渠道、会员资格、credits 账本与扣费规则、MCP 授权、后端路由启停、schema/迁移、基础设施、部署配置、依赖升级，以及首页实体文案、MCP 指南正文和 llms.txt。首页的「自有图床」文案由首页卡负责。本卡使用定价页 JSON-LD 方案，首页定位改动仍由首页卡交付。其他 P0 卡的范围和卡面由其各自负责人维护。

**权益事实与文案验收口径**

| 项目 | 定价页必须准确表达的内容 | 代码依据 |
| --- | --- | --- |
| 存储 | 免费和会员基础容量来自价目接口，现有默认分别为 500 MiB 与 10 GiB；用户可见单位复用 `formatBytes`。云存储包括文档、图片、配置快照及其他实际计量项目，邀请奖励另计 | `billing.go` 的 `billingPricing`；`image_quota.go` 的 `storageQuotaFor`、`storageBreakdown.Total` |
| 免费基础能力 | Markdown 编辑、保存、同步、图床、导出和只读分享 | `PricingPage.tsx` 与现有四语免费权益；相关编辑和分享入口 |
| MCP | 文档检索、读取、创建、修改及支持的管理操作，需要终身会员与相应令牌权限 | `mcp_tokens.go` 的 `requireLifetimeMember`、`authenticateMCPToken`；`mcp.go` 工具注册 |
| 版本历史 | 会员可配置保留策略；MCP 写入的安全快照说明限定于相应写入链路 | `mcp.go` 历史设置读取及四语版本历史说明 |
| 站内 AI 助手 | 改稿、整理、审阅需要终身会员；平台模型按实际用量扣 credits | `agent_reviews.go` 的会员检查；`admin_llm_settings.go`；`CHANGELOG.zh.md` 1.1.8 的平台渠道变更 |
| 会员赠送额度 | 开通终身会员获得 1,000 credits，后续使用按现有规则扣减 | `credits.go` 的 `lifetimeMembershipGrantCredits` 与会员授予链路 |
| 公众号草稿箱 | 终身会员绑定公众号后，普通成功同步消耗 20 credits，失败释放预留；MCP 运营方专门授权的免扣同步适用原有条件 | `admin.go` 的 `requireWechatMember`；`wechat_official_publish.go`；`mcp_wechat_billing.go`、`mcp_wechat.go` |
| AI 封面 | 成功生成消耗 20 credits，公众号草稿同步另计；依赖会员、足额 credits 和可用生图配置 | `wechat_official_publish.go` 的 `wechatCoverGenerate`、`wechatCoverGenerationCredits` |
| X Article | 成功发布消耗 20 credits；已在 X 创建草稿而发布失败时也扣 20，需在脚注说明。调用还依赖登录、平台启用、X 授权与实际可用额度 | `x.go` 的 `xPublish`、`xArticlePublishCredits`、`draft_only` 分支；`media_platforms.go` 的 `requireMediaPlatformEnabled` |
| 飞书 | 终身会员绑定和授权后进行 Koinote → 飞书单向同步，服务需配置可用 | `feishu_docs_sync.go` 的 `feishuDocumentSync`、`syncFeishuDocument` |
| Hub | 私有仓库及 Fork 需要终身会员并启用对应能力，受现有存储限制 | `agent_workspace.go` 的 `requireAgentWorkspaceUser`；`agent_workspace_management.go`；`agent_repository_sharing.go` 的 `publicAgentRepositoryFork` |
| 配置快照 | 免费账号可保存 1 份并更新该份；会员可保存多份，均受空间额度约束 | `config_snapshots.go` 的 `configSnapshotFreeLimit`、创建/更新检查 |
| 个人 LLM 渠道 | 当前已停用；站内 AI 使用平台渠道并按实际用量扣 credits | `admin_llm_settings.go` 的 `personalLLMChannelsDisabled`，会员访问返回 410 `llm_channels_disabled` |

X 发布处理函数先检查登录和平台启用，普通 X 发布与 X Article 的额度处理也有区别。定价页收费脚注应表述具体能力与额度条件，避免把所有外部平台操作概括为统一会员鉴权。MCP 常规文档操作与调用平台模型的工具也应保持计费区别。语义检索/RAG、双链/图谱/标签以及个人 Key 免 credits 均不属于本卡可承诺的现有能力。

代码中的 X 草稿已创建仍扣费、配置快照免费 1 份，以及运营授权的 MCP 微信免扣例外，是本轮补充的验收边界。它们用于准确描述原有行为。开发应以当时最新 main 复核对应实现。

**验收标准**

1. 访问 `/pricing` 及 `?lang=zh|en|fr|ja`，真实 Worker 响应 HTML 的可见正文包含免费数值价格和与当次有效价目一致的会员价格，禁用 JS 能读到关键权益与门槛。裸路径按 Accept-Language 处理，canonical、hreflang、语言头与现有路由行为正确。
2. 解析每种语言的 JSON-LD，确认面包屑和两个 Offer 完整，免费为 0，会员金额及币种与可见正文和同一接口快照一致，包含一次性付款、无自动续费说明。JPY 无误除 100，其他三种货币使用正确小数单位。以变化后的测试价目证明金额没有写死。
3. 测试冷缓存失败、空价目、无效条目、缺默认币种、缓存命中与到期更新、支付未配置。错误路径可读、无假报价和错误跳转，正常恢复后 SSR 与 Offer 同步更新。
4. 四语 FAQ 明确站内 AI/平台模型实际用量扣 credits 与个人渠道已停用，当前资源中的等价 BYOK 免费承诺得到纠正。逐项列出实际修改的键和调用页面，检查历史记录显示的兼容语义。
5. 权益表及脚注覆盖上表全部项目，明确 MCP 与站内 AI 的会员门槛，准确呈现 1,000 credits、三项 20 credits、配置快照免费额度，以及 X 草稿和 MCP 微信授权例外。相关文案修正、内链和账户前置要求随本卡一起验收。
6. React 正常加载和错误状态、四语切换、货币选择、未登录升级入口、会员管理和购买禁用状态通过相关回归，移动端价格/脚注可读。结算仍使用当前选定币种。
7. 最终 diff 保持在展示与必要回归范围内，P0 Hub noindex、仓库页和 sitemap 已合入行为通过原有回归。内部文档保持私有发布边界，四语类型与现有测试入口齐全。
8. 开发交付记录每一项根因、实际修改、受影响链路、执行命令、真实结果及剩余限制。跳过项明确列出，整卡独立评审覆盖实际 BASE_SHA 至最终 HEAD_SHA。

**验证安排与证据分层**

优先扩充现有 `scripts/_check_seo.mjs`，从 `worker.fetch` 真实入口解析 HTML 与 JSON-LD，通过受控价目响应验证上述金额与错误路径；这属于外部价目服务模拟验证。四语内容使用现有 `test:i18n` 及针对定价渲染的断言。需要浏览器交互时采用已有测试设施验证真实组件，测试内容覆盖实际回归风险。

已核对仓库脚本，可用命令包括 `npm run test:seo`、`npm run test:i18n`、`npm run test:docs-center`、`npm run test:account-pages`、`npm run test:quota`、`npm run test:desktop-billing`、`npm run test:backend-origin` 与 `npm run typecheck`。按最终修改链路选择执行，最终 `npm test` 已包含类型和上述主要检查，通过后串行执行 `npm run build`。仓库未提供单独 lint script，记录这一事实。现有 PR CI 还包含后端与数据库检查，报告其实际结果和跳过项。

本地 HTTP 验收使用实际 Worker 服务，针对上述五类路径抓取 HTML，并在相同缓存窗口读取 `/api/billing/pricing` 对照。普通 Vite 开发代理本身无法证明 Worker SSR 正确。服务端口、启动参数和依赖安装方式从仓库现有配置与帮助核对后使用。

本卡展示改动无需生产写入。实际数据库验证、价目/支付/外部发布服务模拟、浏览器组件验证、生产验收各自记录执行环境和证据。源码审查仅能支持规则核对。真实扣费、公众号/X/飞书外部操作及生产验收需遵守另行授权；上线后 GSC 的展示、点击与错误 BYOK 引用属于观察指标。

资源要求沿用本卡约束。全局会话上限 4，本卡由主会话执行；禁止并行子 agent 或后台 AI。全量测试和构建启动前检查 load、MemAvailable 及现有重任务，已有重活或可用内存低于 2 GiB 时等待并说明，重活串行执行。

**内部文档隔离**

文件只存于仓库根 `internal-docs/koinote-pricing-ssr-offers.md`。当前 Vite 以 `spa` 为根、仅复制根目录 `public`，Worker 静态资源来自 `spa/dist`。公开文档路由由 `spa/src/seoMeta.ts` 和页面代码列举，未发现 `/api/docs` 的文档文件读取实现。`wrangler.jsonc` 的 Markdown Text 规则用于被导入的 Markdown，Worker 当前直接导入的是根目录 CHANGELOG 文件。

开发与评审应检查 `spa/src`、`worker` 及构建脚本没有导入或递归扫描本文件，最终产物不含本需求文档的标题/任务标识，也不通过文档目录、`/api/docs`、sitemap 或 llms 索引输出内容。本轮仅完成源码边界核对，打包产物检查由开发构建后完成。

**依赖、分支和冲突顺序**

本卡现有功能依赖已在仓库中具备，无新增功能前驱。本轮保持独立顶层卡。后续若出现真正的线性前置需求，使用一个直接前驱及 `start_when_unblocked=true` 记录，禁止自行合并前卡以解除等待。

| 相关任务/PR | 文件冲突面 | 基线顺序与处理 |
| --- | --- | --- |
| P0 Hub noindex，`4b542254-bf8a-4106-b763-216b82bbddbf` | `worker/seo.ts`、`scripts/_check_seo.mjs` | 已先合入 `201df9a26308a143e8021ec341aba34a42256514`，本卡开发应承接包含其提交的最新 main |
| 首页定位，`7f4a905b-3418-4e7e-b688-4d2273f3119a` | 四语 i18n、`worker/seo.ts`、SEO 测试，按最终 diff 复核 | 沿用首页内部需求文档既定顺序，实际同期重叠时首页先合并，本卡以包含首页改动的 main 为后续合入基线。本轮首页尚无 OPEN PR，允许本卡独立开发；人工合并后的冲突处理保留双方各自语义 |
| P0 Web Analytics，`5f2448cd-ea52-42f8-aa1b-ad5d8b064b5e` | 当前首选方案无直接重叠；若对方改动 Worker/共享入口则按实际 diff 判断 | 发生同文件冲突时 P0 先合并，本卡承接该 main |
| 原 P0 注册/事件卡 `4ff7da07-07a5-4184-838d-667c10661baf`，当前开放注册归因 PR #5 | PR #5 涉及 `package.json`、`spa/src/api.ts`；原卡与 #5 身份分别保留 | 若最终必须修改重叠文件，注册归因先合并，本卡基于合入后的 main；优先使用已有类型和测试入口避免无必要重叠 |
| MCP/助手指南后续独立卡 | 四语 i18n、SEO 文案/测试可能重叠 | 本卡定价与 BYOK 事实说明先合并，后续指南卡以包含本卡的 main 为基线；以实际 OPEN PR 文件清单再次核对 |

共享文件顺序属于集成约定，不替代功能依赖证据。开发与开 PR 前再次查询所有 OPEN PR 的实际文件清单，仅文件重叠按工作流处理。其他卡的内容和状态由其各自负责人维护。

建议依次做价格/Offer 链路、权益与四语修正、必要回归与证据三个小提交，按实际关联可合并相邻步骤。每个提交信息含完整本卡 ID，每个提交单独自审，最终整卡一个 PR。

回滚单元是本 PR 的全部展示、测试和内部文档变更。经届时授权后 revert 本卡提交，并保留其他卡对共享文件的改动。本方案无需数据库回滚或权益数据迁移。

**本轮评估记录**

已完成任务原文、前会话状态、分支/工作区、远端 main、在途 PR、SSR/React 价目链路、四语旧文案、会员与计费例外的源码核对。沙箱 GitHub DNS 失败后，通过批准的只读命令取得上述 main SHA 与 PR 清单。

本轮实际改动为新增本需求文档及保存 Kandev 任务计划，功能代码待开发。当前工作区尚无 `node_modules`。已执行 `node scripts/_check_docs_center.mjs`，真实输出为「文档中心：14 通过，0 失败」，该脚本检查源码结构。需求字段、引用路径、直接公开源码引用和文档空白检查通过。辅助检查首次把 `git diff --no-index` 的正常差异退出码 1 判作失败，随后结合无诊断输出及逐行空白检查纠正并重跑通过。应用行为测试、类型检查、构建、浏览器验收、实际数据库、外部服务模拟和生产验收均待开发阶段执行或另行授权。

本轮已确认尚无关联 PR。Kandev 返回的自动化状态为空，自动合并状态尚不可确认；创建并关联唯一 PR 后须读取并确保 GitHub/Kandev 自动合并关闭，交付保持 OPEN。

评估结论为可按本卡原子实施。交接后开发会话先读取本文件和任务描述，核对最新 main 与在途 PR，再按验收标准实现。具体实现如确需扩大框架、配置、迁移或授权范围，应先说明理由与成本并取得用户同意。

## 开发记录 · 2026-11-29

实际开发基线为 `201df9a26308a143e8021ec341aba34a42256514`，原需求基线为 `7b5c59d1f8f99d9011c891f5cb889285a04da0a6`。任务分支已 rebase 到前者，包含已合入的 Hub noindex 变更。关系查询返回 `blocked_by=[]`、`blockers=[]`，本卡无功能前驱。已读取 Hub PR #6 的远端状态，状态 MERGED，合并 SHA 与基线相同，web、backend、macOS、Windows、secrets 五项 CI 均 SUCCESS，GitHub reviews 列表为空。本卡功能无需等待该卡之外的前置实现。

### 价格与 Offer

第一个提交为 `436f9127b6bfb9fb7ba1305014bfd76e6da337b5`，提交信息包含本卡完整 ID。

- 根因是 SSR 价目读取仅用于容量，正文与结构化数据没有会员价格。当前由定价请求入口获取一份公开价目，选出有效报价并传给正文与 JSON-LD，沿用按后端地址隔离的 5 分钟缓存与 1500ms 请求超时。
- `billingCore.ts` 新增有效会员报价过滤和十进制金额转换，SSR 与 React 复用币种映射、选价与金额格式化。只接受当前支持的四币种及正的安全整数最小单位金额。接口无有效报价时保持免费价格与权益，显示价格失败提示并省略付费 Offer。
- 定价页在 BreadcrumbList 之外输出 SoftwareApplication 与免费/终身 Offer。两档币种一致，免费为 0，会员价格使用接口最小单位转换，JPY 保留整数。Offer 描述复用页面的一次性付款和无自动续费文案。
- React 价目请求加载和失败期间继续显示权益与 FAQ，购买按钮在缺报价时禁用。语言默认币种会跟随四语切换，用户手动选择的币种继续作为结算参数。
- 初次尝试复用 `api.ts` 的 BillingPricing 类型时，Worker 类型检查引入浏览器和桌面传递依赖而失败。已改为只复用纯 `BillingPrice`，在 Worker 中声明公开响应需要的字段，最终类型检查通过。未修改浏览器 API 文件。
- 自审覆盖公开请求头、后端地址、禁止重定向、HTML/JSON 转义、HEAD、缓存有效期和 React 结算入口。第一个提交的代码与新增测试已逐文件检查，空白检查通过。
- `npm run test:seo` 实际输出包含 `SEO checks passed`、`Pricing SSR: four currencies, free/paid offers, cache refresh, fallback, failures, timeout and HEAD passed`、`Pricing React: four locales, loading/error recovery, currency selection, membership and credits checkout passed`。
- 新增测试调用真实 Worker 入口和真实 PricingPage/I18n/React Query 组件。后端价目、会话、支付跳转和路由使用受控模拟，DOM 为 Linkedom。错误用例涵盖非成功响应、重定向、坏 JSON、空或无效价目、网络异常、真实 AbortSignal 超时、缓存到期失败及恢复。测试的 Node 超时模拟和 Lucide 模块适配问题均已修正后重跑通过。

### 四语权益与计费说明

- 根因是个人渠道停用后，四语定价 FAQ、文档中心、旧渠道提示和设置升级说明仍保留旧承诺。已修改 `pricing`、`docsCenter.workflows` 中对应句，以及 `agentModelSettings.description/byokUnavailable`、`llmChannels.description/membersOnly`、`agentReview.byokHint`、`settingsPage.aiLockedDescription`。
- 免费权益包含 1 份可更新的加密配置快照，会员表包含 MCP、历史、站内 AI、1,000 credits、公众号、封面、飞书、Hub 与多份配置快照。FAQ 明确三项 20 credits、X 草稿已创建后的扣费、MCP 微信专项授权免扣和存储计量。各语言的对应项目与段落齐全。
- 相关 X 发布确认提示与 `x_article_draft_only` 错误文案同步补充 20 credits 扣费说明，消费入口与定价说明一致。现有后端扣费分支和会员/授权检查保持原有实现。
- 新增四语回归同时核对后端现有 1,000/20/1 额度常量与用户说明，防止未来规则变化后文案静默过期。此检查属于源码规则核对。
- 定向验证实际输出为 `i18n: 880 passed, 0 failed`、`account pages: 57 passed, 0 failed`、`desktop billing: 34 passed, 0 failed`、`quota wiring: 67 passed, 0 failed`。
- 历史 CHANGELOG 与历史 BYOK 审阅记录的费用来源说明保留历史语义；当前界面已无个人渠道免 credits 承诺。

### 验证环境与执行过程

依赖已按现有 lockfile 安装。第一次沙箱安装遇到 DNS EAI_AGAIN，获准重跑后成功安装 389 个包，依赖清单和 lockfile 没有改动。本机现有 `/tmp/d43ace76-tools/go/bin/go` 为 Go 1.25.0，满足仓库 Go 1.23.0 要求，全量测试通过临时 PATH 使用它，GOCACHE 指向本卡 `/tmp` 目录。

类型检查实际输出 `Types at worker-configuration.d.ts are up to date.`，SPA 与 Worker 的 `tsc --noEmit` 均通过。完整 `npm test` 首次在 `test:share-preview` 因沙箱 `spawnSync go EPERM` 中止，已获准在沙箱外重跑；最终全量、构建、HTTP/浏览器和隔离检查结果续记于下节。

重活前资源检查可用内存约 21 GiB。发现其他 Python 密集任务后暂停启动全量测试，确认其退出后串行执行。每次重测试与构建继续遵守相同资源门槛。


### 最终验证结果

全部应用代码和四语修改完成后，已串行执行以下验证。补写本节期间仅更新内部记录。

| 执行项 | 真实结果 | 证据层级与范围 |
| --- | --- | --- |
| `npm run typecheck` | 退出 0，Wrangler 输出 `Types at worker-configuration.d.ts are up to date.`，SPA 与 Worker TypeScript 检查通过 | 类型与绑定检查 |
| `npm test` | 提升权限重跑退出 0，执行到最后一项 `test:koi-skills`；最后输出 `ok koinote/backend/internal/server 0.009s` 与 `Koi Skill UI passed` | 现有全量 npm 检查，包含相关 Go 子测试和本地 R2 模拟，未执行完整后端数据库套件 |
| `npm run test:seo` | `SEO checks passed`，新增 Pricing SSR 与 Pricing React 汇总均 passed | 真实 Worker 和组件入口，受控模拟价目、会话、路由与支付 |
| `npm run test:i18n` | `i18n: 880 passed, 0 failed` | 四语键、规则常量与文案静态回归 |
| `npm run test:account-pages` / `test:desktop-billing` / `test:quota` | 分别为 57、34、67 passed，均 0 failed | 相关账户、桌面计费和额度回归 |
| `npm run build` | 退出 0，`2758 modules transformed`，`built in 5.68s`，复制 20 个 KaTeX 字体 | 实际 Vite 生产产物；保留大于 500 kB 的 chunk 提示，最大主包 1,982.16 kB，gzip 624.61 kB |
| `wrangler deploy --dry-run --outdir /tmp/koinote-pricing-validation/wrangler-bundle --metafile /tmp/koinote-pricing-validation/wrangler-meta.json --env-file /dev/null --no-autoconfig` | 退出 0，读取 135 个静态资源，Worker 1501.19 KiB，gzip 375.66 KiB，结尾 `--dry-run: exiting now.` | Wrangler 本地打包与配置检查，未上传 Worker |
| Go 公开价目定向测试 | `TestLifetimePriceForUsesAllowlistedCurrencies` 和 `TestBillingPricingIsPublicAndUsesConfiguredQuota` 均 PASS，`ok koinote/backend/internal/server 0.008s` | 真实 Go 路由处理器与配置值，httptest 请求，未连接数据库或 Stripe |
| 本地 HTTP 与 Chromium | 9 项全部通过，禁 JS 5 项、启 JS 4 项；均无横向溢出，启 JS 页面无 pageerror | Miniflare/Workerd 执行真实 Worker，ASSETS 使用实际 spa/dist，后端价目与未登录会话为回环模拟服务 |
| 内部文档隔离 | 扫描 139 个 SPA/Worker 产物文件及 43 个 Worker 构建输入，内部文档匹配数为 0 | 扫描目录名、需求文件名、完整卡号和文档标题；公开源码和构建脚本引用检查同样无匹配 |
| 空白与脚本语法 | `git diff --check`、新增定价测试和 i18n 检查脚本的 `node --check` 全部退出 0 | 仓库没有独立 lint script |

Go 定向命令在 `backend` 目录执行，为 `PATH=/tmp/d43ace76-tools/go/bin:$PATH GOCACHE=/tmp/koinote-pricing-go-cache go test ./internal/server -run '^(TestLifetimePriceForUsesAllowlistedCurrencies|TestBillingPricingIsPublicAndUsesConfiguredQuota)$' -count=1 -v`。全量 npm 使用相同 PATH/GOCACHE，并设置 `WRANGLER_LOG_PATH=/tmp/koinote-pricing-validation/wrangler`。

本地 HTTP 核对 `/pricing` 的日语 Accept-Language 与 `?lang=zh|en|fr|ja`，禁 JS 页面分别取得 CNY 29.00、USD 3.99、EUR 3.99、JPY 600 的受控价目及两个 Offer。变化价目的测试另外使用 7.49、53.00、10.99、1234，验证来源与单位换算。启 JS 四语手机页面都可切换到 JPY 600、看到三项收费说明及登录升级入口。已查看中文手机与英文桌面完整截图，权益、FAQ 与长脚注可读。

本地 `/internal-docs/koinote-pricing-ssr-offers.md` 和 `/api/docs/koinote-pricing-ssr-offers` 均返回 404，未出现内部文档标识。后一请求由模拟后端返回 404，因此只证明本次本地路由行为。真实代码中的公开文档路由未读取内部文档，最终 Vite 产物、Wrangler bundle、sourcemap 与构建输入检查补充证明本卡文档没有进入公开包。

浏览器验收辅助脚本首次使用同步 curl 阻塞了同进程模拟服务。已停止该测试进程组，改成异步 execFile 后重新执行，最终九项通过。该问题发生在临时验收脚本。复查资源时 load 为 0.62 / 0.87 / 1.27，MemAvailable 为 22,759,204 KiB，未观察到并行测试或构建重任务。

### 逐项闭环与自审

| 根因或验收点 | 实际改动与受影响链路 | 验证结果 | 剩余限制 |
| --- | --- | --- | --- |
| SSR 缺价与 Offer 缺失 | 公开价目 → Worker 缓存 → 选币 → 可见正文与 JSON-LD；billingCore 复用到 React | 四语、缺币种、价目变化、缓存更新、JPY、两档 Offer、canonical 和原 Hub noindex 回归通过 | 实际生产价目与搜索展示待授权后观察 |
| 服务异常使正文不可读 | SSR 失败显示提示并保留免费价格/权益，React 加载与失败继续显示正文，缺报价禁用会员购买 | 503、302、坏 JSON、无效金额、网络错误、超时、恢复、HEAD 与组件回归通过 | 后端错误由测试模拟 |
| BYOK 旧承诺 | 四语 pricing、docsCenter.workflows、agentModelSettings、llmChannels、agentReview.byokHint、settingsPage.aiLockedDescription | i18n 与真实定价 SSR/组件检查通过 | 旧渠道卡组件当前未挂载，修正其保留资源；历史 BYOK 审阅记录保留原有费用来源语义 |
| 权益与计费例外不完整 | 免费 1 份配置快照、会员能力表、1,000 credits、三项 20 credits、X 草稿扣费、MCP 微信专项授权与封面另计；XPublishPanel 提示与错误映射一起更新 | 源码追溯现有规则，四语一致性和价格页面展示通过 | 未执行真实扣费、公众号/X/飞书外部调用或真实数据库验证 |
| 内部记录可能进入公开发布 | 需求文档只在仓库根 internal-docs，构建和运行入口保持既有布局 | 源码检查、139 个产物文件与 43 个输入扫描、上述两个本地 404 检查通过 | 本地 /api/docs 的后端为模拟服务；生产路径验收尚未执行 |

精确调用位置补充如下。

- `pricing` 由 `worker/seo.ts` 和 `spa/src/pages/PricingPage.tsx` 消费，`docsCenter.workflows` 由 SSR 文档中心和 `spa/src/pages/DocsPage.tsx` 消费。
- `settingsPage.aiLockedDescription` 用于 `spa/src/pages/SettingsPage.tsx`。`editor.xPublishOAuth2BillingHint` 用于 `spa/src/components/editor/XPublishPanel.tsx`，`errors.x_article_draft_only` 由错误码翻译链路显示。
- `AgentModelSettingsCard.tsx` 和 `LLMChannelsCard.tsx` 保留相关资源引用，当前页面没有挂载这两个旧渠道组件。`agentReview.byokHint` 当前无组件调用，修正该保留键可避免未来复用旧承诺。

第一个提交 `436f9127b6bfb9fb7ba1305014bfd76e6da337b5` 已单独检查实现与测试。第二个提交覆盖四语文案、i18n 回归和本内部文档，逐文件自审确认四语条目数量、免费额度、会员门槛和扣费例外对应一致，并检查实际消费位置与历史语义。最终提交 SHA 登记于 Kandev 任务计划与评审交接，整卡评审基线固定为 `201df9a26308a143e8021ec341aba34a42256514`。

原始工作流安排为开发完成后进入独立评审，PASS 后由「开 PR」阶段复用本分支创建本卡唯一 OPEN PR。后续负责人须核对最终 HEAD、远端 main、在途 PR 文件交集与首页优先顺序，并关联 PR、读回并关闭自动合并。本卡授权终点仍为经过独立评审的 OPEN PR，禁止合并、部署、启用自动合并。后续通用流程中的自动合并规则不适用于本卡，必须把本段限制继续传递。

证据保存在本机临时目录，原始日志为 `/tmp/koinote-pricing-full-test.log`、`/tmp/koinote-pricing-typecheck.log`、`/tmp/koinote-pricing-seo.log`、`/tmp/koinote-pricing-build.log`、`/tmp/koinote-pricing-worker-build.log` 和 `/tmp/koinote-pricing-browser.log`。HTTP HTML、截图、browser-results.json、isolation-results.json 和 Worker 元数据位于 `/tmp/koinote-pricing-validation/`，可供本机独立评审复核，临时证据不随 PR 打包。真实数据库、生产验收和本卡远端 CI 均未执行。
