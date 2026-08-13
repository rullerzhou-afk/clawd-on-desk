# Issue #620 — Codex Pet 拖动闪空帧修复计划（v4，真机证据校正版）

更新时间：2026-08-04
状态：追加修复、自动化与 packaged 真机验收已完成，等待提交与报告者回验

## 1. 结论

#620 的主问题不是 Codex Pet 素材损坏，而是 Clawd 的 Codex Pet 适配层在拖动生命周期中反复销毁并重建 `<object>` 内的 SVG 文档。

第一版修复已经让左右换向在同一 SVG 文档内完成，真机录屏确认换向不再闪。但真机随后发现：松手恢复真实状态，以及拖动中途遇到 agent state change，仍会走完整的跨文档 swap。用户在 packaged build 中手动测试 10 次松手，约 8 次看到短促消失。因此 #620 不能只以“左右换向已修”结束，修复范围必须覆盖：

1. 初次进入拖动后的左右换向；
2. 松手恢复 idle / working 等真实状态；
3. 拖动中途被 state change 打断后继续拖动；
4. Codex Pet 的 click / once 动画重复播放；
5. 普通主题继续保持原有媒体切换语义。

最终方案是 adapter v6 的“通用单文档视觉桥”：每份生成的 Codex Pet wrapper 都包含全部受支持动画，但始终只有一个 spritesheet `<image>`。Renderer 对带 v1 marker 的 Codex Pet `<object>` 只改根元素属性，不再为了文件名变化重建 SVG 文档。

## 2. 已确认事实与被推翻的假设

### 2.1 已确认：跨文档 swap 是空帧风险来源

旧路径为：

```text
drag / state / reaction 文件变化
  -> renderer.swapToFile()
  -> 新建 <object> 并追加 _t= cache bust
  -> 新 nested SVG document load
  -> next opacity = 1
  -> fadeOutMs = 0 时同步 releaseObject(old)
```

`load` 只说明嵌套文档已加载，不保证大 spritesheet 已完成首次 decode / raster / present。Codex Pet 图集约为 1536×1872（V1）或 1536×2288（V2），旧对象同步释放后存在短暂无可见像素的窗口。具体落在 decode、RasterTask、paint 还是 Viz/present，不在没有 tracing 的情况下写成单一已证实层级。

### 2.2 已确认：左右换向的 single-image row 方案成立

Codex Pet 的 running-right 和 running-left 逐帧 durations 完全相同，差异仅是 spritesheet 行号。现有真 Chromium 验证表明：

- 外层 `<g>` 的 Y row offset 与内层 `<image>` 的 X keyframes 正确叠加；
- 连续切换方向 200 次，始终是同一 document、同一 `<image>`、同一 Animation identity；
- `currentTime` 单调，不因左右换向归零；
- V1 / V2 生成物经过 `sanitizeSvg()` 后 marker 和选择器均存活；
- 缺失或非法方向回落到右向，不存在“双边都隐藏”的状态。

外层 row `<g>` 与内层 atlas `<image>` 不能合并：CSS animation 的 `transform` 会替换同一元素的静态 `transform`，无法自动与 Y offset 相加。

### 2.3 已确认：松手和 state change 是同一缺陷的剩余入口

真机 renderer trace 在一次持续拖动中看到 SVG root identity 发生 `2 -> 4 -> 6` 的变化，文档间约有 17ms 间隔；松手则从 directional document 切回 running / idle document。用户在 packaged build 手动复现约 8/10 次松手闪烁。

因此旧计划中“只覆盖左右换向，松手/state change 留作残余风险”的范围不再足够。

### 2.4 被推翻：`clientX` 会制造接近帧率的伪反向

旧计划曾把 moving hit window 内的 `clientX` 视为换向频率主因，并实现 `screenX + 3px deadband`。真机通过 CDP 采集到 2051 个可信 pointermove；同一手工拖动轨迹上，`clientX` 与 `screenX` 都得到 42 次方向翻转，没有出现计划预测的近帧率伺服锯齿。

结论：至少在本次 Windows 125% 真机环境中，该主因预测被证伪。合成 sawtooth fixture 预设了结论，不能覆盖真实浏览器事件。为避免无依据地改变 click/drag 手感、混合 DPI 行为和 cancel/restart 语义，Change set A（`screenX + deadband`）撤回，恢复既有 `clientX` 方向判断。

本修复不再依赖坐标空间假设；即使未来出现高频方向请求，同文档属性切换也不会产生整宠物透明帧。

### 2.5 低功耗暂停是预期行为

静置约 5 秒后，idle / mini-idle / dozing SVG 可以暂停以降低功耗；拖动或新任务会恢复。这不是 #620 的 bug，不删除、不改触发条件。Issue 回复和 release note 必须把它与闪空帧分开说明。

