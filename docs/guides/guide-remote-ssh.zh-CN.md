# 远程 SSH 操作指南

远程 SSH 部署唯一受支持的入口是 Clawd 应用内的 **Settings -> 远程 SSH**。
`scripts/remote-deploy.sh` 已明确停用：独立 shell 脚本无法创建 profile 专属
本地入口、安装身份、可恢复部署事务和带所有权校验的清理流程。

## 前提条件

- 本地 Clawd 正在运行
- 本机能通过系统 `ssh` 连接远端
- 远端已安装 Node.js
- Windows 10/11 远程主机需启用系统自带的 OpenSSH 服务端，并将 Node.js 14+
  加入 PATH。默认 shell 使用 cmd、PowerShell 或 Git Bash 都可以，不需要修改
- 远端已安装至少一个支持的 agent：Claude Code、Codex CLI、Copilot CLI 或 Hermes Agent
- 使用 Hermes Agent 时，远端需要已经装好 Hermes，且其 CLI 可通过
  `<home>/hermes-agent/venv/bin/hermes`、`~/.local/bin/hermes`（git 安装）
  或非 login PATH 里的 `hermes` 访问到。
  plugin 跑在 Hermes 自己的 virtualenv Python 里；上面的 Node.js 要求不变

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
   - 随后在远端检测到 Hermes 时，把 Clawd 的 Hermes plugin 上传到一个独立 staging 目录，再注册进 Hermes home 及其 profile home
   - 配置下方会展示连接 / 部署日志
5. 在远端终端里启动 Claude Code、Codex CLI、Copilot CLI 或一个 Hermes 会话。Dashboard 会在第一条远端 hook 事件到达后显示 session。

全新本机安装下，如果只是接收远程 Copilot CLI 事件，请到 **Settings -> AI 编程工具**
打开 **Copilot CLI**，这样 Clawd 才会接收远程 hook 事件；不需要点
**Install / 安装**，除非你也想在本机安装 Copilot hooks。

如果只是接收远程 Hermes Agent 事件，远程 SSH 部署完整验证通过后，Clawd 会自动在
**Settings -> AI 编程工具** 打开 **Hermes Agent**，远程 hook 事件随即被接收；不需要点
**Install / 安装**，除非你也想在本机安装 Hermes plugin：远程部署不会在本机装任何
东西，也不会把本机集成标记为已安装。

如果配置里开启了 **连接时自动启动 Codex 兜底监控**，Clawd 会把
`~/.claude/hooks/codex-remote-monitor.js` 作为连接维护启动。在 serialized transport
上，这项一次性维护会先完成并关闭，随后才启动持久反向隧道；自动重连不会重复执行
monitor mutation。Codex official hooks 正常可用时不依赖这个兜底监控。Windows
远程主机不可用，即使开启此选项，Clawd 也会跳过。

### Hermes Agent 的支持范围与生效方式

Phase 1 只覆盖默认 `account-default` 的 Remote SSH layout 和标准 Hermes 安装：
`~/.hermes` home 加上 `~/.hermes/profiles/*` 下的 profile home，对应默认 gateway
和普通 named-profile gateway。Clawd 会把托管 plugin 装进 root home 和每个已发现的
profile home，再通过远端 `hermes` CLI 启用它。

自定义 `HERMES_HOME`、multiplexed gateway 和实验性 `profile-isolated` 模式在
Phase 1 **不受支持、也未验证**。

启用 plugin 会在**下一个** Hermes 会话生效。如果这次部署替换了某个正在运行的
gateway 已经加载的托管 plugin 文件，那个 gateway 需要你**手动**重启，才会用新模块
发事件；Clawd 从不替你重启 Hermes gateway。部署进度行会报告属于上述哪一种情况；
`systemctl --user is-active` 只是 best-effort 提示，不能证明 gateway 已经在跑新模块。

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

## Windows 远程主机

Windows 远程部署支持 **Claude Code、Copilot CLI、Codex CLI 官方 hook 和 DeepSeek Harness 桌面版**，仅限
`account-default` 模式。Windows 远程主机不支持 Hermes Agent、`profile-isolated`
模式、Claude 额度环和 Codex 备用监控。部署会跳过不支持的 agent，用户已有的
Claude statusLine 保持原样。Codex 只承诺 CLI；Codex Desktop 尚未验证。

远程部署与那台 Windows 上的本地 Clawd 只能二选一。本地 Clawd 正在运行，或无法
从 runtime 记录确认它已退出时，部署会被拒绝。请先退出那台电脑上的 Clawd，再点
**部署 / 修复 Hook**。远程部署也会移除 Clawd 的 Claude 自动启动 hook，避免启动
Claude 时拉起本地桌宠。

