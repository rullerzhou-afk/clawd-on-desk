#!/usr/bin/env node
// Clawd Desktop Pet — Auto-Start Script
// Registered as a SessionStart hook BEFORE clawd-hook.js.
// Checks if the Electron app is running; if not, launches it detached.
// Uses shared server discovery helpers and should exit quickly in normal cases.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  APPIMAGE_HOOK_MARKER_FILE,
  discoverClawdPort,
} = require("./server-config");
const { buildElectronLaunchConfig } = require("./shared-process");

const INITIAL_DISCOVER_TIMEOUT_MS = 300;
const STARTUP_READY_TIMEOUT_MS = 6000;
const STARTUP_DISCOVER_TIMEOUT_MS = 100;
const STARTUP_POLL_INTERVAL_MS = 100;

function waitForClawdPort(options, callback) {
  const discover = options.discoverClawdPort || discoverClawdPort;
  const setTimeoutFn = options.setTimeout || setTimeout;
  const nowFn = options.now || Date.now;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : STARTUP_READY_TIMEOUT_MS;
  const discoverTimeoutMs = Number.isFinite(options.discoverTimeoutMs)
    ? options.discoverTimeoutMs
    : STARTUP_DISCOVER_TIMEOUT_MS;
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : STARTUP_POLL_INTERVAL_MS;
  const deadline = nowFn() + Math.max(0, timeoutMs);

  function probe() {
    discover({ timeoutMs: discoverTimeoutMs }, (port) => {
      if (port || nowFn() >= deadline) {
        callback(port || null);
        return;
      }
      setTimeoutFn(probe, intervalMs);
    });
  }

  probe();
}

