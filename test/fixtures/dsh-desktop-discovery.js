"use strict";

// Runs under both interpreters the ASAR lock test cares about: node.exe (plain
// fs) and electron.exe as a real main process, where the caller has cleared
// ELECTRON_RUN_AS_NODE so the ASAR-patched fs and its archive cache are live.
// Re-discovery is driven by a trigger file rather than stdin: an Electron main
// process on Windows never fires 'data' on its stdin pipe. Discovery prints its
// status after every trigger rewrite, so the test can replace app.asar
// underneath a still-running process.
const fs = require("fs");
const { discoverDshDesktopSync } = require(process.env.CLAWD_DSH_INSTALLER);

const options = {
  platform: "win32",
  env: {},
  windowsRegistrySnapshot: {
    uninstall: [{ installLocation: process.env.CLAWD_DSH_APP_ROOT }],
    commandDirectory: null,
  },
};
// src/agent-installation-detector.js hands discovery the default module as
// fs: options.fs || require("fs"), which is Electron's patched fs.
if (process.env.CLAWD_DSH_INJECT_DEFAULT_FS === "1") options.fs = require("fs");

function reportDiscovery() {
  console.log(discoverDshDesktopSync(options).status);
}

fs.watchFile(process.env.CLAWD_DSH_RECHECK_FILE, { interval: 50 }, reportDiscovery);
reportDiscovery();
