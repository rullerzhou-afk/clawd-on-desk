#!/usr/bin/env node
// Merge Clawd Grok Build state hooks into
// $GROK_HOME/hooks/clawd-on-desk.json (fallback ~/.grok/hooks/clawd-on-desk.json).
//
// Ownership is the STRUCTURED handler marker in Grok's supported `env` map:
//   env: { CLAWD_GROK_HOOK: "v1" }
// The marker is the sole authority for update, remove, or file deletion. A
// filename/substring heuristic never authorizes mutation; it may only produce a
// diagnostic warning that a legacy/lookalike entry exists.
//
// Grok's RawHandler supports `type`, `command`, `url`, `timeout`, and `env` —
// there is no per-handler `shell` field. Grok's `timeout` unit is SECONDS. On
// Windows the command uses the shared `windowsWrapper: "portable"` form
// (unquoted interpreter token or a bare `node` PATH lookup, plus double-quoted
// script/argument paths).

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { resolveNodeBin } = require("./server-config");
const {
  readJsonFile,
  writeJsonAtomic,
  writeTextAtomic,
  createBackup,
  pruneOldBackups,
  asarUnpackedPath,
  formatNodeHookCommand,
} = require("./json-utils");

// Diagnostic only: an entry whose command contains this filename is reported
// as a potential legacy Clawd entry, but is never adopted, rewritten, or
// deleted on that basis. The unsupported `clawd-bridge.py` marker from the
// unshipped preview is intentionally NOT recognized in any way.
const COMMAND_MARKER = "grok-hook.js";
const LEGACY_MARKERS = Object.freeze([COMMAND_MARKER]);
// Structured ownership marker (the mutation authority).
const MANAGED_MARKER_KEY = "CLAWD_GROK_HOOK";
const MANAGED_MARKER_VALUE = "v1";
const MARKER = MANAGED_MARKER_KEY;

const HOOKS_DIR_NAME = "hooks";
const CONFIG_FILE_NAME = "clawd-on-desk.json";
const PREVIEW_CONFIG_FILE_NAME = "clawd.json";

// Phase 1 main-session events. No SubagentStart/SubagentStop: subagent events
// are ignored entirely. SessionEnd must inherit Grok's 1.5s teardown budget,
// so it carries no explicit timeout; everything else is capped at 5 seconds so
// a passive state hook can never sit on the user's critical path (Grok's
// default Stop/PostToolUse gate is 600s). Grok's `timeout` field is seconds.
const GROK_HOOK_EVENTS = Object.freeze([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
  "StopCancelled",
  "Notification",
  "PreCompact",
  "PostCompact",
  "PermissionDenied",
  "SessionEnd",
]);

const DEFAULT_EVENT_TIMEOUT_SECONDS = 5;

// Explicit per-event timeout policy (seconds, or null = omit and inherit the
// host budget). This table covers exactly GROK_HOOK_EVENTS; unknown events do
// NOT silently inherit the default.
const UNSUPPORTED_EVENT_TIMEOUT = Symbol("unsupported-grok-event-timeout");
const GROK_EVENT_TIMEOUT_SECONDS = Object.freeze({
  SessionStart: 5,
  UserPromptSubmit: 5,
  PreToolUse: 5,
  PostToolUse: 5,
  PostToolUseFailure: 5,
  Stop: 5,
  StopFailure: 5,
  StopCancelled: 5,
  Notification: 5,
  PreCompact: 5,
  PostCompact: 5,
  PermissionDenied: 5,
  SessionEnd: null,
});

function grokEventTimeoutSeconds(event) {
  if (Object.prototype.hasOwnProperty.call(GROK_EVENT_TIMEOUT_SECONDS, event)) {
    return GROK_EVENT_TIMEOUT_SECONDS[event];
  }
  return UNSUPPORTED_EVENT_TIMEOUT;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// statSync-based existence check so the read-only installation detector (whose
// fs proxy injects only read-style methods) can share the inspector.
function pathExists(fsImpl, target) {
  try {
    fsImpl.statSync(target);
    return true;
  } catch {
    return false;
  }
}

function resolveGrokHome(options = {}) {
  if (typeof options.grokHome === "string" && options.grokHome.trim()) {
    return options.grokHome.trim();
  }
  const env = isPlainObject(options.env) ? options.env : process.env;
  const grokHomeEnv = typeof env.GROK_HOME === "string" ? env.GROK_HOME.trim() : "";
  if (grokHomeEnv) return grokHomeEnv;
  if (typeof options.homeDir === "string" && options.homeDir) {
    return path.join(options.homeDir, ".grok");
  }
  return path.join(os.homedir(), ".grok");
}

function resolveGrokHooksDir(options = {}) {
  return path.join(resolveGrokHome(options), HOOKS_DIR_NAME);
}

function resolveGrokConfigPath(options = {}) {
  if (typeof options.configPath === "string" && options.configPath) return options.configPath;
  return path.join(resolveGrokHooksDir(options), CONFIG_FILE_NAME);
}

const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".grok");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, HOOKS_DIR_NAME, CONFIG_FILE_NAME);

