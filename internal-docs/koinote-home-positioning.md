# Koinote 首页与公开实体定位需求评审

评审日期为 2026-11-28，时区 Asia/Singapore。任务为 `7f4a905b-3418-4e7e-b688-4d2273f3119a`，完整标题为「koinote 首页与公开实体重写：改为个人 AI 知识文档库定位，并删除『接你自己的图床』」。

## 评审结论与交付责任

本卡是一个原子任务，交付一个以 `main` 为目标分支的 PR。唯一目标是让首页正文、四语元数据、结构化数据和 README 开头对同一产品定位作出真实、一致的表达。Worker 与 SPA 是同一首页的两个渲染入口，相关文件应一起验收、一起回滚。无需拆卡。

优先级为 P1。整体风险为中等，主要风险来自能力与会员权益表述、四语摘要截断和共用 SEO 入口的回归。允许改动限于展示、相关测试与内部文档，涉及的业务代码作为能力核实依据。任何新增计费、鉴权、数据存储或生产配置需求均须另行说明必要性与成本，并取得用户同意。

PR 负责人为本卡「开发中」主会话，当前分配的 agent profile 为 `92d67037-1df0-4f19-bf5e-8cb0c4965f2b`。负责人承担实现、各提交自审、测试证据与唯一 PR 的交付；「待评审」阶段承担独立评审。Coder 负责后续合并和上线授权。本卡交付止于保持 OPEN 的 PR，禁止合并、部署或启用自动合并，该约束优先于后续工作流的默认合并提示。2026-11-28 尝试在任务层关闭自动合并时，服务返回 `preflight_failed`，原因为尚无关联 PR，自动化状态未能确认。创建并关联 PR 后须读取并关闭 GitHub/Kandev 自动合并，再交付 OPEN PR。

需求评审阶段指令已明确授权将当前原子卡移入开发，覆盖卡面创建时的暂缓状态。以下需求、基线与评审检查保留当时记录，开发完成状态及最终验证结果见本文末尾。

## 基线与前次会话

- 需求记录基线为 `7b5c59d1f8f99d9011c891f5cb889285a04da0a6`。
- 2026-11-28 只读执行 `git ls-remote origin refs/heads/main`，远端 `main` 仍为上述 SHA。
- 本地分支为 `feature/koinote-ai-xik`，HEAD 等于上述基线。评估开始时工作区干净，与基线无代码差异。
- 前次会话于 2026-11-26 被用户取消，仅留下只读调查记录。恢复时没有需求文档、任务计划或关联 PR。
- 2026-11-28 查询仓库全部开放 PR 返回空数组，当前未发现开放 PR 文件冲突。
- 需求引用的 `/workspace/seo-reports/2026-11-26/koinote-audit/` 在本执行环境不存在。历史 GSC 数据与线上抓取结论来自卡片，未作为本轮实测；代码核对足以确定实现边界。

## 目标与内容口径

中文首句采用已确认的定位。

> 个人 AI 知识文档库：Markdown 写作与整理，并通过 MCP 让你的 Agent 安全检索、读取和修改文档。

英文采用忠实对应的表述。

> A personal AI knowledge-document library for Markdown writing and organization, with MCP access that lets your agents securely search, read, and edit your documents.

四语标题品类采用下列对应词，译文可按自然表达微调，产品语义须一致。

| 语言 | 品类 |
| --- | --- |
| zh | 个人 AI 知识文档库 |
| en | Personal AI Knowledge-Document Library |
| fr | Bibliothèque personnelle de documents et de connaissances pour l’IA |
| ja | AI と使う個人用ナレッジ・ドキュメントライブラリ |

`Koinote` 为主品牌，MCP 客户端可举 Codex、Claude Code、OpenCode、OpenClaw。首句、title、description、OG 以用户理解的品类与能力为主。站内名称 Koi AI 可在功能介绍中附带解释。

首屏及紧随其后的能力说明按写、用、管组织，优先复用当前功能卡片与 MCP 区块。

