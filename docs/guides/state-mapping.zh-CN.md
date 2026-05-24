# 状态映射

[返回 README](../../README.zh-CN.md)

大多数 agent 生命周期事件会映射到同一组 Clawd 状态。

Subagent 事件仍映射到逻辑 `juggling` 状态，但 Clawd 主题现在会按 live 子代理数量选择分层素材：1 个子代理使用 `clawd-headphones-groove.svg`，2 个以上使用 `clawd-working-juggling.svg`。旧版 Clawd conducting 素材已退役；Calico 和云宝的 2+ 子代理分层仍使用各自的 conducting 动画。

| 事件 | 状态 | 动画 | Clawd | Calico | 云宝 |
|---|---|---|---|---|---|
| 无活动 | 待机 | 眼球跟踪 | <img src="../../assets/gif/clawd-idle.gif" width="160"> | <img src="../../assets/gif/calico-idle.gif" width="130"> | <img src="../../assets/gif/cloudling-idle.gif" width="140"> |
| 无活动（随机） | 待机 | 看书 / 巡逻 | <img src="../../assets/gif/clawd-idle-reading.gif" width="160"> | | <img src="../../assets/gif/cloudling-idle-reading.gif" width="140"> |
| UserPromptSubmit | 思考 | 思考泡泡 + 灵感闪光 | <img src="../../assets/gif/clawd-thinking.gif" width="160"> | <img src="../../assets/gif/calico-thinking.gif" width="130"> | <img src="../../assets/gif/cloudling-thinking.gif" width="140"> |
| PreToolUse / PostToolUse（1 个会话） | 工作（打字） | 打字 | <img src="../../assets/gif/clawd-typing.gif" width="160"> | <img src="../../assets/gif/calico-typing.gif" width="130"> | <img src="../../assets/gif/cloudling-typing.gif" width="140"> |
| PreToolUse / PostToolUse（2 个会话） | 工作（2 会话分层） | 耳机律动 | <img src="../../assets/gif/clawd-headphones-groove.gif" width="160"> | <img src="../../assets/gif/calico-juggling.gif" width="130"> | <img src="../../assets/gif/cloudling-juggling.gif" width="140"> |
| PreToolUse（3+ 会话） | 工作（建造） | 建造 | <img src="../../assets/gif/clawd-building.gif" width="160"> | <img src="../../assets/gif/calico-building.gif" width="130"> | <img src="../../assets/gif/cloudling-building.gif" width="140"> |
| SubagentStart（1 个） | 杂耍 | 耳机律动 | <img src="../../assets/gif/clawd-headphones-groove.gif" width="160"> | <img src="../../assets/gif/calico-juggling.gif" width="130"> | <img src="../../assets/gif/cloudling-juggling.gif" width="140"> |
| SubagentStart（2+） | 杂耍（2+ 分层） | 三球杂耍 | <img src="../../assets/gif/clawd-juggling.gif" width="160"> | <img src="../../assets/gif/calico-conducting.gif" width="130"> | <img src="../../assets/gif/cloudling-conducting.gif" width="140"> |
| PostToolUseFailure | 报错 | 报错 | <img src="../../assets/gif/clawd-error.gif" width="160"> | <img src="../../assets/gif/calico-error.gif" width="130"> | <img src="../../assets/gif/cloudling-error.gif" width="140"> |
| Stop / PostCompact | 注意 | 开心 | <img src="../../assets/gif/clawd-happy.gif" width="160"> | <img src="../../assets/gif/calico-happy.gif" width="130"> | <img src="../../assets/gif/cloudling-attention.gif" width="140"> |
| PermissionRequest | 通知 | 警报 | <img src="../../assets/gif/clawd-notification.gif" width="160"> | <img src="../../assets/gif/calico-notification.gif" width="130"> | <img src="../../assets/gif/cloudling-notification.gif" width="140"> |
| PreCompact | 扫地 | 扫地 | <img src="../../assets/gif/clawd-sweeping.gif" width="160"> | <img src="../../assets/gif/calico-sweeping.gif" width="130"> | <img src="../../assets/gif/cloudling-sweeping.gif" width="140"> |
| WorktreeCreate | 搬运 | 搬箱子 | <img src="../../assets/gif/clawd-carrying.gif" width="160"> | <img src="../../assets/gif/calico-carrying.gif" width="130"> | <img src="../../assets/gif/cloudling-carrying.gif" width="140"> |
| 60 秒鼠标静止 | 睡觉 | 睡眠 | <img src="../../assets/gif/clawd-sleeping.gif" width="160"> | <img src="../../assets/gif/calico-sleeping.gif" width="130"> | <img src="../../assets/gif/cloudling-sleeping.gif" width="140"> |
| SessionEnd | 删除会话；无其他 live 会话时回到 idle | 不触发睡眠过渡 | | | |

