"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

test("detail polish stays centred and unbroken under real Settings layout", { timeout: 45_000 }, (t) => {
  let executable;
  try { executable = require("electron"); } catch { /* Optional local dependency. */ }
  if (typeof executable !== "string" || !executable) return t.skip("Electron executable is not installed");
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return t.skip("Electron layout audit needs a display (CI can use xvfb-run)");
  }
  const env = { ...process.env };
  // The host harness may run every child as Node; a real Electron main process
  // must not inherit that.
  delete env.ELECTRON_RUN_AS_NODE;
  const args = ["--disable-gpu"];
  if (process.platform === "win32") args.push("--force-device-scale-factor=1.25");
  if (process.platform === "linux") args.push("--no-sandbox");
  const tempRoot = path.resolve(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(tempRoot, "clawd-detail-polish-"));
  env.CLAWD_DETAIL_POLISH_PROFILE = profile;
  args.push(path.join(__dirname, "fixtures", "settings-detail-polish-electron.js"));
  let result;
  try {
    result = spawnSync(executable, args, {
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 40_000,
    });
  } finally {
    assert.equal(path.dirname(path.resolve(profile)), tempRoot);
    assert.ok(path.basename(profile).startsWith("clawd-detail-polish-"));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
  assert.equal(result.status, 0,
    [result.error && result.error.message, result.stdout, result.stderr].filter(Boolean).join("\n")
      || `Electron exited ${result.status}`);
});
