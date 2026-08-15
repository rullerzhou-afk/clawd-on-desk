# 远程 SSH 操作指南

远程 SSH 部署唯一受支持的入口是 Clawd 应用内的 **Settings -> 远程 SSH**。
`scripts/remote-deploy.sh` 已明确停用：独立 shell 脚本无法创建 profile 专属
本地入口、安装身份、可恢复部署事务和带所有权校验的清理流程。

## 前提条件

- 本地 Clawd 正在运行
- 本机能通过系统 `ssh` 连接远端
- 远端已安装 Node.js
- 远端已安装至少一个支持的 agent：Claude Code、Codex CLI 或 Copilot CLI

Clawd 不保存 SSH 密码或私钥口令。首次 host key 确认、passphrase、ssh-agent
加载都交给系统 `ssh` 和系统终端处理。

## 应用内流程

1. 打开 **Settings -> 远程 SSH**。
2. 点击 **新增配置**，填写：
   - **主机**：`user@remote-host`，也可以填你在 `~/.ssh/config` 里配置好的 Host alias
   - **SSH 端口**：默认 `22`
   - **私钥文件**：可选，留空则使用 ssh-agent 或 `~/.ssh/config`
   - **SSH transport 兼容性**：普通主机和 GitHub Codespaces 保持 **自动**。只有其他无法容忍重叠 SSH session 的 ProxyCommand transport 才使用 **强制单 SSH session**
   - **远端转发端口**：默认 `23333`；同一台远端有多个 profile 时才需要换到 `23334-23337`
   - **主机前缀**：可选，用于 Sessions / Dashboard 里区分远端来源
3. 如果 SSH 需要首次确认 host key、输入 passphrase 或加载 ssh-agent，点 **首次认证**。Clawd 会打开系统终端运行一次普通 `ssh`。
4. 点击 **部署 / 修复 Hook**，然后连接 profile。
   - Clawd 会为该 profile 创建专属本地入口，并维护指向它的 `ssh -R` 反向隧道
   - Clawd 会原子写入 profile 身份，把 hook 和 Claude 静态权限 URL pin 到精确远端端口；隧道不会接触通用 `/state`、`/permission` 入口
   - 然后从当前已安装的 Clawd 应用复制 hook 文件到解析出的远端 runtime layout
   - 接着在远端已安装对应 agent 时，以远程模式注册 Claude Code hooks、Codex official hooks 和 Copilot CLI hooks
   - 配置下方会展示连接 / 部署日志
5. 在远端终端里启动 Claude Code、Codex CLI 或 Copilot CLI。Dashboard 会在第一条远端 hook 事件到达后显示 session。

全新本机安装下，如果只是接收远程 Copilot CLI 事件，请到 **Settings -> Agents**
打开 **Copilot CLI**，这样 Clawd 才会接收远程 hook 事件；不需要点
**Install / 安装**，除非你也想在本机安装 Copilot hooks。

如果配置里开启了 **连接时自动启动 Codex 兜底监控**，Clawd 会把
`~/.claude/hooks/codex-remote-monitor.js` 作为连接维护启动。在 serialized transport
上，这项一次性维护会先完成并关闭，随后才启动持久反向隧道；自动重连不会重复执行
monitor mutation。Codex official hooks 正常可用时不依赖这个兜底监控。

### GitHub Codespaces 与单会话 transport

Clawd 会在连接前用 `ssh -G` 检查本机实际生效的 SSH 配置。`ProxyCommand` 精确使用
`gh cs ssh ... --stdio` 或 `gh codespace ssh ... --stdio` 时会自动进入 serialized
模式。同一 Codespace 上，Clawd 自己管理的 SSH/SCP 不会重叠：Node 探测和 monitor
维护先完成并关闭，连接就绪检查则放在唯一的持久 `ssh -R` session 里。

执行 **部署 / 修复 Hook**、断开、清理或身份 / runtime 变更时，Clawd 会通过 stdin
EOF 请求持久 readiness 进程自然退出，并在开始下一条 SSH 操作前等待外层 child
`close`。如果无法证明 transport 已排空，Clawd 会停止并显示恢复错误，不会自动重放
结果未知的远端 mutation。同一 Codespace 的第二个 profile，以及交互式的 **首次认证 /
打开终端**，都会在 managed transport 完全空闲前保持阻止状态。

显式单会话 override 是按有效目标生效的保守兼容开关，只能在未连接时修改。普通 SSH
目标继续使用既有的可并行行为。

## 关键概念

Doctor 里显示的本地服务 `127.0.0.1:<端口>` 是正常的：它是你这台电脑上的
Clawd HTTP 服务，不是远端集群的 IP。远端 hook 也不直接访问你的局域网 IP。

实际链路是：

```
远端 Claude/Codex/Copilot hook
  -> POST http://127.0.0.1:<远端转发端口>
  -> SSH 反向隧道
  -> profile 专属本地入口（校验 routing nonce）
  -> 本机 Clawd 状态 / 权限处理（profile canonical session ID）
  -> Dashboard / Session HUD / 桌宠状态
```

