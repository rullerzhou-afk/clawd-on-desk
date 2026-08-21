"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createRuntimeAgentGate,
  getCodexPermissionMode,
  isAgentEnabled,
  isAgentIntegrationInstalled,
  isAgentPermissionsEnabled,
  isAgentSubagentPermissionsEnabled,
  isAgentNotificationHookEnabled,
  isCodexNativeNotificationSoundEnabled,
  isCodexPermissionInterceptEnabled,
  shouldSyncAgentIntegration,
} = require("../src/agent-gate");
const { commandRegistry } = require("../src/settings-actions");
const prefs = require("../src/prefs");

describe("isAgentEnabled", () => {
  it("returns true when snapshot is missing", () => {
    assert.strictEqual(isAgentEnabled(null, "codex"), true);
    assert.strictEqual(isAgentEnabled(undefined, "codex"), true);
    assert.strictEqual(isAgentEnabled({}, "codex"), true);
  });

  it("returns true when agentId is missing", () => {
    const snap = prefs.getDefaults();
    assert.strictEqual(isAgentEnabled(snap, null), true);
    assert.strictEqual(isAgentEnabled(snap, ""), true);
  });

  it("returns true when agents field is absent (legacy upgrade)", () => {
    assert.strictEqual(isAgentEnabled({ lang: "en" }, "codex"), true);
  });

  it("returns true when the agent id is not in the map", () => {
    // Unknown agent ids default-true so a freshly-added registry agent isn't
    // accidentally off for every existing install.
    const snap = prefs.getDefaults();
    assert.strictEqual(isAgentEnabled(snap, "future-agent-id"), true);
  });

  it("returns true when enabled is not false", () => {
    const snap = { agents: { codex: { enabled: true } } };
    assert.strictEqual(isAgentEnabled(snap, "codex"), true);
  });

  it("returns false only when enabled === false", () => {
    assert.strictEqual(
      isAgentEnabled({ agents: { codex: { enabled: false } } }, "codex"),
      false
    );
  });

  it("treats malformed agent entries as enabled", () => {
    assert.strictEqual(isAgentEnabled({ agents: { codex: "nope" } }, "codex"), true);
    assert.strictEqual(isAgentEnabled({ agents: { codex: null } }, "codex"), true);
  });
});

describe("isAgentIntegrationInstalled", () => {
  it("defaults true for missing legacy snapshots", () => {
    assert.strictEqual(isAgentIntegrationInstalled(null, "copilot-cli"), true);
    assert.strictEqual(isAgentIntegrationInstalled({ lang: "en" }, "copilot-cli"), true);
    assert.strictEqual(isAgentIntegrationInstalled({ agents: { "copilot-cli": {} } }, "copilot-cli"), true);
  });

  it("reads explicit installed intent from normalized prefs", () => {
    const snap = prefs.getDefaults();
    assert.strictEqual(isAgentIntegrationInstalled(snap, "claude-code"), true);
    assert.strictEqual(isAgentIntegrationInstalled(snap, "codex"), true);
    assert.strictEqual(isAgentIntegrationInstalled(snap, "copilot-cli"), false);
  });

  it("combines installed intent and enabled for startup sync", () => {
    assert.strictEqual(
      shouldSyncAgentIntegration({ agents: { codex: { integrationInstalled: true, enabled: true } } }, "codex"),
      true
    );
    assert.strictEqual(
      shouldSyncAgentIntegration({ agents: { codex: { integrationInstalled: false, enabled: true } } }, "codex"),
      false
    );
    assert.strictEqual(
      shouldSyncAgentIntegration({ agents: { codex: { integrationInstalled: true, enabled: false } } }, "codex"),
      false
    );
  });
});

