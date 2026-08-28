# AGENTS.md

This file is the entry point for coding agents working in this repository. Keep it short and operational. Durable architecture lives in `docs/project/`; `docs/plans/` and `docs/investigations/` are historical evidence unless this file explicitly links them.

## Project Overview

Clawd 是一个 Electron 桌宠：通过 hook、日志轮询、plugin 和 extension 感知 AI coding agent 的工作状态，并播放像素风动画。当前支持 Claude Code、Codex CLI、Copilot CLI、Gemini CLI、Antigravity CLI (agy)、Cursor Agent、CodeBuddy、WorkBuddy、Kiro CLI、Kimi Code CLI (Kimi-CLI)、Qwen Code、ZCode、CodeWhale、opencode、MiMo Code、Pi、OpenClaw、Hermes Agent、Qoder、QoderWork、QwenWork (千问办公)、Reasonix、DeepSeek Harness、TraeCode (Trae CN)；内置 Clawd / Calico / Cloudling 三套主题，支持用户主题；平台覆盖 Windows、macOS、Linux，UI 支持 en / zh / zh-TW / ko / ja / pt-BR / es。

## Common Commands

```bash
npm start
npm run build                  # default Windows package
npm run build:win:x64
npm run build:win:arm64
npm run build:win:all
npm run build:mac
npm run build:linux
npm run build:all
npm install
npm test
npm run verify:electron
npm run verify:release
npm run audit:assets
npm run audit:native-package -- --app-root <extracted-app-root> --target <target-id>
npm run create-theme

npm run install:claude-hooks
npm run uninstall:claude-hooks
npm run install:cursor-hooks
npm run install:gemini-hooks
npm run install:antigravity-hooks
npm run install:kiro-hooks
npm run install:kimi-hooks
npm run install:qwen-hooks
npm run install:zcode-hooks
npm run uninstall:zcode-hooks
npm run install:codewhale-hooks
npm run uninstall:codewhale-hooks
npm run install:pi-extension
npm run uninstall:pi-extension
npm run install:openclaw-plugin
npm run uninstall:openclaw-plugin
npm run install:hermes-plugin
npm run uninstall:hermes-plugin
npm run install:qoder-hooks
npm run uninstall:qoder-hooks
npm run install:qoderwork-hooks
npm run uninstall:qoderwork-hooks
npm run install:qwenwork-hooks
npm run uninstall:qwenwork-hooks
npm run install:reasonix-hooks
npm run uninstall:reasonix-hooks
npm run install:workbuddy-hooks
npm run uninstall:workbuddy-hooks
npm run install:dsh
npm run uninstall:dsh
npm run install:codex-hooks
npm run uninstall:codex-hooks
npm run install:codex-debug-hooks
npm run uninstall:codex-debug-hooks
npm run install:mimocode-plugin
npm run uninstall:mimocode-plugin
node hooks/codebuddy-install.js
node hooks/opencode-install.js

bash test-demo.sh [seconds]
bash test-mini.sh [seconds]
bash test-macos.sh
bash test-oneshot-gate.sh [state] [seconds]
```

新安装默认只把 Claude Code 和 Codex 标记为已安装并启用；其他 agent 默认未安装、未启用。正常启动时，Clawd 只会为 `integrationInstalled=true` 且 `enabled=true` 的 agent 自动同步 Claude / Codex / Copilot / Gemini / Antigravity / Cursor / CodeBuddy / WorkBuddy / Kiro / Kimi / Qwen / ZCode / CodeWhale / Qoder / QoderWork / QwenWork / Reasonix / TraeCode hooks、opencode / MiMo Code / OpenClaw / Hermes plugins 和 Pi extension。Settings Agent 页的 Install 会安装并启用该集成；Uninstall 会卸载 Clawd 管理的 hook/plugin/extension，并同时把该 agent 设为未安装、未启用。单独关闭 enabled 只会跳过启动同步并屏蔽事件/权限入口，不卸载用户已有 hooks / plugins / extensions；重新启用未安装 agent 只打开事件入口，不会写本机集成文件。手动安装命令主要用于调试、重装或远程部署。
Settings 注册的自定义 HTTP Agent 是独立模型：`customApplications` 是注册真相，对应 `agents[customId]` 必须显式保持 `integrationInstalled=false`。注册只分配 ID 和状态入口，不安装 hook、不观察进程；v1 仅允许已注册且启用的 ID 向 `/state` 上报，`/permission` 永远不提供决定。删除或伪造的 `custom-` ID 必须直接拒绝，不能降级成 Claude Code subagent。
Copilot CLI 同步走 `<COPILOT_HOME 或 ~/.copilot>/hooks/hooks.json`，marker-based 增量合并只接管含 `copilot-hook.js` 标记的条目，用户其他 entry / 其他 `hooks/*.json` 文件原样保留；hooks.json 或 `settings.json` 顶层 `disableAllHooks: true` 时 doctor 报 warning（不挂 Fix 按钮）。详见 `docs/guides/copilot-setup.md`。

## Read These Docs

