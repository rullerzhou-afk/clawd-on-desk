"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { getAgentDescriptors } = require("./doctor-detectors/agent-descriptors");
const { normalizePathList } = require("./prefs");
const copilot = require("../hooks/copilot-install");
const antigravity = require("../hooks/antigravity-install");
const hermes = require("../hooks/hermes-install");
const reasonix = require("../hooks/reasonix-install");
const dsh = require("../hooks/dsh-install");
const { commandMatchesMarker } = require("../hooks/json-utils");
const { identifyCustomApplication } = require("./custom-applications");

// Agents whose detector parent dir the DEFAULT startup sync creates on its own,
// before the agent has left any evidence of its own. For those, "the directory
// exists" only proves Clawd ran, so they are excluded from local detection.
//
// #895: this used to be the whole default-integration list, on the assumption
// that Clawd creates both ~/.claude and ~/.codex. Only the first is true —
// hooks/install.js writes ~/.claude/settings.json into a missing directory,
// while hooks/codex-install-utils.js bails out when ~/.codex is absent and
// writes nothing. Codex was therefore excluded on a false premise, and Settings
// could never report a genuinely installed Codex.
//
// The test is specifically the default auto-sync, not "any install path can
// create it": an explicit Pi install does create ~/.pi from scratch, but Pi
// ships integrationInstalled=false so nothing syncs it unattended, and its
// directory remains real evidence.
const DEFAULT_AUTO_SYNC_CREATED_PARENT_DIR_AGENT_IDS = new Set(["claude-code"]);
const LOW_CONFIDENCE = "low";
const GEMINI_PARENT_DIR_NOISE_FILES = new Set([
  ".DS_Store",
  ".localized",
  "Thumbs.db",
  "desktop.ini",
]);
const GEMINI_PARENT_DIR_NOISE_SUFFIXES = [
  ".bak",
  ".backup",
  ".old",
  ".orig",
  ".swp",
  ".swo",
  ".tmp",
  "~",
];
// #895: Antigravity squats inside Gemini CLI's ~/.gemini. Google's docs assign
// ~/.gemini/antigravity to the Antigravity app and ~/.gemini/antigravity-cli to
// agy; installing the Antigravity app alone creates the former (its bundled
// Resources/bin binaries are copied there), with no Gemini CLI anywhere. Only
// `config` used to be excluded here, so either of the other two made the
// detector report Gemini CLI as installed with medium confidence — enough to
// raise the "connect this agent" banner. Derive the two Clawd already owns from
// the installer so they cannot drift; `antigravity` has no constant because
// Clawd never writes there.
const GEMINI_PARENT_DIR_FOREIGN_DIRS = new Set([
  path.basename(antigravity.DEFAULT_PARENT_DIR),
  path.basename(path.dirname(antigravity.DEFAULT_STATUSLINE_SETTINGS_PATH)),
  "antigravity",
]);

