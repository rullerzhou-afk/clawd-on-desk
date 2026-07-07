"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { getAgentDescriptors } = require("./doctor-detectors/agent-descriptors");
const { DEFAULT_INTEGRATION_INSTALLED_IDS } = require("./prefs");
const copilot = require("../hooks/copilot-install");
const hermes = require("../hooks/hermes-install");

const DEFAULT_SKIPPED_AGENT_IDS = new Set(DEFAULT_INTEGRATION_INSTALLED_IDS);
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
    return {
      parentDir,
      configPath: copilot.resolveCopilotHooksPath({ homeDir, env }),
      settingsPath: copilot.resolveCopilotSettingsPath({ homeDir, env }),
    };
  }

  if (descriptor.agentId === "openclaw") {
    const { stateDir, configPath } = resolveOpenClawPaths({ homeDir, env });
    return {
      parentDir: stateDir,
      stateDir,
      configPath,
    };
  }

  if (descriptor.agentId === "hermes") {
    const hermesHome = hermes.resolveHermesHome({ homeDir, env, platform });
    return {
      parentDir: hermesHome,
      hermesHome,
      configPath: path.join(hermesHome, "plugins", hermes.PLUGIN_ID),
      configFilePath: path.join(hermesHome, "config.yaml"),
      commandPaths: hermesCommandPaths(hermesHome, platform, env),
    };
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
  return paths;
}

function installationResult(detectedInstalled, confidence, reason, detail) {
  return { detectedInstalled, confidence, reason, detail };
}

function notFound(detail = "No local installation signal found") {
  return installationResult(false, LOW_CONFIDENCE, "not-found", detail);
}

function hasClawdMarkerText(text, marker) {
  return typeof text === "string" && typeof marker === "string" && marker && text.includes(marker);
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
    if (entry.name === "config") continue;
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
    case "copilot-cli":
    case "cursor-agent":
    case "codebuddy":
    case "qwen-code":
    case "codewhale":
    case "opencode":
    case "qoder":
    case "qoderwork":
      if (dirExists(fsImpl, paths.parentDir)) return installationResult(true, "high", "parent-dir", `${paths.parentDir} exists`);
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
    default:
      if (dirExists(fsImpl, paths.parentDir)) return installationResult(true, "medium", "parent-dir", `${paths.parentDir} exists`);
      return notFound();
  }
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
    if (skipDefaultIntegrations && DEFAULT_SKIPPED_AGENT_IDS.has(descriptor.agentId)) {
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

      // Collect all directories to check for this distro. Only agents that
      // WSL deploy actually supports get entries — the UI renders a Pair
      // button per entry, and a guaranteed-to-fail Pair is worse than none.
      const checks = [];
      for (const descriptor of descriptors) {
        if (!descriptor || typeof descriptor.agentId !== "string") continue;
        if (skipDefaultIntegrations && DEFAULT_SKIPPED_AGENT_IDS.has(descriptor.agentId)) continue;
        if (!getAgentInstallScriptName(descriptor.agentId)) continue;
        const wslParentDir = rebaseHomePathPosix(descriptor.parentDir, wslHome, homeDir);
        if (!wslParentDir) continue;
        checks.push({ descriptor, wslParentDir });
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

      // Parse: collect indices of "OK" lines and the two DEP markers.
      const foundIndices = new Set();
      let hooksFilesPresent = false;
      let hooksRegistered = false;
      const stdout = (batchResult && batchResult.stdout) || "";
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        const m = trimmed.match(/^OK (\d+)$/);
        if (m) foundIndices.add(parseInt(m[1], 10));
        else if (trimmed === "DEPFILE 1") hooksFilesPresent = true;
        else if (trimmed === "DEPREG 1") hooksRegistered = true;
      }

      for (let i = 0; i < checks.length; i++) {
        const { descriptor, wslParentDir } = checks[i];
        const hasParentDir = foundIndices.has(i);
        wslAgents.push({
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
        });
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
