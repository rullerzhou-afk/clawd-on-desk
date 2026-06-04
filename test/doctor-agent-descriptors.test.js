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
        "antigravity-cli",
        "codebuddy",
        "kiro-cli",
        "kimi-cli",
        "qwen-code",
        "opencode",
        "pi",
        "openclaw",
        "hermes",
        "qoder",
      ]
    );
  });

  it("uses installer-exported default paths", () => {
    const claude = require("../hooks/install");
    const codex = require("../hooks/codex-install");
    const copilot = require("../hooks/copilot-install");
    const cursor = require("../hooks/cursor-install");
    const gemini = require("../hooks/gemini-install");
    const antigravity = require("../hooks/antigravity-install");
    const codebuddy = require("../hooks/codebuddy-install");
    const kiro = require("../hooks/kiro-install");
    const kimi = require("../hooks/kimi-install");
    const qwen = require("../hooks/qwen-code-install");
    const opencode = require("../hooks/opencode-install");
    const pi = require("../hooks/pi-install");
    const openclaw = require("../hooks/openclaw-install");
    const hermes = require("../hooks/hermes-install");
    const qoder = require("../hooks/qoder-install");

    assert.strictEqual(getAgentDescriptor("claude-code").parentDir, claude.DEFAULT_PARENT_DIR);
    assert.strictEqual(getAgentDescriptor("claude-code").configPath, claude.DEFAULT_CONFIG_PATH);

    assert.strictEqual(getAgentDescriptor("codex").parentDir, codex.DEFAULT_PARENT_DIR);
    assert.strictEqual(getAgentDescriptor("codex").configPath, codex.DEFAULT_CONFIG_PATH);
    assert.strictEqual(getAgentDescriptor("codex").supplementary.configPath, codex.DEFAULT_FEATURES_CONFIG);

    assert.strictEqual(getAgentDescriptor("copilot-cli").parentDir, copilot.resolveCopilotHome());
    assert.strictEqual(getAgentDescriptor("copilot-cli").configPath, copilot.resolveCopilotHooksPath());
    assert.strictEqual(getAgentDescriptor("copilot-cli").settingsPath, copilot.resolveCopilotSettingsPath());

    assert.strictEqual(getAgentDescriptor("cursor-agent").parentDir, cursor.DEFAULT_PARENT_DIR);
    assert.strictEqual(getAgentDescriptor("cursor-agent").configPath, cursor.DEFAULT_CONFIG_PATH);

    assert.strictEqual(getAgentDescriptor("gemini-cli").parentDir, gemini.DEFAULT_PARENT_DIR);
    assert.strictEqual(getAgentDescriptor("gemini-cli").configPath, gemini.DEFAULT_CONFIG_PATH);

    assert.strictEqual(getAgentDescriptor("antigravity-cli").parentDir, antigravity.DEFAULT_PARENT_DIR);
    assert.strictEqual(getAgentDescriptor("antigravity-cli").configPath, antigravity.DEFAULT_CONFIG_PATH);

    assert.strictEqual(getAgentDescriptor("codebuddy").parentDir, codebuddy.DEFAULT_PARENT_DIR);
    assert.strictEqual(getAgentDescriptor("codebuddy").configPath, codebuddy.DEFAULT_CONFIG_PATH);

    assert.strictEqual(getAgentDescriptor("kiro-cli").parentDir, kiro.DEFAULT_PARENT_DIR);
    assert.strictEqual(getAgentDescriptor("kiro-cli").configPath, kiro.DEFAULT_AGENTS_DIR);

    assert.strictEqual(getAgentDescriptor("kimi-cli").parentDir, kimi.DEFAULT_PARENT_DIR);
    assert.strictEqual(getAgentDescriptor("kimi-cli").configPath, kimi.DEFAULT_CONFIG_PATH);

    assert.strictEqual(getAgentDescriptor("qwen-code").parentDir, qwen.DEFAULT_PARENT_DIR);
    assert.strictEqual(getAgentDescriptor("qwen-code").configPath, qwen.DEFAULT_CONFIG_PATH);
    assert.strictEqual(getAgentDescriptor("qwen-code").marker, qwen.MARKER);
    assert.deepStrictEqual(getAgentDescriptor("qwen-code").hookEvents, qwen.QWEN_CODE_HOOK_EVENTS);

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

    assert.strictEqual(getAgentDescriptor("qoder").parentDir, qoder.DEFAULT_PARENT_DIR);
    assert.strictEqual(getAgentDescriptor("qoder").configPath, qoder.DEFAULT_CONFIG_PATH);
    assert.strictEqual(getAgentDescriptor("qoder").marker, qoder.MARKER);
    assert.deepStrictEqual(getAgentDescriptor("qoder").hookEvents, qoder.QODER_HOOK_EVENTS);
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

  it("checks Antigravity hooks as a global hooks file", () => {
    const antigravity = require("../hooks/antigravity-install");
    const descriptor = getAgentDescriptor("antigravity-cli");

    assert.strictEqual(descriptor.eventSource, "hook");
    assert.strictEqual(descriptor.configMode, "antigravity-hooks");
    assert.strictEqual(descriptor.marker, antigravity.MARKER);
    assert.deepStrictEqual(descriptor.hookEvents, antigravity.ANTIGRAVITY_HOOK_EVENTS);
  });

  it("checks Copilot CLI hooks with the dedicated copilot-hooks mode", () => {
    const copilot = require("../hooks/copilot-install");
    const descriptor = getAgentDescriptor("copilot-cli");

    assert.strictEqual(descriptor.eventSource, "hook");
    assert.strictEqual(descriptor.configMode, "copilot-hooks");
    assert.strictEqual(descriptor.autoInstall, true);
    assert.strictEqual(descriptor.marker, copilot.MARKER);
    assert.deepStrictEqual(descriptor.hookEvents, copilot.COPILOT_HOOK_EVENTS);
  });

  it("Copilot descriptor honors $COPILOT_HOME at module-load time", () => {
    // Contract: plan §5 Risk 3 — descriptor is frozen at module load and
    // captures whatever resolveCopilotHome() returns at that moment. Set
    // COPILOT_HOME, blow the require cache for both the descriptor module
    // and the installer it depends on, then re-require and verify all three
    // path fields reflect the env.
    const path = require("node:path");
    const os = require("node:os");
    const fs = require("node:fs");

    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-copilot-env-desc-"));
    const prevEnv = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = tempHome;

    const installerPath = require.resolve("../hooks/copilot-install");
    const descriptorsPath = require.resolve("../src/doctor-detectors/agent-descriptors");
    const prevInstallerCache = require.cache[installerPath];
    const prevDescriptorsCache = require.cache[descriptorsPath];
    delete require.cache[installerPath];
    delete require.cache[descriptorsPath];

    try {
      const { getAgentDescriptor: getFresh } = require("../src/doctor-detectors/agent-descriptors");
      const desc = getFresh("copilot-cli");

      assert.strictEqual(desc.parentDir, tempHome,
        "descriptor.parentDir should resolve to $COPILOT_HOME, not ~/.copilot");
      assert.strictEqual(desc.configPath, path.join(tempHome, "hooks", "hooks.json"));
      assert.strictEqual(desc.settingsPath, path.join(tempHome, "settings.json"));
    } finally {
      // Restore cache + env so downstream tests see the original module.
      if (prevInstallerCache) require.cache[installerPath] = prevInstallerCache;
      else delete require.cache[installerPath];
      if (prevDescriptorsCache) require.cache[descriptorsPath] = prevDescriptorsCache;
      else delete require.cache[descriptorsPath];
      if (prevEnv === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = prevEnv;
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("checks Qoder hooks as a state-only nested settings file", () => {
    const qoder = require("../hooks/qoder-install");
    const descriptor = getAgentDescriptor("qoder");

    assert.strictEqual(descriptor.eventSource, "hook");
    assert.strictEqual(descriptor.configMode, "file");
    assert.strictEqual(descriptor.nested, true);
    assert.strictEqual(descriptor.autoInstall, true);
    assert.strictEqual(descriptor.marker, qoder.MARKER);
    assert.deepStrictEqual(descriptor.hookEvents, qoder.QODER_HOOK_EVENTS);
  });
});