- 写包括 Markdown 写作、整理、自动保存、图片粘贴或拖入后上传到 Koinote 图床。免费版覆盖编辑、同步、图床、导出和只读分享。
- 用包括通过 MCP 在授权范围内搜索、读取和修改文档，以及站内 AI 助手。两项都在相邻正文明确标注需要终身会员。AI 用量遵循现有 credits 规则，避免承诺无限使用。
- 管包括文件夹、标题与正文搜索、版本恢复、四种导出格式和发布辅助。版本能力应保留完整历史的会员条件及安全快照边界。
- 发布说明明确微信公众号保存到草稿箱、知乎 OpenAPI 直发或复制辅助、X 文章发布，以及终身会员从 Koinote 向飞书单向同步。平台授权与现有账号条件应有简短说明，X 发布按现有规则消耗 credits。免费导出与第三方发布在表述上各自写清，避免连读成全部免费。
- 桌面端可用一句说明支持本地优先及完全本地加密模式，本卡采用简短说明。Hub 专区与下载页改版由对应需求承担。

## 根因与代码证据

| 问题 | 根因与现有证据 | 实施时受影响链路 |
| --- | --- | --- |
| 品类仍是在线编辑器 | `spa/src/seoMeta.ts` 的四语 `SITE_TAGLINE` 和 `home.subtitle` 仍采用旧定位 | i18n → `publicPageMeta` → Worker 首屏及 AppShell 页面标题、摘要 |
| 正文与元数据容易遗漏 | `HomePage.tsx` 和 `worker/seo.ts` 的 `pageBody(home)` 分别消费同一组首页字段；`spa/index.html` 又有静态默认 title 与 description | 默认 HTML → Worker 注入 → React 挂载与切换语言 |
| 公开实体字段过时 | `structuredData(home)` 的 SoftwareApplication alternateName 来自旧 tagline，类别为 UtilitiesApplication，WebSite 缺少 description | 首页 JSON-LD → 搜索与社交抓取 |
| 能力与权益不清 | 四语 `home.features` 写自定义图床、基础导出；MCP 介绍缺少显式终身会员门槛 | 首页介绍 → 编辑器、会员与 MCP 入口 |
| 初次渲染和切换语言可能分叉 | `AppShell.tsx` 现有 effect 同步 title、description、canonical，未同步 OG；首页 JSON-LD 由 Worker 生成 | 首次直达及站内回首页、语言切换后的 head |
| 仓库入口沿用旧口径 | README 中文标题、英文简介及开头图床描述采用旧定位 | 仓库介绍与官网相互引用 |

已核实的能力依据如下。

- `spa/src/components/editor/MarkdownEditor.tsx` 调用 `uploadImage`，`worker/images.ts` 使用 `env.IMAGES.put` 写入图床。
- `backend/internal/server/document_search.go` 使用 `position(lower(query) in lower(title/content))` 匹配用户自己的有效文档。文案使用标题和正文搜索；语义检索、RAG、双向链接、图谱、标签不属于本次可宣传能力。
- `backend/internal/server/mcp_tokens.go` 的 `requireLifetimeMember`、`agent_sessions.go`、`writing_agent.go`、`feishu_docs_sync.go` 提供会员边界证据。
- `ExportMenu.tsx` 提供 Markdown、HTML、DOCX、PDF 导出及会员飞书同步入口。
- `WechatOfficialAccountPanel.tsx` 与现有公众号指南描述草稿箱流程；`ZhihuPublishPanel.tsx` 分别实现直发与复制后打开网页编辑器；现有知乎提示说明 OpenAPI 直发暂不支持图片。
- `XPublishPanel.tsx`、`backend/internal/server/x.go` 与现有 X 提示包含账号授权条件及 credits 消耗。官网正文概述这些条件，具体平台资格随现有配置和发布界面说明。
- `spa/src/desktop/localModeCrypto.ts` 提供本地加密实现。需要避免将完全本地模式描述为同时具备联网 MCP、云同步和发布。

以上均为源码核对，尚未执行真实用户操作、数据库或外部平台验证。

## 修改范围与最小实施方案

