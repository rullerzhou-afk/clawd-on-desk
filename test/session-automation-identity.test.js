"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  ADAPTER_POLICY,
  assessSessionAutomationIdentity,
} = require("../src/session-automation-identity");

function assess(agentId, rawSessionId, overrides = {}) {
  return assessSessionAutomationIdentity({
    agentId,
    channel: "permission",
    event: "PermissionRequest",
    rawSessionId,
    ...overrides,
  });
}

const CODEX_SESSION_ID = "codex:019f9c87-23a9-7d03-a7ac-c11e3270c3b8";
const CODEX_LOCAL_CLI = Object.freeze({
  profileId: "local",
  hookSource: "codex-official",
  codexOriginator: "codex-tui",
  codexSource: "cli",
  agentPid: 1234,
});

describe("session automation identity", () => {
  it("fails closed for missing and blank raw session ids", () => {
    for (const rawSessionId of [undefined, null, "", "   "]) {
      assert.deepStrictEqual(
        assess("claude-code", rawSessionId),
        { eligible: false, reason: "missing-session-id" }
      );
    }
  });

  it("rejects every adapter default, prefix-only, and prefix-default before canonicalization", () => {
    for (const [agentId, policy] of Object.entries(ADAPTER_POLICY)) {
      const placeholders = new Set([
        ...policy.placeholders,
        "default",
        `${agentId}:`,
        `${agentId}:default`,
      ]);
      for (const rawSessionId of placeholders) {
        assert.deepStrictEqual(
          assess(agentId, rawSessionId),
          {
            eligible: false,
            reason: rawSessionId === `${agentId}:`
              && !policy.placeholders.includes(rawSessionId)
              ? "prefix-only-session-id"
              : "placeholder-session-id",
          },
          `${agentId}:${rawSessionId}`
        );
      }
    }
  });

  it("keeps every adapter except the audited conditional Codex path closed", () => {
    for (const [agentId, policy] of Object.entries(ADAPTER_POLICY)) {
      const assessed = assess(agentId, `${agentId}:stable-looking-id`);
      assert.strictEqual(policy.eligible, agentId === "codex", agentId);
      assert.strictEqual(assessed.eligible, false, agentId);
      if (agentId !== "codex") {
        assert.strictEqual(assessed.reason, policy.reason, agentId);
      }
    }
  });

  it("allows only audited local process-bound Codex TUI identities", () => {
    for (const codexOriginator of ["codex-tui", "codex_cli_rs", " CODEX-TUI "]) {
      assert.deepStrictEqual(
        assess("codex", CODEX_SESSION_ID, {
          ...CODEX_LOCAL_CLI,
          codexOriginator,
        }),
        { eligible: true, reason: "eligible" }
      );
    }
  });

  it("keeps Codex Desktop, remote and incomplete lifecycle identities fail-closed", () => {
    const cases = [
      [{ profileId: "ssh-profile" }, "remote-session-lifecycle-not-authoritative"],
      [{ hookSource: "manual" }, "untrusted-codex-hook-source"],
      [{ rawSessionId: "codex:stable-looking" }, "non-authoritative-codex-session-id"],
      [{ codexSource: "vscode" }, "unsupported-codex-session-source"],
      [{ codexOriginator: "codex_work_desktop" }, "unsupported-codex-originator"],
      [{ codexOriginator: "Codex Desktop" }, "unsupported-codex-originator"],
      [{ agentPid: null }, "missing-codex-process-lifecycle"],
    ];
    for (const [overrides, reason] of cases) {
      const rawSessionId = overrides.rawSessionId || CODEX_SESSION_ID;
      assert.deepStrictEqual(
        assess("codex", rawSessionId, {
          ...CODEX_LOCAL_CLI,
          ...overrides,
        }),
        { eligible: false, reason }
      );
    }
  });

  it("keeps opencode and MiMo independently closed for non-authoritative permission association", () => {
    for (const agentId of ["opencode", "mimocode"]) {
      assert.deepStrictEqual(
        assess(agentId, `${agentId}:ses-real-looking`),
        {
          eligible: false,
          reason: "permission-session-association-not-authoritative",
        }
      );
    }
  });

  it("ignores sender self-reported eligibility and rejects unsupported adapters/channels", () => {
    assert.deepStrictEqual(
      assess("claude-code", "real-id", {
        sessionAutomationEligible: true,
      }),
      { eligible: false, reason: "identity-verification-required" }
    );
    assert.deepStrictEqual(
      assess("custom-example", "real-id"),
      { eligible: false, reason: "unsupported-adapter" }
    );
    assert.deepStrictEqual(
      assess("claude-code", "real-id", { channel: "renderer" }),
      { eligible: false, reason: "unsupported-channel" }
    );
  });
});
