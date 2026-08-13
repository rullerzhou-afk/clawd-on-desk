# Plan: #694 Windows B0 + B1a — 将 name-only agent 的进程链解析移入 Clawd 主进程

> 状态：**Implementation v2（核心代码、自动化、x64 observer、Codex hook 与 VS Code 双会话 GUI focus 真机证据已完成；默认保持 legacy，等待 ARM64、其余真实 agent、Windows Terminal 与 CodeBuddy 外部 gate）**
> 日期：2026-08-09
> 实施基线：`main@7ffa090a1f0cdda72461ee026165247108f07a56`
> PR rebase 基线：`origin/main@89829323`
> 指定历史基线：`5c9bf10a6fe2747049de0388cd89eee9304a5ce6`，已确认是当前 HEAD 的祖先
> 关联：#694、#681、#627、#634
> 前置文档：`docs/plans/plan-issue-681-offline-hook-process-snapshot.md`
> 本文范围：实施 **Phase B0 + B1a**；工作隔离在 `feat/issue-694-windows-process-chain-b0-b1a`，不直接提交或推送 `main`

---

## 实施进度（2026-08-09）

已完成：

- NtQueryInformationProcess 生产候选、Toolhelp 对照候选、creation-time/PID-reuse 校验、x64 ABI 断言、Win32 `GetLastError()` 正确通道与 handle finally。
- runtime v1 capability、随机 instance generation、逐 agent `legacy|shadow|b1a-authoritative`、五 adapter 显式 header opt-in、fallback port 自动剥 header。
- `/state` 与 Codex `/permission` 的 fresh per-request resolve、shadow 对照、authoritative replace/clear、Codex Desktop source 规则、Codex SessionStart server HWND 采样、CodexUserInputRequest scope 隔离。
- Codex/Cursor/Kiro/CodeBuddy/Reasonix authoritative hook 路径结构性跳过旧 snapshot；可组合 fake HTTP + spawn recorder 证明六条 state/permission 脚本路径 child process=0。
- bounded allowlist shadow logger（1 MB rotate、每 channel/agent/event/kind 200 样本上限），保留经过范围校验的 old/new source/agent PID 与最多 8 项 pidChain，供 mismatch 分类。
- 本机 x64 benchmark：NtQuery 500 样本 min 0.450 ms / p50 0.605 ms / p95 0.747 ms / p99 2.492 ms / max 3.397 ms；Toolhelp 100 样本 min 9.963 ms / p50 10.625 ms / p95 11.581 ms / p99 12.444 ms / max 13.860 ms；两候选运行前后 process handle count 均为 174，delta=0。
- rebase 到 `origin/main@89829323` 后重跑 `npm test`：7,169 pass / 0 fail / 31 skip（7,200 total）；`npm run verify:electron` 通过。旧 `shared-process` walk 语义用例已改用注入式确定性 Windows snapshot，避免全量并发时 WMI 超过生产 3 秒预算造成空快照假失败；生产 legacy WMI 路径与时限未改。
- 实现 review 修正：新 resolver 重新采用 `terminalPid || lastGoodPid`；Claude 对照链由 `legacy=106/new=108` 修至 `legacy=106/new=106 (PARITY OK)`；Toolhelp 生产 FFI 通过 `koffi.address()` 识别 truthy `INVALID_HANDLE_VALUE` External 指针；四个非 Codex adapter 的 POST 复用同一 runtime port，不再二次读盘。
- 子代理实现 review 修正：Codex permission legacy editor 只接受 `code|cursor` 并进入 shadow 对照；strict partial 记录 agent-before-failure 有限分类；NtQuery PBI/FILETIME 与 Toolhelp PROCESSENTRY32W 的 size/关键 offset 不匹配时 resolver fail closed，NtQuery success 还校验 `ReturnLength`；Toolhelp 只把 `ERROR_NO_MORE_FILES` 当正常枚举结束。Kiro default/cwd 交错和 Codex auto-start 首次 legacy、重试 authoritative 均有回归测试。
- 提权 observer 真机正反对照已完成：同一轮 ready + canary 后，legacy 受控链捕获 `node -> powershell.exe`；authoritative 六条 adapter contract 全通过且观察窗口内 inner PowerShell=0。证据：`C:\Users\Ruller\AppData\Local\Temp\clawd-694-observer-10adf420fe9644fc997384f85cf6cb41.jsonl`。
- 真实仓库 Codex hook 在临时 HOME/runtime 与本地临时 server 下完成 shadow `/state`、authoritative `/state`、authoritative `/permission`：shadow old/new 四字段完全一致；authoritative body 不含 server-owned PID 字段，server 从各请求独立 hook PID 成功解析。未改 Codex/Clawd 安装配置，未调用模型。
- PR #837 开发版真实 Electron runtime 完成 shadow/authoritative 切换、真实权限请求、当前会话与第二个并发 Codex 会话验证；两个 Codex 共享同一 `Code.exe` source，但各自 agent PID/pidChain 独立，用户从 HUD 先后点击两行均精确回到对应 VS Code integrated-terminal tab。详见 §13.7。

以下外部 gate 仍未完成，因此 runtime 在所有平台默认公告 `legacy`。`shadow` / `b1a-authoritative` 只允许通过逐 agent 注入或显式开发环境变量开启；若 server resolver 初始化不可用，即使显式请求也在写 runtime 前降级为 `legacy`：

- ARM64 packaged ABI/resolver smoke。
- CodeBuddy 本机未安装，无法验证 direct HTTP permission 与 command state 的 session identity equality；CodeBuddy state 代码已具备 B1a，permission-first 仍按 §6 明确 blocked。
- Cursor/Kiro/Reasonix 的真实 CLI/桌面事件矩阵。
- Windows Terminal 专属 HWND 直达聚焦矩阵；本机已完成 VS Code 双并发 session 的真实 GUI/event-loop focus。当前 Codex 版本启动第二进程时不立即发 hook，首个 prompt 开始才产生 `SessionStart`/`UserPromptSubmit`，因此“事件到达前显示 session”不是可执行 gate；事件一到达后的首次聚焦已通过。

---

## 0. 结论先行

当前 Windows hook 的进程元数据主路径仍是：

```text
agent / outer command wrapper
  -> hook Node
       -> child_process.execFileSync("powershell.exe")
            -> Get-CimInstance Win32_Process（读取全机 PID/PPID/name/cmdline）
```

本机真实 Codex 会话证明旧 resolver 确实依赖这个内层 PowerShell，并且它解析出的两个关键 PID 目前是正确的：

```text
codex.exe 32980
  <- node.exe 28264
     <- pwsh.exe 26456
        <- Code.exe 2420
           <- Code.exe 34836

agentPid  = 32980（codex.exe）
sourcePid = 34836（最外层 Code.exe，用于终端聚焦）
```

B0+B1a 的目标态是：

```text
本地 Windows name-only hook
  -> POST /state 或 command-hook POST /permission
       header 携带 hook Node PID
       -> Electron main 内的 Windows API / Koffi resolver
            -> 沿祖先链读取 PID / PPID / exe name / creation time
            -> 生成 sourcePid / agentPid / pidChain / editor
            -> 写入本请求的 server session metadata，供 UI/focus 使用
```

切流后，Codex / Cursor / Kiro / CodeBuddy / Reasonix 的本地 Windows 正常路径不得再调用 `hooks/shared-process.js` 的 PowerShell snapshot。外层注册命令中的 PowerShell 或 `cmd.exe` 仍保留；本计划移除的是 **hook Node 再启动的内层 snapshot PowerShell**。

本文还确认了一个不能掩盖的例外：CodeBuddy 的状态事件由 `codebuddy-hook.js` 发出，可以携带 hook PID；但阻塞式权限审批是 CodeBuddy 自己直接向 `/permission` 发 HTTP，不经过 Clawd 的 Node hook，因此没有天然的 `process.pid` 可加。已有 session lookup 可覆盖“先 state、后 permission”，但不能覆盖 permission 是首个观测事件。完整 CodeBuddy permission-first 必须先取得真实协议证据，并按 payload PID、辅助 metadata command、TCP connection owner PID 验证增强候选；未通过时不能宣称五个 adapter 的 B1a 全部完成。

---

## 1. 范围、非目标与不可破坏合同

### 1.1 本计划包含

- B0：Windows API / FFI 祖先链 resolver 的 ABI spike、两种 parent API 候选比较、shadow 对照、性能与失败行为验证。
- B1a：仅切换五个只依赖进程名的 adapter：
  - Codex：`codex.exe`
  - Cursor：`cursor.exe`
  - Kiro：`kiro-cli.exe`
  - CodeBuddy：`codebuddy.exe`
  - Reasonix：`reasonix.exe` / `reasonix-desktop.exe` / `reasonix-cli.exe`
- `/state` 与适用的 `/permission` 传输 hook PID。
- permission-first、逐请求 fresh identity、session 中最新结果的 UI/focus 使用、stale metadata 清理、失败降级、shadow 日志、真机证据与发布切流门。

### 1.2 本计划明确不包含

- B1b：Claude / Copilot / Gemini / Antigravity / Kimi / Qwen / Qoder / QoderWork 等需要 `agentCmdlineCheck` 或 Claude headless 命令行判定的 adapter。
- 删除或重写 B1b 仍在使用的 `hooks/shared-process.js` Windows PowerShell resolver。
- 删除安装器生成的外层 PowerShell / `cmd.exe` wrapper。
- 根据安全软件品牌、进程名或版本写分支。
- 请求用户添加安全软件白名单。
- 用 PEB + `ReadProcessMemory` 读取别的进程命令行。
- 改变权限 allow / deny / no-decision、DND 或 stdout sanitization 协议。
- 把 hook PID 当认证信息。
- 顺手修复 editor allowlist、Windows Terminal 前台采样事件名等既存且不阻塞本迁移的问题。

### 1.3 必须保持的合同

- Clawd 不在线或 runtime identity 无效时，Phase A 的 **zero-spawn offline gate** 保持不变。
- 远程 SSH、`CLAWD_REMOTE=1`、`CLAWD_SSH_REMOTE=1`、WSL、WebUI、headless 不得进入本地 Windows B1a resolver。
- 本地 resolver 失败时只损失 focus/process metadata；状态事件仍处理，权限决定仍回到原流程。
- `sourcePid` 不能退化为 hook 的 `process.ppid` 或短命 outer wrapper。
- Codex Desktop 的 `preferAgentPid` 语义保持：最终 `sourcePid` 使用 `agentPid`，不是 terminal/editor PID。
- 旧 resolver 的 `pidChain` 对外顺序保持，不把 hook Node 自身新塞进公开链。
- 遍历时继续采用“离 hook 最近的 agent match”“离 hook 最近的 editor match”和“链上最后一个 terminal match”的现有语义。
- B1a 不得改变 B1b adapter 的 snapshot、cmdline 判定、cache 或 lifecycle 行为。

---

## 2. 本机调查记录

本节只记录可复核的结构性事实，不保存 payload、prompt、命令行内容或原始 session id。

