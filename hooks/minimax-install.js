#!/usr/bin/env node
// Install/uninstall the Clawd state-reporting plugin for MiniMax Code.
//
// MiniMax Code carries hooks inside local plugins discovered under
// `<dataDir>/plugins/` (default `~/.minimax/plugins`, honor `MINIMAX_DATA_DIR`
// and `MAVIS_DATA_DIR`). The whole plugin directory is Clawd-owned: install
// writes it in full, unregister removes it after an ownership check. A
// directory that exists but is not provably ours is never mutated — install
// fails closed, uninstall leaves it and reports it. The one exception is an
// empty directory: it has no content and cannot prove ownership, so it is
// treated as unclaimed and a first install may publish over it.
//
// Ownership is proven only by a structured marker file (`.clawd-managed.json`,
// the Pi extension's convention) — never by a directory name, a manifest name,
// or a basename appearing somewhere in a document — and only when neither the
// marker nor any other managed path is a symbolic link. MiniMax ignores files
// its manifest does not reference, so the marker never reaches its loader.
//
// Layout (Claude-compatible plugin manifest → hooks parse as CLAUDE source
// format, which supports the exec-form `args` we use to avoid every shell
// quoting pitfall on Windows):
//   clawd-state/.clawd-managed.json
//   clawd-state/.claude-plugin/plugin.json
//   clawd-state/hooks/hooks.json

const fs = require("fs");
const path = require("path");
const os = require("os");
const { isDeepStrictEqual } = require("util");
const { resolveNodeBin } = require("./server-config");
const { readJsonFile, writeJsonAtomic, asarUnpackedPath } = require("./json-utils");

const PLUGIN_DIR_NAME = "clawd-state";
const MARKER = "minimax-hook.js";
const OWNER_MARKER_FILE = ".clawd-managed.json";
const OWNER_MARKER_VERSION = 1;
// Every path Clawd reads ownership from or writes through.
const MANAGED_PATHS = [
  OWNER_MARKER_FILE,
  ".claude-plugin",
  path.join(".claude-plugin", "plugin.json"),
  "hooks",
  path.join("hooks", "hooks.json"),
];
// Staging / removal directories live beside `plugins/` (in the data directory
// itself), so MiniMax's plugin scan never sees a half-built or half-removed
// plugin, while a same-filesystem rename still publishes or retires it at once.
const STAGING_PREFIX = ".clawd-minimax-staging-";
const REMOVAL_PREFIX = ".clawd-minimax-removing-";
const DEFAULT_DATA_DIR = path.join(os.homedir(), ".minimax");
const DEFAULT_PLUGIN_ROOT = path.join(DEFAULT_DATA_DIR, "plugins", PLUGIN_DIR_NAME);

// MiniMax's plugin hook event set (PLUGIN_HOOK_EVENTS). PermissionRequest is
// deliberately not registered: the plugin-hook runner caps every handler at
// 1–10 seconds (SessionEnd events get a 3s budget in total), so a blocking
// human-approval round trip is physically impossible. There is no Notification
// event.
const MINIMAX_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
];

// MiniMax parses `timeout` as whole seconds and drops any handler whose value
// is not an integer in 1–10 (it is rejected, not clamped). The hook answers
// stdout immediately and POSTs to Clawd with a 100ms budget, so 2s leaves
// ample headroom under the 3s SessionEnd event budget.
const HOOK_TIMEOUT_SECONDS = 2;

// `<dataDir>` resolution mirrors MiniMax's own precedence (v0.5.1):
// MINIMAX_DATA_DIR → MAVIS_DATA_DIR → `~/.minimax`. Installer, uninstaller,
// cleanup, installation detection, and Doctor all resolve through this single
// helper so a custom data dir can never strand the plugin in a place another
// code path does not look at.
function resolveMinimaxDataDir(homeDir, env) {
  const source = env || process.env;
  for (const key of ["MINIMAX_DATA_DIR", "MAVIS_DATA_DIR"]) {
    const value = typeof source[key] === "string" ? source[key].trim() : "";
    if (value) return value;
  }
  return path.join(homeDir || os.homedir(), ".minimax");
}

function resolveDataDir(options = {}) {
  return options.dataDir || resolveMinimaxDataDir(options.homeDir || os.homedir(), options.env);
}

function resolvePluginRoot(options = {}) {
  if (options.pluginRoot) return options.pluginRoot;
  return path.join(resolveDataDir(options), "plugins", PLUGIN_DIR_NAME);
}

