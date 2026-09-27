"use strict";

const nodeFs = require("fs");

// Pure, no-timer, no-write health inspector for Claude Code's managed hooks.
// Consumed by src/claude-settings-watcher.js's periodic audit and by
// src/doctor-detectors/agent-integrations.js for on-demand diagnostics. Never
// touches settings.json, never calls the installer — callers decide whether
// and how to repair based on the report this module returns.

const {
  validateHookCommand,
} = require("./doctor-detectors/agent-node-bin-parser");
const {
  classifyManagedClaudeStateHookCommand,
  commandMatchesMarker,
  findManagedClaudeEnvNodeBinCandidates,
  parseClaudeEnvStateHookCommand,
  stripUtf8Bom,
} = require("../hooks/json-utils");

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
  "target-generation-missing": "target-generation",
  "permission-url-mismatch": "permission-url",
  "auto-start-path-missing": "auto-start-path",
  "auto-start-stale-path": "auto-start-path",
  "node-bin-invalid": "node-bin",
  "env-hook-migratable": "env-state-hook",
  "duplicate-managed-state-hook": "managed-hook-duplicates",
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

function findManagedStateCommandRecords(settings, eventName) {
  const hooks = settings && settings.hooks;
  const entries = hooks && hooks[eventName];
  if (!Array.isArray(entries)) return { managed: [], unverified: [] };
  const managed = [];
  const unverified = [];

  const collect = (hook, entryIndex, hookIndex) => {
    if (!hook || typeof hook.command !== "string") return;
    // Health historically recognizes Clawd commands inside PowerShell
    // EncodedCommand wrappers. Keep that read-only visibility without
    // broadening the installer's raw-marker mutation ownership boundary.
    const mutationKind = classifyManagedClaudeStateHookCommand(hook.command, settings, eventName);
    const kind = mutationKind || (commandMatchesMarker(hook.command, HOOK_MARKER) ? "literal" : null);
    const record = {
      command: hook.command,
      entryIndex,
      hookIndex,
      kind,
      mutationOwned: !!mutationKind,
    };
    if (kind) {
      if (kind === "env") {
        record.parsedEnv = parseClaudeEnvStateHookCommand(hook.command, eventName);
      }
      managed.push(record);
      return;
    }
    const parsedEnv = parseClaudeEnvStateHookCommand(hook.command, eventName);
    if (parsedEnv) unverified.push({ ...record, parsedEnv });
  };

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = entries[entryIndex];
    if (!entry || typeof entry !== "object") continue;
    collect(entry, entryIndex, null);
    if (!Array.isArray(entry.hooks)) continue;
    for (let hookIndex = 0; hookIndex < entry.hooks.length; hookIndex++) {
      collect(entry.hooks[hookIndex], entryIndex, hookIndex);
    }
  }

  return { managed, unverified };
}

