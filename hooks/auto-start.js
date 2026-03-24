#!/usr/bin/env node
// Clawd Desktop Pet — Auto-Start Script
// Registered as a SessionStart hook BEFORE clawd-hook.js.
// Checks if the Electron app is running; if not, launches it detached.
// Zero dependencies, must exit in <500ms.

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const TIMEOUT_MS = 300;
const PORT = 23333;

// Check if app is already running
const req = http.get(
  { hostname: "127.0.0.1", port: PORT, path: "/state", timeout: TIMEOUT_MS },
  () => {
    // Any response (200, 404, etc.) means server is alive
    process.exit(0);
  }
);

req.on("error", () => {
  launchApp();
  process.exit(0);
});

req.on("timeout", () => {
  req.destroy();
  launchApp();
  process.exit(0);
});

function launchApp() {
  const isPackaged = __dirname.includes("app.asar");
  const isWin = process.platform === "win32";

  try {
    if (isPackaged) {
      if (isWin) {
        // __dirname: <install>/resources/app.asar.unpacked/hooks
        // exe:       <install>/Clawd on Desk.exe
        const installDir = path.resolve(__dirname, "..", "..", "..");
        const exe = path.join(installDir, "Clawd on Desk.exe");
        spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
      } else {
        // __dirname: <name>.app/Contents/Resources/app.asar.unpacked/hooks
        // .app bundle: 4 levels up
        const appBundle = path.resolve(__dirname, "..", "..", "..", "..");
        spawn("open", ["-a", appBundle], {
          detached: true,
          stdio: "ignore",
        }).unref();
      }
    } else {
      // Source / development mode
      const projectDir = path.resolve(__dirname, "..");
      const npm = isWin ? "npm.cmd" : "npm";
      spawn(npm, ["start"], {
        cwd: projectDir,
        detached: true,
        stdio: "ignore",
      }).unref();
    }
  } catch (err) {
    process.stderr.write(`clawd auto-start: ${err.message}\n`);
  }
}
