const fs = require("fs");
const path = require("path");
const os = require("os");
const { resolveNodeBin } = require("./server-config");
const {
  readJsonFile,
  writeJsonAtomic,
  writeJsonAtomicWithBackup,
  asarUnpackedPath,
  commandMatchesMarker,
  extractExistingNodeBin,
  formatNodeHookCommand,
} = require("./json-utils");

const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".codex");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "hooks.json");
const DEFAULT_FEATURES_CONFIG = path.join(DEFAULT_PARENT_DIR, "config.toml");

const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
];
const CODEX_HOOKS_FEATURE_KEY = "hooks";
const LEGACY_CODEX_HOOKS_FEATURE_KEY = "codex_hooks";

function timeoutForCodexEvent(event) {
  return event === "PermissionRequest" ? 600 : 30;
}

function getCodexPaths(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const codexDir = options.codexDir || path.join(homeDir, ".codex");
  return {
    codexDir,
    hooksPath: options.hooksPath || path.join(codexDir, "hooks.json"),
    configPath: options.configPath || path.join(codexDir, "config.toml"),
  };
}

function buildCodexHookCommand(nodeBin, hookScript, platform = process.platform) {
  return formatNodeHookCommand(nodeBin, hookScript, {
    platform,
    // Real Windows Codex hook runs execute command strings through
    // PowerShell. A bare quoted executable (`"node" "hook.js"`) is parsed as
    // a string literal plus an unexpected token and exits 1, so use the
    // PowerShell call operator.
    windowsWrapper: "powershell",
  });
}

function windowsPathToWslPath(value) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(String(value || ""));
  if (!match) return null;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

// POSIX-side `command` for a hooks.json shared with WSL through CODEX_HOME
// (#544). Codex on Windows prefers `commandWindows` (openai/codex#22159), so
// `command` is only executed by POSIX shells — for a Windows-authored
// hooks.json that means WSL. Run the WINDOWS node.exe via WSL interop rather
// than a Linux node: the hook then lives in a Windows process whose
// 127.0.0.1 is the Windows loopback, so events reach Clawd's server (which
// binds 127.0.0.1 only) even in WSL's default NAT mode, where a Linux-side
// process gets connection-refused. Requires WSL interop (on by default).
// Env-var prefixes (`KEY=value node.exe ...`) do NOT cross the interop
// boundary — never prepend env here; put env in commandWindows instead.
function buildCodexHookPosixInteropCommand(nodeBin, hookScript) {
  const wslNodeBin = windowsPathToWslPath(nodeBin);
  // A UNC node path (\\server\share\node.exe or //server/share/node.exe)
  // has no /mnt translation and a POSIX shell cannot exec the raw Windows
  // form — fall back to bare node.exe resolved through the interop PATH.
  const posixNodeBin = wslNodeBin
    || (/^[\\/]{2}/.test(String(nodeBin))
      ? "node.exe"
      : (/\.exe$/i.test(String(nodeBin)) ? nodeBin : `${nodeBin}.exe`));
  return formatNodeHookCommand(posixNodeBin, hookScript, { platform: "linux" });
}

function quotePosixEnvValue(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function quotePowerShellEnvValue(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function filterCommandEnvEntries(env) {
  if (!env || typeof env !== "object") return [];
  return Object.entries(env)
    .filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value !== undefined && value !== null);
}

function withCommandEnv(command, env, platform = process.platform) {
  const entries = filterCommandEnvEntries(env);
  if (!entries.length) return command;

  if (platform === "win32") {
    const prefix = entries
      .map(([key, value]) => `$env:${key}=${quotePowerShellEnvValue(value)}`)
      .join("; ");
    return `${prefix}; ${command}`;
  }

  const prefix = entries
    .map(([key, value]) => `${key}=${quotePosixEnvValue(value)}`)
    .join(" ");
  return `${prefix} ${command}`;
}

function readJsonIfPresent(filePath, label) {
  try {
    return readJsonFile(filePath);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`Failed to read ${label}: ${err.message}`);
  }
}

function parseTomlTableHeader(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("[")) return null;

  const isArray = trimmed.startsWith("[[");
  let quote = null;
  const start = isArray ? 2 : 1;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (quote) {
      if (quote === '"' && ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (isArray) {
      if (ch !== "]" || trimmed[i + 1] !== "]") continue;
      const rest = trimmed.slice(i + 2).trim();
      if (rest && !rest.startsWith("#")) return null;
      return { name: trimmed.slice(start, i).trim(), array: true };
    }
    if (ch === "]") {
      const rest = trimmed.slice(i + 1).trim();
      if (rest && !rest.startsWith("#")) return null;
      return { name: trimmed.slice(start, i).trim(), array: false };
    }
  }
  return null;
}

