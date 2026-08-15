# Plan: Kimi Code 订阅额度环

Status: Phase 0 and implementation complete; automated + isolated Windows dev-GUI validation passed — packaged real-Key smoke remains pending and periodic polling remains policy-blocked

Execution note (2026-08-14): the secret-safe manual probe now lives at
`scripts/manual/kimi-quota-phase0-smoke.ps1` with its Node transport in
`scripts/manual/kimi-quota-phase0-smoke.js`. It fixes the endpoint and Clawd
User-Agent, accepts the key only through hidden-input stdin, caps the response,
does not follow redirects, and emits only sanitized schema evidence. Its nine
focused tests and the repository test suite passed locally. The later live
result is recorded immediately below.

Live update (2026-08-14 20:00–20:02 Asia/Singapore): the operator ran the
probe with a dedicated Kimi Code API Key in a quiet account window. All three
requests returned HTTP 200, `application/json`, 540-byte bodies. The known
quota fields were stable across all samples: API-key transport is
`remaining/limit/resetTime` (not `used`), weekly was `100/100` remaining, and
the single rolling limit was `300 + TIME_UNIT_MINUTE`, also `100/100`
remaining. Both reset times used microsecond RFC3339 `Z`; `totalQuota` was
present as an object and remains intentionally ignored. No visible quota
changed across the three GETs. This passes endpoint/auth/real-UA/wire-shape
and “no obvious GET consumption” gates, but not the stronger claim that a GET
can never consume sub-display precision. The frozen known-field fixture is
`test/fixtures/kimi-quota/phase0-known-fields.json`.

Interactive comparison update (2026-08-14 20:17 Asia/Singapore): the same
account's Kimi Code `/usage` panel showed weekly `0% used`, resetting in
`6d 13h 3m`, and rolling 5h `0% used`, resetting in `4h 3m`. Those relative
times resolve to the probe's absolute weekly
`2026-08-21T01:20:19.901916Z` and 5h
`2026-08-14T16:20:19.901916Z` resets, and `remaining=limit=100` maps exactly
to `0% used`. This closes the value/window/reset mapping gate. No public or
written permission for periodic third-party polling has been obtained, so the
shipping implementation is forced to `manual-only`: only explicit Connect,
Replace, or Refresh actions may contact Kimi.

Implementation update (2026-08-14): the credential store, strict client and
normalizer, manual-only runtime, account-quota provider, snapshot signature,
Orbit/Dashboard renderers, Settings trusted IPC/UI, six locales, user docs,
and regression tests are implemented. The repository suite completed with
7,999 tests (7,964 passed, 35 skipped, 0 failed), and
`npm run verify:electron` verified Electron 41.10.4. An isolated Windows
development-GUI smoke confirmed that the Kimi quota card is visible, its Key
field is `type=password` with `autocomplete=new-password`, the field starts
empty, manual-only and non-read-only security warnings render, and the
Settings snapshot exposes only `kimiQuotaCollectionEnabled` with no Key,
ciphertext, or credentialId. A packaged-app restart/real-Key lifecycle smoke
is deliberately still pending because the operator must paste the secret
locally; the secret must never be sent through chat or placed in a test
artifact.

Created: 2026-08-14

Scope: modern local Kimi Code subscription quota only; this document now also records the implementation gates and live evidence

Review: revised after three independent subagent reviews and an external Claude adversarial review on 2026-08-14

