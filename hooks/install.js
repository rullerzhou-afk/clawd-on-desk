#!/usr/bin/env node
// Clawd Desktop Pet — Hook Installer
// Safely merges hook commands into ~/.claude/settings.json
// Does NOT overwrite existing hooks — appends to arrays

const fs = require("fs");
const path = require("path");
const os = require("os");
const { buildPermissionUrl, DEFAULT_SERVER_PORT, PERMISSION_PATH, readRuntimePort, resolveNodeBin } = require("./server-config");
const { writeJsonAtomic, asarUnpackedPath } = require("./json-utils");

// Hooks supported by all Claude Code versions
const CORE_HOOKS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "Notification",
  // PermissionRequest: handled by HTTP_HOOKS (blocking), not command hook
  "Elicitation",
];

// Events we used to register but shouldn't anymore. WorktreeCreate is a
// work-performing hook (must print the new worktree path to stdout) — our
// notification-only handler broke `claude -w` with "no successful output".
// Reported by @IsuminI in issue #127.
const DEPRECATED_CORE_HOOKS = ["WorktreeCreate"];

// Hooks that require a minimum Claude Code version
const VERSIONED_HOOKS = [
  { event: "PreCompact",  minVersion: "2.1.76" },
  { event: "PostCompact", minVersion: "2.1.76" },
  { event: "StopFailure", minVersion: "2.1.78" },
];

const CLAUDE_VERSION_PATTERN = /(\d+\.\d+\.\d+)/;
const CLAUDE_PACKAGE_JSON_SEGMENTS = ["node_modules", "@anthropic-ai", "claude-code", "package.json"];
const CLAUDE_SHIM_CLI_PATTERN = /node_modules[\\/]+@anthropic-ai[\\/]+claude-code[\\/]+cli\.js/i;
const MAX_CLAUDE_SHIM_BYTES = 64 * 1024;
const UNKNOWN_CLAUDE_VERSION = Object.freeze({
  version: null,
  source: null,
  status: "unknown",
});

/**
 * Compare two semver strings: return true if a < b.
 */
function versionLessThan(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return true;
    if ((pa[i] || 0) > (pb[i] || 0)) return false;
  }
  return false;
}

function parseClaudeVersion(value) {
  if (typeof value !== "string") return null;
  const match = value.match(CLAUDE_VERSION_PATTERN);
  return match ? match[1] : null;
}

function getWindowsClaudePathSuffixes(pathExtEnv) {
  const suffixes = [""];
  const addSuffix = (value) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const normalized = trimmed.startsWith(".") ? trimmed.toLowerCase() : `.${trimmed.toLowerCase()}`;
    if (!suffixes.includes(normalized)) suffixes.push(normalized);
  };

  addSuffix(".cmd");
  addSuffix(".ps1");

  if (typeof pathExtEnv === "string") {
    for (const entry of pathExtEnv.split(";")) {
      addSuffix(entry);
    }
  }

  return suffixes;
}

function getClaudePathCandidates(options = {}) {
  const platform = options.platform || process.platform;
  const pathEnv = options.pathEnv !== undefined ? options.pathEnv : process.env.PATH;
  const existsSync = options.existsSync || fs.existsSync;

  if (typeof pathEnv !== "string" || !pathEnv) return [];

  const suffixes = platform === "win32"
    ? getWindowsClaudePathSuffixes(options.pathExt !== undefined ? options.pathExt : process.env.PATHEXT)
    : [""];
  const delimiter = platform === "win32" ? ";" : ":";
  const candidates = [];
  const seen = new Set();

  for (const rawDir of pathEnv.split(delimiter)) {
    if (typeof rawDir !== "string") continue;
    const dir = rawDir.trim().replace(/^"(.*)"$/, "$1");
    if (!dir) continue;

    for (const suffix of suffixes) {
      const candidate = path.join(dir, `claude${suffix}`);
      const key = platform === "win32" ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) continue;
      seen.add(key);

      try {
        if (existsSync(candidate)) candidates.push(candidate);
      } catch {}
    }
  }

  return candidates;
}