## 3. 修复设计

### 3.1 Adapter v6：通用单文档 wrapper

`src/codex-pet-adapter.js` 将 adapter version 从 5 升到 6。每个生产 wrapper 仍保留原文件名和初始视觉，但内容统一具备：

```xml
<svg
  data-clawd-codex-pet-visuals="v1"
  data-clawd-codex-pet-visual="idle-loop"
  data-clawd-drag-directional="v1"
  data-clawd-drag-direction="right">
  <g class="visual-row" transform="translate(0,...)" >
    <image class="atlas" transform="translate(0,0)" ... />
  </g>
</svg>
```

受支持 visual token：

| 逻辑文件 | visual token | row / mode |
|---|---|---|
| `codex-pet-idle-loop.svg` | `idle-loop` | idle / loop |
| `codex-pet-idle-static.svg` | `idle-static` | idle / static |
| `codex-pet-waving-loop.svg` | `waving-loop` | waving / loop |
| `codex-pet-waving-once.svg` | `waving-once` | waving / once |
| `codex-pet-jumping-loop.svg` | `jumping-loop` | jumping / loop |
| `codex-pet-jumping-once.svg` | `jumping-once` | jumping / once |
| `codex-pet-failed-loop.svg` | `failed-loop` | failed / loop |
| `codex-pet-waiting-loop.svg` | `waiting-loop` | waiting / loop |
| `codex-pet-running-loop.svg` | `running-loop` | running / loop |
| `codex-pet-review-loop.svg` | `review-loop` | review / loop |
| `codex-pet-drag-directional-loop.svg` | `drag-directional` | running-right/left / loop |

每份文档包含所有 token 的 CSS 与 X-only keyframes，但只有一个 `<image>`。根属性控制当前 row 和 animation name：

- `visual-row` 独占 Y offset；
- `atlas` 独占 X animation；
- left/right 只改变 drag visual 的 row；
- once 与 loop 使用不同 animation name，token 变化会自然启动正确动画；
- 同一个 once token 再次触发时由 renderer 显式把 Animation `currentTime` 归零并 `play()`；
- `<g>` 与 `<image>` 都保留 presentation transform，CSS 丢失时仍显示初始帧；
- 不使用 `display:none`、`visibility:hidden` 或 `opacity:0`，结构上不存在两组同时隐藏。

### 3.2 Renderer：受 marker 和资源目录约束的同文档快路径

`swapToFile()` 在通用 swap 前尝试 Codex Pet fast path。仅当下列条件全部成立时复用当前 document：

1. 请求文件属于 adapter v6 支持的 Codex Pet 文件集合；
2. 目标需要 `<object>` channel；
3. 当前元素是 `<object>`；
4. `contentDocument.documentElement` 可访问；
5. 根 marker `data-clawd-codex-pet-visuals="v1"` 存在；
6. 当前资源 URL 与目标 URL 属于同一 assets 目录，防止切换主题后误用旧 spritesheet；
7. 调用方没有显式要求 `forceDocumentReload`。

命中后：

- 修改 `data-clawd-codex-pet-visual`；
- drag visual 同步 `data-clawd-drag-direction`；
- 更新 `currentDisplayedSvg/state/assetUrl` 等逻辑账本；
- 重新应用 scale、tint、mini flip、accessory layout 与低功耗调度；
- 不增加 `activeSwapToken`；
- 不创建 `pendingNext`；
- 不调用 `releaseObject()`；
- 同一 once visual 再触发时重启动画；
- bridge 失败只 warning 一次并回落到普通 media swap，不让宠物卡死。

系统唤醒恢复等明确需要重建 document 的调用传 `forceDocumentReload: true`，不能被 fast path 吞掉。

### 3.3 生命周期结果

```text
idle/working document
  -> 开始拖动：root visual = drag-directional
  -> 左右换向：root direction = left/right
  -> 拖动中 state change：root visual = state visual
  -> 手指仍按住继续移动：root visual = drag-directional
  -> 松手：root visual = 最新真实 state visual
```

整个序列保持同一个 `<object>`、同一个 `contentDocument`、同一个 `<image>`。

### 3.4 普通主题边界

普通主题没有 v1 marker，行为不变：

- `fileLeft !== fileRight` 的 SVG/GIF 方向主题继续走 media swap；
- `<img>` channel 不尝试写 nested SVG；
- 通用 `_t=` cache bust 不删除；
- 通用 `releaseObject()`、fade/crossfade 和 transition 语义不修改；
- 主题 assets 目录变化时强制加载新文档，不能跨主题复用。

## 4. 不变量

