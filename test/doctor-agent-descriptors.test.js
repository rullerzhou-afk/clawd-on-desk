const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const {
  AGENT_DESCRIPTORS,
  getAgentDescriptor,
  getAgentDescriptors,
} = require("../src/doctor-detectors/agent-descriptors");

describe("doctor agent descriptors", () => {
  it("covers all supported agents", () => {
    assert.deepStrictEqual(
      AGENT_DESCRIPTORS.map((entry) => entry.agentId),
      [
        "claude-code",
        "codex",
        "copilot-cli",
        "cursor-agent",
        "gemini-cli",
        "codebuddy",
        "kiro-cli",
        "kimi-cli",
        "opencode",
        "pi",
        "openclaw",
        "hermes",
      ]
    );
  });

  it("uses installer-exported default paths", () => {
    const claude = require("../hooks/install");
    const codex = require("../hooks/codex-install");
    const cursor = require("../hooks/cursor-install");
    const gemini = require("../hooks/gemini-install");
    const codebuddy = require("../hooks/codebuddy-install");
    const kiro = require("../hooks/kiro-install");
    const kimi = require("../hooks/kimi-install");
    const opencode = require("../hooks/opencode-install");
    const pi = require("../hooks/pi-install");
    const openclaw = require("../hooks/openclaw-install");
    const hermes = require("../hooks/hermes-install");

    assert.strictEqual(getAgentDescriptor("claude-code").parentDir, claude.DEFAULT_PARENT_DIR);
    assert.strictEqual(getAgentDescriptor("claude-code").configPath, claude.DEFAULT_CONFIG_PATH);

    assert.strictEqual(getAgentDescriptor("codex").parentDir, codex.DEFAULT_PARENT_DIR);
    assert.strictEqual(getAgentDescriptor("codex").configPath, codex.DEFAULT_CONFIG_PATH);
    assert.strictEqual(getAgentDescriptor("codex").supplementary.configPath, codex.DEFAULT_FEATURES_CONFIG);

    assert.strictEqual(getAgentDescriptor("cursor-agent").parentDir, cursor.DEFAULT_PARENT_DIR);
    assert.strictEqual(getAgentDescriptor("cursor-agent").configPath, cursor.DEFAULT_CONFIG_PATH);

    assert.strictEqual(getAgentDescriptor("gemini-cli").parentDir, gemini.DEFAULT_PARENT_DIR);
    assert.strictEqual(getAgentDescriptor("gemini-cli").configPath, gemini.DEFAULT_CONFIG_PATH);

    assert.strictEqual(getAgentDescriptor("codebuddy").parentDir, codebuddy.DEFAULT_PARENT_DIR);
    assert.strictEqual(getAgentDescriptor("codebuddy").configPath, codebuddy.DEFAULT_CONFIG_PATH);

    assert.strictEqual(getAgentDescriptor("kiro-cli").parentDir, kiro.DEFAULT_PARENT_DIR);
    assert.strictEqual(getAgentDescriptor("kiro-cli").configPath, kiro.DEFAULT_AGENTS_DIR);

    assert.strictEqual(getAgentDescriptor("kimi-cli").parentDir, kimi.DEFAULT_PARENT_DIR);
    assert.strictEqual(getAgentDescriptor("kimi-cli").configPath, kimi.DEFAULT_CONFIG_PATH);

    assert.strictEqual(getAgentDescriptor("opencode").parentDir, opencode.DEFAULT_PARENT_DIR);
    assert.strictEqual(getAgentDescriptor("opencode").configPath, opencode.DEFAULT_CONFIG_PATH);

    assert.strictEqual(getAgentDescriptor("pi").parentDir, pi.DEFAULT_PARENT_DIR);
    assert.strictEqual(getAgentDescriptor("pi").configPath, pi.DEFAULT_EXTENSION_DIR);
    assert.strictEqual(getAgentDescriptor("pi").marker, pi.EXTENSION_FILE);
    assert.strictEqual(getAgentDescriptor("pi").coreFile, pi.CORE_FILE);
    assert.strictEqual(getAgentDescriptor("pi").markerFile, pi.MARKER_FILE);

    assert.strictEqual(getAgentDescriptor("openclaw").parentDir, openclaw.DEFAULT_STATE_DIR);
    assert.strictEqual(getAgentDescriptor("openclaw").configPath, openclaw.DEFAULT_CONFIG_PATH);
    assert.strictEqual(getAgentDescriptor("openclaw").marker, openclaw.PLUGIN_DIR_NAME);

    assert.strictEqual(getAgentDescriptor("hermes").parentDir, hermes.resolveHermesHome());
    assert.strictEqual(
      getAgentDescriptor("hermes").configPath,
      path.join(hermes.resolveHermesHome(), "plugins", hermes.PLUGIN_ID)
    );
  });

  it("returns copies from public accessors", () => {
    const list = getAgentDescriptors();
    list[0].agentId = "mutated";
    assert.strictEqual(getAgentDescriptor("claude-code").agentId, "claude-code");
    assert.strictEqual(getAgentDescriptor("missing"), null);
  });

  it("checks Gemini hooks with the official nested settings shape", () => {
    const descriptor = getAgentDescriptor("gemini-cli");

    assert.strictEqual(descriptor.eventSource, "hook");
    assert.strictEqual(descriptor.nested, true);
  });
});