- `docs/project/agent-runtime-architecture.md`：运行时架构、模块边界、启动与数据流、多 agent、permission bubble、终端聚焦和自动同步
- `docs/project/theme-state-ui.md`：状态机、主题系统、settings、mini mode、素材规则、平台限制、待落地 UI 决策
- `docs/project/release-process.md`：发版 checklist、release note 核对、tag 触发 GitHub 打包和资产确认
- `docs/guides/copilot-setup.md`：Copilot CLI 自动同步说明、`COPILOT_HOME` 兼容性、手动配置备选模板
- `docs/guides/dsh-setup.md`：DeepSeek Harness web profile 实验性 plugin-only 状态与普通审批集成
- `docs/guides/state-mapping.md`：状态 → 动画权威表
- `docs/guides/guide-theme-creation.md`：主题作者指南
- `docs/guides/setup-guide.md`：安装、远程 SSH、各 agent 接入
- `docs/guides/custom-agent-http.md`：自定义 HTTP Agent 的 state-only 接入合约和动态端口发现
- `docs/guides/known-limitations.md`：用户向已知限制
- `docs/guides/codex-wsl-clarification.md`：Codex / WSL 路径与 Node 说明
- `docs/guides/guide-remote-ssh.md`：Remote SSH 用户流程、Codespaces 单会话 transport 与共享主机边界
- `docs/guides/telegram-approval.md` / `docs/guides/feishu-lark-remote-approval.md`：远程审批设置与失败回退语义
- `docs/guides/roam-fence.md`：自由漫游与可选围栏

## Runtime Summary

- HTTP hook / plugin 主路径：`src/server.js` → `src/server-route-state.js` → `src/agent-runtime-main.js` → `src/state.js` → IPC；本地 JSONL monitor 直接进入 `agent-runtime-main`，不经过 HTTP server
- 权限主路径：`src/server-route-permission.js` → `src/permission.js`；本地 bubble、显式 permission automation 与可选 Telegram / 飞书 Lark 远程审批都可能产生真实决定
- 桌宠的渲染/输入双窗口由 `src/pet-window-runtime.js` 统一创建和定位；浮层排序与 topmost 行为在 `src/floating-window-runtime.js` / `src/topmost-runtime.js`
- `src/state.js` 生成的 session snapshot 是 Dashboard、HUD/Orbit 与可选通知/presence/mobile consumer 的共享合约，改字段必须检查所有消费者
- `src/integration-sync.js` 为已安装且启用的 agent 异步同步 hooks / plugins / extensions；Codex official hooks 为 primary，JSONL 轮询保留为 fallback
- Claude hook 恢复由 `src/claude-settings-watcher.js` 的目录 watcher + 低频只读巡检共同负责；repair 统一经过 `src/claude-hook-operations.js` 队列并复验，连续失败转 `manual-fix-required`。完整 gate、阈值与 source-missing 语义见 `docs/project/agent-runtime-architecture.md`
- `src/agent-gate.js` 控制各 agent 的安装意图、启用状态、权限气泡开关和 wait-for-input notification 子开关
- 设置系统主链路是 `src/prefs.js` → `src/settings-controller.js`（唯一写入者）→ `src/settings-store.js`；`settings-actions*` 负责校验和 pre-commit gates，`settings-effect-router.js` 负责 post-commit runtime effects 与广播
- 启动时还会尝试自动安装 VS Code / Cursor terminal-focus extension，并初始化 updater
- Remote SSH 通过 effective transport inspection 区分 ordinary parallel SSH 与 serialized transport；后者由 target-scoped coordinator 编排。远程部署只走 Settings，`scripts/remote-deploy.sh` 已 fail-fast 停用

## Core Files

更细的背景见 `docs/project/agent-runtime-architecture.md` 和 `docs/project/theme-state-ui.md`。

