# Hub 仓库详情页默认 noindex 与 sitemap 清理

评审日期为 2026-11-28，时区 Asia/Singapore。本文件是仓库内部需求与验收记录，位于根目录 `internal-docs/`，仅随本卡 PR 评审。禁止纳入公开文档目录、静态资源、文档 bundle 或 `/api/docs`。

## 任务与交付责任

- 当前卡为 `4b542254-bf8a-4106-b763-216b82bbddbf`，标题为「koinote Hub 仓库页默认 noindex 并移出 sitemap，同时处理 ?file= 参数页」。
- 评估结论为一个原子任务，交付一个 PR。详情页索引指令、文件参数 canonical 与 sitemap 候选 URL 属于同一项 Hub 索引策略，使用同一套 SEO 入口与回归脚本，可以一起验收、通过一个 PR 回滚。
- 规模为小型功能变更，涉及 Worker SEO 渲染、SPA 元信息同步及直接相关测试。预计核心文件为 `worker/seo.ts`、`worker/index.ts`、`spa/src/components/AppShell.tsx`、`scripts/_check_seo.mjs`，按实际复用需要调整 `spa/src/seoMeta.ts` 或增加最小的客户端回归入口。
- PR 负责人为本卡「开发中」阶段的 Coder 执行者，负责实现、逐提交自审、验证记录和最终交接。「待评审」执行独立评审，「开 PR」执行者负责推送同一分支并创建或复用本卡唯一 PR。当前尚无 PR。
- 不创建父卡、子卡、集成分支或额外顶层卡。当前无前驱任务，无 `blocked_by` 依赖。
- 本次用户明确要求评估后转入开发，按该指令继续工作。2026-11-26 的暂缓限制记录为历史状态。
- 交付边界为开放 PR。禁止合并、启用自动合并或部署，通用后续工作流的自动合并规则须服从本卡这项明确限制。

## 目标与证据口径

所有 `/repositories/<合法 id>` 默认输出 noindex，包括 `lang`、`file`、目录筛选上下文及其他查询参数组合。公开仓库正常可读，现有用户访问、文件深链接与安装流程继续可用。sitemap 只列仍允许索引的公开页面。

原始需求依据 2026-11-26 的审计记录。近 28 天 Hub 页有 166 个 URL、992 次展示、7 次点击，sitemap 当时含 616 条仓库详情页，另有 84 个带 `file` 的 URL 出现在 GSC。以上数据沿用任务描述，当前环境缺少 `/workspace/seo-reports/2026-11-26/koinote-audit/`，本轮未独立复算 GSC 或 Cloudflare 数据。搜索表现变化留待上线后观察。

需求评审开始时工作区没有遗留实现或测试修改。该阶段重新检查了相关源码，并补齐内部需求文档。后续开发进展按时间记录在本文末尾。

## 基线、分支与冲突面

- 仓库为 `https://github.com/moutsea/koinote`，默认发布分支及 PR base 为 `main`。
- 需求对照 SHA、本地 HEAD 与 2026-11-28 只读查询到的远端 `refs/heads/main` 均为 `7b5c59d1f8f99d9011c891f5cb889285a04da0a6`。
- 沿用当前任务分支 `feature/koinote-hub-noindex-sve`。开发开始时重新核实远端 main，若发生变化，先检查相关代码差异并以新的 main 为开发基线，在 PR 中记录原始基线、实际 base 与最终 head SHA。
- 2026-11-28 通过 GitHub 查询到开放 PR 清单为空，当前没有需要指定先合并的冲突 PR。共享冲突面为 `worker/seo.ts`、`worker/index.ts`、`spa/src/components/AppShell.tsx`、`spa/src/seoMeta.ts`、`scripts/_check_seo.mjs`，以及确需调整时的 `package.json`。
- 开工及开 PR 前复核同仓变更。若出现与上述文件重叠的先行卡，应在本节写明该卡 ID、PR、先合并顺序及其合入 main 后的 SHA，再确认本卡基线。不得假设另一独立分支已经包含所需提交。
- 计划分成两个可单独审查的小提交，并保持一个 PR。第一个提交交付详情页索引指令、客户端导航与相关回归，同时纳入本需求文档。第二个提交交付 sitemap 清理及对应回归。每个提交信息含本卡 ID，逐个自审，独立评审覆盖最终完整 diff。

