#!/usr/bin/env node
// Clawd Desktop Pet — Auto-Start Script
// Registered as a SessionStart hook BEFORE clawd-hook.js.
// Checks if the Electron app is running; if not, launches it detached.
// Uses shared server discovery helpers and should exit quickly in normal cases.

const { spawn } = require("child_process");
const path = require("path");
const { discoverClawdPort } = require("./server-config");
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

function launchApp() {
  const isPackaged = __dirname.includes("app.asar");
  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";

  try {
    if (isPackaged) {
      if (isWin) {
        // __dirname: <install>/resources/app.asar.unpacked/hooks
        // exe:       <install>/Clawd on Desk.exe
        const installDir = path.resolve(__dirname, "..", "..", "..");
        const exe = path.join(installDir, "Clawd on Desk.exe");
        spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
      } else if (isMac) {
        // __dirname: <name>.app/Contents/Resources/app.asar.unpacked/hooks
        // .app bundle: 4 levels up
        const appBundle = path.resolve(__dirname, "..", "..", "..", "..");
        spawn("open", ["-a", appBundle], {
          detached: true,
          stdio: "ignore",
        }).unref();
      } else {
        // Linux packaged app:
        // AppImage: process.env.APPIMAGE holds the .AppImage file path.
        // deb/dir:  executable is <install>/clawd-on-desk, same depth as Windows.
        //   __dirname: <install>/resources/app.asar.unpacked/hooks
        //   install:   3 levels up
        const appImage = process.env.APPIMAGE;
        if (appImage) {
          spawn(appImage, [], { detached: true, stdio: "ignore" }).unref();
        } else {
          const installDir = path.resolve(__dirname, "..", "..", "..");
          const exe = path.join(installDir, "clawd-on-desk");
          spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
        }
      }
    } else {
      // Source / development mode: start Electron directly so Windows does not
      // flash a console through the cmd/npm/launch.js process chain.
      const projectDir = path.resolve(__dirname, "..");
      const electron = require("electron");
      const launchConfig = buildElectronLaunchConfig(projectDir);
      spawn(electron, launchConfig.args, {
        cwd: launchConfig.cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: launchConfig.env,
      }).unref();
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
  launchApp,
  main,
};
