"use strict";

const fs = require("fs");
const path = require("path");

const {
  isAgentEnabled,
  isAgentIntegrationInstalled,
  isAgentPermissionsEnabled,
} = require("../agent-gate");
const { getAgent } = require("../../agents/registry");
const { commandMatchesMarker, findHookCommands } = require("../../hooks/json-utils");
const { GEMINI_HOOK_EVENTS } = require("../../hooks/gemini-install");
const { ANTIGRAVITY_HOOK_EVENTS, HOOK_GROUP_ID: ANTIGRAVITY_HOOK_GROUP_ID } = require("../../hooks/antigravity-install");
const {
  hasUserPermissionHookInOtherFiles,
  hasUserPermissionHookInSettingsJson,
  isCopilotPermissionRegistrable,
} = require("../../hooks/copilot-install");
const {
  findKimiHookCommands,
  listClawdKimiHookEvents,
  normalizePermissionMode: normalizeKimiPermissionMode,
  KIMI_HOOK_EVENTS,
} = require("../../hooks/kimi-install");
const { parseTomlSections: parseCodewhaleTomlSections } = require("../../hooks/codewhale-install");
const { getAgentDescriptors } = require("./agent-descriptors");
const {
  commandContainsFragment,
  validateHookCommand,
  validateHookTarget,
} = require("./agent-node-bin-parser");
const { checkCodexHookTrust, checkCodexHooksFeature } = require("./codex-features-check");
const { inspectStableCodexHookCommand } = require("../../hooks/codex-install-utils");
const { validateOpencodeEntry } = require("./opencode-entry-validator");
const { validateOpenClawEntry } = require("./openclaw-entry-validator");
const { hasIncludeDirective } = require("../../hooks/openclaw-install");
const { inspectDeepSeekHarnessDiskSync } = require("../../hooks/dsh-install");

const REPAIRABLE_AGENT_STATUSES = new Set(["not-connected", "broken-path"]);
const GEMINI_HOOKS_DISABLED_DETAIL = "Gemini hooks are disabled in settings.json; Clawd preserves this user setting and will not receive hook events";
const ANTIGRAVITY_HOOKS_DISABLED_DETAIL = "Antigravity Clawd hooks are disabled in hooks.json; Clawd preserves this user setting and will not receive hook events";
const QWEN_HOOKS_DISABLED_DETAIL = "Qwen Code hooks are disabled in settings.json; Clawd preserves this user setting and will not receive hook events";

function dirExists(fsImpl, dirPath) {
  try {
    return fsImpl.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(fsImpl, filePath) {
  try {
    return fsImpl.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readJson(fsImpl, filePath) {
  // Strip the UTF-8 BOM (U+FEFF). PowerShell `Set-Content -Encoding utf8`
  // and some Notepad saves prepend it; Node's JSON.parse refuses to parse
  // a leading BOM. Without this, a user who hand-edits hooks.json in those
  // tools makes the doctor pane silently flip to config-corrupt while
  // installers (which already strip BOM) keep working — the mismatch makes
  // the offered Fix button useless because clicking it doesn't reproduce
  // the parse error path.
  let raw = fsImpl.readFileSync(filePath, "utf8");
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  return JSON.parse(raw);
}

// JSONC-aware sibling of readJson for descriptors with configJsonc: true
// (mimocode's ~/.config/mimocode/mimocode.jsonc). Comments and trailing
// commas are LEGAL there — parsing with bare JSON.parse would flip a healthy
// config to "config-corrupt". Genuinely broken files still throw, keeping
// the config-corrupt path meaningful. jsonc-parser is lazy-required so the
// doctor pays for it only when a JSONC agent is actually inspected.
function readJsonc(fsImpl, filePath) {
  let raw = fsImpl.readFileSync(filePath, "utf8");
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  // eslint-disable-next-line global-require
  const { parse } = require("jsonc-parser");
  const errors = [];
  const tree = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length) {
    throw new Error(`invalid JSONC (${errors.length} parse error${errors.length === 1 ? "" : "s"})`);
  }
  return tree;
}

function withAgentBubbleNote(detail, prefs, agentId) {
  // State-only agents (capabilities.permissionApproval === false) never
  // surface a Clawd bubble in the first place, so annotating them as
  // "permission bubbles disabled" would be misleading. Antigravity, Pi,
  // and OpenClaw are current examples.
  const agent = getAgent(agentId);
  if (agent && agent.capabilities && agent.capabilities.permissionApproval === false) {
    return detail;
  }
  if (!isAgentPermissionsEnabled(prefs, agentId)) {
    return {
      ...detail,
      permissionsEnabled: false,
      permissionBubbleDetail: "permission bubbles disabled for this agent",
    };
  }
  return detail;
}

function getClaudeHookGuardStatus(options) {
  const server = options && options.server;
  if (!server || typeof server.getClaudeHookGuardStatus !== "function") return null;
  try {
    return server.getClaudeHookGuardStatus();
  } catch {
    return null;
  }
}

function getClaudeHookHealthStatus(options) {
  const server = options && options.server;
  if (!server || typeof server.getClaudeHookHealthStatus !== "function") return null;
  try {
    return server.getClaudeHookHealthStatus();
  } catch {
    return null;
  }
}

// Explains *why* Claude Code's hook config hasn't self-healed, using the
// periodic health supervisor's runtime status (#657) — the disk inspector
// above remains the source of truth for whether it's currently broken; this
// only annotates that verdict. Covers not-connected, broken-path,
// source-script-missing, and manual-fix-required per the #657 plan §6.9.
function withClaudeHookGuardNotice(detail, descriptor, options) {
  if (descriptor.agentId !== "claude-code" || !detail) return detail;

  const runtimeHealth = getClaudeHookHealthStatus(options);
  const repairableDisk = REPAIRABLE_AGENT_STATUSES.has(detail.status);

  // Reconcile can never fix a missing source script, so this must never
  // offer a configuration Repair — overriding the status keeps it out of
  // REPAIRABLE_AGENT_STATUSES for the withAgentFixAction() check below.
  if (
    repairableDisk
    && runtimeHealth
    && runtimeHealth.status === "degraded"
    && runtimeHealth.degradedReason === "source-script-missing"
  ) {
    return {
      ...detail,
      status: "source-script-missing",
      level: "warning",
      detail: "The current Clawd installation's Claude hook script is missing. Reinstall or re-extract Clawd to restore automatic hook repair.",
      claudeHookRuntimeStatus: {
        status: runtimeHealth.status,
        degradedReason: runtimeHealth.degradedReason,
        at: runtimeHealth.at || null,
      },
    };
  }

  if (
    (repairableDisk || detail.status === "ok")
    &&
    runtimeHealth
    && runtimeHealth.status === "degraded"
    && (
      runtimeHealth.degradedReason === "env-hook-node-unresolved"
      || runtimeHealth.degradedReason === "env-indirection-unverified"
    )
  ) {
    const unresolvedNode = runtimeHealth.degradedReason === "env-hook-node-unresolved";
    return {
      ...detail,
      status: detail.status === "ok" ? "needs-review" : detail.status,
      level: "warning",
      detail: unresolvedNode
        ? "Clawd preserved an env-indirected Claude hook because settings.env does not provide a usable absolute Node path. Check CLAWD_NODE_BIN, then use Fix."
        : "Clawd found an env-indirected Claude hook but settings.env does not prove that it belongs to Clawd. Review CLAWD_HOOK_PATH before changing it.",
      claudeHookRuntimeStatus: {
        status: runtimeHealth.status,
        degradedReason: runtimeHealth.degradedReason,
        at: runtimeHealth.at || null,
      },
    };
  }

  if (!repairableDisk) return detail;

  const guard = getClaudeHookGuardStatus(options);
  if (guard && guard.type === "suspicious-shrink") {
    return {
      ...detail,
      detail: "Clawd paused automatic Claude hook repair after settings.json shrank during an external rewrite. Use Fix or restart Clawd to reinstall Clawd hooks.",
      claudeHookGuard: {
        type: guard.type,
        at: guard.at || null,
        before: guard.before || null,
        after: guard.after || null,
      },
    };
  }

  if (runtimeHealth && runtimeHealth.status === "guarded") {
    return {
      ...detail,
      detail: "Clawd paused automatic Claude hook repair because settings.json shrank suspiciously. Use Fix or restart Clawd to reinstall Clawd hooks.",
      claudeHookRuntimeStatus: {
        status: runtimeHealth.status,
        issueSignature: runtimeHealth.issueSignature || null,
        at: runtimeHealth.at || null,
      },
    };
  }

  if (runtimeHealth && runtimeHealth.status === "manual-fix-required") {
    return {
      ...detail,
      detail: "Clawd's automatic Claude hook repair failed 3 times in a row and stopped retrying. Use Fix to try once more, or check the hook script manually.",
      claudeHookRuntimeStatus: {
        status: runtimeHealth.status,
        issueSignature: runtimeHealth.issueSignature || null,
        attempt: runtimeHealth.attempt || null,
        message: runtimeHealth.message || null,
        at: runtimeHealth.at || null,
      },
    };
  }

  return detail;
}

// TraeCode carries an extra manual step beyond registering hooks.json: the
// hooks only fire after the user enables them inside Trae (Settings → Hooks)
// and picks a run mode — the IDE holds that switch in private storage Clawd
// cannot read. The check cannot detect it, so when the integration looks
// healthy we surface an informational note instead. Never masks a primary
// finding — the note only annotates an "ok" status.
function withTraeCodeEnableNotice(detail, descriptor) {
  if (descriptor.agentId !== "traecode" || !detail) return detail;
  if (detail.status !== "ok") return detail;
  const base = typeof detail.detail === "string" && detail.detail ? detail.detail : "TraeCode hooks registered";
  return {
    ...detail,
    detail: `${base}. Hooks only fire after enabling them in Trae: Settings → Hooks → Enable (run mode: Sandbox).`,
  };
}

function withAgentFixAction(detail, descriptor) {
  if (
    descriptor.agentId === "kimi-cli"
    && detail.status === "needs-review"
    && detail.supplementary
    && detail.supplementary.key === "kimi_legacy_mode"
  ) {
    // Stale legacy install (missing events / retired env-prefix mode /
    // missing --permission-mode flag): re-running the integration installer
    // strips and rewrites every Clawd block in the current canonical form.
    return { ...detail, fixAction: { type: "agent-integration", agentId: descriptor.agentId } };
  }
  if (!descriptor.autoInstall || !REPAIRABLE_AGENT_STATUSES.has(detail.status)) return detail;
  if (detail.supplementary && detail.supplementary.key === "hook_group") return detail;
  if (
    descriptor.agentId === "gemini-cli"
    && detail.supplementary
    && detail.supplementary.key === "gemini_hooks"
    && detail.supplementary.value !== "enabled"
  ) {
    return detail;
  }
  if (
    descriptor.agentId === "antigravity-cli"
    && detail.supplementary
    && detail.supplementary.key === "antigravity_hooks"
    && detail.supplementary.value !== "enabled"
  ) {
    return detail;
  }
  if (
    descriptor.agentId === "zcode"
    && detail.supplementary
    && detail.supplementary.key === "zcode_hooks"
    && detail.supplementary.value === "permission-conflict"
  ) {
    // A Fix would re-register Clawd's blocking hook next to the user's own
    // PermissionRequest hook — the exact last-wins override the conflict
    // report exists to prevent. Resolution is manual by design.
    return detail;
  }
  if (
    descriptor.agentId === "qwen-code"
    && detail.supplementary
    && detail.supplementary.key === "qwen_hooks"
    && detail.supplementary.value !== "enabled"
  ) {
    return detail;
  }
  if (
    descriptor.agentId === "zcode"
    && detail.supplementary
    && detail.supplementary.key === "zcode_hooks"
    && typeof detail.supplementary.value === "string"
    && detail.supplementary.value.startsWith("disabled")
  ) {
    // Both the master runner flag and per-hook enabled:false are explicit
    // ZCode user choices. Doctor may explain them, but Fix must not reactivate
    // hooks behind the user's back.
    return detail;
  }
  if (
    descriptor.agentId === "copilot-cli"
    && detail.supplementary
    && detail.supplementary.key === "copilot_hooks"
    && typeof detail.supplementary.value === "string"
    && (detail.supplementary.value.startsWith("disabled")
        || detail.supplementary.value === "permission-user-hook")
  ) {
    // disabled-*: user set disableAllHooks; Clawd must not override.
    // permission-user-hook: user (or a sibling *.json) owns permissionRequest;
    // running Fix would re-trigger the same safe-v1 skip — surface a warning
    // without a button so the user wires Clawd in manually if they want it.
    return detail;
  }
  const fixAction = { type: "agent-integration", agentId: descriptor.agentId };
  if (
    descriptor.agentId === "codex"
    && detail.supplementary
    && detail.supplementary.key === "hooks"
    && detail.supplementary.value === "disabled"
  ) {
    fixAction.forceCodexHooksFeature = true;
  }
  return {
    ...detail,
    fixAction,
  };
}

function makeDetail(descriptor, status, fields = {}) {
  return {
    agentId: descriptor.agentId,
    agentName: descriptor.agentName,
    eventSource: descriptor.eventSource,
    status,
    ...fields,
  };
}

function statusLevel(status) {
  if (
    status === "not-connected"
    || status === "broken-path"
    || status === "config-corrupt"
    || status === "needs-review"
  ) {
    return "warning";
  }
  return status === "ok" ? null : "info";
}

// codex resolves commandWindows on Windows and command on POSIX
// (openai/codex#22159). Since #544, a win32-authored hooks.json carries a
// WSL-interop form in `command` that is only executable inside WSL, so the
// doctor must validate the field THIS platform's codex would run — the
// generic findHookCommands (command only) would flag every dual-field
// Windows install as broken-path, and Repair would regenerate the same
// fields forever.
function resolveCodexPlatformCommand(hook, platform) {
  if (!hook || typeof hook !== "object") return null;
  const windowsVariant = typeof hook.commandWindows === "string" ? hook.commandWindows : null;
  const base = typeof hook.command === "string" ? hook.command : null;
  return platform === "win32" ? (windowsVariant || base) : base;
}

function findCodexPlatformHookCommands(settings, marker, platform) {
  if (!settings || !settings.hooks || typeof settings.hooks !== "object") return [];
  const commands = [];
  const push = (hook) => {
    const resolved = resolveCodexPlatformCommand(hook, platform);
    if (resolved && commandMatchesMarker(resolved, marker)) commands.push(resolved);
  };
  for (const entries of Object.values(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      if (Array.isArray(entry.hooks)) {
        for (const hook of entry.hooks) push(hook);
      }
      push(entry);
    }
  }
  return commands;
}

function validateCodexCommandList(descriptor, commands, options) {
  if (!commands.length) return validateCommandList(descriptor, commands, options);
  const results = commands.map((command) => {
    const stable = inspectStableCodexHookCommand(command, {
      platform: options.platform,
      fs: options.fs,
    });
    if (!stable.matched) {
      return options.validateCommand(command, { platform: options.platform, fs: options.fs });
    }
    if (!stable.ok) {
      return {
        ok: false,
        issue: stable.issue,
        scriptPath: stable.launcherPath || null,
      };
    }
    const result = options.validateTarget({
      nodeBin: stable.nodeBin,
      scriptPath: stable.scriptPath,
    }, {
      platform: options.platform,
      fs: options.fs,
      requireNodeExecutable: true,
    });
    return { ...result, stableExecution: result.ok === true };
  });
  const ok = results.find((result) => result.ok);
  if (ok) {
    return makeDetail(descriptor, "ok", {
      level: null,
      detail: ok.stableExecution
        ? `${descriptor.configPath} hook registered, stable execution target verified`
        : `${descriptor.configPath} hook registered, scriptPath verified`,
      commandCount: commands.length,
      scriptPath: ok.scriptPath,
    });
  }
  const first = results[0] || { issue: "parse-failed" };
  return makeDetail(descriptor, "broken-path", {
    level: "warning",
    detail: `hook command failed validation: ${first.issue}`,
    hookCommandIssue: first.issue || "parse-failed",
    nodeBin: first.nodeBin || null,
    scriptPath: first.scriptPath || null,
    commandFragment: String(commands[0] || "").slice(0, 128),
  });
}

function validateCommandList(descriptor, commands, options) {
  if (!commands.length) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      detail: `${descriptor.configPath} has no ${descriptor.marker} command`,
    });
  }

  const results = commands.map((command) => options.validateCommand(command, {
    platform: options.platform,
    fs: options.fs,
  }));
  const ok = results.find((result) => result.ok);
  if (ok) {
    return makeDetail(descriptor, "ok", {
      level: null,
      detail: `${descriptor.configPath} hook registered, scriptPath verified`,
      commandCount: commands.length,
      scriptPath: ok.scriptPath,
    });
  }

  const first = results[0] || { issue: "parse-failed" };
  return makeDetail(descriptor, "broken-path", {
    level: "warning",
    detail: `hook command failed validation: ${first.issue}`,
    hookCommandIssue: first.issue || "parse-failed",
    nodeBin: first.nodeBin || null,
    scriptPath: first.scriptPath || null,
    commandFragment: first.fragment || String(commands[0] || "").slice(0, 128),
  });
}

