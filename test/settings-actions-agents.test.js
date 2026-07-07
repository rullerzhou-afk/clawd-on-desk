"use strict";

const test = require("node:test");
const assert = require("node:assert");

const prefs = require("../src/prefs");
const agentCommands = require("../src/settings-actions-agents");

test("settings agent actions expose the command surface", () => {
  assert.deepStrictEqual(Object.keys(agentCommands).sort(), [
    "INSTALLABLE_AGENT_IDS",
    "clearAgentCleanupHints",
    "clearAgentInstallHints",
    "deployToWsl",
    "dismissAgentCleanupHints",
    "dismissAgentInstallHints",
    "installAgentIntegration",
    "removeFromWsl",
    "repairAgentIntegration",
    "setAgentFlag",
    "setAgentPermissionMode",
    "uninstallAgentIntegration",
  ]);
});

test("settings agent integration commands share a serialization lock", () => {
  assert.strictEqual(agentCommands.setAgentFlag.lockKey, "agentIntegration");
  assert.strictEqual(agentCommands.setAgentPermissionMode.lockKey, "agentIntegration");
  assert.strictEqual(agentCommands.installAgentIntegration.lockKey, "agentIntegration");
  assert.strictEqual(agentCommands.uninstallAgentIntegration.lockKey, "agentIntegration");
  assert.strictEqual(agentCommands.repairAgentIntegration.lockKey, "agentIntegration");
  assert.strictEqual(agentCommands.dismissAgentInstallHints.lockKey, "agentIntegration");
  assert.strictEqual(agentCommands.dismissAgentCleanupHints.lockKey, "agentIntegration");
  assert.strictEqual(agentCommands.clearAgentCleanupHints.lockKey, "agentIntegration");
  assert.strictEqual(agentCommands.clearAgentInstallHints.lockKey, "agentIntegration");
});

test("settings agent actions enable an agent and preserve sibling flags", () => {
  const snapshot = prefs.getDefaults();
  snapshot.agents.codex = {
    enabled: false,
    permissionsEnabled: false,
    notificationHookEnabled: true,
    permissionMode: "intercept",
  };
  const calls = {
    syncIntegrationForAgent: [],
    startMonitorForAgent: [],
  };
  const deps = {
    snapshot,
    syncIntegrationForAgent: (agentId) => calls.syncIntegrationForAgent.push(agentId),
    startMonitorForAgent: (agentId) => calls.startMonitorForAgent.push(agentId),
  };

  const result = agentCommands.setAgentFlag(
    { agentId: "codex", flag: "enabled", value: true },
    deps
  );

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(calls.syncIntegrationForAgent, ["codex"]);
  assert.deepStrictEqual(calls.startMonitorForAgent, ["codex"]);
  assert.strictEqual(result.commit.agents.codex.enabled, true);
  assert.strictEqual(result.commit.agents.codex.permissionsEnabled, false);
  assert.strictEqual(result.commit.agents.codex.notificationHookEnabled, true);
  assert.strictEqual(result.commit.agents.codex.permissionMode, "intercept");
});

test("settings agent actions do not install files when enabling an uninstalled agent", () => {
  const snapshot = prefs.getDefaults();
  snapshot.agents["gemini-cli"] = {
    integrationInstalled: false,
    enabled: false,
    permissionsEnabled: true,
    notificationHookEnabled: true,
  };
  const calls = {
    syncIntegrationForAgent: [],
    startMonitorForAgent: [],
  };
  const deps = {
    snapshot,
    syncIntegrationForAgent: (agentId) => calls.syncIntegrationForAgent.push(agentId),
    startMonitorForAgent: (agentId) => calls.startMonitorForAgent.push(agentId),
  };

  const result = agentCommands.setAgentFlag(
    { agentId: "gemini-cli", flag: "enabled", value: true },
    deps
  );

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(calls.syncIntegrationForAgent, []);
  assert.deepStrictEqual(calls.startMonitorForAgent, ["gemini-cli"]);
  assert.strictEqual(result.commit.agents["gemini-cli"].enabled, true);
  assert.strictEqual(result.commit.agents["gemini-cli"].integrationInstalled, false);
});

test("settings agent actions switch Codex permission mode and dismiss pending bubbles", () => {
  const snapshot = prefs.getDefaults();
  snapshot.agents.codex.permissionMode = "intercept";
  const calls = { dismissPermissionsByAgent: [] };
  const deps = {
    snapshot,
    dismissPermissionsByAgent: (agentId) => calls.dismissPermissionsByAgent.push(agentId),
  };

  const result = agentCommands.setAgentPermissionMode(
    { agentId: "codex", mode: "native" },
    deps
  );

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.commit.agents.codex.permissionMode, "native");
  assert.strictEqual(result.commit.agents.codex.enabled, true);
  assert.deepStrictEqual(calls.dismissPermissionsByAgent, ["codex"]);
});

