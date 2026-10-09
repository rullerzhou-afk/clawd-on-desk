"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const initPermission = require("../src/permission");
const {
  classifyPermissionInteraction,
} = require("../src/permission-automation-policy");

function liveResponse(overrides = {}) {
  return {
    destroyed: false,
    writableEnded: false,
    writableFinished: false,
    ...overrides,
  };
}

function makeRuntime(ctxOverrides = {}, entryOverrides = {}) {
  const ctx = {
    doNotDisturb: false,
    sessions: new Map(),
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    isAgentSubagentPermissionsEnabled: () => true,
    isCodexPermissionInterceptEnabled: () => true,
    getPermissionAutomationMode: () => "auto-tools",
    ...ctxOverrides,
  };
  const permission = initPermission(ctx);
  const entry = {
    res: liveResponse(),
    sessionId: "session-live",
    agentId: "claude-code",
    toolName: "Bash",
    toolInput: { command: "npm test" },
    interaction: classifyPermissionInteraction({
      agentId: "claude-code",
      toolName: "Bash",
    }),
    sessionAutomationIdentity: Object.freeze({
      eligible: true,
      reason: "eligible",
    }),
    ...entryOverrides,
  };
  permission.pendingPermissions.push(entry);
  return { permission, entry };
}

describe("permission session automation live gate", () => {
  it("requires a still-pending, writable blocking response", () => {
    const { permission, entry } = makeRuntime();
    assert.strictEqual(permission.isPermissionEntryLive(entry), true);

    for (const responseState of [
      { destroyed: true },
      { writableEnded: true },
      { writableFinished: true },
    ]) {
      const probe = makeRuntime({}, { res: liveResponse(responseState) });
      assert.strictEqual(probe.permission.isPermissionEntryLive(probe.entry), false);
    }

    permission.pendingPermissions.splice(0, 1);
    assert.strictEqual(permission.isPermissionEntryLive(entry), false);
  });

  it("treats delayed-disconnect entries as dead even while they remain pending", () => {
    const { permission, entry } = makeRuntime({}, { _delayedResolve: true });
    assert.strictEqual(permission.pendingPermissions.includes(entry), true);
    assert.strictEqual(permission.isPermissionEntryLive(entry), false);
    assert.strictEqual(
      permission.canAutoResolvePendingPermission(entry, {
        sessionOnly: true,
        mode: "auto-tools",
      }),
      false
    );
  });

  it("treats lifecycle-cancelled entries as dead even before the hook socket closes", () => {
    const { permission, entry } = makeRuntime({}, {
      _sessionTrustLifecycleCancelled: true,
    });
    assert.strictEqual(permission.pendingPermissions.includes(entry), true);
    assert.strictEqual(permission.isPermissionEntryLive(entry), false);
    assert.strictEqual(
      permission.canAutoResolvePendingPermission(entry, {
        sessionOnly: true,
        mode: "auto-tools",
      }),
      false
    );
  });

  it("fails closed for reverse-bridge entries without adapter-specific liveness", () => {
    for (const agentId of ["opencode", "mimocode"]) {
      const { permission, entry } = makeRuntime({}, {
        res: null,
        agentId,
        interaction: classifyPermissionInteraction({ agentId, toolName: "Bash" }),
      });
      assert.strictEqual(permission.isPermissionEntryLive(entry), false, agentId);
    }
  });

  it("requires every current route gate and a route-owned stable identity", () => {
    const cases = [
      [{ doNotDisturb: true }, {}, "DND"],
      [{ isAgentEnabled: () => false }, {}, "agent"],
      [{ isAgentPermissionsEnabled: () => false }, {}, "permission"],
      [{ isAgentSubagentPermissionsEnabled: () => false }, { subagentId: "child" }, "subagent"],
      [{ sessions: new Map([["session-live", { headless: true }]]) }, {}, "headless"],
      [{ isCodexPermissionInterceptEnabled: () => false }, { agentId: "codex", isCodex: true }, "codex"],
      [{}, { sessionAutomationIdentity: { eligible: false, reason: "test" } }, "identity"],
    ];

    for (const [ctxOverrides, entryOverrides, label] of cases) {
      const { permission, entry } = makeRuntime(ctxOverrides, entryOverrides);
      assert.strictEqual(
        permission.canAutoResolvePendingPermission(entry, {
          sessionOnly: true,
          mode: "auto-tools",
        }),
        false,
        label
      );
    }
  });

  it("allows an interactive Codex subagent to inherit automation despite its state-only headless marker", () => {
    const { permission, entry } = makeRuntime({
      sessions: new Map([["session-live", { agentId: "codex", headless: true }]]),
    }, {
      agentId: "codex",
      isCodex: true,
      codexInteractiveSubagent: true,
      codexSessionRole: "subagent",
      codexAgentNickname: "Halley",
      subagentId: "session-live",
      headless: false,
      interaction: classifyPermissionInteraction({ agentId: "codex", toolName: "Bash" }),
    });

    assert.strictEqual(
      permission.canAutoResolvePendingPermission(entry, {
        sessionOnly: true,
        mode: "auto-tools",
      }),
      true
    );

    const payload = permission.buildPermissionBubblePayload(entry);
    assert.strictEqual(payload.isCodexSubagent, true);
    assert.strictEqual(payload.codexAgentNickname, "Halley");

    entry.headless = true;
    assert.strictEqual(
      permission.canAutoResolvePendingPermission(entry, {
        sessionOnly: true,
        mode: "auto-tools",
      }),
      false
    );
  });

  it("uses an explicit session mode and never reads the global mode for session-only checks", () => {
    const { permission, entry } = makeRuntime({
      getPermissionAutomationMode: () => "auto-tools",
    });

    assert.strictEqual(
      permission.canAutoResolvePendingPermission(entry, { sessionOnly: true }),
      false
    );
    assert.strictEqual(
      permission.canAutoResolvePendingPermission(entry, {
        sessionOnly: true,
        mode: "auto-tools",
      }),
      true
    );
    assert.strictEqual(
      permission.canAutoResolvePendingPermission(entry, { sessionOnly: false }),
      true
    );
  });

  it("still defers questions, plans, unknown requests, and passive notifications", () => {
    for (const [toolName, entryOverrides] of [
      ["AskUserQuestion", {}],
      ["ExitPlanMode", {}],
      ["Unknown", {}],
      ["Bash", { isCodexNotify: true }],
    ]) {
      const { permission, entry } = makeRuntime({}, {
        toolName,
        interaction: classifyPermissionInteraction({
          agentId: "claude-code",
          eventKind: entryOverrides.isCodexNotify ? "passive-notification" : "permission",
          toolName,
        }),
        ...entryOverrides,
      });
      assert.strictEqual(
        permission.canAutoResolvePendingPermission(entry, {
          sessionOnly: true,
          mode: "auto-tools",
        }),
        false,
        toolName
      );
    }
  });

  it("puts only a main-derived offer boolean on the bubble payload", () => {
    const { permission, entry } = makeRuntime({
      canOfferSessionTrust: () => true,
    });
    const payload = permission.buildPermissionBubblePayload(entry);
    assert.strictEqual(payload.canOfferSessionTrust, true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(payload, "sessionAutomationIdentity"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(payload, "agentId"), false);
  });

  it("renderer exposes one session-trust action without deriving eligibility", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "src", "bubble-renderer.js"),
      "utf8"
    );
    assert.match(source, /data\.canOfferSessionTrust === true/);
    assert.match(source, /decide\("session-trust"\)/);
    assert.match(source, /data\.isCodexSubagent/);
    assert.match(source, /data\.codexAgentNickname \|\| bubbleText\(data\.lang, "agent"\)/);
    assert.doesNotMatch(source, /sessionAutomationIdentity/);
  });
});
