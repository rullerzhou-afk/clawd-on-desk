#!/usr/bin/env node
// Clawd Desktop Pet — Hook Installer
// Safely merges hook commands into ~/.claude/settings.json
// Does NOT overwrite existing hooks — appends to arrays

const fs = require("fs");
const path = require("path");
const os = require("os");
const childProcess = require("child_process");
const {
  buildPermissionUrl,
  DEFAULT_SERVER_PORT,
  isManagedPermissionUrl,
  PERMISSION_PATH,
  readRuntimePort,
  readRemoteIdentity,
  resolveRemoteIdentityPath,
  resolveSshSecureMarkerPath,
  REMOTE_HOOK_HTTP_TIMEOUT_MS,
  resolveNodeBin,
  resolveNodeBinAsync,
  SERVER_PORTS,
} = require("./server-config");
const {
  readJsonFile,
  readJsonFileAsync,
  writeJsonAtomic,
  writeJsonAtomicAsync,
  writeJsonAtomicWithBackup,
  writeJsonAtomicWithBackupAsync,
  writeTextAtomic,
  createBackup,
  pruneOldBackups,
  asarUnpackedPath,
  buildPortableStatuslineCommand,
  classifyManagedClaudeStateHookCommand,
  extractExistingNodeBin,
  findManagedClaudeEnvNodeBinCandidates,
} = require("./json-utils");
const {
  planAppImageHookBundle,
  materializeAppImageHookBundle,
  isAppImageHookBundleComplete,
  isLegacyAppImageHookPath,
} = require("./appimage-hook-materializer");
const {
  findMissingHookDependencies,
  formatMissingHookDependencies,
} = require("./hook-dependency-preflight");

function resolveClaudeHome(options = {}) {
  const env = options.env || process.env;
  const configured = typeof options.claudeHome === "string"
    ? options.claudeHome
    : env.CLAUDE_CONFIG_DIR;
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim();
  }
  return path.join(options.homeDir || os.homedir(), ".claude");
}

function resolveClaudeSettingsPath(options = {}) {
  return options.settingsPath || path.join(resolveClaudeHome(options), "settings.json");
}

function resolveClaudeHooksDir(options = {}) {
  return options.hooksDir || path.join(resolveClaudeHome(options), "hooks");
}

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
  // /design is a built-in skill in Claude Code 2.1.265+.
  { event: "UserPromptExpansion", minVersion: "2.1.265" },
  // Conservative supported baseline, not the first release of this event.
  { event: "PostToolBatch", minVersion: "2.1.280" },
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
let cachedClaudeVersionInfo = null;
let cachedClaudeVersionPromise = null;

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

// Path semantics must follow the requested platform, not the host: tests inject
// win32/posix scenarios cross-platform. In production platform === process.platform,
// so this resolves to the host path module.
function pathForPlatform(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function getClaudePathCandidates(options = {}) {
  const platform = options.platform || process.platform;
  const platformPath = pathForPlatform(platform);
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
      const candidate = platformPath.join(dir, `claude${suffix}`);
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

async function getClaudePathCandidatesAsync(options = {}) {
  const platform = options.platform || process.platform;
  const platformPath = pathForPlatform(platform);
  const pathEnv = options.pathEnv !== undefined ? options.pathEnv : process.env.PATH;
  const access = options.access || fs.promises.access.bind(fs.promises);

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
      const candidate = platformPath.join(dir, `claude${suffix}`);
      const key = platform === "win32" ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) continue;
      seen.add(key);

      try {
        await access(candidate);
        candidates.push(candidate);
      } catch {}
    }
  }

  return candidates;
}

function getClaudePackageJsonCandidates(candidatePath, options = {}) {
  const platform = options.platform || process.platform;
  const platformPath = pathForPlatform(platform);
  const existsSync = options.existsSync || fs.existsSync;
  const readFileSync = options.readFileSync || fs.readFileSync;
  const realpathSync = options.realpathSync || fs.realpathSync;
  const statSync = options.statSync || fs.statSync;

  if (!platformPath.isAbsolute(candidatePath)) return [];

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

  const candidateDir = platformPath.dirname(candidatePath);
  addCandidate(platformPath.join(candidateDir, ...CLAUDE_PACKAGE_JSON_SEGMENTS));

  try {
    const resolvedPath = realpathSync(candidatePath);
    addCandidate(platformPath.join(platformPath.dirname(resolvedPath), "package.json"));
  } catch {}

  try {
    const stat = statSync(candidatePath);
    const isRegularFile = typeof stat.isFile === "function" ? stat.isFile() : true;
    // npm shims are tiny; skip unusually large files rather than reading arbitrary PATH entries into memory.
    if (isRegularFile && typeof stat.size === "number" && stat.size <= MAX_CLAUDE_SHIM_BYTES) {
      const shimSource = readFileSync(candidatePath, "utf8");
      const shimMatch = shimSource.match(CLAUDE_SHIM_CLI_PATTERN);
      if (shimMatch) {
        const cliPath = platformPath.resolve(candidateDir, shimMatch[0].replace(/[\\/]/g, platformPath.sep));
        addCandidate(platformPath.join(platformPath.dirname(cliPath), "package.json"));
      }
    }
  } catch {}

  return candidates;
}