function decodeXmlText(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function resolveMacBundleExecutable(appBundle, options = {}) {
  const fsApi = options.fs || fs;
  let executableName = null;
  try {
    const plist = fsApi.readFileSync(
      path.posix.join(appBundle, "Contents", "Info.plist"),
      "utf8"
    );
    const match = plist.match(
      /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/i
    );
    const candidate = match ? decodeXmlText(match[1]).trim() : "";
    if (
      candidate
      && candidate !== "."
      && candidate !== ".."
      && !candidate.includes("/")
      && !candidate.includes("\\")
    ) {
      executableName = candidate;
    }
  } catch {}
  // electron-builder's productName is the stable executable name even when a
  // user renames or copies the outer .app bundle in Finder.
  if (!executableName) executableName = "Clawd on Desk";
  return path.posix.join(appBundle, "Contents", "MacOS", executableName);
}

function resolveAppImageExecutable(hooksDir, options = {}) {
  const fsApi = options.fs || fs;
  const candidates = [];
  try {
    candidates.push(
      fsApi.readFileSync(path.posix.join(hooksDir, APPIMAGE_HOOK_MARKER_FILE), "utf8")
    );
  } catch {}
  // APPIMAGE belongs to the running AppImage process, not arbitrary source
  // shells. Only trust the environment fallback while executing from the
  // packaged asar tree; materialized hooks use the adjacent marker above.
  if (hooksDir.includes("app.asar")) {
    const env = options.env || process.env;
    candidates.push(
      typeof options.appImagePath === "string" ? options.appImagePath : "",
      env && typeof env.APPIMAGE === "string" ? env.APPIMAGE : ""
    );
  }
  for (const value of candidates) {
    const candidate = String(value || "").trim();
    if (candidate && path.posix.isAbsolute(candidate)) return candidate;
  }
  return null;
}

function spawnDetached(spawnProcess, command, args, options, onError) {
  const child = spawnProcess(command, args, options);
  if (child && typeof child.once === "function") {
    child.once("error", (err) => {
      onError(err);
    });
  }
  if (child && typeof child.unref === "function") child.unref();
  return child;
}

function main(deps = {}) {
  const discover = deps.discoverClawdPort || discoverClawdPort;
  const launch = deps.launchApp || launchApp;
  const exit = deps.exit || ((code) => process.exit(code));

  discover({ timeoutMs: INITIAL_DISCOVER_TIMEOUT_MS }, (port) => {
    if (port) {
      exit(0);
      return;
    }
    launch();
    waitForClawdPort({
      discoverClawdPort: discover,
      setTimeout: deps.setTimeout,
      now: deps.now,
      timeoutMs: deps.startupReadyTimeoutMs,
      discoverTimeoutMs: deps.startupDiscoverTimeoutMs,
      intervalMs: deps.startupPollIntervalMs,
    }, () => exit(0));
  });
}

function launchApp(options = {}) {
  const hooksDir = options.hooksDir || __dirname;
  const platform = options.platform || process.platform;
  const spawnProcess = options.spawn || spawn;
  const onSpawnError = options.onSpawnError || ((err) => {
    process.stderr.write(`clawd auto-start: ${err && err.message ? err.message : err}\n`);
  });
  const isWin = platform === "win32";
  const isMac = platform === "darwin";
  const appImage = platform === "linux"
    ? resolveAppImageExecutable(hooksDir, options)
    : null;
  const isPackaged = hooksDir.includes("app.asar") || !!appImage;

  try {
    if (isPackaged) {
      if (isWin) {
        // __dirname: <install>/resources/app.asar.unpacked/hooks
        // exe:       <install>/Clawd on Desk.exe
        const installDir = path.resolve(hooksDir, "..", "..", "..");
        const exe = path.join(installDir, "Clawd on Desk.exe");
        spawnDetached(
          spawnProcess,
          exe,
          [],
          { detached: true, stdio: "ignore" },
          onSpawnError
        );
      } else if (isMac) {
        // __dirname: <name>.app/Contents/Resources/app.asar.unpacked/hooks
        // .app bundle: 4 levels up
        const appBundle = path.posix.resolve(hooksDir, "..", "..", "..", "..");
        const executable = resolveMacBundleExecutable(appBundle, {
          fs: options.fs,
        });
        // Launch the bundle executable directly. LaunchServices can create a
        // process without bringing an unpacked or unregistered bundle to a
        // ready state, which drops the cold SessionStart during packaged
        // smoke testing.
        spawnDetached(
          spawnProcess,
          executable,
          [],
          { detached: true, stdio: "ignore" },
          onSpawnError
        );
      } else {
        // Linux packaged app:
        // AppImage: process.env.APPIMAGE holds the .AppImage file path.
        // deb/dir:  executable is <install>/clawd-on-desk, same depth as Windows.
        //   __dirname: <install>/resources/app.asar.unpacked/hooks
        //   install:   3 levels up
        if (appImage) {
          spawnDetached(
            spawnProcess,
            appImage,
            [],
            { detached: true, stdio: "ignore" },
            onSpawnError
          );
        } else {
          const installDir = path.posix.resolve(hooksDir, "..", "..", "..");
          const exe = path.posix.join(installDir, "clawd-on-desk");
          spawnDetached(
            spawnProcess,
            exe,
            [],
            { detached: true, stdio: "ignore" },
            onSpawnError
          );
        }
      }
    } else {
      // Source / development mode: start Electron directly so Windows does not
      // flash a console through the cmd/npm/launch.js process chain.
      const projectDir = path.resolve(hooksDir, "..");
      const electron = options.electron || require("electron");
      const launchConfig = buildElectronLaunchConfig(projectDir);
      spawnDetached(
        spawnProcess,
        electron,
        launchConfig.args,
        {
          cwd: launchConfig.cwd,
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          env: launchConfig.env,
        },
        onSpawnError
      );
    }
  } catch (err) {
    process.stderr.write(`clawd auto-start: ${err.message}\n`);
  }
}

if (require.main === module) main();

module.exports = {
  INITIAL_DISCOVER_TIMEOUT_MS,
  STARTUP_READY_TIMEOUT_MS,
  STARTUP_DISCOVER_TIMEOUT_MS,
  STARTUP_POLL_INTERVAL_MS,
  waitForClawdPort,
  resolveAppImageExecutable,
  resolveMacBundleExecutable,
  launchApp,
  main,
};
