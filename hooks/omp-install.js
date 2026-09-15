#!/usr/bin/env node
"use strict";

// Installs the Clawd <-> OMP (oh-my-pi) extension into
// ~/.omp/agent/extensions/clawd-on-desk/. Derived from hooks/pi-install.js;
// OMP is a fork of the same agent and the install contract is identical.

const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const { asarUnpackedPath, writeJsonAtomic } = require("./json-utils");
const { resolveNodeBin } = require("./server-config");

const EXTENSION_DIR_NAME = "clawd-on-desk";
const EXTENSION_FILE = "index.ts";
const CORE_FILE = "omp-extension-core.js";
const MARKER_FILE = ".clawd-managed.json";
// The community bridge (github.com/Crosery/clawd-on-desk-omp) installs as a
// single sibling file in the same extensions directory and reports the same
// lifecycle events through Clawd's custom-application channel. OMP would load
// both and POST twice per event, so its presence blocks this installer.
const STANDALONE_BRIDGE_FILE = "clawd-on-desk-omp.ts";
const OMP_CONFIG_DIR_NAME = ".omp";
const PROFILES_DIR_NAME = "profiles";
const AGENT_DIR_NAME = "agent";
const EXTENSIONS_DIR_NAME = "extensions";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), OMP_CONFIG_DIR_NAME, AGENT_DIR_NAME);
const DEFAULT_EXTENSIONS_DIR = path.join(DEFAULT_PARENT_DIR, EXTENSIONS_DIR_NAME);
const DEFAULT_EXTENSION_DIR = path.join(DEFAULT_EXTENSIONS_DIR, EXTENSION_DIR_NAME);

function resolveSourcePath(fileName, baseDir = __dirname) {
  return asarUnpackedPath(path.resolve(baseDir, fileName));
}