function resolveHookScriptPath() {
  return asarUnpackedPath(path.resolve(__dirname, "grok-hook.js").replace(/\\/g, "/"));
}

function isAllowedPosixNodeToken(token) {
  if (token === "node") return true;
  return path.posix.isAbsolute(token) && path.posix.basename(token) === "node";
}

function isAllowedWindowsNodeToken(token) {
  // Windows path/basename comparison is case-insensitive, and the writer keeps
  // the caller's original casing. Only the basename is relaxed; the absolute
  // drive/UNC form and the no-other-token constraint are unchanged.
  if (token.toLowerCase() === "node") return true;
  if (!/^[A-Za-z]:[\\/]/.test(token)) return false;
  const basename = path.win32.basename(token.replace(/\//g, "\\")).toLowerCase();
  // Symmetric with the writer: an absolute Windows node token may be either
  // `node` or `node.exe` (the official Node installer uses `node.exe`).
  return basename === "node" || basename === "node.exe";
}

// Strict canonical recognition of the generated managed command. It must be the
// exact current/packaged hook script as the SOLE script argument and only an
// intended POSIX (`"node" "script"`) or Windows portable (`node "script"`)
// Node-token form. Extra arguments, shell operators, a wrong interpreter, or a
// same-named script at another path are rejected.
function parseCanonicalManagedCommand(command, hookScript) {
  if (typeof command !== "string" || !command.trim()) return null;
  const expectedScript = String(hookScript || "").replace(/\\/g, "/");

  const posix = command.match(/^"([^"]+)" "([^"]+)"$/);
  if (posix) {
    const [, nodeToken, scriptPath] = posix;
    if (scriptPath.replace(/\\/g, "/") !== expectedScript) return null;
    if (!isAllowedPosixNodeToken(nodeToken)) return null;
    return { form: "posix", nodeToken, scriptPath };
  }

  const portable = command.match(/^(\S+) "([^"]+)"$/);
  if (portable) {
    const [, nodeToken, scriptPath] = portable;
    if (scriptPath.replace(/\\/g, "/") !== expectedScript) return null;
    if (!isAllowedWindowsNodeToken(nodeToken)) return null;
    return { form: "portable", nodeToken, scriptPath };
  }

  return null;
}

function desiredHookCommand(nodeBin, hookScript, options = {}) {
  // Grok Build Phase 1 has no WSL support. Force the WSL branch off so an
  // ambient CLAWD_WSL_DISTRO / WSL_DISTRO_NAME can never make the writer emit
  // the unquoted WSL form that the strict inspector rejects (a Fix loop).
  return formatNodeHookCommand(nodeBin, hookScript, {
    platform: options.platform || process.platform,
    windowsWrapper: "portable",
    wslDistro: null,
  });
}

function handlerHasMarker(handler) {
  if (!isPlainObject(handler)) return false;
  const env = handler.env;
  return isPlainObject(env) && env[MANAGED_MARKER_KEY] === MANAGED_MARKER_VALUE;
}

function handlerHasExactMarkerEnv(handler) {
  if (!handlerHasMarker(handler)) return false;
  return Object.keys(handler.env).length === 1;
}

function groupHasMarker(group) {
  if (!isPlainObject(group) || !Array.isArray(group.hooks)) return false;
  return group.hooks.some((handler) => handlerHasMarker(handler));
}

function groupMatcherIsEmpty(group) {
  // Upstream `MatcherGroup.matcher` is `Option<String>`: absent AND null both
  // mean "no matcher".
  return isPlainObject(group)
    && (group.matcher === undefined || group.matcher === null || group.matcher === "");
}

function documentHasMarker(doc) {
  // Ownership lives only in a MatcherGroup's `hooks` array. A flat handler-shaped
  // entry is not a valid Grok MatcherGroup and never confers ownership.
  if (!isPlainObject(doc) || !isPlainObject(doc.hooks)) return false;
  for (const entries of Object.values(doc.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const group of entries) {
      if (groupHasMarker(group)) return true;
    }
  }
  return false;
}

function collectOwnedHandlers(doc) {
  const found = [];
  if (!isPlainObject(doc) || !isPlainObject(doc.hooks)) return found;
  for (const [event, entries] of Object.entries(doc.hooks)) {
    if (!Array.isArray(entries)) continue;
    entries.forEach((group, groupIndex) => {
      if (!isPlainObject(group)) return;
      if (Array.isArray(group.hooks)) {
        group.hooks.forEach((handler, handlerIndex) => {
          if (handlerHasMarker(handler)) {
            found.push({ event, groupIndex, handlerIndex, handler, group });
          }
        });
      }
    });
  }
  return found;
}

// Diagnostic-only legacy lookalike detection. Only exact marker-owned HANDLERS
// are excluded, so an unowned lookalike sibling inside an otherwise canonical
// group is still reported. A fresh canonical install reports zero lookalikes.
// This never authorizes mutation.
function findLegacyCommandPaths(doc) {
  const found = [];
  if (!isPlainObject(doc) || !isPlainObject(doc.hooks)) return found;
  for (const [event, entries] of Object.entries(doc.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const group of entries) {
      if (!isPlainObject(group)) continue;
      const candidates = [];
      if (typeof group.command === "string") candidates.push(group.command);
      if (Array.isArray(group.hooks)) {
        for (const handler of group.hooks) {
          if (!isPlainObject(handler) || typeof handler.command !== "string") continue;
          if (handlerHasMarker(handler)) continue;
          candidates.push(handler.command);
        }
      }
      for (const command of candidates) {
        if (LEGACY_MARKERS.some((marker) => command.includes(marker))) {
          found.push({ event, command });
          break;
        }
      }
    }
  }
  return found;
}

// Matches the pinned upstream serde shape:
//   RawHandler { type: String (required), command/url: Option<String>,
//                timeout: Option<u64>, env: HashMap<String,String> }
// `env: null` is accepted upstream (null/absent => empty map). `timeout` must be
// a non-negative safe integer compatible with Rust u64.
function validateRawHandlerShape(handler, where) {
  if (!isPlainObject(handler)) {
    throw new Error(`Invalid Grok hook file: ${where} must be an object`);
  }
  if (typeof handler.type !== "string") {
    throw new Error(`Invalid Grok hook file: ${where}.type is required and must be a string`);
  }
  if (handler.type !== "command" && handler.type !== "http") {
    throw new Error(`Invalid Grok hook file: ${where}.type must be "command" or "http"`);
  }
  if (handler.command !== undefined && typeof handler.command !== "string") {
    throw new Error(`Invalid Grok hook file: ${where}.command must be a string`);
  }
  if (handler.url !== undefined && typeof handler.url !== "string") {
    throw new Error(`Invalid Grok hook file: ${where}.url must be a string`);
  }
  if (handler.timeout !== undefined
    && (typeof handler.timeout !== "number"
      || !Number.isSafeInteger(handler.timeout)
      || handler.timeout < 0)) {
    throw new Error(`Invalid Grok hook file: ${where}.timeout must be a non-negative safe integer (seconds)`);
  }
  if (handler.env !== undefined && handler.env !== null) {
    if (!isPlainObject(handler.env)) {
      throw new Error(`Invalid Grok hook file: ${where}.env must be an object`);
    }
    for (const [key, value] of Object.entries(handler.env)) {
      if (typeof value !== "string") {
        throw new Error(`Invalid Grok hook file: ${where}.env.${key} must be a string`);
      }
    }
  }
}

// MatcherGroup { matcher: Option<String> (default), hooks: Vec<RawHandler> }.
// `hooks` is REQUIRED; a flat handler-shaped entry is not a valid group.
function validateMatcherGroupShape(group, where) {
  if (!isPlainObject(group)) {
    throw new Error(`Invalid Grok hook file: ${where} must be a matcher-group object`);
  }
  if (group.matcher !== undefined && group.matcher !== null && typeof group.matcher !== "string") {
    throw new Error(`Invalid Grok hook file: ${where}.matcher must be a string`);
  }
  if (!Array.isArray(group.hooks)) {
    throw new Error(`Invalid Grok hook file: ${where}.hooks is required and must be an array`);
  }
  group.hooks.forEach((handler, index) => {
    validateRawHandlerShape(handler, `${where}.hooks[${index}]`);
  });
}

// Fail-closed shape validation for every event Clawd may touch. Unknown
// top-level keys, other event groups, and foreign sibling handlers are
// preserved (not rejected) — only the shapes Clawd must mutate are validated.
function validateTouchedDocument(doc, configPath) {
  if (!isPlainObject(doc)) {
    throw new Error(`Invalid Grok hook file ${configPath}: top level must be an object`);
  }
  if (doc.hooks === undefined) return;
  if (!isPlainObject(doc.hooks)) {
    throw new Error(`Invalid Grok hook file ${configPath}: "hooks" must be an object`);
  }
  for (const event of GROK_HOOK_EVENTS) {
    const entries = doc.hooks[event];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) {
      throw new Error(`Invalid Grok hook file ${configPath}: hooks.${event} must be an array`);
    }
    entries.forEach((group, index) => {
      validateMatcherGroupShape(group, `hooks.${event}[${index}]`);
    });
  }
}

