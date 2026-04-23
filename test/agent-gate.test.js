"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { isAgentEnabled, isAgentPermissionsEnabled, isAgentNotificationHookEnabled } = require("../src/agent-gate");
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

describe("setAgentFlag command", () => {
  function makeDeps(overrides = {}) {
    const calls = {
      startMonitorForAgent: [],
      stopMonitorForAgent: [],
      clearSessionsByAgent: [],
      dismissPermissionsByAgent: [],
    };
    return {
      calls,
      deps: {
        snapshot: prefs.getDefaults(),
        startMonitorForAgent: (id) => calls.startMonitorForAgent.push(id),
        stopMonitorForAgent: (id) => calls.stopMonitorForAgent.push(id),
        clearSessionsByAgent: (id) => calls.clearSessionsByAgent.push(id),
        dismissPermissionsByAgent: (id) => calls.dismissPermissionsByAgent.push(id),
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
    assert.deepStrictEqual(calls.stopMonitorForAgent, ["codex"]);
    assert.deepStrictEqual(calls.clearSessionsByAgent, ["codex"]);
    assert.deepStrictEqual(calls.dismissPermissionsByAgent, ["codex"]);
    assert.strictEqual(calls.startMonitorForAgent.length, 0);
    assert.strictEqual(r.commit.agents.codex.enabled, false);
    assert.strictEqual(r.commit.agents["claude-code"].enabled, true);
  });

  it("enabling a previously-disabled agent starts the monitor", () => {
    const seeded = prefs.getDefaults();
    seeded.agents.codex = { enabled: false, permissionsEnabled: true };
    const { deps, calls } = makeDeps({ snapshot: seeded });
    const r = commandRegistry.setAgentFlag(
      { agentId: "codex", flag: "enabled", value: true },
      deps
    );
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(calls.startMonitorForAgent, ["codex"]);
    assert.strictEqual(calls.stopMonitorForAgent.length, 0);
    assert.strictEqual(r.commit.agents.codex.enabled, true);
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
    const { deps } = makeDeps();
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
    // The idle-alert gate runs at the server route layer (shouldDropNotificationHook),
    // so toggling the flag has no monitor / session / bubble side effects.
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
});