| File | Responsibility |
|------|------|
| `src/main.js` | Electron composition root：生命周期、上下文组装与各 runtime / IPC 注册器接线 |
| `src/server.js` + `src/server-route-state.js` + `src/server-route-permission.js` | HTTP 服务、端口发现、`/state` / `/permission` 路由 |
| `src/agent-runtime-main.js` + `src/integration-sync.js` | local monitor / official hook 仲裁、Codex turn fence、按 gate 的集成同步 |
| `src/state.js` | 状态机、多会话合并、优先级、自动回退、睡眠/DND |
| `src/renderer.js` | 动画切换、SVG 预加载、眼球追踪渲染 |
| `src/permission.js` + `src/permission-automation-policy.js` + `src/session-automation-coordinator.js` | 权限气泡、自动化策略、per-session 授权与决策回包；远程 client 由 `main.js` 注入 |
| `src/pet-window-runtime.js` + `src/floating-window-runtime.js` + `src/topmost-runtime.js` | 双窗口 owner、浮层重排、z-order / fullscreen / focusability |
| `src/update-bubble.js` | 更新气泡创建、测高、跟随桌宠定位，避让 HUD / permission stack |
| `src/dashboard.js` + `src/dashboard-renderer.js` | Sessions Dashboard 窗口、会话列表、别名编辑、终端跳转 |
| `src/session-hud.js` + `src/session-hud-renderer.js` | 桌宠旁轻量会话 HUD、折叠行、点击跳转 |
| `src/session-alias.js` | session alias key 规范化、TTL pruning、Kiro cwd scope |
| `src/theme-loader.js` + `src/theme-runtime.js` | stateless 主题加载/消毒与唯一 active-theme owner |
| `src/prefs.js` | 偏好 schema、load/save/migrate/validate，设置持久化入口 |
| `src/settings-actions*.js` + `src/settings-effect-router.js` | 设置 validators / commands / pre-commit gates 与 post-commit runtime effects |
| `src/settings-controller.js` | 设置系统唯一写入者 |
| `src/settings-store.js` | 不可变 snapshot store |
| `src/settings-ui-core.js` + `src/settings-renderer.js` + `src/settings-tab-*.js` | Settings shared UI state、侧栏/tab shell 与各页逻辑 |
| `src/menu.js` | 托盘 / 右键菜单，串起设置、Dashboard、mini mode、更新入口 |
| `src/mini.js` | 极简模式入场、滑动、peek、状态映射 |
| `src/tick.js` | 主循环、鼠标轮询、眼球和 idle/sleep 逻辑 |
| `src/drag-position.js` | 拖拽落点规范化与跨显示器钳制 |
| `src/visible-margins.js` | 可视角色边距与 edge pinning 规则 |
| `src/updater.js` | Git 模式 / `electron-updater` 双路径更新逻辑 |
| `src/focus.js` | 终端聚焦 |
| `src/hit-renderer.js` + `src/hit-geometry.js` | 输入窗口命中、拖拽、连击反应 |
| `src/remote-ssh-runtime.js` | Remote SSH tunnel/ingress 状态机、ordinary health probe、serialized readiness 与重连 |
| `src/remote-ssh-transport.js` + `src/remote-ssh-transport-coordinator.js` | effective transport inspection、pre-spawn admission、target ownership、drain barrier 与 quarantine |
| `src/remote-ssh-deploy.js` | Deploy / Repair、身份事务、lease/fencing、wrapper、cleanup 与远端 Codex monitor mutation |
| `src/remote-ssh-identity.js` + `src/remote-ssh-layout.js` + `src/remote-ssh-ingress.js` | 身份/布局真相与 profile 专属、nonce 校验的本地 ingress |
| `src/remote-ssh-node.js` + `src/remote-ssh-shell-detect.js` + `src/remote-ssh-local-config.js` | 远端 Node/ shell 探测与本机 SSH config 入口 |
| `src/remote-ssh-profile.js` | Remote SSH profile schema、校验、默认值和持久化规范化 |
| `src/remote-ssh-ipc.js` | Remote SSH runtime / deploy / monitor orchestration、intent policy、IPC 状态与进度广播 |
| `src/remote-ssh-quote.js` | Remote SSH 终端命令与跨平台 shell quoting helper |
| `agents/registry.js` | agent 注册表 |
| `agents/codex-log-monitor.js` | Codex JSONL fallback 轮询 |
| `agents/gemini-log-monitor.js` | legacy Gemini session JSON 轮询器；当前 Gemini hook-only 路径不启动 |
| `hooks/dsh-install.js` | DeepSeek Harness immutable managed bridge generation、ownership verify、安装 / 修复 / 卸载事务 |
| `hooks/clawd-hook.js` + `hooks/copilot-hook.js` | Claude Code / Copilot CLI 状态上报脚本 |
| `hooks/install.js` | Claude hook 注册 / 卸载 |
| `hooks/auto-start.js` | Claude `SessionStart` 自动拉起 Clawd 的 hook |
| `hooks/codex-hook.js` / `hooks/codex-install.js` | Codex official hooks 状态与权限审批、安装 / 卸载 |
| `hooks/cursor-install.js` / `gemini-install.js` / `antigravity-install.js` / `kiro-install.js` / `kimi-install.js` / `qwen-code-install.js` / `codewhale-install.js` / `codebuddy-install.js` / `workbuddy-install.js` / `opencode-install.js` / `pi-install.js` / `openclaw-install.js` / `hermes-install.js` / `qoder-install.js` / `qoderwork-install.js` / `reasonix-install.js` | 各 agent 集成安装逻辑 |
| `hooks/workbuddy-hook.js` | WorkBuddy state + Notification command hook；无 session_id 时返回合法 stdout 后丢弃事件 |
| `hooks/zcode-hook.js` / `hooks/zcode-install.js` | ZCode 状态 + 阻塞式 PermissionRequest hooks（`hookSpecificOutput` 决定 / `{}` 无决定）、`hooks.events.*` 按事件超时增量注册与 Claude-imported Clawd hook 清理 |
| `hooks/qoder-hook.js` | Qoder state-only 状态上报脚本（Phase 1，stdout 恒为 `{}`） |
| `hooks/codex-remote-monitor.js` | 远程 Codex JSONL 轮询并通过 SSH 隧道回传（含 token_count 订阅配额的 metadata_only 上报） |
| `hooks/claude-statusline.js` / `hooks/antigravity-statusline.js` | 各 CLI statusline 适配器：渲染状态行 + 把订阅配额（rate_limits）以 metadata_only POST 上报；Claude 版支持远程部署（`CLAWD_REMOTE=1` 前缀）与 `--chain` 串联模式（原 statusLine 对象保存在 `~/.claude/hooks/clawd-statusline-chain.json`，卸载时恢复） |
| `extensions/vscode/extension.js` | VS Code / Cursor 终端 tab 聚焦辅助扩展 |