// Validate every event array that actually contains an owned handler, wherever
// it lives, so uninstall never mutates an event whose matcher/handler shapes are
// malformed.
function validateOwnedEventShapes(doc, configPath) {
  if (!isPlainObject(doc) || !isPlainObject(doc.hooks)) return;
  for (const [event, entries] of Object.entries(doc.hooks)) {
    if (!Array.isArray(entries)) continue;
    if (!entries.some((group) => groupHasMarker(group))) continue;
    entries.forEach((group, index) => {
      validateMatcherGroupShape(group, `${configPath}: hooks.${event}[${index}]`);
    });
  }
}

function buildManagedHandler(desiredCommand, event) {
  const timeout = grokEventTimeoutSeconds(event);
  if (timeout === UNSUPPORTED_EVENT_TIMEOUT) {
    // Fail closed: never build a managed handler for an unrecognized event.
    throw new Error(`Unsupported Grok hook event for a managed handler: ${event}`);
  }
  const handler = { type: "command", command: desiredCommand };
  if (timeout !== null) handler.timeout = timeout;
  handler.env = { [MANAGED_MARKER_KEY]: MANAGED_MARKER_VALUE };
  return handler;
}

function handlerMatchesDesired(handler, desiredCommand, event) {
  if (!handlerHasExactMarkerEnv(handler)) return false;
  if (handler.type !== "command") return false;
  if (handler.command !== desiredCommand) return false;
  const timeout = grokEventTimeoutSeconds(event);
  if (timeout === UNSUPPORTED_EVENT_TIMEOUT) return false;
  if (timeout === null) {
    if (handler.timeout !== undefined) return false;
  } else if (handler.timeout !== timeout) {
    return false;
  }
  return true;
}

