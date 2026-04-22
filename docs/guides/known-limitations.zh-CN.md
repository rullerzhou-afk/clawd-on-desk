# 已知限制

[返回 README](../README.zh-CN.md)

| 限制 | 说明 |
|------|------|
| **Codex CLI：无法跳转终端** | Codex 通过 JSONL 日志轮询，日志中不含终端 PID，点击桌宠无法跳转到 Codex 终端。Claude Code 和 Copilot CLI 正常。 |
| **Codex CLI：Windows hooks 禁用** | Codex 在 Windows 上硬编码禁用了 hooks，因此走日志轮询，延迟约 1.5 秒（hook 方式几乎无延迟）。 |
| **Copilot CLI：需手动配置 hooks** | Copilot 是目前唯一仍需手动创建 `~/.copilot/hooks/hooks.json` 的受支持 Agent。 |
| **Copilot CLI：无权限气泡** | Copilot 的 `preToolUse` 只支持拒绝，无法做完整的允许/拒绝审批流。权限气泡目前支持 Claude Code、CodeBuddy 和 opencode。 |
| **Gemini CLI：无 working 状态** | Gemini 的 session JSON 只记录已完成消息，不包含进行中的工具执行。桌宠会从 thinking 直接跳到 happy/error，工作中没有打字动画。 |
| **Gemini CLI：无权限气泡** | Gemini 在终端内处理工具审批。文件轮询无法拦截或展示审批请求。 |
| **Gemini CLI：无法跳转终端** | Session JSON 不携带终端 PID，和 Codex 一样无法做终端聚焦。 |
| **Gemini CLI：轮询延迟** | 约 1.5 秒轮询间隔，另加 4 秒延迟窗口用于批量处理工具完成信号，明显慢于 hook 驱动的 agent。 |
| **Cursor Agent：无权限气泡** | Cursor 在 hook 的 stdout JSON 里处理权限，而不是走 HTTP 阻塞式审批，Clawd 无法接管这条审批链路。 |
| **Cursor Agent：启动恢复能力有限** | 启动时不做进程检测，否则任意 Cursor 编辑器进程都可能误判为活跃会话。Clawd 会保持 idle，直到收到第一条 hook 事件。 |
| **Kiro CLI：无法区分会话** | Kiro CLI stdin JSON 不含 session_id，所有 Kiro 会话会被合并为单个追踪会话。 |
| **Kiro CLI：无 SessionEnd 事件** | Kiro CLI 没有 SessionEnd 事件，Clawd 无法检测 Kiro 会话结束。 |
| **Kiro CLI：无 subagent 检测** | Kiro CLI 没有 subagent 事件，不会触发杂耍/指挥动画。 |
| **Kiro CLI：终端权限确认仍在终端处理** | macOS 与 Windows 上 Kiro 的状态 hooks 已验证可用；但当 Kiro 显示 `t / y / n` 这类原生权限确认时，当前仍需在终端里处理，Clawd 不接管这类确认。 |
| **opencode：子会话菜单短暂污染** | opencode 通过 `task` 工具分派并行子代理时，子会话会在 Sessions 子菜单里短暂出现（5-8 秒），完成后自动清理。纯视觉问题，不影响建筑动画。 |
| **opencode：终端聚焦锚定启动窗口** | Plugin 跑在 opencode 进程内，`source_pid` 指向启动 opencode 的那个终端。如果你用 `opencode attach` 从另一个窗口接入，点击桌宠只会聚焦到最初的启动窗口。 |
| **macOS/Linux 安装包自动更新** | DMG/AppImage/deb 安装包无法自动更新——使用 `git clone` + `npm start` 可通过 `git pull` 自动更新，或从 GitHub Releases 手动下载。 |
| **Electron 主进程无自动化测试** | 单元测试覆盖了 agent 配置和日志轮询，但状态机、窗口管理、托盘等 Electron 逻辑暂无自动化测试。 |
| **Claude Code：桌宠未运行时工具被自动拒绝** | 桌宠 HTTP 服务未运行时，Clawd 注册的 `PermissionRequest` hook 因 `ECONNREFUSED` 失败，Claude Code 当前会把这种失败当作"用户拒绝"，影响 `Edit`、`Write`、`Bash` 等所有需要权限的工具。这违反 CC 自己的 hooks 文档（声明 HTTP hook 失败应 non-blocking） —— 见 [anthropics/claude-code#46193](https://github.com/anthropics/claude-code/issues/46193)。绕过：保持桌宠运行（推荐），或临时把 `~/.claude/settings.json` 里的 `PermissionRequest` key 重命名以禁用该 hook。 |