## 根因与最小改动方案

### 详情页成功响应和回退响应

现有 `worker/seo.ts` 的 `renderRepositoryPage` 成功响应保留仓库正文与无参数 canonical，但没有 noindex。后端异常、超时或无有效仓库正文时返回带 `no-store` 的 200 SPA 外壳，同样缺少 noindex。`worker/index.ts` 在 SEO 渲染抛错后直接返回 ASSETS，形成另一个可能漏标的 HTML 出口。

在现有仓库页处理链路补齐 `X-Robots-Tag` 与 HTML `meta[name="robots"]` 的 noindex。正常页、可恢复的后端故障外壳及 SEO 异常恢复后的仓库 HTML 都应覆盖。GET 与 HEAD 的 HTTP 索引指令一致，HEAD 保持无正文。复用现有路由分类与 HTML 处理能力，改动集中在索引信息，避免新建通用 SEO 框架。

不存在或已撤回仓库仍由现有后端 404/400 映射为页面 404 + noindex。请求归一化继续保留大小写、尾斜杠和前导零的现有单次 301，保留查询参数，不为 `file` 或 `lang` 增加跳转。

### 文件预览与客户端导航

`worker/seo.ts` 的正常详情页 canonical 已固定为 `/repositories/<id>`。`spa/src/components/AppShell.tsx` 通过 `pageOwnsMeta` 将仓库 canonical 与界面语言参数分离。`spa/src/agentRepositoryMarkdown.ts` 生成 `file` 参数深链接，详情页按它选中并预览文件。

沿用现有 canonical，在能返回 HTML 的故障回退中补齐同一无参数目标。按仓库详情路径统一应用 noindex，避免枚举参数造成漏标。现有文件预览参数为 `file`，兼顾它与 `lang`、筛选上下文、`installKoi` 的组合，保留全部业务参数。

客户端路由切换时同步本卡引入的 robots meta。需要验证从公开页进入详情页，以及从详情页返回目录、首页和定价页的往返路径，避免 noindex 泄漏到可收录的公开页。现有分享页、应用页和预览域名的索引规则纳入回归检查。

### sitemap 与目录页

`worker/seo.ts` 的 `sitemapXml` 先遍历 `PUBLIC_PAGE_PATHS` 输出公开页面和语言变体，再请求 `/api/agent/repositories/sitemap` 并追加全部公开仓库。现有 `scripts/_check_seo.mjs` 还要求仓库条目完整进入 sitemap，回归预期需要随本次策略更新。

移除 Worker 对仓库 sitemap feed 的请求与条目拼接，删除因此失去用途的专用过滤函数和超时常量，保留公开页及其 hreflang。后端已有 sitemap API 保持原有契约，本卡无需修改后端或删除接口。

目录页 `/repositories` 及其语言版本继续允许索引。已检查 `AgentPublicRepositoriesPage.tsx`，加载更多使用 API 游标，筛选使用按钮或表单，未发现必须在本卡处理的成批可抓取目录分页链接，因此本次不扩展目录参数索引策略。详情页链接携带的筛选参数由统一 noindex 覆盖。

`robots.txt` 应继续允许抓取仓库详情页，以便搜索引擎读取索引指令。sitemap 可提交地址为 `https://koinote.app/sitemap.xml`，由上线后有权限的人员提交 GSC。

## 范围边界

交付范围为仓库详情页响应头与 HTML robots meta、无参数 canonical、客户端导航元信息同步、sitemap 清理、直接相关自动化检查及本内部文档。

