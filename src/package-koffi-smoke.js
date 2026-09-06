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

// The fullscreen probe reports false, or the fullscreen window's identity: an
// opaque non-empty id string, degrading to plain true when koffi.address is
// unavailable. Anything else means the packaged FFI path is broken.
function assertFullscreenProbeValue(value) {
  const ok = value === false || value === true || (typeof value === "string" && value.length > 0);
  if (!ok) {
    const shape = typeof value === "string" ? "an empty string" : typeof value;
    throw new Error(`Fullscreen probe returned ${shape}`);
  }
  return value;
}

function nativeWindowHandleId(win) {
  if (!win || typeof win.getNativeWindowHandle !== "function") {
    throw new Error("Packaged fullscreen identity window has no native handle");
  }
  const handle = win.getNativeWindowHandle();
  if (!Buffer.isBuffer(handle) || handle.length < 4) {
    throw new Error("Packaged fullscreen identity window returned an invalid native handle buffer");
  }
  const value = handle.length >= 8
    ? handle.readBigUInt64LE(0)
    : BigInt(handle.readUInt32LE(0));
  if (value <= 0n) throw new Error("Packaged fullscreen identity window returned a null native handle");
  return String(value);
}

async function waitForFullscreenIdentity({
  win,
  fullscreenProbe,
  expectedId = null,
  timeoutMs = 8_000,
  sleepFn,
} = {}) {
  const sleep = sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  win.setFullScreen(true);
  win.show();
  win.focus();
  let lastValue = false;
  while (Date.now() <= deadline) {
    if (typeof win.isDestroyed === "function" && win.isDestroyed()) {
      throw new Error("Fullscreen identity window was destroyed before detection");
    }
    if (typeof win.isFocused === "function" && !win.isFocused()) win.focus();
    lastValue = assertFullscreenProbeValue(fullscreenProbe());
    if (
      typeof lastValue === "string"
      && lastValue.length > 0
      && (expectedId == null || lastValue === expectedId)
    ) return lastValue;
    await sleep(100);
  }
  const expected = expectedId == null ? "" : `, expected=${expectedId}`;
  throw new Error(
    `Packaged fullscreen probe did not return the requested window identity (last=${String(lastValue)}${expected})`,
  );
}

async function runWindowsFullscreenIdentityProbe({
  BrowserWindow,
  fullscreenProbe,
  koffi,
  timeoutMs = 8_000,
  sleepFn,
} = {}) {
  if (!fullscreenProbe || typeof fullscreenProbe.isWindowIdAlive !== "function") {
    throw new Error("Packaged fullscreen probe has no HWND liveness checker");
  }
  if (!koffi || typeof koffi.address !== "function" || typeof koffi.load !== "function") {
    throw new Error("Packaged fullscreen identity probe has no Koffi pointer support");
  }
  const GetAncestor = koffi.load("user32.dll").func(
    "void* __stdcall GetAncestor(void* hWnd, uint32 gaFlags)",
  );
  const ids = [];
  const windows = [];
  let foregroundControllable = false;
  try {
    for (let index = 0; index < 2; index += 1) {
      const win = new BrowserWindow({ show: false, width: 320, height: 240, skipTaskbar: true });
      windows.push(win);
      const expectedId = nativeWindowHandleId(win);
      // GetAncestor(GA_ROOT) returns this top-level BrowserWindow's HWND as a
      // Koffi external pointer. Comparing koffi.address() with Electron's
      // native-handle buffer proves the exact production identity conversion
      // without depending on a CI desktop that permits foreground focus.
      const hwnd = GetAncestor(BigInt(expectedId), 2);
      if (!hwnd) throw new Error(`GetAncestor rejected packaged HWND ${expectedId}`);
      const id = String(koffi.address(hwnd));
      if (id !== expectedId) {
        throw new Error(`Packaged Koffi HWND identity mismatch: expected=${expectedId}, actual=${id}`);
      }
      if (fullscreenProbe.isWindowIdAlive(id) !== true) {
        throw new Error(`IsWindow rejected live packaged fullscreen HWND ${id}`);
      }
      ids.push(id);
    }
    if (ids[0] === ids[1]) {
      throw new Error(`Packaged fullscreen identities collapsed to the same value: ${ids[0]}`);
    }

    // BrowserWindow.destroy() does not give the smoke a portable guarantee
    // that the underlying HWND has already left the process-wide handle table:
    // Windows may finish native teardown asynchronously, and a handle value may
    // be reused immediately. Validate the negative IsWindow/BigInt path with
    // INVALID_HANDLE_VALUE instead, while both observed HWNDs remain live so
    // their identity-distinctness assertion cannot be defeated by handle reuse.
    const invalidWindowId = "18446744073709551615";
    if (fullscreenProbe.isWindowIdAlive(invalidWindowId) !== false) {
      throw new Error(`IsWindow accepted invalid packaged HWND ${invalidWindowId}`);
    }

    // The x64 hosted desktop allows BrowserWindows to own the foreground, so
    // retain the end-to-end geometry/fullscreen probe there. Windows ARM64
    // hosted runners may deny every focus request; record that environment
    // limitation only after the architecture-sensitive pointer/liveness proof
    // above has passed.
    try {
      await waitForFullscreenIdentity({
        win: windows[0],
        fullscreenProbe,
        expectedId: ids[0],
        timeoutMs: Math.min(timeoutMs, 2_000),
        sleepFn,
      });
      foregroundControllable = true;
    } catch (err) {
      if (!/did not return the requested window identity/.test(String(err && err.message))) throw err;
    }
  } finally {
    for (const win of windows) {
      if (typeof win.isDestroyed !== "function" || !win.isDestroyed()) win.destroy();
    }
  }
  return {
    firstId: ids[0],
    secondId: ids[1],
    distinct: true,
    nativeRoundTrip: true,
    liveAccepted: true,
    invalidRejected: true,
    foregroundControllable,
    fullscreenObserved: foregroundControllable,
  };
}

