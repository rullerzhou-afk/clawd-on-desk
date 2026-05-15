"use strict";

const fs = require("fs");
const path = require("path");

const { isAgentEnabled, isAgentPermissionsEnabled } = require("../agent-gate");
const { findHookCommands } = require("../../hooks/json-utils");
const { GEMINI_HOOK_EVENTS } = require("../../hooks/gemini-install");
const { findKimiHookCommands } = require("../../hooks/kimi-install");
const { getAgentDescriptors } = require("./agent-descriptors");
const { validateHookCommand } = require("./agent-node-bin-parser");
const { checkCodexHookTrust, checkCodexHooksFeature } = require("./codex-features-check");
const { validateOpencodeEntry } = require("./opencode-entry-validator");
const { validateOpenClawEntry } = require("./openclaw-entry-validator");
const { hasIncludeDirective } = require("../../hooks/openclaw-install");

const INFO_ONLY_STATUSES = new Set([
  "disabled",
  "manual-managed",
  "manual-only",
  "not-installed",
]);
const REPAIRABLE_AGENT_STATUSES = new Set(["not-connected", "broken-path"]);
const GEMINI_HOOKS_DISABLED_DETAIL = "Gemini hooks are disabled in settings.json; Clawd preserves this user setting and will not receive hook events";

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
  return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
}

function withAgentBubbleNote(detail, prefs, agentId) {
  if (!isAgentPermissionsEnabled(prefs, agentId)) {
    return {
      ...detail,
      permissionsEnabled: false,
      permissionBubbleDetail: "permission bubbles disabled for this agent",
    };
  }
  return detail;
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
        if (hook && typeof hook.command === "string" && hook.command.includes(marker)) {
          commands.push(hook.command);
        }
      }
    }
    if (typeof entry.command === "string" && entry.command.includes(marker)) {
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

function applyCodexSupplementary(detail, descriptor, options, settings) {
  if (!descriptor.supplementary || descriptor.supplementary.key !== "hooks") return detail;
  if (detail.status !== "ok") return detail;

  const supplementary = checkCodexHooksFeature(descriptor.supplementary.configPath, { fs: options.fs });
  if (supplementary.value === "disabled") {
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

  let detail = descriptor.agentId === "gemini-cli"
    ? validateGeminiHookEvents(descriptor, settings, options)
    : validateCommandList(
      descriptor,
      findHookCommands(settings, descriptor.marker, { nested: !!descriptor.nested }),
      options
    );
  detail = {
    ...detail,
    parentDirExists: true,
    configFileExists: true,
    configPath: descriptor.configPath,
  };
  detail = applyCodexSupplementary(detail, descriptor, options, settings);
  return applyGeminiSupplementary(detail, descriptor, settings);
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
      detail: `opencode plugin entry is invalid: ${validation.reason}`,
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
      detail: "This agent uses project-level config",
      scriptPath: descriptor.scriptPath || null,
      scriptExists: descriptor.scriptPath ? fileExists(options.fs, descriptor.scriptPath) : null,
    });
  }

  const parentDirExists = descriptor.parentDir ? dirExists(options.fs, descriptor.parentDir) : false;
  if (!parentDirExists) {
    return makeDetail(descriptor, "not-installed", {
      level: "info",
      parentDirExists: false,
      configPath: descriptor.configPath,
      detail: `${descriptor.parentDir} missing`,
    });
  }

  let detail;
  if (descriptor.configMode === "file") {
    detail = checkFileMode(descriptor, options);
  } else if (descriptor.configMode === "toml-text") {
    detail = checkTomlTextMode(descriptor, options);
  } else if (descriptor.configMode === "dir") {
    detail = checkKiroDirMode(descriptor, options);
  } else if (descriptor.configMode === "pi-extension") {
    detail = checkPiExtensionMode(descriptor, options);
  } else if (descriptor.configMode === "openclaw-plugin") {
    detail = checkOpenClawPluginMode(descriptor, options);
  } else if (descriptor.configMode === "plugin-dir") {
    detail = checkPluginDirMode(descriptor, options);
  } else {
    detail = makeDetail(descriptor, "manual-only", {
      level: "info",
      detail: `Unsupported config mode: ${descriptor.configMode}`,
    });
  }

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
  } else if (okCount === 0 && details.every((detail) => INFO_ONLY_STATUSES.has(detail.status))) {
    status = "critical";
    level = "critical";
  }
  return { status, level, counts, okCount, warningCount };
}

function checkAgentIntegrations(options = {}) {
  const detectorOptions = {
    fs: options.fs || fs,
    platform: options.platform || process.platform,
    prefs: options.prefs || {},
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
    parseYamlPluginEnabled,
    checkTomlTextMode,
    validateCommandList,
  },
};