## Constraints

- `agents/registry.js` 的 capabilities 是权限、subagent、session-end 等路由/gate 的权威来源；不得另写名单代替 capability 判定。但 permission automation eligibility 由更窄的 `isKnownPermissionAgent()` 显式判定（`KNOWN_PERMISSION_AGENTS` + explicit opencode-family membership），不得从 `permissionApproval` 自动派生或合并回 registry capabilities
- Claude Code / CodeBuddy 的阻塞式权限审批走 `POST /permission` HTTP hook；普通状态事件走 command hook
- permission automation（off / auto-tools / unattended）和 per-session grant 会在 bubble 渲染前产生真实 allow/answer。agent/family eligibility 是显式白名单；工具分类则因 mode/adapter 而异：auto-tools 对 Claude/Qwen 的未知 built-in fail closed，但其他已知 adapter 不都使用逐工具白名单，unattended 还会有意自动放行可作 Allow/Deny 的未知请求。新增 agent、工具或交互类型必须审查 policy + tests，不能从 `permissionApproval` 推导资格或笼统假设“未知请求都会 defer”
- Telegram / 飞书 Lark 与本地 bubble 是并行决策通道。远程通道超时、断连、未配置或发送失败不得产生远程决定，更不得转成 deny；有本地 bubble 时请求继续 pending，只有 remote-only 且所有可用 client 都无决定时，整体请求才 no-decision 并回到 agent 原生流程
- WorkBuddy 通过 `~/.workbuddy/settings.json` 的 Claude Code 兼容 command hooks 做 **state + Notification only** 集成：不注册 `/permission`，审批始终留在 WorkBuddy 原生沙箱与 GUI；无 `session_id` 的事件返回合法 stdout 后直接丢弃。当前只支持 macOS/Windows 桌面应用，没有已验证的 Linux/WSL CLI；不要把裸 `Electron` 当 WorkBuddy 进程。
- Codex 的阻塞式权限审批走 official `PermissionRequest` command hook：hook 脚本长连接 `POST /permission`，只允许 stdout 返回 sanitized `behavior/message`，`updatedInput` / `updatedPermissions` / `interrupt` 必须 omit
- hook 脚本只允许依赖 Node 内置模块，以及同目录 `hooks/` 下、且登记在 `src/remote-ssh-deploy.js` 的 `HOOK_FILES` 部署清单中的纯 Node helper（如 `server-config.js` / `shared-process.js` / `json-utils.js` / `codex-originator.js` / `codex-subagent-fields.js` / `context-usage.js` / `state-payload-size.js` / `quota-bucket.js` / `claude-rate-limits.js` / `codex-rate-limits.js` / `antigravity-context-usage.js`）；manifest-consistency 测试强制检查依赖闭包，新增 helper 必须登记
- CJS hook 脚本需要稳定终端 PID 时，必须复用 `hooks/shared-process.js` 的 `createPidResolver()` 及其 lifecycle context；不要复制进程树 walk 或用 `process.ppid` 简化。`getStablePid()` 只是 opencode-family plugin 的内部 resolver
- opencode 权限不走 `permission.ask` hook，而是 event hook + reverse bridge
- Pi 通过 `~/.pi/agent/extensions/clawd-on-desk` 的 global extension 推送状态；Clawd 对 Pi 是 **state-only**，不接管权限、不弹权限气泡，也不把 Pi 的默认 YOLO 流程改成手动确认
- DeepSeek Harness 首发是 **web profile / Windows-first experimental / plugin-only**；packaged-app source loading smoke 已完成，API-backed session/approval smoke 未完成前不得写成 Windows-verified。Clawd-managed in-process plugin 只监听公开 `session/created`、`session/event`、`session/disposed` 与 blocking `approval/request`。状态按 session FIFO 上报并携带上游 seq；Clawd 不读取 `$DSH_HOME/storages` projection。普通审批进入独立 DSH `/permission` adapter，只支持人工 Allow Once / Deny；204 / 断连 / DND / disabled 都由 plugin `next()` 交还 DSH 原生 web answerer。`ask_user_question` 始终留在 DSH 原生 provider；DSH 不进入 `KNOWN_PERMISSION_AGENTS`，auto-tools / unattended / per-session grant 全部 DEFER。安装器通过官方 `dsh plugin --profile web add/remove` 管理 immutable marker-owned generation，foreign 同名包 fail closed；当前冻结支持 npm 发布物 `@deepseek-ai/dsh@0.1.0-rc.6`（integrity `sha512-brpZfED7ieRa2PQ5tUxMhHrM1pb2CmKFVM/f6yMULBDMicahk+Z2OsHgTwTDnoiZm23Ftu9rQz0NN4pflaoJcg==`），`47f9438` 仅是源码调查基线，不代表 rc.6 的 tag/commit 映射。
- DSH 每个 canonical `DSH_HOME` 的 mutation lock 只有在 owner/schema/token/PID/timestamp/owner-recorded operation timeout 合法、超过该 owner timeout 两倍、且 OS PID probe 明确为 `ESRCH` 时才允许 atomic-rename takeover；live、`EPERM`、unknown、corrupt/foreign owner 一律拒绝并返回精确 lock path。canonical lock 的 owner write/release 禁止 recursive cleanup。无全局 CLI 时生成的手动 npx generation 必须先在同一锁内写 owned reference，手动 add/remove 命令必须显式 pin shell-quoted canonical `DSH_HOME`；malformed/foreign/concurrently replaced reference 一律 fail closed 并保留 generation
- OpenClaw 通过 `~/.openclaw/openclaw.json` plugin 路径做 state-only 集成；Phase 1 不做 permission bubble / terminal focus，主要支持本地 `openclaw tui --local`
- Antigravity CLI (agy) 通过 `~/.gemini/config/hooks.json` 做 **state-only** hook 集成（PreInvocation / PostToolUse / PostInvocation / Stop），**不注册 PreToolUse**。agy LLM 会主动调内置 `ask_permission` 工具，触发 agy 自己的 5 选项 native menu（含 "Persist to settings.json" 持久白名单），Clawd 不插手权限决策也不双层确认。`agents/antigravity-cli.js` `capabilities.permissionApproval` / `interactiveBubble` 均为 false。
- Qwen Code 通过 `~/.qwen/settings.json` 做 hook-only 集成（SessionStart / SessionEnd / UserPromptSubmit / PreToolUse / PostToolUse / Stop / Notification / PermissionRequest），支持状态与阻塞式 `PermissionRequest` 权限气泡；`disableAllHooks: true` 时注册条目不会触发。
- QwenWork (千问办公) 通过 `~/.QwenWorkCN/settings.json` 做 **hook-only / state-only** 集成（agent id `qwenwork`；SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / PostToolUseFailure / Stop / Notification / PermissionRequest / PermissionDenied / SessionEnd）。`PermissionRequest` / `PermissionDenied` 只作为观察映射成 `working`（每任务 40+ 次，映射成 notification 会刷屏），hook stdout 恒为 `{}`：Clawd 不产生 allow/deny，不注册 `/permission`，也不进入 permission automation eligibility，唯一决策者是 QwenWork 原生权限流程；`agents/qwenwork.js` 的 `capabilities.permissionApproval` / `interactiveBubble` 均为 false。Windows command 必须保持 `windowsWrapper:"portable"`（QwenWork 经 POSIX shell 执行 command hook），PowerShell `-EncodedCommand` **只**用于识别并原地迁移旧条目，不是当前写入形态。marker 只认 `qwenwork-hook.js`，不得仅凭 `name:"clawd"` 删除用户 hook；混合 entry 中第三方 hook 原样保留。session id 命名空间是 `qwenwork:<raw>`；`~/.QwenWorkCN/workspace/<id>` 这类内部工作区 cwd 不做 basename 回退，避免 HUD/Dashboard 显示内部 ID。当前真实支持平台只有 macOS / Windows 桌面端（官方下载页 https://qwenwork.cn/download 只提供 macOS 14+ / Windows 10+ / HarmonyOS 6.1+，没有 Linux 客户端），因此 `processNames.linux`、resolver linux agent name 均为空，也不进 `src/wsl-deploy.js` 的 WSL Pair 映射。桌面主进程长驻、不代表 active turn，`startupRecoveryProcessNames` 全空、无 startup recovery。安装/卸载走 Settings → Agents，或 `npm run install:qwenwork-hooks` / `npm run uninstall:qwenwork-hooks`；卸载必须同时在 `hooks/cleanup-integrations.js` 的 `MANAGED_AGENT_IDS` / `AGENT_CLEANERS` / `byAgent` 里有条目，否则 About cleanup 只会改 prefs、hook 留在磁盘上
- ZCode 通过 `~/.zcode/cli/config.json` 的 `hooks.events.*` 集成全部 7 个支持事件（SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / PostToolUseFailure / Stop / PermissionRequest，无 SessionEnd / Notification）。PermissionRequest 为阻塞式权限审批：hook 长连接 `POST /permission`（HTTP 等待 590s，installer 注册 `timeoutMs: 600000`），有决定时 stdout 返回最小合法 `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`（deny 可带 `message`），无决定 / 超时 / 断连 / 任何错误输出 `{}` 并 exit 0，ZCode 回退原生权限流程；`interrupt` / `updatedInput` / `updatedPermissions` / `permissionUpdates` 必须 omit（最小输出 union 按 ZCode 3.5.x 严格 schema 约束；macOS ZCode 3.8.1 已完成真实 hook / 气泡 Allow/Deny 往返，3.5.x PermissionRequest 真机往返未覆盖）。超时单位陷阱：ZCode `timeout` 是秒、`timeoutMs` 才是毫秒，且超时按事件区分（PermissionRequest 600000、state 事件 8000）。Phase 2 只允许人工审批：ZCode 不进入 `KNOWN_PERMISSION_AGENTS`，global / per-session permission automation 在工具面与会话身份审计完成前全部 defer。prefs v14→v15 迁移把 Phase 1 持久化的 `zcode.permissionsEnabled:false` 翻 true（当时开关从未渲染、无用户意图）。配置必须有 `hooks.enabled=true` 才会执行；安装器只在该字段缺失时补 true，显式 `hooks.enabled=false` 或 Clawd 单项 hook 的 `enabled=false` 必须保留，Doctor warning 且不提供会覆盖用户选择的 Fix。ZCode 导入 Claude 配置后，只清理 `.zcode` 中明确引用 `clawd-hook.js` 的 Clawd-owned 条目，绝不改 `~/.claude/settings.json`。安全边界（复核后新增）：`/state` 生命周期 sweep 对 zcode（及 qwen/DSH 等 native-fallback adapter）只允许 no-decision，绝不伪 deny；hook 侧 `tool_input` 预算内原样发送、任何截断（长 Bash 尾部 `rm -rf` 场景）或序列化超 512KiB 一律 fail-closed 输出 `{}` 交还原生 UI；无 allow/answer/plan capability 的 interaction（如 ZCode 真实的 ExitPlanMode / AskUserQuestion）本地气泡与远程卡片都不提供决定入口、直接 204；全局气泡关闭只关本地窗口，Telegram/飞书 remote-only 审批仍可用（per-agent gate 关闭才是全退出）；installer 遇到 foreign `PermissionRequest` hook 时不注册自己的 blocking hook，若 foreign hook 后出现则移除自己的 managed hook（ZCode 同事件 hook 串行执行、后写覆盖，Clawd allow 会盖掉用户 hook 的 deny），Doctor 报 `permission-conflict` 且不给 Fix；六个 Phase 1 managed hook 全部显式 disabled 时新 PermissionRequest 继承 `enabled:false`；服务端 pre-parse 超限一律断连回退，不伪造 deny
- Qoder 通过 `~/.qoder/settings.json` 做 **state-only** hook 集成。Clawd 只把 `PermissionRequest` / `PermissionDenied` 当 notification 观察，**不替 Qoder 做权限决策**，hook stdout 恒为 `{}`，由 Qoder 原生权限流程接管；Windows command 必须保持 `windowsWrapper:"portable"`，旧 PowerShell encoded 条目只做 Clawd-owned 原地迁移。session id 命名空间是 `qoder:<raw>`；启动恢复只认 CLI 进程 `qodercli` / `qoder-cli`，不认 IDE 进程 `qoder.exe`
- TraeCode (Trae CN) 通过 `~/.trae-cn/hooks.json` 做 **hook-only / state-only** 集成。Windows command 必须保持 `windowsWrapper:"encoded"`：Trae 的 Windows Sandbox 会把 hook 命令作为 `trae-sandbox.exe --command-line` 的单个原生参数再次转发，普通引号或 `portable` 形态会在含空格路径处拆分；外层必须保持无引号的 PowerShell `-EncodedCommand`，POSIX 则继续使用普通 quoted command。该约束不适用于经 POSIX shell 执行 Windows hook 的 agent（如 Qoder / QwenWork）。
- HTTP 服务端口范围固定为 `127.0.0.1:23333-23337`；运行时端口写入 `~/.clawd/runtime.json`
- 自定义 HTTP Agent 的 sender 必须读取 `~/.clawd/runtime.json`，不能把 23333 写死；注册不等于已连接。custom v1 只支持 `/state`，不支持 `/permission`
- CodeBuddy PermissionRequest hook 的所有权只认本机 managed URL 或 marker `clawd-on-desk.permission.v1`；纯 `name:"clawd"` 不能触发改写/删除。裸 CLI 和 WSL 默认 preserve，Settings/startup/repair 必须显式传 local/custom permission target
- Remote SSH 的远端 Node 探测要求 Node >= 14；Node discovery/version validation 只在 `src/remote-ssh-node.js`，ordinary tunnel health 与 serialized readiness 在 `src/remote-ssh-runtime.js`，不得互相复制或从已停用脚本另起实现
- 注册 Claude Code hook 必须 marker-scoped merge：只可更新/删除含 `clawd-hook.js` / `auto-start.js` marker 的 Clawd-owned entry，不得整体覆盖数组或改动无 marker 的用户 entry
- 注册 Claude Code statusLine 时只接管空槽或自己的槽（marker `claude-statusline.js`）；远程部署可用 profile 的 `chainStatusline` opt-in 串联既有第三方 statusline（`--chain-existing`），显式关闭时必须从 sidecar 恢复原 statusLine。订阅配额通过 `metadata_only` POST 进入 session-independent `updateAccountQuota` per-source store；不要把 quota 塞进 `updateSession` opts，也不要以 session 存活作为摄入前提
- Copilot CLI hooks 走按需自动同步：`hooks/copilot-install.js` 在本地启动仅当 Copilot CLI 已安装且已启用时调用；远端由 Settings Remote SSH deploy controller 调用。路径解析尊重 `COPILOT_HOME` env（trimmed 非空才生效，否则 fallback 到 `~/.copilot`）；`hooks/copilot-hook.js` 的 session-state resolver 同样走 env
- Remote SSH 的 effective transport 由 `ssh -G` 只读检查决定：ordinary SSH 在没有 retained serialized occupancy 时保持 `context:null` 的 parallel 路径；serialized transport 以有效 target key（不是 profile id）互斥。所有 serialized managed SSH/SCP child 必须持 coordinator 发出的有效 connection/operation context，并通过其 pre-spawn gateway 启动；用户交互终端只有命中 serialized/retained occupancy 时才要求 coordinator 判定 target 完全 idle
- serialized persistent tunnel 使用同一条 SSH 内嵌 readiness；暂停通过 stdin EOF 请求自然退出并等待 `close`。强杀或带 signal 的 outer `ssh.exe` close 不能证明 nested ProxyCommand 已 drain；timeout/未验证 drain 必须 quarantine，期间禁止新 child、mutation、resume 或 interactive terminal
- mutation 在 deploy-lock acquire-attempted / lock-owned 后遇到 exit 255、EOF/reset、signal 或其他 unknown result 时不得自动 replay、retry、release lock 或恢复连接；必须保留 primary error 并传播 recovery state，必要时要求 `manual_lock_inspection_required`
- Remote SSH secure hook 必须同时携带 `CLAWD_REMOTE=1` 与 `CLAWD_SSH_REMOTE=1`，只读 layout identity 并 pin 精确端口；identity 缺失/损坏/不可读必须 fail closed，禁止回退端口扫描
- Remote SSH deploy-lock acquisition 必须原子化；成功 acquire 后的每个 live mutation 都要在同一远端命令内 fencing 校验，cleanup 还必须锁内重读 installId/profileId/runtimeKey/layoutVersion 所有权。无身份、冲突、ownerless/corrupt lock 均不得自动接管
- 默认 `account-default` 只支持不同 Unix 账号；同 Unix 账号冲突必须阻止。`profile-isolated` 在真实 SSH/CLI 矩阵完成前由 `CLAWD_ENABLE_EXPERIMENTAL_REMOTE_ISOLATION=1` 发布门隐藏；它只隔离用户级 CLI config/session/runtime 与 Clawd 路由，不代表完整 HOME 或同 UID 安全隔离，project 配置/部分 cache/macOS Claude Keychain auth 仍可能共享
- 禁用 agent 不应卸载 hooks / plugins / extensions：只停止对应 monitor、清理 session / bubble、让 HTTP hook 入口快速 fallback；重新启用未安装 agent 不触发本机 integration sync。卸载集成必须走 Settings Agent 页的 Uninstall / 对应 uninstall 命令，并同时清掉 `integrationInstalled`
- Kiro 的 `sessionId="default"` 会复用；session alias key 必须按 cwd scope 区分，同时保留旧 `local|kiro-cli|default` 只读 fallback
- Windows NSIS release 必须产出明确架构的 x64 / ARM64 安装包：`win.artifactName` 保留 `${arch}`，`nsis.buildUniversalInstaller` 保持 `false`
- 每个 release target 只能保留一个匹配目标架构的 Koffi `koffi.node`；`afterPack` 只允许剪裁 `app.asar.unpacked` 的物理文件，禁止重写 `app.asar`，并必须通过完整 native inventory audit（唯一常设例外是 electron-builder 管理的 Windows ia32 `resources/elevate.exe`）
- 资源路径统一用 `path.join(__dirname, ...)`
- 需要编辑发布素材时，先复制到 `assets/source/` 再改，不要直接改工作素材来源不明的文件
- `assets/source/cloudling-pointer-bridge/` 是 Cloudling 指针桥素材的保留源文件目录；运行时逻辑已内联进主题 SVG，不要把这个 source 目录当临时文件清理
- 主题状态、sleep/DND、mini mode、状态映射的细节在 `docs/project/theme-state-ui.md`
- Settings 体系里，store 是唯一真相，controller 是唯一写入者；不要绕开 `settings-controller.js`

