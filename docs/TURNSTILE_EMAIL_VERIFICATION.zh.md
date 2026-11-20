# 邮箱验证码 Turnstile 接入与验证记录

## 当前状态

已部署生产，业务提交为 `f4b94d0b41d032d404665f351c05fcfc9af2e768`。
[完整 CI](https://github.com/moutsea/koinote/actions/runs/44679724775) 与
[自动部署](https://github.com/moutsea/koinote/actions/runs/44681891230) 均成功。
配对 Key 已安全写入 GitHub 发布配置并同步到后端，Secret 未下发到浏览器。
真实人类挑战、有效 token 的首次提交与重放、邮件收取仍待人工验收。

## 原因与实际改动

原有匿名发码接口只检查邮箱格式、发送频率和验证码规则，没有验证请求是否来自人类。
此次在 Go 后端共用 `requireEmailHumanVerification`，将校验放在验证码生成、数据库事务
和发信之前。校验通过后继续使用原有验证码 HMAC、发送限流和邮件服务。

注册与历史未验证账号补验共用 `email_verification` 用途，找回密码使用
`password_reset`。后端直接访问官方 Siteverify，并同时检查 `success`、`hostname`
及 `action`。生产必须配置两项 Key，服务不可用或配置缺失时拒绝发码。

登录页只在上述三个发码场景加载验证组件；验证过期、失败、切换用途或请求完成后
清除旧 token，重发需要新 token。普通密码登录与 OAuth 的原有入口不要求验证。
组件包含中、英、法、日文状态提示与重试入口，并适配 320px 页面宽度。

公开配置接口只提供 Sitekey 和是否启用验证。Secret 由后端环境读取；Compose 与
部署 workflow 已接好环境变量，GitHub 分别使用 Variable `TURNSTILE_SITE_KEY`
及 Secret `TURNSTILE_SECRET_KEY`。Worker 的 CSP 仅追加官方挑战脚本与 iframe 域名。
部署顺序为：配置 Key → 后端 → SPA 与 Worker。

## 已实际验证

- 隔离 PostgreSQL：相关 Go 测试开启 race 检查，12 个顶层测试、含子测试共 41 项通过，
  0 失败、0 跳过。覆盖注册、补验、找回密码、原有限流及重放 token 不能重复记入发送账本。
- 独立 Chromium：真实 `LoginPage` DOM 检查通过，覆盖缺失、过期、卸载后旧回调、
  请求成功与失败后的重置、配置失败重试、开发环境重发及 320px 布局。
- SPA/Worker 类型检查、生产构建、Go vet、CSP 39 项、i18n 795 项、账号页 57 项、
  现有密码安全页面检查及部署 YAML/actionlint/密钥流顺序检查通过。

## 模拟与剩余验收

上述数据库测试使用真实隔离数据库；Turnstile Siteverify 响应使用模拟传输。
页面测试使用模拟 Turnstile 组件与发码接口，未解真实挑战、未发送真实邮件。
已有邮件服务测试覆盖邮件请求协议，但不代表生产收件箱已收到本次验证码。

收到配对 Key 后，Secret 有效性探针返回 `invalid-input-response`，没有
`invalid-input-secret`；探针只证明 Secret 被接受，不证明挑战或发信成功。
仍需确认组件允许 `koinote.app`，并验证实际
Cloudflare 挑战、正确用途与域名的首次提交、重复 token 拒绝，以及生产邮件收取。
真实环境验收结果应另行记录，不能把模拟服务响应记作生产成功。

## 本轮生产检查

- `GET /api/auth/turnstile` 返回 200、`required: true`、与配置一致的 Sitekey，
  无 Secret 或其他额外字段，并带 `Cache-Control: no-store`。
- 注册/补验发码、找回密码发码两个入口分别验证：缺 token 返回
  400/`human_verification_required`，无效 token 返回 403/`human_verification_failed`。
  无效 token 经过真实 Go 后端和 Cloudflare Siteverify，未使用模拟响应。
- 登录页实际返回 200，线上 CSP 包含官方脚本与 iframe 域名，未开放内联或 eval 脚本。
  独立 Chromium 中已观察到正常显示的 Cloudflare 真人验证复选框。
- 自动浏览器未完成真人挑战，没有提交有效生产 token，也没有发送真实邮件。
  生产有效 token 的首次提交、重放拒绝和邮件收取不列为通过项；需在登录页手动试发。

本地未配置两项 Key 时保留原有开发发码流程；配置任一项即启用必需验证。
生产始终要求验证，即使两项 Key 均被误删也不会绕过。
