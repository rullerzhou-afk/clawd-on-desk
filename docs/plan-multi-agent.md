# M3 多 Agent 适配器架构 — 实施方案

## Context

Clawd 桌宠目前硬编码绑定 Claude Code。所有事件映射、进程检测、hook 注册都写死在 main.js 和 hook 脚本里。本次重构的目标是抽象出 Agent 适配层，让支持新 agent（Codex CLI、Copilot CLI）只需新增配置文件 + 事件源模块，不碰核心状态机逻辑。

**核心约束**：
- 不搞重度 OOP 适配器，用配置驱动
- Claude Code 集成零 regression
- Codex 走 JSONL 日志轮询（Windows hooks 完全禁用）
- Copilot CLI 走 hook（与 Claude Code 同路径，事件集高度相似）
- 所有 agent 的事件最终汇入同一个 `updateSession()` 流程

---

## 三个 Agent 对比

| 特性 | Claude Code | Codex CLI | Copilot CLI |
|------|------------|-----------|-------------|
| 事件源 | command hook + HTTP hook | JSONL 日志轮询 | command hook |
| Hook 事件数 | 14 | 4（Windows 禁用） | 10 |
| Windows hooks | 正常 | **禁用** | 正常 |
| 权限审批 | HTTP hook blocking | 不支持 | 不支持（preToolUse 仅 deny） |
| SubagentStart/Stop | 有 | 无 | 有 |
| SessionEnd | 有 | 无（靠超时） | 有 |
| 进程名 | `claude.exe` / `claude` | `codex.exe` / `codex` | `copilot.exe` / `copilot` |
| Hook 配置位置 | `~/.claude/settings.json` | `~/.codex/hooks.json` | 项目目录 `hooks.json` 或 `hooks/hooks.json` |
| Hook 事件名风格 | PascalCase（`PreToolUse`） | PascalCase | camelCase（`preToolUse`） |
| stdin JSON | `{ session_id, cwd }` | 同左 | `{ sessionId, timestamp, cwd, toolName, toolArgs }` |

---

## Phase 1：新增文件

### 1.1 `agents/claude-code.js` — Claude Code 配置

从 main.js / clawd-hook.js 提取硬编码常量：

```javascript
module.exports = {
  id: "claude-code",
  name: "Claude Code",
  processNames: { win: ["claude.exe"], mac: ["claude"] },
  nodeCommandPatterns: ["claude-code", "@anthropic-ai"],
  eventSource: "hook",
  eventMap: {
    SessionStart: "idle", SessionEnd: "sleeping",
    UserPromptSubmit: "thinking",
    PreToolUse: "working", PostToolUse: "working", PostToolUseFailure: "error",
    Stop: "attention", SubagentStart: "juggling", SubagentStop: "working",
    PreCompact: "sweeping", PostCompact: "attention",
    Notification: "notification", Elicitation: "notification",
    WorktreeCreate: "carrying",
  },
  capabilities: { httpHook: true, permissionApproval: true, sessionEnd: true, subagent: true },
  pidField: "claude_pid",
};
```

### 1.2 `agents/codex.js` — Codex CLI 配置

```javascript
module.exports = {
  id: "codex",
  name: "Codex CLI",
  processNames: { win: ["codex.exe"], mac: ["codex"] },
  nodeCommandPatterns: [],
  eventSource: "log-poll",
  logEventMap: {
    "session_meta": "idle",
    "event_msg:task_started": "thinking",
    "event_msg:user_message": "thinking",
    "event_msg:agent_message": "working",
    "response_item:function_call": "working",
    "response_item:custom_tool_call": "working",
    "event_msg:task_complete": "attention",
    "event_msg:context_compacted": "sweeping",
    "event_msg:turn_aborted": "idle",
  },
  capabilities: { httpHook: false, permissionApproval: false, sessionEnd: false, subagent: false },
  logConfig: {
    sessionDir: "~/.codex/sessions",
    filePattern: "rollout-*.jsonl",
    pollIntervalMs: 1500,
  },
  pidField: "codex_pid",
};
```

### 1.3 `agents/copilot-cli.js` — Copilot CLI 配置

