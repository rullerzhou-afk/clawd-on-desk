"use strict";

// Route-facing half of the optional external review command (#995).
//
// The accepted request is reviewed ONCE, at the trust boundary, before the
// entry can reach any automatic-allow path -- global automation, a session
// grant that already exists, a grant created later (sweep), or the remote-only
// path. Freezing the verdict on the entry is what makes the decision paths
// stay synchronous and race-free: by the time canAutoResolvePendingPermission()
// or maybeAutoApprovePermission() asks, the answer is already known. There is
// no in-flight review whose late result could arrive after an allow, because
// the allow cannot happen before this function settles.

const {
  AUTOMATION_ACTION,
  INTERACTION_INTENT,
  PERMISSION_AUTOMATION_MODE,
  evaluatePermissionAutomation,
  isValidInteraction,
} = require("./permission-automation-policy");
const {
  DEFAULT_TIMEOUT_MS,
  NOT_REVIEWED_TAG,
  normalizePermissionReviewCommand,
  normalizePermissionReviewTimeoutMs,
  runPermissionReviewCommand,
} = require("./permission-review-command");

const REVIEWED_INTENTS = new Set([
  INTERACTION_INTENT.TOOL_APPROVAL,
  INTERACTION_INTENT.UNKNOWN,
]);

/**
 * Read the review settings through the permission runtime's ctx.
 *
 * `ok: false` means the settings could not be read at all. Callers must treat
 * that as "could be configured" (hold unless the entry carries an explicit
 * allow stamp) rather than "off".
 */
function readPermissionReviewConfig(ctx) {
  if (!ctx || typeof ctx.getPermissionReviewConfig !== "function") {
    return { ok: true, command: [], timeoutMs: DEFAULT_TIMEOUT_MS };
  }
  try {
    const raw = ctx.getPermissionReviewConfig();
    return {
      ok: true,
      command: normalizePermissionReviewCommand(raw && raw.command),
      timeoutMs: normalizePermissionReviewTimeoutMs(raw && raw.timeoutMs),
    };
  } catch (_err) {
    return { ok: false, command: [], timeoutMs: DEFAULT_TIMEOUT_MS };
  }
}

/** True when a review is configured, or when that cannot be determined. */
function isPermissionReviewEnabled(ctx) {
  const config = readPermissionReviewConfig(ctx);
  return config.ok === false || config.command.length > 0;
}

function effectiveModeForStub(ctx, stub) {
  if (ctx && typeof ctx.getEffectivePermissionAutomationMode === "function") {
    return ctx.getEffectivePermissionAutomationMode(stub, { sessionOnly: false });
  }
  if (ctx && typeof ctx.getPermissionAutomationMode === "function") {
    return ctx.getPermissionAutomationMode();
  }
  return PERMISSION_AUTOMATION_MODE.OFF;
}

/**
 * Whether running the command for this request could change anything.
 *
 * Only ordinary tool requests that this exact agent/mode/identity combination
 * would auto-allow qualify -- plan review and questions keep their existing
 * handling (the destructive reminder draws the same line), and a request that
 * was going to a human anyway must not pay the process cost or produce a
 * misleading "paused" reason.
 */
function isReviewCandidate({ ctx, agentId, sessionId, sessionAutomationIdentity, interaction }) {
  if (!isValidInteraction(interaction)) return false;
  if (!REVIEWED_INTENTS.has(interaction.intent)) return false;
  if (interaction.capabilities.allowDeny !== true) return false;
  const stub = {
    agentId,
    sessionId,
    sessionAutomationIdentity,
  };
  const mode = effectiveModeForStub(ctx, stub);
  if (!Object.values(PERMISSION_AUTOMATION_MODE).includes(mode)) return false;
  return evaluatePermissionAutomation({
    mode,
    interaction,
    reminderHold: false,
    reviewHold: false,
  }) === AUTOMATION_ACTION.AUTO_ALLOW;
}

// The external command does not run when the destructive reminder already holds
// the request: that hold is decided from the request itself and adding a second
// process would not change the outcome. The stamp says "not applicable" (an
// explicit allow would be wrong: nothing was reviewed) so the card shows the
// reminder's reason, not a review reason.
function destructiveHoldAtAccept(ctx, reminderStamp) {
  if (!reminderStamp || reminderStamp.hold !== true) return false;
  if (typeof ctx.isDestructiveReminderEnabled !== "function") return false;
  try {
    return ctx.isDestructiveReminderEnabled() === true;
  } catch (_err) {
    return true;
  }
}

