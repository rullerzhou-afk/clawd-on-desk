# Codex + WSL：路径、Node 与配对

官方资料核对日期：**2026-09-05**。Clawd 源码基线：**`7383e8b80b8c0f05bd1dc53cb9e51fb96558a2ed`**。译文同步自英文版：**2026-09-05**。这些是文档/源码核对日期，不是新的设备验证日期。

## 当前支持

OpenAI 支持在 **WSL2** 中运行 Codex。Codex 0.115 起不再支持 WSL1。当前 Codex hooks 默认启用，`hooks` 是标准 feature key，`codex_hooks` 是已弃用的别名；非策略管理的 hooks 仍需通过 Codex 的 `/hooks` 流程审核和信任。参见官方 [WSL 指南](https://learn.chatgpt.com/docs/windows/wsl) 和 [hooks 指南](https://learn.chatgpt.com/docs/hooks#turn-hooks-off)。

Windows Clawd 已提供显式的 **WSL Scan → Pair** 流程。它不会在启动时默默安装到所有发行版，也不会自动轮询独立 Linux home 下的会话。Clawd 以 Codex official hooks 为主，JSONL 轮询作为已配置会话来源的 fallback。Codex 支持 WSL，与 Clawd 能否访问某个 home，是两个问题。

## 配置与执行路径

Windows 与 WSL 默认使用独立的 Codex home。可以在 WSL 中设置 `CODEX_HOME=/mnt/c/Users/<windows-user>/.codex`，显式共享 Windows 的配置、认证与会话，详见 OpenAI 的 [共享 home 说明](https://learn.chatgpt.com/docs/windows/windows-app#share-config-auth-and-sessions-with-wsl)。共享目录不会决定 Clawd hook 使用哪个 Node 可执行文件。

| 配置 | Hook 执行方式 | 网络要求 |
| --- | --- | --- |
| 独立 Linux home（WSL 中的 `~/.codex`），集成安装在该发行版 | Linux Node | Linux 必须能访问 Windows Clawd 的回环服务；WSL2 通常需要 mirrored networking。 |
| 共享 Windows `CODEX_HOME`，POSIX interop launcher 由 Windows 生成 | 通过 WSL interop 使用 Windows `node.exe` | 访问 Windows 回环服务，因此该传输路径不要求 mirrored networking，NAT 下也如此。 |
| 共享 Windows `CODEX_HOME`，已有原生 POSIX launcher 由 WSL/Linux 安装器拥有 | Linux Node；Windows 同步会保留该 launcher | 仍使用 Linux 网络路径；共享 home 本身不等于 Windows interop。 |

第二、三行对应 [codex-install-utils.js](../../hooks/codex-install-utils.js) 中不同的所有权分支，由 [codex-install.test.js](../../test/codex-install.test.js) 覆盖。诊断网络前先核对已注册的 launcher 及实际 Node 目标，仅看 `CODEX_HOME` 不够。这些源码/测试证据不代表每种共享 home 组合都完成了真机验证。

## 推荐流程：独立 home + Pair

1. 在目标 WSL2 发行版中安装 Codex 和 Linux Node，并在那里运行 Codex，建立独立 home。
2. 启动 Windows Clawd，打开 **Settings → Agents → Connected → WSL Scan**，在 Codex 下找到该发行版并选择 **Pair**。Windows 本机没有 Codex 时，这一行可能位于 **Unavailable**。
3. 确认 Clawd 中的 Codex 已**启用**。WSL 配对与 Windows 本机集成安装是独立操作，通常不会替你启用被关闭的 agent。
4. 分别核对安装与连通性结果，按需在 Codex 中审核/信任 hooks，然后启动新会话，确认它出现在 Clawd。探测失败或结果未知都不能视为连接成功。

从完整仓库手动安装、复制全部 hook 文件和网络排障步骤见 [WSL 安装指南](setup-guide.zh-CN.md#wslwindows-subsystem-for-linux)。不要从 `hooks/*.js` 中手动挑选文件。

Linux Node 需要访问 Windows Clawd 的 `127.0.0.1:23333-23337` 服务；WSL2 默认 NAT 不会把 Windows 回环服务暴露给 Linux。mirrored networking 要求 Windows 11 22H2 或更高版本，参见 [Microsoft 网络指南](https://learn.microsoft.com/en-us/windows/wsl/networking#mirrored-mode-networking)。WSL1 共享回环地址只是通用网络事实，不表示现代 Codex 支持 WSL1。网络探测也不能验证所有 agent 的权限链路；安装指南另有 Claude 权限 URL 在安装时固定的限制说明。

## 会话发现与验证边界

Pair 为所选发行版安装 hooks，**不会**让 Windows 的 JSONL fallback 开始轮询所有 `/home/<user>/.codex/sessions`。共享 `CODEX_HOME` 可以让共享会话文件可见，但不会挂载或发现其他 Linux home。本机已配置集成的启动同步，与用户主动发起的 WSL 配对，是不同操作。

远端 Codex monitor 是 managed Remote SSH 的架构 fallback，不是供普通 WSL 用户新增的手动 scanner 教程。secure Remote SSH 依赖部署身份和固定传输目标；请使用 [Settings → Remote SSH](guide-remote-ssh.md)，不要脱离该布局单独运行 scanner。

源码依据：[WSL 部署](../../src/wsl-deploy.js)、[agent 设置操作](../../src/settings-actions-agents.js)、[集成同步](../../src/integration-sync.js)、[Codex JSONL monitor](../../agents/codex-log-monitor.js)。

本次修订对齐官方资料与 Clawd 源码行为，**没有新增 Windows/WSL 真机验证结果**。安装器测试、连通性探测、真实 Codex 会话和共享 home interop 验证是不同证据。每次设备验证应分别记录平台、版本、配置与结果，文首日期不能代替这些记录。
