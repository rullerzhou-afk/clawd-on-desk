"use strict";

const createPetGeometryMain = require("./pet-geometry-main");
const {
  computeLooseClamp,
  getDisplayInsets,
  findMatchingDisplay,
  isPointInAnyWorkArea,
  SYNTHETIC_WORK_AREA,
} = require("./work-area");
const {
  getThemeMarginBox,
  computeStableVisibleContentMargins,
  getLooseDragMargins,
  getRestClampMargins,
} = require("./visible-margins");
const {
  createDragSnapshot,
  computeAnchoredDragBounds,
  computeFinalDragBounds: computeFinalDragBoundsRaw,
  needsFinalClampAdjustment: needsFinalClampAdjustmentRaw,
  materializeVirtualBounds: materializeVirtualBoundsRaw,
} = require("./drag-position");
const { resolveHorizontalEdgeContext } = require("./display-edge");
const { classifyCloakState } = require("./win-cloak-recovery");

const noop = () => {};
const DEFAULT_CRASH_RELOAD_LIMIT = 5;
const DEFAULT_CRASH_RELOAD_WINDOW_MS = 30_000;
const NON_RELOADABLE_RENDER_GONE_REASONS = new Set([
  "clean-exit",
  "killed",
  "integrity-failure",
  "launch-failed",
]);

// Issue #690 GNOME/XWayland edge-virtualization constants — plan §4.3.
// RECONCILE_QUIET_MS: debounce window for the native move/resize -> reconcile
// path. SETTLE_MS: bounded grace period after a write before an unexplained
// actual/expected mismatch stops being treated as "still settling"; must stay
// >= 3x RECONCILE_QUIET_MS to cover one WM round trip plus one debounce.
// HIT_QUIET_MS: the hit window's independent (longer) quiet period, so we
// don't fight a Mutter interactive grab.
const RECONCILE_QUIET_MS = 100;
const SETTLE_MS = 400;
const HIT_QUIET_MS = 250;

// I5: below this width/height the hit rect is degenerate (menu mini-entry's
// fully-offscreen preload stage, or a 1-5px transition sliver) — don't try to
// write a sliver BrowserWindow, suppress input instead (plan §3 I5).
const HIT_MIN_PX = 8;

function isLiveWindow(win) {
  return !!(win && typeof win.isDestroyed === "function" && !win.isDestroyed());
}

function getRenderGoneReason(details) {
  return details && typeof details.reason === "string" ? details.reason : "unknown";
}

function createRenderProcessGoneReloadGuard(options = {}) {
  const crashReloadLimit = Number.isFinite(options.crashReloadLimit)
    ? Math.max(0, Math.floor(options.crashReloadLimit))
    : DEFAULT_CRASH_RELOAD_LIMIT;
  const crashReloadWindowMs = Number.isFinite(options.crashReloadWindowMs)
    ? Math.max(0, options.crashReloadWindowMs)
    : DEFAULT_CRASH_RELOAD_WINDOW_MS;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const log = typeof options.crashReloadLog === "function"
    ? options.crashReloadLog
    : (message) => console.warn(message);
  const reloadsByKey = new Map();

  return function shouldReloadAfterRenderProcessGone(crashKey, details) {
    const key = crashKey || "default";
    const reason = getRenderGoneReason(details);
    if (NON_RELOADABLE_RENDER_GONE_REASONS.has(reason)) {
      log(`Clawd: not reloading ${key} after render-process-gone (${reason})`);
      return false;
    }

    const ts = Number(now());
    const cutoff = ts - crashReloadWindowMs;
    const recent = (reloadsByKey.get(key) || []).filter((value) => value >= cutoff);
    if (recent.length >= crashReloadLimit) {
      log(`Clawd: stopped reloading ${key} after ${recent.length} crashes in ${crashReloadWindowMs}ms`);
      reloadsByKey.set(key, recent);
      return false;
    }

    recent.push(ts);
    reloadsByKey.set(key, recent);
    return true;
  };
}

function reloadWindowWebContents(win) {
  try {
    if (!isLiveWindow(win)) return false;
    const contents = win.webContents;
    if (!contents) return false;
    if (typeof contents.isDestroyed === "function" && contents.isDestroyed()) return false;
    if (typeof contents.reload !== "function") return false;
    contents.reload();
    return true;
  } catch {
    return false;
  }
}

