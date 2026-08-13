# Plan: Issue #244 Low Power Idle Mouse-Follow CPU

> Status: **Implemented and shipped.** `lowPowerIdleMode` lives in `src/prefs.js`, and
> the release smoke checklist carries a Low-power idle item
> (`docs/project/release-process.md`). Issue #244 closed 2026-07-12. The draft below is
> kept as the design record — it was written as "Draft v1, revised after Claude review
> and Codex code check".
> Date: 2026-05-07 (status refreshed 2026-08-12)
> Issue: https://github.com/rullerzhou-afk/clawd-on-desk/issues/244
> Scope: Fix the existing Low power idle behavior so passive mouse-follow does not keep idle rendering active. Do not add a new Settings toggle in this pass.

---

## 1. Issue Summary

Reporter environment:

- Clawd version: 0.7.0, also reproduced on 0.6.2
- OS: macOS 15, Apple Silicon
- Low power idle: enabled

Initial report:

- Idle CPU was around 27-30% in one Clawd process and 18-20% in a second process.
- Combined idle CPU was around 45-50%, with 6-8% GPU.
- macOS showed Clawd as "Using Significant Energy".

Reporter follow-up after collecting 7 minutes of samples:

- Low power idle does work when it engages: idle samples averaged about 0.2% CPU.
- It only engaged for 41 / 86 samples, about 48% of the time.
- The remaining active samples averaged about 41.8% CPU.
- Overall average was about 22.0%, with max 63.2%.

Interpretation:

- The existing switch is real, but it does not solve normal desktop usage because passive mouse-follow keeps the app active.
- There are two related but separate problems:
  1. Passive mouse-follow should not block Low power idle.
  2. Active eye-tracking / SVG rendering cost is high on macOS arm64 and needs profiling.

This plan addresses the first problem and reduces unnecessary work after Low power idle has engaged. It does not fully solve active-rendering cost when Low power idle is disabled or before idle pause engages.

---

## 2. Current Code Path

Settings:

- `src/prefs.js` defines `lowPowerIdleMode`.
- `src/settings-tab-general.js` renders the General tab switch.
- `src/settings-effect-router.js` sends `low-power-idle-mode-change` to the renderer.
- `src/main.js` also syncs the current value after renderer load.

Renderer low-power behavior:

```text
src/renderer.js
  LOW_POWER_IDLE_PAUSE_MS = 5000
  LOW_POWER_PAUSE_STATES = idle / mini-idle / dozing
  setLowPowerIdleMode()
  scheduleLowPowerIdlePause()
  pauseCurrentSvgForLowPower()
  resumeCurrentSvgForLowPower()
```

When Low power idle is enabled and the renderer remains in a pause-eligible state for 5 seconds, it injects pause CSS and calls `root.pauseAnimations()` for the current SVG.

Current bug:

```text
src/tick.js
  screen.getCursorScreenPoint()
  compute eye / pointer payload
  sendToRenderer("eye-move", ...)
  sendToRenderer("cloudling-pointer", ...)

src/renderer.js
  onEyeMove()
    noteLowPowerActivity()
    applyEyeMove() or _startLayerAnimLoop()

  onCloudlingPointer()
    noteLowPowerActivity()
    applyCloudlingPointerBridge()
```

`noteLowPowerActivity()` resumes the SVG and reschedules the 5 second pause timer. Normal mouse movement therefore keeps resetting Low power idle.

Main-process work still exists even if the renderer ignores tracking:

```text
src/tick.js
  IDLE_TICK_MS = 250
  BOOST_TICK_MS = 100
  BACKGROUND_TICK_MS = 750
```

In `idle`, `mini-idle`, or `miniMode`, `tick.js` continues polling the global cursor. When the cursor moves, it may also read pet bounds, compute hit rects, compute eye offsets, and send renderer IPC. A renderer-only fix would leave this path active.

---

## 3. Corrected Assumptions From Review

Claude review correctly identified:

1. A renderer-only patch is incomplete. Main-process cursor polling and renderer IPC continue after the renderer starts ignoring eye movement.
2. Layered tracking can leave a `requestAnimationFrame` loop alive. Low-power suppression must cancel or stop that loop.
3. Active-rendering cost should be tracked as a follow-up, not silently dismissed.

Codex code check corrected these points:

1. `tick.js` does not literally do full bounds / hit rect / IPC work on every tick. It deduplicates some work when the cursor has not moved. However, under normal mouse movement those paths can still run frequently enough to matter.
2. Activity Monitor process attribution is not enough to prove that the second Clawd process is specifically main-process tick plus IPC. That is a plausible hypothesis, not a measured fact.
3. The hit window does not currently provide independent hover wake events. `src/hit-renderer.js` handles click, drag, right-click, and focus paths, but not ordinary `mouseenter` / `mouseleave` / hover IPC. Therefore this fix should not fully stop cursor polling unless a separate hover wake path is added.
4. `test/renderer-low-power.test.js` is currently mostly source-level assertions, not an existing browser-env renderer behavior harness.

---

## 4. Target Behavior

When `lowPowerIdleMode` is on:

1. Passive mouse-follow must not reset the 5 second low-power pause timer.
2. Once the SVG is paused for Low power idle, passive tracking should stop mutating SVG DOM.
3. Main-process tick should avoid high-frequency cursor polling and avoid sending passive tracking IPC while low-power pause is active.
4. Real activity must still wake the pet:
   - agent state changes
   - permission / notification / working / thinking states
   - click reactions
   - drag reactions
   - disabling Low power idle
   - theme/state changes that swap assets
5. Existing mini-mode behavior must not regress. Because there is no independent hover IPC from hit window, mini hover paths still need some polling unless a future change adds a separate event path.

---

## 5. Implementation Plan

### 5.1 Renderer: Passive Tracking Is Not Activity

File: `src/renderer.js`

Remove `noteLowPowerActivity()` from passive tracking handlers:

- `window.electronAPI.onEyeMove(...)`
- `window.electronAPI.onCloudlingPointer(...)`

Keep activity wake behavior in these paths:

- `onStateChange(...)`
- `playReaction(...)`
- `startDragReaction(...)`
- `setLowPowerIdleMode(false)`
- other explicit state / reaction transitions

Rationale:

- Eye movement and Cloudling pointer updates are passive visual follow behavior.
- They should not restart animation merely because the user is moving the system cursor.

### 5.2 Renderer: Suppress Passive Tracking While Paused

File: `src/renderer.js`

Add a helper:

```js
function shouldSuppressPassiveTrackingForLowPower() {
  return lowPowerIdleMode && lowPowerSvgPaused && shouldPauseForLowPower();
}
```

The three checks are intentionally redundant. `lowPowerSvgPaused` should be sufficient in the steady state, but keeping `lowPowerIdleMode` and `shouldPauseForLowPower()` in the predicate avoids a short stale-paused window during state changes.

`onEyeMove(dx, dy)` behavior:

1. Keep updating `lastEyeDx` / `lastEyeDy` with the latest effective position.
2. If low-power passive tracking is suppressed:
   - cancel any active layered tracking frame
   - do not call `_startLayerAnimLoop()`
   - do not call `applyEyeMove()`
   - do not run stale-target reattach work
   - return
3. Otherwise behave as today.

Layered tracking details:

- If `_layerAnimFrame` is already active when low-power pause begins, cancel it.
- Add a guard in the RAF tick itself so a frame that starts before pause does not reschedule after pause.
- Do not unwrap tracking layers just because of low-power pause. Unwrapping is heavier and is already handled by `detachEyeTracking()`.

`onCloudlingPointer(payload)` behavior:

1. Normalize and store the latest `lastCloudlingPointerPayload`.
2. If low-power passive tracking is suppressed, do not call the SVG bridge.
3. Otherwise call the bridge as today.

Recovery detail:

- When a real activity resumes animation or a state swap loads the same object again, the renderer already has the latest eye / pointer values and can reapply them through the normal attach / state-change paths.

### 5.3 Renderer -> Main: Notify Low-Power Pause State

Files:

- `src/preload.js`
- `src/renderer.js`
- `src/pet-interaction-ipc.js`
- `src/main.js`

Expose a renderer-to-main IPC:

```js
setLowPowerIdlePaused(paused)
```

Renderer sends:

- `true` when `pauseCurrentSvgForLowPower()` actually pauses the current SVG.
- `false` when `resumeCurrentSvgForLowPower()` clears low-power pause.
- `false` when Low power idle is disabled.

Main stores a mirror boolean, for example `lowPowerIdlePaused`.

Important:

- Send notifications only on transitions, not on every timer tick.
- Treat renderer notification as a performance hint, not source of truth for app state.
- If the renderer reloads, default to `false` until it reports a pause again.
  - Listen to render-window `webContents` events such as `did-start-loading` and `render-process-gone`; both should reset the main mirror to `false`.
  - This prevents a stale `lowPowerIdlePaused=true` mirror from throttling tick after the renderer has crashed or reloaded.
