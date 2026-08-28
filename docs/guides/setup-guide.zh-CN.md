# 配置指南

[返回 README](../../README.zh-CN.md)

## Agent 配置说明

全新安装默认只安装并启用 Claude Code 和 Codex。其他本机 agent 需要先到 **Settings → Agents** 点该 agent 的 **Install / 安装**；安装且启用后，Clawd 才会在启动时继续同步对应 hook / plugin / extension。单独关闭 agent 只会停止事件入口，不会卸载文件；**Uninstall / 卸载** 只删除 Clawd 管理的 hook / plugin / extension 条目，并同时禁用该 agent。

**自定义 HTTP Agent** — Settings 可以注册其他本机可执行文件并分配稳定的 `custom-...` ID，但“注册”不会自动安装 hook，也不会让普通应用自动上报事件。自定义 Agent v1 仅支持状态：应用或你编写的 adapter 必须主动向 Clawd 运行时的 `/state` 地址 POST 生命周期事件；权限决定仍留在应用自己的界面中。动态端口发现、请求体、三平台示例以及禁用/移除语义见 [custom-agent-http.md](custom-agent-http.md)。

**Claude Code** — 开箱即用。Clawd 启动时会自动注册 hooks。只有在确认 Claude Code 版本兼容时才会注册 versioned hooks（`PreCompact`、`PostCompact`、`StopFailure`）；如果版本无法确认，会自动回退到核心 hooks，并清理旧的不兼容条目。除了监听 `~/.claude/settings.json` 所在目录的变化外，Clawd 还会每 5 分钟做一次只读健康巡检——即使 hook 脚本是在系统 Temp 等其他目录被清理、且 `settings.json` 本身完全没变化，也能发现并自动修复。同一问题连续自动修复 3 次仍失败会停止自动重试，Doctor 会提示手动 Fix；如果是当前安装包自身的 hook 脚本缺失（例如安装损坏），Clawd 不会盲目重写配置，会提示重新安装或重新解压。

### Claude Code 使用信息：官方状态栏，不抓取网页

本机 Claude 使用信息采集**默认关闭**。可在 **Settings → General → 额度环 → 采集本机 Claude 使用信息** 中显式开启；开启后，Clawd 会把自己的可见 `statusLine.command` 添加到 `~/.claude/settings.json`。

