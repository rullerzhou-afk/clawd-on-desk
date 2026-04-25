# 状态映射

[返回 README](../README.zh-CN.md)

| 事件 | 状态 | 动画 | Clawd | Calico |
|---|---|---|---|---|
| 无活动 | 待机 | 眼球跟踪 | <img src="../assets/gif/clawd-idle.gif" width="160"> | <img src="../assets/gif/calico-idle.gif" width="130"> |
| 无活动（随机） | 待机 | 看书 / 巡逻 | <img src="../assets/gif/clawd-idle-reading.gif" width="160"> | |
| UserPromptSubmit | 思考 | 思考泡泡 | <img src="../assets/gif/clawd-thinking.gif" width="160"> | <img src="../assets/gif/calico-thinking.gif" width="130"> |
| PreToolUse / PostToolUse | 工作（打字） | 打字 | <img src="../assets/gif/clawd-typing.gif" width="160"> | <img src="../assets/gif/calico-typing.gif" width="130"> |
| PreToolUse（3+ 会话） | 工作（建造） | 建造 | <img src="../assets/gif/clawd-building.gif" width="160"> | <img src="../assets/gif/calico-building.gif" width="130"> |
| SubagentStart（1 个） | 杂耍 | 杂耍 | <img src="../assets/gif/clawd-juggling.gif" width="160"> | <img src="../assets/gif/calico-juggling.gif" width="130"> |
| SubagentStart（2+） | 指挥 | 指挥 | <img src="../assets/gif/clawd-conducting.gif" width="160"> | <img src="../assets/gif/calico-conducting.gif" width="130"> |
| PostToolUseFailure | 报错 | 报错 | <img src="../assets/gif/clawd-error.gif" width="160"> | <img src="../assets/gif/calico-error.gif" width="130"> |
| Stop / PostCompact | 注意 | 开心 | <img src="../assets/gif/clawd-happy.gif" width="160"> | <img src="../assets/gif/calico-happy.gif" width="130"> |
| PermissionRequest | 通知 | 警报 | <img src="../assets/gif/clawd-notification.gif" width="160"> | <img src="../assets/gif/calico-notification.gif" width="130"> |
| PreCompact | 扫地 | 扫地 | <img src="../assets/gif/clawd-sweeping.gif" width="160"> | <img src="../assets/gif/calico-sweeping.gif" width="130"> |
| WorktreeCreate | 搬运 | 搬箱子 | <img src="../assets/gif/clawd-carrying.gif" width="160"> | <img src="../assets/gif/calico-carrying.gif" width="130"> |
| 60 秒无事件 | 睡觉 | 睡眠 | <img src="../assets/gif/clawd-sleeping.gif" width="160"> | <img src="../assets/gif/calico-sleeping.gif" width="130"> |

## Kimi Code CLI（Kimi-CLI）Hook 事件

Kimi Code CLI（Kimi-CLI）现已采用 hook-only 集成（`~/.kimi/config.toml`），下面这 13 个 hook 事件会映射到 Clawd 的共享状态：

| Kimi Hook Event | 状态 |
|---|---|
| SessionStart | idle |
| SessionEnd | sleeping |
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

## 极简模式

拖到屏幕右边缘（或右键 →"极简模式"）进入——半身露出在屏幕边缘，悬停时探出来。

| 触发 | 极简反应 | Clawd | Calico |
|---|---|---|---|
| 默认 | 呼吸 + 眨眼 + 眼球追踪 | <img src="../assets/gif/clawd-mini-idle.gif" width="100"> | <img src="../assets/gif/calico-mini-idle.gif" width="80"> |
| 鼠标悬停 | 探出身体 + 招手 | <img src="../assets/gif/clawd-mini-peek.gif" width="100"> | <img src="../assets/gif/calico-mini-peek.gif" width="80"> |
| 通知 / 权限请求 | 警报弹出 | <img src="../assets/gif/clawd-mini-alert.gif" width="100"> | <img src="../assets/gif/calico-mini-alert.gif" width="80"> |
| 任务完成 | 开心庆祝 | <img src="../assets/gif/clawd-mini-happy.gif" width="100"> | <img src="../assets/gif/calico-mini-happy.gif" width="80"> |

## 点击反应

彩蛋——试试双击、连点 4 下、或反复戳 Clawd，会有隐藏反应。
