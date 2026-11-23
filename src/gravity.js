"use strict";

// src/gravity.js — a drag released in mid-air makes the pet fall to the floor
// instead of hanging there.
//
// Same frame loop as roam.js: applyPetWindowBounds every 16 ms with the size
// frozen at the start (#569), hit window and anchored surfaces synced per frame.
//
// Floors per display: the taskbar one (lowest resting spot) and an optional
// shelf set with Shift+release, stored in ~/.clawd/gravity-floor.json as its
// height above the taskbar floor. The shelf is one-way: it only catches a pet
// coming down onto it, and below it the pet falls to the taskbar. The same
// file keeps the on/off switch from the Gravity menu (off by default).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createTranslator } = require("./i18n");

const GRAVITY_PX_PER_S2 = 2800;
const MAX_FALL_SPEED_PX_PER_S = 2400;
const FRAME_MS = 16;
// A late frame advances the fall by at most this much.
const MAX_FRAME_MS = 32;
const MIN_DROP_PX = 2;
// Released this close below the shelf still counts as standing on it.
const SHELF_TOLERANCE_PX = 2;
const FLOOR_FILE = path.join(os.homedir(), ".clawd", "gravity-floor.json");
// Landing squash intensity (0..1) follows the impact speed: no squash up to a
// ~40 px drop, full squash from ~500 px (v = sqrt(2 * g * h)).
const SQUASH_MIN_SPEED = Math.sqrt(2 * GRAVITY_PX_PER_S2 * 40);
const SQUASH_FULL_SPEED = Math.sqrt(2 * GRAVITY_PX_PER_S2 * 500);

function landingIntensity(speed) {
  const k = (speed - SQUASH_MIN_SPEED) / (SQUASH_FULL_SPEED - SQUASH_MIN_SPEED);
  return Math.round(Math.min(1, Math.max(0, k)) * 100) / 100;
}

// One fall step: gravity up to the maximum fall speed, exact over the frame
// (accelerating, then steady), so the impact speed matches the drop height.
function advanceFall(motion, elapsedMs) {
  const duration = Math.max(0, elapsedMs) / 1000;
  const accelerating = Math.min(
    duration,
    Math.max(0, (MAX_FALL_SPEED_PX_PER_S - motion.vy) / GRAVITY_PX_PER_S2),
  );
  const vy = Math.min(motion.vy + GRAVITY_PX_PER_S2 * accelerating, MAX_FALL_SPEED_PX_PER_S);
  const y = motion.y
    + ((motion.vy + vy) / 2) * accelerating
    + MAX_FALL_SPEED_PX_PER_S * (duration - accelerating);
  return { y, vy };
}

// Display bounds as the key: stable across restarts while the monitor layout stays the same.
function electronDisplayKey(x, y) {
  try {
    const { screen } = require("electron");
    const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
    const b = display && display.bounds;
    return b ? `${b.x},${b.y},${b.width}x${b.height}` : null;
  } catch {
    return null;
  }
}