test("settings agent actions repair Codex with the forced hooks feature option", async () => {
  const snapshot = prefs.getDefaults();
  const calls = [];
  const deps = {
    snapshot,
    repairIntegrationForAgent: async (agentId, options) => {
      calls.push({ agentId, options });
      return { status: "ok", message: "codex repaired" };
    },
  };

  const result = await agentCommands.repairAgentIntegration(
    { agentId: "codex", forceCodexHooksFeature: true },
    deps
  );

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.message, "codex repaired");
  assert.deepStrictEqual(calls, [
    { agentId: "codex", options: { forceCodexHooksFeature: true } },
  ]);
});

test("settings agent actions install an integration and enable ingress", async () => {
  const snapshot = prefs.getDefaults();
  snapshot.agents["copilot-cli"] = {
    integrationInstalled: false,
    enabled: false,
    permissionsEnabled: true,
    notificationHookEnabled: true,
  };
  const calls = [];
  const deps = {
    snapshot,
    syncIntegrationForAgent: async (agentId) => {
      calls.push(agentId);
      return { status: "ok", message: "installed" };
    },
    startMonitorForAgent: (agentId) => calls.push(`monitor:${agentId}`),
  };

  const result = await agentCommands.installAgentIntegration({ agentId: "copilot-cli" }, deps);

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.message, "installed");
  assert.deepStrictEqual(calls, ["copilot-cli", "monitor:copilot-cli"]);
  assert.strictEqual(result.commit.agents["copilot-cli"].integrationInstalled, true);
  assert.strictEqual(result.commit.agents["copilot-cli"].enabled, true);
  assert.deepStrictEqual(result.commit.dismissedAgentInstallHints, {});
  assert.deepStrictEqual(result.commit.dismissedAgentCleanupHints, {});
});

test("settings agent actions install reasonix integration and enable ingress", async () => {
  const snapshot = prefs.getDefaults();
  snapshot.agents.reasonix = {
    integrationInstalled: false,
    enabled: false,
    permissionsEnabled: false,
    notificationHookEnabled: true,
  };
  const calls = [];
  const deps = {
    snapshot,
    syncIntegrationForAgent: async (agentId) => {
      calls.push(agentId);
      return { status: "ok", message: "Reasonix hooks installed" };
    },
    startMonitorForAgent: (agentId) => calls.push(`monitor:${agentId}`),
  };

  const result = await agentCommands.installAgentIntegration({ agentId: "reasonix" }, deps);

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.message, "Reasonix hooks installed");
  assert.deepStrictEqual(calls, ["reasonix", "monitor:reasonix"]);
  assert.strictEqual(result.commit.agents.reasonix.integrationInstalled, true);
  assert.strictEqual(result.commit.agents.reasonix.enabled, true);
  assert.deepStrictEqual(result.commit.dismissedAgentInstallHints, {});
  assert.deepStrictEqual(result.commit.dismissedAgentCleanupHints, {});
});

test("settings agent actions clear hint dismissals after a manual install", async () => {
  const snapshot = prefs.getDefaults();
  snapshot.dismissedAgentInstallHints = { "qwen-code": true, hermes: true };
  snapshot.dismissedAgentCleanupHints = { "qwen-code": true, hermes: true };

  const result = await agentCommands.installAgentIntegration({ agentId: "qwen-code" }, {
    snapshot,
    syncIntegrationForAgent: async () => ({ status: "ok" }),
  });

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.commit.agents["qwen-code"].integrationInstalled, true);
  assert.deepStrictEqual(result.commit.dismissedAgentInstallHints, { hermes: true });
  assert.deepStrictEqual(result.commit.dismissedAgentCleanupHints, { hermes: true });
});

test("settings agent actions return skipped without committing installed intent when install skips", async () => {
  const result = await agentCommands.installAgentIntegration({ agentId: "hermes" }, {
    snapshot: prefs.getDefaults(),
    syncIntegrationForAgent: async () => ({ status: "skipped", message: "Hermes missing" }),
  });

  assert.strictEqual(result.status, "skipped");
  assert.strictEqual(result.commit, undefined);
  assert.match(result.message, /Hermes missing/);
});

