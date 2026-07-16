"use strict";

// Pure, no-timer, no-write health inspector for Claude Code's managed hooks.
// Consumed by src/claude-settings-watcher.js's periodic audit and by
// src/doctor-detectors/agent-integrations.js for on-demand diagnostics. Never
// touches settings.json, never calls the installer — callers decide whether
// and how to repair based on the report this module returns.

const {
  validateHookCommand,
} = require("./doctor-detectors/agent-node-bin-parser");
const { commandMatchesMarker } = require("../hooks/json-utils");

// Deliberately NOT imported from ./claude-settings-watcher: that module will
// require this one (Phase 2's periodic audit calls inspectClaudeHookHealth()),
// and a mutual top-level require would hand one side an empty module.exports.
// This mirrors claude-settings-watcher.js's entriesContainHttpHookUrl exactly;
// keep both in sync if the PermissionRequest hook shape ever changes.
function entriesContainHttpHookUrl(entries, expectedUrl) {
  if (!Array.isArray(entries) || !expectedUrl) return false;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "http" && entry.url === expectedUrl) return true;
    if (!Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (!hook || typeof hook !== "object") continue;
      if (hook.type === "http" && hook.url === expectedUrl) return true;
    }
  }
  return false;
}

const HOOK_MARKER = "clawd-hook.js";
const AUTO_START_MARKER = "auto-start.js";

// Bounds the issues array so a pathological settings.json (thousands of
// malformed entries) cannot blow up Doctor payloads or logs.
const MAX_ISSUES = 20;

// buildClaudeRepairSignature() collapses every automatically-repairable issue
// code into one of these classes. The signature must stay stable across
// unrelated churn (event ordering, which specific event lost its hook, the
// literal stale path) so the watcher's 3-strikes counter only advances when
// the underlying repair actually keeps failing — not because two equivalent
// failures happened to render their issue list in a different order.
const REPAIR_CLASS_BY_CODE = Object.freeze({
  "missing-hooks": "managed-hooks",
  "missing-managed-core-hooks": "managed-hooks",
  "script-path-missing": "core-script-path",
  "stale-script-path": "core-script-path",
  "permission-url-mismatch": "permission-url",
  "auto-start-path-missing": "auto-start-path",
  "auto-start-stale-path": "auto-start-path",
  "node-bin-invalid": "node-bin",
});

function normalizePathForComparison(value, platform) {
  const text = String(value || "");
  return platform === "win32" ? text.replace(/\\/g, "/").toLowerCase() : text;
}

function scriptPathMatchesExpected(actual, expected, platform) {
  // Nothing to compare against (caller didn't pass an expected path) — don't
  // manufacture a stale-path issue out of an unknown expectation.
  if (typeof expected !== "string" || !expected) return true;
  return normalizePathForComparison(actual, platform) === normalizePathForComparison(expected, platform);
}

function findMarkerCommandsForEvent(hooks, eventName, marker) {
  const entries = hooks[eventName];
  if (!Array.isArray(entries)) return [];
  const commands = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (Array.isArray(entry.hooks)) {
      for (const hook of entry.hooks) {
        if (hook && typeof hook.command === "string" && commandMatchesMarker(hook.command, marker)) {
          commands.push(hook.command);
        }
      }
    }
    if (typeof entry.command === "string" && commandMatchesMarker(entry.command, marker)) {
      commands.push(entry.command);
    }
  }
  return commands;
}

function pushIssue(issues, issue) {
  if (issues.length >= MAX_ISSUES) return;
  issues.push(issue);
}

const CORE_COMMAND_ISSUE_CODES = Object.freeze({
  stale: "stale-script-path",
  missing: "script-path-missing",
});
const AUTO_START_COMMAND_ISSUE_CODES = Object.freeze({
  stale: "auto-start-stale-path",
  missing: "auto-start-path-missing",
});

// Validates every Clawd-owned command found for one event. Every command is
// checked independently — a stale/broken duplicate sitting alongside an
// already-healthy command for the same event must still surface as an issue.
// Stopping at the first healthy match would silently hide exactly the kind
// of leftover the #657 supervisor exists to find.
function inspectEventCommands(commands, event, marker, expectedScriptPath, validateOptions, issues, issueCodes) {
  const results = commands.map((command) => validateHookCommand(command, validateOptions));

  for (const result of results) {
    if (result.ok && scriptPathMatchesExpected(result.scriptPath, expectedScriptPath, validateOptions.platform)) {
      continue;
    }
    if (result.ok) {
      // Parses fine but doesn't point at the current expected path — a
      // stale/duplicate entry, flagged even when a sibling command under
      // the same event is already healthy.
      pushIssue(issues, {
        code: issueCodes.stale,
        event,
        marker,
        scriptPath: result.scriptPath,
        automaticRepairable: true,
      });
      continue;
    }
    if (result.issue === "nodeBin-invalid") {
      pushIssue(issues, {
        code: "node-bin-invalid",
        event,
        marker,
        nodeBin: result.nodeBin || null,
        automaticRepairable: true,
      });
    } else if (result.issue === "scriptPath-missing") {
      pushIssue(issues, {
        code: issueCodes.missing,
        event,
        marker,
        scriptPath: result.scriptPath || null,
        automaticRepairable: true,
      });
    } else {
      // parse-failed or an unrecognized wrapper — do not guess. Misclassifying
      // a third-party/unusual command as repairable risks rewriting something
      // Clawd does not own; surface it for Doctor instead.
      pushIssue(issues, {
        code: "command-unparseable",
        event,
        marker,
        automaticRepairable: false,
      });
    }
  }
}

