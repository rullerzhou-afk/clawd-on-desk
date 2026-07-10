#!/usr/bin/env node
// Merge Clawd Kimi hooks into the Kimi CLI config (append-only, idempotent).
//
// Two hook targets exist since the upstream generation change (#563):
//   - legacy Kimi CLI (Python):    ~/.kimi/config.toml
//   - Kimi Code (TypeScript CLI):  ~/.kimi-code/config.toml
// Both use the same TOML [[hooks]] shape, but they differ in event set,
// command format (see below) and how strict the config schema is.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { resolveNodeBin } = require("./server-config");
const {
  asarUnpackedPath,
  extractExistingNodeBinFromCommands,
  readTextFileStripBom,
  resolveWslDistroEnv,
  writeTextAtomicWithBackup,
} = require("./json-utils");
const MARKER = "kimi-hook.js";
const MODE_EXPLICIT = "explicit";
const MODE_SUSPECT = "suspect";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".kimi");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "config.toml");
// Kimi Code home. Honors KIMI_CODE_HOME the same way the CLI does
// (apps/kimi-code/src/utils/paths.ts) so hooks land in the config the CLI
// actually reads. Resolved at module load; changing the env var requires a
// Clawd restart, matching how the CLI itself picks it up per process.
const KIMI_CODE_PARENT_DIR =
  typeof process.env.KIMI_CODE_HOME === "string" && process.env.KIMI_CODE_HOME.trim()
    ? process.env.KIMI_CODE_HOME.trim()
    : path.join(os.homedir(), ".kimi-code");
const KIMI_CODE_CONFIG_PATH = path.join(KIMI_CODE_PARENT_DIR, "config.toml");

const KIMI_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "Notification",
];

// Kimi Code additions: native permission events (replace the legacy
// PreToolUse suspect/explicit heuristic) and the Esc interrupt.
const KIMI_CODE_HOOK_EVENTS = [
  ...KIMI_HOOK_EVENTS,
  "PermissionRequest",
  "PermissionResult",
  "Interrupt",
];

const FLAVOR_LEGACY = "legacy";
const FLAVOR_KIMI_CODE = "kimi-code";

// Kimi Code's HookDefSchema is z.strict(): any unknown key, unknown event or
// out-of-range timeout makes the runtime drop the ENTIRE hooks section —
// including hooks the user wrote themselves. Never write a block that could
// trip that.
const KIMI_CODE_ALLOWED_HOOK_KEYS = new Set(["event", "matcher", "command", "timeout"]);
const KIMI_CODE_TIMEOUT_MIN = 1;
const KIMI_CODE_TIMEOUT_MAX = 600;

const HOOK_TIMEOUT_SECONDS = 30;

const COMMAND_WITH_MARKER_REGEX = new RegExp(
  `command\\s*=\\s*"(?:\\\\.|[^"\\\\])*${MARKER}(?:\\\\.|[^"\\\\])*"|command\\s*=\\s*'[^']*${MARKER}[^']*'`
);
const COMMAND_LINE_REGEX = /command\s*=\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)')/g;

function unescapeTomlDoubleQuotedCommand(value) {
  return String(value)
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function normalizePermissionMode(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === MODE_EXPLICIT || normalized === MODE_SUSPECT) return normalized;
  return null;
}

// Extract any existing CLAWD_KIMI_PERMISSION_MODE=... prefix from Clawd-owned
// hook command lines in config.toml. Used as a fallback when the caller did
// not pass an explicit mode AND no env var is set — without this, the startup
// auto-sync would silently strip the prefix written by a previous install,
// breaking the "persistent mode" promise documented in setup-guide.md.
function extractExistingPermissionMode(content) {
  if (typeof content !== "string" || !content) return null;
  // Match both quoting styles. The double-quoted branch must allow `\"` inside
  // because Clawd installer historically wrote `command = "...\"node\" \"...kimi-hook.js\""`.
  // A naive `[^"]*` truncates at the first `\"`, drops MARKER, and silently
  // returns null — which is exactly the regression that erased the user's
  // suspect-mode prefix on startup auto-sync.
  let match;
  COMMAND_LINE_REGEX.lastIndex = 0;
  while ((match = COMMAND_LINE_REGEX.exec(content)) !== null) {
    const value = match[1] !== undefined
      ? unescapeTomlDoubleQuotedCommand(match[1])
      : (match[2] || "");
    if (!value.includes(MARKER)) continue;
    const modeMatch = value.match(/CLAWD_KIMI_PERMISSION_MODE=([A-Za-z]+)/);
    if (modeMatch) {
      const normalized = normalizePermissionMode(modeMatch[1]);
      if (normalized) return normalized;
    }
  }
  return null;
}

