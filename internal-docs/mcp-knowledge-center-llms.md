# MCP 知识库中心与 llms.txt 需求评审

本文件仅用于内部需求、开发交接与验收记录。存放于仓库根目录 `internal-docs/`，禁止复制到 `docs/`、`doc/`、`public/`，禁止加入前端或 Worker 文档 bundle、公开导入链及 `/api/docs`。

## 评审结论与责任

- 评审日期为 2026-11-29，时区 Asia/Singapore。
- 当前卡为 `c29e20c7-ef73-400a-aad7-98351f081d79`，标题为「koinote 建设 MCP 知识库中心页与 llms.txt，并拆分各客户端指南」。
- 判定为一个原子任务，由当前卡交付一个 PR。单一目标是让用户和无 JavaScript 的读取方通过公开文档准确理解并接入已有 MCP。总览、客户端子页和文本索引属于同一文档交付，SPA 与 Worker 是其两条呈现链路。
- 本卡可独立验收并通过回退本 PR 恢复。规模为中等，包含文档内容、路由、边缘正文、四语及对应测试，不以行数或文件数拆卡。
- 优先级为 P1，风险为中等。主要风险来自权限与费用误述、凭证示例落盘、客户端版本差异、SPA 与边缘路由不一致。产品后端行为不在改动范围内。
- PR 负责人为本卡「开发中」阶段承接的 Codex agent，使用当前配置的 agent profile `92d67037-1df0-4f19-bf5e-8cb0c4965f2b`。该负责人负责实现、逐提交自审、测试证据和单一 PR 的交付；「待评审」阶段负责独立评审，Coder 保留业务决策与合并授权。
- 交接依据为本轮用户明确要求评估完成后移入「开发中」。本轮交付需求文档与计划，随后通过工作流交接实现。
- 授权范围截至开 PR。禁止合并、部署或触发生产变更，此限制须传递至后续阶段。

## 已确认需求与当前状态

产品中文定位沿用用户确认的原文。

> 个人 AI 知识文档库：Markdown 写作与整理，并通过 MCP 让你的 Agent 安全检索、读取和修改文档。

英文以 Koinote 的个人 AI 知识文档库定位及 MCP-compatible agents 为主体。站内名称 Koi AI 可在适当上下文使用，页面 title、description、OG 的首要信息应说明产品与用途。

免费版覆盖编辑、同步、图床、导出和分享。文档 MCP、仓库 MCP 与站内 AI 助手需要终身会员。配置同步临时授权须按下文已核实的独立规则描述，避免扩大会员限制。

2026-11-26 的 GSC 数字与线上审查结论来自原始任务描述，只作为需求背景。本机不存在描述中的 `/workspace/seo-reports/2026-11-26/koinote-audit/` 文件，本轮未复查 GSC 或线上页面。

上一会话完成过只读工具数量与权限调查，没有留下实现提交或需求文档。本轮开始时工作区干净，HEAD 为 `7b5c59d1f8f99d9011c891f5cb889285a04da0a6`，无关联 PR。

### 已有实现及缺口

| 链路 | 已核实的现状 | 本卡要补齐的内容 |
| --- | --- | --- |
| `spa/src/pages/MCPGuidePage.tsx` | 已有四个客户端及通用客户端配置，已有仓库 MCP 简介 | 完整工具目录、准确边界及四个稳定子页入口 |
| `spa/src/i18n/{zh,en,fr,ja}.ts` | 已有 MCP 文案与客户端简述 | 总览、权限、费用提示和客户端页的准确四语表达 |
| `spa/src/main.tsx`、`spa/src/seoMeta.ts` | 只有 `/docs/mcp` 总览路由 | 客户端子页及其页面级元信息 |
| `worker/seo.ts` | MCP 静态正文只有概述、客户端简述等，缺少工具表和配置代码 | 无 JavaScript 时可读的目录、配置、边界与子页正文 |
| Worker 资源处理 | 未实现 `/llms.txt`；缺失文本资源可进入 HTML 404 处理 | 精确路径的 GET/HEAD 纯文本响应 |
| `README.md`、`README.en.md` | 已有接入说明，OpenCode 片段为 V1 结构，OpenClaw 记有 2026.6.10 验证说明 | 对应版本说明、必要配置更新及到子页的内链 |