```javascript
module.exports = {
  id: "copilot-cli",
  name: "Copilot CLI",
  processNames: { win: ["copilot.exe"], mac: ["copilot"] },
  nodeCommandPatterns: ["@github/copilot"],
  eventSource: "hook",
  // Copilot CLI 用 camelCase 事件名，hook 脚本内部做映射
  eventMap: {
    sessionStart: "idle", sessionEnd: "sleeping",
    userPromptSubmitted: "thinking",
    preToolUse: "working", postToolUse: "working", errorOccurred: "error",
    agentStop: "attention",
    subagentStart: "juggling", subagentStop: "working",
    preCompact: "sweeping",
  },
  capabilities: {
    httpHook: false,            // 无 HTTP hook type
    permissionApproval: false,  // preToolUse 只能 deny，不能做 bubble 审批
    sessionEnd: true,
    subagent: true,
  },
  hookConfig: {
    // Copilot CLI hooks 放在项目目录的 hooks.json 或 hooks/hooks.json
    // 注册方式与 Claude Code 不同——不写全局 settings，而是写项目级 hooks.json
    configFormat: "project-hooks-json",
  },
  // stdin JSON 字段名是 camelCase（sessionId 而非 session_id）
  stdinFormat: "camelCase",
  pidField: "copilot_pid",
};
```

### 1.4 `agents/registry.js` — Agent 注册中心

加载所有 agent 配置，提供查询 API：
- `getAllAgents()` → 返回配置数组
- `getAgent(id)` → 按 id 查询
- `getAllProcessNames()` → 聚合所有 agent 进程名（供 detectRunningAgentProcesses 用）

### 1.5 `agents/codex-log-monitor.js` — Codex JSONL 日志轮询

**核心机制**：
- `setInterval` 每 1.5s 轮询 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
- **同时扫描今天和昨天的目录**（处理跨午夜的活跃会话）
- 增量读取：记录每个文件的 byte offset，只处理新追加的行
- 处理不完整行：保留尾部 partial line 到下次轮询拼接
- 事件映射：`type` + `payload.type` 组合查 `logEventMap`
- 回调注入 `updateSession()`

**会话生命周期**：
- 新文件出现 + `session_meta` → 新会话 idle
- `task_complete` + 30s 无新内容 → 会话结束
- codex.exe 进程不在 → 孤儿清理（复用 isProcessAlive）

**会话 ID 命名空间**：前缀 `codex:` 防碰撞，如 `codex:019d23d4-...`

**CWD**：从 `session_meta.payload.cwd` 字段获取

**不支持的功能**（Phase 1 跳过）：
- Codex 终端聚焦（日志无 PID，session 菜单条目 disabled）
- Codex PID 精确关联（退回文件 mtime 超时清理）

### 1.6 `hooks/copilot-hook.js` — Copilot CLI hook 脚本

复制 `clawd-hook.js` 结构，适配 Copilot CLI 的差异：

**与 clawd-hook.js 的区别**：
- 事件名 camelCase（`preToolUse` vs `PreToolUse`）
- stdin JSON 字段名 camelCase（`sessionId` vs `session_id`，`toolName` vs `tool_name`）
- 进程检测：查找 `copilot.exe` / `copilot` 或 `node.exe` running `@github/copilot`
- body 发送 `agent_id: "copilot-cli"` 和 `copilot_pid`
- 不需要处理 PermissionRequest（Copilot 无 HTTP hook）

**可以共享的逻辑**：
- `getStablePid()` 的进程树遍历核心逻辑完全相同
- HTTP POST 到 `127.0.0.1:23333/state` 的发送逻辑相同
- stdin 超时保护（400ms）相同

**实现策略**：不搞共享模块（hook 脚本必须零依赖），直接复制 `clawd-hook.js` 改差异部分。约 190 行。

---

## Phase 2：main.js 改动

### 2.0 package.json 打包配置（BLOCKER）

`files` 数组必须加入 `"agents/**/*"`，否则打包后 require 会崩：

```json
"files": [
  "src/**/*",
  "assets/svg/**/*",
  "assets/tray-icon*.png",
  "hooks/**/*",
  "extensions/**/*",
  "agents/**/*"
]
```

### 2.1 新增 import（顶部）

```javascript
const { getAgent, getAllProcessNames } = require("../agents/registry");
const CodexLogMonitor = require("../agents/codex-log-monitor");
```

### 2.2 Session 对象结构（第 214 行）

`claudePid` → `agentPid`，新增 `agentId` 字段。