不做范围包括原创内容补写、热门页索引白名单、Hub 导入或安装流程改造、后端接口删除、数据库迁移、计费与会员权益、支付、MCP 授权、首页和文档文案重写、分享页策略调整、重试系统、新配置或 CI 改造。实现若确需扩大范围，先说明原因与成本并取得用户同意。

## 验收标准

1. 正常公开仓库的无参数地址，以及 `lang=zh|en|fr|ja`、`file=SKILL.md`、`file` 与 `lang` 混合和实际文件路径编码的地址，GET 为 200，可读仓库正文仍在，响应头包含 noindex，HTML robots meta 一致。登录态与匿名访问均走通。
2. 上述详情地址的 canonical 唯一且指向同一无参数 `/repositories/<id>`，丢弃查询参数仅发生在 canonical 值中。页面 URL 的参数、选中文件、文件内锚点和安装入口继续有效。
3. HEAD 返回对应状态及 noindex，响应正文为空。合法仓库的状态判断仍与 GET 一致，已有未知 ID 的 HEAD 行为也覆盖回归。
4. 后端网络失败、超时及已有缺失数据回退路径继续返回可恢复的 SPA 外壳，并包含 noindex 和对应 canonical。SEO 渲染异常后若取得可用 HTML 外壳，同样满足该约束。故障回退保留已有 `no-store` 语义。
5. 后端明确返回 404 或 400，以及本地判定非法的仓库 ID，仍返回页面 404 + noindex。用已有模拟后端测试该映射，真实数据库与生产记录另行标注。
6. 前导零、大小写、尾斜杠变体维持现有一次路径归一化，查询参数保留，最终 HTML 为 noindex。规范地址上的文件参数不产生新增 301 链。
7. `/repositories` 及支持语言版本继续返回 200，并保持可收录。目录到详情再返回的客户端导航，以及详情到首页、定价页的导航，robots meta 与目标页策略一致，无重复或残留标记。现有页面标题、描述、文件预览及移动端操作可用。
8. `/sitemap.xml` 返回 XML，GET 和 HEAD 都不调用仓库 sitemap feed。所有 `<loc>` 和 hreflang 链接中均没有 `/repositories/<id>` 或其参数变体。`PUBLIC_PAGE_PATHS` 内首页、定价、文档、目录等页面及四种语言变体仍完整，XML 转义与既有缓存行为正常。
9. `robots.txt` 不新增阻挡仓库详情或预览参数的规则。分享页、应用页、未知路由、静态资源和 workers.dev 预览域名通过现有相关回归。
10. 以 `/repositories/224`、`/repositories/530`、`/repositories/130`、`/repositories/168` 和 `/repositories/117?file=<实际存在的文件路径>` 作为上线后抽查清单。有效公开页应为 200 + noindex；若仓库已撤回或不存在，记录真实 404，不能为了样本通过伪造存在。模拟数据中的同号测试仅算模拟验证。
11. 内部文档位于根目录 `internal-docs/koinote-hub-noindex.md`，没有从运行时代码导入，没有复制到 `docs/`、`doc/`、`public/` 或 `spa/dist`，构建产物不含该文档内容，`/api/docs` 不返回它。当前源码未发现 `/api/docs` 文档路由，开发完成时复核最终版本。
12. 相关测试覆盖真实 Worker 入口的 GET、HEAD、参数、404、故障回退和 sitemap，并覆盖客户端元信息往返。测试必须执行最终修改后的代码，不能用只匹配源码的断言替代运行时行为验证。

## 风险与依赖

整体风险为中等，业务代码风险较低，搜索曝光影响覆盖所有 Hub 详情页。noindex 使相关搜索入口逐步减少，属于本卡目标；恢复索引需要搜索引擎再次处理。

