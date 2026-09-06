const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const {
  APPIMAGE_HOOK_MARKER_FILE,
  CODEX_WINDOWS_STABLE_ARG,
  CODEX_WSL_INTEROP_ARG,
  resolveNodeBin,
} = require("./server-config");
const {
  readJsonFile,
  writeJsonAtomic,
  writeJsonAtomicWithBackup,
  writeTextAtomic,
  asarUnpackedPath,
  commandMatchesMarker,
  extractExistingNodeBin,
  formatNodeHookCommand,
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
  "Stop",
];
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

function quotePowerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
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
    const runFile = quotePowerShellLiteral(launcherPath);
    const signature = quotePowerShellLiteral(CODEX_STABLE_WINDOWS_RUN_SIGNATURE);
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
    const manifestPath = match[1].replace(/''/g, "'");
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
  return event === "PermissionRequest" ? 600 : 30;
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
function buildCodexHookPosixInteropCommand(nodeBin, hookScript) {
  const wslNodeBin = windowsPathToWslPath(nodeBin);
  // A UNC node path (\\server\share\node.exe or //server/share/node.exe)
  // has no /mnt translation and a POSIX shell cannot exec the raw Windows
  // form — fall back to bare node.exe resolved through the interop PATH.
  const posixNodeBin = wslNodeBin
    || (/^[\\/]{2}/.test(String(nodeBin))
      ? "node.exe"
      : (/\.exe$/i.test(String(nodeBin)) ? nodeBin : `${nodeBin}.exe`));
  return `${formatNodeHookCommand(posixNodeBin, hookScript, { platform: "linux" })} ${CODEX_WSL_INTEROP_ARG}`;
}

function collectRelativeHookClosure(entryPath, options = {}) {
  const fsApi = options.fs || fs;
  const resolvedEntry = path.resolve(entryPath);
  const rootDir = path.dirname(resolvedEntry);
  const extraEntryPaths = Array.isArray(options.extraEntryPaths)
    ? options.extraEntryPaths.map((value) => path.resolve(value))
    : [];
  const pending = [resolvedEntry, ...extraEntryPaths];
  const files = new Map();

  while (pending.length > 0) {
    const current = pending.pop();
    if (files.has(current)) continue;
    const relative = path.relative(rootDir, current);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`AppImage hook dependency escaped hooks directory: ${current}`);
    }
    const content = fsApi.readFileSync(current);
    files.set(current, content);
    const source = content.toString("utf8");
    for (const match of source.matchAll(/require\(["'](\.\/[^"']+)["']\)/g)) {
      const resolved = path.resolve(path.dirname(current), match[1]);
      const candidate = path.extname(resolved) ? resolved : `${resolved}.js`;
      const dependencyRelative = path.relative(rootDir, candidate);
      if (dependencyRelative.startsWith("..") || path.isAbsolute(dependencyRelative)) {
        throw new Error(`AppImage hook dependency escaped hooks directory: ${match[1]}`);
      }
      pending.push(candidate);
    }
  }
  return { rootDir, files };
}