### 2.1 仓库与工作区

- 当前分支：`main`。
- 当前 HEAD：`7ffa090a1f0cdda72461ee026165247108f07a56`。
- 指定基线 `5c9bf10...` 是当前 HEAD 祖先，当前没有发现 B0+B1a 已被别的提交实现。
- 工作区已有多项与本任务无关的 untracked 文件和目录；后续实现只能改本计划列出的文件，不得清理、移动或纳入这些用户文件。

### 2.2 当前 Clawd runtime

- `~/.clawd/runtime.json` 当前包含 `app`、`port`、`ownerPid`。
- 调查时监听端口为 `23333`，owner PID 为 `29412`，且进程存活。
- owner 是从 `D:\animation` 启动的 Electron development app。
- 这证明 runtime identity 可以作为 hook 选择 legacy/shadow/authoritative 协议的本地能力公告载体；它仍然只是 liveness/capability hint，不是认证。

### 2.3 当前日志位置与规模

当前有效运行记录主要在：

- `%APPDATA%\clawd-on-desk\session-debug.log`
- `%APPDATA%\clawd-on-desk\permission-debug.log`
- `%APPDATA%\clawd-on-desk\focus-debug.log`
- `~/.clawd/codex-hook-debug.jsonl`

`~/.clawd/logs/clawd.log` 体积很小且时间较旧，不代表当前开发实例。

`codex-hook-debug.jsonl` 调查时约 243 MB，含 52,024 条可解析记录，时间范围为 2026-04-26 至 2026-05-07；事件计数为：

| Event | Count |
|---|---:|
| PreToolUse | 24,515 |
| PostToolUse | 22,611 |
| UserPromptSubmit | 1,709 |
| Stop | 1,673 |
| PermissionRequest | 1,304 |
| SessionStart | 212 |

该文件是显式 debug sampler，并写入完整 payload。它不能复用为 B0 shadow 日志：体积不受本任务边界控制，也违反“只记录派生差异、不记录 payload/cmdline”的目标。

### 2.4 当前真实 Codex session metadata

从 `session-debug.log` 最近 5,000 行中解析到：

- 2,018 条事件记录。
- 1,584 条 Codex 记录。
- 5 个 Codex session。
- 当前活跃 session 持续上报 `agentPid=32980`、`sourcePid=34836`、`source=codex-official`。

最近样本中的 PID 组合稳定集中在每个 session，而不是每个 hook wrapper PID。这说明 session state 适合保存每次解析后的最新结果供 UI/focus 使用；它不证明下一事件可以把 existing metadata 当 ancestry truth，B1a 首版仍须逐请求 fresh walk。

### 2.5 当前真实 Codex 进程链

通过只读 `Win32_Process` 查询核对到：

| PID | Name | Parent PID | 作用 |
|---:|---|---:|---|
| 32980 | `codex.exe` | 28264 | native Codex agent |
| 28264 | `node.exe` | 26456 | npm Codex JS wrapper |
| 26456 | `pwsh.exe` | 2420 | VS Code integrated terminal shell |
| 2420 | `Code.exe` | 34836 | VS Code child process |
| 34836 | `Code.exe` | 12124 | 最外层可聚焦 editor PID |
| 12124 | `explorer.exe` | — | shell boundary |

结论：

- name-only agent 识别必须跳过中间 `node.exe` 和 shell。
- terminal/editor 不能取遇到的第一个 `Code.exe`；现有 resolver 更新 terminal match 直到外层，因此得到 34836。
- 新 resolver 必须复刻该选择语义，否则“PID 都活着”仍可能聚焦到错误进程。

### 2.6 权限日志的时间含义

`permission-debug.log` 中可关联的 943 个 Codex `hit -> response` 样本为：

- p50：10 ms
- p95：18 ms
- p99：4,210 ms
- max：111,552 ms

p99/max 包含用户阅读和点击权限气泡的等待时间，不能当 resolver 或 HTTP route 性能基线。B0 必须在进入权限等待前单独计时 process resolution；不能用这组 p99 证明 100ms state budget 已满足或未满足。

### 2.7 五个 B1a adapter 的本机可验证性

| Agent | 本机安装/启用 | 当前运行 | 可做真机 smoke | 已知限制 |
|---|---|---|---|---|
| Codex | 是 | 是 | 立即可做六事件、并发、permission-first | 外层 `commandWindows` PowerShell 必须保留 |
| Cursor | 是 | 否 | 可启动后做状态事件 | 当前配置外层使用 `cmd.exe` |
| Kiro | 是 | 否 | 可启动后做状态事件 | session id 常为 `default`，不能借磁盘 session cache 猜归属 |
| Reasonix | 是 | 否 | 可启动后做状态事件 | state-only；Windows installer 有外层 encoded PowerShell |
| CodeBuddy | 否 | 否 | 当前本机阻塞 | permission 是 direct HTTP，不经过 `codebuddy-hook.js` |

### 2.8 现有代码事实

- `hooks/shared-process.js` 的 Windows snapshot 使用 `execFileSync("powershell.exe")` + `Get-CimInstance Win32_Process`，超时 3 秒，读取 PID、PPID、Name、CommandLine、CreationDate。
- 默认从 `process.ppid` 开始，最大深度 8。
- 五个 B1a agent 配置均无 `agentCmdlineCheck`，只需 PID/PPID/name。
- `/state` 当前接收并归一化 `source_pid`、`agent_pid`、`pid_chain`、editor。
- `/permission` 的 Codex 分支会把 process metadata 写入 session，因此 permission-first 有现成落点。
- `src/state.js` 当前用 `incoming || existing` 合并 PID 字段；新 resolver 失败且旧 PID 已失效时，单纯传 null 不会清掉 stale metadata。B1a 必须增加窄作用域的 authoritative replace/clear 合同。
- `src/win-foreground-terminal.js` 与 `src/win-fullscreen-detect.js` 已证明 Electron main 内可用 Koffi，并提供 off-Windows no-op、初始化失败 fail-closed、handle finally close 的代码范式。
- 仓库当前没有可复用的 `NtQueryInformationProcess`、Toolhelp process snapshot、`GetProcessTimes` 或 `GetExtendedTcpTable` 实现。

---

## 3. 目标架构

### 3.1 每 agent 运行模式与实例关联

在 runtime identity 中增加版本化、逐 agent 的能力字段和每次 server start 唯一的实例 generation，例如：

```json
{
  "app": "clawd-on-desk",
  "port": 23333,
  "ownerPid": 29412,
  "windowsProcessChain": {
    "version": 1,
    "instanceGeneration": "<random-per-server-start>",
    "agents": {
      "codex": "shadow",
      "cursor-agent": "legacy",
      "kiro-cli": "legacy",
      "codebuddy": "legacy",
      "reasonix": "legacy"
    }
  }
}
```

每个 agent 的 mode 只允许：

- `legacy`：该 adapter 继续调用旧 hook resolver，不发送 hook PID。
- `shadow`：该 adapter 继续发送旧 metadata，同时发送 hook PID；server 只比较，不覆盖生产字段。
- `b1a-authoritative`：该 adapter 的 eligible 请求跳过旧 resolver；server 结果成为权威 process metadata。

兼容规则：

| runtime 状态 | 新 hook 行为 |
|---|---|
| runtime 缺失、损坏、owner 无效/已死 | 保持 Phase A：不 snapshot、不 POST 到该 dead identity，process metadata unavailable |
| 旧 Clawd runtime 没有能力字段 | 所有 agent 为 `legacy`，保持旧版本功能 |
| 新 Clawd 对该 agent 为 `legacy` | 旧 resolver |
| 新 Clawd 对该 agent 为 `shadow` | 旧 resolver + hook PID |
| 新 Clawd 对该 agent 为 `b1a-authoritative` | 仅该 agent 的 eligible 请求跳过旧 resolver |

开发阶段可通过 Electron 进程的显式测试环境变量选择逐 agent `shadow`，但 hook 最终以 runtime 公告为准。不得要求 agent/hook 继承 Electron 的环境变量，也不得按安全软件选择 mode。

hook 只读一次 runtime，形成不可变的：

```text
runtimeObservation = {
  port, ownerPid, instanceGeneration, version, agentMode
}
```

同一个 observation 同时用于“是否跳过 legacy resolver”和随后 POST。请求把 `instanceGeneration` 回传；server 仅当它与当前实例一致时才使用 PID metadata。generation 是多实例/重启关联令牌，不是认证信息。

首选 runtime port 失败后仍允许扫描 fallback port以送达状态/权限，但 fallback 请求不得携带 authoritative/shadow PID metadata，接收方按 metadata unavailable 处理。这样 installed/dev 两个 Clawd 实例、runtime 原子替换或重启竞态不会把实例 A 的 capability 错套到实例 B。

最终切流只在对应 agent 的 state/command-hook gate 通过后把该 agent 改为 `b1a-authoritative`。CodeBuddy 的 mode 可以先切 state hook；direct HTTP permission 没有合格 entry PID 时仍 fail closed，并继续标记为未完成。`shadow` 保留为开发诊断模式，不做永久用户设置。

### 3.2 hook PID 传输

在 `hooks/server-config.js` 的 HTTP helper 中提供 **显式 opt-in** 的 B1a header builder。只有五个 adapter 主动传入类似以下 option 时才添加：

```js
{
  windowsProcessChain: {
    agentId,
    hookPid: process.pid,
    runtimeObservation,
  },
}
```

wire header 至少包含：

```text
X-Clawd-Hook-Pid: <process.pid>
X-Clawd-Process-Instance: <runtime instanceGeneration>
```

合同：

- 仅五个 adapter 显式 opt-in、本地 Windows、对应 agent mode 为 `shadow` 或 `b1a-authoritative`，并且当前投递 port 等于 observation port 时添加。
- Remote SSH / secure remote ingress 必须省略。
- server 只接受十进制正整数、`1..0xffffffff` 范围。
- header 是 ancestry entry hint，不是认证、授权或所有权证明。
- server 必须同时以 instance generation、`remoteProfile`、agent allowlist、effective host/WSL/platform/headless 与链上 expected agent name 验证 eligibility。
- header 不进入 debug payload dump，不持久化为 session 字段。
- 旧 server 会忽略未知 header；新 hook 对旧 runtime 仍走 legacy，因此升级/降级兼容。
- Claude/Copilot/Qwen 等 B1b hook、custom/statusline 和其他通用 helper 调用点不传 opt-in option，wire shape 不变。

选择 header 而不是给五份 JSON body 增加字段，是因为 process PID/instance 属于传输上下文，不是 agent 业务数据；server 可以在读完 body、完成 source classification 后再决定是否使用。

### 3.3 authoritative hook 控制流

五个 hook 不能在 body 尚未应用 source boundary 时就决定跳过旧 resolver。应先建立最小 body/source boundary，再调用共享 helper：

