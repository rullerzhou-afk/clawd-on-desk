const { BrowserWindow } = require("electron");
const path = require("path");
const { keepOutOfTaskbar } = require("./taskbar");
const { clampTextScale, scaleWidth, scaleHeight, applyZoomToWindow } = require("./text-scale");

const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const WIN_TOPMOST_LEVEL = "pop-up-menu";
const LINUX_WINDOW_TYPE = "toolbar";
// CSS px (multiple of 20 → integral DIP width at every 5% textScale step).
const WIDTH = 340;
const EDGE_MARGIN = 8;
const GAP = 6;
const MAX_WORK_AREA_WIDTH_RATIO = 0.9;
const MAC_FLOATING_TOPMOST_DELAY_MS = 120;

function requiredDependency(value, name, owner) {
  if (!value) throw new Error(`${owner} requires ${name}`);
  return value;
}

function registerUpdateBubbleIpc(options = {}) {
  const ipcMain = requiredDependency(options.ipcMain, "ipcMain", "registerUpdateBubbleIpc");
  const updateBubble = requiredDependency(options.updateBubble, "updateBubble", "registerUpdateBubbleIpc");
  requiredDependency(updateBubble.handleUpdateBubbleHeight, "updateBubble.handleUpdateBubbleHeight", "registerUpdateBubbleIpc");
  requiredDependency(updateBubble.handleUpdateBubbleAction, "updateBubble.handleUpdateBubbleAction", "registerUpdateBubbleIpc");
  const disposers = [];

  function on(channel, listener) {
    ipcMain.on(channel, listener);
    disposers.push(() => ipcMain.removeListener(channel, listener));
  }

  on("update-bubble-height", (event, height) => updateBubble.handleUpdateBubbleHeight(event, height));
  on("update-bubble-action", (event, actionId) => updateBubble.handleUpdateBubbleAction(event, actionId));

  return {
    dispose() {
      while (disposers.length) {
        const dispose = disposers.pop();
        dispose();
      }
    },
  };
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

const FOLLOW_PREFERENCES = new Set(["auto", "left", "right"]);
const FIXED_CORNERS = new Set(["top-left", "top-right", "bottom-left", "bottom-right"]);

function normalizeFollowPreference(value) {
  return FOLLOW_PREFERENCES.has(value) ? value : "auto";
}

function normalizeFixedCorner(value) {
  return FIXED_CORNERS.has(value) ? value : "bottom-right";
}

function isUsableRect(rect) {
  return !!(
    rect
    && Number.isFinite(rect.x)
    && Number.isFinite(rect.y)
    && Number.isFinite(rect.width)
    && rect.width > 0
    && Number.isFinite(rect.height)
    && rect.height > 0
  );
}

function rectsIntersect(a, b) {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

function normalizeAvoidRects(avoidRects) {
  return Array.isArray(avoidRects) ? avoidRects.filter(isUsableRect) : [];
}

function findDirectionalY(rect, avoidRects, workArea, edgeMargin, gap, direction) {
  const minY = workArea.y + edgeMargin;
  const maxY = workArea.y + workArea.height - edgeMargin - rect.height;
  if (maxY < minY) return minY;
  let y = Math.max(minY, Math.min(rect.y, maxY));
  const blockers = normalizeAvoidRects(avoidRects);
  for (let pass = 0; pass <= blockers.length; pass++) {
    const candidate = { ...rect, y };
    const collisions = blockers.filter((blocker) => rectsIntersect(candidate, blocker));
    if (collisions.length === 0) return y;
    if (direction === "down") {
      y = Math.max(...collisions.map((blocker) => blocker.y + blocker.height + gap), y);
    } else {
      y = Math.min(...collisions.map((blocker) => blocker.y - gap - rect.height), y);
    }
    if (y < minY || y > maxY) return null;
  }
  return null;
}

function findNearestY(rect, avoidRects, workArea, edgeMargin, gap) {
  const minY = workArea.y + edgeMargin;
  const maxY = workArea.y + workArea.height - edgeMargin - rect.height;
  if (maxY < minY) return minY;
  const idealY = Math.max(minY, Math.min(rect.y, maxY));
  const blockers = normalizeAvoidRects(avoidRects);
  const candidates = new Set([idealY, minY, maxY]);
  for (const blocker of blockers) {
    if (rect.x >= blocker.x + blocker.width || rect.x + rect.width <= blocker.x) continue;
    candidates.add(blocker.y - gap - rect.height);
    candidates.add(blocker.y + blocker.height + gap);
  }
  return [...candidates]
    .filter((candidate) => Number.isFinite(candidate) && candidate >= minY && candidate <= maxY)
    .sort((a, b) => Math.abs(a - idealY) - Math.abs(b - idealY) || a - b)
    .find((candidate) => {
      const positioned = { ...rect, y: candidate };
      return !blockers.some((blocker) => rectsIntersect(positioned, blocker));
    });
}

function computeUpdateBubbleBounds({
  bubbleFollowPet,
  followPreference = "auto",
  fixedCorner = "bottom-right",
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
  avoidRects = [],
}) {
  const permissionStackOffset = Math.max(0, Number(reservedHeight) || 0);
  const followRect = anchorRect || hitRect;
  const blockers = normalizeAvoidRects(avoidRects);
  const minX = workArea.x;
  const maxX = workArea.x + workArea.width - width;
  const buildFixedCandidate = (corner, allowCollisionFallback = false) => {
    const normalizedCorner = normalizeFixedCorner(corner);
    const left = normalizedCorner.endsWith("left");
    const top = normalizedCorner.startsWith("top");
    const x = left ? workArea.x + edgeMargin : maxX - edgeMargin;
    const idealY = top
      ? workArea.y + edgeMargin
      : workArea.y + workArea.height - edgeMargin - height - permissionStackOffset;
    const baseRect = { x, y: idealY, width, height };
    const y = findDirectionalY(
      baseRect,
      blockers,
      workArea,
      edgeMargin,
      gap,
      top ? "down" : "up"
    );
    if (y !== undefined && y !== null) return { ...baseRect, y };
    if (!allowCollisionFallback) return null;
    return {
      ...baseRect,
      y: Math.max(
        workArea.y + edgeMargin,
        Math.min(idealY, workArea.y + workArea.height - edgeMargin - height)
      ),
    };
  };

  if (bubbleFollowPet && petBounds && followRect) {
    const followTop = Math.round(followRect.top);
    const followRectBottom = Math.round(followRect.bottom);
    const followCx = Math.round((followRect.left + followRect.right) / 2);
    const reserve = Math.max(0, Number(hudReservedOffset) || 0);
    const underPetY = followRectBottom + gap + reserve + permissionStackOffset;
    const abovePetY = followTop - gap - height;
    const workAreaBottom = workArea.y + workArea.height - edgeMargin;
    const followRight = Math.round(followRect.right);
    const followLeft = Math.round(followRect.left);
    const followCy = Math.round((followRect.top + followRect.bottom) / 2);
    const spaceRight = workArea.x + workArea.width - followRight;
    const spaceLeft = followLeft - workArea.x;
    const autoSideOrder = spaceRight >= spaceLeft ? ["right", "left"] : ["left", "right"];
    const preference = normalizeFollowPreference(followPreference);
    const candidateOrder = preference === "left"
      ? ["left", "below", "above", "right"]
      : (preference === "right"
        ? ["right", "below", "above", "left"]
        : ["below", "above", ...autoSideOrder]);

    const tryVertical = (direction) => {
      const x = Math.max(minX, Math.min(followCx - Math.round(width / 2), maxX));
      const idealY = direction === "below" ? underPetY : abovePetY;
      if (direction === "below" && idealY + height > workAreaBottom) return null;
      if (direction === "above" && idealY < workArea.y + edgeMargin) return null;
      const baseRect = { x, y: idealY, width, height };
      const y = findDirectionalY(
        baseRect,
        blockers,
        workArea,
        edgeMargin,
        gap,
        direction === "below" ? "down" : "up"
      );
      return y === undefined || y === null ? null : { ...baseRect, y };
    };

    const trySide = (side) => {
      if (side === "right" && spaceRight < width) return null;
      if (side === "left" && spaceLeft < width) return null;
      const x = side === "right"
        ? Math.min(followRight + gap, maxX)
        : Math.max(minX, followLeft - gap - width);
      const baseRect = {
        x,
        y: followCy - Math.round(height / 2),
        width,
        height,
      };
      const y = findNearestY(baseRect, blockers, workArea, edgeMargin, gap);
      return y === undefined || y === null ? null : { ...baseRect, y };
    };

    for (const candidate of candidateOrder) {
      const result = candidate === "below" || candidate === "above"
        ? tryVertical(candidate)
        : trySide(candidate);
      if (result) return result;
    }
    return buildFixedCandidate("bottom-right", true);
  }

  return buildFixedCandidate(fixedCorner, true);
}

module.exports = function initUpdateBubble(ctx) {
  let bubble = null;
  // CSS px, as reported by the renderer; converted to DIP where consumed.
  let measuredHeight = 0;
  let activePayload = null;
  let resolveAction = null;
  let hideTimer = null;
  let autoCloseTimer = null;
  let visibleSince = 0;

  function notifyOrbitGeometryChanged() {
    const reposition = typeof ctx.repositionQuotaRing === "function"
      ? ctx.repositionQuotaRing
      : ctx.repositionSessionHud;
    if (typeof reposition !== "function") return;
    try { reposition(); } catch {}
  }

  function getTextScale(workArea) {
    return clampTextScale(typeof ctx.getTextScale === "function" ? ctx.getTextScale(workArea) : 1);
  }

  function getTargetWorkArea(petBounds) {
    if (typeof ctx.getBubbleWorkArea === "function") {
      return ctx.getBubbleWorkArea(!!ctx.bubbleFollowPet, petBounds);
    }
    const cx = petBounds.x + petBounds.width / 2;
    const cy = petBounds.y + petBounds.height / 2;
    return ctx.getNearestWorkArea(cx, cy);
  }

  function getAvoidRects() {
    const rects = [];
    for (const getterName of ["getPermissionBubbleBounds", "getSessionHudBounds"]) {
      if (typeof ctx[getterName] !== "function") continue;
      try {
        const value = ctx[getterName]();
        if (Array.isArray(value)) rects.push(...value);
        else if (value) rects.push(value);
      } catch {}
    }
    return rects;
  }

  function ensureBubble() {
    if (bubble && !bubble.isDestroyed()) return bubble;

    const petBounds = ctx.getPetWindowBounds();
    const workArea = getTargetWorkArea(petBounds);
    const scale = getTextScale(workArea);
    bubble = new BrowserWindow({
      width: scaleWidth(WIDTH, scale),
      height: scaleHeight(estimateHeight(activePayload), scale),
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
      notifyOrbitGeometryChanged();
      if (resolveAction) {
        const fallback = activePayload && activePayload.defaultAction != null ? activePayload.defaultAction : null;
        const resolver = resolveAction;
        resolveAction = null;
        resolver({ action: fallback, source: "closed" });
      }
    });

    bubble.webContents.once("did-finish-load", () => {
      // Explicit even though same-origin propagation usually covers it — a
      // stale partition-persisted factor must never win over prefs.
      const petBounds = ctx.getPetWindowBounds();
      applyZoomToWindow(bubble, getTextScale(getTargetWorkArea(petBounds)));
      if (activePayload) bubble.webContents.send("update-bubble-show", activePayload);
    });

    if (typeof ctx.guardAlwaysOnTop === "function") ctx.guardAlwaysOnTop(bubble);
    return bubble;
  }

  function computeBounds(target = null) {
    if (!ctx.win || ctx.win.isDestroyed()) return null;
    const petBounds = target && target.petBounds ? target.petBounds : ctx.getPetWindowBounds();
    const wa = target && target.workArea ? target.workArea : getTargetWorkArea(petBounds);
    const scale = target && Number.isFinite(target.scale) ? target.scale : getTextScale(wa);
    const height = scaleHeight(measuredHeight || estimateHeight(activePayload), scale);
    const anchorRect = ctx.bubbleFollowPet && typeof ctx.getUpdateBubbleAnchorRect === "function"
      ? ctx.getUpdateBubbleAnchorRect(petBounds)
      : null;
    const hitRect = ctx.bubbleFollowPet ? ctx.getHitRectScreen(petBounds) : null;

    return computeUpdateBubbleBounds({
      bubbleFollowPet: ctx.bubbleFollowPet,
      followPreference: ctx.bubbleFollowPreference,
      fixedCorner: ctx.bubbleFixedCorner,
      width: Math.min(scaleWidth(WIDTH, scale), Math.floor(wa.width * MAX_WORK_AREA_WIDTH_RATIO)),
      edgeMargin: Math.round(EDGE_MARGIN * scale),
      gap: Math.round(GAP * scale),
      height,
      reservedHeight: 0,
      hudReservedOffset: 0,
      workArea: wa,
      petBounds,
      anchorRect,
      hitRect,
      avoidRects: getAvoidRects(),
    });
  }

  function repositionUpdateBubble() {
    if (!bubble || bubble.isDestroyed()) return;
    // Resolve the scale ONCE and feed the same value to both the zoom
    // injection and the bounds math (see session-hud syncSessionHud).
    const petBounds = ctx.getPetWindowBounds();
    const workArea = getTargetWorkArea(petBounds);
    const scale = getTextScale(workArea);
    applyZoomToWindow(bubble, scale);
    const bounds = computeBounds({ petBounds, workArea, scale });
    if (bounds) bubble.setBounds(bounds);
  }

  function syncVisibility(hiddenOverride) {
    if (!bubble || bubble.isDestroyed()) return;
    const hidden = typeof hiddenOverride === "boolean" ? hiddenOverride : ctx.petHidden;
    if (hidden) {
      bubble.hide();
      return;
    }
    bubble.showInactive();
    keepOutOfTaskbar(bubble);
    if (isMac) deferMacFloatingVisibility(ctx, bubble);
    else if (typeof ctx.reapplyMacVisibility === "function") ctx.reapplyMacVisibility();
  }

  // Resolve the in-flight bubble promise with a tagged result.
  // source ∈ 'user' | 'autoClose' | 'policy' | 'closed'
  // Callers that consume the resolved value through awaitBubbleAction()
  // in updater.js only see `action` (string), preserving the old contract
  // for non-pending callers. handlePendingVersion reads `source` directly
  // to gate the per-version dedupe store on real user dismissal.
  function settlePrevious(action, source = "user") {
    if (!resolveAction) return;
    const resolver = resolveAction;
    resolveAction = null;
    resolver({ action, source });
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
      if (resolveAction) settlePrevious(fallback, "autoClose");
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
      if (resolveAction) settlePrevious(fallback, "autoClose");
      hideUpdateBubble();
      return false;
    }
    autoCloseTimer = setTimeout(() => {
      autoCloseTimer = null;
      const fallback = activePayload && activePayload.defaultAction != null ? activePayload.defaultAction : null;
      if (resolveAction) settlePrevious(fallback, "autoClose");
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
      settlePrevious(fallback, "closed");
    }
    activePayload = payload;
    if (!policy.enabled) {
      hideUpdateBubble();
      return Promise.resolve({ action: fallback, source: "policy" });
    }
    const win = ensureBubble();

    const send = () => {
      measuredHeight = 0;
      repositionUpdateBubble();
      if (win && !win.isDestroyed()) {
        win.webContents.send("update-bubble-show", payload);
        syncVisibility();
        notifyOrbitGeometryChanged();
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
      return Promise.resolve({ action: fallback, source: "autoClose" });
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
      if (bubble && !bubble.isDestroyed()) {
        bubble.hide();
        notifyOrbitGeometryChanged();
      }
    }, 250);
  }

  function hideForPolicy() {
    if (resolveAction) {
      const fallback = activePayload && activePayload.defaultAction != null ? activePayload.defaultAction : null;
      settlePrevious(fallback, "policy");
    }
    hideUpdateBubble();
  }

  function resolveCurrentAction(actionId) {
    if (!resolveAction) return;
    const resolver = resolveAction;
    resolveAction = null;
    resolver({ action: actionId, source: "user" });
  }

  function handleUpdateBubbleAction(event, actionId) {
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    if (!bubble || senderWin !== bubble) return;
    if (actionId === "copy-error") {
      const feedback = activePayload && activePayload.copyFeedback || {};
      let status = "ok";
      try {
        if (!ctx.clipboard || typeof ctx.clipboard.writeText !== "function") {
          throw new Error("clipboard unavailable");
        }
        ctx.clipboard.writeText(String(activePayload && activePayload.copyText || ""));
      } catch (_) {
        status = "error";
      }
      if (bubble && !bubble.isDestroyed()) {
        bubble.webContents.send("update-bubble-copy-result", {
          status,
          label: status === "ok" ? feedback.copied : feedback.failed,
        });
      }
      return;
    }
    hideUpdateBubble();
    resolveCurrentAction(actionId);
  }

  function handleUpdateBubbleHeight(event, height) {
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    if (!bubble || senderWin !== bubble) return;
    if (typeof height === "number" && height > 0) {
      measuredHeight = Math.ceil(height);
      repositionUpdateBubble();
      notifyOrbitGeometryChanged();
    }
  }

  function cleanup() {
    if (hideTimer) clearTimeout(hideTimer);
    clearAutoCloseTimer();
    settlePrevious(activePayload && activePayload.defaultAction != null ? activePayload.defaultAction : null, "closed");
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

module.exports.registerUpdateBubbleIpc = registerUpdateBubbleIpc;

module.exports.__test = {
  computeAutoCloseRemainingMs,
  computeUpdateBubbleBounds,
  estimateHeight,
};
