"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");

const RETIRED_SOURCE_PATHS = [
  "src/telegram-approval-client.js",
  "src/telegram-approval-sidecar.js",
  "src/telegram-owner-manager.js",
  "src/telegram-sidecar-status-bridge.js",
];

const RETIRED_RUNTIME_TOKENS = [
  "LEGACY_ACTIVE",
  "SWITCHING_TO_LEGACY",
  "START_SIDECAR",
  "STOP_SIDECAR",
  "USER_ENABLE_LEGACY",
  "USER_ROLLBACK_TO_LEGACY",
  "SIDECAR_STARTED",
  "SIDECAR_START_FAILED",
  "SIDECAR_RUNTIME_FAILED",
];

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("retired Telegram runtime modules are absent and have no production importer", () => {
  for (const relativePath of RETIRED_SOURCE_PATHS) {
    assert.equal(fs.existsSync(path.join(ROOT, relativePath)), false, `${relativePath} must stay retired`);
  }

  const productionSources = [
    "src/main.js",
    "src/permission.js",
    "src/settings-tab-telegram-approval.js",
    "src/telegram-approval-runtime-status.js",
    "src/telegram-approval-settings.js",
    "src/telegram-migration-controller.js",
    "src/telegram-migration-state.js",
  ].map((relativePath) => `${relativePath}\n${read(relativePath)}`).join("\n");

  for (const relativePath of RETIRED_SOURCE_PATHS) {
    const moduleName = path.basename(relativePath, ".js");
    assert.equal(
      productionSources.includes(moduleName),
      false,
      `production source must not import ${moduleName}`,
    );
  }
});

test("production migration vocabulary has no legacy runtime transition", () => {
  const sources = [
    read("src/main.js"),
    read("src/telegram-migration-controller.js"),
    read("src/telegram-migration-state.js"),
  ].join("\n");
  for (const token of RETIRED_RUNTIME_TOKENS) {
    assert.equal(sources.includes(token), false, `${token} must not return`);
  }
});

test("main publishes the native/off decision only after disabling the retired flag", () => {
  const main = read("src/main.js");
  const start = main.indexOf("async function persistTelegramMigrationPatch(patch) {");
  const end = main.indexOf("\n// Canonical paths only", start);
  assert.ok(start >= 0 && end > start, "main must keep a single migration persistence boundary");
  const body = main.slice(start, end);
  const disableIndex = body.indexOf("await setTelegramApprovalEnabledForMigration(false)");
  const migrationWriteIndex = body.indexOf('await applySettingsUpdateOrThrow("tgMigration"');
  assert.ok(disableIndex >= 0);
  assert.ok(migrationWriteIndex > disableIndex, "partial writes must not publish native before legacy is disabled");
  assert.doesNotMatch(body, /deleteToken|unlink|rmSync|remove/);
});

test("package scripts cannot fetch, verify, or stage the retired executable", () => {
  const pkg = JSON.parse(read("package.json"));
  const scriptText = JSON.stringify(pkg.scripts || {});
  for (const token of [
    "fetch:sidecars",
    "verify:sidecars",
    "assert:packaged-sidecar",
    "ensure-sidecar-binaries",
    "fetch-sidecar-binaries",
    "verify-sidecar-binaries",
  ]) {
    assert.equal(scriptText.includes(token), false, `${token} must stay retired`);
  }
  assert.equal(scriptText.includes("assert-no-retired-telegram-sidecar"), false);
});

test("the permanent package assertion is present in all build workflows", () => {
  const release = read(".github/workflows/build.yml");
  const retirement = read(".github/workflows/telegram-retirement-package-audit.yml");
  const wayland = read(".github/workflows/wayland-smoke.yml");
  for (const [name, workflow] of [
    ["release", release],
    ["retirement", retirement],
    ["wayland", wayland],
  ]) {
    assert.match(
      workflow,
      /scripts\/assert-no-retired-telegram-sidecar\.js/,
      `${name} workflow must inspect real package resources`,
    );
  }
});
