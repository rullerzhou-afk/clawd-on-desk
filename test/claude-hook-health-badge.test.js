"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const {
  classifyClaudeHookHealthStatus,
  CLAUDE_HOOK_BADGE_SIGNATURES,
} = require("../src/claude-hook-health-badge");
const { SUPPORTED_LANGS } = require("../src/i18n");

function loadSettingsI18nStrings() {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "settings-i18n.js"), "utf8");
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.ClawdSettingsI18n.STRINGS;
}

describe("classifyClaudeHookHealthStatus", () => {
  it("warns on manual-fix-required with the manual-fix reason key", () => {
    const v = classifyClaudeHookHealthStatus({ status: "manual-fix-required" });
    assert.strictEqual(v.healthy, false);
    assert.strictEqual(v.signature, "manual-fix-required");
    assert.strictEqual(v.reasonKey, "claudeHookHealthReasonManualFix");
    assert.strictEqual(v.available, true);
    assert.strictEqual(v.status, "manual-fix-required");
  });

  it("warns on guarded (suspicious-shrink auto-repair pause)", () => {
    const v = classifyClaudeHookHealthStatus({ status: "guarded" });
    assert.strictEqual(v.healthy, false);
    assert.strictEqual(v.signature, "guarded");
    assert.strictEqual(v.reasonKey, "claudeHookHealthReasonGuarded");
  });

  it("warns on degraded only when the source hook script is missing", () => {
    const missing = classifyClaudeHookHealthStatus({
      status: "degraded",
      degradedReason: "source-script-missing",
    });
    assert.strictEqual(missing.healthy, false);
    assert.strictEqual(missing.signature, "source-missing");
    assert.strictEqual(missing.reasonKey, "claudeHookHealthReasonSourceMissing");
  });

  it("stays silent for transient/self-healing degraded reasons", () => {
    for (const degradedReason of ["unreadable", "resolver-hiccup", null, undefined]) {
      const v = classifyClaudeHookHealthStatus({ status: "degraded", degradedReason });
      assert.strictEqual(v.healthy, true, String(degradedReason));
      assert.strictEqual(v.signature, null, String(degradedReason));
    }
  });

  it("stays silent for benign states", () => {
    for (const status of ["healthy", "stopped", "repairing", "some-future-state"]) {
      const v = classifyClaudeHookHealthStatus({ status });
      assert.strictEqual(v.healthy, true, status);
      assert.strictEqual(v.signature, null, status);
      assert.strictEqual(v.available, true, status);
      assert.strictEqual(v.status, status, status);
    }
  });

  it("reports unavailable/unknown on garbage input without throwing", () => {
    for (const bad of [null, undefined, 42, "guarded", {}]) {
      const v = classifyClaudeHookHealthStatus(bad);
      assert.strictEqual(v.healthy, true);
      assert.strictEqual(v.signature, null);
      if (bad && typeof bad === "object") {
        assert.strictEqual(v.available, true);
      } else {
        assert.strictEqual(v.available, false);
      }
      assert.strictEqual(v.status, bad && typeof bad === "object" ? "unknown" : "unknown");
    }
  });

  it("exposes the warning signatures table for the two direct-mapped states", () => {
    assert.strictEqual(CLAUDE_HOOK_BADGE_SIGNATURES["manual-fix-required"].signature, "manual-fix-required");
    assert.strictEqual(CLAUDE_HOOK_BADGE_SIGNATURES.guarded.reasonKey, "claudeHookHealthReasonGuarded");
  });
});

describe("claudeHookHealthReasonSourceMissing hint", () => {
  it("exists for every locale and never points at Doctor repair", () => {
    const strings = loadSettingsI18nStrings();
    for (const lang of SUPPORTED_LANGS) {
      const hint = strings[lang].claudeHookHealthReasonSourceMissing;
      assert.strictEqual(typeof hint, "string", `${lang}: missing hint`);
      assert.ok(hint.length > 0, `${lang}: empty hint`);
      assert.ok(!hint.includes("Doctor"), `${lang}: hint must not direct users to Doctor: ${hint}`);
    }
  });
});
