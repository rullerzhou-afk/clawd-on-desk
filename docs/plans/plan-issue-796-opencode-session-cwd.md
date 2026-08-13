# Issue #796 OpenChamber 多目录重复初始化下的 OpenCode session cwd 归属修复计划

制定日期：2026-08-03

状态：**v3，Claude 第二轮复审 GO；实现与 macOS 打包闭包已完成；独立子代理复审 GO；待 Windows 11 + OpenChamber 真机验收**

Issue：[#796 HUD shows wrong project path for active session when multiple plugin instances share the same session id](https://github.com/rullerzhou-afk/clawd-on-desk/issues/796)

上游关联：[OpenChamber #2568](https://github.com/openchamber/openchamber/issues/2568)

代码基准：`origin/main@86125b9ff72eb3c85ba6e731889a42a6a6b5c006`（v0.14.0，2026-08-02）

报告环境：Windows 11、OpenChamber 1.17.2；Issue 自报 Clawd 0.19.0，但官方当前不存在该版本，实施/真机验收前必须复核实际 Clawd 版本、commit 和构建来源。

---

## 0. 一句话结论

可以在 Clawd 插件侧做窄修复，不必等待 OpenChamber 先改预热/Instance 生命周期：

1. `hooks/opencode-plugin/index.mjs` 在模块求值时只调用一次 `createOpencodeFamilyPlugin()`；OpenCode 随后为不同目录多次调用**同一个 plugin function**，所以这些 handler 共享同一个 factory closure，而不是各自拥有独立状态。
2. 当前共享 closure 中的 `_cwd` 会被每次 `plugin(ctx)` 用 `ctx.directory` 覆盖；任何 handler 发送 `/state` 或 `/permission` 时，都会读到**发送当时最近一次 init 的目录**。
3. 修复应在该共享 closure 内建立一张 `_sessionDirectoryById`，从 `session.created` / `session.updated` / `session.deleted` 的 `properties.info.directory` 捕获 session 级目录；所有 handler 天然共享这张表。
4. `/state` 与 `/permission` 通过同一个 resolver 按 `body.session_id` 选择 cwd；session map 命中时永远优先于 init 目录。
5. 采用 closure 级 `_hostEmitsSessionInfo` latch：在尚未成功见过 session info 的旧 host 上保留最近 init 目录回退；一旦证明当前 host 会提供可绑定的 `info.directory`，后续 map miss 就 omit cwd，不再发送可能错误的回退值。
6. `handlePermissionAsked()` 直接优先读取事件自带 session id，旧 payload 才回退 `_lastSeenSessionId || _rootSessionId`。

首选方案不改 HUD、Dashboard、`src/server-route-state.js`、`src/state.js` 或 permission 服务端结构。第一轮计划中的 G1 建立在“多个独立 plugin closure 接收同一 session 事件”的错误模型上，现已删除。修订后的 closure 级条件已由 OpenCode v1.18.11 源码证明；其适用范围限定为 OpenChamber 默认捆绑的 v1.18.11。用户覆盖二进制、旧 OpenCode 和 MiMo Code 落入明确的兼容/验收边界，而不是继续作为一个表述错误的实施前阻断门。

---

## 1. 已确认事实与证据边界

### 1.1 OpenChamber 1.17.2 的真实触发链

OpenChamber 1.17.2 会预热最多四个目录：

- `settings.lastDirectory`；
- 再加按 `lastOpenedAt` 排序的三个最近 project；
- 对每个目录顺序请求 `GET /session/status?directory=...`；
- 嵌入的 `opencode serve` 因目录请求懒初始化对应 Instance。

证据：

- [`packages/web/server/lib/opencode/lifecycle.js`](https://github.com/openchamber/openchamber/blob/v1.17.2/packages/web/server/lib/opencode/lifecycle.js) 中 `WARMUP_DIRECTORY_LIMIT = 4` 及 `warmOpenCodeDirectories()`；
- [`packages/web/server/index.js`](https://github.com/openchamber/openchamber/blob/v1.17.2/packages/web/server/index.js) 中 `lastDirectory + recent projects` 的目录来源；
- [`settings-normalization-runtime.js`](https://github.com/openchamber/openchamber/blob/v1.17.2/packages/web/server/lib/opencode/settings-normalization-runtime.js) 在 realpath 失败时保留原路径，因此已删除目录仍可能进入预热集合。

这解释了 Issue 中同 PID、同一秒出现四个不同 `INIT directory`，其中包含历史/已删除项目的现象。常见稳定错误序列是：活动项目恰好为第一项 `lastDirectory`，随后另外三个预热 init 继续覆盖共享 `_cwd`，最终活动 session 的 handler 发送时读到第四项历史目录。

Issue 还声称活动目录不在已记录的 INIT 集合里，这与默认 v1.18.11 的按目录懒初始化语义存在一个尚未裁决的矛盾：如果活动目录确实未初始化，首次访问应再触发一次 init；而 `core.mjs` 每次 init 都会 `resetDebugLog()`，后来的 init 可能截断先前取证。候选解释包括路径表现/脱敏差异、`lastDirectory` 失同步或日志采集时机。该未知不改变插件侧修法，但真机步骤必须区分这两个子场景。

截至 2026-08-03，OpenChamber #2568 仍是开放问题；任何后续状态或上游修复在实施时需要重新读取，不能把本计划的快照当成永久事实。

### 1.2 Clawd 当前的共享 closure 根因

1. [`hooks/opencode-plugin/index.mjs`](../../hooks/opencode-plugin/index.mjs) 在模块顶层调用一次 `createOpencodeFamilyPlugin()`，default export 是这一个 plugin function。
2. OpenCode v1.18.11 经 `await import(row.entry)` 加载插件 module，并为每个目录 Instance 调用该导出的 plugin function；同一 host 进程内 module cache 意味着 entry 通常只求值一次。
3. [`hooks/opencode-family-plugin/core.mjs`](../../hooks/opencode-family-plugin/core.mjs) 的 `_cwd`、`_lastStatePerSession`、`_sessionParentById`、`_lastSeenSessionId`、bridge state 等都位于 factory closure。
4. 因此 N 次 `plugin(ctx)` 共享上述状态；每次 init 都覆盖同一个 `_cwd`。同进程内不是 N 个 closure 竞争，而是一个共享变量按 init 顺序被重写。
5. OpenCode v1.18.11 plugin 事件分发会按 `event.location.directory === ctx.directory` 过滤。一个 session 的事件只进入拥有该目录的 handler；其他历史目录 handler 不会为同一事件各发一次。
6. 错误路径因此是：**owning handler 正确收到活动 session 事件，但共同发送层从共享 `_cwd` 取到最近一次历史 init 目录。**
7. [`src/server-route-state.js`](../../src/server-route-state.js) 只规范 wire `cwd`，没有来源/权威性标记；[`src/state.js`](../../src/state.js) 对同一 session 接受新的非空 cwd，否则保留旧值。同进程代的主错误在发送前已经确定，服务端 last-writer 主要会放大跨 host 进程代/重启后的错误变化。
8. HUD 和 Dashboard 只是渲染已污染的 session cwd，不是根因。

上游证据：

- [OpenCode v1.18.11 plugin loader](https://github.com/anomalyco/opencode/blob/v1.18.11/packages/opencode/src/plugin/loader.ts)；
- [OpenCode v1.18.11 plugin initialization/event dispatch](https://github.com/anomalyco/opencode/blob/v1.18.11/packages/opencode/src/plugin/index.ts)。

### 1.3 `/permission` 的真实影响路径

`postToClawd()` 当前会给 `/state` 与 `/permission` body 都附上 `_cwd`，但 [`src/server-route-permission.js`](../../src/server-route-permission.js) 的 opencode-family 分支并不读取/保存 `data.cwd`，构造的 `permEntry` 也没有 cwd。

permission bubble 的 folder 标签和 terminal focus 优先读取 session store 中的 cwd；该 session store 由 `/state` 污染。因此：

- 修好 `/state` 的 session cwd 会间接修好 permission folder/focus；
- `/permission` body cwd 的自动化断言只是 wire 级卫生，防止未来消费者使用脏值；
- 不得为了“让 permission cwd 真有消费者”而扩展 permEntry 或修改 permission 服务端，这会无必要扩大 #796 范围。

### 1.4 OpenCode v1.18.11 的 wire 契约

默认 OpenChamber 1.17.2 捆绑的 OpenCode CLI 版本派生自 `@opencode-ai/sdk` pin 1.18.11，但 SDK pin 不等于运行时必然使用该二进制。OpenChamber 可通过 `settings.opencodeBinary`、环境变量、捆绑二进制、PATH 和硬编码回退选择实际 serve；真机验收必须读取**实际二进制版本与来源**。参考 [`prepare-opencode-cli.mjs`](https://github.com/openchamber/openchamber/blob/v1.17.2/packages/electron/scripts/prepare-opencode-cli.mjs) 与 [`env-runtime.js`](https://github.com/openchamber/openchamber/blob/v1.17.2/packages/web/server/lib/opencode/env-runtime.js)。

对默认 v1.18.11，服务端 schema 才是 wire 真相：

- `session.created` / `session.updated` / `session.deleted` 的 `properties` 同时携带 `sessionID` 和 `info`；
- `info` 中包含 `id`、`directory`、可选 `parentID`；
- `message.part.updated` 携带 `properties.sessionID`；
- `permission.asked` request 携带 `sessionID`。

证据：

- [OpenCode v1.18.11 session wire schema](https://github.com/anomalyco/opencode/blob/v1.18.11/packages/schema/src/v1/session.ts)；
- [OpenCode v1.18.11 permission wire schema](https://github.com/anomalyco/opencode/blob/v1.18.11/packages/schema/src/v1/permission.ts)。

生成的 [`types.gen.ts`](https://github.com/anomalyco/opencode/blob/v1.18.11/packages/sdk/js/src/gen/types.gen.ts) 对这些 event 的字段描述落后于 wire schema，不能再作为本计划的唯一权威。

[`hooks/opencode-family-plugin/session-ids.mjs`](../../hooks/opencode-family-plugin/session-ids.mjs) 当前已能读取实际 v1.18.11 wire 的 `properties.sessionID`；因此 `properties.info.id` fallback 是对 info-only host/fork/过时 SDK 形态的纵深兼容，不是本次默认环境的主断点。仍需补齐它，因为 capture 的 identity 与 directory 必须能来自同一份 `info`，且 info-only `session.deleted` 目前会被错误当成无 session id 丢弃。

### 1.5 修订后的 G1：closure 级 info 可见性

正确的问题不是“每个重复实例是否都先收到 info”，而是：

> 共享 factory closure 是否在第一次为某 session 发送 cwd 前，从 owning handler 收到过可绑定的 `properties.info.directory`？

对 OpenChamber 默认捆绑的 OpenCode v1.18.11，该条件已有源码证据：

- 新建 session：`session.created` wire 同时带 `sessionID` 和 `info.directory`，capture 与第一次 SessionStart 发送可以在同一 handler 调用中按先 capture、后 translate/send 完成；
- 恢复/继续 session：prompt 控制流先 `sessions.touch(sessionID)`，产生含 info 的 `session.updated`，之后才进入 busy/运行循环；
- Instance bootstrap 会先初始化 plugin，再处理该 Instance 的请求，避免 owning handler 在订阅前错过当前请求产生的事件；
- 事件按目录过滤，因此不需要等待其他历史目录 handler“收敛”。

参考：

- [OpenCode v1.18.11 session prompt](https://github.com/anomalyco/opencode/blob/v1.18.11/packages/opencode/src/session/prompt.ts)；
- [OpenCode v1.18.11 project bootstrap](https://github.com/anomalyco/opencode/blob/v1.18.11/packages/opencode/src/project/bootstrap.ts)；
- [OpenCode v1.18.11 plugin event dispatch](https://github.com/anomalyco/opencode/blob/v1.18.11/packages/opencode/src/plugin/index.ts)。

结论：原 G1 按“多个独立实例”表述已被否定并删除；closure 级 G1 对默认 v1.18.11 已关闭，不再要求升级到服务端 provenance 或 SDK lookup。实际二进制 override、MiMo 和旧 host 仍需通过 fallback/latch 语义与验收边界处理。

### 1.6 当前自动化证据

在与 `origin/main` 相关 OpenCode 文件无差异的本地代码上执行：

```bash
node --test \
  test/opencode-family-core.test.js \
  test/opencode-plugin-session.test.js \
  test/opencode-family-bridge.test.js
```

结果：42 passed / 0 failed。测试期间沙箱禁止 `/bin/ps`，产生 process-walk warning，但三组目标 suite 均完成且通过。

这个结果只证明当前已有测试未发现回归。现有 `test/opencode-family-bridge.test.js` 的 `initInstance()` 每次都会重新调用 `createOpencodeFamilyPlugin()`；它创建的是两个独立 closure，适合 family/进程隔离测试，但**不是 #796 的同进程生产模型**，不能反证该 Issue。

### 1.7 仍未确认，不能写成已证实

- 尚未在维护者控制的 Windows 11 + OpenChamber 1.17.2 环境独立复现。
- 尚未取得报告者实际 OpenCode serve 二进制版本、选择来源和 OpenChamber settings 片段。
- 尚未裁决“活动目录不在 INIT 列表”与 v1.18.11 懒初始化语义之间的取证矛盾。
- 尚未证明 MiMo Code 的 module/handler 生命周期、目录过滤和 session event shape 与 OpenCode 完全一致。
- 尚未验证修复后的 packaged app、Windows HUD、Dashboard、permission focus 或重启稳定性。
- Issue 自报 Clawd 0.19.0 与官方发布历史不符，不能把该版本号当作复现基准。

---

## 2. 修复目标

1. 同一 factory closure 内，不同目录 handler 共享一张按规范化 session id 键控的目录映射。
2. session cwd 以 event `info.directory` 为权威，不受后续/历史 `plugin(ctx)` init 顺序影响。
3. `/state` 与 `/permission` 使用同一个 cwd resolver；permission body 保持 wire 卫生，真实 folder/focus 通过正确的 `/state` session cwd 修复。
4. `session.created` / `session.updated` / `session.deleted` 的 hybrid、info-only、legacy-only identity 都有明确兼容规则。
5. OpenCode-family prefix 隔离保持不变：`opencode:ses_x` 与 `mimocode:ses_x` 不共享目录映射或 latch。
6. 旧 host 从未提供有效 `info.directory` 时保留现有单 init 兼容行为；现代 host 一旦证明会提供 info，map miss 不再发送虚假 init fallback。
7. `permission.asked` 显式 session id 优先于 `_lastSeenSessionId` 间接绑定；legacy 无 id 行为不变。
8. 不新增依赖、不新增持久化、不改用户配置、不迁移 plugin 注册路径。
9. 修复前红/修复后绿的主回归必须复刻“一次 factory、两次 plugin(ctx)”生产模型。
10. 自动化、packaged artifact 和 Windows/OpenChamber 真机证据分层报告。

---

## 3. 非目标

- 不修 OpenChamber 的目录预热/Instance 生命周期上游根因。
- 不把 `src/state.js` 的通用 cwd 合并改成 first-writer-wins。
- 不按 `source_pid` / `agent_pid` 猜目录所有权；同一 host 内重复 init 共享 PID。
- 不用 `fs.existsSync`、`realpath` 或“目录是否存在”判断 cwd 权威性。
- 不按最近状态事件、初始化字典序或目录存在时间选择 cwd。
- 不改变 session key、snapshot schema、HUD 标题算法、Dashboard 渲染或 session alias 规则。
- 不给 opencode-family `permEntry` 新增 cwd，也不修改 permission 服务端消费路径。
- 不增加 SDK lookup、metadata-only 状态刷新或新的服务端 `cwd_source` schema。
- 不为 `session.updated` 合成状态事件或绕开现有 same-state dedup。
- 不解决 bridge 在重复 init 时轮换 token、覆盖 `_ctxClient` 且不关闭旧 Bun server 的生命周期缺陷。该问题已确认真实但必须另案跟踪，不能偷渡进 #796。
- 不新增 permission event 名称，不重做 permission bridge 协议，也不解决 legacy 无 sessionID 权限事件在并发 session 下的猜测绑定。
- 不修改网络代理配置，也不以切换代理作为复现/验证步骤。
- 不在未单独授权时向 Issue 请求信息、发表评论、创建跟踪 Issue、commit、push 或发布 PR。

---

## 4. 方案比较与最终选择

### 4.1 PID、first-writer、path-exists、last-active heuristic —— 拒绝

同一 host 的多次 init 共享 PID；第一写者/最近写者都可能是历史目录；路径存在不代表属于当前 session。把这些启发式放入通用 state 层还会影响其他 agent，无法建立可靠权威关系。

### 4.2 仅在当前 lifecycle body 临时读取 `info.directory` —— 不完整

后续 `session.status`、`session.idle`、tool part、permission 等事件通常只携带 session id。只修 created/updated 当次 body，后续发送仍会回到共享 init 目录，因此必须有 per-session map。

### 4.3 per-session map + 永久 init fallback —— 基础方案，不单独采用

共享 factory closure 内维护：

```text
normalized session id -> authoritative directory from properties.info
```

map hit 可完全修复默认 v1.18.11；但若一个会发 info 的现代 host 出现异常 map miss，永久 fallback 仍可能发送共享的最近 init 目录。虽然 §1.5 已证明正常控制流不会发生这一窗口，仍可用极低成本 latch 进一步 fail-safe。

### 4.4 safe miss（所有 miss 都 omit）—— 拒绝

它能避免说谎，但会让从不提供 `info.directory` 的旧 host 即使单目录运行也永久丢失 cwd，造成不必要兼容回归。

### 4.5 wire provenance + 服务端保护 —— 保留为未来升级路径

plugin 发送 `cwd_source=session-info|init-fallback`，服务端阻止 fallback 覆盖已有 authoritative cwd，能保护 host 重启代之间的瞬态。但它需要修改 route/state schema 与通用合并语义，扩大所有 agent/remote ingress 的回归面；当前默认环境已有插件侧完整证据，不需要为 #796 默认采用。

### 4.6 non-blocking SDK lookup —— 拒绝

map miss 时查询 session 看似直接，但引入 in-flight 管理、错误/超时语义、错误目录 Instance 懒启动和补发/dedup 时序。相较纯 Map+latch 没有收益，风险和测试面显著更大。

### 4.7 最终选择：共享 map + info-latch + permission 显式 id

在 `createOpencodeFamilyPlugin()` factory closure 内新增：

```js
const _sessionDirectoryById = new Map();
let _hostEmitsSessionInfo = false;
```

每次成功把有效 `info.directory` 绑定到一致的 session identity 后，把 latch 设为 `true`。resolver 的固定 precedence：

```text
map hit
  -> authoritative session directory

map miss AND hostEmitsSessionInfo=false
  -> latest init directory, if valid (legacy compatibility)

map miss AND hostEmitsSessionInfo=true
  -> omit cwd (modern-host fail-safe)
```

该 latch 位于 factory closure：

- 同一个 entry/host 的所有目录 handler 共享；
- 不放进每次 `plugin(ctx)` 返回的 handler 私有对象；
- 不放到 module-global，OpenCode 与 MiMo/独立 factory 不能互相置位；
- 只有成功 capture 才置位，invalid/mismatch info 不得改变兼容模式；
- 不需要持久化，host 进程重启后重新从 `false` 开始。

`handlePermissionAsked()` 同时改为：

```js
resolveSessionId(
  getEventSessionId(event),
  _lastSeenSessionId || _rootSessionId,
)
```

对 v1.18.11 行为等价，但消除“主 handler 必须先更新 lastSeen”这一时序耦合；legacy 无 session id 的 fallback 保持不变。

---

## 5. 强制设计不变量

### D1 — factory closure 是共享真相边界

同一 entry module 的 N 次 `plugin(ctx)` 必须共享 `_sessionDirectoryById`、latch 和现有 dedup/parent 状态。不得把 map/latch 建在 `plugin(ctx)` 函数体或返回的 handler 对象里；否则每个目录重新隔离，复现错误模型。

### D2 — session info 胜过最近 init

只要某 session 已从 `properties.info.directory` 获得有效目录，后续 `/state` 与 `/permission` 都不得被任何新的 `ctx.directory` 覆盖。

### D3 — identity 与 directory 必须相关联

若 payload 同时出现 event/legacy `sessionID` 与 `info.id` 且规范化后不一致：

- 不把 `info.directory` 绑定到任一 id；
- 不置 `_hostEmitsSessionInfo`；
- 不猜测哪个 id 正确；
- 记录低频、无完整路径的 mismatch 诊断；
- 状态 identity 可继续遵守现有 helper precedence，但 directory capture 必须 fail closed。

### D4 — prefix/factory 隔离不变

map key 必须走当前 factory 的 `normalizeSessionId()`。OpenCode 与 MiMo 同 raw id 不能共享 map/latch；两个独立 factory 产物也不能共享 closure state。

### D5 — 一个 resolver 服务两个 outbound 通道

禁止在 `buildStateBody()` 与 `handlePermissionAsked()` 各写一套 cwd precedence。`postToClawd()` 或其调用前的唯一 resolver 必须按最终 `body.session_id` 解析 cwd，服务 `/state` 和 `/permission`。

### D6 — capture 必须早于 translate/drop

`session.updated` 当前映射为 null。目录 capture 必须发生在 `translateEvent()` 与 no-session-id drop 前，才能更新缓存；info-only `session.deleted` 也必须先通过扩展后的 identity helper 得到 session id。

### D7 — 删除事件先固化 body、后清 map

`session.deleted` 先 capture 最新 info，再构造 SessionEnd 并同步把 cwd 固化进 JSON body，最后删除对应 map key。不得先删再 resolver fallback 到历史 init 目录。

当前 `postToClawd()` 在 async IIFE 前同步执行 `JSON.stringify(body)`；实现可以依赖并测试这个顺序，或更明确地先把解析结果写入 body。

### D8 — disposed 清理只是 legacy 防御

`server.instance.disposed` 无 session id 时仍清空 directory/parent map，但 OpenCode v1.18.11 的 [`instance-store.ts`](https://github.com/anomalyco/opencode/blob/v1.18.11/packages/opencode/src/project/instance-store.ts) 把该事件送入 GlobalBus/SSE，不会进入 plugin event hook。它不能作为现代 host 的主要 map 释放保障，也不能在测试/文档里伪装成现代生命周期证明。

### D9 — invalid directory 不破坏已有好值

非字符串、空字符串或只有空白的 `info.directory` 不写 map、不置 latch，也不清除已有值。不得 `path.resolve`、大小写折叠、转换斜杠或检查存在性；保留 upstream 路径文本。

### D10 — latch 只收紧 fallback，不制造状态

latch=false 代表“尚未证明 host 支持 info”，不是“当前 session 一定是 legacy”；latch=true 后 miss 只 omit cwd，不补发状态、不改 dedup、不清 server 已有 cwd。

### D11 — same-state dedup 与 HUD 刷新语义不变

`session.updated` 只更新目录缓存，不合成 SessionStart 或绕过 `_lastStatePerSession`。若 session 处于 idle 且之后没有真实状态转换，HUD 可能在下次真实 event 才看到新 cwd；即时 metadata update 属于另案。

### D12 — plugin entry 与 bridge 行为不在本 PR 改形

`hooks/opencode-plugin/index.mjs` / `hooks/mimocode-plugin/index.mjs` 继续只 default-export plugin function。不得新增 entry named export。#796 测试可以观察现有 bridge 字段，但不得顺手改变 bridge token/server/client 生命周期。

---

## 6. 详细数据流

### 6.1 session metadata 提取

在 `session-ids.mjs` 增加安全的 `getEventSessionInfo()` 或等价 helper，并让 `getEventSessionId()` 保持兼容 precedence：

```text
properties.sessionID
  -> top-level event.sessionID
  -> properties.info.id
  -> null
```

测试/实现必须区分四种 event shape：

1. **hybrid**：`properties.sessionID + properties.info.id` 同时存在且一致；这是 v1.18.11 wire 常态。
2. **info-only**：只有 `properties.info.id`；这是 stale SDK 类型、host fork 或防御性兼容场景。
3. **legacy-only**：只有 `properties.sessionID` 或 top-level `event.sessionID`。
4. **mismatch**：多个 id 规范化后不一致；identity 按现有 precedence，directory capture fail closed。

推荐返回结构化 metadata：

```js
{
  eventSessionId,
  infoSessionId,
  directory,
  mismatch,
}
```

helper 保持 prefix-independent；只有 factory 内通过 `normalizeSessionId()` 形成 map key。

### 6.2 closure state

在 `createOpencodeFamilyPlugin()` closure 中新增：

```js
const _sessionDirectoryById = new Map();
let _hostEmitsSessionInfo = false;
```

当前 `_cwd` 建议重命名为 `_lastInitDirectory`；如果为控制 diff 保留 `_cwd`，也必须修改注释，明确它是整个 shared closure 的“最近一次 init legacy fallback”，不能再称为 per-instance directory。

新增三个窄职责 helper：

```js
captureSessionDirectory(event)
resolveSessionDirectory(sessionId)
cleanupSessionDirectory(event, phase)
```

`session.deleted` 的 directory cleanup 不得复用现有 `cleanupSessionParentMap()` 在 translate 前的调用点：parent map 在 send 前清理，directory map 在 SessionEnd body 固化/序列化后清理，属于两个不可合并的 phase。

不得把 capture/precedence 全塞进 `postToClawd()` 的一条赋值里，以免难以测试 mismatch、latch 和清理时序。

### 6.3 capture 规则

只对以下低频 lifecycle event 尝试读取 `properties.info`：

- `session.created`；
- `session.updated`；
- `session.deleted`。

固定步骤：

1. 提取 event identity、info identity 和 directory。
2. 两个 identity 都存在且规范化后不一致：skip capture，latch 不变，记录 mismatch。
3. 否则使用 `info.id || event session id` 作为 raw id。
4. 经当前 family `normalizeSessionId()` 得到 map key。
5. directory 为有效非空字符串时 `Map#set`，然后 `_hostEmitsSessionInfo = true`。
6. `session.updated` 可覆盖该 session 旧的权威目录，不影响其他 session。
7. 不把 `_lastInitDirectory` 写入 map；兼容 fallback 和 authoritative cache 必须可区分。

### 6.4 outbound resolver

共同发送层在所有 process/Orca metadata 注入之后、`JSON.stringify(body)` 之前，根据最终 `body.session_id` 调用 resolver：

```text
normalize body.session_id
  -> map hit: set body.cwd=session directory
  -> miss + latch false + valid lastInitDirectory: set fallback cwd
  -> miss + latch true: delete/omit body.cwd
  -> no valid source: omit body.cwd
```

约束：

- map hit 必须覆盖 body 上任何旧 fallback；
- omit 时不要发送 `cwd: ""`；服务端会保留已有非空 cwd；
- 不得用 `_lastSeenSessionId` 替代明确的 `body.session_id` 做 cwd 查询；
- resolver 是同步纯逻辑，不做文件、网络或 SDK I/O。

### 6.5 event handler 顺序

建议顺序：

1. 校验 event shape。
2. 用扩展后的 `getEventSessionId()` 解析 sid。
3. 对 `server.instance.disposed` 立即做 legacy defensive clear。
4. 对 created/updated/deleted 运行 directory capture。
5. 保持现有 root/lastSeen/parentID 更新语义，让 info-only id 也能进入相同 namespace。
6. permission event 直接调用修订后的 `handlePermissionAsked(event)`，随后 return。
7. 非 permission event 进入现有 parent cleanup、translate、drop、send 流程。
8. `session.deleted` 的 SessionEnd body 同步固化/序列化完成后，删除该 session directory key。

必须证明：`session.updated` 即使 translate=null 也 capture；info-only deleted 不被 drop；deleted body 使用 map 后才清理。

### 6.6 permission 路径

`handlePermissionAsked()` 的 session id 改为显式 event-first：

```text
getEventSessionId(event)
  -> _lastSeenSessionId
  -> _rootSessionId
  -> family default
```

生成规范化 `session_id` 后，仍由共同 outbound resolver 选择 cwd。

自动化要分清两层证明：

- `/permission` body cwd：wire hygiene；
- permission bubble folder/focus：服务端读取 `/state` 已建立的 session cwd，需在现有逻辑/真机路径证明，不给 `permEntry` 增加 cwd。

bridge URL/token、request id、once/always/reject 的现有行为不因 #796 改动；主回归不得声称 bridge 坐标“属于各 handler”，因为 bridge state 也在同一个共享 closure，重复 init 的所有权缺陷属于非目标。

### 6.7 debug 诊断

只增加低噪声来源诊断，不扩大完整路径暴露：

- `SESSION_DIR capture session=<id> source=info`；
- `SESSION_DIR skip session=<id> reason=id-mismatch|invalid-directory`；
- outbound 可记录 `cwdSource=session-info|legacy-init-fallback|none`。

现有 `INIT directory=...` 已记录完整路径，本 PR 不新增第二份完整路径日志。不要为了 tail 调试引入平台相关 basename 误判。

---

## 7. 文件级实施计划

### A. `hooks/opencode-family-plugin/session-ids.mjs`

- 为 `getEventSessionId()` 增加 `properties.info.id` 最后 fallback。
- 新增/复用安全的 `properties.info` metadata helper。
- 明确 hybrid/info-only/legacy-only/mismatch contract。
- directory helper 不做 prefix、路径规范化或存在性检查。
- 保持 `createSessionIdHelpers(prefix)` 和现有 prefix-dependent helper 边界。

### B. `hooks/opencode-family-plugin/core.mjs`

- 新增 factory-closure `_sessionDirectoryById` 和 `_hostEmitsSessionInfo`。
- 将 `_cwd` 重命名/重注释为 shared `_lastInitDirectory` legacy fallback。
- 新增 capture / resolve / cleanup helper。
- 在 translate/drop 前 capture created/updated/deleted。
- 共同发送层按 `body.session_id` 注入 map/latch 解析后的 cwd。
- `handlePermissionAsked()` 直接优先使用 `getEventSessionId(event)`。
- `session.deleted` 发送后删自己的 key；`server.instance.disposed` 保留 legacy clear。
- 保持 fire-and-forget POST、process metadata、Orca pane key、port discovery、dedup 和 bridge 行为不变。
- `plugin.__test` 只暴露最小 live view/helper；不向 entry module 增 named export。

### C. `test/opencode-plugin-session.test.js`

新增 identity/wire contract：

- hybrid created/updated/deleted：`sessionID` 与 `info.id` 一致；
- info-only created/deleted：得到同一 namespaced id，deleted 不再被 no-id drop；
- info-only created：`_rootSessionId` / `_lastSeenSessionId` 都更新为 `info.id`，SessionStart 不再落 family default；用 `plugin.__test` live view 或等价行为断言锁住该副作用；
- legacy-only `properties.sessionID` / top-level `event.sessionID` 继续工作；
- hybrid mismatch：identity precedence 明确，但 directory 不绑定、latch 不置位；
- `info.parentID` 现有 child 语义保持；
- invalid/missing info 不抛错。

### D. `test/opencode-family-core.test.js`

新增纯逻辑 contract：

- 一个 factory 的 map/latch 可供其多次 plugin 调用共享；
- 两个独立 factory 产物保持隔离；OpenCode/MiMo 同 raw id 不串；
- map hit 胜过 last-init fallback；
- latch=false miss 使用兼容 fallback；
- 第一次成功 capture 后 latch=true，其他 session miss omit cwd；
- family default session 在 latch=false 时仍使用兼容 fallback、latch=true 时 omit，不因 default key 绕过 resolver；
- invalid/mismatch capture 不置 latch；
- session.updated 只改目标 session；empty update 不清好值；
- deleted 只清目标 key；disposed defensive clear 全表；
- same-state dedup、parent/headless state bag 不因 map 改变。

### E. `test/opencode-family-bridge.test.js` 或新增 `test/opencode-family-session-directory.test.js`

主红→绿回归必须写死生产实例化模型：

```js
const plugin = createOpencodeFamilyPlugin(OPENCODE_CONFIG)
const hooksA = await plugin(ctxA)
const hooksB = await plugin(ctxB)
```

其中：

- `ctxA.directory = "C:\\active-project"`；
- `ctxB.directory = "C:\\history-b"`；
- 只让 owning handler（例如 `hooksA`）处理 `ses_live` 的 event，模拟 v1.18.11 目录过滤；
- event 使用 hybrid wire：`properties.sessionID="ses_live"` 且 `info.id="ses_live"`、`info.directory="C:\\active-project"`；
- 修复前 `/state` cwd 稳定是最后 init 的 `history-b`，修复后必须是 `active-project`。

`ctxA.directory === info.directory` 是 v1.18.11 的真实 owning-instance 不变量；owning directory 与 info directory 不同的组合只能作为附加防御变体，不能充当 #796 主回归。

至少覆盖：

1. 同一个 factory、两次 plugin(ctx) 的 created → status/tool 状态序列。
2. `session.updated` 在没有 state POST 时先更新 map，下一真实状态使用新目录。
3. session A/B 交错，map 不串且不借用 `_lastSeenSessionId`。
4. latch false/true miss 的 wire body 差异。
5. `session.deleted` body 用权威目录，序列化后 key 被删除。
6. `/permission` body 使用同一 resolver；只断言 wire hygiene，不宣称它直接驱动 UI focus。
7. legacy permission 无 session id 保持现有 fallback；v1.18.11 permission 显式 id 优先。
8. 现有 bridge once/always/reject/token suite 继续通过；不新增“每 handler 独立 bridge”的错误断言。

fixture 必须在 import core 前设置临时 HOME/USERPROFILE，并 mock fetch、Bun.serve 和必要的 process resolver，不能写用户真实 `~/.clawd`、OpenCode config 或网络。现有 bridge 测试的 temp HOME 方式可复用。

双 factory 测试保留为次要隔离模型：它代表不同 entry/family 或不同 host 进程，不得拿它代替上述主回归。

### F. 保持不改的文件（scope guard）

除非第二轮 Claude 复审提供新的阻断级证据，以下文件不应因 #796 修改：

- `src/server-route-state.js`；
- `src/state.js`；
- `src/server-route-permission.js`；
- `src/permission.js`；
- `src/session-hud-renderer.js`；
- `src/dashboard-renderer.js`；
- `hooks/opencode-plugin/index.mjs`；
- `hooks/mimocode-plugin/index.mjs`；
- installer、Doctor、Settings、Remote SSH deploy manifest。

本修复预计只改 shared core、session helper 和测试，不新增 helper 文件，因此无需更新 `HOOK_FILES` 或 packaging globs；仍必须用现有 manifest/package tests 证明。

---

## 8. 自动化验证矩阵

### 8.1 identity / wire shape

| 场景 | 期望 |
|---|---|
| hybrid `sessionID + info.id` match | v1.18.11 常态；identity/capture 正常 |
| info-only `info.id` | 防御性兼容；得到 raw id、可 capture |
| legacy `properties.sessionID` | 维持现有 id |
| top-level `event.sessionID` | 维持现有 id |
| hybrid mismatch | identity 按现有 precedence；directory 不绑定；latch 不置位 |
| `info.directory` 为空/非字符串 | 不写、不清已有值、不置 latch |
| Windows/CJK/空格路径 | 原文保留，不 resolve/realpath |

### 8.2 cwd precedence / latch

| map | latch | last init fallback | 期望 cwd |
|---|---:|---|---|
| active directory | false/true | stale directory | active directory |
| updated directory | true | stale directory | updated directory |
| miss | false | valid legacy directory | legacy directory |
| miss | false | empty | omit |
| miss | true | stale directory | omit |
| miss（含 family default） | false/true | 任意 | 严格遵守同一 latch 规则，不为 default 绕过 resolver |
| miss；unknown 混合-shape host（部分 lifecycle 有 info、部分无） | true | 可能正确 | omit；已知理论残余是可见 cwd 缺失而非错误目录，接受且不加新机制 |
| session A hit / B hit | true | 任意 | 各取自己的 map，不借 lastSeen |
| factory A latch=true / factory B=false | 分离 | 各自 fallback | 不跨 factory |

### 8.3 lifecycle

| event | 期望 |
|---|---|
| `session.created` hybrid/info-only | capture 后 SessionStart body 带 session cwd |
| `session.updated` | translate=null 也更新 map/latch；不发送合成状态 |
| `session.status` / tool event | 从明确 body session id 对应 map 读取 cwd |
| `permission.asked` | 显式 event id 优先；body cwd 走同 resolver |
| `session.deleted` | SessionEnd 同步固化后删该 key |
| `server.instance.disposed` | 若 legacy host 真送到 hook，清全部 cwd/parent map |

### 8.4 fixture architecture

| 模型 | 用途 | 是否为 #796 主回归 |
|---|---|---:|
| 一个 factory，两次 `plugin(ctx)` | 同 host 多目录 init，共享 closure | 是 |
| 两个 factory，各一次 `plugin(ctx)` | family/entry/跨进程隔离 | 否，次要 |
| 一个 handler 接 owning-directory event | 模拟 v1.18.11 event filter | 是 |
| 所有 handler 广播同一 event | 非 v1.18.11 生产模型 | 否，不得作为主证明 |

### 8.5 回归边界

- same-state dedup 不变；
- child/headless parent map 不变；
- OpenCode/MiMo prefix 和 latch 不串；
- bridge once/always/reject 与现有 token 校验行为不变；
- port discovery/self-healing 不变；
- Orca/terminal process metadata 不变；
- entry module 仍只有 default export；
- plugin config/install path 不变；
- server 对其他 agent 的 cwd merge 不变；
- 不新增网络或文件同步 I/O。

---

## 9. 验证顺序

### 9.1 修复前红灯证据

在改实现前先落主 fixture，并证明：

- 同一 factory 依次 `plugin(ctxA)` / `plugin(ctxB)`；
- owning `hooksA` 收到 session info directory；
- 现有代码发出的 cwd 是 `ctxB.directory`；
- 失败原因是 cwd 断言，不是真实端口、HOME 污染、bridge token 或 `/bin/ps` 环境噪声。

主红测试的失败断言只锁 cwd；session id、状态序列和 bridge 字段放在独立用例中，保持红灯语义单一，避免未来 bridge 另案修复稀释该回归的因果。

保留这次红灯的准确测试名/断言输出，再实施修复。

### 9.2 静态与定向测试

```bash
git diff --check
node --test \
  test/opencode-plugin-session.test.js \
  test/opencode-family-core.test.js \
  test/opencode-family-bridge.test.js \
  test/opencode-family-session-directory.test.js \
  test/opencode-install.test.js \
  test/state.test.js
```

若未新增独立测试文件，从命令中删除该项，但必须保证同 factory 双 init 主回归实际存在。记录 tests/pass/fail/skip 和 process-walk warning，不能只报 exit 0。

### 9.3 OpenCode-family、manifest 与打包相关回归

```bash
node --test \
  test/doctor-opencode-entry.test.js \
  test/doctor-agent-integrations.test.js \
  test/package-build-config.test.js \
  test/remote-ssh-deploy.test.js
npm run verify:electron
```

重点是证明 entry → core → session-ids 依赖闭包、Remote SSH 部署清单和 packaged layout 未因 helper 修改断裂。

### 9.4 全量回归

```bash
npm test
```

必须记录 pass/fail/skip。若出现沙箱 `/bin/ps`、端口或平台条件问题，要与 baseline 对照，将环境噪声和产品失败分开，不得把定向绿冒充全量绿。

### 9.5 packaged artifact

至少完成维护者当前平台的真实 package sanity，并为报告目标产出/取得 Windows x64 包：

```bash
npm run build:mac
npm run build:win:x64
```

按可用平台执行；macOS builder 成功不能写成 Windows 行为已验证。检查：

- `app.asar.unpacked/hooks/opencode-family-plugin/core.mjs` 存在；
- `session-ids.mjs` 存在；
- `opencode-plugin/index.mjs` 能加载 shared core；
- integration 注册路径无需迁移；
- packaged Electron 能启动，不只看 builder exit code。

---

## 10. Windows 11 + OpenChamber 真机验收

### 10.1 前置与取证

- 记录 Clawd About 的真实版本、commit、构建来源，纠正 Issue 的 0.19.0。
- 记录 OpenChamber 1.17.2 的实际 OpenCode serve 可执行文件路径、`--version` 与选择来源；检查 `settings.opencodeBinary` 和相关 override，不只记录 SDK package pin。
- 脱敏记录 OpenChamber settings 中 `lastDirectory`、按 `lastOpenedAt` 排序的 projects，以及目录是否仍存在。
- OpenCode integration installed + enabled。
- 准备两个存在的历史项目、一个已删除历史目录和一个活动项目。
- 在打开/恢复活动 session 前保存当时的 plugin 日志副本；后续 init 的 `resetDebugLog()` 可能破坏前序证据。
- 使用 §6.7 的 `cwdSource=session-info|legacy-init-fallback|none` 诊断区分 map hit、兼容 fallback 与 omit；不得只凭 HUD 标题反推 resolver 分支。
- 所有公开证据移除用户名、完整私有路径、token 和项目内容。

### 10.2 触发链和两个子场景

场景 A：活动目录就是 `lastDirectory`，属于四项 warmup 的第一项。

1. 人为构造 settings：`lastDirectory` 为活动项目，按 `lastOpenedAt` 排序的前三个 distinct project 均为历史目录，确保四项 warmup 完整且最后 init 不是活动目录。
2. 启动 OpenChamber + Clawd，记录 warmup 目录顺序和全部可见 INIT。
3. 确认最后一次 init 是历史项目，而 owning session handler 属于第一项活动目录。
4. 修复前应可观察错误 cwd；修复后所有活动 session `/state` 都必须使用 `info.directory`。

场景 B：活动目录不在四项预热集合。

1. 保存前四项 warmup 日志后再打开活动 session。
2. 观察是否出现第五次 init；若日志被 reset，使用预先副本与新日志拼接时间线。
3. 再触发一个背景/历史目录请求，验证最近 init 再变化也不能覆盖已有 session map。
4. 若没有第五次 init，记录实际二进制版本、请求路由和路径表现，不能按默认 v1.18.11 语义强行解释。

若上游版本已改变导致无法自然复现，使用受控同 factory 双 init fixture，但必须标记“受控复现”，不能伪装成 Windows/OpenChamber 自然通过。

### 10.3 单 session 产品验收

1. 新建 session：created → busy/tool/idle 全程 cwd 正确。
2. 恢复旧 session：updated 在 busy 前 capture，HUD/Dashboard 使用活动目录。
3. HUD 标题为活动目录 basename；Dashboard 为活动完整路径。
4. 触发 permission bubble：folder 与 deny-and-focus/跳转使用 session store 中正确 cwd；注明它由 `/state` 修复间接生效。
5. 删除 session：SessionEnd 后记录清理，不出现历史 fallback 闪回。
6. 完全退出并重启 OpenChamber + Clawd 至少三轮；预热顺序/最近项目变化时结果稳定。
7. 直接运行单项目 OpenCode CLI，legacy/正常行为无回归。

### 10.4 两个并发 session

1. project A/B 各一个 live session。
2. 交错 prompt、tool、stop、permission。
3. HUD/Dashboard 同时显示 A/B 正确目录。
4. A 的 event 不修改 B 的 cwd，反之亦然。
5. 删除/关闭 A 后，B 的 cwd 与 permission focus 不受影响。
6. 若观察到状态/parent/headless 串台，作为独立 session ownership 缺陷记录，不能混记为 cwd 修复失败或顺手扩 scope。

### 10.5 兼容与残余边界

- 用 legacy-only fixture 验证 latch 尚未置位时单 init fallback 保持。
- 用 override/旧二进制时明确记录其 event shape；若从不提供 info，多目录错误只能维持现状，不能宣称 #796 已在该版本完全修复。
- 若实际二进制处于“部分 lifecycle event 带 info、部分不带”的未知中间版本，同进程先 capture 新 session 后，恢复的 legacy-shape session 可能因 latch=true 而 omit cwd；这是可见降级、优于发送错误历史目录，记录为已知残余而不增加未经证实的兼容机制。
- MiMo Code 至少完成自动化 prefix/fallback/latch 隔离；若无法真机 smoke，明确记录未验证。
- `session.updated` 后若没有真实状态转换，HUD 可能延迟刷新；按 D11 记录为已知边界。
- Windows 真机完成前，自动化和 packaged import 只能证明逻辑/布局，不能证明 UI 集成完成。

---

## 11. 风险、保护和设计门

| ID | 风险 | 保护 / 决策 |
|---|---|---|
| R1 | 错把多目录 init 实现成每 handler 私有 map | D1；主 fixture 一次 factory、两次 plugin(ctx)；禁止只测双 factory |
| R2 | map miss 继续发送最近历史 init cwd | 默认 v1.18.11 顺序已有证明；info-latch 后 miss omit |
| R3 | 老 host 从不发 info，单 CLI 丢 cwd | latch=false 保留 legacy fallback；legacy-only 测试 |
| R4 | `info.id` 与 wire `sessionID` 冲突导致 cwd 绑错 | mismatch capture fail closed；latch 不置位 |
| R5 | `session.updated` translate=null，cache 不更新 | capture 早于 translate/drop |
| R6 | deleted 先清 map，SessionEnd 带历史 cwd | 同步固化/序列化后清；端到端断言 |
| R7 | map/latch 变 module-global，OpenCode/MiMo 串 | factory closure + prefix；双 factory 隔离测试 |
| R8 | 为即时更新绕 dedup，重播动画/完成态变化 | D11：不合成状态；另案 metadata update |
| R9 | 误以为 `/permission` body cwd 直接修 UI而扩大服务端 | 明确 wire hygiene 与 session-store 因果；scope guard |
| R10 | modern host 收不到 disposed，map 长期增长 | session.deleted 尽力清；map 生命周期=host 进程；量级可接受；不加 LRU |
| R11 | LRU 淘汰长寿活动 session 后回到 miss | 明确不加 LRU；进程级 map 的小量增长优于错误淘汰 |
| R12 | 实际 OpenCode binary 非默认 v1.18.11 | 真机读取 executable/version/override；限定结论范围 |
| R13 | 新 debug 日志泄露完整路径 | 只记 source/reason，不新增完整路径 |
| R14 | 同 factory fixture 意外暴露 bridge token/client 重 init 缺陷 | 分类为已知范围外；不在 #796 修；现有 bridge suite 防回归 |
| R15 | Issue 版本错误导致验证错包 | About/commit/read-back；官方 release 和自定义 build 分开记录 |

### 计划复审门

- **P1：第二轮 Claude 必须确认 v2 已统一使用 shared factory-closure 模型。**
- **P2：第二轮 Claude 必须确认 info-latch 兼容矩阵没有新的 silent cwd regression。**
- **P3：第二轮 Claude 必须确认同 factory 双 init fixture 在修复前会因 cwd 断言失败，而不是测到范围外 bridge bug。**
- **P4：若复审提出新的 P0/P1 架构证据，先更新计划，不直接实施。**

### 实现/合并证据门

- **G1（已关闭，有限定）：默认 OpenChamber 1.17.2 + bundled OpenCode v1.18.11 的 closure 级 info-before-send 已有源码证据；真机必须确认实际二进制落在该范围。**
- **G2：一次 factory、两次 plugin(ctx) 的 `/state` 主回归修复前红、修复后绿；permission cwd 只作为 wire 卫生断言。**
- **G3：hybrid/info-only/legacy-only/mismatch identity 与 latch contract 有明确测试。**
- **G4：Windows/OpenChamber 单 session、恢复、并发、重启、permission focus 完成；若只能由报告者完成，PR/Issue 明确待验，不能宣称已完全验证。**
- **G5：定向、全量、manifest/package 和 packaged shared-core import 证据分层完成。**
- **G6：bridge token/client 重 init 缺陷未被暗改或错误宣称已解决；如需跟踪，另行授权创建 Issue。**

---

## 12. 回滚方案

该修复无数据 migration、prefs/schema 或 plugin 注册变化，可聚焦回滚：

1. 回退 `session-ids.mjs` 的 `info.id` / metadata helper。
2. 回退 `core.mjs` 的 session directory map、latch、capture/resolve/cleanup 与 permission 显式 id。
3. 回退对应测试。

回滚后恢复 shared `_cwd` 最近 init 覆盖行为，不需要清用户配置。不得通过删除 OpenCode history、修改 OpenChamber settings/database 或清理项目目录“回滚”。

---

## 13. 实施完成定义

- [x] hybrid/info-only/legacy-only/mismatch identity 均有契约测试。
- [x] `_sessionDirectoryById` 与 `_hostEmitsSessionInfo` 位于 factory closure，不在每次 plugin init 或 module-global。
- [x] 主回归明确是一个 factory、两次 plugin(ctx)、owning handler 单路事件。
- [x] 修复前主回归因 latest-init cwd 失败；修复后使用 session info cwd。
- [x] map hit 永远优先于 init fallback。
- [x] latch=false miss 兼容旧 host；latch=true miss omit cwd。
- [x] invalid/empty/mismatch info 不写 map、不置 latch、不破坏好值。
- [x] created/updated/deleted capture 与清理顺序正确。
- [x] `/state` 与 `/permission` 使用同一 resolver；permission UI 因果说明准确。
- [x] `permission.asked` 显式 event session id 优先，legacy fallback 不变。
- [x] 两个并发 session cwd 不串；两个独立 factory/OpenCode-MiMo 不串。
- [x] disposed 只作为 legacy 防御；不加 LRU。
- [x] child/headless、dedup、port discovery、process metadata、entry export 和现有 bridge suite 回归保持。
- [x] bridge token/client 重 init 问题未混入本修复。
- [x] 定向测试、全量测试记录精确 pass/fail/skip。
- [x] manifest/package 闭包与 packaged entry 加载完成（macOS x64/arm64；Windows 包仍待目标平台）。
- [ ] Windows 真机记录实际 OpenCode executable/version/override 和 OpenChamber settings 触发链。
- [ ] Windows 11 + OpenChamber 单 session、resume、两个子场景、并发、重启、permission focus 完成或明确待验。
- [ ] Issue 中 Clawd 实际版本得到复核。
- [x] 未修改代理、用户 OpenCode/OpenChamber 配置或无关 state/UI/permission 逻辑。

---

## 14. 第二轮 Claude reviewer 重点问题

1. v2 对 module evaluation、factory closure、`plugin(ctx)` 多次调用和按目录 event filter 的模型是否准确？还有没有把“handler/Instance/factory closure”混用的地方？
2. 推荐的 `_hostEmitsSessionInfo` latch 是否真能同时满足：现代 host 不说谎、旧 host 单 init 不丢 cwd？是否存在一个 session 成功 capture 后，另一个合法 legacy-shape session 被错误 omit 的现实混合模式？
3. latch 应由“成功 capture 有效 directory”置位，还是只要看见合法 `properties.info` 就置位？当前选择是否最安全？
4. hybrid mismatch 时“identity 继续现有 precedence、directory/latch fail closed”是否正确，还是整个状态 event 也必须 drop？
5. `session.deleted` 先 capture/serialize、后删除 map 是否覆盖所有同步/异步边界？是否应避免在 deleted capture 时用新 info 覆盖旧权威目录？
6. 一个 factory 两次 `plugin(ctx)`、只给 owning handler event 的主 fixture 是否准确复刻 v1.18.11？测试如何隔离已知 bridge token/client 重 init 缺陷，确保红灯只来自 cwd？
7. `/permission` body cwd 仅为 wire hygiene、产品 permission focus 由 `/state` session store 间接修复，这一因果是否完整？是否仍有任何必须修改 `src/server-route-permission.js` 的 blocker？
8. `handlePermissionAsked(getEventSessionId(event), fallback)` 的一行修正是否应包含在 #796，是否会改变任何 legacy/并发语义？
9. modern OpenCode 收不到 `server.instance.disposed` 的判断是否准确？不加 LRU、让 map 随 host 进程生存是否有不可接受的内存或错误复用风险？
10. actual binary override、MiMo 和 old host 的剩余边界是否已经诚实表达，还是仍有被错误宣称“完全修复”的路径？
11. scope guard 是否足够窄？有没有证据要求修改 state/server/HUD，或相反应删除计划里某个非必要改动？
12. 请给出最终 verdict：`GO` / `REVISE` / `BLOCK`，并把每个问题标为 P0/P1/P2/P3，附具体文件/测试/计划章节引用。

---

## 15. 实施与复审记录（2026-08-03）

### 15.1 计划复审

- Claude 第二轮对抗审查结论：`GO`，无 P0/P1/P2；四项 P3 已在实施前回写到 v2。
- 实现后独立子代理初审及 P3 修正复审结论均为 `GO`；最终 P0/P1/P2/P3 全部为零。
- 子代理提出的两项 P3 已关闭：本文件状态/证据已回写；新增同 factory 的 A/B owning handler 交错 state/tool 断言，并补 legacy permission lastSeen/cwd 回退断言。

### 15.2 红灯与实现证据

- 基准：`origin/main@86125b9ff72eb3c85ba6e731889a42a6a6b5c006`。
- 分支：`fix/issue-796-opencode-session-cwd`。
- 修复前主 fixture 只失败于 cwd：expected `C:\\active-project`，actual `C:\\history-b`。
- 修复后同一 fixture 通过；生产代码只修改 shared core 与 session-id helper，没有修改 state/server/HUD/permission UI。

### 15.3 自动化与打包证据

- 核心四组 suite（含子代理 P3 补测）：53 passed / 0 failed / 0 skipped。
- 计划列出的 OpenCode-family 扩展定向组（含 install/state）：331 passed / 0 failed / 0 skipped。
- manifest/package/Remote SSH 闭包组：198 passed / 0 failed。
- `npm run verify:electron`：Electron 41.10.2 通过。
- `npm test`（子代理 P3 补测后最终树）：6784 tests / 6763 passed / 0 failed / 21 skipped。
- `npm run build:mac`：x64 与 arm64 DMG 均成功；无 Developer ID，x64 未签名、arm64 ad-hoc 签名，未 notarize，仅作为本地 package sanity。
- x64/arm64 `app.asar.unpacked` 均包含 `opencode-plugin/index.mjs`、`opencode-family-plugin/core.mjs` 与 `session-ids.mjs`；asar 列表可解析三者，两个包内 core/helper 与当前源码 SHA-256 完全一致。
- arm64 packaged Electron 已短暂启动并写出 runtime port，随后确认主进程/helper 全部退出。该结果不等于 Windows 或 OpenChamber 产品验收。

### 15.4 尚未完成、不得宣称已验证

- Windows 11 + OpenChamber 1.17.2 自然复现与实际 OpenCode executable/version/override 取证。
- Windows HUD、Dashboard、permission focus、并发、重启和两个 warmup 子场景。
- MiMo Code 真实 lifecycle/event shape。
- Issue 自报 Clawd 0.19.0 的实际构建来源复核。
- 范围外的多 init bridge token/client/server 生命周期问题。
