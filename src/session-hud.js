"use strict";

const { BrowserWindow, screen } = require("electron");
const path = require("path");
const { keepOutOfTaskbar } = require("./taskbar");
const { clampTextScale, scaleHeight, applyZoomToWindow } = require("./text-scale");

const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";

const HUD_BORDER_Y = 2;
const HUD_WIDTH = 240;
const HUD_WIDTH_COMPACT = 190;
const HUD_WIDTH_LABELS = 320;
const HUD_WIDTH_LABELS_COMPACT = 260;
const HUD_CONTEXT_USAGE_WIDTH_BUMP = 36;
const HUD_LABELS_ONLY_WIDTH_TRIM = 36;
const HUD_ROW_HEIGHT = 28;
const HUD_MAX_EXPANDED_ROWS = 3;
const HUD_MAX_EXPANDED_ROWS_LABELS = 5;
const HUD_HEIGHT = HUD_ROW_HEIGHT + HUD_BORDER_Y;
const HUD_WINDOW_SHELL = Object.freeze({
  top: 2,
  right: 3,
  bottom: 8,
  left: 3,
});
const HUD_PET_GAP = 4;
const BUBBLE_GAP = 6;
const EDGE_MARGIN = 8;
const WIN_TOPMOST_LEVEL = "pop-up-menu";
const LINUX_WINDOW_TYPE = "toolbar";
const MAC_FLOATING_TOPMOST_DELAY_MS = 120;
const HOT_ZONE_PAD = 24;
const AUTO_HIDE_POLL_MS = 200;
const HIDE_GRACE_MS = 500;
const HIDDEN_WINDOW_DESTROY_MS = 30000;
const HUD_WIDTH_GROWTH_RATIO = 0.4;

function clampToWorkArea(value, min, max) {
  if (max < min) return min;
  return Math.max(min, Math.min(value, max));
}

function isScreenRect(rect) {
  return !!rect
    && Number.isFinite(rect.left)
    && Number.isFinite(rect.top)
    && Number.isFinite(rect.right)
    && Number.isFinite(rect.bottom);
}

function isHudSession(session) {
  return !!session && !session.headless && session.state !== "sleeping" && !session.hiddenFromHud;
}

function snapshotHasVisibleSessions(snapshot) {
  const sessions = Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : [];
  return sessions.some(isHudSession);
}

function evaluateBaseEligible({
  snapshot,
  sessionHudEnabled,
  petHidden,
  miniMode,
  miniTransitioning,
}) {
  if (!snapshot) return false;
  if (sessionHudEnabled === false) return false;
  if (petHidden) return false;
  if (miniMode || miniTransitioning) return false;
  return snapshotHasVisibleSessions(snapshot);
}

function pointInExpandedRect(point, rect, pad) {
  if (!point || !isScreenRect(rect)) return false;
  const p = Number.isFinite(pad) ? pad : 0;
  return point.x >= rect.left - p
    && point.x <= rect.right + p
    && point.y >= rect.top - p
    && point.y <= rect.bottom + p;
}

function computeAutoHideHotZone({ petHitRect, expectedHudContentBounds, pad }) {
  const rects = [];
  if (isScreenRect(petHitRect)) rects.push(petHitRect);
  if (expectedHudContentBounds) {
    const r = expectedHudContentBounds;
    if (Number.isFinite(r.x) && Number.isFinite(r.y)
        && Number.isFinite(r.width) && Number.isFinite(r.height)
        && r.width > 0 && r.height > 0) {
      rects.push({
        left: r.x,
        top: r.y,
        right: r.x + r.width,
        bottom: r.y + r.height,
      });
    } else if (isScreenRect(r)) {
      rects.push(r);
    }
  }
  return { rects, pad: Number.isFinite(pad) ? pad : 0 };
}

function pointInHotZone(point, hotZone) {
  if (!hotZone || !Array.isArray(hotZone.rects)) return false;
  for (const rect of hotZone.rects) {
    if (pointInExpandedRect(point, rect, hotZone.pad)) return true;
  }
  return false;
}

