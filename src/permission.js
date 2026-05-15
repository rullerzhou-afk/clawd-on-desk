// src/permission.js — Permission bubble management (stacking, show/hide, responses)
// Extracted from main.js L349-357, L1594-1746

const { BrowserWindow, globalShortcut } = require("electron");
const { getDefaultShortcuts } = require("./shortcut-actions");
const { keepOutOfTaskbar } = require("./taskbar");
const path = require("path");
const http = require("http");
const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
} = require("../hooks/server-config");

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";
const isWin = process.platform === "win32";
const { execFile } = require("child_process");

function captureFrontApp(cb) {
  if (!isMac) { cb(null); return; }
  execFile("osascript", ["-e",
    'tell application "System Events" to get name of first application process whose frontmost is true'
  ], { timeout: 500 }, (err, stdout) => {
    cb(err ? null : stdout.trim());
  });
}

function restoreFrontApp(appName) {
  if (!isMac || !appName) return;
  execFile("osascript", ["-e",
    `tell application "${appName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" to activate`
  ], { timeout: 1000 }, () => {});
}

const RESTORE_FOCUS_DELAY_MS = 300;
const MAC_FLOATING_TOPMOST_DELAY_MS = 120;
const WIN_TOPMOST_LEVEL = "pop-up-menu";
const LINUX_WINDOW_TYPE = "toolbar";
// 24px matches the 8px stack margin on both edges plus a small buffer, so a
// single tall bubble never hugs or exceeds the visible work area.
const BUBBLE_HEIGHT_RESERVE = 24;

function requiredDependency(value, name, owner) {
  if (!value) throw new Error(`${owner} requires ${name}`);
  return value;
}

function registerPermissionIpc(options = {}) {
  const ipcMain = requiredDependency(options.ipcMain, "ipcMain", "registerPermissionIpc");
  const permission = requiredDependency(options.permission, "permission", "registerPermissionIpc");
  requiredDependency(permission.handleBubbleHeight, "permission.handleBubbleHeight", "registerPermissionIpc");
  requiredDependency(permission.handleDecide, "permission.handleDecide", "registerPermissionIpc");
  const disposers = [];

  function on(channel, listener) {
    ipcMain.on(channel, listener);
    disposers.push(() => ipcMain.removeListener(channel, listener));
  }

  on("bubble-height", (event, height) => permission.handleBubbleHeight(event, height));
  on("permission-decide", (event, behavior) => permission.handleDecide(event, behavior));

  return {
    dispose() {
      while (disposers.length) {
        const dispose = disposers.pop();
        dispose();
      }
    },
  };
}

function clampBubbleHeight(naturalHeight, workAreaHeight, reserve = BUBBLE_HEIGHT_RESERVE) {
  const roundedHeight = Math.ceil(Number(naturalHeight));
  if (!Number.isFinite(roundedHeight) || roundedHeight <= 0) return 0;

  const areaHeight = Math.floor(Number(workAreaHeight));
  if (!Number.isFinite(areaHeight) || areaHeight <= 0) return roundedHeight;

  const edgeReserve = Math.max(0, Math.floor(Number(reserve) || 0));
  const maxHeight = Math.max(1, areaHeight - edgeReserve);
  return Math.min(roundedHeight, maxHeight);
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

// Legacy Codex JSONL notifications have no /permission connection, so their
// sub-gate is checked at the bubble-creation callsite instead of route entry.
function shouldSuppressCodexNotifyBubble(ctx) {
  const codexBubblesEnabled =
    typeof ctx.isAgentPermissionsEnabled !== "function" ||
    ctx.isAgentPermissionsEnabled("codex");
  const policy = getPolicy(ctx, "notification");
  return !!(ctx.doNotDisturb || !policy.enabled || !codexBubblesEnabled);
}

function shouldSuppressKimiNotifyBubble(ctx) {
  const kimiBubblesEnabled =
    typeof ctx.isAgentPermissionsEnabled !== "function" ||
    ctx.isAgentPermissionsEnabled("kimi-cli");
  const policy = getPolicy(ctx, "notification");
  return !!(ctx.doNotDisturb || !policy.enabled || !kimiBubblesEnabled);
}

function getPolicy(ctx, kind) {
  if (typeof ctx.getBubblePolicy === "function") {
    try {
      const policy = ctx.getBubblePolicy(kind);
      if (policy && typeof policy.enabled === "boolean") return policy;
    } catch {}
  }
  if (kind === "permission") return { enabled: !ctx.hideBubbles, autoCloseMs: 0 };
  if (kind === "notification") return { enabled: !ctx.hideBubbles, autoCloseMs: 30000 };
  return { enabled: !ctx.hideBubbles, autoCloseMs: 0 };
}

function sanitizeCodexPermissionDecision(decisionOrBehavior, message) {
  const source = typeof decisionOrBehavior === "string"
    ? { behavior: decisionOrBehavior, message }
    : (decisionOrBehavior && typeof decisionOrBehavior === "object" ? decisionOrBehavior : null);
  if (!source) return null;

  const behavior = source.behavior === "deny" ? "deny"
    : (source.behavior === "allow" ? "allow" : null);
  if (!behavior) return null;

  const decision = { behavior };
  if (behavior === "deny" && typeof source.message === "string" && source.message) {
    decision.message = source.message;
  }
  return decision;
}

function buildCodexPermissionResponseBody(decisionOrBehavior, message) {
  const decision = sanitizeCodexPermissionDecision(decisionOrBehavior, message);
  if (!decision) return "{}";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision,
    },
  });
}

function isPassiveNotifyEntry(permEntry) {
  return !!(permEntry && (permEntry.isCodexNotify || permEntry.isKimiNotify));
}