之后打开本地 Clawd，会将 hook 接管回本地使用。下次**连接**或自动重连时，Clawd
会检查本次部署实际安装过的组件，发现接管后提示重新部署；成功连接后不会持续检查。
如果本地 Clawd 开启了**开机启动**，Windows 重启后可能自动启动它并接管 hook。
要切回远程使用，请先退出它，再重新部署。

文件权限依赖 Windows 用户 profile 目录继承的 ACL，不能隔离共用同一 Windows
账号的部署。Copilot 会忽略带 UTF-8 BOM 的 `hooks.json`；Clawd 会在部署时自动
去掉 BOM，并回读确认。

Codex 使用 `~\.codex` 下的官方 hook。部署后要在远端 Codex 的 TUI 里运行
`/hooks` 信任新条目；卸载本次部署后，排在后面的第三方 hook 序号会前移，可能
也需要重新 `/hooks` 确认。`hooks.json` 不能带 UTF-8 BOM，Clawd 会自动修正。
部署只管理 `~\.codex`，不支持自定义 `CODEX_HOME`。`~\.codex`、其中的
`hooks.json` 或 `config.toml` 是链接时会被拒绝部署。`~\.codex\hooks.json` 里
有无法确认归属的 Clawd 条目时也会拒绝部署；请先处理或删除该条目再部署。远端
`config.toml` 的 `[features].hooks` 被显式设为 `false` 时，部署会在写任何 hook
或配置之前被拒绝；请先开启再部署。

### DeepSeek Harness 桌面版

远端为 Windows 时，Clawd 可以显示 DeepSeek Harness 桌面版的会话状态、工具活动
和完成，并让你在 Mac 上回答审批。点击会话不能跳转到远端 DSH 窗口。

请先在远端安装 DeepSeek Harness 桌面版，并至少打开一次以创建桌面版设置。
支持版本与[本地 DSH 集成](dsh-setup.md)一致：`0.2` 系列从 `0.2.0-rc.2` 起，
`0.1` 系列从 `0.1.0-rc.6` 起。部署前需要登录着那台 Windows 电脑的桌面。
管理员账号通过 SSH 部署时，Clawd 会经一次性计划任务，在你的桌面会话里以普通
权限安装 DSH 插件，用完即删。部署后，**请在远端电脑上重启 DeepSeek Harness
桌面版**，新连接才会生效。验证通过的部署也会打开 Mac 上 Clawd 设置里的
DeepSeek Harness 开关。

DSH 的远程连接与那台电脑上的本地 Clawd 二选一。若本地 Clawd 已接入 DSH，
部署会先要求确认，再将它切换为远程使用。以后启动远端本地 Clawd，不会自动抢回
DSH 连接。想换回本地，请打开那台电脑上的 Clawd，在设置里修复 DeepSeek Harness
集成。其他 agent 的 hook 仍遵循上文的本地接管规则。

DSH 远程接入不支持网页版（`dsh web`）、headless、Linux / macOS 远程主机或
`profile-isolated` 模式。没有安装 DSH 桌面版的远端，其他 agent 仍按原有方式部署，
即使未使用的 DSH 数据文件夹是链接也不会被阻止。

部署日志中的 DSH 提示含义如下：

| 原因 | 处理方式 |
| --- | --- |
| `dsh_asset_upload_failed` | 连接文件上传失败。检查 SSH 和远端文件夹权限，再点**部署 / 修复 Hook**。 |
| `bridge-ownership-conflict` | 无法确认已有的 DSH 插件是否属于 Clawd。先检查远端该插件，再部署。 |
| `dsh_desktop_ambiguous` | 找到了多个桌面版安装。保留要使用的安装，再部署。 |
| `dsh_desktop_unreadable` | 无法检查桌面版安装。检查安装文件夹的访问权限，再部署。 |
| `dsh_home_ambiguous` | 找到了不止一个可能的数据文件夹。检查 `DSH_HOME` 和默认的 `~\.dsh` 文件夹，再部署。 |
| `dsh-home-changed` | 数据文件夹与上次部署不同。恢复原文件夹，或先清理原部署，再部署到新文件夹。 |
| `inspection-required` | 上次安装需要人工检查。确认远端集成情况后，按下文解除暂停，再点**部署 / 修复 Hook**。 |
| `dsh_install_failed` | 未能安装 DSH 连接。检查部署日志和远端文件权限，再部署。 |
| `installer_result_unknown` | 未收到安装完成的确认。先检查远端集成再重试；若安装已暂停，检查确认后再解除。 |
| `dsh_local_migration_required` | 本地 Clawd 已接入 DSH。确认后会改用远程；以后想换回本地，在那台电脑的 Clawd 设置里修复 DSH 集成。 |
| `dsh_profile_unreadable` | 无法读取桌面版设置。检查桌面版数据文件夹内 `package.json` 的内容和访问权限，再部署。 |
| `dsh_readback_failed` | 安装已结束，但未能确认连接有效。检查远端集成，再部署。 |
| `version-unsupported` | 换用本地集成所支持的 DSH 版本，再部署。 |
| `windows_dsh_cleanup_incomplete` | 插件文件或 DSH 设置中的引用仍有残留，或无法检查清楚。先点**部署 / 修复 Hook**，再重新清理。 |
| `windows_dsh_desktop_session_required` | 先登录远端 Windows 桌面，再部署，让插件能以普通权限安装。 |
| `dsh_discovery_incomplete` | 这是非阻断提示：其他集成已部署，但未能完整检查 DSH 安装情况，已跳过 DSH。检查远端 DSH，需要时再部署。 |

