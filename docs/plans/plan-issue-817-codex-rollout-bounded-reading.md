# Issue #817 Codex rollout 有界读取 — 修复计划

制定日期：2026-08-06

Issue：[A JavaScript error occurred in the main process #817](https://github.com/rullerzhou-afk/clawd-on-desk/issues/817)

代码基准：`main @ fad1b53d9a252cc8a765c1a7b6294f16a48d842c`

状态：**Draft PR #820 的代码 head `27add1e110a6d96472b9d120b66fca2236ff7267` 已完成七轮独立审查、mutation 验证、全仓测试与 macOS arm64 打包真机 smoke；第七轮结论为 `APPROVE`，未发现未解决的 P0-P3，已具备 Ready/合并条件。Issue 公开回复与发布不在本计划的自动执行范围内。**

复审注记：初稿先后经过子代理与 Claude 独立只读审查；本版只吸收经源码、定向探针或明确不变量验证成立的意见。复审发现初稿的 EOF 结算判据、绝对 pin 策略和 short-read oversized 判定存在缺陷，均已在本版重写。

版本控制注记：仓库 `.gitignore` 当前忽略 `docs/**`；本文已通过显式 `git add -f` 随 Draft PR #820 的初始提交纳入版本控制，后续修改会正常显示在该 tracked 文件的 diff 中。

实施验证（2026-08-07）：

- 收口提交前，远端 `main` 仍为本文基准 `fad1b53d9a252cc8a765c1a7b6294f16a48d842c`；Issue #817 仍为 OPEN、无新增评论。
- focused：`180 pass / 0 fail`。
- Remote SSH deploy manifest / dependency closure：`57 pass / 0 fail`。
- 全仓：`6947 pass / 0 fail / 21 conditional skip`；用户提供的修改前基线为 `6883 pass / 0 fail`。
- `verify:electron`：Electron `41.10.2` 完整性通过；两份修改脚本的 `node --check` 与 `git diff --check` 通过。
- `build:mac:arm64`：成功生成 ad-hoc 签名、未 notarize 的 `dist/Clawd-on-Desk-0.14.0-arm64.dmg`。
- packaged smoke：每轮审查补修后的精确代码均重新打包；最终代码 head `27add1e110a6d96472b9d120b66fca2236ff7267` 的 macOS arm64 App 使用隔离临时 HOME 面对 600 MiB 稀疏 Codex rollout 连续运行约 80 秒，主进程保持存活，未出现 `Cannot create a string longer than 0x1fffffe8 characters`；测试 App、临时 HOME、user-data 与 fixture 已停止并清理。
- 首轮独立实现审查（初始 head `aff82ec24fd56adcf2fc8a120baa33bfd0f16685`）确认三项缺陷并已补修：startup recovery 缓存候选消费前重验，防止重复 pending/覆盖 live tracker；validated baseline 后的持续失败继续执行 30 秒起、最高 5 分钟的指数退避，并让 deferred stat failure 同样遵守 `notBefore`；20 MiB recovery 账本按 head/tail 最坏物理读取量保守计费，覆盖两段重叠与文件并发增长。
- 二轮独立实现审查（补修 head `4da6119ea12abe45149044559a3dfad692863c8f`）确认首轮三项均已关闭，但发现 recovery 的固定候选计费无法同时约束反复 short read 的累计请求量，并会让空/极小文件挤掉后续有效候选。实现现已把 admission 的最新 stat 快照原样传入 reader，按该快照的真实 head/tail 范围计费，并让每段至多 8 次补读共享等于该段长度的总请求/分配预算；新增“每次只读 1 byte”与“15 个空文件后仍恢复 tiny pending”回归。
- 三轮独立实现审查（补修 head `eb411435883c6cb4af0d8500f3ddb6f71401f992`）确认前两轮问题均已关闭，但发现 recovery 读完后未重验 admission 快照：Windows LastWriteTime 冻结时，stat 后新增 pending 会因候选被消费、普通 old-mtime gate 又跳过而永久遗漏；head/tail 多次独立 open 期间的 inode replacement 还可能混合旧 root metadata 与新 subagent tail。实现现已在任何分类、回填、发卡或写 tracker 前完成 post-read stat 验证；identity 变化或 size shrink 整次 fail closed，冻结 mtime 的同 identity growth 保留为下一 bounded slice 的 continuation，不在原快照内扩读。新增 frozen growth、rename replacement、in-place shrink 和远端 frozen growth 回归。
- 四轮独立实现审查（补修 head `0eb5dc69db390703f3aaa751a9143d9ff93973b9`）确认三轮两个 P2 已关闭，预算/tiny/backoff 仍成立，但发现稳定 recent-backfill 会先直接注册 classifier，再经 `_applySessionMeta()` 重复注册一次。实现现已让含 head meta 的 raw tail 只由 rawLines 注册，tail 不含 head 时才显式 apply 一次，普通 pending 则直接注册一次；回归锁定快照验证后的 classifier registration 恰好一次。
- 五轮独立实现审查（补修 head `591092589ad61f45052c383f60f97f800b3a7d10`）确认 production recent-backfill 已只分类一次，但发现 direct recovery 入口仍会重复分类，且普通 stale pending 的 direct/production 路径只分类、不应用 `session_meta`，导致 `originator/source` 丢失。实现现已统一为唯一 `_applySessionMeta()` 路径：small recent tail 由 raw head line 应用，head 在 tail 外时显式应用，普通 stale pending 始终应用单独读取的 head；回归分别锁定 direct small/large recent 与 direct/production stale pending 的 classifier 次数、`cwd/originator/source` 和 pending 回调。
- 第六轮 Claude 交叉审查（审查 head `40d0426556c4e067638fdb9498477055510d011b`）没有发现新的 production P0/P1/P2，但确认三类回归 oracle 仍不足以锁住已实现不变量：admitted replay 不受 active/retired LRU 汰换、recovery head short-read 按真实 `bytesRead` 续读、剩余轮询预算不足时不把一个完整 quantum 切成 fragment；审查还发现远程 replay 尚在 `initializing` 时 stale cleanup 可能误发 `sleeping`。本轮已同时补本地/远程回归与远程 stale gate；亲跑 mutation 证明分别移除 LRU prune filter、retire guard、真实 short-read cursor、整 quantum budget defer 或 remote initializing gate 后新测试必红。Claude 标记的 legacy recovery sweep 死代码与 #817 安全性修复无关，保留为独立清理 follow-up，不在本 PR 扩大生产改动范围。
- 第七轮 Claude exact-head delta review（审查 head `27add1e110a6d96472b9d120b66fca2236ff7267`）独立复现 focused `180 pass / 0 fail`、Remote SSH manifest/deploy `57 pass / 0 fail`、全仓 `6947 pass / 0 fail / 21 skip`，并亲跑 prune filter、retire guard、本地/远程 short-read cursor、本地/远程 budget fragment 与 remote initializing gate 七项 mutation，结果 `7/7 CAUGHT`。审查确认 remote stale gate 与 abandonment/rebaseline 生命周期一致，legacy recovery sweep 不可达代码保留为非阻塞 follow-up 合理；最终结论为 `APPROVE`，未发现未解决的 P0-P3。
- 残余验证边界：未取得报告人的真实 rollout；未做 x64、Windows、Linux 或真实 Remote SSH 主机 smoke；arm64 smoke 证明打包生产入口不再立即执行无界解码，不等同于完整追完 600 MiB backlog。

---

## 0. 一句话结论

本地 `agents/codex-log-monitor.js` 和远程 `hooks/codex-remote-monitor.js` 都会按“文件大小 - 当前 offset”一次性分配 Buffer 并整体解码；当未读区间足够大时，本地 Electron 主进程会在 `Buffer.toString()` 撞上 V8 的单字符串上限。修复应同时限制**单文件单次请求/分配为 4 MiB**、**一次轮询的总请求/分配为 16 MiB**和**每轮最多 64 个候选尝试**，以去重的 full-quantum 公平轮转按真实 `bytesRead` 与完整换行推进 offset，把不完整行留在磁盘；初始化/回填依据“本轮实际扫描是否覆盖快照 EOF”结算，而不是依据 committed offset。远程 monitor 同时移除可跨轮无限增长的内存 `partial`。

---

## 1. 现象、证据与根因

### 1.1 Issue 现场

#817 报告的 macOS 打包应用主进程栈为：

```text
Error: Cannot create a string longer than 0x1fffffe8 characters
at Buffer.toString (node:buffer:937:14)
at CodexLogMonitor._pollFile (.../agents/codex-log-monitor.js:817:50)
at CodexLogMonitor._poll (.../agents/codex-log-monitor.js:234:14)
at Timeout._onTimeout (.../agents/codex-log-monitor.js:184:18)
```

`0x1fffffe8`（536,870,888）与当前 Node/V8 暴露的 `buffer.constants.MAX_STRING_LENGTH` 完全一致。当前主线第 817 行正是：

```js
const text = buf.subarray(0, committedBytes).toString("utf8");
```

因此，报错不是某一条 JSON 损坏，也不是普通编码异常，而是**单次解码目标超过运行时允许的最大字符串长度**。

### 1.2 本地生产路径为何会无界

`CodexLogMonitor._pollFile()` 当前流程是：

1. 用 `fstatSync(fd)` 取得打开后文件大小；
2. 计算 `readLen = openedStat.size - tracked.offset`；
3. `Buffer.alloc(readLen)`；
4. 一次 `readSync()` 读取整个未读区间；
5. 找到最后一个换行后，把此前全部字节一次性转成字符串并 `split("\n")`。

新发现的 rollout、Clawd 重启后的回填、长时间未被轮询后恢复的文件，都可能让 `tracked.offset` 落后于 EOF 很远。`_readPositions` 只在当前 Clawd 进程内存中保存，并不跨应用重启持久化，因此“大文件 + 新进程首次 attach”是合法生产场景。

安全模拟把打开后文件大小设为 `MAX_STRING_LENGTH + 1`，同时阻止真实大分配；当前实现仍会请求一次 `536,870,889` 字节的 Buffer，证明读取长度没有上限。Issue 没有提供具体 rollout 文件大小，因此计划不声称报告人的文件一定是多少字节；但栈、运行时常量和当前代码足以确定故障机制。

### 1.3 远程路径有同源缺陷

`hooks/codex-remote-monitor.js::pollFile()` 同样使用：

```js
const readLen = stat.size - entry.offset;
buf = Buffer.alloc(readLen);
```

而且它会先把本轮解码结果与 `entry.partial` 拼接，再保存新的 `partial`。所以只给 `readLen` 加上限但不限制/删除 `partial`，跨多轮后仍可能构造出超大字符串。远程进程不会弹 Electron 主进程错误框，但仍可能卡死、OOM 或退出，并让 Remote SSH 的 Codex JSONL fallback 静默失效。

远程脚本已经位于 `src/remote-ssh-deploy.js::HOOK_FILES`，本计划不新增 helper 文件，因此不需要改变部署 manifest；修改后的脚本仍会通过既有部署 hash/read-back 流程下发。

### 1.4 现有测试为何没有发现

当前基线：

```text
node --test test/codex-log-monitor.test.js test/codex-remote-monitor.test.js
129 pass / 0 fail
```

现有用例覆盖短读、截断、文件替换、tracker 淘汰、回填、UTF-8 tail、pending `request_user_input` 等复杂边界，但没有约束：

- 单次 `Buffer.alloc()` / `readSync()` 的最大长度；
- 一个 backlog 必须跨多轮逐步追赶；
- 初始化状态在“只读完第一块、尚未追到 EOF”时不能提前结束；
- 远程 `partial` 的内存上限。

因此这是**回归 oracle 缺口**，不是现有测试失败。

---

## 2. 修复目标与非目标

### 2.1 必须实现

1. 任意文件大小下，本地和远程 monitor 的单次 Buffer 分配与字符串解码都有固定上限。
2. backlog 跨多轮读取时，完整 JSONL 记录不重复、不跳过，offset 只按真实读取/提交结果推进。
3. 不完整 UTF-8/JSONL 尾行不转成持久字符串，继续留在磁盘，待后续写完整后从记录起点重读。
4. oversized discard 只能在本轮确实读满一个 4 MiB record window，或确实扫描到 snapshot EOF 的长不完整尾行时发生；任意 short read 不得仅因返回量大于 64 KiB 就被误判为 oversized。
5. 本地 `backfilling`、本地 `initializingUserInputs`、远程 `initializing` 都只能在本轮实际扫描覆盖文件快照 EOF 后结束；committed offset 可以因未完成尾行仍小于 snapshot size。
6. 已准入 replay 在 active LRU、day-dir 滑出扫描窗口和 151+ 候选压力下都不能丢富状态或把剩余历史当 live；未准入候选不得先读半截，同时 replay 不能永久占住全部 50 个 active 槽位。
7. 保留本地 file identity、短读、截断/替换和 read-position ledger 的安全语义；rebaseline 必须静默终止旧 replay，不能发布旧文件重建出的 snapshot/pending。
8. 本地与 Remote SSH monitor 同轮修复，避免只把崩溃从桌面进程转移到远程 daemon。

### 2.2 明确不做

- 不删除、截断、迁移或重写用户的 `~/.codex/sessions`。
- 不修改 Codex official hooks 与 JSONL fallback 的职责分工。
- 不持久化 `_readPositions` 到磁盘；这是可独立评估的性能/恢复设计，不是 #817 的必要条件。
- 不改 agent gate、Remote SSH routing、nonce、部署 lease、网络端口或代理配置。
- 不借本 Issue 重构两个 monitor 的全部重复代码，也不新增远程 helper/`HOOK_FILES` 条目。
- 不把 `try/catch`、提高堆上限或让用户删除历史记录当作根治方案。
- 不在本修复中自动回复/关闭 Issue、创建 PR、合并或发布版本。

---

## 3. 强制不变量

以下任一不满足，修复不可交付。

### B1 — 单文件、整轮分配与候选尝试都有硬上限

新增语义常量：

```js
const MAX_POLL_READ_BYTES = 4 * 1024 * 1024;
const MAX_POLL_TOTAL_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_POLL_FILE_ATTEMPTS = 64;
const MAX_ACTIVE_DIR_DISCOVERY_ATTEMPTS_PER_POLL = 16;
```

本地每个文件每次 `_pollFile()`、远程每个文件每次 `pollFile()` 最多请求/分配 4 MiB；一次正常 poll 在所有 rollout 之间合计最多请求/分配 16 MiB，并最多尝试 64 个候选文件：

```js
const requiredQuantum = Math.min(
  fileSnapshotSize - offset,
  MAX_POLL_READ_BYTES
);
if (remainingRequestBudget < requiredQuantum) {
  // Do not issue a fragmentary read. Resume from this candidate next poll.
  return DEFER_TO_NEXT_POLL;
}
const readLen = requiredQuantum;
```

请求/分配预算按 `readLen` 在分配前扣减，因为 `Buffer.alloc(readLen)` 即使最终只 short-read 1 byte，也已经付出了整段同步分配/清零成本；`bytesRead` 仍是 offset、解析和诊断的唯一真相，并且实际读取量自然不超过请求预算。另设文件尝试上限是为了约束 stat/open/read 失败、0-byte 和 `size===offset` 等不消耗字节预算的路径。

一次 file attempt 从 discovery 阶段准备对该 path 做首次 `statSync` / admission 判断之前就开始计数，而不是等进入 `_pollFile()` 才计；获取不到 attempt token 就停止本轮发现并保存目录/path 游标。每个 attempt 内的 pre-stat/open/fstat/read 是固定数量的同步操作。正常 discovery、admitted replay、deferred retry、startup recovery 候选 stat，以及本地 `_getActiveDayDirs()` 为旧 day-dir 内 rollout 做的逐文件 `statSync`，都共用同一个 64 次全局上限，不能先无界 stat/分类完所有文件再交给 scheduler。

本地把 `_getActiveDayDirs()` 改成可续跑的增量 walker，持久保存 year/month/day/file cursor；每轮最多使用全局 64 个 token 中的 16 个，至少把其余 48 个留给已知目录的数据候选，walker 无工作时可借给数据路径。一次完整 walker pass 期间保留上一轮完成的 active-day cache，并 union 本轮新发现的 active dir；只有完整 pass 结束后才原子替换 cache，避免半轮结果把仍活跃的旧目录误删。startup recovery 同样以持久目录/path cursor 跨 poll 完成 discovery，使用固定大小的 top-20 newest 候选集合；attempt token 用尽时不得把 `_didInitialRecoveryScan` 提前设为完成，也不得先 materialize/sort 无界 `recoveryCandidates`。目录级 `readdirSync` 名称数组仍是 §10 明示的残余边界。

候选必须先按 canonical `filePath` 去重，同一文件一轮至多调用一次读取入口。处理顺序使用跨轮游标或等价 round-robin；任意 data-bearing 候选的完整 quantum 都是 `min(snapshotUnread, 4 MiB)`。剩余预算不足该 quantum 时，本轮**完全不读该文件**并让下轮从它开始，不能反复给无换行文件碎片 quantum——这个规则同样覆盖 `64 KiB < snapshotUnread < 4 MiB`，否则一个 3 MiB 无换行尾行也可能每轮只拿到 1 MiB、offset 永远不动。启动 recovery sweep 继续受其已有独立文件数/总字节预算保护，不得把两个预算相加后误称为同一个不变量。

测试必须观察真实传给 `Buffer.alloc` / `fs.readSync` 的长度、一整轮累计请求量、真实 bytesRead、候选尝试数和去重结果，不能真的创建 512 MiB 测试字符串。4 MiB 是单次扫描上限，不是任意写入时序下的 JSONL 最大记录承诺；若实现阶段以测量证据调整常量，仍须是固定有限值，并同步本文与测试。

### B2 — `bytesRead` 是读取真相

不得用先前的 `stat.size` 或请求的 `readLen` 假定实际读取成功。发生 short read 时：

- 只处理 `buf.subarray(0, bytesRead)`；
- 只按该有效区间内的完整换行推进；
- 读取失败或 `bytesRead <= 0` 时不推进 offset；
- fd 必须在 `finally` 中关闭。

本地已有这套约束；远程 monitor 必须补齐，不能继续 `entry.offset = stat.size`。

唯一例外是 B5 明确定义的 no-progress fail-closed abandonment：达到次数+时间双阈值后，可以把 offset 静默基线到该 work item **最后一次成功验证过的 snapshot EOF**（本地为 open 后 `fstat` 且已通过与 pre-stat 的 identity 一致性检查，远程为其既有 size-only 模型下的成功 pre-open stat），明确放弃尚未可靠处理的旧 snapshot。它不是“读取成功”或“记录已提交”，必须走独立分支、不得解析/外发被跳过内容，并由专门回归锁定。

### B3 — 只提交完整换行记录

对本轮有效 Buffer 在**原始字节空间**寻找最后一个 `0x0A`：

- 找到：只解码到 `lastNewline + 1`，offset 只增加这段 committed bytes；最后换行后的尾巴不缓存，留在磁盘下轮重读。
- 未找到且有效字节数 `<= MAX_PARTIAL_BYTES`：offset 不动，整段留在磁盘等待补齐。
- 未找到且有效字节数 `> MAX_PARTIAL_BYTES`：**不能仅凭返回量就 discard**。只有满足以下任一可证明条件时，才按既有容错策略推进 `bytesRead` 并丢弃：
  1. 本次完整读满请求，而且请求长度等于 `MAX_POLL_READ_BYTES`，证明从当前记录边界起至少一个完整 cap 内没有换行；
  2. 本次完整覆盖到 snapshot EOF，证明当前快照里存在一个超过 64 KiB 的未完成尾行。
- 若 `readSync` 任意 short read 后尚未覆盖 snapshot EOF，即使返回量已超过 64 KiB，也必须保持 offset 不动并在后续轮询重试，不能把一个本可在 4 MiB 内完成的记录误判为 oversized。

从 oversized record 中段恢复时，本轮第一个换行前可能是 JSON 片段；让既有 `JSON.parse` 失败路径忽略该片段即可，后续完整记录仍正常处理。不得为了修复它而重新拼接无界字符串。

记录尺寸契约以“从记录起点到终止 LF 的总字节数”为准：在完整、稳定快照和 full read 下，该跨度 `<= MAX_POLL_READ_BYTES` 的记录必须保留，`> MAX_POLL_READ_BYTES` 的记录会被确定性丢弃并在下一换行后恢复。超过 64 KiB 的**未完成 snapshot 尾行**仍可能按既有策略丢失；这个写入时序例外必须在文档和测试中明确，不能宣称“所有 4 MiB 以下记录永不丢”。

### B4 — replay 依据“扫描到 snapshot EOF”结算，不依据 committed offset

在 read 前保存 `readStartOffset`，以本轮打开后的文件大小作为 `snapshotSize`（远程暂用 pre-open stat），只用真实返回量计算：

```js
const scannedToSnapshotEnd =
  readStartOffset + bytesRead >= snapshotSize;
```

committed offset 只表示最后一个已提交换行的位置；当快照末尾存在未完成尾行时，它可以长期小于 `snapshotSize`，不能拿来判断 replay 是否已扫描完整个快照。

实现一个共同的正常结算出口，例如 `finalizeReplayAfterScan(scannedToSnapshotEnd)`：

- 本地在 `backfilling && scannedToSnapshotEnd` 时才 `_emitBackfillSnapshot()` 并清 `backfilling`；
- 本地在 `initializingUserInputs && scannedToSnapshotEnd` 时才清初始化标志并 `_emitPendingUserInputRequests()`；
- 远程在 `entry.initializing && scannedToSnapshotEnd` 时才结束初始化；若其目录仍在正常扫描窗口内，再发布 unresolved pending requests；若已 out-of-window，则按 B5 fail closed，清除 staged pending 而不发卡，避免发布后立即 prune、永远收不到 resolution。

正常结算出口必须覆盖：正常 newline commit、经证明安全的 oversized discard、以及“已扫描到 EOF 但未完成尾行仍留盘”的路径。最后一种情况下 offset 可以不推进，但 replay 仍应结束；尾行以后若被补齐，再按 live append 从记录起点重读。`stat.size === offset` 的无数据早退也要先结算已有 replay flags。

`bytesRead <= 0`、读取失败、或 short read 尚未覆盖 snapshot EOF 时不结算。文件在读取后继续增长不影响本不变量：只对本轮固定 snapshot 负责，不能在处理后重新 stat 并追逐持续变化的真实 EOF。

### B5 — replay 必须使用有界准入 working set，不能依赖无界绝对 pin

4 MiB 分块会把初始化/回填变成正常的多轮状态。当前 active tracker 上限为 50、retired 富状态上限为 100，而且 `_poll()` 只遍历当轮 `_getSessionDirs()`；因此“绝对排除 replay tracker 淘汰并等待后续轮询追完”不成立：老 day-dir 掉出 active/latest-7 窗口后，它既不再被 poll，也不会自动释放槽位。

不能采用“rich 状态淘汰后从 0 重放”的方案：当 50 active + 100 retired 之外还有第 151 个多块 replay 时，公平轮转会循环淘汰富状态，各文件可能永远重复第一块而没有完成进度。定案改为**有界准入 working set**：

```js
const MAX_REPLAY_WORK_ITEMS = 40;
const MAX_BACKGROUND_REPLAY_WORK_ITEMS = 32;
const MAX_DEFERRED_RECENT_PATHS = 192;
const MAX_DEFERRED_BACKGROUND_PATHS = 64;
const MAX_REPLAY_NO_PROGRESS_ATTEMPTS = 8;
const REPLAY_NO_PROGRESS_TIMEOUT_MS = 30 * 1000;
const REPLAY_RETRY_BASE_BACKOFF_MS = 30 * 1000;
const REPLAY_RETRY_MAX_BACKOFF_MS = 5 * 60 * 1000;
```

1. rich tracker 的权威 replay phase 仍由现有 `backfilling || initializingUserInputs` 表示，不增加会与两者漂移的第三个 phase 布尔，也不把 pending/state/quota 塞进 `_readPositions`。
2. 一个可能需要多轮的首次 attach 在读取第一字节前必须获得 replay work slot；已准入 tracker 在正常结算、rebaseline、路径消失或 `stop()` 之前保留全部富状态和单调 offset，**不得进入 active/retired LRU 淘汰**。
3. 最多 40 个 replay work item，其中最多 32 个可由旧 mtime/background replay 占用，至少 8 个 slot 保留给 active-window 内的新 rollout。工作项仍可引用 `_tracked` 中同一个 tracker 对象，但它的生命周期由 bounded replay working set 保护，而不是依赖 `_retiredTracked` 容量。
4. 没有 slot 的文件在任何读取前进入按 path 去重的轻量 deferred queue，只保存 path、发现顺序、lane、用于重新校验的最小 identity/mtime 信息，以及可选的 `notBefore` / `retryLevel`；offset 保持 0，因此不存在“已处理半截却丢富状态”。后两个字段只用于 `hasValidatedSnapshot=false`、没有任何外发事件的失败候选延迟重试，不承担 replay 富状态；所有 discovery/admission 来源在同一 canonical path 命中 deferred entry 时都必须遵守 `notBefore`，不能由普通 mtime/size 更新绕过。recent/background 是两个独立 FIFO lane，容量分别固定为 192/64；某 lane 满时只在该 lane 内按规则替换/丢弃，recent 洪峰不得挤占 background 的 64 个保留位，反之亦然。被丢候选以后仍可由正常目录扫描或 startup recovery 重新发现，但不承诺极端溢出下恢复所有历史状态；即使延迟信息随候选溢出丢失，也只会让一个从未验证过 snapshot 的路径较早再试，不会重复外发事件。
5. slot 释放后的准入采用明确的 3:1 recent/background 加权轮转（某 lane 为空时另一 lane 借用），保证 recent 不被旧 backlog 长期阻塞，background 也不会被持续的新 session 永久饿死。已准入 replay 与普通 tracked 文件进入一个按 canonical path 去重的 cyclic scheduler；每个被选中的 data-bearing 文件获得至多一个完整 4 MiB quantum。
6. 已准入 replay 即使其 day-dir 滑出 active/latest-7 窗口，也继续由 working set 调度并获得完整 quantum，直到正常结算或 B6 静默中止；完成后释放 slot，再按公平顺序准入 deferred 文件。
7. 每个 work item 记录 `consecutiveNoProgress`、`lastProgressAt`、`lastValidatedSnapshotSize` 与本地 `lastValidatedIdentity`。本地只在成功 open/fstat 且 opened identity 与 pre-stat identity 一致后更新这组 validated snapshot；若 identity 改变，立即走 B6 rebaseline abort，不能进入 no-progress abandonment。远程因保留既有 size-only 模型，只用成功的 pre-open stat 更新 snapshot size。只有 committed/discarded offset 前进或正常 scan-to-EOF 结算才算进度；任何进度都重置连续失败计数与 retry backoff。读取异常、0-byte、以及未到 EOF 且无可提交换行的 short read 都不算。连续无进度至少 8 次且距离上次进度至少 30 秒时，走独立的 `abandonReplayAtValidatedSnapshot()`：
   - 不从 0 重放；把 tracker/ledger offset 静默设为最后一次验证过的 snapshot EOF，并同步已验证 identity；
   - 清除**仅处于 replay staging、从未外发**的状态，不发 snapshot、pending、resolution 或 lifecycle：本地 `backfilling=true` 时丢弃用于合成 backfill snapshot 的 `lastState` / `hadToolUse` / assistant output 等；两端都清除初始化期间被压住、从未发布的 pending request；
   - 不得清除已经对应外发 lifecycle 的 live bookkeeping。本地 recent attach 可能是 `backfilling=false, initializingUserInputs=true`，远程 `initializing` 也只压 pending、不压普通 lifecycle；这两类 tracker 已提交记录形成的 `lastState`、dedupe/stale 状态、`hadToolUse` 与 assistant output 必须保留，使未来新增的 completion 仍只处理一次并保持正确语义；
   - 清 `backfilling` / `initializing*` 并释放 work slot；tracker 以后只从该 baseline 处理新增字节，因此首块已外发事件不会重复；
   - 设置 per-path read backoff，30 秒起指数增长、最高 5 分钟；本地把 baseline identity/offset 与 `readBackoffUntil` / `readBackoffLevel` 保存在现有 `_readPositions` ledger 中，远程保存在 tracker entry 中，不另建第二张失败路径表，也不为调度全表扫描。后续读取成功产生 committed/discarded progress 才重置，普通 mtime/size 增长不能绕过。
   分支只允许使用唯一谓词 `hasValidatedSnapshot`：即使 `readSync` 返回 0，只要本地 open 后 `fstat` + identity（或远程 pre-open stat）成功，就必须走上述 baseline abandonment；只有 validation 从未成功、`hasValidatedSnapshot=false` 时，才释放 work slot 并把 path 作为带 `notBefore` / `retryLevel` 的普通 deferred 候选延迟重试。后者没有已外发记录，不存在重复外发风险。不得用“是否读到字节”代替该谓词，不得让 40 个 EACCES/0-byte 文件永久毒死全部 slot，也不得在退场时发布 staged 状态。
8. active LRU 仍只淘汰 replay 已完成的普通 tracker；由于 replay working set 最多占 40 个 `_tracked` 引用，50 个 active 槽位至少留出 10 个给普通/live tracker。需要腾位时淘汰普通 tracker，不能把 admitted replay 塞进 `_retiredTracked`。
9. `stop()` 清空 active/retired/replay/deferred/ledger；这不是 LRU 退休流程。

远程 monitor 没有本地 active/retired LRU，但同样引入固定上限的 initializing working set、deferred queue 与 no-progress abandonment/backoff；entry 保存最后验证的 stat snapshot size，退场后从该 baseline 继续新增字节，不能从 0 重放已 POST 的生命周期。`pruneTrackedOutOfWindow()` 不得删除仍 admitted 且 `initializing=true` 的 entry；它继续受 B1/B5 调度直到结算或安全中止。若 entry 在 out-of-window 状态追到 EOF 且仍有 unresolved pending request，必须 fail closed：不发布这些随后无法继续跟踪 resolution 的卡片，清 staged pending 后释放 initialization，再允许 prune；不能“先发卡、同轮删 tracker”。两端的 deferred queue 与每轮候选访问都受固定容量/尝试数保护，不能每轮扫描整个无界 ledger/Map。

### B6 — rebaseline 与 read-position 规则必须显式区分“正常结算”和“静默中止”

本地保留 open 前后 identity/size 校验，但所有早退路径都必须处理 replay phase：

- pre-stat `stat.size === tracked.offset`：这是正常已追到当前快照，走 B4 正常结算；
- pre-stat 曾为 `size > offset`，但 open/fstat 后同 identity 的 `openedStat.size === tracked.offset`：`readLen <= 0` 早退前同样走 B4 正常结算；不得只覆盖第一个 equality；
- open 前或 open 后发现 identity 改变/文件缩小：保持既有“跳到新 snapshot EOF”的静默 rebaseline，但调用独立的 `abortReplayForRebaseline()`；清除尚未发布的初始化 pending 与 replay phase，**不得**调用 `_emitBackfillSnapshot()` 或 `_emitPendingUserInputRequests()`；
- remote size truncation 保留其既有“offset 重置为 0 后读取新内容”的模型，但必须先丢弃旧文件的 staged initialization state，再为新 snapshot 重新建立 initialization；空文件路径也要能结束旧 phase，不能永久粘住。

正常 commit 与 oversized discard 后，`tracked.fileIdentity` 和 `_readPositions.identity` 必须一起更新为本轮 opened identity；除 B5 明确定义的 abandonment baseline 外，所有 offset 只保存最后 committed/discarded raw-byte 位置。正常结算或静默中止 replay 时释放 working-set slot；不得留下无法再次调度的占槽对象。

rebaseline 的测试必须证明旧文件已积累但尚未发布的 sustained snapshot/pending request 不会泄漏到新文件。已完成初始化的普通 tracker 退休/二次淘汰后仍按现有 ledger 从同 identity 的 committed offset 恢复。

### B7 — 远程不再保留无界 `partial`

远程 monitor 迁移到与本地一致的 disk-backed incomplete-tail 约定：

- 新 tracker 不再创建 `partial`；
- truncation 不再清一个不存在的 `partial`；
- `pollFile()` 不再拼接 `entry.partial + decodedChunk`；
- `recoverStalePendingUserInputEntry()` 在 raw tail Buffer 中找到最后一个完整换行，recovered offset 停在该换行后，不越过未完成尾行；
- recovery tracker 不再携带 `partial`，后续 append 由普通 `pollFile()` 从完整记录起点重读并解析。

这一步必须移植本地 recovery 已有的 raw-byte 逻辑，包括“tail window 恰好从记录边界开始”和“window 从多字节字符中间开始”的处理；不得从解码后的字符串长度反推 raw-byte offset。源码中“recovered entry 已追到真实 EOF”的旧注释也必须同步改为“停在最后完整换行，未完成尾行留盘”。

### B8 — recovery 的 head/tail 游标也以真实 raw `bytesRead` 为准

本地 `_readByteRange()` 已返回 `{ text, bytesRead, buf }`，远程 `readByteRange()` 必须对齐为同样的有效 raw Buffer 契约。两端 `readCompleteFirstLine()` 当前都存在 short read 后把 `readSoFar` 直接设为请求 target 的旧行为，可能跳过实际未读字节；既然本轮会修改 recovery framing，应一起封口：

- head reader 只按真实 `bytesRead` 增加 raw-byte 游标；`bytesRead <= 0` 或读取异常时 fail closed；
- 不把多个独立解码字符串直接拼接来跨越 UTF-8 边界；在最多 `RECOVERY_HEAD_LINE_MAX_BYTES` 的 raw Buffer 中找换行，只解码完整第一行；
- tail boundary、最后换行、committed tail bytes 和 recovered offset 都基于实际返回的 raw Buffer；tail window 若 short read，必须在固定 `RECOVERY_TAIL_SCAN_BYTES` 预算内从真实 `bytesRead` 位置继续补读，直到覆盖本轮 snapshot EOF；若在抵达 snapshot EOF 前出现 0-byte/异常，则该次 recovery fail closed、不得用“尾窗前半段”推断 pending 状态；
- short read 不能用请求长度补齐 offset，也不能从含 U+FFFD 的解码文本反推字节数。
- head/tail 补读除字节预算外还必须有固定尝试次数上限，例如 `RECOVERY_MAX_READ_ATTEMPTS = 8`；超过次数即 fail closed。不能让每次只返回 1 byte 的文件系统在主线程制造最多数十万/上百万次同步 open/read/close。

这条 fail-closed 很关键：如果 request 已落在 short-read 的前半段，而对应 resolution 仍在尚未读到的后半段，把前半段当完整 tail 会错误复活历史卡片。

这不是扩大 recovery 扫描预算；head 仍最多 256 KiB，tail 仍最多 1 MiB，同时各自最多固定次数的读取尝试。UTF-8 边界测试必须验证 raw Buffer 拼接；当前逐块 `toString()` 再拼接通常仍能 `JSON.parse`，但会把跨块字符污染成多个 U+FFFD，不能只用“是否抛解析错误”作为 oracle。

全局 `RECOVERY_SWEEP_MAX_TOTAL_BYTES = 20 MiB` 必须按**同一 admission stat 快照下的物理请求上界**记账。每个准备消费的候选先重验 live tracker、replay/deferred 状态、`notBefore` 与最新 stat；通过后把这份 stat 快照原样传给 recovery reader，按 `min(snapshotSize, 256 KiB) + min(snapshotSize, 1 MiB) + (snapshotSize > 1 MiB ? 1 : 0)` 预留 head、tail 与 boundary byte 的范围预算，预算不足则停止本轮 recovery。head 和 exact-range reader 各自至多尝试 8 次，并让所有 short-read 补读共享一个不超过目标范围长度的总请求/Buffer 分配预算；不能每次重新申请完整剩余范围，令实际请求量成倍超过账本。空文件消费 0 byte，极小文件按真实范围计费，不能被固定最坏值提前挤出本轮。

读取完成后、在任何 classifier/backfill/quota/notification 副作用以及 tracker 写入前，必须再次 stat。本地 identity 变化、size shrink 或无法证明仍是同一文件时，整次 recovery fail closed，不能混合不同快照的 head/tail；远程维持既有 size-only 模型，至少对 size/mtime 变化 fail closed，same-size 原地 replacement 仍是既有边界。文件消失则释放候选。若本地同 identity（远程为 size-only 连续性）文件在 admission 后增长，本轮仍只承认旧 snapshot 范围：已经从旧快照恢复出 tracker 时，由该 tracker 从旧 committed offset 续读；旧快照尚无可恢复状态时，必须保留候选为下一次 bounded slice 的 continuation，使 Windows 冻结 LastWriteTime 的追加不会再被 untracked old-mtime gate 永久跳过。continuation 继续共用累计 20 文件/20 MiB 上限，不能在原 slice 内自行扩读新增长。

### B9 — catch 只是保险，不能替代有界读取

不得仅在 `toString()` 或 timer 外层吞异常。那会让同一文件每 1.5 秒重新尝试巨量分配，持续冻结主进程并可能升级为 OOM。实现可以保留/补充窄范围的文件级错误隔离，但必须先满足 B1-B8，且错误路径不得推进未经确认的 offset。

---

## 4. 具体改动设计

### 4.1 `agents/codex-log-monitor.js`

按以下边界修改：

1. 定义单文件 4 MiB、整轮请求/分配 16 MiB、每轮 64 个候选尝试上限；attempt 从 discovery stat 前计数，`_poll()` 维护目录/path 游标、去重候选和跨轮公平游标，`_pollFile()` 接收剩余请求预算并报告 requested/bytesRead/结果分类；把 `_getActiveDayDirs()` 改为每轮最多占 16 个全局 attempt token 的可续跑 walker，startup recovery discovery 改为跨轮 cursor + bounded top-20 候选。
2. `requiredQuantum = Math.min(unreadBytes, MAX_POLL_READ_BYTES)`；剩余请求预算不足时不读取并保留游标，足够时 `readLen=requiredQuantum` 并在分配前扣预算。offset/解析只信 bytesRead；保留 open → fstat → identity recheck → read → finally close 顺序。
3. 保留 raw-byte `lastIndexOf(0x0a)` 与 committed offset 方案；新增 B3 的 discard 证明条件，任意 short read 不得误丢记录。
4. 用 `readStartOffset + bytesRead >= openedStat.size` 计算 `scannedToSnapshotEnd`；正常 commit、合法 discard、EOF incomplete tail 和 `size===offset` 都进入 B4 正常结算。
5. identity/truncation rebaseline 进入独立静默 abort，不发布旧 snapshot/pending；正常推进时同步 `tracked.fileIdentity` 与 `_readPositions.identity`。
6. 增加 bounded replay working set 与双 lane deferred queue；任何首次读取前先准入，admitted replay 保留富状态且不参加 active/retired LRU，完成/abort 后释放 slot；连续无进度达到次数+时间双阈值时，以唯一的 `hasValidatedSnapshot` 谓词分支：true 则静默 baseline 到该 snapshot EOF 并保留 bounded backoff，false 才退回带延迟字段的 deferred queue。
7. 调度候选按 canonical path 去重，包含正常发现、admitted replay 和 deferred admission；day-dir 掉窗不终止 admitted replay，近期与 background 使用有界加权轮转。
8. `_readCompleteFirstLine()` 与 recovery tail 用 raw Buffer、真实 short-read 游标和固定尝试次数上限，不增加 256 KiB/1 MiB 字节预算。
9. 不改 `_processLine()` 的事件映射、quota、assistant output、session title 和 subagent 分类；仅为 replay 生命周期增加必要的清理/恢复入口。

注意：`openedStat.size` 是本轮打开后快照。不能在处理完后再 `statSync` 并要求追上持续增长的真实 EOF，否则高写入会话可能永远无法结束初始化。

### 4.2 `hooks/codex-remote-monitor.js`

远程实现对齐本地 framing 语义，但不引入新 helper：

1. 增加单文件 4 MiB、整轮请求/分配 16 MiB、每轮 64 个候选尝试与 `MAX_PARTIAL_BYTES` 常量；attempt 从 discovery stat 前计数，`poll()` 按 path 去重，按请求量记总预算，并公平轮转 tracked/initializing/deferred 文件。
2. `pollFile()` 继续使用 pre-open `stat` 作为本轮 size snapshot，不新增 inode/fstat identity 模型；改为有界 `readLen`、权威 `bytesRead`、`finally` close、raw-byte newline commit。
3. offset 从“直接跳到 `stat.size`”改为“按 committed/经证明 discard 的 bytes 增加”；任意 short read 不触发 oversized discard。
4. 删除 tracker 的 `partial` 字段和所有拼接逻辑。
5. truncation 不再清不存在的 partial；先丢弃旧 staged initialization，再从 offset 0 对新 snapshot 重新初始化，空文件也能安全结束旧 phase；out-of-window pruning 延迟删除 admitted initializing entry，若其在窗口外以 pending 结束则 fail closed 不发卡再 prune。
6. 使用 `readStartOffset + bytesRead >= stat.size`；正常 commit、合法 discard、EOF incomplete tail 与 `size===offset` 都能结算 `initializing`。
7. `readByteRange()` 返回有效 raw `buf`；`readCompleteFirstLine()` 和 tail 按真实 bytesRead 前进，使用 raw Buffer，并有固定尝试次数上限。
8. `recoverStalePendingUserInputEntry()` 在最后完整换行处停止 offset；更新对应测试的旧 partial 断言和“已到 EOF”旧注释。
9. 增加与本地同样有固定上限的 initializing working set/deferred admission/no-progress baseline abandonment/backoff，但不引入 active/retired LRU；保留 standalone、Node >= 14、纯内置模块/同目录已登记 helper 的部署约束。修复后的远端脚本仍需用户执行 Settings → Remote SSH → Deploy / Repair Hooks 才会替换既有部署。

远程 `pollFile()` 当前没有本地的 inode/birthtime identity 模型；#817 不顺带扩大为远程 rotation 架构重写，保留既有 size-based truncation 假设，但补齐 short-read 与 fd-close 正确性。

### 4.3 不新增共享 helper 的理由

本次只有读取上限与 framing 语义需要同步。新建共享 hook helper 会扩大远程部署 manifest、依赖闭包、hash promotion/read-back 和 rollback 面；而本地/远程 tracker 状态机本来就不同。先用小范围镜像实现 + 两套同构行为测试封住缺口。若未来继续出现 drift，再单独评估抽取纯 framing helper。

---

## 5. 文件级实施清单

| 文件 | 计划改动 |
|---|---|
| `agents/codex-log-monitor.js` | 限制单文件/整轮请求与候选尝试；去重公平调度；scan-to-EOF 结算；bounded replay admission/deferred queue；保持 raw-byte offset/identity；修 recovery short read/UTF-8 |
| `hooks/codex-remote-monitor.js` | 限制单文件/整轮请求与候选尝试；去重公平调度；bounded initializing admission；按 bytesRead/换行推进；scan-to-EOF 结算；移除 partial；修 recovery raw offset/short read；finally close |
| `test/codex-log-monitor.test.js` | 增加超大虚拟文件、多块追赶、总预算/尝试上限/去重/公平性、bounded admission、day-dir liveness、初始化/回填、discard 证明、rebaseline、recovery 等回归 |
| `test/codex-remote-monitor.test.js` | 增加同构读取/总预算/公平性、discard 证明、初始化/rebaseline/recovery 回归；把 partial 测试改为 disk-backed offset 契约 |
| `docs/plans/plan-issue-817-codex-rollout-bounded-reading.md` | 记录根因、设计、验收与残余边界 |

不计划改动：`src/agent-runtime-main.js`、`src/remote-ssh-deploy.js`、`agents/codex.js`、official hook 安装器、Settings 与用户文档。若实现过程中发现必须改这些文件，应暂停并先修订方案，不能静默扩 scope。

---

## 6. 实施顺序

### Phase 1 — 先建立会失败的回归 oracle

1. 本地测试伪造 `fstatSync().size = MAX_STRING_LENGTH + 1`，拦截并记录 `Buffer.alloc` / `readSync` 请求长度；不创建真实超大字符串。
2. 断言当前缺陷路径会请求超过计划上限；修复后每次请求 `<= MAX_POLL_READ_BYTES`，整轮请求/分配 `<= MAX_POLL_TOTAL_REQUEST_BYTES`，候选尝试 `<= MAX_POLL_FILE_ATTEMPTS`。
3. 使用约 8–13 MiB 的真实临时 fixture 直接跨越生产 4 MiB 边界，证明 `Math.min` 上限确实参与生产入口；不要只用小 fixture + short-read 冒充 cap 测试。
4. short-read 另用 mock 强制，独立证明只按真实返回量推进；加入一次 `>64 KiB`、停在未满 4 MiB 记录换行前的 short read，证明不会误 discard。
5. 在本地与远程分别建立“request 在第一块、resolution 在后续块”的初始化回归，证明不会闪卡。
6. 建立 incomplete EOF、`size===offset` 与 rebaseline 三类结算/中止 oracle，区分正常 finalize 和静默 abort。
7. 建立 `>150` 个两块以上 replay、day-dir 掉窗和新文件竞争回归，证明只有 bounded working set 获得富状态、deferred 尚未读取、已准入 offset 单调越过首块并最终释放 slot。
8. 建立重复候选来源、post-fstat equality、大量 0-byte/error candidates、多个 no-newline backlog 获取完整 quantum，以及 discovery stat 从第 65 个候选延续到下轮的回归。
9. 建立 40 个永久无进度 admitted + 新 recent 最终获 slot；分别覆盖 validated snapshot + 0-byte 必须 baseline、validation 从未成功才 deferred，并让其中至少一个候选先成功外发 lifecycle、再连续失败，证明 baseline abandonment 后不会从 0 重放；同时覆盖 recent 洪峰不挤掉 background 保留 lane、远程 rollover pending fail-closed。
10. 建立 cap 前后记录尺寸边界、两端 oversized/no-newline EOF、recovery UTF-8 raw 拼接和读取尝试次数上限回归。

测试应验证生产入口 `_pollFile()` / `pollFile()`，不能只测试一个脱离真实 tracker 状态的纯 helper。

### Phase 2 — 修本地 monitor

1. 加单文件/整轮请求上限、候选尝试上限、path 去重与 full-quantum 公平游标。
2. 保持 bytesRead/newline/identity 语义并加入 discard 证明条件。
3. 补 `scannedToSnapshotEnd` 正常结算出口和 rebaseline 静默 abort。
4. 增加 bounded replay working set、recent/background 独立容量和 3:1 准入、bounded deferred queue、no-progress baseline abandonment/backoff；admitted replay 不进入 LRU，完成或安全退场后再释放 slot。
5. 修 recovery head/tail short-read raw 游标、UTF-8 拼接和尝试次数上限。
6. 跑本地 monitor 全套用例，确认 backfill、tracker eviction、day-dir、short read、truncate/replace 无回归。

### Phase 3 — 修远程 monitor

1. 对齐单文件/整轮请求上限、候选尝试上限、去重 full-quantum 公平调度与 newline commit。
2. 移除 `partial`，迁移 recovery tail offset。
3. 补 poll/recovery short read、discard 证明与 finally close。
4. 补 bounded initializing admission、no-progress baseline abandonment/backoff、scan-to-EOF 正常结算、truncation 的旧 staged state 清理，以及 initializing 期间的 out-of-window prune 延迟/pending fail-closed。
5. 更新 recovery offset、raw Buffer、重试上限与旧注释。
6. 跑远程 monitor 与 remote-deploy manifest/依赖闭包用例。

### Phase 4 — 综合验证

按 §8 完成 focused、全量、静态检查与 diff review。任何测试为了通过而放宽 B1-B9，都必须回到方案层重新讨论。

---

## 7. 回归测试矩阵

### 7.1 本地 monitor

| ID | 场景 | 必须证明 |
|---|---|---|
| L1 | 虚拟未读区间 `MAX_STRING_LENGTH + 1` | 无真实巨量分配；单次 alloc/read 不超过 4 MiB；不抛主进程异常 |
| L2 | 多个完整记录跨三轮读完 | 每条事件恰好一次；offset 单调增加；最终等于最后完整换行后位置 |
| L3 | 正常 JSONL 记录在 chunk 尾部未完成 | 本轮不推进该尾行；补齐后从记录起点成功解析，无 UTF-8 破坏 |
| L4 | LF-inclusive span 恰为 4 MiB，以及 4 MiB + 1 的完整记录 | 前者必须处理；后者确定性 discard，且下一条正常记录恢复一次 |
| L5 | pending request 与 resolution 分处不同块 | 初始化结束前不发卡；追到 EOF 后仍为 resolved，零闪卡 |
| L6 | stale backfill 跨多块 | 历史事件不外发；只在追到快照 EOF 时合成至多一个 sustained snapshot |
| L7 | 普通 short read | 请求预算按完整 quantum 扣；只按 `bytesRead` 解析和推进；下一轮补齐剩余记录 |
| L8 | `>64 KiB` short read 停在一个小于 4 MiB 完整记录的换行前 | 不误判 oversized、不推进 offset；后续 full read 后该记录恰好处理一次 |
| L9 | read/fstat/close 失败 | fd 正确关闭；失败不推进 offset；下一轮可恢复 |
| L10 | incomplete tail 或合法 oversized discard 已扫描到 EOF | committed offset 可小于 size，但两个 replay flags 正常结算 |
| L11 | pre-stat `size===offset`；另测 pre-stat>offset、同 identity post-fstat `size===offset` | 两个无数据早退都正常 finalize 并释放 replay slot，不粘 flag |
| L12 | truncate / inode replacement 发生在 replay 中 | 静默 abort；旧 sustained snapshot/pending 不发布；identity/ledger 对齐，新写入仍能 live |
| L13 | admitted replay 首块后制造 active/retired LRU 压力 | replay 不进入 LRU，富状态与单调 offset 保留；普通 tracker 仍可淘汰、新文件仍可 attach |
| L14 | 151+ 个每个至少两块的 replay 候选 | working set/deferred 容量成立；deferred 未读；admitted 不循环重启并最终完成，随后公平准入后续候选 |
| L15 | admitted replay 的 day-dir 掉出 active/latest-7，且同时有新 rollout | replay 仍获完整 quantum；recent 新文件可获保留 slot；不会永久占死 50 个 active 槽位 |
| L16 | deferred queue 达到容量且混合/持续到来的 recent/background | 容量固定；3:1 admission 可判定且 background 仍获 slot；溢出只丢未读取候选，不丢半截富状态、不产生无界 Map 扫描 |
| L17 | oversized discard 与普通 commit 后的 identity ledger | tracker 与 `_readPositions` 保存 opened identity；重挂不误跳 EOF |
| L18 | recovery head/tail short read、UTF-8 跨块、request/resolution 分隔、1-byte 后端 | raw 拼接不污染字符；游标只按 bytesRead；读不全 fail closed；最多固定尝试次数 |
| L19 | 正常/replay 重复来源 + 旧 day-dir 的 `_getActiveDayDirs()` stat + startup recovery + 100+ 个 0-byte/error discovery + 多个 full/short-read backlog | 对整个 `_poll()` 统计全部逐文件 stat/open/read：path 数据入口每轮只处理一次；active-dir walker 最多用 16 个、全局 attempt <=64；第 65 个与未完 startup recovery 下轮续跑；recovery top-K 容量固定；请求总量 <=16 MiB；已知数据候选每轮至少有保留 token，跨轮首尾均进步 |
| L20 | 多个 `>4 MiB` no-newline backlog，以及一个约 3 MiB 的 no-newline tail 竞争 | 每个都最终获得 `min(unread,4 MiB)` 完整 quantum并按契约处理，不因总预算碎片永久停在 offset 0 |
| L21 | 40 个 admitted 持续 EACCES/0-byte/no-commit short read；覆盖 `fstat` 成功 + 0-byte、validation 从未成功，以及 recent attach 先外发 `task_started` + tool-use 再失败；随后制造 active + retired 双淘汰并加入新 recent | 唯一按 `hasValidatedSnapshot` 分支：前者 baseline、后者 deferred；pre-stat 与 opened fstat 保持同 identity 但故意给不同 size，baseline 必须采用 opened fstat EOF/identity并写入 `_readPositions`（identity 改变另由 L12 验证 rebaseline abort）；同 identity 重挂在 `readBackoffUntil` 前零读取、deadline 后才读取；只清未发布 staging，保留 dedupe/turn bookkeeping，后续 `task_complete` 只外发一次且保留 tool-use completion 语义；新 recent 最终准入 |

### 7.2 远程 monitor

| ID | 场景 | 必须证明 |
|---|---|---|
| R1 | 虚拟超大未读区间 | 单次 alloc/read 有界；daemon 不因 `toString` 上限退出 |
| R2 | 多块完整记录 + short read | offset 按 committed bytes 前进，不再跳到 `stat.size` |
| R3 | recovery tail 有未完成 resolution | recovered offset 停在最后完整换行；无 `partial`；补齐后正常清卡 |
| R4 | tail window 从 UTF-8 多字节中间开始 | raw-byte offset 不越过 EOF；不从替换字符长度反推字节位置 |
| R5 | request/resolution 跨块初始化 | 未追完时不提前发布历史 pending request |
| R6 | 4 MiB / 4 MiB+1 记录边界，后跟正常记录 | 边界内处理；越界 discard；不累积 partial；后续状态上报一次 |
| R7 | poll short read、readSync/close 异常 | fd 最终关闭；offset 不误推进；成功读取不因 close 报错被作废；下一轮恢复 |
| R8 | stale cleanup 后恢复 | 不重放旧 task_complete；新事件仍发送一次 |
| R9 | incomplete tail 或合法 oversized discard 已扫描到 EOF；另测 `size===offset` | 初始化按 scanned EOF 结算，即使 committed offset 小于 size；无数据早退不粘 flag |
| R10 | `>64 KiB` short read 停在小于 cap 的完整记录换行前 | 不误 discard；后续 full read 后恰好处理一次 |
| R11 | truncation 发生在初始化中 | 旧 staged pending 不发布；新 snapshot 从 0 重新初始化；空文件不粘旧 phase |
| R12 | recovery head/tail short read、UTF-8 跨块、request/resolution 分隔、1-byte 后端 | raw buf/游标/offset 正确；读不全 fail closed；最多固定尝试次数 |
| R13 | 151+ 个至少两块的 initializing 候选 | bounded working set/deferred admission；admitted 单调完成；deferred 未读且随后公平准入 |
| R14 | 正常/initializing 重复来源 + 100+ 个 0-byte/error discovery + mixed full/short read | path 去重；stat 前起尝试 <=64；目录游标跨轮继续；请求总量 <=16 MiB；无稳定饥饿 |
| R15 | 多个 `>4 MiB` no-newline backlog + 一个约 3 MiB tail | 每个最终获得 `min(unread,4 MiB)` 完整 quantum并按契约处理，不因碎片预算卡住 |
| R16 | admitted initializing 跨 today/yesterday rollover，EOF 时仍有 pending，随后旧目录追加 resolution | prune 在初始化中暂缓；窗口外 finalize 不发无法跟踪的卡、清 staged pending 后 prune；后续 append 不留下幽灵卡 |
| R17 | deferred queue 满且 recent/background 持续竞争 | 容量固定；3:1 admission 让两 lane 都推进；溢出不创建半截 initializing entry |
| R18 | 40 个 admitted initializing 持续无进度；覆盖 stat 成功 + 0-byte、stat 从未成功，以及先 POST `task_started` + assistant output 再失败；随后新 recent 到达 | 唯一按 `hasValidatedSnapshot` 分支：前者 baseline 到最后 validated stat EOF、后者在 `notBefore` 前不再准入；只清 staged pending，保留 lifecycle/assistant bookkeeping与指数 backoff；后续 `task_complete` 只 POST 一次且携带正确 output，不重复首块 POST；新 recent 最终准入 |
| R19 | `--once` 面对多块 backlog | 只执行一个有界 poll quantum 后正常退出；明确不宣称已追完或完成 full smoke |

### 7.3 变异检查

至少做以下人工 mutation，确保新测试会红：

1. 删除单文件 `Math.min(..., MAX_POLL_READ_BYTES)`；L1/R1 必须失败。
2. 删除整轮请求/分配 budget，或在 short read 后只扣 bytesRead；L19/R14 必须失败。
3. 删除 `MAX_POLL_FILE_ATTEMPTS`；L19/R14 的 0-byte/error 集合必须失败。
4. 不对 normal/replay 候选按 path 去重；L19/R14 必须失败。
5. 把 offset/解析游标推进量从 `bytesRead` 换回 `readLen` 或 `stat.size`；L7/R2 必须失败。
6. 把 `scannedToSnapshotEnd` 换回 `committedOffset >= snapshotSize`；L10/R9 必须失败。
7. post-fstat `size===offset` 直接 return 而不 finalize；L11 必须失败。
8. 删除 initialization 的 scan-to-EOF gate；L5/R5 必须失败。
9. 远程 recovery offset 改回真实 EOF 且不保留 partial；R3 必须失败。
10. 把 committed bytes 改成整个有效 buffer 长度；L3/R2 必须失败。
11. 删除 discard 的 full-read/cap-or-EOF 证明条件，让任意 `>64 KiB` short read 推进；L8/R10 必须失败。
12. 允许 admitted replay 进入 active/retired LRU；L13/L14 必须失败。
13. 取消 replay admission 上限，或让 deferred 候选先读一块再排队；L14/R13 必须失败。
14. 调度候选只取日期目录，不取 admitted replay；L15/R16 必须失败。
15. 远程 out-of-window prune 无条件删除 initializing entry；R16 必须失败。
16. rebaseline 复用正常 finalize 并发布旧 staged 状态；L12/R11 必须失败。
17. oversized discard 后绕过正常结算出口；L10/R9 必须失败。
18. oversized discard 后保留旧 tracker/ledger identity；L17 必须失败。
19. recovery head 游标改回请求 target，或把独立解码字符串直接拼接；L18/R12 必须失败。
20. 删除 recovery 尝试次数上限；L18/R12 的 1-byte 后端必须失败。
21. 当剩余预算小于 `requiredQuantum=min(snapshotUnread,4 MiB)` 时仍发起碎片读取；L20/R15 必须失败。
22. deferred admission 永远优先 recent、不执行 3:1 background 保底；L16/R17 必须失败。
23. 删除 no-progress 双阈值/slot 释放；用“是否读到字节”代替 `hasValidatedSnapshot`；把 `abandonReplayAtValidatedSnapshot()` 改成删除 offset 后从 0 重放；本地只把 backoff 放 rich tracker、在同 identity 但 size 不同的场景用 pre-stat EOF 而非 opened fstat EOF 写 ledger；错误清除已外发 lifecycle 的 turn/dedupe bookkeeping；忽略 deferred `notBefore`；或让普通 mtime/size 直接清 backoff。L21/R18 必须失败。
24. 远程 out-of-window initialization 正常发布 pending 后立即 prune；R16 必须失败。
25. `MAX_POLL_FILE_ATTEMPTS` 只在 `_pollFile()` 内计数、discovery stat 不计，或让 `_getActiveDayDirs()` 在取得 token 前无界 stat；L19/R14 必须失败。

---

## 8. 验证命令与通过标准

### 8.1 Focused tests

```bash
node --test test/codex-log-monitor.test.js test/codex-remote-monitor.test.js
```

要求：0 fail；新增用例全部执行，不允许 skip。

### 8.2 Remote deploy 契约

```bash
node --test test/remote-deploy.test.js test/remote-ssh-deploy.test.js test/remote-ssh-path-isolation.test.js
```

要求：`codex-remote-monitor.js` 仍在 `HOOK_FILES`，依赖闭包与部署 read-back 通过；不能因为本次修复新增未登记依赖。

### 8.3 全量与静态检查

```bash
npm test
node --check agents/codex-log-monitor.js
node --check hooks/codex-remote-monitor.js
git diff --check
```

要求：仓库全量 0 fail；平台条件 skip 如实报告，不冒充真机验证；语法与 diff 检查通过。

### 8.4 资源边界验证

用 mock/虚拟 stat 证明：

- 任何单次 `Buffer.alloc` / `readSync` 请求 `<= MAX_POLL_READ_BYTES`；
- 一次正常 poll 在全部文件间累计的 requested/allocated bytes `<= MAX_POLL_TOTAL_REQUEST_BYTES`，真实 bytesRead 不超过请求量；
- 每轮候选尝试 `<= MAX_POLL_FILE_ATTEMPTS`，计数从 discovery stat 前开始并覆盖 `_getActiveDayDirs()`；active-dir walker 每轮最多占 16 个 token，完整 pass 前不丢上一版 cache；重复来源的同一路径只处理一次；第 65 个候选由目录/path 游标延续到下轮；startup recovery 使用 bounded top-20 且未走完整个 discovery cursor 前不标记完成；
- 跨轮调度能让预算后方的文件持续取得进度，并让大于 cap 与小于 cap 的 no-newline backlog 最终获得 `min(snapshotUnread,4 MiB)` 完整 quantum，而不是只证明总量小；
- 任何单次 committed `toString()` 输入 `<= MAX_POLL_READ_BYTES`；
- remote tracker 不再存在可随轮询增长的 `partial` 字符串；
- admitted replay/initializing 连续无进度达到次数+时间阈值后只按 `hasValidatedSnapshot` 分支：true 时静默 baseline 到最后 validated snapshot EOF，false 时才进入 deferred；释放 slot 并受 bounded backoff，只清未发布 staging；本地 backoff/validated fstat identity 经 active + retired 双淘汰仍有效，已外发 lifecycle 的 turn/dedupe bookkeeping 必须保留且事件不能重复；
- recovery head/tail 同时受字节预算和固定尝试次数保护；
- 测试本身不分配接近 512 MiB 的 Buffer/字符串，不把 CI 变成内存压力测试。

本修复属于平台中立的 Node 文件读取逻辑。自动化能证明根因与边界，但如果后续没有实际运行打包后的 macOS 应用，不应声称“macOS packaged UI 已真机验证”；应分别报告代码回归与打包应用 smoke 的证据。

---

## 9. 拒绝的替代方案

### A. 只在 timer 或 `toString()` 外加 `try/catch`

拒绝。它只能隐藏弹窗，不能阻止每 1.5 秒重复巨量分配、主线程冻结与 OOM。

### B. 新 attach 无条件直接把 offset 跳到 EOF

拒绝。会丢失 session metadata、当前 sustained state、quota、pending `request_user_input`，破坏 JSONL fallback 的恢复职责。B5 的双阈值退场不是普通 attach 策略，而是 work item 已连续失败后为避免重复外发和永久占槽采用的显式 fail-closed circuit breaker；它只能跳到最后 validated snapshot EOF，并必须把由此产生的历史恢复损失写入交付报告。

### C. 只读文件尾部固定窗口

不作为本轮主方案。它能快速避开大历史，但无法可靠重建所有跨窗口状态；需要重新定义 fallback 恢复语义。#817 先用有界顺序追赶解决安全性，再根据真实性能数据评估独立优化。

### D. 使用 `readFileSync`、stream 拼成一个完整字符串或无限增长 `partial`

拒绝。API 形式变化不改变单字符串/内存无界问题。

### E. 提高 Node/V8 堆或字符串限制

拒绝。运行时单字符串限制不是产品应依赖的可调契约，而且更大的单次同步解析仍会冻结 Electron 主进程。

### F. 删除/压缩用户 Codex 历史

拒绝。破坏用户数据，也无法阻止未来 rollout 再次增长。

---

## 10. 残余风险与后续项

1. **追赶期间的可见性**：单文件 512 MiB backlog 即使独占 4 MiB/1.5 秒，也约需 128 轮、3.2 分钟；有多个文件共享总预算时更久。`backfilling` 期间 JSONL fallback 的状态、metadata 与被动 `request_user_input` 卡片不会发布，不应只描述成“动画延迟”。Codex official PermissionRequest hook 是独立路径，不在此影响范围。
2. **记录丢弃契约**：完整稳定快照下，LF-inclusive span `<=4 MiB` 的记录保留、`>4 MiB` 的记录确定性丢弃；超过 64 KiB 的 snapshot 未完成尾行也可能按既有策略被丢失。任意 short read 本身不构成 discard 证据。
3. **公平不是实时承诺**：16 MiB 请求预算、64 次候选上限与 round-robin 只保证有界和无稳定饥饿，不保证每个大 backlog 在固定秒数内完成。若真实体验仍不可接受，应另立 bounded head+tail fast attach 设计，不能重新放开无界读取。
4. **deferred admission 溢出**：working set 只保护已准入 replay；recent/background deferred lane 分别固定为 192/64。某 lane 溢出时只在自身内部替换/丢弃，不侵占另一 lane 的保留位。被丢路径以后可能由目录扫描/recovery 重获机会，但极端洪峰下不承诺恢复每个历史会话；它不能导致半截 replay 变 live、富状态循环丢失或内存无界。
5. **no-progress 安全退场会丢历史**：持续失败/0-byte 的 replay 达到双阈值后，只要 `hasValidatedSnapshot=true`，就会丢弃尚未发布的富状态并把 offset baseline 到最后 validated snapshot EOF；该 snapshot 中尚未处理的 completion、pending、state、quota 或 metadata 都可能永久漏报。这个 circuit breaker 以明确的数据恢复损失换取“不从 0 重复已外发生命周期、不发布 staged pending、不永久毒死 slot”；只有 validation 从未成功的候选才会以 offset 0 延迟重试。
6. **目录枚举基数**：64-attempt 上限从 discovery stat 前约束所有逐文件同步操作，`_getActiveDayDirs()` 也通过每轮最多 16 次 stat 的持久 walker 受控；但 `readdirSync(dir)` 仍会一次 materialize 单个目录的名称数组。本 Issue 不改为 `opendir` 流式枚举；异常巨大单目录的纯名称数组仍是保留限制，不能把“逐文件 stat/open/read 有界”夸大成“目录列表内存严格常量”。
7. **远端 out-of-window pending fail-closed**：跨 rollover 的 initialization 若在窗口外追到 EOF 且仍 pending，将不发布该卡片，以避免 tracker prune 后永远无法 resolve；这是明确的数据恢复损失，优先于制造幽灵卡。
8. **recovery fail-closed**：达到尝试次数上限会漏掉该次 pending recovery，也会漏掉依赖同一 tail 的 Windows recent-active 恢复；这优先避免用不完整 tail 错误复活历史卡。startup sweep 仍是一轮机会，不冒充无损恢复。
9. **远程交付**：桌面应用升级不会自动用新内容替换已部署 profile 的 `codex-remote-monitor.js`。在增加版本/hash 自动协调机制前，用户必须在 Settings → Remote SSH 执行 Deploy / Repair Hooks；release notes 和 Issue/PR 验证说明都要写明。
10. **远程 rotation 模型**：远程仍主要用 size-based truncation guard，不在本轮引入完整 file identity。该既有限制与 #817 的字符串上限独立。
11. **远端 `--once`**：有界读取后它只代表“成功执行一个有界诊断 poll”，大 backlog 不保证追完；不能把 `--once` 成功冒充 daemon catch-up smoke。
12. **打包应用证据**：Node 测试不等于 macOS 打包应用 smoke；交付报告必须分开陈述。
13. **既有轻量 ledger 不是严格常量内存**：本地 `_readPositions` 仍会按本进程见过的 distinct rollout path 增长，远程完成初始化的普通 tracker 数量也主要由日期窗口/prune 约束。本方案严格限制的是单次/单轮读取分配、replay 富状态、deferred 候选和逐文件同步操作；backoff 复用既有 entry，不新增另一张无界表，也不在 poll 中扫描完整 ledger。若要给所有轻量 path metadata 加硬上限，必须先设计不会令被淘汰文件从 0 重放的 fail-closed eviction，作为独立后续项，不能把本方案夸大成“monitor 总内存严格常量”。

---

## 11. 完成定义

只有同时满足以下条件，才能称 #817 的代码修复完成：

- [ ] L1-L21、R1-R19 和二十五项 mutation 均能证明对应不变量；
- [ ] 本地与远程 monitor 的单文件 Buffer/字符串上限、整轮请求/分配预算、候选尝试上限、path 去重和 full-quantum 跨轮公平性均可观察且固定；本地 `_getActiveDayDirs()` 和 startup recovery discovery 也纳入全局 attempt/cursor/bounded-top-K oracle；
- [ ] 初始化/回填跨块不闪历史卡、不提前发状态；
- [ ] EOF incomplete tail 以扫描范围而非 committed offset 正确结算；rebaseline 静默 abort，不发布旧 staged 状态；
- [ ] bounded working set/deferred admission 在 151+ 候选、active LRU、day-dir/remote rollover 和队列溢出下都保持富状态单调进度，不变 live、不循环重启、不永久占满全部 active 槽位；
- [ ] 40 个永久无进度 admitted 能按双阈值和唯一 `hasValidatedSnapshot` 谓词安全分支、释放 slot 并执行 bounded backoff；本地 opened-fstat baseline/backoff 经 active + retired 双淘汰仍有效，只清未发布 staging，保留已外发 lifecycle 的 turn/dedupe bookkeeping 且不从 0 重复，后续 recent/background 均可恢复准入；
- [ ] 正常 commit、合法 oversized discard、EOF incomplete tail 和 `size===offset` 都能正确结算；任意 short read 不会误 discard；
- [ ] 远端 out-of-window initialization 不发布随后无法跟踪 resolution 的 pending；`--once` 明确只执行一个有界 quantum；
- [ ] remote recovery 不再保存 `partial`，未完成尾行可在 append 后恢复；
- [ ] recovery raw UTF-8、真实 bytesRead 和固定尝试次数上限均有 mutation-sensitive 覆盖；
- [ ] focused、remote-deploy、全量、语法、diff 检查全部通过；
- [ ] 已部署 Remote SSH profile 的手动 Deploy / Repair Hooks 要求已写入交付报告/release notes，且未把桌面升级误称为远端已更新；
- [ ] 没有改动网络代理、用户 Codex 历史、official hook 职责或 Remote SSH routing；
- [ ] 独立 code review 没有未解决的 P0/P1/P2；
- [ ] 最终报告分别列出自动化、真实打包应用/平台验证和未验证边界；
- [ ] GitHub 回复、PR、merge、Issue close 与发布仍按独立授权执行。
