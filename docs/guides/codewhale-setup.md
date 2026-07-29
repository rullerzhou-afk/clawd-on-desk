# CodeWhale 适配 Clawd on Desk — 完整开发文档

> 基准：Clawd on Desk v0.8.1（fork from rullerzhou-afk/clawd-on-desk）
> 日期：2026-06-02 ~ 2026-06-03；review 修复：2026-06-11
> 状态：**Phase 1 完成，review 反馈已修复，Phase 2 搁置**

---

## 目录

1. [目标](#1-目标)
2. [已实现功能（Phase 1）](#2-已实现功能phase-1)
3. [文件改动清单](#3-文件改动清单)
4. [新增文件详解](#4-新增文件详解)
5. [修改文件详解](#5-修改文件详解)
6. [事件映射表](#6-事件映射表)
7. [已知限制与未实现功能](#7-已知限制与未实现功能)
8. [常见问题排查](#8-常见问题排查)
9. [使用说明](#9-使用说明)

---

## 1. 目标

让 Clawd on Desk（桌面宠物）能够感知并动画化 CodeWhale 的运行时状态。CodeWhale 是一个基于 DeepSeek API 的 AI 编程代理（TUI/CLI），运行在终端中。

核心目标：
- CodeWhale 开启/结束会话 → 螃蟹 idle/sleeping
- 用户输入 prompt → 螃蟹 thinking
- 调用工具（读文件、写文件、执行命令等）→ 螃蟹 working
- 切换模式/压缩上下文 → 螃蟹 sweeping/attention
- 出错 → 螃蟹 error

---

## 2. 已实现功能（Phase 1：State-Only 集成）

### 2.1 状态感知

螃蟹根据 CodeWhale 的生命周期事件自动切换动画：

| CodeWhale 事件 | 螃蟹动画 | 触发时机 |
|---|---|---|
| `session_start` | idle（空闲） | 启动 CodeWhale 或新建会话 |
| `session_end` | sleeping（睡觉） | 退出 CodeWhale |
| `message_submit` | thinking（思考泡泡） | 用户输入 prompt |
| `tool_call_before` | working（打字/建造） | 工具调用前 |
| `tool_call_after`（成功） | working | 工具调用成功 |
| `tool_call_after`（失败） | error | 工具调用失败 |
| `mode_change`（compact） | sweeping（扫地） | 上下文压缩 |
| `mode_change`（其他） | attention（感叹号） | agent/plan/yolo 切换 |
| `on_error` | error | CodeWhale 发生错误 |

### 2.2 按需安装与同步

- 全新安装默认不会写入 CodeWhale hooks；需要本机 CodeWhale 追踪时，先到 **Settings → Agents → CodeWhale → Install** 安装并启用集成
- 安装且启用后，Clawd 启动时会继续同步 7 个 hooks 条目到 `~/.codewhale/config.toml`
- Settings / Doctor 的 Fix / Repair 会手动重新同步；`npm run install:codewhale-hooks` 仍可用于调试或预注册
- 卸载支持（`npm run uninstall:codewhale-hooks`）

### 2.3 会话标签优化

- HUD 显示 `CodeWhale` 而非工作空间目录名
- 稳定 session ID 缓存：切换模式等无 session id 的事件不会创建重复标签

---

## 3. 文件改动清单

### 3.1 新增文件（4 个）

| 文件 | 行数 | 用途 |
|---|---|---|
| `agents/codewhale.js` | ~40 | Agent 元数据配置 |
| `hooks/codewhale-hook.js` | ~210 | 生命周期 hook 脚本（事件翻译 + HTTP POST） |
| `hooks/codewhale-install.js` | ~350 | 安装脚本（读写 `~/.codewhale/config.toml`） |
| `assets/icons/agents/codewhale.png` | — | 64×64 runtime agent PNG |

### 3.2 修改文件（核心）

| 文件 | 改动行数 | 改动内容 |
|---|---|---|
| `agents/registry.js` | +2 | require + AGENTS 数组注册 |
| `src/prefs.js` | +1 | agents 默认值白名单 |
| `src/integration-sync.js` | +18 | `syncCodewhaleHooks()` 自动同步函数 |
| `src/server-agent-id.js` | +1 | `HOOK_SOURCE_AGENT_IDS` 注册 |
| `src/settings-actions-agents.js` | +1 | `AUTO_REPAIRABLE_AGENT_IDS` |
| `src/settings-agent-order.js` | +1 | `NON_COLLAPSIBLE` 排序 |
| `src/i18n.js` | +5 | 5 种语言的 eventSource 翻译键 |
| `hooks/codewhale-install.js` | 多行 | 幂等注册、legacy orphan cleanup、Windows command quoting、CodeWhale config path resolver |
| `hooks/codewhale-hook.js` | 多行 | session_title + 稳定 session id + session 缓存 + 可测试入口 |
| `src/doctor-detectors/agent-descriptors.js` | 多行 | CodeWhale descriptor |
| `src/doctor-detectors/agent-integrations.js` | 多行 | `codewhale-hooks-toml` Doctor 检查 |
| `hooks/cleanup-integrations.js` | 多行 | managed cleanup 接入 CodeWhale |
| `package.json` | 1 行 | 保留 `npm start` 的 sidecar preflight |

---

## 4. 新增文件详解

### 4.1 `agents/codewhale.js` — Agent 配置

```js
module.exports = {
  id: "codewhale",
  name: "CodeWhale",
  processNames: { win: ["codewhale.exe"], mac: ["codewhale"], linux: ["codewhale"] },
  eventSource: "hook",
  eventMap: { ... },         // snake_case → PascalCase + 动画状态
  capabilities: {
    permissionApproval: false, // Phase 2 需 CodeWhale 源码改动
    sessionEnd: true,
    subagent: false,
  },
  pidField: "codewhale_pid",
};
```

关键字段：
- `eventSource: "hook"` — 告诉 Clawd 此 agent 通过 hooks 感知事件（区别于 `"log-poll"` / `"plugin-event"` / `"extension"`）
- `capabilities.sessionEnd: true` — 会话结束时 Clawd 显示 sleeping 动画而非隐藏
- `permissionApproval: false` — Phase 2（权限审批气泡）需要 CodeWhale 源码改动

### 4.2 `hooks/codewhale-hook.js` — Hook 脚本

这是整合同的核心文件。CodeWhale 在每次生命周期事件触发时调用此脚本。

**架构**：
```
CodeWhale → 设置环境变量 → 调用 hook 脚本 → 翻译事件 → POST /state → Clawd
```

**环境变量**（CodeWhale 传入）：
| 变量 | 含义 | 事件 |
|---|---|---|
| `DEEPSEEK_SESSION_ID` | 会话 ID | 大部分事件 |
| `DEEPSEEK_TOOL_NAME` | 工具名称 | tool_call_before/after |
| `DEEPSEEK_TOOL_SUCCESS` | 工具是否成功 | tool_call_after |
| `DEEPSEEK_MODE` | 当前模式 | mode_change |
| `DEEPSEEK_PREVIOUS_MODE` | 上一个模式 | mode_change |
| `DEEPSEEK_WORKSPACE` | 工作空间路径 | session_start 等 |
| `DEEPSEEK_MODEL` | 模型名称 | session_start 等 |
| `DEEPSEEK_ERROR` | 错误信息 | on_error |

**稳定 Session ID 缓存**：

`mode_change` 等事件可能不带 `DEEPSEEK_SESSION_ID`，如果不处理会导致 Clawd HUD 出现重复标签。解决方案：
1. 首次事件时生成 session id → 写入 `/tmp/codewhale-hook-session`
2. 后续事件从缓存读取
3. `session_end` 时清除缓存

**session_title 覆盖**：

Clawd 默认用 `path.basename(cwd)` 作为 HUD 标签，即工作空间目录名（如 `claude_on_desk`）。hook 脚本通过 `session_title: "CodeWhale"` 覆盖，使 HUD 显示正确的 agent 名。

### 4.3 `hooks/codewhale-install.js` — 安装脚本

操作 `~/.codewhale/config.toml` 的 `[[hooks.hooks]]` 部分：

```toml
[hooks]
enabled = true

[[hooks.hooks]]
# managed by clawd-on-desk
event = "session_start"
command = '''node "/path/to/codewhale-hook.js" session_start'''
background = true
timeout_secs = 5
```

7 个事件全部注册：
- `session_start`（background）
- `session_end`（**非** background，await 确保送达）
- `message_submit`（background）
- `tool_call_before`（background）
- `tool_call_after`（background）
- `mode_change`（background）
- `on_error`（background）

**幂等性**：已存在的 clawd-managed 条目被更新，手动添加的条目保留。

**关键修复**：见 [5.1 节](#51-codewhale-installjs-关键修复)。

### 4.4 `assets/icons/agents/codewhale.png`

64×64 runtime agent PNG。所有 runtime agent PNG 都必须保持 64×64，避免 `test/state-agent-icons.test.js` 失败。

---

## 5. 修改文件详解

### 5.1 `codewhale-install.js` 关键修复

#### 5.1.1 Electron 启动路径

Clawd 启动时 `integration-sync.js` 调用 `codewhale-install.js`，此时 `process.execPath` 是 Electron 二进制路径而非 Node.js。错误 hook command 会变成：
```
electron "/path/to/hook.js" session_start
```
而非正确的：
```
node "/path/to/hook.js" session_start
```

**修复**：
```js
// 修复前
const nodeBin = process.execPath || "node";

// 修复后
const nodeBin = process.versions.electron ? "node" : (process.execPath || "node");
```

检测到 Electron 运行时自动 fallback 到 PATH 中的 `node`。

#### 5.1.2 幂等注册与 legacy cleanup

早期实现把 `# managed by clawd-on-desk` 写在 `[[hooks.hooks]]` 前一行。`parseTomlSections()` 遇到 `[[hooks.hooks]]` 才开启新 section，导致 marker 被归到前一个 section，重复注册会不断追加 hook block，本地复现可见 `7 -> 8 -> 9 -> 10` 增长；卸载也可能只删 `6/7` 个 managed hook，留下孤儿 hook。

当前修复：

- marker 写入 `[[hooks.hooks]]` section 内；
- parser 兼容旧的 marker-before-header 格式；
- marker 丢失但 `command` 指向 `codewhale-hook.js` 的历史 orphan hook 也按 managed hook 清理；
- register 会先删除旧 managed entries，再写入 7 个 canonical entries；
- 第二次 register 返回 `added: 0`、`removed: 0`、`updated: false`，startup sync 不会反复记录无意义日志。

临时副本验证：历史污染配置可从 15 个 Clawd hook 引用收敛到 7 个，第二次注册保持 7 个，卸载后变 0 个。真实用户配置未在验证中写入。

#### 5.1.3 Windows command quoting

hook command 不再手写：

```js
const command = `${nodePath} "${hookPath}" ${event}`;
```

而是复用 `formatNodeHookCommand()`。这样 `C:\Program Files\nodejs\node.exe` 等含空格路径会被正确引用，不会被 shell 拆坏。

#### 5.1.4 Config path

CodeWhale CLI 会尊重 `CODEWHALE_CONFIG_PATH` 和 `DEEPSEEK_CONFIG_PATH`。installer 和 Doctor 现在共用 `resolveCodewhaleConfigPath()`，默认仍是 `~/.codewhale/config.toml`，但显式 env/config path 会优先生效。

### 5.2 `agents/registry.js`

```js
const codewhale = require("./codewhale");
// ...
const AGENTS = [
  // ...
  codewhale,
];
```

### 5.3 `src/prefs.js`

```js
// agents 默认值白名单中新增
"codewhale": { integrationInstalled: false, enabled: false, permissionsEnabled: false, notificationHookEnabled: true },
```

### 5.4 `src/integration-sync.js`

```js
function syncCodewhaleHooks() {
  var r = require('../hooks/codewhale-install.js');
  var result = r.registerCodewhaleHooks({ silent: true });
  // ...
}
```

CodeWhale 只有在 Settings 中安装且启用后才会在 Clawd 启动时自动调用此函数；用户触发 Install / Fix / Repair 时也会调用。

### 5.5 `src/server-agent-id.js`

```js
const HOOK_SOURCE_AGENT_IDS = new Map([
  // ...
  ["codewhale-hook", "codewhale"],
]);
```

将 hook source 字符串 `"codewhale-hook"` 映射到 agent `"codewhale"`。

### 5.6 `src/settings-actions-agents.js`

```js
const AUTO_REPAIRABLE_AGENT_IDS = new Set([
  // ...
  "codewhale",
]);
```

允许设置面板中一键修复 CodeWhale hooks。

### 5.7 `src/settings-agent-order.js`

```js
const NON_COLLAPSIBLE = [
  // ...
  "codewhale",
];
```

确保 CodeWhale 在 agent 列表中显示为可展开项，并露出通知开关。

### 5.8 `package.json`

```json
"start": "node launch.js"
```

CodeWhale 集成本身不需要改动 `npm start`。Telegram legacy sidecar 已退役，源码启动不再预检查、下载或暂存该二进制。

### 5.9 Doctor / Cleanup

CodeWhale 已进入 Doctor descriptor 和 integration checks：

- `src/doctor-detectors/agent-descriptors.js` 使用 `configMode: "codewhale-hooks-toml"`。
- `src/doctor-detectors/agent-integrations.js` 校验 7 个 CodeWhale hook events、script path、broken command，并识别 `[hooks].enabled = false`。
- `hooks/cleanup-integrations.js` 调用 `unregisterCodewhaleHooks()` 清理 canonical hooks 和 legacy orphan hooks。

---

## 6. 事件映射表

| CodeWhale 事件 | 环境变量关键字段 | Clawd 事件 | 动画状态 | 同步模式 |
|---|---|---|---|---|
| `session_start` | DEEPSEEK_SESSION_ID, DEEPSEEK_WORKSPACE, DEEPSEEK_MODE | `SessionStart` | idle | fire-and-forget |
| `session_end` | DEEPSEEK_SESSION_ID | `SessionEnd` | sleeping | **await** |
| `message_submit` | DEEPSEEK_SESSION_ID, DEEPSEEK_MESSAGE(截断) | `UserPromptSubmit` | thinking | fire-and-forget |
| `tool_call_before` | DEEPSEEK_TOOL_NAME | `PreToolUse` | working | fire-and-forget |
| `tool_call_after`（成功） | DEEPSEEK_TOOL_NAME, DEEPSEEK_TOOL_SUCCESS=true | `PostToolUse` | working | fire-and-forget |
| `tool_call_after`（失败） | DEEPSEEK_TOOL_NAME, DEEPSEEK_TOOL_SUCCESS=false | `PostToolUseFailure` | error | fire-and-forget |
| `mode_change`（compact） | DEEPSEEK_MODE=compact | `PreCompact` | sweeping | fire-and-forget |
| `mode_change`（其他） | DEEPSEEK_MODE/ DEEPSEEK_PREVIOUS_MODE | `Stop` | attention | fire-and-forget |
| `on_error` | DEEPSEEK_ERROR | `StopFailure` | error | fire-and-forget |
| `shell_env` | — | — | — | 忽略 |

---

## 7. 已知限制与未实现功能

### 7.1 未实现：权限审批气泡（Phase 2）

**目标**：当 CodeWhale 需要用户确认工具调用时（如执行 shell 命令、写入文件），Clawd 弹出交互式气泡，用户点击"允许"或"拒绝"后回复给 CodeWhale。

**阻塞原因**：

CodeWhale 有两个独立的 hook/事件系统：

| 系统 | 实现 | 事件数 | 是否有审批事件 |
|---|---|---|---|
| Shell Hooks (`[[hooks.hooks]]` in config.toml) | 命令行调用 | 8 个 | ❌ 无 |
| Runtime Events (`HookDispatcher` + sinks) | SSE / Webhook / JSONL | 20+ 个 | ✅ 有 `ApprovalLifecycle` |

审批事件（`ApprovalLifecycle`）只在 Runtime Events 中可用。访问它需要 `codewhale serve --http`（Runtime API），但 **serve 和 TUI 是两个独立进程，不共享 RuntimeThreadManager 实例**。serve 的 SSE 端点看不到 TUI 的审批事件，bridge 收不到任何东西。

**需要的 CodeWhale 源码改动**（不在此项目范围内）：
- 让 TUI 内嵌 HTTP server（类似 `--http` 标志在主命令上）——或——
- 让 serve 和 TUI 共享同一个 RuntimeThreadManager store

**临时方案**：用户保持 `approval_mode = auto` 或 `suggest`，在终端中手动审批。桌宠仅显示状态动画。

### 7.2 未实现：子代理支持（Phase 3）

**目标**：CodeWhale 启动子代理（subagent）时，螃蟹切换到 juggling/building 动画。

**阻塞原因**：CodeWhale 的 sub-agent 机制细节未知。需要研究其 session/task 生命周期事件。

### 7.3 未实现：深度会话集成（Phase 4）

包括：
- HTTP/SSE Runtime API 会话信息获取
- 终端聚焦支持
- Dashboard 增强

### 7.4 图标

当前 `assets/icons/agents/codewhale.png` 是 64×64 runtime PNG。后续可以替换为更正式的 CodeWhale 官方 logo，但尺寸必须保持 64×64。

---

## 8. 常见问题排查

### 8.1 螃蟹不动

1. 确认 Clawd 在运行：`curl http://127.0.0.1:23333/state` 返回 `{"ok":true}`
2. 确认已在 **Settings → Agents → CodeWhale → Install** 安装并启用集成
3. 确认 hooks 已注册：`grep "codewhale-hook" ~/.codewhale/config.toml` 应有 7 个条目
4. 确认 hooks 用的是 `node` 而非 `electron`：同上
5. 手动模拟测试：
   ```bash
   DEEPSEEK_SESSION_ID=test_001 \
   DEEPSEEK_WORKSPACE=/tmp \
   DEEPSEEK_MODE=agent \
   node hooks/codewhale-hook.js session_start
   ```

### 8.2 HUD 标签显示错误（如 `claude_on_desk`）

确认 hook 脚本是修改后的版本（包含 `session_title: "CodeWhale"`）。重启 codewhale 后新会话生效。

### 8.3 多个重复 HUD 标签

旧 session 残留。重启 Clawd 清除，或右键删除。

### 8.4 Hook 命令用了 electron 而非 node

如果已安装且启用的 CodeWhale 集成在 Clawd 启动同步时覆盖了 hooks：
1. 从 **Settings → Agents → CodeWhale → Fix / Repair** 重新同步，或调试时手动运行 `npm run install:codewhale-hooks`
2. 确认 `codewhale-install.js` 使用 `resolveNodeBin()`，不会在 Electron 启动路径里固定写入裸 `node`

### 8.5 安装脚本失败

默认路径下，确保 `~/.codewhale/` 目录存在且 `config.toml` 格式正确。若使用 `CODEWHALE_CONFIG_PATH` 或 `DEEPSEEK_CONFIG_PATH`，installer 会按显式路径写入并创建父目录。

---

## 9. 使用说明

### 9.1 首次启动

```bash
cd clawd-on-desk

# 1. 安装依赖（已完成则跳过）
npm install

# 2. 配置 chrome-sandbox 权限（Linux 必需）
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox

# 3. 启动桌宠
npm start
```

启动后打开 **Settings → Agents → CodeWhale → Install**。安装且启用后，Clawd 会在后续启动时继续同步 CodeWhale hooks。

如需在启动桌宠前调试 installer，也可以手动执行：

```bash
npm run install:codewhale-hooks
```

### 9.2 日常使用

```bash
# 启动 Clawd
cd clawd-on-desk && npm start

# 启动 CodeWhale（另一个终端）
codewhale

# 或 YOLO 模式
codewhale --yolo
```

### 9.3 卸载

```bash
# 卸载 hooks
npm run uninstall:codewhale-hooks

# 停止桌宠
pkill -f "electron.*clawd-on-desk"
```

### 9.4 调试

```bash
# 查看 Clawd 状态
curl http://127.0.0.1:23333/state

# 查看已注册 hooks
grep "codewhale-hook" ~/.codewhale/config.toml

# 手动触发事件
cd clawd-on-desk
DEEPSEEK_SESSION_ID=debug DEEPSEEK_WORKSPACE=$(pwd) \
  node hooks/codewhale-hook.js session_start
```