async function waitForSmokeCondition(check, label, { timeoutMs = 8_000, sleepFn } = {}) {
  const sleep = sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (check()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for packaged smoke condition: ${label}`);
}

async function runWindowsFullscreenAutoHideRuntimeProbe({
  BrowserWindow,
  fullscreenProbe,
  hitActivation,
  timeoutMs = 8_000,
} = {}) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const createPetWindow = (x, backgroundColor) => {
    const win = new BrowserWindow({
      show: false,
      x,
      y: 40,
      width: 180,
      height: 180,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      backgroundColor,
      focusable: false,
    });
    win.showInactive();
    win.setAlwaysOnTop(true, "pop-up-menu");
    return win;
  };

  const renderWin = createPetWindow(40, "#245c3a");
  const hitWin = createPetWindow(240, "#5c2424");
  const fullscreenWindows = [];
  let topmostRuntime = null;
  try {
    const createPetWindowRuntime = require("./pet-window-runtime");
    const createTopmostRuntime = require("./topmost-runtime");
    const petWindowRuntime = createPetWindowRuntime({
      isWin: true,
      topmostLevel: "pop-up-menu",
      getRenderWindow: () => renderWin,
      getHitWindow: () => hitWin,
      noteManualPetShow: () => topmostRuntime.noteFullscreenAutoHideOverride(),
      reassertWinTopmost: (...args) => topmostRuntime.reassertWinTopmost(...args),
    });
    topmostRuntime = createTopmostRuntime({
      isWin: true,
      getWin: () => renderWin,
      getHitWin: () => hitWin,
      isForegroundFullscreen: () => fullscreenProbe(),
      getForegroundFullscreenObservation: () => fullscreenProbe.getLastObservation(),
      isFullscreenWindowAlive: (id) => fullscreenProbe.isWindowIdAlive(id),
      getFullscreenAutoHide: () => true,
      getFullscreenOverlay: () => false,
      setFullscreenAutoHidden: (...args) => petWindowRuntime.setFullscreenAutoHidden(...args),
      isFullscreenAutoHidden: () => petWindowRuntime.isFullscreenAutoHidden(),
      setHitWinFocusable: (focusable) => hitActivation.setFocusable(hitWin, focusable),
    });
    topmostRuntime.startFocusablePoll();

    const firstFullscreen = new BrowserWindow({ show: false, width: 320, height: 240, skipTaskbar: true });
    fullscreenWindows.push(firstFullscreen);
    const firstId = await waitForFullscreenIdentity({
      win: firstFullscreen,
      fullscreenProbe,
      timeoutMs,
    });
    await waitForSmokeCondition(
      () => petWindowRuntime.isFullscreenAutoHidden() && !renderWin.isVisible() && !hitWin.isVisible(),
      "pet windows to auto-hide over first fullscreen HWND",
      { timeoutMs },
    );

    // Model a tray/Alt-Tab excursion that outlasts the old 15-tick arming
    // window. The original fullscreen HWND stays alive in the background.
    const excursionWindow = new BrowserWindow({ show: false, width: 420, height: 280, skipTaskbar: true });
    fullscreenWindows.push(excursionWindow);
    excursionWindow.show();
    excursionWindow.focus();
    await waitForSmokeCondition(
      () => !petWindowRuntime.isFullscreenAutoHidden() && renderWin.isVisible() && hitWin.isVisible(),
      "pet windows to restore during a foreground excursion",
      { timeoutMs },
    );
    await sleep(createTopmostRuntime.FSAUTOHIDE_OVERRIDE_GRACE_TICKS * 1_000 + 1_500);

    const showResult = petWindowRuntime.setPetHidden(false);
    if (!showResult.applied || !renderWin.isVisible() || !hitWin.isVisible()) {
      throw new Error("Manual Show did not override packaged fullscreen auto-hide");
    }
    const returnedId = await waitForFullscreenIdentity({
      win: firstFullscreen,
      fullscreenProbe,
      timeoutMs,
    });
    if (returnedId !== firstId) throw new Error("Original fullscreen HWND identity changed across excursion");
    await sleep(2_500);
    if (petWindowRuntime.isFullscreenAutoHidden() || !renderWin.isVisible() || !hitWin.isVisible()) {
      throw new Error("Long foreground excursion expired the original fullscreen Show override");
    }

    const secondFullscreen = new BrowserWindow({ show: false, width: 360, height: 260, skipTaskbar: true });
    fullscreenWindows.push(secondFullscreen);
    const secondId = await waitForFullscreenIdentity({
      win: secondFullscreen,
      fullscreenProbe,
      timeoutMs,
    });
    if (secondId === firstId) throw new Error("Second fullscreen app reused the first active HWND identity");
    await waitForSmokeCondition(
      () => petWindowRuntime.isFullscreenAutoHidden() && !renderWin.isVisible() && !hitWin.isVisible(),
      "different fullscreen HWND to end the manual Show override",
      { timeoutMs },
    );

    secondFullscreen.destroy();
    firstFullscreen.destroy();
    await waitForSmokeCondition(
      () => !petWindowRuntime.isFullscreenAutoHidden() && renderWin.isVisible() && hitWin.isVisible(),
      "pet windows to restore after fullscreen exit",
      { timeoutMs },
    );
    if (!renderWin.isAlwaysOnTop() || !hitWin.isAlwaysOnTop()) {
      throw new Error("Restored packaged pet windows did not immediately regain topmost");
    }

    // The most recently remembered fullscreen HWND is now dead. A Show must
    // discard it through IsWindow and fall back to the ordinary bounded grace;
    // after that grace expires, a new fullscreen HWND must hide normally.
    petWindowRuntime.setPetHidden(false);
    await sleep(createTopmostRuntime.FSAUTOHIDE_OVERRIDE_GRACE_TICKS * 1_000 + 1_500);
    const thirdFullscreen = new BrowserWindow({ show: false, width: 400, height: 300, skipTaskbar: true });
    fullscreenWindows.push(thirdFullscreen);
    await waitForFullscreenIdentity({
      win: thirdFullscreen,
      fullscreenProbe,
      timeoutMs,
    });
    await waitForSmokeCondition(
      () => petWindowRuntime.isFullscreenAutoHidden() && !renderWin.isVisible() && !hitWin.isVisible(),
      "new fullscreen HWND to hide after dead-episode grace expired",
      { timeoutMs },
    );
    thirdFullscreen.destroy();
    await waitForSmokeCondition(
      () => !petWindowRuntime.isFullscreenAutoHidden() && renderWin.isVisible() && hitWin.isVisible(),
      "pet windows to restore after dead-episode regression check",
      { timeoutMs },
    );

    return {
      firstAutoHidden: true,
      longExcursionOverrideHeld: true,
      manualShowVisible: true,
      differentFullscreenRehidden: true,
      exitRestoredVisible: true,
      exitRestoredTopmost: true,
      deadEpisodeDidNotLeak: true,
    };
  } finally {
    if (topmostRuntime) topmostRuntime.cleanup();
    for (const win of fullscreenWindows) {
      if (!win.isDestroyed()) win.destroy();
    }
    if (!renderWin.isDestroyed()) renderWin.destroy();
    if (!hitWin.isDestroyed()) hitWin.destroy();
  }
}

function runHitWindowNoActivateRoundTrip(hitActivation, win, errors = []) {
  const describeErrors = () => errors.join(" | ");
  const initialNonActivating = hitActivation.isNonActivating(win);
  if (initialNonActivating !== true) {
    throw new Error(`Packaged WS_EX_NOACTIVATE initial state missing: ${describeErrors()}`);
  }
  if (!hitActivation.setFocusable(win, true) || hitActivation.isNonActivating(win) !== false) {
    throw new Error(`Packaged WS_EX_NOACTIVATE initial clear failed: ${describeErrors()}`);
  }
  if (!hitActivation.setFocusable(win, false) || hitActivation.isNonActivating(win) !== true) {
    throw new Error(`Packaged WS_EX_NOACTIVATE enable failed: ${describeErrors()}`);
  }
  if (!hitActivation.setFocusable(win, true) || hitActivation.isNonActivating(win) !== false) {
    throw new Error(`Packaged WS_EX_NOACTIVATE final restore failed: ${describeErrors()}`);
  }
  return {
    initialNonActivating: true,
    afterInitialClear: false,
    afterFullscreenEnable: true,
    afterFinalRestore: false,
  };
}

async function runPlatformProbe({ BrowserWindow, target, koffi }) {
  if (target.runtimePlatform === "win32") {
    const win = new BrowserWindow({
      show: false,
      width: 80,
      height: 80,
      skipTaskbar: true,
      focusable: false,
    });
    try {
      win.showInactive();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const { createCloakInspector } = require("./win-cloak-recovery");
      const { createForegroundFullscreenProbe } = require("./win-fullscreen-detect");
      const { createForegroundWindowsTerminalProbe } = require("./win-foreground-terminal");
      const { createHitWindowActivationController } = require("./win-hit-window-activation");
      const logs = [];
      const cloak = createCloakInspector({ isWin: true, log: (line) => logs.push(line) });
      try {
        const onCurrentDesktop = cloak.isOnCurrentVirtualDesktop(win);
        const fullscreenErrors = [];
        const fullscreenProbe = createForegroundFullscreenProbe({
          isWin: true,
          onError: (err) => fullscreenErrors.push(`init: ${err.message}`),
          onCallError: (err) => fullscreenErrors.push(`call: ${err.message}`),
        });
        const fullscreen = fullscreenProbe();
        if (fullscreenErrors.length) {
          throw new Error(`Fullscreen probe failed: ${fullscreenErrors.join(" | ")}`);
        }
        assertFullscreenProbeValue(fullscreen);
        const fullscreenIdentity = await runWindowsFullscreenIdentityProbe({
          BrowserWindow,
          fullscreenProbe,
          koffi,
        });
        const hitActivationErrors = [];
        const hitActivation = createHitWindowActivationController({
          isWin: true,
          koffi,
          onError: (err) => hitActivationErrors.push(err && err.message ? err.message : String(err)),
        });
        if (!hitActivation.available) {
          throw new Error(`Hit-window activation controller unavailable: ${hitActivationErrors.join(" | ")}`);
        }
        const hitWindowNoActivateRoundTrip = runHitWindowNoActivateRoundTrip(
          hitActivation,
          win,
          hitActivationErrors,
        );
        const fullscreenAutoHideRuntime = fullscreenIdentity.foregroundControllable
          ? await runWindowsFullscreenAutoHideRuntimeProbe({
            BrowserWindow,
            fullscreenProbe,
            hitActivation,
          })
          : {
            skipped: true,
            reason: "packaged-runner-cannot-focus-browser-windows",
            nativeIdentityAndLivenessPassed: true,
          };
        if (fullscreenErrors.length) {
          throw new Error(`Fullscreen identity probe failed: ${fullscreenErrors.join(" | ")}`);
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
          fullscreenIdentity,
          fullscreenAutoHideRuntime,
          hitWindowNoActivateRoundTrip,
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
  const platformProbe = await runPlatformProbe({ BrowserWindow, target, koffi });

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
  assertFullscreenProbeValue,
  nativeWindowHandleId,
  waitForFullscreenIdentity,
  runWindowsFullscreenIdentityProbe,
  waitForSmokeCondition,
  runWindowsFullscreenAutoHideRuntimeProbe,
  runHitWindowNoActivateRoundTrip,
  runPlatformProbe,
  runPackageKoffiSmoke,
  writeResult,
  maybeRunPackageKoffiSmoke,
};
