# Agent Runtime Architecture

This document holds the deeper runtime and integration notes that were previously in the root `AGENTS.md`.

## Data Flow

```text
Claude Code 状态同步（command hook，非阻塞）：
  Claude Code 触发事件
    → hooks/clawd-hook.js（零依赖 Node 脚本，stdin 读 JSON 取 session_id + source_pid）
    → HTTP POST 127.0.0.1:23333/state { state, session_id, event, source_pid, cwd }
    → src/server.js HTTP 壳 → src/server-route-state.js → src/agent-runtime-main.js → src/state.js 状态机（多会话追踪 + 优先级 + 最小显示时长 + 睡眠序列）
    → IPC state-change 事件
    → src/renderer.js（<object> SVG 预加载 + 淡入切换 + 眼球追踪）

Copilot CLI 状态同步（command hook，非阻塞）：
  Copilot 触发事件
    → hooks/copilot-hook.js（camelCase 事件名 → agents/copilot-cli.js 映射 → HTTP POST）
    → 同上状态机

Cursor Agent 状态同步（command hook，stdin JSON，非阻塞）：
  Cursor IDE 触发事件
    → hooks/cursor-hook.js（hook_event_name → 映射为 PascalCase event + HTTP POST，stdout 返回 allow/continue 以满足 preToolUse 等 hook）
    → 同上状态机（agent_id: cursor-agent）

Codex CLI 状态同步（official hooks primary + JSONL fallback）：
  Codex 触发 SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop
    → hooks/codex-hook.js（stdin JSON，session_id 优先与 transcript_path 的 rollout UUID 对齐）
    → HTTP POST 127.0.0.1:23333/state { state, session_id, event, turn_id, hook_source }
    → 同上状态机（agent_id: codex）
  Codex 写入 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
    → agents/codex-log-monitor.js（fallback：hook 未覆盖事件、hook 禁用/不可用、历史兼容）
    → src/agent-runtime-main.js 对 hook-active session 做事件级 suppression，避免重复状态/重复气泡；本地 JSONL 路径不经过 HTTP server

本机 Codex 注册使用每个 `CODEX_HOME` 下固定的分平台入口。Windows 的固定
`commandWindows` 在 Codex 已启动的 PowerShell 进程内读取 UTF-8/Base64
`clawd-hooks/codex-hook.js.windows.run` 数据 sidecar，再直接调用其中的 Node /
hook target；不落地或二次启动 `.ps1`。旁路 JSON manifest 只供 Doctor 做完整性
与目标健康校验。POSIX 使用 `clawd-hooks/codex-hook.js.sh` 与对应 manifest。
正式包、开发目录、不同 worktree、Node 安装路径切换时只原子更新
这些受管 artifact，不再改 `hooks.json` 的命令字符串，因此首次迁移 review 后
不会反复触发 `/hooks` review。Windows 与 WSL 的 manifest/wrapper 分开保存，
共用 `CODEX_HOME` 时不会互相覆盖目标。Remote SSH 部署继续直接引用已部署的
远端 hook 文件，不经过本机固定入口。Doctor 按 Codex 官方的归一化 handler
SHA-256 精确核对 `trusted_hash`，命令变更后不会因原位置仍有旧 hash 而误报
trusted。

Gemini CLI 状态同步（hook-only，stdin JSON + stdout JSON）：
  Gemini CLI 触发 SessionStart / BeforeAgent / BeforeTool / AfterTool / AfterAgent / SessionEnd 等事件
    → hooks/gemini-hook.js（hook_event_name 或 argv 事件名 → agents/gemini-cli.js 映射）
    → HTTP POST 127.0.0.1:23333/state
    → 同上状态机（agent_id: gemini-cli）

Antigravity CLI (agy) 状态同步（hook-only，stdin JSON + stdout JSON）：
  agy 触发 PreInvocation / PostToolUse / PostInvocation / Stop
    → hooks/antigravity-hook.js（camelCase payload + argv 事件名 → agents/antigravity-cli.js 映射）
    → HTTP POST 127.0.0.1:23333/state（状态）
    → 同上状态机（agent_id: antigravity-cli）
  Hook 注册到 ~/.gemini/config/hooks.json 的 clawd hook group，**仅状态事件**。PreToolUse **故意不注册**，权限完全交给 agy 自己 5 选项 native menu（agy 1.0.1 LLM 主动调内置 ask_permission 工具触发，含 "Persist to settings.json" 持久规则）。Stop stdout 返回允许停止的 JSON。

Kiro CLI 状态同步（per-agent hook，stdin JSON）：
  Kiro CLI 触发事件
    → hooks/kiro-hook.js（camelCase 事件 → agents/kiro-cli.js 映射 → HTTP POST）
    → 同上状态机（agent_id: kiro-cli）
  注意：Kiro 无 global hooks，hooks/kiro-install.js 把 hook 注入到 ~/.kiro/agents/ 下每个
  custom agent 配置里，并额外维护一个 "clawd" agent（继承 kiro_default，启动时从 kiro_default
  重新同步以避免行为漂移）。内置 kiro_default 没有可编辑 JSON，用户需 `kiro-cli --agent clawd`
  或 `/agent swap clawd` 才能启用 hooks。

CodeBuddy 状态同步（Claude Code 兼容 hook，command）：
  CodeBuddy 触发事件
    → hooks/codebuddy-hook.js（PascalCase 事件 → agents/codebuddy.js 映射 → HTTP POST）
    → 同上状态机（agent_id: codebuddy）
  Hook 注册到 ~/.codebuddy/settings.json，格式与 Claude Code 完全兼容。

自定义 HTTP Agent（动态注册，state-only）：
  Settings 选择本机可执行文件
    → customApplications 生成稳定 custom-... ID（只代表注册，不证明应用是 AI，也不安装 hook）
    → 应用或外部 adapter 读取 ~/.clawd/runtime.json 的当前端口
    → HTTP POST 127.0.0.1:<runtime-port>/state { agent_id, session_id, state, event }
    → server-agent-id.js 只接受当前仍注册的 custom ID，enabled gate 决定是否进入状态机
  v1 不支持 /permission；已注册 custom 的权限请求返回 204 no-decision，删除/伪造的 custom- ID 直接拒绝，不能降级成 Claude Code subagent。

WorkBuddy 状态与通知同步（Claude Code 兼容 hook，command）：
  WorkBuddy 触发 SessionStart / SessionEnd / UserPromptSubmit / PreToolUse / PostToolUse / Stop / Notification / PreCompact
    → hooks/workbuddy-hook.js（PascalCase 事件 → agents/workbuddy.js 映射 → HTTP POST）
    → 同上状态机（agent_id: workbuddy）
  Hook 注册到当前 WorkBuddy AI 的 ~/.workbuddy-ai/settings.json（旧版兼容 ~/.workbuddy/settings.json）。集成为 state + Notification only：不注册 PermissionRequest HTTP hook，
  审批始终由 WorkBuddy 原生沙箱与 GUI 处理；无 session_id 的事件在返回合法 stdout 后直接丢弃，不进入 /state。

QwenWork（千问办公）状态同步（hook-only / state-only，settings.json）：
  QwenWork 触发 SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / PostToolUseFailure / Stop /
  Notification / PermissionRequest / PermissionDenied / SessionEnd
    → hooks/qwenwork-hook.js（hook 事件 → agents/qwenwork.js 映射 → HTTP POST）
    → 同上状态机（agent_id: qwenwork，session_id 规范化为 qwenwork:<raw>）
  Hook 注册到 ~/.QwenWorkCN/settings.json（marker `qwenwork-hook.js`，增量合并；混合 entry 里第三方 hook 原样保留）。
  Windows command 用 portable 形态（`windowsWrapper:"portable"`），PowerShell `-EncodedCommand` 只用于识别并原地迁移旧条目。
  PermissionRequest / PermissionDenied 仅作观察映射成 working（每任务 40+ 次），stdout 恒为 `{}`：不注册 /permission、
  不进 permission automation eligibility，Allow / Deny 全部留在 QwenWork 原生权限流程。
  只发送 tool_input 的 sha1 fingerprint，不把原始 tool_input POST 给 Clawd。
  平台边界：官方只提供 macOS 14+ / Windows 10+ / HarmonyOS 6.1+（https://qwenwork.cn/download），没有 Linux 客户端，
  因此 processNames.linux 与 resolver linux agent name 均为空，也不进 WSL Pair；桌面主进程长驻，无 startup recovery。

Kimi Code CLI（Kimi-CLI）状态同步（hook-only，config.toml）：
  Kimi Code CLI（Kimi-CLI）触发事件
    → hooks/kimi-hook.js（hook 事件 → agents/kimi-cli.js 映射 → HTTP POST）
    → 同上状态机（agent_id: kimi-cli）
  Hook 注册到 ~/.kimi/config.toml 的 [[hooks]] 条目；Clawd 启动时会自动同步这些条目。

ZCode 状态同步与权限审批（hook-only，config.json）：
  状态事件 SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / PostToolUseFailure / Stop
    → hooks/zcode-hook.js（hook 事件 → agents/zcode.js 映射 → HTTP POST /state）
    → 同上状态机（agent_id: zcode，session_id 规范化为 zcode:<raw>）
  权限事件 PermissionRequest（Phase 2 起）
    → hooks/zcode-hook.js 构造权限 body（tool_name 缺失 / unknown 时 fail-closed 落回 state 路径）
    → 长阻塞 HTTP POST /permission（等待 590s；installer 注册 per-hook timeoutMs 600000）
    → 本地 bubble / Telegram / 飞书远程审批产生人工决定（automation 未审计，全部 defer）
    → 有决定时 stdout 返回最小 hookSpecificOutput（allow 裸 behavior；deny 可带 message），
      无决定 / 超时 / 断连输出 "{}" 并 exit 0，ZCode 回退原生权限流程
  Hook 注册到 ~/.zcode/cli/config.json 的 hooks.events.*（7 个支持事件全部注册）。显式 hooks.enabled=false
  或 Clawd 单项 hook enabled=false 是用户选择，启动同步 / Settings Repair 均保留，Doctor 只提示。
  旧版 zcode-cli 与当前 Electron Node-mode Resources/glm/zcode.cjs 进程均受支持；GUI shell 只有在
  命令行同时含 zcode.cjs 时才会被认作 runtime。ZCode 不进入 permission automation 白名单：
  在工具面与会话身份审计完成前，global / per-session automation 全部 defer。prefs v14→v15 迁移翻转 Phase 1 的
  zcode.permissionsEnabled=false 为 true。

opencode 状态同步（in-process plugin，~0ms 延迟）：
  opencode 触发事件（session.created / session.status / message.part.updated 等）
    → hooks/opencode-plugin/index.mjs（CLI/TUI 运行于 Bun；Desktop sidecar 运行于 Electron utilityProcess / Node）
    → translateEvent 映射（opencode v2 事件名 → PascalCase Clawd event 名）
    → session.created 的 event.properties.info.parentID 会被记录为 child → parent 映射，child 状态上报带 headless: true
    → fire-and-forget HTTP POST 127.0.0.1:23333/state
    → 同上状态机（agent_id: opencode）
  permission.asked 通过 plugin POST /permission 进入 Clawd；决定经随机 localhost 端口上的反向 bridge 返回，
  CLI/TUI bridge 使用 Bun.serve，Desktop bridge 使用 node:http，再由 plugin 调用宿主 SDK 的 permission reply route。
  permission.replied 使用 current requestID/sessionID 契约回送 completion lifecycle；同一 request 的 asked/replied
  在 plugin 内因果串行，lifecycle 最多投递 3 次。Clawd 只按 agent/request/canonical session/bridge generation
  精确清理 pending UI、timer 与 notification，不向宿主反向发送第二次决定。

MiMo Code 状态同步（in-process plugin，~0ms 延迟）：
  MiMo Code 触发事件（session.created / session.status / message.part.updated 等）
    → hooks/mimocode-plugin/index.mjs（插件跑在 mimo.exe 进程内，共享 @mimo-ai/plugin SDK）
    → translateEvent 映射（与 opencode 同源的事件名 → PascalCase Clawd event 名）
    → session.created 的 event.properties.info.parentID 会被记录为 child → parent 映射，child 状态上报带 headless: true
    → fire-and-forget HTTP POST 127.0.0.1:23333/state
    → 同上状态机（agent_id: mimocode）

Pi 状态同步（global extension，state-only）：
  Pi 触发 session_start / before_agent_start / tool_call / tool_result / agent_end 等事件
    → ~/.pi/agent/extensions/clawd-on-desk/index.ts（Pi extension runtime）
    → hooks/pi-extension-core.js 映射为 PascalCase Clawd event 名
    → HTTP POST 127.0.0.1:23333/state
    → 同上状态机（agent_id: pi）

OpenClaw 状态同步（in-process plugin，state-only）：
  OpenClaw 触发 session_start / model_call_started / before_tool_call / after_tool_call / model_call_ended 等事件
    → hooks/openclaw-plugin/index.js（plain ESM default object，OpenClaw plugin loader 直接识别）
    → 映射为 PascalCase Clawd event 名，POST body 只发送 allowlist 字段
    → fire-and-forget HTTP POST 127.0.0.1:23333/state
    → 同上状态机（agent_id: openclaw）

Hermes Agent 状态同步（Python plugin，Hermes SDK）：
  Hermes 触发 on_session_start / pre_llm_call / post_llm_call / pre_tool_call / post_tool_call / on_session_end / on_session_finalize / on_session_reset
    → hooks/hermes-plugin/__init__.py（plugin 跑在 Hermes worker 进程内）
    → 映射为 Clawd event + 同步 HTTP POST 127.0.0.1:23333/state
    → 同上状态机（agent_id: hermes）
  终端聚焦 metadata 在 plugin register 时用 daemon thread 异步解析进程树；首个 hook 可不带 source_pid。

DeepSeek Harness 状态同步（in-process plugin，web profile，experimental）：
  DSH 公开 session/created / session/event / session/disposed
    → @dsh-external/dsh-clawd-bridge（Node ESM plugin，运行在 DSH 进程内）
    → 每个 session 独立 FIFO POST 动态发现的 127.0.0.1:23333-23337/state
    → src/dsh-state-sequence.js 用持久 event.seq / exclusive session.seq watermark 拒绝 stale、duplicate 和 dispose 后 late event
    → 同上状态机（agent_id: deepseek-harness，session_id: deepseek-harness:<raw>）
  bridge 只发送 event、state、工具名、cwd 和 seq 等 allowlist 字段；不发送 prompt、arguments、result 或 conversation。

opencode 权限气泡（event hook + 反向 bridge，非阻塞）：
  opencode 请求权限 → event hook 收到 permission.asked
    → plugin POST /permission（带 bridge_url + bridge_token）→ Clawd 立即 200 ACK（不挂连接）
    → Clawd 创建 bubble 窗口 → 用户 Allow/Always/Deny
    → Clawd POST plugin 的反向 bridge → bridge 用 ctx.client._client.post() 调 opencode 内置 Hono 路由 /permission/:id/reply
    → opencode 执行对应行为（once/always/reject）
  用户先在 opencode 原生 UI 回答 → event hook 收到 permission.replied（sessionID/requestID/reply）
    → plugin 同步失效 request 的反向 target，并在同 request asked POST 之后发送 replied lifecycle
    → lifecycle 使用 lifecycle_bridge_url/token（不复用普通 bridge 字段，对旧 Clawd fail-safe）
    → Clawd exact-match 删除该 request 的本地 pending、bubble、timer 与 notification
    → 不调用 reverse bridge，不复制 reply，不产生第二次宿主决定

MiMo Code 权限气泡（event hook + 反向 bridge，非阻塞，与 opencode 同源协议）：
  MiMo Code 请求权限 → event hook 收到 permission.asked
    → plugin POST /permission（带 bridge_url + bridge_token）→ Clawd 立即 200 ACK（不挂连接）
    → Clawd 创建 bubble 窗口 → 用户 Allow/Always/Deny
    → Clawd POST plugin 的反向 bridge → bridge 用 ctx.client._client.post() 调 MiMo Code 内置 Hono 路由 /permission/:id/reply
    → MiMo Code 执行对应行为（once/always/reject）
  MiMo Code 原生 UI 的 permission.replied 走同一 request-specific completion lifecycle；共享 core 与自动化已覆盖，
  但发布物真机验证必须单列，不能从 OpenCode 真机结果推断。

DeepSeek Harness 权限气泡（approval waterfall，阻塞）：
  DSH approval/request → bridge prepend listener 挂起 POST /permission
    → 独立 DSH adapter 创建仅 Allow Once / Deny 的 bubble（无 suggestions / Always / Go to Terminal）
    → allow / deny 分别映射为 allowed-once / rejected
    → 204、断连、DND、disabled 或所有审批通道无决定时 bridge 调 next()，交还 DSH web answerer
  ask_user_question 不进入 Clawd；DSH 原生 provider 始终是唯一 question owner。

远程 SSH 状态同步（反向端口转发）：
  远程服务器上的 Claude Code / Codex CLI
    → secure hooks 只 POST 到 profile pin 住的远端转发端口
    → SSH 隧道落到该 profile 的临时本地 ingress
    → ingress 校验 routing nonce 并写入 profileId canonical namespace
    → 同上状态机（CLAWD_REMOTE=1 + CLAWD_SSH_REMOTE=1，跳过远端 PID 聚焦）
  secure identity 缺失/损坏时 fail closed，不回退 23333-23337 扫描；
  通用本地 /state 与 /permission 不作为 SSH 隧道目标

权限决策流（Claude Code HTTP hook，阻塞）：
  Claude Code PermissionRequest
    → HTTP POST 127.0.0.1:23333/permission { tool_name, tool_input, session_id, permission_suggestions }
    → main.js 创建 bubble 窗口（bubble.html）显示权限卡片
    → 用户点击 Allow / Deny / suggestion → HTTP 响应 { behavior }
    → Claude Code 执行对应行为
    → 子 agent（Task）内触发的请求带 agent_id（实例 uuid）/ agent_type；server-agent-id.js 归一化为
      claude-code 并标记 subagent 来源，`agents["claude-code"].subagentPermissionsEnabled=false`（#451
      子开关）时直接断开连接让 CC 回落终端提示（ExitPlanMode / AskUserQuestion 豁免）

权限决策流（Codex official PermissionRequest command hook，阻塞）：
  Codex PermissionRequest
    → hooks/codex-hook.js POST /permission { tool_name, tool_input, tool_input_description, session_id, turn_id }
    → 默认 intercept 模式：main.js 创建普通 Allow / Deny bubble，用户点击后 codex-hook.js stdout 输出官方 JSON decision
    → 显式 native 模式：server 记录 notification 并立即返回 no-decision，Codex AutoReview / 原生审批继续处理
    → DND / disabled / bubble hidden / Clawd unavailable 时 stdout "{}"，Codex 回到原生审批提示
```

