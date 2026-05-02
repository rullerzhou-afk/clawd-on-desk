#!/usr/bin/env node
// Clawd Desktop Pet — Auto-Start Script
// Registered as a SessionStart hook BEFORE clawd-hook.js.
// Checks if the Electron app is running; if not, launches it detached.
// Uses shared server discovery helpers and should exit quickly in normal cases.

const { spawn } = require("child_process");
const path = require("path");
const { discoverClawdPort } = require("./server-config");

const TIMEOUT_MS = 300;

discoverClawdPort({ timeoutMs: TIMEOUT_MS }, (port) => {
  if (port) {
    process.exit(0);
    return;
  }
  launchApp();
  process.exit(0);
});

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
      // Source / development mode — spawn Electron directly to avoid
      // a visible console window from the npm → launch.js chain.
      const projectDir = path.resolve(__dirname, "..");
      const electron = require("electron");
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      spawn(electron, [projectDir], {
        cwd: projectDir,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env,
      }).unref();
    }
  } catch (err) {
    process.stderr.write(`clawd auto-start: ${err.message}\n`);
  }
}