function createPetWindowRuntime(options = {}) {
  const screen = options.screen || {};
  const isWin = !!options.isWin;
  const isMac = !!options.isMac;
  const isLinux = !!options.isLinux;
  const linuxWindowType = options.linuxWindowType;
  const topmostLevel = options.topmostLevel;
  const getRenderWindow = options.getRenderWindow || (() => null);
  const getHitWindow = options.getHitWindow || (() => null);
  const getSettingsWindow = options.getSettingsWindow || (() => null);
  const getPrimaryWorkAreaSafe = options.getPrimaryWorkAreaSafe || (() => null);
  const getNearestWorkArea = options.getNearestWorkArea || (() => getPrimaryWorkAreaSafe() || SYNTHETIC_WORK_AREA);
  const getActiveTheme = options.getActiveTheme || (() => null);
  const getCurrentState = options.getCurrentState || (() => null);
  const getCurrentSvg = options.getCurrentSvg || (() => null);
  const getCurrentHitBox = options.getCurrentHitBox || (() => null);
  const getDisplayedVisual = options.getDisplayedVisual || (() => null);
  const getCurrentAccessoryPayloads = options.getCurrentAccessoryPayloads
    || (() => ({ head: options.getCurrentAccessoryPayload ? options.getCurrentAccessoryPayload() : null }));
  const getAccessoryMirrored = options.getAccessoryMirrored || (() => false);
  const getMiniMode = options.getMiniMode || (() => false);
  const getMiniTransitioning = options.getMiniTransitioning || (() => false);
  const getMiniContainedSeam = options.getMiniContainedSeam || (() => null);
  const getMiniPeekOffset = options.getMiniPeekOffset || (() => 0);
  const getCurrentPixelSize = options.getCurrentPixelSize || (() => null);
  const getEffectiveCurrentPixelSize = options.getEffectiveCurrentPixelSize || getCurrentPixelSize;
  const getAllowEdgePinning = options.getAllowEdgePinning || (() => false);
  const sendToRenderer = options.sendToRenderer || noop;
  const keepOutOfTaskbar = options.keepOutOfTaskbar || noop;
  const repositionSessionHud = options.repositionSessionHud || noop;
  const repositionAnchoredSurfaces = options.repositionAnchoredSurfaces || noop;
  const repositionFloatingBubbles = options.repositionFloatingBubbles || noop;
  const showFloatingSurfacesForPet = options.showFloatingSurfacesForPet || noop;
  const hideFloatingSurfacesForPet = options.hideFloatingSurfacesForPet || noop;
  const setFloatingSurfacesFullscreenSuppressed = options.setFloatingSurfacesFullscreenSuppressed || noop;
  // #935: every manual show (setPetHidden(false)) reports user intent here so
  // topmost-runtime's fullscreen auto-hide sync can latch its override — even
  // when the show lands as a visible no-op (a stale menu item clicked after
  // the sync already auto-restored the pet).
  const noteManualPetShow = options.noteManualPetShow || noop;
  const syncSessionHudVisibilityAndBubbles = options.syncSessionHudVisibilityAndBubbles || noop;
  const syncPermissionShortcuts = options.syncPermissionShortcuts || noop;
  const buildTrayMenu = options.buildTrayMenu || noop;
  const buildContextMenu = options.buildContextMenu || noop;
  const reapplyMacVisibility = options.reapplyMacVisibility || noop;
  // #640: re-run the editing-overlap dodge whenever the hit geometry syncs —
  // the hitbox can change without the window moving (state switches between
  // hitboxes, theme reload), which changes the overlap answer.
  const syncImeEditingPetDodge = options.syncImeEditingPetDodge || noop;
  const reassertWinTopmost = options.reassertWinTopmost || noop;
  const scheduleHwndRecovery = options.scheduleHwndRecovery || noop;
  // #525: DWM cloak probe + un-cloak primitives (win-cloak-recovery.js).
  // Absent/unavailable inspector degrades every cloak path to a no-op.
  const cloakInspector = options.cloakInspector || null;
  const isMiniAnimating = options.isMiniAnimating || (() => false);
  // Issue #690 plan §4.3.10's fourth protection period. roam.js's per-frame
  // applyPetWindowBounds() (ROAM_FRAME_MS=16) is a continuous native-write
  // period reconcile must not fight, exactly like drag/mini/Settings preview.
  const isRoamAnimating = options.isRoamAnimating || (() => false);
  const now = options.now || (() => Date.now());
  // Injectable so reconcile's timers (quiet/sweep/hit-quiet/hit-confirm) can
  // be driven by a fake clock in tests instead of a real wall-clock sleep —
  // production constants (RECONCILE_QUIET_MS/SETTLE_MS/HIT_QUIET_MS) stay
  // real, tests advance a fake `now`/timer queue together instead of shrinking
  // the thresholds (a shrunk threshold proves nothing about production
  // timing).
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  const isNearWorkAreaEdge = options.isNearWorkAreaEdge || (() => false);
  // Low-noise diagnostics for the I2 offset legal-domain backstop and the
  // assertNoYOffset guard (plan §3 I2, §4.3.2). Production logging is opt-in
  // exactly as plan §8 specifies: ordinary `npm start` must not turn expected
  // native-window reconciliation into warning spam. Tests and diagnostics can
  // still inject edgeLog directly and therefore do not depend on process env.
  const edgeLog = options.edgeLog || ((message) => {
    if (process.env.CLAWD_WINDOW_DEBUG === "1") console.warn(message);
  });
  // Phase 2 item 8's escape hatch (plan §4.3 point 12 / §11.11). A live
  // function (not a value captured once) so tests can flip it and so a
  // real CLAWD_DISABLE_EDGE_VIRTUALIZATION env change take effect without a
  // restart being architecturally required, matching how isLinux/isWin etc.
  // are otherwise treated as fixed per-process facts but env vars are not.
  const isEdgeVirtualizationDisabled = options.isEdgeVirtualizationDisabled
    || (() => process.env.CLAWD_DISABLE_EDGE_VIRTUALIZATION === "1");
  const flushRuntimeStateToPrefs = options.flushRuntimeStateToPrefs || noop;
  const handleMiniDisplayChange = options.handleMiniDisplayChange || noop;
  // Issue #690 plan §4.5 point 4.5-4: handleDisplayMetricsChanged() must hand
  // a mid-transition topology change to mini.js instead of silently dropping
  // it (see the call site below).
  const notifyMiniTopologyChangedDuringTransition =
    options.notifyMiniTopologyChangedDuringTransition || noop;
  const exitMiniMode = options.exitMiniMode || noop;
  const shouldReloadAfterRenderProcessGone = createRenderProcessGoneReloadGuard(options);

  function reloadRuntimeWindowWebContents(win, reloadOptions = {}) {
    if (
      reloadOptions
      && reloadOptions.crashKey
      && !shouldReloadAfterRenderProcessGone(reloadOptions.crashKey, reloadOptions.details)
    ) {
      return false;
    }
    return reloadWindowWebContents(win);
  }

  const petGeometryMain = createPetGeometryMain({
    getActiveTheme,
    getDisplayedVisual,
    getCurrentState,
    getCurrentSvg,
    getCurrentHitBox,
    getCurrentAccessoryPayloads,
    getAccessoryMirrored,
    getMiniMode,
    getMiniPeekOffset,
  });

  let viewportOffsetY = 0;
  // Issue #690 X-offset / logical-physical mapping state (plan §4.3 point 2).
  // lastLogicalBounds is the storage quantity I1/I2 make authoritative: only
  // its x/y are ever read back (width/height are recorded for log parity but
  // never consumed — §3 I2).
  let viewportOffsetX = 0;
  let lastLogicalBounds = null;
  // PR #751 Codex review #2 (rework batch A-2): everything a later reconcile
  // pass needs to judge THIS write's outcome, frozen at write time instead of
  // recomputed fresh at reconcile time (which could disagree with what was
  // actually used to materialize the write if state — most importantly the
  // observedClampInsets table — changed in between). Shape once set:
  //   physical: the physical rect requested by this write (was expectedPhysical)
  //   workArea: the workArea materialized against (was lastResolvedWorkArea)
  //   gen: writeGen's value at this write
  //   clampBounds: resolveHorizontalClampBounds()'s return for this write
  //     ({ leftBound, rightBound, displayId })
  //   displayId: clampBounds.displayId, hoisted for convenience
  //   xEligibleLeft / xEligibleRight: whether that side's bound is non-null —
  //     i.e. whether THIS write happened in a context (Linux, escape hatch
  //     off, outer workArea edge) where an X clamp could have explained a
  //     later mismatch at all (rework batch A-4's eligibility gate).
  let expectedWrite = null;
  let writeGen = 0;
  let settleUntil = 0;
  let lastWriteAt = 0; // now() at the most recent applyPetWindowBounds() write — diagnostics only (sinceWriteMs)
  // PR #751 Codex second-review C-1 (replaces rework batch A-1's
  // sawUnexplainedMismatch, now retired — see below): true once a native
  // move/resize event has actually arrived for THIS write generation.
  // Codex's B1 counter-example broke sawUnexplainedMismatch's proxy
  // ("a quiet point saw an unexplainable mismatch" standing in for "an event
  // happened"): a burst of CONSECUTIVE external-move events, each landing
  // and resetting scheduleReconcile()'s quiet timer before the previous one
  // could ever fire, means quiet-point classification never runs at all
  // during the burst — sawUnexplainedMismatch stays false even though real
  // events kept happening — so when the settle sweep (armed independently at
  // write time, on its own SETTLE_MS timer that a quiet-point restart cannot
  // touch) finally fires first, (b3) misread "no quiet point ever flagged
  // this" as "nothing ever moved" and blind-adopted a genuine external move.
  // nativeEventSeenThisGen tracks the true fact directly instead of via that
  // proxy: set unconditionally by onNativeGeometryEvent() (regardless of
  // protection-period state — see that function's own comment), cleared by
  // applyPetWindowBounds() on every fresh write (a new generation has seen
  // no events yet).
  //
  // Self-writeback echo lifecycle: our own setBounds() may set this bit
  // asynchronously after a write. Branches (a) and (b1) consume it once the
  // observed rect is fully explained (exact or clamp-adjusted match), and a
  // fresh write clears it. The bit therefore survives only while native
  // evidence remains unexplained, including burst/protection debt that a
  // later settle sweep must reconcile.
  let nativeEventSeenThisGen = false;
  const loggedEdgeReasons = new Set();

  // §4.3.9-13 render-side deferred reconcile state.
  let reconcileTimer = null;     // debounced quiet-point timer (RECONCILE_QUIET_MS)
  let sweepTimer = null;         // one-shot settle-sweep timer (SETTLE_MS)
  let sweepGen = -1;             // generation the pending sweepTimer belongs to
  let deferredSweepGen = -1;     // one-shot: a sweep landed during a protection period for this gen
  let reconcileDirty = false;    // a native geometry event arrived during a protection period

  // §4.3.14 observedClampInset: Map<"displayId:edge", insetPx>. Not persisted
  // (I7) — relearned every process lifetime, per edge.
  const observedClampInsets = new Map();
  // PR #751 Codex review #3 (rework batch A-3): a clamp-explainable candidate
  // must be observed TWICE in a row with the identical (displayId, edge,
  // inset) before it's actually written to observedClampInsets — a single
  // external move that happens to land on a workArea edge (a one-off event,
  // not a real WM-boundary fact) would otherwise permanently pollute the
  // learned inset from ONE observation. See maybeLearnInset() below.
  //
  // PR #751 second-review C-4 (Codex B4): { displayId, edge, inset, writeGen,
  // displaysGen } | null — writeGen and displaysGen (this file's own
  // displaysCacheGeneration, PR #751 B-5) are stamped at candidate CREATION
  // time. See maybeLearnInset() for how displaysGen gates confirmation
  // (writeGen is recorded too, per the coordinator's spec, but deliberately
  // NOT gated on — see that function's own comment for why).
  let pendingInsetCandidate = null;

  // §4.3.11 hit-side reconcile state — deliberately separate from the render
  // fields above; hit has its own quiet period (HIT_QUIET_MS), its own
  // "requested" rect, and (per this batch's P1-4 scope) only an adopt-clamp
  // action plus a conservative grab-candidate log, never a rebase/follow.
  let lastRequestedHitRect = null;
  let lastHitWorkArea = null;
  // PR #751 Codex review #2 (rework batch A-2, hit-side symmetric fix):
  // resolveClampAwareBounds(lastHitWorkArea)'s result AT THE MOMENT
  // syncHitWin() wrote lastRequestedHitRect — runHitReconcile() must judge
  // against what was true then, not recompute fresh (which could disagree if
  // the inset table changed in between, e.g. clearObservedClampInsets()).
  let lastHitClampBounds = null;
  let hitQuietTimer = null;
  let hitConfirmTimer = null;    // explicit re-check for the two-level grab judgment (§4.3.11 public premise 3)
  let hitLastObservedActual = null;
  let hitStableCount = 0;
  let hitRetriedRect = null;     // the target we've already spent our one WM-clamp retry on
  let hitGeometryDrift = null;   // diagnostic: last adopt-clamp drift on the hit side
  // PR #751 Codex review #6 (rework batch B-3): { derived, actual } — the
  // derived target that led to runHitReconcile()'s last adopted (WM-clamped)
  // outcome, and what actually got adopted for it. syncHitWin() checks this
  // BEFORE deciding whether to write: if the freshly re-derived target
  // matches `derived` again (the pet hasn't moved), the adopted `actual` is
  // kept as settled fact instead of re-initiating a write to the
  // already-once-rejected derived value — which would otherwise flip-flop
  // forever (write derived -> WM clamps -> adopt -> next sync re-derives the
  // same target -> write derived again -> ...).
  let lastAdoptedHitOutcome = null;

  // I5 applyHitInputState() single-writer state.
  let hitGeometrySuppressed = false;
  let settingsSizePreviewIgnoringHit = false;
  let imeEditingPetDodge = false;
  let hitInputIgnoreApplied = null; // null = never explicitly applied yet

  let petHidden = false;
  // #935: second visibility layer under topmost-runtime's fullscreen auto-hide
  // sync. Runtime-only (never persisted — a crash while auto-hidden must not
  // strand the pet invisible on relaunch). Effective visibility is
  // petHidden || fullscreenAutoHidden; the manual flag stays the user's.
  let fullscreenAutoHidden = false;
  let dragLocked = false;
  let dragSnapshot = null;
  let hitShapeWidth = 0;
  let hitShapeHeight = 0;
  let settingsSizePreviewSyncFrozen = false;
  const themeMarginEnvelopeCache = new Map();

  function getPrimaryWorkAreaFallback() {
    return getPrimaryWorkAreaSafe() || SYNTHETIC_WORK_AREA;
  }

  // PR #751 Codex review #10 (rework batch B-5): generation-cached wrapper
  // around screen.getAllDisplays(). Every internal caller here
  // (resolveEdgeContextForBounds, findDisplayIdForPoint,
  // getAttachedMiniWorkArea-equivalent lookups, etc.) used to trigger a
  // fresh native enumeration on every call — including once per mini
  // animation FRAME via materializeVirtualBounds() ->
  // resolveHorizontalClampBounds() -> findDisplayIdForPoint(), which is
  // unconditional (not gated by whether the caller already supplied an
  // edgeContext) — so mini.js's Phase 3 "cache topology once per animation"
  // optimization (threading a pre-resolved edgeContext through animCtx)
  // never actually capped the true underlying enumeration count. The cache
  // is invalidated (generation bump) only by a real topology change —
  // handleDisplayAdded()/handleDisplayRemoved()/handleDisplayMetricsChanged()
  // below — so it stays valid across an entire mini transition's frames,
  // collapsing dozens of per-frame native calls down to at most one.
  let displaysCacheGeneration = 0;
  let cachedDisplays = null;
  let cachedDisplaysGeneration = -1;

  function invalidateDisplaysCache() {
    displaysCacheGeneration += 1;
  }

  function getAllDisplays() {
    if (cachedDisplaysGeneration === displaysCacheGeneration && cachedDisplays) {
      return cachedDisplays;
    }
    cachedDisplays = typeof screen.getAllDisplays === "function" ? screen.getAllDisplays() : [];
    cachedDisplaysGeneration = displaysCacheGeneration;
    return cachedDisplays;
  }

  function getCursorScreenPoint() {
    return typeof screen.getCursorScreenPoint === "function"
      ? screen.getCursorScreenPoint()
      : null;
  }

  function getDisplayNearestPoint(cx, cy) {
    const point = { x: Math.round(cx), y: Math.round(cy) };
    try {
      if (typeof screen.getDisplayNearestPoint === "function") {
        return screen.getDisplayNearestPoint(point) || null;
      }
    } catch {}
    return null;
  }

  function getPrimaryDisplaySafe() {
    try {
      return typeof screen.getPrimaryDisplay === "function"
        ? (screen.getPrimaryDisplay() || null)
        : null;
    } catch {
      return null;
    }
  }

  function getDisplayForInsets(cx, cy) {
    let display = getDisplayNearestPoint(cx, cy);
    if (!display || !display.bounds || !display.workArea) {
      display = getPrimaryDisplaySafe();
    }
    return display;
  }

  function getNearestDisplayBottomInset(cx, cy) {
    const display = getDisplayForInsets(cx, cy);
    return getDisplayInsets(display).bottom;
  }

  function getNearestDisplayPhysicalBounds(cx, cy) {
    // Do not fall back to primary here: callers may be mapping a forced
    // secondary work area (mini exit). A failed lookup must preserve that
    // work area, never jump the pet to another display.
    const display = getDisplayNearestPoint(cx, cy);
    return display && isValidWorkArea(display.bounds) ? display.bounds : null;
  }

  function getPrimaryDisplayPhysicalBounds() {
    const display = getPrimaryDisplaySafe();
    return display && isValidWorkArea(display.bounds) ? display.bounds : null;
  }

  function projectDisplaysToPhysicalBounds(displays) {
    if (!Array.isArray(displays)) return displays;
    return displays.map((display) => {
      if (!display || !isValidWorkArea(display.bounds)) return display;
      return { ...display, workArea: display.bounds };
    });
  }

  function hasCompletePhysicalDisplayTopology(displays, primaryBounds) {
    if (!Array.isArray(displays) || displays.length === 0) return !!primaryBounds;
    return displays.every((display) => display && isValidWorkArea(display.bounds));
  }

  function getClampDisplaysSafe() {
    let rawDisplays;
    try {
      rawDisplays = getAllDisplays();
    } catch {
      return { displays: [], physicalTopologyComplete: false };
    }
    if (!Array.isArray(rawDisplays)) {
      return { displays: [], physicalTopologyComplete: false };
    }
    const displays = rawDisplays.filter(
      (display) => display && isValidWorkArea(display.workArea)
    );
    return {
      displays,
      physicalTopologyComplete: displays.length === rawDisplays.length,
    };
  }

  function setViewportOffsetY(offsetY) {
    const next = Number.isFinite(offsetY) ? Math.max(0, Math.round(offsetY)) : 0;
    if (next === viewportOffsetY) return;
    viewportOffsetY = next;
    sendToRenderer("viewport-offset", viewportOffsetY);
  }

  function getViewportOffsetY() {
    return viewportOffsetY;
  }

  // Signed X counterpart to setViewportOffsetY/getViewportOffsetY (plan §4.3
  // point 1). Unlike Y, X is never clamped to >= 0 here — I2 defines its
  // legal domain as the open interval (-width, +width), enforced by the
  // caller (see guardOffsetXLegalDomain below) because only the caller knows
  // the window width at the moment of the write.
  function setViewportOffsetX(offsetX) {
    const next = Number.isFinite(offsetX) ? Math.round(offsetX) : 0;
    if (next === viewportOffsetX) return;
    viewportOffsetX = next;
    sendToRenderer("viewport-offset-x", viewportOffsetX);
  }

  function getViewportOffsetX() {
    return viewportOffsetX;
  }

  // PR #751 Codex review #11 (rework batch B-6): consolidates
  // did-finish-load's two separate sendToRenderer("viewport-offset"/"-x")
  // calls into one. setViewportOffsetY/X() above both short-circuit when the
  // new value equals the current one, so a reload landing after a value was
  // already adopted (the common case) would otherwise never get an explicit
  // resend — the renderer's in-memory state was just wiped by the reload and
  // has no other way to learn the current value. Y is always resent
  // unconditionally (old main.js behavior: it always sent Y, even at 0). X is
  // only resent when non-zero: on Windows/macOS, and on Linux away from an
  // outer edge, viewportOffsetX is always 0, so unconditionally resending it
  // on every single reload would just be IPC noise the renderer never needs;
  // genuine non-zero Linux edge-virtualization offsets still get resent.
  function resendViewportOffsets() {
    sendToRenderer("viewport-offset", viewportOffsetY);
    if (viewportOffsetX !== 0) {
      sendToRenderer("viewport-offset-x", viewportOffsetX);
    }
  }

  function logEdgeOnce(reason, detail) {
    if (loggedEdgeReasons.has(reason)) return;
    loggedEdgeReasons.add(reason);
    edgeLog(`Clawd: edge-${reason} ${detail}`);
  }

  function clearLoggedEdgeReason(reason) {
    loggedEdgeReasons.delete(reason);
  }

  // getPetWindowBounds()'s null-on-dead-window contract is load-bearing and
  // MUST NOT change: src/roam.js:104-105, src/tick.js:236-238 and
  // src/pet-interaction-ipc.js:121-124 all depend on this null to no-op
  // gracefully. Topology re-materialization also treats this null as a no-op
  // instead of trying to recover geometry from a dead render window.
  //
  // Position now comes from the stored logical bounds (I1/I2): once
  // applyPetWindowBounds() has adopted a target, that target — not whatever
  // the live physical window has drifted to — is the position truth. Size is
  // never virtualized, so it always comes from the live window (plan §3 I2:
  // "位置" is a storage quantity, "尺寸" is not).
  function getPetWindowBounds() {
    const win = getRenderWindow();
    if (!isLiveWindow(win)) return null;
    const live = win.getBounds();
    if (!lastLogicalBounds) return { ...live }; // cold start / never adopted
    return {
      x: lastLogicalBounds.x,
      y: lastLogicalBounds.y,
      width: live.width,
      height: live.height,
    };
  }

  function resolveWorkAreaFor(bounds) {
    return bounds
      ? getNearestWorkArea(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      : null;
  }

  // Shared src/display-edge.js topology resolver (plan §4.1), scoped to a
  // single target rect. Only ever consulted on Linux — see
  // resolveHorizontalClampBounds below — so this never runs a displays
  // enumeration on Windows/macOS.
  function resolveEdgeContextForBounds(bounds, workArea) {
    if (!bounds || !isValidWorkArea(workArea)) return null;
    return resolveHorizontalEdgeContext({
      displays: getAllDisplays(),
      workArea,
      yMid: bounds.y + bounds.height / 2,
    });
  }

  // §4.3.14's observedClampInset is keyed by (displayId, edge). display-edge.js
  // (Phase 1, frozen — see its own module comment) doesn't expose a display-id
  // lookup, so this is a small local equivalent: whichever display's workArea
  // contains the point wins, mirroring display-edge.js's own findLocalDisplay.
  function findDisplayIdForPoint(cx, cy) {
    const displays = getAllDisplays();
    if (!Array.isArray(displays)) return null;
    for (const d of displays) {
      if (!d || !d.workArea) continue;
      const wa = d.workArea;
      if (cx >= wa.x && cx <= wa.x + wa.width && cy >= wa.y && cy <= wa.y + wa.height) {
        return Number.isFinite(d.id) ? d.id : null;
      }
    }
    return null;
  }

  function getObservedClampInset(displayId, edge) {
    if (displayId == null) return 0;
    const value = observedClampInsets.get(`${displayId}:${edge}`);
    return Number.isFinite(value) ? value : 0;
  }

  // §4.3.14: "每次学到的 inset 与旧值不同就记一条 inset-drift 日志" — this
  // fires on every change including the very first 0 -> N learn, not just
  // later drift, since the plan doesn't carve out an exception for the first
  // learn and the §6.3 "inset 自举" test only requires that the first learn
  // itself succeeds (not that it stay silent).
  function updateObservedClampInset(displayId, edge, inset) {
    if (displayId == null || !Number.isFinite(inset)) return;
    const key = `${displayId}:${edge}`;
    const prev = observedClampInsets.get(key);
    if (prev === inset) return;
    observedClampInsets.set(key, inset);
    edgeLog(`Clawd: inset-drift display=${displayId} edge=${edge} old=${Number.isFinite(prev) ? prev : 0} new=${inset}`);
  }

  // PR #751 Codex review #3 (rework batch A-3): the gate in front of
  // updateObservedClampInset() above. A single clamp-explainable observation
  // is not enough evidence to commit to the learned-inset table — it might
  // be a one-off external move that merely happens to land on a workArea
  // edge, not a real, stable fact about the WM's usable region. Only a
  // SECOND consecutive candidate with the identical (displayId, edge, inset)
  // actually gets written; any other candidate in between overwrites the
  // pending one instead of learning (so a fluke can't "vote" alongside a
  // later real one — the streak must be genuinely consecutive). This does
  // not affect acceptance (adopt-clamp) at all — whether a mismatch is
  // EXPLAINED as a clamp and whether it's LEARNED FROM stay two separate
  // questions, exactly as before.
  // PR #751 second-review C-4 (Codex B4): a pending candidate must also
  // still be judged against the SAME display topology it was first observed
  // under — displaysCacheGeneration (B-5) advances whenever
  // handleDisplayAdded/Removed/MetricsChanged runs (all three now also
  // clear this whole table — see those functions below), so a candidate
  // whose stamped displaysGen no longer matches the CURRENT generation is
  // stale: the same numeric inset re-appearing after a topology change is
  // coincidence, not confirmation, and must not be treated as the second
  // half of a genuine streak. A stale candidate is simply replaced by the
  // new observation (as its own fresh, unconfirmed pending candidate) —
  // same "overwrite, don't confirm" outcome as an ordinary non-matching
  // candidate.
  //
  // writeGen is ALSO stamped on the candidate (per the coordinator's spec)
  // but deliberately NOT gated on here: writeGen legitimately (and
  // necessarily) advances between every candidate and the write that goes
  // on to confirm it — they are, by construction, two separate
  // applyPetWindowBounds() calls (see the "inset self-bootstrap" test).
  // Gating confirmation on writeGen equality would reject every single
  // confirmation, including the ordinary two-write bootstrap this whole
  // mechanism exists to support — verified empirically before finalizing
  // this decision (a literal "any writeGen advance is stale" reading was
  // tried and it broke that existing, still-required-to-pass test). An
  // intervening write that itself produces an unexplainable mismatch
  // already clears pendingInsetCandidate directly (runReconcile()'s
  // (b2)/(b3)-rebase/(c) branches below) — that is the actual "did
  // something disruptive happen" signal for writes, kept separate from
  // topology's own signal here.
  function maybeLearnInset(displayId, clampObs) {
    if (!clampObs || clampObs.axis !== "x" || displayId == null) return;
    const candidate = {
      displayId, edge: clampObs.edge, inset: clampObs.inset,
      writeGen, displaysGen: displaysCacheGeneration,
    };
    const stale = !!pendingInsetCandidate && pendingInsetCandidate.displaysGen !== displaysCacheGeneration;
    if (
      !stale
      && pendingInsetCandidate
      && pendingInsetCandidate.displayId === candidate.displayId
      && pendingInsetCandidate.edge === candidate.edge
      && pendingInsetCandidate.inset === candidate.inset
    ) {
      updateObservedClampInset(candidate.displayId, candidate.edge, candidate.inset);
      pendingInsetCandidate = null;
    } else {
      pendingInsetCandidate = candidate;
    }
  }

  // Wired to display-metrics-changed's debounce handler (main.js) per §4.3.14:
  // "inset 只在同一 (displayId, edge) 内有效...里必须显式清空对应 display 的
  // 表项". Clearing the whole table on any topology-metrics event is a safe
  // superset — Electron doesn't cheaply tell us WHICH display changed from
  // this event alone, and re-learning an unchanged inset on the next clamp is
  // a harmless, self-healing cost (worst case: one extra "predicted != actual"
  // frame, never a correctness bug). Also clears any pending (unconfirmed)
  // inset candidate (A-3) — a topology change invalidates whatever streak was
  // building toward confirmation.
  function clearObservedClampInsets() {
    observedClampInsets.clear();
    pendingInsetCandidate = null;
  }

  // §4.2's leftBound/rightBound: null means "don't clamp that side". I3 is
  // enforced right here — Windows/macOS, the CLAWD_DISABLE_EDGE_VIRTUALIZATION
  // escape hatch (Phase 2 item 8, plan §4.3 point 12), and any edge the shared
  // helper reports as an internal seam all get { null, null }, which
  // reproduces byte-identical pre-#690 physical-overflow behavior via
  // materializeVirtualBoundsRaw()'s existing null-bound fast path.
  //
  // §4.3.14's inset narrows the predicted boundary so predicted physical
  // converges to actual physical instead of jumping "predicted -> measured"
  // after the fact (see runReconcile()'s adopt-clamp branch, which is the
  // only writer of observedClampInset). `displayId` is included in the
  // return value (PR #751 Codex review #2, rework batch A-2) purely so
  // applyPetWindowBounds() can fold it straight into expectedWrite's
  // snapshot without a second findDisplayIdForPoint() call.
  function resolveHorizontalClampBounds(bounds, workArea, providedEdgeContext) {
    if (!isLinux || isEdgeVirtualizationDisabled()) return { leftBound: null, rightBound: null, displayId: null };
    const edge = providedEdgeContext || resolveEdgeContextForBounds(bounds, workArea);
    if (!edge) return { leftBound: null, rightBound: null, displayId: null };
    const displayId = isValidWorkArea(workArea)
      ? findDisplayIdForPoint(workArea.x + workArea.width / 2, workArea.y + workArea.height / 2)
      : null;
    return {
      leftBound: edge.left.isOuterWorkAreaEdge
        ? edge.left.workAreaBoundary + getObservedClampInset(displayId, "left")
        : null,
      rightBound: edge.right.isOuterWorkAreaEdge
        ? edge.right.workAreaBoundary - getObservedClampInset(displayId, "right")
        : null,
      displayId,
    };
  }

  // Shared materializer (plan §4.2/§4.3 point 4: "resolveStartupPlacement()
  // ... 使用相同 materializer"). Both applyPetWindowBounds() and
  // resolveStartupPlacement() call this exact function so a Linux outer-edge
  // window can never be constructed off-screen and then reconciled — the
  // startup bounds are already correct on the first native write.
  function resolveMaterializationWorkArea(bounds, workArea, opts = {}) {
    const requestedWorkArea = isValidWorkArea(workArea)
      ? workArea
      : resolveWorkAreaFor(bounds);
    const allowEdgePinning = "allowEdgePinning" in opts
      ? !!opts.allowEdgePinning
      : getAllowEdgePinning();
    if (!isMac || !allowEdgePinning || getMiniMode()) return requestedWorkArea;

    const probeArea = isValidWorkArea(workArea) ? workArea : null;
    const probeX = probeArea
      ? probeArea.x + probeArea.width / 2
      : bounds.x + bounds.width / 2;
    const probeY = probeArea
      ? probeArea.y + probeArea.height / 2
      : bounds.y + bounds.height / 2;
    return getNearestDisplayPhysicalBounds(probeX, probeY) || requestedWorkArea;
  }

  function materializeVirtualBounds(bounds, workArea, opts = {}) {
    if (!bounds) return null;
    const resolvedWorkArea = resolveMaterializationWorkArea(bounds, workArea, opts);
    const clampBounds = resolveHorizontalClampBounds(bounds, resolvedWorkArea, opts.edgeContext);
    const raw = materializeVirtualBoundsRaw(bounds, resolvedWorkArea, clampBounds);
    if (!raw) return null;
    // PR #751 Codex review #2 (rework batch A-2): surface the workArea and
    // clampBounds this call actually resolved/used, purely additive to the
    // existing { bounds, viewportOffsetX, viewportOffsetY } shape — so
    // applyPetWindowBounds() can snapshot them into expectedWrite without
    // resolveHorizontalClampBounds() being called a second time.
    return { ...raw, workArea: resolvedWorkArea, clampBounds };
  }

  function sameRect(a, b) {
    return !!a && !!b
      && a.x === b.x && a.y === b.y
      && a.width === b.width && a.height === b.height;
  }

  // Electron's DIP <-> physical-pixel conversion can read a Windows window
  // back one DIP wider/taller than the exact rect just requested (commonly at
  // 125% display scale). This is not an external move: x/y are unchanged and
  // the native size differs by at most one. Rebasing such a readback into the
  // logical size makes the next write grow again (206 -> 207 -> 208) and also
  // sends the hit window through the external-grab candidate path.
  //
  // Keep this deliberately narrow: position differences are always real, a
  // size delta larger than one is still a resize, and Linux clamp evidence
  // continues to use exact rectangles.
  function isWindowsNativeSizeRounding(expected, actual) {
    if (!isWin || !expected || !actual) return false;
    const widthDelta = actual.width - expected.width;
    const heightDelta = actual.height - expected.height;
    return expected.x === actual.x
      && expected.y === actual.y
      && Math.abs(widthDelta) <= 1
      && Math.abs(heightDelta) <= 1
      && (widthDelta !== 0 || heightDelta !== 0);
  }

  // §4.3.2's recomputeOffsetsFrom: rederives both offsets from a known-good
  // (logical, actualPhysical) pair without going through materialize. Callers:
  // the I2 backstop below (with logical===actualPhysical, trivially valid,
  // see the comment there — `eligible` doesn't matter in that call since the
  // two rects are identical either way, so it passes false), and
  // runReconcile()'s adopt-clamp branches — the latter are REAL, unguarded
  // write points (§12.18: the legal-domain backstop must fire at every
  // offset write point, not just materialize's own result), since
  // lastLogicalBounds and actual there come from genuine reconciliation, not
  // a controlled reset. The rebase branch doesn't need its own guard here:
  // it always calls back through applyPetWindowBounds(), which already runs
  // guardOffsetXLegalDomain() on its own materialize result.
  //
  // `eligible` (PR #751 Codex review #4a, rework batch A-4): replaces the
  // former unconditional `isLinux && !isEdgeVirtualizationDisabled()` check.
  // The caller passes whether THIS write's own snapshot says an X clamp was
  // even possible (expectedWrite.xEligibleLeft || .xEligibleRight) — on a
  // Linux internal seam (both bounds null) `isLinux` alone used to be true
  // even though no clamp could legitimately explain anything there, letting
  // an adopt-clamp classification send a spurious non-zero X offset IPC (an
  // I3 violation: X offset must be exactly 0 off any Linux-outer-edge
  // context). Gating on the snapshot's own eligibility instead closes that.
  function recomputeOffsetsFrom(logical, actualPhysical, eligible) {
    const rawOffsetX = eligible ? (logical.x - actualPhysical.x) : 0;
    const width = actualPhysical.width;
    if (Number.isFinite(rawOffsetX) && width > 0 && Math.abs(rawOffsetX) < width) {
      setViewportOffsetX(rawOffsetX);
      clearLoggedEdgeReason("offset-out-of-range");
    } else {
      logEdgeOnce(
        "offset-out-of-range",
        `axis=x offsetX=${rawOffsetX} width=${width} expected=${JSON.stringify(actualPhysical)}`
      );
      lastLogicalBounds = { x: actualPhysical.x, y: actualPhysical.y };
      setViewportOffsetX(0);
      // PR #751 Codex review #7 (rework batch B-4): the hard-resync semantics
      // here is "logical follows physical, BOTH offsets zero" —
      // lastLogicalBounds was just reset to actualPhysical (Y included), so Y
      // offset must ALSO be zeroed, and this function must return here
      // instead of falling through to the unconditional Y computation below
      // (which would use the STALE `logical.y` parameter against the NEW
      // actualPhysical.y, reintroducing a non-zero Y offset this reset was
      // supposed to eliminate).
      setViewportOffsetY(0);
      return;
    }
    setViewportOffsetY(Math.max(0, actualPhysical.y - logical.y));
  }

  // §3 I2's legal-domain backstop for the one offset write point this batch
  // adds. #pet-container is a 100%-sized `overflow:hidden` box
  // (src/styles.css) — an |offsetX| that reaches the window width clips the
  // character out entirely with no visible affordance left to drag it back.
  // Refuse that value instead: log once, hard-resync lastLogicalBounds to the
  // physical rect we actually have, and zero both offsets so logical tracks
  // physical exactly. This is a rare backstop (a sane leftBound/rightBound
  // from resolveHorizontalClampBounds should never trigger it) — reconcile-
  // driven recomputes (adopt-clamp, rebase) will reuse it once a later batch
  // wires them up. Returns true when it fired (caller must skip the normal
  // setViewportOffsetX call in that case).
  function guardOffsetXLegalDomain(materialized) {
    const offsetX = materialized.viewportOffsetX;
    const width = materialized.bounds.width;
    if (Number.isFinite(offsetX) && width > 0 && Math.abs(offsetX) < width) {
      return false;
    }
    logEdgeOnce(
      "offset-out-of-range",
      `axis=x offsetX=${offsetX} width=${width} expected=${JSON.stringify(materialized.bounds)}`
    );
    recomputeOffsetsFrom(materialized.bounds, materialized.bounds, false); // logical===actual here; eligibility is moot
    lastLogicalBounds = { x: materialized.bounds.x, y: materialized.bounds.y };
    // I2 point 3: "触发一次 syncDerivedSurfaces()" — the backstop just moved
    // logical bounds without going through the normal apply path below, so
    // hit/HUD/anchored surfaces need an explicit nudge here too.
    syncDerivedSurfaces();
    return true;
  }

  // Unifies the hit/HUD/anchored-surface sync that must follow ANY change to
  // logical bounds, not just ones that produce a native move/resize event (I6:
  // "offset 变化也是窗口移动"). This is exactly the pre-existing
  // syncFloatingWindowsAfterPetBoundsChange() (settingsSizePreviewSyncFrozen
  // early-return included) — §4.3.9 explicitly calls for the ORIGINAL
  // win.on("move"/"resize") listener body to move here, not be duplicated.
  function syncDerivedSurfaces() {
    syncFloatingWindowsAfterPetBoundsChange();
  }

  // Low-noise diagnostic line for a reconcile action, matching the field set
  // in plan §8's example and named explicitly in §12.10: writeGen, settleState,
  // sinceWriteMs, and a predicted-actual delta. `extra` carries a reason= or
  // edge= suffix (e.g. "reason=no-event" for §4.3.13's sweep-with-no-event
  // adopt-clamp).
  function logReconcileEvent(windowLabel, predicted, actual, action, settleState, sinceWriteMs, extra) {
    const rectStr = (r) => (r ? `${r.x},${r.y},${r.width},${r.height}` : "n/a");
    const delta = predicted && actual
      ? `${actual.x - predicted.x},${actual.y - predicted.y},${actual.width - predicted.width},${actual.height - predicted.height}`
      : "n/a";
    edgeLog(
      `Clawd: edge-reconcile window=${windowLabel} predicted=${rectStr(predicted)} actual=${rectStr(actual)} `
      + `delta=${delta} writeGen=${writeGen} settleState=${settleState} sinceWriteMs=${sinceWriteMs} `
      + `action=${action}${extra ? ` ${extra}` : ""}`
    );
  }

  // §4.3.9: move/resize callbacks carry no geometry and must not read/write
  // anything themselves — their only job is to (re)schedule the debounced
  // quiet-point check. Shared by render move and resize alike.
  //
  // PR #751 second-review C-1: also records that a real event happened for
  // THIS generation, unconditionally — deliberately NOT gated on protection
  // state (dragLocked/mini/settings-preview/roam), so a burst of events
  // arriving entirely inside a still-protected window (or entirely between
  // two quiet-timer resets, never once reaching a quiet point) still leaves
  // true evidence behind for whatever reconcile pass eventually runs.
  function onNativeGeometryEvent() {
    nativeEventSeenThisGen = true;
    scheduleReconcile();
  }

  function scheduleReconcile() {
    if (reconcileTimer) clearTimeoutFn(reconcileTimer);
    reconcileTimer = setTimeoutFn(() => runReconcile("native-quiet"), RECONCILE_QUIET_MS);
  }

  // §4.3.13: every write also arms a bounded, generation-stamped sweep so an
  // actual/expected mismatch gets adopted even when no native move/resize
  // event ever arrives (e.g. Mutter's ConfigureNotify already matches what we
  // asked and nothing changes again). "New generation invalidates old sweep"
  // is enforced by both halves here: clearTimeout on re-entry AND the sweepGen
  // capture that runReconcile() checks against the CURRENT writeGen.
  function scheduleSettleSweep() {
    if (sweepTimer) clearTimeoutFn(sweepTimer);
    sweepGen = writeGen;
    sweepTimer = setTimeoutFn(() => {
      sweepTimer = null;
      runReconcile("settle-sweep", sweepGen);
    }, SETTLE_MS);
  }

  // §4.3.10's four protection periods (drag / mini transition+animation /
  // Settings size preview / roam) only ever mark reconcile dirty while
  // active — nothing re-triggers a check once the period ends unless the
  // period's own exit point calls this. It deliberately does not call
  // runReconcile() synchronously (a release is often immediately followed by
  // a fresh applyPetWindowBounds() — drag-end is exactly that — and a
  // synchronous reconcile here would read geometry that hasn't landed yet);
  // it just requeues the normal debounced quiet-point path.
  function releaseReconcileProtection() {
    if (!reconcileDirty && deferredSweepGen < 0) return;
    reconcileDirty = false;
    scheduleReconcile();
  }

  // The render half of §4.3.9-13's expected-write reconcile. Classifies
  // whatever the physical window actually is against what we last asked for,
  // entirely at a debounced quiet point — never inside a native event
  // callback (this function's own callers are always a setTimeout body).
  //
  // PR #751 Codex review #1/#2/#4a (rework batch A) + second-review C-1:
  // classification order —
  //   (a) sameRect -> accept (unchanged)
  //   (b1) clamp-explainable -> always adopt, regardless of time (unchanged)
  //   (b2) NOT explainable but still inside THIS write's own settle window ->
  //        DEFER (Codex #1): don't touch expected/offset/logical, just wait
  //        and re-check at the next quiet point. Settle is bounded
  //        (SETTLE_MS), so this can't defer forever — it eventually falls
  //        through to (b3)/(c). (b2) itself needs no "did an event happen"
  //        evidence: merely being called again with an unexplainable
  //        mismatch inside settle IS the re-check succeeding.
  //   (b3) NOT explainable, and the settle sweep (or an inherited deferred-
  //        sweep debt) is what's classifying -> rebase if a real native
  //        event was ever seen for this generation (nativeEventSeenThisGen —
  //        C-1, replacing A-1's sawUnexplainedMismatch proxy, which a burst
  //        of consecutive events landing between quiet-point restarts could
  //        leave permanently false even though real events kept happening —
  //        see nativeEventSeenThisGen's own comment for Codex's B1
  //        counter-example), otherwise adopt (the original "no-event" sweep
  //        fallback — §4.3.13 — nothing ever positively indicated a real
  //        move, so blind-adopt is still safe).
  //   (c) everything else -> rebase (unchanged)
  // (b1)/(b2)/(b3) are ALL gated on this write's own eligibility snapshot
  // (expectedWrite.xEligibleLeft || .xEligibleRight) — off that, only (a)
  // and (c) exist: physical is truth, exactly like non-Linux/escape-hatch/
  // Linux-internal-seam contexts always behaved pre-#690 (A-4).
  function runReconcile(reason = "native-quiet", gen = -1) {
    // Sweep entries must NOT blindly null reconcileTimer: a quiet timer that's
    // still legitimately counting down would become an orphan no one can
    // cancel via scheduleReconcile()'s clearTimeout.
    if (reason !== "settle-sweep") reconcileTimer = null;

    // Only the sweep whose generation still matches the current write (or a
    // deferred sweep resuming for that same generation) may consume settle.
    const fromSettleSweep =
      (reason === "settle-sweep" && gen === writeGen)
      || (deferredSweepGen === writeGen);

    // Protection-period judgment — must align with the plan's table exactly:
    // drag / mini transition+animation / Settings size preview / roam. Missing
    // any one of these means that period's continuous writes go unprotected.
    if (
      dragLocked
      || getMiniTransitioning()
      || isMiniAnimating()
      || settingsSizePreviewSyncFrozen
      || isRoamAnimating()
    ) {
      reconcileDirty = true;
      if (fromSettleSweep) deferredSweepGen = writeGen; // remember which generation is owed
      return;
    }
    deferredSweepGen = -1; // one-shot consumption, never sticky

    const win = getRenderWindow();
    if (!isLiveWindow(win) || !expectedWrite || !lastLogicalBounds) return;
    const actual = win.getBounds();
    if (fromSettleSweep) settleUntil = 0; // the only consumption point for this generation's settle

    const settleState = now() < settleUntil ? "active" : "expired";
    const sinceWriteMs = now() - lastWriteAt;
    const expected = expectedWrite.physical;

    // (a) our own write landed exactly as requested.
    //
    // PR #751 third-review D-1 (Codex #1, blocking): consumes
    // nativeEventSeenThisGen here. Codex's counter-example: gen1 writes,
    // gen2 writes (resetting the bit to false), then gen1's OWN native move
    // echo — real BrowserWindow geometry events are asynchronous, so it can
    // arrive AFTER gen2's write already started — lands late and sets the
    // bit true again, even though it says nothing about gen2's actual
    // position. A quiet point at this point sees actual === expected (a),
    // and — before this fix — returned without touching the bit, leaving it
    // "true" on stale, unrelated evidence. A LATER, genuinely event-less
    // silent WM reposition (no move event of its own at all) would then
    // reach the settle sweep with the bit still wrongly true, misreading
    // "no evidence for THIS mismatch" as "an event happened", and rebasing
    // a silent WM clamp into logical — a ratchet variant of the same class
    // C-1 fixed, just entering through (a) instead of the sweep path
    // directly.
    //
    // Semantics: confirming actual === expected at a quiet point means
    // whatever event(s) landed since the last write have been fully
    // explained as our own write settling (a self-writeback echo, per
    // nativeEventSeenThisGen's own comment) — that evidence is spent, not
    // carried forward to judge some LATER, unrelated mismatch. Coordinator
    // explicitly rejected Codex's own suggested alternative (binding the
    // bit to a specific expected write via some counted/matched echo
    // scheme): an off-by-one in that accounting would swallow a genuine
    // external event as if it were an echo, flipping the failure direction
    // from conservative (occasionally over-attributing evidence) to
    // dangerous (silently discarding real evidence of a real move).
    //
    // Residual window (theoretical floor, not fully closable without an
    // event source tag Electron doesn't provide): if gen1's echo arrives
    // even LATER than this exact quiet point — i.e., AFTER (a) has already
    // consumed whatever was true so far — and lands in the narrow gap
    // between this quiet point and whatever reconcile pass next observes
    // it, it can still re-arm the bit for a mismatch it doesn't actually
    // explain. This is the same fundamentally-irreducible ambiguity C-1's
    // own comment already names (a bare geometry event carries no
    // "which write do I belong to" marker) — narrowed by this fix from "any
    // stale echo, indefinitely" to "an echo landing inside one specific,
    // already-short window", not eliminated outright.
    if (sameRect(actual, expected)) {
      nativeEventSeenThisGen = false;
      syncDerivedSurfaces();
      return;
    }

    // A Windows-only native size-rounding readback is self-write evidence,
    // not a user/compositor move. Preserve the logical dimensions, accept the
    // measured physical rect for this write generation, and consume the
    // resize echo so a later mismatch cannot borrow it as external evidence.
    if (isWindowsNativeSizeRounding(expected, actual)) {
      expectedWrite = { ...expectedWrite, physical: { ...actual } };
      nativeEventSeenThisGen = false;
      syncDerivedSurfaces();
      return;
    }

    const xEligible = expectedWrite.xEligibleLeft || expectedWrite.xEligibleRight;
    const clampObs = xEligible
      ? deriveClampObservation(actual, expected, expectedWrite.workArea, expectedWrite.clampBounds)
      : null;

    // (b1) explainable as a clamp -> always adopt, regardless of time.
    if (clampObs !== null) {
      logReconcileEvent("render", expected, actual, "adopt-clamp", settleState, sinceWriteMs, `edge=${clampObs.edge}`);
      expectedWrite = { ...expectedWrite, physical: { ...actual } };
      recomputeOffsetsFrom(lastLogicalBounds, actual, xEligible);
      if (clampObs.axis === "x") maybeLearnInset(expectedWrite.displayId, clampObs);
      // The native evidence has now been fully explained by this clamp
      // observation. Do not let it authorize a later, unrelated silent
      // mismatch to rebase at the settle sweep (the same consumption rule
      // as branch (a), just with a clamp-adjusted expected rect).
      nativeEventSeenThisGen = false;
      syncDerivedSurfaces();
      return;
    }

    // (b2) not explainable, but still inside THIS write's own settle window:
    // defer instead of adopt (Codex #1). No flag to set here — see C-1's
    // nativeEventSeenThisGen comment for why the OLD sawUnexplainedMismatch
    // (set on this exact line, pre-C-1) was the wrong signal for (b3) to
    // consult.
    //
    // PR #751 second-review C-4 (Codex B4): an unexplainable mismatch just
    // appeared — the environment is no longer trusted enough to let an
    // in-flight inset candidate ride through to confirmation on its next
    // observation, even though this branch doesn't itself touch the
    // observed-inset table. Clearing it here is a superset, not a
    // discrimination — see maybeLearnInset()'s own comment for why this is
    // kept separate from that function's displaysGen check.
    if (xEligible && now() < settleUntil) {
      pendingInsetCandidate = null;
      scheduleReconcile();
      return;
    }

    // (b3) not explainable, and the settle sweep (or an inherited deferred-
    // sweep debt) is classifying: rebase if a real native event was ever
    // seen for this generation (C-1: nativeEventSeenThisGen); otherwise
    // adopt (nothing ever positively indicated a real move).
    if (xEligible && fromSettleSweep) {
      if (nativeEventSeenThisGen) {
        pendingInsetCandidate = null; // C-4: same reasoning as (b2) above
        logReconcileEvent("render", expected, actual, "rebase", settleState, sinceWriteMs, "reason=event-seen");
        applyPetWindowBounds({
          x: actual.x + viewportOffsetX,
          y: actual.y - viewportOffsetY,
          width: actual.width,
          height: actual.height,
        });
        syncDerivedSurfaces();
        return;
      }
      logReconcileEvent("render", expected, actual, "adopt-clamp", settleState, sinceWriteMs, "reason=no-event");
      expectedWrite = { ...expectedWrite, physical: { ...actual } };
      recomputeOffsetsFrom(lastLogicalBounds, actual, xEligible);
      syncDerivedSurfaces();
      return;
    }

    // (c) everything else (a real external move, or ANY mismatch at all in a
    // non-eligible context) — keep the current VISUAL position with the old
    // offset, then rebase logical bounds onto the new physical position.
    // The two axes use opposite-signed formulas by design (I2): X offset is
    // signed (logical - physical) so logical follows physical PLUS the old
    // offset; Y offset is a non-negative top-lift (physical - logical) so
    // logical follows physical MINUS the old offset. This is a historical
    // sign convention, not a typo, and must never be "unified".
    pendingInsetCandidate = null; // C-4: same reasoning as (b2) above
    logReconcileEvent("render", expected, actual, "rebase", settleState, sinceWriteMs, null);
    applyPetWindowBounds({
      x: actual.x + viewportOffsetX,
      y: actual.y - viewportOffsetY,
      width: actual.width,
      height: actual.height,
    });
    syncDerivedSurfaces();
  }

  // §4.3.10's clamp-explainability test — completely time-independent, and
  // shared by BOTH the render and (public premise 1, §4.3.11) hit reconcile
  // paths. Derives the CANDIDATE inset from actual by subtraction; never
  // compares actual against an already-known inset. The latter self-deadlocks
  // at inset=0: the boundary it would compare against is the un-narrowed one,
  // but a clamped window sits on the NARROWED boundary, so the check returns
  // false forever and the first non-zero inset is never learned.
  //
  // Deviation from the plan's literal pseudocode, verified necessary by
  // hand-tracing the plan's own §6.3 "inset 自举" numbers (logical X=1768,
  // width=203, wa.right=1920, Mutter mock inset=40): `expected` here is
  // always OUR OWN materialized prediction, which by construction already
  // satisfies `expected.right <= wa.right` (materialize never predicts past
  // the raw workArea) and equals wa.right EXACTLY whenever a clamp was
  // actually engaged (inset=0) or equals `wa.right - <the inset used>` once
  // any inset is already learned. Comparing `expected` against the RAW `wa`
  // boundary with `<=` therefore returns null in BOTH the very first
  // (bootstrap, inset=0) clamp and every subsequent "inset changed again"
  // clamp — i.e. it never fires for the exact scenarios it exists to detect
  // (confirmed by direct calculation, not just reasoning about it). The fix
  // compares against the boundary OUR OWN materializer actually clamped
  // against (`clampBounds`, reflecting whatever inset was current at
  // prediction time) with a STRICT inequality, so "expected sits exactly on
  // the boundary it was clamped to" reads as "genuinely overflowed", while a
  // position that only happens to be near an edge without ever being clamped
  // still falls through to null.
  //
  // PR #751 second-review C-2 (Codex B2): removed the old
  // `?? (wa.x + wa.width)` / `?? wa.x` raw-workArea fallback for a null
  // clampBounds side. That fallback was rework batch A-2's leftover from
  // when clampBounds was an optional parameter some callers didn't have —
  // both current callers now always pass their own write-time snapshot
  // (expectedWrite.clampBounds / lastHitClampBounds), so a null bound is
  // never "caller didn't supply one", it is the eligibility answer itself: a
  // seam, off-Linux, or escape-hatch context where THAT side was never
  // topologically able to clamp anything. Falling back to the raw workArea
  // boundary there let a seam-side mismatch get misread as a genuine outer-
  // edge clamp (Codex's own dual-display counter-example: [0,1000)/
  // [1000,2000), snapshot left=eligible/right=null (an internal seam), a
  // write at x=900 w=100 that then reads back at 880 — an 8px mismatch
  // wholly explainable as noise, but only via the right side, which this
  // write's own snapshot says was never eligible). dx<0 can only ever be
  // explained by a RIGHT-side clamp; dx>0 only by a LEFT-side clamp — so
  // each branch below checks only its own side's bound and returns null
  // immediately if that side was never eligible, instead of silently
  // reaching for the other axis' boundary value.
  function deriveClampObservation(actual, expected, wa, clampBounds) {
    if (!actual || !expected || !isValidWorkArea(wa)) return null;
    if (actual.width !== expected.width || actual.height !== expected.height) return null;
    const dx = actual.x - expected.x;
    const dy = actual.y - expected.y;
    if ((dx !== 0) === (dy !== 0)) return null; // a clamp changes exactly one axis
    if (dx !== 0) {
      const edge = dx < 0 ? "right" : "left";
      const bound = edge === "right"
        ? (clampBounds ? clampBounds.rightBound : null)
        : (clampBounds ? clampBounds.leftBound : null);
      if (!Number.isFinite(bound)) return null; // this side was never eligible to clamp anything
      // A clamp only ever pushes the window INWARD, so the original request
      // must genuinely have reached the boundary it was clamped against.
      if (edge === "right" && expected.x + expected.width < bound) return null;
      if (edge === "left" && expected.x > bound) return null;
      // The learned inset itself is always relative to the RAW workArea
      // (that's its definition: how far Mutter's real usable edge sits
      // inside Electron's reported one), never the already-adjusted boundary.
      const inset = edge === "right"
        ? (wa.x + wa.width) - (actual.x + actual.width)
        : actual.x - wa.x;
      if (!Number.isFinite(inset) || inset < 0 || inset > expected.width) return null;
      return { axis: "x", edge, inset };
    }
    const edge = dy < 0 ? "bottom" : "top";
    if (edge === "bottom" && expected.y + expected.height <= wa.y + wa.height) return null;
    if (edge === "top" && expected.y >= wa.y) return null;
    if (Math.abs(dy) > expected.height) return null;
    return { axis: "y", edge }; // Y is only used for acceptance, never learned
  }

  // The boundary OUR OWN materializer would clamp against right now for a
  // given workArea (i.e. resolveHorizontalClampBounds() without needing a
  // target rect / edge context) — used only to feed deriveClampObservation()
  // the "effective" boundary explained above. Deliberately NOT platform- or
  // escape-hatch-gated beyond what getObservedClampInset() itself already
  // is: on non-Linux (or with the escape hatch on) the inset table is always
  // empty, so this degrades to exactly the raw wa boundary — byte-identical
  // to the plan's literal (uncorrected) comparison there.
  function resolveClampAwareBounds(wa) {
    if (!isValidWorkArea(wa)) return { leftBound: null, rightBound: null };
    const displayId = findDisplayIdForPoint(wa.x + wa.width / 2, wa.y + wa.height / 2);
    return {
      leftBound: wa.x + getObservedClampInset(displayId, "left"),
      rightBound: wa.x + wa.width - getObservedClampInset(displayId, "right"),
    };
  }

  // Regulates native writes plus derived offset/log state for one logical
  // bounds request. `next` is the caller's intended (possibly off-screen on
  // Linux) logical position; the return value is the physical rect actually
  // requested from the OS.
  //
  //  - force: write natively even when the materialized physical rect already
  //    matches the current live bounds (needed by #525's compositor refresh
  //    and topmost's nudge — see recoverVisiblePetAfterRendererLoad below).
  //  - workArea / edgeContext: let a caller that already resolved these
  //    (e.g. a future per-frame mini animation) skip re-resolving them here.
  //    In normal macOS mode with edge pinning enabled, workArea is only a
  //    display hint: Y materialization uses that display's physical bounds.
  //    Mini mode remains explicitly work-area-contained.
  //  - assertNoYOffset: mini's future per-frame X-only entry point. When the
  //    materialize result still has a non-zero Y offset (it shouldn't, if the
  //    caller clamped Y first), refuse to forward it to the renderer and log
  //    once instead of reopening the Y layout hot path.
  function applyPetWindowBounds(next, opts = {}) {
    const win = getRenderWindow();
    if (!isLiveWindow(win) || !next) return null;

    const m = materializeVirtualBounds(next, opts.workArea, opts);
    if (!m) return null;

    // Key ordering (this batch's inviolable contract): the storage
    // quantities are updated BEFORE the native write below, so any business
    // read that lands after this point — even one triggered synchronously
    // from inside win.setBounds itself — observes the new logical position,
    // never a stale or WM-polluted one.
    lastLogicalBounds = { x: next.x, y: next.y, width: next.width, height: next.height };
    writeGen += 1;
    // PR #751 Codex review #2 (rework batch A-2): freeze this write's own
    // clamp-eligibility basis — a later reconcile pass judges THIS write's
    // outcome against what was true right now, not whatever the inset table
    // says by the time it gets around to checking.
    expectedWrite = {
      physical: { ...m.bounds },
      workArea: m.workArea,
      gen: writeGen,
      clampBounds: m.clampBounds,
      displayId: m.clampBounds.displayId,
      xEligibleLeft: m.clampBounds.leftBound !== null,
      xEligibleRight: m.clampBounds.rightBound !== null,
    };
    nativeEventSeenThisGen = false; // C-1: fresh generation, no events observed yet
    settleUntil = now() + SETTLE_MS;
    lastWriteAt = now();

    const cur = win.getBounds();
    if (opts.force || !sameRect(cur, m.bounds)) win.setBounds(m.bounds);

    // guardOffsetXLegalDomain(), when it fires, already hard-resyncs BOTH
    // offsets to 0 via recomputeOffsetsFrom() and overwrites lastLogicalBounds
    // — the normal per-axis assignments below must be skipped entirely in
    // that case, or the unconditional Y branch would immediately clobber the
    // guard's reset back to the original (rejected) m.viewportOffsetY.
    if (!guardOffsetXLegalDomain(m)) {
      setViewportOffsetX(m.viewportOffsetX);
      clearLoggedEdgeReason("offset-out-of-range");

      if (!opts.assertNoYOffset) {
        setViewportOffsetY(m.viewportOffsetY);
        clearLoggedEdgeReason("assert-no-y-offset");
      } else if (m.viewportOffsetY !== 0) {
        logEdgeOnce("assert-no-y-offset", `viewportOffsetY=${m.viewportOffsetY}`);
      } else {
        clearLoggedEdgeReason("assert-no-y-offset");
      }
    }

    scheduleSettleSweep();

    repositionSessionHud();
    return m.bounds;
  }

  function applyPetWindowPosition(x, y, opts = {}) {
    const bounds = getPetWindowBounds();
    if (!bounds) return null;
    return applyPetWindowBounds({ ...bounds, x, y }, opts);
  }

  function isPetHidden() {
    return petHidden;
  }

  // #525: clear an abnormal DWM cloak before showing. showInactive() alone
  // does NOT un-cloak (hide/show cycling is unreliable for that — plan §1.2-B);
  // DwmSetWindowAttribute(DWMWA_CLOAK, FALSE) is the direct primitive. Windows
  // parked on another virtual desktop are deliberately left alone.
  function uncloakIfAbnormal(win) {
    if (!cloakInspector || !cloakInspector.available || !isLiveWindow(win)) return false;
    const flag = cloakInspector.readCloakState(win);
    const verdict = classifyCloakState(flag, flag === 0 ? true : cloakInspector.isOnCurrentVirtualDesktop(win));
    if (verdict !== "recover") return false;
    return cloakInspector.uncloak(win);
  }

  function showPetWindows() {
    const win = getRenderWindow();
    if (isLiveWindow(win)) {
      uncloakIfAbnormal(win);
      win.showInactive();
      keepOutOfTaskbar(win);
    }
    const hitWin = getHitWindow();
    if (isLiveWindow(hitWin)) {
      uncloakIfAbnormal(hitWin);
      hitWin.showInactive();
      keepOutOfTaskbar(hitWin);
    }
  }

  function hidePetWindows() {
    const win = getRenderWindow();
    if (isLiveWindow(win)) win.hide();
    const hitWin = getHitWindow();
    if (isLiveWindow(hitWin)) hitWin.hide();
  }

  function isPetEffectivelyHidden() {
    return petHidden || fullscreenAutoHidden;
  }

  function isFullscreenAutoHidden() {
    return fullscreenAutoHidden;
  }

  // Shared tail of both visibility setters. Window show/hide fires only when
  // the EFFECTIVE state crossed an edge (so stacking a second hide reason on
  // an already-hidden pet is a visible no-op, and removing one reason while
  // the other still holds keeps the pet hidden); the downstream syncs run on
  // any layer change — applyHitInputState and the HUD/menu rebuilds all read
  // the effective state themselves and dedupe internally.
  function applyVisibilityLayerChange(prevEffective, options = {}) {
    const nextEffective = isPetEffectivelyHidden();
    const crossedEdge = nextEffective !== prevEffective;
    if (crossedEdge) {
      if (nextEffective) {
        hidePetWindows();
        if (options.syncFloatingSurfaces !== false) hideFloatingSurfacesForPet();
      } else {
        showPetWindows();
        if (options.syncFloatingSurfaces !== false) showFloatingSurfacesForPet();
        reapplyMacVisibility();
      }
    }
    // I5: effective hidden is one of applyHitInputState()'s OR-ed reasons.
    applyHitInputState();
    syncSessionHudVisibilityAndBubbles();
    syncPermissionShortcuts();
    buildTrayMenu();
    buildContextMenu();
    return crossedEdge;
  }

  // Idempotent visibility setter. Returns { applied, deferred, changed }:
  //  - no render window  -> { applied:false, deferred:false, changed:false }
  //  - mini transitioning -> { applied:false, deferred:true,  changed:false } (petHidden untouched)
  //  - already in target  -> { applied:true,  deferred:false, changed:false }
  //  - state flipped      -> { applied:true,  deferred:false, changed:true  }
  // `changed` reports whether the pet's on-screen visibility actually flipped,
  // which with the #935 auto-hide layer stacked on top is not always the same
  // as the manual flag flipping.
  function setPetHidden(hidden) {
    const target = !!hidden;
    const win = getRenderWindow();
    if (!isLiveWindow(win)) return { applied: false, deferred: false, changed: false };
    // Preserve the user's explicit Show intent even if a mini transition makes
    // the visibility write wait for a later fullscreen poll. In the common
    // auto-hidden case the manual layer is already visible, so the retry only
    // needs to lift the fullscreen layer once the transition completes.
    if (!target) noteManualPetShow();
    if (getMiniTransitioning()) return { applied: false, deferred: true, changed: false };
    // #935: a manual show also clears the fullscreen auto-hide — "show" must
    // mean show NOW, not "show once the fullscreen app exits". topmost-
    // runtime's sync observes the cleared flag and holds off re-hiding for the
    // rest of that fullscreen episode.
    const clearAutoHide = !target && fullscreenAutoHidden;
    if (target === petHidden && !clearAutoHide) {
      if (!target) reassertWinTopmost();
      return { applied: true, deferred: false, changed: false };
    }
    const prevEffective = isPetEffectivelyHidden();
    petHidden = target;
    if (clearAutoHide) {
      fullscreenAutoHidden = false;
      setFloatingSurfacesFullscreenSuppressed(false);
    }
    const changed = applyVisibilityLayerChange(prevEffective);
    // showInactive restores native visibility but not necessarily the topmost
    // band an exclusive fullscreen HWND displaced. The override is already
    // armed above, so reassert can surface the pet immediately even when the
    // legacy fullscreenOverlay pref is off; do not wait for the 5s watchdog.
    if (!target && !isPetEffectivelyHidden()) reassertWinTopmost();
    // A manual hide placed while the fullscreen layer already owns effective
    // visibility still needs to capture its own permission cutoff and suspend
    // ordinary floating notices. That manual state survives fullscreen exit.
    if (target && !changed) hideFloatingSurfacesForPet();
    return { applied: true, deferred: false, changed };
  }

  // #935: topmost-runtime's fullscreen auto-hide writer. Same contract and
  // guards as setPetHidden, acting on the auto layer only — it never touches
  // the manual flag, so a pet the user hid stays hidden when the auto-hide
  // lifts, and the tray/context menus keep reflecting the user's choice.
  function setFullscreenAutoHidden(hidden, fullscreenObservation) {
    const target = !!hidden;
    const win = getRenderWindow();
    if (!isLiveWindow(win)) return { applied: false, deferred: false, changed: false };
    if (getMiniTransitioning()) return { applied: false, deferred: true, changed: false };
    if (target === fullscreenAutoHidden) return { applied: true, deferred: false, changed: false };
    const prevEffective = isPetEffectivelyHidden();
    fullscreenAutoHidden = target;
    const changed = applyVisibilityLayerChange(prevEffective, { syncFloatingSurfaces: false });
    setFloatingSurfacesFullscreenSuppressed(target);
    // Exiting fullscreen can leave showInactive windows visible but displaced
    // from the topmost band until the 5s watchdog runs. Restore the band now,
    // using the focus poll's already-known observation so this path does not
    // perform a second native foreground probe in the same tick.
    if (!target && changed && !isPetEffectivelyHidden()) {
      if (fullscreenObservation !== undefined) reassertWinTopmost(fullscreenObservation);
      else reassertWinTopmost();
    }
    return { applied: true, deferred: false, changed };
  }

  function togglePetVisibility() {
    // #935: toggle what the user SEES. From an auto-hidden pet one toggle
    // shows it (setPetHidden(false) clears the auto layer); without the auto
    // layer this is the pre-#935 manual flip.
    return setPetHidden(!isPetEffectivelyHidden());
  }

  // ── #525: self-healing for cloaked-yet-supposedly-visible windows ──
  //
  // Called from the 5s topmost watchdog, powerMonitor resume/unlock, and the
  // second-instance handler. Deliberately NOT wired into togglePetVisibility:
  // hide must always mean hide (a cloak-aware toggle polarity degenerates into
  // "can never hide" on machines whose cloak flag reads permanently non-zero —
  // the exact regression review round 2026-07-16 blocked in the external
  // patch). Recovery failures back off exponentially so a stubborn cloak never
  // turns the watchdog into a 5s hide/show strobe.
  const CLOAK_BACKOFF_BASE_MS = 5_000;
  const CLOAK_BACKOFF_MAX_MS = 300_000;
  let cloakFailStreak = 0;
  let cloakCooldownUntil = 0;

  function recoverIfCloaked() {
    if (!cloakInspector || !cloakInspector.available) return "unavailable";
    if (isPetEffectivelyHidden()) return "hidden";
    if (getMiniTransitioning() || isMiniAnimating() || dragLocked) return "busy";
    if (settingsSizePreviewSyncFrozen) return "frozen";
    if (now() < cloakCooldownUntil) return "backoff";

    const targets = [getRenderWindow(), getHitWindow()].filter(isLiveWindow);
    if (!targets.length) return "no-window";

    let attempted = false;
    let touched = false;
    let stillCloaked = false;
    for (const win of targets) {
      const flag = cloakInspector.readCloakState(win);
      if (flag === 0) continue;
      const verdict = classifyCloakState(flag, cloakInspector.isOnCurrentVirtualDesktop(win));
      if (verdict !== "recover") continue;
      attempted = true;
      // Fail-open contract: if the DWM un-cloak call itself fails, do NOT go
      // on to touch the window (show/taskbar/topmost would be a behavior
      // change over the pre-#525 no-op, and a fail-open re-read of 0 could
      // then mislabel the round "recovered"). Count it as a failure and let
      // the backoff decide when to try again.
      if (!cloakInspector.uncloak(win)) {
        stillCloaked = true;
        continue;
      }
      win.showInactive();
      keepOutOfTaskbar(win);
      touched = true;
      if (cloakInspector.readCloakState(win) !== 0) stillCloaked = true;
    }
    if (!attempted) {
      // Nothing abnormal this round: the previous fault (if any) resolved on
      // its own, so the NEXT independent fault must start from a fresh 10s
      // backoff instead of inheriting an escalated cooldown.
      cloakFailStreak = 0;
      cloakCooldownUntil = 0;
      return "clean";
    }

    // Same fail-open contract as above, second exit: a round where every
    // un-cloak call failed must not re-assert topmost either — that would
    // setAlwaysOnTop both windows on a path where native calls are failing.
    if (touched) reassertWinTopmost();
    if (!stillCloaked) {
      cloakFailStreak = 0;
      cloakCooldownUntil = 0;
      scheduleHwndRecovery();
      return "recovered";
    }
    cloakFailStreak += 1;
    const backoff = Math.min(
      CLOAK_BACKOFF_BASE_MS * 2 ** cloakFailStreak,
      CLOAK_BACKOFF_MAX_MS
    );
    cloakCooldownUntil = now() + backoff;
    return "failed";
  }

  // A transparent Windows BrowserWindow can finish its first load while the
  // native HWND is nominally visible but still parked below the useful z-order
  // or waiting for a compositor refresh. The manual "bring to primary display"
  // action heals that state because it replays bounds, shows both layers, and
  // re-asserts topmost. Run the same non-relocating sequence after the renderer
  // finishes loading so startup/crash recovery does not require that menu
  // action. Intentional hiding and in-flight geometry transitions remain
  // authoritative.
  function recoverVisiblePetAfterRendererLoad() {
    if (!isWin) return "unsupported";
    const win = getRenderWindow();
    if (!isLiveWindow(win)) return "no-window";
    if (isPetEffectivelyHidden()) return "hidden";
    if (getMiniTransitioning() || isMiniAnimating() || dragLocked) return "busy";
    if (settingsSizePreviewSyncFrozen) return "frozen";

    // Replaying the exact virtual bounds is intentional: setBounds() gives a
    // transparent HWND a compositor refresh without discarding the user's
    // saved display/edge position. applyPetWindowBounds also preserves a
    // virtual negative-Y offset used by top-edge pinning. force:true is
    // required here (plan §4.3 point 3 / §12.12): the materialized physical
    // rect is normally identical to what's already live, and
    // applyPetWindowBounds() now skips the native write in that case unless
    // told not to — but the whole point of this path is the compositor
    // refresh from a real setBounds() call.
    const bounds = getPetWindowBounds();
    if (bounds) {
      applyPetWindowBounds(bounds, { force: true });
      syncHitWin();
      repositionAnchoredSurfaces();
    }
    showPetWindows();
    reapplyMacVisibility();
    reassertWinTopmost();
    scheduleHwndRecovery();
    return "recovered";
  }

  function bringPetToPrimaryDisplay() {
    const win = getRenderWindow();
    if (!isLiveWindow(win)) return;
    if (getMiniMode() || getMiniTransitioning()) return;

    const workArea = getPrimaryWorkAreaFallback();
    const size = getEffectiveCurrentPixelSize(workArea);
    const bounds = {
      x: Math.round(workArea.x + (workArea.width - size.width) / 2),
      y: Math.round(workArea.y + (workArea.height - size.height) / 2),
      width: size.width,
      height: size.height,
    };

    applyPetWindowBounds(bounds);
    syncHitWin();
    repositionFloatingBubbles();

    if (isPetEffectivelyHidden()) {
      togglePetVisibility();
    } else {
      showPetWindows();
    }

    reapplyMacVisibility();
    reassertWinTopmost();
    scheduleHwndRecovery();
    flushRuntimeStateToPrefs();
  }

  function getObjRect(bounds) {
    return petGeometryMain.getObjRect(bounds);
  }

  function getAssetPointerPayload(bounds, point) {
    return petGeometryMain.getAssetPointerPayload(bounds, point);
  }

  function getHitRectScreen(bounds) {
    return clipHitRectToMiniSeam(petGeometryMain.getHitRectScreen(bounds));
  }

  function getUpdateBubbleAnchorRect(bounds) {
    return petGeometryMain.getUpdateBubbleAnchorRect(bounds);
  }

  function getSessionHudAnchorRect(bounds) {
    return petGeometryMain.getSessionHudAnchorRect(bounds);
  }

  function getVisibleContentMargins(bounds) {
    const theme = getActiveTheme();
    if (!bounds || !theme) return { top: 0, bottom: 0 };
    const box = getThemeMarginBox(theme);
    if (!box) return { top: 0, bottom: 0 };

    const cacheKey = [
      theme._id || "",
      theme._variantId || "",
      bounds.width,
      bounds.height,
      JSON.stringify(box),
    ].join("|");
    const cached = themeMarginEnvelopeCache.get(cacheKey);
    if (cached) return cached;

    const margins = computeStableVisibleContentMargins(theme, bounds, { box });
    themeMarginEnvelopeCache.set(cacheKey, margins);
    return margins;
  }

  function looseClampPetToDisplays(x, y, w, h) {
    const allowEdgePinning = getAllowEdgePinning();
    const { displays, physicalTopologyComplete } = getClampDisplaysSafe();
    // #241: macOS workArea excludes the Dock/menu bar. Edge pinning is visual,
    // so its clamp topology must follow the physical display rectangle instead.
    const physicalPrimaryBounds = isMac && allowEdgePinning
      ? getPrimaryDisplayPhysicalBounds()
      : null;
    const usePhysicalBounds = isMac
      && allowEdgePinning
      && physicalTopologyComplete
      && hasCompletePhysicalDisplayTopology(displays, physicalPrimaryBounds);
    const margins = getVisibleContentMargins({ x, y, width: w, height: h });
    const bottomInset = usePhysicalBounds
      ? 0
      : getNearestDisplayBottomInset(x + w / 2, y + h / 2);
    return computeLooseClamp(
      usePhysicalBounds ? projectDisplaysToPhysicalBounds(displays) : displays,
      usePhysicalBounds
        ? (physicalPrimaryBounds || getPrimaryWorkAreaSafe())
        : getPrimaryWorkAreaSafe(),
      x,
      y,
      w,
      h,
      getLooseDragMargins({
        width: w,
        height: h,
        visibleMargins: margins,
        allowEdgePinning,
        bottomInset,
      })
    );
  }

  function isValidWorkArea(wa) {
    return !!(
      wa
      && Number.isFinite(wa.x)
      && Number.isFinite(wa.y)
      && Number.isFinite(wa.width)
      && wa.width > 0
      && Number.isFinite(wa.height)
      && wa.height > 0
    );
  }

  function clampToScreenVisual(x, y, w, h, optionsArg = {}) {
    const margins = getVisibleContentMargins(
      { x, y, width: w, height: h },
      optionsArg
    );
    const forcedWorkArea = isValidWorkArea(optionsArg.workArea)
      ? optionsArg.workArea
      : null;
    const nearestWorkArea = forcedWorkArea || getNearestWorkArea(x + w / 2, y + h / 2);
    const insetProbeX = forcedWorkArea
      ? nearestWorkArea.x + nearestWorkArea.width / 2
      : x + w / 2;
    const insetProbeY = forcedWorkArea
      ? nearestWorkArea.y + nearestWorkArea.height / 2
      : y + h / 2;
    const allowEdgePinning = "allowEdgePinning" in optionsArg
      ? !!optionsArg.allowEdgePinning
      : getAllowEdgePinning();
    // A forced work area (for example, mini-mode exit) still identifies the
    // display; when pinning is enabled, clamp against that display's bounds.
    const physicalBounds = isMac && allowEdgePinning
      ? getNearestDisplayPhysicalBounds(insetProbeX, insetProbeY)
      : null;
    const clampArea = physicalBounds || nearestWorkArea;
    const bottomInset = physicalBounds
      ? 0
      : getNearestDisplayBottomInset(insetProbeX, insetProbeY);
    const mLeft = Math.round(w * 0.25);
    const mRight = Math.round(w * 0.25);
    const clampMargins = getRestClampMargins({
      height: h,
      visibleMargins: margins,
      allowEdgePinning,
      bottomInset,
    });
    return {
      x: Math.max(
        clampArea.x - mLeft,
        Math.min(x, clampArea.x + clampArea.width - w + mRight)
      ),
      y: Math.max(
        clampArea.y - clampMargins.top,
        Math.min(y, clampArea.y + clampArea.height - h + clampMargins.bottom)
      ),
    };
  }

  function clampToScreen(x, y, w, h) {
    return clampToScreenVisual(x, y, w, h);
  }

  function computeFinalDragBounds(bounds, size, clampPosition = clampToScreenVisual) {
    return computeFinalDragBoundsRaw(bounds, size, clampPosition);
  }

  function needsFinalClampAdjustment(bounds, size, clampPosition = clampToScreenVisual) {
    return needsFinalClampAdjustmentRaw(bounds, size, clampPosition);
  }

  // At an internal multi-monitor seam the render window is clip-pathed so its
  // seam-crossing half shows nothing — but the hit (input) window is a
  // transparent surface and would keep capturing clicks over the neighbouring
  // display. Clip the hit rect to the same seam so those clicks fall through.
  // The clamps keep the rect from inverting when the whole hit rect is past
  // the seam; the degenerate check in callers then drops the tiny/inverted
  // result via the suppress path instead of writing it.
  function clipHitRectToMiniSeam(hit) {
    if (!hit) return hit;
    const seam = getMiniContainedSeam();
    if (!seam || !Number.isFinite(seam.boundary)) return hit;
    if (seam.edge === "right") {
      if (hit.right <= seam.boundary) return hit;
      return { ...hit, right: Math.max(hit.left, seam.boundary) };
    }
    if (hit.left >= seam.boundary) return hit;
    return { ...hit, left: Math.min(hit.right, seam.boundary) };
  }

  // I5's read-only physical-bounds helper (§4.3 point 8) for hit clipping and
  // debugging. Business modules must keep treating getPetWindowBounds() as
  // the only logical-position source of truth — this is never a substitute.
  function getPhysicalRenderBounds() {
    const win = getRenderWindow();
    if (!isLiveWindow(win)) return null;
    return win.getBounds();
  }

  // I5's outward clip: hit.right/left/top pull in on whichever side(s) the
  // CURRENT viewport offset pushed the physical window away from the logical
  // one — the character is only actually visible inside the physical render
  // window on that side. hit.bottom is always capped to the physical bottom
  // regardless of any offset ("所有路径" — I5's fourth bullet). Reacts to
  // whatever viewportOffsetX/Y already are; no platform gate needed here
  // since offsetX is always 0 off Linux (I3) and offsetY's top-lift already
  // applied on any platform before #690.
  function applyOutwardClip(hit, physical) {
    if (!hit || !physical) return hit;
    let { left, top, right, bottom } = hit;
    if (viewportOffsetX > 0) right = Math.min(right, physical.x + physical.width);
    if (viewportOffsetX < 0) left = Math.max(left, physical.x);
    if (viewportOffsetY > 0) top = Math.max(top, physical.y);
    bottom = Math.min(bottom, physical.y + physical.height);
    return { left, top, right: Math.max(left, right), bottom: Math.max(top, bottom) };
  }

  // I5: the hit window is a Linux `toolbar` under the same fully-onscreen
  // constraint as render — a rect that pokes past the target workArea just
  // gets moved again by Mutter, stranding the hit region away from the
  // character. Intersecting with the SAME inset-narrowed edges materialize
  // uses (§4.3.14 / §12.13) keeps the two from disagreeing by exactly the
  // learned inset. Linux-only at the call site below (I3): Windows/macOS
  // never intersect against workArea here, preserving existing edge-pinning
  // behavior that deliberately sits partially outside it.
  //
  // PR #751 Codex review #5 (rework batch B-2): only clip whichever side(s)
  // `clampBounds` (render's own write-time snapshot, expectedWrite.clampBounds
  // — the exact eligibility basis materialize used for the pet window
  // itself, reused here rather than re-resolved from a bare displayId) marks
  // eligible — a null bound means that side is a seam (or otherwise
  // ineligible): don't clip it at all. The previous displayId-based version
  // clipped BOTH sides unconditionally against the raw workArea width
  // regardless of seam/outer-edge status, which cut a hit rect that
  // legitimately spans onto a neighbouring display down to a single
  // display's width — Y (top/bottom vs workArea) is unaffected, unchanged.
  function intersectHitWithWorkArea(hit, workArea, clampBounds) {
    if (!hit || !isValidWorkArea(workArea)) return hit;
    let { left, right } = hit;
    const leftBound = clampBounds && Number.isFinite(clampBounds.leftBound) ? clampBounds.leftBound : null;
    const rightBound = clampBounds && Number.isFinite(clampBounds.rightBound) ? clampBounds.rightBound : null;
    if (leftBound !== null) left = Math.max(left, leftBound);
    if (rightBound !== null) right = Math.min(right, rightBound);
    const top = Math.max(hit.top, workArea.y);
    const bottom = Math.min(hit.bottom, workArea.y + workArea.height);
    return { left, top, right: Math.max(left, right), bottom: Math.max(top, bottom) };
  }

  // I5's single ignore-mouse writer. Four independent suppression reasons OR
  // together. Pre-#690 there were four writers and three separate caches
  // (hit window creation with no platform gate; Settings size preview,
  // Windows-only; macOS editing dodge with topmost-runtime.js's own now-
  // removed imeEditingHitIgnoreApplied cache) — collapsing to one cache
  // (hitInputIgnoreApplied) means no writer can leave the window in a state a
  // DIFFERENT writer's stale cache doesn't know about.
  // `hitWinOverride`: createHitWindow() below needs this at the exact moment
  // it's constructing the window, before the caller (main.js) has assigned it
  // to whatever `getHitWindow()` reads — the local reference is correct there,
  // getHitWindow() is not yet. Every other caller omits it and gets the
  // normal getHitWindow() lookup, still funneled through this one function.
  function applyHitInputState(hitWinOverride) {
    const hitWin = hitWinOverride || getHitWindow();
    if (!isLiveWindow(hitWin) || typeof hitWin.setIgnoreMouseEvents !== "function") return;
    const ignore = hitGeometrySuppressed || isPetEffectivelyHidden()
      || settingsSizePreviewIgnoringHit || imeEditingPetDodge;
    if (ignore === hitInputIgnoreApplied) return;
    hitWin.setIgnoreMouseEvents(ignore);
    hitInputIgnoreApplied = ignore;
  }

  // The fourth applyHitInputState() reason, fed by topmost-runtime.js's macOS
  // editing-overlap dodge (#640) instead of that module reaching into
  // hitWin.setIgnoreMouseEvents() directly (I5's single-writer requirement).
  function setImeEditingPetDodge(value) {
    const next = !!value;
    if (next === imeEditingPetDodge) return;
    imeEditingPetDodge = next;
    applyHitInputState();
  }

  function resetHitReconcileObservation() {
    hitLastObservedActual = null;
    hitStableCount = 0;
    if (hitConfirmTimer) { clearTimeoutFn(hitConfirmTimer); hitConfirmTimer = null; }
  }

  // What syncHitWin() reports back. "deferred" is a normal outcome — a drag is
  // holding the pointer, the windows are not up yet, or the rect is a
  // transient sliver — and callers that care about the new geometry should
  // retry rather than warn. "failed" means the rect could not be resolved at
  // all; with today's guards that is unreachable (every clip step returns a
  // rect, and bounds are non-null once the windows are live), so it is defence
  // in depth for callers that inject their own sync, not a live path.
  const APPLIED_HIT_SYNC = Object.freeze({ applied: true, deferred: false });
  const DEFERRED_HIT_SYNC = Object.freeze({ applied: false, deferred: true });
  const FAILED_HIT_SYNC = Object.freeze({ applied: false, deferred: false });

  // syncHitWin() is the ONLY caller that needs the full I5 pipeline in this
  // exact order (§4.3 point 7: outward clip, THEN internal-seam clip) — it
  // calls petGeometryMain.getHitRectScreen() directly (bypassing the exposed
  // getHitRectScreen()/clipHitRectToMiniSeam() pairing used by hover/overlap
  // callers elsewhere) so seam clipping happens strictly after outward
  // clipping, not baked in before it.
  function syncHitWin() {
    const hitWin = getHitWindow();
    const win = getRenderWindow();
    if (!isLiveWindow(hitWin) || !isLiveWindow(win)) return DEFERRED_HIT_SYNC;
    // Keep the captured pointer stable while dragging. Repositioning the input
    // window mid-drag can break pointer capture on Windows.
    if (dragLocked) return DEFERRED_HIT_SYNC;
    const bounds = getPetWindowBounds();
    let hit = petGeometryMain.getHitRectScreen(bounds);
    if (!hit) return FAILED_HIT_SYNC;

    const physical = getPhysicalRenderBounds();
    hit = applyOutwardClip(hit, physical);
    const hitWa = resolveWorkAreaFor(bounds);
    // PR #751 Codex review #5/#4c (rework batch B-2): the escape hatch must
    // revert hit to pre-#690 behavior entirely — no workArea intersection,
    // no HIT_MIN suppression below — not just skip the X offset itself.
    const edgeVirtualizationActive = isLinux && !isEdgeVirtualizationDisabled();
    if (edgeVirtualizationActive) {
      // Reuse render's own write-time snapshot rather than re-resolving
      // fresh from a bare displayId lookup.
      const clampBounds = expectedWrite ? expectedWrite.clampBounds : null;
      hit = intersectHitWithWorkArea(hit, hitWa, clampBounds);
    }
    hit = clipHitRectToMiniSeam(hit);
    if (!hit) return FAILED_HIT_SYNC;

    const x = Math.round(hit.left);
    const y = Math.round(hit.top);
    const w = Math.round(hit.right - hit.left);
    const h = Math.round(hit.bottom - hit.top);

    // Linux-gated (Codex review #4c): off Linux, or with the escape hatch
    // engaged, a narrow rect is written as-is — no suppression — matching
    // pre-#690 behavior exactly (HIT_MIN degeneracy is itself a consequence
    // of the workArea intersection just skipped above).
    if (edgeVirtualizationActive && (w < HIT_MIN_PX || h < HIT_MIN_PX)) {
      // Degenerate (menu mini-entry's fully-offscreen preload, or a 1-7px
      // transition sliver): don't write a sliver BrowserWindow, and don't
      // leave the OLD rect sitting there interactive either. Suppress FIRST
      // — before the syncImeEditingPetDodge() tail call below — so the
      // OR-composition in applyHitInputState() can never be flipped back to
      // interactive by a different reason's writer while this rect is
      // invalid (I5's ordering requirement: today's `return` here would hide
      // that bug only because it happens to run before the dodge call).
      hitGeometrySuppressed = true;
      applyHitInputState();
      repositionSessionHud();
      syncImeEditingPetDodge();
      // Nothing was written: this rect is a transient sliver. Callers that
      // need the new geometry should retry, not warn.
      return DEFERRED_HIT_SYNC;
    }

    const target = { x, y, width: w, height: h };
    const wasSuppressed = hitGeometrySuppressed;
    // PR #751 Codex review #6 (rework batch B-3): if this derived target
    // matches whatever derivation last led to an adopted WM-clamped outcome,
    // keep that outcome as settled fact rather than re-initiating a write to
    // the derived value runHitReconcile() already established gets clamped
    // away — recovering from suppression always needs a real write, so that
    // still takes the normal path even if the derivation happens to match.
    if (!wasSuppressed && lastAdoptedHitOutcome && sameRect(target, lastAdoptedHitOutcome.derived)) {
      lastRequestedHitRect = { ...lastAdoptedHitOutcome.actual };
    } else if (wasSuppressed || !sameRect(lastRequestedHitRect, target)) {
      // PR #751 second-review C-3 (Codex B3): lastHitWorkArea/lastHitClampBounds
      // are the write basis runHitReconcile() judges THIS rect against later
      // (A-2's own point: judge against what was true when written, not
      // whatever is true when reconcile happens to run) — moved here, INSIDE
      // the branch that actually calls hitWin.setBounds(target), atomic with
      // lastRequestedHitRect itself. They used to refresh unconditionally on
      // every syncHitWin() call, including the two branches above/below that
      // do NOT write anything (same-target no-op, and the adopted-outcome
      // reuse) — a table/inset change landing between two such no-op calls
      // would silently move the goalposts out from under a rect that was
      // never actually re-written, so runHitReconcile() would judge a STALE
      // rect against a boundary that was never the basis for it.
      lastHitWorkArea = hitWa;
      lastHitClampBounds = resolveClampAwareBounds(hitWa);
      lastRequestedHitRect = target;
      hitWin.setBounds(target);
      hitRetriedRect = null;
      lastAdoptedHitOutcome = null;
      resetHitReconcileObservation();
    }
    // Update shape if hitbox dimensions changed (e.g. after resize).
    if (w !== hitShapeWidth || h !== hitShapeHeight) {
      hitShapeWidth = w;
      hitShapeHeight = h;
      hitWin.setShape([{ x: 0, y: 0, width: w, height: h }]);
    }
    if (wasSuppressed) {
      // Recover: geometry is already written above before input flips back
      // on, so there's no frame where the stale rect is clickable again.
      hitGeometrySuppressed = false;
      applyHitInputState();
    }
    repositionSessionHud();
    // #640: the hit rect just (re)resolved — state switches and theme reloads
    // change hitboxes without moving the window, so the overlap answer can
    // flip right here. Cheap + edge-triggered inside.
    syncImeEditingPetDodge();
    return APPLIED_HIT_SYNC;
  }

  // §4.3.11's hit-side reconcile. Debounced on its own (longer) quiet period
  // so we don't fight a Mutter interactive grab; move/resize callbacks here
  // are just as geometry-blind as the render ones (§4.3.9) — scheduling is
  // their only job.
  function onHitNativeGeometryEvent() {
    scheduleHitReconcile();
  }

  function scheduleHitReconcile() {
    if (hitQuietTimer) clearTimeoutFn(hitQuietTimer);
    // A fresh native event means whatever candidate-stability streak was
    // building toward "grab ended" (public premise 3 below) reflects a
    // genuinely new movement, not a pause — the two-level judgment restarts.
    if (hitConfirmTimer) { clearTimeoutFn(hitConfirmTimer); hitConfirmTimer = null; }
    hitStableCount = 0;
    hitQuietTimer = setTimeoutFn(() => {
      hitQuietTimer = null;
      runHitReconcile();
    }, HIT_QUIET_MS);
  }

  // §4.3.11's public premises, implemented as the shared state machine
  // regardless of which P1-4 branch (A/B) a later batch picks:
  //
  //  1. Explainability beats time: a clamp-explainable difference is ALWAYS
  //     adopt-clamp, never routed into the grab judgment below, independent
  //     of whether hit settle has "expired".
  //  2. Mutter does not clamp during an interactive grab — it silently drops
  //     the position component of our ConfigureRequest and keeps the window
  //     wherever the user is dragging it, still sending ConfigureNotify (see
  //     mutter@50.3 src/x11/window-x11.c meta_window_move_resize_request(),
  //     called from meta_window_x11_configure_request(): "We ignore configure
  //     requests while the user is moving/resizing the window ... pretend the
  //     app asked for the current size/position instead"). That single fact
  //     is why retrying our own write is FREE here (no visible jitter) and
  //     why a naive one-shot "target unchanged, actual different => WM
  //     rejected it" test is not just imprecise but actively wrong during a
  //     grab: it would read as "permanently rejected" when it is actually
  //     "try again next quiet point, no cost".
  //  3. "Grab ended" needs a SECOND, independent signal — "no hit move event
  //     for HIT_QUIET_MS" is the same signal that triggered this check in the
  //     first place, so alone it can't distinguish a real release from a
  //     mid-drag pause (a trackpad re-grip alone can exceed 250ms).
  //     dragLocked can't help either — it is only set by the hit renderer's
  //     own DOM pointerdown -> pet-interaction-ipc "drag-lock" IPC, which a
  //     GNOME Super+drag grab (a compositor-level gesture) never goes
  //     through. So the second signal here is purely observational: `actual`
  //     must be independently unchanged across two CONSECUTIVE HIT_QUIET_MS
  //     periods before we call it a confirmed external move.
  //  4. Retry/adopt state is recoverable, not a one-shot lockout — see the
  //     hitRetriedRect comment below.
  function runHitReconcile() {
    const hitWin = getHitWindow();
    if (!isLiveWindow(hitWin) || !lastRequestedHitRect) return;
    const actual = hitWin.getBounds();

    if (sameRect(actual, lastRequestedHitRect)) {
      hitRetriedRect = null;
      resetHitReconcileObservation();
      return;
    }

    // Same Windows DIP rounding as the render window. Remember the derived
    // target alongside its accepted native outcome so the next syncHitWin()
    // reuses the settled rect instead of rewriting it and starting the cycle
    // again. Pure x/y movement never enters this branch.
    if (isWindowsNativeSizeRounding(lastRequestedHitRect, actual)) {
      lastAdoptedHitOutcome = {
        derived: { ...lastRequestedHitRect },
        actual: { ...actual },
      };
      lastRequestedHitRect = { ...actual };
      hitRetriedRect = null;
      resetHitReconcileObservation();
      return;
    }

    // A-2: judge against the boundary snapshotted when this rect was WRITTEN
    // (syncHitWin()), not one recomputed fresh here against whatever the
    // CURRENT inset table says.
    const clampObs = deriveClampObservation(
      actual, lastRequestedHitRect, lastHitWorkArea, lastHitClampBounds
    );
    if (clampObs) {
      // §12.21: recoverable, not a one-shot lockout. The SAME target gets at
      // most one retry write; adopting afterward doesn't disable future
      // retries — a target that later changes (a fresh syncHitWin() write)
      // re-arms this automatically, since hitRetriedRect no longer matches
      // the new lastRequestedHitRect.
      if (sameRect(hitRetriedRect, lastRequestedHitRect)) {
        hitGeometryDrift = { x: actual.x - lastRequestedHitRect.x, y: actual.y - lastRequestedHitRect.y };
        logReconcileEvent(
          "hit", lastRequestedHitRect, actual, "adopt-clamp", "n/a", "n/a",
          `edge=${clampObs.edge} hitDrift=${hitGeometryDrift.x},${hitGeometryDrift.y}`
        );
        // PR #751 Codex review #6 (rework batch B-3): remember which derived
        // target led to this adopted outcome — see syncHitWin()'s own
        // comment for why the next sync needs this to avoid flip-flopping.
        lastAdoptedHitOutcome = { derived: { ...lastRequestedHitRect }, actual: { ...actual } };
        lastRequestedHitRect = { ...actual };
        hitRetriedRect = null;
      } else {
        hitRetriedRect = { ...lastRequestedHitRect };
        hitWin.setBounds(lastRequestedHitRect);
      }
      resetHitReconcileObservation();
      return;
    }

    // Two-level grab judgment (public premise 3): only promote to "grab
    // ended" once `actual` is independently observed stable across two
    // consecutive HIT_QUIET_MS periods.
    if (hitLastObservedActual && sameRect(hitLastObservedActual, actual)) {
      hitStableCount += 1;
    } else {
      hitStableCount = 1; // first observation of this candidate value
    }
    hitLastObservedActual = { ...actual };

    if (hitStableCount >= 2) {
      handleHitExternalMoveCandidate(actual);
      resetHitReconcileObservation();
      return;
    }

    // Not yet confirmed — nothing else will re-trigger this check (no new
    // native event arrived since the debounce fired), so explicitly re-arm
    // for one more HIT_QUIET_MS rather than judging "still dragging" off a
    // single sample.
    hitConfirmTimer = setTimeoutFn(() => {
      hitConfirmTimer = null;
      runHitReconcile();
    }, HIT_QUIET_MS);
  }

  // P1-4 (§4.3.11): the hit window moved externally (most likely a GNOME
  // Super+drag grabbing the transparent hit layer instead of the visual
  // render window) and the two-level judgment above confirmed the grab
  // ended. Phase 0's real-machine active-window sample is the only evidence
  // that can settle whether Super+drag actually grabs render or hit (plan §5
  // Phase 0 item 1) — until that data returns and option A ("follow",
  // modifies lastLogicalBounds) or option B ("bounce back", snaps hitWin
  // back) is picked, this batch deliberately does NEITHER: no
  // applyPetWindowBounds() rebase (that's A) and no forced hitWin
  // setBounds() snap-back (that's B). It only logs, so the confirmed moment
  // is visible in diagnostics, and lastRequestedHitRect is left exactly
  // where it was — a later batch's real A/B branch hooks in at this exact
  // call site.
  function handleHitExternalMoveCandidate(actualHit) {
    edgeLog(
      `Clawd: edge-hit-external-move-candidate action=log-only `
      + `actual=${actualHit.x},${actualHit.y},${actualHit.width},${actualHit.height} `
      + `lastRequestedHitRect=${lastRequestedHitRect.x},${lastRequestedHitRect.y},${lastRequestedHitRect.width},${lastRequestedHitRect.height} `
      + `note=P1-4-pending-real-machine-data`
    );
  }

  function getInitialHitWindowBounds(renderBounds = getPetWindowBounds()) {
    const hit = getHitRectScreen(renderBounds);
    if (!hit) return null;
    return {
      x: Math.round(hit.left),
      y: Math.round(hit.top),
      width: Math.round(hit.right - hit.left),
      height: Math.round(hit.bottom - hit.top),
    };
  }

  function createRenderWindow(optionsArg = {}) {
    const BrowserWindow = optionsArg.BrowserWindow;
    if (typeof BrowserWindow !== "function") {
      throw new Error("createRenderWindow requires BrowserWindow");
    }
    const isQuitting = typeof optionsArg.isQuitting === "function" ? optionsArg.isQuitting : () => false;
    const size = optionsArg.size;
    const initialWindowBounds = optionsArg.initialWindowBounds;
    const renderWin = new BrowserWindow({
      width: size.width,
      height: size.height,
      x: initialWindowBounds.x,
      y: initialWindowBounds.y,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      fullscreenable: false,
      enableLargerThanScreen: true,
      ...(isLinux ? { type: linuxWindowType } : {}),
      ...(isMac ? { type: "panel", roundedCorners: false } : {}),
      webPreferences: {
        preload: optionsArg.preloadPath,
        backgroundThrottling: false,
        additionalArguments: [
          "--theme-config=" + JSON.stringify(optionsArg.themeConfig),
        ],
      },
    });

    if (typeof optionsArg.setRenderWindow === "function") {
      optionsArg.setRenderWindow(renderWin);
    }
    renderWin.setFocusable(false);

    if (isLinux) {
      renderWin.on("close", (event) => {
        if (!isQuitting()) {
          event.preventDefault();
          if (!renderWin.isVisible()) {
            renderWin.showInactive();
            keepOutOfTaskbar(renderWin);
          }
        }
      });
      renderWin.on("unresponsive", () => {
        if (isQuitting()) return;
        console.warn("Clawd: renderer unresponsive — reloading");
        reloadWindowWebContents(renderWin);
      });
    }

    if (isWin) renderWin.setAlwaysOnTop(true, topmostLevel);
    if (isWin) {
      let sessionEndFlushed = false;
      const flushForSessionEnd = () => {
        if (sessionEndFlushed) return;
        sessionEndFlushed = true;
        try {
          flushRuntimeStateToPrefs();
        } catch (err) {
          console.warn("Clawd: failed to persist prefs during Windows session end:", err && err.message);
        }
      };
      renderWin.on("query-session-end", flushForSessionEnd);
      renderWin.on("session-end", flushForSessionEnd);
    }
    renderWin.loadFile(optionsArg.loadFilePath);
    // file:// zoom propagates partition-wide and persists across restarts;
    // builds that briefly used setZoomFactor for textScale may have left a
    // non-1 factor behind. Reset it from the first window to load so the pet
    // (and, via propagation, every file:// page) renders 1:1 — textScale uses
    // per-document CSS zoom instead and never touches this map.
    if (renderWin.webContents && typeof renderWin.webContents.once === "function") {
      renderWin.webContents.once("did-finish-load", () => {
        try { renderWin.webContents.setZoomFactor(1); } catch {}
      });
    }
    // force:true: the BrowserWindow constructor above already received
    // initialWindowBounds (the pre-materialized, safe physical rect), so
    // re-materializing initialVirtualBounds here will usually match live
    // bounds exactly and would otherwise be skipped by the "same rect"
    // optimization. Force a definitive write anyway so offset truth
    // (lastLogicalBounds/viewportOffsetX/Y) is established the same way
    // regardless of whether the constructor's bounds happened to match.
    applyPetWindowBounds(optionsArg.initialVirtualBounds, { force: true });
    renderWin.showInactive();
    keepOutOfTaskbar(renderWin);
    reapplyMacVisibility();

    if (isMac && typeof optionsArg.applyDockVisibility === "function") {
      setTimeout(() => {
        if (!isLiveWindow(renderWin)) return;
        optionsArg.applyDockVisibility();
      }, 0);
    }

    return renderWin;
  }

  function createHitWindow(optionsArg = {}) {
    const BrowserWindow = optionsArg.BrowserWindow;
    if (typeof BrowserWindow !== "function") {
      throw new Error("createHitWindow requires BrowserWindow");
    }
    const initialHitWindowBounds = getInitialHitWindowBounds();
    const hitWin = new BrowserWindow({
      width: initialHitWindowBounds.width,
      height: initialHitWindowBounds.height,
      x: initialHitWindowBounds.x,
      y: initialHitWindowBounds.y,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      fullscreenable: false,
      enableLargerThanScreen: true,
      ...(isLinux ? { type: linuxWindowType } : {}),
      ...(isMac ? { type: "panel", roundedCorners: false } : {}),
      // KEY EXPERIMENT: allow activation to avoid WS_EX_NOACTIVATE input
      // routing bugs. Linux keeps the old non-focusable behavior.
      focusable: !isLinux,
      webPreferences: {
        preload: optionsArg.preloadPath,
        backgroundThrottling: false,
        additionalArguments: [
          "--hit-theme-config=" + JSON.stringify(optionsArg.hitThemeConfig),
          "--hit-platform=" + process.platform,
        ],
      },
    });
    // setShape: native hit region, no per-pixel alpha dependency.
    // hitWin has no visual content, so clipping is irrelevant.
    hitWin.setShape([{ x: 0, y: 0, width: initialHitWindowBounds.width, height: initialHitWindowBounds.height }]);
    // I5's single ignore-mouse writer (applyHitInputState()) — baseline at
    // creation is interactive, since all four suppression reasons start
    // false. Passed explicitly because getHitWindow() can't resolve to this
    // window until createHitWindow() returns and the caller assigns it.
    applyHitInputState(hitWin);
    if (isMac) hitWin.setFocusable(false);
    hitWin.showInactive();
    keepOutOfTaskbar(hitWin);
    if (isWin) hitWin.setAlwaysOnTop(true, topmostLevel);
    reapplyMacVisibility();
    hitWin.loadFile(optionsArg.loadFilePath);
    if (isWin && typeof optionsArg.guardAlwaysOnTop === "function") {
      optionsArg.guardAlwaysOnTop(hitWin);
    }
    if (typeof optionsArg.onDidFinishLoad === "function") {
      hitWin.webContents.on("did-finish-load", () => optionsArg.onDidFinishLoad(hitWin));
    }
    hitWin.webContents.on("render-process-gone", (_event, details) => {
      if (typeof optionsArg.onRenderProcessGone === "function") {
        optionsArg.onRenderProcessGone(details, hitWin);
        return;
      }
      reloadRuntimeWindowWebContents(hitWin, { crashKey: "hitWin", details });
    });
    return hitWin;
  }

  // §4.3.10's drag protection-period release point. The plan names two call
  // sites (src/pet-interaction-ipc.js's drag-lock(false) branch and its
  // drag-end finally block) — both call this exact setter with false, so
  // triggering the release on the true->false transition here covers both
  // without pet-interaction-ipc.js needing to know reconcile internals.
  function setDragLocked(value) {
    const next = !!value;
    const wasLocked = dragLocked;
    dragLocked = next;
    if (wasLocked && !next) releaseReconcileProtection();
  }

  function isDragLocked() {
    return dragLocked;
  }

  function beginDragSnapshot() {
    const win = getRenderWindow();
    if (!isLiveWindow(win)) {
      dragSnapshot = null;
      return;
    }
    const bounds = getPetWindowBounds();
    if (!bounds) {
      dragSnapshot = null;
      return;
    }
    // #408: use the effective size (frozen, when keepSizeAcrossDisplays is on)
    // so the drag snapshot follows the frozen invariant instead of re-reading
    // live bounds — keeps every size path on one source of truth.
    const size = getEffectiveCurrentPixelSize();
    dragSnapshot = createDragSnapshot(
      getCursorScreenPoint(),
      bounds,
      size
    );
  }

  function clearDragSnapshot() {
    dragSnapshot = null;
  }

  function moveWindowForDrag() {
    if (!dragLocked) return;
    if (getMiniMode() || getMiniTransitioning()) return;
    if (!isLiveWindow(getRenderWindow())) return;
    if (!dragSnapshot) return;

    const bounds = computeAnchoredDragBounds(
      dragSnapshot,
      getCursorScreenPoint(),
      looseClampPetToDisplays
    );
    if (!bounds) return;

    applyPetWindowBounds(bounds);
    if (isWin && isNearWorkAreaEdge(bounds)) reassertWinTopmost();
    syncHitWin();
    repositionAnchoredSurfaces();
  }

  function hasStoredPositionThemeMismatch(prefs) {
    const theme = getActiveTheme();
    if (!prefs || !theme) return false;
    return prefs.positionThemeId !== theme._id
      || prefs.positionVariantId !== theme._variantId;
  }

  function resolveStartupPlacement(prefs, size, optionsArg = {}) {
    const restoreMiniFromPrefs = optionsArg.restoreMiniFromPrefs || (() => null);
    let startBounds;
    if (prefs.miniMode) {
      startBounds = restoreMiniFromPrefs(prefs, size);
    } else if (prefs.positionSaved) {
      startBounds = { x: prefs.x, y: prefs.y, width: size.width, height: size.height };
    } else {
      const workArea = getPrimaryWorkAreaFallback();
      startBounds = {
        x: workArea.x + workArea.width - size.width - 20,
        y: workArea.y + workArea.height - size.height - 20,
        width: size.width,
        height: size.height,
      };
    }

    const allDisplays = getAllDisplays();
    const savedDisplayStillAttached = !!findMatchingDisplay(
      prefs.positionDisplay,
      allDisplays
    );
    const savedCenterVisible = isPointInAnyWorkArea(
      startBounds.x + startBounds.width / 2,
      startBounds.y + startBounds.height / 2,
      allDisplays
    );
    const startupNeedsRegularize = prefs.positionSaved
      && !prefs.miniMode
      && (
        hasStoredPositionThemeMismatch(prefs)
        || (
          !(savedDisplayStillAttached && savedCenterVisible)
          && needsFinalClampAdjustment(startBounds, size, clampToScreenVisual)
        )
      );
    const startupRegularizedBounds = startupNeedsRegularize
      ? computeFinalDragBounds(startBounds, size, clampToScreenVisual)
      : null;
    const initialVirtualBounds = startupRegularizedBounds || startBounds;
    const initialMaterialized = materializeVirtualBounds(initialVirtualBounds);
    return {
      startBounds,
      startupNeedsRegularize,
      startupRegularizedBounds,
      initialVirtualBounds,
      initialWindowBounds: (initialMaterialized && initialMaterialized.bounds) || initialVirtualBounds,
    };
  }

  function beginSettingsSizePreviewProtection() {
    // settingsSizePreviewSyncFrozen gates the reconcile protection period
    // (§4.3.10) and is set BEFORE the Windows-only early return below on
    // purpose — that protection is effective on Linux too, even though the
    // rest of this function's topmost/hit-ignore behavior is Windows-only.
    settingsSizePreviewSyncFrozen = true;
    if (!isWin) return;
    const settingsWindow = getSettingsWindow();
    if (
      isLiveWindow(settingsWindow)
      && typeof settingsWindow.setAlwaysOnTop === "function"
    ) {
      settingsWindow.setAlwaysOnTop(true, topmostLevel);
      if (typeof settingsWindow.moveTop === "function") settingsWindow.moveTop();
    }
    // I5: route through the single ignore-mouse writer instead of writing
    // hitWin.setIgnoreMouseEvents() directly.
    settingsSizePreviewIgnoringHit = true;
    applyHitInputState();
  }

  function endSettingsSizePreviewProtection() {
    settingsSizePreviewSyncFrozen = false;
    // §4.3.10's protection-period release point. Called BEFORE the
    // Windows-only early return below, mirroring beginSettingsSizePreview
    // Protection()'s freeze flag being set before its own early return —
    // §12.15 flags this exact ordering as the trap: the freeze (and
    // therefore its release) is Linux-effective even though the
    // topmost/hit-ignore behavior past this point is Windows-only.
    releaseReconcileProtection();
    if (!isWin) return;
    const settingsWindow = getSettingsWindow();
    if (
      isLiveWindow(settingsWindow)
      && typeof settingsWindow.setAlwaysOnTop === "function"
    ) {
      settingsWindow.setAlwaysOnTop(false);
    }
    settingsSizePreviewIgnoringHit = false;
    applyHitInputState();
    const hitWin = getHitWindow();
    if (isLiveWindow(hitWin) && typeof hitWin.setAlwaysOnTop === "function") {
      hitWin.setAlwaysOnTop(true, topmostLevel);
    }
    reassertWinTopmost();
    scheduleHwndRecovery();
  }

  function syncFloatingWindowsAfterPetBoundsChange() {
    if (settingsSizePreviewSyncFrozen) return;
    syncHitWin();
    repositionAnchoredSurfaces();
  }

  function rematerializePetAfterTopologyChange() {
    const current = getPetWindowBounds();
    if (!current) return;
    const size = getEffectiveCurrentPixelSize();
    const clamped = clampToScreenVisual(current.x, current.y, size.width, size.height);

    // Only mini transitions defer topology changes: mini caches its workArea
    // for an animation and has an explicit pending-topology consumer at each
    // exit. Normal drag/roam/Settings preview have no equivalent hand-off, so
    // skipping the event could leave this mapping stale indefinitely.
    // syncHitWin() retains its own drag/pointer-capture guard, and the apply
    // below skips a native write whenever the physical rect is unchanged.
    //
    // Topology can change the logical -> physical mapping even when neither
    // the logical clamp nor the live window size changes. In particular, a
    // Linux outer edge can become an internal seam after a display is added:
    // the old physical clamp/viewport offset must then be cleared. Always
    // refresh the materialization snapshot; applyPetWindowBounds() already
    // skips the native setBounds() call when the physical rect is unchanged.
    applyPetWindowBounds({ ...clamped, width: size.width, height: size.height });
    syncHitWin();
  }

  function handleDisplayMetricsChanged() {
    invalidateDisplaysCache();
    // PR #751 second-review C-4 (Codex B4): all three topology events now
    // clear the observed-inset table + any pending candidate (previously
    // only this one did — see main.js's own immediate, non-debounced call
    // to this same method, added by C-6, which is what actually makes this
    // fire promptly for metrics; this call is a self-contained backstop for
    // any caller that invokes this function directly, e.g. tests).
    clearObservedClampInsets();
    reapplyMacVisibility();
    const win = getRenderWindow();
    if (!isLiveWindow(win)) return;
    // §4.5 point 4.5-4: a topology change mid-mini-transition (enter/exit
    // animation in flight) used to be dropped here entirely — reflowing
    // against the OLD topology under the animation would fight the
    // in-progress writes, but doing nothing left mini parked on stale
    // workArea/seam data once the transition settled. Hand it to mini.js
    // instead: it marks pendingTopologyMaterialize and consumes it exactly
    // once at whichever of its own three transition-end points comes next.
    //
    // PR #751 second-review C-5 (Codex B5): also defer during a PEEK
    // animation (isMiniAnimating(), true during miniPeekIn()/miniPeekOut()'s
    // brief slide even though miniMode never leaves "fully mini" and
    // getMiniTransitioning() stays false) — matching runReconcile()'s own
    // protection-period condition exactly (dragLocked/miniTransitioning/
    // isMiniAnimating/settingsSizePreviewSyncFrozen/isRoamAnimating), which
    // already treats a peek as protected. Without this, a topology event
    // mid-peek fell through to the getMiniMode() branch below and
    // re-materialized against the OLD topology WHILE the peek's own
    // in-flight write was still landing, fighting it — the exact class of
    // bug 4.5-4 already fixed for full transitions, just not peeks.
    if (getMiniTransitioning() || isMiniAnimating()) {
      notifyMiniTopologyChangedDuringTransition();
      return;
    }
    if (getMiniMode()) {
      handleMiniDisplayChange();
      return;
    }
    // #408 remains covered by the unconditional logical re-materialization:
    // a Windows sleep/wake size drift is snapped back to the effective size,
    // while a fully unchanged physical rect still avoids a native write.
    rematerializePetAfterTopologyChange();
    repositionAnchoredSurfaces();
  }

  function handleDisplayRemoved() {
    invalidateDisplaysCache();
    // PR #751 second-review C-4 (Codex B4): see handleDisplayMetricsChanged()'s
    // own comment above — display-removed used to leave the inset table
    // untouched entirely, unlike metrics-changed.
    clearObservedClampInsets();
    reapplyMacVisibility();
    const win = getRenderWindow();
    if (!isLiveWindow(win)) return;
    // §4.5 point 4.5-4 (coordinator-directed follow-up, batch 3): the same
    // gap handleDisplayMetricsChanged() had — a topology change landing
    // mid-mini-transition used to be silently dropped here too. Hand it to
    // mini.js the same way: it marks pendingTopologyMaterialize and consumes
    // it exactly once at whichever of its own three transition-end points
    // comes next.
    //
    // PR #751 second-review C-5 (Codex B5): also defer during a peek
    // animation — see handleDisplayMetricsChanged()'s own comment above.
    if (getMiniTransitioning() || isMiniAnimating()) {
      notifyMiniTopologyChangedDuringTransition();
      return;
    }
    if (getMiniMode()) {
      exitMiniMode();
      return;
    }
    rematerializePetAfterTopologyChange();
    repositionAnchoredSurfaces();
  }

  function handleDisplayAdded() {
    invalidateDisplaysCache();
    // PR #751 second-review C-4 (Codex B4): see handleDisplayMetricsChanged()'s
    // own comment above — display-added used to leave the inset table
    // untouched entirely, unlike metrics-changed.
    clearObservedClampInsets();
    reapplyMacVisibility();
    const win = getRenderWindow();
    if (isLiveWindow(win)) {
      // §4.5 point 4.5-4 (coordinator-directed follow-up, batch 3): same
      // hand-off as handleDisplayMetricsChanged()/handleDisplayRemoved()
      // above — this function's own transitioning check used to just skip
      // the mini branch entirely instead of deferring it.
      //
      // PR #751 second-review C-5 (Codex B5): also defer during a peek
      // animation — see handleDisplayMetricsChanged()'s own comment.
      if (getMiniTransitioning() || isMiniAnimating()) {
        notifyMiniTopologyChangedDuringTransition();
      } else if (getMiniMode()) {
        handleMiniDisplayChange();
      } else {
        rematerializePetAfterTopologyChange();
      }
    }
    repositionAnchoredSurfaces();
  }

  return {
    getObjRect,
    getAssetPointerPayload,
    getHitRectScreen,
    getUpdateBubbleAnchorRect,
    getSessionHudAnchorRect,
    getPetWindowBounds,
    applyPetWindowBounds,
    applyPetWindowPosition,
    isPetHidden,
    isPetEffectivelyHidden,
    setPetHidden,
    setFullscreenAutoHidden,
    isFullscreenAutoHidden,
    togglePetVisibility,
    recoverIfCloaked,
    recoverVisiblePetAfterRendererLoad,
    bringPetToPrimaryDisplay,
    getViewportOffsetY,
    setViewportOffsetY,
    getViewportOffsetX,
    setViewportOffsetX,
    resendViewportOffsets,
    getVisibleContentMargins,
    looseClampPetToDisplays,
    clampToScreenVisual,
    clampToScreen,
    computeFinalDragBounds,
    needsFinalClampAdjustment,
    materializeVirtualBounds,
    syncHitWin,
    getInitialHitWindowBounds,
    createRenderWindow,
    createHitWindow,
    reloadWindowWebContents: reloadRuntimeWindowWebContents,
    setDragLocked,
    isDragLocked,
    beginDragSnapshot,
    clearDragSnapshot,
    moveWindowForDrag,
    resolveStartupPlacement,
    beginSettingsSizePreviewProtection,
    endSettingsSizePreviewProtection,
    syncFloatingWindowsAfterPetBoundsChange,
    handleDisplayMetricsChanged,
    handleDisplayRemoved,
    handleDisplayAdded,
    // Issue #690 Phase 2 items 5-8 (batch 2)
    getPhysicalRenderBounds,
    setImeEditingPetDodge,
    onNativeGeometryEvent,
    onHitNativeGeometryEvent,
    releaseReconcileProtection,
    clearObservedClampInsets,
    getObservedClampInset,
    // PR #751 second-review C-6: exposed so main.js's display-metrics-changed
    // listener can invalidate the displays cache IMMEDIATELY, without
    // waiting for handleDisplayMetricsChanged()'s own 400ms geometry-reflow
    // debounce (that function still calls this itself too, redundantly but
    // harmlessly, once it eventually fires).
    invalidateDisplaysCache,
    // PR #751 second-review C-7 (Codex non-blocking): test-only surface —
    // no production caller needs this (runReconcile() is only ever invoked
    // internally, from scheduleReconcile()/scheduleSettleSweep()'s own
    // timers). Exposed specifically so a test can call it with an EXPLICIT,
    // frozen `gen` argument that's deliberately stale relative to the
    // CURRENT writeGen — proving the `gen === writeGen` generation guard
    // itself rejects it, rather than only ever observing that rejection
    // indirectly through a same-rect no-op (which passes regardless of
    // whether the guard does anything at all — see the test this replaces
    // for the finding that motivated this).
    runReconcile,
  };
}

module.exports = createPetWindowRuntime;