## Runtime Ownership Boundaries

`src/main.js` 是 composition root，不再是各子系统的实现 owner。新增或修改行为时先进入对应 owner，避免把逻辑重新堆回 `main.js`：

| Boundary | Owner |
|---|---|
| HTTP `/state` / `/permission` | `src/server-route-state.js` / `src/server-route-permission.js`；`src/server.js` 负责监听、端口与组合 |
| official hook / local monitor 仲裁 | `src/agent-runtime-main.js`，配合 `src/codex-turn-fence.js` / `src/codex-official-activity.js` |
| 双窗口与浮层 | `src/pet-window-runtime.js` 创建/定位 render + hit window；`src/floating-window-runtime.js` / `src/topmost-runtime.js` 管浮层重排与 z-order |
| Settings 写入与副作用 | `settings-controller` 是唯一写入者；`settings-actions*` 是 pre-commit gates；`settings-effect-router` 是 post-commit runtime effects |
| Settings UI | `settings-ui-core` 持有 shared UI state，`settings-renderer` 是侧栏/tab shell，业务页在 `settings-tab-*` |
| Theme | `theme-loader` 是 stateless loader；`theme-runtime` 是唯一 active-theme owner |

`state.js` 的 session snapshot 是共享 schema：Dashboard、Session HUD（含 Orbit quota ring）以及可选 Telegram completion、Discord presence、LAN PWA 等 consumer 都会读取它。新增、重命名或删除字段时必须检查全部 consumer，不能只看 Dashboard/HUD。

