<div align="center">

<!-- logo.png 是几乎纯黑的墨（平均亮度 3/255），在 GitHub 深色主题下会整个消失。
     用 <picture> 按主题切换：GitHub 支持 prefers-color-scheme 媒体查询。 -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/logo-dark.png">
  <img src="public/logo.png" alt="Koinote" width="96" height="96">
</picture>

# Koinote 锦鲤笔记 —— 所见即所得的在线 Markdown 编辑器

边写边渲染，图片粘贴即进图床，一键导出到微信公众号、知乎、PDF 和 Word。

**[koinote.app](https://koinote.app)** —— 打开即用，不必自己部署

[English](README.en.md) · [在线更新日志](https://koinote.app/changelog) · [中文更新日志](CHANGELOG.zh.md) · [路线图](docs/ROADMAP.zh.md) · [设计文档](docs/DESIGN.zh.md) · [MIT License](LICENSE)

[![CI](https://github.com/moutsea/koinote/actions/workflows/ci.yml/badge.svg)](https://github.com/moutsea/koinote/actions/workflows/ci.yml)

</div>

---

## 这是什么

一个 Typora 式的在线 Markdown 编辑器：不分左右分栏，写下的语法立刻变成排版后的样子。

和本地 Markdown 编辑器的五个区别：

- **图片粘贴即上传** —— 存进自己的 R2 图床，正文里是干净链接而不是一坨 base64
- **一键导出到自媒体** —— 微信公众号复制内联富文本并可保存到草稿箱，知乎可在确认后直接发布，掘金复制原生 Markdown；网页端和桌面端均可绑定最多 5 个公众号、设置默认账号；封面可用 Koinote Logo+标题、正文图片或 AI 生成
- **文档在云端** —— 多设备同步、可分享
- **Agent 通过 MCP 读写文档** —— Codex、Claude Code、OpenCode、OpenClaw 等客户端
- **AI 审阅式优化**（会员）—— 模型先给出标题、正文和排版 Diff，用户逐条决定是否应用

仓库还包含基于 Tauri 2 的 macOS / Windows 客户端 alpha：文档与图片本地优先保存，恢复网络后
自动上传图片、替换正文地址并同步文档；登录在系统浏览器完成，通过 `koinote://auth` + PKCE
把短期访问令牌交回客户端。

> 当前开源版包含完整的编辑、图床、导出、分享、MCP 与会员闭环；终生会员还可使用
> AI 优化，逐条审阅并落实标题和正文建议。

### 下载桌面客户端

[官网下载入口](https://koinote.app/download)会跳转到最新 GitHub Release，提供 macOS Apple
芯片、macOS Intel 和 Windows x64 安装包及 SHA-256 校验文件。客户端启动后自动检查更新，也可
在账户菜单手动检查；更新包使用独立的 Tauri 签名验证。

Alpha 安装包尚未购买平台证书，macOS 只做 ad-hoc 签名，首次运行会看到安全提醒：请右键应用
选择“打开”，或在“系统设置 → 隐私与安全性”中选择“仍要打开”。若提示应用“已损坏”，先核对
Release 中的 SHA-256，再执行：

```bash
xattr -dr com.apple.quarantine /Applications/Koinote.app
```

## 功能

**编辑**

- 所见即所得，无分栏预览。标题、列表、引用、表格、任务列表、代码块
- 代码高亮 37 种语言（highlight.js common 集）
- LaTeX 公式，行内 `$…$` 与块级 `$$…$$`，点击可回到源码
- 多标签同时开多篇、大纲导航、文件夹树、拖拽移动
- 15 款四语 Markdown 模板：免费提供会议纪要、每日记录、周复盘、任务清单、通用表格；会员解锁日报、周报、OKR、KPI、文章策划、README、PRD、论文阅读、决策记录与技术方案
- 移动端使用文档抽屉切换文章，桌面端保留可调宽度文件树
- 全局搜索标题与 Markdown 正文，`⌘K` / `Ctrl+K` 唤起并高亮命中位置
- 自动保存（防抖），失败会明确告知而不是静默丢内容
- revision 乐观锁检测网页与 Agent 的并发修改；冲突时保留本地草稿并提供合并界面
- 会员可查看、逐行比较和恢复文档历史，每篇保留 1–100 版；即使关闭历史，Agent 写入仍保留 1 个安全快照
- 会员可用 AI 优化像代码审查一样审阅标题、正文与排版 Diff，详见 [AI 优化](#ai-优化)

**会员与定价**

- 免费版 500 MB 云端空间和 5 款基础模板；终生会员一次付费得 10 GB、10 款高级模板、MCP、版本历史、AI 优化和 1,000 credits
- 独立 `/pricing` 页面对比两档权益，价目表从后端读取，支持 USD / CNY / EUR / JPY
- Stripe 一次性付款，支持银行卡、支付宝和微信支付
- 邀请奖励：专属链接自动带入邀请码，新用户注册后双方各得 500 MB，每账号累计最多 5 GB

**账号安全**

- 邮箱验证码注册与密码登录，另支持 Google / GitHub OAuth
- 邮箱密码账号支持验证码找回与登录后修改密码
- 修改或重置密码会立即失效其他设备上的旧会话；也可单独执行“退出其他设备”
- 找回密码请求对未知邮箱和 OAuth-only 账号使用统一响应，验证码只保存 HMAC
- 用户可在 Dashboard 输入当前邮箱并二次确认，立即注销账号；图片异步回收，必要财务记录解除账号关联后依法保留

**桌面客户端（alpha）**

- macOS 与 Windows 共用 React / TipTap 界面，Tauri 只承载原生窗口、SQLite、深链和系统钥匙串
- 可选择无需账号的完全本地模式：密码经 PBKDF2 派生 AES-GCM 密钥，文档、文件夹名称与图片加密写入 SQLite；该模式禁用同步、分享、会员、MCP、更新检查及其他全部网络请求
- 本地模式与账号离线缓存使用独立命名空间；登录账号后可再次验证本地密码，将当前本地文档、目录和图片复制为普通账号文档，导入后两边继续独立演进
- 文档、目录、标签页和图片本地优先；离线可创建、编辑、粘贴图片、搜索和整理，联网后自动上传本地图片、替换为图床 URL 并同步正文
- 已同步的站内图片自动缓存上限为 512 MB，也可在客户端首页手动清空；清空后会按打开的文档重新缓存，退出账号会删除全部本地副本
- 客户端主导航提供 MCP / 版本控制文档和价格页，联网时可管理 MCP 令牌、查看活动日志、发起会员 Checkout，并由管理员查看站点统计；账号注销会同时清理本机 SQLite 数据与钥匙串令牌
- 网页与客户端在前台定时检测远端修改，窗口重新聚焦时立即检查；无本地改动时自动更新，有草稿时提示处理冲突
- revision 冲突会同时保留本地稿与云端稿，由用户明确选择，不用“最后写入者”静默覆盖正文
- OAuth / 密码登录仍在系统浏览器完成；PKCE 授权码单次有效，访问令牌 15 分钟，刷新令牌 30 天轮换
- 访问令牌、刷新令牌和未完成的 PKCE verifier 只存 macOS Keychain / Windows Credential Manager，不进 SQLite
- 启动后自动检查签名更新，账户菜单也可手动检查并查看下载进度；安装完成后自动重启

**图床**

- 粘贴或拖入即上传到 Cloudflare R2
- 从网页粘贴的外链图片自动转存，避免对方删图后裂图
- 按 magic byte 校验真实类型，拒收 SVG（能内嵌脚本）
- 每用户配额（免费用户默认 500 MB，终生会员 10 GB，邀请奖励最多叠加 5 GB；均包含正文与图片）
- 网页显示自有图片时走同源 `/images/...`，导出保留 CDN 地址，避开浏览器
  CORS / Local Network Access 误拦截
- 文档删图后异步回收不再引用的 R2 对象；删除前会复查引用，CDN 模式同时清缓存

**导出**

| 格式           | 说明                                                       |
| -------------- | ---------------------------------------------------------- |
| Markdown       | 原样导出                                                   |
| HTML           | 单 HTML 文件，正文样式内嵌；KaTeX CSS 与图片仍使用外部地址 |
| DOCX           | 走文档树构建，公式保留 LaTeX 源码                          |
| PDF            | 桌面端直接保存；浏览器端打开系统打印面板。文字可选、可搜索 |
| **自媒体平台** | 微信公众号草稿箱、知乎 OpenAPI 直发或网页辅助发布、X Article 直接发布（图片由服务端上传）；掘金复制原生 Markdown |

「我的文档」还支持批量迁移：可导入单个 `.md`、带图片的文件夹或 ZIP，也可把全部
文档、文件夹结构和引用图片一次导出为可再次导入的 ZIP。

富文本导出做了不少细活：代码高亮在导出时重新生成（编辑器里的高亮是视图装饰，
不在文档里）、缩进用不换行空格 + `<br>` 承载（微信会剥掉 `white-space`）、
代码块带 Mac 窗口三点、公式栅格化成图片上传。

微信公众号提供 20 套可直接内联的排版主题。除经典媒体与技术文档风格外，还加入
Koinote Paper（暖纸长文）、Koinote Signal（产品与 AI）、Koinote Notes（知识笔记）
和 Koinote Pulse（社区通讯）四套原创主题；编辑器预览与复制到微信使用同一套规则。
主题名称和分组会跟随当前界面语言显示。

### 微信公众号草稿箱

终生会员可以在网页端或桌面客户端绑定最多 5 个已认证公众号，选择默认账号后，把当前文章和内联主题效果直接保存到指定账号的草稿箱。使用时依次完成：

1. 在微信公众平台准备 AppID、AppSecret，并将 Koinote 云端出口 IP 加入接口白名单。
2. 打开 Koinote「设置 → 微信公众号」完成绑定；AppSecret 只在服务端加密保存。
3. 在编辑器选择「导出到自媒体 → 微信公众号 → 同步到账号草稿箱」，再选择封面并确认保存。

封面不是必需项，可使用 Koinote Logo + 标题、正文图片或 AI 生成的图片。每次成功同步到草稿箱消耗 20 credits；每次成功生成 AI 封面另消耗 20 credits。失败不会扣除对应费用。文章只会进入草稿箱，不会被 Koinote 直接发布。完整的微信后台配置和排查步骤见[公众号配置教程](https://koinote.app/docs/wechat-official-account)。

### 知乎直接发布

在「设置 → 知乎」绑定知乎开放平台凭证后，可在编辑器选择「导出到自媒体 → 知乎」并确认直接发布。文章不会写入知乎草稿箱；OpenAPI 直发暂不支持包含图片的文章，发布前会明确提示。

如果没有 OpenAPI 凭证，仍可使用知乎面板中的「复制并打开知乎」：Koinote 会复制带主题的标题和正文（包含图片）并打开知乎写作页，用户粘贴完整内容后自行确认发布。

### X 文章发布

在「设置 → X」通过 X 官方 OAuth 2.0 授权绑定账号。只有 X Premium 或 Premium+ 账号可以发布 Article；编辑器的 X 面板会把标题、正文和图片作为一篇 X Article 发布。正文按 X Articles API 的加权字符规则限制为最多 10,000，图片最多 20 张，超出时会在发布前提示，不会静默截断。每次成功发布消耗 20 Koinote credits。OAuth 令牌只在服务端加密保存。

**分享**

- 两档权限：知道链接即可访问 / 需要口令
- 放宽权限时强制换 token，老链接立刻失效
- 口令 bcrypt 存哈希，两层限流防爆破
- 分享页动态生成网页标题与 OpenGraph 卡片，显示累计阅读次数，并允许登录用户“复制到我的 Koinote”
- 口令分享在解锁前不暴露标题、摘要或封面；阅读统计只保存累计数，不记录访客身份

**MCP**

- 支持 Codex、Claude Code、OpenCode、OpenClaw 等 Streamable HTTP MCP 客户端，配置见 [Agent 文档访问](#agent-文档访问mcp)
- Dashboard 的 MCP 活动日志保留 180 天，记录工具、令牌、文档、结果与耗时，不记录正文或令牌内容

**界面**

- 四语：中文 / English / 日本語 / Français
- 深浅色主题，水墨风格视觉

**更新与提醒**

- 每次发版从四语更新日志自动提取要点，向发版前已注册的用户展示一次；管理员也可在后台编写提醒，由后端 LLM 译为四语后统一发布
- 公开 `/changelog` 页面直接读取仓库的 `CHANGELOG.md`，按版本时间线展示

**管理后台**

- 用户与会员规模、按币种收入、订单、全站存储、30 天趋势、产品转化漏斗、D1/D7/D30 留存、最近用户与付款
- 服务监控读取宿主机 CPU、内存、磁盘与网卡流量
- 可选接入 Cloudflare Analytics，查看当天边缘 UV / PV、请求数和流量

## 技术栈

```
浏览器 ──▶ Cloudflare Worker ──┬─ 托管 SPA 静态资源
                               ├─ /api/images/* 与 /images/* ──▶ R2
                               ├─ /api/internal/email/* ──▶ Email Sending
                               └─ 其余 /api/*、/mcp ──▶ Go 后端 ──▶ PostgreSQL
Go 后端 ──内部回调────────────▶ Worker（验证码邮件 / R2 回收）
PostgreSQL ──pg_dump / AES-256-GCM──▶ 私有备份 R2（每 6 小时）
浏览器 ──Stripe Checkout──────▶ Stripe ──签名 Webhook──▶ Go 后端 ──▶ 飞书机器人
桌面端 ──本地 SQLite（正文与图片）──▶ 离线读写 ──联网同步 / Bearer token──▶ Worker / Go 后端 / R2
```

- **前端** Vite · React 19 · TypeScript · TanStack Router · Tailwind v4
- **编辑器** TipTap v3（ProseMirror）· tiptap-markdown · KaTeX · lowlight
- **后端** Go（stdlib `net/http`）· pgx · Stripe Go SDK · PostgreSQL 16
- **边缘** Cloudflare Worker · R2 · Email Sending
- **桌面端** Tauri 2 · Rust · SQLite · macOS Keychain / Windows Credential Manager

浏览器会话使用无状态 HMAC-SHA256 签名 cookie；桌面端使用只在数据库保存 SHA-256 摘要的
不透明访问 / 刷新令牌，以支持轮换、撤销和修改密码后的统一失效。

## Agent 文档访问（MCP）

终生会员可以在 Dashboard 的「Agent 文档访问（MCP）」区域创建个人访问令牌（PAT），
然后让支持 Streamable HTTP MCP 的客户端连接 `https://koinote.app/mcp`。站内的
[MCP 接入指南](https://koinote.app/docs/mcp)汇总了 Codex、Claude Code、OpenCode、OpenClaw、
WorkBuddy 与通用客户端的配置及版本控制说明。常规 MCP 文档工具只负责鉴权、文档读写、版本控制
与审计，由客户端提供模型能力；微信公众号 GEO 摘要生成是例外，会按账号设置调用内置模型或 BYOK
渠道。除使用 GEO 生成工具外，Koinote 不需要 OpenAI、Anthropic 或其他模型 API Key。

PAT 支持只读、读写或仅发布 scope、1–365 天或永久有效、创建后修改有效期和单独撤销。数据库用 SHA-256 摘要鉴权，另用
AES-GCM 加密保存可恢复副本；账号本人可按需再次查看，列表不会直接返回完整令牌。每次 MCP
请求都会重新检查会员状态、有效期与撤销状态。建议先创建只读令牌，需要写入时再单独创建
读写令牌。Dashboard 的活动日志可分页追踪 Agent 调用过的工具、关联文档、结果与耗时，保留
180 天且不保存正文或令牌原文。

Codex 配置（把令牌放进环境变量，不要写进仓库）：

```bash
export KOINOTE_MCP_TOKEN='knt_mcp_...'
```

```toml
# ~/.codex/config.toml
[mcp_servers.koinote]
url = "https://koinote.app/mcp"
bearer_token_env_var = "KOINOTE_MCP_TOKEN"
```

Claude Code：

```bash
claude mcp add --transport http koinote https://koinote.app/mcp \
  --header "Authorization: Bearer knt_mcp_..."
```

OpenCode（写入全局或项目级 `opencode.json`；配置格式见其
[MCP 官方文档](https://opencode.ai/docs/mcp-servers/)）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "koinote": {
      "type": "remote",
      "url": "https://koinote.app/mcp",
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:KOINOTE_MCP_TOKEN}"
      }
    }
  }
}
```

OpenClaw：

```bash
openclaw mcp add koinote \
  --url https://koinote.app/mcp \
  --transport streamable-http \
  --header "Authorization=Bearer ${KOINOTE_MCP_TOKEN}"

openclaw mcp doctor koinote --probe
```

其他客户端无需 Koinote 专用适配：只要支持远程 Streamable HTTP MCP，并允许给请求设置
`Authorization: Bearer <PAT>`，即可使用相同端点和令牌接入。

只读工具包括分页列出文档和文件夹、按文件夹筛选、列出文件夹树、查看已绑定公众号（不返回密钥）、列出可用文档主题、查询 credits 余额、按标题与正文搜索、读取文档大纲和上下文、查找正文锚点、比较版本、分段读取正文、查看历史版本和列出回收站；读写令牌额外获得
新建、追加、整篇更新、精准文本补丁、修改元数据、创建/重命名/移动/删除文件夹、移动文档、批量移动文档、恢复版本、移入回收站与恢复文档。Agent 不能永久删除文档，永久删除只在
网页回收站提供标题确认；普通删除保留 30 天。整篇更新、追加、移入回收站和恢复都要求最新 revision；网页端使用同一套乐观锁并在冲突时提供
本地/远端合并界面。详细取舍见[设计文档](docs/DESIGN.zh.md#mcp-文档访问)。

需要向微信公众号草稿箱推送时，请创建“仅发布”令牌。Agent 可先调用 `list_wechat_accounts` 选择默认账号或指定账号；该令牌只能读取文档并调用
`push_wechat_draft`，不会获得修改文档或删除文档的权限；推送会在服务端生成基础 HTML，不会套用文档的 Koinote 微信主题，并使用已绑定的公众号上传文章图片，属于外部副作用。每次成功推送消耗 20 credits。
封面默认为 Koinote 默认封面，也可选择正文图片或 AI 生成封面（每张 AI 封面额外消耗 20 credits）。

微信公众号 GEO 摘要也可通过 MCP 管理：`get_wechat_geo_summary` 用于读取已保存摘要和检查是否过期，读写或仅发布令牌可以调用
`generate_wechat_geo_summary` 生成并保存摘要，也可以用 `update_wechat_geo_summary` 修改文本或开关。使用内置模型生成会按实际用量消耗 credits，BYOK 渠道不扣费。
推送草稿时需显式传入 `includeGeo: true`，且摘要必须已启用并与当前文档匹配；默认不会把隐藏语料带入草稿。

## AI 优化

终生会员可以在编辑器工具栏打开「AI 优化」。开始前编辑器会先保存当前草稿，然后由模型
返回一组可审阅的变更，而不是直接覆盖文章：每项建议都显示原因、删除内容和新增内容，可以
单独应用或忽略，也可以一次应用/忽略全部。标题会获得 0–100 分；低于 60 分时会要求模型
给出 2–3 个互不相同的候选标题，但不会为了凑数而让整份审阅失败。正文修改必须以文档中唯一出现的原文为锚点，重叠或找不到原文的
建议会被拒绝。应用时仍校验最新 revision，并为会员留下可恢复的历史版本。

结果在界面中分为「标题建议」「正文表达」「结构排版」三类。结构排版会从层级、可读性、重点、节奏、模块和移动端
六个维度评分，并基于 Markdown AST 给出可验证的标题层级调整、拆段、转列表、重点块和分隔线建议。
结构操作由服务端生成确定性补丁，不能借排版之名改写原文；与文字修改重叠的排版建议不会进入待办列表。用户还可以
选择任一结构维度发起第二轮深入分析，让模型结合更多文章上下文寻找段落、篇章或论证层面的改动。

审阅提交后在后台运行，完成后通过站内通知返回结果。第一波并行完成标题定位与六维结构诊断，
第二波让全文级发展性编辑和正文分块任务带着诊断结果工作，同时最多调用 3 路模型。进度与部分建议
会持久化，切换页面或刷新后仍可查看；某一路返回无效结果只重试该子任务。全部完成前部分建议保持只读，
避免应用一半后让剩余结果基于过期正文。为控制超长文成本，标准结构诊断最多携带 32 KiB 实际块文本和
400 个块元数据；全文级编辑与深入分析最多携带 96 KiB 实际块文本和 600 个块元数据，并按全文分布与
长段落采样；正文分块仍覆盖全文。

内置模型按模型报告的实际输入+输出 token 计费，每 2,000 token 扣 1 credit（向上取整）；
审阅最终失败不扣费；若校验失败后重试成功，则按本次审阅全部实际模型调用的累计 token 计费。
充值包为 3,000 / 10,000 / 30,000 credits 三档，
金额、币种和 credits 都由后端白名单及 Stripe 回调复核。

会员也可在「AI 设置」配置自己的渠道：

- `openai`：OpenAI-compatible Chat Completions，Base URL 通常以 `/v1` 结尾；
- `anthropic`：Anthropic Messages，后端调用 `/v1/messages`。

BYOK 调用不消耗 credits。API Key 使用独立的 `LLM_CREDENTIAL_ENCRYPTION_KEY` 通过 AES-GCM
加密，列表只返回掩码提示，创建后不会把明文返给浏览器；Base URL 在保存与调用时均做 HTTPS、
私网/回环地址和重定向限制。需要注意：执行优化时，所选模型服务商会收到当前文章的标题与正文，
因此只能配置你信任的渠道。

## 快速开始

需要 Node 20.19+（或 22.12+）、Go 1.23+、Docker Compose。

```bash
git clone https://github.com/moutsea/koinote.git && cd koinote
cp .env.example .env
```

**编辑 `.env`，两项必填：**

```bash
# 1. 会话签名密钥（留空后端拒绝启动）
openssl rand -base64 48

# 2. Worker → 后端的内部令牌
openssl rand -base64 36 | tr '+/' '-_' | tr -d '='
```

把生成的值分别填进 `SESSION_SECRET` 和 `BACKEND_INTERNAL_TOKEN`，
并把 `NODE_ENV` 改成 `development`（本地开发用 http，`production` 会让 cookie
带上 `Secure` 而存不住）。本地测试邮箱注册时再设 `ENABLE_MOCK_EMAIL=true`，
注册页会自动填入测试验证码，不会发送真实邮件。

然后：

```bash
npm ci
docker compose up -d postgres         # 起数据库
npm run backend:dev                   # 起后端（自动跑迁移）
npm run dev                           # 起前端 → http://localhost:5273
```

图片上传要额外起 wrangler（R2 绑定只在 Worker 侧，自带本地模拟）：

先在仓库根目录创建不会入库的 `.dev.vars`：

```dotenv
BACKEND_INTERNAL_TOKEN=<与 .env 相同的值>
```

再启动 Worker：

```bash
npx wrangler dev --port 8788
```

本地 Worker 默认代理 `http://localhost:8080`。后端改了端口时，再用
`--var BACKEND_URL:http://localhost:<端口>` 覆盖；只改 `.env` 不会自动传给 Wrangler。

本地测试会员支付时，在 `.env` 填 Stripe test mode 的 `STRIPE_SECRET_KEY` 和
`STRIPE_LIFETIME_PRODUCT_ID`。测试 Credits 充值时再创建一个 Product，并把公开的 `prod_...`
填入 `STRIPE_CREDITS_PRODUCT_ID`；三档充值价格不需要在 Dashboard 另建 Price。后端会按白名单为 Credits Product 创建
USD、CNY、EUR、JPY 内联价格，并让 Stripe 按所选币种动态展示银行卡、支付宝、微信支付等可用方式。成功回跳会主动确认并发放 credits；要同时测试 webhook，
再安装 Stripe CLI 并运行：

```bash
stripe listen --forward-to localhost:8080/api/billing/webhook
```

把 CLI 输出的 `whsec_...` 填入 `STRIPE_WEBHOOK_SECRET` 后重启后端，支付可使用 Stripe
测试卡 `4242 4242 4242 4242`（任意未来日期与 CVC）。

本地测试 AI 优化时，先为 `LLM_CREDENTIAL_ENCRYPTION_KEY` 生成独立随机值。内置模型
需要同时填写 `AGENT_LLM_PROTOCOL`、`AGENT_LLM_BASE_URL`、`AGENT_LLM_API_KEY`、
`AGENT_LLM_MODEL`；四项全空时只关闭内置 credits 模式，会员配置的 BYOK 仍可用。

本地测试微信公众号草稿箱前，也必须单独生成并长期保留
`WECHAT_CREDENTIAL_ENCRYPTION_KEY`；它不会回退复用 `SESSION_SECRET`。未配置时后端仍可启动，
但公众号绑定不可用。AI 封面生成为可选能力，需要同时配置
`WECHAT_COVER_IMAGE_BASE_URL`、`WECHAT_COVER_IMAGE_API_KEY`、`WECHAT_COVER_IMAGE_MODEL`，
API Key 只由后端读取。绑定前还要在微信公众平台把后端出口 IP 加入 IP 白名单。

本地测试知乎直接发布时，生产环境必须配置独立的
`ZHIHU_CREDENTIAL_ENCRYPTION_KEY`；开发环境留空时复用 `SESSION_SECRET`。在知乎开放平台
申请 OpenAPI 凭证后，进入设置中的“知乎”绑定 App Key 和 App Secret。发布前会弹出确认，
确认后直接调用知乎发布接口，不会写入知乎草稿箱。当前知乎发布暂不支持包含图片的文章，
含图片时会在发布前提示；需要图片的文章请先使用微信公众号或掘金等其他导出方式。

如果微信 API 需要经专用中转机访问，本地 Docker 后端可把
`WECHAT_API_PROXY_URL` 设为 `http://host.docker.internal:18080`，并在宿主机建立
`ssh -N -L 18080:127.0.0.1:18080 root@<中转机>` 隧道；生产环境优先使用 WireGuard
私网地址 `http://10.77.0.1:18080`，若云厂商尚未放行 UDP，则使用同样的 SSH 隧道落到
Docker 网关地址。中转服务只接受发往 `api.weixin.qq.com:443` 的 CONNECT 请求，不是通用代理。

详细步骤、端口冲突、全容器启动见[设计文档](docs/DESIGN.zh.md#本地开发)。

### 桌面客户端开发

额外安装 Rust stable；macOS 需要 Xcode Command Line Tools，Windows 需要 Microsoft C++
Build Tools 与 WebView2。先按上文启动本地 PostgreSQL、后端与 Vite，再运行：

```bash
npm run desktop:dev             # Koinote Local 开发客户端，连接本机 http://localhost:5273
npm run desktop:dev:local       # Koinote Local（同上）
npm run desktop:dev:production   # Koinote 正式配置，连接 https://koinote.app
npm run desktop:check           # Rust / Tauri 编译检查
npm run desktop:build           # 生成连接正式服务的安装包
npm run desktop:build:local     # 生成 Koinote Local 测试安装包
```

正式客户端固定同步 `https://koinote.app`；本地测试客户端使用独立的应用标识、系统钥匙串服务和
`koinote-local://` 深链，并固定同步 `http://localhost:5273`。两者不会共用登录会话、离线数据库或
OAuth 回调。桌面端 SQLite 保存离线文档与图片副本，但不保存令牌；断网粘贴的图片先使用本地占位地址，联网后
自动上传到 R2 并把正文替换成图床 URL。自动下载的远端图片缓存最多占用 512 MB；用户主动
粘贴但尚未上传的图片不会被缓存上限淘汰。退出账号会清除该账号的离线文档与图片缓存。
完全本地模式的数据使用独立 SQLite 命名空间并加密存储，密码和派生密钥不会上传，派生密钥
也不会写入磁盘；关闭客户端后必须重新输入密码。忘记密码无法恢复，因此应定期导出 ZIP 备份。

官方 Release 使用 `TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
生成更新签名，并发布 `latest.json`。Fork 仓库发布自己的客户端前，必须生成新的 Tauri
签名密钥，把私钥写入同名 GitHub Secrets，并替换 `src-tauri/tauri.conf.json` 中的
`plugins.updater.pubkey` 与更新地址；不要复用 Koinote 官方公钥和 Release 地址。

### 微信导出检查与结构化排版

微信公众号导出弹窗会先给出本地发布检查：标题长度、正文标题重复、图片替代文字、图片转存路径和模块语法都会显示为可解释的提醒。检查不会阻止复制，也不会修改文档；草稿标题仍以编辑器标题为准。

文章可以在开头使用轻量的 YAML frontmatter 保存发布元信息。支持 `title`、`author`、`digest`、`summary` 和 `description`；导出时 frontmatter 会从可见正文移除，标题、摘要和作者会作为公众号草稿元信息传入。

导出阶段支持适合窄屏阅读的结构块，语法来自 Koinote 的独立数据模型：

```markdown
:::hero
eyebrow: 深度观察
title: 先把文章的主判断讲清楚
subtitle: 让读者在第一屏知道为什么值得继续读
:::

:::metrics[核心数据]
阅读量 | 42% | 来自最近一轮测试
效率 | 2x | 比原流程更快
:::

:::callout
type: warning
body: 发布前请检查图片和链接。
:::
```

目前可用模块包括 `hero`、`toc`、`callout`、`metrics`、`steps`、`quote`、`quote-card`、`faq` 和 `cta`。未知或格式错误的模块会保留为普通文本，并在发布前检查中提示，不会静默丢失内容。模块只在微信公众号富文本导出和草稿流程中渲染，编辑区仍保持原有 Markdown 交互。

## 自建须知

这几条会直接影响安全，部署前值得看一眼：

**`SESSION_SECRET` 必填，没有回退。** 留空后端拒绝启动 —— 这是故意的。
它曾经会回退到一个硬编码常量，而那在开源仓库里等于公开签名密钥。

**`BACKEND_INTERNAL_TOKEN` 自己生成，别用任何示例值。** 这个头能让持有者伪造成
任意用户（后端见到它就信 `X-Auth-User-Id`，不再校验会话），等同于全站管理员凭据。
`.env.example` 里刻意留空。

**生产环境的 `EMAIL_VERIFICATION_SECRET` 必须独立生成。** 后端会拒绝在生产环境
复用 `SESSION_SECRET`，这样轮换验证码密钥不会让所有会话失效，邮件链路泄露也不会
扩大成会话伪造。

**生产环境的 `LLM_CREDENTIAL_ENCRYPTION_KEY` 必须独立且持久。** 它只用于会员 BYOK
API Key 的 AES-GCM 加密，不能复用会话、MCP 或模型服务密钥。直接轮换会让既有渠道无法解密，
轮换前必须先做密文迁移。

**生产环境的 `WECHAT_CREDENTIAL_ENCRYPTION_KEY` 同样必须独立且持久。** 它只用于
公众号 AppSecret 的 AES-GCM 加密，不能复用会话、BYOK 或封面模型 API Key；直接轮换会让
既有公众号绑定无法解密。公众号 token、封面生成和草稿创建都只在后端完成，客户端永远拿不到
AppSecret 或封面模型密钥。

**生产环境的 `ZHIHU_CREDENTIAL_ENCRYPTION_KEY` 必须独立且持久。** 它只用于知乎 OpenAPI
AppSecret 的 AES-GCM 加密，不能复用会话、MCP、BYOK 或微信凭据密钥；直接轮换会让既有知乎
绑定无法解密。AppSecret 只在后端使用，不会下发到 SPA、桌面客户端或知乎请求正文。

**微信公众号封面模型是可选的完整配置组。** `WECHAT_COVER_IMAGE_BASE_URL`、
`WECHAT_COVER_IMAGE_API_KEY`、`WECHAT_COVER_IMAGE_MODEL` 必须三项齐全或全部留空；生产只接受
HTTPS。启用后仅终生会员可调用，每生成一张封面固定消耗 20 credits，并按用户限流。模型服务商会收到用户输入的封面提示词，
不会收到公众号 AppSecret 或文章正文。

**AI 优化内置模型是可选的完整配置组。** `AGENT_LLM_PROTOCOL`、`AGENT_LLM_BASE_URL`、
`AGENT_LLM_API_KEY`、`AGENT_LLM_MODEL` 必须四项齐全或全部留空；生产只接受 HTTPS。
BYOK 端点还会拒绝本机、私网、带用户信息的 URL 和重定向，但模型服务商仍会收到待审文章。

**手动提醒翻译是可选的后端能力。** `ANNOUNCEMENT_LLM_BASE_URL`、
`ANNOUNCEMENT_LLM_API_KEY`、`ANNOUNCEMENT_LLM_MODEL` 必须同时配置或同时留空；生产环境
只接受 HTTPS。这里连接的是兼容 Anthropic Messages 的中转服务，端点运营者会收到 API Key
和管理员正在发布的标题、摘要与要点，因此只能配置你信任的服务；请求不会包含用户账号、文档
或图片，密钥也不会下发到 SPA、Worker 或客户端。不配置时版本提醒仍会正常导入，只是后台不能
手动发布多语言提醒。

**Stripe 生产配置必须完整。** 启用任一商品时必须配置 `STRIPE_SECRET_KEY`，并至少配置
`STRIPE_LIFETIME_PRODUCT_ID` 或 `STRIPE_CREDITS_PRODUCT_ID`；生产还必须配置
`STRIPE_WEBHOOK_SECRET`。支付成功后本站数据库才是会员与 credits 的权益真值，前端返回值
不会直接授予配额或余额。

**`NODE_ENV` 决定 cookie 的 `Secure` 标志。** 生产必须是 `production`。

**图片是「知道 URL 即可读」的。** key 随机不可枚举，但没有鉴权 —— 私有文档里的
图片，链接泄漏后任何人都能看。这是图床的常规做法，但用户通常会假设「私有文档里的
图也是私有的」。你的场景不能接受的话，得改成签名 URL。

**限流是进程内的。** 多实例部署时各进程独立计数，实际阈值被放大 N 倍。
上多实例前要接入共享限流存储。

**改了后端代码要重新构建镜像。** `docker compose up -d` 不重新构建，
要用 `docker compose up -d --build backend` —— 否则代码改了行为没变，且没有任何报错。

## 部署

```bash
npm run build     # → spa/dist
npm run deploy    # 构建并部署 production Worker + SPA，不部署后端
```

后端首次部署需要先在 VPS 配好 `.env` 与 `deploy/Caddyfile`，再从仓库根目录运行：

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

生产 `.env` 应设置 `POSTGRES_PORT=127.0.0.1:5432`、
`BACKEND_PORT=127.0.0.1:8080`，并正确设置 `NODE_ENV=production`、`APP_URL`、
`WORKER_URL` 以及会话/OAuth 凭据；如需后台手动发布提醒，还要设置三项
`ANNOUNCEMENT_LLM_*` 后端变量。官方部署 workflow 把 API Key 放在 Actions Secret，
把中转地址和模型名分别放在 Actions Variable `ANNOUNCEMENT_LLM_BASE_URL` 与
`ANNOUNCEMENT_LLM_MODEL`；三项全空时普通部署不会因此失败。BYOK 需要独立的必填 Secret
`LLM_CREDENTIAL_ENCRYPTION_KEY`；可选的 AI 优化内置模型同样把 API Key 放 Secret，把
`AGENT_LLM_PROTOCOL`、`AGENT_LLM_BASE_URL`、`AGENT_LLM_MODEL` 放 Actions Variables。
四项全空时部署保留 VPS 已有值。仓库里的
`koinote.app`、`api.koinote.app`、`img.koinote.app` 和 `verify@koinote.app` 是当前官方
部署值，自建时要同步替换 `wrangler.jsonc`、`deploy/Caddyfile` 与 OAuth 回调配置。

Admin 的“服务监控”读取整台 Linux 服务器的 CPU、Load Average、内存、Swap、磁盘、
主网卡流量和开机时长。production compose 只读挂载所需的五个 `/proc` 指标文件，
并用 `deploy/host-metrics/filesystem-probe` 单文件只读挂载探测其所在文件系统容量；
不会挂载 Docker socket、完整 `/proc` 或宿主机根目录，也不依赖宿主机目录 UID
与容器进程一致。使用自定义容器编排时，需要为
`HOST_METRICS_PROC_PATH` 和 `HOST_METRICS_FILESYSTEM_PATH` 提供等价的只读挂载。

production Worker 要设的 secret：

```bash
npx wrangler secret put BACKEND_URL --env production
npx wrangler secret put BACKEND_INTERNAL_TOKEN --env production   # 与后端同值
npx wrangler secret put CLOUDFLARE_ZONE_ID --env production
npx wrangler secret put CLOUDFLARE_CACHE_PURGE_TOKEN --env production
```

`BACKEND_URL` 要指向后端的 HTTPS 源站，例如 `https://api.koinote.app`；
`BACKEND_INTERNAL_TOKEN` 必须与 VPS `.env` 完全一致。

后两项用于 CDN 图片删除后的全局缓存清理；如果改成 Worker 代理图片，需要同时调整
`IMAGE_PUBLIC_BASE` 和部署 workflow。邮箱注册使用 Cloudflare Email Sending，首次部署先执行：

```bash
KOINOTE_DOMAIN=koinote.app
npx wrangler email sending enable "$KOINOTE_DOMAIN"
```

Worker 通过 `EMAIL` binding 从 `verify@koinote.app` 发信，不需要邮件 API token；
VPS 的 `.env` 需要把 `WORKER_URL` 设为 `https://koinote.app`，并与 Worker 配置相同的
`BACKEND_INTERNAL_TOKEN`。生产还必须设置独立的 `EMAIL_VERIFICATION_SECRET`；验证码
仅以 HMAC 形式保存在 Postgres，10 分钟失效。

### PostgreSQL 异地备份与恢复

`database-backup` 是显式启用的 compose profile。它每 6 小时执行一次 PostgreSQL 16
custom-format `pg_dump`，压缩后以 CMS AES-256-GCM 公钥加密，再通过内部鉴权上传到独立的
私有 R2 bucket。失败会在 15 分钟后重试；配置了飞书机器人时，同一故障最多每 6 小时告警一次。
保留策略是最近 28 份全部保留，此后保留到第 35 天的每日版本、到第 180 天的每周版本，以及
到第 400 天的每月版本，因此成功运行时 RPO 最多约 6 小时。

这份备份只包含 PostgreSQL（账号、文档、支付与图片账本），**不复制 `koinote-images` 中的图片对象**。
备份 bucket 不要配置公共访问或自定义域名。单份备份限制为 95 MiB，以保持在 Cloudflare 常规
请求体上限内；接近该大小时应在告警发生前改为分片或 R2 S3 直传。

首次启用需要创建私有 bucket，并生成仅由运维人员保存的恢复私钥。仓库里的证书属于官方部署；
自建实例必须替换成自己的公钥证书，私钥应至少另存一份离线副本，不能放在 VPS、容器镜像或 Git：

```bash
mkdir -p ~/.koinote-backup
chmod 700 ~/.koinote-backup
openssl req -x509 -newkey rsa:4096 -nodes -sha256 -days 3650 \
  -subj '/CN=Koinote Database Backup' \
  -keyout ~/.koinote-backup/database-backup-private-key.pem \
  -out deploy/database-backup/database-backup-certificate.pem
chmod 600 ~/.koinote-backup/database-backup-private-key.pem
npx wrangler r2 bucket create koinote-backups
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build database-backup
```

恢复时先下载、核对响应中的 `X-Koinote-Backup-Sha256`，再解密并让 `pg_restore` 检查目录；
应恢复到新建的空数据库，验证用户数、文档数和迁移版本后再做受控切换，不要直接覆盖正在运行的主库：

```bash
read -rsp 'Internal token: ' KOINOTE_INTERNAL_TOKEN; echo
BACKUP_NAME=koinote-2026-08-16T1200Z.dump.cms
curl -fsS -D backup.headers \
  -H "X-Koinote-Internal-Token: $KOINOTE_INTERNAL_TOKEN" \
  "https://koinote.app/api/internal/backups/database/$BACKUP_NAME" \
  -o "$BACKUP_NAME"
unset KOINOTE_INTERNAL_TOKEN
grep -i '^x-koinote-backup-sha256:' backup.headers
sha256sum "$BACKUP_NAME"
openssl cms -decrypt -binary -inform DER \
  -in "$BACKUP_NAME" \
  -recip deploy/database-backup/database-backup-certificate.pem \
  -inkey ~/.koinote-backup/database-backup-private-key.pem \
  -out koinote.dump
pg_restore --list koinote.dump >/dev/null
createdb koinote_restore
pg_restore --exit-on-error --no-owner --no-privileges \
  --dbname koinote_restore koinote.dump
```

`GET /api/internal/backups` 使用同一个内部令牌，可查看备份总数、最近一次上传时间、大小和校验和。

管理员入口只对数据库中 `is_admin=true` 的用户显示。首次部署可按邮箱授予管理员：

```bash
docker compose exec postgres psql -U koinote -d koinote \
  -c "UPDATE users SET is_admin = true WHERE lower(email) = lower('you@example.com');"
```

`/admin` 的用户、会员、收入、订单与存储来自 PostgreSQL。今日 UV / PV 是可选的
Cloudflare 边缘 HTTP Analytics：创建一个独立 Token，权限设为
`Zone / Analytics / Read`，Zone Resources 只包含 Koinote 的 Zone，然后将
它保存为 `CLOUDFLARE_ANALYTICS_TOKEN`。不要复用只有 Cache Purge 权限的
`CLOUDFLARE_CACHE_PURGE_TOKEN`。未配置或 Cloudflare 暂时失败时，只有流量卡片显示不可用，
其余管理数据仍正常展示。

Stripe Dashboard 还需创建 webhook endpoint：

```text
https://koinote.app/api/billing/webhook
event: checkout.session.completed
event: checkout.session.async_payment_succeeded
```

将 endpoint 的 signing secret 配为 `STRIPE_WEBHOOK_SECRET`。要显示支付宝和微信支付，
需在 Dashboard 里启用 Alipay 与 WeChat Pay —— 代码不固定支付方式，由 Stripe 按账号地区、
用户位置和币种动态决定，条件不满足时只显示银行卡。金额校验、幂等与多服务共用同一 Stripe
账号的处理见[设计文档](docs/DESIGN.zh.md#会员与支付)。

想在收款时收到飞书通知，配上成对的 `BOT_WEBHOOK` 与 `BOT_WEBHOOK_SECRET`（只配一项
生产环境会拒绝启动）。通知只含站内用户 ID、金额、币种和订单号，失败按退避重试，
不影响已发放的权益。

检查是否开通请用 `npx wrangler email sending list` 和
`npx wrangler email sending dns get "$KOINOTE_DOMAIN"`。Email Sending 会把退信 MX 与
SPF 放在 `cf-bounce.<域名>`，DKIM 放在 `cf-bounce._domainkey.<域名>`；根域没有 MX
只表示不在根域收信，不能据此判断发信未开通。

图片走 CDN（可选，省 Worker 请求数）见[设计文档](docs/DESIGN.zh.md#图片走-cdn)。

### 自动部署

`.github/workflows/deploy.yml`：push 到 `main` 且 CI 全绿后先部署并验活后端，再部署
Worker 与 SPA、确认首份数据库异地备份成功，最后验活站点 `/api/images/config`。

需要这几个仓库 secret：

| secret                         | 用途                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`         | 部署需 Workers Scripts / R2 / Routes 编辑权限；若也用它 onboard 发信域，再加 Email Sending 编辑权限 |
| `CLOUDFLARE_ACCOUNT_ID`        | `wrangler whoami` 能看到                                                                            |
| `CLOUDFLARE_ZONE_ID`           | 图片 CDN 所在 Zone，用于删除后的缓存清理                                                            |
| `CLOUDFLARE_CACHE_PURGE_TOKEN` | 仅授予 Zone / Cache Purge 权限                                                                      |
| `CLOUDFLARE_ANALYTICS_TOKEN`   | 可选；仅授予目标 Zone 的 Analytics Read，供 Admin 今日 UV / PV 使用                                 |
| `EMAIL_VERIFICATION_SECRET`    | 验证码 HMAC 独立密钥，部署时安全写入 VPS `.env`                                                     |
| `MCP_TOKEN_ENCRYPTION_KEY`     | MCP 访问令牌加密密钥；必须长期保留，轮换后旧令牌无法再次查看                                        |
| `LLM_CREDENTIAL_ENCRYPTION_KEY` | BYOK API Key 独立加密密钥；生产必填，轮换前必须迁移既有密文                                       |
| `WECHAT_CREDENTIAL_ENCRYPTION_KEY` | 微信公众号 AppSecret 独立加密密钥；生产必填，轮换前必须迁移既有密文                              |
| `ZHIHU_CREDENTIAL_ENCRYPTION_KEY` | 知乎 OpenAPI AppSecret 独立加密密钥；生产必填，轮换前必须迁移既有密文                         |
| `X_CREDENTIAL_ENCRYPTION_KEY`     | X API 凭证独立加密密钥；生产必填，轮换前必须迁移既有密文                                      |
| `X_OAUTH2_CLIENT_ID`              | X Developer Portal OAuth 2.0 Client ID；与 Secret 同时配置                                     |
| `X_OAUTH2_CLIENT_SECRET`          | X Developer Portal OAuth 2.0 Client Secret；回调地址为 `{APP_URL}/api/x/oauth2/callback`       |
| `STRIPE_SECRET_KEY`            | Stripe 服务端密钥；先用 `sk_test_...`，正式收款前换 live mode                                       |
| `STRIPE_WEBHOOK_SECRET`        | `/api/billing/webhook` endpoint 的签名密钥（`whsec_...`）                                           |
| `STRIPE_LIFETIME_PRODUCT_ID`   | 终生会员 Product ID（`prod_...`），价格由后端白名单生成                                             |
| `STRIPE_CREDITS_PRODUCT_ID`    | Credits 充值 Product ID（`prod_...`），三档 USD 价格由后端白名单生成                              |
| `AGENT_LLM_API_KEY`            | 可选；平台 AI 优化内置模型密钥，须与三个 `AGENT_LLM_*` Actions Variables 同时配置                    |
| `WECHAT_COVER_IMAGE_API_KEY`   | 可选；公众号 AI 封面模型密钥，须与 Base URL、模型两个 Actions Variables 同时配置                     |
| `WECHAT_API_PROXY_URL`         | 可选 Actions Variable；生产微信 API 中转地址，配置后部署会写入 VPS `.env`，未配置时保留服务器已有值 |
| `BOT_WEBHOOK`                  | 可选；飞书群机器人 webhook，与 Kimiseek 复用同名配置                                                |
| `BOT_WEBHOOK_SECRET`           | 可选；飞书群机器人签名密钥，必须与 `BOT_WEBHOOK` 成对配置                                           |
| `VPS_HOST`                     | 后端服务器地址                                                                                      |
| `VPS_SSH_KEY`                  | 部署专用私钥（建议单独生成一把，不要复用个人密钥）                                                  |
| `VPS_HOST_KEY`                 | 服务器的 known_hosts 条目，用于固定 host key                                                        |

首次配置或轮换验证码密钥时，在仓库目录执行：

```bash
openssl rand -base64 48 | tr -d '\n' | gh secret set EMAIL_VERIFICATION_SECRET
gh secret list --app actions | grep '^EMAIL_VERIFICATION_SECRET'
openssl rand -base64 48 | tr -d '\n' | gh secret set MCP_TOKEN_ENCRYPTION_KEY
openssl rand -base64 48 | tr -d '\n' | gh secret set LLM_CREDENTIAL_ENCRYPTION_KEY
openssl rand -base64 48 | tr -d '\n' | gh secret set WECHAT_CREDENTIAL_ENCRYPTION_KEY
openssl rand -base64 48 | tr -d '\n' | gh secret set ZHIHU_CREDENTIAL_ENCRYPTION_KEY
```

Stripe 密钥可用 `gh secret set STRIPE_SECRET_KEY`、`gh secret set STRIPE_WEBHOOK_SECRET`
和 `gh secret set STRIPE_LIFETIME_PRODUCT_ID` 交互式写入，避免密钥进入 shell 历史；Credits 的
公开 Product ID 放在 Actions Variable `STRIPE_CREDITS_PRODUCT_ID`。AI 优化内置模型的 API Key
放 Secret，其余协议、Base URL、模型放同名 Actions Variables；整组未设置时部署保留 VPS 已有值。
公众号封面模型同理：API Key 放 `WECHAT_COVER_IMAGE_API_KEY` Secret，Base URL 与模型分别放
`WECHAT_COVER_IMAGE_BASE_URL`、`WECHAT_COVER_IMAGE_MODEL` Actions Variables；整组未设置时
部署保留 VPS 已有配置。生产微信中转地址放 `WECHAT_API_PROXY_URL` Actions Variable；未设置时同样
保留 VPS `.env` 里的既有值。
飞书通知同理使用 `gh secret set BOT_WEBHOOK` 和 `gh secret set BOT_WEBHOOK_SECRET`；两项
都未设置时，部署会保留 VPS `.env` 里已有的飞书配置。

第二条命令只显示 secret 名称和更新时间，不会读取密钥值。部署 workflow 会在开始部署前
检查所有必填 secrets；检查通过后，它会在重启后端之前通过 stdin 和临时文件原子更新
VPS 的 `/opt/koinote/.env`。可选的 Analytics Token 配置后也会以同样方式写入；因此不需要手动把验证码、MCP 令牌加密或 Stripe 密钥写进生产 `.env`，
但首次部署必须先在 GitHub 配好这些 repository secrets。

## 测试

```bash
npm test          # 两端 typecheck + 全部前端/Worker 断言套件
npm run go:test   # go vet + go test；未设 TEST_DATABASE_URL 时数据库集成测试会跳过
```

GitHub Actions 在每次 push 与 PR 上额外构建前后端，并用真实 PostgreSQL 执行
`go test -race` 与 SQL PREPARE 校验；另有一个 job 检查密钥卫生。

前端导出与分享另有 Playwright 端到端脚本，见[设计文档](docs/DESIGN.zh.md#验证)。

## 文档

- [更新日志](CHANGELOG.zh.md) —— 每个版本新增、变更、修复与安全更新
- [产品路线图](docs/ROADMAP.zh.md) —— 近期优先级、后续方向与产品原则
- [设计文档](docs/DESIGN.zh.md) —— 为什么这么实现、踩过哪些坑、哪些是有意的降级
- [Product Roadmap (English)](docs/ROADMAP.en.md)
- [Design Notes (English)](docs/DESIGN.en.md)

## 许可证

[MIT](LICENSE)