## Kimi Code CLI（Kimi-CLI）Hook 事件

Kimi Code CLI（Kimi-CLI）现已采用 hook-only 集成（`~/.kimi/config.toml`），下面这 13 个 hook 事件会映射到 Clawd 的共享状态：

| Kimi Hook Event | 状态 |
|---|---|
| SessionStart | idle |
| SessionEnd | 删除会话；无其他 live 会话时回到 idle |
| UserPromptSubmit | thinking |
| PreToolUse | 默认映射到 working。只有在 payload 中出现明确审批信号（`permission_required` / `requires_approval` / `waiting_for_approval` / `is_permission_request`）时，才会切到 permission 类动画。持久化模式开关：`CLAWD_KIMI_PERMISSION_MODE=explicit`（默认，仅显式信号触发 notification）或 `CLAWD_KIMI_PERMISSION_MODE=suspect`（对 gated tool 使用延迟启发式判断）。安装脚本（`npm run install:kimi-hooks` 以及启动时自动同步）会把这个值写进 `~/.kimi/config.toml` 中每个 Kimi hook 的 `command` 字段，所以重启 Clawd 后仍会保留。其他可选开关：`CLAWD_KIMI_PERMISSION_IMMEDIATE=1` 可对权限工具强制立即映射；`CLAWD_KIMI_PERMISSION_SUSPECT=1`（旧别名）只对当前进程开启 suspect mode；`CLAWD_KIMI_PERMISSION_SUSPECT_MS=<ms>` 可调 suspect 窗口；`CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION=1` 会在开启可选模式时仍保持 explicit-only 行为。 |
| PostToolUse | working |
| PostToolUseFailure | error |
| Stop | attention |
| StopFailure | error |
| SubagentStart | juggling |
| SubagentStop | working |
| PreCompact | sweeping |
| PostCompact | attention |
| Notification | notification |

## Pi Extension 事件

Pi 使用全局 extension（`~/.pi/agent/extensions/clawd-on-desk`），会把交互式会话生命周期事件映射到 Clawd 的共享状态：

| Pi Extension Event | Clawd Event | 状态 |
|---|---|---|
| session_start | SessionStart | idle |
| before_agent_start | UserPromptSubmit | thinking |
| tool_call | PreToolUse | working |
| tool_result (ok) | PostToolUse | working |
| tool_result (isError) | PostToolUseFailure | error |
| agent_end | Stop | attention |
| session_before_compact | PreCompact | sweeping |
| session_compact | PostCompact | attention |
| session_shutdown | SessionEnd | 删除会话；无其他 live 会话时回到 idle |

Pi 当前在 Clawd 中是 state-only 集成：Clawd 不接管权限、不新增确认弹窗，Pi 保持默认 YOLO 执行行为。

## 极简模式

拖到屏幕右边缘（或右键 →"极简模式"）进入——半身露出在屏幕边缘，悬停时探出来。

| 触发 | 极简反应 | Clawd | Calico | 云宝 |
|---|---|---|---|---|
| 默认 | 呼吸 + 眨眼 + 眼球追踪 | <img src="../../assets/gif/clawd-mini-idle.gif" width="100"> | <img src="../../assets/gif/calico-mini-idle.gif" width="80"> | <img src="../../assets/gif/cloudling-mini-idle.gif" width="90"> |
| 鼠标悬停 | 探出身体 + 招手 | <img src="../../assets/gif/clawd-mini-peek.gif" width="100"> | <img src="../../assets/gif/calico-mini-peek.gif" width="80"> | <img src="../../assets/gif/cloudling-mini-peek.gif" width="90"> |
| 通知 / 权限请求 | 警报弹出 | <img src="../../assets/gif/clawd-mini-alert.gif" width="100"> | <img src="../../assets/gif/calico-mini-alert.gif" width="80"> | <img src="../../assets/gif/cloudling-mini-alert.gif" width="90"> |
| 任务完成 | 开心庆祝 | <img src="../../assets/gif/clawd-mini-happy.gif" width="100"> | <img src="../../assets/gif/calico-mini-happy.gif" width="80"> | <img src="../../assets/gif/cloudling-mini-happy.gif" width="90"> |

## 点击反应

彩蛋——试试双击、连点 4 下、或反复戳 Clawd，会有隐藏反应。