## Windows B1a Process Metadata Capability (#694)

Codex、Cursor Agent、Kiro CLI、CodeBuddy 和 Reasonix 的本地 Windows hook 支持一套版本化的 server-side process-chain capability。Clawd runtime owner 把以下数据写入 `~/.clawd/runtime.json`：随机 `instanceGeneration`，以及每个 agent 的 `legacy | shadow | b1a-authoritative` mode。默认始终是 `legacy`；`shadow` 和 `b1a-authoritative` 仅用于显式开发/验证，resolver 初始化或 ABI 校验失败时在写 runtime 前降级回 `legacy`。

本地 Windows、非 remote/WSL 的 hook 可以把当前 hook Node PID 和 runtime generation 放入 `X-Clawd-Hook-Pid` / `X-Clawd-Process-Instance`；headless/official/subagent 分类在 server 收到请求后完成，只有通过 effective eligibility 的请求才消费这些 header。header 只发往同一次 immutable runtime observation 指定的端口；扫描到其他 fallback server 时自动剥离。PID/generation 是 capability routing metadata，不是认证凭据。B1b adapter、自定义 HTTP Agent 和 Remote SSH 不进入该协议。

`shadow` 下 hook 仍提供 legacy metadata，server 用新 Windows resolver 做逐请求 fresh walk 并只记录 bounded parity；`b1a-authoritative` 下五个 hook 的 eligible 路径不再启动 legacy snapshot PowerShell，`/state` 和 Codex `/permission` 以 server 结果 replace/clear `sourcePid`、`agentPid`、`pidChain` 与 walk-derived editor。replace 失败必须清 stale process identity、重新计算 `pidReachable`，身份变化时清关联的 Windows Terminal HWND / Orca pane；Cursor 的 `editor="cursor"` 属于 adapter 常量而非 walk-derived 字段。Codex Desktop 保持 `sourcePid=agentPid`，普通 CLI 保持最外层 terminal 优先。Kiro 的 `sessionId="default"` 不得用于 process-chain reuse，每个请求都使用自己的 hook PID。

