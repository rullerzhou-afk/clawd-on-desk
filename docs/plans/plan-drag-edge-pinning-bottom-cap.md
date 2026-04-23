# Plan: Edge Pinning Bottom Cap by Display Inset

> **状态**：Proposed
> **范围**：Issue #126 的后续修正，只处理 ON 模式底部过冲；不改 OFF 语义
> **前置**：已落地 `allowEdgePinning` toggle（`94cf1a6`）与 near-edge topmost reassert（`c961d8b`）
> **关联文档**：[plan-drag-edge-pinning-toggle.md](./plan-drag-edge-pinning-toggle.md)

## 1. 背景

`allowEdgePinning = ON` 之后，当前实现把 bottom slack 固定成 `0.25 * windowHeight`：

- [src/visible-margins.js](D:/animation/src/visible-margins.js:77)
- [src/visible-margins.js](D:/animation/src/visible-margins.js:102)

最终 rest clamp 仍然是基于 `display.workArea`：

- [src/main.js](D:/animation/src/main.js:2735)

也就是说，当前数学表达的是：

```js
maxWindowY = workArea.bottom - windowHeight + round(windowHeight * 0.25)
```

这在“taskbar 高度刚好约等于 `0.25h`”的机器上手感很好，但在 taskbar 更薄的机器上会让真实窗口越过物理屏幕底边。

## 2. 已核实事实

### 2.1 当前架构对顶部和底部并不对称

Clawd 现在只有 top-only 的 virtual-bounds materialization：

- [src/drag-position.js](D:/animation/src/drag-position.js:37)
- [src/main.js](D:/animation/src/main.js:456)
- [src/main.js](D:/animation/src/main.js:467)
- [src/renderer.js](D:/animation/src/renderer.js:139)

`materializeVirtualBounds()` 只做：

```js
realY = Math.max(virtualY, workArea.y)
viewportOffsetY = Math.max(0, realY - virtualY)
```

这保证了顶部“视觉可越界、真实窗口不出屏”。底部没有对称机制，所以 bottom clamp 一旦过头，掉出物理屏幕的是**真实窗口本体**。

### 2.2 Peter 的截图里 `33%` 只能推出 `P:10`

当前设置页 size slider 的换算是：

- [src/settings-renderer.js](D:/animation/src/settings-renderer.js:636)
- [src/settings-renderer.js](D:/animation/src/settings-renderer.js:640)
- [src/size-utils.js](D:/animation/src/size-utils.js:16)

`33%` 对应的是 proportional size `P:10`。但这只能推出“窗口尺寸 = 当前 display workArea 的 10% DIP”，不能直接从视频物理像素推出固定 `280px`。

### 2.3 Electron 的 `Display.bounds` / `workArea` 是 DIP

Electron 官方文档明确写明：

- `Display.bounds` is in DIP points
- `Display.workArea` is in DIP points

来源：

- https://www.electronjs.org/docs/latest/api/structures/display
- https://www.electronjs.org/docs/latest/api/screen/

所以运行时 clamp 逻辑不需要额外做 DPI 换算；DPI 只会影响“如何从视频像素反推代码里的几何量”。

## 3. 根因

当前 ON 模式底部 slack 是“相对 `workArea.bottom` 的固定窗口高度比例”，而不是“受物理屏幕边界约束的最大允许外溢”。

于是当：

```text
desiredBottomOverflow = round(windowHeight * 0.25)
desiredBottomOverflow > displayBottomInset
```

时，真实窗口会掉出物理屏幕底边：

```text
overflowPastPhysicalBottom = desiredBottomOverflow - displayBottomInset
```

这就是 Peter 在自己 setup 上看到“只剩头顶”的直接原因。

## 4. 修复目标

### 4.1 要达成的结果

`allowEdgePinning = ON` 时：

1. 仍然允许“脚踩 taskbar”的视觉效果
2. 但真实窗口不能越过物理屏幕底边
3. drag 和 rest 必须使用同一套 capped bottom slack，避免 drop 回弹