function findHookCommandsForEvent(settings, eventName, marker, options) {
  if (!settings || !settings.hooks || typeof marker !== "string" || !marker) return [];
  // Most agents keep per-event arrays directly under settings.hooks.<Event>
  // (the Claude Code / Qwen settings.json schema). ZCode config-file hooks nest
  // one level deeper under settings.hooks.events.<Event>; descriptor.hookEventsContainer
  // selects the container path (defaults to ["hooks"]).
  const containerPath = (options && Array.isArray(options.hookEventsContainer) && options.hookEventsContainer.length)
    ? options.hookEventsContainer
    : ["hooks"];
  let container = settings;
  for (const key of containerPath) {
    if (!container || typeof container !== "object") return [];
    container = container[key];
  }
  const entries = container ? container[eventName] : null;
  if (!Array.isArray(entries)) return [];

  const nested = options && options.nested;
  const commands = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (nested && Array.isArray(entry.hooks)) {
      for (const hook of entry.hooks) {
        if (hook && typeof hook.command === "string" && commandContainsFragment(hook.command, marker)) {
          commands.push(hook.command);
        }
      }
    }
    if (typeof entry.command === "string" && commandContainsFragment(entry.command, marker)) {
      commands.push(entry.command);
    }
  }
  return commands;
}

function zcodeHookContainsMarker(hook, marker) {
  if (!hook || typeof hook !== "object") return false;
  if (
    typeof hook.command === "string"
    && commandContainsFragment(hook.command, marker)
  ) {
    return true;
  }
  return !!(
    Array.isArray(hook.args)
    && hook.args.some((arg) => typeof arg === "string" && arg.includes(marker))
  );
}

function findZcodeHooksForEvent(settings, eventName, marker, options) {
  if (!settings || !settings.hooks || typeof marker !== "string" || !marker) return [];
  const containerPath = (
    options
    && Array.isArray(options.hookEventsContainer)
    && options.hookEventsContainer.length
  )
    ? options.hookEventsContainer
    : ["hooks", "events"];
  let container = settings;
  for (const key of containerPath) {
    if (!container || typeof container !== "object") return [];
    container = container[key];
  }
  const entries = container ? container[eventName] : null;
  if (!Array.isArray(entries)) return [];

  const hooks = [];
  const push = (hook) => {
    if (!zcodeHookContainsMarker(hook, marker)) return;
    if (
      hook.type === "process"
      && typeof hook.command === "string"
      && Array.isArray(hook.args)
    ) {
      const scriptPath = hook.args.find((arg) => typeof arg === "string" && arg.includes(marker));
      hooks.push({
        kind: "process",
        nodeBin: hook.command,
        scriptPath,
        args: hook.args,
        timeoutMs: hook.timeoutMs,
        fragment: JSON.stringify({
          type: hook.type,
          command: hook.command,
          args: hook.args,
          timeoutMs: hook.timeoutMs,
        }).slice(0, 128),
      });
      return;
    }
    if (typeof hook.command === "string") {
      hooks.push({
        kind: "command",
        command: hook.command,
        fragment: hook.command.slice(0, 128),
      });
    }
  };

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (Array.isArray(entry.hooks)) {
      for (const hook of entry.hooks) push(hook);
    }
    push(entry);
  }
  return hooks;
}

function validateZcodeProcessHook(hook, eventName, descriptor, options) {
  const args = hook.args;
  // Timeouts are per-event (PermissionRequest blocks on the bubble at 600s,
  // state events stay at 8s), so the zcode descriptor carries a resolver
  // (processHookTimeoutMsForEvent) instead of a single value.
  const expectedTimeoutMs = descriptor.processHookTimeoutMsForEvent(eventName);
  if (
    !Array.isArray(args)
    || args.length !== 2
    || typeof args[0] !== "string"
    || !args[0].includes(descriptor.marker)
    || args[1] !== eventName
    || hook.timeoutMs !== expectedTimeoutMs
  ) {
    return {
      ok: false,
      issue: "process-shape-invalid",
      nodeBin: hook.nodeBin || null,
      scriptPath: hook.scriptPath || null,
    };
  }
  return options.validateTarget({
    nodeBin: hook.nodeBin,
    scriptPath: hook.scriptPath,
  }, {
    platform: options.platform,
    fs: options.fs,
    requireAbsoluteNode: true,
    requireNodeExecutable: true,
  });
}

