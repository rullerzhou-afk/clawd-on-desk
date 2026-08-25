// src/permission.js — Permission bubble management (stacking, show/hide, responses)
// Extracted from main.js L349-357, L1594-1746

const { BrowserWindow, globalShortcut } = require("electron");
const { getDefaultShortcuts } = require("./shortcut-actions");
const { keepOutOfTaskbar } = require("./taskbar");
const { clampTextScale, scaleWidth, scaleHeight, applyZoomToWindow } = require("./text-scale");
const { createTranslator } = require("./i18n");
const { firstStringValue } = require("./bubble-format");
const { MAC_TOPMOST_LEVEL } = require("./topmost-runtime");
const { redactSecrets } = require("./secret-redact");
const path = require("path");
const http = require("http");
const { timingSafeEqual } = require("crypto");
const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
} = require("../hooks/server-config");
const { isOpencodeFamilyEntry, getFamilyConfig } = require("../agents/opencode-family");
const { isPassiveNotifyEntry } = require("./passive-notify-entry");
const {
  normalizeOpencodeFamilyBridgeUrl,
  isValidOpencodeFamilyBridgeToken,
} = require("./opencode-family-bridge-url");
const {
  PERMISSION_AUTOMATION_MODE,
  INTERACTION_INTENT,
  AUTOMATION_ACTION,
  classifyPermissionInteraction,
  evaluatePermissionAutomation,
  isValidInteraction,
  isDecisionInteraction,
} = require("./permission-automation-policy");

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
// CSS px. Multiple of 20 on purpose: every 5% textScale step scales it to an
// integer DIP width, so the CSS viewport width (and therefore renderer-side
// height measurements) stays exact across scale changes.
const BUBBLE_BASE_WIDTH = 340;
const BUBBLE_EXPANDED_BASE_WIDTH = 500;
const BUBBLE_EXPANDED_PREFERRED_HEIGHT = 620;
const BUBBLE_EXPANDED_WORK_AREA_RATIO = 0.6;
const BUBBLE_EXPANDED_CHROME_FALLBACK = 190;
const BUBBLE_EXPANDED_DETAIL_LINE_FALLBACK = 18;
const BUBBLE_EXPANDED_MIN_DETAIL_LINES = 5;
// Hard cap so a scaled bubble can't swallow a small work area.
const BUBBLE_MAX_WORK_AREA_WIDTH_RATIO = 0.9;
const PLAN_FEEDBACK_MAX_LENGTH = 4000;
// WorkBuddy is intentionally absent: its desktop form factor resolves the
// permission loop inside its own native sandbox + GUI, so Clawd never issues a
// rich remote approval for it (see agents/workbuddy.js). If a future CLI form
// factor emits a real PermissionRequest, re-adding it will need a source-owned
// endpoint or server-side identity injection first (WorkBuddy's native events
// carry client:"WorkBuddy", not an agent_id server-agent-id.js recognizes).
const REMOTE_RICH_APPROVAL_AGENT_IDS = new Set(["claude-code", "codebuddy"]);

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
  if (typeof permission.handleImeEditing === "function") {
    on("bubble-ime-editing", (event, editing) => permission.handleImeEditing(event, editing));
  }
  if (typeof permission.handleBubbleExpanded === "function") {
    on("permission-set-expanded", (event, expanded) => permission.handleBubbleExpanded(event, expanded));
  }
  if (typeof permission.handleCompositionActive === "function") {
    on("bubble-composition-active", (event, active) => permission.handleCompositionActive(event, active));
  }

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

