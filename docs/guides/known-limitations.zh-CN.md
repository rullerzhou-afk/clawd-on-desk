# 已知限制

[返回 README](../README.zh-CN.md)

| 限制 | 说明 |
|------|------|
| **Codex CLI：无法跳转终端** | Codex official hooks 和 JSONL fallback 都不携带可用终端 PID，点击桌宠仍无法跳转到 Codex 终端。Claude Code 和 Copilot CLI 正常。 |
| **Codex CLI：hook 覆盖仍不完整** | Official hooks 已覆盖实时状态和 `PermissionRequest` 观察 / intercept 模式，但不是所有运行时信号都有 hook。Clawd 会保留 JSONL 轮询，用于 hook 被禁用的会话，以及 web search、context compaction、turn aborted 等 fallback-only 状态 / metadata 事件；这些事件仍可能有轮询延迟。审批不再从 JSONL 猜测，必须依赖 official `PermissionRequest` hook。 |
| **Copilot CLI：暂无 Telegram 远程审批** | Copilot 的本地权限气泡已可用，v1 接入时主动排除了 Telegram 远程审批。`edit` 工具的 full diff 是最坏 payload，必须先做一套安全摘要 formatter 才能走桥接发出去。本地气泡链路不受影响。 |
| **Gemini CLI：无权限气泡** | Gemini 仍在终端内处理工具审批。Clawd 会观察 Gemini hook 事件，但除非 Gemini 未来提供兼容的阻塞式审批协议，否则不显示权限气泡。 |
| **Antigravity CLI：无权限气泡（仅状态同步）** | Clawd **不会为 agy 弹任何权限气泡**。所有 Allow / Deny / Always-allow 决策都在 agy 自己的 5 选项终端菜单里完成（同意 / 同意并持久 / 拒绝 / 永远拒绝 / 永远拒绝并持久）。想要永久规则就在 agy 菜单里选择标有「Persist to settings.json」的选项 —— 规则落到 `~/.gemini/antigravity-cli/settings.json`，你也可以在那里清理。dogfooding 显示在它之上再加 Clawd bubble 会让单次任务变 8-10 次确认，因此设计上让 agy 完全拥有权限流程。桌宠仍通过 PreInvocation / PostToolUse / Stop hook 反映 working / idle / attention 状态。 |
| **Cursor Agent：无权限气泡** | Cursor 在 hook 的 stdout JSON 里处理权限，而不是走 HTTP 阻塞式审批，Clawd 无法接管这条审批链路。 |
| **Cursor Agent：启动恢复能力有限** | 启动时不做进程检测，否则任意 Cursor 编辑器进程都可能误判为活跃会话。Clawd 会保持 idle，直到收到第一条 hook 事件。 |
| **Hermes Agent：使用前需要安装集成** | Hermes 会显示在 Settings 里，但新安装默认是 Not installed。Clawd 只有在你显式安装该集成、且检测到真实 Hermes 安装后才会写入 plugin 文件。安装 Hermes 后，在 **Settings -> Agents -> Install** 里安装，或执行 `npm run install:hermes-plugin`。 |
| **Hermes Agent：暂不支持权限气泡和 subagent 动画** | 当前 Hermes plugin 覆盖状态、会话、SessionEnd、工具活动和终端聚焦。权限气泡需要上游提供阻塞式审批协议；subagent 动画需要成对的 subagent start/stop 生命周期事件。 |
| **Kiro CLI：无法区分会话** | Kiro CLI stdin JSON 不含 session_id，所有 Kiro 会话会被合并为单个追踪会话。 |
| **Kiro CLI：无 SessionEnd 事件** | Kiro CLI 没有 SessionEnd 事件，Clawd 无法检测 Kiro 会话结束。 |
| **Kiro CLI：无 subagent 检测** | Kiro CLI 没有 subagent 事件，不会触发杂耍/指挥动画。 |
| **Kiro CLI：终端权限确认仍在终端处理** | macOS 与 Windows 上 Kiro 的状态 hooks 已验证可用；但当 Kiro 显示 `t / y / n` 这类原生权限确认时，当前仍需在终端里处理，Clawd 不接管这类确认。 |
| **Kimi Code CLI（Kimi-CLI）：hook-only 运行路径** | Kimi 在 Clawd 中采用 hook-only 集成（`~/.kimi/config.toml`）。如果未来某个 Kimi 版本让 hooks 失效，回退方式是恢复 commit `e57679a` 里的旧日志轮询实现（当前 `agents/kimi-log-monitor.js` 只是兼容 stub）。 |
| **Kimi Code CLI（Kimi-CLI）：引用 `kimi-hook.js` 的 `[[hooks]]` block 由 Clawd 接管** | Clawd 每次启动（以及执行 `npm run install:kimi-hooks`）都会自动同步 Kimi hooks。凡是 `command` 里引用 `kimi-hook.js` 的 `[[hooks]]` block，都会被视为 Clawd-owned：这些 block 会被整批删除并重写为标准 13 个事件（包括之前安装时写入的 `CLAWD_KIMI_PERMISSION_MODE=…` 前缀；如果这次没传 env，就沿用旧值）。`config.toml` 里其他非 hook 段（如 `[server]`、`[mcp]`、`[[tools]]`）和你自己写的、但不引用 `kimi-hook.js` 的 `[[hooks]]` block 不会被动。想调整权限模式，请先设置环境变量（例如 `CLAWD_KIMI_PERMISSION_MODE`）再重新运行安装脚本，不要直接手改 `command` 字段。 |
| **opencode：child session 仅作为后台工作** | 当 opencode 的 `session.created` 明确带 `event.properties.info.parentID` 时，Clawd 会把该 child / subtask 视为 root session 拥有的 headless 后台工作。它不会出现在 HUD / focus 表面，也不会参与多会话 fanout 动画。 |
| **opencode：终端聚焦锚定启动窗口** | Plugin 跑在 opencode 进程内，`source_pid` 指向启动 opencode 的那个终端。如果你用 `opencode attach` 从另一个窗口接入，点击桌宠只会聚焦到最初的启动窗口。 |
| **Pi：仅状态同步** | Clawd 通过全局 extension 观察 Pi 交互式会话生命周期和工具事件，但不接管权限、不新增确认弹窗。Pi 会保留默认 YOLO 执行行为。 |
| **Pi：session reload 可能短暂闪烁** | Pi 在 reload / session replacement 时会先发 `session_shutdown`，随后新 runtime 发 `session_start`。Clawd 可能短暂删除并重新创建 Pi 会话。 |
| **OpenClaw：本地 TUI state-only 支持** | Phase 1 通过 OpenClaw plugin 观察 `openclaw tui --local` 的生命周期和工具事件。暂不提供权限气泡或终端聚焦；gateway / daemon / messaging 部署也未必能锚定到本地终端窗口。 |
| **OpenClaw：启动时不编辑 JSON5 配置** | OpenClaw 支持 JSON5 和 include 型配置。Clawd 启动同步只会编辑已存在且是严格 JSON 的 `~/.openclaw/openclaw.json`；遇到 JSON5 / include 配置会跳过，除非你手动运行 installer，让 OpenClaw CLI 自己负责写入。 |
| **OpenClaw on Windows：原生 codex relay 可能失败** | 如果 OpenClaw 使用原生 `agentRuntime: codex` 路径时卡住，或报 unsafe native hook relay bridge，建议切到 OpenAI-compatible model/provider，例如 `openai-codex/gpt-5.5`。这是 OpenClaw 自身行为；Clawd 只观察 plugin 状态事件，无法修复 relay。 |
| **CodeWhale：全局 session id 缓存** | Phase 1 会把最近一次 CodeWhale session id 存在 `os.tmpdir()` 下的单个全局文件。多个 CodeWhale 实例并发运行时可能互相覆盖或误清这个缓存，导致状态串线或 HUD 出现重复标签。 |
| **Qoder：仅状态同步** | Phase 1 通过 `~/.qoder/settings.json` 的 hook 观察 Qoder 状态与会话。`PermissionRequest` / `PermissionDenied` 只作为通知观察——hook 恒返回 `{}`，从不代答权限决策，所有 Allow / Deny 都留在 Qoder 原生权限流程里，Clawd 不弹权限气泡。启动恢复只识别 Qoder CLI 进程（`qodercli` / `qoder-cli`），闲置打开的 Qoder IDE 不会被当成进行中的 agent 工作。 |
| **Windows Terminal：tab 聚焦能力有限** | Windows Terminal 会用一个宿主窗口 / 进程承载多个 tab，Clawd 无法可靠激活其中某一个指定 tab。HUD / Dashboard 终端跳转最适合单独的传统 `cmd.exe` / PowerShell 窗口，或标题里包含项目目录名的独立 Windows Terminal 窗口。Windows 11 上，`cmd.exe` 和 PowerShell 也可能默认被 Windows Terminal 托管；如果要使用传统窗口，需要把默认终端应用程序改为 Windows 控制台主机。 |
| **Windows：hook 的进程信息需要 Clawd 正在运行** | 终端聚焦和会话 PID 来自一次进程树查询，hook 只在 Clawd 真正运行时才做。从 **vNEXT** 起，退出 Clawd 后残留的 CLI hook 不再查询进程树——它只上报已有信息就结束。可见影响是：在 Clawd 关闭期间开始的会话，要等到 Clawd 运行后的下一个事件才有可点击聚焦的目标；Clawd 已经认识的会话会保留此前学到的 PID。强杀 Clawd 后的几秒内、以及 `~/.clawd/runtime.json` 不可读时（Doctor → Local server 会给出警告）同理。升级到 vNEXT 后首次重启 Clawd 之前，旧版 `runtime.json` 没有 owner 字段，hook 会按"Clawd 未运行"处理并省略这些信息——重启一次即可恢复。 |
| **Windows：Clawd 在线时部分 agent 仍会跑一次 PowerShell 进程查询** | 上面那次查询目前仍是一个隐藏的 PowerShell，会读取进程列表，安全软件可能因此告警。**vNEXT** 已经做到：Clawd 未运行时不再执行它，且临时缓存不再保存 agent 的命令行（只保存 `headless` 是/否）。在线路径暂时未变，跟踪于 [#681](https://github.com/rullerzhou-afk/clawd-on-desk/issues/681)、[#627](https://github.com/rullerzhou-afk/clawd-on-desk/issues/627) 和 [#634](https://github.com/rullerzhou-afk/clawd-on-desk/issues/634)。 |
| **macOS/Linux 安装包自动更新** | DMG/AppImage/deb 安装包无法自动更新——使用 `git clone` + `npm start` 可通过 `git pull` 自动更新，或从 GitHub Releases 手动下载。 |
| **Electron 主进程无自动化测试** | 单元测试覆盖了 agent 配置和日志轮询，但状态机、窗口管理、托盘等 Electron 逻辑暂无自动化测试。 |
| **Claude Code：桌宠未运行时工具被自动拒绝** | 桌宠 HTTP 服务未运行时，Clawd 注册的 `PermissionRequest` hook 因 `ECONNREFUSED` 失败，Claude Code 当前会把这种失败当作"用户拒绝"，影响 `Edit`、`Write`、`Bash` 等所有需要权限的工具。这违反 CC 自己的 hooks 文档（声明 HTTP hook 失败应 non-blocking） —— 见 [anthropics/claude-code#46193](https://github.com/anthropics/claude-code/issues/46193)。绕过：保持桌宠运行（推荐），或临时把 `~/.claude/settings.json` 里的 `PermissionRequest` key 重命名以禁用该 hook。 |
| **Claude Code + CC Switch：受保护的自动修复暂停** | Clawd 通常会在其他工具重写 `~/.claude/settings.json` 后自动补回 Claude hooks。但如果文件突然缩水到看起来不安全，Clawd 会暂停自动修复，避免把外部工具的半成品配置固化；Doctor 会把 Claude Code 标为需要 Fix。可通过 **Settings -> Doctor -> Fix**、重启 Clawd，或重新打开「自动管理 Claude hooks」修复。CC Switch 的 Shared Config Snippet 可在同一台机器上携带 Clawd hooks，但这些 hooks 含本机路径和端口，不建议当作跨设备通用片段同步。 |
