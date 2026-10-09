"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("browser permission POST has no approval UI; native A/B decisions stay separate", { timeout: 35000 }, (t) => {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return t.skip("Electron permission smoke needs an X11/Wayland display");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-ingress-electron-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, CLAWD_INGRESS_EXPECT_BLOCKED: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAWD_INGRESS_EVIDENCE_DIR;
  const args = [
    path.join(__dirname, "fixtures", "permission-ingress-electron.js"),
    `--user-data-dir=${root}`,
  ];
  // Match the other Electron fixtures on Ubuntu CI, where the workspace's
  // Chromium setuid helper cannot satisfy the sandbox ownership contract.
  if (process.platform === "linux") args.push("--no-sandbox");
  const result = spawnSync(require("electron"), args,
    { env, encoding: "utf8", timeout: 30000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PERMISSION_INGRESS_ELECTRON_OK/);
});