function findKimiHookCommands(content, marker = MARKER) {
  if (typeof content !== "string" || !content || typeof marker !== "string" || !marker) {
    return [];
  }
  const commands = [];
  let match;
  COMMAND_LINE_REGEX.lastIndex = 0;
  while ((match = COMMAND_LINE_REGEX.exec(content)) !== null) {
    const value = match[1] !== undefined
      ? unescapeTomlDoubleQuotedCommand(match[1])
      : (match[2] || "");
    if (value.includes(marker)) commands.push(value);
  }
  return commands;
}

// Remove every [[hooks]] block whose command references Clawd's kimi-hook.js.
// A block ends at the next TOML section header (`[x]` or `[[x]]`) or EOF —
// NOT only at the next `[[hooks]]`. Using the narrower lookahead would cause
// a regex-based pass to greedily swallow any trailing `[server]`, `[mcp]`,
// `[[tools]]`, etc. that the user added after their hooks, silently deleting
// their own config. Walking line-by-line avoids that entirely.
// On the kimi-code target this same pass also self-heals entries the upstream
// legacy migration copied over verbatim (env-prefix commands that are dead on
// Windows): they carry MARKER, get stripped here and rewritten in the new
// format.
function stripClawdKimiHookBlocks(content) {
  if (typeof content !== "string" || !content) return { content: "", removed: 0 };
  const HEADER_RE = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/;
  const HOOKS_HEADER_RE = /^\s*\[\[hooks\]\]\s*(?:#.*)?$/;
  const lines = content.split("\n");
  const output = [];
  let removed = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (HOOKS_HEADER_RE.test(line)) {
      const start = i;
      let j = i + 1;
      while (j < lines.length && !HEADER_RE.test(lines[j])) j++;
      const block = lines.slice(start, j).join("\n");
      if (COMMAND_WITH_MARKER_REGEX.test(block)) {
        removed++;
      } else {
        output.push(block);
      }
      i = j;
    } else {
      output.push(line);
      i++;
    }
  }
  return { content: output.join("\n"), removed };
}

function buildHookBlocks(events, command) {
  return events.map((event) => `[[hooks]]
event = "${event}"
command = '${command}'
matcher = ""
timeout = ${HOOK_TIMEOUT_SECONDS}
`).join("\n");
}

// Guard for the kimi-code target: parse the blocks we are ABOUT to write and
// verify they satisfy the strict upstream schema (allowed keys only, known
// event, integer timeout in range, single-line literal command). Throws
// instead of writing — a malformed write would take down the user's own hooks.
function validateKimiCodeHookBlocks(blocksText, allowedEvents) {
  const allowed = new Set(allowedEvents);
  const blocks = blocksText.split(/^\[\[hooks\]\]\s*$/m).slice(1);
  if (blocks.length === 0) {
    throw new Error("kimi-code hook validation: no [[hooks]] blocks generated");
  }
  for (const block of blocks) {
    const keys = new Map();
    for (const rawLine of block.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const keyMatch = line.match(/^([A-Za-z_]+)\s*=\s*(.*)$/);
      if (!keyMatch) {
        throw new Error(`kimi-code hook validation: unparseable line: ${line}`);
      }
      keys.set(keyMatch[1], keyMatch[2]);
    }
    for (const key of keys.keys()) {
      if (!KIMI_CODE_ALLOWED_HOOK_KEYS.has(key)) {
        throw new Error(`kimi-code hook validation: illegal key "${key}" (strict schema would drop the whole hooks section)`);
      }
    }
    // Upstream treats matcher/timeout as optional, but our generator always
    // writes all four keys — a missing one means the generator broke.
    for (const key of KIMI_CODE_ALLOWED_HOOK_KEYS) {
      if (!keys.has(key)) {
        throw new Error(`kimi-code hook validation: missing key "${key}"`);
      }
    }
    const eventValue = (keys.get("event") || "").replace(/^"|"$/g, "");
    if (!allowed.has(eventValue)) {
      throw new Error(`kimi-code hook validation: unknown event "${eventValue}"`);
    }
    const timeoutValue = Number(keys.get("timeout"));
    if (
      !Number.isInteger(timeoutValue)
      || timeoutValue < KIMI_CODE_TIMEOUT_MIN
      || timeoutValue > KIMI_CODE_TIMEOUT_MAX
    ) {
      throw new Error(`kimi-code hook validation: timeout out of range: ${keys.get("timeout")}`);
    }
    const commandValue = keys.get("command") || "";
    if (!/^'[^']*'$/.test(commandValue) && !/^"(?:\\.|[^"\\])*"$/.test(commandValue)) {
      throw new Error("kimi-code hook validation: command is not a single-line TOML string");
    }
  }
}

