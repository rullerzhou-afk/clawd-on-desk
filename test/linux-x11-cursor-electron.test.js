"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Plain Node resolves libc.so.6 free() and the process-wide free() to the same
// glibc function, so only Electron, with Chromium's allocator shim, can tell a
// mismatched free() from the right one.
test("live X11 cursor queries free replies and errors without crashing Electron", { timeout: 35000 }, (t) => {
  if (process.platform !== "linux") return t.skip("Linux only");
  if (!process.env.DISPLAY) return t.skip("needs an X11 display");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-x11-cursor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [
    path.join(__dirname, "fixtures", "linux-x11-cursor-electron.js"),
    `--user-data-dir=${root}`,
    "--ozone-platform=x11",
    // Match the other Electron fixtures on Ubuntu CI, where the workspace's
    // Chromium setuid helper cannot satisfy the sandbox ownership contract.
    "--no-sandbox",
  ];
  const result = spawnSync(require("electron"), args,
    { env, encoding: "utf8", timeout: 30000, windowsHide: true });
  assert.ifError(result.error);
  if (/LINUX_X11_CURSOR_UNAVAILABLE/.test(result.stdout)) {
    return t.skip(`libxcb unavailable: ${result.stdout.trim()}`);
  }
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /LINUX_X11_CURSOR_ELECTRON_OK/);
});