// Where staging and removal directories go: the data directory, never
// `plugins/`. A caller that passes only `pluginRoot` gets its grandparent
// (`<dataDir>/plugins/<name>` → `<dataDir>`), which is the data directory.
// MiniMax treats every directory in `plugins/` as a plugin candidate, dot-names
// included, so a half-built or half-removed directory must never live there.
function resolveWorkParent(options = {}) {
  if (options.dataDir) return options.dataDir;
  if (options.pluginRoot) return path.dirname(path.dirname(options.pluginRoot));
  return resolveDataDir(options);
}

// Read a JSON file through an injectable fs (Doctor passes the harness fs).
function readJsonWith(fsImpl, filePath) {
  return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// lstat (so a symlink is seen as a link, not as its target). Falls back to
// stat for injected fs shims that do not implement lstatSync.
//
// Only ENOENT / ENOTDIR mean "not there". Any other error (EACCES, EPERM,
// EIO…) means the path could not be inspected, which must never be read as
// absence: that would let Uninstall report a live plugin as removed.
function lstatState(fsImpl, targetPath) {
  try {
    const stat = typeof fsImpl.lstatSync === "function"
      ? fsImpl.lstatSync(targetPath)
      : fsImpl.statSync(targetPath);
    return { kind: "present", stat };
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return { kind: "missing" };
    return { kind: "error", error: err };
  }
}

function isSymlinkStat(stat) {
  return !!stat && typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink();
}

// A real directory with no entries at all. Anything else — a link, a file,
// a directory holding even one entry, or one that cannot be listed — is not
// empty, so the fail-closed rules still apply to it.
function isEmptyDirectory(fsImpl, targetPath) {
  const state = lstatState(fsImpl, targetPath);
  if (state.kind !== "present" || isSymlinkStat(state.stat) || !state.stat.isDirectory()) return false;
  if (typeof fsImpl.readdirSync !== "function") return false;
  try {
    return fsImpl.readdirSync(targetPath).length === 0;
  } catch {
    return false;
  }
}

function buildOwnerMarker() {
  return {
    app: "clawd-on-desk",
    integration: "minimax",
    managed: true,
    version: OWNER_MARKER_VERSION,
  };
}

function isOwnerMarker(value) {
  return isPlainObject(value)
    && value.app === "clawd-on-desk"
    && value.integration === "minimax"
    && value.managed === true;
}

function isAbsoluteCommandPath(value) {
  return typeof value === "string"
    && value.length > 0
    && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));
}

function isHookScriptArg(value) {
  if (!isAbsoluteCommandPath(value)) return false;
  return value.replace(/\\/g, "/").endsWith(`/hooks/${MARKER}`);
}

// The `command` of every handler that runs Clawd's hook script in exec form
// (its first argument is an absolute path to hooks/minimax-hook.js). Used by
// recordedNodeBin, which needs that exact node path — the broader
// documentReferencesClawdHook below covers shell-form handlers too.
function clawdHookCommands(doc) {
  const commands = [];
  for (const handler of collectHookHandlers(doc)) {
    if (Array.isArray(handler.args) && isHookScriptArg(handler.args[0])) commands.push(handler.command);
  }
  return commands;
}

// Every handler in a hooks document. The envelope rule mirrors MiniMax's
// readHooksEnvelope (parsePluginHookDocuments): a plain-object `hooks` field is
// the events map, otherwise the whole document is itself the events map — so a
// bare `{ "SessionStart": [...] }` document runs too and must not be read as
// absent. Groups whose `hooks` is not an array contribute none.
function collectHookHandlers(doc) {
  const handlers = [];
  if (!isPlainObject(doc)) return handlers;
  const events = isPlainObject(doc.hooks) ? doc.hooks : doc;
  for (const groups of Object.values(events)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const groupHandlers = isPlainObject(group) && Array.isArray(group.hooks) ? group.hooks : [];
      for (const handler of groupHandlers) {
        if (isPlainObject(handler)) handlers.push(handler);
      }
    }
  }
  return handlers;
}

// Whether any handler could run Clawd's hook script: exec-form args, a shell
// `command` (MiniMax runs command-only CLAUDE handlers through a shell), or the
// Windows command fields. A case-insensitive `minimax-hook.js` substring in any
// of them counts. This is only "may still be running Clawd's hook" and
// over-reports on purpose — it is never an ownership signal; ownership stays
// the marker file alone.
function documentReferencesClawdHook(doc) {
  const mentions = (value) => typeof value === "string" && value.toLowerCase().includes(MARKER.toLowerCase());
  for (const handler of collectHookHandlers(doc)) {
    if (mentions(handler.command) || mentions(handler.commandWindows) || mentions(handler.command_windows)) {
      return true;
    }
    if (Array.isArray(handler.args) && handler.args.some(mentions)) return true;
  }
  return false;
}