这里使用的是 Claude Code 官方扩展机制，不是私有或逆向接口。Claude Code 的[官方 statusline 文档](https://code.claude.com/docs/en/statusline)会向状态栏命令提供 `context_window.current_usage`、`context_window.context_window_size`，以及可用时的 `rate_limits`；命令在本机执行，不消耗额外 API token。

数据路径如下：

1. 一次正常 Claude Code 交互后，Claude Code 自己把官方 statusline JSON 通过 stdin 交给已配置命令。
2. Clawd 读取输入 token 用量与上报的上下文窗口大小，并在 Claude Code 提供时读取订阅额度；终端中仍会显示一条简短、可见的状态栏。
3. Clawd 只把规范化后的上下文快照和可用额度发送到自身的 `127.0.0.1:23333-23337` loopback 服务。显式部署的 SSH profile 则通过用户配置的反向 SSH 隧道回到本机 Clawd。

此功能**不会**额外请求 Anthropic、抓取 `claude.ai`、调用 `/usage`，也不会读取 Claude 的认证 cookie/token。转发内容只有规范化的 token 数、窗口大小，以及可用额度的百分比/重置时间，不包含 prompt 或 transcript 正文。即使 context window 可用，`rate_limits` 仍可能缺失。

#### 模型范围的 Claude 额度（例如 Fable）

除通用的 5 小时和每周额度外，Claude 还可能设置模型范围的独立周额度。例如，Anthropic 说明符合条件的 Max 与 premium seat 订阅可在账号每周额度的一定比例内使用 Fable，并可在 Claude 自己的 Usage 设置中同时查看总体与 Fable 用量。它在产品语义上类似一个单独识别的模型额度，但目前并不通过 Clawd 现用的同一集成面提供。

截至 2026 年 8 月 15 日，Claude Code 官方 statusline 合约只公开 `rate_limits.five_hour` 与 `rate_limits.seven_day`。本次调查观察到 Claude Code 的内部本地缓存会在 `cachedUsageUtilization.utilization.limits` 下以 `weekly_scoped` 条目表示 Fable，官方客户端自身也会通过内部 `/api/oauth/usage` 请求取得更完整的用量数据；但该缓存 schema 与接口都没有被文档化为稳定的第三方集成合约。

因此 Clawd 有意**不**读取 Claude Code 的内部用量缓存、不读取或刷新 Claude OAuth 凭据，也不调用未公开的 usage endpoint。结果是：Fable / 模型范围额度可能出现在 Claude 自己的 Usage 设置中，却不出现在 Clawd。这是上游可见性边界，不是 Clawd 漏解析了官方 `rate_limits` 对象；在没有受支持的数据源提供额外 bucket 时，单独增加一个展示 provider 也无法解决。

技术上可行不等同于平台支持。只有当 Anthropic 通过官方 statusline payload 暴露模型范围额度、公开只读的第三方 usage 接口，或以其他方式明确支持该集成时，Clawd 才会重新评估接入。在此之前，Clawd 不显示 Fable 额度属于预期行为。参见 Anthropic 的 [Fable 套餐说明](https://support.claude.com/en/articles/15424964-claude-fable-5-on-your-plan)与 Claude Code [官方 statusline schema](https://code.claude.com/docs/en/statusline)。

Claude Code 只有一个用户级 statusline 槽位，因此 Clawd 绝不会静默覆盖已有的自定义状态栏：槽位被占用时，启用操作会显式失败并保持原命令不变；关闭采集只移除带 Clawd ownership marker 的命令，并立即清除缓存的本机 Claude 额度，同时保留 Remote SSH 额度和所有非 Claude provider。

没有 Clawd statusline 时，普通 Claude hooks 仍会从 transcript 上报输入 token 用量。Clawd 只对封闭列表里的标准 Claude ID 使用兼容性分母；模型为空、自定义或未知时只显示 used，不再猜成 200K。要让自定义 provider 的真实上限与 Claude Code `/context` 一致，需要开启此开关，让 Claude Code 自己上报的 `context_window_size` 持有分母，同时 transcript hooks 继续刷新 used。

普通本机修复命令 `npm run install:claude-hooks` 不会开启采集。显式调试命令 `npm run install:claude-hooks -- --statusline` 可以安装并显示 Clawd 状态栏，但 Settings 开关关闭时，应用仍会把其本机 context/quota POST 当作成功 no-op；下次本机启动 reconcile 也会移除这个 Clawd 管理的调试槽位。Remote SSH 部署是另一项显式操作；若远端已有自己的 statusline，请在 profile 中开启 **部署时串联远端已有的 statusline**，以便保留并在卸载时恢复原注册。

**Codex CLI** — 开箱即用。Clawd 会在检测到 Codex 时自动注册 official hooks 到 `~/.codex/hooks.json`，并在用户没有显式关闭 hooks 时启用 `[features].hooks = true`。Installer 会把已废弃的 `[features].codex_hooks` 迁移到 `hooks`，同时保留用户显式设置的 false。Official hooks 提供实时状态和真实 Allow/Deny 权限气泡。**Settings → Agents → Codex → 随 Codex 启动** 单独控制本机 Codex 的 `SessionStart` 能否在 Clawd 未运行时拉起桌宠；关闭它不会停用状态或审批接入，Clawd 已运行时仍然正常工作。全新安装默认关闭，升级用户则保留此前的开启行为；Remote SSH 与 WSL hook 永远不会冷启动桌面应用。`~/.codex/sessions/` JSONL 轮询只保留为状态 / metadata fallback，用于 hook 被禁用或 hook 未覆盖事件；审批不再从 JSONL 猜测。Codex 发出 `request_user_input` 时，Clawd 会从 transcript 中识别该调用，播放通知反应并显示问题/选项的只读预览。回答仍在 Codex 原生界面中完成，卡片不会注入选择；匹配的工具输出写入后会自动关闭。

**Copilot CLI** — 需要本机 Copilot CLI 追踪时，先到 **Settings → Agents** 安装。安装且启用后，Clawd 启动时会自动在 `<COPILOT_HOME 或 ~/.copilot>/hooks/hooks.json` 注册 hooks（marker-based 合并，你已有的 hook 条目和其他 `hooks/*.json` 文件原样保留）。SSH 远程部署走应用内 **Settings → 远程 SSH → 部署 / 修复 Hook** 自动配置。`hooks.json` 或 `settings.json` 顶层 `disableAllHooks: true` 时 doctor 会报 warning 并不挂 Fix 按钮。详见 [copilot-setup.zh-CN.md](copilot-setup.zh-CN.md)（含手动备选与 `COPILOT_HOME` 说明）。

**Gemini CLI** — hooks 配置在 `~/.gemini/settings.json`。需要本机 Gemini 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步 hooks。也可以手动执行 `npm run install:gemini-hooks`。

**Antigravity CLI (agy)** — hooks 配置在 `~/.gemini/config/hooks.json`。需要本机 agy 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步 hooks。也可以手动执行 `npm run install:antigravity-hooks`。Clawd 对 agy 是**仅状态同步**集成：桌宠会反映 working / idle / attention 状态，**但 Clawd 不显示任何权限气泡**。所有 Allow / Deny / Always-allow 决策都在 agy 自己的 5 选项终端菜单里完成 —— 想要永久规则就在 agy 菜单里选择标有「Persist to settings.json」的选项。Clawd-在前的方案 dogfood 后发现单次任务变 8-10 次确认，所以 PreToolUse hook 故意不注册。

**Cursor Agent** — hooks 配置在 `~/.cursor/hooks.json`。需要本机 Cursor Agent 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步 hooks。也可以手动执行 `npm run install:cursor-hooks`。

**CodeBuddy** — 使用与 Claude Code 兼容的 hooks，配置写入 `~/.codebuddy/settings.json`。需要本机 CodeBuddy 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步 hooks。PermissionRequest 条目使用版本化 marker `clawd-on-desk.permission.v1`；注册和卸载不会碰其他 HTTP hook，包括仅仅叫 `clawd` 的第三方条目。裸跑 `node hooks/codebuddy-install.js` 会保留已有、由该 marker 管理的自定义权限 URL；用 `--permission-url local` 可明确恢复本机 Clawd 地址，用 `--permission-url https://example/permission` 可明确设置自定义 HTTP(S) 地址。

**WorkBuddy** — 使用与 Claude Code 兼容的 hooks，当前 WorkBuddy AI 的配置写入 `~/.workbuddy-ai/settings.json`，旧版使用 `~/.workbuddy/settings.json`。需要本机 WorkBuddy 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步 hooks。也可以手动执行 `node hooks/workbuddy-install.js`。WorkBuddy 是 macOS/Windows 的 Electron 桌面应用，没有独立的 Linux/WSL CLI；状态类动效已在 macOS 上验证可用。集成为**仅状态 + 通知**：桌面版审批始终由 WorkBuddy 原生沙箱与 GUI 确认卡片处理，因此 Clawd 不会注册 `/permission` HTTP hook。权限请求只会以「等待确认」的 Notification 形式（带 `session_id`）传给 Clawd——铃铛/提醒提示可用（已在 Windows 实测），但同意/拒绝的决定始终留在 WorkBuddy 内。

**Kiro CLI** — 需要本机 Kiro 追踪时，先到 **Settings → Agents** 安装；如果你想在启动 Clawd 前先注册 hooks，也可执行 `npm run install:kiro-hooks`。Kiro 内置的 `kiro_default` 不是一个可编辑的 JSON agent，所以 Clawd 会维护一个自定义 `clawd` agent，并在集成安装后每次启动时先同步最新的 `kiro_default` 配置，再追加 hooks。需要 hooks 时，请用 `kiro-cli --agent clawd` 新开会话，或者在现有会话里执行 `/agent swap clawd`。目前在 macOS 与 Windows 上，状态类动效已验证可用；但涉及终端里 `t / y / n` 的原生权限确认，仍然只能在终端处理。

**Kimi Code** — Clawd 用同一个集成同时支持两代 Kimi。新版 Kimi Code（TypeScript CLI）的 hooks 在 `~/.kimi-code/config.toml`，旧版 Kimi CLI（Python，上游已停更）的在 `~/.kimi/config.toml`；哪个目录存在 Clawd 就装哪个（两个都在就都装）。需要本机 Kimi 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 会在启动时持续同步 hooks。也可以手动执行 `npm run install:kimi-hooks`。在 Clawd 中 Kimi 采用 hook-only 集成：状态和权限提示都来自 hook 事件，不依赖日志轮询。在新版 Kimi Code 上，权限气泡由 CLI 原生的 `PermissionRequest`/`PermissionResult` hook 事件驱动——气泡会显示正在等待批准的具体命令，你在终端里作出选择后气泡立即消失，无需任何配置。如果你用过 Kimi Code 内置的旧版迁移，Clawd 下一次同步会自动把迁移过来的 hook 条目升级为新格式（旧的 env 前缀命令写法在 Windows 上无法执行）。旧版 `~/.kimi` 安装的权限提示**默认启用 suspect 启发式**：现行 kimi-cli 版本的 `PreToolUse` 从不携带显式审批字段（1.37 与 1.49 实测），旧的 explicit-only 默认值意味着提示卡根本不会出现。安装器会把模式以 `--permission-mode=suspect` 参数的形式持久化到每条 hook 的 `command` 里；此前选择过的模式——包括 `explicit`——在重新同步时始终原样保留，绝不会被翻转（用已停用的 `CLAWD_KIMI_PERMISSION_MODE=…` env 前缀形式装过的配置会连值一起迁移成参数形式）。想退出默认：在运行安装命令前设置 `CLAWD_KIMI_PERMISSION_MODE=explicit`（持久化），或在运行 kimi-cli 时临时设置该环境变量——运行时环境变量的优先级永远高于持久化参数。需要了解的代价：suspect 启发式下，*已免审*的门控命令若运行超过约 0.8 秒，会短暂弹出一张误报提示卡（卡片几秒后自动关闭；宠物会保持通知姿势直到该命令跑完）。嫌烦可在 **Settings → Agents** 里整体关闭 Kimi 的权限提示。注意：自动同步会按预期行重写 `command` 字段，你对该字段的手工修改会在下次启动时被静默还原。

**Qwen Code** — hooks 配置在 `~/.qwen/settings.json`。需要本机 Qwen 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步 hooks。也可以手动执行 `npm run install:qwen-hooks`。Qwen Code 在 Clawd 中采用 hook-only 集成：状态更新和阻塞式 `PermissionRequest` 审批都来自 Qwen hook 事件。如果 Qwen settings 里有 `disableAllHooks: true`，Clawd 可以注册条目，但 Qwen 不会触发它们，直到用户移除该开关。

**ZCode** — config-file hooks 配置在 `~/.zcode/cli/config.json` 的 `hooks.events.*`。需要本机 ZCode 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 会持续同步全部 7 个支持事件——6 个状态事件加上阻塞式 `PermissionRequest` 审批 hook（由 Clawd 本地气泡或远程审批产生人工 allow/deny；Clawd 无决定时由 ZCode 自己的权限流程接管）。在完成 ZCode 工具面与会话身份审计前，全局和 per-session 权限自动化都会 defer。也可以手动执行 `npm run install:zcode-hooks`。安装后请新建一个 ZCode 会话，让它读取当前 hook 配置。ZCode 只有在 `hooks.enabled: true` 时才执行 config-file hooks：字段缺失时 Clawd 会补 true，但用户显式设置的全局 `hooks.enabled: false` 或单项 hook `enabled: false` 都会保留，Doctor 只提示，不提供会覆盖该选择的 Fix。如果 ZCode 曾导入 Claude 配置，Clawd 只会从 ZCode 配置里删除明确引用自身 `clawd-hook.js` 的旧条目，绝不修改 `~/.claude/settings.json`。

**CodeWhale** — lifecycle hooks 配置在 `~/.codewhale/config.toml`（`[[hooks.hooks]]` 条目）。需要本机 CodeWhale 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步 hooks。也可以手动执行 `npm run install:codewhale-hooks`。Phase 1 是 state-only：Clawd 只驱动生命周期、工具调用和模式切换动画，不弹权限气泡，也不追踪子代理。详见 [codewhale-setup.md](codewhale-setup.md)。

**Reasonix CLI** — hooks 配置在 `<Reasonix home>/settings.json`（macOS/Linux 为 `~/.reasonix/settings.json`，当前 Windows 版本为 `%APPDATA%\reasonix\settings.json`）。在 Windows 上，Clawd 也会跟随 Reasonix 的兼容回退读取旧的 `~/.reasonix/settings.json`；卸载时会从两处配置中分别删除 Clawd 管理的条目。需要本机 Reasonix 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步当前生效的 hooks。也可以手动执行 `npm run install:reasonix-hooks`。Phase 1 是 state-only：Clawd 只驱动生命周期、工具调用、通知、压缩和子代理结束动效，权限决策仍留在 Reasonix 自己的终端流程。

**opencode** — 使用 `~/.config/opencode/` 下当前生效的 plugin 配置：`config.json` → `opencode.json` → `opencode.jsonc`，后者优先。需要本机 opencode 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步 plugin。也可以手动执行 `node hooks/opencode-install.js`。

**MiMo Code** — 使用 `~/.config/mimocode/` 下当前生效的 plugin 配置：`config.json` → `mimocode.json` → 默认 `mimocode.jsonc`，后者优先。需要本机 MiMo Code 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步生效的 plugin entry。也可以手动执行 `npm run install:mimocode-plugin`。MiMo Code 与 opencode 使用同一套 plugin SDK 和 Allow / Always / Deny 权限行为；`task` 创建的子会话不参与可见的多会话动画聚合。

**Pi** — 使用全局 extension 目录 `~/.pi/agent/extensions/clawd-on-desk`。需要本机 Pi 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步 extension。也可以手动执行 `npm run install:pi-extension`。交互式 Pi 会话会向 Clawd 上报生命周期和工具活动，但 Pi 是 state-only：Clawd 不显示权限气泡、不调用 Pi 终端确认，并保留 Pi 默认 YOLO 执行行为。

**OpenClaw** — 使用 `~/.openclaw/openclaw.json` 里的 plugin 路径。需要本机 OpenClaw 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步 plugin。也可以手动执行 `npm run install:openclaw-plugin`，由 OpenClaw CLI 处理首次安装。Phase 1 只做状态动画，面向本地 `openclaw tui --local` 会话；暂不接 OpenClaw 权限气泡，也不支持 OpenClaw 终端聚焦。

**Hermes Agent** — 从 [hermes-agent.org](https://hermes-agent.org/) 或 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 安装 Hermes。需要本机 Hermes 追踪时，先到 **Settings → Agents** 安装 Clawd 集成；安装且 Hermes 存在后，Clawd 会把 plugin 复制到 Hermes 的托管 plugin 目录，并通过 `hermes plugins enable clawd-on-desk` 启用它。也可以手动执行 `npm run install:hermes-plugin` 强制同步，或执行 `npm run uninstall:hermes-plugin` 移除 Clawd 的 Hermes plugin。Hermes 支持状态、会话、终端聚焦和受支持的权限气泡；具体边界见 [known-limitations.zh-CN.md](known-limitations.zh-CN.md)。

**QwenWork（千问办公）** — agent id `qwenwork`；hooks 写入 `~/.QwenWorkCN/settings.json`（这是 QwenWork 真实的用户数据目录，不是它 hooks 文档里写的 `~/.qwenwork`）。需要本机 QwenWork 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步 hooks。也可以手动执行 `npm run install:qwenwork-hooks`，卸载用 `npm run uninstall:qwenwork-hooks`。

- **平台**：只支持 macOS / Windows 桌面端。[qwenwork.cn/download](https://qwenwork.cn/download) 提供 macOS 14+、Windows 10+ 与 HarmonyOS 6.1+，没有 Linux 客户端，因此 QwenWork 不出现在 WSL Pair 列表里，也没有 Linux 进程名。
- **hook-only / state-only**：Clawd 用 QwenWork 的生命周期事件驱动动画、Session HUD 和 Dashboard。`PermissionRequest` / `PermissionDenied` 仅作观察并映射成 `working`（它们是正常工具流的一部分，每个任务会触发 40+ 次，映射成 `notification` 会一直闪）。
- **Clawd 不做决定**：hook stdout 在所有路径（成功、未知事件、异常）恒为 `{}`。Clawd 不注册 `/permission`，不产生 allow/deny，QwenWork 也不在 permission automation eligibility 名单里——所有审批都留在 QwenWork 自己的权限流程。
- **无 startup recovery**：QwenWork 桌面主进程是长驻进程，它在跑不代表有正在进行的任务，Clawd 只按 hook 事件反应。
- **Windows 命令形态**：条目使用 portable 的 `node "<script>" "<Event>"` 形式，因为 QwenWork 通过 POSIX shell 执行 command hook。PowerShell `-EncodedCommand` 只用于*识别*，让旧版本写下的 Clawd 条目原地迁移，不是 Clawd 当前写入的形态。
- **所有权**：合并与卸载只处理 command 中带 `qwenwork-hook.js` marker 的条目。仅仅名为 `clawd` 的 hook 不会被动；Clawd hook 与第三方 hook 混在同一 entry 时，第三方 hook 原样保留。
- **可选调试日志**：`CLAWD_QWENWORK_HOOK_DEBUG=1` 会往 `~/.clawd/qwenwork-hook-debug.jsonl` 追加事件与字段结构摘要（不含 prompt、tool input、路径）。再加 `CLAWD_QWENWORK_HOOK_DEBUG_RAW=1` 才会记录完整原始 payload——**此时该文件含敏感数据**，用完请删除。macOS/Linux 上文件按 `0600` 创建；若 hook 新建调试目录则使用 `0700`，已有的共享 `~/.clawd` 目录保持原权限不变。

**Qoder** — hooks 写入 `~/.qoder/settings.json`。需要本机 Qoder 追踪时，先到 **Settings → Agents** 安装；安装且启用后，Clawd 才会在启动时继续同步 hooks。也可以手动执行 `npm run install:qoder-hooks`。Phase 1 是 state-only：hook 恒返回 `{}`，`PermissionRequest` / `PermissionDenied` 只作为通知观察——Clawd 不弹权限气泡、不代答权限决策，权限流程由 Qoder 原生接管。启动恢复只识别 Qoder CLI 进程（`qodercli` / `qoder-cli`），闲置打开的 Qoder IDE 不会被当成进行中的 agent 工作。

## 权限处理自动化

可从桌宠或托盘的 **权限处理** 子菜单选择 Clawd 如何处理受支持的权限请求：

- **每次询问**：不自动作出任何决定。
- **仅提问弹窗**：自动批准显式支持 agent 的工具型请求，但问题与计划审阅仍等待你处理。Claude/Qwen 使用已审阅的 built-in 列表，但并非每个受支持 adapter 都有逐工具 allowlist。
- **自动放行**：处理 adapter 判定为 automation-eligible 的请求。对 Claude/Qwen，这包括名称非空但尚未识别的请求；缺失名称、不受支持的 decision shape，以及 CodeBuddy 的问题/计划仍回到原生流程。只有愿意交出这组更广的决定时才应开启。应用重启后会降级到 **仅提问弹窗**。

两种自动化模式都会先要求确认。Dashboard 还可以为每个符合条件的 live session 独立选择 **每次询问** 或仅工具模式。新 agent 不会因为声明了权限能力就自动获得自动化资格，但工具名的处理取决于 adapter 和模式。仅状态集成和由 agent 原生接管权限的流程不会被改变。

## Telegram 远程审批

Clawd 可以把受支持、仍待处理的权限请求镜像到专用 Telegram bot；本地气泡仍然可用。通道失败或超时不会产生远程决定，也不会自动拒绝：有本地气泡时请求继续等待；只有 remote-only 且所有可用 client 都无决定时，才回到 agent 原生界面。设置、支持范围和迁移说明见 [telegram-approval.md](telegram-approval.md)。

## 飞书 / Lark 远程审批

Clawd 也可以通过飞书（中国）或 Lark（国际）的自建应用发送交互卡片。两者属于同一个远程审批通道，可在 **Settings → 远程审批 → 飞书 / Lark** 中选择平台。权限范围、用户 ID 差异和卡片语言见 [feishu-lark-remote-approval.md](feishu-lark-remote-approval.md)。

## 远程 SSH 模式（Claude Code, Codex CLI & Copilot CLI）

<img src="../../assets/screenshot-remote-ssh.png" width="560" alt="远程 SSH — 来自树莓派的权限气泡">

Clawd 支持通过 SSH 反向端口转发感知远程服务器上的 AI Agent 状态。Hook 事件和权限请求通过 SSH 隧道传回本地 Clawd，无需修改 Clawd 本体代码。

**受支持流程：应用内 Settings → 远程 SSH → 部署 / 修复 Hook**

DMG / 安装包用户的入口是 Clawd 应用内的 **Settings → 远程 SSH**：新增 profile（填 `user@host`、可选私钥、转发端口），点 **部署 / 修复 Hook** 后再连接。Clawd 会创建 profile 专属本地入口、建立指向它的 `ssh -R` 反向隧道，并部署带身份 pin 的 hooks。完整步骤、多用户升级边界、Doctor 边界和故障排查见专门指南：

**→ [docs/guides/guide-remote-ssh.zh-CN.md](guide-remote-ssh.zh-CN.md)**

当 SSH alias 的有效 `ProxyCommand` 使用 `gh cs ssh --stdio` 时，Clawd 会自动识别 GitHub Codespaces：同一 Codespace 的 Clawd 托管 SSH/SCP 会串行执行，连接就绪检查也放进持久反向隧道本身，通常不需要手动选择 transport 模式。

**工作原理：**
- **Claude Code** — command hook 和静态 PermissionRequest URL 都使用 profile 的精确远端端口；专属本地入口校验 routing nonce 后才转发状态或权限决定。
- **Codex CLI** — official hooks 和 layout 内的 fallback monitor 使用同一条 pin 住的 transport；本机无法聚焦远端窗口，所以 `request_user_input` 卡片会提示回到远端终端。
- **Copilot CLI** — 部署会在 Copilot 存在时写入解析后的 `<COPILOT_HOME>/hooks/hooks.json`；hook 使用同一条带身份校验的 transport。

**来自远端机器的 Claude 使用信息与订阅额度：**
- **Claude Code** — 部署还会在远端的 `~/.claude/settings.json` 注册 Clawd statusline，把其上报的上下文窗口和可用 Pro/Max `rate_limits` 通过隧道送回 Clawd。这仍是上面说明的官方本地 statusline 机制，不会额外请求 Anthropic。若远端已有自己的 statusline，可在 profile 中启用 **部署时串联远端已有的 statusline**：原 statusline 继续负责输出，注册会保存在 `~/.claude/hooks/clawd-statusline-chain.json`，卸载时恢复；Clawd 只读取上下文窗口与可用额度。

全新本机安装下，如果只是接收远程 Copilot CLI 事件，请到 **Settings → Agents** 打开 **Copilot CLI**，这样 Clawd 才会接收远程 hook 事件；不需要点 **Install / 安装**，除非你也想在本机安装 Copilot hooks。

Remote SSH hook 同时携带一般 remote 标记和专用 secure marker；身份缺失或损坏会
fail closed，绝不回退端口扫描。远端 PID 不会当作本机终端身份，因此远程会话不支持
终端聚焦。

共享服务器上的所有桌面都必须升级并成功重新部署，不同 Unix 账号的修复才完整生效。
`scripts/remote-deploy.sh` 已停用，因为它无法参与安全 profile 事务。同 Unix 账号的
`profile-isolated` 仍是带发布门的实验能力：隔离用户级 CLI roots 与 Clawd 路由，
不隔离整个 `HOME`、project 文件、部分 cache、同 UID 读取能力或 macOS Claude
Keychain 登录。准确边界见专门指南。

> 感谢 [@Magic-Bytes](https://github.com/Magic-Bytes) 提出 SSH 隧道方案（[#9](https://github.com/rullerzhou-afk/clawd-on-desk/issues/9)）。

## WSL（Windows Subsystem for Linux）

> 本节的主线是 Claude Code / 其他 hook 型 agent 的 WSL 配置。关于 `Codex CLI + WSL` 的官方支持现状、Codex hooks feature flag 行为、以及 Clawd 当前为什么默认扫不到 WSL Linux home 下的 Codex 日志，见：[codex-wsl-clarification.zh-CN.md](codex-wsl-clarification.zh-CN.md)

如果 agent 跑在 WSL 里、Clawd 跑在 Windows 宿主上，集成会向 `127.0.0.1:23333-23337` 上报。WSL1 天然共享这条 loopback；WSL2 通常需要镜像网络，默认 NAT 并不能让 Linux 访问 Windows 的 loopback 服务。应用内 Pair 会探测这条链路，并在安装成功但网络不可达时给出警告。

对于已支持的 agent，请在 **Settings → Agents** 的 Connected 区执行 **WSL Scan**，再找到对应发行版并点击 **Pair**。仅存在于 WSL 的 agent 仍可能位于 **Unavailable** 折叠区，因为本机安装状态与 WSL 配对是两套状态。Pair 会打开 Clawd 的事件入口，但不会把它标记为 Windows 本机集成，也不会在 Windows 安装文件。

**WSL 中的 Hermes Agent：** 请先在目标发行版里安装 Hermes。Pair 会把一份私有临时安装 payload 传入 WSL，在 Hermes 主 home 和已发现 profiles 中安装并启用 `clawd-on-desk`，随后删除临时 payload。**Unpair** 只禁用/移除该发行版里的 Clawd Hermes plugin，保留其他 plugin；如果本机或其他 WSL 来源仍可能使用 Hermes，也不会关闭全局 Hermes 事件入口。自定义 WSL `HERMES_HOME` 会从该发行版的 login shell 中解析。

**配置步骤：**

```bash
# 在 WSL shell 中执行：
mkdir -p ~/.claude/hooks

# 从 Windows 侧的 Clawd 仓库复制 hook 文件（按实际路径调整 /mnt/ 前缀）
cp /mnt/d/animation/hooks/{server-config,json-utils,shared-process,clawd-hook,install,codex-hook,codex-install,codex-install-utils,codex-remote-monitor,codex-session-index,codex-subagent-fields,copilot-hook,copilot-install}.js ~/.claude/hooks/

# 以远程模式注册 Claude hooks
node ~/.claude/hooks/install.js --remote

# 如果 WSL 中安装了 Codex CLI，也以远程模式注册 Codex official hooks
node ~/.claude/hooks/codex-install.js --remote

# 如果 WSL 中安装了 Copilot CLI，也以远程模式注册 Copilot CLI hooks
node ~/.claude/hooks/copilot-install.js --remote
```

配置完成后，在 Windows 上启动 Clawd，在 WSL 里运行 Claude Code —— Clawd 会自动感知你的会话。权限气泡也能正常弹出。

应用内 WSL 部署路径会故意以不带 `--statusline` 的方式运行 Claude installer，因此只提供 transcript fallback，不宣称能拿到自定义 provider 的权威窗口。上面的手动 `--remote` 命令会在 WSL 的独立 home 中安装一条可见 statusline，但 Windows 端应用只有在 **采集本机 Claude 使用信息** 开启时才接受它的 context/quota metadata；开关关闭时这些 POST 会被当作成功 no-op。Windows 本机启动 reconcile 也无法移除 WSL 独立 home 里的 statusline。

如果 Codex 运行在 WSL 里，official hooks 需要安装到 WSL 自己的 `~/.codex` 下。如果你希望 WSL 与 Windows 共用同一份 Codex home，也可以在 WSL 里先设置 `CODEX_HOME=/mnt/c/Users/<windows-user>/.codex` 再运行 Codex。

### WSL 网络与 Hook 注册（替代方案）

Clawd 跑在 Windows 的 Electron 应用里，而你的 AI 编程助手（Claude Code、Kiro CLI 等）可能跑在 WSL 里。WSL 中的 hook 脚本会把 HTTP 请求发到 `127.0.0.1:23333`，所以 WSL 和 Windows 必须共享同一个 localhost。

- **WSL1** — 开箱即用。WSL1 天然与 Windows 共享 localhost，无需额外配置。
- **WSL2** — 需要镜像网络模式。WSL2 默认拥有独立网络栈，`127.0.0.1` 指向 WSL 自身而不是 Windows。请在 `%USERPROFILE%\.wslconfig` 中启用镜像模式（文件不存在就新建），然后执行 `wsl --shutdown` 重启 WSL：

```ini
[wsl2]
networkingMode=mirrored
```

**在 WSL 中手动注册 hooks：**

Clawd 在 Windows 启动时会自动注册 Claude Code hooks 到 `~/.claude/settings.json`。但如果你的 Agent 跑在 WSL 里，hooks 需要注册到 WSL 自己的 home 目录。请在 WSL 中执行：

```bash
git clone https://github.com/rullerzhou-afk/clawd-on-desk.git
cd clawd-on-desk

# Claude Code
node hooks/install.js

# Codex CLI
node hooks/codex-install.js --remote

# Kiro CLI - 会将 hooks 注册到 ~/.kiro/agents/ 下所有自定义 agent，
# 并自动创建一个 clawd agent
node hooks/kiro-install.js

# Kimi Code CLI（Kimi-CLI）
node hooks/kimi-install.js

# Qwen Code
node hooks/qwen-code-install.js

# Cursor Agent
node hooks/cursor-install.js

# Gemini CLI
node hooks/gemini-install.js

# Antigravity CLI (agy)
node hooks/antigravity-install.js

# CodeBuddy
# 保留已有、由版本化 marker 管理的自定义权限 URL
node hooks/codebuddy-install.js
# 明确指定目标：
# node hooks/codebuddy-install.js --permission-url local
# node hooks/codebuddy-install.js --permission-url https://approval.example/permission

# WorkBuddy
node hooks/workbuddy-install.js

# opencode
node hooks/opencode-install.js

# Pi
node hooks/pi-install.js

# OpenClaw
node hooks/openclaw-install.js
```

> 提示：如果仓库克隆在 WSL 内（如 `~/clawd-on-desk`），hook 脚本会自动使用 WSL 的 Node.js 路径。如果仓库放在 Windows 盘里（如 `/mnt/c/...`），请确保 WSL 的 PATH 中有 `node`。

## Windows 说明

- **安装包**：GitHub Releases 提供独立的 Windows x64 和 Windows ARM64 NSIS 安装包。Intel / AMD Windows 设备下载 `Clawd-on-Desk-Setup-<version>-x64.exe`，Windows on ARM 设备下载 `Clawd-on-Desk-Setup-<version>-arm64.exe`。
- **自动更新**：Windows 安装包使用 `electron-updater`，更新时会保持当前匹配的架构。

## macOS 说明

- **源码运行**（`npm start`）：Intel 和 Apple Silicon 均可直接使用。
- **正式 DMG 安装包**：GitHub 正式 Release 同时提供 x64 与 arm64 DMG；发布工作流会用 Developer ID 签名、Apple 公证并 stapled。手动 `workflow_dispatch` 在没有签名凭据时可能只生成 ad-hoc 验证 artifact，不能当作正式安装包分发。
- **自动更新桥接**：旧版 DMG 没有 ZIP 更新载荷，不能把自己自动升级到首个支持应用内更新的版本。现有用户需要从 GitHub Releases 手动安装一次首个桥接版 DMG；装上桥接版后，后续正式版本可在 Clawd 内下载，选择“立即重启”安装，或选择“稍后”并在退出、重新打开后完成。真实能力仍以同一 Developer ID 的 A→B 真机升级记录为准，不能用单元测试代替。
- **源码自动更新**：源码运行时，“检查更新”会执行 `git pull` + `npm install`（依赖有变化时）并自动重启。

## Linux 说明

- **源码运行**（`npm start`）：默认启用 Electron sandbox。如果你的 Linux 开发环境仍然遇到 chrome-sandbox 初始化失败，可临时使用 `CLAWD_DISABLE_SANDBOX=1 npm start` 作为兼容方案。
- **安装包**：AppImage 和 `.deb` 可从 [GitHub Releases](https://github.com/rullerzhou-afk/clawd-on-desk/releases) 下载。deb 安装后应用图标会出现在 GNOME 应用菜单。
- **终端聚焦**：依赖 `wmctrl` 或 `xdotool`（有一个就行）。安装：`sudo apt install wmctrl` 或 `sudo apt install xdotool`。
- **自动更新**：AppImage / deb 安装包仍需从 GitHub Releases 手动下载；源码运行时，“检查更新”会执行 `git pull` + `npm install`（依赖有变化时）并自动重启。
