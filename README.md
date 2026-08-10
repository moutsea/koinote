# Koinote

Typora 式所见即所得的在线 Markdown 编辑器，集成图床与 AI（规划中），采用订阅制。

以 [MIT 许可证](LICENSE) 开源。

## 自建须知

自己部署的话，这几条会直接影响安全，值得先看一眼：

- **`SESSION_SECRET` 必填**，没有回退，留空后端拒绝启动。生成：
  `openssl rand -base64 48`。细节见[会话密钥](#会话密钥session_secret)。
- **`NODE_ENV` 决定 cookie 的 `Secure` 标志**。`.env.example` 默认给
  `production`，本地开发要自己改回 `development`（否则 http://localhost
  下登录态存不住）。
- **图片是「知道 URL 即可读」的**：key 随机不可枚举，但没有鉴权。私有文档里的
  图片，链接泄漏后任何人都能看。这是图床的常规做法，但用户通常会假设
  「私有文档里的图也是私有的」—— 如果你的场景不能接受，得改成签名 URL。
- **限流是进程内的**，多实例部署时阈值会被放大 N 倍，见[限流](#限流)。

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

Vite 端口由 `.env` 的 `DEV_PORT` 控制（默认 5173），`/api/*` 与 `/health`
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
npm run docker:up   # postgres + redis + backend 全部进容器
```

## 认证

- 注册 / 登录 / 登出 / 会话查询：`POST /api/auth/{register,login,logout}`、`GET /api/auth/session`
- 第三方登录：`GET /api/auth/oauth/{google,github}/{start,callback}`
- 会话是无状态 HMAC-SHA256 签名的 `koinote_session` cookie（HttpOnly / SameSite=Lax / 生产 Secure），**不落库**
- 密码 bcrypt（cost 10）哈希；登录支持用户名或邮箱，大小写不敏感
- MVP 简化：注册即 `is_verified=true` 可直接登录；邮箱验证 / 支付留待后续阶段

### 会话密钥（SESSION_SECRET）

`koinote_session` 的 HMAC 签名密钥。**必填，没有任何回退** ——
留空后端直接拒绝启动，不分环境（本地也一样）。

```bash
openssl rand -base64 48
```

曾经有两级回退：`BACKEND_INTERNAL_TOKEN`，再兜底一个硬编码常量。两级都删了：

- 硬编码兜底在开源仓库里等于**公开签名密钥** —— 拿那个字符串就能签出任意用户的
  会话，不需要密码。原本有一道「生产环境必须配」的检查拦它，但那道检查挂在
  `NODE_ENV=production` 上，而 `.env.example` 里写的是 `development`，
  照文档走一遍就绕过去了。三个各自合理的决定凑成一个默认不安全的部署。
- 回退到 `BACKEND_INTERNAL_TOKEN` 也删了：那是 Worker → 后端的横向凭据，
  与会话签名是两种用途、两种轮换周期。混用意味着轮换内部令牌会把所有人踢下线，
  且任何能读到内部令牌的组件都顺带获得了伪造任意会话的能力。

**换密钥会让所有已签发的会话立即失效**，用户需重新登录。

### 内部令牌（BACKEND_INTERNAL_TOKEN）

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
能拿到那个用户的全部文档（HTTP 200）。留空是安全的：后端见到空令牌会完全忽略
那两个头，后果只是图片记账不生效。

三处必须一致，不一致的表现是**图片记账静默失败**（用量统计不到，配额形同虚设）：

| 位置 | 用途 |
| --- | --- |
| `.env` | 后端读，也给 docker-compose |
| `.dev.vars` | 本地 `wrangler dev` |
| `wrangler secret put BACKEND_INTERNAL_TOKEN` | 生产的 Worker |

### 限流

| 端点 | 维度 | 阈值 |
| --- | --- | --- |
| 登录 | IP | 10 次 / 15 分钟 |
| 登录 | 账号 | 100 次 / 15 分钟 |
| 注册 | IP | 5 次 / 小时 |
| 分享口令校验 | IP | 20 次 / 15 分钟 |
| 分享口令校验 | 链接 | 10 次 / 15 分钟 |

两处刻意的设计，都容易做反：

**账号维度的阈值远高于 IP 维度**（100 对 10）。任何人都能对着别人的账号发失败
请求，所以账号维度要是收得和 IP 一样紧，攻击者用 10 个请求就能把任意用户锁在门外
15 分钟 —— 那是自己造出来的拒绝服务，比它挡住的撞库更容易被利用。它只做兜底，
挡分布式撞库（很多 IP 各试几次，永远碰不到 IP 阈值）。

**限流排在参数校验之后**，只对「格式合法、真的在试一组凭证」的请求计数。放在最
前面的话，用户在注册页手滑五次（密码太短、邮箱漏了 `@`）就被锁一小时，而他一个号
都没注册成功。挡刷号的效果不受影响：批量注册必须发合法请求，而合法请求全都计数。

限流器是**进程内**的（`ratelimit.go`）。多实例部署时各进程独立计数，实际阈值被
放大 N 倍 —— 上多实例前要换成 Redis。

### 安全响应头

由 Worker 在唯一出口统一加（`worker/securityHeaders.ts`）：CSP、HSTS、
`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy`、
`Cross-Origin-Opener-Policy`、`X-Content-Type-Options`。

包在入口而不是各分支里加：Worker 有 7 条返回路径，逐个加迟早漏一条，
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

## 分享

两档权限：

| 档位 | 含义 |
|---|---|
| `link` | 知道链接即可访问，token 随机 32 位十六进制不可枚举 |
| `password` | 访问者需输入口令（bcrypt 存哈希，至少 6 字符） |

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
```

前端页面在 `/share/$token`，无需登录，只读视图复用编辑器的同一套扩展，
所以代码高亮、公式、图片的呈现与编辑时一致。

几处刻意的语义取舍：

- **重复调用 POST 默认复用同一 token** —— 已发出的链接不会因为改权限就失效
- **但放宽权限时必须换 token**（见下）
- **撤销后重新开启会换新 token** —— 老链接永久失效，这是撤销的意义所在
- **已撤销与从未存在返回同一响应** —— 不泄露某个链接曾经有效
- **口令档下 GET 只回 `requiresPassword` 标志** —— 正文一个字都不经过未验证的响应
- **公开视图只输出 title / content / updatedAt / ownerName** —— 内部 id、user_id、doc_id、share_token 一律不外泄

### 放宽权限必须换 token

判定见 `shouldRotateShareToken`。规则不对称，因为风险不对称：

| 改动 | token | 理由 |
|---|---|---|
| 收紧（`link` → `password`） | 复用 | 老链接只会变得更严，安全性只增不减 |
| 改口令（`password` → `password`） | 复用 | 权限档未变 |
| **放宽（`password` → `link`）** | **换新** | 见下 |

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

> ⚠ **限流器是进程内存实现**（`go.mod` 尚无 Redis 客户端）。
> 多实例部署时各进程独立计数，实际阈值被放大 N 倍。上多实例前必须换成 Redis。

## 导出

四种格式，全部在浏览器端完成，不占后端资源：

| 格式 | 实现 |
|---|---|
| `.md` | 直接取 `storage.markdown.getMarkdown()`，内容本就是 Markdown |
| `.html` | 自包含单文件，样式内联，KaTeX 的 CSS 引 CDN，公式在生成时渲染 |
| `.docx` | `docx` 库，走 ProseMirror 文档树构建 |
| `.pdf` | html2canvas-pro 栅格化 + jsPDF 分页，一键下载 |
| 微信公众号 | 主题样式内联 + 公式转图，写进剪贴板 |
| 打印 / 另存为 PDF | 浏览器原生打印管道 + `@media print` |

**PDF 为什么是两条路**：浏览器里能产出矢量文字 PDF 的引擎只挂在打印管道上，
而打印对话框无法绕过。所以「一键下载」与「文字可选可搜」在纯前端不能同时成立，
两条路各保留一条：

| | 一键下载 | 文字可选可搜 | 体积 |
|---|---|---|---|
| `.pdf`（栅格） | 是 | 否，文字是位图 | 约 650 KB/页 |
| 打印 / 另存为 PDF | 否，需在对话框选 | 是，矢量 | 小得多 |

那个对话框与打印机无关：Chrome 选「另存为 PDF」时走的是 Skia 的 PDF 后端，
不碰任何打印机驱动，未装打印机也能用。CSS 规范里这套东西叫 *paged media*，
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

| 微信的行为 | 因此必须 |
|---|---|
| 剥掉 `<style>` 与外链 CSS | 样式只能进每个元素的 `style` 属性 |
| 剥掉 `class` / `id` | 选择器只能是标签名 |
| 剥掉 `<script>` 等 | 直接删掉整个子树 |
| 粘贴时抓取外部图片转存 | 公式图片走 R2 真实 URL |

**主题直接以「标签 → 声明串」存**（`wechatThemes.ts`），不存 CSS 文本。既然最终
只能按标签查表，就省掉 keepask 那道从 markdown 正则抽 CSS 的环节。代价是失去
CSS 的表达力，但那部分表达力在内联方案下本来就用不上——keepask 的主题里有
`h2:before{content:""}` 这类装饰条，**内联时会被静默丢掉，在微信里根本不出现**。
所以这里的五个主题都不依赖伪元素。唯一保留的后代选择器是 `pre code`（代码块内的
`code` 与行内 `code` 视觉不同）。

**公式必须转成图片。** KaTeX 的产物是几百个带 class 的 `<span>` 靠 `position`
拼出来的排版，class 被剥掉后剩一堆错位的散字，比不显示更糟。流程是
KaTeX → html2canvas（3 倍，公式字号小，低于 3 倍在手机上发虚）→ 上传 R2 →
`<img>`。选 R2 而非 base64 data URL：微信抓取外链是你文档里普通图片已经验证过的
行为，而 data URL 是否被接受无法确认。

两处刻意的顺序，反了就出错：

1. **先转公式图，再内联样式。** 反过来新插入的 `<img>` 拿不到主题的 `img` 规则。
2. **公式图的宽高排在主题规则之后。** 主题的 `img` 规则里有 `height:auto`，
   顺序反了会把公式压扁。这条靠 `data-wechat-keep-style` 传递，有专门的断言守着。

**公式图会按 LaTeX 源码缓存。** 不缓存的话每次导出都重新栅格化并重新上传 ——
实测切几次主题就能在 R2 里堆出 22 份同样的图，而且现在没有 images 表，这些对象
无法列举也无法清理。缓存只在当前页面存活期内有效；跨会话去重要等 images 表落地后
由服务端按内容哈希查重。

**已知降级**：代码块的语法高亮无法保留（class 被剥），只剩等宽字体与底色。
对话框里明写了这条，不让用户以为是 bug。公式转换失败时降级成 LaTeX 源码并提示
数量——静默降级的话用户会以为公式本来就长那样。

## 代码高亮与 LaTeX

**代码高亮**：lowlight（highlight.js）的 common 集，约 37 种主流语言。
打三个反引号加语言名即可，如 ```` ```go ````。配色见 `globals.css` 的 GitHub Dark 精简版。

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

### 图片走 CDN（IMAGE_PUBLIC_BASE）

留空时图片经 Worker 代理读取，**每次加载消耗一次 Worker 请求**。配上 R2 自定义
域名后 `publicURL` 直接返回绝对地址，走 CDN，不再计入 Worker 请求数。

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

**配完必须用自查端点确认，不要只看图片能不能显示：**

```bash
curl https://你的域名/api/images/config
# {"mode":"cdn","base":"https://img.你的域名","valid":true,"warning":null}
```

自查端点存在的理由：配错时系统**回落到 Worker 代理，图片照样显示**，所以
「图片能看」证明不了 CDN 生效了。没有这个端点，只能等月底看账单上多出的请求数。
`mode` 不是 `cdn` 就说明没生效，`warning` 会说明原因。

`normalizeImageBase`（`worker/images.ts`）的校验：必须带 scheme、只收 http(s)、
拒绝带查询串或 fragment、去掉末尾斜杠、保留子路径（R2 自定义域名允许挂子路径）。
配错不抛错而是回落 —— 抛错会让上传直接失败，那是更坏的结果。

> 关于 workerd 的一个猜想被实测否定了，记在这里免得后人重走：曾以为 workerd 的
> `URL` 会把无 scheme 的输入静默补成 `https://`（那样只靠 try/catch 校验就会在
> 线上失效）。实际探针结果是 workerd 与 Node 一致，三种无 scheme 写法都抛
> `TypeError`。代码里那条 scheme 正则因此是冗余的，保留只为让约束显式可读。

## 验证

一条命令跑完前端与 Worker 的全部检查（两端 typecheck + 25 个断言套件）：

```bash
npm test          # typecheck × 2 + 25 个套件，失败即停
npm run go:test   # go vet + go test（后端）
```

两者由 GitHub Actions 在每次 push 与 PR 上跑（`.github/workflows/ci.yml`），
另有一个 job 检查密钥卫生：`.env*` / `.dev.vars` 没被提交、源码里没有硬编码密钥。

> 各套件脚本末尾是 `; ec=$?; rm -f ...; exit $ec` 而不是 `; rm -f ...`。
> 后者会让 npm 读到 `rm` 的退出码（永远 0）—— 测试失败也报成功，CI 接上去
> 等于没接。这个坑实测过：改坏一处源码，套件明明打印「1 失败」，
> `npm run` 的退出码仍是 0。

后端：`cd backend && go test ./...`（CI 里带 `-race`）。

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

`verify_export_formats.py` 覆盖四种格式，重点是公式在每种格式里是否真的落地。

两个脚本都需要后端与数据库在跑，且会在数据库里留下一个 `pdfprobe` 测试账号。

## 构建与部署

```bash
npm run build     # vite build → spa/dist
npm run deploy    # 构建并 wrangler deploy（需先配 wrangler 与 secrets）
```

后端：`cd backend && docker build -t koinote-backend .`，部署到 VPS，
Worker 的 `BACKEND_URL` secret 指向后端公网地址。
