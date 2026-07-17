# 配置指南

[返回 README](../../README.zh-CN.md)

## Agent 配置说明

全新安装默认只安装并启用 Claude Code 和 Codex。其他本机 agent 需要先到 **Settings → Agents** 点该 agent 的 **Install / 安装**；安装且启用后，Clawd 才会在启动时继续同步对应 hook / plugin / extension。单独关闭 agent 只会停止事件入口，不会卸载文件；**Uninstall / 卸载** 只删除 Clawd 管理的 hook / plugin / extension 条目，并同时禁用该 agent。

**Claude Code** — 开箱即用。Clawd 启动时会自动注册 hooks。只有在确认 Claude Code 版本兼容时才会注册 versioned hooks（`PreCompact`、`PostCompact`、`StopFailure`）；如果版本无法确认，会自动回退到核心 hooks，并清理旧的不兼容条目。除了监听 `~/.claude/settings.json` 所在目录的变化外，Clawd 还会每 5 分钟做一次只读健康巡检——即使 hook 脚本是在系统 Temp 等其他目录被清理、且 `settings.json` 本身完全没变化，也能发现并自动修复。同一问题连续自动修复 3 次仍失败会停止自动重试，Doctor 会提示手动 Fix；如果是当前安装包自身的 hook 脚本缺失（例如安装损坏），Clawd 不会盲目重写配置，会提示重新安装或重新解压。

**Codex CLI** — 开箱即用。Clawd 会在检测到 Codex 时自动注册 official hooks 到 `~/.codex/hooks.json`，并在用户没有显式关闭 hooks 时启用 `[features].hooks = true`。Installer 会把已废弃的 `[features].codex_hooks` 迁移到 `hooks`，同时保留用户显式设置的 false。Official hooks 提供实时状态和真实 Allow/Deny 权限气泡；`~/.codex/sessions/` JSONL 轮询只保留为状态 / metadata fallback，用于 hook 被禁用或 hook 未覆盖事件；审批不再从 JSONL 猜测。

**Copilot CLI** — 需要本机 Copilot CLI 追踪时，先到 **Settings → Agents** 安装。安装且启用后，Clawd 启动时会自动在 `<COPILOT_HOME 或 ~/.copilot>/hooks/hooks.json` 注册 hooks（marker-based 合并，你已有的 hook 条目和其他 `hooks/*.json` 文件原样保留）。SSH 远程部署走应用内 **Settings → 远程 SSH → 一键部署** 自动配置。`hooks.json` 或 `settings.json` 顶层 `disableAllHooks: true` 时 doctor 会报 warning 并不挂 Fix 按钮。详见 [copilot-setup.zh-CN.md](copilot-setup.zh-CN.md)（含手动备选与 `COPILOT_HOME` 说明）。

**Gemini CLI** — hooks 配置在 `~/.gemini/settings.json`。需要本机 Gemini 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步 hooks。也可以手动执行 `npm run install:gemini-hooks`。

**Antigravity CLI (agy)** — hooks 配置在 `~/.gemini/config/hooks.json`。需要本机 agy 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步 hooks。也可以手动执行 `npm run install:antigravity-hooks`。Clawd 对 agy 是**仅状态同步**集成：桌宠会反映 working / idle / attention 状态，**但 Clawd 不显示任何权限气泡**。所有 Allow / Deny / Always-allow 决策都在 agy 自己的 5 选项终端菜单里完成 —— 想要永久规则就在 agy 菜单里选择标有「Persist to settings.json」的选项。Clawd-在前的方案 dogfood 后发现单次任务变 8-10 次确认，所以 PreToolUse hook 故意不注册。

**Cursor Agent** — hooks 配置在 `~/.cursor/hooks.json`。需要本机 Cursor Agent 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步 hooks。也可以手动执行 `npm run install:cursor-hooks`。

**CodeBuddy** — 使用与 Claude Code 兼容的 hooks，配置写入 `~/.codebuddy/settings.json`。需要本机 CodeBuddy 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步 hooks。也可以手动执行 `node hooks/codebuddy-install.js`。

