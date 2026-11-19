const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const {
  CODEX_WINDOWS_STABLE_ARG,
  CODEX_WSL_INTEROP_ARG,
  resolveNodeBin,
} = require("./server-config");
const {
  collectRelativeHookClosure,
  materializeAppImageHookScript,
} = require("./appimage-hook-materializer");
const {
  readJsonFile,
  writeJsonAtomic,
  writeJsonAtomicWithBackup,
  writeTextAtomic,
  asarUnpackedPath,
  commandMatchesMarker,
  extractExistingNodeBin,
  formatNodeHookCommand,
  normalizeHookScriptPath,
  parsePowerShellEnvCommand,
  quotePowerShellSingleArg,
  remoteHookScriptKey,
  unescapePowerShellSingleQuoted,
} = require("./json-utils");

function resolveCodexHome(options = {}) {
  if (typeof options.codexDir === "string" && options.codexDir.trim()) return options.codexDir.trim();
  const env = options.env || process.env;
  if (typeof env.CODEX_HOME === "string" && env.CODEX_HOME.trim()) return env.CODEX_HOME.trim();
  return path.join(options.homeDir || os.homedir(), ".codex");
}

const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "Stop",
  "Interrupt",
  "SessionEnd",
];
const CODEX_SSH_REMOTE_ARG = "--clawd-ssh-remote";
const CODEX_WINDOWS_REMOTE_OWNERSHIP_CONFLICT = "codex-windows-remote-ownership-conflict";
const CODEX_WINDOWS_REMOTE_UNSAFE_PATH = "codex-windows-remote-unsafe-path";
const CODEX_WINDOWS_REMOTE_HOOKS_DISABLED = "codex-windows-remote-hooks-disabled";
const CODEX_HOOKS_FEATURE_KEY = "hooks";
const LEGACY_CODEX_HOOKS_FEATURE_KEY = "codex_hooks";
const CODEX_STABLE_HOOK_DIRNAME = "clawd-hooks";
const CODEX_STABLE_LAUNCHER_VERSION = 3;
const CODEX_STABLE_LAUNCHER_SIGNATURE = "clawd-codex-stable-launcher-v3";
const CODEX_STABLE_WINDOWS_RUN_SIGNATURE = "clawd-codex-stable-windows-run-v1";
const LEGACY_CODEX_STABLE_LAUNCHER_SIGNATURES = new Set([
  "clawd-codex-stable-launcher-v2",
]);
const CODEX_STABLE_GENERATION_PREFIX = "clawd-generation:";

function stableCodexHookPaths(codexDir, options = {}) {
  const stableDir = options.stableHookDir || path.join(codexDir, CODEX_STABLE_HOOK_DIRNAME);
  const platform = options.platform || process.platform;
  const legacyWindowsLauncherPath = path.join(stableDir, "codex-hook.js.ps1");
  const windowsRunPath = path.join(stableDir, "codex-hook.js.windows.run");
  const posixLauncherPath = path.join(stableDir, "codex-hook.js.sh");
  const windowsManifestPath = path.join(stableDir, "codex-hook.windows.json");
  const posixManifestPath = path.join(stableDir, "codex-hook.posix.json");
  return {
    stableDir,
    legacyWindowsLauncherPath,
    windowsRunPath,
    posixLauncherPath,
    windowsManifestPath,
    posixManifestPath,
    // Windows stable entries use a direct call-operator command; the data
    // sidecar is read by codex-hook.js itself (Defender ML false positive on
    // the old inline dispatcher, clawd-on-desk#986). POSIX still needs a
    // tiny /bin/sh launcher.
    launcherPath: platform === "win32" ? windowsRunPath : posixLauncherPath,
    manifestPath: platform === "win32" ? windowsManifestPath : posixManifestPath,
  };
}

function resolveStableCodexDir(options = {}) {
  if (typeof options.codexDir === "string" && options.codexDir.trim()) {
    return options.codexDir.trim();
  }
  // Cleanup callers often pin hooksPath for a different user home. Follow
  // that explicit target instead of an inherited CODEX_HOME from this process.
  if (typeof options.hooksPath === "string" && options.hooksPath.trim()) {
    return path.dirname(path.resolve(options.hooksPath.trim()));
  }
  return resolveCodexHome(options);
}