// Problems that make a managed handler non-canonical for the inspector, which
// cannot resolve the exact node binary (spawning in the read-only detector is
// not allowed). Command identity is checked by the script reference, not the
// interpreter path.
function managedHandlerProblems(handler, event, hookScript) {
  const problems = [];
  if (!handlerHasMarker(handler)) problems.push("marker");
  if (!handlerHasExactMarkerEnv(handler)) problems.push("marker-env");
  if (handler.type !== "command") problems.push("type");
  if (!parseCanonicalManagedCommand(handler.command, hookScript)) problems.push("command");
  const timeout = grokEventTimeoutSeconds(event);
  if (timeout === UNSUPPORTED_EVENT_TIMEOUT) {
    problems.push("unsupported-event");
  } else if (timeout === null) {
    if (handler.timeout !== undefined) problems.push("timeout");
  } else if (handler.timeout !== timeout) {
    problems.push("timeout");
  }
  return problems;
}

// Merge into a single canonical managed handler per event, always placed in an
// effective empty matcher group. Foreign siblings and their matcher groups are
// preserved; duplicates and handlers under a non-empty matcher are removed.
function mergeManagedEvent(entries, desiredCommand, event) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  const before = JSON.stringify(list);
  const desiredHandler = buildManagedHandler(desiredCommand, event);
  const ownedGroups = list.filter((group) => groupHasMarker(group));

  if (ownedGroups.length === 0) {
    list.push({ matcher: "", hooks: [desiredHandler] });
    return { entries: list, added: 1, updated: 0, skipped: 0 };
  }

  let placed = false;
  for (const group of ownedGroups) {
    const emptyMatcher = groupMatcherIsEmpty(group);
    const keptHooks = [];
    for (const handler of group.hooks) {
      if (!handlerHasMarker(handler)) {
        keptHooks.push(handler);
        continue;
      }
      if (!placed && emptyMatcher) {
        handler.type = desiredHandler.type;
        handler.command = desiredHandler.command;
        if (desiredHandler.timeout === undefined) delete handler.timeout;
        else handler.timeout = desiredHandler.timeout;
        handler.env = { ...desiredHandler.env };
        placed = true;
        keptHooks.push(handler);
      }
      // else: duplicate owned handler, or a handler under a non-empty matcher.
    }
    group.hooks = keptHooks;
  }

  for (let index = list.length - 1; index >= 0; index -= 1) {
    const group = list[index];
    if (!isPlainObject(group) || !Array.isArray(group.hooks)) continue;
    if (group.hooks.length === 0 && !Object.keys(group).some((key) => key !== "hooks" && key !== "matcher")) {
      list.splice(index, 1);
    }
  }

  if (!placed) list.push({ matcher: "", hooks: [desiredHandler] });

  const updated = JSON.stringify(list) !== before;
  return { entries: list, added: 0, updated: updated ? 1 : 0, skipped: updated ? 0 : 1 };
}

