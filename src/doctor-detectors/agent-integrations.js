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
const { QWEN_CODE_HOOK_EVENTS } = require("../../hooks/qwen-code-install");
const {
  hasUserPermissionHookInOtherFiles,
  hasUserPermissionHookInSettingsJson,
  isCopilotPermissionRegistrable,
} = require("../../hooks/copilot-install");
const { findKimiHookCommands } = require("../../hooks/kimi-install");
const { parseTomlSections: parseCodewhaleTomlSections } = require("../../hooks/codewhale-install");
const { getAgentDescriptors } = require("./agent-descriptors");
const { commandContainsFragment, validateHookCommand } = require("./agent-node-bin-parser");
const { checkCodexHookTrust, checkCodexHooksFeature } = require("./codex-features-check");
const { validateOpencodeEntry } = require("./opencode-entry-validator");
const { validateOpenClawEntry } = require("./openclaw-entry-validator");
const { hasIncludeDirective } = require("../../hooks/openclaw-install");

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

function withClaudeHookGuardNotice(detail, descriptor, options) {
  if (descriptor.agentId !== "claude-code") return detail;
  if (!detail || detail.status !== "not-connected") return detail;
  const guard = getClaudeHookGuardStatus(options);
  if (!guard || guard.type !== "suspicious-shrink") return detail;
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

function withAgentFixAction(detail, descriptor) {
  if (!descriptor.autoInstall || !REPAIRABLE_AGENT_STATUSES.has(detail.status)) return detail;
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
    descriptor.agentId === "qwen-code"
    && detail.supplementary
    && detail.supplementary.key === "qwen_hooks"
    && detail.supplementary.value !== "enabled"
  ) {
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
  const entries = settings.hooks[eventName];
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

function validateGeminiHookEvents(descriptor, settings, options) {
  const missingEvents = [];
  let commandCount = 0;
  let firstOk = null;
  let firstFailure = null;

  for (const eventName of GEMINI_HOOK_EVENTS) {
    const commands = findHookCommandsForEvent(settings, eventName, descriptor.marker, { nested: !!descriptor.nested });
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

function validateQwenHookEvents(descriptor, settings, options) {
  const events = Array.isArray(descriptor.hookEvents) ? descriptor.hookEvents : QWEN_CODE_HOOK_EVENTS;
  const missingEvents = [];
  let commandCount = 0;
  let firstOk = null;
  let firstFailure = null;

  for (const eventName of events) {
    const commands = findHookCommandsForEvent(settings, eventName, descriptor.marker, { nested: !!descriptor.nested });
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
      detail: `${descriptor.configPath} missing Qwen Code hook event(s): ${missingEvents.join(", ")}`,
      commandCount,
      missingQwenHookEvents: missingEvents,
    });
  }

  if (firstFailure) {
    const first = firstFailure.result;
    return makeDetail(descriptor, "broken-path", {
      level: "warning",
      detail: `Qwen Code hook command failed validation for ${firstFailure.eventName}: ${first.issue || "parse-failed"}`,
      commandCount,
      hookCommandIssue: first.issue || "parse-failed",
      nodeBin: first.nodeBin || null,
      scriptPath: first.scriptPath || null,
      commandFragment: first.fragment || String(firstFailure.command || "").slice(0, 128),
      brokenQwenHookEvent: firstFailure.eventName,
    });
  }

  return makeDetail(descriptor, "ok", {
    level: null,
    detail: `${descriptor.configPath} Qwen Code hooks registered for ${events.length} events, scriptPath verified`,
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

function checkFileMode(descriptor, options) {
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
    settings = readJson(options.fs, descriptor.configPath);
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
  } else if (descriptor.agentId === "qwen-code") {
    detail = validateQwenHookEvents(descriptor, settings, options);
  } else if (descriptor.agentId === "codex") {
    detail = validateCommandList(
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
  detail = applyGeminiSupplementary(detail, descriptor, settings);
  return applyQwenSupplementary(detail, descriptor, settings);
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
    return makeDetail(descriptor, "broken-path", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: descriptor.configPath,
      detail: `opencode plugin entry is invalid: ${describeOpencodeEntryIssue(validation.reason)}`,
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

  // Multi-generation agents (#563: kimi legacy + kimi-code) declare ordered
  // configTargets; the first whose directory exists is the one doctor judges.
  const activeTarget = Array.isArray(descriptor.configTargets)
    ? descriptor.configTargets.find((target) => dirExists(options.fs, target.parentDir))
    : null;
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

  detail = withClaudeHookGuardNotice(detail, descriptor, options);
  return withAgentFixAction(withAgentBubbleNote(detail, prefs, descriptor.agentId), descriptor);
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
    prefs: options.prefs || {},
    server: options.server || null,
    validateCommand: options.validateCommand || validateHookCommand,
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