### 4.2 明确不做

这次 patch 不做：

1. 全面重写 display 选择策略
2. top-only viewport offset 推广为上下对称 signed shift
3. 改动 OFF 模式行为
4. 改动 top ratio `0.6h`

## 5. 方案

### 5.1 用 display inset cap bottom slack

新增一个 display inset helper，表达“workArea 相对物理屏幕四边各缩进多少”：

```js
function getDisplayInsets(display) {
  if (!display || !display.bounds || !display.workArea) {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }

  const { bounds, workArea } = display;
  return {
    top: Math.max(0, workArea.y - bounds.y),
    left: Math.max(0, workArea.x - bounds.x),
    bottom: Math.max(0, bounds.y + bounds.height - (workArea.y + workArea.height)),
    right: Math.max(0, bounds.x + bounds.width - (workArea.x + workArea.width)),
  };
}
```

底边真正允许的 slack 改为：

```js
desiredBottom = Math.round(height * EDGE_PIN_BOTTOM_RATIO);
effectiveBottom = Math.min(desiredBottom, displayInsets.bottom);
```

这样：

- 我的机器：taskbar 高度约等于 `0.25h`，体验不变
- Peter 的机器：taskbar 更薄时，bottom slack 自动被 cap 到 taskbar band 高度
- top/left/right taskbar 也不会被“`bounds.height - workArea.height` 只适配 bottom taskbar”这种写法误伤

### 5.2 drag 和 rest 必须同 cap

当前 ON 模式 bottom ratio 同时存在于两个 helper：

- [src/visible-margins.js](D:/animation/src/visible-margins.js:77)
- [src/visible-margins.js](D:/animation/src/visible-margins.js:102)

所以这次修复必须把同一个 `displayInsets.bottom` 同时传给：

- `getLooseDragMargins(...)`
- `getRestClampMargins(...)`

否则 drag 期间能到的位置，在 drop 后会被 rest clamp 重新拉回，形成回弹。

### 5.3 这次先不改 display selection 语义

当前 `clampToScreenVisual()` 仍然用“center point 最近 workArea”：

- [src/main.js](D:/animation/src/main.js:2711)
- [src/main.js](D:/animation/src/main.js:2735)

本 patch 只需要拿到一个同语义的 `Display` 来求 inset。最小实现可以继续按 center point 取最近 display，再求其 `displayInsets.bottom`。

`screen.getDisplayMatching(rect)` 的矩形匹配更稳，尤其对多屏更合理，但那是独立改进项，不是这次 bug 的必要条件。

## 6. 代码改动建议

### 6.1 `src/work-area.js`

新增纯函数：

```js
function getDisplayInsets(display) { ... }
```

理由：

1. 这里已经承载纯 display/workArea 数学
2. helper 可单测
3. 不把 Electron `screen` 依赖塞进 `visible-margins.js`

### 6.2 `src/visible-margins.js`

扩展两个 helper 的参数，接受 caller 传入的 bottom inset cap：

```js
function getLooseDragMargins({
  width,
  height,
  visibleMargins,
  allowEdgePinning,
  bottomInset,
} = {}) { ... }

function getRestClampMargins({
  height,
  visibleMargins,
  allowEdgePinning,
  bottomInset,
} = {}) { ... }
```

ON 模式时：

```js
const desiredBottom = Math.round(heightPx * EDGE_PIN_BOTTOM_RATIO);
const cappedBottom = Math.min(
  desiredBottom,
  Number.isFinite(bottomInset) ? Math.max(0, Math.round(bottomInset)) : desiredBottom
);
```

`top` 保持现状，不变。

### 6.3 `src/main.js`

在 `looseClampPetToDisplays()` 和 `clampToScreenVisual()` 两处都拿到“当前语义下的 display bottom inset”，并传给 margin policy helper：

```js
const display = screen.getDisplayNearestPoint({
  x: Math.round(x + w / 2),
  y: Math.round(y + h / 2),
});
const displayInsets = getDisplayInsets(display);
```

