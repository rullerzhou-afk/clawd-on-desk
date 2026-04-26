const { BrowserWindow } = require("electron");
const path = require("path");
const { keepOutOfTaskbar } = require("./taskbar");

const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const WIN_TOPMOST_LEVEL = "pop-up-menu";
const LINUX_WINDOW_TYPE = "toolbar";
const WIDTH = 340;
const EDGE_MARGIN = 8;
const GAP = 6;
const MAC_FLOATING_TOPMOST_DELAY_MS = 120;

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

function getPolicy(ctx) {
  if (typeof ctx.getBubblePolicy === "function") {
    try {
      const policy = ctx.getBubblePolicy("update");
      if (policy && typeof policy.enabled === "boolean") return policy;
    } catch {}
  }
  return { enabled: true, autoCloseMs: 0 };
}

function estimateHeight(payload) {
  let height = payload && payload.mode === "error" ? 220 : 150;
  if (payload && payload.message) {
    const messageLines = String(payload.message).split(/\r?\n/).length;
    height += Math.max(0, messageLines - 1) * 16;
  }
  if (payload && payload.detail) {
    const detailText = String(payload.detail);
    const detailLines = detailText.split(/\r?\n/).length;
    const wrappedLines = Math.ceil(detailText.length / 72);
    height += Math.min(220, 32 + detailLines * 16 + wrappedLines * 6);
  }
  if (payload && Array.isArray(payload.actions) && payload.actions.length) height += 44;
  return height;
}

