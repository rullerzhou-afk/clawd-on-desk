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

test("cigarette SMIL advances and restarts in the production mouth object channel", { timeout: 30_000 }, (t) => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");
  assert.match(source, /<object id="clawd-mouth-accessory"[^>]*type="image\/svg\+xml"/);

  const executable = electronExecutable();
  if (!executable) return t.skip("Electron executable is not installed");
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return t.skip("Electron cigarette audit needs an X11/Wayland display (CI can use xvfb-run)");
  }

  const fixture = path.join(__dirname, "fixtures", "cigarette-accessory-electron.js");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-cigarette-electron-"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Fractional scale factors round the embedded SVG viewport to whole device
  // pixels (50x90 css at 125% lands at 50.4x90.4), breaking the fixture's 0.1px fill check.
  const args = ["--disable-gpu", "--force-device-scale-factor=1", `--user-data-dir=${profile}`];
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
    fs.rmSync(resolvedProfile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }

  assert.strictEqual(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join("\n") || `Electron exited ${result.status}`
  );
});
