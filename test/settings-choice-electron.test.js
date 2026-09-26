"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("Settings choices preserve native keyboard activation, focus and accessibility roles", { timeout: 45_000 }, (t) => {
  let executable;
  try { executable = require("electron"); } catch { /* Optional dependency. */ }
  if (typeof executable !== "string") return t.skip("Electron executable is not installed");
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return t.skip("Electron requires a display (use xvfb-run in CI)");
  }
  const tempRoot = path.resolve(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(tempRoot, "clawd-choice-test-"));
  const env = { ...process.env, CLAWD_CHOICE_TEST_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = ["--disable-gpu"];
  if (process.platform === "linux") args.push("--no-sandbox");
  args.push(path.join(__dirname, "fixtures", "settings-choice-electron.js"));
  let result;
  try {
    result = spawnSync(executable, args, { env, encoding: "utf8", windowsHide: true, timeout: 40_000 });
  } finally {
    assert.equal(path.dirname(path.resolve(profile)), tempRoot);
    assert.ok(path.basename(profile).startsWith("clawd-choice-test-"));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
  assert.equal(result.status, 0, [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n"));
});