function isFeaturesTableHeader(header) {
  return !!header && !header.array && header.name.replace(/\s+/g, "") === "features";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchFeatureBoolean(line, key) {
  const match = String(line || "").match(
    new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(true|false)\\s*(?:#.*)?$`, "i")
  );
  if (!match) return null;
  return match[1].toLowerCase() === "true";
}

function isFeatureAssignment(line, key) {
  return new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, "i").test(String(line || ""));
}

function replaceFeatureKey(line, fromKey, toKey) {
  return String(line || "").replace(
    new RegExp(`^(\\s*)${escapeRegExp(fromKey)}(\\s*=)`, "i"),
    `$1${toKey}$2`
  );
}

function setFeatureBoolean(line, key, value) {
  if (isFeatureAssignment(line, key)) {
    return String(line || "").replace(/=\s*(true|false)\b/i, `= ${value ? "true" : "false"}`);
  }
  return `${key} = ${value ? "true" : "false"}`;
}

function findFeatureAssignments(lines, start, end) {
  const result = {
    hooks: null,
    hooksNonBoolean: null,
    legacy: null,
    legacyNonBoolean: null,
    legacyIndices: [],
  };

  for (let i = start + 1; i < end; i++) {
    const hooksValue = matchFeatureBoolean(lines[i], CODEX_HOOKS_FEATURE_KEY);
    if (hooksValue !== null) {
      if (!result.hooks) result.hooks = { index: i, value: hooksValue };
      continue;
    }
    if (isFeatureAssignment(lines[i], CODEX_HOOKS_FEATURE_KEY)) {
      if (!result.hooksNonBoolean) result.hooksNonBoolean = { index: i };
      continue;
    }

    const legacyValue = matchFeatureBoolean(lines[i], LEGACY_CODEX_HOOKS_FEATURE_KEY);
    if (legacyValue !== null) {
      result.legacyIndices.push(i);
      if (!result.legacy) result.legacy = { index: i, value: legacyValue };
      continue;
    }
    if (isFeatureAssignment(lines[i], LEGACY_CODEX_HOOKS_FEATURE_KEY)) {
      result.legacyIndices.push(i);
      if (!result.legacyNonBoolean) result.legacyNonBoolean = { index: i };
    }
  }

  return result;
}

function removeFeatureLines(lines, indices, keepIndex = -1) {
  let changed = false;
  const unique = [...new Set(indices)]
    .filter((index) => index !== keepIndex)
    .sort((a, b) => b - a);
  for (const index of unique) {
    lines.splice(index, 1);
    changed = true;
  }
  return changed;
}

function writeCodexConfigToml(configPath, lines, newline) {
  const nextText = `${lines.join(newline).replace(/\s*$/, "")}${newline}`;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, nextText, "utf-8");
}