所以“已连接”只说明隧道通了。远端 session 要出现在 Dashboard 里，还必须满足：

- 远端 hooks 已部署成功
- 远端 agent 已启动并产生至少一条 hook 事件
- Codex 如需 `/hooks` review，已经在远端 Codex TUI 里 review 通过
- 全新本机安装下，如果只接收远程 Copilot CLI，本机 **Settings -> Agents -> Copilot CLI** 已打开

## 共享服务器隔离与升级边界

每个已连接 profile 都有独立的本地入口和 routing nonce。安全版远端 hook 只打
一个 pin 住的端口，不再扫描 `23333-23337`；接收端在状态或权限数据进入 Clawd
前再次校验 nonce。内部 session key 也包含 profile，所以相同 raw session id
不会互相覆盖。

对于**同一服务器、不同 Unix 账号**，所有参与者都升级并成功执行一次
**部署 / 修复 Hook** 后，跨用户串台才真正消失。只升级 app 不够：旧远端 hook
仍可能扫描到仍在运行的旧接收入口。迁移期间宁可丢事件，也不会把事件交给错误桌面。

默认 `account-default` 模式不支持两个 profile 共用同一个 Unix 账号。检测到所有权
冲突、无属主旧部署或远端本地 Clawd 正在使用账号默认配置时，Clawd 会在写入前阻止。
无属主旧痕迹始终要求显式确认；本机“以前部署过”的时间戳不能证明远端所有权。

实验性的 `profile-isolated` runtime 只在验证构建中可用，必须显式设置
`CLAWD_ENABLE_EXPERIMENTAL_REMOTE_ISOLATION=1` 才显示。它为每个 profile 分开
Claude/Codex/Copilot 用户配置、sessions、Clawd 文件和启动 wrapper；真实 SSH/CLI
矩阵通过前，不作为已支持的共享账号隔离发布。它不会虚拟化整个 `HOME`：同一 Unix
UID 仍可读取所有 profile，project 配置和部分 cache 仍共享，macOS 上 Claude
subscription auth 仍通过 Keychain 共享。只有用界面显示的专属 wrapper 启动的
session 才在承诺范围内；裸 `claude`、`codex`、`copilot` 仍走账号默认目录。

## Doctor 与远端的边界

Doctor 的 **Agent 集成**检查只诊断本机配置，例如本机
`~/.claude/settings.json` 里的 hook path。它不会 SSH 到远端检查远端
`~/.claude/settings.json`、`~/.codex/hooks.json` 或
`~/.copilot/hooks/hooks.json`。

因此，本机 Claude Code 显示 `broken path` 只代表本机 Claude hook 路径异常，
不等于远端 SSH 部署失败。远端状态请看 Remote SSH profile 里的 **Hook 状态**
和部署进度日志。Doctor 还会显示被拒绝的 Remote SSH 入口事件、未激活 wrapper
和中断的 runtime-mode 事务，并明确实验隔离边界；这些本机检查仍不等于真实远端
CLI 已验证。

## 常见问题

### Dashboard 中没有远端 session

先看 Remote SSH profile：

- 如果 Hook 状态是“从未部署”，点 **部署 / 修复 Hook**
- 如果状态是“已连接”但 Dashboard 仍为空，在远端 agent 里发送一条消息触发 hook
- 如果是 Codex，远端 Codex 可能还需要执行 `/hooks` review

### 远端端口冲突

一条已经健康连接的隧道断开后，上一条远端 SSH session 可能还在释放监听端口。
Clawd 会保留原端口，按退避节奏最多重试四次（目前总计约三分钟）。界面显示
**重连中**时，不需要立刻修改 profile。

如果这是首次连接，或有限恢复结束后端口仍不可用，冲突可能是长期存在的。可以稍后
再试，或从 `23333-23337` 中选择一个未占用的 **远端转发端口**。一旦改了端口，
必须先执行 **部署 / 修复 Hook**，再点 **连接**：安全身份、hook 目标、权限 URL
和健康检查都 pin 在一个精确端口上。当前目标重新部署前，Clawd 会阻止普通连接。

历史部署记录只用于所有权清理，不代表还有一个可直接恢复的 active 端口槽。
即使把端口从 `23333 → 23334 → 23333` 改回去，也必须为当前目标重新部署；Clawd
不会自动复活历史 routing 身份。安全边界来自 pin 住的身份和专属入口，不来自端口保密。

### 远端没有 Node.js

部署会在 `check-node` 步骤失败。先在远端安装 Node.js，再重新部署。

### 可以手动开 SSH 隧道吗？

安全版 Remote SSH 不支持这样做。本地目标是临时的 profile 专属入口，不是 Clawd
通用 HTTP 端口。请使用 profile 的 **连接**，让 Clawd 一起创建和销毁入口与隧道。
手写 `ssh -R ...:23333` 指向通用服务端口不会建立 profile 绑定；携带安全 nonce
的请求到达那里会直接收到 404。