1. 在 `spa/src/seoMeta.ts` 修改四语 `SITE_TAGLINE`，继续复用 `defaultSiteTitle` 与 `publicPageMeta`。首页摘要要在现有 160 字符截断后保留品类、Markdown 与 MCP 等核心信息。优先缩短首页摘要，必要时仅给首页增加简短 SEO 描述字段。长篇发布条件放在紧邻能力说明中。
2. 在 `spa/src/i18n/{zh,en,fr,ja}.ts` 的首页字段完成四语定位、功能、图床、导出发布与会员条件。按实际字段变更同步 `types.ts`。在 `HomePage.tsx` 做承载这些内容所需的最小结构与图标调整。
3. 在 `worker/seo.ts` 的首页正文渲染中同步新增或调整后的字段。WebSite 与 SoftwareApplication 的 name 采用品牌加本地化品类，alternateName 包含本地化品类，description 复用首页 meta.description；SoftwareApplication 使用适合知识文档工具的 ProductivityApplication 类别。免费版本的 Offer 继续仅表达免费版本，避免推导出 Agent 免费。
4. 更新 `spa/index.html` 的默认中文标题、摘要。必要时在 `AppShell.tsx` 的既有 effect 中补齐首页 OG 和首页 JSON-LD 的语言同步，以共享文案生成结果。避免引入通用 SEO 框架或改变其他公开页的专属 meta 所有权。
5. README 中英文仅修正开头定位及与其紧邻、直接冲突的能力句，英文“your own bucket”一并纠正。正文其余章节维持各自原任务归属。
6. 扩展现有 `scripts/_check_seo.mjs`、`scripts/_check_i18n.mjs` 及其已有测试入口，覆盖本次四语正文、head 和 JSON-LD 契约。需要检查 DOM 时优先复用已有 `linkedom` 与测试设施。

预估为中等规模、约 12–14 个文本/前端/Worker/测试文件，实际文件数由验证需要决定。建议分为 2–3 个可审查的小提交，每个提交信息带本卡号，每次提交单独自审，最终 PR 仍按完整首页定位链路一次验收。内部文档随该功能 PR 提交。

## 范围边界

- 定价页面、FAQ、价格 SSR 由定价卡负责；首页只准确引用现有会员条件。
- `/docs/mcp`、Hub 正文、站内助手指南路径与命名分别由对应卡负责。
- Hub noindex、Web Analytics、注册归因和事件埋点由已有 P0 卡负责。
- 计费金额、会员资格、支付渠道、MCP 授权规则和既有有效 URL 属于本次必须保留的行为边界。
- 自定义图床、语义检索/RAG、双向链接/图谱/标签、自带模型 Key 免 credits、面向所有用户的 Skills 一键安装均不得出现在新增能力承诺中。负面词检查只覆盖本次交付文案与首页输出，历史文章和需求说明中的引用按各自语境处理。

## 依赖、分支与文件冲突

本卡无功能前驱，现有实现已提供所需能力。使用现有独立分支 `feature/koinote-ai-xik`，PR base 为 `main`。开工前重新核对远端 main，记录 BASE_SHA/HEAD_SHA；如 main 前进，将本卡改动带到最新 main 后重跑受影响检查，并在 PR 写明与需求记录基线的差异。提交只包含本卡内容。

当前没有开放 PR，因此本轮不增加阻塞边。下表记录潜在同文件冲突时的明确先后顺序，发生实际重叠时按此更新基线；若需要等待任务完成，只为本卡添加一个直接前驱，使用线性依赖，解除后自动启动。禁止通过自行合并前卡来解除等待。

| 其他任务 | 潜在重叠文件 | 出现同期重叠时的基线顺序 |
| --- | --- | --- |
| P0 Hub noindex，`4b542254-bf8a-4106-b763-216b82bbddbf` | `worker/seo.ts`、`scripts/_check_seo.mjs` | P0 先合并，本卡以包含其改动的 main 为基线，保留其仓库页与 sitemap 规则 |
| P0 Web Analytics，`5f2448cd-ea52-42f8-aa1b-ad5d8b064b5e` | `spa/index.html`，以及其实际选用的共享入口 | P0 先合并，本卡以包含其改动的 main 为基线，保留统计脚本 |
| P0 注册归因与事件，`4ff7da07-07a5-4184-838d-667c10661baf` | 取决于其真实 diff，可能涉及 `AppShell.tsx`、i18n、测试入口 | 若实际重叠则 P0 先合并，本卡以该 main 为基线；仅相同仓库不构成依赖 |
| 定价、MCP/助手指南等后续独立需求 | 四语 i18n、`worker/seo.ts`、`seoMeta.ts`、SEO 测试 | 当前无开放 PR 的条件下，本首页卡先合并，后续卡以该 main 为基线；若已有明确更早顺序，以实际任务安排复核并记录 |