1. 每份 adapter v6 wrapper 只有一个 spritesheet `<image>`。
2. V1 根 viewBox 为 192×208，内部图为 1536×1872；V2 根 viewBox 同为 192×208，内部图为 1536×2288。
3. running-left/right durations 必须逐帧相同；分叉时 generator fail closed。
4. Y offset 只在外层 row，X keyframes 只在内层 image。
5. sanitizer 后 universal marker、visual selectors、direction selector 与 presentation transforms 必须存活。
6. 不支持的文件、marker 缺失、contentDocument 不可读或 `<img>` channel 必须回落普通 swap。
7. 资源目录变化时不得复用旧 document。
8. 显式 force reload 不得被同文档快路径拦截。
9. adapter v5 与更旧 marker 下一次 sync 必须 rebuild 为 v6，并保留原 theme id / suffix。
10. 低功耗暂停、DND、cursor polling pause/resume 和 drag end IPC 次数保持原语义。
11. `clientX` 输入逻辑保持修复前行为；不保留未经真机支持的 `screenX` deadband。

## 5. 自动化测试

### 5.1 Adapter / sanitizer

- universal generator 拒绝未知 wrapper 文件；
- V1/V2 尺寸正确；
- 每份生产 wrapper 只有一个 `<image>`；
- 初始 visual 与 presentation row 正确；
- 所有 visual 的 CSS/keyframes 都存在；
- once/loop/static mode 正确；
- drag left/right timing parity pure assertion 可测；
- 所有 materialized wrapper 经过 `sanitizeSvg()` 后 marker 与 selectors 存活；
- strict theme loader 可加载；
- v5→v6（并由旧版本通用测试覆盖更早 marker）触发 rebuild、保留 suffix；
- 旧独立 left/right wrapper 不再生成。

### 5.2 Renderer

- drag → mid-drag state change → drag restart → release 全程 object identity 与 swap token 不变；
- 方向属性正确，重复同方向不重复写；
- 同一 once visual 重触发时 `currentTime=0` 并 `play()`；
- 主题 assets 目录变化时创建新 object；
- marker 缺失 warning once 并正常 fallback；
- 普通 distinct directional files 继续 media swap；
- pending cancel、迟到 load、cursor polling、低功耗和 theme re-init 回归继续通过；
- force document reload 对 universal document 仍创建新 object。

### 5.3 Hit renderer

撤回 Change set A 后，`src/hit-renderer.js` 与相应测试恢复到修复前版本。既有 click、drag threshold、direction change、pointerup/cancel/lost capture 与 late cancel 测试必须继续通过。

## 6. 真机证据与下一轮验收

### 6.1 已完成证据

- 第一版 dev clean recording：60 FPS、36 秒、2160 帧；15 个换向点均可见，无整宠物透明帧、无双影；
- 第一版真 Chromium：方向属性连续切换 200 次，document / image / Animation identity 不变；
- packaged build：`contentDocument` 可读，sanitized wrapper marker 可访问；
- 用户确认左右拖动不再突然消失；
- 用户确认 packaged 松手约 8/10 次闪，促成本次 v6 扩围；
- 真机 trusted pointer trace：2051 moves，clientX 与 screenX 均 42 flips，推翻“接近帧率伪反向”的预测；
- renderer trace 捕获 drag/state/restart 文档 identity 变化与约 17ms 间隔。

### 6.2 v6 必做验收

先让用户通过应用菜单正常退出当前 packaged Clawd；不得用进程级命令结束 Windows Terminal 或其他共享宿主。

1. `npm test`、`npm run verify:electron` 全绿；
2. 重新构建 Windows x64 packaged app；
3. dev 与 packaged 各确认 v6 marker 和可写 `contentDocument`；
4. 左右快速换向至少 100 次：document identity 不变，无透明帧、无双影；
5. 手工拖动并松手至少 20 次：每次 release 前后 document identity 不变，逐帧无透明帧；
6. 拖动中主动触发 idle↔working / session start-stop，再继续拖动并松手：identity 不变；
7. click once 动画连续触发，确认每次从首帧重新播放且不换 document；
8. Windows 125% 当前环境复测；若可用，再做 100% / 150% 视觉 smoke。坐标算法已撤回，因此 DPI 不再是 screenX correctness gate；
9. 自造 `fileLeft !== fileRight` GIF 主题，确认普通主题仍换向正确；
10. Clawd / Calico / Cloudling 拖动、单击、低功耗 smoke；
11. 报告者 Firefly / 菲比回验。

一次偶然“没看到闪”不构成通过。松手旧基线约 8/10 可复现，因此 v6 至少连续 20 次无闪，并同时用 document identity 证明没有跨文档 swap。