根因是公开页面与代码中的工具注册、客户端配置和边缘渲染分散维护。最小方案是复用现有路由与 i18n，在一个小型公开内容模块中维护工具名、scope、分类和客户端配置，供 SPA 与 Worker 引用；以针对性测试对照 Go 注册名。避免引入目录生成框架、运行时 tools/list 请求或新的文档平台。

## 原子范围与排除项

### 交付范围

1. 将 `/docs/mcp` 改为总览，说明传输方式、端点、授权入口、会员要求、三类连接及完整工具目录。
2. 增加 `/docs/mcp/codex`、`/docs/mcp/claude-code`、`/docs/mcp/opencode`、`/docs/mcp/openclaw`。每页包含环境变量准备、可复制配置、适用版本、只读验证方式和常见鉴权问题。总览与子页互链。
3. 新增 `/llms.txt`。采用单个 UTF-8 纯文本资源，英文为主要说明，包含中、英、法、日四语的定位、会员及关键边界摘要。文本固定，不按请求语言变体复制完整文档。
4. 总览与四个子页沿用现有中、英、法、日语言选择方式，所有新增用户可见字段提供四语。配置代码与注册名保持原文。已有译文可复用，准确性须人工审阅。
5. 配套调整相关 README 段落、既有文档入口和测试，文案与内链并入本卡验收。

### 排除项

- `/llms-full.txt` 本轮排除，简洁文本索引已满足原始验收。
- OAuth MCP、语义检索、RAG、文件夹级授权、双向链接、知识图谱、标签和任何新协议能力均不实现。
- MCP 鉴权、工具行为、计费金额、会员权益、支付渠道、数据库迁移、配置密钥和部署流水线均不改动。
- 首页与定价页的站点级定位由独立卡负责。本卡仅修改 MCP 页面自身元信息及关联的必要内链。
- 已有 P0 卡 `4b542254-bf8a-4106-b763-216b82bbddbf`、`5f2448cd-ea52-42f8-aa1b-ad5d8b064b5e`、`4ff7da07-07a5-4184-838d-667c10661baf` 的范围和卡面保持既有归属。本卡不向这些卡写评论或重建其工作。
- 不为满足页面文案而补做产品能力；发现实现与原需求口径不符时，先据实限定文案，业务变更另需用户确认。

## 工具目录与权限口径

下列目录来自本轮读取的 Go 注册代码，原始基线与已核实的最新 main 在这三组注册文件上没有差异。开发交付前须按最终基线再核对，不将数量永久写死为产品承诺。

### 文档 MCP

端点为 `https://koinote.app/mcp`，连接名为 `koinote`。注册名去重后共 35 个，三种文档 scope 的可见数量分别为 read 16、write 34、publish 19。页面展示全部工具并注明 scope；一个令牌只能看见自己 scope 对应的工具。

只读组共 16 个，read、write、publish 均可见。

- `list_documents`、`search_documents`、`get_document`、`list_document_versions`
- `get_document_version`、`list_trashed_documents`、`get_document_history_settings`、`list_folders`
- `list_wechat_accounts`、`get_wechat_geo_summary`、`list_document_themes`、`get_agent_credits`
- `get_document_outline`、`get_document_context`、`compare_document_versions`、`find_text_in_document`

本地写入组中以下 15 个仅 write 可见。

- `create_document`、`append_to_document`、`update_document`、`restore_document_version`
- `trash_document`、`restore_trashed_document`、`update_document_history_settings`、`create_folder`
- `rename_folder`、`move_folder`、`move_document`、`batch_move_documents`、`delete_folder`
- `update_document_metadata`、`apply_text_patch`

`update_wechat_geo_summary` 属于本地摘要写入，write 和 publish 均可见。它编辑摘要或开关，代码说明不调用模型、不消耗 credits。

外部副作用组包括以下 3 个；说明须写清是否同时保存本地结果。

- `generate_wechat_geo_summary` 对 write 和 publish 可见，调用平台模型并保存摘要，消耗 credits。
- `sync_document_to_feishu` 仅 write 可见，需绑定飞书，将 Koinote 内容单向写入飞书并覆盖对应内容。
- `push_wechat_draft` 仅 publish 可见，向已绑定的微信公众号草稿箱写入，可上传图片，涉及 credits 与可选 AI 封面费用。费用提示沿用现有实现和定价说明，避免复制后失配；需要精确写数字时同时核对运营授权减免分支。

特别注意，publish 支持读取文档和管理 GEO 摘要，write 不包含 `push_wechat_draft`。不能把“仅发布”解释为完全没有读取或本地写入能力。