function reviewStamp(result) {
  return {
    configured: true,
    hold: result.hold === true,
    tag: typeof result.tag === "string" ? result.tag : null,
    note: typeof result.note === "string" ? result.note : null,
    warning: result.warning === true,
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
  };
}

/**
 * Derive the review stamp spread into a pending permission entry.
 *
 * Resolves `{ permissionReview, cancelled }`; `permissionReview` is null when
 * no command is configured (the common, zero-cost case). Never rejects.
 *
 * `signal` is the request's abort signal. When it fires, the child is killed
 * and the result carries `cancelled: true`; the route must then stop without
 * creating an entry. A cancelled review is not a verdict -- it must never be
 * stamped as "allowed" even though the process produced no answer.
 */
async function preparePermissionReview(options = {}) {
  const {
    ctx,
    agentId,
    sessionId,
    sessionAutomationIdentity,
    interaction,
    toolName,
    toolInput,
    cwd,
    permissionReminder,
    signal,
  } = options;

  const config = readPermissionReviewConfig(ctx);
  if (config.ok === false) {
    if (typeof ctx.permLog === "function") {
      ctx.permLog(`external review: settings read failed; holding tool=${toolName || "(missing)"} session=${sessionId} agent=${agentId || "unknown"}`);
    }
    return {
      permissionReview: reviewStamp({
        hold: true,
        tag: "settings-error",
        note: null,
        warning: false,
        exitCode: null,
      }),
    };
  }
  if (config.command.length === 0) return { permissionReview: null };

  if (!isReviewCandidate({ ctx, agentId, sessionId, sessionAutomationIdentity, interaction })) {
    // No automatic allow is possible for this request right now, so nothing
    // needs review. The stamp is still a hold: if a session grant appears
    // later and makes the pending request auto-resolvable, an unreviewed
    // automatic allow must be impossible (fail closed) rather than silently
    // skipped.
    return {
      permissionReview: reviewStamp({
        hold: true,
        tag: NOT_REVIEWED_TAG,
        note: null,
        warning: false,
        exitCode: null,
      }),
    };
  }

  if (destructiveHoldAtAccept(ctx, permissionReminder)) {
    if (typeof ctx.permLog === "function") {
      ctx.permLog(`external review: skipped (destructive reminder holds) tool=${toolName || "(missing)"} session=${sessionId} agent=${agentId || "unknown"}`);
    }
    return {
      permissionReview: reviewStamp({
        hold: false,
        tag: "destructive-hold",
        note: null,
        warning: false,
        exitCode: null,
      }),
    };
  }

  const startedAt = Date.now();
  const result = await runPermissionReviewCommand({
    command: config.command,
    timeoutMs: config.timeoutMs,
    payload: { toolName, toolInput, agentId, sessionId, cwd },
    signal,
  });
  if (result.cancelled === true) {
    if (typeof ctx.permLog === "function") {
      ctx.permLog(`external review: cancelled (${result.reason || "request changed"}) after ${Date.now() - startedAt}ms tool=${toolName || "(missing)"} session=${sessionId} agent=${agentId || "unknown"}`);
    }
    return { permissionReview: null, cancelled: true, reason: result.reason || "cancelled" };
  }
  const stamp = reviewStamp(result);
  if (typeof ctx.permLog === "function") {
    const detail = result.error ? ` error=${JSON.stringify(String(result.error).slice(0, 200))}` : "";
    ctx.permLog(`external review: outcome=${stamp.tag} hold=${stamp.hold} exit=${stamp.exitCode === null ? "-" : stamp.exitCode} elapsed=${Date.now() - startedAt}ms tool=${toolName || "(missing)"} session=${sessionId} agent=${agentId || "unknown"}${stamp.note ? ` note=${JSON.stringify(stamp.note)}` : ""}${detail}`);
    if (stamp.tag === "unavailable") {
      // The usual cause is an interpreter that is not on the PATH the app
      // inherited (a GUI launch gets a minimal PATH on macOS). Say so once per
      // request instead of leaving the user with "every allow is a card".
      ctx.permLog("external review: command could not be started — use an absolute executable path; failing closed to the human card");
    }
  }
  return { permissionReview: stamp };
}

module.exports = {
  destructiveHoldAtAccept,
  effectiveModeForStub,
  isPermissionReviewEnabled,
  isReviewCandidate,
  preparePermissionReview,
  readPermissionReviewConfig,
  reviewStamp,
};