describe("isAgentPermissionsEnabled", () => {
  it("returns true when snapshot is missing", () => {
    assert.strictEqual(isAgentPermissionsEnabled(null, "claude-code"), true);
    assert.strictEqual(isAgentPermissionsEnabled(undefined, "claude-code"), true);
    assert.strictEqual(isAgentPermissionsEnabled({}, "claude-code"), true);
  });

  it("returns true when agentId is missing", () => {
    const snap = prefs.getDefaults();
    assert.strictEqual(isAgentPermissionsEnabled(snap, null), true);
    assert.strictEqual(isAgentPermissionsEnabled(snap, ""), true);
  });

  it("returns true when agents field is absent (legacy upgrade)", () => {
    assert.strictEqual(isAgentPermissionsEnabled({ lang: "en" }, "claude-code"), true);
  });

  it("returns true when the agent id is unknown to the registry", () => {
    const snap = prefs.getDefaults();
    assert.strictEqual(isAgentPermissionsEnabled(snap, "future-agent-id"), true);
  });

  it("returns true when permissionsEnabled flag is absent (pre-subgate prefs file)", () => {
    // A prefs file written before the sub-gate existed has {enabled: true}
    // only. The gate must not flip those users to "bubbles off" on upgrade.
    assert.strictEqual(
      isAgentPermissionsEnabled({ agents: { "claude-code": { enabled: true } } }, "claude-code"),
      true
    );
  });

  it("returns false only when permissionsEnabled === false", () => {
    assert.strictEqual(
      isAgentPermissionsEnabled(
        { agents: { "claude-code": { enabled: true, permissionsEnabled: false } } },
        "claude-code"
      ),
      false
    );
  });

  it("is independent of the master enabled flag (does NOT short-circuit)", () => {
    // A disabled agent with the sub-flag still on reads as permissions-on —
    // callers are expected to check the master gate first. Keeping the gates
    // independent lets the UI ask "what's the sub switch state" truthfully
    // even while master is off.
    assert.strictEqual(
      isAgentPermissionsEnabled(
        { agents: { "claude-code": { enabled: false, permissionsEnabled: true } } },
        "claude-code"
      ),
      true
    );
    assert.strictEqual(
      isAgentPermissionsEnabled(
        { agents: { "claude-code": { enabled: false, permissionsEnabled: false } } },
        "claude-code"
      ),
      false
    );
  });

  it("treats malformed agent entries as permissions-enabled", () => {
    assert.strictEqual(
      isAgentPermissionsEnabled({ agents: { "claude-code": "nope" } }, "claude-code"),
      true
    );
    assert.strictEqual(
      isAgentPermissionsEnabled({ agents: { "claude-code": null } }, "claude-code"),
      true
    );
  });
});

describe("isAgentNotificationHookEnabled", () => {
  it("returns true for missing snapshot / agentId / agents field", () => {
    assert.strictEqual(isAgentNotificationHookEnabled(null, "claude-code"), true);
    assert.strictEqual(isAgentNotificationHookEnabled({}, "claude-code"), true);
    assert.strictEqual(isAgentNotificationHookEnabled(prefs.getDefaults(), null), true);
    assert.strictEqual(isAgentNotificationHookEnabled({ lang: "en" }, "claude-code"), true);
  });

  it("returns true when the flag is absent (pre-flag prefs file)", () => {
    // Upgrade path: existing users have {enabled, permissionsEnabled} only —
    // they must keep hearing idle alerts unless they explicitly turn them off.
    assert.strictEqual(
      isAgentNotificationHookEnabled(
        { agents: { "claude-code": { enabled: true, permissionsEnabled: true } } },
        "claude-code"
      ),
      true
    );
  });

  it("returns false only when notificationHookEnabled === false", () => {
    assert.strictEqual(
      isAgentNotificationHookEnabled(
        { agents: { "claude-code": { notificationHookEnabled: false } } },
        "claude-code"
      ),
      false
    );
  });

  it("is independent of master enabled / permissionsEnabled flags", () => {
    // The Agents tab reads each sub-switch's committed state regardless of
    // master or sibling sub state, so these gates must not short-circuit
    // into each other.
    const snap = {
      agents: {
        "claude-code": {
          enabled: false,
          permissionsEnabled: false,
          notificationHookEnabled: true,
        },
      },
    };
    assert.strictEqual(isAgentNotificationHookEnabled(snap, "claude-code"), true);
  });
});

describe("Codex permission mode gate", () => {
  it("defaults missing Codex permissionMode to intercept", () => {
    assert.strictEqual(getCodexPermissionMode(null), "intercept");
    assert.strictEqual(getCodexPermissionMode({ agents: { codex: {} } }), "intercept");
    assert.strictEqual(isCodexPermissionInterceptEnabled({ agents: { codex: {} } }), true);
  });

  it("uses native mode only when explicitly selected", () => {
    assert.strictEqual(
      isCodexPermissionInterceptEnabled({ agents: { codex: { permissionMode: "intercept" } } }),
      true
    );
    assert.strictEqual(
      isCodexPermissionInterceptEnabled({ agents: { codex: { permissionMode: "native" } } }),
      false
    );
  });
});