### 仓库 MCP

使用相同 `/mcp` 端点，连接名为 `koinote-agent`，环境变量用 `KOINOTE_AGENT_TOKEN`。通过 agent_read 或 agent_write 令牌选择仓库工具，与普通文档 PAT 区分。

只读组共 8 个，agent_read 和 agent_write 均可见。

- `list_agent_workspaces`、`get_agent_workspace`、`read_agent_workspace_file`、`get_agent_workspace_prompt`
- `get_agent_workspace_storage`、`list_agent_workspace_commits`、`get_agent_workspace_commit`、`read_agent_workspace_commit_file`

写入组共 4 个，仅 agent_write 可见。

- `create_agent_workspace`、`manage_agent_workspace`、`update_agent_workspace`、`restore_agent_workspace_commit`

仓库组共 12 个。`manage_agent_workspace` 支持永久删除仓库，更新及恢复也可能移除文件，必须点明破坏性。文档 MCP 的“不能永久删除文档”边界不能泛化到仓库工具。

### 配置同步 MCP

端点为 `https://koinote.app/api/config-sync/mcp`，连接名为 `koinote-config-sync`。仅含 `get_config_sync_snapshot` 和 `read_config_sync_envelope` 两个只读工具。

授权从用户已有配置快照取得，使用独立 `knt_config_sync_` 临时凭证，30 分钟有效并绑定单个快照及 revision。普通文档或仓库 PAT 无法访问。Agent 获取元信息和密文，在本地解密；迁移密码、解密密钥与明文均不上传服务端。撤销可停止后续读取，已下载内容无法收回。

源码中 `configSyncCreate` 使用 `requireUser`，`authorizeConfigSync` 检查临时授权及会话有效性，没有终身会员判断。`config_snapshots.go` 允许免费账号保存一个配置快照。因此，“终身会员必需”应明确限定到文档 MCP、仓库 MCP及站内 AI，配置同步说明独立临时授权规则。本卡不新增会员门槛。

密文超过 8 MiB 时按工具返回的下载地址获取整包，现有上限为 64 MiB，两个 MCP 工具自身没有云端写入能力。只在对应简介中说明这一已有路径，不扩建下载或同步系统。

## 必须准确表达的能力边界

- MCP 使用 Bearer 凭证，服务端没有 MCP OAuth 授权流程。要求 OAuth 且无法配置 Bearer 请求头的网页版连接方式无法直接接入。网站登录及飞书绑定的 OAuth 不等于 MCP OAuth，客户端兼容性按所需认证方式表述。
- `document_search.go` 通过 `position(lower(...))` 对标题和正文进行不区分大小写的子串匹配。明确标注语义检索和 RAG 尚未提供。
- 文件夹参数用于筛选结果，文档 PAT 没有文件夹级授权范围。不得把 folderId 筛选描述为权限隔离。
- 文档默认私有，受当前账号授权保护；双向链接、图谱与标签尚未提供。
- 现有文档的追加、替换、精确补丁、元数据更新、版本恢复及移入/移出回收站要求 expectedRevision，冲突后读取最新版本再处理。创建、文件夹操作、历史设置、GEO 摘要及移动文档的校验规则各异，避免承诺所有写操作都强制 revision。
- 文档 MCP 无永久删除工具，回收站保留按现有 30 天规则描述。仓库工具的删除能力单独说明。
- 文档与仓库 MCP 活动日志保留 180 天，记录工具、结果、耗时及关联标识等，不记正文或令牌原文。配置同步没有相同审计调用，不能承诺三种端点均有完整活动日志。
- 常规文档操作使用客户端模型能力；GEO 摘要、公众号推送及 AI 封面按已有规则涉及 credits。不得声称自带模型 Key 可豁免平台费用或存在自带图床能力。

主要实现依据为 `backend/internal/server/mcp.go`、`mcp_tokens.go`、`mcp_organization.go`、`mcp_geo.go`、`mcp_agent_workspace_tools.go`、`config_sync.go`、`config_snapshots.go` 和 `document_search.go`。

## 客户端指南与来源核对

每页将 shell 环境变量设置与 JSON/TOML 配置分成独立代码块。示例仅使用占位值，保留环境变量引用的原始字符；复制后配置文件中不得出现令牌明文。公共页面的验证动作使用列工具或只读文档操作，涉及写入与扣费的示例注明前提。