主要回归风险来自共用 HTML 出口遗漏故障分支、客户端 robots 残留影响公开页、路径重定向丢失文件参数，以及 sitemap 误删正常公开页。验收通过响应矩阵、客户端往返和完整 sitemap 集合对比覆盖这些风险。

权限与数据安全方面，复用现有公开仓库接口与回源头处理，SSR 仅使用现有公开字段。检查 HTML 转义、404 隔离和原有访问控制回归。计费、会员、支付和 MCP 授权处于本卡不做范围，最终 diff 应能确认这一边界。无需数据库结构变更、密钥变更、新依赖或发布配置变更。

开发验证依赖仓库 `package-lock.json` 对应的 npm 依赖。当前工作区尚无 `node_modules`，开发阶段按仓库既有方式安装。后端 HTTP 与 ASSETS 可沿用 SEO 脚本的模拟，生产抽查和 GSC 观察由后续获授权的上线人员执行。

## 验证计划与资源约束

优先扩展现有 `scripts/_check_seo.mjs`，替换「全部仓库进入 sitemap」旧预期，并在同一入口覆盖成功和回退响应。客户端检查复用已有 DOM/组件验证方式，确有必要时增加最小测试入口，避免为单项功能搭测试框架。

实现后串行执行仓库已有命令。

```sh
npm run test:seo
npm run test:security-headers
npm run test:share-og
npm run test:docs-center
npm run test:agent-repository-storage
npm run typecheck
npm run build
```

`package.json` 当前未定义 lint 命令，不编造 lint 结果。构建后检查 SPA 输出和 Worker 打包输入是否包含内部文档，保留真实输出及检查方式。页面交互验证要记录所用环境、匿名或登录态、是否使用模拟接口，避免混称端到端生产验收。

全量测试与构建开始前查看 load、MemAvailable 和已有重任务进程。存在其他重活或 MemAvailable 小于 2 GiB 时等待并说明。重活串行，不启动并行子 agent 或后台 AI，总会话数遵守 4 的上限。本轮评审只进行了源码读取、轻量检查与只读远端查询。

## 本轮记录与待完成项

- 根因已追溯至 `renderRepositoryPage` 的成功及后端回退响应、Worker 的 SEO 异常兜底、AppShell 的路由元信息同步，以及 `sitemapXml` 的仓库 feed 追加逻辑。
- 本轮实际改动仅为本文件与任务计划记录。功能代码、回归测试实现和 PR 交付由开发阶段执行。
- 受影响链路为浏览器或爬虫请求 → Worker SEO → 公开仓库接口或 SPA 外壳 → 客户端导航，以及 sitemap → 公开页面集合。
- 已完成源码与发布路径静态核对。Vite 的公开目录是根目录 `public/`，输出为 `spa/dist`，Worker 资产目录为 `spa/dist`。现有公开文档由 TSX/i18n 生成，Worker 显式导入四份 CHANGELOG。Wrangler 的 Markdown Text 规则存在，最终 Worker bundle 的实际输入与输出仍需在开发阶段验证。
- 本轮执行 `node scripts/_check_docs_center.mjs`，结果为 14 通过、0 失败。`git diff --check` 通过，新增内部文档独立空白检查通过。对 worker、spa、public、docs、scripts、Vite、Wrangler 与工作流源码搜索，未发现 `internal-docs` 或本文件名的引用；对 backend、worker、spa 搜索，未发现 `/api/docs` 或 `import.meta.glob`。这是静态隔离核对，实际构建产物尚未验证。
- 构建、类型检查、SEO 运行时回归与客户端交互验证尚未执行，当前缺少 npm 依赖。该限制已交给开发阶段处理，不能据此关闭实现验收。
- 实际数据库验证尚未执行，本卡方案不需要数据库改动。外部服务模拟验证尚未执行。生产验收及 GSC 观察尚未执行。
- 后续每项修复关闭前补充根因、实际改动、受影响链路、验证命令及真实结果、剩余限制，并记录 base/head SHA。上线后搜索指标仅作观察项，不能承诺立即退索引。

