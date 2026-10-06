// src/tick.js — Main tick loop (cursor polling, eye tracking, idle/sleep detection, mini peek)
// Extracted from main.js L527-689

const { screen } = require("electron");

module.exports = function initTick(ctx) {

const random = typeof ctx.random === "function" ? ctx.random : Math.random;
const now = typeof ctx.now === "function" ? ctx.now : Date.now;

// ── Mouse idle tracking ──
let lastCursorX = null, lastCursorY = null;
let mouseStillSince = Date.now();
let isMouseIdle = false;       // showing idle-look
let hasTriggeredYawn = false;  // 60s threshold already fired
let idleLookPlayed = false;    // idle-look already played once since last movement
let idleLookReturnTimer = null;
let idleLookVisualGeneration = null;
let idleLookAttempt = null;
let yawnDelayTimer = null;     // tracked setTimeout for yawn/idle-look transitions
let idleWasActive = false;
let lastEyeDx = 0, lastEyeDy = 0;
let lastPointerBridgeKey = null;
let lastPointerBridgePayload = null;
let mainTickTimer = null;
let mainTickActive = false;
let nextMainTickAt = 0;

// ── Spin detection: tracks cursor circling to trigger dizzy animation ──
let lastCursorAngle = null;             // last cursor angle (radians) relative to eye-tracking origin
let accumulatedSpin = 0;                // signed accumulated angular displacement
let dizzyCooldownUntil = 0;             // timestamp until which dizzy cannot re-trigger
let lastSpinTickAt = 0;                 // timestamp of last spin tick

const SPIN_THRESHOLD = Math.PI * 4;     // 2 full circles (signed) to trigger dizzy
const SPIN_IDLE_RESET_MS = 500;         // a pause longer than this resets the spin meter
const SPIN_MIN_RADIUS = 24;             // cursor must be this many px from center to count
const DIZZY_COOLDOWN_MS = 12000;        // can't re-trigger dizzy for 12s

const FAST_TICK_MS = 50;
const BOOST_TICK_MS = 100;
const IDLE_TICK_MS = 250;
// Keep a low-rate cursor probe so new movement can leave the paused state.
const LOW_POWER_IDLE_TICK_MS = 1000;
const LOW_POWER_MINI_IDLE_TICK_MS = 2000;
const REACTION_TICK_MS = 500;
const BACKGROUND_TICK_MS = 750;
const RECENT_MOUSE_MS = 2000;
const POINTER_BRIDGE_STATES = new Set(["idle", "mini-idle", "mini-peek"]);
const LOW_POWER_PAUSE_STATES = new Set(["idle", "mini-idle", "dozing"]);
const POINTER_BRIDGE_EPSILON = 0.001;

// ── Theme-driven state (refreshed on hot theme switch) ──
let theme = null;
let MOUSE_IDLE_TIMEOUT = 0;
let MOUSE_SLEEP_TIMEOUT = 0;
let SVG_IDLE_FOLLOW = null;
let IDLE_ANIMS = [];
let IDLE_EASTER_EGGS = [];
const idleEasterEggLastPlayedAt = new Map();
let SLEEP_MODE = "full";
let THEME_SUPPORTS_DIZZY = false;

function refreshTheme() {
  theme = ctx.theme;
  MOUSE_IDLE_TIMEOUT = theme.timings.mouseIdleTimeout;
  MOUSE_SLEEP_TIMEOUT = theme.timings.mouseSleepTimeout;
  SVG_IDLE_FOLLOW = theme.states.idle[0];
  IDLE_ANIMS = (theme.idleAnimations || []).map(a => ({ svg: a.file, duration: a.duration }));
  IDLE_EASTER_EGGS = (theme.idleEasterEggs || []).map((egg) => ({
    svg: egg.file,
    duration: egg.duration,
    chance: egg.chance,
    cooldownMs: egg.cooldownMs,
    requiresAccessories: { ...egg.requiresAccessories },
  }));
  SLEEP_MODE = theme.sleepSequence && theme.sleepSequence.mode === "direct" ? "direct" : "full";
  // Precompute dizzy support so the per-tick spin detector can gate cheaply and skip all
  // its math on themes that don't define a real dizzy state (e.g. Calico, Cloudling).
  THEME_SUPPORTS_DIZZY = !!(theme.states && Array.isArray(theme.states.dizzy) && theme.states.dizzy.length > 0
    && theme.timings && theme.timings.autoReturn
    && Number.isFinite(theme.timings.autoReturn.dizzy) && theme.timings.autoReturn.dizzy > 0);
}

refreshTheme();

// #509: resting idle sprite — the user-selected default idle visual when set,
// the theme's follow sprite otherwise. SVG_IDLE_FOLLOW itself stays pure so the
// eye-tracking gate below only fires on the real follow sprite.
function idleRestSvg() {
  const choice = typeof ctx.getIdleVisualChoice === "function" ? ctx.getIdleVisualChoice() : null;
  return choice || SVG_IDLE_FOLLOW;
}

function idleEasterEggKey(egg) {
  const requirements = egg && egg.requiresAccessories;
  return [
    theme && theme._id || "",
    egg && egg.svg || "",
    requirements && requirements.head || "",
    requirements && requirements.mouth || "",
  ].join("|");
}

function isIdleEasterEggEnvironmentEligible() {
  if (ctx.currentState !== "idle" || ctx.idlePaused) return false;
  if (ctx.miniMode || ctx.miniTransitioning || ctx.dragLocked || ctx.menuOpen) return false;
  if (ctx.lowPowerIdlePaused) return false;
  if (!ctx.win || ctx.win.isDestroyed()) return false;
  if (typeof ctx.win.isVisible === "function" && !ctx.win.isVisible()) return false;
  return true;
}

function isIdleEasterEggEligible(egg) {
  if (!IDLE_EASTER_EGGS.includes(egg) || !isIdleEasterEggEnvironmentEligible()) return false;
  if (typeof ctx.getEffectiveAccessoryIds !== "function") return false;
  const ids = ctx.getEffectiveAccessoryIds();
  const requirements = egg.requiresAccessories;
  if (!ids || ids.head !== requirements.head || ids.mouth !== requirements.mouth) return false;
  const lastPlayedAt = idleEasterEggLastPlayedAt.get(idleEasterEggKey(egg));
  return !Number.isFinite(lastPlayedAt) || now() >= lastPlayedAt + egg.cooldownMs;
}

function chooseIdleEasterEgg() {
  const eligible = IDLE_EASTER_EGGS.filter(isIdleEasterEggEligible);
  if (eligible.length === 0) return null;
  const roll = random();
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1) return null;
  let upperBound = 0;
  for (const egg of eligible) {
    upperBound += egg.chance;
    if (roll < upperBound) return egg;
  }
  return null;
}

