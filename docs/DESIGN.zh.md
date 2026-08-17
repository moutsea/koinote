# Koinote 设计文档

这份文档记录**为什么这么实现** —— 哪些取舍是有意的、踩过哪些坑、哪些降级是明知
代价后接受的。功能介绍与快速开始见 [README](../README.md)。

写下来的理由：这里绝大多数决定的错误版本都能跑，只是会在几个月后以很难查的方式
暴露 —— 比如一个静默丢内容的导出、一个把受害者一起锁住的限流、一个"配错了但看起来
正常"的 CDN。这些坑不记下来，下一个人（包括三个月后的我）会重新踩一遍。

> 中文是这份文档的原本。English: [DESIGN.en.md](DESIGN.en.md)

## 目录

- [架构](#架构)
- [本地开发](#本地开发)
- [认证与安全](#认证)
- [桌面客户端](#桌面客户端)
- [邀请奖励](#邀请奖励)
- [会员与支付](#会员与支付)
- [MCP 文档访问](#mcp-文档访问)
- [搜索、迁移与产品分析](#搜索迁移与产品分析)
- [管理后台](#管理后台)
- [分享](#分享)
- [导出](#导出)
- [代码高亮与 LaTeX](#代码高亮与-latex)
- [图床](#图床cloudflare-r2)
- [验证](#验证)

## 架构

```
浏览器 ──▶ Cloudflare Worker (worker/index.ts)
              ├─ 托管 Vite 打的 SPA 静态资源 (spa/dist)
              └─ /api/*、/health、/mcp ──▶ 反向代理到 Go 后端
                                          │
                                    ┌─────▼────────────────┐
                                    │ docker-compose:      │
                                    │  Go 后端 + Postgres  │
                                    └──────────────────────┘
桌面账号模式 ──本地 SQLite / 系统钥匙串──▶ Worker / Go 后端（Bearer token 同步）
桌面本地模式 ──密码加密的独立 SQLite 命名空间（不连接网络）
```

- **前端**：Vite + React 19 + TypeScript + TanStack Router + react-query + Tailwind v4
- **编辑器内核**：TipTap v3（ProseMirror 系）+ tiptap-markdown（Markdown 往返保真）
- **后端**：Go（stdlib net/http）+ pgx；浏览器用 HMAC-SHA256 cookie，桌面端用可撤销的不透明 token
- **数据库**：PostgreSQL 16
- **部署**：Cloudflare Worker（前端）+ VPS/docker-compose（后端）

## 目录结构

```
spa/          前端 SPA 源码（Vite root）
  src/
    pages/          主页 / 登录 / Dashboard / Admin / 编辑器页
    components/     AppShell、editor（TipTap）
    api.ts          后端 API 封装（credentials: include）
    auth.ts         会话状态 hook（react-query）
    desktop/        Tauri 运行时、PKCE、系统钥匙串请求与 SQLite 离线同步
src-tauri/    macOS / Windows 原生壳、权限、SQLite 迁移与应用图标
worker/       Cloudflare Worker（API 代理 + SPA 托管）
backend/      Go 后端
  cmd/server/       入口
  internal/         config / db / migrations / server(auth,session) / model
  migrations/       SQL 迁移
docker-compose.yml  postgres + backend
```

## 本地开发

需要三样：Node 20.19+（或 22.12+）、Go 1.23+、Docker Compose。

### 1. 起数据库

```bash
cp .env.example .env
docker compose up -d postgres
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

Vite 端口由 `.env` 的 `DEV_PORT` 控制（默认 5273），`/api/*` 与 `/health`
自动代理到后端，`/api/images` 与 `/images` 转给 wrangler（只有 Worker 有 R2 绑定）。

`strictPort` 是开的：端口被占时宁可启动失败，也不静默递增 —— 否则 OAuth
provider 按登记的端口回跳会打到空端口，报错还查不出来。

### 跑生产构建物

```bash
npm run build
npx vite preview        # 默认 :5274，代理配置与 dev 一致
```

`preview` 段的代理是必要的：没有它，`preview` 下所有 `/api` 请求都会落到 SPA 的
`index.html`，登录直接失败，于是生产构建只能靠部署来验证。

### 全容器一键起

```bash
npm run docker:up   # postgres + backend 全部进容器
```

> **改了后端代码要重新构建镜像。** `docker compose up -d` 只重启容器、不重新构建，
> 所以跑的还是旧代码。要用 `docker compose up -d --build backend`。
> 这个坑的表现是最难查的一类：代码是对的、行为是旧的、没有任何报错。

## 认证

- 邮箱注册：先 `POST /api/auth/verification-code` 发码，再把验证码交给
  `POST /api/auth/register`；存量未验证账号走 `POST /api/auth/verify-email`
- 登录 / 登出 / 会话查询：`POST /api/auth/{login,logout}`、`GET /api/auth/session`
- 密码安全：`POST /api/auth/password-reset-code`、`POST /api/auth/password-reset`、
  `POST /api/auth/password` 与 `POST /api/auth/sessions/invalidate`
- 第三方登录：`GET /api/auth/oauth/{google,github}/{start,callback}`
- 会话凭证是 HMAC-SHA256 签名的 `koinote_session` cookie（HttpOnly / SameSite=Lax / 生产 Secure），
  服务端只保存账户级 `session_version`，不保存逐条会话
- 密码 bcrypt（cost 10）哈希；登录支持用户名或邮箱，大小写不敏感
- 验证码只存 HMAC，10 分钟过期；消费验证码、建用户和删除验证码在同一事务中
- 找回密码使用独立表与 HMAC purpose，不能消费注册验证码；未知邮箱与 OAuth-only
  账号返回相同结果。重置或修改密码会递增 `session_version`，旧 Cookie 立即失效；
  修改密码后当前设备会收到新版本 Cookie，找回密码后则必须重新登录
- OAuth 账号由 provider 视为已验证；只有真正新建账号时才会处理邀请奖励

### 会话密钥 SESSION_SECRET

`koinote_session` 的 HMAC 签名密钥。**必填，没有任何回退** ——
留空后端直接拒绝启动，不分环境（本地也一样）。

```bash
openssl rand -base64 48
```

曾经有两级回退：`BACKEND_INTERNAL_TOKEN`，再兜底一个硬编码常量。两级都删了：

- 硬编码兜底在开源仓库里等于**公开签名密钥** —— 拿那个字符串就能签出任意用户的
  会话，不需要密码。原本有一道「生产环境必须配」的检查拦它，但那道检查挂在
  `NODE_ENV=production` 上，而当时的 `.env.example` 写的是 `development`，
  照文档走一遍就绕过去了。三个各自合理的决定凑成一个默认不安全的部署。
- 回退到 `BACKEND_INTERNAL_TOKEN` 也删了：那是 Worker → 后端的横向凭据，
  与会话签名是两种用途、两种轮换周期。混用意味着轮换内部令牌会把所有人踢下线，
  且任何能读到内部令牌的组件都顺带获得了伪造任意会话的能力。

**换密钥会让所有已签发的会话立即失效**，用户需重新登录。

Cookie 载荷包含账户当前的 `session_version`。部署 0021 前签发的 Cookie 没有该字段，
后端把缺失值兼容为初始版本 1；账户执行改密、找回或“退出其他设备”后版本递增，这些
旧 Cookie 与其他设备上仍未过期的 Cookie 会一起失效。这样无需维护会话表，也能提供
账户级撤销边界。

### 内部令牌 BACKEND_INTERNAL_TOKEN

Worker → 后端的横向鉴权。**必填，自己生成，别用任何示例值。**

```bash
openssl rand -base64 36 | tr '+/' '-_' | tr -d '='
```

这个头能让持有者**伪造成任意用户** —— 后端见到它就信 `X-Auth-User-Id` 给的身份，
不再校验会话（见 `authUserIDFromRequest`）。所以它等同于全站管理员凭据，
和 `SESSION_SECRET` 是两种用途，不要共用一个值。

`.env.example` 里刻意留空。之前给的示例值是 `koinote-internal-dev-token` ——
开源之后那就是一把公开的万能钥匙，而 README 第一步就是 `cp .env.example .env`，
照文档部署的人默认带着它上线。实测拿它加上任意已知 `authUserId` 直连后端，
能拿到那个用户的全部文档（HTTP 200）。留空不会产生这条越权路径，但图片记账、
图片回收和验证码发信这些 Worker ↔ 后端内部调用都会失效。

三处必须一致；不一致会让图片记账/回收失败，并让邮箱验证码发送返回 503：

| 位置                                                          | 用途                        |
| ------------------------------------------------------------- | --------------------------- |
| `.env`                                                        | 后端读，也给 docker-compose |
| `.dev.vars`                                                   | 本地 `wrangler dev`         |
| `wrangler secret put BACKEND_INTERNAL_TOKEN --env production` | 生产的 Worker               |

### 限流

| 端点         | 维度          | 阈值                               |
| ------------ | ------------- | ---------------------------------- |
| 登录         | IP            | 10 次 / 15 分钟                    |
| 登录         | 账号          | 100 次 / 15 分钟                   |
| 注册         | IP            | 5 次 / 小时                        |
| 验证码发送   | 邮箱          | 5 次 / 小时，且至少间隔 1 分钟     |
| 验证码发送   | IP            | 20 次 / 小时                       |
| 验证码校验   | 邮箱 / 验证码 | 最多失败 5 次                      |
| 找回密码发码 | 邮箱 / IP     | 5 / 20 次每小时，且至少间隔 1 分钟 |
| 找回密码校验 | 邮箱 / 验证码 | 最多失败 5 次                      |
| 分享口令校验 | IP            | 20 次 / 15 分钟                    |
| 分享口令校验 | 链接          | 10 次 / 15 分钟                    |

两处刻意的设计，都容易做反：

**账号维度的阈值远高于 IP 维度**（100 对 10）。任何人都能对着别人的账号发失败
请求，所以账号维度要是收得和 IP 一样紧，攻击者用 10 个请求就能把任意用户锁在门外
15 分钟 —— 那是自己造出来的拒绝服务，比它挡住的撞库更容易被利用。它只做兜底，
挡分布式撞库（很多 IP 各试几次，永远碰不到 IP 阈值）。

**限流排在参数校验之后**，只对「格式合法、真的在试一组凭证」的请求计数。放在最
前面的话，用户在注册页手滑五次（密码太短、邮箱漏了 `@`）就被锁一小时，而他一个号
都没注册成功。挡刷号的效果不受影响：批量注册必须发合法请求，而合法请求全都计数。

登录、注册与分享限流器是**进程内**的（`ratelimit.go`）；验证码发送次数同时落库，
可跨重启保留。多实例下进程内桶仍各自计数，实际阈值被放大 N 倍 —— 上多实例前要
接入共享限流存储。

### 安全响应头

由 Worker 在唯一出口统一加（`worker/securityHeaders.ts`）：CSP、HSTS、
`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy`、
`Cross-Origin-Opener-Policy`、`X-Content-Type-Options`。

包在入口而不是各分支里加：Worker 有多条返回路径，逐个加迟早漏一条，
而漏掉的那条不会有任何报错，只是那个端点静默地少了防护。

两处不能随手"收紧"的地方：

- `style-src` 必须保留 `'unsafe-inline'`。主题 CSS 是运行时注入的 `<style>`
  （主题随文档变，算不出 hash），KaTeX 渲染公式时给每个 span 写 `style` 属性。
  收紧的结果是公式不显示、主题失效 —— 那种"坏了"往往以整条删掉 CSP 收场，
  比不加更糟。`script-src` 则收到了 `'self'`，没有 `unsafe-inline`。
- HSTS 只在 https 下发。在 http 上发会把 `localhost` 钉成 https，
  开发机在浏览器里彻底打不开，且 `max-age` 期间清不掉。

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

## 桌面客户端

桌面端使用 Tauri 2，而不是 Electron。React / TipTap 界面继续复用网页代码，Rust 层只负责
浏览器做不到或不该做的能力：原生窗口、`koinote://` 深链、SQLite、系统钥匙串和单实例。
这样安装包和常驻内存更小，也不用维护第二套编辑器。

### 系统浏览器登录与 PKCE

桌面 WebView 不直接收密码，也不复制 Google / GitHub OAuth 回调。登录流程是：

1. 客户端生成 `state` 与 PKCE verifier，只把它们暂存在 macOS Keychain / Windows Credential Manager。
2. 系统浏览器打开 `/desktop/authorize`；用户沿用网页 cookie 登录并明确批准客户端访问。
3. 后端生成 5 分钟、单次有效的授权码，数据库只存 SHA-256 摘要与 code challenge。
4. 浏览器跳到 `koinote://auth?code=…&state=…`；客户端先比较 state，再用 verifier 换 token。
5. 访问令牌 15 分钟有效，刷新令牌 30 天有效且每次使用都轮换。数据库只存 token 摘要，
   原文只留在系统钥匙串；撤销、修改密码和“退出其他设备”都通过 `session_version` 立即生效。

Bearer token 通过后端显式 allowlist 只能访问桌面编辑、整理、分享、存储用量、会员 Checkout、
MCP 令牌管理，以及管理员读取统计所需的精确路径和方法；会员与管理员资格仍由对应端点二次校验。
密码、会话安全操作和永久删除文档继续禁止。

深链本身是不可信输入，所以 code、state、client ID 和 PKCE 字符集在前后端都会校验。Windows
收到深链时会启动第二个进程，single-instance 插件负责把 URL 转给已有窗口。

### 本地优先同步

SQLite 按账号保存文档、文件夹、标签页、待同步状态与冲突副本，但不保存任何令牌。新建文档和
文件夹先生成 UUID v4；后端允许已鉴权桌面客户端提交这个 ID，并把内容相同的重试视作幂等成功，
所以请求在服务端落库后丢失响应也不会复制出第二篇文档。

文档同步同时维护三个数字：`local_revision` 给已打开的编辑器做本机 CAS，`base_revision` 是
最后确认的服务端 revision，`change_seq` 用来拒绝过期网络响应。云端确认不能让本地 revision
回退；拉取响应写 SQLite 时必须仍匹配发请求前的 base、状态和 change sequence，否则说明用户
等待期间又输入了内容，该响应只能留给下一轮处理。正文两端都变化时保存本地与云端完整副本，
由用户选择；文件夹目前没有服务端 revision，因此冲突时保留本地待同步状态并在下一轮重放。

网页端在页面可见时每 30 秒刷新一次文档 revision 列表，并在窗口重新获得焦点时立即检查；只有
revision 变化才拉取完整正文。桌面端以相同节奏执行静默同步，应用远端内容前会先把编辑器防抖
窗口中的草稿写入 SQLite。干净文档自动采用远端版本，同时编辑则保留本地稿和云端稿并主动提示，
后台检查不会让“已同步”状态周期性闪成“正在同步”。

账号离线模式支持 Markdown 正文、目录、搜索、标签页和图片：离线粘贴的图片先以本地 URL
写入 SQLite，联网后上传图床并替换正文；已同步的站内图片按 LRU 缓存，默认上限 512 MiB。
版本历史、分享、支付和管理等功能仍需联网。退出登录会清除该账号的本机 SQLite 缓存，避免
共用电脑残留正文。登出前编辑器先把防抖窗口中的内容写入 SQLite；若仍有待同步修改或冲突，
必须由用户明确确认丢弃后才会清理，不能把离线正文静默删除。

### 完全本地模式不是账号离线模式

完全本地模式不创建会话，也不读取系统钥匙串中的账号令牌。首次进入必须设置至少 8 位密码；
客户端以 PBKDF2-SHA256（310,000 次）派生 512 位材料，一半作为 AES-GCM 密钥，另一半作为
密码校验值。SQLite 只保存随机 salt、迭代次数和校验值；密码从不落盘，AES 密钥只留在当前
进程内存，关闭或锁定客户端后必须重新输入。密码无法找回，这一点必须在设置前明确告知用户。

本地资料固定使用 `local:v1` 命名空间，与任何账号缓存隔离。标题、正文、主题、文件夹名称、
编辑器标签页和图片 base64 在写入 SQLite 前逐项 AES-GCM 加密；文档 ID、时间、字节数和状态等
索引元数据保持可查询。因此拿到数据库文件的人仍能推断文档数量、目录关系、修改时间和大致体积，
但不能直接读取标题、正文、文件夹名称和图片内容。本地搜索也必须先解密全部候选文档再在内存过滤，
这是内容加密换来的有意取舍；文档达到数千篇后，搜索成本会随文档数线性增加。
这个模式不只是“同步暂时失败”：桌面 HTTP 传输层会在加载原生网络插件
之前拒绝请求，更新检查和远端页面不会挂载，未缓存的远端图片也不会交给 WebView 自行下载。
因此编辑、搜索、回收站和本地导入导出可以使用，分享、会员、MCP、邀请、管理后台以及所有其他
依赖远端的功能均不可用。

从账号模式切到本地模式会先走正常登出保护，再锁定并切换命名空间；两边不会共享文档对象。
登录账号后，用户可再次输入本地密码，把当前文档、文件夹和正文引用的图片复制进账号命名空间。
导入会为所有对象生成新 UUID，并由 Rust 在同一个 SQLite 事务中整批写入：任一插入失败则全部
回滚。导入完成后这些副本走普通账号同步流程，源资料保持原样；以后任一侧的修改都不会反映到
另一侧，重复导入也会再创建一套独立副本。

CI 分别在 macOS 与 Windows 运行 Rust / Tauri 编译检查。更新包使用独立 Tauri 密钥签名；正式分发
仍需要 Apple Developer ID、公证和 Windows 代码签名证书，这些属于平台信誉基础设施，不影响本地 alpha。

## 邀请奖励

每个用户有一个 16 位专属邀请码，控制台把它组成 `/register?invite=CODE` 链接。邮箱注册
直接在请求体提交邀请码；OAuth 则把邀请码放进已有的 HMAC 签名 state cookie，第三方平台
只看到随机 nonce，无法读取或篡改邀请码。

奖励只在创建全新账号时生效：邀请人与被邀请人各增加 500 MiB 永久空间，但每个账号的
`bonus_storage_bytes` 累计最多 5 GiB：

- `users.invitation_code` 唯一且不可由用户修改
- `users.invited_by` 记录直接邀请关系
- `users.bonus_storage_bytes` 保存累计永久奖励，数据库约束与应用读取层都强制 5 GiB 上限
- `invitations.invited_user_id` 唯一，是同一个新账号不能重复发奖的数据库边界

创建新用户、写邀请账本、给双方增加空间在同一个 PostgreSQL 事务中完成。邀请码无效时整笔
注册回滚，邮箱验证码不会被消费；任一步失败也不会出现一方拿到空间、另一方没拿到的半状态。
并发邀请会锁定邀请人行，最后一笔只发剩余额度；达到上限后的邀请仍记录关系，实际奖励记为 0。
既有账号再次走 OAuth 登录时忽略 URL 中的邀请码，不能在注册后补领。`GET /api/invitations`
只返回当前用户自己的邀请码、成功邀请数与奖励汇总。

OAuth state 用独立的 `invitationCodeInvalid` 布尔字段表达无效邀请码，签名载荷中不会放入
与合法邀请码共享命名空间的哨兵字符串。

## 会员与支付

首个付费权益是多币种一次性付款的终生会员，不做订阅：

- 免费用户使用 `IMAGE_QUOTA_MB`（默认 500 MB）的基础云存储配额
- 终生会员基础配额固定为 10 GiB，并取得后续 AI 功能的使用资格
- 两种等级都会在基础配额之上叠加最多 5 GiB 的 `bonus_storage_bytes` 邀请奖励
- `users.membership_tier` 是权益真值，当前只允许 `free | lifetime`
- `stripe_payments.checkout_session_id` 是幂等键，成功页主动确认与 Stripe webhook
  即使同时到达，也只会记录一笔付款并发放一次权益

支付流程：

```
POST /api/billing/checkout
  └─ 浏览器只提交币种，后端从白名单选金额并为固定 Product 创建 Checkout
       ├─ 浏览器跳转 Stripe
       ├─ 成功回跳 POST /api/billing/checkout/confirm
       └─ Stripe POST /api/billing/webhook（checkout.session.completed）
              └─ 两条确认路径都重新向 Stripe Retrieve Session
                   └─ 数据库事务记录付款 + 把会员等级改为 lifetime
```

币种白名单为 USD 3.99、CNY 29、EUR 3.99、JPY 600。Stripe 侧只配置一个
`STRIPE_LIFETIME_PRODUCT_ID`，每次 Checkout 由后端用 `price_data` 创建该币种的内联价格。
这样既能让用户明确选择结算币种，也不会把金额控制权交给浏览器。

不信任浏览器回传的金额、Price 或会员等级。发放前必须同时验证：`payment` 模式、
`paid` 状态、metadata 中的币种属于白名单、Session 与 line item 的金额/币种完全匹配、
唯一 line item 的 Product ID 与数量，以及
`client_reference_id` / metadata 中的用户归属。Webhook 原始请求先用 endpoint secret
验证 `Stripe-Signature`，但即使签名正确仍重新拉取 Session，避免把事件快照当权益真值。

Stripe 账号由多个服务共用，因此 Checkout Session 与 PaymentIntent 都写入
`metadata.service=koinote`。Webhook 只路由该服务的事件，其他服务的签名事件返回 200 忽略；
成功页确认和 Webhook 的最终 Session 校验都强制要求相同服务标记。

Checkout 不传 `payment_method_types`，由 Stripe 从 Dashboard 已启用方式中按地区、
用户位置和币种动态选择；当前测试账号已启用银行卡、Alipay 与 WeChat Pay。Webhook 同时处理
`checkout.session.completed` 与 `checkout.session.async_payment_succeeded`，后者保证异步
付款在用户关闭成功页后仍能发放权益。生产环境的
`STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、`STRIPE_LIFETIME_PRODUCT_ID` 必须三项齐全；
开发环境可暂缺 webhook secret，靠成功页确认走通 test mode。

每次点击购买都会生成新的随机 attempt ID，幂等键再把它与参数版本、回跳地址、用户、
Product、金额、币种和 Customer 参数一起生成指纹。Stripe 对同一次 API 调用的网络重试仍保持
幂等，但用户取消、Session 超时或主动重试时会得到新的 Session，不会被带回已失效页面。
改变支付方式等请求结构时仍需同步更新参数版本。创建 Session 另按用户限制为 10 分钟 5 次，
避免重复请求持续消耗 Stripe API；不同用户的计数互不影响。

### 收款通知

配置了 `BOT_WEBHOOK` 与 `BOT_WEBHOOK_SECRET` 时（沿用 Kimiseek 的机器人变量名），
首次落账会向飞书群推一条消息。两个约束决定了实现形状：

**通知不能影响权益。** 飞书挂掉时会员必须照常发放，所以通知状态是 `stripe_payments`
上的几个列，而不是发放事务的一部分。待通知标记在发放事务内写入（`notification_next_try_at`
与 `ON CONFLICT DO NOTHING` 共享同一把幂等锁），因此「落了账但没入队」不可能发生，
反过来通知失败也只是留下重试状态。

**恰好通知一次。** 成功页确认、webhook、以及 Stripe 的 webhook 重试是三条会撞在一起的
路径。判据是 `RowsAffected() == 1` —— 只有真正插入了付款行的那一次才推送，靠
`checkout_session_id` 主键去重，不额外加锁。

重试由一分钟一次的轮询驱动，`notification_locked_until` 提供 30 秒租约让多实例不重复投递。
退避是 `1 << (attempts-1)` 分钟，8 次之后固定为 24 小时 —— 与图片 GC 的
`gcMaxAttempts` 不同，这里不会彻底放弃，因为漏掉一笔收款的代价比多留一行待重试记录高。

消息正文只有站内用户 ID、金额、币种和订单标识。`paymentNotification` 结构体里没有
邮箱字段，不是发送时过滤掉的 —— 这样后来的人也没法顺手把它加回去。金额按 Stripe 的
最小单位解释，零位小数币种（JPY 等 16 种）列在 `zeroDecimalCurrencies` 里，
和价格白名单放在一起维护。

配额不是前端显示值：图片记账、文档创建、文档更新、存储用量四条路径都调用
`storageQuotaFor(user)`。这样数据库刚发放会员后，下一次写入就直接获得 10 GiB 加受限邀请奖励，
未来 AI 鉴权也可复用同一个会员等级，而不必再查 Stripe。

## MCP 文档访问

MCP 是 Koinote 暴露给 Codex、Claude Code 等 Agent 客户端的文档操作协议。模型推理发生在
客户端；Koinote 只提供工具与数据，因此服务端不调用 LLM，也不需要 OpenAI、Anthropic
等模型 API Key。当前入口是 Streamable HTTP `POST /mcp`，使用官方 Go MCP SDK 的无状态
JSON 响应模式。Worker 只精确代理 `/mcp`，保持请求 body stream，不解析或重编码协议内容。

### 为什么协议层在 Go，而不是 Worker / Durable Object

MCP 的身份、会员等级、文档授权、版本和审计真值都在 PostgreSQL 与 Go 后端。若把协议层
放进 Worker，它仍要先回后端认证，再把每个工具调用转回后端，多一跳却没有新增决策能力。
文档 CRUD 也是无状态请求，不需要 Durable Object 的会话状态、迁移与额外计费。Worker
因此只承担和 `/api/*` 相同的边缘反向代理职责，所有权限判断都留在 Go。

### 为什么第一版使用 PAT，而不是 OAuth

第一版只面向终生会员，并采用账户页创建的个人访问令牌：`read` 或 `write` scope、1–365 天
或永久有效、创建后可修改有效期、逐个撤销，最多 20 个有效令牌。永久令牌以
`expires_at IS NULL` 表示。明文带 `knt_mcp_` 前缀；数据库用 SHA-256 摘要鉴权，
同时以独立密钥做 AES-GCM 加密，账号本人可通过带限流的专用接口按需再次查看。列表接口只
返回尾号提示，不批量下发明文。令牌本身有 256 位随机熵，哈希不需要承担低熵密码的抗暴力
破解职责。

每次请求都会重新查询 token 与用户，检查撤销、过期和 `membership_tier=lifetime`，所以
已建立的无状态客户端不会绕过后续撤销或会员降级。认证查询故障返回 500，不伪装成 401。
每 token 每分钟最多 120 个请求，请求体最多 2 MiB；PAT 管理响应带 `Cache-Control: no-store`。
限流目前与站内其他限流一样是进程内的，多实例前应迁到共享存储。

PAT 对 CLI 客户端是一等公民，也避免为了首版引入 OAuth 2.1 的授权服务器元数据、受保护
资源元数据、动态客户端注册和授权 UI。等有大量第三方用户需要浏览器授权时，再评估 OAuth；
现在先把较小、可撤销且容易审计的信任边界做扎实。

### 工具与授权边界

只读令牌暴露：

- `list_documents`：按最近修改分页列出摘要，不返回正文
- `search_documents`：搜索标题与 Markdown 正文，并返回命中位置附近的短摘要
- `get_document`：按 Unicode 字符 offset/limit 分段读取，并返回总长度与 `hasMore`
- `list_document_versions` / `get_document_version`：查看保留的恢复点
- `list_trashed_documents`：列出 30 天回收站中的摘要和自动删除时间

读写令牌额外暴露 `create_document`、`append_to_document`、`update_document` 与
`restore_document_version`，以及带 `expectedRevision` 的 `trash_document`、
`restore_trashed_document`。MCP 不暴露永久删除；永久删除只允许网页回收站在再次确认并输入
标题后调用。普通删除只是设置 `trashed_at`，30 天内仍计入配额、保留版本并保护图片引用；
后台每小时清理到期行，届时才删除版本并把真正孤儿的图片交给 R2 GC。所有查询都同时按 `user_id` 和
`doc_id` 过滤，也不读取公开分享，因此提示注入最多影响持有该 token 的客户端上下文，不能
跨账号扩大数据范围。真正的写入隔离来自 scope，而不是一条“内容不可信”的提示词。

审计日志只保存 user、token、工具名、文档 ID、成功/失败和耗时，不记录正文或明文 token，
并由后端每日清理超过 180 天的记录，避免高频工具调用让运维元数据无界增长。
协议工具的业务错误给 Agent 返回可行动的信息（如重新读取最新 revision），数据库内部错误
则统一对外为 `internal server error`。

### 版本历史先于 Agent 写入

整篇覆盖的破坏力不低于删除，所以开放 `update_document` 前先建立了版本历史和网页/MCP
共用的 revision compare-and-swap：每次真实修改 revision 加一，相同内容的 no-op 不增加；
客户端收到成功响应前断线后，用旧 revision 重试同一内容会幂等返回当前文档，旧 revision
配不同内容才冲突。追加与恢复也要求 `expectedRevision`，不是用“追加天然安全”掩盖并发覆盖。

网页自动保存同样发送 revision。若 Agent 在网页标签打开期间修改文档，下一次网页保存收到
409，不会把 Agent 内容静默覆盖；本地草稿写入 localStorage，刷新后仍能进入合并界面。用户
可采用远端，也可编辑本地标题与正文后用最新 revision 保存；远端再次变化会再次冲突。明确
覆盖时强制保存被覆盖状态，历史恢复本身也走 CAS，并把恢复前的当前状态再留一版。

只有终生会员保存历史。默认开启历史、每篇保留 20 版并为 MCP 写入保存完整旧状态；用户可在
账户页或通过读写 MCP token 调整为每篇 1–100 版，也可关闭网页等常规新快照，或关闭 MCP
完整历史。关闭 MCP 完整历史不会让 Agent 的整篇覆盖变得不可恢复：每篇仍维护最近 1 个
MCP 安全快照，下一次 Agent 写入会替换旧安全快照；后续产生完整版本时也会移除重复的安全
快照。安全快照与普通版本共享每篇上限和账号总计 100 版的上限，不形成隐藏额度。关闭设置
不会删除已有版本，降低单篇上限会立即裁剪。频繁网页自动保存最多每五分钟保存一次，避免每
800 ms 防抖写入制造一版。

读写 scope 的 token 可以修改这套账户级保留策略，不只可以改文档内容。这项权限是刻意开放的，
但不能绕过恢复安全边界：设置变更无法关闭 revision CAS、会员校验、每篇/账号上限，也无法关闭
强制保留的最近 1 个 MCP 安全快照。即使 Agent 在整篇覆盖前同时关闭常规历史和 MCP 完整历史，
被覆盖状态仍能从安全快照恢复。若未来要移除强制安全快照，必须先把设置工具拆到独立 scope，或
不再向读写 token 暴露。

历史正文不计入用户的云存储字节配额，但其中引用的图片继续阻止 R2 GC；版本淘汰或文档删除后
重新检查引用，再异步回收真正孤儿的对象。当前引用复查会在最坏情况下顺序扫描该用户的全部
历史正文，数据规模增长后应改为独立的版本图片引用表或等价索引结构。文档与图片配额变更共用
用户级 advisory transaction lock，防止并发请求都基于旧用量通过检查。

## 搜索、迁移与产品分析

全局搜索和 MCP 的 `search_documents` 共用后端查询：只查当前用户、排除回收站，同时匹配标题与
Markdown 正文并返回命中位置附近的短摘要。查询长度限制为 1–200 个 Unicode 字符，网页每次最多
50 条；前端用 `⌘K` / `Ctrl+K` 唤起并在本地高亮结果。搜索词不会写入日志或产品统计。当前实现是
大小写不敏感的子串扫描；数据量明显增长后再评估 PostgreSQL 全文索引或 trigram。

批量迁移保持 Markdown 为主格式。导入接受单个 `.md`、浏览器选择的文件夹或 ZIP；ZIP 解包限制为
1000 个文件和 250 MiB 未压缩数据，路径先归一化并拒绝越界。只有被 Markdown 实际引用的 PNG、
JPEG、GIF、WebP 才上传，随后把 Markdown 与 HTML `<img>` 地址改写为新账号下的 URL，避免不可见
文件消耗配额。全量导出会保留文件夹结构，把自有图片从同源 `/images/<key>` 读取后写进 `assets/`，
并附带 manifest；单张图读取失败会记录在 manifest，不会静默阻止其余文档导出。

产品统计是第一方、最小化数据：`product_milestones` 对每个用户/事件只留首次时间，覆盖注册、首篇
文档、首次上传、首次导出、首次 MCP 成功调用、开始结算和完成结算；`user_daily_activity` 每个用户
每天最多一行，只用于 D1/D7/D30 留存。正文、标题、搜索词、文件名和分享访客身份都不进入统计。
除“首次导出”只能由浏览器确认外，其余事件都在后端业务成功路径记录。留存只从迁移上线时间开始
计算，后台同时展示这个起点，不伪造历史活跃。

## 管理后台

`GET /api/admin/stats` 先从服务端 session 读取用户，再检查数据库中的 `is_admin`；前端
是否显示菜单只改善体验，不参与授权。未登录返回 401，普通用户返回 403。响应不包含密码哈希、
Stripe Customer ID、Checkout Session ID 或内部鉴权标识。

业务统计以 PostgreSQL 为真值：用户、已验证用户、终生会员、文档、图片账本、全站存储、
订单、按币种收入、30 天增长、首次行为漏斗、D1/D7/D30 留存和最近记录。不同币种不做无汇率来源的相加；前端分别用
`Intl.NumberFormat` 展示。包含文档与图片全表聚合的总览缓存一分钟，缓存锁同时合并并发加载，
避免多个管理员刷新时重复扫描大表。

今日 UV / PV 通过 Cloudflare GraphQL Analytics API 的 `httpRequests1hGroups` 查询。
查询不带时间维度且只取聚合结果，因此 `uniq.uniques` 是整段时间的去重结果，不能把小时桶的 UV 相加。
它使用独立的最小权限 `CLOUDFLARE_ANALYTICS_TOKEN`，并按 hostname 过滤同一 Zone 下的流量。
结果缓存一分钟。Token 缺失、权限错误或 Cloudflare 超时时只让 `traffic.available=false`，
PostgreSQL 业务统计仍返回 200。这个 UV / PV 是边缘 HTTP 口径，可能包含合法爬虫与已放行
的自动流量，不等同于客户端埋点的真实用户会话。

## 分享

两档权限：

| 档位       | 含义                                               |
| ---------- | -------------------------------------------------- |
| `link`     | 知道链接即可访问，token 随机 32 位十六进制不可枚举 |
| `password` | 访问者需输入口令（bcrypt 存哈希，至少 6 字符）     |

原本还有第三档 `public`，已删。它与 `link` **行为完全相同**——后端从未有分支
读它，而它声称的「允许被索引」也不存在：`setShareResponseHeaders` 给所有分享页
无条件加了 `noindex`。界面提示语当时写的就是「同上」。一个不改变任何行为的
选项只会让用户误以为自己做了一个安全决策。

存量数据由 `normalizeShareAccess` 在读取时归一成 `link`；写入路径仍接受
`public`（老页面可能还没刷新）并按 `link` 处理，但其余非法取值一律 400。
读写不共用归一函数是有意的：读取时兜底成 `link` 是安全的（真正的访问控制在
`share_password_hash`），写入时兜底则会把拼错的档位静默咽下去。

端点：

```
POST   /api/documents/{docId}/share   开启或改权限（需登录且限本人）
DELETE /api/documents/{docId}/share   撤销
GET    /api/share/{token}             公开读取，token 即凭证
POST   /api/share/{token}/verify      校验口令后返回正文
GET    /api/share/{token}/meta        给 Worker 提供最小 OpenGraph 元数据
```

前端页面在 `/share/$token`，无需登录，只读视图复用编辑器的同一套扩展，
所以代码高亮、公式、图片的呈现与编辑时一致。Worker 在返回 SPA HTML 前注入动态标题、摘要、
canonical 与 OpenGraph/Twitter 卡片；口令档的 meta 只回 `protected=true`，不会泄露标题、摘要或封面。
分享仍保留 `noindex`，这些元数据服务于聊天工具与社交平台预览，而不是开放搜索引擎收录。

口令只保护分享 API 返回的标题与正文，不把图片对象改成私有资源。正文引用的 `/images/<key>`
和 R2 自定义域名地址仍是“知道 URL 即可读”；key 随机不可枚举，但拿到完整图片 URL 的人无需
分享口令即可读取。这与全站图床及“复制到我的 Koinote”的图片转存模型一致。若产品以后要求
口令同时保护图片，需要改成短期签名 URL 或受鉴权的图片代理，不能只调整分享接口。

正文实际返回后才原子递增 `share_view_count`；口令失败和只取 meta 都不计数，也不记录读者身份、IP
或 User-Agent。登录用户可把分享复制到自己的账号；复制时会重新上传正文引用的 Koinote 图片，
避免原作者日后删除文档或触发图片 GC 导致副本裂图。

几处刻意的语义取舍：

- **重复调用 POST 默认复用同一 token** —— 已发出的链接不会因为改权限就失效
- **但放宽权限时必须换 token**（见下）
- **撤销后重新开启会换新 token** —— 老链接永久失效，这是撤销的意义所在
- **已撤销与从未存在返回同一响应** —— 不泄露某个链接曾经有效
- **口令档下 GET 只回 `requiresPassword` 标志** —— 正文一个字都不经过未验证的响应
- **公开视图只输出 title / content / updatedAt / ownerName / viewCount** —— 内部 id、user_id、doc_id、share_token 一律不外泄

### 放宽权限必须换 token

判定见 `shouldRotateShareToken`。规则不对称，因为风险不对称：

| 改动                              | token    | 理由                               |
| --------------------------------- | -------- | ---------------------------------- |
| 收紧（`link` → `password`）       | 复用     | 老链接只会变得更严，安全性只增不减 |
| 改口令（`password` → `password`） | 复用     | 权限档未变                         |
| **放宽（`password` → `link`）**   | **换新** | 见下                               |

放宽时若复用 token，同一个 URL 会从「要口令」变成「谁拿到都能直接读全文」，
**之前被口令挡住的人瞬间全部获得访问权**，而用户以为自己只是改了个设置。
这一步没有确认对话框拦着（撤销分享有），所以它是静默的权限放宽。

换 token 让老链接立刻失效，用户必须重新分享——这个动作本身就是知情确认。
响应回传 `tokenRotated`，界面据此显示提示，因为用户可能已经把老链接发出去了。

选择换 token 而非加确认弹窗：弹窗可以被无脑点掉，而换 token 是结构性的——
拿过老链接的人不会因为你调了个设置就突然获得访问权。

口令爆破防护：两层限流（单 IP 20 次、单链接 10 次，15 分钟窗口），
限流 key 用 token 的 sha256 而非明文。响应头 `Cache-Control: private, no-store`
—— 口令档正文若被 CDN 缓存，拿到缓存就等于绕过口令。另加 `X-Robots-Tag: noindex`。

> ⚠ **限流器是进程内存实现**。
> 多实例部署时各进程独立计数，实际阈值被放大 N 倍。上多实例前必须接入共享限流存储。

## 导出

“我的文档”的全量 ZIP 迁移与单篇格式导出分开：前者以 Markdown、目录和图片的可逆搬迁为目标，
后者以交付给阅读器、办公软件或自媒体平台为目标。全量迁移细节见“搜索、迁移与产品分析”。

六条路径，全部在浏览器端完成，不占后端资源：

| 格式              | 实现                                                          |
| ----------------- | ------------------------------------------------------------- |
| `.md`             | 直接取 `storage.markdown.getMarkdown()`，内容本就是 Markdown  |
| `.html`           | 自包含单文件，样式内联，KaTeX 的 CSS 引 CDN，公式在生成时渲染 |
| `.docx`           | `docx` 库，走 ProseMirror 文档树构建                          |
| `.pdf`            | html2canvas-pro 栅格化 + jsPDF 分页，一键下载                 |
| 微信公众号        | 主题样式内联 + 公式转图，写进剪贴板                           |
| 打印 / 另存为 PDF | 浏览器原生打印管道 + `@media print`                           |

**PDF 为什么是两条路**：浏览器里能产出矢量文字 PDF 的引擎只挂在打印管道上，
而打印对话框无法绕过。所以「一键下载」与「文字可选可搜」在纯前端不能同时成立，
两条路各保留一条：

|                   | 一键下载         | 文字可选可搜   | 体积         |
| ----------------- | ---------------- | -------------- | ------------ |
| `.pdf`（栅格）    | 是               | 否，文字是位图 | 约 650 KB/页 |
| 打印 / 另存为 PDF | 否，需在对话框选 | 是，矢量       | 小得多       |

那个对话框与打印机无关：Chrome 选「另存为 PDF」时走的是 Skia 的 PDF 后端，
不碰任何打印机驱动，未装打印机也能用。CSS 规范里这套东西叫 _paged media_，
PDF 只是它的一个输出目标。

栅格路径的实现取舍：

- **栅格化真实 DOM，而不是手工在 canvas 上画字**。公式、代码高亮、表格边框
  都由浏览器排版，不用自己写排版逻辑 —— 手绘方案要支持 LaTeX 等于重写一个
  TeX 排版引擎。
- **分页切口对齐到块元素边界**，避免把一行字横着切两半。但若紧随切点的元素
  本身高过一页（长代码块），它无论如何都要被硬切，此时不提前断页，否则白扔
  半页空白。
- **图片先转 data URL 再栅格化**。跨域图片会让 canvas 变成 tainted，之后
  `toDataURL` 直接抛 `SecurityError`，表现是整个导出失败而非少一张图。
- **代码块在 PDF 里用浅底**，与打印路径一致；深底在纸上是整片实色，且位图
  压缩率差得多。
- **倍率 2 倍（≈192 DPI），无损 PNG**。压缩等级与去 alpha 通道都实测过，
  对体积没有影响；唯一有效的是有损 JPEG（省 14%~40%），但中文小字在 JPEG 下
  边缘起振铃，画质优先。
- `html2canvas-pro` 而非 `html2canvas`：Tailwind v4 默认输出 `oklch()` 颜色，
  原版认不出会渲染成透明或黑色。

**DOCX 的降级取舍**：公式保留为 LaTeX 源文本（转 Word 的 OMML 是另一个量级的
工作，保留源码至少无损可读）；代码块只给等宽字体加浅灰底，不做语法高亮着色；
图片逐张抓取内嵌，类型按文件头嗅探（把 JPEG 标成 png 会产出打不开的文档），
webp 不被 docx 支持故降级成占位行；单张图片失败只留占位，不让整个导出失败。

`docx` 库约 1 MB，用动态 `import` 拆成独立 chunk，不压在编辑器首屏。

### 微信公众号

参考 `../keepask` 的 `dbskill_wechat_styles.go`。它有两条路：一条让 LLM 按样式
指南生成 HTML，一条是纯字符串处理的样式内联器。**这里抄的是后者** —— koinote
没有 AI 接入，而且内联那 248 行本来就不需要模型：正则抽 CSS、拍平成
「标签 → 声明」、遍历 HTML 树写 `style` 属性。

产物不落盘而是**写进剪贴板**（`text/html` + `text/plain` 双格式），因为用户的
实际动作是「粘贴到公众号编辑器」，下载 .html 再打开再全选复制是多余的三步。

微信编辑器的行为决定了实现的每一处：

| 微信的行为                        | 因此必须                          |
| --------------------------------- | --------------------------------- |
| 剥掉 `<style>` 与外链 CSS         | 样式只能进每个元素的 `style` 属性 |
| 剥掉 `class` / `id`               | 选择器只能是标签名                |
| 剥掉 `<script>` 等                | 直接删掉整个子树                  |
| 粘贴时抓取外部图片转存            | 公式图片走 R2 真实 URL            |
| 剥掉 `white-space`（实测确认）    | 缩进必须靠结构承载，不能靠 CSS    |
| **不**剥 `background`（实测确认） | 深色主题原样存活                  |

后两条是靠用户反复粘贴测出来的，不是查文档得来的 —— 微信没有公开的过滤规则清单，
只能一条条试。记在这里是因为它们决定了下面两处实现。

**主题直接以「标签 → 声明串」存**（`wechatThemes.ts`），不存 CSS 文本。既然最终
只能按标签查表，就省掉 keepask 那道从 markdown 正则抽 CSS 的环节。代价是失去
CSS 的表达力，但那部分表达力在内联方案下本来就用不上——keepask 的主题里有
`h2:before{content:""}` 这类装饰条，**内联时会被静默丢掉，在微信里根本不出现**。
所以这里的五个主题都不依赖伪元素。唯一保留的后代选择器是 `pre code`（代码块内的
`code` 与行内 `code` 视觉不同）。

**高亮必须在导出时重新生成一遍。** `CodeBlockLowlight` 是用 ProseMirror 的
**装饰**（decoration）上色的 —— 那是视图层的东西，从不进入文档。所以
`editor.getHTML()` 的产物里根本没有 `hljs-*` span。

这正是一个用户报过的 bug 的根因：粘到公众号里是「一个灰色的代码框，代码都是文本
形式」。当时下游每一环都是对的 —— 配色表、内联器、颜色查表全都能单独跑通 ——
但内联器读到的 class 永远是空串，因为那一环根本不存在。
`highlightCode.ts` 在导出舞台上重跑一遍 lowlight 来补上。

同一个根因也影响 HTML / PDF 导出：`exportStyles.ts` 里那些 `.hljs-*` 规则
本来永远匹配不到任何元素。

**缩进必须靠结构承载。** 微信剥掉 `white-space`，所以 `pre-wrap` 靠不住 ——
行首空格会被空白折叠吃掉，Python 直接变成废码。解法是让空白本身不需要 CSS 维持：
U+00A0（不参与空白折叠）加 `<br>`（是元素，不受 `white-space` 影响）。
制表符按 4 空格展开。见 `wechatWhitespace.ts`。

这一条是用户报了两次才定下来的：第一次「高亮没了」，修完高亮之后第二次
「高亮在了，但缩进没了」。每一轮我都明确说过哪一部分无法验证，而每一次
坏掉的正是那个无法验证的部分 —— 所以真正起作用的机制是用户的粘贴反馈，
不是我的推理。

**公式必须转成图片。** KaTeX 的产物是几百个带 class 的 `<span>` 靠 `position`
拼出来的排版，class 被剥掉后剩一堆错位的散字，比不显示更糟。流程是
KaTeX → html2canvas（3 倍，公式字号小，低于 3 倍在手机上发虚）→ 上传 R2 →
`<img>`。选 R2 而非 base64 data URL：微信抓取外链是你文档里普通图片已经验证过的
行为，而 data URL 是否被接受无法确认。

两处刻意的顺序，反了就出错：

1. **先转公式图，再内联样式。** 反过来新插入的 `<img>` 拿不到主题的 `img` 规则。
2. **公式图的宽高排在主题规则之后。** 主题的 `img` 规则里有 `height:auto`，
   顺序反了会把公式压扁。这条靠 `data-wechat-keep-style` 传递，有专门的断言守着。

**公式图是临时、内容寻址对象。** 同一次导出里按 LaTeX 源码复用渲染结果；上传后
Worker 再按 PNG 字节的 SHA-256 生成稳定 key，因此跨刷新、跨会话重复导出也不会在
R2 堆副本。每次导出会把对象的保留期续到 7 天，之后进入图片 GC；若用户把该 URL
写回自己的正文，GC 的引用复查会保留它，直到正文真正移除引用。账本用 `purpose`
区分这类临时对象：它们不占正文云存储额度，而是受独立的每用户 100 MiB 临时额度约束，
所以导出不会顶满普通上传，客户端伪造 purpose 也不能无限绕过存储限制。

**已知降级**：代码块的语法高亮无法保留（class 被剥），只剩等宽字体与底色。
对话框里明写了这条，不让用户以为是 bug。公式转换失败时降级成 LaTeX 源码并提示
数量——静默降级的话用户会以为公式本来就长那样。

## 代码高亮与 LaTeX

**代码高亮**：lowlight（highlight.js）的 common 集，约 37 种主流语言。
打三个反引号加语言名即可，如 ` ```go `。配色见 `globals.css` 的 GitHub Dark 精简版。

**LaTeX**：KaTeX 渲染，用 CommonMark 通行的分隔符。

- 行内：`$E = mc^2$`
- 块级：`$$…$$`（同行或跨行皆可）
- 点击公式可回到源码编辑
- 语法错误时回落成红色等宽文本并标记，不静默失败

三处需要留意的实现细节：

0. **导出时必须自己调一遍 KaTeX。** 扩展的 `renderHTML` 只输出一个带
   `data-latex` 的空元素（见 `extension-mathematics/dist/index.js`），公式的
   可见形态完全由编辑器内的 nodeview 提供。导出走 `editor.getHTML()`，拿不到
   nodeview —— 不补渲染的话，导出物里公式位置是**零高度的空白**，属于静默丢
   内容。`spa/src/components/editor/renderMath.ts` 负责补这一步，HTML 与 PDF
   两条导出路径共用。
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

**图片是「知道 URL 即可读」的。** key 不可枚举，但没有鉴权 —— 私有文档里的图片，
链接泄漏后任何人都能看。这是图床的常规做法，但用户通常会假设「私有文档里的图也是
私有的」，所以这条取舍值得在隐私政策里明说。不能接受的话要改成签名 URL。

### 存量对象的回填

`scripts/backfill_image_objects.py` 把已经在 R2 里、但不在 `image_objects` 账本里的
对象补进账本。

需要它的原因是个 bug：记账的那条 SQL 一直有类型推导错误（`bytes` 列是 `bigint`，
而 `SUM(bytes)` 是 `numeric`，`$3` 被推出两种类型），所以**图片记账从来没工作过** ——
账本长期是空表，用量只显示文档正文那一部分。修好之后新上传会记账，但存量不会追溯。

```bash
python3 scripts/backfill_image_objects.py            # 预演，不写库
python3 scripts/backfill_image_objects.py --apply    # 真写
```

做法是扫所有文档正文里的图片 key（用与 `image_keys.go` 相同的正则与归属规则）
→ HEAD 拿 `content-length` → 插账本。幂等：已在账本里的跳过，重复跑不会重复计费。

三处刻意的取舍：

- **不走配额判定。** 这些对象已经占着 R2 的空间了，账本只是把既有事实记下来。
  用带 `WHERE` 判定的那条语句会在超额时拒绝写入，结果是「用量仍然显示不出来」——
  与回填的目的正好相反。
- **R2 里不存在的 key 跳过并报数。** 那是正文引用了已被删除的对象，
  往账本里塞一个不存在的对象会让用量虚高，而且永远没人来纠正。
- **扫不到孤儿对象。** R2 里可能有已经不被任何文档引用的图（删过的、上传后没保存的），
  扫正文永远看不到它们。要覆盖得让 Worker 加一个列举端点，而孤儿对象本来就该由
  回收任务删掉，不该长期计费。

脚本启动时会读 `image_keys.go` 比对正则，不一致就直接退出 —— 两边抄了同一个正则，
漂移的后果是「漏掉一类扩展名」，而漏一部分比整个没跑更难发现。

### 本地上传需要 Wrangler

Vite 会把 `/api/images` 与 `/images` 代理到 `http://localhost:8788`。Worker 没启动时
上传会连接失败；Go 后端本身没有 R2 端点。

先在仓库根目录创建已被 `.gitignore` 排除的 `.dev.vars`：

```dotenv
BACKEND_INTERNAL_TOKEN=<与 .env 相同的值>
```

再启动 wrangler（自带本地 R2 模拟，不碰线上数据）：

```bash
npx wrangler dev --port 8788
```

Worker 默认把后端请求发到 `http://localhost:8080`；后端改端口时用
`--var BACKEND_URL:http://localhost:<端口>` 覆盖。

本地对象存在 `.wrangler/state/v3/r2`（已在 `.gitignore` 中）。

### 生产配置

```bash
npx wrangler secret put BACKEND_URL --env production          # 指向 Go 后端 HTTPS 源站
npx wrangler secret put BACKEND_INTERNAL_TOKEN --env production   # 与后端使用同一个值
npx wrangler secret put CLOUDFLARE_ZONE_ID --env production
npx wrangler secret put CLOUDFLARE_CACHE_PURGE_TOKEN --env production
# R2 绑定已写在 wrangler.jsonc，无需 secret
```

### 图片地址分层：网页同源，导出 CDN

由 `IMAGE_PUBLIC_BASE` 控制。

配上 R2 自定义域名后，`publicURL` 返回 CDN 绝对地址并写入文档，作为图片的规范地址。
网页渲染时 `ImageNodeView` 只改实际 `<img src>`，把自有 CDN 地址映射成同源
`/images/<key>`：这样不受浏览器 CORS / Local Network Access 影响。TipTap 节点里的
地址不变，所以 Markdown、HTML、微信等导出仍使用 CDN，旧文档也无需迁移。

这层稳定性有明确代价：网页首次加载一张图片会消耗一次 Worker 请求；浏览器拿到的
响应带一年 immutable 缓存，重复打开不会每次都请求。外部导出内容和直接访问 CDN
仍不经过 Worker。

本地开发的模拟 R2 不含生产对象。`IMAGE_READ_FALLBACK_BASE` 默认留空，避免开源仓库在
本地 R2 缺图时意外访问维护者的生产域名。确实需要查看自己生产环境的存量图片时，可在
`.dev.vars` 中显式设置自己的 CDN 基址；回源仍要求合法的自有图片 key，不能充当任意
URL 代理，`env.production` 也不启用这条路径。

留空**不影响**微信导出的正确性：导出时 `auditWechatImages`
（`spa/src/components/editor/wechatImages.ts`）会把 `/images/<key>` 按当前源补成
绝对地址，所以线上部署后即使走 Worker 代理，微信也抓得到，只是每次加载多花一个
Worker 请求。

真正抓不到的场景是**本地开发**：补出来的是 `http://localhost:5273/...`，微信的
服务器访问不到。这时导出对话框会直接报出「N 张图片抓不到 + 主机名」——
必须在点复制的时候就说，因为粘贴那一刻微信不会报错，要等文章预览才看到裂图。

配置步骤（在 Cloudflare 后台手工做）：

1. R2 → `koinote-images` → Settings → Public access → Connect Custom Domain
2. 填一个已托管在 Cloudflare 的子域名，如 `img.你的域名`
3. 等 DNS 与证书就绪
4. 把它写进 `wrangler.jsonc` 的 `IMAGE_PUBLIC_BASE`，形如 `https://img.你的域名`
5. 创建一个只带 `Zone / Cache Purge` 权限的 API token，再把
   `CLOUDFLARE_ZONE_ID` 与 `CLOUDFLARE_CACHE_PURGE_TOKEN` 设成 Worker secret
6. 给图片域名加 Cache Rule，把 404 的 Edge TTL 设为 0。Cloudflare 默认会缓存
   R2 自定义域名的 404；旧文档、导出内容和直接访问仍可能命中该域名

**配完必须用自查端点确认，不要只看图片能不能显示：**

```bash
curl https://你的域名/api/images/config
# {"mode":"cdn","base":"https://img.你的域名","valid":true,
#  "purgeRequired":true,"purgeConfigured":true,"warning":null}
```

自查端点存在的理由：配错时系统**回落到 Worker 代理，图片照样显示**，所以
「图片能看」证明不了 CDN 生效了。没有这个端点，只能等月底看账单上多出的请求数。
健康配置会返回 HTTP 200、`mode: "cdn"` 和 `purgeConfigured: true`；
`warning` 会说明失败原因。

删除 R2 对象不会自动清掉 Cloudflare CDN 已缓存的内容。图片删除端点因此先删 R2，
再按完整公开 URL 调 single-file purge API。缺 purge 配置时会在碰 R2 前拒绝；R2 已删
但 purge 失败时会返回错误，让后端保留 GC 队列与配额账本，下一轮幂等重试。3 个固定
重试查询参数的变体也会与原 URL 一起清理，并按 Cloudflare 单次最多 100 个 URL 分批。
这里必须调用 REST API，因为 R2 binding 没有全局 CDN purge；
`caches.default.delete()` 也只清当前数据中心。

`normalizeImageBase`（`worker/images.ts`）的校验：必须带 scheme、只收 http(s)、
拒绝带查询串或 fragment、去掉末尾斜杠、保留子路径（R2 自定义域名允许挂子路径）。
配错不抛错而是回落 —— 抛错会让上传直接失败，那是更坏的结果。

> 关于 workerd 的一个猜想被实测否定了，记在这里免得后人重走：曾以为 workerd 的
> `URL` 会把无 scheme 的输入静默补成 `https://`（那样只靠 try/catch 校验就会在
> 线上失效）。实际探针结果是 workerd 与 Node 一致，三种无 scheme 写法都抛
> `TypeError`。代码里那条 scheme 正则因此是冗余的，保留只为让约束显式可读。

## 验证

一条命令跑完前端与 Worker 的全部检查（两端 typecheck + 全部断言套件）：

```bash
npm test          # typecheck × 2 + 全部套件，失败即停
npm run go:test   # go vet + go test（后端）
```

两者由 GitHub Actions 在每次 push 与 PR 上跑（`.github/workflows/ci.yml`），
另有一个 job 检查密钥卫生：`.env*` / `.dev.vars` 没被提交、源码里没有硬编码密钥。

> 各套件脚本末尾是 `; ec=$?; rm -f ...; exit $ec` 而不是 `; rm -f ...`。
> 后者会让 npm 读到 `rm` 的退出码（永远 0）—— 测试失败也报成功，CI 接上去
> 等于没接。这个坑实测过：改坏一处源码，套件明明打印「1 失败」，
> `npm run` 的退出码仍是 0。

后端：`cd backend && go test ./...`（CI 里带 `-race`）。

MCP：`npm run test:mcp` 检查 Worker/Vite/后端路由、会员入口，以及只开放可恢复删除而不开放永久删除；Go 测试使用
官方 SDK 完成 Streamable HTTP 握手，并在真实 PostgreSQL 下覆盖 PAT 哈希与即时撤销、
read/write 工具集、文档读写、revision 冲突与幂等重试、版本保留、并发 CAS、审计以及
历史图片的 GC 保护。

Worker：`npm run test:worker` —— `normalizeImageBase` 的 21 条纯函数断言。
`npm run test:security-headers` —— 安全响应头的 35 条断言。
平台层另有 `python3 scripts/verify_image_base.py`，在真实 workerd 里确认
`/api/images/config` 路由挂对、`env` 读到、响应结构正确（Node 那层验不了这些）。
它会临时改写 `wrangler.jsonc` 再从 `git show HEAD` 还原。

前端导出这块没有单元测试框架，改用**真浏览器端到端验证** —— 协议层的 curl
验不了「点了导出按钮之后浏览器到底下载了什么」。两个脚本走完整链路：登录、
写入含公式/代码/表格的内容、点菜单、抓下载文件、解析产物。

```bash
pip install playwright pypdf pillow && playwright install chromium

# 建议对着生产构建物跑（npm run build && npx vite preview）
PROBE_BASE=http://localhost:5274 python3 scripts/verify_pdf_export.py
PROBE_BASE=http://localhost:5274 python3 scripts/verify_export_formats.py
PROBE_BASE=http://localhost:5274 python3 scripts/verify_share_rotation.py
PROBE_BASE=http://localhost:5274 python3 scripts/verify_wechat_export.py
```

`verify_wechat_export.py` 检查产物是否真的满足微信约束：无 `<style>`、无 `class`、
样式全在 `style` 属性上、公式变成指向 R2 的 `<img>` 且带显式宽高、剪贴板同时有
`text/html` 与 `text/plain`。它需要 wrangler 在 8788（公式要上传 R2）。

> 这几个脚本都会先确认「测试内容真的写进了编辑器」才继续。文档是异步加载的，
> 过早输入会被随后到达的持久化内容盖掉 —— 曾经因此出现偶发失败，而且失败时
> 断言实际验的是上一次测试留下的旧文档，比直接报错更难查。

`verify_share_rotation.py` 验证放宽权限时老链接确实失效。这条必须走真实 HTTP：
单元测试只能证明判定函数对，证明不了「那个 URL 真的打不开了」。

`verify_pdf_export.py` 会解析 PDF 内部结构：页数、A4 尺寸、**每页内容流实际
引用的 XObject**（判断分页是否正确 —— jsPDF 把所有位图放在一个共享资源字典里，
所以不能只看 `page.images`）、各页位图指纹是否互不相同、分页填充率、单页体积，
以及导出时按需加载了哪些 chunk。

`verify_export_formats.py` 覆盖四种下载格式，重点是公式在每种格式里是否真的落地。

两个脚本都需要后端与数据库在跑，且会在数据库里留下一个 `pdfprobe` 测试账号。

## 构建与部署

```bash
npm run build     # vite build → spa/dist
npm run deploy    # 构建并部署 production Worker + SPA（不部署后端）
```

后端首次部署在 VPS 配好 `.env` 与 `deploy/Caddyfile` 后，从仓库根目录运行：

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

后续官方部署由 `.github/workflows/deploy.yml` 先同步并重建后端、跑健康检查，再发布
Worker 与 SPA；`BACKEND_URL` secret 指向后端 HTTPS 源站。