function evaluateShouldShow({
  snapshot,
  sessionHudEnabled,
  sessionHudPinned,
  clickRevealed,
  inHotZone,
  now,
  visibleHoldUntil,
  hideGraceMs,
  petHidden,
  miniMode,
  miniTransitioning,
}) {
  const baseEligible = evaluateBaseEligible({
    snapshot,
    sessionHudEnabled,
    petHidden,
    miniMode,
    miniTransitioning,
  });
  if (!baseEligible) return { show: false, nextHoldUntil: 0 };
  if (sessionHudPinned === true) return { show: true, nextHoldUntil: 0 };
  if (clickRevealed !== true) return { show: false, nextHoldUntil: 0 };

  // revealed 态：hot zone 续命 + grace period
  let nextHoldUntil = Number.isFinite(visibleHoldUntil) ? visibleHoldUntil : 0;
  const tNow = Number.isFinite(now) ? now : 0;
  const grace = Number.isFinite(hideGraceMs) ? hideGraceMs : 0;
  if (inHotZone) {
    nextHoldUntil = tNow + grace;
  }
  const show = inHotZone || tNow < nextHoldUntil;
  return { show, nextHoldUntil };
}

function getHudMaxExpandedRows(showStateLabels = true) {
  return showStateLabels === false ? HUD_MAX_EXPANDED_ROWS : HUD_MAX_EXPANDED_ROWS_LABELS;
}

function computeHudLayout(snapshot, options = {}) {
  const sessions = (snapshot && Array.isArray(snapshot.sessions)) ? snapshot.sessions : [];
  if (sessions.length === 0) return { expanded: [], folded: [], rowCount: 0 };
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const orderedIds = (snapshot && Array.isArray(snapshot.orderedIds))
    ? snapshot.orderedIds
    : sessions.map((s) => s.id);
  const ordered = orderedIds.map((id) => byId.get(id)).filter(Boolean);
  const orderedSet = new Set(ordered.map((s) => s.id));
  const missing = sessions.filter((s) => !orderedSet.has(s.id));
  const visible = ordered.concat(missing).filter(isHudSession);
  const maxExpandedRows = getHudMaxExpandedRows(options.showStateLabels);
  const expanded = visible.slice(0, maxExpandedRows);
  const folded = visible.slice(maxExpandedRows);
  const rowCount = expanded.length + (folded.length > 0 ? 1 : 0);
  return { expanded, folded, rowCount };
}

function computeHudHeight(rowCount) {
  if (!Number.isFinite(rowCount) || rowCount <= 0) return HUD_ROW_HEIGHT;
  return rowCount * HUD_ROW_HEIGHT + HUD_BORDER_Y;
}

function computeHudReservedOffset(cardHeight) {
  const h = Number.isFinite(cardHeight) && cardHeight > 0 ? cardHeight : HUD_ROW_HEIGHT;
  return HUD_PET_GAP + h + HUD_WINDOW_SHELL.bottom + BUBBLE_GAP;
}

function getHudWidthScale(scale) {
  const s = clampTextScale(scale);
  if (s <= 1) return s;
  return 1 + (s - 1) * HUD_WIDTH_GROWTH_RATIO;
}

function computeHudOuterWidth(width, scale, widthScale = scale) {
  const s = clampTextScale(scale);
  const ws = clampTextScale(widthScale);
  return Math.round(width * ws)
    + Math.round(HUD_WINDOW_SHELL.left * s)
    + Math.round(HUD_WINDOW_SHELL.right * s);
}

