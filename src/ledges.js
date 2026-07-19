"use strict";

// Window-ledge tracking for the Gravity toggle (macOS only; other platforms
// gracefully degrade to floor-only physics).
//
// Spawns the clawd-ledges-sidecar (Swift, zero TCC permissions — bounds only,
// never window titles) which streams JSON lines of visible window top-edge
// segments in global top-left coords (Electron's own space on macOS). Keeps
// the latest list for the gravity sim, and — while the pet stands on a ledge —
// rides the window: follows small moves, and drops the pet when the window
// vanishes, jumps far, or slides out from under him.

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { getFootRestInset } = require("./visible-margins");

const STALE_MS = 6000;           // no sidecar line this long ⇒ treat as no data
const RIDE_INTERVAL_MS = 250;
const RIDE_MAX_STEP = 40;        // bigger one-tick window moves ⇒ drop, don't teleport
const MIN_OVERLAP_RATIO = 0.4;
const MAX_RESTARTS = 5;

module.exports = function initLedges(ctx) {
  // Tests inject a fake spawn / platform; production uses child_process and
  // the real process.platform.
  const spawnProcess = typeof ctx.spawn === "function" ? ctx.spawn : spawn;
  const isMacPlatform = ctx.isMacPlatform != null
    ? !!ctx.isMacPlatform
    : process.platform === "darwin";
  let proc = null;
  let ledges = [];
  let lastAt = 0;
  let standing = null;            // { id, pid } of the supporting window
  let rideTimer = null;
  let restarts = 0;
  let stopped = false;
  let gravity = null;

  function sidecarPath() {
    if (typeof ctx.getSidecarPath === "function") return ctx.getSidecarPath();
    try {
      const { app } = require("electron");
      return path.join(app.getPath("userData"), "clawd-ledges-sidecar");
    } catch (_) {
      return null;
    }
  }

  function start() {
    if (!isMacPlatform || proc) return;
    stopped = false;      // re-entrant: the Gravity toggle stops/starts us
    restarts = 0;
    const bin = sidecarPath();
    if (!bin || !fs.existsSync(bin)) return;    // graceful: floor-only physics
    const size = typeof ctx.getEffectiveCurrentPixelSize === "function"
      ? ctx.getEffectiveCurrentPixelSize() : null;
    const petH = size && Number.isFinite(size.height) && size.height > 0 ? size.height : 120;
    try {
      proc = spawnProcess(bin, [String(process.pid), String(Math.round(petH))], {
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (_) {
      proc = null;
      return;
    }
    let buf = "";
    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          if (Array.isArray(msg.ledges)) {
            ledges = msg.ledges;
            lastAt = Date.now();
          }
        } catch (_) { /* partial/garbled line — skip */ }
      }
    });
    proc.on("exit", () => {
      proc = null;
      if (!stopped && restarts < MAX_RESTARTS) {
        restarts += 1;
        setTimeout(start, 2000 * restarts);
      }
    });
    try {
      const { app } = require("electron");
      app.once("will-quit", stop);
    } catch (_) { /* tests */ }
  }

  function stop() {
    stopped = true;
    setStanding(null);
    if (proc) { try { proc.kill(); } catch (_) {} proc = null; }
  }

  // Fresh ledge list (empty when the sidecar is dead/stale).
  function getLedges() {
    if (Date.now() - lastAt > STALE_MS) return [];
    return ledges;
  }

  function getStanding() { return standing; }

  function setStanding(ledge) {
    standing = ledge ? { id: ledge.id, pid: ledge.pid } : null;
    if (standing && !rideTimer) {
      rideTimer = setInterval(rideTick, RIDE_INTERVAL_MS);
    } else if (!standing && rideTimer) {
      clearInterval(rideTimer);
      rideTimer = null;
    }
  }

  // Segments belonging to the window the pet currently stands on.
  function getStandingSegs() {
    if (!standing) return null;
    const segs = getLedges().filter((l) => l.id === standing.id);
    return segs.length ? segs : null;
  }

  function bindGravity(g) { gravity = g; }

  function drop() {
    setStanding(null);
    if (gravity && typeof gravity.startFreeFall === "function") {
      gravity.startFreeFall();
    }
  }

  function rideTick() {
    if (!standing) return;
    if (typeof ctx.isDragLocked === "function" && ctx.isDragLocked()) { setStanding(null); return; }
    if (ctx.getMiniMode && ctx.getMiniMode()) { setStanding(null); return; }
    // Stale sidecar data: hold still rather than dropping on missing info.
    if (Date.now() - lastAt > STALE_MS) return;

    const segs = ledges.filter((l) => l.id === standing.id);
    const bounds = ctx.getPetWindowBounds();
    if (!bounds) return;
    if (!segs.length) { drop(); return; }               // window gone/occluded

    const petBottom = bounds.y + bounds.height - getFootRestInset(bounds.height);
    const delta = segs[0].y - petBottom;
    if (Math.abs(delta) > RIDE_MAX_STEP) { drop(); return; }   // fast move ⇒ fall
    if (Math.round(delta) !== 0) {
      ctx.applyPetWindowBounds({
        x: bounds.x, y: bounds.y + delta,
        width: bounds.width, height: bounds.height,
      });
      if (typeof ctx.syncHitWin === "function") ctx.syncHitWin();
      if (typeof ctx.repositionAnchoredSurfaces === "function") ctx.repositionAnchoredSurfaces();
    }
    // still enough footing?
    const w = bounds.width;
    const supported = segs.some(
      (s) => Math.min(s.x2, bounds.x + w) - Math.max(s.x, bounds.x) >= MIN_OVERLAP_RATIO * w
    );
    if (!supported) drop();
  }

  return { start, stop, getLedges, getStanding, setStanding, getStandingSegs, bindGravity };
};
