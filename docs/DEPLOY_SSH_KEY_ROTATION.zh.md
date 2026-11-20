# GitHub 部署 SSH 密钥轮换记录

日期：2026-11-20。范围为 `moutsea/koinote` 的 `VPS_SSH_KEY` 和
生产主服务器的部署公钥授权。目标地址仅保存在受保护的运维配置和 `VPS_HOST` Secret 中。

## 基线与根因

旧部署钥的公开指纹为 `SHA256:rCkzzQLmQie54lPlrE+WHpxbb8bbslUh9md0TBH518M`。
它与本机个人管理钥不同，且原已不在目标机当前授权列表中。
[替换前的真实 Actions 校验](https://github.com/moutsea/koinote/actions/runs/44699769249)
确认目标地址匹配，但 SSH 返回 `Permission denied (publickey)`。
本轮没有发现私钥泄露的证据，也没有将授权缺失推断为泄露。

## 实际改动与共用链路

- 生成专用于本仓库部署的 Ed25519 密钥，将公钥以 `restrict` 选项加入 VPS 授权列表。
- 通过 stdin 更新 GitHub Repository Secret `VPS_SSH_KEY`，没有在源码、命令参数或日志中
  写入私钥。新公开指纹为 `SHA256:7rmIl9EIKM/fm/1+OYnhuAlFUhgZI8EnvWtZhZUaXho`。
- 新钥通过 Actions 校验后，本机生成的部署私钥临时副本已删除，由 GitHub Secret 持久保管。
- Deploy、WeChat Diagnostics、Sync System Repositories 和 Discover System Repositories
  共用此 Secret，后续任务自动使用新钥。服务器地址与 known_hosts 配置未变更。
- 新增 `verify-vps-ssh.yml` 手动工作流，核对固定主机公钥及部署钥公开指纹，再验证 SSH 与后端健康；
  当前版本从 Secret 读取预期公开指纹，不接收明文地址输入或输出主机名，临时私钥由退出清理处理。
- 个人管理钥及其授权保留。此前为避免管理通道中断而临时增加的管理钥和 SSH 配置，
  在确认部署钥与管理钥不同后已全部撤回；其他服务器与 GitHub 账号 SSH Key 未改动。

## 已实际验证

- 新钥在本机实际连接目标 VPS 成功，后端健康检查返回 200。
- 使用新部署钥的真实 `rsync --dry-run` 通过，没有写入远端测试文件。
- [替换后的 Actions 校验](https://github.com/moutsea/koinote/actions/runs/44700184801)
  成功：目标地址匹配、新公开指纹匹配、主机名正确、SSH 成功、后端健康检查通过。
- 原个人管理钥仍能正常登录，当前服务器授权列表包含原管理公钥及新部署公钥。
- 新工作流 YAML/actionlint 检查通过。Actions 日志检查确认 SSH 环境值被遮蔽，
  私钥原文及每一行私钥载荷均未出现。

本轮检查使用真实 VPS 与 GitHub Actions，没有模拟 SSH 或健康检查。
验证了 SSH 和传输能力，没有重新发布或重启业务服务，也没有逐一执行会改变业务数据的
仓库同步、发现和诊断任务。旧部署钥在更换前已被目标机拒绝，并非本次删除了个人管理授权。

## 后续轮换

先加入新公钥并验证登录，再通过 stdin 更新 Secret，最后运行手动工作流：

```bash
gh secret set VPS_DEPLOY_KEY_FINGERPRINT --repo moutsea/koinote
gh workflow run verify-vps-ssh.yml --repo moutsea/koinote --ref main
```

确认实际工作流通过后，撤销属于旧部署钥的授权，并清理临时私钥；不能凭钥匙名称推断
它与个人管理钥相同。`VPS_HOST_KEY` 是服务器身份校验配置，不是本次轮换的登录私钥。
