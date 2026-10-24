"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
test("result cards render and interact in isolated Electron windows", { timeout: 45_000 }, t => {
  let executable;
  try { executable = require("electron"); } catch {}
  if (typeof executable !== "string") return t.skip("Electron not installed");
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return t.skip("A desktop display is required");
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-results-test-"));
  const env = { ...process.env, CLAWD_RESULT_TEST_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = ["--disable-gpu"];
  if (process.platform === "linux") args.push("--no-sandbox");
  args.push(path.join(__dirname, "fixtures/session-result-electron.js"));
  let result;
  try { result = spawnSync(executable, args, { env, encoding: "utf8", timeout: 40000, windowsHide: true }); }
  finally { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); }
  assert.equal(result.status, 0, [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n"));
});