function finishIdleVisualPlayback(attempt) {
  idleLookReturnTimer = null;
  if (idleLookAttempt !== attempt) return;
  if (!isMouseIdle || ctx.currentState !== "idle") {
    idleLookVisualGeneration = null;
    idleLookAttempt = null;
    return;
  }
  if (
    idleLookVisualGeneration
    && typeof ctx.isVisualGenerationCurrent === "function"
    && !ctx.isVisualGenerationCurrent(idleLookVisualGeneration)
  ) {
    isMouseIdle = false;
    idleLookVisualGeneration = null;
    idleLookAttempt = null;
    return;
  }
  isMouseIdle = false;
  idleLookVisualGeneration = null;
  idleLookAttempt = null;
  const returnSvg = idleRestSvg();
  ctx.sendToRenderer("state-change", "idle", returnSvg);
  setTimeout(() => { ctx.forceEyeResend = true; }, 200);
}

// ── Unified main tick (cursor polling for eye tracking + sleep + mini peek) ──
// Input routing is handled by hitWin — no setIgnoreMouseEvents toggling here.
function startMainTick() {
  if (mainTickActive) return;
  // Render window: permanently click-through (set once, never toggle)
  ctx.win.setIgnoreMouseEvents(true);
  ctx.mouseOverPet = false;

  mainTickActive = true;
  scheduleNextTick(0);
}

