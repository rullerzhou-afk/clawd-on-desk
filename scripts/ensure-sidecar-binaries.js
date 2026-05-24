"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  TARGETS,
  fetchSidecarBinaries,
  targetBinaryPath,
} = require("./fetch-sidecar-binaries");

const ENSURE_COMMAND = "node scripts/ensure-sidecar-binaries.js";
const SKIP_ENV = "CLAWD_SKIP_SIDECAR_FETCH";
const OVERRIDE_ENV = "CLAWD_CC_CONNECT_CLAWD_PATH";
const DEFAULT_PREFLIGHT_REQUEST_TIMEOUT_MS = 30000;

function runtimePlatformName(platform = process.platform) {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "darwin";
  if (platform === "linux") return "linux";
  return "";
}

function runtimeSidecarTarget(options = {}) {
  const platformName = runtimePlatformName(options.platform);
  const arch = String(options.arch || process.arch || "").trim();
  if (!platformName || !arch) return null;
  const dir = `${platformName}-${arch}`;
  const target = TARGETS.find((item) => item.dir === dir);
  return target ? { ...target } : null;
}

function truthyEnv(value) {
  const text = String(value == null ? "" : value).trim().toLowerCase();
  return !!text && text !== "0" && text !== "false" && text !== "no";
}

function isExistingFile(fsModule, filePath) {
  try {
    if (!fsModule.existsSync(filePath)) return false;
    if (typeof fsModule.statSync !== "function") return true;
    const stat = fsModule.statSync(filePath);
    return !stat || typeof stat.isFile !== "function" || stat.isFile();
  } catch {
    return false;
  }
}

function sidecarFetchCommand(targetDir) {
  return `npm run fetch:sidecars -- --target ${targetDir}`;
}

function runtimeExecutableName(platform = process.platform) {
  return platform === "win32" ? "cc-connect-clawd.exe" : "cc-connect-clawd";
}

function resolveOverridePath(rawValue, options = {}) {
  const value = String(rawValue || "").trim();
  if (!value) return "";
  const fsModule = options.fs || fs;
  const platform = options.platform || process.platform;
  try {
    if (fsModule && typeof fsModule.statSync === "function") {
      const stat = fsModule.statSync(value);
      if (stat && typeof stat.isDirectory === "function" && stat.isDirectory()) {
        return path.join(value, runtimeExecutableName(platform));
      }
    }
  } catch {
    // Treat the override as a direct executable path below.
  }
  if (/[\\/]$/.test(value)) return path.join(value, runtimeExecutableName(platform));
  return value;
}

function write(stream, message) {
  if (stream && typeof stream.write === "function") stream.write(message);
}

function skipPreflightHint() {
  return `Set ${SKIP_ENV}=1 before running npm start to skip the sidecar preflight.`;
}

async function ensureCurrentPlatformSidecar(options = {}) {
  const env = options.env || process.env;
  const fsModule = options.fs || fs;
  const rootDir = options.rootDir || path.join(__dirname, "..");
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const target = options.target || runtimeSidecarTarget(options);

  if (truthyEnv(env[SKIP_ENV])) {
    return { ok: true, skipped: true, reason: "env-skip" };
  }
  if (env[OVERRIDE_ENV]) {
    const overridePath = resolveOverridePath(env[OVERRIDE_ENV], { fs: fsModule, platform: options.platform });
    if (isExistingFile(fsModule, overridePath)) {
      return { ok: true, skipped: true, reason: "override-path", path: overridePath };
    }
    const launchMessage = options.strict
      ? "Strict mode will stop launch until the override path is fixed, or unset to allow automatic sidecar fetch."
      : "Clawd will still launch. Fix the override path, or unset it to allow automatic sidecar fetch.";
    write(stderr, [
      `${OVERRIDE_ENV} is set but no sidecar executable was found: ${overridePath || env[OVERRIDE_ENV]}`,
      launchMessage,
      "",
    ].join("\n"));
    return { ok: false, skipped: true, reason: "override-path-missing", path: overridePath || String(env[OVERRIDE_ENV]) };
  }
  if (!target) {
    return {
      ok: true,
      skipped: true,
      reason: "unsupported-runtime",
      platform: options.platform || process.platform,
      arch: options.arch || process.arch,
    };
  }

  const binaryPath = targetBinaryPath(rootDir, target);
  if (isExistingFile(fsModule, binaryPath)) {
    return { ok: true, existing: true, target: target.dir, path: binaryPath };
  }

  const command = sidecarFetchCommand(target.dir);
  if (options.dryRun) {
    return { ok: false, missing: true, target: target.dir, path: binaryPath, command };
  }

  write(stdout, `Missing ${target.dir} cc-connect-clawd sidecar; fetching pinned binary...\n`);
  try {
    const fetch = options.fetchSidecarBinaries || fetchSidecarBinaries;
    await fetch({
      rootDir,
      target: target.dir,
      fs: fsModule,
      requestTimeoutMs: options.requestTimeoutMs || DEFAULT_PREFLIGHT_REQUEST_TIMEOUT_MS,
    });
    return { ok: true, fetched: true, target: target.dir, path: binaryPath };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    write(stderr, [
      "Telegram approval sidecar is missing and could not be fetched automatically.",
      `Run: ${command}`,
      skipPreflightHint(),
      `Reason: ${message}`,
      "",
    ].join("\n"));
    return { ok: false, missing: true, target: target.dir, path: binaryPath, command, error: message };
  }
}

function parseArgs(argv = []) {
  const out = { strict: false, dryRun: false };
  for (const arg of argv) {
    if (arg === "--strict") out.strict = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function printHelp(stdout = process.stdout) {
  stdout.write(`Usage: ${ENSURE_COMMAND} [--strict] [--dry-run]\n`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    printHelp();
    return;
  }
  const result = await ensureCurrentPlatformSidecar({ strict: args.strict, dryRun: args.dryRun });
  if (!result.ok && args.strict) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exitCode = 1;
  });
}

module.exports = {
  ENSURE_COMMAND,
  SKIP_ENV,
  OVERRIDE_ENV,
  DEFAULT_PREFLIGHT_REQUEST_TIMEOUT_MS,
  runtimePlatformName,
  runtimeSidecarTarget,
  truthyEnv,
  isExistingFile,
  sidecarFetchCommand,
  runtimeExecutableName,
  resolveOverridePath,
  skipPreflightHint,
  ensureCurrentPlatformSidecar,
  parseArgs,
};