- When transitioning from `true` to `false`, trigger one eye resend boost:
  - set `forceEyeResend = true` through the existing setter path
  - preserve the existing `forceEyeResendBoostUntil` behavior
  - this prevents the first post-resume eye position from being swallowed by tick/renderer dedup while the renderer was frozen on an older transform

### 5.4 Main Tick: Low-Power-Aware Polling

File: `src/tick.js`

Add ctx reader:

```js
get lowPowerIdlePaused() { return lowPowerIdlePaused; }
```

Define explicit low-power tick delays:

```js
const LOW_POWER_IDLE_TICK_MS = 5000;
const LOW_POWER_MINI_IDLE_TICK_MS = 2000;
const LOW_POWER_PAUSE_STATES = new Set(["idle", "mini-idle", "dozing"]);
```

Update scheduling:

- In normal `idle` after the renderer has reported `lowPowerIdlePaused`, use `LOW_POWER_IDLE_TICK_MS` instead of `IDLE_TICK_MS` or recent-mouse `BOOST_TICK_MS`.
- In `mini-idle`, use `LOW_POWER_MINI_IDLE_TICK_MS` so hover / mini-peek can still recover within a bounded delay.
- Do not apply these delays to `mini-peek`, drag, menu-open, or transition paths where cursor position is needed for immediate user-visible interaction.
- `dozing` is a low-power pause state, but it is not an eye-tracking path in `tick.js`; keep wake/deep-sleep behavior owned by `state.js` wake polling.
- Avoid using `ctx.idlePaused` for this. That flag currently pauses cursor polling during reactions and has different semantics.

Suppress passive IPC while paused:

- If `lowPowerIdlePaused` and `currentState` is in `LOW_POWER_PAUSE_STATES`, skip `sendToRenderer("eye-move", ...)`.
- Also skip `sendToRenderer("cloudling-pointer", ...)` for passive idle pointer bridge.
- Keep non-passive state changes going through `state-change`.

Do not fully stop cursor polling in v1:

- Current hover / mini peek behavior depends on `tick.js`.
- The hit window does not currently send hover enter/leave IPC.
- Sleep threshold checks are also currently performed inside `tick.js`; stopping the tick would prevent idle-look / yawning / sleeping from being triggered.
- Full stop can be considered later only if a separate sleep deadline timer and hover wake path are implemented.

### 5.5 Sleep Timer Semantics

Do not change the existing mouse-still sleep model in this issue.

Current behavior:

- Mouse movement resets `mouseStillSince`.
- After `mouseIdleTimeout`, random idle animation can run.
- After `mouseSleepTimeout`, sleep sequence can start.

This issue is about Low power idle energy use, not changing when the pet sleeps. Changing sleep semantics would be user-visible and should be a separate design decision.

Known trade-off:

- While low-power pause is active, sleep detection can be delayed by up to the active low-power tick interval.
- With the proposed values, normal idle sleep detection can lag by up to about 5 seconds, and mini-idle hover / peek detection can lag by up to about 2 seconds.
- This is an intentional performance trade-off for #244, not a functional regression.

---

## 6. Testing Plan

### 6.1 Tick Behavior Tests

File: `test/tick.test.js`

Add behavior tests around a new `ctx.lowPowerIdlePaused` reader:

1. Idle low-power pause reduces cursor polling.
   - Start in idle with `lowPowerIdlePaused = false`.
   - Let normal adaptive tick run enough to establish baseline.
   - Set `lowPowerIdlePaused = true`.
   - Move the mocked cursor frequently.
   - With `LOW_POWER_IDLE_TICK_MS = 5000`, assert paused normal idle makes no more than 3 cursor polls over 10 seconds.
   - Also assert the non-paused baseline over 10 seconds is materially higher, roughly over 30 cursor polls with the current adaptive idle schedule.

2. Idle low-power pause suppresses passive eye IPC.
   - Start in idle on the idle-follow SVG.
   - Set `lowPowerIdlePaused = true`.
   - Move cursor.
   - Assert no `eye-move` is sent while paused.

3. Idle low-power pause suppresses passive Cloudling pointer IPC.
   - Use an idle state / SVG that enables pointer bridge.
   - Set `lowPowerIdlePaused = true`.
   - Move cursor.
   - Assert no `cloudling-pointer` is sent while paused.

4. Non-paused behavior remains intact.
   - With `lowPowerIdlePaused = false`, existing eye-move and pointer tests should still pass.