- Codex 沿用 `~/.codex/config.toml` 中的 `mcp_servers.koinote`、`url` 和 `bearer_token_env_var`。官方资料已核对该环境变量字段。
- Claude Code 沿用 `.mcp.json` 的 `type: http` 与 `Bearer ${KOINOTE_MCP_TOKEN}`。官方资料已核对 headers 支持环境变量展开。现有中文客户端简述称 CLI 添加，而代码示例为配置文件，需在本卡四语文案中对齐。
- OpenCode 必须注明版本。仓库已有 V1 的 `mcp.koinote` 写法，官方保留 V1 文档；当前 V2 使用 `mcp.servers.koinote`。子页展示清楚标注的 V2 与 V1 配置，保持 `oauth: false` 和 `Bearer {env:KOINOTE_MCP_TOKEN}`，README 的相关片段及版本说明同步对齐。
- OpenClaw 沿用已有 `add --transport streamable-http --no-probe`、字面量环境变量请求头和 `doctor --probe` 示例。README 的 2026.6.10 验证属于历史记录。当前官方说明 probe 需要 Gateway 停止，指南应写明此前提；交付时核对所声明版本的帮助输出及配置保存结果，再记录实测版本。
- WorkBuddy 与其他兼容客户端保留总览中的通用说明。

2026-11-29 已只读核对以下官方资料，官方说明核对仅证明文档契约，本轮未运行这些客户端连接测试。

- Codex 官方 MCP 配置，`https://developers.openai.com/codex/mcp/`，当前跳转到 `https://learn.chatgpt.com/docs/extend/mcp?surface=cli`。
- Claude Code 环境变量展开，`https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json`。
- OpenCode V2，`https://opencode.ai/docs/mcp-servers/`；V1，`https://opencode.ai/v1/docs/mcp-servers/`。
- OpenClaw registry，`https://docs.openclaw.ai/cli/mcp/registry`；transports，`https://docs.openclaw.ai/cli/mcp/transports`。

## 实现路径与内部文档隔离

1. 复用公开页 registry、现有 React 页面组件和 i18n。四个客户端页可以共用一个简洁组件，注册稳定路径并提供独立 title、description、OG、canonical 与返回总览入口。
2. `worker/seo.ts` 与 SPA 消费同一份公开工具和配置内容，服务端 HTML 中必须有工具名、scope、关键边界和对应配置代码。现有无 JavaScript 正文机制可直接扩展。
3. `/llms.txt` 用 Worker 现有请求链路增加精确 GET/HEAD 处理，显式返回 `text/plain; charset=utf-8`。GET 包含定位、主要公开页链接、四个客户端链接、三类连接和边界；HEAD 同状态和内容类型且无正文。通过已有安全头封装返回。
4. llms 内容只引用审核过的公开文案与固定公开 URL，不读取私人文档、PAT、配置快照或内部需求文件。若抽出文本内容模块，该模块需独立于本文件。
5. 现有 `vite.config.ts` 的静态目录为根目录 `public`，Worker 资源目录为 `spa/dist`；当前 Markdown 导入为显式 changelog 导入，未发现 `/api/docs` 注册或文档 glob 导入。保持内部文档无公开引用，并在最终产物检查中验证隔离。
6. 新子页通过既有公开页注册进入站点地图。保留最新 main 的 Hub noindex、仓库详情页 sitemap 排除和 `?file=` 行为，原有页面继续可访问。

## 验收标准