约 8 处引用需更新：
- `updateSession()` 签名和函数体（第 696-764 行）
- `cleanStaleSessions()` 第 779 行 `s.claudePid` → `s.agentPid`
- `/state` 端点第 1224-1233 行解析逻辑

### 2.3 `updateSession()` 签名扩展（第 696 行）

```
- function updateSession(sessionId, state, event, sourcePid, cwd, editor, pidChain, claudePid)
+ function updateSession(sessionId, state, event, sourcePid, cwd, editor, pidChain, agentPid, agentId)
```

内部 `claudePid` → `agentPid`，session 对象写入 `agentId`。
现有所有分支逻辑不变（PermissionRequest 判断、SessionEnd、SubagentStop 保护等）。

### 2.4 `detectRunningClaudeProcesses()` → `detectRunningAgentProcesses()`（第 828 行）

重写搜索条件，同时检测三个 agent：

```
Windows: wmic ... "(Name='node.exe' and CommandLine like '%claude-code%') or Name='claude.exe' or Name='codex.exe' or Name='copilot.exe'"
macOS:   pgrep -f 'claude-code|codex|copilot'
```

所有调用处（第 816 行、第 2102 行）改用新函数名。

### 2.5 `/state` 端点向后兼容（第 1206 行）

同时接受 `claude_pid` 和 `agent_pid` 字段（优先后者）。
新增 `agent_id` 字段解析，默认 `"claude-code"`（向后兼容旧 hook 脚本）。

### 2.6 Codex Monitor 启动（`app.whenReady()` 附近）

```javascript
const codexAgent = getAgent("codex");
const codexMonitor = new CodexLogMonitor(codexAgent, (sid, state, event, extra) => {
  updateSession(sid, state, event, extra.sourcePid, extra.cwd, null, null, extra.agentPid, "codex");
});
codexMonitor.start();
// before-quit 里 codexMonitor.stop()
```

### 2.7 Session 菜单 agent badge

`buildSessionSubmenu()` 中，当存在多种 agent 会话时，显示 `[Codex]` / `[Copilot]` 前缀。

---

## Phase 3：Hook 脚本改动

### 3.1 clawd-hook.js

`send()` 函数（第 155-186 行）HTTP body 新增字段：

```javascript
body.agent_id = "claude-code";
body.agent_pid = _claudePid;    // 新字段名
if (_claudePid) body.claude_pid = _claudePid;  // 保留旧字段，向后兼容
```

其余逻辑（EVENT_TO_STATE、getStablePid、stdin 解析）不改。

### 3.2 copilot-hook.js（新建）

复制 clawd-hook.js，修改以下差异：

```javascript
// 事件映射表（camelCase）
const EVENT_TO_STATE = {
  sessionStart: "idle", sessionEnd: "sleeping",
  userPromptSubmitted: "thinking",
  preToolUse: "working", postToolUse: "working", errorOccurred: "error",
  agentStop: "attention",
  subagentStart: "juggling", subagentStop: "working",
  preCompact: "sweeping",
};

// 进程检测
const COPILOT_NAMES_WIN = new Set(["copilot.exe"]);
const COPILOT_NAMES_MAC = new Set(["copilot"]);

// stdin JSON 字段名（camelCase）
sessionId = payload.sessionId || "default";  // 而非 payload.session_id
cwd = payload.cwd || "";

// HTTP body
body.agent_id = "copilot-cli";
body.agent_pid = _copilotPid;  // 而非 _claudePid
```

---

## Phase 4：install.js 改动

扩展 `registerHooks()` 支持 Copilot CLI hooks 注册。

**Copilot CLI 的 hooks 配置方式不同**：
- Claude Code：写入全局 `~/.claude/settings.json`
- Copilot CLI：写入项目目录的 `hooks.json`（或 `hooks/hooks.json`）

**暂不自动注册 Copilot hooks**。原因：
1. Copilot hooks 是项目级的，不是全局的——我们不应该自动往用户的每个项目写 hooks.json
2. 用户可以手动在需要的项目里创建 hooks.json

**替代方案**：在右键菜单或托盘菜单加一个"Install Copilot Hooks for this project"选项，让用户主动触发。这个放到 Phase 2 实现。

---

## 不改的部分