**Kiro CLI** — 需要本机 Kiro 追踪时，先到 **Settings → Agents** 安装；如果你想在启动 Clawd 前先注册 hooks，也可执行 `npm run install:kiro-hooks`。Kiro 内置的 `kiro_default` 不是一个可编辑的 JSON agent，所以 Clawd 会维护一个自定义 `clawd` agent，并在集成安装后每次启动时先同步最新的 `kiro_default` 配置，再追加 hooks。需要 hooks 时，请用 `kiro-cli --agent clawd` 新开会话，或者在现有会话里执行 `/agent swap clawd`。目前在 macOS 与 Windows 上，状态类动效已验证可用；但涉及终端里 `t / y / n` 的原生权限确认，仍然只能在终端处理。

**Kimi Code** — Clawd 用同一个集成同时支持两代 Kimi。新版 Kimi Code（TypeScript CLI）的 hooks 在 `~/.kimi-code/config.toml`，旧版 Kimi CLI（Python，上游已停更）的在 `~/.kimi/config.toml`；哪个目录存在 Clawd 就装哪个（两个都在就都装）。需要本机 Kimi 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 会在启动时持续同步 hooks。也可以手动执行 `npm run install:kimi-hooks`。在 Clawd 中 Kimi 采用 hook-only 集成：状态和权限提示都来自 hook 事件，不依赖日志轮询。在新版 Kimi Code 上，权限气泡由 CLI 原生的 `PermissionRequest`/`PermissionResult` hook 事件驱动——气泡会显示正在等待批准的具体命令，你在终端里作出选择后气泡立即消失，无需任何配置。如果你用过 Kimi Code 内置的旧版迁移，Clawd 下一次同步会自动把迁移过来的 hook 条目升级为新格式（旧的 env 前缀命令写法在 Windows 上无法执行）。旧版 `~/.kimi` 安装的权限提示**默认启用 suspect 启发式**：现行 kimi-cli 版本的 `PreToolUse` 从不携带显式审批字段（1.37 与 1.49 实测），旧的 explicit-only 默认值意味着提示卡根本不会出现。安装器会把模式以 `--permission-mode=suspect` 参数的形式持久化到每条 hook 的 `command` 里；此前选择过的模式——包括 `explicit`——在重新同步时始终原样保留，绝不会被翻转（用已停用的 `CLAWD_KIMI_PERMISSION_MODE=…` env 前缀形式装过的配置会连值一起迁移成参数形式）。想退出默认：在运行安装命令前设置 `CLAWD_KIMI_PERMISSION_MODE=explicit`（持久化），或在运行 kimi-cli 时临时设置该环境变量——运行时环境变量的优先级永远高于持久化参数。需要了解的代价：suspect 启发式下，*已免审*的门控命令若运行超过约 0.8 秒，会短暂弹出一张误报提示卡（卡片几秒后自动关闭；宠物会保持通知姿势直到该命令跑完）。嫌烦可在 **Settings → Agents** 里整体关闭 Kimi 的权限提示。注意：自动同步会按预期行重写 `command` 字段，你对该字段的手工修改会在下次启动时被静默还原。

**Qwen Code** — hooks 配置在 `~/.qwen/settings.json`。需要本机 Qwen 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步 hooks。也可以手动执行 `npm run install:qwen-hooks`。Qwen Code 在 Clawd 中采用 hook-only 集成：状态更新和阻塞式 `PermissionRequest` 审批都来自 Qwen hook 事件。如果 Qwen settings 里有 `disableAllHooks: true`，Clawd 可以注册条目，但 Qwen 不会触发它们，直到用户移除该开关。

**CodeWhale** — lifecycle hooks 配置在 `~/.codewhale/config.toml`（`[[hooks.hooks]]` 条目）。需要本机 CodeWhale 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步 hooks。也可以手动执行 `npm run install:codewhale-hooks`。Phase 1 是 state-only：Clawd 只驱动生命周期、工具调用和模式切换动画，不弹权限气泡，也不追踪子代理。详见 [codewhale-setup.md](codewhale-setup.md)。