| 编号 | 验收内容与证据 |
| --- | --- |
| A1 | 本地 Worker 的 `/docs/mcp` 返回 200；GET 原始 HTML 能找到三组全部工具注册名，名称、去重数量、分组和 scope 与最终 Go 基线一致。验证 read 16、write 34、publish 19、agent_read 8、agent_write 12 及 config-sync 2 的当前口径，基线变更时先核实再更新。 |
| A2 | 总览 HTML 和 React 页面均显示无 MCP OAuth、子串检索、未提供 RAG/语义检索、无文件夹级授权、默认私有、revision 适用范围、180 天日志适用范围及权限/费用边界。三类凭证及 publish/仓库删除例外明确。 |
| A3 | 四个客户端子路径可直接 GET/HEAD，刷新及站内导航正常；原始 HTML 和页面包含对应可复制配置。环境变量引用保持字面量，代码块能按其格式解析，JSON/TOML 与 shell 分开。OpenCode 版本明确，OpenClaw 前提明确，README 对应配置和内链一致。 |
| A4 | `/llms.txt` GET/HEAD 均返回 200、`text/plain`，HEAD 无正文。正文包含已确认定位、主要公开页与客户端页链接、四语关键句及能力边界；返回内容不依赖登录或私人数据。 |
| A5 | 总览及客户端页在 `?lang=zh/en/fr/ja` 下正文、标题和描述对应正确语言；浏览器接管前后关键信息一致。相关 canonical、hreflang 与 sitemap 使用既有规则。 |
| A6 | 总览到子页、子页到总览、README 到指南的链接可达；现有 `/docs`、`/docs/version-history`、设置入口和仓库页可继续访问。Hub noindex 与详情页退出 sitemap 的现有测试通过。移动端代码可横向滚动，复制内容完整。 |
| A7 | 相关静态接线、文档、SEO、i18n、类型检查及构建通过；公开工具目录与 Go 注册集合的针对性测试覆盖漏项和误写 scope。验证结果注明实际运行环境和跳过项。 |
| A8 | 本文件保持在根目录 `internal-docs/`，没有进入源码公开 import、文档 glob、Vite 静态目录或 Worker 文档 bundle。构建产物与本地 `/api/docs` 请求中不出现本卡 ID、内部需求标题或正文标记。 |
| A9 | 整卡 diff 符合排除项；每个小提交自审并记录根因、改动、链路、结果和限制，最终同一个 HEAD 获得完整独立评审。一个 PR 指向 main，保持开放等待授权。 |

GSC 收录、注册转化和终身会员转化留待上线后观察，不作为本 PR 的合并前验收门槛。生产 URL 检查需在获准上线后执行，本卡阶段不部署。

## 分支、依赖与文件冲突

- 仓库为 `moutsea/koinote`，默认及 PR base 分支均为 `main`。
- 原始只读基线为 `7b5c59d1f8f99d9011c891f5cb889285a04da0a6`。现有任务分支为 `feature/koinote-mcp-llms-txt-bh1`，本轮评审保持在该分支。
- 本轮通过 `git ls-remote origin refs/heads/main` 核实远端 main 为 `201df9a26308a143e8021ec341aba34a42256514`，与本地 origin/main 一致。相对原始基线增加了 Hub noindex 任务的提交。本轮只读比较了差异，尚未更新任务分支。
- 开发先基于当时最新 main 更新当前任务分支，记录实际 BASE_SHA。当前已知最低基线为上述 `201df9a...`。在 PR 描述中说明与原始基线的差异，保留需求文档；每次更新基线后检查工具目录、路由和文案变化。
- 功能没有必须新增的外部依赖或其它功能卡前驱，复用当前依赖与测试工具。保持一张顶层卡，无 parent_id、子任务或集成分支。
- 工具行为的源代码只读核对。预计改动面为 `spa/src/pages/MCPGuidePage.tsx`、客户端共用页面或内容模块、`spa/src/main.tsx`、`spa/src/seoMeta.ts`、四语文件与类型、`worker/seo.ts`、`scripts/_check_mcp_wiring.mjs`、`scripts/_check_docs_center.mjs`、`scripts/_check_seo.mjs`、两份 README 及本内部文档。如 llms 使用 Worker 入口分支，追加 `worker/index.ts`。
- `worker/seo.ts`、`worker/index.ts`、`scripts/_check_seo.mjs` 已与合入 main 的 Hub noindex 卡重叠。该卡先合并，本卡以其 `201df9a...` 提交为基线，保留其行为和回归测试。
- 本轮查询到开放的非 draft PR #5「feat: 注册首触与分享注册归因 [d43ace76]」，分支为 `feature/koinote-de5`，与预计改动中的 `spa/src/main.tsx` 重叠。文件整合顺序为 PR #5 先、本卡后。可先在现有 main 开发，开本卡 PR 前按工作流复查该冲突；待 #5 由其负责流程合入 main 后，以包含它的 main 更新本分支并重跑路由相关检查。本卡不执行对方合并。若开 PR 时它仍开放，按工作流的文件冲突等待规则交接，不能谎称阻塞已解除。
- 如后续发现其它同文件 PR，在本节补充具体 PR、文件和顺序，不以全仓库是否存在 PR 作为等待条件。

回滚单位为本 PR 的完整变更。回退后恢复旧 MCP 总览、移除本次新增的客户端页与文本索引；用户文档、仓库文件、令牌、账单与数据库状态均无需迁移。任何实际回滚由获得授权的发布流程执行。