5. Mini-mode guard.
   - Verify low-power throttling does not break existing mini peek tests.
   - With `LOW_POWER_MINI_IDLE_TICK_MS = 2000`, assert paused `mini-idle` makes no more than 6 cursor polls over 10 seconds.
   - Verify `mini-peek`, drag, and transition paths are not throttled by the low-power paused idle delays.

### 6.2 Renderer Low-Power Tests

File: `test/renderer-low-power.test.js`

Minimum source-level smoke tests:

- `onEyeMove` no longer calls `noteLowPowerActivity()`.
- `onCloudlingPointer` no longer calls `noteLowPowerActivity()`.
- A helper equivalent to `shouldSuppressPassiveTrackingForLowPower()` exists.
- Suppressed eye movement cancels the layered RAF path.

Preferred behavior tests, if a renderer VM harness is added:

1. Enable Low power idle.
2. Enter idle and advance timers past 5 seconds.
3. Assert low-power pause state is active.
4. Fire repeated `eye-move` callbacks.
5. Assert the SVG remains paused and no transform writes occur.
6. Start a layered tracking RAF, then enter low-power pause.
7. Assert the RAF is canceled or no longer reschedules.
8. Fire repeated Cloudling pointer callbacks.
9. Assert the bridge function is not called while paused, but latest payload is retained.

There is no existing jsdom dependency or ready-made renderer harness. If this issue stays narrow, keep the minimum source-level smoke tests and open a follow-up to replace them with a VM/stub behavior harness modeled after `test/settings-renderer-browser-env.test.js`.

### 6.3 IPC Tests

File: `test/pet-interaction-ipc.test.js`

Add coverage for the new renderer-to-main low-power pause IPC:

- `low-power-idle-paused true` updates the main mirror.
- `low-power-idle-paused false` clears it.
- Disposer removes the listener.

### 6.4 Regression Tests

Run:

```bash
node --test test/tick.test.js test/renderer-low-power.test.js test/pet-interaction-ipc.test.js
npm test
```

`npm test` already scopes to `node --test test/*.test.js`, so it will not run temporary root-level `test-*.js` files.

---

## 7. Manual Verification

On macOS arm64 if available:

1. Enable Low power idle.
2. Leave Clawd in idle for at least 5 seconds.
3. Keep moving the mouse around the desktop, not dragging or clicking the pet.
4. Expected: idle SVG remains paused and eye / pointer follow stays frozen while paused.
5. Trigger a real activity:
   - click reaction
   - drag reaction
   - agent state event
   - Settings toggle off/on
6. Expected: Clawd resumes animation for that activity.
7. Return to idle.
8. Expected: Low power pause re-engages.

Suggested resource target for this issue:

- During idle with Low power idle enabled and continuous ordinary mouse movement, CPU should stay close to the paused-idle profile rather than the active eye-follow profile.
- A practical target is sustained average under 5% combined CPU in the reporter's sampling method, but CI should not enforce this number.
- Lulu does not have a macOS device. CSV sampling validation depends on help from the reporter (`@1nwooozip`) or another macOS arm64 tester. Local Windows verification can cover paused behavior and IPC suppression, but macOS CPU numbers are required before closing the issue as fixed.

Record:

- Clawd version / branch
- theme
- sample duration
- sample interval
- average CPU
- max CPU
- whether GPU remains elevated

---

## 8. Follow-Up Issue

Open or keep a follow-up for active-rendering CPU on macOS arm64.

Follow-up scope:

- Profile active eye-follow without Low power idle pause.
- Compare built-in themes:
  - Clawd single-target SVG tracking
  - Calico layered tracking
  - Cloudling scripted pointer bridge
- Separate main-process cursor polling from renderer SVG / CSS animation / GPU compositing cost.
- Investigate whether Calico filters, object-channel SVG, layered RAF easing, or Chromium compositing dominate.
- Consider active-mode optimizations only after measurement:
  - lower tracking rate
  - coalesce IPC
  - reduce layered RAF duration
  - reduce SVG filter cost
  - theme-specific low-power assets

Do not block the Low power idle bugfix on this profiling work.

---

## 9. Out Of Scope

- New Settings UI such as "Pause eye tracking when low power idle".
- Changing the mouse-still sleep sequence.
- Reworking hit window hover tracking.
- Rewriting theme SVGs or Calico assets.
- Implementing active-mode CPU optimizations such as lower tracking rate, IPC coalescing, layered RAF tuning, SVG filter simplification, or theme-specific low-power assets.
- Claiming that active rendering CPU is fixed without macOS profiling.
