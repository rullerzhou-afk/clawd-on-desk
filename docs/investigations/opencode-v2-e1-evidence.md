# OpenCode v2 适配 E1 真机证据（2026-09-24）

issue #1039。测试环境：macOS arm64，`opencode v2.0.15`（brew `anomalyco/tap/opencode-v2`），GLM `glm-5.3-flash`
（bigmodel Anthropic 协议 `https://open.bigmodel.cn/api/anthropic/v1`，provider config 用 v2 新形状
`providers.<id>.package/settings`）。探针插件 `/tmp/clawd-e1/v2probe/index.mjs`（零 import 纯对象），
日志 `/tmp/clawd-e1/probe.log`，v1 对照 `opencode-ai@1.18.32`（/tmp/oc1 临时 prefix）。

## 结论速览

| # | 问题 | 结论 |
|---|------|------|
| 1 | v2 读哪个 plugin 配置键 | **`plugins`（新）生效**；同时容忍并尝试加载旧 `plugin` 键条目 |
| 2 | v1 是否容忍配置里出现 `plugins` 键 | **容忍**：1.18.32 `debug config` 静默丢弃该键，config 解析正常 ⇒ 双键并存注册安全 |
| 3 | v1 函数入口在 v2 下的命运 | server log WARN：`Plugin must export a default definition with an id and an effect or setup function (Expected object at ["default"])`，宿主不崩、插件 inert ⇒ #1039 根因 |
| 4 | v2 entry 形态 | `{id, setup}` 纯对象、零 import、目录 specifier（解析到目录下 `index.mjs`，无需 package.json）全部可用 |
| 5 | evaluate hook 可否异步阻塞等外部决定 | **可以**：hook 内 `await 2s` 期间宿主真实等待，改 `event.effect="allow"` 后工具才执行 |
| 6 | 插件进程模型 | 插件在常驻 service 内（`ppid=1`，CLI 退出后事件流仍活）；`source_pid`/进程树不可信 |
| 7 | `plugin list` | 显示插件 `id`（合法）或 `-`（加载失败）；source 为目录解析后的 `index.mjs` 路径 |

## ctx（setup 入参）实测

`Object.keys(ctx)`：`agent, aisdk, app, command, event, experimental, generate, integration, location,
mcp, model, options, permission, plugin, provider, reference, rpc, session, shell, skill, storage, tool,
vcs, websearch, worktree`

- `app = {name:"cli", version:"2.0.15", channel:"latest"}`
- `location = {directory, project:{id, directory, canonical}}`（service 级，非 per-session）
- `permission` domain keys：`get, hook, list, reply`（**没有** rules/persist API ⇒ "always allow" 无宿主持久化）
- `session` domain keys：`command, context, create, generate, get, hook, interrupt, move, prompt,
  switchAgent, switchModel, synthetic, update, wait`（**没有** list ⇒ 无会话枚举 hydration）

## permission evaluate hook 实测

```
EVALUATE enter= {"sessionID":"ses_…","agent":"build","action":"shell",
                 "resources":["echo probe-test-123"],
                 "source":{"type":"tool","messageID":"msg_…","id":"call_…"},
                 "effect":"ask"}
```

- 注册：`ctx.permission.hook("evaluate", async (event) => {…})`
- 异步阻塞：t0=…337 → await 2000ms → t1=…339，期间无工具执行；`event.effect="allow"` 后 shell 才跑
- 只对 `effect:"ask"` 触发（本次 allow 规则未触发 hook）；配置 deny 最终、不进 hook（与文档一致）
- `resources` 是逐 action 的输入摘要（shell=完整命令字符串）；`source.id` 是 tool call id

## v2 事件流实测（一次真实 GLM 会话，含 shell 工具）

事件信封：`{id, created, type, durable?:{aggregateID:<sessionID>, seq, version},
location?:{directory}, data:{…}}`。`location.directory` 是 per-event cwd 权威来源。

观察到的完整事件词汇（按时间序）：

