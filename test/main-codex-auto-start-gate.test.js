const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const MAIN_PATH = path.join(__dirname, "..", "src", "main.js");

test("only the single-instance winner publishes the startup Codex auto-start gate", () => {
  const source = fs.readFileSync(MAIN_PATH, "utf8").replace(/\r\n/g, "\n");
  const lockIndex = source.indexOf("const gotTheLock = app.requestSingleInstanceLock();");
  const loserBranchIndex = source.indexOf("if (!gotTheLock)", lockIndex);
  const winnerBranchIndex = source.indexOf("} else {", loserBranchIndex);
  const startupSnapshotIndex = source.indexOf(
    "const startupGateSnapshot =",
    winnerBranchIndex
  );
  const startupSyncIndex = source.indexOf(
    '_syncCodexAutoStartGate(startupGateSnapshot, "startup")'
  );

  assert.ok(lockIndex >= 0, "main.js should request the single-instance lock");
  assert.ok(loserBranchIndex > lockIndex, "main.js should branch on the lock result");
  assert.ok(winnerBranchIndex > loserBranchIndex, "main.js should have a winner branch");
  assert.ok(
    startupSnapshotIndex > winnerBranchIndex
      && startupSyncIndex > startupSnapshotIndex,
    "startup gate sync must run only inside the single-instance winner branch"
  );
});

test("non-authoritative startup prefs publish a fail-closed Codex gate", () => {
  const source = fs.readFileSync(MAIN_PATH, "utf8").replace(/\r\n/g, "\n");
  const startupSnapshotIndex = source.indexOf("const startupGateSnapshot =");
  const lockedGuardIndex = source.indexOf(
    "_initialPrefsLoad.locked === true",
    startupSnapshotIndex
  );
  const recoveredGuardIndex = source.indexOf(
    "_initialPrefsLoad.recovered === true",
    startupSnapshotIndex
  );
  const codexAuthorityGuardIndex = source.indexOf(
    "_initialPrefsLoad.codexAutoStartAuthoritative === false",
    startupSnapshotIndex
  );
  const failClosedIndex = source.indexOf(
    ") ? null : _initialPrefsLoad.snapshot;",
    startupSnapshotIndex
  );
  const startupSyncIndex = source.indexOf(
    '_syncCodexAutoStartGate(startupGateSnapshot, "startup")',
    startupSnapshotIndex
  );

  assert.ok(startupSnapshotIndex >= 0, "main.js should derive a startup gate snapshot");
  assert.ok(
    lockedGuardIndex > startupSnapshotIndex
      && recoveredGuardIndex > lockedGuardIndex
      && codexAuthorityGuardIndex > recoveredGuardIndex
      && failClosedIndex > codexAuthorityGuardIndex
      && startupSyncIndex > failClosedIndex,
    "locked, recovered, or gate-invalid prefs must become a null fail-closed startup snapshot"
  );
});

test("Codex auto-start authority loss is latched for the whole process", () => {
  const source = fs.readFileSync(MAIN_PATH, "utf8").replace(/\r\n/g, "\n");
  const latchIndex = source.indexOf("const _codexAutoStartAuthorityLost = (");
  const lockedIndex = source.indexOf("_initialPrefsLoad.locked === true", latchIndex);
  const recoveredIndex = source.indexOf("|| _initialPrefsRecovered", latchIndex);
  const backupIndex = source.indexOf("|| _initialPrefsRecoveryBackupFailed", latchIndex);
  const fieldAuthorityIndex = source.indexOf(
    "|| _initialPrefsLoad.codexAutoStartAuthoritative === false",
    latchIndex
  );
  const evaluatorIndex = source.indexOf(
    "const _evaluateCodexAutoStartGate = createCodexAutoStartGateEvaluator({",
    latchIndex
  );
  const syncIndex = source.indexOf(
    "_persistCodexAutoStartGate(_evaluateCodexAutoStartGate(snapshot))",
    evaluatorIndex
  );

  assert.ok(latchIndex >= 0, "main.js should capture initial authority once");
  assert.ok(
    lockedIndex > latchIndex
      && recoveredIndex > lockedIndex
      && backupIndex > recoveredIndex
      && fieldAuthorityIndex > backupIndex
      && evaluatorIndex > fieldAuthorityIndex
      && syncIndex > evaluatorIndex,
    "startup authority loss must feed the evaluator used by every gate sync"
  );
});

test("future-version locked settings cannot publish an ephemeral Codex gate", () => {
  const source = fs.readFileSync(MAIN_PATH, "utf8").replace(/\r\n/g, "\n");
  const subscriptionIndex = source.indexOf(
    '_settingsController.subscribeKey("agents", (_agents, snapshot) => {'
  );
  const lockedGuardIndex = source.indexOf(
    "if (_settingsController.isLocked()) return;",
    subscriptionIndex
  );
  const settingsSyncIndex = source.indexOf(
    '_syncCodexAutoStartGate(snapshot, "settings")',
    subscriptionIndex
  );

  assert.ok(subscriptionIndex >= 0, "main.js should subscribe to agents changes");
  assert.ok(
    lockedGuardIndex > subscriptionIndex && lockedGuardIndex < settingsSyncIndex,
    "locked settings must return before publishing the settings gate"
  );
});

test("Codex auto-start gate follows the dedicated preference as well as agent state", () => {
  const source = fs.readFileSync(MAIN_PATH, "utf8").replace(/\r\n/g, "\n");
  assert.ok(
    source.includes("_persistCodexAutoStartGate(_evaluateCodexAutoStartGate(snapshot))"),
    "the published gate should use the combined preference/install/enabled predicate"
  );
  assert.ok(
    source.includes('_settingsController.subscribeKey("autoStartWithCodex", (_enabled, snapshot) => {'),
    "preference commits should republish the durable Codex gate"
  );
});

test("unreadable or recovered prefs fail every prefs-backed agent runtime gate closed", () => {
  const source = fs.readFileSync(MAIN_PATH, "utf8").replace(/\r\n/g, "\n");
  const gateIndex = source.indexOf("const _runtimeAgentGate = createRuntimeAgentGate({");
  const authorityIndex = source.indexOf(
    "isAuthoritative: () => !_initialPrefsRecovered && !_settingsController.hasReadFailure()",
    gateIndex
  );

  assert.ok(gateIndex >= 0, "main.js should create one centralized runtime agent gate");
  assert.ok(
    authorityIndex > gateIndex,
    "the runtime agent gate must reject the defaults fallback from unreadable prefs"
  );

  for (const expected of [
    "_runtimeAgentGate.isAgentEnabled(agentId)",
    "_runtimeAgentGate.shouldSyncAgentIntegration(agentId)",
    "_runtimeAgentGate.isAgentPermissionsEnabled(agentId)",
    "_runtimeAgentGate.isAgentSubagentPermissionsEnabled(agentId)",
    "_runtimeAgentGate.isCodexPermissionInterceptEnabled()",
  ]) {
    assert.ok(source.includes(expected), `main.js should route ${expected} through the safe gate`);
  }
});
