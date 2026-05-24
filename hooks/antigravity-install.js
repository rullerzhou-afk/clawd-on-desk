#!/usr/bin/env node
// Merge Clawd Antigravity hooks into ~/.gemini/config/hooks.json.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { resolveNodeBin } = require("./server-config");
const { writeJsonAtomic, asarUnpackedPath, formatNodeHookCommand } = require("./json-utils");

const HOOK_GROUP_ID = "clawd";
const MARKER = "antigravity-hook.js";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".gemini", "config");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "hooks.json");

// PreToolUse intentionally NOT registered. Antigravity 1.0.1 LLMs proactively
// call the built-in `ask_permission` tool before sensitive actions, which then
// triggers agy's native 5-option menu — there's no way for a hook to suppress
// that menu. Layering a Clawd bubble on top of (or in front of) the native
// menu yields 8-10 confirmations for a single user task.
// Antigravity stays a state-only integration; agy native menu owns permission.
const ANTIGRAVITY_HOOK_EVENTS = [
  "PreInvocation",
  "PostToolUse",
  "PostInvocation",
  "Stop",
];
const DEFAULT_HOOK_TIMEOUT_SECONDS = 10;

function buildAntigravityHookCommand(nodeBin, hookScript, event, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === "win32") {
    return buildWindowsAntigravityHookCommand(nodeBin, hookScript, event, options);
  }
  return formatNodeHookCommand(nodeBin, hookScript, {
    ...options,
    args: [event],
  });
}

function quotePowerShellSingleArg(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function windowsPowerShellBin(options = {}) {
  if (options.powerShellBin) return options.powerShellBin;
  const root = process.env.SystemRoot || "C:\\Windows";
  return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function buildWindowsAntigravityHookCommand(nodeBin, hookScript, event, options = {}) {
  const psCommand = [
    "&",
    quotePowerShellSingleArg(nodeBin),
    quotePowerShellSingleArg(hookScript),
    quotePowerShellSingleArg(event),
  ].join(" ");
  const encodedCommand = Buffer.from(psCommand, "utf16le").toString("base64");
  return `${windowsPowerShellBin(options)} -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`;
}

function decodeWindowsEncodedCommand(command) {
  const match = String(command || "").match(/(?:^|\s)-(?:EncodedCommand|enc|e)\s+([A-Za-z0-9+/=]+)/i);
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf16le").trim();
    return decoded || null;
  } catch {
    return null;
  }
}

function extractFirstQuotedToken(command) {
  const text = String(command || "").trim().replace(/^&\s+/, "");
  const single = text.match(/^'((?:''|[^'])*)'/);
  if (single) return single[1].replace(/''/g, "'");
  const double = text.match(/^"((?:\\"|[^"])*)"/);
  if (double) return double[1].replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  const bare = text.match(/^(\S+)/);
  return bare ? bare[1] : null;
}

function extractNodeBinFromCommand(command) {
  const decoded = decodeWindowsEncodedCommand(command);
  const token = extractFirstQuotedToken(decoded || command);
  if (!token || token.includes(MARKER)) return null;
  return token;
}

function collectHookCommandsFromEntries(entries) {
  const commands = [];
  if (!Array.isArray(entries)) return commands;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.command === "string") {
      const decoded = decodeWindowsEncodedCommand(entry.command);
      if (entry.command.includes(MARKER) || (decoded && decoded.includes(MARKER))) {
        commands.push(entry.command);
      }
    }
    if (!Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (!hook || typeof hook.command !== "string") continue;
      const decoded = decodeWindowsEncodedCommand(hook.command);
      if (hook.command.includes(MARKER) || (decoded && decoded.includes(MARKER))) {
        commands.push(hook.command);
      }
    }
  }
  return commands;
}