function shouldSuppressCodexUserInputBubble(ctx) {
  const policy = getPolicy(ctx, "notification");
  return !!(ctx.doNotDisturb || !policy.enabled);
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

function buildQwenCodePermissionResponseBody(decisionOrBehavior, message) {
  return buildCodexPermissionResponseBody(decisionOrBehavior, message);
}

// ZCode's 3.5.x PermissionRequest schema accepts the same minimal union the
// codex builder emits ({ behavior } allow / { behavior, message } deny).
// End-to-end Allow/Deny is verified on macOS ZCode 3.8.1.
function buildZcodePermissionResponseBody(decisionOrBehavior, message) {
  return buildCodexPermissionResponseBody(decisionOrBehavior, message);
}

function sanitizeAntigravityPermissionDecision(decisionOrBehavior, message) {
  const source = typeof decisionOrBehavior === "string"
    ? { decision: decisionOrBehavior, reason: message }
    : (decisionOrBehavior && typeof decisionOrBehavior === "object" ? decisionOrBehavior : null);
  if (!source) return null;

  const raw = typeof source.decision === "string"
    ? source.decision
    : (typeof source.behavior === "string" ? source.behavior : "");
  const decision = raw === "deny" ? "deny"
    : (raw === "allow" ? "allow"
      : (raw === "ask" || raw === "force_ask" ? raw : null));
  if (!decision) return null;

  const out = { decision };
  const reason = typeof source.reason === "string" && source.reason
    ? source.reason
    : (typeof source.message === "string" ? source.message : "");
  if (reason && decision !== "allow") out.reason = reason;
  if (decision === "allow") out.allowTool = true;
  if (decision === "deny" && reason) out.denyReason = reason;
  return out;
}

function buildAntigravityPermissionResponseBody(decisionOrBehavior, message) {
  const decision = sanitizeAntigravityPermissionDecision(decisionOrBehavior, message);
  return decision ? JSON.stringify(decision) : "{}";
}

// Copilot CLI wire format: hook reads `{behavior, message?}` JSON from the
// HTTP response body and re-emits it on stdout. Unlike Codex/Qwen there is
// no hookSpecificOutput envelope — Phase 0 §5 locked the schema. Anything
// other than allow/deny falls back to "{}" so the caller can emit 204 and
// let copilot-hook.js write empty stdout (Phase 0 §3 native-flow signal).
function sanitizeCopilotPermissionDecision(decisionOrBehavior, message) {
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

function buildCopilotPermissionResponseBody(decisionOrBehavior, message) {
  const decision = sanitizeCopilotPermissionDecision(decisionOrBehavior, message);
  return decision ? JSON.stringify(decision) : "{}";
}

function computePassiveNotifyRemainingMs(createdAt, autoCloseMs, now = Date.now()) {
  const totalMs = Number(autoCloseMs);
  if (!Number.isFinite(totalMs) || totalMs <= 0) return 0;
  const startedAt = Number(createdAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return totalMs;
  return Math.max(0, totalMs - Math.max(0, now - startedAt));
}

function computePermissionAutoCloseRemainingMs(entry, autoCloseMs, now = Date.now()) {
  const timeout = Number(autoCloseMs);
  if (!(timeout > 0)) return 0;
  const createdAt = Number.isFinite(entry && entry.createdAt) ? entry.createdAt : now;
  const completedPause = Number.isFinite(entry && entry.autoClosePausedTotalMs)
    ? Math.max(0, entry.autoClosePausedTotalMs)
    : 0;
  const activePause = Number.isFinite(entry && entry.autoClosePauseStartedAt)
    ? Math.max(0, now - entry.autoClosePauseStartedAt)
    : 0;
  const elapsed = Math.max(0, now - createdAt - completedPause - activePause);
  return Math.max(0, timeout - elapsed);
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

function stackBoundsFromTop(bubbleHeights, x, yTop, width, gap) {
  const bounds = new Array(bubbleHeights.length);
  let y = yTop;
  for (let i = 0; i < bubbleHeights.length; i++) {
    const height = bubbleHeights[i];
    bounds[i] = { x, y, width, height };
    y += height + gap;
  }
  return bounds;
}

function alignVariableBubbleBounds(bounds, bubbleSizes, options) {
  if (!Array.isArray(bounds) || !Array.isArray(bubbleSizes) || bounds.length !== bubbleSizes.length) {
    return bounds;
  }
  const maxWidth = Math.max(...bubbleSizes.map((size) => size.width));
  const first = bounds[0];
  let alignment = "right";
  if (options.followPet && options.hitRect) {
    const hitLeft = Math.round(options.hitRect.left);
    const hitRight = Math.round(options.hitRect.right);
    const fallbackRight = options.workArea.x + options.workArea.width - maxWidth - options.margin;
    if (first.x === hitRight) alignment = "left";
    else if (first.x + maxWidth === hitLeft) alignment = "right";
    else if (first.x === fallbackRight) alignment = "right";
    else alignment = "center";
  } else {
    alignment = normalizeFixedCorner(options.fixedCorner).endsWith("left") ? "left" : "right";
  }

  const result = bounds.map((bound, index) => {
    const size = bubbleSizes[index];
    let x = bound.x;
    if (alignment === "right") x += maxWidth - size.width;
    else if (alignment === "center") x += Math.round((maxWidth - size.width) / 2);
    return { x, y: bound.y, width: size.width, height: size.height };
  });

  const expandedIndex = Number.isInteger(options.expandedIndex) ? options.expandedIndex : -1;
  const expanded = result[expandedIndex];
  if (!expanded) return result;
  const minTop = options.workArea.y + options.margin;
  const maxBottom = options.workArea.y + options.workArea.height - options.margin;
  let shiftY = 0;
  if (expanded.y < minTop) shiftY = minTop - expanded.y;
  if (expanded.y + expanded.height + shiftY > maxBottom) {
    shiftY += maxBottom - (expanded.y + expanded.height + shiftY);
  }
  if (shiftY !== 0) {
    for (const bound of result) bound.y += shiftY;
  }
  return result;
}

function findNonOverlappingStackTop({
  x,
  width,
  totalHeight,
  idealTop,
  workArea,
  margin,
  gap,
  avoidRects,
}) {
  const minTop = workArea.y + margin;
  const maxTop = workArea.y + workArea.height - margin - totalHeight;
  const rects = normalizeAvoidRects(avoidRects);
  if (maxTop < minTop) {
    const overflowRect = { x, y: minTop, width, height: totalHeight };
    return rects.some((rect) => rectsIntersect(overflowRect, rect)) ? null : minTop;
  }

  const clampedIdeal = Math.max(minTop, Math.min(idealTop, maxTop));
  const candidates = new Set([clampedIdeal, minTop, maxTop]);
  for (const rect of rects) {
    if (x >= rect.x + rect.width || x + width <= rect.x) continue;
    candidates.add(rect.y - gap - totalHeight);
    candidates.add(rect.y + rect.height + gap);
  }

  return [...candidates]
    .filter((candidate) => Number.isFinite(candidate) && candidate >= minTop && candidate <= maxTop)
    .sort((a, b) => Math.abs(a - idealTop) - Math.abs(b - idealTop) || a - b)
    .find((candidate) => {
      const stackRect = { x, y: candidate, width, height: totalHeight };
      return !rects.some((rect) => rectsIntersect(stackRect, rect));
    });
}

function findDownwardStackTop({
  x,
  width,
  totalHeight,
  idealTop,
  workArea,
  gap,
  avoidRects,
}) {
  const minTop = workArea.y;
  const maxTop = workArea.y + workArea.height - totalHeight;
  if (maxTop < minTop || idealTop > maxTop) return null;
  let y = Math.max(minTop, idealTop);
  const rects = normalizeAvoidRects(avoidRects);

  for (let pass = 0; pass <= rects.length; pass++) {
    const stackRect = { x, y, width, height: totalHeight };
    const collisions = rects.filter((rect) => rectsIntersect(stackRect, rect));
    if (collisions.length === 0) return y;
    y = Math.max(y, ...collisions.map((rect) => rect.y + rect.height + gap));
    if (y > maxTop) return null;
  }
  return null;
}

// Pure layout calculator for the permission bubble stack. Returns one bounds
// object per height in oldest→newest order. Follow placement uses an ordered
// preference with safe fallback; fixed placement anchors to one work-area
// corner. Across every branch, the oldest request remains visually highest.
function computeBubbleStackLayout({
  followPet,
  followPreference = "auto",
  fixedCorner = "bottom-right",
  bubbleHeights,
  bubbleWidth: bw,
  margin,
  gap,
  workArea: wa,
  hitRect,
  hudReservedOffset = 0,
  avoidRects = [],
  bubbleSizes = null,
  expandedIndex = -1,
}) {
  if (Array.isArray(bubbleSizes)) {
    const sizes = bubbleSizes.map((size) => ({
      width: Math.max(1, Math.round(Number(size && size.width) || 0)),
      height: Math.max(1, Math.round(Number(size && size.height) || 0)),
    }));
    if (sizes.length === 0) return [];
    const maxWidth = Math.max(...sizes.map((size) => size.width));
    const uniformBounds = computeBubbleStackLayout({
      followPet,
      followPreference,
      fixedCorner,
      bubbleHeights: sizes.map((size) => size.height),
      bubbleWidth: maxWidth,
      margin,
      gap,
      workArea: wa,
      hitRect,
      hudReservedOffset,
      avoidRects,
    });
    return alignVariableBubbleBounds(uniformBounds, sizes, {
      followPet,
      fixedCorner,
      hitRect,
      expandedIndex,
      workArea: wa,
      margin,
    });
  }
  const N = bubbleHeights.length;
  if (N === 0) return [];

  // totalH = sum of heights + (N-1) gaps. The previous in-place loop in
  // repositionBubbles added a gap after every bubble (N gaps total), which
  // over-counted by one gap and slightly skewed both the below/side cutoff
  // and the side vertical centering. Fixed here.
  let totalH = 0;
  for (let i = 0; i < N; i++) {
    totalH += bubbleHeights[i];
    if (i < N - 1) totalH += gap;
  }

  const buildCorner = (corner, allowCollisionFallback = false) => {
    const normalizedCorner = normalizeFixedCorner(corner);
    const left = normalizedCorner.endsWith("left");
    const top = normalizedCorner.startsWith("top");
    const x = left
      ? wa.x + margin
      : wa.x + wa.width - bw - margin;
    const minTop = wa.y + margin;
    const bottomTop = wa.y + wa.height - margin - totalH;
    const idealTop = top || bottomTop < minTop ? minTop : bottomTop;
    const yTop = findNonOverlappingStackTop({
      x,
      width: bw,
      totalHeight: totalH,
      idealTop,
      workArea: wa,
      margin,
      gap,
      avoidRects,
    });
    if (yTop !== undefined && yTop !== null) {
      return stackBoundsFromTop(bubbleHeights, x, yTop, bw, gap);
    }
    return allowCollisionFallback
      ? stackBoundsFromTop(bubbleHeights, x, idealTop, bw, gap)
      : null;
  };

  if (followPet && hitRect) {
    const hitBottom = Math.round(hitRect.bottom);
    const hitLeft = Math.round(hitRect.left);
    const hitRight = Math.round(hitRect.right);
    const hitCx = Math.round((hitRect.left + hitRect.right) / 2);
    const hitCy = Math.round((hitRect.top + hitRect.bottom) / 2);
    const reserve = Math.max(0, Number(hudReservedOffset) || 0);
    const spaceRight = wa.x + wa.width - hitRight;
    const spaceLeft = hitLeft - wa.x;
    const sideOrder = spaceRight >= spaceLeft ? ["right", "left"] : ["left", "right"];
    const preference = normalizeFollowPreference(followPreference);
    const candidateOrder = preference === "left"
      ? ["left", "below", "right"]
      : (preference === "right"
        ? ["right", "below", "left"]
        : ["below", ...sideOrder]);

    const tryBelow = () => {
      const x = Math.max(wa.x, Math.min(hitCx - Math.round(bw / 2), wa.x + wa.width - bw));
      const yTop = findDownwardStackTop({
        x,
        width: bw,
        totalHeight: totalH,
        idealTop: hitBottom + reserve,
        workArea: wa,
        gap,
        avoidRects,
      });
      if (yTop === undefined || yTop === null) return null;
      return stackBoundsFromTop(bubbleHeights, x, yTop, bw, gap);
    };

    const trySide = (side) => {
      if (side === "right" && spaceRight < bw) return null;
      if (side === "left" && spaceLeft < bw) return null;
      const x = side === "right" ? hitRight : hitLeft - bw;
      const idealTop = hitCy - Math.round(totalH / 2);
      const yTop = findNonOverlappingStackTop({
        x,
        width: bw,
        totalHeight: totalH,
        idealTop,
        workArea: wa,
        margin,
        gap,
        avoidRects,
      });
      return yTop === undefined || yTop === null
        ? null
        : stackBoundsFromTop(bubbleHeights, x, yTop, bw, gap);
    };

    for (const candidate of candidateOrder) {
      const result = candidate === "below" ? tryBelow() : trySide(candidate);
      if (result) return result;
    }
    return buildCorner("bottom-right", true);
  }

  return buildCorner(fixedCorner, true);
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

// Remote clients (Feishu / Telegram) clamp question text to card / message
// limits before display (240 chars, trimmed, control chars stripped), so the
// text they hold no longer round-trips to toolInput for long or
// whitespace-heavy questions. Both remote clients and the desktop renderer
// therefore key submitted answers by question index. Only this main-process
// boundary maps those opaque display ids back to the exact upstream wire keys.
function remapIndexedElicitationAnswers(toolInput, indexedAnswers) {
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const source = indexedAnswers && typeof indexedAnswers === "object" && !Array.isArray(indexedAnswers)
    ? indexedAnswers
    : {};
  const answers = {};
  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    if (!question || typeof question.question !== "string" || !question.question) continue;
    if (!Object.prototype.hasOwnProperty.call(source, String(i))) continue;
    answers[question.question] = source[String(i)];
  }
  return answers;
}

// Treat renderer/remote answer payloads as untrusted input. An elicitation is
// only an allow when every upstream question has exactly one non-empty answer;
// partial maps used to turn into a successful allow with missing fields, which
// could make the agent loop or silently choose a default.
function validateAndRemapIndexedElicitationAnswers(toolInput, indexedAnswers) {
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  const questions = Array.isArray(input.questions) ? input.questions : [];
  if (questions.length === 0) {
    return { ok: false, reason: "elicitation has no questions" };
  }
  if (
    !indexedAnswers
    || typeof indexedAnswers !== "object"
    || Array.isArray(indexedAnswers)
  ) {
    return { ok: false, reason: "elicitation answers must be an indexed object" };
  }

  const sourceKeys = Object.keys(indexedAnswers);
  const expectedKeys = questions.map((_question, index) => String(index));
  if (
    sourceKeys.length !== expectedKeys.length
    || sourceKeys.some((key) => !expectedKeys.includes(key))
  ) {
    return { ok: false, reason: "elicitation answers do not match all questions" };
  }

  const seenWireQuestions = new Set();
  const answers = {};
  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    const wireQuestion = question && typeof question.question === "string"
      ? question.question
      : "";
    if (!wireQuestion || seenWireQuestions.has(wireQuestion)) {
      return { ok: false, reason: "elicitation questions have invalid or duplicate wire keys" };
    }
    seenWireQuestions.add(wireQuestion);
    const answer = indexedAnswers[String(i)];
    if (typeof answer !== "string" || !answer.trim()) {
      return { ok: false, reason: `elicitation answer ${i} is empty` };
    }
    answers[wireQuestion] = answer.trim();
  }
  return { ok: true, answers };
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
  if (perm.tmuxSocket) focusEntry.tmuxSocket = perm.tmuxSocket;
  if (perm.tmuxClient) focusEntry.tmuxClient = perm.tmuxClient;
  if (perm.orcaPaneKey) focusEntry.orcaPaneKey = perm.orcaPaneKey;
  if (perm.host) focusEntry.host = perm.host;
  if (perm.platform) focusEntry.platform = perm.platform;
  if (perm.model) focusEntry.model = perm.model;
  if (perm.codexOriginator) focusEntry.codexOriginator = perm.codexOriginator;
  if (perm.codexSource) focusEntry.codexSource = perm.codexSource;
  return focusEntry;
}

function collectVisibleWindowBounds(windows) {
  const bounds = [];
  for (const bubble of windows || []) {
    if (!bubble || bubble.isDestroyed()) continue;
    if (typeof bubble.isVisible === "function" && !bubble.isVisible()) continue;
    if (typeof bubble.getBounds !== "function") continue;
    try {
      const rect = bubble.getBounds();
      if (rect && rect.width > 0 && rect.height > 0) bounds.push(rect);
    } catch {}
  }
  return bounds;
}

module.exports = function initPermission(ctx) {

// Bound to ctx.lang (a live getter), so a runtime language switch is picked up
// by the next remote-approval payload without recreating this module.
const t = createTranslator(() => ctx.lang);

// Each entry: { res, abortHandler, suggestions, sessionId, bubble, hideTimer, toolName, toolInput, resolvedSuggestion, createdAt, measuredHeight }
const pendingPermissions = [];
let expandedPermissionEntry = null;
// Keep windows independently of pendingPermissions so Orbit continues avoiding
// a bubble during its 250ms fade-out after the request has already been removed
// from the pending list.
const permissionBubbleWindows = new Set();
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
    p => !isPassiveNotifyEntry(p)
      && isValidInteraction(p.interaction)
      && p.interaction.capabilities.allowDeny === true
      && p.textInputActive !== true
      && (p.interaction.intent !== INTERACTION_INTENT.PLAN_REVIEW || p.expanded === true)
      && !isDecisionInteraction(p.interaction)
  );
}

// #601: hotkeys must reach exactly what is on screen. While the pet is hidden,
// bubbles pending at hide time are collapsed (they return on show) but new
// requests still pop (docs/project/theme-state-ui.md) — so gate on bubble
// visibility instead of dropping the hotkeys wholesale, and never let a blind
// keypress resolve a request whose bubble the user cannot see. When the pet is
// visible, keep the plain actionable list: entries without a bubble window
// (creation failed / not yet created) must stay hotkey-reachable.
function getHotkeyActionablePermissions() {
  const actionable = getActionablePermissions();
  if (!ctx.petHidden) return actionable;
  return actionable.filter((p) => {
    const bub = p.bubble;
    try {
      return !!bub && !bub.isDestroyed() && bub.isVisible();
    } catch {
      return false;
    }
  });
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
  const shouldRegister = permissionPolicy.enabled
    && getHotkeyActionablePermissions().length > 0;
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
  if (typeof ctx.repositionSessionHud === "function") {
    try { ctx.repositionSessionHud(); } catch {}
  }
}

function getVisibleBubbleBounds() {
  return collectVisibleWindowBounds(permissionBubbleWindows);
}

function hotkeyResolve(behavior, message) {
  const targets = getHotkeyActionablePermissions();
  if (!targets.length) return;
  const perm = targets[targets.length - 1]; // newest
  captureFrontApp((appName) => {
    resolvePermissionEntry(perm, behavior, message);
    if (appName) {
      setTimeout(() => restoreFrontApp(appName), RESTORE_FOCUS_DELAY_MS);
    }
    // If macOS frontmost-app capture fails, leave focus untouched. Hotkeys are
    // meant to answer without pulling the user back to the agent terminal.
  });
}

function hotkeyAllow() { hotkeyResolve("allow"); }
function hotkeyDeny()  { hotkeyResolve("deny", "Denied via hotkey"); }

const unsubscribeShortcuts = typeof ctx.subscribeShortcuts === "function"
  ? ctx.subscribeShortcuts(() => syncPermissionShortcuts())
  : null;

// Fallback height before renderer reports actual measurement. CSS px, like
// perm.measuredHeight — both are converted to DIP at the consumption points.
function estimateBubbleHeight(sugCount) {
  return 200 + (sugCount || 0) * 37;
}

function getTextScale(workArea) {
  return clampTextScale(typeof ctx.getTextScale === "function" ? ctx.getTextScale(workArea) : 1);
}

function getBubbleWidth(scale, workArea) {
  const scaled = scaleWidth(BUBBLE_BASE_WIDTH, scale);
  const waWidth = Math.floor(Number(workArea && workArea.width) || 0);
  if (waWidth <= 0) return scaled;
  return Math.min(scaled, Math.floor(waWidth * BUBBLE_MAX_WORK_AREA_WIDTH_RATIO));
}

function getExpandedBubbleWidth(scale, workArea) {
  const scaled = scaleWidth(BUBBLE_EXPANDED_BASE_WIDTH, scale);
  const waWidth = Math.floor(Number(workArea && workArea.width) || 0);
  if (waWidth <= 0) return scaled;
  return Math.min(scaled, Math.floor(waWidth * BUBBLE_MAX_WORK_AREA_WIDTH_RATIO));
}

function ensureBubblePresentationState(perm) {
  if (!perm || typeof perm !== "object") return;
  if (!Number.isInteger(perm.measurementEpoch) || perm.measurementEpoch < 0) {
    perm.measurementEpoch = 0;
  }
  if (perm.expanded !== true) perm.expanded = false;
  if (perm.compositionActive !== true) perm.compositionActive = false;
}

function getCompactBubbleHeight(perm, scale, workArea) {
  return clampBubbleHeight(
    scaleHeight(
      perm.compactMeasuredHeight
        || perm.measuredHeight
        || estimateBubbleHeight((perm.suggestions || []).length),
      scale
    ),
    workArea.height
  );
}

function computeExpandedHeightBudget(perm, scale, workArea, margin, gap) {
  const otherEntries = pendingPermissions.filter((entry) => entry !== perm && !entry.remoteOnly);
  const compactSiblingHeight = otherEntries.reduce(
    (sum, entry) => sum + getCompactBubbleHeight(entry, scale, workArea),
    0
  );
  const stackGaps = Math.max(0, pendingPermissions.filter((entry) => !entry.remoteOnly).length - 1) * gap;
  const preferred = Math.min(
    scaleHeight(BUBBLE_EXPANDED_PREFERRED_HEIGHT, scale),
    Math.floor(workArea.height * BUBBLE_EXPANDED_WORK_AREA_RATIO)
  );
  const chromeHeight = scaleHeight(
    perm.expandedChromeHeight || BUBBLE_EXPANDED_CHROME_FALLBACK,
    scale
  );
  const detailLineHeight = scaleHeight(
    perm.expandedDetailLineHeight || BUBBLE_EXPANDED_DETAIL_LINE_FALLBACK,
    scale
  );
  const readableFloor = chromeHeight + detailLineHeight * BUBBLE_EXPANDED_MIN_DETAIL_LINES;
  const stackBudget = workArea.height - margin * 2 - compactSiblingHeight - stackGaps;
  const workAreaCap = Math.max(1, workArea.height - margin * 2);
  return Math.min(workAreaCap, Math.max(readableFloor, Math.min(preferred, stackBudget)));
}

function getExpandedBubbleHeight(perm, scale, workArea, margin, gap) {
  const budget = Math.min(
    perm.expandedHeightBudget || computeExpandedHeightBudget(perm, scale, workArea, margin, gap),
    Math.max(1, workArea.height - margin * 2)
  );
  const natural = scaleHeight(
    perm.expandedMeasuredHeight || BUBBLE_EXPANDED_PREFERRED_HEIGHT,
    scale
  );
  return Math.max(1, Math.min(natural, budget));
}

function getExpandedBudgetKey(workArea, scale) {
  return [workArea.x, workArea.y, workArea.width, workArea.height, scale].join(":");
}

function getAnchorWorkArea(petBounds) {
  const bounds = petBounds || ctx.getPetWindowBounds();
  if (typeof ctx.getBubbleWorkArea === "function") {
    return ctx.getBubbleWorkArea(!!ctx.bubbleFollowPet, bounds);
  }
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  return ctx.getNearestWorkArea(cx, cy);
}

function getHudAvoidRects() {
  if (typeof ctx.getSessionHudBounds !== "function") return [];
  try {
    const bounds = ctx.getSessionHudBounds();
    return Array.isArray(bounds) ? bounds : (bounds ? [bounds] : []);
  } catch {
    return [];
  }
}

function repositionBubbles() {
  // Thin wrapper around computeBubbleStackLayout (top of file). All the
  // geometry lives there so it can be unit-tested without Electron windows.
  if (!ctx.win || ctx.win.isDestroyed()) return;
  const petBounds = ctx.getPetWindowBounds();
  const wa = getAnchorWorkArea(petBounds);
  const scale = getTextScale(wa);
  const margin = Math.round(8 * scale);
  const gap = Math.round(6 * scale);
  const compactWidth = getBubbleWidth(scale, wa);
  const expandedWidth = getExpandedBubbleWidth(scale, wa);
  const hitRect = ctx.bubbleFollowPet ? ctx.getHitRectScreen(petBounds) : null;
  const hudAvoidRects = getHudAvoidRects();

  const layoutPermissions = pendingPermissions.filter((perm) => !perm.remoteOnly);
  const bubbleSizes = layoutPermissions.map((perm) => {
    ensureBubblePresentationState(perm);
    if (perm.expanded) {
      const budgetKey = getExpandedBudgetKey(wa, scale);
      if (perm.expandedBudgetKey && perm.expandedBudgetKey !== budgetKey) {
        perm.expandedHeightBudget = computeExpandedHeightBudget(perm, scale, wa, margin, gap);
        perm.expandedHeightBudgetMeasured = false;
        perm.measurementEpoch += 1;
        sendPermissionPresentation(perm);
      }
      perm.expandedBudgetKey = budgetKey;
    }
    return perm.expanded
      ? {
          width: expandedWidth,
          height: getExpandedBubbleHeight(perm, scale, wa, margin, gap),
        }
      : {
          width: compactWidth,
          height: getCompactBubbleHeight(perm, scale, wa),
        };
  });
  const expandedIndex = layoutPermissions.findIndex((perm) => perm.expanded === true);

  const bounds = computeBubbleStackLayout({
    followPet: !!ctx.bubbleFollowPet,
    followPreference: ctx.bubbleFollowPreference,
    fixedCorner: ctx.bubbleFixedCorner,
    bubbleHeights: bubbleSizes.map((size) => size.height),
    bubbleWidth: compactWidth,
    bubbleSizes,
    expandedIndex,
    margin,
    gap,
    workArea: wa,
    hitRect,
    // A live HUD rectangle is the authoritative collision source. Keep the
    // legacy scalar reserve only as a fallback for older/incomplete runtimes
    // that cannot expose the actual window bounds.
    hudReservedOffset: hudAvoidRects.length === 0 && typeof ctx.getHudReservedOffset === "function"
      ? ctx.getHudReservedOffset()
      : 0,
    avoidRects: hudAvoidRects,
  });

  for (let i = 0; i < layoutPermissions.length; i++) {
    const perm = layoutPermissions[i];
    if (perm.bubble && !perm.bubble.isDestroyed() && bounds[i]) {
      // Re-resolve zoom here too: the pet may have crossed onto a display
      // with a different textScale (applyZoomToWindow memoizes, so this is
      // a no-op when nothing changed).
      applyZoomToWindow(perm.bubble, scale);
      // #640: a bubble whose text field is being typed into holds its
      // position — followPet anchoring must not yank the input box around
      // mid-composition (pet drag; roam is separately paused while editing).
      // Fresh bubbles never carry the flag, so they still get placed.
      if (perm.bubble.__clawdMacImeEditing) continue;
      perm.bubble.setBounds(bounds[i]);
    }
  }
}

// Permission-automation chokepoint. Every agent branch in the /permission route
// funnels through showPermissionBubble after its DND / per-agent / headless
// gates have already run, so this is the single place to honor the
// runtime mode without auto-approving requests those gates
// meant to drop. Passive notifications (codex/kimi) are excluded — they are
// not approvals and carry no HTTP response
// to satisfy. Returns true when it consumed the entry (caller must NOT build a
// bubble), false otherwise.

// Session-scoped automation can run after the route has returned (for example,
// when a grant sweeps an already-queued request). Re-check the live permission
// object instead of trusting a snapshot captured at route time.
function isPermissionEntryLive(permEntry) {
  if (!permEntry || !pendingPermissions.includes(permEntry)) return false;
  if (permEntry._delayedResolve === true) return false;
  if (permEntry._sessionTrustLifecycleCancelled === true) return false;
  if (isPassiveNotifyEntry(permEntry)) return false;

  // opencode/MiMo ACK the inbound HTTP request immediately and reply through a
  // reverse bridge. Until that adapter exposes a positive, request-specific
  // bridge-liveness signal, membership in pendingPermissions is not enough to
  // prove that an automated decision can still reach the real request.
  if (isOpencodeFamilyEntry(permEntry)) return false;

  const res = permEntry.res;
  if (!res || typeof res !== "object") return false;
  if (res.destroyed === true) return false;
  if (res.writableEnded === true) return false;
  if (res.writableFinished === true) return false;
  return true;
}

function isInteractiveCodexSubagentEntry(permEntry) {
  return !!(permEntry
    && permEntry.isCodex === true
    && permEntry.codexInteractiveSubagent === true
    && permEntry.headless !== true);
}

function isPermissionEntryHeadless(permEntry) {
  if (!permEntry || typeof permEntry !== "object") return false;
  if (permEntry.headless === true) return true;
  const session = ctx.sessions && typeof ctx.sessions.get === "function"
    ? ctx.sessions.get(permEntry.sessionId)
    : null;
  return !!(session
    && session.headless === true
    && !isInteractiveCodexSubagentEntry(permEntry));
}

function canAutoResolvePendingPermission(permEntry, options = {}) {
  if (!isPermissionEntryLive(permEntry)) return false;
  if (ctx.doNotDisturb) return false;

  const agentId = typeof permEntry.agentId === "string"
    ? permEntry.agentId.trim()
    : "";
  if (!agentId) return false;
  if (typeof ctx.isAgentEnabled !== "function" || !ctx.isAgentEnabled(agentId)) {
    return false;
  }
  if (
    typeof ctx.isAgentPermissionsEnabled !== "function"
    || !ctx.isAgentPermissionsEnabled(agentId)
  ) {
    return false;
  }
  if (
    (permEntry.subagentId || permEntry.subagentType)
    && (
      typeof ctx.isAgentSubagentPermissionsEnabled !== "function"
      || !ctx.isAgentSubagentPermissionsEnabled(agentId)
    )
  ) {
    return false;
  }

  if (isPermissionEntryHeadless(permEntry)) return false;

  if (
    permEntry.isCodex
    && (
      typeof ctx.isCodexPermissionInterceptEnabled !== "function"
      || !ctx.isCodexPermissionInterceptEnabled()
    )
  ) {
    return false;
  }

  const identity = permEntry.sessionAutomationIdentity;
  if (!identity || identity.eligible !== true) return false;

  let mode = options.mode;
  if (mode === undefined) {
    mode = options.sessionOnly === true
      ? PERMISSION_AUTOMATION_MODE.OFF
      : (
          typeof ctx.getPermissionAutomationMode === "function"
            ? ctx.getPermissionAutomationMode()
            : PERMISSION_AUTOMATION_MODE.OFF
        );
  }

  return evaluatePermissionAutomation({
    mode,
    interaction: permEntry.interaction,
    entry: permEntry,
  }) === AUTOMATION_ACTION.AUTO_ALLOW;
}

// Default reply used to answer AskUserQuestion / clarify prompts while
// auto-pilot is on. The user isn't present to type, so we explicitly defer the
// choice back to the agent rather than sending blank answers.
const AUTO_APPROVE_ELICITATION_ANSWER = "You choose whatever is best.";

// Build an answers map that assigns the deferral reply to every question in the
// elicitation toolInput. Mirrors the question-key shape buildElicitationUpdatedInput
// expects (keyed by the question text), so each prompt gets a real answer rather
// than being dropped as empty.
function buildAutoApproveElicitationAnswers(toolInput) {
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const answers = {};
  for (const question of questions) {
    if (!question || typeof question.question !== "string" || !question.question) continue;
    answers[question.question] = AUTO_APPROVE_ELICITATION_ANSWER;
  }
  return answers;
}

function maybeAutoApprovePermission(permEntry) {
  if (!permEntry) return false;
  if (isPassiveNotifyEntry(permEntry)) return false;
  const mode = typeof ctx.getEffectivePermissionAutomationMode === "function"
    ? ctx.getEffectivePermissionAutomationMode(permEntry, { sessionOnly: false })
    : (
        typeof ctx.getPermissionAutomationMode === "function"
          ? ctx.getPermissionAutomationMode()
          : PERMISSION_AUTOMATION_MODE.OFF
      );
  const action = evaluatePermissionAutomation({
    mode,
    interaction: permEntry.interaction,
    entry: permEntry,
  });
  if (action === AUTOMATION_ACTION.DEFER) {
    if (!isValidInteraction(permEntry.interaction)) {
      permLog(`automation defer: invalid interaction tool=${permEntry.toolName} session=${permEntry.sessionId} agent=${permEntry.agentId || "unknown"}`);
    } else if (
      mode !== PERMISSION_AUTOMATION_MODE.OFF
      && permEntry.interaction.intent === INTERACTION_INTENT.UNKNOWN
    ) {
      permLog(`automation defer: unknown interaction mode=${mode} tool=${permEntry.toolName || "(missing)"} session=${permEntry.sessionId} agent=${permEntry.agentId || "unknown"}`);
    }
    return false;
  }

  // Global automation keeps its existing adapter-wide behavior. A session
  // override, however, may be consumed after the route has created the entry,
  // so it must pass the same current liveness/gate/identity chokepoint used by
  // warning returns, remote commit, and sweep.
  if (action === AUTOMATION_ACTION.AUTO_ALLOW) {
    const hasSessionOverride = typeof ctx.hasSessionAutomationOverride === "function"
      && ctx.hasSessionAutomationOverride(permEntry);
    // Interactive Codex children may inherit global automation only when the
    // same route-owned identity and live gates used by session automation are
    // valid. This prevents a Desktop/unknown process identity from turning an
    // otherwise manual Agent-thread bubble into an automatic allow.
    const needsLiveGate = hasSessionOverride || isInteractiveCodexSubagentEntry(permEntry);
    if (needsLiveGate && !canAutoResolvePendingPermission(permEntry, { mode })) return false;
  }

  if (action === AUTOMATION_ACTION.AUTO_ANSWER) {
    const wireInput = permEntry.elicitationWireInput || permEntry.toolInput;
    permEntry.resolvedUpdatedInput = buildElicitationUpdatedInput(
      wireInput,
      buildAutoApproveElicitationAnswers(wireInput)
    );
  }

  permLog(`permission automation: mode=${mode} action=${action} intent=${permEntry.interaction.intent} tool=${permEntry.toolName} session=${permEntry.sessionId} agent=${permEntry.agentId || "claude-code"}`);
  resolvePermissionEntry(permEntry, "allow");
  return true;
}


// Shared by the per-bubble closure below and by the exported test seam. The
// closure owns the ownership checks (is this still *my* window?); this owns
// what happens once a failure is real.
function handlePermissionBubbleFailure(permEntry, reason) {
  permEntry._bubbleFatalHandled = true;
  if (isPassiveNotifyEntry(permEntry)) {
    permLog(`passive notification bubble failed; dismissing: ${reason} tool=${permEntry.toolName} session=${permEntry.sessionId} agent=${permEntry.agentId || "unknown"}`);
    dismissPassiveNotify(permEntry, `bubble-failed:${reason}`);
    return true;
  }
  permLog(`permission bubble failed; returning no-decision: ${reason} tool=${permEntry.toolName} session=${permEntry.sessionId} agent=${permEntry.agentId || "unknown"}`);
  resolvePermissionEntry(permEntry, "no-decision", reason);
  return true;
}

function showPermissionBubble(permEntry) {
  // Auto-pilot: if enabled, approve immediately and never render a bubble.
  if (maybeAutoApprovePermission(permEntry)) return;
  ensureBubblePresentationState(permEntry);

  const canOfferSessionTrust = typeof ctx.canOfferSessionTrust === "function"
    && ctx.canOfferSessionTrust(permEntry) === true;
  const sugCount = (permEntry.suggestions || []).length + (canOfferSessionTrust ? 1 : 0);
  const wa = getAnchorWorkArea();
  const scale = getTextScale(wa);
  const bh = clampBubbleHeight(scaleHeight(estimateBubbleHeight(sugCount), scale), wa.height);
  // Temporary position — repositionBubbles() will finalize after renderer reports real height
  const pos = { x: 0, y: 0, width: getBubbleWidth(scale, wa), height: bh };

  // Bubbles that host a text input (elicitation "Other", ExitPlanMode
  // feedback) need keyboard focus. On macOS, the topmost level is dropped
  // per-edit at runtime instead (see handleImeEditing) so the IME candidate
  // window isn't occluded.
  const interactionCapabilities = isValidInteraction(permEntry.interaction)
    ? permEntry.interaction.capabilities
    : {};
  const needsTextInput = interactionCapabilities.answerQuestions === true
    || interactionCapabilities.planFeedback === true;

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
    ...(isMac ? { type: "panel", acceptFirstMouse: true } : {}),
    // Elicitation needs keyboard focus for the Other/textarea input path.
    // Permission prompts need focusable: true on macOS to receive clicks,
    // while acceptFirstMouse lets the first click hit the inactive panel.
    // ExitPlanMode needs keyboard focus for the "Tell Claude what to change"
    // textarea feedback path on other platforms.
    focusable: isMac ? true : needsTextInput,
    webPreferences: {
      preload: path.join(__dirname, "preload-bubble.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Partial-create rollback: a synchronous throw after the BrowserWindow
  // exists (setAlwaysOnTop/showInactive/repositioning on exotic platforms,
  // shortcut sync, autoclose arming) must not orphan a live window with
  // registered close handlers while the route-level catch drops the pending
  // entry — nothing would ever close that window. Strip listeners, destroy
  // the window, and rethrow so the caller finishes the rollback.
  try {
    permEntry.bubble = bub;
    permissionBubbleWindows.add(bub);
    permEntry.bubbleReady = false;
    // macOS: text-input bubbles skip the native stationary treatment (SkyLight
    // private space) that occludes the OS IME candidate window. They stay
    // cross-space visible via Electron and drop out of always-on-top while a text
    // field is focused (handleImeEditing) so CJK input popups can surface.
    if (isMac && needsTextInput) bub.__clawdMacTextInputBubble = true;

    if (isWin) {
      bub.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    }

    bub.webContents.once("did-finish-load", () => {
      if (pendingPermissions.indexOf(permEntry) === -1 || permEntry.bubble !== bub) return;
      permEntry.bubbleReady = true;
      // Explicit even though same-origin propagation usually covers it — a
      // stale partition-persisted factor must never win over prefs.
      applyZoomToWindow(bub, getTextScale(getAnchorWorkArea()));
      syncPermissionBubbleContent(permEntry);
      // Arrival never steals focus. Plan/Ask receive focus only after the user
      // explicitly expands the bubble (handleBubbleExpanded).
    });

    bub.on("closed", () => {
      permissionBubbleWindows.delete(bub);
      const idx = pendingPermissions.indexOf(permEntry);
      if (idx !== -1) {
        // Qwen + Copilot + ZCode + DSH can hand no-decision back to their native
        // flow. Hermes has no native permission UI, so its opt-in plugin gate
        // treats this as a retryable block. In every case we avoid fabricating a
        // user denial. CC/CodeBuddy still get an explicit deny for this
        // user-close action.
        const behavior = (
          permEntry.isQwenCode
          || permEntry.isCopilotCli
          || permEntry.isHermes
          || permEntry.isZcode
          || permEntry.isDsh
        ) ? "no-decision" : "deny";
        resolvePermissionEntry(permEntry, behavior, "Bubble window closed by user");
      }
      repositionDependentBubbles();
    });

    function failPermissionBubble(reason) {
      if (
        permEntry._bubbleFatalHandled
        || pendingPermissions.indexOf(permEntry) === -1
        || permEntry.bubble !== bub
      ) {
        return false;
      }
      handleBubbleRendererGone(bub);
      return handlePermissionBubbleFailure(permEntry, reason);
    }

    // Loading or renderer failure must release the blocking hook. Returning
    // no-decision lets agents with a native approval flow take over and avoids
    // fabricating either an allow or a deny.
    bub.webContents.once("did-fail-load", (_event, errorCode, errorDescription) => {
      failPermissionBubble(
        `Permission bubble failed to load (${errorCode || "unknown"}: ${errorDescription || "unknown error"})`
      );
    });
    bub.webContents.on("render-process-gone", (_event, details) => {
      const reason = details && details.reason ? details.reason : "unknown";
      failPermissionBubble(`Permission bubble renderer exited (${reason})`);
    });

    let loadFailedSynchronously = false;
    try {
      const loadResult = bub.loadFile(path.join(__dirname, "bubble.html"));
      if (loadResult && typeof loadResult.catch === "function") {
        loadResult.catch((err) => {
          failPermissionBubble(
            `Permission bubble failed to load: ${err && err.message ? err.message : String(err)}`
          );
        });
      }
    } catch (err) {
      loadFailedSynchronously = failPermissionBubble(
        `Permission bubble failed to load: ${err && err.message ? err.message : String(err)}`
      );
    }
    if (loadFailedSynchronously) return;

    // macOS: set alwaysOnTop BEFORE showInactive to prevent bubble from sinking.
    // (Text-input bubbles later drop out of always-on-top per-edit — and skip the
    // native SkyLight path — so their IME candidate window can surface; that's
    // handled by handleImeEditing + reapplyMacVisibility, not a lower level here.)
    if (isMac) {
      bub.setAlwaysOnTop(true, MAC_TOPMOST_LEVEL);
    }

    repositionBubbles();
    bub.showInactive();
    repositionDependentBubbles();
    keepOutOfTaskbar(bub);
    // macOS: defer full visibility restoration to avoid activating Clawd
    if (isMac) deferMacFloatingVisibility(ctx, bub);
    else ctx.reapplyMacVisibility();

    ctx.guardAlwaysOnTop(bub);
    syncPermissionShortcuts();

    armPermissionAutoCloseTimer(permEntry);
  } catch (createErr) {
    try { bub.removeAllListeners("closed"); } catch {}
    try { bub.destroy(); } catch {}
    permissionBubbleWindows.delete(bub);
    permEntry.bubble = null;
    throw createErr;
  }
}
// Autoclose: set up the dismiss-without-decision timer for a single pending
// permission. Passive notification entries (codex/kimi) own their own
// dismissal via dismissPassiveNotify and must not be auto-closed through this
// path — their UI lifecycle is decoupled from the agent's response channel.
function armPermissionAutoCloseTimer(permEntry) {
  if (!permEntry || isPassiveNotifyEntry(permEntry)) return;
  if (permEntry.autoCloseTimer) {
    clearTimeout(permEntry.autoCloseTimer);
    permEntry.autoCloseTimer = null;
  }
  if (!pendingPermissions.includes(permEntry)) return;
  if (permEntry.trustConfirming === true || isDecisionInteraction(permEntry.interaction)) return;
  const policy = getPolicy(ctx, "permission");
  if (!policy.enabled || !(policy.autoCloseMs > 0)) return;
  const remaining = computePermissionAutoCloseRemainingMs(
    permEntry,
    policy.autoCloseMs,
    Date.now()
  );
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

function notifyPermissionsChanged(reason) {
  if (expandedPermissionEntry && !pendingPermissions.includes(expandedPermissionEntry)) {
    expandedPermissionEntry = null;
  }
  // #640: every path that adds or removes a pendingPermissions entry funnels
  // through here — including resolvePermissionEntry's inline splice, which is
  // what Allow/Deny clicks, Enter submits, and the auto-close timer all use.
  // A bubble can leave the list while its text field still holds focus (no
  // blur ever fires, and handleImeEditing can't match a spliced entry), so
  // this is the one reliable place to re-run the editing-overlap dodge scan
  // and restore the pet. Cheap + edge-triggered; platform gate lives inside.
  if (typeof ctx.syncImeEditingPetDodge === "function") {
    try {
      ctx.syncImeEditingPetDodge();
    } catch (err) {
      permLog(`syncImeEditingPetDodge failed: ${err && err.message ? err.message : err}`);
    }
  }
  if (typeof ctx.onPermissionsChanged !== "function") return;
  try {
    ctx.onPermissionsChanged(reason);
  } catch (err) {
    permLog(`onPermissionsChanged failed: ${err && err.message ? err.message : err}`);
  }
}

function notifyPermissionResolved(permEntry, reason) {
  if (!permEntry || isPassiveNotifyEntry(permEntry)) return;
  if (typeof ctx.onPermissionResolved !== "function") return;
  const hasPendingForSession = pendingPermissions.some((entry) =>
    entry
    && entry.sessionId === permEntry.sessionId
    && !isPassiveNotifyEntry(entry)
  );
  try {
    ctx.onPermissionResolved(permEntry, {
      reason: reason || "resolved",
      hasPendingForSession,
    });
  } catch (err) {
    permLog(`onPermissionResolved failed: ${err && err.message ? err.message : err}`);
  }
}

// NOTE: deliberately does NOT announce to Slack. Queueing an entry only means
// the route accepted it — permission automation may still auto-allow it on the
// very next statement, which used to produce a "needs your approval" Slack ping
// for a request nobody ever saw. The announce happens later, at the two points
// where a real user decision is known to be pending (the renderer's bubble
// height acknowledgement or a remote client's card-delivery acknowledgement).
function addPendingPermission(permEntry, reason = "added") {
  pendingPermissions.push(permEntry);
  notifyPermissionsChanged(reason);
  return permEntry;
}

function removePendingPermission(permEntry, reason = "removed") {
  const idx = pendingPermissions.indexOf(permEntry);
  if (idx === -1) return false;
  pendingPermissions.splice(idx, 1);
  notifyPermissionsChanged(reason);
  return true;
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
  ensureBubblePresentationState(permEntry);
  const sess = ctx.sessions.get(permEntry.sessionId);
  const sessionFolder = sess && sess.cwd ? path.basename(sess.cwd) : null;
  const sessionShortId = permEntry.sessionId
    ? String(permEntry.sessionId).slice(-3)
    : null;
  return {
    toolName: permEntry.toolName,
    toolInput: permEntry.toolInput,
    detailText: typeof permEntry.detailText === "string"
      ? permEntry.detailText
      : null,
    detailTruncated: permEntry.detailTruncated === true,
    elicitationDetailInput: permEntry.elicitationDetailInput || null,
    presentation: {
      expanded: permEntry.expanded === true,
      measurementEpoch: permEntry.measurementEpoch,
    },
    suggestions: permEntry.suggestions || [],
    canOfferSessionTrust: typeof ctx.canOfferSessionTrust === "function"
      && ctx.canOfferSessionTrust(permEntry) === true,
    sessionTrustError: typeof permEntry.sessionTrustError === "string"
      ? permEntry.sessionTrustError
      : null,
    lang: ctx.lang,
    interaction: isValidInteraction(permEntry.interaction) ? permEntry.interaction : null,
    isElicitation: permEntry.isElicitation || false,
    // opencode-family provenance for the renderer, which has no registry
    // access: presence of familyAgentId selects the family render branch;
    // familyDisplayName templates the blanket-always tooltip (plan §3.5).
    familyAgentId: isOpencodeFamilyEntry(permEntry) ? permEntry.agentId : null,
    familyDisplayName: isOpencodeFamilyEntry(permEntry)
      ? ((getFamilyConfig(permEntry.agentId) || {}).displayName || permEntry.agentId)
      : null,
    isAntigravity: permEntry.isAntigravity || false,
    // Provenance for the renderer: lets the bubble relabel Codex MCP tool calls
    // (issue #445) without touching approval semantics. Mirrors the flags above.
    isCodex: permEntry.isCodex || false,
    isCodexSubagent: permEntry.isCodex === true && permEntry.codexSessionRole === "subagent",
    codexAgentNickname: permEntry.codexAgentNickname || null,
    isCodexUserInputNotify: permEntry.isCodexUserInputNotify || false,
    codexUserInputCallId: permEntry.codexUserInputCallId || null,
    isRemote: !!permEntry.host,
    // Hermes must NOT get the regular go-to-terminal fallback: its opt-in
    // permission gate has no native approval prompt to hand back to. A 204 is
    // converted into a retryable block by the plugin. Clarify elicitation is
    // different and can hand control to Hermes' native clarification UI.
    isHermes: permEntry.isHermes || false,
    // DSH has a downstream native web answerer. Its first-release bubble must
    // not render Go to Terminal because that action has no decision meaning.
    isDsh: permEntry.isDsh || false,
    // Display-only detail for the passive Kimi notify card: the real tool
    // name plus the whitelisted tool_input subset let the renderer reuse the
    // standard cue path (formatDetail) while the card stays dismiss-only.
    kimiToolName: permEntry.kimiToolName || null,
    kimiToolInput: permEntry.kimiToolInput || null,
    familyAlways: permEntry.familyAlwaysCandidates || [],
    familyPatterns: permEntry.familyPatterns || [],
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

function sendPermissionPresentation(permEntry) {
  const bub = permEntry && permEntry.bubble;
  if (!bub || bub.isDestroyed() || !permEntry.bubbleReady) return false;
  ensureBubblePresentationState(permEntry);
  bub.webContents.send("permission-presentation", {
    expanded: permEntry.expanded === true,
    measurementEpoch: permEntry.measurementEpoch,
  });
  return true;
}

function beginSessionTrustConfirmation(permEntry) {
  if (!isPermissionEntryLive(permEntry) || permEntry.trustConfirming === true) return false;
  permEntry.trustConfirming = true;
  permEntry.autoClosePauseStartedAt = Date.now();
  if (permEntry.autoCloseTimer) {
    clearTimeout(permEntry.autoCloseTimer);
    permEntry.autoCloseTimer = null;
  }
  return true;
}

function endSessionTrustConfirmation(permEntry, options = {}) {
  if (!permEntry) return false;
  const now = Date.now();
  if (Number.isFinite(permEntry.autoClosePauseStartedAt)) {
    const elapsed = Math.max(0, now - permEntry.autoClosePauseStartedAt);
    permEntry.autoClosePausedTotalMs = Math.max(
      0,
      Number(permEntry.autoClosePausedTotalMs) || 0
    ) + elapsed;
  }
  permEntry.autoClosePauseStartedAt = null;
  permEntry.trustConfirming = false;
  if (options.rearm === true) armPermissionAutoCloseTimer(permEntry);
  return true;
}

function basenameForDisplay(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  const parts = text.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : text;
}

function compactRemoteApprovalText(value, maxLen = 200) {
  let text = typeof value === "string" ? value : String(value == null ? "" : value);
  text = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  text = redactSecrets(text);
  if (text.length > maxLen) text = `${text.slice(0, Math.max(0, maxLen - 1))}…`;
  return text;
}

function remoteApprovalDecisionLabel(decision) {
  if (decision === "allow") return "批准一次";
  if (decision === "deny") return "拒绝";
  if (decision === "terminal") return "前往终端";
  if (decision === "no-decision") return "未返回审批结果";
  if (decision === "elicitation-submit") return "提交输入";
  return "";
}

function isRemoteRichApprovalSupported(permEntry) {
  const agentId = compactRemoteApprovalText(permEntry && permEntry.agentId ? permEntry.agentId : "claude-code", 80);
  return REMOTE_RICH_APPROVAL_AGENT_IDS.has(agentId);
}

function isRemoteApprovalActionable(permEntry) {
  if (!permEntry || typeof permEntry !== "object") return false;
  const interaction = permEntry.interaction;
  if (
    isValidInteraction(interaction)
    && interaction.intent === INTERACTION_INTENT.HUMAN_QUESTION
    && interaction.capabilities.answerQuestions
  ) return true;
  if (isPassiveNotifyEntry(permEntry) || isOpencodeFamilyEntry(permEntry) || permEntry.isAntigravity || permEntry.isCopilotCli) return false;
  if (isDecisionInteraction(interaction)) return false;
  if (PASSTHROUGH_TOOLS.has(permEntry.toolName)) return false;
  // Mirror the local headless gate on remote channels. An audited interactive
  // Codex Agent thread is the one exception: its state session is headless for
  // HUD/focus policy, but the approval itself remains human-actionable.
  if (isPermissionEntryHeadless(permEntry)) return false;
  return true;
}

// Slack is a one-way attention channel, not an approval transport. Do not
// reuse isRemoteApprovalActionable here: that predicate intentionally excludes
// adapters such as the opencode family and Copilot because Telegram/Feishu
// cannot safely return a decision for them. A successfully rendered desktop
// bubble is still something Slack should announce.
//
// Route-owned interaction capabilities remain the authority. In particular,
// an opencode-family AskUserQuestion cannot be answered in Clawd
// (answerQuestions=false), so announcing "answer in the desktop app" would be
// just as misleading as excluding its ordinary Allow/Deny bubbles.
function isSlackPermissionAnnounceable(permEntry) {
  if (!permEntry || typeof permEntry !== "object") return false;
  if (!isValidInteraction(permEntry.interaction)) return false;
  if (isPassiveNotifyEntry(permEntry)) return false;
  if (PASSTHROUGH_TOOLS.has(permEntry.toolName)) return false;
  if (isPermissionEntryHeadless(permEntry)) return false;

  const { intent, capabilities } = permEntry.interaction;
  if (intent === INTERACTION_INTENT.HUMAN_QUESTION) {
    return capabilities.answerQuestions === true;
  }
  // ExitPlanMode has its own plan-review/feedback contract and is deliberately
  // not a Slack permission notification in this phase.
  if (isDecisionInteraction(permEntry.interaction)) return false;
  return capabilities.allowDeny === true;
}

function buildRemoteElicitationPayload(permEntry) {
  if (
    !permEntry
    || !isValidInteraction(permEntry.interaction)
    || permEntry.interaction.intent !== INTERACTION_INTENT.HUMAN_QUESTION
    || !permEntry.interaction.capabilities.answerQuestions
  ) return null;
  const input = permEntry.toolInput && typeof permEntry.toolInput === "object" ? permEntry.toolInput : {};
  const questions = Array.isArray(input.questions) ? input.questions : [];
  if (!questions.length) return null;
  const agentId = compactRemoteApprovalText(permEntry.agentId || "claude-code", 80) || "claude-code";
  const session = ctx.sessions.get(permEntry.sessionId);
  const sessionFolder = compactRemoteApprovalText(
    basenameForDisplay((session && session.cwd) || permEntry.cwd || ""),
    80
  );
  return {
    title: `${agentId} needs input`,
    detail: compactRemoteApprovalText(input.description || input.summary || "", 200),
    agentId,
    folder: sessionFolder,
    questions,
  };
}

// Tool-specific fields that hint at what the action targets, tried in order
// when the tool gave no description/summary/reason (e.g. Write, Edit, Read —
// unlike Bash, which always carries `description`). Only cheap, low-risk
// identifiers (a path, a Glob file-selection pattern) — never full file
// contents/diffs/commands/search queries.
// Field names reuse bubble-format.js's firstStringValue so this list doesn't
// drift out of sync with the naming variants (TargetFile/AbsolutePath/...)
// other agents use.
const FALLBACK_PATH_FIELDS = ["file_path", "path", "TargetFile", "AbsolutePath", "filePath", "FilePath", "DirectoryPath"];
const FALLBACK_PATTERN_FIELDS = ["pattern", "Pattern"];
const FALLBACK_URL_FIELDS = ["url", "Url"];

// `command`/`query` are deliberately excluded: they can carry secrets a
// generic sanitizer can't reliably catch (inline env vars, API query
// params), so they never leave the desktop bubble.
function stripUrlQueryAndCredentials(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function buildRemoteApprovalFallbackDetail(input, toolName) {
  const pathValue = firstStringValue(input, FALLBACK_PATH_FIELDS);
  if (pathValue) {
    const text = compactRemoteApprovalText(basenameForDisplay(pathValue), 200);
    if (text) return text;
  }
  // `pattern` is overloaded: Glob uses it to identify files, while Grep uses
  // it for the user's raw search expression. The latter can contain customer
  // names, email addresses, or secret identifiers and is no safer to send to
  // a remote channel than the deliberately excluded `query` field.
  if (toolName === "Glob") {
    const patternValue = firstStringValue(input, FALLBACK_PATTERN_FIELDS);
    if (patternValue) {
      const text = compactRemoteApprovalText(patternValue, 200);
      if (text) return text;
    }
  }
  const urlValue = firstStringValue(input, FALLBACK_URL_FIELDS);
  if (urlValue) {
    const originAndPath = stripUrlQueryAndCredentials(urlValue);
    if (originAndPath) {
      const text = compactRemoteApprovalText(originAndPath, 200);
      if (text) return text;
    }
  }
  return null;
}

// String.prototype.replace's replacement-string argument treats $$/$&/$`/$'
// as special sequences. Dynamic values (tool input, agent/tool names, etc.)
// must never be interpolated with the string form — a Glob pattern
// containing "$$", for example, would corrupt the rendered card. The
// function form of the replacement argument is never parsed for $-sequences.
function interpolate(template, token, value) {
  return template.replace(token, () => value);
}

// Returns a redacted summary string — never null. We used to refuse to send a
// Telegram card at all when the tool gave no description/summary/reason (e.g.
// Write/Edit, unlike Bash which always carries `description`), reasoning that
// a blank "Tool input hidden by Clawd" card would let the user approve a black
// box. In practice that meant those requests never reached Telegram at all —
// worse than a labelled blank card, since the user had no idea anything was
// pending. Now we fall back to a cheap identifier (file path / Glob pattern /
// URL)
// and, failing that, an explicit "no description, go check the desktop bubble"
// notice — so every remote-approval-eligible request produces a card.
function buildRemoteApprovalSummary(permEntry) {
  const input = permEntry && permEntry.toolInput && typeof permEntry.toolInput === "object"
    ? permEntry.toolInput
    : {};
  const candidates = [
    input.description,
    input.summary,
    input.reason,
  ];
  for (const candidate of candidates) {
    const text = compactRemoteApprovalText(candidate, 200);
    if (text) return text;
  }
  const fallbackDetail = buildRemoteApprovalFallbackDetail(input, permEntry && permEntry.toolName);
  if (fallbackDetail) return interpolate(t("approvalSummaryFallbackDetail"), "{detail}", fallbackDetail);
  return t("approvalSummaryUnavailable");
}

function buildRemoteSuggestionLabel(suggestion) {
  if (!suggestion || typeof suggestion !== "object") return "";
  if (suggestion.type === "setMode") {
    if (suggestion.mode === "acceptEdits") return t("approvalSuggestionAutoEdits");
    if (suggestion.mode === "plan") return t("approvalSuggestionPlanMode");
    const mode = compactRemoteApprovalText(suggestion.mode || "", 18);
    return mode ? interpolate(t("approvalSuggestionModePrefix"), "{mode}", mode) : "";
  }
  if (suggestion.type === "addRules") {
    const rules = Array.isArray(suggestion.rules) ? suggestion.rules : [suggestion];
    const first = rules.find((rule) => rule && typeof rule === "object") || {};
    const behavior = compactRemoteApprovalText(suggestion.behavior || first.behavior || "allow", 12);
    const isDeny = behavior === "deny";
    const toolName = compactRemoteApprovalText(first.toolName || suggestion.toolName || "", 16);
    if (toolName) {
      return isDeny
        ? interpolate(t("approvalSuggestionAlwaysDenyTool"), "{tool}", toolName)
        : interpolate(t("approvalSuggestionAlwaysAllowTool"), "{tool}", toolName);
    }
    return isDeny ? t("approvalSuggestionAlwaysDeny") : t("approvalSuggestionAlwaysAllow");
  }
  return "";
}

function buildRemoteSuggestionButtons(permEntry) {
  if (!isRemoteRichApprovalSupported(permEntry)) return [];
  const suggestions = Array.isArray(permEntry.suggestions) ? permEntry.suggestions : [];
  const seen = new Set();
  const buttons = [];
  suggestions.forEach((suggestion, index) => {
    const label = compactRemoteApprovalText(buildRemoteSuggestionLabel(suggestion), 28);
    if (!label || seen.has(label)) return;
    seen.add(label);
    buttons.push({ index, label });
  });
  return buttons;
}

// Returns the Telegram approval payload. buildRemoteApprovalSummary always
// returns a non-empty string (a real summary, a cheap fallback identifier, or
// an explicit "no description" notice), so there is always a safe summary to
// ship — this never returns null.
function buildRemoteApprovalPayload(permEntry) {
  const summary = buildRemoteApprovalSummary(permEntry);
  const agentId = compactRemoteApprovalText(permEntry.agentId || "claude-code", 80) || "claude-code";
  const toolName = compactRemoteApprovalText(permEntry.toolName || t("approvalUnknownTool"), 80) || t("approvalUnknownTool");
  const session = ctx.sessions.get(permEntry.sessionId);
  const sessionFolder = compactRemoteApprovalText(
    basenameForDisplay((session && session.cwd) || permEntry.cwd || ""),
    80
  );
  // Label this value "Folder" (not "Session"): it is only the cwd basename,
  // never a session id or full local path.
  const detail = [
    `${t("approvalDetailAgent")}: ${agentId}`,
    `${t("approvalDetailTool")}: ${toolName}`,
    sessionFolder ? `${t("approvalDetailFolder")}: ${sessionFolder}` : null,
    `${t("approvalDetailSummary")}: ${summary}`,
  ].filter(Boolean).join("\n");
  const fields = [
    { label: t("approvalDetailAgent"), value: agentId },
    { label: t("approvalDetailTool"), value: toolName },
    sessionFolder ? { label: t("approvalDetailFolder"), value: sessionFolder } : null,
    { label: t("approvalDetailSummary"), value: summary },
  ].filter(Boolean);
  const suggestionButtons = buildRemoteSuggestionButtons(permEntry);
  const payload = {
    title: interpolate(interpolate(t("approvalRequestsTitle"), "{agent}", agentId), "{tool}", toolName),
    detail,
    fields,
  };
  if (suggestionButtons.length > 0) payload.suggestions = suggestionButtons;
  return payload;
}

// One-way Slack heads-up when a permission request is actually waiting on the
// user. Fires once per entry (guarded) and independently of whether an
// interactive remote channel (Telegram/Feishu) is connected — Slack cannot
// resolve the approval itself in this build, so it only announces where the
// user can act (the desktop app, or an active remote-only channel).
// Best-effort: never throws into the caller's sync path.
//
// Callers invoke this only after automation has had its chance: desktop entries
// arrive from the renderer's post-reveal height acknowledgement, while
// remote-only entries arrive from a remote client's explicit delivery
// acknowledgement. The gates below are a belt-and-braces re-check of the
// conditions that make a request human-visible, so a future call site cannot
// reintroduce a ping for a request silently dropped by DND or already resolved.

function announceSlackPermission(permEntry) {
  if (typeof ctx.notifySlackPermission !== "function") return;
  if (!permEntry || permEntry._slackPermissionAnnounced) return;
  if (!isSlackPermissionAnnounceable(permEntry)) return;
  // DND drops permission requests before they ever surface locally; a Slack
  // ping would be the one thing that still reached the user.
  if (ctx.doNotDisturb) return;
  // Auto-approved / already-answered entries are out of the pending list.
  if (pendingPermissions.indexOf(permEntry) === -1) return;
  permEntry._slackPermissionAnnounced = true;
  try {
    const agentId = compactRemoteApprovalText(permEntry.agentId || "claude-code", 80) || "claude-code";
    const toolName = compactRemoteApprovalText(permEntry.toolName || t("approvalUnknownTool"), 80) || t("approvalUnknownTool");
    const session = ctx.sessions.get(permEntry.sessionId);
    const folder = compactRemoteApprovalText(
      basenameForDisplay((session && session.cwd) || permEntry.cwd || ""),
      80
    );
    // An answerable elicitation is a question, not a decision: its
    // capabilities.allowDeny is false, and buildRemoteApprovalSummary can never
    // find a description for one, so it would always have reported "No
    // description available". Reuse the elicitation payload the interactive
    // channels already build, so Slack shows what was actually asked.
    const elicitation = buildRemoteElicitationPayload(permEntry);
    const actionTarget = permEntry.remoteOnly === true ? "remote" : "desktop";
    if (elicitation) {
      ctx.notifySlackPermission({
        kind: "question",
        actionTarget,
        title: elicitation.title,
        detail: elicitation.detail,
        agentId: elicitation.agentId,
        folder: elicitation.folder,
        questions: elicitation.questions,
      }, {
        isStillRelevant: () => pendingPermissions.includes(permEntry),
      });
      return;
    }
    ctx.notifySlackPermission({
      kind: "approval",
      actionTarget,
      title: interpolate(interpolate(t("approvalRequestsTitle"), "{agent}", agentId), "{tool}", toolName),
      toolName,
      agentId,
      folder,
      summary: buildRemoteApprovalSummary(permEntry),
    }, {
      isStillRelevant: () => pendingPermissions.includes(permEntry),
    });
  } catch (err) {
    permLog(`slack permission announce failed: ${err && err.message ? err.message : err}`);
  }
}

function normalizeRemoteApprovalDecision(decision) {
  if (decision === "allow" || decision === "deny") return { action: decision };
  if (!decision || typeof decision !== "object") return null;
  const action = decision.action === "allow" || decision.decision === "allow" ? "allow"
    : (decision.action === "deny" || decision.decision === "deny" ? "deny"
      : (decision.action === "suggestion" ? "suggestion" : null));
  if (!action) return null;
  if (action !== "suggestion") return { action };
  const index = Number(decision.index);
  return Number.isInteger(index) && index >= 0 ? { action, index } : null;
}

function getTelegramApprovalClient() {
  if (typeof ctx.getTelegramApprovalClient === "function") {
    try { return ctx.getTelegramApprovalClient(); } catch (err) {
      permLog(`telegram remote approval client lookup failed: ${compactRemoteApprovalText(err && err.message ? err.message : err, 200)}`);
      return null;
    }
  }
  return ctx.telegramApprovalClient || null;
}

function getRemoteApprovalClients() {
  const clients = [];
  const telegramClient = getTelegramApprovalClient();
  if (telegramClient) clients.push({ name: "telegram", client: telegramClient });
  if (typeof ctx.getRemoteApprovalClients === "function") {
    let extra = [];
    try {
      extra = ctx.getRemoteApprovalClients() || [];
    } catch (err) {
      permLog(`remote approval client lookup failed: ${compactRemoteApprovalText(err && err.message ? err.message : err, 200)}`);
    }
    for (const entry of Array.isArray(extra) ? extra : []) {
      if (!entry) continue;
      const name = typeof entry.name === "string" && entry.name ? entry.name : "remote";
      const client = entry.client || entry;
      if (client && client !== telegramClient) clients.push({ name, client });
    }
  }
  return clients.filter(({ client }) => {
    if (!client || typeof client.requestApproval !== "function") return false;
    return !(typeof client.isEnabled === "function" && !client.isEnabled());
  });
}

function notifyRemoteApprovalResolved(permEntry, outcome = {}, options = {}) {
  const requests = Array.isArray(permEntry && permEntry.remoteApprovalRequests)
    ? [...permEntry.remoteApprovalRequests]
    : [];
  let notified = 0;
  for (const request of requests) {
    if (!request || request.name === options.skipClientName) continue;
    const client = request.client;
    if (!client || typeof client.resolveApprovalExternally !== "function") continue;
    try {
      if (client.resolveApprovalExternally(request.signal, outcome)) notified += 1;
    } catch (err) {
      permLog(`${request.name || "remote"} remote approval update failed: ${compactRemoteApprovalText(err && err.message ? err.message : err, 200)}`);
    }
  }
  return notified;
}

function cancelRemoteApproval(permEntry, options = {}) {
  if (permEntry && permEntry.sessionTrustCandidate && typeof ctx.cancelSessionTrustCandidate === "function") {
    try {
      ctx.cancelSessionTrustCandidate(permEntry, {
        reason: options.reason || "permission-resolved",
      });
    } catch {}
  }
  if (options.outcome) {
    notifyRemoteApprovalResolved(permEntry, options.outcome, {
      skipClientName: options.skipClientName,
    });
  }
  const controllers = [];
  if (permEntry && Array.isArray(permEntry.remoteApprovalAbortControllers)) {
    controllers.push(...permEntry.remoteApprovalAbortControllers);
    permEntry.remoteApprovalAbortControllers = [];
  }
  const controller = permEntry && permEntry.remoteApprovalAbortController;
  if (controller) {
    controllers.push(controller);
    permEntry.remoteApprovalAbortController = null;
  }
  for (const item of controllers) {
    try { item.abort(); } catch {}
  }
  if (permEntry) permEntry.remoteApprovalRequests = [];
}

// "Go to terminal" path: drop the bubble, abort any in-flight Telegram prompt,
// destroy the hook socket WITHOUT writing a decision, hand focus back to the
// agent terminal. The destroy is what actually frees the terminal: CC and
// CodeBuddy block on the PermissionRequest HTTP hook (600s) and show nothing
// in the terminal until it finishes — a dropped connection is a non-blocking
// hook error, so they immediately fall back to their native chat prompt
// without treating it as a deny (same mechanism as the autoclose no-decision
// path and the bypass gate in server-route-permission.js). For opencode the
// destroy is a no-op behind the writableEnded guard: its fire-and-forget POST
// was 200-ACKed on arrival and the native TUI prompt owns the request.
// All permission cleanup paths share the same defensive renderer teardown.
// A renderer crash may leave the BrowserWindow alive while webContents is
// already gone, so never assume either object can still receive IPC.
function hidePermissionBubbleSafely(permEntry) {
  const bub = permEntry && permEntry.bubble;
  if (!bub) return false;

  let bubbleDestroyed = false;
  try {
    bubbleDestroyed = typeof bub.isDestroyed === "function" && bub.isDestroyed();
  } catch (err) {
    permLog(`permission bubble state check failed: ${err && err.message ? err.message : String(err)}`);
    bubbleDestroyed = true;
  }
  if (bubbleDestroyed) return false;

  try {
    const bubbleContents = bub.webContents;
    if (
      bubbleContents
      && typeof bubbleContents.send === "function"
      && (
        typeof bubbleContents.isDestroyed !== "function"
        || !bubbleContents.isDestroyed()
      )
    ) {
      bubbleContents.send("permission-hide");
    }
  } catch (err) {
    permLog(`permission bubble hide failed: ${err && err.message ? err.message : String(err)}`);
  }

  if (permEntry.hideTimer) clearTimeout(permEntry.hideTimer);
  permEntry.hideTimer = setTimeout(() => {
    try {
      if (
        bub
        && (
          typeof bub.isDestroyed !== "function"
          || !bub.isDestroyed()
        )
        && typeof bub.destroy === "function"
      ) {
        bub.destroy();
      }
    } catch (err) {
      permLog(`permission bubble destroy failed: ${err && err.message ? err.message : String(err)}`);
    }
  }, 250);
  return true;
}

// A remote-only entry (bubbles disabled, decided over Feishu/Telegram) has no
// desktop bubble to drop — route it through the shared no-decision path.
function dismissPermissionForTerminal(perm) {
  if (!perm) return;
  if (perm.remoteOnly) {
    resolvePermissionEntry(perm, "no-decision", "Go to terminal from remote approval");
    ctx.focusTerminalForSession(perm.sessionId, { fallbackEntry: buildPermissionFocusEntry(perm) });
    return;
  }
  // Cancel before splicing so a late Telegram decision can't slip in between
  // the splice and the abort.
  const remoteOutcome = perm.remoteApprovalResolution || {
    decision: "terminal",
    actionLabel: "前往终端",
    source: "desktop",
  };
  cancelRemoteApproval(perm, {
    outcome: remoteOutcome,
    skipClientName: perm.remoteApprovalSkipClientName,
  });
  const idx = pendingPermissions.indexOf(perm);
  if (idx !== -1) {
    pendingPermissions.splice(idx, 1);
    notifyPermissionsChanged("deny-and-focus");
    notifyPermissionResolved(perm, "deny-and-focus");
  }
  const { res, abortHandler } = perm;
  if (res && abortHandler) {
    try { res.removeListener("close", abortHandler); } catch {}
  }
  if (res && !res.writableEnded && !res.destroyed) {
    try { res.destroy(); } catch {}
  }
  hidePermissionBubbleSafely(perm);
  repositionBubbles();
  repositionDependentBubbles();
  syncPermissionShortcuts();
  ctx.focusTerminalForSession(perm.sessionId, { fallbackEntry: buildPermissionFocusEntry(perm) });
}

function maybeStartRemoteApproval(permEntry) {
  if (!isRemoteApprovalActionable(permEntry)) return false;
  if (pendingPermissions.indexOf(permEntry) === -1) return false;
  const clients = getRemoteApprovalClients();
  if (!clients.length) return false;

  const payload = isValidInteraction(permEntry.interaction)
    && permEntry.interaction.intent === INTERACTION_INTENT.HUMAN_QUESTION
    ? buildRemoteElicitationPayload(permEntry)
    : buildRemoteApprovalPayload(permEntry);
  if (!payload) return false;

  const controllers = [];
  const remoteRequests = [];
  let started = false;
  // Remote-only entries (bubble === null, from tryRemoteOnlyApproval when the
  // desktop bubble is disabled) have no other UI waiting on the decision — if
  // every remote client settles without ever producing one (send failure,
  // invalid payload, client disconnect), the entry would otherwise sit in
  // pendingPermissions holding the HTTP connection open until the hook's own
  // timeout. Track settlements and fall back once none are left. The fallback
  // is "no-decision" (drop the socket → the agent re-prompts in its own UI),
  // NOT an explicit deny: nobody actually said no — answering deny here would
  // decide on the user's behalf over a transient Telegram/Feishu failure.
  let settledWithoutDecision = 0;

  function onRemoteCardDelivered() {
    // Starting requestApproval/requestElicitation only means the client began
    // an async send. Slack may announce a remote-only request only after the
    // client confirms that its actionable card obtained a message id. Re-check
    // relevance here because the request may have resolved or DND may have
    // been enabled while the send was in flight.
    if (permEntry.remoteOnly !== true) return;
    if (ctx.doNotDisturb) return;
    if (!pendingPermissions.includes(permEntry)) return;
    announceSlackPermission(permEntry);
  }

  function maybeFallBackRemoteOnlyEntry() {
    if (!permEntry.remoteOnly) return;
    if (settledWithoutDecision < remoteRequests.length) return;
    if (pendingPermissions.indexOf(permEntry) === -1) return;
    permLog(`remote-only approval: all remote requests settled without a decision, falling back (tool=${permEntry.toolName} session=${permEntry.sessionId})`);
    resolvePermissionEntry(permEntry, "no-decision", "Remote approval unavailable; no client returned a decision");
  }

  for (const { name, client } of clients) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    if (controller) controllers.push(controller);
    let request;
    try {
      if (
        isValidInteraction(permEntry.interaction)
        && permEntry.interaction.intent === INTERACTION_INTENT.HUMAN_QUESTION
        && permEntry.interaction.capabilities.answerQuestions
      ) {
        if (typeof client.requestElicitation !== "function") continue;
        request = client.requestElicitation(payload, {
          ...(controller ? { signal: controller.signal } : {}),
          onDelivered: onRemoteCardDelivered,
        });
      } else {
        const clientPayload = {
          ...payload,
          canOfferSessionTrust: typeof ctx.canOfferRemoteSessionTrust === "function"
            && ctx.canOfferRemoteSessionTrust(permEntry, { name, client }) === true,
        };
        request = client.requestApproval(clientPayload, {
          ...(controller ? { signal: controller.signal } : {}),
          onDelivered: onRemoteCardDelivered,
        });
      }
      remoteRequests.push({
        name,
        client,
        controller,
        signal: controller ? controller.signal : null,
      });
      permEntry.remoteApprovalRequests = remoteRequests;
      started = true;
    } catch (err) {
      permLog(`${name} remote approval failed: ${compactRemoteApprovalText(err && err.message ? err.message : err, 200)}`);
      continue;
    }
    Promise.resolve(request)
      .then((decision) => {
        if (!isRemoteApprovalDecision(decision)) {
          if (decision) permLog(`${name} remote approval ignored decision=${compactRemoteApprovalText(decision, 40)}`);
          settledWithoutDecision += 1;
          maybeFallBackRemoteOnlyEntry();
          return;
        }
        // A decision can pass the shape check above yet still be unusable
        // (e.g. "suggestion:9" for an entry with no such suggestion). That is
        // just as settled-without-a-decision as an invalid payload.
        if (handleRemoteApprovalDecision(
          permEntry,
          decision,
          name,
          client,
          () => {
            settledWithoutDecision += 1;
            maybeFallBackRemoteOnlyEntry();
          }
        ) === false) {
          settledWithoutDecision += 1;
          maybeFallBackRemoteOnlyEntry();
        }
      })
      .catch((err) => {
        permLog(`${name} remote approval failed: ${compactRemoteApprovalText(err && err.message ? err.message : err, 200)}`);
        settledWithoutDecision += 1;
        maybeFallBackRemoteOnlyEntry();
      })
      .finally(() => {
        if (!controller || !Array.isArray(permEntry.remoteApprovalAbortControllers)) return;
        const idx = permEntry.remoteApprovalAbortControllers.indexOf(controller);
        if (idx !== -1) permEntry.remoteApprovalAbortControllers.splice(idx, 1);
      });
  }
  if (!started) return false;
  permEntry.remoteApprovalRequests = remoteRequests;
  if (controllers.length) {
    permEntry.remoteApprovalAbortControllers = controllers;
    permEntry.remoteApprovalAbortController = controllers[0];
  }
  return started;
}

function isRemoteApprovalDecision(decision) {
  return decision === "allow"
    || decision === "deny"
    || decision === "terminal"
    || (decision && typeof decision === "object" && decision.type === "elicitation-submit")
    || (decision && typeof decision === "object" && decision.action === "session-trust")
    || (typeof decision === "string" && /^suggestion:\d+$/.test(decision))
    || !!normalizeRemoteApprovalDecision(decision);
}

function remoteDecisionSource(name) {
  if (name === "telegram") return "remote";
  if (name === "feishu") return "feishu";
  return "remote";
}

function applyRemotePermissionSuggestion(permEntry, decision) {
  if (!isRemoteRichApprovalSupported(permEntry)) return "";
  const index = parseInt(String(decision).split(":")[1], 10);
  if (!Number.isInteger(index) || index < 0) return "";
  const suggestion = permEntry && Array.isArray(permEntry.suggestions)
    ? permEntry.suggestions[index]
    : null;
  if (!suggestion) return "";
  if (!applyPermissionSuggestion(permEntry, index, { requireResolved: true })) return "";
  return buildRemoteSuggestionLabel(suggestion);
}

function setRemoteResolutionOutcome(permEntry, outcome, sourceName) {
  permEntry.remoteApprovalResolution = outcome;
  permEntry.remoteApprovalSkipClientName = sourceName || "";
}

// Returns false only when the decision passed isRemoteApprovalDecision but
// could not actually be applied (an invalid suggestion index) and the entry is
// still pending — the caller counts that as "settled without a decision" so a
// remote-only entry can still fall back instead of hanging until the hook's
// timeout. Every consumed/already-resolved path returns true.
function handleRemoteApprovalDecision(
  permEntry,
  decision,
  sourceName,
  sourceClient,
  onSessionTrustSettledWithoutDecision
) {
  const isSessionTrustDecision = !!(
    decision
    && typeof decision === "object"
    && decision.action === "session-trust"
  );
  const discardUnusedSessionTrustHandle = (reason) => {
    if (
      !isSessionTrustDecision
      || !sourceClient
      || typeof sourceClient.discardSessionTrustCardHandle !== "function"
    ) {
      return false;
    }
    try {
      return sourceClient.discardSessionTrustCardHandle(decision.cardHandle, { reason }) === true;
    } catch {
      return false;
    }
  };
  if (pendingPermissions.indexOf(permEntry) === -1) {
    discardUnusedSessionTrustHandle("permission-resolved");
    return true;
  }
  const source = remoteDecisionSource(sourceName);
  if (
    isSessionTrustDecision
    && typeof ctx.requestRemoteSessionTrust === "function"
  ) {
    let reportedUnresolved = false;
    const reportUnresolved = () => {
      if (reportedUnresolved || pendingPermissions.indexOf(permEntry) === -1) return;
      reportedUnresolved = true;
      if (typeof onSessionTrustSettledWithoutDecision === "function") {
        onSessionTrustSettledWithoutDecision();
      }
    };
    Promise.resolve(ctx.requestRemoteSessionTrust(permEntry, {
      clientName: sourceName,
      client: sourceClient,
      cardHandle: decision.cardHandle,
    })).then((result) => {
      const status = result && result.status;
      if (status !== "applied" && status !== "equivalent") {
        discardUnusedSessionTrustHandle("session-trust-unavailable");
        reportUnresolved();
      }
    }).catch((err) => {
      permLog(`${sourceName || "remote"} session trust failed: ${compactRemoteApprovalText(err && err.message ? err.message : err, 200)}`);
      discardUnusedSessionTrustHandle("session-trust-failed");
      reportUnresolved();
    });
    return true;
  }
  if (isSessionTrustDecision) discardUnusedSessionTrustHandle("session-trust-unavailable");
  const normalizedLegacy = normalizeRemoteApprovalDecision(decision);
  if (normalizedLegacy) {
    if (normalizedLegacy.action === "suggestion") {
      decision = `suggestion:${normalizedLegacy.index}`;
    } else {
      decision = normalizedLegacy.action;
    }
  }
  if (decision === "terminal") {
    setRemoteResolutionOutcome(permEntry, {
      decision: "terminal",
      actionLabel: "前往终端",
      source,
    }, sourceName);
    if (
      isValidInteraction(permEntry.interaction)
      && permEntry.interaction.intent === INTERACTION_INTENT.HUMAN_QUESTION
    ) {
      if (permEntry.isHermes || permEntry.isDsh) {
        // Hermes treats an explicit deny as "clarification cancelled"; only a
        // no-decision (204) falls back to its native terminal prompt, which is
        // what "go to terminal" means here.
        resolvePermissionEntry(permEntry, "no-decision", "Go to terminal from remote approval");
        ctx.focusTerminalForSession(permEntry.sessionId, { fallbackEntry: buildPermissionFocusEntry(permEntry) });
        return true;
      }
      resolvePermissionEntry(permEntry, "deny", "User answered in terminal");
      return true;
    }
    if (permEntry.isCodex || permEntry.isQwenCode || permEntry.isAntigravity || permEntry.isZcode || permEntry.isDsh) {
      resolvePermissionEntry(permEntry, "no-decision", "Go to terminal from remote approval");
      ctx.focusTerminalForSession(permEntry.sessionId, { fallbackEntry: buildPermissionFocusEntry(permEntry) });
    } else {
      dismissPermissionForTerminal(permEntry);
    }
    return true;
  }

  if (
    isValidInteraction(permEntry.interaction)
    && permEntry.interaction.intent === INTERACTION_INTENT.HUMAN_QUESTION
    && permEntry.interaction.capabilities.answerQuestions
    && decision
    && typeof decision === "object"
    && decision.type === "elicitation-submit"
  ) {
    const wireInput = permEntry.elicitationWireInput || permEntry.toolInput;
    const validatedAnswers = validateAndRemapIndexedElicitationAnswers(
      wireInput,
      decision.answers
    );
    if (!validatedAnswers.ok) {
      permLog(`${sourceName || "remote"} remote approval ignored incomplete elicitation: ${validatedAnswers.reason}`);
      return false;
    }
    permEntry.resolvedUpdatedInput = buildElicitationUpdatedInput(
      wireInput,
      validatedAnswers.answers
    );
    setRemoteResolutionOutcome(permEntry, {
      decision: "elicitation-submit",
      actionLabel: "提交输入",
      source,
    }, sourceName);
    resolvePermissionEntry(permEntry, "allow");
    return true;
  }

  if (typeof decision === "string" && decision.startsWith("suggestion:")) {
    const label = applyRemotePermissionSuggestion(permEntry, decision);
    if (!label) {
      permLog(`${sourceName || "remote"} remote approval ignored invalid suggestion decision=${compactRemoteApprovalText(decision, 40)}`);
      return false;
    }
    setRemoteResolutionOutcome(permEntry, {
      decision,
      actionLabel: label,
      source,
    }, sourceName);
    resolvePermissionEntry(permEntry, "allow");
    return true;
  }

  setRemoteResolutionOutcome(permEntry, {
    decision,
    actionLabel: remoteApprovalDecisionLabel(decision),
    source,
  }, sourceName);
  resolvePermissionEntry(permEntry, decision);
  return true;
}

function applyPermissionSuggestion(perm, index, options = {}) {
  const suggestion = perm && Array.isArray(perm.suggestions) ? perm.suggestions[index] : null;
  if (!suggestion) return false;
  permLog(`suggestion raw: ${JSON.stringify(suggestion)}`);
  let resolved = false;
  if (suggestion.type === "addRules") {
    const rules = Array.isArray(suggestion.rules) ? suggestion.rules
      : [{ toolName: suggestion.toolName, ruleContent: suggestion.ruleContent }];
    perm.resolvedSuggestion = {
      type: "addRules",
      destination: suggestion.destination || "localSettings",
      behavior: suggestion.behavior || "allow",
      rules,
    };
    resolved = true;
  } else if (suggestion.type === "setMode") {
    perm.resolvedSuggestion = {
      type: "setMode",
      mode: suggestion.mode,
      destination: suggestion.destination || "localSettings",
    };
    resolved = true;
  }
  return resolved || !options.requireResolved;
}

  function resolvePermissionEntry(permEntry, behavior, message) {
    // Codex notify bubbles have no HTTP connection — route to dedicated cleanup
    if (isPassiveNotifyEntry(permEntry)) {
      dismissPassiveNotify(permEntry, `resolve:${behavior || "unknown"}`);
      return;
    }
  const idx = pendingPermissions.indexOf(permEntry);
  if (idx === -1) return;
  const remoteOutcome = permEntry.remoteApprovalResolution || {
    decision: behavior === "deny" ? "deny" : behavior === "no-decision" ? "no-decision" : "allow",
    actionLabel: remoteApprovalDecisionLabel(behavior === "deny" || behavior === "no-decision" ? behavior : "allow"),
    source: "desktop",
  };
  cancelRemoteApproval(permEntry, {
    outcome: remoteOutcome,
    skipClientName: permEntry.remoteApprovalSkipClientName,
  });

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
  notifyPermissionsChanged("resolved");
  notifyPermissionResolved(permEntry, "resolved");

  if (permEntry.autoCloseTimer) {
    clearTimeout(permEntry.autoCloseTimer);
    permEntry.autoCloseTimer = null;
  }

  const { res, abortHandler } = permEntry;
  if (res && abortHandler) res.removeListener("close", abortHandler);

  // Hide this bubble (fade out + destroy)
  hidePermissionBubbleSafely(permEntry);

  // Reposition remaining bubbles to fill the gap
  repositionBubbles();
  repositionDependentBubbles();
  syncPermissionShortcuts();

  // opencode-family: decisions go back via the plugin's reverse bridge
  // (Bun.serve or node:http on a random localhost port). The plugin then calls
  // the host's in-process Hono route. Plugin sent us a fire-and-forget POST — no HTTP
  // response to complete on this connection.
  if (isOpencodeFamilyEntry(permEntry)) {
    // Autoclose: silent drop — same DND semantics. The host falls back to its
    // built-in terminal or Desktop prompt so the user can answer natively.
    if (behavior === "no-decision") return;
    let reply;
    if (behavior === "deny") reply = "reject";
    else if (permEntry.familyAlwaysPicked) reply = "always";
    else reply = "once";
    replyOpencodeFamilyPermission({
      agentId: permEntry.agentId,
      bridgeUrl: permEntry.familyBridgeUrl,
      bridgeToken: permEntry.familyBridgeToken,
      requestId: permEntry.familyRequestId,
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

  if (permEntry.isQwenCode) {
    if (behavior === "no-decision") {
      sendQwenCodeNoDecisionResponse(res, message || "fallback");
    } else {
      sendQwenCodePermissionResponse(res, {
        behavior: behavior === "deny" ? "deny" : "allow",
        message,
      });
    }
    return;
  }

  if (permEntry.isZcode) {
    if (behavior === "no-decision") {
      sendZcodeNoDecisionResponse(res, message || "fallback");
    } else {
      sendZcodePermissionResponse(res, {
        behavior: behavior === "deny" ? "deny" : "allow",
        message,
      });
    }
    return;
  }

  if (permEntry.isCopilotCli) {
    if (behavior === "no-decision") {
      sendCopilotNoDecisionResponse(res, message || "fallback");
    } else {
      sendCopilotPermissionResponse(res, {
        behavior: behavior === "deny" ? "deny" : "allow",
        message,
      });
    }
    return;
  }

  if (permEntry.isAntigravity) {
    if (behavior === "no-decision") {
      sendAntigravityNoDecisionResponse(res, message || "fallback");
    } else {
      sendAntigravityPermissionResponse(res, {
        behavior: behavior === "deny" ? "deny" : "allow",
        message,
      });
    }
    return;
  }

  if (permEntry.isHermes) {
    if (behavior === "no-decision") {
      sendHermesNoDecisionResponse(res, message || "fallback");
    } else if (permEntry.isElicitation && behavior === "allow" && permEntry.resolvedUpdatedInput) {
      sendHermesPermissionResponse(res, {
        decision: "allow",
        answers: permEntry.resolvedUpdatedInput.answers || {},
      });
    } else {
      sendHermesPermissionResponse(res, {
        decision: behavior === "deny" ? "deny" : "allow",
        message: message || undefined,
      });
    }
    return;
  }

  // DeepSeek Harness bridge waits on this HTTP response inside its public
  // approval/request waterfall. Only ordinary approval decisions travel here;
  // ask_user_question remains owned by DSH's native provider.
  if (permEntry.isDsh) {
    if (behavior === "no-decision") {
      sendDshNoDecisionResponse(res, message || "fallback");
      return;
    }
    sendDshPermissionResponse(res, {
      decision: behavior === "deny" ? "deny" : "allow",
    });
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

// Fire-and-forget POST to the family plugin's reverse bridge. The plugin runs
// inside the host and does NOT expose the host's own permission route
// externally — TUI mode has no TCP listener at all (see Phase 2 Spike in
// docs/plans/plan-opencode-integration.md). Instead the plugin starts a tiny
// Bun.serve (CLI/TUI) or node:http (Desktop) listener on a random port and
// forwards our decision to the host's in-process Hono router via ctx.client._client.post().
//
// Shape: POST http://127.0.0.1:<plugin-port>/reply
//   Authorization: Bearer <hex token>
//   { "request_id": "per_xxx", "reply": "once" | "always" | "reject" }
//
// Uses raw http.request (not fetch) to avoid Electron main-process fetch
// polyfill concerns. Bridge is always 127.0.0.1 bound by the plugin so no
// IPv4/IPv6 gotcha. 5s timeout — on failure the host still falls back to its
// native terminal or Desktop approval.
function replyOpencodeFamilyPermission({ agentId, bridgeUrl, bridgeToken, requestId, reply, toolName }) {
  const tag = agentId || "opencode-family";
  const normalizedBridgeUrl = normalizeOpencodeFamilyBridgeUrl(bridgeUrl);
  const validBridgeToken = isValidOpencodeFamilyBridgeToken(bridgeToken);
  if (!normalizedBridgeUrl || !validBridgeToken || !requestId) {
    const missing = !normalizedBridgeUrl
      ? "valid bridgeUrl"
      : (!validBridgeToken ? "valid bridgeToken" : "requestId");
    permLog(`${tag} reply skipped: missing ${missing}`);
    return;
  }
  const fullUrl = `${normalizedBridgeUrl}/reply`;
  permLog(`${tag} reply: tool=${toolName || "?"} request=${requestId} reply=${reply} url=${fullUrl}`);

  let parsed;
  try { parsed = new URL(fullUrl); } catch {
    permLog(`${tag} reply skipped: invalid bridge URL ${fullUrl}`);
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
      permLog(`${tag} reply status=${res.statusCode} request=${requestId} body=${respBody.trim() || "(empty)"}`);
    });
  });
  req.on("error", (err) => {
    const info = err
      ? `code=${err.code || ""} errno=${err.errno || ""} syscall=${err.syscall || ""} msg=${err.message || ""}`
      : "null";
    permLog(`${tag} reply ERR ${info} request=${requestId}`);
  });
  req.on("timeout", () => {
    req.destroy();
    permLog(`${tag} reply timeout request=${requestId}`);
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

function sendQwenCodeNoDecisionResponse(res, reason = "") {
  return sendNoDecisionResponse(res, reason, "qwen-code");
}

function sendQwenCodePermissionResponse(res, decisionOrBehavior, message) {
  if (!res || res.writableEnded || res.destroyed || res.headersSent) return false;
  const responseBody = buildQwenCodePermissionResponseBody(decisionOrBehavior, message);
  if (responseBody === "{}") {
    return sendQwenCodeNoDecisionResponse(res, "invalid decision");
  }
  permLog(`qwen-code response: ${responseBody}`);
  res.writeHead(200, {
    "Content-Type": "application/json",
    [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID,
  });
  res.end(responseBody);
  return true;
}

function sendZcodeNoDecisionResponse(res, reason = "") {
  return sendNoDecisionResponse(res, reason, "zcode");
}

function sendZcodePermissionResponse(res, decisionOrBehavior, message) {
  if (!res || res.writableEnded || res.destroyed || res.headersSent) return false;
  const responseBody = buildZcodePermissionResponseBody(decisionOrBehavior, message);
  if (responseBody === "{}") {
    return sendZcodeNoDecisionResponse(res, "invalid decision");
  }
  permLog(`zcode response: ${responseBody}`);
  res.writeHead(200, {
    "Content-Type": "application/json",
    [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID,
  });
  res.end(responseBody);
  return true;
}

function sendCopilotNoDecisionResponse(res, reason = "") {
  return sendNoDecisionResponse(res, reason, "copilot-cli");
}

function sendCopilotPermissionResponse(res, decisionOrBehavior, message) {
  if (!res || res.writableEnded || res.destroyed || res.headersSent) return false;
  const responseBody = buildCopilotPermissionResponseBody(decisionOrBehavior, message);
  if (responseBody === "{}") {
    return sendCopilotNoDecisionResponse(res, "invalid decision");
  }
  permLog(`copilot-cli response: ${responseBody}`);
  res.writeHead(200, {
    "Content-Type": "application/json",
    [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID,
  });
  res.end(responseBody);
  return true;
}

function sendAntigravityNoDecisionResponse(res, reason = "") {
  return sendNoDecisionResponse(res, reason, "antigravity");
}

function sendAntigravityPermissionResponse(res, decisionOrBehavior, message) {
  if (!res || res.writableEnded || res.destroyed || res.headersSent) return false;
  const responseBody = buildAntigravityPermissionResponseBody(decisionOrBehavior, message);
  if (responseBody === "{}") {
    return sendAntigravityNoDecisionResponse(res, "invalid decision");
  }
  permLog(`antigravity response: ${responseBody}`);
  res.writeHead(200, {
    "Content-Type": "application/json",
    [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID,
  });
  res.end(responseBody);
  return true;
}

function sendHermesNoDecisionResponse(res, reason = "") {
  return sendNoDecisionResponse(res, reason, "hermes");
}

function sendDshNoDecisionResponse(res, reason = "") {
  return sendNoDecisionResponse(res, reason, "dsh");
}

function sendDshPermissionResponse(res, responseObj) {
  if (!res || res.writableEnded || res.destroyed || res.headersSent) return false;
  const responseBody = JSON.stringify(responseObj);
  permLog(`dsh response: ${responseBody}`);
  res.writeHead(200, {
    "Content-Type": "application/json",
    [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID,
  });
  res.end(responseBody);
  return true;
}

function sendHermesPermissionResponse(res, responseObj) {
  if (!res || res.writableEnded || res.destroyed || res.headersSent) return false;
  const responseBody = JSON.stringify(responseObj);
  permLog(`hermes response: ${responseBody}`);
  res.writeHead(200, {
    "Content-Type": "application/json",
    [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID,
  });
  res.end(responseBody);
  return true;
}

function handleBubbleHeight(event, measurement) {
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  const perm = pendingPermissions.find(p => p.bubble === senderWin);
  if (!perm) return;
  ensureBubblePresentationState(perm);
  const legacyHeight = typeof measurement === "number" ? measurement : null;
  const height = legacyHeight !== null ? legacyHeight : Number(measurement && measurement.height);
  const state = legacyHeight !== null ? "compact" : measurement && measurement.state;
  const epoch = legacyHeight !== null ? 0 : Number(measurement && measurement.measurementEpoch);
  if (!(height > 0)) return;
  if (state !== (perm.expanded ? "expanded" : "compact")) return;
  if (!Number.isInteger(epoch) || epoch !== perm.measurementEpoch) return;

  if (state === "expanded") {
    perm.expandedMeasuredHeight = Math.ceil(height);
    const chromeHeight = Number(measurement && measurement.chromeHeight);
    const detailLineHeight = Number(measurement && measurement.detailLineHeight);
    if (chromeHeight > 0) perm.expandedChromeHeight = Math.ceil(chromeHeight);
    if (detailLineHeight > 0) perm.expandedDetailLineHeight = Math.ceil(detailLineHeight);
    if (!perm.expandedHeightBudgetMeasured) {
      const wa = getAnchorWorkArea();
      const scale = getTextScale(wa);
      const margin = Math.round(8 * scale);
      const gap = Math.round(6 * scale);
      perm.expandedHeightBudget = computeExpandedHeightBudget(perm, scale, wa, margin, gap);
      perm.expandedBudgetKey = getExpandedBudgetKey(wa, scale);
      perm.expandedHeightBudgetMeasured = true;
    }
  } else {
    perm.compactMeasuredHeight = Math.ceil(height);
    // Keep the legacy field during the transition because several tests and
    // older callers inspect it directly.
    perm.measuredHeight = perm.compactMeasuredHeight;
  }
  // revealCard() reports height on the next animation frame, so this is the
  // first main-process acknowledgement that the exact interaction was loaded,
  // received through permission-show, rendered, and made visible. Announcing
  // earlier (even at did-finish-load) can strand an unretractable Slack card
  // when content sync or the renderer fails. Later resize reports are safe:
  // announceSlackPermission is once-guarded per entry.
  announceSlackPermission(perm);
  // Geometry updates happen after the delivery acknowledgement. If either
  // reflow throws, the already-rendered card must still be announced.
  repositionBubbles();
  repositionDependentBubbles();
}

function handleBubbleExpanded(event, expanded) {
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  const perm = pendingPermissions.find((entry) => entry.bubble === senderWin);
  if (!perm) return false;
  ensureBubblePresentationState(perm);
  const wantsExpanded = expanded === true;
  if (wantsExpanded === perm.expanded) {
    sendPermissionPresentation(perm);
    return true;
  }

  if (wantsExpanded) {
    const previous = expandedPermissionEntry;
    if (previous && previous !== perm) {
      ensureBubblePresentationState(previous);
      if (previous.compositionActive) {
        sendPermissionPresentation(previous);
        sendPermissionPresentation(perm);
        return false;
      }
      previous.expanded = false;
      previous.measurementEpoch += 1;
      sendPermissionPresentation(previous);
    }
    const wa = getAnchorWorkArea();
    const scale = getTextScale(wa);
    const margin = Math.round(8 * scale);
    const gap = Math.round(6 * scale);
    perm.expanded = true;
    perm.measurementEpoch += 1;
    perm.expandedHeightBudget = computeExpandedHeightBudget(perm, scale, wa, margin, gap);
    perm.expandedBudgetKey = getExpandedBudgetKey(wa, scale);
    perm.expandedHeightBudgetMeasured = false;
    expandedPermissionEntry = perm;
    repositionBubbles();
    sendPermissionPresentation(perm);

    const capabilities = isValidInteraction(perm.interaction)
      ? perm.interaction.capabilities
      : {};
    if (capabilities.answerQuestions === true || capabilities.planFeedback === true) {
      try { senderWin.focus(); } catch {}
    }
  } else {
    perm.expanded = false;
    perm.measurementEpoch += 1;
    if (expandedPermissionEntry === perm) expandedPermissionEntry = null;
    sendPermissionPresentation(perm);
    repositionBubbles();
  }
  repositionDependentBubbles();
  syncPermissionShortcuts();
  return true;
}

function handleCompositionActive(event, active) {
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  const perm = pendingPermissions.find((entry) => entry.bubble === senderWin);
  if (!perm) return;
  ensureBubblePresentationState(perm);
  perm.compositionActive = active === true;
}

// macOS only: while a text input inside the bubble is focused, the bubble must
// drop out of always-on-top so the OS IME candidate window (Chinese/Japanese/
// Korean input popup) can surface — it floats above normal windows only, so any
// always-on-top level (and the native SkyLight stationary path) occludes it.
// We only flip the __clawdMacImeEditing flag here and let reapplyMacVisibility()
// apply the actual editing-vs-normal window state, so both directions round-trip
// through one place (topmost-runtime.js) instead of being hand-rolled twice.
// The renderer clears the flag on element blur AND on window blur (e.g. Cmd-Tab
// away mid-composition), so it can't get stuck and strand the bubble.
function handleImeEditing(event, editing) {
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  const perm = pendingPermissions.find(p => p.bubble === senderWin);
  if (!perm || !perm.bubble || perm.bubble.isDestroyed()) return;
  perm.textInputActive = editing === true;
  syncPermissionShortcuts();
  if (!isMac) return;
  const wasEditing = perm.bubble.__clawdMacImeEditing === true;
  if (editing) perm.bubble.__clawdMacImeEditing = true;
  else delete perm.bubble.__clawdMacImeEditing;
  if (typeof ctx.reapplyMacVisibility === "function") ctx.reapplyMacVisibility();
  if (!editing && wasEditing) {
    if (typeof ctx.repositionFloatingBubbles === "function") {
      try { ctx.repositionFloatingBubbles(); } catch {}
    } else {
      repositionBubbles();
      repositionDependentBubbles();
    }
    // reapplyMacVisibility() evaluates the pet dodge before the frozen bubble
    // moves. Re-evaluate once more against its final bounds so blur cannot
    // strand the pet faded/click-through (or leave it covering the input).
    if (typeof ctx.syncImeEditingPetDodge === "function") {
      try { ctx.syncImeEditingPetDodge(); } catch {}
    }
  }
}

// #640: the editing flag is normally cleared by renderer focusout/window-blur
// IPC (see handleImeEditing) — a crashed renderer can't send either, so the
// flag would stay stuck and keep the pet faded + click-through. Called from
// the bubble's render-process-gone listener.
function handleBubbleRendererGone(bubble) {
  if (!bubble || !bubble.__clawdMacImeEditing) return;
  delete bubble.__clawdMacImeEditing;
  if (typeof ctx.reapplyMacVisibility === "function") ctx.reapplyMacVisibility();
}

function handleDecide(event, behavior) {
  // Identify which permission this bubble belongs to via sender webContents
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  const perm = pendingPermissions.find(p => p.bubble === senderWin);
  permLog(`IPC permission-decide: behavior=${behavior} matched=${!!perm}`);
  if (!perm) return;
  if (perm.isCodexUserInputNotify) {
    dismissPassiveNotify(perm, "ipc-decide");
    if (behavior === "codex-user-input-focus" && !perm.host) {
      ctx.focusTerminalForSession(perm.sessionId, { fallbackEntry: buildPermissionFocusEntry(perm) });
    }
    return;
  }
  if (perm.isCodexNotify || perm.isKimiNotify) {
    dismissPassiveNotify(perm, "ipc-decide");
    // Kimi Code's cue is a heads-up that its terminal is blocking on a native
    // approve/reject prompt, so "Got it" doubles as "take me there": focus the
    // originating terminal after dismissing. Codex's passive notify is
    // informational-only, so it stays a plain acknowledge.
    if (perm.isKimiNotify) {
      ctx.focusTerminalForSession(perm.sessionId, { fallbackEntry: buildPermissionFocusEntry(perm) });
    }
    return;
  }
  if (behavior === "session-trust") {
    if (typeof ctx.requestSessionTrust === "function") {
      Promise.resolve(ctx.requestSessionTrust(perm)).catch((err) => {
        permLog(`session trust request failed: ${err && err.message ? err.message : err}`);
        perm.sessionTrustError = typeof ctx.translate === "function"
          ? ctx.translate("sessionAutomationFailedRetry")
          : "Session automation failed. Please try again.";
        endSessionTrustConfirmation(perm, { rearm: true });
        syncPermissionBubbleContent(perm);
      });
    }
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
  if (perm.isQwenCode) {
    if (behavior === "allow" || behavior === "deny") {
      resolvePermissionEntry(perm, behavior);
      return;
    }
    resolvePermissionEntry(perm, "no-decision", `Unsupported Qwen bubble action: ${String(behavior)}`);
    if (behavior === "deny-and-focus") {
      ctx.focusTerminalForSession(perm.sessionId, { fallbackEntry: buildPermissionFocusEntry(perm) });
    }
    return;
  }
  if (perm.isZcode) {
    if (behavior === "allow" || behavior === "deny") {
      resolvePermissionEntry(perm, behavior);
      return;
    }
    resolvePermissionEntry(perm, "no-decision", `Unsupported ZCode bubble action: ${String(behavior)}`);
    if (behavior === "deny-and-focus") {
      ctx.focusTerminalForSession(perm.sessionId, { fallbackEntry: buildPermissionFocusEntry(perm) });
    }
    return;
  }
  if (perm.isCopilotCli) {
    if (behavior === "allow" || behavior === "deny") {
      resolvePermissionEntry(perm, behavior);
      return;
    }
    // Mirror Codex/Qwen: any non-allow/deny UI action (deny-and-focus,
    // suggestion picker, family-always) is unsupported for Copilot's
    // simple {behavior, message} wire format. Resolve as no-decision so
    // the hook returns empty stdout and Copilot's native menu owns the
    // call rather than the bubble parking until timeout.
    resolvePermissionEntry(perm, "no-decision", `Unsupported Copilot bubble action: ${String(behavior)}`);
    if (behavior === "deny-and-focus") {
      ctx.focusTerminalForSession(perm.sessionId, { fallbackEntry: buildPermissionFocusEntry(perm) });
    }
    return;
  }
  if (perm.isAntigravity && behavior !== "allow" && behavior !== "deny") {
    resolvePermissionEntry(perm, "no-decision", `Unsupported Antigravity bubble action: ${String(behavior)}`);
    if (behavior === "deny-and-focus") {
      ctx.focusTerminalForSession(perm.sessionId, { fallbackEntry: buildPermissionFocusEntry(perm) });
    }
    return;
  }
  if (perm.isDsh) {
    if (behavior === "allow" || behavior === "deny") {
      resolvePermissionEntry(perm, behavior);
      return;
    }
    resolvePermissionEntry(perm, "no-decision", `Unsupported DSH bubble action: ${String(behavior)}`);
    return;
  }
  if (perm.isHermes) {
    if (behavior === "allow" || behavior === "deny") {
      resolvePermissionEntry(perm, behavior);
      return;
    }
    if (
      isValidInteraction(perm.interaction)
      && perm.interaction.intent === INTERACTION_INTENT.HUMAN_QUESTION
      && perm.interaction.capabilities.answerQuestions
      && behavior
      && typeof behavior === "object"
      && behavior.type === "elicitation-submit"
    ) {
      const wireInput = perm.elicitationWireInput || perm.toolInput;
      const validatedAnswers = validateAndRemapIndexedElicitationAnswers(
        wireInput,
        behavior.answers
      );
      if (!validatedAnswers.ok) {
        permLog(`desktop Hermes elicitation rejected: ${validatedAnswers.reason}`);
        resolvePermissionEntry(perm, "no-decision", validatedAnswers.reason);
        return;
      }
      perm.resolvedUpdatedInput = buildElicitationUpdatedInput(
        wireInput,
        validatedAnswers.answers
      );
      resolvePermissionEntry(perm, "allow");
      return;
    }
    // Hermes' opt-in permission gate has no native approval prompt. The plugin
    // maps no-decision to a retryable block, while clarify elicitation maps it
    // to Hermes' native clarification UI. This branch backstops unknown/legacy
    // actions without fabricating allow or deny.
    resolvePermissionEntry(perm, "no-decision", `Unsupported Hermes bubble action: ${String(behavior)}`);
    if (behavior === "deny-and-focus") {
      ctx.focusTerminalForSession(perm.sessionId, { fallbackEntry: buildPermissionFocusEntry(perm) });
    }
    return;
  }
  if (
    isValidInteraction(perm.interaction)
    && perm.interaction.intent === INTERACTION_INTENT.HUMAN_QUESTION
    && perm.interaction.capabilities.answerQuestions
    && behavior
    && typeof behavior === "object"
    && behavior.type === "elicitation-submit"
  ) {
    const wireInput = perm.elicitationWireInput || perm.toolInput;
    const validatedAnswers = validateAndRemapIndexedElicitationAnswers(
      wireInput,
      behavior.answers
    );
    if (!validatedAnswers.ok) {
      permLog(`desktop elicitation rejected: ${validatedAnswers.reason}`);
      resolvePermissionEntry(perm, "no-decision", validatedAnswers.reason);
      return;
    }
    perm.resolvedUpdatedInput = buildElicitationUpdatedInput(
      wireInput,
      validatedAnswers.answers
    );
    resolvePermissionEntry(perm, "allow");
    return;
  }
  // Plan feedback: "Tell Claude what to change" textarea submitted from the
  // ExitPlanMode bubble. Sends deny + reason so CC feeds the feedback to
  // Claude as a system message for plan revision.
  if (
    isValidInteraction(perm.interaction)
    && perm.interaction.intent === INTERACTION_INTENT.PLAN_REVIEW
    && perm.interaction.capabilities.planFeedback
    && behavior
    && typeof behavior === "object"
    && behavior.type === "plan-feedback"
  ) {
    const feedback = typeof behavior.feedback === "string"
      ? behavior.feedback.trim()
      : "";
    if (!feedback) {
      // Empty feedback → treat as "go to terminal"
      dismissPermissionForTerminal(perm);
      return;
    }
    if (feedback.length > PLAN_FEEDBACK_MAX_LENGTH) {
      permLog(`desktop plan feedback rejected: exceeds ${PLAN_FEEDBACK_MAX_LENGTH} characters`);
      resolvePermissionEntry(perm, "no-decision", "Plan feedback is too long");
      return;
    }
    resolvePermissionEntry(perm, "deny", feedback);
    return;
  }
  // opencode-family "Always" button — map to reply="always" via resolvePermissionEntry
  if (behavior === "family-always") {
    perm.familyAlwaysPicked = true;
    resolvePermissionEntry(perm, "allow");
    return;
  }
  // "suggestion:N" — user picked a permission suggestion
  if (typeof behavior === "string" && behavior.startsWith("suggestion:")) {
    const idx = parseInt(behavior.split(":")[1], 10);
    if (!applyPermissionSuggestion(perm, idx)) { resolvePermissionEntry(perm, "deny", "Invalid suggestion index"); return; }
    resolvePermissionEntry(perm, "allow");
  } else if (behavior === "deny-and-focus") {
    dismissPermissionForTerminal(perm);
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
    interaction: classifyPermissionInteraction({
      agentId: "codex",
      eventKind: "notification",
      toolName: "CodexExec",
    }),
    isElicitation: false, isCodexNotify: true,
    agentId: "codex",
    autoExpireTimer: null,
  };
  addPendingPermission(permEntry, "passive-added");
  showPermissionBubble(permEntry);
  permLog(`passive notify show: agent=codex session=${sessionId} autoCloseMs=${policy.autoCloseMs}`);
  schedulePassiveNotifyAutoExpire(permEntry, policy.autoCloseMs);
}

function showCodexUserInputBubble({
  sessionId,
  callId,
  questions,
  autoResolutionMs,
  sourcePid,
  agentPid,
  cwd,
  host,
  codexOriginator,
  codexSource,
}) {
  if (!sessionId || !callId || !Array.isArray(questions) || !questions.length) return false;
  if (shouldSuppressCodexUserInputBubble(ctx)) {
    const policy = getPolicy(ctx, "notification");
    permLog(`codex user-input suppressed: session=${sessionId} dnd=${ctx.doNotDisturb} notificationEnabled=${policy.enabled}`);
    return false;
  }
  // autoResolutionMs is validated/clamped at the protocol boundary
  // (hooks/codex-user-input.js) but has no reader in the bubble UI — nothing
  // auto-closes this card but a matching function_call_output or an
  // explicit lifecycle end (see agent-runtime-main.js), so it's deliberately
  // left out of toolInput rather than threaded somewhere that implies a
  // countdown exists.
  const existing = findCodexUserInputEntry(sessionId, callId);
  if (existing) {
    existing.toolInput = { questions };
    existing.createdAt = Date.now();
    syncPermissionBubbleContent(existing);
    return true;
  }
  const permEntry = {
    res: null,
    abortHandler: null,
    suggestions: [],
    sessionId,
    bubble: null,
    hideTimer: null,
    toolName: "CodexUserInput",
    toolInput: { questions },
    codexUserInputCallId: callId,
    resolvedSuggestion: null,
    createdAt: Date.now(),
    interaction: classifyPermissionInteraction({
      agentId: "codex",
      eventKind: "native-question",
      toolName: "CodexUserInput",
    }),
    isElicitation: false,
    isCodexUserInputNotify: true,
    agentId: "codex",
    sourcePid: sourcePid || null,
    agentPid: agentPid || null,
    cwd: cwd || "",
    host: host || null,
    codexOriginator: codexOriginator || null,
    codexSource: codexSource || null,
    autoExpireTimer: null,
  };
  addPendingPermission(permEntry, "passive-added");
  showPermissionBubble(permEntry);
  permLog(`passive user-input show: agent=codex session=${sessionId} call=${callId}`);
  return true;
}

function showKimiNotifyBubble({ sessionId, command, toolName, permissionAction, permissionCommand, permissionToolInput }) {
  if (shouldSuppressKimiNotifyBubble(ctx)) {
    const policy = getPolicy(ctx, "notification");
    permLog(`kimi notify suppressed: session=${sessionId} dnd=${ctx.doNotDisturb} notificationEnabled=${policy.enabled}`);
    return;
  }
  const policy = getPolicy(ctx, "notification");
  // #563: prefer the real command from Kimi Code's native PermissionRequest
  // display block, then its human-readable action line; legacy synthesized
  // requests carry neither and keep the generic copy.
  const bubbleCommand = permissionCommand || permissionAction || command
    || "Approve or reject in Kimi terminal.";
  // A newer request for the same session replaces the stale cue in place
  // (codex idiom above): the terminal now blocks on the NEW command, and
  // keeping request #1's pill/command/badge would show a wrong answer with
  // authority. A legacy-shaped refresh downgrades to the generic copy — the
  // generic line can't be wrong.
  const existing = findKimiNotifyEntryBySession(sessionId);
  if (existing) {
    existing.toolInput = { command: bubbleCommand };
    existing.kimiToolName = typeof toolName === "string" && toolName ? toolName : null;
    existing.kimiToolInput = permissionToolInput && typeof permissionToolInput === "object"
      ? permissionToolInput
      : null;
    existing.createdAt = Date.now();
    permLog(`passive notify refresh: agent=kimi-cli session=${sessionId} autoCloseMs=${policy.autoCloseMs}`);
    syncPermissionBubbleContent(existing);
    schedulePassiveNotifyAutoExpire(existing, policy.autoCloseMs);
    return;
  }
  const permEntry = {
    res: null,
    abortHandler: null, suggestions: [],
    sessionId, bubble: null, hideTimer: null,
    toolName: "KimiPermission",
    toolInput: { command: bubbleCommand },
    kimiToolName: typeof toolName === "string" && toolName ? toolName : null,
    // Whitelisted subset of the native request's tool_input (see
    // extractPermissionToolInput in hooks/kimi-hook.js — the server re-runs
    // it at the trust boundary). Display-only: it feeds the bubble's
    // tool-aware cue and never touches approval semantics.
    kimiToolInput: permissionToolInput && typeof permissionToolInput === "object"
      ? permissionToolInput
      : null,
    resolvedSuggestion: null, createdAt: Date.now(),
    interaction: classifyPermissionInteraction({
      agentId: "kimi-cli",
      eventKind: "notification",
      toolName: "KimiPermission",
    }),
    isElicitation: false, isKimiNotify: true,
    agentId: "kimi-cli",
    autoExpireTimer: null,
  };
  addPendingPermission(permEntry, "passive-added");
  showPermissionBubble(permEntry);
  permLog(`passive notify show: agent=kimi-cli session=${sessionId} autoCloseMs=${policy.autoCloseMs}`);
  schedulePassiveNotifyAutoExpire(permEntry, policy.autoCloseMs);
}

function getPassiveNotifyAgentId(permEntry) {
  if (permEntry?.isCodexNotify || permEntry?.isCodexUserInputNotify) return "codex";
  if (permEntry?.isKimiNotify) return "kimi-cli";
  return permEntry?.agentId || "unknown";
}

function findCodexUserInputEntry(sessionId, callId) {
  if (!sessionId || !callId) return null;
  return pendingPermissions.find((permEntry) =>
    permEntry
    && permEntry.isCodexUserInputNotify
    && permEntry.sessionId === sessionId
    && permEntry.codexUserInputCallId === callId
  ) || null;
}

function findCodexNotifyEntryBySession(sessionId) {
  if (!sessionId) return null;
  return pendingPermissions.find((permEntry) => permEntry && permEntry.isCodexNotify && permEntry.sessionId === sessionId) || null;
}

function findKimiNotifyEntryBySession(sessionId) {
  if (!sessionId) return null;
  return pendingPermissions.find((permEntry) => permEntry && permEntry.isKimiNotify && permEntry.sessionId === sessionId) || null;
}

function dismissPassiveNotify(permEntry, reason = "unknown") {
  const idx = pendingPermissions.indexOf(permEntry);
  if (idx === -1) return;
  permLog(
    `passive notify dismiss: agent=${getPassiveNotifyAgentId(permEntry)} session=${permEntry.sessionId || "(none)"} reason=${reason}`
  );
  pendingPermissions.splice(idx, 1);
  notifyPermissionsChanged("passive-dismissed");
  if (permEntry.autoExpireTimer) clearTimeout(permEntry.autoExpireTimer);
  if (permEntry.hideTimer) clearTimeout(permEntry.hideTimer);
  hidePermissionBubbleSafely(permEntry);
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
  // request_user_input is a blocking question, not a transient notification.
  // Keep it visible until Codex records the matching function_call_output (or
  // the user explicitly dismisses/focuses it), even if notification policy is
  // refreshed while the card is open.
  if (permEntry.isCodexUserInputNotify) return false;
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
  const passiveEntries = pendingPermissions.filter(
    (entry) => isPassiveNotifyEntry(entry) && !entry.isCodexUserInputNotify
  );
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
  if (idx !== -1) {
    pendingPermissions.splice(idx, 1);
    notifyPermissionsChanged("dismissed");
  }
  cancelRemoteApproval(perm);
  if (perm._delayTimer) { clearTimeout(perm._delayTimer); perm._delayTimer = null; }
  if (perm.autoCloseTimer) { clearTimeout(perm.autoCloseTimer); perm.autoCloseTimer = null; }
  if (perm.abortHandler && perm.res) {
    try { perm.res.removeListener("close", perm.abortHandler); } catch {}
  }
  hidePermissionBubbleSafely(perm);
  // Do not answer approval requests on the user's behalf. Dropping the UI
  // means Codex/Antigravity receive no decision, CC/CodeBuddy fall back
  // via socket close, and opencode falls back by receiving no bridge reply.
  if (perm.isCodex) {
    sendCodexNoDecisionResponse(perm.res, reason || "permission-dismissed");
  } else if (perm.isQwenCode) {
    sendQwenCodeNoDecisionResponse(perm.res, reason || "permission-dismissed");
  } else if (perm.isZcode) {
    sendZcodeNoDecisionResponse(perm.res, reason || "permission-dismissed");
  } else if (perm.isCopilotCli) {
    sendCopilotNoDecisionResponse(perm.res, reason || "permission-dismissed");
  } else if (perm.isAntigravity) {
    sendAntigravityNoDecisionResponse(perm.res, reason || "permission-dismissed");
  } else if (perm.isHermes) {
    sendHermesNoDecisionResponse(perm.res, reason || "permission-dismissed");
  } else if (perm.isDsh) {
    sendDshNoDecisionResponse(perm.res, reason || "permission-dismissed");
  } else if (!isOpencodeFamilyEntry(perm) && perm.res && !perm.res.destroyed) {
    try { perm.res.destroy(); } catch {}
  }
}

function opencodeFamilyBridgeTokensEqual(expected, candidate) {
  if (
    !isValidOpencodeFamilyBridgeToken(expected)
    || !isValidOpencodeFamilyBridgeToken(candidate)
  ) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const candidateBytes = Buffer.from(candidate, "utf8");
  if (expectedBytes.length !== candidateBytes.length) return false;
  try {
    return timingSafeEqual(expectedBytes, candidateBytes);
  } catch {
    return false;
  }
}

function normalizeExternalFamilyPermissionIdentity(identity) {
  if (!identity || typeof identity !== "object") return null;
  const agentId = typeof identity.agentId === "string" ? identity.agentId : "";
  if (!getFamilyConfig(agentId)) return null;
  const requestId = typeof identity.requestId === "string" && identity.requestId
    ? identity.requestId
    : null;
  const sessionId = typeof identity.sessionId === "string" && identity.sessionId
    ? identity.sessionId
    : null;
  const bridgeUrl = normalizeOpencodeFamilyBridgeUrl(identity.bridgeUrl);
  const bridgeToken = isValidOpencodeFamilyBridgeToken(identity.bridgeToken)
    ? identity.bridgeToken
    : null;
  if (!requestId || !sessionId || !bridgeUrl || !bridgeToken) return null;
  return { agentId, requestId, sessionId, bridgeUrl, bridgeToken };
}

function boundedPermissionIdentityForLog(value) {
  if (typeof value !== "string") return "(invalid)";
  const clean = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim();
  if (!clean) return "(empty)";
  return clean.length > 120 ? `${clean.slice(0, 119)}…` : clean;
}

// A native OpenCode-family UI already resolved this exact request. Remove all
// exact duplicates locally, but never call resolvePermissionEntry(): that path
// would send a second once/always/reject decision through the reverse bridge.
function dismissOpencodeFamilyPermissionResolvedExternally(identity) {
  const normalized = normalizeExternalFamilyPermissionIdentity(identity);
  if (!normalized) {
    permLog("opencode-family external resolve no-op: invalid identity");
    return 0;
  }

  const matches = pendingPermissions.filter((entry) => {
    if (!isOpencodeFamilyEntry(entry) || entry.agentId !== normalized.agentId) return false;
    if (entry.familyRequestId !== normalized.requestId) return false;
    if (entry.sessionId !== normalized.sessionId) return false;
    const entryBridgeUrl = normalizeOpencodeFamilyBridgeUrl(entry.familyBridgeUrl);
    if (!entryBridgeUrl || entryBridgeUrl !== normalized.bridgeUrl) return false;
    return opencodeFamilyBridgeTokensEqual(entry.familyBridgeToken, normalized.bridgeToken);
  });

  if (matches.length === 0) {
    permLog(`opencode-family external resolve no-op: agent=${normalized.agentId} request=${boundedPermissionIdentityForLog(normalized.requestId)}`);
    return 0;
  }

  // Establish non-liveness first for every exact duplicate. A late click,
  // hotkey, automation callback, or timer will now fail its pending-membership
  // guard before any slower renderer/notification teardown runs.
  for (const entry of matches) {
    const index = pendingPermissions.indexOf(entry);
    if (index !== -1) pendingPermissions.splice(index, 1);
  }
  notifyPermissionsChanged("resolved-externally");

  for (const entry of matches) {
    cancelRemoteApproval(entry, { reason: "resolved-externally" });
    if (entry._delayTimer) { clearTimeout(entry._delayTimer); entry._delayTimer = null; }
    if (entry.autoCloseTimer) { clearTimeout(entry.autoCloseTimer); entry.autoCloseTimer = null; }
    if (entry.autoExpireTimer) { clearTimeout(entry.autoExpireTimer); entry.autoExpireTimer = null; }
    if (entry.abortHandler && entry.res) {
      try { entry.res.removeListener("close", entry.abortHandler); } catch {}
    }
    hidePermissionBubbleSafely(entry);
    notifyPermissionResolved(entry, "resolved-externally");
  }

  repositionBubbles();
  repositionDependentBubbles();
  syncPermissionShortcuts();
  permLog(`opencode-family external resolve matched: agent=${normalized.agentId} request=${boundedPermissionIdentityForLog(normalized.requestId)} count=${matches.length}`);
  return matches.length;
}

// Mirrors the DND dispatcher: CC res.destroy() so it falls back to chat,
// opencode skips the bridge reply so TUI takes over, codex just closes.
// options.subagentOnly (#451) restricts the sweep to entries that came from a
// CC subagent, mirroring the shouldBypassCCSubagentBubble exemptions —
// plan-review and elicitation bubbles stay up even when that sub-gate flips
// off, so dismissal must not reap them either.
function dismissPermissionsByAgent(agentId, options = {}) {
  if (!agentId) return 0;
  const subagentOnly = !!(options && options.subagentOnly);
  const matchesScope = (p) => !subagentOnly
    || (p.subagentId && !isDecisionInteraction(p.interaction));
  const toDismiss = pendingPermissions.filter((p) => p && p.agentId === agentId && matchesScope(p));
  if (toDismiss.length === 0) return 0;
  const reason = subagentOnly ? `dismiss-by-agent-subagent:${agentId}` : `dismiss-by-agent:${agentId}`;
  for (const perm of toDismiss) {
    if (isPassiveNotifyEntry(perm)) {
      dismissPassiveNotify(perm, reason);
      continue;
    }
    dismissInteractivePermissionWithoutDecision(perm, reason);
  }
  repositionBubbles();
  repositionDependentBubbles();
  syncPermissionShortcuts();
  permLog(`dismissPermissionsByAgent(${agentId}${subagentOnly ? ", subagent-only" : ""}): cleared ${toDismiss.length}`);
  return toDismiss.length;
}

function dismissInteractivePermissionBubbles() {
  const toDismiss = pendingPermissions.filter((p) => p && !isPassiveNotifyEntry(p));
  if (toDismiss.length === 0) return 0;
  for (const perm of toDismiss) {
    dismissInteractivePermissionWithoutDecision(perm, "interactive-bubbles-dismissed");
  }
  repositionBubbles();
  repositionDependentBubbles();
  syncPermissionShortcuts();
  permLog(`dismissInteractivePermissionBubbles(): cleared ${toDismiss.length}`);
  return toDismiss.length;
}

function dismissPermissionsForDnd() {
  const toDismiss = pendingPermissions.filter(Boolean);
  if (toDismiss.length === 0) return 0;
  for (const perm of toDismiss) {
    if (isPassiveNotifyEntry(perm)) {
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

function clearCodexUserInputBubbles(sessionId, callId, reason = "codex-user-input-clear") {
  const toRemove = pendingPermissions.filter((perm) =>
    perm
    && perm.isCodexUserInputNotify
    && (!sessionId || perm.sessionId === sessionId)
    && (!callId || perm.codexUserInputCallId === callId)
  );
  for (const perm of toRemove) dismissPassiveNotify(perm, reason);
  return toRemove.length;
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
  // Clean up all pending permission requests without deciding on the user's
  // behalf. Each protocol gets its normal no-decision fallback: bodyless
  // replies for supported hooks, socket close for Claude/CodeBuddy, and no
  // bridge reply for opencode-family requests.
  for (const perm of [...pendingPermissions]) {
    if (perm._delayTimer) clearTimeout(perm._delayTimer);
    if (perm.autoExpireTimer) clearTimeout(perm.autoExpireTimer);
    if (isPassiveNotifyEntry(perm)) dismissPassiveNotify(perm, "Clawd is quitting");
    else dismissInteractivePermissionWithoutDecision(perm, "Clawd is quitting");
  }
  permissionBubbleWindows.clear();
}

return {
  showPermissionBubble, resolvePermissionEntry,
  sendPermissionResponse, repositionBubbles, permLog,
  pendingPermissions, PASSTHROUGH_TOOLS,
  getVisibleBubbleBounds,
  addPendingPermission, removePendingPermission,
  isPermissionEntryLive, canAutoResolvePendingPermission,
  beginSessionTrustConfirmation, endSessionTrustConfirmation,
  syncPermissionBubbleContent,
  maybeStartRemoteApproval,
  dismissPermissionForTerminal,
  // Test seam: lets wire-level tests pin which provenance flags reach the
  // renderer (isHermes suppresses the go-to-terminal action — issue #689).
  buildPermissionBubblePayload,
  handleBubbleHeight, handleBubbleExpanded, handleCompositionActive,
  handleDecide, handleImeEditing, handleBubbleRendererGone, cleanup,
  showCodexNotifyBubble, clearCodexNotifyBubbles,
  showCodexUserInputBubble, clearCodexUserInputBubbles,
  showKimiNotifyBubble, clearKimiNotifyBubbles,
  refreshPassiveNotifyAutoClose,
  refreshPermissionAutoCloseForPolicy,
  dismissPermissionsByAgent, dismissInteractivePermissionBubbles,
  dismissPermissionsForDnd,
  dismissOpencodeFamilyPermissionResolvedExternally,
  syncPermissionShortcuts,
  replyOpencodeFamilyPermission,
  // Exposed for the payload↔renderer contract test (plan §3.5/§9): the
  // builder closes over ctx, so it can only be reached through an instance.
  buildPermissionBubblePayload,
};

};

module.exports.registerPermissionIpc = registerPermissionIpc;

// Test-only exports — bypasses the initPermission factory so unit tests can
// hit the pure layout function without standing up Electron / ctx mocks.
module.exports.__test = {
  computeBubbleStackLayout,
  computePassiveNotifyRemainingMs,
  computePermissionAutoCloseRemainingMs,
  clampBubbleHeight,
  shouldSuppressCodexNotifyBubble,
  sanitizeCodexPermissionDecision,
  buildCodexPermissionResponseBody,
  buildQwenCodePermissionResponseBody,
  buildZcodePermissionResponseBody,
  sanitizeAntigravityPermissionDecision,
  buildAntigravityPermissionResponseBody,
  buildElicitationUpdatedInput,
  remapIndexedElicitationAnswers,
  validateAndRemapIndexedElicitationAnswers,
  collectVisibleWindowBounds,
};
