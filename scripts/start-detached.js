#!/usr/bin/env node

// Detached launcher for development use.
//
// Unlike `npm start`, this spawns Electron in the background so the shell can
// exit immediately while Clawd keeps running as a normal GUI app.

const { spawn } = require("child_process");
const path = require("path");
const electron = require("electron");

const repoRoot = path.join(__dirname, "..");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

if (process.platform === "linux") {
  env.ELECTRON_DISABLE_SANDBOX = "1";
  env.CHROME_DEVEL_SANDBOX = "";
}

const args = process.platform === "linux"
  ? [".", "--no-sandbox", "--disable-setuid-sandbox"]
  : ["."];

const child = spawn(electron, args, {
  cwd: repoRoot,
  env,
  detached: true,
  stdio: "ignore",
});

child.unref();

process.stdout.write(`Clawd started in background (pid ${child.pid})\n`);
