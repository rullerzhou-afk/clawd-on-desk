"use strict";

// #1026 Settings Uninstall / About Cleanup commit semantics for
// registrationRemoved-based results and the conservative per-agent fallback.

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { commandRegistry, MANAGED_CLEANUP_AGENT_IDS } = require("../src/settings-actions");
const {
  uninstallAgentIntegration,
} = require("../src/settings-actions-agents");
const prefs = require("../src/prefs");

function installedSnapshot() {
  const snapshot = prefs.getDefaults();
  snapshot.agents = { ...(snapshot.agents || {}) };
  for (const agentId of MANAGED_CLEANUP_AGENT_IDS) {
    snapshot.agents[agentId] = {
      ...(snapshot.agents[agentId] || {}),
      integrationInstalled: true,
      enabled: true,
    };
  }
  return snapshot;
}

function deps(extra = {}) {
  return {
    snapshot: prefs.getDefaults(),
    writeCodexAutoStartGate: () => true,
    stopIntegrationForAgent: () => true,
    stopMonitorForAgent: () => true,
    clearSessionsByAgent: () => true,
    dismissPermissionsByAgent: () => true,
    startClaudeSettingsWatcher: () => true,
    ...extra,
  };
}

describe("#1026 Settings Uninstall registrationRemoved semantics", () => {
  it("blocks commit and runtime teardown when an active registration remains", async () => {
    const calls = [];
    const result = await uninstallAgentIntegration({ agentId: "opencode" }, deps({
      uninstallIntegrationForAgent: async () => ({
        status: "ok",
        registrationRemoved: false,
        activeEntryRemaining: true,
        messaging: "still there",
      }),
      stopMonitorForAgent: () => calls.push("stop"),
      clearSessionsByAgent: () => calls.push("sessions"),
      dismissPermissionsByAgent: () => calls.push("perms"),
    }));
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.commit, undefined);
    assert.strictEqual(result.activeEntryRemaining, true);
    assert.deepStrictEqual(calls, []);
  });

  it("treats unknown registration (null) as blocking too", async () => {
    const result = await uninstallAgentIntegration({ agentId: "opencode" }, deps({
      uninstallIntegrationForAgent: async () => ({ status: "ok", registrationRemoved: null }),
    }));
    assert.strictEqual(result.status, "error");
    assert.strictEqual(result.commit, undefined);
  });

  it("commits when the registration was removed even if managed files remain (ok + warning)", async () => {
    const result = await uninstallAgentIntegration({ agentId: "opencode" }, deps({
      uninstallIntegrationForAgent: async () => ({
        status: "ok",
        registrationRemoved: true,
        managedFilesRemoved: false,
        warnings: ["generation retained"],
      }),
    }));
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.commit.agents.opencode.integrationInstalled, false);
    assert.strictEqual(result.commit.agents.opencode.enabled, false);
    assert.deepStrictEqual(result.warnings, ["generation retained"]);
    assert.strictEqual(result.managedFilesRemoved, false);
  });

  it("keeps the legacy status-only path when a cleaner omits the new fields", async () => {
    const okResult = await uninstallAgentIntegration({ agentId: "qwen-code" }, deps({
      uninstallIntegrationForAgent: async () => ({ removed: 1, changed: true }),
    }));
    assert.strictEqual(okResult.status, "ok");
    assert.strictEqual(okResult.commit.agents["qwen-code"].integrationInstalled, false);

    const errResult = await uninstallAgentIntegration({ agentId: "qwen-code" }, deps({
      uninstallIntegrationForAgent: async () => ({ status: "error", message: "nope" }),
    }));
    assert.strictEqual(errResult.status, "error");
    assert.strictEqual(errResult.commit, undefined);
  });
});

describe("#1026 About cleanup per-agent commit", () => {
  it("keeps install intent for a failed OpenCode cleanup while disabling it", async () => {
    const result = await commandRegistry.cleanupIntegrations(null, deps({
      snapshot: installedSnapshot(),
      cleanupIntegrations: async () => ({
        mode: "apply",
        agents: [
          { agentId: "opencode", status: "failed", registrationRemoved: false, activeEntryRemaining: true, warnings: [], residualPaths: [] },
        ],
        summary: { agentsChecked: 1, agentsAffected: 0, entriesRemoved: 0, skipped: 0, failed: 1 },
      }),
    }));
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.commit.agents.opencode.enabled, false);
    assert.strictEqual(result.commit.agents.opencode.integrationInstalled, true);
  });

  it("marks only the agents whose registration was actually removed", async () => {
    const result = await commandRegistry.cleanupIntegrations(null, deps({
      cleanupIntegrations: async () => ({
        mode: "apply",
        agents: [
          { agentId: "opencode", status: "applied", registrationRemoved: true, activeEntryRemaining: false },
        ],
        summary: { agentsChecked: 1, agentsAffected: 1, entriesRemoved: 1, skipped: 0, failed: 0 },
      }),
    }));
    assert.strictEqual(result.commit.agents.opencode.integrationInstalled, false);
    // Other managed agents were not present in the result array → keep intent.
    assert.notStrictEqual(result.commit.agents.codex.integrationInstalled, false);
  });

  it("keeps a legacy no-agents success blanket-uninstalling", async () => {
    const result = await commandRegistry.cleanupIntegrations(null, deps({
      cleanupIntegrations: async () => ({
        mode: "apply",
        summary: { agentsChecked: 20, agentsAffected: 0, entriesRemoved: 0, skipped: 20, failed: 0 },
      }),
    }));
    for (const agentId of MANAGED_CLEANUP_AGENT_IDS) {
      assert.strictEqual(result.commit.agents[agentId].integrationInstalled, false, agentId);
    }
  });

  it("keeps install intent when cleanup throws", async () => {
    const result = await commandRegistry.cleanupIntegrations(null, deps({
      snapshot: installedSnapshot(),
      cleanupIntegrations: async () => {
        throw new Error("boom");
      },
    }));
    assert.strictEqual(result.status, "ok");
    for (const agentId of MANAGED_CLEANUP_AGENT_IDS) {
      if (result.commit.agents[agentId]) {
        assert.notStrictEqual(result.commit.agents[agentId].integrationInstalled, false, agentId);
      }
    }
  });
});
