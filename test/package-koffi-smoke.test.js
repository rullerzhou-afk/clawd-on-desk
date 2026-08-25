"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  parseSmokeArgs,
  physicalAddonPath,
  comparablePath,
  isInside,
  callStableNativeFunction,
  assertFullscreenProbeValue,
} = require("../src/package-koffi-smoke");
const {
  parseArgs: parseRunnerArgs,
  cleanupSmokeUserData,
} = require("../scripts/run-packaged-koffi-smoke");

test("packaged smoke mode is opt-in and requires target/output", () => {
  assert.equal(parseSmokeArgs(["--unrelated"]), null);
  assert.throws(() => parseSmokeArgs(["--clawd-package-smoke"]), /target.*required/i);
  assert.throws(
    () => parseSmokeArgs(["--clawd-package-smoke", "--clawd-package-smoke-target=windows-x64"]),
    /output.*required/i,
  );
  const parsed = parseSmokeArgs([
    "--clawd-package-smoke",
    "--clawd-package-smoke-target=windows-x64",
    "--clawd-package-smoke-output=dist/smoke.json",
  ]);
  assert.equal(parsed.targetId, "windows-x64");
  assert.equal(path.isAbsolute(parsed.outputPath), true);
});

test("physical addon evidence maps logical ASAR path to unpacked storage", () => {
  const logical = path.resolve("dist/resources/app.asar/node_modules/koffi/build/koffi/win32_x64/koffi.node");
  const physical = physicalAddonPath(logical).replace(/\\/g, "/");
  assert.match(physical, /resources\/app\.asar\.unpacked\/node_modules\/koffi/);
  assert.equal(physicalAddonPath(physicalAddonPath(logical)), physicalAddonPath(logical));
});

test("Windows extended-length dlopen paths compare inside normal resources paths", () => {
  if (process.platform !== "win32") return;
  const resources = "D:\\app\\resources";
  const addon = "\\\\?\\D:\\app\\resources\\app.asar.unpacked\\koffi.node";
  assert.equal(comparablePath(addon), "D:\\app\\resources\\app.asar.unpacked\\koffi.node");
  assert.equal(isInside(resources, addon), true);
  assert.equal(isInside(resources, "\\\\?\\D:\\outside\\koffi.node"), false);
});

test("stable native call proves Koffi 2.16.3 works on the current Windows host", { skip: process.platform !== "win32" }, () => {
  const koffi = require("koffi");
  const result = callStableNativeFunction(koffi, "win32");
  assert.equal(result.symbol, "GetCurrentProcessId");
  assert.equal(result.value, process.pid);
  assert.equal(typeof koffi.address(Buffer.alloc(8)), "bigint");
});

test("packaged smoke runner parser rejects incomplete invocations", () => {
  assert.throws(() => parseRunnerArgs([]), /--executable is required/);
  assert.throws(() => parseRunnerArgs(["--executable", "app.exe"]), /--target is required/);
  assert.throws(
    () => parseRunnerArgs(["--executable", "app.exe", "--target", "windows-x64"]),
    /--output is required/,
  );
});

test("packaged smoke cleanup removes only its exact adjacent temporary profile", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-smoke-cleanup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "windows-x64.json");
  const profile = path.join(root, ".koffi-smoke-user-data-1234");
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, "state"), "temporary");
  assert.deepEqual(
    cleanupSmokeUserData(output, { runtime: { userDataPath: profile } }),
    { cleaned: true, reason: "removed" },
  );
  assert.equal(fs.existsSync(profile), false);
  assert.throws(
    () => cleanupSmokeUserData(output, { runtime: { userDataPath: path.join(root, "unrelated") } }),
    /unsafe smoke user-data cleanup path/i,
  );
});

test("fullscreen probe smoke check accepts a verdict or a window identity", () => {
  assert.equal(assertFullscreenProbeValue(false), false);
  assert.equal(assertFullscreenProbeValue(true), true);
  assert.equal(assertFullscreenProbeValue("81985529216486895"), "81985529216486895");
  assert.throws(() => assertFullscreenProbeValue(""), /empty string/);
  assert.throws(() => assertFullscreenProbeValue(0), /number/);
  assert.throws(() => assertFullscreenProbeValue(null), /object/);
  assert.throws(() => assertFullscreenProbeValue(undefined), /undefined/);
});