function validateZcodeHookEvents(descriptor, settings, options) {
  const events = descriptor.hookEvents;
  const agentName = descriptor.agentName || descriptor.agentId;
  const missingEvents = [];
  let commandCount = 0;
  let firstOk = null;
  let firstFailure = null;

  for (const eventName of events) {
    const hooks = findZcodeHooksForEvent(settings, eventName, descriptor.marker, {
      hookEventsContainer: descriptor.hookEventsContainer,
    });
    commandCount += hooks.length;
    if (!hooks.length) {
      missingEvents.push(eventName);
      continue;
    }
    const results = hooks.map((hook) => (
      hook.kind === "process"
        ? validateZcodeProcessHook(hook, eventName, descriptor, options)
        : options.validateCommand(hook.command, {
          platform: options.platform,
          fs: options.fs,
        })
    ));
    const ok = results.find((result) => result.ok);
    if (ok) {
      if (!firstOk) firstOk = ok;
      continue;
    }
    if (!firstFailure) {
      firstFailure = {
        eventName,
        result: results[0] || { issue: "parse-failed" },
        hook: hooks[0],
      };
    }
  }

  if (missingEvents.length) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      detail: `${descriptor.configPath} missing ${agentName} hook event(s): ${missingEvents.join(", ")}`,
      commandCount,
      missingHookEvents: missingEvents,
    });
  }
  if (firstFailure) {
    const first = firstFailure.result;
    return makeDetail(descriptor, "broken-path", {
      level: "warning",
      detail: `${agentName} hook command failed validation for ${firstFailure.eventName}: ${first.issue || "parse-failed"}`,
      commandCount,
      hookCommandIssue: first.issue || "parse-failed",
      nodeBin: first.nodeBin || null,
      scriptPath: first.scriptPath || null,
      commandFragment: first.fragment || firstFailure.hook.fragment,
      brokenHookEvent: firstFailure.eventName,
    });
  }
  return makeDetail(descriptor, "ok", {
    level: null,
    detail: `${descriptor.configPath} ${agentName} hooks registered for ${events.length} events, scriptPath verified`,
    commandCount,
    scriptPath: firstOk && firstOk.scriptPath ? firstOk.scriptPath : null,
  });
}

function validateGeminiHookEvents(descriptor, settings, options) {
  const missingEvents = [];
  let commandCount = 0;
  let firstOk = null;
  let firstFailure = null;

  for (const eventName of GEMINI_HOOK_EVENTS) {
    const commands = findHookCommandsForEvent(settings, eventName, descriptor.marker, {
      nested: !!descriptor.nested,
      hookEventsContainer: descriptor.hookEventsContainer,
    });
    commandCount += commands.length;
    if (!commands.length) {
      missingEvents.push(eventName);
      continue;
    }

    const results = commands.map((command) => options.validateCommand(command, {
      platform: options.platform,
      fs: options.fs,
    }));
    const ok = results.find((result) => result.ok);
    if (ok) {
      if (!firstOk) firstOk = ok;
      continue;
    }
    if (!firstFailure) {
      firstFailure = {
        eventName,
        result: results[0] || { issue: "parse-failed" },
        command: commands[0],
      };
    }
  }

  if (missingEvents.length) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      detail: `${descriptor.configPath} missing Gemini hook event(s): ${missingEvents.join(", ")}`,
      commandCount,
      missingGeminiHookEvents: missingEvents,
    });
  }

  if (firstFailure) {
    const first = firstFailure.result;
    return makeDetail(descriptor, "broken-path", {
      level: "warning",
      detail: `Gemini hook command failed validation for ${firstFailure.eventName}: ${first.issue || "parse-failed"}`,
      commandCount,
      hookCommandIssue: first.issue || "parse-failed",
      nodeBin: first.nodeBin || null,
      scriptPath: first.scriptPath || null,
      commandFragment: first.fragment || String(firstFailure.command || "").slice(0, 128),
      brokenGeminiHookEvent: firstFailure.eventName,
    });
  }

  return makeDetail(descriptor, "ok", {
    level: null,
    detail: `${descriptor.configPath} Gemini hooks registered for ${GEMINI_HOOK_EVENTS.length} events, scriptPath verified`,
    commandCount,
    scriptPath: firstOk && firstOk.scriptPath ? firstOk.scriptPath : null,
  });
}

function validateFileHookEvents(descriptor, settings, options) {
  const events = descriptor.hookEvents;
  const agentName = descriptor.agentName || descriptor.agentId;
  const missingKey = descriptor.agentId === "qwen-code" ? "missingQwenHookEvents" : "missingHookEvents";
  const brokenKey = descriptor.agentId === "qwen-code" ? "brokenQwenHookEvent" : "brokenHookEvent";
  const missingEvents = [];
  let commandCount = 0;
  let firstOk = null;
  let firstFailure = null;

  for (const eventName of events) {
    const commands = findHookCommandsForEvent(settings, eventName, descriptor.marker, {
      nested: !!descriptor.nested,
      hookEventsContainer: descriptor.hookEventsContainer,
    });
    commandCount += commands.length;
    if (!commands.length) {
      missingEvents.push(eventName);
      continue;
    }

    const results = commands.map((command) => options.validateCommand(command, {
      platform: options.platform,
      fs: options.fs,
    }));
    const ok = results.find((result) => result.ok);
    if (ok) {
      if (!firstOk) firstOk = ok;
      continue;
    }
    if (!firstFailure) {
      firstFailure = {
        eventName,
        result: results[0] || { issue: "parse-failed" },
        command: commands[0],
      };
    }
  }

  if (missingEvents.length) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      detail: `${descriptor.configPath} missing ${agentName} hook event(s): ${missingEvents.join(", ")}`,
      commandCount,
      [missingKey]: missingEvents,
    });
  }

  if (firstFailure) {
    const first = firstFailure.result;
    return makeDetail(descriptor, "broken-path", {
      level: "warning",
      detail: `${agentName} hook command failed validation for ${firstFailure.eventName}: ${first.issue || "parse-failed"}`,
      commandCount,
      hookCommandIssue: first.issue || "parse-failed",
      nodeBin: first.nodeBin || null,
      scriptPath: first.scriptPath || null,
      commandFragment: first.fragment || String(firstFailure.command || "").slice(0, 128),
      [brokenKey]: firstFailure.eventName,
    });
  }

  return makeDetail(descriptor, "ok", {
    level: null,
    detail: `${descriptor.configPath} ${agentName} hooks registered for ${events.length} events, scriptPath verified`,
    commandCount,
    scriptPath: firstOk && firstOk.scriptPath ? firstOk.scriptPath : null,
  });
}

// Copilot CLI's hooks.json entries store the command in per-platform `bash` /
// `powershell` fields (not the single `command` field used by Claude/Cursor/
// Gemini). Generic findHookCommandsForEvent would miss them, so scan all three
// fields and let the validator decide which is platform-appropriate.
function findCopilotHookCommandsForEvent(settings, eventName, marker) {
  if (!settings || !settings.hooks || typeof marker !== "string" || !marker) return [];
  const entries = settings.hooks[eventName];
  if (!Array.isArray(entries)) return [];
  const commands = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    for (const field of ["bash", "powershell", "command"]) {
      const cmd = entry[field];
      if (typeof cmd === "string" && commandContainsFragment(cmd, marker)) {
        commands.push(cmd);
      }
    }
  }
  return commands;
}

function validateCopilotHookEvents(descriptor, settings, settingsJson, options) {
  // disableAllHooks short-circuit — check both hooks.json (file-scoped) and
  // settings.json (global). Either being true means hooks won't run.
  if (settings && settings.disableAllHooks === true) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      detail: `${descriptor.configPath} has disableAllHooks=true; Clawd hooks will not run`,
      supplementary: { key: "copilot_hooks", value: "disabled-file" },
    });
  }
  if (settingsJson && settingsJson.disableAllHooks === true) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      detail: `${descriptor.settingsPath || "settings.json"} has disableAllHooks=true; Clawd hooks will not run`,
      supplementary: { key: "copilot_hooks", value: "disabled-global" },
    });
  }

  // Safe-v1 cross-file check. Mirrors hooks/copilot-install.js so the
  // installer's silent skip is visible to the user via the doctor pane:
  //   - in-file: another (non-Clawd) entry in hooks.json's permissionRequest
  //   - cross-file: any sibling *.json in the same hooks/ dir declares the event
  // When triggered, permissionRequest is removed from the per-event validation
  // pass and the result is annotated with `permission-user-hook`. The Fix
  // button is suppressed at attachFixAction() so the user cannot trigger an
  // install that the installer itself will reject. Without this layer the
  // doctor reports "missing permissionRequest" and offers a Fix that never
  // does anything.
  const inFileArr = (settings && settings.hooks && Array.isArray(settings.hooks.permissionRequest))
    ? settings.hooks.permissionRequest
    : [];
  const hasInFileUserHook = !isCopilotPermissionRegistrable(inFileArr);
  const hooksDirForScan = descriptor.configPath
    ? require("path").dirname(descriptor.configPath)
    : null;
  const hasCrossFileUserHook = hooksDirForScan
    ? hasUserPermissionHookInOtherFiles(hooksDirForScan, descriptor.configPath, { fs: options.fs })
    : false;
  // settings.json inline `hooks` block also merges into Copilot's hook chain.
  // Doctor only covers installer-time signals here — repo-level
  // .github/hooks/*.json is checked at request time by copilot-hook.js.
  const hasInlineSettingsHook = descriptor.settingsPath
    ? hasUserPermissionHookInSettingsJson(descriptor.settingsPath, { fs: options.fs })
    : false;
  const permissionOwnedByUser = hasInFileUserHook || hasCrossFileUserHook || hasInlineSettingsHook;

  const events = (Array.isArray(descriptor.hookEvents) ? descriptor.hookEvents : [])
    .filter((e) => !(permissionOwnedByUser && e === "permissionRequest"));
  const missingEvents = [];
  let commandCount = 0;
  let firstOk = null;
  let firstFailure = null;

  for (const eventName of events) {
    const commands = findCopilotHookCommandsForEvent(settings, eventName, descriptor.marker);
    commandCount += commands.length;
    if (!commands.length) {
      missingEvents.push(eventName);
      continue;
    }

    const results = commands.map((command) => options.validateCommand(command, {
      platform: options.platform,
      fs: options.fs,
    }));
    const ok = results.find((result) => result.ok);
    if (ok) {
      if (!firstOk) firstOk = ok;
      continue;
    }
    if (!firstFailure) {
      firstFailure = {
        eventName,
        result: results[0] || { issue: "parse-failed" },
        command: commands[0],
      };
    }
  }

  if (missingEvents.length) {
    const detail = {
      level: "warning",
      detail: `${descriptor.configPath} missing Copilot hook event(s): ${missingEvents.join(", ")}`,
      commandCount,
      missingCopilotHookEvents: missingEvents,
    };
    if (permissionOwnedByUser) {
      detail.supplementary = { key: "copilot_hooks", value: "permission-user-hook" };
      detail.permissionUserHook = true;
    }
    return makeDetail(descriptor, "not-connected", detail);
  }

  if (firstFailure) {
    const first = firstFailure.result;
    return makeDetail(descriptor, "broken-path", {
      level: "warning",
      detail: `Copilot hook command failed validation for ${firstFailure.eventName}: ${first.issue || "parse-failed"}`,
      commandCount,
      hookCommandIssue: first.issue || "parse-failed",
      nodeBin: first.nodeBin || null,
      scriptPath: first.scriptPath || null,
      commandFragment: first.fragment || String(firstFailure.command || "").slice(0, 128),
      brokenCopilotHookEvent: firstFailure.eventName,
    });
  }

  if (permissionOwnedByUser) {
    return makeDetail(descriptor, "ok", {
      level: "warning",
      detail: `${descriptor.configPath} Copilot state hooks registered; permissionRequest left to user hook`,
      commandCount,
      scriptPath: firstOk && firstOk.scriptPath ? firstOk.scriptPath : null,
      supplementary: { key: "copilot_hooks", value: "permission-user-hook" },
      permissionUserHook: true,
    });
  }

  return makeDetail(descriptor, "ok", {
    level: null,
    detail: `${descriptor.configPath} Copilot hooks registered for ${events.length} events, scriptPath verified`,
    commandCount,
    scriptPath: firstOk && firstOk.scriptPath ? firstOk.scriptPath : null,
  });
}