module.exports = function initGravity(ctx, options = {}) {
  const floorFile = options.floorFile || FLOOR_FILE;
  const getDisplayKey = options.getDisplayKey || electronDisplayKey;
  const now = options.now || (() => performance.now());
  // Menu labels in the app's language; English when no translator is given.
  const translate = options.t || createTranslator(() => "en");
  const saved = loadState();
  let enabled = saved.enabled === true;
  let floors = saved.floors;
  let falling = false;
  let fallTimer = null;
  let onFallEnd = null;
  let defaultFallEnd = null;

  function loadState() {
    try {
      const data = JSON.parse(fs.readFileSync(floorFile, "utf8"));
      return {
        enabled: !!(data && data.enabled === true),
        floors: data && data.floors && typeof data.floors === "object" ? data.floors : {},
      };
    } catch {
      return { enabled: false, floors: {} };
    }
  }

  function saveState() {
    try {
      fs.mkdirSync(path.dirname(floorFile), { recursive: true });
      const tmp = `${floorFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, enabled, floors }, null, 2));
      fs.renameSync(tmp, floorFile);
    } catch (err) {
      console.warn("Clawd gravity: floor not saved:", err && err.message);
    }
  }

  function isWindowAlive() {
    return !!(ctx.win && !ctx.win.isDestroyed());
  }

  function isMiniBusy() {
    return !!((ctx.getMiniMode && ctx.getMiniMode()) || ctx.miniTransitioning);
  }

  function frozenSize(bounds) {
    const size = typeof ctx.getEffectiveCurrentPixelSize === "function"
      ? ctx.getEffectiveCurrentPixelSize()
      : null;
    return {
      width: size && Number.isFinite(size.width) && size.width > 0 ? size.width : bounds.width,
      height: size && Number.isFinite(size.height) && size.height > 0 ? size.height : bounds.height,
    };
  }

  // Floors and top of the display where the pet is, all from the rest clamp it
  // already obeys, edge pinning included (as if dragged against each edge).
  // shelfY is null without a custom floor there.
  function resolveArea(bounds) {
    const { width, height } = frozenSize(bounds);
    const cx = bounds.x + width / 2;
    const cy = bounds.y + height / 2;
    const wa = ctx.getNearestWorkArea(cx, cy);
    if (!wa) return null;
    const rest = (x, y) => ctx.clampToScreenVisual(x, y, width, height, { workArea: wa });
    const lowest = rest(bounds.x, wa.y + wa.height);
    const highest = rest(bounds.x, wa.y - height);
    const valid = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);
    if (![lowest, highest].every(valid)) return null;
    const taskbarY = Math.round(lowest.y);
    const topY = Math.round(highest.y);
    const key = getDisplayKey(cx, cy);
    const savedFloor = key ? floors[key] : null;
    let shelfY = null;
    if (savedFloor && Number.isFinite(savedFloor.heightAboveTaskbar) && savedFloor.heightAboveTaskbar > 0) {
      shelfY = Math.max(topY, taskbarY - Math.round(savedFloor.heightAboveTaskbar));
    }
    return {
      width,
      height,
      key,
      taskbarY,
      shelfY,
    };
  }

  function finish(landed, landing) {
    if (fallTimer) {
      clearTimeout(fallTimer);
      fallTimer = null;
    }
    if (!falling) return;
    falling = false;
    // Same release point as roam: a reconcile marked dirty mid-fall runs now.
    if (typeof ctx.releaseReconcileProtection === "function") ctx.releaseReconcileProtection();
    const callback = onFallEnd;
    onFallEnd = null;
    if (typeof callback === "function") callback(landed, landing || null);
  }

  // Drops the pet onto the floor below it. Returns true when it left the
  // ground. onEnd(landed, landing) runs once at the end (defaults to the
  // setFallEndHandler one); landed is false (landing null) when the pet was
  // caught mid-air or the fall was interrupted, otherwise landing = { intensity }.
  function startFall(onEnd) {
    if (!enabled || falling || !isWindowAlive() || isMiniBusy()) return false;
    const start = ctx.getPetWindowBounds();
    if (!start) return false;
    const area = resolveArea(start);
    if (!area) return false;
    const { width, height } = area;
    // On or above the shelf it lands there; below it, on the taskbar floor.
    const onShelfSide = area.shelfY !== null && start.y <= area.shelfY + SHELF_TOLERANCE_PX;
    const floorY = onShelfSide ? area.shelfY : area.taskbarY;
    if (floorY - start.y < MIN_DROP_PX) return false;

    falling = true;
    onFallEnd = onEnd || defaultFallEnd;
    let motion = { y: start.y, vy: 0 };
    let lastTick = now();
    let frameCount = 0;

    function place(x, y, final) {
      ctx.applyPetWindowBounds({ x: Math.round(x), y: Math.round(y), width, height });
      if (typeof ctx.syncHitWin === "function") ctx.syncHitWin();
      if (typeof ctx.repositionAnchoredSurfaces === "function") ctx.repositionAnchoredSurfaces();
      if (
        typeof ctx.repositionBubbles === "function"
        && ctx.bubbleFollowPet
        && ctx.pendingPermissions
        && ctx.pendingPermissions.length
        && (++frameCount % 3 === 0 || final)
      ) {
        ctx.repositionBubbles();
      }
    }

    function step() {
      fallTimer = null;
      if (!falling) return;
      // Caught mid-air (the new drag owns the window), mini mode or shutdown.
      if (!isWindowAlive() || ctx.dragLocked || isMiniBusy()) {
        finish(false);
        return;
      }
      const t = now();
      const elapsed = Math.min(MAX_FRAME_MS, Math.max(0, t - lastTick));
      lastTick = t;
      const previousY = motion.y;
      const next = advanceFall(motion, elapsed);
      if (next.y >= floorY) {
        // Speed when touching down (v² = v0² + 2gh), not at the end of the
        // frame, which already overshot the floor by up to 32 ms.
        const impact = Math.min(
          MAX_FALL_SPEED_PX_PER_S,
          Math.sqrt(Math.max(0, motion.vy * motion.vy + 2 * GRAVITY_PX_PER_S2 * (floorY - previousY))),
        );
        place(start.x, floorY, true);
        finish(true, { intensity: landingIntensity(impact) });
        return;
      }
      motion = next;
      place(start.x, motion.y, false);
      fallTimer = setTimeout(step, FRAME_MS);
    }

    // Deferred first frame: drag-end may still hold the drag lock until its finally block.
    fallTimer = setTimeout(step, FRAME_MS);
    return true;
  }

  // A new drag catches a falling pet at once, so the held end of the old drag
  // reaction goes out before the new drag starts its own.
  function beginDrag() {
    cancel();
  }

  // End of a drag: the pet drops onto the floor below it.
  function release(onEnd) {
    return startFall(onEnd);
  }

  // Shift+release: the current height becomes this display's floor. Released
  // on (or below) the taskbar floor, it clears the custom floor instead.
  function setFloorHere() {
    if (!enabled) return false;
    const bounds = ctx.getPetWindowBounds();
    const here = bounds && resolveArea(bounds);
    if (!here || !here.key) return false;
    const heightAboveTaskbar = Math.round(here.taskbarY - bounds.y);
    if (heightAboveTaskbar <= SHELF_TOLERANCE_PX) delete floors[here.key];
    else floors[here.key] = { heightAboveTaskbar };
    saveState();
    return true;
  }

  function hasCustomFloor() {
    const bounds = ctx.getPetWindowBounds();
    const here = bounds && resolveArea(bounds);
    return !!(here && here.shelfY !== null);
  }

  // The shelf goes away: a pet standing on it drops to the taskbar.
  function resetFloor() {
    const bounds = ctx.getPetWindowBounds();
    const here = bounds && resolveArea(bounds);
    if (!here || !here.key || !floors[here.key]) return false;
    delete floors[here.key];
    saveState();
    startFall();
    return true;
  }

  // Off: stops a fall where it is. On: a pet left in mid-air drops right away.
  function setEnabled(value) {
    const next = !!value;
    if (next === enabled) return;
    enabled = next;
    saveState();
    if (enabled) startFall();
    else cancel();
  }

  function isEnabled() {
    return enabled;
  }

  function buildMenuItem() {
    return {
      label: translate("gravity"),
      submenu: [
        { label: translate("gravityFallWhenReleased"), type: "checkbox", checked: enabled, click: () => setEnabled(!enabled) },
        { type: "separator" },
        { label: translate("gravitySetFloorHint"), enabled: false },
        {
          label: translate("gravityResetFloor"),
          enabled: enabled && hasCustomFloor(),
          click: () => resetFloor(),
        },
      ],
    };
  }

  function setFallEndHandler(handler) {
    defaultFallEnd = typeof handler === "function" ? handler : null;
  }

  function cancel() {
    finish(false);
  }

  function isFalling() {
    return falling;
  }

  return {
    startFall,
    release,
    beginDrag,
    cancel,
    isFalling,
    setFloorHere,
    hasCustomFloor,
    resetFloor,
    setEnabled,
    isEnabled,
    buildMenuItem,
    setFallEndHandler,
  };
};
