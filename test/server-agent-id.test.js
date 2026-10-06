"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  DEFAULT_HOOK_AGENT_ID,
  KNOWN_HOOK_AGENT_IDS,
  MAX_SUBAGENT_ID_LENGTH,
  MAX_SUBAGENT_TYPE_LENGTH,
  normalizeSubagentMetadata,
  resolveHookAgentId,
} = require("../src/server-agent-id");

const SUBAGENT_UUID = "0199f2c5-1bb8-7892-9e3b-1d6f4a1c2b3d";

describe("resolveHookAgentId", () => {
  it("treats registry agent ids as explicit identities", () => {
    for (const id of ["claude-code", "codebuddy", "hermes", "codex", "qwen-code"]) {
      assert.deepStrictEqual(resolveHookAgentId({ agent_id: id }), {
        agentId: id,
        source: "explicit",
        defaulted: false,
      });
    }
  });

  it("trims whitespace around explicit ids", () => {
    assert.strictEqual(resolveHookAgentId({ agent_id: "  codebuddy  " }).agentId, "codebuddy");
  });

  it("maps hook_source when agent_id is missing", () => {
    assert.deepStrictEqual(resolveHookAgentId({ hook_source: "codex-official" }), {
      agentId: "codex",
      source: "hook-source",
      defaulted: false,
    });
  });

  it("classifies an unknown agent_id as a Claude Code subagent marker (#451)", () => {
    // CC ≥ 2.1.x stamps common hook input with agent_id = per-instance
    // subagent uuid (present only inside Task subagents). It must resolve to
    // claude-code instead of leaking into per-agent gates / session labels.
    assert.deepStrictEqual(
      resolveHookAgentId({ agent_id: SUBAGENT_UUID, agent_type: "code-reviewer" }),
      {
        agentId: "claude-code",
        source: "subagent",
        defaulted: false,
        subagentId: SUBAGENT_UUID,
        subagentType: "code-reviewer",
      }
    );
  });

  it("accepts only currently registered custom agent ids", () => {
    const id = "custom-nova-ai-0123456789ab";
    assert.deepStrictEqual(resolveHookAgentId({ agent_id: id }, { customAgentIds: [id] }), {
      agentId: id,
      source: "custom",
      defaulted: false,
    });
    assert.deepStrictEqual(resolveHookAgentId({ agent_id: id }), {
      agentId: null,
      source: "rejected-custom",
      rejected: true,
      rawAgentId: id,
    });
    assert.strictEqual(resolveHookAgentId({ agent_id: "custom-forged-0123456789ab" }, {
      customAgentIds: [id],
    }).source, "rejected-custom");
  });

  it("rejects malformed custom namespace ids before hook_source fallback", () => {
    const resolved = resolveHookAgentId({
      agent_id: "custom-BROKEN",
      hook_source: "copilot-hook",
    });
    assert.deepStrictEqual(resolved, {
      agentId: null,
      source: "rejected-custom",
      rejected: true,
      rawAgentId: "custom-BROKEN",
    });
  });

  it("rejects ASCII case variants of the reserved custom namespace", () => {
    for (const agentId of ["CUSTOM-nova-ai-0123456789ab", "Custom-BROKEN"]) {
      const resolved = resolveHookAgentId({ agent_id: agentId, hook_source: "copilot-hook" });
      assert.strictEqual(resolved.rejected, true);
      assert.strictEqual(resolved.source, "rejected-custom");
      assert.strictEqual(resolved.rawAgentId, agentId);
    }
  });

  it("truncates overlong rejected custom ids for diagnostics", () => {
    const resolved = resolveHookAgentId({ agent_id: `custom-${"x".repeat(200)}` });
    assert.strictEqual(resolved.rejected, true);
    assert.strictEqual(resolved.rawAgentId.length, 80);
    assert.ok(resolved.rawAgentId.startsWith("custom-"));
  });

  it("classifies a subagent marker without agent_type", () => {
    const resolved = resolveHookAgentId({ agent_id: SUBAGENT_UUID });
    assert.strictEqual(resolved.source, "subagent");
    assert.strictEqual(resolved.subagentId, SUBAGENT_UUID);
    assert.strictEqual(resolved.subagentType, null);
  });

  it("uses the shared bounded normalizer for subagent ids and types", () => {
    assert.strictEqual(normalizeSubagentMetadata(` ${SUBAGENT_UUID} `, MAX_SUBAGENT_ID_LENGTH), SUBAGENT_UUID);
    assert.strictEqual(normalizeSubagentMetadata("reviewer", MAX_SUBAGENT_TYPE_LENGTH), "reviewer");
    assert.strictEqual(normalizeSubagentMetadata(`x${"\n"}y`, MAX_SUBAGENT_ID_LENGTH), null);
    assert.strictEqual(normalizeSubagentMetadata("x".repeat(MAX_SUBAGENT_ID_LENGTH + 1), MAX_SUBAGENT_ID_LENGTH), null);

    const overlong = "x".repeat(MAX_SUBAGENT_ID_LENGTH + 1);
    assert.deepStrictEqual(resolveHookAgentId({ agent_id: overlong }), {
      agentId: null,
      source: "rejected-subagent",
      rejected: true,
      rawAgentId: overlong.slice(0, 80),
    });

    const invalidType = resolveHookAgentId({
      agent_id: SUBAGENT_UUID,
      agent_type: "x".repeat(MAX_SUBAGENT_TYPE_LENGTH + 1),
    });
    assert.strictEqual(invalidType.source, "subagent");
    assert.strictEqual(invalidType.subagentType, null);
  });

  it("prefers hook_source routing over an unknown agent_id", () => {
    // A non-CC hook body that ever carries a stray non-registry agent_id must
    // keep routing by its hook_source stamp, not become a CC subagent.
    const resolved = resolveHookAgentId({ agent_id: SUBAGENT_UUID, hook_source: "copilot-hook" });
    assert.strictEqual(resolved.agentId, "copilot-cli");
    assert.strictEqual(resolved.source, "hook-source");
    assert.strictEqual(resolved.subagentId, undefined);
  });

  it("defaults to claude-code when nothing identifies the agent", () => {
    for (const data of [{}, { agent_id: "" }, { agent_id: 42 }, { hook_source: "unknown-source" }]) {
      assert.deepStrictEqual(resolveHookAgentId(data), {
        agentId: DEFAULT_HOOK_AGENT_ID,
        source: "default",
        defaulted: true,
      });
    }
  });

  it("exposes the registry-known id set", () => {
    assert.ok(KNOWN_HOOK_AGENT_IDS.has("claude-code"));
    assert.ok(KNOWN_HOOK_AGENT_IDS.has("qoder"));
    assert.ok(!KNOWN_HOOK_AGENT_IDS.has(SUBAGENT_UUID));
  });
});
