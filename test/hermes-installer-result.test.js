"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  HERMES_RESULT_SENTINEL,
  HERMES_RESULT_SCHEMA_VERSION,
  HERMES_PLUGIN_ASSET_FILES,
  parseHermesInstallerResult,
} = require("../src/hermes-installer-result");
const wslDeploy = require("../src/wsl-deploy");

function sentinelLine(value) {
  return `${HERMES_RESULT_SENTINEL}${JSON.stringify(value)}\n`;
}

function okResult(overrides = {}) {
  return {
    schemaVersion: HERMES_RESULT_SCHEMA_VERSION,
    operation: "install",
    status: "ok",
    message: "installed",
    ...overrides,
  };
}

test("exports the frozen contract shared by the WSL and Remote SSH deploy paths", () => {
  assert.equal(HERMES_RESULT_SENTINEL, "CLAWD_HERMES_RESULT_V1=");
  assert.equal(HERMES_RESULT_SCHEMA_VERSION, 1);
  assert.deepStrictEqual([...HERMES_PLUGIN_ASSET_FILES], ["plugin.yaml", "__init__.py"]);
  assert.equal(Object.isFrozen(HERMES_PLUGIN_ASSET_FILES), true);
});

test("wsl-deploy re-exports the same sentinel and parser, not a copy", () => {
  assert.equal(wslDeploy.HERMES_RESULT_SENTINEL, HERMES_RESULT_SENTINEL);
  assert.equal(wslDeploy.parseHermesInstallerResult, parseHermesInstallerResult);
});

test("exactly one sentinel line is required", () => {
  const line = sentinelLine(okResult());
  assert.equal(parseHermesInstallerResult(line, "install").ok, true);

  for (const [label, stdout] of [
    ["no sentinel", "installed fine\n"],
    ["empty stdout", ""],
    ["non-string stdout", null],
    ["two sentinels", `${line}${line}`],
  ]) {
    const parsed = parseHermesInstallerResult(stdout, "install");
    assert.equal(parsed.ok, false, label);
    assert.match(parsed.error, /exactly one result sentinel/, label);
  }
});

test("surrounding installer chatter never breaks the single-sentinel rule", () => {
  const stdout = [
    "warning: hermes CLI is slow",
    sentinelLine(okResult()).trimEnd(),
    "done",
  ].join("\r\n");
  const parsed = parseHermesInstallerResult(stdout, "install");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.message, "installed");
});

test("invalid JSON, wrong schema, wrong status and wrong operation all fail closed", () => {
  const badJson = parseHermesInstallerResult(`${HERMES_RESULT_SENTINEL}{"schemaVersion":\n`, "install");
  assert.equal(badJson.ok, false);
  assert.match(badJson.error, /invalid JSON/);

  for (const schemaVersion of [2, "1", null, undefined]) {
    const parsed = parseHermesInstallerResult(sentinelLine(okResult({ schemaVersion })), "install");
    assert.equal(parsed.ok, false, `schemaVersion ${String(schemaVersion)}`);
    assert.match(parsed.error, /Unsupported Hermes installer result schema/);
  }

  for (const status of ["OK", "failed", "", null, true]) {
    const parsed = parseHermesInstallerResult(sentinelLine(okResult({ status })), "install");
    assert.equal(parsed.ok, false, `status ${String(status)}`);
    assert.match(parsed.error, /Invalid Hermes installer result status/);
  }

  const wrongOperation = parseHermesInstallerResult(
    sentinelLine(okResult({ operation: "uninstall" })),
    "install",
  );
  assert.equal(wrongOperation.ok, false);
  assert.match(wrongOperation.error, /wrong operation/);

  // No expected operation → the operation field is not checked.
  assert.equal(
    parseHermesInstallerResult(sentinelLine(okResult({ operation: "uninstall" })), null).ok,
    true,
  );
});

test("warning and error statuses parse; only the caller decides what they mean", () => {
  for (const status of ["ok", "warning", "error"]) {
    const parsed = parseHermesInstallerResult(sentinelLine(okResult({ status })), "install");
    assert.equal(parsed.ok, true, status);
    assert.equal(parsed.result.status, status);
  }
});

test("additive remote fields pass through untouched", () => {
  const wire = okResult({
    status: "warning",
    warning: "gateway restart required",
    remote: true,
    cliCommand: "/home/u/.local/bin/hermes",
    targets: [
      {
        home: "/home/u/.hermes",
        kind: "root",
        plugin: "absent",
        action: "installed",
        status: "ok",
        reason: null,
        message: "installed",
        hashes: { "plugin.yaml": "a".repeat(64), "__init__.py": "b".repeat(64) },
        marker: true,
        enabled: true,
        activation: "next-session",
        warnings: [],
      },
      {
        home: "/home/u/.hermes/profiles/qarpus",
        kind: "profile",
        plugin: "managed",
        action: "updated",
        status: "warning",
        reason: null,
        message: "updated",
        hashes: { "plugin.yaml": "c".repeat(64), "__init__.py": "d".repeat(64) },
        marker: true,
        enabled: true,
        activation: "restart-required",
        warnings: ["gateway restart required"],
      },
    ],
    activeGatewayUnits: ["hermes-gateway.service"],
  });
  const parsed = parseHermesInstallerResult(sentinelLine(wire), "install");
  assert.equal(parsed.ok, true);
  assert.deepStrictEqual(parsed.result, wire);
});

test("uninstall results use the same contract", () => {
  const wire = okResult({ operation: "uninstall", status: "warning", message: "removed with warnings" });
  const parsed = parseHermesInstallerResult(sentinelLine(wire), "uninstall");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.operation, "uninstall");
  assert.equal(parseHermesInstallerResult(sentinelLine(wire), "install").ok, false);
});