/**
 * Inspect a raw (unparsed) settings.json string for Claude hook health.
 * Pure and read-only: `fs` is only ever used for existsSync/validateHookCommand
 * checks the caller already needed; this function never writes anything.
 *
 * @param {string} rawSettings
 * @param {object} options
 * @param {string} [options.expectedPermissionUrl]
 * @param {string} [options.expectedHookScriptPath]
 * @param {string} [options.expectedAutoStartScriptPath]
 * @param {boolean} [options.requireAutoStart]
 * @param {string[]} [options.coreEvents]
 * @param {string} [options.platform]
 * @param {object} [options.fs] — injected fs (existsSync at minimum)
 */
function inspectClaudeHookHealth(rawSettings, options = {}) {
  const platform = options.platform || process.platform;
  const fsImpl = options.fs;
  const coreEvents = Array.isArray(options.coreEvents) ? options.coreEvents : [];
  const expectedPermissionUrl = options.expectedPermissionUrl || null;
  const expectedHookScriptPath = options.expectedHookScriptPath || null;
  const expectedAutoStartScriptPath = options.expectedAutoStartScriptPath || null;
  const requireAutoStart = !!options.requireAutoStart;
  const validateOptions = { platform, fs: fsImpl };

  const unreadable = () => ({
    status: "unreadable",
    repairable: false,
    issues: [],
    commandCount: 0,
    managedCoreEventCount: 0,
    snapshot: null,
  });

  if (typeof rawSettings !== "string" || !rawSettings.trim()) return unreadable();

  let parsed;
  try {
    parsed = JSON.parse(rawSettings);
  } catch {
    return unreadable();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return unreadable();

  // The currently-installed source script is a hard precondition for every
  // repair this module can suggest: reconciling settings.json only rewrites
  // commands to point at expectedHookScriptPath, which is useless if that
  // file itself does not exist (a broken/partial install). Check this before
  // anything else so callers never attempt a reconcile that cannot succeed.
  // When auto-start is required, its own source script is an equally hard
  // precondition — otherwise a repair would "fix" things by writing a
  // SessionStart command that points at a script that isn't there either,
  // and since that write only happens while requireAutoStart is true, a
  // caller who later disables auto-start would never see the resulting
  // broken command flagged again (requireAutoStart:false skips the check
  // entirely) — it would sit as undetected garbage in settings.json.
  if (fsImpl && expectedHookScriptPath && !fsImpl.existsSync(expectedHookScriptPath)) {
    return {
      status: "source-script-missing",
      repairable: false,
      issues: [{ code: "source-script-missing", automaticRepairable: false }],
      commandCount: 0,
      managedCoreEventCount: 0,
      snapshot: null,
    };
  }
  if (fsImpl && requireAutoStart && expectedAutoStartScriptPath && !fsImpl.existsSync(expectedAutoStartScriptPath)) {
    return {
      status: "source-script-missing",
      repairable: false,
      issues: [{ code: "source-script-missing", event: "SessionStart", marker: AUTO_START_MARKER, automaticRepairable: false }],
      commandCount: 0,
      managedCoreEventCount: 0,
      snapshot: null,
    };
  }

  const issues = [];
  const hooks = parsed.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    pushIssue(issues, { code: "missing-hooks", automaticRepairable: true });
    return {
      status: "unhealthy",
      repairable: true,
      issues,
      commandCount: 0,
      managedCoreEventCount: 0,
      snapshot: { keyCount: Object.keys(parsed).length, hookCount: 0 },
    };
  }

  let commandCount = 0;
  let managedCoreEventCount = 0;
  const missingEvents = [];

  for (const event of coreEvents) {
    const commands = findMarkerCommandsForEvent(hooks, event, HOOK_MARKER);
    commandCount += commands.length;
    if (!commands.length) {
      missingEvents.push(event);
      continue;
    }
    managedCoreEventCount++;
    inspectEventCommands(commands, event, HOOK_MARKER, expectedHookScriptPath, validateOptions, issues, CORE_COMMAND_ISSUE_CODES);
  }

  if (coreEvents.length > 0 && managedCoreEventCount === 0) {
    pushIssue(issues, { code: "missing-managed-core-hooks", automaticRepairable: true });
  } else if (missingEvents.length > 0) {
    // A partial gap (some but not all core events missing) is a Doctor-only
    // signal in this PR — it must never feed the automatic repair signature.
    for (const event of missingEvents) {
      pushIssue(issues, { code: "missing-core-event", event, automaticRepairable: false });
    }
  }

  if (expectedPermissionUrl && !entriesContainHttpHookUrl(hooks.PermissionRequest, expectedPermissionUrl)) {
    pushIssue(issues, { code: "permission-url-mismatch", event: "PermissionRequest", automaticRepairable: true });
  }

  if (requireAutoStart) {
    const autoStartCommands = findMarkerCommandsForEvent(hooks, "SessionStart", AUTO_START_MARKER);
    if (!autoStartCommands.length) {
      pushIssue(issues, {
        code: "auto-start-path-missing",
        event: "SessionStart",
        marker: AUTO_START_MARKER,
        automaticRepairable: true,
      });
    } else {
      inspectEventCommands(
        autoStartCommands,
        "SessionStart",
        AUTO_START_MARKER,
        expectedAutoStartScriptPath,
        validateOptions,
        issues,
        AUTO_START_COMMAND_ISSUE_CODES
      );
    }
  }

  const snapshot = { keyCount: Object.keys(parsed).length, hookCount: commandCount };
  const repairable = issues.some((issue) => issue.automaticRepairable === true);

  return {
    status: issues.length === 0 ? "healthy" : "unhealthy",
    repairable,
    issues,
    commandCount,
    managedCoreEventCount,
    snapshot,
  };
}

