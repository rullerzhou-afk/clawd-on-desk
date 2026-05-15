# 已知限制

[返回 README](../README.zh-CN.md)

| 限制 | 说明 |
|------|------|
| **Codex CLI：无法跳转终端** | Codex official hooks 和 JSONL fallback 都不携带可用终端 PID，点击桌宠仍无法跳转到 Codex 终端。Claude Code 和 Copilot CLI 正常。 |
| **Codex CLI：hook 覆盖仍不完整** | Official hooks 已覆盖实时状态和 `PermissionRequest` 观察 / intercept 模式，但不是所有运行时信号都有 hook。Clawd 会保留 JSONL 轮询，用于 hook 被禁用的会话，以及 web search、context compaction、turn aborted 等 fallback-only 事件；这些事件仍可能有轮询延迟。 |
| **Copilot CLI：本地需手动配置 hooks** | 本地安装仍需手动创建 `~/.copilot/hooks/hooks.json`。SSH 远程部署 (`scripts/remote-deploy.sh`) 现在已经自动配置 Copilot hooks。 |
| **Copilot CLI：无权限气泡** | Copilot 的 `preToolUse` 只支持拒绝，无法做完整的允许/拒绝审批流。权限气泡目前支持 Claude Code、Codex CLI、CodeBuddy、opencode 和 Pi。 |
| **Gemini CLI：无权限气泡** | Gemini 仍在终端内处理工具审批。Clawd 会观察 Gemini hook 事件，但除非 Gemini 未来提供兼容的阻塞式审批协议，否则不显示权限气泡。 |
| **Cursor Agent：无权限气泡** | Cursor 在 hook 的 stdout JSON 里处理权限，而不是走 HTTP 阻塞式审批，Clawd 无法接管这条审批链路。 |
| **Cursor Agent：启动恢复能力有限** | 启动时不做进程检测，否则任意 Cursor 编辑器进程都可能误判为活跃会话。Clawd 会保持 idle，直到收到第一条 hook 事件。 |
| **Hermes Agent：安装前可见但不生效** | Hermes 默认在 Settings 里开启，方便发现；但 Clawd 只有在检测到真实 Hermes 安装后才会写入 plugin 文件。安装 Hermes 后重启 Clawd，或执行 `npm run install:hermes-plugin`。 |
| **Hermes Agent：暂不支持权限气泡和 subagent 动画** | 当前 Hermes plugin 覆盖状态、会话、SessionEnd、工具活动和终端聚焦。权限气泡需要上游提供阻塞式审批协议；subagent 动画需要成对的 subagent start/stop 生命周期事件。 |
| **Kiro CLI：无法区分会话** | Kiro CLI stdin JSON 不含 session_id，所有 Kiro 会话会被合并为单个追踪会话。 |
| **Kiro CLI：无 SessionEnd 事件** | Kiro CLI 没有 SessionEnd 事件，Clawd 无法检测 Kiro 会话结束。 |
| **Kiro CLI：无 subagent 检测** | Kiro CLI 没有 subagent 事件，不会触发杂耍/指挥动画。 |
| **Kiro CLI：终端权限确认仍在终端处理** | macOS 与 Windows 上 Kiro 的状态 hooks 已验证可用；但当 Kiro 显示 `t / y / n` 这类原生权限确认时，当前仍需在终端里处理，Clawd 不接管这类确认。 |
| **Kimi Code CLI（Kimi-CLI）：hook-only 运行路径** | Kimi 在 Clawd 中采用 hook-only 集成（`~/.kimi/config.toml`）。如果未来某个 Kimi 版本让 hooks 失效，回退方式是恢复 commit `e57679a` 里的旧日志轮询实现（当前 `agents/kimi-log-monitor.js` 只是兼容 stub）。 |
| **Kimi Code CLI（Kimi-CLI）：引用 `kimi-hook.js` 的 `[[hooks]]` block 由 Clawd 接管** | Clawd 每次启动（以及执行 `npm run install:kimi-hooks`）都会自动同步 Kimi hooks。凡是 `command` 里引用 `kimi-hook.js` 的 `[[hooks]]` block，都会被视为 Clawd-owned：这些 block 会被整批删除并重写为标准 13 个事件（包括之前安装时写入的 `CLAWD_KIMI_PERMISSION_MODE=…` 前缀；如果这次没传 env，就沿用旧值）。`config.toml` 里其他非 hook 段（如 `[server]`、`[mcp]`、`[[tools]]`）和你自己写的、但不引用 `kimi-hook.js` 的 `[[hooks]]` block 不会被动。想调整权限模式，请先设置环境变量（例如 `CLAWD_KIMI_PERMISSION_MODE`）再重新运行安装脚本，不要直接手改 `command` 字段。 |
| **opencode：子会话菜单短暂污染** | opencode 通过 `task` 工具分派并行子代理时，子会话会在 Sessions 子菜单里短暂出现（5-8 秒），完成后自动清理。纯视觉问题，不影响建筑动画。 |
| **opencode：终端聚焦锚定启动窗口** | Plugin 跑在 opencode 进程内，`source_pid` 指向启动 opencode 的那个终端。如果你用 `opencode attach` 从另一个窗口接入，点击桌宠只会聚焦到最初的启动窗口。 |
| **Pi：权限气泡覆盖有限** | Clawd 通过全局 extension 观察 Pi 交互式会话生命周期。Pi 权限气泡第一版只覆盖 `bash`、`write`、`edit` 工具调用；Clawd 气泡不可用、被关闭或被 DND 隐藏时，extension 会回退到 Pi 终端确认。 |
| **Pi：session reload 可能短暂闪烁** | Pi 在 reload / session replacement 时会先发 `session_shutdown`，随后新 runtime 发 `session_start`。Clawd 可能短暂删除并重新创建 Pi 会话。 |
| **OpenClaw：本地 TUI state-only 支持** | Phase 1 通过 OpenClaw plugin 观察 `openclaw tui --local` 的生命周期和工具事件。暂不提供权限气泡或终端聚焦；gateway / daemon / messaging 部署也未必能锚定到本地终端窗口。 |
| **OpenClaw：启动时不编辑 JSON5 配置** | OpenClaw 支持 JSON5 和 include 型配置。Clawd 启动同步只会编辑已存在且是严格 JSON 的 `~/.openclaw/openclaw.json`；遇到 JSON5 / include 配置会跳过，除非你手动运行 installer，让 OpenClaw CLI 自己负责写入。 |
| **OpenClaw on Windows：原生 codex relay 可能失败** | 如果 OpenClaw 使用原生 `agentRuntime: codex` 路径时卡住，或报 unsafe native hook relay bridge，建议切到 OpenAI-compatible model/provider，例如 `openai-codex/gpt-5.5`。这是 OpenClaw 自身行为；Clawd 只观察 plugin 状态事件，无法修复 relay。 |
| **Windows Terminal：tab 聚焦能力有限** | Windows Terminal 会用一个宿主窗口 / 进程承载多个 tab，Clawd 无法可靠激活其中某一个指定 tab。HUD / Dashboard 终端跳转最适合单独的传统 `cmd.exe` / PowerShell 窗口，或标题里包含项目目录名的独立 Windows Terminal 窗口。Windows 11 上，`cmd.exe` 和 PowerShell 也可能默认被 Windows Terminal 托管；如果要使用传统窗口，需要把默认终端应用程序改为 Windows 控制台主机。 |
| **macOS/Linux 安装包自动更新** | DMG/AppImage/deb 安装包无法自动更新——使用 `git clone` + `npm start` 可通过 `git pull` 自动更新，或从 GitHub Releases 手动下载。 |
| **Electron 主进程无自动化测试** | 单元测试覆盖了 agent 配置和日志轮询，但状态机、窗口管理、托盘等 Electron 逻辑暂无自动化测试。 |
| **Claude Code：桌宠未运行时工具被自动拒绝** | 桌宠 HTTP 服务未运行时，Clawd 注册的 `PermissionRequest` hook 因 `ECONNREFUSED` 失败，Claude Code 当前会把这种失败当作"用户拒绝"，影响 `Edit`、`Write`、`Bash` 等所有需要权限的工具。这违反 CC 自己的 hooks 文档（声明 HTTP hook 失败应 non-blocking） —— 见 [anthropics/claude-code#46193](https://github.com/anthropics/claude-code/issues/46193)。绕过：保持桌宠运行（推荐），或临时把 `~/.claude/settings.json` 里的 `PermissionRequest` key 重命名以禁用该 hook。 |
