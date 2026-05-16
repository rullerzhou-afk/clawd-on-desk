#!/usr/bin/env node
"use strict";

// Merge Clawd nano-agent hooks into nano-agent's user config (append-only,
// idempotent). nano-agent's hookservice loads `security.hooks` from
// `~/.config/nano/config.yaml` (global) or `.nano.yaml` (project). We touch
// the global path by default so per-project overrides remain user-owned.
//
// Each registered entry uses a stable `clawd-on-desk:<event>` name so we can
// recognise our own entries on re-install / uninstall without disturbing
// user-authored hooks. Per AGENTS.md, hook scripts may only depend on Node
// built-ins; this installer runs in the main app and may load js-yaml.

const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");
const {
  resolveNodeBin,
  buildPermissionUrl,
  DEFAULT_SERVER_PORT,
  readRuntimePort,
} = require("./server-config");
const { asarUnpackedPath } = require("./json-utils");

const HOOK_NAME_PREFIX = "clawd-on-desk:";
const HOOK_SCRIPT_MARKER = "nano-agent-hook.js";
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "nano", "config.yaml");

// Events nano-agent fires that map cleanly onto Clawd states. Mirrors the
// EVENT_TO_STATE table in nano-agent-hook.js. Use snake_case (nano-agent's
// canonical event identifier).
const NANO_COMMAND_HOOK_EVENTS = [
  "session_start",
  "session_end",
  "user_prompt_submit",
  "pre_tool_use",
  "post_tool_use",
  "post_tool_use_failure",
  "stop",
  "stop_failure",
  "subagent_start",
  "subagent_stop",
  "pre_compact",
  "post_compact",
  "notification",
];

// Event names that participate in approval / blocking flows. They pair best
// with HTTP hooks so the server can hold the connection open while the user
// decides; the command path here would only short-circuit to allow.
const NANO_HTTP_HOOK_EVENTS = [
  "permission_request",
];