上述 P0 卡身份与原范围维持原登记；本卡只记录自身冲突处置。开 PR 前重新读取开放 PR 及文件清单，按实际冲突面协调。用户禁止并行子 agent 或后台 AI，本卡由单一主会话串行完成。

## 验收标准

1. 本地 Worker 的 `/` 以及 `/?lang=zh|en|fr|ja` 返回 200。title、唯一的 meta description、og:title、og:description、JSON-LD 中两个实体的 name/alternateName/description 体现本地化个人 AI 知识文档库定位。旧编辑器品类与自定义图床承诺从首页输出移除，主语和主品牌符合已确认定位。
2. 四语可见首屏及相邻能力区均包含 Markdown 写作与整理、MCP 安全读写、站内助手、四种导出格式、微信公众号/知乎/X，以及飞书会员单向同步说明。MCP 与站内助手的终身会员门槛明确可见，免费版能力齐全，完整版本历史的会员条件准确。
3. 公众号表述为保存到草稿箱；知乎区分 OpenAPI 直发与复制辅助；X 有账号权限及 credits 条件提示；首页整体避免承诺所有平台一键成功、免费或无限使用。旧图床句的四语对应表达全部清除。
4. 浏览器直达四语首页、站内返回首页、主动切换语言后，H1/正文、title/description、OG 与首页 JSON-LD 使用相同当前语言和定位。测试同时检查语义预期与共用数据的一致性，避免仅让两个同样错误的值相等。
5. 窄屏 390px 与桌面宽度下可阅读、无横向溢出或 CTA 遮挡。写作、注册、下载、会员及 MCP 指南等原有入口继续可达，已有路由与 canonical/hreflang 契约通过回归。
6. README 中英文开头与首页定位一致。新增内部需求文档位于根目录 `internal-docs/`，文档内容不出现在公开文档列表、客户端/Worker bundle、静态资源目录或 `/api/docs` 响应中。
7. 四语正文和结构化数据有真实执行的自动化测试。记录相关测试、类型检查、构建及现有 CI 的实际结果，失败或跳过如实标注。每个 review 修复记录根因、实际改动、上下游链路、验证结果、剩余限制。

## 验证安排与证据边界

开发阶段优先执行仓库已有命令，按改动结果补齐有意义的回归。

- `npm run test:seo` 验证真实 Worker 入口生成的 HTML。现有 ASSETS 与后端为模拟，该结果属于运行代码加外部服务模拟验证。
- `npm run test:i18n` 验证四语内容契约，`npm run test:docs-center`、`npm run test:header-nav`、`npm run test:layout` 覆盖相关入口与布局。若修改 AppShell 元数据同步，补充实际 DOM/浏览器行为验证。
- `npm run typecheck` 与 `npm run build` 验证 SPA/Worker 类型和构建。构建后检查 `spa/dist` 与 Worker 打包产物不存在内部需求文本或文件名，并检查公开文档/API 输出。
- 使用本地 Worker 对上述五个首页 URL 抓取 HTML，再用浏览器验证四语与两种宽度。Vite 单独提供的 HTML 不足以证明 Worker 注入通过。运行参数先查本仓脚本与工具帮助。
- 当前仓库 `.github/workflows/ci.yml` 在 PR 执行 `npm test` 与构建，最终交付需记录适用 CI。仓库没有独立 lint script，按实际现有检查执行，避免虚构 lint 通过。
- 任何全量测试/构建之前检查 load、MemAvailable 与现有重活。已有重活或可用内存低于 2GiB 时等待并说明。全量测试和构建串行执行，全局会话上限 4。

