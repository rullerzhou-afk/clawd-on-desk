"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  RELEASE_TARGETS,
  normalizePlatform,
  normalizeBuilderArch,
  getReleaseTarget,
  resolveReleaseTarget,
} = require("../src/native-package-target");

test("native package target map covers the five release targets exactly", () => {
  assert.deepEqual(
    RELEASE_TARGETS.map((target) => target.id),
    ["windows-x64", "windows-arm64", "darwin-x64", "darwin-arm64", "linux-x64"],
  );
  assert.equal(getReleaseTarget("windows-x64").koffiTriplet, "win32_x64");
  assert.equal(getReleaseTarget("linux-x64").artifactArchAliases.includes("amd64"), true);
});

test("electron-builder numeric and textual architecture values normalize once", () => {
  assert.equal(normalizeBuilderArch(1), "x64");
  assert.equal(normalizeBuilderArch(3), "arm64");
  assert.equal(normalizeBuilderArch("1"), "x64");
  assert.equal(normalizeBuilderArch("amd64"), "x64");
  assert.equal(normalizeBuilderArch("aarch64"), "arm64");
  assert.equal(normalizePlatform("windows"), "win32");
  assert.equal(normalizePlatform("mac"), "darwin");
});

test("target resolution rejects unsupported platform and architecture tuples", () => {
  assert.equal(resolveReleaseTarget("win32", 1).id, "windows-x64");
  assert.equal(resolveReleaseTarget("win32", 3).id, "windows-arm64");
  assert.equal(resolveReleaseTarget("darwin", "x64").id, "darwin-x64");
  assert.equal(resolveReleaseTarget("linux", "amd64").id, "linux-x64");
  assert.throws(() => resolveReleaseTarget("linux", "arm64"), /Unsupported package target/);
  assert.throws(() => resolveReleaseTarget("freebsd", "x64"), /Unsupported package target/);
  assert.throws(() => getReleaseTarget("windows-ia32"), /Unknown release target/);
});