function targetDefinition(flavor, settingsPath) {
  if (flavor === FLAVOR_KIMI_CODE) {
    const configPath = settingsPath || KIMI_CODE_CONFIG_PATH;
    return {
      flavor: FLAVOR_KIMI_CODE,
      settingsPath: configPath,
      parentDir: path.dirname(configPath),
      events: KIMI_CODE_HOOK_EVENTS,
      // Native PermissionRequest/PermissionResult events replace the
      // suspect/explicit heuristic, and the POSIX `VAR=x cmd` prefix does not
      // execute under cmd.exe (kimi-code runs hooks via `spawn(shell:true)`,
      // i.e. %COMSPEC% on Windows) — so no mode prefix on this target, ever.
      supportsModePrefix: false,
      // hooks-only file. MUST NOT contain default_model: a dangling model
      // alias makes the CLI's next session-create fail.
      createConfigContent: "",
      validateBlocks: true,
    };
  }
  const configPath = settingsPath || DEFAULT_CONFIG_PATH;
  return {
    flavor: FLAVOR_LEGACY,
    settingsPath: configPath,
    parentDir: path.dirname(configPath),
    events: KIMI_HOOK_EVENTS,
    supportsModePrefix: true,
    createConfigContent: 'default_model = "kimi-for-coding"\n',
    validateBlocks: false,
  };
}