function ensureCodexHooksFeature(configPath, options = {}) {
  const force = !!options.force;
  let text = "";
  try {
    text = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    if (err.code !== "ENOENT") {
      return { changed: false, warning: `Failed to read config.toml: ${err.message}` };
    }
  }

  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text ? text.split(/\r?\n/) : [];
  let featuresStart = -1;
  let featuresEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const section = parseTomlTableHeader(lines[i]);
    if (!section) continue;
    if (isFeaturesTableHeader(section)) {
      featuresStart = i;
      continue;
    }
    if (featuresStart !== -1 && i > featuresStart) {
      featuresEnd = i;
      break;
    }
  }

  if (featuresStart !== -1) {
    const found = findFeatureAssignments(lines, featuresStart, featuresEnd);
    if (found.hooks) {
      let changed = false;
      let warning = null;
      if (!found.hooks.value) {
        if (force) {
          lines[found.hooks.index] = setFeatureBoolean(lines[found.hooks.index], CODEX_HOOKS_FEATURE_KEY, true);
          changed = true;
        } else {
          warning = "config.toml already has [features].hooks = false; leaving Codex hooks disabled.";
        }
      }
      changed = removeFeatureLines(lines, found.legacyIndices, found.hooks.index) || changed;
      if (changed) writeCodexConfigToml(configPath, lines, newline);
      return { changed, warning };
    }

    if (found.hooksNonBoolean) {
      return {
        changed: false,
        warning: "config.toml already has [features].hooks, but it is not a boolean; leaving it unchanged.",
      };
    }

    if (found.legacy) {
      const targetValue = force ? true : found.legacy.value;
      lines[found.legacy.index] = setFeatureBoolean(
        replaceFeatureKey(lines[found.legacy.index], LEGACY_CODEX_HOOKS_FEATURE_KEY, CODEX_HOOKS_FEATURE_KEY),
        CODEX_HOOKS_FEATURE_KEY,
        targetValue
      );
      removeFeatureLines(lines, found.legacyIndices, found.legacy.index);
      writeCodexConfigToml(configPath, lines, newline);
      return {
        changed: true,
        warning: targetValue
          ? null
          : "config.toml already has [features].hooks = false; leaving Codex hooks disabled.",
      };
    }

    if (found.legacyNonBoolean) {
      return {
        changed: false,
        warning: "config.toml already has [features].codex_hooks, but it is not a boolean; leaving it unchanged.",
      };
    }

    lines.splice(featuresStart + 1, 0, "hooks = true");
  } else {
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    lines.push("[features]", "hooks = true");
  }

  writeCodexConfigToml(configPath, lines, newline);
  return { changed: true, warning: null };
}

// includeWindowsVariant widens the match to commandWindows. Registration
// passes it only on win32 hosts: a POSIX host must never claim (and rewrite
// the command of) an entry whose only Clawd trace is a leftover
// commandWindows — that command could be a third-party hook. Uninstall, by
// contrast, always matches both fields: removal must be complete on every
// platform.
function hookMatchesCodexMarker(hook, marker, includeWindowsVariant) {
  return (
    (typeof hook.command === "string" && commandMatchesMarker(hook.command, marker)) ||
    (includeWindowsVariant === true
      && typeof hook.commandWindows === "string"
      && commandMatchesMarker(hook.commandWindows, marker))
  );
}

function findCodexCommandHook(entry, marker, options = {}) {
  if (!entry || typeof entry !== "object") return null;
  const includeWindowsVariant = options.includeWindowsVariant === true;
  const innerHooks = Array.isArray(entry.hooks) ? entry.hooks : [];
  for (const hook of innerHooks) {
    if (!hook || typeof hook !== "object") continue;
    if (hookMatchesCodexMarker(hook, marker, includeWindowsVariant)) return hook;
  }
  if (hookMatchesCodexMarker(entry, marker, includeWindowsVariant)) return entry;
  return null;
}

// Windows-host variant of extractExistingNodeBin: scans command AND
// commandWindows, and only accepts Windows-form absolute paths (drive letter
// or UNC). The POSIX `command` on a Windows host holds a derived /mnt/...
// interop path — extracting that back as the node bin would corrupt
// commandWindows on the next reconcile.
function extractExistingWindowsNodeBin(settings, marker) {
  const hooks = settings && settings.hooks;
  if (!hooks || typeof hooks !== "object") return null;
  const commands = [];
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const inner = Array.isArray(entry.hooks) ? entry.hooks : [entry];
      for (const hook of inner) {
        if (!hook || typeof hook !== "object") continue;
        for (const cmd of [hook.commandWindows, hook.command]) {
          if (typeof cmd === "string" && commandMatchesMarker(cmd, marker)) commands.push(cmd);
        }
      }
    }
  }
  for (const cmd of commands) {
    for (const match of cmd.matchAll(/"([^"]+)"/g)) {
      const token = match[1];
      if (!token || token.includes(marker)) continue;
      if (/^[A-Za-z]:[\\/]/.test(token) || token.startsWith("\\\\")) return token;
    }
  }
  return null;
}

