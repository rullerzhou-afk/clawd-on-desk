"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const { createWatchAdapter, classifyWatchIssue, watchApprovalId } = require("../src/watch-adapter");

function makeFakeSidecar() {
  let opts = null;
  const transport = { connected: false, secure: false, sent: [], send(p) { this.sent.push(p); } };
  const factory = (sidecarOptions) => {
    opts = sidecarOptions;
    return { transport, start() {}, stop() {} };
  };
  return { factory, get opts() { return opts; }, transport };
}

function baseDeps(extra = {}) {
  const timers = [];
  const adapterOpts = {
    env: {},
    getSettings: () => ({ enabled: true, permissionsEnabled: true, namePrefix: "Clawd", address: "" }),
    setTimeout: (fn, ms) => { const id = { fn, ms }; timers.push(id); return id; },
    clearTimeout: (id) => { const i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1); },
    now: () => 1000,
    log: () => {},
    onStatusChanged: () => {},
    getSessionSnapshot: () => ({ sessions: [] }),
    getCurrentState: () => "idle",
    getCurrentSvg: () => null,
    ...extra,
  };
  return { adapterOpts, timers };
}

let live = null;
afterEach(() => { if (live) { try { live.stop(); } catch (_) {} live = null; } });

describe("watch-adapter approval round-trip", () => {
  it("should resolve the real pending entry with allow when ids match", () => {
    const fake = makeFakeSidecar();
    const perm = { sessionId: "abcdefghXYZ", toolName: "Bash", createdAt: 42 };
    const calls = [];
    const { adapterOpts } = baseDeps({
      createSidecar: fake.factory,
      getPendingPermissions: () => [perm],
      resolvePermissionEntry: (entry, decision) => calls.push([entry, decision]),
    });
    live = createWatchAdapter(adapterOpts);
    live.start();

    fake.opts.onApprovalResponse({ requestId: watchApprovalId(perm), decision: "allow" });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], perm);
    assert.strictEqual(calls[0][1], "allow");
  });

  it("should map unknown decision to deny", () => {
    const fake = makeFakeSidecar();
    const perm = { sessionId: "s", toolName: "Edit", createdAt: 7 };
    const calls = [];
    const { adapterOpts } = baseDeps({
      createSidecar: fake.factory,
      getPendingPermissions: () => [perm],
      resolvePermissionEntry: (e, d) => calls.push(d),
    });
    live = createWatchAdapter(adapterOpts); live.start();
    fake.opts.onApprovalResponse({ requestId: watchApprovalId(perm), decision: "whatever" });
    assert.deepStrictEqual(calls, ["deny"]);
  });

  it("should NOT resolve when permissionsEnabled is false", () => {
    const fake = makeFakeSidecar();
    const perm = { sessionId: "s", toolName: "Bash", createdAt: 1 };
    const calls = [];
    const { adapterOpts } = baseDeps({
      getSettings: () => ({ enabled: true, permissionsEnabled: false, namePrefix: "Clawd", address: "" }),
      createSidecar: fake.factory,
      getPendingPermissions: () => [perm],
      resolvePermissionEntry: () => calls.push(1),
    });
    live = createWatchAdapter(adapterOpts); live.start();
    fake.opts.onApprovalResponse({ requestId: watchApprovalId(perm), decision: "allow" });
    assert.strictEqual(calls.length, 0);
  });

  it("should NOT resolve when requestId matches no pending entry", () => {
    const fake = makeFakeSidecar();
    const calls = [];
    const { adapterOpts } = baseDeps({
      createSidecar: fake.factory,
      getPendingPermissions: () => [{ sessionId: "s", toolName: "Bash", createdAt: 1 }],
      resolvePermissionEntry: () => calls.push(1),
    });
    live = createWatchAdapter(adapterOpts); live.start();
    fake.opts.onApprovalResponse({ requestId: "nope:nope:0", decision: "allow" });
    assert.strictEqual(calls.length, 0);
  });

  it("should not push permissions when permissionsEnabled is false", () => {
    const fake = makeFakeSidecar();
    const perm = { sessionId: "s", toolName: "Bash", toolInput: { command: "ls" }, createdAt: 1 };
    const { adapterOpts } = baseDeps({
      getSettings: () => ({ enabled: true, permissionsEnabled: false, namePrefix: "Clawd", address: "" }),
      createSidecar: fake.factory,
      getPendingPermissions: () => [perm],
    });
    live = createWatchAdapter(adapterOpts); live.start();
    fake.transport.connected = true;
    live.notifyPermissionsChanged();
    const approvals = fake.transport.sent.filter((m) => m.type === "approval_request");
    assert.strictEqual(approvals.length, 0);
  });
});

describe("watch-adapter restart/backoff", () => {
  it("should schedule restart on sidecar exit", () => {
    const fake = makeFakeSidecar();
    const { adapterOpts, timers } = baseDeps({ createSidecar: fake.factory });
    live = createWatchAdapter(adapterOpts); live.start();

    fake.opts.log("info", "sidecar exited code=1 signal=null");
    assert.strictEqual(timers.length, 1);
    assert.strictEqual(timers[0].ms, 15000);
  });

  it("should reset retryAttempt on successful connection", () => {
    const fake = makeFakeSidecar();
    const statuses = [];
    const { adapterOpts } = baseDeps({
      createSidecar: fake.factory,
      onStatusChanged: (s) => statuses.push(s),
    });
    live = createWatchAdapter(adapterOpts); live.start();

    // Crash increments retry
    fake.opts.log("info", "sidecar exited code=1 signal=null");
    const afterCrash = statuses[statuses.length - 1];
    assert.ok(afterCrash.retryAttempt >= 1);

    // Connect resets
    fake.opts.onStatus({ connected: true });
    const afterConnect = statuses[statuses.length - 1];
    assert.strictEqual(afterConnect.retryAttempt, 0);
  });
});

describe("classifyWatchIssue", () => {
  it("should classify MISSING_BLEAK as non-retryable", () => {
    const r = classifyWatchIssue({ code: "MISSING_BLEAK" });
    assert.strictEqual(r.category, "missing_bleak");
    assert.strictEqual(r.retryable, false);
  });

  it("should classify DISCONNECTED as retryable", () => {
    const r = classifyWatchIssue({ code: "DISCONNECTED" });
    assert.strictEqual(r.category, "disconnected");
    assert.strictEqual(r.retryable, true);
  });

  it("should classify ENOENT as python_missing", () => {
    const r = classifyWatchIssue({ code: "ENOENT" });
    assert.strictEqual(r.category, "python_missing");
    assert.strictEqual(r.retryable, false);
  });

  it("should classify SIDECAR_EXIT as retryable", () => {
    const r = classifyWatchIssue({ code: "SIDECAR_EXIT" });
    assert.strictEqual(r.category, "sidecar_exited");
    assert.strictEqual(r.retryable, true);
  });

  it("should classify unknown codes as watch_error", () => {
    const r = classifyWatchIssue({ code: "SOMETHING" });
    assert.strictEqual(r.category, "watch_error");
    assert.strictEqual(r.retryable, true);
  });
});

describe("watchApprovalId", () => {
  it("should generate deterministic id from sessionId + toolName + createdAt", () => {
    const id = watchApprovalId({ sessionId: "abcdefgh12345678", toolName: "Bash", createdAt: 42 });
    assert.strictEqual(id, "12345678:Bash:42");
  });

  it("should handle missing fields gracefully", () => {
    const id = watchApprovalId({});
    assert.strictEqual(id, "::0");
  });
});