| 模块 | 原因 |
|------|------|
| STATE_SVGS / STATE_PRIORITY / AUTO_RETURN_MS | 状态和动画是 agent 无关的 |
| resolveDisplayState() | 纯优先级逻辑，agent 无关 |
| getWorkingSvg() / getJugglingSvg() | 基于 session 计数，agent 无关 |
| 权限 bubble 系统 | Codex/Copilot 不发 PermissionRequest，不会触发 |
| 睡眠序列 / 眼球追踪 / Mini Mode | 全部 agent 无关 |
| hooks/auto-start.js | 已经是 agent 无关的（只检查 HTTP 健康） |

---

## 关键文件清单

| 文件 | 操作 | 改动量 |
|------|------|--------|
| `agents/claude-code.js` | 新建 | ~30 行 |
| `agents/codex.js` | 新建 | ~35 行 |
| `agents/copilot-cli.js` | 新建 | ~40 行 |
| `agents/registry.js` | 新建 | ~25 行 |
| `agents/codex-log-monitor.js` | 新建 | ~180 行 |
| `hooks/copilot-hook.js` | 新建 | ~190 行（复制 clawd-hook.js 改差异） |
| `src/main.js` | 修改 | ~40 行改动（重命名 + 新增初始化） |
| `hooks/clawd-hook.js` | 修改 | ~3 行（body 加字段） |
| `package.json` | 修改 | 1 行（files 加 agents） |

---

## 验证计划

1. **Claude Code 回归测试**：启动 Clawd + 开一个 Claude Code 会话，验证 idle → thinking → working → attention 流转正常，权限 bubble 正常弹出
2. **Codex 集成测试**：启动 Clawd + 在另一个终端运行 `codex exec --full-auto "list files"`，观察桌宠从 idle 变为 thinking → working → attention
3. **Copilot CLI 集成测试**：在项目目录放 hooks.json，运行 `copilot -p "list files" --allow-all`，观察桌宠状态变化
4. **多 agent 共存**：同时运行 Claude Code 和 Codex/Copilot，验证会话独立追踪，右键菜单显示 agent badge
5. **Codex 会话清理**：Codex 任务完成后 30s，确认会话被清理，桌宠回到 idle/睡眠
6. **向后兼容**：不更新 clawd-hook.js 的情况下启动（模拟旧版 hook），确认 `/state` 端点仍正常工作
7. **无 Codex/Copilot 环境**：未安装时，确认轮询模块和 hook 安静失败不报错

---

## 风险

| 风险 | 应对 |
|------|------|
| Codex JSONL 格式变更 | 映射集中在 codex.js，改一处 |
| 日志文件大（90K+ 一个 session） | 增量读取，只处理新字节 |
| `claude_pid` → `agent_pid` 兼容 | /state 同时接受两个字段名 |
| 无 Codex/Copilot 的环境报错 | try-catch 包裹初始化 |
| 打包后 agents/ 缺失 | package.json `files` 必须加 `"agents/**/*"` |
| 跨午夜目录切换 | 轮询模块同时扫今天和昨天的目录 |
| Codex 用户中断（Ctrl+C） | `logEventMap` 加 `"event_msg:turn_aborted": "idle"` |
| Copilot hooks 注册方式不同 | 暂不自动注册，提供手动安装选项 |
| Copilot stdin JSON camelCase | hook 脚本内部处理，不影响 /state 端点 |

---

## 调研结论（2026-03-25）

### Codex CLI

- **JSONL 日志路径**：`~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<session-id>.jsonl`
- **每条 record**：`{ timestamp, type, payload }`
- **15 种 record type**，映射 6 种桌宠状态
- **Hooks**：Windows 完全禁用，仅 4 个事件，PreToolUse 只能 deny
- **结论**：Windows 上必须走 JSONL 轮询

### Copilot CLI

- **版本**：v1.0.11（2026-02-25 GA）
- **Hooks 配置**：项目目录 `hooks.json` 或 `hooks/hooks.json`（非全局配置）
- **10 个 hook 事件**：sessionStart, sessionEnd, userPromptSubmitted, preToolUse, postToolUse, errorOccurred, agentStop, subagentStart, subagentStop, preCompact
- **stdin JSON**：camelCase 字段名（`sessionId`, `toolName`, `toolArgs`）
- **preToolUse**：支持 deny + modifiedArgs（比 Codex 强，但仍无法做 bubble 审批）
- **Windows hooks**：正常工作
- **Session 事件 schema**：97+ 种事件类型（`session-events.schema.json`，292KB）
- **结论**：走 hook 路径，与 Claude Code 同架构，成本最低