CodeBuddy direct HTTP `PermissionRequest` 不经过 Clawd command hook，因此没有可信 hook PID。B1a 当前只覆盖其 command state；permission-first 仍需真实协议/session identity 证据，不得伪造或从别的 session 猜测 PID。

## Multi-Agent Registry

每个 agent 定义为一个配置模块，导出事件映射、进程名、能力声明（`capabilities` 含 `httpHook` / `permissionApproval` / `sessionEnd` / `subagent`）：

- `agents/claude-code.js` — Claude Code 事件映射 + 能力（hooks、permission、terminal focus）
- `agents/codex.js` — Codex CLI official hook 事件映射 + JSONL fallback 轮询配置
- `agents/copilot-cli.js` — Copilot CLI camelCase 事件映射
- `agents/cursor-agent.js` — Cursor Agent（hooks.json）事件映射
- `agents/gemini-cli.js` — Gemini CLI hook 事件映射
- `agents/antigravity-cli.js` — Antigravity CLI (agy) hook 事件映射（state-only，无权限气泡）
- `agents/kimi-cli.js` — Kimi Code CLI（Kimi-CLI）hook 事件映射 + permission 分类策略
- `agents/zcode.js` — ZCode config-file hook 事件映射与阻塞式 PermissionRequest 人工权限审批（automation 未审计，全部 defer）
- `agents/kiro-cli.js` — Kiro CLI 事件映射（camelCase），无 HTTP hook / 无权限 / 无 subagent
- `agents/codebuddy.js` — CodeBuddy 事件映射（PascalCase，Claude Code 兼容），支持权限
- `agents/workbuddy.js` — WorkBuddy 事件映射（PascalCase，Claude Code 兼容），state + Notification only，无 Clawd 权限审批
- `agents/qwenwork.js` — QwenWork（千问办公）hook 事件映射（state-only，无权限气泡，无 startup recovery；`processNames.linux` 为空）
- `agents/opencode.js` — opencode 事件映射 + 能力（plugin、permission、terminal focus）
- `agents/mimocode.js` — MiMo Code 事件映射 + 能力（plugin、permission、terminal focus），与 opencode 同源
- `agents/pi.js` — Pi extension 事件映射 + 能力（extension，state-only，不接管 permission）
- `agents/openclaw.js` — OpenClaw plugin 事件映射 + 能力（state-only，本地终端聚焦暂不支持）
- `agents/hermes.js` — Hermes Agent plugin 事件映射 + 能力（session、SessionEnd、terminal focus、permission；无 subagent）
- `agents/registry.js` — agent 注册表：按 ID 或进程名查找 agent 配置
- `agents/codex-log-monitor.js` — Codex JSONL fallback 增量轮询器（文件监视 + 增量读取 + 状态 / metadata fallback，不再做审批猜测）
- `agents/gemini-log-monitor.js` — legacy Gemini session JSON 轮询器；当前 hook-only 路径不启动

运行时的 agent 安装意图 / 启停 / 权限气泡开关通过 `src/agent-gate.js` 读 `prefs.agents[id].integrationInstalled` / `.enabled` / `.permissionsEnabled`。`enabled` 仍然只表示是否处理该 agent 的事件：关闭会让 `state.js` / `server.js` 停止处理事件、清理 session / bubble；`integrationInstalled` 才表示本机 hook/plugin/extension 是否由 Clawd 维护。snapshot 缺字段时 gate 保守默认 true 以兼容旧版；新安装的 schema 会显式把 Claude Code / Codex 设为已安装且启用，其余 agent 设为未安装且未启用。Claude Code 额外有 `.subagentPermissionsEnabled` 子开关（#451，仅 claude-code 默认条目携带该 flag），控制 Task 子 agent 发起的 PermissionRequest 是否弹泡泡。

动态 custom Agent 是上述安装模型的明确例外：`customApplications` 是注册真相，validate post-pass 保证每个已注册 ID 都有 gate entry，且始终显式写 `integrationInstalled=false`、`permissionsEnabled=false`。它不会进入 integration sync map；`enabled` 只控制 `/state` ingress。删除注册项会同步清 session、权限残留和该 ID 的 recent-event ring，并删除 stale custom gate；未知的非-custom agent entry 仍保留向前兼容。

`server-hook-events.js` 的 recent-event ring 按已解析 agent ID 分桶，Settings 的“本次运行活动”和 Doctor connection test 共用这份进程内数据。非法 `custom-` identity 一律写入固定 `rejected-custom` 桶，原始 ID 最多保留 80 字符作为诊断字段，不能让随机 ID 制造无界 Map key。ring 不写 prefs，重启即清空。

## Hook And Plugin Sync

启动链路只会自动补齐 `integrationInstalled=true` 且 `enabled=true` 的缺失集成；若 prefs 文件不可读（`locked && recovered`），内存 snapshot 只是非权威 defaults fallback，整条 prefs-backed agent runtime gate 会 fail closed，本次进程不自动同步集成、不启动 monitor、不接受 state/permission ingress，也不恢复旧 session：

- `server.js` 启动后异步同步已安装且已启用的 Claude / Codex / Copilot / Gemini / Antigravity / Cursor / CodeBuddy / WorkBuddy / Kiro / Kimi / Qwen / ZCode / CodeWhale / Qoder / QoderWork / QwenWork / Reasonix hooks、opencode / MiMo Code / OpenClaw / Hermes / DeepSeek Harness plugins 和 Pi extension；Hermes 同步会先做无副作用安装探测，未安装时不创建 `~/.hermes`；DSH startup sync 不初始化缺失的 web profile，只 repair 已 opt-in 的 marker-owned entry
- Claude hook 同步时还会扫 `DEPRECATED_CORE_HOOKS`（当前含 `WorktreeCreate`）清掉旧版本留下的过时 Clawd hook。常规所有权仍认 command 中的字面 `clawd-hook.js` marker；兼容 #852 的外部 env 间接形式时，只有“单条简单 Node 调用 + 精确 `CLAWD_HOOK_PATH` token + 唯一事件参数”，且 `settings.env.CLAWD_HOOK_PATH` 的跨平台 basename 恰为 `clawd-hook.js` 才视为 owned。复合命令、间接 env 值和第三方同事件 hook 均 fail closed。deprecated / versioned / HTTP-only / uninstall 路径删除全部 owned 命中；active state hook 则按子项位置折叠成一条，优先保留已 canonical 的命令并保留 mixed wrapper 的 matcher / 第三方 sibling。迁移不会改写 `settings.env`；严格的反注入规则只校验外部 env Node 候选，不会拒绝安装器已解析/保留的绝对路径（如含括号的 Windows 路径）。若 env-only 事件无法验证可用的绝对 Node 路径，会保留一条 env hook 而不是降级成裸 `node`；若已有 literal hook，则保留 literal 而不让不可迁移的 env duplicate 取代它

