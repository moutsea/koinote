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

## 分享

三档权限，参考 keepask 的分享模型落地：

| 档位 | 含义 |
|---|---|
| `link` | 知道链接即可访问，token 随机 32 位十六进制不可枚举 |
| `public` | 同上，语义上允许公开传播 |
| `password` | 访问者需输入口令（bcrypt 存哈希，至少 6 字符） |

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

- **重复调用 POST 复用同一 token，只改权限** —— 已发出的链接不会因为改权限就失效
- **撤销后重新开启会换新 token** —— 老链接永久失效，这是撤销的意义所在
- **已撤销与从未存在返回同一响应** —— 不泄露某个链接曾经有效
- **口令档下 GET 只回 `requiresPassword` 标志** —— 正文一个字都不经过未验证的响应
- **公开视图只输出 title / content / updatedAt / ownerName** —— 内部 id、user_id、doc_id、share_token 一律不外泄

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

`IMAGE_PUBLIC_BASE` 留空时图片经 Worker 代理读取，每次加载消耗一次 Worker 请求。
在 Cloudflare 后台给 bucket 绑定自定义域名后填上它（如 `https://img.你的域名`），
图片改走 CDN，不再计入 Worker 请求数。

## 验证

后端：`cd backend && go test ./...`（含 `-race`）。

前端导出这块没有单元测试框架，改用**真浏览器端到端验证** —— 协议层的 curl
验不了「点了导出按钮之后浏览器到底下载了什么」。两个脚本走完整链路：登录、
写入含公式/代码/表格的内容、点菜单、抓下载文件、解析产物。

```bash
pip install playwright pypdf pillow && playwright install chromium

# 建议对着生产构建物跑（npm run build && npx vite preview）
PROBE_BASE=http://localhost:5274 python3 scripts/verify_pdf_export.py
PROBE_BASE=http://localhost:5274 python3 scripts/verify_export_formats.py
```

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