function materializeAppImageHookScript(entryPath, options = {}) {
  const fsApi = options.fs || fs;
  const appImagePath = String(options.appImagePath || "").trim();
  if (!path.posix.isAbsolute(appImagePath)) {
    throw new Error("AppImage hook installation requires an absolute APPIMAGE path");
  }

  const resolvedEntry = path.resolve(entryPath);
  const { rootDir, files } = collectRelativeHookClosure(resolvedEntry, {
    fs: fsApi,
    extraEntryPaths: options.extraEntryPaths,
  });
  const ordered = [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
  const hasher = crypto.createHash("sha256");
  hasher.update(`${appImagePath}\0`);
  for (const [filePath, content] of ordered) {
    hasher.update(`${path.relative(rootDir, filePath)}\0`);
    hasher.update(content);
    hasher.update("\0");
  }

  const materializedRoot = options.materializedRoot
    || path.join(options.homeDir || os.homedir(), ".clawd", "appimage-hooks");
  const versionDir = path.join(materializedRoot, hasher.digest("hex").slice(0, 20));
  const targetEntry = path.join(versionDir, path.relative(rootDir, resolvedEntry));
  const markerPath = path.join(versionDir, APPIMAGE_HOOK_MARKER_FILE);
  const isComplete = () => {
    try {
      if (String(fsApi.readFileSync(markerPath, "utf8")).trim() !== appImagePath) return false;
      return ordered.every(([filePath]) =>
        fsApi.existsSync(path.join(versionDir, path.relative(rootDir, filePath))));
    } catch {
      return false;
    }
  };
  if (isComplete()) return targetEntry;

  fsApi.mkdirSync(materializedRoot, { recursive: true, mode: 0o700 });
  const stagingDir = `${versionDir}.tmp-${process.pid}-${Date.now()}`;
  let replacedDir = null;
  try {
    fsApi.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
    for (const [filePath, content] of ordered) {
      const target = path.join(stagingDir, path.relative(rootDir, filePath));
      fsApi.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fsApi.writeFileSync(target, content);
    }
    fsApi.writeFileSync(
      path.join(stagingDir, APPIMAGE_HOOK_MARKER_FILE),
      `${appImagePath}\n`,
      { mode: 0o600 }
    );
    if (fsApi.existsSync(versionDir) && !isComplete()) {
      replacedDir = `${versionDir}.replaced-${process.pid}-${Date.now()}`;
      fsApi.renameSync(versionDir, replacedDir);
    }
    try {
      fsApi.renameSync(stagingDir, versionDir);
    } catch (err) {
      // Another process may have won the same content-addressed install.
      if (!isComplete()) {
        if (replacedDir && !fsApi.existsSync(versionDir)) {
          try { fsApi.renameSync(replacedDir, versionDir); } catch {}
        }
        throw err;
      }
      fsApi.rmSync(stagingDir, { recursive: true, force: true });
    }
    if (replacedDir) fsApi.rmSync(replacedDir, { recursive: true, force: true });
  } catch (err) {
    try {
      fsApi.rmSync(stagingDir, { recursive: true, force: true });
    } catch {}
    throw err;
  }
  return targetEntry;
}

function quotePosixEnvValue(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function quotePowerShellEnvValue(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
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
      .map(([key, value]) => `$env:${key}=${quotePowerShellEnvValue(value)}`)
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
  const feature = ensureCodexHooksFeature(configPath, {
    force: options.forceCodexHooksFeature === true,
  });
  if (feature.warning) warnings.push(feature.warning);

  const settings = readJsonIfPresent(hooksPath, "hooks.json");
  const hostPlatform = options.platform || process.platform;
  const isWindowsHost = hostPlatform === "win32";
  const processEnv = options.processEnv || process.env;
  let hookScript = asarUnpackedPath(path.resolve(__dirname, scriptName).replace(/\\/g, "/"));
  if (hostPlatform === "linux" && processEnv.APPIMAGE) {
    const extraEntryPaths = scriptName === "codex-hook.js"
      ? [asarUnpackedPath(path.resolve(__dirname, "auto-start.js").replace(/\\/g, "/"))]
      : [];
    hookScript = materializeAppImageHookScript(hookScript, {
      appImagePath: processEnv.APPIMAGE,
      homeDir: options.homeDir,
      materializedRoot: options.materializedRoot,
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
  const sshSecureRemote = options.remote === true
    && (options.sshRemote === true || processEnv.CLAWD_SSH_REMOTE === "1");
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
  // recovery, Doctor validation). Remote installs never opt into the stable launcher and keep
  // their env-prefixed direct form unchanged. Note codex builds before
  // openai/codex#22159 (2026-05) ignore commandWindows and would run the
  // POSIX form on Windows.
  const desiredCommandWindows = isWindowsHost
    ? (stableLauncher
      ? `${buildCodexHookCommand(
        stableLauncher.nodeBin,
        stableLauncher.target,
        "win32"
      )} ${CODEX_WINDOWS_STABLE_ARG}`
      : withCommandEnv(buildCodexHookCommand(nodeBin, hookScript, "win32"), commandEnv, "win32"))
    : null;
  const desiredCommand = stableLauncher
    ? (isWindowsHost
      ? buildStableCodexHookCommand(
        windowsPathToWslPath(stableLauncher.posixLauncherPath) || stableLauncher.posixLauncherPath,
        "linux"
      )
      : buildStableCodexHookCommand(stableLauncher.posixLauncherPath, hostPlatform))
    : (isWindowsHost
      ? buildCodexHookPosixInteropCommand(nodeBin, hookScript)
      : withCommandEnv(buildCodexHookCommand(nodeBin, hookScript, hostPlatform), commandEnv, hostPlatform));
  // Gate the warning on the same filter withCommandEnv applies, so an env
  // object that contributes nothing (invalid keys / nullish values) doesn't
  // emit a false warning — repairCodexHooks escalates any warning to error.
  if (isWindowsHost && filterCommandEnvEntries(commandEnv).length) {
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
    let found = false;
    let stale = false;
    const desiredTimeout = timeoutForCodexEvent(event);

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

  if (changed) writeJsonAtomic(hooksPath, settings);

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

module.exports = {
  CODEX_HOOK_EVENTS,
  CODEX_WINDOWS_STABLE_ARG,
  CODEX_WSL_INTEROP_ARG,
  CODEX_HOOKS_FEATURE_KEY,
  LEGACY_CODEX_HOOKS_FEATURE_KEY,
  buildCodexHookCommand,
  buildCodexHookPosixInteropCommand,
  buildStableCodexHookCommand,
  buildStableCodexHookLauncherSource,
  collectRelativeHookClosure,
  ensureCodexHooksFeature,
  extractExistingWindowsNodeBin,
  findCodexCommandHook,
  parseTomlTableHeader,
  materializeAppImageHookScript,
  materializeStableCodexHookLauncher,
  inspectStableCodexHookCommand,
  readStableCodexHookManifest,
  removeStableCodexHookLauncher,
  registerCodexCommandHooks,
  stableCodexHookPaths,
  timeoutForCodexEvent,
  unregisterCodexCommandHooks,
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
