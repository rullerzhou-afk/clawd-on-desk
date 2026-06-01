# 计划：Issue #357 上下文用量显示（A1）

> 状态：草稿 v1（需求 + 开发计划，暂无代码）。
> 日期：2026-06-01
> Issue：https://github.com/rullerzhou-afk/clawd-on-desk/issues/357（"宠物可以支持显示上下文用量吗，感觉很实用"）
> 范围：在 Session HUD / Dashboard 里展示每个会话的上下文窗口用量（已用 token vs 上限），数据来自 agent 已经发出的信号。只读遥测；不改 agent 行为、权限流程或动画优先级。

---

## 1. 目标

让用户一眼看出当前 agent 会话的上下文窗口有多满，从而预判何时会触发 `/compact` 或需要开新会话。两个展示面：

1. **Session HUD**（桌宠旁）— 每个 live 会话行上一个紧凑的用量指示器。
2. **Sessions Dashboard** — 同样的用量，外加 `已用 / 上限（token）` 原始数字。

可选拓展（Phase 2）：当会话越过高用量阈值（如 ≥ 90%）时，让桌宠偏向 `attention` 类提示。Phase 1 故意不做这一步，以免改动状态优先级机制。

### 非目标

- 不新增常驻轮询。用量搭车现有 hook 事件 / JSONL 轮询。
- 除统一为 `{ used, limit, percent }` 形状外，不做跨 agent 的归一化扩展。
- 不做历史 token 曲线（那属于另一个 A2 "统计面板" 点子）。
- Phase 1 不改 `state.js` 优先级解析或动画选择。

---

## 2. 数据从哪来

上下文用量是按 agent 区分的，且并非所有 agent 都能拿到。本计划只为真正提供数字的 agent 点亮指示器，其余静默降级（不显示指示器）。

| Agent | 用量来源 | 可得性 |
|---|---|---|
| **Claude Code** | `hooks/clawd-hook.js` 已经在读的 transcript JSONL（`readTranscriptTailEntries`）。assistant 消息条目携带 `usage` 对象（`input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`）。上下文窗口大小依模型而定（如 200k）。 | 高——transcript 尾部今天已被解析（用于会话标题 / API 错误），所以无新增文件 IO。 |
| **Codex CLI** | 会话 JSONL 携带 `token_count` / `event_msg` 记录，含累计 token 用量与上下文窗口信息。该 JSONL 已被 `agents/codex-log-monitor.js` 轮询。 | 中——需在 monitor 里加一个新的解析分支；只有 fallback（非 hook）会话会通过轮询发出。 |
| **其他 agent**（Copilot、Gemini、Cursor、Kimi、Qwen、opencode、Pi 等） | 现有 hook payload 里没有可靠的用量信号。 | Phase 1 无——指示器直接隐藏。 |

关键结论：**Phase 1 主攻 Claude Code**，因为每次 hook 事件都已经读 transcript 尾部。Codex 作为快速跟进，等 Claude 路径验证好数据形状后再做。其它一律降级为"不显示指示器"。

### 百分比计算

```
contextUsage = {
  used:    input_tokens + cache_read_input_tokens + cache_creation_input_tokens (+ 上一轮 output),
  limit:   模型上下文窗口（来自一张按模型的小查表，带兜底默认值）,
  percent: clamp(round(used / limit * 100), 0, 100),
  source:  "claude" | "codex"   // 用于调试 / 格式化
}
```

`used` 的精确公式在实现阶段对照真实 Claude Code transcript 敲定（按 AGENTS.md，涉及 transcript/usage 的改动必须用真实会话验证，不能只靠手写 payload）。模型→上限查表与解析器放在一起，遇到未知模型时回退到保守默认值——此时只显示原始 `used` 数（不显示百分比）。

---

## 3. 数据流（沿用现有字段管线）

上下文用量走的就是 `model` / `provider` / `sessionTitle` 今天已经在走的同一条路，不引入任何新传输：

```
hooks/clawd-hook.js                      (解析 transcript 尾部 → context_usage)
  → POST /state body: { ..., context_usage: { used, limit } }
src/server-route-state.js                (像 model/provider 一样校验 data.context_usage)
  → updateSession({ ..., contextUsage })
src/state.js  updateSession()            (存 srcContextUsage，像 model 一样 sticky)
  → session.contextUsage
src/state-session-snapshot.js            (buildSessionSnapshotEntry 增加 contextUsage)
  → snapshot 条目 { ..., contextUsage }
src/session-hud-renderer.js              (在行的 "right" 簇渲染用量芯片)
src/dashboard-renderer.js                (在详情里渲染 已用 / 上限 / 百分比)
```

Codex fallback 路径：

```
agents/codex-log-monitor.js              (解析 token_count 事件 → contextUsage)
  → 复用今天 monitor 回调一样的 updateSession({ contextUsage }) 入口
```

### 校验规则（server-route-state.js）

照搬 `model` / `cwd` 用的防御式写法：

- 仅当 `data.context_usage` 是对象、`used` 为有限非负数（`limit` 可选、为有限正数）时才接受。
- 非法输入静默丢弃（不返回 400）——用量是尽力而为的遥测。
- 空 / 缺失输入做 sticky：不清空已知的 `contextUsage`（与 `sessionTitle` 的"忽略 + 回退"规则一致）。

---

## 4. 设置与 UI

### 4.1 偏好项

在 `src/prefs.js` 加一个布尔，沿用现有 `sessionHudShow*` 家族：

```js
sessionHudShowContextUsage: { type: "boolean", default: true },
```