function findAntigravityHookCommandsForEvent(settings, eventName, marker) {
  if (!settings || typeof settings !== "object" || typeof marker !== "string" || !marker) return [];
  const commands = [];

  for (const hookGroup of Object.values(settings)) {
    if (!hookGroup || typeof hookGroup !== "object") continue;
    const entries = hookGroup[eventName];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.command === "string" && commandContainsFragment(entry.command, marker)) {
        commands.push(entry.command);
      }
      if (!Array.isArray(entry.hooks)) continue;
      for (const hook of entry.hooks) {
        if (hook && typeof hook.command === "string" && commandContainsFragment(hook.command, marker)) {
          commands.push(hook.command);
        }
      }
    }
  }

  return commands;
}

function validateAntigravityHookEvents(descriptor, settings, options) {
  const events = Array.isArray(descriptor.hookEvents) ? descriptor.hookEvents : ANTIGRAVITY_HOOK_EVENTS;
  const missingEvents = [];
  let commandCount = 0;
  let firstOk = null;
  let firstFailure = null;

  for (const eventName of events) {
    const commands = findAntigravityHookCommandsForEvent(settings, eventName, descriptor.marker);
    commandCount += commands.length;
    if (!commands.length) {
      missingEvents.push(eventName);
      continue;
    }

    const results = commands.map((command) => options.validateCommand(command, {
      platform: options.platform,
      fs: options.fs,
    }));
    const ok = results.find((result) => result.ok);
    if (ok) {
      if (!firstOk) firstOk = ok;
      continue;
    }
    if (!firstFailure) {
      firstFailure = {
        eventName,
        result: results[0] || { issue: "parse-failed" },
        command: commands[0],
      };
    }
  }

  if (missingEvents.length) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      detail: `${descriptor.configPath} missing Antigravity hook event(s): ${missingEvents.join(", ")}`,
      commandCount,
      missingAntigravityHookEvents: missingEvents,
    });
  }

  if (firstFailure) {
    const first = firstFailure.result;
    return makeDetail(descriptor, "broken-path", {
      level: "warning",
      detail: `Antigravity hook command failed validation for ${firstFailure.eventName}: ${first.issue || "parse-failed"}`,
      commandCount,
      hookCommandIssue: first.issue || "parse-failed",
      nodeBin: first.nodeBin || null,
      scriptPath: first.scriptPath || null,
      commandFragment: first.fragment || String(firstFailure.command || "").slice(0, 128),
      brokenAntigravityHookEvent: firstFailure.eventName,
    });
  }

  return makeDetail(descriptor, "ok", {
    level: null,
    detail: `${descriptor.configPath} Antigravity hooks registered for ${events.length} events, scriptPath verified`,
    commandCount,
    scriptPath: firstOk && firstOk.scriptPath ? firstOk.scriptPath : null,
  });
}

function applyCodexSupplementary(detail, descriptor, options, settings) {
  if (!descriptor.supplementary || descriptor.supplementary.key !== "hooks") return detail;

  const supplementary = checkCodexHooksFeature(descriptor.supplementary.configPath, { fs: options.fs });
  if (
    supplementary.value === "disabled"
    && (detail.status === "ok" || REPAIRABLE_AGENT_STATUSES.has(detail.status))
  ) {
    return {
      ...detail,
      status: "not-connected",
      level: "warning",
      supplementary: {
        key: "hooks",
        value: supplementary.value,
        detail: supplementary.detail,
      },
      detail: "Codex hooks feature is disabled",
    };
  }
  if (detail.status !== "ok") return detail;
  const codexHookTrust = checkCodexHookTrust(
    descriptor.supplementary.configPath,
    settings,
    descriptor.configPath,
    {
      fs: options.fs,
      marker: descriptor.marker,
      platform: options.platform,
    }
  );
  const next = {
    ...detail,
    supplementary: {
      key: "hooks",
      value: supplementary.value,
      detail: supplementary.detail,
    },
    codexHookTrust,
  };
  if (codexHookTrust.value === "needs-review") {
    return {
      ...next,
      status: "needs-review",
      level: "warning",
      detail: "Codex hooks are installed but need review in Codex /hooks before they can run",
    };
  }
  return next;
}

function getGeminiHooksSupplementary(settings, descriptor) {
  const hooksConfig = settings && typeof settings === "object" ? settings.hooksConfig : null;
  if (!hooksConfig || typeof hooksConfig !== "object") {
    return {
      key: "gemini_hooks",
      value: "enabled",
      detail: "hooksConfig allows Clawd Gemini hooks",
    };
  }

  if (hooksConfig.enabled === false) {
    return {
      key: "gemini_hooks",
      value: "disabled-global",
      detail: "hooksConfig.enabled is false",
    };
  }

  const disabled = Array.isArray(hooksConfig.disabled) ? hooksConfig.disabled : [];
  if (disabled.includes("clawd")) {
    return {
      key: "gemini_hooks",
      value: "disabled-clawd",
      detail: 'hooksConfig.disabled includes "clawd"',
    };
  }

  return {
    key: "gemini_hooks",
    value: "enabled",
    detail: "hooksConfig allows Clawd Gemini hooks",
  };
}

function applyGeminiSupplementary(detail, descriptor, settings) {
  if (descriptor.agentId !== "gemini-cli") return detail;

  const supplementary = getGeminiHooksSupplementary(settings, descriptor);
  if (supplementary.value !== "enabled") {
    return {
      ...detail,
      status: "not-connected",
      level: "warning",
      detail: GEMINI_HOOKS_DISABLED_DETAIL,
      supplementary,
    };
  }
  return {
    ...detail,
    supplementary,
  };
}

function applyDisabledHookGroup(detail, descriptor, settings) {
  if (!descriptor.hookGroupId) return detail;
  const hooksConfig = settings && typeof settings === "object" ? settings.hooksConfig : null;
  if (!hooksConfig || typeof hooksConfig !== "object") return detail;

  let supplementary = null;
  if (hooksConfig.enabled === false) {
    supplementary = {
      key: "hook_group",
      value: "disabled-global",
      detail: "hooksConfig.enabled is false",
    };
  } else if (Array.isArray(hooksConfig.disabled) && hooksConfig.disabled.includes(descriptor.hookGroupId)) {
    supplementary = {
      key: "hook_group",
      value: `disabled-${descriptor.hookGroupId}`,
      detail: `hooksConfig.disabled includes "${descriptor.hookGroupId}"`,
    };
  }
  if (!supplementary) return detail;
  return {
    ...detail,
    status: "not-connected",
    level: "warning",
    detail: `${descriptor.agentName} hooks are disabled in settings.json; Clawd preserves this user setting and will not receive hook events`,
    supplementary,
  };
}

function getQwenHooksSupplementary(settings) {
  if (settings && typeof settings === "object" && settings.disableAllHooks === true) {
    return {
      key: "qwen_hooks",
      value: "disabled-global",
      detail: "disableAllHooks is true",
    };
  }
  return {
    key: "qwen_hooks",
    value: "enabled",
    detail: "settings.json allows Clawd Qwen hooks",
  };
}

function applyQwenSupplementary(detail, descriptor, settings) {
  if (descriptor.agentId !== "qwen-code") return detail;

  const supplementary = getQwenHooksSupplementary(settings);
  if (supplementary.value !== "enabled") {
    return {
      ...detail,
      status: "not-connected",
      level: "warning",
      detail: QWEN_HOOKS_DISABLED_DETAIL,
      supplementary,
    };
  }
  return {
    ...detail,
    supplementary,
  };
}

function getZcodeHooksSupplementary(settings, descriptor) {
  const hooks = settings && typeof settings === "object" ? settings.hooks : null;
  if (!hooks || typeof hooks !== "object" || hooks.enabled !== true) {
    if (hooks && hooks.enabled === false) {
      return {
        key: "zcode_hooks",
        value: "disabled-global",
        detail: "hooks.enabled is false",
      };
    }
    return {
      key: "zcode_hooks",
      value: "needs-enable",
      detail: "hooks.enabled must be true for config-file hooks",
    };
  }

  const events = hooks.events && typeof hooks.events === "object" ? hooks.events : {};
  const disabledEvents = [];
  const invalidWrapperEvents = [];
  for (const eventName of descriptor.hookEvents || []) {
    const entries = Array.isArray(events[eventName]) ? events[eventName] : [];
    let managedCount = 0;
    let activeCount = 0;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      // Flat command entries are legacy/invalid for current ZCode, but the
      // generic validator still reports their path issue. Do not interpret an
      // unsupported entry-level enabled flag as a valid user opt-out.
      if (
        zcodeHookContainsMarker(entry, descriptor.marker)
      ) {
        managedCount++;
        activeCount++;
        invalidWrapperEvents.push(eventName);
      }
      if (!Array.isArray(entry.hooks)) continue;
      const managedNestedHooks = entry.hooks.filter((hook) => (
        zcodeHookContainsMarker(hook, descriptor.marker)
      ));
      if (
        managedNestedHooks.length > 0
        && Object.keys(entry).some((key) => key !== "matcher" && key !== "hooks")
      ) {
        invalidWrapperEvents.push(eventName);
      }
      for (const hook of managedNestedHooks) {
        managedCount++;
        if (hook.enabled !== false) activeCount++;
        const allowedFields = hook.type === "process"
          ? new Set(["type", "command", "args", "enabled", "timeoutMs"])
          : new Set(["type", "command", "shell", "async", "enabled", "timeout", "timeoutMs"]);
        if (Object.keys(hook).some((key) => !allowedFields.has(key))) {
          invalidWrapperEvents.push(eventName);
        }
      }
    }
    if (managedCount > 0 && activeCount === 0) disabledEvents.push(eventName);
  }

  if (disabledEvents.length > 0) {
    // Order is intentional: explicit user opt-outs (enabled=false) are
    // reported before a foreign PermissionRequest conflict — under a full
    // opt-out Clawd's own hooks (the would-be conflicting side) are inactive,
    // so the disabled-events report is the actionable one.
    return {
      key: "zcode_hooks",
      value: "disabled-events",
      detail: `Clawd hooks have enabled=false for: ${disabledEvents.join(", ")}`,
      disabledEvents,
    };
  }
  if (invalidWrapperEvents.length > 0) {
    const uniqueEvents = [...new Set(invalidWrapperEvents)];
    return {
      key: "zcode_hooks",
      value: "invalid-wrapper",
      detail: `Clawd hook wrapper has unsupported fields for: ${uniqueEvents.join(", ")}`,
      invalidWrapperEvents: uniqueEvents,
    };
  }

  // Foreign PermissionRequest conflict (mirrors the installer gate in
  // hooks/zcode-install.js): ZCode runs same-event hooks serially with
  // last-wins decisions, so a non-Clawd hook owning PermissionRequest means
  // Clawd's blocking hook must stay unregistered — and a Fix that silently
  // created the overlap would let one hook override the other's deny.
  const permissionEntries = Array.isArray(events.PermissionRequest) ? events.PermissionRequest : [];
  let foreignPermissionHook = false;
  let managedPermissionHook = false;
  for (const entry of permissionEntries) {
    if (!entry || typeof entry !== "object") continue;
    if (zcodeHookContainsMarker(entry, descriptor.marker)) managedPermissionHook = true;
    else if (typeof entry.command === "string") foreignPermissionHook = true;
    if (!Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (!hook || typeof hook !== "object") continue;
      if (zcodeHookContainsMarker(hook, descriptor.marker)) managedPermissionHook = true;
      // Mirror hooks/zcode-install.js exactly: any nested non-Clawd object is
      // a foreign owner. Limiting this to command hooks makes Doctor offer a
      // Fix that the installer can never complete for imported HTTP entries.
      else foreignPermissionHook = true;
    }
  }
  if (foreignPermissionHook) {
    return {
      key: "zcode_hooks",
      value: "permission-conflict",
      detail: managedPermissionHook
        ? "a foreign PermissionRequest hook coexists with Clawd's; ZCode executes same-event hooks with last-wins decisions — keep exactly one owner for PermissionRequest"
        : "a foreign PermissionRequest hook owns the event; Clawd's blocking permission hook is intentionally not registered (last-wins would override the existing hook's deny)",
    };
  }

  return {
    key: "zcode_hooks",
    value: "enabled",
    detail: "config.json allows Clawd ZCode hooks",
  };
}