function computeSessionHudBounds({ hitRect, anchorRect, workArea, width = HUD_WIDTH, height = HUD_HEIGHT, scale = 1, widthScale = scale }) {
  const followRect = isScreenRect(anchorRect) ? anchorRect : hitRect;
  if (!isScreenRect(followRect) || !workArea) return null;
  const followTop = Math.round(followRect.top);
  const followBottom = Math.round(followRect.bottom);
  const followCx = Math.round((followRect.left + followRect.right) / 2);

  // width/height arrive in CSS px (HUD constants); rects are DIP. Convert
  // everything page-rendered before mixing coordinate spaces. Height, shell and
  // gaps keep full textScale, while width can grow more gently so a large-text
  // HUD stays compact instead of turning into a banner.
  const s = clampTextScale(scale);
  const ws = clampTextScale(widthScale);
  const dipWidth = Math.round(width * ws);
  const dipHeight = Math.ceil(height * s);
  const shell = {
    top: Math.round(HUD_WINDOW_SHELL.top * s),
    right: Math.round(HUD_WINDOW_SHELL.right * s),
    bottom: Math.round(HUD_WINDOW_SHELL.bottom * s),
    left: Math.round(HUD_WINDOW_SHELL.left * s),
  };
  const petGap = Math.round(HUD_PET_GAP * s);
  const edgeMargin = Math.round(EDGE_MARGIN * s);

  const outerWidth = dipWidth + shell.left + shell.right;
  const outerHeight = dipHeight + shell.top + shell.bottom;
  const minX = Math.round(workArea.x);
  const maxX = Math.round(workArea.x + workArea.width - dipWidth);
  const x = clampToWorkArea(followCx - Math.round(dipWidth / 2), minX, maxX);

  const belowY = followBottom + petGap;
  const belowMax = workArea.y + workArea.height - edgeMargin;
  if (belowY + dipHeight <= belowMax) {
    const contentBounds = { x, y: belowY, width: dipWidth, height: dipHeight };
    return {
      bounds: {
        x: contentBounds.x - shell.left,
        y: contentBounds.y - shell.top,
        width: outerWidth,
        height: outerHeight,
      },
      contentBounds,
      flippedAbove: false,
    };
  }

  const minY = Math.round(workArea.y + edgeMargin);
  const maxY = Math.round(workArea.y + workArea.height - edgeMargin - dipHeight);
  const aboveY = followTop - dipHeight - petGap;
  const contentBounds = {
    x,
    y: clampToWorkArea(aboveY, minY, maxY),
    width: dipWidth,
    height: dipHeight,
  };
  return {
    bounds: {
      x: contentBounds.x - shell.left,
      y: contentBounds.y - shell.top,
      width: outerWidth,
      height: outerHeight,
    },
    contentBounds,
    flippedAbove: true,
  };
}

function getHudWidth(showElapsed = true, showStateLabels = true, showContextUsage = false) {
  const base = showStateLabels === false
    ? (showElapsed === false ? HUD_WIDTH_COMPACT : HUD_WIDTH)
    : (showElapsed === false ? HUD_WIDTH_LABELS_COMPACT : HUD_WIDTH_LABELS);
  if (showStateLabels !== false && showContextUsage !== true) {
    return Math.max(HUD_WIDTH_COMPACT, base - HUD_LABELS_ONLY_WIDTH_TRIM);
  }
  return showContextUsage === true ? base + HUD_CONTEXT_USAGE_WIDTH_BUMP : base;
}

function deferMacFloatingVisibility(ctx, win) {
  if (!isMac || !win || win.isDestroyed()) return;
  const deferUntil = Date.now() + MAC_FLOATING_TOPMOST_DELAY_MS;
  win.__clawdMacDeferredVisibilityUntil = deferUntil;
  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    if (win.__clawdMacDeferredVisibilityUntil === deferUntil) {
      delete win.__clawdMacDeferredVisibilityUntil;
    }
    if (typeof ctx.reapplyMacVisibility === "function") ctx.reapplyMacVisibility();
  }, MAC_FLOATING_TOPMOST_DELAY_MS);
}