按标准设置链路接通（`settings-controller` 是唯一写入者；`prefs.js` → `settings-actions` → store → renderer 广播）。在 Session HUD 设置区把它和 `显示状态标签` / `显示用时` 并排做成开关，并在 `src/settings-i18n.js` 加上 i18n 文案（en / zh-CN / zh-TW / ko / ja）。

### 4.2 Session HUD 指示器

`src/session-hud-renderer.js` 里行已经有一个 `right` 簇放状态芯片 + 用时。仅在 `sessionHudShowContextUsage` 打开 **且** `session.contextUsage` 存在时，在那里加一个小用量芯片：

- 紧凑形态：`72%`（或一条细横条）——保持很小，HUD 空间有限。
- 颜色档：< 75% 中性、75–90% 暖色、≥ 90% 热色（复用 `session-hud.html` / styles 里现有的芯片色 token，不新造调色板）。
- `title` tooltip 携带原始 `已用 / 上限` 供悬停查看。
- 当 `limit` 未知时，显示原始 token 数（如 `18.2k`），不显示百分比，用中性色。

### 4.3 Dashboard 详情

在 `src/dashboard-renderer.js` 的会话详情区渲染完整的 `已用 / 上限（百分比）` 一行。同样以 `contextUsage` 是否存在做门控。

---

## 5. 分阶段

**Phase 1 — 仅 Claude Code（先发）：**
1. 扩展 `hooks/clawd-hook.js` 的 transcript 尾部读取，从已解析的条目算出 `context_usage`（无新增文件读）。
2. 把 `context_usage` 沿 `server-route-state.js` → `state.js` → snapshot 接通。
3. 加 `sessionHudShowContextUsage` 偏好 + 设置开关 + i18n。
4. 渲染 HUD 用量芯片与 Dashboard 详情。
5. 测试（见 §6）+ 对照真实 Claude Code 会话手动验证。

**Phase 2 — Codex fallback：**
6. 在 `agents/codex-log-monitor.js` 解析 `token_count`，喂给同一个 `updateSession` 字段。

**Phase 3（可选，独立 PR）— 高用量 attention 提示：**
7. 评估在 ≥ 阈值时让桌宠偏向 attention 提示。因为会动到状态优先级，需要单独设计签字确认；故意延后。

---

## 6. 测试

遵循仓库的 Node 内置 test-runner 约定（`npm test`），所有逻辑都要可在脱离 Electron 的情况下做单测：

- **解析器单测**：喂入有代表性的 Claude transcript 尾部条目（有 / 无 `usage`、有 cache token、未知模型），断言算出的 `{ used, limit, percent }`。Phase 2 再加 Codex `token_count` fixture。
- **服务端路由测试**（仿 `server-route-state` 风格）：合法对象被接受、非法被丢弃、空输入 sticky（不清空之前的用量）。
- **Snapshot 测试**（`state-session-snapshot`）：`contextUsage` 流入 snapshot 条目；未知时为 `null`/缺失。
- **设置测试**：`sessionHudShowContextUsage` 的默认值、持久化、effect 传播。
- **手动（AGENTS.md 要求）**：对照真实 Claude Code 会话，验证随对话增长显示的百分比与终端自身的 `/context` 视图一致；transcript/usage 改动不能只靠手写 payload 验证。

---

## 7. 风险与待定问题

- **token 公式准确性**：cache-read vs cache-creation vs input token 的计入方式必须与 Claude Code 自己报告的上下文饱和度一致；锁定公式前先对照真实 transcript。
- **模型→上限查表漂移**：上下文窗口会随模型发布变化。查表保持小、集中、默认安全；模型未知时显示原始计数而非猜一个错误的百分比。
- **HUD 空间**：HUD 刻意紧凑。百分比芯片是安全默认；细条作为后续若可读再上。
- **Codex hook 模式会话**：Codex 官方 hook 可能不带 token 计数，所以 Phase 2 的用量只在 JSONL 轮询的 fallback 上尽力而为（与 `docs/guides/known-limitations.md` 里现有的 Codex fallback 限制一致）。
- **隐私**：只有聚合 token 计数跨过本地 HTTP 边界（已绑定 `127.0.0.1`）；payload 不新增任何 prompt 内容。

---

## 8. 改动清单（供实现 PR 用）

| 文件 | 改动 |
|---|---|
| `hooks/clawd-hook.js` | 从 transcript 尾部条目算出 `context_usage`；加进 `/state` body |
| `src/server-route-state.js` | 校验 + 转发 `context_usage` → `contextUsage` |
| `src/state.js` | 在会话上存 `srcContextUsage`（sticky，像 `model`） |
| `src/state-session-snapshot.js` | 在 `buildSessionSnapshotEntry` 加 `contextUsage` |
| `src/session-hud-renderer.js` | 在行的 `right` 簇渲染用量芯片 |
| `src/dashboard-renderer.js` | 渲染 `已用 / 上限（百分比）` 详情 |
| `src/prefs.js` | 加 `sessionHudShowContextUsage` 布尔 |
| `src/settings-i18n.js` + Session HUD 设置页 | 开关 + 5 语言文案 |
| `agents/codex-log-monitor.js` | （Phase 2）解析 `token_count` → `contextUsage` |
| `test/*.test.js` | 解析器、服务端路由、snapshot、设置测试 |

---

*本文档是 A1 的需求 + 开发计划，刻意不含任何功能代码改动；实现在后续 PR 中按上面的改动清单与分阶段落地。*