function dirExists(fsImpl, dirPath) {
  if (!dirPath) return false;
  try {
    return fsImpl.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(fsImpl, filePath) {
  if (!filePath) return false;
  try {
    return fsImpl.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function statPath(fsImpl, filePath) {
  if (!filePath) return null;
  try {
    const stat = fsImpl.statSync(filePath);
    if (stat.isDirectory()) return "dir";
    if (stat.isFile()) return "file";
    return "other";
  } catch {
    return null;
  }
}

function readText(fsImpl, filePath) {
  try {
    return fsImpl.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function listDir(fsImpl, dirPath) {
  try {
    return fsImpl.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function checkedAtValue(now) {
  if (typeof now === "function") {
    const value = now();
    return Number.isFinite(value) ? value : Date.now();
  }
  return Number.isFinite(now) ? now : Date.now();
}

function rebaseHomePath(value, homeDir) {
  if (typeof value !== "string" || !value || typeof homeDir !== "string" || !homeDir) {
    return value;
  }
  const currentHome = path.resolve(os.homedir());
  const resolved = path.resolve(value);
  if (resolved === currentHome) return homeDir;
  if (resolved.startsWith(`${currentHome}${path.sep}`)) {
    return path.join(homeDir, path.relative(currentHome, resolved));
  }
  return value;
}

function pathForHome(homeDir, ...parts) {
  return path.join(homeDir || os.homedir(), ...parts);
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function finalizeAgentPaths(descriptor, paths, options) {
  return {
    ...paths,
    commandPaths: uniqueStrings(paths.commandPaths || []),
    customDiscoveryPaths: customDiscoveryPathsForAgent(options, descriptor.agentId),
  };
}

function resolveOpenClawPaths(options) {
  const env = options.env || process.env;
  const stateDir = typeof env.OPENCLAW_STATE_DIR === "string" && env.OPENCLAW_STATE_DIR.trim()
    ? env.OPENCLAW_STATE_DIR
    : pathForHome(options.homeDir, ".openclaw");
  const configPath = typeof env.OPENCLAW_CONFIG_PATH === "string" && env.OPENCLAW_CONFIG_PATH.trim()
    ? env.OPENCLAW_CONFIG_PATH
    : path.join(stateDir, "openclaw.json");
  return { stateDir, configPath };
}

function hermesCommandPaths(hermesHome, platform, env = {}) {
  if (platform === "win32") {
    const paths = [path.join(hermesHome, "hermes-agent", "venv", "Scripts", "hermes.exe")];
    if (typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA.trim()) {
      paths.push(path.join(env.LOCALAPPDATA, "hermes", "hermes-agent", "venv", "Scripts", "hermes.exe"));
    }
    return paths;
  }
  return [path.join(hermesHome, "hermes-agent", "venv", "bin", "hermes")];
}

function resolveAgentPaths(descriptor, options) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const platform = options.platform || process.platform;

  if (descriptor.agentId === "copilot-cli") {
    const parentDir = copilot.resolveCopilotHome({ homeDir, env });
    return finalizeAgentPaths(descriptor, {
      parentDir,
      configPath: copilot.resolveCopilotHooksPath({ homeDir, env }),
      settingsPath: copilot.resolveCopilotSettingsPath({ homeDir, env }),
    }, options);
  }

  if (descriptor.agentId === "openclaw") {
    const { stateDir, configPath } = resolveOpenClawPaths({ homeDir, env });
    return finalizeAgentPaths(descriptor, {
      parentDir: stateDir,
      stateDir,
      configPath,
    }, options);
  }

  if (descriptor.agentId === "hermes") {
    const hermesHome = hermes.resolveHermesHome({ homeDir, env, platform });
    return finalizeAgentPaths(descriptor, {
      parentDir: hermesHome,
      hermesHome,
      configPath: path.join(hermesHome, "plugins", hermes.PLUGIN_ID),
      configFilePath: path.join(hermesHome, "config.yaml"),
      commandPaths: hermesCommandPaths(hermesHome, platform, env),
    }, options);
  }

  if (descriptor.agentId === "deepseek-harness") {
    const dshHome = typeof env.DSH_HOME === "string" && env.DSH_HOME.trim()
      ? path.resolve(env.DSH_HOME.trim())
      : path.join(homeDir, ".dsh");
    return finalizeAgentPaths(descriptor, {
      parentDir: dshHome,
      configPath: dsh.resolveDshProfileDir(dshHome),
      commandPaths: dsh.dshCommandPathsSync({ fs: options.fs, env, platform }),
    }, options);
  }

  if (descriptor.agentId === "reasonix") {
    const configTargets = reasonix.resolveReasonixConfigTargets({
      env,
      platform,
      userHomeDir: homeDir,
    });
    const primary = configTargets[0];
    return finalizeAgentPaths(descriptor, {
      parentDir: primary ? primary.parentDir : "",
      configPath: primary ? primary.configPath : "",
      configTargets,
    }, options);
  }

  const parentDir = rebaseHomePath(descriptor.parentDir, homeDir);
  const configPath = rebaseHomePath(descriptor.configPath, homeDir);
  const paths = { parentDir, configPath };
  if (descriptor.settingsPath) paths.settingsPath = rebaseHomePath(descriptor.settingsPath, homeDir);
  if (descriptor.configFilePath) paths.configFilePath = rebaseHomePath(descriptor.configFilePath, homeDir);
  if (Array.isArray(descriptor.configTargets)) {
    paths.configTargets = descriptor.configTargets.map((target) => ({
      ...target,
      parentDir: rebaseHomePath(target.parentDir, homeDir),
      configPath: rebaseHomePath(target.configPath, homeDir),
    }));
  }
  return finalizeAgentPaths(descriptor, paths, options);
}

function customDiscoveryPathsForAgent(options, agentId) {
  const fromOption = options.customDiscoveryPaths && options.customDiscoveryPaths[agentId];
  const agents = options.snapshot && options.snapshot.agents;
  const fromPrefs = agentId === "custom"
    ? options.snapshot && options.snapshot.customToolDiscoveryPaths
    : agents && agents[agentId] && agents[agentId].customDiscoveryPaths;
  const legacyCustom = agentId === "custom" && agents && agents.custom && agents.custom.customDiscoveryPaths;
  return normalizePathList([
    ...normalizePathList(fromOption),
    ...normalizePathList(fromPrefs),
    ...normalizePathList(legacyCustom),
  ]);
}

function installationResult(detectedInstalled, confidence, reason, detail) {
  return { detectedInstalled, confidence, reason, detail };
}

function notFound(detail = "No local installation signal found") {
  return installationResult(false, LOW_CONFIDENCE, "not-found", detail);
}

function hasClawdMarkerText(text, marker) {
  if (typeof text !== "string" || typeof marker !== "string" || !marker) return false;
  if (commandMatchesMarker(text, marker)) return true;

  let parsed;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
  } catch {
    return false;
  }

  const containsCommandMarker = (value) => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some((entry) => containsCommandMarker(entry));
    for (const [key, entry] of Object.entries(value)) {
      if (key === "command" && commandMatchesMarker(entry, marker)) return true;
      if (containsCommandMarker(entry)) return true;
    }
    return false;
  };
  return containsCommandMarker(parsed);
}

function hasNonClawdHookCommand(value, marker) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => hasNonClawdHookCommand(entry, marker));
  for (const [key, entry] of Object.entries(value)) {
    if (key === "command" && typeof entry === "string" && !hasClawdMarkerText(entry, marker)) return true;
    if (hasNonClawdHookCommand(entry, marker)) return true;
  }
  return false;
}

function classifyGeminiSettings(fsImpl, settingsPath, marker) {
  const raw = readText(fsImpl, settingsPath);
  if (raw === null) return { exists: false, userContent: false, clawdOnly: false, unreadable: false };
  let parsed;
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch {
    return { exists: true, userContent: true, clawdOnly: false, unreadable: true };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { exists: true, userContent: true, clawdOnly: false, unreadable: false };
  }

  const keys = Object.keys(parsed);
  const nonClawdKeys = keys.filter((key) => key !== "hooks" && key !== "hooksConfig");
  if (nonClawdKeys.length > 0) {
    return { exists: true, userContent: true, clawdOnly: false, unreadable: false };
  }
  if (hasNonClawdHookCommand(parsed.hooks, marker)) {
    return { exists: true, userContent: true, clawdOnly: false, unreadable: false };
  }
  if (parsed.hooksConfig && typeof parsed.hooksConfig === "object" && !Array.isArray(parsed.hooksConfig)) {
    const hookConfigKeys = Object.keys(parsed.hooksConfig);
    if (hookConfigKeys.some((key) => key !== "disabled")) {
      return { exists: true, userContent: true, clawdOnly: false, unreadable: false };
    }
  }
  return { exists: true, userContent: false, clawdOnly: keys.length > 0, unreadable: false };
}

function geminiDirHasNonClawdSignals(fsImpl, parentDir, settingsPath, marker) {
  if (!dirExists(fsImpl, parentDir)) return false;
  const entries = listDir(fsImpl, parentDir);
  for (const entry of entries) {
    if (!entry || typeof entry.name !== "string") continue;
    if (GEMINI_PARENT_DIR_NOISE_FILES.has(entry.name)) continue;
    if (GEMINI_PARENT_DIR_NOISE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
    // Directories only: a plain file that happens to be named `antigravity` is
    // not Antigravity's, so it stays a Gemini CLI signal.
    if (GEMINI_PARENT_DIR_FOREIGN_DIRS.has(entry.name)
      && typeof entry.isDirectory === "function"
      && entry.isDirectory()) continue;
    if (entry.name === path.basename(settingsPath)) {
      const classified = classifyGeminiSettings(fsImpl, settingsPath, marker);
      if (classified.userContent) return true;
      continue;
    }
    return true;
  }
  return false;
}

function detectGeminiInstallation(descriptor, paths, options) {
  const fsImpl = options.fs;
  const classified = classifyGeminiSettings(fsImpl, paths.configPath, descriptor.marker);
  if (classified.exists && classified.userContent) {
    return installationResult(
      true,
      classified.unreadable ? "medium" : "high",
      "config-file",
      classified.unreadable
        ? `${paths.configPath} exists but could not be classified`
        : `${paths.configPath} contains non-Clawd Gemini settings`
    );
  }
  if (geminiDirHasNonClawdSignals(fsImpl, paths.parentDir, paths.configPath, descriptor.marker)) {
    return installationResult(true, "medium", "parent-dir", `${paths.parentDir} contains Gemini CLI files`);
  }
  if (classified.exists && classified.clawdOnly) {
    return notFound(`${paths.configPath} contains only Clawd-managed Gemini hook signals`);
  }
  return notFound();
}

function detectHermesInstallation(paths, options) {
  const fsImpl = options.fs;
  if (fileExists(fsImpl, paths.configFilePath)) {
    return installationResult(true, "high", "config-file", `${paths.configFilePath} exists`);
  }
  if ((paths.commandPaths || []).some((candidate) => fileExists(fsImpl, candidate))) {
    return installationResult(true, "high", "cli-path", "Hermes CLI runtime was found");
  }
  if (dirExists(fsImpl, paths.hermesHome)) {
    return installationResult(true, "low", "parent-dir", `${paths.hermesHome} exists`);
  }
  return notFound();
}

function detectInstallation(descriptor, paths, options) {
  const fsImpl = options.fs;
  const custom = detectCustomDiscoveryPath(paths.customDiscoveryPaths, options);
  if (custom) return custom;
  switch (descriptor.agentId) {
    case "gemini-cli":
      return detectGeminiInstallation(descriptor, paths, options);
    case "antigravity-cli":
      if (dirExists(fsImpl, paths.parentDir)) return installationResult(true, "medium", "parent-dir", `${paths.parentDir} exists`);
      return notFound();
    case "kimi-cli": {
      // #563: two valid generations — ~/.kimi-code (Kimi Code) and ~/.kimi
      // (legacy CLI). Either directory counts as installed; report which one
      // matched so doctor/UI can tell the generations apart.
      for (const target of paths.configTargets || []) {
        if (dirExists(fsImpl, target.parentDir)) {
          return installationResult(true, "high", "parent-dir", `${target.parentDir} exists`);
        }
      }
      if (dirExists(fsImpl, paths.parentDir)) return installationResult(true, "high", "parent-dir", `${paths.parentDir} exists`);
      return notFound();
    }
    case "workbuddy":
      for (const target of paths.configTargets || []) {
        const isLegacy = target.label === "legacy";
        if ((!isLegacy && dirExists(fsImpl, target.parentDir)) || (isLegacy && fileExists(fsImpl, target.configPath))) {
          return installationResult(true, "high", "parent-dir", `${target.parentDir} exists`);
        }
      }
      if (dirExists(fsImpl, paths.parentDir)) return installationResult(true, "high", "parent-dir", `${paths.parentDir} exists`);
      return notFound();
    case "copilot-cli":
    case "cursor-agent":
    case "codebuddy":
    case "qwen-code":
    case "zcode":
    case "codewhale":
    case "opencode":
    case "mimocode":
    case "qoder":
    case "qoderwork":
    case "traecode":
    case "qwenwork":
      if (dirExists(fsImpl, paths.parentDir)) return installationResult(true, "high", "parent-dir", `${paths.parentDir} exists`);
      return notFound();
    case "reasonix":
      for (const target of paths.configTargets || []) {
        if (dirExists(fsImpl, target.parentDir)) {
          return installationResult(true, "medium", "parent-dir", `${target.parentDir} exists`);
        }
      }
      return notFound();
    case "kiro-cli":
      if (dirExists(fsImpl, paths.parentDir)) return installationResult(true, "high", "parent-dir", `${paths.parentDir} exists`);
      if (dirExists(fsImpl, paths.configPath)) return installationResult(true, "medium", "config-dir", `${paths.configPath} exists`);
      return notFound();
    case "pi":
      if (dirExists(fsImpl, paths.parentDir)) return installationResult(true, "high", "parent-dir", `${paths.parentDir} exists`);
      return notFound();
    case "openclaw":
      if (dirExists(fsImpl, paths.stateDir)) return installationResult(true, "high", "parent-dir", `${paths.stateDir} exists`);
      if (fileExists(fsImpl, paths.configPath)) return installationResult(true, "high", "config-file", `${paths.configPath} exists`);
      return notFound();
    case "hermes":
      return detectHermesInstallation(paths, options);
    case "deepseek-harness":
      for (const commandPath of paths.commandPaths || []) {
        if (fileExists(fsImpl, commandPath)) {
          return installationResult(true, "high", "command-path", `${commandPath} exists`);
        }
      }
      if (dirExists(fsImpl, paths.parentDir)) {
        const home = paths.parentDir;
        const isDshHome = ["profiles", "sessions", "storages"].some((name) => (
          dirExists(fsImpl, path.join(home, name))
        ));
        if (isDshHome) return installationResult(true, "high", "parent-dir", `${home} exists`);
      }
      return notFound();
    default:
      if (dirExists(fsImpl, paths.parentDir)) return installationResult(true, "medium", "parent-dir", `${paths.parentDir} exists`);
      return notFound();
  }
}

function detectCustomDiscoveryPath(paths, options) {
  const fsImpl = options.fs;
  for (const candidate of normalizePathList(paths)) {
    const kind = statPath(fsImpl, candidate);
    if (!kind) continue;
    return installationResult(
      true,
      "medium",
      "custom-path",
      `User-provided path exists: ${candidate} (${kind})`
    );
  }
  return null;
}

function detectCustomTools(options = {}) {
  const fsImpl = options.fs || fs;
  const paths = customDiscoveryPathsForAgent({ ...options, fs: fsImpl }, "custom");
  const addedIds = new Set(((options.snapshot && options.snapshot.customApplications) || []).map((entry) => entry && entry.id));
  return paths.map((candidate) => {
    const kind = statPath(fsImpl, candidate);
    const application = kind ? identifyCustomApplication(candidate, { ...options, fs: fsImpl }) : null;
    return {
      path: candidate,
      detectedInstalled: !!kind,
      confidence: application ? "high" : (kind ? "low" : LOW_CONFIDENCE),
      reason: application ? "application-recognized" : (kind ? "no-application" : "not-found"),
      detail: application ? `Recognized ${application.name}` : (kind ? "No launchable application was recognized" : "Path was not found"),
      kind: kind || null,
      application: application ? { ...application, added: addedIds.has(application.id) } : null,
    };
  });
}

function detectCustomAgents(options = {}) {
  const fsImpl = options.fs || fs;
  const applications = Array.isArray(options.snapshot && options.snapshot.customApplications)
    ? options.snapshot.customApplications
    : [];
  return applications.map((application) => {
    const agentId = application && typeof application.id === "string" ? application.id : "";
    const executablePath = application && typeof application.executablePath === "string"
      ? application.executablePath
      : "";
    const kind = executablePath ? statPath(fsImpl, executablePath) : null;
    return {
      agentId,
      executablePath,
      detectedInstalled: !!kind,
      confidence: kind ? "high" : LOW_CONFIDENCE,
      reason: kind ? "registered-executable" : "not-found",
      detail: kind
        ? `Registered executable exists: ${executablePath} (${kind})`
        : `Registered executable was not found: ${executablePath}`,
    };
  }).filter((entry) => entry.agentId && entry.executablePath);
}

function markerInDirectoryFiles(fsImpl, dirPath, marker, options = {}) {
  if (!dirExists(fsImpl, dirPath)) return false;
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : 100;
  let checked = 0;
  for (const entry of listDir(fsImpl, dirPath)) {
    if (!entry || !entry.isFile || !entry.isFile()) continue;
    if (checked >= maxFiles) break;
    checked++;
    const text = readText(fsImpl, path.join(dirPath, entry.name));
    if (hasClawdMarkerText(text, marker)) return true;
  }
  return false;
}

function detectClawdIntegration(descriptor, paths, options) {
  const fsImpl = options.fs;
  if (descriptor.agentId === "deepseek-harness") {
    const health = dsh.inspectDeepSeekHarnessDiskSync({
      fs: fsImpl,
      dshHome: paths.parentDir,
      dshInstallRoot: options.dshInstallRoot,
      managedRoot: options.dshManagedRoot,
      homeDir: options.homeDir,
      env: options.env,
      platform: options.platform,
    });
    return health.status === "healthy"
      ? {
        detected: true,
        reason: "managed-plugin",
        detail: `${health.profileDir} contains the verified Clawd bridge`,
        paths: { profileDir: health.profileDir, pluginDir: health.resolved.packageDir },
      }
      : {
        detected: false,
        reason: health.status,
        detail: `DeepSeek Harness bridge is ${health.status}`,
        paths: { profileDir: health.profileDir },
      };
  }
  if (descriptor.agentId === "pi") {
    const markerPath = path.join(paths.configPath, descriptor.markerFile || ".clawd-managed.json");
    return fileExists(fsImpl, markerPath)
      ? { detected: true, reason: "marker-file", detail: `${markerPath} exists`, paths: { markerPath } }
      : { detected: false, reason: "not-found", detail: "No Clawd-managed Pi extension marker found" };
  }
  if (descriptor.agentId === "hermes") {
    const files = Array.isArray(descriptor.managedFiles) ? descriptor.managedFiles : [];
    const found = files.some((file) => fileExists(fsImpl, path.join(paths.configPath, file)));
    return found
      ? { detected: true, reason: "managed-files", detail: `${paths.configPath} contains Clawd plugin files`, paths: { pluginDir: paths.configPath } }
      : { detected: false, reason: "not-found", detail: "No Clawd-managed Hermes plugin files found" };
  }
  if (descriptor.configMode === "dir") {
    return markerInDirectoryFiles(fsImpl, paths.configPath, descriptor.marker)
      ? { detected: true, reason: "marker-found", detail: `${paths.configPath} contains ${descriptor.marker}`, paths: { configPath: paths.configPath } }
      : { detected: false, reason: "not-found", detail: `No ${descriptor.marker} marker found` };
  }
  // Multi-generation agents (#563: kimi legacy + kimi-code) may carry the
  // marker in any generation's config; report the first hit.
  if (Array.isArray(paths.configTargets)) {
    for (const target of paths.configTargets) {
      const targetText = readText(fsImpl, target.configPath);
      if (hasClawdMarkerText(targetText, descriptor.marker)) {
        return {
          detected: true,
          reason: "marker-found",
          detail: `${target.configPath} contains ${descriptor.marker}`,
          paths: { configPath: target.configPath },
        };
      }
    }
  }
  const text = readText(fsImpl, paths.configPath);
  if (hasClawdMarkerText(text, descriptor.marker)) {
    return {
      detected: true,
      reason: "marker-found",
      detail: `${paths.configPath} contains ${descriptor.marker}`,
      paths: { configPath: paths.configPath },
    };
  }
  return {
    detected: false,
    reason: "not-found",
    detail: `No ${descriptor.marker || "Clawd"} marker found`,
  };
}

function detectAgentInstallation(descriptor, options = {}) {
  const fsImpl = options.fs || fs;
  const normalizedOptions = {
    ...options,
    fs: fsImpl,
    env: options.env || process.env,
    platform: options.platform || process.platform,
    homeDir: options.homeDir || os.homedir(),
  };
  const paths = resolveAgentPaths(descriptor, normalizedOptions);
  const installation = detectInstallation(descriptor, paths, normalizedOptions);
  return {
    agentId: descriptor.agentId,
    agentName: descriptor.agentName,
    detectedInstalled: installation.detectedInstalled,
    confidence: installation.confidence,
    reason: installation.reason,
    detail: installation.detail,
    paths,
    clawdIntegration: detectClawdIntegration(descriptor, paths, normalizedOptions),
  };
}

// ── Detection cache ─────────────────────────────────────────────────
// WSL detection is expensive (spawn per agent × distro). Cache permanently
// in the module; invalidate on explicit refresh or after Pair.
// Non-Windows platforms never need WSL detection — mark detected immediately
// so the UI never sees wslPending and never auto-triggers a scan.

let _cachedWslAgents = [];
let _cachedWslDistros = [];
let _cachedDetected = process.platform !== "win32";
let _wslRefreshGeneration = 0;
let _wslRefreshCommitted = 0;

function detectAgentInstallations(options = {}) {
  const descriptors = Array.isArray(options.descriptors) ? options.descriptors : getAgentDescriptors();
  const skippedAgentIds = [];
  const agents = [];
  const skipDefaultIntegrations = options.skipDefaultIntegrations !== false;
  for (const descriptor of descriptors) {
    if (!descriptor || typeof descriptor.agentId !== "string") continue;
    if (skipDefaultIntegrations && DEFAULT_AUTO_SYNC_CREATED_PARENT_DIR_AGENT_IDS.has(descriptor.agentId)) {
      skippedAgentIds.push(descriptor.agentId);
      continue;
    }
    agents.push(detectAgentInstallation(descriptor, options));
  }

  // WSL: return cached results (populated by the Agents-tab scan). Before the
  // first scan this is empty with wslPending set so the UI shows a spinner
  // and triggers the scan.
  return {
    checkedAt: checkedAtValue(options.now),
    agents,
    customAgents: detectCustomAgents(options),
    customTools: detectCustomTools(options),
    skippedAgentIds,
    wslAgents: _cachedWslAgents,
    wslDistros: _cachedWslDistros,
    wslPending: !_cachedDetected,
    // Lets the UI always offer a manual Scan on Windows, even after a failed
    // startup scan left the cache empty (no rows, no pending flag).
    wslSupported: process.platform === "win32",
  };
}

// Async WSL scan — runs on the first Settings→Agents visit and on explicit
// user action (Scan button, after Pair/Unpair). Deliberately NOT run at app
// startup: probing a distro boots its VM, and launch must not wake every
// stopped distro. Populates module-level cache so subsequent reads are instant.
//
// Uses a committed-generation counter: successful results are only
// overwritten by a newer scan that actually completes. If a newer scan
// fails (timeout, broken wsl.exe), the previous results survive.
// Also batches dir-exists checks into one wsl.exe spawn per distro
// instead of one per (distro × agent).
const HERMES_WSL_HOME_SENTINEL = "CLAWD_HERMES_HOME_V1=";

function quoteWslPath(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function parseHermesWslHome(stdout) {
  const lines = (typeof stdout === "string" ? stdout : "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith(HERMES_WSL_HOME_SENTINEL));
  if (lines.length !== 1) return null;
  const value = lines[0].slice(HERMES_WSL_HOME_SENTINEL.length);
  if (!value.startsWith("/") || value.includes("\0") || value.includes("\r") || value.includes("\n") || value.includes("\\")) {
    return null;
  }
  if (path.posix.normalize(value) !== value) return null;
  return value;
}

async function resolveHermesWslHome(distro, wslHome, execInWsl, options = {}) {
  // wsl.exe may add an outer shell around the requested login bash. Escape
  // both dollars so HERMES_HOME/HOME are resolved by that login shell, after
  // the user's profile has run, rather than by the outer launcher shell.
  const command = "printf '" + HERMES_WSL_HOME_SENTINEL
    + "%s\\n' \"\\${HERMES_HOME:-\\$HOME/.hermes}\"";
  const result = await execInWsl(
    distro,
    command,
    { ...options, shell: "bash", shellFlags: ["-l", "-i", "-c"], timeout: 15000 }
  );
  const resolved = result && result.code === 0 ? parseHermesWslHome(result.stdout) : null;
  return {
    path: resolved || `${wslHome.replace(/\/+$/, "")}/.hermes`,
    customHomeUnknown: !resolved,
  };
}

async function refreshWslDetection(options = {}) {
  if (process.platform !== "win32") {
    _cachedDetected = true;
    return detectAgentInstallations(options);
  }

  const generation = ++_wslRefreshGeneration;

  try {
    const { getWslDistributions, getWslHomeDir, execInWsl, rebaseHomePathPosix } = require("./wsl-utils");
    const { getAgentInstallScriptName } = require("./wsl-deploy");
    const descriptors = Array.isArray(options.descriptors) ? options.descriptors : getAgentDescriptors();

    const homeDir = options.homeDir || os.homedir();
    const skipDefaultIntegrations = options.skipDefaultIntegrations !== false;
    const distros = await getWslDistributions({ excludeDistros: options.excludeDistros });
    // null = wsl.exe failed (as opposed to "no distros"). Throw so the catch
    // branch below keeps the previous cache instead of committing emptiness.
    if (distros === null) {
      throw new Error("WSL distro enumeration failed (wsl.exe error or timeout)");
    }
    const wslAgents = [];

    // Preserve a distro's previous entries when this scan cannot produce
    // trustworthy results for it — a stopped distro or a mid-batch timeout
    // must not demote previously detected agents to "not found".
    const keepPreviousEntries = (distroName) => {
      wslAgents.push(..._cachedWslAgents.filter((e) => e && e.distro === distroName));
    };

    for (const distro of distros) {
      const wslHome = await getWslHomeDir(distro.name, options);
      if (!wslHome) {
        keepPreviousEntries(distro.name);
        continue;
      }

      const supportsHermes = descriptors.some((descriptor) =>
        descriptor
        && descriptor.agentId === "hermes"
        && (!skipDefaultIntegrations || !DEFAULT_AUTO_SYNC_CREATED_PARENT_DIR_AGENT_IDS.has("hermes"))
        && getAgentInstallScriptName("hermes")
      );
      const hermesWslHome = supportsHermes
        ? await resolveHermesWslHome(distro.name, wslHome, execInWsl, options)
        : null;

      // Collect all directories to check for this distro. Only agents that
      // WSL deploy actually supports get entries — the UI renders a Pair
      // button per entry, and a guaranteed-to-fail Pair is worse than none.
      const checks = [];
      for (const descriptor of descriptors) {
        if (!descriptor || typeof descriptor.agentId !== "string") continue;
        if (skipDefaultIntegrations && DEFAULT_AUTO_SYNC_CREATED_PARENT_DIR_AGENT_IDS.has(descriptor.agentId)) continue;
        if (!getAgentInstallScriptName(descriptor.agentId)) continue;
        // Hermes' descriptor was resolved in the Windows process and can point
        // at LOCALAPPDATA or a host-only HERMES_HOME. Never rebase that value
        // into WSL; resolve the distro's own environment above.
        const wslParentDir = descriptor.agentId === "hermes" && hermesWslHome
          ? hermesWslHome.path
          : rebaseHomePathPosix(descriptor.parentDir, wslHome, homeDir);
        if (!wslParentDir) continue;
        checks.push({
          descriptor,
          wslParentDir,
          integrationEvidence: descriptor.agentId === "hermes" ? "hermes-plugin-files" : null,
          customHomeUnknown: descriptor.agentId === "hermes" && hermesWslHome
            ? hermesWslHome.customHomeUnknown
            : false,
        });
      }

      if (checks.length === 0) continue;

      // Batch all dir-exists checks into a single wsl.exe spawn.
      // Each line emits "OK N" or "NO N" for the Nth check; two trailing
      // DEPFILE/DEPREG lines report the distro's Clawd hook deployment
      // state (see below).
      const batchLines = checks.map((c, i) => {
        const escaped = c.wslParentDir.replace(/'/g, "'\\''");
        return `test -d '${escaped}' && echo "OK ${i}" || echo "NO ${i}"`;
      });
      for (let i = 0; i < checks.length; i++) {
        const check = checks[i];
        if (check.integrationEvidence !== "hermes-plugin-files") continue;
        const primaryPlugin = `${check.wslParentDir.replace(/\/+$/, "")}/plugins/clawd-on-desk`;
        const profilesDir = `${check.wslParentDir.replace(/\/+$/, "")}/profiles`;
        batchLines.push(
          `if { test -f ${quoteWslPath(`${primaryPlugin}/plugin.yaml`)} || `
          + `test -f ${quoteWslPath(`${primaryPlugin}/__init__.py`)} || `
          + `find ${quoteWslPath(profilesDir)} -mindepth 4 -maxdepth 4 -type f `
          + `\\( -path '*/plugins/clawd-on-desk/plugin.yaml' -o -path '*/plugins/clawd-on-desk/__init__.py' \\) `
          + `-print -quit 2>/dev/null | grep -q .; }; then echo "INTFILE ${i} 1"; else echo "INTFILE ${i} 0"; fi`
        );
      }
      // Two independent deployment signals, because they answer different
      // UI questions:
      //   DEPFILE — hook files exist in the distro. Pairing ANY agent copies
      //     them, and Unpair keeps them (shared dir). Drives the Unpair
      //     button: there is something to clean up.
      //   DEPREG — ~/.claude/settings.json references clawd-hook.js, i.e.
      //     the claude-code registration is active. File-only checks give
      //     false positives after a claude-code Unpair (uninstall clears
      //     settings.json but keeps shared files). Together with DEPFILE it
      //     drives the "hooks deployed" badge.
      // Note DEPREG is claude-code truth only — other agents register in
      // their own config files (e.g. ~/.codex/hooks.json). Per-agent pairing
      // truth is a known follow-up; the badge must not gate the Unpair
      // button, or distros paired with only a non-claude agent lose their
      // unpair entry point.
      const deployedFile = `${wslHome.replace(/\/$/, "")}/.claude/hooks/clawd-hook.js`;
      const deployedFileEscaped = deployedFile.replace(/'/g, "'\\''");
      const settingsPathEscaped = `${wslHome.replace(/\/$/, "")}/.claude/settings.json`.replace(/'/g, "'\\''");
      batchLines.push(`test -f '${deployedFileEscaped}' && echo "DEPFILE 1" || echo "DEPFILE 0"`);
      batchLines.push(`grep -q clawd-hook.js '${settingsPathEscaped}' 2>/dev/null && echo "DEPREG 1" || echo "DEPREG 0"`);
      const batchResult = await execInWsl(
        distro.name,
        batchLines.join("; "),
        { timeout: 30000 }  // fixed 30s — test -d is sub-ms, only distro boot/hang justifies a timeout
      );

      // A failed or timed-out batch has no trustworthy per-agent results;
      // keep whatever the previous scan knew about this distro.
      if (!batchResult || batchResult.error || batchResult.code !== 0) {
        console.warn("Clawd: WSL batch dir check failed in", distro.name, "—",
          (batchResult && (batchResult.error ? batchResult.error.message : `exit ${batchResult.code}`)) || "no result");
        keepPreviousEntries(distro.name);
        continue;
      }

      // Parse every expected marker strictly. Truncated, duplicate, or
      // conflicting output is not a trustworthy negative result.
      const dirStates = new Map();
      const integrationStates = new Map();
      let hooksFilesPresent = null;
      let hooksRegistered = null;
      let markerError = false;
      const stdout = (batchResult && batchResult.stdout) || "";
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        let match = trimmed.match(/^(OK|NO) (\d+)$/);
        if (match) {
          const index = parseInt(match[2], 10);
          const value = match[1] === "OK";
          if (dirStates.has(index)) markerError = true;
          else dirStates.set(index, value);
          continue;
        }
        match = trimmed.match(/^INTFILE (\d+) ([01])$/);
        if (match) {
          const index = parseInt(match[1], 10);
          const value = match[2] === "1";
          if (integrationStates.has(index)) markerError = true;
          else integrationStates.set(index, value);
          continue;
        }
        if (trimmed === "DEPFILE 1" || trimmed === "DEPFILE 0") {
          if (hooksFilesPresent !== null) markerError = true;
          else hooksFilesPresent = trimmed.endsWith("1");
        } else if (trimmed === "DEPREG 1" || trimmed === "DEPREG 0") {
          if (hooksRegistered !== null) markerError = true;
          else hooksRegistered = trimmed.endsWith("1");
        }
      }

      if (dirStates.size !== checks.length || hooksFilesPresent === null || hooksRegistered === null) markerError = true;
      for (let i = 0; i < checks.length; i++) {
        if (!dirStates.has(i)) markerError = true;
        if (checks[i].integrationEvidence && !integrationStates.has(i)) markerError = true;
      }
      if (markerError) {
        console.warn("Clawd: WSL batch marker output was incomplete or ambiguous in", distro.name);
        keepPreviousEntries(distro.name);
        continue;
      }

      for (let i = 0; i < checks.length; i++) {
        const { descriptor, wslParentDir, integrationEvidence, customHomeUnknown } = checks[i];
        const hasParentDir = dirStates.get(i) === true;
        const entry = {
          agentId: descriptor.agentId,
          agentName: descriptor.agentName,
          distro: distro.name,
          detectedInstalled: hasParentDir,
          confidence: hasParentDir ? "high" : "low",
          reason: hasParentDir ? "parent-dir" : "not-found",
          detail: hasParentDir
            ? `${wslParentDir} exists in WSL ${distro.name}`
            : `${wslParentDir} not found in WSL ${distro.name}`,
          wslHome,
          wslParentDir,
          hooksDeployed: hooksFilesPresent && hooksRegistered,
          hooksFilesPresent,
        };
        if (integrationEvidence) {
          entry.integrationFilesPresent = integrationStates.get(i) === true;
          entry.hermesHomeResolutionUnknown = customHomeUnknown;
        }
        wslAgents.push(entry);
      }
    }

    // Only overwrite cache if no newer scan has already committed.
    // This preserves results from this scan even if a newer scan started
    // concurrently and subsequently failed (generation > committed).
    if (generation <= _wslRefreshCommitted) return detectAgentInstallations(options);

    _cachedWslAgents = wslAgents;
    _cachedWslDistros = distros;
    _cachedDetected = true;
    _wslRefreshCommitted = generation;
  } catch (err) {
    // If a newer scan already committed, don't touch the cache.
    if (generation <= _wslRefreshCommitted) return detectAgentInstallations(options);

    console.warn("Clawd: WSL detection scan failed:", err && err.message ? err.message : err);
    _cachedDetected = true;
    // A failed scan must NOT claim the committed slot: _wslRefreshCommitted
    // tracks the newest scan that committed DATA. If a failure bumped it, a
    // concurrent older scan that later succeeds would see itself as outdated
    // and discard valid results in favor of the stale/empty cache.

    const result = detectAgentInstallations(options);
    result.wslError = err && err.message ? err.message : String(err);
    return result;
  }

  return detectAgentInstallations(options);
}

module.exports = {
  detectAgentInstallation,
  detectAgentInstallations,
  refreshWslDetection,
  resolveAgentPaths,
};
