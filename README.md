<div align="center">

<!-- logo.png 是几乎纯黑的墨（平均亮度 3/255），在 GitHub 深色主题下会整个消失。
     用 <picture> 按主题切换：GitHub 支持 prefers-color-scheme 媒体查询。 -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/logo-dark.png">
  <img src="public/logo.png" alt="Koinote" width="96" height="96">
</picture>

# Koinote 锦鲤笔记

**所见即所得的在线 Markdown 编辑器**

边写边渲染，图片直接进图床，一键导出与分享。

**[koinote.app](https://koinote.app)** —— 打开即用，不必自己部署

[English](README.en.md) · [在线更新日志](https://koinote.app/changelog) · [中文更新日志](CHANGELOG.zh.md) · [路线图](docs/ROADMAP.zh.md) · [设计文档](docs/DESIGN.zh.md) · [MIT License](LICENSE)

[![CI](https://github.com/moutsea/koinote/actions/workflows/ci.yml/badge.svg)](https://github.com/moutsea/koinote/actions/workflows/ci.yml)

</div>

---

## 这是什么

一个 Typora 式的在线 Markdown 编辑器：不分左右分栏，写下的语法立刻变成排版后的样子。

和本地编辑器的区别在于四件事：**图片粘贴即上传**（自己的 R2 图床，正文里是干净的
链接而不是一坨 base64）、**导出到自媒体**（微信公众号与知乎使用内联富文本，掘金使用
Markdown）、**文档在云端**（多设备、可分享），以及让 **Codex、Claude Code、OpenCode、
OpenClaw 等 Agent 通过 MCP 安全操作自己的文档**。

仓库还包含基于 Tauri 2 的 macOS / Windows 客户端 alpha：本地 SQLite 优先读写，恢复网络后
自动同步；登录在系统浏览器完成，通过 `koinote://auth` + PKCE 把短期访问令牌交回客户端。

桌面客户端可从 [Koinote 官网下载入口](https://koinote.app/download) 获取。该地址会跳转到
最新 GitHub Release，提供 macOS Apple 芯片、macOS Intel 和 Windows x64 安装包及 SHA-256
校验文件。Alpha 安装包目前尚未购买平台证书；macOS 包会做 ad-hoc 完整性签名，但没有
Apple Developer ID 与公证，首次运行时系统仍会显示安全提醒。请先右键应用选择“打开”，
或在“系统设置 → 隐私与安全性”中选择“仍要打开”；若系统仍提示应用“已损坏”，请先核对
Release 中的 SHA-256，再运行 `xattr -dr com.apple.quarantine /Applications/Koinote.app`。
从 `0.1.4` 起客户端会在启动后自动检查新版本，也可以在账户菜单中手动检查、下载并重启
安装；更新包使用独立的 Tauri 签名验证，不依赖付费平台证书。

> 当前开源版聚焦编辑、图床、导出、分享与账号闭环；AI 功能尚在规划中，终生会员
> 已通过 Stripe Checkout 支持一次性付款。

## 功能

**编辑**

- 所见即所得，无分栏预览。标题、列表、引用、表格、任务列表、代码块
- 代码高亮 37 种语言（highlight.js common 集）
- LaTeX 公式，行内 `$…$` 与块级 `$$…$$`，点击可回到源码
- 多标签同时开多篇、大纲导航、文件夹树、拖拽移动
- 移动端使用文档抽屉切换文章，桌面端保留可调宽度文件树
- 全局搜索标题与 Markdown 正文，`⌘K` / `Ctrl+K` 唤起并高亮命中位置
- 自动保存（防抖），失败会明确告知而不是静默丢内容
- revision 乐观锁检测网页与 Agent 的并发修改；冲突时保留本地草稿并提供合并界面
- 终生会员可查看和恢复文档历史，并设置是否启用、每篇保留 1–100 版，以及 MCP 写入是否保留完整历史（即使关闭，Agent 写入仍保留最近 1 个安全快照；账号总计最多 100 版）

**MCP 与会员**

- 首页与独立 `/docs/mcp` 指南展示 MCP 的客户端配置、授权、并发保护与版本恢复机制，支持 Codex、Claude Code、OpenCode、OpenClaw 等 Streamable HTTP MCP 客户端
- 独立 `/pricing` 页面公开对比免费版与终生会员权益，并从后端读取当前多币种 Stripe 价目表
- 免费版默认提供 500 MB 云端空间；终生会员一次付费获得 10 GB、MCP、版本历史和后续 AI 功能使用资格

**账号安全**

- 邮箱密码账号支持验证码找回与登录后修改密码
- 修改或重置密码会立即失效其他设备上的旧会话；也可单独执行“退出其他设备”
- 找回密码请求对未知邮箱和 OAuth-only 账号使用统一响应，验证码只保存 HMAC

**桌面客户端（alpha）**

- macOS 与 Windows 共用 React / TipTap 界面，Tauri 只承载原生窗口、SQLite、深链和系统钥匙串
- 文档、目录和标签页本地优先；离线可创建、编辑、搜索和整理，联网后后台推送与拉取
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

| 格式              | 说明                                                       |
| ----------------- | ---------------------------------------------------------- |
| Markdown          | 原样导出                                                   |
| HTML              | 单 HTML 文件，正文样式内嵌；KaTeX CSS 与图片仍使用外部地址 |
| DOCX              | 走文档树构建，公式保留 LaTeX 源码                          |
| PDF               | 一键下载（栅格化）                                         |
| 打印 / 另存为 PDF | 文字矢量可选可搜                                           |
| **自媒体平台**    | 微信公众号 / 知乎复制内联富文本；掘金复制原生 Markdown     |

「我的文档」还支持批量迁移：可导入单个 `.md`、带图片的文件夹或 ZIP，也可把全部
文档、文件夹结构和引用图片一次导出为可再次导入的 ZIP。

富文本导出做了不少细活：代码高亮在导出时重新生成（编辑器里的高亮是视图装饰，
不在文档里）、缩进用不换行空格 + `<br>` 承载（微信会剥掉 `white-space`）、
代码块带 Mac 窗口三点、公式栅格化成图片上传。

**分享**

- 两档权限：知道链接即可访问 / 需要口令
- 放宽权限时强制换 token，老链接立刻失效
- 口令 bcrypt 存哈希，两层限流防爆破
- 分享页动态生成网页标题与 OpenGraph 卡片，显示累计阅读次数，并允许登录用户“复制到我的 Koinote”
- 口令分享在解锁前不暴露标题、摘要或封面；阅读统计只保存累计数，不记录访客身份

**其他**

- 公开 `/changelog` 页面直接读取仓库的 `CHANGELOG.md`，按版本时间线展示新增、改进、安全与修复记录
- 界面四语：中文 / English / 日本語 / Français
- 深浅色主题，水墨风格视觉
- 邮箱验证码注册与密码登录 + Google / GitHub OAuth
- 邀请奖励：专属链接自动带入邀请码，新用户注册成功后双方各得 500 MB，每个账号累计最多 5 GB
- Stripe 多币种一次性付款终生会员：支持 USD / CNY / EUR / JPY，以及银行卡、支付宝和微信支付
- 支付首次落账后可向飞书群机器人发送收款通知，成功页与 webhook 不会重复通知
- 管理员后台：用户与会员规模、按币种收入、订单、全站存储、30 天趋势、产品转化漏斗、D1/D7/D30 留存、最近用户与付款
- 可选接入 Cloudflare Analytics，在管理后台查看当天边缘 UV / PV、请求数和流量
- 终生会员可通过 Streamable HTTP MCP 让 Codex、Claude Code 等 Agent 读写自己的文档

## 技术栈

```
浏览器 ──▶ Cloudflare Worker ──┬─ 托管 SPA 静态资源
                               ├─ /api/images/* 与 /images/* ──▶ R2
                               ├─ /api/internal/email/* ──▶ Email Sending
                               └─ 其余 /api/*、/mcp ──▶ Go 后端 ──▶ PostgreSQL
Go 后端 ──内部回调────────────▶ Worker（验证码邮件 / R2 回收）
浏览器 ──Stripe Checkout──────▶ Stripe ──签名 Webhook──▶ Go 后端 ──▶ 飞书机器人
桌面端 ──本地 SQLite──────────▶ 离线读写 ──联网同步 / Bearer token──▶ Worker / Go 后端
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
WorkBuddy 与通用客户端的配置及版本控制说明。Koinote
本身只负责鉴权、文档读写、版本控制与审计，**不会调用 LLM，也不需要 OpenAI、Anthropic
或其他模型 API Key**；理解指令和选择工具的是 Codex、Claude Code 等客户端自身。

PAT 支持只读或读写 scope、1–365 天或永久有效、创建后修改有效期和单独撤销。数据库用 SHA-256 摘要鉴权，另用
AES-GCM 加密保存可恢复副本；账号本人可按需再次查看，列表不会直接返回完整令牌。每次 MCP
请求都会重新检查会员状态、有效期与撤销状态。建议先创建只读令牌，需要写入时再单独创建
读写令牌。

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

只读工具包括分页列出文档、按标题与正文搜索、分段读取正文、查看历史版本和列出回收站；读写令牌额外获得
新建、追加、整篇更新、恢复版本、移入回收站与恢复文档。Agent 不能永久删除文档，永久删除只在
网页回收站提供标题确认；普通删除保留 30 天。整篇更新、追加、移入回收站和恢复都要求最新 revision；网页端使用同一套乐观锁并在冲突时提供
本地/远端合并界面。详细取舍见[设计文档](docs/DESIGN.zh.md#mcp-文档访问)。

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
`STRIPE_LIFETIME_PRODUCT_ID`。后端会按白名单为这个 Product 创建 USD 3.99、CNY 29、
EUR 3.99 或 JPY 600 的内联价格。成功回跳会主动确认并发放权益；要同时测试 webhook，
再安装 Stripe CLI 并运行：

```bash
stripe listen --forward-to localhost:8080/api/billing/webhook
```

把 CLI 输出的 `whsec_...` 填入 `STRIPE_WEBHOOK_SECRET` 后重启后端，支付可使用 Stripe
测试卡 `4242 4242 4242 4242`（任意未来日期与 CVC）。

详细步骤、端口冲突、全容器启动见[设计文档](docs/DESIGN.zh.md#本地开发)。

### 桌面客户端开发

额外安装 Rust stable；macOS 需要 Xcode Command Line Tools，Windows 需要 Microsoft C++
Build Tools 与 WebView2。先按上文启动本地 PostgreSQL、后端与 Vite，再运行：

```bash
npm run desktop:dev       # Tauri 开发窗口，系统浏览器回调 koinote://auth
npm run desktop:check     # Rust / Tauri 编译检查
npm run desktop:build     # 生成当前平台安装包
```

生产构建默认同步 `https://koinote.app`；本地开发默认同步 `http://localhost:5273`。桌面端
SQLite 不保存令牌，退出账号会清除该账号在本机的离线文档缓存。

官方 Release 使用 `TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
生成更新签名，并发布 `latest.json`。Fork 仓库发布自己的客户端前，必须生成新的 Tauri
签名密钥，把私钥写入同名 GitHub Secrets，并替换 `src-tauri/tauri.conf.json` 中的
`plugins.updater.pubkey` 与更新地址；不要复用 Koinote 官方公钥和 Release 地址。

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

**Stripe 生产配置必须完整。** `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、
`STRIPE_LIFETIME_PRODUCT_ID` 三项只要配置了一项，生产环境就要求全部齐全。支付成功后
本站数据库里的会员等级才是权益真值；前端返回值不会直接授予 10 GB 配额。

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
`WORKER_URL` 以及会话/OAuth 凭据。仓库里的
`koinote.app`、`api.koinote.app`、`img.koinote.app` 和 `verify@koinote.app` 是当前官方
部署值，自建时要同步替换 `wrangler.jsonc`、`deploy/Caddyfile` 与 OAuth 回调配置。

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
Worker 与 SPA，最后验活站点 `/api/images/config`。

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
| `STRIPE_SECRET_KEY`            | Stripe 服务端密钥；先用 `sk_test_...`，正式收款前换 live mode                                       |
| `STRIPE_WEBHOOK_SECRET`        | `/api/billing/webhook` endpoint 的签名密钥（`whsec_...`）                                           |
| `STRIPE_LIFETIME_PRODUCT_ID`   | 终生会员 Product ID（`prod_...`），价格由后端白名单生成                                             |
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
```

Stripe 三项可用 `gh secret set STRIPE_SECRET_KEY`、`gh secret set STRIPE_WEBHOOK_SECRET`
和 `gh secret set STRIPE_LIFETIME_PRODUCT_ID` 交互式写入，避免密钥进入 shell 历史。
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
