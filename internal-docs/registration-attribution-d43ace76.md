# 注册首触与分享注册归因交付记录

本卡为 `d43ace76-4048-4092-92f2-7eb3beb5257d`，名称为「koinote 注册首触与分享注册归因」。授权交付为一个以 main 为基线的 OPEN PR，独立评审后由部署与验收环节处理合并和上线。

## 基线与依赖

本卡没有前驱。已读取卡面及登记工作区的 `internal-docs/product-attribution-and-milestones.md`。开工远端 main、本地 origin/main 和初始 HEAD 均为 `7b5c59d1f8f99d9011c891f5cb889285a04da0a6`，独立工作区 `/var/lib/kandev/tasks/koinote_r9h2dzr7/moutsea-koinote`，任务分支为 `feature/koinote-de5`。功能代码 HEAD 与验证结果见本文末尾，最终交付 HEAD 和 PR 信息记录在卡片完成记录中。

## 根因与实际修改

### 首触缺失

原浏览器初始化与注册 API 没有来源数据契约，注册后无法区分直接访问与缺失采集。新增 `registrationAttribution.ts` 在 Web 的 main.tsx 初始化，使用 localStorage 保存首个有效记录。注册入口复用同一采集 promise，分享摘要完成后才读取来源。存储读取、解析或写入失败时省略首触，邮箱注册与 OAuth 跳转继续执行。

服务端在 `registration_attribution.go` 统一清洗。UTM 仅接受 ASCII 字母、数字、下划线、短横线，每项最多 128 字符，超限或非法值丢弃。referrer 仅接受规范化外部 DNS 主机名，拒绝 URL、userinfo、端口与 IP。落地路径使用当前路由白名单，动态段转换为模板，去除 query 和 fragment，未知路径丢弃。首触时间接受 2020 年起至服务端当前时间后五分钟的有效时间，异常记录整体省略。浏览器客户端执行相同限制，服务端始终再次校验。

来源优先顺序为有效 utm_source、外部 referrer 主机、分享落地路径、direct。无可用记录的账号没有归因行，后续查询用 LEFT JOIN / COALESCE 表达 unknown。first_source 为服务端计算值，客户端不能指定其结果。来源信息只用于分析。

### 新建用户与归因提交边界

`0126_registration_attribution.sql` 新建 `user_registration_attribution`，user_id 为主键，随用户删除级联。邮箱注册在消费验证码、写入用户和邀请奖励的既有事务内写入有效首触。Google/GitHub 通过共用 `getOrCreateOAuthUser` 的新建分支在同一事务写入。持久化使用 ON CONFLICT DO NOTHING，已有身份登录、已验证同邮箱复用以及唯一冲突回查分支均不会补写首触。

事务写入失败会撤销用户、邀请奖励、归因及验证码消费。原 registered 继续在新账号提交成功后尽力记录。三个入口的账号权限、邀请奖励及会话签发沿用原流程。

### 分享 CTA 上下文

SharePage 的预览区和页尾注册 CTA 均使用 `shareRegistrationHref`，追加独立的 shareSignupToken 参数。LoginPage 从当前注册 URL 读取它，分别传给邮箱注册请求和两个 OAuth start 入口。首触保留原搜索来源，CTA 上下文独立形成 share_signup。

服务端只接受现有 32 位小写十六进制分享 token，查询当前有效且未移入回收站的分享文档，再生成 SHA-256。OAuth state 仅增加清洗后首触和包含文档定位信息、摘要的分享上下文，复用现有签名、nonce、过期和跳转校验。新增分析上下文和数据库字段不保存原始 token。既有 redirectTo 为用户返回分享页保留原跳转语义。

新账号提交后复用 recordProductMilestone 尽力记录 share_signup。写入时按文档 ID 和当前 token 摘要再次验证，授权期间撤销、轮换或移入回收站的分享将舍弃事件。仅访问分享、普通 redirectTo、旧账号登录和无效分享来源都不会触发。事件仍使用 `(user_id,event_name)` 唯一约束，首次时间和来源摘要保持不变。

