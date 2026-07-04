"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  getCodexHookHealth,
  classifyCodexHookDetail,
  decideCodexHookNotification,
} = require("../src/codex-hook-health");

describe("classifyCodexHookDetail", () => {
  it("treats an ok integration as healthy (no signature)", () => {
    const r = classifyCodexHookDetail({ status: "ok" });
    assert.strictEqual(r.signature, null);
    assert.strictEqual(r.reasonKey, null);
  });

  it("treats inactive-or-user-disabled Codex states as nothing to warn about", () => {
    for (const status of ["not-installed", "not-managed", "disabled", "manual-only", "manual-managed"]) {
      assert.strictEqual(classifyCodexHookDetail({ status }).signature, null, status);
    }
  });

  it("distinguishes features.hooks=false from a missing registration", () => {
    const disabled = classifyCodexHookDetail({
      status: "not-connected",
      supplementary: { key: "hooks", value: "disabled" },
    });
    assert.strictEqual(disabled.signature, "feature-disabled");
    assert.strictEqual(disabled.reasonKey, "codexHookHealthReasonDisabled");

    const notRegistered = classifyCodexHookDetail({ status: "not-connected" });
    assert.strictEqual(notRegistered.signature, "not-registered");
    assert.strictEqual(notRegistered.reasonKey, "codexHookHealthReasonInactive");
  });

  it("maps needs-review (trust) and broken-path", () => {
    const review = classifyCodexHookDetail({
      status: "needs-review",
      codexHookTrust: { value: "needs-review" },
    });
    assert.strictEqual(review.signature, "needs-review");

    const broken = classifyCodexHookDetail({ status: "broken-path" });
    assert.strictEqual(broken.signature, "broken-path");
  });

  it("surfaces any other non-ok status generically instead of swallowing it", () => {
    const r = classifyCodexHookDetail({ status: "weird-new-status" });
    assert.strictEqual(r.signature, "weird-new-status");
    assert.strictEqual(r.reasonKey, "codexHookHealthReasonInactive");
  });

  it("never throws on garbage input", () => {
    assert.strictEqual(classifyCodexHookDetail(null).signature, null);
    assert.strictEqual(classifyCodexHookDetail(undefined).signature, null);
    assert.strictEqual(classifyCodexHookDetail(42).signature, null);
  });
});

describe("getCodexHookHealth", () => {
  it("returns unavailable+healthy when no Codex descriptor is present", () => {
    const v = getCodexHookHealth({ descriptors: [{ agentId: "claude-code" }] });
    assert.strictEqual(v.available, false);
    assert.strictEqual(v.healthy, true);
    assert.strictEqual(v.signature, null);
  });

  it("maps an absent Codex install to healthy (not-installed), without throwing", () => {
    const fakeDescriptor = {
      agentId: "codex",
      agentName: "Codex CLI",
      eventSource: "hook",
      parentDir: "/clawd-nonexistent-codex-dir-xyz",
      configPath: "/clawd-nonexistent-codex-dir-xyz/hooks.json",
      configMode: "file",
      autoInstall: true,
      marker: "codex-hook.js",
      nested: true,
      supplementary: { key: "hooks", configPath: "/clawd-nonexistent-codex-dir-xyz/config.toml" },
    };
    const v = getCodexHookHealth({ descriptors: [fakeDescriptor] });
    assert.strictEqual(v.available, true);
    assert.strictEqual(v.healthy, true);
    assert.strictEqual(v.signature, null);
    assert.strictEqual(v.status, "not-installed");
  });

  it("degrades to a healthy verdict if the probe throws", () => {
    const explodingDescriptors = {
      // .find on a non-array path is guarded; force the try/catch via a getter
      get length() { throw new Error("boom"); },
    };
    // Array.isArray(explodingDescriptors) is false → treated as no descriptor.
    const v = getCodexHookHealth({ descriptors: explodingDescriptors });
    assert.strictEqual(v.healthy, true);
    assert.strictEqual(v.signature, null);
  });
});

describe("decideCodexHookNotification (edge-triggered dedup)", () => {
  const broken = (sig) => ({ signature: sig });
  const healthy = { signature: null };

  it("notifies once on a fresh breakage", () => {
    const d = decideCodexHookNotification(broken("needs-review"), "");
    assert.strictEqual(d.shouldNotify, true);
    assert.strictEqual(d.nextSignature, "needs-review");
  });

  it("stays silent when the same breakage was already notified", () => {
    const d = decideCodexHookNotification(broken("needs-review"), "needs-review");
    assert.strictEqual(d.shouldNotify, false);
    assert.strictEqual(d.nextSignature, "needs-review");
  });

  it("notifies again when the breakage kind changes", () => {
    const d = decideCodexHookNotification(broken("feature-disabled"), "needs-review");
    assert.strictEqual(d.shouldNotify, true);
    assert.strictEqual(d.nextSignature, "feature-disabled");
  });

  it("resets the remembered signature once healthy, so a later break re-fires", () => {
    const d = decideCodexHookNotification(healthy, "needs-review");
    assert.strictEqual(d.shouldNotify, false);
    assert.strictEqual(d.nextSignature, "");
    // and a subsequent break notifies again
    const d2 = decideCodexHookNotification(broken("needs-review"), d.nextSignature);
    assert.strictEqual(d2.shouldNotify, true);
  });

  it("never notifies when notifications are disabled, but keeps the prior signature", () => {
    const d = decideCodexHookNotification(broken("needs-review"), "", { notifyEnabled: false });
    assert.strictEqual(d.shouldNotify, false);
    assert.strictEqual(d.nextSignature, "");
    // re-enabling later fires exactly once
    const d2 = decideCodexHookNotification(broken("needs-review"), d.nextSignature, { notifyEnabled: true });
    assert.strictEqual(d2.shouldNotify, true);
  });

  it("never notifies when Codex is disabled in Clawd", () => {
    const d = decideCodexHookNotification(broken("needs-review"), "", { codexEnabled: false });
    assert.strictEqual(d.shouldNotify, false);
  });

  it("does not record while disabled if already notified (no duplicate on re-enable)", () => {
    const d = decideCodexHookNotification(broken("needs-review"), "needs-review", { notifyEnabled: false });
    assert.strictEqual(d.shouldNotify, false);
    assert.strictEqual(d.nextSignature, "needs-review");
  });

  it("resets to healthy even while notifications are disabled", () => {
    const d = decideCodexHookNotification(healthy, "needs-review", { notifyEnabled: false });
    assert.strictEqual(d.nextSignature, "");
  });
});