function readGrokDocument(configPath, fsImpl) {
  if (!fsImpl.existsSync(configPath)) return { doc: null, existed: false };
  let doc;
  try {
    doc = readJsonFile(configPath);
  } catch (err) {
    throw new Error(`Failed to read ${configPath}: ${err.message}`);
  }
  return { doc, existed: true };
}

function previewPathFor(configPath) {
  return path.join(path.dirname(configPath), PREVIEW_CONFIG_FILE_NAME);
}

function previewWarnings(configPath, fsImpl) {
  const previewPath = previewPathFor(configPath);
  if (path.resolve(previewPath) === path.resolve(configPath)) return [];
  if (!pathExists(fsImpl, previewPath)) return [];
  return [
    `${previewPath} looks like a PR-preview duplicate from an unshipped Grok integration. `
    + "Clawd will not modify or delete either file; inspect and remove the stale preview manually.",
  ];
}

// POSIX permission bits of an existing file, or null when there is nothing to
// preserve (new file or a platform without meaningful mode bits).
function readExistingModeBits(fsImpl, configPath) {
  if (process.platform === "win32") return null;
  try {
    return fsImpl.statSync(configPath).mode & 0o777;
  } catch {
    return null;
  }
}

// Preserve the exact existing POSIX mode across an atomic replace. json-utils'
// writeTextAtomic applies `mode` to the temp file before the rename, so an
// existing 0600 config stays 0600. This is a Grok-local reuse of the shared
// safe primitive; shared json-utils behavior is unchanged.
function writeJsonAtomicPreservingExistingMode(configPath, data, fsImpl) {
  const mode = readExistingModeBits(fsImpl, configPath);
  const text = JSON.stringify(data, null, 2);
  if (mode === null) writeTextAtomic(configPath, text);
  else writeTextAtomic(configPath, text, { mode });
}

// Every mutation of an existing owned file must leave a recoverable backup that
// matches the original bytes BEFORE the write, so an aborted write still has a
// restore point. Bounded backup pruning is preserved, and the live file keeps
// the original mode (including when a later delete fails and it survives).
function writeWithVerifiedBackup(configPath, next, options, fsImpl) {
  const originalBytes = Buffer.from(fsImpl.readFileSync(configPath));
  const backupPath = createBackup(configPath, { ...options, backup: true });
  if (!backupPath) {
    throw new Error(`Failed to create a recoverable backup for ${configPath}`);
  }
  const backupBytes = Buffer.from(fsImpl.readFileSync(backupPath));
  if (!backupBytes.equals(originalBytes)) {
    throw new Error(`Backup verification failed for ${configPath}`);
  }
  writeJsonAtomicPreservingExistingMode(configPath, next, fsImpl);
  pruneOldBackups(configPath, options, backupPath);
  return backupPath;
}