function applyZcodeSupplementary(detail, descriptor, settings) {
  if (descriptor.agentId !== "zcode") return detail;

  const supplementary = getZcodeHooksSupplementary(settings, descriptor);
  if (supplementary.value === "disabled-global") {
    return {
      ...detail,
      status: "not-connected",
      level: "warning",
      detail: "ZCode config-file hooks are disabled globally; Clawd preserves hooks.enabled=false and will not receive hook events",
      supplementary,
    };
  }
  if (supplementary.value === "disabled-events") {
    return {
      ...detail,
      status: "not-connected",
      level: "warning",
      detail: `Clawd ZCode hooks are disabled for ${supplementary.disabledEvents.join(", ")}; Clawd preserves each enabled=false setting`,
      supplementary,
    };
  }
  if (supplementary.value === "needs-enable") {
    return {
      ...detail,
      status: "not-connected",
      level: "warning",
      detail: "ZCode config-file hooks require hooks.enabled=true before Clawd can receive events",
      supplementary,
    };
  }
  if (supplementary.value === "invalid-wrapper") {
    return {
      ...detail,
      status: "not-connected",
      level: "warning",
      detail: `ZCode rejected unsupported fields on Clawd hook wrappers for ${supplementary.invalidWrapperEvents.join(", ")}`,
      supplementary,
    };
  }
  if (supplementary.value === "permission-conflict") {
    // Deliberately no fixAction: any automated Fix would either create the
    // last-wins overlap or delete a user's own hook. The generic validator's
    // missing-event Fix must not leak through here either.
    return {
      ...detail,
      status: "not-connected",
      level: "warning",
      detail: supplementary.detail,
      supplementary,
      fixAction: undefined,
    };
  }
  return {
    ...detail,
    supplementary,
  };
}

function getAntigravityHooksSupplementary(settings) {
  const hookGroup = settings && typeof settings === "object" ? settings[ANTIGRAVITY_HOOK_GROUP_ID] : null;
  if (hookGroup && typeof hookGroup === "object" && hookGroup.enabled === false) {
    return {
      key: "antigravity_hooks",
      value: "disabled-clawd",
      detail: `${ANTIGRAVITY_HOOK_GROUP_ID}.enabled is false`,
    };
  }
  return {
    key: "antigravity_hooks",
    value: "enabled",
    detail: "hooks.json allows Clawd Antigravity hooks",
  };
}

function applyAntigravitySupplementary(detail, descriptor, settings) {
  if (descriptor.agentId !== "antigravity-cli") return detail;

  const supplementary = getAntigravityHooksSupplementary(settings);
  if (supplementary.value !== "enabled") {
    return {
      ...detail,
      status: "not-connected",
      level: "warning",
      detail: ANTIGRAVITY_HOOKS_DISABLED_DETAIL,
      supplementary,
    };
  }
  return {
    ...detail,
    supplementary,
  };
}

// MiMo-style merged config (descriptor.configCandidates, highest-priority
// first): EVERY existing candidate loads, each parsed as JSONC exactly like
// the host's own loader, and the "plugin" array is REPLACED by the
// highest-priority file that declares it. The doctor must validate that
// EFFECTIVE view — checking one fixed file would bless a masked entry or
// miss the live one (#607 review). Only opencode-family JSONC members set
// configCandidates, so this always funnels into checkOpencodeSettings.
function checkMergedJsoncConfig(descriptor, options) {
  const existing = [];
  for (const candidate of descriptor.configCandidates) {
    if (!fileExists(options.fs, candidate)) continue;
    let tree;
    try {
      tree = readJsonc(options.fs, candidate);
    } catch (err) {
      return makeDetail(descriptor, "config-corrupt", {
        level: "warning",
        parentDirExists: true,
        configFileExists: true,
        configPath: candidate,
        detail: `${candidate}: ${err && err.message ? err.message : "config parse failed"}`,
      });
    }
    existing.push({ candidate, tree });
  }

  if (!existing.length) {
    return makeDetail(descriptor, descriptor.autoInstall ? "not-connected" : "manual-only", {
      level: descriptor.autoInstall ? "warning" : "info",
      parentDirExists: true,
      configFileExists: false,
      configPath: descriptor.configPath,
      detail: `${descriptor.configPath} missing`,
    });
  }

  const owner = existing.find((entry) => (
    entry.tree && typeof entry.tree === "object" && !Array.isArray(entry.tree)
    && Object.prototype.hasOwnProperty.call(entry.tree, "plugin")
  ));
  const effective = owner || existing[0];
  // Point every downstream message at the file whose plugin array is live.
  return checkOpencodeSettings({ ...descriptor, configPath: effective.candidate }, effective.tree, options);
}

function checkFileMode(descriptor, options) {
  if (Array.isArray(descriptor.configCandidates) && descriptor.configCandidates.length) {
    return checkMergedJsoncConfig(descriptor, options);
  }
  if (!fileExists(options.fs, descriptor.configPath)) {
    return makeDetail(descriptor, descriptor.autoInstall ? "not-connected" : "manual-only", {
      level: descriptor.autoInstall ? "warning" : "info",
      parentDirExists: true,
      configFileExists: false,
      configPath: descriptor.configPath,
      detail: `${descriptor.configPath} missing`,
    });
  }

  let settings;
  try {
    settings = descriptor.configJsonc
      ? readJsonc(options.fs, descriptor.configPath)
      : readJson(options.fs, descriptor.configPath);
  } catch (err) {
    return makeDetail(descriptor, "config-corrupt", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: descriptor.configPath,
      detail: err && err.message ? err.message : "config parse failed",
    });
  }

  if (descriptor.detection === "opencode-plugin") {
    return checkOpencodeSettings(descriptor, settings, options);
  }

  let detail;
  if (descriptor.agentId === "gemini-cli") {
    detail = validateGeminiHookEvents(descriptor, settings, options);
  } else if (
    descriptor.hookExecutorShape === "zcode-process"
    && Array.isArray(descriptor.hookEvents)
    && descriptor.hookEvents.length
  ) {
    detail = validateZcodeHookEvents(descriptor, settings, options);
  } else if (Array.isArray(descriptor.hookEvents) && descriptor.hookEvents.length) {
    detail = validateFileHookEvents(descriptor, settings, options);
  } else if (descriptor.agentId === "codex") {
    detail = validateCodexCommandList(
      descriptor,
      findCodexPlatformHookCommands(settings, descriptor.marker, options.platform || process.platform),
      options
    );
  } else {
    detail = validateCommandList(
      descriptor,
      findHookCommands(settings, descriptor.marker, { nested: !!descriptor.nested }),
      options
    );
  }
  detail = {
    ...detail,
    parentDirExists: true,
    configFileExists: true,
    configPath: descriptor.configPath,
  };
  detail = applyCodexSupplementary(detail, descriptor, options, settings);
  detail = applyDisabledHookGroup(detail, descriptor, settings);
  detail = applyGeminiSupplementary(detail, descriptor, settings);
  detail = applyQwenSupplementary(detail, descriptor, settings);
  return applyZcodeSupplementary(detail, descriptor, settings);
}

function checkCopilotHooksMode(descriptor, options) {
  if (!fileExists(options.fs, descriptor.configPath)) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      parentDirExists: true,
      configFileExists: false,
      configPath: descriptor.configPath,
      detail: `${descriptor.configPath} missing`,
    });
  }

  let hooksJson;
  try {
    hooksJson = readJson(options.fs, descriptor.configPath);
  } catch (err) {
    return makeDetail(descriptor, "config-corrupt", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: descriptor.configPath,
      detail: err && err.message ? err.message : "hooks.json parse failed",
    });
  }

  // settings.json is optional and auxiliary — its only doctor signal is the
  // disableAllHooks flag. Parse errors are ignored so a malformed
  // settings.json never blocks hooks.json validation (see the matching
  // "ignores parse errors in settings.json" test case).
  let settingsJson = null;
  if (descriptor.settingsPath && fileExists(options.fs, descriptor.settingsPath)) {
    try {
      settingsJson = readJson(options.fs, descriptor.settingsPath);
    } catch {
      // ignore parse errors; settings.json is auxiliary
    }
  }

  const detail = validateCopilotHookEvents(descriptor, hooksJson, settingsJson, options);
  return {
    ...detail,
    parentDirExists: true,
    configFileExists: true,
    configPath: descriptor.configPath,
  };
}