本卡展示改动不需要实际数据库写入、扣费或外部平台发布。权限与能力结论目前来自代码，功能回归按真实执行层级记录。生产 curl、实际第三方发布、真实数据库验证及 GSC 结果均尚未执行。生产验证须等后续明确上线授权；首页查询结构与 CTR 属上线后观察项，不作为本 PR 验收条件。

## 内部文档隔离与需求评审阶段检查

Vite 的应用根为 `spa`，静态目录为根目录 `public`，输出为 `spa/dist`；Wrangler 的 assets 目录也是 `spa/dist`。公开文档由明确路由与 i18n 字段提供，Worker 当前只显式导入四份 CHANGELOG Markdown。仓库扫描未发现 `import.meta.glob`、`/api/docs` 内容生成器或 `internal-docs` 导入。

Wrangler 的 `**/*.md` 是已导入 Markdown 的模块类型规则，仍需在开发构建后核实最终产物。内部文档隔离采用根目录放置并保持零公开导入，本轮无需改动构建或部署配置。

本轮状态为需求评审完成、功能实现与验收待执行。已执行的检查记录如下。

- `node scripts/_check_docs_center.mjs` 输出「文档中心：14 通过，0 失败」。该脚本是静态接线断言，结果只证明现有文档入口契约通过。
- 内部文档路径检查确认文件位于仓库根 `internal-docs/`，并扫描公开源码、静态目录、构建脚本和配置，未发现对该目录或文件名的引用。
- `git diff --check` 返回 0；新增文档的 `git diff --no-index --check /dev/null internal-docs/koinote-home-positioning.md` 返回 1 且 stdout/stderr 均为空，表示存在新增差异、无 whitespace 报错。
- 本地没有 `node_modules`，本轮交付为需求文档，未安装依赖或执行功能测试、类型检查、构建和浏览器验收。真实 bundle 隔离验证仍待开发阶段完成。

## 回滚与交接

功能上线后的回滚单元为本卡单个 PR 的全部展示、测试和文档改动，由届时授权的负责人执行。由于本卡不引入 schema、迁移或数据写入，无数据库回滚步骤。回滚时保留其他卡在共享文件中的独立改动。

评审完成后将当前卡移动到「开发中」`ce7108c3-7888-4c98-9347-512e71ef0989`。开发会话首先读取本文件、复核最新 main 与冲突面，再落实上面的验收。后续每一项实际修复均在此文档补充结果，测试原型、源码核对和待执行计划分别标明。

## 开发实施记录（2026-11-28）

开发开始再次确认远端 `main` 与本地 HEAD 均为 `7b5c59d1f8f99d9011c891f5cb889285a04da0a6`。Kandev 返回 `blocked_by=[]`，本卡无功能前置依赖。沿用 `feature/koinote-ai-xik`，由当前主会话串行实施。

### 根因、实际改动与链路

| 根因 | 实际改动 | 受影响链路与验证依据 |
| --- | --- | --- |
| 首页品类及能力说明过时 | 四语 `home` 重写为个人 AI 知识文档库，六张功能卡承载写、用、管、图床、导出、发布，首屏补充会员说明 | 四语字段 → HomePage 与 Worker 首页正文；SEO 语义断言、真实组件 DOM 检查 |
| SEO 与实体仍沿用编辑器定位 | `SITE_TAGLINE` 更新，抽出共用 `homeStructuredData`；WebSite/SoftwareApplication 的名称、别名与摘要统一，类别改为 ProductivityApplication | `seoMeta.ts` → Worker 首屏及浏览器首页 JSON-LD；各语种实体字段逐项比较 |
| 静态外壳及仓库入口缺少同步 | 更新 `spa/index.html` 和中英文 README 开头 | 默认 HTML 与仓库简介；模板源内容、首页 Worker 输出核对 |
| 首屏缺少权益和发布条件 | 说明免费编辑/同步/图床/导出/分享、MCP 与站内助手需终身会员、AI credits、公众号草稿、知乎两条路径、X 权限及 credits、飞书会员单向同步 | 展示文案与现有入口代码核对，首页正文测试；无真实扣费或外部发布 |
| 浏览器切换语言后 OG 与 JSON-LD 不随正文更新 | HomePage 挂载 effect 同步首页 OG、Twitter 与 JSON-LD，离开首页时还原原有 head，移除临时创建的节点 | 实际首页组件与 I18nProvider，在英文 Worker 首屏、纯 SPA 外壳、其他公开页已有实体三类初始状态下执行；60 次语言渲染、12 组挂载/退出场景通过 |