Settings Agent 页的 Install 会执行对应 sync 并把 `integrationInstalled=true, enabled=true` 一起提交；Uninstall 会调用 marker-scoped 卸载器，并把 `integrationInstalled=false, enabled=false` 一起提交。单独重新启用一个未安装 agent 只打开事件入口，不会写本机配置；手动安装命令主要用于调试、重装或远程机部署。

CodeBuddy 的 PermissionRequest HTTP 所有权只认严格的本机 managed URL，或版本化 marker `clawd-on-desk.permission.v1`。旧 `name:"clawd"` 只有在 URL 同时属于 managed local endpoint 时才会迁移；同名第三方/custom URL 注册和卸载均不触碰。进程内 startup、Settings install/clear/repair 显式传 `{mode:"local"}` 或 `{mode:"custom",url}`；裸 CLI 与 WSL deploy 用 `{mode:"preserve"}`，防止把 marker-owned custom URL 意外改回 localhost。

### Claude hook 健康巡检与自愈（#657）

`src/claude-settings-watcher.js` 除了原有的目录 watcher（盯 `~/.claude/` 目录、debounce 1 秒）外，还跑一个自调度的低频只读健康巡检：

- 默认周期 5 分钟，不依赖任何 settings.json fs 事件——hook 脚本在其他目录（如系统 Temp）被删除也能发现，watcher 和周期巡检共用同一个 `runHealthCheck(reason)` 决策函数。
- 判断逻辑收敛在 `src/claude-hook-health.js` 的 `inspectClaudeHookHealth()`：解析 command、校验 nodeBin/scriptPath、比对当前权威路径（`hooks/install.js` 的 `getClaudeHookScriptPath()` / `getClaudeAutoStartScriptPath()` / `CLAUDE_CORE_HOOK_EVENTS`），复用 Doctor 的 `agent-node-bin-parser.js` 解析器，不另起一套正则。
- env-indirected state hook 先复用 `hooks/json-utils.js` 的严格 ownership classifier，再进入健康判定；它不会把未展开的 `${CLAWD_NODE_BIN}` / `${CLAWD_HOOK_PATH}` 交给普通 target validator。可安全迁移和 owned duplicate 产生专属 automatic repair class；Node 路径无法验证或 ownership 证据不足只产生 degraded 诊断，不消耗 3 次自动修复预算。watcher 的 suspicious-shrink snapshot 也复用同一 classifier，避免把待迁移的 Clawd env hook 误记成第三方 hook。
- 可自动修复的问题（`buildClaudeRepairSignature()` 判定）经 `src/claude-hook-operations.js` 的实例级队列串行 repair，repair 后重新读盘用同一 inspector 复验，不只信 installer 的 `updated>0`。
- 同一 repair signature 连续 3 次修复+复验失败后进入 `manual-fix-required`，停止自动 mutation，只保留 5 分钟只读复查；健康恢复或 repair class 集合实际变化时清计数。
- `settings.json` suspicious-shrink 期间只弹一次 `notifySuspiciousShrink`，不会每个周期重复通知。
- 当前安装包的 hook 源脚本（`getClaudeHookScriptPath()`）本身不存在时，不会尝试任何 reconcile（写了也没用），状态设为 `source-script-missing`，Doctor 提示重装/重新解压而不是提供配置 Repair。
- 巡检严格受 `manageClaudeHooksAutomatically`、`claude-code.integrationInstalled`、`claude-code.enabled` 三个 gate 保护，和目录 watcher 共用同一套 gate。
- 所有 mutation 入口（启动 reconcile、watcher 自动恢复、周期自愈、Settings Agent Install/Enable、Doctor Fix、`autoStartWithClaude` 开关、Settings Agent Uninstall、legacy hooks Install/Uninstall、About 页 `cleanupIntegrations`）都经过 `src/server.js` 持有的同一个 `claude-hook-operations.js` 队列实例，串行执行、互不覆盖；statusline 注册/卸载只在 startup、Settings Agent Install/Enable、Settings Agent Uninstall、About cleanup 这几个来源触发，周期巡检和 Doctor Fix 不碰 statusline。
- 历史 key `claudeQuotaCollectionEnabled` 现在是本机 Claude statusline metadata（context window + 可用 quota）的唯一用户授权。关闭或卸载时，server 先用进程内 suppression 挡住未结尾包，再 ownership-safe 卸载并清除 `profileId="local"`（含 WSL）会话的 statusline 分母所有权，同时从 account-quota store 定向删除所有非 `remote:` 来源的 `claudeQuota` 并立即广播、持久化；同源 Codex / Antigravity provider 与 Remote SSH quota 保留。关闭态启动也会执行同一缓存迁移。statusline 上报拥有 limit，普通 transcript hook 仍可更新 used，并按保留的权威 limit 重算 percent。
- Kimi Code quota 是独立的 main-process、manual-only transport：只有 Settings 中显式 Connect/Replace/Reconnect/Refresh 才会请求固定的 `https://api.kimi.com/coding/v1/usages`，app ready、hook、resume、Dashboard show 都不联网。Kimi Code API Key 以 Electron `safeStorage` 密文保存在 `~/.clawd/kimi-code-quota-credential.json`，不进入 prefs、settings snapshot、日志或 `account-quota.json`；Linux `basic_text` backend fail closed。每次保存生成与 Key 无关的随机 `credentialId`，`~/.clawd/kimi-quota-runtime.json` 在 quota store 同步 flush 后才记录该 id；启动发现 id 缺失/不一致会先清理本机 Kimi cache，避免 Replace Key 的 crash 窗口把旧账户额度标成新连接。`kimiQuotaCollectionEnabled` 是 command-only durable gate，runtime 在请求 admission 和 response commit 两端都重读该 gate 与 `kimi-cli.enabled`；hook payload 永远不是 Kimi quota 来源。Disconnect 后的重连走专用 trusted IPC `settings:kimi-quota-reconnect` → `runtime.reconnect()`：只读校验本地密文可用后 re-enable 并立即走与 Refresh 完全相同的 admission/commit 路径，属于用户显式手动动作，Key 始终不离开 main process。
- `server.getClaudeHookHealthStatus()` 暴露供 Doctor 使用的只读状态（`healthy` / `repairing` / `degraded` / `manual-fix-required` / `guarded` / `stopped`），与既有的 `getClaudeHookGuardStatus()`（仅覆盖 suspicious-shrink 一种通知）并存，互不替代。

## Permission Bubble