describe("createRuntimeAgentGate", () => {
  it("preserves the normalized prefs gates while the snapshot is authoritative", () => {
    const snapshot = prefs.getDefaults();
    const gate = createRuntimeAgentGate({
      getSnapshot: () => snapshot,
      isAuthoritative: () => true,
    });

    assert.strictEqual(gate.isAuthoritative(), true);
    assert.strictEqual(gate.isAgentEnabled("claude-code"), true);
    assert.strictEqual(gate.isAgentIntegrationInstalled("codex"), true);
    assert.strictEqual(gate.shouldSyncAgentIntegration("codex"), true);
    assert.strictEqual(gate.isAgentPermissionsEnabled("codex"), true);
    assert.strictEqual(gate.isAgentSubagentPermissionsEnabled("claude-code"), true);
    assert.strictEqual(gate.isAgentNotificationHookEnabled("codex"), true);
    assert.strictEqual(gate.isCodexPermissionInterceptEnabled(), true);
    assert.strictEqual(gate.hasAnyEnabledAgent(), true);
  });

  it("fails every prefs-backed runtime gate closed for a non-authoritative snapshot", () => {
    const snapshot = prefs.getDefaults();
    const gate = createRuntimeAgentGate({
      getSnapshot: () => snapshot,
      isAuthoritative: () => false,
    });

    assert.strictEqual(gate.isAuthoritative(), false);
    assert.strictEqual(gate.isAgentEnabled("claude-code"), false);
    assert.strictEqual(gate.isAgentIntegrationInstalled("codex"), false);
    assert.strictEqual(gate.shouldSyncAgentIntegration("codex"), false);
    assert.strictEqual(gate.isAgentPermissionsEnabled("codex"), false);
    assert.strictEqual(gate.isAgentSubagentPermissionsEnabled("claude-code"), false);
    assert.strictEqual(gate.isAgentNotificationHookEnabled("codex"), false);
    assert.strictEqual(gate.isCodexNativeNotificationSoundEnabled(), false);
    assert.strictEqual(gate.isCodexPermissionInterceptEnabled(), false);
    assert.strictEqual(gate.hasAnyEnabledAgent(), false);
  });

  it("fails closed if the authority probe throws", () => {
    const gate = createRuntimeAgentGate({
      getSnapshot: () => prefs.getDefaults(),
      isAuthoritative: () => {
        throw new Error("authority unavailable");
      },
    });

    assert.strictEqual(gate.isAuthoritative(), false);
    assert.strictEqual(gate.isAgentEnabled("codex"), false);
    assert.strictEqual(gate.shouldSyncAgentIntegration("codex"), false);
    assert.strictEqual(gate.isCodexPermissionInterceptEnabled(), false);
  });

  it("fails closed if the authoritative snapshot reader throws", () => {
    const gate = createRuntimeAgentGate({
      getSnapshot: () => {
        throw new Error("snapshot unavailable");
      },
    });

    assert.strictEqual(gate.isAuthoritative(), true);
    assert.strictEqual(gate.isAgentEnabled("codex"), false);
    assert.strictEqual(gate.shouldSyncAgentIntegration("codex"), false);
    assert.strictEqual(gate.isCodexPermissionInterceptEnabled(), false);
    assert.strictEqual(gate.hasAnyEnabledAgent(), false);
  });
});

describe("isAgentSubagentPermissionsEnabled", () => {
  it("returns true when the flag is absent (pre-#451 prefs file)", () => {
    assert.strictEqual(isAgentSubagentPermissionsEnabled(null, "claude-code"), true);
    assert.strictEqual(isAgentSubagentPermissionsEnabled({}, "claude-code"), true);
    assert.strictEqual(
      isAgentSubagentPermissionsEnabled(
        { agents: { "claude-code": { enabled: true, permissionsEnabled: true } } },
        "claude-code"
      ),
      true
    );
  });

  it("returns false only when subagentPermissionsEnabled === false", () => {
    assert.strictEqual(
      isAgentSubagentPermissionsEnabled(
        { agents: { "claude-code": { subagentPermissionsEnabled: false } } },
        "claude-code"
      ),
      false
    );
    assert.strictEqual(
      isAgentSubagentPermissionsEnabled(
        { agents: { "claude-code": { subagentPermissionsEnabled: true } } },
        "claude-code"
      ),
      true
    );
  });

  it("is independent of the master / permission gates", () => {
    assert.strictEqual(
      isAgentSubagentPermissionsEnabled(
        { agents: { "claude-code": { enabled: false, permissionsEnabled: false, subagentPermissionsEnabled: true } } },
        "claude-code"
      ),
      true
    );
  });

  it("defaults true for agents that never carry the flag", () => {
    const snap = prefs.getDefaults();
    assert.strictEqual(isAgentSubagentPermissionsEnabled(snap, "codex"), true);
    assert.strictEqual(isAgentSubagentPermissionsEnabled(snap, "future-agent-id"), true);
  });
});

