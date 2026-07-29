"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const asar = require("@electron/asar");
const {
  isRetiredPath,
  inspectRetiredTelegramSidecar,
  stableJson,
  parseArgs,
} = require("../scripts/assert-no-retired-telegram-sidecar");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawd-retired-tg-"));
}

test("retired binary and source paths are fail-closed", () => {
  for (const value of [
    "sidecars/cc-connect-clawd/windows-x64/cc-connect-clawd.exe",
    "other/cc-connect-clawd",
    "src/telegram-approval-sidecar.js",
    "src/telegram-approval-client.js",
    "src/telegram-owner-manager.js",
    "src/telegram-sidecar-status-bridge.js",
  ]) {
    assert.equal(isRetiredPath(value), true, value);
  }
  assert.equal(isRetiredPath("src/telegram-native-runner.js"), false);
  assert.equal(isRetiredPath("resources/icon.ico"), false);
});

test("clean resources and a real clean app.asar pass deterministically", async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "icon.ico"), "icon");
  const source = path.join(root, "source");
  fs.mkdirSync(path.join(source, "src"), { recursive: true });
  fs.writeFileSync(path.join(source, "src", "telegram-native-runner.js"), "native");
  await asar.createPackage(source, path.join(root, "app.asar"));
  fs.rmSync(source, { recursive: true, force: true });

  const first = inspectRetiredTelegramSidecar({ resourcesRoot: root });
  const second = inspectRetiredTelegramSidecar({ resourcesRoot: root });
  assert.equal(first.errors.length, 0);
  assert.equal(first.summary.asarFiles > 0, true);
  assert.equal(stableJson(first), stableJson(second));
  assert.doesNotMatch(stableJson(first), /\r/);
});

test("a retired source hidden inside a real app.asar hard-fails", async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  fs.mkdirSync(path.join(source, "src"), { recursive: true });
  fs.writeFileSync(path.join(source, "src", "telegram-approval-sidecar.js"), "retired");
  await asar.createPackage(source, path.join(root, "app.asar"));
  fs.rmSync(source, { recursive: true, force: true });

  const report = inspectRetiredTelegramSidecar({ resourcesRoot: root });
  assert.deepEqual(report.errors, [{
    code: "retired-telegram-sidecar-present",
    path: "src/telegram-approval-sidecar.js",
    source: "app.asar",
  }]);
});

test("a missing app.asar hard-fails instead of silently skipping archive inspection", (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "icon.ico"), "icon");

  assert.throws(
    () => inspectRetiredTelegramSidecar({ resourcesRoot: root }),
    /Required app\.asar does not exist/,
  );
});

test("a retired executable anywhere under resources hard-fails", async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "clean.txt"), "clean");
  await asar.createPackage(source, path.join(root, "app.asar"));
  fs.rmSync(source, { recursive: true, force: true });
  const target = path.join(root, "stale", "cc-connect-clawd.exe");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "MZ");
  const report = inspectRetiredTelegramSidecar({ resourcesRoot: root });
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].source, "resources");
});

test("CLI parser requires an explicit resources root", () => {
  assert.throws(() => parseArgs([]), /--resources-root is required/);
  assert.throws(() => parseArgs(["--wat"]), /Unknown argument/);
  assert.deepEqual(
    parseArgs(["--resources-root", "dist/resources", "--output", "report.json"]),
    { resourcesRoot: "dist/resources", output: "report.json" },
  );
});