```text
build base body
  -> apply remote / WSL source fields
  -> Codex 额外检查 argv 是否含 CODEX_WSL_INTEROP_ARG
  -> read one immutable runtimeObservation
  -> if local Windows + matching B1a agent + authoritative + not WSL/remote:
       不调用 createPidResolver() 返回的 resolve()
       POST 到 observation.port 时加 hook PID + instance generation
     else:
       保持 legacy resolve() 与原字段
```

测试必须用会抛错的 legacy resolver seam 证明 authoritative 路径从结构上没有调用旧 resolver，而不是“调用后碰巧 cache hit”。

仅调用 `applyWslSourceFields()` 不足以排除 Windows-node WSL interop：当前 WSL detector 在 `process.platform === "win32"` 时返回 null，而 Codex interop 由 `--clawd-wsl-interop` 标记。该 interop 实际在 WSL 内启动 Windows `node.exe`，body 不携带可供 server 独立识别的 WSL 标记。主防线必须是 Codex hook 的 argv 检查：该 argv 下不 opt-in header、不跳过旧边界行为；若异常或伪造 header 仍到达 server，再由 expected agent executable name 校验 fail closed。不能把 server 的 host/WSL 检查描述为此 interop 场景的独立第二道防线。

### 3.4 server eligibility 与 route 顺序

server 仅在以下条件全部为真时使用新 resolver：

1. `process.platform === "win32"`。
2. 请求来自本地主 server，`remoteProfile === null`。
3. agent id 属于 Codex / Cursor / Kiro / CodeBuddy / Reasonix。
4. request instance generation 与当前 server instance 一致。
5. 合并 incoming 与 existing 后的 **effective** host/WSL/platform/headless 仍属于本地交互 Windows；不能只看当前 body 缺没缺字段。
6. 对应 agent mode 是 `shadow` 或 `b1a-authoritative`。
7. header PID 合法且当前可打开/查询。
8. 解析链上出现该 adapter 允许的 agent executable name。

即使 localhost 客户端伪造 header，也只能影响已有本地非认证状态接口中的 focus metadata；expected agent name 和 creation time 校验用于健壮性，不能描述成安全认证。

`/state` 的顺序必须明确为：

```text
parse / normalize
  -> reject invalid/custom/disabled/metadata_only
  -> validate state
  -> Codex official/subagent/headless classification
  -> incoming + existing 得 effective source boundary
  -> B1a resolver
  -> 用新 effective sourcePid 参与现有 WT sampling
  -> updateSession
```

这样 authoritative UserPrompt 的首事件也能在现有 WT sampling 前得到 sourcePid。`/permission` 则先完成 invalid/disabled/DND/headless 等无需 focus 的短路，只在真正需要持久化或创建 bubble/remote approval 的路径解析；resolver 失败不得改变决策分支。

`CodexUserInputRequest` 明确不进入上述 B1a `/state` 编排：

- 目前唯一通过 HTTP `/state` 构造 `codex_user_input` 的是 `hooks/codex-remote-monitor.js`；它始终带 remote `host`，因此不满足本地 B1a eligibility，也没有本地 hook PID header。
- 本地 JSONL monitor 不走 `/state`，而是在 `src/agent-runtime-main.js` 中直接调用 bubble/session 路径，并由 `agents/codex-log-monitor.js` 提供写日志的 Codex process metadata。
- official `hooks/codex-hook.js` 不发出 `codex_user_input`。

因此不得把 resolver 提前到 `codex_user_input` 分支之前，也不得把 authoritative replace 泛化到所有 `CodexUserInputRequest`。只增加回归测试，证明 remote monitor 与本地 JSONL direct path 的 PID/focus 行为保持不变。

### 3.5 B1a 首版逐请求 fresh walk

B1a 首版不做跨事件 session reuse。每个 eligible request 都从 **该请求自己的 hook PID** fresh walk：

- Kiro 没有稳定 session id，所有真实会话都合并为 `default`；按 existing session 复用会把并发 Kiro A 的链交给 Kiro B。
- Cursor / CodeBuddy / Reasonix 在缺少 raw session id 或 cwd 时也明确不可缓存。
- 只做 `processAlive(pid)` 不能识别跨事件 PID reuse。
- 逐请求设计最简单，也最接近旧 resolver 的 per-event correctness；性能是否足够由 B0 数据决定，不在 plan 中预先用不安全 cache 优化。

server session 仍保存本次结果供 Dashboard/focus 使用，但它不是下一次请求的 ancestry truth。permission-first 在进入权限等待前 fresh walk；后续 state 再用自己的 hook PID fresh walk。

若 B0 证明逐请求 FFI 无法满足性能门，才另开一个受控优化切片：

- Kiro 永远不按 `default` session reuse；同 cwd 也不足以区分并发实例。
- Cursor / CodeBuddy / Reasonix 必须复刻现有 raw session id + cwd cacheability 规则。
- “cache hit”最多把 **full ancestry walk** 降为 0；仍要查询 source/agent PID 的 current creation identity，不能宣称 FFI=0。
- creation identity 存在 server 私有、bounded、带 TTL/capacity/cleanup 的 sidecar，不进入 UI/session snapshot。
- async worker/cache 结果用 generation token，不能由迟到结果覆盖新请求。

### 3.6 authoritative replace/clear

当前 state merge 无法清空 stale PID，因此增加一个只供 server resolver 使用的纯函数合同，由 normal state 和 transient permission 两条路径共同调用：

```text
mergeProcessMetadata(existing, incoming, mode)
mode = merge | authoritative-replace
```

route 可继续通过窄作用域 option 表达：

```js
updateSession(sid, state, event, {
  replaceProcessMetadata: true,
  sourcePid: result.sourcePid || null,
  agentPid: result.agentPid || null,
  pidChain: result.pidChain || null,
  editor: result.editor || null,
})
```

`authoritative-replace` 必须：

- null 真正清掉 `sourcePid`、`agentPid`、`pidChain`、`editor`。
- clear 时强制 `pidReachable=false`，不得回退 existing true。
- source identity 改变/清空、且同请求没有 fresh HWND 时清掉 stale `wtHwnd`。
- 向 `mergeOrcaPaneKey` 提供明确的 changed/cleared 信号，不能让旧 focus identity 黏住。
- 覆盖 normal merge 与 Codex transient PermissionRequest 两套现有 truthy merge。
- transient result 即使全 null 也必须进入 replace，不能被 `shouldPersistCodexPermissionFocus` 的 truthy gate 跳过。
- B1b 永远使用原 `merge`。

adapter 定义的常量 fallback 不属于 walk 派生数据。例如 Cursor 在旧本地 hook 中无条件发送 `editor = detectedEditor || "cursor"`；authoritative 解析失败时仍应按 adapter 规则保留 effective `editor="cursor"`，只清除 walk 派生的 editor。测试必须区分 raw walk editor 与 adapter effective editor。

cwd、host、session identity 与其他 agent metadata不受此纯函数影响；fresh server WT HWND 在同请求生成时可保留。

失败规则：

- 每个 eligible 请求都解析；成功则原子替换。
- 新解析失败：显式清空上一事件留下的 process/focus identity，不用 existing 或 `process.ppid` 猜。
- 新 session 解析失败：字段保持 null。
- permission route 解析失败：权限流程继续，决定协议不变。

### 3.7 Codex Desktop 特例

低层 resolver 返回 terminal/editor `stablePid` 与 `agentPid`。route 根据现有 `codex_originator` / session meta 再应用：

```text
Codex CLI      sourcePid = stablePid
Codex Desktop  sourcePid = agentPid
```

shadow 对照必须比较 **应用该规则后的 effective sourcePid**，否则会把正确的新低层结果误报为 mismatch。

### 3.8 前台 Windows Terminal

`foregroundWtHwnd` 继续由 Electron main 的现有 `captureForegroundWindowsTerminal()` 负责，不并入新 ancestry FFI。但不能只保持当前 UserPrompt sampling：旧 snapshot 只有在 Codex `SessionStart` fresh walk 时稳定提供 hook 侧 `foregroundWtHwnd`；`UserPromptSubmit` 的 cache-only 生命周期不会提供 fresh HWND。若 authoritative `SessionStart` 直接删除旧 snapshot 而 server 仍只在 UserPrompt 采样，会使 SessionStart 到首个 prompt 之间失去 Windows Terminal 直达窗口聚焦，退化为 process-chain focus。

本计划固定采用补偿方案，而不是把该退化登记为 accepted change：

- 对 eligible authoritative Codex `SessionStart`，在 B1a resolver 与 effective source boundary 之后调用现有 `captureForegroundWindowsTerminal()`，与 UserPrompt 使用同一探针和边界。
- shadow 阶段的 Codex `SessionStart` 也额外采样 server candidate，仅用于与 legacy hook HWND 对照；user-visible state 仍使用 legacy body，不能让 shadow 改行为。该诊断采样必须是独立路径，不受生产采样现有 `!wtHwnd` 短路影响——legacy body 正好已有 HWND，才有对照意义。
- legacy HWND 采于 hook-side fresh walk，server candidate 采于请求到达后；两者之间前台窗口可能合法切换。HWND mismatch 必须按采样时间差/前台切换分类，不设数值 100% parity 门；最终完成证据以 §10 的 SessionStart 后、首 prompt 前真实聚焦行为为准。
- 采样失败按现有 best-effort 语义返回 null，不启动 PowerShell，也不改变 ancestry/permission 决策。
- 真机必须验证 `SessionStart` 后、首个 prompt 前点击聚焦仍能命中正确 Windows Terminal 窗口。

本计划不顺手统一 Kiro/Copilot 的 prompt event 拼写，也不承诺所有 agent 都获得新的 WT foreground sampling。

---

## 4. B0：Windows API / FFI spike

### 4.1 低层模块边界

建议新增 `src/win-process-ancestry.js`，只负责：

- 由一个 PID 获取 parent PID、exe basename、creation time；完整 path 只在低层瞬时使用，不扩大到语义层。
- 先查询 1 个 hook identity，再最多公开 8 个 outward ancestor；hook query 不占旧 `maxDepth=8`。
- eligibility 的“header PID 当前可查询”与 walk 的 hook identity query 必须合并为同一次 `OpenProcess`/同一份 identity observation，不能先探活再重开一次 handle，避免重复开销和额外 TOCTOU 窗口。
- 处理 process exit、access denied、invalid handle、PID reuse、system boundary。
- 返回结构化 status/error kind，不做 agent 语义分类。
- off-Windows 或 Koffi init 失败返回 unavailable，不抛到 route。

建议新增 `src/server-windows-process-metadata.js`，负责：

- B1a allowlist 与每个 agent 的 `agentNames`、terminal names、editor map。
- local/remote/WSL/headless eligibility。
- 每请求 fresh walk；若性能 gate 失败，再承载受限 reuse policy 与 creation identity sidecar。
- 旧/新 shadow 对照与 effective Codex sourcePid。
- authoritative 结果到 route/state 的 merge contract。
- 性能计时和 privacy-safe debug record。

低层 FFI 不 require route/state；语义层通过依赖注入接收 `queryProcess`、`processAlive`、clock、logger，方便在非 Windows CI 做完整单测。