async function getClaudePackageJsonCandidatesAsync(candidatePath, options = {}) {
  const platform = options.platform || process.platform;
  const platformPath = pathForPlatform(platform);
  const access = options.access || fs.promises.access.bind(fs.promises);
  const readFile = options.readFile || fs.promises.readFile.bind(fs.promises);
  const realpath = options.realpath || fs.promises.realpath.bind(fs.promises);
  const stat = options.stat || fs.promises.stat.bind(fs.promises);

  if (!platformPath.isAbsolute(candidatePath)) return [];

  const candidates = [];
  const seen = new Set();
  const addCandidate = async (packageJsonPath) => {
    if (typeof packageJsonPath !== "string" || !packageJsonPath) return;
    const key = platform === "win32" ? packageJsonPath.toLowerCase() : packageJsonPath;
    if (seen.has(key)) return;
    seen.add(key);

    try {
      await access(packageJsonPath);
      candidates.push(packageJsonPath);
    } catch {}
  };

  const candidateDir = platformPath.dirname(candidatePath);
  await addCandidate(platformPath.join(candidateDir, ...CLAUDE_PACKAGE_JSON_SEGMENTS));

  try {
    const resolvedPath = await realpath(candidatePath);
    await addCandidate(platformPath.join(platformPath.dirname(resolvedPath), "package.json"));
  } catch {}

  try {
    const statResult = await stat(candidatePath);
    const isRegularFile = typeof statResult.isFile === "function" ? statResult.isFile() : true;
    if (isRegularFile && typeof statResult.size === "number" && statResult.size <= MAX_CLAUDE_SHIM_BYTES) {
      const shimSource = await readFile(candidatePath, "utf8");
      const shimMatch = String(shimSource).match(CLAUDE_SHIM_CLI_PATTERN);
      if (shimMatch) {
        const cliPath = platformPath.resolve(candidateDir, shimMatch[0].replace(/[\\/]/g, platformPath.sep));
        await addCandidate(platformPath.join(platformPath.dirname(cliPath), "package.json"));
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

async function getClaudeVersionFromPackageJsonAsync(packageJsonPath, options = {}) {
  const readFile = options.readFile || fs.promises.readFile.bind(fs.promises);

  try {
    const packageJson = JSON.parse(String(await readFile(packageJsonPath, "utf8")));
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

async function readClaudeVersionFallbackAsync(candidatePath, options = {}) {
  for (const packageJsonPath of await getClaudePackageJsonCandidatesAsync(candidatePath, options)) {
    const versionInfo = await getClaudeVersionFromPackageJsonAsync(packageJsonPath, options);
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
  const platformPath = pathForPlatform(platform);
  const homeDir = options.homeDir || os.homedir();
  const execFileSync = options.execFileSync || require("child_process").execFileSync;
  const candidates = [];

  if (platform === "darwin") {
    candidates.push(
      platformPath.join(homeDir, ".local", "bin", "claude"),
      platformPath.join(homeDir, ".claude", "local", "claude"),
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

async function getClaudeVersionAsync(options = {}) {
  if (options.resetCache) {
    cachedClaudeVersionInfo = null;
    cachedClaudeVersionPromise = null;
  }
  if (cachedClaudeVersionInfo) return cachedClaudeVersionInfo;
  if (cachedClaudeVersionPromise) return cachedClaudeVersionPromise;

  const compute = async () => {
    const platform = options.platform || process.platform;
    const platformPath = pathForPlatform(platform);
    const homeDir = options.homeDir || os.homedir();
    const execFile = options.execFile || ((command, args, execOptions) => new Promise((resolve, reject) => {
      childProcess.execFile(command, args, execOptions, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    }));
    const candidates = Array.isArray(options.candidates)
      ? [...options.candidates]
      : [];

    if (!candidates.length) {
      if (platform === "darwin") {
        candidates.push(
          platformPath.join(homeDir, ".local", "bin", "claude"),
          platformPath.join(homeDir, ".claude", "local", "claude"),
          "/opt/homebrew/bin/claude",
          "/usr/local/bin/claude"
        );
      }
      candidates.push(...await getClaudePathCandidatesAsync(options));
      candidates.push("claude");
    }

    const seen = new Set();
    let fallbackInfo = null;
    for (const candidate of candidates) {
      const key = platform === "win32" ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const out = await execFile(candidate, ["--version"], {
          encoding: "utf8",
          timeout: 5000,
          windowsHide: true,
        });
        const stdout = typeof out === "string" ? out : out && typeof out.stdout === "string" ? out.stdout : "";
        const version = parseClaudeVersion(stdout);
        if (!version) continue;
        const result = {
          version,
          source: candidate === "claude" ? "PATH:claude" : candidate,
          status: "known",
        };
        cachedClaudeVersionInfo = result;
        return result;
      } catch {}

      const fallback = await readClaudeVersionFallbackAsync(candidate, options);
      if (fallback && !fallbackInfo) fallbackInfo = fallback;
    }
    if (fallbackInfo) cachedClaudeVersionInfo = fallbackInfo;
    return fallbackInfo || { ...UNKNOWN_CLAUDE_VERSION };
  };

  cachedClaudeVersionPromise = compute().finally(() => {
    cachedClaudeVersionPromise = null;
  });
  return cachedClaudeVersionPromise;
}

const MARKER = "clawd-hook.js";
const AUTO_START_MARKER = "auto-start.js";
const LEGACY_AUTO_START_MARKER = "auto-start.sh";
const HTTP_MARKER = PERMISSION_PATH;
const STATE_HOOK_TIMEOUT_SECONDS = 5;
const REMOTE_STATE_HOOK_TIMEOUT_SECONDS = Math.ceil(REMOTE_HOOK_HTTP_TIMEOUT_MS / 1000) + 5;
const AUTO_START_HOOK_TIMEOUT_SECONDS = 15;

// Authoritative script paths — the single source of truth for both what
// registerHooks()/registerHooksAsync() write and what runtime health checks
// (src/claude-hook-health.js) compare against. Computing this in two places
// would let the installer and the health inspector silently drift apart.
function getClaudeHookScriptPath() {
  return asarUnpackedPath(path.resolve(__dirname, "clawd-hook.js").replace(/\\/g, "/"));
}

function getClaudeAutoStartScriptPath() {
  return asarUnpackedPath(path.resolve(__dirname, "auto-start.js").replace(/\\/g, "/"));
}

// Source (packaged) path of the statusline script. Its runtime target may be a
// materialized AppImage generation; resolveClaudeHookPaths() is the only
// source of truth for what settings should point at.
function getClaudeStatuslineScriptPath() {
  return asarUnpackedPath(path.resolve(__dirname, "claude-statusline.js").replace(/\\/g, "/"));
}

// All three Claude runtime artifacts shipped together in one content-addressed
// generation. AppImage materialization always plans the full bundle, even when
// a feature toggle (auto-start / quota statusline) is currently off, so
// flipping a toggle never migrates the state hook to a different generation.
function claudeSourceHookPaths() {
  return {
    state: getClaudeHookScriptPath(),
    autoStart: getClaudeAutoStartScriptPath(),
    statusline: getClaudeStatuslineScriptPath(),
  };
}

// Single source of truth for "which source paths is this resolver working
// with". A partial options.sourcePaths override must be merged identically by
// every consumer (resolver, AppImage decision, fs guard), otherwise the guard
// could see a partial object and decide direct while the resolver materializes.
function mergeClaudeSourcePaths(options = {}) {
  const override = options && typeof options.sourcePaths === "object" && options.sourcePaths
    ? options.sourcePaths
    : null;
  return override ? { ...claudeSourceHookPaths(), ...override } : claudeSourceHookPaths();
}

// Accept an absolute path on either platform. This is only for APPDIR/source
// paths: cross-platform tests synthesize platform:"linux" on a Windows host and
// feed path.resolve() output (D:\\...). APPIMAGE itself must stay POSIX-absolute
// because it is the emulated Linux runtime field.
function isAbsoluteAnyPlatformPath(value) {
  const text = String(value || "");
  return path.posix.isAbsolute(text) || path.win32.isAbsolute(text);
}

// Normalized POSIX containment test used for APPIMAGE ownership. Both sides are
// converted to forward slashes so a Windows-style separator/drive path cannot
// sneak past.
function isPosixPathInside(dir, target) {
  const root = String(dir || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const child = String(target || "").replace(/\\/g, "/");
  if (!root || !child) return false;
  return child === root || child.startsWith(`${root}/`);
}

// Pure decision: should this process materialize Claude hooks for a local
// AppImage? processEnv is intentionally separate from options.env — it only
// answers "is this host process an AppImage, and where is it?", while
// options.env still drives CLAUDE_CONFIG_DIR / shell installer semantics.
//
// APPIMAGE/APPDIR are plain inherited environment variables: a non-AppImage
// Clawd launched from another AppImage's shell (e.g. VSCodium) also sees them.
// Presence alone is therefore NOT evidence that *this* process runs from a
// Clawd AppImage, and must never be used to write that foreign executable into
// a marker. Ownership requires APPDIR to contain Clawd's own source scripts;
// APPDIR is set by the AppImage runtime to this process's mount, so a foreign
// mount cannot contain our hooks. deb/source/direct all fail this check.
function claudeSourcesInsideAppDir(sources, appDir) {
  return isPosixPathInside(appDir, sources.state)
    && isPosixPathInside(appDir, sources.autoStart)
    && isPosixPathInside(appDir, sources.statusline);
}

function evaluateClaudeAppImage(options = {}, sourcePaths) {
  const platform = options.platform || process.platform;
  if (platform !== "linux") return { materialize: false };
  if (options.remote === true) return { materialize: false };
  const env = options.processEnv || process.env;
  if (!env || !Object.prototype.hasOwnProperty.call(env, "APPIMAGE")) {
    return { materialize: false };
  }
  const raw = env.APPIMAGE;
  // A set-but-malformed APPIMAGE is a fail-closed condition (ignored plan
  // §3.1): a real AppImage host always exposes a non-empty absolute path, so
  // guessing would risk writing a relative or unrelated target.
  if (typeof raw !== "string" || !raw.trim()) {
    return {
      materialize: false,
      error: {
        reason: "invalid-appimage-path",
        message: "APPIMAGE is set but is not a non-empty string; refusing to materialize Claude hooks",
      },
    };
  }
  const appImagePath = raw.trim();
  // APPIMAGE is the emulated Linux runtime field: under platform:"linux" only a
  // POSIX absolute path is valid. A Windows drive path or UNC is malformed for
  // Linux and must fail closed, never fall through to a foreign executable.
  if (!path.posix.isAbsolute(appImagePath)) {
    return {
      materialize: false,
      error: {
        reason: "invalid-appimage-path",
        message: "APPIMAGE is set but is not an absolute POSIX path; refusing to materialize Claude hooks",
      },
    };
  }
  const appDir = env.APPDIR;
  if (typeof appDir !== "string" || !appDir.trim() || !isAbsoluteAnyPlatformPath(appDir.trim())) {
    // A valid absolute APPIMAGE without a usable absolute APPDIR cannot prove
    // this process is the AppImage owner; fall back to direct mode rather than
    // trusting a foreign executable. APPDIR/source paths accept win32 absolute
    // so synthetic platform:"linux" tests on a Windows host still work.
    return { materialize: false };
  }
  const override = sourcePaths && typeof sourcePaths === "object"
    ? sourcePaths
    : options.sourcePaths;
  const sources = mergeClaudeSourcePaths({ ...options, sourcePaths: override });
  if (!claudeSourcesInsideAppDir(sources, appDir.trim())) {
    return { materialize: false };
  }
  return { materialize: true, appImagePath };
}

// The single Claude source/target resolver. `source` is always the current
// package/repo script used for preflight and bundle input; `target` is what
// settings commands and health expectations must use (identical to source in
// direct mode, the persistent generation in AppImage mode). Total by design:
// every I/O / plan / environment failure is returned as {ok:false,...}, never
// thrown, so a lazy caller such as the settings watcher can degrade and keep
// patrolling instead of dying on one transient error.
function resolveClaudeHookPaths(options = {}, config = {}) {
  const shouldMaterialize = config.materialize === true;
  const source = mergeClaudeSourcePaths(options);
  let decision;
  try {
    decision = evaluateClaudeAppImage(options, source);
  } catch (err) {
    return { ok: false, reason: "appimage-eval-failed", message: err && err.message };
  }
  if (decision.error) return { ok: false, ...decision.error };
  if (!decision.materialize) {
    return {
      ok: true,
      mode: "direct",
      source,
      target: { ...source },
      generationDir: null,
      appImagePath: null,
      targetGeneration: null,
    };
  }
  try {
    const platform = options.platform || process.platform;
    const plan = planAppImageHookBundle(
      [source.state, source.autoStart, source.statusline],
      {
        appImagePath: decision.appImagePath,
        homeDir: options.homeDir,
        materializedRoot: options.materializedRoot,
        platform,
        rootDir: path.dirname(source.state),
        fs: options.fs,
        realpathSync: options.realpathSync,
      }
    );
    if (shouldMaterialize) {
      materializeAppImageHookBundle(plan, { fs: options.fs });
    }
    const targetFor = (sourcePath) => plan.entryTargets.get(path.resolve(sourcePath));
    const target = {
      // path.resolve normalizes the injected-fs-independent source string to
      // the exact key planAppImageHookBundle used (path.resolve on each entry).
      state: targetFor(source.state),
      autoStart: targetFor(source.autoStart),
      statusline: targetFor(source.statusline),
    };
    if (!target.state || !target.autoStart || !target.statusline) {
      return {
        ok: false,
        reason: "appimage-plan-incomplete",
        message: "AppImage hook plan did not resolve all Claude entry targets",
      };
    }
    return {
      ok: true,
      mode: "appimage-materialized",
      source,
      target,
      generationDir: plan.generationDir,
      appImagePath: decision.appImagePath,
      targetGeneration: {
        ok: isAppImageHookBundleComplete(plan, { fs: options.fs }),
        dir: plan.generationDir,
      },
    };
  } catch (err) {
    const cause = err && err.details && err.details.cause;
    const reason = err && err.code === "READ_FAILED" && (cause === "ENOENT" || cause === "EACCES")
      ? "source-script-missing"
      : ((err && err.code) || "appimage-materialize-failed");
    return {
      ok: false,
      reason,
      message: err && err.message,
    };
  }
}

// Best-effort, read-only helper for callers that only need the expected target
// paths (health/watcher/Doctor). Returns the resolver result; callers must
// treat !ok as degraded and never write.
function resolveClaudeHookPathsReadOnly(options = {}) {
  return resolveClaudeHookPaths(options, { materialize: false });
}

// Shared pure contract for the "injected fs must match the mutation target"
// hazard. src/server.js deliberately does NOT hand ctx.fs to the installer
// mutation: mutation always writes through node:fs. Therefore, whenever a local
// AppImage materialization is in effect, ANY injected fs (even one exposing
// every read/write method) could plan a different generation than the real
// installer writes, so it must fail closed. Direct mode never reads files
// through the seam, so any fs is fine there.
function checkClaudeMaterializationFs(options = {}) {
  const fsApi = options.fs;
  if (!fsApi || fsApi === fs) return { ok: true };
  let decision;
  try {
    // evaluateClaudeAppImage merges partial sourcePaths the same way the
    // resolver does, so the guard can never see a partial object and decide
    // direct while the resolver materializes.
    decision = evaluateClaudeAppImage(options);
  } catch (err) {
    return { ok: false, reason: "appimage-eval-failed", message: err && err.message };
  }
  if (decision.materialize !== true) return { ok: true };
  return {
    ok: false,
    reason: "resolver-fs-inconsistent",
    message: "AppImage hook materialization always uses the real filesystem for the settings mutation; an injected fs cannot be shared with it",
  };
}

// Production preflight contract shared by server and installer. Resolves and,
// for a local AppImage, materializes the persistent generation so a caller can
// prove the whole runtime exists BEFORE writing any settings. `requireStatusline`
// additionally validates the statusline source closure in direct mode, where
// resolveClaudeHookPaths does not read files.
function preflightClaudeRuntime(options = {}) {
  const resolved = resolveClaudeHookPaths(options, { materialize: true });
  if (!resolved || resolved.ok !== true) {
    return resolved || { ok: false, reason: "resolver-failed", message: "Claude hook path resolution failed" };
  }
  if (options.requireStatusline === true && resolved.mode === "direct") {
    const missing = findMissingHookDependencies(["claude-statusline.js"], {
      hooksDir: path.dirname(resolved.target.statusline),
    });
    if (missing.length) {
      return { ok: false, reason: "source-script-missing", message: formatMissingHookDependencies(missing) };
    }
  }
  return resolved;
}

function buildCommandHookSpec(nodeBin, scriptPath, args = "", options = {}) {
  const platform = options.platform || process.platform;
  const argSuffix = args ? ` ${args}` : "";
  // Shell-quoted form: used for PowerShell (& operator), remote POSIX (env-prefix
  // syntax is shell syntax), and native macOS/Linux (paths may contain spaces in
  // packaged apps). Quotes are part of the shell grammar.
  const shellQuotedCommand = `"${nodeBin}" "${scriptPath}"${argSuffix}`;
  // Plain (unquoted) form for WSL — Claude Code on WSL either defaults to
  // sh -c or splits on spaces; both work without quotes. Quoting WITHOUT
  // a shell field causes the hook runner to treat the quotes as part of the
  // executable name, breaking WSL hook execution. WSL paths never contain
  // spaces (/usr/bin/node, /home/…/.claude/hooks/…).
  const plainCommand = `${nodeBin} ${scriptPath}${argSuffix}`;
  const isWsl = !!options.wslDistro;

  const withHookOptions = (hook) => {
    if (Object.prototype.hasOwnProperty.call(options, "async")) {
      hook.async = options.async === true;
    }
    if (Number.isFinite(options.timeout)) {
      hook.timeout = options.timeout;
    }
    return hook;
  };

  // Remote hook deployment targets POSIX shells over SSH and relies on bash-style
  // env-prefix syntax (`CLAWD_REMOTE=1 cmd`). Keep that legacy form even if tests
  // force win32 here; Windows + remote is not a supported deployment target.
  if (options.remote) {
    return withHookOptions({
      type: "command",
      command: `${buildRemoteHookEnvPrefix(options)} ${shellQuotedCommand}`,
    });
  }

  if (platform === "win32") {
    return withHookOptions({
      type: "command",
      shell: "powershell",
      command: `& ${shellQuotedCommand}`,
    });
  }

  // WSL: plain (unquoted) POSIX format — no shell field. Claude Code on
  // WSL/Linux splits on spaces or uses sh -c; both work without quotes.
  // Quoting without a shell field was the root cause of silent WSL hook
  // failures (quotes treated as part of executable name).
  if (isWsl) {
    return withHookOptions({
      type: "command",
      command: plainCommand,
    });
  }

  // Native macOS/Linux: keep shell-quoted form. Paths in packaged apps
  // may contain spaces, and the hook runner on these platforms handles
  // quoted commands via the default sh -c.
  return withHookOptions({
    type: "command",
    command: shellQuotedCommand,
  });
}

function quotePosixEnvValue(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function isSshSecureRemoteInstall(options = {}) {
  const env = options.env || process.env;
  return options.remote === true
    && (options.sshRemote === true || env.CLAWD_SSH_REMOTE === "1");
}

function buildRemoteHookEnvPrefix(options = {}) {
  if (!isSshSecureRemoteInstall(options)) return "CLAWD_REMOTE=1";
  const identityPath = resolveRemoteIdentityPath(options);
  const markerPath = resolveSshSecureMarkerPath(options);
  const hostPrefixPath = options.hostPrefixPath
    || (options.env || process.env).CLAWD_HOST_PREFIX_PATH
    || path.join(path.dirname(identityPath), "clawd-host-prefix");
  const remoteLastLogPath = options.remoteLastLogPath
    || (options.env || process.env).CLAWD_REMOTE_LAST_LOG_PATH
    || path.join(path.dirname(identityPath), "clawd-remote-last-error.log");
  const statuslineSidecarPath = options.statuslineSidecarPath
    || (options.env || process.env).CLAWD_STATUSLINE_SIDECAR_PATH
    || path.join(path.dirname(identityPath), "clawd-statusline-chain.json");
  return [
    "CLAWD_REMOTE=1",
    "CLAWD_SSH_REMOTE=1",
    `CLAWD_REMOTE_IDENTITY_PATH=${quotePosixEnvValue(identityPath)}`,
    `CLAWD_SSH_SECURE_MARKER_PATH=${quotePosixEnvValue(markerPath)}`,
    `CLAWD_HOST_PREFIX_PATH=${quotePosixEnvValue(hostPrefixPath)}`,
    `CLAWD_REMOTE_LAST_LOG_PATH=${quotePosixEnvValue(remoteLastLogPath)}`,
    `CLAWD_STATUSLINE_SIDECAR_PATH=${quotePosixEnvValue(statuslineSidecarPath)}`,
  ].join(" ");
}

function requireRemoteInstallIdentity(options = {}) {
  if (!isSshSecureRemoteInstall(options)) return null;
  const identity = options.remoteIdentity && options.remoteIdentity.ok !== undefined
    ? options.remoteIdentity
    : readRemoteIdentity(options);
  if (!identity || identity.ok !== true) {
    const reason = identity && identity.reason ? identity.reason : "identity-invalid";
    throw new Error(`Secure Remote SSH identity is required before installing hooks (${reason})`);
  }
  return identity;
}

function resolveRemotePermissionTransport(options = {}) {
  if (options.remote !== true) return "path";
  const value = options.remotePermissionTransport
    || (options.env || process.env).CLAWD_REMOTE_PERMISSION_TRANSPORT
    || "path";
  return value === "query" || value === "native" ? value : "path";
}

function forEachCommandHook(entries, visitor) {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.command === "string") {
      visitor(entry);
    }
    if (Array.isArray(entry.hooks)) {
      for (const hook of entry.hooks) {
        if (!hook || typeof hook !== "object" || typeof hook.command !== "string") continue;
        visitor(hook);
      }
    }
  }
}

function syncCommandHook(entries, marker, expectedHook) {
  let found = false;
  let changed = false;
  const syncField = (hook, field) => {
    const hasExpected = Object.prototype.hasOwnProperty.call(expectedHook, field);
    const hasCurrent = Object.prototype.hasOwnProperty.call(hook, field);
    if (!hasExpected) {
      if (!hasCurrent) return;
      delete hook[field];
      changed = true;
      return;
    }
    if (hook[field] === expectedHook[field]) return;
    hook[field] = expectedHook[field];
    changed = true;
  };

  forEachCommandHook(entries, (hook) => {
    if (!hook.command.includes(marker)) return;
    found = true;
    syncField(hook, "type");
    if (hook.command !== expectedHook.command) {
      hook.command = expectedHook.command;
      changed = true;
    }
    syncField(hook, "shell");
    syncField(hook, "async");
    syncField(hook, "timeout");
  });
  return { found, changed };
}

const STATE_HOOK_SYNC_FIELDS = Object.freeze(["type", "command", "shell", "async", "timeout"]);

function commandHookMatchesExpected(hook, expectedHook) {
  if (!hook || !expectedHook) return false;
  return STATE_HOOK_SYNC_FIELDS.every((field) => {
    const hasExpected = Object.prototype.hasOwnProperty.call(expectedHook, field);
    const hasCurrent = Object.prototype.hasOwnProperty.call(hook, field);
    return hasExpected === hasCurrent && (!hasExpected || hook[field] === expectedHook[field]);
  });
}

function syncCommandHookFields(hook, expectedHook) {
  let changed = false;
  for (const field of STATE_HOOK_SYNC_FIELDS) {
    const hasExpected = Object.prototype.hasOwnProperty.call(expectedHook, field);
    const hasCurrent = Object.prototype.hasOwnProperty.call(hook, field);
    if (!hasExpected) {
      if (hasCurrent) {
        delete hook[field];
        changed = true;
      }
      continue;
    }
    if (hook[field] !== expectedHook[field]) {
      hook[field] = expectedHook[field];
      changed = true;
    }
  }
  return changed;
}

function collectManagedStateHookRecords(entries, settings, event) {
  if (!Array.isArray(entries)) return [];
  const records = [];
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = entries[entryIndex];
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.command === "string") {
      const kind = classifyManagedClaudeStateHookCommand(entry.command, settings, event);
      if (kind) records.push({ entryIndex, hookIndex: null, hook: entry, kind });
    }
    if (!Array.isArray(entry.hooks)) continue;
    for (let hookIndex = 0; hookIndex < entry.hooks.length; hookIndex++) {
      const hook = entry.hooks[hookIndex];
      if (!hook || typeof hook !== "object" || typeof hook.command !== "string") continue;
      const kind = classifyManagedClaudeStateHookCommand(hook.command, settings, event);
      if (kind) records.push({ entryIndex, hookIndex, hook, kind });
    }
  }
  return records;
}

function stateHookRecordKey(record) {
  return `${record.entryIndex}:${record.hookIndex === null ? "flat" : record.hookIndex}`;
}

// Active state hooks converge to one owned child. Removal must be position-
// aware: old syncCommandHook() can produce byte-identical duplicates, so a
// command-string predicate cannot express "keep this one, remove the rest."
function foldManagedStateHooks(entries, settings, event, expectedHook, options = {}) {
  const records = collectManagedStateHookRecords(entries, settings, event);
  if (records.length === 0) {
    return { entries, found: false, changed: false, updated: false, removed: 0 };
  }

  const envRecords = records.filter((record) => record.kind === "env");
  const literalRecords = records.filter((record) => record.kind === "literal");
  const canCanonicalizeEnv = options.canCanonicalizeEnv === true;
  let survivor;
  if (!canCanonicalizeEnv && literalRecords.length > 0) {
    // A working literal command is strictly better than an env command we
    // cannot safely migrate. Never delete the literal merely because an env
    // record happened to appear earlier in the event array.
    survivor = literalRecords.find((record) => commandHookMatchesExpected(record.hook, expectedHook))
      || literalRecords[0];
  } else if (envRecords.length > 0 && !canCanonicalizeEnv) {
    // With no literal fallback, preserve one env command unchanged instead of
    // degrading it to bare `node` under Claude Code's minimal macOS PATH.
    survivor = envRecords[0];
  } else {
    survivor = records.find((record) => commandHookMatchesExpected(record.hook, expectedHook)) || records[0];
  }

  const shouldCanonicalize = survivor.kind !== "env" || canCanonicalizeEnv;
  const updated = shouldCanonicalize ? syncCommandHookFields(survivor.hook, expectedHook) : false;
  const survivorKey = stateHookRecordKey(survivor);
  const removedKeys = new Set(
    records
      .filter((record) => stateHookRecordKey(record) !== survivorKey)
      .map(stateHookRecordKey)
  );

  if (removedKeys.size === 0) {
    return { entries, found: true, changed: updated, updated, removed: 0 };
  }

  const nextEntries = [];
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = entries[entryIndex];
    if (!entry || typeof entry !== "object") {
      nextEntries.push(entry);
      continue;
    }

    const removeFlat = removedKeys.has(`${entryIndex}:flat`);
    const hasNested = Array.isArray(entry.hooks);
    const nextHooks = hasNested
      ? entry.hooks.filter((hook, hookIndex) => !removedKeys.has(`${entryIndex}:${hookIndex}`))
      : null;

    if (removeFlat) {
      if (!nextHooks || nextHooks.length === 0) continue;
      const nextEntry = { ...entry, hooks: nextHooks };
      for (const field of STATE_HOOK_SYNC_FIELDS) delete nextEntry[field];
      nextEntries.push(nextEntry);
      continue;
    }

    if (!hasNested || nextHooks.length === entry.hooks.length) {
      nextEntries.push(entry);
      continue;
    }
    if (nextHooks.length === 0 && typeof entry.command !== "string") continue;
    nextEntries.push({ ...entry, hooks: nextHooks });
  }

  return {
    entries: nextEntries,
    found: true,
    changed: true,
    updated,
    removed: removedKeys.size,
  };
}

function isClawdPermissionUrl(url) {
  return isManagedPermissionUrl(url);
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
      (command) => classifyManagedClaudeStateHookCommand(command, settings, event) !== null
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
// WSL detection for the hook command format. CLAWD_WSL_DISTRO is injected
// by the Windows-side one-click deploy; WSL_DISTRO_NAME is set by WSL init
// itself, so a manual `node install.js` inside WSL also gets the plain
// command format (the quoted form silently fails there — see
// buildCommandHookSpec). Gated on linux so a stale variable in some other
// environment cannot flip the format.
function resolveInstallWslDistro(options = {}) {
  if (options.wslDistro) return options.wslDistro;
  if (process.env.CLAWD_WSL_DISTRO) return process.env.CLAWD_WSL_DISTRO;
  if (process.platform === "linux" && process.env.WSL_DISTRO_NAME) {
    return process.env.WSL_DISTRO_NAME;
  }
  return null;
}

function resolveWritePath(settingsPath) {
  try { return fs.realpathSync(settingsPath); } catch (err) {
    // ENOENT: new file, no symlink yet — use the unresolved path.
    // Other errors (ELOOP, EACCES, EIO) — surface them rather than silently
    // replacing a symlink with a regular file.
    if (err && err.code === "ENOENT") return settingsPath;
    throw err;
  }
}

function accessModeForPlatform(platform) {
  return platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK;
}

function validateEnvNodeCandidatesSync(candidates, options = {}) {
  const access = options.accessSync || fs.accessSync;
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    try {
      access(candidate, accessModeForPlatform(options.platform || process.platform));
      return candidate;
    } catch {}
  }
  return null;
}

async function validateEnvNodeCandidatesAsync(candidates, options = {}) {
  const access = options.access || fs.promises.access.bind(fs.promises);
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    try {
      await access(candidate, accessModeForPlatform(options.platform || process.platform));
      return candidate;
    } catch {}
  }
  return null;
}

function configuredNodeResolution(nodeBin) {
  const value = typeof nodeBin === "string" && nodeBin ? nodeBin : "node";
  return {
    nodeBin: value,
    // isSafeNodeExecutableCandidate() intentionally applies a much stricter
    // anti-injection grammar to untrusted settings.env values before they are
    // considered. Candidates from that source have already passed that gate
    // before reaching here. Resolver output, explicit caller choices, and
    // existing literal commands are the same trusted values the installer
    // already serializes for every core event; requiring basename `node` or
    // rejecting quoted path characters such as parentheses would make env
    // migration disagree with normal registration. The only unsafe fallback
    // for migration is a non-absolute command such as bare `node`.
    canCanonicalizeEnv: path.posix.isAbsolute(value) || path.win32.isAbsolute(value),
  };
}

function resolveConfiguredNodeBinSync(options, settings) {
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  if (typeof resolved === "string" && resolved) return configuredNodeResolution(resolved);

  const existing = extractExistingNodeBin(settings, MARKER, { nested: true });
  if (existing) return configuredNodeResolution(existing);

  const envCandidate = validateEnvNodeCandidatesSync(
    findManagedClaudeEnvNodeBinCandidates(settings),
    options
  );
  if (envCandidate) return configuredNodeResolution(envCandidate);

  return configuredNodeResolution("node");
}

function registerHooks(options = {}) {
  const settingsPath = resolveClaudeSettingsPath(options);
  const writePath = resolveWritePath(settingsPath);
  const remoteIdentity = requireRemoteInstallIdentity(options);
  const remotePermissionTransport = resolveRemotePermissionTransport(options);
  const hookPort = remoteIdentity ? remoteIdentity.remotePort : getHookServerPort(options.port);
  const platform = options.platform || process.platform;
  const wslDistro = resolveInstallWslDistro(options);

  // Read existing settings. readJsonFile strips a single leading UTF-8 BOM
  // (#657) so a BOM-prefixed canonical config can be merged instead of
  // failing to parse. A valid-JSON non-object root is rejected here (thrown
  // inside the try so the existing catch wraps it as a read failure) rather
  // than being treated as an empty config and overwritten.
  let settings = {};
  let preExisting = false;
  try {
    settings = readJsonFile(settingsPath);
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error("settings.json root must be a JSON object");
    }
    preExisting = true;
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read settings.json: ${err.message}`);
    }
  }

  if (!settings.hooks) settings.hooks = {};

  // Resolve and (for a local Linux AppImage) materialize the persistent
  // generation BEFORE any settings mutation. Failure here must abort the whole
  // registration: writing a command toward a generation that was never
  // completed would leave a permanently broken hook.
  const resolvedHookPaths = resolveClaudeHookPaths(options, { materialize: true });
  if (!resolvedHookPaths.ok) {
    throw new Error(
      `Failed to prepare Claude hook runtime: ${resolvedHookPaths.message || resolvedHookPaths.reason}`
    );
  }
  const hookScript = resolvedHookPaths.target.state;
  const autoStartScript = resolvedHookPaths.target.autoStart;

  // Resolve absolute node path — on macOS/Linux, Claude Code runs hooks with
  // a minimal PATH that excludes Homebrew, nvm, volta, etc.
  // If detection fails (null), preserve the existing absolute path from settings
  // to avoid destructively overwriting a working config with bare "node".
  const nodeResolution = resolveConfiguredNodeBinSync(options, settings);
  const { nodeBin } = nodeResolution;

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
      (command) => classifyManagedClaudeStateHookCommand(command, settings, event) !== null
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

    // Local Windows hooks must use explicit PowerShell invocation because Claude
    // Code defaults command hooks to bash on Windows. Remote hooks stay on the
    // legacy POSIX/bash-compatible form; see buildCommandHookSpec().
    const desiredHook = buildCommandHookSpec(nodeBin, hookScript, event, {
      platform,
      remote: options.remote,
      sshRemote: options.sshRemote,
      wslDistro,
      async: true,
      timeout: options.remote ? REMOTE_STATE_HOOK_TIMEOUT_SECONDS : STATE_HOOK_TIMEOUT_SECONDS,
      remoteIdentityPath: options.remoteIdentityPath || (remoteIdentity && remoteIdentity.filePath),
      secureMarkerPath: options.secureMarkerPath,
      hostPrefixPath: options.hostPrefixPath,
    });
    const commandSync = foldManagedStateHooks(
      settings.hooks[event],
      settings,
      event,
      desiredHook,
      { canCanonicalizeEnv: nodeResolution.canCanonicalizeEnv }
    );
    if (commandSync.found) {
      settings.hooks[event] = commandSync.entries;
      removed += commandSync.removed;
      if (commandSync.updated) {
        updated++;
      }
      if (commandSync.changed) {
        changed = true;
      } else {
        skipped++;
      }
      continue;
    }

    // Use nested format to match Claude Code's expected structure
    settings.hooks[event].push({
      matcher: "",
      hooks: [desiredHook],
    });
    added++;
  }

  // Register auto-start hook for SessionStart (launches app if not running)
  if (options.autoStart) {
    if (!Array.isArray(settings.hooks.SessionStart)) {
      settings.hooks.SessionStart = [];
      changed = true;
    }

    const autoStartHook = buildCommandHookSpec(nodeBin, autoStartScript, "", {
      platform,
      wslDistro,
      async: true,
      timeout: AUTO_START_HOOK_TIMEOUT_SECONDS,
    });
    const autoStartSync = syncCommandHook(settings.hooks.SessionStart, AUTO_START_MARKER, autoStartHook);
    if (!autoStartSync.found) {
      // Keep auto-start visible before the state hook in settings. Claude Code
      // runs matching hooks in parallel, so correctness must not depend on order.
      settings.hooks.SessionStart.unshift({
        matcher: "",
        hooks: [autoStartHook],
      });
      added++;
    } else if (autoStartSync.changed) {
      updated++;
      changed = true;
    } else {
      skipped++;
    }

    // Remove all legacy auto-start.sh entries if present. Match per sub-hook so
    // a mixed wrapper keeps its third-party siblings (unlike the old
    // whole-entry filter), and count each removal.
    const legacyAutoStartResult = removeMatchingCommandHooks(
      settings.hooks.SessionStart,
      (command) => command.includes(LEGACY_AUTO_START_MARKER)
    );
    if (legacyAutoStartResult.changed) {
      settings.hooks.SessionStart = legacyAutoStartResult.entries;
      removed += legacyAutoStartResult.removed;
      changed = true;
    }
  }

  // Clean up stale command hooks for HTTP-only events (e.g. PermissionRequest).
  // Old versions or manual edits may have registered a command hook alongside the
  // HTTP hook, causing Claude Code to fire both and produce duplicate bubbles.
  for (const event of Object.keys(HTTP_HOOKS)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    const result = removeMatchingCommandHooks(
      settings.hooks[event],
      (command) => classifyManagedClaudeStateHookCommand(command, settings, event) !== null
    );
    if (result.changed) {
      settings.hooks[event] = result.entries;
      removed += result.removed;
      changed = true;
    }
  }

  // Register HTTP hooks (permission decision collection)
  for (const [event, { matcher, hook }] of Object.entries(HTTP_HOOKS)) {
    if (remotePermissionTransport === "native") {
      const removedHttp = removeMatchingHttpHooks(
        settings.hooks[event],
        (entry) => isManagedPermissionUrl(entry && entry.url),
      );
      if (removedHttp.changed) {
        settings.hooks[event] = removedHttp.entries;
        removed += removedHttp.removed;
        changed = true;
      }
      continue;
    }
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      changed = true;
    }

    const desiredHook = {
      ...hook,
      url: buildPermissionUrl(
        hookPort,
        remoteIdentity && remoteIdentity.routingNonce,
        remotePermissionTransport,
      ),
    };
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
  let backupPath = null;
  if (added > 0 || changed) {
    // Snapshot the user's prior settings before mutating so the install is
    // recoverable. Atomic write prevents a half-written file, not an undo —
    // and we inject hooks into a shared global config the user did not author.
    // Only back up a file that already existed; opt out with `backup: false`.
    if (preExisting && options.backup !== false) {
      backupPath = writeJsonAtomicWithBackup(writePath, settings, {
        backup: true,
        backupPath: options.backupPath,
        backupKeep: options.backupKeep,
      });
      if (backupPath && !options.silent) {
        console.log(`  Backup: saved previous settings to ${backupPath}`);
      }
    } else {
      writeJsonAtomic(writePath, settings);
    }
  }

  if (!options.silent) {
    const versionLabel = versionInfo.status === "known" ? versionInfo.version : "unknown";
    const versionSource = versionInfo.source || "unavailable";
    console.log(`Clawd hooks installed to ${writePath}`);
    console.log(`  Claude Code version: ${versionLabel}`);
    console.log(`  Detection source: ${versionSource}`);
    if (versionInfo.status === "unknown") {
      console.log("  Versioned hooks: disabled (Claude Code version could not be detected)");
    }
    console.log(`  Added: ${added} hooks`);
    if (updated > 0) console.log(`  Updated: ${updated} stale hook paths`);
    if (removed > 0) console.log(`  Removed: ${removed} obsolete or incompatible managed hooks`);
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
    backupPath,
  };
}

// #317: an explicit options.nodeBin is the caller's authoritative choice
// (Remote/WSL/test injection) and must never be re-validated against this
// machine's filesystem. A Node path already extracted from the user's existing
// config only needs one lightweight existence check — not a full resolver
// probe — to avoid reintroducing the shell/version spawn #317 removed.
// Resolution only escalates to the async resolver (which may spawn a shell)
// when there is no existing path, or the existing path fails that check.
async function resolveConfiguredNodeBinAsync(options, settings) {
  if (typeof options.nodeBin === "string" && options.nodeBin) {
    return configuredNodeResolution(options.nodeBin);
  }

  const existing = extractExistingNodeBin(settings, MARKER, { nested: true });
  if (existing) {
    const access = options.access || fs.promises.access.bind(fs.promises);
    // Match the doctor validator and resolver: POSIX requires the execute
    // bit (X_OK) — a Node path that merely exists but lost its executable
    // permission would otherwise be preserved here, then judged broken by
    // the health inspector on the very next check, forcing pointless repair
    // cycles. Windows has no equivalent executable-bit semantics, so F_OK
    // (existence) matches resolveWindowsNodeBinSync/Async's own checks.
    const platform = options.platform || process.platform;
    const mode = platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK;
    try {
      await access(existing, mode);
      return configuredNodeResolution(existing);
    } catch {
      // existing path is gone/inaccessible — fall through to the resolver
    }
  }

  const resolved = await resolveNodeBinAsync(options);
  if (resolved) return configuredNodeResolution(resolved);

  const envCandidate = await validateEnvNodeCandidatesAsync(
    findManagedClaudeEnvNodeBinCandidates(settings),
    options
  );
  if (envCandidate) return configuredNodeResolution(envCandidate);

  return configuredNodeResolution("node");
}

async function registerHooksAsync(options = {}) {
  const settingsPath = resolveClaudeSettingsPath(options);
  const writePath = resolveWritePath(settingsPath);
  const remoteIdentity = requireRemoteInstallIdentity(options);
  const remotePermissionTransport = resolveRemotePermissionTransport(options);
  const hookPort = remoteIdentity ? remoteIdentity.remotePort : getHookServerPort(options.port);
  const platform = options.platform || process.platform;
  const wslDistro = resolveInstallWslDistro(options);

  let settings = {};
  let preExisting = false;
  try {
    settings = await readJsonFileAsync(settingsPath);
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error("settings.json root must be a JSON object");
    }
    preExisting = true;
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read settings.json: ${err.message}`);
    }
  }

  if (!settings.hooks) settings.hooks = {};

  // Same source/target resolution as registerHooks() — materialize before any
  // settings mutation, and use the persistent target for every command.
  const resolvedHookPaths = resolveClaudeHookPaths(options, { materialize: true });
  if (!resolvedHookPaths.ok) {
    throw new Error(
      `Failed to prepare Claude hook runtime: ${resolvedHookPaths.message || resolvedHookPaths.reason}`
    );
  }
  const hookScript = resolvedHookPaths.target.state;
  const autoStartScript = resolvedHookPaths.target.autoStart;

  const nodeResolution = await resolveConfiguredNodeBinAsync(options, settings);
  const { nodeBin } = nodeResolution;

  let added = 0;
  let skipped = 0;
  let versionSkipped = 0;
  let updated = 0;
  let removed = 0;
  let changed = false;

  const versionInfo = options.claudeVersionInfo || await getClaudeVersionAsync(options);
  const { supported: supportedVersionedHooks, unsupported: unsupportedVersionedHooks } =
    getSupportedVersionedHooks(versionInfo);
  const supportedVersionedEvents = new Set(supportedVersionedHooks.map((hook) => hook.event));
  versionSkipped = unsupportedVersionedHooks.length;

  const reconcileResult = reconcileVersionedHooks(settings, supportedVersionedEvents, versionInfo);
  removed += reconcileResult.removed;
  changed = changed || reconcileResult.changed;

  for (const event of DEPRECATED_CORE_HOOKS) {
    if (!Array.isArray(settings.hooks[event])) continue;
    const result = removeMatchingCommandHooks(
      settings.hooks[event],
      (command) => classifyManagedClaudeStateHookCommand(command, settings, event) !== null
    );
    if (!result.changed) continue;
    removed += result.removed;
    changed = true;
    if (result.entries.length > 0) settings.hooks[event] = result.entries;
    else delete settings.hooks[event];
  }

  const hookEvents = [...CORE_HOOKS];
  for (const { event } of supportedVersionedHooks) {
    hookEvents.push(event);
  }

  for (const event of hookEvents) {
    if (!Array.isArray(settings.hooks[event])) {
      const existing = settings.hooks[event];
      settings.hooks[event] = existing && typeof existing === "object" ? [existing] : [];
      changed = true;
    }

    const desiredHook = buildCommandHookSpec(nodeBin, hookScript, event, {
      platform,
      remote: options.remote,
      sshRemote: options.sshRemote,
      wslDistro,
      async: true,
      timeout: options.remote ? REMOTE_STATE_HOOK_TIMEOUT_SECONDS : STATE_HOOK_TIMEOUT_SECONDS,
      remoteIdentityPath: options.remoteIdentityPath || (remoteIdentity && remoteIdentity.filePath),
      secureMarkerPath: options.secureMarkerPath,
      hostPrefixPath: options.hostPrefixPath,
    });
    const commandSync = foldManagedStateHooks(
      settings.hooks[event],
      settings,
      event,
      desiredHook,
      { canCanonicalizeEnv: nodeResolution.canCanonicalizeEnv }
    );
    if (commandSync.found) {
      settings.hooks[event] = commandSync.entries;
      removed += commandSync.removed;
      if (commandSync.updated) {
        updated++;
      }
      if (commandSync.changed) {
        changed = true;
      } else {
        skipped++;
      }
      continue;
    }

    settings.hooks[event].push({
      matcher: "",
      hooks: [desiredHook],
    });
    added++;
  }

  if (options.autoStart) {
    if (!Array.isArray(settings.hooks.SessionStart)) {
      settings.hooks.SessionStart = [];
      changed = true;
    }

    const autoStartHook = buildCommandHookSpec(nodeBin, autoStartScript, "", {
      platform,
      wslDistro,
      async: true,
      timeout: AUTO_START_HOOK_TIMEOUT_SECONDS,
    });
    const autoStartSync = syncCommandHook(settings.hooks.SessionStart, AUTO_START_MARKER, autoStartHook);
    if (!autoStartSync.found) {
      settings.hooks.SessionStart.unshift({
        matcher: "",
        hooks: [autoStartHook],
      });
      added++;
    } else if (autoStartSync.changed) {
      updated++;
      changed = true;
    } else {
      skipped++;
    }

    // Remove all legacy auto-start.sh entries if present. Match per sub-hook so
    // a mixed wrapper keeps its third-party siblings (unlike the old
    // whole-entry filter), and count each removal.
    const legacyAutoStartResult = removeMatchingCommandHooks(
      settings.hooks.SessionStart,
      (command) => command.includes(LEGACY_AUTO_START_MARKER)
    );
    if (legacyAutoStartResult.changed) {
      settings.hooks.SessionStart = legacyAutoStartResult.entries;
      removed += legacyAutoStartResult.removed;
      changed = true;
    }
  }

  for (const event of Object.keys(HTTP_HOOKS)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    const result = removeMatchingCommandHooks(
      settings.hooks[event],
      (command) => classifyManagedClaudeStateHookCommand(command, settings, event) !== null
    );
    if (result.changed) {
      settings.hooks[event] = result.entries;
      removed += result.removed;
      changed = true;
    }
  }

  for (const [event, { matcher, hook }] of Object.entries(HTTP_HOOKS)) {
    if (remotePermissionTransport === "native") {
      const removedHttp = removeMatchingHttpHooks(
        settings.hooks[event],
        (entry) => isManagedPermissionUrl(entry && entry.url),
      );
      if (removedHttp.changed) {
        settings.hooks[event] = removedHttp.entries;
        removed += removedHttp.removed;
        changed = true;
      }
      continue;
    }
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      changed = true;
    }

    const desiredHook = {
      ...hook,
      url: buildPermissionUrl(
        hookPort,
        remoteIdentity && remoteIdentity.routingNonce,
        remotePermissionTransport,
      ),
    };
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

  let backupPath = null;
  if (added > 0 || changed) {
    // See registerHooks(): back up the prior config before injecting hooks so
    // the change is recoverable. Only back up a pre-existing file; `backup: false` opts out.
    if (preExisting && options.backup !== false) {
      backupPath = await writeJsonAtomicWithBackupAsync(writePath, settings, {
        backup: true,
        backupPath: options.backupPath,
        backupKeep: options.backupKeep,
      });
      if (backupPath && !options.silent) {
        console.log(`  Backup: saved previous settings to ${backupPath}`);
      }
    } else {
      await writeJsonAtomicAsync(writePath, settings);
    }
  }

  if (!options.silent) {
    const versionLabel = versionInfo.status === "known" ? versionInfo.version : "unknown";
    const versionSource = versionInfo.source || "unavailable";
    console.log(`Clawd hooks installed to ${writePath}`);
    console.log(`  Claude Code version: ${versionLabel}`);
    console.log(`  Detection source: ${versionSource}`);
    if (versionInfo.status === "unknown") {
      console.log("  Versioned hooks: disabled (Claude Code version could not be detected)");
    }
    console.log(`  Added: ${added} hooks`);
    if (updated > 0) console.log(`  Updated: ${updated} stale hook paths`);
    if (removed > 0) console.log(`  Removed: ${removed} obsolete or incompatible managed hooks`);
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
    backupPath,
  };
}

function unregisterHooks(options = {}) {
  const settingsPath = resolveClaudeSettingsPath(options);
  const writePath = resolveWritePath(settingsPath);
  let settings = {};
  try {
    settings = readJsonFile(settingsPath);
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
      (command) => classifyManagedClaudeStateHookCommand(command, settings, event) !== null
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

  let backupPath = null;
  if (changed) {
    backupPath = writeJsonAtomicWithBackup(writePath, settings, options);
  }

  const result = { removed, changed };
  if (options.backup === true) result.backupPath = backupPath;
  return result;
}

async function unregisterHooksAsync(options = {}) {
  const settingsPath = resolveClaudeSettingsPath(options);
  const writePath = resolveWritePath(settingsPath);
  let settings = {};
  try {
    settings = await readJsonFileAsync(settingsPath);
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
      (command) => classifyManagedClaudeStateHookCommand(command, settings, event) !== null
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

  let backupPath = null;
  if (changed) {
    backupPath = await writeJsonAtomicWithBackupAsync(writePath, settings, options);
  }

  const result = { removed, changed };
  if (options.backup === true) result.backupPath = backupPath;
  return result;
}

/**
 * Remove the auto-start hook from SessionStart in ~/.claude/settings.json.
 * Also removes legacy auto-start.sh entries.
 * @returns {boolean} true if a hook was removed
 */
function unregisterAutoStart(options = {}) {
  const settingsPath = resolveClaudeSettingsPath(options);
  const writePath = resolveWritePath(settingsPath);
  let settings;
  try {
    settings = readJsonFile(settingsPath);
  } catch {
    return false;
  }

  const arr = settings && settings.hooks && settings.hooks.SessionStart;
  if (!Array.isArray(arr)) return false;

  // Remove only the managed sub-hooks. A whole-entry filter would drop a mixed
  // wrapper's third-party siblings along with the managed command.
  const result = removeMatchingCommandHooks(
    arr,
    (command) => command.includes(AUTO_START_MARKER) || command.includes(LEGACY_AUTO_START_MARKER)
  );
  if (!result.changed) return false;

  settings.hooks.SessionStart = result.entries;
  writeJsonAtomic(writePath, settings);
  return true;
}

/**
 * Check if the auto-start hook is currently registered in settings.json.
 * @returns {boolean}
 */
function isAutoStartRegistered(options = {}) {
  const settingsPath = resolveClaudeSettingsPath(options);
  try {
    const settings = readJsonFile(settingsPath);
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

const STATUSLINE_MARKER = "claude-statusline.js";
const STATUSLINE_CHAIN_FLAG = "--chain";

function writeLocalStatuslineSettings(file, settings, options) {
  const mode = fs.statSync(file).mode & 0o777;
  const backupPath = createBackup(file, options);
  writeTextAtomic(file, JSON.stringify(settings, null, 2), { encoding: "utf8", mode });
  if (backupPath) pruneOldBackups(file, options, backupPath);
  return backupPath;
}

function hasClaudeSettingsDir(homeDir, options = {}) {
  return fs.existsSync(resolveClaudeHome({ ...options, homeDir }));
}

// Chain mode sidecar: holds the user's original statusLine object verbatim
// while our command occupies the slot with `--chain`. The statusline script
// executes the sidecar's command (their rendering survives), and unregister
// restores the object from here. A sidecar file instead of a CLI argument
// because real third-party statusline commands are arbitrarily-quoted shell
// one-liners - embedding one inside another quoted command is exactly the
// escaping swamp buildPortableStatuslineCommand exists to avoid.
function statuslineChainSidecarPath(homeDir) {
  return path.join(resolveClaudeHooksDir({ homeDir }), "clawd-statusline-chain.json");
}

function readChainSidecarStatusLine(sidecarPath) {
  try {
    const raw = readJsonFile(sidecarPath);
    const statusLine = raw && typeof raw === "object" ? raw.statusLine : null;
    if (statusLine && typeof statusLine === "object" && !Array.isArray(statusLine)
      && typeof statusLine.command === "string" && statusLine.command.trim()) {
      return statusLine;
    }
  } catch {}
  return null;
}

function canonicalStatuslinePath(value, platform = process.platform) {
  let normalized = String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (platform === "win32" || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")) {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

function isNodeStatuslineToken(value) {
  const basename = String(value || "").replace(/\\/g, "/").split("/").pop().toLowerCase();
  return basename === "node" || basename === "node.exe";
}

function validateRemoteStatuslinePrefix(prefix) {
  let rest = String(prefix || "").trim();
  if (!rest) return { ok: true, remote: false };
  const allowed = new Set([
    "CLAWD_REMOTE",
    "CLAWD_SSH_REMOTE",
    "CLAWD_REMOTE_IDENTITY_PATH",
    "CLAWD_SSH_SECURE_MARKER_PATH",
    "CLAWD_HOST_PREFIX_PATH",
    "CLAWD_REMOTE_LAST_LOG_PATH",
    "CLAWD_STATUSLINE_SIDECAR_PATH",
  ]);
  let sawRemote = false;
  while (rest) {
    const match = rest.match(/^([A-Z_]+)=((?:'(?:'\\''|[^'])*')|(?:"(?:\\"|[^"])*")|(?:\S+))(?:\s+|$)/);
    if (!match || !allowed.has(match[1])) return { ok: false, remote: false };
    if (match[1] === "CLAWD_REMOTE") {
      if (match[2] !== "1") return { ok: false, remote: false };
      sawRemote = true;
    }
    rest = rest.slice(match[0].length);
  }
  return { ok: sawRemote, remote: sawRemote };
}

function parseStrictClaudeStatuslineCommand(command, expectedScript, platform = process.platform) {
  if (typeof command !== "string" || !command.trim() || /[\r\n\0]/.test(command)) return null;
  let body = command.trim();
  let suffix = "plain";
  const localMatch = body.match(/\s+--local-chain\s+([a-f0-9]{32})$/);
  if (localMatch) {
    suffix = "local";
    body = body.slice(0, localMatch.index);
  } else if (/\s+--chain$/.test(body)) {
    suffix = "remote-chain";
    body = body.replace(/\s+--chain$/, "");
  }
  const scriptMatch = body.match(/^(.*)\s+"((?:\\"|[^"])*)"$/);
  if (!scriptMatch) return null;
  const scriptPath = scriptMatch[2].replace(/\\"/g, '"');
  let head = scriptMatch[1].trim();
  let nodeBin;
  const quotedNode = head.match(/^(.*?)(?:^|\s)"((?:\\"|[^"])*)"$/);
  if (quotedNode) {
    head = quotedNode[1].trim();
    nodeBin = quotedNode[2].replace(/\\"/g, '"');
  } else {
    const bareNode = head.match(/^(.*?)(?:^|\s)(\S+)$/);
    if (!bareNode) return null;
    head = bareNode[1].trim();
    nodeBin = bareNode[2];
  }
  if (head.endsWith("&")) head = head.slice(0, -1).trim();
  const prefix = validateRemoteStatuslinePrefix(head);
  if (!prefix.ok && head) return null;
  if (!isNodeStatuslineToken(nodeBin)) return null;
  const exactScript = canonicalStatuslinePath(scriptPath, platform) === canonicalStatuslinePath(expectedScript, platform);
  const legacyAppImage = platform === "linux" && !exactScript
    && isLegacyAppImageHookPath(scriptPath, STATUSLINE_MARKER);
  if (!exactScript && !legacyAppImage) return null;
  if (suffix === "local" && prefix.remote) return null;
  if (suffix === "remote-chain" && !prefix.remote) return null;
  return { suffix, remote: prefix.remote, nodeBin, scriptPath, legacyAppImage };
}

function hasExactStatuslineMarker(command) {
  return new RegExp(`(?:^|[\\\\/])${STATUSLINE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=["'\\s]|$)`, "i")
    .test(String(command || ""));
}

function classifyManagedClaudeStatusline(existing, options = {}) {
  const {
    LOCAL_CHAIN_FLAG, requireOwnedLocalChain,
    PLAIN_OWNER, REMOTE_CHAIN_OWNER,
    readStatuslineOwnerRecord, ownerRecordMatchesCommand,
  } = require("./claude-statusline-local-chain");
  if (!existing || typeof existing.command !== "string" || !existing.command.trim()) {
    return { classification: "foreign", mode: null };
  }
  const command = existing.command;
  if (command.includes(` ${LOCAL_CHAIN_FLAG} `)) {
    try {
      const record = requireOwnedLocalChain(options.localSidecar, existing);
      return { classification: "owned", mode: "local", record };
    } catch (error) {
      return { classification: "ambiguous", mode: "local", error };
    }
  }

  let plainRecord = null;
  let remoteRecord = null;
  let plainRecordError = null;
  let remoteRecordError = null;
  try { plainRecord = readStatuslineOwnerRecord(options.plainOwnerPath, PLAIN_OWNER); } catch (error) { plainRecordError = error; }
  try { remoteRecord = readStatuslineOwnerRecord(options.remoteSidecarPath, REMOTE_CHAIN_OWNER); } catch (error) { remoteRecordError = error; }
  if (ownerRecordMatchesCommand(plainRecord, command)) {
    return { classification: "owned", mode: "plain", record: plainRecord };
  }
  if (ownerRecordMatchesCommand(remoteRecord, command)) {
    return { classification: "owned", mode: "remote", record: remoteRecord };
  }

  const parsed = parseStrictClaudeStatuslineCommand(command, options.expectedScript, options.platform);
  if (parsed) {
    if (parsed.remote || parsed.suffix === "remote-chain") {
      if (remoteRecordError) {
        const legacyOriginal = readChainSidecarStatusLine(options.remoteSidecarPath);
        if (parsed.suffix === "remote-chain" && legacyOriginal) {
          return { classification: "owned", mode: "remote", legacy: true, legacyOriginal, parsed };
        }
        return { classification: "ambiguous", mode: "remote", error: remoteRecordError };
      }
      if (parsed.suffix === "remote-chain" && !remoteRecord) {
        const legacyOriginal = readChainSidecarStatusLine(options.remoteSidecarPath);
        if (!legacyOriginal) return { classification: "ambiguous", mode: "remote" };
        return { classification: "owned", mode: "remote", legacy: true, legacyOriginal, parsed };
      }
      if (remoteRecord) return { classification: "ambiguous", mode: "remote" };
      return { classification: "owned", mode: "remote", legacy: !remoteRecord, parsed };
    }
    if (plainRecordError) return { classification: "ambiguous", mode: "plain", error: plainRecordError };
    if (plainRecord) return { classification: "ambiguous", mode: "plain" };
    return { classification: "owned", mode: "plain", legacy: !plainRecord, parsed };
  }
  return {
    classification: hasExactStatuslineMarker(command) ? "ambiguous" : "foreign",
    mode: null,
  };
}

// Claude Code's statusLine setting is a single slot, not an event-keyed map
// like hooks - only one script can render the visible status line at a
// time. Default registration only takes an empty/owned slot. Explicit local
// coexistence preserves the original before wrapping it; remote --chain keeps
// its separate historical contract.
function registerClaudeStatusline(options = {}) {
  // Lazy load so a partial manual copy can still run the CLI dependency
  // preflight and report every missing runtime file before any mutation.
  const {
    LOCAL_CHAIN_FLAG, LOCAL_CHAIN_FILE, statuslineFingerprint,
    createLocalChainRecord, requireOwnedLocalChain, resolveLocalChainShell,
    PLAIN_OWNER_FILE, PLAIN_OWNER, REMOTE_CHAIN_FILE, REMOTE_CHAIN_OWNER,
    readStatuslineOwnerRecord, writeStatuslineOwnerRecord, ownerRecordMatchesCommand,
  } = require("./claude-statusline-local-chain");
  const homeDir = options.homeDir || os.homedir();
  const settingsPath = resolveClaudeSettingsPath({ ...options, homeDir });
  const writePath = resolveWritePath(settingsPath);
  const remoteIdentity = requireRemoteInstallIdentity(options);

  if (!options.settingsPath && !hasClaudeSettingsDir(homeDir, options)) {
    if (!options.silent) console.log("Clawd: Claude Code settings not found - skipping statusline registration");
    return { installed: false, changed: false, skippedExisting: false, settingsPath };
  }

  // Materialize and byte-verify the persistent generation BEFORE reading or
  // writing any sidecar / settings.statusLine. A failed materialization must
  // leave the recovery record and both files exactly as they were.
  const resolvedHookPaths = resolveClaudeHookPaths({ ...options, homeDir }, { materialize: true });
  if (!resolvedHookPaths.ok) {
    return {
      installed: false,
      changed: false,
      skippedExisting: false,
      settingsPath,
      error: {
        reason: resolvedHookPaths.reason,
        message: resolvedHookPaths.message
          || "Failed to prepare the Claude statusline runtime",
      },
    };
  }
  const targetStatuslineScript = resolvedHookPaths.target.statusline;
  // Direct mode does not materialize, so validate the statusline source and
  // its static relative closure here before touching any settings or sidecar.
  // Without this, a partial hand copy could register a command that dies at
  // require time. (AppImage mode already byte-validated the closure via
  // materialize.)
  if (resolvedHookPaths.mode === "direct") {
    const missingDeps = findMissingHookDependencies(["claude-statusline.js"], {
      hooksDir: path.dirname(targetStatuslineScript),
    });
    if (missingDeps.length) {
      return {
        installed: false,
        changed: false,
        skippedExisting: false,
        settingsPath,
        error: {
          reason: "source-script-missing",
          message: formatMissingHookDependencies(missingDeps),
        },
      };
    }
  }

  let settings = {};
  try {
    settings = readJsonFile(settingsPath);
  } catch (err) {
    if (err.code !== "ENOENT") throw new Error(`Failed to read settings.json: ${err.message}`);
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) settings = {};

  const existing = settings.statusLine && typeof settings.statusLine === "object" ? settings.statusLine : null;
  const platform = options.platform || process.platform;
  const sidecarDir = options.settingsPath
    ? path.join(path.dirname(settingsPath), "hooks")
    : resolveClaudeHooksDir({ ...options, homeDir });
  const localSidecar = options.localChainSidecarPath || path.join(sidecarDir, LOCAL_CHAIN_FILE);
  const sidecarPath = options.chainSidecarPath || path.join(sidecarDir, REMOTE_CHAIN_FILE);
  const plainOwnerPath = options.plainOwnerPath || path.join(sidecarDir, PLAIN_OWNER_FILE);
  const ownership = classifyManagedClaudeStatusline(existing, {
    expectedScript: targetStatuslineScript,
    platform,
    localSidecar,
    remoteSidecarPath: sidecarPath,
    plainOwnerPath,
  });
  if (ownership.classification === "ambiguous") {
    throw new Error(`Claude statusline ownership is ambiguous; kept unchanged${ownership.error ? `: ${ownership.error.message}` : ""}`);
  }
  const existingIsOurs = ownership.classification === "owned";

  const requestedMode = options.remote === true ? "remote" : "plain";
  if (existingIsOurs && (ownership.mode === "plain" || ownership.mode === "remote")
    && ownership.mode !== requestedMode) {
    throw new Error(`Claude statusline is owned by ${ownership.mode} mode; unregister that mode before registering ${requestedMode} mode. Recovery records kept unchanged`);
  }

  if (options.expectedStatuslineFingerprint !== undefined
    && statuslineFingerprint(existing) !== options.expectedStatuslineFingerprint) {
    throw new Error("Claude statusline changed while confirmation was open; please try again");
  }
  const localChainRequested = options.remote !== true && options.chainExisting === true;
  if (existingIsOurs && ownership.mode === "local") {
    // Local consent cannot authorize a remote routing/mode migration. Refuse
    // before refreshing either file; the two recovery records are independent.
    if (options.remote === true) {
      throw new Error("Claude statusline uses local coexistence; turn off local Claude usage collection on this account before remote deployment. "
        + `Statusline and local recovery record kept unchanged: ${localSidecar}`);
    }
    const record = requireOwnedLocalChain(localSidecar, existing);
    if (record.platform !== platform) throw new Error("Statusline recovery record belongs to a different platform");
    const script = targetStatuslineScript;
    const nodeBin = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
    const command = `${buildPortableStatuslineCommand(nodeBin || "node", script, { platform })} ${LOCAL_CHAIN_FLAG} ${record.id}`;
    if (command === existing.command) {
      return { installed: true, changed: false, skippedExisting: false, chained: true, localChained: true, settingsPath };
    }
    // Keep both exact owned commands during a path refresh so a failed/crashed
    // settings write can still be restored. The original is never rewritten.
    writeTextAtomic(localSidecar, JSON.stringify({ ...record, managedCommand: command, previousManagedCommand: existing.command }),
      { encoding: "utf8", mode: 0o600 });
    const current = readJsonFile(settingsPath);
    if (statuslineFingerprint(current.statusLine || null) !== statuslineFingerprint(existing)) {
      throw new Error("Claude statusline changed during refresh; recovery record was retained");
    }
    current.statusLine = { ...existing, command };
    writeLocalStatuslineSettings(writePath, current, options);
    return { installed: true, changed: true, skippedExisting: false, chained: true, localChained: true, settingsPath };
  }
  if (localChainRequested && existing && !existingIsOurs) {
    if (existing.type !== "command" || typeof existing.command !== "string" || !existing.command.trim()) {
      throw new Error("The existing Claude statusline is not a supported command; kept unchanged");
    }
    const platform = options.platform || process.platform;
    resolveLocalChainShell({ platform, env: options.env, exists: options.shellExists });
    const script = targetStatuslineScript;
    const nodeBin = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
    const portable = buildPortableStatuslineCommand(nodeBin || "node", script, { platform });
    const record = createLocalChainRecord(localSidecar, existing, portable, platform);
    // Re-read after saving recovery evidence, preserving unrelated changes
    // made by another application while we prepared this registration.
    const current = readJsonFile(settingsPath);
    if (statuslineFingerprint(current.statusLine || null) !== statuslineFingerprint(existing)) {
      throw new Error("Claude statusline changed during registration; recovery record was retained");
    }
    current.statusLine = { ...existing, command: record.managedCommand };
    writeLocalStatuslineSettings(writePath, current, options);
    return { installed: true, changed: true, skippedExisting: false, chained: true, localChained: true, settingsPath };
  }

  // Legacy remote chain is independent from the consent-bound local record.
  const chainRequested = options.remote === true && options.chainExisting === true;
  const chainExplicitlyDisabled = options.remote === true && options.chainExisting === false;
  if (existing && !existingIsOurs && !chainRequested) {
    if (!options.silent) console.log(`Clawd: existing Claude Code statusline detected at ${settingsPath} - leaving it in place`);
    return {
      installed: true, changed: false, skippedExisting: true, settingsPath,
      statuslineFingerprint: statuslineFingerprint(existing),
    };
  }

  let chainActive = false;
  let chainedOriginal = null;
  if (existing && !existingIsOurs && chainRequested) {
    chainedOriginal = existing;
    chainActive = true;
  } else if (existingIsOurs && ownership.mode === "remote" && existing.command.endsWith(` ${STATUSLINE_CHAIN_FLAG}`)) {
    chainedOriginal = ownership.record ? ownership.record.statusLine : ownership.legacyOriginal;
    if (chainExplicitlyDisabled && chainedOriginal) {
      // A profile toggle is an explicit deploy target, not an omitted repair
      // preference. Turning it off restores the third-party slot and consumes
      // the sidecar exactly like unregister; otherwise Settings would mark an
      // off profile deployed while the remote silently kept --chain.
      const current = readJsonFile(settingsPath);
      if (statuslineFingerprint(current.statusLine || null) !== statuslineFingerprint(existing)) {
        throw new Error("Claude statusline changed during remote restoration; recovery record was retained");
      }
      current.statusLine = chainedOriginal;
      writeJsonAtomic(writePath, current);
      try { fs.unlinkSync(sidecarPath); } catch {}
      if (!options.silent) console.log(`Clawd: restored existing Claude Code statusline at ${settingsPath}`);
      return {
        installed: true,
        changed: true,
        skippedExisting: true,
        chained: false,
        restoredChained: true,
        settingsPath,
      };
    }
    // An omitted preference is a repair/startup refresh: preserve an existing
    // chain and never rewrite its sidecar. If the sidecar vanished (or an
    // explicit disable cannot restore it), degrade to our plain mode.
    if (chainExplicitlyDisabled) {
      try { fs.unlinkSync(sidecarPath); } catch {}
    }
    chainActive = !chainExplicitlyDisabled && !!chainedOriginal;
  }

  const scriptPath = targetStatuslineScript;
  const nodeBin = (options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin()) || "node";
  // No `& "..."` here: statusLine has no shell field, and on Windows Claude
  // Code runs this through Git Bash when Git is installed - the PowerShell
  // call-operator form is a bash syntax error and the statusline dies
  // silently. See buildPortableStatuslineCommand.
  //
  // Remote installs (install.js --remote, run ON the remote from
  // ~/.claude/hooks/) target POSIX shells only (deploy aborts on cmd.exe),
  // so the bash-style env prefix is safe - same convention as
  // buildCommandHookSpec's remote hook form. CLAWD_REMOTE=1 is what makes
  // claude-statusline.js stamp body.host so its best-effort quota POSTs ride
  // the reverse tunnel onto the right sessions.
  // nodeBin needs no remote resolution here: this code already runs under
  // the remote's own node, so resolveNodeBin() IS the remote path.
  const portableCommand = buildPortableStatuslineCommand(nodeBin, scriptPath, { platform });
  const prefixed = options.remote === true
    ? `${buildRemoteHookEnvPrefix({
        ...options,
        remoteIdentityPath: options.remoteIdentityPath || (remoteIdentity && remoteIdentity.filePath),
      })} ${portableCommand}`
    : portableCommand;
  const command = chainActive ? `${prefixed} ${STATUSLINE_CHAIN_FLAG}` : prefixed;
  const desired = { type: "command", command, padding: 0 };

  const ownerPath = options.remote === true ? sidecarPath : plainOwnerPath;
  const ownerLiteral = options.remote === true ? REMOTE_CHAIN_OWNER : PLAIN_OWNER;
  let priorOwner = null;
  try {
    priorOwner = readStatuslineOwnerRecord(ownerPath, ownerLiteral);
  } catch (error) {
    // A legacy remote chain sidecar contains only the original statusLine.
    // It is upgraded in place only after the strict current command above was
    // recognized; any other malformed/foreign record remains a hard conflict.
    if (!(options.remote === true && ownership.legacy === true && chainedOriginal)) throw error;
  }
  if (priorOwner && existingIsOurs && ownership.mode === (options.remote === true ? "remote" : "plain")
    && !ownerRecordMatchesCommand(priorOwner, existing.command)) {
    throw new Error(`Claude statusline ownership record does not match; kept unchanged: ${ownerPath}`);
  }
  if (priorOwner && options.remote === true && chainActive
    && statuslineFingerprint(priorOwner.statusLine || null) !== statuslineFingerprint(chainedOriginal || null)) {
    throw new Error(`Claude statusline recovery record does not match; kept unchanged: ${ownerPath}`);
  }
  const ownerRecord = {
    ...(priorOwner || {}),
    owner: ownerLiteral,
    version: 1,
    ...(options.remote === true ? { statusLine: chainActive ? chainedOriginal : (priorOwner && priorOwner.statusLine) || null } : {}),
    managedCommand: command,
    ...(existingIsOurs && existing.command !== command ? { previousManagedCommand: existing.command } : {}),
  };
  const ownerBefore = priorOwner ? statuslineFingerprint(priorOwner) : null;
  writeStatuslineOwnerRecord(ownerPath, ownerRecord);
  const ownershipChanged = ownerBefore !== statuslineFingerprint(ownerRecord);

  const changed = !existing || JSON.stringify(existing) !== JSON.stringify(desired);
  if (changed) {
    const current = fs.existsSync(settingsPath) ? readJsonFile(settingsPath) : {};
    if (statuslineFingerprint(current.statusLine || null) !== statuslineFingerprint(existing)) {
      throw new Error("Claude statusline changed during registration; ownership record was retained");
    }
    current.statusLine = desired;
    if (fs.existsSync(writePath)) writeLocalStatuslineSettings(writePath, current, options);
    else writeJsonAtomic(writePath, current);
    // Consume only a record that classified the just-replaced slot. Stale or
    // foreign evidence is never deleted merely because the target mode changed.
    const obsoleteOwnerPath = options.remote === true ? plainOwnerPath : sidecarPath;
    if (existingIsOurs && ownership.mode !== (options.remote === true ? "remote" : "plain") && ownership.record) {
      try { fs.unlinkSync(obsoleteOwnerPath); } catch {}
    }
  }

  if (!options.silent) {
    console.log(`Clawd Claude Code statusline -> ${settingsPath}${changed ? " (updated)" : " (already up to date)"}${chainActive ? " (chained)" : ""}`);
  }

  return { installed: true, changed: changed || ownershipChanged, skippedExisting: false, chained: chainActive, settingsPath };
}

function unregisterClaudeStatusline(options = {}) {
  const {
    LOCAL_CHAIN_FLAG, LOCAL_CHAIN_FILE, statuslineFingerprint, requireOwnedLocalChain,
    PLAIN_OWNER_FILE, REMOTE_CHAIN_FILE,
  } = require("./claude-statusline-local-chain");
  const homeDir = options.homeDir || os.homedir();
  const settingsPath = resolveClaudeSettingsPath({ ...options, homeDir });
  const writePath = resolveWritePath(settingsPath);
  let settings = {};
  try {
    settings = readJsonFile(settingsPath);
  } catch (err) {
    if (err.code !== "ENOENT") throw new Error(`Failed to read settings.json: ${err.message}`);
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) settings = {};

  const existing = settings.statusLine && typeof settings.statusLine === "object" ? settings.statusLine : null;
  const platform = options.platform || process.platform;
  const resolved = resolveClaudeHookPathsReadOnly({ ...options, homeDir });
  const expectedScript = resolved && resolved.ok === true
    ? resolved.target.statusline
    : getClaudeStatuslineScriptPath();
  const sidecarDir = options.settingsPath
    ? path.join(path.dirname(settingsPath), "hooks")
    : resolveClaudeHooksDir({ ...options, homeDir });
  const localSidecar = options.localChainSidecarPath || path.join(sidecarDir, LOCAL_CHAIN_FILE);
  const sidecarPath = options.chainSidecarPath || path.join(sidecarDir, REMOTE_CHAIN_FILE);
  const plainOwnerPath = options.plainOwnerPath || path.join(sidecarDir, PLAIN_OWNER_FILE);
  const ownership = classifyManagedClaudeStatusline(existing, {
    expectedScript,
    platform,
    localSidecar,
    remoteSidecarPath: sidecarPath,
    plainOwnerPath,
  });

  if (ownership.classification !== "owned") {
    if (ownership.classification === "ambiguous") {
      throw new Error(`Claude statusline ownership is ambiguous; kept unchanged${ownership.error ? `: ${ownership.error.message}` : ""}`);
    }
    return { installed: !!existing, removed: 0, changed: false, settingsPath };
  }
  if (ownership.legacy === true && !(ownership.parsed && ownership.parsed.legacyAppImage === true)) {
    throw new Error("Claude statusline ownership evidence is missing or legacy; run registration repair before uninstall");
  }

  if (ownership.mode === "local" && existing.command.includes(` ${LOCAL_CHAIN_FLAG} `)) {
    const record = requireOwnedLocalChain(localSidecar, existing);
    const current = readJsonFile(settingsPath);
    if (statuslineFingerprint(current.statusLine || null) !== statuslineFingerprint(existing)) {
      throw new Error("Claude statusline changed during restoration; recovery record was retained");
    }
    current.statusLine = record.statusLine;
    const backupPath = writeLocalStatuslineSettings(writePath, current, options);
    // Never delete recovery evidence before the original settings are saved.
    let recoveryRecordRetained = false;
    try {
      if (statuslineFingerprint(readJsonFile(localSidecar)) !== statuslineFingerprint(record)) {
        recoveryRecordRetained = true;
      } else fs.unlinkSync(localSidecar);
    } catch { recoveryRecordRetained = true; }
    return { installed: true, removed: 1, changed: true, restoredChained: true, recoveryRecordRetained, settingsPath, backupPath };
  }

  // A chained slot restores the user's original statusLine object from the
  // sidecar instead of leaving the slot empty; the sidecar is consumed
  // either way so no stale copy outlives the registration it served.
  const chained = ownership.mode === "remote"
    ? ((ownership.record && ownership.record.statusLine) || ownership.legacyOriginal || null)
    : null;
  const current = readJsonFile(settingsPath);
  if (statuslineFingerprint(current.statusLine || null) !== statuslineFingerprint(existing)) {
    throw new Error("Claude statusline changed during removal; ownership record was retained");
  }
  if (chained) current.statusLine = chained;
  else delete current.statusLine;
  const backupPath = writeJsonAtomicWithBackup(writePath, current, options);
  const ownerPath = ownership.mode === "remote" ? sidecarPath : plainOwnerPath;
  try { fs.unlinkSync(ownerPath); } catch {}
  if (!options.silent) {
    console.log(`Clawd Claude Code statusline ${chained ? "restored chained original" : "removed"} -> ${settingsPath}`);
  }
  const result = { installed: true, removed: 1, changed: true, settingsPath };
  if (chained) result.restoredChained = true;
  if (options.backup === true) result.backupPath = backupPath;
  return result;
}

function parseClaudeInstallCliOptions(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  const remote = args.includes("--remote");
  return {
    remote,
    chainExisting: args.includes("--chain-existing"),
    // Remote deploy is itself an explicit quota-collection action. Locally,
    // installing/reinstalling command hooks must not silently opt the user into
    // the visible single-slot statusLine; Settings owns that preference unless
    // the debug CLI receives an explicit --statusline.
    installStatusline: remote || args.includes("--statusline"),
  };
}

// Export for use by main.js
module.exports = {
  STATUSLINE_MARKER,
  CLAUDE_CORE_HOOK_EVENTS: Object.freeze([...CORE_HOOKS]),
  getClaudeHookScriptPath,
  getClaudeAutoStartScriptPath,
  getClaudeStatuslineScriptPath,
  claudeSourceHookPaths,
  evaluateClaudeAppImage,
  checkClaudeMaterializationFs,
  preflightClaudeRuntime,
  resolveClaudeHookPaths,
  resolveClaudeHookPathsReadOnly,
  resolveClaudeHome,
  resolveClaudeSettingsPath,
  resolveClaudeHooksDir,
  registerHooks,
  registerHooksAsync,
  unregisterHooks,
  unregisterHooksAsync,
  unregisterAutoStart,
  isAutoStartRegistered,
  registerClaudeStatusline,
  unregisterClaudeStatusline,
  __test: {
    classifyManagedClaudeStatusline,
    findMissingHookDependencies,
    formatMissingHookDependencies,
    parseClaudeVersion,
    getWindowsClaudePathSuffixes,
    getClaudePathCandidates,
    getClaudePathCandidatesAsync,
    getClaudePackageJsonCandidates,
    getClaudePackageJsonCandidatesAsync,
    getClaudeVersionFromPackageJson,
    getClaudeVersionFromPackageJsonAsync,
    readClaudeVersionFallback,
    readClaudeVersionFallbackAsync,
    getClaudeVersion,
    getClaudeVersionAsync,
    isClawdPermissionHook,
    isClawdPermissionUrl,
    removeMatchingHttpHooks,
    versionLessThan,
    removeMatchingCommandHooks,
    reconcileVersionedHooks,
    shouldReconcileVersionedHooks,
    buildCommandHookSpec,
    buildRemoteHookEnvPrefix,
    isSshSecureRemoteInstall,
    parseClaudeInstallCliOptions,
  },
};

// Lazy getters preserve the public API without freezing HOME or
// CLAUDE_CONFIG_DIR when this remote-capable module is loaded.
Object.defineProperty(module.exports, "DEFAULT_PARENT_DIR", {
  enumerable: true,
  get() { return resolveClaudeHome(); },
});
Object.defineProperty(module.exports, "DEFAULT_CONFIG_PATH", {
  enumerable: true,
  get() { return resolveClaudeSettingsPath(); },
});

// CLI: run directly with `node hooks/install.js [--remote] [--statusline]`
if (require.main === module) {
  try {
    const { remote, chainExisting, installStatusline } =
      parseClaudeInstallCliOptions(process.argv.slice(2));
    // Check only what this invocation requests. auto-start.js is opt-in and
    // is not registered by this CLI, so it must not become a prerequisite.
    const entryPoints = ["clawd-hook.js"];
    if (installStatusline) entryPoints.push("claude-statusline.js");
    const missingDeps = findMissingHookDependencies(entryPoints);
    if (missingDeps.length) {
      console.error(formatMissingHookDependencies(missingDeps));
      process.exitCode = 1;
    } else {
      registerHooks({ remote });
      if (installStatusline) {
        // Remote installs also register statusline. Local commands opt in
        // only with --statusline and otherwise preserve the visible slot.
        registerClaudeStatusline({ remote, chainExisting });
      }
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