function getClaudePackageJsonCandidates(candidatePath, options = {}) {
  const platform = options.platform || process.platform;
  const existsSync = options.existsSync || fs.existsSync;
  const readFileSync = options.readFileSync || fs.readFileSync;
  const realpathSync = options.realpathSync || fs.realpathSync;
  const statSync = options.statSync || fs.statSync;

  if (!path.isAbsolute(candidatePath)) return [];

  const candidates = [];
  const seen = new Set();
  const addCandidate = (packageJsonPath) => {
    if (typeof packageJsonPath !== "string" || !packageJsonPath) return;
    const key = platform === "win32" ? packageJsonPath.toLowerCase() : packageJsonPath;
    if (seen.has(key)) return;
    seen.add(key);

    try {
      if (existsSync(packageJsonPath)) candidates.push(packageJsonPath);
    } catch {}
  };

  const candidateDir = path.dirname(candidatePath);
  addCandidate(path.join(candidateDir, ...CLAUDE_PACKAGE_JSON_SEGMENTS));

  try {
    const resolvedPath = realpathSync(candidatePath);
    addCandidate(path.join(path.dirname(resolvedPath), "package.json"));
  } catch {}

  try {
    const stat = statSync(candidatePath);
    const isRegularFile = typeof stat.isFile === "function" ? stat.isFile() : true;
    // npm shims are tiny; skip unusually large files rather than reading arbitrary PATH entries into memory.
    if (isRegularFile && typeof stat.size === "number" && stat.size <= MAX_CLAUDE_SHIM_BYTES) {
      const shimSource = readFileSync(candidatePath, "utf8");
      const shimMatch = shimSource.match(CLAUDE_SHIM_CLI_PATTERN);
      if (shimMatch) {
        const cliPath = path.resolve(candidateDir, shimMatch[0].replace(/[\\/]/g, path.sep));
        addCandidate(path.join(path.dirname(cliPath), "package.json"));
      }
    }
  } catch {}

  return candidates;
}

function getClaudeVersionFromPackageJson(packageJsonPath, options = {}) {
  const readFileSync = options.readFileSync || fs.readFileSync;

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const version = parseClaudeVersion(packageJson.version);
    if (!version) return null;
    return {
      version,
      source: packageJsonPath,
      status: "known",
    };
  } catch {
    return null;
  }
}

function readClaudeVersionFallback(candidatePath, options = {}) {
  for (const packageJsonPath of getClaudePackageJsonCandidates(candidatePath, options)) {
    const versionInfo = getClaudeVersionFromPackageJson(packageJsonPath, options);
    if (versionInfo) return versionInfo;
  }
  return null;
}

/**
 * Detect installed Claude Code version.
 * On macOS, try known absolute install paths before falling back to PATH.
 * Returns an object describing the result so callers can fail closed.
 */
function getClaudeVersion(options = {}) {
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  const execFileSync = options.execFileSync || require("child_process").execFileSync;
  const candidates = [];

  if (platform === "darwin") {
    candidates.push(
      path.join(homeDir, ".local", "bin", "claude"),
      path.join(homeDir, ".claude", "local", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude"
    );
  }
  candidates.push(...getClaudePathCandidates(options));
  candidates.push("claude");

  const seen = new Set();
  let fallbackInfo = null;
  for (const candidate of candidates) {
    const key = platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const out = execFileSync(candidate, ["--version"], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });
      const version = parseClaudeVersion(out);
      if (!version) continue;
      return {
        version,
        source: candidate === "claude" ? "PATH:claude" : candidate,
        status: "known",
      };
    } catch {}

    const fallback = readClaudeVersionFallback(candidate, options);
    // Prefer a candidate that can answer `--version` directly; keep the first metadata
    // fallback in search order, but continue scanning in case a later executable works.
    if (fallback && !fallbackInfo) fallbackInfo = fallback;
  }
  return fallbackInfo || { ...UNKNOWN_CLAUDE_VERSION };
}