function computeAutoCloseRemainingMs(shownAt, autoCloseMs, now = Date.now()) {
  const totalMs = Number(autoCloseMs);
  if (!Number.isFinite(totalMs) || totalMs <= 0) return 0;
  const startedAt = Number(shownAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return totalMs;
  return Math.max(0, totalMs - Math.max(0, now - startedAt));
}

function computeUpdateBubbleBounds({
  bubbleFollowPet,
  width,
  edgeMargin,
  gap,
  height,
  reservedHeight,
  hudReservedOffset = 0,
  workArea,
  petBounds,
  anchorRect,
  hitRect,
}) {
  const permissionStackOffset = Math.max(0, Number(reservedHeight) || 0);
  let x = workArea.x + workArea.width - width - edgeMargin;
  let y = workArea.y + workArea.height - edgeMargin - height - permissionStackOffset;

  const followRect = anchorRect || hitRect;

  if (bubbleFollowPet && petBounds && followRect) {
    const followTop = Math.round(followRect.top);
    const followRectBottom = Math.round(followRect.bottom);
    const followCx = Math.round((followRect.left + followRect.right) / 2);
    const reserve = Math.max(0, Number(hudReservedOffset) || 0);
    const underPetY = followRectBottom + gap + reserve + permissionStackOffset;
    const abovePetY = followTop - gap - height;
    const workAreaBottom = workArea.y + workArea.height - edgeMargin;
    const maxY = workAreaBottom - height;

    if (underPetY + height <= workAreaBottom) {
      x = Math.max(workArea.x, Math.min(followCx - Math.round(width / 2), workArea.x + workArea.width - width));
      y = underPetY;
    } else if (abovePetY >= workArea.y + edgeMargin) {
      x = Math.max(workArea.x, Math.min(followCx - Math.round(width / 2), workArea.x + workArea.width - width));
      y = abovePetY;
    } else {
      const followRight = Math.round(followRect.right);
      const followLeft = Math.round(followRect.left);
      const followCy = Math.round((followRect.top + followRect.bottom) / 2);
      const spaceRight = workArea.x + workArea.width - followRight;
      const spaceLeft = followLeft - workArea.x;
      if (spaceRight >= width || spaceRight >= spaceLeft) {
        x = Math.min(followRight + gap, workArea.x + workArea.width - width);
      } else {
        x = Math.max(workArea.x, followLeft - gap - width);
      }
      y = Math.max(
        workArea.y + edgeMargin,
        Math.min(followCy - Math.round(height / 2), maxY)
      );
    }
  }

  y = Math.max(workArea.y + edgeMargin, y);
  return { x, y, width, height };
}

module.exports = function initUpdateBubble(ctx) {
  let bubble = null;
  let measuredHeight = 0;
  let activePayload = null;
  let resolveAction = null;
  let hideTimer = null;
  let autoCloseTimer = null;
  let visibleSince = 0;

  function getPermissionStackHeight() {
    const pending = typeof ctx.getPendingPermissions === "function" ? ctx.getPendingPermissions() : [];
    let total = 0;
    for (const perm of pending) {
      if (!perm || !perm.bubble || perm.bubble.isDestroyed() || !perm.bubble.isVisible()) continue;
      total += perm.measuredHeight || 200;
      total += GAP;
    }
    return total;
  }

  function ensureBubble() {
    if (bubble && !bubble.isDestroyed()) return bubble;

    bubble = new BrowserWindow({
      width: WIDTH,
      height: estimateHeight(activePayload),
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: !isMac,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
      ...(isMac ? { type: "panel" } : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload-update-bubble.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    if (isWin) bubble.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);

    bubble.loadFile(path.join(__dirname, "update-bubble.html"));
    bubble.on("closed", () => {
      bubble = null;
      measuredHeight = 0;
      if (resolveAction) {
        const fallback = activePayload && activePayload.defaultAction != null ? activePayload.defaultAction : null;
        const resolver = resolveAction;
        resolveAction = null;
        resolver(fallback);
      }
    });

    bubble.webContents.once("did-finish-load", () => {
      if (activePayload) bubble.webContents.send("update-bubble-show", activePayload);
    });

    if (typeof ctx.guardAlwaysOnTop === "function") ctx.guardAlwaysOnTop(bubble);
    return bubble;
  }

  function computeBounds() {
    if (!ctx.win || ctx.win.isDestroyed()) return null;
    const petBounds = ctx.getPetWindowBounds();
    const cx = petBounds.x + petBounds.width / 2;
    const cy = petBounds.y + petBounds.height / 2;
    const wa = ctx.getNearestWorkArea(cx, cy);
    const height = measuredHeight || estimateHeight(activePayload);
    const reservedHeight = getPermissionStackHeight();
    const anchorRect = ctx.bubbleFollowPet && typeof ctx.getUpdateBubbleAnchorRect === "function"
      ? ctx.getUpdateBubbleAnchorRect(petBounds)
      : null;
    const hitRect = ctx.bubbleFollowPet ? ctx.getHitRectScreen(petBounds) : null;

    return computeUpdateBubbleBounds({
      bubbleFollowPet: ctx.bubbleFollowPet,
      width: WIDTH,
      edgeMargin: EDGE_MARGIN,
      gap: GAP,
      height,
      reservedHeight,
      hudReservedOffset: typeof ctx.getHudReservedOffset === "function" ? ctx.getHudReservedOffset() : 0,
      workArea: wa,
      petBounds,
      anchorRect,
      hitRect,
    });
  }

  function repositionUpdateBubble() {
    if (!bubble || bubble.isDestroyed()) return;
    const bounds = computeBounds();
    if (bounds) bubble.setBounds(bounds);
  }

  function syncVisibility() {
    if (!bubble || bubble.isDestroyed()) return;
    if (ctx.petHidden) {
      bubble.hide();
      return;
    }
    bubble.showInactive();
    keepOutOfTaskbar(bubble);
    if (isMac) deferMacFloatingVisibility(ctx, bubble);
    else if (typeof ctx.reapplyMacVisibility === "function") ctx.reapplyMacVisibility();
  }

  function settlePrevious(actionId) {
    if (!resolveAction) return;
    const resolver = resolveAction;
    resolveAction = null;
    resolver(actionId);
  }

  function clearAutoCloseTimer() {
    if (autoCloseTimer) {
      clearTimeout(autoCloseTimer);
      autoCloseTimer = null;
    }
  }

  function scheduleAutoClose(payload) {
    clearAutoCloseTimer();
    const policy = getPolicy(ctx);
    if (!policy.enabled || !(policy.autoCloseMs > 0)) return;
    visibleSince = Date.now();
    autoCloseTimer = setTimeout(() => {
      autoCloseTimer = null;
      const fallback = payload && payload.defaultAction != null ? payload.defaultAction : null;
      if (resolveAction) settlePrevious(fallback);
      hideUpdateBubble();
    }, policy.autoCloseMs);
  }

  function refreshAutoCloseForPolicy() {
    if (!bubble || bubble.isDestroyed() || !activePayload) return false;
    clearAutoCloseTimer();
    const policy = getPolicy(ctx);
    if (!policy.enabled || !(policy.autoCloseMs > 0)) {
      hideForPolicy();
      return false;
    }
    const remainingMs = computeAutoCloseRemainingMs(visibleSince, policy.autoCloseMs, Date.now());
    if (remainingMs <= 0) {
      const fallback = activePayload && activePayload.defaultAction != null ? activePayload.defaultAction : null;
      if (resolveAction) settlePrevious(fallback);
      hideUpdateBubble();
      return false;
    }
    autoCloseTimer = setTimeout(() => {
      autoCloseTimer = null;
      const fallback = activePayload && activePayload.defaultAction != null ? activePayload.defaultAction : null;
      if (resolveAction) settlePrevious(fallback);
      hideUpdateBubble();
    }, remainingMs);
    return true;
  }

  function showUpdateBubble(payload) {
    const policy = getPolicy(ctx);
    const fallback = payload && payload.defaultAction != null ? payload.defaultAction : null;
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    clearAutoCloseTimer();
    if (resolveAction) {
      settlePrevious(fallback);
    }
    activePayload = payload;
    if (!policy.enabled) {
      hideUpdateBubble();
      return Promise.resolve(fallback);
    }
    const win = ensureBubble();

    const send = () => {
      measuredHeight = 0;
      repositionUpdateBubble();
      if (win && !win.isDestroyed()) {
        win.webContents.send("update-bubble-show", payload);
        syncVisibility();
        scheduleAutoClose(payload);
      }
    };

    if (win.webContents.isLoading()) {
      win.webContents.once("did-finish-load", send);
    } else {
      send();
    }

    if (!payload.requireAction) {
      resolveAction = null;
      return Promise.resolve(fallback);
    }

    return new Promise((resolve) => {
      resolveAction = resolve;
    });
  }

  function hideUpdateBubble() {
    if (!bubble || bubble.isDestroyed()) return;
    bubble.webContents.send("update-bubble-hide");
    clearAutoCloseTimer();
    visibleSince = 0;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (bubble && !bubble.isDestroyed()) bubble.hide();
    }, 250);
  }

  function hideForPolicy() {
    if (resolveAction) {
      const fallback = activePayload && activePayload.defaultAction != null ? activePayload.defaultAction : null;
      settlePrevious(fallback);
    }
    hideUpdateBubble();
  }

  function resolveCurrentAction(actionId) {
    if (!resolveAction) return;
    const resolver = resolveAction;
    resolveAction = null;
    resolver(actionId);
  }

  function handleUpdateBubbleAction(event, actionId) {
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    if (!bubble || senderWin !== bubble) return;
    hideUpdateBubble();
    resolveCurrentAction(actionId);
  }

  function handleUpdateBubbleHeight(event, height) {
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    if (!bubble || senderWin !== bubble) return;
    if (typeof height === "number" && height > 0) {
      measuredHeight = Math.ceil(height);
      repositionUpdateBubble();
    }
  }

  function cleanup() {
    if (hideTimer) clearTimeout(hideTimer);
    clearAutoCloseTimer();
    settlePrevious(activePayload && activePayload.defaultAction != null ? activePayload.defaultAction : null);
    if (bubble && !bubble.isDestroyed()) bubble.destroy();
    bubble = null;
  }

  return {
    showUpdateBubble,
    hideUpdateBubble,
    repositionUpdateBubble,
    handleUpdateBubbleAction,
    handleUpdateBubbleHeight,
    syncVisibility,
    hideForPolicy,
    refreshAutoCloseForPolicy,
    cleanup,
    getBubbleWindow: () => bubble,
  };
};

module.exports.__test = {
  computeAutoCloseRemainingMs,
  computeUpdateBubbleBounds,
  estimateHeight,
};