function getBaseTickDelay(idleNow, miniIdleNow) {
  if (ctx.dragLocked || ctx.menuOpen || ctx.miniTransitioning) return FAST_TICK_MS;
  if (ctx.lowPowerIdlePaused && idleNow) return LOW_POWER_IDLE_TICK_MS;
  if (ctx.lowPowerIdlePaused && miniIdleNow) return LOW_POWER_MINI_IDLE_TICK_MS;
  if (ctx.miniMode || miniIdleNow) return FAST_TICK_MS;
  if (idleNow) {
    if (Date.now() - mouseStillSince <= RECENT_MOUSE_MS) return BOOST_TICK_MS;
    return IDLE_TICK_MS;
  }
  if (ctx.idlePaused) return REACTION_TICK_MS;
  return BACKGROUND_TICK_MS;
}

function applyBoost(delay) {
  if (ctx.lowPowerIdlePaused && LOW_POWER_PAUSE_STATES.has(ctx.currentState)) return delay;
  const boostUntil = Number(ctx.forceEyeResendBoostUntil) || 0;
  if (boostUntil > Date.now()) return Math.min(delay, BOOST_TICK_MS);
  return delay;
}

function getNextTickDelay(idleNow, miniIdleNow) {
  return applyBoost(getBaseTickDelay(idleNow, miniIdleNow));
}

function scheduleNextTick(delay) {
  if (!mainTickActive) return;
  if (mainTickTimer) clearTimeout(mainTickTimer);
  const safeDelay = Math.max(0, Number.isFinite(delay) ? delay : BACKGROUND_TICK_MS);
  nextMainTickAt = Date.now() + safeDelay;
  mainTickTimer = setTimeout(runMainTick, safeDelay);
}

function scheduleSoon(maxDelay = BOOST_TICK_MS) {
  if (!mainTickActive) return;
  const safeDelay = Math.max(0, Number.isFinite(maxDelay) ? maxDelay : BOOST_TICK_MS);
  if (!mainTickTimer || nextMainTickAt - Date.now() > safeDelay) {
    scheduleNextTick(safeDelay);
  }
}

function getPointerBridgeKey() {
  const state = ctx.currentState;
  if (!POINTER_BRIDGE_STATES.has(state)) return null;
  return `${state}|${ctx.currentSvg || ""}`;
}

function hasMiniState(state) {
  const files = ctx.theme && ctx.theme.miniMode && ctx.theme.miniMode.states
    && ctx.theme.miniMode.states[state];
  return Array.isArray(files) && !!files[0];
}

function pointerBridgePayloadChanged(key, payload) {
  if (key !== lastPointerBridgeKey || !lastPointerBridgePayload) return true;
  return payload.inside !== lastPointerBridgePayload.inside
    || Math.abs(payload.x - lastPointerBridgePayload.x) > POINTER_BRIDGE_EPSILON
    || Math.abs(payload.y - lastPointerBridgePayload.y) > POINTER_BRIDGE_EPSILON;
}