- Claude Code / CodeBuddy 的 PermissionRequest 用 HTTP hook（阻塞式），其他事件用 command hook（非阻塞式）
- `agents/registry.js` 的 capability 声明是 agent 是否进入权限、interactive bubble、subagent 等路径的权威来源；文档里的 agent 名单只是说明，不可替代 capability gate。automation 的 agent/family eligibility 另有显式白名单，故意不能从 `permissionApproval` 自动推导；工具 eligibility 是 mode/adapter-specific，不是单一逐工具 allowlist
- 动态 custom HTTP Agent v1 是 state-only：`/permission` 恒不返回 Allow/Deny，也不创建权限 bubble
- WorkBuddy 不进入 `/permission`：权限请求只以 Notification 驱动提醒，Allow / Deny 决策留在 WorkBuddy 原生 GUI
- QwenWork 不进入 `/permission`：`PermissionRequest` / `PermissionDenied` 只被观察并映射成 `working`，hook stdout 恒为 `{}`，Clawd 不产生 allow/deny，也不在 permission automation eligibility 名单内
- DeepSeek Harness 普通 approval 进入独立 blocking adapter；人工 Allow/Deny 可用，但 auto-tools、unattended 与 per-session grant 全部 DEFER。`ask_user_question` 返回 204 交给 DSH 原生 provider
- Codex 的 PermissionRequest 是 official command hook；hook 脚本挂起等待 `/permission`，再把 sanitized allow/deny JSON 写到 stdout
- `POST /permission` 接收 `{ tool_name, tool_input, session_id, permission_suggestions }`；Codex 额外带 `turn_id`、`tool_input_description`、`tool_input_fingerprint`
- 每个权限请求都会创建独立 `BrowserWindow`。普通卡片默认保持约 340 CSS px 的三行摘要；长内容和次级操作通过用户点击进入约 500 CSS px 的详情态，详情正文独立滚动，标题与决定按钮固定可见。安全 normal layout 中到达的首张可回答 Ask 默认直接进入详情态；桌面同时最多一个详情 owner，其他请求仍是摘要卡。切换详情不会销毁窗口，因此 Ask/Plan 的选择、输入草稿、步骤和滚动位置都保留
- 普通工具摘要态保留 Allow/Deny、permission suggestions（含 Always）和可用的会话授权；Plan 摘要态同时提供「查看计划」与快速批准，反馈/回终端等次级操作只在详情态出现；未能创建期默认展开的 Ask 摘要态只提供「回答」。Plan 与默认展开的 Ask 到达时都不抢焦点；只有本地显式展开或 queue selection 才聚焦窗口并发送一次 restore-active-control。Win/Linux 由创建期 `focusable` 覆盖其潜在输入需求
- bubble 通过 IPC `bubble-height` 回报 `{state, measurementEpoch, height}`。主进程只接受当前摘要/详情 epoch 的测量，避免展开→收起→展开期间的旧高度覆盖新布局；详情高度以 `min(60% workArea, 620 CSS px)` 为偏好，并以实测 chrome + 5 行正文为可读下限、当前 workArea 为硬上限。卡片没有自己的宽度（`html/body` 撑满窗口），自然高度随 BrowserWindow 宽度变化，所以 renderer 在窗口宽度真正改变后会再报一次高度；详情→摘要的 presentation 早于 `repositionBubbles()` 收窄窗口，没有这次补测就会按详情宽度少算一个折行，摘要卡底部被窗口裁掉
- `permission.js` 是 permission presentation 的唯一 owner：它用目标 workArea、text scale、HUD avoid rect 和每张卡实测宽高先尝试原逐窗栈；不安全时按 agent + session 选 FIFO 代表并预留队列入口，再只向减少非保护代表的方向收敛。详情、IME composition、文本输入和用户显式选中的请求是保护项。可选代表准入按 expanded owner 的 frozen size 计算，不能靠压扁保护项腾位置；代表集合确定后，带 launcher 的最终 layout 才从 expanded viewport 的本轮有效高度中扣除 launcher、已选其他代表和全部 gaps。该 effective cap 不改 frozen normal-mode budget；含 expanded representative 且最终仍不安全的候选不得进入新的 queue revision/ACK。首次从 normal mode 命中该 guard 时仍应用 crowded normal bounds 并同步全可见 ownership，已有 committed overflow 则保持原样；普通非展开请求继续沿用既有 queue-failure fallback。Follow 模式详情朝远离桌宠的一侧扩展，Fixed 模式保持所选角的边缘对齐
- overflow 队列使用独立 `permission-queue.html` / preload / renderer，只暴露 open、close、select、ACK 四类导航 IPC，没有任何决定 IPC，也不接收本地详情、wire input、suggestions 或 token。抽屉打开时隐藏请求窗口但不销毁；选中项后恢复原 BrowserWindow/DOM。每个队列 revision 必须先 ACK 再提交 visible/hidden 集合，提交期限从第一条尚未被当前 ACK 表示的请求开始且不会被后续 revision 续期；队列加载、renderer、window 或 ACK 失败时，本 overflow episode 只回退逐窗栈且不重建、不决定请求
- overflow 模式关闭全局 Allow/Deny 快捷键；Slack 只在请求窗口自身 height ACK 或已 ACK 队列的 main-owned hidden snapshot 上执行现有 once-guard。petHidden 使用 request ordinal cutoff 隔离旧请求与隐藏期间的新请求；topmost、IME overlap、HUD/update/Orbit 避让和 roam hold 都只扫描 presentation owner 返回的真实可见 permission windows（含队列及仍在 fade 的请求窗）
- 本地详情数据与网络/决策数据分离：route 在生成有界摘要的同时保留最多 128 KiB 的仅本地显示详情；fingerprint、automation、HTTP 回包、Telegram/飞书/Slack payload 继续使用原有数据。Ask 的 wire question/answer key 保持上游原文，长正文和选项说明只影响详情显示
- 支持 Allow / Deny / suggestion 决策，以及 `addRules` / `setMode` suggestion 类型
- `permission-automation-policy.js` 的 off / auto-tools / unattended 与 `session-automation-coordinator.js` 的 per-session grant 会在 bubble 渲染前产生真实决定。auto-tools 对 Claude/Qwen 的未知 built-in（除有效 namespaced MCP）fail closed，但其他已知 adapter 对非空工具名不都使用逐工具 allowlist；unattended 在识别已知 decision tools 后仍有意对可作 Allow/Deny 的未知请求保留“handle every request”行为。新增 agent/tool/interaction 必须同时审查 policy 与 tests，不能笼统假设 unknown 一律 defer
- Telegram 与飞书 / Lark 是和本地 bubble 并行的远程决策通道；关闭本地 bubble 不等于关闭远程审批。远程 client 超时、断连、未配置或启动失败不得产生决定或 deny：本地 bubble 存在时请求继续 pending；仅在 remote-only 且所有可用 client 都无决定时，整体请求才 no-decision 并让 agent 回原生 UI 重问
- DND 只负责“不弹 bubble”，不替用户决定权限：opencode 与 MiMo Code 分支 silent drop，让 TUI 内置权限提示接管；Claude Code 分支 `res.destroy()`，让 CC 回到内置聊天/终端确认；Codex 分支返回 no-decision `{}`；DeepSeek Harness 分支返回带 server identity 的 204，让 plugin `next()` 到原生 web answerer
- Codex 审批只认 official `PermissionRequest` hook；JSONL fallback 不再根据 shell function_call 猜测审批，也不再创建 Codex passive approval notify bubble
- 涉及 Claude Code 权限 payload 的改动（`permission_suggestions`、`updatedPermissions`、elicitation 输入等）必须至少用一次真实 Claude Code 验证；`curl` 自编请求历史上掩盖过字段结构 bug