## Testing

- 自动化测试使用 Node 内置 test runner：`npm test`
- `test/*.test.js` 覆盖核心 unit/contract、installer、route、UI/runtime 与 Remote SSH transport/coordinator/identity；部分 fixture 会启动 Node、shell 或 Git Bash 子进程，缺少依赖时可能 skip，不能把全套结果概括成纯逻辑或等价真机验证
- Remote SSH 真机矩阵与记录在 `scripts/manual/README.md`；Windows OpenSSH + Codespaces stdio 边界及 ordinary-host V15 release gate 不能从 unit tests 互相推断，无法执行时必须明确记录 pending / residual risk
- Windows Terminal 真机、GUI smoke 与清理必须假定多个 tab/window 共享进程：不得按 PID/进程名 `taskkill`、`Stop-Process` 或宽泛终止 WindowsTerminal、Codex、`cmd.exe`、`ssh.exe`、OpenConsole、conhost。测试终端只能在明确 test-owned session 内 `exit`；无法证明 ownership 就保留现场并请用户手动关闭
- 当前开发环境是 Windows-first；macOS 特定路径无法在这里手动 QA，改到 mac 逻辑时要用 code-review-first 的方式说明行为变化和残余风险
- 涉及 Claude Code hook payload 的改动（尤其 `/permission`、`permission_suggestions`、`updatedPermissions`、elicitation 输入）至少用一次真实 Claude Code 验证；`curl` 自编 payload 不够
- 透明窗口、托盘、真实拖拽、跨平台前台聚焦等 Electron 行为仍以手动验证为主