Research baseline: Kimi Code `0.36.0`, upstream source
[`7475c2e2e3dd86ac0b8a8d51d4f1d233ed7df797`](https://github.com/MoonshotAI/kimi-code/tree/7475c2e2e3dd86ac0b8a8d51d4f1d233ed7df797)

## 1. 结论先行

Clawd 可以增加 Kimi Code 额度环。现有 Orbit 的双环模型与 Kimi Code 的额度结构天然匹配：

- 外环：5 小时滚动窗口；
- 内环：每周额度；
- 详情：各窗口已用百分比、准确重置时间和最后成功更新时间。

首发必须标记为 **Experimental / 实验性**，并明确写成“Kimi Code 5 小时 / 周额度”，不能写成“Kimi 会员总额度”。原因不是 Clawd 的 UI 或状态架构不成熟，而是 Kimi Code 当前机器接口的产品契约仍不完整：官方客户端正在调用 `/coding/v1/usages`，官方论坛也给出了 Kimi Code API Key 的调用方式，但该接口尚未作为稳定公共 API 文档化。

当前风险边界最清楚、能覆盖普通 TUI 的首发**候选**方案是：

1. 用户在 Kimi Code 控制台创建一枚独立、可撤销的 **Kimi Code API Key**，在 Clawd Settings 中显式连接；
2. Clawd main process 通过固定官方 `https://api.kimi.com/coding/v1/usages` 查询；只有 polling-policy gate 通过才启用低频单飞后台刷新，否则首发仅允许用户主动刷新；
3. 只把规范化后的 5h / weekly bucket 写入现有 session-independent account quota store；
4. API Key 只以 Electron `safeStorage` 加密密文落盘，不进入 prefs、hook、IPC snapshot、日志、遥测或 `account-quota.json`；
5. Kimi hook 只负责现有生命周期和权限事件，不承担网络额度查询。

“候选”是有意保留的门槛：第一方源码只直接证明 OAuth access token 能调用该端点；Kimi Code API Key 的直接证据来自官方域名论坛中的 legacy/experimental 示例，而且该示例与当前 OAuth client 的字段 shape 还不完全一致。Phase 0 在真实 API Key 上确认权限、schema、真实 User-Agent 后，才能把它升级为实施 transport；后台周期 polling 还要取得上游公开/书面许可，技术 2xx 不能代替政策许可。

这不是理论上的完美终局。更理想的上游契约是 `kimi usage --json`、公开稳定的 usage API，或由 Kimi 自己在 hook/status-line payload 中附带 managed usage；这些能力当前不存在。计划因此把“上游稳定结构化接口”列为长期替换路径，同时为当前用户提供一个边界明确、可在 Kimi Console 撤销的实验性候选实现。

## 2. 产品与额度边界

必须把三套相似但不同的额度体系拆开：

| 产品 | 数据 | 首发处理 |
| --- | --- | --- |
| Kimi Code 订阅 | 5 小时滚动额度、周额度、重置时间、Extra Usage | 只接 5h + weekly 双环 |
| Kimi 网页/App 会员 | 月度共享池与会员权益 | 不采集；UI 明确“不包含 Kimi 月总额度” |
| Moonshot Open Platform | API 现金/代金券余额及 RPM/TPM 等限制 | 不采集；不得映射为 Kimi Code 订阅额度 |

官方会员说明确认：Kimi Code 有独立的 5 小时和周额度，同时可能受 Kimi 月度共享池约束，Extra Usage 钱包由 Kimi Web 与 Kimi Code 共享：

- [Kimi Code Membership](https://www.kimi.com/code/docs/en/kimi-code/membership.html)
- [Kimi API troubleshooting](https://www.kimi.com/zh-cn/help/kimi-api/api-troubleshooting)

因此，首发即使两个环都未满，也不能声称“Kimi 一定可继续使用”；月总额度、服务过载或并发限制仍可能阻止请求。Dashboard 和 hover 文案必须使用描述性语言，不使用“可用/不可用”的硬判断。

`boosterWallet` 首发只解析后丢弃，不持久化、不显示：

- 金额属于比额度百分比更敏感的财务数据；
- 开启 Extra Usage 后，订阅环达到 100% 不等于 Kimi Code 无法继续工作；
- 把余额做成第三个环会破坏现有“短窗口/长窗口”语义。

未来若产品确实需要 Extra Usage，应作为独立 Dashboard 卡片设计，另行确认金额隐私、货币单位、月上限和“额度耗尽但钱包接管”的文案，不在本计划顺手加入。

## 3. 已核对的上游事实

### 3.1 官方客户端的数据源

Kimi Code 第一方源码已证实的调用链是：OAuth manager 先取得 fresh access token，再调用 usage client：

```http
GET https://api.kimi.com/coding/v1/usages
Authorization: Bearer <oauth-access-token>
Accept: application/json
```

源码与测试：

- [managed-usage.ts](https://github.com/MoonshotAI/kimi-code/blob/7475c2e2e3dd86ac0b8a8d51d4f1d233ed7df797/packages/oauth/src/managed-usage.ts)
- [managed-usage.test.ts](https://github.com/MoonshotAI/kimi-code/blob/7475c2e2e3dd86ac0b8a8d51d4f1d233ed7df797/packages/oauth/test/managed-usage.test.ts)
- [toolkit.ts](https://github.com/MoonshotAI/kimi-code/blob/7475c2e2e3dd86ac0b8a8d51d4f1d233ed7df797/packages/oauth/src/toolkit.ts)
- [usage-panel.ts](https://github.com/MoonshotAI/kimi-code/blob/7475c2e2e3dd86ac0b8a8d51d4f1d233ed7df797/apps/kimi-code/src/tui/components/messages/usage-panel.ts)

当前 OAuth client 源码和测试使用的关键结构为：

```json
{
  "usage": {
    "used": "40",
    "limit": "1000",
    "resetTime": "2026-08-21T00:00:00Z"
  },
  "limits": [
    {
      "window": {
        "duration": 300,
        "timeUnit": "TIME_UNIT_MINUTE"
      },
      "detail": {
        "used": "1",
        "limit": "100",
        "resetTime": "2026-08-14T16:00:00Z"
      }
    }
  ],
  "boosterWallet": {}
}
```

但官方域名论坛给出的 Kimi Code API Key 示例使用 `limit + remaining`，没有 `used`。这可能是接口代际迁移，也可能是 API Key 与 OAuth 两条 wire shape 不同：

```json
{
  "usage": {
    "remaining": "100",
    "limit": "100",
    "resetTime": "2026-03-09T11:16:04.416717Z"
  }
}
```

两条已见 wire shape 的已知差异是 `used` 与 `remaining`；论坛示例同样包含 `resetTime`，且使用带微秒的 RFC3339 `Z` 时间。计划不能把论坛证据和第一方 OAuth 调用链混写成同一个已确认 contract。Phase 0 必须记录 API Key 当前实际返回 `used`、`remaining` 或两者，并在进入实现前冻结脱敏 schema。

上游解析行为确认：

- `usage` 是 weekly summary；它本身不携带 window，官方客户端补成一周；
- `limits[]` 是滚动窗口列表；`300 + TIME_UNIT_MINUTE` 即 5 小时；
- `used`、`limit` 可以是十进制字符串或 number；
- `resetTime` 是绝对时间；
- 响应允许未来增加未知字段和未知窗口；Clawd 必须忽略，而不是 fail open 映射到现有环。

官方论坛给出了 Kimi Code API Key 调用 `/usages` 的示例，同时把它称为 legacy/experimental；公开 Kimi Code 文档只正式承诺 API Key 可供第三方 coding tools 调用模型，没有把 usage endpoint 列为公共 API：

- [Moonshot AI Forum — Kimi Code API usage query](https://forum.moonshot.ai/t/error-code-429-were-receiving-too-many-requests-at-the-moment/191/7)
- [Kimi Code third-party tool setup](https://www.kimi.com/code/docs/en/)

`/usages` 还可能出现未文档化的 `totalQuota`。其单位、语义和正确性都没有官方契约，且已有[长期固定错误值的社区报告](https://github.com/MoonshotAI/kimi-code/issues/1569)，因此首发必须忽略；raw response 中即使出现，也不得进入 snapshot、persistence 或日志。Kimi 月会员池只能视为目前不可可靠机器获取的 UI-only 数据。

Phase 0 必须在真实、用户显式提供的 Kimi Code API Key 上复核权限与 shape；源码和论坛证据不能替代发布前真机 smoke。

### 3.2 现有 hook、status line 和 CLI 不提供额度

现有 Clawd Kimi hook 只接收生命周期、权限、cwd、PID 等事件字段。Kimi 官方 hook payload 没有 subscription usage；`SessionHeartbeat` 也只有存活信息，不能生成额度：

- [Kimi Code hooks](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html)
- `hooks/kimi-hook.js`
- `hooks/kimi-install.js`

`status_line.command` 的输入只有模型、cwd、权限模式、context 使用量、session id、版本等字段，没有 managed usage；它每秒最多执行一次且有 300ms 上限。官方 `/usages` 请求默认允许数秒网络等待，因此把额度查询塞进 status line 会造成请求风暴、超时，并占用用户唯一 status line：

- [status-line-command.ts](https://github.com/MoonshotAI/kimi-code/blob/7475c2e2e3dd86ac0b8a8d51d4f1d233ed7df797/apps/kimi-code/src/tui/utils/status-line-command.ts)

`/usage` 是交互 TUI slash command，不是稳定的 `kimi usage --json` 子命令。按当前 command routing 的代码审查，`kimi -p "/usage"` 会进入 print/prompt 路径而不是 TUI slash dispatcher，可能创建 session 并消耗额度；这一点是源码行为推断，不是官方文档承诺。无论如何，它都不是可发布机器接口，因此计划禁止 PTY/ANSI scrape 和 headless prompt 模拟。

### 3.3 OAuth 凭据不能由 Clawd 接管

现代 Kimi Code 的 OAuth credential 默认位于 `$KIMI_CODE_HOME/credentials/`，未设置时为 `~/.kimi-code/credentials/`。凭据包含 access token、refresh token 和 expiry metadata：

- [storage.ts](https://github.com/MoonshotAI/kimi-code/blob/7475c2e2e3dd86ac0b8a8d51d4f1d233ed7df797/packages/oauth/src/storage.ts)
- [oauth-manager.ts](https://github.com/MoonshotAI/kimi-code/blob/7475c2e2e3dd86ac0b8a8d51d4f1d233ed7df797/packages/oauth/src/oauth-manager.ts)

官方 OAuth workspace package 标记为 private。token 到期时间由服务端动态返回，不能假定固定时长；当前环境观测到的短时 access token 也不是稳定 API 契约。更关键的是，上游 Windows 路径明确不使用跨进程 refresh lock。Clawd 如果另起一套 refresh client，会与 Kimi Code 的 refresh-token rotation 竞争，可能导致凭据 tombstone、反复 401 或用户被迫重新登录。

首发因此禁止：

- 读取、复制或导入 `~/.kimi-code/credentials/*.json`；
- 持久化 Kimi 的 access/refresh token；
- 调用、复制或 vendoring 上游 private OAuth package；
- 写回或修复 Kimi credential；
- access token 失败后退化为 refresh token 流程。

### 3.4 Kimi Web 本地 REST 不是首发默认

`kimi web` 启动的本地 server 提供 experimental `GET /api/v1/oauth/usage`，但普通 TUI 不会启动该 server。其 `server.token` 不只是“额度只读 token”，还保护 session、文件和 shell 等高权限 API：

- [Kimi Code Server API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html)
- [Kimi Code local server security](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/server.html)

Clawd 不应为了额度自动启动 `kimi web`，也不应暗中读取这个高权限 bearer。对“用户已经运行 Kimi Web”的子集，它有一个真实优点：由 Kimi 自己持有 OAuth，不需要再创建一枚可从远程调用模型/消耗额度的长期 API Key。但 server token 可在本机访问文件、shell 和 session，且该路径覆盖不了普通 TUI，所以它是不同 threat tradeoff，不是 API Key 的严格优胜或劣势方案。未来若实现，只能作为用户显式选择的 opportunistic transport：限定 loopback、验证 live instance/health/capability、token 仅在内存使用、不自动启动、也不与 API Key 自动 fallback。

## 4. 方案比较与决策

| 方案 | 普通 TUI 覆盖 | 凭据风险 | 上游契约 | 用户体验 | 决策 |
| --- | --- | --- | --- | --- | --- |
| 用户提供独立 Kimi Code API Key，低频请求 `/usages` | 完整 | 高；可远程调用模型/消耗额度 | 半公开 / experimental | 一次配置；接口稳定性待验证 | **Phase 0 首发候选** |
| 复用用户已运行的 Kimi Web `/api/v1/oauth/usage` | 仅 Kimi Web | 高权限 local bearer | 官方但 experimental | 必须保持 server 运行 | 不作为首发；未来另评估 |
| 读取 Kimi OAuth credentials 并自行刷新 | 完整 | 高；refresh rotation 竞态 | private package | 看似无配置、故障代价高 | 拒绝 |
| 仅读取当前 access token，不刷新 | 短暂 | 高；仍读取登录 secret | private | 很快失效 | 拒绝 |
| hook / heartbeat / status line 联网查询 | 有 session 时部分覆盖 | 中 | payload 无 quota | 延迟、请求风暴、侵占用户配置 | 拒绝 |
| PTY 抓 `/usage` 或 `-p "/usage"` | 脆弱 | 中 | 非机器契约 | 抢交互、可能耗额度 | 拒绝 |
| 浏览器 cookie + 私有 Billing RPC | 网页月额度可能可见 | 极高 | 私有 web RPC | 易失效、ToS 风险 | 拒绝 |
| 等待 `kimi usage --json` / 公共 usage API | 未来完整 | 最低 | 最佳 | 当前不可用 | 长期替换路径 |

判断标准不是“哪个方案完全没有缺点”，而是“哪个今天可实现、覆盖普通 Kimi Code、不会接管第三方登录凭据、且用户能在 Kimi Console 独立撤销”。当前不存在一个同时满足“普通 TUI 全覆盖、不新增高权 secret、稳定公共契约”的方案。独立 Kimi Code API Key 是唯一广覆盖候选；对已运行 Kimi Web 的用户，本地 REST 是较窄但可能更合适的显式替代。

若 Phase 0 真实 smoke 证明 API Key 不能访问 `/usages`、schema 无法安全解释，或低频第三方查询不被允许，本计划必须停在 blocked，不得自动降级到 OAuth credential、Kimi Web token 或终端 scrape。届时正确行动是推动上游提供结构化契约，而不是把另一种 threat model 偷偷变成 fallback。

## 5. 目标运行时架构

```text
Settings trusted renderer
  -> settings commands: test/save, enable/disable, forget local key
  -> encrypted credential store (ciphertext only)
  -> kimi-quota-runtime (main process, singleflight + backoff)
  -> kimi-quota-transport seam
       -> Phase 1: API-key client (fixed HTTPS origin)
       -> future opt-in: already-running Kimi Web local client
  -> kimi-quota-normalizer
  -> state.updateAccountQuota(null, { kimiQuota })
  -> account quota persistence/snapshot signature
  -> Dashboard + HUD Orbit
```

明确不走：

```text
Kimi hook -> /state -> quota
Kimi credentials -> OAuth refresh
Kimi Web server.token -> local REST
session.update -> quota
```

额度是账户级、session-independent 信息。main process collector 必须直接调用 `state.updateAccountQuota()`；不得为了额度创建假 session，也不得把 `kimiQuota` 塞进 `updateSession()` options。

Phase 1 只产生 local source（`host=null`）。Kimi Code 官方说明多个设备和 API Key 共享账户额度，因此这枚本机 coin 代表所连接 Kimi 账户的全局 Kimi Code 消耗，而不是“这台机器消耗了多少”。Remote SSH、多账户和 profile-specific credential 不在首发范围。

transport seam 只抽象 `fetchUsage({ signal }) -> rawUsage` 和 sanitized status，不抽象认证策略或自动 fallback。每个 transport 必须由用户显式选择，且拥有自己的 threat disclosure、credential store 与 capability test。Phase 1 只有 API-key implementation；保留 seam 是为了未来替换成更稳定的上游 JSON/API，而不是现在同时发布两套实验路径。

API Key 只能证明“这枚 Key 所属账户”的 quota。Clawd 没有公开接口可以证明它与当前 Kimi TUI 的 OAuth 登录账户相同；UI 不得写“当前 CLI 账户额度”。首发不读取 OAuth profile 做账户比对，也不采集账户 PII。

## 6. Secret 与 Settings 事务

### 6.1 新增持久化偏好

新增：

```js
kimiQuotaCollectionEnabled: { type: "boolean", default: false }
```

它只表达“用户授权 Clawd 查询 Kimi Code 额度”的产品意图，不保存 key。该字段应为 command-only：renderer 不能通过通用 `settings:update` 绕过凭据验证直接设为 true。

### 6.2 凭据存储

新增 `src/kimi-quota-credential-store.js`，作为 Kimi quota secret 的唯一读写者：

- 默认路径：`~/.clawd/kimi-code-quota-credential.json`；
- 只保存 version、credential kind、加密密文、非敏感时间戳，以及每次 save/replace 都重新生成的随机 `credentialId`；`credentialId` 不得由 Key 哈希、前后缀或账户信息派生；
- 使用 Electron `safeStorage.encryptString/decryptString`；
- `isEncryptionAvailable() !== true` 时 fail closed；
- Linux `getSelectedStorageBackend() === "basic_text"` 时 fail closed，不能把“可调用 safeStorage”误当成安全加密；
- 原子写入，文件权限尽量收紧；
- 解密失败保留密文供用户稍后重试，不自动覆盖成空文件；
- API Key 永不复制进 prefs、settings snapshot、错误对象或诊断日志；
- secret getter 只在请求作用域内返回，不做进程级明文 cache；
- 删除本地副本必须同步持久化，不能让崩溃重启复活旧 ciphertext。

API Key 不能进入 prefs 还有一个现存代码层理由：`settings:get-snapshot` 当前不是 secret getter，Settings effect 也会把全量 settings snapshot 广播给多个 BrowserWindow。即使未来这些入口收紧，本功能仍以“secret 永不进入 store/snapshot/broadcast”为固定边界，而不是依赖 renderer 当前可信。

`~/.clawd/kimi-quota-runtime.json` 除 polling budget 外，还保存非敏感的 `lastQuotaCredentialId` 和 `lastQuotaCapturedAt`，用于把持久化 quota 与产生它的 credential generation 对账。成功写 quota 的顺序必须是：

1. 用 request 捕获的 `credentialId` 和 generation 再过一次 commit gate；
2. `updateAccountQuota()` 后同步 flush `account-quota.json`；
3. 只有 flush 成功后，才原子记录 `lastQuotaCredentialId/lastQuotaCapturedAt`。

如果 crash 发生在步骤 2 与 3 之间，重启会保守清掉一份其实正确的新 quota；不能反向排序，否则可能把旧账户 quota 错认成新账户。这个取舍优先“暂时无数据显示”而不是“跨账户错标”。

`safeStorage` 只保护 at-rest ciphertext，不保护同一 OS 用户下的恶意进程、运行中的 main-process 内存、受损的受信 Settings renderer、crash dump 或 Electron 本身。Kimi Code API Key 也不是只读 usage token：它可用于模型调用、消耗订阅额度，并可能在 Extra Usage 开启时产生费用。Connect 前必须明确披露这些边界，并建议用户在 Kimi Console 创建易识别的设备专用 key（例如 `Clawd <device>`）。

`src/remote-ssh-identity.js` 已有 safeStorage availability/backend 判定与“暂时不可解密时保留密文”的成熟范例，可以复用设计原则，但不要把 Kimi key 塞进 Remote SSH identity 文件或复用其 schema。

### 6.3 Settings 命令

不要尝试把“secret 文件变化 + prefs boolean 变化”伪装成一个原子 command。当前 `settings-controller` 没有跨文件 transaction/rollback/afterCommit；先写或删 credential 再返回 `commit`，遇到 prefs save 失败或 crash 会产生跨域不一致。首发通过拆分稳定动作来消除这个伪事务：

1. `kimiQuota.testCredential`
   - 接收 renderer 临时传入的 key；
   - 只做内存请求；
   - 返回 `ok / usage-credential-rejected / unavailable / rate-limited` 等非敏感结果；不能把 usage endpoint 拒绝表述成整个 Key 无效；
   - 不保存、不启用。
2. `kimiQuota.saveCredential`
   - 先用候选 key 完成 live test；
   - 如果 collection 已启用，test 成功后先 bump runtime generation 并 abort 旧请求，再原子替换加密文件；
   - candidate save 生成全新的随机 `credentialId`，与 ciphertext 在同一 credential record 中原子替换；
   - replace 失败时旧 ciphertext 必须仍在，并以旧 credential reconcile/re-arm collector；
   - replace 成功后清除旧 Key 所属账户的 local `kimiQuota`、同步 flush/broadcast，再以新 generation 立即刷新，避免把旧账户 quota 暂时标成新连接；
   - 不修改 prefs；replace 失败时保留旧 ciphertext；
   - 首次保存成功但随后 enable 失败，是合法、可恢复的 `configured-disabled` 状态。
3. `kimiQuota.setCollectionEnabled`
   - command-only prefs mutation；enable 前只读确认 credential 可用；
   - command 本身不写 secret、不启动/停止 runtime；
   - commit 成功后的 `settings-effect-router` 才启动或停止 runtime；
   - disable 后清除所有非 `remote:` 来源的 `kimiQuota`，同步 flush 并广播；启动 reconcile 会补偿 effect 后 crash。
4. `kimiQuota.forgetLocalCredential`
   - 只允许在 durable `kimiQuotaCollectionEnabled=false` 时调用；
   - 仅删除 Clawd 本地保存的 ciphertext，不修改 prefs；
   - 删除失败则 key 副本仍在，不能报告成功；
   - UI 明确提示这**不会撤销 Kimi Console 中仍可远程使用的 Key**，并提供打开官方 Console/说明的动作。

Settings 的“Connect”按钮按顺序执行 save -> enable；第二步失败时显示“Key 已安全保存，但采集尚未启用”，允许重试 enable 或 forget。“Disable collection”只执行 disable；用户随后可单独选择“Forget local key”。这个中间状态比跨两个文件的假原子性更容易恢复和解释。

所有 Kimi secret/collection commands 首发共享现有 `lockKey="agentIntegration"`，与 agent install/enable/disable/uninstall 和 About cleanup 串行；不要在同锁 command 内递归调用 `controller.applyCommand()`。若未来 controller 支持有序多域锁，再考虑拆分专用 lock。并发测试必须覆盖 Connect/Replace/Disable/Forget 与 Kimi Uninstall、agent disable、About cleanup。

secret command 必须走 dedicated、trusted Settings IPC。全部 Kimi secret commands 加入 `INTERNAL_SETTINGS_COMMANDS`，只能由受 `isTrustedSettingsEvent()` 保护的专用 handler 转发给 controller；preload 只暴露具名方法，不能接受任意 action name。renderer sender、main frame 和 Settings URL 都必须匹配。输入必须是 string、trim 后非空、长度有小上限，拒绝 CR/LF/NUL 和任何可形成 header injection 的字符；测试超长输入、subframe、错误 URL、旧 Settings window 和 generic command 绕过。

Settings UI 只显示：未配置、已配置但关闭、正在验证、正在采集、manual-only/仅手动刷新、agent-disabled、凭据被 usage endpoint 拒绝、服务暂不可用、persistence-error、clock-invalid、automatic-budget-exhausted。永不把已保存 key 回填 renderer；编辑必须输入新 key，显示值只能是固定占位符，不能返回末四位等衍生指纹。显示对象必须称为“已连接 API Key 所属账户”，不得暗示它一定等于当前 Kimi TUI 的 OAuth 账户。

### 6.4 Gate 与数据生命周期

runtime 运行必须同时满足：

```text
kimiQuotaCollectionEnabled === true
&& isAgentEnabled(snapshot, "kimi-cli") === true
&& credential store 可成功解密
```

`integrationInstalled` 不是技术 gate：它表示 Clawd-managed hook 是否落盘，而 API-key collector 不依赖 hook。`enabled` 仍是 agent 总开关，必须通过 `src/agent-gate.js` 的 canonical helper 判断，不能另写直接字段逻辑。

行为约定：

- agent disable：停止新轮询并 abort in-flight；保留加密 key 和 last-known quota，按现有 stale/retention 规则变暗；
- agent re-enable：quota opt-in 且 credential 可用时恢复轮询；hook 是否重装仍完全遵循既有 integrationInstalled 语义；
- Settings “Disable collection”：关闭 opt-in、停止 runtime、清本地 quota，但保留加密 key；
- Settings “Forget local key”：只在关闭采集后删除 Clawd ciphertext；远端 Key 仍需用户去 Kimi Console revoke；
- Kimi integration uninstall：只删除 Clawd-managed hooks 并按既有规则把 agent 设为未安装/禁用；collector 因 `enabled=false` 暂停，但不静默删除只显示一次的 key；
- About integration cleanup：与 agent lifecycle 共享锁并暂停 collector；不得从纯 Node `hooks/cleanup-integrations.js` 删除 secret。若 About UI 要忘记 key，必须有独立确认和远端 revoke 提示；
- 启动 reconcile：opt-in=false 时定向清除 crash 遗留的 local Kimi quota；opt-in=true 时比较 credential record 的 `credentialId` 与 runtime-state 的 `lastQuotaCredentialId`，本地 quota 存在但 id 缺失/不一致就先 clear+flush，再恢复 runtime；clear persistence 失败则停在 `persistence-error`、只允许 Retry/Test，不得查询并绑定新 quota；key missing/暂不可解密时不联网并显示可恢复状态；
- app quit：abort in-flight，flush account quota；不写任何明文 secret；
- 关闭 `sessionHudShowQuota`：只隐藏 UI，不停止已授权的数据收集，保持与现有 quota UI 开关语义一致。

## 7. 网络 client 合约

新增 `src/kimi-quota-client.js`，依赖注入 fetch、clock 和 timer 以便 hermetic test。

请求必须满足：

- origin 和 path 编译期固定为 `https://api.kimi.com/coding/v1/usages`；
- 不接受用户自定义 base URL，不跟随 redirect；
- `GET`，`Accept: application/json`；
- `Authorization: Bearer <key>`；
- 使用真实、可辨识的 `User-Agent: Clawd/<app-version> KimiQuota/experimental`，不伪装成 Kimi Code；
- 单次 timeout 8 秒；
- response body 上限建议 64 KiB；超过即拒绝；
- 只在 2xx 且 body 为 JSON object 时进入 normalizer；
- 错误只记录 status class、request id（若非敏感）和归一化 error code；不记录 URL query、header、raw body 或 exception 中可能携带的 request dump；
- 若 runtime 使用的 fetch 实现不能保证 `redirect: "error"`、abort 和 body 上限，需在实现前改用更可控的 Electron/Node HTTPS primitive，而不是放宽约束。

错误语义：

- `400`：标记 `incompatible-response` 并 terminal stop，保留缓存，等待手动 retry 或应用更新；
- 2xx schema mismatch：第一次退避 15 分钟、第二次 60 分钟；同一 app version/transport 连续第三次进入 `incompatible-response` terminal stop。任一成功 response 清零计数；计数写入非敏感 runtime-state，app restart 不能绕过；
- `401`：标记 `usage-credential-rejected`，停止周期轮询并保留缓存；不能断言整个 API Key 无效，因为它可能仍可调用模型、只是没有 usage endpoint scope；
- `402`：会员权益暂时无法验证，保留缓存并退避；
- `403`：保留缓存并长退避；只有受严格 schema/size 限制的已知 `access_terminated` error code 才进入 terminal status，普通 403 不能直接认定 weekly=100%；
- `404`：标记 `unsupported-or-moved`，停止自动轮询，等待用户手动 retry 或应用更新；
- `429`：解析 delta-seconds 和 HTTP-date 两种 `Retry-After`；绝不早于服务端要求重试。超过 24 小时的值进入 manual-retry 状态，而不是向下截短；无合法 header 才走指数退避。不能直接把任一环设为 100%，因为服务过载、并发限制和额度限制都可能返回 429；
- `5xx`、DNS、TLS、timeout、offline：保留缓存，指数退避；
- malformed 2xx：保留缓存，记录无响应内容的诊断 reason；
- 所有失败都不得更新 session state、触发 permission bubble 或伪造 Kimi notification。

官方错误参考：

- [Kimi Code Error Reference](https://www.kimi.com/code/docs/en/kimi-code/error-reference.html)

## 8. Normalizer 与 presence-aware 更新语义

新增 `src/kimi-quota-normalizer.js`（若未来 remote hook 需要复用，再评估移动到 `hooks/`；首发不把 main-only helper登记进 remote `HOOK_FILES`）。

canonical fields：

```js
const KIMI_QUOTA_FIELDS = ["kimiFiveHour", "kimiWeekly"];
```

转换规则：

1. 数值仅接受 finite decimal number 或符合明确 grammar 的完整 decimal string；空字符串、exponent、hex、Infinity、NaN、前后垃圾和对象全部拒绝；
2. 要求 `limit > 0`、`used >= 0`；负 used 不能靠通用 clamp 伪装成 0%；
3. 有有效 `used` 时使用 `used`；仅有 `remaining` 时要求 `0 <= remaining <= limit` 并计算 `used=limit-remaining`；两者都有时用 decimal-safe 运算校验 `used + remaining == limit`（允许的绝对误差固定为 `1e-6 * max(1, abs(limit))`），冲突则拒绝该候选 bucket；
4. `usedPercent = used / limit * 100`，最终由通用 quota normalizer round/clamp 到 `[0, 100]`；
5. `usage` 只映射为 `kimiWeekly`；
6. `limits[]` 仅将规范化后恰好 300 分钟的窗口映射为 `kimiFiveHour`，兼容 `300 MINUTE` 与 `5 HOUR` 的等价表达；
7. 未知 time unit、未知窗口和未知字段忽略；完全相同的重复 5h 可 dedupe，内容冲突则整次 response fail closed，不能凭数组顺序选一个；
8. candidate presence 是可测试的 own-property/schema 规则：`usage` own-property 存在但为 null/非 object，或其 used/remaining/limit/resetTime 坏掉，即 weekly malformed；`limits` 存在但非 array，即 response malformed；数组项一旦能识别为 300m/5h window、其 detail 坏掉，即 5h malformed；空 `limits` 或只有未知 window 表示 5h absent。weekly/5h candidate **存在但 malformed** 时整次 response 失败并保留 last-known，不能降级成“本次没报告”；
9. `resetTime` 必须解析为有限 epoch-ms；明显已过期或超过 store 45 天上限的 bucket 会被现有 store 拒绝；
10. 同一成功响应中的 bucket 共享 `capturedAt=Date.now()`；
11. 至少有一个有效 bucket 才算成功 quota response；
12. `boosterWallet`、`totalQuota` 和所有未知字段不进入 canonical object、snapshot、persistence 或日志。

输出：

```js
{
  kimiFiveHour: {
    usedPercent,
    windowMinutes: 300,
    resetAt,
    capturedAt
  },
  kimiWeekly: {
    usedPercent,
    windowMinutes: 10080,
    resetAt,
    capturedAt
  }
}
```

上游没有承诺“bucket 缺失等于服务端删除”，experimental endpoint 也可能偶发漏字段。因此 Kimi 首发采用 presence-aware partial update：本次明确出现且合法的 bucket 更新；本次未出现的 sibling 保留原 `seenAt`，自然变 stale，并在自己的 `resetAt` 过期后由现有 store dim/drop。这样不会因为一次 weekly-only 响应误删仍有效的 5h 缓存。

Phase 0 应连续采样并记录 bucket presence 行为。如果未来取得稳定上游“完整快照”契约，再单独把 Kimi 切到 complete policy。首发不需要改动 Codex/Spark 的 `completeWhenWindowAware(group)` 特例；只把 `kimiQuota` 注册为普通 provider，避免为未证实的 completeness 顺手重构 store。所有 bucket 仍携带同一 `capturedAt`，现有 per-bucket 乱序拒绝继续生效。

## 9. Poll runtime 合约

新增 `src/kimi-quota-runtime.js`，由 `main.js` 创建并持有。

状态机至少包括：

```text
disabled
unconfigured
ready
refreshing
backoff
usage-credential-rejected
incompatible-response
unsupported-or-moved
persistence-error
stopped
```

调度约定：

- runtime 有两个编译/发布模式：`manual-only` 与 `periodic-approved`。Phase 0 没拿到 Kimi 对 quota background polling 的公开或书面许可时，发布模式必须是 `manual-only`：只有用户点击 Test/Refresh/Connect 才能请求，app ready、hook、resume、Dashboard show 都不能隐式联网；
- `periodic-approved` 只有政策 gate 通过才可启用：app ready 延迟首次刷新；最近 30 分钟有 accepted Kimi hook 活动时，成功 cadence 固定为 5 分钟加稳定 per-install jitter `[-30s,+30s]`；无近期活动时为 30 分钟加 `[-3m,+3m]` jitter。Dashboard show/resume 可触发一次刷新，但不会独自把 runtime 长期维持在 active cadence；
- Kimi hook 活动、app resume、Dashboard show、用户手动 refresh 必须尊重 `backoffUntil` 和 singleflight；automatic triggers 还受最短成功间隔与 rolling budget。hook 只当 trigger，不提供 quota data；
- Kimi provider stale grace 固定 7 分钟，满足 `5m + 30s max jitter + 1m lastSeenAt quantization + 8s timeout < 7m`；具体落点见 §10.3 的两份 renderer policy。inactive 30 分钟或 manual-only 模式下变 stale 是有意的 last-known 语义；
- automatic budget 是持久化 rolling-24h deque/token bucket，默认上限 192 次；这是刻意低于全天 active 5 分钟 cadence 的二级 circuit breaker（全天理论值 288），正常约 8h active + 16h inactive 约 128 次，异常连续活跃约 16h 后会触顶。保存在不含 secret 的 `~/.clawd/kimi-quota-runtime.json`，原子写，app restart 不重置。每次 automatic attempt 在发请求前占用名额；24 小时后释放。预算耗尽时显示下次恢复时间，不静默变 stale；
- runtime state 持久化 `maxObservedWallClock/lastQuotaCapturedAt`。检测到显著 clock rollback 或 `now < lastQuotaCapturedAt` 时冻结 automatic polling，并在发请求前拒绝会写 quota 的 manual Refresh，显示 `clock-invalid`；只读 `testCredential` 仍可执行但不得写 account store。这样不会让 2xx manual response 被 `capturedAt` 乱序规则静默丢弃；
- 同一 credential generation 只允许一个 in-flight request；所有触发合并到 singleflight；
- 失败按 1m、2m、5m、15m、30m、60m 上限退避；成功归零；
- `Retry-After` 支持 delta-seconds/HTTP-date，绝不提前；异常超长值进入 manual-retry；
- disable、forget、credential replacement、agent disable、app quit 都 bump generation 并 abort in-flight；旧 generation 即使晚到也不得写 state；
- 已知 resetAt 刚越过后，可以在 30–90 秒 jitter 后请求一次刷新，但仍受 backoff 和 budget 限制；
- timer 必须 `unref()`（可用时），不能阻止退出；
- runtime 状态只向 Settings 暴露非敏感摘要，不进入 session snapshot，避免额度 polling 状态制造 HUD 广播。

post-commit effect 只负责快速 start/abort/reconcile，不是安全上的唯一 gate。每次 request admission 和每次 response commit 前，runtime 都必须重新读取 canonical `kimiQuotaCollectionEnabled + isAgentEnabled + credential generation + feature/policy mode`；任一不满足就不发请求/不写 state。这样即使 `settings-effect-router` 的通知丢失或抛错，durable opt-out 后也不会继续联网，late response 也不能复活 quota。

首发不为此功能新增一个会收集客户端状态的 remote-config 服务。紧急停止能力由三层提供：用户 opt-out、packaged/local feature kill switch（测试覆盖）以及 404/schema-incompatible 的自动 terminal stop；若上游明确要求停止第三方 polling，必须通过应用更新默认关闭，不能继续依赖历史成功结果。

具体接点：Kimi accepted hook activity 在 `main.js` 的 accepted hook recorder 触发；Dashboard show 在 `src/dashboard.js`；resume/wake 复用 main 的 powerMonitor lifecycle。首发不把 Orbit hover/visibility改成隐式高频 trigger。safeStorage reconcile 和 runtime start 必须位于 `app.whenReady()` 之后、Settings 可操作 secret 之前；Settings show 也调用一次幂等 `runtime.reconcile()`，补偿 enable post-commit effect 丢失的 liveness（manual Refresh 始终可按 canonical gate lazy-reconcile）。quit 顺序是先 stop/bump/abort runtime，再 flush state。runtime 必须自行移除 power/event listeners，重复 start/stop 保持幂等。

每次成功通过 main-only durable commit seam 执行：

```js
const result = state.commitLocalKimiQuota(kimiQuota);
if (result.persisted) {
  runtimeState.bindQuotaToCredential(credentialId, capturedAt);
}
```

`persisted=false` 时保留当前进程内 last-known/new value均可，但必须显示 persist warning、不得推进 binding；重启会因 credentialId mismatch 保守清理，绝不能把未落盘 quota 标成已绑定。

不得通过 `/state` HTTP route 回灌本机额度；不得修改 `hooks/kimi-hook.js` 的 100ms fire-and-forget 路径。

## 10. Account store、snapshot 与 UI 改动

### 10.1 Store 与 state

- `src/state-account-quota.js`
  - 引入 `KIMI_QUOTA_FIELDS`；
  - 注册 `kimiQuota` provider；
  - Kimi 使用现有 partial/presence-aware merge；不改变 Codex/Spark 的 window-aware complete 特例；
  - 让 `persistNow()/flush()` 返回可观察的 success/failure；当前实现吞写盘错误并返回 undefined，无法满足 credentialId 的 flush-before-binding 顺序；
  - 保持 source cap、reset plausibility、retention、atomic persistence 和 mergeSources 语义；
  - 单纯增加向后兼容 provider 不要求为了凑数 bump persistence schema；若实现引入迁移则单独论证。
- `src/state.js`
  - 暴露新的 `clearLocalKimiQuota()`，返回 `{ cleared, persisted }`；不要改变既有 `clearLocalClaudeQuota()` 的 number 返回 contract；
  - 提供 main-only `commitLocalKimiQuota(kimiQuota)`：update 后同步 flush，返回 `{ accepted, persisted }`；runtime 只有在 `persisted=true` 后才能推进 `lastQuotaCredentialId`；
  - collection disable/启动 opt-out reconcile 清除所有非 `remote:` Kimi provider，同步 flush 并广播；
  - 不修改 session model。

### 10.2 Snapshot

- `src/state-session-snapshot.js`
  - `quotaAgentIcons.kimiQuota = iconFor("kimi-cli")`；
  - `sessionSnapshotSignature()` 显式加入 `kimiQuota.group/lastSeenAt`。

后者是合并阻断项：如果只把 `accountQuota` 深拷贝到 snapshot、却不更新 signature，Kimi 数值或 freshness 的后续变化可能被 dedup 吞掉，renderer 不刷新。

### 10.3 Orbit

- `src/quota-ring-geometry.js` 和 `src/quota-ring-renderer.js`
  - 同步注册 `kimiQuota`；
  - outer=`kimiFiveHour`，inner=`kimiWeekly`；
  - 使用现有 `assets/icons/agents/kimi-cli.png`；
  - 明确 glyph zoom，不依赖默认碰巧合适；
  - 保持 geometry/renderer provider 顺序一致。
- `src/quota-ring.html`
  - 为 Kimi 增加独立 outer/inner identity token 和 selector；
  - 做正常色觉与常见 CVD 模式人工 QA，不能只靠 hue 区分；glyph 始终保留 provider identity。

Orbit 当前可见上限为四枚 coin。Kimi 加入后，本机四 provider 恰好达到上限；多 source 继续使用现有 `+N` overflow，不在首发扩大窗口或改变布局。

Kimi stale grace 的实现落点必须是 **per-provider renderer policy**，不是 runtime 常量，也不能把全局 5 分钟统一改成 7 分钟：

```js
const DEFAULT_QUOTA_STALE_AFTER_MS = 5 * 60 * 1000;
const PROVIDER_STALE_AFTER_MS = Object.freeze({
  kimiQuota: 7 * 60 * 1000,
});
```

`src/quota-ring-renderer.js` 与 `src/dashboard-renderer.js` 运行在不同浏览器上下文，不能依赖 require 同一个 main/CommonJS module；两处各镜像同名表和 fallback helper，所有 stale 判断都按 provider key 取阈值。增加 source-contract test 同时读取两份表，断言 key/value 完全一致，并断言未列 provider 仍为 5 分钟。不要通过 snapshot 注入阈值，避免把静态 UI policy 变成 session/account schema。

### 10.4 Dashboard 与文案

- `src/dashboard-renderer.js`：新增 Kimi Code section；
- `src/i18n.js`：Dashboard/Orbit 的 en / zh / zh-TW / ko / ja / pt-BR 同时补齐：
  - Kimi Code；
  - 5-hour window；
  - weekly；
  - experimental；
  - last confirmed / stale；
  - “Does not include the shared monthly Kimi membership quota”；
- `src/settings-i18n.js`：Settings 的六语言补齐 Connect、Replace key、Disable collection、Forget local key、Retry、endpoint rejected、agent disabled、manual-only、persistence/clock/budget 状态、remote revoke warning；
- Settings quota card 提供 Connect、Replace key、Disable collection、Forget local key、Retry；
- usage credential rejected/offline 只进入 Settings 的 sanitized status channel；Dashboard 只消费 account quota snapshot，显示 `lastSeenAt` 和静态范围警告，不把 runtime status 偷塞进 session snapshot；
- 若 403/耗尽态下 usage endpoint 自身不可读，Dashboard/Settings 只能写“额度可能已满，但当前无法确认”，保留 last-known 和时间戳；不得把 last-known 强行改成 100%；
- UI 不显示 API Key 指纹、余额或 raw error body。

## 11. 文件级实施清单

预计新增：

- `src/kimi-quota-client.js`
- `src/kimi-quota-normalizer.js`
- `src/kimi-quota-credential-store.js`
- `src/kimi-quota-runtime.js`
- 对应的四组 unit tests

预计修改：

- `src/main.js`
- `src/prefs.js`
- `src/settings-actions.js`（也可以拆成 `settings-actions-kimi-quota.js`，避免主文件继续膨胀）
- `src/settings-ipc.js`
- `src/settings-ui-core.js`
- `src/settings-tab-general.js`
- `src/settings-renderer.js`
- `src/preload-settings.js`
- `src/settings-i18n.js`
- `src/settings.css`
- `src/settings-effect-router.js`
- `src/state-account-quota.js`
- `src/state-session-snapshot.js`
- `src/state.js`
- `src/quota-ring-geometry.js`
- `src/quota-ring-renderer.js`
- `src/quota-ring.html`
- `src/dashboard.js`（Dashboard show trigger）
- `src/dashboard-renderer.js`
- `src/dashboard.html`（若 Experimental/月额度警告不能复用现有 quota 样式）
- `src/i18n.js`
- 相关 test fixtures / browser-env snapshots
- `docs/project/agent-runtime-architecture.md`
- `docs/project/theme-state-ui.md`
- `docs/guides/setup-guide.md` 或独立 Kimi quota 用户指南
- 根 `AGENTS.md` 的 Kimi/额度约束摘要

首发不修改：

- `hooks/kimi-hook.js`
- `hooks/kimi-install.js`
- `src/server-route-state.js`
- `src/remote-ssh-deploy.js` 的 `HOOK_FILES`
- `hooks/cleanup-integrations.js` 的纯 Node secret 删除逻辑
- Kimi permission automation policy
- Kimi session ID / process detection

必须审计并覆盖集成测试、但预计不改生产行为的 owner：

- `src/settings-controller.js`：复用 command-only commit 与 lock，不新增跨文件 transaction；
- `src/settings-actions-agents.js`：现有 install/disable/uninstall 的 `agentIntegration` lock 和 agent commit；
- `src/agent-gate.js`：只消费 canonical `isAgentEnabled()`，不另造 gate；
- `src/settings-actions.js` 的 About cleanup owner：共享 lock 后只暂停，不静默删 secret；
- `hooks/cleanup-integrations.js`：继续只负责纯 Node hook/plugin cleanup，绝不接触 Electron safeStorage secret。

若实现过程中发现必须修改这些 non-goal 文件，先回到计划审查，不能以“顺手”扩大信任边界。

## 12. 测试计划

### 12.1 Normalizer

1. `used/limit`、`remaining/limit` 为 number 和 decimal string；
2. 300 minute 与 5 hour 都映射 5h；
3. `usage` 映射 weekly；
4. resetTime 时区与 epoch-ms，包含论坛实样 `2026-03-09T11:16:04.416717Z` 的微秒+Z；candidate 缺 resetTime 按 malformed 整次 fail closed；
5. `limit=0`、used/remaining 负数、remaining>limit、NaN、Infinity、空字符串、exponent、partial numeric string 拒绝；
6. `remaining=0`、`remaining=limit`、used+remaining 在固定 `1e-6` 相对容差内通过，超出容差 fail closed；used 超 limit 后经通用 normalizer clamp；
7. 未知窗口、单位和字段忽略；
8. 冲突重复 5h fail closed；
9. `usage` null/坏字段、`limits` 非数组、recognized 5h detail malformed 都整次失败；空 limits/unknown-only limits 表示 5h absent；只有一个明确出现且有效的 bucket 时只更新该 bucket，缺失 sibling 保留旧 seenAt；
10. `boosterWallet`、`totalQuota` 不进入输出。

### 12.2 Client 与 secret

1. 精确 method/origin/path/headers/User-Agent；
2. redirect 拒绝、timeout、abort、body size cap；
3. 2xx malformed、400、401、402、403/access_terminated、404、429、5xx、offline 分类；
4. `Retry-After` delta-seconds/HTTP-date、绝不提前、超长转 manual；
5. 所有错误对象和日志无 key、Authorization、raw body；
6. safeStorage unavailable / Linux `basic_text` fail closed；
7. encrypted round-trip、随机非衍生 credentialId、atomic replace、decrypt failure 保留密文；
8. save/replace 新 key test 或 atomic replace 失败时旧 key 不丢；
9. enabled 状态 replace：candidate test -> bump/abort -> 新 credentialId+ciphertext 原子 replace；失败 re-arm old collector，成功清旧 quota 并立即刷新新 generation；旧 response 晚到不写 state；
10. enable prefs save 失败留下 configured-disabled，不启动 runtime；disable prefs save 失败不停止 runtime；forget 仅允许 durable off 且删除失败保留 ciphertext；
11. commands 与 agent disable/uninstall/About cleanup 共享 lock，无嵌套 controller deadlock；
12. locked/future prefs 拒绝 secret/enable mutation；
13. generic command、subframe、错误 URL、旧窗口、CR/LF/NUL、超长 key 全部拒绝；
14. settings snapshot、prefs、account-quota file 中搜索不到测试 secret。

### 12.3 Runtime

1. gate 全组合：opt-in / canonical enabled / credential；证明 integrationInstalled 不影响 collector 技术 gate；
2. singleflight 与活动触发 debounce；
3. manual-only 无 app/hook/resume/dashboard 自动请求；periodic-approved 才启用 active 5 分钟 / inactive 30 分钟 cadence和精确 jitter；
4. backoff 和成功复位；
5. 401/404 停止周期轮询、402/403/429/backoff 保留 last-known；
6. collection disable/agent disable/forget/key replacement bump generation；
7. abort 后的 late response 不得写 state；
8. retry 不创建 session、不改宠物状态、不弹 bubble；
9. quit 清 timer/abort request；
10. runtime 状态不制造 session snapshot 广播风暴；
11. hook/dashboard/resume trigger 不绕过 backoff/budget；resetAt 后 jitter refresh；
12. rolling-24h budget 持久化、restart 不重置、192 次二级 throttle、clock rollback freeze、预算恢复时间；rollback 时 Refresh 不发请求/不写 store，Test 仍可只读执行；
13. settings-effect-router 通知丢失/抛错时，request admission/response commit gate 仍阻止 durable opt-out 后联网或写 quota；
14. enable effect 丢失时 manual Refresh 可 lazy-reconcile，Settings show/app restart 的 reconcile 会恢复 periodic；
15. credentialId 对账与 crash injection：replace ciphertext 后清 quota 前 crash；account-quota flush 后 runtime binding 前 crash；binding 成功后重启；id missing/mismatch 必须先 clear+flush；
16. account-quota persist failure 不推进 binding、显示 sanitized warning，重启 mismatch 清理；
17. app-ready、重复 start/stop、listener cleanup、quit ordering。

### 12.4 Account quota 与 snapshot

1. `kimiQuota` provider 白名单、持久化/reload、deep clone；
2. presence-aware Kimi update 不移除缺失 sibling；旧 sibling 保持原 seenAt 并按 resetAt/stale/retention 退出；
3. capturedAt 乱序旧快照拒绝；
4. Codex/Spark completeWhenWindowAware 与 Claude/Antigravity partial 行为不回归；
5. clearProvider 只清 Kimi，不碰其他 provider；
6. local clear 保留未来 `remote:` source；
7. mergeSources 按 bucket freshest 语义；
8. expired/dim/drop/retention；
9. Kimi group 或 lastSeenAt 变化必定改变 snapshot signature；
10. Kimi icon URL 注入且 snapshot 保持不可变。
11. account quota `persistNow/flush` 成功/失败返回值，以及 `commitLocalKimiQuota` 的 flush-before-binding contract。

### 12.5 UI

1. Kimi 一枚 coin 双环；
2. outer=5h、inner=weekly；
3. used / remaining 两种显示模式；
4. expired、stale、missing single bucket；
5. 四 coin 上限与 `+N` overflow；
6. Kimi glyph zoom、CSS identity selectors；
7. Dashboard section 与重置时间；
8. 六种 locale key 完整；
9. Settings Connect/Replace/Disable/Forget/endpoint-rejected/agent-disabled/offline；
10. Kimi per-provider stale=7m、其他 provider default=5m；quota-ring/dashboard 两份 policy key/value 镜像一致，健康 5m+jitter collector 不闪 stale；
11. untrusted renderer 不能调用 secret IPC；renderer 永远拿不到保存的 key。

### 12.6 真机与发布门

Phase 0 Windows smoke（实现前）：

1. 用户在 Kimi Code 控制台创建专用测试 API Key；
2. 用最终计划的真实网络 stack、真实 `Clawd/...` User-Agent 和固定 endpoint 请求 `/usages`；禁止把 key 写入 shell history、repo、日志或 test fixture；
3. 在账户静默窗口关闭其它设备/TUI 活动后连续 2–3 次 GET，按合理间隔比较 used 序列，确认查询本身不明显消耗 quota，并冻结 `used`/`remaining`/`limit`、微秒+Z resetTime、window 和 bucket presence shape；
4. 对照真实 Kimi Code `/usage`，确认 5h/weekly used、limit、reset；
5. 审查 interactive-use policy：取得上游公开/书面 polling 许可才允许 `periodic-approved`；未取得许可时技术 smoke 仍可支持 `manual-only`，不得用“接口返回 2xx”推导后台自动化许可；
6. 在 Kimi Console 撤销测试 key，确认 usage endpoint 拒绝且不会影响 Kimi OAuth 登录；不能把删除 Clawd 本地副本写成 revoke；
7. 尽可能在 5h 接近/达到耗尽时验证 `/usages` 是否仍为 2xx；若只返回 403，记录“耗尽态不可观测”残余风险和 UI 文案，不能把 403 合成 100%；
8. 向上游确认 membership 中“30 天不活跃自动解绑”是否影响 API Key；未确认则保留为 residual risk，并验证 usage-credential-rejected 恢复路径；
9. 记录 usage endpoint 实际 429 是否提供 Retry-After；没有 header 时只依赖本地 backoff，不能把防御性支持写成上游保证；
10. 保存脱敏 shape、status 和时间单位作为调查记录，不保存任何 header、账户标识或金额。

实现后：

- `npm test`；
- `npm run verify:electron`；
- packaged Windows x64 smoke：safeStorage、Settings secret flow、app restart、disable/forget/revoke copy；
- 真实 Kimi Code API Key 对照 `/usage`；
- 断网、sleep/resume、401、429、Kimi 未启动、Clawd 重启；
- 人工检查 Orbit/Dashboard 颜色和全部语言；
- macOS/Linux 只能做 code-review-first 时，必须明确记录 manual QA pending；不能把 Windows smoke 外推为全平台验证。

## 13. 分阶段落地

### Phase 0 — 上游契约 smoke（合并任何产品代码前）

- 真实验证 Kimi Code API Key 可调用 `/usages`；
- 连续采样并冻结 API-key transport 的 used/remaining、窗口和 presence shape；
- 在账户静默窗口验证 GET 自身不明显消耗 quota；能到达时验证耗尽态 `/usages` 是否仍可读；
- 确认调用不需要伪造 Kimi Code User-Agent；
- 确认真实 UA 查询技术上可用，并单独审查 [Kimi Code Community Guidelines](https://www.kimi.com/code/docs/en/kimi-code/community-guidelines.html) 的 interactive-use 边界；只有取得上游公开或书面确认时才能发布 `periodic-approved`，未取得确认则强制 `manual-only`，明确禁止则整个 API-key product path blocked；确认 API Key 可在 Console 独立撤销；
- 确认或记录 30 天不活跃解绑是否作用于 API Key、usage endpoint 的 401/403 实际分工，以及 429 是否提供 Retry-After；
- endpoint/auth/schema/真实-UA 技术 gate 失败则整个 API-key path blocked；polling policy 未确认则只阻断 periodic mode，保留 manual-only；两种情况都不启用其他隐式 fallback。

### Phase 1 — 隔离模块（不生产启用）

- 完成四个隔离模块和 hermetic tests；
- 不接 UI、不启动生产轮询；
- 先完成 secret redaction 与 generation/abort tests。

### Phase 2 — account store 与 snapshot（仍隐藏）

- 注册 presence-aware Kimi provider，不改 Codex complete policy；
- 加 clear lifecycle 和 snapshot signature；
- 完成跨 provider 回归。

### Phase 3 — controller、main runtime 与 lifecycle（feature flag 隐藏）

- trusted secret commands；
- agentIntegration shared lock、command-only opt-in、post-commit effects；
- main app-ready/start/stop/trigger/quit 接线；
- agent disable/uninstall/About cleanup 的暂停与保留-secret 语义；
- 启动 opt-out/cache reconcile；
- UI 仍不公开。

### Phase 4 — Settings、Dashboard、Orbit 与真机开放

- opt-in card 与专用 trusted preload/IPC；
- Dashboard/Orbit/i18n/CVD；
- packaged Windows smoke；
- 真实 `/usage` 对照；
- 更新架构与用户文档。

### Phase 5 — 上游稳定接口迁移准备

- 记录 upstream feature request：`kimi usage --json` 或公开 usage API；
- client/normalizer 保持 seam，使未来能替换 transport 而不改变 account store/UI；
- 一旦上游提供稳定结构化接口，另开迁移计划，不能在同一 release 静默切换认证模型。

## 14. 合并与发布完成条件

所有条件同时满足才能称为“支持 Kimi Code 额度环”：

1. 真实 Kimi Code API Key smoke 通过，且与 `/usage` 数值/重置时间一致；
2. secret 只以安全密文落盘，untrusted renderer 无法读取或写入；
3. 日志、prefs、snapshot、account quota persistence 和 test artifacts 均无 secret；
4. normalizer 覆盖 API-key 实测的 used/remaining shape，对未来字段 fail closed，不把未知窗口画错；
5. Disable collection 停止联网并同步清本地 quota；Forget 只删除 Clawd ciphertext，UI 明确远端 Key 必须在 Kimi Console 另行 revoke；uninstall/About 不静默制造 orphan key；
6. collection disable、agent disable、forget 和 credential replacement 后 late response 不可复活旧数据；
7. Kimi quota 变化参与 snapshot signature；
8. Kimi presence-aware、Codex/Spark completeWhenWindowAware 与 Claude/Antigravity partial merge 无回归；
9. Orbit、Dashboard、Settings 和六语言测试齐全；
10. `npm test` 与 `npm run verify:electron` 通过；
11. Windows packaged smoke 通过；未执行的平台明确列 residual risk；
12. 用户文档醒目标出 Experimental、5h/weekly 范围、月额度缺口、API Key 的模型调用/Extra Usage 风险，以及“forget local copy ≠ Console revoke”；
13. 未取得上游 polling 许可时构建/发布强制 manual-only 且无隐式请求；取得许可后，active/inactive cadence、stale grace、backoff、jitter 和持久化 rolling budget tests 证明不会闪烁或无界轮询；
14. API Key、collection 和 agent lifecycle 共用锁；credentialId/quota binding、replace handoff、effect failure、并发/locked prefs/persist failure/crash-reconcile tests 通过；
15. Kimi per-provider stale policy 在 quota-ring/dashboard 两处镜像一致，其他 provider 保持 5 分钟；
16. 耗尽态不可观测、30 天解绑和 Retry-After 若未能实测，必须作为 release residual risk 与用户文案记录，不能默认为已支持。

## 15. 非目标

- 不读取或修改 Kimi OAuth credential；
- 不支持 Kimi Web 月度会员池；
- 不显示 Moonshot Open Platform 余额；
- 不显示 Extra Usage 金额；
- 不自动启动 `kimi web`；
- 不在首发实现 Kimi Web transport，也不在 transport 之间自动 fallback；
- 不抓取 TUI `/usage`；
- 不修改 Kimi hook 事件集或 permission 行为；
- 不在 Phase 1 支持 legacy Python `~/.kimi`、WSL、Remote SSH 或多 Kimi 账户；
- 不把 Kimi 加入任何新的 permission automation eligibility；
- 不因为已有 Kimi icon 就省略颜色/布局/CVD QA；
- 不把 generic 403/429 当成 quota exhausted。

## 16. 残余风险

1. `/usages` 仍是 experimental contract，上游可能改 endpoint、字段或 API Key 权限；client 必须在 schema drift 时保留 last-known 并提示 unavailable，而不是猜测。
2. 独立 API Key 仍具模型调用能力，不是只读 token；即使可撤销，也必须按 secret 保护。
3. Kimi 网页月度共享池不可见，两个环健康时仍可能被月池阻断；产品文案只能降低误解，无法消除信息缺口。
4. Kimi Code 可跨设备共享额度；轮询值可能在本机无活动时变化，这是正确行为，不能当异常过滤。
5. safeStorage 在部分 Linux 环境不可安全使用；首发宁可显示“安全存储不可用”，不能明文 fallback。
6. 四枚 coin 达到当前 Orbit 可见上限；以后再加第五个 ring provider 时必须重新评估默认排序和 overflow UX。
7. Clawd 只能忘记本地 ciphertext，不能通过 API 撤销远端 Key；用户若遗漏 Console revoke，远端 secret 会继续有效。
8. Clawd 无法证明 API Key 账户等于当前 Kimi TUI OAuth 账户；UI 只能描述“已连接 Key 所属账户”。
9. 耗尽时 usage endpoint 可能自身返回 403；若 Phase 0 无法证实耗尽态仍可读，环可能停在 last-known 而到不了 100%，UI 只能提示“可能已满但无法确认”。
10. membership 文档的 30 天不活跃自动解绑明确描述 devices，但是否包含 API Key 未证实；长期 manual-only 用户可能突然进入 usage-credential-rejected，需要重新连接/确认。
11. manual-only 下 stale 是正常状态；用户仍可能把 last-known 误读为实时值，必须始终显示 last confirmed 时间和模式标签。
12. budget、backoff、clock rollback、schema terminal 的交互面较大；设计优先让数据变旧/消失而不是显示错误数据，因此排障可能更依赖 Settings sanitized status。

## 17. Review 记录

2026-08-14 完成三路独立 subagent review：

1. **官方接口与认证审阅**发现两个 P0：第一方源码只直接证明 OAuth access token，API Key 仅有官方论坛的 experimental 示例；论坛的 `remaining/limit` 又与当前 OAuth client 的 `used/limit` 不同。修订后 API Key 降为 Phase 0 候选，normalizer 同时支持并交叉校验 used/remaining，Phase 0 必须冻结真实 API-key schema。
2. **Clawd 架构审阅**指出原 connect/disconnect 横跨 credential file 与 prefs，却错误宣称原子；现 controller 没有 rollback/afterCommit。修订没有为单一功能扩展复杂 controller transaction，而是拆成 save、command-only enable/disable、forget 三个稳定动作，合法暴露 configured-disabled 状态，并用 `agentIntegration` shared lock 消除 lifecycle 竞态。
3. **Red-team 替代方案审阅**确认：今天不存在同时覆盖普通 TUI、不新增高权 secret、又有稳定公共契约的严格更优单路线。已运行 Kimi Web 的用户存在局部更优的 local transport，但其 bearer 拥有文件/shell/session 权限且覆盖有限；计划保留显式 transport seam，不在首发扩 scope或暗中 fallback。
4. **完整快照分歧**：仓库审阅最初建议把 Kimi 设为 complete provider；官方契约审阅指出上游从未承诺“缺失即删除”。最终采用更保守的 presence-aware partial update，依靠每 bucket seenAt/resetAt/stale/retention 退出旧值，不重构 Codex/Spark policy。
5. **轮询与 secret 文案**：增加 active/inactive cadence、Kimi stale grace、jitter、预算、完整 Retry-After；明确 API Key 可调用模型/产生 Extra Usage、safeStorage 只保护 at rest、forget local copy 不等于 Console revoke，且 Key 账户不保证等于当前 TUI 账户。
6. **Closure review** 进一步要求把技术可用与自动化许可拆开：无上游公开/书面 polling 许可时只能发布 manual-only；同时固定 replace-key generation handoff、每次 admission/commit 复查 durable gate、schema mismatch 三次 terminal 规则、candidate presence grammar，以及跨重启 rolling budget。
7. **外部 Claude 独立对抗审查**未发现 P0，并新增三条 P1：credential replacement crash 后的跨账户 quota 错标、Kimi stale grace 缺少 renderer 实现落点、论坛示例漏抄 resetTime。修订后用随机 credentialId + flush-before-binding 对账保证 crash 时最多清掉正确数据而不跨账户错标；在 quota-ring/dashboard 两处镜像 per-provider stale policy 并加一致性测试；补回论坛的微秒 RFC3339 resetTime，并把已知 wire 差异收窄为 used vs remaining。审查提出的耗尽态、30 天解绑、192 次预算、clock rollback、quiet-window smoke、snapshot 暴露面和 enable effect liveness 也已纳入 Phase 0、测试或残余风险。

审阅后仍保留两个外部 gate：其一，用真实专用 Kimi Code API Key 验证 endpoint 权限、wire shape、GET 不消耗额度和真实 Clawd User-Agent；其二，后台周期 polling 必须取得上游公开/书面许可，否则只能发布 `manual-only`。技术 gate 失败或政策明确禁止时，不得转向 OAuth、cookie、TUI scrape 或隐式 Kimi Web fallback。
