# PermissionRequest HTTP hook fail-deny

> **状态（2026-09-18 更新）**：**已由上游修复，本 investigation 归档为历史记录。**
> - 已确认受影响版本：Claude Code **2.1.100**（完整受影响区间未逐版验证）。
> - 上游修复：Claude Code **v2.1.113**。跟踪 [anthropics/claude-code#46193](https://github.com/anthropics/claude-code/issues/46193)；维护者账号在 v2.1.113 起无法复现，Claude contributor 明确回复 "fixed as of v2.1.113"，Issue 以 **Completed** 关闭。报告者在 **v2.1.274** 再次验证不再出现 fail-deny。
> - **影响（仅历史版本）**：桌宠没在跑时，Claude Code 调用 Edit/Write/Bash 等需要权限确认的工具会被自动 deny，用户看到 "tool use was rejected"。
> - **Clawd 侧动作**：**不兜底，也不因该历史问题改权限 hook 策略**。在仍能复现的旧版本上升级 Claude Code 或保持桌宠运行。
> - 下面的证据链、根因与时间线保留原始版本信息，仅用于旧版用户排障，不代表当前行为。

## TL;DR

- CC 2.1.100 给 Edit/Write/Bash 等所有需要权限的工具都发 `PermissionRequest` hook（用 `permission-debug.log` 实证 `tool=Write`）
- CC 官方文档承诺 HTTP hook 连接失败 → non-blocking → execution continues（已 WebFetch 核实原文）
- 实际行为：桌宠没在跑 → 端口 ECONNREFUSED → CC silently denies tool call → 用户看到 "tool use was rejected"
- **实际行为违反 CC 自己的文档** → 当时判定为 CC bug，不是 Clawd 应该兜底的事
- **上游已在 v2.1.113 修复**；本 investigation 到此闭环，不再作为当前限制。

## 现象

桌宠 Electron 主进程**没在跑**时，Claude Code 在任意工作目录里调用 Edit / Write / Bash 等"需要权限确认"的工具，会立刻被自动拒绝，返回如下消息：

> The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).

用户**没有**手动点击拒绝。Claude Code 把"hook 失败"当成了"用户拒绝"。

## 根因

CC 2.1.100 现在给 Edit/Write/Bash 等所有需要权限的工具都发 `PermissionRequest` hook（matcher 与 `PreToolUse` 共享，覆盖所有工具名）。当 hook 配置为 HTTP 类型且端口无人 listen 时，CC 收到 `ECONNREFUSED` 后会 silently deny tool call，而不是按文档承诺的 non-blocking 行为 fall through 到内置 chat prompt。

这违反 CC 自己的 hook 文档（详见下方"证据链"）。Clawd 无锅。

## 证据链

### 1. CC 给 Edit/Write 发 PermissionRequest（实证）

`%APPDATA%/clawd-on-desk/permission-debug.log` 行 `2026-04-10T10:56:59.529Z`：

```
[2026-04-10T10:56:59.529Z] showing bubble: tool=Write session=807e3e37-...
```

`tool=Write` 走了 `/permission` HTTP 端点 → 证明 CC 现在确实给 Write 发 `PermissionRequest`（而不是只给 Bash）。

### 2. CC 文档承诺 HTTP hook 失败 non-blocking

来源：https://code.claude.com/docs/en/hooks（已 WebFetch 核实，2026-04-10）

> Error handling differs from command hooks: non-2xx responses, connection failures, and timeouts all produce non-blocking errors that allow execution to continue. To block a tool call or deny a permission, return a 2xx response with a JSON body containing `decision: "block"` or a `hookSpecificOutput` with `permissionDecision: "deny"`.

并且 HTTP response handling 表格里明确：

> **Connection failure or timeout**: non-blocking error, execution continues

PermissionRequest matcher 覆盖范围（同一份文档）：

> Matches on tool name, same values as PreToolUse.

PreToolUse matcher 接受 `Bash`, `Edit|Write`, `mcp__.*` 等所有工具名。

### 3. 矛盾：实际行为是 fail-closed deny

桌宠没在跑 → 端口 23333 ECONNREFUSED → CC 拒绝 tool call。这与 (2) 矛盾。

## 排除掉的方向（节省未来调查时间）

| 方向 | 排除依据 |
|------|----------|
| `hooks/install.js` 写错了 url/timeout | 历史无回归 commit；桌宠开着时 hook 完全正常工作 |
| timeout 单位从秒变成毫秒 | 文档明确写秒；如果是单位问题桌宠开着也会失败，但日志大量正常 ack |
| `settings.json` json schema 解析错误 | json 合法且其他 hook 段都正常工作 |
| `80a1670` (DND fail-deny 修复) 的回归 | 那个修复改的是桌宠**运行中且 DND** 的代码路径，桌宠没开时根本到不了那段代码 |
| `091bb59` (移除 PreToolUse HTTP hook for Edit/Write) 的回归 | 091bb59 在 CC 旧版本下是对的；是 CC 后来升级把 Edit/Write 也纳入 PermissionRequest |

## 复现

1. 关闭桌宠（菜单退出 / kill electron 进程）
2. 确认 `127.0.0.1:23333` 无监听：`netstat -ano | grep 23333`
3. 在任意工作目录开 Claude Code session
4. 让 Claude 调用 Edit / Write / Bash 工具
5. 观察：立刻被 deny

恢复：开桌宠 → 23333 监听 → hook 正常 → bubble 弹出 → 用户决定。

## 临时绕过（按推荐度）

1. **开桌宠**（已验证）—— 鹿鹿日常本来就开着，最简单
2. **临时屏蔽 hook**：把 `~/.claude/settings.json` 里的 `PermissionRequest` 段重命名为 `_PermissionRequest`（key 改个名让 CC 找不到），走默认 Y/N 询问。**之后必须改回来**，否则桌宠权限气泡整体失效

## 上下文（结案）

最初由鹿鹿 2026-04-10 发现：当时桌宠没开，Edit 调用一直被自动 deny，本以为是 Clawd 的 bug。诊断过程：
- Claude 用 `permission-debug.log` 实证了 CC 给 Write 发 PermissionRequest
- Codex 在 review 中找到了 CC 文档的 non-blocking 承诺
- Claude WebFetch 核实文档原文（两段 quote）
- 搜了 anthropics/claude-code 18 个相关搜索词，确认没人报过
- 鹿鹿决定发 issue (#46193)，不在 Clawd 侧加 workaround

## 未来要做的事（CC 修好后）

- [ ] 监控 anthropics/claude-code#46193 的 status
- [ ] CC 修了之后：
  - 删除 `README.md` / `README.zh-CN.md` 里 Known Limitations 表格的对应行
  - 把这个文档归档（移到 `docs/archive/` 或在标题加 RESOLVED）
  - 顺手更新 `hooks/install.js:248-250` 那条过时注释（"Edit/Write permissions are handled by Claude Code's own permission mode — not our hook"），写明历史脉络

## 不要做的事

不要在 Clawd 侧加 hook fail-deny 的 workaround：
- ❌ command hook wrapper（包一层脚本检测端口）
- ❌ quit-time unregister + start-time register（崩溃路径漏）
- ❌ 强制 auto-start hook 拉起 Electron（用户体验差 + 冷启动竞态）

这些都是在帮 CC 擦屁股。CC 修好后变成废代码 + 维护负债。
