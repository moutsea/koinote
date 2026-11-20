# 发布流程安全修复

日期：2026-11-21。范围为 Koinote 发布、SSH 验证及仓库内中继部署模板。

## 发布来源与生产 Secret

根因：CI 同时接受 push 和 PR，而 Deploy 原先只判断 CI 成功、分支名为 main，
随后检出触发提交。`workflow_run` 能取得生产 Secret，因此外部 PR 不能作为可信发布来源。

实际修复：job 在 checkout、依赖安装和任何生产 Secret 注入前检查官方仓库、
事件类型、成功结果、来源仓库、main 分支和提交 SHA。只有本仓库 main 的成功 push，
且提交等于触发发布时的默认分支 SHA，才允许继续。旧 CI 不会覆盖新的安全修复；
回滚应通过新的 main 回滚提交及 CI 完成，而非重跑旧提交的部署。
GITHUB_TOKEN 权限限制为 contents:read，checkout 不把认证信息保留在工作区。

门禁的第一阶段修复已单独推送为 `372621b`，之后再补齐日志边界和永久回归。
最终整合保留了期间合入的 `dda3522`：敏感端点改从 Secret 读取，
SSH 公钥预期指纹从 Secret 读取，多个运维步骤通过私有 shell 屏蔽原始输出。
本次在此基础上保留服务器构建故障日志、校验来源 SHA 并接入回归检查。

## 失败日志与凭据传输

根因：健康检查失败时会直接转印后端和备份容器日志；Stripe 商品检查也会公开
第三方错误消息。运行时凭据不一定登记在当前 GitHub job 的 Secret 中，不能只依赖自动打码。

实际修复与上下游：

- Stripe 认证经 stdin 传给 curl，不进入进程参数。响应和传输错误只写权限受限的
  临时目录，退出时清理；公开输出只包含固定商品类别、HTTP 状态和下一步排查方式。
- 后端与备份的健康状态只接受固定状态集合，异常输出不会被拼回错误文案；
  容器原始日志留在服务器，不再转印到 Actions。
- 后端、备份构建经 `deploy/run-private-command.sh` 执行。失败详情保存在服务器
  `/var/log/koinote-deploy`（0700）下，文件权限为 0600，保留原退出码；成功输出不公开且临时文件清理。
  此脚本由既有 deploy 目录 rsync 同步，先于远端构建执行。
- SSH 验证失败只公开固定错误，不输出连接诊断、主机名或原始服务日志。
- 已合入的私有 shell 继续屏蔽相关步骤的全部输出；服务器上的构建故障详情仍可由管理员排查。

管理员排查构建失败时，应通过受保护的 SSH 通道在服务器查看该目录，
不要把日志上传为公开仓库的 Actions artifact 或直接贴入 issue。

## 地址配置与中继模板

根因：SSH 验证输入默认值、运维记录、SSH 隧道和证书 hook 包含真实部署地址。

实际修复：移除这些地址及主机名；SSH 地址只从 VPS_HOST Secret 读取，
固定 known_hosts 仍验证目标主机身份。手动验证不再接收 expected_host 输入。

中继模板沿用已合入的私有配置：SSH 目标来自 root-only 的
`/etc/koinote/wechat-relay/tunnel.env`，证书 lineage 从
`/etc/koinote/wechat-relay/cert-lineage` 读取（缺省为不含地址的固定证书名）。
Certbot hook 仅处理匹配的证书；配置按数据读取，不作为 shell 执行。
安装新的 unit 或 hook 前必须先配置私有文件，详见中继 README。

## 验证与限制

- `python3 scripts/check_deployment_security.py`：执行实际 workflow shell 的故障回归；
  SSH、Stripe 为本机测试替身。覆盖可信/不可信事件、敏感错误输出、状态污染、清理与日志权限。
  此检查已接入 Linux CI，也可用 `npm run test:deployment-security` 单独运行。
- `GO111MODULE=off go test -race ./deploy/wechat-proxy`：原代理回归通过。
- 在真实 Linux 主服务器的隔离临时目录中执行同一私有日志脚本，确认原退出码、
  受保护诊断内容、0700/0600 权限；通过 systemd-analyze verify 校验新 unit。
  只执行无凭据的测试命令，没有重建业务容器；后端健康接口仍为 200。

没有执行完整 GitHub Actions 发布或实际构建，不将故障替身验证视为生产发布验收。
中继模板只更新了源码，未安装到停机中继、未启动中继或执行真实证书续期。
本次没有修改其他 AI 的 runner 草稿、KeepAsk 业务工作区或进行跨项目密钥轮换。

删除当前文件中的地址不等于删除历史信息：旧提交、旧日志或缓存仍可能保留地址，
本次未重写 Git 历史。源站访问控制和 SSH 公钥认证仍是必要边界。
本次未发现这些来源风险已被利用的证据，也不把未发现日志明文当作绝无泄露的证明。