function registerGrokHooks(options = {}) {
  const grokHome = resolveGrokHome(options);
  const configPath = resolveGrokConfigPath(options);
  const fsImpl = options.fs || fs;

  if (!options.configPath && !options.force && !fsImpl.existsSync(grokHome)) {
    if (!options.silent) console.log("Clawd: Grok home directory not found — skipping hook registration");
    return { status: "skipped", reason: "grok-home-missing", added: 0, skipped: 0, updated: 0, configPath, grokHome };
  }

  // A stale preview file next to the canonical path means two loadable Grok
  // hook files could coexist. Clawd must not mutate either one; surface a
  // review-required result so Settings does not commit installed/enabled.
  const warnings = previewWarnings(configPath, fsImpl);
  if (warnings.length > 0) {
    if (!options.silent) {
      for (const warning of warnings) console.warn(`Clawd: ${warning}`);
    }
    return {
      status: "needs-review",
      reason: "grok-stale-preview",
      added: 0,
      skipped: 0,
      updated: 0,
      changed: false,
      configPath,
      grokHome,
      warnings,
      message: warnings.join(" "),
    };
  }

  const hookScript = resolveHookScriptPath();
  const { doc, existed } = readGrokDocument(configPath, fsImpl);

  let next;
  if (!existed) {
    next = { hooks: {} };
  } else {
    validateTouchedDocument(doc, configPath);
    if (!documentHasMarker(doc)) {
      // A pre-existing file without the structured marker is foreign. Never
      // adopt, rewrite, or delete it.
      throw new Error(
        `Refusing to modify foreign Grok hook file ${configPath}: no ${MANAGED_MARKER_KEY} marker found`
      );
    }
    next = JSON.parse(JSON.stringify(doc));
  }
  if (!isPlainObject(next.hooks)) next.hooks = {};

  const resolvedNodeBin = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolvedNodeBin || "node";
  const desiredCommand = desiredHookCommand(nodeBin, hookScript, options);

  let added = 0;
  let skipped = 0;
  let updated = 0;

  for (const event of GROK_HOOK_EVENTS) {
    const result = mergeManagedEvent(next.hooks[event], desiredCommand, event);
    next.hooks[event] = result.entries;
    added += result.added;
    skipped += result.skipped;
    updated += result.updated;
  }

  const changed = added > 0 || updated > 0 || !existed;
  let backupPath = null;
  if (changed) {
    if (existed) backupPath = writeWithVerifiedBackup(configPath, next, options, fsImpl);
    else writeJsonAtomic(configPath, next);
    verifyManagedEntries(configPath, desiredCommand, fsImpl);
  }

  if (!options.silent) {
    console.log(`Clawd Grok hooks → ${configPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
  }
  const result = { added, skipped, updated, changed, configPath, grokHome, warnings };
  if (backupPath) result.backupPath = backupPath;
  return result;
}

function verifyManagedEntries(configPath, desiredCommand, fsImpl) {
  let doc;
  try {
    doc = readJsonFile(configPath);
  } catch (err) {
    throw new Error(`Failed to verify ${configPath}: ${err.message}`);
  }
  for (const event of GROK_HOOK_EVENTS) {
    const owned = collectOwnedHandlers({ hooks: { [event]: doc.hooks && doc.hooks[event] } });
    if (owned.length !== 1) {
      throw new Error(`Failed to verify ${configPath}: hooks.${event} has ${owned.length} managed handlers`);
    }
    if (!groupMatcherIsEmpty(owned[0].group)) {
      throw new Error(`Failed to verify ${configPath}: hooks.${event} managed handler is under a non-empty matcher`);
    }
    if (!handlerMatchesDesired(owned[0].handler, desiredCommand, event)) {
      throw new Error(`Failed to verify ${configPath}: hooks.${event} managed handler is not current`);
    }
  }
}

function removeOwnedFromEntries(entries) {
  const next = [];
  let removed = 0;
  let changed = false;
  for (const group of entries) {
    if (!isPlainObject(group)) {
      next.push(group);
      continue;
    }
    if (Array.isArray(group.hooks)) {
      const kept = group.hooks.filter((handler) => {
        if (!handlerHasMarker(handler)) return true;
        removed++;
        changed = true;
        return false;
      });
      if (kept.length !== group.hooks.length) {
        const remainingKeys = Object.keys(group).filter((key) => key !== "hooks" && key !== "matcher");
        if (kept.length === 0 && remainingKeys.length === 0) {
          continue; // the group existed only for the managed handler
        }
        next.push({ ...group, hooks: kept });
        continue;
      }
    }
    next.push(group);
  }
  return { entries: next, removed, changed };
}

function unregisterGrokHooks(options = {}) {
  const configPath = resolveGrokConfigPath(options);
  const fsImpl = options.fs || fs;
  if (!fsImpl.existsSync(configPath)) {
    if (!options.silent) console.log("Clawd Grok hooks removed: 0");
    return { removed: 0, changed: false, configPath };
  }

  let doc;
  try {
    doc = readJsonFile(configPath);
  } catch (err) {
    throw new Error(`Failed to read ${configPath}: ${err.message}`);
  }
  if (!isPlainObject(doc)) {
    throw new Error(`Invalid Grok hook file ${configPath}: top level must be an object`);
  }
  if (doc.hooks !== undefined && !isPlainObject(doc.hooks)) {
    throw new Error(`Invalid Grok hook file ${configPath}: "hooks" must be an object`);
  }
  // Never delete a foreign file, even on uninstall.
  if (!documentHasMarker(doc)) {
    if (!options.silent) console.log("Clawd Grok hooks removed: 0 (foreign file preserved)");
    return { removed: 0, changed: false, configPath };
  }
  // Fail closed on malformed touched shapes: an owned file must never be
  // mutated while any event that holds an owned handler is invalid.
  validateOwnedEventShapes(doc, configPath);

  const next = JSON.parse(JSON.stringify(doc));
  let removed = 0;
  let changed = false;
  if (isPlainObject(next.hooks)) {
    for (const event of Object.keys(next.hooks)) {
      const entries = next.hooks[event];
      if (!Array.isArray(entries)) continue;
      const result = removeOwnedFromEntries(entries);
      if (!result.changed) continue;
      removed += result.removed;
      changed = true;
      if (result.entries.length > 0) next.hooks[event] = result.entries;
      else delete next.hooks[event];
    }
  }

  if (!changed) {
    if (!options.silent) console.log("Clawd Grok hooks removed: 0");
    return { removed: 0, changed: false, configPath };
  }

  // Delete only when the hooks object has exactly zero keys after the exact
  // owned removal AND there is no other top-level data. Unknown/foreign/
  // malformed values keep the file alive.
  const hooksKeyCount = isPlainObject(next.hooks) ? Object.keys(next.hooks).length : 0;
  const canDelete = hooksKeyCount === 0 && !settingsHasOtherKeys(next);
  const backupPath = writeWithVerifiedBackup(configPath, next, options, fsImpl);
  if (canDelete) {
    try {
      fsImpl.unlinkSync(configPath);
    } catch (err) {
      if (err && err.code !== "ENOENT") throw err;
    }
  }

  if (!options.silent) console.log(`Clawd Grok hooks removed: ${removed}`);
  return { removed, changed: true, configPath, deletedFile: canDelete, canDelete, backupPath };
}

function settingsHasOtherKeys(doc) {
  if (!isPlainObject(doc)) return false;
  return Object.keys(doc).some((key) => key !== "hooks");
}

// Shared inspector used by Doctor, the installation detector, and cleanup so
// every consumer resolves the same dynamic path and the same structured
// ownership/contract verdict.
function inspectGrokHookFile(options = {}) {
  const fsImpl = options.fs || fs;
  const grokHome = resolveGrokHome(options);
  const configPath = resolveGrokConfigPath(options);
  const previewPath = previewPathFor(configPath);
  const result = {
    grokHome,
    configPath,
    previewPath,
    hookScript: resolveHookScriptPath(),
    parentDirExists: false,
    configFileExists: false,
    managed: false,
    managedEventCount: 0,
    managedHandlerCount: 0,
    stalePreview: false,
    warnings: [],
    health: "not-installed",
  };

  if (path.resolve(previewPath) !== path.resolve(configPath) && pathExists(fsImpl, previewPath)) {
    result.stalePreview = true;
    result.warnings.push(
      `${previewPath} looks like a PR-preview duplicate from an unshipped Grok integration; `
      + "Clawd does not own or modify it. Inspect it manually."
    );
  }

  if (!pathExists(fsImpl, grokHome)) {
    result.health = "not-installed";
    return result;
  }
  result.parentDirExists = true;

  // Two loadable Grok hook files must be surfaced for manual review: never
  // mutate either, and never offer an automatic Fix.
  if (result.stalePreview) {
    result.health = "needs-review";
    result.detail = "A stale PR-preview clawd.json exists beside the canonical file";
    return result;
  }

  if (!pathExists(fsImpl, configPath)) {
    result.health = "not-connected";
    return result;
  }
  result.configFileExists = true;

  let doc;
  try {
    doc = readJsonFile(configPath);
  } catch (err) {
    result.health = "config-corrupt";
    result.detail = err && err.message ? err.message : "config parse failed";
    return result;
  }
  if (!isPlainObject(doc)) {
    result.health = "config-corrupt";
    result.detail = "top level must be an object";
    return result;
  }

  // Grok fails the whole hook-file parse on any malformed recognized event
  // (including a malformed foreign sibling beside canonical owned handlers).
  // Report that as non-healthy and non-repairable rather than "healthy".
  try {
    validateTouchedDocument(doc, configPath);
  } catch (err) {
    result.health = "config-corrupt";
    result.detail = err && err.message ? err.message : "recognized event shape is invalid";
    return result;
  }

  const legacyCommands = findLegacyCommandPaths(doc);
  if (legacyCommands.length > 0) {
    result.legacyCommandLookalikes = legacyCommands.length;
    result.warnings.push(
      `${legacyCommands.length} handler command(s) reference ${COMMAND_MARKER} without the `
      + `${MANAGED_MARKER_KEY} structured marker; they are diagnostic-only and never Clawd-owned.`
    );
  }

  const owned = collectOwnedHandlers(doc);
  if (owned.length === 0) {
    result.health = "foreign-file";
    result.detail = `No ${MANAGED_MARKER_KEY} structured marker found`;
    return result;
  }

  result.managed = true;
  result.managedHandlerCount = owned.length;
  const managedEvents = new Set(owned.map((entry) => entry.event));
  result.managedEventCount = managedEvents.size;

  const problems = [];
  for (const event of GROK_HOOK_EVENTS) {
    const occurrences = owned.filter((entry) => entry.event === event);
    if (occurrences.length === 0) {
      problems.push(`${event}:missing`);
      continue;
    }
    if (occurrences.length > 1) {
      problems.push(`${event}:duplicate(${occurrences.length})`);
      continue;
    }
    const [{ handler, group }] = occurrences;
    if (!groupMatcherIsEmpty(group)) problems.push(`${event}:non-empty-matcher`);
    for (const problem of managedHandlerProblems(handler, event, result.hookScript)) {
      problems.push(`${event}:${problem}`);
    }
  }

  if (problems.length > 0) {
    result.health = "incomplete";
    result.problems = problems;
    result.detail = `Managed Grok handlers are not canonical: ${problems.join(", ")}`;
    return result;
  }
  result.health = "healthy";
  return result;
}

module.exports = {
  MARKER,
  COMMAND_MARKER,
  MANAGED_MARKER_KEY,
  MANAGED_MARKER_VALUE,
  LEGACY_MARKERS,
  GROK_HOOK_EVENTS,
  DEFAULT_EVENT_TIMEOUT_SECONDS,
  GROK_EVENT_TIMEOUT_SECONDS,
  UNSUPPORTED_EVENT_TIMEOUT,
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  CONFIG_FILE_NAME,
  PREVIEW_CONFIG_FILE_NAME,
  grokEventTimeoutSeconds,
  resolveGrokHome,
  resolveGrokHooksDir,
  resolveGrokConfigPath,
  resolveHookScriptPath,
  desiredHookCommand,
  parseCanonicalManagedCommand,
  handlerHasMarker,
  handlerHasExactMarkerEnv,
  documentHasMarker,
  groupMatcherIsEmpty,
  collectOwnedHandlers,
  findLegacyCommandPaths,
  validateTouchedDocument,
  validateOwnedEventShapes,
  validateMatcherGroupShape,
  validateRawHandlerShape,
  mergeManagedEvent,
  inspectGrokHookFile,
  registerGrokHooks,
  unregisterGrokHooks,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterGrokHooks({});
    else registerGrokHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