function checkTomlTextMode(descriptor, options) {
  if (!fileExists(options.fs, descriptor.configPath)) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      parentDirExists: true,
      configFileExists: false,
      configPath: descriptor.configPath,
      detail: `${descriptor.configPath} missing`,
    });
  }

  let text;
  try {
    text = options.fs.readFileSync(descriptor.configPath, "utf8");
  } catch (err) {
    return makeDetail(descriptor, "config-corrupt", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: descriptor.configPath,
      detail: err && err.message ? err.message : "config read failed",
    });
  }

  return {
    ...validateCommandList(descriptor, findKimiHookCommands(text, descriptor.marker), options),
    parentDirExists: true,
    configFileExists: true,
    configPath: descriptor.configPath,
  };
}

function unescapeTomlDoubleQuotedValue(value) {
  return String(value || "")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

function parseTomlScalarValue(raw) {
  const value = String(raw || "").trim();
  if (value.startsWith("'''")) {
    const end = value.indexOf("'''", 3);
    return end >= 0 ? value.slice(3, end) : null;
  }
  if (value.startsWith('"""')) {
    const end = value.indexOf('"""', 3);
    return end >= 0 ? unescapeTomlDoubleQuotedValue(value.slice(3, end)) : null;
  }
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end >= 0 ? value.slice(1, end) : null;
  }
  if (value.startsWith("\"")) {
    let escaped = false;
    for (let i = 1; i < value.length; i++) {
      const ch = value[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        return unescapeTomlDoubleQuotedValue(value.slice(1, i));
      }
    }
    return null;
  }
  const bare = value.replace(/\s+#.*$/, "").trim();
  return bare || null;
}

function tomlAssignmentValue(lines, key) {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`);
  for (const line of lines) {
    const match = String(line || "").match(pattern);
    if (!match) continue;
    return parseTomlScalarValue(match[1]);
  }
  return null;
}

function findCodewhaleHookCommandsForEvent(text, eventName, descriptor) {
  if (typeof text !== "string" || !text) return [];
  const sectionMarker = descriptor.marker;
  const commandMarker = descriptor.commandMarker || "codewhale-hook.js";
  return parseCodewhaleTomlSections(text)
    .filter((section) => section.header === "hooks.hooks")
    .filter((section) => section.lines.some((line) => commandContainsFragment(line, sectionMarker)))
    .filter((section) => tomlAssignmentValue(section.lines, "event") === eventName)
    .map((section) => tomlAssignmentValue(section.lines, "command"))
    .filter((command) => typeof command === "string" && commandContainsFragment(command, commandMarker));
}

function codewhaleHooksExplicitlyDisabled(text) {
  const hooksSection = parseCodewhaleTomlSections(text)
    .find((section) => section.header === "hooks");
  if (!hooksSection) return false;
  return tomlAssignmentValue(hooksSection.lines, "enabled") === "false";
}

function validateCodewhaleHookEvents(descriptor, text, options) {
  const events = Array.isArray(descriptor.hookEvents) ? descriptor.hookEvents : [];
  const missingEvents = [];
  let commandCount = 0;
  let firstOk = null;
  let firstFailure = null;

  if (codewhaleHooksExplicitlyDisabled(text)) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      detail: "CodeWhale hooks are disabled in config.toml; Clawd will not receive hook events",
      supplementary: {
        key: "codewhale_hooks",
        value: "disabled",
        detail: "[hooks].enabled is false",
      },
      commandCount: 0,
    });
  }

  for (const eventName of events) {
    const commands = findCodewhaleHookCommandsForEvent(text, eventName, descriptor);
    commandCount += commands.length;
    if (!commands.length) {
      missingEvents.push(eventName);
      continue;
    }

    const results = commands.map((command) => options.validateCommand(command, {
      platform: options.platform,
      fs: options.fs,
    }));
    const ok = results.find((result) => result.ok);
    if (ok) {
      if (!firstOk) firstOk = ok;
      continue;
    }
    if (!firstFailure) {
      firstFailure = {
        eventName,
        result: results[0] || { issue: "parse-failed" },
        command: commands[0],
      };
    }
  }

  if (missingEvents.length) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      detail: `${descriptor.configPath} missing CodeWhale hook event(s): ${missingEvents.join(", ")}`,
      commandCount,
      missingCodewhaleHookEvents: missingEvents,
    });
  }

  if (firstFailure) {
    const first = firstFailure.result;
    return makeDetail(descriptor, "broken-path", {
      level: "warning",
      detail: `CodeWhale hook command failed validation for ${firstFailure.eventName}: ${first.issue || "parse-failed"}`,
      commandCount,
      hookCommandIssue: first.issue || "parse-failed",
      nodeBin: first.nodeBin || null,
      scriptPath: first.scriptPath || null,
      commandFragment: first.fragment || String(firstFailure.command || "").slice(0, 128),
      brokenCodewhaleHookEvent: firstFailure.eventName,
    });
  }

  return makeDetail(descriptor, "ok", {
    level: null,
    detail: `${descriptor.configPath} CodeWhale hooks registered for ${events.length} events, scriptPath verified`,
    commandCount,
    scriptPath: firstOk && firstOk.scriptPath ? firstOk.scriptPath : null,
  });
}

function checkCodewhaleHooksTomlMode(descriptor, options) {
  if (!fileExists(options.fs, descriptor.configPath)) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      parentDirExists: true,
      configFileExists: false,
      configPath: descriptor.configPath,
      detail: `${descriptor.configPath} missing`,
    });
  }

  let text;
  try {
    text = options.fs.readFileSync(descriptor.configPath, "utf8");
  } catch (err) {
    return makeDetail(descriptor, "config-corrupt", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: descriptor.configPath,
      detail: err && err.message ? err.message : "CodeWhale config read failed",
    });
  }

  return {
    ...validateCodewhaleHookEvents(descriptor, text, options),
    parentDirExists: true,
    configFileExists: true,
    configPath: descriptor.configPath,
  };
}

function checkKiroDirMode(descriptor, options) {
  const agentsDir = descriptor.configPath;
  if (!dirExists(options.fs, agentsDir)) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      parentDirExists: true,
      configFileExists: false,
      configPath: agentsDir,
      detail: `${agentsDir} missing`,
      kiroScan: { fullyValidFiles: [], brokenFiles: [], noMarkerFiles: [], corruptFiles: [] },
    });
  }

  let entries = [];
  try {
    entries = options.fs.readdirSync(agentsDir);
  } catch (err) {
    return makeDetail(descriptor, "config-corrupt", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: agentsDir,
      detail: err && err.message ? err.message : "agents dir unreadable",
    });
  }

  const jsonFiles = entries
    .filter((file) => file.endsWith(".json") && !file.endsWith(".example.json"))
    .slice(0, 50);
  const scan = {
    fullyValidFiles: [],
    brokenFiles: [],
    noMarkerFiles: [],
    corruptFiles: [],
  };
  let firstIssue = null;

  for (const file of jsonFiles) {
    const filePath = path.join(agentsDir, file);
    let settings;
    try {
      settings = readJson(options.fs, filePath);
    } catch {
      scan.corruptFiles.push(file);
      continue;
    }

    const commands = findHookCommands(settings, descriptor.marker, { nested: !!descriptor.nested });
    if (!commands.length) {
      scan.noMarkerFiles.push(file);
      continue;
    }
    const results = commands.map((command) => options.validateCommand(command, {
      platform: options.platform,
      fs: options.fs,
    }));
    if (results.some((result) => result.ok)) {
      scan.fullyValidFiles.push(file);
    } else {
      scan.brokenFiles.push(file);
      if (!firstIssue) firstIssue = results[0] || { issue: "parse-failed" };
    }
  }

  if (scan.fullyValidFiles.length > 0) {
    return makeDetail(descriptor, "ok", {
      level: null,
      parentDirExists: true,
      configFileExists: true,
      configPath: agentsDir,
      detail: `${scan.fullyValidFiles.length} hooked agent(s). Use 'kiro-cli --agent clawd' to activate.`,
      kiroScan: scan,
    });
  }
  if (scan.brokenFiles.length > 0) {
    return makeDetail(descriptor, "broken-path", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: agentsDir,
      detail: `Kiro hook command failed validation in ${scan.brokenFiles[0]}`,
      hookCommandIssue: firstIssue && firstIssue.issue ? firstIssue.issue : "parse-failed",
      nodeBin: firstIssue && firstIssue.nodeBin ? firstIssue.nodeBin : null,
      scriptPath: firstIssue && firstIssue.scriptPath ? firstIssue.scriptPath : null,
      kiroScan: scan,
    });
  }
  if (scan.corruptFiles.length > 0 && scan.noMarkerFiles.length === 0) {
    return makeDetail(descriptor, "config-corrupt", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: agentsDir,
      detail: `Kiro agent config could not be parsed: ${scan.corruptFiles[0]}`,
      kiroScan: scan,
    });
  }
  return makeDetail(descriptor, "not-connected", {
    level: "warning",
    parentDirExists: true,
    configFileExists: true,
    configPath: agentsDir,
    detail: "No Kiro agent config contains a valid Clawd hook",
    kiroScan: scan,
  });
}

function checkPluginDirMode(descriptor, options) {
  const pluginDir = descriptor.configPath;
  if (!dirExists(options.fs, pluginDir)) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      parentDirExists: true,
      configFileExists: false,
      configPath: pluginDir,
      detail: `${pluginDir} missing`,
      missingPluginFiles: descriptor.managedFiles || [],
    });
  }

  const managedFiles = Array.isArray(descriptor.managedFiles) ? descriptor.managedFiles : [];
  const missingPluginFiles = managedFiles.filter((file) => !fileExists(options.fs, path.join(pluginDir, file)));
  if (missingPluginFiles.length > 0) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: pluginDir,
      detail: `${pluginDir} missing managed file(s): ${missingPluginFiles.join(", ")}`,
      missingPluginFiles,
    });
  }

  const configFilePath = descriptor.configFilePath;
  let pluginEnabled = null;
  if (configFilePath && fileExists(options.fs, configFilePath)) {
    try {
      const text = options.fs.readFileSync(configFilePath, "utf8");
      pluginEnabled = parseYamlPluginEnabled(text, descriptor.marker);
    } catch (err) {
      return makeDetail(descriptor, "config-corrupt", {
        level: "warning",
        parentDirExists: true,
        configFileExists: true,
        configPath: pluginDir,
        pluginConfigPath: configFilePath,
        detail: err && err.message ? err.message : "plugin config read failed",
      });
    }
  }

  if (pluginEnabled === false) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: pluginDir,
      pluginConfigPath: configFilePath,
      pluginEnabled: false,
      detail: `${configFilePath} does not list ${descriptor.marker} as an enabled plugin`,
    });
  }

  if (pluginEnabled === null) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: pluginDir,
      pluginConfigPath: configFilePath || null,
      pluginEnabled: null,
      detail: `${configFilePath || "plugin config"} missing; cannot verify ${descriptor.marker} is enabled`,
    });
  }

  return makeDetail(descriptor, "ok", {
    level: null,
    parentDirExists: true,
    configFileExists: true,
    configPath: pluginDir,
    pluginConfigPath: configFilePath,
    pluginEnabled: true,
    detail: `${pluginDir} plugin files present and enabled`,
  });
}

function checkAntigravityHooksMode(descriptor, options) {
  if (!fileExists(options.fs, descriptor.configPath)) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      parentDirExists: true,
      configFileExists: false,
      configPath: descriptor.configPath,
      detail: `${descriptor.configPath} missing`,
    });
  }

  let settings;
  try {
    settings = readJson(options.fs, descriptor.configPath);
  } catch (err) {
    return makeDetail(descriptor, "config-corrupt", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: descriptor.configPath,
      detail: err && err.message ? err.message : "Antigravity hooks.json parse failed",
    });
  }

  const detail = {
    ...validateAntigravityHookEvents(descriptor, settings, options),
    parentDirExists: true,
    configFileExists: true,
    configPath: descriptor.configPath,
  };
  return applyAntigravitySupplementary(detail, descriptor, settings);
}

function stripYamlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (quote === "\"" && ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function yamlIndent(line) {
  const match = String(line || "").match(/^ */);
  return match ? match[0].length : 0;
}

function unquoteYamlScalar(value) {
  const text = String(value || "").trim();
  if (text.length >= 2 && text.startsWith("\"") && text.endsWith("\"")) {
    return text.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

function yamlScalarEquals(value, expected) {
  return unquoteYamlScalar(value) === expected;
}

function yamlInlineListContains(value, expected) {
  const text = String(value || "").trim();
  if (!text.startsWith("[") || !text.endsWith("]")) return null;
  const inner = text.slice(1, -1).trim();
  if (!inner) return false;
  return inner
    .split(",")
    .map((entry) => entry.trim())
    .some((entry) => yamlScalarEquals(entry, expected));
}

function parseYamlPluginEnabled(text, pluginId) {
  if (typeof text !== "string" || typeof pluginId !== "string" || !pluginId) return null;
  const lines = text.split(/\r?\n/);
  let inPlugins = false;
  let pluginsIndent = -1;
  let currentKey = "";
  let sawEnabled = false;

  for (const rawLine of lines) {
    const withoutComment = stripYamlComment(rawLine);
    if (!withoutComment.trim()) continue;
    const indent = yamlIndent(withoutComment);
    const trimmed = withoutComment.trim();

    if (!inPlugins) {
      if (indent === 0 && /^plugins\s*:\s*$/.test(trimmed)) {
        inPlugins = true;
        pluginsIndent = indent;
      }
      continue;
    }

    if (indent <= pluginsIndent) break;

    const keyMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (keyMatch && indent === pluginsIndent + 2) {
      currentKey = keyMatch[1];
      if (currentKey !== "enabled") continue;

      sawEnabled = true;
      const rest = keyMatch[2].trim();
      const inlineList = yamlInlineListContains(rest, pluginId);
      if (inlineList === true) return true;
      if (inlineList === false || rest === "" || rest === "[]") continue;
      if (yamlScalarEquals(rest, pluginId)) return true;
      continue;
    }

    if (currentKey === "enabled" && trimmed.startsWith("-")) {
      const item = trimmed.slice(1).trim();
      if (yamlScalarEquals(item, pluginId)) return true;
    }
  }

  return sawEnabled ? false : null;
}

function findOpencodePluginEntry(pluginEntries, marker) {
  if (!Array.isArray(pluginEntries)) return null;
  for (const entry of pluginEntries) {
    if (typeof entry !== "string") continue;
    const normalized = entry.replace(/\\/g, "/");
    const isAbsolute = path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized);
    if (isAbsolute && path.posix.basename(normalized) === marker) return entry;
  }
  return null;
}

function findOpenClawPluginEntry(pluginPaths, marker) {
  if (!Array.isArray(pluginPaths)) return null;
  for (const entry of pluginPaths) {
    if (typeof entry !== "string") continue;
    const normalized = entry.replace(/\\/g, "/");
    const isAbsolute = path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized);
    if (isAbsolute && path.posix.basename(normalized) === marker) return entry;
  }
  return null;
}

function describeOpencodeEntryIssue(reason) {
  switch (reason) {
    case "not-absolute":
      return "the plugin path is not absolute";
    case "directory-missing":
      return "the plugin directory does not exist";
    case "not-a-directory":
      return "the plugin entry is not a directory";
    case "index-mjs-missing":
      return "the plugin directory has no index.mjs";
    case "index-mjs-unreadable":
      return "the plugin index.mjs could not be read";
    case "extra-module-exports":
      return "the module exports more than the default function, so opencode rejects it and loads nothing (#413)";
    case "family-core-missing":
      return "a shared opencode-family file the entry imports is missing (packaging problem)";
    default:
      return reason;
  }
}

function checkOpencodeSettings(descriptor, settings, options) {
  const entry = findOpencodePluginEntry(settings && settings.plugin, descriptor.marker);
  if (!entry) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: descriptor.configPath,
      detail: `${descriptor.configPath} has no ${descriptor.marker} plugin entry`,
    });
  }

  const validation = validateOpencodeEntry(entry, { fs: options.fs });
  if (!validation.ok) {
    // family-core-missing carries WHICH shared file is gone — surface it, or
    // the user sees "packaging problem" with no way to tell core.mjs from
    // session-ids.mjs (the modal renders detail verbatim, no i18n layer).
    const missingSuffix = validation.missing ? ` — missing ${validation.missing}` : "";
    return makeDetail(descriptor, "broken-path", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: descriptor.configPath,
      detail: `opencode plugin entry is invalid: ${describeOpencodeEntryIssue(validation.reason)}${missingSuffix}`,
      opencodeEntryIssue: validation.reason,
      opencodeEntry: entry,
    });
  }

  return makeDetail(descriptor, "ok", {
    level: null,
    parentDirExists: true,
    configFileExists: true,
    configPath: descriptor.configPath,
    detail: `${descriptor.configPath} plugin entry verified`,
    opencodeEntry: entry,
  });
}

function checkOpenClawPluginMode(descriptor, options) {
  if (!fileExists(options.fs, descriptor.configPath)) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      parentDirExists: true,
      configFileExists: false,
      configPath: descriptor.configPath,
      detail: `${descriptor.configPath} missing`,
    });
  }

  let settings;
  try {
    settings = readJson(options.fs, descriptor.configPath);
  } catch (err) {
    return makeDetail(descriptor, "needs-review", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: descriptor.configPath,
      detail: `OpenClaw config is not strict JSON; Clawd startup sync will skip direct edits (${err && err.message ? err.message : "parse failed"})`,
    });
  }

  if (hasIncludeDirective(settings)) {
    return makeDetail(descriptor, "needs-review", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: descriptor.configPath,
      detail: "OpenClaw config uses include directives; Clawd startup sync will not edit it directly",
    });
  }

  const pluginPaths = settings
    && settings.plugins
    && settings.plugins.load
    && settings.plugins.load.paths;
  const entry = findOpenClawPluginEntry(pluginPaths, descriptor.marker);
  if (!entry) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: descriptor.configPath,
      detail: `${descriptor.configPath} has no ${descriptor.marker} plugin path`,
    });
  }

  const pluginConfig = settings
    && settings.plugins
    && settings.plugins.entries
    && settings.plugins.entries[descriptor.pluginId || "clawd-on-desk"];
  if (pluginConfig && pluginConfig.enabled === false) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: descriptor.configPath,
      detail: "OpenClaw Clawd plugin is registered but disabled",
      openclawEntry: entry,
    });
  }

  const validation = validateOpenClawEntry(entry, { fs: options.fs });
  if (!validation.ok) {
    return makeDetail(descriptor, "broken-path", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: descriptor.configPath,
      detail: `OpenClaw plugin path is invalid: ${validation.reason}`,
      openclawEntryIssue: validation.reason,
      openclawEntry: entry,
    });
  }

  return makeDetail(descriptor, "ok", {
    level: null,
    parentDirExists: true,
    configFileExists: true,
    configPath: descriptor.configPath,
    detail: `${descriptor.configPath} OpenClaw plugin entry verified`,
    openclawEntry: entry,
  });
}

function readJsonIfPresent(fsImpl, filePath) {
  try {
    return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isPiManagedMarker(value) {
  return !!(
    value
    && value.app === "clawd-on-desk"
    && value.integration === "pi"
    && value.managed === true
  );
}

function checkPiExtensionMode(descriptor, options) {
  const extensionDir = descriptor.configPath;
  const markerPath = path.join(extensionDir, descriptor.markerFile || ".clawd-managed.json");
  const extensionPath = path.join(extensionDir, descriptor.marker || "index.ts");
  const corePath = path.join(extensionDir, descriptor.coreFile || "pi-extension-core.js");

  if (!dirExists(options.fs, extensionDir)) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      parentDirExists: true,
      configFileExists: false,
      configPath: extensionDir,
      extensionDir,
      detail: `${extensionDir} missing`,
    });
  }

  const marker = readJsonIfPresent(options.fs, markerPath);
  if (!isPiManagedMarker(marker)) {
    return makeDetail(descriptor, "needs-review", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: extensionDir,
      extensionDir,
      markerPath,
      detail: `${extensionDir} exists but is not Clawd-managed`,
    });
  }

  const extensionFileExists = fileExists(options.fs, extensionPath);
  const coreFileExists = fileExists(options.fs, corePath);
  if (!extensionFileExists || !coreFileExists) {
    return makeDetail(descriptor, "broken-path", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: extensionDir,
      extensionDir,
      markerPath,
      extensionPath,
      corePath,
      extensionFileExists,
      coreFileExists,
      detail: "Pi extension files are missing or incomplete",
    });
  }

  return makeDetail(descriptor, "ok", {
    level: null,
    parentDirExists: true,
    configFileExists: true,
    configPath: extensionDir,
    extensionDir,
    markerPath,
    extensionPath,
    corePath,
    extensionFileExists,
    coreFileExists,
    detail: `${extensionDir} extension verified`,
  });
}

function checkAgent(descriptor, options) {
  const prefs = options.prefs || {};
  if (!isAgentIntegrationInstalled(prefs, descriptor.agentId)) {
    return makeDetail(descriptor, "not-managed", {
      level: "info",
      detail: "This integration is not installed in Settings",
    });
  }

  if (!isAgentEnabled(prefs, descriptor.agentId)) {
    return makeDetail(descriptor, "disabled", {
      level: "info",
      detail: "You disabled this agent in Settings",
    });
  }

  if (descriptor.agentId === "claude-code" && prefs.manageClaudeHooksAutomatically === false) {
    return makeDetail(descriptor, "manual-managed", {
      level: "info",
      detail: "Automatic Claude hook management is disabled",
    });
  }

  if (descriptor.configMode === "none-global") {
    return makeDetail(descriptor, "manual-only", {
      level: "info",
      detail: "This agent does not use a host-managed config file",
      scriptPath: descriptor.scriptPath || null,
      scriptExists: descriptor.scriptPath ? fileExists(options.fs, descriptor.scriptPath) : null,
    });
  }

  if (descriptor.configMode === "dsh-plugin") {
    const health = inspectDeepSeekHarnessDiskSync({
      fs: options.fs,
      dshHome: descriptor.parentDir,
      dshInstallRoot: options.dshInstallRoot,
      managedRoot: options.dshManagedRoot,
      homeDir: options.homeDir,
      env: options.env,
      platform: options.platform,
    });
    let detail;
    if (health.status === "healthy") {
      detail = makeDetail(descriptor, "ok", {
        level: null,
        detail: `${health.profileDir} managed bridge verified on disk; restart any running dsh web process to load this plugin generation`,
        configPath: health.profileDir,
        pluginPath: health.resolved && health.resolved.packageDir,
        bridgeHealth: health.status,
      });
    } else if (
      health.status === "profile-entry-foreign-or-conflicting"
      || health.status === "version-unsupported"
      || health.status === "host-version-unsupported"
      || health.status === "generation-integrity-failed"
      || health.status === "source-unavailable"
      || health.status === "profile-corrupt"
    ) {
      detail = makeDetail(descriptor, "needs-review", {
        level: "warning",
        detail: health.status === "version-unsupported" || health.status === "host-version-unsupported"
          ? `DeepSeek Harness ${health.detectedDshVersion || "or its bridge marker"} is outside ${health.supportedDshRange || "the supported range"}; Clawd will not activate it automatically`
          : (health.status === "generation-integrity-failed"
            ? "The managed DeepSeek Harness bridge bytes no longer match their ownership marker; inspect them manually"
            : (health.status === "source-unavailable"
              ? "Clawd's packaged DeepSeek Harness bridge source is unavailable; repair the Clawd installation"
              : (health.status === "profile-corrupt"
                ? "The DeepSeek Harness web profile manifest is unreadable; Clawd will not rewrite it automatically"
                : "A foreign or conflicting DeepSeek Harness plugin uses the Clawd bridge package name; Clawd will not replace it"))),
        configPath: health.profileDir,
        bridgeHealth: health.status,
      });
    } else {
      const broken = health.status !== "absent" && health.status !== "profile-missing";
      detail = makeDetail(descriptor, broken ? "broken-path" : "not-connected", {
        level: "warning",
        detail: `DeepSeek Harness managed bridge is ${health.status}`,
        configPath: health.profileDir,
        bridgeHealth: health.status,
      });
    }
    return withAgentFixAction(withAgentBubbleNote(detail, prefs, descriptor.agentId), descriptor);
  }

  // Multi-home agents declare ordered configTargets. Most use the first
  // existing directory; WorkBuddy's legacy target requires a real config file,
  // while Reasonix mirrors its own compatibility loader by preferring an
  // existing current/legacy settings file before a bare home.
  const configTargets = Array.isArray(descriptor.configTargets) ? descriptor.configTargets : [];
  const activeTarget = descriptor.preferExistingConfigFile
    ? configTargets.find((target) => fileExists(options.fs, target.configPath))
      || configTargets.find((target) => dirExists(options.fs, target.parentDir))
    : configTargets.find((target) => {
      if (descriptor.agentId === "workbuddy" && target.label === "legacy") {
        return fileExists(options.fs, target.configPath);
      }
      return dirExists(options.fs, target.parentDir);
    });
  const effectiveDescriptor = activeTarget
    ? { ...descriptor, parentDir: activeTarget.parentDir, configPath: activeTarget.configPath }
    : descriptor;

  const parentDirExists = effectiveDescriptor.parentDir
    ? dirExists(options.fs, effectiveDescriptor.parentDir)
    : false;
  if (!parentDirExists) {
    return makeDetail(descriptor, "not-installed", {
      level: "info",
      parentDirExists: false,
      configPath: descriptor.configPath,
      detail: Array.isArray(descriptor.configTargets)
        ? `${descriptor.configTargets.map((target) => target.parentDir).join(" / ")} missing`
        : `${descriptor.parentDir} missing`,
    });
  }
  descriptor = effectiveDescriptor;

  let detail;
  if (descriptor.configMode === "file") {
    detail = checkFileMode(descriptor, options);
  } else if (descriptor.configMode === "copilot-hooks") {
    detail = checkCopilotHooksMode(descriptor, options);
  } else if (descriptor.configMode === "toml-text") {
    detail = checkTomlTextMode(descriptor, options);
  } else if (descriptor.configMode === "codewhale-hooks-toml") {
    detail = checkCodewhaleHooksTomlMode(descriptor, options);
  } else if (descriptor.configMode === "dir") {
    detail = checkKiroDirMode(descriptor, options);
  } else if (descriptor.configMode === "pi-extension") {
    detail = checkPiExtensionMode(descriptor, options);
  } else if (descriptor.configMode === "openclaw-plugin") {
    detail = checkOpenClawPluginMode(descriptor, options);
  } else if (descriptor.configMode === "plugin-dir") {
    detail = checkPluginDirMode(descriptor, options);
  } else if (descriptor.configMode === "antigravity-hooks") {
    detail = checkAntigravityHooksMode(descriptor, options);
  } else {
    detail = makeDetail(descriptor, "manual-only", {
      level: "info",
      detail: `Unsupported config mode: ${descriptor.configMode}`,
    });
  }

  if (descriptor.agentId === "kimi-cli") {
    detail = withKimiLegacyPermissionModeSupplement(detail, descriptor, options);
  }
  detail = withClaudeHookGuardNotice(detail, descriptor, options);
  detail = withTraeCodeEnableNotice(detail, descriptor);
  return withAgentFixAction(withAgentBubbleNote(detail, prefs, descriptor.agentId), descriptor);
}

// #563 follow-up: with both Kimi generations installed, the primary check
// judges the first existing configTarget (kimi-code) and the legacy
// ~/.kimi/config.toml is never inspected — yet that is the config the Python
// kimi-cli actually reads. And even when legacy IS the active target, the
// generic command check only asserts "some command exists and its script
// resolves". Since the suspect default ships as an argv flag on the hook
// command (--permission-mode), a stale legacy install — retired env-prefix
// form (not executed on Windows), missing flag, or missing events — silently
// means "no cues at all" for legacy sessions. Assert completeness here
// whenever the legacy directory carries Clawd hooks, whichever target the
// primary check judged.
function withKimiLegacyPermissionModeSupplement(detail, descriptor, options) {
  // Never mask a primary finding — the supplement only tightens an "ok".
  if (detail.status !== "ok") return detail;
  const targets = Array.isArray(descriptor.configTargets) ? descriptor.configTargets : [];
  const legacyTarget = targets.find((target) => target.label === "legacy");
  if (!legacyTarget || !dirExists(options.fs, legacyTarget.parentDir)) return detail;
  if (!fileExists(options.fs, legacyTarget.configPath)) return detail;
  let text;
  try {
    text = options.fs.readFileSync(legacyTarget.configPath, "utf8");
  } catch {
    // Unreadable legacy config: if legacy is the active target the primary
    // check already surfaced it; if kimi-code is active, don't turn a read
    // hiccup into a warning.
    return detail;
  }
  const commands = findKimiHookCommands(text, descriptor.marker);
  // No Clawd hooks on legacy at all: connection status is the primary
  // check's business (when legacy is active) or a deliberate non-install.
  if (!commands.length) return detail;

  const issues = [];
  const registeredEvents = new Set(listClawdKimiHookEvents(text, descriptor.marker));
  const missingEvents = KIMI_HOOK_EVENTS.filter((event) => !registeredEvents.has(event));
  if (missingEvents.length) {
    issues.push(`missing hook events: ${missingEvents.join(", ")}`);
  }
  // The retired env prefix is checked UNCONDITIONALLY: a command carrying
  // both the prefix and a valid argv flag is still dead on Windows (the
  // leading `VAR=x` form never executes under a real shell there), yet its
  // node/script substrings would pass the generic command validation.
  if (/CLAWD_KIMI_PERMISSION_MODE=/.test(commands.join("\n"))) {
    issues.push("hook commands carry the retired env-prefix mode form (never executed on Windows)");
  }
  const modes = commands.map((command) => {
    const argvMatch = command.match(/--permission-mode=([A-Za-z]+)/);
    return argvMatch ? normalizeKimiPermissionMode(argvMatch[1]) : null;
  });
  const missingModeCount = modes.filter((mode) => !mode).length;
  if (missingModeCount > 0) {
    issues.push(`${missingModeCount} hook command(s) missing the --permission-mode flag`);
  }
  const distinctModes = new Set(modes.filter(Boolean));
  if (distinctModes.size > 1) {
    issues.push(`inconsistent --permission-mode values: ${[...distinctModes].join(", ")}`);
  }
  if (!issues.length) return detail;
  return {
    ...detail,
    status: "needs-review",
    level: "warning",
    detail: `${legacyTarget.configPath}: ${issues.join("; ")} — Fix rewrites Clawd's Kimi hooks in the current format`,
    supplementary: { key: "kimi_legacy_mode", value: "stale" },
    kimiLegacyConfigPath: legacyTarget.configPath,
  };
}