### 4.2 候选 A：per-ancestor handle walk

候选 API：

- `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid)`
- 动态加载 `ntdll.dll!NtQueryInformationProcess`
- `ProcessBasicInformation` 读取 `InheritedFromUniqueProcessId`
- `QueryFullProcessImageNameW` 读取 exe path/name
- `GetProcessTimes` 读取 creation FILETIME
- `CloseHandle` 关闭每一个成功打开的 handle

优点：只查询当前祖先链，数据范围最窄。

风险与必须验证项：

- `NtQueryInformationProcess` 文档将其视为可能变化的内部接口，不能只凭开发机成功就定案。
- `PROCESS_BASIC_INFORMATION` 中 `ULONG_PTR` 在 x64/ARM64 的尺寸、对齐与 Koffi 声明必须核对，并对实际 `sizeof/offset` 写断言。
- `NTSTATUS=int32`、`DWORD=uint32`、`ULONG_PTR/uintptr_t` 的 Koffi 值必须显式归一化。
- `NTSTATUS`、null handle、protected/elevated process、祖先进程瞬间退出要区分。
- Koffi `2.16.3` 在每次 Windows FFI 调用前后保存/恢复 TEB `LastErrorValue`（x64：`src/koffi/src/abi_x64_win.cc` 的 `CallData::Execute`；ARM64：`abi_arm64.cc` 的 `_WIN32` 分支），因此通过 Koffi 声明的 `kernel32!GetLastError()` 在紧随失败调用之后调用时，读到的是该失败调用的 Win32 错误码，不被中间 Node/V8 活动污染。Win32 API 失败后经该通道采样错误码，仅用于诊断分类；`koffi.errno()` 是 CRT/POSIX errno，与 kernel32 last error 无关，禁止用于 Win32 错误分类。控制流首先依赖 API 返回值，NT API 依赖其 `NTSTATUS`，不得用错误码猜测 ancestry 或放宽 fail-closed。B0 spike 仍须在本机实测一次故意失败的 `OpenProcess`，插入 JS 分配/GC 压力后再经 Koffi 声明的 `GetLastError()` 采样，确认错误码保持。
- `QueryFullProcessImageNameW` 的 buffer size 单位是字符数，不是 byte。
- 不得把 64-bit FILETIME 合并成可能丢精度的 JS Number；建议保留 `{ high, low }` 并做无符号字典序比较。

### 4.3 候选 B：Toolhelp snapshot

候选 API：

- `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)`
- `Process32FirstW` / `Process32NextW`
- `PROCESSENTRY32W.th32ProcessID` / `th32ParentProcessID` / `szExeFile`
- 仅对最终祖先链打开 handle，使用 `QueryFullProcessImageNameW` / `GetProcessTimes`
- `CloseHandle` 关闭 snapshot 和 process handles

优点：parent PID API 稳定、文档化，不依赖内部 NT struct。

代价：创建全系统基础进程快照。即使不读命令行，也必须诚实记录这一数据边界；临时 PID map 不得日志、落盘或传给 hook。

Toolhelp 特有验证：

- `INVALID_HANDLE_VALUE` 不是 null，且必须按当前指针宽度比较。
- `PROCESSENTRY32W.dwSize`、Unicode struct、`szExeFile` 数组长度正确。
- `ERROR_BAD_LENGTH` 只做有上限重试。
- 高进程数机器的同步阻塞时间。

### 4.4 候选选择 gate

B0 不预先指定胜者。用同一批真实/合成链比较：

| 维度 | per-ancestor NtQuery | Toolhelp |
|---|---:|---:|
| expected agent 命中率 | 记录 | 记录 |
| sourcePid 等价率 | 记录 | 记录 |
| agentPid 等价率 | 记录 | 记录 |
| pidChain 等价率 | 记录 | 记录 |
| editor 等价率 | 记录 | 记录 |
| access denied / exited / partial | 分类 | 分类 |
| p50/p95/p99/max | 记录 | 记录 |
| Electron event-loop block | 记录 | 记录 |
| x64 ABI | 真机 | 真机 |
| ARM64 ABI | 真机或正式硬件 gate | 真机或正式硬件 gate |
| API 稳定性与维护风险 | 评审 | 评审 |
| 数据范围 | 祖先链 | 全系统基础 snapshot |

生产实现只选一条主路径。另一候选不能偷偷变成失败 fallback；尤其不能 fallback 到 PowerShell。若主路径 unavailable，结果就是 metadata unavailable。

### 4.5 PID reuse / 退出竞态

从 hook PID 开始时：

1. 查询 hook PID 的 creation time 和 parent PID。
2. 查询 parent 的 creation time。
3. 只有 `parent.creationTime <= child.creationTime` 才继续。
4. 每上移一层重复该关系。
5. 任一层 PID 不存在、creation time 反向、parent 自环、已访问 PID 重复、超过 maxDepth 时停止并返回明确 reason。

低层 walk 可以读取 hook 节点来建立 child identity，但 outward `pidChain` 从 hook 的 parent 开始，保持旧 resolver 兼容。测试必须覆盖“expected agent/terminal 恰好出现在第 8 个 outward ancestor”：最多是 1 次 hook query + 8 个公开节点，不能产生 off-by-one。

若在找到 expected agent 之前发生非自然失败，整次结果 fail closed；不能把半条链当可靠 `sourcePid`。若已经找到 expected agent，之后在寻找 outer terminal 时失败，B0 默认采用更严格的 partial/unavailable。旧 snapshot 在表非空且 start PID 可见时可能返回已读部分链，因此这是一项有意的 stricter behavior change，shadow 需标为 `intentional-stricter-partial-failure`，单独统计 focus 成功率；不能一面接受该差异，一面宣称所有样本四字段 100% parity。

### 4.6 parity 语义

shadow 不能只比较“有没有 PID”。新语义必须逐项复刻：

- agent：从 hook 向外遇到的第一个 expected agent name。
- terminal/source：遍历中每次遇到 terminal name 都更新，最终取最外层 match。
- editor：旧代码只在尚未检测到 editor 时赋值，因此取离 hook 最近的第一个 editor match；保持 case-insensitive basename 匹配。
- system boundary：与旧 `SYSTEM_BOUNDARY_WIN` / PID boundary 一致；boundary 进程先计入 outward `pidChain`，随后终止遍历，但不更新 terminal/source 或 `lastGoodPid`。
- maxDepth：hook identity query 不计入，outward ancestor 默认 8。
- Codex Desktop：比较 effective sourcePid。
- outward `pidChain`：不含 hook Node，顺序与旧 resolver 相同。

任何“新实现其实更合理”的差异都先分类，不能在 B0 中悄悄改既有用户行为。comparable legacy fresh-success 样本必须精确 parity；legacy cache hit、legacy unavailable/new available、以及上述 stricter partial failure 分开计算，不混进同一个百分比。

---

## 5. B0 shadow、日志与性能

### 5.1 shadow 行为

shadow 模式下：

- hook 仍调用旧 resolver，并发送旧 `source_pid` / `agent_pid` / `pid_chain` / editor。
- 该 adapter 显式 opt-in，HTTP helper 在 observation port 上发送 hook PID + instance generation header。
- server 用新 resolver 计算候选结果。
- route 继续使用旧字段，用户可见 session/focus 不受新结果影响。
- logger 只记录对照结果和耗时。

shadow 与 authoritative 首版都逐 eligible 请求解析。shadow 日志达到每 agent/event 的样本上限后可以停止额外对照记录，但性能验证仍需覆盖持续事件负载。

旧 resolver 的返回带 `cacheSource=fresh|v2|v1|none`。shadow transport 需用不含业务数据的诊断 header/option 把该 provenance 交给 server，按三类计算：

- `fresh` 且成功：四字段 exact parity 的主要 denominator。
- `v1/v2` cache hit：比较 cache 实际保存的 stable/agent/editor subset；`pidChain` 缺失不算新 resolver mismatch。
- `none/unavailable`：新结果单列为 new-only available 或双方 unavailable。

另外分别报告 raw resolver editor 与经过当前 route allowlist 后的 effective editor。CodeBuddy 可在 raw 层得到 `codebuddy`，但当前 state/focus 只消费 `code|cursor`；本计划不借 parity 报告暗示 editor allowlist 已扩展。

### 5.2 privacy-safe bounded log

新增独立日志，例如：

```text
%APPDATA%\clawd-on-desk\windows-process-chain-shadow.log
```

使用 `src/log-rotate.js`，默认上限 1 MB，并再加进程内样本上限。每条 JSONL 只允许：

- timestamp
- resolver version / candidate API / mode
- agent id / event name
- old/new `sourcePid`、`agentPid`、`pidChain`、raw/effective editor
- match booleans
- legacy cache provenance、status / bounded error kind
- depth / durationMs
- 是否为 intentional stricter partial failure

禁止记录：

- stdin payload
- prompt/tool input/output
- command line
- 全系统进程表
- exe 完整路径
- cwd
- transcript path
- raw session id
- 环境变量

现有 243 MB `codex-hook-debug.jsonl` 不参与 shadow，也不在本任务中删除。

### 5.3 性能测量分层

分别测：

1. 单个低层 process query。
2. 一次 1 个 hook identity + 最多 8 个 outward ancestor 的 walk。
3. semantic classification。
4. `/state` 从 body parse 到 response end 的 server 时间。
5. `/permission` 从 body parse 到进入用户等待前的 resolver 时间。
6. Electron event-loop delay / UI frame impact。

每组记录 cold/warm 的 p50、p95、p99、max、失败率、样本数与机器信息。权限气泡的人类等待时间不计入 resolver 指标。

### 5.4 provisional performance gate

在 B0 数据出来前先设保守 gate，不能用“平均很快”替代尾延迟：

- ancestry resolver p99 不超过 25 ms，max 不超过 50 ms。
- 本地 `/state` server route p99 不超过 75 ms，为 hook 100 ms timeout 留至少 25 ms 传输/调度余量。
- 本地 `/permission` 从 body parse 经 authoritative resolve/session update 到 bubble/native handoff 的 pre-wait route p99 不超过 75 ms；590 秒阻塞等待和用户思考时间不计入。
- 单次同步 main-thread block p99 不超过一个约 16 ms frame budget；超过即进入 worker/persistent helper 设计评估。
- 0 handle leak；在隔离测试进程中用 `GetProcessHandleCount` 对连续 10,000 次 real mixed success/failure 测稳定 delta，避免 Electron 后台 handle 波动污染结论。

若同步 FFI 不达标：

- 优先使用一个随 Electron 生命周期存在的 worker thread，并把 Koffi 与 query 封装在 worker 内。
- 每个请求带 generation token；request 超时后丢弃迟到结果，不污染已替换的 session。没有稳定 identity 的 Kiro/default 请求不得按 session single-flight 合并。
- 仍不得回退 hook PowerShell，也不得启动每事件 helper process。

最终数字如需调整，必须在 evidence 文档中写明机器、样本、分位数和调整理由，再由 reviewer 批准；不能在实现中静默放宽。

