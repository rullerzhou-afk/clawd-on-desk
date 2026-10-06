"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ISSUE_URL = "https://github.com/rullerzhou-afk/clawd-on-desk/issues/709";
const VERIFY_COMMAND = "node scripts/verify-electron-install.js";
const MAC_HELPER_APPS = Object.freeze([
  "Electron Helper.app",
  "Electron Helper (GPU).app",
  "Electron Helper (Plugin).app",
  "Electron Helper (Renderer).app",
]);

function expectedPlatformPath(platform) {
  if (platform === "darwin") return "Electron.app/Contents/MacOS/Electron";
  if (platform === "win32") return "electron.exe";
  if (platform === "linux") return "electron";
  return "";
}

function isExistingDirectory(fsModule, filePath) {
  try {
    if (!fsModule.existsSync(filePath)) return false;
    if (typeof fsModule.statSync !== "function") return true;
    const stat = fsModule.statSync(filePath);
    return !stat || typeof stat.isDirectory !== "function" || stat.isDirectory();
  } catch {
    return false;
  }
}

function existingFileStat(fsModule, filePath) {
  try {
    if (!fsModule.existsSync(filePath)) return null;
    if (typeof fsModule.statSync !== "function") return {};
    const stat = fsModule.statSync(filePath);
    if (stat && typeof stat.isFile === "function" && !stat.isFile()) return null;
    return stat || {};
  } catch {
    return null;
  }
}

function parseSemverTriplet(value) {
  const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
}