### Codex official hook notes

P0 spike（2026-04-26，Windows native Codex CLI）采到的实际 payload 边界：

- `session_id` 与 `transcript_path` 文件名里的 rollout UUID 一致；`codex-hook.js` 仍优先从 `transcript_path` 提取 UUID 作为防御。
- `permission_mode` 在采样到的 SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse / Stop 中都存在，值为 `default`。
- `SessionStart.source` 采到 `startup`；其他事件不带 `source`。
- `Stop.stop_hook_active` 采到 `false`；`true` 时 hook 直接 no-op，避免 Codex stop continuation 边界抖动。
- 普通 `PreToolUse` / `PostToolUse` 的 `tool_input` 不保证有 `description`；Bash 和 `apply_patch` 样本只有 `command`。
- `PermissionRequest.tool_input.description` 在真实审批样本中存在，作为 bubble 文案首选；缺失时回退格式化 `tool_input`。
- Codex PermissionRequest 输出必须 omit `updatedInput` / `updatedPermissions` / `interrupt`，不能写 `null`；这些字段今天 fail closed。

## Plugin Notes

opencode、MiMo Code、OpenClaw、Hermes 和 DeepSeek Harness 是 plugin 形式集成的 agent；OpenClaw Phase 1 只上报状态，其他 agent 主要是 hook 脚本。

- 进程树 walk 从 `process.pid` 起步，不是 `ppid`
- `task` 工具会直接新建 session，而不是产出 subtask part；只有 `session.created` 明确带 `event.properties.info.parentID` 的 session 才会被视为 child
- opencode child session 作为 root 拥有的后台 headless 工作处理：不参与 HUD / focus / 多会话 fanout，`session.idle` 会降级为 `sleeping/SessionEnd`，root session 的 `session.idle` 才映射 `attention/Stop`；MiMo Code 与 opencode 同源，child session 行为一致
- 由于 `permission.ask` hook 在 opencode 1.3.13 上未被调用，权限只能走 event hook + 反向 bridge；MiMo Code 同源，权限同样走 event hook + 反向 bridge
- plugin 内发出的 POST 必须 fire-and-forget，避免拖慢 TUI
- 打包后需要把 `app.asar/` 重写为 `app.asar.unpacked/`
- Hermes plugin 使用同步 POST，避免短命 `hermes -z` 进程退出前丢事件；Clawd 未启动时有短 cooldown，避免反复扫端口
- Hermes 的 `agent_pid` 当前是 plugin worker 进程 PID；`source_pid` 来自异步进程树解析，给终端聚焦使用
- Hermes config.yaml 是用户 YAML，不做 line-oriented 编辑；安装只复制托管 plugin 文件并调用 `hermes plugins enable clawd-on-desk`
- DeepSeek Harness 首发只支持 web profile 与 npm 发布物 `@deepseek-ai/dsh@0.1.0-rc.6`。安装器按 canonical `DSH_HOME` 哈希命名空间把 bridge 复制成 immutable hash generation，再用官方 `dsh plugin --profile web add/remove` mutation；dependency、bundle row、installation-first/profile-second resolution 与 Clawd marker 必须同时验证，foreign 同名 package 永不覆盖或删除；不同 DSH_HOME 不共享可删除 generation、mutation lock 或 inspection latch
- DSH mutation lock 只在 owner/schema/token/PID/timestamp/owner-recorded operation timeout 全合法、年龄超过该 owner timeout 的两倍、且 PID probe 明确返回 `ESRCH` 时通过 sibling atomic rename 接管；live PID、`EPERM`、unknown、corrupt/foreign owner 均 fail closed，错误必须暴露精确 lock path。owner write/release 只允许隔离并删除 exact owner file 与空 lock dir，禁止 recursive canonical cleanup。无全局 CLI 的手动 npx generation 通过同 namespace 的 owned reference 持久保活，直到验证或显式卸载；命令显式 pin shell-quoted canonical `DSH_HOME`，malformed/foreign/concurrent anchor 一律保留 generation 并要求人工检查
- DSH state listener 是 fire-and-forget FIFO；approval listener 是唯一例外，必须阻塞等待决定或 `next()`。`session/created` observer 顶层 non-throwing，避免同步异常 veto DSH session 创建
- DSH projection storage 不是稳定协议：首发不读取 workspace/projcache，也不运行 fallback monitor
- DSH Install/Repair 成功与 Doctor healthy 都是 disk-only 结论，必须提示重启正在运行的 `dsh web`。安装器/Doctor 对非 `0.1.0-rc.6` 禁止 mutation 并报警；上游没有 external plugin 可用的公开 runtime host-version/activation seam，因此已安装 bridge 遇到 DSH 原地升级时无法在 listener 注册前可靠自禁用，这是 experimental residual，不得写成 runtime fail-closed 保证

## Pi Notes

- Pi 使用 global extension 目录 `~/.pi/agent/extensions/clawd-on-desk`；安装器复制 `pi-extension.ts` 和自包含的 `pi-extension-core.js`
- Extension 运行目录不在 Clawd repo 内，不能依赖 `hooks/shared-process.js`；需要的进程树和 HTTP 逻辑保持在 extension 文件内
- 只在 `ctx.hasUI === true` 或交互式 TTY 模式上报状态，避免 print/RPC 模式污染桌宠状态
- Pi 是 state-only：`tool_call` 只上报 `PreToolUse` 状态，不等待 Clawd `/permission`，不弹权限气泡，也不调用 `ctx.ui.confirm()`
- 旧版 managed extension 如果仍在已启动的 Pi 进程里向 `/permission` 发请求，server 返回 allow，保持 Pi 默认 YOLO 行为，而不是把 fallback 变成手动确认
- `tool_call` handler 必须顶层 catch 并返回 `undefined`；Pi 的 `emitToolCall()` 不 catch extension 异常，未捕获异常可能变成通用 `Extension failed, blocking execution`
- `tool_result` 按 `isError` 拆成 `PostToolUse` / `PostToolUseFailure`
- Pi permission subgate 默认关闭：`prefs` 默认把 `agents.pi.permissionsEnabled` 置为 `false`；v4 migration 会把旧 true 重置为 false

## OpenClaw Notes