function sendPointerBridge(cursor, bounds) {
  if (typeof ctx.getAssetPointerPayload !== "function") return;
  if (shouldSuppressPassiveIpc()) return;
  const key = getPointerBridgeKey();
  if (!key || !cursor || !bounds) return;
  if (ctx.currentState !== "mini-peek" && Number(ctx.eyePauseUntil) > Date.now()) return;

  const raw = ctx.getAssetPointerPayload(bounds, cursor);
  if (!raw || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return;

  const payload = {
    x: raw.x,
    y: raw.y,
    // Clawd polls the global cursor, so pointer-aware Cloudling idle states
    // should keep following even when the cursor is outside the SVG art rect.
    inside: true,
  };
  if (!pointerBridgePayloadChanged(key, payload)) return;

  lastPointerBridgeKey = key;
  lastPointerBridgePayload = payload;
  ctx.sendToRenderer("cloudling-pointer", payload);
}

function shouldSuppressPassiveIpc() {
  return !!ctx.lowPowerIdlePaused && LOW_POWER_PAUSE_STATES.has(ctx.currentState);
}

function runMainTick() {
  mainTickTimer = null;
  nextMainTickAt = 0;
  const delay = runMainTickOnce();
  if (mainTickActive && !mainTickTimer) scheduleNextTick(delay);
}

function runMainTickOnce() {
    if (!ctx.win || ctx.win.isDestroyed()) return BACKGROUND_TICK_MS;

    // ── Idle state edge detection (must run every tick for timer cleanup) ──
    const idleNow = ctx.currentState === "idle" && !ctx.idlePaused;
    const miniIdleNow = ctx.currentState === "mini-idle" && !ctx.idlePaused && !ctx.miniTransitioning;
    // #569: an active roam walk runs in state "roam", so it must keep polling
    // the cursor as well — otherwise the "cancel roaming when mouse moves"
    // block below is unreachable mid-walk, and a user interaction that resizes
    // the pet (e.g. the Settings size slider) lands mid-walk only to be
    // overwritten by the walk's anchored per-frame bounds writes.
    const roamNow = ctx.currentState === "roam" && !ctx.idlePaused;
    const nextDelay = () => getNextTickDelay(idleNow, miniIdleNow);

    if (idleNow && !idleWasActive) {
      isMouseIdle = false;
      hasTriggeredYawn = false;
      idleLookPlayed = false;
      lastCursorX = null;
      lastCursorY = null;
      mouseStillSince = Date.now();
      lastEyeDx = 0;
      lastEyeDy = 0;
      lastCursorAngle = null;
      accumulatedSpin = 0;
      lastSpinTickAt = 0;
      if (idleLookReturnTimer) { clearTimeout(idleLookReturnTimer); idleLookReturnTimer = null; }
      if (yawnDelayTimer) { clearTimeout(yawnDelayTimer); yawnDelayTimer = null; }
    }

    if (!idleNow && idleWasActive) {
      if (idleLookReturnTimer) { clearTimeout(idleLookReturnTimer); idleLookReturnTimer = null; }
      if (yawnDelayTimer) { clearTimeout(yawnDelayTimer); yawnDelayTimer = null; }
    }
    idleWasActive = idleNow;

    // Skip expensive native IPC calls (getCursorScreenPoint, getBounds) when
    // cursor tracking is not needed — saves ~20 calls/sec to the OS layer.
    const needsCursorPoll = idleNow || miniIdleNow || ctx.miniMode || roamNow;
    if (!needsCursorPoll) return nextDelay();

    const cursor = screen.getCursorScreenPoint();
    const moved = lastCursorX !== null && (cursor.x !== lastCursorX || cursor.y !== lastCursorY);
    lastCursorX = cursor.x;
    lastCursorY = cursor.y;

    // ── Cursor-over-pet tracking (for mini peek + eye tracking, NOT for input routing) ──
    const pointerBridgeKey = getPointerBridgeKey();
    const suppressPassiveIpc = shouldSuppressPassiveIpc();
    const needsPointerBridgeBounds = !!pointerBridgeKey
      && !suppressPassiveIpc
      && (moved || ctx.forceEyeResend || pointerBridgeKey !== lastPointerBridgeKey);
    const needsBounds = ctx.miniMode || moved || ctx.forceEyeResend || miniIdleNow || needsPointerBridgeBounds;
    let bounds = null;
    if (needsBounds) {
      bounds = typeof ctx.getPetWindowBounds === "function"
        ? ctx.getPetWindowBounds()
        : ctx.win.getBounds();
    }
    if (bounds && !ctx.dragLocked) {
      const hit = ctx.getHitRectScreen(bounds);
      const over = cursor.x >= hit.left && cursor.x <= hit.right
                && cursor.y >= hit.top  && cursor.y <= hit.bottom;
      ctx.mouseOverPet = over;
    }

    // ── Mini mode peek hover ──
    if (ctx.miniMode && (ctx.miniTransitioning || ctx.dragLocked || ctx.menuOpen)
      && typeof ctx.cancelPendingMiniPeek === "function") ctx.cancelPendingMiniPeek(true);
    if (ctx.miniMode && !ctx.miniTransitioning && !ctx.dragLocked && !ctx.menuOpen) {
      const canPeek = ctx.currentState === "mini-idle" || ctx.currentState === "mini-peek"
        || ctx.currentState === "mini-peek-hold" || ctx.currentState === "mini-sleep"
        || ctx.currentState === "mini-sleep-peek";
      if (!ctx.isAnimating && canPeek) {
        if (ctx.mouseOverPet && ctx.currentState === "mini-sleep" && !ctx.miniSleepPeeked) {
          ctx.miniPeekIn("sleep");
          ctx.miniSleepPeeked = true;
          if (hasMiniState("mini-sleep-peek")) ctx.applyState("mini-sleep-peek");
        } else if (!ctx.mouseOverPet && (ctx.currentState === "mini-sleep" || ctx.currentState === "mini-sleep-peek") && ctx.miniSleepPeeked) {
          ctx.miniPeekOut();
          ctx.miniSleepPeeked = false;
          if (ctx.currentState === "mini-sleep-peek") ctx.applyState("mini-sleep");
        } else if (ctx.mouseOverPet && ctx.currentState === "mini-idle" && !ctx.miniPeeked) {
          ctx.miniPeekIn("peek");
          ctx.applyState("mini-peek");
        } else if (!ctx.mouseOverPet && (ctx.currentState === "mini-peek" || ctx.currentState === "mini-peek-hold" || ctx.miniPeeked)) {
          ctx.miniPeekOut();
          ctx.miniPeeked = false;
          if (ctx.currentState !== "mini-idle") ctx.applyState("mini-idle");
        }
      }
    }

    sendPointerBridge(cursor, bounds);

    if (!idleNow && !miniIdleNow && !roamNow) return nextDelay();

    // ── Free roam: cancel roaming when mouse moves ──
    if (ctx.roam) {
      if (moved && ctx.roam.enabled) {
        ctx.roam.cancelRoam();
      }
    }

    // ── Below: idle or mini-idle logic ──
    // Normal idle: mouse idle detection + sleep sequence
    if (idleNow) {
      if (moved) {
        mouseStillSince = Date.now();
        hasTriggeredYawn = false;
        idleLookPlayed = false;
        if (idleLookReturnTimer) { clearTimeout(idleLookReturnTimer); idleLookReturnTimer = null; }
        idleLookVisualGeneration = null;
        idleLookAttempt = null;
        if (yawnDelayTimer) { clearTimeout(yawnDelayTimer); yawnDelayTimer = null; }
        if (isMouseIdle) {
          isMouseIdle = false;
          ctx.sendToRenderer("state-change", "idle", idleRestSvg());
        }
      }

      const elapsed = Date.now() - mouseStillSince;

      // Startup recovery: Claude Code is running but no hook yet — stay awake
      // Only suppress sleep sequence, don't skip eye tracking below
      if (ctx.startupRecoveryActive) {
        mouseStillSince = Date.now();
      }

      // 60s no mouse movement → yawning → dozing
      if (!hasTriggeredYawn && elapsed >= MOUSE_SLEEP_TIMEOUT) {
        hasTriggeredYawn = true;
        if (!isMouseIdle && !shouldSuppressPassiveIpc()) ctx.sendToRenderer("eye-move", 0, 0);
        if (SLEEP_MODE === "direct") {
          if (ctx.currentState === "idle") ctx.setState("sleeping");
        } else {
          yawnDelayTimer = setTimeout(() => {
            yawnDelayTimer = null;
            if (ctx.currentState === "idle") ctx.setState("yawning");
          }, isMouseIdle ? 50 : 250);
        }
        return nextDelay();
      }

      // 20s no mouse movement → random idle animation (play once, then return
      // to the resting idle visual). A user-chosen resting sprite is excluded
      // from the pool — "playing" it would be an invisible no-op that eats the
      // once-per-idle-period slot. With no choice set the pool is untouched:
      // a theme may deliberately list its follow sprite as a stay-at-rest beat.
      if (
        (IDLE_ANIMS.length > 0 || IDLE_EASTER_EGGS.length > 0)
        && !isMouseIdle
        && !hasTriggeredYawn
        && !idleLookPlayed
        && elapsed >= MOUSE_IDLE_TIMEOUT
      ) {
        const choice = typeof ctx.getIdleVisualChoice === "function" ? ctx.getIdleVisualChoice() : null;
        const pool = choice ? IDLE_ANIMS.filter((a) => a.svg !== choice) : IDLE_ANIMS;
        const easterEgg = chooseIdleEasterEgg();
        if (!easterEgg && pool.length === 0) {
          idleLookPlayed = true;
          return nextDelay();
        }
        isMouseIdle = true;
        idleLookPlayed = true;
        const pick = easterEgg || pool[Math.floor(random() * pool.length)];
        if (!shouldSuppressPassiveIpc()) ctx.sendToRenderer("eye-move", 0, 0);
        yawnDelayTimer = setTimeout(() => {
          yawnDelayTimer = null;
          if (easterEgg && !isIdleEasterEggEligible(easterEgg)) {
            isMouseIdle = false;
            idleLookPlayed = false;
            idleLookVisualGeneration = null;
            if (idleLookReturnTimer) {
              clearTimeout(idleLookReturnTimer);
              idleLookReturnTimer = null;
            }
            return;
          }
          if (isMouseIdle && ctx.currentState === "idle") {
            const attempt = {};
            idleLookAttempt = attempt;
            const onLogicalSettlement = (settlement) => {
              if (idleLookAttempt !== attempt) return;
              if (
                !settlement
                || settlement.status !== "committed"
                || !Number.isSafeInteger(settlement.visualGeneration)
                || !isMouseIdle
                || ctx.currentState !== "idle"
                || (typeof ctx.isVisualGenerationCurrent === "function"
                  && !ctx.isVisualGenerationCurrent(settlement.visualGeneration))
              ) {
                // A failed/superseded load never started playing. Keep the
                // once-per-idle attempt consumed so a broken asset cannot spin.
                isMouseIdle = false;
                idleLookVisualGeneration = null;
                idleLookAttempt = null;
                return;
              }
              idleLookVisualGeneration = settlement.visualGeneration;
              if (easterEgg) {
                idleEasterEggLastPlayedAt.set(idleEasterEggKey(easterEgg), now());
              }
              idleLookReturnTimer = setTimeout(
                () => finishIdleVisualPlayback(attempt),
                pick.duration
              );
            };
            const request = ctx.sendToRenderer("state-change", "idle", pick.svg, {
              onLogicalSettlement,
            });
            if (idleLookAttempt !== attempt) return;
            const visualGeneration = request && request.visualGeneration;
            idleLookVisualGeneration = visualGeneration;
            if (!Number.isSafeInteger(visualGeneration)) {
              isMouseIdle = false;
              idleLookVisualGeneration = null;
              idleLookAttempt = null;
            }
          }
        }, 250);
        return nextDelay();
      }

      // Free roam tick: wander around when idle long enough
      if (ctx.roam) ctx.roam.tick();
    }

    const trackEyesNow = (idleNow && ctx.currentSvg === SVG_IDLE_FOLLOW && !isMouseIdle) || miniIdleNow;
    if (!trackEyesNow) {
      // Resting on a non-follow visual: the eye path below never runs, so
      // consume the resend flag here — otherwise needsBounds stays true and
      // getPetWindowBounds() fires every idle tick for nothing.
      if (idleNow && !isMouseIdle && ctx.forceEyeResend) ctx.forceEyeResend = false;
      return nextDelay();
    }
    if (shouldSuppressPassiveIpc() && !moved) {
      if (ctx.forceEyeResend) ctx.forceEyeResend = false;
      return nextDelay();
    }
    if (ctx.eyePauseUntil) {
      if (Date.now() < ctx.eyePauseUntil) return nextDelay();
      ctx.eyePauseUntil = null;
    }
    if (!moved && !ctx.forceEyeResend) return nextDelay();

    // ── Eye position calculation (shared by idle and mini-idle) ──
    const skipDedup = ctx.forceEyeResend || (ctx.lowPowerIdlePaused && moved);
    ctx.forceEyeResend = false;

    if (!bounds) {
      bounds = typeof ctx.getPetWindowBounds === "function"
        ? ctx.getPetWindowBounds()
        : ctx.win.getBounds();
    }

    const obj = ctx.getObjRect(bounds);
    const eyeScreenX = obj.x + obj.w * theme.eyeTracking.eyeRatioX;
    const eyeScreenY = obj.y + obj.h * theme.eyeTracking.eyeRatioY;

    const relX = cursor.x - eyeScreenX;
    const relY = cursor.y - eyeScreenY;

    const MAX_OFFSET = theme.eyeTracking.maxOffset;
    const dist = Math.sqrt(relX * relX + relY * relY);
    let eyeDx = 0, eyeDy = 0;
    if (dist > 1) {
      const scale = Math.min(1, dist / 300);
      eyeDx = (relX / dist) * MAX_OFFSET * scale;
      eyeDy = (relY / dist) * MAX_OFFSET * scale;
    }

    eyeDx = Math.round(eyeDx * 2) / 2;
    eyeDy = Math.round(eyeDy * 2) / 2;
    const yClamp = MAX_OFFSET * 0.5;
    const xClamp = MAX_OFFSET * 0.85;
    eyeDx = Math.max(-xClamp, Math.min(xClamp, eyeDx));
    eyeDy = Math.max(-yClamp, Math.min(yClamp, eyeDy));

    if (skipDedup || eyeDx !== lastEyeDx || eyeDy !== lastEyeDy) {
      lastEyeDx = eyeDx;
      lastEyeDy = eyeDy;
      ctx.sendToRenderer("eye-move", eyeDx, eyeDy);
    }

    // --- Spin detection: detect sustained circling around the pet to trigger dizzy ---
    // Only active during normal idle eye-follow (not mini-idle, not idle-look), and only
    // when the active theme actually supports dizzy (THEME_SUPPORTS_DIZZY) — so unsupported
    // themes (Calico, Cloudling) skip the math entirely and keep normal idle behavior.
    //
    // We accumulate SIGNED angular displacement: circling one way keeps the same sign and
    // builds toward the threshold, while back-and-forth wiggling cancels out. The meter
    // resets on a pause, or when the cursor is too close to the eye-tracking origin (where
    // the angle is dominated by sub-pixel jitter), instead of decaying every tick — so a
    // genuine two-circle gesture reaches ±SPIN_THRESHOLD precisely.
    if (idleNow && !miniIdleNow && !isMouseIdle && moved && THEME_SUPPORTS_DIZZY) {
      const now = Date.now();

      if (dist < SPIN_MIN_RADIUS) {
        // Too close to the center — angle is unreliable; break the accumulation chain.
        lastCursorAngle = null;
        accumulatedSpin = 0;
      } else {
        const angle = Math.atan2(relY, relX);
        const stalled = lastSpinTickAt > 0 && (now - lastSpinTickAt) > SPIN_IDLE_RESET_MS;
        if (lastCursorAngle === null || stalled) {
          // First sample, or resumed after a pause → (re)start the meter.
          accumulatedSpin = 0;
        } else {
          let delta = angle - lastCursorAngle;
          if (delta > Math.PI) delta -= 2 * Math.PI;
          if (delta < -Math.PI) delta += 2 * Math.PI;
          accumulatedSpin += delta; // signed: reversing direction cancels progress

          if (Math.abs(accumulatedSpin) >= SPIN_THRESHOLD && now > dizzyCooldownUntil) {
            accumulatedSpin = 0;
            lastCursorAngle = null;
            lastSpinTickAt = 0;
            dizzyCooldownUntil = now + DIZZY_COOLDOWN_MS;
            lastEyeDx = 0;
            lastEyeDy = 0;
            ctx.setState("dizzy");
            return nextDelay();
          }
        }
        lastCursorAngle = angle;
      }
      lastSpinTickAt = now;
    }

    return nextDelay();
}

function resetIdleTimer() {
  mouseStillSince = Date.now();
}

function cleanup() {
  mainTickActive = false;
  if (mainTickTimer) { clearTimeout(mainTickTimer); mainTickTimer = null; }
  nextMainTickAt = 0;
  if (idleLookReturnTimer) { clearTimeout(idleLookReturnTimer); idleLookReturnTimer = null; }
  idleLookAttempt = null;
  idleLookVisualGeneration = null;
  if (yawnDelayTimer) { clearTimeout(yawnDelayTimer); yawnDelayTimer = null; }
  lastCursorX = null;
  lastCursorY = null;
  isMouseIdle = false;
  hasTriggeredYawn = false;
  idleLookPlayed = false;
  idleWasActive = false;
  lastEyeDx = 0;
  lastEyeDy = 0;
  lastPointerBridgeKey = null;
  lastPointerBridgePayload = null;
  lastCursorAngle = null;
  accumulatedSpin = 0;
  dizzyCooldownUntil = 0;
  lastSpinTickAt = 0;
}

// Expose mouseStillSince for wake poll (state.js deep sleep timeout)
Object.defineProperty(startMainTick, '_mouseStillSince', {
  get() { return mouseStillSince; },
});

return { startMainTick, resetIdleTimer, cleanup, refreshTheme, scheduleSoon, get _mouseStillSince() { return mouseStillSince; } };

};