// Local dual-field variant of removeMatchingCommandHooks: uninstall must
// remove a hook when EITHER command or commandWindows carries the marker —
// a hand-edited command must not shield a still-live commandWindows from
// removal, on any platform. The shared helper only inspects command and
// stays single-field for agents that never write commandWindows.
function removeCodexCommandHooks(entries, predicate) {
  if (!Array.isArray(entries)) return { entries, removed: 0, changed: false };
  const hookMatches = (hook) =>
    (typeof hook.command === "string" && predicate(hook.command))
    || (typeof hook.commandWindows === "string" && predicate(hook.commandWindows));

  let removed = 0;
  let changed = false;
  const nextEntries = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      nextEntries.push(entry);
      continue;
    }

    if (hookMatches(entry)) {
      removed++;
      changed = true;
      continue;
    }

    if (!Array.isArray(entry.hooks)) {
      nextEntries.push(entry);
      continue;
    }

    const nextHooks = entry.hooks.filter((hook) => {
      if (!hook || typeof hook !== "object") return true;
      if (!hookMatches(hook)) return true;
      removed++;
      changed = true;
      return false;
    });

    if (nextHooks.length === entry.hooks.length) {
      nextEntries.push(entry);
      continue;
    }

    if (
      nextHooks.length === 0
      && typeof entry.command !== "string"
      && typeof entry.commandWindows !== "string"
    ) continue;
    nextEntries.push({ ...entry, hooks: nextHooks });
  }

  return { entries: nextEntries, removed, changed };
}