function findUsableEnvNodeCandidate(settings, validateOptions, resolveTrustedNodeCandidate) {
  const fsImpl = validateOptions.fs || nodeFs;
  const platform = validateOptions.platform || process.platform;
  const isUsable = (candidate) => {
    if (typeof candidate !== "string" || !candidate) return false;
    try {
      if (platform === "win32") return fsImpl.existsSync(candidate);
      fsImpl.accessSync(candidate, nodeFs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  // First prefer a Node the env-owned commands/settings already evidence.
  for (const candidate of findManagedClaudeEnvNodeBinCandidates(settings)) {
    if (isUsable(candidate)) return candidate;
  }
  // #874: when env evidence names no usable Node (CLAWD_NODE_BIN missing, bare
  // `node`, or stale) but the host's normal resolver can still find a usable
  // absolute Node, treat the hook as migratable rather than stuck. The resolved
  // path is only used to CLASSIFY migratable here — it is never serialized; the
  // installer re-resolves and writes the absolute value during the actual repair.
  if (typeof resolveTrustedNodeCandidate === "function") {
    let trusted = null;
    try {
      trusted = resolveTrustedNodeCandidate();
    } catch {
      trusted = null;
    }
    if (isUsable(trusted)) return trusted;
  }
  return null;
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
      // When the whole persistent generation is known to be missing/corrupt,
      // every command pointing at its (expected) target is a consequence of
      // that one fault. Suppressing the per-command path-missing issue keeps
      // the repair signature stable between "generation dir deleted" and
      // "generation present but corrupt", so the 3-strike counter does not
      // reset just because the same repair deletes then recreates files.
      if (
        validateOptions.suppressTargetGenerationConsequences === true
        && scriptPathMatchesExpected(result.scriptPath, expectedScriptPath, validateOptions.platform)
      ) {
        continue;
      }
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
 * @param {string} [options.expectedHookScriptPath] — persistent command target
 *   (AppImage generation in AppImage mode; source script in direct mode)
 * @param {string} [options.expectedAutoStartScriptPath] — persistent command
 *   target for the auto-start entry
 * @param {string} [options.sourceHookScriptPath] — packaged source script that
 *   a repair could rebuild from. Defaults to expectedHookScriptPath.
 * @param {string} [options.sourceAutoStartScriptPath] — packaged source
 *   auto-start script. Defaults to expectedAutoStartScriptPath.
 * @param {{ ok: boolean }} [options.targetGeneration] — byte-verified
 *   completeness of the persistent generation. `ok:false` is a repairable
 *   target-generation-missing issue even when the entry files still exist.
 * @param {boolean} [options.requireAutoStart]
 * @param {string[]} [options.coreEvents]
 * @param {string} [options.platform]
 * @param {object} [options.fs] — injected fs (existsSync at minimum)
 * @param {() => (string|null)} [options.resolveTrustedNodeCandidate] — returns a
 *   host-resolved absolute Node path (or null) used ONLY to classify an
 *   env-indirected hook as migratable when env evidence names no usable Node.
 *   Must be cheap/spawn-free per call; the caller is responsible for memoizing.
 */
function inspectClaudeHookHealth(rawSettings, options = {}) {
  const platform = options.platform || process.platform;
  const fsImpl = options.fs;
  const coreEvents = Array.isArray(options.coreEvents) ? options.coreEvents : [];
  const expectedPermissionUrl = options.expectedPermissionUrl || null;
  const expectedHookScriptPath = options.expectedHookScriptPath || null;
  const expectedAutoStartScriptPath = options.expectedAutoStartScriptPath || null;
  // Source is what a repair would rebuild FROM; target is what settings should
  // point AT. They differ only in AppImage mode. Callers that don't split them
  // keep the historical behavior (source === target).
  const sourceHookScriptPath = options.sourceHookScriptPath || expectedHookScriptPath;
  const sourceAutoStartScriptPath = options.sourceAutoStartScriptPath || expectedAutoStartScriptPath;
  const targetGeneration = options.targetGeneration || null;
  const requireAutoStart = !!options.requireAutoStart;
  const validateOptions = {
    platform,
    fs: fsImpl,
    suppressTargetGenerationConsequences: !!(targetGeneration && targetGeneration.ok === false),
  };

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
    parsed = JSON.parse(stripUtf8Bom(rawSettings));
  } catch {
    return unreadable();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return unreadable();

  // The currently-installed SOURCE script is a hard precondition for every
  // repair this module can suggest. In AppImage mode the persistent target
  // generation can be rebuilt from this source; if the source itself is gone
  // (broken/partial install, mount vanished) no repair can succeed, so this
  // stays an unrepairable source-script-missing. Target-generation loss is a
  // separate, repairable signal below.
  // When auto-start is required, its own source script is an equally hard
  // precondition.
  if (fsImpl && sourceHookScriptPath && !fsImpl.existsSync(sourceHookScriptPath)) {
    return {
      status: "source-script-missing",
      repairable: false,
      issues: [{ code: "source-script-missing", automaticRepairable: false }],
      commandCount: 0,
      managedCoreEventCount: 0,
      snapshot: null,
    };
  }
  if (fsImpl && requireAutoStart && sourceAutoStartScriptPath && !fsImpl.existsSync(sourceAutoStartScriptPath)) {
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
  let hasUnverifiedEnvIndirection = false;
  // Resolved lazily and memoized: only an actual ownership-proven env-indirected
  // hook (the branch below) needs to know whether a usable Node exists, and the
  // injected resolver may spawn a subprocess. A config with no env hook must
  // never trigger host-Node resolution.
  let envNodeCandidateResolved = false;
  let envNodeCandidate = null;
  const getUsableEnvNodeCandidate = () => {
    if (!envNodeCandidateResolved) {
      envNodeCandidateResolved = true;
      envNodeCandidate = findUsableEnvNodeCandidate(
        parsed,
        validateOptions,
        options.resolveTrustedNodeCandidate
      );
    }
    return envNodeCandidate;
  };

  for (const event of coreEvents) {
    const records = findManagedStateCommandRecords(parsed, event);
    commandCount += records.managed.length;
    for (const record of records.unverified) {
      hasUnverifiedEnvIndirection = true;
      pushIssue(issues, {
        code: "env-indirection-unverified",
        event,
        marker: HOOK_MARKER,
        automaticRepairable: false,
      });
    }
    if (!records.managed.length) {
      missingEvents.push(event);
      continue;
    }
    managedCoreEventCount++;
    const mutationOwnedCount = records.managed.filter((record) => record.mutationOwned).length;
    if (mutationOwnedCount > 1) {
      pushIssue(issues, {
        code: "duplicate-managed-state-hook",
        event,
        marker: HOOK_MARKER,
        count: mutationOwnedCount,
        automaticRepairable: true,
      });
    }
    for (const record of records.managed) {
      if (record.kind === "literal") {
        inspectEventCommands(
          [record.command],
          event,
          HOOK_MARKER,
          expectedHookScriptPath,
          validateOptions,
          issues,
          CORE_COMMAND_ISSUE_CODES
        );
        continue;
      }
      const migratable = !!getUsableEnvNodeCandidate();
      pushIssue(issues, {
        code: migratable ? "env-hook-migratable" : "env-hook-node-unresolved",
        event,
        marker: HOOK_MARKER,
        automaticRepairable: migratable,
      });
    }
  }

  if (coreEvents.length > 0 && managedCoreEventCount === 0 && !hasUnverifiedEnvIndirection) {
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

  // Byte-verified completeness of the persistent target generation. A
  // generation whose entry files exist but are truncated / wrong-content /
  // marker-mismatched passes every command check above, so this is the only
  // signal that the artifact itself needs rebuilding. Repairable: the watcher
  // re-runs the installer, which rematerializes from the still-present source.
  if (targetGeneration && targetGeneration.ok === false) {
    pushIssue(issues, {
      code: "target-generation-missing",
      marker: HOOK_MARKER,
      generationDir: targetGeneration.dir || null,
      automaticRepairable: true,
    });
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

const DEGRADED_DIAGNOSTICS = Object.freeze({
  "command-unparseable": Object.freeze({
    reason: "command-unparseable",
    message: "a Clawd-owned hook command could not be parsed; see Doctor for details",
  }),
  "env-hook-node-unresolved": Object.freeze({
    reason: "env-hook-node-unresolved",
    message: "an env-indirected Clawd hook was preserved because its absolute Node path could not be verified",
  }),
  "env-indirection-unverified": Object.freeze({
    reason: "env-indirection-unverified",
    message: "an env-indirected hook command could not be proven Clawd-owned from settings.env",
  }),
});

function getClaudeHookDegradedDiagnostic(report) {
  if (!report || !Array.isArray(report.issues)) return null;
  for (const issue of report.issues) {
    const diagnostic = issue && DEGRADED_DIAGNOSTICS[issue.code];
    if (diagnostic) return diagnostic;
  }
  return null;
}

/**
 * Whether an explicit Install/Fix write actually left the config genuinely
 * healthy, suitable for reporting a user-facing "ok" instead of blindly
 * trusting the installer's return value. Any unhealthy report fails this
 * stricter gate, including non-automatic issues such as a missing core event
 * or an unparseable Clawd-owned command.
 */
function isExplicitRepairVerified(report) {
  return !!report && report.status === "healthy";
}

module.exports = {
  inspectClaudeHookHealth,
  buildClaudeRepairSignature,
  hasNoAutomaticRepairWork,
  reportHasUnparseableCommand,
  getClaudeHookDegradedDiagnostic,
  isExplicitRepairVerified,
  CLAUDE_HOOK_MARKER: HOOK_MARKER,
  CLAUDE_AUTO_START_MARKER: AUTO_START_MARKER,
};