/**
 * Deterministic, order/path-insensitive signature for the automatically
 * repairable subset of an issues list. Two reports with the same underlying
 * root causes must produce the same signature even if the specific event,
 * stale path, or issue ordering differs — the watcher's 3-strikes counter
 * depends on this to avoid resetting on cosmetic churn.
 */
function buildClaudeRepairSignature(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return null;
  const classes = new Set();
  for (const issue of issues) {
    if (!issue || issue.automaticRepairable !== true) continue;
    const cls = REPAIR_CLASS_BY_CODE[issue.code];
    if (cls) classes.add(cls);
  }
  if (classes.size === 0) return null;
  return `v1:${Array.from(classes).sort().join(",")}`;
}

/**
 * Whether an inspectClaudeHookHealth() report represents "nothing left for
 * automatic repair to do" — healthy, or only non-repairable/diagnostic
 * issues remain. unreadable/source-script-missing are never clean: neither
 * status means the config was actually verified, so callers must not treat
 * them as success.
 *
 * This is deliberately lenient about `command-unparseable`: that issue is
 * `automaticRepairable: false` (misclassifying a third-party/unusual command
 * as Clawd's to rewrite is worse than leaving it alone), so there is no
 * automatic repair action it should ever trigger or block. Used by the
 * periodic supervisor to decide "is there work for auto-repair to attempt."
 * Callers that need to know whether the config is *actually, fully* healthy
 * (e.g. reporting an explicit Install/Fix as succeeded) must use
 * isExplicitRepairVerified() instead — see its own docstring for why.
 */
function hasNoAutomaticRepairWork(report) {
  if (!report) return false;
  if (report.status === "unreadable" || report.status === "source-script-missing") return false;
  return buildClaudeRepairSignature(report.issues) === null;
}

/**
 * Whether a report contains a Clawd-owned command this module could not
 * parse (and therefore never attempted to classify as stale/missing/valid).
 * Exposed so callers can distinguish "nothing left to repair" from "nothing
 * left to repair, but something is still visibly wrong" without duplicating
 * the issue-code check.
 */
function reportHasUnparseableCommand(report) {
  return !!(report && Array.isArray(report.issues) && report.issues.some((issue) => issue && issue.code === "command-unparseable"));
}

/**
 * Stricter than hasNoAutomaticRepairWork(): whether an explicit Install/Fix
 * write actually left the config genuinely healthy, suitable for reporting
 * a user-facing "ok" instead of a blind trust of the installer's return
 * value. A `command-unparseable` command is never auto-repairable, so
 * hasNoAutomaticRepairWork() alone would call it clean even when a
 * Clawd-owned hook command is sitting there broken — that must not be
 * reported back to the user as a successful Install/Fix.
 */
function isExplicitRepairVerified(report) {
  return hasNoAutomaticRepairWork(report) && !reportHasUnparseableCommand(report);
}

module.exports = {
  inspectClaudeHookHealth,
  buildClaudeRepairSignature,
  hasNoAutomaticRepairWork,
  reportHasUnparseableCommand,
  isExplicitRepairVerified,
  CLAUDE_HOOK_MARKER: HOOK_MARKER,
  CLAUDE_AUTO_START_MARKER: AUTO_START_MARKER,
};