function registerCodexCommandHooks(options = {}) {
  const marker = options.marker;
  const scriptName = options.scriptName || marker;
  const events = Array.isArray(options.events) ? options.events : CODEX_HOOK_EVENTS;
  if (!marker || !scriptName) throw new Error("registerCodexCommandHooks requires marker and scriptName");

  const { codexDir, hooksPath, configPath } = getCodexPaths(options);
  if (!options.hooksPath && !options.codexDir && !fs.existsSync(codexDir)) {
    if (!options.silent) console.log("Clawd: ~/.codex/ not found - skipping Codex hook registration");
    return { added: 0, skipped: 0, updated: 0, configChanged: false, warnings: [] };
  }

  const warnings = [];
  const feature = ensureCodexHooksFeature(configPath, {
    force: options.forceCodexHooksFeature === true,
  });
  if (feature.warning) warnings.push(feature.warning);

  const hookScript = asarUnpackedPath(path.resolve(__dirname, scriptName).replace(/\\/g, "/"));
  const settings = readJsonIfPresent(hooksPath, "hooks.json");
  const hostPlatform = options.platform || process.platform;
  const isWindowsHost = hostPlatform === "win32";
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved
    || (isWindowsHost
      ? extractExistingWindowsNodeBin(settings, marker)
      : extractExistingNodeBin(settings, marker, { nested: true }))
    || "node";
  const commandEnv = {
    ...(options.env || {}),
    ...(options.remote ? { CLAWD_REMOTE: "1" } : {}),
  };
  // On a Windows host, a WSL session may consume this hooks.json through a
  // shared CODEX_HOME (#544). Codex resolves `commandWindows` on Windows and
  // `command` on POSIX, so write both: keep the PowerShell form in
  // commandWindows (unchanged from what `command` used to hold, so existing
  // Windows installs keep their trusted_hash) and put a WSL-interop form in
  // `command`. Note codex builds before openai/codex#22159 (2026-05) ignore
  // commandWindows and would run the POSIX form on Windows.
  const desiredCommandWindows = isWindowsHost
    ? withCommandEnv(buildCodexHookCommand(nodeBin, hookScript, "win32"), commandEnv, "win32")
    : null;
  const desiredCommand = isWindowsHost
    ? buildCodexHookPosixInteropCommand(nodeBin, hookScript)
    : withCommandEnv(buildCodexHookCommand(nodeBin, hookScript, hostPlatform), commandEnv, hostPlatform);
  // Gate the warning on the same filter withCommandEnv applies, so an env
  // object that contributes nothing (invalid keys / nullish values) doesn't
  // emit a false warning — repairCodexHooks escalates any warning to error.
  if (isWindowsHost && filterCommandEnvEntries(commandEnv).length) {
    warnings.push(
      "Env vars don't cross the WSL interop boundary; they were applied to commandWindows only."
    );
  }

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  let added = 0;
  let skipped = 0;
  let updated = 0;
  let changed = false;

  for (const event of events) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      changed = true;
    }

    const arr = settings.hooks[event];
    let found = false;
    let stale = false;
    const desiredTimeout = timeoutForCodexEvent(event);

    for (const entry of arr) {
      const hook = findCodexCommandHook(entry, marker, { includeWindowsVariant: isWindowsHost });
      if (!hook) continue;
      found = true;
      if (hook.type !== "command") {
        hook.type = "command";
        stale = true;
      }
      // On win32 an entry can be claimed through commandWindows alone. If
      // its command string no longer carries the marker, the user replaced
      // it deliberately (e.g. interop unavailable in their WSL) — keep
      // their fix and keep managing commandWindows only. Rewriting it here
      // would recreate the exact "reconcile wipes my manual fix" loop #544
      // reported.
      const commandHandEdited = isWindowsHost
        && typeof hook.command === "string"
        && hook.command !== ""
        && !commandMatchesMarker(hook.command, marker);
      if (!commandHandEdited && hook.command !== desiredCommand) {
        hook.command = desiredCommand;
        stale = true;
      }
      if (isWindowsHost && hook.commandWindows !== desiredCommandWindows) {
        hook.commandWindows = desiredCommandWindows;
        stale = true;
      }
      if (hook.timeout !== desiredTimeout) {
        hook.timeout = desiredTimeout;
        stale = true;
      }
      break;
    }

    if (found) {
      if (stale) {
        updated++;
        changed = true;
      } else {
        skipped++;
      }
      continue;
    }

    const newHook = isWindowsHost
      ? { type: "command", command: desiredCommand, commandWindows: desiredCommandWindows, timeout: desiredTimeout }
      : { type: "command", command: desiredCommand, timeout: desiredTimeout };
    arr.push({ hooks: [newHook] });
    added++;
    changed = true;
  }

  if (changed) writeJsonAtomic(hooksPath, settings);

  if (!options.silent) {
    const label = options.label || "Codex hooks";
    console.log(`Clawd ${label} -> ${hooksPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
    if (feature.changed) console.log(`  Updated [features].hooks in ${configPath}`);
    for (const warning of warnings) console.warn(`  Warning: ${warning}`);
    // Codex requires the user to review each new/changed hook command in the
    // TUI before it activates (sha256 trusted_hash gate written to
    // [hooks.state] in config.toml). Surface this so users don't get the
    // "tunnel connected, hooks installed, but desktop pet still silent"
    // dead zone the first time they launch codex post-install.
    if (added > 0 || updated > 0 || feature.changed) {
      console.log("");
      console.log("  Next step: open codex CLI and run /hooks to review and");
      console.log("  activate the new/updated hooks (otherwise they stay inactive).");
    }
  }

  return { added, skipped, updated, configChanged: feature.changed, warnings };
}

function unregisterCodexCommandHooks(options = {}) {
  const markers = Array.isArray(options.markers)
    ? options.markers.filter((marker) => typeof marker === "string" && marker)
    : [options.marker].filter((marker) => typeof marker === "string" && marker);
  const events = Array.isArray(options.events) ? options.events : CODEX_HOOK_EVENTS;
  if (!markers.length) throw new Error("unregisterCodexCommandHooks requires marker");

  const { hooksPath } = getCodexPaths(options);
  let settings;
  try {
    settings = readJsonFile(hooksPath);
  } catch (err) {
    if (err.code === "ENOENT") return { removed: 0 };
    throw new Error(`Failed to read hooks.json: ${err.message}`);
  }
  if (!settings.hooks || typeof settings.hooks !== "object") return { removed: 0 };

  let removed = 0;
  let changed = false;
  for (const event of events) {
    const arr = settings.hooks[event];
    if (!Array.isArray(arr)) continue;
    const result = removeCodexCommandHooks(arr, (command) =>
      markers.some((marker) => commandMatchesMarker(command, marker))
    );
    if (result.changed) {
      removed += result.removed;
      if (result.entries.length > 0) settings.hooks[event] = result.entries;
      else delete settings.hooks[event];
      changed = true;
    }
  }

  let backupPath = null;
  if (changed) backupPath = writeJsonAtomicWithBackup(hooksPath, settings, options);
  if (!options.silent) console.log(`Clawd Codex hooks removed: ${removed}`);
  const result = { removed, changed };
  if (options.backup === true) result.backupPath = backupPath;
  return result;
}

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  DEFAULT_FEATURES_CONFIG,
  CODEX_HOOK_EVENTS,
  CODEX_HOOKS_FEATURE_KEY,
  LEGACY_CODEX_HOOKS_FEATURE_KEY,
  buildCodexHookCommand,
  buildCodexHookPosixInteropCommand,
  ensureCodexHooksFeature,
  extractExistingWindowsNodeBin,
  findCodexCommandHook,
  parseTomlTableHeader,
  registerCodexCommandHooks,
  timeoutForCodexEvent,
  unregisterCodexCommandHooks,
  windowsPathToWslPath,
  withCommandEnv,
};