describe("Codex native notification sound gate", () => {
  it("defaults off for missing / legacy prefs", () => {
    assert.strictEqual(isCodexNativeNotificationSoundEnabled(null), false);
    assert.strictEqual(isCodexNativeNotificationSoundEnabled({ agents: { codex: {} } }), false);
  });

  it("returns true only when nativeNotificationSoundEnabled === true", () => {
    assert.strictEqual(
      isCodexNativeNotificationSoundEnabled({
        agents: { codex: { nativeNotificationSoundEnabled: true } },
      }),
      true
    );
    assert.strictEqual(
      isCodexNativeNotificationSoundEnabled({
        agents: { codex: { nativeNotificationSoundEnabled: false } },
      }),
      false
    );
  });
});

describe("setAgentFlag command", () => {
  function makeDeps(overrides = {}) {
    const calls = {
      startMonitorForAgent: [],
      stopMonitorForAgent: [],
      clearSessionsByAgent: [],
      dismissPermissionsByAgent: [],
      syncIntegrationForAgent: [],
      stopIntegrationForAgent: [],
      writeCodexAutoStartGate: [],
    };
    return {
      calls,
      deps: {
        snapshot: prefs.getDefaults(),
        startMonitorForAgent: (id) => calls.startMonitorForAgent.push(id),
        stopMonitorForAgent: (id) => calls.stopMonitorForAgent.push(id),
        clearSessionsByAgent: (id) => calls.clearSessionsByAgent.push(id),
        dismissPermissionsByAgent: (id) => calls.dismissPermissionsByAgent.push(id),
        syncIntegrationForAgent: (id) => calls.syncIntegrationForAgent.push(id),
        stopIntegrationForAgent: (id) => calls.stopIntegrationForAgent.push(id),
        writeCodexAutoStartGate: (enabled) => {
          calls.writeCodexAutoStartGate.push(enabled);
          return true;
        },
        ...overrides,
      },
    };
  }

  it("rejects missing agentId", () => {
    const { deps } = makeDeps();
    const r = commandRegistry.setAgentFlag({ flag: "enabled", value: false }, deps);
    assert.strictEqual(r.status, "error");
  });

  it("rejects unknown flag name", () => {
    const { deps } = makeDeps();
    const r = commandRegistry.setAgentFlag(
      { agentId: "codex", flag: "wombat", value: false },
      deps
    );
    assert.strictEqual(r.status, "error");
    assert.ok(r.message.includes("flag"));
  });

  it("does not let the generic flag command fake installed state", () => {
    const { deps } = makeDeps();
    const r = commandRegistry.setAgentFlag(
      { agentId: "copilot-cli", flag: "integrationInstalled", value: true },
      deps
    );
    assert.strictEqual(r.status, "error");
    assert.ok(r.message.includes("flag"));
  });

  it("rejects non-boolean value", () => {
    const { deps } = makeDeps();
    const r = commandRegistry.setAgentFlag(
      { agentId: "codex", flag: "enabled", value: "off" },
      deps
    );
    assert.strictEqual(r.status, "error");
  });

  it("is noop when value already matches current state", () => {
    const { deps, calls } = makeDeps();
    const r = commandRegistry.setAgentFlag(
      { agentId: "codex", flag: "enabled", value: true },
      deps
    );
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.noop, true);
    assert.strictEqual(calls.stopMonitorForAgent.length, 0);
    assert.strictEqual(calls.startMonitorForAgent.length, 0);
  });

  it("disabling master flag runs stop + clear sessions + dismiss permissions", () => {
    const { deps, calls } = makeDeps();
    const r = commandRegistry.setAgentFlag(
      { agentId: "codex", flag: "enabled", value: false },
      deps
    );
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(calls.stopIntegrationForAgent.length, 0);
    assert.deepStrictEqual(calls.stopMonitorForAgent, ["codex"]);
    assert.deepStrictEqual(calls.clearSessionsByAgent, ["codex"]);
    assert.deepStrictEqual(calls.dismissPermissionsByAgent, ["codex"]);
    assert.strictEqual(calls.startMonitorForAgent.length, 0);
    assert.strictEqual(r.commit.agents.codex.enabled, false);
    assert.strictEqual(r.commit.agents["claude-code"].enabled, true);
  });

  it("enabling a previously-disabled agent syncs its integration and starts the monitor", () => {
    const seeded = prefs.getDefaults();
    seeded.agents.codex = { enabled: false, permissionsEnabled: true };
    const { deps, calls } = makeDeps({ snapshot: seeded });
    const r = commandRegistry.setAgentFlag(
      { agentId: "codex", flag: "enabled", value: true },
      deps
    );
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(calls.syncIntegrationForAgent, ["codex"]);
    assert.deepStrictEqual(calls.startMonitorForAgent, ["codex"]);
    assert.strictEqual(calls.stopMonitorForAgent.length, 0);
    assert.strictEqual(r.commit.agents.codex.enabled, true);
  });

  it("enabling an uninstalled agent starts the monitor without syncing integration files", () => {
    const seeded = prefs.getDefaults();
    seeded.agents["copilot-cli"] = {
      integrationInstalled: false,
      enabled: false,
      permissionsEnabled: true,
      notificationHookEnabled: true,
    };
    const { deps, calls } = makeDeps({ snapshot: seeded });
    const r = commandRegistry.setAgentFlag(
      { agentId: "copilot-cli", flag: "enabled", value: true },
      deps
    );
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(calls.syncIntegrationForAgent, []);
    assert.deepStrictEqual(calls.startMonitorForAgent, ["copilot-cli"]);
    assert.strictEqual(r.commit.agents["copilot-cli"].enabled, true);
    assert.strictEqual(r.commit.agents["copilot-cli"].integrationInstalled, false);
  });

  it("disabling Claude Code stops its integration watcher before commit", () => {
    const seeded = prefs.getDefaults();
    seeded.agents["claude-code"] = { enabled: true, permissionsEnabled: true };
    const { deps, calls } = makeDeps({ snapshot: seeded });
    const r = commandRegistry.setAgentFlag(
      { agentId: "claude-code", flag: "enabled", value: false },
      deps
    );
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(calls.stopIntegrationForAgent, ["claude-code"]);
    assert.deepStrictEqual(calls.stopMonitorForAgent, ["claude-code"]);
    assert.deepStrictEqual(calls.clearSessionsByAgent, ["claude-code"]);
    assert.deepStrictEqual(calls.dismissPermissionsByAgent, ["claude-code"]);
    assert.strictEqual(r.commit.agents["claude-code"].enabled, false);
  });

  it("toggling master flag preserves permissionsEnabled (no silent wipe)", () => {
    // Regression guard. Pre-refactor setAgentEnabled wrote
    // `{ [agentId]: { enabled } }`, erasing sibling flags on every main-
    // switch flip. setAgentFlag must spread the existing entry.
    const seeded = prefs.getDefaults();
    seeded.agents["claude-code"] = { enabled: true, permissionsEnabled: false };
    const { deps } = makeDeps({ snapshot: seeded });
    const r = commandRegistry.setAgentFlag(
      { agentId: "claude-code", flag: "enabled", value: false },
      deps
    );
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.commit.agents["claude-code"].enabled, false);
    assert.strictEqual(
      r.commit.agents["claude-code"].permissionsEnabled,
      false,
      "permissionsEnabled flag must survive a master-switch flip"
    );
  });

  it("rejects subagentPermissionsEnabled for non-claude agents before any side effect (#451)", () => {
    // Yunbao review E: a kimi-cli call would otherwise reach
    // agent-runtime-main's dismissPermissionsByAgent, whose Kimi branch
    // disposes permission state regardless of options/removed count.
    const dismissCalls = [];
    const { deps } = makeDeps({
      dismissPermissionsByAgent: (id, options) => dismissCalls.push([id, options]),
    });
    const r = commandRegistry.setAgentFlag(
      { agentId: "kimi-cli", flag: "subagentPermissionsEnabled", value: false },
      deps
    );
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /claude-code/);
    assert.deepStrictEqual(dismissCalls, []);
  });

  it("disabling subagentPermissionsEnabled dismisses only subagent bubbles (#451)", () => {
    const dismissCalls = [];
    const { deps, calls } = makeDeps({
      dismissPermissionsByAgent: (id, options) => dismissCalls.push([id, options]),
    });
    const r = commandRegistry.setAgentFlag(
      { agentId: "claude-code", flag: "subagentPermissionsEnabled", value: false },
      deps
    );
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(dismissCalls, [["claude-code", { subagentOnly: true }]]);
    assert.strictEqual(calls.stopMonitorForAgent.length, 0);
    assert.strictEqual(calls.clearSessionsByAgent.length, 0);
    assert.strictEqual(r.commit.agents["claude-code"].subagentPermissionsEnabled, false);
    assert.strictEqual(
      r.commit.agents["claude-code"].permissionsEnabled,
      true,
      "sibling permission flag must survive the subagent sub-gate flip"
    );
  });

  it("enabling subagentPermissionsEnabled is a pure data flip — no side effects", () => {
    const seeded = prefs.getDefaults();
    seeded.agents["claude-code"] = { enabled: true, permissionsEnabled: true, subagentPermissionsEnabled: false };
    const dismissCalls = [];
    const { deps } = makeDeps({
      snapshot: seeded,
      dismissPermissionsByAgent: (id, options) => dismissCalls.push([id, options]),
    });
    const r = commandRegistry.setAgentFlag(
      { agentId: "claude-code", flag: "subagentPermissionsEnabled", value: true },
      deps
    );
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(dismissCalls, []);
    assert.strictEqual(r.commit.agents["claude-code"].subagentPermissionsEnabled, true);
  });

  it("disabling permissionsEnabled only dismisses bubbles — no monitor/session churn", () => {
    const { deps, calls } = makeDeps();
    const r = commandRegistry.setAgentFlag(
      { agentId: "claude-code", flag: "permissionsEnabled", value: false },
      deps
    );
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(calls.dismissPermissionsByAgent, ["claude-code"]);
    assert.strictEqual(calls.stopMonitorForAgent.length, 0);
    assert.strictEqual(calls.clearSessionsByAgent.length, 0);
    assert.strictEqual(calls.startMonitorForAgent.length, 0);
    assert.strictEqual(r.commit.agents["claude-code"].permissionsEnabled, false);
    assert.strictEqual(
      r.commit.agents["claude-code"].enabled,
      true,
      "master enabled flag must be preserved when flipping the sub flag"
    );
  });

  it("enabling permissionsEnabled is a pure data flip — no side effects", () => {
    const seeded = prefs.getDefaults();
    seeded.agents["claude-code"] = { enabled: true, permissionsEnabled: false };
    const { deps, calls } = makeDeps({ snapshot: seeded });
    const r = commandRegistry.setAgentFlag(
      { agentId: "claude-code", flag: "permissionsEnabled", value: true },
      deps
    );
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(calls.dismissPermissionsByAgent.length, 0);
    assert.strictEqual(calls.stopMonitorForAgent.length, 0);
    assert.strictEqual(calls.clearSessionsByAgent.length, 0);
    assert.strictEqual(calls.startMonitorForAgent.length, 0);
    assert.strictEqual(r.commit.agents["claude-code"].permissionsEnabled, true);
  });

  it("propagates an error if a side effect throws, without committing", () => {
    const { deps } = makeDeps({
      stopMonitorForAgent: () => {
        throw new Error("boom");
      },
    });
    const r = commandRegistry.setAgentFlag(
      { agentId: "codex", flag: "enabled", value: false },
      deps
    );
    assert.strictEqual(r.status, "error");
    assert.ok(r.message.includes("boom"));
    assert.strictEqual(r.commit, undefined);
  });

  it("missing side-effect deps are tolerated (simulates hook-only agent)", () => {
    // Hook-based agents like Copilot / Cursor have no monitor — the command
    // should still succeed; the route layer enforces the gate.
    const seeded = prefs.getDefaults();
    seeded.agents["copilot-cli"] = {
      ...seeded.agents["copilot-cli"],
      integrationInstalled: true,
      enabled: true,
    };
    const { deps } = makeDeps({ snapshot: seeded });
    delete deps.startMonitorForAgent;
    delete deps.stopMonitorForAgent;
    const r = commandRegistry.setAgentFlag(
      { agentId: "copilot-cli", flag: "enabled", value: false },
      deps
    );
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.commit.agents["copilot-cli"].enabled, false);
  });

  it("accepts notificationHookEnabled as a pure data flip — no side effects", () => {
    // The idle-alert mute is a presentation-layer check inside state.js
    // updateSession (gated right before setState("notification")), so
    // toggling the flag has no monitor / session / bubble side effects.
    const { deps, calls } = makeDeps();
    const r = commandRegistry.setAgentFlag(
      { agentId: "claude-code", flag: "notificationHookEnabled", value: false },
      deps
    );
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(calls.stopMonitorForAgent.length, 0);
    assert.strictEqual(calls.startMonitorForAgent.length, 0);
    assert.strictEqual(calls.clearSessionsByAgent.length, 0);
    assert.strictEqual(calls.dismissPermissionsByAgent.length, 0);
    assert.strictEqual(r.commit.agents["claude-code"].notificationHookEnabled, false);
    assert.strictEqual(
      r.commit.agents["claude-code"].enabled,
      true,
      "master enabled flag must be preserved"
    );
    assert.strictEqual(
      r.commit.agents["claude-code"].permissionsEnabled,
      true,
      "permissionsEnabled sibling must be preserved"
    );
  });

  it("accepts Codex nativeNotificationSoundEnabled as a pure data flip", () => {
    const { deps, calls } = makeDeps();
    const r = commandRegistry.setAgentFlag(
      { agentId: "codex", flag: "nativeNotificationSoundEnabled", value: true },
      deps
    );
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(calls.stopMonitorForAgent.length, 0);
    assert.strictEqual(calls.startMonitorForAgent.length, 0);
    assert.strictEqual(calls.clearSessionsByAgent.length, 0);
    assert.strictEqual(calls.dismissPermissionsByAgent.length, 0);
    assert.strictEqual(r.commit.agents.codex.nativeNotificationSoundEnabled, true);
    assert.strictEqual(r.commit.agents.codex.permissionMode, "intercept");
  });
});

