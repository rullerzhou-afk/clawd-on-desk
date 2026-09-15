"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

test("theme pickers stay anchored and bounded under real Settings CSS zoom", { timeout: 45_000 }, (t) => {
  let executable;
  try { executable = require("electron"); } catch { /* Optional local dependency. */ }
  if (typeof executable !== "string" || !executable) return t.skip("Electron executable is not installed");
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return t.skip("Electron layout audit needs a display (CI can use xvfb-run)");
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = ["--disable-gpu"];
  if (process.platform === "win32") args.push("--force-device-scale-factor=1.25");
  if (process.platform === "linux") args.push("--no-sandbox");
  const tempRoot = path.resolve(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(tempRoot, "clawd-picker-layout-"));
  env.CLAWD_PICKER_LAYOUT_PROFILE = profile;
  args.push(path.join(__dirname, "fixtures", "settings-picker-layout-electron.js"));
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
    assert.ok(path.basename(profile).startsWith("clawd-picker-layout-"));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
  assert.equal(result.status, 0,
    [result.error && result.error.message, result.stdout, result.stderr].filter(Boolean).join("\n")
      || `Electron exited ${result.status}`);
});
