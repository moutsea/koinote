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

[English](README.en.md) · [设计文档](docs/DESIGN.zh.md) · [MIT License](LICENSE)

[![CI](https://github.com/moutsea/koinote/actions/workflows/ci.yml/badge.svg)](https://github.com/moutsea/koinote/actions/workflows/ci.yml)

</div>

---

## 这是什么

一个 Typora 式的在线 Markdown 编辑器：不分左右分栏，写下的语法立刻变成排版后的样子。

和本地编辑器的区别在于三件事：**图片粘贴即上传**（自己的 R2 图床，正文里是干净的
链接而不是一坨 base64）、**导出到微信公众号**（15 套排版主题，样式内联成公众号
编辑器认得的形式）、**文档在云端**（多设备、可分享）。

> 这是第一个开源版本。核心编辑、图床、导出、分享都能用；AI 辅助与订阅计费尚未落地。

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
- 每用户配额（默认 500 MB，含正文与图片）

**导出**

| 格式 | 说明 |
|---|---|
| Markdown | 原样导出 |
| HTML | 自包含单文件，样式内联 |
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
- 邮箱密码 + Google / GitHub 登录

## 技术栈

```
浏览器 ──▶ Cloudflare Worker ──┬─ 托管 SPA 静态资源
                               └─ /api/* 反向代理 ──▶ Go 后端 + Postgres
                                  图片直接落 R2
```

- **前端** Vite · React 19 · TypeScript · TanStack Router · Tailwind v4
- **编辑器** TipTap v3（ProseMirror）· tiptap-markdown · KaTeX · lowlight
- **后端** Go（stdlib `net/http`）· pgx · PostgreSQL 16
- **边缘** Cloudflare Worker · R2

会话是无状态的 HMAC-SHA256 签名 cookie，不落库。

## 快速开始

需要 Node 20+、Go 1.23+、Docker。

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
带上 `Secure` 而存不住）。

然后：

```bash
npm install
docker compose up -d postgres redis   # 起数据库
npm run backend:dev                   # 起后端（自动跑迁移）
npm run dev                           # 起前端 → http://localhost:5273
```

图片上传要额外起 wrangler（R2 绑定只在 Worker 侧，自带本地模拟）：

```bash
npx wrangler dev --port 8788 --var BACKEND_URL:http://localhost:8090
```

> `.dev.vars` 里的 `BACKEND_INTERNAL_TOKEN` 要和 `.env` 填同一个值。

详细步骤、端口冲突、全容器启动见[设计文档](docs/DESIGN.zh.md#本地开发)。

## 自建须知

这几条会直接影响安全，部署前值得看一眼：

**`SESSION_SECRET` 必填，没有回退。** 留空后端拒绝启动 —— 这是故意的。
它曾经会回退到一个硬编码常量，而那在开源仓库里等于公开签名密钥。

**`BACKEND_INTERNAL_TOKEN` 自己生成，别用任何示例值。** 这个头能让持有者伪造成
任意用户（后端见到它就信 `X-Auth-User-Id`，不再校验会话），等同于全站管理员凭据。
`.env.example` 里刻意留空。

**`NODE_ENV` 决定 cookie 的 `Secure` 标志。** 生产必须是 `production`。

**图片是「知道 URL 即可读」的。** key 随机不可枚举，但没有鉴权 —— 私有文档里的
图片，链接泄漏后任何人都能看。这是图床的常规做法，但用户通常会假设「私有文档里的
图也是私有的」。你的场景不能接受的话，得改成签名 URL。

**限流是进程内的。** 多实例部署时各进程独立计数，实际阈值被放大 N 倍。
上多实例前要换成 Redis。

**改了后端代码要重新构建镜像。** `docker compose up -d` 不重新构建，
要用 `docker compose up -d --build backend` —— 否则代码改了行为没变，且没有任何报错。

## 部署

```bash
npm run build     # → spa/dist
npm run deploy    # wrangler deploy（需先配好 secrets）
```

后端 `cd backend && docker build -t koinote-backend .`，部署到 VPS，
Worker 的 `BACKEND_URL` secret 指向它的公网地址。

生产要设的 secret：

```bash
wrangler secret put BACKEND_URL
wrangler secret put BACKEND_INTERNAL_TOKEN   # 与后端同值
```

图片走 CDN（可选，省 Worker 请求数）见[设计文档](docs/DESIGN.zh.md#图片走-cdn)。

### 自动部署

`.github/workflows/deploy.yml`：push 到 `main` 且 CI 全绿后自动部署 Worker
与后端，部署完验活后端 `/health` 与站点 `/api/images/config`。

需要这几个仓库 secret：

| secret | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 权限：Workers Scripts 编辑、Workers R2 编辑、Workers Routes 编辑 |
| `CLOUDFLARE_ACCOUNT_ID` | `wrangler whoami` 能看到 |
| `VPS_HOST` | 后端服务器地址 |
| `VPS_SSH_KEY` | 部署专用私钥（建议单独生成一把，不要复用个人密钥） |
| `VPS_HOST_KEY` | 服务器的 known_hosts 条目，用于固定 host key |

## 测试

```bash
npm test          # 两端 typecheck + 25 个断言套件
npm run go:test   # go vet + go test
```

GitHub Actions 在每次 push 与 PR 上跑这两条，另有一个 job 检查密钥卫生。

前端导出与分享另有 Playwright 端到端脚本，见[设计文档](docs/DESIGN.zh.md#验证)。

## 文档

- [设计文档](docs/DESIGN.zh.md) —— 为什么这么实现、踩过哪些坑、哪些是有意的降级
- [Design Notes (English)](docs/DESIGN.en.md)

## 许可证

[MIT](LICENSE)