### 6.3 v6 packaged 验收结果（2026-08-04）

- `dist/win-unpacked` 中的 `app.asar` 已核对为 adapter v6、universal bridge、force reload escape，且不含撤回的 screen deadband；
- 启动 sync 将本机 `codex-pet-furina` 从 v5 自动升级到 v6，全部 11 个 wrapper 均带 universal marker；
- packaged `contentDocument` 可读写；
- working 状态连续 20 次人工拖动/松手无闪：后台 4ms polling 共 62,532 次，`nullPolls=0`，`rootIdsSeen=[1]`；
- 该轮每次 release 都恢复 `running-loop`，因为真实主进程状态是 `working`；测试前基线也已是 `running-loop`，不是恢复回归；
- 真实状态回到 idle 后再次人工拖放，用户确认恢复 standing idle；后台共 27,066 次 polling，`nullPolls=0`，`rootIdsSeen=[1]`，每次均记录 `idle-loop -> drag-directional -> idle-loop`；
- 两轮都没有创建第二个 document，没有透明窗口，也没有媒体元素叠放；
- Windows x64 NSIS 构建和签名成功；构建日志仍有既存的 `@larksuiteoapi/node-sdk@1.66.0` 依赖树告警，但 exit code 为 0，和 #620 无关。

## 7. 实施顺序与当前进度

1. [x] 复现原始左右换向跨 document 路径；
2. [x] 实现 adapter v5 single-image directional wrapper；
3. [x] 实现 renderer v1 directional bridge；
4. [x] 第一轮自动化、Chromium 探针、dev/packaged 真机；
5. [x] 发现并量化 release 闪烁；
6. [x] 用真实 trusted pointer trace 推翻 clientX 高频根因，撤回 screenX/deadband；
7. [x] 设计并实现 adapter v6 universal visual bridge；
8. [x] 实现 renderer 同文档 state/reaction/drag fast path、assets 目录保护与 warning fallback；
9. [x] 增加 adapter/sanitizer/renderer 回归测试；
10. [x] 增加 force reload 专项测试；
11. [x] 全量测试与 Electron 验证（6873 tests / 6842 passed / 0 failed / 31 skipped；Electron 41.10.2）；
12. [x] 正常退出旧 packaged app，重新 build；
13. [x] packaged v6 working/idle 松手真机验收；state-change 同文档路径由 renderer 行为测试与实机 idle/working token 切换共同覆盖；
14. [x] 更新 v0.14.0 release note；
15. [ ] 提交追加修复；最终关闭仍等待报告者回验。

## 8. 文件边界

预计修改：

- `src/codex-pet-adapter.js`
- `src/renderer.js`
- `test/codex-pet-adapter.test.js`
- `test/renderer-low-power.test.js`
- `docs/plans/plan-issue-620-codex-pet-drag-direction-flicker.md`
- `docs/releases/release-v0.14.0.md`

恢复到父提交版本（撤回未证实 Change set A）：

- `src/hit-renderer.js`
- `test/hit-renderer.test.js`

不需要修改 main-process drag ownership、IPC contract、theme schema 或 sanitizer 生产实现。

## 9. Adapter 版本与回滚

adapter v5 已在本次真机环境生成并运行，因此新生成协议必须使用 v6，不能悄悄改变 v5 内容后仍把现有 marker 判 unchanged。

回滚原则：

- 若只回滚 renderer fast path，v6 wrapper 仍会按初始 visual 正常播放，但状态变化退回普通 swap；
- 若回滚生成协议，需保持 marker 版本能唯一对应产物，避免“同号不同内容”；
- 降版本会使 marker collection 与 PNG alpha validation cache 重新计算，虽应正确但不必要；
- 回滚不得删除通用 `<img>/<object>` cache bust，因为一次性普通主题仍依赖新动画时间线。

## 10. 合并与关闭标准

只有全部满足时才能把 #620 描述为已修复：

1. 定向与全量自动化 0 failure；
2. v6 生成物经 sanitizer 后 marker/selector 契约成立；
3. dev 与 packaged 中 drag、换向、state change、release 的 object/document identity 不变；
4. packaged 连续至少 20 次松手无透明闪；
5. 60 FPS 逐帧抽样无全透明帧、无双影；
6. 普通 GIF directional fixture 与三个内置主题无回归；
7. 低功耗暂停仍按设计工作；
8. release note 只把闪空帧列为修复，把五秒 idle pause 明确列为预期行为；
9. 报告者回验通过。

若 v6 真机仍在同一 document 内出现 release 透明帧，则说明原因不是 document teardown，应保留 identity 证据并转向属性切换瞬间的 raster/present tracing；不得继续堆 RAF 或恢复双 `<object>` 方案。