已安装桌面版的 DSH 数据文件夹或远程连接文件夹中有链接时，会报 `path_link`。
请检查这些文件夹后再重试；此检查不会阻止未安装 DSH 桌面版的电脑。

**人工检查远端 DSH 集成后**，可在那台电脑的 PowerShell 中运行以下命令解除
安装暂停。将占位符替换为 `~\.clawd\remote-integrations\deepseek-harness` 下
本次部署的 64 位文件夹名，可查看其中的 `deployment.json` 来确认所属部署。
此操作只解除暂停，不会修复或批准集成。然后在 Mac 上点**部署 / 修复 Hook**。

```powershell
node "$env:USERPROFILE\.claude\hooks\dsh-install.js" --remote-clear-latch --profile desktop --remote-root "$env:USERPROFILE\.clawd\remote-integrations\deepseek-harness" --install-id '<deployment install ID>'
```

## 关键概念

Doctor 里显示的本地服务 `127.0.0.1:<端口>` 是正常的：它是你这台电脑上的
Clawd HTTP 服务，不是远端集群的 IP。远端 hook 也不直接访问你的局域网 IP。

实际链路是：

```
远端 Claude/Codex/Copilot/Hermes hook
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
- 全新本机安装下，如果只接收远程 Copilot CLI，本机 **Settings -> AI 编程工具 -> Copilot CLI** 已打开
- 如果只接收远程 Hermes Agent，本机 **Settings -> AI 编程工具 -> Hermes Agent** 仍处于打开状态（完整验证通过的部署会自动打开它）；部署日志要求时，远端 gateway 也已手动重启

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

Hermes 不改变这一点：它的部署阶段同样跑在远端 Node runtime 上，装好的 plugin
则跑在 Hermes 自己的 virtualenv Python 里。如果 Hermes 阶段因为解析不到 `hermes`
CLI 而失败，请让它可通过 `<home>/hermes-agent/venv/bin/hermes`、`~/.local/bin/hermes`
或非 login PATH 里的 `hermes` 访问到，然后重新部署。

### 远端没有 Node.js（Windows）

在 Windows 远端安装 Node.js 14+，并让 OpenSSH 会话能从 PATH 找到 `node`，然后
重新点**部署 / 修复 Hook**。只在交互式 shell 中可用的 Node 版本管理器不够。如果
部署后 PATH 上的 Node 可执行文件路径变了，需要重新部署以确认新路径。不需要修改
OpenSSH 的默认 shell。

### 远程 hook 被本地 Clawd 接管

先退出 Windows 远端上的 Clawd，再点**部署 / 修复 Hook**。本地 Clawd 启动时会恢复
本地 hook；如果开启了**开机启动**，Windows 重启后也可能接管。Claude Code、Copilot
CLI 和 Codex CLI 都适用。提示会在下次连接或重连时出现，已健康连接期间不会持续
检查。如果提示无法读取或确认 hook 配置，请检查文件权限和 JSON，再重连或重新部署。
Codex 的 `~\.codex\hooks.json` 缺失或带 BOM 时同样需要重新部署并运行 `/hooks`
确认。

### 可以手动开 SSH 隧道吗？

安全版 Remote SSH 不支持这样做。本地目标是临时的 profile 专属入口，不是 Clawd
通用 HTTP 端口。请使用 profile 的 **连接**，让 Clawd 一起创建和销毁入口与隧道。
手写 `ssh -R ...:23333` 指向通用服务端口不会建立 profile 绑定；携带安全 nonce
的请求到达那里会直接收到 404。