function quotePosixLiteral(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function stableLauncherGeneration(source) {
  return crypto.createHash("sha256").update(source).digest("hex");
}

function inspectStableLauncherSource(source, platform) {
  const normalized = String(source || "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const signatureIndex = platform === "win32" ? 0 : 1;
  const generationIndex = signatureIndex + 1;
  const expectedSignature = `# ${CODEX_STABLE_LAUNCHER_SIGNATURE}`;
  if (lines[signatureIndex] !== expectedSignature) {
    return { ok: false, issue: "stable-launcher-invalid" };
  }
  const generationLine = lines[generationIndex] || "";
  const expectedPrefix = `# ${CODEX_STABLE_GENERATION_PREFIX}`;
  if (!generationLine.startsWith(expectedPrefix)) {
    return { ok: false, issue: "stable-launcher-invalid" };
  }
  const declaredGeneration = generationLine.slice(expectedPrefix.length);
  const body = lines.slice(generationIndex + 1).join("\n");
  const actualGeneration = stableLauncherGeneration(body);
  if (!/^[a-f0-9]{64}$/.test(declaredGeneration) || declaredGeneration !== actualGeneration) {
    return { ok: false, issue: "stable-launcher-stale" };
  }
  return { ok: true, generation: actualGeneration };
}

function buildStableCodexHookLauncherSource(options = {}) {
  const platform = options.platform || process.platform;
  const nodeBin = String(options.nodeBin || "");
  const target = String(options.target || "");
  const args = Array.isArray(options.args) ? options.args.map(String) : [];
  const envEntries = filterCommandEnvEntries(options.env);

  if (platform === "win32") {
    throw new Error("Windows stable Codex hooks use a data-sidecar dispatcher, not a .ps1 launcher");
  }

  const body = [
    ...envEntries.map(([key, value]) => `export ${key}=${quotePosixLiteral(value)}`),
    `exec ${[nodeBin, target, ...args].map(quotePosixLiteral).join(" ")} "$@"`,
    "",
  ].join("\n");
  const generation = stableLauncherGeneration(body);
  return {
    generation,
    source: [
      "#!/bin/sh",
      `# ${CODEX_STABLE_LAUNCHER_SIGNATURE}`,
      `# ${CODEX_STABLE_GENERATION_PREFIX}${generation}`,
      body,
    ].join("\n"),
  };
}

function writeTextIfChanged(filePath, content, mode = 0o600) {
  try {
    if (fs.readFileSync(filePath, "utf8") === content) {
      if (process.platform !== "win32") {
        const currentMode = fs.statSync(filePath).mode & 0o777;
        if (currentMode !== mode) fs.chmodSync(filePath, mode);
      }
      return false;
    }
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }
  writeTextAtomic(filePath, content, { encoding: "utf8", mode });
  return true;
}

function stableManifestBinding(record) {
  return crypto.createHash("sha256").update(JSON.stringify({
    managedBy: record.managedBy,
    version: record.version,
    platform: record.platform,
    mode: record.mode,
    nodeBin: record.nodeBin,
    target: record.target,
    args: record.args,
    env: record.env,
    generation: record.generation,
  })).digest("hex");
}

function legacyStableManifestBinding(record) {
  return crypto.createHash("sha256").update(JSON.stringify({
    managedBy: record.managedBy,
    version: record.version,
    platform: record.platform,
    mode: record.mode,
    nodeBin: record.nodeBin,
    target: record.target,
    generation: record.generation,
  })).digest("hex");
}

function isStableManifestEnv(value) {
  return !!(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.entries(value).every(([key, entry]) => (
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof entry === "string"
    ))
  );
}

function readStableCodexHookManifest(manifestPath, options = {}) {
  const fsApi = options.fs || fs;
  try {
    const record = JSON.parse(fsApi.readFileSync(manifestPath, "utf8"));
    if (
      !record
      || record.managedBy !== "clawd-on-desk"
      || record.version !== CODEX_STABLE_LAUNCHER_VERSION
      || !["win32", "posix"].includes(record.platform)
      || !["native", "windows-interop"].includes(record.mode)
      || (record.platform === "win32" && record.mode !== "native")
      || typeof record.nodeBin !== "string"
      || !record.nodeBin.trim()
      || typeof record.target !== "string"
      || !record.target.trim()
      || !Array.isArray(record.args)
      || !record.args.every((entry) => typeof entry === "string")
      || !isStableManifestEnv(record.env)
      || !/^[a-f0-9]{64}$/.test(String(record.generation || ""))
      || !/^[a-f0-9]{64}$/.test(String(record.binding || ""))
      || record.binding !== stableManifestBinding(record)
    ) return { ok: false, issue: "stable-manifest-invalid", record: null };
    return { ok: true, record };
  } catch (err) {
    return {
      ok: false,
      issue: err && err.code === "ENOENT" ? "stable-manifest-missing" : "stable-manifest-invalid",
      record: null,
    };
  }
}

function readLegacyStableCodexHookManifest(manifestPath, options = {}) {
  const fsApi = options.fs || fs;
  try {
    const record = JSON.parse(fsApi.readFileSync(manifestPath, "utf8"));
    if (
      !record
      || record.managedBy !== "clawd-on-desk"
      || record.version !== 2
      || !["win32", "posix"].includes(record.platform)
      || !["native", "windows-interop"].includes(record.mode)
      || (record.platform === "win32" && record.mode !== "native")
      || typeof record.nodeBin !== "string"
      || !record.nodeBin.trim()
      || typeof record.target !== "string"
      || !record.target.trim()
      || !/^[a-f0-9]{64}$/.test(String(record.generation || ""))
      || !/^[a-f0-9]{64}$/.test(String(record.binding || ""))
      || record.binding !== legacyStableManifestBinding(record)
    ) return { ok: false, record: null };
    return { ok: true, record };
  } catch {
    return { ok: false, record: null };
  }
}

function readExistingStableCodexNodeBin(codexDir, platform, options = {}) {
  const paths = stableCodexHookPaths(codexDir, { ...options, platform });
  const current = readStableCodexHookManifest(paths.manifestPath);
  const manifest = current.ok ? current : readLegacyStableCodexHookManifest(paths.manifestPath);
  const expectedPlatform = platform === "win32" ? "win32" : "posix";
  if (
    !manifest.ok
    || manifest.record.platform !== expectedPlatform
    || manifest.record.mode !== "native"
  ) return null;
  const nodeBin = manifest.record.nodeBin.trim();
  return nodeBin || null;
}

function writeStableCodexHookLauncher(launcherPath, manifestPath, spec) {
  const built = buildStableCodexHookLauncherSource(spec);
  const args = Array.isArray(spec.args) ? spec.args.map(String) : [];
  const env = Object.fromEntries(filterCommandEnvEntries(spec.env));
  const manifestBase = {
    managedBy: "clawd-on-desk",
    version: CODEX_STABLE_LAUNCHER_VERSION,
    platform: spec.platform === "win32" ? "win32" : "posix",
    mode: spec.mode,
    nodeBin: spec.healthNodeBin || spec.nodeBin,
    target: spec.healthTarget || spec.target,
    args,
    env,
    generation: built.generation,
  };
  const manifest = { ...manifestBase, binding: stableManifestBinding(manifestBase) };
  const launcherUpdated = writeTextIfChanged(launcherPath, built.source, 0o700);
  const manifestUpdated = writeTextIfChanged(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    0o600
  );
  return { launcherPath, manifestPath, launcherUpdated, manifestUpdated, manifest };
}

function encodeStableWindowsRunValue(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

function buildStableWindowsRunSource(spec) {
  return [
    CODEX_STABLE_WINDOWS_RUN_SIGNATURE,
    encodeStableWindowsRunValue(spec.nodeBin),
    encodeStableWindowsRunValue(spec.target),
    ...filterCommandEnvEntries(spec.env).map(([key, value]) => (
      `E${encodeStableWindowsRunValue(key)}.${encodeStableWindowsRunValue(value)}`
    )),
    "",
  ].join("\n");
}

function inspectStableWindowsRunSource(source) {
  const normalized = String(source || "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== CODEX_STABLE_WINDOWS_RUN_SIGNATURE || !lines[1] || !lines[2]) {
    return { ok: false, issue: "stable-launcher-invalid" };
  }
  try {
    const decode = (value) => Buffer.from(value, "base64").toString("utf8");
    const nodeBin = decode(lines[1]);
    const target = decode(lines[2]);
    if (!nodeBin || !target) return { ok: false, issue: "stable-launcher-invalid" };
    const env = {};
    for (const line of lines.slice(3).filter(Boolean)) {
      const separator = line.indexOf(".");
      if (!line.startsWith("E") || separator < 2) {
        return { ok: false, issue: "stable-launcher-invalid" };
      }
      const key = decode(line.slice(1, separator));
      const value = decode(line.slice(separator + 1));
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        return { ok: false, issue: "stable-launcher-invalid" };
      }
      env[key] = value;
    }
    return {
      ok: true,
      generation: stableLauncherGeneration(normalized),
      nodeBin,
      target,
      env,
    };
  } catch {
    return { ok: false, issue: "stable-launcher-invalid" };
  }
}

function writeStableCodexHookWindowsArtifacts(runPath, manifestPath, spec) {
  const runSource = buildStableWindowsRunSource(spec);
  const manifestBase = {
    managedBy: "clawd-on-desk",
    version: CODEX_STABLE_LAUNCHER_VERSION,
    platform: "win32",
    mode: "native",
    nodeBin: String(spec.nodeBin),
    target: String(spec.target),
    args: Array.isArray(spec.args) ? spec.args.map(String) : [],
    env: Object.fromEntries(filterCommandEnvEntries(spec.env)),
    generation: stableLauncherGeneration(runSource),
  };
  const manifest = { ...manifestBase, binding: stableManifestBinding(manifestBase) };
  const launcherUpdated = writeTextIfChanged(runPath, runSource, 0o600);
  const manifestUpdated = writeTextIfChanged(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    0o600
  );
  return {
    launcherPath: runPath,
    manifestPath,
    launcherUpdated,
    manifestUpdated,
    manifest,
  };
}

function removeOwnedLegacyWindowsLauncher(launcherPath) {
  try {
    const source = fs.readFileSync(launcherPath, "utf8").replace(/^\uFEFF/, "");
    const firstLine = source.replace(/\r\n/g, "\n").split("\n")[0];
    const signature = firstLine.startsWith("# ") ? firstLine.slice(2) : "";
    if (
      signature !== CODEX_STABLE_LAUNCHER_SIGNATURE
      && !LEGACY_CODEX_STABLE_LAUNCHER_SIGNATURES.has(signature)
    ) return false;
    fs.unlinkSync(launcherPath);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

function materializeStableCodexHookLauncher(entryPath, options = {}) {
  const codexDir = resolveStableCodexDir(options);
  const platform = options.platform || process.platform;
  const paths = stableCodexHookPaths(codexDir, { ...options, platform });
  const target = path.resolve(entryPath);
  const nodeBin = String(options.nodeBin || "").trim();
  if (!fs.existsSync(target)) throw new Error(`Codex hook target does not exist: ${target}`);
  if (!nodeBin) throw new Error("Stable Codex hook launcher requires a Node executable");
  fs.mkdirSync(paths.stableDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(paths.stableDir, 0o700);

  if (platform === "win32") {
    const windows = writeStableCodexHookWindowsArtifacts(
      paths.windowsRunPath,
      paths.windowsManifestPath,
      {
      nodeBin,
      target,
      env: options.env,
      }
    );
    removeOwnedLegacyWindowsLauncher(paths.legacyWindowsLauncherPath);
    const existingPosix = readStableCodexHookManifest(paths.posixManifestPath);
    const legacyPosix = existingPosix.ok
      ? { ok: false, record: null }
      : readLegacyStableCodexHookManifest(paths.posixManifestPath);
    let posix = null;
    let posixPreserved = false;
    if (
      (existingPosix.ok && existingPosix.record.mode === "native")
      || (legacyPosix.ok && legacyPosix.record.mode === "native")
    ) {
      // A WSL/Linux installer owns the POSIX launcher in a shared CODEX_HOME.
      // Windows startup sync must never point it back at a Windows-only target.
      posixPreserved = true;
    } else if (!existingPosix.ok && !legacyPosix.ok && fs.existsSync(paths.posixLauncherPath)) {
      // Unknown/corrupt POSIX state may belong to WSL or a newer Clawd.
      // Preserve it so a POSIX installer can inspect or repair its own artifact.
      posixPreserved = true;
    } else {
      const posixNodeBin = windowsPathToWslPath(nodeBin)
        || (/^[\\/]{2}/.test(nodeBin) ? "node.exe" : (/\.exe$/i.test(nodeBin) ? nodeBin : `${nodeBin}.exe`));
      const posixHealthTarget = windowsPathToWslPath(target) || target;
      posix = writeStableCodexHookLauncher(
        paths.posixLauncherPath,
        paths.posixManifestPath,
        {
          platform: "linux",
          mode: "windows-interop",
          nodeBin: posixNodeBin,
          target: target.replace(/\\/g, "/"),
          args: [CODEX_WSL_INTEROP_ARG],
          healthNodeBin: posixNodeBin,
          healthTarget: posixHealthTarget,
        }
      );
    }
    return { ...paths, platform, target, nodeBin, windows, posix, posixPreserved };
  }

  const posix = writeStableCodexHookLauncher(
    paths.posixLauncherPath,
    paths.posixManifestPath,
    { platform, mode: "native", nodeBin, target, env: options.env }
  );
  return { ...paths, platform, target, nodeBin, windows: null, posix, posixPreserved: false };
}

function buildStableCodexHookCommand(launcherPath, platform = process.platform) {
  if (platform === "win32") {
    // NOTE (2026-09-04): the local stable Windows path no longer uses this
    // inline dispatcher — Windows Defender's ML heuristic flags the
    // "ReadAllLines + FromBase64String + SetEnvironmentVariable + & $n $t"
    // shape as Trojan:Win32/Commando.A!ml on every Codex PowerShell launch
    // (clawd-on-desk#986). Production registers the direct call-operator form
    // (desiredCommandWindows / buildCodexHookCommand) and codex-hook.js reads
    // the sidecar itself. This branch remains only for recognizing/removing
    // legacy entries and for non-executing compatibility tests.
    const runFile = quotePowerShellSingleArg(launcherPath);
    const signature = quotePowerShellSingleArg(CODEX_STABLE_WINDOWS_RUN_SIGNATURE);
    // Codex already evaluates commandWindows in PowerShell. Read the mutable
    // UTF-8/Base64 data sidecar with .NET APIs, so non-ASCII user/profile
    // paths stay data and never depend on Windows PowerShell 5.1's legacy
    // no-BOM .ps1 decoding. No script file or second powershell.exe is used.
    return [
      "$ErrorActionPreference='Stop'",
      "$u=[Text.Encoding]::UTF8",
      `$l=[IO.File]::ReadAllLines(${runFile},$u)`,
      `if($l[0]-ne ${signature}){exit 1}`,
      "$n=$u.GetString([Convert]::FromBase64String($l[1]))",
      "$t=$u.GetString([Convert]::FromBase64String($l[2]))",
      "for($i=3;$i-lt$l.Length;$i++){if(!$l[$i]){continue};$p=$l[$i].Substring(1).Split('.',2);if(!$l[$i].StartsWith('E')-or$p.Length-ne 2){exit 1};$k=$u.GetString([Convert]::FromBase64String($p[0]));$v=$u.GetString([Convert]::FromBase64String($p[1]));[Environment]::SetEnvironmentVariable($k,$v,'Process')}",
      "& $n $t",
      "exit $LASTEXITCODE # codex-hook.js",
    ].join(";");
  }
  return `"/bin/sh" "${String(launcherPath).replace(/"/g, '\\"')}"`;
}

function extractStableCodexHookLauncherPath(command, platform = process.platform) {
  const text = String(command || "");
  if (platform === "win32") {
    const match = text.match(/ReadAllLines\(\s*'((?:''|[^'])+)'/i);
    if (!match) return null;
    const manifestPath = unescapePowerShellSingleQuoted(match[1]);
    return manifestPath.replace(/\\/g, "/").endsWith("codex-hook.js.windows.run")
      ? manifestPath
      : null;
  }
  const suffix = "codex-hook.js.sh";
  const quoted = [...text.matchAll(/["']([^"']+)["']/g)]
    .map((match) => match[1])
    .find((value) => value.replace(/\\/g, "/").endsWith(suffix));
  return quoted || null;
}

function inspectStableCodexHookCommand(command, options = {}) {
  const platform = options.platform || process.platform;
  const fsApi = options.fs || fs;
  let launcherPath = extractStableCodexHookLauncherPath(command, platform);
  let directWindowsCommand = false;
  if (
    !launcherPath
    && platform === "win32"
    && options.codexDir
    && String(command || "").trim().endsWith(` ${CODEX_WINDOWS_STABLE_ARG}`)
  ) {
    const paths = stableCodexHookPaths(options.codexDir, { ...options, platform });
    launcherPath = paths.windowsRunPath;
    directWindowsCommand = true;
  }
  if (!launcherPath) return { matched: false };
  const manifestPath = platform === "win32"
    ? path.join(path.dirname(launcherPath), "codex-hook.windows.json")
    : path.join(path.dirname(launcherPath), "codex-hook.posix.json");
  if (platform === "win32") {
    let source;
    try {
      source = fsApi.readFileSync(launcherPath, "utf8");
    } catch {
      return { matched: true, ok: false, issue: "stable-launcher-missing", launcherPath, manifestPath };
    }
    const launcher = inspectStableWindowsRunSource(source);
    if (!launcher.ok) {
      return { matched: true, ok: false, issue: launcher.issue, launcherPath, manifestPath };
    }
    const manifest = readStableCodexHookManifest(manifestPath, { fs: fsApi });
    if (!manifest.ok) {
      return { matched: true, ok: false, issue: manifest.issue, launcherPath, manifestPath };
    }
    if (manifest.record.platform !== "win32" || manifest.record.mode !== "native") {
      return {
        matched: true,
        ok: false,
        issue: "stable-manifest-platform",
        launcherPath,
        manifestPath,
      };
    }
    if (
      launcher.generation !== manifest.record.generation
      || launcher.nodeBin !== manifest.record.nodeBin
      || launcher.target !== manifest.record.target
      || JSON.stringify(launcher.env) !== JSON.stringify(manifest.record.env)
      || manifest.record.args.length !== 0
    ) {
      return {
        matched: true,
        ok: false,
        issue: "stable-launcher-stale",
        launcherPath,
        manifestPath,
      };
    }
    if (
      directWindowsCommand
      && command !== `${buildCodexHookCommand(
        manifest.record.nodeBin,
        manifest.record.target,
        "win32"
      )} ${CODEX_WINDOWS_STABLE_ARG}`
    ) {
      return {
        matched: true,
        ok: false,
        issue: "stable-launcher-stale",
        launcherPath,
        manifestPath,
      };
    }
    return {
      matched: true,
      ok: true,
      launcherPath,
      manifestPath,
      nodeBin: manifest.record.nodeBin,
      scriptPath: manifest.record.target,
      mode: manifest.record.mode,
      directWindowsCommand,
    };
  }
  let source;
  try {
    source = fsApi.readFileSync(launcherPath, "utf8");
  } catch {
    return { matched: true, ok: false, issue: "stable-launcher-missing", launcherPath, manifestPath };
  }
  const launcher = inspectStableLauncherSource(source, platform);
  if (!launcher.ok) {
    return { matched: true, ok: false, issue: launcher.issue, launcherPath, manifestPath };
  }
  const manifest = readStableCodexHookManifest(manifestPath, { fs: fsApi });
  if (!manifest.ok) return { matched: true, ok: false, issue: manifest.issue, launcherPath, manifestPath };
  if (manifest.record.platform !== (platform === "win32" ? "win32" : "posix")) {
    return { matched: true, ok: false, issue: "stable-manifest-platform", launcherPath, manifestPath };
  }
  if (launcher.generation !== manifest.record.generation) {
    return { matched: true, ok: false, issue: "stable-launcher-stale", launcherPath, manifestPath };
  }
  return {
    matched: true,
    ok: true,
    launcherPath,
    manifestPath,
    nodeBin: manifest.record.nodeBin,
    scriptPath: manifest.record.target,
    mode: manifest.record.mode,
  };
}

function removeStableCodexHookLauncher(options = {}) {
  const codexDir = resolveStableCodexDir(options);
  const paths = stableCodexHookPaths(codexDir, options);
  let launcherRemoved = 0;
  let manifestRemoved = 0;

  const legacyWindowsRemoved = removeOwnedLegacyWindowsLauncher(paths.legacyWindowsLauncherPath);
  if (legacyWindowsRemoved) launcherRemoved++;
  const pairs = [
    {
      launcherPath: paths.windowsRunPath,
      manifestPath: paths.windowsManifestPath,
      platform: "win32",
      ownedHint: legacyWindowsRemoved,
      windowsRun: true,
    },
    {
      launcherPath: paths.posixLauncherPath,
      manifestPath: paths.posixManifestPath,
      platform: "linux",
      ownedHint: false,
      windowsRun: false,
    },
  ];
  for (const { launcherPath, manifestPath, platform, ownedHint, windowsRun } of pairs) {
    let launcherOwned = false;
    if (launcherPath) {
      try {
        const source = fs.readFileSync(launcherPath, "utf8").replace(/^\uFEFF/, "");
        const lines = source.replace(/\r\n/g, "\n").split("\n");
        if (windowsRun) {
          launcherOwned = lines[0] === CODEX_STABLE_WINDOWS_RUN_SIGNATURE;
        } else {
          const signature = lines[1] && lines[1].startsWith("# ") ? lines[1].slice(2) : "";
          launcherOwned = signature === CODEX_STABLE_LAUNCHER_SIGNATURE
            || LEGACY_CODEX_STABLE_LAUNCHER_SIGNATURES.has(signature);
        }
        if (launcherOwned) {
          fs.unlinkSync(launcherPath);
          launcherRemoved++;
        }
      } catch (err) {
        if (!err || err.code !== "ENOENT") throw err;
      }
    }
    const manifest = readStableCodexHookManifest(manifestPath);
    const legacyManifest = manifest.ok
      ? { ok: false }
      : readLegacyStableCodexHookManifest(manifestPath);
    if (manifest.ok || legacyManifest.ok || launcherOwned || ownedHint) {
      try {
        fs.unlinkSync(manifestPath);
        manifestRemoved++;
      } catch (err) {
        if (!err || err.code !== "ENOENT") throw err;
      }
    }
  }

  try { fs.rmdirSync(paths.stableDir); } catch {}
  return {
    changed: launcherRemoved > 0 || manifestRemoved > 0,
    launcherRemoved,
    manifestRemoved,
  };
}

function timeoutForCodexEvent(event) {
  if (event === "PermissionRequest") return 600;
  // Upstream caps teardown/interruption hooks at three seconds.
  if (event === "SessionEnd" || event === "Interrupt") return 3;
  return 30;
}

function getCodexPaths(options = {}) {
  const codexDir = resolveCodexHome(options);
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
// boundary — never prepend env here; keep it on the native Windows path
// (the stable local hook imports it from its data sidecar).
function buildCodexHookPosixInteropCommand(nodeBin, hookScript, options = {}) {
  const wslNodeBin = windowsPathToWslPath(nodeBin);
  // A UNC node path (\\server\share\node.exe or //server/share/node.exe)
  // has no /mnt translation and a POSIX shell cannot exec the raw Windows
  // form — fall back to bare node.exe resolved through the interop PATH.
  const posixNodeBin = wslNodeBin
    || (/^[\\/]{2}/.test(String(nodeBin))
      ? "node.exe"
      : (/\.exe$/i.test(String(nodeBin)) ? nodeBin : `${nodeBin}.exe`));
  return `${formatNodeHookCommand(posixNodeBin, hookScript, { platform: "linux", wslDistro: options.wslDistro })} ${CODEX_WSL_INTEROP_ARG}`;
}

function quotePosixEnvValue(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
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
      .map(([key, value]) => `$env:${key}=${quotePowerShellSingleArg(value)}`)
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

// Read-only mirror of ensureCodexHooksFeature's decision. Callers must not
// write config.toml; this only classifies the current [features] state.
function readCodexHooksFeatureState(text) {
  const lines = text ? String(text).split(/\r?\n/) : [];
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

  if (featuresStart === -1) return "missing";
  const found = findFeatureAssignments(lines, featuresStart, featuresEnd);
  if (found.hooks) return found.hooks.value ? "on" : "off";
  if (found.hooksNonBoolean) return "invalid";
  if (found.legacy) return found.legacy.value ? "on" : "off";
  if (found.legacyNonBoolean) return "invalid";
  return "missing";
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

function unquotePowerShellDoubleQuoted(value) {
  return String(value).replace(/\\(["\\])/g, "$1");
}

// Strict counterpart for the POSIX `command` field of a Windows remote hook.
// Only the exact shape the installer writes is accepted: two double-quoted
// tokens followed by the bare WSL-interop and SSH-remote flags, in that
// order. A flag hidden in a path or in an extra argument never matches.
function parseWindowsRemoteCodexInteropCommand(command) {
  if (typeof command !== "string" || /[\r\n\0]/.test(command)) return null;
  const match = /^"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)" --clawd-wsl-interop --clawd-ssh-remote$/.exec(command);
  if (!match) return null;
  if (/[$`\u201C\u201D\u201E]/.test(match[1]) || /[$`\u201C\u201D\u201E]/.test(match[2])) return null;
  return {
    nodeBin: unquotePowerShellDoubleQuoted(match[1]),
    script: unquotePowerShellDoubleQuoted(match[2]),
  };
}

// The local Windows stable entry is a direct PowerShell call-operator command
// with a bare stable flag. Kept separate from parsePowerShellEnvCommand so a
// remote-shaped command can never be mistaken for it (and vice versa).
// Installation verification and takeover checks need a command field, not just
// the ownership classification: `ours` also accepts a missing command so that
// uninstall can safely delete a half-written entry.
function isOwnedWindowsRemoteCodexCommand(command, options = {}) {
  const parsed = parseWindowsRemoteCodexInteropCommand(command);
  if (!parsed) return null;
  const scriptName = options.scriptName || "codex-hook.js";
  if (normalizeHookScriptPath(parsed.script, "win32")
    !== remoteHookScriptKey(options.hooksDir, scriptName, "win32")) return null;
  return parsed;
}

function parseLocalStableWindowsCodexCommand(command) {
  if (typeof command !== "string" || /[\r\n\0]/.test(command)) return null;
  const match = /^& "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)" --clawd-windows-stable$/.exec(command);
  if (!match) return null;
  return {
    nodeBin: unquotePowerShellDoubleQuoted(match[1]),
    script: unquotePowerShellDoubleQuoted(match[2]),
  };
}

function codexScriptBasename(value) {
  return String(value || "").replace(/\\/g, "/").split("/").pop();
}

// Windows paths are case-insensitive, so local-entry recognition must be too.
function isCodexScriptName(value, scriptName) {
  return codexScriptBasename(value).toLowerCase() === String(scriptName).toLowerCase();
}

function commandHasCodexMarker(command) {
  return typeof command === "string" && commandMatchesMarker(command, "codex-hook.js");
}

function classifyWindowsCodexField(command, context) {
  if (typeof command !== "string") return "missing";

  const native = parsePowerShellEnvCommand(command);
  if (
    native
    && native.args.length === 3
    && native.args[2] === CODEX_SSH_REMOTE_ARG
    && normalizeHookScriptPath(native.args[1], "win32")
      === remoteHookScriptKey(context.hooksDir, context.scriptName, "win32")
  ) {
    return "ours";
  }

  const localStable = parseLocalStableWindowsCodexCommand(command);
  if (localStable && isCodexScriptName(localStable.script, context.scriptName)) {
    return "local";
  }

  if (
    native
    && native.args.length >= 2
    && isCodexScriptName(native.args[1], context.scriptName)
    && !native.args.includes(CODEX_SSH_REMOTE_ARG)
    && normalizeHookScriptPath(native.args[1], "win32")
      !== remoteHookScriptKey(context.hooksDir, context.scriptName, "win32")
  ) {
    return "local";
  }

  return commandHasCodexMarker(command) ? "marker" : "foreign";
}

function classifyPosixCodexField(command, context) {
  if (typeof command !== "string") return "missing";
  const parsed = parseWindowsRemoteCodexInteropCommand(command);
  if (
    parsed
    && normalizeHookScriptPath(parsed.script, "win32")
      === remoteHookScriptKey(context.hooksDir, context.scriptName, "win32")
  ) {
    return "ours";
  }
  return commandHasCodexMarker(command) ? "marker" : "foreign";
}

// Object-level ownership for a Windows remote Codex hook. Both command fields
// are inspected together, each with its own strict parser, because a hook is
// only safe to update or remove when the native and interop forms agree that
// it belongs to this deployment.
function classifyWindowsRemoteCodexHook(hook, options = {}) {
  if (!hook || typeof hook !== "object") return "third-party";
  const context = {
    hooksDir: options.hooksDir,
    scriptName: options.scriptName || "codex-hook.js",
  };
  const native = classifyWindowsCodexField(hook.commandWindows, context);
  const posix = classifyPosixCodexField(hook.command, context);

  if (native === "ours" && (posix === "ours" || posix === "missing")) return "ours";
  if (native === "ours" || posix === "ours") return "conflict";
  if (native === "local") {
    // A local stable commandWindows is still safe to migrate only while its
    // interop command is missing or still carries the Clawd marker. A
    // marker-less command means the user replaced it deliberately; keep it
    // and fail the install instead of overwriting their fix.
    return posix === "missing" || posix === "marker" ? "local-clawd" : "conflict";
  }
  if (native !== "marker" && posix !== "marker") return "third-party";
  return "unknown-clawd";
}

function listWindowsRemoteCodexHooks(entries) {
  const items = [];
  if (!Array.isArray(entries)) return items;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (Array.isArray(entry.hooks)) {
      for (const hook of entry.hooks) {
        if (hook && typeof hook === "object") items.push({ entry, hook, nested: true });
      }
      continue;
    }
    if (typeof entry.command === "string" || typeof entry.commandWindows === "string") {
      items.push({ entry, hook: entry, nested: false });
    }
  }
  return items;
}

// A group can also carry a top-level command of its own (third-party or
// hand-written). Removing the last nested hook must not take that command with
// it; keep the group and drop only its now-empty hooks array.
function dropEmptiedHookGroup(entries, index, entry) {
  if (entry.hooks.length !== 0) return;
  if (typeof entry.command === "string" || typeof entry.commandWindows === "string") {
    delete entry.hooks;
    return;
  }
  entries.splice(index, 1);
}

function assertWindowsRemoteCodexOwnership(settings, events, context) {
  const hookEvents = new Set(events);
  if (settings.hooks && typeof settings.hooks === "object") {
    for (const event of Object.keys(settings.hooks)) hookEvents.add(event);
  }
  for (const event of hookEvents) {
    const entries = settings.hooks && settings.hooks[event];
    for (const item of listWindowsRemoteCodexHooks(entries)) {
      const classification = classifyWindowsRemoteCodexHook(item.hook, context);
      if (classification !== "conflict" && classification !== "unknown-clawd") continue;
      throw new Error(
        `${CODEX_WINDOWS_REMOTE_OWNERSHIP_CONFLICT}: ${event} has a ${classification} Codex hook; `
        + "refusing to install remote hooks until that entry is resolved"
      );
    }
  }
}

function assertSafeWindowsRemoteHookPath(value, label) {
  if (!/[$`"\u201C\u201D\u201E]/.test(String(value))) return;
  throw new Error(
    `${CODEX_WINDOWS_REMOTE_UNSAFE_PATH}: ${label} contains a PowerShell-unsafe character: ${value}`
  );
}

function registerWindowsRemoteEvent(entries, desired, context) {
  const items = listWindowsRemoteCodexHooks(entries).map((item) => ({
    ...item,
    classification: classifyWindowsRemoteCodexHook(item.hook, context),
  }));
  const existingOurs = items.find((item) => item.classification === "ours");
  const firstLocal = items.find((item) => item.classification === "local-clawd");
  // An existing deployment entry wins. Otherwise migrate the first local
  // stable entry in place so its group-level fields (matcher, ...) survive.
  const keep = existingOurs || firstLocal || null;
  const removeHooks = new Set();
  const removeEntries = new Set();

  for (const item of items) {
    if (item === keep) continue;
    if (item.classification !== "ours" && item.classification !== "local-clawd") continue;
    if (item.nested) removeHooks.add(item.hook);
    else removeEntries.add(item.entry);
  }

  let changed = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (removeEntries.has(entry)) {
      entries.splice(i, 1);
      changed = true;
      continue;
    }
    if (!Array.isArray(entry.hooks) || !entry.hooks.some((hook) => removeHooks.has(hook))) continue;
    entry.hooks = entry.hooks.filter((hook) => !removeHooks.has(hook));
    changed = true;
    dropEmptiedHookGroup(entries, i, entry);
  }

  if (!keep) {
    entries.push({
      hooks: [{
        type: "command",
        command: desired.command,
        commandWindows: desired.commandWindows,
        timeout: desired.timeout,
      }],
    });
    return { added: 1, updated: 0, skipped: 0, changed: true };
  }

  const hook = keep.hook;
  let stale = changed;
  if (hook.type !== "command") {
    hook.type = "command";
    stale = true;
  }
  if (hook.command !== desired.command) {
    hook.command = desired.command;
    stale = true;
  }
  if (hook.commandWindows !== desired.commandWindows) {
    hook.commandWindows = desired.commandWindows;
    stale = true;
  }
  if (hook.timeout !== desired.timeout) {
    hook.timeout = desired.timeout;
    stale = true;
  }
  return stale
    ? { added: 0, updated: 1, skipped: 0, changed: true }
    : { added: 0, updated: 0, skipped: 1, changed: false };
}

function hooksFileHasUtf8Bom(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    return buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF;
  } catch {
    return false;
  }
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
  const hostPlatform = options.platform || process.platform;
  const isWindowsHost = hostPlatform === "win32";
  const processEnv = options.processEnv || process.env;
  const sshSecureRemote = options.remote === true
    && (options.sshRemote === true || processEnv.CLAWD_SSH_REMOTE === "1");
  const windowsRemoteOwned = isWindowsHost && options.remote === true;
  const windowsRemoteSecure = windowsRemoteOwned && sshSecureRemote;
  let feature = null;
  // Every non-Windows-SSH path keeps the baseline order: enable the feature
  // first, then read hooks.json. Only the guarded remote path moves all
  // rejection checks ahead of that write.
  if (!windowsRemoteSecure) {
    feature = ensureCodexHooksFeature(configPath, {
      force: options.forceCodexHooksFeature === true,
    });
    if (feature.warning) warnings.push(feature.warning);
  }
  let settings = readJsonIfPresent(hooksPath, "hooks.json");
  if (windowsRemoteSecure && (!settings || typeof settings !== "object" || Array.isArray(settings))) settings = {};
  const hooksHadUtf8Bom = isWindowsHost && hooksFileHasUtf8Bom(hooksPath);
  let hookScript = asarUnpackedPath(path.resolve(__dirname, scriptName).replace(/\\/g, "/"));
  if (hostPlatform === "linux" && processEnv.APPIMAGE) {
    const extraEntryPaths = scriptName === "codex-hook.js"
      ? [asarUnpackedPath(path.resolve(__dirname, "auto-start.js").replace(/\\/g, "/"))]
      : [];
    hookScript = materializeAppImageHookScript(hookScript, {
      appImagePath: processEnv.APPIMAGE,
      homeDir: options.homeDir,
      materializedRoot: options.materializedRoot,
      platform: hostPlatform,
      extraEntryPaths,
    }).replace(/\\/g, "/");
  }
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const stableNodeBin = options.stableLauncher === true
    ? readExistingStableCodexNodeBin(codexDir, hostPlatform, options)
    : null;
  const commandNodeBin = isWindowsHost
    ? extractExistingWindowsNodeBin(settings, marker)
    : extractExistingNodeBin(settings, marker, { nested: true });
  // A stable POSIX command begins with the fixed /bin/sh interpreter. It is
  // not the Node binary and must never be fed back into the managed wrapper
  // when discovery temporarily fails. A valid native manifest above is the
  // source of truth for stable installs; legacy commands still use the old
  // extraction fallback.
  const legacyNodeBin = options.stableLauncher === true && commandNodeBin === "/bin/sh"
    ? null
    : commandNodeBin;
  const nodeBin = resolved
    || stableNodeBin
    || legacyNodeBin
    || "node";
  if (windowsRemoteOwned) {
    assertSafeWindowsRemoteHookPath(nodeBin, "node path");
    assertSafeWindowsRemoteHookPath(hookScript, "hook script path");
  }
  if (windowsRemoteSecure) {
    assertWindowsRemoteCodexOwnership(settings, events, { hooksDir: __dirname, scriptName });
    if (options.forceCodexHooksFeature !== true) {
      let configText = null;
      try {
        configText = fs.readFileSync(configPath, "utf-8");
      } catch (err) {
        if (err.code !== "ENOENT") throw new Error(`Failed to read config.toml: ${err.message}`);
      }
      if (configText !== null && readCodexHooksFeatureState(configText) === "off") {
        throw new Error(
          `${CODEX_WINDOWS_REMOTE_HOOKS_DISABLED}: [features].hooks is false in ${configPath}`
        );
      }
    }
    feature = ensureCodexHooksFeature(configPath, {
      force: options.forceCodexHooksFeature === true,
    });
    if (feature.warning) warnings.push(feature.warning);
  }

  const remoteSecureEnv = options.remote ? {
    CLAWD_REMOTE: "1",
    ...(sshSecureRemote ? {
      CLAWD_SSH_REMOTE: "1",
      ...(processEnv.CLAWD_REMOTE_IDENTITY_PATH
        ? { CLAWD_REMOTE_IDENTITY_PATH: processEnv.CLAWD_REMOTE_IDENTITY_PATH }
        : {}),
      ...(processEnv.CLAWD_SSH_SECURE_MARKER_PATH
        ? { CLAWD_SSH_SECURE_MARKER_PATH: processEnv.CLAWD_SSH_SECURE_MARKER_PATH }
        : {}),
      ...(processEnv.CLAWD_HOST_PREFIX_PATH
        ? { CLAWD_HOST_PREFIX_PATH: processEnv.CLAWD_HOST_PREFIX_PATH }
        : {}),
      ...(processEnv.CLAWD_REMOTE_LAST_LOG_PATH
        ? { CLAWD_REMOTE_LAST_LOG_PATH: processEnv.CLAWD_REMOTE_LAST_LOG_PATH }
        : {}),
      ...(processEnv.CODEX_HOME ? { CODEX_HOME: processEnv.CODEX_HOME } : {}),
    } : {}),
  } : {};
  const commandEnv = {
    ...(options.env || {}),
    ...remoteSecureEnv,
  };
  let stableLauncher = null;
  if (options.stableLauncher === true) {
    stableLauncher = materializeStableCodexHookLauncher(hookScript, {
      ...options,
      codexDir,
      nodeBin,
      env: commandEnv,
      platform: hostPlatform,
    });
  }
  // On a Windows host, a WSL session may consume this hooks.json through a
  // shared CODEX_HOME (#544). Codex resolves `commandWindows` on Windows and
  // `command` on POSIX. The local *stable* Windows entry used to be a fixed
  // inline PowerShell dispatcher that decoded the UTF-8/Base64 data sidecar
  // (node path, hook path, env) before `& $node $target`. Windows Defender's
  // ML heuristic flags that dispatcher's command line as
  // Trojan:Win32/Commando.A!ml on every Codex PowerShell launch (2026-09-03,
  // Threat ID 2147840094, clawd-on-desk#986), so the entry is now the direct
  // call-operator form — AGENTS.md requires the PowerShell call operator; a
  // bare `"node" "hook.js"` exits 1 — and codex-hook.js reads the same
  // mutable sidecar itself and applies env before any hook code runs. The
  // sidecar/manifest artifacts are still written (data-driven hook, installer
  // recovery, Doctor validation). Remote installs never opt into the stable
  // launcher and keep the env-prefixed direct form below. Note codex builds
  // before openai/codex#22159 (2026-05) ignore commandWindows and would run
  // the POSIX form on Windows.
  const baseCommandWindows = isWindowsHost
    ? (stableLauncher
      ? `${buildCodexHookCommand(
        stableLauncher.nodeBin,
        stableLauncher.target,
        "win32"
      )} ${CODEX_WINDOWS_STABLE_ARG}`
      : withCommandEnv(buildCodexHookCommand(nodeBin, hookScript, "win32"), commandEnv, "win32"))
    : null;
  // The quoted standalone flag is valid PowerShell syntax and is the shape
  // the ownership classifier expects. It is not a replacement for the env
  // prefix: the native command above keeps that.
  const desiredCommandWindows = windowsRemoteSecure
    ? `${baseCommandWindows} ${JSON.stringify(CODEX_SSH_REMOTE_ARG)}`
    : baseCommandWindows;
  let desiredCommand = stableLauncher
    ? (isWindowsHost
      ? buildStableCodexHookCommand(
        windowsPathToWslPath(stableLauncher.posixLauncherPath) || stableLauncher.posixLauncherPath,
        "linux"
      )
      : buildStableCodexHookCommand(stableLauncher.posixLauncherPath, hostPlatform))
    : (isWindowsHost
      ? buildCodexHookPosixInteropCommand(
        nodeBin,
        hookScript,
        // A Windows SSH remote deployment must write the exact quoted shape
        // its ownership parser accepts, even when the installer process
        // inherits CLAWD_WSL_DISTRO from somewhere else.
        windowsRemoteSecure ? { wslDistro: null } : undefined
      )
      : withCommandEnv(buildCodexHookCommand(nodeBin, hookScript, hostPlatform), commandEnv, hostPlatform));
  // The WSL-interop form keeps its existing bare-argument style.
  if (windowsRemoteSecure && !stableLauncher && isWindowsHost) {
    desiredCommand = `${desiredCommand} ${CODEX_SSH_REMOTE_ARG}`;
  }
  // Gate the warning on the same filter withCommandEnv applies, so an env
  // object that contributes nothing (invalid keys / nullish values) doesn't
  // emit a false warning — repairCodexHooks escalates any warning to error.
  // The native command keeps its env prefix. The flag additionally covers the
  // interop command, which cannot inherit env, and gives both fields a shared
  // ownership marker; the interop-env warning would only add noise here.
  if (isWindowsHost && !windowsRemoteSecure && filterCommandEnvEntries(commandEnv).length) {
    warnings.push(
      "Env vars don't cross the WSL interop boundary; they were applied to the native Windows hook only."
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
    const desiredTimeout = timeoutForCodexEvent(event);

    if (windowsRemoteSecure) {
      const result = registerWindowsRemoteEvent(arr, {
        command: desiredCommand,
        commandWindows: desiredCommandWindows,
        timeout: desiredTimeout,
      }, { hooksDir: __dirname, scriptName });
      added += result.added;
      updated += result.updated;
      skipped += result.skipped;
      changed = changed || result.changed;
      continue;
    }

    let found = false;
    let stale = false;

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

  // Windows Codex rejects the whole hooks.json when it starts with a UTF-8
  // BOM, so rewrite it without one even when the entries themselves did not
  // change. POSIX hosts keep the file byte-for-byte.
  if (changed || hooksHadUtf8Bom) writeJsonAtomic(hooksPath, settings);

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

  return { added, skipped, updated, configChanged: feature.changed, warnings, stableLauncher };
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

// Remove only the hook objects this deployment owns. Codex entries carry no
// nonce, so ownership is proved by the command shape itself: a native remote
// commandWindows (plus an optional matching interop command). A hook with one
// owned field and one foreign/hand-edited field is a conflict and stays on
// disk so the deployment layer can report an incomplete cleanup.
function unregisterRemoteOwnedCodexHooks(options = {}) {
  const hooksDir = options.hooksDir;
  if (typeof hooksDir !== "string" || !hooksDir.trim()) {
    throw new Error("Remote owned uninstall requires --hooks-dir");
  }
  const scriptName = options.scriptName || "codex-hook.js";
  const { hooksPath } = getCodexPaths(options);
  let settings;
  try {
    settings = readJsonFile(hooksPath);
  } catch (err) {
    if (err.code === "ENOENT") return { removed: 0, conflicts: 0, changed: false };
    throw new Error(`Failed to read hooks.json: ${err.message}`);
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)
    || !settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    return { removed: 0, conflicts: 0, changed: false };
  }

  const context = { hooksDir, scriptName };
  let removed = 0;
  let conflicts = 0;
  let changed = false;

  for (const event of Object.keys(settings.hooks)) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;

    const removeHooks = new Set();
    const removeEntries = new Set();
    for (const item of listWindowsRemoteCodexHooks(entries)) {
      const classification = classifyWindowsRemoteCodexHook(item.hook, context);
      if (classification === "conflict") {
        conflicts += 1;
        continue;
      }
      if (classification !== "ours") continue;
      if (item.nested) removeHooks.add(item.hook);
      else removeEntries.add(item.entry);
      removed += 1;
    }
    if (!removeHooks.size && !removeEntries.size) continue;

    changed = true;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (removeEntries.has(entry)) {
        entries.splice(i, 1);
        continue;
      }
      if (!Array.isArray(entry.hooks) || !entry.hooks.some((hook) => removeHooks.has(hook))) continue;
      entry.hooks = entry.hooks.filter((hook) => !removeHooks.has(hook));
      dropEmptiedHookGroup(entries, i, entry);
    }
    if (entries.length === 0) delete settings.hooks[event];
  }

  if (changed) writeJsonAtomic(hooksPath, settings);
  return { removed, conflicts, changed };
}

module.exports = {
  CODEX_HOOK_EVENTS,
  CODEX_SSH_REMOTE_ARG,
  CODEX_WINDOWS_STABLE_ARG,
  CODEX_WSL_INTEROP_ARG,
  CODEX_WINDOWS_REMOTE_HOOKS_DISABLED,
  CODEX_WINDOWS_REMOTE_OWNERSHIP_CONFLICT,
  CODEX_WINDOWS_REMOTE_UNSAFE_PATH,
  CODEX_HOOKS_FEATURE_KEY,
  LEGACY_CODEX_HOOKS_FEATURE_KEY,
  buildCodexHookCommand,
  buildCodexHookPosixInteropCommand,
  buildStableCodexHookCommand,
  buildStableCodexHookLauncherSource,
  classifyWindowsRemoteCodexHook,
  collectRelativeHookClosure,
  ensureCodexHooksFeature,
  extractExistingWindowsNodeBin,
  findCodexCommandHook,
  parseTomlTableHeader,
  materializeAppImageHookScript,
  materializeStableCodexHookLauncher,
  inspectStableCodexHookCommand,
  isOwnedWindowsRemoteCodexCommand,
  readCodexHooksFeatureState,
  readStableCodexHookManifest,
  removeStableCodexHookLauncher,
  registerCodexCommandHooks,
  stableCodexHookPaths,
  timeoutForCodexEvent,
  unregisterCodexCommandHooks,
  unregisterRemoteOwnedCodexHooks,
  windowsPathToWslPath,
  withCommandEnv,
  resolveCodexHome,
};

Object.defineProperty(module.exports, "DEFAULT_PARENT_DIR", {
  enumerable: true,
  get() { return resolveCodexHome(); },
});
Object.defineProperty(module.exports, "DEFAULT_CONFIG_PATH", {
  enumerable: true,
  get() { return path.join(resolveCodexHome(), "hooks.json"); },
});
Object.defineProperty(module.exports, "DEFAULT_FEATURES_CONFIG", {
  enumerable: true,
  get() { return path.join(resolveCodexHome(), "config.toml"); },
});