### 迁移与采集起点

新增迁移扩展原事件 CHECK，增加仅供 share_signup 使用的 64 位小写十六进制 share_source_key，保留七种旧事件。product_analytics_meta 新增两个可空起点字段，在新注册采集链首次成功提交时设定。既有数据不会被回填来源或分享注册事件。

### 验证中发现并修复的问题

- 真实 PostgreSQL 首次执行发现分享事件 SELECT 的同一参数在目标 varchar 列和 text 比较中类型推导冲突。增加显式 text 转换，覆盖邮箱、OAuth 和并发实际写入。
- 分享页两个 CTA 分别位于预览与匿名全文兼容分支。新增页面运行时测试分别构造这两个状态，核对实际渲染链接的独立参数与返回地址。

## 验证与证据

所有数据库用例连接本卡隔离 PostgreSQL 16，监听本机 55436，数据目录 `/tmp/d43ace76-postgres`。OAuth provider 使用本地 httptest 服务接管 token/profile 请求。前端使用现有 esbuild、React、linkedom 和模拟 fetch 验证实际页面与模块行为。静态接线断言单独标注。

必要命令和最终真实输出见以下验证记录。原始日志目录为 `/tmp/d43ace76-evidence`。

## 剩余限制与生产验收

- 浏览器清理存储、跨设备与 referrer 被移除会丢失来源，历史来源保持 unknown。localStorage 属于浏览器配置文件，多标签页复用首次记录，多个自然人共用浏览器可能共享首触。
- UTM 和 referrer 是客户端提供的分析数据，不用于身份认证、权限、奖励、计费或会员判定。任何有效活动标签都可能被访问者伪造，服务端清洗保证格式与存储边界。
- 分享 CTA token 证明访问者持有有效链接，无法证明真实鼠标点击。仅传 redirectTo 不具备分享注册语义。
- 首触分享摘要由浏览器基于高熵 token 生成。有效 CTA 来源由服务端查询验证，两者分别表达落地与注册上下文。
- 分享撤销、轮换或移入回收站后，注册成功时无法再确认来源则舍弃 share_signup。数据库故障及账号提交后进程退出可能漏记 registered/share_signup，沿用现有尽力记录机制。
- 生产验收尚未执行。真实 Google/GitHub 授权页面、线上迁移及线上统计数据由独立部署与验收处理。

应用回滚时保留新增归因表、事件来源列与采集起点字段，已采集数据继续保留。旧应用写入七类既有事件仍兼容新约束。

本说明仅存放在 internal-docs，运行时入口没有导入它。构建后的泄露检查见以下验证记录。

## 已完成的后端验证

环境为 PostgreSQL 16、Go 1.25.0、gcc 13、Node 22.18.0、npm 10.9.3。Go 位于 `/tmp/d43ace76-tools/go/bin`。GOCACHE 使用 `/tmp/d43ace76-go-cache`，GOMODCACHE 使用本机 `/var/lib/kandev/go/pkg/mod`。TEST_DATABASE_URL 指向本卡隔离库 `postgres://koinote@127.0.0.1:55436/koinote?sslmode=disable`。

实际执行 `go test -p 2 -race -timeout 20m ./... -json`，退出码为 0。日志为 `go-race.jsonl`，共 3,788 条测试通过记录，包含子用例。

```text
ok koinote/backend/cmd/sync-agent-repositories 1.031s
ok koinote/backend/internal/config 1.032s
ok koinote/backend/internal/migrations 2.815s
ok koinote/backend/internal/server 735.997s
```

`go vet -p 2 ./...` 退出码为 0，日志没有诊断输出。新增 Go 文件经 gofmt 检查没有未格式化文件，`git diff --check` 没有诊断输出。package.json 没有独立 lint 脚本，沿用仓库的类型、Go vet 和静态检查。

