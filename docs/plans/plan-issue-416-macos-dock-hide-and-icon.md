# Plan: Issue #416 — macOS Dock "Hide" no-op + oversized Dock icon

> Status: IMPLEMENTED (2026-06-04). Probe ran → Path 1 (§3.2). Both parts shipped + unit-tested + live-verified on macOS; two Codex implementation-review passes → Go. See §7 for the as-built notes.
>
> **v2 → v3 changelog (2nd Codex pass, all re-verified):**
> 1. **Path 1 blocker fixed.** Dock right-click → Hide works on a **non-frontmost** app, which fires **no** `did-resign-active`. So v2's "read `app.isHidden()` once after `did-resign-active`" would miss the issue's main path. Path 1 is now driven by a **persistent `app.isHidden()` change watcher** (poll ~250ms) with focus events only as supplementary sampling triggers (§3.3).
> 2. **Native notification demoted.** `src/mac-window.js` is `objc_msgSend`-only (no `objc_allocateClassPair`/IMP/block bridge); a koffi callback held across the ObjC notification lifecycle is crash-prone. `NSApplicationDidHide` observation moves to an optional later refinement; the polling watcher is the primary mechanism (§3.3).
> 3. **`hiddenByOsHide` clear rule broadened:** *any* manual hide/show (tray/shortcut) clears it, not just `showDock` toggles (§3.5).
> 4. **Path 2 made concrete:** add a `{ canHide }` option to `applyStationaryCollectionBehavior` (`mac-window.js:142`); `topmost-runtime.js:81` passes `true` for render/hit, `false` for permission/update/HUD/context-owner. Window `hide/show` handlers must gate on `app.isHidden()` so a manual `setPetHidden()` isn't mislabeled as an OS hide (§3.4).
> 5. **`setPetHidden` contract pinned** + mini reconciliation switched to a **short-poll on `getMiniTransitioning()`** (mini.js clears the flag at 4 sites: 252/258/426/558 — a single completion callback would miss cancel/exit paths) (§3.5).
> 6. **Probe instrumentation** upgraded: continuous `isHidden()` change poll, log `app.isActive()`, `osascript` targets by **pid** not process name, and the "Dock Hide while inactive" path is a must-test (§3.2).
> 7. Part B: added a **regression guard** recommendation (assert `dock-icon.png` bbox ≠ 100%) (§4.5). §6 resolved #2 and #3.
>
> ---
>
> Status history: Draft v2, revised after 1st Codex review + independent code re-verification (2026-06-04). No code written yet.
> Date: 2026-06-04
> Issue: https://github.com/rullerzhou-afk/clawd-on-desk/issues/416
> Reporter: sanyimufeng (wq). Owner confirmed repro 2026-06-03.
> Scope: Two macOS-Dock-only changes discovered together.
>   - **Part A (#416):** macOS app "Hide" (⌘H / Dock right-click → 隐藏) does nothing for the pet. Make it actually hide/restore the pet.
>   - **Part B (new, unfiled):** Clawd's Dock tile is visibly larger than neighbor apps. Re-pad the icon to the Apple grid.
> Out of scope: Windows/Linux behavior (no app-level Hide there); the build/dmg icon (`assets/icon.png`); any new Settings toggle.
>
> **v1 → v2 changelog (what the Codex review caught, all re-verified against the shipped code):**
> 1. Electron 41's `app` module has **no `hide`/`show` events** — verified in `node_modules/electron/electron.d.ts`: the `App` interface (lines 21–2045) only declares `activate` / `did-become-active` / `did-resign-active`; `'hide'`/`'show'` live on `BaseWindow` (2158/2415) and `BrowserWindow` (4295/4858). v1's core bridge (`app.on('hide')`) was based on a non-existent event. Part A reworked (§3).
> 2. With `canHide:NO`, the pet windows also won't emit their own `BrowserWindow` `'hide'` event on ⌘H → **no Electron-level Hide signal exists at all**. The signal must come from native `NSApplicationDidHide/UnhideNotification` or polling `app.isHidden()`.
> 3. The Part B generation script was **not idempotent** (read `dock-icon.png`, scale down, overwrite the same file → reruns keep shrinking) and skipped the repo's "preserve release assets under `assets/source/`" rule. Fixed (§4).
> 4. Factual corrections: the topmost watchdog is **Windows-only** (`src/topmost-runtime.js:186` `if (!isWin) return`), so on macOS `canHide:NO` is re-asserted by `reapplyMacVisibility()` on events, **not** a timer. The pet **right-click context menu has no hide item** (`buildContextMenu` only — tray/menu-bar menu has it). `dock-icon.png` ships via `build.files` (`package.json:138`), **not** `extraResources`.
> 5. `reapplyMacVisibility()` applies `canHide:NO` to **all** floating surfaces (permission bubbles, update bubble, Session HUD, context-menu owner), not just pet/hit windows — so any B2 `canHide` relaxation has blast radius beyond the pet.

---

## 1. Issue Summary

Reporter: on macOS, right-clicking the Clawd icon in the Dock shows a "隐藏" (Hide) option, but clicking it does nothing — the pet stays on screen and the Dock tile remains.

Two distinct findings:

1. **Part A — the inert "Hide" (the filed issue).** On a normal app, macOS "Hide" (⌘H) instantly hides all the app's windows (the Dock tile always stays — that part is normal macOS, not removable). On Clawd, even the window-hiding does nothing, because the pet windows opt out of hide. The menu item is present (macOS forces it into every app's Dock menu) but inert.
2. **Part B — the oversized Dock tile.** Clawd's runtime Dock icon fills 100% of its canvas (zero margin) vs the Apple grid's ~80.5%, so it bulges larger than neighbors.

