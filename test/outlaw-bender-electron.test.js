"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function electronExecutable() {
  try {
    const value = require("electron");
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

test("outlaw bender completes and restarts in Electron's production object SVG channel", { timeout: 30_000 }, (t) => {
  const executable = electronExecutable();
  if (!executable) return t.skip("Electron executable is not installed");
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return t.skip("Electron bender audit needs an X11/Wayland display (CI can use xvfb-run)");
  }

  const fixture = path.join(__dirname, "fixtures", "outlaw-bender-electron.js");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-bender-electron-"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = ["--disable-gpu"];
  args.push(`--user-data-dir=${profile}`);
  if (process.platform === "linux") args.push("--no-sandbox");
  args.push(fixture);
  let result;
  try {
    result = spawnSync(executable, args, {
      env,
      encoding: "utf8",
      timeout: 25_000,
    });
  } finally {
    const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
    const resolvedProfile = path.resolve(profile);
    assert.ok(resolvedProfile.startsWith(tempRoot), "Electron profile must stay under the temp root");
    fs.rmSync(resolvedProfile, { recursive: true, force: true });
  }

  assert.strictEqual(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join("\n") || `Electron exited ${result.status}`
  );
});