test("settings agent actions uninstall an integration and disable ingress", async () => {
  const snapshot = prefs.getDefaults();
  snapshot.agents["copilot-cli"] = {
    integrationInstalled: true,
    enabled: true,
    permissionsEnabled: true,
    notificationHookEnabled: true,
  };
  snapshot.dismissedAgentCleanupHints = { "copilot-cli": true, hermes: true };
  const calls = [];
  const deps = {
    snapshot,
    uninstallIntegrationForAgent: async (agentId) => {
      calls.push(agentId);
      return { removed: 0, changed: false };
    },
    stopMonitorForAgent: (agentId) => calls.push(`stop:${agentId}`),
    clearSessionsByAgent: (agentId) => calls.push(`clear:${agentId}`),
    dismissPermissionsByAgent: (agentId) => calls.push(`dismiss:${agentId}`),
  };

  const result = await agentCommands.uninstallAgentIntegration({ agentId: "copilot-cli" }, deps);

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(calls, ["copilot-cli", "stop:copilot-cli", "clear:copilot-cli", "dismiss:copilot-cli"]);
  assert.strictEqual(result.commit.agents["copilot-cli"].integrationInstalled, false);
  assert.strictEqual(result.commit.agents["copilot-cli"].enabled, false);
  assert.deepStrictEqual(result.commit.dismissedAgentInstallHints, { "copilot-cli": true });
  assert.deepStrictEqual(result.commit.dismissedAgentCleanupHints, { hermes: true });
});

test("settings agent actions can uninstall without suppressing the next install hint", async () => {
  const snapshot = prefs.getDefaults();
  snapshot.agents["qwen-code"] = {
    integrationInstalled: true,
    enabled: true,
    permissionsEnabled: true,
    notificationHookEnabled: true,
  };
  snapshot.dismissedAgentInstallHints = { "qwen-code": true, hermes: true };

  const result = await agentCommands.uninstallAgentIntegration({
    agentId: "qwen-code",
    dismissInstallHint: false,
  }, {
    snapshot,
    uninstallIntegrationForAgent: async () => ({ status: "ok" }),
  });

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.commit.agents["qwen-code"].integrationInstalled, false);
  assert.deepStrictEqual(result.commit.dismissedAgentInstallHints, { hermes: true });
});

test("settings agent actions dismiss agent install hints in one commit", () => {
  const snapshot = prefs.getDefaults();
  snapshot.dismissedAgentInstallHints = { hermes: true };

  const result = agentCommands.dismissAgentInstallHints({
    agentIds: ["qwen-code", "hermes", "qwen-code"],
  }, { snapshot });

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(result.commit.dismissedAgentInstallHints, {
    hermes: true,
    "qwen-code": true,
  });
});

test("settings agent actions dismiss agent cleanup hints in one commit", () => {
  const snapshot = prefs.getDefaults();
  snapshot.dismissedAgentCleanupHints = { hermes: true };

  const result = agentCommands.dismissAgentCleanupHints({
    agentIds: ["qwen-code", "hermes", "qwen-code"],
  }, { snapshot });

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(result.commit.dismissedAgentCleanupHints, {
    hermes: true,
    "qwen-code": true,
  });
});

test("settings agent actions clear agent cleanup hints in one commit", () => {
  const snapshot = prefs.getDefaults();
  snapshot.dismissedAgentCleanupHints = { "qwen-code": true, hermes: true };

  const result = agentCommands.clearAgentCleanupHints({
    agentIds: ["qwen-code", "copilot-cli"],
  }, { snapshot });

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(result.commit.dismissedAgentCleanupHints, { hermes: true });
});

test("settings agent actions clear agent install hints in one commit", () => {
  const snapshot = prefs.getDefaults();
  snapshot.dismissedAgentInstallHints = { "qwen-code": true, hermes: true };

  const result = agentCommands.clearAgentInstallHints({
    agentIds: ["qwen-code", "copilot-cli"],
  }, { snapshot });

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(result.commit.dismissedAgentInstallHints, { hermes: true });
});

test("settings agent actions do not commit uninstall failures", async () => {
  const result = await agentCommands.uninstallAgentIntegration({ agentId: "copilot-cli" }, {
    snapshot: prefs.getDefaults(),
    uninstallIntegrationForAgent: async () => ({ status: "error", message: "write failed" }),
  });

  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.commit, undefined);
  assert.match(result.message, /write failed/);
});

test("settings agent actions block repair for uninstalled integrations", async () => {
  const snapshot = prefs.getDefaults();
  snapshot.agents["copilot-cli"].integrationInstalled = false;
  snapshot.agents["copilot-cli"].enabled = true;
  const result = await agentCommands.repairAgentIntegration({ agentId: "copilot-cli" }, {
    snapshot,
    repairIntegrationForAgent: async () => {
      throw new Error("should not run");
    },
  });

  assert.strictEqual(result.status, "error");
  assert.match(result.message, /not installed/);
});

test("settings agent actions report repair payload errors with the repair command name", async () => {
  const result = await agentCommands.repairAgentIntegration({}, {
    snapshot: prefs.getDefaults(),
    repairIntegrationForAgent: async () => {
      throw new Error("should not run");
    },
  });

  assert.strictEqual(result.status, "error");
  assert.match(result.message, /repairAgentIntegration\.agentId/);
});