function computePassiveNotifyRemainingMs(createdAt, autoCloseMs, now = Date.now()) {
  const totalMs = Number(autoCloseMs);
  if (!Number.isFinite(totalMs) || totalMs <= 0) return 0;
  const startedAt = Number(createdAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return totalMs;
  return Math.max(0, totalMs - Math.max(0, now - startedAt));
}

// Pure layout calculator for the permission bubble stack. Extracted out of
// repositionBubbles() so the geometry can be unit-tested without spinning up
// real Electron BrowserWindows. Returns one bounds object per height in the
// input array, in the same (oldest→newest) order.
//
// Layout priority when followPet=true:
//   1. below pet     — stack hangs from hitRect.bottom (oldest closest to
//                       the pet body, newest at the bottom of the stack)
//   2. side of pet   — pick the side with more horizontal room (right wins
//                       on ties), vertically anchored on the pet center and
//                       clamped to the work area
//   3. corner fallback — only when neither side has bw of clearance, fall
//                         back to the work area's bottom-right corner
//
// followPet=false → bottom-right of the work area (default Clawd behavior).
//
// Visual invariant across ALL branches: bubbles[0] (oldest) ends up at the
// highest y, bubbles[N-1] (newest) at the lowest y. Crossing a layout
// threshold only translates the anchor — it does NOT reverse the visual
// order. PR #89 fixed the original below↔degraded order-flip; this guards
// the same bug from regressing.
//
// Degenerate case (totalH > usable work area height): the second clamp on
// yBottom intentionally wins, anchoring the stack to the TOP of the work
// area. The OLDEST bubble stays visible while newer ones overflow off the
// bottom. Rationale: oldest is the request that has been waiting longest,
// and Claude Code re-sends on timeout if newest gets dropped — losing
// oldest is harder to recover. See test
// "anchors stack top when totalH overflows the work area".
function computeBubbleStackLayout({
  followPet,
  bubbleHeights,
  bubbleWidth: bw,
  margin,
  gap,
  workArea: wa,
  hitRect,
  hudReservedOffset = 0,
}) {
  const N = bubbleHeights.length;
  const bounds = new Array(N);
  if (N === 0) return bounds;

  // totalH = sum of heights + (N-1) gaps. The previous in-place loop in
  // repositionBubbles added a gap after every bubble (N gaps total), which
  // over-counted by one gap and slightly skewed both the below/side cutoff
  // and the side vertical centering. Fixed here.
  let totalH = 0;
  for (let i = 0; i < N; i++) {
    totalH += bubbleHeights[i];
    if (i < N - 1) totalH += gap;
  }

  let x, yBottom;
  if (followPet && hitRect) {
    const hitBottom = Math.round(hitRect.bottom);
    const hitLeft = Math.round(hitRect.left);
    const hitRight = Math.round(hitRect.right);
    const hitCx = Math.round((hitRect.left + hitRect.right) / 2);
    const hitCy = Math.round((hitRect.top + hitRect.bottom) / 2);

    // 1. Below pet — enough vertical room to hang the stack from the hitbox.
    //    Iterate oldest→newest growing downward so the visual order matches
    //    the side/corner branches' upward-stacking loop below.
    const reserve = Math.max(0, Number(hudReservedOffset) || 0);
    if (wa.y + wa.height - hitBottom >= reserve + totalH) {
      x = Math.max(wa.x, Math.min(hitCx - Math.round(bw / 2), wa.x + wa.width - bw));
      let yTop = hitBottom + reserve;
      for (let i = 0; i < N; i++) {
        const bh = bubbleHeights[i];
        bounds[i] = { x, y: yTop, width: bw, height: bh };
        yTop += bh + gap;
      }
      return bounds;
    }

    // 2. Side — pick the side with more room (right wins on ties).
    const spaceRight = wa.x + wa.width - hitRight;
    const spaceLeft = hitLeft - wa.x;
    if (spaceRight >= bw && spaceRight >= spaceLeft) {
      x = Math.min(hitRight, wa.x + wa.width - bw);
    } else if (spaceLeft >= bw) {
      x = Math.max(wa.x, hitLeft - bw);
    } else {
      // 3. Corner fallback — neither side has bw of clearance.
      x = wa.x + wa.width - bw - margin;
      yBottom = wa.y + wa.height - margin;
    }

    if (yBottom === undefined) {
      // Side vertical anchor: center the stack on the pet, then clamp to
      // the work area. When totalH > usable height, minBottom > maxBottom
      // and the second clamp wins on purpose (see header comment for the
      // degenerate-case rationale).
      yBottom = hitCy + Math.round(totalH / 2);
      const maxBottom = wa.y + wa.height - margin;
      const minBottom = wa.y + margin + totalH;
      if (yBottom > maxBottom) yBottom = maxBottom;
      if (yBottom < minBottom) yBottom = minBottom;
    }
  } else {
    // followPet=off (or no hit rect): bottom-right of the nearest work area.
    x = wa.x + wa.width - bw - margin;
    yBottom = wa.y + wa.height - margin;
  }

  // Default upward stacking loop: newest (i=N-1) sits at yBottom, the rest
  // grow upward. Combined with the below-branch's downward iteration above,
  // the invariant holds: oldest highest on screen, newest lowest.
  for (let i = N - 1; i >= 0; i--) {
    const bh = bubbleHeights[i];
    const y = yBottom - bh;
    yBottom = y - gap;
    bounds[i] = { x, y, width: bw, height: bh };
  }
  return bounds;
}

function buildElicitationUpdatedInput(toolInput, answers) {
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const normalizedAnswers = {};

  for (const question of questions) {
    if (!question || typeof question.question !== "string" || !question.question) continue;
    const answer = answers && Object.prototype.hasOwnProperty.call(answers, question.question)
      ? answers[question.question]
      : undefined;
    if (typeof answer === "string" && answer.trim()) {
      normalizedAnswers[question.question] = answer.trim();
    }
  }

  return {
    ...input,
    questions,
    answers: normalizedAnswers,
  };
}

function buildPermissionFocusEntry(perm) {
  if (!perm || typeof perm !== "object") return null;
  const sessionId = String(perm.sessionId || "");
  if (!sessionId) return null;
  const focusEntry = { id: sessionId, agentId: perm.agentId || null };
  if (perm.sourcePid) focusEntry.sourcePid = perm.sourcePid;
  if (perm.cwd) focusEntry.cwd = perm.cwd;
  if (perm.agentPid) focusEntry.agentPid = perm.agentPid;
  if (perm.pidChain) focusEntry.pidChain = perm.pidChain;
  if (perm.host) focusEntry.host = perm.host;
  if (perm.platform) focusEntry.platform = perm.platform;
  if (perm.model) focusEntry.model = perm.model;
  if (perm.codexOriginator) focusEntry.codexOriginator = perm.codexOriginator;
  if (perm.codexSource) focusEntry.codexSource = perm.codexSource;
  return focusEntry;
}

module.exports = function initPermission(ctx) {

// Each entry: { res, abortHandler, suggestions, sessionId, bubble, hideTimer, toolName, toolInput, resolvedSuggestion, createdAt, measuredHeight }
const pendingPermissions = [];
// Pure-metadata tools auto-allowed without showing a bubble (zero side effects)
const PASSTHROUGH_TOOLS = new Set([
  "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TaskStop", "TaskOutput",
]);

// ── Permission hotkeys (contextual global shortcuts) ──
let registeredAllowAccel = null;
let registeredDenyAccel = null;

function getShortcutSnapshot() {
  const defaults = getDefaultShortcuts();
  const settingsSnapshot = typeof ctx.getSettingsSnapshot === "function"
    ? ctx.getSettingsSnapshot()
    : null;
  const shortcuts = settingsSnapshot && settingsSnapshot.shortcuts;
  return {
    ...defaults,
    ...(shortcuts && typeof shortcuts === "object" ? shortcuts : {}),
  };
}

function verifyUnregister(accelerator) {
  try {
    globalShortcut.unregister(accelerator);
  } catch {
    return false;
  }
  if (typeof globalShortcut.isRegistered === "function") {
    try {
      return !globalShortcut.isRegistered(accelerator);
    } catch {
      return false;
    }
  }
  return true;
}

function getActionablePermissions() {
  return pendingPermissions.filter(
    p => !p.isElicitation && !p.isCodexNotify && !p.isKimiNotify && p.toolName !== "ExitPlanMode"
  );
}

function syncSingle(actionId, current, target, handler, setState) {
  if (current === target) {
    if (typeof ctx.clearShortcutFailure === "function") {
      ctx.clearShortcutFailure(actionId);
    }
    return;
  }

  if (target !== null) {
    let ok = false;
    try { ok = !!globalShortcut.register(target, handler); } catch { ok = false; }
    if (!ok) {
      if (typeof ctx.reportShortcutFailure === "function") {
        ctx.reportShortcutFailure(actionId, "system conflict");
      }
      return;
    }
  }

  if (current !== null) {
    const unregistered = verifyUnregister(current);
    if (!unregistered) {
      if (target !== null) {
        try { globalShortcut.unregister(target); } catch {}
      }
      if (typeof ctx.reportShortcutFailure === "function") {
        ctx.reportShortcutFailure(actionId, "switch failed");
      }
      return;
    }
  }

  setState(target);
  if (typeof ctx.clearShortcutFailure === "function") {
    ctx.clearShortcutFailure(actionId);
  }
}

function syncPermissionShortcuts() {
  const shortcutSnapshot = getShortcutSnapshot();
  const permissionPolicy = getPolicy(ctx, "permission");
  const shouldRegister = permissionPolicy.enabled && !ctx.petHidden
    && getActionablePermissions().length > 0;
  const targetAllow = shouldRegister ? shortcutSnapshot.permissionAllow : null;
  const targetDeny = shouldRegister ? shortcutSnapshot.permissionDeny : null;

  syncSingle("permissionAllow", registeredAllowAccel, targetAllow, hotkeyAllow, (value) => {
    registeredAllowAccel = value;
  });
  syncSingle("permissionDeny", registeredDenyAccel, targetDeny, hotkeyDeny, (value) => {
    registeredDenyAccel = value;
  });
}

function repositionDependentBubbles() {
  if (typeof ctx.repositionUpdateBubble === "function") {
    try { ctx.repositionUpdateBubble(); } catch {}
  }
}

function hotkeyResolve(behavior, message) {
  const targets = getActionablePermissions();
  if (!targets.length) return;
  const perm = targets[targets.length - 1]; // newest
  captureFrontApp((appName) => {
    resolvePermissionEntry(perm, behavior, message);
    if (appName) {
      setTimeout(() => restoreFrontApp(appName), RESTORE_FOCUS_DELAY_MS);
    } else if (isMac) {
      // macOS only: osascript failed — fall back to terminal focus
      setTimeout(() => ctx.focusTerminalForSession(perm.sessionId), RESTORE_FOCUS_DELAY_MS);
    }
    // non-macOS: no focus change (matches pre-PR behavior)
  });
}

function hotkeyAllow() { hotkeyResolve("allow"); }
function hotkeyDeny()  { hotkeyResolve("deny", "Denied via hotkey"); }

const unsubscribeShortcuts = typeof ctx.subscribeShortcuts === "function"
  ? ctx.subscribeShortcuts(() => syncPermissionShortcuts())
  : null;

// Fallback height before renderer reports actual measurement
function estimateBubbleHeight(sugCount) {
  return 200 + (sugCount || 0) * 37;
}

function getAnchorWorkArea(petBounds) {
  const bounds = petBounds || ctx.getPetWindowBounds();
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  return ctx.getNearestWorkArea(cx, cy);
}

function repositionBubbles() {
  // Thin wrapper around computeBubbleStackLayout (top of file). All the
  // geometry lives there so it can be unit-tested without Electron windows.
  if (!ctx.win || ctx.win.isDestroyed()) return;
  const margin = 8;
  const gap = 6;
  const bw = 340;
  const petBounds = ctx.getPetWindowBounds();
  const wa = getAnchorWorkArea(petBounds);
  const hitRect = ctx.bubbleFollowPet ? ctx.getHitRectScreen(petBounds) : null;

  const bubbleHeights = pendingPermissions.map(perm =>
    clampBubbleHeight(
      perm.measuredHeight || estimateBubbleHeight((perm.suggestions || []).length),
      wa.height
    )
  );

  const bounds = computeBubbleStackLayout({
    followPet: !!ctx.bubbleFollowPet,
    bubbleHeights,
    bubbleWidth: bw,
    margin,
    gap,
    workArea: wa,
    hitRect,
    hudReservedOffset: typeof ctx.getHudReservedOffset === "function" ? ctx.getHudReservedOffset() : 0,
  });

  for (let i = 0; i < pendingPermissions.length; i++) {
    const perm = pendingPermissions[i];
    if (perm.bubble && !perm.bubble.isDestroyed() && bounds[i]) {
      perm.bubble.setBounds(bounds[i]);
    }
  }
}

function showPermissionBubble(permEntry) {
  const sugCount = (permEntry.suggestions || []).length;
  const wa = getAnchorWorkArea();
  const bh = clampBubbleHeight(estimateBubbleHeight(sugCount), wa.height);
  // Temporary position — repositionBubbles() will finalize after renderer reports real height
  const pos = { x: 0, y: 0, width: 340, height: bh };

  const bub = new BrowserWindow({
    width: pos.width,
    height: pos.height,
    x: pos.x,
    y: pos.y,
    show: false, // Fix lost focus
    frame: false,
    transparent: true,
    alwaysOnTop: !isMac,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
    ...(isMac ? { type: "panel" } : {}),
    // Elicitation needs keyboard focus for the Other/textarea input path.
    // Permission prompts stay non-focusable so they don't steal focus from
    // CC's terminal (which would trigger false "User answered in terminal"
    // denials — see bub.focus() note below).
    focusable: !!permEntry.isElicitation,
    webPreferences: {
      preload: path.join(__dirname, "preload-bubble.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  permEntry.bubble = bub;
  permEntry.bubbleReady = false;

  if (isWin) {
    bub.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
  }

  bub.loadFile(path.join(__dirname, "bubble.html"));

  bub.webContents.once("did-finish-load", () => {
    permEntry.bubbleReady = true;
    syncPermissionBubbleContent(permEntry);
    // Elicitation bubbles need keyboard focus so arrow keys and Enter work.
    // Regular permission bubbles must NOT steal focus from the terminal —
    // doing so triggers false "User answered in terminal" denials in Claude Code.
    if (permEntry.isElicitation) {
      bub.focus();
    }
  });

  repositionBubbles();
  bub.showInactive();
  repositionDependentBubbles();
  keepOutOfTaskbar(bub);
  // macOS: constructing/raising a topmost panel too early can still activate
  // Clawd on some setups. Defer topmost restoration until after showInactive.
  if (isMac) deferMacFloatingVisibility(ctx, bub);
  else ctx.reapplyMacVisibility();

  bub.on("closed", () => {
    const idx = pendingPermissions.indexOf(permEntry);
    if (idx !== -1) {
      resolvePermissionEntry(permEntry, "deny", "Bubble window closed by user");
    }
  });

  ctx.guardAlwaysOnTop(bub);
  syncPermissionShortcuts();
  armPermissionAutoCloseTimer(permEntry);
}

// Autoclose: set up the dismiss-without-decision timer for a single pending
// permission. Passive notification entries (codex/kimi) own their own
// dismissal via dismissPassiveNotify and must not be auto-closed through this
// path — their UI lifecycle is decoupled from the agent's response channel.
function armPermissionAutoCloseTimer(permEntry) {
  if (!permEntry || permEntry.isCodexNotify || permEntry.isKimiNotify) return;
  if (permEntry.autoCloseTimer) {
    clearTimeout(permEntry.autoCloseTimer);
    permEntry.autoCloseTimer = null;
  }
  const policy = getPolicy(ctx, "permission");
  if (!policy.enabled || !(policy.autoCloseMs > 0)) return;
  const elapsed = Math.max(0, Date.now() - (permEntry.createdAt || Date.now()));
  const remaining = Math.max(0, policy.autoCloseMs - elapsed);
  if (remaining === 0) {
    dismissPermissionWithoutDecision(permEntry, "Auto-closed before timer armed");
    return;
  }
  permEntry.autoCloseTimer = setTimeout(() => {
    permEntry.autoCloseTimer = null;
    dismissPermissionWithoutDecision(permEntry, "Auto-closed after configured timeout");
  }, remaining);
}

function dismissPermissionWithoutDecision(permEntry, message) {
  if (!permEntry) return;
  const idx = pendingPermissions.indexOf(permEntry);
  if (idx === -1) return;
  permLog(`auto-close dismiss: tool=${permEntry.toolName} session=${permEntry.sessionId} agent=${permEntry.agentId || "claude-code"}`);
  resolvePermissionEntry(permEntry, "no-decision", message || "Auto-closed");
}

// Called by settings-effect-router after permissionBubbleAutoCloseSeconds
// changes. Re-arm every visible permission entry against the current policy
// so a freshly-raised value extends pending bubbles and a lowered value
// shortens (or immediately fires) the remaining wait.
function refreshPermissionAutoCloseForPolicy() {
  for (const perm of [...pendingPermissions]) {
    armPermissionAutoCloseTimer(perm);
  }
}

function buildPermissionBubblePayload(permEntry) {
  const sess = ctx.sessions.get(permEntry.sessionId);
  const sessionFolder = sess && sess.cwd ? path.basename(sess.cwd) : null;
  const sessionShortId = permEntry.sessionId
    ? String(permEntry.sessionId).slice(-3)
    : null;
  return {
    toolName: permEntry.toolName,
    toolInput: permEntry.toolInput,
    suggestions: permEntry.suggestions || [],
    lang: ctx.lang,
    isElicitation: permEntry.isElicitation || false,
    isOpencode: permEntry.isOpencode || false,
    isPi: permEntry.isPi || false,
    opencodeAlways: permEntry.opencodeAlwaysCandidates || [],
    opencodePatterns: permEntry.opencodePatterns || [],
    sessionFolder,
    sessionShortId,
  };
}

function syncPermissionBubbleContent(permEntry) {
  const bub = permEntry && permEntry.bubble;
  if (!bub || bub.isDestroyed() || !permEntry.bubbleReady) return false;
  bub.webContents.send("permission-show", buildPermissionBubblePayload(permEntry));
  return true;
}

  function resolvePermissionEntry(permEntry, behavior, message) {
    // Codex notify bubbles have no HTTP connection — route to dedicated cleanup
    if (permEntry.isCodexNotify || permEntry.isKimiNotify) {
      dismissPassiveNotify(permEntry, `resolve:${behavior || "unknown"}`);
      return;
    }
  const idx = pendingPermissions.indexOf(permEntry);
  if (idx === -1) return;

  // Minimum display time: if bubble just appeared and dismiss is automatic
  // (client disconnect / terminal answer), delay so user can see it briefly
  const MIN_BUBBLE_DISPLAY_MS = 2000;
  const age = Date.now() - (permEntry.createdAt || 0);
  const isAutoResolve = message === "Client disconnected";
  if (isAutoResolve && permEntry.bubble && age < MIN_BUBBLE_DISPLAY_MS && !permEntry._delayedResolve) {
    permEntry._delayedResolve = true;
    permEntry._delayTimer = setTimeout(() => resolvePermissionEntry(permEntry, behavior, message), MIN_BUBBLE_DISPLAY_MS - age);
    return;
  }

  pendingPermissions.splice(idx, 1);

  if (permEntry.autoCloseTimer) {
    clearTimeout(permEntry.autoCloseTimer);
    permEntry.autoCloseTimer = null;
  }

  const { res, abortHandler, bubble: bub } = permEntry;
  if (res && abortHandler) res.removeListener("close", abortHandler);

  // Hide this bubble (fade out + destroy)
  if (bub && !bub.isDestroyed()) {
    bub.webContents.send("permission-hide");
    if (permEntry.hideTimer) clearTimeout(permEntry.hideTimer);
    permEntry.hideTimer = setTimeout(() => {
      if (bub && !bub.isDestroyed()) bub.destroy();
    }, 250);
  }

  // Reposition remaining bubbles to fill the gap
  repositionBubbles();
  repositionDependentBubbles();
  syncPermissionShortcuts();

  // opencode: decisions go back via the plugin's reverse bridge (Bun.serve
  // on a random localhost port). The plugin then calls opencode's in-process
  // Hono route. Plugin sent us a fire-and-forget POST — no HTTP response to
  // complete on this connection.
  if (permEntry.isOpencode) {
    // Autoclose: silent drop — same DND semantics. opencode TUI falls back
    // to its built-in prompt so the user can answer in the terminal.
    if (behavior === "no-decision") return;
    let reply;
    if (behavior === "deny") reply = "reject";
    else if (permEntry.opencodeAlwaysPicked) reply = "always";
    else reply = "once";
    replyOpencodePermission({
      bridgeUrl: permEntry.opencodeBridgeUrl,
      bridgeToken: permEntry.opencodeBridgeToken,
      requestId: permEntry.opencodeRequestId,
      reply,
      toolName: permEntry.toolName,
    });
    return;
  }

  // Guard: client may have disconnected
  if (!res || res.writableEnded || res.destroyed) return;

  if (permEntry.isCodex) {
    if (behavior === "no-decision") {
      sendCodexNoDecisionResponse(res, message || "fallback");
    } else {
      sendCodexPermissionResponse(res, {
        behavior: behavior === "deny" ? "deny" : "allow",
        message,
      });
    }
    return;
  }

  if (permEntry.isPi) {
    if (behavior === "no-decision") {
      sendNoDecisionResponse(res, message || "fallback", "pi");
    } else {
      const decision = { behavior: behavior === "deny" ? "deny" : "allow" };
      if (behavior === "deny" && message) decision.message = message;
      sendPermissionResponse(res, decision);
    }
    return;
  }

  if (permEntry.isElicitation) {
    if (behavior === "no-decision") {
      // Autoclose: drop the socket so CC stops waiting, then refocus the
      // terminal — same UX as the deny path but without sending a decision.
      try { res.destroy(); } catch {}
      ctx.focusTerminalForSession(permEntry.sessionId);
      return;
    }
    if (behavior === "allow" && permEntry.resolvedUpdatedInput) {
      sendPermissionResponse(res, {
        behavior: "allow",
        updatedInput: permEntry.resolvedUpdatedInput,
      });
    } else {
      sendPermissionResponse(res, "deny", message, "Elicitation");
      ctx.focusTerminalForSession(permEntry.sessionId);
    }
    return;
  }

  if (behavior === "no-decision") {
    // Claude Code / CodeBuddy autoclose path: destroy the socket so the
    // hook's curl sees a connection failure, which is a non-blocking error
    // per the hooks doc — CC falls back to its built-in chat prompt rather
    // than treating it as an explicit deny.
    try { res.destroy(); } catch {}
    return;
  }

  const decision = { behavior: behavior === "deny" ? "deny" : "allow" };
  if (behavior === "deny" && message) decision.message = message;
  if (permEntry.resolvedSuggestion) {
    decision.updatedPermissions = [permEntry.resolvedSuggestion];
  }

  sendPermissionResponse(res, decision);
}

function permLog(msg) {
  if (!ctx.permDebugLog) return;
  const { rotatedAppend } = require("./log-rotate");
  rotatedAppend(ctx.permDebugLog, `[${new Date().toISOString()}] ${msg}\n`);
}

// Fire-and-forget POST to the opencode plugin's reverse bridge. The plugin
// runs inside opencode's Bun process and does NOT expose opencode's own
// permission route externally — TUI mode has no TCP listener at all (see
// Phase 2 Spike in docs/plans/plan-opencode-integration.md). Instead the plugin
// starts its own Bun.serve on a random localhost port and forwards our
// decision to opencode's in-process Hono router via ctx.client._client.post().
//
// Shape: POST http://127.0.0.1:<plugin-port>/reply
//   Authorization: Bearer <hex token>
//   { "request_id": "per_xxx", "reply": "once" | "always" | "reject" }
//
// Uses raw http.request (not fetch) to avoid Electron main-process fetch
// polyfill concerns. Bridge is always 127.0.0.1 bound by the plugin so no
// IPv4/IPv6 gotcha. 5s timeout — on failure the opencode TUI still falls
// back to terminal-based approval.
function replyOpencodePermission({ bridgeUrl, bridgeToken, requestId, reply, toolName }) {
  if (!bridgeUrl || !bridgeToken || !requestId) {
    const missing = !bridgeUrl ? "bridgeUrl" : (!bridgeToken ? "bridgeToken" : "requestId");
    permLog(`opencode reply skipped: missing ${missing}`);
    return;
  }
  const fullUrl = `${bridgeUrl.replace(/\/$/, "")}/reply`;
  permLog(`opencode reply: tool=${toolName || "?"} request=${requestId} reply=${reply} url=${fullUrl}`);

  let parsed;
  try { parsed = new URL(fullUrl); } catch {
    permLog(`opencode reply skipped: invalid bridge URL ${fullUrl}`);
    return;
  }
  const body = JSON.stringify({ request_id: requestId, reply });
  const req = http.request({
    hostname: parsed.hostname,
    port: parsed.port || 80,
    path: parsed.pathname + parsed.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      Authorization: `Bearer ${bridgeToken}`,
    },
    timeout: 5000,
    family: 4,
  }, (res) => {
    let respBody = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { if (respBody.length < 500) respBody += chunk; });
    res.on("end", () => {
      permLog(`opencode reply status=${res.statusCode} request=${requestId} body=${respBody.trim() || "(empty)"}`);
    });
  });
  req.on("error", (err) => {
    const info = err
      ? `code=${err.code || ""} errno=${err.errno || ""} syscall=${err.syscall || ""} msg=${err.message || ""}`
      : "null";
    permLog(`opencode reply ERR ${info} request=${requestId}`);
  });
  req.on("timeout", () => {
    req.destroy();
    permLog(`opencode reply timeout request=${requestId}`);
  });
  req.write(body);
  req.end();
}

function sendPermissionResponse(res, decisionOrBehavior, message, hookEventName = "PermissionRequest") {
  let decision;
  if (typeof decisionOrBehavior === "string") {
    decision = { behavior: decisionOrBehavior };
    if (message) decision.message = message;
  } else {
    decision = decisionOrBehavior;
  }
  const responseBody = JSON.stringify({
    hookSpecificOutput: { hookEventName, decision },
  });
  permLog(`response: ${responseBody}`);
  res.writeHead(200, {
    "Content-Type": "application/json",
    [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID,
  });
  res.end(responseBody);
}

function sendNoDecisionResponse(res, reason = "", label = "permission") {
  if (!res || res.writableEnded || res.destroyed || res.headersSent) return false;
  if (reason) permLog(`${label} no-decision: ${reason}`);
  res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
  res.end();
  return true;
}

function sendCodexNoDecisionResponse(res, reason = "") {
  return sendNoDecisionResponse(res, reason, "codex");
}

function sendCodexPermissionResponse(res, decisionOrBehavior, message) {
  if (!res || res.writableEnded || res.destroyed || res.headersSent) return false;
  const responseBody = buildCodexPermissionResponseBody(decisionOrBehavior, message);
  if (responseBody === "{}") {
    return sendCodexNoDecisionResponse(res, "invalid decision");
  }
  permLog(`codex response: ${responseBody}`);
  res.writeHead(200, {
    "Content-Type": "application/json",
    [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID,
  });
  res.end(responseBody);
  return true;
}

function handleBubbleHeight(event, height) {
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  const perm = pendingPermissions.find(p => p.bubble === senderWin);
  if (perm && typeof height === "number" && height > 0) {
    perm.measuredHeight = Math.ceil(height);
    repositionBubbles();
    repositionDependentBubbles();
  }
}

function handleDecide(event, behavior) {
  // Identify which permission this bubble belongs to via sender webContents
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  const perm = pendingPermissions.find(p => p.bubble === senderWin);
  permLog(`IPC permission-decide: behavior=${behavior} matched=${!!perm}`);
  if (!perm) return;
  if (perm.isCodexNotify || perm.isKimiNotify) {
    dismissPassiveNotify(perm, "ipc-decide");
    return;
  }
  if (perm.isCodex) {
    if (behavior === "allow" || behavior === "deny") {
      resolvePermissionEntry(perm, behavior);
      return;
    }
    // Codex is blocking on the hook socket. UI actions that mean "handle it
    // elsewhere" must answer no-decision immediately instead of leaving the
    // hook parked until its long timeout.
    resolvePermissionEntry(perm, "no-decision", `Unsupported Codex bubble action: ${String(behavior)}`);
    if (behavior === "deny-and-focus") {
      ctx.focusTerminalForSession(perm.sessionId, { fallbackEntry: buildPermissionFocusEntry(perm) });
    }
    return;
  }
  if (perm.isPi && behavior !== "allow" && behavior !== "deny") {
    resolvePermissionEntry(perm, "no-decision", `Unsupported Pi bubble action: ${String(behavior)}`);
    if (behavior === "deny-and-focus") {
      ctx.focusTerminalForSession(perm.sessionId, { fallbackEntry: buildPermissionFocusEntry(perm) });
    }
    return;
  }
  if (perm.isElicitation && behavior && typeof behavior === "object" && behavior.type === "elicitation-submit") {
    perm.resolvedUpdatedInput = buildElicitationUpdatedInput(perm.toolInput, behavior.answers);
    resolvePermissionEntry(perm, "allow");
    return;
  }
  // opencode "Always" button — map to reply="always" via resolvePermissionEntry
  if (behavior === "opencode-always") {
    perm.opencodeAlwaysPicked = true;
    resolvePermissionEntry(perm, "allow");
    return;
  }
  // "suggestion:N" — user picked a permission suggestion
  if (typeof behavior === "string" && behavior.startsWith("suggestion:")) {
    const idx = parseInt(behavior.split(":")[1], 10);
    const suggestion = perm.suggestions?.[idx];
    if (!suggestion) { resolvePermissionEntry(perm, "deny", "Invalid suggestion index"); return; }
    permLog(`suggestion raw: ${JSON.stringify(suggestion)}`);
    if (suggestion.type === "addRules") {
      const rules = Array.isArray(suggestion.rules) ? suggestion.rules
        : [{ toolName: suggestion.toolName, ruleContent: suggestion.ruleContent }];
      perm.resolvedSuggestion = {
        type: "addRules",
        destination: suggestion.destination || "localSettings",
        behavior: suggestion.behavior || "allow",
        rules,
      };
    } else if (suggestion.type === "setMode") {
      perm.resolvedSuggestion = {
        type: "setMode",
        mode: suggestion.mode,
        destination: suggestion.destination || "localSettings",
      };
    }
    resolvePermissionEntry(perm, "allow");
  } else if (behavior === "deny-and-focus") {
    // Dismiss bubble without responding — let user decide in terminal.
    // Keep abortHandler registered so socket cleanup happens when Claude Code disconnects.
    const idx = pendingPermissions.indexOf(perm);
    if (idx !== -1) pendingPermissions.splice(idx, 1);
    if (perm.bubble && !perm.bubble.isDestroyed()) {
      perm.bubble.webContents.send("permission-hide");
      if (perm.hideTimer) clearTimeout(perm.hideTimer);
      const bub = perm.bubble;
      perm.hideTimer = setTimeout(() => { if (!bub.isDestroyed()) bub.destroy(); }, 250);
    }
    repositionBubbles();
    repositionDependentBubbles();
    syncPermissionShortcuts();
    ctx.focusTerminalForSession(perm.sessionId, { fallbackEntry: buildPermissionFocusEntry(perm) });
  } else {
    resolvePermissionEntry(perm, behavior === "allow" ? "allow" : "deny");
  }
}

function showCodexNotifyBubble({ sessionId, command }) {
  if (shouldSuppressCodexNotifyBubble(ctx)) {
    const policy = getPolicy(ctx, "notification");
    permLog(`codex notify suppressed: session=${sessionId} dnd=${ctx.doNotDisturb} notificationEnabled=${policy.enabled}`);
    return;
  }
  const policy = getPolicy(ctx, "notification");
  const existing = findCodexNotifyEntryBySession(sessionId);
  if (existing) {
    existing.toolInput = { command: command || "(unknown)" };
    existing.createdAt = Date.now();
    permLog(`passive notify refresh: agent=codex session=${sessionId} autoCloseMs=${policy.autoCloseMs}`);
    syncPermissionBubbleContent(existing);
    schedulePassiveNotifyAutoExpire(existing, policy.autoCloseMs);
    return;
  }
  const permEntry = {
    res: null,
    abortHandler: null, suggestions: [],
    sessionId, bubble: null, hideTimer: null,
    toolName: "CodexExec",
    toolInput: { command: command || "(unknown)" },
    resolvedSuggestion: null, createdAt: Date.now(),
    isElicitation: false, isCodexNotify: true,
    agentId: "codex",
    autoExpireTimer: null,
  };
  pendingPermissions.push(permEntry);
  showPermissionBubble(permEntry);
  permLog(`passive notify show: agent=codex session=${sessionId} autoCloseMs=${policy.autoCloseMs}`);
  schedulePassiveNotifyAutoExpire(permEntry, policy.autoCloseMs);
}

function showKimiNotifyBubble({ sessionId, command }) {
  if (shouldSuppressKimiNotifyBubble(ctx)) {
    const policy = getPolicy(ctx, "notification");
    permLog(`kimi notify suppressed: session=${sessionId} dnd=${ctx.doNotDisturb} notificationEnabled=${policy.enabled}`);
    return;
  }
  const policy = getPolicy(ctx, "notification");
  const permEntry = {
    res: null,
    abortHandler: null, suggestions: [],
    sessionId, bubble: null, hideTimer: null,
    toolName: "KimiPermission",
    toolInput: { command: command || "Approve or reject in Kimi terminal." },
    resolvedSuggestion: null, createdAt: Date.now(),
    isElicitation: false, isKimiNotify: true,
    agentId: "kimi-cli",
    autoExpireTimer: null,
  };
  pendingPermissions.push(permEntry);
  showPermissionBubble(permEntry);
  permLog(`passive notify show: agent=kimi-cli session=${sessionId} autoCloseMs=${policy.autoCloseMs}`);
  schedulePassiveNotifyAutoExpire(permEntry, policy.autoCloseMs);
}

function getPassiveNotifyAgentId(permEntry) {
  if (permEntry?.isCodexNotify) return "codex";
  if (permEntry?.isKimiNotify) return "kimi-cli";
  return permEntry?.agentId || "unknown";
}

function findCodexNotifyEntryBySession(sessionId) {
  if (!sessionId) return null;
  return pendingPermissions.find((permEntry) => permEntry && permEntry.isCodexNotify && permEntry.sessionId === sessionId) || null;
}

function dismissPassiveNotify(permEntry, reason = "unknown") {
  const idx = pendingPermissions.indexOf(permEntry);
  if (idx === -1) return;
  permLog(
    `passive notify dismiss: agent=${getPassiveNotifyAgentId(permEntry)} session=${permEntry.sessionId || "(none)"} reason=${reason}`
  );
  pendingPermissions.splice(idx, 1);
  if (permEntry.autoExpireTimer) clearTimeout(permEntry.autoExpireTimer);
  if (permEntry.hideTimer) clearTimeout(permEntry.hideTimer);
  if (permEntry.bubble && !permEntry.bubble.isDestroyed()) {
    permEntry.bubble.webContents.send("permission-hide");
    const bub = permEntry.bubble;
    setTimeout(() => { if (!bub.isDestroyed()) bub.destroy(); }, 250);
  }
  repositionBubbles();
  repositionDependentBubbles();
  syncPermissionShortcuts();
}

function schedulePassiveNotifyAutoExpire(permEntry, autoCloseMs, now = Date.now()) {
  if (!isPassiveNotifyEntry(permEntry)) return false;
  if (permEntry.autoExpireTimer) {
    clearTimeout(permEntry.autoExpireTimer);
    permEntry.autoExpireTimer = null;
  }
  const remainingMs = computePassiveNotifyRemainingMs(permEntry.createdAt, autoCloseMs, now);
  permLog(
    `passive notify schedule: agent=${getPassiveNotifyAgentId(permEntry)} session=${permEntry.sessionId || "(none)"} autoCloseMs=${autoCloseMs} remainingMs=${remainingMs}`
  );
  if (remainingMs <= 0) {
    dismissPassiveNotify(permEntry, "auto-expire-immediate");
    return false;
  }
  permEntry.autoExpireTimer = setTimeout(() => {
    dismissPassiveNotify(permEntry, "auto-expire-timeout");
  }, remainingMs);
  return true;
}

function refreshPassiveNotifyAutoClose() {
  const passiveEntries = pendingPermissions.filter(isPassiveNotifyEntry);
  if (passiveEntries.length === 0) return 0;
  const policy = getPolicy(ctx, "notification");
  const now = Date.now();
  let processed = 0;
  for (const permEntry of [...passiveEntries]) {
    processed += 1;
    schedulePassiveNotifyAutoExpire(permEntry, policy.autoCloseMs, now);
  }
  permLog(`passive notify refresh: processed=${processed} autoCloseMs=${policy.autoCloseMs}`);
  return processed;
}

function dismissInteractivePermissionWithoutDecision(perm, reason) {
  const idx = pendingPermissions.indexOf(perm);
  if (idx !== -1) pendingPermissions.splice(idx, 1);
  if (perm._delayTimer) { clearTimeout(perm._delayTimer); perm._delayTimer = null; }
  if (perm.autoCloseTimer) { clearTimeout(perm.autoCloseTimer); perm.autoCloseTimer = null; }
  if (perm.abortHandler && perm.res) {
    try { perm.res.removeListener("close", perm.abortHandler); } catch {}
  }
  if (perm.hideTimer) clearTimeout(perm.hideTimer);
  if (perm.bubble && !perm.bubble.isDestroyed()) {
    try { perm.bubble.webContents.send("permission-hide"); } catch {}
    const bub = perm.bubble;
    perm.hideTimer = setTimeout(() => {
      if (bub && !bub.isDestroyed()) bub.destroy();
    }, 250);
  }
  // Do not answer approval requests on the user's behalf. Dropping the UI
  // means Codex receives no decision, CC/CodeBuddy fall back via socket
  // close, and opencode falls back by receiving no bridge reply.
  if (perm.isCodex) {
    sendCodexNoDecisionResponse(perm.res, reason || "permission-dismissed");
  } else if (perm.isPi) {
    sendNoDecisionResponse(perm.res, reason || "permission-dismissed", "pi");
  } else if (!perm.isOpencode && perm.res && !perm.res.destroyed) {
    try { perm.res.destroy(); } catch {}
  }
}

// Mirrors the DND dispatcher: CC res.destroy() so it falls back to chat,
// opencode skips the bridge reply so TUI takes over, codex just closes.
function dismissPermissionsByAgent(agentId) {
  if (!agentId) return 0;
  const toDismiss = pendingPermissions.filter((p) => p && p.agentId === agentId);
  if (toDismiss.length === 0) return 0;
  for (const perm of toDismiss) {
    if (perm.isCodexNotify || perm.isKimiNotify) {
      dismissPassiveNotify(perm, `dismiss-by-agent:${agentId}`);
      continue;
    }
    dismissInteractivePermissionWithoutDecision(perm, `dismiss-by-agent:${agentId}`);
  }
  repositionBubbles();
  repositionDependentBubbles();
  syncPermissionShortcuts();
  permLog(`dismissPermissionsByAgent(${agentId}): cleared ${toDismiss.length}`);
  return toDismiss.length;
}

function dismissInteractivePermissionBubbles() {
  const toDismiss = pendingPermissions.filter((p) => p && !p.isCodexNotify && !p.isKimiNotify);
  if (toDismiss.length === 0) return 0;
  for (const perm of toDismiss) {
    dismissInteractivePermissionWithoutDecision(perm, "interactive-bubbles-dismissed");
  }
  repositionBubbles();
  syncPermissionShortcuts();
  permLog(`dismissInteractivePermissionBubbles(): cleared ${toDismiss.length}`);
  return toDismiss.length;
}

function dismissPermissionsForDnd() {
  const toDismiss = pendingPermissions.filter(Boolean);
  if (toDismiss.length === 0) return 0;
  for (const perm of toDismiss) {
    if (perm.isCodexNotify || perm.isKimiNotify) {
      dismissPassiveNotify(perm, "dnd-enabled");
      continue;
    }
    dismissInteractivePermissionWithoutDecision(perm, "dnd-enabled");
  }
  repositionBubbles();
  repositionDependentBubbles();
  syncPermissionShortcuts();
  permLog(`dismissPermissionsForDnd(): cleared ${toDismiss.length}`);
  return toDismiss.length;
}

function clearCodexNotifyBubbles(sessionId, reason = sessionId ? "codex-session-activity" : "codex-global-clear") {
  if (!pendingPermissions.some(p => p.isCodexNotify)) return;
  const toRemove = sessionId
    ? pendingPermissions.filter((p) => p.isCodexNotify && p.sessionId === sessionId)
    : pendingPermissions.filter((p) => p.isCodexNotify);
  for (const perm of toRemove) dismissPassiveNotify(perm, reason);
}

function clearKimiNotifyBubbles(sessionId, reason = sessionId ? "kimi-session-release" : "kimi-global-clear") {
  const hasKimi = pendingPermissions.some(p => p.isKimiNotify);
  if (!hasKimi) return;
  const toRemove = sessionId
    ? pendingPermissions.filter((p) => p.isKimiNotify && p.sessionId === sessionId)
    : pendingPermissions.filter((p) => p.isKimiNotify);
  for (const perm of toRemove) dismissPassiveNotify(perm, reason);
}

function cleanup() {
  // Unregister hotkeys
  if (registeredAllowAccel !== null) {
    try { globalShortcut.unregister(registeredAllowAccel); } catch {}
    registeredAllowAccel = null;
  }
  if (registeredDenyAccel !== null) {
    try { globalShortcut.unregister(registeredDenyAccel); } catch {}
    registeredDenyAccel = null;
  }
  if (typeof unsubscribeShortcuts === "function") {
    try { unsubscribeShortcuts(); } catch {}
  }
  // Clean up all pending permission requests. Codex gets no-decision so its
  // native approval flow can continue; Claude/CodeBuddy get explicit deny so
  // they don't hang while the app is quitting.
  for (const perm of [...pendingPermissions]) {
    if (perm._delayTimer) clearTimeout(perm._delayTimer);
    if (perm.autoExpireTimer) clearTimeout(perm.autoExpireTimer);
    if (perm.isCodex || perm.isPi) resolvePermissionEntry(perm, "no-decision", "Clawd is quitting");
    else resolvePermissionEntry(perm, "deny", "Clawd is quitting");
  }
}

return {
  showPermissionBubble, resolvePermissionEntry,
  sendPermissionResponse, repositionBubbles, permLog,
  pendingPermissions, PASSTHROUGH_TOOLS,
  handleBubbleHeight, handleDecide, cleanup,
  showCodexNotifyBubble, clearCodexNotifyBubbles,
  showKimiNotifyBubble, clearKimiNotifyBubbles,
  refreshPassiveNotifyAutoClose,
  refreshPermissionAutoCloseForPolicy,
  dismissPermissionsByAgent, dismissInteractivePermissionBubbles,
  dismissPermissionsForDnd,
  syncPermissionShortcuts,
  replyOpencodePermission,
};

};

module.exports.registerPermissionIpc = registerPermissionIpc;

// Test-only exports — bypasses the initPermission factory so unit tests can
// hit the pure layout function without standing up Electron / ctx mocks.
module.exports.__test = {
  computeBubbleStackLayout,
  computePassiveNotifyRemainingMs,
  clampBubbleHeight,
  shouldSuppressCodexNotifyBubble,
  sanitizeCodexPermissionDecision,
  buildCodexPermissionResponseBody,
  buildElicitationUpdatedInput,
};