**Reasonix CLI** — hooks 配置在 `<Reasonix home>/settings.json`（macOS/Linux 为 `~/.reasonix/settings.json`，Windows 为 `%APPDATA%\reasonix\settings.json`）。需要本机 Reasonix 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步 hooks。也可以手动执行 `npm run install:reasonix-hooks`。Phase 1 是 state-only：Clawd 只驱动生命周期、工具调用、通知、压缩和子代理结束动效，权限决策仍留在 Reasonix 自己的终端流程。

**opencode** — 使用 `~/.config/opencode/opencode.json` 里的 plugin 配置。需要本机 opencode 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步 plugin。也可以手动执行 `node hooks/opencode-install.js`。

**Pi** — 使用全局 extension 目录 `~/.pi/agent/extensions/clawd-on-desk`。需要本机 Pi 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步 extension。也可以手动执行 `npm run install:pi-extension`。交互式 Pi 会话会向 Clawd 上报生命周期和工具活动，但 Pi 是 state-only：Clawd 不显示权限气泡、不调用 Pi 终端确认，并保留 Pi 默认 YOLO 执行行为。

**OpenClaw** — 使用 `~/.openclaw/openclaw.json` 里的 plugin 路径。需要本机 OpenClaw 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步 plugin。也可以手动执行 `npm run install:openclaw-plugin`，由 OpenClaw CLI 处理首次安装。Phase 1 只做状态动画，面向本地 `openclaw tui --local` 会话；暂不接 OpenClaw 权限气泡，也不支持 OpenClaw 终端聚焦。

