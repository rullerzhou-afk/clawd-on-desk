"use strict";

// Wiring tests: the statusLine tap must be registered/removed alongside the
// Claude Code integration, gated the same way as the other Claude hooks
// (manageClaudeHooksAutomatically + claude-code enabled). The tap is what
// feeds the usage gauge rate_limits from CC's stdin, so if this wiring breaks
// the hybrid silently degrades to API-only polling.

const { test } = require("node:test");
const assert = require("node:assert");

const { createIntegrationSyncRuntime } = require("../src/integration-sync");

function makeRuntime(overrides = {}) {
  const calls = { register: 0, remove: 0, clawd: 0 };
  const ctx = {
    manageClaudeHooksAutomatically: true,
    isAgentEnabled: () => true,
    syncStatuslineTapImpl: () => { calls.register++; return { status: "ok", changed: true }; },
    removeStatuslineTapImpl: () => { calls.remove++; return { status: "ok", changed: true }; },
    syncClawdHooksImpl: () => { calls.clawd++; return { status: "ok" }; },
    ...overrides.ctx,
  };
  const rt = createIntegrationSyncRuntime({
    ctx,
    getHookServerPort: () => 23333,
    shouldManageClaudeHooks: () => ctx.manageClaudeHooksAutomatically !== false,
    isAgentEnabled: (id) => ctx.isAgentEnabled(id) !== false,
    startClaudeSettingsWatcher: () => {},
    stopClaudeSettingsWatcher: () => true,
    ...overrides.deps,
  });
  return { rt, calls };
}

test("startup sync registers the statusLine tap when Claude Code is enabled", () => {
  const { rt, calls } = makeRuntime();
  rt.syncEnabledStartupIntegrations();
  assert.strictEqual(calls.register, 1, "tap should be registered at startup");
  assert.strictEqual(calls.clawd, 1, "clawd hooks still synced alongside");
});

test("startup sync skips the tap when hook management is off", () => {
  const { rt, calls } = makeRuntime({
    ctx: { manageClaudeHooksAutomatically: false },
  });
  rt.syncEnabledStartupIntegrations();
  assert.strictEqual(calls.register, 0, "no tap when manageClaudeHooksAutomatically=false");
});

test("syncIntegrationForAgent('claude-code') registers the tap", () => {
  const { rt, calls } = makeRuntime();
  rt.syncIntegrationForAgent("claude-code");
  assert.strictEqual(calls.register, 1);
});

test("stopIntegrationForAgent('claude-code') removes the tap", () => {
  const { rt, calls } = makeRuntime();
  rt.stopIntegrationForAgent("claude-code");
  assert.strictEqual(calls.remove, 1, "tap should be removed when Claude Code is disabled");
});

test("stopIntegrationForAgent for a non-claude agent does not touch the tap", () => {
  const { rt, calls } = makeRuntime();
  rt.stopIntegrationForAgent("codex");
  assert.strictEqual(calls.remove, 0);
});

test("syncStatuslineTap / removeStatuslineTap are exposed and return status", () => {
  const { rt } = makeRuntime();
  assert.strictEqual(typeof rt.syncStatuslineTap, "function");
  assert.strictEqual(typeof rt.removeStatuslineTap, "function");
  assert.strictEqual(rt.syncStatuslineTap().status, "ok");
  assert.strictEqual(rt.removeStatuslineTap().status, "ok");
});

test("a throwing tap impl is swallowed into an error status (never crashes sync)", () => {
  const { rt } = makeRuntime({
    ctx: { syncStatuslineTapImpl: () => { throw new Error("boom"); } },
  });
  // Must not throw out of the startup path.
  assert.doesNotThrow(() => rt.syncEnabledStartupIntegrations());
  const res = rt.syncStatuslineTap();
  assert.strictEqual(res.status, "error");
});
