#!/usr/bin/env node

// Cross-platform launcher that ensures Electron runs in GUI mode.
//
// Claude Code (and other Electron-based tools) set ELECTRON_RUN_AS_NODE=1,
// which forces Electron to behave as a plain Node.js process — the browser
// layer never initializes, so `require("electron").app` is undefined.
//
// This launcher strips that variable before spawning the real Electron binary.

const { spawn } = require("child_process");
const path = require("path");
const electron = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = process.platform === "linux" ? [".", "--no-sandbox"] : ["."];
const child = spawn(electron, args, {
  stdio: "inherit",
  env,
  cwd: __dirname,
});

child.on("close", (code) => process.exit(code ?? 0));
