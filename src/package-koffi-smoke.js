"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { getReleaseTarget, resolveRuntimeTarget } = require("./native-package-target");

const SMOKE_FLAG = "--clawd-package-smoke";
const TARGET_PREFIX = "--clawd-package-smoke-target=";
const OUTPUT_PREFIX = "--clawd-package-smoke-output=";

function comparablePath(value) {
  let resolved = path.resolve(String(value || ""));
  if (process.platform === "win32" && resolved.startsWith("\\\\?\\UNC\\")) {
    resolved = `\\\\${resolved.slice(8)}`;
  } else if (process.platform === "win32" && resolved.startsWith("\\\\?\\")) {
    resolved = resolved.slice(4);
  }
  return resolved;
}

function isInside(parent, candidate) {
  const relative = path.relative(comparablePath(parent), comparablePath(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function parseSmokeArgs(argv) {
  const args = Array.from(argv || [], String);
  if (!args.includes(SMOKE_FLAG)) return null;
  const targetArg = args.find((arg) => arg.startsWith(TARGET_PREFIX));
  const outputArg = args.find((arg) => arg.startsWith(OUTPUT_PREFIX));
  const targetId = targetArg ? targetArg.slice(TARGET_PREFIX.length) : "";
  const outputPath = outputArg ? outputArg.slice(OUTPUT_PREFIX.length) : "";
  if (!targetId) throw new Error(`${TARGET_PREFIX}<target> is required`);
  if (!outputPath) throw new Error(`${OUTPUT_PREFIX}<path> is required`);
  getReleaseTarget(targetId);
  return { targetId, outputPath: path.resolve(outputPath) };
}

function physicalAddonPath(filename) {
  const resolved = path.resolve(String(filename || ""));
  if (/app\.asar\.unpacked(?:[\\/]|$)/i.test(resolved)) return resolved;
  return resolved.replace(/app\.asar(?=[\\/])/i, "app.asar.unpacked");
}

function captureKoffiLoad() {
  const originalDlopen = process.dlopen;
  let dlopenPath = "";
  process.dlopen = function patchedDlopen(module, filename, ...args) {
    if (path.basename(String(filename || "")).toLowerCase() === "koffi.node") {
      dlopenPath = String(filename);
    }
    return originalDlopen.call(this, module, filename, ...args);
  };
  try {
    const koffi = require("koffi");
    return { koffi, dlopenPath };
  } finally {
    process.dlopen = originalDlopen;
  }
}

function callStableNativeFunction(koffi, platform = process.platform) {
  if (platform === "win32") {
    const kernel32 = koffi.load("kernel32.dll");
    const getCurrentProcessId = kernel32.func("uint __stdcall GetCurrentProcessId()");
    return { library: "kernel32.dll", symbol: "GetCurrentProcessId", value: getCurrentProcessId() };
  }
  if (platform === "darwin") {
    const libSystem = koffi.load("/usr/lib/libSystem.B.dylib");
    const getpid = libSystem.func("int getpid()");
    return { library: "/usr/lib/libSystem.B.dylib", symbol: "getpid", value: getpid() };
  }
  if (platform === "linux") {
    const libc = koffi.load("libc.so.6");
    const getpid = libc.func("int getpid()");
    return { library: "libc.so.6", symbol: "getpid", value: getpid() };
  }
  throw new Error(`Unsupported package smoke platform: ${platform}`);
}

async function runPlatformProbe({ BrowserWindow, target }) {
  if (target.runtimePlatform === "win32") {
    const win = new BrowserWindow({ show: false, width: 80, height: 80, skipTaskbar: true });
    try {
      win.showInactive();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const { createCloakInspector } = require("./win-cloak-recovery");
      const { createForegroundFullscreenProbe } = require("./win-fullscreen-detect");
      const { createForegroundWindowsTerminalProbe } = require("./win-foreground-terminal");
      const logs = [];
      const cloak = createCloakInspector({ isWin: true, log: (line) => logs.push(line) });
      try {
        const onCurrentDesktop = cloak.isOnCurrentVirtualDesktop(win);
        const fullscreenErrors = [];
        const fullscreen = createForegroundFullscreenProbe({
          isWin: true,
          onError: (err) => fullscreenErrors.push(`init: ${err.message}`),
          onCallError: (err) => fullscreenErrors.push(`call: ${err.message}`),
        })();
        if (fullscreenErrors.length) {
          throw new Error(`Fullscreen probe failed: ${fullscreenErrors.join(" | ")}`);
        }
        if (typeof fullscreen !== "boolean") {
          throw new Error(`Fullscreen probe returned ${typeof fullscreen}`);
        }
        const terminalErrors = [];
        const foregroundTerminalHwnd = createForegroundWindowsTerminalProbe({
          isWin: true,
          onError: (err) => terminalErrors.push(`init: ${err.message}`),
          onCallError: (err) => terminalErrors.push(`call: ${err.message}`),
        })();
        if (terminalErrors.length) {
          throw new Error(`Foreground Windows Terminal probe failed: ${terminalErrors.join(" | ")}`);
        }
        if (foregroundTerminalHwnd !== null && !/^[1-9]\d*$/.test(foregroundTerminalHwnd)) {
          throw new Error(`Foreground Windows Terminal probe returned ${foregroundTerminalHwnd}`);
        }
        if (!cloak.available) throw new Error(`Cloak inspector unavailable: ${logs.join(" | ")}`);
        if (typeof onCurrentDesktop !== "boolean") {
          throw new Error(
            `Cloak inspector returned ${onCurrentDesktop} for a real packaged BrowserWindow ` +
            `(visible=${win.isVisible()} logs=${logs.join(" | ") || "none"})`
          );
        }
        return {
          cloakAvailable: cloak.available,
          cloakOnCurrentDesktop: onCurrentDesktop,
          foregroundFullscreen: fullscreen,
          foregroundTerminalHwnd,
          foregroundTerminalExpectedMiss: foregroundTerminalHwnd === null,
          logs,
        };
      } finally {
        cloak.dispose();
      }
    } finally {
      win.destroy();
    }
  }

  if (target.runtimePlatform === "darwin") {
    const win = new BrowserWindow({ show: false, width: 80, height: 80, skipTaskbar: true });
    try {
      const { applyStationaryCollectionBehavior } = require("./mac-window");
      const applied = applyStationaryCollectionBehavior(win);
      if (applied !== true) throw new Error("applyStationaryCollectionBehavior returned false");
      return { stationaryCollectionBehaviorApplied: true };
    } finally {
      win.destroy();
    }
  }

  return { windowProbe: "not-required" };
}

async function runPackageKoffiSmoke({ targetId, resourcesPath, BrowserWindow, userDataPath = "" } = {}) {
  const target = getReleaseTarget(targetId);
  const runtimeTarget = resolveRuntimeTarget();
  if (runtimeTarget.id !== target.id) {
    throw new Error(`Packaged runtime target mismatch: expected ${target.id}, got ${runtimeTarget.id}`);
  }
  if (!resourcesPath) throw new Error("Electron resourcesPath is unavailable");

  const { koffi, dlopenPath } = captureKoffiLoad();
  if (!dlopenPath) throw new Error("Koffi loaded without an observable process.dlopen path");
  const physicalPath = physicalAddonPath(dlopenPath);
  if (!fs.existsSync(physicalPath) || !fs.statSync(physicalPath).isFile()) {
    throw new Error(`Physical Koffi addon does not exist: ${physicalPath}`);
  }
  if (!isInside(resourcesPath, physicalPath)) {
    throw new Error(`Koffi addon loaded outside packaged resources: ${physicalPath}`);
  }
  const normalized = physicalPath.replace(/\\/g, "/");
  if (!normalized.includes(`/app.asar.unpacked/node_modules/koffi/build/koffi/${target.koffiTriplet}/koffi.node`)) {
    throw new Error(`Koffi addon path does not match ${target.koffiTriplet}: ${physicalPath}`);
  }
  const version = require("koffi/package.json").version;
  if (version !== "2.16.3") throw new Error(`Unexpected packaged Koffi version: ${version}`);

  const nativeCall = callStableNativeFunction(koffi, target.runtimePlatform);
  if (nativeCall.value !== process.pid) {
    throw new Error(`${nativeCall.symbol} returned ${nativeCall.value}; expected ${process.pid}`);
  }
  const addressType = typeof koffi.address(Buffer.alloc(8));
  if (addressType !== "bigint") throw new Error(`koffi.address(Buffer) returned ${addressType}`);
  const platformProbe = await runPlatformProbe({ BrowserWindow, target });

  return {
    schemaVersion: 1,
    ok: true,
    target: target.id,
    runtime: { platform: process.platform, arch: process.arch, pid: process.pid, userDataPath },
    koffi: {
      version,
      dlopenPath,
      physicalPath,
      addressType,
    },
    nativeCall,
    platformProbe,
  };
}

function writeResult(outputPath, result) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

function maybeRunPackageKoffiSmoke({ app, BrowserWindow, argv = process.argv.slice(1) } = {}) {
  let options;
  try {
    options = parseSmokeArgs(argv);
  } catch (err) {
    process.stderr.write(`${err && err.message ? err.message : String(err)}\n`);
    app.exit(1);
    return true;
  }
  if (!options) return false;

  const smokeUserData = path.join(
    path.dirname(options.outputPath),
    `.koffi-smoke-user-data-${process.pid}`,
  );
  fs.mkdirSync(smokeUserData, { recursive: true });
  app.setPath("userData", smokeUserData);
  app.commandLine.appendSwitch("user-data-dir", smokeUserData);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.whenReady().then(async () => {
    try {
      const result = await runPackageKoffiSmoke({
        targetId: options.targetId,
        resourcesPath: process.resourcesPath,
        BrowserWindow,
        userDataPath: smokeUserData,
      });
      writeResult(options.outputPath, result);
      app.exit(0);
    } catch (err) {
      writeResult(options.outputPath, {
        schemaVersion: 1,
        ok: false,
        target: options.targetId,
        error: err && err.stack ? err.stack : String(err),
      });
      app.exit(1);
    }
  });
  return true;
}

module.exports = {
  SMOKE_FLAG,
  TARGET_PREFIX,
  OUTPUT_PREFIX,
  comparablePath,
  isInside,
  parseSmokeArgs,
  physicalAddonPath,
  captureKoffiLoad,
  callStableNativeFunction,
  runPlatformProbe,
  runPackageKoffiSmoke,
  writeResult,
  maybeRunPackageKoffiSmoke,
};