---

## 6. CodeBuddy permission-first 决策门

### 6.1 已确认的协议差异

- `codebuddy-hook.js` 处理 state/notification，可显式 opt-in hook PID header。
- `codebuddy-install.js` 的阻塞式 PermissionRequest 注册为直接 HTTP URL。
- direct HTTP request 的客户端是 CodeBuddy 自己，不会执行 `hooks/server-config.js`，因此不会自动带 `X-Clawd-Hook-Pid`。
- 不能为了方便把它未经验证改成 command shim；项目合同要求 CodeBuddy 阻塞审批走 `POST /permission` HTTP hook。

### 6.2 证据取得顺序

安装并启用真实 CodeBuddy 后，先做最小、脱敏的结构采集：

1. 只记录 PermissionRequest payload 的字段名和数值字段类型，不记录值/内容。
2. 在一个受控 CodeBuddy session 中配对 command state 与 HTTP permission，记录两侧 `session_id` 是否存在、是否使用 fallback、经 `resolveSessionIdentity` 后是否相等；不得落盘原始 session id，只允许记录 equality boolean，或在必须跨记录关联时使用仅本次采集有效的随机加盐哈希。
3. 检查是否已有由 CodeBuddy 定义、可证明属于当前 requester 的 PID 字段。
4. 同时记录 `req.socket.localAddress/localPort/remoteAddress/remotePort`，不记录业务 payload。
5. 对照同一时刻的 CodeBuddy/IDE 进程树。

若 payload 有可靠 PID，先验证它跨 CLI/IDE/版本的语义，再决定使用；字段名像 `pid` 不等于已证明是 requester PID。

### 6.3 候选 0：沿用已有 session lookup 的零新增 API baseline

先准确限定现状可能覆盖的范围：CodeBuddy state hook 在 B1a 切流后会把 authoritative metadata 写入 session；permission bubble 的聚焦主路径按 `sessionId` 读取现有 session，再与 generic `permEntry` fallback 合并。因此，只有在 §6.2 真机证明 command state 与 HTTP permission 的 session identity 规范化为同一 key，且该 session 在权限请求前至少出现过一个 state 事件时，generic permEntry 本身没有 PID 才不会影响现有 session 聚焦主路径。

候选 0 不声称解决 permission-first。若两路 session identity 已证明一致，它留下的精确缺口是：PermissionRequest 是该 session 的第一个可观察事件、此时没有可查询 session metadata；若两路 identity 不同或无法验证，则候选 0 覆盖率视为 0，而不是“通常可用”。该 baseline 零新增 API、零协议风险，可以作为缩小发布声明的最低方案；§6.2 的 payload PID、下述辅助 command 或 TCP owner 都是为了消灭这个首事件窗口。

### 6.4 条件候选 A：辅助 command metadata hook

若 payload 没有可靠 PID，先验证一个比 TCP table 数据范围更窄、但不能假设可行的候选：

- 保留现有 HTTP hook 作为唯一阻塞/决策路径。
- 额外注册一个 PermissionRequest command hook，只上报 process metadata，stdout 恒为无决定。
- 必须用真实 CodeBuddy 证明 command hook 一定在 HTTP 阻塞前执行、同一 PermissionRequest 有可靠关联键、不会双重审批或改变原生 fallback。

只要执行顺序、并发关联或 timeout 任一无法保证，就拒绝该候选；不得用 race-prone 的“通常先到”上线。

### 6.5 条件候选 B：TCP owner PID

若 payload 没有 PID，B0 可单独 spike：

- 在请求仍打开时用 `GetExtendedTcpTable(TCP_TABLE_OWNER_PID_CONNECTIONS)`。
- 用 server socket 的反向四元组匹配客户端连接。
- 取得 owning PID 后走同一 ancestry resolver。
- 对 MIB 端口字节序、`ERROR_INSUFFICIENT_BUFFER`、server/client 四元组反向匹配、Electron network/utility process、连接复用、IPv4 loopback、瞬时关闭、多并发请求做真机验证。

该方案仍是 Windows API，不改变 CodeBuddy HTTP hook 合同，但它会读取系统 TCP owner table，必须独立记录数据范围、耗时和错误面。只有真实 CodeBuddy permission-first 100% 命中 expected agent 链时才能进入生产。

### 6.6 成功后的 route/state 落点

无论最终采用 payload PID、辅助 command 或 TCP owner，解析成功后都不能只改一个 session-options builder：

- generic CodeBuddy `permEntry` 必须带 `sourcePid`、`agentPid`、`pidChain`、effective editor，供 permission bubble 的 focus fallback 使用。
- generic `updateSession()` 调用必须显式带同一 metadata。
- `state.js` 增加只对“已验证的 CodeBuddy authoritative permission metadata”生效的 permission-first persistence；其他 generic permission 不得因此创建 ghost session。
- 该窄分支与 Codex transient 分支共用 §3.6 的 authoritative replace/clear 纯函数。

### 6.7 失败结论

若 payload PID、辅助 command 与 TCP owner PID 都不能可靠定位 CodeBuddy ancestry：

- CodeBuddy state 可以完成 B1a。
- CodeBuddy permission-first process metadata 保持 unavailable；不得因同名/default session 复用别的实例 metadata。
- 不影响权限决定。
- #694 的“五个 adapter permission-first 全完成”不得勾选；必须明确缩小发布声明或继续研究。

---

## 7. B1a 实施切片

### Slice 0：建立可重复的旧路径正对照

目的：先证明 observer 真能看到内层 snapshot PowerShell，避免完成后“零事件”只是观测器失效。

- 先在目标测试权限级别实测 observer 可注册。本机 2026-08-09 的非管理员 token 实测 `Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace` 返回“拒绝访问”，因此本计划的 WMI/ETW observer 必须在明确 UAC 提升的专属测试会话中启动；若改用等价 observer，也必须先记录其权限前提。
- ready handshake 只能在订阅注册成功后输出；注册失败、权限不足和 canary 未捕获必须是三种不同结果，不能都归类为“本轮无效”。
- 同一轮先运行一个带唯一 marker 的受控 Node -> PowerShell canary，证明 observer 当时仍在工作；canary 失败时先检查权限/订阅状态，再判断 observer 逻辑。
- observer 在专属测试会话中运行并通过该会话内 `exit` 结束；不得 `taskkill` / `Stop-Process` 清理 Windows Terminal。
- 明确排除 observer 自己产生的 PowerShell PID/子树。
- 在当前 legacy Codex 六事件中捕获：outer wrapper -> hook Node -> inner snapshot PowerShell。
- 记录 parent PID 关系，而不是只数系统里出现了几个 `powershell.exe`。

自动化测试不能依赖管理员权限。把现有 offline probe 中的“记录 spawn”能力拆成可复用 preload recorder，使 authoritative hook 测试可以正常连接 fake HTTP server，同时断言 `execFileSync`/PowerShell spawn 为 0；阻断 HTTP 的 offline 行为仍由原 helper 单独控制。管理员 observer 是真机证据层，非管理员 spawn recorder 是自动化回归层，两者不能互相替代。

通过标准：observer 在目标权限级别注册成功且输出 ready；同轮 canary 被捕获；至少一个受控 legacy hook 事件被 observer 正确识别为 hook Node 的 PowerShell child。

### Slice 1：FFI ABI spike 与候选定案

- 建立 `src/win-process-ancestry.js` 的可注入原型。
- 实现 NtQuery 与 Toolhelp 两个候选，仅用于 spike。
- 使用静态 fake process graph 锁定 parent/name/creation/error 语义。
- 在本机 Codex chain、VS Code terminal、Windows Terminal/standalone shell 上对照。
- 记录 x64 数字；ARM64 未验证前不得标记 B1a release-ready。
- 选出单一生产 API，删除未选候选的生产调用路径；可以保留测试/证据脚本，但不能形成自动 fallback。

产物：候选 decision record、ABI 表、性能分位数、错误分类。

### Slice 2：runtime capability 与 hook PID transport

- 扩展 `parseRuntimeConfig` / `readRuntimeIdentity` / `writeRuntimeConfig`，保持旧 shape 可读。
- `src/server.js` 在 start 和 Doctor repair 两条写 runtime 路径使用同一 per-agent mode map 与 instance generation。
- `hooks/server-config.js` 只给五个 adapter 显式 opt-in、且投向 observation port 的 request 添加 header；fallback 送状态但无 metadata header。
- remote/secure/old runtime/invalid runtime/Windows-node WSL interop/双本地 Clawd 实例测试。
- runtime 文件写失败继续使 hook process metadata fail closed；不因能力字段失败恢复 PowerShell。

### Slice 3：server semantic resolver 与 state route shadow

- 新增 B1a agent config/semantic layer。
- 按 §3.4 固定 route 顺序，在 Codex classification 与 effective source boundary 后、WT sampling 前运行 eligibility/resolver。
- shadow 比较 old/new，不改变 updateSession 输入。
- 分开记录 fresh/cache/unavailable、raw/effective editor 与 intentional partial failure。
- 增加 bounded rotated log 和分层计时。
- 验证 stale existing metadata 的 replace/clear seam，但 shadow 不启用生产替换。
- 增加 `CodexUserInputRequest` transport-source 回归：remote HTTP monitor 因 host boundary 不进入 B1a，本地 JSONL direct path 不经 `/state`，两者的 PID/focus 行为均保持原样。
- Codex `SessionStart` shadow 通过不受 `!wtHwnd` 短路影响的独立诊断调用采样 server HWND candidate，并与 legacy hook HWND 按时间差分类对照，但不改变 user-visible session、不设 HWND 100% 数值 parity 门。

### Slice 4：Codex `/permission` shadow 与 permission-first

- command hook `/permission` 携带 hook PID。
- 在 invalid/disabled/DND/headless 短路后、进入真正的 bubble/Telegram/native fallback 等待前解析。
- 与 state route 共用 semantic resolver 和 session metadata 合同。
- 测试 no-decision、DND、bubble disabled、超时、stdout sanitization 均不变。
- 真实 permission-first：新 session 的第一个观测事件直接为 PermissionRequest，确认可建立 focus metadata。
- 点名覆盖 native permission mode：即使 `shouldInterceptCodexPermission === false`，现有路径仍会 `updateSession(..., codexSessionOptions)`；resolver 必须在该 updateSession 之前完成，且不得把 native no-decision 路径误判为“不需要 metadata”。

### Slice 5：五个 adapter authoritative cutover

按风险分开切，不做一次性机械替换：

1. Codex：六事件、CLI/Desktop `preferAgentPid`、permission-first、两个并发 session；authoritative `SessionStart` 由 server 采样 WT HWND，首 prompt 前聚焦不退化。
2. Cursor：外层 `cmd.exe` 保留，authoritative 路径不调用旧 resolver，解析失败仍保留 adapter 常量 `editor="cursor"`。
3. Kiro：每请求必须使用本次 hook PID，不按 `default` 或 cwd 复用；不同 cwd、相同 cwd的两个并发 Kiro 都做交错测试。
4. Reasonix：state-only，延迟 Stop 和 outer encoded PowerShell 不变。
5. CodeBuddy state：状态 hook 切流；permission 只有通过 §6 gate 才勾选。