## 回滚

本卡使用一个 PR，获授权的发布人员可整体回退该 PR 的代码提交，使详情页索引指令与 sitemap 一起回到此前策略。无数据库和数据格式迁移。搜索引擎侧状态会随再次抓取更新，回滚验收应以实际 HTTP、HTML 和 sitemap 为准。本评审及后续 PR 阶段禁止执行生产回滚、合并或部署。


## 开发记录一 · 详情页索引指令

2026-11-28 接续开发时确认前一会话已留下未提交的详情页实现和回归测试，npm 依赖已经安装。`list_related_tasks` 返回 `blocked_by=[]`、`blockers=[]`，无需要等待 PASS 的前驱任务。两个旧会话均已取消，本会话继续单进程修改。远端 `main` 再次核实为 `7b5c59d1f8f99d9011c891f5cb889285a04da0a6`，开放 PR 清单为空，当前分支以该提交为基线。

- 根因与改动。详情页成功响应、后端失败外壳和 SEO 异常回退出口均补齐 `X-Robots-Tag: noindex` 及带 `data-repository-robots` 的 HTML meta。故障外壳补齐无参数 canonical，并沿用 `no-store`。正常正文、真实 404 和一次路径归一化经过回归。
- 客户端链路。实际采用 `AgentPublicRepositoryDetail` 的挂载与卸载生命周期管理专属 meta，复用 Worker 首屏节点，离开详情组件后清理。AppShell 既有 canonical 同步已覆盖本卡路径，采用此方案可缩小公共组件改动范围。
- Worker 验证。`npm run test:seo` 退出 0，输出 `SEO checks passed`。测试执行打包后的 `worker/index.ts`，ASSETS 和后端 HTTP 使用模拟。覆盖 GET/HEAD、语言和文件参数、Cookie 有无、后端 400/404、网络异常、超时、503、无效 JSON、缺少数据、ASSETS 获取和读取正文失败、旧 ETag、路径归一化、目录可索引、预览域名和既有分享/应用页策略。故障注入会输出预期的 `seo render failed` 日志。
- 客户端验证。`node scripts/_check_agent_repository_sharing.mjs` 退出 0，输出包含 `repository robots lifecycle passed`。使用真实 React 组件、React Query 和 Linkedom DOM，API、会话及路由订阅使用现有适配器。覆盖首屏接管、站内进入、账号及仓库切换、离开到目录/首页/定价组件、文件选择及目录上下文恢复。原有安装、Clone、Fork、权限、撤回、并发回包测试一并通过。
- 类型检查。`npm run typecheck` 退出 0，SPA 与 Worker 的 `tsc --noEmit` 通过，Wrangler 输出 `Types at worker-configuration.d.ts are up to date.`。首次运行的本地日志写入被沙箱拒绝，随后获准重跑，结果通过且无日志错误。
- 自审。逐文件检查 Worker 请求入口、公开后端回源、HTML 转义、条件请求头、前端生命周期和现有操作回归。响应使用公开数据，测试断言 SEO 回源不转发 Cookie 或 Authorization。`git diff --check` 通过。
- 验证限制。热门 ID 的同号数据属于模拟验证。实际数据库、外部服务真实请求、完整浏览器导航/视觉验收和生产抽查未执行。类型检查及组件测试不代表这些环境已验收。sitemap 清理与最终构建隔离核查在第二个提交完成。


## 开发记录二 · sitemap 与最终回归

第一个提交为 `27d06d16b1fa67639e24fe3a90e637358a7ac650`，提交信息包含本卡完整 ID。提交后复核其全部文件与空白检查通过。