本卡数据库测试均真实执行，全部 PASS，SKIP 为 0。

| 验收与根因 | 实际改动及受影响链路 | 验证结果 | 剩余限制 |
| --- | --- | --- | --- |
| 初访信息原先丢失 | main 首触采集 → 注册请求 → 服务端清洗 → 用户归因表 | `TestRegistrationAttributionCleaning`、`TestEmailRegistrationAttributionDatabase` 通过，核对 UTM、referrer、模板路径和首触优先级 | 客户端来源可伪造，存储及 referrer 缺失无法还原 |
| 复用账号可能误归因 | OAuth 仅新建分支接线，既有身份、同邮箱及冲突回查保留原归因 | `TestOAuthRegistrationAttributionDatabase`、`TestOAuthRegistrationAttributionRevocationAndLegacyReuse` 通过，Google/GitHub token/profile 为本地 HTTP 模拟，持久化为真实数据库 | 真实 provider 授权页面待生产验收 |
| 注册失败可能留下半套数据 | 首触位于用户、邀请码奖励及验证码的既有事务内 | `TestRegistrationAttributionRollbackAndConcurrentEmail`、`TestOAuthRegistrationAttributionTransactionRollback` 通过，实际 CHECK 约束失败触发回滚，验证码可重试 | 有效首触的数据库事务失败仍会让本次注册失败，可重试 |
| 分享访问与注册 CTA 原先无法区分 | 独立 CTA 参数 → 当前分享验证 → 签名 state → 新用户提交后再次验证 → share_signup | 邮箱和 OAuth 数据库用例覆盖普通 redirectTo、无效/撤销/轮换/回收站分享、旧账号及 link/password/旧 public | 撤销来源会被舍弃，持有链接无法证明真实鼠标点击 |
| 重复请求可能覆盖首次 | 用户归因主键与事件唯一约束，ON CONFLICT DO NOTHING | `TestRegistrationAttributionConcurrentPersistence` 通过，12 路 OAuth 并发及 12 路重复写入各保留一行，首次时间和详情保持不变 | 沿用浏览器首次有效存储的语义 |
| 埋点故障可能影响业务 | share_signup 复用尽力记录，失败只产生安全诊断 | `TestRegistrationMilestoneFailureDoesNotBlockSignup` 通过，实际事件 CHECK 失败时邮箱和 OAuth 注册仍成功 | 数据库故障或提交后进程退出可能漏记事件 |
| 历史兼容与隐私 | 新迁移扩展 CHECK、级联外键、摘要列，历史不回填 | `TestRegistrationAttributionUpgradePreservesHistory` 通过，执行完整旧迁移和新迁移，保留七类旧事件和时间，重复 Apply 不覆盖；用户删除清理和原始 token 检查通过 | 旧用户来源为 unknown |

全后端回归有 9 个具名 SKIP，均属于现有外部条件测试，记录如下。

- `TestAgentWireAuthenticatedCallbackAndMCP` 需要上游 checkout 与 `test:koi-agent-contract`。
- `TestAgentEmptyFolderLive`、`TestAgentFolderMergeLive` 需要显式线上验收。
- `TestAgentIntentLiveHost`、`TestAgentConversationLive`、`TestWritingAgentLive` 需要显式付费外部验收。
- `TestCuratedAgentRepositories` 需要 KOINOTE_CATALOG_ARCHIVES 专用档案。
- `TestAnthropicAnnouncementTranslatorLive` 需要 ANNOUNCEMENT_LLM_LIVE_API_KEY。
- `TestKoiImportRequestContract` 由前端 `test:koi-skills` 提供请求契约，整包 Go 回归内没有该运行环境。

这些跳过项不计入数据库或生产验收通过证据。

## 前端、构建与公开产物验证

以下命令均退出 0。

