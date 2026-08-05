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

## 构建与部署

```bash
npm run build     # vite build → spa/dist
npm run deploy    # 构建并 wrangler deploy（需先配 wrangler 与 secrets）
```

后端：`cd backend && docker build -t koinote-backend .`，部署到 VPS，
Worker 的 `BACKEND_URL` secret 指向后端公网地址。