| 事件 | data 要点 | Clawd 映射用途 |
|---|---|---|
| `model.updated` / `provider.updated` / `websearch.updated` / `integration.updated` / `skill.updated` / `command.updated` / `agent.updated` / `reference.updated` / `plugin.updated` | `{}` | 忽略 |
| `session.step.started` | `{sessionID, assistantMessageID, agent, model{id,providerID,variant}, started}` | working/thinking 开始 |
| `session.reasoning.started/.delta/.ended` | `{sessionID, assistantMessageID, ordinal, delta/text, state.signature}` | thinking |
| `session.text.started/.delta/.ended` | 同上形态 | working（助手输出） |
| `session.tool.input.started` | `{sessionID, assistantMessageID, id:call_…, name:"shell"}` | PreToolUse 前奏 |
| `session.tool.input.ended` | `{…, id, text:"{\"command\":…}"}`（JSON 字符串） | tool_input 捕获 |
| `session.tool.called` | `{…, id, input:{command}, executed:false}` | PreToolUse/working |
| `session.step.streamed` | `{sessionID, assistantMessageID}` | 忽略 |
| `session.tool.progress` | `{…, id, metadata:{shellID}}` | working |
| `shell.created` | `{info:{id, status, command, cwd, shell, file, metadata:{sessionID}, time{started}}}` | working（可选） |
| `shell.exited` | `{id, exit, status}` | 忽略 |
| `session.tool.success` | `{…, id, content:[{type:"text",text}], metadata:{status:"completed", truncated, exit}, executed}` | PostToolUse |
| `session.step.ended` | `{…, finish:"tool-calls"\|"stop", rawFinish:"tool_use"\|"end_turn", cost, tokens{input,output,reasoning,cache}}` | finish=stop ⇒ 完成候选 |
| `session.usage.updated` | `{sessionID, cost, tokens{input,output,reasoning,cache{read,write}}}` | context usage（#830 v2 路径） |
| `session.renamed` | `{sessionID, title}` | 标题 |
| `session.execution.succeeded` | `{sessionID}`（durable） | **终态完成 → Stop/attention** |

单轮 `opencode run` 中**未见**：`session.created`、`session.deleted`、`session.status`、`session.idle`、
`session.error`、`permission.v2.asked/replied`（evaluate hook 已在 ask 阶段拦截）、tool error 终态事件名。
E2E（TUI、失败会话、子代理）补查；未知事件一律忽略（fail-closed 不映射）。

## provider 配置（v2 形状，与本仓库无关但记录在案）

- 键是 `providers`（复数）；字段 `package`（不是 `npm`）、`settings`（不是 `options`）
- Anthropic 协议端点：`package:"@ai-sdk/anthropic"` + `settings.baseURL:"https://open.bigmodel.cn/api/anthropic/v1"`
- `@opencode/ai/providers/anthropic-compatible` 在 2.0.15 报 `Cannot find package '@opencode/ai'`（bundle
  解析缺陷）；在 `~/.config/opencode` 里 `npm i @opencode/ai` 后消失
- 官方 schema URL `https://opencode.ai/config.json` 当前返回的仍是 v1 形状（`plugin`/`provider`、
  `additionalProperties:false`），与运行时不一致——**运行时实测优先于该 schema**

## 对设计的直接影响

1. 双键并存注册：v1 条目留在 `plugin`（v1 专用），v2 条目写 `plugins`（string 目录指向 generation 内
   v2 入口目录）；两代宿主互不干扰（#1/#2 证据）。
2. v2 bundle 增量最小化为 1 个文件：`opencode-plugin-v2/index.mjs`（探针证明目录 specifier 无需
   package.json）；allowlist 4→5。
3. 权限：evaluate hook 阻塞 POST Clawd `/permission` 长连接，await 决定后改 effect；
   "always allow" 用插件内 per-session 内存 map（service 常驻 ⇒ 覆盖会话生命周期），无宿主持久化可依赖。
4. cwd/title：`location.directory`（事件信封）+ `session.renamed`/`session.step.*` data；不依赖 ctx.location。
5. pid：不发送（service 进程无意义），终端跳转 v2 降级。

## E2 补充：气泡决策全链路真机验证（2026-09-24，源码运行的新 Clawd 实例）

环境：`node launch.js` 加载本分支代码（automation 先临时切 `off`，CDP 驱动真实气泡点击，
结束后恢复用户原偏好 `auto-tools` 并正常重启）。宿主 opencode 2.0.15 + GLM。

| 链路 | 结果 |
|---|---|
| Allow（单 ask） | 气泡显示、连接保持 → 点击 → `PERM resolved allow` → effect 生效、工具执行 |
| Allow（同一工具调用连续两个 ask：external_directory + edit） | 两个阻塞连接各自独立 hold/resolve，全部 allow 后文件创建 |
| Deny | 点击 → `{decision:"deny"}` → opencode 显示 "Permission denied: shell"，命令未执行 |
| Always（family-always 点击） | `{decision:"always"}` 返回、工具执行、插件记录 per-session 规则 |
| Always-hit（同 `--session` 续跑、相同 action） | **零气泡**、`PERM always-hit` 内存命中、文件直接创建 |
| auto-tools 自动化互操作 | 用户偏好 auto-tools 下 ask 在 ~3ms 被服务端策略 allow，v2 阻塞路径直接消费决定，无气泡 |
| 并行工具调用 | 两个 write 并行 → 两条独立阻塞连接，分别解析互不干扰 |
| 状态流 | 全程 idle→thinking→working→attention POST OK（新实例端口 23333） |
| 失败回退 | 对无 v2 分支的旧 Clawd（纯 200 ACK）：`unsupported-decision` → no-decision → 原生 ask UI |

实现细节备注：同一工具调用的多个 ask 共用 `request_id`（源自 tool call id）——仅用于日志关联，
决定经各自 HTTP 响应返回，无碰撞语义；无需修改。