- `npm run typecheck`，SPA TypeScript 与 Worker 类型检查通过，Wrangler 返回 `Types at worker-configuration.d.ts are up to date.`。
- `npm run test:growth-ui`，原有静态接线检查、新增首触模块运行时检查及注册页实际 React 事件/请求载荷检查通过。API 响应为模拟。
- `npm run test:share-session`，现有会话失效、延迟响应和重登回归通过，新增分别渲染预览区与页尾注册 CTA，实际检查两个 href 的分享参数。
- `npm test`，完整前端脚本按 package.json 串行执行通过，包含上述检查以及 share-preview、邮箱、账号、邀请码相关接线、i18n 和安全回归。独立 `test:share-preview` 首次因 PATH 缺少 Go 未启动，修正 PATH 后在本次完整回归中真实执行。
- `go build -p 2 ./...`，后端全部包构建通过，输出日志为空。
- `npm run build`，返回 `built in 5.71s`，复制了 20 个 KaTeX 字体。构建有部分 chunk 大于 500 kB 的提示，本卡没有扩展分包优化范围。
- `node_modules/.bin/esbuild worker/index.ts --bundle --format=esm --platform=neutral --loader:.md=text --outfile=/tmp/d43ace76-evidence/worker.mjs`，Worker 构建通过。

完整前端回归中的实际输出节选如下。

```text
registration attribution runtime checks passed (first touch, privacy, CTA context, malformed/disabled storage); entry wiring checked statically
registration page runtime checks passed (email payload, both OAuth buttons, redirect, independent CTA, disabled storage; API responses mocked)
share session checks passed (expiry, re-login, transient errors, guest-key unlocks, previews, in-flight responses, throttling and retry)
share preview rendering checks passed (187 backend/Markdown-it/TipTap cases, 42 destination comparisons, 135 reference comparisons)
ok koinote/backend/internal/server 0.010s
Koi Skill UI passed: rollout gate, settings, folder installation/replacement, GitHub/Hub previews, migration selection/retry, Hub continuation, empty-library recovery, file preview and account isolation
```

最后两行来自 `test:koi-skills`，它设置 KOINOTE_TEST_IMPORT_REQUESTS 后执行 `TestKoiImportRequestContract`，补齐该测试在整包 Go 回归中的条件性跳过。

公开产物检查读取 SPA 和 Worker 共 133 个文件，搜索本交付说明、完整需求文档的路径与标题，匹配数为 0。SPA index.html、JS、CSS 及字体完整。

```text
PASS: SPA index, JS, CSS and 20 KaTeX fonts exist; scanned 133 SPA/Worker files, internal document markers found=0
```

验证期间的环境问题均已恢复。初次 Wrangler 类型检查受到沙箱日志目录写限制，授权重跑成功。初次 race 启动因缺少 C 编译器而拒绝启动，安装 gcc 后完整执行成功。后续重活均先检查主机状态，其他全量测试或构建运行时等待。

## 提交与评审交接

- `43aeed96a59aadb8bb1806b1fd5ea69aa457693d` 包含迁移、服务端清洗、注册事务和分享注册事件。自查覆盖新旧账号边界、邀请奖励、摘要隐私和尽力事件写入。
- `f8ae9493231eef576914b2a661e807c15c42c4a2` 包含浏览器采集、两个 CTA、邮箱/OAuth 参数传递。自查覆盖存储失败、来源不可覆盖、普通跳转和桌面入口兼容。
- 最终测试与交付说明提交包含本卡测试及本文。功能代码 HEAD 为 `f8ae9493231eef576914b2a661e807c15c42c4a2`，最终交付 HEAD 记录在 PR 和卡片完成记录中。

本轮完成开发自查。独立评审由后续工作流承担，生产验收由部署与验收环节承担。原始输出位于 `/tmp/d43ace76-evidence`，包括 `go-race.jsonl`、`go-vet.log`、`go-build.log`、`typecheck.log`、`npm-test.log`、`growth-ui.log`、`share-session.log`、`spa-build.log`、`worker-build.log` 和 `bundle-isolation.log`。