- 根因与改动。`sitemapXml` 原先主动查询公开仓库 feed 并追加详情地址。现已移除该回源、条目拼接、专用数据过滤器与超时参数，改为同步生成公开页面清单。后端 sitemap 路由仍定义于 `backend/internal/server/server.go`，本卡仅清理 Worker 的调用方。
- 受影响链路。浏览器或爬虫请求 `/sitemap.xml`，由 Worker 按 `PUBLIC_PAGE_PATHS` 生成 XML。13 类公开页面各保留无参数、四语言变体，共 65 个 loc，每项含完整的 5 个 hreflang 链接。详情页全部排除，GET/HEAD 都无后端回源。
- 自审。核对 sitemap 生成的上游路由、公开页面集合、下游 XML 与 hreflang，以及普通页面仍使用的后端超时。删除的超时选项原先只有仓库 feed 使用。回归通过 XML DOM 对完整 URL 集合和每组 hreflang 进行比较，并断言后端请求计数为零，包含后端故障情形。
- 已完成的相关命令与真实结果。`npm run test:seo` 输出 `SEO checks passed`，`npm run test:security-headers` 输出 `安全响应头：39 通过，0 失败`，`npm run test:share-og` 输出 `share OpenGraph checks passed`，`npm run test:docs-center` 输出 `文档中心：14 通过，0 失败`，以上最终退出码均为 0。
- 仓库存储回归。`npm run test:agent-repository-storage` 首次因沙箱禁止监听 `127.0.0.1` 返回 EPERM，获准重跑后退出 0，输出 `Repository R2: authentication, bounded uploads, hashes, immutable retries, empty/max files and ranges passed.`。这是本地 Workerd/Miniflare R2 实现验证。
- 工作区回归。`npm run test:agent-workspace` 首次因沙箱禁止测试子进程调用 `/bin/sh` 返回 EPERM，获准重跑后退出 0。实际执行 workspace、access、sharing 和 retry 四段脚本，最终输出包含 `repository robots lifecycle passed` 和 `Repository HTTP Retry-After, 601-file resume, shared cooldown, cancellation and withdrawal checks passed`。Node 输出 MockTimers 实验性 API 提示。
- 资源记录。串行验证前 load 为 `1.46 / 2.13 / 3.42`，MemAvailable 为 `24238428 kB`。构建前发现其他 Node 测试占用约 330% CPU，load 升至 `9.58 / 7.46 / 5.13`，MemAvailable 为 `24116876 kB`，因此等待该重任务结束。

### 最终验证与限制

