"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function electronExecutable() {
  try {
    const executable = require("electron");
    return typeof executable === "string" && executable ? executable : null;
  } catch {
    return null;
  }
}

test("display scale compositor: production SVG zoom, sampling and accessory geometry survive display changes", { timeout: 180_000 }, (t) => {
  const executable = electronExecutable();
  if (!executable) return t.skip("Electron executable is not installed");
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return t.skip("Electron display scale audit needs an X11/Wayland display (CI can use xvfb-run)");
  }

  const fixture = path.join(__dirname, "fixtures", "display-scale-compositor-electron.js");
  const snapshots = [];
  for (const scale of [1, 1.25, 1.5, 2]) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-display-scale-electron-"));
    const env = { ...process.env, CLAWD_ELECTRON_AUDIT_SCALE: String(scale) };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = [`--force-device-scale-factor=${scale}`, `--user-data-dir=${profile}`];
    if (process.platform === "linux") args.push("--no-sandbox");
    args.push(fixture);
    let result;
    try {
      result = spawnSync(executable, args, { env, encoding: "utf8", timeout: 25_000 });
    } finally {
      const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
      const resolvedProfile = path.resolve(profile);
      assert.ok(resolvedProfile.startsWith(tempRoot), "Electron profile must stay under the temp root");
      fs.rmSync(resolvedProfile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    const diagnostics = [result.stdout, result.stderr, result.error && result.error.message].filter(Boolean).join("\n");
    assert.strictEqual(result.status, 0, `scale ${scale}: ${diagnostics || `Electron exited ${result.status}`}`);
    const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith('{"displayScaleCompositor":'));
    assert.ok(line, `scale ${scale}: missing JSON snapshot\n${diagnostics}`);
    const snapshot = JSON.parse(line);
    assert.ok(Math.abs(snapshot.devicePixelRatio - scale) < 0.01, `scale ${scale}: unexpected devicePixelRatio`);
    assert.strictEqual(snapshot.display, "", `scale ${scale}: root display was not restored`);
    if (scale === 1) assert.strictEqual(snapshot.zoom, "");
    else assert.ok(Math.abs(Number(snapshot.zoom) - 1 / scale) < 0.00001, `scale ${scale}: incorrect root zoom`);
    assert.ok(snapshot.animationCount > 0, `scale ${scale}: missing animations`);
    assert.ok(snapshot.sampledCount > 0, `scale ${scale}: missing steps() sampling`);
    assert.strictEqual(snapshot.unlistedZoom, "", `scale ${scale}: unlisted document received zoom`);
    snapshots.push(snapshot);
  }

  const baseline = snapshots[0];
  for (const snapshot of snapshots.slice(1)) {
    for (let index = 0; index < baseline.normalizedMatrix.length; index++) {
      const dimension = index % 2 === 0 ? "width" : "height";
      // Each viewport may round to a different device pixel. Compare the
      // projected unit rectangle relative to its media box with that allowance.
      const tolerance = 1 / (baseline.devicePixelRatio * baseline.mediaBox[dimension])
        + 1 / (snapshot.devicePixelRatio * snapshot.mediaBox[dimension]) + 0.000001;
      assert.ok(
        Math.abs(snapshot.normalizedMatrix[index] - baseline.normalizedMatrix[index]) <= tolerance,
        `scale ${snapshot.devicePixelRatio}: accessory matrix[${index}] drifted beyond one device pixel per viewport`,
      );
    }
  }
  assert.deepStrictEqual(baseline.zoomChanges.map((change) => change.devicePixelRatio), [1.5, 1]);
  assert.ok(Math.abs(Number(baseline.zoomChanges[0].zoom) - 1 / 1.5) < 0.00001);
  assert.strictEqual(baseline.zoomChanges[1].zoom, "");
});