function readOwnership(pluginRoot, fsImpl) {
  // Returns { owned: true } or { owned: false, reason }.
  const f = fsImpl || fs;
  const rootState = lstatState(f, pluginRoot);
  if (rootState.kind === "missing") return { owned: false, reason: "missing" };
  if (rootState.kind === "error") return { owned: false, reason: "uninspectable-root" };
  const rootStat = rootState.stat;
  // MiniMax itself refuses symlinked plugin roots, and following one would let
  // install write into — or uninstall recurse through — an arbitrary target.
  if (isSymlinkStat(rootStat)) return { owned: false, reason: "symlink-root" };
  if (!rootStat.isDirectory()) return { owned: false, reason: "not-a-directory" };
  // A real directory with no entries is unclaimed: it has no manifest, MiniMax
  // will not load it, and it cannot prove ownership. This also covers a writer
  // that was interrupted between mkdir and its first write.
  if (isEmptyDirectory(f, pluginRoot)) return { owned: false, reason: "empty-directory" };
  // Ownership is only ever read from, and files only ever written through,
  // real paths inside this directory: a linked marker could borrow a Clawd
  // marker from elsewhere, and a linked `hooks/` would carry a Repair outside.
  for (const relative of MANAGED_PATHS) {
    const state = lstatState(f, path.join(pluginRoot, relative));
    if (state.kind === "error") return { owned: false, reason: "uninspectable-managed-path" };
    if (state.kind === "present" && isSymlinkStat(state.stat)) {
      return { owned: false, reason: "symlinked-managed-path" };
    }
  }

  const markerPath = path.join(pluginRoot, OWNER_MARKER_FILE);
  const markerState = lstatState(f, markerPath);
  if (markerState.kind === "missing") return { owned: false, reason: "missing-marker" };
  if (markerState.kind === "error") return { owned: false, reason: "unreadable-owner-marker" };
  if (!markerState.stat.isFile()) return { owned: false, reason: "owner-marker-not-a-file" };
  let marker;
  try {
    marker = readJsonWith(f, markerPath);
  } catch {
    return { owned: false, reason: "unreadable-owner-marker" };
  }
  if (!isOwnerMarker(marker)) return { owned: false, reason: "foreign-owner-marker" };
  if (marker.version !== OWNER_MARKER_VERSION) return { owned: false, reason: "unsupported-owner-marker-version" };
  return { owned: true };
}

// MiniMax 0.5.4 resolves a Claude-compatible manifest's `hooks` field like
// this: undefined → hooks/hooks.json; a non-empty string (or an object with a
// non-empty string `path`) → that one file, trimmed; any other plain object →
// the inline document itself; an array → each string / { path } element, also
// trimmed, with everything else invalid and ignored. Clawd follows the same
// rules so a hook document declared anywhere else is not mistaken for "no
// Clawd hook".
function declaredHookEntries(declared) {
  if (declared === undefined) return [{ path: "hooks/hooks.json" }];
  if (typeof declared === "string") {
    const trimmed = declared.trim();
    return trimmed ? [{ path: trimmed }] : [{ invalid: true }];
  }
  if (isPlainObject(declared)) {
    if (typeof declared.path === "string" && declared.path.trim()) {
      return [{ path: declared.path.trim() }];
    }
    return [{ inline: declared }];
  }
  if (Array.isArray(declared)) {
    return declared.map((entry) => {
      if (typeof entry === "string" && entry.trim()) return { path: entry.trim() };
      if (isPlainObject(entry) && typeof entry.path === "string" && entry.path.trim()) {
        return { path: entry.path.trim() };
      }
      return { invalid: true };
    });
  }
  return [{ invalid: true }];
}