实施选择是在 HomePage 内限定元数据同步的生命周期，复用 AppShell 已有的 title、description、canonical 更新。四语摘要全部控制在 160 字符内，法语为 157 字符，因此继续直接复用 `home.subtitle`，无需新增独立 SEO 描述字段。会员说明与桌面模式说明各增加一个首页字段。

### 范围自审

- 首轮实现逐一比较四语字典 `home` 之外文本，均逐字一致。浏览器检查随后发现共享页脚的旧定位遗漏，最终字典差异限定为 `home` 与删除重复的 `footer.tagline`，其余段落逐字一致。
- 本次业务实现改动仅涉及首页展示与 SEO。后端、计费/会员判断、数据库、桌面实现、部署配置及依赖锁文件没有差异。
- JSON-LD 通过共享函数生成。Worker 保留原有安全 JSON 序列化，浏览器使用 `textContent`，避免把文案作为 HTML 执行。
- 新增测试复用仓库现有 esbuild、React 和 linkedom。`test:seo` 接入首页 DOM 回归；没有新增测试依赖。

### 验证过程中的环境问题

首次类型检查完成后 Wrangler 报沙箱日志目录只读，随后在获准的正常目录权限环境重跑 `npm run typecheck`，退出 0，SPA 与 Worker 类型检查、Worker 类型生成一致性均通过。

第一次 `npm test` 在 `test:share-preview` 调用 `go` 时返回 `spawnSync go EACCES`。原因是当前 PATH 未包含可用 Go 工具链。使用本机已有 `/tmp/d43ace76-tools/go/bin` 补充本次命令 PATH 后重新执行完整测试；结果以最终验证记录为准。

首页 DOM 测试最初遇到 lucide-react 的 CommonJS 打包入口问题，测试适配为优先读取现有包的 module 入口。修正后真实组件的 60 次语言渲染和 12 组生命周期检查通过，该问题涉及测试加载方式。


### 浏览器自审发现与修复

首轮四语浏览器检查通过了标题/正文、OG/JSON-LD、语言切换、入口往返与无横向溢出断言。人工查看整页截图时发现页脚仍沿用在线编辑器品类，英文和法文还带有自己的图床含义。根因为 `AppFooter.tsx` 单独读取 `footer.tagline`，与首页定位来源分离。

实际修复为 AppFooter 直接读取 `home.subtitle`，删除四语及类型定义中已无用途的 footer.tagline，并调整既有页脚译文检查。此变更覆盖所有展示该共享页脚的页面，只同步品牌摘要。

新增的真实组件断言先在旧页脚上运行，明确报出“页脚必须复用同一产品定位摘要”，实际值为旧英文编辑器与 image store 句。修复后 SEO/DOM 测试通过，仍为 60 次语言渲染、12 组生命周期场景；i18n 为 859 通过、0 失败（删除了四个重复字段的非空检查）；文档中心为 14 通过、0 失败。

截图首次捕获到已有 1.1 秒标题动画的模糊中间帧，截图流程改为等待字体并快进有限动画，产品动画实现保留原状。最终视觉验收以重新构建后的稳定截图为准。


## 开发最终验证与交接（2026-11-28）

本卡开发实现与本地验收完成，下一阶段为独立评审。任务交付终点仍为一个保持 OPEN 的 PR。工作流在独立评审通过后进入「开 PR」，本开发阶段尚无关联 PR，远端 CI 尚未产生。创建并关联后，负责会话须读取并关闭 GitHub 与 Kandev 自动合并。用户关于禁止合并、部署和自动合并的指令继续适用于所有后续阶段。

### 提交基线与逐提交自审