const MARKER = "clawd-hook.js";
const AUTO_START_MARKER = "auto-start.js";
const LEGACY_AUTO_START_MARKER = "auto-start.sh";
const HTTP_MARKER = PERMISSION_PATH;

/**
 * Extract the node binary path from existing hook commands in settings.
 * Looks for the first quoted absolute path before `marker` in any hook command.
 * Returns the path (e.g. "/opt/homebrew/bin/node") or null.
 */
function extractNodeBinFromSettings(settings, marker) {
  if (!settings || !settings.hooks) return null;
  for (const entries of Object.values(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const cmds = [];
      if (typeof entry.command === "string") cmds.push(entry.command);
      if (Array.isArray(entry.hooks)) {
        for (const h of entry.hooks) {
          if (h && typeof h.command === "string") cmds.push(h.command);
        }
      }
      for (const cmd of cmds) {
        if (!cmd.includes(marker)) continue;
        // Find first quoted token: "something"
        const qi = cmd.indexOf('"');
        if (qi === -1) continue;
        const qe = cmd.indexOf('"', qi + 1);
        if (qe === -1) continue;
        const firstQuoted = cmd.substring(qi + 1, qe);
        // If first quoted token IS the hook script (old format), node was bare — nothing to preserve
        if (firstQuoted.includes(marker)) continue;
        // Only preserve absolute paths
        if (firstQuoted.startsWith("/")) return firstQuoted;
      }
    }
  }
  return null;
}

function forEachCommandHook(entries, visitor) {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.command === "string") {
      visitor(entry.command, (next) => { entry.command = next; });
    }
    if (Array.isArray(entry.hooks)) {
      for (const hook of entry.hooks) {
        if (!hook || typeof hook !== "object" || typeof hook.command !== "string") continue;
        visitor(hook.command, (next) => { hook.command = next; });
      }
    }
  }
}

function syncCommandHook(entries, marker, expectedCommand) {
  let found = false;
  let changed = false;
  forEachCommandHook(entries, (command, update) => {
    if (!command.includes(marker)) return;
    found = true;
    if (command !== expectedCommand) {
      update(expectedCommand);
      changed = true;
    }
  });
  return { found, changed };
}

function isClawdPermissionUrl(url) {
  if (typeof url !== "string" || !url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:"
      && parsed.hostname === "127.0.0.1"
      && parsed.pathname === HTTP_MARKER;
  } catch {
    return false;
  }
}

function isClawdPermissionHook(entry) {
  return !!entry
    && typeof entry === "object"
    && entry.type === "http"
    && typeof entry.url === "string"
    && isClawdPermissionUrl(entry.url);
}

function removeMatchingCommandHooks(entries, predicate) {
  if (!Array.isArray(entries)) return { entries, removed: 0, changed: false };

  let removed = 0;
  let changed = false;
  const nextEntries = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      nextEntries.push(entry);
      continue;
    }

    if (typeof entry.command === "string" && predicate(entry.command)) {
      removed++;
      changed = true;
      continue;
    }

    if (!Array.isArray(entry.hooks)) {
      nextEntries.push(entry);
      continue;
    }

    const nextHooks = entry.hooks.filter((hook) => {
      if (!hook || typeof hook !== "object" || typeof hook.command !== "string") return true;
      if (!predicate(hook.command)) return true;
      removed++;
      changed = true;
      return false;
    });

    if (nextHooks.length === entry.hooks.length) {
      nextEntries.push(entry);
      continue;
    }

    if (nextHooks.length === 0 && typeof entry.command !== "string") {
      continue;
    }

    nextEntries.push({ ...entry, hooks: nextHooks });
  }

  return { entries: nextEntries, removed, changed };
}

