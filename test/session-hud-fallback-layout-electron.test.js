"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("untitled HUD tags remain contained at large text sizes with long elapsed labels", { timeout: 60_000 }, (t) => {
  let executable;
  try { executable = require("electron"); } catch { /* Optional local dependency. */ }
  if (typeof executable !== "string" || !executable) return t.skip("Electron executable is not installed");
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return t.skip("Electron layout audit needs a display (CI can use xvfb-run)");
  }
  const tempRoot = path.resolve(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(tempRoot, "clawd-hud-fallback-layout-"));
  const env = { ...process.env, CLAWD_HUD_LAYOUT_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = ["--disable-gpu"];
  if (process.platform === "win32") args.push("--force-device-scale-factor=1.25");
  if (process.platform === "linux") args.push("--no-sandbox");
  args.push(path.join(__dirname, "fixtures", "session-hud-fallback-layout-electron.js"));
  let result;
  try {
    result = spawnSync(executable, args, { env, encoding: "utf8", windowsHide: true, timeout: 55_000 });
  } finally {
    assert.equal(path.dirname(path.resolve(profile)), tempRoot);
    assert.ok(path.basename(profile).startsWith("clawd-hud-fallback-layout-"));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
  assert.equal(result.status, 0,
    [result.error && result.error.message, result.stdout, result.stderr].filter(Boolean).join("\n")
      || `Electron exited ${result.status}`);
});
