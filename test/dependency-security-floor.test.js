"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const pkg = require("../package.json");
const lock = require("../package-lock.json");

const DIRECT_POLICIES = Object.freeze({
  electron: { major: 41, floor: "41.10.4" },
  "electron-builder": { major: 26, floor: "26.15.7" },
});

const TRANSITIVE_POLICIES = Object.freeze({
  "js-yaml": Object.freeze({ 4: "4.3.1" }),
  "brace-expansion": Object.freeze({
    1: "1.1.18",
    2: "2.1.4",
    5: "5.0.9",
  }),
  "ip-address": Object.freeze({ 10: "10.3.1" }),
  // node-gyp 12.x carries the reviewed v6 line; @electron/get carries v7.
  undici: Object.freeze({
    6: "6.28.0",
    7: "7.29.0",
  }),
});

function parseVersion(value, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(value);
  assert.ok(match, `${label} must be a concrete semver, got ${JSON.stringify(value)}`);
  return match.slice(1, 4).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1;
    }
  }
  return 0;
}

function assertAtLeast(actual, floor, label) {
  const actualParts = parseVersion(actual, label);
  const floorParts = parseVersion(floor, `${label} floor`);
  assert.ok(
    compareVersions(actualParts, floorParts) >= 0,
    `${label} must be >= ${floor}, got ${actual}`
  );
  return actualParts;
}

function packageNameForEntry(packagePath, entry) {
  if (entry && typeof entry.name === "string") {
    return entry.name;
  }
  return packagePath.split("node_modules/").at(-1) || "";
}

function entriesFor(packageName) {
  return Object.entries(lock.packages)
    .filter(([packagePath, entry]) => packagePath && packageNameForEntry(packagePath, entry) === packageName)
    .map(([packagePath, entry]) => ({ packagePath, entry }));
}

test("direct Electron build dependencies stay on reviewed majors and security floors", () => {
  const lockRoot = lock.packages[""];
  assert.ok(lockRoot, "package-lock.json must contain the root package entry");

  for (const [name, policy] of Object.entries(DIRECT_POLICIES)) {
    const range = pkg.devDependencies[name];
    const match = /^\^(\d+\.\d+\.\d+)$/.exec(range || "");
    assert.ok(match, `${name} must use a caret range with a concrete floor`);
    assert.strictEqual(
      lockRoot.devDependencies[name],
      range,
      `${name} root lock metadata must match package.json`
    );

    const manifestFloor = match[1];
    const manifestParts = assertAtLeast(manifestFloor, policy.floor, `${name} manifest floor`);
    assert.strictEqual(manifestParts[0], policy.major, `${name} manifest must remain on major ${policy.major}`);

    const locked = lock.packages[`node_modules/${name}`];
    assert.ok(locked, `${name} must have a top-level lock entry`);
    const lockedParts = assertAtLeast(locked.version, manifestFloor, `${name} locked version`);
    assert.strictEqual(lockedParts[0], policy.major, `${name} lock entry must remain on major ${policy.major}`);
  }
});

test("all reviewed transitive package copies stay above their per-major security floors", () => {
  for (const [name, majorPolicies] of Object.entries(TRANSITIVE_POLICIES)) {
    for (const { packagePath, entry } of entriesFor(name)) {
      const versionParts = parseVersion(entry.version, `${name} at ${packagePath}`);
      const floor = majorPolicies[versionParts[0]];
      assert.ok(
        floor,
        `${name} at ${packagePath} introduced unreviewed major ${versionParts[0]} (${entry.version})`
      );
      assertAtLeast(entry.version, floor, `${name} at ${packagePath}`);
    }
  }

  assert.ok(entriesFor("js-yaml").length > 0, "the runtime YAML parser must remain visible in the lockfile");
  assert.ok(entriesFor("brace-expansion").length > 0, "brace-expansion copies must remain auditable");
  assert.ok(entriesFor("undici").length > 0, "undici copies must remain auditable");
});

test("electron-builder generated-artifact dependencies cannot regress below fixed lines", () => {
  const appBuilderEntries = entriesFor("app-builder-lib");
  assert.ok(appBuilderEntries.length > 0, "app-builder-lib must remain present");
  for (const { packagePath, entry } of appBuilderEntries) {
    const parts = assertAtLeast(entry.version, "26.15.0", `app-builder-lib at ${packagePath}`);
    assert.strictEqual(parts[0], 26, "a new app-builder-lib major requires explicit review");
  }

  const runtimeEntries = entriesFor("builder-util-runtime");
  assert.ok(runtimeEntries.length > 0, "builder-util-runtime must remain present");
  for (const { packagePath, entry } of runtimeEntries) {
    const parts = assertAtLeast(entry.version, "9.7.0", `builder-util-runtime at ${packagePath}`);
    assert.strictEqual(parts[0], 9, "a new builder-util-runtime major requires explicit review");
  }
});