function removeMatchingHttpHooks(entries, predicate) {
  if (!Array.isArray(entries)) return { entries, removed: 0, changed: false };

  let removed = 0;
  let changed = false;
  const nextEntries = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      nextEntries.push(entry);
      continue;
    }

    if (isClawdPermissionHook(entry) && predicate(entry)) {
      removed++;
      changed = true;
      continue;
    }

    if (!Array.isArray(entry.hooks)) {
      nextEntries.push(entry);
      continue;
    }

    const nextHooks = entry.hooks.filter((hook) => {
      if (!isClawdPermissionHook(hook)) return true;
      if (!predicate(hook)) return true;
      removed++;
      changed = true;
      return false;
    });

    if (nextHooks.length === entry.hooks.length) {
      nextEntries.push(entry);
      continue;
    }

    if (nextHooks.length === 0 && typeof entry.command !== "string" && entry.type !== "http") {
      continue;
    }

    nextEntries.push({ ...entry, hooks: nextHooks });
  }

  return { entries: nextEntries, removed, changed };
}

function syncHttpHook(entries, expectedUrl) {
  let found = false;
  let changed = false;
  if (!Array.isArray(entries)) return { found, changed };
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (isClawdPermissionHook(entry)) {
      found = true;
      if (entry.url !== expectedUrl) {
        entry.url = expectedUrl;
        changed = true;
      }
    }
    if (!Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (!isClawdPermissionHook(hook)) continue;
      found = true;
      if (hook.url !== expectedUrl) {
        hook.url = expectedUrl;
        changed = true;
      }
    }
  }
  return { found, changed };
}

function getHookServerPort(explicitPort) {
  return Number.isInteger(explicitPort) ? explicitPort : (readRuntimePort() || DEFAULT_SERVER_PORT);
}

// HTTP hooks: PermissionRequest uses bidirectional HTTP hook for permission decisions.
// Claude Code fires PermissionRequest for tools needing approval (primarily Bash).
// Edit/Write permissions are handled by Claude Code's own permission mode — not our hook.
const HTTP_HOOKS = {
  PermissionRequest: {
    matcher: "",
    hook: {
      type: "http",
      url: "http://127.0.0.1:23333/permission",
      timeout: 600,
    },
  },
};

function getSupportedVersionedHooks(versionInfo) {
  const supported = [];
  const unsupported = [];

  for (const hook of VERSIONED_HOOKS) {
    const isSupported = (
      versionInfo.status === "known" &&
      !versionLessThan(versionInfo.version, hook.minVersion)
    );
    if (isSupported) supported.push(hook);
    else unsupported.push(hook);
  }

  return { supported, unsupported };
}

function shouldReconcileVersionedHooks(versionInfo) {
  return versionInfo.status === "known";
}

function reconcileVersionedHooks(settings, supportedEvents, versionInfo) {
  let removed = 0;
  let changed = false;
  if (!shouldReconcileVersionedHooks(versionInfo)) {
    return { removed, changed };
  }

  for (const { event } of VERSIONED_HOOKS) {
    if (supportedEvents.has(event)) continue;
    if (!Array.isArray(settings.hooks[event])) continue;
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
      changed = true;
      continue;
    }

    const result = removeMatchingCommandHooks(
      settings.hooks[event],
      (command) => command.includes(MARKER)
    );

    if (!result.changed) continue;

    removed += result.removed;
    changed = true;
    if (result.entries.length > 0) settings.hooks[event] = result.entries;
    else delete settings.hooks[event];
  }

  return { removed, changed };
}

/**
 * Register Clawd hooks into ~/.claude/settings.json.
 * Safe to call multiple times — skips already-registered hooks.
 * @param {object} [options]
 * @param {boolean} [options.silent] - suppress console output (for auto-registration)
 * @param {boolean} [options.autoStart] - register auto-start hook for SessionStart
 * @param {string} [options.settingsPath] - internal override for tests
 * @param {{ version: string|null, source: string|null, status: "known"|"unknown" }} [options.claudeVersionInfo]
 * @returns {{ added: number, skipped: number, updated: number, removed: number, version: string|null, versionStatus: "known"|"unknown", versionSource: string|null }}
 */