function extractExistingAntigravityNodeBin(existingGroup) {
  if (!existingGroup || typeof existingGroup !== "object") return null;
  for (const event of ANTIGRAVITY_HOOK_EVENTS) {
    for (const command of collectHookCommandsFromEntries(existingGroup[event])) {
      const nodeBin = extractNodeBinFromCommand(command);
      if (nodeBin) return nodeBin;
    }
  }
  return null;
}

function resolveAntigravityNodeBin(options = {}) {
  if (options.nodeBin !== undefined) return options.nodeBin;
  return resolveNodeBin(options);
}

function buildHookHandler(command, timeout = DEFAULT_HOOK_TIMEOUT_SECONDS) {
  return { type: "command", command, timeout };
}

function buildAntigravityHooks(commandForEvent) {
  return {
    clawd: {
      PreInvocation: [buildHookHandler(commandForEvent("PreInvocation"))],
      PostToolUse: [{
        matcher: "*",
        hooks: [buildHookHandler(commandForEvent("PostToolUse"))],
      }],
      PostInvocation: [buildHookHandler(commandForEvent("PostInvocation"))],
      Stop: [buildHookHandler(commandForEvent("Stop"))],
    },
  };
}

function hasAntigravityConfig(homeDir) {
  return fs.existsSync(path.join(homeDir, ".gemini", "config"));
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

function normalizeSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function registerAntigravityHooks(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const configPath = options.configPath || path.join(homeDir, ".gemini", "config", "hooks.json");

  if (!options.configPath && !hasAntigravityConfig(homeDir)) {
    if (!options.silent) console.log("Clawd: Antigravity config not found - skipping Antigravity hook registration");
    return { installed: false, added: 0, updated: 0, skipped: 0, configPath };
  }

  const settings = normalizeSettings(readJsonIfExists(configPath));
  const existingGroup = settings[HOOK_GROUP_ID] && typeof settings[HOOK_GROUP_ID] === "object" && !Array.isArray(settings[HOOK_GROUP_ID])
    ? settings[HOOK_GROUP_ID]
    : null;
  const hookScript = asarUnpackedPath(path.resolve(__dirname, "antigravity-hook.js").replace(/\\/g, "/"));
  const nodeBin = resolveAntigravityNodeBin(options)
    || extractExistingAntigravityNodeBin(existingGroup)
    || "node";
  const desiredGroup = buildAntigravityHooks((event) => buildAntigravityHookCommand(nodeBin, hookScript, event, options))[HOOK_GROUP_ID];

  let added = 0;
  let updated = 0;
  let skipped = 0;

  if (existingGroup && existingGroup.enabled === false) {
    desiredGroup.enabled = false;
  }

  for (const event of ANTIGRAVITY_HOOK_EVENTS) {
    const existingText = existingGroup ? JSON.stringify(existingGroup[event]) : null;
    const nextText = JSON.stringify(desiredGroup[event]);
    if (existingText === nextText) {
      skipped++;
    } else if (existingText === null) {
      added++;
    } else {
      updated++;
    }
  }

  const changed = !existingGroup || JSON.stringify(existingGroup) !== JSON.stringify(desiredGroup);
  if (changed) {
    settings[HOOK_GROUP_ID] = desiredGroup;
    writeJsonAtomic(configPath, settings);
  }

  if (!options.silent) {
    console.log(`Clawd Antigravity hooks -> ${configPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
  }

  return { installed: true, added, updated, skipped, configPath };
}

module.exports = {
  HOOK_GROUP_ID,
  MARKER,
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  ANTIGRAVITY_HOOK_EVENTS,
  registerAntigravityHooks,
  __test: {
    buildAntigravityHookCommand,
    buildAntigravityHooks,
    buildWindowsAntigravityHookCommand,
    decodeWindowsEncodedCommand,
    extractExistingAntigravityNodeBin,
    extractNodeBinFromCommand,
    hasAntigravityConfig,
    normalizeSettings,
    resolveAntigravityNodeBin,
  },
};

if (require.main === module) {
  try {
    registerAntigravityHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
