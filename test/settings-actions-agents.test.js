"use strict";

const test = require("node:test");
const assert = require("node:assert");

const prefs = require("../src/prefs");
const agentCommands = require("../src/settings-actions-agents");
const { commandRegistry } = require("../src/settings-actions");

test("settings agent actions expose the command surface", () => {
  assert.deepStrictEqual(Object.keys(agentCommands).sort(), [
    "AUTO_REPAIRABLE_AGENT_IDS",
    "INSTALLABLE_AGENT_IDS",
    "addCustomApplication",
    "clearAgentCleanupHints",
    "clearAgentInstallHints",
    "deployToWsl",
    "dismissAgentCleanupHints",
    "dismissAgentInstallHints",
    "installAgentIntegration",
    "removeCustomApplication",
    "removeFromWsl",
    "repairAgentIntegration",
    "setAgentCustomDiscoveryPaths",
    "setAgentCustomPermissionUrl",
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
  assert.strictEqual(agentCommands.setAgentCustomPermissionUrl.lockKey, "agentIntegration");
  assert.strictEqual(agentCommands.setAgentCustomDiscoveryPaths.lockKey, "agentIntegration");
  assert.strictEqual(agentCommands.addCustomApplication.lockKey, "agentIntegration");
  assert.strictEqual(agentCommands.removeCustomApplication.lockKey, "agentIntegration");
  assert.strictEqual(agentCommands.dismissAgentInstallHints.lockKey, "agentIntegration");
  assert.strictEqual(agentCommands.dismissAgentCleanupHints.lockKey, "agentIntegration");
  assert.strictEqual(agentCommands.clearAgentCleanupHints.lockKey, "agentIntegration");
  assert.strictEqual(agentCommands.clearAgentInstallHints.lockKey, "agentIntegration");
});

test("settings agent actions save a CodeBuddy-compatible custom permission URL", () => {
  const snapshot = prefs.getDefaults();
  const result = agentCommands.setAgentCustomPermissionUrl({
    agentId: "codebuddy",
    value: " https://approval.example.test/permission ",
  }, { snapshot });

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(
    result.commit.agents.codebuddy.customPermissionUrl,
    "https://approval.example.test/permission"
  );
});

test("settings command registry exposes custom AI add, remove, and discovery commands", () => {
  assert.strictEqual(commandRegistry.addCustomApplication, agentCommands.addCustomApplication);
  assert.strictEqual(commandRegistry.removeCustomApplication, agentCommands.removeCustomApplication);
  assert.strictEqual(commandRegistry.setAgentCustomDiscoveryPaths, agentCommands.setAgentCustomDiscoveryPaths);
  assert.strictEqual(commandRegistry.setAgentCustomPermissionUrl, agentCommands.setAgentCustomPermissionUrl);
});

test("settings agent actions add and deduplicate a recognized custom AI", () => {
  const snapshot = prefs.getDefaults();
  const application = {
    id: "custom-nova-ai-0123456789ab",
    name: "Nova AI",
    sourcePath: "C:\\NovaAI",
    executablePath: "C:\\NovaAI\\NovaAI.exe",
    processName: "NovaAI.exe",
    category: "code",
  };
  const result = agentCommands.addCustomApplication({ path: application.sourcePath }, {
    snapshot,
    identifyCustomApplication: () => application,
  });
  assert.deepStrictEqual(result.commit.customApplications, [application]);
  assert.deepStrictEqual(result.commit.agents[application.id], {
    integrationInstalled: false,
    enabled: true,
    permissionsEnabled: false,
    notificationHookEnabled: true,
  });
  assert.strictEqual(result.application.managedIntegration, false);
  assert.strictEqual(result.application.permissionApproval, false);
  const duplicate = agentCommands.addCustomApplication({ path: application.sourcePath }, {
    snapshot: { ...snapshot, customApplications: [application] },
    identifyCustomApplication: () => application,
  });
  assert.strictEqual(duplicate.noop, true);
});

test("settings agent actions reject unidentified paths and clean up removed custom AI", () => {
  const id = "custom-nova-ai-0123456789ab";
  assert.strictEqual(agentCommands.addCustomApplication({ path: "C:\\missing" }, {
    snapshot: prefs.getDefaults(),
    identifyCustomApplication: () => null,
  }).status, "error");
  assert.strictEqual(agentCommands.addCustomApplication({ path: "C:\\bad-id.exe" }, {
    snapshot: prefs.getDefaults(),
    identifyCustomApplication: () => ({
      id: "custom-invalid",
      name: "Invalid",
      sourcePath: "C:\\bad-id.exe",
      executablePath: "C:\\bad-id.exe",
      processName: "bad-id.exe",
    }),
  }).status, "error");
  const calls = [];
  const result = agentCommands.removeCustomApplication({ id }, {
    snapshot: {
      customApplications: [{ id }],
      agents: { [id]: { enabled: true } },
    },
    clearSessionAutomationByAgent: (agentId) => calls.push(["automation", agentId]),
    clearSessionsByAgent: (agentId) => calls.push(["sessions", agentId]),
    dismissPermissionsByAgent: (agentId) => calls.push(["permissions", agentId]),
    clearRecentHookEvents: (agentId) => calls.push(["ring", agentId]),
  });
  assert.deepStrictEqual(result.commit.customApplications, []);
  assert.strictEqual(result.commit.agents[id], undefined);
  assert.deepStrictEqual(calls, [
    ["automation", id],
    ["sessions", id],
    ["permissions", id],
    ["ring", id],
  ]);
});

test("settings agent actions enforce the persisted custom AI limit", () => {
  const application = {
    id: "custom-over-limit-0123456789ab",
    name: "Over Limit",
    sourcePath: "C:\\OverLimit.exe",
    executablePath: "C:\\OverLimit.exe",
    processName: "OverLimit.exe",
    category: "code",
  };
  const current = Array.from({ length: 32 }, (_, index) => ({ id: `custom-app-${String(index).padStart(2, "0")}-0123456789ab` }));
  const result = agentCommands.addCustomApplication({ path: application.sourcePath }, {
    snapshot: { customApplications: current, agents: {} },
    identifyCustomApplication: () => application,
  });
  assert.strictEqual(result.status, "error");
  assert.match(result.message, /limit reached/);
});

test("settings agent actions sync an installed custom permission URL change immediately", () => {
  const snapshot = prefs.getDefaults();
  snapshot.agents.codebuddy.integrationInstalled = true;
  const calls = [];
  const result = agentCommands.setAgentCustomPermissionUrl({
    agentId: "codebuddy",
    value: "https://approval.example.test/permission",
  }, {
    snapshot,
    syncIntegrationForAgent: (agentId, options) => calls.push({ agentId, options }),
  });

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(calls, [{
    agentId: "codebuddy",
    options: { permissionTarget: { mode: "custom", url: "https://approval.example.test/permission" } },
  }]);
  assert.strictEqual(
    result.commit.agents.codebuddy.customPermissionUrl,
    "https://approval.example.test/permission"
  );
});

test("settings agent actions sync clearing an installed custom permission URL immediately", () => {
  const snapshot = prefs.getDefaults();
  snapshot.agents.codebuddy.integrationInstalled = true;
  snapshot.agents.codebuddy.customPermissionUrl = "https://approval.example.test/permission";
  const calls = [];
  const result = agentCommands.setAgentCustomPermissionUrl({
    agentId: "codebuddy",
    value: "",
  }, {
    snapshot,
    syncIntegrationForAgent: (agentId, options) => calls.push({ agentId, options }),
  });

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(calls, [{
    agentId: "codebuddy",
    options: { permissionTarget: { mode: "local" } },
  }]);
  assert.strictEqual(result.commit.agents.codebuddy.customPermissionUrl, "");
});

test("settings agent actions reject non-http custom permission URLs", () => {
  const result = agentCommands.setAgentCustomPermissionUrl({
    agentId: "codebuddy",
    value: "file:///tmp/permission",
  }, { snapshot: prefs.getDefaults() });

  assert.strictEqual(result.status, "error");
  assert.match(result.message, /http/);
});

test("settings agent actions save custom discovery paths for the shared custom slot", () => {
  const snapshot = prefs.getDefaults();
  const result = agentCommands.setAgentCustomDiscoveryPaths({
    agentId: "custom",
    value: "C:\\Tools\\AI.exe; C:\\Tools\\AI.exe\nC:\\Tools\\AI\\config",
  }, { snapshot });

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(result.commit.customToolDiscoveryPaths, [
    "C:\\Tools\\AI.exe",
    "C:\\Tools\\AI\\config",
  ]);
});

test("settings agent actions reject permission gates for custom state-only agents", () => {
  const result = agentCommands.setAgentFlag({
    agentId: "custom-nova-ai-0123456789ab",
    flag: "permissionsEnabled",
    value: true,
  }, { snapshot: prefs.getDefaults() });

  assert.strictEqual(result.status, "error");
  assert.match(result.message, /state-only/);
});

test("settings agent actions preserve semicolons in array paths and reject overflow", () => {
  const snapshot = prefs.getDefaults();
  const valid = agentCommands.setAgentCustomDiscoveryPaths({
    agentId: "custom",
    value: ["C:\\Tools;Lab\\AI.exe"],
  }, { snapshot });
  assert.deepStrictEqual(valid.commit.customToolDiscoveryPaths, ["C:\\Tools;Lab\\AI.exe"]);

  const tooMany = agentCommands.setAgentCustomDiscoveryPaths({
    agentId: "custom",
    value: Array.from({ length: 65 }, (_, index) => `C:\\Tools\\AI-${index}`),
  }, { snapshot });
  assert.strictEqual(tooMany.status, "error");
  assert.match(tooMany.message, /limit reached/);

  const tooLong = agentCommands.setAgentCustomDiscoveryPaths({
    agentId: "custom",
    value: [`C:\\${"x".repeat(2050)}`],
  }, { snapshot });
  assert.strictEqual(tooLong.status, "error");
  assert.match(tooLong.message, /at most/);
});

test("settings agent actions save discovery overrides on a registered agent", () => {
  const snapshot = prefs.getDefaults();
  const result = agentCommands.setAgentCustomDiscoveryPaths({
    agentId: "qwen-code",
    value: "C:\\Tools\\Qwen",
  }, { snapshot });

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(result.commit.agents["qwen-code"].customDiscoveryPaths, ["C:\\Tools\\Qwen"]);
  assert.strictEqual(result.commit.customToolDiscoveryPaths, undefined);
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
    writeCodexAutoStartGate: [],
  };
  const deps = {
    snapshot,
    syncIntegrationForAgent: (agentId) => calls.syncIntegrationForAgent.push(agentId),
    startMonitorForAgent: (agentId) => calls.startMonitorForAgent.push(agentId),
    writeCodexAutoStartGate: (enabled) => {
      calls.writeCodexAutoStartGate.push(enabled);
      return true;
    },
  };

  const result = agentCommands.setAgentFlag(
    { agentId: "codex", flag: "enabled", value: true },
    deps
  );

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(calls.syncIntegrationForAgent, ["codex"]);
  assert.deepStrictEqual(calls.startMonitorForAgent, ["codex"]);
  assert.deepStrictEqual(
    calls.writeCodexAutoStartGate,
    [],
    "the post-commit agents subscriber publishes the enabled gate"
  );
  assert.strictEqual(result.commit.agents.codex.enabled, true);
  assert.strictEqual(result.commit.agents.codex.permissionsEnabled, false);
  assert.strictEqual(result.commit.agents.codex.notificationHookEnabled, true);
  assert.strictEqual(result.commit.agents.codex.permissionMode, "intercept");
});

test("settings agent actions fail closed when the Codex auto-start gate cannot sync", () => {
  const snapshot = prefs.getDefaults();
  const calls = [];
  const result = agentCommands.setAgentFlag(
    { agentId: "codex", flag: "enabled", value: false },
    {
      snapshot,
      writeCodexAutoStartGate: (enabled) => {
        calls.push(enabled);
        return false;
      },
      stopMonitorForAgent: () => calls.push("stop"),
    }
  );

  assert.strictEqual(result.status, "error");
  assert.match(result.message, /auto-start gate/);
  assert.deepStrictEqual(calls, [false]);
  assert.strictEqual(result.commit, undefined);
});

test("settings agent actions persist the disabled Codex gate before runtime cleanup", () => {
  const snapshot = prefs.getDefaults();
  const calls = [];
  const result = agentCommands.setAgentFlag(
    { agentId: "codex", flag: "enabled", value: false },
    {
      snapshot,
      writeCodexAutoStartGate: (enabled) => {
        calls.push(`gate:${enabled}`);
        return true;
      },
      stopMonitorForAgent: () => calls.push("stop"),
      clearSessionAutomationByAgent: () => calls.push("automation"),
      clearSessionsByAgent: () => calls.push("sessions"),
      dismissPermissionsByAgent: () => calls.push("permissions"),
    }
  );

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(calls, [
    "gate:false",
    "stop",
    "automation",
    "sessions",
    "permissions",
  ]);
  assert.strictEqual(result.commit.agents.codex.enabled, false);
});

test("disabling an agent clears session automation before sessions and permissions", () => {
  const snapshot = prefs.getDefaults();
  snapshot.agents["qwen-code"] = {
    integrationInstalled: true,
    enabled: true,
    permissionsEnabled: true,
    notificationHookEnabled: true,
  };
  const calls = [];
  const result = agentCommands.setAgentFlag(
    { agentId: "qwen-code", flag: "enabled", value: false },
    {
      snapshot,
      stopMonitorForAgent: (id) => calls.push(`stop:${id}`),
      clearSessionAutomationByAgent: (id) => calls.push(`automation:${id}`),
      clearSessionsByAgent: (id) => calls.push(`sessions:${id}`),
      dismissPermissionsByAgent: (id) => calls.push(`permissions:${id}`),
    }
  );
  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(calls, [
    "stop:qwen-code",
    "automation:qwen-code",
    "sessions:qwen-code",
    "permissions:qwen-code",
  ]);
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

test("settings agent actions await the Claude enable queue before starting the monitor or committing", async () => {
  const snapshot = prefs.getDefaults();
  snapshot.agents["claude-code"] = {
    integrationInstalled: true,
    enabled: false,
    permissionsEnabled: true,
    notificationHookEnabled: true,
  };
  let resolveSync;
  const calls = { syncIntegrationForAgent: [], startMonitorForAgent: [] };
  const deps = {
    snapshot,
    syncIntegrationForAgent: (agentId, options) => {
      calls.syncIntegrationForAgent.push({ agentId, options });
      return new Promise((resolve) => { resolveSync = resolve; });
    },
    startMonitorForAgent: (agentId) => calls.startMonitorForAgent.push(agentId),
  };

  const pending = agentCommands.setAgentFlag({ agentId: "claude-code", flag: "enabled", value: true }, deps);
  assert.ok(typeof pending.then === "function", "claude-code enable must return a Promise");

  // setAgentFlag's async branch reaches deps.syncIntegrationForAgent one
  // microtask tick later (Promise.resolve().then(...)); flush that tick
  // before asserting the monitor hasn't started and grabbing resolveSync.
  await Promise.resolve();
  assert.deepStrictEqual(calls.startMonitorForAgent, [], "monitor must not start before the queue settles");

  resolveSync({ status: "ok" });
  const result = await pending;

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.commit.agents["claude-code"].enabled, true);
  assert.deepStrictEqual(calls.startMonitorForAgent, ["claude-code"]);
  assert.deepStrictEqual(calls.syncIntegrationForAgent, [
    { agentId: "claude-code", options: { source: "settings-agent-enable", automatic: false } },
  ]);
});

test("settings agent actions do not commit or start the monitor when the Claude enable queue fails", async () => {
  const snapshot = prefs.getDefaults();
  snapshot.agents["claude-code"] = {
    integrationInstalled: true,
    enabled: false,
    permissionsEnabled: true,
  };
  const calls = { startMonitorForAgent: [] };
  const deps = {
    snapshot,
    syncIntegrationForAgent: async () => ({ status: "error", message: "write failed" }),
    startMonitorForAgent: (agentId) => calls.startMonitorForAgent.push(agentId),
  };

  const result = await agentCommands.setAgentFlag({ agentId: "claude-code", flag: "enabled", value: true }, deps);

  assert.strictEqual(result.status, "error");
  assert.match(result.message, /write failed/);
  assert.strictEqual(result.commit, undefined);
  assert.deepStrictEqual(calls.startMonitorForAgent, []);
});

test("settings agent actions keep Claude enable synchronous when the integration is not installed", () => {
  const snapshot = prefs.getDefaults();
  snapshot.agents["claude-code"] = {
    integrationInstalled: false,
    enabled: false,
    permissionsEnabled: true,
  };
  const calls = { syncIntegrationForAgent: [], startMonitorForAgent: [] };
  const deps = {
    snapshot,
    syncIntegrationForAgent: (agentId) => calls.syncIntegrationForAgent.push(agentId),
    startMonitorForAgent: (agentId) => calls.startMonitorForAgent.push(agentId),
  };

  const result = agentCommands.setAgentFlag({ agentId: "claude-code", flag: "enabled", value: true }, deps);

  assert.strictEqual(typeof result.then, "undefined", "must stay synchronous when Claude is not installed");
  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(calls.syncIntegrationForAgent, []);
  assert.deepStrictEqual(calls.startMonitorForAgent, ["claude-code"]);
});

test("settings agent actions install Claude Code with the settings-agent-install source, non-automatic", async () => {
  const calls = [];
  const result = await agentCommands.installAgentIntegration({ agentId: "claude-code" }, {
    snapshot: prefs.getDefaults(),
    syncIntegrationForAgent: async (agentId, options) => {
      calls.push({ agentId, options });
      return { status: "ok" };
    },
  });

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(calls, [
    { agentId: "claude-code", options: { source: "settings-agent-install", automatic: false } },
  ]);
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

test("settings agent actions repair CodeBuddy with an explicit permission target", async () => {
  const customSnapshot = prefs.getDefaults();
  customSnapshot.agents.codebuddy.integrationInstalled = true;
  customSnapshot.agents.codebuddy.enabled = true;
  customSnapshot.agents.codebuddy.customPermissionUrl = "https://approval.example.test/permission";
  const calls = [];
  const repairIntegrationForAgent = async (agentId, options) => {
    calls.push({ agentId, options });
    return { status: "ok", message: "repaired" };
  };

  await agentCommands.repairAgentIntegration({ agentId: "codebuddy" }, {
    snapshot: customSnapshot,
    repairIntegrationForAgent,
  });
  const localSnapshot = prefs.getDefaults();
  localSnapshot.agents.codebuddy.integrationInstalled = true;
  localSnapshot.agents.codebuddy.enabled = true;
  await agentCommands.repairAgentIntegration({ agentId: "codebuddy" }, {
    snapshot: localSnapshot,
    repairIntegrationForAgent,
  });

  assert.deepStrictEqual(calls, [
    {
      agentId: "codebuddy",
      options: {
        permissionTarget: { mode: "custom", url: "https://approval.example.test/permission" },
        forceCodexHooksFeature: false,
      },
    },
    {
      agentId: "codebuddy",
      options: { permissionTarget: { mode: "local" }, forceCodexHooksFeature: false },
    },
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

test("settings agent actions defer the enabled Codex gate on install but disable it before uninstall", async () => {
  const installSnapshot = prefs.getDefaults();
  installSnapshot.agents.codex.integrationInstalled = false;
  installSnapshot.agents.codex.enabled = false;
  const calls = [];
  const installed = await agentCommands.installAgentIntegration({ agentId: "codex" }, {
    snapshot: installSnapshot,
    syncIntegrationForAgent: async () => ({ status: "ok" }),
    writeCodexAutoStartGate: (enabled) => {
      calls.push(`install:${enabled}`);
      return true;
    },
  });
  assert.strictEqual(installed.status, "ok");
  assert.strictEqual(installed.commit.agents.codex.enabled, true);

  const uninstallSnapshot = prefs.getDefaults();
  const uninstalled = await agentCommands.uninstallAgentIntegration({ agentId: "codex" }, {
    snapshot: uninstallSnapshot,
    writeCodexAutoStartGate: (enabled) => {
      calls.push(`uninstall:${enabled}`);
      return true;
    },
    uninstallIntegrationForAgent: async () => ({ status: "ok" }),
  });
  assert.strictEqual(uninstalled.status, "ok");
  assert.strictEqual(uninstalled.commit.agents.codex.enabled, false);
  assert.deepStrictEqual(calls, ["uninstall:false"]);
});

test("settings agent actions pass CodeBuddy custom hook URL during install", async () => {
  const snapshot = prefs.getDefaults();
  snapshot.agents.codebuddy.customPermissionUrl = "https://approval.example.test/permission";
  const calls = [];
  const deps = {
    snapshot,
    syncIntegrationForAgent: async (agentId, options) => {
      calls.push({ agentId, options });
      return { status: "ok", message: "installed" };
    },
  };

  const result = await agentCommands.installAgentIntegration({ agentId: "codebuddy" }, deps);

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(calls, [{
    agentId: "codebuddy",
    options: {
      permissionTarget: { mode: "custom", url: "https://approval.example.test/permission" },
      source: "settings-agent-install",
      automatic: false,
    },
  }]);
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
    clearSessionAutomationByAgent: (agentId) => calls.push(`automation:${agentId}`),
    clearSessionsByAgent: (agentId) => calls.push(`clear:${agentId}`),
    dismissPermissionsByAgent: (agentId) => calls.push(`dismiss:${agentId}`),
  };

  const result = await agentCommands.uninstallAgentIntegration({ agentId: "copilot-cli" }, deps);

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(calls, [
    "copilot-cli",
    "stop:copilot-cli",
    "automation:copilot-cli",
    "clear:copilot-cli",
    "dismiss:copilot-cli",
  ]);
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

test("settings agent actions preserve structured DSH inspection guidance", async () => {
  const snapshot = prefs.getDefaults();
  const failure = {
    status: "error",
    reason: "inspection-required",
    manualCommand: 'dsh plugin --profile web add "C:/managed/generation"',
    supportedRange: "=0.1.0-rc.6",
    detectedVersion: "0.1.0-rc.7",
    manualInspectionRequired: true,
    message: "DSH mutation needs inspection",
  };
  const result = await agentCommands.installAgentIntegration({ agentId: "deepseek-harness" }, {
    snapshot,
    syncIntegrationForAgent: async () => failure,
  });
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.reason, failure.reason);
  assert.strictEqual(result.manualCommand, failure.manualCommand);
  assert.strictEqual(result.supportedRange, failure.supportedRange);
  assert.strictEqual(result.detectedVersion, failure.detectedVersion);
  assert.strictEqual(result.manualInspectionRequired, true);
  assert.match(result.message, /dsh plugin --profile web add/);
  assert.strictEqual(result.commit, undefined);
});

test("settings DSH install and repair surface the conservative restart hint", async () => {
  const restartHint = "DeepSeek Harness bridge verified on disk. Restart any running dsh web process to load this plugin generation.";
  const installSnapshot = prefs.getDefaults();
  const install = await agentCommands.installAgentIntegration({ agentId: "deepseek-harness" }, {
    snapshot: installSnapshot,
    syncIntegrationForAgent: async () => ({ status: "ok", message: restartHint }),
  });
  assert.strictEqual(install.status, "ok");
  assert.strictEqual(install.message, restartHint);

  const repairSnapshot = prefs.getDefaults();
  repairSnapshot.agents["deepseek-harness"].integrationInstalled = true;
  repairSnapshot.agents["deepseek-harness"].enabled = true;
  const repair = await agentCommands.repairAgentIntegration({ agentId: "deepseek-harness" }, {
    snapshot: repairSnapshot,
    repairIntegrationForAgent: async () => ({ status: "ok", message: restartHint }),
  });
  assert.strictEqual(repair.status, "ok");
  assert.strictEqual(repair.message, restartHint);
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

test("settings agent actions install, uninstall, and repair ZCode through the real action gates", async () => {
  const installSnapshot = prefs.getDefaults();
  const installCalls = [];
  const installed = await agentCommands.installAgentIntegration({ agentId: "zcode" }, {
    snapshot: installSnapshot,
    syncIntegrationForAgent: async (agentId, options) => {
      installCalls.push({ agentId, options });
      return { status: "ok", message: "ZCode hooks installed" };
    },
    startMonitorForAgent: (agentId) => installCalls.push({ start: agentId }),
  });

  assert.strictEqual(installed.status, "ok");
  assert.deepStrictEqual(installCalls, [
    {
      agentId: "zcode",
      options: { source: "settings-agent-install", automatic: false },
    },
    { start: "zcode" },
  ]);
  assert.strictEqual(installed.commit.agents.zcode.integrationInstalled, true);
  assert.strictEqual(installed.commit.agents.zcode.enabled, true);

  const activeSnapshot = {
    ...installSnapshot,
    agents: installed.commit.agents,
  };
  const repairCalls = [];
  const repaired = await agentCommands.repairAgentIntegration({ agentId: "zcode" }, {
    snapshot: activeSnapshot,
    repairIntegrationForAgent: async (agentId, options) => {
      repairCalls.push({ agentId, options });
      return { status: "ok", message: "ZCode hooks repaired" };
    },
  });

  assert.strictEqual(repaired.status, "ok");
  assert.deepStrictEqual(repairCalls, [{
    agentId: "zcode",
    options: { forceCodexHooksFeature: false },
  }]);

  const uninstallCalls = [];
  const uninstalled = await agentCommands.uninstallAgentIntegration({ agentId: "zcode" }, {
    snapshot: activeSnapshot,
    uninstallIntegrationForAgent: async (agentId) => {
      uninstallCalls.push(["uninstall", agentId]);
      return { status: "ok" };
    },
    stopMonitorForAgent: (agentId) => uninstallCalls.push(["stop", agentId]),
    clearSessionsByAgent: (agentId) => uninstallCalls.push(["clear", agentId]),
    dismissPermissionsByAgent: (agentId) => uninstallCalls.push(["dismiss", agentId]),
  });

  assert.strictEqual(uninstalled.status, "ok");
  assert.deepStrictEqual(uninstallCalls, [
    ["uninstall", "zcode"],
    ["stop", "zcode"],
    ["clear", "zcode"],
    ["dismiss", "zcode"],
  ]);
  assert.strictEqual(uninstalled.commit.agents.zcode.integrationInstalled, false);
  assert.strictEqual(uninstalled.commit.agents.zcode.enabled, false);
});

test("every opencode-family member is installable AND auto-repairable (R10 P3)", () => {
  // AUTO_REPAIRABLE_AGENT_IDS gates repairAgentIntegration; INSTALLABLE
  // gates install/uninstall. Dropping a family member from either set turns
  // the Settings/Doctor Repair buttons into "no automatic repair available"
  // with every other test green (GPT-5.5 review mutation).
  const { OPENCODE_FAMILY } = require("../agents/opencode-family");
  for (const agentId of Object.keys(OPENCODE_FAMILY)) {
    assert.ok(
      agentCommands.INSTALLABLE_AGENT_IDS.has(agentId),
      `${agentId} missing from INSTALLABLE_AGENT_IDS`
    );
    assert.ok(
      agentCommands.AUTO_REPAIRABLE_AGENT_IDS.has(agentId),
      `${agentId} missing from AUTO_REPAIRABLE_AGENT_IDS`
    );
  }
});

test("successful Hermes WSL Pair opens ingress without claiming a local install", async () => {
  const snapshot = prefs.getDefaults();
  snapshot.agents.hermes = {
    integrationInstalled: false,
    enabled: false,
    permissionsEnabled: true,
    notificationHookEnabled: true,
  };
  const result = await agentCommands.deployToWsl({ agentId: "hermes", distro: "Ubuntu" }, {
    snapshot,
    deployHooksToWsl: async (distro, agentId) => ({
      ok: true,
      distro,
      agentId,
      message: "Hermes plugin installed",
      warning: "one profile failed",
    }),
  });

  assert.strictEqual(result.status, "ok", "warning must stay top-level ok so controller applies commit");
  assert.strictEqual(result.warning, "one profile failed");
  assert.strictEqual(result.commit.agents.hermes.enabled, true);
  assert.strictEqual(result.commit.agents.hermes.integrationInstalled, false);
  assert.strictEqual(result.commit.agents.hermes.permissionsEnabled, true);
});

test("Hermes WSL Pair preserves an existing local installation flag", async () => {
  const snapshot = prefs.getDefaults();
  snapshot.agents.hermes.integrationInstalled = true;
  snapshot.agents.hermes.enabled = false;
  const result = await agentCommands.deployToWsl({ agentId: "hermes", distro: "Ubuntu" }, {
    snapshot,
    deployHooksToWsl: async () => ({ ok: true }),
  });
  assert.strictEqual(result.commit.agents.hermes.integrationInstalled, true);
  assert.strictEqual(result.commit.agents.hermes.enabled, true);
});

test("failed Hermes WSL Pair does not open ingress", async () => {
  const result = await agentCommands.deployToWsl({ agentId: "hermes", distro: "Ubuntu" }, {
    snapshot: prefs.getDefaults(),
    deployHooksToWsl: async () => ({ ok: false, message: "enable failed" }),
  });
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.commit, undefined);
  assert.match(result.message, /enable failed/);
});

test("Hermes WSL Unpair propagates warnings without disabling the global gate", async () => {
  const snapshot = prefs.getDefaults();
  snapshot.agents.hermes.enabled = true;
  const result = await agentCommands.removeFromWsl({ agentId: "hermes", distro: "Ubuntu" }, {
    snapshot,
    removeHooksFromWsl: async () => ({ ok: true, message: "removed", warning: "disable failed" }),
  });
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.warning, "disable failed");
  assert.strictEqual(result.commit, undefined);
  assert.strictEqual(snapshot.agents.hermes.enabled, true);
});