- 资源恢复后 load 为 `2.42 / 4.62 / 4.56`，MemAvailable 为 `25296476 kB`，重测试进程已退出，随后串行完成类型检查、SPA 构建和 Worker 本地打包。
- `WRANGLER_LOG_PATH=/tmp/koinote-noindex-validation/wrangler npm run typecheck` 退出 0，耗时 10.6 秒。SPA 与 Worker 的 `tsc --noEmit` 通过，生成类型检查输出 `Types at worker-configuration.d.ts are up to date.`。日志路径通过已安装 Wrangler 的实现确认，只作用于本次命令。
- `npm run build` 退出 0，耗时 6.7 秒，输出 `2758 modules transformed`、`built in 6.01s`、`已复制 20 个字体到 assets/fonts`。构建存在部分 chunk 超过 500 kB 的提示，最大主包约 1,970.68 kB，gzip 622.61 kB。该提示属于体积检查结果。
- 已先查询 `wrangler deploy --help`，再执行 `WRANGLER_LOG_PATH=/tmp/koinote-noindex-validation/wrangler ./node_modules/.bin/wrangler deploy --dry-run --env production --env-file /dev/null --outdir /tmp/koinote-noindex-validation/worker --metafile /tmp/koinote-noindex-validation/worker-meta.json`。退出 0，输出 `Total Upload: 1481.03 KiB / gzip: 372.37 KiB` 和 `--dry-run: exiting now.`。这一步为本地编译与配置检查。Wrangler 提示顶层 `BACKEND_URL`、`IMAGE_READ_FALLBACK_BASE` 未出现在生产 vars，配置中的生产后端使用 secret，实际生产绑定由上线验收核实。
- 产物隔离核查。扫描 `spa/dist` 的 132 个文件和 Worker 输出目录的 7 个文件，对 `internal-docs`、完整文件名、卡号及需求标题均得到 0 匹配；Worker metafile 的 43 项输入中没有内部文档，输出 Markdown 模块仅为四语言 CHANGELOG。最初使用短词 `koinote-hub-noindex` 检索时命中 source map 中的工作区目录名，随后核实来源并改为完整文件名和正文标识检查。
- 源码隔离核查。worker、spa/src、public、backend 搜索 `internal-docs`、需求文件名与 `/api/docs`，结果均为空。已核对 Vite publicDir、构建输出路径和 Wrangler assets 配置。此项为源码及构建产物检查。
- `node --check scripts/_check_seo.mjs`、`node --check scripts/_check_agent_repository_sharing.mjs` 和 `git diff --check` 均退出 0。`package.json` 没有 lint 命令，仓库也没有 ESLint/Biome 配置，因此 lint 项记录为未配置。
- 实际数据库验证未执行。Worker 后端/ASSETS 和前端 API/路由使用模拟，R2 使用本地 Workerd/Miniflare；实际修改后的 Worker 与 React 组件均已执行。完整浏览器视觉、真实登录会话、外部服务真实调用及生产验收未执行。
- 本卡完成两个独立自审提交。实际 base 为 `7b5c59d1f8f99d9011c891f5cb889285a04da0a6`，最终 head SHA 记录在 Kandev 任务计划和交接消息，避免文档自引用提交 SHA。后续独立评审覆盖 base 至 head 全部 diff，再由开 PR 阶段创建或复用本卡唯一 PR。
- 上线后仍需按本文抽查清单验证热门仓库的真实状态，并由获授权人员将 `https://koinote.app/sitemap.xml` 提交 GSC、观察索引变化。本卡授权范围止于开放 PR。

## PR CI 回归修正 · 2026-11-28

- PR 为 `moutsea/koinote#6`，首轮 CI `46137086945` 的 web job 在 `test:backend-origin` 失败。根因是 `scripts/_check_backend_origin.mjs` 仍要求 sitemap 调用旧仓库 feed 一次，本卡已移除该调用，实际为零；先前定向验证遗漏了这个既有套件。
- 最小修正将同一回源鉴权用例改为请求 `/repositories/7` 与 `/api/agent/repositories/7`，响应使用有效的公开仓库 fixture。保留来源令牌校验、禁止跟随重定向和一次回源断言。sitemap 零回源继续由 `_check_seo.mjs` 的 GET/HEAD 和后端故障用例覆盖。
- 修改前本地 `npm run test:backend-origin` 实测 23 通过、1 失败，错误与 CI 一致，为 `0 !== 1`。修改后的完整 `npm test` 中该套件为 24 通过、0 失败，SEO 和分享页检查也通过。
- 完整 `npm test` 在后续 `test:share-preview` 因本机没有可执行 Go 编译器报 `spawnSync go EACCES`，未将其余未执行套件计作通过。此前 typecheck 已再次通过；本次仅修改测试与内部记录，既有功能构建证据仍对应相同运行时代码。
- 外部 HTTP 使用模拟，当前修正没有实际数据库或生产验证。首轮 CI 的 desktop macOS、Windows 和 secrets job 已通过，backend 当时仍在运行，最终结果以 GitHub Checks 为准。
- 本修正提交改变 HEAD，原 `ca21e0903a738b640548e65cfc44156675bfbd3d` 的独立 PASS 不覆盖新提交。推送后须对最终 HEAD 重新独立评审，完整检查通过前不发开 PR 阶段完成信号。仍只保留同一开放 PR，等待人工合并。