- Phase 1 只支持状态动画，不接 OpenClaw 的 `requireApproval` / permission bubble。
- Phase 1 明确面向 `openclaw tui --local` 这类本地单进程使用形态；gateway / daemon / messaging 部署没有稳定终端窗口锚点，后续再设计。
- 插件目录是 `hooks/openclaw-plugin/`，manifest 必须包含 `activation.onStartup` 和空对象 `configSchema`。
- 安装器默认只直写已经存在且可被 `JSON.parse` 解析的 `~/.openclaw/openclaw.json`（或 `OPENCLAW_CONFIG_PATH`）；发现 JSON5/comment/$include 时跳过启动同步，手动 `npm run install:openclaw-plugin` 才走 OpenClaw CLI fallback。
- 启动同步不会主动创建 `~/.openclaw/openclaw.json`。OpenClaw 没装或尚未初始化时返回 skip，避免抢先写入残缺配置。
- OpenClaw 在 Windows 上通常是 `node.exe ... openclaw.mjs`，所以 `agents/openclaw.js` 不声明进程名。OpenClaw 的 install scanner 会拦截带 `child_process` 的插件；Phase 1 插件不做进程树 walk，只发送 `agent_pid`，Sessions Dashboard 的终端聚焦对 OpenClaw 暂不可用。
- `model_call_ended` 成功后用 1500ms debounce 发 `Stop`；期间有新 model/tool/compaction 活动则取消。`failureKind=aborted|terminated` 也按非错误 `Stop` 处理，只有 timeout/connection 等失败发 `StopFailure`。
- `session_end` 只在 `idle|daily|deleted|unknown` 时映射 `SessionEnd/sleeping`；`new|reset|compaction` 不让桌宠睡觉。
- OpenClaw POST body 是 allowlist：`agent_id`、`session_id`、`state`、`event`、`cwd`、`agent_pid`、`tool_name`、`tool_use_id`、`hook_source`、`openclaw_*`、`error_present` 等；禁止透传 `params` / `result` / `error` 字符串 / `messages`。

## Terminal Focus And Remote

- CJS hook 脚本通过 `hooks/shared-process.js` 的 `createPidResolver()` 与 lifecycle context 遍历进程树定位终端应用 PID（Windows Terminal、VS Code、iTerm2 等）；opencode-family plugin 保留自己的内部 resolver
- 不要用 `process.ppid` 做轻量替代：Claude Code / hook 进程链里它通常只是临时 shell PID，不稳定也不可持久化
- `source_pid` 跟随状态更新送到 `main.js`，用于 Sessions 菜单聚焦
- 右键 Sessions 子菜单点击后，`focusTerminalWindow()` 会用 PowerShell（Windows）或 `osascript`（macOS）聚焦终端
- 远程场景只通过 Settings Remote SSH controller 部署：`runtimeKey → layout` 解析、
  installId/profileId/nonce 身份、原子 lease/fencing、持久部署事务和 profile 专属 ingress
  共同把远端 hook 事件回送到本地 Clawd；`scripts/remote-deploy.sh` 已 fail-fast 停用
- `account-default` 用于不同 Unix 账号；同 Unix 账号默认冲突阻止。实验
  `profile-isolated` 仅在显式验证开关下出现，分开 Claude/Codex/Copilot 用户级
  config/session/runtime roots 与 wrapper，不虚拟化整个 HOME，也不是同 UID 安全边界

### Remote SSH transport coordination

Remote SSH 有两条明确分开的 transport 路径：

- `remote-ssh-transport.js` 通过 `ssh -G` 展开本机 SSH 配置并分类 effective transport。ordinary SSH 保持原 parallel tunnel + health-probe 行为；Codespaces `gh cs ssh --stdio` 和显式 serialized override 进入 single-session 路径。ProxyCommand 输出只作为 bounded data 解析，不得求值或重放；首次 unknown inspection 必须 fail closed
- serialized ownership 以有效 transport key 为作用域，不是 profile id。同一 target 的 sibling profiles 共享一个 coordinator slot；非 owner 的 Connect、mutation 和 interactive terminal 必须返回 busy，不能另起 child
- serialized connection 与 operation 先取得 coordinator context，其 managed SSH/SCP child 必须经 context 的 pre-spawn gateway；spawn 后再登记不构成 admission。ordinary transport 在没有 retained serialized occupancy 时保留 `context:null` 的 parallel raw-child 路径，但不能在配置漂移后被偷偷重键为 serialized。用户发起的 detached interactive terminal 不纳入 managed child；fresh inspection 命中 serialized 或 retained occupancy 时必须通过 `checkInteractive()`，且只在 target 无 owner、无 child、无 operation、非 quarantine 时放行
- serialized persistent tunnel 把 readiness command/marker 放在同一 SSH session，不再开第二条 probe SSH。准备期的 Node resolve 与可选 monitor mutation 必须在 tunnel 前完成；automatic reconnect 只重复只读准备，不盲目 replay mutation
- 正常暂停通过 tunnel stdin EOF 请求远端 readiness process 退出，并等待 child `close`。`exit`、强杀或带 signal 的 outer `ssh.exe` close 都不足以证明 nested ProxyCommand 已 drain；未验证 drain、watchdog timeout 或仍有 live child 时 slot 进入 quarantine，禁止新 child、mutation、resume 和 interactive terminal
- Deploy/Repair/cleanup 保留既有 identity transaction、layout-scoped lease、fencing 与 ownership checks。mutation 在 lock acquire-attempted / lock-owned 后出现 255、EOF/reset、signal 等 unknown result 时不得 replay、retry、自动 release lock 或恢复连接；返回 primary error，并按 lock stage 暴露 recovery state / `manual_lock_inspection_required`
- operation 后是否恢复 tunnel 只看最新 `desiredConnected` / generation、最新 profile 与 fresh inspection；用户在 operation 中 Disconnect 必须赢，target/config 漂移必须 fail closed

用户流程见 `docs/guides/guide-remote-ssh.md`，真机矩阵与精确清理流程见 `scripts/manual/README.md`。Unit tests 不能证明 Windows OpenSSH 的 nested `gh.exe` 生命周期，也不能用 Codespaces 结果推断 ordinary-host V15。

## Context Menu Owner Window

- `contextMenuOwner` 必须保留 `parent: win`；没有 parent 再配 `closable: false` 会导致 `app.quit()` 无法正常收尾
- 退出路径依赖 `requestAppQuit()` 先把 `isQuitting = true`，再让 `window-all-closed` 真正走到退出分支；不要绕开这套守卫

## Updating

- Git 模式（非打包，主要是 macOS/Linux 源码运行）会 `git fetch` 比较 HEAD，有更新则 `git pull` + 必要时 `npm install`，然后 `app.relaunch()`
- Windows NSIS 与 macOS DMG 打包模式走 `electron-updater`；均保持 `autoDownload=false`，用户确认后才下载
- macOS Release 同时发布 x64 / arm64 的 DMG 与 ZIP；DMG 用于首次/手动安装，Squirrel.Mac 只消费 ZIP。`latest-mac.yml` 必须同时列出两架构的 ZIP 与 DMG，且 top-level `path` 指向 x64 ZIP
- macOS 下载完成后可选择立即重启，或稍后正常退出并重新打开；安装请求期间复用 update bubble 显示准备状态，ready/staging 错误必须作为真实错误显示，不能降级成“已是最新”
- 旧版 DMG 没有 ZIP 更新载荷，不能自举到首个支持应用内更新的桥接版；现有用户仍需手动安装桥接版一次。单元/metadata/包结构验证不等于同一 Developer ID 的 A→B 真机升级证据
- 托盘菜单里的 “Check for Updates” 可以手动触发

## i18n

- 支持 en / zh / zh-TW / ko / ja / pt-BR / es
- 文案集中在 `src/i18n.js`
- 语言偏好持久化到 `clawd-prefs.json`，启动时通过 `hydrate()` 灌入 controller