---

## 2. Current Code Path

### 2.1 Why "Hide" is inert (Part A)

- Pet windows opt out of OS hide in `src/mac-window.js:177`:
  ```text
  src/mac-window.js  applyStationaryCollectionBehavior()
    msgVoidBool(nsWindow, selSetCanHide, false);          // [nsWindow setCanHide:NO]  ← direct cause of Hide no-op
    msgVoidBool(nsWindow, selSetHidesOnDeactivate, false); // only explains "stays put when app deactivates"
    ... + canJoinAllSpaces | stationary | screen-saver level
  ```
  `setCanHide:NO` makes `-[NSApplication hide:]` skip these windows. `hidesOnDeactivate:NO` is a *different* flag (deactivation, not Hide) and is **not** the Hide root cause.
- `applyStationaryCollectionBehavior` is re-asserted on macOS via `reapplyMacVisibility()` (`src/topmost-runtime.js:62`) **on events** (e.g. `applyDockVisibility`, show paths). The topmost **watchdog timer** (`:185`) is **Windows-only** (`if (!isWin) return`) — there is no periodic mac re-assert.
- Crucially, `reapplyMacVisibility()`'s `apply()` runs over **getWin, getHitWin, every pending permission bubble, the update bubble, the Session HUD, and the context-menu owner** (`src/topmost-runtime.js:81-88`) — so `canHide:NO` is set on the *entire* floating-surface group, not just the pet.
- No custom Dock menu (`app.dock.setMenu` never called) → the screenshot menu is 100% macOS-provided; Electron cannot remove/re-bind the system "隐藏 / 退出" items.
- **No `app.on('hide'|'show')` exist as Electron events** (see changelog #1). Existing app-lifecycle handlers in `src/main.js`: `open-url` (3184), `second-instance` (3198), `whenReady` (3221), `before-quit` (3293), `window-all-closed` (3324). App focus events that *do* exist: `activate`, `did-become-active`, `did-resign-active`. Hidden-state method: `app.isHidden()` / `app.hide()` / `app.show()`.

The pet **can** be hidden trivially — the app already does it:

```text
src/pet-window-runtime.js
  isPetHidden()            -> petHidden (single source of truth)
  showPetWindows()         -> win.showInactive() + hitWin.showInactive() + keepOutOfTaskbar
  hidePetWindows()         -> win.hide() + hitWin.hide()
  togglePetVisibility()    -> flips petHidden; show branch: showFloatingSurfacesForPet() + reapplyMacVisibility();
                              hide branch: hideFloatingSurfacesForPet();
                              then syncSessionHudVisibilityAndBubbles() + syncPermissionShortcuts()
                              + buildTrayMenu() + buildContextMenu(); early-returns while miniTransitioning
```

`togglePetVisibility()` is reached from (all cross-platform):
- The **tray / menu-bar** menu item "隐藏 Clawd / 显示 Clawd" (`src/menu.js:179`, inside `buildTrayMenu`). **The pet right-click `buildContextMenu` does NOT include this item.**
- The persistent global shortcut `togglePet` (`src/shortcut-actions.js:13`).
- `bringPetToPrimaryDisplay()` internal use (`src/pet-window-runtime.js:235`).

### 2.2 Why the Dock icon is oversized (Part B)

- `src/main.js:3221-3231` overrides the Dock icon at runtime on macOS (`app.dock.setIcon(assets/dock-icon.png)`), with a comment admitting the build icon "appears smaller", so a full-bleed version was swapped in.
- Measured content occupancy (non-transparent bbox / 1024px canvas):
  | Asset | Used for | Content width | vs Apple grid (80.5%) |
  |-------|----------|---------------|------------------------|
  | `assets/icon.png` | build/dmg icon | **72.6%** (low-centered: B-margin 89 vs T 136) | too small |
  | `assets/dock-icon.png` | runtime Dock tile (override) | **100.0%** (0 margin) | too big |
- `dock-icon.png` is referenced only at `src/main.js:3227` and shipped via `package.json:138` (**`build.files`**, not `extraResources`).

---

## 3. Part A — Make macOS "Hide" actually hide the pet

User-chosen direction: **bridge the OS app-hidden state to the pet.** macOS-only; guard everything with `isMac`; no behavior change on Windows/Linux.

### 3.1 The real decision axis

Not "B1 vs B2" but **two independent questions**:
- **Q-signal:** where does "the app was hidden" come from, given `app` has no `hide` event and (under `canHide:NO`) the window emits none either?
- **Q-canHide:** do we keep `canHide:NO` (and observe the hidden-state transition externally) or relax it to `YES` (and let the OS hide the window, which emits a `BrowserWindow 'hide'`)?

These collapse into two viable paths, chosen by the probe below.

### 3.2 Step 0 — Probe FIRST (must run before any Part A coding)

Temporary instrumentation in `main.js` `whenReady` (this session is `darwin` → testable here), then `npm start`. The probe must capture a **continuous `app.isHidden()` change poll** (not just a one-shot read on an event), `app.isActive()`, and must cover the **Dock-right-click-Hide-while-Clawd-is-NOT-frontmost** path — that path fires no `did-resign-active`, which is exactly why v2's one-shot approach was unsafe.

- **Triggers (test each):** ⌘H (only equivalent when `app.isActive()` is true); **Dock right-click → 隐藏 (the issue's main path — also test while another app is frontmost)**; `osascript` targeting **by pid, not process name**:
  `osascript -e 'tell application "System Events" to set visible of (first process whose unix id is <pid>) to false'`.
- **Repeat the matrix with `canHide:NO` (current) and `canHide:YES`.**
- Optional AppKit ground truth: an `NSApplicationDidHide/UnhideNotification` observer (see §3.3 for why it's not the primary mechanism).

Probe instrumentation (Codex-supplied, adapted — drop into `whenReady`, remove before shipping):

```js
function installMacHideProbe(label = "current") {
  if (!isMac) return;
  const { BrowserWindow } = require("electron");
  const t0 = process.hrtime.bigint();
  const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
  const stateOf = (w) => !w || w.isDestroyed() ? null
    : { id: w.id, visible: w.isVisible(), focused: w.isFocused(),
        minimized: typeof w.isMinimized === "function" ? w.isMinimized() : undefined };
  const log = (event, extra = {}) => console.log("[mac-hide-probe]", JSON.stringify({
    label, t: Math.round(ms()), event,
    appHidden: app.isHidden(), appActive: app.isActive(), showDock,
    petHidden: petWindowRuntime.isPetHidden(),
    render: stateOf(win), hit: stateOf(hitWin),
    all: BrowserWindow.getAllWindows().map(stateOf), ...extra }));
  const sample = (event, extra) => { log(event, extra);
    for (const d of [0, 16, 50, 100, 250, 500, 1000]) setTimeout(() => log(`${event}+${d}ms`, extra), d); };
  for (const ev of ["activate", "did-become-active", "did-resign-active"]) app.on(ev, (...args) => sample(`app:${ev}`, { args }));
  for (const [name, w] of [["render", win], ["hit", hitWin]]) {
    if (!w || w.isDestroyed()) continue;
    for (const ev of ["hide", "show", "blur", "focus"]) w.on(ev, () => sample(`${name}:${ev}`));
  }
  let lastHidden = app.isHidden();
  const timer = setInterval(() => { const next = app.isHidden();
    if (next !== lastHidden) { lastHidden = next; sample(`poll:appHidden=${next}`); } }, 100);
  app.once("before-quit", () => clearInterval(timer));
  log("installed", { pid: process.pid,
    targetedHide: `osascript -e 'tell application "System Events" to set visible of (first process whose unix id is ${process.pid}) to false'` });
}
```

**Decision:** *Under `canHide:NO`, does any Hide trigger drive `app.isHidden()` → true (per the poll)?*
- **YES** → **Path 1** (keep `canHide:NO`, watch `isHidden()`, drive the pet manually).
- **NO** → **Path 2** (relax `canHide`).

**✅ PROBE RUN 2026-06-04 (this machine, dev build, pid 80984) → Path 1 confirmed.** Sent the by-pid Hide (`osascript … set visible … to false`, the issue's Dock-Hide equivalent):
- `app.isHidden()` flipped **true** within ~100ms (poll caught it), and back **false** on restore. So `canHide:NO` does **not** block the app entering hidden state — Codex's prediction held.
- `render`/`hit` windows stayed `visible:true` throughout while `appHidden:true` — **OS-level proof of #416** (app hidden, windows refuse to vanish).
- **No `did-resign-active` fired** (tracked `appActive` stayed `true` across the whole hide/show) → an event-only detector would have missed it; **the polling watcher is mandatory**, not just preferred.
- Latency Hide→detect ≈ one poll tick (~100–250ms), matching §3.8.

### 3.3 Path 1 — keep `canHide:NO`, watch `app.isHidden()` (preferred)

Leaves the load-bearing window flags untouched. **Primary mechanism: a persistent `app.isHidden()` change watcher** (poll ~250ms), with focus events (`did-resign-active` / `activate` / `did-become-active`) only as *supplementary* sampling triggers — **never** as the sole signal:
- On `isHidden()` flip **false→true** → `setPetHidden(true)` + mark `hiddenByOsHide`.
- On flip **true→false** → if `hiddenByOsHide`, `setPetHidden(false)` + clear it.
- **Why polling, not `did-resign-active`:** Dock right-click → Hide works on a **non-frontmost** app and fires **no** `did-resign-active`; a once-after-resign read would miss the issue's main path entirely (Codex v3 blocker).
- **Native `NSApplicationDidHide` notification is NOT the first implementation.** `mac-window.js` is `objc_msgSend`-only (no dynamic class / IMP / block bridge); a koffi callback + observer token held across the app lifecycle is crash-prone if cleanup slips. Ship the poll first; native notification is an optional later refinement that removes the poll latency (§3.8).

### 3.4 Path 2 — relax `canHide`, let the OS hide the window (fallback)

Only if the probe shows `canHide:NO` blocks the app from ever entering hidden state.
- **Scope it cleanly via a parameter:** give `applyStationaryCollectionBehavior(win, { canHide })` a second arg (`mac-window.js:142`); in `reapplyMacVisibility`'s `apply()` (`topmost-runtime.js:81`) pass `canHide:true` for the render + hit windows and `canHide:false` for permission bubbles / update bubble / Session HUD / context-menu owner. Otherwise the whole floating-surface group (changelog #5) becomes OS-hideable.
- Subscribe to the pet render window's `BrowserWindow` `'hide'`/`'show'` events → `setPetHidden(...)` + sync.
- **The `hide`/`show` handler MUST gate on `app.isHidden()`** to tell an OS hide from a manual `setPetHidden()` (which itself calls `win.hide()` and fires `'hide'`). Without the gate, a tray/shortcut hide gets mislabeled as an OS hide → wrong restore behavior / loops.
- On show, call `reapplyMacVisibility()` to re-assert stationary/all-Spaces/topmost (a hide/show cycle can reset collection behavior).
- Accepted downside: Clawd then also responds to "隐藏其他 / Hide Others" (⌥⌘H). Arguably correct ("hide" means hide); record in the test plan.
- **Must** still drive `petHidden` + all UI sync from the window events, else the OS hides windows while `petHidden` stays false and tray label / permission shortcuts / update-bubble timer desync.

### 3.5 Shared design (both paths)

- **Refactor** `togglePetVisibility()` → idempotent `setPetHidden(hidden)` with `togglePetVisibility()` a thin wrapper. Keep ALL existing sync (floating surfaces, HUD, permission shortcuts, tray + context menu). `pet-window-runtime.js` stays platform-neutral and only does idempotent hide/show. **Return contract** (pinned): no render window → `{applied:false, deferred:false, changed:false}`; already in target state → `{applied:true, deferred:false, changed:false}`; `miniTransitioning` → `{applied:false, deferred:true, changed:false}` and **`petHidden` is left unchanged**; normal flip → `{applied:true, deferred:false, changed:true}`.
- **OS-hide bridging + the `hiddenByOsHide` flag live in a small mac-only unit** (e.g. `src/mac-hide.js` or an `isMac` block in `main.js` `whenReady`), **not** in the pet runtime.
- **`hiddenByOsHide` clear rule:** set it **only** when the watcher/handler observes an OS-driven hide; clear it on the matching OS unhide **and on ANY manual hide/show** (tray, `togglePet` shortcut, `bringPetToPrimaryDisplay`) and on any `showDock` toggle. Otherwise a manual state change after an OS hide leaves a stale flag and a later `activate` falsely "restores".
- **Manual show from tray/shortcut, and Dock-activate restore:** if `app.isHidden()` is true, call `app.show()` *before* `setPetHidden(false)` — avoids the "windows `showInactive`'d but app still hidden" limbo. Lives in the mac-only wrapper, not the platform-neutral runtime.
- **Mini transition (use a short-poll, not a callback):** when `setPetHidden` returns `deferred:true`, schedule a short poll on `getMiniTransitioning()` and re-apply once it clears. Preferred over adding a completion callback to `src/mini.js` because the flag is cleared at **4 sites** (enter/exit/cancel: lines 252/258/426/558) — a single callback would miss the cancel/exit paths.
- **UX restore policy (decided):** `show`/unhide restores only an OS-hide; `activate` while the Dock is visible **and** `petHidden` also restores a *manual* hide (clicking the tile is an explicit "come back"); never restore unconditionally on `did-become-active` (would fight normal focus switches).
- **`window-all-closed`:** `hide()` ≠ `close()`, so hiding must not trip the quit path (confirmed).

### 3.6 Test plan (manual, macOS — this machine + reporter's)

0. Run the §3.2 probe; record the decision.
1. Pet visible, Dock shown → ⌘H → pet hides, Dock tile stays → click tile → pet returns to same spot/Space.
2. Dock right-click → 隐藏 → same as (1).
3. ⌘Tab away and back → pet must **not** have hidden (deactivation ≠ hide).
4. Tray "隐藏 Clawd", then click the Dock tile → pet returns (per §3.5 policy).
5. ⌥⌘H "Hide Others" → document/verify behavior (Path 2 will hide Clawd; Path 1 will not unless the app itself is hidden).
6. Multi-display + mini mode + live permission bubble + Session HUD: hide/restore each combination; unplug/switch displays while hidden, then restore.
7. `showDock=false` (accessory): no crash/stuck state; tray "显示 Clawd" still restores.
8. Windows/Linux smoke: tray Hide/Show + `togglePet` shortcut unchanged (no mac-hide path runs).
9. Unit test: `setPetHidden` idempotency + `{applied,deferred,changed}` + the `hiddenByOsHide` reconciliation (pure logic; the AppKit signal stays manual).

### 3.7 Files touched (Part A)

- `src/pet-window-runtime.js` — `togglePetVisibility` → `setPetHidden(hidden)` returning `{applied,deferred,changed}` + wrapper; export `setPetHidden`.
- `src/main.js` (or new `src/mac-hide.js`) — `isMac` mac-hide unit: the `app.isHidden()` change watcher (Path 1) or window `hide/show` subscription (Path 2); `hiddenByOsHide` + clear rule; restore policy; `app.show()`-before-show guard; short-poll on `getMiniTransitioning()`.
- `src/mini.js` — **no change needed** (the mac-hide unit short-polls `getMiniTransitioning()`; no new callback).
- `src/mac-window.js` — **only if Path 2**: add the `{ canHide }` param; `src/topmost-runtime.js` passes `true`/`false` per surface.
- `test/` — visibility-state reconciliation test (`setPetHidden` contract + `hiddenByOsHide` clear rule).

### 3.8 Residual risk

- The probe outcome (§3.2) gates the whole approach; do not write Part A before running it.
- **Polling latency (Path 1):** with `canHide:NO` the pet stays visible until the next `isHidden()` poll catches the flip — a ~250ms lag after ⌘H before the pet disappears. Acceptable; the optional native `NSApplicationDidHide` notification (later refinement) removes it.
- **Poll cost vs issue #244:** a persistent 250ms `app.isHidden()` poll is a cheap boolean check — negligible next to the SVG / eye-tracking cost that #244 targets. Pick 250ms as the responsiveness/cost balance; do not drop to the probe's 100ms in shipping code.
- **Path 2** changes a load-bearing flag (scoped via the `{canHide}` param) and its `hide/show` handler must gate on `app.isHidden()`; regress Spaces / fullscreen / Mission Control / Hide Others.
- A future native observer adds FFI surface; keep it behind the existing `mac-window.js` try/catch + warn-once.

---

## 4. Part B — Re-pad the Dock icon to the Apple grid

### 4.1 Goal

Make Clawd's Dock tile match neighbor apps by giving `assets/dock-icon.png` the standard macOS margin. **Keep** the runtime override at `src/main.js:3227` (dropping it would fall back to the 72.6%, low-centered `icon.png`). Only the asset's padding + one comment change.

### 4.2 Target

- Apple grid: artwork **824 / 1024 = 80.5%**, **100px transparent margin each side**, centered.
- Source the artwork from the current full-bleed squircle, scaled down — not from `icon.png`.

### 4.3 Method (idempotent + respects the asset-source rule)

1. **Preserve the source first** (AGENTS.md: edit release assets only after copying into `assets/source/`): copy the *current* full-bleed `assets/dock-icon.png` → `assets/source/dock-icon-fullbleed.png`.
2. Generate the shipped icon **from the preserved source** (so reruns are idempotent — never read-and-overwrite the same file):
   ```python
   from PIL import Image
   src = Image.open("assets/source/dock-icon-fullbleed.png").convert("RGBA")  # preserved full-bleed source
   TARGET, CANVAS = 824, 1024
   scaled = src.resize((TARGET, TARGET), Image.LANCZOS)
   canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
   off = (CANVAS - TARGET) // 2                                # = 100px margins
   canvas.paste(scaled, (off, off), scaled)
   canvas.save("assets/dock-icon.png")
   ```
3. Update the now-stale comment at `src/main.js:3222` ("fills the canvas") → e.g. "padded to the macOS icon grid (~80.5%) so the Dock tile matches neighbor apps."

### 4.4 Test plan

- `npm start` on macOS → compare Clawd's Dock tile against Notes / WeChat / Claude. Should sit on the same baseline.
- Check at multiple Dock sizes + magnification on/off. **Finalize the % by an on-device Dock screenshot** — 80.5% is the starting point, not gospel; tune `TARGET` (~840–860 if it still reads small).

### 4.5 Notes

- New asset is perfectly centered (100px all sides) → does not inherit `icon.png`'s low-centering.
- `assets/icon.png` (build/dmg, 72.6%) is independently small — **out of scope**, flag for a future cross-surface pass (Finder/dmg/About), don't fix here.
- **Regression guard (recommended):** assert `dock-icon.png`'s non-transparent bbox is **not** 100% of the canvas, so a future hand-edit can't silently revert to full-bleed. Caveat: `npm test` runs in plain Node (no PIL / image lib in deps) — implement either as a small committed build/CI script using Python PIL (already used to generate the asset) or a tiny no-dep PNG alpha-edge check, not a standard `node:test` case unless a decoder is added.

### 4.6 Files touched (Part B)

- `assets/source/dock-icon-fullbleed.png` — new preserved source.
- `assets/dock-icon.png` — regenerated.
- `src/main.js:3222` — comment only.

---

## 5. Sequencing

Per owner direction ("一样样做"): land **Part B first** (isolated, instantly verifiable) — but include the source-preservation + comment fix. Then **Part A**, gated on the §3.2 probe choosing Path 1 vs Path 2. Separate commits even on one branch so each reviews/reverts independently.

## 6. Open questions

1. **Probe result** (§3.2) — **RESOLVED 2026-06-04 → Path 1.** Confirmed on this machine: under `canHide:NO`, a by-pid Hide flips `app.isHidden()` true (windows stay visible), restore flips it false, and no `did-resign-active` fires → poll `app.isHidden()`, keep `canHide:NO`, drive the pet via `setPetHidden`. Part A is unblocked.
2. **UX restore policy** (§3.5) — **DECIDED:** Dock-tile click restores even a manual tray hide.
3. **Final Dock icon %** (§4.4) — **DECIDED:** ship 80.5% / 824px first; only tune up to 840–860 if an on-device Dock screenshot reads small. Do not pre-enlarge.

---

## 7. As-built notes (2026-06-04)

**Part A — Path 1 (poll `app.isHidden()`, keep `canHide:NO`):**
- `src/mac-hide.js` (new) — `createMacHideController`: ~250ms `app.isHidden()` change watcher (unref'd); `hiddenByOsHide` ownership; `onActivate` (unhide if app-hidden, else restore a manual hide when Dock visible); `applyWithMiniRetry` (retries a mini-deferred hide up to ~60s, cancellable + unref'd, warns instead of silently swallowing on exhaust); `noteManualChange`/`stop` cancel pending retries.
- `src/pet-window-runtime.js` — `togglePetVisibility` → idempotent `setPetHidden(hidden)` returning `{applied,deferred,changed}` + thin wrapper; exported.
- `src/main.js` — require + `macHideController` created/started in `whenReady` under `isMac` + `app.on("activate")`; `prepManualPetVisibility()` (release OS-hide ownership + `app.show()` if app-hidden) shared by `togglePetVisibility()` and `bringPetToPrimaryDisplay()`; `macHideController.stop()` in before-quit; `showDock` mirror clears the flag.

**Part B — Dock icon:** `assets/dock-icon.png` regenerated to 80.5% (824/1024, 100px margins) from the preserved full-bleed source `assets/source/dock-icon-fullbleed.png`; runtime `app.dock.setIcon` override kept; comment updated.

**Tests:** `test/mac-hide.test.js` (controller incl. retry-cancel / opposite-state / start-hidden / stop); `setPetHidden` contract cases in `test/pet-window-runtime.test.js`; full-bleed-regression bbox check (no-dep PNG decoder) in `test/main-mac-dock-icon.test.js`. Related suite 38/38; live-verified on macOS (osascript Hide→pet hides, Show→returns; icon size matches neighbors).

**Review:** two Codex implementation passes → Go. All three blockers closed (retry-cancel, retry-cap+warn, `bringPetToPrimaryDisplay` bypass). Deferred as optional, non-blocking: an active poll right after `onActivate`'s `app.show()` for snappier restore; the ~250ms window where a manual hide immediately after an OS hide could be mis-attributed (practically unreachable).