function registerKimiHooksAtTarget(target, options = {}) {
  const settingsPath = target.settingsPath;

  // Skip if the Kimi config directory doesn't exist (this generation of the
  // CLI is not installed, or a custom path points to a non-existent home).
  const kimiDir = target.parentDir;
  if (!fs.existsSync(kimiDir)) {
    if (!options.silent) console.log(`Clawd: ${kimiDir} not found — skipping Kimi hook registration`);
    return { added: 0, skipped: 0, updated: 0, flavor: target.flavor, settingsPath, present: false };
  }

  const hookScript = asarUnpackedPath(path.resolve(__dirname, "kimi-hook.js").replace(/\\/g, "/"));

  let content = "";
  try {
    content = fs.readFileSync(settingsPath, "utf-8");
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read config.toml: ${err.message}`);
    }
    // Create a minimal config.toml if it doesn't exist (per-target shape).
    content = target.createConfigContent;
  }

  // Preserve a user-repaired absolute Node path baked into the existing TOML
  // when fresh detection fails. Without this, startup auto-sync would overwrite
  // a working `C:\Program Files\nodejs\node.exe` back to bare `"node"` — the
  // same regression mode #317 reported for Claude's settings.json.
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved
    || extractExistingNodeBinFromCommands(findKimiHookCommands(content, MARKER), MARKER)
    || "node";

  // Priority: explicit caller option → env var → mode already baked into the
  // existing config.toml hook command. The fallback is critical for the
  // startup auto-sync path: Clawd launches without the env var, sees an
  // existing install that was done with CLAWD_KIMI_PERMISSION_MODE=suspect,
  // and MUST preserve that prefix so the user's persistent choice survives.
  // (Legacy target only — see targetDefinition for why kimi-code never gets one.)
  let modePrefix = "";
  if (target.supportsModePrefix) {
    const providedMode = normalizePermissionMode(
      options.permissionMode !== undefined
        ? options.permissionMode
        : process.env.CLAWD_KIMI_PERMISSION_MODE
    );
    const configuredMode = providedMode || extractExistingPermissionMode(content);
    modePrefix = configuredMode ? `CLAWD_KIMI_PERMISSION_MODE=${configuredMode} ` : "";
  }
  // WSL: plain unquoted form — quoted-without-shell breaks naive-split hook
  // runners (see json-utils formatNodeHookCommand); WSL paths have no spaces.
  const desiredCommand = resolveWslDistroEnv()
    ? `${modePrefix}${nodeBin} ${hookScript}`
    : `${modePrefix}"${nodeBin}" "${hookScript}"`;

  const hookBlocks = buildHookBlocks(target.events, desiredCommand);
  if (target.validateBlocks) validateKimiCodeHookBlocks(hookBlocks, target.events);

  // Check if our hooks are already registered (matches both single and double quotes)
  const markerRegex = new RegExp(COMMAND_WITH_MARKER_REGEX.source, "g");
  const existingMatches = [...content.matchAll(markerRegex)];

  if (existingMatches.length > 0) {
    // Normalize + de-duplicate all Clawd-owned Kimi hook blocks. A stale extra
    // block can fire duplicate PreToolUse events that cancel suspect timers and
    // suppress notification animation. On kimi-code this is also what upgrades
    // entries the upstream migration copied from ~/.kimi verbatim.
    const stripped = stripClawdKimiHookBlocks(content);
    let normalized = stripped.content;
    normalized = normalized.replace(/^hooks\s*=\s*\[\]\s*$/m, "");
    normalized = normalized.trimEnd() + "\n\n" + hookBlocks;
    const updated = normalized !== content ? 1 : 0;
    content = normalized;
    if (updated > 0) {
      fs.mkdirSync(kimiDir, { recursive: true });
      fs.writeFileSync(settingsPath, content);
    }
    if (!options.silent) {
      console.log(`Clawd Kimi hooks → ${settingsPath}`);
      if (updated > 0) {
        console.log(`  Updated: normalized ${existingMatches.length} existing hook command(s)`);
        if (stripped.removed > target.events.length) {
          console.log(`  Deduped: removed ${stripped.removed - target.events.length} duplicate block(s)`);
        }
      } else {
        console.log("  Skipped: already registered");
      }
    }
    return { added: 0, skipped: 1, updated, flavor: target.flavor, settingsPath, present: true };
  }

  // Remove empty `hooks = []` since we need to use [[hooks]] array-of-tables syntax
  content = content.replace(/^hooks\s*=\s*\[\]\s*$/m, "");

  // Append to file
  content = content.trimEnd() + "\n\n" + hookBlocks;

  fs.mkdirSync(kimiDir, { recursive: true });
  fs.writeFileSync(settingsPath, content);

  if (!options.silent) {
    console.log(`Clawd Kimi hooks → ${settingsPath}`);
    console.log(`  Added: ${target.events.length} hooks`);
  }

  return { added: target.events.length, skipped: 0, updated: 0, flavor: target.flavor, settingsPath, present: true };
}

/**
 * Register Clawd hooks into the Kimi config(s).
 *
 * Default (no settingsPath): sync BOTH generations — legacy ~/.kimi and
 * kimi-code ~/.kimi-code — installing into whichever directories exist.
 * With options.settingsPath: single-target mode; options.flavor picks the
 * block format ("legacy" default, "kimi-code" for the new CLI).
 *
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.settingsPath]
 * @param {string} [options.flavor]
 * @returns {{ added: number, skipped: number, updated: number, targets: object[] }}
 */
function registerKimiHooks(options = {}) {
  if (options.settingsPath) {
    const target = targetDefinition(options.flavor || FLAVOR_LEGACY, options.settingsPath);
    const result = registerKimiHooksAtTarget(target, options);
    return { ...result, targets: [result] };
  }

  const targets = [
    targetDefinition(FLAVOR_LEGACY),
    targetDefinition(FLAVOR_KIMI_CODE),
  ];
  const results = [];
  const errors = [];
  for (const target of targets) {
    try {
      results.push(registerKimiHooksAtTarget(target, options));
    } catch (err) {
      errors.push(err);
      results.push({
        added: 0, skipped: 0, updated: 0,
        flavor: target.flavor, settingsPath: target.settingsPath, present: false,
        error: err && err.message ? err.message : String(err),
      });
      if (!options.silent) console.warn(`Clawd: Kimi hook sync failed for ${target.settingsPath}: ${err.message}`);
    }
  }
  return aggregateRegisterResults(results, errors);
}

// Pure aggregation over per-target register results. A failed target must be
// VISIBLE to integration-sync: normalizeCountSyncResult only reads counts
// unless a `status` string is present, so a partial failure that left counts
// looking healthy ("legacy already current, kimi-code write failed") — or a
// zero-count failure it would misread as "not installed" — gets an explicit
// error status with the failing paths in the message.
function aggregateRegisterResults(results, errors) {
  const aggregate = {
    added: results.reduce((sum, r) => sum + (r.added || 0), 0),
    skipped: results.reduce((sum, r) => sum + (r.skipped || 0), 0),
    updated: results.reduce((sum, r) => sum + (r.updated || 0), 0),
    targets: results,
  };
  if (errors.length === 0) return aggregate;
  // Every target failed outright: throw, matching the single-target contract
  // (integration-sync's catch converts it into an error status).
  if (errors.length === results.length) {
    throw errors[0];
  }
  const failed = results.filter((r) => r.error);
  aggregate.status = "error";
  aggregate.message = `Kimi hook sync failed for ${failed.map((r) => r.settingsPath).join(", ")}: ${failed[0].error}`;
  return aggregate;
}

function unregisterKimiHooksAtPath(settingsPath, options = {}) {
  let content = "";
  try {
    content = readTextFileStripBom(settingsPath, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return { removed: 0, changed: false, settingsPath };
    throw new Error(`Failed to read config.toml: ${err.message}`);
  }

  const stripped = stripClawdKimiHookBlocks(content);
  const changed = stripped.content !== content;
  let backupPath = null;
  if (changed) backupPath = writeTextAtomicWithBackup(settingsPath, stripped.content, options);
  const result = { removed: stripped.removed, changed, settingsPath };
  if (options.backup === true) result.backupPath = backupPath;
  return result;
}

/**
 * Remove Clawd hooks from the Kimi config(s). Default: both generations.
 * options.settingsPaths (array) or options.settingsPath (string) narrows it.
 */
function unregisterKimiHooks(options = {}) {
  const paths = Array.isArray(options.settingsPaths) && options.settingsPaths.length > 0
    ? options.settingsPaths
    : options.settingsPath
      ? [options.settingsPath]
      : [DEFAULT_CONFIG_PATH, KIMI_CODE_CONFIG_PATH];

  const results = paths.map((settingsPath) => unregisterKimiHooksAtPath(settingsPath, options));
  const removed = results.reduce((sum, r) => sum + (r.removed || 0), 0);
  const changed = results.some((r) => r.changed);
  if (!options.silent) console.log(`Clawd Kimi hooks removed: ${removed}`);
  const primary = results.find((r) => r.changed) || results[0];
  const aggregate = {
    removed,
    changed,
    settingsPath: primary ? primary.settingsPath : paths[0],
    results,
  };
  const backupPaths = results
    .map((r) => r.backupPath)
    .filter((p) => typeof p === "string" && p);
  if (options.backup === true) {
    aggregate.backupPaths = backupPaths;
    aggregate.backupPath = backupPaths[0] || null;
  }
  return aggregate;
}

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  KIMI_CODE_PARENT_DIR,
  KIMI_CODE_CONFIG_PATH,
  registerKimiHooks,
  unregisterKimiHooks,
  KIMI_HOOK_EVENTS,
  KIMI_CODE_HOOK_EVENTS,
  normalizePermissionMode,
  extractExistingPermissionMode,
  findKimiHookCommands,
  stripClawdKimiHookBlocks,
  validateKimiCodeHookBlocks,
  aggregateRegisterResults,
  MODE_EXPLICIT,
  MODE_SUSPECT,
  FLAVOR_LEGACY,
  FLAVOR_KIMI_CODE,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterKimiHooks({});
    else registerKimiHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