function quoteForShell(value) {
  // hookservice runs the command via `sh -c` — single-quote with POSIX
  // ' -> '\'' escape for paths that may contain spaces or apostrophes.
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function buildHookCommand(nodeBin, scriptPath, eventName, options = {}) {
  // The event name is duplicated as argv[2] for parity with the Claude Code
  // hook contract; the script also reads NANO_HOOK_INPUT.event as a fallback.
  const command = [
    quoteForShell(nodeBin),
    quoteForShell(scriptPath),
    quoteForShell(eventName),
  ].join(" ");
  // Remote SSH deployment: nano-agent runs on the remote machine but Clawd
  // listens locally. Prepending CLAWD_REMOTE=1 tells the hook script to use
  // the SSH tunnel host prefix instead of resolving local PIDs (and matches
  // hooks/install.js:buildCommandHookSpec for the Claude Code path).
  return options.remote ? `CLAWD_REMOTE=1 ${command}` : command;
}

function buildCommandHookEntry(eventName, command, statusMessage) {
  return {
    name: `${HOOK_NAME_PREFIX}${eventName}`,
    event: eventName,
    pattern: "*",
    type: "command",
    command,
    enabled: true,
    failure_policy: "allow", // never block the user because Clawd is offline
    async: true,             // fire-and-forget; we only care about state side-effects
    env_whitelist: [
      "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL",
      "CLAWD_REMOTE",
    ],
    status_message: statusMessage,
  };
}

function buildHttpHookEntry(eventName, url, statusMessage) {
  return {
    name: `${HOOK_NAME_PREFIX}${eventName}`,
    event: eventName,
    pattern: "*",
    type: "http",
    enabled: true,
    failure_policy: "allow",
    http: {
      url,
      method: "POST",
      timeout_seconds: 600,
    },
    status_message: statusMessage,
  };
}

function isOurEntry(entry) {
  return !!(entry && typeof entry === "object" && typeof entry.name === "string"
    && entry.name.startsWith(HOOK_NAME_PREFIX));
}

function entriesEquivalent(a, b) {
  // Cheap structural equality check — sufficient because we always emit
  // entries via the same builders. Uses JSON.stringify for canonicalization.
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

function ensureSecurityHooksArray(config) {
  if (!config || typeof config !== "object") return null;
  if (config.security == null) config.security = {};
  if (typeof config.security !== "object" || Array.isArray(config.security)) {
    return null;
  }
  if (!Array.isArray(config.security.hooks)) {
    if (config.security.hooks == null) {
      config.security.hooks = [];
    } else {
      return null;
    }
  }
  return config.security.hooks;
}

function loadConfig(configPath, fsImpl) {
  const raw = fsImpl.readFileSync(configPath, "utf8");
  const parsed = yaml.load(raw);
  if (parsed == null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`nano-agent config at ${configPath} is not a YAML mapping`);
  }
  return parsed;
}

function dumpConfig(config) {
  return yaml.dump(config, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
}

function writeYamlAtomic(filePath, contents, fsImpl) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  fsImpl.mkdirSync(dir, { recursive: true });
  try {
    fsImpl.writeFileSync(tmpPath, contents, "utf8");
    fsImpl.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fsImpl.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

function resolveScriptPath(baseDir) {
  const dir = path.resolve(baseDir || __dirname).replace(/\\/g, "/");
  return asarUnpackedPath(path.join(dir, "nano-agent-hook.js").replace(/\\/g, "/"));
}

function summarizeStatusMessage(eventName) {
  return `clawd-on-desk: report ${eventName} state`;
}

/**
 * Register Clawd hooks into nano-agent's config (idempotent).
 *
 * @param {object} [options]
 * @param {string} [options.configPath]    - override target YAML path (default ~/.config/nano/config.yaml)
 * @param {string} [options.scriptPath]    - override hook script path
 * @param {string} [options.nodeBin]       - override node binary (default from resolveNodeBin)
 * @param {number} [options.port]          - override Clawd HTTP server port
 * @param {object} [options.fs]            - inject fs for tests
 * @param {boolean} [options.silent]
 * @returns {{ status: string, configPath: string, added: number, updated: number, skipped: number, reason?: string }}
 */
function registerNanoAgentHooks(options = {}) {
  const fsImpl = options.fs || fs;
  const configPath = options.configPath || DEFAULT_CONFIG_PATH;

  let exists = true;
  try { fsImpl.statSync(configPath); } catch { exists = false; }
  if (!exists) {
    if (!options.silent) {
      console.log(`Clawd: ${configPath} not found — skipping nano-agent hook registration`);
    }
    return { status: "skipped", reason: "config-missing", configPath, added: 0, updated: 0, skipped: 0 };
  }

  let config;
  try {
    config = loadConfig(configPath, fsImpl);
  } catch (err) {
    if (!options.silent) console.warn(`Clawd: failed to parse ${configPath}: ${err.message}`);
    return { status: "error", reason: "config-parse-failed", message: err.message, configPath, added: 0, updated: 0, skipped: 0 };
  }

  const hooks = ensureSecurityHooksArray(config);
  if (hooks == null) {
    if (!options.silent) console.warn(`Clawd: ${configPath} has incompatible security/security.hooks shape`);
    return { status: "error", reason: "config-shape-incompatible", configPath, added: 0, updated: 0, skipped: 0 };
  }

  const scriptPath = options.scriptPath || resolveScriptPath();
  const resolvedNode = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolvedNode || "node";
  const port = options.port || readRuntimePort() || DEFAULT_SERVER_PORT;
  const permissionUrl = buildPermissionUrl(port);

  const desiredCommandEntries = NANO_COMMAND_HOOK_EVENTS.map((eventName) =>
    buildCommandHookEntry(
      eventName,
      buildHookCommand(nodeBin, scriptPath, eventName, { remote: !!options.remote }),
      summarizeStatusMessage(eventName)
    )
  );
  const desiredHttpEntries = NANO_HTTP_HOOK_EVENTS.map((eventName) =>
    buildHttpHookEntry(eventName, permissionUrl, summarizeStatusMessage(eventName))
  );
  const desiredAll = [...desiredCommandEntries, ...desiredHttpEntries];
  const desiredByName = new Map(desiredAll.map((entry) => [entry.name, entry]));

  let added = 0;
  let updated = 0;
  let skipped = 0;
  let changed = false;

  for (let i = 0; i < hooks.length; i++) {
    const entry = hooks[i];
    if (!isOurEntry(entry)) continue;
    const desired = desiredByName.get(entry.name);
    if (!desired) continue; // a stale entry for an event we no longer emit; uninstall pass cleans these
    if (entriesEquivalent(entry, desired)) {
      skipped++;
    } else {
      hooks[i] = desired;
      updated++;
      changed = true;
    }
    desiredByName.delete(entry.name);
  }

  for (const entry of desiredByName.values()) {
    hooks.push(entry);
    added++;
    changed = true;
  }

  if (changed) {
    writeYamlAtomic(configPath, dumpConfig(config), fsImpl);
  }

  if (!options.silent) {
    console.log(`Clawd nano-agent hooks → ${configPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
  }

  return { status: "ok", configPath, added, updated, skipped };
}

/**
 * Remove all clawd-on-desk hook entries from nano-agent's config.
 */
function unregisterNanoAgentHooks(options = {}) {
  const fsImpl = options.fs || fs;
  const configPath = options.configPath || DEFAULT_CONFIG_PATH;

  let exists = true;
  try { fsImpl.statSync(configPath); } catch { exists = false; }
  if (!exists) {
    return { status: "skipped", reason: "config-missing", configPath, removed: 0 };
  }

  let config;
  try {
    config = loadConfig(configPath, fsImpl);
  } catch (err) {
    return { status: "error", reason: "config-parse-failed", message: err.message, configPath, removed: 0 };
  }

  const security = config && config.security;
  const hooks = security && Array.isArray(security.hooks) ? security.hooks : null;
  if (!hooks) {
    return { status: "skipped", reason: "no-hooks-array", configPath, removed: 0 };
  }

  const before = hooks.length;
  const filtered = hooks.filter((entry) => !isOurEntry(entry));
  const removed = before - filtered.length;
  if (removed === 0) {
    return { status: "ok", configPath, removed: 0 };
  }
  config.security.hooks = filtered;
  writeYamlAtomic(configPath, dumpConfig(config), fsImpl);
  if (!options.silent) {
    console.log(`Clawd nano-agent hooks ← removed ${removed} entries from ${configPath}`);
  }
  return { status: "ok", configPath, removed };
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  HOOK_NAME_PREFIX,
  HOOK_SCRIPT_MARKER,
  NANO_COMMAND_HOOK_EVENTS,
  NANO_HTTP_HOOK_EVENTS,
  buildCommandHookEntry,
  buildHookCommand,
  buildHttpHookEntry,
  ensureSecurityHooksArray,
  isOurEntry,
  registerNanoAgentHooks,
  unregisterNanoAgentHooks,
};

if (require.main === module) {
  try {
    const remote = process.argv.includes("--remote");
    if (process.argv.includes("--uninstall")) {
      unregisterNanoAgentHooks({});
    } else {
      registerNanoAgentHooks({ remote });
    }
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
}