每个 adapter 都可以独立回到 runtime `legacy` 进行诊断，但生产 capability 不按用户安全软件或 agent 版本永久分叉。

### Slice 6：真实 Windows 无内层 PowerShell 证明

沿用 Slice 0 的同一 observer 与判定逻辑：

- observer 必须在已验证可注册的提升会话中 ready，不能从普通非管理员自动化会话静默启动后把 Access Denied 当零事件。
- outer PowerShell/cmd wrapper 允许存在。
- 每轮 authoritative negative count 前先跑 contemporaneous canary，observer 未捕获 canary则本轮无效。
- hook Node 的 PowerShell child 必须为 0。
- Codex 六事件、两并发 session 各运行多轮。
- Cursor/Kiro/Reasonix 运行真实事件。
- CodeBuddy 安装可用后补 state 与 permission-first。
- 观察窗口覆盖 hook start 到 response/exit，记录 observer 自身排除规则。

这是 #694 的关键完成证据；只看任务管理器没有弹窗、只看 hook exit 0、只跑 curl 均不够。

### Slice 7：回归、文档与发布门

- 定向测试通过。
- `npm test` 全量通过。
- `npm run verify:electron` 通过。
- Windows x64 packaged launch + resolver smoke 通过；`verify:electron` 本身不能替代打包产物验证。
- ARM64 需要正式 packaged 真机/CI ABI + resolver smoke 证据。
- 更新 `docs/project/agent-runtime-architecture.md` 的 Windows focus/process metadata 路径。
- 只按真实完成情况更新 #681/#627/#634；B1b 未切流时不能宣称所有 hook-side PowerShell 已消失。
- release note 明确“name-only 五组”和“内层 snapshot PowerShell”，不误导为所有 PowerShell wrapper 均删除。

---

## 8. 预期文件改动

### 8.1 新增

- `src/win-process-ancestry.js`：低层 Windows API / Koffi ancestry。
- `src/server-windows-process-metadata.js`：B1a eligibility、fresh-walk 语义、shadow、timing；仅在性能不达标时再承载受限 cache policy。
- `test/win-process-ancestry.test.js`：FFI fake / ABI shape / error / handle lifecycle。
- `test/server-windows-process-metadata.test.js`：agent matrix、shadow、per-request identity、stale clear、Codex Desktop。
- 一个明确标注 manual/evidence、要求提升权限并在注册成功后才 ready 的 Windows observer/benchmark 脚本；路径在实现时按现有 test/script 规范定案。
- 一个可复用的非管理员 hook spawn recorder preload helper；允许真实/fake HTTP 正常运行，只记录 `execFileSync` 等 process spawn，与现有 offline HTTP blocker 解耦。
- 条件新增 `src/win-local-tcp-owner.js` 及测试：仅当 CodeBuddy §6 选择 TCP owner 方案。

### 8.2 修改

- `hooks/server-config.js`：runtime capability、PID header、local/remote transport guard。
- `src/server.js`：每 server 实例一个 resolver、per-agent mode/generation 写入、route 注入、cleanup。
- `src/server-route-state.js`：shadow/authoritative process metadata orchestration、authoritative Codex SessionStart foreground WT sampling；保持 `codex_user_input` 的 remote/local JSONL 既有边界。
- `src/server-route-permission.js`：Codex permission-first；条件接 CodeBuddy payload/辅助 command/TCP owner，并写 permEntry + session focus metadata。
- `src/state.js`：窄作用域 `replaceProcessMetadata`/clear 合同。
- `hooks/codex-hook.js`
- `hooks/cursor-hook.js`
- `hooks/kiro-hook.js`
- `hooks/codebuddy-hook.js`
- `hooks/reasonix-hook.js`
- 条件修改 `hooks/codebuddy-install.js`：仅当 §6 的辅助 command metadata hook 被真实顺序证明采用；原 HTTP permission hook 仍是唯一决策路径。
- 对应现有 hook/server/state/runtime 测试。
- `docs/project/agent-runtime-architecture.md` 与必要的 known limitations/release note 草稿。

### 8.3 原则上不改

- 五个 installer 既有 outer Windows command shape；CodeBuddy 若采用辅助 metadata hook，只能新增独立无决定 entry，不重写原 HTTP permission entry。
- B1b hook 的 resolver 调用。
- `hooks/shared-process.js` 的 B1b Windows 实现；除非只增加不改变 legacy 语义的共享常量/test seam。
- permission response schema。
- Remote SSH layout/ingress/security协议。

---

## 9. 自动化测试矩阵

### 9.1 FFI / process graph

- parent walk 正常 1..8 层。
- hook PID 不进入 outward pidChain。
- nearest agent、nearest editor、outermost terminal。
- 两层 `Code.exe` 选择外层，复现本机 2420/34836 形态。
- system boundary、parent=0、self-parent、cycle、maxDepth。
- hook query + 恰好第 8 个 outward ancestor 命中，不得 off-by-one。
- process exits before open / between parent and time query。
- access denied / protected process。
- invalid/null handle、`INVALID_HANDLE_VALUE`。
- Win32 failure 后经 Koffi 声明的 `GetLastError()` 采样的诊断码与预期错误一致，覆盖中间 JS 分配/GC 干扰用例；`koffi.errno()` 不得出现在 Win32 错误分类路径；控制流仍以 API return/NTSTATUS 为准。
- 所有成功 handle 在 success/failure/throw 路径关闭一次。
- FILETIME high/low 无精度损失比较。
- parent creation newer than child -> PID reuse fail closed。
- x64/ARM64 pointer-size struct declaration断言。
- Toolhelp 若被选：dwSize、Unicode、ERROR_BAD_LENGTH bounded retry。
- NtQuery 若被选：NTSTATUS、动态 symbol unavailable、ULONG_PTR 对齐。

### 9.2 transport/runtime

- legacy runtime shape -> legacy resolver。
- missing/corrupt/dead owner -> zero snapshot。
- shadow -> old metadata + PID header。
- authoritative B1a -> PID header + old resolver call count 0。
- per-agent mode map：一个 agent authoritative 不影响另一个 agent legacy/shadow。
- instance generation match 才消费 metadata；runtime 原子换主/direct 失败/fallback server 只收业务事件、不收 PID metadata。
- remote / secure remote -> header absent、new resolver 0。
- Windows-node `CODEX_WSL_INTEROP_ARG` -> header absent、new resolver 0；普通 WSL/body effective host boundary同样保持旧跨边界行为。
- invalid PID header：空、负数、小数、指数、超 uint32、多值 header。
- custom HTTP agent/未知 agent 即使伪造 header也不进入 B1a。
- Claude/Copilot/Qwen/custom/statusline 四类反例不 opt-in header。
- runtime write/repair/clear owner guard 保持。

### 9.3 state/session

- first state 成功解析并持久 process metadata。
- 后续每个 eligible event 都使用自己的 hook PID fresh walk，不以 existing PID 活着为由跳过。
- 解析失败 -> stale PID/editor/pidChain 显式清空，不被 `incoming || existing` 留住；`pidReachable=false`。
- Cursor authoritative 失败保留 adapter effective `editor="cursor"`，但不保留 stale walk-derived editor。
- source identity 改变/清空时，没有同请求 fresh HWND 则旧 `wtHwnd` 清空，Orca identity 获得 changed/cleared 信号。
- 两并发 session 不串 metadata。
- 两个 Kiro/default 同 cwd与不同 cwd交错事件都不串 metadata。
- 同 session 两请求不会用较早的迟到结果覆盖较新 identity；若保持同步 main-thread 则证明无异步竞态，若 worker 则使用 generation token。
- shadow mismatch 不改变 user-visible state。
- B1b agent body/behavior byte-for-byte 或字段级兼容。

### 9.4 adapter

- 五个 adapter 各自 expected executable name。
- Codex CLI sourcePid=terminal，Desktop sourcePid=agentPid。
- Codex SessionStart/UserPromptSubmit/PreToolUse/PermissionRequest/PostToolUse/Stop。
- Codex authoritative SessionStart 在 resolver 后由 server 采样 WT HWND；shadow 用独立调用绕过生产 `!wtHwnd` 短路，只比较 server candidate、不改 legacy visible HWND；合法时间差 mismatch 不设 100% parity 门。
- `CodexUserInputRequest` 不进入 B1a：remote HTTP path 被 host boundary 排除，本地 JSONL direct path 保持 writer PID metadata。
- Cursor editor fallback、`cursor_pid` legacy alias 不回归。
- Kiro `default` session 每请求 fresh；同 cwd/不同 cwd并发。
- Reasonix state-only、Stop timer、stdout。
- CodeBuddy state authoritative；direct permission 按 §6 决策结果测试。
- authoritative 测试将 legacy `resolve()` seam 设为 throw，证明没有意外调用。

### 9.5 permission

- Codex permission-first 建 session metadata。
- 已有 session 的新 permission 仍从本请求 hook PID fresh walk。
- 解析失败仍进入 bubble/native no-decision，响应 sanitized。
- DND 不替用户决定。
- timeout/connection close 路径不因 resolver 改变。
- native Codex permission mode 的 `updateSession` 在 resolver 之后取得同一 authoritative metadata，no-decision 行为不变。
- CodeBuddy direct HTTP 不能假装经过 hook helper。
- CodeBuddy 候选 0 先验证 command state 与 HTTP permission 的 raw/fallback identity 经规范化后命中同一 key，且证据不记录原始 session id；验证通过后才覆盖“已有 state session 后再来 permission”的 session-first focus，首个观测事件就是 permission 时仍明确 unavailable。
- CodeBuddy payload/辅助 command/TCP owner 任一增强候选成功后，permEntry focus 字段与窄 scope permission-first persistence 都有测试；其他 generic agent 不产生 ghost session。

### 9.6 mutation / regression guard

- 删除 authoritative guard 应使“legacy resolver must not run”测试失败。
- 恢复 `process.ppid` fallback 应使 unavailable 测试失败。
- 去掉 creation-time 检查应使 PID reuse 测试失败。
- 将 terminal 从 last match 改 first match，应使双 `Code.exe` parity 测试失败。
- remote/WSL/Windows-node interop/instance generation eligibility 任一 guard 被删，应有测试失败。
- 新 resolver 里出现 `child_process` / `powershell.exe` / `Get-CimInstance` 生产依赖时静态断言失败。
- authoritative hook 使用 spawn recorder 正常访问 fake HTTP server，并断言内层 PowerShell/`execFileSync` spawn 为 0；该测试不要求管理员权限。

---

## 10. 真机验证矩阵