**Hermes Agent** — 从 [hermes-agent.org](https://hermes-agent.org/) 或 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 安装 Hermes。需要本机 Hermes 追踪时，先到 **Settings → Agents** 安装 Clawd 集成；安装且 Hermes 存在后，Clawd 会把 plugin 复制到 Hermes 的托管 plugin 目录，并通过 `hermes plugins enable clawd-on-desk` 启用它。也可以手动执行 `npm run install:hermes-plugin` 强制同步，或执行 `npm run uninstall:hermes-plugin` 移除 Clawd 的 Hermes plugin。

**Qoder** — hooks 写入 `~/.qoder/settings.json`。需要本机 Qoder 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步 hooks。也可以手动执行 `npm run install:qoder-hooks`。Phase 1 是 state-only：hook 恒返回 `{}`，`PermissionRequest` / `PermissionDenied` 只作为通知观察——Clawd 不弹权限气泡、不代答权限决策，权限流程由 Qoder 原生接管。启动恢复只识别 Qoder CLI 进程（`qodercli` / `qoder-cli`），闲置打开的 Qoder IDE 不会被当成进行中的 agent 工作。
## 远程 SSH 模式（Claude Code, Codex CLI & Copilot CLI）

<img src="../../assets/screenshot-remote-ssh.png" width="560" alt="远程 SSH — 来自树莓派的权限气泡">

Clawd 支持通过 SSH 反向端口转发感知远程服务器上的 AI Agent 状态。Hook 事件和权限请求通过 SSH 隧道传回本地 Clawd，无需修改 Clawd 本体代码。

**主流程：应用内 Settings → 远程 SSH → 一键部署**

DMG / 安装包用户的入口是 Clawd 应用内的 **Settings → 远程 SSH**：新增 profile（填 `user@host`、可选私钥、转发端口），点 **一键部署**，Clawd 会自动建立 `ssh -R` 反向隧道并把 hooks 部署到远端。完整步骤、Doctor 边界和故障排查（端口冲突 / 没 Node.js / 远端 session 不显示等）见专门指南：

**→ [docs/guides/guide-remote-ssh.zh-CN.md](guide-remote-ssh.zh-CN.md)**

**工作原理：**
- **Claude Code** — 远程 hook 将状态 POST 到 `localhost:23333`，SSH 隧道转发回本地 Clawd。权限气泡也能正常弹出——HTTP 往返通过隧道完成。
- **Codex CLI** — 远程 official hooks 通过同一隧道 POST 状态和权限请求。如果远程 Codex hooks 不可用或被禁用，再使用 fallback 日志监控：`node ~/.claude/hooks/codex-remote-monitor.js --port 23333`
- **Copilot CLI** — 一键部署会自动写入远程的 `~/.copilot/hooks/hooks.json`（前提是远程已安装 Copilot CLI，即 `~/.copilot/` 存在）。Hook 通过同一隧道 POST 状态和 session title。

全新本机安装下，如果只是接收远程 Copilot CLI 事件，请到 **Settings → Agents** 打开 **Copilot CLI**，这样 Clawd 才会接收远程 hook 事件；不需要点 **Install / 安装**，除非你也想在本机安装 Copilot hooks。

远程 hook 以 `CLAWD_REMOTE` 模式运行，跳过 PID 采集（远程 PID 在本地无意义）。远程会话不支持终端聚焦。

**源码用户备选：** 从源码目录运行（`npm start` 调试场景）才需要老脚本：

```bash
bash scripts/remote-deploy.sh user@远程主机
```

它复制源码树里的 hooks 文件并打印手动 SSH 配置（`~/.ssh/config` 加 `RemoteForward 127.0.0.1:23333 127.0.0.1:23333`）。DMG / 安装包用户不需要源码目录，请用应用内一键部署。

> 感谢 [@Magic-Bytes](https://github.com/Magic-Bytes) 提出 SSH 隧道方案（[#9](https://github.com/rullerzhou-afk/clawd-on-desk/issues/9)）。

## WSL（Windows Subsystem for Linux）

> 本节的主线是 Claude Code / 其他 hook 型 agent 的 WSL 配置。关于 `Codex CLI + WSL` 的官方支持现状、Codex hooks feature flag 行为、以及 Clawd 当前为什么默认扫不到 WSL Linux home 下的 Codex 日志，见：[codex-wsl-clarification.zh-CN.md](codex-wsl-clarification.zh-CN.md)

如果你在 WSL 里跑 Claude Code，而 Clawd 跑在 Windows 宿主上，hook 可以直接 POST 到 `127.0.0.1:23333` —— 不需要 SSH 隧道，因为 WSL2 默认与 Windows 共享 localhost。

**配置步骤：**

```bash
# 在 WSL shell 中执行：
mkdir -p ~/.claude/hooks

# 从 Windows 侧的 Clawd 仓库复制 hook 文件（按实际路径调整 /mnt/ 前缀）
cp /mnt/d/animation/hooks/{server-config,json-utils,shared-process,clawd-hook,install,codex-hook,codex-install,codex-install-utils,codex-remote-monitor,codex-session-index,codex-subagent-fields,copilot-hook,copilot-install}.js ~/.claude/hooks/

# 以远程模式注册 Claude hooks
node ~/.claude/hooks/install.js --remote

# 如果 WSL 中安装了 Codex CLI，也以远程模式注册 Codex official hooks
node ~/.claude/hooks/codex-install.js --remote

# 如果 WSL 中安装了 Copilot CLI，也以远程模式注册 Copilot CLI hooks
node ~/.claude/hooks/copilot-install.js --remote
```

如果你的 WSL 里开启了 SSH 服务，也可以用源码备选脚本：

```bash
# 从 Windows 侧执行（Git Bash / PowerShell）：
bash scripts/remote-deploy.sh 你的用户名@localhost
```

配置完成后，在 Windows 上启动 Clawd，在 WSL 里运行 Claude Code —— Clawd 会自动感知你的会话。权限气泡也能正常弹出。

如果 Codex 运行在 WSL 里，official hooks 需要安装到 WSL 自己的 `~/.codex` 下。如果你希望 WSL 与 Windows 共用同一份 Codex home，也可以在 WSL 里先设置 `CODEX_HOME=/mnt/c/Users/<windows-user>/.codex` 再运行 Codex。

> **注意：** WSL2 的 localhost 转发需要 Windows 10 build 18945+（默认开启）。如果不生效，检查 `%USERPROFILE%\.wslconfig` 中 `localhostForwarding=true` 是否被禁用。

### WSL 网络与 Hook 注册（替代方案）

Clawd 跑在 Windows 的 Electron 应用里，而你的 AI 编程助手（Claude Code、Kiro CLI 等）可能跑在 WSL 里。WSL 中的 hook 脚本会把 HTTP 请求发到 `127.0.0.1:23333`，所以 WSL 和 Windows 必须共享同一个 localhost。

- **WSL1** — 开箱即用。WSL1 天然与 Windows 共享 localhost，无需额外配置。
- **WSL2** — 需要镜像网络模式。WSL2 默认拥有独立网络栈，`127.0.0.1` 指向 WSL 自身而不是 Windows。请在 `%USERPROFILE%\.wslconfig` 中启用镜像模式（文件不存在就新建），然后执行 `wsl --shutdown` 重启 WSL：

```ini
[wsl2]
networkingMode=mirrored
```

**在 WSL 中手动注册 hooks：**

Clawd 在 Windows 启动时会自动注册 Claude Code hooks 到 `~/.claude/settings.json`。但如果你的 Agent 跑在 WSL 里，hooks 需要注册到 WSL 自己的 home 目录。请在 WSL 中执行：

```bash
git clone https://github.com/rullerzhou-afk/clawd-on-desk.git
cd clawd-on-desk

# Claude Code
node hooks/install.js

# Codex CLI
node hooks/codex-install.js --remote

# Kiro CLI - 会将 hooks 注册到 ~/.kiro/agents/ 下所有自定义 agent，
# 并自动创建一个 clawd agent
node hooks/kiro-install.js

# Kimi Code CLI（Kimi-CLI）
node hooks/kimi-install.js

# Qwen Code
node hooks/qwen-code-install.js

# Cursor Agent
node hooks/cursor-install.js

# Gemini CLI
node hooks/gemini-install.js

# Antigravity CLI (agy)
node hooks/antigravity-install.js

# CodeBuddy
node hooks/codebuddy-install.js

# opencode
node hooks/opencode-install.js

# Pi
node hooks/pi-install.js

# OpenClaw
node hooks/openclaw-install.js
```

> 提示：如果仓库克隆在 WSL 内（如 `~/clawd-on-desk`），hook 脚本会自动使用 WSL 的 Node.js 路径。如果仓库放在 Windows 盘里（如 `/mnt/c/...`），请确保 WSL 的 PATH 中有 `node`。

## Windows 说明

- **安装包**：GitHub Releases 提供独立的 Windows x64 和 Windows ARM64 NSIS 安装包。Intel / AMD Windows 设备下载 `Clawd-on-Desk-Setup-<version>-x64.exe`，Windows on ARM 设备下载 `Clawd-on-Desk-Setup-<version>-arm64.exe`。
- **自动更新**：Windows 安装包使用 `electron-updater`，更新时会保持当前匹配的架构。

## macOS 说明

- **源码运行**（`npm start`）：Intel 和 Apple Silicon 均可直接使用。
- **DMG 安装包**：未签名 Apple 开发者证书，macOS Gatekeeper 会拦截。解决方法：
  - 右键点击应用 → **打开** → 在弹窗中点击 **打开**，或
  - 在终端运行 `xattr -cr /Applications/Clawd\ on\ Desk.app`

## Linux 说明

- **源码运行**（`npm start`）：默认启用 Electron sandbox。如果你的 Linux 开发环境仍然遇到 chrome-sandbox 初始化失败，可临时使用 `CLAWD_DISABLE_SANDBOX=1 npm start` 作为兼容方案。
- **安装包**：AppImage 和 `.deb` 可从 [GitHub Releases](https://github.com/rullerzhou-afk/clawd-on-desk/releases) 下载。deb 安装后应用图标会出现在 GNOME 应用菜单。
- **终端聚焦**：依赖 `wmctrl` 或 `xdotool`（有一个就行）。安装：`sudo apt install wmctrl` 或 `sudo apt install xdotool`。
- **自动更新**：源码运行时，"检查更新"会执行 `git pull` + `npm install`（依赖有变化时）并自动重启。
