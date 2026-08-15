# 更新日志

这里记录 Koinote 中值得用户关注的变化。项目遵循
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 新增 Tauri 2 macOS / Windows 客户端 alpha：系统浏览器 PKCE 登录、系统钥匙串令牌、
  SQLite 本地优先文档、后台同步与显式冲突恢复。
- 官网新增桌面客户端下载入口，GitHub Release 同时提供 macOS Apple 芯片、Intel 与 Windows x64 安装包。
- 网页编辑器与桌面客户端新增前台远端更新检测：无本地改动时自动更新，同时编辑时保留双方内容并提示处理冲突。

### Changed

- 编辑器文档侧栏现在直接提供 Markdown 导入入口；空文档页同时提供“导入文件”和“导入文件夹”。
- macOS 26 改用原生 Icon Composer 图标资源，旧版 macOS 与 Windows 继续使用原有回退图标。

### Fixed

- 修复 Word 与 PDF 导出直接跨域读取站内图床时被浏览器 CORS 拦截、有效图片变成失败占位文字的问题。
- 修复客户端管理后台与 MCP 令牌请求被桌面 Bearer 白名单拒绝的问题，在主导航补回“文档”和“价格”，
  并将仅网页允许的账号安全与永久删除操作转到系统浏览器处理，避免点击后返回 403。

## [0.5.0] - 2026-08-15

### Added

- 新增标题与正文全局搜索，支持 `⌘K` / `Ctrl+K`、结果高亮和 MCP 搜索摘要。
- 支持 Markdown、文件夹和 ZIP 导入，并可完整导出文档、目录与图片后再次导入。
- 分享页新增 OpenGraph 卡片、阅读次数和“复制到我的 Koinote”。
- 新增密码找回、修改密码、会话失效和移动端文档抽屉。
- 上线 MCP、版本历史、定价和更新日志公开页面。

### Changed

- MCP 令牌支持永久有效和修改有效期，接入文档覆盖 Codex、Claude Code、OpenCode、OpenClaw、WorkBuddy 等客户端。
- 自媒体导出扩展到微信公众号、知乎和掘金；会员可通过版本历史、回收站和 Agent 安全快照恢复内容。
- 管理后台新增隐私友好的产品漏斗与 D1/D7/D30 留存统计。

### Fixed

- 修复分享标题或摘要包含 `$` 时 OpenGraph 页面结构可能损坏的问题。

## [0.4.0] - 2026-08-13

### Added

- 终生会员可通过带权限范围的 MCP 客户端读写文档，并使用 revision 检测冲突。
- 新增版本历史、恢复快照、回收站与还原流程，保护网页和 Agent 写入。
- Stripe 会员付款可发送持久化、保护隐私的飞书通知。
- “我的文档”和“邀请好友”拆分为独立账户页面。

### Fixed

- 掘金导出补上标题，微信公众号导出保留图注和代码块窗口装饰。
- 历史版本会保护引用图片，上传与文档写入并发时配额仍保持准确。
- Cloudflare Analytics 改用免费套餐可用的数据集。

## [0.3.0] - 2026-08-12

### Added

- 新增多币种 Stripe Checkout：终生会员一次付费获得 10 GB 存储空间。
- 邀请双方各得 500 MB，每个账户的邀请奖励上限为 5 GB。
- 新增存储用量、会员升级入口与管理员统计后台。
- 可选接入 Cloudflare Analytics，查看边缘 UV、PV、请求数和流量。

### Changed

- 存储配额会综合会员等级与邀请奖励计算。
- 微信公式临时图片使用独立限额和内容寻址复用。

### Security

- 支付发放会校验价格、币种、商品、用户和 `metadata.service=koinote`。
- 加固 OAuth 跳转、邀请奖励、内部令牌与 Checkout 创建流程。

## [0.2.0] - 2026-08-11

### Added

- 新增邮箱验证码注册与 Cloudflare Email Sending 发信。
- 新增包含后端和 Worker 健康检查的自动部署。
- 新增按用户统计的图片存储账本与配额。

### Fixed

- 图片回收会复查实时引用，删除后返还配额，短暂加载失败也可自动恢复。
- 账户创建失败时不再消耗验证码。

### Security

- 验证码使用 HMAC 存储和事务消费，并加入限流与请求体大小限制。

## [0.1.0] - 2026-08-10

### Added

- 首个开源版本，采用 React、TipTap、Go、PostgreSQL 与 Cloudflare Worker。
- 支持所见即所得 Markdown、文件夹、标签页、自动保存、代码高亮、表格、任务列表和 KaTeX。
- 支持 R2 图床、受保护分享，以及 Markdown、HTML、DOCX、PDF、打印和微信公众号导出。
- 提供中文、英文、日文、法文界面，并支持密码、Google 与 GitHub 登录。