function writeTextAtomic(filePath, text) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(tmpPath, text, "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

function fileExists(filePath, fsImpl = fs) {
  try {
    return fsImpl.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function dirExists(dirPath, fsImpl = fs) {
  try {
    return fsImpl.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function readJsonIfPresent(filePath, fsImpl = fs) {
  try {
    const raw = fsImpl.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isManagedMarker(value) {
  return !!(
    value
    && value.app === "clawd-on-desk"
    && value.integration === "omp"
    && value.managed === true
  );
}

function buildMarker() {
  return {
    app: "clawd-on-desk",
    integration: "omp",
    managed: true,
    version: 1,
    installedAt: new Date().toISOString(),
  };
}

function commandExists(command, args, options = {}) {
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  try {
    const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1500;
    const raw = execFileSync(command, args, {
      encoding: "utf8",
      timeout,
      windowsHide: true,
    });
    return String(raw || "").trim().length > 0;
  } catch {
    return false;
  }
}

function executableExists(filePath, platform, accessSync = fs.accessSync) {
  try {
    accessSync(filePath, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hasOmpCommand(options = {}) {
  if (typeof options.ompCommandAvailable === "boolean") return options.ompCommandAvailable;
  if (typeof options.ompCommandAvailable === "function") return !!options.ompCommandAvailable();

  const platform = options.platform || process.platform;
  const accessSync = options.accessSync || fs.accessSync;
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  const nodeBin = Object.prototype.hasOwnProperty.call(options, "nodeBin")
    ? options.nodeBin
    : resolveNodeBin({ platform, execFileSync, accessSync });

  if (nodeBin && nodeBin !== "node") {
    const nodeDir = path.dirname(nodeBin);
    const candidates = platform === "win32"
      ? ["omp.cmd", "omp.exe", "omp.ps1"]
      : ["omp"];
    if (candidates.some((name) => executableExists(path.join(nodeDir, name), platform, accessSync))) {
      return true;
    }
  }

  if (platform === "win32") {
    return commandExists("where", ["omp"], { execFileSync });
  }

  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    if (commandExists(shell, ["-lic", "command -v omp"], { execFileSync })) return true;
  }
  return commandExists("sh", ["-lc", "command -v omp"], { execFileSync });
}

// OMP resolves user extensions through the ACTIVE agent directory, not a fixed
// path: the config root is <home>/<PI_CONFIG_DIR or ".omp">, a named profile
// (OMP_PROFILE ?? PI_PROFILE) lives one level deeper under profiles/<name>, and
// PI_CODING_AGENT_DIR relocates the profile-less default. Mirroring that here is
// what keeps install, uninstall, the installation detector and Doctor pointing
// at the same directory — and at the directory an OMP session will actually
// load. A directory OMP never reads would otherwise report a successful install.
//
// A profile name is a validated slug; OMP ignores an invalid one rather than
// erroring, so an invalid value is treated as "no profile" here too.
const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

function normalizeOmpProfileName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return null;
  if (name === "." || name === ".." || name.endsWith(".")) return null;
  if (!PROFILE_NAME_PATTERN.test(name)) return null;
  if (WINDOWS_RESERVED_NAME_PATTERN.test(name)) return null;
  return name;
}

function resolveOmpEnvironment(options = {}) {
  const env = options.env && typeof options.env === "object" ? options.env : process.env;
  const homeDir = typeof options.homeDir === "string" && options.homeDir
    ? options.homeDir
    : os.homedir();
  const configuredRoot = typeof env.PI_CONFIG_DIR === "string" ? env.PI_CONFIG_DIR.trim() : "";
  // OMP always joins the name under the home directory, even when the value
  // looks absolute, so an absolute-looking value must not escape it here.
  const root = path.join(homeDir, configuredRoot || OMP_CONFIG_DIR_NAME);
  const profile = normalizeOmpProfileName(env.OMP_PROFILE)
    || normalizeOmpProfileName(env.PI_PROFILE);
  return {
    env,
    homeDir,
    root,
    profile,
    configRoot: profile ? path.join(root, PROFILES_DIR_NAME, profile) : root,
  };
}

// The agent directory OMP would load extensions from for this environment.
function resolveOmpAgentDir(options = {}) {
  if (typeof options.parentDir === "string" && options.parentDir) return options.parentDir;
  const { env, configRoot, profile } = resolveOmpEnvironment(options);
  const defaultAgentDir = path.join(configRoot, AGENT_DIR_NAME);
  // An active profile owns its directory outright: OMP ignores
  // PI_CODING_AGENT_DIR while one is set.
  if (profile) return defaultAgentDir;
  const override = typeof env.PI_CODING_AGENT_DIR === "string"
    ? env.PI_CODING_AGENT_DIR.trim()
    : "";
  return override ? path.resolve(override) : defaultAgentDir;
}

// Every OTHER profile on this machine, i.e. the agent directories this
// installation does NOT manage. Clawd resolves exactly one, so a machine that
// runs OMP under a profile loads nothing from it; Doctor says so rather than
// reporting bare "verified".
function listOtherOmpProfileAgentDirs(options = {}) {
  const fsImpl = options.fs || fs;
  const { root } = resolveOmpEnvironment(options);
  const managed = path.resolve(resolveOmpAgentDir(options));
  const profilesDir = path.join(root, PROFILES_DIR_NAME);
  let entries;
  try {
    entries = fsImpl.readdirSync(profilesDir, { withFileTypes: true });
  } catch {
    // No profiles directory (the common case) or an fs double without
    // readdirSync: nothing to report.
    return [];
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry || typeof entry.isDirectory !== "function" || !entry.isDirectory()) continue;
    const agentDir = path.join(profilesDir, entry.name, AGENT_DIR_NAME);
    if (path.resolve(agentDir) === managed) continue;
    if (!dirExists(agentDir, fsImpl)) continue;
    dirs.push({ profile: entry.name, agentDir });
  }
  // readdir order is filesystem-defined; the Doctor detail renders this list,
  // so pin it to a stable order instead of whatever the directory happens to
  // return.
  return dirs.sort((a, b) => a.profile.localeCompare(b.profile));
}

function resolveExtensionsDir(options = {}) {
  if (options.extensionDir) return path.dirname(options.extensionDir);
  return path.join(resolveOmpAgentDir(options), EXTENSIONS_DIR_NAME);
}

// Path of the standalone bridge if the user already runs it, else null.
function findStandaloneBridge(options = {}) {
  const fsImpl = options.fs || fs;
  const candidate = path.join(resolveExtensionsDir(options), STANDALONE_BRIDGE_FILE);
  return fileExists(candidate, fsImpl) ? candidate : null;
}

function resolveExtensionDir(options = {}) {
  return options.extensionDir || path.join(resolveExtensionsDir(options), EXTENSION_DIR_NAME);
}

function readSourceFiles(options = {}) {
  const sourceDir = options.sourceDir || __dirname;
  const extensionPath = options.extensionSourcePath || resolveSourcePath("omp-extension.ts", sourceDir);
  const corePath = options.coreSourcePath || resolveSourcePath(CORE_FILE, sourceDir);
  return {
    extensionPath,
    corePath,
    extensionText: fs.readFileSync(extensionPath, "utf8"),
    coreText: fs.readFileSync(corePath, "utf8"),
  };
}

function registerOmpExtension(options = {}) {
  const fsImpl = options.fs || fs;
  const parentDir = resolveOmpAgentDir(options);
  const extensionDir = resolveExtensionDir(options);
  const markerPath = path.join(extensionDir, MARKER_FILE);
  const extensionPath = path.join(extensionDir, EXTENSION_FILE);
  const corePath = path.join(extensionDir, CORE_FILE);

  const parentExists = dirExists(parentDir, fsImpl);
  if (!parentExists && !hasOmpCommand(options)) {
    if (!options.silent) {
      console.log("Clawd: OMP not found - skipping OMP extension registration");
    }
    return { installed: false, skipped: true, updated: false, reason: "omp-not-found", extensionDir };
  }

  const standaloneBridge = findStandaloneBridge({ ...options, extensionDir });
  if (standaloneBridge) {
    // Clawd may have installed first, with the bridge added afterwards. The
    // bridge owns the same lifecycle events, so leaving Clawd's copy in place
    // makes OMP load BOTH and report every event twice. Retire only the copy
    // this installer verifiably wrote; a foreign directory stays untouched.
    const oursHere = dirExists(extensionDir, fsImpl)
      && isManagedMarker(readJsonIfPresent(markerPath, fsImpl));
    let removedOwnCopy = false;
    if (oursHere) {
      fsImpl.rmSync(extensionDir, { recursive: true, force: true });
      removedOwnCopy = true;
    }
    if (!options.silent) {
      console.log(`Clawd: ${standaloneBridge} already bridges OMP - skipping`);
      if (removedOwnCopy) {
        console.log(`  Removed Clawd's own copy at ${extensionDir} so OMP does not report every event twice`);
      }
      console.log("  Remove it first if you want Clawd to manage the integration instead.");
    }
    return {
      installed: false,
      skipped: true,
      updated: false,
      reason: "standalone-bridge-present",
      extensionDir,
      standaloneBridge,
      removedOwnCopy,
    };
  }

  const extensionExists = dirExists(extensionDir, fsImpl);
  if (extensionExists && !isManagedMarker(readJsonIfPresent(markerPath, fsImpl))) {
    if (!options.silent) {
      console.log(`Clawd: ${extensionDir} exists but is not Clawd-managed - skipping`);
    }
    return { installed: false, skipped: true, updated: false, reason: "unmanaged-existing-extension", extensionDir };
  }

  const { extensionText, coreText } = readSourceFiles(options);
  const previousExtension = fileExists(extensionPath, fsImpl) ? fsImpl.readFileSync(extensionPath, "utf8") : null;
  const previousCore = fileExists(corePath, fsImpl) ? fsImpl.readFileSync(corePath, "utf8") : null;
  const updated = previousExtension !== extensionText || previousCore !== coreText;

  fsImpl.mkdirSync(extensionDir, { recursive: true });
  writeTextAtomic(extensionPath, extensionText);
  writeTextAtomic(corePath, coreText);
  writeJsonAtomic(markerPath, buildMarker());

  if (!options.silent) {
    console.log(`Clawd OMP extension -> ${extensionDir}`);
    console.log(updated ? "  Installed or updated" : "  Already up to date");
  }

  return { installed: true, skipped: false, updated, extensionDir };
}

function unregisterOmpExtension(options = {}) {
  const fsImpl = options.fs || fs;
  const extensionDir = resolveExtensionDir(options);
  const markerPath = path.join(extensionDir, MARKER_FILE);
  const marker = readJsonIfPresent(markerPath, fsImpl);
  if (!dirExists(extensionDir, fsImpl)) {
    if (!options.silent) console.log("Clawd: OMP extension is not installed");
    return { removed: false, skipped: true, reason: "missing", extensionDir };
  }
  if (!isManagedMarker(marker)) {
    if (!options.silent) console.log(`Clawd: ${extensionDir} is not Clawd-managed - skipping uninstall`);
    return { removed: false, skipped: true, reason: "unmanaged-existing-extension", extensionDir };
  }
  fsImpl.rmSync(extensionDir, { recursive: true, force: true });
  if (!options.silent) console.log(`Clawd: removed OMP extension from ${extensionDir}`);
  return { removed: true, skipped: false, extensionDir };
}

module.exports = {
  CORE_FILE,
  STANDALONE_BRIDGE_FILE,
  findStandaloneBridge,
  resolveExtensionsDir,
  DEFAULT_EXTENSION_DIR,
  DEFAULT_EXTENSIONS_DIR,
  DEFAULT_PARENT_DIR,
  EXTENSION_DIR_NAME,
  EXTENSIONS_DIR_NAME,
  EXTENSION_FILE,
  MARKER_FILE,
  buildMarker,
  hasOmpCommand,
  isManagedMarker,
  listOtherOmpProfileAgentDirs,
  registerOmpExtension,
  resolveExtensionDir,
  resolveOmpAgentDir,
  resolveOmpEnvironment,
  resolveSourcePath,
  unregisterOmpExtension,
  writeTextAtomic,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) {
      unregisterOmpExtension({});
    } else {
      registerOmpExtension({});
    }
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
}
