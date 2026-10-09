#!/usr/bin/env node

// Cross-platform launcher that ensures Electron runs in GUI mode.
//
// Claude Code (and other Electron-based tools) set ELECTRON_RUN_AS_NODE=1,
// which forces Electron to behave as a plain Node.js process — the browser
// layer never initializes, so `require("electron").app` is undefined.
//
// This launcher strips that variable before spawning the real Electron binary.

const { spawn } = require("child_process");
const {
  verifyElectronInstall,
  formatElectronInstallFailure,
} = require("./scripts/verify-electron-install");

const electronInstall = verifyElectronInstall({ context: "launch" });
if (!electronInstall.ok) {
  process.stderr.write(`${formatElectronInstallFailure(electronInstall)}\n`);
  process.exit(1);
}

const electron = require("electron");
const { buildElectronLaunchConfig } = require("./hooks/shared-process");

const forwardedArgs = process.argv.slice(2);
const launchConfig = buildElectronLaunchConfig(__dirname, { forwardedArgs });
const child = spawn(electron, launchConfig.args, {
  stdio: "inherit",
  env: launchConfig.env,
  cwd: launchConfig.cwd,
});

child.on("close", (code) => process.exit(code ?? 0));