## High-Risk Gotchas

- `src/pet-window-runtime.js` 的 `hitWin` 必须在 Windows/macOS 保持 focusable（当前为 `focusable: !isLinux`），不要把 Windows 拖拽修复改回去
- `miniTransitioning` 期间，所有窗口定位路径都必须先检查保护标志，否则 `setPosition()` 可能并发崩
- DND 会屏蔽 hook 事件并压住 bubble，但**不应替用户做权限决定**：opencode 走 silent drop 回到 TUI 提示，Claude Code / CodeBuddy 走断连回到内置聊天/终端确认，Codex official hook 走 no-decision `{}` 回到原生审批提示；Pi 是 state-only，不进入权限审批链路
- 隐藏桌宠（petHidden）≠ 免打扰：隐藏只收起宠物/HUD/update bubble/当时 pending 的权限气泡，**隐藏期间新到的权限请求仍照常弹气泡，这是有意设计、不要当 bug 修**；要静默权限气泡走 DND（见上条）。详见 `docs/project/theme-state-ui.md` State Machine 节
- Session HUD 显示所有非 headless、非 sleeping 的 live session，包括 badge=Done 的 idle session；不要再按 `state !== "idle"` 过滤，否则完成后的 Claude Code 会话会从 HUD 消失
- update bubble 跟随桌宠时要同时避让 Session HUD 和 permission stack；permission bubble 增删、测高、deny-and-focus 后都要触发 update bubble 重排
- `mini-working` 是可选主题能力，缺失时必须优雅降级
- `contextMenuOwner` 必须保留 `parent: win`；配合 `closable:false` 才不会把退出流程卡死
- Windows 前台窗口锁与 process-query 路径依赖 ALT trick + `koffi` FFI；同一 Koffi registry 的 named structs/bindings 必须复用既有缓存，不要重复注册，相关回归通常不是单点逻辑 bug
- `~/.claude/settings.json` 的 hook 恢复 watcher 必须盯目录而不是文件；原子替换会让文件级 watch 在 Windows 上静默失效
- Claude watcher 必须同时受 `manageClaudeHooksAutomatically`、`claude-code.integrationInstalled` 和 `claude-code.enabled` 保护；不要让未安装或禁用 Claude Code 后的 watcher 重新写回 hooks
- 所有进程内对 `~/.claude/settings.json` 的 mutation（启动 reconcile、watcher 自动恢复、周期健康自愈、Settings Install/Enable、Doctor Fix、auto-start 开关、卸载、About 清理）必须经过 `src/claude-hook-operations.js` 的 server-owned 队列；不要绕开队列直接 `require("../hooks/install.js")` 写文件，否则会与其他来源的写入竞态
- 周期健康巡检（`src/claude-settings-watcher.js`）只读判断用 `src/claude-hook-health.js`；同一 repair signature 连续 3 次修复+复验失败后必须停在 `manual-fix-required`，不再自动 mutation，只保留 5 分钟只读复查；suspicious-shrink 通知同一持续问题只弹一次，不要每轮重复
- opencode 的 `permission.ask` hook 目前不可用，权限只能走 event hook + bridge
- Codex CLI official hooks 已接入；JSONL 轮询仍是 fallback，用于 hook 不可用、hook 未覆盖事件（如 WebSearch / compaction / abort）和历史兼容。本机 `SessionStart` 冷启动还受 `autoStartWithCodex` 控制：新安装默认关闭，v17 升级保持原先的开启行为，损坏/非权威 prefs 在当前进程内 fail closed，WSL / WSL interop / Remote SSH 永不走冷启动。Windows `commandWindows` 由 PowerShell 解析：legacy 直接命令必须用 `& "node" ...` call operator；本机 stable 入口必须保持“固定内联 PowerShell dispatcher → UTF-8/Base64 `codex-hook.js.windows.run` 数据 sidecar → `& $node $target`”形态（JSON manifest 只供 Doctor），不得改回裸 `"node" "hook.js"`（会 exit 1）、二次 `powershell.exe -File` 或无 BOM `.ps1`
- Kiro 没有 global hooks，只能注入到 `~/.kiro/agents/*.json`
- `src/renderer.js` 里给 `<img>` SVG 追加的 `?_t=` cache-bust query 不能删；Chromium 会复用同 URL SVG 的动画时间线，一次性动画会停在末帧

## Do Not Revisit

Language 子菜单底部截断是 Electron 透明窗口 + Windows DWM 的底层兼容问题。不要再尝试通过切换 `alwaysOnTop`、透明窗策略或 JS 菜单布局修它。