## 开发和验证安排

按一个 PR 内的小提交推进，每个提交信息包含卡号 `c29e20c7`，每次提交前自审当前改动与上游、共用逻辑、下游显示。

1. 基线更新后补齐公开目录与边界口径，扩展总览及其服务端 HTML，同步相关四语与针对性测试。
2. 交付四个客户端稳定子页、配置版本说明、README 对应片段及内链，验证深链接、复制与元信息。
3. 交付 `/llms.txt`、GET/HEAD 验证和内部文档隔离检查，再对最终 HEAD 执行整卡验收并进入独立评审。

代码中实际存在的相关命令包括 `npm run test:mcp`、`npm run test:docs-center`、`npm run test:seo`、`npm run test:i18n`、`npm run typecheck`、`npm run build`。开发时按改动选择运行并串行执行重活；全量测试只在现有 CI 要求或风险需要时运行，不为本卡新增无关框架。

可复用的 Go 权限集合测试为 `TestMCPScopeControlsExposedTools`，它使用进程内 MCP 客户端，不依赖数据库。开发如执行该测试，应标为进程内协议验证。使用真实 PostgreSQL 的端到端测试需要有效的 `TEST_DATABASE_URL`，缺少环境导致的 skip 不能记为通过。

SEO 用例调用实际 Worker handler，但当前测试中的 ASSETS 与后端 fetch 为模拟对象。扩展用例可验证响应契约，仍需将其标为模拟依赖下的 Worker 验证。正式客户端连接测试记录实际版本、环境、令牌类型和只读工具结果；仅解析配置不能记为客户端联通。

任何全量测试或构建启动前读取 load、MemAvailable 并检查已有重活。已有重活或 MemAvailable 小于 2 GiB 时等待并说明。保持全局会话上限 4，本卡不启动并行子 agent 或后台 AI。

## 本轮实际验证与剩余限制

本轮仅新增本内部需求文档并登记任务计划，功能实现仍待开发阶段交付。

- 仓库和上一会话检查已完成，确认本轮开始时无未提交改动、无关联 PR、无既有需求计划。
- Go 源码静态提取并人工核对得到文档工具 35、仓库工具 12、配置同步工具 2，权限分支同时与现有测试预期核对。尚未执行 Go 权限测试或数据库测试。
- 只读远端 main 查询成功，确认 `201df9a26308a143e8021ec341aba34a42256514`；只读开放 PR 查询成功，确认 PR #5 的文件重叠。
- `npm run test:mcp` 实际输出为「MCP 接线：28 通过，0 失败」。
- `npm run test:docs-center` 实际输出为「文档中心：14 通过，0 失败」。两项均为当前旧基线的静态检查，不能作为新功能已通过验收的证据。
- 上述检查时 load average 为 1.02 / 1.09 / 1.76，MemAvailable 为 22,202,400 kB；本轮仅执行轻量检查。
- 当前工作区没有 node_modules 和构建产物，本轮未运行 SEO bundle、类型检查、构建、浏览器测试、四个客户端连接测试或真实外部服务调用。
- 真实数据库验证、外部服务模拟验证和生产验收本轮均未执行。官网状态及 GSC 数据没有在本轮复测。
- 已对 49 个工具名逐一检查本文件覆盖，并核实三组工具注册源文件与已确认的 origin/main 一致。公开源码对 internal-docs 的引用扫描、需求必需字段检查和文档空白检查均通过。`git diff --no-index --check /dev/null internal-docs/mcp-knowledge-center-llms.md` 无空白错误输出，因新增文件差异返回 1。最终构建产物与 HTTP 隔离检查列为 A8 的开发验收。

后续关闭每个 review 问题时，在任务计划或 PR 验证记录中逐项填写根因、实际改动、受影响链路、运行结果及剩余限制，并指向对应 BASE_SHA/HEAD_SHA。设计说明、历史验证记录、跳过的测试与测试原型不能替代最终实现证据。

## 开发交付记录（2026-11-29）

本节补充开发阶段事实，上节为需求评审时的历史记录。

### 实际基线、依赖和提交