然后：

```js
getLooseDragMargins({ ..., bottomInset: displayInsets.bottom })
getRestClampMargins({ ..., bottomInset: displayInsets.bottom })
```

## 7. 测试

### 7.1 单测

应补的最小单测：

1. `test/work-area.test.js`
   - `getDisplayInsets()` on bottom taskbar
   - `getDisplayInsets()` on top taskbar
   - `getDisplayInsets()` on left/right taskbar
2. `test/visible-margins.test.js`
   - ON drag bottom capped by inset
   - ON rest bottom capped by inset
   - inset 大于 desiredBottom 时仍保持原 ratio
   - `bottomInset = 0` 时 ON bottom slack = 0

### 7.2 手测

Windows 上至少覆盖：

1. 1920x1080 / 100% DPI / 标准 bottom taskbar
2. 2560x1440 / 100% DPI / 标准 bottom taskbar
3. 2560x1440 / 125% DPI / 标准 bottom taskbar
4. `allowEdgePinning` OFF 回归
5. drag 到底后 drop，确认没有 bounce-back

## 8. 风险与取舍

### 8.1 已接受的限制

这次 patch 仍然不是“真正的底部 virtual bounds”。

它只是把 bottom overflow 限制在物理 display inset 以内，因此：

1. 解决了“桌宠主体掉出物理屏幕”这个 bug
2. 保住了 Peter 想要的 taskbar flush feel
3. 但没有像顶部那样提供“真实窗口不动、只做视口偏移”的底部虚拟能力

这对 #126 足够。

### 8.2 延后项

可单独开后续 issue 的两件事：

1. 把 display 选择从 center-nearest point 升级成 `screen.getDisplayMatching(rect)`
2. 把 top-only `viewportOffsetY` 推广成支持 bottom 的 signed viewport shift

## 9. 一句话决策

这次按最小修复做：

> `allowEdgePinning = ON` 时，bottom slack 从固定 `0.25h` 改成 `min(0.25h, displayBottomInset)`，并且 drag / rest 同步套用；其余语义保持不变。

## 10. Scope extension: OFF mode top cap (a90783a)

> 本节为事后追记 —— 原计划 §4.2 明写"不改动 OFF 模式行为"，但紧随 4b07658 之后的 a90783a 在 OFF mode 里**确实**动了 top drag margin。记录决策是为了让 plan 和代码一致。

**背景**：OFF mode 原先的 top drag margin 是 `topMargin + rubberBandY (0.25h)`。对 envelope 有大片 halo 的 theme（`topMargin` 本身就很大），叠上 0.25h 后，user 一拖能把窗口主体顶到只剩很薄一条，看着像 bug。

**改动**：新增 `getCappedOffRubberBandTop(topMargin, heightPx, rubberBandY)`，封顶到 `max(topMargin, 0.5h)`：
- 如果 `topMargin < 0.5h`：cap 是 `0.5h`，drag 最多允许 `min(topMargin + 0.25h, 0.5h)`，超过半个窗口的部分不再吃进去
- 如果 `topMargin >= 0.5h`：cap 就是 `topMargin` 本身，drag 和 rest 等量，退化为无 rubber-band

**不是 bug，是设计**：drag margin 比 rest margin 大（rubber-band 的定义），释放回弹是 feature。4-21 review 时一度误判为 asymmetry regression，复核后确认 rest 仍然用 `topMargin`（`src/visible-margins.js:132`），drag/rest 按 rubber-band 语义正确不对称。

**不 break "飞出去"的玩法**：`topMargin` 本身来自 theme envelope，大多数 theme 下 < 0.5h，cap 基本等于 0.5h，比原来 `topMargin + 0.25h` 在绝大多数场景下**更宽松**（原来 0 < topMargin < 0.25h 时 total < 0.5h），所以老用户习惯的"飞出去"手感不变。

**测试**：`test/visible-margins.test.js` 里 3 条 OFF mode cap 用例覆盖 modest headroom / exceed-half-window / rest-unchanged 三种情形。