- BASE_SHA 为 `7b5c59d1f8f99d9011c891f5cb889285a04da0a6`。开发开始与最终验收期间均执行 `git ls-remote origin refs/heads/main`，返回同一 SHA。
- 功能 HEAD 为 `f60df1f713294a2b00bf63badbcef8c340b61cd6`。以下全量测试、最终构建、HTTP 与浏览器验证均针对该功能提交。后续第三个提交仅纳入本内部文档，最终交付 HEAD 记录在任务计划与阶段报告中。
- `89ca6913fc49142957a74d333173d89e5fd31f71` 完成四语首页、静态模板、共享 SEO/JSON-LD、浏览器 head、README 与测试。自审覆盖字典 → SPA/Worker → 搜索实体整条链路，核对会员与发布能力的现有实现，以及 HTML/JSON 序列化方式。
- `f60df1f713294a2b00bf63badbcef8c340b61cd6` 修复截图中发现的共享页脚旧定位。自审覆盖 AppFooter 的所有使用页、四语类型与测试接线，修前新增断言真实失败，修后全量测试通过。根因、受影响链路及修复见上一节。
- 第三个提交纳入本需求与验证记录。提交前自审确认内部文件路径、公开导入及构建产物隔离、验收覆盖和验证层级，使用 Git whitespace 检查。每个提交信息均带完整卡号。
- 最终只读查询 `gh pr list -R moutsea/koinote --state open --json number,title,headRefName,baseRefName,isDraft` 返回 `[]`。无当前开放 PR 冲突，开 PR 阶段仍须再次核对。

### 自动化检查的真实输出

| 检查 | 实际结果 | 证据与层级 |
| --- | --- | --- |
| `PATH="/tmp/d43ace76-tools/go/bin:$PATH" npm test` | 退出 0，完成 77 个专项脚本及 SPA/Worker 类型检查 | `/tmp/koinote-home-full-test-final.log`，本地仓库完整 npm 测试入口 |
| SEO 与首页 DOM | `SEO checks passed`；`HomePage DOM checks passed (60 locale renders, 12 mount/unmount scenarios)` | 同一全量日志，Worker 代码与真实 React 组件运行，外部服务、登录和 DOM 路由使用测试适配 |
| 四语 | `i18n: 859 passed, 0 failed` | 同一全量日志，四语语义与结构化数据契约 |
| 文档与导航 | `文档中心：14 通过，0 失败`；`header nav checks passed` | 同一全量日志，相关静态与逻辑检查 |
| 布局 | `layout: 149 passed, 0 failed` | 同一全量日志，布局契约检查 |
| 分享预览 | backend/Markdown-it/TipTap 187 项、destination 42 项、reference 135 项通过 | 同一全量日志，使用本机现有 Go 工具链运行跨端渲染回归 |
| 最终 `npm run build` | 退出 0，`built in 5.98s`，复制 20 个 KaTeX 字体 | `/tmp/koinote-home-build-final.log`，最终生产格式前端产物 |
| JavaScript 语法 | `_check_home_page.mjs`、`_check_i18n.mjs`、`_check_seo.mjs` 的 `node --check` 均退出 0 | 本地实际命令 |
| Git whitespace | `git diff --check` 与最终暂存检查无输出、退出 0 | 本地实际命令 |
| lint | 仓库 `package.json` 无独立 lint script | 已核实脚本配置，记录为不适用 |

SEO 日志中的 `seo render failed { path: '/docs', error: 'Error: asset fetch failed' }` 来自已有的资源读取失败回归场景，随后的 SEO 成功标记和整个测试命令退出码均为通过。初次 Go PATH 与 Wrangler 日志目录问题已按上一节恢复并重新执行。

构建输出包含字体在构建期未解析和大于 500 kB chunk 提示。构建插件实际复制 20 个字体，最终本地 Worker 对全部 20 个字体资源返回 200 且内容非空。chunk 大小提示仍存在，本卡未做拆包改造。

### HTTP、浏览器与内部文档隔离

本地测试服务使用仓库 Wrangler，加载最终 `spa/dist`。命令为 `node node_modules/wrangler/bin/wrangler.js dev --local --env-file /dev/null --ip 127.0.0.1 --port 8797 --inspector-port 9297 --persist-to /tmp/koinote-home-worker-state --var BACKEND_URL:http://127.0.0.1:18889 --log-level warn`。验证完成后已停止该服务。