- BASE_SHA 为 `201df9a26308a143e8021ec341aba34a42256514`。开发开始前已 fetch 并 rebase 到该 main，保留 Hub noindex。2026-11-29 再次只读查询远端 main，SHA 仍相同。
- Kandev 关联查询返回 `blocked_by: []`、`blockers: []`。功能开发没有等待其它卡的正式 PASS。
- PR #5 仍为 OPEN、非 draft，head 为 `c0254a335b882fc97bdbcde6b8e0194d05e4f911`，web、backend、两平台 desktop、secrets 五项 CI 均 SUCCESS。文件冲突仍为 `spa/src/main.tsx`。开 PR 阶段须继续执行既定整合顺序和等待规则，独立评审后才能交付本卡 PR。
- `da0c2a2` 提交内部需求与 A1–A9，提交前核对需求、分支策略及内部隔离。
- `f4d9ed9a8b35c6ee6846dec2e62f2a1eaea3523a` 提交完整四语页面、目录、配置、Worker 正文与 llms.txt、README 及对应测试。提交前按公开内容 → SPA → Worker → README → 回归逐项自审。
- `d77194c` 提交自审发现的 README 会员和正文权限限定及回归断言。
- 最终 HEAD 由开发阶段任务计划与独立评审交接记录固定，评审覆盖上述 BASE_SHA 到最终 HEAD 的完整 diff。

### 交付与验收覆盖

| 编号 | 开发证据 | 后续限制 |
| --- | --- | --- |
| A1 | Go 注册集合静态比对覆盖文档35、仓库12、配置同步2。五种 PAT scope 同时通过真实进程内协议测试。四语原始 HTML 和浏览器总览逐项含49个注册名。 | 工具注册与 scope 已核验，数据库操作另需其环境。 |
| A2 | 共用四语字段覆盖 OAuth、子串检索、folderId、默认私有、revision、日志、publish、删除及费用。浏览器逐句比对七条边界，SSR检查关键词与完整目录。 | 本卡只描述当前后端行为。 |
| A3 | 16个客户端/语言组合完成站内进入、直接加载、刷新与返回。36次真实剪贴板读取逐字等于源配置。JSON解析及 Python tomllib 解析成功，Bash引用测试成功。OpenClaw 2026.6.10 实测帮助和 `--no-probe` 保存，落盘保留字面量环境引用。 | Codex、Claude Code、OpenCode 未运行真实客户端连接。OpenClaw 本轮验证范围为帮助与落盘，历史联通记录保留其版本限定。 |
| A4 | 真实本地 Worker GET/HEAD 均200，Content-Type为 `text/plain; charset=utf-8`，HEAD空正文。四语关键摘要齐全。模拟依赖用例证明不需ASSETS或后端。 | 线上响应留给获准的发布验收。 |
| A5 | 中英法日原始 HTML lang、标题、canonical、5条hreflang及sitemap通过。浏览器接管后的标题与服务端一致，语言菜单切换至日文并刷新成功。 | 无已知开发阻塞。 |
| A6 | 四子页互链通过，`/docs`、版本历史、设置、仓库设置、公开仓库目录返回200。390px宽度无整页横向溢出，代码块可横向滚动。复制拒绝分支提供手动复制提示。Hub noindex及sitemap排除通过既有SEO回归。 | 设置与仓库路径使用匿名本地环境验证入口，涉及账号功能由既有测试覆盖。 |
| A7 | 完整 `npm test` 退出0，包含类型、MCP、文档中心、SEO、i18n及既有链路。构建退出0。新增脚本 `node --check` 和 `git diff --check` 通过。 | 仓库没有独立lint命令。构建保留已有字体解析及大chunk警告。 |
| A8 | 扫描133个SPA产物文件与32个输入构成的Worker bundle，内部路径、需求标题、卡号均未出现。源码公开引用扫描无匹配。本地内部文档路径404，`/api/docs` 经本地模拟后端返回404且无内部标记。 | `/api/docs` 使用404模拟后端，未声称真实后端或数据库验收。 |
| A9 | 一张顶层卡，四次逻辑提交含卡号，完整清单交接独立评审。 | 整卡独立PASS与单一开放PR由后续工作流完成。授权上限仍为开PR，后续阶段也禁止合并、部署和生产操作。 |

### 实际命令和输出

运行环境为 Node `v22.18.0`、npm `10.9.3`、Go `go1.25.0 linux/amd64`、Chromium `156.0.8078.4`。Go 与浏览器工具复用主机已有临时安装，缓存与浏览器脚本放 `/tmp/koinote-mcp-validation/`。本卡未修改项目依赖清单及锁文件。