| 场景 | B0 shadow | B1a authoritative | 必须证据 |
|---|---:|---:|---|
| Codex + VS Code integrated pwsh | 必须 | 必须 | 四字段 parity、六事件、无 inner PS |
| Codex + Windows Terminal | 必须 | 必须 | source focus、outer/inner 归属、SessionStart 后首 prompt 前 WT HWND 直达聚焦 |
| Codex permission-first | 必须 | 必须 | 首事件建 metadata、权限结果不变 |
| Codex user-input bubble | 不进入 B1a | 不进入 B1a | remote monitor host boundary、本地 JSONL direct writer PID/fallback focus 均不变 |
| Codex 两并发 session | 必须 | 必须 | 不串 PID、observer 有效 |
| Codex Desktop | 可用时必须 | 可用时必须 | preferAgentPid |
| Cursor | 必须 | 必须 | state、editor/focus、无 inner PS |
| Kiro | 必须 | 必须 | 同/不同 cwd并发 default session、每请求独立链、无 inner PS |
| Reasonix | 必须 | 必须 | state-only、无 inner PS |
| CodeBuddy state | 安装后必须 | 安装后必须 | state chain |
| CodeBuddy permission-first | 安装后 release gate | 安装后 release gate | 先证明 state/permission session identity 同 key；候选 0 再精确记录首事件缺口；若声明完整支持，需 payload PID、辅助 command 或 TCP owner 的顺序/归属证明 |
| Clawd offline | 必须 | 必须 | observer 证明 0 inner snapshot |
| Remote SSH | 必须 | 必须 | 本地 resolver 0、路由不变 |
| WSL / Windows-node interop | 必须 | 必须 | argv/header/resolver 均不误当 local Windows |
| x64 | 必须 | 必须 | packaged ABI、性能、handle、resolver load |
| ARM64 | 必须 | 必须 | packaged ABI、性能、handle、resolver load |
| elevated/protected parent | 必须 | 必须 | fail closed、不崩、不改权限 |

Observer 判定必须基于 parent-child：

```text
允许：outer powershell.exe/cmd.exe -> hook node.exe
禁止：hook node.exe -> inner powershell.exe（snapshot）
```

WMI/ETW observer 必须在已验证可订阅的提升测试会话中运行，并把注册成功、canary 成功和 legacy/authoritative 计数同时写入证据；普通自动化只负责 spawn recorder 回归，不能替代这层真机证据。

不得把 Windows Terminal 的共享 `WindowsTerminal.exe` PID 当作测试专属进程，也不得以进程级方式结束它。

---

## 11. 切流、回滚与完成标准

### 11.1 B0 完成标准

- 提升权限 observer 已成功注册并 ready；旧路径 positive control 可重复捕获 inner PowerShell；authoritative 每轮 negative test 前 contemporaneous canary 成功。
- 两个 FFI 候选有同样本对照，单一生产候选有书面 decision。
- ABI、creation-time、handle、错误分类测试齐全。
- shadow 日志 bounded 且不含 payload/cmdline/path/cwd/session id。
- Codex 六事件与至少两个并发 session 的 comparable legacy fresh-success 四字段 100% parity；cache/unavailable/intentional partial 分层报告。
- Cursor/Kiro/Reasonix comparable fresh-success 必测样本 100% parity；raw/effective editor 分开。
- CodeBuddy 已记录为 completed 或明确 blocked，不能模糊处理。
- 性能与 event-loop gate 通过，或 worker 方案重新过同一 gate。

### 11.2 B1a 切流标准

- 对应 agent 的 authoritative runtime capability 默认启用前，自动化和该 agent 真机 gate 通过。
- 五个 hook 的 eligible local Windows 路径 old resolver call count=0。
- 每个 eligible request 使用自己的 entry PID；Kiro/default 不跨事件复用。
- observer 证明 hook Node 的 snapshot PowerShell child=0；外层 wrapper 仍正常。
- state/permission failure 不影响业务协议。
- stale metadata 能清空，不能聚焦旧 PID。
- Codex authoritative SessionStart 在首 prompt 前仍能取得 fresh WT HWND 并直达聚焦；采样失败保持 best-effort、无 PowerShell fallback。
- CodexUserInputRequest 的 remote monitor 与本地 JSONL direct path 未被 B1a 编排改写。
- Remote/WSL/Windows-node interop/B1b 行为未改变。
- CodeBuddy permission-first 未通过时，不能用“五个 adapter 全完成”关闭总目标。

### 11.3 回滚

- 对应 agent 的运行时 `mode=legacy` 是开发/紧急诊断回滚，不删除新模块或改用户 agent 配置。
- 回滚只恢复该 agent hook 对旧 resolver 的调用；不更改 permission contract。
- per-agent shadow/authoritative mode 与 instance generation 必须由 Clawd runtime owner 写入，旧 owner 退出仍遵守现有 owner-guard clear。
- 不通过安全软件检测自动回滚。

### 11.4 最终完成报告必须包含

- 实际选择的 Windows API 与理由。
- x64/ARM64 ABI 验证结果。
- shadow parity 样本数与 mismatch 分类。
- resolver/route p50/p95/p99/max 与 event-loop 数据。
- handle leak 结果。
- 每个 agent 的真实 smoke 状态。
- CodeBuddy permission-first 的最终方案与证据，或明确残余。
- CodeBuddy state/permission session identity 的 presence/fallback/equality 结果；不得包含原始 session id。
- observer positive/negative control 与 inner PowerShell 计数。
- observer 的权限级别、注册/ready 结果，以及非管理员 spawn-recorder 自动化结果。
- Codex SessionStart server HWND 对照的时间差/mismatch 分类与首 prompt 前聚焦结果；不虚报 HWND 数值 100% parity。
- CodexUserInputRequest 保持 B1a scope 外的回归证据。
- B1b 仍保留旧 resolver 的准确说明。

---

## 12. 开工前决策清单

- [x] 子代理已独立审阅，Claude 已完成 v2 与 v3 两轮审阅；主代理按代码、本机 observer 与 Win32 last-error 实测逐条裁决并修订为 v4。
- [ ] 确认 issue #694 的验收是否要求 CodeBuddy direct permission-first 与其余四个同批发布。
- [x] 本机复核未找到 CodeBuddy command/process；在取得真实环境前正式登记为外部 smoke blocker。
- [x] 已使用可 UAC 提升的专属 observer 进程；测试没有启动或终止 Windows Terminal，也没有使用进程级清理。
- [x] Slice 0 observer 注册/ready/canary/legacy positive control 与 authoritative negative control 已完成。
- [x] 用户已授权按计划实施；NtQuery 与 Toolhelp 两候选 spike、x64 benchmark 与 handle gate 已完成。
- [x] shadow log 只保留派生分类字段及经范围校验的 old/new PID/chain，1 MB rotate、每 key 200 样本；不记录 payload/cmdline/path/cwd/session id。
- [x] `docs/project/agent-runtime-architecture.md` 已记录 runtime capability、PID/generation header、fallback 剥离、authoritative replace/clear 与 CodeBuddy 边界。
- [ ] ARM64 真机/CI 资源已安排。
- [x] 实施与审阅完成后才创建独立功能分支；不直接提交或推送 `main`。

---

## 13. 独立审阅记录

### 13.1 子代理首轮审阅

审阅方式：子代理只读检查本计划和相关代码，不编辑文件、不运行测试、不改变本机状态。主代理逐条核对代码后作如下处理：

| 级别 | 发现 | 处理 |
|---|---|---|
| P0 | Kiro 所有实例共用 `default`，通用 session reuse 会串链 | 接受；B1a 首版改为每 eligible request fresh walk，Kiro 永不按 default/cwd 复用 |
| P1 | 通用 HTTP helper 会误给 B1b 带 PID header | 接受；改为五个 adapter 显式 opt-in，并补 B1b/custom 反例 |
| P1 | 全局 mode 无法逐 adapter 回滚，且 fallback port 有多实例 TOCTOU | 接受；改为 per-agent mode map + immutable runtimeObservation + instance generation；fallback 只送业务事件 |
| P1 | Windows-node WSL interop 不会被普通 WSL detector 标记 | 接受；Codex hook 显式排除 `CODEX_WSL_INTEROP_ARG`，不发送 header/不跳过 legacy；server 只能对异常 header 做 expected-agent-name fail closed，不能从 body 独立识别 interop |
| P1 | resolver 必须在 Codex classification 后、WT sampling 前使用 effective metadata | 接受；固定 state/permission route 顺序 |
| P1 | CodeBuddy direct permission 成功后仍缺 permEntry/session 落点 | 接受；补 payload/辅助 command/TCP 三候选及窄 scope persistence/focus 合同 |
| P1 | `replaceProcessMetadata` 未覆盖两套 merge、pidReachable、HWND/Orca | 接受；抽纯函数，normal/transient 共用，失败真实清空 focus identity |
| P1 | `processAlive` 不能证明跨事件 PID identity | 接受；首版不跨事件 reuse；若性能迫使 cache，必须验证 creation identity |
| P1 | hook query + maxDepth 有 off-by-one 风险 | 接受；明确 1 次 hook query + 8 个 outward nodes |
| P1 | stricter partial failure 与 100% parity 表述冲突 | 接受；只要求 comparable fresh-success exact parity，其余分层报告 |
| P2 | ABI、Win32 last-error、handle leak、observer、packaged smoke 细节不足 | 接受；分别补入 FFI、测试、observer 与发布 gate；v4 最终更正为 Koffi 声明的 `GetLastError()` 通道，`koffi.errno()` 明确禁用 |
| P2 | editor raw/effective 与 nearest/outermost 语义混淆 | 接受；修正为 nearest editor、outermost terminal，并分开 raw/effective 报告 |

本轮没有为了迎合审阅而扩大到 B1b，也没有接受任何改变权限决策、删除 outer wrapper 或按安全软件分流的建议。

### 13.2 Claude 二次审阅与主代理裁决

Claude 对 v2 的总体结论为 **Needs revision**。主代理重新读取相关 producer、route、state、focus 与 Koffi 证据，并在本机做一次只读 observer 注册实验后作如下裁决：

| Claude 发现 | 裁决 | 主代理处理 |
|---|---|---|
| Slice 0 observer 缺权限前提 | 接受 | 本机非管理员 `Register-CimIndicationEvent(Win32_ProcessStartTrace)` 实测 Access Denied；改为提升会话注册/ready/canary 三层证据，并增加无需管理员的 spawn-recorder 自动化层 |
| `CodexUserInputRequest` 必须纳入 B1a resolver/replace | 拒绝 | HTTP producer 只有 remote monitor 且总带 host；本地 JSONL monitor 绕过 `/state` 并自带 writer PID；official hook 不生产该事件。将它拉进 B1a 会扩大边界，v3 只加“不进入 B1a”的回归测试 |
| authoritative Codex SessionStart 会失去唯一稳定 hook-side WT HWND | 接受 | 选择在 resolver 后复用现有 server `captureForegroundWindowsTerminal()`；shadow 比较 candidate，authoritative 供给 session，并增加首 prompt 前聚焦真机 gate |
| `SYSTEM_PROCESS_NAMES` 名称与 boundary 顺序不准确 | 接受 | 更正为 `SYSTEM_BOUNDARY_WIN`，明确 boundary 先进入 pidChain、再 break，且不更新 terminal/lastGood |
| Cursor 常量 editor clear、permission 性能 gate、eligibility 双开 handle、native permission updateSession 漏项 | 接受 | 分别补 adapter effective editor 规则、`/permission` pre-wait p99、单次 hook identity observation、native mode 测试 |
| Win32 error 应只作诊断 | 接受但 v3 的 API 名称错误、已在 v4 修正 | 当前 Koffi `2.16.3` 以 TEB `LastErrorValue` 保存/恢复机制保护通过 Koffi 声明的 `GetLastError()`；`koffi.errno()` 是 CRT/POSIX errno，不适用；仍要求 spike 实测，控制流依据 return/NTSTATUS |
| CodeBuddy 可先沿用 existing session focus | 接受为候选 0 baseline | 先以真机证明 state/permission identity 同 key；通过后覆盖“先 state 后 permission”，不解决“permission 是首个观测事件”；只有增强候选通过才能宣称完整 permission-first |