function compareSemverTriplets(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function electronVersionSatisfiesSpec(version, spec) {
  const actual = parseSemverTriplet(version);
  const rawSpec = String(spec || "").trim();
  if (!actual || !rawSpec) return false;
  const operator = rawSpec[0] === "^" || rawSpec[0] === "~" ? rawSpec[0] : "";
  const base = parseSemverTriplet(operator ? rawSpec.slice(1) : rawSpec.replace(/^=/, ""));
  if (!base) return false;
  if (!operator) return compareSemverTriplets(actual, base) === 0;
  if (compareSemverTriplets(actual, base) < 0) return false;
  if (operator === "~") return actual[0] === base[0] && actual[1] === base[1];
  if (base[0] > 0) return actual[0] === base[0];
  if (base[1] > 0) return actual[0] === 0 && actual[1] === base[1];
  return actual[0] === 0 && actual[1] === 0 && actual[2] === base[2];
}

function postinstallSkipReason(options) {
  if (options.context !== "postinstall") return "";
  if (options.env.ELECTRON_SKIP_BINARY_DOWNLOAD) return "electron-download-skipped";
  if (options.env.ELECTRON_OVERRIDE_DIST_PATH) return "custom-electron-dist";
  if (!options.fs.existsSync(options.packageRoot)) return "electron-dev-dependency-absent";
  return "";
}

function verifyElectronInstall(options = {}) {
  const fsModule = options.fs || fs;
  const pathModule = options.path || path;
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const hostPlatform = options.hostPlatform || process.platform;
  const arch = options.arch || process.arch;
  const rootDir = options.rootDir || pathModule.join(__dirname, "..");
  const packageRoot = options.packageRoot || pathModule.join(rootDir, "node_modules", "electron");
  const context = options.context || "verify";
  const skipReason = postinstallSkipReason({ context, env, fs: fsModule, packageRoot });

  if (skipReason) {
    return {
      ok: true,
      skipped: true,
      reason: skipReason,
      context,
      platform,
      arch,
      nodeVersion: process.version,
      packageRoot,
      missing: [],
      invalid: [],
    };
  }

  const missing = [];
  const invalid = [];
  const platformPath = expectedPlatformPath(platform);
  const packageJsonPath = pathModule.join(packageRoot, "package.json");
  const projectPackageJsonPath = pathModule.join(rootDir, "package.json");
  let electronVersion = "unknown";

  if (!platformPath) {
    invalid.push({ path: packageRoot, reason: `unsupported platform: ${platform}` });
  }

  if (!isExistingDirectory(fsModule, packageRoot)) {
    missing.push(packageRoot);
  } else if (!existingFileStat(fsModule, packageJsonPath)) {
    missing.push(packageJsonPath);
  } else {
    try {
      const packageJson = JSON.parse(fsModule.readFileSync(packageJsonPath, "utf8"));
      if (typeof packageJson.version !== "string" || !packageJson.version.trim()) {
        invalid.push({ path: packageJsonPath, reason: "missing package version" });
      } else {
        electronVersion = packageJson.version;
      }
    } catch (error) {
      invalid.push({
        path: packageJsonPath,
        reason: `invalid JSON: ${error && error.message ? error.message : String(error)}`,
      });
    }
  }

  if (electronVersion !== "unknown" && existingFileStat(fsModule, projectPackageJsonPath)) {
    try {
      const projectPackage = JSON.parse(fsModule.readFileSync(projectPackageJsonPath, "utf8"));
      const declaredSpec = projectPackage.devDependencies && projectPackage.devDependencies.electron;
      if (typeof declaredSpec !== "string" || !electronVersionSatisfiesSpec(electronVersion, declaredSpec)) {
        invalid.push({
          path: projectPackageJsonPath,
          reason: `installed Electron ${electronVersion} does not satisfy declared range ${JSON.stringify(declaredSpec)}`,
        });
      }
    } catch (error) {
      invalid.push({
        path: projectPackageJsonPath,
        reason: `invalid JSON: ${error && error.message ? error.message : String(error)}`,
      });
    }
  }

  if (platformPath && isExistingDirectory(fsModule, packageRoot)) {
    const pathFile = pathModule.join(packageRoot, "path.txt");
    // Electron's resolver falls back to `<override>/electron` when path.txt is
    // absent. That filename matches the shipped Linux launcher. macOS and
    // Windows keep the exact path.txt requirement because their supported
    // executable layouts use an app bundle and electron.exe, respectively.
    const allowLinuxOverrideFallback =
      context === "launch" && platform === "linux" && Boolean(env.ELECTRON_OVERRIDE_DIST_PATH);
    const pathFileStat = existingFileStat(fsModule, pathFile);
    if (!pathFileStat && !allowLinuxOverrideFallback) {
      missing.push(pathFile);
    } else if (pathFileStat) {
      const actualPath = fsModule.readFileSync(pathFile, "utf8");
      if (actualPath !== platformPath) {
        invalid.push({
          path: pathFile,
          reason: `expected exact contents ${JSON.stringify(platformPath)}, got ${JSON.stringify(actualPath)}`,
        });
      }
    }

    const distRoot = env.ELECTRON_OVERRIDE_DIST_PATH
      ? pathModule.resolve(env.ELECTRON_OVERRIDE_DIST_PATH)
      : pathModule.join(packageRoot, "dist");
    const executablePath = pathModule.join(distRoot, platformPath);
    const versionPath = pathModule.join(distRoot, "version");
    const executableStat = existingFileStat(fsModule, executablePath);
    if (!executableStat) {
      missing.push(executablePath);
    } else if (
      platform !== "win32" &&
      hostPlatform !== "win32" &&
      Number.isInteger(executableStat.mode) &&
      (executableStat.mode & 0o111) === 0
    ) {
      invalid.push({ path: executablePath, reason: "executable mode is missing" });
    }

    if (!existingFileStat(fsModule, versionPath)) {
      missing.push(versionPath);
    } else {
      const distVersion = fsModule.readFileSync(versionPath, "utf8").trim().replace(/^v/, "");
      if (electronVersion !== "unknown" && distVersion !== electronVersion) {
        invalid.push({
          path: versionPath,
          reason: `expected Electron ${electronVersion}, got ${JSON.stringify(distVersion)}`,
        });
      }
    }

    if (platform === "darwin") {
      const contentsRoot = pathModule.join(distRoot, "Electron.app", "Contents");
      const frameworksRoot = pathModule.join(contentsRoot, "Frameworks");
      const frameworkRoot = pathModule.join(frameworksRoot, "Electron Framework.framework");
      const frameworkBinary = pathModule.join(frameworkRoot, "Versions", "A", "Electron Framework");

      for (const directoryPath of [frameworksRoot, frameworkRoot]) {
        if (!isExistingDirectory(fsModule, directoryPath)) missing.push(directoryPath);
      }
      if (!existingFileStat(fsModule, frameworkBinary)) missing.push(frameworkBinary);
      for (const appName of MAC_HELPER_APPS) {
        const helperPath = pathModule.join(frameworksRoot, appName);
        if (!isExistingDirectory(fsModule, helperPath)) missing.push(helperPath);
      }

    }

    return {
      ok: missing.length === 0 && invalid.length === 0,
      skipped: false,
      context,
      platform,
      arch,
      nodeVersion: process.version,
      electronVersion,
      packageRoot,
      distRoot,
      executablePath,
      missing,
      invalid,
    };
  }

  return {
    ok: missing.length === 0 && invalid.length === 0,
    skipped: false,
    context,
    platform,
    arch,
    nodeVersion: process.version,
    electronVersion,
    packageRoot,
    missing,
    invalid,
  };
}

function formatElectronInstallFailure(result) {
  const lines = [
    "Electron installation integrity check failed.",
    `Environment: Electron ${result.electronVersion || "unknown"}, Node ${result.nodeVersion}, ${result.platform}-${result.arch}`,
  ];
  if (result.missing.length) {
    lines.push("", "Missing paths:");
    for (const filePath of result.missing) lines.push(`- ${filePath}`);
  }
  if (result.invalid.length) {
    lines.push("", "Invalid paths:");
    for (const item of result.invalid) lines.push(`- ${item.path}: ${item.reason}`);
  }
  lines.push(
    "",
    "Electron's install.js exit status is not sufficient to prove that the app bundle is complete.",
    "Creating or repairing only path.txt does not restore a missing Frameworks directory.",
    "",
    "Recovery: delete node_modules/electron completely, then run npm install again.",
    "macOS/Linux: rm -rf node_modules/electron && npm install",
    "PowerShell: Remove-Item -Recurse -Force node_modules/electron; npm install",
    `Tracking issue: ${ISSUE_URL}`
  );
  return lines.join("\n");
}

function parseArgs(argv = []) {
  const out = { context: "verify" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--context") {
      index += 1;
      if (!argv[index]) throw new Error("--context requires a value");
      out.context = argv[index];
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!new Set(["verify", "postinstall", "launch"]).has(out.context)) {
    throw new Error(`Unsupported context: ${out.context}`);
  }
  return out;
}

function runCli(argv = process.argv.slice(2), options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error && error.message ? error.message : String(error)}\n`);
    return { exitCode: 1, result: null };
  }
  if (args.help) {
    stdout.write(`Usage: ${VERIFY_COMMAND} [--context verify|postinstall|launch]\n`);
    return { exitCode: 0, result: null };
  }

  const result = verifyElectronInstall({ ...options, context: args.context });
  if (result.skipped) {
    stdout.write(`Skipped Electron install verification (${result.reason}).\n`);
    return { exitCode: 0, result };
  }
  if (!result.ok) {
    stderr.write(`${formatElectronInstallFailure(result)}\n`);
    return { exitCode: 1, result };
  }
  stdout.write(`Verified Electron ${result.electronVersion} installation.\n`);
  return { exitCode: 0, result };
}

function main() {
  const outcome = runCli();
  if (outcome.exitCode) process.exitCode = outcome.exitCode;
}

if (require.main === module) main();

module.exports = {
  ISSUE_URL,
  VERIFY_COMMAND,
  MAC_HELPER_APPS,
  expectedPlatformPath,
  isExistingDirectory,
  existingFileStat,
  electronVersionSatisfiesSpec,
  postinstallSkipReason,
  verifyElectronInstall,
  formatElectronInstallFailure,
  parseArgs,
  runCli,
};