- 完整 `npm test` 退出0，末项为 `Koi Skill UI passed`。关键输出为 `MCP 接线：28 通过，0 失败`、`MCP 知识库检查通过：49 个工具、5 种 PAT scope、4 种语言及客户端配置`、`文档中心：14 通过，0 失败`、`SEO checks passed`、`i18n: 795 passed, 0 failed`。记录于 `npm-test-final.log`，最终HEAD复验另记 `npm-test-head.log`。
- `npm run build` 退出0，输出 `built in 5.56s` 和 `[katex] 已复制 20 个字体到 assets/fonts`。字体构建时解析与500kB chunk警告为当前构建已存在的提示，输出目录正常生成。
- 在 backend 目录运行 `go test ./internal/server -run '^TestMCPScopeControlsExposedTools$' -count=1 -v`，输出 `--- PASS: TestMCPScopeControlsExposedTools (0.02s)` 及 `ok koinote/backend/internal/server 0.030s`。这是进程内协议验证。
- 临时浏览器脚本 `browser.mjs` 启动 `wrangler dev --local`，仅监听127.0.0.1，使用真实构建资源和本地401/404后端模拟。输出 `clientLocalePages: 16`、`clipboardChecks: 36`、`pageErrors: []`，语言切换、复制拒绝、GET/HEAD、旧路由及内部隔离均通过。结果在 `browser-results.json`，移动端截图在 `openclaw-mobile.png`。
- OpenClaw `2026.6.10 (aa69b12)` 使用符合其要求的 Node `v22.23.5`，临时安装禁用安装脚本并隔离状态目录。`mcp add --help` 与 `mcp doctor --help` 均退出0。使用假令牌环境变量运行示例保存动作，输出 `Saved MCP server "koinote"`，JSON中仍为 `Bearer ${KOINOTE_MCP_TOKEN}`，无假令牌明文。使用 `--no-probe`，本轮未请求生产端点。
- 产物检查输出 `SPA artifact isolation passed: 133 files`、`Worker bundle isolation passed: 32 inputs, 1637717 bytes`、`Codex configuration TOML parse passed`。
- 每次重活前检查全机进程、load与MemAvailable，曾因其它工作区完整测试运行而等待。测试、构建、浏览器与Go测试串行，运行前可用内存约22–23GiB。

### 自审问题与修复闭环

| 问题与根因 | 实际改动与受影响链路 | 验证结果 | 限制 |
| --- | --- | --- | --- |
| 旧总览、README与Worker正文分别维护，缺少仓库/配置同步目录，权限和费用表述过宽。 | 引入小型公开内容模块及四语字段，SPA、SEO、llms共用，README同步版本与权限。Go注册 → 目录 → 两端正文 → README链路逐项核对。 | 注册集合检查、五scope进程内测试、四语HTML和浏览器检查通过。 | 外部服务费用与扣费行为保持源实现，未真实扣费。 |
| 新增PublicPage键后，首次类型检查发现Worker switch缺分支。 | 在现有 `pageBody` 中加入四子页分支，配置通过escapeHTML进入正文。 | 后续完整类型检查、16组GET/HEAD及浏览器刷新通过。 | 使用匿名本地后端模拟。 |
| 标点整理误改同一行TypeScript接口分隔符，首轮完整npm test在类型检查失败。 | 恢复类型分隔符，收窄到文案标点，检查完整文件。 | 完整npm test重跑退出0。失败日志保留于 `npm-test.log`。 | 此失误在提交前修复。 |
| README英文旧句漏列publish，会员复查泛指全部MCP，中文把GEO修改与“无文档修改权限”混写。 | 补齐publish的读取/摘要/推送，会员检查明确为文档MCP，无修改权限明确为文档正文。加入对应静态回归断言。 | `npm run test:mcp` 28项及目录/文案断言通过，README差异自审完成。 | README的其它功能说明沿用原有范围。 |
| 沙箱拦截Bash子进程或Wrangler日志写入，工具返回EPERM/只读错误。 | 经工具授权在受控外部环境重跑，缓存及日志隔离到/tmp。 | 完整npm test、构建和针对性MCP测试均实际退出0。 | 沙箱失败记录不计为验证通过。 |

本轮没有真实PostgreSQL数据验证，没有真实客户端到账号的联通或外部服务写入，没有生产验收。全量测试中包含既有SQLite测试，不能将其等同于本卡的PostgreSQL验证。浏览器与Worker验收的后端为显式模拟。独立评审需要基于最终HEAD复查，开PR阶段再查同文件冲突并遵守用户硬性授权。