function summarize(details) {
  const counts = {};
  for (const detail of details) {
    counts[detail.status] = (counts[detail.status] || 0) + 1;
  }
  const warningCount = details.filter((detail) => statusLevel(detail.status) === "warning").length;
  const okCount = counts.ok || 0;
  let status = "pass";
  let level = null;
  if (warningCount > 0) {
    status = "warning";
    level = "warning";
  }
  // An all-info aggregate (every integration disabled / manual-managed / not
  // installed) is a deliberate user or environment choice, not a fault, so the
  // summary stays green (#490). The "nothing is wired up" hint is surfaced as
  // info-level UI copy instead, and a genuinely broken local server is still
  // flagged red by the separate local-server check.
  return { status, level, counts, okCount, warningCount };
}

function checkAgentIntegrations(options = {}) {
  const detectorOptions = {
    fs: options.fs || fs,
    platform: options.platform || process.platform,
    env: options.env || process.env,
    prefs: options.prefs || {},
    server: options.server || null,
    validateCommand: options.validateCommand || validateHookCommand,
    validateTarget: options.validateTarget || validateHookTarget,
    dshInstallRoot: options.dshInstallRoot,
    dshManagedRoot: options.dshManagedRoot,
    homeDir: options.homeDir,
  };
  const descriptors = options.descriptors || getAgentDescriptors();
  const details = descriptors.map((descriptor) => checkAgent(descriptor, detectorOptions));
  const summary = summarize(details);
  return {
    id: "agent-integrations",
    ...summary,
    details,
  };
}

module.exports = {
  checkAgentIntegrations,
  checkAgent,
  findOpenClawPluginEntry,
  findOpencodePluginEntry,
  summarize,
  __test: {
    checkFileMode,
    checkKiroDirMode,
    checkOpenClawPluginMode,
    checkPiExtensionMode,
    checkPluginDirMode,
    checkAntigravityHooksMode,
    findAntigravityHookCommandsForEvent,
    parseYamlPluginEnabled,
    codewhaleHooksExplicitlyDisabled,
    checkTomlTextMode,
    validateCommandList,
  },
};
