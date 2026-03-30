// src/permission.js — Permission bubble management (stacking, show/hide, responses)
// Extracted from main.js L349-357, L1594-1746

const { BrowserWindow } = require("electron");
const path = require("path");
const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
} = require("../hooks/server-config");

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";
const isWin = process.platform === "win32";
const WIN_TOPMOST_LEVEL = "pop-up-menu";
const LINUX_WINDOW_TYPE = "toolbar";

module.exports = function initPermission(ctx) {

// Each entry: { res, abortHandler, suggestions, sessionId, bubble, hideTimer, toolName, toolInput, resolvedSuggestion, createdAt, measuredHeight }
const pendingPermissions = [];
// Pure-metadata tools auto-allowed without showing a bubble (zero side effects)
const PASSTHROUGH_TOOLS = new Set([
  "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TaskStop", "TaskOutput",
]);

// Fallback height before renderer reports actual measurement
function estimateBubbleHeight(sugCount) {
  return 200 + (sugCount || 0) * 37;
}

function repositionBubbles() {
  // Stack bubbles from bottom-right upward. Newest (last in array) at bottom.
  if (!ctx.win || ctx.win.isDestroyed()) return;
  const margin = 8;
  const gap = 6;
  const bw = 340;
  const petBounds = ctx.win.getBounds();
  const cx = petBounds.x + petBounds.width / 2;
  const cy = petBounds.y + petBounds.height / 2;
  const wa = ctx.getNearestWorkArea(cx, cy);

  let x, yBottom;
  if (ctx.bubbleFollowPet) {
    // Use hitbox bottom for tight positioning against actual pet body
    const hit = ctx.getHitRectScreen(petBounds);
    const hitBottom = Math.round(hit.bottom);
    const hitCx = Math.round((hit.left + hit.right) / 2);

    // Calculate total bubble stack height
    let totalH = 0;
    for (const perm of pendingPermissions) {
      totalH += (perm.measuredHeight || estimateBubbleHeight((perm.suggestions || []).length)) + gap;
    }

    // Degradation: if total bubble height exceeds half the workspace, fall back to
    // default bottom-right stacking so bubbles don't crowd the pet or overflow
    if (totalH > wa.height / 2) {
      x = wa.x + wa.width - bw - margin;
      yBottom = wa.y + wa.height - margin;
      // Fall through to upward stacking loop below
    } else if (wa.y + wa.height - hitBottom >= totalH) {
      // Enough room below — place bubbles under the pet body
      x = Math.max(wa.x, Math.min(hitCx - Math.round(bw / 2), wa.x + wa.width - bw));
      let yTop = hitBottom;
      for (let i = pendingPermissions.length - 1; i >= 0; i--) {
        const perm = pendingPermissions[i];
        const bh = perm.measuredHeight || estimateBubbleHeight((perm.suggestions || []).length);
        if (perm.bubble && !perm.bubble.isDestroyed()) {
          perm.bubble.setBounds({ x, y: yTop, width: bw, height: bh });
        }
        yTop += bh + gap;
      }
      return;
    } else {
      // Not enough room below — place to the side with more space
      const hitRight = Math.round(hit.right);
      const hitLeft = Math.round(hit.left);
      const spaceRight = wa.x + wa.width - hitRight;
      const spaceLeft = hitLeft - wa.x;
      if (spaceRight >= bw || spaceRight >= spaceLeft) {
        x = Math.min(hitRight, wa.x + wa.width - bw);
      } else {
        x = Math.max(wa.x, hitLeft - bw);
      }
      // Side fallback: stack from workspace bottom upward (not pet bottom, which would occlude pet)
      yBottom = wa.y + wa.height - margin;
    }
  } else {
    // Default: bottom-right corner of nearest work area
    x = wa.x + wa.width - bw - margin;
    yBottom = wa.y + wa.height - margin;
  }

  // Iterate in reverse: newest bubble (end of array) gets the bottom slot
  for (let i = pendingPermissions.length - 1; i >= 0; i--) {
    const perm = pendingPermissions[i];
    const bh = perm.measuredHeight || estimateBubbleHeight((perm.suggestions || []).length);
    const y = yBottom - bh;
    yBottom = y - gap;
    if (perm.bubble && !perm.bubble.isDestroyed()) {
      perm.bubble.setBounds({ x, y, width: bw, height: bh });
    }
  }
}

function showPermissionBubble(permEntry) {
  const sugCount = (permEntry.suggestions || []).length;
  const bh = estimateBubbleHeight(sugCount);
  // Temporary position — repositionBubbles() will finalize after renderer reports real height
  const pos = { x: 0, y: 0, width: 340, height: bh };

  const bub = new BrowserWindow({
    width: pos.width,
    height: pos.height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload-bubble.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  permEntry.bubble = bub;

  if (isWin) {
    bub.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
  }

  bub.loadFile(path.join(__dirname, "bubble.html"));

  bub.webContents.once("did-finish-load", () => {
    bub.webContents.send("permission-show", {
      toolName: permEntry.toolName,
      toolInput: permEntry.toolInput,
      suggestions: permEntry.suggestions || [],
      lang: ctx.lang,
      isElicitation: permEntry.isElicitation || false,
    });
    // Don't call bub.focus() — it steals focus from terminal and can trigger
    // false "User answered in terminal" denials in Claude Code, wasting tokens.
  });

  repositionBubbles();
  bub.showInactive();
  // Linux WMs may reset skipTaskbar after showInactive — re-apply explicitly
  if (isLinux) bub.setSkipTaskbar(true);
  // macOS: apply after showInactive() — it resets NSWindowCollectionBehavior
  ctx.reapplyMacVisibility();

  bub.on("closed", () => {
    const idx = pendingPermissions.indexOf(permEntry);
    if (idx !== -1) {
      resolvePermissionEntry(permEntry, "deny", "Bubble window closed by user");
    }
  });

  ctx.guardAlwaysOnTop(bub);
}

function resolvePermissionEntry(permEntry, behavior, message) {
  // Codex notify bubbles have no HTTP connection — route to dedicated cleanup
  if (permEntry.isCodexNotify) {
    dismissCodexNotify(permEntry);
    return;
  }
  const idx = pendingPermissions.indexOf(permEntry);
  if (idx === -1) return;

  // Minimum display time: if bubble just appeared and dismiss is automatic
  // (client disconnect / terminal answer), delay so user can see it briefly
  const MIN_BUBBLE_DISPLAY_MS = 2000;
  const age = Date.now() - (permEntry.createdAt || 0);
  const isAutoResolve = message === "Client disconnected";
  if (isAutoResolve && age < MIN_BUBBLE_DISPLAY_MS && !permEntry._delayedResolve) {
    permEntry._delayedResolve = true;
    permEntry._delayTimer = setTimeout(() => resolvePermissionEntry(permEntry, behavior, message), MIN_BUBBLE_DISPLAY_MS - age);
    return;
  }

  pendingPermissions.splice(idx, 1);

  const { res, abortHandler, bubble: bub } = permEntry;
  if (abortHandler) res.removeListener("close", abortHandler);

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

  // Guard: client may have disconnected
  if (res.writableEnded || res.destroyed) return;

  if (permEntry.isElicitation) {
    sendPermissionResponse(res, "deny", null, "Elicitation");
    ctx.focusTerminalForSession(permEntry.sessionId);
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

function handleBubbleHeight(event, height) {
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  const perm = pendingPermissions.find(p => p.bubble === senderWin);
  if (perm && typeof height === "number" && height > 0) {
    perm.measuredHeight = Math.ceil(height);
    repositionBubbles();
  }
}

function handleDecide(event, behavior) {
  // Identify which permission this bubble belongs to via sender webContents
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  const perm = pendingPermissions.find(p => p.bubble === senderWin);
  permLog(`IPC permission-decide: behavior=${behavior} matched=${!!perm}`);
  if (!perm) return;
  if (perm.isCodexNotify) {
    dismissCodexNotify(perm);
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
    ctx.focusTerminalForSession(perm.sessionId);
  } else {
    resolvePermissionEntry(perm, behavior === "allow" ? "allow" : "deny");
  }
}

const CODEX_NOTIFY_EXPIRE_MS = 30000;

function showCodexNotifyBubble({ sessionId, command }) {
  if (ctx.doNotDisturb) return;
  const permEntry = {
    res: null,
    abortHandler: null, suggestions: [],
    sessionId, bubble: null, hideTimer: null,
    toolName: "CodexExec",
    toolInput: { command: command || "(unknown)" },
    resolvedSuggestion: null, createdAt: Date.now(),
    isElicitation: false, isCodexNotify: true,
    autoExpireTimer: null,
  };
  pendingPermissions.push(permEntry);
  showPermissionBubble(permEntry);
  permEntry.autoExpireTimer = setTimeout(() => {
    dismissCodexNotify(permEntry);
  }, CODEX_NOTIFY_EXPIRE_MS);
}

function dismissCodexNotify(permEntry) {
  const idx = pendingPermissions.indexOf(permEntry);
  if (idx === -1) return;
  pendingPermissions.splice(idx, 1);
  if (permEntry.autoExpireTimer) clearTimeout(permEntry.autoExpireTimer);
  if (permEntry.hideTimer) clearTimeout(permEntry.hideTimer);
  if (permEntry.bubble && !permEntry.bubble.isDestroyed()) {
    permEntry.bubble.webContents.send("permission-hide");
    const bub = permEntry.bubble;
    setTimeout(() => { if (!bub.isDestroyed()) bub.destroy(); }, 250);
  }
  repositionBubbles();
}

function clearCodexNotifyBubbles(sessionId) {
  if (!pendingPermissions.some(p => p.isCodexNotify)) return;
  const toRemove = pendingPermissions.filter(
    p => p.isCodexNotify && p.sessionId === sessionId
  );
  for (const perm of toRemove) dismissCodexNotify(perm);
}

function cleanup() {
  // Clean up all pending permission requests — send explicit deny so Claude Code doesn't hang
  for (const perm of [...pendingPermissions]) {
    if (perm._delayTimer) clearTimeout(perm._delayTimer);
    resolvePermissionEntry(perm, "deny", "Clawd is quitting");
  }
}

return {
  showPermissionBubble, resolvePermissionEntry,
  sendPermissionResponse, repositionBubbles, permLog,
  pendingPermissions, PASSTHROUGH_TOOLS,
  handleBubbleHeight, handleDecide, cleanup,
  showCodexNotifyBubble, clearCodexNotifyBubbles,
};

};