- `/` 与 `/?lang=zh|en|fr|ja` 共五个 URL 均返回 200。逐一检查 title、唯一 description、OG 标题/摘要，以及 WebSite/SoftwareApplication 的 name、alternateName、description，一致且符合四语新定位。默认请求携带英文 Accept-Language。HTML 与结果保存在 `/tmp/koinote-home-http/`。
- Chromium 使用真实 Worker HTML 和生产格式前端资源，检查四语各自直达、390px 与 1440px 两种宽度，共 8 组通过。每组切换四次语言并从 MCP 指南返回首页，合计 32 次切换、8 次往返。H1、页脚、title/description、OG 与 JSON-LD 同步，页面异常为零，横向溢出为零，写作/注册/会员/MCP 指南按钮边界均在视口内。
- 人工复看法语 390px 与中文 1440px 最终整页截图，标题、功能卡、发布条件与页脚可读，CTA 无遮挡。截图已等待字体加载并快进有限动画。脚本为 `/tmp/koinote-home-browser.mjs`，最终输出为 `/tmp/koinote-home-browser-final.log`，截图与结构化结果位于 `/tmp/koinote-home-browser/`。
- 浏览器的 `/api/**` 使用未登录会话等模拟响应。此结果覆盖展示、导航与语言生命周期。真实账号、付费、文档写入及外部平台发布尚未验收。
- 最终扫描 `spa/dist` 的 133 个文件与 `.wrangler/tmp` 的 8 个文件，内部目录名、需求文件名及内部文档特征文本均为零命中。扫描结果保存在 `/tmp/koinote-home-isolation-final.json`。
- 本地 Worker 对 `/internal-docs/koinote-home-positioning.md` 和 `/docs/internal-docs/koinote-home-positioning.md` 均返回 404；`/docs?lang=zh` 返回 200。三者均无内部文档内容。
- 使用临时 Go overlay 测试真实 `App{}.Routes()`，`/api/docs`、`/api/docs/internal-docs/koinote-home-positioning.md`、`/internal-docs/koinote-home-positioning.md` 均返回 404，响应为 `404 page not found`。实际输出含 `PASS` 与 `ok koinote/backend/internal/server 0.012s`，保存在 `/tmp/koinote-home-api-isolation-final.log`。测试源为 `/tmp/koinote-home-isolation-test.go`，未连接数据库，路由使用实际实现。

### 验收逐项对应

1. 五个首页 URL、四语元数据与实体通过最终 HTTP 和 SEO 自动化检查。
2. Markdown、MCP、站内助手、四种导出、三方发布与会员条件通过四语正文断言，浏览器确认可见。
3. 公众号草稿箱、知乎 OpenAPI/复制辅助与图片限制、X 权限/credits、飞书单向同步在四语正文中明确，图床承诺已改为 Koinote 图床。相关权益及权限仅作源码核对。
4. 四语直达、主动切换与指南返回的正文/head 同步通过真实浏览器验证；DOM 同时覆盖不同初始 head、StrictMode 和卸载还原。
5. 两种宽度通过程序检查，最终截图已人工复核；现有导航契约回归通过。
6. 中英文 README 开头已同步。内部文档路径、源码引用、公开列表、前端与 Worker 产物及真实后端路由隔离均已检查。
7. 四语语义、结构化数据、首页生命周期测试已随功能提交，全量 npm 测试、类型检查与构建通过。远端 CI 待开 PR 后核对。

### 剩余限制与独立评审入口

本轮未执行真实数据库验收、真实外部平台发布/扣费、桌面原生平台编译或生产验收。PR 的仓库 CI 还包括 PostgreSQL、后端 race 和 macOS/Windows 桌面编译等检查，须在开 PR 阶段记录各 job 的真实结果。本地记录保存在 `/tmp`，持久结论与命令在本文件，自动化测试已进入代码仓库。

独立评审须审 BASE_SHA 至最终交付 HEAD 的完整差异，覆盖四语正文/README、SEO/Worker/浏览器、共享页脚与相关回归。用户约束为单卡单 PR、保持 OPEN。评审通过后复用本分支推进唯一 PR，完成自动合并关闭及状态读回。