describe("setAgentPermissionMode command", () => {
  function makeDeps(overrides = {}) {
    const calls = { dismissPermissionsByAgent: [] };
    return {
      calls,
      deps: {
        snapshot: prefs.getDefaults(),
        dismissPermissionsByAgent: (id) => calls.dismissPermissionsByAgent.push(id),
        ...overrides,
      },
    };
  }

  it("treats switching Codex to the default intercept mode as a noop", () => {
    const { deps, calls } = makeDeps();
    const r = commandRegistry.setAgentPermissionMode(
      { agentId: "codex", mode: "intercept" },
      deps
    );
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.noop, true);
    assert.deepStrictEqual(calls.dismissPermissionsByAgent, []);
  });

  it("switches Codex back to native mode and dismisses pending Codex bubbles", () => {
    const seeded = prefs.getDefaults();
    seeded.agents.codex.permissionMode = "intercept";
    const { deps, calls } = makeDeps({ snapshot: seeded });
    const r = commandRegistry.setAgentPermissionMode(
      { agentId: "codex", mode: "native" },
      deps
    );
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.commit.agents.codex.permissionMode, "native");
    assert.deepStrictEqual(calls.dismissPermissionsByAgent, ["codex"]);
  });

  it("treats missing Codex permissionMode as intercept when switching to native", () => {
    const seeded = prefs.getDefaults();
    delete seeded.agents.codex.permissionMode;
    const { deps, calls } = makeDeps({ snapshot: seeded });
    const r = commandRegistry.setAgentPermissionMode(
      { agentId: "codex", mode: "native" },
      deps
    );
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.commit.agents.codex.permissionMode, "native");
    assert.deepStrictEqual(calls.dismissPermissionsByAgent, ["codex"]);
  });

  it("rejects unsupported agents and modes", () => {
    const { deps } = makeDeps();
    assert.strictEqual(
      commandRegistry.setAgentPermissionMode({ agentId: "claude-code", mode: "native" }, deps).status,
      "error"
    );
    assert.strictEqual(
      commandRegistry.setAgentPermissionMode({ agentId: "codex", mode: "auto" }, deps).status,
      "error"
    );
  });
});