module.exports = function initSessionHud(ctx) {
  let hudWindow = null;
  let didFinishLoad = false;
  let latestSnapshot = null;
  let hudFlippedAbove = false;
  let lastReservedOffset = 0;
  let hiddenDestroyTimer = null;

  function getTextScale() {
    return clampTextScale(typeof ctx.getTextScale === "function" ? ctx.getTextScale() : 1);
  }
  let lastHudHeight = HUD_ROW_HEIGHT;
  let pollTimer = null;
  let clickRevealed = false;
  let visibleHoldUntil = 0;

  function getCurrentSnapshot() {
    return typeof ctx.getSessionSnapshot === "function"
      ? ctx.getSessionSnapshot()
      : { sessions: [], groups: [], orderedIds: [], menuOrderedIds: [] };
  }

  function getMiniMode() {
    return typeof ctx.getMiniMode === "function" && ctx.getMiniMode();
  }

  function getMiniTransitioning() {
    return typeof ctx.getMiniTransitioning === "function" && ctx.getMiniTransitioning();
  }

  function baseEligible(snapshot = latestSnapshot) {
    return evaluateBaseEligible({
      snapshot,
      sessionHudEnabled: ctx.sessionHudEnabled,
      petHidden: ctx.petHidden,
      miniMode: getMiniMode(),
      miniTransitioning: getMiniTransitioning(),
    });
  }

  function shouldShow(snapshot = latestSnapshot) {
    if (!baseEligible(snapshot)) return false;
    if (ctx.sessionHudPinned === true) return true;
    return clickRevealed;
  }

  function isAutoHidePollingNeeded() {
    if (!baseEligible(latestSnapshot)) return false;
    if (ctx.sessionHudPinned === true) return false;
    return clickRevealed === true;
  }

  function computeExpectedHudContentBounds(snapshot, scale = getTextScale()) {
    if (!ctx.win || ctx.win.isDestroyed()) return null;
    const petBounds = typeof ctx.getPetWindowBounds === "function" ? ctx.getPetWindowBounds() : null;
    if (!petBounds) return null;
    const hitRect = typeof ctx.getHitRectScreen === "function"
      ? ctx.getHitRectScreen(petBounds)
      : null;
    const anchorRect = typeof ctx.getSessionHudAnchorRect === "function"
      ? ctx.getSessionHudAnchorRect(petBounds)
      : null;
    const cx = petBounds.x + petBounds.width / 2;
    const cy = petBounds.y + petBounds.height / 2;
    const workArea = typeof ctx.getNearestWorkArea === "function"
      ? ctx.getNearestWorkArea(cx, cy)
      : { x: 0, y: 0, width: 1280, height: 800 };
    const layout = computeHudLayout(snapshot, { showStateLabels: ctx.sessionHudShowStateLabels !== false });
    const height = computeHudHeight(layout.rowCount);
    const width = getHudWidth(
      ctx.sessionHudShowElapsed !== false,
      ctx.sessionHudShowStateLabels !== false,
      ctx.sessionHudShowContextUsage !== false
    );
    const widthScale = getHudWidthScale(scale);
    // Must carry the SAME scale the visible HUD was laid out with — an
    // unscaled expectation makes the auto-hide hot zone smaller than the
    // real window, so the cursor "leaves" while still visually over the HUD
    // (unreachable pin at 150%).
    const computed = computeSessionHudBounds({ hitRect, anchorRect, workArea, width, height, scale, widthScale });
    return { hitRect, contentBounds: computed && computed.contentBounds };
  }

  function evaluateAutoHideCursorNow({ syncOnChange = true } = {}) {
    if (!isAutoHidePollingNeeded()) {
      stopAutoHidePoll();
      return false;
    }
    let cursor = null;
    try {
      cursor = screen.getCursorScreenPoint();
    } catch (_err) {
      cursor = null;
    }
    let inHotZone = false;
    if (cursor) {
      // Single scale resolve for the whole evaluation: expected bounds and
      // pad must describe the same (scaled) HUD the user actually sees.
      const scale = getTextScale();
      const expected = computeExpectedHudContentBounds(latestSnapshot, scale);
      const hotZone = computeAutoHideHotZone({
        petHitRect: expected && expected.hitRect,
        expectedHudContentBounds: expected && expected.contentBounds,
        pad: Math.round(HOT_ZONE_PAD * scale),
      });
      inHotZone = pointInHotZone(cursor, hotZone);
    }
    const now = Date.now();
    const result = evaluateShouldShow({
      snapshot: latestSnapshot,
      sessionHudEnabled: ctx.sessionHudEnabled,
      sessionHudPinned: ctx.sessionHudPinned,
      clickRevealed,
      inHotZone,
      now,
      visibleHoldUntil,
      hideGraceMs: HIDE_GRACE_MS,
      petHidden: ctx.petHidden,
      miniMode: getMiniMode(),
      miniTransitioning: getMiniTransitioning(),
    });
    visibleHoldUntil = result.nextHoldUntil;
    // In revealed state, poll detecting !show means user moved away past grace.
    // Clear clickRevealed so subsequent ticks stop polling.
    const wasRevealed = clickRevealed;
    if (wasRevealed && !result.show && ctx.sessionHudPinned !== true) {
      clickRevealed = false;
      visibleHoldUntil = 0;
      if (syncOnChange) {
        syncSessionHud(latestSnapshot, { sendSnapshot: false });
      }
      return true;
    }
    return false;
  }

  function pollAutoHideCursor() {
    pollTimer = null;
    if (!isAutoHidePollingNeeded()) {
      stopAutoHidePoll();
      return;
    }
    evaluateAutoHideCursorNow();
    schedulePollTick();
  }

  function schedulePollTick() {
    if (pollTimer) return;
    pollTimer = setTimeout(pollAutoHideCursor, AUTO_HIDE_POLL_MS);
  }

  function startAutoHidePoll() {
    evaluateAutoHideCursorNow({ syncOnChange: false });
    if (!isAutoHidePollingNeeded()) return;
    if (!pollTimer) schedulePollTick();
  }

  function stopAutoHidePoll() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    clickRevealed = false;
    visibleHoldUntil = 0;
  }

  function cancelHiddenDestroy() {
    if (!hiddenDestroyTimer) return;
    clearTimeout(hiddenDestroyTimer);
    hiddenDestroyTimer = null;
  }

  function scheduleHiddenDestroy() {
    // Reclaiming the hidden HUD renderer is a low-power-idle-mode behavior;
    // default mode keeps the window warm so reveals stay instant.
    if (!ctx.lowPowerIdleMode) return;
    if (!hudWindow || hudWindow.isDestroyed()) return;
    if (hudWindow.isVisible()) return;
    if (hiddenDestroyTimer) return;
    hiddenDestroyTimer = setTimeout(() => {
      hiddenDestroyTimer = null;
      // Re-check the flag: the user may have left low-power mode while hidden.
      if (!ctx.lowPowerIdleMode) return;
      if (!hudWindow || hudWindow.isDestroyed() || hudWindow.isVisible()) return;
      hudWindow.destroy();
    }, HIDDEN_WINDOW_DESTROY_MS);
  }

  // Internal: clear revealed state without syncing. Caller decides next sync.
  function clearReveal() {
    clickRevealed = false;
    visibleHoldUntil = 0;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  // Public API: user clicked the pet to reveal HUD.
  function revealFromPet() {
    if (!baseEligible(latestSnapshot)) return;
    if (ctx.sessionHudPinned === true) return;     // pinned already always-show
    if (clickRevealed) {
      // Already revealed — refresh grace as a click tolerance.
      visibleHoldUntil = Date.now() + HIDE_GRACE_MS;
      return;
    }
    clickRevealed = true;
    visibleHoldUntil = Date.now() + HIDE_GRACE_MS;  // seed
    syncSessionHud(latestSnapshot, { sendSnapshot: true });
    startAutoHidePoll();
  }

  // Public API: settings effect router calls this when sessionHudPinned flips.
  // Router has already updated ctx.sessionHudPinned before calling.
  function handlePinnedChanged(next) {
    if (next === true) {
      stopAutoHidePoll();
      // Pinned now — HUD always shows via shouldShow. Clear any stale reveal.
      clickRevealed = false;
      visibleHoldUntil = 0;
      syncSessionHud(latestSnapshot);
      return;
    }
    // unpin transition — read real window state, NOT shouldShow() (router
    // already mirrored sessionHudPinned=false so shouldShow would return
    // false and cause the HUD to flash hidden).
    const wasVisible =
      hudWindow && !hudWindow.isDestroyed() && hudWindow.isVisible();
    if (wasVisible && baseEligible(latestSnapshot)) {
      // Seed revealed state so the HUD stays visible until the user moves
      // away (grace period), preserving the on-screen experience.
      clickRevealed = true;
      visibleHoldUntil = Date.now() + HIDE_GRACE_MS;
      startAutoHidePoll();
      syncSessionHud(latestSnapshot);
    } else {
      syncSessionHud(latestSnapshot);
    }
  }

  function syncAutoHidePollLifecycle() {
    if (isAutoHidePollingNeeded()) startAutoHidePoll();
    else stopAutoHidePoll();
  }

  function sendSnapshot(snapshot = latestSnapshot) {
    if (!snapshot || !hudWindow || hudWindow.isDestroyed() || !didFinishLoad) return;
    if (!hudWindow.webContents || hudWindow.webContents.isDestroyed()) return;
    hudWindow.webContents.send("session-hud:session-snapshot", {
      ...snapshot,
      hudShowStateLabels: ctx.sessionHudShowStateLabels !== false,
      hudShowElapsed: ctx.sessionHudShowElapsed !== false,
      hudShowContextUsage: ctx.sessionHudShowContextUsage !== false,
      hudPinned: ctx.sessionHudPinned === true,
    });
  }

  function sendI18n() {
    if (!hudWindow || hudWindow.isDestroyed() || !didFinishLoad) return;
    if (!hudWindow.webContents || hudWindow.webContents.isDestroyed()) return;
    if (typeof ctx.getI18n !== "function") return;
    hudWindow.webContents.send("session-hud:lang-change", ctx.getI18n());
  }

  function ensureSessionHud() {
    cancelHiddenDestroy();
    if (hudWindow && !hudWindow.isDestroyed()) return hudWindow;
    if (!ctx.win || ctx.win.isDestroyed()) return null;

    didFinishLoad = false;
    hudFlippedAbove = false;
    const hudWidth = getHudWidth(
      ctx.sessionHudShowElapsed !== false,
      ctx.sessionHudShowStateLabels !== false,
      ctx.sessionHudShowContextUsage !== false
    );
    // Provisional CSS px → DIP size; syncSessionHud() replaces it with the
    // precise computeSessionHudBounds() result before the window is shown.
    const scale = getTextScale();
    const widthScale = getHudWidthScale(scale);
    hudWindow = new BrowserWindow({
      parent: ctx.win,
      width: computeHudOuterWidth(hudWidth, scale, widthScale),
      height: scaleHeight(HUD_HEIGHT + HUD_WINDOW_SHELL.top + HUD_WINDOW_SHELL.bottom, scale),
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: !isMac,
      focusable: false,
      hasShadow: false,
      backgroundColor: "#00000000",
      ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
      ...(isMac ? { type: "panel" } : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload-session-hud.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    if (isWin) hudWindow.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    if (typeof ctx.guardAlwaysOnTop === "function") ctx.guardAlwaysOnTop(hudWindow);

    hudWindow.loadFile(path.join(__dirname, "session-hud.html"));
    hudWindow.webContents.once("did-finish-load", () => {
      didFinishLoad = true;
      // Explicit even though same-origin propagation usually covers it — a
      // stale partition-persisted factor must never win over prefs.
      applyZoomToWindow(hudWindow, getTextScale());
      sendI18n();
      syncSessionHud();
    });
    hudWindow.on("closed", () => {
      cancelHiddenDestroy();
      hudWindow = null;
      didFinishLoad = false;
      hudFlippedAbove = false;
      notifyReservedOffsetIfChanged();
    });

    return hudWindow;
  }

  function hideSessionHud() {
    hudFlippedAbove = false;
    if (hudWindow && !hudWindow.isDestroyed()) hudWindow.hide();
    notifyReservedOffsetIfChanged();
    scheduleHiddenDestroy();
  }

  function computeBounds(snapshot, scale = getTextScale()) {
    if (!ctx.win || ctx.win.isDestroyed()) return null;
    const petBounds = typeof ctx.getPetWindowBounds === "function" ? ctx.getPetWindowBounds() : null;
    if (!petBounds) return null;
    const hitRect = typeof ctx.getHitRectScreen === "function"
      ? ctx.getHitRectScreen(petBounds)
      : null;
    const anchorRect = typeof ctx.getSessionHudAnchorRect === "function"
      ? ctx.getSessionHudAnchorRect(petBounds)
      : null;
    const cx = petBounds.x + petBounds.width / 2;
    const cy = petBounds.y + petBounds.height / 2;
    const workArea = typeof ctx.getNearestWorkArea === "function"
      ? ctx.getNearestWorkArea(cx, cy)
      : { x: 0, y: 0, width: 1280, height: 800 };
    const layout = computeHudLayout(snapshot, { showStateLabels: ctx.sessionHudShowStateLabels !== false });
    const height = computeHudHeight(layout.rowCount);
    const width = getHudWidth(
      ctx.sessionHudShowElapsed !== false,
      ctx.sessionHudShowStateLabels !== false,
      ctx.sessionHudShowContextUsage !== false
    );
    const widthScale = getHudWidthScale(scale);
    lastHudHeight = height;
    return computeSessionHudBounds({ hitRect, anchorRect, workArea, width, height, scale, widthScale });
  }

  function showSessionHud(win) {
    if (!win || win.isDestroyed() || !didFinishLoad) return;
    cancelHiddenDestroy();
    if (!win.isVisible()) {
      win.showInactive();
      keepOutOfTaskbar(win);
      if (isMac) deferMacFloatingVisibility(ctx, win);
      else if (typeof ctx.reapplyMacVisibility === "function") ctx.reapplyMacVisibility();
    }
    notifyReservedOffsetIfChanged();
  }

  function syncSessionHud(snapshot = latestSnapshot || getCurrentSnapshot(), options = {}) {
    latestSnapshot = snapshot;
    // Defend against stale reveal: if base eligibility dropped (e.g. last
    // session ended), clear any leftover clickRevealed so a future new
    // session does not pop the HUD without a fresh user click.
    if (!baseEligible(snapshot)) {
      clearReveal();
    }
    syncAutoHidePollLifecycle();
    if (!shouldShow(snapshot)) {
      hideSessionHud();
      return;
    }

    const win = ensureSessionHud();
    if (!win || win.isDestroyed()) return;

    // Resolve the scale ONCE per sync and feed the same value to both the
    // zoom injection and the bounds math — two separate reads could disagree
    // mid-display-crossing and produce a scaled window with unzoomed content
    // (or the clipped inverse).
    const scale = getTextScale();
    const computed = computeBounds(snapshot, scale);
    if (!computed) {
      hideSessionHud();
      return;
    }
    applyZoomToWindow(win, scale);
    hudFlippedAbove = !!computed.flippedAbove;
    win.setBounds(computed.bounds);
    if (options.sendSnapshot !== false) sendSnapshot(snapshot);
    showSessionHud(win);
  }

  function broadcastSessionSnapshot(snapshot) {
    syncSessionHud(snapshot);
  }

  function repositionSessionHud() {
    syncSessionHud(latestSnapshot || getCurrentSnapshot(), { sendSnapshot: false });
  }

  function getHudReservedOffset() {
    return readHudReservedOffset();
  }

  function readHudReservedOffset() {
    if (!hudWindow || hudWindow.isDestroyed() || !hudWindow.isVisible()) return 0;
    if (hudFlippedAbove) return 0;
    // computeHudReservedOffset works in CSS px; consumers (bubble avoidance)
    // position windows in DIP.
    return scaleHeight(computeHudReservedOffset(lastHudHeight), getTextScale());
  }

  function notifyReservedOffsetIfChanged() {
    const next = readHudReservedOffset();
    if (next === lastReservedOffset) return;
    lastReservedOffset = next;
    if (typeof ctx.onReservedOffsetChange === "function") ctx.onReservedOffsetChange(next);
  }

  function cleanup() {
    stopAutoHidePoll();
    cancelHiddenDestroy();
    if (hudWindow && !hudWindow.isDestroyed()) hudWindow.destroy();
    hudWindow = null;
    didFinishLoad = false;
    hudFlippedAbove = false;
    lastHudHeight = HUD_ROW_HEIGHT;
    notifyReservedOffsetIfChanged();
  }

  return {
    ensureSessionHud,
    broadcastSessionSnapshot,
    repositionSessionHud,
    syncSessionHud,
    sendI18n,
    getHudReservedOffset,
    cleanup,
    getWindow: () => hudWindow,
    // v5 three-state API
    revealFromPet,
    handlePinnedChanged,
    clearReveal,
  };
};

module.exports.__test = {
  computeSessionHudBounds,
  computeHudLayout,
  getHudMaxExpandedRows,
  computeHudHeight,
  computeHudReservedOffset,
  isHudSession,
  getHudWidth,
  getHudWidthScale,
  computeHudOuterWidth,
  evaluateBaseEligible,
  evaluateShouldShow,
  pointInExpandedRect,
  computeAutoHideHotZone,
  pointInHotZone,
  constants: {
    HUD_WIDTH,
    HUD_WIDTH_COMPACT,
    HUD_WIDTH_LABELS,
    HUD_WIDTH_LABELS_COMPACT,
    HUD_CONTEXT_USAGE_WIDTH_BUMP,
    HUD_LABELS_ONLY_WIDTH_TRIM,
    HUD_HEIGHT,
    HUD_ROW_HEIGHT,
    HUD_MAX_EXPANDED_ROWS,
    HUD_MAX_EXPANDED_ROWS_LABELS,
    HUD_WINDOW_SHELL,
    HUD_PET_GAP,
    BUBBLE_GAP,
    EDGE_MARGIN,
    HUD_BORDER_Y,
    HOT_ZONE_PAD,
    AUTO_HIDE_POLL_MS,
    HIDE_GRACE_MS,
    HIDDEN_WINDOW_DESTROY_MS,
    HUD_WIDTH_GROWTH_RATIO,
  },
};