// Read a JSON document that a manifest points at, staying inside the plugin
// directory. Returns `{ kind: "value", value }`, `{ kind: "missing" }`, or
// `{ kind: "unknown" }` for anything Clawd cannot safely resolve or parse.
function readContainedJson(f, root, relative) {
  if (typeof relative !== "string" || !relative) return { kind: "unknown" };
  if (relative.includes("\0")) return { kind: "unknown" };
  if (path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) return { kind: "unknown" };
  // MiniMax's own resolver (kHe) splits on both separators before path.resolve,
  // so `hooks\other.json` means hooks/other.json on every platform. Match that
  // instead of letting POSIX treat the backslash as a literal name character.
  const abs = path.resolve(root, ...relative.split(/[\\/]/));
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return { kind: "unknown" };
  const segments = rel.split(path.sep);
  let current = root;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    const state = lstatState(f, current);
    if (state.kind === "missing") return { kind: "missing" };
    if (state.kind === "error") return { kind: "unknown" };
    if (isSymlinkStat(state.stat)) return { kind: "unknown" };
    if (i === segments.length - 1 && !state.stat.isFile()) return { kind: "unknown" };
  }
  try {
    return { kind: "value", value: JSON.parse(f.readFileSync(abs, "utf8")) };
  } catch {
    return { kind: "unknown" };
  }
}

