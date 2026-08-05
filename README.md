# Koinote

Typora 式所见即所得的在线 Markdown 编辑器，集成图床与 AI（规划中），采用订阅制。

## 架构

```
浏览器 ──▶ Cloudflare Worker (worker/index.ts)
              ├─ 托管 Vite 打的 SPA 静态资源 (spa/dist)
              └─ /api/*、/health ──▶ 反向代理到 Go 后端
                                          │
                                    ┌─────▼──────────────────────┐
                                    │ docker-compose:            │
                                    │  Go 后端 + Postgres + Redis │
                                    └────────────────────────────┘
```

- **前端**：Vite + React 19 + TypeScript + TanStack Router + react-query + Tailwind v4
- **编辑器内核**：TipTap v3（ProseMirror 系）+ tiptap-markdown（Markdown 往返保真）
- **后端**：Go（stdlib net/http）+ pgx，无状态 HMAC-SHA256 会话 cookie
- **数据库**：PostgreSQL 16；缓存 Redis 7（MVP 占位，登录闭环暂不使用）
- **部署**：Cloudflare Worker（前端）+ VPS/docker-compose（后端）

## 目录结构

```
spa/          前端 SPA 源码（Vite root）
  src/
    pages/          主页 / 登录 / Dashboard / 编辑器页
    components/     AppShell、editor（TipTap）
    api.ts          后端 API 封装（credentials: include）
    auth.ts         会话状态 hook（react-query）
worker/       Cloudflare Worker（API 代理 + SPA 托管）
backend/      Go 后端
  cmd/server/       入口
  internal/         config / db / migrations / server(auth,session) / model
  migrations/       SQL 迁移
docker-compose.yml  postgres + redis + backend
```

## 本地开发

需要三样：Node 20+、Go 1.23+、Docker。

### 1. 起数据库

```bash
cp .env.example .env
docker compose up -d postgres redis
```

> ⚠️ **端口冲突提醒**：若本机已跑着原生 PostgreSQL 占用 5432，容器会连不上。
> 在 `.env` 里改 `POSTGRES_PORT=5433`（或其他空闲端口），并同步把
> `DATABASE_URL` 的端口改成一致，再启动。

### 2. 起后端（自动跑迁移）

```bash
npm run backend:dev
# 或：cd backend && go run ./cmd/server
```

后端启动时自动加载 `.env`（依次找 `./.env`、`../.env`、`../../.env`，所以在仓库根或
`backend/` 下跑都能读到），监听 `:8080`，并自动执行 `migrations/*.sql`。

真实环境变量优先级高于 `.env` 文件，因此 docker-compose 注入的值不会被文件里的旧值覆盖。
容器镜像里没有 `.env`，全靠 compose 注入，找不到文件不影响启动。

### 3. 起前端

```bash
npm run dev
```

Vite 在 `:5173`，`/api/*` 与 `/health` 自动代理到后端 `:8080`。
打开 http://localhost:5173 即可。

### 全容器一键起

```bash
npm run docker:up   # postgres + redis + backend 全部进容器
```

## 认证

- 注册 / 登录 / 登出 / 会话查询：`POST /api/auth/{register,login,logout}`、`GET /api/auth/session`
- 第三方登录：`GET /api/auth/oauth/{google,github}/{start,callback}`
- 会话是无状态 HMAC-SHA256 签名的 `ka_session` cookie（HttpOnly / SameSite=Lax / 生产 Secure），**不落库**
- 密码 bcrypt（cost 10）哈希；登录支持用户名或邮箱，大小写不敏感
- MVP 简化：注册即 `is_verified=true` 可直接登录；邮箱验证 / 支付留待后续阶段

### 会话密钥（SESSION_SECRET）

`ka_session` 的 HMAC 签名密钥，取值优先级：
`SESSION_SECRET` → `BACKEND_INTERNAL_TOKEN` → 开发默认值。

生成一个高强度值放进 `.env`：

```bash
openssl rand -base64 48
```

- 生产环境**必须**显式设置，否则启动直接失败；开发环境缺省只打警告。
- 不要和 `BACKEND_INTERNAL_TOKEN` 共用同一个值，否则一处泄露等于两处失守。
- **换密钥会让所有已签发的会话立即失效**，用户需重新登录。

### 第三方登录配置

Google / GitHub 的完整流程已实现，只需填凭证（未配置时 start 端点返回 501）：

```bash
GOOGLE_CLIENT_ID= / GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID= / GITHUB_CLIENT_SECRET=
```