function registerHooks(options = {}) {
  const settingsPath = options.settingsPath || path.join(os.homedir(), ".claude", "settings.json");
  const hookPort = getHookServerPort(options.port);
  const hookScript = asarUnpackedPath(path.resolve(__dirname, "clawd-hook.js").replace(/\\/g, "/"));

  // Read existing settings
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read settings.json: ${err.message}`);
    }
  }

  if (!settings.hooks) settings.hooks = {};

  // Resolve absolute node path — on macOS/Linux, Claude Code runs hooks with
  // a minimal PATH that excludes Homebrew, nvm, volta, etc.
  // If detection fails (null), preserve the existing absolute path from settings
  // to avoid destructively overwriting a working config with bare "node".
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved
    || extractNodeBinFromSettings(settings, MARKER)
    || "node";

  let added = 0;
  let skipped = 0;
  let versionSkipped = 0;
  let updated = 0;
  let removed = 0;
  let changed = false;

  // Detect CC version for versioned hooks filtering
  const versionInfo = options.claudeVersionInfo || getClaudeVersion();
  const { supported: supportedVersionedHooks, unsupported: unsupportedVersionedHooks } =
    getSupportedVersionedHooks(versionInfo);
  const supportedVersionedEvents = new Set(supportedVersionedHooks.map((hook) => hook.event));
  versionSkipped = unsupportedVersionedHooks.length;

  const reconcileResult = reconcileVersionedHooks(settings, supportedVersionedEvents, versionInfo);
  removed += reconcileResult.removed;
  changed = changed || reconcileResult.changed;

  // Remove deprecated hooks we used to register. Match by MARKER so user-authored
  // hooks for the same event are preserved untouched. See issue #127.
  for (const event of DEPRECATED_CORE_HOOKS) {
    if (!Array.isArray(settings.hooks[event])) continue;
    const result = removeMatchingCommandHooks(
      settings.hooks[event],
      (command) => command.includes(MARKER)
    );
    if (!result.changed) continue;
    removed += result.removed;
    changed = true;
    if (result.entries.length > 0) settings.hooks[event] = result.entries;
    else delete settings.hooks[event];
  }

  // Build the full hook list: core + version-compatible hooks
  const hookEvents = [...CORE_HOOKS];
  for (const { event } of supportedVersionedHooks) {
    hookEvents.push(event);
  }

  for (const event of hookEvents) {
    if (!Array.isArray(settings.hooks[event])) {
      // Preserve existing non-array config by wrapping it
      const existing = settings.hooks[event];
      settings.hooks[event] = existing && typeof existing === "object" ? [existing] : [];
      changed = true;  // format was normalized, need to persist
    }

    // Check if our hook is already registered (search nested hooks arrays too)
    // Remote mode: prepend CLAWD_REMOTE=1 so the hook skips PID collection
    const desiredCommand = options.remote
      ? `CLAWD_REMOTE=1 "${nodeBin}" "${hookScript}" ${event}`
      : `"${nodeBin}" "${hookScript}" ${event}`;
    const commandSync = syncCommandHook(settings.hooks[event], MARKER, desiredCommand);
    if (commandSync.found) {
      if (commandSync.changed) {
        updated++;
        changed = true;
      } else {
        skipped++;
      }
      continue;
    }

    // Use nested format to match Claude Code's expected structure
    settings.hooks[event].push({
      matcher: "",
      hooks: [
        {
          type: "command",
          command: desiredCommand,
        },
      ],
    });
    added++;
  }

  // Register auto-start hook for SessionStart (launches app if not running)
  if (options.autoStart) {
    const autoStartScript = asarUnpackedPath(path.resolve(__dirname, "auto-start.js").replace(/\\/g, "/"));

    if (!Array.isArray(settings.hooks.SessionStart)) {
      settings.hooks.SessionStart = [];
      changed = true;
    }

    const autoStartCommand = `"${nodeBin}" "${autoStartScript}"`;
    const autoStartSync = syncCommandHook(settings.hooks.SessionStart, AUTO_START_MARKER, autoStartCommand);
    if (!autoStartSync.found) {
      // Insert at index 0 — must run BEFORE clawd-hook.js so the app is starting
      settings.hooks.SessionStart.unshift({
        matcher: "",
        hooks: [{ type: "command", command: autoStartCommand }],
      });
      added++;
    } else if (autoStartSync.changed) {
      updated++;
      changed = true;
    } else {
      skipped++;
    }

    // Remove all legacy auto-start.sh entries if present
    const beforeLen = settings.hooks.SessionStart.length;
    settings.hooks.SessionStart = settings.hooks.SessionStart.filter((entry) => {
      if (!entry || typeof entry !== "object") return true;
      if (typeof entry.command === "string" && entry.command.includes(LEGACY_AUTO_START_MARKER)) return false;
      if (Array.isArray(entry.hooks)) {
        if (entry.hooks.some((h) => h && typeof h.command === "string" && h.command.includes(LEGACY_AUTO_START_MARKER))) return false;
      }
      return true;
    });
    if (settings.hooks.SessionStart.length < beforeLen) changed = true;
  }

  // Clean up stale command hooks for HTTP-only events (e.g. PermissionRequest).
  // Old versions or manual edits may have registered a command hook alongside the
  // HTTP hook, causing Claude Code to fire both and produce duplicate bubbles.
  for (const event of Object.keys(HTTP_HOOKS)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    const result = removeMatchingCommandHooks(
      settings.hooks[event],
      (command) => command.includes(MARKER)
    );
    if (result.changed) {
      settings.hooks[event] = result.entries;
      removed += result.removed;
      changed = true;
    }
  }

  // Register HTTP hooks (permission decision collection)
  for (const [event, { matcher, hook }] of Object.entries(HTTP_HOOKS)) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      changed = true;
    }

    const desiredHook = { ...hook, url: buildPermissionUrl(hookPort) };
    const httpSync = syncHttpHook(settings.hooks[event], desiredHook.url);
    if (httpSync.found) {
      if (httpSync.changed) {
        updated++;
        changed = true;
      } else {
        skipped++;
      }
      continue;
    }

    settings.hooks[event].push({
      matcher,
      hooks: [desiredHook],
    });
    added++;
  }

  // Only write if something changed (avoid unnecessary disk I/O)
  if (added > 0 || changed) {
    writeJsonAtomic(settingsPath, settings);
  }

  if (!options.silent) {
    const versionLabel = versionInfo.status === "known" ? versionInfo.version : "unknown";
    const versionSource = versionInfo.source || "unavailable";
    console.log(`Clawd hooks installed to ${settingsPath}`);
    console.log(`  Claude Code version: ${versionLabel}`);
    console.log(`  Detection source: ${versionSource}`);
    if (versionInfo.status === "unknown") {
      console.log("  Versioned hooks: disabled (Claude Code version could not be detected)");
    }
    console.log(`  Added: ${added} hooks`);
    if (updated > 0) console.log(`  Updated: ${updated} stale hook paths`);
    if (removed > 0) console.log(`  Removed: ${removed} incompatible versioned hooks`);
    if (skipped > 0) console.log(`  Skipped: ${skipped} (already registered)`);
    if (versionSkipped > 0) {
      const reason = versionInfo.status === "known"
        ? `version too old for ${unsupportedVersionedHooks.map((hook) => hook.event).join(", ")}`
        : "version unknown, versioned hooks disabled";
      console.log(`  Skipped: ${versionSkipped} (${reason})`);
    }
    console.log(`\nHook events: ${hookEvents.join(", ")}`);
    if (Object.keys(HTTP_HOOKS).length > 0) {
      console.log(`HTTP hooks: ${Object.keys(HTTP_HOOKS).join(", ")}`);
    }
  }

  return {
    added,
    skipped,
    updated,
    removed,
    version: versionInfo.version,
    versionStatus: versionInfo.status,
    versionSource: versionInfo.source,
  };
}

function unregisterHooks(options = {}) {
  const settingsPath = options.settingsPath || path.join(os.homedir(), ".claude", "settings.json");
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return { removed: 0, changed: false };
    throw new Error(`Failed to read settings.json: ${err.message}`);
  }

  if (!settings.hooks || typeof settings.hooks !== "object") {
    return { removed: 0, changed: false };
  }

  let removed = 0;
  let changed = false;
  for (const [event, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries)) continue;

    const commandResult = removeMatchingCommandHooks(
      entries,
      (command) => command.includes(MARKER)
        || command.includes(AUTO_START_MARKER)
        || command.includes(LEGACY_AUTO_START_MARKER)
    );
    const httpResult = removeMatchingHttpHooks(
      commandResult.entries,
      (hook) => isClawdPermissionHook(hook)
    );

    if (!commandResult.changed && !httpResult.changed) continue;

    removed += commandResult.removed + httpResult.removed;
    changed = true;
    if (httpResult.entries.length > 0) settings.hooks[event] = httpResult.entries;
    else delete settings.hooks[event];
  }

  if (changed) {
    writeJsonAtomic(settingsPath, settings);
  }

  return { removed, changed };
}

/**
 * Remove the auto-start hook from SessionStart in ~/.claude/settings.json.
 * Also removes legacy auto-start.sh entries.
 * @returns {boolean} true if a hook was removed
 */
function unregisterAutoStart() {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch {
    return false;
  }

  const arr = settings.hooks && settings.hooks.SessionStart;
  if (!Array.isArray(arr)) return false;

  const before = arr.length;
  settings.hooks.SessionStart = arr.filter((entry) => {
    if (!entry || typeof entry !== "object") return true;
    // Remove auto-start.js entries
    if (typeof entry.command === "string" && entry.command.includes(AUTO_START_MARKER)) return false;
    if (Array.isArray(entry.hooks)) {
      if (entry.hooks.some((h) => h && typeof h.command === "string" && h.command.includes(AUTO_START_MARKER))) return false;
    }
    // Remove legacy auto-start.sh entries
    if (typeof entry.command === "string" && entry.command.includes(LEGACY_AUTO_START_MARKER)) return false;
    if (Array.isArray(entry.hooks)) {
      if (entry.hooks.some((h) => h && typeof h.command === "string" && h.command.includes(LEGACY_AUTO_START_MARKER))) return false;
    }
    return true;
  });

  if (settings.hooks.SessionStart.length < before) {
    writeJsonAtomic(settingsPath, settings);
    return true;
  }
  return false;
}

/**
 * Check if the auto-start hook is currently registered in settings.json.
 * @returns {boolean}
 */
function isAutoStartRegistered() {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const arr = settings.hooks && settings.hooks.SessionStart;
    if (!Array.isArray(arr)) return false;
    return arr.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      if (typeof entry.command === "string" && entry.command.includes(AUTO_START_MARKER)) return true;
      if (Array.isArray(entry.hooks)) {
        return entry.hooks.some((h) => h && typeof h.command === "string" && h.command.includes(AUTO_START_MARKER));
      }
      return false;
    });
  } catch {
    return false;
  }
}

// Export for use by main.js
module.exports = {
  registerHooks,
  unregisterHooks,
  unregisterAutoStart,
  isAutoStartRegistered,
  __test: {
    parseClaudeVersion,
    getWindowsClaudePathSuffixes,
    getClaudePathCandidates,
    getClaudePackageJsonCandidates,
    getClaudeVersionFromPackageJson,
    readClaudeVersionFallback,
    getClaudeVersion,
    isClawdPermissionHook,
    isClawdPermissionUrl,
    removeMatchingHttpHooks,
    versionLessThan,
    removeMatchingCommandHooks,
    reconcileVersionedHooks,
    shouldReconcileVersionedHooks,
  },
};

// CLI: run directly with `node hooks/install.js [--remote]`
if (require.main === module) {
  try {
    const remote = process.argv.includes("--remote");
    registerHooks({ remote });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
