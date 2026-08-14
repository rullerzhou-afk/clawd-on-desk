# Plan: 修复 PR #876 — DeepSeek Harness 集成

Status: implementation and non-API Windows smoke complete; API-backed session/approval smoke pending

Created: 2026-08-14

Base: `main@719e3432c80d5b9129b08aa6dbe0138b9ddc5a00`

Reviewed PR head: `origin/pr-876@9100d15448ddafccc3c583ff0ab79217e24920e8`

Review: revised after independent subagent review and external Claude source audit on 2026-08-14

Related: [PR #876](https://github.com/rullerzhou-afk/clawd-on-desk/pull/876), [issue #815](https://github.com/rullerzhou-afk/clawd-on-desk/issues/815)

## 1. 结论先行

PR #876 不应按当前形态直接合并，但适合现在马上修，因为 DeepSeek
Harness（下文简称 DSH）的公开集成 seam 已经足以支持第一版。

首发采用 **plugin-only** 架构：

| 能力 | 首发路径 | 原生回退 | 结论 |
| --- | --- | --- | --- |
| 状态感知 | DSH 官方 in-process plugin 监听公开 session 事件并 POST `/state` | plugin 不可用时不影响 DSH；Clawd 不伪造状态 | 支持 |
| 普通工具审批 | plugin 在公开 `approval/request` waterfall 中等待 Clawd `/permission` | handler 调 `next()`，交还 DSH web UI / 下游 listener | 支持 |
| `ask_user_question` | DSH 原生 provider | DSH 原生 UI | 首发不接管 |
| DSH 未安装 / 未启用集成 | 不写 DSH 配置 | 无 | fail open，不影响 DSH |

这里的关键判断是：

- **部署形态更像 opencode**：代码运行在 agent 的官方 plugin 进程内。
- **Clawd 的 blocking permission adapter 最接近 Hermes**：DSH 的 callback 自身
  可等待，plugin 可以在同一调用链里等待 allow / deny / no-decision；原生 fallback
  的控制流又与 Claude / Codex 的阻塞 hook 相近。
- **不复制 opencode reverse bridge**：opencode 使用反向 bridge，是因为
  `permission.asked` 只是 fire-and-forget event，Clawd 必须另行调用 opencode
  REST API 回答。DSH 已公开 `approval/request` waterfall，额外反向通道只会
  增加重复决定、孤儿 bubble 和竞态。
- **不复制 #876 的私有 provider takeover**：当前 DSH `UserQuestionService`
  只有公开的 `registerProvider()`，没有公开 provider middleware / chaining API。
  #876 直接读取并写入私有 `service.provider`，还用未被 disposer 管理的递归
  `setTimeout` 等待原 provider。这不是可发布的兼容层。
- **projection monitor 不进入首发**：它读取上游非公开 storage，会引入双源抢占、
  去重、staleness 和乱序问题。只有真实 plugin 丢事件证据出现后，才在独立 PR
  评估 fallback。

首发只支持 DSH `web` profile。其他 profile 必须先完成真实 spike，再声明支持。

## 2. 已核对的上游事实

本计划在 2026-08-14 先对照 DSH 官方仓库
[`master@47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)
冻结公开 seam，再逐文件复核实际 npm 发布物
`@deepseek-ai/dsh@0.1.0-rc.6`（integrity
`sha512-brpZfED7ieRa2PQ5tUxMhHrM1pb2CmKFVM/f6yMULBDMicahk+Z2OsHgTwTDnoiZm23Ftu9rQz0NN4pflaoJcg==`）
及其内嵌 rc.6 packages。npm registry 没有 `0.1.0-rc.5`，且 rc.6 发布物未携带
`gitHead`；因此 `47f9438` 只作为源码调查基线，本文不声称它是 rc.6 的 tag/commit
映射。rc.6 编译产物确认下列 contract 仍成立：

- DSH 仍标为 developer preview，上游明确保留 breaking changes 的可能。
- 官方安装入口为 `dsh plugin --profile <name> add <package-or-path>`。
- [`dsh plugin`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/src/plugin.ts)
  是 thin pnpm forwarder：profile 不存在时会先初始化，再在 profile 目录运行
  `pnpm <args>` 并 reconcile bundle layers。因此 pnpm 是 interactive bridge 安装的
  真实前置条件，local path 最终是 link 还是 snapshot 也取决于 pnpm spec 语义。
- [`ApprovalService`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/interaction/user-approval/src/index.ts)
  公开 `approval/request` waterfall；listener 可以返回决定，也可以调用 `next()`
  委托给后续 listener。web profile 的
  [`api-proxy`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/host/apiproxy/src/api-proxy.ts)
  会注册原生浏览器 answerer。
  当前唯一 grant 是一次性的 `allowed-once`；`policy="never"` 会在 listener dispatch
  前直接 reject，Clawd 不得绕过它。
- [`UserQuestionService`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/interaction/user-questions/src/index.ts)
  公开 `registerProvider(provider)` 和 disposer，但当前只持有单一 provider；没有
  公开“包裹现有 provider 后再 fallback”的 API。
- [`session/event`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/index.ts)
  是公开、observe-only、per-listener contained 的 emit firehose；constructor seed
  不会重放到该事件，因此恢复中的旧 session 只能使用经验证的公开 snapshot；没有
  公开 snapshot 时，Clawd 从下一条 live event 开始感知，不能偷偷读取私有 service。
- `session/created` 与其他 observer 的失败边界不同：listener 同步抛错会 veto 并
  回滚 session 创建；`session/event` 和 `session/disposed` 的 listener 异常才是
  per-listener contained。公开 `session.seq` getter 表示“下一条事件序号”，不是
  最近一条已提交事件的序号。
- DSH 同时维护 `storage-json` 与 `storage-sqlite` 后端；projection 的文件形态本身
  是 profile 配置面，不是首发 adapter 可以依赖的稳定协议。
- profile package resolution 有 DSH installation 与 profile 两个官方 anchor；
  `$DSH_HOME/profiles/node_modules` 的 flat fallback 由 DSH 用自身应用依赖闭包维护，
  不是 Clawd-managed external plugin 目录，Clawd verifier 只能读取解析结果，不能
  接管、修复或删除该 fallback。
- DSH projection checkpoint 当前包含 `openStep`、`pendingCalls`、session list
  metadata 等字段，但它不是稳定的实时事件 API，首发不依赖它。
- rc.6 的 home-level `$DSH_HOME/cordis.patch.yml` user layer 优先于 profile layer；
  因而 profile rows 和 package resolution 只能证明 disk health，不能证明运行时最终
  activation。Install、Repair 与 Doctor 必须保留 restart 提示和 disk-only 边界。

这些只是本计划的调查快照，不构成永久兼容承诺。实现必须记录并测试一个明确的
DSH 支持版本区间；不能把“当前 master 可用”当成无版本上限的 contract。

## 3. #876 当前的合并阻断项

### P0 — 必须在合并前修复

1. **Clawd 端口被写死为 23333**

   `hooks/dsh-clawd-bridge/lib/index.js` 使用
   `http://127.0.0.1:23333`。Clawd 实际端口范围是 23333–23337，权威入口是
   `~/.clawd/runtime.json`。第二个 Clawd 实例或 23333 被占用时，bridge 会静默
   失效。

2. **打包后的 bridge 源路径不可由外部 DSH 稳定加载**

   `hooks/dsh-install.js` 直接使用
   `path.join(__dirname, "dsh-clawd-bridge")`。Electron 打包后需要先解析到
   `app.asar.unpacked`；更重要的是，DSH / pnpm 不应长期依赖一个会随 NSIS、
   AppImage mount 或应用更新变化的安装目录。

3. **Settings Install 会把 bridge 失败误报为成功**

   `syncDeepSeekHarnessMonitor()` 调用 `installDeepSeekHarnessBridge()` 后丢弃其
   返回值，再用“发现 DSH 数据目录成功”完成安装事务。因此 bridge 没装上时，
   `integrationInstalled=true` 仍可能被提交。

4. **`ask_user_question` 修改 DSH 私有字段**

   bridge 直接读写 `ctx.userQuestions.provider`，并使用无法取消的递归 timer。
   这会受到 bundle 激活顺序、上游字段重命名、重复 apply 和 unload 竞态影响。
   首发必须删除这条 takeover 路径。

5. **projection monitor 不适合作为首发 source**

   它读取上游非公开 projection storage，并且当前实现会把 malformed JSON 当成
   空 workspace、把全部 session 错发成 `SessionEnd`；全局文件 mtime 还会让一个
   活跃 session 给另一个陈旧 session 的 `working` 续命。首发从 #876 中移除该
   monitor，而不是把它变成 plugin 的第二个并发 source。

6. **权限自动化资格未经审计即打开**

   #876 把 `deepseek-harness` 直接加入 `KNOWN_PERMISSION_AGENTS`，并让
   `ask_user_question` 进入 auto-answer，但没有补齐 policy contract tests。
   registry capability 不能自动推导 automation eligibility。首发的 DSH 请求
   默认只允许人工决定；auto-tools / unattended / per-session automation 在真实
   tool taxonomy 和 no-decision 行为验证前必须 defer。

7. **缺少真实 DSH 和 packaged app 验证**

   当前新增测试主要验证本地 helper，并没有证明真实 Cordis lifecycle、真实
   waterfall ordering、真实 `dsh plugin add/remove`，也没有证明 NSIS 解包后的
   bridge 可被外部 Node / pnpm 加载。PR 当前也没有 CI check 结果。

8. **把“从 session log 反查 tool arguments”当成了 approval contract**

   DSH 官方 `ApprovalRequest` 明确只承诺 `agent`、`toolName`、可选 `callId`、
   可选 `reason` 和 signal，不携带 tool arguments。官方 web answerer 确实会倒序
   扫描同一 approval 包自己定义的 `approval/asked` 审计事件；#876 扫描的却是跨包
   `tool/call.data.arguments` 内部 shape，缺少同等级上游承诺。首发 bubble 应以官方
   ApprovalRequest 字段为 contract；除非 Phase 0 找到公开、有界、被上游承诺的
   call lookup，否则不要把跨包 session log reconstruction 设为必需路径。

9. **DSH 不能落入 Claude / CodeBuddy shared permission branch**

    共享分支包含 `PASSTHROUGH_TOOLS`、headless 处理、Claude suggestion / response
    shape 和 Go to Terminal -> deny 等历史语义。DSH 若复用它，可能在未审计时
    auto-allow，或把本应 `next()` 的 native fallback 变成 deny。#876 现状里部分
    Claude-shaped allow / deny 因 bridge 只识别 `{ decision }` 而碰巧退化成
    `next()`；这只是响应 shape 不匹配的偶然，Clawd 审计与 DSH 实际结果已经不一致。
    DSH 必须在共享分支之前进入独立 blocking adapter。

10. **Uninstall 在 ownership 检查前就按包名 remove**

    同名 dependency 可能已经指向用户自己的 package/path。必须先验证 dependency、
    bundle row、resolved target 和 Clawd marker；foreign / conflicting 时绝不能调用
    官方 remove。删完再验证已经太迟。

11. **Repair 通道没有实现文档承诺的 bridge repair**

    #876 只在 `options.automatic === false` 时安装 bridge，但现有
    `repairAgentIntegration()` 没有传这个标志，因此 Settings / Doctor Repair 实际只
    做 detection。重做时必须给 Install、explicit Repair、automatic startup sync
    明确的 operation mode，不能靠一个含义模糊的 boolean 决定是否 mutation。

### P1 — 首发应一起修复

- `postToClawd()` 必须校验 HTTP status、限制响应体大小、校验
  `x-clawd-server: clawd-on-desk`，并在成功、失败、超时和 abort 后移除 listener。
- host 安装检测和 Clawd bridge 健康检测必须分开。仅发现 `~/.dsh` 不能作为
  `clawdIntegration=true`。
- `agents/deepseek-harness.js` 的注释和 capability 互相矛盾：文字写 state-only，
  配置却打开 permission。实现完成后必须以真实首发能力统一文档。
- bridge 必须 namespace session ID，例如 `deepseek-harness:<raw-id>`，并限制 ID、
  title、cwd、tool input 和 response body 的大小。
- 安装、卸载、About cleanup、Doctor Fix 共用 marker-scoped ownership verifier；
  Settings Uninstall 保持事务语义，About cleanup 保持项目现有 best-effort 语义。
- Settings Uninstall 的 cleaner 失败必须返回 `{ status: "error" }`；#876 当前的
  `{ removed: false, reason: "bridge-remove-failed" }` 会被现有事务误当成成功并提交
  uninstalled prefs。cleanup-integrations 的注释也必须与其真实外部 remove mutation
  一致，不能写成“只改 prefs”。

## 4. 目标运行时架构

```text
DSH web profile
  └─ Clawd-managed DSH plugin
       ├─ public session events ───────────> POST /state
       └─ public approval/request waterfall
              ├─ Clawd returns allow/deny -> DSH decision
              └─ no decision/error/abort -> next() -> DSH native answerer

Clawd Electron
  ├─ per-session ordered state ingress
  └─ independent DSH blocking permission adapter
```

### 4.1 状态顺序与 lifecycle fence

`session/event` 是 emit firehose，DSH 不等待 listener 返回的 Promise。bridge 不能
无序并发 POST，否则迟到的 `PreToolUse` 可能覆盖 `Stop` / `SessionEnd`。

首发必须选择并验证一种顺序 contract：

1. 首选 plugin 内 per-session FIFO sender；不同 session 可以并行，同一 session
   严格按 DSH event seq 发送。
2. queue 有固定上限和合并规则：不得丢 `SessionStart`、failure、`Stop`、
   `SessionEnd`；高频同态工作事件可以按明确规则折叠。
3. 真正的 `session/event` payload 带持久 `SessionEvent.seq` 作为 `event_seq`；Clawd
   记录 last accepted event seq，拒绝 stale / duplicate event，作为网络重试和
   disposer race 的第二道 fence。`session/created` / `session/disposed` callback 没有
   event，改带公开 `session.seq` 作为 **exclusive `session_seq` watermark**；不能把它
   冒充已消费的 `event_seq`。例如 created 时 watermark 为 `k`，第一条 live event 的
   `event_seq === k` 必须可接受；disposed 时 watermark 为 `n`，它关闭该 lifecycle，
   丢弃其后的 late callback。比较规则必须由 fixture 单测冻结。
4. plugin unload / re-apply 使用 generation token；旧 generation 的 queued event
   和 late callback 不得继续 POST。该 token 是 plugin lifecycle fence，不替代 DSH
   持久 seq，也不作为每次 apply 后从 1 开始的伪事件序号。
5. session dispose 后的 late tool result 必须被丢弃，不能把已结束 session 复活。
6. `session/created` listener 必须是整体 try/catch 的 non-throwing observer：同步异常
   会 veto 并回滚 DSH session 创建，不能依赖上游 containment。任何
   `session/created` / `session/event` / `session/disposed` 观察回调内也不得同步调用
   `session.append()`；append publication 重入会在上游直接抛错。

如果真实 DSH spike 能从公开 session service 在 plugin apply 时枚举 live session，
可以发送一次有界 activation snapshot；它同样携带 exclusive `session_seq` watermark，
复用 created 的比较规则，不发明第二套 snapshot seq。若没有公开枚举 API，Clawd
从下一条 live event 开始感知；首发不访问 private storage / service 补历史。

### 4.2 公开事件映射

Phase 0 必须用真实 DSH 采样确定 payload 后再冻结映射。计划中的候选映射为：

| DSH public event | Clawd event | State | 备注 |
| --- | --- | --- | --- |
| session create / attach | `SessionStart` | `idle` | 只发一次 |
| human user message / turn start | `UserPromptSubmit` | `thinking` | 不转发 prompt 文本 |
| tool call start | `PreToolUse` | `working` | 只保留工具名和有界参数摘要 |
| tool result success | `PostToolUse` | `working` | 不转发完整 stdout/result |
| tool result failure | `PostToolUseFailure` | `error` | 只传 error-present / 分类 |
| turn end success | `Stop` | `attention` | 验证 turn/end 是否每轮触发 |
| turn end failure | `StopFailure` | `error` | 需真实 fixture |
| session dispose | `SessionEnd` | `sleeping` | 对照 opencode 的 lifecycle close 惯例；另行验证 archive 是否等价 |

不允许仅凭 TypeScript 类型名猜事件。Spike 必须保存脱敏 fixture，并写入 adapter
contract test。

### 4.3 Approval 决策链

plugin 只使用公开的 `approval/request`：

1. 用 `{ prepend: true }` 注册 Clawd listener。
2. 把 `toolName`、`callId`、`reason` 和 session ID 转成 `POST /permission`。
   首发默认不扫描完整 session log 补 tool arguments；若 Phase 0 验证公开的有界
   lookup，才把参数摘要作为可选展示增强，查不到不影响决策。
3. 等待 Clawd 返回：
   - `allow` -> DSH `allowed-once`（不提供 Always / persisted rule）
   - `deny` -> DSH `rejected`
   - adapter-specific HTTP 204 -> `next()`
   - invalid response / Clawd unreachable -> `next()`
   - DSH abort signal -> 取消 HTTP 请求并返回 DSH cancellation contract
4. handler 的所有异常都必须被 containment 后显式转为 `next()`；不能 throw 后依赖
   DSH containment，因为 throwing listener 会直接得到 `unavailable`，不会继续
   downstream answerer。
5. 下游没有 answerer时，由 DSH 自己按其 policy fail closed；Clawd 不伪造 allow。
6. DSH `policy="never"` 在 waterfall 之前就返回 `rejected`，Clawd 不显示 bubble，
   也不修改该 policy。

`deepseek-harness` 必须在 Claude / CodeBuddy shared branch 之前进入独立 blocking
adapter，结构上参考 Hermes branch。DSH 不经过：

- `PASSTHROUGH_TOOLS`
- headless auto-deny / auto-allow
- Claude permission suggestions
- Claude response serializer
- Go to Terminal

automation policy 必须写成独立、可审计的 DSH contract，而不是复用“known Claude-
compatible permission agent”默认值：

- 不把 `deepseek-harness` 加入 `KNOWN_PERMISSION_AGENTS`，也不走
  `isTrustedClaudeCompatibleToolApproval()` 对非 Claude / Qwen 的 default-true 路径；
- 普通且字段完整的 DSH approval 由专属分支分类为
  `TOOL_APPROVAL { allowDeny: true, nativeFallback: true }`，但 `autoTools=false`、
  `unattended=false`；这样人工 bubble / remote card 可操作，所有自动化仍 DEFER；
- defense-in-depth 地把 DSH `ask_user_question` 分类为
  `HUMAN_QUESTION { nativeFallback: true, answerQuestions: false }`，即使未来误送到
  `/permission` 也不能 auto-answer；
- `session-automation-identity.js` 首发不把 DSH 设为 eligible adapter。per-session
  grant 最终也必须经过同一 interaction eligibility，因此不能绕过上述 DEFER。

Go to Terminal 在 DSH 首发 bubble 中直接隐藏，避免任何 deny / no-decision 歧义。

本地 bubble、Telegram、飞书 / Lark 仍遵守现有并行决策语义，但 gate 要分开：

- DSH agent 的 `permissionsEnabled=false`：本地和远程都不介入，立即 204。
- DND、agent disabled、app shutdown：不产生任何 Clawd 决定，立即 204。
- 仅关闭本地 bubble：远程 channel 仍可回答；只有所有可用 remote client 都无决定
  时才返回 204。
- bubble 创建失败、auto-close、remote-only 全部无决定：返回 204。

DSH 分支的可控 no-decision 显式返回带 Clawd server header 的 204，而不是借
`res.destroy()` 表达；后者只保留给已有依赖断连语义的 adapter。网络断连仍被
bridge 当作 no-decision 兜底并调用 `next()`。

隐藏桌宠不是 DND；隐藏期间的新 approval 仍可弹 bubble，保持项目现有语义。

### 4.4 首发不接管 `ask_user_question`

首发必须满足以下条件才可重新打开这项工作：

- DSH 提供公开的 provider middleware / replace-with-fallback API，或公开支持
  多 provider chain；
- disposer 可以精确恢复原状态，重复 apply/unload 无泄漏 timer；
- question ID、顺序、duplicate text、single-select、multi-select、custom answer、
  abort 和 native fallback 都有真实测试；
- 支持 `intent`（包括 `plan-review`）的呈现，并验证 `intent.approve` 必须命中自身
  options、`detail` 必填等上游校验语义；
- Clawd 的回答按 DSH question `id` 回传，不能只依赖 question text；
- automation policy 单独审计，不因普通 tool approval 已支持而自动打开回答资格。

在此之前，`ask_user_question` 完整留给 DSH 原生 UI；Clawd 不注册、改写或声称
观察这条尚未确认有公开 observer seam 的交互。#876 已使用的 answer vocabulary
`{ id, selected: string[], custom? }` 与当前官方类型一致，作为 deferred mapping 知识
留档；它不构成首发接管 provider 的理由。

## 5. 传输与安全 contract

### 5.1 动态端口发现

DSH plugin 安装包必须自包含一个小型 Clawd client，行为与
`hooks/server-config.js` 的本地 contract 一致：

- 先读 `~/.clawd/runtime.json`，要求 `app === "clawd-on-desk"` 且 port 在
  23333–23337；
- runtime 文件缺失或目标不可达时，才有界扫描 23333–23337；
- probe / response 必须验证 `x-clawd-server: clawd-on-desk`；
- state POST 使用短 timeout，permission POST 使用人类操作级长 timeout；
- 连接失败后有短 cooldown，避免每个流式事件都扫描五个端口；
- runtime 文件变化或首选端口失败时清缓存并重新发现；
- 只允许 loopback，配置不能把 Clawd permission payload 发往任意远端 URL。

bridge 运行在 DSH 的安装目录之外，不能在运行时 import Electron `app.asar` 内的
模块。安装包可复制经过测试的 helper，或把相同逻辑抽成能被两边物理打包的纯
Node 文件；无论哪种方式，都要用 shared contract test 防止协议漂移。

### 5.2 Payload 最小化

允许发送：

- `agent_id`, `hook_source`, canonical `session_id`
- `state`, `event`, `cwd`, bounded title
- `tool_name`, `tool_use_id`, bounded reason
- 只有真实上游 contract 支持时才发送 bounded / truncated tool input；默认不从完整
  session log 重建
- `agent_pid`；只有真实验证后的稳定 terminal PID 才可作为 `source_pid`

禁止发送完整 prompt、assistant output、reasoning、tool result、conversation history、
环境变量或 DSH credential/config。任何日志默认不得记录完整 permission payload。

## 6. 安装、同步和卸载事务

### 6.1 稳定的 managed bundle

应用内源文件先通过 `asarUnpackedPath()` 定位，再复制到 immutable generation：

```text
~/.clawd/integrations/deepseek-harness/
  homes/
    <canonical-dsh-home-hash>/
      generations/
        <bundle-hash>/
          package.json
          cordis.patch.yml
          lib/index.js
          clawd-manifest.json
```

namespace 必须由 real-or-resolved canonical `DSH_HOME` 稳定派生；多个 DSH_HOME
不得共享可删除 generation、mutation lock 或 inspection latch。显式 alternate-home
cleanup 只进入目标 home 的 namespace。

`clawd-manifest.json` 至少记录：

- owner marker 和 schema version
- Clawd bridge protocol version
- source Clawd version / bundle hash
- supported DSH version range
- installed timestamp

更新先写 sibling staging directory，完整校验后 rename 为新的 hash generation；
不得覆盖一个 DSH / pnpm 可能仍在读取的固定 `current/` 非空目录。官方 add 指向完整
generation；验证 profile 已切换后，才清理未被引用且 marker 正确的旧 generation。

随后调用官方：

```text
dsh plugin --profile web add <managed-generation>
```

不得直接编辑 DSH profile 的 `package.json`、bundle rows 或 pnpm files。
安装后必须按 DSH 官方的 installation-first、profile-second 两级 anchor 做一次真实
package resolution，记录最终命中的路径和 package marker。Clawd external plugin 预期
命中 profile-local dependency；若同名 installation dependency 抢先命中，按 foreign /
conflicting fail closed。`$DSH_HOME/profiles/node_modules` flat fallback 属于 DSH 应用
dependency closure，Clawd 只读检查解析结果，绝不写入、清理或据此认领 ownership。

startup、Settings、Doctor 和 About cleanup 的 DSH profile mutation 必须经过同一个
进程内 queue，并用跨进程 lock 或等价 fencing 防止两个 Clawd 实例/版本同时运行
pnpm。所有复制、hash、CLI 和 manifest I/O 使用异步实现；不得用 `execFileSync`
阻塞 Electron main/startup。

lock 只解决同时写，不能解决两个版本依次互相“修复”。每次 automatic mutation 都
必须在锁内重读 profile / marker 并做版本仲裁：

- 不得用旧 Clawd 自动降级健康的较新 bridge generation；
- 当前 Clawd 比已安装 generation 新时，才允许按明确的 compatible upgrade 规则同步；
- 同版本异 hash、owner/source 不一致或无法比较版本时 fail closed，交给显式
  Settings / Doctor，不得来回切换；
- mutation 完成前再次核对 lock ownership 与目标 generation，结果未知不盲目重放。

### 6.2 CLI discovery

- Windows 优先解析实际 `dsh` npm shim / bin entry，但不能假定只存在 global npm
  layout。
- POSIX 允许用受控 login shell 做 `command -v dsh`，并保持参数数组执行。
- 不因找不到 global `dsh` 就自动运行 `npx` 下载 DSH。
- 同时检查 `pnpm` 可用性和 DSH 所需版本；缺少 pnpm 时给出官方 actionable error，
  不能只显示笼统的 “dsh plugin add failed”。
- 对“仅通过 `npx @deepseek-ai/dsh web` 使用”的用户，Settings 可检测 host，但
  自动 Install 不可用；提供明确的官方手动 plugin-add 命令。plugin 未安装并验证
  前，Clawd 不声明集成已安装，也没有状态/审批接管。
- 用户用该命令手动安装了**完全匹配且 marker-owned** 的 bridge 后，下一次 Settings
  Install / Verify 可以只读复验并提交 installed prefs，不再要求全局 `dsh`；后续
  需要 mutation/uninstall 而 CLI 仍不可定位时，返回对应手动命令，不伪装成功。
- `DSH_HOME` trimmed 非空时生效；CLI、Doctor 和 managed bundle verifier
  必须使用同一个 home resolution contract。

### 6.3 Settings Install

Install 是一个事务：

1. 检测 DSH host、pnpm 与 web profile。首次显式 Install 可以让官方 CLI 初始化
   缺失的 web profile，但必须在 UI/结果中明确这是一次 profile mutation。
2. stage + promote managed bundle。
3. 调用官方 `dsh plugin add`。
4. 重读 DSH manifest，验证 dependency、profile bundle row，并按官方两个 resolution
   anchor 解析最终 package。
5. 验证 resolved target 是 marker-owned Clawd generation，协议 / hash 匹配。若
   pnpm materialize 为 profile-owned snapshot，则验证 snapshot 内的 marker / hash
   和其 recorded source generation，而不是假设 resolved path 必在 `~/.clawd`；若
   installation anchor 的同名 package 抢先命中则报 conflict，不得修 DSH 自有 flat
   fallback。
6. 全部成功后，Settings controller 才一次提交
   `integrationInstalled=true, enabled=true`。

任何一步失败：

- 返回结构化 error 和可执行修复提示；
- 不提交 `integrationInstalled=true`；
- 不删除用户其他 DSH plugin；
- stage residue 只在 ownership 明确时清理；
- 如果 DSH profile mutation 结果未知，Doctor 标为 inspection required，不盲目重放。

### 6.4 Startup sync / Repair

- installer API 使用显式 operation mode（至少 `install`、`startup-sync`、
  `explicit-repair`、`uninstall`），不得再用 `automatic === false` 隐式决定是否安装
  bridge。Settings Repair / Doctor Fix 走 `explicit-repair`，允许对 ownership 明确的
  managed entry 执行 marker-scoped re-add / update，并把失败返回给调用事务。
- 只有 `integrationInstalled=true && enabled=true` 才允许启动同步 managed bridge。
- 未安装或禁用时，不写 DSH profile，不创建 DSH home。
- 已 opt-in 的用户允许 marker-scoped repair；这与项目其他 hook/plugin 的启动同步
  语义保持一致。
- automatic startup sync 不得因为 profile 整体缺失而调用会初始化 profile 的
  `dsh plugin add`；此时只报 `profile-entry-missing` / `repair-required`。重新初始化
  完整 profile 只能由 Settings Install 或显式 Doctor Fix 触发。
- 同步必须返回 bridge 的真实结果，不能用“发现 DSH host”代替成功。
- app 更新导致 bridge hash 变化时，按官方 CLI 的真实行为决定是否需要重新 add；
  Phase 0 必须验证 file dependency 是 link、copy 还是 pnpm store snapshot。
- DSH 进程已运行时若需要 restart 才加载新 plugin，Settings / Doctor 明确提示，
  不声称当前进程已经生效。

### 6.5 Uninstall / About cleanup

Settings Uninstall：

1. 先读取 dependency、bundle row 和 resolved target。
2. 验证 target 指向 marker-owned Clawd generation，且 package、protocol、owner、
   recorded hash 一致。
3. foreign / conflicting 时立即停止，绝不调用 remove，也不删除任何文件。
4. ownership 成立后，才用官方
   `dsh plugin --profile web remove <package-name>` 删除 Clawd bundle row。
5. 重读 profile，验证 dependency、bundle row 均不存在，且 profile-local resolution
   不再命中 Clawd-owned generation / snapshot。DSH installation-owned flat fallback
   不属于 Clawd 卸载目标，无论内容如何都不得删除。
6. 成功后才删除未引用的 marker-owned managed generation。
7. 成功后 Settings controller 才提交
   `integrationInstalled=false, enabled=false`。
8. DSH CLI 不可用或 mutation 失败时保留 managed bundle，避免 profile 留下悬空路径，
   并返回带 `status: "error"` 的 repairable error；Settings controller 必须据此保留
   installed prefs。
9. `hooks/cleanup-integrations.js` 的 agent id、cleaner 和 by-agent 结果必须齐全。

About cleanup 保持项目现有 best-effort 语义：prefs 会先关闭 / 标记未安装，再尝试
外部 cleanup；失败必须进入报告并保留 managed generation。两条路径共享同一
ownership verifier，但不强行统一 transaction policy。

## 7. Deferred：Projection monitor fallback

首发不合入 `agents/deepseek-harness-monitor.js`，也不维护 plugin / monitor 双源仲裁。
上游同时提供 `storage-json` 和 `storage-sqlite`，说明 projection 文件格式本身就是
可替换的 profile 配置面；这进一步排除了把某个 JSON 文件布局当作首发稳定 contract。

只有出现以下至少一种真实证据，才开独立 PR：

- 支持版本的公开 `session/event` 确认丢失 Clawd 必需的 live lifecycle；
- DSH 提供版本化、公开、只读的 projection API；
- 大量真实用户只能使用无法安装 plugin 的 deployment，并且 state-only fallback 的
  产品收益足以引入独立 partial-install 模型。

届时必须重新设计，而不是原样取回 #876 monitor：至少包含 schema/version sentinel、
malformed 保留 previous state、valid-empty debounce、`rows.sessionStats.seq`、
per-session freshness、异步非重叠 bounded reads，以及 plugin activation/liveness lease
或 per-turn fence。永久 session ownership 不是有效 failover；plugin crash、恢复、
late event、completion rescue 和双源乱序都必须有测试。

## 8. Doctor 与 Settings 真相分离

Doctor 至少展示两个不同事实：

| 项目 | 含义 |
| --- | --- |
| DSH host detected | CLI 或可信 DSH layout 存在 |
| Clawd disk integration health | managed generation、DSH manifest、官方两级 package resolution、协议版本是否健康 |

现有通用 descriptor/marker detector 不足以证明上述 ownership。需要增加 DSH 专属
inspector / validator，并在 `src/doctor-detectors/agent-integrations.js` 接入状态与 Fix
action；不能只改 `agent-descriptors.js`。inspector 必须报告最终命中的 resolution
anchor / target；`$DSH_HOME/profiles/node_modules` flat fallback 只作为 DSH-owned
解析背景读取，绝不能被 Doctor Fix 当成 Clawd 残留清理。

健康状态建议：

- `not-installed`
- `host-detected-integration-absent`
- `healthy`
- `managed-bundle-missing`
- `profile-entry-missing`
- `profile-entry-foreign-or-conflicting`
- `version-unsupported`
- `cli-unavailable`
- `repair-failed`

Fix 按钮只对 ownership 明确、结果可验证的 repair class 出现。foreign / conflicting
entry 不得自动覆盖。

Doctor 首发只报告 disk health。若没有带 bridge protocol/version 的 activation
handshake，就无法证明 plugin 已在当前 DSH 进程中加载，也不能声称可检测
`restart-required`。安装结果可以保守提示“可能需要重启 DSH”；若后续加入 handshake，
runtime activation health 再作为与 disk health 分离的状态接入。

## 9. 分阶段实施

### Phase 0 — 冻结上游 contract（合并阻断）

- 安装计划支持的具体 DSH 版本，记录 `dsh --version`、registry artifact、integrity；
  若发布物没有可验证的 `gitHead`，必须把 source-audit baseline 与发布物身份分开记录，
  不得虚构 tag/commit 映射。
- 写最小 probe plugin，只使用公开 API。
- 捕获并脱敏 session event、approval request、abort、web native fallback fixture。
- 验证 `approval/request` prepend + `next()` 的真实 ordering 和返回值。
- 验证 Clawd listener 抛错 / 超时 / 取消时，DSH native web UI 仍接管。
- 验证 `policy="never"` 不 dispatch listener，Clawd 不可能越权 allow。
- 验证普通 approval 的官方字段确实不含 arguments；决定是否完全取消参数反查。
- 验证 `session/created` 同步 throw 的 veto/rollback、`session/event` 与
  `session/disposed` 的 contained 行为，以及 observer 内 `session.append()` 重入失败；
  probe plugin 自身的 lifecycle listener 必须保持 non-throwing。
- 运行包含 `compaction/prune` 的完整 turn，确认 append-only `SessionEvent.seq` 仍单调、
  contiguous 且不重编；同时冻结 created/disposed 的 exclusive `session.seq` watermark
  与首条/末条 event 的比较 fixture。
- 验证 `dsh plugin add/remove` 的 Windows 路径语义；POSIX 行为做 code review，
  不在完成真机 smoke 前宣称已支持。
- 验证 local path dependency 在 pnpm layer 中是 link 还是 snapshot。
- 验证 external bridge 最终从 profile-local dependency 解析，以及 add/remove 对
  DSH installation-owned `$DSH_HOME/profiles/node_modules` flat fallback 的实际行为；
  Clawd 测试只能观察它未被触碰，不能把它纳入 managed cleanup。
- 验证 profile 缺失时官方 CLI 的初始化副作用，以及 pnpm missing / incompatible
  的真实 exit code 和 stderr。
- 明确 supported DSH version range；安装器、startup sync 与 Doctor 对不兼容版本
  fail closed，不执行 profile mutation。DSH 当前没有供 external plugin 可靠读取 host
  version 的公开 runtime seam：已安装 bridge 若遇到宿主原地升级，无法在 plugin 内兑现
  “未知版本绝不加载”的强保证；这必须作为 experimental residual 明示，直到上游提供
  version/activation handshake。adapter 仍须 non-throwing，approval 失败必须 `next()`
  回 DSH 原生 UI。
- 单独向 DSH 上游确认 user question 是否有公开 middleware roadmap；不阻塞普通
  approval 首发。

Deliverable：脱敏 fixtures、spike 记录和更新后的 compatibility table。

### Phase 1 — Managed bundle 与事务安装

- 重构 `hooks/dsh-install.js`，引入 immutable hash generations、marker、CLI discovery、
  shared mutation queue/lock 和 manifest verification。
- Settings Install/Uninstall 只根据完整 bridge transaction 提交 prefs。
- startup sync 只在 installed + enabled gate 下 repair。
- Doctor 区分 host 与 integration health。
- 完成 packaged `asar.unpacked` path 测试。

这一阶段完成前，不打开 permission capability。

### Phase 2 — Plugin primary state

- bridge 监听 Phase 0 验证过的公开 session event。
- `session/created` callback 整体 try/catch，所有 lifecycle observer 禁止同步 append；
  bridge 自身错误只能丢一条 Clawd 状态并记有界诊断，不能 veto DSH session。
- 使用动态 Clawd discovery，短 timeout、payload allowlist 和 cooldown。
- 加入 canonical session ID 与 hook source。
- 增加 per-session FIFO、bounded queue、`event_seq` stale fence 和 unload generation
  fence。
- 完成 state event fixtures、multi-session、disable/re-enable 和 shutdown tests。

### Phase 3 — 普通 approval bubble

- 只实现公开 `approval/request` listener。
- 在 Claude / CodeBuddy shared branch 之前加入独立 DSH blocking adapter，结构参考
  Hermes；capability 与 automation eligibility 分开。
- 在 `classifyPermissionInteraction()` 增加 DSH 专属分支：普通 approval
  `allowDeny=true/nativeFallback=true`，但 `autoTools/unattended=false`；禁止加入
  `KNOWN_PERMISSION_AGENTS`，`ask_user_question` 保持 `answerQuestions=false`，且不把
  DSH 加入 session automation eligible adapter。
- 禁止经过 `PASSTHROUGH_TOOLS`、headless auto-decision、Claude suggestions / response
  serializer；DSH bubble 隐藏 Go to Terminal。
- 首发 DSH automation 全部 defer，只允许人工 bubble / remote channels 决定。
- 区分 permissionsEnabled、DND、本地 bubble off + remote-only，并让所有可控
  no-decision 返回带 Clawd header 的 204。
- no-decision、timeout、abort、native web answerer 逐项验证。
- DSH response serializer 仅映射已实测的 allow / deny 值；其他字段 omit。
- bubble 只显示 Allow Once / Deny，不提供 Always、suggestion 或持久规则按钮。
- 删除 #876 的 userQuestions provider takeover 与相关 auto-answer alias。

### Phase 4 — 文档、发布与清理

- 更新 README、setup guide、runtime architecture、AGENTS agent summary。
- 补充 DSH web-only、plugin-only、restart hint、CLI discovery 和 native fallback 说明。
- 完成 cleanup integrations、package scripts、i18n、icons/source manifest。
- 跑 full tests、Windows packaged smoke 和 release verification。
- PR 描述列出 ask_user_question 为 deferred，不能宣称完整 interactive coverage。

## 10. 预计文件边界

优先复用 #876 中可验证的 registry、UI 和 icon 工作；bridge、installer、permission
adapter 重写，projection monitor 不进入首发。

### 新建 / 保留

- `agents/deepseek-harness.js`
- `hooks/dsh-clawd-bridge/package.json`
- `hooks/dsh-clawd-bridge/cordis.patch.yml`
- `hooks/dsh-clawd-bridge/lib/index.js`
- `hooks/dsh-install.js`
- `src/doctor-detectors/deepseek-harness-integration.js`（建议命名）
- `docs/guides/dsh-setup.md`
- focused DSH tests under `test/`

### 需要接线或修改

- `agents/registry.js`
- `src/agent-runtime-main.js`
- `src/integration-sync.js`
- `src/agent-installation-detector.js`
- `src/doctor-detectors/agent-descriptors.js`
- `src/doctor-detectors/agent-integrations.js`
- `src/prefs.js`
- `src/settings-actions-agents.js`
- `src/settings-actions.js`
- `src/server-route-permission.js`
- `src/permission.js`
- permission bubble renderer / action files（若需隐藏 DSH Go to Terminal）
- `src/permission-automation-policy.js`（DSH 专属 manual-actionable / automation-ineligible
  interaction；禁止加入 `KNOWN_PERMISSION_AGENTS`）
- `src/session-automation-identity.js`（保持 DSH session grant ineligible，并补 contract test）
- `hooks/cleanup-integrations.js`
- `package.json`
- README / i18n / docs / icon manifest

若 FIFO / stale fence 会让 `agent-runtime-main.js` 出现 DSH 专属状态机，应抽成小型
模块并单测，避免 composition root 继续膨胀。不要借 #876 同时推进 #815 的全局
插件框架重构。

## 11. 自动化测试矩阵

### Installer / ownership

- DSH host missing：不创建 `~/.dsh`，返回 skipped。
- host present, CLI missing：Install 失败且 prefs 不提交。
- managed generation 从 unpacked source 完整写入，hash / marker 正确。
- `dsh plugin add` 成功但 manifest 未变化：返回 error。
- dependency 存在但 bundle row 缺失：Doctor degraded，不算 installed。
- 官方两级 resolution 命中 profile-local marker-owned package 才算 healthy；同名
  installation-level package 抢先命中时 fail closed 为 conflict。
- `$DSH_HOME/profiles/node_modules` flat fallback 在 install、repair、uninstall、Doctor
  Fix 中都只读且不被删除；不得把 DSH-owned symlink 当 Clawd generation reference。
- 同名 foreign dependency / target：不覆盖、不删除。
- uninstall 在调用 CLI 前验证 ownership；foreign target 时断言 CLI 0 次调用。
- uninstall CLI 失败：保留 managed bundle 和 installed prefs。
- cleaner 失败必须返回 `status: "error"`，断言 Settings Uninstall 不提交 prefs；About
  cleanup 仍按既有 best-effort policy 报告失败。
- explicit Repair 会 marker-scoped 重装 bridge；startup-sync 在 profile 缺失时只报
  repair-required，二者不能再被 `automatic` boolean 混淆；CLI repair 失败的
  `{ status: "error" }` 必须沿调用链保留，Doctor 不显示成功且 prefs 不变。
- repeated install/uninstall 幂等。
- Windows path 含空格、括号、Unicode。
- packaged path 包含 `app.asar` 时解析到物理 `app.asar.unpacked`。
- startup / Settings / Doctor / About 并发 mutation 被同一 queue/lock 串行；两个 Clawd
  实例竞争时一个 fail closed。
- 两个 Clawd 版本顺序获得 lock：旧版本不降级新 generation，新版本按规则升级旧
  generation，同版本异 hash fail closed；不能只测同时竞争。
- 两个 canonical `DSH_HOME` 安装相同 bundle 时落入不同 namespace；卸载或 About
  cleanup 其中一个 home 后，另一个 home 的 generation 与 disk health 保持完整。

### Plugin transport

- runtime.json 指向 23334–23337 时正确发现。
- stale runtime port 失败后扫描并验证 server header。
- 非 Clawd server、非 loopback config、oversized response 均拒绝。
- state timeout 不阻塞 DSH event loop。
- permission timeout / abort 清除 socket、timer 和 abort listener。
- plugin unload 后无 timer / handler / pending request 泄漏。

### State

- fixture 映射覆盖 start、prompt、tool start/result/failure、turn end、session end。
- `session/created` listener 内部同步异常被 bridge 吞掉，不 veto / rollback DSH
  session；observer 不调用 `session.append()`。
- prompt / result / reasoning 不进入 payload。
- 同 session FIFO、不同 session 可并行。
- created `session_seq=k` 不吞掉首条 `event_seq=k`；disposed watermark 关闭 lifecycle，
  late callback 不能复活；compaction/prune 后 seq fence 仍单调。
- delayed `PreToolUse` 不覆盖已接受的 `Stop` / `SessionEnd`。
- queue 达到上限时按 contract 折叠高频同态事件，不丢 lifecycle / failure。
- plugin unload 后 late queue / callback 被 generation fence 丢弃。
- session dispose 后 late tool result 不复活 session。
- agent disabled 后 state route 快速 fallback，session / bubble 清理符合现有 gate。

### Permission

- allow -> `allowed-once`，deny -> `rejected`。
- `policy="never"` 不进入 Clawd listener，不能由 Clawd override。
- 204 / empty / invalid JSON / wrong header / non-2xx -> `next()`。
- DSH DND、auto-close、bubble failure 等可控 no-decision path 精确返回 204；不改
  Claude / Codex / opencode 现有 fallback wire shape。
- DSH route 在 shared Claude/CodeBuddy branch 前命中；`PASSTHROUGH_TOOLS` 不能
  auto-allow DSH。
- headless、Go to Terminal、Claude suggestion serializer 都不能给 DSH 产生决定。
- DSH bubble 不渲染 Go to Terminal action。
- `permissionsEnabled=false` 与 DND 立即 204；仅关闭 local bubble 时仍等待可用
  remote clients，全部 no-decision 后才 204。
- agent disabled / app shutdown -> 204 -> `next()`。
- local bubble 与 Telegram / Lark 并行；remote failure 不产生 deny。
- downstream native answerer 能在 Clawd no-decision 后真实回答。
- downstream answerer 不存在时保持 DSH fail-closed。
- DSH 普通 approval 的 interaction 保持 `allowDeny=true`，但
  `evaluatePermissionAutomation()` 在 auto-tools 与 unattended 均显式返回 DEFER；
  session automation identity 不 eligible、grant 不可创建，off 也不产生决定。
- 即使 session automation store 中预先存在伪造或旧版残留的 DSH grant，也必须因
  当前 route-owned identity ineligible 而不能 sweep / auto-resolve pending approval。
- tool args 缺失是正常 contract；reason / tool name / call id 有安全、有界展示。
- 若实现可选 arguments lookup，缺失、字符串 JSON、malformed JSON、oversized input
  均不阻断审批。
- `ask_user_question` 没有被 bridge 注册、改写或抢占。

### Project regression

- registry / prefs default / settings reducer / integration sync。
- About cleanup by-agent contract；cleanup 失败时 prefs 仍关闭、managed generation
  保留并报告。
- Claude、Codex、Qwen、opencode permission response shape 不变。
- `npm test`
- `npm run verify:electron`
- `npm run verify:release`
- `npm run audit:assets`

## 12. 真实验证矩阵

首发定义为 **Windows native DSH web experimental**；合并前至少完成：

1. Clawd 使用 23333 和非 23333 两种端口。
2. DSH 空闲、提交 prompt、工具成功、工具失败、turn 完成、session 关闭。
3. 两个并行 DSH session，确认状态不串线。
4. 一个普通 approval：Clawd allow、deny 各一次。
5. Clawd DND 时 approval 回到 DSH web UI。
6. Clawd 未启动 / 中途退出时 approval 回到 DSH web UI。
7. 在 DSH web UI 直接回答，Clawd 不留下孤儿 bubble。
8. disabled、uninstall、reinstall、Clawd update 后 repair。
9. 从 x64 NSIS 解包/安装后的物理资源路径完成 plugin add 与实际加载。
10. 若本机条件允许，再覆盖 ARM64 package path；不能用 unit test 宣称已验证。
11. `permissionsEnabled=false`、local bubble off + remote-only、Go to Terminal 不产生
    DSH deny / allow。
12. npx-only host 被检测但不会误报 integration installed；manual command 提示可执行。
13. 分别开启 auto-tools 与 unattended 后发起 DSH approval，请求仍进入人工 bubble；
    不会静默 allow，也不会出现 per-session grant 入口。

POSIX smoke 不作为 Windows experimental 首发的 merge gate。macOS / Linux 在当前
Windows-first 环境中记录 pending 和 residual risk，并通过代码审查确认 path、shell、
home resolution 不写死 Windows；在 README 宣称某个 POSIX 平台已支持前，必须至少
完成该平台一次真实 install/state/approval/uninstall smoke。

## 13. Rollout 与兼容策略

- 新 agent 默认 `integrationInstalled=false, enabled=false`，与项目当前新集成默认
  规则一致。
- 首版 UI 标注 `DeepSeek Harness (web, experimental)`；DSH developer preview
  阶段不承诺无限向后/向前兼容。
- bridge manifest 声明 protocol version；Clawd 的 disk mutation 与 Doctor 只接受冻结的
  DSH version。由于上游尚无公开 runtime host-version seam，已安装 bridge 遇到宿主原地
  升级时不能可靠地在注册 listener 前自我禁用；首发将此列为 experimental residual，
  依靠 non-throwing observer、approval `next()` 与明确 restart/compatibility warning
  保持 DSH 原生流程可恢复。Clawd 不从 projection 猜状态。
- 不自动下载 DSH，不修改用户 approval preset，不接管 userQuestions provider。
- 一旦发现上游 public event shape 漂移，状态 adapter fail silent，Doctor 给出明确
  compatibility warning；不能让 plugin exception阻断 DSH。

## 14. 与 #815 插件化的边界

#876 应先做，但不应等待 #815，也不应在这个 PR 内顺手重构全仓插件框架。

这次只留下未来可迁移的干净边界：

- agent descriptor
- installer lifecycle（detect / install / verify / repair / uninstall）
- event adapter
- permission adapter
- Doctor health provider

这些正好可以成为 #815 后续 internal plugin manifest 的输入。等 #876 经真实 DSH
验证稳定后，再从它和现有 opencode / Hermes / hook agents 中提取共同 contract，
比先设计一个没有第二种真实 plugin host 验证的抽象更稳。

## 15. Definition of Done

- [ ] Phase 0 的真实 DSH contract fixture 和版本范围已记录（rc.6 artifact/版本范围已
      冻结；API-backed session/approval fixture 待补）。
- [x] 没有任何 DSH 私有字段访问或递归未托管 timer。
- [x] bridge 从动态 Clawd 端口工作，并验证 server identity。
- [x] packaged app 使用稳定 managed bundle，不依赖易变安装路径。
- [x] multi-instance mutation 有 queue/lock 和锁内版本仲裁；旧 Clawd 不自动降级
      健康的新 generation。
- [x] Settings Install 只有在 bridge 完整验证后才提交 installed。
- [x] startup sync、Doctor、Uninstall、About cleanup 共用 ownership verifier，并保留
      各自既有 transaction / best-effort policy。
- [x] plugin-only state 有 FIFO、event_seq 和 unload/dispose fence。
- [ ] lifecycle observer non-throwing，created listener 不能 veto DSH session；exclusive
      session watermark 与 compaction 后 seq 已由真实 fixture 验证。
- [x] projection monitor 已从首发 diff 移除并记录为 evidence-gated follow-up。
- [x] DSH 使用独立 blocking permission adapter，不经过 shared branch 的隐式决定。
- [ ] 普通 approval 的 allow / deny / no-decision / abort / native fallback 已真机验证。
- [ ] DSH 人工 Allow/Deny 可用，但 auto-tools、unattended 和 per-session grant 首发均
      fail-closed DEFER。
- [x] `ask_user_question` 明确保留原生 UI。
- [x] full test suite、packaged Windows smoke 和文档完成。
- [ ] PR 描述准确标注 web-only、Windows-verified experimental、plugin-only 和
      deferred scope。

## 16. 实施与验证记录（2026-08-14）

冻结与 artifact 证据：

- npm registry 没有计划最初引用的 `0.1.0-rc.5`；实际安装并冻结
  `@deepseek-ai/dsh@0.1.0-rc.6`，integrity 为
  `sha512-brpZfED7ieRa2PQ5tUxMhHrM1pb2CmKFVM/f6yMULBDMicahk+Z2OsHgTwTDnoiZm23Ftu9rQz0NN4pflaoJcg==`。
- 已逐项复核 rc.6 编译发布物中的 approval request/outcome/waterfall、session header/
  seq/lifecycle、installation-first/profile-second resolution、pnpm plugin add/remove 和
  scope dispatch；`47f9438` 仅保留为源码调查基线，不冒充 rc.6 commit 映射。

自动化与 review：

- `npm test`：7,907 tests，7,872 pass，0 fail，35 conditional skip。
- `npm run verify:electron`、`npm run verify:release`、`npm run audit:assets` 通过；asset
  audit 只有仓库既有的 tracked-tree 51.40 MiB warning。
- 独立子代理多轮增量 review 找到并关闭 double-next、lifetime abort、equal-watermark
  restart、Windows packaged Node runner、automation eligibility、ownership/latch/version
  仲裁、多 DSH_HOME generation、approval reason display 等高严重度问题。
- Claude 最终只读复审提出的唯一代码 Major（崩溃遗留 mutation lock 永久锁死）已按
  fail-closed 语义关闭：仅 managed owner/schema/token/PID/timestamp 全部有效、年龄超过
  两倍实际 operation timeout、且 OS PID probe 明确返回 `ESRCH` 时，才通过 sibling
  atomic rename 接管；live PID、`EPERM`、unknown、corrupt/foreign owner 继续拒绝，并
  向用户返回精确 lock path。并发接管测试证明最多一个 contender 获锁。
- 同轮 Minor 已收口：无全局 CLI 的 npx-only generation 在锁内写 owned reference，
  cleanup 不会删除尚待用户执行的命令目标；marker 显式记录版本属于 staging assumption；
  Feishu/Lark 的 DSH 审批卡不再显示无意义的 terminal action；flat fallback ownership
  与人工恢复边界已写入 guide。增量 review 又把 owner-recorded timeout、canonical lock
  exact cleanup、malformed/foreign/concurrent manual-reference preservation，以及 alternate
  home 手动命令显式 pin `DSH_HOME` 纳入 contract。DSH focused 回归 118/118 通过。当前代码 review 无已知
  Blocker/Major；API-backed smoke 仍是 ship gate，而不是用 unit test 代替的已验证事实。

Windows x64 non-API 真机：

- 全局安装 `dsh 0.1.0-rc.6`；所有 profile mutation 使用 workspace 内隔离
  `DSH_HOME`，默认 `~/.dsh` 在验证后仍不存在。
- 真实 `dsh plugin --profile web add` 生成 `link:` dependency 和 bundle row；marker、
  supported range、artifact integrity、bundle hash 与 official profile winner 全部一致。
- `dsh --profile web --dump-config` 出现 `@dsh-external/dsh-clawd-bridge`，实际
  `dsh web --host 127.0.0.1 --port 0` 成功监听随机端口，证明 rc.6 能加载 plugin layer。
- 真机发现 rc.6/pnpm remove 会删 manifest rows、但留下 profile-local managed junction。
  Uninstall 因此新增极窄的 ownership cleanup：只在 lock 内、rows 均消失、link 的
  realpath 精确命中当前 DSH_HOME namespace 中 marker/hash 完整的 generation 时执行
  `unlink`；普通目录、foreign target、flat fallback、installation anchor 都 fail closed。
  fresh add/remove 与 unknown-result recovery 最终均为 `absent`、无 latch。
- `npm run build:win:x64` 成功；真实 bridge 来源解析到
  `dist/win-unpacked/resources/app.asar.unpacked/hooks/dsh-clawd-bridge`。用该 packaged
  source 重跑 add/config composition/web boot/remove 全部通过。
- `npm run audit:native-package -- --app-root dist\\win-unpacked --target windows-x64`
  通过，只有 policy 允许的 electron-builder ia32 `elevate.exe` 例外。

仍需用户回来提供 API 配置后完成：真实 session lifecycle/state、普通 approval 的
Allow Once / Deny / 204 no-decision / disconnect / abort / native web fallback，以及
auto-tools 与 unattended 开启时仍 DEFER 的 UI 矩阵。在这些证据完成前，不把 approval
路径写成 Windows-verified。

已知低风险 residual：若 agent 在禁用期间恰好漏收 `SessionEnd`，随后同一 DSH
session 以完全相同 watermark 重载，server fence 会把重复 `SessionStart` 当作 active
lifecycle restart 丢弃；下一条单调递增的 live event 仍会被接受，因此这是短暂可见性
gap，不会产生权限决定或把旧事件倒序复活。直接在 enable 时清 fence 会扩大旧 in-flight
event 被重新接受的窗口，首发保留当前更保守的 stale-event 边界，后续可结合 runtime
generation handshake 再消除该 gap。