// Whether the directory still runs Clawd's hook under MiniMax's real loading
// rules: true when a handler referencing our script is found anywhere; false
// when Clawd can positively confirm there is none; null when some part is
// unmodellable or unreadable and no Clawd handler was found — never "gone".
function hooksReferenceClawdHook(pluginRoot, fsImpl) {
  const f = fsImpl || fs;
  const rootState = lstatState(f, pluginRoot);
  if (rootState.kind === "missing") return false;
  if (rootState.kind === "error") return null;
  // Clawd does not follow links; whether a given MiniMax version skips a linked
  // plugin is a version detail, so a link is "unknown", not "no hook".
  if (isSymlinkStat(rootState.stat)) return null;
  if (!rootState.stat.isDirectory()) return false;

  let found = false;
  let unknown = false;
  const inspectDocument = (relative) => {
    const read = readContainedJson(f, pluginRoot, relative);
    if (read.kind === "unknown") unknown = true;
    else if (read.kind === "value" && documentReferencesClawdHook(read.value)) found = true;
  };

  // Manifest formats Clawd does not model could still declare a hook document
  // that runs our script, so their presence reads as unknown rather than "no".
  for (const manifestRelative of ["plugin.json", ".minimax-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
    if (lstatState(f, path.join(pluginRoot, manifestRelative)).kind !== "missing") unknown = true;
  }

  const claudeManifest = readContainedJson(f, pluginRoot, ".claude-plugin/plugin.json");
  if (claudeManifest.kind === "unknown") {
    unknown = true;
  } else if (claudeManifest.kind === "value") {
    if (!isPlainObject(claudeManifest.value)) {
      unknown = true;
    } else {
      for (const entry of declaredHookEntries(claudeManifest.value.hooks)) {
        if (entry.path !== undefined) inspectDocument(entry.path);
        else if (entry.inline !== undefined) {
          if (documentReferencesClawdHook(entry.inline)) found = true;
          else unknown = true;
        } else {
          unknown = true;
        }
      }
    }
  }

  // Always also check Clawd's own location, even when the manifest named a
  // different file: over-reporting only keeps Uninstall from claiming success.
  inspectDocument("hooks/hooks.json");

  if (found) return true;
  return unknown ? null : false;
}

function resolveHookScriptPath() {
  return asarUnpackedPath(path.resolve(__dirname, "minimax-hook.js").replace(/\\/g, "/"));
}

function desiredManifest() {
  return {
    name: PLUGIN_DIR_NAME,
    displayName: "Clawd on Desk",
    version: "1.0.0",
    description: "Reports MiniMax Code session state to the Clawd on Desk desktop pet.",
    hooks: ["hooks/hooks.json"],
  };
}

function desiredHooksDocument(hookScript, nodeBin) {
  // One group per event, matcher omitted (matches everything), exec-form
  // args so the command is spawned directly without a shell — identical
  // behavior on Windows/macOS/Linux and no quoting around paths with spaces.
  const handler = { type: "command", command: nodeBin, args: [hookScript], timeout: HOOK_TIMEOUT_SECONDS };
  const hooks = {};
  for (const event of MINIMAX_HOOK_EVENTS) {
    hooks[event] = [{ hooks: [handler] }];
  }
  return { hooks };
}

const NODE_BASENAME_RE = /^node(js)?(\.exe)?$/i;

// The node binary an earlier install recorded: every handler that runs our
// hook script must name the same absolute path, and it must be named like a
// Node binary. A mixed or edited document proves nothing and yields null.
function recordedNodeBin(hooks) {
  const commands = clawdHookCommands(hooks);
  if (commands.length === 0 || new Set(commands).size !== 1) return null;
  const command = commands[0];
  if (!isAbsoluteCommandPath(command)) return null;
  const basename = command.replace(/\\/g, "/").split("/").pop();
  return NODE_BASENAME_RE.test(basename) ? command : null;
}

function isExecutableFile(fsImpl, filePath) {
  try {
    if (!fsImpl.statSync(filePath).isFile()) return false;
  } catch {
    return false;
  }
  if (process.platform === "win32" || typeof fsImpl.accessSync !== "function") return true;
  try {
    fsImpl.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// A recorded path is kept only if it actually runs as Node: a bounded
// `--version` probe. The name and the executable bit alone prove nothing — an
// empty executable file named node fails every spawn with ENOEXEC.
const NODE_PROBE_TIMEOUT_MS = 1500;
function probeNodeBinary(nodePath) {
  try {
    const result = require("child_process").spawnSync(nodePath, ["--version"], {
      encoding: "utf8",
      timeout: NODE_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return !result.error && result.status === 0 && /^v\d+\.\d+\.\d+/.test(String(result.stdout || "").trim());
  } catch {
    return false;
  }
}

// The node binary the hooks document should name. When detection comes back
// empty (a login shell that timed out, an unusual install location), keep the
// node path an earlier install recorded — as the TraeCode / Qoder / QwenWork /
// WorkBuddy installers do — rather than degrading to bare "node": exec-form
// handlers are spawned without a shell, and a desktop app launched from the
// Dock has no node on its PATH, so a bare "node" silently disables every hook.
// Installer and Doctor share this so they never disagree.
function resolveDesiredNodeBin(options = {}) {
  const detect = typeof options.resolveNodeBin === "function" ? options.resolveNodeBin : resolveNodeBin;
  const resolved = options.nodeBin !== undefined ? options.nodeBin : detect();
  if (resolved) return resolved;
  const recorded = recordedNodeBin(options.existingHooks);
  // The probe only runs on the fallback path, so a normal install never spawns.
  const probe = typeof options.probeNodeBin === "function" ? options.probeNodeBin : probeNodeBinary;
  if (recorded && isExecutableFile(options.fs || fs, recorded) && probe(recorded)) return recorded;
  return "node";
}

function readJsonOrUndefined(filePath) {
  try {
    return readJsonFile(filePath);
  } catch {
    return undefined;
  }
}

function uniqueWorkPath(parent, prefix) {
  return path.join(parent, `${prefix}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
}

// rename never merges and never replaces anything with content: POSIX
// rename(2) replaces only an EMPTY target directory (unclaimed, see
// isEmptyDirectory) and fails with ENOTEMPTY/EEXIST/ENOTDIR for a non-empty
// directory, a file, or a link. Windows never replaces an existing directory,
// so an empty target is removed first; rmdir itself refuses a non-empty one.
function publishDirectory(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (!isEmptyDirectory(fs, to)) throw err;
    fs.rmdirSync(to);
    fs.renameSync(from, to);
  }
}

// A first install is assembled in a staging directory and published with one
// rename, so MiniMax — and the next install — only ever sees no plugin or a
// complete, marked one. A failure at any step removes the staging directory
// and leaves nothing behind that could strand the next attempt.
function publishFreshPlugin(pluginRoot, workParent, desired, writeJson) {
  fs.mkdirSync(path.dirname(pluginRoot), { recursive: true });
  fs.mkdirSync(workParent, { recursive: true });
  const staging = uniqueWorkPath(workParent, STAGING_PREFIX);
  fs.mkdirSync(staging);
  try {
    writeJson(path.join(staging, OWNER_MARKER_FILE), buildOwnerMarker());
    writeJson(path.join(staging, ".claude-plugin", "plugin.json"), desired.manifest);
    writeJson(path.join(staging, "hooks", "hooks.json"), desired.hooks);
    publishDirectory(staging, pluginRoot);
  } catch (err) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Install (or refresh) the Clawd MiniMax plugin directory.
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.homeDir] internal override for tests
 * @param {string} [options.dataDir] internal override for tests
 * @param {string} [options.pluginRoot] internal override for tests
 * @param {string|null} [options.nodeBin] internal override for tests (null = detection failed)
 * @param {Function} [options.writeJsonAtomic] internal override for tests
 * @returns {{ added: number, skipped: number, updated: number, pluginRoot: string }}
 */
function installMinimaxPlugin(options = {}) {
  const pluginRoot = resolvePluginRoot(options);
  const writeJson = typeof options.writeJsonAtomic === "function" ? options.writeJsonAtomic : writeJsonAtomic;

  // A root that cannot be inspected must not be treated as absent: writing
  // there could race or collide with content Clawd never saw.
  const rootState = lstatState(fs, pluginRoot);
  if (rootState.kind === "error") {
    const detail = (rootState.error && (rootState.error.code || rootState.error.message)) || rootState.error;
    throw new Error(`Refusing to modify ${pluginRoot}: cannot inspect it (${detail})`);
  }

  // An existing directory is only ever touched after the ownership check
  // passes; anything not provably ours (foreign plugin of any manifest kind,
  // unrelated user content, an unmarked pre-release install, a symlink) fails
  // closed. A real empty directory is unclaimed (see readOwnership) and is
  // published over as a first install.
  let freshPublish = rootState.kind === "missing";
  if (!freshPublish) {
    const ownership = readOwnership(pluginRoot);
    if (!ownership.owned) {
      if (ownership.reason === "empty-directory") {
        freshPublish = true;
      } else {
        throw new Error(
          `Refusing to modify ${pluginRoot}: existing directory is not a Clawd plugin (${ownership.reason})`
        );
      }
    }
  }

  // Skip when MiniMax Code has no data directory (not installed on this
  // machine) — do not create `~/.minimax` on behalf of an absent app.
  const dataDir = resolveDataDir(options);
  if (!options.pluginRoot && !fs.existsSync(dataDir)) {
    if (!options.silent) {
      console.log(`Clawd: ${dataDir} not found — skipping MiniMax Code plugin install`);
    }
    return { added: 0, skipped: 0, updated: 0, pluginRoot };
  }

  const manifestPath = path.join(pluginRoot, ".claude-plugin", "plugin.json");
  const hooksPath = path.join(pluginRoot, "hooks", "hooks.json");
  // A first install (no directory, or an unclaimed empty one) has no prior
  // document to carry a node path forward from.
  const existingHooks = freshPublish ? undefined : readJsonOrUndefined(hooksPath);
  const existingManifest = freshPublish ? undefined : readJsonOrUndefined(manifestPath);
  const nodeBin = resolveDesiredNodeBin({ nodeBin: options.nodeBin, existingHooks });
  const desired = {
    manifest: desiredManifest(),
    hooks: desiredHooksDocument(resolveHookScriptPath(), nodeBin),
  };

  let result;
  if (freshPublish) {
    publishFreshPlugin(pluginRoot, resolveWorkParent(options), desired, writeJson);
    result = { added: MINIMAX_HOOK_EVENTS.length, skipped: 0, updated: 0 };
  } else {
    // An owned directory (valid marker, no linked managed path) is refreshed
    // in place. Its marker already exists, so a refresh interrupted between
    // the per-file atomic writes stays provably ours and the next install
    // finishes it. Only files whose content changed are rewritten: startup
    // sync runs on every launch for installed+enabled users.
    if (!isDeepStrictEqual(existingManifest, desired.manifest)) {
      writeJson(manifestPath, desired.manifest);
    }
    if (isDeepStrictEqual(existingHooks, desired.hooks)) {
      result = { added: 0, skipped: MINIMAX_HOOK_EVENTS.length, updated: 0 };
    } else {
      writeJson(hooksPath, desired.hooks);
      result = { added: 0, skipped: 0, updated: MINIMAX_HOOK_EVENTS.length };
    }
  }

  if (!options.silent) {
    console.log(`Clawd MiniMax Code plugin → ${pluginRoot}`);
    console.log(`  Added: ${result.added}, updated: ${result.updated}, skipped: ${result.skipped}`);
    console.log("  If hooks do not fire, enable the plugin inside MiniMax Code (mcode plugin enable clawd-state@local).");
  }
  return { ...result, pluginRoot };
}

// Uninstall result for a directory Clawd will not delete. When that directory
// still runs Clawd's hook (or that cannot be read), the registration is not
// gone: report registrationRemoved false / null with the exact path so
// Settings and About cleanup keep the install intent and tell the user.
function refusedUninstallResult(pluginRoot, reason) {
  const runsClawdHook = hooksReferenceClawdHook(pluginRoot);
  if (runsClawdHook === false) {
    // The registration really is gone, but the directory stays and blocks the
    // next Install. No residualPaths: this directory is not Clawd's, so the
    // user must not be led to delete it as if it were.
    return {
      removed: 0,
      changed: false,
      pluginRoot,
      reason,
      registrationRemoved: true,
      warnings: [
        `${pluginRoot} is not a Clawd plugin (${reason}), so Clawd left it untouched. `
          + "It does not run Clawd's hook, but Install will refuse to write there until you remove or rename it.",
      ],
    };
  }
  return {
    removed: 0,
    changed: false,
    pluginRoot,
    reason,
    registrationRemoved: runsClawdHook === true ? false : null,
    activeEntryRemaining: runsClawdHook === true ? true : null,
    residualPaths: [pluginRoot],
    message: `${pluginRoot} ${runsClawdHook === true ? "still runs" : "may still run"} Clawd's MiniMax hook, `
      + `but Clawd cannot prove it owns that directory (${reason}), so it was left untouched. `
      + "Delete the directory manually to finish uninstalling.",
  };
}

// After the verified directory has left plugins/, another Clawd instance could
// have seen the root as missing and published a fresh plugin there. Re-read the
// location once, so a reinstall already present at this check is reported
// instead of being claimed removed. This is a snapshot: an install that lands
// after it (even before Settings persists the result) is not covered.
function recheckReinstalledAtRoot(pluginRoot, result) {
  const state = lstatState(fs, pluginRoot);
  if (state.kind === "missing") return result;
  const ownership = readOwnership(pluginRoot);
  if (ownership.reason === "empty-directory") return result;

  const residualPaths = [pluginRoot, ...(Array.isArray(result.residualPaths) ? result.residualPaths : [])];

  if (ownership.owned) {
    return {
      ...result,
      registrationRemoved: false,
      activeEntryRemaining: true,
      residualPaths,
      message: `Clawd removed the original MiniMax plugin, but a new plugin was installed at ${pluginRoot} `
        + "before this uninstall returned (possibly by another Clawd instance). It is still registered; "
        + "close that instance and uninstall again.",
    };
  }

  const runsClawdHook = hooksReferenceClawdHook(pluginRoot);
  if (runsClawdHook === true) {
    return {
      ...result,
      registrationRemoved: false,
      activeEntryRemaining: true,
      residualPaths,
      message: `${pluginRoot} still runs Clawd's MiniMax hook but Clawd cannot prove it owns that directory `
        + `(${ownership.reason}); close the other Clawd instance and uninstall again, or delete it manually.`,
    };
  }
  if (runsClawdHook === null) {
    return {
      ...result,
      registrationRemoved: null,
      activeEntryRemaining: null,
      residualPaths,
      message: `${pluginRoot} may still run Clawd's MiniMax hook and cannot be confirmed removed `
        + `(${ownership.reason}); inspect it manually before relying on this uninstall.`,
    };
  }
  // Nothing of Clawd's runs there: keep the removal result's own leftovers but
  // do not list this foreign directory as residue (same rule as
  // refusedUninstallResult) — only warn that it blocks the next Install.
  return {
    ...result,
    registrationRemoved: true,
    warnings: [
      ...(Array.isArray(result.warnings) ? result.warnings : []),
      `${pluginRoot} is not a Clawd plugin (${ownership.reason}), so Clawd left it untouched. `
        + "It does not run Clawd's hook, but Install will refuse to write there until you remove or rename it.",
    ],
  };
}

/**
 * Remove the Clawd MiniMax plugin directory after verifying ownership.
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.homeDir] internal override for tests
 * @param {string} [options.dataDir] internal override for tests
 * @param {string} [options.pluginRoot] internal override for tests
 * @returns {{
 *   removed: number,
 *   changed: boolean,
 *   pluginRoot: string,
 *   registrationRemoved: boolean|null,
 *   reason?: string,
 *   status?: "error",
 *   message?: string,
 *   warnings?: string[],
 *   residualPaths?: string[],
 *   activeEntryRemaining?: boolean|null,
 * }}
 */
function unregisterMinimaxPlugin(options = {}) {
  const pluginRoot = resolvePluginRoot(options);
  const rootState = lstatState(fs, pluginRoot);
  if (rootState.kind === "missing") {
    return { removed: 0, changed: false, pluginRoot, registrationRemoved: true };
  }
  if (rootState.kind === "error") {
    const detail = (rootState.error && (rootState.error.code || rootState.error.message)) || rootState.error;
    return {
      status: "error",
      message: `Could not inspect ${pluginRoot} (${detail}); Clawd cannot confirm the MiniMax plugin was removed.`,
      removed: 0,
      changed: false,
      pluginRoot,
      registrationRemoved: null,
      activeEntryRemaining: null,
      residualPaths: [pluginRoot],
    };
  }

  const ownership = readOwnership(pluginRoot);
  if (!ownership.owned) {
    if (ownership.reason === "empty-directory") {
      // Unclaimed and empty: it does not run Clawd's hook and does not block a
      // later Install (which publishes over it), so the registration is gone.
      return { removed: 0, changed: false, pluginRoot, registrationRemoved: true };
    }
    if (!options.silent) console.log(`Clawd: ${pluginRoot} is not a Clawd plugin — leaving it untouched`);
    return refusedUninstallResult(pluginRoot, ownership.reason);
  }

  // Move the verified directory out of MiniMax's plugins folder, re-verify
  // what actually moved, and only then delete it: the recursive delete never
  // runs against a path that was not just proven to be ours.
  const removing = uniqueWorkPath(resolveWorkParent(options), REMOVAL_PREFIX);
  try {
    fs.renameSync(pluginRoot, removing);
  } catch (err) {
    return {
      status: "error",
      message: `Could not remove ${pluginRoot}: ${err && err.message ? err.message : err}`,
      removed: 0,
      changed: false,
      pluginRoot,
      registrationRemoved: null,
      residualPaths: [pluginRoot],
    };
  }
  const moved = readOwnership(removing);
  if (!moved.owned) {
    // Whatever moved is not the directory we verified — put it back untouched.
    let restoreError = null;
    try {
      fs.renameSync(removing, pluginRoot);
    } catch (err) {
      restoreError = err;
    }
    if (!restoreError) return refusedUninstallResult(pluginRoot, moved.reason);
    // Neither location can be vouched for: whatever sits at pluginRoot now
    // appeared after the check, and the moved directory is no longer provably
    // ours. Report both and claim nothing.
    const residualPaths = [removing];
    if (lstatState(fs, pluginRoot).kind !== "missing") residualPaths.push(pluginRoot);
    const detail = (restoreError.code || restoreError.message) || restoreError;
    return {
      removed: 0,
      changed: true,
      pluginRoot,
      reason: moved.reason,
      registrationRemoved: null,
      activeEntryRemaining: null,
      residualPaths,
      message: `Clawd moved ${pluginRoot} to ${removing} but could not verify what it moved (${moved.reason}) `
        + `or move it back (${detail}). Inspect both paths and delete them manually to finish uninstalling.`,
    };
  }
  let result;
  try {
    fs.rmSync(removing, { recursive: true, force: true });
    if (!options.silent) console.log(`Clawd MiniMax Code plugin removed: ${pluginRoot}`);
    result = { removed: MINIMAX_HOOK_EVENTS.length, changed: true, pluginRoot, registrationRemoved: true };
  } catch (err) {
    // The plugin has left plugins/ already, so MiniMax will not load it and the
    // registration is gone; only the leftover directory needs manual cleanup.
    const detail = (err && (err.code || err.message)) || err;
    result = {
      removed: MINIMAX_HOOK_EVENTS.length,
      changed: true,
      pluginRoot,
      registrationRemoved: true,
      residualPaths: [removing],
      warnings: [
        `Moved the MiniMax plugin out of ${path.dirname(pluginRoot)}, but could not delete ${removing} (${detail}). `
          + "MiniMax does not scan that folder; delete it manually.",
      ],
    };
  }
  return recheckReinstalledAtRoot(pluginRoot, result);
}

module.exports = {
  DEFAULT_DATA_DIR,
  DEFAULT_PLUGIN_ROOT,
  HOOK_TIMEOUT_SECONDS,
  MARKER,
  MINIMAX_HOOK_EVENTS,
  OWNER_MARKER_FILE,
  OWNER_MARKER_VERSION,
  PLUGIN_DIR_NAME,
  REMOVAL_PREFIX,
  STAGING_PREFIX,
  buildDesiredHooksDocument: desiredHooksDocument,
  buildOwnerMarker,
  desiredManifest,
  hooksReferenceClawdHook,
  installMinimaxPlugin,
  isOwnerMarker,
  readOwnership,
  recordedNodeBin,
  resolveDesiredNodeBin,
  resolveHookScriptPath,
  resolveMinimaxDataDir,
  resolvePluginRoot,
  unregisterMinimaxPlugin,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) {
      const result = unregisterMinimaxPlugin({});
      if (result.registrationRemoved !== true) {
        console.error(result.message || `Could not remove ${result.pluginRoot}`);
        process.exit(1);
      }
    } else {
      installMinimaxPlugin({});
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
