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

[English](README.en.md) · [更新日志](CHANGELOG.md) · [设计文档](docs/DESIGN.zh.md) · [MIT License](LICENSE)

[![CI](https://github.com/moutsea/koinote/actions/workflows/ci.yml/badge.svg)](https://github.com/moutsea/koinote/actions/workflows/ci.yml)

</div>

---

## 这是什么

一个 Typora 式的在线 Markdown 编辑器：不分左右分栏，写下的语法立刻变成排版后的样子。

和本地编辑器的区别在于三件事：**图片粘贴即上传**（自己的 R2 图床，正文里是干净的
链接而不是一坨 base64）、**导出到微信公众号**（15 套排版主题，样式内联成公众号
编辑器认得的形式）、**文档在云端**（多设备、可分享）。

> 当前开源版聚焦编辑、图床、导出、分享与账号闭环；AI 功能尚在规划中，终生会员
> 已通过 Stripe Checkout 支持一次性付款。

## 功能

**编辑**

- 所见即所得，无分栏预览。标题、列表、引用、表格、任务列表、代码块
- 代码高亮 37 种语言（highlight.js common 集）
- LaTeX 公式，行内 `$…$` 与块级 `$$…$$`，点击可回到源码
- 多标签同时开多篇、大纲导航、文件夹树、拖拽移动
- 自动保存（防抖），失败会明确告知而不是静默丢内容

**图床**

- 粘贴或拖入即上传到 Cloudflare R2
- 从网页粘贴的外链图片自动转存，避免对方删图后裂图
- 按 magic byte 校验真实类型，拒收 SVG（能内嵌脚本）
- 每用户配额（免费用户默认 500 MB，终生会员 10 GB，邀请奖励最多叠加 5 GB；均包含正文与图片）
- 网页显示自有图片时走同源 `/images/...`，导出保留 CDN 地址，避开浏览器
  CORS / Local Network Access 误拦截
- 文档删图后异步回收不再引用的 R2 对象；删除前会复查引用，CDN 模式同时清缓存

**导出**

| 格式 | 说明 |
|---|---|
| Markdown | 原样导出 |
| HTML | 单 HTML 文件，正文样式内嵌；KaTeX CSS 与图片仍使用外部地址 |
| DOCX | 走文档树构建，公式保留 LaTeX 源码 |
| PDF | 一键下载（栅格化） |
| 打印 / 另存为 PDF | 文字矢量可选可搜 |
| **微信公众号** | 15 套主题，样式内联进剪贴板，直接粘贴 |

微信这条做了不少细活：代码高亮在导出时重新生成（编辑器里的高亮是视图装饰，
不在文档里）、缩进用不换行空格 + `<br>` 承载（微信会剥掉 `white-space`）、
代码块带 Mac 窗口三点、公式栅格化成图片上传。

**分享**

- 两档权限：知道链接即可访问 / 需要口令
- 放宽权限时强制换 token，老链接立刻失效
- 口令 bcrypt 存哈希，两层限流防爆破

**其他**

- 界面四语：中文 / English / 日本語 / Français
- 深浅色主题，水墨风格视觉
- 邮箱验证码注册与密码登录 + Google / GitHub OAuth
- 邀请奖励：专属链接自动带入邀请码，新用户注册成功后双方各得 500 MB，每个账号累计最多 5 GB
- Stripe 多币种一次性付款终生会员：支持 USD / CNY / EUR / JPY，以及银行卡、支付宝和微信支付
- 管理员后台：用户与会员规模、按币种收入、订单、全站存储、30 天趋势、最近用户与付款
- 可选接入 Cloudflare Analytics，在管理后台查看当天边缘 UV / PV、请求数和流量

## 技术栈

```
浏览器 ──▶ Cloudflare Worker ──┬─ 托管 SPA 静态资源
                               ├─ /api/images/* 与 /images/* ──▶ R2
                               ├─ /api/internal/email/* ──▶ Email Sending
                               └─ 其余 /api/* ──▶ Go 后端 ──▶ PostgreSQL
Go 后端 ──内部回调────────────▶ Worker（验证码邮件 / R2 回收）
浏览器 ──Stripe Checkout──────▶ Stripe ──签名 Webhook──▶ Go 后端
```

- **前端** Vite · React 19 · TypeScript · TanStack Router · Tailwind v4
- **编辑器** TipTap v3（ProseMirror）· tiptap-markdown · KaTeX · lowlight
- **后端** Go（stdlib `net/http`）· pgx · Stripe Go SDK · PostgreSQL 16
- **边缘** Cloudflare Worker · R2 · Email Sending

会话是无状态的 HMAC-SHA256 签名 cookie，不落库。

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

将 endpoint 的 signing secret 配为 `STRIPE_WEBHOOK_SECRET`。站点使用固定 Product ID
和服务端价格白名单创建 Checkout，用户可选择 USD 3.99、CNY 29、EUR 3.99 或 JPY 600；
发放权益前会重新校验付款状态、所选币种对应金额、Product ID 和用户归属。成功页确认与 webhook
共用同一个数据库幂等事务。

Checkout 不在代码里固定支付方式，而是读取 Stripe Dashboard 的 Payment methods 配置，
再按账号地区、用户位置和所选币种展示可用选项。要显示支付宝和微信支付，需在 Stripe
Dashboard 中启用 Alipay 与 WeChat Pay；不满足 Stripe 资格或币种规则时仍可能只显示银行卡。

共享 Stripe 账号时，Koinote 创建的 Checkout Session 与 PaymentIntent 都带
`metadata.service=koinote`。Webhook 对其他服务的事件直接返回 200 忽略，并在真正发放会员前
再次校验该字段、Product、金额、币种和用户归属。

检查是否开通请用 `npx wrangler email sending list` 和
`npx wrangler email sending dns get "$KOINOTE_DOMAIN"`。Email Sending 会把退信 MX 与
SPF 放在 `cf-bounce.<域名>`，DKIM 放在 `cf-bounce._domainkey.<域名>`；根域没有 MX
只表示不在根域收信，不能据此判断发信未开通。

图片走 CDN（可选，省 Worker 请求数）见[设计文档](docs/DESIGN.zh.md#图片走-cdn)。

### 自动部署

`.github/workflows/deploy.yml`：push 到 `main` 且 CI 全绿后先部署并验活后端，再部署
Worker 与 SPA，最后验活站点 `/api/images/config`。

需要这几个仓库 secret：

| secret | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 部署需 Workers Scripts / R2 / Routes 编辑权限；若也用它 onboard 发信域，再加 Email Sending 编辑权限 |
| `CLOUDFLARE_ACCOUNT_ID` | `wrangler whoami` 能看到 |
| `CLOUDFLARE_ZONE_ID` | 图片 CDN 所在 Zone，用于删除后的缓存清理 |
| `CLOUDFLARE_CACHE_PURGE_TOKEN` | 仅授予 Zone / Cache Purge 权限 |
| `CLOUDFLARE_ANALYTICS_TOKEN` | 可选；仅授予目标 Zone 的 Analytics Read，供 Admin 今日 UV / PV 使用 |
| `EMAIL_VERIFICATION_SECRET` | 验证码 HMAC 独立密钥，部署时安全写入 VPS `.env` |
| `STRIPE_SECRET_KEY` | Stripe 服务端密钥；先用 `sk_test_...`，正式收款前换 live mode |
| `STRIPE_WEBHOOK_SECRET` | `/api/billing/webhook` endpoint 的签名密钥（`whsec_...`） |
| `STRIPE_LIFETIME_PRODUCT_ID` | 终生会员 Product ID（`prod_...`），价格由后端白名单生成 |
| `VPS_HOST` | 后端服务器地址 |
| `VPS_SSH_KEY` | 部署专用私钥（建议单独生成一把，不要复用个人密钥） |
| `VPS_HOST_KEY` | 服务器的 known_hosts 条目，用于固定 host key |

首次配置或轮换验证码密钥时，在仓库目录执行：

```bash
openssl rand -base64 48 | tr -d '\n' | gh secret set EMAIL_VERIFICATION_SECRET
gh secret list --app actions | grep '^EMAIL_VERIFICATION_SECRET'
```

Stripe 三项可用 `gh secret set STRIPE_SECRET_KEY`、`gh secret set STRIPE_WEBHOOK_SECRET`
和 `gh secret set STRIPE_LIFETIME_PRODUCT_ID` 交互式写入，避免密钥进入 shell 历史。

第二条命令只显示 secret 名称和更新时间，不会读取密钥值。部署 workflow 会在开始部署前
检查所有必填 secrets；检查通过后，它会在重启后端之前通过 stdin 和临时文件原子更新
VPS 的 `/opt/koinote/.env`。可选的 Analytics Token 配置后也会以同样方式写入；因此不需要手动把验证码或 Stripe 密钥写进生产 `.env`，
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

- [更新日志](CHANGELOG.md) —— 每个版本新增、变更、修复与安全更新
- [设计文档](docs/DESIGN.zh.md) —— 为什么这么实现、踩过哪些坑、哪些是有意的降级
- [Design Notes (English)](docs/DESIGN.en.md)

## 许可证

[MIT](LICENSE)