修订后仍不扩大到 B1b，不改变任何权限决定协议，也不把 remote/local JSONL `CodexUserInputRequest` 错纳入 hook PID transport。

### 13.3 Claude 对 v3 的最终复核与 v4 修正

Claude 对 v3 的结论为 **Needs revision（1 个 P1）**，并明确撤回 v2 中要求把 `CodexUserInputRequest` 纳入 B1a 的错误判断。主代理逐项复核依赖源码与 route/session/focus 路径，并运行一次无写入 Win32 FFI 实测后确认：唯一 P1 与三个 P2 均成立。

| 级别 | 发现 | v4 处理 |
|---|---|---|
| P1 | v3 错把 `koffi.errno()` 当成 Win32 last-error 通道 | 接受；Koffi 文档/源码证明它是 CRT errno。改为通过 Koffi 声明 `kernel32!GetLastError()`，并禁止 `koffi.errno()` 进入 Win32 分类路径 |
| P1 实测 | `OpenProcess(PID 0)` 失败后插入 JS 分配/GC，`GetLastError()` 仍为 87，而预设 `koffi.errno()` 仍为 123 | 记录为 B0 spike 的已知正证据；正式实现仍保留同类 x64/ARM64/package gate |
| P2 | shadow SessionStart 会被现有生产 `!wtHwnd` gate 拦住 | 接受；规定独立诊断采样绕过该短路，且不改变 visible legacy HWND |
| P2 | hook/server HWND 采样存在合法时间差 | 接受；mismatch 分类但不设数值 100% parity，以首 prompt 前真实聚焦为 gate |
| P2 | CodeBuddy 候选 0 隐含两路 session identity 同 key 前提 | 接受；加入 presence/fallback/equality 真机 gate，仅记录 boolean 或单次加盐哈希，不落原始 session id |

完成这些修正后，计划不再保留 Claude 指出的开工阻断项；下一阶段按 §12 前置资源与 Slice 0 真机 positive control 开始，不再继续无边界循环审稿。

### 13.4 子代理对 Implementation v2 的审阅与修正

子代理对完整工作区 diff（不只最近补丁）给出 **Needs revision：0 P0 / 4 P1**。主代理逐条复核后全部接受，并同时处理其 P2 测试/文档建议：

| 级别 | 发现 | 处理 |
|---|---|---|
| P1 | Codex `/permission` shadow 强制把 legacy editor 记为 null | `buildCodexPermissionSessionOptions()` 增加 `code|cursor` allowlist；comparison 使用 legacy effective editor，并补非法 editor 反例 |
| P1 | 无法把 agent 命中后的 stricter partial 与 agent 前失败分层 | resolver 输出 bounded `comparisonClass`、`agentSeenBeforeFailure`、`failureStage`、`errorKind`，route/logger 白名单传递并补两类测试 |
| P1 | ABI 只报告 size，不按 size/offset fail closed，也未检查 Nt return length | 对 pointer-size 对应的 PBI/FILETIME/PROCESSENTRY32W size 与关键 offset 做启动断言；不匹配时 `available=false`；成功 NT call 要求 `ReturnLength` 精确匹配 |
| P1 | Toolhelp 把任何 `Process32NextW=false` 当正常 EOF | 仅接受 `ERROR_NO_MORE_FILES(18)`；其他错误关闭 snapshot、丢弃 partial map、返回 unavailable |
| P2 | Kiro default/cwd 与 Codex auto-start mode transition 缺交错测试 | 补 Kiro A/B/A 三个 hook PID fresh resolve；补首次 runtime offline/legacy、auto-start 后 authoritative 且 retry 零 legacy resolve |
| P2 | fallback `debugLog` 绕过专用 logger sanitizer | state/permission fallback 在输出前统一走 `sanitizeShadowRecord()` |
| P2 | 架构文档未记录新 capability | 已补 `docs/project/agent-runtime-architecture.md` 专节 |

该轮修订后 targeted 235/235、全量 7,198 total / 7,167 pass / 0 fail / 31 skip、Electron verification 均通过；随后完成的二次复核与真机 evidence 见 §13.5-§13.6。

### 13.5 子代理二次复核

同一子代理在上述四个 P1 与 P2 回归补齐后重新审阅完整 diff，结论为 **Ready：0 P0 / 0 P1**。它逐项确认 terminal 优先语义、production `INVALID_HANDLE_VALUE`、默认 legacy、single runtime observation、permission editor parity、partial 分类、ABI/ReturnLength fail-closed 和 Toolhelp EOF 判定均已闭环。

剩余仅有两个非阻塞实现备注：默认 Nt FFI factory 没有做进程内重复构造缓存（生产启动只构造一次）；`NtQueryInformationProcess` 没有显式写 x86 `__stdcall`（当前发布 gate 是 x64/ARM64）。两项不阻止本轮 x64 evidence，但在未来支持/测试 x86 或把 factory 变成可重入公共入口前应处理。审阅指出的 headless header 架构文档措辞也已更正为“hook 可发送、server effective eligibility 决定是否消费”。

### 13.6 x64 真机证据

- ABI/FFI：本机 `process.arch=x64`；PBI、FILETIME 与 PROCESSENTRY32W 的 size/offset 断言通过，NtQuery 与 Toolhelp 均能解析当前真实 Node 父进程；失败路径的 truthy Koffi External `INVALID_HANDLE_VALUE` 经 `koffi.address()` 正确识别。
- parity 反例：带 terminal 外层非 terminal 祖先的对照链由旧 `sourcePid=106` / 新 `sourcePid=108` 修正为两边均为 106，输出 `PARITY OK`。
- 性能/handle：NtQuery 500 次 p99 2.492 ms，Toolhelp 100 次 p99 12.444 ms；测试前、NtQuery 后、Toolhelp 后 process handle count 都是 174。
- observer：提升会话在 `2026-08-09T06:41:58Z` 写出 ready（observer PID 16760）并捕获 canary PID 6112；legacy 窗口捕获 `powershell.exe` PID 31804（父 Node PID 27392）；authoritative 六 adapter 测试 6/6 通过且该窗口没有 PowerShell 记录。证据文件为 `C:\Users\Ruller\AppData\Local\Temp\clawd-694-observer-10adf420fe9644fc997384f85cf6cb41.jsonl`。
- Codex shadow `/state`：真实 hook PID 31132；legacy/candidate 的 `sourcePid=34836`、`agentPid=32980`、editor=`code` 和完整 pidChain 完全相等，所有 comparison boolean 为 true。
- Codex authoritative `/state`：真实 hook PID 34088；body 自有 process 字段为空，candidate `status=ok`、`sourcePid=34836`、`agentPid=32980`、editor=`code`。
- Codex authoritative `/permission`：真实 hook PID 32004；body 自有 process 字段为空，candidate `status=ok`、`sourcePid=34836`、`agentPid=32980`、editor=`code`；hook stdout 为 `{}`、exit 0，未改变权限决定协议。

上述 Codex smoke 使用临时 HOME、临时 runtime 和只接收本轮请求的本地 server；结束后只清理已校验位于系统临时目录下的测试 HOME。没有修改用户的 hook/config、没有启动模型请求、没有重启 Clawd，也没有启动或终止 Windows Terminal。它证明当前 x64 进程链和 transport 合同可工作；当时尚缺的 Codex 并发 session 与 GUI focus 后续已由 §13.7 补齐，ARM64 和其他真实 agent 仍是外部 gate。

### 13.7 PR #837 真实 Electron / 双 Codex GUI 验证

在 PR 分支开发版上先以 `CLAWD_WINDOWS_PROCESS_CHAIN_CODEX=shadow` 启动真实 Electron app，再正常从托盘退出并以 `b1a-authoritative` 重启；全程保留用户的 VS Code/Codex 进程，不使用进程级终止：

- shadow runtime 正确公告 generation 与 Codex-only `shadow`，其余四 agent 保持 `legacy`。沙箱外 fresh `SessionStart` old/new 完全一致：`sourcePid=34836`、`agentPid=32980`、`editor=code`、pidChain=`25592>32980>28264>26456>2420>34836>12124`，resolver duration 1 ms。cache-only `PreToolUse/PostToolUse` 的 legacy body 本来不带 pidChain，按 non-comparable cache 样本分层，其他三字段一致。
- authoritative runtime 正确公告独立 generation 与 Codex-only `b1a-authoritative`。真实 state 持续落为 `agentPid=32980`、`sourcePid=34836`、`pidReachable=1`；真实 `/permission` 命中、创建审批并成功返回 allow，未改变权限协议。app stderr 为空。
- 提升 observer 文件 `C:\Users\Ruller\AppData\Local\Temp\clawd-694-authoritative-observer-019ba76cbf7e4c98a3e2d2eb9856b94e.jsonl` 在 ready/canary 后覆盖多次真实 hook 事件；只看见 Codex 工具执行的 outer `pwsh.exe`（父进程为 `codex` 或已退出的 harness），没有任何父进程为 Node 的 inner snapshot PowerShell。
- 现有会话 HUD 点击由 Windows focus helper 返回 `editor-parent-title-match / confirmed`，用户确认回到正确 VS Code terminal。
- 第二个 Codex PID 28700 与旧会话 PID 32980 同时存活并共享 `Code.exe` PID 34836。新进程在首个输入前没有 producer hook，故不会预先出现 session；发送首个最小 prompt 后创建独立 session，权威链为 `3452>28700>35928>23420>2420>34836>12124`。HUD 在约 2 秒内先聚焦旧 session、再聚焦新 session，第二次同样返回 confirmed；用户确认精确切换到新 integrated-terminal tab，并特别确认该场景在旧实现中长期失败。

该轮把 Codex x64 多事件、两个并发 session、真实 Electron event loop 与 VS Code GUI focus 从待办改为已完成。仍不外推到 Windows Terminal HWND、ARM64、Cursor/Kiro/Reasonix 或 CodeBuddy permission-first；默认 mode 继续是 `legacy`。
