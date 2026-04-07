#!/usr/bin/env node

// Cross-platform launcher that ensures Electron runs in GUI mode.
//
// Claude Code (and other Electron-based tools) set ELECTRON_RUN_AS_NODE=1,
// which forces Electron to behave as a plain Node.js process — the browser
// layer never initializes, so `require("electron").app` is undefined.
//
// This launcher strips that variable before spawning the real Electron binary.

const { spawn } = require("child_process");
const electron = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (process.platform === "linux") {
  // Some environments still trip Chromium sandbox initialization even with
  // argv flags; force-disable via env too for local dev reliability.
  env.ELECTRON_DISABLE_SANDBOX = "1";
  env.CHROME_DEVEL_SANDBOX = "";
}

const args = process.platform === "linux"
  ? [".", "--no-sandbox", "--disable-setuid-sandbox"]
  : ["."];
const child = spawn(electron, args, {
  stdio: "inherit",
  env,
  cwd: __dirname,
});

child.on("close", (code) => process.exit(code ?? 0));