回调地址由 `APP_URL` 拼出，需在平台后台登记：

- Google → `{APP_URL}/api/auth/oauth/google/callback`
- GitHub → `{APP_URL}/api/auth/oauth/github/callback`

`state` 用签名 cookie + nonce 双校验，回跳路径经 `sanitizeRedirectPath` 过滤，只允许站内相对路径。
同邮箱的既有账号（如密码注册用户）在 OAuth 登录时会自动合并，不会重复建号。

## 代码高亮与 LaTeX

**代码高亮**：lowlight（highlight.js）的 common 集，约 37 种主流语言。
打三个反引号加语言名即可，如 ```` ```go ````。配色见 `globals.css` 的 GitHub Dark 精简版。

**LaTeX**：KaTeX 渲染，用 CommonMark 通行的分隔符。

- 行内：`$E = mc^2$`
- 块级：`$$…$$`（同行或跨行皆可）
- 点击公式可回到源码编辑
- 语法错误时回落成红色等宽文本并标记，不静默失败

两处需要留意的实现细节：

1. **分隔符是覆盖过的。** `@tiptap/extension-mathematics` 的输入规则用非标准写法
   （行内 `$$…$$`、块级 `$$$…$$$`），但它的序列化输出却是标准 `$…$` / `$$…$$` ——
   打字与存盘两头对不上。这里覆盖了输入规则，统一到标准写法。
2. **Markdown 往返靠自建的 markdown-it 插件**（`spa/src/components/editor/markdownMath.ts`）。
   `tiptap-markdown` 不认识数学语法，扩展自带的 tokenizer 是给 TipTap 官方
   markdown 包用的，这里用不上。插件里加了防误判规则：`$` 首尾不得为空白、
   收尾 `$` 紧跟数字时按货币处理，否则「价格是 $100 和 $200」会被吞成一个公式。

KaTeX 字体由 `vite.config.ts` 的 `copyKatexFonts` 插件在构建时从 `node_modules`
复制到 `assets/fonts/`。不这么做的话 CSS 里的相对路径会全部 404，
公式退化成后备字体——"能显示但不对"，很难察觉。

## 图床（Cloudflare R2）

图片上传由 **Worker 直接落 R2**，不经过 Go 后端——字节走边缘，不占 VPS 带宽。
鉴权仍回调后端：Worker 带着原始 cookie 打一次 `/api/auth/session` 拿身份。

- `POST /api/images` —— 上传，请求体是**原始字节**（不是 multipart），
  `Content-Type` 必须与真实文件头一致
- `GET /images/<key>` —— 未配自定义域名时的回落读取路径
- 编辑器里粘贴或拖入图片即自动上传，插入返回的 URL

安全约束（都在 Worker 侧强制）：

- 按 **magic byte 嗅探真实类型**，不信客户端声明的 `Content-Type`；声明与实际不符一律拒绝
- **SVG 一律拒收**。SVG 能内嵌脚本，配上公开 bucket 就是储存型 XSS；
  净化 SVG 是场跟绕过赛跑的长期战斗，不如不收
- 上限 10 MiB，`Content-Length` 与实际字节数各挡一道
- key 形如 `u/<authUserId>/<32位随机>.png`，随机且永不复用
- 读取响应带 `X-Content-Type-Options: nosniff`

### ⚠ 本地开发测不到上传

`npm run dev` 是 Vite 直连 Go 后端，**Worker 不在链路里**，
所以 `/api/images` 会 404——跟前端代码对不对无关。

测上传要起 wrangler（自带本地 R2 模拟，不碰线上数据）：

```bash
npx wrangler dev --port 8788 --var BACKEND_URL:http://localhost:8090
```

本地对象存在 `.wrangler/state/v3/r2`（已在 `.gitignore` 中）。

### 生产配置

```bash
wrangler secret put BACKEND_URL          # 指向 Go 后端公网地址
# R2 绑定已写在 wrangler.jsonc，无需 secret
```

`IMAGE_PUBLIC_BASE` 留空时图片经 Worker 代理读取，每次加载消耗一次 Worker 请求。
在 Cloudflare 后台给 bucket 绑定自定义域名后填上它（如 `https://img.你的域名`），
图片改走 CDN，不再计入 Worker 请求数。

## 构建与部署

```bash
npm run build     # vite build → spa/dist
npm run deploy    # 构建并 wrangler deploy（需先配 wrangler 与 secrets）
```

后端：`cd backend && docker build -t koinote-backend .`，部署到 VPS，
Worker 的 `BACKEND_URL` secret 指向后端公网地址。
